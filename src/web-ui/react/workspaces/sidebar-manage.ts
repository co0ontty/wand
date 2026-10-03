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
 * 任务和会话在批量操作里是同一套逻辑：主操作都是归档（软处理——终端继续跑、worktree 保留、
 * 7 天后由保留期清理），只有显式选中的终端才走真删除。所以两个按钮分开描述，
 * 不再用一句「归档任务并删除终端」把两种动作揉在一起。
 */
export function describeManagedAction(selection: SidebarManageSelection): string {
  const tasks = selection.taskIds.length > 0;
  const sessions = selection.sessionIds.length > 0;
  if (tasks && sessions) return "归档任务并归档终端";
  if (tasks) return "归档任务";
  return "归档终端";
}

export function describeManagedResult(selection: SidebarManageSelection): string {
  const parts: string[] = [];
  if (selection.taskIds.length > 0) parts.push(`归档 ${selection.taskIds.length} 个任务`);
  if (selection.sessionIds.length > 0) parts.push(`归档 ${selection.sessionIds.length} 个终端`);
  return parts.join("、") || "处理所选项目";
}

/** 危险按钮：只在选中了真的会被关闭的终端时才出现。 */
export function describeManagedDelete(selection: SidebarManageSelection): string {
  const sessions = selection.sessionIds.length;
  return sessions > 0 ? `删除 ${sessions} 个终端` : "删除终端";
}

/** 只有真的会杀终端时才用危险样式；纯归档不该渲染成红色破坏操作。 */
export function managedSelectionIsDestructive(selection: SidebarManageSelection): boolean {
  return selection.sessionIds.length > 0;
}
