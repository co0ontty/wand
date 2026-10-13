import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { reconcileScheduledRun,scheduledExecutionStatus } from "./scheduled-task-state.js";

import { requireTeamEmployee } from "./ai-team-employee-binding.js";
import type { ConversationService } from "./conversation-service.js";
import { employeeConversationId } from "./conversation-types.js";
import { getErrorMessage } from "./error-utils.js";
import { nextScheduledTime,parseTaskSchedule } from "./scheduled-task-time.js";
import type {
  ScheduledTask,ScheduledTaskDetail,ScheduledTaskRun,ScheduledTaskRunView,
  ScheduledTaskSummary
} from "./scheduled-task-types.js";
import { bodyObject } from "./server-request.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import type { WandStorage } from "./storage.js";
import { provisionalTaskTitleFromDescription } from "./task-title.js";
import type { ProcessEvent,SessionSnapshot } from "./types.js";
import { isGlobalWorkspace } from "./workspace-binding.js";

export class ScheduledTaskConflictError extends Error {}
export class ScheduledTaskNotFoundError extends Error {}

function requiredText(value: unknown, label: string, max: number, preserve = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label}不能为空且不能超过 ${max} 个字符。`);
  }
  return preserve ? value : value.trim();
}

function titleOf(value: unknown, prompt: string): string {
  if (value !== undefined && typeof value !== "string") throw new Error("任务名称必须是文字。");
  const title = (value as string | undefined)?.trim() || provisionalTaskTitleFromDescription(prompt) || "定时任务";
  if (title.length > 200) throw new Error("任务名称不能超过 200 个字符。");
  return title;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function workspaceIdOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, "执行项目", 160);
}

/** Scheduling owns durable occurrences; employee execution and retries remain in the normal conversation protocol. */
export class ScheduledTaskService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingTick: Promise<void> | null = null;
  private disposed = false;
  private readonly liveAcceptedRuns = new Set<string>();

  constructor(private readonly deps: {
    storage: WandStorage;
    conversations: Pick<ConversationService, "send" | "receipt">;
    getSession(id: string): SessionSnapshot | null;
    defaultCwd?: () => string | undefined;
    now?: () => Date;
  }) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  private requireEmployee(id: string): void {
    selectEmployeeCandidate(requireTeamEmployee(this.deps.storage, id));
  }

  private requireWorkspaceCwd(id: string): string {
    const workspace = this.deps.storage.getWorkspace(id);
    if (!workspace || isGlobalWorkspace(workspace)) throw new Error("执行项目不存在或不可用，请重新选择项目。");
    const cwd = workspace.cwd?.trim();
    if (!cwd || !isAbsolute(cwd)) throw new Error("执行项目需要有效的绝对工作目录，请先设置项目目录。");
    return resolveSessionCwd(cwd, undefined);
  }

  private executionDirectory(task: ScheduledTask): { cwd: string | null; error: string | null } {
    const workspace = task.workspaceId ? this.deps.storage.getWorkspace(task.workspaceId) : null;
    const raw = task.workspaceId ? workspace?.cwd?.trim() : this.deps.defaultCwd?.()?.trim();
    const cwd = raw && isAbsolute(raw) ? raw : null;
    try {
      return { cwd: task.workspaceId ? this.requireWorkspaceCwd(task.workspaceId)
        : raw ? resolveSessionCwd(raw, undefined) : null, error: null };
    } catch (error) { return { cwd, error: getErrorMessage(error) }; }
  }

  private requireTask(id: string): ScheduledTask {
    const task = this.deps.storage.getScheduledTask(id);
    if (!task) throw new ScheduledTaskNotFoundError("定时任务不存在。");
    return task;
  }

  private runView(run: ScheduledTaskRun): ScheduledTaskRunView {
    const receipt = run.executionFinishedAt ? run.receipt : this.deps.conversations.receipt(run.requestId) ?? run.receipt;
    const sessionId = receipt?.sessionId ?? null;
    const session = sessionId ? this.deps.getSession(sessionId) : null;
    const executionStatus = scheduledExecutionStatus(run, receipt, session);
    return { ...run, receipt, executionStatus, sessionId };
  }

  private summary(task: ScheduledTask): ScheduledTaskSummary {
    const employee = this.deps.storage.getSiliconEmployee(task.employeeId);
    let employeeUnavailableReason: string | null = null;
    try { this.requireEmployee(task.employeeId); }
    catch (error) { employeeUnavailableReason = getErrorMessage(error); }
    const workspace = task.workspaceId ? this.deps.storage.getWorkspace(task.workspaceId) : null;
    const directory = this.executionDirectory(task);
    const lastRun = this.deps.storage.listScheduledTaskRuns(task.id, 1)[0];
    return { ...task, employeeName: employee?.name ?? "员工已不可用", employeeUnavailableReason,
      workspaceName: task.workspaceId ? workspace?.name ?? "项目已不可用" : "服务默认目录",
      workspaceCwd: directory.cwd, workspaceUnavailableReason: directory.error,
      lastRun: lastRun ? this.runView(lastRun) : null };
  }

  list(includeCancelled = false): ScheduledTaskSummary[] {
    return this.deps.storage.listScheduledTasks(includeCancelled).map(task => this.summary(task));
  }

  get(id: string): ScheduledTaskDetail {
    return { task: this.summary(this.requireTask(id)), runs: this.deps.storage.listScheduledTaskRuns(id).map(run => this.runView(run)) };
  }

  create(value: unknown): ScheduledTaskSummary {
    const input = bodyObject(value);
    if (typeof input.requestId !== "string" || !/^[\w:-]{8,80}$/.test(input.requestId)) throw new Error("需要有效的 requestId。");
    const employeeId = requiredText(input.employeeId, "执行员工", 160);
    const prompt = requiredText(input.prompt, "执行提示词", 256_000, true);
    const workspaceId = workspaceIdOf(input.workspaceId);
    const schedule = parseTaskSchedule(input.schedule);
    const title = titleOf(input.title, prompt);
    const id = `sched_${digest(input.requestId).slice(0, 32)}`;
    const creationFingerprint = digest(JSON.stringify({ employeeId, prompt, schedule, title,
      ...(workspaceId ? { workspaceId } : {}) }));
    const previous = this.deps.storage.getScheduledTask(id);
    if (previous) {
      if (previous.creationFingerprint !== creationFingerprint) throw new ScheduledTaskConflictError("requestId 已用于另一项定时任务，请核对记录。");
      return this.summary(previous);
    }
    this.requireEmployee(employeeId);
    if (workspaceId) this.requireWorkspaceCwd(workspaceId);
    const now = this.now();
    const nextRunAt = nextScheduledTime(schedule, now);
    if (!nextRunAt) throw new Error("单次执行时间必须晚于当前时间。");
    const task: ScheduledTask = { id, creationFingerprint, title, employeeId, workspaceId, prompt, schedule, enabled: true,
      nextRunAt, revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), cancelledAt: null };
    if (!this.deps.storage.createScheduledTask(task)) {
      const current = this.requireTask(id);
      if (current.creationFingerprint !== creationFingerprint) throw new ScheduledTaskConflictError("requestId 已用于另一项定时任务，请核对记录。");
      return this.summary(current);
    }
    return this.summary(task);
  }

  update(id: string, value: unknown): ScheduledTaskSummary {
    const input = bodyObject(value);
    const current = this.requireTask(id);
    if (!Number.isInteger(input.revision) || Number(input.revision) !== current.revision) {
      throw new ScheduledTaskConflictError("定时任务已更新，请刷新后重试。");
    }
    if (current.cancelledAt) throw new ScheduledTaskConflictError("定时任务已取消，历史记录仍保留。");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("启用状态必须是布尔值。");
    if (input.cancelled !== undefined && input.cancelled !== true) throw new Error("取消任务必须传 cancelled=true。");
    if (!["title", "employeeId", "workspaceId", "prompt", "schedule", "enabled", "cancelled"].some(key => input[key] !== undefined)) {
      throw new Error("请提供需要更新的定时任务设置。");
    }
    const now = this.now();
    const prompt = input.prompt === undefined ? current.prompt : requiredText(input.prompt, "执行提示词", 256_000, true);
    const employeeId = input.employeeId === undefined ? current.employeeId : requiredText(input.employeeId, "执行员工", 160);
    const workspaceId = input.workspaceId === undefined ? current.workspaceId ?? null : workspaceIdOf(input.workspaceId);
    const schedule = input.schedule === undefined ? current.schedule : parseTaskSchedule(input.schedule);
    const enabled = input.cancelled === true ? false : input.enabled === undefined ? current.enabled : input.enabled;
    let nextRunAt = current.nextRunAt;
    if (input.cancelled === true) nextRunAt = null;
    else if (input.schedule !== undefined || (enabled && !current.enabled)) {
      nextRunAt = nextScheduledTime(schedule, now);
      if (!nextRunAt) throw new Error("单次执行时间已过去，请设置新的执行时间。");
    }
    if (input.employeeId !== undefined || (enabled && !current.enabled)) this.requireEmployee(employeeId);
    if (workspaceId && input.cancelled !== true && input.enabled !== false) this.requireWorkspaceCwd(workspaceId);
    const updated: ScheduledTask = { ...current, title: input.title === undefined ? current.title : titleOf(input.title, prompt),
      prompt, employeeId, workspaceId, schedule, enabled, nextRunAt, revision: current.revision + 1,
      updatedAt: now.toISOString(), cancelledAt: input.cancelled === true ? now.toISOString() : null };
    if (!this.deps.storage.updateScheduledTask(updated, current.revision)) throw new ScheduledTaskConflictError("定时任务已更新，请刷新后重试。");
    return this.summary(updated);
  }

  private reconcile(run: ScheduledTaskRun, now: string, recoverInactive = true): ScheduledTaskRun {
    if (run.executionFinishedAt) { this.liveAcceptedRuns.delete(run.id); return run; }
    const receipt = this.deps.conversations.receipt(run.requestId) ?? run.receipt;
    const session = receipt?.sessionId ? this.deps.getSession(receipt.sessionId) : null;
    const updated = reconcileScheduledRun(run, receipt, session, now, {
      recoverInactive, liveAccepted: this.liveAcceptedRuns.has(run.id),
    });
    if (updated.executionFinishedAt) this.liveAcceptedRuns.delete(run.id);
    if (updated.state !== run.state || updated.error !== run.error || updated.executionOutcome !== run.executionOutcome
      || updated.executionFinishedAt !== run.executionFinishedAt || JSON.stringify(updated.receipt) !== JSON.stringify(run.receipt)) {
      this.deps.storage.saveScheduledTaskRun(updated);
    }
    return updated;
  }

  /** Capture the original turn's terminal fact before a user can start another turn in the same session. */
  ingestSessionEvent(event: ProcessEvent): void {
    if (this.disposed || (event.type !== "status" && event.type !== "ended")) return;
    const runs = this.deps.storage.getOpenScheduledTaskRunsForSession(event.sessionId);
    if (!runs.length) return;
    const now = this.now().toISOString();
    for (const run of runs) this.reconcile(run, now, false);
  }

  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pendingTick) return this.pendingTick;
    const pending = this.runTick();
    this.pendingTick = pending;
    void pending.finally(() => { if (this.pendingTick === pending) this.pendingTick = null; }).catch(() => {});
    return pending;
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    const nowIso = now.toISOString();
    const openRuns = this.deps.storage.listOpenScheduledTaskRuns().map(run => this.reconcile(run, nowIso));
    for (const task of this.deps.storage.listDueScheduledTasks(nowIso)) {
      if (this.disposed) return;
      if (!task.enabled || task.cancelledAt || !task.nextRunAt || Date.parse(task.nextRunAt) > now.getTime()) continue;
      const overlap = openRuns.some(run => {
        if (run.taskId !== task.id) return false;
        const current = this.deps.storage.getScheduledTaskRun(run.id) ?? run;
        if (current.executionFinishedAt) return false;
        const view = this.runView(current);
        return view.executionStatus === "running" || (view.executionStatus === "pending" && Boolean(view.sessionId));
      });
      const id = `schedrun_${digest(`${task.id}:${task.nextRunAt}`).slice(0, 32)}`;
      const directory = this.executionDirectory(task);
      let run: ScheduledTaskRun = { id, taskId: task.id, requestId: `scheduled:${id}`, scheduledAt: task.nextRunAt,
        claimedAt: nowIso, employeeId: task.employeeId, workspaceId: task.workspaceId ?? null, cwd: directory.cwd, prompt: task.prompt,
        state: overlap ? "skipped" : directory.error ? "rejected" : "claimed", receipt: null,
        error: overlap ? "上次执行尚未结束，本次已跳过。" : directory.error,
        executionFinishedAt: overlap || directory.error ? nowIso : null,
        ...(directory.error && !overlap ? { executionOutcome: "failed" as const } : {}) };
      // One atomic claim advances from now, including after downtime: never fan out missed recurring occurrences.
      if (!this.deps.storage.claimScheduledTaskRun(task, run, nextScheduledTime(task.schedule, now))) continue;
      if (overlap || directory.error) continue;
      try {
        const receipt = await this.deps.conversations.send(employeeConversationId(run.employeeId), run.requestId, run.prompt, null,
          run.cwd ?? undefined, true, { workspaceId: run.workspaceId ?? undefined, title: task.title, scheduled: true });
        run = { ...run, receipt, state: receipt.state === "accepted" ? "accepted" : receipt.state === "rejected" ? "rejected" : "unknown",
          cwd: run.cwd ?? (receipt.sessionId ? this.deps.getSession(receipt.sessionId)?.cwd ?? null : null),
          error: receipt.error ?? (receipt.state === "pending" ? "本次执行的接收状态无法确认；不会自动重发。" : null),
          executionFinishedAt: receipt.state === "rejected" ? nowIso : null,
          ...(receipt.state === "rejected" ? { executionOutcome: "failed" as const } : {}) };
        if (receipt.state === "accepted") this.liveAcceptedRuns.add(run.id);
      } catch (error) {
        const receipt = this.deps.conversations.receipt(run.requestId);
        run = { ...run, receipt, state: receipt?.state === "accepted" ? "accepted" : receipt?.state === "rejected" ? "rejected" : "unknown",
          error: getErrorMessage(error), executionFinishedAt: receipt?.state === "rejected" || !receipt?.sessionId ? nowIso : null,
          ...(receipt?.state === "rejected" || !receipt?.sessionId
            ? { executionOutcome: receipt?.state === "rejected" ? "failed" as const : "unknown" as const } : {}) };
        if (receipt?.state === "accepted") this.liveAcceptedRuns.add(run.id);
      }
      this.deps.storage.saveScheduledTaskRun(run);
      openRuns.push(this.reconcile(run, nowIso));
    }
  }

  start(intervalMs = 15_000): void {
    if (this.disposed || this.timer) return;
    const scan = (): void => { void this.tick().catch(error => console.error("[ScheduledTasks] 扫描失败:", getErrorMessage(error))); };
    scan();
    this.timer = setInterval(scan, intervalMs);
    this.timer.unref?.();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Cleanup waits for the scan to settle; a scan failure must not prevent the server from closing its resources.
    await this.pendingTick?.catch(() => {});
  }
}
