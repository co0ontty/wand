import type { ChatMessage } from "./types.js";
import { stripAnsi, isNoiseLine } from "./pty-text-utils.js";

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
    } else if (currentUserText !== null) {
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
