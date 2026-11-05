import { taskDispatchFence } from "./task-execution-fence.js";
import { createHash } from "node:crypto";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "./ai-team-types.js";
import { isArchiveBlocked } from "./archive-policy.js";
import { HttpError } from "./http-error.js";
import { parseTaskAgent } from "./task-agent-parsing.js";
import { submitTaskComment } from "./task-comment-dispatch.js";
import type { TaskRouteDependencies } from "./server-task-routes.js";
import { taskWorkflowStage, type WandTask, type WandTaskAgent } from "./task-types.js";

const SETTINGS_KEY = "pref:taskAutoFlow";
const SCAN_KEY = "pref:taskAutoFlowScan";
const HISTORY_KEY = "pref:taskAutoFlowHistory";
const STAGES = ["review", "doing", "todo"] as const;
const PERIODIC_STAGE_LIMIT = 3;
type Stage = typeof STAGES[number];
type StageChoice = { employeeId: string; agent: WandTaskAgent | null };
export type TaskAutoFlowSettings = { enabled: boolean; intervalMinutes: number; revision: number; stages: Record<Stage, StageChoice> };
export type TaskAutoFlowScan = { at: string; stage: Stage | null; taskId: string | null; result: string;
  requestedCount?: number; dispatchedTaskIds?: string[]; dispatches?: Array<{ taskId: string; commentId: string }> };
export type TaskAutoFlowLog = TaskAutoFlowScan & { dispatches: Array<{ taskId: string; taskIdentifier: string; commentId: string; state: string; sessionId: string | null }> };

function requestPrefix(task: WandTask, stage: Stage, epoch: string): string {
  return `flow-v2-${createHash("sha256").update(`${task.id}:${stage}:${task.deliveryRevision ?? 0}:${epoch}`).digest("hex").slice(0, 32)}-`;
}

/** Bounded durable dispatches per scan. Existing task intents are the idempotency journal. */
export class TaskAutoFlow {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<TaskAutoFlowScan> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private observedRevision = "";
  private retryAt = Infinity;
  constructor(private readonly deps: TaskRouteDependencies) {}

  private defaults(): TaskAutoFlowSettings {
    const employees = this.deps.storage.listSiliconEmployees();
    const choice = (name: string): StageChoice => {
      const employee = employees.find(item => item.name === name);
      return { employeeId: employee?.id ?? "", agent: employee?.agents[0] ?? null };
    };
    return { enabled: true, intervalMinutes: 30, revision: 0,
      stages: { review: choice("瑞辰"), doing: choice("华杰"), todo: choice("华杰") } };
  }

  settings(): TaskAutoFlowSettings {
    return this.deps.storage.getPreference<TaskAutoFlowSettings>(SETTINGS_KEY, this.defaults());
  }

  lastScan(): TaskAutoFlowScan | null {
    return this.deps.storage.getPreference<TaskAutoFlowScan | null>(SCAN_KEY, null);
  }

  history(): TaskAutoFlowLog[] {
    const scans = this.deps.storage.getPreference<TaskAutoFlowScan[]>(HISTORY_KEY, []);
    return scans.map(scan => ({ ...scan, dispatches: (scan.dispatches ?? []).map(item => {
      const comment = this.deps.storage.getWandTaskComment(item.commentId);
      return { ...item, taskIdentifier: this.deps.storage.getWandTask(item.taskId)?.identifier ?? item.taskId,
        state: comment?.dispatch?.state ?? "unknown", sessionId: comment?.dispatch?.sessionId ?? null };
    }) }));
  }

  private recordScan(scan: TaskAutoFlowScan, manual: boolean): void {
    this.deps.storage.transaction(() => {
      this.deps.storage.setPreference(SCAN_KEY, scan);
      if (!manual) return;
      const history = this.deps.storage.getPreference<TaskAutoFlowScan[]>(HISTORY_KEY, []);
      const existing = history.findIndex(item => item.at === scan.at);
      if (existing >= 0) history[existing] = scan;
      else history.unshift(scan);
      this.deps.storage.setPreference(HISTORY_KEY, history.slice(0, 10));
    });
  }

