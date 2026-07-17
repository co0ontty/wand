import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionSnapshot, ConversationTurn, SessionKind, SessionProvider, SessionRunner, SessionSource, StructuredSessionState, WorktreeMergeInfo } from "./types.js";
import {
  DEFAULT_PASSWORD_VAULT_ID,
  DEFAULT_PASSWORD_VAULT_NAME,
  itemMatchesFilter,
  normalizePasswordItemInput,
  normalizeVaultName,
  nowIso,
  type PasswordVault,
  type PasswordVaultItem,
  type PasswordVaultItemFilter,
  type PasswordVaultItemInput,
  type PasswordVaultItemType,
} from "./password-manager.js";

interface SessionRow {
  id: string;
  session_source: string | null;
  automation_id: string | null;
  provider: SessionProvider | null;
  session_kind: SessionKind | null;
  runner: SessionRunner | null;
  command: string;
  cwd: string;
  mode: SessionSnapshot["mode"];
  status: SessionSnapshot["status"];
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  output: string;
  archived: number;
  archived_at: string | null;
  claude_session_id: string | null;
  messages: string | null;
  queued_messages: string | null;
  structured_state: string | null;
  resumed_from_session_id: string | null;
  auto_recovered: number;
  worktree_enabled: number;
  worktree_info: string | null;
  worktree_merge_status: SessionSnapshot["worktreeMergeStatus"] | null;
  worktree_merge_info: string | null;
  title: string | null;
  description: string | null;
  session_options: string | null;
}

interface PasswordVaultRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface PasswordVaultItemRow {
  id: string;
  vault_id: string;
  type: PasswordVaultItemType;
  title: string;
  username: string | null;
  password: string | null;
  urls: string;
  notes: string | null;
  fields: string;
  tags: string;
  favorite: number;
  archived: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  password_updated_at: string | null;
}

function safeJsonParse<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const SESSION_OPTIONS_SCHEMA_VERSION = 1 as const;

type DurableSessionOptions = Pick<SessionSnapshot,
  | "autonomyPolicy"
  | "approvalPolicy"
  | "allowedScopes"
  | "pendingEscalation"
  | "lastEscalationResult"
  | "autoApprovePermissions"
  | "approvalStats"
  | "selectedModel"
  | "thinkingEffort"
  | "ptyCols"
  | "ptyRows"
  | "currentTaskTitle"
  | "summary"
>;

