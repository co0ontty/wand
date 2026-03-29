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
      continue;
    }
    // Skip control characters except \n, \r, \t
    if (ch < 32 && ch !== 10 && ch !== 13 && ch !== 9) continue;
    stripped += text.charAt(i);
  }
  return stripped;
}

/** Lines considered as UI noise (pass in trimmed) */
function isNoiseLine(line: string): boolean {
  if (line.length === 0) return false;
  if (line.startsWith("────")) return true;
  if (line === "❯") return true;
  if (line.includes("esc to interrupt")) return true;
  if (line.includes("Claude Code v")) return true;
  if (/^Sonnet\b/.test(line)) return true;
  if (line.includes("Failed to install Anthropic")) return true;
  if (line.includes("Claude Code has switched")) return true;
  if (line.includes("? for shortcuts")) return true;
  if (line.includes("Claude is waiting")) return true;
  if (line.includes("[wand]")) return true;
  if (line.startsWith("0;") || line.startsWith("9;")) return true;
  if (line.includes("ctrl+g")) return true;
  if (line.includes("/effort")) return true;
  if (/^Using .* for .* session/.test(line)) return true;
  if (line.startsWith("Press ") && line.includes(" for")) return true;
  if (line.startsWith("type ") && line.includes(" to ")) return true;
  return false;
}

function isAssistantContent(line: string): boolean {
  if (line.startsWith("❯")) return false;
  if (line.includes("esctointerrupt")) return false;
  return true;
}

export function parseMessages(output: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (!output) return messages;

  const stripped = stripAnsi(output).replace(/\r/g, "\n");
  const lines = stripped.split("\n");
  const cleaned = lines.filter((line) => !isNoiseLine(line.trim()));
  if (!cleaned.length) return messages;

  interface Turn { user: string; assistantLines: string[] }
  const turns: Turn[] = [];
  let currentUserText: string | null = null;
  let currentAssistantLines: string[] = [];

  for (const rawLine of cleaned) {
    const line = rawLine.trim();
    if (line.startsWith("❯")) {
      const afterPrompt = line.replace(/^❯\s*/, "").trim();
      if (afterPrompt.startsWith("Try")) continue;

      if (currentUserText !== null && currentAssistantLines.length > 0) {
        turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
        currentAssistantLines = [];
      }

      if (afterPrompt) {
        currentUserText = afterPrompt;
      } else {
        if (currentUserText !== null && currentAssistantLines.length > 0) {
          turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
          currentAssistantLines = [];
        }
        currentUserText = null;
      }
    } else if (currentUserText !== null && isAssistantContent(line)) {
      const contentLine = rawLine.startsWith("⏺") ? rawLine.slice(1) : rawLine;
      currentAssistantLines.push(contentLine);
    }
  }

  if (currentUserText !== null && currentAssistantLines.length > 0) {
    turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
  }

  for (const turn of turns) {
    messages.push({ role: "user", content: turn.user });
    const content = turn.assistantLines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/[\n\s]+$/, "");
    messages.push({ role: "assistant", content });
  }

  return messages;
}
