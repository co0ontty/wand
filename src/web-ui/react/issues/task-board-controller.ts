export interface TaskBoardControllerSnapshot {
  open: boolean;
  workspaceId: string;
  sessionId: string;
  revision: number;
}

type Listener = () => void;
type HistoryMode = "push" | "replace";

export const TASK_BOARD_VIEW_PARAM = "view";
export const TASK_BOARD_VIEW = "taskboard";
export const TASK_BOARD_VIEW_ALIASES = new Set(["taskboard", "issues"]);

const HISTORY_STATE_KEY = "wandShellView";

let snapshot: TaskBoardControllerSnapshot = {
  open: false,
  workspaceId: "",
  sessionId: "",
  revision: 0,
};
const listeners = new Set<Listener>();
let historyInstalled = false;
/** True only for the history entry this tab pushed by opening the board. */
let openedViaPush = false;

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

/** Add or remove `view=taskboard` without touching unrelated query params. */
export function taskBoardSearch(search: string, open: boolean): string {
  const params = new URLSearchParams(searchFrom(search));
  if (open) params.set(TASK_BOARD_VIEW_PARAM, TASK_BOARD_VIEW);
  else params.delete(TASK_BOARD_VIEW_PARAM);
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
  url.search = taskBoardSearch(url.search, open);
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
  if (shouldOpen === snapshot.open) return;
  publish({ open: shouldOpen });
}

export function installTaskBoardHistory(): void {
  if (historyInstalled || typeof window === "undefined") return;
  historyInstalled = true;
  window.addEventListener("popstate", onPopState);
  if (!isTaskBoardView(locationSearch())) return;
  if (!snapshot.open) publish({ open: true });
  writeLocation(true, "replace");
}

export const taskBoardController = {
  open(workspaceId = "", sessionId = ""): void {
    installTaskBoardHistory();
    const wasOpen = snapshot.open;
    publish({ open: true, workspaceId, sessionId });
    if (wasOpen) return;
    if (isTaskBoardView(locationSearch())) {
      writeLocation(true, "replace");
      return;
    }
    writeLocation(true, "push");
    openedViaPush = true;
  },
  close(): void {
    installTaskBoardHistory();
    if (!snapshot.open) return;
    if (openedViaPush && typeof window !== "undefined") {
      openedViaPush = false;
      window.history.back();
      if (!snapshot.open) return;
      publish({ open: false });
      writeLocation(false, "replace");
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
