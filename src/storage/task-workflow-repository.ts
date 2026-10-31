import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import type { SessionRegistry } from "../session-registry.js";
import { HttpError } from "../http-error.js";
import { isArchiveBlocked } from "../archive-policy.js";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "../ai-team-types.js";
import { parseTaskWorkflowInput, taskWorkflowPatch, type TaskWorkflowActor } from "../task-workflow.js";
import { type WandTask } from "../task-types.js";
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
type Grant = { taskId: string; sessionId: string; employeeId: string | null; revision: number };

export class TaskWorkflowRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

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
      for (const member of family) {
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
      const result = this.s.tasks.writeWandTask(task, patch, true);
      const id = crypto.randomUUID();
      this.db.prepare(`INSERT INTO task_workflow_events(id, task_id, request_id, signature, action, actor_kind, actor_id, source_session_id, evidence, blocker, created_at, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, input.requestId, signature, input.action, actor.kind,
          actor.kind === "employee" ? actor.employeeId : null, ownedSession, input.evidence, input.blocker, now, JSON.stringify(result));
      const labels = { submit: "交付已提交，等待 AI 验收", pass: "AI 验收通过，等待人工确认归档", fail: "AI 验收未通过，退回执行中", return: "人工退回，继续修改", accept: "人工确认交付并归档" };
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
