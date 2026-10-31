import crypto from "node:crypto";
import { APNS_SCHEMA } from "./apns-repository.js";
import { LIVE_ACTIVITY_SCHEMA } from "./live-activity-repository.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isUnnamedWorkspaceTaskName } from "../wand-task-sync.js";
import { isSessionProvider } from "../session-provider.js";
import { isThinkingEffort } from "../structured-provider-common.js";
import { DEFAULT_WAND_TASK_PRIORITY, normalizeWandTaskAgentMode, type WandTaskAgent } from "../task-types.js";
import { GLOBAL_WORKSPACE_ID, type SessionSnapshot } from "../types.js";
import { mapSessionCore, parseWandTaskAgent, sessionSelectFields, type SessionRow } from "./mappers.js";

/** Additive, idempotent initialization; legacy content and IDs are never rewritten. */
function migrateKnowledgeDocumentsV22(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(employee_knowledge)").all() as Array<{ name: string }>).map(row => row.name));
  for (const [name, definition] of [["title", "TEXT NOT NULL DEFAULT ''"], ["folder", "TEXT NOT NULL DEFAULT ''"], ["revision", "INTEGER NOT NULL DEFAULT 1"], ["updated_at", "TEXT"]]) {
    if (!columns.has(name!)) db.exec(`ALTER TABLE employee_knowledge ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_knowledge (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
      content_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT, UNIQUE(workspace_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_project_knowledge_owner ON project_knowledge(workspace_id);
    CREATE TABLE IF NOT EXISTS knowledge_namespace_versions (
      scope TEXT NOT NULL, owner_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope, owner_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_access (
      token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
      employee_id TEXT, workspace_id TEXT, employee_revision INTEGER NOT NULL,
      project_revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_access_session ON knowledge_access(session_id);
    CREATE TRIGGER IF NOT EXISTS revoke_knowledge_access_on_session_binding
    AFTER UPDATE OF workspace_id, workspace_task_id, session_options, automation_id ON command_sessions
    WHEN OLD.workspace_id IS NOT NEW.workspace_id
      OR OLD.workspace_task_id IS NOT NEW.workspace_task_id
      OR OLD.automation_id IS NOT NEW.automation_id
      OR (CASE WHEN json_valid(OLD.session_options) THEN json_extract(OLD.session_options, '$.employeeId') END)
        IS NOT (CASE WHEN json_valid(NEW.session_options) THEN json_extract(NEW.session_options, '$.employeeId') END)
    BEGIN
      DELETE FROM knowledge_access WHERE session_id = NEW.id;
      DELETE FROM employee_knowledge_access WHERE session_id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS revoke_knowledge_access_on_employee_delete
    AFTER DELETE ON silicon_employees
    BEGIN
      DELETE FROM knowledge_access WHERE employee_id = OLD.id;
    END;
  `);
}

/**
 * Frozen schema migrations. Every body here is SQL or pure helpers only:
 * never call WandStorage / repository methods, because those change with the
 * application while a migration must keep meaning what it meant when it shipped.
 */

export interface StorageMigrationContext {
  /** Directory that holds the database file (used for the scratch workspace). */
  readonly dataDir: string;
}

export interface StorageMigration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync, context: StorageMigrationContext): void;
}

const LEGACY_TASK_RECORDS_KEY = "pref:taskRecordsVersion";

function nowIsoFrozen(): string {
  return new Date().toISOString();
}

