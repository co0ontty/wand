import type { WandStorage } from "./storage.js";
import type { SessionSnapshot } from "./types.js";
import { projectCwdForSession, normalizeProjectCwd } from "./workspace-binding.js";

/**
 * Only close completed cards linked to this commit's selected iteration entries (or its
 * session). A shared default iteration can contain several projects and old completed work;
 * neither is a reason to archive an unrelated card.
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
): string[] {
  const directory = projectCwdForSession(session);
  const related = new Set<string>();
  const currentTaskId = cardIdForSession(storage, session.id);
  if (currentTaskId) related.add(currentTaskId);

  for (const entry of storage.listIterationPromptsByIds(entryIds)) {
    const taskId = entry.taskId || (entry.sessionId ? cardIdForSession(storage, entry.sessionId) : null);
    if (taskId) related.add(taskId);
  }

  return storage.transaction(() => {
    const archived: string[] = [];
    for (const id of related) {
      const task = storage.getWandTask(id);
      if (task?.status !== "done") continue;
      // The workspace is the authoritative directory for a card. Worktree sessions use the
      // parent project directory; a global/unassigned card only qualifies via this very session.
      const workspace = task.workspaceId ? storage.getWorkspace(task.workspaceId) : null;
      const sameDirectory = !!workspace && workspace.kind !== "global"
        && !!directory && normalizeProjectCwd(workspace.cwd) === directory;
      if (!sameDirectory && !(id === currentTaskId && (!workspace || workspace.kind === "global"))) continue;
      storage.updateWandTask(id, { status: "archived" });
      archived.push(id);
    }
    return archived;
  });
}
