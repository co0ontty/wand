import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import { isGlobalWorkspace } from "../workspace-binding.js";
import { normalizeEmployeeKnowledge } from "../employee-knowledge-content.js";
import { EMPLOYEE_KNOWLEDGE_MAX_ENTRIES } from "../employee-knowledge-types.js";
import { KnowledgeError, type KnowledgeAccess, type KnowledgeDocument, type KnowledgeDocumentInput, type KnowledgeLibrary, type KnowledgeScope } from "../knowledge-types.js";

type Row = { id: string; content: string; title: string; folder: string; revision: number; created_at: string; updated_at: string | null };
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const spec = (scope: KnowledgeScope) => scope === "personal"
  ? { table: "employee_knowledge", owner: "employee_id" }
  : { table: "project_knowledge", owner: "workspace_id" };

export class KnowledgeRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  #owner(scope: KnowledgeScope, ownerId: string): { name: string; readOnly: boolean } {
    if (scope === "personal") {
      const employee = this.s.getSiliconEmployeeDefinition(ownerId);
      if (!employee) throw new KnowledgeError("员工已删除或不存在，不能改存到其他员工。", 404);
      return { name: employee.name, readOnly: false };
    }
    const workspace = this.s.getWorkspace(ownerId);
    if (workspace && !isGlobalWorkspace(workspace)) return { name: workspace.name, readOnly: false };
    if (!workspace) {
      const orphan = this.db.prepare("SELECT project_name FROM project_knowledge WHERE workspace_id = ? LIMIT 1").get(ownerId);
      if (orphan) return { name: `${String(orphan.project_name)}（已移除项目）`, readOnly: true };
    }
    throw new KnowledgeError("项目不存在，或当前空间不是项目知识库。", 404);
  }

  knowledgeOwners(): { employees: Array<{ id: string; name: string }>; projects: Array<{ id: string; name: string; readOnly: boolean }> } {
    const projects = this.s.listWorkspaces().filter(workspace => !isGlobalWorkspace(workspace))
      .map(workspace => ({ id: workspace.id, name: workspace.name, readOnly: false }));
    const orphans = this.db.prepare(`SELECT workspace_id, MAX(project_name) AS project_name FROM project_knowledge
      WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id) GROUP BY workspace_id`).all();
    for (const row of orphans) projects.push({ id: String(row.workspace_id), name: `${String(row.project_name)}（已移除项目）`, readOnly: true });
    return { employees: this.s.listSiliconEmployees({ includeArchived: true }).map(employee => ({ id: employee.id, name: employee.name })), projects };
  }

  #project(row: Row, scope: KnowledgeScope, ownerId: string): KnowledgeDocument {
    return { id: row.id, scope, ownerId, title: row.title || row.content.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 100) || "无标题文档",
      content: row.content, folder: row.folder || "未分类", revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at };
  }

  readKnowledgeLibrary(scope: KnowledgeScope, ownerId: string, query = "", accessToken?: string): KnowledgeLibrary {
    if (accessToken) this.#requireAccess(accessToken, scope, ownerId);
    const owner = this.#owner(scope, ownerId);
    const { table, owner: column } = spec(scope);
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC LIMIT ?`)
      .all(ownerId, EMPLOYEE_KNOWLEDGE_MAX_ENTRIES) as unknown as Row[];
    const normalizedQuery = query.trim().slice(0, 200).toLocaleLowerCase();
    const entries = rows.map(row => this.#project(row, scope, ownerId))
      .filter(entry => `${entry.title}\n${entry.content}\n${entry.folder}`.toLocaleLowerCase().includes(normalizedQuery));
    return { scope, ownerId, ownerName: owner.name, readOnly: owner.readOnly, entries, total: rows.length, limit: EMPLOYEE_KNOWLEDGE_MAX_ENTRIES };
  }

  getKnowledgeDocument(scope: KnowledgeScope, ownerId: string, id: string, accessToken?: string): KnowledgeDocument {
    if (accessToken) this.#requireAccess(accessToken, scope, ownerId);
    this.#owner(scope, ownerId);
    const { table, owner } = spec(scope);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${owner} = ? AND id = ?`).get(ownerId, id) as Row | undefined;
    if (!row) throw new KnowledgeError("文档不属于当前知识库或已删除。", 404);
    return this.#project(row, scope, ownerId);
  }

  #normalize(input: KnowledgeDocumentInput): Required<KnowledgeDocumentInput> {
    let content: string;
    try { content = normalizeEmployeeKnowledge(input.content); } catch (error) { throw new KnowledgeError((error as Error).message); }
    const title = (input.title ?? "").trim();
    const folder = (input.folder ?? "").trim();
    if (title.length > 100 || folder.length > 100) throw new KnowledgeError("标题和目录名最多 100 个字符。");
    // The same credential guard covers metadata, without imposing the body non-empty rule on optional fields.
    for (const value of [title, folder]) if (value) {
      try { normalizeEmployeeKnowledge(value); } catch (error) { throw new KnowledgeError((error as Error).message); }
    }
    return { content, title, folder };
  }

  createKnowledgeDocument(scope: KnowledgeScope, ownerId: string, input: KnowledgeDocumentInput, accessToken?: string): { entry: KnowledgeDocument; created: boolean } {
    const values = this.#normalize(input);
    return this.s.transaction(() => {
      if (accessToken) this.#requireAccess(accessToken, scope, ownerId);
      const owner = this.#owner(scope, ownerId);
      if (owner.readOnly) throw new KnowledgeError("项目已移除，知识保留供查看和删除，不能新增或编辑。", 409);
      const { table, owner: column } = spec(scope);
      const contentHash = hash(values.content);
      const existing = this.db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? AND content_hash = ?`).get(ownerId, contentHash) as Row | undefined;
      if (existing) return { entry: this.#project(existing, scope, ownerId), created: false };
      const count = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(ownerId)?.count ?? 0);
      if (count >= EMPLOYEE_KNOWLEDGE_MAX_ENTRIES) throw new KnowledgeError("知识库已满，请先删除不需要的文档；不会自动丢弃旧知识。");
      const id = `${scope === "personal" ? "k" : "pk"}_${crypto.randomUUID().replace(/-/g, "")}`;
      const now = new Date().toISOString();
      if (scope === "personal") this.db.prepare(`INSERT INTO employee_knowledge (id, employee_id, title, folder, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, values.title, values.folder, values.content, contentHash, now, now);
      else this.db.prepare(`INSERT INTO project_knowledge (id, workspace_id, project_name, title, folder, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, owner.name, values.title, values.folder, values.content, contentHash, now, now);
      return { entry: this.getKnowledgeDocument(scope, ownerId, id), created: true };
    });
  }

  updateKnowledgeDocument(scope: KnowledgeScope, ownerId: string, id: string, revision: number, input: KnowledgeDocumentInput, accessToken?: string): KnowledgeDocument {
    const values = this.#normalize(input);
    return this.s.transaction(() => {
      if (accessToken) this.#requireAccess(accessToken, scope, ownerId);
      const owner = this.#owner(scope, ownerId);
      if (owner.readOnly) throw new KnowledgeError("项目已移除，知识保留供查看和删除，不能新增或编辑。", 409);
      const previous = this.getKnowledgeDocument(scope, ownerId, id);
      if (previous.revision !== revision) throw new KnowledgeError("这篇文档已被修改。请重新读取，保留并核对当前草稿后再保存。", 409);
      const { table, owner: column } = spec(scope);
      const contentHash = hash(values.content);
      const duplicate = this.db.prepare(`SELECT id FROM ${table} WHERE ${column} = ? AND content_hash = ? AND id != ?`).get(ownerId, contentHash, id);
      if (duplicate) throw new KnowledgeError("当前知识库已有相同正文，请核对后保留一篇。");
      this.db.prepare(`UPDATE ${table} SET title = ?, folder = ?, content = ?, content_hash = ?, updated_at = ?, revision = revision + 1
        WHERE ${column} = ? AND id = ? AND revision = ?`).run(values.title, values.folder, values.content, contentHash, new Date().toISOString(), ownerId, id, revision);
      // An older execution must not recreate the previous fact after the user corrected it.
      this.invalidateKnowledgeNamespace(scope, ownerId);
      return this.getKnowledgeDocument(scope, ownerId, id);
    });
  }

  deleteKnowledgeDocument(scope: KnowledgeScope, ownerId: string, id: string, revision: number, accessToken?: string): void {
    this.s.transaction(() => {
      if (accessToken) this.#requireAccess(accessToken, scope, ownerId);
      const previous = this.getKnowledgeDocument(scope, ownerId, id);
      if (previous.revision !== revision) throw new KnowledgeError("文档已变化，请重新读取后再确认删除。", 409);
      const { table, owner } = spec(scope);
      this.db.prepare(`DELETE FROM ${table} WHERE ${owner} = ? AND id = ?`).run(ownerId, id);
      this.invalidateKnowledgeNamespace(scope, ownerId);
    });
  }

  invalidateKnowledgeNamespace(scope: KnowledgeScope, ownerId: string): void {
    this.db.prepare(`INSERT INTO knowledge_namespace_versions(scope, owner_id, revision) VALUES (?, ?, 1)
      ON CONFLICT(scope, owner_id) DO UPDATE SET revision = revision + 1`).run(scope, ownerId);
    if (scope === "personal") this.db.prepare("DELETE FROM employee_knowledge_access WHERE employee_id = ?").run(ownerId);
  }

  #namespaceRevision(scope: KnowledgeScope, ownerId: string | null): number {
    return ownerId ? Number(this.db.prepare("SELECT revision FROM knowledge_namespace_versions WHERE scope = ? AND owner_id = ?").get(scope, ownerId)?.revision ?? 0) : 0;
  }

  /** Only persisted bindings count; legacy UI identity projections are not authority. */
  knowledgeSessionScope(sessionId: string): KnowledgeAccess | null {
    const session = this.db.prepare(`SELECT automation_id,
      CASE WHEN json_valid(session_options) THEN json_extract(session_options, '$.employeeId') END AS employee_id
      FROM command_sessions WHERE id = ?`).get(sessionId);
    if (!session || (typeof session.automation_id === "string" && session.automation_id.startsWith("dingtalk:"))) return null;
    const employeeId = typeof session.employee_id === "string" && this.s.getSiliconEmployeeDefinition(session.employee_id) ? session.employee_id : null;
    const binding = this.s.getSessionWorkspace(sessionId);
    const task = binding?.workspaceTaskId ? this.s.getWorkspaceTask(binding.workspaceTaskId) : null;
    const workspace = binding?.workspaceId ? this.s.getWorkspace(binding.workspaceId) : null;
    const workspaceId = workspace && !isGlobalWorkspace(workspace) && (!binding?.workspaceTaskId || task?.workspaceId === workspace.id) ? workspace.id : null;
    return employeeId || workspaceId ? { sessionId, employeeId, workspaceId } : null;
  }

  issueKnowledgeAccess(sessionId: string, now = Date.now()): string {
    const scope = this.knowledgeSessionScope(sessionId);
    if (!scope) throw new KnowledgeError("当前会话未绑定可用员工或项目，知识库能力不可用。", 403);
    this.db.prepare("DELETE FROM knowledge_access WHERE expires_at <= ?").run(now);
    const token = crypto.randomBytes(32).toString("base64url");
    this.db.prepare(`INSERT INTO knowledge_access (token_hash, session_id, employee_id, workspace_id, employee_revision, project_revision, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hash(token), sessionId, scope.employeeId, scope.workspaceId,
        this.#namespaceRevision("personal", scope.employeeId), this.#namespaceRevision("project", scope.workspaceId), now + 6 * 3600_000);
    return token;
  }

  resolveKnowledgeAccess(token: string, now = Date.now()): KnowledgeAccess | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare("SELECT * FROM knowledge_access WHERE token_hash = ? AND expires_at > ?").get(hash(token), now);
    if (!row) return null;
    const current = this.knowledgeSessionScope(String(row.session_id));
    if (!current || current.employeeId !== row.employee_id || current.workspaceId !== row.workspace_id
      || this.#namespaceRevision("personal", current.employeeId) !== row.employee_revision
      || this.#namespaceRevision("project", current.workspaceId) !== row.project_revision) return null;
    return current;
  }

  revokeKnowledgeAccess(token: string): void { this.db.prepare("DELETE FROM knowledge_access WHERE token_hash = ?").run(hash(token)); }
  revokeSessionKnowledgeAccess(sessionId: string): void { this.db.prepare("DELETE FROM knowledge_access WHERE session_id = ?").run(sessionId); }

  #requireAccess(token: string, scope: KnowledgeScope, ownerId: string): void {
    const access = this.resolveKnowledgeAccess(token);
    if ((scope === "personal" ? access?.employeeId : access?.workspaceId) !== ownerId) throw new KnowledgeError("知识库归属已变化或访问已失效，请等待新的会话执行。", 403);
  }
}
