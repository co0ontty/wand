import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionSnapshot, ConversationTurn, SessionKind, SessionProvider, SessionRunner, SessionSource, StructuredSessionState, WorktreeMergeInfo, Workspace, LayoutNode, TaskWindowLayout, WorkspaceDefaultProvider, WorkspaceTask, WorkspaceTaskWorktree, WorkspaceTaskStatus } from "./types.js";
import { normalizeSessionDirectory } from "./session-directory-tree.js";
import type {
  AgentActivityItem,
  AgentActivityState,
  Mission,
  MissionAttempt,
  MissionAttemptState,
  MissionReviewComment,
  MissionReviewStatus,
  MissionStatus,
} from "./mission-types.js";
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
  workspace_id: string | null;
  workspace_task_id: string | null;
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
  pty_output_seq: number;
  archived: number;
  archived_at: string | null;
  claude_session_id: string | null;
  messages: string | null;
  queued_messages: string | null;
  queued_message_skills: string | null;
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
  | "ptyLaunchMarkerToken"
  | "providerCliActive"
  | "providerCliExitCode"
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
    ptyLaunchMarkerToken: snapshot.ptyLaunchMarkerToken,
    providerCliActive: snapshot.providerCliActive,
    providerCliExitCode: snapshot.providerCliExitCode,
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
  if (parsed.ptyLaunchMarkerToken === null || typeof parsed.ptyLaunchMarkerToken === "string") {
    options.ptyLaunchMarkerToken = parsed.ptyLaunchMarkerToken;
  }
  if (typeof parsed.providerCliActive === "boolean") options.providerCliActive = parsed.providerCliActive;
  if (parsed.providerCliExitCode === null || Number.isSafeInteger(parsed.providerCliExitCode)) {
    options.providerCliExitCode = parsed.providerCliExitCode as number | null;
  }
  if (typeof parsed.currentTaskTitle === "string") options.currentTaskTitle = parsed.currentTaskTitle;
  if (typeof parsed.summary === "string") options.summary = parsed.summary;
  return options;
}

function parseQueuedMessages(raw: string | null): string[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
}

function parseQueuedMessageSkills(raw: string | null, queueLength: number): string[][] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  if (!Array.isArray(parsed)) return undefined;
  return Array.from({ length: queueLength }, (_, index) => {
    const skills = parsed[index];
    return Array.isArray(skills)
      ? skills.filter((skill): skill is string => typeof skill === "string")
      : [];
  });
}

function inferSessionProvider(row: Pick<SessionRow, "provider" | "runner" | "command">): SessionProvider | undefined {
  if (row.provider === "claude" || row.provider === "codex" || row.provider === "opencode" || row.provider === "grok" || row.provider === "qoder" || row.provider === "pi") {
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
  if (row.runner === "pi-cli-json") return "pi";
  if (/^codex\b/i.test(row.command.trim())) return "codex";
  if (/^opencode\b/i.test(row.command.trim())) return "opencode";
  if (/^grok\b/i.test(row.command.trim())) return "grok";
  if (/^qodercli\b/i.test(row.command.trim())) return "qoder";
  if (/^pi\b/i.test(row.command.trim())) return "pi";
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
  return `id, session_source, automation_id, provider, session_kind, runner, command, cwd, mode, status, exit_code, started_at, ended_at, output, pty_output_seq, archived, archived_at, claude_session_id, messages, queued_messages, queued_message_skills, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options, workspace_id, workspace_task_id`;
}

interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  default_provider: string | null;
  layout_json: string | null;
  created_at: string;
  last_opened_at: string | null;
}

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    defaultProvider: (row.default_provider ?? undefined) as Workspace["defaultProvider"],
    layout: row.layout_json ? safeJsonParse<LayoutNode>(row.layout_json) ?? null : null,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

interface WorkspaceTaskRow {
  id: string;
  workspace_id: string;
  name: string;
  worktree_json: string | null;
  layout_json: string | null;
  status: string;
  created_at: string;
  last_opened_at: string | null;
}