function readPreferenceJson(db: DatabaseSync, key: string): unknown {
  const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

function writePreferenceJson(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

/** Raw clone of the global workspace bootstrap: never goes through the repository. */
function ensureGlobalWorkspaceRaw(db: DatabaseSync, dataDir: string): { id: string; kind: string } {
  const existing = db.prepare("SELECT id, kind FROM workspaces WHERE id = ? OR kind = 'global' ORDER BY (id = ?) DESC LIMIT 1")
    .get(GLOBAL_WORKSPACE_ID, GLOBAL_WORKSPACE_ID) as { id: string; kind: string } | undefined;
  if (existing) return existing;
  const scratch = path.join(dataDir, "scratch");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const createdAt = nowIsoFrozen();
  db.prepare(`INSERT INTO workspaces (id, name, cwd, kind, default_provider, layout_json, created_at, last_opened_at)
    VALUES (?, ?, ?, 'global', NULL, NULL, ?, NULL)`).run(GLOBAL_WORKSPACE_ID, "全局任务", scratch, createdAt);
  return { id: GLOBAL_WORKSPACE_ID, kind: "global" };
}

function insertWorkspaceTaskRaw(db: DatabaseSync, input: {
  workspaceId: string; name: string; status: "active" | "done"; milestoneId: string | null; createdAt: string;
}): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO workspace_tasks
    (id, workspace_id, name, worktree_json, layout_json, status, cwd, milestone_id, created_at, last_opened_at)
    VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL)`)
    .run(id, input.workspaceId, input.name, input.status, input.milestoneId, input.createdAt);
  return id;
}

function insertWandTaskRaw(db: DatabaseSync, input: {
  workspaceId: string | null; workspaceTaskId: string; title: string; titleSource: "user" | "auto";
  status: "todo" | "done"; milestoneId: string | null; createdAt: string;
}): void {
  const id = crypto.randomUUID();
  const max = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM wand_tasks WHERE workspace_id IS ? AND status = ?")
    .get(input.workspaceId, input.status) as { value: number };
  const number = db.prepare(`SELECT COALESCE(MAX(CAST(substr(identifier, 6) AS INTEGER)), 0) AS value
    FROM wand_tasks WHERE identifier GLOB 'TASK-[0-9]*'`).get() as { value: number };
  db.prepare(`INSERT INTO wand_tasks (id, identifier, workspace_id, workspace_task_id, parent_task_id, title, title_source,
      auto_title_signature, description, status, priority, labels_json, due_date, milestone_id, sort_order,
      agent_json, execution_subject_json, archived_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, '', ?, ?, '[]', NULL, ?, ?, NULL, NULL, NULL, ?, ?)`)
    .run(id, `TASK-${number.value + 1}`, input.workspaceId, input.workspaceTaskId, input.title, input.titleSource,
      input.status, DEFAULT_WAND_TASK_PRIORITY, input.milestoneId, max.value + 1, input.createdAt, input.createdAt);
}

/** Latest card linked to a container, the same rule the runtime projection uses. */
function latestCardForContainer(db: DatabaseSync, workspaceTaskId: string): { id: string; workspace_id: string | null } | undefined {
  return db.prepare(`SELECT id, workspace_id FROM wand_tasks WHERE workspace_task_id = ?
    ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(workspaceTaskId) as { id: string; workspace_id: string | null } | undefined;
}

function recordTaskSessionRaw(db: DatabaseSync, cardId: string, session: SessionSnapshot, newlyAssigned: boolean): void {
  const now = nowIsoFrozen();
  db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)")
    .run(cardId, session.id, now);
  const provider = session.provider;
  const agent: WandTaskAgent | null = isSessionProvider(provider) ? {
    provider,
    model: session.selectedModel || session.structuredState?.model || "default",
    thinkingEffort: isThinkingEffort(session.thinkingEffort) ? session.thinkingEffort : "off",
    mode: normalizeWandTaskAgentMode(provider, session.mode),
    kind: session.sessionKind === "structured" ? "structured" : "pty",
  } : null;
  db.prepare(`UPDATE wand_tasks SET agent_json = COALESCE(agent_json, ?),
    status = CASE WHEN status = 'todo' AND ? THEN 'doing' ELSE status END,
    updated_at = ? WHERE id = ?`)
    .run(agent ? JSON.stringify(agent) : null, newlyAssigned ? 1 : 0, now, cardId);
}

/**
 * v2: backfill wand task cards for every workspace task and link legacy
 * sessions. Historical databases that already ran the pre-versioned gate
 * (`pref:taskRecordsVersion = 1`) are skipped, exactly as before.
 */
