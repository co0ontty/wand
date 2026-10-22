import { pageSearch, subscribePageRoute } from "../page-route";
import { conversationUi } from "../react/conversations/state";
import { clearTaskBoardPreload, preloadTaskBoardList } from "../react/issues/task-board-list-repository";
import { httpWorkspacesRepository } from "../react/workspaces/repository";
import { loadSessionList } from "../react/session-list-snapshot";

/** Called only after session-check succeeds; every HTTP endpoint still authorizes the read. */
export function preloadAuthenticatedPage(): void {
  void loadSessionList().catch(() => {});
  const params = new URLSearchParams(pageSearch());
  const view = params.get("view");
  if (view === "taskboard" || view === "issues") {
    preloadTaskBoardList();
    void import("../react/issues/task-board-host").catch(() => {});
  }
  // Only the visible workspace projection needs the directory. Do not wake
  // hidden conversation/team pages or install another poll/subscription.
  if (params.get("sidebar") === "tasks" || (!params.has("sidebar") && conversationUi.getSnapshot().mode === "tasks")) {
    httpWorkspacesRepository.preloadTaskGroups();
    void import("../react/workspaces/workspaces-panel").catch(() => {});
  }
}

export function clearStartupPreloads(): void {
  clearTaskBoardPreload();
  httpWorkspacesRepository.clearPreload();
}

// A fast page switch must not leave an unused handoff to become a stale cache
// when that page is opened much later. Importing a module itself never selects it.
subscribePageRoute(clearStartupPreloads);
