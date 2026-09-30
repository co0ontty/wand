import type { AgentActivityState } from "./mission-types.js";
import type { WandTaskAgent } from "./task-types.js";
import type { ConversationTurn } from "./types.js";

export const AI_TEAM_MIN_MEMBERS = 2;
export const AI_TEAM_MAX_MEMBERS = 8;
export const AI_TEAM_DEFAULT_MAX_STEPS = 30;
export const AI_TEAM_MIN_STEPS = 5;
export const AI_TEAM_MAX_STEPS = 200;
/** 每个成员的执行候选上限（1 首选 + 3 备用，§11-Q5）。 */
export const AI_TEAM_MAX_CANDIDATES = 4;

/** 成员职责标注；缺省视同 "any"。 */
export type TeamMemberRole = "plan" | "work" | "verify" | "any";
export const TEAM_MEMBER_ROLES: readonly TeamMemberRole[] = ["plan", "work", "verify", "any"];

export function isTeamMemberRole(value: unknown): value is TeamMemberRole {
  return TEAM_MEMBER_ROLES.includes(value as TeamMemberRole);
}

export interface AiTeamMember {
  /** 团队内唯一，形如 "m_xxxxxxxx"；Leader 派工时原样引用。 */
  id: string;
  name: string;
  /** 职责说明，原样写进提示词。 */
  duty: string;
  /** v2：有序候选执行配置，第一个优先；至少 1 个。 */
  agents: WandTaskAgent[];
  /** 兼容字段：始终等于 agents[0]，供未升级读端使用（§3.6 读点清单）。 */
  agent: WandTaskAgent;
  /** 职责标注；缺省视同 "any"。 */
  role?: TeamMemberRole;
  isLeader: boolean;
  /** 头像：空串按 id 哈希选毛色；"cat:<n>" 指定毛色；"data:image/…" 为用户上传的小图。 */
  avatar?: string;
}

/**
 * 取成员候选列表：agents 缺失/空 → [agent]，否则原样返回。
 * 参数刻意放宽为部分字段，让未归一的裸 JSON（旧 members_json / team_json）也能直接调用。
 */
export function memberAgents(member: {
  agent?: WandTaskAgent | undefined;
  agents?: WandTaskAgent[] | undefined;
}): WandTaskAgent[] {
  if (Array.isArray(member.agents) && member.agents.length > 0) return member.agents;
  return member.agent ? [member.agent] : [];
}

/**
 * 候选身份 = 五元组精确匹配（§3.5）；黑名单与保存期去重共用。
 * 按字面量比较：model:"default" 不与具体默认模型名做等价归一。
 */
export function agentKey(agent: WandTaskAgent): string {
  return `${agent.provider}|${agent.model}|${agent.thinkingEffort}|${agent.mode}|${agent.kind}`;
}

/** 启动失败分类（§3.4）；ai-team-availability（T2）复用此联合类型。 */
export type CandidateFailureKind =
  | "spawn-missing"
  | "host-disabled"
  | "model-unknown"
  | "startup-timeout"
  | "runtime-failure"
  | "format-error"
  | "user-stop";

/** 步骤实际派发用的候选与本步之前跳过的候选（§3.2，存 ai_team_steps.dispatch_info_json）。 */
export interface StepDispatchInfo {
  usedCandidate: number;
  skipped: Array<{
    candidate: number;
    agent: WandTaskAgent;
    /** summarizeError 式清洗后的人类文案。 */
    reason: string;
    errorKind: CandidateFailureKind;
  }>;
}

/** 上传头像在前端缩成小图后的上限（data URL 字符数）。 */
export interface SiliconEmployee {
  id: string; // "e_<uuid>"
  name: string;
  duty: string; // 一句话职责：侧栏/选择器/署名都用它
  prompt: string; // 角色设定；建会话时走 SessionSnapshot.systemPrompt（不拼进首条用户消息）
  avatar: string; // 与 ai-teams 同口径："" | "cat:<n>" | "data:image/…"
  agents: WandTaskAgent[]; // 1..4 项，顺序 = 降级顺序（首选在前）
  /**
   * 非空 = Wand 内置员工（如 "wand-ops" 系统运维）：名字/职责/人设/头像锁定，
   * 不可归档、不可删除，只有执行候选由用户维护。
   */
  systemKey?: string;
  archivedAt?: string; // 归档后不出现在选择器；其历史会话仍可打开
  createdAt: string;
  updatedAt: string;
}