type PersistedSessionOptions = DurableSessionOptions & {
  schemaVersion: typeof SESSION_OPTIONS_SCHEMA_VERSION;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutonomyPolicy(value: unknown): value is NonNullable<SessionSnapshot["autonomyPolicy"]> {
  return value === "assist" || value === "agent" || value === "agent-max";
}

function isApprovalPolicy(value: unknown): value is NonNullable<SessionSnapshot["approvalPolicy"]> {
  return value === "ask-every-time" || value === "approve-once" || value === "remember-this-turn";
}

function isEscalationScope(value: unknown): value is NonNullable<SessionSnapshot["allowedScopes"]>[number] {
  return value === "write_file"
    || value === "run_command"
    || value === "network"
    || value === "outside_workspace"
    || value === "dangerous_shell"
    || value === "unknown";
}

function isEscalationResolution(
  value: unknown,
): value is NonNullable<NonNullable<SessionSnapshot["lastEscalationResult"]>["resolution"]> {
  return value === "approve_once" || value === "approve_turn" || value === "deny" || value === "fallback_manual";
}

function parsePendingEscalation(
  value: unknown,
): NonNullable<SessionSnapshot["pendingEscalation"]> | undefined {
  if (!isRecord(value)
    || typeof value.requestId !== "string"
    || !isEscalationScope(value.scope)
    || (value.runner !== "json" && value.runner !== "pty")
    || (value.source !== "tool_permission_request"
      && value.source !== "sandbox_hard_block"
      && value.source !== "workspace_policy_limit"
      && value.source !== "cli_capability_limit"
      && value.source !== "unknown")
    || typeof value.reason !== "string") {
    return undefined;
  }

  const parsed: NonNullable<SessionSnapshot["pendingEscalation"]> = {
    requestId: value.requestId,
    scope: value.scope,
    runner: value.runner,
    source: value.source,
    reason: value.reason,
  };
  if (isEscalationResolution(value.resolution)) parsed.resolution = value.resolution;
  if (typeof value.target === "string") parsed.target = value.target;
  return parsed;
}

function parseLastEscalationResult(
  value: unknown,
): NonNullable<SessionSnapshot["lastEscalationResult"]> | undefined {
  if (!isRecord(value)
    || typeof value.requestId !== "string"
    || !isEscalationResolution(value.resolution)
    || typeof value.reason !== "string") {
    return undefined;
  }
  return {
    requestId: value.requestId,
    resolution: value.resolution,
    reason: value.reason,
  };
}

function parseApprovalStats(value: unknown): NonNullable<SessionSnapshot["approvalStats"]> | undefined {
  if (!isRecord(value)) return undefined;
  const counts = [value.tool, value.command, value.file, value.total];
  if (!counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return undefined;
  return {
    tool: value.tool as number,
    command: value.command as number,
    file: value.file as number,
    total: value.total as number,
  };
}

function isThinkingEffort(value: unknown): value is NonNullable<SessionSnapshot["thinkingEffort"]> {
  return value === "off"
    || value === "standard"
    || value === "deep"
    || value === "max"
    || (typeof value === "string" && /^codex:[a-z0-9][a-z0-9_-]{0,31}$/.test(value));
}

function serializeSessionOptions(snapshot: SessionSnapshot): string {
  const options: PersistedSessionOptions = {
    schemaVersion: SESSION_OPTIONS_SCHEMA_VERSION,
    autonomyPolicy: snapshot.autonomyPolicy,
    approvalPolicy: snapshot.approvalPolicy,
    allowedScopes: snapshot.allowedScopes,
    pendingEscalation: snapshot.pendingEscalation,
    lastEscalationResult: snapshot.lastEscalationResult,
    autoApprovePermissions: snapshot.autoApprovePermissions,
    approvalStats: snapshot.approvalStats,
    selectedModel: snapshot.selectedModel,
    thinkingEffort: snapshot.thinkingEffort,
    ptyCols: snapshot.ptyCols,
    ptyRows: snapshot.ptyRows,
    currentTaskTitle: snapshot.currentTaskTitle,
    summary: snapshot.summary,
  };
  return JSON.stringify(options);
}

function parseSessionOptions(raw: string | null): DurableSessionOptions {
  const parsed = safeJsonParse<unknown>(raw);
  if (!isRecord(parsed) || parsed.schemaVersion !== SESSION_OPTIONS_SCHEMA_VERSION) return {};

  const options: DurableSessionOptions = {};
  if (isAutonomyPolicy(parsed.autonomyPolicy)) options.autonomyPolicy = parsed.autonomyPolicy;
  if (isApprovalPolicy(parsed.approvalPolicy)) options.approvalPolicy = parsed.approvalPolicy;
  if (Array.isArray(parsed.allowedScopes)) {
    options.allowedScopes = parsed.allowedScopes.filter(isEscalationScope);
  }
  if (parsed.pendingEscalation === null) {
    options.pendingEscalation = null;
  } else {
    const pendingEscalation = parsePendingEscalation(parsed.pendingEscalation);
    if (pendingEscalation) options.pendingEscalation = pendingEscalation;
  }
  if (parsed.lastEscalationResult === null) {
    options.lastEscalationResult = null;
  } else {
    const lastEscalationResult = parseLastEscalationResult(parsed.lastEscalationResult);
    if (lastEscalationResult) options.lastEscalationResult = lastEscalationResult;
  }
  if (typeof parsed.autoApprovePermissions === "boolean") {
    options.autoApprovePermissions = parsed.autoApprovePermissions;
  }
  const approvalStats = parseApprovalStats(parsed.approvalStats);
  if (approvalStats) options.approvalStats = approvalStats;
  if (parsed.selectedModel === null || typeof parsed.selectedModel === "string") {
    options.selectedModel = parsed.selectedModel;
  }
  if (parsed.thinkingEffort === null || isThinkingEffort(parsed.thinkingEffort)) {
    options.thinkingEffort = parsed.thinkingEffort;
  }
  if (Number.isSafeInteger(parsed.ptyCols) && (parsed.ptyCols as number) > 0) {
    options.ptyCols = parsed.ptyCols as number;
  }
  if (Number.isSafeInteger(parsed.ptyRows) && (parsed.ptyRows as number) > 0) {
    options.ptyRows = parsed.ptyRows as number;
  }
  if (typeof parsed.currentTaskTitle === "string") options.currentTaskTitle = parsed.currentTaskTitle;
  if (typeof parsed.summary === "string") options.summary = parsed.summary;
  return options;
}

function parseQueuedMessages(raw: string | null): string[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
}

function inferSessionProvider(row: Pick<SessionRow, "provider" | "runner" | "command">): SessionProvider | undefined {
  if (row.provider === "claude" || row.provider === "codex" || row.provider === "opencode" || row.provider === "grok" || row.provider === "qoder") {
    return row.provider;
  }
  if (row.runner === "claude-cli" || row.runner === "claude-cli-print") {
    return "claude";
  }
  if (row.runner === "codex-cli-exec") {
    return "codex";
  }
  if (row.runner === "opencode-cli-run") {
    return "opencode";
  }
  if (row.runner === "grok-cli-headless") return "grok";
  if (row.runner === "qoder-cli-print") return "qoder";
  if (/^codex\b/i.test(row.command.trim())) return "codex";
  if (/^opencode\b/i.test(row.command.trim())) return "opencode";
  if (/^grok\b/i.test(row.command.trim())) return "grok";
  if (/^qodercli\b/i.test(row.command.trim())) return "qoder";
  return /^claude\b/i.test(row.command.trim()) ? "claude" : undefined;
}

function parseWorktreeInfo(raw: string | null): SessionSnapshot["worktree"] | undefined {
  const parsed = safeJsonParse<{ branch?: unknown; path?: unknown }>(raw);
  if (parsed && typeof parsed.branch === "string" && typeof parsed.path === "string") {
    return { branch: parsed.branch, path: parsed.path };
  }
  return undefined;
}

function parseWorktreeMergeInfo(raw: string | null): WorktreeMergeInfo | undefined {
  return safeJsonParse<WorktreeMergeInfo>(raw);
}

function serializeWorktreeMergeInfo(info: SessionSnapshot["worktreeMergeInfo"]): string | null {
  return info ? JSON.stringify(info) : null;
}

function serializeWorktreeInfo(info: SessionSnapshot["worktree"]): string | null {
  return info ? JSON.stringify(info) : null;
}

function normalizeWorktreeMergeStatus(raw: string | null | undefined): SessionSnapshot["worktreeMergeStatus"] | undefined {
  if (raw === "ready" || raw === "checking" || raw === "merging" || raw === "merged" || raw === "failed") {
    return raw;
  }
  return undefined;
}

function normalizeSessionSource(raw: unknown): SessionSource {
  return raw === "automation" || raw === "startup" || raw === "interactive" ? raw : "interactive";
}



function mapWorktreeMergeFields(row: SessionRow): Pick<SessionSnapshot, "worktreeMergeStatus" | "worktreeMergeInfo"> {
  return {
    worktreeMergeStatus: normalizeWorktreeMergeStatus(row.worktree_merge_status),
    worktreeMergeInfo: parseWorktreeMergeInfo(row.worktree_merge_info) ?? null,
  };
}

function sessionSelectFields(): string {
  return `id, session_source, automation_id, provider, session_kind, runner, command, cwd, mode, status, exit_code, started_at, ended_at, output, archived, archived_at, claude_session_id, messages, queued_messages, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options`;
}

function sessionPersistFields(): string {
  return `id, session_source, automation_id, command, cwd, mode, status, exit_code, started_at, ended_at, output
             , archived, archived_at, claude_session_id, provider, session_kind, runner, messages, queued_messages, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options`;
}

function sessionPersistAssignments(): string {
  return `session_source = excluded.session_source,
             automation_id = excluded.automation_id,
             command = excluded.command,
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
             worktree_merge_info = excluded.worktree_merge_info,
             title = excluded.title,
             description = excluded.description,
             session_options = excluded.session_options`;
}

function sessionRuntimeMetadataAssignments(): string {
  return `session_source = ?, automation_id = ?,
           command = ?, cwd = ?, mode = ?, status = ?, exit_code = ?,
           started_at = ?, ended_at = ?,
           archived = ?, archived_at = ?, claude_session_id = ?,
           provider = ?, session_kind = ?, runner = ?, queued_messages = ?, structured_state = ?,
           resumed_from_session_id = ?, auto_recovered = ?,
           worktree_enabled = ?, worktree_info = ?, worktree_merge_status = ?, worktree_merge_info = ?,
           title = ?, description = ?, session_options = ?`;
}

function sessionPersistValues(snapshot: SessionSnapshot): Array<string | number | null> {
  return [
    snapshot.id,
    normalizeSessionSource(snapshot.sessionSource),
    snapshot.automationId ?? null,
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
    snapshot.title ?? null,
    snapshot.description ?? null,
    serializeSessionOptions(snapshot),
  ];
}

function sessionRuntimeMetadataValues(snapshot: SessionSnapshot): Array<string | number | null> {
  return [
    normalizeSessionSource(snapshot.sessionSource),
    snapshot.automationId ?? null,
    snapshot.command,
    snapshot.cwd,
    snapshot.mode,
    snapshot.status,
    snapshot.exitCode,
    snapshot.startedAt,
    snapshot.endedAt,
    snapshot.archived ? 1 : 0,
    snapshot.archivedAt,
    snapshot.claudeSessionId,
    snapshot.provider ?? null,
    snapshot.sessionKind ?? "pty",
    snapshot.runner ?? null,
    snapshot.queuedMessages ? JSON.stringify(snapshot.queuedMessages) : null,
    snapshot.structuredState ? JSON.stringify(snapshot.structuredState) : null,
    snapshot.resumedFromSessionId ?? null,
    snapshot.autoRecovered ? 1 : 0,
    snapshot.worktreeEnabled ? 1 : 0,
    serializeWorktreeInfo(snapshot.worktree),
    snapshot.worktreeMergeStatus ?? null,
    serializeWorktreeMergeInfo(snapshot.worktreeMergeInfo),
    snapshot.title ?? null,
    snapshot.description ?? null,
    serializeSessionOptions(snapshot),
    snapshot.id,
  ];
}

function mapSessionCore(row: SessionRow): SessionSnapshot {
  const provider = inferSessionProvider(row);
  const sessionOptions = parseSessionOptions(row.session_options);
  return {
    id: row.id,
    sessionSource: normalizeSessionSource(row.session_source),
    automationId: row.automation_id ?? undefined,
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
    messages: safeJsonParse<ConversationTurn[]>(row.messages),
    queuedMessages: parseQueuedMessages(row.queued_messages),
    structuredState: safeJsonParse<StructuredSessionState>(row.structured_state),
    resumedFromSessionId: row.resumed_from_session_id ?? undefined,
    autoRecovered: Boolean(row.auto_recovered),
    worktreeEnabled: Boolean(row.worktree_enabled),
    worktree: parseWorktreeInfo(row.worktree_info) ?? null,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    ...mapWorktreeMergeFields(row),
    ...sessionOptions,
    ...(Object.prototype.hasOwnProperty.call(sessionOptions, "pendingEscalation")
      ? { permissionBlocked: Boolean(sessionOptions.pendingEscalation) }
      : {}),
  };
}

function sessionRowQuery(base: string): string {
  return `${base} ${sessionSelectFields()}`;
}

export const DEFAULT_DB_FILE = "wand.db";

export type AuthPrincipalKind = "browser-admin" | "connected-app";
export type AuthScope = "admin" | "sessions" | "files" | "password-vault" | "session-preferences";

export interface AuthPrincipal {
  kind: AuthPrincipalKind;
  scopes: AuthScope[];
}

export interface PersistedAuthSession {
  token: string;
  expiresAt: number;
  principal: AuthPrincipal;
}

export function resolveDatabasePath(configPath: string): string {
  return path.resolve(path.dirname(configPath), DEFAULT_DB_FILE);
}

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'browser-admin',
    scopes TEXT NOT NULL DEFAULT '["admin"]'
  );

  CREATE TABLE IF NOT EXISTS command_sessions (
    id TEXT PRIMARY KEY,
    session_source TEXT NOT NULL DEFAULT 'interactive',
    automation_id TEXT,
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
    worktree_merge_info TEXT,
    title TEXT,
    description TEXT,
    session_options TEXT NOT NULL DEFAULT '{"schemaVersion":1}'
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_vaults (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_items (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    username TEXT,
    password TEXT,
    urls TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    fields TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    password_updated_at TEXT,
    FOREIGN KEY(vault_id) REFERENCES password_vaults(id)
  );

  CREATE INDEX IF NOT EXISTS idx_password_items_vault ON password_items(vault_id);
  CREATE INDEX IF NOT EXISTS idx_password_items_type ON password_items(type);
  CREATE INDEX IF NOT EXISTS idx_password_items_updated ON password_items(updated_at);
`;

export function ensureDatabaseFile(dbPath: string): boolean {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const created = !existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(INIT_SQL);
  ensureAuthSessionSchema(db);
  ensureCommandSessionSchema(db);
  db.close();
  chmodSync(dbPath, 0o600);
  return created;
}

export class WandStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(INIT_SQL);
    ensureAuthSessionSchema(this.db);
    ensureCommandSessionSchema(this.db);
    this.ensureDefaultPasswordVault();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Run a synchronous group of storage operations atomically. Calls must not
   * be nested because SQLite does not support a second BEGIN on this connection.
   */
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  // ============ Config Methods ============

  /** Get a config value from database */
  getConfigValue(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM app_config WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Set a config value in database */
  setConfigValue(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  /** Delete a config value */
  deleteConfigValue(key: string): void {
    this.db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
  }

  // ============ Preference Methods ============
  // Preferences 与 getConfigValue/setConfigValue 共用 app_config 表，
  // 区别在于：preference 自动 JSON 序列化/反序列化，并按"未设置时返回 fallback"语义返回。
  // 用于存放 UI 设置面板可改的用户偏好（defaultMode/defaultModel/cardDefaults 等），
  // 与 JSON 配置中的部署期参数（host/port/shell 等）分开。

  /** 读取偏好。未设置或 JSON 解析失败时返回 fallback。 */
  getPreference<T>(key: string, fallback: T): T {
    const raw = this.getConfigValue(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /** 写入偏好。undefined / null 视为删除。 */
  setPreference<T>(key: string, value: T | null | undefined): void {
    if (value === undefined || value === null) {
      this.deleteConfigValue(key);
      return;
    }
    this.setConfigValue(key, JSON.stringify(value));
  }

  /** 判断偏好是否在 DB 中存在（区别于值为 null/false/""）。 */
  hasPreference(key: string): boolean {
    return this.getConfigValue(key) !== null;
  }

  /** Get password from database */
  getPassword(): string | null {
    return this.getConfigValue("password");
  }

  /** Set password in database */
  setPassword(password: string): void {
    this.setConfigValue("password", password);
  }

  /** Check if password has been set (not default) */
  hasCustomPassword(): boolean {
    return this.getPassword() !== null;
  }

  /** Get appSecret from database (used to mint Android appTokens) */
  getAppSecret(): string | null {
    return this.getConfigValue("appSecret");
  }

  /** Persist appSecret in database (DB is the authoritative source after first migration) */
  setAppSecret(value: string): void {
    this.setConfigValue("appSecret", value);
  }

  // ============ Browser Extension Password Vault Methods ============

  ensureDefaultPasswordVault(): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO password_vaults (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(DEFAULT_PASSWORD_VAULT_ID, DEFAULT_PASSWORD_VAULT_NAME, now, now);
  }

  listPasswordVaults(): PasswordVault[] {
    this.ensureDefaultPasswordVault();
    const rows = this.db
      .prepare("SELECT id, name, created_at, updated_at FROM password_vaults ORDER BY name COLLATE NOCASE ASC")
      .all() as unknown as PasswordVaultRow[];
    return rows.map(mapPasswordVaultRow);
  }

  createPasswordVault(nameInput: unknown): PasswordVault {
    const name = normalizeVaultName(nameInput);
    const now = nowIso();
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO password_vaults (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, name, now, now);
    return { id, name, createdAt: now, updatedAt: now };
  }

  getPasswordVault(id: string): PasswordVault | null {
    const row = this.db
      .prepare("SELECT id, name, created_at, updated_at FROM password_vaults WHERE id = ?")
      .get(id) as PasswordVaultRow | undefined;
    return row ? mapPasswordVaultRow(row) : null;
  }

  listPasswordItems(filter: PasswordVaultItemFilter = {}): PasswordVaultItem[] {
    this.ensureDefaultPasswordVault();
    const rows = this.db
      .prepare(
        `SELECT id, vault_id, type, title, username, password, urls, notes, fields, tags, favorite, archived,
                created_at, updated_at, last_used_at, password_updated_at
         FROM password_items
         WHERE (? = 1 OR archived = 0)
         ORDER BY favorite DESC, last_used_at DESC NULLS LAST, updated_at DESC`
      )
      .all(filter.includeArchived ? 1 : 0) as unknown as PasswordVaultItemRow[];
    const limit = typeof filter.limit === "number" && Number.isFinite(filter.limit)
      ? Math.max(1, Math.min(200, Math.floor(filter.limit)))
      : 100;
    return rows.map(mapPasswordItemRow).filter((item) => itemMatchesFilter(item, filter)).slice(0, limit);
  }

  getPasswordItem(id: string): PasswordVaultItem | null {
    const row = this.db
      .prepare(
        `SELECT id, vault_id, type, title, username, password, urls, notes, fields, tags, favorite, archived,
                created_at, updated_at, last_used_at, password_updated_at
         FROM password_items
         WHERE id = ? AND archived = 0`
      )
      .get(id) as PasswordVaultItemRow | undefined;
    return row ? mapPasswordItemRow(row) : null;
  }

  createPasswordItem(input: PasswordVaultItemInput): PasswordVaultItem {
    this.ensureDefaultPasswordVault();
    const normalized = normalizePasswordItemInput(input);
    const vaultId = typeof input.vaultId === "string" && this.getPasswordVault(input.vaultId)
      ? input.vaultId
      : DEFAULT_PASSWORD_VAULT_ID;
    const now = nowIso();
    const id = crypto.randomUUID();
    const passwordUpdatedAt = normalized.password ? now : undefined;
    this.db
      .prepare(
        `INSERT INTO password_items (
           id, vault_id, type, title, username, password, urls, notes, fields, tags, favorite, archived,
           created_at, updated_at, last_used_at, password_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`
      )
      .run(
        id,
        vaultId,
        normalized.type,
        normalized.title,
        normalized.username ?? null,
        normalized.password ?? null,
        JSON.stringify(normalized.urls),
        normalized.notes ?? null,
        JSON.stringify(normalized.fields),
        JSON.stringify(normalized.tags),
        normalized.favorite ? 1 : 0,
        now,
        now,
        passwordUpdatedAt ?? null,
      );
    return this.getPasswordItem(id)!;
  }

  updatePasswordItem(id: string, input: PasswordVaultItemInput): PasswordVaultItem | null {
    const existing = this.getPasswordItem(id);
    if (!existing) return null;
    const merged: PasswordVaultItemInput = {
      vaultId: input.vaultId ?? existing.vaultId,
      type: input.type ?? existing.type,
      title: input.title ?? existing.title,
      username: input.username ?? existing.username,
      password: input.password ?? existing.password,
      urls: input.urls ?? existing.urls,
      notes: input.notes ?? existing.notes,
      fields: input.fields ?? existing.fields,
      tags: input.tags ?? existing.tags,
      favorite: input.favorite ?? existing.favorite,
    };
    const normalized = normalizePasswordItemInput(merged);
    const vaultId = typeof merged.vaultId === "string" && this.getPasswordVault(merged.vaultId)
      ? merged.vaultId
      : existing.vaultId;
    const now = nowIso();
    const passwordChanged = Object.prototype.hasOwnProperty.call(input, "password") && normalized.password !== existing.password;
    const passwordUpdatedAt = passwordChanged ? (normalized.password ? now : null) : (existing.passwordUpdatedAt ?? null);
    this.db
      .prepare(
        `UPDATE password_items
         SET vault_id = ?, type = ?, title = ?, username = ?, password = ?, urls = ?, notes = ?,
             fields = ?, tags = ?, favorite = ?, updated_at = ?, password_updated_at = ?
         WHERE id = ? AND archived = 0`
      )
      .run(
        vaultId,
        normalized.type,
        normalized.title,
        normalized.username ?? null,
        normalized.password ?? null,
        JSON.stringify(normalized.urls),
        normalized.notes ?? null,
        JSON.stringify(normalized.fields),
        JSON.stringify(normalized.tags),
        normalized.favorite ? 1 : 0,
        now,
        passwordUpdatedAt,
        id,
      );
    return this.getPasswordItem(id);
  }

  touchPasswordItem(id: string): PasswordVaultItem | null {
    const now = nowIso();
    this.db.prepare("UPDATE password_items SET last_used_at = ?, updated_at = ? WHERE id = ? AND archived = 0").run(now, now, id);
    return this.getPasswordItem(id);
  }

  deletePasswordItem(id: string): boolean {
    const now = nowIso();
    const result = this.db
      .prepare("UPDATE password_items SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0")
      .run(now, id);
    return result.changes > 0;
  }

  // ============ Auth Session Methods ============

  saveAuthSession(
    token: string,
    expiresAt: number,
    principal: AuthPrincipal = { kind: "browser-admin", scopes: ["admin"] },
  ): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token, expires_at, kind, scopes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET
           expires_at = excluded.expires_at,
           kind = excluded.kind,
           scopes = excluded.scopes`
      )
      .run(token, expiresAt, principal.kind, JSON.stringify(principal.scopes));
  }

  getAuthSession(token: string): PersistedAuthSession | null {
    const row = this.db
      .prepare("SELECT token, expires_at, kind, scopes FROM auth_sessions WHERE token = ?")
      .get(token) as { token: string; expires_at: number; kind: string; scopes: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      token: row.token,
      expiresAt: row.expires_at,
      principal: parseAuthPrincipal(row.kind, row.scopes),
    };
  }

  deleteAuthSession(token: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
  }

  deleteAllAuthSessions(): void {
    this.db.prepare("DELETE FROM auth_sessions").run();
  }

  deleteExpiredAuthSessions(now: number): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(now);
  }

  saveSession(snapshot: SessionSnapshot): void {
    // A single SQLite statement is already atomic. Avoid BEGIN IMMEDIATE in
    // this hot path so streaming checkpoints do not take an unnecessary write
    // lock and saveSession can also participate in a caller-owned transaction.
    this.db
      .prepare(
        `INSERT INTO command_sessions (
         ${sessionPersistFields()}
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ${sessionPersistAssignments()}`
      )
      .run(...sessionPersistValues(snapshot));
  }

  /** Update runtime/scalar fields without serializing or rewriting messages/output. */
  updateSessionRuntimeMetadata(snapshot: SessionSnapshot): void {
    this.db
      .prepare(
        `UPDATE command_sessions SET
           ${sessionRuntimeMetadataAssignments()}
         WHERE id = ?`
      )
      .run(...sessionRuntimeMetadataValues(snapshot));
  }

  /** Compatibility alias for older callers; intentionally excludes output/messages. */
  saveSessionMetadata(snapshot: SessionSnapshot): void {
    this.updateSessionRuntimeMetadata(snapshot);
  }

  /** Checkpoint only the PTY/structured text output window. */
  checkpointSessionOutput(id: string, output: string): void {
    this.db.prepare("UPDATE command_sessions SET output = ? WHERE id = ?").run(output, id);
  }

  /**
   * Checkpoint the conversation payload once, optionally folding the matching
   * structured state/output into the same statement.
   */
  checkpointSessionMessages(
    id: string,
    messages: ConversationTurn[],
    structuredState?: StructuredSessionState | null,
    output?: string,
  ): void {
    const assignments = ["messages = ?"];
    const values: Array<string | null> = [JSON.stringify(messages)];
    if (structuredState !== undefined) {
      assignments.push("structured_state = ?");
      values.push(structuredState ? JSON.stringify(structuredState) : null);
    }
    if (output !== undefined) {
      assignments.push("output = ?");
      values.push(output);
    }
    this.db
      .prepare(`UPDATE command_sessions SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values, id);
  }

  getSession(id: string): SessionSnapshot | null {
    const row = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE id = ?`
      )
      .get(id) as SessionRow | undefined;

    return row ? this.mapSessionRow(row) : null;
  }

  getLatestSessionByClaudeSessionId(claudeSessionId: string): SessionSnapshot | null {
    const row = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE claude_session_id = ?
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(claudeSessionId) as SessionRow | undefined;

    return row ? this.mapSessionRow(row) : null;
  }

  loadSessions(): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         ORDER BY started_at DESC`
      )
      .all() as unknown as SessionRow[];

    return rows.map((row) => this.mapSessionRow(row));
  }

  private mapSessionRow(row: SessionRow): SessionSnapshot {
    return mapSessionCore(row);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM command_sessions WHERE id = ?").run(id);
  }
}

function mapPasswordVaultRow(row: PasswordVaultRow): PasswordVault {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPasswordItemRow(row: PasswordVaultItemRow): PasswordVaultItem {
  return {
    id: row.id,
    vaultId: row.vault_id,
    type: row.type,
    title: row.title,
    username: row.username ?? undefined,
    password: row.password ?? undefined,
    urls: safeJsonParse<string[]>(row.urls)?.filter((item): item is string => typeof item === "string") ?? [],
    notes: row.notes ?? undefined,
    fields: safeJsonParse<Record<string, string>>(row.fields) ?? {},
    tags: safeJsonParse<string[]>(row.tags)?.filter((item): item is string => typeof item === "string") ?? [],
    favorite: Boolean(row.favorite),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
    passwordUpdatedAt: row.password_updated_at ?? undefined,
  };
}

const SCHEMA_MIGRATIONS: ReadonlyArray<[column: string, sql: string]> = [
  ["session_source", "ALTER TABLE command_sessions ADD COLUMN session_source TEXT NOT NULL DEFAULT 'interactive'"],
  ["automation_id", "ALTER TABLE command_sessions ADD COLUMN automation_id TEXT"],
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
  ["title", "ALTER TABLE command_sessions ADD COLUMN title TEXT"],
  ["description", "ALTER TABLE command_sessions ADD COLUMN description TEXT"],
  ["session_options", `ALTER TABLE command_sessions ADD COLUMN session_options TEXT NOT NULL DEFAULT '{"schemaVersion":1}'`],
];

const AUTH_SESSION_MIGRATIONS: ReadonlyArray<[column: string, sql: string]> = [
  ["kind", "ALTER TABLE auth_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser-admin'"],
  ["scopes", `ALTER TABLE auth_sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '["admin"]'`],
];

function ensureAuthSessionSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const [column, sql] of AUTH_SESSION_MIGRATIONS) {
    if (!names.has(column)) db.exec(sql);
  }
}

function ensureCommandSessionSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(command_sessions)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const [column, sql] of SCHEMA_MIGRATIONS) {
    if (!names.has(column)) {
      db.exec(sql);
    }
  }
}

const AUTH_SCOPES = new Set<AuthScope>([
  "admin",
  "sessions",
  "files",
  "password-vault",
  "session-preferences",
]);

function parseAuthPrincipal(kind: string, rawScopes: string): AuthPrincipal {
  const normalizedKind: AuthPrincipalKind = kind === "browser-admin" ? "browser-admin" : "connected-app";
  const parsed = safeJsonParse<unknown[]>(rawScopes);
  const scopes = Array.isArray(parsed)
    ? parsed.filter((scope): scope is AuthScope => typeof scope === "string" && AUTH_SCOPES.has(scope as AuthScope))
    : [];
  return {
    kind: normalizedKind,
    scopes: normalizedKind === "browser-admin" && !scopes.includes("admin")
      ? ["admin", ...scopes]
      : scopes,
  };
}
