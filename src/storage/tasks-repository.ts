import crypto from "node:crypto";
import { assertTaskHierarchy } from "../task-hierarchy.js";
import { DatabaseSync } from "node:sqlite";
import { firstLayoutTabId } from "../layout-tree.js";
import { nowIso } from "../password-manager.js";
import { isSessionProvider } from "../session-provider.js";
import { isSystemAiCall } from "../system-ai-call.js";
import { isThinkingEffort } from "../structured-provider-common.js";
import type { WandTask, WandTaskAgent, WandTaskComment, WandTaskStatus } from "../task-types.js";
import { DEFAULT_ITERATION_NAME, DEFAULT_WAND_TASK_PRIORITY, isTaskExecutionSubject, normalizeWandTaskAgentMode } from "../task-types.js";
import { GLOBAL_WORKSPACE_ID, SessionSnapshot } from "../types.js";
import { safeJsonParse, mapWandMilestoneRow, mapIterationPromptRow } from "./mappers.js";
import { parseWandTaskAgent } from "./mappers.js";
import type { WandStorage } from "../storage.js";
import { CreateWandTaskInput, WandTaskPatch, WAND_TASK_FIELDS, WORKSPACE_TASK_PROJECTION, withoutSessionTab } from "./internal.js";
import type { WandTaskMilestone, WandIterationPrompt, WandIterationPromptSource } from "../task-types.js";

