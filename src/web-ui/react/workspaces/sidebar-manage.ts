import type { TaskDirectoryGroup } from "./types.js";
import type { ConversationOrganizationResult } from "../../../conversation-organize-contract.js";

export interface SidebarManageSelection {
  readonly directoryIds?: readonly string[];
  readonly taskIds: readonly string[];
  readonly sessionIds: readonly string[];
}

export const EMPTY_SIDEBAR_MANAGE_SELECTION: SidebarManageSelection = Object.freeze({
  taskIds: [],
  sessionIds: [],
});

export function sidebarManageCount(selection: SidebarManageSelection): number {
  return (selection.directoryIds?.length ?? 0) + selection.taskIds.length + selection.sessionIds.length;
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
  const directoryIds: string[] = [];
  const taskIds: string[] = [];
  const sessionIds: string[] = [];
  for (const group of groups) {
    if (!group.global && !group.synthetic) {
      directoryIds.push(group.workspaceId);
    }
    for (const task of group.tasks) {
      taskIds.push(task.id);
      for (const session of task.sessions) sessionIds.push(session.id);
    }
    for (const session of group.standaloneSessions) sessionIds.push(session.id);
  }
  return { directoryIds, taskIds, sessionIds };
}

export function isManagedGroupSelected(selection: SidebarManageSelection, group: TaskDirectoryGroup): boolean {
  const ids = collectManagedIds([group]);
  const hasItems = ids.taskIds.length + ids.sessionIds.length > 0;
  if (!hasItems) {
    return Boolean(selection.directoryIds?.includes(group.workspaceId));
  }
  return ids.taskIds.every((id) => selection.taskIds.includes(id))
    && ids.sessionIds.every((id) => selection.sessionIds.includes(id));
}

export function toggleManagedGroup(
  selection: SidebarManageSelection,
  group: TaskDirectoryGroup,
): SidebarManageSelection {
  const ids = collectManagedIds([group]);
  const currentlySelected = isManagedGroupSelected(selection, group);
  const currentDirectoryIds = selection.directoryIds ?? [];
  const canManageDirectory = !group.global && !group.synthetic;

  const nextDirectoryIds = currentlySelected
    ? currentDirectoryIds.filter((id) => id !== group.workspaceId)
    : (canManageDirectory && !currentDirectoryIds.includes(group.workspaceId)
        ? [...currentDirectoryIds, group.workspaceId]
        : currentDirectoryIds);

  const nextTaskIds = currentlySelected
    ? selection.taskIds.filter((id) => !ids.taskIds.includes(id))
    : [...new Set([...selection.taskIds, ...ids.taskIds])];

  const nextSessionIds = currentlySelected
    ? selection.sessionIds.filter((id) => !ids.sessionIds.includes(id))
    : [...new Set([...selection.sessionIds, ...ids.sessionIds])];

  return {
    ...(nextDirectoryIds.length > 0 ? { directoryIds: nextDirectoryIds } : {}),
    taskIds: nextTaskIds,
    sessionIds: nextSessionIds,
  };
}

export function pruneManagedSelection(
  selection: SidebarManageSelection,
  groups: readonly TaskDirectoryGroup[],
): SidebarManageSelection {
  const visible = collectManagedIds(groups);
  const taskSet = new Set(visible.taskIds);
  const sessionSet = new Set(visible.sessionIds);
  const nextTaskIds = selection.taskIds.filter((id) => taskSet.has(id));
  const nextSessionIds = selection.sessionIds.filter((id) => sessionSet.has(id));
  const tempSelection: SidebarManageSelection = {
    directoryIds: selection.directoryIds,
    taskIds: nextTaskIds,
    sessionIds: nextSessionIds,
  };
  const prunedDirIds = (selection.directoryIds ?? []).filter((dirId) => {
    const group = groups.find((g) => g.workspaceId === dirId && !g.global && !g.synthetic);
    return group ? isManagedGroupSelected(tempSelection, group) : false;
  });
  return {
    ...(prunedDirIds.length > 0 ? { directoryIds: prunedDirIds } : {}),
    taskIds: nextTaskIds,
    sessionIds: nextSessionIds,
  };
}

