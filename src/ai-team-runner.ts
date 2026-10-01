import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dispatchAgentForTask,
  resolveTaskDispatchTarget,
  sendToAgentSession,
  stopAgentSession,
  type AgentDispatchDeps,
} from "./agent-dispatch.js";
import {
  AI_TEAM_REPORT_DIR,
  aiTeamChatHistoryPath,
  aiTeamHandoffPath,
  aiTeamReportPath,
  buildLeaderFollowupPrompt,
  buildLeaderFormatRetryPrompt,
  buildAiTeamObjective,
  buildLeaderKickoffPrompt,
  buildMemberPrompt,
  leaderOf,
  parseLeaderDecision,
  renderChatHistoryFile,
  renderHandoffFile,
  type AiTeamFinishedStepSummary,
  type AiTeamHandoffEntry,
  type AiTeamPrompt,
  type AiTeamUpstream,
} from "./ai-team-prompts.js";
import {
  AI_TEAM_STARTUP_WINDOW_MS,
  classifyCandidateFailure,
  classifyStartupFailure,
  isDegradableWorkFailure,
  isModelUnknownBeforeDispatch,
  type CandidateFailureKind,
  type ModelCatalogView,
} from "./ai-team-availability.js";
import {
  AI_TEAM_ACTIVE_RUN_STATUSES,
  AI_TEAM_DETAIL_CHAT_TURNS,
  AI_TEAM_TERMINAL_RUN_STATUSES,
  agentKey,
  aiTeamChatTitle,
  memberAgents,
  type AiTeam,
  type AiTeamLiveStep,
  type AiTeamLiveUpdate,
  type AiTeamMember,
  type AiTeamRun,
  type AiTeamRunDetail,
  type AiTeamRunSummary,
  type AiTeamStep,
  type StepDispatchInfo,
} from "./ai-team-types.js";
import { renderLiveStepText } from "./ai-team-live.js";
import { teamReportPreview } from "./team-report-preview.js";
import { getErrorMessage } from "./error-utils.js";
import { activityState } from "./missions.js";
import type { AgentActivityState } from "./mission-types.js";
import type { SessionRegistry } from "./session-registry.js";
import type { AiTeamRunState, WandStorage } from "./storage.js";
import type { WandTask, WandTaskAgent } from "./task-types.js";
import type { ConversationAuthor, ConversationTurn, ProcessEvent, SessionSnapshot, TeamReportFile } from "./types.js";

const REPORT_MAX_BYTES = 64 * 1024;
/** 报告文件最后一次写入后要稳定这么久才读取，避免读到写了一半的文件。 */
const REPORT_SETTLE_MS = 1500;
const OUTPUT_DEBOUNCE_MS = 1000;
/** live 文本推送的独立去抖（§4.9），与 evaluate 的 OUTPUT_DEBOUNCE_MS 互不干扰。 */
const LIVE_NOTIFY_DEBOUNCE_MS = 500;
const SWEEP_INTERVAL_MS = 5000;
const MAX_FORMAT_RETRIES = 2;
/** 同一个候选累计这么多次 startup-timeout 就按五元组拉黑（§3.4 黑名单 agents 层）。 */
const STARTUP_TIMEOUT_STRIKES = 2;
/** 群聊会话的 automationId 前缀；后面接运行 id。 */
export const AI_TEAM_CHAT_PREFIX = "ai-team-chat:";
/** 等批准时，群里回复这些词就是批准，其余内容都当修改意见。 */
const APPROVE_REPLY = /^(批准|同意|可以|开始|开干|好的?|ok|okay|yes|lgtm|approve)[。.!！]*$/i;
const STOP_REPLY = /^(停止|停下|stop)[。.!！]*$/i;
/** 步数用完后，纯「继续」保留尚未执行的计划；带新要求的回复交回负责人安排。 */
const CONTINUE_REPLY = /^(继续|让团队继续|继续执行|接着做|接着干|continue)[。.!！]*$/i;
const STEP_LIMIT_DETAIL = "已达到步数上限";

/** 用户可见的冲突错误（路由转 409）。 */
export class AiTeamConflictError extends Error {}

/** 团队调度需要的会话操作。默认实现走 agent-dispatch；测试可整体替换。 */
export interface AiTeamSessionOps {
  open(input: {
    task: WandTask;
    agent: WandTaskAgent;
    prompt: string;
    automationId: string;
    /** 角色与规则；走 provider 的系统提示通道，不拼进 prompt。 */
    systemPrompt?: string;
  }): Promise<string>;
  send(sessionId: string, text: string): Promise<void>;
  stop(sessionId: string): void;
  snapshot(sessionId: string): SessionSnapshot | null;
  ownerOf(sessionId: string): "structured" | "pty" | "storage" | null;
}

/** 群聊：一次运行一个转发会话，团队的决定、派工和报告都以成员身份发在里面。 */
export interface AiTeamChatOps {
  open(input: { task: WandTask; run: AiTeamRun; title: string }): string;
  post(sessionId: string, turns: ConversationTurn[]): void;
}

export interface AiTeamRunnerOptions {
  storage: WandStorage;
  chat?: AiTeamChatOps;
  /** 解析任务卡的执行目录；默认走 agent-dispatch 的规则。 */
  resolveCwd: (task: WandTask) => string;
  ops: AiTeamSessionOps;
  notify?: (run: AiTeamRun) => void;
  /** 运行中步骤的 live 文本推送（§4.9）：去抖后每 500ms 至多一次，stepId+text+omittedChars+state 全同不重复推。 */
  notifyLive?: (update: AiTeamLiveUpdate) => void;
  now?: () => number;
  /**
   * 某 provider 已发现的模型清单（§3.4 model-unknown 事前比对）。目录未就绪 / 清单为空时
   * 返回空值即可，判定方向是「拿不准就放行」。
   */
  models?: (provider: WandTaskAgent["provider"]) => ModelCatalogView;
  /**
   * 该 provider 服务端配置的默认模型（拿不到返回空串）。只用于提示词里的成员名单：
   * `default` 哨兵不是模型名，写真正会用的那个。
   */
  defaultModelOf?: (provider: WandTaskAgent["provider"]) => string;
}

export function createAiTeamSessionOps(deps: AgentDispatchDeps & { sessions: SessionRegistry }): AiTeamSessionOps {
  return {
    async open(input) {
      const { session } = await dispatchAgentForTask(deps, input);
      return session.id;
    },
    send: (sessionId, text) => sendToAgentSession(deps, sessionId, text),
    stop: (sessionId) => stopAgentSession(deps, sessionId),
    snapshot: (sessionId) => deps.sessions.getLatest(sessionId),
    ownerOf: (sessionId) => deps.sessions.ownerOf(sessionId),
  };
}

export function createAiTeamChatOps(deps: AgentDispatchDeps): AiTeamChatOps | undefined {
  const structured = deps.structured;
  if (!structured) return undefined;
  return {
    open({ task, run, title }) {
      const target = resolveTaskDispatchTarget(deps, task);
      const leader = leaderOf(run.team);
      const session = structured.createRelaySession({
        cwd: run.cwd,
        mode: leader.agent.mode,
        provider: leader.agent.provider,
        worktreeEnabled: false,
        sessionSource: "interactive",
        automationId: `${AI_TEAM_CHAT_PREFIX}${run.id}`,
        workspaceId: target.workspaceId,
        workspaceTaskId: target.workspaceTaskId,
        title,
      });
      deps.storage.bindWandTaskSession(task.id, session.id);
      return session.id;
    },
    post: (sessionId, turns) => {
      structured.appendRelayTurns(sessionId, turns);
    },
  };
}

export function createAiTeamRunner(
  deps: AgentDispatchDeps & {
    sessions: SessionRegistry;
    notify?: (run: AiTeamRun) => void;
    notifyLive?: (update: AiTeamLiveUpdate) => void;
    models?: (provider: WandTaskAgent["provider"]) => ModelCatalogView;
    defaultModelOf?: (provider: WandTaskAgent["provider"]) => string;
  },
): AiTeamRunner {
  const runner = new AiTeamRunner({
    storage: deps.storage,
    resolveCwd: (task) => resolveTaskDispatchTarget(deps, task).cwd,
    ops: createAiTeamSessionOps(deps),
    chat: createAiTeamChatOps(deps),
    notify: deps.notify,
    notifyLive: deps.notifyLive,
    models: deps.models,
    defaultModelOf: deps.defaultModelOf,
  });
  deps.structured?.registerRelay(AI_TEAM_CHAT_PREFIX, (sessionId, text) => runner.chatInput(sessionId, text));
  return runner;
}

/**
 * 群聊里的发言人。上传的头像是 data URL，每条消息都带一份太重，改用按 id 取的像素猫。
 * `agent` 传该步**实际使用候选**（§3.6/B15，降级换候选后跟着变），model / thinkingEffort 与
 * provider 同源；Leader 或没有步骤的场景回退首选候选。只填真值，展示文案归客户端。
 */
export function displayAiTeam(snapshot: AiTeam, current: AiTeam | null): AiTeam {
  if (!current) return snapshot;
  const byId = new Map(current.members.map((member) => [member.id, member]));
  return {
    ...snapshot,
    name: current.name,
    updatedAt: current.updatedAt,
    members: snapshot.members.map((member) => {
      const live = byId.get(member.id);
      return live ? { ...member, name: live.name, avatar: live.avatar } : member;
    }),
  };
}

function chatAuthor(
  member: AiTeamMember,
  sessionId?: string | null,
  agent?: WandTaskAgent | null,
): ConversationAuthor {
  const used = agent ?? memberAgents(member)[0] ?? member.agent;
  return {
    id: member.id,
    name: member.name,
    avatar: member.avatar && !member.avatar.startsWith("data:") ? member.avatar : undefined,
    leader: member.isLeader || undefined,
    provider: used?.provider ?? member.agent.provider,
    model: used?.model?.trim() || undefined,
    thinkingEffort: used?.thinkingEffort || undefined,
    sessionId: sessionId ?? undefined,
  };
}

const chatText = (text: string): ConversationTurn["content"] => [{ type: "text", text }];

/** CLI 的错误常是「一行摘要 + 一大段 JSON」，有用的信息在头尾；中间截掉以免撑爆报告。 */
function summarizeError(error: string | null | undefined): string {
  const text = (error ?? "").trim();
  if (text.length <= 400) return text;
  return `${text.slice(0, 160)} … ${text.slice(-240)}`;
}

/** 遮蔽参照目录：家目录与激活配置目录（含 `/tmp/wand-dev` 这类隔离路径，按传入处理）。 */
export interface RedactionDirs {
  homeDir?: string;
  configDir?: string;
}

const HOME_PATH_PLACEHOLDER = "~";
const CONFIG_PATH_PLACEHOLDER = "<配置目录>";
const SECRET_VALUE_PLACEHOLDER = "<已隐藏>";
/**
 * 凭据参数名。强名字（token / secret / api_key / connection_code …）`=` 与 `:` 两种写法都收；
 * 弱名字（code / key）只收 `code=` / `key=` 形式——否则 provider 错误 JSON 里的
 * `code: 'ENOENT'`、`status_code: 503` 也会被误吞，而连接码本身就是 64 位 hex，逃不掉。
 */
