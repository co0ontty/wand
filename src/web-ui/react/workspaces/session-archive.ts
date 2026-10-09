import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "./types";

/**
 * 归档会话的展示归属：正常列表只看活跃会话，归档的收进每一层自己的
 * `archivedSessions`（任务内一份、目录的未分组会话一份），由侧栏就地展开、恢复或清理。
 *
 * 过滤只做一次（数据加载后），下游的搜索、显示模式、批量选择看到的都是活跃会话；
 * 归档区是独立入口，不会再被「只看活动」之类的筛选误杀。
 */
export function splitArchivedSessions<T extends { archived?: boolean }>(
  sessions: readonly T[],
): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const session of sessions) {
    if (session.archived) archived.push(session);
    else active.push(session);
  }
  return { active, archived };
}

/** Main sessions win over a stale archive entry during archive/restore refreshes. */
function normalizeSessions(sessions: readonly WorkspaceSessionSummary[], existing: readonly WorkspaceSessionSummary[] = []): { active: WorkspaceSessionSummary[]; archived: WorkspaceSessionSummary[] } {
  const unique = new Map<string, WorkspaceSessionSummary>();
  for (const session of sessions) if (!unique.has(session.id)) unique.set(session.id, session);
  const { active, archived } = splitArchivedSessions([...unique.values()]);
  for (const session of existing) {
    if (unique.has(session.id)) continue;
    unique.set(session.id, session);
    archived.push(session);
  }
  return { active, archived };
}

function splitTaskSessions(task: TaskSummary): TaskSummary {
  const { active, archived } = normalizeSessions(task.sessions, task.archivedSessions);
  return { ...task, sessions: active, archivedSessions: archived };
}

/** 把每个目录组的任务与未分组会话拆成「活跃 / 归档」两摞，归档的不进正常列表。 */
export function groupSessionsByArchive(
  groups: readonly TaskDirectoryGroup[],
): TaskDirectoryGroup[] {
  return groups.map((group) => {
    const standalone = normalizeSessions(group.standaloneSessions, group.archivedSessions);
    const next: TaskDirectoryGroup = {
      ...group,
      tasks: group.tasks.map(splitTaskSessions),
      standaloneSessions: standalone.active,
      archivedSessions: standalone.archived,
    };
    return next;
  });
}

/** 归档区的成员总数：任务里的 + 目录未分组的。用于决定是否渲染整块。 */
export function archivedSessionCount(group: TaskDirectoryGroup): number {
  const inTasks = group.tasks.reduce((total, task) => total + (task.archivedSessions?.length ?? 0), 0);
  return inTasks + (group.archivedSessions?.length ?? 0);
}
