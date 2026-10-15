import type { ConversationSummary } from "../../../conversation-types.js";
import { isSessionActive } from "../workspaces/sidebar-display-mode";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../workspaces/types";

export function conversationActivitySessions(groups: readonly TaskDirectoryGroup[]): WorkspaceSessionSummary[] {
  return groups.flatMap(group => [
    ...group.tasks.flatMap(task => [...task.sessions, ...(task.archivedSessions ?? [])]),
    ...group.standaloneSessions, ...(group.archivedSessions ?? []),
  ]);
}

/** Runtime/completion facts, not message timestamps or archive state, define activity. */
export function isConversationActive(item: ConversationSummary, sessions: readonly WorkspaceSessionSummary[],
  _selectedConversationId: string | null, _selectedSessionId: string | null): boolean {
  const sessionIds = new Set([item.sessionId, item.communicationSessionId, ...(item.historySessionIds ?? []),
    ...item.tasks.flatMap(entry => entry.runs.map(run => run.chatSessionId))].filter(Boolean));
  if (sessions.some(session => (item.kind === "dm" ? session.employeeId === item.peerEmployeeId && !session.teamChat : sessionIds.has(session.id))
    && isSessionActive(session))) return true;
  return item.tasks.some(entry => {
    if (entry.task.status === "archived") return false;
    const run = entry.runs[0];
    return run ? ["running", "waiting_user", "awaiting_approval", "failed"].includes(run.status)
      : entry.startup?.state === "pending" || entry.startup?.state === "failed";
  });
}
