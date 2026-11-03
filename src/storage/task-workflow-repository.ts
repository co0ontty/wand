import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import type { SessionRegistry } from "../session-registry.js";
import { HttpError } from "../http-error.js";
import { isArchiveBlocked } from "../archive-policy.js";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "../ai-team-types.js";
import { parseTaskWorkflowInput, taskWorkflowPatch, type TaskWorkflowActor } from "../task-workflow.js";
import { type WandTask } from "../task-types.js";
import { parseTaskMaintenanceInput } from "../task-maintenance.js";
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
type Grant = { taskId: string; sessionId: string; employeeId: string | null; revision: number };

export class TaskWorkflowRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  /** Synchronous transaction arbitrates against queue claims; never stops a runtime. */
  maintainTask(taskId: string, value: unknown, registry?: SessionRegistry): WandTask {
    const input = parseTaskMaintenanceInput(value);
    const signature = hash(JSON.stringify({ maintenance: input }));
    return this.s.transaction(() => {
      const previous = this.db.prepare("SELECT signature FROM task_workflow_events WHERE task_id = ? AND request_id = ?").get(taskId, input.requestId);
      if (previous) {
        if (previous.signature !== signature) throw new HttpError(409, "conflict", "请求标识已用于其他操作，请核对原记录。");
        const current = this.s.getWandTask(taskId);
        if (!current) throw new HttpError(404, "not_found", "任务已删除。");
        return current;
      }
      const task = this.s.getWandTask(taskId);
      if (!task) throw new HttpError(404, "not_found", "未找到该任务。");
      if (task.updatedAt !== input.expectedUpdatedAt || input.action === "close" && task.status === "archived") throw new HttpError(409, "conflict", "任务已变化或已归档，请刷新核对；不会自动重发。");
      const children = this.s.listWandTaskChildren(taskId);
      if (input.action === "close" && children.some(child => child.status !== "archived")) throw new HttpError(409, "busy", "仍有未归档子任务，请逐项核对后再关闭主任务。");
      let duplicate: WandTask | null = null;
      if (input.duplicateTaskId) {
        duplicate = this.s.getWandTask(input.duplicateTaskId);
        if (!duplicate || duplicate.id === task.id || duplicate.workspaceId !== task.workspaceId) throw new HttpError(409, "conflict", "保留任务不存在、与当前任务相同或不属于同一项目。");
        // Do not close an ancestor into its own descendant.
        const seen = new Set<string>([task.id]);
        for (let ancestor: WandTask | null = duplicate; ancestor; ancestor = ancestor.parentTaskId ? this.s.getWandTask(ancestor.parentTaskId) : null) {
          if (seen.has(ancestor.id)) throw new HttpError(409, "conflict", "不能合并到自身子任务或循环层级。");
          seen.add(ancestor.id);
        }
      }
      if (input.action === "close") {
        const queuedIds = (this.db.prepare("SELECT comment_id FROM wand_task_comment_dispatches WHERE task_id = ? AND state IN ('queued', 'paused') ORDER BY comment_id").all(taskId) as Array<{ comment_id: string }>).map(row => row.comment_id);
        if (JSON.stringify(queuedIds) !== JSON.stringify(input.expectedQueuedCommentIds)) throw new HttpError(409, "conflict", "排队指令已变化，请重新核对，未取消新增派发。");
        if (this.db.prepare("SELECT 1 FROM wand_task_comment_dispatches WHERE task_id = ? AND employee_id IS NOT NULL AND (state IN ('pending', 'unknown') OR (state = 'accepted' AND session_id IS NULL)) LIMIT 1").get(taskId)) throw new HttpError(409, "busy", "派发已领取或送达未知，不能取消归档。");
        for (const member of [task, ...children]) {
          for (const id of this.s.listWandTaskSessionIds(member.id)) {
            const session = registry?.getSlim(id) ?? this.s.getSessionSlim(id);
            if (session && isArchiveBlocked(session)) throw new HttpError(409, "busy", "任务仍有运行、排队或等待处理的会话，未停止或归档。");
          }
          if ([member.id, member.workspaceTaskId].some(id => id && this.s.listAiTeamRuns({ taskId: id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES, limit: 1 }).length)) throw new HttpError(409, "busy", "任务仍有活动团队，不能取消归档。");
        }
      }
      const cancelReason = `用户取消（尚未执行）：${input.reason}`;
      const cancelled = this.db.prepare(`UPDATE wand_task_comment_dispatches SET state = 'failed', execution_status = 'stopped', error = ?
        WHERE task_id = ? AND state IN ('queued', 'paused') AND session_id IS NULL${input.action === "cancel" ? " AND comment_id = ?" : ""} RETURNING comment_id`)
        .all(cancelReason, taskId, ...(input.action === "cancel" ? [input.commentId!] : []));
      if (input.action === "cancel" && cancelled.length !== 1) throw new HttpError(409, "conflict", "该派发已领取、已取消或不属于此任务，未改变运行状态。");
      if (input.action === "close" && this.db.prepare("SELECT 1 FROM wand_task_comment_dispatches WHERE task_id = ? AND state IN ('queued', 'paused') LIMIT 1").get(taskId)) throw new HttpError(409, "busy", "队列存在已绑定会话的派发，未关闭任务。");
      const result = this.s.tasks.writeWandTask(task, { ...(input.action === "close" ? { status: "archived" as const } : {}) }, true);
      // Cancellation must preserve history, not opt it into acceptance-based auto-deletion.
      if (input.action === "close") this.db.prepare("UPDATE wand_tasks SET retention_archive_version = NULL WHERE id = ?").run(taskId);
      const id = crypto.randomUUID();
      const evidence = [input.action === "close" ? `无需执行，按${input.kind === "duplicate" ? "重复任务" : "失效任务"}归档` : "取消指定排队派发，任务仍保留",
        `原因：${input.reason}`, duplicate ? `保留任务：${duplicate.identifier} (${duplicate.id})` : "",
        `取消尚未执行的派发：${cancelled.length} 条`, "此操作不代表交付或验收通过；原指令、会话与验收记录保留。"].filter(Boolean).join("\n\n");
      this.db.prepare(`INSERT INTO task_workflow_events(id, task_id, request_id, signature, action, actor_kind, evidence, blocker, created_at, result_json)
        VALUES (?, ?, ?, ?, ?, 'user', ?, '', ?, ?)`).run(id, taskId, input.requestId, signature, `maintenance:${input.action}`, evidence, result.updatedAt, JSON.stringify(result));
      this.db.prepare("INSERT INTO wand_task_comments(id, task_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, taskId, "任务清理", evidence, result.updatedAt);
      return result;
    });
  }

  /** 系统动作（回收、清理）一律在任务评论里留一条可追溯的原因；调用方负责放进同一个事务。 */
  addSystemComment(taskId: string, author: string, body: string, createdAt = new Date().toISOString()): void {
    this.db.prepare("INSERT INTO wand_task_comments(id, task_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, author, body, createdAt);
  }

  /**
   * 回收「执行中却已无人执行」的任务；历史会话、证据和失败验收不代表仍在执行。
   * 在事务内复核自身及子任务的运行、审批、排队、未知送达和团队事实，只退回等待认领，
   * 不停止会话、不删除历史、不清除阻塞或推进交付/验收。运行时事实优先于存储快照。
   */
  reclaimIdleDoingTasks(graceMs = 10 * 60_000, now = Date.now(), registry?: Pick<SessionRegistry, "getSlim">): WandTask[] {
    const reclaimed: WandTask[] = [];
    for (const candidate of this.s.listWandTasks()) {
      if (candidate.status !== "doing") continue;
      const done = this.s.transaction(() => {
        const task = this.s.getWandTask(candidate.id);
        if (!task || task.status !== "doing") return null;
        const updated = Date.parse(task.updatedAt);
        if (!Number.isFinite(updated) || now - updated < graceMs) return null;
        if (this.taskHasPendingWork(task, registry)) return null;
        const result = this.s.tasks.writeWandTask(task, { status: "todo" }, true);
        this.addSystemComment(task.id, "任务回收", [
          "任务回收：已从「执行中」退回「等待认领」",
          "原因：这个任务处于「执行中」，但自身及子任务已无运行、审批、排队、未知送达的执行或活动团队；关联的空闲历史会话不代表仍在执行。",
          "此操作不代表交付、阻塞解除或验收通过；原描述、评论、会话、阻塞及交付/验收记录均保留。需要继续时重新派发即可。",
        ].join("\n\n"), result.updatedAt);
        return result;
      });
      if (done) reclaimed.push(done);
    }
    return reclaimed;
  }

  private taskHasPendingWork(task: WandTask, registry?: Pick<SessionRegistry, "getSlim">, seen = new Set<string>()): boolean {
    // 不完整/循环层级按未知处理，不能凭状态标签回收。
    if (seen.has(task.id)) return true;
    seen.add(task.id);
    for (const id of this.s.listWandTaskSessionIds(task.id)) {
      const session = registry?.getSlim(id) ?? this.s.getSessionSlim(id);
      if (!session || !session.archived && isArchiveBlocked(session)) return true;
    }
    // 父卡评论可以派发到子卡；两种归属都必须核对。未知送达不能用超时猜成已结束。
    if (this.db.prepare(`SELECT 1 FROM wand_task_comment_dispatches d
      WHERE (d.task_id = ? OR d.execution_task_id = ?) AND d.employee_id IS NOT NULL AND (d.state IN ('pending', 'queued', 'paused', 'unknown')
        OR (d.state = 'accepted' AND (d.session_id IS NULL OR (d.result_end_index IS NULL
          AND NOT EXISTS (SELECT 1 FROM command_sessions s WHERE s.id = d.session_id))))) LIMIT 1`).get(task.id, task.id)) return true;
    if ([task.id, task.workspaceTaskId].some(id => id && this.s.listAiTeamRuns({ taskId: id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES, limit: 1 }).length)) return true;
    return this.s.listWandTaskChildren(task.id).some(child => child.status !== "archived" && this.taskHasPendingWork(child, registry, seen));
  }

  /** Called only by an active runner; never grants the project or arbitrary task IDs. */
  issueTaskWorkflowAccess(sessionId: string): { token: string; taskId: string; revision: number } | null {
    const session = this.s.getSessionSlim(sessionId);
    const scope = this.s.knowledgeSessionScope(sessionId);
    if (!session || session.archived || ["failed", "stopped", "exited"].includes(session.status) || !session.workspaceTaskId || !scope?.employeeId || session.automationId?.startsWith("dingtalk:")) return null;
    const employee = this.s.getSiliconEmployeeDefinition(scope.employeeId);
    if (!employee || employee.archivedAt) return null;
    const task = this.s.getWandTaskByWorkspaceTaskId(session.workspaceTaskId);
    if (!task || task.status === "archived" || task.workspaceId !== scope.workspaceId) return null;
    const token = crypto.randomBytes(32).toString("base64url"), revision = task.deliveryRevision ?? 0;
    this.db.prepare("DELETE FROM task_workflow_access WHERE expires_at <= ? OR session_id = ?").run(Date.now(), sessionId);
    this.db.prepare(`INSERT INTO task_workflow_access(token_hash, task_id, session_id, employee_id, workspace_task_id, delivery_revision, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hash(token), task.id, sessionId, scope.employeeId, session.workspaceTaskId, revision, Date.now() + 6 * 3600_000);
    return { token, taskId: task.id, revision };
  }

  resolveTaskWorkflowAccess(token: string): Grant | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare("SELECT * FROM task_workflow_access WHERE token_hash = ? AND expires_at > ?").get(hash(token), Date.now());
    if (!row) return null;
    const session = this.s.getSessionSlim(String(row.session_id));
    const scope = this.s.knowledgeSessionScope(String(row.session_id));
    const task = this.s.getWandTask(String(row.task_id));
    const employee = scope?.employeeId ? this.s.getSiliconEmployeeDefinition(scope.employeeId) : null;
    if (!employee || employee.archivedAt) return null;
    if (!session || session.archived || ["failed", "stopped", "exited"].includes(session.status) || !scope || !task || task.status === "archived" || task.workspaceTaskId !== row.workspace_task_id
      || session.workspaceTaskId !== row.workspace_task_id || scope.employeeId !== row.employee_id || scope.workspaceId !== task.workspaceId
      || (task.deliveryRevision ?? 0) !== row.delivery_revision) return null;
    return { taskId: task.id, sessionId: session.id, employeeId: scope.employeeId, revision: Number(row.delivery_revision) };
  }

  revokeTaskWorkflowAccess(token: string): void { this.db.prepare("DELETE FROM task_workflow_access WHERE token_hash = ?").run(hash(token)); }

  applyEmployeeTaskWorkflow(token: string, taskId: string, input: unknown): WandTask {
    return this.s.transaction(() => {
      const access = this.resolveTaskWorkflowAccess(token);
      if (!access || access.taskId !== taskId) throw new HttpError(403, "forbidden", "任务回填权限已失效或不属于当前任务，请等待新的执行；不能改用所有者身份。");
      return this.applyTaskWorkflow(taskId, input, { kind: "employee", sessionId: access.sessionId, employeeId: access.employeeId });
    });
  }

  applyTaskWorkflow(taskId: string, value: unknown, actor: TaskWorkflowActor, registry?: SessionRegistry): WandTask {
    const input = parseTaskWorkflowInput(value);
    const signature = hash(JSON.stringify({ actor, input }));
    return this.s.transaction(() => {
      const previous = this.db.prepare("SELECT signature, result_json FROM task_workflow_events WHERE task_id = ? AND request_id = ?").get(taskId, input.requestId);
      if (previous) {
        if (previous.signature !== signature) throw new HttpError(409, "conflict", "请求标识已用于另一份验收意图，请保留原输入并核对记录。");
        return this.s.getWandTask(taskId) ?? JSON.parse(String(previous.result_json)) as WandTask;
      }
      const task = this.s.getWandTask(taskId);
      if (!task) throw new HttpError(404, "not_found", "任务已删除。");
      if (task.updatedAt !== input.expectedUpdatedAt) throw new HttpError(409, "conflict", "任务已变化，请刷新并核对当前交付后再操作；草稿不会自动重发。");
      const children = this.s.listWandTaskChildren(taskId);
      const ownedSession = actor.kind === "employee" ? actor.sessionId : null;
      const family = [task, ...children];
      for (const member of input.action === "progress" ? [] : family) {
        if (this.db.prepare("SELECT 1 FROM wand_task_comment_dispatches WHERE (task_id = ? OR execution_task_id = ?) AND employee_id IS NOT NULL AND (state IN ('pending', 'unknown') OR (state = 'accepted' AND session_id IS NULL)) AND (session_id IS NULL OR session_id != ?) LIMIT 1").get(member.id, member.id, ownedSession ?? "")) throw new HttpError(409, "busy", "仍有送达未确认的执行，请先核对原会话。");
        const queued = this.s.countQueuedTaskCommentDispatchesForTask(member.id);
        if (queued > 0) throw new HttpError(409, "busy", "任务仍有排队执行，请先处理队列。");
        for (const id of this.s.listWandTaskSessionIds(member.id)) {
          if (id === ownedSession) continue;
          const session = registry?.getSlim(id) ?? this.s.getSessionSlim(id);
          if (session && isArchiveBlocked(session)) throw new HttpError(409, "busy", "任务仍有执行或等待处理的请求，不能推进验收。");
        }
        if ([member.id, member.workspaceTaskId].some(id => id && this.s.listAiTeamRuns({ taskId: id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES, limit: 1 }).length)) throw new HttpError(409, "busy", "任务仍有运行中的团队，不能推进验收。");
      }
      const now = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();
      const patch = taskWorkflowPatch(task, children, input, actor, now);
      if (input.action === "pass" || input.action === "accept") {
        for (const child of children) {
          const childPatch = input.action === "pass" ? { status: "ready" as const,
            verification: { verdict: "passed" as const, evidence: input.evidence, blocker: "", reviewedAt: now, revision: child.deliveryRevision ?? 0,
              sourceSessionId: ownedSession, reviewerId: actor.kind === "employee" ? actor.employeeId : null } }
            : { status: "archived" as const, acceptance: { evidence: input.evidence, blocker: "", acceptedAt: now, confirmedRevision: child.deliveryRevision ?? 0 } };
          this.s.tasks.writeWandTask(child, childPatch, true);
        }
      }
      if (task.parentTaskId && ["progress", "submit", "fail", "return"].includes(input.action)) {
        const parent = this.s.getWandTask(task.parentTaskId);
        if (parent && ["review", "ready"].includes(parent.status)) this.s.tasks.writeWandTask(parent, { status: "doing", verification: null }, true);
      }
      const result = this.s.tasks.writeWandTask(task, patch, true);
      const id = crypto.randomUUID();
      this.db.prepare(`INSERT INTO task_workflow_events(id, task_id, request_id, signature, action, actor_kind, actor_id, source_session_id, evidence, blocker, created_at, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, input.requestId, signature, input.action, actor.kind,
          actor.kind === "employee" ? actor.employeeId : null, ownedSession, input.evidence, input.blocker, now, JSON.stringify(result));
      const labels = { progress: "执行进展与阻塞已回填（不代表交付）", submit: "交付已提交，等待 AI 验收", pass: "AI 验收通过，等待人工确认归档", fail: "AI 验收未通过，退回执行中", return: "人工退回，继续修改", accept: "人工确认交付并归档" };
      this.db.prepare("INSERT INTO wand_task_comments(id, task_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, taskId, "验收流程", [labels[input.action], input.evidence ? `证据：${input.evidence}` : "", input.blocker ? `缺口：${input.blocker}` : "", `交付版本：${result.deliveryRevision ?? 0}${ownedSession ? ` · 来源会话：${ownedSession}` : ""}`].filter(Boolean).join("\n\n"), now);
      return result;
    });
  }

  hasTaskReviewReceipt(taskId: string, sessionId: string, revision: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM task_workflow_events WHERE task_id = ? AND source_session_id = ? AND action IN ('pass', 'fail') AND json_extract(result_json, '$.verification.revision') = ? LIMIT 1").get(taskId, sessionId, revision));
  }

  listTaskWorkflowEvents(taskId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT id, request_id AS requestId, action, actor_kind AS actorKind, actor_id AS actorId,
      source_session_id AS sourceSessionId, evidence, blocker, created_at AS createdAt FROM task_workflow_events WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`).all(taskId);
  }
}
