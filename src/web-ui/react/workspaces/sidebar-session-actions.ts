import { pageSearch, updatePageRoute } from "../../page-route";
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
  } finally {
    try { await runtime?.refreshSessions(); }
    finally {
      // Confirmed deletion cannot leave a reloadable link to a missing session.
      // A later user navigation belongs to that newer session.
      if (ids.includes(new URLSearchParams(pageSearch()).get("session") ?? "")) {
        updatePageRoute({ session: null, tab: null }, "replace");
      }
    }
  }
}

export async function archiveSidebarSession(sessionId: string, archived: boolean): Promise<void> {
  await httpWorkspacesRepository.batchArchiveSessions([sessionId], archived);
  await workspacesStore.getRuntime()?.refreshSessions();
}
