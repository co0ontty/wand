import type { ConversationDetail } from "./conversation-types.js";
import type { ConversationTurn } from "./types.js";

export interface ConversationHistory {
  revision: string;
  from: string | null;
  hasEarlier: boolean;
  total: number;
}
export interface ConversationSync {
  id: string;
  history: ConversationHistory;
  unchanged?: boolean;
  reset?: boolean;
  detail?: Omit<ConversationDetail, "messages">;
  messages?: ConversationTurn[];
  messageOrder?: string[];
}
export interface ConversationSyncQuery { since?: string; from?: string; older?: boolean; limit?: number }

/** Shared client reducer. The server's order also removes deleted or moved rows. */
export function mergeConversationSync(previous: ConversationDetail | null, update: ConversationSync): ConversationDetail & { history: ConversationHistory } {
  if (previous && previous.id !== update.id) previous = null;
  if (update.unchanged) {
    if (!previous) throw new Error("缺少对话同步基线，请重新读取。");
    return { ...previous, history: update.history };
  }
  const messages = new Map((update.reset ? [] : previous?.messages ?? []).map(turn => [turn.messageId, turn]));
  for (const turn of update.messages ?? []) messages.set(turn.messageId, turn);
  const ordered = (update.messageOrder ?? []).map(id => { const turn = messages.get(id);
    if (!turn) throw new Error("对话同步缺少消息，请重新读取。"); return turn; });
  const detail = update.detail ?? previous;
  if (!detail || detail.id !== update.id) throw new Error("对话同步身份不一致。");
  return { ...detail, messages: ordered, history: update.history };
}
