import { randomUUID } from "node:crypto";

import type { ContentBlock, ConversationTurn, SessionSnapshot } from "./types.js";
import { thinkingEffortToOpenCodeVariant } from "./structured-provider-common.js";

export interface OpenCodeTurnState {
  blocks: ContentBlock[];
  result: string;
  sessionId: string | null;
  usage?: ConversationTurn["usage"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractStructuredText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractStructuredText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["text", "output_text", "message", "content", "summary"]) {
    const text = extractStructuredText(record[key]);
    if (text) return text;
  }
  return "";
}

export function buildOpenCodeArgs(session: SessionSnapshot): string[] {
  const args = ["run", "--format", "json", "--thinking"];
  const modelChoice = session.selectedModel?.trim();
  if (modelChoice && modelChoice !== "default") args.push("--model", modelChoice);

  const variant = thinkingEffortToOpenCodeVariant(session.thinkingEffort);
  if (variant) args.push("--variant", variant);
  if (
    session.autoApprovePermissions === true
    || session.mode === "full-access"
    || session.mode === "managed"
    || session.mode === "auto-edit"
  ) {
    args.push("--dangerously-skip-permissions");
  }
  if (session.claudeSessionId) args.push("--session", session.claudeSessionId);
  return args;
}

export function openCodeToolName(name: string): string {
  const mapped: Record<string, string> = {
    bash: "Bash",
    shell: "Bash",
    read: "Read",
    edit: "Edit",
    write: "Write",
    glob: "Glob",
    grep: "Grep",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    todowrite: "TodoWrite",
    task: "Task",
    skill: "Skill",
  };
  return mapped[name.toLowerCase()] ?? `OpenCode/${name}`;
}

/** Apply one OpenCode NDJSON event to the current transport-neutral turn state. */
export function applyOpenCodeEvent(
  turnState: OpenCodeTurnState,
  event: Record<string, unknown>,
  createId: () => string = randomUUID,
): string | null {
  if (typeof event.sessionID === "string" && event.sessionID) turnState.sessionId = event.sessionID;
  const type = typeof event.type === "string" ? event.type : "";
  const part = asRecord(event.part);
  if (!part) {
    if (type === "error") return extractStructuredText(event.error) || "OpenCode run failed";
    return null;
  }

  if (type === "text" && typeof part.text === "string" && part.text.trim()) {
    turnState.blocks.push({ type: "text", text: part.text });
    turnState.result += (turnState.result ? "\n" : "") + part.text;
    return null;
  }
  if (type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
    turnState.blocks.push({ type: "thinking", thinking: part.text });
    return null;
  }
  if (type === "tool_use") {
    const state = asRecord(part.state) ?? {};
    const tool = typeof part.tool === "string" && part.tool ? part.tool : "tool";
    const toolId = typeof part.callID === "string" && part.callID
      ? part.callID
      : typeof part.id === "string" && part.id
        ? part.id
        : createId();
    const input = asRecord(state.input) ?? {};
    turnState.blocks.push({
      type: "tool_use",
      id: toolId,
      name: openCodeToolName(tool),
      description: typeof state.title === "string" ? state.title : undefined,
      input,
    });
    const failed = state.status === "error";
    const content = failed
      ? (typeof state.error === "string" ? state.error : "OpenCode tool failed")
      : (typeof state.output === "string" ? state.output : "");
    turnState.blocks.push({ type: "tool_result", tool_use_id: toolId, content, is_error: failed });
    return null;
  }
  if (type === "step_finish") {
    const tokens = asRecord(part.tokens);
    const cache = asRecord(tokens?.cache);
    const previous = turnState.usage ?? {};
    turnState.usage = {
      inputTokens: (previous.inputTokens ?? 0) + (typeof tokens?.input === "number" ? tokens.input : 0),
      outputTokens: (previous.outputTokens ?? 0) + (typeof tokens?.output === "number" ? tokens.output : 0),
      reasoningOutputTokens: (previous.reasoningOutputTokens ?? 0) + (typeof tokens?.reasoning === "number" ? tokens.reasoning : 0),
      cacheReadInputTokens: (previous.cacheReadInputTokens ?? 0) + (typeof cache?.read === "number" ? cache.read : 0),
      cacheCreationInputTokens: (previous.cacheCreationInputTokens ?? 0) + (typeof cache?.write === "number" ? cache.write : 0),
      totalCostUsd: (previous.totalCostUsd ?? 0) + (typeof part.cost === "number" ? part.cost : 0),
    };
  }
  return null;
}
