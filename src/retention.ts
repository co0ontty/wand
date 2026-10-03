import { cleanupWorktreeSync } from "./git-worktree.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import type { SessionSnapshot } from "./types.js";

/**
 * 统一保留期策略（会话与看板任务同一套）：
 *   1. 超过 IDLE 没有活动的会话 / 任务 → 自动归档；
 *   2. 归档后经过 ARCHIVED 仍没被恢复 → 自动清理（删除）。
 *
 * 会话的自动归档此前散在两个 runner 里（24h），这里收敛成同一份常量，避免
 * 「会话 24h、任务 7 天」两套口径。运行中的会话/任务永不归档或清理。
 */
export const RETENTION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_ARCHIVED_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  storage: WandStorage;
  sessions: SessionRegistry;
}

export interface RetentionResult {
  archivedSessions: number;
  purgedSessions: number;
  archivedTasks: number;
  purgedTasks: number;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 任务的「最后一次活动」：卡片自身的 updated_at、容器最后一次被打开的时间，
 * 以及它名下会话的结束/开始时间，取三者里最新的一个。
 */
function taskLastActivity(
  storage: WandStorage,
  task: ReturnType<WandStorage["getWandTask"]>,
  bound: readonly SessionSnapshot[],
): number | null {
  const times: number[] = [];
  const updated = timestamp(task?.updatedAt);
  if (updated !== null) times.push(updated);
  const container = task?.workspaceTaskId ? storage.getWorkspaceTask(task.workspaceTaskId) : null;
  const opened = timestamp(container?.lastOpenedAt);
  if (opened !== null) times.push(opened);
  for (const session of bound) {
    const reference = timestamp(session.endedAt ?? session.startedAt);
    if (reference !== null) times.push(reference);
  }
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * 跑一遍保留期清理。返回本轮的实际动作计数，便于日志与测试断言。
 * 纯函数式编排：只依赖 storage / registry，方便在单测里注入固定时间。
 */
export function runRetentionSweep(deps: RetentionDeps, now = Date.now()): RetentionResult {
  const result: RetentionResult = { archivedSessions: 0, purgedSessions: 0, archivedTasks: 0, purgedTasks: 0 };
  const snapshots = deps.sessions.listSlim();

  for (const session of snapshots) {
    // 运行中的会话既不属于「没动」，也不能被杀掉。
    if (session.status === "running") continue;
    if (session.archived) {
      const archivedAt = timestamp(session.archivedAt);
      if (archivedAt === null) {
        // 历史归档行没有时间戳：先补上，让 7 天窗口从这一刻起算，而不是立刻删除。
        try { deps.sessions.setArchived(session.id, true); } catch { /* already gone */ }
        continue;
      }
      if (now - archivedAt < RETENTION_ARCHIVED_MS) continue;
      try {
        deps.sessions.delete(session.id);
        result.purgedSessions += 1;
      } catch { /* best-effort: a session may disappear between the read and the purge */ }
      continue;
    }
    const reference = timestamp(session.endedAt ?? session.startedAt);
    if (reference === null || now - reference < RETENTION_IDLE_MS) continue;
    try {
      deps.sessions.setArchived(session.id, true);
      result.archivedSessions += 1;
    } catch { /* best-effort */ }
  }

  const sessionsByTask = new Map<string, SessionSnapshot[]>();
  for (const session of snapshots) {
    const taskId = session.workspaceTaskId;
    if (!taskId) continue;
    const bucket = sessionsByTask.get(taskId);
    if (bucket) bucket.push(session);
    else sessionsByTask.set(taskId, [session]);
  }

  for (const task of deps.storage.listWandTasks()) {
    const bound = task.workspaceTaskId ? sessionsByTask.get(task.workspaceTaskId) ?? [] : [];
    const running = bound.some((session) => session.status === "running");
    if (task.status === "archived") {
      if (running) continue;
      const archivedAt = timestamp(task.archivedAt);
      if (archivedAt === null) {
        // 历史归档行（归档时间尚未落库）：补写时间戳，给用户留出恢复窗口。
        deps.storage.updateWandTask(task.id, { status: "archived" });
        continue;
      }
      if (now - archivedAt < RETENTION_ARCHIVED_MS) continue;
      const container = task.workspaceTaskId ? deps.storage.getWorkspaceTask(task.workspaceTaskId) : null;
      if (container?.worktree) {
        try { cleanupWorktreeSync(container.worktree); } catch { /* never block cleanup */ }
      }
      deps.storage.deleteWandTask(task.id);
      result.purgedTasks += 1;
      continue;
    }
    if (running) continue;
    const lastActivity = taskLastActivity(deps.storage, task, bound);
    if (lastActivity === null || now - lastActivity < RETENTION_IDLE_MS) continue;
    deps.storage.updateWandTask(task.id, { status: "archived" });
    result.archivedTasks += 1;
  }

  return result;
}

/** 每小时的保留期扫描；返回清理定时器，调用方负责 clearInterval。 */
export function startRetentionTimer(
  deps: RetentionDeps,
  intervalMs = 60 * 60 * 1000,
): NodeJS.Timeout {
  const sweep = (): void => {
    try {
      const result = runRetentionSweep(deps);
      const acted = result.archivedSessions + result.purgedSessions + result.archivedTasks + result.purgedTasks;
      if (acted > 0) {
        console.log(
          `[retention] archived sessions=${result.archivedSessions} tasks=${result.archivedTasks}; `
          + `purged sessions=${result.purgedSessions} tasks=${result.purgedTasks}`,
        );
      }
    } catch (error) {
      console.error(`[retention] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return timer;
}
