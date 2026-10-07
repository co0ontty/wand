import { cleanupWorktreeSync } from "./git-worktree.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import { taskRetentionWindows, type TaskRetentionSettings } from "./task-retention.js";
import type { SessionSnapshot } from "./types.js";

/**
 * 看板任务、会话和已结束的团队运行共用 `taskRetention`。
 * 没配过时默认空闲 7 天归档，再过 7 天清理。
 * 结构化会话看运行状态；PTY 只有正在回复或等待确认才跳过，空闲壳不算在处理。
 */
export const RETENTION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_ARCHIVED_MS = 7 * 24 * 60 * 60 * 1000;

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
  if (session.ptyBusy === true || session.structuredState?.inFlight === true) return true;
  if (session.permissionBlocked || session.pendingEscalation) return true;
  if ((session.sessionKind ?? "pty") === "pty" || session.runner === "pty") return false;
  return session.status === "running";
}

function isIdleLivePty(session: SessionSnapshot): boolean {
  return session.status === "running" && !isRetentionBusy(session)
    && ((session.sessionKind ?? "pty") === "pty" || session.runner === "pty");
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
  const result: RetentionResult = {
    archivedSessions: 0, purgedSessions: 0, archivedTasks: 0, purgedTasks: 0, purgedTeamRuns: 0,
  };
  const taskWindows = taskRetentionWindows(
    typeof deps.taskRetention === "function" ? deps.taskRetention() : deps.taskRetention,
  );
  const snapshots = deps.sessions.listSlim();

  for (const session of snapshots) {
    // 真正还在处理的会话不能归档或杀掉。空闲 PTY 壳不算。
    if (isRetentionBusy(session)) continue;
    if (session.archived) {
      if (taskWindows.archivedMs === null) continue;
      const archivedAt = timestamp(session.archivedAt);
      if (archivedAt === null) {
        // 历史归档行没有时间戳：先补上，让删除窗口从这一刻起算，而不是立刻删除。
        try { deps.sessions.setArchived(session.id, true); } catch { /* already gone */ }
        continue;
      }
      if (now - archivedAt < taskWindows.archivedMs) continue;
      try {
        deps.sessions.delete(session.id);
        result.purgedSessions += 1;
      } catch { /* best-effort: a session may disappear between the read and the purge */ }
      continue;
    }
    if (taskWindows.idleMs === null) continue;
    const reference = timestamp(session.endedAt ?? session.startedAt);
    if (reference === null || now - reference < taskWindows.idleMs) continue;
    if (isIdleLivePty(session)) {
      try { deps.sessions.stop(session.id); } catch { /* shell may already be gone */ }
    }
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
    const running = bound.some((session) => isRetentionBusy(session));
    if (task.status === "archived") {
      if (running || taskWindows.archivedMs === null) continue;
      const archivedAt = timestamp(task.archivedAt);
      if (archivedAt === null) {
        // 历史归档行（归档时间尚未落库）：补写时间戳，给用户留出恢复窗口。
        deps.storage.updateWandTask(task.id, { status: "archived" });
        continue;
      }
      if (now - archivedAt < taskWindows.archivedMs) continue;
      const container = task.workspaceTaskId ? deps.storage.getWorkspaceTask(task.workspaceTaskId) : null;
      if (container?.worktree) {
        try { cleanupWorktreeSync(container.worktree); } catch { /* never block cleanup */ }
      }
      deps.storage.deleteWandTask(task.id);
      result.purgedTasks += 1;
      continue;
    }
    if (running || taskWindows.idleMs === null) continue;
    const lastActivity = taskLastActivity(deps.storage, task, bound);
    if (lastActivity === null || now - lastActivity < taskWindows.idleMs) continue;
    deps.storage.updateWandTask(task.id, { status: "archived" });
    result.archivedTasks += 1;
  }

  sweepTeamRuns(deps, taskWindows, snapshots, now, result);
  return result;
}

function sweepTeamRuns(
  deps: RetentionDeps,
  windows: { idleMs: number | null; archivedMs: number | null },
  snapshots: readonly SessionSnapshot[],
  now: number,
  result: RetentionResult,
): void {
  const sessionById = new Map(snapshots.map((session) => [session.id, session]));
  for (const run of deps.storage.listAiTeamRuns()) {
    if (run.status === "running") continue;
    const linked = teamRunSessionIds(deps.storage, run.id, run.chatSessionId);
    if (linked.some((id) => {
      const session = sessionById.get(id);
      return session ? isRetentionBusy(session) : false;
    })) continue;
    const activity = teamRunActivity(run.updatedAt, linked, sessionById);
    if (activity === null) continue;
    if (windows.archivedMs !== null && now - activity >= windows.archivedMs) {
      for (const id of linked) {
        const session = sessionById.get(id);
        if (!session || isRetentionBusy(session)) continue;
        if (isIdleLivePty(session)) {
          try { deps.sessions.stop(id); } catch { /* already gone */ }
        }
        try {
          deps.sessions.delete(id);
          result.purgedSessions += 1;
          sessionById.delete(id);
        } catch { /* already gone */ }
      }
      deps.storage.deleteAiTeamRun(run.id);
      result.purgedTeamRuns += 1;
      continue;
    }
    if (windows.idleMs === null || now - activity < windows.idleMs) continue;
    for (const id of linked) {
      const session = sessionById.get(id);
      if (!session || session.archived || isRetentionBusy(session)) continue;
      if (isIdleLivePty(session)) {
        try { deps.sessions.stop(id); } catch { /* already gone */ }
      }
      try {
        deps.sessions.setArchived(id, true);
        session.archived = true;
        result.archivedSessions += 1;
      } catch { /* best-effort */ }
    }
  }
}

function teamRunSessionIds(storage: WandStorage, runId: string, chatSessionId: string | null): string[] {
  const ids = new Set<string>();
  if (chatSessionId) ids.add(chatSessionId);
  for (const step of storage.listAiTeamSteps(runId)) {
    if (step.sessionId) ids.add(step.sessionId);
  }
  return [...ids];
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
