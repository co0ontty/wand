import crypto from "node:crypto";
import { CONVERSATION_OWNER, type ConversationInstance, type ConversationRequest } from "./conversation-types.js";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionSnapshot, ConversationTurn, HarnessSessionContext, SessionKind, SessionProvider, SessionRunner, SessionSource, StructuredSessionState, WorktreeMergeInfo, Workspace, LayoutNode, TaskWindowLayout, WorkspaceDefaultProvider, WorkspaceKind, WorkspaceTask, WorkspaceTaskWorktree, WorkspaceTaskStatus, GLOBAL_WORKSPACE_ID } from "./types.js";
import { normalizeSessionDirectory } from "./session-directory-tree.js";
import { ensureWorkspaceForCwd } from "./workspace-binding.js";
import { defaultPiCliSessionSettings, defaultPiSessionSettings, patchPiSessionSettings, type PiSessionSettings } from "./pi-session-settings.js";
import { parseHarnessExtensionState } from "./core-extension-host.js";
import { inferProviderFromCommand, inferProviderFromRunner, isSessionProvider, SESSION_PROVIDERS } from "./session-provider.js";
import { DEFAULT_ITERATION_NAME, DEFAULT_WAND_TASK_AGENT_KIND, DEFAULT_WAND_TASK_PRIORITY, isWandTaskAgentEngine, isWandTaskAgentKind, normalizeWandTaskAgentMode } from "./task-types.js";
import { firstLayoutTabId } from "./layout-tree.js";
import { isUnnamedWorkspaceTaskName } from "./wand-task-sync.js";
import { AI_TEAM_DEFAULT_MAX_STEPS, AI_TEAM_TERMINAL_RUN_STATUSES, aiTeamChatTitle, isBuiltinSiliconEmployee, isTeamMemberRole, memberAgents, parseSiliconEmployeeTags, siliconEmployeeTags } from "./ai-team-types.js";
import type {
  AiTeam, AiTeamMember, AiTeamRun, AiTeamRunChatMarker, AiTeamRunStatus, AiTeamStep, AiTeamStepKind, AiTeamStepSessionMarker, AiTeamStepStatus,
  CandidateFailureKind, SiliconEmployee, StepDispatchInfo,
} from "./ai-team-types.js";
import { freezeTeamEmployees, projectTeamDefinition, restoreTeamMemberEmployee, serializeExecutionTeam } from "./ai-team-employee-binding.js";
import { isTaskExecutionSubject } from "./task-types.js";
import type { WandTask, WandTaskAgent, WandTaskAgentKind, WandTaskTitleSource } from "./task-types.js";
import {
  SYSTEM_EMPLOYEE_KEY,
  systemEmployeeDefinition,
  systemEmployeeSeedAgents,
  type SystemEmployeeSeed,
} from "./system-employee.js";
import { isThinkingEffort } from "./structured-provider-common.js";
import { DEFAULT_EMPLOYEE_KEY } from "./ai-team-types.js";
import { defaultEmployeeDefinition, legacyPtyRoleIdentity } from "./default-employee.js";
import { DECISION_EXPERT_KEY } from "./decision-expert-identity.js";
import { decisionExpertDefinition } from "./decision-expert-employee.js";
import { normalizeEmployeeKnowledge } from "./employee-knowledge-content.js";
import { EMPLOYEE_KNOWLEDGE_MAX_ENTRIES, type EmployeeKnowledgeEntry } from "./employee-knowledge-types.js";
import {
  USER_MEMORY_MAX_EVENTS, USER_MEMORY_RETENTION_MS,
  type UserMemoryEvent, type UserMemoryProfile, type UserMemoryState,
} from "./user-memory-types.js";
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

/** `ai_team_runs.run_state_json`：本次运行的候选黑名单（§3.4 修正 B12 两层键值 + host-disabled）。 */
export interface AiTeamRunState {
  /** spawn-missing：该 provider 的候选全部直接跳过。 */
  providers: SessionProvider[];
  /** 五元组 key → 拉黑它的原因（model-unknown / startup-timeout）。 */
  agents: Array<{ key: string; kind: CandidateFailureKind }>;
  /** 五元组 key → startup-timeout 累计次数（到 2 次进 agents）。 */
  strikes: Record<string, number>;
  /** host-disabled：整个 run 不再尝试该 kind 的候选。 */
  hostDisabled: WandTaskAgentKind[];
}

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
const HARNESS_SUMMARY_MAX_CHARS = 20_000;

