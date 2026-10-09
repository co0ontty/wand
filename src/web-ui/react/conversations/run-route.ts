import type { AiTeamRun } from "../../../ai-team-types.js";
import type { ConversationSummary } from "../../../conversation-types.js";

/** Resolve only explicit ownership; never guess by title or the most recent run. */
export function conversationForRun(run: Pick<AiTeamRun, "id" | "conversationId" | "chatSessionId">,
  conversations: readonly ConversationSummary[] = []): string | null {
  if (run.conversationId) return run.conversationId;
  const matches = conversations.filter(item => item.kind === "group" && (
    (!!run.chatSessionId && item.sessionId === run.chatSessionId)
    || item.tasks.some(task => task.runs.some(candidate => candidate.id === run.id))
  ));
  return matches.length === 1 ? matches[0]!.id : null;
}
