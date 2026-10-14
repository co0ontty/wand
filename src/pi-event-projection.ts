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
  return projected;
}
