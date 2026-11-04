import type { ContentBlock } from "./types.js";
import type { StructuredRunnerTurnState } from "./structured-runner.js";

type PartType = "text" | "thinking";
interface PartCursor { type: PartType; contentIndex?: number; blockIndex: number; }
interface MessageCursor {
  key?: string;
  inputMessageId?: string;
  blockStart: number;
  resultStart: number;
  parts: PartCursor[];
}
type PiContentState = StructuredRunnerTurnState & { piAssistantContent?: MessageCursor };

function messageKey(message: Record<string, unknown>): string | undefined {
  if (typeof message.id === "string" && message.id) return `id:${message.id}`;
  if (typeof message.timestamp === "number") return `timestamp:${message.timestamp}`;
  return undefined;
}

function beginMessage(state: PiContentState, key?: string): MessageCursor {
  // Plain data survives native-file checkpoints; no process-local object identity.
  return state.piAssistantContent = { key, inputMessageId: state.inputMessageId,
    blockStart: state.blocks.length, resultStart: state.result.length, parts: [] };
}

function currentMessage(state: PiContentState): MessageCursor {
  const cursor = state.piAssistantContent;
  return cursor && cursor.inputMessageId === state.inputMessageId && cursor.blockStart <= state.blocks.length
    ? cursor : beginMessage(state);
}

export function startPiAssistantContent(state: PiContentState, message: Record<string, unknown>): void {
  // A protocol start is a new message, including two starts in the same millisecond.
  beginMessage(state, messageKey(message));
}

function syncResult(state: PiContentState, cursor: MessageCursor): void {
  state.result = state.result.slice(0, cursor.resultStart) + state.blocks.slice(cursor.blockStart)
    .filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function updatePiAssistantContent(
  state: PiContentState, update: Record<string, unknown>, observedAt?: string,
): void {
  const kind: PartType | null = typeof update.type === "string" && update.type.startsWith("text_") ? "text"
    : typeof update.type === "string" && update.type.startsWith("thinking_") ? "thinking" : null;
  if (!kind || ![`${kind}_start`, `${kind}_delta`, `${kind}_end`].includes(String(update.type))) return;
  const cursor = currentMessage(state);
  const contentIndex = typeof update.contentIndex === "number" && Number.isSafeInteger(update.contentIndex)
    && update.contentIndex >= 0 ? update.contentIndex : undefined;
  // Older native bridges omitted contentIndex. Their per-type start boundaries
  // still identify the active part, even when another type streams in between.
  let part = contentIndex !== undefined ? cursor.parts.find((part) => part.contentIndex === contentIndex)
    : update.type === `${kind}_start` ? undefined : [...cursor.parts].reverse().find((part) => part.type === kind);
  if (!part) {
    part = { type: kind, contentIndex, blockIndex: state.blocks.length };
    cursor.parts.push(part);
    state.blocks.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
  }
  const block = state.blocks[part.blockIndex];
  if (block?.type !== kind) return;
  const delta = typeof update.delta === "string" ? update.delta : "";
  const content = typeof update.content === "string" ? update.content : undefined;
  if (block.type === "text") {
    if (update.type === "text_delta") block.text += delta;
    else if (update.type === "text_end" && content !== undefined) block.text = content;
    syncResult(state, cursor);
  } else if (block.type === "thinking") {
    if (observedAt) { block.occurredAt ??= observedAt; block.lastActivityAt = observedAt; }
    if (update.type === "thinking_delta") block.thinking += delta;
    else if (update.type === "thinking_end" && content !== undefined) block.thinking = content;
    if (update.type === "thinking_end" && !block.thinking.trim()) {
      state.blocks.splice(part.blockIndex, 1);
      cursor.parts = cursor.parts.filter((other) => other !== part);
      for (const other of cursor.parts) if (other.blockIndex > part.blockIndex) other.blockIndex--;
    }
  }
}

/** Final snapshots reconcile only their own assistant message. Repeated
 * message_end/turn_end/agent_end cannot append the streamed content again or
 * overwrite an earlier message because its text happened to be longer. */
export function reconcilePiAssistantContent(state: PiContentState, message: Record<string, unknown>): void {
  if (!Array.isArray(message.content)) return;
  const key = messageKey(message);
  const previous = state.piAssistantContent;
  // An old turn_end can follow a native input commit. It belongs to the
  // preceding user segment, whose blocks have already been persisted.
  if (key && previous?.key === key && previous.inputMessageId !== state.inputMessageId) return;
  let cursor = currentMessage(state);
  if (key && cursor.key && key !== cursor.key) cursor = beginMessage(state, key);
  cursor.key ??= key;
  const oldParts = cursor.parts.map((part) => ({ ...part, block: state.blocks[part.blockIndex] }));
  const blocks: ContentBlock[] = [];
  const parts: PartCursor[] = [];
  for (const [contentIndex, raw] of message.content.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "text" && item.type !== "thinking") continue;
    const type = item.type;
    const value = typeof item[type] === "string" ? item[type] as string : "";
    if (type === "thinking" ? !value.trim() : !value) continue;
    const priorIndex = oldParts.findIndex((part) => part.contentIndex === contentIndex && part.type === type);
    const fallbackIndex = priorIndex >= 0 ? priorIndex
      : oldParts.findIndex((part) => part.contentIndex === undefined && part.type === type);
    const prior = fallbackIndex >= 0 ? oldParts.splice(fallbackIndex, 1)[0].block : undefined;
    const block: ContentBlock = type === "text" ? { type, text: value }
      : { ...(prior?.type === "thinking" ? prior : {}), type, thinking: value };
    parts.push({ type, contentIndex, blockIndex: cursor.blockStart + blocks.length });
    blocks.push(block);
  }
  // Tool execution has its own owner and IDs. Keep results that arrived between
  // message_end and turn_end while rebuilding the authoritative content order.
  const tools = state.blocks.slice(cursor.blockStart).filter((block) => block.type === "tool_use" || block.type === "tool_result");
  state.blocks = [...state.blocks.slice(0, cursor.blockStart), ...blocks, ...tools];
  cursor.parts = parts;
  syncResult(state, cursor);
}
