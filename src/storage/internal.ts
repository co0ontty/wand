import path from "node:path";
import { restoreTeamMemberEmployee } from "../ai-team-employee-binding.js";
import type { AiTeam, AiTeamMember, AiTeamRun, AiTeamRunStatus, AiTeamStep, AiTeamStepKind, AiTeamStepStatus, CandidateFailureKind, SiliconEmployee, StepDispatchInfo } from "../ai-team-types.js";
import { AI_TEAM_DEFAULT_MAX_STEPS, isTeamMemberRole, memberAgents, siliconEmployeeTags } from "../ai-team-types.js";
import { decisionExpertDefinition } from "../decision-expert-employee.js";
import { hrEmployeeDefinition } from "../hr-employee.js";
import type { AgentActivityItem, AgentActivityState, Mission, MissionAttempt, MissionAttemptState, MissionReviewComment, MissionReviewStatus, MissionStatus } from "../mission-types.js";
import { type PasswordVault, type PasswordVaultItem } from "../password-manager.js";
import { isSessionProvider } from "../session-provider.js";
import type { WandTask, WandTaskAgent, WandTaskAgentKind, WandTaskTitleSource } from "../task-types.js";
import { isWandTaskAgentKind } from "../task-types.js";
import { GLOBAL_WORKSPACE_ID, LayoutNode, SessionProvider } from "../types.js";
import { PasswordVaultRow, PasswordVaultItemRow, safeJsonParse } from "./mappers.js";
import { parseWandTaskAgent } from "./mappers.js";

// Shared module-level helpers for the storage repositories (moved verbatim from storage.ts).

// These system profiles are code-owned; candidates and timestamps are not part of the lock.
export const LOCKED_SYSTEM_EMPLOYEE_DEFINITIONS = [decisionExpertDefinition(""), hrEmployeeDefinition("")];

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


export interface CreateWandTaskInput {
  workspaceId?: string | null;
  workspaceTaskId?: string | null;
  acceptance?: WandTask["acceptance"];
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

export type WandTaskPatch = Partial<Pick<WandTask,
  "workspaceId" | "workspaceTaskId" | "parentTaskId" | "title" | "titleSource"
  | "autoTitleSignature" | "description" | "status" | "priority" | "labels"
  | "dueDate" | "milestoneId" | "sortOrder" | "agent" | "executionSubject" | "acceptance">>;

export const WAND_TASK_FIELDS = `id, identifier, workspace_id, workspace_task_id, parent_task_id,
  title, title_source, auto_title_signature, description, status, priority, labels_json,
  due_date, milestone_id, sort_order, agent_json, execution_subject_json, archived_at, created_at, updated_at, acceptance_json`;

// Shared metadata comes from the latest explicitly linked card, including meaningful NULLs.
// The old container columns remain readable for legacy rows until the startup migration.
export const WORKSPACE_TASK_PROJECTION = `SELECT wt.id,
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

export function withoutSessionTab(node: LayoutNode, sessionId: string): LayoutNode {
  if (node.type === "split") return {
    ...node,
    children: [withoutSessionTab(node.children[0], sessionId), withoutSessionTab(node.children[1], sessionId)],
  };
  const activeId = node.tabs[node.active]?.id;
  const tabs = node.tabs.filter((tab) => tab.kind !== "session" || tab.sessionId !== sessionId);
  const active = tabs.findIndex((tab) => tab.id === activeId);
  return { ...node, tabs, active: active >= 0 ? active : Math.min(node.active, Math.max(0, tabs.length - 1)) };
}


export function mapSiliconEmployeeRow(row: Record<string, unknown>): SiliconEmployee {
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
    systemSessionLimit: typeof row.system_session_limit === "number" ? row.system_session_limit : null,
    archivedAt: typeof row.archived_at === "string" && row.archived_at ? row.archived_at : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapAiTeamRow(row: Record<string, unknown>): AiTeam {
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
export function normalizeAiTeamMember(raw: unknown): AiTeamMember | null {
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

export function normalizeAiTeamMembers(raw: unknown): AiTeamMember[] {
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
export function teamMemberName(members: unknown, memberId: string): string | undefined {
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

export function mapAiTeamRunRow(row: Record<string, unknown>): AiTeamRun {
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
export const CANDIDATE_FAILURE_KINDS: readonly CandidateFailureKind[] = [
  "spawn-missing", "input-rejected", "host-disabled", "model-unknown", "startup-timeout",
  "runtime-failure", "format-error", "user-stop",
];

export function isCandidateFailureKind(value: unknown): value is CandidateFailureKind {
  return CANDIDATE_FAILURE_KINDS.includes(value as CandidateFailureKind);
}

export function nonEmptyString(value: unknown): string | null {
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

export function mapAiTeamStepRow(row: Record<string, unknown>): AiTeamStep {
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

export function mapMissionRow(row: Record<string, unknown>): Mission {
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

export function mapMissionAttemptRow(row: Record<string, unknown>): MissionAttempt {
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

export function mapMissionReviewCommentRow(row: Record<string, unknown>): MissionReviewComment {
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

export function mapAgentActivityRow(row: Record<string, unknown>): AgentActivityItem {
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

export function mapPasswordVaultRow(row: PasswordVaultRow): PasswordVault {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type PasswordItemRowFields = Omit<PasswordVaultItem, "fields">;

/** Parse the (possibly encrypted) `fields` JSON column into a string map. */
export function decodePasswordFields(json: string | null): Record<string, string> {
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

export function mapPasswordItemRow(row: PasswordVaultItemRow): PasswordItemRowFields {
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

/** 首页目录组顺序的偏好键（app_config 表，与其它 UI 偏好同一套读写）。 */
export const WORKSPACE_GROUP_ORDER_KEY = "workspaceGroupOrder";

/** Pi 会话默认设置的偏好键，与其它 UI 偏好同一套读写，不出现在 config.json。 */
export const PI_SESSION_DEFAULTS_KEY = "pref:piSessionDefaults";

export const AUTH_SCOPES = new Set<AuthScope>([
  "admin",
  "sessions",
  "files",
  "password-vault",
  "session-preferences",
]);

export function parseAuthPrincipal(kind: string, rawScopes: string): AuthPrincipal {
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

