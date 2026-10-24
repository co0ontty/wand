import { projectPiToolResult } from "./pi-tool-result-preview.js";

/** Fields consumed by Wand's Pi reducer. Context/entries are CLI-owned history,
 * not new output. Never journal repeated copies of that history in native mode. */
export const PI_PROTOCOL_FIELDS = new Set([
  "type", "id", "message", "assistantMessageEvent", "toolCallId", "toolName",
  "args", "result", "partialResult", "isError", "messages",
]);

/** agent_end is a reconciliation snapshot, not a second replay of every turn.
 * The latest assistant owns the final answer, usage and stop/error facts. This
 * also supports CLIs that emit only the final snapshot (without deltas). */
export function lastPiAssistantMessage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const messages = event.type === "agent_end" && Array.isArray(event.messages) ? event.messages
    : event.type === "message_end" || event.type === "turn_end" ? [event.message] : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && typeof message === "object" && !Array.isArray(message)
      && (message as Record<string, unknown>).role === "assistant") return message as Record<string, unknown>;
  }
  return undefined;
}

export function projectPiProtocolEvent(event: Record<string, unknown>): Record<string, unknown> {
  const projected = Object.fromEntries(Object.entries(event).filter(([key]) => PI_PROTOCOL_FIELDS.has(key)));
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    const last = lastPiAssistantMessage(event);
    projected.messages = last ? [last] : [];
  }
  const message = event.message;
  if (message && typeof message === "object" && !Array.isArray(message)
    && ["user", "toolResult"].includes(String((message as Record<string, unknown>).role))) {
    // These are duplicate transcript snapshots. tool_execution_end already
    // carries the result; do not serialize its image/body a second time.
    projected.message = { role: (message as Record<string, unknown>).role };
  }
  if (event.type === "tool_execution_end" || event.type === "tool_execution_update") {
    const key = event.type === "tool_execution_end" ? "result" : "partialResult";
    if (key in projected) projected[key] = projectPiToolResult(projected[key]);
  }
  return projected;
}
