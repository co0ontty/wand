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

function requestId(task: WandTask, stage: Stage, attempt: number, epoch = ""): string {
  return `auto-flow-${createHash("sha256").update(`${task.id}:${stage}:${task.deliveryRevision ?? 0}:${attempt}${epoch ? `:${epoch}` : ""}`).digest("hex").slice(0, 32)}`;
}

/** Bounded durable dispatches per scan. Existing task intents are the idempotency journal. */
export class TaskAutoFlow {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<TaskAutoFlowScan> | null = null;
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

  private busy(task: WandTask, seen = new Set<string>()): boolean {
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
      (this.busy(child, seen) || taskWorkflowStage(child.status) !== "ready"));
  }

  private attempt(task: WandTask, stage: Stage): number | null {
    const max = stage === "doing" ? 3 : 1;
    for (let attempt = 0; attempt < max; attempt += 1) {
      const previous = this.deps.storage.findTaskCommentRequest(task.id, requestId(task, stage, attempt, taskDispatchFence(this.deps.storage, task.id).epoch));
      if (!previous) return attempt;
      if (previous.comment.dispatch?.state !== "failed" && previous.comment.dispatch?.resultAnchor?.outcome !== "done") return null;
      if (Date.now() - Date.parse(previous.comment.createdAt) < Math.min(24 * 60, 30 * 2 ** attempt) * 60_000) return null;
    }
    return null;
  }

  async tick(force = false, onlyStage?: Stage, limit = 1): Promise<TaskAutoFlowScan> {
    if (this.pending) return this.pending;
    const run = async (): Promise<TaskAutoFlowScan> => {
      const settings = this.settings(), last = this.lastScan();
      const at = new Date(Math.max(Date.now(), last ? Date.parse(last.at) + 1 : 0)).toISOString();
      if (!settings.enabled && !force) return { at, stage: null, taskId: null, result: "已暂停" };
      if (!force && last && Date.now() - Date.parse(last.at) < settings.intervalMinutes * 60_000) return last;
      const tasks = this.deps.storage.listWandTasks();
      const periodic = !force && !onlyStage;
      const requestedCount = periodic ? STAGES.length * PERIODIC_STAGE_LIMIT : limit;
      // Persist the scan boundary before any external effect. A crash can delay a scan, never duplicate one.
      this.recordScan({ at, stage: onlyStage ?? null, taskId: null, result: "扫描中", requestedCount, dispatches: [] }, force);
      const dispatchedTaskIds: string[] = [];
      const dispatches: Array<{ taskId: string; commentId: string }> = [];
      const claimedFamilies = new Set<string>();
      let skipped: TaskAutoFlowScan | null = null;
      for (const stage of onlyStage ? [onlyStage] : STAGES) {
        let stageDispatchedCount = 0;
        const choice = settings.stages[stage], employee = this.deps.storage.getSiliconEmployee(choice.employeeId);
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
          while (family.parentTaskId && !ancestors.has(family.parentTaskId)) {
            ancestors.add(family.parentTaskId);
            const parent = this.deps.storage.getWandTask(family.parentTaskId);
            if (!parent) break;
            family = parent;
          }
          if (claimedFamilies.has(family.id)) continue;
          if (!employee || employee.archivedAt || !choice.agent) { skip("阶段员工或执行配置不可用，请在巡检设置中修正。"); continue; }
          const reviewFailed = stage === "doing" && task.verification?.verdict === "failed"
            && task.verification.revision === (task.deliveryRevision ?? 0);
          if (reviewFailed && !force && this.deps.storage.countTaskReviewFailures(task.id) >= 3) {
            skip("累计三轮验收失败，暂停自动修复；请人工核对验收缺口后再手动巡检。"); continue;
          }
          if (task.acceptance?.blocker?.trim() && !reviewFailed) {
            skip(`任务阻塞待解除：${task.acceptance.blocker.trim().slice(0, 160)}`); continue;
          }
          if (this.busy(task)) { skip("任务仍有运行、排队、活动子任务或未知送达，等待核对。"); continue; }
          if (stage === "review" && this.deps.storage.taskDeliverySubmitter(task.id, task.deliveryRevision ?? 0)?.employeeId === employee.id) {
            skip("当前交付由同一员工提交，需要独立验收员工。"); continue;
          }
          const attempt = this.attempt(task, stage);
          if (attempt === null) { skip("本阶段已派发或仍在有限重试退避中。"); continue; }
          const prompt = stage === "review"
            ? `独立验收 ${task.identifier} 当前交付版本 ${task.deliveryRevision ?? 0}：按任务描述和交付证据真实复核，并用 task:workflow 回填 pass 或 fail。`
            : stage === "doing"
              ? `${reviewFailed ? `验收未通过，继续修复 ${task.identifier} 当前交付版本 ${task.deliveryRevision ?? 0}。先核对验收缺口与现有工作；能在当前授权内解决则修复、验证后用 task:workflow 重新提交。需要用户授权或外部条件时用 progress 写明阻塞，不要重复尝试。` : `继续实现 ${task.identifier} 并补齐证据。先读取任务上下文与现有交付，保留已有工作；完成后用 task:workflow 提交，未完成则回填进展与阻塞。`}`
              : `认领并实现 ${task.identifier}。先读取任务上下文与现有工作，完成后用 task:workflow 提交，未完成则回填进展与阻塞。`;
          const result = await submitTaskComment(this.deps, task.id, {
            requestId: requestId(task, stage, attempt, taskDispatchFence(this.deps.storage, task.id).epoch), body: prompt, employeeId: employee.id,
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
          if (state !== "accepted" && state !== "queued" || !periodic && dispatchedTaskIds.length >= limit) return scan;
          if (periodic && stageDispatchedCount >= PERIODIC_STAGE_LIMIT) break;
        }
      }
      const scan: TaskAutoFlowScan = dispatchedTaskIds.length
        ? { at, stage: onlyStage ?? null, taskId: dispatchedTaskIds.at(-1)!, result: "已完成本次巡检", requestedCount, dispatchedTaskIds, dispatches }
        : { ...(skipped ?? { at, stage: onlyStage ?? null, taskId: null, result: "无可派发任务" }), requestedCount, dispatchedTaskIds, dispatches };
      this.recordScan(scan, force);
      return scan;
    };
    this.pending = run().finally(() => { this.pending = null; });
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
    if (!this.deps.storage.hasPreference(SETTINGS_KEY)) this.deps.storage.transaction(() => {
      if (!this.deps.storage.hasPreference(SETTINGS_KEY)) this.deps.storage.setPreference(SETTINGS_KEY, this.defaults());
    });
    void this.tick().catch(error => console.error("[TaskAutoFlow] scan failed:", error));
    this.timer = setInterval(() => {
      // A dispatch can remain unresolved; keep one in-flight scan and one
      // rejection handler instead of attaching another handler every minute.
      if (this.pending) return;
      void this.tick().catch(error => console.error("[TaskAutoFlow] scan failed:", error));
    }, 60_000);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
