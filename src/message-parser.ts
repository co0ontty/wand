import type { ChatMessage } from "./types.js";
import { stripAnsi, isNoiseLine } from "./pty-text-utils.js";

function isCodexCommand(command?: string): boolean {
  return /^codex\b/.test((command ?? "").trim());
}

const CODEX_FOOTER_RE = /\bgpt-\d+(?:\.\d+)?(?:\s+[a-z0-9.-]+)?\s+·\s+\d+%\s+left\s+·\s+(?:\/|~\/).+/i;
const CODEX_ACTIVITY_RE = /^(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i;

interface CodexCandidate {
  kind: "user" | "assistant" | "echo";
  order: number;
  text: string;
}

interface CodexTurn {
  assistantLines: string[];
  user: string;
  userOrder: number;
}

function stripCodexSegment(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count) || 1))
    .replace(/\x1b\[[0-9;?]*[AB]/g, "\n")
    .replace(/\x1b\[[0-9;?]*[su]/g, "")
    .replace(/\x1b\[[0-9;?]*[HfJKr]/g, "\n")
    .replace(/\x1bM/g, "\n")
    .replace(/\x1b\[[0-9;?]*[ST]/g, "\n")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[><=ePX^_]/g, "")
    .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function normalizeCodexText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[M]+$/g, "")
    .trim();
}

function isLikelyAssistantTailArtifact(longer: string, shorter: string): boolean {
  if (!longer.startsWith(shorter)) return false;
  const suffix = longer.slice(shorter.length);
  return /^[a-z]{1,4}$/i.test(suffix);
}

function parseCodexMessages(output: string): ChatMessage[] {
  const messages: ChatMessage[] = [];

  function normalizeCodexAssistantLine(line: string): string {
    return line
      .replace(/^[•◦·]\s*/, "")
      .replace(/^⏺\s+/, "")
      .replace(/^│\s*/, "")
      .trim();
  }

  function normalizeCodexPromptLine(line: string): string {
    return line
      .replace(/^›\s*/, "")
      .replace(/^>\s*/, "")
      .trim();
  }

  function shouldIgnoreCodexLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (isNoiseLine(trimmed)) return true;
    if (CODEX_FOOTER_RE.test(trimmed)) return true;
    if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return true;
    if (/^\[>[0-9;?]*u$/i.test(trimmed)) return true;
    if (/^M+$/i.test(trimmed)) return true;
    if (/^(?:OpenAI Codex|Codex)\b/i.test(trimmed)) return true;
    if (/^(?:tokens?|context window|remaining context|approvals?|sandbox|provider|session id):\s*/i.test(trimmed)) return true;
    if (/^(?:thinking|working)\s*(?:\.\.\.|…)?$/i.test(trimmed)) return true;
    if (/^[•◦·]\s+(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i.test(trimmed)) return true;
    if (/^(?:model|directory|tip|context|cwd|path):\s+/i.test(trimmed)) return true;
    return false;
  }

  function extractCodexPromptCandidate(line: string): string | null {
    const trimmed = line.trim();
    if (!/^›(?:\s|$)/.test(trimmed)) return null;
    if (CODEX_FOOTER_RE.test(trimmed)) return null;

    const prompt = normalizeCodexText(normalizeCodexPromptLine(trimmed));
    if (!prompt || shouldIgnoreCodexLine(prompt)) return null;
    return prompt;
  }

  function extractCodexAssistantCandidate(line: string): string | null {
    const trimmed = line.trim();
    if (!/^[•◦·⏺]/.test(trimmed)) return null;

    let assistant = normalizeCodexAssistantLine(trimmed);
    if (!assistant || /^[•◦·⏺]$/.test(assistant)) return null;
    assistant = assistant.replace(/\s*\(\d+[smh]?\s*•\s*esc to interrupt\)[\s\S]*$/i, "");
    assistant = assistant.replace(/(?:[a-z]{1,6})?›[\s\S]*$/, "");
    assistant = assistant.replace(/\s{2,}gpt-\d[\s\S]*$/i, "");
    assistant = assistant.replace(/\b(?:OpenAI Codex|model:|directory:|Tip:)\b[\s\S]*$/i, "");
    assistant = normalizeCodexText(assistant);

    if (!assistant || assistant.length < 2 || CODEX_ACTIVITY_RE.test(assistant) || shouldIgnoreCodexLine(assistant)) {
      return null;
    }

    return assistant;
  }

  function extractCodexEchoCandidate(line: string): string | null {
    const trimmed = normalizeCodexText(line);
    if (!trimmed || shouldIgnoreCodexLine(trimmed)) return null;
    if (/^[•◦·⏺›]/.test(trimmed)) return null;
    if (/^[\[\]<>0-9;?]+u?$/i.test(trimmed)) return null;
    if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return null;
    if (trimmed.length > 500) return null;
    return trimmed;
  }

  function collectCodexCandidates(): CodexCandidate[] {
    const candidates: CodexCandidate[] = [];
    let order = 0;

    for (const rawSegment of output.replace(/\r\n?/g, "\n").split("\n")) {
      const cleanedSegment = stripCodexSegment(rawSegment);
      const pieces = cleanedSegment.split("\n");

      for (const piece of pieces) {
        const line = piece.trim();
        if (!line) continue;

        const prompt = extractCodexPromptCandidate(line);
        if (prompt) {
          candidates.push({ kind: "user", order, text: prompt });
          order += 1;
          continue;
        }

        const assistant = extractCodexAssistantCandidate(line);
        if (assistant) {
          candidates.push({ kind: "assistant", order, text: assistant });
          order += 1;
          continue;
        }

        const echo = extractCodexEchoCandidate(line);
        if (echo) {
          candidates.push({ kind: "echo", order, text: echo });
          order += 1;
        }
      }
    }

    return candidates.filter((candidate, index, list) => {
      const previous = list[index - 1];
      return !previous || previous.kind !== candidate.kind || previous.text !== candidate.text;
    });
  }

  function coalesceAssistantLines(lines: string[]): string {
    const collected: string[] = [];

    for (const line of lines) {
      const normalized = normalizeCodexText(line);
      if (!normalized || normalized.length < 2 || shouldIgnoreCodexLine(normalized)) continue;

      const previous = collected[collected.length - 1];
      if (!previous) {
        collected.push(normalized);
        continue;
      }

      if (normalized === previous) continue;
      if (normalized.startsWith(previous)) {
        collected[collected.length - 1] = normalized;
        continue;
      }
      if (previous.startsWith(normalized)) {
        if (isLikelyAssistantTailArtifact(previous, normalized)) {
          collected[collected.length - 1] = normalized;
        }
        continue;
      }

      collected.push(normalized);
    }

    return collected.join("\n").trim();
  }

  function extractVisiblePrompt(lines: string[]): string | null {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;

      const inlinePrompt = extractCodexPromptCandidate(line);
      if (inlinePrompt) return inlinePrompt;

      if (line === "›") {
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = normalizeCodexText(lines[nextIndex]);
          if (!nextLine || CODEX_FOOTER_RE.test(nextLine) || shouldIgnoreCodexLine(nextLine)) continue;
          return nextLine;
        }
      }
    }

    return null;
  }

  function extractVisibleAssistantLines(lines: string[]): string[] {
    const assistantLines: string[] = [];
    let collecting = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (collecting) break;
        continue;
      }

      const assistant = extractCodexAssistantCandidate(line);
      if (assistant) {
        assistantLines.push(assistant);
        collecting = true;
        continue;
      }

      if (collecting) {
        if (
          line === "›" ||
          /^›(?:\s|$)/.test(line) ||
          CODEX_FOOTER_RE.test(line) ||
          shouldIgnoreCodexLine(line)
        ) {
          break;
        }
        assistantLines.push(normalizeCodexText(line));
      }
    }

    return assistantLines;
  }

  const candidates = collectCodexCandidates();
  const explicitUsers = candidates.filter((candidate) => candidate.kind === "user");
  const assistantCandidates = candidates.filter((candidate) => candidate.kind === "assistant");
  const echoCandidates = candidates.filter((candidate) => candidate.kind === "echo");
  const strippedOutput = stripAnsi(output);
  const strippedLines = strippedOutput.split("\n").map((line) => line.trimEnd());
  const visiblePrompt = extractVisiblePrompt(strippedLines);

  const latestExplicitUser = explicitUsers[explicitUsers.length - 1] ?? null;
  const echoedUserCandidates = echoCandidates
    .map((candidate) => candidate.text)
    .filter((text) => text.length >= 3);
  const latestEchoUser = [...echoedUserCandidates].reverse().find((text) => text !== visiblePrompt) ?? echoedUserCandidates[echoedUserCandidates.length - 1] ?? null;
  const currentUser = latestExplicitUser?.text ?? latestEchoUser;

  const rawAssistantLines = assistantCandidates
    .filter((candidate) => !latestExplicitUser || candidate.order > latestExplicitUser.order)
    .map((candidate) => candidate.text);
  const visibleAssistantFallback = [...strippedOutput.matchAll(/^[ \t]*[•◦·⏺][ \t]*(.+)$/gm)]
    .map((match) => normalizeCodexText(match[1] ?? ""))
    .filter((line) => (
      !!line
      && !CODEX_ACTIVITY_RE.test(line)
      && !CODEX_FOOTER_RE.test(line)
      && !/\b(?:OpenAI Codex|model:|directory:|Tip:|esc to interrupt)\b/i.test(line)
    ));
  const assistant = coalesceAssistantLines(rawAssistantLines)
    || coalesceAssistantLines(extractVisibleAssistantLines(strippedLines))
    || visibleAssistantFallback[visibleAssistantFallback.length - 1]
    || null;

  if (currentUser) {
    messages.push({ role: "user", content: currentUser });
  }
  if (assistant) {
    messages.push({ role: "assistant", content: assistant });
  }

  if (!messages.length && latestExplicitUser) {
    messages.push({ role: "user", content: latestExplicitUser.text });
  } else if (!messages.length && latestEchoUser) {
    messages.push({ role: "user", content: latestEchoUser });
  }

  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    if (!previous || previous.role !== message.role || previous.content !== message.content) {
      deduped.push(message);
    }
  }

  return deduped;
}

export function parseMessages(output: string, command?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (!output) return messages;

  if (isCodexCommand(command)) {
    return parseCodexMessages(output);
  }

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
  } else if (currentUserText !== null) {
    // User input exists but no assistant response yet — still record the turn
    turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
  }

  for (const turn of turns) {
    messages.push({ role: "user", content: turn.user });
    const content = turn.assistantLines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/[\n\s]+$/, "");
    if (content) {
      messages.push({ role: "assistant", content });
    }
  }

  return messages;
}
