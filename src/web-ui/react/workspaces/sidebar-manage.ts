import type { TaskDirectoryGroup } from "./types";

export interface SidebarManageSelection {
  readonly taskIds: readonly string[];
  readonly sessionIds: readonly string[];
}

export const EMPTY_SIDEBAR_MANAGE_SELECTION: SidebarManageSelection = Object.freeze({
  taskIds: [],
  sessionIds: [],
});

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
