import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../password-manager.js";
import { SESSION_PROVIDERS, inferProviderFromCommand, inferProviderFromRunner, isSessionProvider } from "../session-provider.js";
import type { WandTask, WandTaskTitleSource } from "../task-types.js";
import { GLOBAL_WORKSPACE_ID, LayoutNode, SessionProvider, SessionSnapshot, TaskWindowLayout, Workspace, WorkspaceDefaultProvider, WorkspaceKind, WorkspaceTask, WorkspaceTaskStatus, WorkspaceTaskWorktree } from "../types.js";
import { isUnnamedWorkspaceTaskName } from "../wand-task-sync.js";
import { ensureWorkspaceForCwd } from "../workspace-binding.js";
import { SessionRow, parseWorktreeInfo, sessionSelectFields, WorkspaceRow, mapWorkspaceRow, WorkspaceTaskRow, mapWorkspaceTaskRow, mapSessionCore, sessionRowQuery } from "./mappers.js";
import type { WandStorage } from "../storage.js";
import { WAND_TASK_FIELDS, WORKSPACE_TASK_PROJECTION } from "./internal.js";
import { SYSTEM_AI_CALL_PREFIX } from "../system-ai-call.js";

/** Workspace storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class WorkspaceRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, cwd, kind, default_provider, layout_json, created_at, last_opened_at FROM workspaces ORDER BY created_at DESC, id DESC"
      )
      .all() as unknown as WorkspaceRow[];
    return rows.map(mapWorkspaceRow);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db
      .prepare(
        "SELECT id, name, cwd, kind, default_provider, layout_json, created_at, last_opened_at FROM workspaces WHERE id = ?"
      )
      .get(id) as unknown as WorkspaceRow | undefined;
    return row ? mapWorkspaceRow(row) : null;
  }

  createWorkspace(input: {
    id?: string;
    name: string;
    cwd: string;
    kind?: WorkspaceKind;
    defaultProvider?: WorkspaceDefaultProvider;
  }): Workspace {
    const id = input.id?.trim() || crypto.randomUUID();
    const kind: WorkspaceKind = input.kind === "global" ? "global" : "project";
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, cwd, kind, default_provider, layout_json, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`
      )
      .run(id, input.name, input.cwd, kind, input.defaultProvider ?? null, createdAt);
    return {
      id,
      name: input.name,
      cwd: input.cwd,
      kind,
      defaultProvider: input.defaultProvider,
      layout: null,
      createdAt,
      lastOpenedAt: null,
    };
  }

  ensureGlobalWorkspace(): Workspace {
    const existing = this.getWorkspace(GLOBAL_WORKSPACE_ID)
      ?? this.listWorkspaces().find((workspace) => workspace.kind === "global");
    if (existing) return existing;
    const scratch = path.join(this.s.directory(), "scratch");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    return this.createWorkspace({
      id: GLOBAL_WORKSPACE_ID,
      name: "全局任务",
      cwd: scratch,
      kind: "global",
    });
  }

  updateWorkspace(id: string, patch: {
    name?: string;
    cwd?: string;
    defaultProvider?: WorkspaceDefaultProvider | null;
  }): void {
    const assignments: string[] = [];
    const values: Array<string | null> = [];
    if (patch.name !== undefined) {
      assignments.push("name = ?");
      values.push(patch.name);
    }
    if (patch.cwd !== undefined) {
      assignments.push("cwd = ?");
      values.push(patch.cwd);
    }
    if (patch.defaultProvider !== undefined) {
      assignments.push("default_provider = ?");
      values.push(patch.defaultProvider ?? null);
    }
    if (assignments.length === 0) return;
    this.db.prepare(`UPDATE workspaces SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  saveWorkspaceLayout(id: string, layout: LayoutNode | null): void {
    this.db
      .prepare("UPDATE workspaces SET layout_json = ? WHERE id = ?")
      .run(layout ? JSON.stringify(layout) : null, id);
  }

  touchWorkspace(id: string): void {
    this.db.prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?").run(nowIso(), id);
  }

  deleteWorkspace(id: string, options: { cascade?: boolean } = {}): void {
    this.s.transaction(() => {
      const cards = this.db.prepare(`SELECT ${WAND_TASK_FIELDS} FROM wand_tasks
        WHERE workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
        .all(id) as Array<Record<string, unknown>>;
      if (options.cascade) {
        this.db.prepare(`DELETE FROM command_sessions WHERE workspace_id = ?
          OR workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
          .run(id, id);
      } else {
        this.db.prepare(`UPDATE command_sessions SET workspace_id = NULL, workspace_task_id = NULL
          WHERE workspace_id = ? OR workspace_task_id IN
            (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
          .run(id, id);
      }
      this.db.prepare(`UPDATE wand_tasks SET workspace_task_id = NULL
        WHERE workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
        .run(id);
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      // Direct project removal detaches active cards; their next dispatch still uses the default cwd.
      // Route-level destructive removal archives cards first, so those cards never gain a container.
      for (const row of cards) {
        const card = this.s.mapWandTaskRow(row);
        if (card.status === "archived") continue;
        const global = this.ensureGlobalWorkspace();
        const containerId = this.insertWorkspaceTask({
          workspaceId: global.id, name: card.title, milestoneId: card.milestoneId,
          status: card.status === "done" ? "done" : "active", createdAt: card.createdAt,
        });
        this.s.writeWandTask(this.s.getWandTask(card.id)!, { workspaceTaskId: containerId });
      }
      this.s.forgetWorkspaceGroupOrder(id);
    });
  }

  listSessionsByWorkspace(workspaceId: string): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE workspace_id = ?
         ORDER BY started_at DESC`
      )
      .all(workspaceId) as unknown as SessionRow[];
    return rows.map((row) => this.s.mapSessionRow(row));
  }

  listSessionsByWorkspaceSlim(workspaceId: string): SessionSnapshot[] {
    const rows = this.db.prepare(`SELECT ${sessionSelectFields(true)} FROM command_sessions
      WHERE workspace_id = ? ORDER BY started_at DESC`).all(workspaceId) as unknown as SessionRow[];
    return rows.map(mapSessionCore);
  }

  /** 显式更新某会话的工作空间归属（用于创建时绑定）。 */
  getSessionWorkspace(sessionId: string): Pick<SessionSnapshot, "workspaceId" | "workspaceTaskId"> | null {
    const row = this.db.prepare("SELECT workspace_id, workspace_task_id FROM command_sessions WHERE id = ?")
      .get(sessionId) as { workspace_id: string | null; workspace_task_id: string | null } | undefined;
    return row ? { workspaceId: row.workspace_id ?? undefined, workspaceTaskId: row.workspace_task_id ?? undefined } : null;
  }

  /** 空白独立会话的目录与项目归属一次落库；创建新项目失败也随事务回滚。 */
  updateBlankSessionDirectory(sessionId: string, cwd: string): string {
    return this.s.transaction(() => {
      const session = this.s.getSession(sessionId);
      if (!session || session.workspaceTaskId || session.worktreeEnabled || session.worktree) {
        throw new Error("任务或工作树会话必须保留原运行目录。");
      }
      const workspace = ensureWorkspaceForCwd(this.s, cwd);
      this.db.prepare("UPDATE command_sessions SET cwd = ?, workspace_id = ? WHERE id = ?")
        .run(cwd, workspace.id, sessionId);
      return workspace.id;
    });
  }

  setSessionWorkspaceId(sessionId: string, workspaceId: string | null): void {
    const binding = this.getSessionWorkspace(sessionId);
    const task = binding?.workspaceTaskId ? this.getWorkspaceTask(binding.workspaceTaskId) : null;
    this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE id = ?")
      .run(task?.workspaceId ?? workspaceId, sessionId);
  }

  /** Normal workspace counts exclude archived sessions and sessions in archived tasks. */
  countSessionsByWorkspace(options: { includeArchived?: boolean; excludeSystemAiCalls?: boolean } = {}): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT session.workspace_id AS id, COUNT(*) AS n
         FROM command_sessions session
         WHERE session.workspace_id IS NOT NULL AND session.workspace_id != ''
           AND (? = 1 OR (session.archived = 0 AND COALESCE((
             SELECT status FROM wand_tasks WHERE workspace_task_id = session.workspace_task_id
             ORDER BY updated_at DESC, rowid DESC LIMIT 1
           ), '') <> 'archived'))
           AND (? = 0 OR COALESCE(session.automation_id, '') NOT GLOB ?)
         GROUP BY session.workspace_id`,
      )
      .all(options.includeArchived === true ? 1 : 0, options.excludeSystemAiCalls === true ? 1 : 0, `${SYSTEM_AI_CALL_PREFIX}*`) as unknown as Array<{ id: string; n: number }>;
    return new Map(rows.map((row) => [row.id, Number(row.n) || 0]));
  }

  /** Count user-initiated CLI launches (one per session), including archived sessions. */
  countInteractiveSessionsByProvider(): Record<SessionProvider, number> {
    const counts = Object.fromEntries(
      SESSION_PROVIDERS.map((provider) => [provider, 0]),
    ) as Record<SessionProvider, number>;
    const rows = this.db.prepare(
      `SELECT provider, runner, command, COUNT(*) AS n
       FROM command_sessions
       WHERE session_source = 'interactive'
       GROUP BY provider, runner, command`,
    ).all() as unknown as Array<{
      provider: string | null;
      runner: string | null;
      command: string;
      n: number;
    }>;
    for (const row of rows) {
      const provider = isSessionProvider(row.provider)
        ? row.provider
        : inferProviderFromRunner(row.runner) ?? inferProviderFromCommand(row.command);
      if (provider) counts[provider] += Number(row.n) || 0;
    }
    return counts;
  }

  /** Sessions not yet attached to a project. Omits messages/output. */
  listUnboundSessionBindings(): Array<{
    id: string;
    cwd: string;
    worktree: SessionSnapshot["worktree"];
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, cwd, worktree_info
         FROM command_sessions
         WHERE workspace_id IS NULL OR workspace_id = ''`,
      )
      .all() as unknown as Array<{ id: string; cwd: string; worktree_info: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      cwd: row.cwd,
      worktree: parseWorktreeInfo(row.worktree_info) ?? null,
    }));
  }

  /** Both task DTOs read one set of task metadata; containers own only local layout/worktree. */
  listWorkspaceTasks(workspaceId: string): WorkspaceTask[] {
    const rows = this.db.prepare(
      `SELECT * FROM (${WORKSPACE_TASK_PROJECTION}) WHERE workspace_id = ?
       ORDER BY created_at DESC, _created_order DESC`,
    ).all(workspaceId) as unknown as WorkspaceTaskRow[];
    return rows.map(mapWorkspaceTaskRow);
  }

  listAllWorkspaceTasks(): WorkspaceTask[] {
    const rows = this.db.prepare(`SELECT * FROM (${WORKSPACE_TASK_PROJECTION})
      ORDER BY created_at DESC, _created_order DESC`).all() as unknown as WorkspaceTaskRow[];
    return rows.map(mapWorkspaceTaskRow);
  }

  getWorkspaceTask(id: string): WorkspaceTask | null {
    const row = this.db.prepare(`${WORKSPACE_TASK_PROJECTION} WHERE wt.id = ?`)
      .get(id) as unknown as WorkspaceTaskRow | undefined;
    return row ? mapWorkspaceTaskRow(row) : null;
  }

  insertWorkspaceTask(input: {
    workspaceId: string; name: string; worktree?: WorkspaceTaskWorktree | null;
    cwd?: string | null; status?: WorkspaceTaskStatus; milestoneId?: string | null;
    createdAt?: string;
  }): string {
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO workspace_tasks
      (id, workspace_id, name, worktree_json, layout_json, status, cwd, milestone_id, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`)
      .run(id, input.workspaceId, input.name, input.worktree ? JSON.stringify(input.worktree) : null,
        input.status ?? "active", input.cwd?.trim() || null, input.milestoneId ?? null,
        input.createdAt ?? nowIso());
    return id;
  }

  taskMilestoneForWrite(id: string | null | undefined, workspaceId: string | null): string {
    if (!id) return this.s.ensureDefaultWandMilestone().id;
    const milestone = this.s.getWandMilestone(id);
    if (!milestone) throw new Error("未找到该里程碑。");
    return workspaceId && milestone.workspaceId && milestone.workspaceId !== workspaceId
      ? this.s.ensureDefaultWandMilestone().id : id;
  }

  createWorkspaceTask(input: {
    workspaceId: string; name: string; worktree?: WorkspaceTaskWorktree | null;
    cwd?: string | null; status?: WorkspaceTaskStatus; milestoneId?: string | null;
    board?: { titleSource?: WandTaskTitleSource; description?: string; parentTaskId?: string | null };
  }): WorkspaceTask {
    return this.s.transaction(() => {
      const workspace = this.getWorkspace(input.workspaceId);
      if (!workspace) throw new Error("任务所属工作区不存在。");
      const projectId = workspace.kind === "global" || workspace.id === GLOBAL_WORKSPACE_ID ? null : workspace.id;
      const milestoneId = this.taskMilestoneForWrite(input.milestoneId, projectId);
      const id = this.insertWorkspaceTask({ ...input, milestoneId });
      this.s.insertWandTask({
        ...input.board, workspaceTaskId: id,
        workspaceId: projectId,
        title: input.name,
        titleSource: input.board?.titleSource ?? (isUnnamedWorkspaceTaskName(input.name) ? "auto" : "user"),
        status: input.status === "done" ? "done" : "todo", milestoneId,
      });
      return this.getWorkspaceTask(id)!;
    });
  }

  updateWorkspaceTask(id: string, patch: {
    name?: string; status?: WorkspaceTaskStatus; worktree?: WorkspaceTaskWorktree | null;
    milestoneId?: string | null; workspaceId?: string;
  }): void {
    this.s.transaction(() => {
      const card = this.s.getWandTaskByWorkspaceTaskId(id);
      if (!card) throw new Error("未找到该任务。");
      if (patch.worktree !== undefined) {
        this.db.prepare("UPDATE workspace_tasks SET worktree_json = ? WHERE id = ?")
          .run(patch.worktree ? JSON.stringify(patch.worktree) : null, id);
      }
      this.s.writeWandTask(card, {
        ...(patch.name !== undefined ? { title: patch.name, titleSource: "user" as const } : {}),
        ...(patch.milestoneId !== undefined ? { milestoneId: patch.milestoneId } : {}),
        ...(patch.workspaceId !== undefined ? {
          workspaceId: patch.workspaceId === GLOBAL_WORKSPACE_ID ? null : patch.workspaceId,
        } : {}),
        ...(patch.status !== undefined ? {
          status: patch.status === "done"
            ? card.status === "archived" ? "archived" as const : "done" as const
            : card.status === "backlog" ? "backlog" as const
              : card.status === "todo" ? "todo" as const : "doing" as const,
        } : {}),
      });
    });
  }

  archiveWorkspaceTask(id: string): WandTask | null {
    const card = this.s.getWandTaskByWorkspaceTaskId(id);
    return card ? this.s.updateWandTask(card.id, { status: "archived" }) : null;
  }

  saveWorkspaceTaskLayout(
    id: string,
    layout: TaskWindowLayout | null,
    expectedRevision?: number,
  ): { ok: true; layoutRevision: number } | { ok: false; conflict: true; layoutRevision: number; layout: TaskWindowLayout | null } {
    const current = this.getWorkspaceTask(id);
    if (!current) throw new Error("未找到该任务。");
    const currentRevision = current.layoutRevision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      return { ok: false, conflict: true, layoutRevision: currentRevision, layout: current.layout };
    }
    const nextRevision = currentRevision + 1;
    this.db
      .prepare("UPDATE workspace_tasks SET layout_json = ?, layout_revision = ? WHERE id = ?")
      .run(layout ? JSON.stringify(layout) : null, nextRevision, id);
    return { ok: true, layoutRevision: nextRevision };
  }

  touchWorkspaceTask(id: string): void {
    this.db.prepare("UPDATE workspace_tasks SET last_opened_at = ? WHERE id = ?").run(nowIso(), id);
  }

  deleteWorkspaceTask(id: string, options: { cascade?: boolean } = {}): void {
    this.s.transaction(() => {
      this.db.prepare(`UPDATE wand_tasks SET workspace_task_id = NULL, status = 'archived', updated_at = ?
        WHERE workspace_task_id = ?`).run(nowIso(), id);
      if (options.cascade) {
        this.db.prepare("DELETE FROM command_sessions WHERE workspace_task_id = ?").run(id);
      } else {
        this.db.prepare("UPDATE command_sessions SET workspace_task_id = NULL WHERE workspace_task_id = ?").run(id);
      }
      this.db.prepare("DELETE FROM workspace_tasks WHERE id = ?").run(id);
    });
  }
}
