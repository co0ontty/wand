import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "./types";

/**
 * 侧栏目录预览只渲染一个目录的切片，任务列表可能被裁剪；打开会话时按
 * `workspaceTaskId` 回到原始目录组找回它，才能恢复该任务的工作区布局。
 */
export function findSessionTask(
  group: TaskDirectoryGroup,
  session: WorkspaceSessionSummary,
  sourceGroups: readonly TaskDirectoryGroup[] = [],
): TaskSummary | undefined {
  const local = group.tasks.find((task) => task.id === session.workspaceTaskId)
    ?? group.tasks.find((task) => task.sessions.some((entry) => entry.id === session.id));
  if (local) return local;
  const source = sourceGroups.find((candidate) => candidate.workspaceId === group.workspaceId);
  if (!source) return undefined;
  return source.tasks.find((task) => task.id === session.workspaceTaskId)
    ?? source.tasks.find((task) => task.sessions.some((entry) => entry.id === session.id));
}