function mapWorkspaceTaskWorktree(raw: string | null): WorkspaceTaskWorktree | null {
  const parsed = safeJsonParse<WorkspaceTaskWorktree>(raw);
  if (!parsed || typeof parsed.path !== "string" || typeof parsed.branch !== "string") return null;
  return parsed;
}

function firstLayoutTabId(node: LayoutNode): string | undefined {
  if (node.type === "pane") return node.tabs[node.active]?.id ?? node.tabs[0]?.id;
  return firstLayoutTabId(node.children[0]) ?? firstLayoutTabId(node.children[1]);
}

/** 读取旧版单棵分屏树时就地包成一个工作窗口，避免升级后丢失布局。 */
function mapWorkspaceTaskLayout(raw: string | null): TaskWindowLayout | null {
  const parsed = safeJsonParse<unknown>(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.type === "windows" && Array.isArray(record.windows)) {
    return parsed as TaskWindowLayout;
  }
  if (record.type === "pane" || record.type === "split") {
    const legacy = parsed as LayoutNode;
    return {
      type: "windows",
      windows: [{ id: "window-legacy", layout: legacy, activeTabId: firstLayoutTabId(legacy) }],
      activeWindowId: "window-legacy",
    };
  }
  return null;
}

function mapWorkspaceTaskRow(row: WorkspaceTaskRow): WorkspaceTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    worktree: mapWorkspaceTaskWorktree(row.worktree_json),
    layout: mapWorkspaceTaskLayout(row.layout_json),
    status: (row.status === "done" ? "done" : "active") as WorkspaceTaskStatus,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function sessionPersistFields(): string {
  return `id, session_source, automation_id, command, cwd, mode, status, exit_code, started_at, ended_at, output, pty_output_seq
             , archived, archived_at, claude_session_id, provider, session_kind, runner, messages, queued_messages, queued_message_skills, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options, workspace_id, workspace_task_id`;
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
             pty_output_seq = excluded.pty_output_seq,
             archived = excluded.archived,
             archived_at = excluded.archived_at,
             claude_session_id = excluded.claude_session_id,
             provider = excluded.provider,
             session_kind = excluded.session_kind,
             runner = excluded.runner,
             messages = excluded.messages,
             queued_messages = excluded.queued_messages,
             queued_message_skills = excluded.queued_message_skills,
             structured_state = excluded.structured_state,
             resumed_from_session_id = excluded.resumed_from_session_id,
             auto_recovered = excluded.auto_recovered,
             worktree_enabled = excluded.worktree_enabled,
             worktree_info = excluded.worktree_info,
             worktree_merge_status = excluded.worktree_merge_status,
             worktree_merge_info = excluded.worktree_merge_info,
             title = excluded.title,
             description = excluded.description,
             session_options = excluded.session_options,
             workspace_id = excluded.workspace_id,
             workspace_task_id = excluded.workspace_task_id`;
}

function sessionRuntimeMetadataAssignments(): string {
  return `session_source = ?, automation_id = ?,
           command = ?, cwd = ?, mode = ?, status = ?, exit_code = ?,
           started_at = ?, ended_at = ?,
           archived = ?, archived_at = ?, claude_session_id = ?,
           provider = ?, session_kind = ?, runner = ?, queued_messages = ?, queued_message_skills = ?, structured_state = ?,
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
    snapshot.ptyOutputSeq ?? 0,
    snapshot.archived ? 1 : 0,
    snapshot.archivedAt,
    snapshot.claudeSessionId,
    snapshot.provider ?? null,
    snapshot.sessionKind ?? "pty",
    snapshot.runner ?? null,
    snapshot.messages ? JSON.stringify(snapshot.messages) : null,
    snapshot.queuedMessages ? JSON.stringify(snapshot.queuedMessages) : null,
    snapshot.queuedMessageSkills ? JSON.stringify(snapshot.queuedMessageSkills) : null,
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
    snapshot.workspaceId ?? null,
    snapshot.workspaceTaskId ?? null,
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
    snapshot.queuedMessageSkills ? JSON.stringify(snapshot.queuedMessageSkills) : null,
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
  const queuedMessages = parseQueuedMessages(row.queued_messages);
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
    ptyOutputSeq: row.pty_output_seq,
    archived: Boolean(row.archived),
    archivedAt: row.archived_at,
    claudeSessionId: row.claude_session_id,
    messages: safeJsonParse<ConversationTurn[]>(row.messages),
    queuedMessages,
    queuedMessageSkills: parseQueuedMessageSkills(row.queued_message_skills, queuedMessages?.length ?? 0),
    structuredState: safeJsonParse<StructuredSessionState>(row.structured_state),
    resumedFromSessionId: row.resumed_from_session_id ?? undefined,
    autoRecovered: Boolean(row.auto_recovered),
    worktreeEnabled: Boolean(row.worktree_enabled),
    worktree: parseWorktreeInfo(row.worktree_info) ?? null,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    workspaceTaskId: row.workspace_task_id ?? undefined,
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
    pty_output_seq INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    claude_session_id TEXT,
    provider TEXT,
    session_kind TEXT NOT NULL DEFAULT 'pty',
    runner TEXT,
    messages TEXT,
    queued_messages TEXT,
    queued_message_skills TEXT,
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

  CREATE TABLE IF NOT EXISTS session_directory_names (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    base_ref TEXT,
    shared_directories TEXT NOT NULL DEFAULT '[]',
    copy_paths TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mission_attempts (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    session_id TEXT,
    provider TEXT NOT NULL,
    state TEXT NOT NULL,
    branch TEXT,
    worktree_path TEXT,
    base_ref TEXT,
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(mission_id) REFERENCES missions(id)
  );

  CREATE TABLE IF NOT EXISTS mission_review_comments (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER,
    side TEXT NOT NULL DEFAULT 'new',
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    sent_at TEXT,
    resolved_at TEXT,
    FOREIGN KEY(mission_id) REFERENCES missions(id),
    FOREIGN KEY(attempt_id) REFERENCES mission_attempts(id)
  );

  CREATE TABLE IF NOT EXISTS agent_activity (
    session_id TEXT PRIMARY KEY,
    mission_id TEXT,
    attempt_id TEXT,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    provider TEXT,
    cwd TEXT,
    updated_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_missions_updated ON missions(updated_at);
  CREATE INDEX IF NOT EXISTS idx_mission_attempts_mission ON mission_attempts(mission_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_attempts_session ON mission_attempts(session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_mission_comments_attempt ON mission_review_comments(attempt_id, status);
  CREATE INDEX IF NOT EXISTS idx_agent_activity_state ON agent_activity(state, updated_at);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    default_provider TEXT,
    layout_json TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_cwd ON workspaces(cwd);
  CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened ON workspaces(last_opened_at);

  CREATE TABLE IF NOT EXISTS workspace_tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    worktree_json TEXT,
    layout_json TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_opened_at TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace ON workspace_tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_tasks_last_opened ON workspace_tasks(last_opened_at);
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

  // ============ Session Directory Names ============

  /** Return user-defined workspace labels keyed by normalized session cwd. */
  listSessionDirectoryNames(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT path, name FROM session_directory_names ORDER BY path ASC")
      .all() as unknown as Array<{ path: string; name: string }>;
    return new Map(rows.map((row) => [row.path, row.name]));
  }

  /** Set a workspace label, or remove it when name is null/blank. */
  setSessionDirectoryName(directoryPath: string, name: string | null): void {
    const normalizedPath = normalizeSessionDirectory(directoryPath);
    if (!normalizedPath) throw new Error("会话目录路径不能为空。");
    const normalizedName = name?.trim() ?? "";
    if (!normalizedName) {
      this.db.prepare("DELETE FROM session_directory_names WHERE path = ?").run(normalizedPath);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO session_directory_names (path, name, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at`
      )
      .run(normalizedPath, normalizedName, nowIso());
  }

  // ============ Workspaces（多标签 / 分屏项目）============

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, cwd, default_provider, layout_json, created_at, last_opened_at FROM workspaces ORDER BY COALESCE(last_opened_at, created_at) DESC"
      )
      .all() as unknown as WorkspaceRow[];
    return rows.map(mapWorkspaceRow);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db
      .prepare(
        "SELECT id, name, cwd, default_provider, layout_json, created_at, last_opened_at FROM workspaces WHERE id = ?"
      )
      .get(id) as unknown as WorkspaceRow | undefined;
    return row ? mapWorkspaceRow(row) : null;
  }

  createWorkspace(input: {
    name: string;
    cwd: string;
    defaultProvider?: WorkspaceDefaultProvider;
  }): Workspace {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, cwd, default_provider, layout_json, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL)`
      )
      .run(id, input.name, input.cwd, input.defaultProvider ?? null, createdAt);
    return {
      id,
      name: input.name,
      cwd: input.cwd,
      defaultProvider: input.defaultProvider,
      layout: null,
      createdAt,
      lastOpenedAt: null,
    };
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
    if (options.cascade) {
      this.db.prepare(
        `DELETE FROM command_sessions
         WHERE workspace_id = ?
            OR workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`,
      ).run(id, id);
    } else {
      // 解绑：保留会话，同时清空 workspace 与即将级联删除的 task 归属。
      this.db.prepare(
        `UPDATE command_sessions
         SET workspace_id = NULL, workspace_task_id = NULL
         WHERE workspace_id = ?
            OR workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`,
      ).run(id, id);
    }
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
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
    return rows.map((row) => this.mapSessionRow(row));
  }

  /** 显式更新某会话的工作空间归属（用于创建时绑定）。 */
  setSessionWorkspaceId(sessionId: string, workspaceId: string | null): void {
    this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE id = ?").run(workspaceId, sessionId);
  }

  /** Lightweight count of persisted sessions grouped by workspace. */
  countSessionsByWorkspace(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT workspace_id AS id, COUNT(*) AS n
         FROM command_sessions
         WHERE workspace_id IS NOT NULL AND workspace_id != ''
         GROUP BY workspace_id`,
      )
      .all() as unknown as Array<{ id: string; n: number }>;
    return new Map(rows.map((row) => [row.id, Number(row.n) || 0]));
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

  // ── Workspace tasks（任务 = 命名 + 独立 worktree + 一组标签）──

  listWorkspaceTasks(workspaceId: string): WorkspaceTask[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, name, worktree_json, layout_json, status, created_at, last_opened_at
         FROM workspace_tasks WHERE workspace_id = ?
         ORDER BY COALESCE(last_opened_at, created_at) DESC`
      )
      .all(workspaceId) as unknown as WorkspaceTaskRow[];
    return rows.map(mapWorkspaceTaskRow);
  }

  getWorkspaceTask(id: string): WorkspaceTask | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, name, worktree_json, layout_json, status, created_at, last_opened_at
         FROM workspace_tasks WHERE id = ?`
      )
      .get(id) as unknown as WorkspaceTaskRow | undefined;
    return row ? mapWorkspaceTaskRow(row) : null;
  }

  createWorkspaceTask(input: {
    workspaceId: string;
    name: string;
    worktree?: WorkspaceTaskWorktree | null;
    status?: WorkspaceTaskStatus;
  }): WorkspaceTask {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const status: WorkspaceTaskStatus = input.status ?? "active";
    this.db
      .prepare(
        `INSERT INTO workspace_tasks (id, workspace_id, name, worktree_json, layout_json, status, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.worktree ? JSON.stringify(input.worktree) : null,
        status,
        createdAt,
      );
    return {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      worktree: input.worktree ?? null,
      layout: null,
      status,
      createdAt,
      lastOpenedAt: null,
    };
  }

  updateWorkspaceTask(id: string, patch: {
    name?: string;
    status?: WorkspaceTaskStatus;
    worktree?: WorkspaceTaskWorktree | null;
  }): void {
    const assignments: string[] = [];
    const values: Array<string | null> = [];
    if (patch.name !== undefined) {
      assignments.push("name = ?");
      values.push(patch.name);
    }
    if (patch.status !== undefined) {
      assignments.push("status = ?");
      values.push(patch.status);
    }
    if (patch.worktree !== undefined) {
      assignments.push("worktree_json = ?");
      values.push(patch.worktree ? JSON.stringify(patch.worktree) : null);
    }
    if (assignments.length === 0) return;
    this.db.prepare(`UPDATE workspace_tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  saveWorkspaceTaskLayout(id: string, layout: TaskWindowLayout | null): void {
    this.db
      .prepare("UPDATE workspace_tasks SET layout_json = ? WHERE id = ?")
      .run(layout ? JSON.stringify(layout) : null, id);
  }

  touchWorkspaceTask(id: string): void {
    this.db.prepare("UPDATE workspace_tasks SET last_opened_at = ? WHERE id = ?").run(nowIso(), id);
  }

  deleteWorkspaceTask(id: string, options: { cascade?: boolean } = {}): void {
    if (options.cascade) {
      this.db.prepare("DELETE FROM command_sessions WHERE workspace_task_id = ?").run(id);
    } else {
      this.db.prepare("UPDATE command_sessions SET workspace_task_id = NULL WHERE workspace_task_id = ?").run(id);
    }
    this.db.prepare("DELETE FROM workspace_tasks WHERE id = ?").run(id);
  }

  listSessionsByWorkspaceTask(taskId: string): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE workspace_task_id = ?
         ORDER BY started_at DESC`
      )
      .all(taskId) as unknown as SessionRow[];
    return rows.map((row) => this.mapSessionRow(row));
  }

  setSessionWorkspaceTaskId(sessionId: string, taskId: string | null): void {
    this.db.prepare("UPDATE command_sessions SET workspace_task_id = ? WHERE id = ?").run(taskId, sessionId);
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

  // ============ Missions ============

  saveMission(mission: Mission): void {
    this.db.prepare(
      `INSERT INTO missions (
         id, title, prompt, cwd, status, base_ref, shared_directories, copy_paths, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, prompt = excluded.prompt, cwd = excluded.cwd,
         status = excluded.status, base_ref = excluded.base_ref,
         shared_directories = excluded.shared_directories, copy_paths = excluded.copy_paths,
         updated_at = excluded.updated_at`
    ).run(
      mission.id,
      mission.title,
      mission.prompt,
      mission.cwd,
      mission.status,
      mission.worktree.baseRef ?? null,
      JSON.stringify(mission.worktree.sharedDirectories ?? []),
      JSON.stringify(mission.worktree.copyPaths ?? []),
      mission.createdAt,
      mission.updatedAt,
    );
  }

  getMission(id: string): Mission | null {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapMissionRow(row) : null;
  }

  listMissions(includeArchived = false): Mission[] {
    const rows = this.db.prepare(
      `SELECT * FROM missions ${includeArchived ? "" : "WHERE status <> 'archived'"} ORDER BY updated_at DESC`
    ).all() as unknown as Record<string, unknown>[];
    return rows.map(mapMissionRow);
  }

  updateMissionStatus(id: string, status: MissionStatus, updatedAt = nowIso()): void {
    this.db.prepare("UPDATE missions SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
  }

  saveMissionAttempt(attempt: MissionAttempt): void {
    this.db.prepare(
      `INSERT INTO mission_attempts (
         id, mission_id, session_id, provider, state, branch, worktree_path, base_ref,
         summary, error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, state = excluded.state, branch = excluded.branch,
         worktree_path = excluded.worktree_path, base_ref = excluded.base_ref,
         summary = excluded.summary, error = excluded.error, updated_at = excluded.updated_at`
    ).run(
      attempt.id, attempt.missionId, attempt.sessionId, attempt.provider, attempt.state,
      attempt.branch, attempt.worktreePath, attempt.baseRef, attempt.summary, attempt.error,
      attempt.createdAt, attempt.updatedAt,
    );
  }

  getMissionAttempt(id: string): MissionAttempt | null {
    const row = this.db.prepare("SELECT * FROM mission_attempts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapMissionAttemptRow(row) : null;
  }

  getMissionAttemptBySession(sessionId: string): MissionAttempt | null {
    const row = this.db.prepare("SELECT * FROM mission_attempts WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapMissionAttemptRow(row) : null;
  }

  listMissionAttempts(missionId: string): MissionAttempt[] {
    const rows = this.db.prepare("SELECT * FROM mission_attempts WHERE mission_id = ? ORDER BY created_at ASC").all(missionId) as unknown as Record<string, unknown>[];
    return rows.map(mapMissionAttemptRow);
  }

  saveMissionReviewComment(comment: MissionReviewComment): void {
    this.db.prepare(
      `INSERT INTO mission_review_comments (
         id, mission_id, attempt_id, file_path, line, side, body, status, created_at, sent_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         file_path = excluded.file_path, line = excluded.line, side = excluded.side,
         body = excluded.body, status = excluded.status, sent_at = excluded.sent_at,
         resolved_at = excluded.resolved_at`
    ).run(
      comment.id, comment.missionId, comment.attemptId, comment.filePath, comment.line,
      comment.side, comment.body, comment.status, comment.createdAt, comment.sentAt, comment.resolvedAt,
    );
  }

  listMissionReviewComments(missionId: string, attemptId?: string): MissionReviewComment[] {
    const rows = attemptId
      ? this.db.prepare("SELECT * FROM mission_review_comments WHERE mission_id = ? AND attempt_id = ? ORDER BY created_at ASC").all(missionId, attemptId)
      : this.db.prepare("SELECT * FROM mission_review_comments WHERE mission_id = ? ORDER BY created_at ASC").all(missionId);
    return (rows as unknown as Record<string, unknown>[]).map(mapMissionReviewCommentRow);
  }

  updateMissionReviewStatus(ids: string[], status: MissionReviewStatus, at = nowIso()): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    const timestampColumn = status === "sent" ? "sent_at" : status === "resolved" ? "resolved_at" : null;
    const timestampSql = timestampColumn ? `, ${timestampColumn} = ?` : "";
    this.db.prepare(`UPDATE mission_review_comments SET status = ?${timestampSql} WHERE id IN (${placeholders})`)
      .run(status, ...(timestampColumn ? [at] : []), ...ids);
  }

  upsertAgentActivity(item: AgentActivityItem): void {
    this.db.prepare(
      `INSERT INTO agent_activity (
         session_id, mission_id, attempt_id, state, title, summary, provider, cwd, updated_at, read_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         mission_id = excluded.mission_id, attempt_id = excluded.attempt_id,
         state = excluded.state, title = excluded.title, summary = excluded.summary,
         provider = excluded.provider, cwd = excluded.cwd, updated_at = excluded.updated_at,
         read_at = CASE WHEN agent_activity.state = excluded.state THEN agent_activity.read_at ELSE excluded.read_at END`
    ).run(
      item.sessionId, item.missionId, item.attemptId, item.state, item.title,
      item.summary, item.provider, item.cwd, item.updatedAt, item.readAt,
    );
  }

  listAgentActivity(): AgentActivityItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM agent_activity
       ORDER BY CASE state WHEN 'needs_permission' THEN 0 WHEN 'needs_input' THEN 1 WHEN 'working' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
                updated_at DESC`
    ).all() as unknown as Record<string, unknown>[];
    return rows.map(mapAgentActivityRow);
  }

  markAgentActivityRead(sessionId?: string): void {
    const at = nowIso();
    if (sessionId) this.db.prepare("UPDATE agent_activity SET read_at = ? WHERE session_id = ?").run(at, sessionId);
    else this.db.prepare("UPDATE agent_activity SET read_at = ? WHERE read_at IS NULL").run(at);
  }

  saveSession(snapshot: SessionSnapshot): void {
    // A single SQLite statement is already atomic. Avoid BEGIN IMMEDIATE in
    // this hot path so streaming checkpoints do not take an unnecessary write
    // lock and saveSession can also participate in a caller-owned transaction.
    this.db
      .prepare(
        `INSERT INTO command_sessions (
         ${sessionPersistFields()}
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  checkpointSessionOutput(id: string, output: string, ptyOutputSeq?: number): void {
    if (ptyOutputSeq === undefined) {
      this.db.prepare("UPDATE command_sessions SET output = ? WHERE id = ?").run(output, id);
      return;
    }
    this.db.prepare("UPDATE command_sessions SET output = ?, pty_output_seq = ? WHERE id = ?")
      .run(output, ptyOutputSeq, id);
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
    ptyOutputSeq?: number,
  ): void {
    const assignments = ["messages = ?"];
    const values: Array<string | number | null> = [JSON.stringify(messages)];
    if (structuredState !== undefined) {
      assignments.push("structured_state = ?");
      values.push(structuredState ? JSON.stringify(structuredState) : null);
    }
    if (output !== undefined) {
      assignments.push("output = ?");
      values.push(output);
    }
    if (ptyOutputSeq !== undefined) {
      assignments.push("pty_output_seq = ?");
      values.push(ptyOutputSeq);
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

function mapMissionRow(row: Record<string, unknown>): Mission {
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    cwd: String(row.cwd),
    status: String(row.status) as MissionStatus,
    worktree: {
      baseRef: typeof row.base_ref === "string" ? row.base_ref : undefined,
      sharedDirectories: safeJsonParse<string[]>(typeof row.shared_directories === "string" ? row.shared_directories : null) ?? [],
      copyPaths: safeJsonParse<string[]>(typeof row.copy_paths === "string" ? row.copy_paths : null) ?? [],
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMissionAttemptRow(row: Record<string, unknown>): MissionAttempt {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
    provider: String(row.provider) as SessionProvider,
    state: String(row.state) as MissionAttemptState,
    branch: typeof row.branch === "string" ? row.branch : null,
    worktreePath: typeof row.worktree_path === "string" ? row.worktree_path : null,
    baseRef: typeof row.base_ref === "string" ? row.base_ref : null,
    summary: typeof row.summary === "string" ? row.summary : null,
    error: typeof row.error === "string" ? row.error : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMissionReviewCommentRow(row: Record<string, unknown>): MissionReviewComment {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    attemptId: String(row.attempt_id),
    filePath: String(row.file_path),
    line: typeof row.line === "number" ? row.line : null,
    side: row.side === "old" ? "old" : "new",
    body: String(row.body),
    status: String(row.status) as MissionReviewStatus,
    createdAt: String(row.created_at),
    sentAt: typeof row.sent_at === "string" ? row.sent_at : null,
    resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : null,
  };
}

function mapAgentActivityRow(row: Record<string, unknown>): AgentActivityItem {
  return {
    sessionId: String(row.session_id),
    missionId: typeof row.mission_id === "string" ? row.mission_id : null,
    attemptId: typeof row.attempt_id === "string" ? row.attempt_id : null,
    state: String(row.state) as AgentActivityState,
    title: String(row.title),
    summary: typeof row.summary === "string" ? row.summary : null,
    provider: typeof row.provider === "string" ? row.provider as SessionProvider : null,
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    updatedAt: String(row.updated_at),
    readAt: typeof row.read_at === "string" ? row.read_at : null,
  };
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
  ["queued_message_skills", "ALTER TABLE command_sessions ADD COLUMN queued_message_skills TEXT"],
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
  ["pty_output_seq", "ALTER TABLE command_sessions ADD COLUMN pty_output_seq INTEGER NOT NULL DEFAULT 0"],
  ["session_options", `ALTER TABLE command_sessions ADD COLUMN session_options TEXT NOT NULL DEFAULT '{"schemaVersion":1}'`],
  ["workspace_id", "ALTER TABLE command_sessions ADD COLUMN workspace_id TEXT"],
  ["workspace_task_id", "ALTER TABLE command_sessions ADD COLUMN workspace_task_id TEXT"],
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