const SECRET_PARAM_PATTERN = new RegExp(
  "\\b((?:(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey"
  + "|secret[_-]?key|client[_-]?secret|private[_-]?key|connection[_-]?code|password|passwd|secret|token)"
  + "\\s*[=:]|(?:code|key)\\s*=)\\s*)(?:\"[^\"]*\"|'[^']*'|[^\\s&;,}\"]+)",
  "gi");
/** 已知签发前缀（sk- / ghp_ / xoxb- / AIza…）后面跟的长串一定是凭据。 */
const KNOWN_SECRET_PATTERN = /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|xox[abprs]?|AIza|ya29)[-_][A-Za-z0-9]{10,}/g;
/** HTTP Authorization 头的值形态：`Bearer <凭据>` 整段收掉。 */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** 高熵长串兜底：≥32 字符的连续 body（provider 文案里的路径、模型名都不到这个长度）。 */
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9][A-Za-z0-9+/=_-]{30,}\b/g;

/**
 * 落库 / 进群聊前的脱敏（§4.5「全链路不写连接码 / token / home 路径」）。
 * 纯函数、无 IO：目录由调用方传进来，同一个输入永远得到同一个输出，重复清洗结果不变。
 * 顺序很关键：先把配置目录（在家目录下）整段换掉，再换家目录，否则 `~/.wand` 会漏半截。
 * 方向是宁多勿漏：认不准的超长串一律隐藏，代价只是文案少一段可调试信息。
 */
export function redactAiTeamErrorText(text: string, dirs: RedactionDirs = {}): string {
  if (!text) return text;
  let out = text;
  const configDir = dirs.configDir?.trim();
  if (configDir && configDir.length > 1) out = out.split(configDir).join(CONFIG_PATH_PLACEHOLDER);
  const homeDir = dirs.homeDir?.trim();
  if (homeDir && homeDir.length > 1 && homeDir !== path.sep) {
    out = out.split(homeDir).join(HOME_PATH_PLACEHOLDER);
  }
  // 报错里提到的可能是别的用户 / 别的机器（本机 homedir 比对不上），通用家目录前缀一并收掉。
  out = out.replace(/(^|[\s"'(=,])(?:\/(?:Users|home)\/|C:\\+Users\\+)[^/"'(),\s]*/g,
    `$1${HOME_PATH_PLACEHOLDER}`);
  out = out.replace(SECRET_PARAM_PATTERN, `$1${SECRET_VALUE_PLACEHOLDER}`);
  out = out.replace(BEARER_PATTERN, SECRET_VALUE_PLACEHOLDER);
  out = out.replace(KNOWN_SECRET_PATTERN, SECRET_VALUE_PLACEHOLDER);
  out = out.replace(LONG_TOKEN_PATTERN, (match) =>
    (/\d/.test(match) && /[A-Za-z]/.test(match)) || /[_-]/.test(match) ? SECRET_VALUE_PLACEHOLDER : match);
  return out;
}

function isSessionGone(snapshot: SessionSnapshot): boolean {
  return snapshot.status === "exited" || snapshot.status === "failed" || snapshot.status === "stopped";
}

function turnText(turn: { content: Array<{ type: string; text?: string }> }): string {
  return turn.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join("\n\n");
}

// ── 群聊开场与协作流转的文案（设计 v2.1 S1–S5）──
// 全部由服务端纯函数拼好：客户端只做 @ 高亮，不拼句子、不猜字段；也**不引任何 LLM 文本**。

/** 每行邀请名单上限（S2/S3）：`邀请 @a、@b、@c、@d 加入群聊`。 */
export const CHAT_INVITE_PER_LINE = 4;

/** 开工发言与派工行共用的步骤说法：`第 2 步「实现 Web 端」`；标题空白时只剩步数。 */
function chatStepLabel(seq: number, title: string): string {
  const label = title.trim();
  return label ? `第 ${seq} 步「${label}」` : `第 ${seq} 步`;
}

/**
 * 首次建群的入群序列（S1–S3）：负责人先入群，再按 `team.members` 原顺序邀请其余成员。
 * 每行最多 [CHAT_INVITE_PER_LINE] 人，第二行起用 `继续邀请 …`；除负责人外没人时给
 * `还没有邀请其他成员入群`（仍两条，不伪造成员）。
 */
export function chatIntroLines(team: Pick<AiTeam, "members">, chatTitle: string): string[] {
  const title = chatTitle.trim();
  const lines = [title ? `创建了团队群聊「${title}」` : "创建了团队群聊"];
  const invitees = team.members.filter((member) => !member.isLeader)
    .map((member) => member.name.trim())
    .filter(Boolean);
  if (invitees.length === 0) {
    lines.push("还没有邀请其他成员入群");
    return lines;
  }
  for (let index = 0; index < invitees.length; index += CHAT_INVITE_PER_LINE) {
    const names = invitees.slice(index, index + CHAT_INVITE_PER_LINE).map((name) => `@${name}`).join("、");
    lines.push(`${index === 0 ? "邀请" : "继续邀请"} ${names} 加入群聊`);
  }
  return lines;
}

/** 开工发言里的一条依据（来自 `step.dependsOn` 解析出的上游步骤）。 */
export interface AiTeamStepBasis {
  seq: number;
  title: string;
  memberName: string;
  reportPath: string;
}

/**
 * 开工发言正文（S4）：
 * - 第 1 行 `我正在开始工作：第 N 步「标题」`；
 * - 有依赖时第 2 行 `依据 @上游成员 第 M 步「上游标题」的产物 <reportPath>`，超过两条
 *   只列前两条并在尾上 `等 N 步`（N = 依赖总数）；
 * - 依赖解析不到（旧数据/步骤被删）→ `依据上游步骤的产物继续`。
 */
export function stepStartText(
  step: Pick<AiTeamStep, "seq" | "title">,
  upstream: ReadonlyArray<AiTeamStepBasis> = [],
  dependencyCount: number = upstream.length,
): string {
  const lines = [`我正在开始工作：${chatStepLabel(step.seq, step.title)}`];
  if (dependencyCount > 0) lines.push(stepBasisLine(upstream, dependencyCount));
  return lines.join("\n");
}

function stepBasisLine(upstream: ReadonlyArray<AiTeamStepBasis>, dependencyCount: number): string {
  const shown = upstream.slice(0, 2);
  if (shown.length === 0) return "依据上游步骤的产物继续";
  const parts = shown.map((item) => {
    const reportPath = item.reportPath.trim();
    return `@${item.memberName} ${chatStepLabel(item.seq, item.title)}的产物${reportPath ? ` ${reportPath}` : ""}`;
  });
  return `依据 ${parts.join("、")}${dependencyCount > shown.length ? ` 等 ${dependencyCount} 步` : ""}`;
}

/**
 * 派工行的依据括注（S5）：`（依据：第 1 步「设计规格」的产物）`，多个依赖用 `、` 连接。
 * 位置 `at` 是**本批 steps 内**的 0-based 下标（展示成第 at+1 步）；没有依赖就是空串（首步无依据）。
 * 它**取代**旧的 `（等第 N 项完成后）`：同一个依赖关系不写两遍。
 */
export function assignmentBasisNote(after: readonly number[], titles: readonly string[]): string {
  if (after.length === 0) return "";
  const parts = after.map((at) => {
    const label = (titles[at] ?? "").trim();
    return `第 ${at + 1} 步${label ? `「${label}」` : ""}的产物`;
  });
  return `（依据：${parts.join("、")}）`;
}

/** 找到提示词（含 reportPath）那一轮之后的 assistant 文本；没有回复返回 null。 */
function assistantReplyAfterPrompt(snapshot: SessionSnapshot, reportPath: string): string | null {
  const messages = snapshot.messages ?? [];
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turn = messages[index]!;
    if (turn.role === "user" && turnText(turn).includes(reportPath)) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return null;
  const replies = messages.slice(promptIndex + 1).filter((turn) => turn.role === "assistant");
  if (replies.length === 0) return null;
  return replies.map(turnText).filter(Boolean).join("\n\n");
}

/** 只看本步提示词之后的真实输出；structured 的失败提示是系统生成的，不是模型回答。 */
function hasStepAssistantReply(snapshot: SessionSnapshot, reportPath: string, errorMessage: string): boolean {
  const messages = snapshot.messages ?? [];
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turn = messages[index]!;
    if (turn.role === "user" && turnText(turn).includes(reportPath)) {
      promptIndex = index;
      break;
    }
  }
  // 无法确认本步起点时，不把历史会话误判成「启动失败」后再次派工。
  if (promptIndex < 0) return true;
  const failureText = errorMessage ? `结构化会话执行失败：${errorMessage}` : null;
  return messages.slice(promptIndex + 1).some((turn) => {
    if (turn.role !== "assistant") return false;
    return !failureText || turn.content.length !== 1
      || turn.content[0]?.type !== "text" || turn.content[0].text !== failureText;
  });
}

function readReport(file: string): string {
  // 交接摘要与卡片预览都只读预算内的字节，完整产物仍由下载接口流式提供。
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(REPORT_MAX_BYTES + 1);
  let bytes = 0;
  try {
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
  } finally {
    closeSync(fd);
  }
  const text = buffer.subarray(0, Math.min(bytes, REPORT_MAX_BYTES)).toString("utf8");
  return bytes > REPORT_MAX_BYTES ? `${text}\n\n（已截断）` : text;
}

/** 把 .wand-team/ 加进仓库的 info/exclude，避免报告文件出现在未跟踪列表里。 */
function excludeReportDir(cwd: string): void {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!gitDir) return;
    const excludeFile = path.join(path.resolve(cwd, gitDir), "info", "exclude");
    const line = `/${AI_TEAM_REPORT_DIR}/`;
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split(/\r?\n/).some((entry) => entry.trim() === line)) return;
    appendFileSync(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
  } catch {
    // 不在 git 仓库里或没有写权限：跳过，不影响运行。
  }
}

type StepOutcome =
  | { kind: "pending"; recheckInMs?: number }
  | { kind: "done"; text: string; fromFile: boolean }
  /** sessionError：会话以出错结束（额度用尽、鉴权失败等），重试同一个模型只会再错一次。 */
  | { kind: "failed"; text: string; sessionError?: boolean };

/** 会话启动失败 + 一个人类可读原因，degradeWorkStep 的输入。 */
interface CandidateFailure {
  kind: CandidateFailureKind;
  reason: string;
}

/**
 * run 级降级状态（§3.4）：两层黑名单 + host-disabled + startup-timeout 计数。
 * 唯一真源是 `ai_team_runs.run_state_json`（`stateOf` 读、`saveState` 写，每次变更立即落库），
 * 所以服务重启后不会退回候选 1 重来、已拉黑的候选不会复试、strikes 不清零。
 * 每步实际用的候选与跳过链存在步骤行自己（`dispatch_info_json`），不在这里。
 */
