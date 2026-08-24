/** 只有多个目录时才显示展开控件；单个目录始终展开，避免空箭头占位。 */
export function showsDirectoryDisclosure(directoryCount: number): boolean {
  return directoryCount > 1;
}

/** 任务下没有终端时不显示箭头；空状态直接展示，无需先展开。 */
export function showsTaskSessionDisclosure(sessionCount: number): boolean {
  return sessionCount > 0;
}

/** 目录默认展开。单个目录不可收起。 */
export function isDirectoryExpanded(userCollapsed: boolean, directoryCount: number): boolean {
  return !showsDirectoryDisclosure(directoryCount) || !userCollapsed;
}

/** 终端默认展开。无终端时始终展示空提示。 */
export function isTaskSessionsExpanded(userCollapsed: boolean, sessionCount: number): boolean {
  return !showsTaskSessionDisclosure(sessionCount) || !userCollapsed;
}
