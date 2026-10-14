import { legacyPtyRoleIdentity } from "../default-employee.js";
import path from "node:path";
import { parseHarnessExtensionState } from "../core-extension-host.js";
import { firstLayoutTabId } from "../layout-tree.js";
import { type PasswordVaultItemType } from "../password-manager.js";
import { defaultPiSessionSettings, patchPiSessionSettings } from "../pi-session-settings.js";
import { inferProviderFromCommand, inferProviderFromRunner, isSessionProvider } from "../session-provider.js";
import { isThinkingEffort } from "../structured-provider-common.js";
import type { WandTaskAgent } from "../task-types.js";
import { DEFAULT_WAND_TASK_AGENT_KIND, isWandTaskAgentEngine, isWandTaskAgentKind, normalizeWandTaskAgentMode } from "../task-types.js";
import { ConversationTurn, HarnessSessionContext, LayoutNode, SessionKind, SessionProvider, SessionRunner, SessionSnapshot, SessionSource, StructuredSessionState, TaskWindowLayout, Workspace, WorkspaceKind, WorkspaceTask, WorkspaceTaskStatus, WorkspaceTaskWorktree, WorktreeMergeInfo } from "../types.js";
import type { WandTaskMilestone, WandIterationPrompt } from "../task-types.js";



export interface SessionRow {
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
  completion_revision: number;
  viewed_completion_revision: number;
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

export interface PasswordVaultRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface PasswordVaultItemRow {
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

export interface ConnectorRow {
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

export function safeJsonParse<T>(raw: string | null): T | undefined {
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
export function parseWandTaskAgent(raw: unknown): WandTaskAgent | null {
  const value = typeof raw === "string"
    ? safeJsonParse<Record<string, unknown>>(raw)
    : raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : undefined;
  if (!value || typeof value !== "object") return null;
  const provider = value.provider;
  const model = value.model;
  const thinkingEffort = value.thinkingEffort;
  if (!isSessionProvider(provider)) return null;
  if (typeof model !== "string" || !model.trim() || model.trim().length > 128) return null;
  if (!isThinkingEffort(thinkingEffort)) return null;
  // mode 是后加列：历史行没有该字段时按标准模式读取，不因此整条配置退化成 null。
  const mode = normalizeWandTaskAgentMode(provider, value.mode);
  // kind 同样是后加字段：老数据 / 老客户端没带时按结构化会话读取。
  const kind = isWandTaskAgentKind(value.kind) ? value.kind : DEFAULT_WAND_TASK_AGENT_KIND;
  const engine = value.engine === undefined || value.engine === null || value.engine === ""
    ? undefined
    : isWandTaskAgentEngine(value.engine) ? value.engine : null;
  if (engine === null || (engine === "sdk" && (provider !== "pi" || kind !== "structured"))) return null;
  return { provider, model: model.trim(), thinkingEffort, mode, kind, ...(engine === "sdk" ? { engine } : {}) };
}

/** `wand_milestones` 行 → 领域对象；名字必须非空，脏行直接跳过。 */
export function mapWandMilestoneRow(row: Record<string, unknown>): WandTaskMilestone | null {
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
export function mapIterationPromptRow(row: Record<string, unknown>): WandIterationPrompt | null {
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

export const SESSION_OPTIONS_SCHEMA_VERSION = 1 as const;

export type DurableSessionOptions = Pick<SessionSnapshot,
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
  | "systemPrompt"
  | "employeeId"
  | "employeeName"
  | "employeeAvatar"
  | "employeeCandidates"
  | "employeeCandidateIndex"
  | "harnessContext"
  | "piSettings"
  | "harnessExtensionState"

>;

export type PersistedSessionOptions = DurableSessionOptions & {
  schemaVersion: typeof SESSION_OPTIONS_SCHEMA_VERSION;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAutonomyPolicy(value: unknown): value is NonNullable<SessionSnapshot["autonomyPolicy"]> {
  return value === "assist" || value === "agent" || value === "agent-max";
}

export function isApprovalPolicy(value: unknown): value is NonNullable<SessionSnapshot["approvalPolicy"]> {
  return value === "ask-every-time" || value === "approve-once" || value === "remember-this-turn";
}

export function isEscalationScope(value: unknown): value is NonNullable<SessionSnapshot["allowedScopes"]>[number] {
  return value === "write_file"
    || value === "run_command"
    || value === "network"
    || value === "outside_workspace"
    || value === "dangerous_shell"
    || value === "unknown";
}

export function isEscalationResolution(
  value: unknown,
): value is NonNullable<NonNullable<SessionSnapshot["lastEscalationResult"]>["resolution"]> {
  return value === "approve_once" || value === "approve_turn" || value === "deny" || value === "fallback_manual";
}

export function parsePendingEscalation(
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

export function parseLastEscalationResult(
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

export function parseApprovalStats(value: unknown): NonNullable<SessionSnapshot["approvalStats"]> | undefined {
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

export function serializeSessionOptions(snapshot: SessionSnapshot): string {
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
    systemPrompt: snapshot.systemPrompt,
    employeeId: snapshot.employeeId,
    employeeName: snapshot.employeeName,
    employeeAvatar: snapshot.employeeAvatar,
    employeeCandidates: snapshot.employeeCandidates,
    employeeCandidateIndex: snapshot.employeeCandidateIndex,
    harnessContext: snapshot.harnessContext,
    piSettings: snapshot.piSettings,
    harnessExtensionState: snapshot.harnessExtensionState,
  };
  return JSON.stringify(options);
}

export function parseSessionOptions(raw: string | null): DurableSessionOptions {
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
  if (typeof parsed.systemPrompt === "string") options.systemPrompt = parsed.systemPrompt;
  if (typeof parsed.employeeId === "string") options.employeeId = parsed.employeeId;
  if (typeof parsed.employeeName === "string") options.employeeName = parsed.employeeName;
  if (typeof parsed.employeeAvatar === "string") options.employeeAvatar = parsed.employeeAvatar;
  if (Array.isArray(parsed.employeeCandidates)) {
    options.employeeCandidates = parsed.employeeCandidates
      .map(parseWandTaskAgent)
      .filter((agent): agent is WandTaskAgent => agent?.kind === "structured");
  }
  if (Number.isSafeInteger(parsed.employeeCandidateIndex) && (parsed.employeeCandidateIndex as number) >= 0) {
    options.employeeCandidateIndex = parsed.employeeCandidateIndex as number;
  }
  const harnessContext = parseHarnessContext(parsed.harnessContext);
  if (harnessContext) options.harnessContext = harnessContext;
  if (parsed.piSettings !== undefined) {
    try { options.piSettings = patchPiSessionSettings(defaultPiSessionSettings(), parsed.piSettings); }
    catch { /* Invalid old settings do not enable optional capabilities. */ }
  }
  const extensions = parseHarnessExtensionState(parsed.harnessExtensionState);
  if (extensions) options.harnessExtensionState = extensions;
  return options;
}

/** core 引擎压缩状态：形状不对就当没有压缩过，不让旧数据把会话读坏。 */
export const HARNESS_SUMMARY_MAX_CHARS = 20_000;

export function parseHarnessContext(raw: unknown): HarnessSessionContext | undefined {
  if (!isRecord(raw)) return undefined;
  const { summary, fromTurnIndex, tokensBefore, compactions } = raw;
  if (typeof summary !== "string" || summary.length === 0) return undefined;
  const boundedFrom = typeof fromTurnIndex === "number" && Number.isSafeInteger(fromTurnIndex) && fromTurnIndex > 0
    ? fromTurnIndex
    : undefined;
  if (boundedFrom === undefined) return undefined;
  return {
    summary: summary.slice(0, HARNESS_SUMMARY_MAX_CHARS),
    fromTurnIndex: boundedFrom,
    tokensBefore: typeof tokensBefore === "number" && Number.isFinite(tokensBefore) && tokensBefore >= 0 ? Math.floor(tokensBefore) : 0,
    compactions: typeof compactions === "number" && Number.isSafeInteger(compactions) && compactions > 0 ? compactions : 1,
  };
}

export function parseQueuedMessages(raw: string | null): string[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
}


export function parseWorktreeInfo(raw: string | null): SessionSnapshot["worktree"] | undefined {
  const parsed = safeJsonParse<{ branch?: unknown; path?: unknown; baseRef?: unknown; repoRoot?: unknown }>(raw);
  if (parsed && typeof parsed.branch === "string" && typeof parsed.path === "string") {
    return {
      branch: parsed.branch, path: parsed.path,
      ...(typeof parsed.baseRef === "string" ? { baseRef: parsed.baseRef } : {}),
      ...(typeof parsed.repoRoot === "string" ? { repoRoot: parsed.repoRoot } : {}),
    };
  }
  return undefined;
}

export function parseWorktreeMergeInfo(raw: string | null): WorktreeMergeInfo | undefined {
  return safeJsonParse<WorktreeMergeInfo>(raw);
}

export function serializeJsonOrNull(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
}

export function normalizeWorktreeMergeStatus(raw: string | null | undefined): SessionSnapshot["worktreeMergeStatus"] | undefined {
  if (raw === "ready" || raw === "checking" || raw === "merging" || raw === "merged" || raw === "failed") {
    return raw;
  }
  return undefined;
}

export function normalizeSessionSource(raw: unknown): SessionSource {
  return raw === "automation" || raw === "startup" || raw === "interactive" ? raw : "interactive";
}



export function mapWorktreeMergeFields(row: SessionRow): Pick<SessionSnapshot, "worktreeMergeStatus" | "worktreeMergeInfo"> {
  return {
    worktreeMergeStatus: normalizeWorktreeMergeStatus(row.worktree_merge_status),
    worktreeMergeInfo: parseWorktreeMergeInfo(row.worktree_merge_info) ?? null,
  };
}

export function sessionSelectFields(slim = false): string {
  return `id, session_source, automation_id, provider, session_kind, runner, command, cwd, mode, status, exit_code, started_at, ended_at, ${slim ? "'' AS output" : "output"}, pty_output_seq, archived, archived_at, claude_session_id, ${slim ? "NULL AS messages" : "messages"}, queued_messages, queued_message_skills, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options, workspace_id, workspace_task_id, completion_revision, viewed_completion_revision`;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  kind: string | null;
  default_provider: string | null;
  layout_json: string | null;
  created_at: string;
  last_opened_at: string | null;
}

export function mapWorkspaceKind(raw: string | null | undefined): WorkspaceKind {
  return raw === "global" ? "global" : "project";
}

export function mapWorkspaceRow(row: WorkspaceRow): Workspace {
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

export interface WorkspaceTaskRow {
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
  card_status: string | null;
}

export function mapWorkspaceTaskWorktree(raw: string | null): WorkspaceTaskWorktree | null {
  const parsed = safeJsonParse<WorkspaceTaskWorktree>(raw);
  if (!parsed || typeof parsed.path !== "string" || typeof parsed.branch !== "string") return null;
  return parsed;
}

/** 读取旧版单棵分屏树时就地包成一个工作窗口，避免升级后丢失布局。 */
export function mapWorkspaceTaskLayout(raw: string | null): TaskWindowLayout | null {
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

export function mapWorkspaceTaskRow(row: WorkspaceTaskRow): WorkspaceTask {
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
    ...(row.card_status === "archived" ? { archived: true } : {}),
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    layoutRevision: Number(row.layout_revision ?? 0) || 0,
  };
}

export function sessionPersistFields(): string {
  return `id, session_source, automation_id, command, cwd, mode, status, exit_code, started_at, ended_at, output, pty_output_seq
             , archived, archived_at, claude_session_id, provider, session_kind, runner, messages, queued_messages, queued_message_skills, structured_state
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options, workspace_id, workspace_task_id`;
}

export function sessionPersistAssignments(): string {
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

export function sessionRuntimeMetadataAssignments(): string {
  return `session_source = ?, automation_id = ?,
           command = ?, cwd = ?, mode = ?, status = ?, exit_code = ?,
           started_at = ?, ended_at = ?,
           archived = ?, archived_at = ?, claude_session_id = ?,
           provider = ?, session_kind = ?, runner = ?, queued_messages = ?, structured_state = ?,
           resumed_from_session_id = ?, auto_recovered = ?,
           worktree_enabled = ?, worktree_info = ?, worktree_merge_status = ?, worktree_merge_info = ?,
           title = ?, description = ?, session_options = ?`;
}

export function sessionPersistValues(snapshot: SessionSnapshot): Array<string | number | null> {
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
    // queued_message_skills 列按「只加不删」保留，但 SDK skills 功能已移除，不再写入。
    null,
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

export function sessionRuntimeMetadataValues(snapshot: SessionSnapshot): Array<string | number | null> {
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

export function mapSessionCore(row: SessionRow): SessionSnapshot {
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
    completionRevision: row.completion_revision ?? 0,
    viewedCompletionRevision: row.viewed_completion_revision ?? 0,
    output: row.output,
    ptyOutputSeq: row.pty_output_seq,
    archived: Boolean(row.archived),
    archivedAt: row.archived_at,
    claudeSessionId: row.claude_session_id,
    messages: safeJsonParse<ConversationTurn[]>(row.messages),
    queuedMessages,
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
    ...legacyPtyRoleIdentity({ ...sessionOptions, sessionKind: row.session_kind ?? "pty", provider }),
    ...(Object.prototype.hasOwnProperty.call(sessionOptions, "pendingEscalation")
      ? { permissionBlocked: Boolean(sessionOptions.pendingEscalation) }
      : {}),
  };
}

export function sessionRowQuery(base: string): string {
  return `${base} ${sessionSelectFields()}`;
}

