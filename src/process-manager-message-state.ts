import { ConversationTurn, SessionSnapshot } from "./types.js";

export interface PersistedMessageState {
  count: number;
  signature: string;
}
/** Derive a short summary for a session from user messages or current task. */
function getLastMessageSignature(messages: ConversationTurn[]): string {
  const last = messages[messages.length - 1];
  if (!last) {
    return "";
  }
  const lastContent = JSON.stringify(last.content ?? []);
  return `${last.role}:${lastContent}`;
}

export function getPersistedMessageState(messages: ConversationTurn[]): PersistedMessageState {
  return {
    count: messages.length,
    signature: getLastMessageSignature(messages),
  };
}

export function shouldPersistMessages(
  lastState: PersistedMessageState | undefined,
  nextMessages: ConversationTurn[]
): boolean {
  if (nextMessages.length === 0) {
    return false;
  }
  const nextState = getPersistedMessageState(nextMessages);
  return !lastState
    || lastState.count !== nextState.count
    || lastState.signature !== nextState.signature;
}

export function recoverMessagesFromSnapshot(snapshot: SessionSnapshot): ConversationTurn[] {
  return snapshot.messages ?? [];
}

export function deriveSessionSummary(messages: ConversationTurn[]): string | undefined {
  // Prefer first user message as summary
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text.trim()) {
        return block.text.trim().slice(0, 120);
      }
    }
    break;
  }
  return undefined;
}
