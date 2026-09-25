import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionSnapshot, ConversationTurn, SessionKind, SessionProvider, SessionRunner, SessionSource, StructuredSessionState, WorktreeMergeInfo, Workspace, LayoutNode, TaskWindowLayout, WorkspaceDefaultProvider, WorkspaceKind, WorkspaceTask, WorkspaceTaskWorktree, WorkspaceTaskStatus, GLOBAL_WORKSPACE_ID } from "./types.js";
import { normalizeSessionDirectory } from "./session-directory-tree.js";
import { inferProviderFromCommand, inferProviderFromRunner, isSessionProvider } from "./session-provider.js";
import { DEFAULT_ITERATION_NAME, DEFAULT_WAND_TASK_AGENT_KIND, DEFAULT_WAND_TASK_PRIORITY, isWandTaskAgentKind, normalizeWandTaskAgentMode } from "./task-types.js";
import { firstLayoutTabId } from "./layout-tree.js";
import { isThinkingEffort } from "./structured-provider-common.js";
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
  decryptVaultSecret,
  encryptVaultSecret,
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

interface ConnectorRow {
  provider: string;
  token: string;
  api_url: string;
  username: string | null;
  connected_at: string | null;
  updated_at: string;
}

export interface ConnectorMeta {
  provider: string;
  apiUrl: string | null;
  username: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

function safeJsonParse<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * `wand_tasks.agent_json` 的读侧校验。历史行 / 手工写坏的值都退化成 null，
 * 前端据此显示「未指定 CLI 工具」，而不是渲染出半个派发配置。
 */
export function parseWandTaskAgent(raw: unknown): import("./task-types.js").WandTaskAgent | null {
  const value = typeof raw === "string" ? safeJsonParse<Record<string, unknown>>(raw) : undefined;
  if (!value || typeof value !== "object") return null;
  const provider = value.provider;
  const model = value.model;
  const thinkingEffort = value.thinkingEffort;
  if (!isSessionProvider(provider)) return null;
  if (typeof model !== "string" || !model.trim() || model.trim().length > 128) return null;
  if (thinkingEffort !== "off" && thinkingEffort !== "standard" && thinkingEffort !== "deep" && thinkingEffort !== "max") return null;
  // mode 是后加列：历史行没有该字段时按标准模式读取，不因此整条配置退化成 null。
  const mode = normalizeWandTaskAgentMode(provider, value.mode);
  // kind 同样是后加字段：老数据 / 老客户端没带时按结构化会话读取。
  const kind = isWandTaskAgentKind(value.kind) ? value.kind : DEFAULT_WAND_TASK_AGENT_KIND;
  return { provider, model: model.trim(), thinkingEffort, mode, kind };
}

/** `wand_milestones` 行 → 领域对象；名字必须非空，脏行直接跳过。 */
function mapWandMilestoneRow(row: Record<string, unknown>): import("./task-types.js").WandTaskMilestone | null {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  return {
    id: String(row.id),
    name,
    dueDate: typeof row.due_date === "string" && row.due_date ? row.due_date : null,
    workspaceId: typeof row.workspace_id === "string" && row.workspace_id ? row.workspace_id : null,
    isDefault: Number(row.is_default) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** `wand_iteration_prompts` 行 → 领域对象；标题为空的脏行直接跳过。 */
function mapIterationPromptRow(row: Record<string, unknown>): import("./task-types.js").WandIterationPrompt | null {
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (!title) return null;
  return {
    id: String(row.id),
    milestoneId: String(row.milestone_id ?? ""),
    workspaceId: typeof row.workspace_id === "string" && row.workspace_id ? row.workspace_id : null,
    sessionId: typeof row.session_id === "string" && row.session_id ? row.session_id : null,
    taskId: typeof row.task_id === "string" && row.task_id ? row.task_id : null,
    repoKey: typeof row.repo_key === "string" && row.repo_key ? row.repo_key : null,
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    title,
    detail: typeof row.detail === "string" ? row.detail : "",
    source: row.source === "dispatch" ? "dispatch" : "session",
    consumedAt: typeof row.consumed_at === "string" && row.consumed_at ? row.consumed_at : null,
    consumedCommit: typeof row.consumed_commit === "string" && row.consumed_commit ? row.consumed_commit : null,
    createdAt: String(row.created_at),
  };
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

function serializeJsonOrNull(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
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

function sessionSelectFields(slim = false): string {
  return `id, session_source, automation_id, provider, session_kind, runner, command, cwd, mode, status, exit_code, started_at, ended_at, ${slim ? "'' AS output" : "output"}, pty_output_seq, archived, archived_at, claude_session_id, ${slim ? "NULL AS messages" : "messages"}, queued_messages, queued_message_skills, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options, workspace_id, workspace_task_id`;
}

interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  kind: string | null;
  default_provider: string | null;
  layout_json: string | null;
  created_at: string;
  last_opened_at: string | null;
}

function mapWorkspaceKind(raw: string | null | undefined): WorkspaceKind {
  return raw === "global" ? "global" : "project";
}

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    kind: mapWorkspaceKind(row.kind),
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
  cwd: string | null;
  milestone_id: string | null;
  created_at: string;
  last_opened_at: string | null;
  layout_revision: number | null;
}

function mapWorkspaceTaskWorktree(raw: string | null): WorkspaceTaskWorktree | null {
  const parsed = safeJsonParse<WorkspaceTaskWorktree>(raw);
  if (!parsed || typeof parsed.path !== "string" || typeof parsed.branch !== "string") return null;
  return parsed;
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
  const cwd = typeof row.cwd === "string" && row.cwd.trim() ? row.cwd : undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    worktree: mapWorkspaceTaskWorktree(row.worktree_json),
    ...(cwd ? { cwd } : {}),
    milestoneId: typeof row.milestone_id === "string" && row.milestone_id ? row.milestone_id : null,
    layout: mapWorkspaceTaskLayout(row.layout_json),
    status: (row.status === "done" ? "done" : "active") as WorkspaceTaskStatus,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    layoutRevision: Number(row.layout_revision ?? 0) || 0,
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
             workspace_id = command_sessions.workspace_id,
             workspace_task_id = command_sessions.workspace_task_id`;
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
    snapshot.archivedAt ?? null,
    snapshot.claudeSessionId ?? null,
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
    serializeJsonOrNull(snapshot.worktree),
    snapshot.worktreeMergeStatus ?? null,
    serializeJsonOrNull(snapshot.worktreeMergeInfo),
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
    snapshot.archivedAt ?? null,
    snapshot.claudeSessionId ?? null,
    snapshot.provider ?? null,
    snapshot.sessionKind ?? "pty",
    snapshot.runner ?? null,
    snapshot.queuedMessages ? JSON.stringify(snapshot.queuedMessages) : null,
    snapshot.queuedMessageSkills ? JSON.stringify(snapshot.queuedMessageSkills) : null,
    snapshot.structuredState ? JSON.stringify(snapshot.structuredState) : null,
    snapshot.resumedFromSessionId ?? null,
    snapshot.autoRecovered ? 1 : 0,
    snapshot.worktreeEnabled ? 1 : 0,
    serializeJsonOrNull(snapshot.worktree),
    snapshot.worktreeMergeStatus ?? null,
    serializeJsonOrNull(snapshot.worktreeMergeInfo),
    snapshot.title ?? null,
    snapshot.description ?? null,
    serializeSessionOptions(snapshot),
    snapshot.id,
  ];
}

function mapSessionCore(row: SessionRow): SessionSnapshot {
  const provider = isSessionProvider(row.provider)
    ? row.provider
    : (inferProviderFromRunner(row.runner) ?? inferProviderFromCommand(row.command));
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

const DEFAULT_DB_FILE = "wand.db";

type AuthPrincipalKind = "browser-admin" | "connected-app";
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

  CREATE TABLE IF NOT EXISTS connectors (
    provider TEXT PRIMARY KEY,
    token TEXT NOT NULL DEFAULT '',
    api_url TEXT NOT NULL DEFAULT '',
    username TEXT,
    connected_at TEXT,
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
    task_id TEXT,
    milestone_id TEXT,
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
    kind TEXT NOT NULL DEFAULT 'project',
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
    cwd TEXT,
    milestone_id TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT,
    layout_revision INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace ON workspace_tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_tasks_last_opened ON workspace_tasks(last_opened_at);

  CREATE TABLE IF NOT EXISTS github_issue_bindings (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (owner, repo, issue_number, session_id),
    FOREIGN KEY (session_id) REFERENCES command_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_github_issue_bindings_session ON github_issue_bindings(session_id);

  CREATE TABLE IF NOT EXISTS wand_milestones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    due_date TEXT,
    workspace_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wand_milestones_created ON wand_milestones(created_at DESC);

  -- 迭代提示词记录：用户在本轮迭代里发过的提示词标题，供 commit message / 汇报类生成复用。
  -- 不建外键：删除迭代只把记录改挂到默认迭代，绝不删记录。
  CREATE TABLE IF NOT EXISTS wand_iteration_prompts (
    id TEXT PRIMARY KEY,
    milestone_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    task_id TEXT,
    repo_key TEXT,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'session',
    consumed_at TEXT,
    consumed_commit TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_iteration ON wand_iteration_prompts(milestone_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_repo ON wand_iteration_prompts(repo_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_session ON wand_iteration_prompts(session_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS wand_tasks (
    id TEXT PRIMARY KEY,
    identifier TEXT,
    workspace_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'none',
    labels_json TEXT NOT NULL DEFAULT '[]',
    due_date TEXT,
    milestone_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    agent_json TEXT,
    workspace_task_id TEXT,
    parent_task_id TEXT,
    title_source TEXT,
    auto_title_signature TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wand_tasks_board ON wand_tasks(workspace_id, status, sort_order, updated_at);
  CREATE TABLE IF NOT EXISTS wand_task_sessions (
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (task_id, session_id),
    FOREIGN KEY (task_id) REFERENCES wand_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES command_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_wand_task_sessions_session ON wand_task_sessions(session_id);
`;

function ensureWandTaskSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(wand_tasks)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (columns.length > 0 && !names.has("identifier")) db.exec("ALTER TABLE wand_tasks ADD COLUMN identifier TEXT");
  if (columns.length > 0 && !names.has("due_date")) db.exec("ALTER TABLE wand_tasks ADD COLUMN due_date TEXT");
  // 任务的默认派发配置（CLI 工具 / 模型 / 思考深度）。只加列，历史行保持 NULL。
  if (columns.length > 0 && !names.has("agent_json")) db.exec("ALTER TABLE wand_tasks ADD COLUMN agent_json TEXT");
  if (columns.length > 0 && !names.has("workspace_task_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN workspace_task_id TEXT");
  // 父任务归属只加列；历史任务仍然是顶层任务。
  if (columns.length > 0 && !names.has("parent_task_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN parent_task_id TEXT");
  // 标题来源：'user' = 用户手写，'auto' = 由描述/会话内容自动生成。只加列，历史行保持 NULL（读取时视为 user）。
  if (columns.length > 0 && !names.has("title_source")) db.exec("ALTER TABLE wand_tasks ADD COLUMN title_source TEXT");
  // 自动标题最近一次的输入指纹：内容没变就不再重复总结（也避免自动标题来回震荡）。只加列。
  if (columns.length > 0 && !names.has("auto_title_signature")) db.exec("ALTER TABLE wand_tasks ADD COLUMN auto_title_signature TEXT");
  // 里程碑：只加列，历史行保持 NULL；里程碑本体在 wand_milestones（INIT_SQL 建表）。
  if (columns.length > 0 && !names.has("milestone_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN milestone_id TEXT");
  if (columns.length > 0) {
    // Index creation must wait until the column exists on legacy databases.
    // INIT_SQL cannot create it: CREATE TABLE IF NOT EXISTS is a no-op on old
    // wand_tasks, and CREATE INDEX would then fail with "no such column".
    db.exec("CREATE INDEX IF NOT EXISTS idx_wand_tasks_workspace_task ON wand_tasks(workspace_task_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wand_tasks_parent ON wand_tasks(parent_task_id)");
    const rows = db.prepare("SELECT id FROM wand_tasks WHERE identifier IS NULL OR identifier = '' ORDER BY created_at, id").all() as Array<{ id: string }>;
    const update = db.prepare("UPDATE wand_tasks SET identifier = ? WHERE id = ?");
    rows.forEach((row, index) => update.run(`TASK-${index + 1}`, row.id));
  }
}

function ensureWorkspaceSchema(db: DatabaseSync): void {
  const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  const workspaceNames = new Set(workspaceColumns.map((column) => column.name));
  if (workspaceColumns.length > 0 && !workspaceNames.has("kind")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'");
  }
  const taskColumns = db.prepare("PRAGMA table_info(workspace_tasks)").all() as Array<{ name: string }>;
  const taskNames = new Set(taskColumns.map((column) => column.name));
  if (taskColumns.length > 0 && !taskNames.has("cwd")) {
    db.exec("ALTER TABLE workspace_tasks ADD COLUMN cwd TEXT");
  }
  if (taskColumns.length > 0 && !taskNames.has("layout_revision")) {
    db.exec("ALTER TABLE workspace_tasks ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 0");
  }
  // 侧栏任务也记里程碑：建任务时把它带到看板卡片上，命名任务与未命名任务保持一致。
  if (taskColumns.length > 0 && !taskNames.has("milestone_id")) {
    db.exec("ALTER TABLE workspace_tasks ADD COLUMN milestone_id TEXT");
  }
}

function ensureWandMilestoneSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(wand_milestones)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  // 里程碑归属工作区：只加列，历史行保持 NULL（读作全局里程碑，所有工作区可见）。
  if (columns.length > 0 && !names.has("workspace_id")) {
    db.exec("ALTER TABLE wand_milestones ADD COLUMN workspace_id TEXT");
  }
  // 默认迭代标记：只加列，历史行保持 0（读作普通迭代）。
  if (columns.length > 0 && !names.has("is_default")) {
    db.exec("ALTER TABLE wand_milestones ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
  }
  if (columns.length > 0) {
    // 索引必须等列存在后再建：老库的 CREATE TABLE IF NOT EXISTS 是空操作，
    // 直接在 INIT_SQL 里建索引会因缺列报错。
    db.exec("CREATE INDEX IF NOT EXISTS idx_wand_milestones_workspace ON wand_milestones(workspace_id, created_at DESC)");
  }
}

/**
 * 迭代提示词记录表：新库由 INIT_SQL 建好，老库在这里补建（只加表，不改表）。
 * 空库（没建过任何表）时 PRAGMA 拿不到列，直接返回。
 */
function ensureIterationPromptSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(wand_iteration_prompts)").all() as Array<{ name: string }>;
  if (columns.length > 0) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS wand_iteration_prompts (
      id TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL,
      workspace_id TEXT,
      session_id TEXT,
      task_id TEXT,
      repo_key TEXT,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'session',
      consumed_at TEXT,
      consumed_commit TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_iteration ON wand_iteration_prompts(milestone_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_repo ON wand_iteration_prompts(repo_key, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_wand_iteration_prompts_session ON wand_iteration_prompts(session_id, created_at DESC)");
}

function ensureConnectorSchema(db: DatabaseSync): void {
  // The table is created by INIT_SQL for new databases; this repairs an
  // existing wand.db that predates the connector feature (additive-only).
  const columns = db.prepare("PRAGMA table_info(connectors)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.size === 0) return;
  const migrations: ReadonlyArray<[column: string, sql: string]> = [
    ["api_url", "ALTER TABLE connectors ADD COLUMN api_url TEXT NOT NULL DEFAULT ''"],
    ["username", "ALTER TABLE connectors ADD COLUMN username TEXT"],
    ["connected_at", "ALTER TABLE connectors ADD COLUMN connected_at TEXT"],
  ];
  for (const [column, sql] of migrations) {
    if (!names.has(column)) db.exec(sql);
  }
}

export function ensureDatabaseFile(dbPath: string): boolean {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const created = !existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(INIT_SQL);
  ensureAuthSessionSchema(db);
  ensureCommandSessionSchema(db);
  ensureWorkspaceSchema(db);
  ensureWandTaskSchema(db);
  ensureWandMilestoneSchema(db);
  ensureIterationPromptSchema(db);
  ensureConnectorSchema(db);
  {
    const missionColumns = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
    if (missionColumns.length > 0 && !missionColumns.some((column) => column.name === "task_id")) {
      db.exec("ALTER TABLE missions ADD COLUMN task_id TEXT");
    }
    // 并行任务的里程碑与看板共用同一份列表；只加列，历史行保持 NULL。
    if (missionColumns.length > 0 && !missionColumns.some((column) => column.name === "milestone_id")) {
      db.exec("ALTER TABLE missions ADD COLUMN milestone_id TEXT");
    }
  }
  db.close();
  chmodSync(dbPath, 0o600);
  return created;
}

export class WandStorage {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(INIT_SQL);
    ensureAuthSessionSchema(this.db);
    ensureCommandSessionSchema(this.db);
    ensureWorkspaceSchema(this.db);
    ensureWandTaskSchema(this.db);
    ensureWandMilestoneSchema(this.db);
    ensureIterationPromptSchema(this.db);
    ensureConnectorSchema(this.db);
    this.ensureDefaultPasswordVault();
  }

  directory(): string {
    return path.dirname(this.dbPath);
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

  // ============ 首页目录组顺序 ============

  /**
   * 用户在首页拖动排序后的目录组顺序（服务端偏好，所有客户端共用）。
   * 存的是客户端看到的组 id：真实工作区用 workspace id，合成目录用 `cwd:<规范化路径>`。
   * 不存在的 id 只是被忽略，不影响渲染。
   */
  getWorkspaceGroupOrder(): string[] {
    const stored = this.getPreference<unknown>(WORKSPACE_GROUP_ORDER_KEY, []);
    if (!Array.isArray(stored)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of stored) {
      if (typeof value !== "string") continue;
      const id = value.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  setWorkspaceGroupOrder(ids: string[]): void {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const value of ids) {
      const id = typeof value === "string" ? value.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      cleaned.push(id);
    }
    // 空顺序等于「没设置过」，回到默认排序，而不是存一个空数组。
    this.setPreference(WORKSPACE_GROUP_ORDER_KEY, cleaned.length > 0 ? cleaned : null);
  }

  /** 工作区被删除后，把它的排序位也清掉，避免 id 被复用后继承旧位置。 */
  forgetWorkspaceGroupOrder(id: string): void {
    const current = this.getWorkspaceGroupOrder();
    if (!current.includes(id)) return;
    this.setWorkspaceGroupOrder(current.filter((item) => item !== id));
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
    const scratch = path.join(this.directory(), "scratch");
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
    this.forgetWorkspaceGroupOrder(id);
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
  getSessionWorkspace(sessionId: string): Pick<SessionSnapshot, "workspaceId" | "workspaceTaskId"> | null {
    const row = this.db.prepare("SELECT workspace_id, workspace_task_id FROM command_sessions WHERE id = ?")
      .get(sessionId) as { workspace_id: string | null; workspace_task_id: string | null } | undefined;
    return row ? { workspaceId: row.workspace_id ?? undefined, workspaceTaskId: row.workspace_task_id ?? undefined } : null;
  }

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

  /** 侧栏任务顺序：新创建在前。GET /api/tasks 按此顺序填充目录组。 */
  listWorkspaceTasks(workspaceId: string): WorkspaceTask[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, name, worktree_json, layout_json, status, cwd, milestone_id, created_at, last_opened_at, layout_revision
         FROM workspace_tasks WHERE workspace_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(workspaceId) as unknown as WorkspaceTaskRow[];
    return rows.map(mapWorkspaceTaskRow);
  }

  getWorkspaceTask(id: string): WorkspaceTask | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, name, worktree_json, layout_json, status, cwd, milestone_id, created_at, last_opened_at, layout_revision
         FROM workspace_tasks WHERE id = ?`
      )
      .get(id) as unknown as WorkspaceTaskRow | undefined;
    return row ? mapWorkspaceTaskRow(row) : null;
  }

  createWorkspaceTask(input: {
    workspaceId: string;
    name: string;
    worktree?: WorkspaceTaskWorktree | null;
    cwd?: string | null;
    status?: WorkspaceTaskStatus;
    milestoneId?: string | null;
  }): WorkspaceTask {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const status: WorkspaceTaskStatus = input.status ?? "active";
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : null;
    const milestoneId = typeof input.milestoneId === "string" && input.milestoneId ? input.milestoneId : null;
    this.db
      .prepare(
        `INSERT INTO workspace_tasks (id, workspace_id, name, worktree_json, layout_json, status, cwd, milestone_id, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.worktree ? JSON.stringify(input.worktree) : null,
        status,
        cwd,
        milestoneId,
        createdAt,
      );
    return {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      worktree: input.worktree ?? null,
      ...(cwd ? { cwd } : {}),
      milestoneId,
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
    milestoneId?: string | null;
    workspaceId?: string;
  }): void {
    const assignments: string[] = [];
    const values: Array<string | null> = [];
    if (patch.workspaceId !== undefined) {
      assignments.push("workspace_id = ?");
      values.push(patch.workspaceId);
    }
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
    if (patch.milestoneId !== undefined) {
      assignments.push("milestone_id = ?");
      values.push(patch.milestoneId || null);
    }
    if (assignments.length === 0) return;
    this.db.prepare(`UPDATE workspace_tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
    const card = this.getWandTaskByWorkspaceTaskId(id);
    if (card) {
      // Reverse projection uses direct SQL, so these writers cannot recurse.
      this.updateWandTask(card.id, {
        ...(patch.name !== undefined ? { title: patch.name, titleSource: "user" as const } : {}),
        ...(patch.milestoneId !== undefined ? { milestoneId: patch.milestoneId } : {}),
        ...(patch.status !== undefined ? {
          status: patch.status === "done"
            ? card.status === "archived" ? "archived" as const : "done" as const
            : card.status === "todo" ? "todo" as const : "doing" as const,
        } : {}),
      });
    }
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
    if (options.cascade) {
      this.db.prepare("DELETE FROM command_sessions WHERE workspace_task_id = ?").run(id);
    } else {
      this.db.prepare("UPDATE command_sessions SET workspace_task_id = NULL WHERE workspace_task_id = ?").run(id);
    }
    this.db.prepare("DELETE FROM workspace_tasks WHERE id = ?").run(id);
  }

  tasksAggregateFingerprint(): string {
    const sessions = this.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(MAX(started_at), '') AS started,
              COALESCE(MAX(ended_at), '') AS ended,
              COALESCE(MAX(title), '') AS title
       FROM command_sessions`
    ).get() as { count: number; started: string; ended: string; title: string };
    // Per-task metadata catches edits even when another task owns the maximum
    // timestamp/revision. Layout payloads are represented by their own revision.
    const tasks = this.db.prepare(
      `SELECT id, workspace_id, name, status, cwd, worktree_json, milestone_id,
              created_at, last_opened_at, layout_revision
       FROM workspace_tasks ORDER BY id`
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

  /** GET /api/wand-tasks 的顺序：新创建在前。客户端按此顺序渲染，不再本地排序。 */
  listWandTasks(workspaceId?: string | null): import("./task-types.js").WandTask[] {
    const rows = this.db.prepare(
      `SELECT id, identifier, workspace_id, workspace_task_id, parent_task_id, title, title_source, auto_title_signature, description, status, priority, labels_json, due_date, milestone_id, sort_order, agent_json, created_at, updated_at
       FROM wand_tasks ${workspaceId === undefined ? "" : "WHERE workspace_id IS ?"}
       ORDER BY created_at DESC, rowid DESC`,
    ).all(...(workspaceId === undefined ? [] : [workspaceId])) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapWandTaskRow(row));
  }

  private mapWandTaskRow(row: Record<string, unknown>): import("./task-types.js").WandTask {
    return {
      id: String(row.id),
      identifier: typeof row.identifier === "string" && row.identifier ? row.identifier : `TASK-${String(row.id).slice(0, 6)}`,
      workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
      workspaceTaskId: typeof row.workspace_task_id === "string" && row.workspace_task_id ? row.workspace_task_id : null,
      parentTaskId: typeof row.parent_task_id === "string" && row.parent_task_id ? row.parent_task_id : null,
      title: String(row.title),
      titleSource: row.title_source === "auto" ? "auto" : "user",
      autoTitleSignature: typeof row.auto_title_signature === "string" && row.auto_title_signature ? row.auto_title_signature : null,
      description: String(row.description ?? ""),
      status: row.status === "doing" || row.status === "done" || row.status === "archived" ? row.status : "todo",
      priority: row.priority === "low" || row.priority === "medium" || row.priority === "high" || row.priority === "urgent" ? row.priority : "none",
      labels: (() => { const parsed = safeJsonParse<unknown>(String(row.labels_json ?? "[]")); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; })(),
      dueDate: typeof row.due_date === "string" ? row.due_date : null,
      milestoneId: typeof row.milestone_id === "string" && row.milestone_id ? row.milestone_id : null,
      sortOrder: Number(row.sort_order) || 0,
      agent: parseWandTaskAgent(row.agent_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getWandTask(id: string): import("./task-types.js").WandTask | null {
    return this.listWandTasks().find((task) => task.id === id) ?? null;
  }

  getWandTaskByWorkspaceTaskId(workspaceTaskId: string): import("./task-types.js").WandTask | null {
    const row = this.db.prepare(
      `SELECT id, identifier, workspace_id, workspace_task_id, parent_task_id, title, title_source, auto_title_signature, description, status, priority, labels_json, due_date, milestone_id, sort_order, agent_json, created_at, updated_at
       FROM wand_tasks WHERE workspace_task_id = ? ORDER BY updated_at DESC LIMIT 1`,
    ).get(workspaceTaskId) as Record<string, unknown> | undefined;
    return row ? this.mapWandTaskRow(row) : null;
  }

  createWandTask(input: { workspaceId?: string | null; workspaceTaskId?: string | null; parentTaskId?: string | null; title: string; titleSource?: import("./task-types.js").WandTaskTitleSource; description?: string; status?: import("./task-types.js").WandTaskStatus; priority?: import("./task-types.js").WandTaskPriority; labels?: string[]; dueDate?: string | null; milestoneId?: string | null; agent?: import("./task-types.js").WandTaskAgent | null }): import("./task-types.js").WandTask {
    const id = crypto.randomUUID(); const now = nowIso();
    const status = input.status ?? "todo"; const priority = input.priority ?? DEFAULT_WAND_TASK_PRIORITY;
    const max = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM wand_tasks WHERE workspace_id IS ? AND status = ?").get(input.workspaceId ?? null, status) as { value?: number } | undefined;
    const numberRow = this.db.prepare("SELECT COALESCE(MAX(CAST(substr(identifier, 6) AS INTEGER)), 0) AS value FROM wand_tasks WHERE identifier GLOB 'TASK-[0-9]*'").get() as { value?: number } | undefined;
    const identifier = `TASK-${(numberRow?.value ?? 0) + 1}`;
    this.db.prepare(`INSERT INTO wand_tasks (id, identifier, workspace_id, workspace_task_id, parent_task_id, title, title_source, auto_title_signature, description, status, priority, labels_json, due_date, milestone_id, sort_order, agent_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, identifier, input.workspaceId ?? null, input.workspaceTaskId ?? null, input.parentTaskId ?? null, input.title, input.titleSource ?? "user", null, input.description ?? "", status, priority, JSON.stringify(input.labels ?? []), input.dueDate ?? null, input.milestoneId ?? null, (max?.value ?? -1) + 1, input.agent ? JSON.stringify(input.agent) : null, now, now);
    return this.getWandTask(id)!;
  }

  updateWandTask(id: string, patch: Partial<Pick<import("./task-types.js").WandTask, "workspaceId" | "workspaceTaskId" | "parentTaskId" | "title" | "titleSource" | "autoTitleSignature" | "description" | "status" | "priority" | "labels" | "dueDate" | "milestoneId" | "sortOrder" | "agent">>): import("./task-types.js").WandTask | null {
    const current = this.getWandTask(id); if (!current) return null;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db.prepare(`UPDATE wand_tasks SET workspace_id = ?, workspace_task_id = ?, parent_task_id = ?, title = ?, title_source = ?, auto_title_signature = ?, description = ?, status = ?, priority = ?, labels_json = ?, due_date = ?, milestone_id = ?, sort_order = ?, agent_json = ?, updated_at = ? WHERE id = ?`).run(next.workspaceId, next.workspaceTaskId, next.parentTaskId, next.title, next.titleSource, next.autoTitleSignature ?? null, next.description, next.status, next.priority, JSON.stringify(next.labels), next.dueDate, next.milestoneId ?? null, next.sortOrder, next.agent ? JSON.stringify(next.agent) : null, next.updatedAt, id);
    if (next.workspaceTaskId) {
      const workspaceId = next.workspaceId ?? this.ensureGlobalWorkspace().id;
      this.db.prepare(`UPDATE workspace_tasks SET name = ?, status = ?, milestone_id = ?, workspace_id = ? WHERE id = ?`)
        .run(next.title, next.status === "done" || next.status === "archived" ? "done" : "active",
          next.milestoneId ?? null, workspaceId, next.workspaceTaskId);
      this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE workspace_task_id = ?")
        .run(workspaceId, next.workspaceTaskId);
    }
    return next;
  }

  deleteWandTask(id: string): void {
    this.db.prepare("UPDATE wand_tasks SET parent_task_id = NULL WHERE parent_task_id = ?").run(id);
    this.db.prepare("DELETE FROM wand_tasks WHERE id = ?").run(id);
  }

  // ── 里程碑（迭代，归属工作区；任务只存 milestoneId）──

  /**
   * 里程碑列表。传工作区 id 时返回「该工作区 + 全局（workspace_id IS NULL）」；
   * 未指定工作区（null / undefined / 空串）时返回全部。
   */
  listWandMilestones(workspaceId?: string | null): import("./task-types.js").WandTaskMilestone[] {
    const scoped = typeof workspaceId === "string" ? workspaceId.trim() : "";
    const select = "SELECT id, name, due_date, workspace_id, is_default, created_at, updated_at FROM wand_milestones";
    // 默认迭代永远排最前：新建任务的下拉把它放在第一项，不选时也回落到它。
    const order = " ORDER BY is_default DESC, created_at DESC, rowid DESC";
    const rows = (scoped
      ? this.db.prepare(`${select} WHERE workspace_id = ? OR workspace_id IS NULL${order}`).all(scoped)
      : this.db.prepare(`${select}${order}`).all()) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapWandMilestoneRow).filter((item): item is import("./task-types.js").WandTaskMilestone => item !== null);
  }

  getWandMilestone(id: string): import("./task-types.js").WandTaskMilestone | null {
    const row = this.db.prepare(
      `SELECT id, name, due_date, workspace_id, is_default, created_at, updated_at FROM wand_milestones WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapWandMilestoneRow(row) : null;
  }

  /** 已有的默认迭代；未创建过时返回 null（读路径用它，不写库）。 */
  findDefaultWandMilestone(): import("./task-types.js").WandTaskMilestone | null {
    const row = this.db.prepare(
      `SELECT id, name, due_date, workspace_id, is_default, created_at, updated_at FROM wand_milestones WHERE is_default = 1 ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    return row ? mapWandMilestoneRow(row) : null;
  }

  /**
   * 惰性拿到全局唯一的「默认迭代」：没有就建一个，返回值一定可写进任务 / 记录。
   * 用户已经自己建过一个同名迭代时直接把它提升为默认，不再造第二个重名行。
   */
  ensureDefaultWandMilestone(): import("./task-types.js").WandTaskMilestone {
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

  createWandMilestone(input: { name: string; dueDate?: string | null; workspaceId?: string | null; isDefault?: boolean }): import("./task-types.js").WandTaskMilestone {
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

  updateWandMilestone(id: string, patch: { name?: string; dueDate?: string | null; workspaceId?: string | null }): import("./task-types.js").WandTaskMilestone | null {
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

  // ============ 迭代提示词记录 ============

  /** 同一会话最近一条记录；用来去重（同一提示词重复提交 / 占位与模型结果双写）。 */
  latestIterationPromptForSession(sessionId: string): import("./task-types.js").WandIterationPrompt | null {
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
    source?: import("./task-types.js").WandIterationPromptSource;
  }): import("./task-types.js").WandIterationPrompt {
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
  } = {}): import("./task-types.js").WandIterationPrompt[] {
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
    return rows.map(mapIterationPromptRow).filter((item): item is import("./task-types.js").WandIterationPrompt => item !== null);
  }

  /** 按 id 批量取记录（用户只勾选了一部分历史变更时用）。 */
  listIterationPromptsByIds(ids: readonly string[]): import("./task-types.js").WandIterationPrompt[] {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 500);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT * FROM wand_iteration_prompts WHERE id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
    ).all(...unique) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapIterationPromptRow).filter((item): item is import("./task-types.js").WandIterationPrompt => item !== null);
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

  // ============ 会话 → 任务 / 迭代 ============

  /** 会话绑定的看板任务 id；没绑或已删除时返回 null。 */
  getWandTaskIdForSession(sessionId: string): string | null {
    const row = this.db.prepare(
      "SELECT task_id FROM wand_task_sessions WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(sessionId) as { task_id?: string } | undefined;
    return row?.task_id || null;
  }

  listWandTaskSessionIds(taskId: string): string[] {
    const rows = this.db.prepare("SELECT session_id FROM wand_task_sessions WHERE task_id = ? ORDER BY rowid ASC, session_id ASC").all(taskId) as unknown as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  listBoundWandTaskSessionIds(): string[] {
    const rows = this.db.prepare("SELECT session_id FROM wand_task_sessions").all() as unknown as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  bindWandTaskSession(taskId: string, sessionId: string): void {
    if (!this.getWandTask(taskId)) throw new Error("未找到该任务。");
    if (!this.getSession(sessionId)) throw new Error("未找到该会话。");
    this.db.prepare("DELETE FROM wand_task_sessions WHERE session_id = ? AND task_id != ?").run(sessionId, taskId);
    this.db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)").run(taskId, sessionId, nowIso());
  }

  unbindWandTaskSession(taskId: string, sessionId: string): void { this.db.prepare("DELETE FROM wand_task_sessions WHERE task_id = ? AND session_id = ?").run(taskId, sessionId); }

  listGithubIssueBindings(owner: string, repo: string, issueNumber: number): Array<{ sessionId: string; boundAt: string }> {
    const rows = this.db.prepare(
      `SELECT session_id, bound_at FROM github_issue_bindings
       WHERE owner = ? AND repo = ? AND issue_number = ? ORDER BY bound_at ASC`,
    ).all(owner, repo, issueNumber) as unknown as Array<{ session_id: string; bound_at: string }>;
    return rows.map((row) => ({ sessionId: row.session_id, boundAt: row.bound_at }));
  }

  bindGithubIssueSession(owner: string, repo: string, issueNumber: number, sessionId: string): void {
    if (!this.getSession(sessionId)) throw new Error("未找到该会话。");
    this.db.prepare(
      `INSERT OR IGNORE INTO github_issue_bindings (owner, repo, issue_number, session_id, bound_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(owner, repo, issueNumber, sessionId, nowIso());
  }

  unbindGithubIssueSession(owner: string, repo: string, issueNumber: number, sessionId: string): void {
    this.db.prepare(
      `DELETE FROM github_issue_bindings WHERE owner = ? AND repo = ? AND issue_number = ? AND session_id = ?`,
    ).run(owner, repo, issueNumber, sessionId);
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

  /**
   * 同 `listSessionsByWorkspaceTask`，但不读 `output`/`messages` 大字段。
   *
   * 侧栏的目录组、任务详情、自动命名只需要元数据；完整行会把整个会话消息
   * 历史 JSON 解析一遍（单会话可达十几 MB），每轮轮询都会卡住事件循环。
   */
  listSessionsByWorkspaceTaskSlim(taskId: string): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT ${sessionSelectFields(true)}
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

  /** Encrypt an at-rest secret with the vault key; plaintext when no key exists. */
  private encryptStoredSecret(value: string | undefined): string | null {
    if (!value) return null;
    const secret = this.getAppSecret();
    return secret ? encryptVaultSecret(value, secret) : value;
  }

  private decryptPasswordItem(item: PasswordItemRowFields, raw: PasswordVaultItemRow): PasswordVaultItem {
    const secret = this.getAppSecret();
    const notes = decryptVaultSecret(raw.notes ?? undefined, secret);
    const fieldsJson = decryptVaultSecret(raw.fields, secret) ?? raw.fields;
    return {
      ...item,
      password: decryptVaultSecret(raw.password ?? undefined, secret),
      notes,
      fields: decodePasswordFields(fieldsJson),
    };
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
    return rows.map((row) => this.decryptPasswordItem(mapPasswordItemRow(row), row))
      .filter((item) => itemMatchesFilter(item, filter)).slice(0, limit);
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
    return row ? this.decryptPasswordItem(mapPasswordItemRow(row), row) : null;
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
        this.encryptStoredSecret(normalized.password),
        JSON.stringify(normalized.urls),
        this.encryptStoredSecret(normalized.notes),
        this.encryptStoredSecret(JSON.stringify(normalized.fields)) ?? "{}",
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
        this.encryptStoredSecret(normalized.password),
        JSON.stringify(normalized.urls),
        this.encryptStoredSecret(normalized.notes),
        this.encryptStoredSecret(JSON.stringify(normalized.fields)) ?? "{}",
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

  // ============ Connector Methods ============
  // 第三方服务凭据（GitHub 等）。token 用与密码库同一把 at-rest 密钥加密，
  // 解密只在服务端发生，绝不通过 /api/settings 回传明文。

  getConnectorToken(provider: string): string | null {
    const row = this.db
      .prepare("SELECT token FROM connectors WHERE provider = ?")
      .get(provider) as { token: string } | undefined;
    if (!row) return null;
    const decrypted = decryptVaultSecret(row.token, this.getAppSecret());
    return decrypted ?? "";
  }

  getConnectorMeta(provider: string): ConnectorMeta | null {
    const row = this.db
      .prepare("SELECT provider, api_url, username, connected_at, updated_at FROM connectors WHERE provider = ?")
      .get(provider) as ConnectorRow | undefined;
    if (!row) return null;
    return {
      provider: row.provider,
      apiUrl: row.api_url || null,
      username: row.username ?? null,
      connectedAt: row.connected_at ?? null,
      updatedAt: row.updated_at,
    };
  }

  saveConnector(
    provider: string,
    input: { token?: string | null; apiUrl?: string | null; username?: string | null; markConnected?: boolean },
  ): ConnectorMeta {
    const now = nowIso();
    const existing = this.getConnectorMeta(provider);
    const token = input.token === undefined || input.token === null || input.token === ""
      ? this.getConnectorToken(provider) ?? ""
      : input.token;
    const apiUrl = input.apiUrl === undefined ? (existing?.apiUrl ?? "") : input.apiUrl;
    const username = input.username === undefined ? (existing?.username ?? null) : input.username;
    const connectedAt = input.markConnected === false ? (existing?.connectedAt ?? now) : now;
    const encrypted = this.encryptConnectorToken(token);
    this.db.prepare(
      `INSERT INTO connectors (provider, token, api_url, username, connected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         token = excluded.token,
         api_url = excluded.api_url,
         username = excluded.username,
         connected_at = excluded.connected_at,
         updated_at = excluded.updated_at`,
    ).run(provider, encrypted, apiUrl, username, connectedAt, now, now);
    return { provider, apiUrl: apiUrl || null, username, connectedAt, updatedAt: now };
  }

  deleteConnector(provider: string): boolean {
    return this.db.prepare("DELETE FROM connectors WHERE provider = ?").run(provider).changes > 0;
  }

  private encryptConnectorToken(token: string): string {
    return this.encryptStoredSecret(token) ?? "";
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
         id, title, prompt, cwd, status, base_ref, shared_directories, copy_paths, created_at, updated_at, task_id, milestone_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, prompt = excluded.prompt, cwd = excluded.cwd,
         status = excluded.status, base_ref = excluded.base_ref,
         shared_directories = excluded.shared_directories, copy_paths = excluded.copy_paths,
         updated_at = excluded.updated_at, task_id = excluded.task_id,
         milestone_id = excluded.milestone_id`
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
      mission.taskId ?? null,
      mission.milestoneId ?? null,
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

  /** 同 `getSession`，但不读 `output`/`messages` 大字段（只取元数据的路径用）。 */
  getSessionSlim(id: string): SessionSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT ${sessionSelectFields(true)}
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

  /** List durable metadata without reading or parsing output/messages payloads. */
  loadSessionsSlim(): SessionSnapshot[] {
    const rows = this.db.prepare(
      `SELECT ${sessionSelectFields(true)} FROM command_sessions ORDER BY started_at DESC`
    ).all() as unknown as SessionRow[];
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
    taskId: typeof row.task_id === "string" ? row.task_id : null,
    milestoneId: typeof row.milestone_id === "string" && row.milestone_id ? row.milestone_id : null,
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

type PasswordItemRowFields = Omit<PasswordVaultItem, "fields">;

/** Parse the (possibly encrypted) `fields` JSON column into a string map. */
function decodePasswordFields(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function mapPasswordItemRow(row: PasswordVaultItemRow): PasswordItemRowFields {
  return {
    id: row.id,
    vaultId: row.vault_id,
    type: row.type,
    title: row.title,
    username: row.username ?? undefined,
    urls: safeJsonParse<string[]>(row.urls)?.filter((item): item is string => typeof item === "string") ?? [],
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
  // Legacy column: never written by current persist helpers. Kept because
  // schema migrations are additive-only and must not DROP columns.
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

/** 首页目录组顺序的偏好键（app_config 表，与其它 UI 偏好同一套读写）。 */
const WORKSPACE_GROUP_ORDER_KEY = "workspaceGroupOrder";

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
  if (columns.length > 0) {
    // 侧栏 / 任务面板按 workspace_task_id 反复拉会话：没有索引时每次都是
    // 46MB 表全扫（单次 ~500ms），而 command_sessions 里有 10MB+ 的 output/
    // messages 溢出行。索引只加不删，老库首次启动时建一次。
    db.exec("CREATE INDEX IF NOT EXISTS idx_command_sessions_workspace_task ON command_sessions(workspace_task_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_command_sessions_workspace ON command_sessions(workspace_id)");
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
