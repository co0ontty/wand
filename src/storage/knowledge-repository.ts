import crypto from "node:crypto";
import { redactSystemAiText } from "../system-ai-redaction.js";
import type { SessionSnapshot } from "../types.js";
import type { ExecutionPromptPart, ExecutionPromptRecord, EmployeeExecutionPrompts } from "../execution-prompt-types.js";
import { formatGlobalKnowledge, isGlobalKnowledgeInstallation, readGlobalKnowledgeSync, syncGlobalKnowledgeFiles } from "../global-knowledge.js";
import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import { isGlobalWorkspace } from "../workspace-binding.js";
import { normalizeEmployeeKnowledge } from "../employee-knowledge-content.js";
import { EMPLOYEE_KNOWLEDGE_MAX_ENTRIES, type EmployeeKnowledgeEntry } from "../employee-knowledge-types.js";
import { GLOBAL_KNOWLEDGE_MAX_BYTES, GLOBAL_KNOWLEDGE_OWNER_ID, KnowledgeError, type KnowledgeAccess, type KnowledgeDocument, type KnowledgeDocumentInput, type KnowledgeLibrary, type KnowledgeScope } from "../knowledge-types.js";

type Row = { id: string; content: string; title: string; folder: string; revision: number; created_at: string; updated_at: string | null };
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const spec = (scope: KnowledgeScope) => scope === "global"
  ? { table: "global_knowledge", owner: "owner_id" }
  : scope === "personal" ? { table: "employee_knowledge", owner: "employee_id" }
  : { table: "project_knowledge", owner: "workspace_id" };