type RunDegradeState = AiTeamRunState;

/**
 * AI 团队调度器。状态全部在数据库里，会话事件驱动推进；同一运行的所有操作串行执行。
 * 成员会话是普通 Wand 会话，服务端只负责传话：Leader 决定派谁做什么，成员交报告。
 */
export class AiTeamRunner {
  private readonly storage: WandStorage;
  private readonly ops: AiTeamSessionOps;
  private readonly chat?: AiTeamChatOps;
  private readonly resolveCwd: (task: WandTask) => string;
  private readonly notifyListener?: (run: AiTeamRun) => void;
  private readonly notifyLiveListener?: (update: AiTeamLiveUpdate) => void;
  private readonly modelsOf?: (provider: WandTaskAgent["provider"]) => ModelCatalogView;
  private readonly defaultModelOf?: (provider: WandTaskAgent["provider"]) => string;
  private readonly now: () => number;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly outputTimers = new Map<string, NodeJS.Timeout>();
  /** live 推送的去抖计时器，按 runId 计（§4.9）。 */
  private readonly liveTimers = new Map<string, NodeJS.Timeout>();
  /** 上次推出去的 live 列表指纹（§4.9）：stepId + text + omittedChars + state 全同就不重复推。 */
  private readonly lastLiveKey = new Map<string, string>();
  private readonly recheckTimers = new Map<string, NodeJS.Timeout>();
  /** 已经确定「不降级、按既有路径记 failed」的步骤，防止 finishStep 再判一次形成回环。 */
  private readonly noDegrade = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  /** 脱敏参照目录只算一次：os.homedir() 读 env，configDir 随 storage 定，运行期不变。 */
  private redactionDirsValue: RedactionDirs | null = null;

  constructor(options: AiTeamRunnerOptions) {
    this.storage = options.storage;
    this.ops = options.ops;
    this.chat = options.chat;
    this.resolveCwd = options.resolveCwd;
    this.notifyListener = options.notify;
    this.notifyLiveListener = options.notifyLive;
    this.modelsOf = options.models;
    this.defaultModelOf = options.defaultModelOf;
    this.now = options.now ?? Date.now;
  }

  /** 提示词里的模型名解析器：`default` 哨兵交给服务端配置的默认模型。 */
  private readonly defaultModelName = (provider: WandTaskAgent["provider"]): string =>
    this.defaultModelOf?.(provider)?.trim() ?? "";

  /** 本 runner 的遮蔽参照目录（§4.5）。 */
  private get redactionDirs(): RedactionDirs {
    if (!this.redactionDirsValue) {
      let homeDir = "";
      try {
        homeDir = os.homedir();
      } catch {
        homeDir = ""; // 拿不到家目录时仍按通用 /Users、/home 前缀与凭据规则清洗
      }
      this.redactionDirsValue = { homeDir, configDir: this.storage.directory() };
    }
    return this.redactionDirsValue;
  }

  /** 只脱敏、不改长度语义（用于本来就不截断的文案）。 */
  private redact(text: string): string {
    return redactAiTeamErrorText(text, this.redactionDirs);
  }

  /** 先脱敏再头尾截断：截断会把中间的敏感串切出来，顺序不能反。 */
  private cleanError(text: string | null | undefined): string {
    return summarizeError(this.redact(text ?? ""));
  }

  // ── 公开操作 ──