function parseHarnessContext(raw: unknown): HarnessSessionContext | undefined {
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

function parseQueuedMessages(raw: string | null): string[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
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
             , resumed_from_session_id, auto_recovered, worktree_enabled, worktree_info, worktree_merge_status, worktree_merge_info, title, description, session_options, workspace_id, workspace_task_id, completion_revision, viewed_completion_revision`;
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
  card_status: string | null;
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
    ...(row.card_status === "archived" ? { archived: true } : {}),
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
    execution_subject_json TEXT,
    workspace_task_id TEXT,
    parent_task_id TEXT,
    title_source TEXT,
    auto_title_signature TEXT,
    archived_at TEXT,
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

  CREATE TABLE IF NOT EXISTS ai_teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    members_json TEXT NOT NULL,
    require_plan_approval INTEGER NOT NULL DEFAULT 1,
    max_steps INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS silicon_employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    duty TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    agents_json TEXT NOT NULL,
    system_key TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_silicon_employees_archived ON silicon_employees(archived_at);

  CREATE TABLE IF NOT EXISTS employee_knowledge (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES silicon_employees(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (employee_id, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_employee_knowledge_owner ON employee_knowledge(employee_id, created_at);
  CREATE TABLE IF NOT EXISTS employee_knowledge_access (
    token_hash TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES silicon_employees(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_employee_knowledge_access_expiry ON employee_knowledge_access(expires_at);

  CREATE TABLE IF NOT EXISTS decision_access (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decision_access_expiry ON decision_access(expires_at);

  CREATE TABLE IF NOT EXISTS openrouter_free_access (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES command_sessions(id) ON DELETE CASCADE,
    selector TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_openrouter_free_access_expiry ON openrouter_free_access(expires_at);

  CREATE TABLE IF NOT EXISTS user_memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    dedup_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_memory_events_created ON user_memory_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_user_memory_events_dedup ON user_memory_events(dedup_key, created_at);
  CREATE TABLE IF NOT EXISTS user_memory_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    source_id INTEGER NOT NULL DEFAULT 0,
    profile_json TEXT
  );
  INSERT OR IGNORE INTO user_memory_state (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS ai_team_runs (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    team_json TEXT NOT NULL,
    objective TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    status_detail TEXT NOT NULL DEFAULT '',
    steps_used INTEGER NOT NULL DEFAULT 0,
    step_limit INTEGER NOT NULL,
    format_retries INTEGER NOT NULL DEFAULT 0,
    plan_approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_team_runs_task ON ai_team_runs(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_team_runs_status ON ai_team_runs(status);

  CREATE TABLE IF NOT EXISTS ai_team_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    member_id TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    report TEXT NOT NULL DEFAULT '',
    report_path TEXT NOT NULL,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT,
    ended_at TEXT,
    UNIQUE (run_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_team_steps_session ON ai_team_steps(session_id, status);
`;

/** AI 团队表的后加列；只加不删，历史行取默认值。 */
function ensureAiTeamSchema(db: DatabaseSync): void {
  const teamColumns = new Set((db.prepare("PRAGMA table_info(ai_teams)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!teamColumns.has("instructions")) db.exec("ALTER TABLE ai_teams ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  const stepColumns = new Set((db.prepare("PRAGMA table_info(ai_team_steps)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!stepColumns.has("depends_on_json")) db.exec("ALTER TABLE ai_team_steps ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'");
  const runColumns = new Set((db.prepare("PRAGMA table_info(ai_team_runs)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!runColumns.has("chat_session_id")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN chat_session_id TEXT");
  if (!runColumns.has("pending_notes_json")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN pending_notes_json TEXT NOT NULL DEFAULT '[]'");
  // v2 多候选降级：步骤实际候选与跳过记录（StepDispatchInfo）、run 级状态（黑名单等）。只加列，旧行取默认 '{}'。
  if (!stepColumns.has("dispatch_info_json")) db.exec("ALTER TABLE ai_team_steps ADD COLUMN dispatch_info_json TEXT NOT NULL DEFAULT '{}'");
  if (!runColumns.has("run_state_json")) db.exec("ALTER TABLE ai_team_runs ADD COLUMN run_state_json TEXT NOT NULL DEFAULT '{}'");

  // 硅基员工表结构保护（遵循只加不删）
  db.exec(`
    CREATE TABLE IF NOT EXISTS silicon_employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      duty TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      agents_json TEXT NOT NULL,
      system_key TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_silicon_employees_archived ON silicon_employees(archived_at);
  `);
  // 内置员工标记（如 "wand-ops"）：只加列，用户员工保持 NULL。
  const employeeColumns = new Set((db.prepare("PRAGMA table_info(silicon_employees)").all() as Array<{ name: string }>).map((column) => column.name));
  if (employeeColumns.size > 0 && !employeeColumns.has("system_key")) {
    db.exec("ALTER TABLE silicon_employees ADD COLUMN system_key TEXT");
  }
  if (employeeColumns.size > 0 && !employeeColumns.has("tags_json")) {
    db.exec("ALTER TABLE silicon_employees ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function ensureWandTaskSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(wand_tasks)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (columns.length > 0 && !names.has("identifier")) db.exec("ALTER TABLE wand_tasks ADD COLUMN identifier TEXT");
  if (columns.length > 0 && !names.has("due_date")) db.exec("ALTER TABLE wand_tasks ADD COLUMN due_date TEXT");
  // 任务的默认派发配置（CLI 工具 / 模型 / 思考深度）。只加列，历史行保持 NULL。
  if (columns.length > 0 && !names.has("agent_json")) db.exec("ALTER TABLE wand_tasks ADD COLUMN agent_json TEXT");
  if (columns.length > 0 && !names.has("execution_subject_json")) db.exec("ALTER TABLE wand_tasks ADD COLUMN execution_subject_json TEXT");
  if (columns.length > 0 && !names.has("workspace_task_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN workspace_task_id TEXT");
  // 父任务归属只加列；历史任务仍然是顶层任务。
  if (columns.length > 0 && !names.has("parent_task_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN parent_task_id TEXT");
  // 标题来源：'user' = 用户手写，'auto' = 由描述/会话内容自动生成。只加列，历史行保持 NULL（读取时视为 user）。
  if (columns.length > 0 && !names.has("title_source")) db.exec("ALTER TABLE wand_tasks ADD COLUMN title_source TEXT");
  // 自动标题最近一次的输入指纹：内容没变就不再重复总结（也避免自动标题来回震荡）。只加列。
  if (columns.length > 0 && !names.has("auto_title_signature")) db.exec("ALTER TABLE wand_tasks ADD COLUMN auto_title_signature TEXT");
  // 里程碑：只加列，历史行保持 NULL；里程碑本体在 wand_milestones（INIT_SQL 建表）。
  if (columns.length > 0 && !names.has("milestone_id")) db.exec("ALTER TABLE wand_tasks ADD COLUMN milestone_id TEXT");
  // 归档时间（自动/手动归档都写它）：任务自动删除按它起算；历史归档行保持 NULL。
  if (columns.length > 0 && !names.has("archived_at")) db.exec("ALTER TABLE wand_tasks ADD COLUMN archived_at TEXT");
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
  // DDL below takes the write lock; without this a concurrent CLI/Server writer
  // aborts startup with SQLITE_BUSY instead of waiting its turn.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(INIT_SQL);
  ensureAuthSessionSchema(db);
  ensureCommandSessionSchema(db);
  ensureWorkspaceSchema(db);
  ensureWandTaskSchema(db);
  ensureWandMilestoneSchema(db);
  ensureIterationPromptSchema(db);
  ensureAiTeamSchema(db);
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

interface CreateWandTaskInput {
  workspaceId?: string | null;
  workspaceTaskId?: string | null;
  parentTaskId?: string | null;
  title: string;
  titleSource?: WandTaskTitleSource;
  description?: string;
  status?: WandTask["status"];
  priority?: WandTask["priority"];
  labels?: string[];
  dueDate?: string | null;
  milestoneId?: string | null;
  agent?: WandTaskAgent | null;
  executionSubject?: WandTask["executionSubject"];
}

type WandTaskPatch = Partial<Pick<WandTask,
  "workspaceId" | "workspaceTaskId" | "parentTaskId" | "title" | "titleSource"
  | "autoTitleSignature" | "description" | "status" | "priority" | "labels"
  | "dueDate" | "milestoneId" | "sortOrder" | "agent" | "executionSubject">>;

const WAND_TASK_FIELDS = `id, identifier, workspace_id, workspace_task_id, parent_task_id,
  title, title_source, auto_title_signature, description, status, priority, labels_json,
  due_date, milestone_id, sort_order, agent_json, execution_subject_json, archived_at, created_at, updated_at`;

// Shared metadata comes from the latest explicitly linked card, including meaningful NULLs.
// The old container columns remain readable for legacy rows until the startup migration.
const WORKSPACE_TASK_PROJECTION = `SELECT wt.id,
  CASE WHEN card.id IS NULL THEN wt.workspace_id
    ELSE COALESCE(card.workspace_id, '${GLOBAL_WORKSPACE_ID}') END AS workspace_id,
  CASE WHEN card.id IS NULL THEN wt.name ELSE card.title END AS name,
  CASE WHEN card.id IS NULL THEN wt.status
    WHEN card.status IN ('done', 'archived') THEN 'done' ELSE 'active' END AS status,
  CASE WHEN card.id IS NULL THEN wt.milestone_id ELSE card.milestone_id END AS milestone_id,
  wt.worktree_json, wt.layout_json, wt.cwd, wt.created_at, wt.last_opened_at, wt.layout_revision,
  card.status AS card_status, wt.rowid AS _created_order
  FROM workspace_tasks wt LEFT JOIN wand_tasks card ON card.id = (
    SELECT id FROM wand_tasks WHERE workspace_task_id = wt.id
    ORDER BY updated_at DESC, rowid DESC LIMIT 1
  )`;

function withoutSessionTab(node: LayoutNode, sessionId: string): LayoutNode {
  if (node.type === "split") return {
    ...node,
    children: [withoutSessionTab(node.children[0], sessionId), withoutSessionTab(node.children[1], sessionId)],
  };
  const activeId = node.tabs[node.active]?.id;
  const tabs = node.tabs.filter((tab) => tab.kind !== "session" || tab.sessionId !== sessionId);
  const active = tabs.findIndex((tab) => tab.id === activeId);
  return { ...node, tabs, active: active >= 0 ? active : Math.min(node.active, Math.max(0, tabs.length - 1)) };
}

export class WandStorage {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private memoryCapture = { enabled: true, revision: 0 };

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    chmodSync(dbPath, 0o600);
    this.db.exec(INIT_SQL);
    ensureAuthSessionSchema(this.db);
    ensureCommandSessionSchema(this.db);
    ensureWorkspaceSchema(this.db);
    ensureWandTaskSchema(this.db);
    ensureWandMilestoneSchema(this.db);
    ensureIterationPromptSchema(this.db);
    ensureAiTeamSchema(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_list_state (
        conversation_id TEXT PRIMARY KEY,
        pinned_at TEXT,
        hidden_at TEXT, dissolved_at TEXT, dissolved_by TEXT, deleting INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
        peer_employee_id TEXT, session_id TEXT, instance_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_peer ON conversations(owner, peer_employee_id)
        WHERE kind = 'dm';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_session ON conversations(session_id)
        WHERE session_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS conversation_tasks (
        conversation_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_messages ON conversation_messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS conversation_requests (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const conversationListColumns = new Set((this.db.prepare("PRAGMA table_info(conversation_list_state)").all() as Array<{ name: string }>).map(column => column.name));
    for (const [name, type] of [["dissolved_at", "TEXT"], ["dissolved_by", "TEXT"], ["deleting", "INTEGER NOT NULL DEFAULT 0"]]) {
      if (!conversationListColumns.has(name!)) this.db.exec(`ALTER TABLE conversation_list_state ADD COLUMN ${name} ${type}`);
    }
    const conversationRunColumns = new Set((this.db.prepare("PRAGMA table_info(ai_team_runs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!conversationRunColumns.has("conversation_id")) this.db.exec("ALTER TABLE ai_team_runs ADD COLUMN conversation_id TEXT");
    if (!conversationRunColumns.has("member_version")) this.db.exec("ALTER TABLE ai_team_runs ADD COLUMN member_version INTEGER");
    if (!conversationRunColumns.has("round_number")) this.db.exec("ALTER TABLE ai_team_runs ADD COLUMN round_number INTEGER");
    ensureConnectorSchema(this.db);
    this.ensureDefaultPasswordVault();
    this.migrateTaskRecords();
    const memory = this.getUserMemoryState();
    this.memoryCapture = { enabled: memory.enabled, revision: memory.revision };
  }

  directory(): string {
    return path.dirname(this.dbPath);
  }

  databasePath(): string {
    return this.dbPath;
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

  // ============ Stable conversations (no read-side repair) ============

  conversationListState(id: string): { pinnedAt: string | null; dissolvedAt: string | null; dissolvedBy: string | null; deleting: boolean } {
    const row = this.db.prepare("SELECT pinned_at, dissolved_at, dissolved_by, deleting FROM conversation_list_state WHERE conversation_id = ?")
      .get(id) as { pinned_at: string | null; dissolved_at: string | null; dissolved_by: string | null; deleting: number } | undefined;
    return { pinnedAt: row?.pinned_at ?? null, dissolvedAt: row?.dissolved_at ?? null, dissolvedBy: row?.dissolved_by ?? null, deleting: !!row?.deleting };
  }

  /** Separate from channel snapshots, so late run saves cannot overwrite lifecycle state. */
  updateConversationListState(id: string, patch: { pinned?: boolean; dissolved?: boolean; deleting?: boolean; dissolvedBy?: string }): void {
    this.transaction(() => {
      const previous = this.conversationListState(id);
      const pinnedAt = patch.pinned === false ? null : patch.pinned === true ? previous.pinnedAt ?? nowIso() : previous.pinnedAt;
      const dissolvedAt = patch.dissolved === true ? previous.dissolvedAt ?? nowIso() : patch.dissolved === false ? null : previous.dissolvedAt;
      // 解散人是当时那一版署名，保留真实归属；只有没传资料时才回落到默认的「我」。
      const dissolvedBy = dissolvedAt ? previous.dissolvedBy ?? patch.dissolvedBy ?? "我" : null;
      this.db.prepare(`INSERT INTO conversation_list_state(conversation_id, pinned_at, dissolved_at, dissolved_by, deleting) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET pinned_at = excluded.pinned_at, dissolved_at = excluded.dissolved_at, dissolved_by = excluded.dissolved_by, deleting = excluded.deleting`)
        .run(id, pinnedAt, dissolvedAt, dissolvedBy, Number(patch.deleting ?? previous.deleting));
    });
  }

  deleteConversation(id: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversation_tasks WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ? AND owner = ?").run(id, CONVERSATION_OWNER);
      this.db.prepare("DELETE FROM conversation_list_state WHERE conversation_id = ?").run(id);
      // Keep the content-free request ledger: retrying an old accepted request must never recreate deleted work.
    });
  }

  listConversations(): ConversationInstance[] {
    return (this.db.prepare("SELECT instance_json FROM conversations WHERE owner = ?").all(CONVERSATION_OWNER) as Array<{ instance_json: string }>)
      .map((row) => JSON.parse(row.instance_json) as ConversationInstance);
  }

  getConversation(id: string): ConversationInstance | null {
    const row = this.db.prepare("SELECT instance_json FROM conversations WHERE id = ? AND owner = ?")
      .get(id, CONVERSATION_OWNER) as { instance_json: string } | undefined;
    return row ? JSON.parse(row.instance_json) as ConversationInstance : null;
  }

  getConversationBySession(sessionId: string): ConversationInstance | null {
    const row = this.db.prepare("SELECT instance_json FROM conversations WHERE session_id = ? AND owner = ?")
      .get(sessionId, CONVERSATION_OWNER) as { instance_json: string } | undefined;
    return row ? JSON.parse(row.instance_json) as ConversationInstance : null;
  }

  saveConversation(instance: ConversationInstance): void {
    this.db.prepare(`INSERT INTO conversations(id, owner, kind, peer_employee_id, session_id, instance_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id, instance_json = excluded.instance_json`)
      .run(instance.id, instance.owner, instance.kind, instance.peerEmployeeId, instance.sessionId, JSON.stringify(instance));
  }

  conversationTasks(id: string): Array<{ taskId: string; linkedAt: string }> {
    return (this.db.prepare("SELECT task_id, linked_at FROM conversation_tasks WHERE conversation_id = ? ORDER BY linked_at, rowid")
      .all(id) as Array<{ task_id: string; linked_at: string }>).map((row) => ({ taskId: row.task_id, linkedAt: row.linked_at }));
  }

  linkConversationTask(conversationId: string, taskId: string, linkedAt: string): void {
    this.db.prepare("INSERT OR IGNORE INTO conversation_tasks(conversation_id, task_id, linked_at) VALUES (?, ?, ?)")
      .run(conversationId, taskId, linkedAt);
  }

  /** One canonical task/workspace/instance association commit, before any model input. */
  createConversationTask(instance: ConversationInstance, input: CreateWandTaskInput, accept?: (task: WandTask) => void): WandTask {
    return this.transaction(() => {
      const workspace = input.workspaceId ? this.getWorkspace(input.workspaceId) : null;
      if (!workspace || workspace.kind === "global") throw new Error("请选择非全局工作项目。");
      const milestoneId = this.taskMilestoneForWrite(input.milestoneId, workspace.id);
      const workspaceTaskId = this.insertWorkspaceTask({ workspaceId: workspace.id, name: input.title, milestoneId });
      const task = this.insertWandTask({ ...input, workspaceId: workspace.id, workspaceTaskId, milestoneId });
      this.saveConversation(instance);
      this.linkConversationTask(instance.id, task.id, task.createdAt);
      accept?.(task);
      return task;
    });
  }

  /** Commit the first accepted fact, identifiers and DM link together, before any execution I/O. */
  acceptConversationDispatch(instance: ConversationInstance, input: CreateWandTaskInput | { continueTaskId: string },
    request: ConversationRequest, source?: ConversationInstance): WandTask {
    const accept = (task: WandTask): WandTask => {
      this.saveConversation(instance);
      this.linkConversationTask(instance.id, task.id, task.createdAt);
      request.receipt = { ...request.receipt, state: "accepted", conversationId: instance.id, taskId: task.id, startup: "pending" };
      if (source) {
        source.createdAt ||= nowIso(); source.updatedAt = nowIso();
        this.saveConversation(source);
        this.appendConversationEvent(source.id, { role: "user", messageId: request.id, requestId: request.id,
          conversationTarget: null, content: [{ type: "text", text: "description" in input ? input.description ?? task.description : task.description }] });
        request.receipt.messageId = request.id;
        const employee = source.peerEmployeeId ? this.getSiliconEmployee(source.peerEmployeeId) : null;
        this.appendConversationEvent(source.id, { role: "assistant", notice: true,
          author: { id: source.peerEmployeeId ?? source.id, name: employee?.name ?? source.name, avatar: employee?.avatar },
          messageId: `${request.id}:task-link`, requestId: request.id,
          conversationLink: { conversationId: instance.id, taskId: task.id, title: task.title },
          content: [{ type: "text", text: `我正在处理「${task.title}」，进展在任务群实时同步。` }] });
      }
      this.saveConversationRequest({ ...request, updatedAt: nowIso() });
      return task;
    };
    if (!("continueTaskId" in input)) return this.createConversationTask(instance, input, accept);
    return this.transaction(() => {
      const task = this.getWandTask(input.continueTaskId);
      if (!task) throw new Error("任务不存在。");
      return accept(task);
    });
  }

  /** Message + reply + exact session association + receipt are committed before any model input. */
  acceptConversationSession(instance: ConversationInstance, createSession: () => string, title: string, input: string,
    request: ConversationRequest): void {
    this.transaction(() => {
      const sessionId = createSession();
      instance.createdAt ||= nowIso(); instance.updatedAt = nowIso();
      this.saveConversation(instance);
      this.appendConversationEvent(instance.id, { role: "user", messageId: request.id, requestId: request.id,
        conversationTarget: null, content: [{ type: "text", text: input }] });
      const employee = instance.peerEmployeeId ? this.getSiliconEmployee(instance.peerEmployeeId) : null;
      this.appendConversationEvent(instance.id, { role: "assistant", messageId: `${request.id}:session`, requestId: request.id,
        author: { id: instance.peerEmployeeId ?? instance.id, name: employee?.name ?? instance.name, avatar: employee?.avatar },
        sessionLink: { sessionId, title }, content: [] });
      this.saveConversationRequest({ ...request, updatedAt: nowIso(), receipt: { ...request.receipt,
        state: "accepted", conversationId: instance.id, sessionId, messageId: request.id, startup: "pending" } });
    });
  }

  conversationSessionIds(id: string): string[] {
    const rows = this.db.prepare(`SELECT json_extract(turn_json, '$.sessionLink.sessionId') AS session_id
      FROM conversation_messages WHERE conversation_id = ? AND json_extract(turn_json, '$.sessionLink.sessionId') IS NOT NULL`)
      .all(id) as Array<{ session_id: string }>;
    return [...new Set(rows.map(row => row.session_id))];
  }

  conversationTaskStartup(taskId: string): ConversationRequest["receipt"] | null {
    const row = this.db.prepare(`SELECT receipt_json FROM conversation_requests
      WHERE json_extract(receipt_json, '$.taskId') = ? AND json_extract(receipt_json, '$.startup') IS NOT NULL
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(taskId) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as ConversationRequest["receipt"] : null;
  }

  appendConversationEvent(id: string, turn: ConversationTurn): void {
    const createdAt = turn.createdAt ?? nowIso();
    const messageId = turn.messageId ?? crypto.randomUUID();
    this.db.prepare("INSERT INTO conversation_messages(id, conversation_id, turn_json, created_at) VALUES (?, ?, ?, ?)")
      .run(messageId, id, JSON.stringify({ ...turn, messageId, conversationId: id, createdAt }), createdAt);
  }

  conversationEvents(id: string): ConversationTurn[] {
    return (this.db.prepare("SELECT turn_json FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid")
      .all(id) as Array<{ turn_json: string }>).map((row) => JSON.parse(row.turn_json) as ConversationTurn);
  }

  getConversationRequest(id: string): ConversationRequest | null {
    const row = this.db.prepare("SELECT * FROM conversation_requests WHERE id = ?").get(id) as
      { id: string; fingerprint: string; receipt_json: string; updated_at: string } | undefined;
    return row ? { id: row.id, fingerprint: row.fingerprint, receipt: JSON.parse(row.receipt_json), updatedAt: row.updated_at } : null;
  }

  saveConversationRequest(request: ConversationRequest): void {
    this.db.prepare(`INSERT INTO conversation_requests(id, fingerprint, receipt_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET receipt_json = excluded.receipt_json, updated_at = excluded.updated_at`)
      .run(request.id, request.fingerprint, JSON.stringify(request.receipt), request.updatedAt);
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

  // ============ Pi 会话默认设置 ============

  /**
   * Pi CLI 会话的「上次设置」：用户在任意 Pi 会话里改过设置后，新建会话以它起步，
   * 不必每开一个会话都重配自动选择 / CodeMode。返回 null 表示沿用出厂默认
   * （跟随 Pi 自身配置），不是「设置全关」。只存设置字段本身，不含路径、命令或凭据。
   */
  getPiSessionDefaults(): PiSessionSettings | null {
    const raw = this.getPreference<unknown>(PI_SESSION_DEFAULTS_KEY, null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    try { return patchPiSessionSettings(defaultPiCliSessionSettings(), raw); } catch {
      // 非法/过期的默认设置不能静默开启任何能力，退回出厂默认。
      return null;
    }
  }

  /** 写入 Pi 会话默认设置；null / undefined 清除，回到出厂默认。 */
  setPiSessionDefaults(settings: PiSessionSettings | null | undefined): void {
    this.setPreference(PI_SESSION_DEFAULTS_KEY, settings ?? null);
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
    this.transaction(() => {
      const cards = this.db.prepare(`SELECT ${WAND_TASK_FIELDS} FROM wand_tasks
        WHERE workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
        .all(id) as Array<Record<string, unknown>>;
      if (options.cascade) {
        this.db.prepare(`DELETE FROM command_sessions WHERE workspace_id = ?
          OR workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
          .run(id, id);
      } else {
        this.db.prepare(`UPDATE command_sessions SET workspace_id = NULL, workspace_task_id = NULL
          WHERE workspace_id = ? OR workspace_task_id IN
            (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
          .run(id, id);
      }
      this.db.prepare(`UPDATE wand_tasks SET workspace_task_id = NULL
        WHERE workspace_task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?)`)
        .run(id);
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      // Direct project removal detaches active cards; their next dispatch still uses the default cwd.
      // Route-level destructive removal archives cards first, so those cards never gain a container.
      for (const row of cards) {
        const card = this.mapWandTaskRow(row);
        if (card.status === "archived") continue;
        const global = this.ensureGlobalWorkspace();
        const containerId = this.insertWorkspaceTask({
          workspaceId: global.id, name: card.title, milestoneId: card.milestoneId,
          status: card.status === "done" ? "done" : "active", createdAt: card.createdAt,
        });
        this.writeWandTask(this.getWandTask(card.id)!, { workspaceTaskId: containerId });
      }
      this.forgetWorkspaceGroupOrder(id);
    });
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

  /** 空白独立会话的目录与项目归属一次落库；创建新项目失败也随事务回滚。 */
  updateBlankSessionDirectory(sessionId: string, cwd: string): string {
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session || session.workspaceTaskId || session.worktreeEnabled || session.worktree) {
        throw new Error("任务或工作树会话必须保留原运行目录。");
      }
      const workspace = ensureWorkspaceForCwd(this, cwd);
      this.db.prepare("UPDATE command_sessions SET cwd = ?, workspace_id = ? WHERE id = ?")
        .run(cwd, workspace.id, sessionId);
      return workspace.id;
    });
  }

  setSessionWorkspaceId(sessionId: string, workspaceId: string | null): void {
    const binding = this.getSessionWorkspace(sessionId);
    const task = binding?.workspaceTaskId ? this.getWorkspaceTask(binding.workspaceTaskId) : null;
    this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE id = ?")
      .run(task?.workspaceId ?? workspaceId, sessionId);
  }

  /** Normal workspace counts exclude archived sessions and sessions in archived tasks. */
  countSessionsByWorkspace(options: { includeArchived?: boolean } = {}): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT session.workspace_id AS id, COUNT(*) AS n
         FROM command_sessions session
         WHERE session.workspace_id IS NOT NULL AND session.workspace_id != ''
           AND (? = 1 OR (session.archived = 0 AND COALESCE((
             SELECT status FROM wand_tasks WHERE workspace_task_id = session.workspace_task_id
             ORDER BY updated_at DESC, rowid DESC LIMIT 1
           ), '') <> 'archived'))
         GROUP BY session.workspace_id`,
      )
      .all(options.includeArchived === true ? 1 : 0) as unknown as Array<{ id: string; n: number }>;
    return new Map(rows.map((row) => [row.id, Number(row.n) || 0]));
  }

  /** Count user-initiated CLI launches (one per session), including archived sessions. */
  countInteractiveSessionsByProvider(): Record<SessionProvider, number> {
    const counts = Object.fromEntries(
      SESSION_PROVIDERS.map((provider) => [provider, 0]),
    ) as Record<SessionProvider, number>;
    const rows = this.db.prepare(
      `SELECT provider, runner, command, COUNT(*) AS n
       FROM command_sessions
       WHERE session_source = 'interactive'
       GROUP BY provider, runner, command`,
    ).all() as unknown as Array<{
      provider: string | null;
      runner: string | null;
      command: string;
      n: number;
    }>;
    for (const row of rows) {
      const provider = isSessionProvider(row.provider)
        ? row.provider
        : inferProviderFromRunner(row.runner) ?? inferProviderFromCommand(row.command);
      if (provider) counts[provider] += Number(row.n) || 0;
    }
    return counts;
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

  /** Both task DTOs read one set of task metadata; containers own only local layout/worktree. */
  listWorkspaceTasks(workspaceId: string): WorkspaceTask[] {
    const rows = this.db.prepare(
      `SELECT * FROM (${WORKSPACE_TASK_PROJECTION}) WHERE workspace_id = ?
       ORDER BY created_at DESC, _created_order DESC`,
    ).all(workspaceId) as unknown as WorkspaceTaskRow[];
    return rows.map(mapWorkspaceTaskRow);
  }

  getWorkspaceTask(id: string): WorkspaceTask | null {
    const row = this.db.prepare(`${WORKSPACE_TASK_PROJECTION} WHERE wt.id = ?`)
      .get(id) as unknown as WorkspaceTaskRow | undefined;
    return row ? mapWorkspaceTaskRow(row) : null;
  }

  private insertWorkspaceTask(input: {
    workspaceId: string; name: string; worktree?: WorkspaceTaskWorktree | null;
    cwd?: string | null; status?: WorkspaceTaskStatus; milestoneId?: string | null;
    createdAt?: string;
  }): string {
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO workspace_tasks
      (id, workspace_id, name, worktree_json, layout_json, status, cwd, milestone_id, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`)
      .run(id, input.workspaceId, input.name, input.worktree ? JSON.stringify(input.worktree) : null,
        input.status ?? "active", input.cwd?.trim() || null, input.milestoneId ?? null,
        input.createdAt ?? nowIso());
    return id;
  }

  private taskMilestoneForWrite(id: string | null | undefined, workspaceId: string | null): string {
    if (!id) return this.ensureDefaultWandMilestone().id;
    const milestone = this.getWandMilestone(id);
    if (!milestone) throw new Error("未找到该里程碑。");
    return workspaceId && milestone.workspaceId && milestone.workspaceId !== workspaceId
      ? this.ensureDefaultWandMilestone().id : id;
  }

  createWorkspaceTask(input: {
    workspaceId: string; name: string; worktree?: WorkspaceTaskWorktree | null;
    cwd?: string | null; status?: WorkspaceTaskStatus; milestoneId?: string | null;
    board?: { titleSource?: WandTaskTitleSource; description?: string; parentTaskId?: string | null };
  }): WorkspaceTask {
    return this.transaction(() => {
      const workspace = this.getWorkspace(input.workspaceId);
      if (!workspace) throw new Error("任务所属工作区不存在。");
      const projectId = workspace.kind === "global" || workspace.id === GLOBAL_WORKSPACE_ID ? null : workspace.id;
      const milestoneId = this.taskMilestoneForWrite(input.milestoneId, projectId);
      const id = this.insertWorkspaceTask({ ...input, milestoneId });
      this.insertWandTask({
        ...input.board, workspaceTaskId: id,
        workspaceId: projectId,
        title: input.name,
        titleSource: input.board?.titleSource ?? (isUnnamedWorkspaceTaskName(input.name) ? "auto" : "user"),
        status: input.status === "done" ? "done" : "todo", milestoneId,
      });
      return this.getWorkspaceTask(id)!;
    });
  }

  updateWorkspaceTask(id: string, patch: {
    name?: string; status?: WorkspaceTaskStatus; worktree?: WorkspaceTaskWorktree | null;
    milestoneId?: string | null; workspaceId?: string;
  }): void {
    this.transaction(() => {
      const card = this.getWandTaskByWorkspaceTaskId(id);
      if (!card) throw new Error("未找到该任务。");
      if (patch.worktree !== undefined) {
        this.db.prepare("UPDATE workspace_tasks SET worktree_json = ? WHERE id = ?")
          .run(patch.worktree ? JSON.stringify(patch.worktree) : null, id);
      }
      this.writeWandTask(card, {
        ...(patch.name !== undefined ? { title: patch.name, titleSource: "user" as const } : {}),
        ...(patch.milestoneId !== undefined ? { milestoneId: patch.milestoneId } : {}),
        ...(patch.workspaceId !== undefined ? {
          workspaceId: patch.workspaceId === GLOBAL_WORKSPACE_ID ? null : patch.workspaceId,
        } : {}),
        ...(patch.status !== undefined ? {
          status: patch.status === "done"
            ? card.status === "archived" ? "archived" as const : "done" as const
            : card.status === "todo" ? "todo" as const : "doing" as const,
        } : {}),
      });
    });
  }

  archiveWorkspaceTask(id: string): WandTask | null {
    const card = this.getWandTaskByWorkspaceTaskId(id);
    return card ? this.updateWandTask(card.id, { status: "archived" }) : null;
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
    this.transaction(() => {
      this.db.prepare(`UPDATE wand_tasks SET workspace_task_id = NULL, status = 'archived', updated_at = ?
        WHERE workspace_task_id = ?`).run(nowIso(), id);
      if (options.cascade) {
        this.db.prepare("DELETE FROM command_sessions WHERE workspace_task_id = ?").run(id);
      } else {
        this.db.prepare("UPDATE command_sessions SET workspace_task_id = NULL WHERE workspace_task_id = ?").run(id);
      }
      this.db.prepare("DELETE FROM workspace_tasks WHERE id = ?").run(id);
    });
  }

  tasksAggregateFingerprint(): string {
    const sessions = this.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(archived), 0) AS archivedCount,
              COALESCE(MAX(started_at), '') AS started,
              COALESCE(MAX(ended_at), '') AS ended,
              COALESCE(MAX(title), '') AS title,
              COALESCE(SUM(completion_revision), 0) AS completionRevision,
              COALESCE(SUM(viewed_completion_revision), 0) AS viewedCompletionRevision
       FROM command_sessions`
    ).get() as { count: number; archivedCount: number; started: string; ended: string; title: string };
    // Per-task metadata catches edits even when another task owns the maximum
    // timestamp/revision. Layout payloads are represented by their own revision.
    const tasks = this.db.prepare(
      `SELECT id, workspace_id, name, status, cwd, worktree_json, milestone_id,
              created_at, last_opened_at, layout_revision
       FROM (${WORKSPACE_TASK_PROJECTION}) ORDER BY id`
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

  /**
   * 会话列表团队标记的廉价指纹：运行/步骤状态一变，`/api/tasks` 里的 `teamChat`/`teamStep`
   * 就跟着变，客户端必须肯重拉。只看聚合值和最近若干条状态，不逐行拼整张表。
   */
  teamSessionFingerprint(): string {
    const runs = this.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE((SELECT GROUP_CONCAT(status || ':' || COALESCE(chat_session_id, ''), '|')
                        FROM (SELECT status, chat_session_id FROM ai_team_runs ORDER BY rowid DESC LIMIT 500)), '') AS statuses
       FROM ai_team_runs`,
    ).get() as { count: number; statuses: string };
    const steps = this.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE((SELECT GROUP_CONCAT(status || ':' || COALESCE(session_id, ''), '|')
                        FROM (SELECT status, session_id FROM ai_team_steps ORDER BY rowid DESC LIMIT 500)), '') AS statuses
       FROM ai_team_steps`,
    ).get() as { count: number; statuses: string };
    return JSON.stringify({ runs, steps });
  }

  /** GET /api/wand-tasks 的顺序：新创建在前。客户端按此顺序渲染，不再本地排序。 */
  listWandTasks(workspaceId?: string | null): import("./task-types.js").WandTask[] {
    const rows = this.db.prepare(
      `SELECT ${WAND_TASK_FIELDS}
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
      executionSubject: (() => {
        const parsed = safeJsonParse<unknown>(typeof row.execution_subject_json === "string" ? row.execution_subject_json : null);
        return isTaskExecutionSubject(parsed) ? parsed : null;
      })(),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: typeof row.archived_at === "string" && row.archived_at ? row.archived_at : null,
    };
  }

  getWandTask(id: string): WandTask | null {
    const row = this.db.prepare(`SELECT ${WAND_TASK_FIELDS} FROM wand_tasks WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWandTaskRow(row) : null;
  }

  getWandTaskByWorkspaceTaskId(workspaceTaskId: string): WandTask | null {
    const row = this.db.prepare(`SELECT ${WAND_TASK_FIELDS} FROM wand_tasks
      WHERE workspace_task_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
      .get(workspaceTaskId) as Record<string, unknown> | undefined;
    return row ? this.mapWandTaskRow(row) : null;
  }

  private insertWandTask(input: CreateWandTaskInput, createdAt = nowIso()): WandTask {
    const id = crypto.randomUUID();
    const status = input.status ?? "todo";
    const createdAtValue = createdAt;
    const archivedAt = status === "archived" ? createdAtValue : null;
    const max = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS value FROM wand_tasks
      WHERE workspace_id IS ? AND status = ?`).get(input.workspaceId ?? null, status) as { value: number };
    const number = this.db.prepare(`SELECT COALESCE(MAX(CAST(substr(identifier, 6) AS INTEGER)), 0) AS value
      FROM wand_tasks WHERE identifier GLOB 'TASK-[0-9]*'`).get() as { value: number };
    this.db.prepare(`INSERT INTO wand_tasks (${WAND_TASK_FIELDS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, `TASK-${number.value + 1}`, input.workspaceId ?? null, input.workspaceTaskId ?? null,
        input.parentTaskId ?? null, input.title, input.titleSource ?? "user", null,
        input.description ?? "", status, input.priority ?? DEFAULT_WAND_TASK_PRIORITY,
        JSON.stringify(input.labels ?? []), input.dueDate ?? null, input.milestoneId ?? null,
        max.value + 1, input.agent ? JSON.stringify(input.agent) : null,
        input.executionSubject ? JSON.stringify(input.executionSubject) : null, archivedAt, createdAtValue, createdAtValue);
    return this.getWandTask(id)!;
  }

  createWandTask(input: CreateWandTaskInput): WandTask {
    return this.transaction(() => {
      const linked = input.workspaceTaskId ? this.getWorkspaceTask(input.workspaceTaskId) : null;
      const workspaceId = input.workspaceId === undefined && linked
        ? linked.workspaceId === GLOBAL_WORKSPACE_ID ? null : linked.workspaceId
        : input.workspaceId ?? null;
      const workspace = workspaceId ? this.getWorkspace(workspaceId) : this.ensureGlobalWorkspace();
      if (!workspace) throw new Error("任务所属工作区不存在。");
      const milestoneId = this.taskMilestoneForWrite(input.milestoneId, workspaceId);
      if (input.workspaceTaskId) {
        const container = this.getWorkspaceTask(input.workspaceTaskId);
        if (!container) throw new Error("未找到该任务。");
        const existing = this.getWandTaskByWorkspaceTaskId(container.id);
        // Compatibility for callers which supplied a previously created container.
        if (existing) return this.writeWandTask(existing, { ...input, workspaceId, milestoneId });
      }
      const workspaceTaskId = input.workspaceTaskId ?? this.insertWorkspaceTask({
        workspaceId: workspace.id, name: input.title,
        status: input.status === "done" || input.status === "archived" ? "done" : "active",
        milestoneId,
      });
      return this.insertWandTask({ ...input, workspaceId, workspaceTaskId, milestoneId });
    });
  }

  /** Private canonical writer; callers own the transaction, never a reverse writer. */
  private writeWandTask(current: WandTask, patch: WandTaskPatch): WandTask {
    const next = { ...current, ...patch, updatedAt: nowIso() };
    // 归档时间只在进入归档时写一次；取消归档/重新打开时清空，恢复“未动多久”重新计时。
    if (next.status === "archived") {
      if (!next.archivedAt) next.archivedAt = next.updatedAt;
    } else {
      next.archivedAt = null;
    }
    if (patch.milestoneId !== undefined || patch.workspaceId !== undefined) {
      next.milestoneId = this.taskMilestoneForWrite(next.milestoneId, next.workspaceId);
    }
    if (!next.workspaceTaskId && next.status !== "archived") {
      const workspace = next.workspaceId ? this.getWorkspace(next.workspaceId) : this.ensureGlobalWorkspace();
      if (!workspace) throw new Error("任务所属工作区不存在。");
      next.workspaceTaskId = this.insertWorkspaceTask({
        workspaceId: workspace.id, name: next.title, milestoneId: next.milestoneId,
        status: next.status === "done" ? "done" : "active", createdAt: next.createdAt,
      });
    }
    this.db.prepare(`UPDATE wand_tasks SET workspace_id = ?, workspace_task_id = ?, parent_task_id = ?,
      title = ?, title_source = ?, auto_title_signature = ?, description = ?, status = ?, priority = ?,
      labels_json = ?, due_date = ?, milestone_id = ?, sort_order = ?, agent_json = ?, execution_subject_json = ?,
      archived_at = ?, updated_at = ?
      WHERE id = ?`)
      .run(next.workspaceId, next.workspaceTaskId, next.parentTaskId, next.title, next.titleSource,
        next.autoTitleSignature ?? null, next.description, next.status, next.priority,
        JSON.stringify(next.labels), next.dueDate, next.milestoneId ?? null, next.sortOrder,
        next.agent ? JSON.stringify(next.agent) : null,
        next.executionSubject ? JSON.stringify(next.executionSubject) : null,
        next.archivedAt, next.updatedAt, next.id);
    if (patch.workspaceId !== undefined && next.workspaceTaskId) {
      const workspaceId = next.workspaceId ?? this.ensureGlobalWorkspace().id;
      // The container FK/index and standalone session workspace bucket follow the canonical project.
      this.db.prepare("UPDATE workspace_tasks SET workspace_id = ? WHERE id = ?")
        .run(workspaceId, next.workspaceTaskId);
      this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE workspace_task_id = ?")
        .run(workspaceId, next.workspaceTaskId);
    }
    return next;
  }

  updateWandTask(id: string, patch: WandTaskPatch): WandTask | null {
    return this.transaction(() => {
      const current = this.getWandTask(id);
      if (!current) return null;
      return this.writeWandTask(current, patch);
    });
  }

  /** Commit completion archives only the selected completed cards, atomically. */
  archiveCompletedWandTasks(ids: readonly string[]): string[] {
    return this.archiveWandTasks(ids, { completedOnly: true });
  }

  /**
   * Archive the given cards. Already-archived ids are skipped.
   * `completedOnly` keeps the historical commit helper from closing in-progress work.
   */
  archiveWandTasks(ids: readonly string[], options: { completedOnly?: boolean } = {}): string[] {
    return this.transaction(() => {
      const archived: string[] = [];
      for (const id of new Set(ids)) {
        const task = this.getWandTask(id);
        if (!task || task.status === "archived") continue;
        if (options.completedOnly && task.status !== "done") continue;
        this.writeWandTask(task, { status: "archived" });
        archived.push(id);
      }
      return archived;
    });
  }

  deleteWandTask(id: string): void {
    this.transaction(() => this.removeWandTaskRow(id));
  }

  /**
   * 批量硬删除卡片：一次事务，返回实际删除的 id（不存在或已消失的跳过）。
   * 归档目录的「清空」和保留期扫描都走这里，调用方自己决定哪些 id 可以删。
   */
  deleteWandTasks(ids: readonly string[]): string[] {
    return this.transaction(() => {
      const deleted: string[] = [];
      for (const id of new Set(ids)) {
        if (this.removeWandTaskRow(id)) deleted.push(id);
      }
      return deleted;
    });
  }

  /** Single-card hard delete body; callers own the transaction (SQLite forbids nesting). */
  private removeWandTaskRow(id: string): boolean {
    const card = this.getWandTask(id);
    if (!card) return false;
    this.db.prepare("UPDATE wand_tasks SET parent_task_id = NULL WHERE parent_task_id = ?").run(id);
    if (card.workspaceTaskId) {
      this.db.prepare("UPDATE command_sessions SET workspace_task_id = NULL WHERE workspace_task_id = ?")
        .run(card.workspaceTaskId);
      this.db.prepare("DELETE FROM workspace_tasks WHERE id = ?").run(card.workspaceTaskId);
    }
    this.db.prepare("DELETE FROM wand_tasks WHERE id = ?").run(id);
    return true;
  }

  /** One-time id-based reconciliation; normal reads never create tasks or repair membership. */
  private migrateTaskRecords(): void {
    if (this.getPreference<number>("pref:taskRecordsVersion", 0) === 1) return;
    this.transaction(() => {
      for (const workspace of this.listWorkspaces()) {
        for (const task of this.listWorkspaceTasks(workspace.id)) {
          if (this.getWandTaskByWorkspaceTaskId(task.id)) continue;
          this.insertWandTask({
            workspaceId: workspace.kind === "global" || workspace.id === GLOBAL_WORKSPACE_ID ? null : workspace.id,
            workspaceTaskId: task.id, title: task.name,
            titleSource: isUnnamedWorkspaceTaskName(task.name) ? "auto" : "user",
            status: task.status === "done" ? "done" : "todo", milestoneId: task.milestoneId,
          }, task.createdAt);
        }
      }
      for (const card of this.listWandTasks()) {
        let container = card.workspaceTaskId ? this.getWorkspaceTask(card.workspaceTaskId) : null;
        if (!container && card.status !== "archived") {
          const workspace = card.workspaceId ? this.getWorkspace(card.workspaceId) : this.ensureGlobalWorkspace();
          if (!workspace) continue;
          const id = this.insertWorkspaceTask({
            workspaceId: workspace.id, name: card.title, milestoneId: card.milestoneId,
            status: card.status === "done" ? "done" : "active", createdAt: card.createdAt,
          });
          this.writeWandTask(card, { workspaceTaskId: id });
          container = this.getWorkspaceTask(id);
        }
        if (!container || this.getWandTaskByWorkspaceTaskId(container.id)?.id !== card.id) continue;
        this.db.prepare("UPDATE workspace_tasks SET workspace_id = ? WHERE id = ?")
          .run(container.workspaceId, container.id);
        const previouslyBound = new Set(this.legacyWandTaskSessionIds(card.id));
        for (const sessionId of previouslyBound) {
          const session = this.getSessionWorkspace(sessionId);
          if (!session || (session.workspaceTaskId && session.workspaceTaskId !== container.id)) continue;
          this.db.prepare("UPDATE command_sessions SET workspace_task_id = ?, workspace_id = ? WHERE id = ?")
            .run(container.id, container.workspaceId, sessionId);
        }
        this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE workspace_task_id = ?")
          .run(container.workspaceId, container.id);
        const sessions = this.listSessionsByWorkspaceTaskSlim(container.id);
        for (const session of sessions) {
          this.db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)")
            .run(card.id, session.id, nowIso());
        }
        const agentSession = sessions.find((session) => isSessionProvider(session.provider));
        const newlyAssigned = sessions.some((session) => !previouslyBound.has(session.id));
        if (agentSession && (!card.agent || newlyAssigned)) {
          this.recordTaskSession(agentSession, newlyAssigned);
        } else if (newlyAssigned && sessions[0]) {
          this.recordTaskSession(sessions[0]);
        }
      }
      this.setPreference("pref:taskRecordsVersion", 1);
    });
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

  /** Live membership has a single owner: command_sessions.workspace_task_id. */
  getWandTaskIdForSession(sessionId: string): string | null {
    const binding = this.getSessionWorkspace(sessionId);
    if (binding?.workspaceTaskId) return this.getWandTaskByWorkspaceTaskId(binding.workspaceTaskId)?.id ?? null;
    const row = this.db.prepare(`SELECT links.task_id FROM wand_task_sessions links
      JOIN wand_tasks card ON card.id = links.task_id
      WHERE links.session_id = ? AND card.workspace_task_id IS NULL AND card.status = 'archived'
      ORDER BY links.rowid DESC LIMIT 1`).get(sessionId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  private legacyWandTaskSessionIds(taskId: string): string[] {
    const rows = this.db.prepare(`SELECT session_id FROM wand_task_sessions
      WHERE task_id = ? ORDER BY rowid ASC, session_id ASC`).all(taskId) as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  listWandTaskSessionIds(taskId: string): string[] {
    const task = this.getWandTask(taskId);
    if (!task) return [];
    if (!task.workspaceTaskId) return task.status === "archived" ? this.legacyWandTaskSessionIds(taskId) : [];
    // Binding timestamps are ordering metadata only; stale membership cannot leak into this projection.
    const rows = this.db.prepare(`SELECT s.id FROM command_sessions s
      LEFT JOIN wand_task_sessions links ON links.session_id = s.id AND links.task_id = ?
      WHERE s.workspace_task_id = ? ORDER BY COALESCE(links.bound_at, s.started_at), s.rowid`)
      .all(task.id, task.workspaceTaskId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  listBoundWandTaskSessionIds(): string[] {
    const rows = this.db.prepare(`SELECT s.id FROM command_sessions s
      WHERE EXISTS (SELECT 1 FROM wand_tasks card WHERE card.workspace_task_id = s.workspace_task_id)
      ORDER BY s.rowid`).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  bindWandTaskSession(taskId: string, sessionId: string): void {
    const task = this.getWandTask(taskId);
    if (!task?.workspaceTaskId) throw new Error("未找到该任务。");
    this.moveSessionToWorkspaceTask(sessionId, task.workspaceTaskId);
  }

  unbindWandTaskSession(taskId: string, sessionId: string): void {
    if (this.getWandTaskIdForSession(sessionId) === taskId) this.moveSessionToWorkspaceTask(sessionId, null);
    else this.db.prepare("DELETE FROM wand_task_sessions WHERE task_id = ? AND session_id = ?").run(taskId, sessionId);
  }

  /** Atomic exclusive ownership change; cwd, output and execution are untouched. */
  moveSessionToWorkspaceTask(sessionId: string, taskId: string | null): void {
    this.transaction(() => {
      const session = this.getSessionWorkspace(sessionId);
      if (!session) throw new Error("未找到该会话。");
      const target = taskId ? this.getWorkspaceTask(taskId) : null;
      if (taskId && !target) throw new Error("未找到目标任务。");
      if (target && !this.getWorkspace(target.workspaceId)) throw new Error("目标工作区不存在。");
      const source = session.workspaceTaskId ? this.getWorkspaceTask(session.workspaceTaskId) : null;
      if (source && source.id !== target?.id && source.layout) {
        const windows = source.layout.windows.map((window) => {
          const layout = withoutSessionTab(window.layout, sessionId);
          return { ...window, layout, activeTabId: firstLayoutTabId(layout) };
        });
        this.saveWorkspaceTaskLayout(source.id, { ...source.layout, windows });
      }
      const targetCard = target ? this.getWandTaskByWorkspaceTaskId(target.id) : null;
      if (target && !targetCard) throw new Error("未找到目标任务。");
      this.db.prepare("DELETE FROM wand_task_sessions WHERE session_id = ? AND (? IS NULL OR task_id != ?)")
        .run(sessionId, targetCard?.id ?? null, targetCard?.id ?? null);
      this.db.prepare("UPDATE command_sessions SET workspace_task_id = ?, workspace_id = ? WHERE id = ?")
        .run(target?.id ?? null, target?.workspaceId ?? session.workspaceId ?? null, sessionId);
      if (target) {
        this.db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)")
          .run(targetCard!.id, sessionId, nowIso());
        if (source?.id !== target.id) this.recordTaskSession(this.getSessionSlim(sessionId)!);
      }
    });
  }

  /** Metadata promotion happens on session creation/move, never on reads or checkpoints. */
  private recordTaskSession(session: SessionSnapshot, newlyAssigned = true): void {
    if (!session.workspaceTaskId) return;
    const card = this.getWandTaskByWorkspaceTaskId(session.workspaceTaskId);
    if (!card) return;
    this.db.prepare("INSERT OR IGNORE INTO wand_task_sessions (task_id, session_id, bound_at) VALUES (?, ?, ?)")
      .run(card.id, session.id, nowIso());
    const provider = session.provider;
    const agent: WandTaskAgent | null = isSessionProvider(provider) ? {
      provider,
      model: session.selectedModel || session.structuredState?.model || "default",
      thinkingEffort: isThinkingEffort(session.thinkingEffort) ? session.thinkingEffort : "off",
      mode: normalizeWandTaskAgentMode(provider, session.mode),
      kind: session.sessionKind === "structured" ? "structured" : "pty",
    } : null;
    this.db.prepare(`UPDATE wand_tasks SET agent_json = COALESCE(agent_json, ?),
      status = CASE WHEN status = 'todo' AND ? THEN 'doing' ELSE status END,
      updated_at = ? WHERE id = ?`)
      .run(agent ? JSON.stringify(agent) : null, newlyAssigned ? 1 : 0, nowIso(), card.id);
  }

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
    this.moveSessionToWorkspaceTask(sessionId, taskId);
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

  // ============ Silicon Employees ============

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
    if (employee.systemKey !== DEFAULT_EMPLOYEE_KEY) return employee;
    const state = this.getUserMemoryState();
    return defaultEmployeeDefinition(employee.agents, employee.updatedAt, employee,
      state.enabled ? state.profile : null);
  }

  getSiliconEmployee(id: string): SiliconEmployee | null {
    const row = this.db.prepare("SELECT * FROM silicon_employees WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.projectDefaultEmployee(mapSiliconEmployeeRow(row)) : null;
  }

  getDefaultSiliconEmployee(): SiliconEmployee | null {
    const employee = this.getSystemSiliconEmployee(DEFAULT_EMPLOYEE_KEY);
    return employee ? this.projectDefaultEmployee(employee) : null;
  }

  /** Seed once, preserve execution choices, and never reset learned preferences on restart. */
  ensureDefaultSiliconEmployee(provider?: SessionProvider): SiliconEmployee {
    const existing = this.getSystemSiliconEmployee(DEFAULT_EMPLOYEE_KEY);
    const state = this.getUserMemoryState();
    const definition = defaultEmployeeDefinition(
      existing?.agents ?? systemEmployeeSeedAgents({ provider }), new Date().toISOString(), existing,
      state.enabled ? state.profile : null,
    );
    if (!existing || existing.name !== definition.name || existing.duty !== definition.duty
      || existing.prompt !== definition.prompt || existing.avatar !== definition.avatar
      || existing.archivedAt || !existing.agents.length) {
      this.saveSiliconEmployee(definition);
      return definition;
    }
    return existing;
  }

  /** 内置「系统运维」员工；未创建（或被删除过）时返回 null。 */
  getSystemSiliconEmployee(key: string = SYSTEM_EMPLOYEE_KEY): SiliconEmployee | null {
    const row = this.db.prepare("SELECT * FROM silicon_employees WHERE system_key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? mapSiliconEmployeeRow(row) : null;
  }

  /**
   * 幂等地保证内置员工存在。已存在时只补齐锁定字段（防止旧的同名定义漂移），
   * 候选保留用户当下的设置；不存在时按 seed 建首条候选。
   */
  ensureSystemSiliconEmployee(seed: SystemEmployeeSeed = {}): SiliconEmployee {
    const existing = this.getSystemSiliconEmployee();
    if (!existing) {
      const employee = systemEmployeeDefinition(systemEmployeeSeedAgents(seed), new Date().toISOString());
      this.saveSiliconEmployee(employee);
      return employee;
    }
    const locked = systemEmployeeDefinition(existing.agents, new Date().toISOString(), existing);
    if (
      existing.name !== locked.name
      || existing.duty !== locked.duty
      || existing.prompt !== locked.prompt
      || existing.avatar !== locked.avatar
      || existing.archivedAt !== undefined
      || existing.agents.length === 0
    ) {
      this.saveSiliconEmployee(locked);
      return locked;
    }
    return existing;
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

  saveSiliconEmployee(employee: SiliconEmployee): void {
    const tags = isBuiltinSiliconEmployee(employee)
      ? siliconEmployeeTags(employee)
      : parseSiliconEmployeeTags(employee.tags ?? []);
    this.db.prepare(
      `INSERT INTO silicon_employees (
         id, name, duty, prompt, avatar, agents_json, system_key, archived_at, created_at, updated_at, tags_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         duty = excluded.duty,
         prompt = excluded.prompt,
         avatar = excluded.avatar,
         agents_json = excluded.agents_json,
         tags_json = excluded.tags_json,
         system_key = excluded.system_key,
         archived_at = excluded.archived_at,
         updated_at = excluded.updated_at`
    ).run(
      employee.id,
      employee.name,
      employee.duty,
      employee.prompt,
      employee.avatar,
      JSON.stringify(employee.agents),
      employee.systemKey ?? null,
      employee.archivedAt ?? null,
      employee.createdAt,
      employee.updatedAt,
      JSON.stringify(tags),
    );
  }

  archiveSiliconEmployee(id: string, archivedAt = new Date().toISOString()): void {
    this.db.prepare("UPDATE silicon_employees SET archived_at = ?, updated_at = ? WHERE id = ?").run(
      archivedAt,
      new Date().toISOString(),
      id,
    );
  }

  unarchiveSiliconEmployee(id: string): void {
    this.db.prepare("UPDATE silicon_employees SET archived_at = NULL, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
  }

  deleteSiliconEmployee(id: string): void {
    this.db.prepare("DELETE FROM silicon_employees WHERE id = ?").run(id);
  }

  // ============ Employee-owned explicit knowledge ============

  private requireKnowledgeEmployee(employeeId: string): void {
    if (!this.db.prepare("SELECT id FROM silicon_employees WHERE id = ?").get(employeeId)) {
      throw new Error("员工已删除或不存在，不能改存到其他员工的知识库。");
    }
  }

  listEmployeeKnowledge(employeeId: string, query = "", limit = 20): EmployeeKnowledgeEntry[] {
    this.requireKnowledgeEmployee(employeeId);
    const normalizedQuery = query.trim().slice(0, 200).toLowerCase();
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), EMPLOYEE_KNOWLEDGE_MAX_ENTRIES));
    // SQLite lower() is ASCII-only. Load at most this employee's fixed quota,
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
    return this.transaction(() => {
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
    return this.transaction(() => {
      this.requireKnowledgeEmployee(employeeId);
      if (accessToken && this.resolveEmployeeKnowledgeAccess(accessToken) !== employeeId) {
        throw new Error("知识库访问已失效，请等待新的会话执行。");
      }
      return this.db.prepare("DELETE FROM employee_knowledge WHERE employee_id = ? AND id = ?")
        .run(employeeId, entryId).changes === 1;
    });
  }

  clearEmployeeKnowledge(employeeId: string): void {
    this.transaction(() => {
      this.requireKnowledgeEmployee(employeeId);
      this.db.prepare("DELETE FROM employee_knowledge WHERE employee_id = ?").run(employeeId);
      this.db.prepare("DELETE FROM employee_knowledge_access WHERE employee_id = ?").run(employeeId);
    });
  }

  /** Opaque per-execution capability: no employee selector, app token or DB secret in model prompts. */
  issueEmployeeKnowledgeAccess(sessionId: string, employeeId: string, now = Date.now()): string {
    this.requireKnowledgeEmployee(employeeId);
    const row = this.getSessionSlim(sessionId);
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
    if (!this.getSessionSlim(sessionId)) throw new Error("决策调用所属会话不存在。");
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
    const session = this.getSessionSlim(sessionId);
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

  // ============ User short-term memory ============

  /** No IO on input hot paths; queued observations still CAS against the database before writing. */
  userMemoryCaptureState(): Readonly<{ enabled: boolean; revision: number }> {
    return this.memoryCapture;
  }

  stopUserMemoryCapture(): void {
    this.memoryCapture = { ...this.memoryCapture, enabled: false };
  }

  getUserMemoryState(now = Date.now()): UserMemoryState {
    const row = this.db.prepare("SELECT * FROM user_memory_state WHERE id = 1").get()!;
    const candidate = safeJsonParse<UserMemoryProfile>(row.profile_json as string | null);
    let profile = candidate && candidate.expiresAt > now && Array.isArray(candidate.preferences)
      && candidate.preferences.length <= 10 && candidate.preferences.every((entry) =>
        entry && typeof entry.text === "string" && entry.text.length <= 160
        && Array.isArray(entry.evidenceIds) && entry.evidenceIds.length <= 5
        && entry.evidenceIds.every((id) => Number.isSafeInteger(id))) ? candidate : null;
    const ids = profile ? [...new Set(profile.preferences.flatMap((entry) => entry.evidenceIds))] : [];
    if (ids.length) {
      const count = this.db.prepare(`SELECT COUNT(*) AS total FROM user_memory_events
        WHERE id IN (${ids.map(() => "?").join(",")}) AND created_at > ? AND created_at <= ?`)
        .get(...ids, now - USER_MEMORY_RETENTION_MS, now)?.total;
      if (count !== ids.length) profile = null;
    }
    return {
      enabled: row.enabled === 1,
      revision: Number(row.revision),
      lastAttemptAt: Number(row.last_attempt_at),
      sourceId: Number(row.source_id),
      profile,
    };
  }

  listUserMemoryEvents(now = Date.now(), limit = 80): UserMemoryEvent[] {
    const rows = this.db.prepare(`SELECT id, feature, text, created_at FROM user_memory_events
      WHERE created_at > ? AND created_at <= ? ORDER BY id DESC LIMIT ?`)
      .all(now - USER_MEMORY_RETENTION_MS, now, Math.max(1, Math.min(limit, USER_MEMORY_MAX_EVENTS))) as
      Array<{ id: number; feature: string; text: string; created_at: number }>;
    return rows.reverse().map((row) => ({
      id: row.id, feature: row.feature, text: row.text, createdAt: row.created_at,
    }));
  }

  userMemoryFeatureCounts(now = Date.now()): Array<{ feature: string; count: number }> {
    return this.db.prepare(`SELECT feature, COUNT(*) AS count FROM user_memory_events
      WHERE created_at > ? AND created_at <= ? GROUP BY feature ORDER BY count DESC, feature`)
      .all(now - USER_MEMORY_RETENTION_MS, now) as Array<{ feature: string; count: number }>;
  }

  /** Only already-redacted, bounded observations reach this table. Queued writes use revision CAS. */
  appendUserMemoryEvent(
    feature: string, text: string, dedupKey: string, revision: number, now = Date.now(),
  ): void {
    this.transaction(() => {
      const state = this.getUserMemoryState(now);
      if (!state.enabled || state.revision !== revision) return;
      this.pruneUserMemory(now);
      const duplicate = this.db.prepare(`SELECT id FROM user_memory_events
        WHERE dedup_key = ? AND created_at > ? LIMIT 1`).get(dedupKey, now - 120_000);
      if (duplicate) return;
      this.db.prepare(`INSERT INTO user_memory_events (feature, text, dedup_key, created_at)
        VALUES (?, ?, ?, ?)`).run(feature, text, dedupKey, now);
      this.db.prepare(`DELETE FROM user_memory_events WHERE id NOT IN
        (SELECT id FROM user_memory_events ORDER BY id DESC LIMIT ?)`)
        .run(USER_MEMORY_MAX_EVENTS);
      this.pruneUserMemory(now);
    });
  }

  pruneUserMemory(now = Date.now()): void {
    this.db.prepare("DELETE FROM user_memory_events WHERE created_at <= ?")
      .run(now - USER_MEMORY_RETENTION_MS);
    const saved = this.db.prepare("SELECT profile_json FROM user_memory_state WHERE id = 1").get();
    if (saved?.profile_json && !this.getUserMemoryState(now).profile) {
      this.db.exec("UPDATE user_memory_state SET profile_json = NULL, source_id = 0 WHERE id = 1");
      this.ensureDefaultSiliconEmployee();
    }
  }

  setUserMemoryEnabled(enabled: boolean): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE user_memory_state SET enabled = ?, revision = revision + 1,
        last_attempt_at = 0, source_id = 0, profile_json = NULL WHERE id = 1`).run(enabled ? 1 : 0);
      this.ensureDefaultSiliconEmployee();
    });
    this.memoryCapture = { enabled, revision: this.memoryCapture.revision + 1 };
  }

  clearUserMemory(): void {
    this.transaction(() => {
      this.db.exec(`DELETE FROM user_memory_events;
        UPDATE user_memory_state SET revision = revision + 1, last_attempt_at = 0,
          source_id = 0, profile_json = NULL WHERE id = 1;`);
      this.ensureDefaultSiliconEmployee();
    });
    this.memoryCapture = { ...this.memoryCapture, revision: this.memoryCapture.revision + 1 };
  }

  markUserMemoryAttempt(revision: number, now: number): boolean {
    return this.db.prepare(`UPDATE user_memory_state SET last_attempt_at = ?
      WHERE id = 1 AND enabled = 1 AND revision = ?`).run(now, revision).changes === 1;
  }

  /** Read fresh candidates inside the transaction; a late model result cannot undo user edits/clear. */
  applyUserMemoryProfile(
    profile: UserMemoryProfile, revision: number, sourceId: number, now = Date.now(),
  ): boolean {
    return this.transaction(() => {
      const state = this.getUserMemoryState(now);
      if (!state.enabled || state.revision !== revision || profile.expiresAt <= now) return false;
      const evidence = this.db.prepare("SELECT created_at FROM user_memory_events WHERE id = ?");
      for (const id of new Set(profile.preferences.flatMap((entry) => entry.evidenceIds))) {
        const row = evidence.get(id);
        if (!row || Number(row.created_at) <= now - USER_MEMORY_RETENTION_MS) return false;
      }
      this.db.prepare(`UPDATE user_memory_state SET profile_json = ?, source_id = ? WHERE id = 1`)
        .run(JSON.stringify(profile), sourceId);
      this.ensureDefaultSiliconEmployee();
      return true;
    });
  }

  // ============ AI Teams ============

  listAiTeams(): AiTeam[] {
    const rows = this.db.prepare("SELECT * FROM ai_teams ORDER BY created_at ASC").all() as unknown as Record<string, unknown>[];
    return rows.map((row) => projectTeamDefinition(mapAiTeamRow(row), this));
  }

  getAiTeam(id: string): AiTeam | null {
    const row = this.db.prepare("SELECT * FROM ai_teams WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? projectTeamDefinition(mapAiTeamRow(row), this) : null;
  }

  saveAiTeam(team: AiTeam): void {
    team = freezeTeamEmployees(team, this);
    this.db.prepare(
      `INSERT INTO ai_teams (
         id, name, description, instructions, members_json, require_plan_approval, max_steps,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         instructions = excluded.instructions,
         members_json = excluded.members_json,
         require_plan_approval = excluded.require_plan_approval,
         max_steps = excluded.max_steps, updated_at = excluded.updated_at`
    ).run(
      team.id, team.name, team.description, team.instructions, JSON.stringify(team.members),
      team.requirePlanApproval ? 1 : 0, team.maxSteps, team.createdAt, team.updatedAt,
    );
  }

  /** 只删团队定义；已有运行保存了团队快照，不受影响。 */
  deleteAiTeam(id: string): void {
    this.db.prepare("DELETE FROM ai_teams WHERE id = ?").run(id);
  }

  /** 保留期清理：删掉一次运行及其步骤。关联会话由调用方按运行所有权删除。 */
  deleteAiTeamRun(id: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM ai_team_steps WHERE run_id = ?").run(id);
      this.db.prepare("DELETE FROM ai_team_runs WHERE id = ?").run(id);
    });
  }

  saveAiTeamRun(run: AiTeamRun): void {
    this.db.prepare(
      `INSERT INTO ai_team_runs (
         id, team_id, task_id, team_json, objective, cwd, status, status_detail,
         steps_used, step_limit, format_retries, plan_approved, chat_session_id, pending_notes_json,
         created_at, updated_at, conversation_id, member_version, round_number
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         team_json = excluded.team_json,
         status = excluded.status, status_detail = excluded.status_detail,
         steps_used = excluded.steps_used, step_limit = excluded.step_limit,
         format_retries = excluded.format_retries, plan_approved = excluded.plan_approved,
         chat_session_id = excluded.chat_session_id, pending_notes_json = excluded.pending_notes_json,
         conversation_id = COALESCE(excluded.conversation_id, ai_team_runs.conversation_id),
         member_version = COALESCE(excluded.member_version, ai_team_runs.member_version),
         round_number = COALESCE(excluded.round_number, ai_team_runs.round_number),
         updated_at = excluded.updated_at`
    ).run(
      run.id, run.teamId, run.taskId, serializeExecutionTeam(run.team), run.objective, run.cwd,
      run.status, run.statusDetail, run.stepsUsed, run.stepLimit, run.formatRetries,
      run.planApproved ? 1 : 0, run.chatSessionId, JSON.stringify(run.pendingNotes), run.createdAt, run.updatedAt,
      run.conversationId ?? null, run.memberVersion ?? null, run.roundNumber ?? null,
    );
  }

  /** 群聊会话对应的最近一次运行（同一个群聊可以接着开新运行）。 */
  getLatestAiTeamRunByChat(sessionId: string): AiTeamRun | null {
    const row = this.db.prepare(
      "SELECT * FROM ai_team_runs WHERE chat_session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapAiTeamRunRow(row) : null;
  }

  /**
   * 会话列表用的群聊标记索引：chat_session_id → 最近一次运行的入口信息。
   * 一次查询建整张表，供 /api/tasks 每请求一次构建；不逐会话查询。
   */
  listAiTeamRunChatMarkers(): Map<string, AiTeamRunChatMarker> {
    const rows = this.db.prepare(
      `SELECT r.id, r.team_id, r.team_json, r.chat_session_id, t.name AS current_team_name,
              task.title AS task_title
       FROM ai_team_runs r LEFT JOIN ai_teams t ON t.id = r.team_id
       LEFT JOIN command_sessions s ON s.id = r.chat_session_id
       LEFT JOIN wand_tasks task ON task.id = COALESCE((
         SELECT id FROM wand_tasks WHERE workspace_task_id = s.workspace_task_id
         ORDER BY updated_at DESC, rowid DESC LIMIT 1
       ), r.task_id)
       WHERE r.chat_session_id IS NOT NULL AND r.chat_session_id <> '' ORDER BY r.created_at DESC`,
    ).all() as unknown as Record<string, unknown>[];
    const markers = new Map<string, AiTeamRunChatMarker>();
    for (const row of rows) {
      const chatSessionId = typeof row.chat_session_id === "string" ? row.chat_session_id : "";
      if (!chatSessionId || markers.has(chatSessionId)) continue;
      const rawTeam = safeJsonParse<Record<string, unknown>>(typeof row.team_json === "string" ? row.team_json : null);
      markers.set(chatSessionId, {
        runId: String(row.id),
        teamId: String(row.team_id),
        teamName: typeof row.current_team_name === "string" ? row.current_team_name : String(rawTeam?.name ?? ""),
        chatTitle: aiTeamChatTitle(typeof row.task_title === "string" ? row.task_title : ""),
        memberCount: Array.isArray(rawTeam?.members) ? rawTeam.members.length : 0,
      });
    }
    return markers;
  }

  /**
   * 会话列表用的成员步骤标记：session_id → 这一步的身份。
   * 和 `listAiTeamRunChatMarkers()` 一样一次查询建整张表，供 /api/tasks 每请求一次构建。
   * 同一个会话被多个步骤复用时取 seq 最大的那一步（最近一次派发）。
   */
  listAiTeamStepSessionMarkers(): Map<string, AiTeamStepSessionMarker> {
    const rows = this.db.prepare(
      `SELECT s.id, s.run_id, s.kind, s.seq, s.member_id, s.title, s.status, s.session_id,
              r.status AS run_status, r.team_json, t.name AS current_team_name, t.members_json AS current_members_json
       FROM ai_team_steps s
       JOIN ai_team_runs r ON r.id = s.run_id
       LEFT JOIN ai_teams t ON t.id = r.team_id
       WHERE s.session_id IS NOT NULL AND s.session_id <> ''
       ORDER BY s.seq DESC`,
    ).all() as unknown as Record<string, unknown>[];
    const markers = new Map<string, AiTeamStepSessionMarker>();
    const currentTeams = new Map<string, unknown>();
    for (const row of rows) {
      const sessionId = typeof row.session_id === "string" ? row.session_id : "";
      if (!sessionId || markers.has(sessionId)) continue;
      const runTeam = safeJsonParse<Record<string, unknown>>(typeof row.team_json === "string" ? row.team_json : null);
      const runId = String(row.run_id);
      const memberId = String(row.member_id ?? "");
      if (!currentTeams.has(runId)) {
        // ai_teams.members_json 存的是裸成员数组；team_json 存的是整份团队对象。
        currentTeams.set(runId, safeJsonParse<unknown>(
          typeof row.current_members_json === "string" ? row.current_members_json : null,
        ));
      }
      const frozenMember = normalizeAiTeamMembers(runTeam?.members).find((member) => member.id === memberId);
      const currentMember = normalizeAiTeamMembers(currentTeams.get(runId)).find((member) => member.id === memberId);
      const employee = frozenMember?.employeeId ? this.getSiliconEmployee(frozenMember.employeeId) : null;
      const memberName = (frozenMember?.employeeId
        ? employee?.name ?? frozenMember.name
        : currentMember?.employeeId ? undefined : teamMemberName(currentTeams.get(runId), memberId))
        ?? teamMemberName(runTeam?.members, memberId)
        ?? memberId;
      const runStatus = String(row.run_status ?? "") as AiTeamRunStatus;
      markers.set(sessionId, {
        runId,
        stepId: String(row.id),
        kind: String(row.kind ?? "work") === "leader" ? "leader" : "work",
        title: String(row.title ?? ""),
        memberId,
        memberName,
        teamName: typeof row.current_team_name === "string" && row.current_team_name
          ? row.current_team_name
          : String(runTeam?.name ?? ""),
        stepStatus: String(row.status ?? "queued") as AiTeamStepStatus,
        runStatus,
        runFinished: AI_TEAM_TERMINAL_RUN_STATUSES.includes(runStatus),
      });
    }
    return markers;
  }

  getAiTeamRun(id: string): AiTeamRun | null {
    const row = this.db.prepare("SELECT * FROM ai_team_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapAiTeamRunRow(row) : null;
  }

  listAiTeamRuns(
    filter: { taskId?: string; teamId?: string; statuses?: readonly AiTeamRunStatus[]; limit?: number } = {},
  ): AiTeamRun[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.taskId) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.teamId) {
      where.push("team_id = ?");
      params.push(filter.teamId);
    }
    if (filter.statuses) {
      if (filter.statuses.length === 0) return [];
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const rows = this.db.prepare(
      `SELECT * FROM ai_team_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`
        + (filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "")
    ).all(...params) as unknown as Record<string, unknown>[];
    return rows.map(mapAiTeamRunRow);
  }

  saveAiTeamStep(step: AiTeamStep): void {
    this.db.prepare(
      `INSERT INTO ai_team_steps (
         id, run_id, seq, kind, member_id, title, instructions, session_id, status,
         report, report_path, depends_on_json, started_at, ended_at, dispatch_info_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, status = excluded.status, report = excluded.report,
         instructions = excluded.instructions, report_path = excluded.report_path,
         depends_on_json = excluded.depends_on_json,
         dispatch_info_json = excluded.dispatch_info_json,
         started_at = excluded.started_at, ended_at = excluded.ended_at`
    ).run(
      step.id, step.runId, step.seq, step.kind, step.memberId, step.title, step.instructions,
      step.sessionId, step.status, step.report, step.reportPath, JSON.stringify(step.dependsOn),
      step.startedAt, step.endedAt, JSON.stringify(step.dispatchInfo ?? { usedCandidate: 0, skipped: [] }),
    );
  }

  listAiTeamSteps(runId: string): AiTeamStep[] {
    const rows = this.db.prepare("SELECT * FROM ai_team_steps WHERE run_id = ? ORDER BY seq ASC").all(runId) as unknown as Record<string, unknown>[];
    return rows.map(mapAiTeamStepRow);
  }

  getRunningAiTeamStepBySession(sessionId: string): AiTeamStep | null {
    const row = this.db.prepare(
      "SELECT * FROM ai_team_steps WHERE session_id = ? AND status = 'running' LIMIT 1"
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapAiTeamStepRow(row) : null;
  }

  /** `ai_team_runs.run_state_json` 的读侧入口（§3.4）；脏值 / 旧行退化成空黑名单。 */
  getAiTeamRunState(runId: string): AiTeamRunState {
    const row = this.db.prepare("SELECT run_state_json FROM ai_team_runs WHERE id = ?").get(runId) as
      | { run_state_json?: unknown }
      | undefined;
    return parseAiTeamRunState(row?.run_state_json);
  }

  /** 只写 `run_state_json` 一列，不碰 `saveAiTeamRun` 负责的业务字段。 */
  setAiTeamRunState(runId: string, state: AiTeamRunState): void {
    this.db.prepare("UPDATE ai_team_runs SET run_state_json = ? WHERE id = ?")
      .run(JSON.stringify(state), runId);
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

  /** Completion/read state is independent of runner checkpoints and survives restarts. */
  getSessionCompletion(id: string): { completionRevision: number; viewedCompletionRevision: number } | null {
    const row = this.db.prepare(`SELECT completion_revision AS completionRevision,
      viewed_completion_revision AS viewedCompletionRevision FROM command_sessions WHERE id = ?`)
      .get(id) as { completionRevision: number; viewedCompletionRevision: number } | undefined;
    return row ? { ...row } : null;
  }

  recordSessionCompletion(id: string): ReturnType<WandStorage["getSessionCompletion"]> {
    const row = this.db.prepare(`UPDATE command_sessions SET completion_revision = completion_revision + 1
      WHERE id = ? RETURNING completion_revision AS completionRevision,
        viewed_completion_revision AS viewedCompletionRevision`)
      .get(id) as { completionRevision: number; viewedCompletionRevision: number } | undefined;
    return row ? { ...row } : null;
  }

  /** A delayed view of generation N must never consume a newer completion N+1. */
  markSessionCompletionViewed(id: string, revision: number): boolean {
    return this.db.prepare(`UPDATE command_sessions SET viewed_completion_revision = ?
      WHERE id = ? AND completion_revision = ? AND viewed_completion_revision < ?`)
      .run(revision, id, revision, revision).changes > 0;
  }

  saveSession(snapshot: SessionSnapshot): void {
    const isNew = !this.getSessionWorkspace(snapshot.id);
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
    if (isNew) {
      const task = snapshot.workspaceTaskId ? this.getWorkspaceTask(snapshot.workspaceTaskId) : null;
      if (task && task.workspaceId !== snapshot.workspaceId) {
        this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE id = ?")
          .run(task.workspaceId, snapshot.id);
      }
      this.recordTaskSession(snapshot);
    }
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

function mapSiliconEmployeeRow(row: Record<string, unknown>): SiliconEmployee {
  const rawAgents = safeJsonParse<unknown>(typeof row.agents_json === "string" ? row.agents_json : null);
  const agents = Array.isArray(rawAgents)
    ? rawAgents
        .map((candidate) => parseWandTaskAgent(candidate))
        .filter((candidate): candidate is WandTaskAgent => candidate !== null)
    : [];
  const systemKey = typeof row.system_key === "string" && row.system_key ? row.system_key : undefined;
  const rawTags = safeJsonParse<unknown>(typeof row.tags_json === "string" ? row.tags_json : null);
  const tags = Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === "string") : [];

  return {
    id: String(row.id),
    name: String(row.name),
    duty: String(row.duty ?? ""),
    prompt: String(row.prompt ?? ""),
    avatar: String(row.avatar ?? ""),
    agents,
    systemKey,
    tags: siliconEmployeeTags({ systemKey, tags }),
    archivedAt: typeof row.archived_at === "string" && row.archived_at ? row.archived_at : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAiTeamRow(row: Record<string, unknown>): AiTeam {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    instructions: String(row.instructions ?? ""),
    members: normalizeAiTeamMembers(safeJsonParse<unknown>(typeof row.members_json === "string" ? row.members_json : null)),
    requirePlanApproval: Number(row.require_plan_approval) !== 0,
    maxSteps: Number(row.max_steps) || AI_TEAM_DEFAULT_MAX_STEPS,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 旧行读端归一（§3.1 修正 B10）：members 是从 members_json/team_json 解析出的裸 JSON，
 * 不满足 AiTeamMember 类型，必须逐成员经 memberAgents 补齐 agents 后才能当 AiTeamMember 用。
 * 没有任何可识别执行配置的成员行直接丢弃（旧数据必然带 agent，走到这里说明行已损坏）。
 */
function normalizeAiTeamMember(raw: unknown): AiTeamMember | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const rawAgent = parseWandTaskAgent(value.agent) ?? undefined;
  const agents = memberAgents({
    agent: rawAgent,
    agents: Array.isArray(value.agents)
      ? value.agents.map((candidate) => parseWandTaskAgent(candidate)).filter((candidate): candidate is WandTaskAgent => candidate !== null)
      : undefined,
  });
  if (agents.length === 0) return null;
  const member: AiTeamMember = {
    id: String(value.id ?? ""),
    name: String(value.name ?? ""),
    duty: String(value.duty ?? ""),
    agents,
    agent: rawAgent ?? agents[0]!,
    isLeader: value.isLeader === true,
  };
  if (typeof value.avatar === "string" && value.avatar) member.avatar = value.avatar;
  if (isTeamMemberRole(value.role)) member.role = value.role;
  if (typeof value.legacyTemplateId === "string") member.legacyTemplateId = value.legacyTemplateId;
  if (typeof value.legacyMemberId === "string") member.legacyMemberId = value.legacyMemberId;
  if (typeof value.employeeId === "string" && value.employeeId.trim()) {
    member.employeeId = value.employeeId.trim();
    const raw = value._employeeSnapshot;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const snapshot = raw as Record<string, unknown>;
      if (snapshot.id === member.employeeId && typeof snapshot.prompt === "string") {
        restoreTeamMemberEmployee(member, {
          id: member.employeeId, name: member.name, avatar: member.avatar ?? "",
          prompt: snapshot.prompt, duty: String(snapshot.duty ?? ""), agents,
          createdAt: String(snapshot.createdAt ?? ""), updatedAt: String(snapshot.updatedAt ?? ""),
        });
      }
    }
  }
  return member;
}

function normalizeAiTeamMembers(raw: unknown): AiTeamMember[] {
  if (!Array.isArray(raw)) return [];
  const members: AiTeamMember[] = [];
  for (const item of raw) {
    const member = normalizeAiTeamMember(item);
    if (member) members.push(member);
  }
  return members;
}

/**
 * 从裸成员 JSON（`ai_teams.members_json` 是数组、`team_json.members` 是数组）里按 id 取显示名。
 * 列表只要名字投影，不做读端归一，损坏行也不该把名字整个丢掉。
 */
function teamMemberName(members: unknown, memberId: string): string | undefined {
  if (!Array.isArray(members)) return undefined;
  for (const member of members) {
    if (!member || typeof member !== "object") continue;
    const record = member as Record<string, unknown>;
    if (String(record.id ?? "") !== memberId) continue;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name) return name;
  }
  return undefined;
}

function mapAiTeamRunRow(row: Record<string, unknown>): AiTeamRun {
  const rawTeam = safeJsonParse<Record<string, unknown>>(typeof row.team_json === "string" ? row.team_json : null);
  const team: AiTeam | null = rawTeam ? {
    id: String(rawTeam.id ?? row.team_id),
    name: String(rawTeam.name ?? ""),
    description: String(rawTeam.description ?? ""),
    instructions: String(rawTeam.instructions ?? ""),
    members: normalizeAiTeamMembers(rawTeam.members),
    ...(rawTeam.allowLeaderWork === true ? { allowLeaderWork: true } : {}),
    requirePlanApproval: rawTeam.requirePlanApproval === undefined ? true : rawTeam.requirePlanApproval !== false,
    maxSteps: Number(rawTeam.maxSteps) || AI_TEAM_DEFAULT_MAX_STEPS,
    createdAt: String(rawTeam.createdAt ?? row.created_at),
    updatedAt: String(rawTeam.updatedAt ?? row.created_at),
  } : null;
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    team: team ?? {
      id: String(row.team_id), name: "", description: "", instructions: "", members: [], requirePlanApproval: true,
      maxSteps: AI_TEAM_DEFAULT_MAX_STEPS, createdAt: String(row.created_at), updatedAt: String(row.created_at),
    },
    taskId: String(row.task_id),
    objective: String(row.objective),
    cwd: String(row.cwd),
    status: String(row.status) as AiTeamRunStatus,
    statusDetail: String(row.status_detail ?? ""),
    stepsUsed: Number(row.steps_used) || 0,
    stepLimit: Number(row.step_limit) || AI_TEAM_DEFAULT_MAX_STEPS,
    formatRetries: Number(row.format_retries) || 0,
    planApproved: Number(row.plan_approved) !== 0,
    chatSessionId: typeof row.chat_session_id === "string" && row.chat_session_id ? row.chat_session_id : null,
    ...(typeof row.conversation_id === "string" ? {
      conversationId: row.conversation_id, memberVersion: Number(row.member_version), roundNumber: Number(row.round_number),
    } : {}),
    pendingNotes: (safeJsonParse<unknown[]>(typeof row.pending_notes_json === "string" ? row.pending_notes_json : null) ?? [])
      .filter((note): note is string => typeof note === "string"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 候选失败类别的读侧白名单；真源是 `ai-team-types.ts` 的 `CandidateFailureKind`。 */
const CANDIDATE_FAILURE_KINDS: readonly CandidateFailureKind[] = [
  "spawn-missing", "input-rejected", "host-disabled", "model-unknown", "startup-timeout",
  "runtime-failure", "format-error", "user-stop",
];

function isCandidateFailureKind(value: unknown): value is CandidateFailureKind {
  return CANDIDATE_FAILURE_KINDS.includes(value as CandidateFailureKind);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * `ai_team_steps.dispatch_info_json` 的读侧校验（§3.2）。脏值 / 旧行默认 `{}` 一律退化成
 * 「首选、没跳过任何候选」，坏条目逐条丢弃，不整字段作废——降级留痕是可观测性数据，
 * 不能因为一条脏记录把整条链丢掉。
 */
export function parseStepDispatchInfo(raw: unknown): StepDispatchInfo {
  const value = typeof raw === "string" ? safeJsonParse<unknown>(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { usedCandidate: 0, skipped: [] };
  const record = value as Record<string, unknown>;
  const skippedRaw = Array.isArray(record.skipped) ? record.skipped : [];
  const skipped: StepDispatchInfo["skipped"] = [];
  for (const item of skippedRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const agent = parseWandTaskAgent(entry.agent);
    const candidate = Number(entry.candidate);
    const reason = nonEmptyString(entry.reason);
    if (!agent || !Number.isInteger(candidate) || candidate < 0 || !reason) continue;
    // 未知类别按 runtime-failure 记：它不可降级，宁可少降一级也不因为脏数据错换候选。
    skipped.push({
      candidate,
      agent,
      reason,
      errorKind: isCandidateFailureKind(entry.errorKind) ? entry.errorKind : "runtime-failure",
    });
  }
  const usedRaw = Number(record.usedCandidate);
  const used = Number.isInteger(usedRaw) && usedRaw > 0 ? usedRaw : 0;
  // 与留痕自相矛盾的脏值以 skipped 链为准向下纠正，绝不凭空跳级。
  const trail = skipped.reduce((highest, item) => Math.max(highest, item.candidate), -1) + 1;
  return { usedCandidate: skipped.length > 0 ? Math.min(used, trail) : used, skipped };
}

/** `ai_team_runs.run_state_json` 的读侧校验（§3.4）；脏值退化成空黑名单。 */
export function parseAiTeamRunState(raw: unknown): AiTeamRunState {
  const value = typeof raw === "string" ? safeJsonParse<unknown>(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { providers: [], agents: [], strikes: {}, hostDisabled: [] };
  const record = value as Record<string, unknown>;
  const state: AiTeamRunState = { providers: [], agents: [], strikes: {}, hostDisabled: [] };
  for (const item of Array.isArray(record.providers) ? record.providers : []) {
    const provider = nonEmptyString(item);
    if (isSessionProvider(provider) && !state.providers.includes(provider)) state.providers.push(provider);
  }
  for (const item of Array.isArray(record.agents) ? record.agents : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const key = nonEmptyString(entry.key);
    if (key && !state.agents.some((agent) => agent.key === key)) {
      state.agents.push({ key, kind: isCandidateFailureKind(entry.kind) ? entry.kind : "runtime-failure" });
    }
  }
  const strikes = record.strikes;
  if (strikes && typeof strikes === "object" && !Array.isArray(strikes)) {
    for (const [key, count] of Object.entries(strikes as Record<string, unknown>)) {
      const value2 = Number(count);
      if (key && Number.isFinite(value2) && value2 > 0) state.strikes[key] = Math.min(999, Math.floor(value2));
    }
  }
  for (const item of Array.isArray(record.hostDisabled) ? record.hostDisabled : []) {
    const kind = nonEmptyString(item);
    if (isWandTaskAgentKind(kind) && !state.hostDisabled.includes(kind)) state.hostDisabled.push(kind);
  }
  return state;
}

function mapAiTeamStepRow(row: Record<string, unknown>): AiTeamStep {
  const step: AiTeamStep = {
    id: String(row.id),
    runId: String(row.run_id),
    seq: Number(row.seq),
    kind: String(row.kind) as AiTeamStepKind,
    memberId: String(row.member_id),
    title: String(row.title),
    instructions: String(row.instructions),
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
    status: String(row.status) as AiTeamStepStatus,
    report: String(row.report ?? ""),
    reportPath: String(row.report_path),
    dependsOn: safeJsonParse<string[]>(typeof row.depends_on_json === "string" ? row.depends_on_json : null) ?? [],
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
  };
  const dispatchInfo = parseStepDispatchInfo(
    typeof row.dispatch_info_json === "string" ? row.dispatch_info_json : null,
  );
  if (dispatchInfo.usedCandidate > 0 || dispatchInfo.skipped.length > 0) step.dispatchInfo = dispatchInfo;
  return step;
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
  ["completion_revision", "ALTER TABLE command_sessions ADD COLUMN completion_revision INTEGER NOT NULL DEFAULT 0"],
  ["viewed_completion_revision", "ALTER TABLE command_sessions ADD COLUMN viewed_completion_revision INTEGER NOT NULL DEFAULT 0"],
];

/** 首页目录组顺序的偏好键（app_config 表，与其它 UI 偏好同一套读写）。 */
const WORKSPACE_GROUP_ORDER_KEY = "workspaceGroupOrder";

/** Pi 会话默认设置的偏好键，与其它 UI 偏好同一套读写，不出现在 config.json。 */
const PI_SESSION_DEFAULTS_KEY = "pref:piSessionDefaults";

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
