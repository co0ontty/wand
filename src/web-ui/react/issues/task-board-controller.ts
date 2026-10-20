import { pageSearch, subscribePageRoute, updatePageRoute } from "../../page-route";

/** Independent feature pages share the same URL owner and browser history. */
export type TaskBoardPage = "board" | "teams" | "teamchat" | "schedules" | "calendar";
export interface TaskBoardControllerSnapshot {
  open: boolean;
  page: TaskBoardPage;
  workspaceId: string;
  sessionId: string;
  runId: string;
  teamId: string;
  calendarRange: "month" | "week";
  revision: number;
}
type Listener = () => void;
export const TASK_BOARD_VIEW_PARAM = "view";
export const TASK_BOARD_VIEW = "taskboard";
export const AI_TEAMS_VIEW = "teams";
export const TEAM_CHAT_VIEW = "teamchat";
export const SCHEDULED_TASKS_VIEW = "schedules";
export const GLOBAL_CALENDAR_VIEW = "calendar";
export const TEAM_CHAT_RUN_PARAM = "run";
const views: Record<TaskBoardPage, string> = { board: TASK_BOARD_VIEW, teams: AI_TEAMS_VIEW, teamchat: TEAM_CHAT_VIEW, schedules: SCHEDULED_TASKS_VIEW, calendar: GLOBAL_CALENDAR_VIEW };
let snapshot: TaskBoardControllerSnapshot = { open: false, page: "board", workspaceId: "", sessionId: "", runId: "", teamId: "", calendarRange: "month", revision: 0 };
const listeners = new Set<Listener>();
let historyInstalled = false;
function publish(next: Partial<TaskBoardControllerSnapshot>): void {
  snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 };
  listeners.forEach(listener => listener());
}
export function isTaskBoardView(search: string): boolean {
  const view = new URLSearchParams(search).get("view");
  return view === "issues" || Object.values(views).includes(view ?? "");
}
export function taskBoardPageOf(search: string): TaskBoardPage {
  const view = new URLSearchParams(search).get("view");
  return (Object.keys(views) as TaskBoardPage[]).find(page => views[page] === view) ?? "board";
}
export function teamChatRunOf(search: string): string { return new URLSearchParams(search).get("run") ?? ""; }
/** Existing query links and unrelated shell flags stay compatible. */
export function taskBoardSearch(search: string, open: boolean, page: TaskBoardPage = "board", runId = "", calendarRange: "month" | "week" = "month"): string {
  const params = new URLSearchParams(search);
  const ownedRange = params.get("view") === "calendar" || page === "calendar";
  if (open) params.set("view", views[page]); else params.delete("view");
  if (open && page === "teamchat" && runId) params.set("run", runId); else params.delete("run");
  if (open && page === "calendar" && calendarRange === "week") params.set("range", "week"); else if (ownedRange) params.delete("range");
  return params.size ? `?${params}` : "";
}
function restore(): void {
  const search = pageSearch();
  const open = isTaskBoardView(search);
  const page = taskBoardPageOf(search);
  const params = new URLSearchParams(search);
  const runId = page === "teamchat" ? teamChatRunOf(search) : "";
  const teamId = page === "teams" ? params.get("team") ?? "" : "";
  const calendarRange = params.get("range") === "week" ? "week" : "month";
  if (open === snapshot.open && page === snapshot.page && runId === snapshot.runId && teamId === snapshot.teamId && calendarRange === snapshot.calendarRange) return;
  publish({ open, page, runId, teamId, calendarRange });
}
export function installTaskBoardHistory(): void {
  if (historyInstalled || typeof window === "undefined") return;
  historyInstalled = true;
  subscribePageRoute(restore);
  restore();
}
export const taskBoardController = {
  open(workspaceId = "", sessionId = "", page: TaskBoardPage = "board", runId = "", teamId = ""): void {
    installTaskBoardHistory();
    const params = new URLSearchParams(pageSearch());
    updatePageRoute({ view: views[page], run: page === "teamchat" ? runId : null,
      ...(page === "teams" && teamId ? { team: teamId } : {}),
      ...(page === "board" && !params.has("directory") && workspaceId ? { directory: workspaceId } : {}),
    });
    publish({ open: true, page, workspaceId: page === "calendar" ? "" : workspaceId, sessionId: page === "calendar" ? "" : sessionId,
      runId: page === "teamchat" ? runId : "", teamId: page === "teams" ? teamId || params.get("team") || "" : "" });
  },
  calendarRange(value: "month" | "week"): void {
    updatePageRoute({ range: value });
    if (snapshot.calendarRange !== value) publish({ calendarRange: value });
  },
  close(): void {
    installTaskBoardHistory();
    if (!snapshot.open) return;
    // Explicit navigation creates a synchronous entry; Back/Forward only restore.
    // No asynchronous history.back() can race the next sidebar destination.
    updatePageRoute({ view: "workspace" });
    if (snapshot.open) publish({ open: false });
  },
};
export const taskBoardStore = {
  subscribe(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot(): TaskBoardControllerSnapshot { return snapshot; },
};
declare global { interface Window { __wandReactTaskBoard?: typeof taskBoardController; } }