  async start(input: { teamId: string; taskId: string; note?: string; chatSessionId?: string }): Promise<AiTeamRunDetail> {
    const team = this.storage.getAiTeam(input.teamId);
    if (!team) throw new Error("团队不存在。");
    const task = this.storage.getWandTask(input.taskId);
    if (!task) throw new Error("任务不存在。");
    const active = this.storage.listAiTeamRuns({ taskId: task.id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES });
    if (active.length > 0) throw new AiTeamConflictError("这张任务已经有进行中的团队运行。");
    const cwd = this.resolveCwd(task);
    const objective = buildAiTeamObjective(task, input.note);
    const createdAt = this.iso();
    const run: AiTeamRun = {
      id: `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      teamId: team.id,
      team,
      taskId: task.id,
      objective,
      cwd,
      status: "running",
      statusDetail: "",
      stepsUsed: 0,
      stepLimit: team.maxSteps,
      formatRetries: 0,
      planApproved: !team.requirePlanApproval,
      chatSessionId: input.chatSessionId ?? null,
      pendingNotes: [],
      createdAt,
      updatedAt: createdAt,
    };
    // 群聊只回显用户刚输入的那句。任务标题已经在会话名里，不要再伪装成用户又说了一次。
    const shown = input.chatSessionId ? "" : (input.note?.trim() || objective);
    // 续跑（用户在同一个群聊里接着说话）要在写进新 notice 之前把历史落下，否则会把
    // 「团队这次接手」这种新行也当成历史写进去。
    const chatHistory = input.chatSessionId ? this.writeChatHistory(run) : null;
    this.openChat(run, task, shown, chatHistory);
    this.storage.saveAiTeamRun(run);
    if (task.status === "todo") this.storage.updateWandTask(task.id, { status: "doing" });
    excludeReportDir(cwd);
    await this.enqueue(run.id, async () => {
      const step = this.createLeaderStep(run, "制定计划");
      await this.dispatchStep(run, step, (reportPath, fresh) => (
        buildLeaderKickoffPrompt(run, reportPath, fresh, chatHistory, this.defaultModelName)
      ));
    });
    return this.detail(run.id);
  }

  approve(runId: string, options: { echo?: boolean } = {}): Promise<AiTeamRunDetail> {
    return this.act(runId, async (run) => {
      this.requireStatus(run, "awaiting_approval", "当前没有待批准的计划。");
      if (options.echo !== false) this.postUser(run, "批准");
      run.planApproved = true;
      this.setStatus(run, "running", "");
      await this.advance(run);
    });
  }

  reject(runId: string, feedback: string, options: { echo?: boolean } = {}): Promise<AiTeamRunDetail> {
    return this.act(runId, async (run) => {
      this.requireStatus(run, "awaiting_approval", "当前没有待批准的计划。");
      const text = feedback.trim();
      if (!text) throw new Error("请写下驳回意见。");
      if (options.echo !== false) this.postUser(run, text);
      for (const step of this.storage.listAiTeamSteps(run.id)) {
        if (step.status === "queued") this.saveStep({ ...step, status: "skipped", endedAt: this.iso() });
      }
      this.setStatus(run, "running", "");
      await this.startLeaderRound(run, `用户没有批准这个计划，意见：${text}\n请重新安排。`);
    });
  }

  reply(runId: string, text: string, options: { echo?: boolean } = {}): Promise<AiTeamRunDetail> {
    return this.act(runId, async (run) => {
      this.requireStatus(run, "waiting_user", "团队当前没有在等你回复。");
      const note = text.trim();
      if (!note) throw new Error("回复不能为空。");
      if (options.echo !== false) this.postUser(run, note);
      run.formatRetries = 0;
      if (run.statusDetail === STEP_LIMIT_DETAIL) {
        // 群聊的「继续」也要真正增加这次运行的预算，且不能作废尚未派出的计划。
        this.extendStepLimit(run, 10);
        this.setStatus(run, "running", "");
        if (CONTINUE_REPLY.test(note)) await this.advance(run);
        else await this.startLeaderRound(run, note);
        return;
      }
      this.refreshTeam(run);
      this.setStatus(run, "running", "");
      await this.startLeaderRound(run, note);
    });
  }

  continueRun(runId: string, extraSteps: number): Promise<AiTeamRunDetail> {
    return this.act(runId, async (run) => {
      this.requireStatus(run, "waiting_user", "团队当前没有在等你。");
      if (run.statusDetail !== STEP_LIMIT_DETAIL) {
        throw new AiTeamConflictError("团队正在等你回复，当前不是步数上限暂停。");
      }
      this.extendStepLimit(run, extraSteps);
      this.setStatus(run, "running", "");
      await this.advance(run);
    });
  }

  /** 已有运行的上限独立持久化；修改团队定义后，下次续跑至少采用新的团队上限。 */
  private extendStepLimit(run: AiTeamRun, extraSteps: number): void {
    const extra = Math.min(50, Math.max(5, Math.round(extraSteps) || 10));
    this.refreshTeam(run);
    run.stepLimit = Math.max(run.stepLimit, run.stepsUsed) + extra;
    run.stepLimit = Math.max(run.stepLimit, run.team.maxSteps);
    this.postNotice(run, `步数上限加到 ${run.stepLimit}，继续执行`);
  }

  completeStep(runId: string, stepId: string, report: string): Promise<AiTeamRunDetail> {
    return this.act(runId, async (run) => {
      const step = this.storage.listAiTeamSteps(run.id).find((item) => item.id === stepId);
      if (!step || step.status !== "running" || step.kind !== "work") {
        throw new AiTeamConflictError("只能手动完成正在进行的成员步骤。");
      }
      await this.finishStep(run, step, { kind: "done", text: report.trim() || "用户手动标记完成", fromFile: false });
    });
  }

  stop(runId: string): Promise<AiTeamRunDetail> {
    return this.act(runId, async (run) => {
      if (!AI_TEAM_ACTIVE_RUN_STATUSES.includes(run.status)) throw new AiTeamConflictError("这次运行已经结束。");
      const endedAt = this.iso();
      for (const step of this.storage.listAiTeamSteps(run.id)) {
        if (step.status !== "running" && step.status !== "queued") continue;
        if (step.status === "running" && step.sessionId) {
          try {
            this.ops.stop(step.sessionId);
          } catch (error) {
            console.error(`[AiTeam] stop session ${step.sessionId} failed:`, getErrorMessage(error));
          }
        }
        this.saveStep({ ...step, status: "skipped", endedAt });
      }
      this.postNotice(run, "团队已停止。在群里发消息可以让团队接着处理。");
      this.setStatus(run, "stopped", "已由用户停止");
      // 步骤全变 skipped：推一次空的 live 列表让卡片收尾（§4.9）。
      this.pushLive(run.id);
    });
  }

  /**
   * 用户在群聊里说的话。等回复时转给负责人；等批准时「批准」类短语直接批准，其余当修改意见；
   * 成员干活时先记下，负责人下一轮一起看到；运行已结束则接着开一轮新的。
   */
  async chatInput(sessionId: string, text: string): Promise<void> {
    const run = this.storage.getLatestAiTeamRunByChat(sessionId);
    if (!run) throw new Error("找不到这个群聊对应的团队运行。");
    const note = text.trim();
    if (STOP_REPLY.test(note) && AI_TEAM_ACTIVE_RUN_STATUSES.includes(run.status)) {
      await this.stop(run.id);
      return;
    }
    switch (run.status) {
      case "awaiting_approval":
        if (APPROVE_REPLY.test(note)) await this.approve(run.id, { echo: false });
        else await this.reject(run.id, note, { echo: false });
        return;
      case "waiting_user":
        await this.reply(run.id, note, { echo: false });
        return;
      case "running":
        await this.act(run.id, async (current) => {
          if (current.status !== "running") throw new AiTeamConflictError("团队状态刚变了，请再发一次。");
          current.pendingNotes = [...current.pendingNotes, note];
          this.postNotice(current, "已记下，负责人安排下一步时会看到。回复「停止」可以叫停团队。");
          this.saveRun(current);
        });
        return;
      default: {
        const team = this.storage.getAiTeam(run.teamId);
        if (!team) throw new Error("团队已被删除，没法接着处理。");
        await this.start({ teamId: team.id, taskId: run.taskId, note, chatSessionId: sessionId });
      }
    }
  }

  detail(runId: string): AiTeamRunDetail {
    const run = this.storage.getAiTeamRun(runId);
    if (!run) throw new Error("团队运行不存在。");
    const steps = this.storage.listAiTeamSteps(run.id);
    const memberStates: Record<string, AgentActivityState> = {};
    for (const step of steps) {
      if (step.status !== "running" || !step.sessionId) continue;
      const snapshot = this.ops.snapshot(step.sessionId);
      if (snapshot) memberStates[step.sessionId] = activityState(snapshot);
    }
    // 群聊回合只给最近这一段（§4.4）；没有群聊会话的旧运行给空数组，前端不用判 null。
    const messages = run.chatSessionId ? this.ops.snapshot(run.chatSessionId)?.messages ?? [] : [];
    const currentTeam = this.storage.getAiTeam(run.teamId);
    const binding = run.chatSessionId ? this.storage.getSessionWorkspace(run.chatSessionId) : null;
    const task = (binding?.workspaceTaskId
      ? this.storage.getWandTaskByWorkspaceTaskId(binding.workspaceTaskId) : null)
      ?? this.storage.getWandTask(run.taskId);
    return {
      run,
      chatTitle: aiTeamChatTitle(task?.title),
      chatTitleUpdatedAt: task?.updatedAt ?? "",
      steps,
      memberStates,
      // 别把展示字段写回 run.team：运行快照里的执行候选/职责由 runner 独立管理。
      displayTeam: displayAiTeam(run.team, currentTeam),
      chatTurns: messages.slice(-AI_TEAM_DETAIL_CHAT_TURNS),
    };
  }

  listForTask(taskId: string): AiTeamRun[] {
    return this.storage.listAiTeamRuns({ taskId });
  }

  /**
   * 此刻正在干活的步骤的实时文本（§4.9）。只覆盖 running 且有会话的步骤，按 seq 升序；
   * 快照拿不到的步骤跳过而不抛。run 不存在时与 detail() 同口径抛错。
   */
  live(runId: string): AiTeamLiveStep[] {
    const run = this.storage.getAiTeamRun(runId);
    if (!run) throw new Error("团队运行不存在。");
    return this.liveSteps(run);
  }

  private liveSteps(run: AiTeamRun): AiTeamLiveStep[] {
    const steps: AiTeamLiveStep[] = [];
    for (const step of this.storage.listAiTeamSteps(run.id)) {
      if (step.status !== "running" || !step.sessionId) continue;
      const snapshot = this.ops.snapshot(step.sessionId);
      if (!snapshot) continue;
      steps.push(this.liveStep(run, step, snapshot));
    }
    return steps;
  }

  private liveStep(run: AiTeamRun, step: AiTeamStep, snapshot: SessionSnapshot): AiTeamLiveStep {
    const member = this.member(run.team, step.memberId);
    const agent = member ? this.actualAgent(member, step) : null;
    const provider = agent?.provider ?? snapshot.provider ?? leaderOf(run.team).agent.provider;
    const rendered = renderLiveStepText(snapshot.messages ?? [], snapshot.output ?? "", {
      // pty bridge 只给「claude 且 CLI 已激活」的 PTY 会话挂载（`process-manager.ts` 的
      // `initializeClaudeBridge` 首行 `record.provider !== "claude" || !record.providerCliActive`
      // 就早退），其余 PTY 在流式期 `messages` 不增长，里面留着的是上一条 turn 的过期文本
      // → 一律以终端 output 尾部为准。structured 有流式 messages，照旧。
      preferOutput: this.ops.ownerOf(step.sessionId!) === "pty"
        && !(provider === "claude" && snapshot.providerCliActive === true),
    });
    return {
      stepId: step.id,
      seq: step.seq,
      memberId: step.memberId,
      memberName: member?.name ?? step.memberId,
      provider,
      model: agent?.model?.trim() || undefined,
      thinkingEffort: agent?.thinkingEffort || undefined,
      sessionId: step.sessionId!,
      state: activityState(snapshot),
      text: rendered.text,
      omittedChars: rendered.omittedChars,
      updatedAt: this.iso(),
    };
  }

  /** 挂一次 run 级 live 去抖：同一 run 每 500ms 至多算一遍、推一次，与 evaluate 的计时器互不干扰。 */
  private scheduleLivePush(runId: string): void {
    if (!this.notifyLiveListener || this.liveTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.liveTimers.delete(runId);
      void this.enqueue(runId, async () => { this.pushLive(runId); });
    }, LIVE_NOTIFY_DEBOUNCE_MS);
    timer.unref?.();
    this.liveTimers.set(runId, timer);
  }

  /** 推一次 live 列表（§4.9）；指纹（stepId + text + omittedChars + state）没变就不重复推，推送失败只忽略。 */
  private pushLive(runId: string): void {
    if (!this.notifyLiveListener) return;
    const run = this.storage.getAiTeamRun(runId);
    if (!run) return;
    const steps = this.liveSteps(run);
    const key = steps
      .map((step) => `${step.stepId}\u0000${step.text}\u0000${step.omittedChars}\u0000${step.state}`)
      .join("\u0001");
    if (this.lastLiveKey.get(runId) === key) return;
    if (AI_TEAM_TERMINAL_RUN_STATUSES.includes(run.status)) {
      // 终态的收尾推送之后不再留指纹：留着就没人清，长跑服务会按 run 数攒字符串（§4.9）。
      this.lastLiveKey.delete(runId);
    } else {
      this.lastLiveKey.set(runId, key);
    }
    try {
      this.notifyLiveListener({ runId, taskId: run.taskId, steps });
    } catch {
      // 通知失败不影响调度；客户端靠下一次事件或轮询端点补齐。
    }
  }

  /** 团队页的运行记录；teamId 为空时列出所有团队（侧边栏计数用）。 */
  listRuns(filter: { teamId?: string; activeOnly?: boolean; limit?: number }): AiTeamRunSummary[] {
    const runs = this.storage.listAiTeamRuns({
      teamId: filter.teamId,
      statuses: filter.activeOnly ? AI_TEAM_ACTIVE_RUN_STATUSES : undefined,
      limit: filter.limit,
    });
    return runs.map((run) => {
      const task = this.storage.getWandTask(run.taskId);
      return { ...run, taskTitle: task?.title ?? "（任务已删除）", taskIdentifier: task?.identifier ?? "" };
    });
  }

  // ── 事件驱动 ──

  /** 与 missions.ingest 并列调用。绝大多数事件与团队无关，必须廉价返回。 */
  ingest(event: ProcessEvent): void {
    if (!event.sessionId || event.sessionId === "__system__") return;
    if (event.type !== "status" && event.type !== "ended" && event.type !== "task" && event.type !== "output") return;
    const step = this.storage.getRunningAiTeamStepBySession(event.sessionId);
    if (!step) return;
    // 四类事件都挂上 live 去抖：权限/提问这类状态变化是靠 status、task 事件进来的，
    // 只挂在 output 上，芯片就只能等下一次 ai-team-run 重拉才更新（§4.9）。
    this.scheduleLivePush(step.runId);
    if (event.type === "output") {
      if (this.outputTimers.has(event.sessionId)) return;
      const timer = setTimeout(() => {
        this.outputTimers.delete(event.sessionId);
        void this.enqueue(step.runId, () => this.evaluate(step.runId));
      }, OUTPUT_DEBOUNCE_MS);
      timer.unref?.();
      this.outputTimers.set(event.sessionId, timer);
      return;
    }
    void this.enqueue(step.runId, () => this.evaluate(step.runId));
  }

  /** 服务启动时调用：把重启前未结束的运行接回来，并开始兜底巡检。 */
  reconcile(): void {
    for (const run of this.storage.listAiTeamRuns({ statuses: ["running"] })) {
      void this.enqueue(run.id, async () => {
        const current = this.storage.getAiTeamRun(run.id);
        if (!current || current.status !== "running") return;
        const running = this.storage.listAiTeamSteps(current.id).filter((step) => step.status === "running");
        for (const step of running) {
          if (step.sessionId && this.ops.snapshot(step.sessionId)) continue;
          await this.finishStep(current, step, { kind: "failed", text: "服务重启后会话丢失" }, false);
        }
        await this.evaluate(current.id);
        const latest = this.storage.getAiTeamRun(current.id);
        if (latest?.status === "running") await this.advance(latest);
      });
    }
    this.startSweep();
  }

  /**
   * 兜底巡检：PTY 成员写完报告后可能不再产生事件。
   * 顺带对每个 run 强制对账一次 live（§4.9）：registry 内部状态静默翻转时一条事件都不会进来，
   * 状态芯片只能等客户端下一次重拉；这里在同一串里重算列表走 pushLive，指纹变了才推，
   * 没变就什么都不发。巡检间隔与 evaluate 行为都不动。
   */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      for (const run of this.storage.listAiTeamRuns({ statuses: ["running"] })) {
        void this.enqueue(run.id, async () => {
          this.pushLive(run.id);
          await this.evaluate(run.id);
        });
      }
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.outputTimers.values()) clearTimeout(timer);
    for (const timer of this.recheckTimers.values()) clearTimeout(timer);
    for (const timer of this.liveTimers.values()) clearTimeout(timer);
    this.outputTimers.clear();
    this.recheckTimers.clear();
    this.liveTimers.clear();
    this.lastLiveKey.clear();
    this.noDegrade.clear();
  }

  /** 等当前排队的所有操作跑完（测试用）。 */
  async idle(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }

  // ── 内部：串行化 ──

  private enqueue<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tracked = next.catch((error) => {
      if (!(error instanceof AiTeamConflictError)) {
        console.error(`[AiTeam] run ${runId}:`, getErrorMessage(error));
      }
    });
    this.chains.set(runId, tracked);
    void tracked.then(() => {
      if (this.chains.get(runId) === tracked) this.chains.delete(runId);
    });
    return next;
  }

  private async act(runId: string, action: (run: AiTeamRun) => Promise<void>): Promise<AiTeamRunDetail> {
    await this.enqueue(runId, async () => {
      const run = this.storage.getAiTeamRun(runId);
      if (!run) throw new Error("团队运行不存在。");
      await action(run);
    });
    return this.detail(runId);
  }

  private requireStatus(run: AiTeamRun, status: AiTeamRun["status"], message: string): void {
    if (run.status !== status) throw new AiTeamConflictError(message);
  }

  // ── 内部：推进 ──

  private async evaluate(runId: string): Promise<void> {
    const run = this.storage.getAiTeamRun(runId);
    if (!run || run.status !== "running") return;
    const running = this.storage.listAiTeamSteps(run.id).filter((item) => item.status === "running");
    let finished = false;
    for (const step of running) {
      const outcome = this.stepOutcome(run, step);
      if (outcome.kind === "pending") {
        if (outcome.recheckInMs !== undefined) this.scheduleRecheck(run.id, outcome.recheckInMs);
        continue;
      }
      // 并行成员可能同时交差：先全部记下，最后统一推进一次。
      await this.finishStep(run, step, outcome, false);
      finished = true;
      if (run.status !== "running") return;
    }
    if (finished) await this.advance(run);
  }

  private scheduleRecheck(runId: string, delayMs: number): void {
    if (this.recheckTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.recheckTimers.delete(runId);
      void this.enqueue(runId, () => this.evaluate(runId));
    }, delayMs);
    timer.unref?.();
    this.recheckTimers.set(runId, timer);
  }

  private stepOutcome(run: AiTeamRun, step: AiTeamStep): StepOutcome {
    if (!step.sessionId) return { kind: "pending" };
    const snapshot = this.ops.snapshot(step.sessionId);
    if (!snapshot) return { kind: "failed", text: "会话不存在" };
    const state = activityState(snapshot);
    const gone = isSessionGone(snapshot);
    const busy = !gone && (
      state === "needs_permission"
      || state === "needs_input"
      || snapshot.structuredState?.inFlight === true
      || (snapshot.queuedMessages?.length ?? 0) > 0
      || snapshot.ptyBusy === true
    );

    const reportFile = path.join(run.cwd, step.reportPath);
    if (existsSync(reportFile)) {
      const age = this.now() - statSync(reportFile).mtimeMs;
      if (!gone && age < REPORT_SETTLE_MS) return { kind: "pending", recheckInMs: REPORT_SETTLE_MS - age + 100 };
      // 结构化会话还在说话时先等它结束：文件可能还会被改写。
      if (!busy || this.ops.ownerOf(step.sessionId) === "pty") {
        return { kind: "done", text: readReport(reportFile), fromFile: true };
      }
      return { kind: "pending" };
    }

    if (busy) return { kind: "pending" };
    const reply = snapshot.messages?.length ? assistantReplyAfterPrompt(snapshot, step.reportPath) : null;
    if (gone) {
      // 出错退出时最后一条回复往往就是错误本身（如 API 503），不能当成报告或决定。
      if (reply && snapshot.status !== "failed") return { kind: "done", text: reply, fromFile: false };
      return {
        kind: "failed",
        text: this.cleanError(snapshot.structuredState?.lastError) || "会话已结束，未交付报告",
        sessionError: snapshot.status === "failed",
      };
    }
    if (this.ops.ownerOf(step.sessionId) === "structured" && reply !== null) {
      return { kind: "done", text: reply, fromFile: false };
    }
    return { kind: "pending" };
  }

  /** 步骤落地后补推一次 live（§4.9）：让卡片收尾，列表可能已空。内部抛错时不推。 */
  private async finishStep(
    run: AiTeamRun,
    step: AiTeamStep,
    outcome: Exclude<StepOutcome, { kind: "pending" }>,
    proceed = true,
  ): Promise<void> {
    await this.finishStepCore(run, step, outcome, proceed);
    this.pushLive(run.id);
  }

  /** proceed=false 时只记结果不推进，由调用方在记完一批之后统一 advance。 */
  private async finishStepCore(
    run: AiTeamRun,
    step: AiTeamStep,
    outcome: Exclude<StepOutcome, { kind: "pending" }>,
    proceed = true,
  ): Promise<void> {
    const endedAt = this.iso();
    // §3.4 触发点 2（异步主通道）：必须在 stepsUsed 递增之前判，否则首个失败候选白扣一步预算。
    if (
      step.kind === "work" && outcome.kind === "failed" && outcome.sessionError
      && !this.noDegrade.has(step.id)
    ) {
      const failure = this.asyncStartupFailure(run, step, outcome.text);
      if (failure) {
        await this.degradeWorkStep(run, step, failure, proceed);
        return;
      }
    }
    run.stepsUsed += 1;
    if (step.kind === "work") {
      const report = outcome.text.trim() || (outcome.kind === "done" ? "（成员没有写报告）" : "失败");
      this.saveStep({ ...step, status: outcome.kind === "done" ? "done" : "failed", report, endedAt });
      const member = this.member(run.team, step.memberId);
      if (member) {
        const reportFile = outcome.kind === "done" ? this.completedReportFile(run, step, report, outcome.fromFile) : undefined;
        // 旧客户端也能用已有附件协议打开文件；新客户端用元数据渲染完整文件卡片。
        const body = reportFile
          ? `[附件已上传，请查看以下文件:\n${reportFile.path}\n]\n\n请查看附件。`
          : outcome.kind === "done" ? "报告文件暂不可用，请查看成员会话。" : report;
        this.postTurn(run, {
          role: "assistant",
          author: chatAuthor(member, step.sessionId, this.actualAgent(member, step)),
          content: chatText(`${outcome.kind === "done" ? "✅ 完成" : "❌ 没完成"}「${step.title}」\n\n${body}`),
          ...(reportFile ? { reportFile } : {}),
        });
      }
      this.saveRun(run);
      if (proceed) await this.advance(run);
      return;
    }

    // 负责人的模型报错时停下来等用户（换模型或稍后回复即可接着来），不当成格式错误空转重试。
    // 按真实角色身份发出正常对话气泡并展示完整报错，而不是次级 notice 小字。
    const leader = leaderOf(run.team);
    if (outcome.kind === "failed" && outcome.sessionError) {
      this.saveStep({ ...step, status: "failed", report: outcome.text, endedAt });
      this.postTurn(run, {
        role: "assistant",
        author: chatAuthor(leader, step.sessionId, this.actualAgent(leader, step)),
        content: chatText(`我的模型调用失败，无法继续处理任务：\n\n\`\`\`\n${outcome.text}\n\`\`\`\n\n可以去团队设置页面为我更换可用模型，或者在群里回复我继续重试。`),
      });
      this.setStatus(run, "waiting_user", `负责人出错：${outcome.text}`);
      return;
    }
    // 会话丢失和回复格式错误走同一条有限重试：会话没了就新开一个并补上团队背景。
    const parsed = outcome.kind === "failed"
      ? { ok: false as const, error: `负责人会话没有交付决定（${outcome.text}）。` }
      : parseLeaderDecision(outcome.text, run.team);
    if (!parsed.ok) {
      this.saveStep({ ...step, status: "failed", report: parsed.error, endedAt });
      if (run.formatRetries >= MAX_FORMAT_RETRIES) {
        this.postNotice(run, `负责人连续几次回复都没按约定格式，团队先停下。在群里回复一句让他重新安排。`, step.sessionId);
        this.setStatus(run, "waiting_user", outcome.kind === "failed" ? parsed.error : "Leader 回复格式多次不正确");
        return;
      }
      run.formatRetries += 1;
      this.postNotice(run, `负责人的回复没能读懂，让他重答（${run.formatRetries}/${MAX_FORMAT_RETRIES}）`, step.sessionId);
      this.saveRun(run);
      const retry = this.createLeaderStep(run, "重新回复");
      await this.dispatchStep(run, retry, (reportPath, fresh) => (
        buildLeaderFormatRetryPrompt(
          run, parsed.error, reportPath, fresh, this.chatHistoryFor(run), this.defaultModelName,
        )
      ));
      return;
    }
    run.formatRetries = 0;
    const decision = parsed.decision;
    this.saveStep({ ...step, status: "done", report: decision.message, endedAt });
    this.postLeaderDecision(run, step, decision);
    if (decision.action === "ask") {
      this.setStatus(run, "waiting_user", decision.message);
      return;
    }
    if (decision.action === "finish") {
      this.setStatus(run, "done", decision.message);
      return;
    }
    let seq = this.nextSeq(run.id);
    const ids = decision.steps.map(() => randomUUID());
    for (const [index, assigned] of decision.steps.entries()) {
      this.saveStep({
        id: ids[index]!,
        runId: run.id,
        seq,
        kind: "work",
        memberId: assigned.memberId,
        title: assigned.title,
        instructions: assigned.instructions,
        sessionId: null,
        status: "queued",
        report: "",
        reportPath: aiTeamReportPath(run.id, seq, "work", assigned.memberId),
        dependsOn: assigned.after.map((position) => ids[position]!),
        startedAt: null,
        endedAt: null,
      });
      seq += 1;
    }
    if (!run.planApproved) {
      this.setStatus(run, "awaiting_approval", decision.message);
      return;
    }
    this.saveRun(run);
    await this.advance(run);
  }

  /**
   * 派出所有已就绪的成员步骤：依赖都已完成、且该成员手上没有活。不同成员并行，同一成员串行。
   * 有成员失败、队列清空或依赖再也满足不了时，等在跑的都结束后交回 Leader。
   */
  private async advance(run: AiTeamRun): Promise<void> {
    if (run.status !== "running") return;
    const steps = this.storage.listAiTeamSteps(run.id);
    const running = steps.filter((step) => step.status === "running");
    if (running.some((step) => step.kind === "leader")) return;
    const lastLeaderSeq = Math.max(0, ...steps.filter((step) => step.kind === "leader" && step.status !== "queued").map((step) => step.seq));
    const failedSinceLeader = steps.some((step) => step.kind === "work" && step.seq > lastLeaderSeq && step.status === "failed");
    const queued = steps.filter((step) => step.status === "queued");
    if (queued.some((step) => step.kind === "leader")) {
      // 重启时可能留下一个还没发出的 Leader 步骤：直接重开一轮。
      if (running.length === 0) await this.startLeaderRound(run);
      return;
    }
    if (!failedSinceLeader) {
      const byId = new Map(steps.map((step) => [step.id, step]));
      const busyMembers = new Set(running.map((step) => step.memberId));
      let inFlight = running.length;
      for (const next of queued) {
        if (busyMembers.has(next.memberId)) continue;
        if (!next.dependsOn.every((id) => byId.get(id)?.status === "done")) continue;
        if (run.stepsUsed + inFlight >= run.stepLimit) break;
        const member = this.member(run.team, next.memberId);
        busyMembers.add(next.memberId);
        inFlight += 1;
        if (!member) {
          await this.finishStep(run, next, { kind: "failed", text: "成员不存在" }, false);
          continue;
        }
        await this.dispatchStep(run, next, (_reportPath, fresh) => (
          buildMemberPrompt(run, next, member, fresh, this.memberUpstream(run, next), this.chatHistoryFor(run))
        ), false);
      }
    }
    // 还有人在干活就等；否则（队列清空、有人失败、依赖落空或步数用完）交回 Leader，
    // 步数用完时 startLeaderRound 会停下来等用户。
    if (this.storage.listAiTeamSteps(run.id).some((step) => step.status === "running")) return;
    await this.startLeaderRound(run);
  }

  /** 开一轮 Leader：把上一轮 Leader 之后结束的成员报告交给他。 */
  private async startLeaderRound(run: AiTeamRun, userNote?: string): Promise<void> {
    if (!this.hasBudget(run)) return;
    // 成员干活时用户在群里说的话，这一轮一起交给负责人。
    if (run.pendingNotes.length > 0) {
      userNote = [...run.pendingNotes, userNote ?? ""].filter(Boolean).join("\n\n");
      run.pendingNotes = [];
      this.saveRun(run);
    }
    const steps = this.storage.listAiTeamSteps(run.id);
    // Leader 重新安排时，之前排队的步骤作废。
    const endedAt = this.iso();
    for (const step of steps) {
      if (step.status === "queued") this.saveStep({ ...step, status: "skipped", endedAt });
    }
    const lastLeaderSeq = Math.max(0, ...steps.filter((step) => step.kind === "leader" && step.status === "done").map((step) => step.seq));
    const finished: AiTeamFinishedStepSummary[] = steps
      .filter((step) => step.kind === "work" && step.seq > lastLeaderSeq && (step.status === "done" || step.status === "failed"))
      .map((step) => ({ step, memberName: this.member(run.team, step.memberId)?.name ?? step.memberId }));
    const step = this.createLeaderStep(run, userNote ? "回应用户" : "安排下一步");
    const handoffPath = this.writeHandoff(
      run,
      step.seq,
      "leader",
      finished.map(({ step: item, memberName }) => this.handoffEntry(run, item, memberName)),
    );
    await this.dispatchStep(run, step, (reportPath, fresh) => (
      buildLeaderFollowupPrompt(
        run, finished, reportPath, userNote, fresh, handoffPath, this.chatHistoryFor(run), this.defaultModelName,
      )
    ));
  }

  /** 一条交接条目：元信息 + 报告全文（全文只进交接文件，不进提示词）。 */
  private handoffEntry(run: AiTeamRun, step: AiTeamStep, memberName?: string): AiTeamHandoffEntry {
    return {
      seq: step.seq,
      title: step.title,
      memberName: memberName ?? this.member(run.team, step.memberId)?.name ?? step.memberId,
      status: step.status,
      reportPath: step.reportPath,
      report: step.report,
    };
  }

  /**
   * 成员步骤的上游交接：把依赖步骤的报告写成一个交接文件，提示词只给路径。
   * 没有依赖、或写文件失败时返回 null（提示词仍逐行列出上游报告文件）。
   */
  /**
   * 开工发言（S4）：成员**自己发的真实发言**（头像 + 名字 + 气泡），不是居中 notice；
   * 文案由 [stepStartText] 拼（依据只来自 `step.dependsOn`，不引 `decision.message` / 报告正文 / 提示词文本）。
   * 工作步骤与负责人步骤都走这里：负责人轮（制定计划 / 安排下一步 / 回应用户）同样要让人看见他开工了。
   */
  private postStepStart(
    run: AiTeamRun,
    step: AiTeamStep,
    member: AiTeamMember,
    agent: WandTaskAgent | undefined,
    reusable: string | null,
  ): void {
    this.postTurn(run, {
      role: "assistant",
      author: chatAuthor(member, reusable, agent),
      content: chatText(stepStartText(step, this.upstreamBasis(run, step), step.dependsOn.length)),
    });
  }

  /**
   * 开工发言的依据：只看 `step.dependsOn`，按依赖顺序解析出上游步骤（没有依赖返回空数组）。
   * 不调 `memberUpstream`：那个会顺手写交接文件，而这里只要读数据（设计 v2.1 强调不引 LLM 文本）。
   */
  private upstreamBasis(run: AiTeamRun, step: AiTeamStep): AiTeamStepBasis[] {
    if (step.dependsOn.length === 0) return [];
    const byId = new Map(this.storage.listAiTeamSteps(run.id).map((item) => [item.id, item]));
    return step.dependsOn
      .map((id) => byId.get(id))
      .filter((item): item is AiTeamStep => Boolean(item))
      .map((item) => ({
        seq: item.seq,
        title: item.title,
        memberName: this.member(run.team, item.memberId)?.name ?? item.memberId,
        reportPath: item.reportPath,
      }));
  }

  private memberUpstream(run: AiTeamRun, step: AiTeamStep): AiTeamUpstream | null {
    if (step.dependsOn.length === 0) return null;
    const byId = new Map(this.storage.listAiTeamSteps(run.id).map((item) => [item.id, item]));
    const deps = step.dependsOn
      .map((id) => byId.get(id))
      .filter((item): item is AiTeamStep => Boolean(item));
    if (deps.length === 0) return null;
    const entries = deps.map((item) => this.handoffEntry(run, item));
    const handoffPath = this.writeHandoff(run, step.seq, "work", entries);
    if (!handoffPath) return null;
    return {
      handoffPath,
      steps: entries.map(({ seq, title, memberName, status, reportPath }) => ({ seq, title, memberName, status, reportPath })),
    };
  }

  /**
   * 同一个群聊里接着开新运行时的续跑交接（§4.4 同一套文件交接）：把之前几轮的步骤摘要
   * 与群聊原文写进 `.wand-team/<runId>/chat-history.md`，提示词只给路径。
   * 不是续跑（没有群聊会话、之前没有运行、群聊也还是空的）返回 null，提示词就不带这一段。
   */
  private writeChatHistory(run: AiTeamRun): string | null {
    const chatSessionId = run.chatSessionId;
    if (!chatSessionId) return null;
    // 库按 created_at DESC 返回，换回时间正序，读的人看到的是「先做了什么、后做了什么」。
    const previous = this.storage.listAiTeamRuns({ taskId: run.taskId })
      .filter((item) => item.id !== run.id && item.chatSessionId === chatSessionId)
      .reverse();
    const turns = this.ops.snapshot(chatSessionId)?.messages ?? [];
    if (previous.length === 0 && turns.length === 0) return null;
    const runs = previous.map((item) => ({
      status: item.status,
      steps: this.storage.listAiTeamSteps(item.id).map((step) => ({
        seq: step.seq,
        memberName: this.member(run.team, step.memberId)?.name ?? step.memberId,
        title: step.title,
        status: step.status,
      })),
    }));
    const relative = aiTeamChatHistoryPath(run.id);
    try {
      const file = path.join(run.cwd, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, renderChatHistoryFile({ runs, turns, generatedAt: this.iso() }), "utf8");
      return relative;
    } catch (error) {
      console.error(`[AiTeam] write chat history ${relative} failed:`, getErrorMessage(error));
      return null;
    }
  }

  /**
   * 这次运行要接着的群聊上下文文件；文件不在（不是续跑、或写失败）就给 null。
   * 续跑标记就落在文件本身，所以服务重启后同一路径依旧成立，不用额外存一列。
   */
  private chatHistoryFor(run: AiTeamRun): string | null {
    const relative = aiTeamChatHistoryPath(run.id);
    return existsSync(path.join(run.cwd, relative)) ? relative : null;
  }

  /** 交接文件写到报告目录；失败只记日志，不阻断派发。 */
  private writeHandoff(run: AiTeamRun, seq: number, kind: "leader" | "work", entries: AiTeamHandoffEntry[]): string | null {
    if (entries.length === 0) return null;
    const relative = aiTeamHandoffPath(run.id, seq, kind);
    try {
      const file = path.join(run.cwd, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, renderHandoffFile(entries, this.iso()), "utf8");
      return relative;
    } catch (error) {
      console.error(`[AiTeam] write handoff ${relative} failed:`, getErrorMessage(error));
      return null;
    }
  }

  private hasBudget(run: AiTeamRun): boolean {
    if (run.stepsUsed < run.stepLimit) return true;
    this.postNotice(run, `已用完 ${run.stepLimit} 步的上限，团队先停下。回复一句让团队继续，或在任务面板里加步数。`);
    this.setStatus(run, "waiting_user", STEP_LIMIT_DETAIL);
    return false;
  }

  private createLeaderStep(run: AiTeamRun, title: string): AiTeamStep {
    const seq = this.nextSeq(run.id);
    const leader = leaderOf(run.team);
    const step: AiTeamStep = {
      id: randomUUID(),
      runId: run.id,
      seq,
      kind: "leader",
      memberId: leader.id,
      title,
      instructions: "",
      sessionId: null,
      status: "queued",
      report: "",
      reportPath: aiTeamReportPath(run.id, seq, "leader", leader.id),
      dependsOn: [],
      startedAt: null,
      endedAt: null,
    };
    this.saveStep(step);
    return step;
  }

  /**
   * 派出一个步骤：先把步骤标成 running 再发送；同一成员的活会话复用（上下文延续）。
   * 提示词分两段：`system`（角色与规则）只在新建会话时交给系统提示通道，`message` 是本轮用户消息。
   */
  private async dispatchStep(
    run: AiTeamRun,
    step: AiTeamStep,
    buildPrompt: (reportPath: string, fresh: boolean) => AiTeamPrompt,
    proceed = true,
  ): Promise<void> {
    const member = this.member(run.team, step.memberId);
    const candidates = member ? memberAgents(member) : [];
    const info = this.infoOf(step);
    const agent = candidates[info.usedCandidate];
    // §3.4 触发点 1 的事前分支：当前候选已被拉黑、候选列表被改到没有这一档，或快照就绪且模型
    // 明确不在清单里。三者都走 degradeWorkStep 留痕，不在这里静默换候选。
    if (member && step.kind === "work") {
      const blocked = agent
        ? this.blockedCandidate(run.id, agent)
        : { kind: "runtime-failure" as const, reason: `候选列表已变更，没有候选 ${info.usedCandidate + 1}` };
      const unknown = blocked === null && agent.kind === "structured"
        && isModelUnknownBeforeDispatch(agent, this.modelsOf?.(agent.provider))
        ? { kind: "model-unknown" as const, reason: `模型 ${agent.model} 不在 ${agent.provider} 已发现的模型清单里` }
        : null;
      const pre = blocked ?? unknown;
      if (pre) {
        await this.degradeWorkStep(run, step, pre, proceed);
        return;
      }
    }
    const reusable = member ? this.liveSessionFor(run, member, step.id, agent) : null;
    const prompt = buildPrompt(step.reportPath, reusable === null);
    const startedAt = this.iso();
    let running: AiTeamStep = { ...step, instructions: step.kind === "leader" ? prompt.message : step.instructions, status: "running", startedAt, sessionId: reusable };
    this.saveStep(running);
    this.notify(run);
    // 开工发言（S4）：就发在这个位置（原来那条居中 notice 的地方），所以候选起不来的那次尝试
    // 也会留一句「我正在开始工作」+ 随后的降级/失败出口；作者署名与报告同一套口径，
    // 复用会话时带真实 sessionId，新建在 open 前未知；若 open 失败，失败报告也可能无 ID。
    // 负责人步骤同样要发：负责人一轮可能要读代码好几分钟，中途只在群里留一条 live 卡，
    // 群聊看上去就是「工位上写着工作中、消息里什么都没有」，等他交出计划才突然出现一屏文字。
    // 设计 v2 的口径本来就是「步骤开工时该成员自己发一条」，工作步骤那条门是从旧 notice 继承来的。
    if (member) this.postStepStart(run, running, member, agent, reusable);
    try {
      if (!member) throw new Error("成员不存在");
      if (!agent) throw new Error("成员没有配置可用的 CLI 候选");
      if (reusable) {
        await this.ops.send(reusable, prompt.message);
      } else {
        const task = this.storage.getWandTask(run.taskId);
        if (!task) throw new Error("任务卡已被删除");
        const sessionId = await this.ops.open({
          task,
          agent,
          prompt: prompt.message,
          automationId: `ai-team:${run.id}`,
          systemPrompt: prompt.system,
        });
        running = { ...running, sessionId };
        this.saveStep(running);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      const kind = classifyCandidateFailure(message);
      if (agent && kind === "host-disabled") {
        // 进程级信号（agent-dispatch 的「当前服务未启用 … 会话」）：本次运行该 kind 的候选全部不再
        // 尝试，也不能当成「不可降级」直接吞掉——记进黑名单后交给既有失败出口。
        this.disableHostKind(run.id, agent.kind);
      } else if (agent && step.kind === "work" && kind === "spawn-missing"
        && !existsSync(path.join(run.cwd, step.reportPath)) && !this.noDegrade.has(step.id)) {
        // §3.4 触发点 1：会话根本没起来，ENOENT 对 structured / pty 同样可靠（修正 B4 排除的是
        // PTY 的异步分类）。传 `running` 而不是入参 `step`：复用会话时 sessionId 只在 running 上。
        // 候选边界与黑名单由 degradeWorkStep 自己判，耗尽时它走 failed 出口。
        await this.degradeWorkStep(run, running, { kind, reason: message }, proceed);
        return;
      }
      await this.finishStep(run, running, { kind: "failed", text: `派发失败：${this.redact(message)}` }, proceed);
    }
  }

  /**
   * 换候选 = 开新步（§3.4 五步），与 Leader 的格式重试同构。全程在调用方的 enqueue 链里；
   * 只直接派出 A′，**不整轮 advance**（N1：advance 的 queued/byId/busyMembers 是进循环时的快照，
   * 整轮调整会在同一栈里对同一步二次派发）。`proceed` 原样透传给 A′ 的 dispatchStep。
   */
  private async degradeWorkStep(
    run: AiTeamRun,
    step: AiTeamStep,
    failure: CandidateFailure,
    proceed: boolean,
  ): Promise<void> {
    const info = this.infoOf(step);
    const member = this.member(run.team, step.memberId);
    const candidates = member ? memberAgents(member) : [];
    const agent = candidates[info.usedCandidate];
    // 三条流（群聊 notice / 旧步 report / dispatch_info_json.skipped[].reason）共用这一个出口，
    // 先脱敏再截断：CLI 原文常带 /Users/<user>/… 与 token=…，落库前必须收掉（§4.5）。
    const reason = this.cleanError(failure.reason) || failure.kind;
    const skipped: StepDispatchInfo["skipped"] = [
      ...info.skipped,
      ...(agent ? [{ candidate: info.usedCandidate, agent, reason, errorKind: failure.kind }] : []),
    ];
    const next = info.usedCandidate + 1;
    const tail = candidates.slice(next);
    // 级联深度天然以候选上限（4）为界：每降一级 usedCandidate +1。耗尽时退回既有 failed 出口，
    // 交回 Leader 决定 ask/finish，不另设 waiting_user 捷径、不循环。
    if (!member || !agent || tail.length === 0 || tail.every((item) => this.blockedCandidate(run.id, item))) {
      const detail = skipped.map((item) => `候选 ${item.candidate + 1}（${item.reason}）`).join("、");
      this.noDegrade.add(step.id);
      try {
        await this.finishStep(run, step, {
          kind: "failed",
          sessionError: true,
          text: `${member?.name ?? "该成员"}的所有候选均不可用：${detail || reason}`,
        }, proceed);
      } finally {
        this.noDegrade.delete(step.id);
      }
      return;
    }
    // ① 安全阀：判错也不能让两个 CLI 同时写同一个工作目录。
    if (step.sessionId) {
      const previous = this.ops.snapshot(step.sessionId);
      if (previous && !isSessionGone(previous)) {
        try {
          this.ops.stop(step.sessionId);
        } catch (error) {
          // stop 抛错不做兜底会让旧步卡在 running，这里只记日志继续记账。
          console.error(`[AiTeam] stop degraded session ${step.sessionId} failed:`, getErrorMessage(error));
        }
      }
    }
    // ② 旧步只留痕：skipped 不占 stepsUsed（走 finishStep 会记 failed 并扣预算）。
    //    跳过链随这一步一起落 dispatch_info_json，重启后恢复链不会从候选 1 重来。
    this.saveStep({
      ...step,
      status: "skipped",
      report: `候选 ${info.usedCandidate + 1} 不可用：${reason}`,
      endedAt: this.iso(),
      dispatchInfo: { ...info, skipped },
    });
    // ③ 新步：同成员、同标题、同指令，继承 dependsOn；新 seq → reportPath 天然不同，
    //    不会撞上上一候选留在原地的半截报告文件。
    const seq = this.nextSeq(run.id);
    const replacement: AiTeamStep = {
      id: randomUUID(),
      runId: run.id,
      seq,
      kind: "work",
      memberId: step.memberId,
      title: step.title,
      instructions: step.instructions,
      sessionId: null,
      status: "queued",
      report: "",
      reportPath: aiTeamReportPath(run.id, seq, "work", step.memberId),
      dependsOn: step.dependsOn,
      startedAt: null,
      endedAt: null,
      dispatchInfo: { usedCandidate: next, skipped },
    };
    this.saveStep(replacement);
    // 群聊降级行（§5.3/B15）：一次降级一行，署名用切过去的新候选；事前 model-unknown 跳过
    // 同样走 degradeWorkStep，所以这里也覆盖它。reason 已经过脱敏 + 头尾截断（§4.5）。
    this.postNotice(
      run,
      `⚠️ ${member.name} 的首选配置不可用（${reason}），已切换到候选 ${next + 1}`,
      null,
      member,
      candidates[next],
    );
    // ④ 依赖重指向（R1）：排队步骤等的仍是「这件事做完」，只是换了承载候选的步骤。
    //    running / done 的历史步骤不改写。
    for (const queued of this.storage.listAiTeamSteps(run.id)) {
      if (queued.status !== "queued" || !queued.dependsOn.includes(step.id)) continue;
      this.saveStep({
        ...queued,
        dependsOn: queued.dependsOn.map((id) => (id === step.id ? replacement.id : id)),
      });
    }
    // ⑤ 黑名单记账（立即写 run_state_json），然后只直接派 A′。
    this.accountCandidateFailure(run.id, agent, failure.kind);
    await this.dispatchStep(run, replacement, (reportPath, fresh) => {
      const target = this.member(run.team, replacement.memberId) ?? member;
      return buildMemberPrompt(
        run, replacement, target, fresh, this.memberUpstream(run, replacement), this.chatHistoryFor(run),
      );
    }, proceed);
  }

  /**
   * 会话「起来又倒下」的启动期归因（§3.4 触发点 2）。判定核在 ai-team-availability，
   * 这里只负责喂时钟、快照与报告产出；不满足降级条件返回 null，按既有路径记 failed。
   */
  private asyncStartupFailure(run: AiTeamRun, step: AiTeamStep, outcomeText: string): CandidateFailure | null {
    const member = this.member(run.team, step.memberId);
    if (!member) return null;
    const info = this.infoOf(step);
    const candidates = memberAgents(member);
    const agent = candidates[info.usedCandidate];
    if (!agent) return null;
    const snapshot = step.sessionId ? this.ops.snapshot(step.sessionId) : null;
    // 启动时刻未知时按窗口外处理：宁可交回 Leader，不猜它是启动失败。
    const startedAt = step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
    const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, this.now() - startedAt) : AI_TEAM_STARTUP_WINDOW_MS;
    const errorMessage = snapshot?.structuredState?.lastError ?? outcomeText;
    const kind = classifyStartupFailure({
      status: snapshot?.status ?? "failed",
      hasAssistantReply: snapshot
        ? hasStepAssistantReply(snapshot, step.reportPath, errorMessage)
        : true,
      elapsedMs,
      errorMessage,
    });
    if (!isDegradableWorkFailure({
      stepKind: step.kind,
      agentKind: agent.kind,
      sessionError: true,
      hasReportOutput: existsSync(path.join(run.cwd, step.reportPath)),
      failure: kind,
      usedCandidate: info.usedCandidate,
      candidateCount: candidates.length,
      nextCandidateBlocked: this.blockedCandidate(run.id, candidates[info.usedCandidate + 1]) !== null,
    })) return null;
    return { kind, reason: errorMessage };
  }

  /** run 级黑名单里这一层是谁封的、为什么封（§3.4 修正 B12 两层键值 + host-disabled 进程级）。 */
  private blockedCandidate(runId: string, agent: WandTaskAgent | undefined): CandidateFailure | null {
    if (!agent) return null;
    const state = this.stateOf(runId);
    if (state.hostDisabled.includes(agent.kind)) {
      return {
        kind: "host-disabled",
        reason: `本服务未启用${agent.kind === "pty" ? "终端" : "结构化"}会话，候选 ${agent.provider} 不再尝试`,
      };
    }
    if (state.providers.includes(agent.provider)) {
      return { kind: "spawn-missing", reason: `${agent.provider} CLI 不可用` };
    }
    const blocked = state.agents.find((item) => item.key === agentKey(agent));
    if (blocked) return { kind: blocked.kind, reason: `${agent.provider}/${agent.model} 已被标记不可用` };
    return null;
  }

  /** 黑名单从库里读（§3.4）：run 不存在或列里是脏值时退化成空黑名单。 */
  private stateOf(runId: string): RunDegradeState {
    return this.storage.getAiTeamRunState(runId);
  }

  /** 每次黑名单变更立即落库，重启后已拉黑的候选与 strikes 计数都还在。 */
  private saveState(runId: string, state: RunDegradeState): void {
    this.storage.setAiTeamRunState(runId, state);
  }

  /** host-disabled 是进程级信号：本次运行该 kind 的候选全部不再尝试。 */
  private disableHostKind(runId: string, kind: WandTaskAgent["kind"]): void {
    const state = this.stateOf(runId);
    if (state.hostDisabled.includes(kind)) return;
    this.saveState(runId, { ...state, hostDisabled: [...state.hostDisabled, kind] });
  }

  /**
   * 失败候选的黑名单记账（§3.4）：spawn-missing 封 provider、model-unknown 直接封五元组、
   * startup-timeout 累计到 STARTUP_TIMEOUT_STRIKES 才封。runtime-failure 这类不计入，
   * 一次写完一次落库。
   */
  private accountCandidateFailure(runId: string, agent: WandTaskAgent, kind: CandidateFailureKind): void {
    const state = this.stateOf(runId);
    const key = agentKey(agent);
    if (kind === "spawn-missing") {
      if (state.providers.includes(agent.provider)) return;
      this.saveState(runId, { ...state, providers: [...state.providers, agent.provider] });
      return;
    }
    if (kind === "model-unknown") {
      if (state.agents.some((item) => item.key === key)) return;
      this.saveState(runId, { ...state, agents: [...state.agents, { key, kind }] });
      return;
    }
    if (kind !== "startup-timeout") return;
    const strikes = Math.min(999, (state.strikes[key] ?? 0) + 1);
    const agents = strikes >= STARTUP_TIMEOUT_STRIKES && !state.agents.some((item) => item.key === key)
      ? [...state.agents, { key, kind: "startup-timeout" as const }]
      : state.agents;
    this.saveState(runId, { ...state, strikes: { ...state.strikes, [key]: strikes }, agents });
  }

  /**
   * 本步实际用的候选与累计跳过的候选（`dispatch_info_json`）；没有记录 = 首选、没跳过过任何候选。
   * 读的是步骤行自己，重启后同一条恢复链继续从库里接着走。
   */
  private infoOf(step: AiTeamStep): StepDispatchInfo {
    return step.dispatchInfo ?? { usedCandidate: 0, skipped: [] };
  }

  /** 该步实际使用的候选（§3.6 署名口径）：候选一律经 memberAgents 读，越界回退首选。 */
  private actualAgent(member: AiTeamMember, step: AiTeamStep): WandTaskAgent | null {
    const candidates = memberAgents(member);
    return candidates[this.infoOf(step).usedCandidate] ?? candidates[0] ?? null;
  }

  /**
   * 运行停下来等用户时，用户可能刚在团队页换了成员的 CLI / 模型（比如额度用尽换一个）。
   * 接着跑之前换成最新配置；成员被删了或没有负责人时保留原快照。
   */
  private refreshTeam(run: AiTeamRun): void {
    const latest = this.storage.getAiTeam(run.teamId);
    if (!latest || !latest.members.some((member) => member.isLeader)) return;
    const used = new Set(this.storage.listAiTeamSteps(run.id).map((step) => step.memberId));
    if ([...used].some((id) => !latest.members.some((member) => member.id === id))) return;
    run.team = latest;
  }

  /**
   * 同一成员复用还活着的会话。比对基准是该成员**最近一步实际使用的候选**（§3.6），
   * 降级之后不会因为「和首选不一致」而每步都另开会话；候选换了五元组就不复用。
   */
  private liveSessionFor(
    run: AiTeamRun,
    member: AiTeamMember,
    excludeStepId: string,
    agent: WandTaskAgent | undefined,
  ): string | null {
    const steps = this.storage.listAiTeamSteps(run.id);
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      if (step.id === excludeStepId || step.memberId !== member.id || !step.sessionId) continue;
      const snapshot = this.ops.snapshot(step.sessionId);
      if (!snapshot || isSessionGone(snapshot)) return null;
      const candidates = memberAgents(member);
      const previous = candidates[this.infoOf(step).usedCandidate] ?? candidates[0];
      if (!previous || (agent && agentKey(previous) !== agentKey(agent))) return null;
      if (snapshot.provider && snapshot.provider !== previous.provider) return null;
      const model = previous.model === "default" ? "" : previous.model;
      if (model && snapshot.selectedModel && snapshot.selectedModel !== model) return null;
      return step.sessionId;
    }
    return null;
  }

  // ── 群聊 ──

  private openChat(run: AiTeamRun, task: WandTask, objective: string, chatHistory?: string | null): void {
    if (!this.chat) return;
    // 「首次建群」只能在这一拍判定：`open()` 之后 run.chatSessionId 就有值了。
    // 入群序列（S1–S3）只跟这个分支走，续跑/重启接回/同一个群里开新 run 都不重播（v2.1 规则 1）。
    const firstChat = !run.chatSessionId;
    try {
      if (firstChat) {
        run.chatSessionId = this.chat.open({ task, run, title: aiTeamChatTitle(task.title) });
      }
    } catch (error) {
      console.error(`[AiTeam] open chat for ${run.id} failed:`, getErrorMessage(error));
      return;
    }
    if (objective) this.postUser(run, objective);
    if (!firstChat) {
      // 续跑时不说「接手」：用户看得出这是同一轮工作往下走，并把交给团队的历史文件摊开给他核。
      if (chatHistory) {
        this.postNotice(run, `接着这个群聊里上一轮的进度继续；交给负责人和成员的记录见 ${chatHistory}`);
      }
      return;
    }
    // 首次建群：负责人先入群，再按名单邀请其余成员（2–3 条系统行，作者都是负责人）。
    const leader = leaderOf(run.team);
    const leaderAgent = leader ? memberAgents(leader)[0] ?? leader.agent : undefined;
    for (const line of chatIntroLines(run.team, aiTeamChatTitle(task.title))) {
      this.postNotice(run, line, run.chatSessionId, leader, leaderAgent);
    }
  }

  /** 真实文件保持原字节；CLI 回复/手动完成的报告先落成文件，再投递卡片。 */
  private completedReportFile(run: AiTeamRun, step: AiTeamStep, report: string, fromFile: boolean): TeamReportFile | undefined {
    try {
      const file = path.resolve(run.cwd, step.reportPath);
      if (!fromFile) {
        mkdirSync(path.dirname(file), { recursive: true });
        // 不覆盖恰好迟到的 CLI 文件：它才是产物真源。
        if (!existsSync(file)) writeFileSync(file, report, { encoding: "utf8", flag: "wx" });
      }
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error("报告路径不是文件");
      return {
        stepId: step.id, path: file, name: path.basename(file), size: stat.size,
        preview: teamReportPreview(readReport(file), step.title),
      };
    } catch (error) {
      console.error("[AiTeam] report attachment unavailable:", getErrorMessage(error));
      return undefined;
    }
  }

  private postTurn(run: AiTeamRun, turn: ConversationTurn): void {
    if (!this.chat || !run.chatSessionId) return;
    try {
      this.chat.post(run.chatSessionId, [turn]);
    } catch (error) {
      console.error(`[AiTeam] post to chat ${run.chatSessionId} failed:`, getErrorMessage(error));
    }
  }

  private postUser(run: AiTeamRun, text: string): void {
    this.postTurn(run, { role: "user", content: chatText(text) });
  }

  private postNotice(
    run: AiTeamRun,
    text: string,
    sessionId?: string | null,
    member?: AiTeamMember,
    agent?: WandTaskAgent | null,
  ): void {
    this.postTurn(run, {
      role: "assistant", notice: true, content: chatText(text),
      author: member ? chatAuthor(member, sessionId, agent) : undefined,
    });
  }

  /** 负责人的决定：说明 + 派工清单；等批准 / 等回复时告诉用户在群里怎么接话。 */
  private postLeaderDecision(
    run: AiTeamRun,
    step: AiTeamStep,
    decision: Extract<ReturnType<typeof parseLeaderDecision>, { ok: true }>["decision"],
  ): void {
    const lines = [decision.message.trim()];
    if (decision.action === "assign") {
      const assigned = decision.steps.map((item, index) => {
        const name = this.member(run.team, item.memberId)?.name ?? item.memberId;
        const basis = assignmentBasisNote(item.after, decision.steps.map((entry) => entry.title));
        return `${index + 1}. **@${name}** ${item.title}${basis}`;
      });
      lines.push(assigned.join("\n"));
    }
    const leader = leaderOf(run.team);
    this.postTurn(run, {
      role: "assistant",
      author: chatAuthor(leader, step.sessionId, this.actualAgent(leader, step)),
      content: chatText(lines.filter(Boolean).join("\n\n")),
    });
    if (decision.action === "assign" && !run.planApproved) {
      this.postNotice(run, "等你批准计划：回复「批准」开始执行，或者直接写修改意见。");
    } else if (decision.action === "ask") {
      this.postNotice(run, "负责人在等你回复，直接在群里回答即可。");
    } else if (decision.action === "finish") {
      this.postNotice(run, "团队已完成。还有要改的，直接在群里说，团队会接着处理。");
    }
    this.postVerifyOverlapNotices(run, decision);
  }

  /**
   * 职责交叉只提示、不拦截（§3.3 修正 B13）：同一个成员既实现过又验收时，在群里提一句，
   * 由用户决定是否让负责人调整。服务端不做任何职责硬校验，步骤照常派发。
   */
  private postVerifyOverlapNotices(
    run: AiTeamRun,
    decision: Extract<ReturnType<typeof parseLeaderDecision>, { ok: true }>["decision"],
  ): void {
    if (decision.action !== "assign") return;
    // 此刻本步还没落库，listAiTeamSteps 里只有历史步骤，正好用来判「已经做过实现」。
    const history = this.storage.listAiTeamSteps(run.id);
    const notified = new Set<string>();
    for (const assigned of decision.steps) {
      if (notified.has(assigned.memberId)) continue;
      const member = this.member(run.team, assigned.memberId);
      if (!member || member.role !== "verify") continue;
      const didWork = history.some(
        (step) => step.kind === "work" && step.memberId === member.id && step.status === "done",
      );
      if (!didWork) continue;
      notified.add(member.id);
      this.postNotice(run, `「${member.name}」既做过实现又被安排验收，介意的话在群里说一句让负责人调整。`);
    }
  }

  private member(team: AiTeam, memberId: string): AiTeamMember | null {
    return team.members.find((member) => member.id === memberId) ?? null;
  }

  private nextSeq(runId: string): number {
    const steps = this.storage.listAiTeamSteps(runId);
    return (steps[steps.length - 1]?.seq ?? 0) + 1;
  }

  private setStatus(run: AiTeamRun, status: AiTeamRun["status"], detail: string): void {
    run.status = status;
    run.statusDetail = detail;
    this.saveRun(run);
    // 进终态就不可能再有 live 变化，清掉该 run 的推送指纹：不然长跑的服务会按 run 数线性攒字符串。
    if (AI_TEAM_TERMINAL_RUN_STATUSES.includes(status)) this.lastLiveKey.delete(run.id);
  }

  private saveRun(run: AiTeamRun): void {
    run.updatedAt = this.iso();
    this.storage.saveAiTeamRun(run);
    this.notify(run);
  }

  private saveStep(step: AiTeamStep): void {
    this.storage.saveAiTeamStep(step);
  }

  private notify(run: AiTeamRun): void {
    try {
      this.notifyListener?.(run);
    } catch {
      // 通知失败不影响已写入的状态；客户端会在下次打开时重新拉取。
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
