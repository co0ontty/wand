import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isUnnamedWorkspaceTaskName } from "../wand-task-sync.js";
import { isSessionProvider } from "../session-provider.js";
import { isThinkingEffort } from "../structured-provider-common.js";
import { DEFAULT_WAND_TASK_PRIORITY, normalizeWandTaskAgentMode, type WandTaskAgent } from "../task-types.js";
import { GLOBAL_WORKSPACE_ID, type SessionSnapshot } from "../types.js";
import { mapSessionCore, parseWandTaskAgent, sessionSelectFields, type SessionRow } from "./mappers.js";

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
];