  save(raw: unknown): TaskAutoFlowSettings {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("巡检设置无效。");
    const value = raw as Record<string, unknown>;
    if (typeof value.enabled !== "boolean" || !Number.isInteger(value.intervalMinutes)
      || Number(value.intervalMinutes) < 5 || Number(value.intervalMinutes) > 1440
      || !Number.isInteger(value.revision)) throw new Error("巡检开关、周期或设置版本无效。");
    const stages = value.stages;
    if (!stages || typeof stages !== "object" || Array.isArray(stages)) throw new Error("阶段配置无效。");
    const stageValues = stages as Record<string, unknown>;
    const parsed = {} as Record<Stage, StageChoice>;
    for (const stage of STAGES) {
      const rawChoice = stageValues[stage];
      if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) throw new Error(`${stage} 阶段配置无效。`);
      const choice = rawChoice as Record<string, unknown>;
      if (typeof choice.employeeId !== "string" || !choice.employeeId) throw new Error(`${stage} 阶段需要员工。`);
      const employee = this.deps.storage.getSiliconEmployee(choice.employeeId);
      if (!employee || employee.archivedAt) throw new Error(`${stage} 阶段员工已不可用。`);
      const agent = parseTaskAgent(choice.agent);
      if (!agent || agent.kind !== "structured") throw new Error(`${stage} 阶段需要有效的结构化 CLI、模型与思考配置。`);
      parsed[stage] = { employeeId: employee.id, agent };
    }
    return this.deps.storage.transaction(() => {
      const current = this.settings();
      if (current.revision !== value.revision) throw new HttpError(409, "conflict", "巡检设置已变化，请刷新后重试。");
      const next = { enabled: value.enabled as boolean, intervalMinutes: Number(value.intervalMinutes), revision: current.revision + 1, stages: parsed };
      this.deps.storage.setPreference(SETTINGS_KEY, next);
      return next;
    });
  }

  private busy(task: WandTask, seen = new Set<string>(), requireDeliveredChildren = true): boolean {
    if (seen.has(task.id)) return true;
    seen.add(task.id);
    const storage = this.deps.storage;
    if (storage.taskHasUnsettledDispatch(task.id) || storage.countQueuedTaskCommentDispatchesForTask(task.id)) return true;
    if (storage.listWandTaskSessionIds(task.id).some(id => {
      const session = this.deps.sessions?.getSlim(id) ?? storage.getSessionSlim(id);
      return !session || isArchiveBlocked(session);
    })) return true;
    if ([task.id, task.workspaceTaskId].some(id => id && storage.listAiTeamRuns({ taskId: id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES, limit: 1 }).length)) return true;
    return storage.listWandTaskChildren(task.id).some(child => child.status !== "archived" &&
      (this.busy(child, seen, requireDeliveredChildren) || requireDeliveredChildren && taskWorkflowStage(child.status) !== "ready"));
  }

  private attempt(task: WandTask, stage: Stage): { requestId: string; count: number } | null {
    const prefix = requestPrefix(task, stage, taskDispatchFence(this.deps.storage, task.id).epoch);
    const { count, latest } = this.deps.storage.taskAutoFlowAttempts(task.id, prefix);
    if (latest) {
      const dispatch = latest.dispatch;
      // Cancellation and unknown delivery never become retryable merely with elapsed time.
      if (dispatch?.status === "stopped" || dispatch?.resultAnchor?.outcome === "stopped") return null;
      const terminal = dispatch?.resultAnchor?.endIndex != null && ["done", "failed"].includes(dispatch.resultAnchor.outcome ?? "");
      if (dispatch?.state !== "failed" && !terminal) return null;
      const failed = dispatch?.state === "failed" || dispatch?.resultAnchor?.outcome === "failed";
      const delay = failed ? Math.min(30 * 60_000, 60_000 * 2 ** Math.min(count - 1, 5)) : 10_000;
      const retryAt = Date.parse(latest.createdAt) + delay;
      if (Date.now() < retryAt) { this.retryAt = Math.min(this.retryAt, retryAt); return null; }
    }
    return { requestId: `${prefix}${count}`, count };
  }

  private choice(task: WandTask, stage: Stage, settings: TaskAutoFlowSettings): StageChoice | null {
    if (stage === "review") return settings.stages.review;
    const previous = this.deps.storage.taskLastDispatch(task.id);
    if (previous?.dispatch?.employeeId) return { employeeId: previous.dispatch.employeeId,
      agent: this.deps.storage.getTaskCommentDispatchAgent(previous.id) };
    const subject = task.executionSubject;
    if (subject?.type === "employee") return { employeeId: subject.id,
      agent: subject.agentOverride ?? task.agent ?? this.deps.storage.getSiliconEmployee(subject.id)?.agents[0] ?? null };
    // Explicit direct-tool/team assignments are not permission to switch to another employee.
    if (subject || task.agent) return null;
    return settings.stages[stage];
  }

  /** Coalesced event wakeup. Durable receipts and CAS remain the dispatch authority. */
  wake(): void {
    if (!this.running || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (this.pending) { void this.pending.finally(() => this.wake()).catch(() => {}); return; }
      void this.tick(false, undefined, 1, true).catch(error => console.error("[TaskAutoFlow] wake failed:", error));
    }, 100);
    this.wakeTimer.unref?.();
  }

  async tick(force = false, onlyStage?: Stage, limit = 1, eventDriven = false): Promise<TaskAutoFlowScan> {
    if (this.pending) return this.pending;
    const run = async (): Promise<TaskAutoFlowScan> => {
      const settings = this.settings(), last = this.lastScan();
      const at = new Date(Math.max(Date.now(), last ? Date.parse(last.at) + 1 : 0)).toISOString();
      if (!settings.enabled && !force) return { at, stage: null, taskId: null, result: "已暂停" };
      const revision = this.deps.storage.projectionRevision();
      if (!force && !eventDriven && last && revision === this.observedRevision
        && Date.now() < this.retryAt && Date.now() - Date.parse(last.at) < settings.intervalMinutes * 60_000) return last;
      this.retryAt = Infinity;
      const tasks = this.deps.storage.listWandTasks();
      const periodic = !force && !onlyStage;
      const stages: readonly Stage[] = onlyStage ? [onlyStage] : ["review", "doing"];
      const requestedCount = periodic ? stages.length * PERIODIC_STAGE_LIMIT : limit;
      // Persist the scan boundary before any external effect. A crash can delay a scan, never duplicate one.
      this.recordScan({ at, stage: onlyStage ?? null, taskId: null, result: "扫描中", requestedCount, dispatches: [] }, force);
      const dispatchedTaskIds: string[] = [];
      const dispatches: Array<{ taskId: string; commentId: string }> = [];
      const claimedFamilies = new Set<string>();
      let skipped: TaskAutoFlowScan | null = null;
      for (const stage of stages) {
        let stageDispatchedCount = 0;
        const candidates = stage === "doing" ? [...tasks].sort((left, right) => {
          const failed = (task: WandTask): number => Number(task.verification?.verdict === "failed"
            && task.verification.revision === (task.deliveryRevision ?? 0));
          return failed(right) - failed(left);
        }) : tasks;
        for (const candidate of candidates) {
          const task = this.deps.storage.getWandTask(candidate.id);
          if (!task || taskWorkflowStage(task.status) !== stage || task.archivedAt) continue;
          const fence = taskDispatchFence(this.deps.storage, task.id);
          if (fence.blocked || fence.requestedAt >= at) continue;
          const skip = (result: string): void => { skipped ??= { at, stage, taskId: task.id, result }; };
          let family = task;
          const ancestors = new Set<string>();
          let parentPaused = false;
          while (family.parentTaskId && !ancestors.has(family.parentTaskId)) {
            ancestors.add(family.parentTaskId);
            const parent = this.deps.storage.getWandTask(family.parentTaskId);
            if (!parent) { parentPaused = true; break; }
            if (!["doing", "review"].includes(taskWorkflowStage(parent.status))) parentPaused = true;
            family = parent;
          }
          if (parentPaused || claimedFamilies.has(family.id)) continue;
          if (family.id !== task.id && this.busy(family, new Set(), false)) { skip("同一需求仍有活动执行，等待安全接续。"); continue; }
          const choice = this.choice(task, stage, settings);
          const employee = choice ? this.deps.storage.getSiliconEmployee(choice.employeeId) : null;
          if (!employee || employee.archivedAt || !choice?.agent) { skip("阶段员工或执行配置不可用，请在巡检设置中修正。"); continue; }
          const lastDispatch = this.deps.storage.taskLastDispatch(task.id, stage === "review" ? "review" : "execution");
          if (lastDispatch && (lastDispatch.dispatch?.status === "stopped" || lastDispatch.dispatch?.resultAnchor?.outcome === "stopped")
            && lastDispatch.createdAt >= fence.requestedAt) { skip("执行已被取消，等待明确重新开始，不自动重放。"); continue; }
          const reviewFailed = stage === "doing" && task.verification?.verdict === "failed"
            && task.verification.revision === (task.deliveryRevision ?? 0);
          if (task.acceptance?.blockerKind === "external" && task.acceptance.blocker.trim()) {
            skip(`等待解除外部阻塞：${task.acceptance.blocker.trim().slice(0, 160)}`); continue;
          }
          if (this.busy(task)) { skip("任务仍有运行、排队、活动子任务或未知送达，等待核对。"); continue; }
          if (stage === "review" && this.deps.storage.taskDeliverySubmitter(task.id, task.deliveryRevision ?? 0)?.employeeId === employee.id) {
            skip("当前交付由同一员工提交，需要独立验收员工。"); continue;
          }
          const attempt = this.attempt(task, stage);
          if (attempt === null) { skip("本阶段仍在等待确定回执、取消保护或重试退避。"); continue; }
          const prompt = stage === "review"
            ? `独立验收 ${task.identifier} 当前交付版本 ${task.deliveryRevision ?? 0}。核对最新有效需求与逐项自测证据，在实际交付环境复核全部完成标准；功能不通过用 task:workflow fail 一次写清全部已发现缺口，通过用 pass，系统会自动完成归档。缺权限、环境或需求冲突等无法自行解除的明确阻塞用 block，不能把环境受阻冒充实现缺陷。`
            : `${reviewFailed ? "独立验收未通过，原负责人继续返工" : stage === "todo" ? "认领并完整实现" : "继续完整实现"} ${task.identifier}。先核对最新需求、父任务、完整评论及已有工作；新的用户决定优先，旧验收标准若已被明确替代不得恢复。你的责任是把全部目标完成并逐项自测通过；自测失败就定位、修复、复测，不得只报告失败或把缺口交给验收者。全部通过后携带 selfTest 清单用 task:workflow submit 提交独立验收。普通进展用 progress，不结束任务；只有当前授权和条件下无法自行解决的明确阻塞才用 block，写明已尝试办法及需要的最小条件。${attempt.count > 0 ? "这是未完成任务的接续：保留此前成果，核对上一轮结果，不重放未知操作；同一方法反复失败时调整诊断和方案，不降低标准或重复空转。" : ""}`;
          const result = await submitTaskComment(this.deps, task.id, {
            requestId: attempt.requestId, body: prompt, employeeId: employee.id,
            purpose: stage === "review" ? "review" : "execution",
          }, choice.agent, task.id, task.updatedAt);
          const state = result.comment.dispatch?.state ?? "已记录";
          dispatches.push({ taskId: task.id, commentId: result.comment.id });
          if (state === "accepted" || state === "queued") {
            dispatchedTaskIds.push(task.id);
            stageDispatchedCount += 1;
            claimedFamilies.add(family.id);
          }
          const scan: TaskAutoFlowScan = { at, stage, taskId: task.id, result: state,
            requestedCount, dispatchedTaskIds: [...dispatchedTaskIds], dispatches: [...dispatches] };
          this.recordScan(scan, force);
          if (!periodic && (state !== "accepted" && state !== "queued" || dispatchedTaskIds.length >= limit)) return scan;
          if (periodic && stageDispatchedCount >= PERIODIC_STAGE_LIMIT) break;
        }
      }
      const scan: TaskAutoFlowScan = dispatchedTaskIds.length
        ? { at, stage: onlyStage ?? null, taskId: dispatchedTaskIds.at(-1)!, result: "已完成本次巡检", requestedCount, dispatchedTaskIds, dispatches }
        : { ...(skipped ?? { at, stage: onlyStage ?? null, taskId: null, result: "无可派发任务" }), requestedCount, dispatchedTaskIds, dispatches };
      this.recordScan(scan, force);
      return scan;
    };
    this.pending = run().finally(() => { this.observedRevision = this.deps.storage.projectionRevision(); this.pending = null; });
    return this.pending;
  }

  /** One explicit scan while paused. CAS prevents an uncertain POST from scanning another task on retry. */
  runOnce(expectedLastScanAt: string | null, stage?: Stage, count = 1): Promise<TaskAutoFlowScan> {
    if (this.pending || (this.lastScan()?.at ?? null) !== expectedLastScanAt) {
      throw new HttpError(409, "conflict", "巡检状态已变化，请刷新结果后再决定是否重新运行。");
    }
    return this.tick(true, stage, count);
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    if (!this.deps.storage.hasPreference(SETTINGS_KEY)) this.deps.storage.transaction(() => {
      if (!this.deps.storage.hasPreference(SETTINGS_KEY)) this.deps.storage.setPreference(SETTINGS_KEY, this.defaults());
    });
    void this.tick().catch(error => console.error("[TaskAutoFlow] scan failed:", error));
    this.timer = setInterval(() => {
      // A dispatch can remain unresolved; keep one in-flight scan and one
      // rejection handler instead of attaching another handler every minute.
      if (this.pending) return;
      void this.tick().catch(error => console.error("[TaskAutoFlow] scan failed:", error));
    }, 10_000);
    this.timer.unref?.();
  }

  dispose(): void {
    this.running = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
