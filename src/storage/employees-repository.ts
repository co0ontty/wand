import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SiliconEmployee } from "../ai-team-types.js";
import { DEFAULT_EMPLOYEE_KEY, DEFAULT_MAX_CONCURRENT_TASKS, isBuiltinSiliconEmployee, parseSiliconEmployeeTags, siliconEmployeeTags } from "../ai-team-types.js";
import { decisionExpertDefinition } from "../decision-expert-employee.js";
import { DECISION_EXPERT_KEY } from "../decision-expert-identity.js";
import { defaultEmployeeDefinition } from "../default-employee.js";
import { normalizeEmployeeKnowledge } from "../employee-knowledge-content.js";
import { EMPLOYEE_KNOWLEDGE_MAX_ENTRIES, type EmployeeKnowledgeEntry } from "../employee-knowledge-types.js";
import { FIXED_EMPLOYEE_AVATARS, employeeAvatarValue, fixedEmployeeAvatar, isFixedAvatarEmployee } from "../fixed-employee-avatar.js";
import { HR_EMPLOYEE_KEY } from "../hr-employee-identity.js";
import { hrEmployeeDefinition } from "../hr-employee.js";
import { SYSTEM_EMPLOYEE_KEY, systemEmployeeDefinition, systemEmployeeDefaultAgents, systemEmployeeSeedAgents, type SystemEmployeeSeed } from "../system-employee.js";
import type { WandTaskAgent } from "../task-types.js";
import { SessionProvider } from "../types.js";
import type { WandStorage } from "../storage.js";
import { LOCKED_SYSTEM_EMPLOYEE_DEFINITIONS, mapSiliconEmployeeRow } from "./internal.js";

