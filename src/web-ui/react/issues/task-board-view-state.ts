import {
  EMPTY_ISSUE_FILTERS, ISSUE_BOARD_VIEWS, ISSUE_PRIORITIES,
  type IssueBoardFilters, type IssueBoardView,
} from "./task-board-agent";

export interface TaskBoardViewState {
  view: IssueBoardView;
  query: string;
  workspaceId: string;
  filters: IssueBoardFilters;
}

const STORAGE_KEY = "wand.task-board.view-state";

export function parseTaskBoardViewState(value: unknown): TaskBoardViewState {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const filter = item.filters && typeof item.filters === "object"
    ? item.filters as Record<string, unknown> : {};
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    view: ISSUE_BOARD_VIEWS.some((entry) => entry.value === item.view) ? item.view as IssueBoardView : "board",
    query: typeof item.query === "string" ? item.query : "",
    workspaceId: typeof item.workspaceId === "string" ? item.workspaceId : "",
    filters: {
      statuses: strings(filter.statuses).filter((entry): entry is IssueBoardFilters["statuses"][number] =>
        ["todo", "doing", "done", "archived"].includes(entry)),
      priorities: strings(filter.priorities).filter((entry): entry is IssueBoardFilters["priorities"][number] =>
        ISSUE_PRIORITIES.some((priority) => priority.value === entry)),
      labels: strings(filter.labels),
    },
  };
}

/** Search may contain local paths; keep browsing context in this tab, outside shareable URLs. */
export function readTaskBoardViewState(): TaskBoardViewState {
  try {
    return parseTaskBoardViewState(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return { view: "board", query: "", workspaceId: "", filters: EMPTY_ISSUE_FILTERS };
  }
}

export function writeTaskBoardViewState(state: TaskBoardViewState): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Private browsing remains usable. */ }
}
