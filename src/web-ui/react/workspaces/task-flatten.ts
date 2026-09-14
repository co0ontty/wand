import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "./types";

/** 服务端给未命名任务使用的占位名。 */
export const UNNAMED_TASK_NAME = "未命名任务";

/** 名称缺失或等于占位名，视为「未命名任务」。 */
export function isUnnamedTaskName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return trimmed.length === 0 || trimmed === UNNAMED_TASK_NAME;
}

/**
 * 未命名任务不单独占一行：它的会话并入该目录的未分组终端。
 *
 * 目录树始终是「目录 → 任务 → 终端」三级；未命名任务只是服务端的历史
 * 兜底容器，渲染成任务行会让目录树出现一排同名空壳。与 Android
 * `flattenUnnamedTasksIntoStandalone` 保持同一结构。
 */
export function flattenUnnamedTasks(group: TaskDirectoryGroup): TaskDirectoryGroup {
  const named: TaskSummary[] = [];
  const standaloneSessions: WorkspaceSessionSummary[] = [...group.standaloneSessions];
  for (const task of group.tasks) {
    if (isUnnamedTaskName(task.name)) standaloneSessions.push(...task.sessions);
    else named.push(task);
  }
  if (named.length === group.tasks.length) return group;
  return { ...group, tasks: named, standaloneSessions };
}

export function flattenUnnamedTasksInGroups(
  groups: readonly TaskDirectoryGroup[],
): TaskDirectoryGroup[] {
  return groups.map(flattenUnnamedTasks);
}

/**
 * 折叠后未命名任务不再出现在 `group.tasks` 里，打开会话需要回到原始目录组
 * 按 `workspaceTaskId` 找回它，才能恢复该任务的工作区布局。
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

/**
 * The sidebar polls `/api/tasks` every few seconds and the route builds fresh
 * objects per response. Folding unnamed tasks must therefore compare content,
 * not identity — otherwise every poll hands React a brand-new group tree and
 * 40-session directories re-render on a timer.
 */
function flattenSignature(groups: readonly TaskDirectoryGroup[]): string {
  const parts: string[] = [];
  for (const group of groups) {
    parts.push(
      `g${group.workspaceId}:${group.workspaceName}:${group.tasks.length}:`
      + group.standaloneSessions.map((session) => session.id).join(","),
    );
    for (const task of group.tasks) {
      parts.push(`t${task.id}:${task.name}:${task.sessions.map((session) => session.id).join(",")}`);
    }
  }
  return parts.join("|");
}

/** Memoized wrapper around `flattenUnnamedTasksInGroups` keyed by content. */
export function createUnnamedTaskFlattener(): (
  groups: readonly TaskDirectoryGroup[],
) => TaskDirectoryGroup[] {
  let signature: string | null = null;
  let cached: TaskDirectoryGroup[] = [];
  return (groups) => {
    const next = flattenSignature(groups);
    if (signature === next) return cached;
    signature = next;
    cached = flattenUnnamedTasksInGroups(groups);
    return cached;
  };
}
