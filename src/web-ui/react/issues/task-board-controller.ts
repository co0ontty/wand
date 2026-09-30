/** 看板、AI 团队页与群聊页共用这一条独立路由：同一时刻只开其中一页，返回键行为一致。 */
export type TaskBoardPage = "board" | "teams" | "teamchat";

export interface TaskBoardControllerSnapshot {
  open: boolean;
  page: TaskBoardPage;
  workspaceId: string;
  sessionId: string;
  /** page === "teamchat" 时要打开的团队运行 id（也持久化在 URL `run` 参数里）。 */
  runId: string;
  /** 团队联系人入口要预选并展开开工表单的团队。 */
  teamId: string;
  revision: number;
}

type Listener = () => void;
type HistoryMode = "push" | "replace";

export const TASK_BOARD_VIEW_PARAM = "view";
export const TASK_BOARD_VIEW = "taskboard";
export const AI_TEAMS_VIEW = "teams";
export const TEAM_CHAT_VIEW = "teamchat";
export const TEAM_CHAT_RUN_PARAM = "run";
const TASK_BOARD_VIEW_ALIASES = new Set(["taskboard", "issues", AI_TEAMS_VIEW, TEAM_CHAT_VIEW]);

const HISTORY_STATE_KEY = "wandShellView";

let snapshot: TaskBoardControllerSnapshot = {
  open: false,
  page: "board",
  workspaceId: "",
  sessionId: "",
  runId: "",
  teamId: "",
  revision: 0,
};
const listeners = new Set<Listener>();
let historyInstalled = false;
/** True only for the history entry this tab pushed by opening the board. */
let openedViaPush = false;
let closingViaBack = false;
let reopenAfterBack: { workspaceId: string; sessionId: string; page: TaskBoardPage; runId: string; teamId: string } | null = null;

function publish(next: Partial<TaskBoardControllerSnapshot>): void {
  snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 };
  listeners.forEach((listener) => listener());
}

function searchFrom(search: string): string {
  return search.startsWith("?") ? search.slice(1) : search;
}

/** Whether a query string currently addresses the task board route. */
export function isTaskBoardView(search: string): boolean {
  const value = new URLSearchParams(searchFrom(search)).get(TASK_BOARD_VIEW_PARAM);
  return value != null && TASK_BOARD_VIEW_ALIASES.has(value);
}

export function taskBoardPageOf(search: string): TaskBoardPage {
  const value = new URLSearchParams(searchFrom(search)).get(TASK_BOARD_VIEW_PARAM);
  if (value === AI_TEAMS_VIEW) return "teams";
  if (value === TEAM_CHAT_VIEW) return "teamchat";
  return "board";
}

/** 群聊页地址里带的运行 id；页面刷新后靠它恢复同一个群聊。 */
export function teamChatRunOf(search: string): string {
  return new URLSearchParams(searchFrom(search)).get(TEAM_CHAT_RUN_PARAM) ?? "";
}

/** Add or remove `view=taskboard` (or `view=teams` / `view=teamchat&run=…`) without touching unrelated query params. */
export function taskBoardSearch(
  search: string,
  open: boolean,
  page: TaskBoardPage = "board",
  runId = "",
): string {
  const params = new URLSearchParams(searchFrom(search));
  if (open) {
    params.set(
      TASK_BOARD_VIEW_PARAM,
      page === "teams" ? AI_TEAMS_VIEW : page === "teamchat" ? TEAM_CHAT_VIEW : TASK_BOARD_VIEW,
    );
  } else {
    params.delete(TASK_BOARD_VIEW_PARAM);
  }
  if (open && page === "teamchat" && runId) params.set(TEAM_CHAT_RUN_PARAM, runId);
  else params.delete(TEAM_CHAT_RUN_PARAM);
  const next = params.toString();
  return next ? `?${next}` : "";
}

function locationSearch(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location.search;
  } catch {
    return "";
  }
}

function historyState(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const state = window.history.state;
  return state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
}

function writeLocation(open: boolean, mode: HistoryMode): void {
  if (typeof window === "undefined" || !window.history) return;
  const url = new URL(window.location.href);
  url.search = taskBoardSearch(url.search, open, snapshot.page, snapshot.runId);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const state = { ...historyState(), [HISTORY_STATE_KEY]: open ? TASK_BOARD_VIEW : null };
  if (next === current || mode === "replace") {
    window.history.replaceState(state, "", next);
    return;
  }
  window.history.pushState(state, "", next);
}

function onPopState(): void {
  const shouldOpen = isTaskBoardView(locationSearch());
  openedViaPush = false;
  closingViaBack = false;
  const reopen = reopenAfterBack;
  reopenAfterBack = null;
  if (reopen) {
    taskBoardController.open(reopen.workspaceId, reopen.sessionId, reopen.page, reopen.runId, reopen.teamId);
    return;
  }
  const page = shouldOpen ? taskBoardPageOf(locationSearch()) : snapshot.page;
  if (shouldOpen === snapshot.open && page === snapshot.page) return;
  publish({
    open: shouldOpen,
    page,
    runId: page === "teamchat" ? teamChatRunOf(locationSearch()) : "",
    teamId: "",
  });
}

export function installTaskBoardHistory(): void {
  if (historyInstalled || typeof window === "undefined") return;
  historyInstalled = true;
  window.addEventListener("popstate", onPopState);
  if (!isTaskBoardView(locationSearch())) return;
  if (!snapshot.open) {
    const page = taskBoardPageOf(locationSearch());
    publish({ open: true, page, ...(page === "teamchat" ? { runId: teamChatRunOf(locationSearch()) } : {}) });
  }
  writeLocation(true, "replace");
}

export const taskBoardController = {
  open(workspaceId = "", sessionId = "", page: TaskBoardPage = "board", runId = "", teamId = ""): void {
    installTaskBoardHistory();
    if (closingViaBack) {
      reopenAfterBack = { workspaceId, sessionId, page, runId, teamId };
      return;
    }
    const wasOpen = snapshot.open;
    const pageChanged = snapshot.page !== page;
    const runChanged = page === "teamchat" && snapshot.runId !== runId;
    publish({ open: true, workspaceId, sessionId, page, runId: page === "teamchat" ? runId : "", teamId: page === "teams" ? teamId : "" });
    if (wasOpen) {
      // 看板 ⇄ 团队页 ⇄ 群聊页之间切换只改地址，不多压一层历史：返回键仍然一步回到会话。
      if (pageChanged || runChanged) writeLocation(true, "replace");
      return;
    }
    if (isTaskBoardView(locationSearch())) {
      writeLocation(true, "replace");
      return;
    }
    writeLocation(true, "push");
    openedViaPush = true;
  },
  close(): void {
    installTaskBoardHistory();
    reopenAfterBack = null;
    if (closingViaBack || !snapshot.open) return;
    if (openedViaPush && typeof window !== "undefined") {
      openedViaPush = false;
      closingViaBack = true;
      publish({ open: false });
      // Traversal completes at popstate; replacing here destroys the forward entry.
      window.history.back();
      return;
    }
    publish({ open: false });
    writeLocation(false, "replace");
  },
};

export const taskBoardStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): TaskBoardControllerSnapshot {
    return snapshot;
  },
};

declare global {
  interface Window {
    __wandReactTaskBoard?: typeof taskBoardController;
  }
}
