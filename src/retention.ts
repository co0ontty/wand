import { isArchiveBlocked } from "./archive-policy.js";
import { cleanupWorktreeSync } from "./git-worktree.js";
import { createRetentionProtection } from "./retention-protection.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import { defaultTaskRetention, taskRetentionWindows, type TaskRetentionSettings } from "./task-retention.js";
import type { SessionSnapshot } from "./types.js";
import { parseTimestampMs as timestamp } from "./time-utils.js";

/** Backward-compatible exports for consumers of the historical default windows. */
const DEFAULT_RETENTION_WINDOWS = taskRetentionWindows(defaultTaskRetention());
export const RETENTION_IDLE_MS = DEFAULT_RETENTION_WINDOWS.idleMs!;
export const RETENTION_ARCHIVED_MS = DEFAULT_RETENTION_WINDOWS.archivedMs!;

/**
 * 看板任务、会话和已结束的团队运行共用 `taskRetention` 的开关与天数。
 * 只有已验收、无未完成上下文且无执行/审批/排队事实的任务才能自动归档；
 * 关联会话与团队历史跟随保护。升级前的任务归档不自动删除。
 * 结构化会话看运行状态；PTY 只有正在回复或等待确认才跳过，空闲壳不算在处理。
 */

export interface RetentionDeps {
  storage: WandStorage;
  sessions: SessionRegistry;
  /** 每次扫描读取。传入函数才能在设置保存后立刻用新窗口，而不是启动时的快照。 */
  taskRetention?: TaskRetentionSettings | (() => TaskRetentionSettings | undefined);
}

export interface RetentionResult {
  archivedSessions: number;
  purgedSessions: number;
  archivedTasks: number;
  purgedTasks: number;
  purgedTeamRuns: number;
}

/**
 * 保留期里的「还在处理」：结构化会话看运行状态；PTY 的 `running` 只表示壳进程还在，
 * 空闲 zsh 不算。真正挡住清理的是正在回复、或停在权限/确认上。
 */
export function isRetentionBusy(session: SessionSnapshot): boolean {
  return isArchiveBlocked(session);
}

function isIdleLivePty(session: SessionSnapshot): boolean {
  return session.status === "running" && !isRetentionBusy(session)
    && ((session.sessionKind ?? "pty") === "pty" || session.runner === "pty");
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
  const result: RetentionResult = {
    archivedSessions: 0, purgedSessions: 0, archivedTasks: 0, purgedTasks: 0, purgedTeamRuns: 0,
  };
  const taskWindows = taskRetentionWindows(
    typeof deps.taskRetention === "function" ? deps.taskRetention() : deps.taskRetention,
  );
  const snapshots = deps.sessions.listSlim();
  // Eligibility is fixed from the pre-mutation snapshot, so a task archived in this pass cannot be purged in it.
  const protection = createRetentionProtection(deps.storage, snapshots, taskWindows.archivedMs, now);
  const purgedSessionIds = new Set<string>();
  const archivedSessionIds = new Set<string>();

  for (const session of snapshots) {
    // 真正还在处理的会话不能归档或杀掉。空闲 PTY 壳不算。
    if (isArchiveBlocked(session)) continue;
    if (session.archived) {
      if (!protection.canPurgeSession(session.id) || taskWindows.archivedMs === null) continue;
      const archivedAt = timestamp(session.archivedAt);
      if (archivedAt === null) {
        // 历史归档行没有时间戳：先补上，让删除窗口从这一刻起算，而不是立刻删除。
        try { deps.sessions.setArchived(session.id, true); } catch { /* already gone */ }
        continue;
      }
      if (now - archivedAt < taskWindows.archivedMs) continue;
      purgeRetentionSession(deps, session, purgedSessionIds, result);
      continue;
    }
    if (taskWindows.idleMs === null || !protection.canArchiveSession(session.id)) continue;
    const reference = timestamp(session.endedAt ?? session.startedAt);
    if (reference === null || now - reference < taskWindows.idleMs) continue;
    archiveRetentionSession(deps, session, archivedSessionIds, result);
  }

  const sessionsByTask = new Map<string, SessionSnapshot[]>();
  for (const session of snapshots) {
    const taskId = session.workspaceTaskId;
    if (!taskId) continue;
    const bucket = sessionsByTask.get(taskId);
    if (bucket) bucket.push(session);
    else sessionsByTask.set(taskId, [session]);
  }

  for (const task of protection.tasks) {
    const bound = task.workspaceTaskId ? sessionsByTask.get(task.workspaceTaskId) ?? [] : [];
    if (task.status === "archived") {
      const archivedAt = timestamp(task.archivedAt);
      if (archivedAt === null) {
        // 只补时间戳；状态未变，不会把升级前归档标记为可自动删除。
        deps.storage.updateWandTask(task.id, { status: "archived" });
        continue;
      }
      if (!protection.canPurgeTask(task.id)) continue;
      const container = task.workspaceTaskId ? deps.storage.getWorkspaceTask(task.workspaceTaskId) : null;
      if (container?.worktree) {
        try { cleanupWorktreeSync(container.worktree); } catch { /* never block cleanup */ }
      }
      deps.storage.deleteWandTask(task.id);
      result.purgedTasks += 1;
      continue;
    }
    if (taskWindows.idleMs === null || !protection.canArchiveTask(task)) continue;
    const lastActivity = taskLastActivity(deps.storage, task, bound);
    if (lastActivity === null || now - lastActivity < taskWindows.idleMs) continue;
    deps.storage.updateWandTask(task.id, { status: "archived" });
    result.archivedTasks += 1;
  }

  sweepTeamRuns(deps, protection, taskWindows, snapshots, purgedSessionIds, archivedSessionIds, now, result);
  return result;
}

