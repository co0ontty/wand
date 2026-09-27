

/** 任务下没有终端时不显示箭头。 */
export function showsTaskSessionDisclosure(sessionCount: number): boolean {
  return sessionCount > 0;
}

/** 目录默认展开；用户收起后保持收起。 */
export function isDirectoryExpanded(userCollapsed: boolean, _directoryCount?: number): boolean {
  return !userCollapsed;
}

/** 终端默认展开。无终端的任务默认折叠、不显示空提示；只有当它是唯一任务时才展开引导创建首个会话。 */
export function isTaskSessionsExpanded(
  userCollapsed: boolean,
  sessionCount: number,
  isOnlyTask = false,
): boolean {
  if (!showsTaskSessionDisclosure(sessionCount)) return isOnlyTask;
  return !userCollapsed;
}
