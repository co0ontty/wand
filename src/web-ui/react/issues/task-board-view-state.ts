import {
  EMPTY_ISSUE_FILTERS, ISSUE_BOARD_VIEWS, ISSUE_PRIORITIES,
  type IssueBoardFilters, type IssueBoardView,
} from "./task-board-agent";
import type { WandTaskListed } from "./task-board-repository";

export const TASK_BOARD_SORTS = [
  { value: "manual", label: "默认顺序" },
  { value: "priority", label: "优先级优先" },
  { value: "due", label: "截止日期优先" },
  { value: "updated", label: "最近更新" },
] as const;
export type TaskBoardSort = typeof TASK_BOARD_SORTS[number]["value"];

/** Sort the projection only; preserve stored order and stable ties. Undated tasks stay last. */
export function sortTaskBoardTasks<T extends Pick<WandTaskListed, "priority" | "dueDate" | "updatedAt">>(tasks: T[], sort: TaskBoardSort): T[] {
  if (sort === "manual") return tasks;
  const rank = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return [...tasks].sort((a, b) => {
    if (sort === "priority") return rank[a.priority] - rank[b.priority];
    if (sort === "due") return (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export interface TaskBoardViewState {
  view: IssueBoardView;
  query: string;
  workspaceId: string;
  filters: IssueBoardFilters;
  sort: TaskBoardSort;
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
    sort: TASK_BOARD_SORTS.some((entry) => entry.value === item.sort) ? item.sort as TaskBoardSort : "manual",
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
    return { view: "board", query: "", workspaceId: "", filters: EMPTY_ISSUE_FILTERS, sort: "manual" };
  }
}

export function writeTaskBoardViewState(state: TaskBoardViewState): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Private browsing remains usable. */ }
}
