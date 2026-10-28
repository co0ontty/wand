import { AgentDispatchPreflightError, dispatchAgentForTask } from "./agent-dispatch.js";
import { agentKey } from "./ai-team-types.js";
import { DEFAULT_MAX_CONCURRENT_TASKS } from "./employee-types.js";
import { employeeInputPriority, type EmployeeInputScheduling } from "./employee-input-scheduling.js";
import type { ProcessManager } from "./process-manager.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import { taskCommentPrompt } from "./task-comment-dispatch.js";
import { statusAfterWandTaskDispatch, type WandTask, type WandTaskAgent, type WandTaskComment } from "./task-types.js";
import type { SessionSnapshot, WandConfig } from "./types.js";

type QueuedExecution = { taskId: string; priority: number; createdAt: string; sequence?: number } & (
  { kind: "comment"; commentId: string } | { kind: "session"; sessionId: string; index: number }
);

export interface EmployeeTaskCommentSubmission {
  taskId: string;
  employeeId: string;
  employeeName: string;
  requestId: string;
  signature: string;
  body: string;
  instruction: string;
  sourceCommentId: string | null;
  taskVersion: string;
  referencedTaskIds: readonly string[];
  /** 提交时选中的执行快照；排队后仍按它启动，避免员工候选变化改变已接受的本轮意图。 */
  agent: WandTaskAgent;
}

export interface TaskExecutionQueueDeps {
  storage: WandStorage;
  config: WandConfig;
  structured: StructuredSessionManager | null;
  processes: ProcessManager | null;
  sessions?: SessionRegistry;
}

/**
 * 员工任务的并发闸门。
 *
 * 按员工串行决策：同一员工在跑的任务数达到上限时，新派发落成持久化的 queued 行，
 * 不创建会话；任务状态仍提升为 doing（活动任务）。手动消息最高，其余按任务实时优先级补位，同级 FIFO。
 * 同一任务的多条派发不额外占槽，避免同一任务互相排队等待自己。
 */