/** Employee storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class EmployeeRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  listSiliconEmployees(options?: { includeArchived?: boolean }): SiliconEmployee[] {
    const includeArchived = options?.includeArchived ?? false;
    // 内置员工（system_key 非空）始终排在最前，其余按创建时间。
    const sql = includeArchived
      ? "SELECT * FROM silicon_employees ORDER BY (system_key IS NULL), created_at ASC"
      : "SELECT * FROM silicon_employees WHERE archived_at IS NULL ORDER BY (system_key IS NULL), created_at ASC";
    const rows = this.db.prepare(sql).all() as unknown as Record<string, unknown>[];
    return rows.map((row) => this.projectDefaultEmployee(mapSiliconEmployeeRow(row)));
  }

  private projectDefaultEmployee(employee: SiliconEmployee): SiliconEmployee {
    // Presentation only: legacy columns stay untouched until an explicit migration.
    employee = { ...employee, avatar: employeeAvatarValue(employee) };
    if (employee.systemKey !== DEFAULT_EMPLOYEE_KEY) return employee;
    const state = this.s.getUserMemoryState();
    return defaultEmployeeDefinition(employee.agents, employee.updatedAt, employee,
      state.enabled ? state.profile : null);
  }

  /** Saved definition without generated short-term preferences. */
  getSiliconEmployeeDefinition(id: string): SiliconEmployee | null {
    const row = this.db.prepare("SELECT * FROM silicon_employees WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapSiliconEmployeeRow(row) : null;
  }

  getSiliconEmployee(id: string): SiliconEmployee | null {
    const employee = this.getSiliconEmployeeDefinition(id);
    return employee ? this.projectDefaultEmployee(employee) : null;
  }

  getDefaultSiliconEmployee(): SiliconEmployee | null {
    const employee = this.getSystemSiliconEmployee(DEFAULT_EMPLOYEE_KEY);
    return employee ? this.projectDefaultEmployee(employee) : null;
  }

  /** Seed once, preserve execution choices, and never reset learned preferences on restart. */
  ensureDefaultSiliconEmployee(provider?: SessionProvider): SiliconEmployee {
    const existing = this.getSystemSiliconEmployee(DEFAULT_EMPLOYEE_KEY);
    if (existing) return this.projectDefaultEmployee(existing);
    const definition = defaultEmployeeDefinition(systemEmployeeSeedAgents({ provider }), new Date().toISOString());
    this.saveSiliconEmployee(definition);
    return this.projectDefaultEmployee(definition);
  }

  /** 内置「系统运维」员工；未创建（或被删除过）时返回 null。 */
  getSystemSiliconEmployee(key: string = SYSTEM_EMPLOYEE_KEY): SiliconEmployee | null {
    const row = this.db.prepare("SELECT * FROM silicon_employees WHERE system_key = ?").get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    const employee = mapSiliconEmployeeRow(row);
    return { ...employee, avatar: employeeAvatarValue(employee) };
  }

  /** Seed only when missing; restart never overwrites user profile, candidates, or legacy avatars. */
  ensureSystemSiliconEmployee(seed: SystemEmployeeSeed = {}): SiliconEmployee {
    const existing = this.getSystemSiliconEmployee();
    if (existing) return existing;
    const employee = systemEmployeeDefinition(systemEmployeeDefaultAgents(seed), new Date().toISOString());
    this.saveSiliconEmployee(employee);
    return employee;
  }

  /** Stable built-in decision employee; seed once and retain the user's ordered call chain. */
  ensureDecisionExpertEmployee(): SiliconEmployee {
    const existing = this.getSystemSiliconEmployee(DECISION_EXPERT_KEY);
    const definition = decisionExpertDefinition(new Date().toISOString(), existing);
    if (!existing || existing.name !== definition.name || existing.duty !== definition.duty || existing.prompt !== definition.prompt
      || existing.avatar !== definition.avatar || existing.archivedAt || !existing.agents.length) {
      this.saveSiliconEmployee(definition);
      return definition;
    }
    return existing;
  }

  /** The speech polisher built-in was removed; archive (never delete) a leftover row so history stays readable. */
  retireLegacySpeechPolisherEmployee(): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE silicon_employees SET archived_at = ?, updated_at = ? WHERE system_key = 'wand-speech-polisher' AND archived_at IS NULL").run(now, now);
  }

  /** HR owns recruitment independently; seed from configured system candidates once. */
  ensureHrEmployee(seedAgents?: WandTaskAgent[]): SiliconEmployee {
    const existing = this.getSystemSiliconEmployee(HR_EMPLOYEE_KEY);
    const definition = hrEmployeeDefinition(new Date().toISOString(), existing, seedAgents);
    if (!existing || existing.name !== definition.name || existing.duty !== definition.duty || existing.prompt !== definition.prompt
      || existing.avatar !== definition.avatar || existing.archivedAt || !existing.agents.length) {
      this.saveSiliconEmployee(definition);
      return definition;
    }
    return existing;
  }

  saveSiliconEmployee(employee: SiliconEmployee): void {
    const existing = this.getSiliconEmployeeDefinition(employee.id);
    const locked = LOCKED_SYSTEM_EMPLOYEE_DEFINITIONS.find((definition) => definition.id === employee.id || definition.systemKey === employee.systemKey);
    if (locked) {
      if (employee.id !== locked.id || employee.systemKey !== locked.systemKey) throw new Error("内置员工身份不可修改或冒用。");
      if (existing && existing.systemKey !== locked.systemKey) throw new Error("内置员工身份冲突，不能覆盖已有记录。");
      for (const field of ["name", "duty", "prompt", "avatar", "tags"] as const) {
        if (JSON.stringify(employee[field]) !== JSON.stringify(locked[field])) throw new Error("该员工是内置的，基础资料不可修改。");
      }
      if (employee.archivedAt !== undefined) throw new Error("内置员工不可归档。");
    }
    const target = FIXED_EMPLOYEE_AVATARS.find((entry) => entry.id === employee.id || entry.systemKey === employee.systemKey);
    if (target) {
      if (employee.id !== target.id || employee.systemKey !== target.systemKey) throw new Error("内置员工身份不可修改或冒用。");
      if (existing && !isFixedAvatarEmployee(existing)) throw new Error("内置员工身份冲突，不能覆盖已有记录。");
      if (employee.avatar !== (existing?.avatar ?? target.avatar) && employee.avatar !== employeeAvatarValue(employee)) {
        throw new Error("该员工是内置的，头像不可修改。");
      }
      if (existing && JSON.stringify(employee.tags) !== JSON.stringify(existing.tags)) throw new Error("该员工是内置的，标签不可修改。");
      if (employee.archivedAt !== existing?.archivedAt) throw new Error("内置员工不可归档。");
    }
    const tags = isBuiltinSiliconEmployee(employee)
      ? siliconEmployeeTags(employee)
      : parseSiliconEmployeeTags(employee.tags ?? []);
    const systemSessionLimit = employee.systemSessionLimit === undefined ? existing?.systemSessionLimit ?? null : employee.systemSessionLimit;
    if (systemSessionLimit !== null && (!Number.isInteger(systemSessionLimit) || systemSessionLimit < 0 || systemSessionLimit > 10_000)) {
      throw new Error("系统调用历史保留上限必须是 0 到 10000 的整数，或 null（不限）。");
    }
    const maxConcurrentTasks = employee.maxConcurrentTasks ?? existing?.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 100) {
      throw new Error("并发任务上限必须是 1 到 100 的整数。");
    }
    this.db.prepare(
      `INSERT INTO silicon_employees (
         id, name, duty, prompt, avatar, agents_json, system_key, archived_at, created_at, updated_at, tags_json, system_session_limit, max_concurrent_tasks
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         duty = excluded.duty,
         prompt = excluded.prompt,
         avatar = excluded.avatar,
         agents_json = excluded.agents_json,
         tags_json = excluded.tags_json,
         system_session_limit = excluded.system_session_limit,
         max_concurrent_tasks = excluded.max_concurrent_tasks,
         system_key = excluded.system_key,
         archived_at = excluded.archived_at,
         updated_at = excluded.updated_at`
    ).run(
      employee.id,
      employee.name,
      employee.duty,
      employee.prompt,
      // Accept a canonical read echo without persisting a display projection over a legacy value.
      target && existing ? existing.avatar : employee.avatar,
      JSON.stringify(employee.agents),
      employee.systemKey ?? null,
      employee.archivedAt ?? null,
      employee.createdAt,
      employee.updatedAt,
      JSON.stringify(tags),
      systemSessionLimit,
      maxConcurrentTasks,
    );
  }

  /** Explicit, atomic migration; not called from GET, config load, seeds, or ordinary saves.
   * Compare all expected avatar values first; change only avatar, including preserving timestamps.
   */
  migrateFixedEmployeeAvatars(expected: ReadonlyArray<{ id: string; systemKey: string; avatar: string }>): number {
    return this.s.transaction(() => {
      if (expected.length !== FIXED_EMPLOYEE_AVATARS.length || new Set(expected.map((entry) => entry.id)).size !== expected.length) {
        throw new Error("固定头像迁移需要两个精确且不同的目标。");
      }
      const rows = FIXED_EMPLOYEE_AVATARS.map((target) => {
        const prior = expected.find((entry) => entry.id === target.id && entry.systemKey === target.systemKey);
        const employee = this.getSiliconEmployeeDefinition(target.id);
        if (!prior || !employee || fixedEmployeeAvatar(employee) !== target.avatar) throw new Error("固定头像迁移目标不存在或身份冲突。");
        if (employee.avatar !== prior.avatar && employee.avatar !== target.avatar) throw new Error("固定头像迁移检测到头像已变化，请重新核对。");
        return { target, employee };
      });
      let changed = 0;
      for (const { target, employee } of rows) {
        if (employee.avatar === target.avatar) continue;
        changed += Number(this.db.prepare("UPDATE silicon_employees SET avatar = ? WHERE id = ? AND system_key = ? AND avatar = ?")
          .run(target.avatar, target.id, target.systemKey, employee.avatar).changes);
      }
      return changed;
    });
  }

  archiveSiliconEmployee(id: string, archivedAt = new Date().toISOString()): void {
    if (isBuiltinSiliconEmployee(this.getSiliconEmployeeDefinition(id))) throw new Error("内置员工不可归档。");
    this.s.transaction(() => {
      this.db.prepare("UPDATE silicon_employees SET archived_at = ?, updated_at = ? WHERE id = ?").run(
        archivedAt,
        new Date().toISOString(),
        id,
      );
      this.db.prepare(`UPDATE wand_task_comment_dispatches SET state = 'failed', error = '员工已归档或删除，排队执行已取消。'
        WHERE employee_id = ? AND state = 'queued'`).run(id);
    });
  }

  unarchiveSiliconEmployee(id: string): void {
    if (isBuiltinSiliconEmployee(this.getSiliconEmployeeDefinition(id))) throw new Error("内置员工不能恢复归档。");
    this.db.prepare("UPDATE silicon_employees SET archived_at = NULL, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
  }

  deleteSiliconEmployee(id: string): void {
    if (isBuiltinSiliconEmployee(this.getSiliconEmployeeDefinition(id))) throw new Error("内置员工不可删除。");
    this.s.transaction(() => {
      this.db.prepare(`UPDATE wand_task_comment_dispatches SET state = 'failed', error = '员工已归档或删除，排队执行已取消。'
        WHERE employee_id = ? AND state = 'queued'`).run(id);
      this.db.prepare("DELETE FROM silicon_employees WHERE id = ?").run(id);
    });
  }

  private requireKnowledgeEmployee(employeeId: string): void {
    if (!this.db.prepare("SELECT id FROM silicon_employees WHERE id = ?").get(employeeId)) {
      throw new Error("员工已删除或不存在，不能改存到其他员工的知识库。");
    }
  }

  listEmployeeKnowledge(employeeId: string, query = "", limit = 20): EmployeeKnowledgeEntry[] {
    this.requireKnowledgeEmployee(employeeId);
    const normalizedQuery = query.trim().slice(0, 200).toLowerCase();
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), EMPLOYEE_KNOWLEDGE_MAX_ENTRIES));
    // SQLite lower() is ASCII-only. Load at most this.s employee's fixed quota,
    // perform Unicode case folding, and apply the result limit after filtering.
    const rows = this.db.prepare(`SELECT id, employee_id, content, created_at FROM employee_knowledge
      WHERE employee_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(employeeId, EMPLOYEE_KNOWLEDGE_MAX_ENTRIES) as
      Array<{ id: string; employee_id: string; content: string; created_at: string }>;
    return rows.filter((row) => row.content.toLowerCase().includes(normalizedQuery))
      .slice(0, boundedLimit).map((row) => ({
        id: row.id, employeeId: row.employee_id, content: row.content, createdAt: row.created_at,
      }));
  }

  countEmployeeKnowledge(employeeId: string): number {
    this.requireKnowledgeEmployee(employeeId);
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM employee_knowledge WHERE employee_id = ?")
      .get(employeeId)?.count ?? 0);
  }

  rememberEmployeeKnowledge(employeeId: string, value: string, accessToken?: string): EmployeeKnowledgeEntry {
    const content = normalizeEmployeeKnowledge(value);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return this.s.transaction(() => {
      this.requireKnowledgeEmployee(employeeId);
      if (accessToken && this.resolveEmployeeKnowledgeAccess(accessToken) !== employeeId) {
        throw new Error("知识库访问已失效，请等待新的会话执行。");
      }
      const existing = this.db.prepare("SELECT id, content, created_at FROM employee_knowledge WHERE employee_id = ? AND content_hash = ?")
        .get(employeeId, hash);
      if (existing) return { id: String(existing.id), employeeId,
        content: String(existing.content), createdAt: String(existing.created_at) };
      if (this.countEmployeeKnowledge(employeeId) >= EMPLOYEE_KNOWLEDGE_MAX_ENTRIES) {
        throw new Error("该员工知识库已满，请先删除不需要的内容，不会自动丢弃旧知识。");
      }
      const entry = { id: `k_${crypto.randomUUID().replace(/-/g, "")}`, employeeId,
        content, createdAt: new Date().toISOString() };
      this.db.prepare(`INSERT INTO employee_knowledge (id, employee_id, content, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(entry.id, employeeId, content, hash, entry.createdAt);
      return entry;
    });
  }

  forgetEmployeeKnowledge(employeeId: string, entryId: string, accessToken?: string): boolean {
    return this.s.transaction(() => {
      this.requireKnowledgeEmployee(employeeId);
      if (accessToken && this.resolveEmployeeKnowledgeAccess(accessToken) !== employeeId) {
        throw new Error("知识库访问已失效，请等待新的会话执行。");
      }
      return this.db.prepare("DELETE FROM employee_knowledge WHERE employee_id = ? AND id = ?")
        .run(employeeId, entryId).changes === 1;
    });
  }

  clearEmployeeKnowledge(employeeId: string): void {
    this.s.transaction(() => {
      this.requireKnowledgeEmployee(employeeId);
      this.db.prepare("DELETE FROM employee_knowledge WHERE employee_id = ?").run(employeeId);
      this.db.prepare("DELETE FROM employee_knowledge_access WHERE employee_id = ?").run(employeeId);
    });
  }

  /** Opaque per-execution capability: no employee selector, app token or DB secret in model prompts. */
  issueEmployeeKnowledgeAccess(sessionId: string, employeeId: string, now = Date.now()): string {
    this.requireKnowledgeEmployee(employeeId);
    const row = this.s.getSessionSlim(sessionId);
    if (!row || row.employeeId !== employeeId) throw new Error("知识库归属与会话员工不一致。");
    this.db.prepare("DELETE FROM employee_knowledge_access WHERE expires_at <= ?").run(now);
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    this.db.prepare(`INSERT INTO employee_knowledge_access (token_hash, employee_id, session_id, expires_at)
      VALUES (?, ?, ?, ?)`).run(hash, employeeId, sessionId, now + 6 * 60 * 60 * 1000);
    return token;
  }

  resolveEmployeeKnowledgeAccess(token: string, now = Date.now()): string | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const row = this.db.prepare(`SELECT a.employee_id FROM employee_knowledge_access a
      JOIN command_sessions s ON s.id = a.session_id JOIN silicon_employees e ON e.id = a.employee_id
      WHERE a.token_hash = ? AND a.expires_at > ? AND json_extract(s.session_options, '$.employeeId') = a.employee_id`)
      .get(hash, now);
    return typeof row?.employee_id === "string" ? row.employee_id : null;
  }

  revokeEmployeeKnowledgeAccess(token: string): void {
    this.db.prepare("DELETE FROM employee_knowledge_access WHERE token_hash = ?")
      .run(crypto.createHash("sha256").update(token).digest("hex"));
  }

  /** Inference-only capability; never accepted by general HTTP authentication. */
  issueDecisionAccess(sessionId: string, now = Date.now()): string {
    if (!this.s.getSessionSlim(sessionId)) throw new Error("决策调用所属会话不存在。");
    this.db.prepare("DELETE FROM decision_access WHERE expires_at <= ? OR session_id = ?").run(now, sessionId);
    const token = `wd_${crypto.randomBytes(32).toString("base64url")}`;
    this.db.prepare("INSERT INTO decision_access (token_hash, session_id, expires_at) VALUES (?, ?, ?)")
      .run(crypto.createHash("sha256").update(token).digest("hex"), sessionId, now + 6 * 60 * 60 * 1000);
    return token;
  }

  resolveDecisionAccess(token: string, now = Date.now()): string | null {
    if (!/^wd_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare("SELECT session_id FROM decision_access WHERE token_hash = ? AND expires_at > ?")
      .get(crypto.createHash("sha256").update(token).digest("hex"), now);
    return typeof row?.session_id === "string" ? row.session_id : null;
  }

  revokeDecisionAccess(token: string): void {
    this.db.prepare("DELETE FROM decision_access WHERE token_hash = ?")
      .run(crypto.createHash("sha256").update(token).digest("hex"));
  }

  /** CLI-only free inference scope, durable across Server restarts but not reusable by another run. */
  issueOpenRouterFreeAccess(sessionId: string, selector: string, credentialHash: string,
    requirements: { preferReasoning?: boolean; allowedSelectors?: readonly string[] }, now = Date.now()): string {
    const session = this.s.getSessionSlim(sessionId);
    if (session?.provider !== "pi" || session.sessionKind !== "structured"
      || !selector.startsWith("wand-openrouter-free/") || !/^[a-f0-9]{64}$/.test(credentialHash)) {
      throw new Error("免费模型调用所属会话或凭据无效。");
    }
    this.db.prepare("DELETE FROM openrouter_free_access WHERE expires_at <= ? OR session_id = ?").run(now, sessionId);
    const token = `wf_${crypto.randomBytes(32).toString("base64url")}`;
    this.db.prepare(`INSERT INTO openrouter_free_access
      (token_hash, session_id, selector, requirements_json, credential_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(crypto.createHash("sha256").update(token).digest("hex"), sessionId, selector,
        JSON.stringify(requirements), credentialHash, now + 6 * 60 * 60 * 1000);
    return token;
  }

  revokeOpenRouterFreeAccess(token: string): void {
    this.db.prepare("DELETE FROM openrouter_free_access WHERE token_hash = ?")
      .run(crypto.createHash("sha256").update(token).digest("hex"));
  }
}