function migrateTaskRecordsV2(db: DatabaseSync, context: StorageMigrationContext): void {
  // Written for older binaries too: they gate on the same key and must keep skipping.
  if (readPreferenceJson(db, LEGACY_TASK_RECORDS_KEY) === 1) return;

  // Phase 1: a card for every container that has none (one scan, no per-row lookup).
  const linkedContainers = new Set(
    (db.prepare("SELECT workspace_task_id FROM wand_tasks WHERE workspace_task_id IS NOT NULL").all() as Array<{ workspace_task_id: string }>)
      .map((row) => row.workspace_task_id),
  );
  const workspaces = db.prepare("SELECT id, kind FROM workspaces ORDER BY created_at DESC, id DESC")
    .all() as Array<{ id: string; kind: string }>;
  for (const workspace of workspaces) {
    const isGlobal = workspace.kind === "global" || workspace.id === GLOBAL_WORKSPACE_ID;
    const containers = db.prepare(`SELECT id, name, status, milestone_id, created_at FROM workspace_tasks
      WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(workspace.id) as Array<{ id: string; name: string; status: string; milestone_id: string | null; created_at: string }>;
    for (const container of containers) {
      if (linkedContainers.has(container.id)) continue;
      insertWandTaskRaw(db, {
        workspaceId: isGlobal ? null : workspace.id,
        workspaceTaskId: container.id,
        title: container.name,
        titleSource: isUnnamedWorkspaceTaskName(container.name) ? "auto" : "user",
        status: container.status === "done" ? "done" : "todo",
        milestoneId: container.milestone_id,
        createdAt: container.created_at,
      });
      linkedContainers.add(container.id);
    }
  }

  // Phase 2: attach orphan cards to containers and link their sessions.
  const cards = db.prepare(`SELECT id, workspace_id, workspace_task_id, title, status, milestone_id, agent_json, created_at
    FROM wand_tasks ORDER BY created_at DESC, rowid DESC`)
    .all() as Array<{
      id: string; workspace_id: string | null; workspace_task_id: string | null; title: string; status: string;
      milestone_id: string | null; agent_json: string | null; created_at: string;
    }>;
  for (const card of cards) {
    const now = nowIsoFrozen();
    let containerId: string | null = card.workspace_task_id;
    if (!containerId && card.status !== "archived") {
      const workspace = card.workspace_id
        ? db.prepare("SELECT id, kind FROM workspaces WHERE id = ?").get(card.workspace_id) as { id: string; kind: string } | undefined
        : ensureGlobalWorkspaceRaw(db, context.dataDir);
      if (!workspace) continue;
      containerId = insertWorkspaceTaskRaw(db, {
        workspaceId: workspace.id,
        name: card.title,
        status: card.status === "done" ? "done" : "active",
        milestoneId: card.milestone_id,
        createdAt: card.created_at,
      });
      db.prepare("UPDATE wand_tasks SET workspace_task_id = ?, archived_at = NULL, updated_at = ? WHERE id = ?")
        .run(containerId, now, card.id);
    }
    if (!containerId) continue;
    const latest = latestCardForContainer(db, containerId);
    if (latest?.id !== card.id) continue;

    // Projected container workspace: the linked card's workspace wins, global maps to GLOBAL_WORKSPACE_ID.
    const container = db.prepare("SELECT id, workspace_id FROM workspace_tasks WHERE id = ?")
      .get(containerId) as { id: string; workspace_id: string } | undefined;
    if (!container) continue;
    const containerWorkspaceId = card.workspace_id ?? GLOBAL_WORKSPACE_ID;
    db.prepare("UPDATE workspace_tasks SET workspace_id = ? WHERE id = ?").run(containerWorkspaceId, container.id);

    const previouslyBound = new Set((db.prepare(`SELECT session_id FROM wand_task_sessions
      WHERE task_id = ? ORDER BY rowid ASC, session_id ASC`).all(card.id) as Array<{ session_id: string }>)
      .map((row) => row.session_id));
    for (const sessionId of previouslyBound) {
      const session = db.prepare("SELECT workspace_task_id FROM command_sessions WHERE id = ?")
        .get(sessionId) as { workspace_task_id: string | null } | undefined;
      if (!session || (session.workspace_task_id && session.workspace_task_id !== container.id)) continue;
      db.prepare("UPDATE command_sessions SET workspace_task_id = ?, workspace_id = ? WHERE id = ?")
        .run(container.id, containerWorkspaceId, sessionId);
    }
    db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE workspace_task_id = ?").run(containerWorkspaceId, container.id);

    const sessions = (db.prepare(`SELECT ${sessionSelectFields(true)} FROM command_sessions
      WHERE workspace_task_id = ? ORDER BY started_at DESC`).all(container.id) as unknown as SessionRow[])
      .map((row) => mapSessionCore(row));
    for (const session of sessions) {
      db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)")
        .run(card.id, session.id, now);
    }
    const agentSession = sessions.find((session) => isSessionProvider(session.provider));
    const newlyAssigned = sessions.some((session) => !previouslyBound.has(session.id));
    if (agentSession && (!parseWandTaskAgent(card.agent_json) || newlyAssigned)) {
      recordTaskSessionRaw(db, card.id, agentSession, newlyAssigned);
    } else if (newlyAssigned && sessions[0]) {
      recordTaskSessionRaw(db, card.id, sessions[0], true);
    }
  }

  // Kept for older binaries that still read the legacy gate.
  writePreferenceJson(db, LEGACY_TASK_RECORDS_KEY, 1);
}

/** v3: bearer tokens become SHA-256 digests in place. Existing logged-in sessions keep working. */
function migrateAuthTokensV3(db: DatabaseSync): void {
  const rows = db.prepare("SELECT token FROM auth_sessions").all() as Array<{ token: string }>;
  const update = db.prepare("UPDATE auth_sessions SET token = ? WHERE token = ?");
  for (const row of rows) {
    const digest = crypto.createHash("sha256").update(row.token, "utf8").digest("hex");
    if (digest !== row.token) update.run(digest, row.token);
  }
}

/**
 * v4: at most one task card per container. The index is created only when the
 * existing rows already satisfy it; otherwise nothing is changed and the count is
 * logged, so the operator can deduplicate deliberately. Runtime write paths must enforce
 * uniqueness while the index is absent. Existing non-unique index stays.
 */
function uniqueCardPerContainerV4(db: DatabaseSync): void {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT workspace_task_id FROM wand_tasks WHERE workspace_task_id IS NOT NULL
    GROUP BY workspace_task_id HAVING COUNT(*) > 1)`).get() as { count: number };
  if (row.count > 0) {
    console.warn(`[wand] ${row.count} workspace task(s) have more than one task card; unique index not created`);
    return;
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uniq_wand_tasks_one_card_per_container ON wand_tasks(workspace_task_id) WHERE workspace_task_id IS NOT NULL");
}

export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  { version: 2, name: "task-records-backfill", up: migrateTaskRecordsV2 },
  { version: 3, name: "auth-token-digests", up: migrateAuthTokensV3 },
  { version: 4, name: "unique-card-per-container", up: uniqueCardPerContainerV4 },
  { version: 5, name: "managed-upload-provenance", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS wand_uploads (
      file_path TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE,
      cwd TEXT NOT NULL, canonical_cwd TEXT NOT NULL, session_id TEXT NOT NULL,
      device INTEGER NOT NULL, inode INTEGER NOT NULL, size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL, created_at INTEGER NOT NULL,
      orphaned_at INTEGER, checked_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_wand_uploads_checked ON wand_uploads(checked_at, created_at);
    CREATE TABLE IF NOT EXISTS wand_upload_references (
      file_path TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(file_path, session_id)
    );
  `) },
  { version: 6, name: "conversation-organization-jobs", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_organization_jobs (
      id TEXT PRIMARY KEY, request_token TEXT NOT NULL UNIQUE, scope_key TEXT NOT NULL,
      status TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_organization_running ON conversation_organization_jobs(status);
    CREATE TABLE IF NOT EXISTS conversation_organization_cache (
      scope_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `) },
  { version: 7, name: "feedback-task-projection", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS wand_task_comments (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author_name TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES wand_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_wand_task_comments_task ON wand_task_comments(task_id, created_at);
    CREATE TABLE IF NOT EXISTS feedback_task_features (
      feature TEXT PRIMARY KEY, task_id TEXT,
      FOREIGN KEY(task_id) REFERENCES wand_tasks(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS feedback_reports (
      report_id TEXT PRIMARY KEY, feature TEXT NOT NULL, task_id TEXT,
      occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, envelope_json TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES wand_tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_reports_task ON feedback_reports(task_id, received_at);
  `) },
  // These objects originally shipped in baseline SQL only. Existing versioned
  // databases skip that baseline, so they need explicit additive upgrade steps.
  { version: 8, name: "employee-im-settings", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS employee_im_settings (
      employee_id TEXT PRIMARY KEY REFERENCES silicon_employees(id) ON DELETE CASCADE,
      config_json TEXT NOT NULL,
      credentials TEXT
    );
  `) },
  // Freeze the expression here instead of importing the evolving runtime helper.
  { version: 9, name: "scheduled-run-claim-indexes", up: db => db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_claimed ON scheduled_task_runs((CASE WHEN json_extract(run_json, '$.claimedAt') GLOB '????-??-??T*' THEN julianday(json_extract(run_json, '$.claimedAt')) ELSE NULL END), id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task_claimed ON scheduled_task_runs(task_id, (CASE WHEN json_extract(run_json, '$.claimedAt') GLOB '????-??-??T*' THEN julianday(json_extract(run_json, '$.claimedAt')) ELSE NULL END), id);
  `) },
  { version: 10, name: "task-delivery-acceptance", up: db => {
    const columns = db.prepare("PRAGMA table_info(wand_tasks)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "acceptance_json")) db.exec("ALTER TABLE wand_tasks ADD COLUMN acceptance_json TEXT");
  } },
  { version: 11, name: "task-comment-dispatch", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS wand_task_comment_dispatches (
      comment_id TEXT PRIMARY KEY REFERENCES wand_task_comments(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES wand_tasks(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, signature TEXT NOT NULL, source_comment_id TEXT,
      employee_id TEXT, employee_name TEXT, instruction TEXT NOT NULL,
      task_version TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT, error TEXT, execution_status TEXT,
      UNIQUE(task_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_comment_dispatch_session ON wand_task_comment_dispatches(session_id);
  `) },
  { version: 12, name: "employee-system-session-limit", up: db => {
    const columns = db.prepare("PRAGMA table_info(silicon_employees)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "system_session_limit")) {
      db.exec("ALTER TABLE silicon_employees ADD COLUMN system_session_limit INTEGER");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_ai_employee_history
      ON command_sessions(json_extract(session_options, '$.employeeId'), started_at DESC)
      WHERE automation_id GLOB 'system-ai:*'`);
  } },
  { version: 13, name: "task-comment-result-anchor", up: db => {
    const columns = db.prepare("PRAGMA table_info(wand_task_comment_dispatches)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "result_start_index")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN result_start_index INTEGER");
    if (!columns.some(column => column.name === "result_end_index")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN result_end_index INTEGER");
    if (!columns.some(column => column.name === "result_request_id")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN result_request_id TEXT");
    if (!columns.some(column => column.name === "result_outcome")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN result_outcome TEXT");
    if (!columns.some(column => column.name === "result_fingerprint")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN result_fingerprint TEXT");
  } },
  { version: 14, name: "task-comment-result-start-fingerprint", up: db => {
    const columns = db.prepare("PRAGMA table_info(wand_task_comment_dispatches)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "result_start_fingerprint")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN result_start_fingerprint TEXT");
  } },
  { version: 15, name: "task-comment-referenced-tasks", up: db => {
    const columns = db.prepare("PRAGMA table_info(wand_task_comment_dispatches)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "referenced_task_ids")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN referenced_task_ids TEXT NOT NULL DEFAULT '[]'");
  } },
  { version: 16, name: "employee-task-concurrency", up: db => {
    const employeeColumns = db.prepare("PRAGMA table_info(silicon_employees)").all() as Array<{ name: string }>;
    if (!employeeColumns.some(column => column.name === "max_concurrent_tasks")) {
      db.exec("ALTER TABLE silicon_employees ADD COLUMN max_concurrent_tasks INTEGER");
    }
    const dispatchColumns = db.prepare("PRAGMA table_info(wand_task_comment_dispatches)").all() as Array<{ name: string }>;
    if (!dispatchColumns.some(column => column.name === "agent_json")) {
      db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN agent_json TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_comment_dispatch_queue ON wand_task_comment_dispatches(state, employee_id)");
  } },
  // 未设置过的员工回填为新的默认并发上限 2；迁移内写死数值，保持当时语义。
  { version: 17, name: "employee-task-concurrency-default", up: db => {
    db.exec("UPDATE silicon_employees SET max_concurrent_tasks = 2 WHERE max_concurrent_tasks IS NULL");
  } },
  { version: 18, name: "pi-cli-parsed-checkpoints", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS pi_cli_checkpoints (
      session_id TEXT PRIMARY KEY,
      checkpoint TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES command_sessions(id) ON DELETE CASCADE
    )
  `) },
  { version: 19, name: "dingtalk-group-mirrors", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS dingtalk_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(kind, id)
    );
    CREATE INDEX IF NOT EXISTS dingtalk_records_kind_updated ON dingtalk_records(kind, updated_at);
    CREATE INDEX IF NOT EXISTS dingtalk_records_state ON dingtalk_records(kind, json_extract(data, '$.state'), id);
    CREATE INDEX IF NOT EXISTS dingtalk_records_delivery ON dingtalk_records(kind, json_extract(data, '$.delivery'), updated_at, id);
    CREATE INDEX IF NOT EXISTS dingtalk_records_binding_delivery ON dingtalk_records(kind, json_extract(data, '$.bindingId'), json_extract(data, '$.delivery'));
  `) },
  { version: 20, name: "apns-device-subscriptions-and-outbox", up: db => db.exec(APNS_SCHEMA) },
  { version: 21, name: "apns-live-activity-updates", up: db => db.exec(LIVE_ACTIVITY_SCHEMA) },
  { version: 22, name: "scoped-knowledge-documents", up: migrateKnowledgeDocumentsV22 },
  { version: 23, name: "task-retention-archive-provenance", up: db => {
    const columns = db.prepare("PRAGMA table_info(wand_tasks)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "retention_archive_version")) {
      // NULL deliberately protects every pre-policy archive, even if it was once accepted.
      db.exec("ALTER TABLE wand_tasks ADD COLUMN retention_archive_version INTEGER");
    }
  } },
  { version: 24, name: "task-two-level-workflow", up: db => {
    const columns = new Set((db.prepare("PRAGMA table_info(wand_tasks)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("verification_json")) db.exec("ALTER TABLE wand_tasks ADD COLUMN verification_json TEXT");
    if (!columns.has("delivery_revision")) db.exec("ALTER TABLE wand_tasks ADD COLUMN delivery_revision INTEGER NOT NULL DEFAULT 0");
    const dispatchColumns = new Set((db.prepare("PRAGMA table_info(wand_task_comment_dispatches)").all() as Array<{ name: string }>).map(column => column.name));
    if (!dispatchColumns.has("purpose")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution'");
    if (!dispatchColumns.has("review_revision")) db.exec("ALTER TABLE wand_task_comment_dispatches ADD COLUMN review_revision INTEGER");
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_workflow_events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES wand_tasks(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, signature TEXT NOT NULL, action TEXT NOT NULL,
        actor_kind TEXT NOT NULL, actor_id TEXT, source_session_id TEXT,
        evidence TEXT NOT NULL, blocker TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL,
        UNIQUE(task_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_workflow_history ON task_workflow_events(task_id, created_at);
      CREATE TABLE IF NOT EXISTS task_workflow_access (
        token_hash TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES wand_tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
        employee_id TEXT, workspace_task_id TEXT NOT NULL, delivery_revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_workflow_access_session ON task_workflow_access(session_id);
      CREATE TRIGGER IF NOT EXISTS revoke_task_workflow_access_on_binding
      AFTER UPDATE OF workspace_id, workspace_task_id, session_options, automation_id ON command_sessions
      WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.workspace_task_id IS NOT NEW.workspace_task_id
        OR OLD.automation_id IS NOT NEW.automation_id
        OR (CASE WHEN json_valid(OLD.session_options) THEN json_extract(OLD.session_options, '$.employeeId') END)
          IS NOT (CASE WHEN json_valid(NEW.session_options) THEN json_extract(NEW.session_options, '$.employeeId') END)
      BEGIN DELETE FROM task_workflow_access WHERE session_id = NEW.id; END;
    `);
  } },
  { version: 25, name: "structured-input-acceptances", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS structured_input_acceptances (
      session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, signature TEXT NOT NULL, receipt_json TEXT NOT NULL,
      PRIMARY KEY(session_id, idempotency_key)
    );
    CREATE TRIGGER IF NOT EXISTS delete_structured_input_acceptances
      AFTER DELETE ON command_sessions BEGIN
        DELETE FROM structured_input_acceptances WHERE session_id = OLD.id;
      END;
  `) },
  { version: 26, name: "global-knowledge", up: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS global_knowledge (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL CHECK(owner_id = 'global'),
      title TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
      content_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT, UNIQUE(owner_id, content_hash)
    )`);
    const columns = db.prepare("PRAGMA table_info(knowledge_access)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "global_revision")) {
      // Existing grants predate global access and must not silently acquire it.
      db.exec("ALTER TABLE knowledge_access ADD COLUMN global_revision INTEGER NOT NULL DEFAULT -1");
    }
  } },
  { version: 27, name: "workspace-session-sections", up: db => db.exec("ALTER TABLE workspace_tasks ADD COLUMN container_kind TEXT NOT NULL DEFAULT 'task'") },
];