/**
 * AI 按自然语言期望起草的员工配置：只带一个首选执行候选，
 * 其余手动字段（头像、备用候选）仍由表单和「高级配置」负责。
 */
export interface SiliconEmployeeDraft {
  name: string;
  duty: string;
  prompt: string;
  agent: WandTaskAgent;
}

export const AI_TEAM_AVATAR_MAX_CHARS = 60_000;
export const SILICON_EMPLOYEE_AVATAR_MAX_CHARS = 60_000;

// ============ 内置「系统运维」员工 ============
// 纯常量与判定放在这里：浏览器端要拿 Tag 和判定，不能把 server-only 的
// system-employee.ts（依赖 node:fs）拉进前端 bundle。

export const SYSTEM_EMPLOYEE_KEY = "wand-ops";
export const SYSTEM_EMPLOYEE_ID = "e_wand_ops";
export const SYSTEM_EMPLOYEE_NAME = "勤劳的初二";
/** 员工列表 / 设置页上的标识。 */
export const SYSTEM_EMPLOYEE_TAG = "系统运维";

export function isSystemSiliconEmployee(
  employee: Pick<SiliconEmployee, "systemKey"> | null | undefined,
): boolean {
  return employee?.systemKey === SYSTEM_EMPLOYEE_KEY;
}


export interface AiTeam {
  id: string;
  name: string;
  description: string;
  /** 协作指令：分工、工作要求与注意事项，写进负责人和成员的提示词。 */
  instructions: string;
  members: AiTeamMember[];
  requirePlanApproval: boolean;
  /** Leader 轮次 + 成员步骤合计的上限。 */
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
}

export type AiTeamRunStatus =
  | "running"
  | "awaiting_approval"
  | "waiting_user"
  | "done"
  | "failed"
  | "stopped";

export const AI_TEAM_ACTIVE_RUN_STATUSES: readonly AiTeamRunStatus[] = ["running", "awaiting_approval", "waiting_user"];

/** 终态：不会再有 live 变化，runner 据此清掉该 run 的推送指纹，避免长跑服务按 run 数攒字符串。 */
export const AI_TEAM_TERMINAL_RUN_STATUSES: readonly AiTeamRunStatus[] = ["done", "failed", "stopped"];

