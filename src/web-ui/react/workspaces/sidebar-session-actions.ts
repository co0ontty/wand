import { httpWorkspacesRepository } from "./repository";
import { workspacesStore } from "./controller";
import { workspaceContextStore } from "./workspace-context";
import { closeSessionPane } from "./window-layout";
import type { TaskSummary } from "./types";

/** Shared deletion choreography: atomic server deletion, active layout cleanup, then session refresh. */
export async function deleteSidebarSessions(sessionIds: readonly string[], task: TaskSummary | null): Promise<void> {
  const ids = [...new Set(sessionIds.filter(id => id.trim().length > 0))];
  if (!ids.length) return;
  await httpWorkspacesRepository.deleteSessions(ids);
  const runtime = workspacesStore.getRuntime();
  try {
    const context = workspaceContextStore.getSnapshot();
    if (runtime && task && context.taskId === task.id && context.layout) {
      const next = ids.reduce((layout, id) => closeSessionPane(layout, id), context.layout);
      await runtime.saveTaskLayout(next);
    }
  } finally { await runtime?.refreshSessions(); }
}

export async function archiveSidebarSession(sessionId: string, archived: boolean): Promise<void> {
  await httpWorkspacesRepository.batchArchiveSessions([sessionId], archived);
  await workspacesStore.getRuntime()?.refreshSessions();
}
