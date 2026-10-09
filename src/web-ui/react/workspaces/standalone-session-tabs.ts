import type { UiSessionVm } from "../shell/ui-store";
import { orderWorkspaceSessions, workspaceSessionProvider } from "./session-order";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "./types";

export interface StandaloneSessionTabScope {
  readonly group: TaskDirectoryGroup | null;
  readonly sessions: readonly WorkspaceSessionSummary[];
}

/** Directory ownership comes from the server, including repo/worktree normalization. */
export function standaloneSessionTabScope(
  groups: readonly TaskDirectoryGroup[],
  selected: Readonly<UiSessionVm> | null,
  liveSessions?: ReadonlyMap<string, Readonly<UiSessionVm>>,
): StandaloneSessionTabScope | null {
  if (!selected || (selected.source !== "wand" && selected.source !== "automation") || selected.workspaceTaskId || selected.archived) return null;
  const group = groups.find(candidate => candidate.standaloneSessions.some(session => session.id === selected.id));
  if (group) {
    const sessions = orderWorkspaceSessions(group.standaloneSessions.filter(session => {
      const live = liveSessions?.get(session.id);
      return !session.archived && !session.teamChat && !session.workspaceTaskId
        // Canonical selection can only open ids present in the live session list.
        && (!liveSessions || Boolean(live))
        && !live?.archived && !live?.workspaceTaskId;
    }));
    return sessions.some(session => session.id === selected.id) ? { group, sessions } : null;
  }
  // A just-created session reaches the live shell before the directory read. Keep
  // its own tab stable during that read; never infer sibling membership from cwd.
  const elsewhere = groups.some(candidate => (
    candidate.archivedSessions?.some(session => session.id === selected.id)
    || candidate.tasks.some(task => [...task.sessions, ...(task.archivedSessions ?? [])].some(session => session.id === selected.id))
  ));
  if (elsewhere) return null;
  return { group: null, sessions: [{
    id: selected.id, title: selected.title, cwd: selected.cwd, status: selected.status,
    provider: workspaceSessionProvider(selected), sessionKind: selected.kind,
    startedAt: selected.startedAt,
  }] };
}
