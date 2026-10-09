import type { WandStorage } from "./storage.js";
import type { SessionSnapshot } from "./types.js";
import type { SessionRegistry } from "./session-registry.js";
import { projectCwdForSession, normalizeProjectCwd } from "./workspace-binding.js";

/**
 * Close cards linked to this commit. The session's own task (or the task the client
 * opened this chat from) leaves the active list even while it is still in progress —
 * that is the row the user just asked to archive. Other cards only close when they are
 * already done: a shared iteration can contain unrelated in-progress work, and selecting
 * its prompts must not sweep those cards off the list.
 */
function cardIdForSession(storage: WandStorage, sessionId: string): string | null {
  const binding = storage.getSessionWorkspace(sessionId);
  const card = binding?.workspaceTaskId
    ? storage.getWandTaskByWorkspaceTaskId(binding.workspaceTaskId)
    : null;
  return card?.id ?? storage.getWandTaskIdForSession(sessionId);
}

export function archiveCommitTasks(
  storage: WandStorage,
  session: SessionSnapshot,
  entryIds: readonly string[],
  options: { workspaceTaskId?: string | null } = {},
): string[] {
  const directory = projectCwdForSession(session);
  const currentTaskId = cardIdForSession(storage, session.id);
  const openedTaskId = options.workspaceTaskId
    ? storage.getWandTaskByWorkspaceTaskId(options.workspaceTaskId)?.id ?? null
    : null;
  // These two are the task the user is looking at. Archive them even if still todo/doing.
  const inProgressAllowed = new Set<string>();
  if (currentTaskId) inProgressAllowed.add(currentTaskId);
  if (openedTaskId) inProgressAllowed.add(openedTaskId);

  const related = new Set<string>(inProgressAllowed);
  for (const entry of storage.listIterationPromptsByIds(entryIds)) {
    const taskId = entry.taskId || (entry.sessionId ? cardIdForSession(storage, entry.sessionId) : null);
    if (taskId) related.add(taskId);
  }

  const eligible: string[] = [];
  for (const id of related) {
    const task = storage.getWandTask(id);
    if (!task || task.status === "archived") continue;
    if (task.status !== "done" && !inProgressAllowed.has(id)) continue;
    // Project directory constrains selected history; standalone cards qualify via this session.
    const workspace = task.workspaceId ? storage.getWorkspace(task.workspaceId) : null;
    const sameDirectory = !!workspace && workspace.kind !== "global"
      && !!directory && normalizeProjectCwd(workspace.cwd) === directory;
    if (!sameDirectory && !(id === currentTaskId && (!workspace || workspace.kind === "global"))) continue;
    eligible.push(id);
  }
  return storage.archiveWandTasks(eligible);
}

/** Sweep standalone chats in this project, including those absent from commit prompts. */
export function archiveCommitStandaloneSessions(
  storage: WandStorage,
  sessions: Pick<SessionRegistry, "listSlim" | "setArchived">,
  session: SessionSnapshot,
  archivedSessionIds: string[],
): void {
  const directory = projectCwdForSession(session);
  if (!directory) return;
  for (const candidate of sessions.listSlim()) {
    if (candidate.archived || projectCwdForSession(candidate) !== directory) continue;
    // A workspace task remains a task even if it has no corresponding board card.
    if (candidate.workspaceTaskId || cardIdForSession(storage, candidate.id)) continue;
    if (sessions.setArchived(candidate.id, true)) archivedSessionIds.push(candidate.id);
  }
}