/**
 * 任务和会话在批量操作里是同一套逻辑：主操作都是归档（软处理——终端继续跑、worktree 保留，
 * 之后由保留期清理），只有显式选中的终端才走真删除。所以两个按钮分开描述，
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

export function describeConversationOrganizationOutcome(result: ConversationOrganizationResult): { label: string; reason: string } {
  const changes: string[] = [];
  if (result.createdTasks.length) changes.push(`新建 ${result.createdTasks.length} 个任务`);
  if (result.updatedTasks.length) changes.push(`更新 ${result.updatedTasks.length} 个系统任务标题`);
  if (result.reusedTasks.length) changes.push(`复用 ${new Set(result.reusedTasks.map(task => task.taskId)).size} 个任务`);
  if (result.movedSessions.length) changes.push(`归入 ${result.movedSessions.length} 个会话`);
  const label = result.unchanged ? "会话内容和归属未变化，没有重复建任务或调用模型"
    : changes.length ? `${result.cancelled || result.error ? "部分完成：" : "已"}${changes.join("、")}`
      : result.cancelled ? "已取消后续会话归类" : result.error ? "会话归类未完成" : result.eligibleSessions ? "会话尚未得到明确工作分组，本次未作调整" : "没有符合范围且有正文的工作会话";
  const details = [`已检查 ${result.analyzedSessions}/${result.eligibleSessions} 个工作会话`,
    result.skippedManualSessions ? `跳过 ${result.skippedManualSessions} 个人工任务中的会话` : "",
    result.skippedSessions ? `排除 ${result.skippedSessions} 个归档/私聊/自动化/系统日志或无正文会话` : "",
    result.unassignedSessions.length ? `${result.unassignedSessions.length} 个会话尚未确定主题` : "",
    result.refused.length ? `${result.refused.length} 项未处理：${result.refused[0]?.reason}` : "", result.error ?? ""].filter(Boolean);
  return { label, reason: details.join("；") };
}

export function describeOrganizeOutcome(result: {
  movedSessions: readonly unknown[];
  categorizedTasks: readonly unknown[];
  refused: readonly { reason: string }[];
  eligibleTasks?: number;
  skippedTasks?: number;
}): { label: string; reason: string } {
  const moved = result.movedSessions.length;
  const categorized = result.categorizedTasks.length;
  const reason = result.refused[0]?.reason ?? "";
  const details = [
    result.eligibleTasks === undefined ? "" : `已检查 ${result.eligibleTasks} 个任务`,
    result.skippedTasks ? `已跳过 ${result.skippedTasks} 个用户自定标题的任务` : "",
  ].filter(Boolean);
  if (!moved && !categorized) {
    return { label: reason ? "未调整任何任务或会话" : (result.eligibleTasks === 0 ? "没有符合归类范围的任务" : "未发现可安全归类的项"),
      reason: [...details, reason].filter(Boolean).join("；") };
  }
  const parts: string[] = [];
  if (categorized) parts.push(`归类 ${categorized} 个任务`);
  if (moved) parts.push(`归属 ${moved} 个会话`);
  return {
    label: `已${parts.join("、")}`,
    reason: [...details, result.refused.length ? `另有 ${result.refused.length} 项未处理：${reason}` : ""].filter(Boolean).join("；"),
  };
}

export function standaloneManagedSessionIds(
  selection: SidebarManageSelection,
  groups?: readonly TaskDirectoryGroup[],
): readonly string[] {
  if (!groups || !selection.directoryIds || selection.directoryIds.length === 0) {
    return selection.sessionIds;
  }
  const dirSet = new Set(selection.directoryIds);
  return selection.sessionIds.filter((id) => !groups.some((g: TaskDirectoryGroup) =>
    dirSet.has(g.workspaceId) && (g.standaloneSessions.some((s) => s.id === id) || g.tasks.some((t) => t.sessions.some((s) => s.id === id)))
  ));
}

/** 危险按钮：只在选中了真的会被关闭的终端或被删除的目录时才出现。 */
export function describeManagedDelete(
  selection: SidebarManageSelection,
  groups?: readonly TaskDirectoryGroup[],
): string {
  const dirs = selection.directoryIds?.length ?? 0;
  const sessions = standaloneManagedSessionIds(selection, groups).length;
  if (dirs > 0 && sessions > 0) return `删除 ${dirs} 个目录与 ${sessions} 个终端`;
  if (dirs > 0) return `删除 ${dirs} 个目录`;
  if (sessions > 0) return `删除 ${sessions} 个终端`;
  return "删除终端";
}

/** 只有真的会杀终端或删目录时才用危险样式；纯归档不该渲染成红色破坏操作。 */
export function managedSelectionIsDestructive(selection: SidebarManageSelection): boolean {
  return (selection.directoryIds?.length ?? 0) > 0 || selection.sessionIds.length > 0;
}
