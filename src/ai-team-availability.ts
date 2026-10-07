import type { CandidateFailureKind } from "./ai-team-types.js";
import type { WandTaskAgent, WandTaskAgentKind } from "./task-types.js";

/**
 * v2 启动失败分类与候选降级判定（设计文档 §3.4）。
 * 本模块只放纯函数：不接 runner、不读全局状态、不碰时钟与文件系统；
 * 时间窗与快照一律由调用方算好传入。
 */

/** 类别真源在 ai-team-types.ts（StepDispatchInfo 引用），这里按文档口径对外再导出一次。 */
export type { CandidateFailureKind } from "./ai-team-types.js";

/**
 * startup-timeout 判定的启动窗口（§3.4、§11-Q7）：固定常量，刻意不开 config 口子。
 * 窗口内「会话已没 + 从没出过 assistant 回复」才视为启动失败可降级；窗口外按 runtime-failure 对待。
 */
export const AI_TEAM_STARTUP_WINDOW_MS = 45_000;

/** 与 runner isSessionGone 同语义的状态清单（本地镜像，保持本模块零依赖 runner）。 */
const SESSION_GONE_STATUSES: readonly string[] = ["exited", "failed", "stopped"];

export function isSessionGoneStatus(status: string): boolean {
  return SESSION_GONE_STATUSES.includes(status);
}

/**
 * CLI 缺失类文案（spawn-missing）。来源样例（只引用不改）：
 *   - structured-session-manager.ts: codex exec ENOENT →「PATH 中找不到 … 可执行文件」
 *   - git-quick-commit.ts: error.code === "ENOENT" →「未找到 <cmd> CLI。」
 */
const SPAWN_MISSING_PATTERNS: readonly RegExp[] = [
  /\bENOENT\b/i,
  /No such file or directory/i,
  /command not found/i,
  /native binary not found/i,
  /找不到[^\n]{0,24}可执行文件/,
  /未找到[^\n]{0,24}CLI/,
  /(cli|binary|executable|可执行文件)[^\n]{0,24}not found/i,
  /not found[^\n]{0,24}(cli|binary|executable)/i,
];

/** host-disabled 文案源：agent-dispatch.ts 的「当前服务未启用结构化/终端会话，无法派发 Agent。」 */
const HOST_DISABLED_PATTERNS: readonly RegExp[] = [/未启用[^\n]{0,8}会话/];

/**
 * 按错误文案分类。只认 spawn-missing 与 host-disabled 两类稳定信号；
 * 无法归类的启动期错误一律 runtime-failure（不降级，宁失败交回 Leader）。
 * model-unknown 只由事前快照比对产生（isModelUnknownBeforeDispatch），事后一律不判。
 */
export function classifyCandidateFailure(errorMessage: string | null | undefined): CandidateFailureKind {
  const text = (errorMessage ?? "").trim();
  if (!text) return "runtime-failure";
  if (HOST_DISABLED_PATTERNS.some((pattern) => pattern.test(text))) return "host-disabled";
  if (SPAWN_MISSING_PATTERNS.some((pattern) => pattern.test(text))) return "spawn-missing";
  return "runtime-failure";
}

export interface StartupFailureProbe {
  /** 会话快照状态（SessionSnapshot.status 字面量）。 */
  status: string;
  /** snapshot.messages 是否出现过 assistant 回复（有任何输出即算）。 */
  hasAssistantReply: boolean;
  /** now - step.startedAt（毫秒）；由调用方计算。 */
  elapsedMs: number;
  /** structuredState.lastError 等错误文案；没有则留空。 */
  errorMessage?: string | null;
}

/**
 * 异步启动失败的组合判定：先按文案（ENOENT 优先于窗口），再看 startup window。
 * 结论只会是 spawn-missing / host-disabled / startup-timeout / runtime-failure。
 */
export function classifyStartupFailure(probe: StartupFailureProbe): CandidateFailureKind {
  const byText = classifyCandidateFailure(probe.errorMessage);
  if (byText !== "runtime-failure") return byText;
  if (
    isSessionGoneStatus(probe.status)
    && !probe.hasAssistantReply
    && probe.elapsedMs < AI_TEAM_STARTUP_WINDOW_MS
  ) {
    return "startup-timeout";
  }
  return "runtime-failure";
}

export interface WorkFailureInput {
  /** 成员执行步骤的启动失败降级；负责人完整候选重试由 runner 管理。 */
  stepKind: "leader" | "work";
  /** PTY 候选一律不异步分类、不降级（§3.4 修正 B4）。 */
  agentKind: WandTaskAgentKind;
  /** stepOutcome 给出的会话失败信号。 */
  sessionError: boolean;
  /** 报告文件已有产出 → 会话启动是成功的，不降级。 */
  hasReportOutput: boolean;
  /** classifyStartupFailure / classifyCandidateFailure 的结果。 */
  failure: CandidateFailureKind;
  /** 本步实际使用的候选下标。 */
  usedCandidate: number;
  /** 该成员的候选总数（memberAgents(member).length）。 */
  candidateCount: number;
  /** 下一候选是否已在 run 级黑名单里。 */
  nextCandidateBlocked: boolean;
}

/**
 * 降级判定核（§3.4 触发点 2）：全部条件满足才允许「降级开新步」。
 * host-disabled / model-unknown / runtime-failure / format-error / user-stop 一律 false。
 */
export function isDegradableWorkFailure(input: WorkFailureInput): boolean {
  if (input.stepKind !== "work") return false;
  if (input.agentKind !== "structured") return false;
  if (!input.sessionError) return false;
  if (input.hasReportOutput) return false;
  if (input.failure !== "spawn-missing" && input.failure !== "startup-timeout") return false;
  if (input.usedCandidate >= input.candidateCount - 1) return false;
  if (input.nextCandidateBlocked) return false;
  return true;
}

/** 事前比对用的最小快照视图：一列模型 id（字符串或带 id 字段的条目）。 */
export type ModelCatalogView =
  | ReadonlyArray<string | { id?: unknown } | null | undefined>
  | null
  | undefined;

/**
 * model-unknown 的事前检查（§3.4 修正 B3），方向是「拿不准就放行」：
 * 仅当快照存在、清单非空、model 不是 "default" 且精确匹配失败时才返回 true。
 * 快照缺失 / 空清单（冷启动）、"default"、命中清单 → false，照常派发交给事后降级。
 */
export function isModelUnknownBeforeDispatch(agent: WandTaskAgent, snapshot: ModelCatalogView): boolean {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return false;
  if (agent.model === "default") return false;
  const ids = new Set<string>();
  for (const entry of snapshot) {
    if (typeof entry === "string") ids.add(entry);
    else if (entry && typeof entry === "object" && typeof entry.id === "string") ids.add(entry.id);
  }
  if (ids.size === 0) return false;
  return !ids.has(agent.model);
}
