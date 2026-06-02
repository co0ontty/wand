import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
function safeJsonParse(raw) {
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function parseQueuedMessages(raw) {
    const parsed = safeJsonParse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : undefined;
}
function inferSessionProvider(row) {
    if (row.provider === "claude" || row.provider === "codex") {
        return row.provider;
    }
    if (row.runner === "claude-cli" || row.runner === "claude-cli-print") {
        return "claude";
    }
    return /^claude\b/.test(row.command.trim()) ? "claude" : undefined;
}
function parseWorktreeInfo(raw) {
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed.branch === "string" && typeof parsed.path === "string") {
        return { branch: parsed.branch, path: parsed.path };
    }
    return undefined;
}
function parseWorktreeMergeInfo(raw) {
    return safeJsonParse(raw);
}
function serializeWorktreeMergeInfo(info) {
    return info ? JSON.stringify(info) : null;
}
function serializeWorktreeInfo(info) {
    return info ? JSON.stringify(info) : null;
}
function normalizeWorktreeMergeStatus(raw) {
    if (raw === "ready" || raw === "checking" || raw === "merging" || raw === "merged" || raw === "failed") {
        return raw;
    }
    return undefined;
}
function mapWorktreeMergeFields(row) {
    return {
        worktreeMergeStatus: normalizeWorktreeMergeStatus(row.worktree_merge_status),
        worktreeMergeInfo: parseWorktreeMergeInfo(row.worktree_merge_info) ?? null,
    };
}
function sessionSelectFields() {
    return `id, provider, session_kind, runner, command, cwd, mode, status, exit_code, started_at, ended_at, output, archived, archived_at, claude_session_id, messages, queued_messages, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info`;
}
function sessionPersistFields() {
    return `id, command, cwd, mode, status, exit_code, started_at, ended_at, output
             , archived, archived_at, claude_session_id, provider, session_kind, runner, messages, queued_messages, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info`;
}
function sessionPersistAssignments() {
    return `command = excluded.command,
             cwd = excluded.cwd,
             mode = excluded.mode,
             status = excluded.status,
             exit_code = excluded.exit_code,
             started_at = excluded.started_at,
             ended_at = excluded.ended_at,
             output = excluded.output,
             archived = excluded.archived,
             archived_at = excluded.archived_at,
             claude_session_id = excluded.claude_session_id,
             provider = excluded.provider,
             session_kind = excluded.session_kind,
             runner = excluded.runner,
             messages = excluded.messages,
             queued_messages = excluded.queued_messages,
             structured_state = excluded.structured_state,
             resumed_from_session_id = excluded.resumed_from_session_id,
             auto_recovered = excluded.auto_recovered,
             worktree_enabled = excluded.worktree_enabled,
             worktree_info = excluded.worktree_info,
             worktree_merge_status = excluded.worktree_merge_status,
             worktree_merge_info = excluded.worktree_merge_info`;
}
function sessionMetadataAssignments() {
    return `command = ?, cwd = ?, mode = ?, status = ?, exit_code = ?,
           started_at = ?, ended_at = ?, output = ?,
           archived = ?, archived_at = ?, claude_session_id = ?,
           provider = ?, session_kind = ?, runner = ?, structured_state = ?,
           resumed_from_session_id = ?, auto_recovered = ?,
           worktree_enabled = ?, worktree_info = ?, worktree_merge_status = ?, worktree_merge_info = ?`;
}
function sessionPersistValues(snapshot) {
    return [
        snapshot.id,
        snapshot.command,
        snapshot.cwd,
        snapshot.mode,
        snapshot.status,
        snapshot.exitCode,
        snapshot.startedAt,
        snapshot.endedAt,
        snapshot.output,
        snapshot.archived ? 1 : 0,
        snapshot.archivedAt,
        snapshot.claudeSessionId,
        snapshot.provider ?? null,
        snapshot.sessionKind ?? "pty",
        snapshot.runner ?? null,
        snapshot.messages ? JSON.stringify(snapshot.messages) : null,
        snapshot.queuedMessages ? JSON.stringify(snapshot.queuedMessages) : null,
        snapshot.structuredState ? JSON.stringify(snapshot.structuredState) : null,
        snapshot.resumedFromSessionId ?? null,
        snapshot.autoRecovered ? 1 : 0,
        snapshot.worktreeEnabled ? 1 : 0,
        serializeWorktreeInfo(snapshot.worktree),
        snapshot.worktreeMergeStatus ?? null,
        serializeWorktreeMergeInfo(snapshot.worktreeMergeInfo),
    ];
}
function sessionMetadataValues(snapshot) {
    return [
        snapshot.command,
        snapshot.cwd,
        snapshot.mode,
        snapshot.status,
        snapshot.exitCode,
        snapshot.startedAt,
        snapshot.endedAt,
        snapshot.output,
        snapshot.archived ? 1 : 0,
        snapshot.archivedAt,
        snapshot.claudeSessionId,
        snapshot.provider ?? null,
        snapshot.sessionKind ?? "pty",
        snapshot.runner ?? null,
        snapshot.structuredState ? JSON.stringify(snapshot.structuredState) : null,
        snapshot.resumedFromSessionId ?? null,
        snapshot.autoRecovered ? 1 : 0,
        snapshot.worktreeEnabled ? 1 : 0,
        serializeWorktreeInfo(snapshot.worktree),
        snapshot.worktreeMergeStatus ?? null,
        serializeWorktreeMergeInfo(snapshot.worktreeMergeInfo),
        snapshot.id,
    ];
}
function mapSessionCore(row) {
    const provider = inferSessionProvider(row);
    return {
        id: row.id,
        sessionKind: row.session_kind ?? "pty",
        provider,
        runner: row.runner ?? undefined,
        command: row.command,
        cwd: row.cwd,
        mode: row.mode,
        status: row.status,
        exitCode: row.exit_code,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        output: row.output,
        archived: Boolean(row.archived),
        archivedAt: row.archived_at,
        claudeSessionId: row.claude_session_id,
        messages: safeJsonParse(row.messages),
        queuedMessages: parseQueuedMessages(row.queued_messages),
        structuredState: safeJsonParse(row.structured_state),
        resumedFromSessionId: row.resumed_from_session_id ?? undefined,
        autoRecovered: Boolean(row.auto_recovered),
        worktreeEnabled: Boolean(row.worktree_enabled),
        worktree: parseWorktreeInfo(row.worktree_info) ?? null,
        ...mapWorktreeMergeFields(row),
    };
}
function sessionRowQuery(base) {
    return `${base} ${sessionSelectFields()}`;
}
export const DEFAULT_DB_FILE = "wand.db";
export function resolveDatabasePath(configPath) {
    return path.resolve(path.dirname(configPath), DEFAULT_DB_FILE);
}
const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS command_sessions (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    output TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    claude_session_id TEXT,
    provider TEXT,
    session_kind TEXT NOT NULL DEFAULT 'pty',
    runner TEXT,
    messages TEXT,
    queued_messages TEXT,
    structured_state TEXT,
    resumed_from_session_id TEXT,
    resumed_to_session_id TEXT,
    auto_recovered INTEGER NOT NULL DEFAULT 0,
    worktree_enabled INTEGER NOT NULL DEFAULT 0,
    worktree_info TEXT,
    worktree_merge_status TEXT,
    worktree_merge_info TEXT
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;
export function ensureDatabaseFile(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const created = !existsSync(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec(INIT_SQL);
    ensureCommandSessionSchema(db);
    db.close();
    return created;
}
export class WandStorage {
    db;
    constructor(dbPath) {
        mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.db.exec(INIT_SQL);
        ensureCommandSessionSchema(this.db);
    }
    close() {
        this.db.close();
    }
    // ============ Config Methods ============
    /** Get a config value from database */
    getConfigValue(key) {
        const row = this.db
            .prepare("SELECT value FROM app_config WHERE key = ?")
            .get(key);
        return row?.value ?? null;
    }
    /** Set a config value in database */
    setConfigValue(key, value) {
        this.db
            .prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(key, value);
    }
    /** Delete a config value */
    deleteConfigValue(key) {
        this.db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
    }
    // ============ Preference Methods ============
    // Preferences 与 getConfigValue/setConfigValue 共用 app_config 表，
    // 区别在于：preference 自动 JSON 序列化/反序列化，并按"未设置时返回 fallback"语义返回。
    // 用于存放 UI 设置面板可改的用户偏好（defaultMode/defaultModel/cardDefaults 等），
    // 与 JSON 配置中的部署期参数（host/port/shell 等）分开。
    /** 读取偏好。未设置或 JSON 解析失败时返回 fallback。 */
    getPreference(key, fallback) {
        const raw = this.getConfigValue(key);
        if (raw === null)
            return fallback;
        try {
            return JSON.parse(raw);
        }
        catch {
            return fallback;
        }
    }
    /** 写入偏好。undefined / null 视为删除。 */
    setPreference(key, value) {
        if (value === undefined || value === null) {
            this.deleteConfigValue(key);
            return;
        }
        this.setConfigValue(key, JSON.stringify(value));
    }
    /** 判断偏好是否在 DB 中存在（区别于值为 null/false/""）。 */
    hasPreference(key) {
        return this.getConfigValue(key) !== null;
    }
    /** Get password from database */
    getPassword() {
        return this.getConfigValue("password");
    }
    /** Set password in database */
    setPassword(password) {
        this.setConfigValue("password", password);
    }
    /** Check if password has been set (not default) */
    hasCustomPassword() {
        return this.getPassword() !== null;
    }
    /** Get appSecret from database (used to mint Android appTokens) */
    getAppSecret() {
        return this.getConfigValue("appSecret");
    }
    /** Persist appSecret in database (DB is the authoritative source after first migration) */
    setAppSecret(value) {
        this.setConfigValue("appSecret", value);
    }
    // ============ Auth Session Methods ============
    saveAuthSession(token, expiresAt) {
        this.db
            .prepare(`INSERT INTO auth_sessions (token, expires_at)
         VALUES (?, ?)
         ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at`)
            .run(token, expiresAt);
    }
    getAuthSession(token) {
        const row = this.db
            .prepare("SELECT token, expires_at FROM auth_sessions WHERE token = ?")
            .get(token);
        if (!row) {
            return null;
        }
        return {
            token: row.token,
            expiresAt: row.expires_at
        };
    }
    deleteAuthSession(token) {
        this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
    }
    deleteExpiredAuthSessions(now) {
        this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(now);
    }
    saveSession(snapshot) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db
                .prepare(`INSERT INTO command_sessions (
           ${sessionPersistFields()}
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             ${sessionPersistAssignments()}`)
                .run(...sessionPersistValues(snapshot));
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    /**
     * Lightweight update — only touches scalar session fields, skips messages.
     * Use this in the hot persist path to avoid serializing large message arrays.
     * Full messages are written by saveSession() at state transitions (exit/stop).
     */
    saveSessionMetadata(snapshot) {
        this.db
            .prepare(`UPDATE command_sessions SET
           ${sessionMetadataAssignments()}
         WHERE id = ?`)
            .run(...sessionMetadataValues(snapshot));
    }
    getSession(id) {
        const row = this.db
            .prepare(`${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE id = ?`)
            .get(id);
        return row ? this.mapSessionRow(row) : null;
    }
    getLatestSessionByClaudeSessionId(claudeSessionId) {
        const row = this.db
            .prepare(`${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE claude_session_id = ?
         ORDER BY started_at DESC
         LIMIT 1`)
            .get(claudeSessionId);
        return row ? this.mapSessionRow(row) : null;
    }
    loadSessions() {
        const rows = this.db
            .prepare(`${sessionRowQuery("SELECT")}
         FROM command_sessions
         ORDER BY started_at DESC`)
            .all();
        return rows.map((row) => this.mapSessionRow(row));
    }
    mapSessionRow(row) {
        return mapSessionCore(row);
    }
    updateSessionWorktreeMergeState(id, status, info) {
        const current = this.getSession(id);
        if (!current) {
            return null;
        }
        const updated = {
            ...current,
            worktreeMergeStatus: status,
            worktreeMergeInfo: info,
        };
        this.saveSessionMetadata(updated);
        return updated;
    }
    deleteSession(id) {
        this.db.prepare("DELETE FROM command_sessions WHERE id = ?").run(id);
    }
}
const SCHEMA_MIGRATIONS = [
    ["archived", "ALTER TABLE command_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"],
    ["archived_at", "ALTER TABLE command_sessions ADD COLUMN archived_at TEXT"],
    ["claude_session_id", "ALTER TABLE command_sessions ADD COLUMN claude_session_id TEXT"],
    ["provider", "ALTER TABLE command_sessions ADD COLUMN provider TEXT"],
    ["session_kind", "ALTER TABLE command_sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'pty'"],
    ["runner", "ALTER TABLE command_sessions ADD COLUMN runner TEXT"],
    ["messages", "ALTER TABLE command_sessions ADD COLUMN messages TEXT"],
    ["queued_messages", "ALTER TABLE command_sessions ADD COLUMN queued_messages TEXT"],
    ["structured_state", "ALTER TABLE command_sessions ADD COLUMN structured_state TEXT"],
    ["resumed_from_session_id", "ALTER TABLE command_sessions ADD COLUMN resumed_from_session_id TEXT"],
    ["resumed_to_session_id", "ALTER TABLE command_sessions ADD COLUMN resumed_to_session_id TEXT"],
    ["auto_recovered", "ALTER TABLE command_sessions ADD COLUMN auto_recovered INTEGER NOT NULL DEFAULT 0"],
    ["worktree_enabled", "ALTER TABLE command_sessions ADD COLUMN worktree_enabled INTEGER NOT NULL DEFAULT 0"],
    ["worktree_info", "ALTER TABLE command_sessions ADD COLUMN worktree_info TEXT"],
    ["worktree_merge_status", "ALTER TABLE command_sessions ADD COLUMN worktree_merge_status TEXT"],
    ["worktree_merge_info", "ALTER TABLE command_sessions ADD COLUMN worktree_merge_info TEXT"],
];
function ensureCommandSessionSchema(db) {
    const columns = db.prepare("PRAGMA table_info(command_sessions)").all();
    const names = new Set(columns.map((column) => column.name));
    for (const [column, sql] of SCHEMA_MIGRATIONS) {
        if (!names.has(column)) {
            db.exec(sql);
        }
    }
}