function archiveRetentionSession(
  deps: RetentionDeps,
  session: SessionSnapshot,
  archivedSessionIds: Set<string>,
  result: RetentionResult,
): void {
  if (session.archived || archivedSessionIds.has(session.id)) return;
  if (isIdleLivePty(session)) {
    try { deps.sessions.stop(session.id); } catch { /* shell may already be gone */ }
  }
  try {
    deps.sessions.setArchived(session.id, true);
    session.archived = true;
    archivedSessionIds.add(session.id);
    result.archivedSessions += 1;
  } catch { /* best-effort */ }
}

function purgeRetentionSession(
  deps: RetentionDeps,
  session: SessionSnapshot,
  purgedSessionIds: Set<string>,
  result: RetentionResult,
): void {
  if (purgedSessionIds.has(session.id)) return;
  if (isIdleLivePty(session)) {
    try { deps.sessions.stop(session.id); } catch { /* already gone */ }
  }
  try {
    deps.sessions.delete(session.id);
    purgedSessionIds.add(session.id);
    result.purgedSessions += 1;
  } catch { /* best-effort: a session may disappear between the read and the purge */ }
}

function sweepTeamRuns(
  deps: RetentionDeps,
  protection: ReturnType<typeof createRetentionProtection>,
  windows: { idleMs: number | null; archivedMs: number | null },
  snapshots: readonly SessionSnapshot[],
  purgedSessionIds: Set<string>,
  archivedSessionIds: Set<string>,
  now: number,
  result: RetentionResult,
): void {
  const sessionById = new Map(snapshots.map((session) => [session.id, session]));
  for (const run of protection.runs) {
    if (!protection.canPurgeRun(run.id) && !protection.canArchiveRun(run.id)) continue;
    const linked = protection.teamSessionIds.get(run.id) ?? [];
    const activity = teamRunActivity(run.updatedAt, linked, sessionById);
    if (activity === null) continue;
    if (protection.canPurgeRun(run.id) && windows.archivedMs !== null && now - activity >= windows.archivedMs) {
      for (const id of linked) {
        const session = sessionById.get(id);
        if (!session || !protection.canPurgeSession(id)) continue;
        purgeRetentionSession(deps, session, purgedSessionIds, result);
        sessionById.delete(id);
      }
      deps.storage.deleteAiTeamRun(run.id);
      result.purgedTeamRuns += 1;
      continue;
    }
    if (!protection.canArchiveRun(run.id) || windows.idleMs === null || now - activity < windows.idleMs) continue;
    for (const id of linked) {
      const session = sessionById.get(id);
      if (!session || !protection.canArchiveSession(id)) continue;
      archiveRetentionSession(deps, session, archivedSessionIds, result);
    }
  }
}

function teamRunActivity(
  updatedAt: string,
  sessionIds: readonly string[],
  sessionById: ReadonlyMap<string, SessionSnapshot>,
): number | null {
  const times: number[] = [];
  const updated = timestamp(updatedAt);
  if (updated !== null) times.push(updated);
  for (const id of sessionIds) {
    const session = sessionById.get(id);
    const reference = timestamp(session?.endedAt ?? session?.startedAt);
    if (reference !== null) times.push(reference);
  }
  return times.length > 0 ? Math.max(...times) : null;
}

function logRetentionSweep(result: RetentionResult): void {
  const acted = result.archivedSessions + result.purgedSessions + result.archivedTasks + result.purgedTasks + result.purgedTeamRuns;
  if (acted > 0) {
    console.log(
      `[retention] archived sessions=${result.archivedSessions} tasks=${result.archivedTasks}; `
      + `purged sessions=${result.purgedSessions} tasks=${result.purgedTasks} teamRuns=${result.purgedTeamRuns}`,
    );
  }
}

/**
 * 可重复调用的扫描。同一时刻只跑一轮；进行中又被请求时，本轮结束后再跑一轮，
 * 这样保存设置时不会和定时扫描互相覆盖。
 */
export function createRetentionSweep(deps: RetentionDeps): () => RetentionResult {
  const empty: RetentionResult = {
    archivedSessions: 0, purgedSessions: 0, archivedTasks: 0, purgedTasks: 0, purgedTeamRuns: 0,
  };
  let running = false;
  let again = false;
  let last = empty;
  return () => {
    if (running) {
      again = true;
      return last;
    }
    running = true;
    try {
      do {
        again = false;
        last = runRetentionSweep(deps);
        logRetentionSweep(last);
      } while (again);
      return last;
    } catch (error) {
      console.error(`[retention] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      running = false;
    }
  };
}

/** 每小时的保留期扫描；返回清理定时器，调用方负责 clearInterval。 */
export function startRetentionTimer(
  deps: RetentionDeps,
  intervalMs = 60 * 60 * 1000,
  sweep = createRetentionSweep(deps),
): NodeJS.Timeout {
  const run = (): void => {
    try { sweep(); } catch { /* createRetentionSweep 已记录 */ }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