/** Task storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class TaskRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  tasksAggregateFingerprint(): string {
    const sessions = this.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(archived), 0) AS archivedCount,
              COALESCE(MAX(started_at), '') AS started,
              COALESCE(MAX(ended_at), '') AS ended,
              COALESCE(MAX(title), '') AS title,
              COALESCE(SUM(completion_revision), 0) AS completionRevision,
              COALESCE(SUM(viewed_completion_revision), 0) AS viewedCompletionRevision
       FROM command_sessions`
    ).get() as { count: number; archivedCount: number; started: string; ended: string; title: string };
    // Per-task metadata catches edits even when another task owns the maximum
    // timestamp/revision. Layout payloads are represented by their own revision.
    const tasks = this.db.prepare(
      `SELECT id, workspace_id, name, status, cwd, worktree_json, milestone_id,
              created_at, last_opened_at, layout_revision
       FROM (${WORKSPACE_TASK_PROJECTION}) ORDER BY id`
    ).all();
    const workspaces = this.db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(MAX(last_opened_at), '') AS opened FROM workspaces`
    ).get() as { count: number; opened: string };
    // 名称也进指纹：改名（含工作区/项目名与目录自定义名）后客户端才肯重拉任务列表。
    const names = this.db.prepare(
      `SELECT
         COALESCE((SELECT GROUP_CONCAT(id || ':' || name || ':' || cwd, '|')
                   FROM (SELECT id, name, cwd FROM workspaces ORDER BY id)), '') AS workspaceNames,
         COALESCE((SELECT GROUP_CONCAT(path || ':' || name || ':' || updated_at, '|')
                   FROM (SELECT path, name, updated_at FROM session_directory_names ORDER BY path)), '') AS directoryNames`
    ).get() as { workspaceNames: string; directoryNames: string };
    const membership = this.db.prepare(
      "SELECT id, workspace_id, workspace_task_id FROM command_sessions ORDER BY id",
    ).all();
    return JSON.stringify({
      sessions,
      membership,
      tasks,
      workspaces,
      names,
    });
  }

  /**
   * 会话列表团队标记的廉价指纹：运行/步骤状态一变，`/api/tasks` 里的 `teamChat`/`teamStep`
   * 就跟着变，客户端必须肯重拉。只看聚合值和最近若干条状态，不逐行拼整张表。
   */
  teamSessionFingerprint(): string {
    const runs = this.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE((SELECT GROUP_CONCAT(status || ':' || COALESCE(chat_session_id, ''), '|')
                        FROM (SELECT status, chat_session_id FROM ai_team_runs ORDER BY rowid DESC LIMIT 500)), '') AS statuses
       FROM ai_team_runs`,
    ).get() as { count: number; statuses: string };
    const steps = this.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE((SELECT GROUP_CONCAT(status || ':' || COALESCE(session_id, ''), '|')
                        FROM (SELECT status, session_id FROM ai_team_steps ORDER BY rowid DESC LIMIT 500)), '') AS statuses
       FROM ai_team_steps`,
    ).get() as { count: number; statuses: string };
    return JSON.stringify({ runs, steps });
  }

  /** GET /api/wand-tasks 的顺序：新创建在前。客户端按此顺序渲染，不再本地排序。 */
  listWandTasks(workspaceId?: string | null): WandTask[] {
    const rows = this.db.prepare(
      `SELECT ${WAND_TASK_FIELDS}
       FROM wand_tasks ${workspaceId === undefined ? "" : "WHERE workspace_id IS ?"}
       ORDER BY created_at DESC, rowid DESC`,
    ).all(...(workspaceId === undefined ? [] : [workspaceId])) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapWandTaskRow(row));
  }

  mapWandTaskRow(row: Record<string, unknown>): WandTask {
    return {
      acceptance: safeJsonParse(String(row.acceptance_json ?? "null")),
      id: String(row.id),
      identifier: typeof row.identifier === "string" && row.identifier ? row.identifier : `TASK-${String(row.id).slice(0, 6)}`,
      workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
      workspaceTaskId: typeof row.workspace_task_id === "string" && row.workspace_task_id ? row.workspace_task_id : null,
      parentTaskId: typeof row.parent_task_id === "string" && row.parent_task_id ? row.parent_task_id : null,
      title: String(row.title),
      titleSource: row.title_source === "auto" ? "auto" : "user",
      autoTitleSignature: typeof row.auto_title_signature === "string" && row.auto_title_signature ? row.auto_title_signature : null,
      description: String(row.description ?? ""),
      status: row.status === "backlog" || row.status === "doing" || row.status === "done" || row.status === "archived" ? row.status as WandTaskStatus : "todo",
      priority: row.priority === "low" || row.priority === "medium" || row.priority === "high" || row.priority === "urgent" ? row.priority : "none",
      labels: (() => { const parsed = safeJsonParse<unknown>(String(row.labels_json ?? "[]")); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; })(),
      dueDate: typeof row.due_date === "string" ? row.due_date : null,
      milestoneId: typeof row.milestone_id === "string" && row.milestone_id ? row.milestone_id : null,
      sortOrder: Number(row.sort_order) || 0,
      agent: parseWandTaskAgent(row.agent_json),
      executionSubject: (() => {
        const parsed = safeJsonParse<unknown>(typeof row.execution_subject_json === "string" ? row.execution_subject_json : null);
        return isTaskExecutionSubject(parsed) ? parsed : null;
      })(),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: typeof row.archived_at === "string" && row.archived_at ? row.archived_at : null,
    };
  }

  listWandTaskComments(taskId: string): WandTaskComment[] {
    return this.listWandTaskCommentsPage(taskId, { limit: 50 }).comments;
  }

  /** Cursor page ordered by stable (created_at, id), returned oldest-to-newest for display. */
  listWandTaskCommentsPage(taskId: string, options: { before?: { createdAt: string; id: string } | null; limit?: number } = {}): { comments: WandTaskComment[]; totalCount: number; nextCursor: { createdAt: string; id: string } | null } {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const before = options.before;
    const rows = (before
      ? this.db.prepare(`SELECT id, created_at FROM wand_task_comments WHERE task_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(taskId, before.createdAt, before.createdAt, before.id, limit + 1)
      : this.db.prepare(`SELECT id, created_at FROM wand_task_comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(taskId, limit + 1)) as Array<{ id: string; created_at: string }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page.at(-1);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM wand_task_comments WHERE task_id = ?").get(taskId) as { count: number };
    const comments = [...page].reverse().map(row => this.getWandTaskComment(row.id)!).filter(Boolean);
    return { comments, totalCount: Number(count.count) || 0,
      nextCursor: hasMore && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null };
  }

  countWandTaskComments(taskId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM wand_task_comments WHERE task_id = ?").get(taskId) as { count: number };
    return Number(row.count) || 0;
  }

  /** One grouped query for task-list projections; tasks without comments are omitted (read as zero). */
  countWandTaskCommentsByTask(): Map<string, number> {
    const rows = this.db.prepare(`SELECT task_id, COUNT(*) AS count FROM wand_task_comments GROUP BY task_id`)
      .all() as Array<{ task_id: string; count: number }>;
    return new Map(rows.map(row => [row.task_id, Number(row.count) || 0]));
  }

  getWandTaskComment(id: string): WandTaskComment | null {
    const row = this.db.prepare(`SELECT c.*, d.request_id, d.source_comment_id, d.employee_id, d.employee_name,
      d.instruction, d.task_version, d.state, d.session_id, d.error, d.execution_status,
      d.result_start_index, d.result_end_index, d.result_request_id, d.result_outcome, d.result_fingerprint, d.result_start_fingerprint FROM wand_task_comments c
      LEFT JOIN wand_task_comment_dispatches d ON d.comment_id = c.id WHERE c.id = ?`).get(id) as Record<string, string | null> | undefined;
    return row ? this.mapWandTaskCommentRow(row) : null;
  }

  /** One task-scoped query for a bounded set of known comment IDs (e.g. status refresh for older pages). */
  getWandTaskCommentsByIds(taskId: string, ids: readonly string[]): WandTaskComment[] {
    const boundedIds = [...new Set(ids)].slice(0, 100);
    if (!boundedIds.length) return [];
    const placeholders = boundedIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT c.*, d.request_id, d.source_comment_id, d.employee_id, d.employee_name,
      d.instruction, d.task_version, d.state, d.session_id, d.error, d.execution_status,
      d.result_start_index, d.result_end_index, d.result_request_id, d.result_outcome, d.result_fingerprint, d.result_start_fingerprint
      FROM wand_task_comments c LEFT JOIN wand_task_comment_dispatches d ON d.comment_id = c.id
      WHERE c.task_id = ? AND c.id IN (${placeholders})`).all(taskId, ...boundedIds) as Array<Record<string, string | null>>;
    const byId = new Map(rows.map(row => [row.id!, this.mapWandTaskCommentRow(row)]));
    return boundedIds.flatMap(id => { const comment = byId.get(id); return comment ? [comment] : []; });
  }

  private mapWandTaskCommentRow(row: Record<string, string | null>): WandTaskComment {
    return { id: row.id!, taskId: row.task_id!, authorName: row.author_name!, body: row.body!, createdAt: row.created_at!,
      ...(row.request_id ? { requestId: row.request_id, sourceCommentId: row.source_comment_id, instruction: row.instruction!, taskVersion: row.task_version!,
        dispatch: row.employee_id ? { employeeId: row.employee_id, employeeName: row.employee_name!,
          state: row.state as "pending" | "accepted" | "failed" | "unknown", sessionId: row.session_id, error: row.error,
          ...(row.result_start_index !== null && row.result_start_index !== undefined && row.result_request_id ? { resultAnchor: {
            requestId: row.result_request_id, startFingerprint: row.result_start_fingerprint ?? "", fingerprint: row.result_fingerprint ?? "", startIndex: Number(row.result_start_index),
            endIndex: row.result_end_index === null || row.result_end_index === undefined ? null : Number(row.result_end_index),
            outcome: row.result_outcome === "done" || row.result_outcome === "failed" || row.result_outcome === "stopped" ? row.result_outcome : null,
          } } : {}), ...(row.execution_status ? { status: row.execution_status } : {}) } : null } : {}) };
  }

  findTaskCommentRequest(taskId: string, requestId: string): { comment: WandTaskComment; signature: string } | null {
    const row = this.db.prepare(`SELECT comment_id, signature FROM wand_task_comment_dispatches WHERE task_id = ? AND request_id = ?`)
      .get(taskId, requestId) as { comment_id: string; signature: string } | undefined;
    return row ? { comment: this.getWandTaskComment(row.comment_id)!, signature: row.signature } : null;
  }

  /** Atomically persist both the visible comment and the one-shot dispatch intent before any side effect. */
  createTaskCommentIntent(input: { taskId: string; requestId: string; signature: string; body: string; instruction: string;
    sourceCommentId: string | null; employeeId: string | null; employeeName: string | null; taskVersion: string }): WandTaskComment {
    return this.s.transaction(() => {
      const id = crypto.randomUUID();
      this.db.prepare(`INSERT INTO wand_task_comments(id, task_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, input.taskId, "用户", input.body, nowIso());
      this.db.prepare(`INSERT INTO wand_task_comment_dispatches(comment_id, task_id, request_id, signature, source_comment_id,
        employee_id, employee_name, instruction, task_version, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.taskId, input.requestId, input.signature, input.sourceCommentId, input.employeeId, input.employeeName,
          input.instruction, input.taskVersion, input.employeeId ? "pending" : "accepted");
      return this.getWandTaskComment(id)!;
    });
  }

  updateTaskCommentDispatch(id: string, state: "pending" | "accepted" | "failed" | "unknown", sessionId: string | null, error: string | null = null): void {
    this.db.prepare(`UPDATE wand_task_comment_dispatches SET state = ?, session_id = COALESCE(?, session_id), error = ? WHERE comment_id = ?`)
      .run(state, sessionId, error, id);
  }

  /** Bind the first structured request to its stable message index exactly once. */
  bindTaskCommentResultStart(sessionId: string, requestId: string, startIndex: number): void {
    const session = this.db.prepare("SELECT messages FROM command_sessions WHERE id = ?").get(sessionId) as { messages: string | null } | undefined;
    if (!session?.messages) return;
    let messages: unknown;
    try { messages = JSON.parse(session.messages); } catch { return; }
    const turns = Array.isArray(messages) ? messages as Array<{ role?: unknown; requestId?: unknown }> : null;
    const turn = turns?.[startIndex];
    if (!Number.isInteger(startIndex) || startIndex < 0 || turn?.role !== "user" || turn.requestId !== requestId) return;
    // Bind once. Candidate fallback explicitly reopens this anchor only after the
    // runner reports a verified pre-execution rejection.
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(turn)).digest("hex");
    this.db.prepare(`UPDATE wand_task_comment_dispatches SET result_start_index = ?, result_request_id = ?,
      result_start_fingerprint = ?, result_fingerprint = NULL
      WHERE session_id = ? AND state != 'failed' AND result_start_index IS NULL AND EXISTS (
        SELECT 1 FROM command_sessions s WHERE s.id = ? AND s.automation_id = 'wand-task-comment:' || wand_task_comment_dispatches.comment_id
          AND s.session_kind = 'structured'
      )`).run(startIndex, requestId, fingerprint, sessionId, sessionId);
  }

  /** Reopen only a terminal, explicitly rejected attempt that the structured runner is retrying before acceptance. */
  resetTaskCommentResultForUnacceptedRetry(sessionId: string, failedRequestId: string): void {
    this.db.prepare(`UPDATE wand_task_comment_dispatches SET result_start_index = NULL, result_end_index = NULL,
      result_request_id = NULL, result_start_fingerprint = NULL, result_outcome = NULL, result_fingerprint = NULL, execution_status = 'running'
      WHERE session_id = ? AND result_request_id = ?
        AND (result_end_index IS NULL OR result_outcome = 'failed')
        AND EXISTS (SELECT 1 FROM command_sessions s WHERE s.id = ?
          AND s.automation_id = 'wand-task-comment:' || wand_task_comment_dispatches.comment_id AND s.session_kind = 'structured')`)
      .run(sessionId, failedRequestId, sessionId);
  }

  /** Freeze end-exclusive message boundary only on an explicit terminal event, once. */
  freezeTaskCommentResult(sessionId: string, endIndex: number, outcome: "done" | "failed" | "stopped", requestId?: string | null): void {
    const session = this.db.prepare("SELECT messages FROM command_sessions WHERE id = ?").get(sessionId) as { messages: string | null } | undefined;
    if (!session?.messages) return;
    let messages: unknown;
    try { messages = JSON.parse(session.messages); } catch { return; }
    if (!Array.isArray(messages) || !Number.isInteger(endIndex) || endIndex < 0 || endIndex > messages.length) return;
    const turns = messages as Array<{ role?: unknown; requestId?: unknown }>;
    const bindings = this.db.prepare(`SELECT comment_id, result_start_index, result_request_id, result_start_fingerprint FROM wand_task_comment_dispatches
      WHERE session_id = ? AND result_start_index IS NOT NULL AND result_end_index IS NULL`).all(sessionId) as Array<{ comment_id: string; result_start_index: number; result_request_id: string; result_start_fingerprint: string | null }>;
    for (const binding of bindings) {
      const startIndex = Number(binding.result_start_index);
      if (startIndex < 0 || endIndex <= startIndex || turns[startIndex]?.role !== "user"
        || turns[startIndex]?.requestId !== binding.result_request_id || (requestId && requestId !== binding.result_request_id)) continue;
      const startFingerprint = crypto.createHash("sha256").update(JSON.stringify(turns[startIndex])).digest("hex");
      if (startFingerprint !== binding.result_start_fingerprint) continue;
      const range = turns.slice(startIndex, endIndex);
      // A later user request means the original terminal event was missed; never widen its result into another round.
      if (range.some((turn, index) => index > 0 && turn.role === "user")) continue;
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(range)).digest("hex");
      this.db.prepare(`UPDATE wand_task_comment_dispatches SET result_end_index = ?, result_outcome = ?, result_fingerprint = ?
        WHERE comment_id = ? AND result_end_index IS NULL AND result_start_fingerprint = ?`)
        .run(endIndex, outcome, fingerprint, binding.comment_id, binding.result_start_fingerprint);
    }
  }

  getTaskCommentResultBinding(taskId: string, commentId: string): { sessionId: string; requestId: string | null; startFingerprint: string | null; fingerprint: string | null; startIndex: number | null; endIndex: number | null; outcome: "done" | "failed" | "stopped" | null } | null {
    const row = this.db.prepare(`SELECT session_id, result_request_id, result_start_fingerprint, result_fingerprint, result_start_index, result_end_index, result_outcome
      FROM wand_task_comment_dispatches WHERE task_id = ? AND comment_id = ?`).get(taskId, commentId) as {
        session_id: string | null; result_request_id: string | null; result_start_fingerprint: string | null; result_fingerprint: string | null; result_start_index: number | null; result_end_index: number | null; result_outcome: string | null;
      } | undefined;
    if (!row?.session_id) return null;
    return { sessionId: row.session_id, requestId: row.result_request_id, startFingerprint: row.result_start_fingerprint, fingerprint: row.result_fingerprint,
      startIndex: row.result_start_index === null ? null : Number(row.result_start_index),
      endIndex: row.result_end_index === null ? null : Number(row.result_end_index),
      outcome: row.result_outcome === "done" || row.result_outcome === "failed" || row.result_outcome === "stopped" ? row.result_outcome : null };
  }

  getTaskCommentForTask(taskId: string, commentId: string): WandTaskComment | null {
    const comment = this.getWandTaskComment(commentId);
    return comment?.taskId === taskId ? comment : null;
  }

  /** Read-only recovery of the create/bind crash gap, by a server-generated correlation ID, never message text. */
  findTaskCommentExecutionSessionId(commentId: string, employeeId: string): string | null {
    const rows = this.db.prepare("SELECT id FROM command_sessions WHERE automation_id = ? LIMIT 2")
      .all(`wand-task-comment:${commentId}`) as Array<{ id: string }>;
    return rows.length === 1 && this.s.getSessionSlim(rows[0]!.id)?.employeeId === employeeId ? rows[0]!.id : null;
  }

  /** Event-owned facts, including stop outcomes which structured sessions intentionally represent as idle. */
  recordTaskCommentSessionEvent(event: import("../types.js").ProcessEvent): void {
    const data = event.data as { status?: string; turnOutcome?: string; terminalRequestId?: string; messages?: unknown; structuredState?: { activeRequestId?: string | null; lastError?: string | null; inFlight?: boolean } } | undefined;
    if (!data || typeof data !== "object") return;
    const rows = this.db.prepare(`SELECT comment_id, execution_status FROM wand_task_comment_dispatches
      WHERE session_id = ? AND EXISTS (SELECT 1 FROM command_sessions s WHERE s.id = ?
        AND s.automation_id = 'wand-task-comment:' || wand_task_comment_dispatches.comment_id AND s.session_kind = 'structured')`)
      .all(event.sessionId, event.sessionId) as Array<{ comment_id: string; execution_status: string | null }>;
    if (rows.length === 0) return;
    const messages = Array.isArray(data.messages) ? data.messages as Array<{ requestId?: unknown; messageId?: unknown; role?: unknown }> : null;
    const anchored = this.db.prepare(`SELECT 1 AS found FROM wand_task_comment_dispatches WHERE session_id = ?
      AND result_start_index IS NOT NULL AND result_end_index IS NULL LIMIT 1`).get(event.sessionId);
    if (!anchored && !messages && event.type !== "ended") return;
    const eventOutcome = data.turnOutcome === "stopped" || data.turnOutcome === "done" || data.turnOutcome === "failed"
      ? data.turnOutcome : null;
    const status = eventOutcome ?? (data.structuredState?.inFlight ? "running"
      : data.structuredState?.lastError ? "failed" : data.status);
    const perTurnTerminal = typeof data.terminalRequestId === "string"
      && (data.turnOutcome === "stopped" || data.turnOutcome === "done" || data.turnOutcome === "failed");
    if (status && (event.type === "ended" || perTurnTerminal)) {
      const update = this.db.prepare(`UPDATE wand_task_comment_dispatches SET execution_status = ? WHERE comment_id = ?
        AND execution_status IS NOT ? AND (result_end_index IS NULL OR ? = 'done')`);
      for (const row of rows) update.run(status, row.comment_id, status, status);
    } else if (status === "running") {
      const update = this.db.prepare(`UPDATE wand_task_comment_dispatches SET execution_status = 'running' WHERE comment_id = ?
        AND execution_status IS NOT 'running' AND result_end_index IS NULL`);
      for (const row of rows) update.run(row.comment_id);
    }

    const activeRequestId = data.structuredState?.activeRequestId;
    if (data.structuredState?.inFlight && activeRequestId && messages) {
      // A different active request supersedes an open anchor whose terminal event was
      // missed (e.g. after a crash). Only an explicitly rejected retry resets first.
      const startIndex = messages.findIndex(message => message?.role === "user" && message.requestId === activeRequestId);
      if (startIndex >= 0) this.bindTaskCommentResultStart(event.sessionId, activeRequestId, startIndex);
      return;
    }
    // Quiet/idle status snapshots, stale ended events, and incomplete payloads cannot settle an anchor.
    // A manager may emit an explicit per-turn terminal fact while the session remains running
    // (interrupt-and-send); it carries the original logical request ID and exact transcript boundary.
    if (!perTurnTerminal || !messages) return;
    const outcome = data.turnOutcome === "stopped" ? "stopped"
      : data.turnOutcome === "failed" || data.structuredState?.lastError || status === "failed" ? "failed" : "done";
    const terminalRequestId = data.terminalRequestId ?? (event.type === "ended"
      ? messages.slice().reverse().find(message => message?.role === "user")?.requestId
      : null);
    const terminalId = typeof terminalRequestId === "string" ? terminalRequestId : null;
    this.freezeTaskCommentResult(event.sessionId, messages.length, outcome, terminalId);
  }

  getWandTask(id: string): WandTask | null {
    const row = this.db.prepare(`SELECT ${WAND_TASK_FIELDS} FROM wand_tasks WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWandTaskRow(row) : null;
  }

  getWandTaskByWorkspaceTaskId(workspaceTaskId: string): WandTask | null {
    const row = this.db.prepare(`SELECT ${WAND_TASK_FIELDS} FROM wand_tasks
      WHERE workspace_task_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
      .get(workspaceTaskId) as Record<string, unknown> | undefined;
    return row ? this.mapWandTaskRow(row) : null;
  }

  insertWandTask(input: CreateWandTaskInput, createdAt = nowIso()): WandTask {
    return this.s.transaction(() => this.insertWandTaskBody(input, createdAt));
  }

  private insertWandTaskBody(input: CreateWandTaskInput, createdAt: string): WandTask {
    if (input.workspaceTaskId && this.getWandTaskByWorkspaceTaskId(input.workspaceTaskId)) {
      throw new Error("该任务容器已有任务卡片。");
    }
    assertTaskHierarchy(this.listWandTasks(), null, input.parentTaskId ?? null, input.workspaceId ?? null);
    const id = crypto.randomUUID();
    const status = input.status ?? "todo";
    const createdAtValue = createdAt;
    const archivedAt = status === "archived" ? createdAtValue : null;
    const max = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS value FROM wand_tasks
      WHERE workspace_id IS ? AND status = ?`).get(input.workspaceId ?? null, status) as { value: number };
    const number = this.db.prepare(`SELECT COALESCE(MAX(CAST(substr(identifier, 6) AS INTEGER)), 0) AS value
      FROM wand_tasks WHERE identifier GLOB 'TASK-[0-9]*'`).get() as { value: number };
    try {
      this.db.prepare(`INSERT INTO wand_tasks (${WAND_TASK_FIELDS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, `TASK-${number.value + 1}`, input.workspaceId ?? null, input.workspaceTaskId ?? null,
        input.parentTaskId ?? null, input.title, input.titleSource ?? "user", null,
        input.description ?? "", status, input.priority ?? DEFAULT_WAND_TASK_PRIORITY,
        JSON.stringify(input.labels ?? []), input.dueDate ?? null, input.milestoneId ?? null,
        max.value + 1, input.agent ? JSON.stringify(input.agent) : null,
        input.executionSubject ? JSON.stringify(input.executionSubject) : null, archivedAt, createdAtValue, createdAtValue, input.acceptance ? JSON.stringify(input.acceptance) : null);
    } catch (error) {
      if (input.workspaceTaskId && this.getWandTaskByWorkspaceTaskId(input.workspaceTaskId)) {
        throw new Error("该任务容器已有任务卡片。", { cause: error });
      }
      throw error;
    }
    if (input.parentTaskId) {
      const parent = this.getWandTask(input.parentTaskId);
      if (parent?.acceptance?.acceptedAt) this.writeWandTask(parent, { acceptance: { ...parent.acceptance, acceptedAt: null } });
    }
    this.s.notifyTaskTitleChange();
    return this.getWandTask(id)!;
  }

  createWandTask(input: CreateWandTaskInput): WandTask {
    return this.s.transaction(() => {
      const linked = input.workspaceTaskId ? this.s.getWorkspaceTask(input.workspaceTaskId) : null;
      const workspaceId = input.workspaceId === undefined && linked
        ? linked.workspaceId === GLOBAL_WORKSPACE_ID ? null : linked.workspaceId
        : input.workspaceId ?? null;
      const workspace = workspaceId ? this.s.getWorkspace(workspaceId) : this.s.ensureGlobalWorkspace();
      if (!workspace) throw new Error("任务所属工作区不存在。");
      const milestoneId = this.s.taskMilestoneForWrite(input.milestoneId, workspaceId);
      if (input.workspaceTaskId) {
        const container = this.s.getWorkspaceTask(input.workspaceTaskId);
        if (!container) throw new Error("未找到该任务。");
        const existing = this.getWandTaskByWorkspaceTaskId(container.id);
        // Compatibility for callers which supplied a previously created container.
        if (existing) return this.writeWandTask(existing, { ...input, workspaceId, milestoneId });
      }
      const workspaceTaskId = input.workspaceTaskId ?? this.s.insertWorkspaceTask({
        workspaceId: workspace.id, name: input.title,
        status: input.status === "done" || input.status === "archived" ? "done" : "active",
        milestoneId,
      });
      return this.insertWandTask({ ...input, workspaceId, workspaceTaskId, milestoneId });
    });
  }

  /** Private canonical writer; callers own the transaction, never a reverse writer. */
  writeWandTask(current: WandTask, patch: WandTaskPatch): WandTask {
    const next = { ...current, ...patch, updatedAt: nowIso() };
    assertTaskHierarchy(this.listWandTasks(), current.id, next.parentTaskId, next.workspaceId, current);
    if (next.acceptance?.acceptedAt) {
      if (patch.description !== undefined && patch.description !== current.description) next.acceptance = { ...next.acceptance, acceptedAt: null };
      else if (!next.acceptance.evidence.trim() || next.acceptance.blocker.trim()) throw new Error("验收通过需要交付证据，并先解除阻塞。");
      else if (this.listWandTasks().some(child => child.parentTaskId === current.id && !child.acceptance?.acceptedAt)) throw new Error("仍有子任务未验收通过，不能通过主目标整体验收。");
    }
    // 归档时间只在进入归档时写一次；取消归档/重新打开时清空，恢复“未动多久”重新计时。
    if (next.status === "archived") {
      if (!next.archivedAt) next.archivedAt = next.updatedAt;
    } else {
      next.archivedAt = null;
    }
    if (patch.milestoneId !== undefined || patch.workspaceId !== undefined) {
      next.milestoneId = this.s.taskMilestoneForWrite(next.milestoneId, next.workspaceId);
    }
    if (next.workspaceTaskId && next.workspaceTaskId !== current.workspaceTaskId) {
      const existing = this.db.prepare(`SELECT id FROM wand_tasks WHERE workspace_task_id = ? AND id != ? LIMIT 1`)
        .get(next.workspaceTaskId, current.id) as { id: string } | undefined;
      if (existing) throw new Error("该任务容器已有任务卡片。");
    }
    if (!next.workspaceTaskId && next.status !== "archived") {
      const workspace = next.workspaceId ? this.s.getWorkspace(next.workspaceId) : this.s.ensureGlobalWorkspace();
      if (!workspace) throw new Error("任务所属工作区不存在。");
      next.workspaceTaskId = this.s.insertWorkspaceTask({
        workspaceId: workspace.id, name: next.title, milestoneId: next.milestoneId,
        status: next.status === "done" ? "done" : "active", createdAt: next.createdAt,
      });
    }
    this.db.prepare(`UPDATE wand_tasks SET workspace_id = ?, workspace_task_id = ?, parent_task_id = ?,
      title = ?, title_source = ?, auto_title_signature = ?, description = ?, status = ?, priority = ?,
      labels_json = ?, due_date = ?, milestone_id = ?, sort_order = ?, agent_json = ?, execution_subject_json = ?,
      archived_at = ?, updated_at = ?, acceptance_json = ?
      WHERE id = ?`)
      .run(next.workspaceId, next.workspaceTaskId, next.parentTaskId, next.title, next.titleSource,
        next.autoTitleSignature ?? null, next.description, next.status, next.priority,
        JSON.stringify(next.labels), next.dueDate, next.milestoneId ?? null, next.sortOrder,
        next.agent ? JSON.stringify(next.agent) : null,
        next.executionSubject ? JSON.stringify(next.executionSubject) : null,
        next.archivedAt, next.updatedAt, next.acceptance ? JSON.stringify(next.acceptance) : null, next.id);
    if (patch.workspaceId !== undefined && next.workspaceTaskId) {
      const workspaceId = next.workspaceId ?? this.s.ensureGlobalWorkspace().id;
      // The container FK/index and standalone session workspace bucket follow the canonical project.
      this.db.prepare("UPDATE workspace_tasks SET workspace_id = ? WHERE id = ?")
        .run(workspaceId, next.workspaceTaskId);
      this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE workspace_task_id = ?")
        .run(workspaceId, next.workspaceTaskId);
    }
    if ((patch.acceptance !== undefined || patch.description !== undefined || patch.parentTaskId !== undefined) && next.parentTaskId) {
      const parent = this.getWandTask(next.parentTaskId);
      if (parent?.acceptance?.acceptedAt) this.writeWandTask(parent, { acceptance: { ...parent.acceptance, acceptedAt: null } });
    }
    this.s.notifyTaskTitleChange();
    return next;
  }

  updateWandTask(id: string, patch: WandTaskPatch): WandTask | null {
    return this.s.transaction(() => {
      const current = this.getWandTask(id);
      if (!current) return null;
      return this.writeWandTask(current, patch);
    });
  }

  /** Commit completion archives only the selected completed cards, atomically. */
  archiveCompletedWandTasks(ids: readonly string[]): string[] {
    return this.archiveWandTasks(ids, { completedOnly: true });
  }

  /**
   * Archive the given cards. Already-archived ids are skipped.
   * `completedOnly` keeps the historical commit helper from closing in-progress work.
   */
  archiveWandTasks(ids: readonly string[], options: { completedOnly?: boolean } = {}): string[] {
    return this.s.transaction(() => {
      const archived: string[] = [];
      for (const id of new Set(ids)) {
        const task = this.getWandTask(id);
        if (!task || task.status === "archived") continue;
        if (options.completedOnly && task.status !== "done") continue;
        this.writeWandTask(task, { status: "archived" });
        archived.push(id);
      }
      return archived;
    });
  }

  deleteWandTask(id: string): void {
    this.s.transaction(() => this.removeWandTaskRow(id));
  }

  /**
   * 批量硬删除卡片：一次事务，返回实际删除的 id（不存在或已消失的跳过）。
   * 归档目录的「清空」和保留期扫描都走这里，调用方自己决定哪些 id 可以删。
   */
  deleteWandTasks(ids: readonly string[]): string[] {
    return this.s.transaction(() => {
      const deleted: string[] = [];
      for (const id of new Set(ids)) {
        if (this.removeWandTaskRow(id)) deleted.push(id);
      }
      return deleted;
    });
  }

  /** Single-card hard delete body; callers own the transaction (SQLite forbids nesting). */
  private removeWandTaskRow(id: string): boolean {
    const card = this.getWandTask(id);
    if (!card) return false;
    this.db.prepare("UPDATE wand_tasks SET parent_task_id = NULL WHERE parent_task_id = ?").run(id);
    if (card.workspaceTaskId) {
      this.db.prepare("UPDATE command_sessions SET workspace_task_id = NULL WHERE workspace_task_id = ?")
        .run(card.workspaceTaskId);
      this.db.prepare("DELETE FROM workspace_tasks WHERE id = ?").run(card.workspaceTaskId);
    }
    this.db.prepare("DELETE FROM wand_tasks WHERE id = ?").run(id);
    return true;
  }

  /**
   * 里程碑列表。传工作区 id 时返回「该工作区 + 全局（workspace_id IS NULL）」；
   * 未指定工作区（null / undefined / 空串）时返回全部。
   */
  listWandMilestones(workspaceId?: string | null): WandTaskMilestone[] {
    const scoped = typeof workspaceId === "string" ? workspaceId.trim() : "";
    const select = "SELECT id, name, due_date, workspace_id, is_default, created_at, updated_at FROM wand_milestones";
    // 默认迭代永远排最前：新建任务的下拉把它放在第一项，不选时也回落到它。
    const order = " ORDER BY is_default DESC, created_at DESC, rowid DESC";
    const rows = (scoped
      ? this.db.prepare(`${select} WHERE workspace_id = ? OR workspace_id IS NULL${order}`).all(scoped)
      : this.db.prepare(`${select}${order}`).all()) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapWandMilestoneRow).filter((item): item is WandTaskMilestone => item !== null);
  }

  getWandMilestone(id: string): WandTaskMilestone | null {
    const row = this.db.prepare(
      `SELECT id, name, due_date, workspace_id, is_default, created_at, updated_at FROM wand_milestones WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapWandMilestoneRow(row) : null;
  }

  /** 已有的默认迭代；未创建过时返回 null（读路径用它，不写库）。 */
  findDefaultWandMilestone(): WandTaskMilestone | null {
    const row = this.db.prepare(
      `SELECT id, name, due_date, workspace_id, is_default, created_at, updated_at FROM wand_milestones WHERE is_default = 1 ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    return row ? mapWandMilestoneRow(row) : null;
  }

  /**
   * 惰性拿到全局唯一的「默认迭代」：没有就建一个，返回值一定可写进任务 / 记录。
   * 用户已经自己建过一个同名迭代时直接把它提升为默认，不再造第二个重名行。
   */
  ensureDefaultWandMilestone(): WandTaskMilestone {
    const existing = this.findDefaultWandMilestone();
    if (existing) return existing;
    const sameName = this.db.prepare(
      `SELECT id FROM wand_milestones WHERE name = ? AND workspace_id IS NULL ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    ).get(DEFAULT_ITERATION_NAME) as { id?: string } | undefined;
    if (sameName?.id) {
      this.db.prepare("UPDATE wand_milestones SET is_default = 1, updated_at = ? WHERE id = ?").run(nowIso(), sameName.id);
      return this.getWandMilestone(sameName.id)!;
    }
    return this.createWandMilestone({ name: DEFAULT_ITERATION_NAME, isDefault: true });
  }

  createWandMilestone(input: { name: string; dueDate?: string | null; workspaceId?: string | null; isDefault?: boolean }): WandTaskMilestone {
    const id = crypto.randomUUID();
    const now = nowIso();
    const workspaceId = typeof input.workspaceId === "string" && input.workspaceId.trim() ? input.workspaceId.trim() : null;
    // 默认迭代是全局兜底：固定 workspace_id = NULL，任何工作区的任务都能挂。
    const isDefault = input.isDefault === true;
    this.db.prepare(
      `INSERT INTO wand_milestones (id, name, due_date, workspace_id, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.name, input.dueDate ?? null, isDefault ? null : workspaceId, isDefault ? 1 : 0, now, now);
    return this.getWandMilestone(id)!;
  }

  updateWandMilestone(id: string, patch: { name?: string; dueDate?: string | null; workspaceId?: string | null }): WandTaskMilestone | null {
    const current = this.getWandMilestone(id);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      dueDate: patch.dueDate === undefined ? current.dueDate : patch.dueDate,
      // 默认迭代永远是全局的：不允许改挂到某个工作区，否则别的项目就看不到兜底迭代了。
      workspaceId: current.isDefault
        ? null
        : patch.workspaceId === undefined
          ? current.workspaceId
          : (typeof patch.workspaceId === "string" && patch.workspaceId.trim() ? patch.workspaceId.trim() : null),
      updatedAt: nowIso(),
    };
    this.db.prepare(
      `UPDATE wand_milestones SET name = ?, due_date = ?, workspace_id = ?, updated_at = ? WHERE id = ?`,
    ).run(next.name, next.dueDate, next.workspaceId, next.updatedAt, id);
    return this.getWandMilestone(id);
  }

  /**
   * 删除里程碑只解绑任务（milestone_id 置空）、并把提示词记录改挂到默认迭代，绝不删任务与记录。
   * 默认迭代不可删除：返回 false，由调用方给出明确提示。
   */
  deleteWandMilestone(id: string): boolean {
    const current = this.getWandMilestone(id);
    if (!current) return false;
    if (current.isDefault) return false;
    const removed = this.db.prepare("DELETE FROM wand_milestones WHERE id = ?").run(id);
    if (Number(removed.changes) === 0) return false;
    this.db.prepare("UPDATE wand_tasks SET milestone_id = NULL WHERE milestone_id = ?").run(id);
    this.db.prepare("UPDATE workspace_tasks SET milestone_id = NULL WHERE milestone_id = ?").run(id);
    // 记录属于「用户的改动历史」，不能因为删迭代就丢：改挂到默认迭代。
    const fallback = this.findDefaultWandMilestone();
    if (fallback) {
      this.db.prepare("UPDATE wand_iteration_prompts SET milestone_id = ? WHERE milestone_id = ?").run(fallback.id, id);
    }
    return true;
  }

  /** 各迭代下的任务数（看板卡片），用于下拉里的数量提示；历史 NULL 行算在默认迭代里。 */
  countWandTasksByMilestone(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT milestone_id, COUNT(*) AS count FROM wand_tasks GROUP BY milestone_id`,
    ).all() as unknown as Array<{ milestone_id: string | null; count: number }>;
    const defaultId = this.findDefaultWandMilestone()?.id ?? null;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = row.milestone_id ? String(row.milestone_id) : defaultId;
      if (!key) continue;
      counts[key] = (counts[key] ?? 0) + (Number(row.count) || 0);
    }
    return counts;
  }

  /** 同一会话最近一条记录；用来去重（同一提示词重复提交 / 占位与模型结果双写）。 */
  latestIterationPromptForSession(sessionId: string): WandIterationPrompt | null {
    const row = this.db.prepare(
      `SELECT * FROM wand_iteration_prompts WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapIterationPromptRow(row) : null;
  }

  createIterationPrompt(input: {
    milestoneId: string;
    workspaceId?: string | null;
    sessionId?: string | null;
    taskId?: string | null;
    repoKey?: string | null;
    cwd?: string;
    title: string;
    detail?: string;
    source?: WandIterationPromptSource;
  }): WandIterationPrompt {
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO wand_iteration_prompts (id, milestone_id, workspace_id, session_id, task_id, repo_key, cwd, title, detail, source, consumed_at, consumed_commit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(
      id,
      input.milestoneId,
      input.workspaceId ?? null,
      input.sessionId ?? null,
      input.taskId ?? null,
      input.repoKey ?? null,
      input.cwd ?? "",
      input.title,
      input.detail ?? "",
      input.source ?? "session",
      now,
    );
    return mapIterationPromptRow(
      this.db.prepare(`SELECT * FROM wand_iteration_prompts WHERE id = ?`).get(id) as Record<string, unknown>,
    )!;
  }

  /**
   * 迭代窗口里的提示词记录，按时间正序（模型读起来就是「先做什么、后做什么」）。
   * `repoKey` 给值时按仓库隔离；`includeConsumed=false` 只看还没提交的部分。
   */
  listIterationPrompts(filter: {
    milestoneId?: string | null;
    repoKey?: string | null;
    sessionId?: string | null;
    includeConsumed?: boolean;
    limit?: number;
  } = {}): WandIterationPrompt[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (filter.milestoneId) {
      conditions.push("milestone_id = ?");
      values.push(filter.milestoneId);
    }
    if (filter.repoKey) {
      conditions.push("repo_key = ?");
      values.push(filter.repoKey);
    }
    if (filter.sessionId) {
      conditions.push("session_id = ?");
      values.push(filter.sessionId);
    }
    if (!filter.includeConsumed) conditions.push("consumed_at IS NULL");
    const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 200)));
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM wand_iteration_prompts${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).all(...values, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapIterationPromptRow).filter((item): item is WandIterationPrompt => item !== null);
  }

  /** 按 id 批量取记录（用户只勾选了一部分历史变更时用）。 */
  listIterationPromptsByIds(ids: readonly string[]): WandIterationPrompt[] {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 500);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT * FROM wand_iteration_prompts WHERE id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
    ).all(...unique) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapIterationPromptRow).filter((item): item is WandIterationPrompt => item !== null);
  }

  /** 标记这些记录已被某次提交用掉，下一轮「上次提交以来」从这里开始。 */
  markIterationPromptsConsumed(ids: readonly string[], commit: string): number {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return 0;
    const placeholders = unique.map(() => "?").join(", ");
    const result = this.db.prepare(
      `UPDATE wand_iteration_prompts SET consumed_at = ?, consumed_commit = ? WHERE id IN (${placeholders})`,
    ).run(nowIso(), commit, ...unique);
    return Number(result.changes) || 0;
  }

  /** Live membership has a single owner: command_sessions.workspace_task_id. */
  getWandTaskIdForSession(sessionId: string): string | null {
    const binding = this.s.getSessionWorkspace(sessionId);
    if (binding?.workspaceTaskId) return this.getWandTaskByWorkspaceTaskId(binding.workspaceTaskId)?.id ?? null;
    const row = this.db.prepare(`SELECT links.task_id FROM wand_task_sessions links
      JOIN wand_tasks card ON card.id = links.task_id
      WHERE links.session_id = ? AND card.workspace_task_id IS NULL AND card.status = 'archived'
      ORDER BY links.rowid DESC LIMIT 1`).get(sessionId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  private legacyWandTaskSessionIds(taskId: string): string[] {
    const rows = this.db.prepare(`SELECT session_id FROM wand_task_sessions
      WHERE task_id = ? ORDER BY rowid ASC, session_id ASC`).all(taskId) as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  listWandTaskSessionIds(taskId: string): string[] {
    const task = this.getWandTask(taskId);
    if (!task) return [];
    if (!task.workspaceTaskId) return task.status === "archived" ? this.legacyWandTaskSessionIds(taskId) : [];
    // Binding timestamps are ordering metadata only; stale membership cannot leak into this.s projection.
    const rows = this.db.prepare(`SELECT s.id FROM command_sessions s
      LEFT JOIN wand_task_sessions links ON links.session_id = s.id AND links.task_id = ?
      WHERE s.workspace_task_id = ? ORDER BY COALESCE(links.bound_at, s.started_at), s.rowid`)
      .all(task.id, task.workspaceTaskId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  listBoundWandTaskSessionIds(): string[] {
    const rows = this.db.prepare(`SELECT s.id FROM command_sessions s
      WHERE EXISTS (SELECT 1 FROM wand_tasks card WHERE card.workspace_task_id = s.workspace_task_id)
      ORDER BY s.rowid`).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  bindWandTaskSession(taskId: string, sessionId: string): void {
    const task = this.getWandTask(taskId);
    if (!task?.workspaceTaskId) throw new Error("未找到该任务。");
    this.moveSessionToWorkspaceTask(sessionId, task.workspaceTaskId);
  }

  unbindWandTaskSession(taskId: string, sessionId: string): void {
    if (this.getWandTaskIdForSession(sessionId) === taskId) this.moveSessionToWorkspaceTask(sessionId, null);
    else this.db.prepare("DELETE FROM wand_task_sessions WHERE task_id = ? AND session_id = ?").run(taskId, sessionId);
  }

  /** Atomic exclusive ownership change; cwd, output and execution are untouched. */
  moveSessionToWorkspaceTask(sessionId: string, taskId: string | null): void {
    if (taskId && isSystemAiCall(this.s.getSessionSlim(sessionId))) throw new Error("系统调用记录不能绑定到业务任务。");
    this.s.notifyTaskTitleChange();
    this.s.transaction(() => {
      const session = this.s.getSessionWorkspace(sessionId);
      if (!session) throw new Error("未找到该会话。");
      const target = taskId ? this.s.getWorkspaceTask(taskId) : null;
      if (taskId && !target) throw new Error("未找到目标任务。");
      if (target && !this.s.getWorkspace(target.workspaceId)) throw new Error("目标工作区不存在。");
      const source = session.workspaceTaskId ? this.s.getWorkspaceTask(session.workspaceTaskId) : null;
      if (source && source.id !== target?.id && source.layout) {
        const windows = source.layout.windows.map((window) => {
          const layout = withoutSessionTab(window.layout, sessionId);
          return { ...window, layout, activeTabId: firstLayoutTabId(layout) };
        });
        this.s.saveWorkspaceTaskLayout(source.id, { ...source.layout, windows });
      }
      const targetCard = target ? this.getWandTaskByWorkspaceTaskId(target.id) : null;
      if (target && !targetCard) throw new Error("未找到目标任务。");
      this.db.prepare("DELETE FROM wand_task_sessions WHERE session_id = ? AND (? IS NULL OR task_id != ?)")
        .run(sessionId, targetCard?.id ?? null, targetCard?.id ?? null);
      this.db.prepare("UPDATE command_sessions SET workspace_task_id = ?, workspace_id = ? WHERE id = ?")
        .run(target?.id ?? null, target?.workspaceId ?? session.workspaceId ?? null, sessionId);
      if (target) {
        this.db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)")
          .run(targetCard!.id, sessionId, nowIso());
        if (source?.id !== target.id) this.recordTaskSession(this.s.getSessionSlim(sessionId)!);
      }
    });
  }

  /** Metadata promotion happens on session creation/move, never on reads or checkpoints. */
  recordTaskSession(session: SessionSnapshot, newlyAssigned = true): void {
    if (!session.workspaceTaskId) return;
    this.s.notifyTaskTitleChange();
    const card = this.getWandTaskByWorkspaceTaskId(session.workspaceTaskId);
    if (!card) return;
    this.db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)")
      .run(card.id, session.id, nowIso());
    const provider = session.provider;
    const agent: WandTaskAgent | null = isSessionProvider(provider) ? {
      provider,
      ...(session.structuredState?.engine === "core" ? { engine: "sdk" as const } : session.sessionKind === "pty" || session.structuredState?.engine === "cli" ? { engine: "cli" as const } : {}),
      model: session.selectedModel || session.structuredState?.model || "default",
      thinkingEffort: isThinkingEffort(session.thinkingEffort) ? session.thinkingEffort : "off",
      mode: normalizeWandTaskAgentMode(provider, session.mode),
      kind: session.sessionKind === "structured" ? "structured" : "pty",
    } : null;
    this.db.prepare(`UPDATE wand_tasks SET agent_json = COALESCE(agent_json, ?),
      status = CASE WHEN status IN ('todo', 'backlog') AND ? THEN 'doing' ELSE status END,
      updated_at = ? WHERE id = ?`)
      .run(agent ? JSON.stringify(agent) : null, newlyAssigned ? 1 : 0, nowIso(), card.id);
  }

  /** Every session bound to a card (board membership, then sidebar container), slim. One id query + one batch read. */
  listWandTaskSessionsSlim(taskId: string): SessionSnapshot[] {
    return this.s.getSessionsSlimByIds(this.listWandTaskSessionIds(taskId));
  }
}
