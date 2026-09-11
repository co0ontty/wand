import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "./types";
import { taskActivity, taskRecency } from "./sidebar-task-meta";

export interface SidebarManageSelection {
  readonly taskIds: readonly string[];
  readonly sessionIds: readonly string[];
}

export const EMPTY_SIDEBAR_MANAGE_SELECTION: SidebarManageSelection = Object.freeze({
  taskIds: [],
  sessionIds: [],
});

export const COLLAPSED_RAIL_LIMIT = 8;

export interface CollapsedRailTask {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly global: boolean;
  readonly task: TaskSummary;
  readonly activity: "attention" | "running" | null;
}

export interface CollapsedRailModel {
  readonly items: readonly CollapsedRailTask[];
  readonly overflow: number;
}

export function sidebarManageCount(selection: SidebarManageSelection): number {
  return selection.taskIds.length + selection.sessionIds.length;
}

export function toggleId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

export function toggleManagedTask(
  selection: SidebarManageSelection,
  taskId: string,
): SidebarManageSelection {
  return { ...selection, taskIds: toggleId(selection.taskIds, taskId) };
}

export function toggleManagedSession(
  selection: SidebarManageSelection,
  sessionId: string,
): SidebarManageSelection {
  return { ...selection, sessionIds: toggleId(selection.sessionIds, sessionId) };
}

export function collectManagedIds(groups: readonly TaskDirectoryGroup[]): SidebarManageSelection {
  const taskIds: string[] = [];
  const sessionIds: string[] = [];
  for (const group of groups) {
    for (const task of group.tasks) {
      taskIds.push(task.id);
      for (const session of task.sessions) sessionIds.push(session.id);
    }
    for (const session of group.standaloneSessions) sessionIds.push(session.id);
  }
  return { taskIds, sessionIds };
}

export function pruneManagedSelection(
  selection: SidebarManageSelection,
  groups: readonly TaskDirectoryGroup[],
): SidebarManageSelection {
  const visible = collectManagedIds(groups);
  const taskSet = new Set(visible.taskIds);
  const sessionSet = new Set(visible.sessionIds);
  return {
    taskIds: selection.taskIds.filter((id) => taskSet.has(id)),
    sessionIds: selection.sessionIds.filter((id) => sessionSet.has(id)),
  };
}

/** Selected tasks cascade their terminals; leftover sessions are deleted separately. */
export function resolveManagedDeletion(
  selection: SidebarManageSelection,
  groups: readonly TaskDirectoryGroup[],
): SidebarManageSelection {
  const taskSet = new Set(selection.taskIds);
  const owned = new Set<string>();
  for (const group of groups) {
    for (const task of group.tasks) {
      if (!taskSet.has(task.id)) continue;
      for (const session of task.sessions) owned.add(session.id);
    }
  }
  return {
    taskIds: [...taskSet],
    sessionIds: selection.sessionIds.filter((id) => !owned.has(id)),
  };
}

export function describeManagedDeletion(selection: SidebarManageSelection): string {
  const parts: string[] = [];
  if (selection.taskIds.length > 0) parts.push(`${selection.taskIds.length} 个任务`);
  if (selection.sessionIds.length > 0) parts.push(`${selection.sessionIds.length} 个终端`);
  return parts.join("和") || "所选项目";
}

export function findManagedTask(
  groups: readonly TaskDirectoryGroup[],
  taskId: string,
): TaskSummary | null {
  for (const group of groups) {
    const task = group.tasks.find((item) => item.id === taskId);
    if (task) return task;
  }
  return null;
}

export function findManagedSession(
  groups: readonly TaskDirectoryGroup[],
  sessionId: string,
): WorkspaceSessionSummary | null {
  for (const group of groups) {
    const standalone = group.standaloneSessions.find((item) => item.id === sessionId);
    if (standalone) return standalone;
    for (const task of group.tasks) {
      const session = task.sessions.find((item) => item.id === sessionId);
      if (session) return session;
    }
  }
  return null;
}

function railRank(item: CollapsedRailTask, activeTaskId: string | null): number {
  if (item.task.id === activeTaskId) return 0;
  if (item.activity === "attention") return 1;
  if (item.activity === "running") return 2;
  return 3;
}

/** Narrow rail: active / needing attention first, then recency. Cap the list. */
export function collapsedRailTasks(
  groups: readonly TaskDirectoryGroup[],
  activeTaskId: string | null,
  limit = COLLAPSED_RAIL_LIMIT,
): CollapsedRailModel {
  const items: CollapsedRailTask[] = groups.flatMap((group) => group.tasks.map((task) => ({
    workspaceId: group.workspaceId,
    workspaceName: group.global ? "独立任务" : group.workspaceName,
    global: Boolean(group.global),
    task,
    activity: taskActivity(task),
  })));
  items.sort((left, right) => {
    const rankDelta = railRank(left, activeTaskId) - railRank(right, activeTaskId);
    if (rankDelta !== 0) return rankDelta;
    return taskRecency(right.task).localeCompare(taskRecency(left.task));
  });
  const visible = items.slice(0, Math.max(0, limit));
  return { items: visible, overflow: Math.max(0, items.length - visible.length) };
}
