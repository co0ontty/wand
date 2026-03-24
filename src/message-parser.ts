import type { ChatMessage } from "./types.js";

/** Strip ANSI escape sequences from raw PTY output */
function stripAnsi(text: string): string {
  let stripped = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 27) {
      i++;
      if (i >= text.length) break;
      const next = text.charCodeAt(i);
      if (next === 91) {
        // CSI sequence: skip until final byte (64-126)
        i++;
        while (i < text.length) {
          const c = text.charCodeAt(i);
          if (c >= 64 && c <= 126) break;
          i++;
        }
      } else if (next === 93) {
        // OSC sequence: skip until BEL (7) or ESC\ (27 92)
        i++;
        while (i < text.length) {
          if (text.charCodeAt(i) === 7) break;
          if (text.charCodeAt(i) === 27 && i + 1 < text.length && text.charCodeAt(i + 1) === 92) {
            i++;
            break;
          }
          i++;
        }
      }
      // Other escape sequences: skip the next character
      continue;
    }
    // Skip control characters except \n, \r, \t
    if (ch < 32 && ch !== 10 && ch !== 13 && ch !== 9) continue;
    stripped += text.charAt(i);
  }
  return stripped;
}

/** Check if a line is noise from Claude TUI */
function isNoiseLine(line: string): boolean {
  if (!line) return true;
  if (line.startsWith("────")) return true;
  if (line === "❯") return true;
  if (line.includes("esc to interrupt")) return true;
  if (line.includes("Claude Code v")) return true;
  if (/^Sonnet\b/.test(line)) return true;
  if (line.startsWith("~/")) return true;
  if (line.includes("● high")) return true;
  if (line.includes("Failed to install Anthropic")) return true;
  if (line.includes("Claude Code has switched")) return true;
  if (line.includes("Fluttering")) return true;
  if (line.includes("? for shortcuts")) return true;
  if (line.startsWith("0;") || line.startsWith("9;")) return true;
  if (line.includes("Claude is waiting")) return true;
  if (/[✢✳✶✻✽]/.test(line)) return true;
  if (/^[▐▝▘]/.test(line)) return true;
  const singleCharNoise = ["lu", "ue", "tr", "ti", "g", "n", "i…", "…", "uts", "lt", "rg", "·"];
  if (singleCharNoise.includes(line) && line.length < 4) return true;
  if (line.startsWith("✽F") || line.startsWith("✻F")) return true;
  if (line.includes("[wand]")) return true;
  if (line.includes("⏵")) return true;
  if (line.includes("acceptedit")) return true;
  if (line.includes("shift+tab")) return true;
  if (line.includes("tabtocycle")) return true;
  if (line.includes("ctrl+g")) return true;
  if (line.includes("/effort")) return true;
  if (line.includes("Haiku")) return true;
  if (line.includes("to cycle")) return true;
  if (/\bhigh\s*·/.test(line) || /\bmedium\s*·/.test(line) || /\blow\s*·/.test(line)) return true;
  if (line.includes("npm WARN") || line.includes("npm notice")) return true;
  if (/^Using .* for .* session/.test(line)) return true;
  if (line.includes("Permissions") && line.includes("mode")) return true;
  if (line.startsWith("Press ") && line.includes(" for")) return true;
  if (line.startsWith("type ") && line.includes(" to ")) return true;
  if (line.length < 3 && !/^[a-zA-Z]{3}$/.test(line)) return true;
  return false;
}

/** Filter assistant content line */
function isAssistantContent(line: string): boolean {
  if (line.includes("⏺")) return true;
  if (line.length < 8) return false;
  if (/[✢✳✶✻✽]/.test(line)) return false;
  if (/^[▐▝▘]/.test(line)) return false;
  if (line.startsWith("❯")) return false;
  if (line.includes("esctointerrupt")) return false;
  if (line.startsWith("?for") || line.startsWith("? for")) return false;
  return true;
}

export function parseMessages(output: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (!output) return messages;

  // Strip ANSI and normalize
  const stripped = stripAnsi(output).replace(/\r/g, "\n");
  const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);

  // Filter noise
  const cleaned = lines.filter((line) => !isNoiseLine(line));
  if (!cleaned.length) return messages;

  // ── Multi-turn parsing: find ALL ❯ markers and build turn pairs ──
  interface Turn { user: string; assistantLines: string[] }
  const turns: Turn[] = [];
  let currentUserText: string | null = null;
  let currentAssistantLines: string[] = [];

  for (const line of cleaned) {
    if (line.startsWith("❯")) {
      const afterPrompt = line.replace(/^❯\s*/, "").trim();

      // Skip prompt suggestions
      if (afterPrompt.startsWith("Try")) continue;

      // Finalize previous turn
      if (currentUserText !== null && currentAssistantLines.length > 0) {
        turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
        currentAssistantLines = [];
      }

      if (afterPrompt) {
        currentUserText = afterPrompt;
      } else {
        // Standalone ❯ — finalize and reset
        if (currentUserText !== null && currentAssistantLines.length > 0) {
          turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
          currentAssistantLines = [];
        }
        currentUserText = null;
      }
    } else if (currentUserText !== null && isAssistantContent(line)) {
      // Clean ⏺ prefix
      const cleanLine = line.startsWith("⏺") ? line.slice(1).trim() : line;
      if (cleanLine) currentAssistantLines.push(cleanLine);
    }
  }

  // Finalize last turn
  if (currentUserText !== null && currentAssistantLines.length > 0) {
    turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
  }

  // Convert to messages
  for (const turn of turns) {
    messages.push({ role: "user", content: turn.user });
    messages.push({ role: "assistant", content: turn.assistantLines.join("\n") });
  }

  return messages;
}
