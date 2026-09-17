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

export function isManagedGroupSelected(selection: SidebarManageSelection, group: TaskDirectoryGroup): boolean {
  const ids = collectManagedIds([group]);
  return ids.taskIds.length + ids.sessionIds.length > 0
    && ids.taskIds.every((id) => selection.taskIds.includes(id))
    && ids.sessionIds.every((id) => selection.sessionIds.includes(id));
}

export function toggleManagedGroup(
  selection: SidebarManageSelection,
  group: TaskDirectoryGroup,
): SidebarManageSelection {
  const ids = collectManagedIds([group]);
  const remove = isManagedGroupSelected(selection, group);
  const update = (current: readonly string[], members: readonly string[]): string[] => (
    remove ? current.filter((id) => !members.includes(id)) : [...new Set([...current, ...members])]
  );
  return {
    taskIds: update(selection.taskIds, ids.taskIds),
    sessionIds: update(selection.sessionIds, ids.sessionIds),
  };
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

/**
 * 任务在批量操作里是归档（终端继续跑、worktree 保留），只有被显式选中的终端才是真删除。
 * 所以这里不再把任务名下的终端并入删除集合，两者互不覆盖。
 */
export function describeManagedAction(selection: SidebarManageSelection): string {
  const tasks = selection.taskIds.length > 0;
  const sessions = selection.sessionIds.length > 0;
  if (tasks && sessions) return "归档任务并删除终端";
  if (tasks) return "归档任务";
  return "删除终端";
}

export function describeManagedResult(selection: SidebarManageSelection): string {
  const parts: string[] = [];
  if (selection.taskIds.length > 0) parts.push(`归档 ${selection.taskIds.length} 个任务`);
  if (selection.sessionIds.length > 0) parts.push(`删除 ${selection.sessionIds.length} 个终端`);
  return parts.join("、") || "处理所选项目";
}

/** 只有真的会杀终端时才用危险样式；纯归档不该渲染成红色破坏性操作。 */
export function managedSelectionIsDestructive(selection: SidebarManageSelection): boolean {
  return selection.sessionIds.length > 0;
}
