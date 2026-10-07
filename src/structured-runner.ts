import type { ContentBlock, ConversationTurn, SessionSnapshot } from "./types.js";

/** core 引擎回报的上下文占用；CLI runner 无此能力时省略。 */
export interface StructuredContextUsage {
  /** 本轮请求实际占用的上下文 token。 */
  usedTokens: number;
  /** 当前模型上下文窗口 token。 */
  windowTokens: number;
  /** used / window，0-100，保留 1 位。 */
  percent: number;
  /** 本会话累计压缩次数。 */
  compactions?: number;
}

/** core 引擎本轮发生的一次上下文压缩，由会话管理器落成压缩状态。 */
export interface StructuredCompactionNotice {
  reason: "threshold" | "manual" | "overflow";
  tokensBefore: number;
  /** 压缩后重估的 token；估算值，不作为计费依据。 */
  tokensAfter?: number;
  summary: string;
  /** 摘要覆盖到第几条会话消息之前（即从这一条开始保留原样）。 */
  fromTurnIndex: number;
  /** 被摘要覆盖的消息条数。 */
  droppedMessages: number;
  /** 本会话累计压缩次数。 */
  compactions: number;
  /** 摘要调用本身的用量。 */
  usage?: ConversationTurn["usage"];
}

export interface StructuredRunnerTurnState {
  blocks: ContentBlock[];
  result: string;
  sessionId: string | null;
  model?: string;
  usage?: ConversationTurn["usage"];
  /** Provider turn phase when the CLI stays alive after its visible reply. */
  phase?: "responding" | "background";
  /** Actual server-owned resource choice for this submitted round; presentation metadata only. */
  resourceSelection?: import("./pi-session-settings.js").PiResourceSelectionNotice;
  /** 本轮结束后的上下文占用（core 引擎）。 */
  contextUsage?: StructuredContextUsage;
  /** 本轮发生的上下文压缩（core 引擎）；每个回合最多一条。 */
  compaction?: StructuredCompactionNotice;
  /** Native Pi extension metadata to checkpoint, never part of the wire DTO. */
  harnessExtensionState?: SessionSnapshot["harnessExtensionState"];
}

export interface StructuredRunnerContext {
  session: SessionSnapshot;
  prompt: string;
  env: NodeJS.ProcessEnv;
  /** Execution-only group boundary; never persisted/projected to session DTOs. */
  modelGroupModels?: readonly string[];
}

export interface StructuredRunnerObserver {
  isActive(): boolean;
  onStdout?(text: string): void;
  onStderr?(text: string): void;
  onEvent?(event: Record<string, unknown>): void;
  onUpdate(state: StructuredRunnerTurnState): void;
}

export interface StructuredRunnerResult {
  state: StructuredRunnerTurnState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  primaryError: string | null;
  errors?: string[];
  stdoutTail?: string;
  stopReason?: "ask-user-question";
  spawnError?: NodeJS.ErrnoException;
  /** Explicit pre-execution fact only; absent means unknown, not permission to replay. */
  inputAccepted?: boolean;
  /** A resource preparation failure or explicit price boundary must not be bypassed by fallback. */
  retryForbidden?: boolean;
  /** Adapter-verified initial provider refusal, with no prior model output or tool execution. */
  rejection?: import("./structured-failure.js").ProviderRejectionKind;
  /** Normalized once at the runner boundary; consumers do not re-guess delivery from error text. */
  failure?: import("./structured-failure.js").StructuredFailure | null;
}

export interface StructuredRunnerExecution {
  args: string[];
  spawnedAt: string;
  pid: number | null;
  completion: Promise<StructuredRunnerResult>;
  /** Idempotent, best-effort, and never throws. Completion must still settle. */
  interrupt(): void;
}

export interface StructuredRunnerAdapter {
  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution;
}