export interface AiTeamRun {
  id: string;
  teamId: string;
  /** 执行快照；仅 runner 在明确续跑/回复边界按规则刷新，展示层改名不写回这里。 */
  team: AiTeam;
  taskId: string;
  objective: string;
  cwd: string;
  status: AiTeamRunStatus;
  statusDetail: string;
  stepsUsed: number;
  stepLimit: number;
  /** 当前这轮 Leader 回复格式错误的重试次数。 */
  formatRetries: number;
  /** 首个计划是否已被批准（或无需批准）。 */
  planApproved: boolean;
  /** 这次运行的群聊会话；旧运行没有。 */
  chatSessionId: string | null;
  /** 成员干活时用户在群里说的话，等负责人下一轮一起转告。 */
  pendingNotes: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 会话列表用的群聊标记：chat_session_id → 最近一次运行（`AiTeamRunChatMarker` 索引的 value）。
 * 只带列表徽标和点开 IM 视图所需的入口信息，不暴露运行细节。
 */
export interface AiTeamRunChatMarker {
  runId: string;
  teamId: string;
  teamName: string;
  memberCount: number;
}

/**
 * 会话列表用的成员步骤标记：`ai_team_steps.session_id` → 这一步的身份（`AiTeamStepSessionMarker` 索引的 value）。
 * 派发出来的会话没有人类起的标题，列表用 `title` 当短标题；`runFinished` 决定它算进行中还是历史。
 * 成员名按当前团队定义投影，团队或成员被删时退回运行快照，和群聊署名同一套规则。
 */
export interface AiTeamStepSessionMarker {
  runId: string;
  stepId: string;
  kind: AiTeamStepKind;
  /** 这一步的任务标题，短、稳定。 */
  title: string;
  memberId: string;
  memberName: string;
  teamName: string;
  stepStatus: AiTeamStepStatus;
  runStatus: AiTeamRunStatus;
  runFinished: boolean;
}

export type AiTeamStepKind = "leader" | "work";
export type AiTeamStepStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface AiTeamStep {
  id: string;
  runId: string;
  seq: number;
  kind: AiTeamStepKind;
  memberId: string;
  title: string;
  /** 发给成员（或 Leader）的输入。 */
  instructions: string;
  sessionId: string | null;
  status: AiTeamStepStatus;
  /** 这些步骤都完成后才能开始；空数组表示可立即开始（同一成员仍一次只做一步）。 */
  dependsOn: string[];
  /** work：成员报告；leader：Leader 给用户看的说明。 */
  report: string;
  /** 约定的报告文件，相对 run.cwd。 */
  reportPath: string;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * 本步实际派发用的候选与之前的跳过链（§3.2，存 ai_team_steps.dispatch_info_json）。
   * 缺省 = 首选、没跳过过任何候选；旧运行不凭空造出留痕。
   */
  dispatchInfo?: StepDispatchInfo;
}

/** 团队页的运行记录：带上任务卡标题，免去前端再查。 */
export interface AiTeamRunSummary extends AiTeamRun {
  taskTitle: string;
  taskIdentifier: string;
}

/** detail() 里群聊回合的截尾条数（§4.4）：面板只给最近这一段，完整会话走「打开群聊」。 */
export const AI_TEAM_DETAIL_CHAT_TURNS = 200;

/** live 卡片文本的尾部保留上限（§4.9），超出部分回报 omittedChars 给前端显示「已省略前面 N 字」。 */
export const AI_TEAM_LIVE_TEXT_MAX_CHARS = 2000;

/**
 * 一个正在干活的运行中步骤的实时快照（§4.9）：Web 走 ai-team-step-live 推送，
 * 移动端轮询 GET /api/ai-team-runs/:id/live，两边共用这个形状。
 */
export interface AiTeamLiveStep {
  stepId: string;
  seq: number;
  memberId: string;
  memberName: string;
  /** 该步实际使用候选的 provider（署名口径同 §3.6）。 */
  provider: WandTaskAgent["provider"];
  /**
   * 该步实际使用候选的模型 id（provider 的原生 model id，`"default"` = 跟随服务端默认）；
   * 取不到候选就不填。中文标签由客户端做。
   */
  model?: string;
  /** 该步实际使用候选的思考深度；同上，取不到不填。 */
  thinkingEffort?: string;
  sessionId: string;
  state: AgentActivityState;
  /** renderLiveStepText 的渲染结果，尾部保留、至多 AI_TEAM_LIVE_TEXT_MAX_CHARS 字。 */
  text: string;
  omittedChars: number;
  updatedAt: string;
}

/** notifyLive 回调与 ai-team-step-live 通知的 payload（§4.9）。 */
export interface AiTeamLiveUpdate {
  runId: string;
  taskId: string;
  steps: AiTeamLiveStep[];
}

export interface AiTeamRunDetail {
  run: AiTeamRun;
  steps: AiTeamStep[];
  /** 运行中步骤所在会话的实时状态（等待授权 / 等待回答等）。 */
  memberStates: Record<string, AgentActivityState>;
  /** 仅供展示：运行时成员顺序/职责保持快照，仍存在的成员按 id 取当前名字/头像。不得用于派工。 */
  displayTeam?: AiTeam;
  /** 群聊 relay 会话的原始消息；作者和正文是历史记录，不因改名而改写。 */
  chatTurns: ConversationTurn[];
}