export class KnowledgeRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  recordExecutionPrompt(session: SessionSnapshot, channel: string, parts: ExecutionPromptPart[], env: NodeJS.ProcessEnv = {}): void {
    if (!session.employeeId) return;
    const redact = (value: string): string => {
      let text = value;
      for (const [key, secret] of Object.entries(env)) {
        if (/(?:KEY|TOKEN|PASSWORD|SECRET|AUTH|COOKIE|CREDENTIAL|PROOF)/i.test(key) && secret && secret.length >= 6) text = text.split(secret).join("[已脱敏]");
      }
      return redactSystemAiText(text);
    };
    const record: ExecutionPromptRecord = {
      id: crypto.randomUUID(), employeeId: session.employeeId, sessionId: session.id,
      executedAt: new Date().toISOString(), provider: session.provider ?? "unknown",
      tool: session.sessionKind === "pty" ? "PTY" : session.structuredState?.engine === "core" ? "Wand Agent" : session.runner ?? "CLI",
      model: session.selectedModel || "默认模型（未显式指定）", channel,
      parts: parts.filter(part => part.text.trim()).map(part => ({ source: part.source, text: redact(part.text) })),
    };
    this.db.prepare("INSERT INTO execution_prompts(id, employee_id, record) VALUES (?, ?, ?)").run(record.id, record.employeeId, JSON.stringify(record));
  }

  employeeExecutionPrompts(employeeId: string, before?: number): EmployeeExecutionPrompts {
    this.#owner("personal", employeeId);
    const rows = this.db.prepare("SELECT sequence, record FROM execution_prompts WHERE employee_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 21")
      .all(employeeId, before ?? Number.MAX_SAFE_INTEGER) as unknown as Array<{ sequence: number; record: string }>;
    return { employeeId, currentPrompt: redactSystemAiText(this.s.getSiliconEmployeeDefinition(employeeId)?.prompt ?? ""),
      records: rows.slice(0, 20).map(row => JSON.parse(row.record) as ExecutionPromptRecord),
      nextCursor: rows.length > 20 ? rows[19].sequence : null };
  }

  #owner(scope: KnowledgeScope, ownerId: string): { name: string; readOnly: boolean } {
    if (scope === "global") {
      if (ownerId !== GLOBAL_KNOWLEDGE_OWNER_ID) throw new KnowledgeError("全局知识库归属无效。", 400);
      return { name: "全局知识库", readOnly: false };
    }
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

  knowledgeOwners(): { global: { id: string; name: string }; employees: Array<{ id: string; name: string }>; projects: Array<{ id: string; name: string; readOnly: boolean }> } {
    const projects = this.s.listWorkspaces().filter(workspace => workspace.userAdded && !isGlobalWorkspace(workspace))
      .map(workspace => ({ id: workspace.id, name: workspace.name, readOnly: false }));
    const orphans = this.db.prepare(`SELECT workspace_id, MAX(project_name) AS project_name FROM project_knowledge
      WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id) GROUP BY workspace_id`).all();
    for (const row of orphans) projects.push({ id: String(row.workspace_id), name: `${String(row.project_name)}（已移除项目）`, readOnly: true });
    return { global: { id: GLOBAL_KNOWLEDGE_OWNER_ID, name: "全局知识库" },
      employees: this.s.listSiliconEmployees({ includeArchived: true }).map(employee => ({ id: employee.id, name: employee.name })), projects };
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
    return { scope, ownerId, ownerName: owner.name, readOnly: owner.readOnly, entries, total: rows.length, limit: EMPLOYEE_KNOWLEDGE_MAX_ENTRIES,
      ...(scope === "global" ? { totalBytes: Buffer.byteLength(formatGlobalKnowledge(rows.map(row => this.#project(row, scope, ownerId)))),
        maxTotalBytes: GLOBAL_KNOWLEDGE_MAX_BYTES,
        ...(isGlobalKnowledgeInstallation(this.s.databasePath()) ? { cliSync: this.s.getPreference("pref:globalKnowledgeSync", readGlobalKnowledgeSync()) } : {}) } : {}) };
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

  #checkGlobalBudget(scope: KnowledgeScope, input: Required<KnowledgeDocumentInput>, replacingId = ""): void {
    if (scope !== "global") return;
    const entries = this.readKnowledgeLibrary("global", GLOBAL_KNOWLEDGE_OWNER_ID).entries.filter(entry => entry.id !== replacingId);
    const next = { ...input, title: input.title || input.content.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 100) || "无标题文档",
      folder: input.folder || "未分类", id: replacingId || `gk_${"0".repeat(32)}`, revision: 9999999999 };
    const total = Buffer.byteLength(formatGlobalKnowledge([...entries, next]));
    if (total > GLOBAL_KNOWLEDGE_MAX_BYTES) throw new KnowledgeError("全局约定每轮完整加载，合计最多 24 KB（含标题与目录）。请精简后保存；已有内容不会被截断或删除。");
  }

  syncGlobalKnowledge(): void {
    if (!isGlobalKnowledgeInstallation(this.s.databasePath())) return;
    try {
      // Serialize snapshots and file writes with other CLI processes using the same database.
      this.s.transaction(() => {
        const library = this.readKnowledgeLibrary("global", GLOBAL_KNOWLEDGE_OWNER_ID);
        // Do not create rule files until a global library has been used at least once.
        if (!library.total && !readGlobalKnowledgeSync().length) return;
        const results = syncGlobalKnowledgeFiles(formatGlobalKnowledge(library.entries));
        this.s.setPreference("pref:globalKnowledgeSync", results);
        for (const result of results) if (result.error) console.warn(`[knowledge] ${result.provider}: ${result.error}`);
      });
    } catch (error) {
      const message = (error as Error).message;
      this.s.setPreference("pref:globalKnowledgeSync", [{ provider: "全部 CLI", path: "", error: message }]);
      console.warn(`[knowledge] CLI 同步未完成：${message}`);
    }
  }

  createKnowledgeDocument(scope: KnowledgeScope, ownerId: string, input: KnowledgeDocumentInput, accessToken?: string): { entry: KnowledgeDocument; created: boolean } {
    const values = this.#normalize(input);
    const result = this.s.transaction(() => {
      if (accessToken) this.#requireAccess(accessToken, scope, ownerId);
      const owner = this.#owner(scope, ownerId);
      if (owner.readOnly) throw new KnowledgeError("项目已移除，知识保留供查看和删除，不能新增或编辑。", 409);
      const { table, owner: column } = spec(scope);
      const contentHash = hash(values.content);
      const existing = this.db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? AND content_hash = ?`).get(ownerId, contentHash) as Row | undefined;
      if (existing) return { entry: this.#project(existing, scope, ownerId), created: false };
      const count = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(ownerId)?.count ?? 0);
      if (count >= EMPLOYEE_KNOWLEDGE_MAX_ENTRIES) throw new KnowledgeError("知识库已满，请先删除不需要的文档；不会自动丢弃旧知识。");
      this.#checkGlobalBudget(scope, values);
      const id = `${scope === "global" ? "gk" : scope === "personal" ? "k" : "pk"}_${crypto.randomUUID().replace(/-/g, "")}`;
      const now = new Date().toISOString();
      if (scope === "global") this.db.prepare(`INSERT INTO global_knowledge (id, owner_id, title, folder, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, values.title, values.folder, values.content, contentHash, now, now);
      else if (scope === "personal") this.db.prepare(`INSERT INTO employee_knowledge (id, employee_id, title, folder, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, values.title, values.folder, values.content, contentHash, now, now);
      else this.db.prepare(`INSERT INTO project_knowledge (id, workspace_id, project_name, title, folder, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, owner.name, values.title, values.folder, values.content, contentHash, now, now);
      return { entry: this.getKnowledgeDocument(scope, ownerId, id), created: true };
    });
    if (scope === "global") this.syncGlobalKnowledge();
    return result;
  }

  updateKnowledgeDocument(scope: KnowledgeScope, ownerId: string, id: string, revision: number, input: KnowledgeDocumentInput, accessToken?: string): KnowledgeDocument {
    const values = this.#normalize(input);
    const result = this.s.transaction(() => {
      if (accessToken) this.#requireAccess(accessToken, scope, ownerId);
      const owner = this.#owner(scope, ownerId);
      if (owner.readOnly) throw new KnowledgeError("项目已移除，知识保留供查看和删除，不能新增或编辑。", 409);
      const previous = this.getKnowledgeDocument(scope, ownerId, id);
      if (previous.revision !== revision) throw new KnowledgeError("这篇文档已被修改。请重新读取，保留并核对当前草稿后再保存。", 409);
      const { table, owner: column } = spec(scope);
      const contentHash = hash(values.content);
      const duplicate = this.db.prepare(`SELECT id FROM ${table} WHERE ${column} = ? AND content_hash = ? AND id != ?`).get(ownerId, contentHash, id);
      if (duplicate) throw new KnowledgeError("当前知识库已有相同正文，请核对后保留一篇。");
      this.#checkGlobalBudget(scope, values, id);
      this.db.prepare(`UPDATE ${table} SET title = ?, folder = ?, content = ?, content_hash = ?, updated_at = ?, revision = revision + 1
        WHERE ${column} = ? AND id = ? AND revision = ?`).run(values.title, values.folder, values.content, contentHash, new Date().toISOString(), ownerId, id, revision);
      // An older execution must not recreate the previous fact after the user corrected it.
      this.invalidateKnowledgeNamespace(scope, ownerId);
      return this.getKnowledgeDocument(scope, ownerId, id);
    });
    if (scope === "global") this.syncGlobalKnowledge();
    return result;
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
    if (scope === "global") this.syncGlobalKnowledge();
  }

  /** Legacy DTO/order/search are adapters; this repository owns all document writes. */
  listLegacyEmployeeKnowledge(employeeId: string, query = "", limit = 20): EmployeeKnowledgeEntry[] {
    this.#owner("personal", employeeId);
    const normalizedQuery = query.trim().slice(0, 200).toLowerCase();
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), EMPLOYEE_KNOWLEDGE_MAX_ENTRIES));
    const rows = this.db.prepare(`SELECT * FROM employee_knowledge WHERE employee_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(employeeId, EMPLOYEE_KNOWLEDGE_MAX_ENTRIES) as unknown as Row[];
    return rows.filter(row => row.content.toLowerCase().includes(normalizedQuery)).slice(0, boundedLimit)
      .map(row => ({ id: row.id, employeeId, content: row.content, createdAt: row.created_at, revision: row.revision }));
  }

  #legacyAccess(employeeId: string, accessToken?: string): void {
    this.#owner("personal", employeeId);
    if (accessToken && this.s.resolveEmployeeKnowledgeAccess(accessToken) !== employeeId) {
      throw new KnowledgeError("知识库访问已失效，请等待新的会话执行。", 403);
    }
  }

  #legacyRevision(revision?: number): number {
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
      throw new KnowledgeError("删除必须携带读取时的 revision；请重新读取并核对，不会自动删除新版知识。", 409);
    }
    return revision;
  }

  rememberLegacyEmployeeKnowledge(employeeId: string, content: string, accessToken?: string): EmployeeKnowledgeEntry {
    return this.s.transaction(() => {
      this.#legacyAccess(employeeId, accessToken);
      const { entry } = this.createKnowledgeDocument("personal", employeeId, { content });
      return { id: entry.id, employeeId, content: entry.content, createdAt: entry.createdAt, revision: entry.revision };
    });
  }

  forgetLegacyEmployeeKnowledge(employeeId: string, id: string, accessToken?: string, revision?: number): boolean {
    return this.s.transaction(() => {
      this.#legacyAccess(employeeId, accessToken);
      const expected = this.#legacyRevision(revision);
      const exists = this.db.prepare("SELECT 1 FROM employee_knowledge WHERE employee_id = ? AND id = ?").get(employeeId, id);
      if (!exists) return false;
      this.deleteKnowledgeDocument("personal", employeeId, id, expected);
      return true;
    });
  }

  /** Delete only the explicitly reviewed snapshot; concurrent additions survive. */
  clearLegacyEmployeeKnowledge(employeeId: string, entries?: Array<{ id: string; revision: number }>): void {
    this.s.transaction(() => {
      this.#owner("personal", employeeId);
      if (!Array.isArray(entries) || entries.length > EMPLOYEE_KNOWLEDGE_MAX_ENTRIES) {
        throw new KnowledgeError("清空必须提供已读取的 entries（id/revision）快照；不会盲删当前全部知识。", 409);
      }
      const ids = new Set<string>();
      for (const entry of entries) {
        if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) throw new KnowledgeError("知识快照无效。", 409);
        ids.add(entry.id);
        const expected = this.#legacyRevision(entry.revision);
        if (this.getKnowledgeDocument("personal", employeeId, entry.id).revision !== expected) {
          throw new KnowledgeError("知识快照已变化，请重新读取后确认；未删除任何条目。", 409);
        }
      }
      for (const entry of entries) this.deleteKnowledgeDocument("personal", employeeId, entry.id, entry.revision);
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
    return { sessionId, employeeId, workspaceId };
  }

  issueKnowledgeAccess(sessionId: string, now = Date.now()): string {
    const scope = this.knowledgeSessionScope(sessionId);
    if (!scope) throw new KnowledgeError("当前会话不存在或不允许访问知识库。", 403);
    this.db.prepare("DELETE FROM knowledge_access WHERE expires_at <= ?").run(now);
    const token = crypto.randomBytes(32).toString("base64url");
    this.db.prepare(`INSERT INTO knowledge_access (token_hash, session_id, employee_id, workspace_id, employee_revision, project_revision, global_revision, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(hash(token), sessionId, scope.employeeId, scope.workspaceId,
        this.#namespaceRevision("personal", scope.employeeId), this.#namespaceRevision("project", scope.workspaceId),
        this.#namespaceRevision("global", GLOBAL_KNOWLEDGE_OWNER_ID), now + 6 * 3600_000);
    return token;
  }

  resolveKnowledgeAccess(token: string, now = Date.now()): KnowledgeAccess | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare("SELECT * FROM knowledge_access WHERE token_hash = ? AND expires_at > ?").get(hash(token), now);
    if (!row) return null;
    const current = this.knowledgeSessionScope(String(row.session_id));
    if (!current || current.employeeId !== row.employee_id || current.workspaceId !== row.workspace_id
      || this.#namespaceRevision("personal", current.employeeId) !== row.employee_revision
      || this.#namespaceRevision("project", current.workspaceId) !== row.project_revision
      || this.#namespaceRevision("global", GLOBAL_KNOWLEDGE_OWNER_ID) !== row.global_revision) return null;
    return current;
  }

  revokeKnowledgeAccess(token: string): void { this.db.prepare("DELETE FROM knowledge_access WHERE token_hash = ?").run(hash(token)); }
  revokeSessionKnowledgeAccess(sessionId: string): void { this.db.prepare("DELETE FROM knowledge_access WHERE session_id = ?").run(sessionId); }

  #requireAccess(token: string, scope: KnowledgeScope, ownerId: string): void {
    const access = this.resolveKnowledgeAccess(token);
    if (!access || (scope === "global" ? GLOBAL_KNOWLEDGE_OWNER_ID : scope === "personal" ? access.employeeId : access.workspaceId) !== ownerId) {
      throw new KnowledgeError("知识库归属已变化或访问已失效，请等待新的会话执行。", 403);
    }
  }
}
