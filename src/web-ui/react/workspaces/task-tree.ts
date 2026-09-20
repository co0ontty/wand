

/** 任务下没有终端时不显示箭头；空状态直接展示，无需先展开。 */
export function showsTaskSessionDisclosure(sessionCount: number): boolean {
  return sessionCount > 0;
}

/** 目录默认展开；用户收起后保持收起。 */
export function isDirectoryExpanded(userCollapsed: boolean, _directoryCount?: number): boolean {
  return !userCollapsed;
}

/** 终端默认展开。无终端时始终展示空提示。 */
export function isTaskSessionsExpanded(userCollapsed: boolean, sessionCount: number): boolean {
  return !showsTaskSessionDisclosure(sessionCount) || !userCollapsed;
}
