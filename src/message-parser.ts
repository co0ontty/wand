import type { ChatMessage } from "./types.js";

export function parseMessages(output: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (!output) return messages;

  // Strip ANSI escape sequences (CSI sequences)
  let stripped = "";
  for (let i = 0; i < output.length; i++) {
    const ch = output.charCodeAt(i);
    if (ch === 27) {
      i++;
      if (i >= output.length) break;
      const next = output.charCodeAt(i);
      if (next === 91) {
        i++;
        while (i < output.length) {
          const c = output.charCodeAt(i);
          if (c >= 64 && c <= 126) break;
          i++;
        }
      }
      continue;
    }
    stripped += output.charAt(i);
  }

  // Convert CR to LF and split into lines
  stripped = stripped.replace(/\r/g, "\n");
  const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);

  // Filter noise lines
  const cleaned = lines.filter((line) => {
    if (!line) return false;
    if (line.indexOf("────────────────") === 0) return false;
    if (line === "❯") return false;
    if (line.indexOf("esc to interrupt") !== -1) return false;
    if (line.indexOf("Claude Code v") !== -1) return false;
    if (line.indexOf("Sonnet") !== -1) return false;
    if (line.indexOf("~/") === 0) return false;
    if (line.indexOf("● high") !== -1) return false;
    if (line.indexOf("Failed to install Anthropic marketplace") !== -1) return false;
    if (line.indexOf("Claude Code has switched from npm to native installer") !== -1) return false;
    if (line.indexOf("Fluttering") !== -1) return false;
    if (line.indexOf("? for shortcuts") !== -1) return false;
    if (line.indexOf("0;") === 0) return false;
    if (line.indexOf("9;") === 0) return false;
    if (line.indexOf("Claude is waiting") !== -1) return false;
    if (line.indexOf("✢") !== -1 || line.indexOf("✳") !== -1 || line.indexOf("✶") !== -1 || line.indexOf("✻") !== -1 || line.indexOf("✽") !== -1) return false;
    if (line.indexOf("▐") === 0 || line.indexOf("▝") === 0 || line.indexOf("▘") === 0) return false;
    const singleCharNoise = ["lu", "ue", "tr", "ti", "g", "n", "i…", "…", "uts", "lt", "rg", "·"];
    if (singleCharNoise.includes(line) && line.length < 4) return false;
    if (line.indexOf("✽F") === 0 || line.indexOf("✻F") === 0) return false;
    return true;
  });

  if (!cleaned.length) return messages;

  // Find first user prompt line (❯)
  let userCmdIndex = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].indexOf("❯") === 0) {
      userCmdIndex = i;
      break;
    }
  }

  if (userCmdIndex === -1) return messages;

  // Extract user message
  const userText = cleaned[userCmdIndex].replace(/^❯\s*/, "").trim();
  if (userText) {
    messages.push({ role: "user", content: userText });
  }

  // Extract assistant response (lines after the prompt)
  const assistantLines = cleaned.slice(userCmdIndex + 1).filter((line) => {
    if (line.indexOf("⏺") !== -1 && (line.indexOf("Hi!") !== -1 || line.indexOf("Hello") !== -1 || line.indexOf("What") !== -1 || line.indexOf("working") !== -1)) return true;
    if (line.indexOf("⏺") === 0) return true;
    if (line.length < 8) return false;
    if (line.indexOf("✢") !== -1 || line.indexOf("✳") !== -1 || line.indexOf("✶") !== -1 || line.indexOf("✻") !== -1 || line.indexOf("✽") !== -1) return false;
    if (line.indexOf("▐") === 0 || line.indexOf("▝") === 0 || line.indexOf("▘") === 0) return false;
    if (line.indexOf("❯") === 0) return false;
    if (line.indexOf("esctointerrupt") !== -1) return false;
    if (line.indexOf("?for") === 0 || line.indexOf("? for") === 0) return false;
    return true;
  });

  if (assistantLines.length) {
    messages.push({ role: "assistant", content: assistantLines.join("\n") });
  }

  return messages;
}