export class TaskExecutionQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly reservations = new Map<string, Map<string, number>>();
  private readonly dispatchingSessions = new Set<string>();
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly deps: TaskExecutionQueueDeps) {}

  async submit(input: EmployeeTaskCommentSubmission): Promise<WandTaskComment> {
    if (this.disposed) throw new Error("员工执行队列已关闭。");
    const employee = this.deps.storage.getSiliconEmployee(input.employeeId);
    if (!employee || employee.archivedAt) throw new Error("硅基员工不存在或已归档。");
    return this.exclusive(employee.id, async () => {
      const task = this.deps.storage.getWandTask(input.taskId);
      if (!task) throw new Error("未找到该任务。");
      const latest = this.deps.storage.getSiliconEmployee(input.employeeId);
      if (!latest || latest.archivedAt) throw new Error("硅基员工不存在或已归档。");
      const closed = task.status === "done" || task.status === "archived";
      // 先持久化再统一选队首，不能先排空低优先级旧项再比较新派发。
      const queued = !closed;
      const comment = this.deps.storage.createTaskCommentIntent({
        taskId: input.taskId, requestId: input.requestId, signature: input.signature, body: input.body,
        instruction: input.instruction, sourceCommentId: input.sourceCommentId, employeeId: input.employeeId,
        employeeName: input.employeeName, taskVersion: input.taskVersion, referencedTaskIds: input.referencedTaskIds,
        agent: input.agent, queued,
      });
      this.promoteTask(task);
      if (!queued) await this.dispatchComment(comment.id, input.employeeId);
      else await this.drainLocked(employee.id);
      return this.deps.storage.getWandTaskComment(comment.id)!;
    });
  }

  /** 结构化回合结束等空闲信号后调用；多次信号会合并成一次排空。 */
  scheduleDrain(employeeId: string): void {
    if (this.disposed || !employeeId || this.scheduled.has(employeeId)) return;
    const timer = setTimeout(() => {
      this.scheduled.delete(employeeId);
      void this.drain(employeeId).catch(error => console.error("[TaskQueue] drain failed:", error));
    }, 60);
    timer.unref?.();
    this.scheduled.set(employeeId, timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
  }

  async drain(employeeId: string): Promise<void> {
    await this.exclusive(employeeId, () => this.drainLocked(employeeId));
  }

  /** 服务启动恢复：只排空持久化的 queued 行；pending 仍按未知送达处理，不重放。 */
  async drainAll(): Promise<void> {
    const employees = new Set(this.deps.storage.listQueuedTaskCommentEmployees());
    for (const session of this.deps.structured?.listSlim?.() ?? []) {
      if (session.employeeId && session.queuedMessages?.length) employees.add(session.employeeId);
    }
    await Promise.all([...employees].map(employeeId =>
      this.drain(employeeId).catch(error => console.error(`[TaskQueue] drain ${employeeId} failed:`, error))));
  }

  private async drainLocked(employeeId: string): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      const employee = this.deps.storage.getSiliconEmployee(employeeId);
      if (!employee || employee.archivedAt) {
        this.deps.storage.cancelQueuedTaskCommentsForEmployee(employeeId, "员工已归档或删除，排队执行已取消。");
        return;
      }
      const next = this.queuedExecutions(employeeId).find(item => this.hasCapacity(employee, item.taskId));
      if (!next) return;
      if (next.kind === "session") {
        this.reserve(employeeId, next.taskId);
        this.dispatchingSessions.add(next.sessionId);
        // 不等整轮完成，否则会阻塞该员工其他槽位的入队/补位。
        void this.deps.structured!.flushEmployeeQueuedInput(next.sessionId, next.index).catch(error => {
          console.error("[TaskQueue] queued input failed:", error);
        }).finally(() => {
          this.dispatchingSessions.delete(next.sessionId);
          this.release(employeeId, next.taskId);
          // 显式未接受的输入可能已被 flush 放回队列：留待后续信号，不做自动重试循环。
          if (this.disposed) return;
          const pending = this.deps.structured!.get(next.sessionId)?.queuedInputScheduling ?? [];
          if (!pending.some(item => item.enqueuedAt === next.createdAt)) this.scheduleDrain(employeeId);
        });
        continue;
      }
      const task = this.deps.storage.getWandTask(next.taskId);
      if (!task) {
        this.deps.storage.cancelQueuedTaskComment(next.commentId, "任务不存在，排队执行已取消。");
        continue;
      }
      if (task.status === "done" || task.status === "archived") {
        this.deps.storage.cancelQueuedTaskComment(next.commentId, "任务已关闭，排队执行已取消。");
        continue;
      }
      if (!this.hasCapacity(employee, task.id)) return;
      if (!this.deps.storage.claimQueuedTaskComment(next.commentId)) continue;
      await this.dispatchComment(next.commentId, employeeId);
      // 排空后继续填充剩余槽位；无剩余排队时下一轮查询会直接返回。
    }
  }

  private async dispatchComment(commentId: string, employeeId: string): Promise<void> {
    const comment = this.deps.storage.getWandTaskComment(commentId);
    const task = comment ? this.deps.storage.getWandTask(comment.taskId) : null;
    const employee = this.deps.storage.getSiliconEmployee(employeeId);
    if (!comment?.dispatch || !task) {
      if (comment) this.deps.storage.updateTaskCommentDispatch(comment.id, "failed", null, "任务或派发记录不存在。");
      return;
    }
    if (task.status === "done" || task.status === "archived") {
      this.deps.storage.updateTaskCommentDispatch(comment.id, "failed", null, "任务已关闭，排队执行已取消。");
      return;
    }
    if (!employee || employee.archivedAt) {
      this.deps.storage.updateTaskCommentDispatch(comment.id, "failed", null, "员工已归档或删除，排队执行已取消。");
      return;
    }
    let agent: WandTaskAgent;
    try {
      agent = this.deps.storage.getTaskCommentDispatchAgent(comment.id) ?? selectEmployeeCandidate(employee).agent;
    } catch (error) {
      this.deps.storage.updateTaskCommentDispatch(comment.id, "failed", null, error instanceof Error ? error.message : "员工没有可用的执行候选。");
      return;
    }
    const candidateIndex = employee.agents.findIndex(candidate => agentKey(candidate) === agentKey(agent));
    const executionEmployee = candidateIndex >= 0 ? employee : { ...employee, agents: [agent] };
    const referencedTasks = (comment.referencedTaskIds ?? []).flatMap(id => {
      const referenced = this.deps.storage.getWandTask(id);
      return referenced ? [{ id: referenced.id, identifier: referenced.identifier }] : [];
    });
    let sessionId: string | null = null;
    this.reserve(employee.id, task.id);
    try {
      await dispatchAgentForTask(
        { storage: this.deps.storage, config: this.deps.config, structured: this.deps.structured, processes: this.deps.processes },
        {
          task, agent, employee: executionEmployee,
          employeeCandidateIndex: Math.max(0, candidateIndex),
          automationId: `wand-task-comment:${comment.id}`,
          prompt: taskCommentPrompt({ taskId: task.id, commentId: comment.id, sourceCommentId: comment.sourceCommentId ?? null,
            taskVersion: comment.taskVersion ?? task.updatedAt, instruction: comment.instruction ?? comment.body, referencedTasks }),
          sessionCreated: session => {
            sessionId = session.id;
            // 已从队列认领、正在启动的派发不再被后来入队项抢占。
            this.dispatchingSessions.add(session.id);
            this.deps.storage.updateTaskCommentDispatch(comment.id, "pending", session.id);
          },
        },
      );
      this.deps.storage.updateTaskCommentDispatch(comment.id, "accepted", sessionId);
    } catch (error) {
      const rejected = error instanceof AgentDispatchPreflightError && !sessionId;
      this.deps.storage.updateTaskCommentDispatch(comment.id, rejected ? "failed" : "unknown", sessionId,
        rejected ? error.message : "执行送达未确认，请核对关联会话；不会自动重放。");
    } finally {
      if (sessionId) this.dispatchingSessions.delete(sessionId);
      this.release(employee.id, task.id);
    }
  }

  /** 与任务派发共享同一闸门，来源来自服务端手动发送入口。 */
  canStartSession(session: SessionSnapshot, scheduling: EmployeeInputScheduling, immediate = false): boolean {
    if (this.disposed) return false;
    if (!session.employeeId) return true;
    const employee = this.deps.storage.getSiliconEmployee(session.employeeId);
    if (!employee || employee.archivedAt) throw new Error("硅基员工不存在或已归档。");
    // 「立即发送」是显式用户动作：不再等待并发槽位或排在其它派发之后。
    if (immediate) return true;
    const taskId = this.sessionTaskId(session);
    if (!this.hasCapacity(employee, taskId)) return false;
    if (this.dispatchingSessions.has(session.id)) return true;
    const priority = this.priority(taskId, scheduling.source);
    const waiting = this.queuedExecutions(employee.id).find(item => this.hasCapacity(employee, item.taskId));
    return !waiting || waiting.priority < priority
      || (waiting.priority === priority && waiting.createdAt > scheduling.enqueuedAt);
  }

  private sessionTaskId(session: SessionSnapshot): string {
    return (session.workspaceTaskId
      ? this.deps.storage.getWandTaskByWorkspaceTaskId(session.workspaceTaskId)?.id ?? session.workspaceTaskId
      : this.deps.storage.getWandTaskIdForSession(session.id)) ?? `session:${session.id}`;
  }

  private priority(taskId: string, source: EmployeeInputScheduling["source"]): number {
    return employeeInputPriority(source, this.deps.storage.getWandTask(taskId)?.priority);
  }

  private queuedExecutions(employeeId: string): QueuedExecution[] {
    const employee = this.deps.storage.getSiliconEmployee(employeeId);
    if (!employee) return [];
    const running = this.runningTaskIds(employeeId);
    for (const taskId of this.reservations.get(employeeId)?.keys() ?? []) running.add(taskId);
    const full = running.size >= (employee.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS);
    // 满槽时仍允许已占槽任务的后续消息，不能被其他任务的队首挡死。
    const comments = this.deps.storage.listQueuedTaskCommentDispatches(employeeId, 1, full ? [...running] : undefined);
    const result: QueuedExecution[] = comments.map(item => ({ ...item, kind: "comment",
      priority: this.priority(item.taskId, "task") }));
    for (const { session, index, scheduling } of this.deps.structured?.employeeQueuedInputs?.(employeeId) ?? []) {
      if (this.dispatchingSessions.has(session.id)) continue;
      const taskId = this.sessionTaskId(session);
      result.push({ kind: "session", sessionId: session.id, index, taskId,
        createdAt: scheduling.enqueuedAt, sequence: scheduling.sequence, priority: this.priority(taskId, scheduling.source) });
    }
    // Array.sort 稳定；同一会话同一时刻的项继续遵循显式队列顺序。
    return result.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0));
  }

  private promoteTask(task: WandTask): void {
    if (task.status !== "backlog" && task.status !== "todo") return;
    this.deps.storage.updateWandTask(task.id, { status: statusAfterWandTaskDispatch(task.status) });
  }

  private hasCapacity(employee: NonNullable<ReturnType<WandStorage["getSiliconEmployee"]>>, taskId: string): boolean {
    const limit = employee.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    const running = this.runningTaskIds(employee.id);
    for (const reserved of this.reservations.get(employee.id)?.keys() ?? []) running.add(reserved);
    return running.has(taskId) || running.size < limit;
  }

  /** 在飞的结构化回合才算占用并发；同一任务的多条派发共用同一个槽位。 */
  private runningTaskIds(employeeId: string): Set<string> {
    const sessions = this.deps.structured?.employeeActiveSessions?.(employeeId)
      ?? this.deps.sessions?.listSlim() ?? this.deps.storage.loadSessionsSlim();
    const ids = new Set<string>();
    for (const session of sessions) {
      if (session.employeeId !== employeeId) continue;
      if (!this.deps.structured?.employeeActiveSessions && !session.structuredState?.inFlight) continue;
      ids.add(this.sessionTaskId(session));
    }
    return ids;
  }

  private reserve(employeeId: string, taskId: string): void {
    const bucket = this.reservations.get(employeeId) ?? new Map<string, number>();
    bucket.set(taskId, (bucket.get(taskId) ?? 0) + 1);
    this.reservations.set(employeeId, bucket);
  }

  private release(employeeId: string, taskId: string): void {
    const bucket = this.reservations.get(employeeId);
    if (!bucket) return;
    const count = (bucket.get(taskId) ?? 1) - 1;
    if (count > 0) bucket.set(taskId, count);
    else bucket.delete(taskId);
    if (!bucket.size) this.reservations.delete(employeeId);
  }

  private exclusive<T>(employeeId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(employeeId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chains.set(employeeId, next.catch(() => undefined));
    return next;
  }
}
