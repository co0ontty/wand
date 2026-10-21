import type { ConversationSessionUpdate } from "../../../conversation-types.js";

// WebSocket frames only need to fan out the small update; rendering stays in
// the lazy conversation view so the shell does not download chat/markdown code.
const listeners = new Set<(update: ConversationSessionUpdate) => void>();

export function notifyConversationSessionPreview(update: ConversationSessionUpdate): void {
  for (const listener of listeners) listener(update);
}

export function subscribeConversationSessionPreview(listener: (update: ConversationSessionUpdate) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
