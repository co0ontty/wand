import { type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { defaultModelGroupSelector, isAutoAssignSelector, resolveModelGroupModels } from "./model-groups.js";
import { resolveAutoAssign } from "./model-auto-assign.js";
import { withModelGroups } from "./model-group-runner.js";
import { classifyStructuredFailure, hasStructuredExecutionProgress, type StructuredFailure } from "./structured-failure.js";
import { withAutomaticPiResources } from "./pi-auto-resources.js";
import { randomUUID } from "node:crypto";

import { prepareSessionWorktree, type WorktreeSetupSpec } from "./git-worktree.js";

import { SessionLogger } from "./session-logger.js";
import { WandStorage } from "./storage.js";
import {
  CardExpandDefaults, ContentBlock, ConversationTurn, EscalationRequest, EscalationScope,
  ExecutionMode, HarnessSessionContext, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, SessionSource, StructuredSessionState,
  WandConfig,
} from "./types.js";
import { truncateMessagesForTransport } from "./message-truncator.js";
import { stampNewToolUseTimes } from "./tool-use-timestamps.js";
import { buildChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";
import { getDefaultModelForProvider } from "./config.js";
import type { WandTaskAgent } from "./task-types.js";
import { recordIterationPrompt } from "./iteration-log.js";
import { startEmployeeKnowledgeRunner } from "./employee-knowledge.js";
import { CoreRunner } from "./core-runner.js";
import { CoreTurnTracker } from "./core-turn-tracker.js";
import type { CoreStatus } from "./core-status-cli.js";
import { coreHarnessAgentDir, resolveHarnessEngineSync, type EngineResolution } from "./harness-engine.js";
import { cliPiSettingsRejection, defaultPiCliSessionSettings, defaultPiSessionSettings, patchPiSessionSettings, type PiSessionSettings } from "./pi-session-settings.js";
import { withDecisionAccess, type DecisionRuntimeAccess } from "./decision-runner.js";
import { signalNameFromNumber } from "./signal-utils.js";
import {
  provisionalSessionTopic,
  SessionNativeTitleTracker,
  SessionTopicCoordinator,
  sessionTopicBlocklistForSnapshot,
  shouldAcceptGeneratedSessionTitle,
  shouldGenerateSessionTopicFromInput,
} from "./session-topic.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { isSessionProvider, providerCliCommand } from "./session-provider.js";
import { resolveSessionProvider, resolveSystemAiContext } from "./session-ai-context.js";
import { readNativeSessionTitle } from "./native-session-title.js";
import { CodexRunner } from "./structured-codex-adapter.js";
import { CodexProtocolReducer } from "./structured-codex-protocol.js";
import { normalizeStructuredToolResultContent } from "./structured-content.js";
import {
  buildSessionSystemPromptParts,
  ClaudeCliRunner,
  derivePermissionPolicy,
} from "./structured-claude-adapter.js";
import { inferStructuredEscalation, structuredPermissionDenied } from "./structured-permission.js";
import {
  captureTaskMeta,
  extractClaudeAssistantMessage,
  extractClaudeModelName,
  normalizeClaudeToolInput,
  stampParentTaskResults,
  stampSelfTask,
  tagSubagentBlocks,
  ClaudeCliProtocolReducer,
  type TaskMetaMap,
} from "./structured-claude-protocol.js";
import { OpenCodeRunner, applyOpenCodeEvent } from "./structured-opencode-adapter.js";
import { GrokRunner, applyGrokEvent } from "./structured-grok-adapter.js";
import { QoderRunner } from "./structured-qoder-adapter.js";
import { PiRunner, applyPiEvent, isMissingPiSession } from "./structured-pi-adapter.js";
import { GeminiRunner, applyGeminiEvent, isMissingGeminiSession } from "./structured-gemini-adapter.js";
import {
  structuredRunId,
  type StructuredExecHost,
  type StructuredRunState,
} from "./structured-exec-host.js";
import type { StructuredCompactionNotice, StructuredRunnerAdapter, StructuredRunnerExecution, StructuredRunnerResult, StructuredRunnerTurnState } from "./structured-runner.js";
import {
  defaultStructuredRunner,
  defaultStructuredState,
  isStructuredRunnerForProvider,
  normalizeThinkingEffort,
  normalizeTurnAnchors,
  resolveStructuredRunner,
} from "./structured-provider-common.js";
import { TurnQuietHeartbeat } from "./turn-heartbeat.js";
import { enrichStructuredMessages, WAND_PROTOCOL_VERSION } from "./structured-client-protocol.js";
import { RETENTION_IDLE_MS } from "./retention.js";


export interface StructuredSessionManagerRunners {
  /**
   * 宿主注入的执行器。注入 `pi` 视作钉死 CLI 引擎（`auto` 不覆盖）；
   * 注入 `core` 则视为宿主提供了进程内 harness 能力。
   */
  core?: StructuredRunnerAdapter;
  claudeCli?: StructuredRunnerAdapter;
  codex?: StructuredRunnerAdapter;
  opencode?: StructuredRunnerAdapter;
  grok?: StructuredRunnerAdapter;
  qoder?: StructuredRunnerAdapter;
  pi?: StructuredRunnerAdapter;
  gemini?: StructuredRunnerAdapter;
}

interface CreateStructuredSessionOptions {
  title?: string;
  cwd: string;
  mode: ExecutionMode;
  provider?: SessionProvider;
  runner?: SessionRunner;
  worktreeEnabled?: boolean;
  worktreeSpec?: WorktreeSetupSpec;
  /** 用户指定的模型（别名或完整 ID）。留空则 spawn 时不加 --model。 */
  model?: string;
  /** 用户预设的思考深度。留空 / null 视为 off。 */
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  sessionSource?: SessionSource;
  automationId?: string;
  employeeId?: string;
  employeeName?: string;
  employeeAvatar?: string;
  employeeCandidates?: WandTaskAgent[];
  employeeCandidateIndex?: number;
  /** 会话级系统提示（团队 / 自动化的角色与规则）；走 provider 的系统提示通道。 */
  systemPrompt?: string;
  /** 所属工作空间 ID（多标签 / 分屏项目）。 */
  workspaceId?: string;
  /** 所属工作空间任务 ID（任务 = 独立 worktree + 一组标签）。 */
  workspaceTaskId?: string;
  /**
   * 恢复用的初始会话 id：
   *   - Codex：历史 thread id，首条消息即 `codex exec ... resume <id>` 续接。
   *   - Claude：历史 session id，首条消息即 `--resume` / SDK resume 续接。
   * 留空表示新建会话。
   */
  claudeSessionId?: string;
}

/**
 * 转发会话（AI 团队群聊）：外观是普通结构化会话，但不起 CLI。
 * 用户发的话交给 handler，别的参与者的发言由 appendRelayTurns 写进来。
 * 按 automationId 前缀识别，重启后照样生效。
 */
export type StructuredRelayHandler = (sessionId: string, text: string) => void | Promise<void>;
class PersistedStructuredRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedStructuredRunnerError";
  }
}

/** Runner-owned refusal facts, never inferred by schedulers from a displayed error. */
class UnacceptedStructuredInputError extends Error {
  readonly #state: StructuredRunnerTurnState;
  constructor(message: string, readonly failure: StructuredFailure, state: StructuredRunnerTurnState) {
    super(message);
    this.name = "UnacceptedStructuredInputError";
    this.#state = state;
  }
  get state(): StructuredRunnerTurnState { return this.#state; }
}

interface StreamingTurnState extends StructuredRunnerTurnState {}

/** Line-at-a-time protocol replayer used to rebuild turn state from daemon logs. */
interface ReplayProcessor {
  state: StructuredRunnerTurnState;
  stderr: string;
  primaryError: string | null;
  errors?: string[];
  stdoutTail?: string;
  stopReason?: "ask-user-question";
  askUserQuestionDetected?: boolean;
  /** Feed one complete stdout line; returns true when turn state changed. */
  feed(line: string, observedAt?: string): boolean;
}

function buildReplayProcessor(session: SessionSnapshot): ReplayProcessor {
  const runner = session.runner;
  if (runner === "codex-cli-exec") {
    const reducer = new CodexProtocolReducer(session);
    return {
      state: reducer.state,
      stderr: "",
      get primaryError() { return reducer.primaryError; },
      get errors() { return reducer.errors; },
      feed: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        let event: unknown;
        try { event = JSON.parse(trimmed); } catch { return false; }
        return reducer.apply(event);
      },
    };
  }
  if (runner === "claude-cli-print" || runner === "qoder-cli-print") {
    const reducer = new ClaudeCliProtocolReducer(session);
    const managed = session.mode === "managed";
    const processor: ReplayProcessor = {
      state: reducer.state,
      stderr: "",
      primaryError: null,
      stdoutTail: "",
      get askUserQuestionDetected() { return reducer.askUserQuestionDetected; },
      get stopReason() { return reducer.askUserQuestionDetected ? "ask-user-question" as const : undefined; },
      feed: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        processor.stdoutTail = trimmed.slice(-1024);
        let event: unknown;
        try { event = JSON.parse(trimmed); } catch { return false; }
        if (runner === "qoder-cli-print" && event && typeof event === "object" && !Array.isArray(event)) {
          const record = event as Record<string, unknown>;
          if (record.type === "result" && record.subtype !== "success") {
            const errors = Array.isArray(record.errors)
              ? record.errors.filter((item): item is string => typeof item === "string")
              : [];
            processor.primaryError = errors.join("\n") || "Qoder CLI execution failed";
          }
        }
        return reducer.apply(event, managed);
      },
    };
    return processor;
  }
  // grok-cli-headless / opencode-cli-run / pi-cli-json / gemini-cli-json share the same shape.
  const state: StructuredRunnerTurnState = {
    blocks: [],
    result: "",
    sessionId: session.claudeSessionId,
    model: session.selectedModel ?? session.structuredState?.model,
    ...(runner === "opencode-cli-run" ? { usage: undefined } : {}),
  };
  const processor: ReplayProcessor = {
    state,
    stderr: "",
    primaryError: null,
    feed: (line, observedAt) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      let event: Record<string, unknown>;
      try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { return false; }
      const error = runner === "grok-cli-headless"
        ? applyGrokEvent(state as Parameters<typeof applyGrokEvent>[0], event)
        : runner === "opencode-cli-run"
          ? applyOpenCodeEvent(state, event)
          : runner === "gemini-cli-json"
            ? applyGeminiEvent(state, event)
            : applyPiEvent(state, event, observedAt);
      if (error) processor.primaryError = error;
      return true;
    },
  };
  return processor;
}

function recoveredCommandLabel(runner: SessionRunner | undefined): string {
  switch (runner) {
    case "codex-cli-exec": return "codex exec";
    case "opencode-cli-run": return "opencode run";
    case "grok-cli-headless": return "grok -p --output-format streaming-json";
    case "qoder-cli-print": return "qodercli -p --output-format stream-json";
    case "pi-cli-json": return "pi --mode json";
    case "gemini-cli-json": return "gemini -p --output-format stream-json";
    default: return "claude -p";
  }
}


const STREAM_EMIT_DEBOUNCE_MS = 16;
/** Min interval between full saveSession() calls for an in-progress streaming turn.
 *  saveSession serializes the entire messages array, so doing it on every NDJSON
 *  event is N². close-path always calls saveSession unconditionally to take the
 *  authoritative final snapshot. */
// Full message snapshots become increasingly expensive during long turns.
// Terminal paths always force an authoritative save, so a one-second crash
// checkpoint keeps recovery useful without rewriting megabytes five times a
// second on the event loop.
const STREAM_SAVE_THROTTLE_MS = 1_000;
const DETACHED_RECOVERY_RETRY_MS = 500;
const ARCHIVE_AFTER_MS = RETENTION_IDLE_MS;

interface StreamingCheckpointDirty {
  metadata: boolean;
  output: boolean;
  messages: boolean;
}

/**
 * 找出最后一条 assistant turn 中尚未配对 tool_result 的 AskUserQuestion tool_use。
 * 用来识别"刚被 SIGTERM 中断、正在等用户提交答案"的状态。
 */
function findUnpairedAskUserQuestion(
  messages: ConversationTurn[],
): { id: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i];
    if (turn.role !== "assistant") continue;
    for (const block of turn.content) {
      if (block.type === "tool_use" && block.name === "AskUserQuestion") {
        const toolUseId = block.id;
        // 检查后续 turn 中是否已有对应 tool_result
        let answered = false;
        for (let j = i + 1; j < messages.length; j++) {
          const nextTurn = messages[j];
          for (const nb of nextTurn.content) {
            if (nb.type === "tool_result" && nb.tool_use_id === toolUseId) {
              answered = true;
              break;
            }
          }
          if (answered) break;
        }
        if (!answered) return { id: toolUseId };
      }
    }
    // 只检查最后一条 assistant turn
    return null;
  }
  return null;
}

/** Enrich a snapshot with a derived summary from the first user message. */
function withSummary(snapshot: SessionSnapshot): SessionSnapshot {
  if (snapshot.summary) return snapshot;
  const messages = snapshot.messages ?? [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text.trim()) {
        return { ...snapshot, summary: block.text.trim().slice(0, 120) };
      }
    }
    break;
  }
  return snapshot;
}

/** Should we auto-approve permissions for this mode? */
function shouldAutoApproveForMode(mode: ExecutionMode): boolean {
  return mode === "full-access" || mode === "managed" || mode === "auto-edit";
}

function buildStructuredOutputPayload(snapshot: SessionSnapshot): ProcessEvent["data"] {
  return {
    wandProtocolVersion: WAND_PROTOCOL_VERSION,
    output: snapshot.output,
    messages: snapshot.messages ? enrichStructuredMessages(snapshot.messages, snapshot.id) : undefined,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    provider: snapshot.provider,
    runner: snapshot.runner,
    selectedModel: snapshot.selectedModel,
    thinkingEffort: snapshot.thinkingEffort,
    employeeId: snapshot.employeeId,
    employeeName: snapshot.employeeName,
    employeeAvatar: snapshot.employeeAvatar,
    employeeCandidateIndex: snapshot.employeeCandidateIndex,
    title: snapshot.title,
    description: snapshot.description,
    summary: snapshot.description ?? snapshot.summary,
  };
}

/**
 * 返回最近一次真正提交给结构化会话的用户输入。
 *
 * 排队非空时，队尾才是“上一条提交”；否则回看当前正在处理的最后一个 user turn。
 * 这里只接受可无损还原成字符串的 text / tool_result，避免把图片等结构化内容误判
 * 成更早的纯文本输入。
 */
export function getLastSubmittedStructuredInput(snapshot: Pick<SessionSnapshot, "messages" | "queuedMessages">): string | null {
  const queue = snapshot.queuedMessages ?? [];
  for (let i = queue.length - 1; i >= 0; i--) {
    const queued = queue[i]?.trim();
    if (queued) return queued;
  }

  const messages = snapshot.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i];
    if (turn.role !== "user") continue;

    const textParts = turn.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text);
    if (textParts.length > 0) {
      const text = textParts.join("\n").trim();
      return text || null;
    }

    const toolResult = turn.content.find(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result" && typeof block.content === "string",
    );
    return toolResult && typeof toolResult.content === "string" ? toolResult.content.trim() || null : null;
  }
  return null;
}

/** 仅用于 in-flight 排队分支：连续两次内容相同则把后一次视为输入重放。 */
export function isDuplicateStructuredQueueInput(
  snapshot: Pick<SessionSnapshot, "messages" | "queuedMessages">,
  input: string,
): boolean {
  const prompt = input.trim();
  if (!prompt) return false;
  return getLastSubmittedStructuredInput(snapshot) === prompt;
}

function buildIncrementalStructuredPayload(
  snapshot: SessionSnapshot,
  cardDefaults: CardExpandDefaults,
): ProcessEvent["data"] {
  const messages = snapshot.messages ?? [];
  // Derive semantics from the complete current turn before taking the
  // incremental tail; TaskCreate results can live in an earlier provider frame.
  const clientMessages = enrichStructuredMessages(messages, snapshot.id);
  const lastTurn = clientMessages.length > 0 ? clientMessages[clientMessages.length - 1] : undefined;
  // Streaming turn (index 0 here) is preserved verbatim; truncation only kicks
  // in if the live response is already bigger than the transport threshold,
  // matching the PTY runner's behaviour in process-manager.ts.
  const lastMessage = lastTurn ? truncateMessagesForTransport([lastTurn], cardDefaults, 0)[0] : undefined;
  return {
    wandProtocolVersion: WAND_PROTOCOL_VERSION,
    incremental: true,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    lastMessage,
    messageCount: messages.length,
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Identity of one content block inside an assistant turn. Tool ids are copied
 * verbatim from the CLI stream and never mutate, so they are the anchors used to
 * align a replayed turn with the transcript we already stored.
 */
function replayBlockAnchor(block: ContentBlock): string | null {
  switch (block.type) {
    case "tool_use": return `tool_use:${block.id}`;
    case "tool_result": return `tool_result:${block.tool_use_id}`;
    case "thinking": return `thinking:${block.thinking}`;
    case "text": return `text:${block.text}`;
    default: return null;
  }
}

/**
 * Index of the last replayed block the stored turn already contains, or -1 when
 * no overlap can be proven.
 *
 * Needed because a daemon replay log can start mid-stream
 * (STRUCTURED_RUN_LOG_MAX_CHARS), so the first replayed blocks usually repeat the
 * tail of the turn we accumulated live before the restart.
 */
function lastStoredAnchorIndex(stored: ContentBlock[] | null, replayed: ContentBlock[]): number {
  if (!stored || stored.length === 0) return -1;
  const known = new Set<string>();
  for (const block of stored) {
    const anchor = replayBlockAnchor(block);
    if (anchor !== null) known.add(anchor);
  }
  let cut = -1;
  for (let index = 0; index < replayed.length; index += 1) {
    const anchor = replayBlockAnchor(replayed[index]);
    if (anchor !== null && known.has(anchor)) cut = index;
  }
  return cut;
}

/**
 * 截断重放期间「本地已存 turn + replay 新增段」的合并视图。
 *
 * 重启后在 terminald 里继续跑的 CLI 只保留最后 STRUCTURED_RUN_LOG_MAX_CHARS 字符的
 * stdout，replay 出来的是「半截尾巴」：直接用它覆盖会删掉重启前用户已经看到的输出，
 * 完全不用它又会让前端冻结到本轮结束。所以把 checkpoint 里的 turn 当固定底，只把
 * replay 里能证明是新增的那段拼在后面。cut 只算一次，视图随 replay 增长而增长
 * （保持流式），且重复调用幂等（不会重复追加、也不会丢底）。
 */
class TruncatedReplayView {
  private readonly base: ContentBlock[] | null;
  private cut = -1;
  private primed = false;

  constructor(messages: ConversationTurn[] | undefined) {
    const last = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
    this.base = last && last.role === "assistant" ? last.content : null;
  }

  get ready(): boolean {
    return this.primed;
  }

  /** 必须在 replay 首轮 feed 完成后再定锚点：feed 途中的半截 blocks 会把重叠判错。 */
  prime(replayed: ContentBlock[]): void {
    this.cut = lastStoredAnchorIndex(this.base, replayed);
    this.primed = true;
  }

  content(replayed: ContentBlock[]): ContentBlock[] {
    if (!this.base || this.base.length === 0) return replayed;
    // 证明不了重叠就只信本地已存内容（宁可暂不追加，也不要重复整段）。
    if (!this.primed || this.cut === -1) return this.base;
    const extra = replayed.slice(this.cut + 1);
    return extra.length === 0 ? this.base : [...this.base, ...extra];
  }
}

/** Append a standalone notice turn without touching the previous assistant turn. */
function appendNoticeTurn(messages: ConversationTurn[] | undefined, turn: ConversationTurn): ConversationTurn[] {
  return [...(messages ?? []), { ...turn, createdAt: isoNow(), completedAt: isoNow() }];
}

/** core 引擎的压缩通知 → 可持久化的会话上下文（历史不删，只记切点与摘要）。 */
function compactionToSessionContext(notice: StructuredCompactionNotice): HarnessSessionContext {
  return {
    summary: notice.summary,
    fromTurnIndex: notice.fromTurnIndex,
    tokensBefore: notice.tokensBefore,
    compactions: notice.compactions,
  };
}

function cancelPendingResourceSelection(messages: ConversationTurn[] | undefined): ConversationTurn[] | undefined {
  const last = messages?.at(-1);
  if (!messages || last?.role !== "assistant" || last.resourceSelection?.status !== "selecting") return messages;
  return [...messages.slice(0, -1), { ...last, completedAt: isoNow(), resourceSelection: {
    ...last.resourceSelection, status: "cancelled", label: "本轮自动选择已取消",
  } }];
}

function upsertAssistantMessage(
  messages: ConversationTurn[] | undefined,
  turn: ConversationTurn,
  complete = false,
  stampNewTools = true,
): ConversationTurn[] {
  const msgs = [...(messages ?? [])];
  const last = msgs[msgs.length - 1];
  const observedAt = isoNow();
  const createdAt = (last?.role === "assistant" ? last.createdAt : undefined) ?? turn.createdAt ?? observedAt;
  const next: ConversationTurn = {
    ...turn,
    ...(turn.resourceSelection ? { resourceSelection: turn.resourceSelection }
      : last?.role === "assistant" && last.resourceSelection ? { resourceSelection: last.resourceSelection } : {}),
    createdAt,
    content: stampNewToolUseTimes(
      turn.content, last?.role === "assistant" ? last.content : undefined, observedAt, stampNewTools,
    ),
  };
  if (complete) next.completedAt = isoNow();
  else if (last?.role === "assistant" && last.completedAt) next.completedAt = last.completedAt;
  if (last?.role === "assistant") msgs[msgs.length - 1] = next;
  else msgs.push(next);
  return msgs;
}

export class StructuredSessionManager {
  private readonly sessions = new Map<string, SessionSnapshot>();
  // Both freshly started runners and adopted daemon runs own the same input gate.
  private readonly pendingRunnerExecutions = new Map<string, Pick<StructuredRunnerExecution, "interrupt">>();
  // Server-only, one-shot execution UUIDs. Actual request lifecycle clears them; metadata updates do not.
  // Never persisted or included in session DTOs.
  private readonly unacceptedTeamStarts = new Map<string, { requestId: string; failure: StructuredFailure }>();
  private readonly interruptedWith = new Map<string, string>();
  /**
   * 「智能分配」正在结算的会话：这段窗口内还没有 runner 归属，新输入必须排队而不是另起一轮。
   * token.cancelled 由 stop / delete 置位，结算回来后不得再启动。
   */
  private readonly autoAssignPending = new Map<string, { cancelled: boolean }>();
  private readonly preserveQueueOnInterrupt = new Set<string>();
  /** Last wall-clock time (ms) a streaming checkpoint reached SQLite. */
  private readonly lastStreamSaveAt = new Map<string, number>();
  private readonly streamCheckpointTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamCheckpointDirty = new Map<string, StreamingCheckpointDirty>();
  /**
   * Idempotency keys we've already accepted, mapped to their wall-clock timestamp.
   * Android WebView 在进程恢复时偶尔会重发上一个未收到响应的 POST（HTTP/2 stream
   * reset 等场景），客户端 JS 没有重试逻辑也拦不住。这里用 (sessionId, key) 永
   * 久去重，重复就抛错让前端弹 toast 提示，**不**做任何处理。timestamp 仅用于
   * map 大小溢出时按时间裁剪。
   */
  private readonly seenIdempotencyKeys = new Map<string, number>();
  private readonly relayHandlers = new Map<string, StructuredRelayHandler>();
  private emitEvent: ((event: ProcessEvent) => void) | null = null;
  private archiveTimer: NodeJS.Timeout | null = null;
  /**
   * 静默期心跳：回合在飞且连续 TURN_QUIET_HEARTBEAT_MS 没有任何事件时，用现有的
   * status 事件重发一次权威快照（含最新 turn 锚点）。timer 只在 inFlight 期间存在。
   */
  private readonly turnHeartbeat = new TurnQuietHeartbeat((sessionId) => this.publishQuietHeartbeat(sessionId));
  private readonly topicCoordinator = new SessionTopicCoordinator();
  private readonly nativeTitles = new SessionNativeTitleTracker();
  private readonly streamEmitTimers = new Set<NodeJS.Timeout>();
  private readonly claudeCliRunner: StructuredRunnerAdapter;
  private readonly codexRunner: StructuredRunnerAdapter;
  private readonly openCodeRunner: StructuredRunnerAdapter;
  private readonly grokRunner: StructuredRunnerAdapter;
  private readonly qoderRunner: StructuredRunnerAdapter;
  private readonly piRunner: StructuredRunnerAdapter;
  /** 进程内 core 引擎供员工候选显式启用；普通 Pi 主功能不使用它。 */
  private readonly coreRunner: StructuredRunnerAdapter;
  /** 宿主是否显式注入了 pi 的 CLI runner / core runner，供系统级引擎状态使用。 */
  private readonly piRunnerSupplied: boolean;
  private readonly coreRunnerSupplied: boolean;
  private coreRestartDrains = 0;
  private readonly geminiRunner: StructuredRunnerAdapter;
  /** Structured CLI runs that were mid-flight when the previous web process died. */
  private pendingRecoveryIds: string[] = [];
  private detachedRecoveryPromise: Promise<void> | null = null;
  private detachedRecoveryRetryTimer: NodeJS.Timeout | null = null;
  private detachedRecoveryFailureLogged = false;
  private disposed = false;

  constructor(
    private readonly storage: WandStorage,
    private readonly config: WandConfig,
    private readonly logger: SessionLogger | null = null,
    runners: StructuredSessionManagerRunners = {},
    private readonly execHost?: StructuredExecHost,
    private readonly decisionRuntime: () => DecisionRuntimeAccess | null = () => null,
    openRouter?: OpenRouterFreeModelsService,
    /** 「智能分配」专用的本地决策入口：只有真正能跑时才注入，没注入则用系统员工回退。 */
    private readonly autoAssignEvaluate: () => DecisionRuntimeAccess["evaluate"] = () => undefined,
  ) {
    const wrap = (runner: StructuredRunnerAdapter): StructuredRunnerAdapter =>
      withModelGroups(withDecisionAccess(runner, storage, decisionRuntime), config);
    this.claudeCliRunner = wrap(runners.claudeCli ?? new ClaudeCliRunner({ language: () => this.config.language }, this.execHost));
    this.codexRunner = wrap(runners.codex ?? new CodexRunner(undefined, this.execHost));
    this.openCodeRunner = wrap(runners.opencode ?? new OpenCodeRunner(undefined, this.execHost));
    this.grokRunner = wrap(runners.grok ?? new GrokRunner(undefined, this.execHost));
    this.qoderRunner = wrap(runners.qoder ?? new QoderRunner(undefined, this.execHost));
    this.piRunner = wrap(withAutomaticPiResources(
      runners.pi ?? new PiRunner(undefined, this.execHost, coreHarnessAgentDir(config.harness),
        openRouter ? { storage, service: openRouter } : undefined), config,
      { evaluate: () => this.decisionRuntime()?.evaluate }));
    this.coreRunner = withModelGroups(runners.core ?? new CoreRunner({ config: this.config,
      decisionAccess: decisionRuntime, openRouter }), config);
    this.piRunnerSupplied = runners.pi !== undefined;
    this.coreRunnerSupplied = runners.core !== undefined;
    this.geminiRunner = wrap(runners.gemini ?? new GeminiRunner(undefined, this.execHost));
    // 能力探测放到 server 启动处 await（warmCoreHarness），这里不再另起预热。
    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "structured") continue;
      const restoredStatus = snapshot.status === "running" ? "idle" : snapshot.status;
      const storedProvider = snapshot.provider ?? snapshot.structuredState?.provider;
      const provider: SessionProvider = isSessionProvider(storedProvider) ? storedProvider : "claude";
      const storedRunner = snapshot.runner ?? snapshot.structuredState?.runner;
      // Legacy/corrupt snapshots are normalized on restore so send dispatch can
      // rely on the provider/runner invariant without making startup fail.
      const runner = isStructuredRunnerForProvider(provider, storedRunner)
        ? storedRunner
        : defaultStructuredRunner(provider);
      const recoverableDetachedRun = snapshot.status === "running"
        && this.execHost?.persistent === true
        // 进程内 core 回合不会比服务活得更久；重启后只能算中断，不能去 daemon 里领养。
        && snapshot.structuredState?.engine !== "core";
      if (recoverableDetachedRun) this.pendingRecoveryIds.push(snapshot.id);
      const restored: SessionSnapshot = {
        ...snapshot,
        sessionKind: "structured",
        sessionSource: snapshot.sessionSource ?? "interactive",
        automationId: snapshot.automationId,
        provider,
        runner,
        status: recoverableDetachedRun ? "running" : restoredStatus,
        autoApprovePermissions: snapshot.autoApprovePermissions ?? shouldAutoApproveForMode(snapshot.mode),
        approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
        queuedMessages: snapshot.queuedMessages ?? [],
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          // 保留既有可读投影（engine / contextUsage / compactions / phase），只覆盖受管字段。
          ...(snapshot.structuredState ?? {}),
          provider,
          runner,
          model: snapshot.structuredState?.model ?? snapshot.selectedModel ?? undefined,
          lastError: snapshot.status === "running"
            ? recoverableDetachedRun ? null : "服务重启，上一轮已中断。"
            : snapshot.structuredState?.lastError ?? null,
          inFlight: recoverableDetachedRun,
          activeRequestId: recoverableDetachedRun
            ? snapshot.structuredState?.activeRequestId ?? `recover-pending-${snapshot.id}`
            : null,
          // 锚点跟着真实运行事实走：还能被 terminald 领养的回合保留重启前那一轮的起点
          // （attach 成功后由 adoptTurn 重新挂静默心跳）；服务重启导致中断的回合降级为
          // idle，锚点一并清 null，不伪造「还在跑」。
          turnStartedAt: recoverableDetachedRun ? snapshot.structuredState?.turnStartedAt ?? null : null,
          lastActivityAt: recoverableDetachedRun ? snapshot.structuredState?.lastActivityAt ?? null : null,
        },
        selectedModel: snapshot.selectedModel ?? null,
        titleGenerating: false,
      };
      this.sessions.set(restored.id, restored);
      // Keep the durable running marker until terminald inventory has been
      // reconciled. If web is restarted again during startup, the next owner
      // must still know there is a daemon run to adopt.
      if (!recoverableDetachedRun) this.storage.saveSession(restored);
    }
    this.archiveExpiredSessions();
    this.archiveTimer = setInterval(() => {
      try { this.archiveExpiredSessions(); } catch (err) {
        console.error(`[StructuredSessionManager] archive scan failed: ${String(err)}`);
      }
    }, 60 * 1000);
    this.archiveTimer.unref?.();
  }

  private archiveExpiredSessions(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.archived || session.status === "running") continue;
      const referenceTime = session.endedAt ?? session.startedAt;
      const endedAtMs = Date.parse(referenceTime);
      if (!Number.isFinite(endedAtMs) || now - endedAtMs < ARCHIVE_AFTER_MS) continue;
      session.archived = true;
      session.archivedAt = new Date(now).toISOString();
      this.storage.updateSessionRuntimeMetadata(session);
    }
  }

  setEventEmitter(emitEvent: (event: ProcessEvent) => void): void {
    if (this.disposed) return;
    this.emitEvent = emitEvent;
  }

  getCoreTurnStatus(): CoreStatus {
    const ids = new Set(CoreTurnTracker.getActiveTurnIds());
    // Include manager-owned executions through their final durable checkpoint.
    for (const [id] of this.pendingRunnerExecutions) {
      if (this.sessions.get(id)?.structuredState?.engine === "core") ids.add(id);
    }
    const activeTurnCount = Math.max(CoreTurnTracker.getActiveTurnCount(), ids.size);
    return { hasActiveTurns: activeTurnCount > 0, activeTurnCount, activeTurnIds: [...ids] };
  }

  /** Keep current turns running; new Pi inputs stay in the durable input queue. */
  beginCoreRestartDrain(): () => void {
    if (this.disposed) throw new Error("StructuredSessionManager has been disposed.");
    this.coreRestartDrains += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.coreRestartDrains -= 1;
      if (this.coreRestartDrains === 0) this.resumeQueuedPiMessages();
    };
  }

  /** Resume accepted inputs after a cancelled drain or after a successful restart. */
  resumeQueuedPiMessages(): void {
    if (this.disposed || this.coreRestartDrains > 0) return;
    for (const session of this.sessions.values()) {
      if (session.provider === "pi" && session.status === "idle"
        && !session.structuredState?.inFlight && !session.structuredState?.lastError
        && (session.queuedMessages?.length ?? 0) > 0) {
        setImmediate(() => { void this.flushNextQueuedMessage(session.id); });
      }
    }
  }

  /** Stop every runner and flush terminal state before storage is closed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unacceptedTeamStarts.clear();
    // 静默心跳不跨服务关闭存活（会话级 timer 不允许泄漏）。
    this.turnHeartbeat.dispose();

    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = null;
    }
    if (this.detachedRecoveryRetryTimer) {
      clearTimeout(this.detachedRecoveryRetryTimer);
      this.detachedRecoveryRetryTimer = null;
    }
    for (const timer of this.streamEmitTimers) clearTimeout(timer);
    this.streamEmitTimers.clear();

    const activeSessionIds = new Set<string>([
      ...this.pendingRunnerExecutions.keys(),
      ...Array.from(this.sessions.values())
        .filter((session) => session.structuredState?.inFlight)
        .map((session) => session.id),
    ]);
    // With a persistent exec host the daemon keeps CLI runs alive across web
    // restarts; leave them in-flight so recoverDetachedRuns() can re-attach.
    const detachSafe = this.execHost?.persistent === true;
    for (const id of activeSessionIds) {
      const session = this.sessions.get(id);
      if (!session) continue;
      if (detachSafe) continue;
      const cancelled: SessionSnapshot = {
        ...session,
        messages: cancelPendingResourceSelection(session.messages),
        status: "idle",
        exitCode: null,
        endedAt: null,
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          ...this.settleTurn(id, session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
          inFlight: false,
          activeRequestId: null,
          lastError: null,
        },
      };
      this.sessions.set(id, cancelled);
      try { this.saveAuthoritativeSession(cancelled); } catch { /* best-effort shutdown flush */ }
    }

    for (const [executionId, execution] of this.pendingRunnerExecutions) {
      if (detachSafe) continue;
      execution.interrupt();
    }
    this.pendingRunnerExecutions.clear();
    this.interruptedWith.clear();
    this.preserveQueueOnInterrupt.clear();
    for (const token of this.autoAssignPending.values()) token.cancelled = true;
    this.autoAssignPending.clear();
    for (const timer of this.streamCheckpointTimers.values()) clearTimeout(timer);
    this.streamCheckpointTimers.clear();
    this.streamCheckpointDirty.clear();
    this.lastStreamSaveAt.clear();
    this.topicCoordinator.clear();
    this.nativeTitles.clear();
    this.emitEvent = null;
  }

  // ---------------------------------------------------------------------------
  // Detached-run recovery: re-attach CLI runs that kept going inside terminald
  // while the previous web process was down.
  // ---------------------------------------------------------------------------

  /** Called once after startup wiring; transient daemon failures retry automatically. */
  recoverDetachedRuns(): Promise<void> {
    if (this.disposed || this.execHost?.persistent !== true || this.pendingRecoveryIds.length === 0) {
      return Promise.resolve();
    }
    if (this.detachedRecoveryPromise) return this.detachedRecoveryPromise;
    if (this.detachedRecoveryRetryTimer) {
      clearTimeout(this.detachedRecoveryRetryTimer);
      this.detachedRecoveryRetryTimer = null;
    }
    const recovery = this.recoverDetachedRunsOnce();
    this.detachedRecoveryPromise = recovery;
    const clearRecovery = (): void => {
      if (this.detachedRecoveryPromise === recovery) this.detachedRecoveryPromise = null;
    };
    void recovery.then(clearRecovery, clearRecovery);
    return recovery;
  }

  private async recoverDetachedRunsOnce(): Promise<void> {
    if (this.disposed || !this.execHost) return;
    let runs: StructuredRunState[];
    try {
      runs = await this.execHost.listRuns();
      this.detachedRecoveryFailureLogged = false;
    } catch (error) {
      if (!this.detachedRecoveryFailureLogged) {
        this.detachedRecoveryFailureLogged = true;
        process.stderr.write(`[wand] structured run recovery waiting for terminal daemon: ${getErrorMessage(error)}\n`);
      }
      this.scheduleDetachedRecovery();
      return;
    }

    if (this.disposed) return;
    const ids = [...this.pendingRecoveryIds];
    const byRunId = new Map(runs.map((run) => [run.runId, run]));
    for (const sessionId of ids) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.pendingRecoveryIds = this.pendingRecoveryIds.filter((id) => id !== sessionId);
        continue;
      }
      const state = byRunId.get(structuredRunId(sessionId));
      if (!state) {
        // Inventory was read successfully, so this is a genuinely lost run,
        // not a temporary control-plane outage. Commit the interrupted view.
        const interrupted: SessionSnapshot = {
          ...session,
          status: "idle",
          exitCode: null,
          endedAt: null,
          structuredState: {
            ...this.settleTurn(sessionId, session.structuredState as StructuredSessionState),
            inFlight: false,
            activeRequestId: null,
            lastError: "服务重启，上一轮已中断。",
          },
        };
        this.sessions.set(sessionId, interrupted);
        this.saveAuthoritativeSession(interrupted);
        this.emitStructuredSnapshot(interrupted);
        this.pendingRecoveryIds = this.pendingRecoveryIds.filter((id) => id !== sessionId);
        continue;
      }
      try {
        // listRuns is metadata-only on Render v2. Fetch the authoritative
        // paged replay from the owner before feeding any provider reducer.
        const attached = await this.execHost.attachRun(state.runId);
        if (this.disposed) return;
        if (!attached || attached.incarnationId !== state.incarnationId) {
          throw new Error("Structured run changed owner between inventory and replay");
        }
        await this.resumeDetachedRun(this.requireSession(sessionId), attached);
        this.pendingRecoveryIds = this.pendingRecoveryIds.filter((id) => id !== sessionId);
      } catch (error) {
        console.error(`[WAND] structured run recovery failed for ${sessionId}:`, error);
        if (!this.disposed && !this.pendingRecoveryIds.includes(sessionId)) {
          this.pendingRecoveryIds.push(sessionId);
        }
      }
    }
    this.scheduleDetachedRecovery();
  }

  private scheduleDetachedRecovery(): void {
    if (this.disposed || this.pendingRecoveryIds.length === 0 || this.detachedRecoveryRetryTimer) return;
    this.detachedRecoveryRetryTimer = setTimeout(() => {
      this.detachedRecoveryRetryTimer = null;
      void this.recoverDetachedRuns();
    }, DETACHED_RECOVERY_RETRY_MS);
    this.detachedRecoveryRetryTimer.unref?.();
  }

  private async resumeDetachedRun(snapshot: SessionSnapshot, initialState: StructuredRunState): Promise<void> {
    const sessionId = snapshot.id;
    if (this.disposed || !this.execHost || !snapshot.structuredState) return;
    const requestId = `recover-${initialState.incarnationId}`;
    let runningHandle: Awaited<ReturnType<StructuredExecHost["adoptRun"]>> = null;
    let interruptRequested = false;
    const execution = {
      interrupt: (): void => {
        interruptRequested = true;
        runningHandle?.interrupt();
      },
    };
    // Reserve ownership before publishing inFlight or awaiting adoption. Inputs
    // arriving during replay/attach must queue just like inputs to a fresh runner.
    this.pendingRunnerExecutions.set(sessionId, execution);

    // Re-arm the in-flight marker so UI and request guards treat the resumed
    // turn like any other streaming turn.
    const resumed: SessionSnapshot = {
      ...snapshot,
      status: "running",
      exitCode: null,
      endedAt: null,
      structuredState: this.adoptTurn(sessionId, {
        ...(snapshot.structuredState as StructuredSessionState),
        inFlight: true,
        activeRequestId: requestId,
        lastError: null,
      }),
    };
    this.sessions.set(sessionId, resumed);
    this.saveAuthoritativeSession(resumed);
    this.emitStructuredSnapshot(resumed);
    process.stderr.write(`[wand] resuming structured run for session ${sessionId} (daemon pid ${initialState.pid})\n`);
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: `${resumed.runner ?? "structured"}-recovered`,
      provider: resumed.provider,
      pid: initialState.pid,
      cwd: resumed.cwd,
      status: initialState.status,
      exitCode: initialState.exitCode,
      stdoutTruncated: initialState.stdoutTruncated,
      recoveredAt: new Date().toISOString(),
    });

    const processor = buildReplayProcessor(resumed);
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    // 日志被截断时 reducer 只看到半截历史，重建出的 turn 远比本地已存的少；
    // 不能用它覆盖 messages/output，也不能就此冻结前端。
    const replayTruncated = initialState.stdoutTruncated;
    const replayView = new TruncatedReplayView(resumed.messages);
    let replayingHistory = true;
    const syncTurn = (turnState: StructuredRunnerTurnState): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const structuredState = this.noteTurnActivity(sessionId, {
        ...(current.structuredState as StructuredSessionState),
        model: turnState.model ?? current.structuredState?.model,
        phase: turnState.phase ?? current.structuredState?.phase,
      });
      if (replayTruncated) {
        // 锚点未定前（首轮 feed 中）只有半截 blocks，先只落元数据。
        if (!replayView.ready) {
          const patched: SessionSnapshot = { ...current, structuredState };
          this.sessions.set(sessionId, patched);
          this.saveStreamingSnapshot(patched, { metadata: true });
          return;
        }
        // 已存底 + replay 新增段：前端继续流式拿到增长中的 turn，库里也不会丢底。
        const merged: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks(replayView.content([...turnState.blocks]), turnState.result),
          usage: turnState.usage,
        };
        const patched: SessionSnapshot = {
          ...current,
          messages: upsertAssistantMessage(current.messages, merged, false, !replayingHistory),
          structuredState,
        };
        this.sessions.set(sessionId, patched);
        this.saveStreamingSnapshot(patched);
        return;
      }
      const turn: ConversationTurn = {
        role: "assistant",
        content: this.compactContentBlocks([...turnState.blocks], turnState.result),
        usage: turnState.usage,
      };
      const messages = upsertAssistantMessage(current.messages, turn, false, !replayingHistory);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
        structuredState,
      };
      this.sessions.set(sessionId, patched);
      this.saveStreamingSnapshot(patched);
    };
    const flushEmit = (): void => {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      emitTimer = null;
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (current) {
        this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
      }
    };
    const scheduleEmit = (): void => {
      if (!emitTimer) emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
    };
    const onApplied = (changed: boolean): void => {
      if (changed) {
        syncTurn(processor.state);
        scheduleEmit();
      }
      if (processor.askUserQuestionDetected && runningHandle) {
        runningHandle.interrupt();
      }
    };

    let lastStdoutSeq = initialState.stdoutSeq;
    let lastStderrSeq = initialState.stderrSeq;
    const feedLine = (line: string): void => {
      onApplied(processor.feed(line, replayingHistory ? undefined : new Date().toISOString()));
    };
    const feedDelta = (text: string): void => {
      carry += text;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) feedLine(line);
    };
    let carry = "";

    const feedFullLog = (): void => {
      const log = initialState.stdoutLog;
      const lines = log.split("\n");
      const tail = lines.pop() ?? "";
      for (const line of lines) feedLine(line);
      if (tail.trim()) feedLine(tail);
    };

    if (initialState.status === "exited") {
      feedFullLog();
      replayView.prime([...processor.state.blocks]);
      this.finalizeRecoveredRun(sessionId, requestId, processor, replayView, {
        exitCode: initialState.exitCode,
        signal: initialState.signal === null ? null : signalNameFromNumber(initialState.signal),
        stderr: initialState.stderrLog,
        stdoutTruncated: initialState.stdoutTruncated,
      });
      flushEmit();
      return;
    }

    // Still running: replay what we have, then subscribe live. Events that
    // arrive between snapshot and subscription are deduped via fedChars.
    {
      const lines = initialState.stdoutLog.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) feedLine(line);
    }
    try {
      runningHandle = await this.execHost.adoptRun(structuredRunId(sessionId));
    } catch (error) {
      this.releasePendingRunnerExecution(sessionId, execution, false);
      throw error;
    }
    // Server shutdown detaches persistent runs; only an explicit stop/delete
    // should cancel a handle that arrived after its request was invalidated.
    if (this.disposed) return;
    if (!this.isCurrentRequest(sessionId, requestId)) {
      runningHandle?.interrupt();
      this.releasePendingRunnerExecution(sessionId, execution);
      return;
    }
    if (!runningHandle) {
      // Run vanished between listing and adoption; fall back to failure notes.
      this.finalizeRecoveredRun(sessionId, requestId, processor, replayView, {
        exitCode: null,
        signal: null,
        stderr: initialState.stderrLog,
        stdoutTruncated: false,
        lost: true,
      });
      flushEmit();
      return;
    }
    // 首轮 feed + attach 完成后再定锚点，之后 onStream 的事件都走合并视图。
    replayView.prime([...processor.state.blocks]);
    replayingHistory = false;
    runningHandle.onStream((event) => {
      // Events may be buffered while structuredAttach is in flight. Sequence
      // watermarks distinguish overlap with the snapshot from genuinely new
      // output; character-count skipping corrupts a new short event.
      if (event.stream === "stdout") {
        if (event.seq <= lastStdoutSeq) return;
        lastStdoutSeq = event.seq;
        // 重启后 daemon 继续吐出的输出也要落回会话制品，否则会话日志在重启点断掉，
        // 事后无从核对这一轮到底产出了什么。
        this.logger?.appendStructuredStdout(sessionId, event.data);
        feedDelta(event.data);
        return;
      }
      if (event.seq <= lastStderrSeq) return;
      lastStderrSeq = event.seq;
      this.logger?.appendStructuredStderr(sessionId, event.data);
      processor.stderr += event.data;
    });
    runningHandle.onExit((event) => {
      if (carry.trim()) feedLine(carry);
      carry = "";
      this.finalizeRecoveredRun(sessionId, requestId, processor, replayView, {
        exitCode: event.exitCode,
        signal: event.signal === null ? null : signalNameFromNumber(event.signal),
        stderr: processor.stderr,
        stdoutTruncated: initialState.stdoutTruncated,
      });
      flushEmit();
    });
    // Install exit listeners before delivering an interrupt that arrived during adopt.
    if (interruptRequested) runningHandle.interrupt();
  }

  private finalizeRecoveredRun(
    sessionId: string,
    requestId: string,
    processor: ReplayProcessor,
    replayView: TruncatedReplayView,
    outcome: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      stdoutTruncated: boolean;
      lost?: boolean;
    },
  ): void {
    if (!this.isCurrentRequest(sessionId, requestId)) return;
    const execution = this.pendingRunnerExecutions.get(sessionId);
    if (execution) this.releasePendingRunnerExecution(sessionId, execution);
    else this.execHost?.forgetRun(structuredRunId(sessionId));
    const current = this.sessions.get(sessionId);
    if (!current) return;

    const commandLabel = recoveredCommandLabel(current.runner);
    const interruptedForQuestion = processor.stopReason === "ask-user-question";
    // 退出码/信号是 CLI 的权威结论：daemon 的 replay 日志被截断只说明我们重建不出
    // 完整过程记录，不代表这一轮失败（否则 exit 0 会被报成 "exited with code 0"）。
    const replayTruncated = outcome.stdoutTruncated;
    const failedExit = outcome.lost
      || (outcome.exitCode !== null && outcome.exitCode !== 0)
      || outcome.signal !== null;
    const interruptPrompt = this.interruptedWith.get(sessionId);
    if ((processor.primaryError || failedExit) && !interruptedForQuestion && !interruptPrompt) {
      const errorText = outcome.lost
        ? "服务重启后运行进程已丢失，本轮未能完成。"
        : this.formatStructuredExitError(commandLabel, outcome.exitCode, outcome.signal, {
            stderr: outcome.stderr.slice(-4096),
            primary: processor.primaryError,
            extras: processor.errors,
            stdoutTail: processor.stdoutTail,
          });
      const failed = this.finishStructuredFailure(
        current,
        typeof outcome.exitCode === "number" ? outcome.exitCode : 1,
        errorText,
        processor.state,
        { keepTranscript: replayTruncated },
      );
      this.sessions.set(sessionId, failed);
      this.saveAuthoritativeSession(failed);
      this.emitStructuredSnapshot(failed);
      this.emitStructuredSnapshot(failed, "ended");
      return;
    }

    const keepRunning = interruptedForQuestion || !!interruptPrompt;
    const messages = replayTruncated
      ? this.mergeTruncatedReplayTurn(current, processor, replayView, !keepRunning)
      : this.buildCompletedAssistantMessages(current, processor.state, false);
    const finished: SessionSnapshot = {
      ...current,
      status: keepRunning ? "running" : "idle",
      exitCode: keepRunning ? null : 0,
      endedAt: keepRunning ? null : new Date().toISOString(),
      // 日志被截断时 output 保留重启前的版本：replay 只覆盖尾部，用它反而丢掉前半段。
      output: replayTruncated ? current.output || processor.state.result : processor.state.result,
      claudeSessionId: processor.state.sessionId ?? current.claudeSessionId,
      messages,
      queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...this.settleTurn(sessionId, current.structuredState as StructuredSessionState),
        model: processor.state.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
        phase: undefined,
      },
    };
    this.sessions.set(sessionId, finished);
    this.saveAuthoritativeSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");

    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      this.preserveQueueOnInterrupt.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((error) => {
          console.error("[WAND] recovered interrupt-and-send failed:", error);
        });
      });
    } else if ((finished.queuedMessages?.length ?? 0) > 0) {
      setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
    }
  }

  private trackStreamEmitTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
    this.streamEmitTimers.add(timer);
    return timer;
  }

  private clearStreamEmitTimer(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.streamEmitTimers.delete(timer);
  }

  /** Mark streaming payload dirty and enforce both leading and trailing checkpoints. */
  private saveStreamingSnapshot(
    snapshot: SessionSnapshot,
    changed: Partial<StreamingCheckpointDirty> = { messages: true, output: true },
  ): void {
    if (this.disposed) return;
    const dirty = this.streamCheckpointDirty.get(snapshot.id) ?? { metadata: false, output: false, messages: false };
    if (changed.metadata) dirty.metadata = true;
    if (changed.output) dirty.output = true;
    if (changed.messages) dirty.messages = true;
    this.streamCheckpointDirty.set(snapshot.id, dirty);

    const now = Date.now();
    const last = this.lastStreamSaveAt.get(snapshot.id) ?? 0;
    const remaining = STREAM_SAVE_THROTTLE_MS - (now - last);
    if (remaining <= 0) {
      this.flushStreamingCheckpoint(snapshot.id);
      return;
    }
    if (this.streamCheckpointTimers.has(snapshot.id)) return;
    const timer = setTimeout(() => {
      this.streamCheckpointTimers.delete(snapshot.id);
      if (!this.disposed) this.flushStreamingCheckpoint(snapshot.id);
    }, remaining);
    timer.unref?.();
    this.streamCheckpointTimers.set(snapshot.id, timer);
  }

  private flushStreamingCheckpoint(sessionId: string): void {
    const timer = this.streamCheckpointTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.streamCheckpointTimers.delete(sessionId);
    }
    const dirty = this.streamCheckpointDirty.get(sessionId);
    const snapshot = this.sessions.get(sessionId);
    if (!dirty || !snapshot) {
      this.streamCheckpointDirty.delete(sessionId);
      return;
    }
    if (dirty.metadata) this.storage.updateSessionRuntimeMetadata(snapshot);
    if (dirty.messages) {
      this.storage.checkpointSessionMessages(
        sessionId,
        snapshot.messages ?? [],
        snapshot.structuredState,
        dirty.output ? snapshot.output : undefined,
      );
    } else if (dirty.output) {
      this.storage.checkpointSessionOutput(sessionId, snapshot.output);
    }
    this.streamCheckpointDirty.delete(sessionId);
    this.lastStreamSaveAt.set(sessionId, Date.now());
  }

  private clearStreamingCheckpoint(sessionId: string): void {
    this.cancelStreamingCheckpointTimer(sessionId);
    this.streamCheckpointDirty.delete(sessionId);
    this.lastStreamSaveAt.delete(sessionId);
  }

  private cancelStreamingCheckpointTimer(sessionId: string): void {
    const timer = this.streamCheckpointTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.streamCheckpointTimers.delete(sessionId);
  }

  private saveAuthoritativeSession(snapshot: SessionSnapshot): void {
    this.storage.saveSession(snapshot);
    this.clearStreamingCheckpoint(snapshot.id);
  }

  private checkpointSessionMessages(snapshot: SessionSnapshot, includeOutput = false): void {
    this.storage.updateSessionRuntimeMetadata(snapshot);
    this.storage.checkpointSessionMessages(
      snapshot.id,
      snapshot.messages ?? [],
      snapshot.structuredState,
      includeOutput ? snapshot.output : undefined,
    );
  }

  list(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .map(withSummary)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Return lightweight snapshots for the session list (no output/messages). */
  listSlim(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .map((s) => {
        const enriched = withSummary(s);
        const { output: _o, messages: _m, ...slim } = enriched;
        return { ...slim, output: "" } as SessionSnapshot;
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): SessionSnapshot | null {
    const s = this.sessions.get(id);
    return s ? withSummary(s) : null;
  }

  setSessionWorkspace(id: string, membership: Pick<SessionSnapshot, "workspaceId" | "workspaceTaskId">): void {
    const updated = { ...this.requireSession(id), ...membership };
    this.sessions.set(id, updated);
    this.emitStructuredSnapshot(updated);
  }

  setSessionTopic(id: string, title: string, description: string): SessionSnapshot {
    const current = this.requireSession(id);
    const updated: SessionSnapshot = { ...current, title, description, summary: description };
    this.sessions.set(id, updated);
    this.storage.updateSessionRuntimeMetadata({ ...updated, titleGenerating: undefined });
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** 归档会先停掉还在跑的回合，会话 ID 和 provider session id 都留着。 */
  setSessionArchived(id: string, archived: boolean): SessionSnapshot {
    const current = archived && this.requireSession(id).status === "running"
      ? this.stop(id)
      : this.requireSession(id);
    const archivedAt = archived ? new Date().toISOString() : null;
    const updated: SessionSnapshot = { ...current, archived, archivedAt };
    this.sessions.set(id, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId: id,
      data: { archived, archivedAt, sessionKind: "structured" },
    });
    return updated;
  }

  private setSessionTopicGenerating(id: string, titleGenerating: boolean): void {
    const current = this.sessions.get(id);
    if (!current || current.titleGenerating === titleGenerating) return;
    const updated = { ...current, titleGenerating };
    this.sessions.set(id, updated);
    this.emit({ type: "output", sessionId: id, data: { sessionKind: "structured", titleGenerating } });
  }

  /**
   * Update worktree merge progress on the canonical in-memory snapshot before
   * persisting it. A null result means this manager does not own the session.
   */
  setWorktreeMergeState(
    id: string,
    status: SessionSnapshot["worktreeMergeStatus"],
    info: SessionSnapshot["worktreeMergeInfo"],
  ): SessionSnapshot | null {
    const current = this.sessions.get(id);
    if (!current) return null;
    const updated: SessionSnapshot = {
      ...current,
      worktreeMergeStatus: status,
      worktreeMergeInfo: info ?? null,
    };
    this.sessions.set(id, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId: id,
      data: {
        sessionKind: "structured",
        worktreeMergeStatus: status,
        worktreeMergeInfo: updated.worktreeMergeInfo,
      },
    });
    return updated;
  }

  private maybeGenerateSessionTopic(id: string, input: string): void {
    const session = this.sessions.get(id);
    if (this.disposed || !session || !input.trim()) return;
    // 迭代提示词记录：和会话标题共用同一套「有没有信息量」判断，用户不用多做一步。
    recordIterationPrompt(this.storage, session, input, "session");
    const blockedTitles = sessionTopicBlocklistForSnapshot(session, this.storage);
    // CLI 自己起了名字就归它，模型标题与输入首行都不再覆盖；取不到原生标题才走系统硅基员工。
    const hasNativeTitle = this.nativeTitles.has(id);
    const provisional = provisionalSessionTopic(input, blockedTitles);
    if (
      provisional
      && !hasNativeTitle
      && shouldGenerateSessionTopicFromInput(input)
      && (session.title !== provisional.title || session.description !== provisional.description)
    ) {
      this.setSessionTopic(id, provisional.title, provisional.description);
    }
    this.topicCoordinator.request(id, {
      messages: session.messages,
      input,
      cwd: session.cwd,
      language: this.config.language,
      ai: resolveSystemAiContext(session, this.config, this.storage.getSystemSiliconEmployee()),
      readNativeTitle: () => readNativeSessionTitle(
        resolveSessionProvider(session),
        session.claudeSessionId,
        session.cwd,
      ),
      hasNativeTitle,
      onGenerating: (generating) => {
        if (!this.disposed) this.setSessionTopicGenerating(id, generating);
      },
      onTopic: ({ title, description, source }) => {
        if (this.disposed || !this.sessions.has(id)) return;
        if (source === "native") {
          this.applyNativeSessionTitle(id, title, blockedTitles);
          return;
        }
        if (this.nativeTitles.has(id)) return;
        if (shouldAcceptGeneratedSessionTitle(title, blockedTitles)) {
          this.setSessionTopic(id, title, description);
        }
      },
      onError: (error) => {
        console.error(`[StructuredSessionManager] Failed to generate session topic ${id}:`, getErrorMessage(error));
      },
    });
  }

  /** 原生标题优先于模型标题：只受「不能是任务名/目录名」约束，命中且变化时才落库。 */
  private applyNativeSessionTitle(id: string, title: string, blockedTitles: readonly string[]): void {
    this.nativeTitles.record(id, title);
    const current = this.sessions.get(id);
    if (!current || !shouldAcceptGeneratedSessionTitle(title, blockedTitles)) return;
    if (current.title === title && current.description === title) return;
    this.setSessionTopic(id, title, title);
  }

  createSession(options: CreateStructuredSessionOptions): SessionSnapshot {
    if (this.disposed) throw new Error("StructuredSessionManager has been disposed.");
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const requestedProvider: unknown = options.provider ?? "claude";
    if (!isSessionProvider(requestedProvider)) {
      throw new Error(`不支持的结构化 provider: ${String(requestedProvider)}`);
    }
    const provider: SessionProvider = requestedProvider;
    const runner = resolveStructuredRunner(provider, options.runner);
    const baseCwd = resolveSessionCwd(options.cwd, this.config.defaultCwd);
    const worktreeSetup = options.worktreeEnabled
      ? prepareSessionWorktree({ cwd: baseCwd, sessionId: id, spec: options.worktreeSpec })
      : null;
    const selectedModel = options.model?.trim() || null;
    const initialThinkingEffort = normalizeThinkingEffort(options.thinkingEffort);
    const autoCompaction = this.config.harness?.compaction?.enabled ?? true;
    // 员工 SDK 会话不静默继承用户的全局扩展，也不继承 CLI 专属的资源/CodeMode 默认。
    const sdkEmployeeSession = provider === "pi"
      && options.employeeCandidates?.[options.employeeCandidateIndex ?? 0]?.engine === "sdk";
    // CLI Pi 会话从「上次设置」起步：用户在任一 Pi 会话改过的自动选择 / CodeMode / 资源选择
    // 就是新会话的默认，不需要每开一个会话重配一次。autoCompaction 始终取当前配置。
    const rememberedPiSettings = provider === "pi" && !sdkEmployeeSession ? this.storage.getPiSessionDefaults() : null;
    const snapshot: SessionSnapshot = {
      id,
      // Pi 会话从创建起就带着自己的工具/功能安排：面板显示的设置与首轮真实启动参数必须一致。
      ...(provider === "pi" ? { piSettings: sdkEmployeeSession ? defaultPiSessionSettings(autoCompaction)
        : rememberedPiSettings ? { ...rememberedPiSettings, autoCompaction }
        : defaultPiCliSessionSettings(autoCompaction) } : {}),
      sessionKind: "structured",
      sessionSource: options.sessionSource ?? "interactive",
      title: options.title?.trim() || undefined,
      automationId: options.automationId,
      employeeId: options.employeeId,
      employeeName: options.employeeName,
      employeeAvatar: options.employeeAvatar,
      employeeCandidates: options.employeeCandidates,
      employeeCandidateIndex: options.employeeCandidateIndex,
      systemPrompt: options.systemPrompt?.trim() || null,
      workspaceId: options.workspaceId,
      workspaceTaskId: options.workspaceTaskId,
      provider,
      runner,
      command:
        provider === "codex"
          ? "codex exec --json"
          : provider === "opencode"
            ? "opencode run --format json"
          : provider === "grok"
            ? "grok -p --output-format streaming-json"
          : provider === "qoder"
            ? "qodercli -p --output-format stream-json"
          : provider === "pi"
            ? "pi --mode json --print"
          : provider === "gemini"
            ? "gemini -p --output-format stream-json"
          : runner === "claude-cli-print"
            ? "claude -p (stream-json)"
            : "claude -p --output-format stream-json",
      cwd: worktreeSetup?.cwd ?? baseCwd,
      mode: options.mode,
      worktreeEnabled: Boolean(worktreeSetup),
      worktree: worktreeSetup?.worktree ?? null,
      status: "idle",
      exitCode: null,
      startedAt,
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      claudeSessionId: options.claudeSessionId?.trim() || null,
      messages: [],
      queuedMessages: [],
      structuredState: {
        provider,
        runner,
        model: selectedModel ?? undefined,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
        // 新会话还没有回合在飞：锚点显式为 null，客户端不会看到「已运行 N 分钟」。
        turnStartedAt: null,
        lastActivityAt: null,
      },
      autoRecovered: false,
      autoApprovePermissions: shouldAutoApproveForMode(options.mode),
      approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
      selectedModel,
      thinkingEffort: initialThinkingEffort,
    };

    this.sessions.set(id, snapshot);
    this.storage.saveSession(snapshot);
    this.emit({ type: "started", sessionId: id, data: { sessionKind: "structured" } });

    return snapshot;
  }

  registerRelay(automationIdPrefix: string, handler: StructuredRelayHandler): void {
    this.relayHandlers.set(automationIdPrefix, handler);
  }

  private relayHandlerFor(session: SessionSnapshot): StructuredRelayHandler | null {
    const automationId = session.automationId ?? "";
    for (const [prefix, handler] of this.relayHandlers) {
      if (automationId.startsWith(prefix)) return handler;
    }
    return null;
  }

  createRelaySession(options: CreateStructuredSessionOptions & { automationId: string; title: string }): SessionSnapshot {
    const created = this.createSession(options);
    const titled: SessionSnapshot = { ...created, title: options.title };
    this.sessions.set(titled.id, titled);
    this.storage.saveSession(titled);
    this.emitStructuredSnapshot(titled);
    return titled;
  }

  /** Server-only generation anchor, including a failed unaccepted turn whose activeRequestId is cleared. */
  teamRequestId(id: string): string | null {
    if (this.disposed) return null;
    const session = this.sessions.get(id);
    if (!session?.automationId?.startsWith("ai-team:")) return null;
    const failed = this.unacceptedTeamStarts.get(id);
    return session.structuredState?.activeRequestId
      ?? (session.status === "failed" && !session.structuredState?.inFlight ? failed?.requestId ?? null : null);
  }

  /** Compatibility boolean API; typed consumers preserve the reason without parsing user-facing text. */
  consumeUnacceptedTeamStartup(id: string, requestId: string): boolean {
    return this.consumeUnacceptedTeamFailure(id, requestId) !== null;
  }

  /** Consume only the exact failed request observed by dispatch, once, before a newer request can replace it. */
  consumeUnacceptedTeamFailure(id: string, requestId: string): StructuredFailure | null {
    const fact = this.unacceptedTeamStarts.get(id);
    if (!fact || fact.requestId !== requestId) return null;
    this.unacceptedTeamStarts.delete(id);
    const session = this.sessions.get(id);
    return !this.disposed && session?.status === "failed"
      && !session.structuredState?.activeRequestId && !session.structuredState?.inFlight ? fact.failure : null;
  }

  private employeeCandidateModel(agent: WandTaskAgent): string | null {
    return agent.model === "default"
      ? defaultModelGroupSelector(this.config.modelGroups, agent.provider, getDefaultModelForProvider(this.config, agent.provider))
        || getDefaultModelForProvider(this.config, agent.provider) || null : agent.model;
  }

  /** Only an unstarted employee conversation may replay its explicitly rejected first input. */
  private retryEmployeeCandidate(
    id: string,
    original: SessionSnapshot,
    prompt: string,
    error: unknown,
  ): Promise<SessionSnapshot> | null {
    // Team runs own candidate scheduling; keep the snapshot without a second retry loop.
    if (original.automationId?.startsWith("ai-team:") || !(error instanceof UnacceptedStructuredInputError)) return null;
    const candidates = original.employeeCandidates ?? [];
    const index = original.employeeCandidateIndex ?? 0;
    const nextIndex = index + 1;
    if (!original.employeeId || (original.messages?.length ?? 0) !== 0 || original.claudeSessionId
      || !error.failure.retryable || nextIndex >= candidates.length) return null;
    const selected = candidates[index];
    // Explicit tool/model changes, including changes during the pending request, remain authoritative.
    if (!selected || original.provider !== selected.provider
      || (original.selectedModel && original.selectedModel !== this.employeeCandidateModel(selected))) return null;
    const current = this.sessions.get(id);
    if (!current || current.status !== "running" || current.provider !== original.provider
      || current.selectedModel !== original.selectedModel || current.mode !== original.mode
      || current.piSettings !== original.piSettings) return null;
    const next = candidates[nextIndex]!;
    const runner = resolveStructuredRunner(next.provider, undefined);
    const model = this.employeeCandidateModel(next);
    const sameTool = next.provider === original.provider && (next.engine ?? "cli") === (selected.engine ?? "cli");
    const piSettings = next.provider !== "pi" ? undefined : sameTool ? current.piSettings
      : next.engine === "sdk" ? defaultPiSessionSettings(this.config.harness?.compaction?.enabled ?? true)
      : { ...(this.storage.getPiSessionDefaults() ?? defaultPiCliSessionSettings()),
        autoCompaction: this.config.harness?.compaction?.enabled ?? true };
    const retry: SessionSnapshot = {
      ...current,
      provider: next.provider,
      runner,
      command: providerCliCommand(next.provider),
      mode: next.mode,
      autoApprovePermissions: shouldAutoApproveForMode(next.mode),
      selectedModel: model,
      thinkingEffort: next.thinkingEffort,
      employeeCandidateIndex: nextIndex,
      piSettings,
      claudeSessionId: null,
      harnessContext: undefined,
      harnessExtensionState: undefined,
      messages: [],
      output: "",
      status: "idle",
      exitCode: null,
      endedAt: null,
      structuredState: {
        ...defaultStructuredState(next.provider, runner),
        model: model ?? undefined,
      },
    };
    this.logger?.appendStructuredSpawn(id, { kind: "candidate-fallback", failureKind: error.failure.kind,
      fromProvider: original.provider, toProvider: next.provider, candidateIndex: nextIndex });
    this.sessions.set(id, retry);
    this.saveAuthoritativeSession(retry);
    // sendMessage publishes the new running snapshot synchronously; do not expose a transient idle slot.
    return this.sendMessage(id, prompt);
  }

  private throwUnacceptedInput(sessionId: string, result: StructuredRunnerResult, command: string, missingHint: string): void {
    const failure = result.failure ?? classifyStructuredFailure(result);
    if (!failure?.retryable || this.interruptedWith.has(sessionId)) return;
    const message = result.spawnError
      ? `${command} 启动失败：${result.spawnError.message}${result.spawnError.code === "ENOENT" ? missingHint : ""}`
      : result.primaryError?.trim() || `${command} 在执行前拒绝了输入。`;
    this.logger?.appendStructuredSpawn(sessionId, { kind: "structured-input-rejected", command,
      exitCode: result.exitCode, failureKind: failure.kind });
    throw new UnacceptedStructuredInputError(message, failure, result.state);
  }

  /** 往转发会话里追加别的参与者的发言。 */
  appendRelayTurns(id: string, turns: ConversationTurn[]): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session || turns.length === 0) return session ?? null;
    const createdAt = new Date().toISOString();
    const updated: SessionSnapshot = {
      ...session,
      messages: [
        ...(session.messages ?? []),
        ...turns.map((turn) => ({ ...turn, createdAt: turn.createdAt ?? createdAt })),
      ],
    };
    this.sessions.set(id, updated);
    this.storage.saveSession(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  async sendMessage(
    id: string,
    input: string,
    opts?: { interrupt?: boolean; idempotencyKey?: string; preserveQueue?: boolean; queueAlreadyRemoved?: boolean;
      teamRequestStarted?: (sessionId: string, requestId: string) => void },
  ): Promise<SessionSnapshot> {
    if (this.disposed) throw new Error("StructuredSessionManager has been disposed.");
    let session = this.requireSession(id);
    const prompt = input.trim();
    if (!prompt) return session;
    const relay = this.relayHandlerFor(session);
    if (relay) {
      // 群聊不起 CLI：先落下用户这句话，再交给转发方；转发失败以提示行告诉用户。
      const posted = this.appendRelayTurns(id, [{ role: "user", content: [{ type: "text", text: prompt }] }])!;
      try {
        await relay(id, prompt);
      } catch (error) {
        this.appendRelayTurns(id, [{
          role: "assistant", notice: true, content: [{ type: "text", text: `没能转达：${getErrorMessage(error)}` }],
        }]);
      }
      return this.sessions.get(id) ?? posted;
    }
    if (opts?.idempotencyKey) {
      const mapKey = `${id}:${opts.idempotencyKey}`;
      if (this.seenIdempotencyKeys.has(mapKey)) {
        const err = new Error("检测到重复发送，已拦截。") as Error & { code?: string };
        err.code = "duplicate_idempotency_key";
        throw err;
      }
      this.seenIdempotencyKeys.set(mapKey, Date.now());
      // 防止 map 无限增长：超过 1024 条时按时间裁掉一半最早的
      if (this.seenIdempotencyKeys.size > 1024) {
        const sorted = Array.from(this.seenIdempotencyKeys.entries()).sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < sorted.length / 2; i++) {
          this.seenIdempotencyKeys.delete(sorted[i][0]);
        }
      }
    }
    // Pi 主功能现在固定走 CLI；core SDK 重启 drain 不影响 CLI 会话入场。
    this.maybeGenerateSessionTopic(id, prompt);
    // 「智能分配」结算窗口：还没有 runner 归属，新输入先排队，不能另起一轮。
    if (this.autoAssignPending.has(id)) return this.enqueueInput(session, prompt);
    if (session.structuredState?.inFlight) {
      const runnerExecution = this.pendingRunnerExecutions.get(id);
      // interrupt() only requests cancellation; completion can settle later.
      // Treat runner-map ownership as the authoritative in-flight state.
      const childActive = Boolean(runnerExecution) || this.pendingRecoveryIds.includes(id);
      if (!childActive) {
        const recovered: SessionSnapshot = {
          ...session,
          status: "idle",
          endedAt: session.endedAt ?? new Date().toISOString(),
          structuredState: {
            ...this.settleTurn(id, session.structuredState as StructuredSessionState),
            inFlight: false,
            activeRequestId: null,
          },
        };
        this.sessions.set(id, recovered);
        this.storage.updateSessionRuntimeMetadata(recovered);
        session = recovered;
      } else if (opts?.interrupt) {
        this.requireRecoveryControl(id);
        this.interruptedWith.set(id, prompt);
        if (opts.preserveQueue) {
          this.preserveQueueOnInterrupt.add(id);
          // 「立即发送」排队条某一条：interrupt 把它作为新输入重发，但该条仍留在
          // queuedMessages 里。必须在这里把它从队列摘掉一次，否则 preserveQueue 会
          // 原样保留整条队列，待 interruptPrompt 跑完 flushNextQueuedMessage 会把它
          // 当成普通排队再发一遍（重复发送）。旧客户端没有走 promote endpoint，
          // 服务端只能按文本删第一处匹配；新客户端会带 queueAlreadyRemoved 跳过这里。
          if (!opts.queueAlreadyRemoved) {
            const queue = session.queuedMessages ?? [];
            const removeAt = queue.indexOf(prompt);
            if (removeAt !== -1) {
              const trimmedQueue = queue.slice(0, removeAt).concat(queue.slice(removeAt + 1));
              session = { ...session, queuedMessages: trimmedQueue };
              this.sessions.set(id, session);
              this.storage.updateSessionRuntimeMetadata(session);
              this.emitStructuredSnapshot(session);
            }
          }
        } else {
          this.preserveQueueOnInterrupt.delete(id);
        }
        runnerExecution?.interrupt();
        return session;
      } else {
        return this.enqueueInput(session, prompt);
      }
    }

    // 「智能分配」：只有真拿到这一轮提示词才能结算成本次使用的分组。结算后钉在会话上，
    // 后续轮次用同一个分组（不在会话中途换模型）；客户端选择器同步显示实际分组。
    if (isAutoAssignSelector(session.selectedModel)) {
      const token = { cancelled: false };
      this.autoAssignPending.set(id, token);
      let assigned: Awaited<ReturnType<typeof resolveAutoAssign>>;
      try {
        assigned = await resolveAutoAssign({
          provider: session.provider ?? "claude",
          prompt,
          groups: this.config.modelGroups,
          evaluate: this.autoAssignEvaluate(),
          ai: resolveSystemAiContext(session, this.config, this.storage.getSystemSiliconEmployee()),
          cwd: session.cwd,
          language: this.config.language,
        });
      } catch (error) {
        // 结算本身绝不阻断发送：拿不到结论就按默认分组继续。
        console.warn("[AutoAssign] 分配分组失败，改用默认分组:", getErrorMessage(error));
        assigned = { selector: "", group: null, strategy: "default", calls: 0 };
      } finally {
        if (this.autoAssignPending.get(id) === token) this.autoAssignPending.delete(id);
      }
      const latest = this.sessions.get(id);
      if (!latest || token.cancelled || this.disposed) return latest ?? session;
      session = latest;
      // 结算期间用户可能自己换了模型；那是更强的意愿，不覆盖。
      if (isAutoAssignSelector(session.selectedModel)) {
        const resolved: SessionSnapshot = {
          ...session,
          selectedModel: assigned.selector || null,
          structuredState: {
            ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
            ...(assigned.selector ? { model: assigned.selector } : {}),
          },
        };
        this.sessions.set(id, resolved);
        this.storage.updateSessionRuntimeMetadata(resolved);
        this.emit({
          type: "status",
          sessionId: id,
          data: { sessionKind: "structured", selectedModel: resolved.selectedModel, structuredState: resolved.structuredState },
        });
        session = resolved;
        if (assigned.group) {
          console.info(`[AutoAssign] ${id} → 分组「${assigned.group.name}」（${assigned.strategy}${assigned.probability === undefined ? "" : `, p=${assigned.probability.toFixed(2)}`}）`);
        }
      }
    }

    // 检测上一轮 assistant 是否有未配对的 AskUserQuestion tool_use（说明前一次
    // child 是被 SIGTERM 主动 kill 的，正在等用户回答）。如果有，把这次的输入打包
    // 成 tool_result 注入到 messages，让 UI 把卡片渲染为 answered。
    const pendingAsk = findUnpairedAskUserQuestion(session.messages ?? []);
    const userTurnAt = isoNow();
    const userTurn: ConversationTurn = pendingAsk
      ? {
          role: "user",
          createdAt: userTurnAt,
          content: [
            {
              type: "tool_result",
              tool_use_id: pendingAsk.id,
              content: prompt,
              is_error: false,
            },
          ],
        }
      : {
          role: "user",
          createdAt: userTurnAt,
          content: [{ type: "text", text: prompt }],
        };
    const requestId = randomUUID();
    this.unacceptedTeamStarts.delete(id);
    if ((session.provider === "pi" && isMissingPiSession(session.structuredState?.lastError, session.claudeSessionId))
      || (session.provider === "gemini" && isMissingGeminiSession(session.structuredState?.lastError))) {
      session = { ...session, claudeSessionId: null };
    }
    const updated: SessionSnapshot = {
      ...session,
      status: "running",
      exitCode: null,
      endedAt: null,
      messages: [...(session.messages ?? []), userTurn],
      structuredState: this.beginTurn(id, {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        inFlight: true,
        activeRequestId: requestId,
        lastError: null,
      }),
    };
    this.sessions.set(id, updated);
    if (updated.automationId?.startsWith("ai-team:")) opts?.teamRequestStarted?.(id, requestId);
    this.checkpointSessionMessages(updated);
    this.emitStructuredSnapshot(updated);
    this.emit({
      type: "status",
      sessionId: id,
      data: { status: "running", sessionKind: "structured", queuedMessages: updated.queuedMessages, structuredState: updated.structuredState },
    });

    // 续接 AskUserQuestion 的两条不同路线：
    //   - CLI runner (`claude -p`)：stdin 是 ignore，没有 tool_result 回传通道，
    //     只能把答案当作普通文本塞回去，靠提示词让 Claude 自己脑补"这是工具回答"。
    //   - SDK runner：streaming input mode 下 prompt 是 AsyncIterable，可以把
    //     用户答案直接 yield 成真正的 tool_result block，对 Claude 来说就是标准
    //     的工具结果，不需要任何 hack。runner 自己从 session.messages 末尾读取
    //     新加的 userTurn，所以传原始 prompt 即可。
    const cliClaudePrompt = pendingAsk
      ? `[对刚才 AskUserQuestion 工具的回答 — 结构化模式不支持工具结果回传，下面是用户从选项中的选择]\n${prompt}`
      : prompt;

    try {
      const provider = updated.provider ?? updated.structuredState?.provider ?? "claude";
      const runner = updated.runner ?? updated.structuredState?.runner;
      if (!isStructuredRunnerForProvider(provider, runner)) {
        throw new Error(`会话 runner ${String(runner)} 与 provider ${provider} 不匹配。`);
      }
      if (provider === "codex") {
        await this.runCodexStreaming(id, updated, prompt, requestId);
      } else if (provider === "opencode") {
        await this.runOpenCodeStreaming(id, updated, prompt, requestId);
      } else if (provider === "grok") {
        await this.runGrokStreaming(id, updated, prompt, requestId);
      } else if (provider === "qoder") {
        await this.runClaudeStreaming(id, updated, prompt, requestId, {
          runner: this.qoderRunner,
          provider: "qoder",
          commandLabel: "qodercli -p",
          logKind: "qoder-print",
          installHint: "请安装 @qoder-ai/qodercli，或重跑 `wand service:install` 刷新服务的 PATH",
        });
      } else if (provider === "pi") {
        const employeeAgent = updated.employeeCandidates?.[updated.employeeCandidateIndex ?? 0];
        const sdkRequested = employeeAgent?.engine === "sdk";
        // 对话框默认固定走 CLI；只有员工候选明确配置 SDK 时，员工会话才启用 core。
        const resolution = sdkRequested
          ? resolveHarnessEngineSync({ ...this.config.harness, engine: "core" }, "pi", {
            coreRunnerSupplied: this.coreRunnerSupplied,
          })
          : { engine: "cli" as const, reason: "Pi 主功能固定使用 CLI JSON" };
        const enginePatched: SessionSnapshot = {
          ...updated,
          structuredState: {
            ...(updated.structuredState as StructuredSessionState),
            engine: resolution.engine,
            engineReason: resolution.reason,
          },
        };
        this.sessions.set(id, enginePatched);
        if (resolution.engine === "core") {
          await this.runClaudeStreaming(id, enginePatched, prompt, requestId, {
            runner: this.coreRunner,
            provider: "pi",
            commandLabel: "pi core（员工 SDK）",
            logKind: "pi-core",
          });
        } else {
          await this.runClaudeStreaming(id, enginePatched, prompt, requestId, {
            runner: this.piRunner,
            provider: "pi",
            commandLabel: "pi --mode json --print",
            logKind: "pi-json",
            installHint: "请安装 @earendil-works/pi-coding-agent（或兼容的 Pi CLI），或重跑 `wand service:install` 刷新服务的 PATH",
          });
        }
      } else if (provider === "gemini") {
        await this.runClaudeStreaming(id, updated, prompt, requestId, {
          runner: this.geminiRunner,
          provider: "gemini",
          commandLabel: "gemini -p --output-format stream-json",
          logKind: "gemini-json",
          installHint: "请安装 @google/gemini-cli ≥ 0.11（`npm i -g @google/gemini-cli@latest`），或重跑 `wand service:install` 刷新服务的 PATH",
        });
      } else {
        await this.runClaudeStreaming(id, updated, cliClaudePrompt, requestId);
      }
      const finished = this.requireSession(id);
      return finished;
    } catch (error) {
      const message = getErrorMessage(error);
      // Close handlers use this tagged error after they have already persisted
      // the detailed failure. Re-throw even if an ended-event listener removed
      // the session synchronously; there is no request-id marker to leak.
      if (error instanceof PersistedStructuredRunnerError) throw error;
      const current = this.sessions.get(id);
      if (!current) throw error;
      // stop() or a newer turn may have invalidated this execution while its
      // runner was unwinding. A stale rejection must never fail the new turn.
      if (!this.isCurrentRequest(id, requestId)) {
        return current;
      }
      const retry = this.retryEmployeeCandidate(id, session, prompt, error);
      if (retry) return await retry;
      const failed: SessionSnapshot = error instanceof UnacceptedStructuredInputError
        ? this.finishStructuredFailure(current, 1, message, error.state)
        : {
          ...current,
          status: "failed",
          exitCode: 1,
          endedAt: new Date().toISOString(),
          pendingEscalation: null,
          permissionBlocked: false,
          structuredState: {
            ...this.settleTurn(id, current.structuredState as StructuredSessionState),
            inFlight: false,
            activeRequestId: null,
            lastError: message,
          },
        };
      this.sessions.set(id, failed);
      this.saveAuthoritativeSession(failed);
      if (!this.disposed && error instanceof UnacceptedStructuredInputError
        && current.automationId?.startsWith("ai-team:")) {
        // Available before status/ended listeners run. A later turn/stop/delete invalidates this fact.
        if (this.unacceptedTeamStarts.size >= 1024) {
          this.unacceptedTeamStarts.delete(this.unacceptedTeamStarts.keys().next().value!);
        }
        this.unacceptedTeamStarts.set(id, { requestId, failure: error.failure });
      }
      this.emit({
        type: "status",
        sessionId: id,
        data: { status: failed.status, error: message, sessionKind: "structured", queuedMessages: failed.queuedMessages, structuredState: failed.structuredState },
      });
      this.emitStructuredSnapshot(failed, "ended");
      throw error;
    }
  }

  /**
   * Reorder the pending queued messages. `order` is a permutation of the current
   * indices, e.g. `[2, 0, 1]` means "move the third queued message to the front,
   * push the original first to position #2". Throws if the permutation is
   * malformed (length mismatch / duplicate / out-of-range). 不允许在 inFlight
   * 期间改"已经被 flushNextQueuedMessage 拿走的队首"，但本方法只动 queue 数组
   * 本身，flushNext 在另一段时序里读 sessions.get(...) 当前快照，已经天然安全。
   */
  reorderQueuedMessages(sessionId: string, order: number[]): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const queue = session.queuedMessages ?? [];
    if (!Array.isArray(order) || order.length !== queue.length) {
      throw new Error("排序长度与当前队列不一致，请刷新后重试。");
    }
    const seen = new Set<number>();
    for (const idx of order) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= queue.length || seen.has(idx)) {
        throw new Error("排序参数无效。");
      }
      seen.add(idx);
    }
    const reordered = order.map((idx) => queue[idx]);
    const updated: SessionSnapshot = {
      ...session,
      queuedMessages: reordered,
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** Edit only the pending item still identified by both index and original text. */
  editQueuedMessage(sessionId: string, index: number, expectedText: string, text: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const queue = session.queuedMessages ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= queue.length || queue[index] !== expectedText) {
      throw new Error("排队消息已变化，请刷新后重试。");
    }
    const trimmed = text.trim();
    if (!trimmed) throw new Error("排队消息不能为空。");
    const next = queue.slice();
    next[index] = trimmed;
    const updated = { ...session, queuedMessages: next };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** Remove a single queued message only while index and text still identify the same item. */
  deleteQueuedMessage(sessionId: string, index: number, expectedText?: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const queue = session.queuedMessages ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      throw new Error("队列中没有该条消息（可能已被处理）。");
    }
    if (expectedText !== undefined && queue[index] !== expectedText) {
      throw new Error("排队消息已变化，请按最新顺序重试。");
    }
    const next = queue.slice(0, index).concat(queue.slice(index + 1));
    const updated: SessionSnapshot = {
      ...session,
      queuedMessages: next,
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /**
   * Remove one queued message by index before sending it. Keeping this operation
   * on the server prevents clients from re-sending the text while the original
   * queue entry remains available for the automatic flush path.
   */
  async promoteQueuedMessage(
    sessionId: string,
    index: number,
    expectedText?: string,
    idempotencyKey?: string,
  ): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId);
    this.requireRecoveryControl(sessionId);
    if (idempotencyKey && this.seenIdempotencyKeys.has(`${sessionId}:${idempotencyKey}`)) {
      return session;
    }
    const queue = session.queuedMessages ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      throw new Error("队列中没有该条消息（可能已被处理）。");
    }
    if (expectedText !== undefined && queue[index] !== expectedText) {
      throw new Error("排队消息已变化，请按最新顺序重试。");
    }

    const prompt = queue[index];
    const remaining = queue.slice(0, index).concat(queue.slice(index + 1));
    const inFlight = session.status === "running" && session.structuredState?.inFlight === true;
    const updated: SessionSnapshot = {
      ...session,
      queuedMessages: remaining,
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);

    try {
      return await this.sendMessage(sessionId, prompt, {
        interrupt: inFlight,
        preserveQueue: inFlight,
        queueAlreadyRemoved: true,
        idempotencyKey,
      });
    } catch {
      // Once the item has been promoted it must not return to the queue: the
      // send path may have already persisted its user turn before a runner error.
      return this.requireSession(sessionId);
    }
  }

  /** Clear all queued messages. No-op when queue is already empty. */
  clearQueuedMessages(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (!session.queuedMessages || session.queuedMessages.length === 0) {
      return session;
    }
    const updated: SessionSnapshot = { ...session, queuedMessages: [] };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** 仅空白独立对话能改目录：不建替代会话、不迁移任务/worktree 或已接受的输入。 */
  setSessionDirectory(sessionId: string, cwd: string): SessionSnapshot {
    if (typeof cwd !== "string" || !cwd.trim()) throw new Error("请选择有效的运行目录。");
    const session = this.requireSession(sessionId);
    if (session.status !== "idle" || session.archived || session.structuredState?.inFlight ||
        this.pendingRunnerExecutions.has(sessionId) || session.claudeSessionId ||
        session.resumedFromSessionId || session.autoRecovered ||
        (session.messages?.length ?? 0) > 0 || (session.queuedMessages?.length ?? 0) > 0 ||
        session.automationId || (session.sessionSource && session.sessionSource !== "interactive") ||
        this.relayHandlerFor(session)) {
      throw new Error("只有尚未发送消息的新建空白对话可以更换运行目录。");
    }
    if (session.workspaceTaskId || session.worktreeEnabled || session.worktree) {
      throw new Error("任务或工作树会话必须保留原运行目录。");
    }
    const resolved = resolveSessionCwd(cwd, null);
    const workspaceId = this.storage.updateBlankSessionDirectory(sessionId, resolved);
    const updated = { ...session, cwd: resolved, workspaceId };
    this.sessions.set(sessionId, updated);
    this.emit({
      type: "status", sessionId,
      data: { sessionKind: "structured", cwd: resolved, workspaceId },
    });
    return updated;
  }

  /** 新建空白对话可原位换 CLI；接受过输入、恢复会话和自动化不跨 provider 搬历史。 */
  setSessionProvider(sessionId: string, provider: SessionProvider): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (!isSessionProvider(provider)) throw new Error("请选择有效的 CLI 工具。");
    if (session.status !== "idle" || session.archived || session.structuredState?.inFlight ||
        this.pendingRunnerExecutions.has(sessionId) || session.claudeSessionId ||
        (session.messages?.length ?? 0) > 0 || (session.queuedMessages?.length ?? 0) > 0 ||
        session.automationId || (session.sessionSource && session.sessionSource !== "interactive") ||
        this.relayHandlerFor(session)) {
      throw new Error("只有尚未发送消息的新建空白对话可以更换工具。");
    }
    if (session.provider === provider) return session;
    const candidates = session.employeeCandidates ?? [];
    const candidateIndex = candidates.findIndex((candidate) => candidate.provider === provider);
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    const runner = defaultStructuredRunner(provider);
    const model = candidate && candidate.model !== "default" ? candidate.model
      : defaultModelGroupSelector(this.config.modelGroups, provider, getDefaultModelForProvider(this.config, provider)) || getDefaultModelForProvider(this.config, provider) || null;
    const effort = normalizeThinkingEffort(candidate?.thinkingEffort ?? this.config.defaultThinkingEffort);
    const thinkingEffort = effort?.includes(":") && !effort.startsWith(`${provider}:`) ? "off" : effort;
    const requestedMode = candidate?.mode ?? session.mode;
    const unsupportedMode = (requestedMode === "native" && provider !== "claude") ||
      (requestedMode === "auto-edit" && ["opencode", "grok", "pi"].includes(provider));
    const mode: ExecutionMode = provider === "codex" ? "full-access"
      : unsupportedMode ? "default" : requestedMode;
    const updated: SessionSnapshot = {
      ...session,
      provider,
      runner,
      // 从别的 provider 切到 Pi 的空白会话与新建 Pi 会话同等：以「上次设置」起步。
      ...(provider === "pi" && !session.piSettings ? { piSettings: candidate?.engine === "sdk"
        ? defaultPiSessionSettings(this.config.harness?.compaction?.enabled ?? true)
        : { ...(this.storage.getPiSessionDefaults() ?? defaultPiCliSessionSettings(this.config.harness?.compaction?.enabled ?? true)),
          autoCompaction: this.config.harness?.compaction?.enabled ?? true } } : {}),
      command: recoveredCommandLabel(runner),
      mode,
      autoApprovePermissions: shouldAutoApproveForMode(mode),
      selectedModel: model,
      thinkingEffort,
      employeeCandidateIndex: candidateIndex >= 0 ? candidateIndex : undefined,
      structuredState: { ...defaultStructuredState(provider, runner), model: model ?? undefined },
    };
    // 身份、知识归属、任务/目录和候选快照不变；只更新本会话的执行参数。
    this.storage.saveSession(updated);
    this.sessions.set(sessionId, updated);
    this.emit({
      type: "status",
      sessionId,
      data: { ...(buildStructuredOutputPayload(updated) as Record<string, unknown>), command: updated.command,
        mode, autoApprovePermissions: updated.autoApprovePermissions },
    });
    return updated;
  }

  getPiSettings(sessionId: string): { settings: PiSessionSettings; resolution: EngineResolution } {
    const session = this.requireSession(sessionId);
    if (session.provider !== "pi") throw new Error("这些设置仅适用于 Pi 结构化会话。");
    const employeeAgent = session.employeeCandidates?.[session.employeeCandidateIndex ?? 0];
    const sdkRequested = employeeAgent?.engine === "sdk";
    let resolution: EngineResolution;
    if (sdkRequested) {
      try {
        resolution = resolveHarnessEngineSync({ ...this.config.harness, engine: "core" }, "pi", {
          coreRunnerSupplied: this.coreRunnerSupplied,
        });
      } catch (error) {
        resolution = { engine: "core", reason: getErrorMessage(error) };
      }
    } else {
      resolution = { engine: "cli", reason: "Pi 主功能固定使用 CLI JSON" };
    }
    const defaults = resolution.engine === "cli"
      ? defaultPiCliSessionSettings(this.config.harness?.compaction?.enabled ?? true)
      : defaultPiSessionSettings(this.config.harness?.compaction?.enabled ?? true);
    // Legacy sessions really use Pi discovery. Do not report a new empty selection as applied.
    if (!session.piSettings) delete defaults.resources;
    return { settings: session.piSettings ?? defaults, resolution };
  }

  /** Metadata-only, synchronous merge: active runs retain their captured settings, queued rounds see these. */
  setPiSettings(sessionId: string, patch: unknown): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (session.archived) throw new Error("请先恢复已归档的会话。");
    const { settings, resolution } = this.getPiSettings(sessionId);
    const updatedSettings = patchPiSessionSettings(settings, patch);
    if (resolution.engine === "core" && ((patch as Record<string, unknown>).resources !== undefined
      || (patch as Record<string, unknown>).codemodeOverride !== undefined
      || (patch as Record<string, unknown>).autoResources !== undefined
      || (patch as Record<string, unknown>).lockedSkills !== undefined)) {
      throw new Error("当前 SDK 候选尚不支持此会话级设置；没有改用全局资源或 CodeMode 配置。");
    }
    if (resolution.engine !== "core") {
      // 写入裁决与启动参数用同一套能力边界：表达不出的字段/取值不落库。
      const rejection = cliPiSettingsRejection(patch, updatedSettings);
      if (rejection) throw new Error(rejection);
    }
    // Automatic selection or skill locks need an explicit on/off boundary, not legacy discovery.
    if ((updatedSettings.autoResources || updatedSettings.lockedSkills?.length) && !updatedSettings.resources) {
      updatedSettings.resources = { skills: [], mcpServers: [] };
    }
    const updated = { ...session, piSettings: updatedSettings };
    // Do not publish a setting that did not reach durable storage.
    this.storage.updateSessionRuntimeMetadata(updated);
    // 记住这次设置：新建 Pi CLI 会话以它起步。SDK 会话表达不出资源/CodeMode，不写回默认。
    if (resolution.engine === "cli") this.storage.setPiSessionDefaults(updatedSettings);
    this.sessions.set(sessionId, updated);
    this.emit({ type: "status", sessionId, data: { sessionKind: "structured", piSettings: updated.piSettings } });
    return updated;
  }

  /** Update the selected model for a structured session. Takes effect on the next spawn. */
  setSessionModel(sessionId: string, model: string | null): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const normalized = model?.trim() || null;
    resolveModelGroupModels(this.config.modelGroups, session.provider ?? "claude", normalized, {
      preferDefault: !normalized || normalized === "default",
    });
    const updated: SessionSnapshot = {
      ...session,
      selectedModel: normalized,
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        model: normalized ?? undefined,
      },
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", selectedModel: normalized, structuredState: updated.structuredState },
    });
    return updated;
  }

  /**
   * Update the thinking-effort level for a structured session. Takes effect on
   * the next spawn / next message (SDK runner injects `thinking`, Claude CLI
   * runner passes `--effort`, codex runner overrides `model_reasoning_effort`).
   */
  setSessionThinkingEffort(
    sessionId: string,
    effort: SessionSnapshot["thinkingEffort"],
  ): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const normalized = normalizeThinkingEffort(effort);
    const updated: SessionSnapshot = {
      ...session,
      thinkingEffort: normalized,
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", thinkingEffort: normalized },
    });
    return updated;
  }

  /**
   * Switch the execution mode of a structured session mid-flight. Takes effect on
   * the next message/query — permission policy, append-system-prompt and CLI flags
   * are all re-derived from session.mode per turn. Mirrors setSessionModel; also
   * re-syncs autoApprovePermissions so the permission posture matches the new mode.
   */
  setSessionMode(sessionId: string, mode: ExecutionMode): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const autoApprove = shouldAutoApproveForMode(mode);
    const updated: SessionSnapshot = {
      ...session,
      mode,
      autoApprovePermissions: autoApprove,
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", mode, autoApprovePermissions: autoApprove },
    });
    return updated;
  }

  /** Toggle auto-approve for the session. */
  toggleAutoApprove(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const newVal = !session.autoApprovePermissions;
    if (newVal && session.pendingEscalation) {
      const resolved = this.resolveEscalation(sessionId, session.pendingEscalation.requestId, "approve_once");
      const updated: SessionSnapshot = { ...resolved, autoApprovePermissions: true };
      this.sessions.set(sessionId, updated);
      this.storage.updateSessionRuntimeMetadata(updated);
      this.emit({
        type: "status",
        sessionId,
        data: { sessionKind: "structured", autoApprovePermissions: true },
      });
      return updated;
    }
    const updated: SessionSnapshot = { ...session, autoApprovePermissions: newVal };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", autoApprovePermissions: newVal },
    });
    return updated;
  }

  approvePermission(sessionId: string): SessionSnapshot {
    const pending = this.requireSession(sessionId).pendingEscalation;
    if (!pending) throw new Error("当前会话没有待处理的授权请求。");
    return this.resolveEscalation(sessionId, pending.requestId, "approve_once");
  }

  denyPermission(sessionId: string): SessionSnapshot {
    const pending = this.requireSession(sessionId).pendingEscalation;
    if (!pending) throw new Error("当前会话没有待处理的授权请求。");
    return this.resolveEscalation(sessionId, pending.requestId, "deny");
  }

  /** Resolve a specific escalation by requestId. */
  resolveEscalation(sessionId: string, requestId: string, resolution: unknown): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const pending = session.pendingEscalation;
    if (!pending) {
      throw new Error("当前会话没有待处理的授权请求。");
    }
    if (pending.requestId !== requestId) {
      throw new Error("授权请求已失效，请刷新后重试。");
    }
    if (resolution !== "approve_once" && resolution !== "approve_turn" && resolution !== "deny") {
      throw new Error("resolution 必须是 approve_once、approve_turn 或 deny。");
    }
    const approved = resolution !== "deny";
    const scope = pending.scope;
    if (approved && scope) {
      this.incrementApprovalStats(session, scope);
    }
    const updated: SessionSnapshot = {
      ...session,
      pendingEscalation: null,
      permissionBlocked: false,
      lastEscalationResult: {
        requestId: pending.requestId,
        resolution,
        reason: approved ? "user_approved" : "user_denied",
      },
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { permissionBlocked: false, approvalStats: updated.approvalStats, sessionKind: "structured" },
    });
    return updated;
  }

  private requireRecoveryControl(id: string): void {
    if (this.pendingRecoveryIds.includes(id) && !this.pendingRunnerExecutions.has(id)) {
      throw new Error("正在恢复运行中的任务，请稍后重试控制操作；新消息仍可排队。");
    }
  }

  stop(id: string): SessionSnapshot {
    this.unacceptedTeamStarts.delete(id);
    const session = this.requireSession(id);
    this.requireRecoveryControl(id);
    // 结算中的智能分配还没有 runner：置位取消，结算回来后不得再启动。
    const pendingAssign = this.autoAssignPending.get(id);
    if (pendingAssign) {
      pendingAssign.cancelled = true;
      this.autoAssignPending.delete(id);
    }
    this.interruptedWith.delete(id);
    this.preserveQueueOnInterrupt.delete(id);
    // Clearing activeRequestId is the generation barrier: late data/close callbacks
    // from the cancelled runner can no longer mutate this session or a replacement turn.
    // 主动停止只是取消「当前回合」，结构化会话本身并没有结束——置为 idle 而非 stopped。
    // 这样前端不会进入"会话已结束/恢复会话"终止态，输入框保持可用，直接展示历史内容。
    const cancelled: SessionSnapshot = {
      ...session,
      messages: cancelPendingResourceSelection(session.messages),
      status: "idle",
      exitCode: null,
      endedAt: null,
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...this.settleTurn(id, session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        inFlight: false,
        activeRequestId: null,
        lastError: null,
      },
    };
    this.sessions.set(id, cancelled);

    const runnerExecution = this.pendingRunnerExecutions.get(id);
    if (runnerExecution) {
      runnerExecution.interrupt();
      this.releasePendingRunnerExecution(id, runnerExecution);
    }
    this.saveAuthoritativeSession(cancelled);
    // 仍发 "ended" 事件让各端停掉"回复中"指示 / 灵动岛，但携带的 status 是 idle。
    this.emitStructuredSnapshot(cancelled, "ended");
    return cancelled;
  }

  delete(id: string): void {
    this.unacceptedTeamStarts.delete(id);
    this.requireRecoveryControl(id);
    const pendingAssign = this.autoAssignPending.get(id);
    if (pendingAssign) {
      pendingAssign.cancelled = true;
      this.autoAssignPending.delete(id);
    }
    const runnerExecution = this.pendingRunnerExecutions.get(id);
    // Invalidate callback ownership before signalling the runner. Cancellation
    // can synchronously wake listeners in some adapter implementations.
    this.sessions.delete(id);
    if (runnerExecution) {
      runnerExecution.interrupt();
      this.releasePendingRunnerExecution(id, runnerExecution);
    }
    this.clearStreamingCheckpoint(id);
    // 会话被删除后迟到的回合回调必须失效，静默心跳也不能再给一个不存在的会话发事件。
    this.turnHeartbeat.cancel(id);
    this.interruptedWith.delete(id);
    this.preserveQueueOnInterrupt.delete(id);
    this.storage.deleteSession(id);
    this.logger?.deleteSession(id);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private requireSession(id: string): SessionSnapshot {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error("未找到该结构化会话。");
    }
    return session;
  }

  /** True only while this exact turn still owns the session's mutable state. */
  private isCurrentRequest(sessionId: string, requestId: string): boolean {
    return !this.disposed && this.sessions.get(sessionId)?.structuredState?.activeRequestId === requestId;
  }

  private currentSessionForRequest(sessionId: string, requestId: string): SessionSnapshot | null {
    if (!this.isCurrentRequest(sessionId, requestId)) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  /** Delete a handle only if it still belongs to the execution doing cleanup. */
  private releasePendingRunnerExecution(
    sessionId: string,
    execution: Pick<StructuredRunnerExecution, "interrupt">,
    forgetRun = true,
  ): boolean {
    if (this.pendingRunnerExecutions.get(sessionId) !== execution) return false;
    this.pendingRunnerExecutions.delete(sessionId);
    // A failed recovery attach must retain the daemon record for the next retry.
    if (forgetRun) this.execHost?.forgetRun(structuredRunId(sessionId));
    return true;
  }

  /**
   * 本轮开始：turnStartedAt / lastActivityAt 同时落下，并给这一轮挂上静默心跳。
   * 只在新回合（新 requestId）起点未知时调用；daemon 领养走 adoptTurn。
   */
  private beginTurn(sessionId: string, state: StructuredSessionState): StructuredSessionState {
    const at = isoNow();
    this.turnHeartbeat.observe(sessionId);
    return { ...state, turnStartedAt: at, lastActivityAt: at };
  }

  /**
   * 领养 daemon 里仍在飞的回合：起点是重启前那一轮的真实时刻，不能改写成重连时刻；
   * 锚点缺失（改动之前落库的历史数据）才退回现在。
   */
  private adoptTurn(sessionId: string, state: StructuredSessionState): StructuredSessionState {
    const at = isoNow();
    this.turnHeartbeat.observe(sessionId);
    return { ...state, turnStartedAt: state.turnStartedAt ?? at, lastActivityAt: at };
  }

  /**
   * 观测到本轮活动（输出 chunk / 状态变化）：只刷新 lastActivityAt 并重新计算静默窗口；
   * turnStartedAt 保持不变，客户端才算是「这一轮已经跑了多久」而不是「距离上一条输出多久」。
   */
  private noteTurnActivity(sessionId: string, state: StructuredSessionState): StructuredSessionState {
    this.turnHeartbeat.observe(sessionId);
    return { ...state, lastActivityAt: isoNow() };
  }

  /**
   * 本轮收敛：`inFlight` 清 false 的一切路径（结束 / 失败 / 停止 / 中断 / 重启降级 /
   * 候选降级）都必须走这里——两个锚点一起回 null，静默心跳立即 cancel。
   * 收敛后不存在任何「还在跑」的读数，客户端不需要再猜上一轮的锚点属于哪一轮。
   */
  private settleTurn(sessionId: string, state: StructuredSessionState): StructuredSessionState {
    this.turnHeartbeat.cancel(sessionId);
    return { ...state, turnStartedAt: null, lastActivityAt: null };
  }

  /**
   * 静默窗口到期：确认这一轮仍在飞才补发一次，payload 与一条普通 status 快照完全一致
   * （不带新字段、不开新事件类型）。返回值决定要不要再挂下一个窗口。
   */
  private publishQuietHeartbeat(sessionId: string): boolean {
    if (this.disposed) return false;
    const session = this.sessions.get(sessionId);
    if (session?.structuredState?.inFlight !== true) return false;
    // 停在权限 / 升级裁决上的回合不是在「安静地干活」：那一屏已经有 pendingEscalation
    // 这个显式指示，再广播「仍在运行」是错的。保留窗口（返回 true），但不发事件，
    // 等用户裁决后 runner 继续产出时会自然重新计时。
    if (session.pendingEscalation || session.permissionBlocked) return true;
    this.emit({
      type: "status",
      sessionId,
      data: {
        ...(buildStructuredOutputPayload(session) as Record<string, unknown>),
        status: session.status,
        exitCode: session.exitCode,
      },
    });
    return true;
  }

  private emitStructuredSnapshot(session: SessionSnapshot, eventType: "output" | "ended" = "output"): void {
    // 排队消息只通过 payload.queuedMessages 单独下发，由各端在消息卡片外的「排队条」
    // 里纵向渲染——绝不再把它们当成 __queued 占位 turn 混进 messages 消息流里，否则会
    // 和排队条重复显示（旧的「显示异常」根因）。
    const payload = buildStructuredOutputPayload(session) as Record<string, unknown>;
    const data = {
      ...payload,
      status: session.status,
      exitCode: session.exitCode,
    };
    this.emit({
      type: eventType,
      sessionId: session.id,
      data,
    });
  }

  private enqueueInput(session: SessionSnapshot, prompt: string): SessionSnapshot {
    if (isDuplicateStructuredQueueInput(session, prompt)) {
      const err = new Error("与上一条消息相同，已忽略，不会加入排队。") as Error & { code?: string };
      err.code = "duplicate_queued_message";
      throw err;
    }
    const queue = session.queuedMessages ?? [];
    if (queue.length >= 10) throw new Error("排队消息已满（最多 10 条），请等待当前消息处理完成。");
    const queued = { ...session, queuedMessages: [...queue, prompt] };
    this.sessions.set(session.id, queued);
    this.storage.updateSessionRuntimeMetadata(queued);
    this.emitStructuredSnapshot(queued);
    return queued;
  }

  private async flushNextQueuedMessage(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const current = this.sessions.get(sessionId);
    if (!current || (current.queuedMessages?.length ?? 0) === 0) {
      return;
    }
    if (current.structuredState?.inFlight) {
      return;
    }
    const [nextInput, ...restQueue] = current.queuedMessages ?? [];
    if (!nextInput) {
      return;
    }
    const nextSession: SessionSnapshot = {
      ...current,
      queuedMessages: restQueue,
    };
    this.sessions.set(sessionId, nextSession);
    this.storage.updateSessionRuntimeMetadata(nextSession);
    this.emitStructuredSnapshot(nextSession);
    try {
      await this.sendMessage(sessionId, nextInput);
    } catch (error) {
      console.error("[WAND] flushNextQueuedMessage failed:", error);
      // 发送失败时把消息放回队首，避免永久丢失
      const afterFail = this.sessions.get(sessionId);
      if (afterFail) {
        const rescued: SessionSnapshot = {
          ...afterFail,
          queuedMessages: [nextInput, ...(afterFail.queuedMessages ?? [])],
        };
        this.sessions.set(sessionId, rescued);
        this.storage.updateSessionRuntimeMetadata(rescued);
        this.emitStructuredSnapshot(rescued);
      }
    }
  }

  private emit(event: ProcessEvent): void {
    if (!this.disposed && this.emitEvent) {
      this.emitEvent(event);
    }
  }

  private incrementApprovalStats(session: SessionSnapshot, scope: EscalationScope): void {
    const prev = session.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 };
    const stats = { ...prev };
    if (scope === "run_command" || scope === "dangerous_shell") {
      stats.command++;
    } else if (scope === "write_file") {
      stats.file++;
    } else {
      stats.tool++;
    }
    stats.total++;
    session.approvalStats = stats;
  }

  // ---------------------------------------------------------------------------
  // Streaming codex exec --json execution
  // ---------------------------------------------------------------------------

  private async runCodexStreaming(
    sessionId: string,
    session: SessionSnapshot,
    prompt: string,
    requestId: string,
  ): Promise<void> {
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    const syncSnapshot = (turnState: StructuredRunnerTurnState): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const turn: ConversationTurn = {
        role: "assistant",
        content: this.compactContentBlocks([...turnState.blocks], turnState.result),
        usage: turnState.usage,
      };
      const messages = upsertAssistantMessage(current.messages, turn);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
        structuredState: this.noteTurnActivity(sessionId, {
          ...(current.structuredState as StructuredSessionState),
          model: turnState.model ?? current.structuredState?.model,
        }),
      };
      this.sessions.set(sessionId, patched);
      this.saveStreamingSnapshot(patched);
    };
    const flushEmit = (): void => {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      emitTimer = null;
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (current) {
        this.emit({
          type: "output",
          sessionId,
          data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}),
        });
      }
    };
    const scheduleEmit = (): void => {
      if (!emitTimer) {
        emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
      }
    };

    const execution = startEmployeeKnowledgeRunner(this.storage, this.codexRunner, {
      session,
      prompt,
      env: buildChildEnv(this.config.inheritEnv !== false),
    }, {
      isActive: () => this.isCurrentRequest(sessionId, requestId),
      onStdout: (text) => this.logger?.appendStructuredStdout(sessionId, text),
      onStderr: (text) => this.logger?.appendStructuredStderr(sessionId, text),
      onEvent: (event) => this.logger?.appendStreamEvent(sessionId, event),
      onUpdate: (turnState) => {
        syncSnapshot(turnState);
        scheduleEmit();
      },
    });
    this.pendingRunnerExecutions.set(sessionId, execution);
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "codex-exec",
      provider: "codex",
      pid: execution.pid,
      cwd: session.cwd,
      args: execution.args,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      threadId: session.claudeSessionId,
      spawnedAt: execution.spawnedAt,
    });

    let result;
    try {
      result = await execution.completion;
    } finally {
      const released = this.releasePendingRunnerExecution(sessionId, execution);
      if (released) this.cancelStreamingCheckpointTimer(sessionId);
    }
    if (!this.isCurrentRequest(sessionId, requestId)) {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      return;
    }
    flushEmit();

    this.throwUnacceptedInput(sessionId, result, "codex exec",
      "（PATH 中找不到 codex 可执行文件；请确认 codex 已安装，或重跑 `wand service:install` 刷新服务的 PATH）");

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "codex-exec-close",
      pid: execution.pid,
      spawnedAt: execution.spawnedAt,
      closedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      stderrTail: result.stderr.slice(-2048),
      codexErrors: result.errors,
      codexTurnFailed: result.primaryError,
    });
    const current = this.currentSessionForRequest(sessionId, requestId);
    if (!current) return;

    const interruptedByUser = this.interruptedWith.has(sessionId);
    const interruptPrompt = this.interruptedWith.get(sessionId);
    if ((result.primaryError || (result.exitCode !== 0 && result.exitCode !== null) || result.signal) && !interruptedByUser) {
      const errorText = this.formatStructuredExitError(
        "codex exec",
        result.exitCode,
        result.signal,
        { stderr: result.stderr, primary: result.primaryError, extras: result.errors },
      );
      const failed = this.finishStructuredFailure(
        current,
        typeof result.exitCode === "number" ? result.exitCode : 1,
        errorText,
        result.state,
      );
      this.sessions.set(sessionId, failed);
      this.saveAuthoritativeSession(failed);
      this.emitStructuredSnapshot(failed);
      this.emitStructuredSnapshot(failed, "ended");
      throw new PersistedStructuredRunnerError(errorText);
    }

    const messages = this.buildCompletedAssistantMessages(current, result.state);
    const keepRunning = !!interruptPrompt;
    const finished: SessionSnapshot = {
      ...current,
      status: keepRunning ? "running" : "idle",
      exitCode: keepRunning ? null : 0,
      endedAt: keepRunning ? null : new Date().toISOString(),
      output: result.state.result,
      claudeSessionId: result.state.sessionId ?? current.claudeSessionId,
      messages,
      queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...this.settleTurn(sessionId, current.structuredState as StructuredSessionState),
        model: result.state.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
      },
    };
    this.sessions.set(sessionId, finished);
    this.saveAuthoritativeSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");

    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      this.preserveQueueOnInterrupt.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((error) => {
          console.error("[WAND] codex interrupt-and-send failed:", error);
        });
      });
      return;
    }
    setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
  }

  private async runGrokStreaming(
    sessionId: string,
    session: SessionSnapshot,
    prompt: string,
    requestId: string,
  ): Promise<void> {
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    const syncSnapshot = (turnState: StructuredRunnerTurnState): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const turn: ConversationTurn = {
        role: "assistant",
        content: this.compactContentBlocks([...turnState.blocks], turnState.result),
        usage: turnState.usage,
      };
      const messages = upsertAssistantMessage(current.messages, turn);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
        // 每个 provider 帧都是本轮还在活动的证据：刷新 lastActivityAt 并重挂静默窗口。
        structuredState: this.noteTurnActivity(sessionId, current.structuredState as StructuredSessionState),
      };
      this.sessions.set(sessionId, patched);
      this.saveStreamingSnapshot(patched);
    };
    const flushEmit = (): void => {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      emitTimer = null;
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (current) this.emit({
        type: "output",
        sessionId,
        data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}),
      });
    };
    const scheduleEmit = (): void => {
      if (!emitTimer) emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
    };

    const execution = startEmployeeKnowledgeRunner(this.storage, this.grokRunner, {
      session,
      prompt,
      env: buildChildEnv(this.config.inheritEnv !== false),
    }, {
      isActive: () => this.isCurrentRequest(sessionId, requestId),
      onStdout: (text) => this.logger?.appendStructuredStdout(sessionId, text),
      onStderr: (text) => this.logger?.appendStructuredStderr(sessionId, text),
      onEvent: (event) => this.logger?.appendStreamEvent(sessionId, event),
      onUpdate: (turnState) => { syncSnapshot(turnState); scheduleEmit(); },
    });
    this.pendingRunnerExecutions.set(sessionId, execution);
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "grok-headless",
      provider: "grok",
      pid: execution.pid,
      cwd: session.cwd,
      args: execution.args,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      sessionId: session.claudeSessionId,
      spawnedAt: execution.spawnedAt,
    });

    let result;
    try {
      result = await execution.completion;
    } finally {
      const released = this.releasePendingRunnerExecution(sessionId, execution);
      if (released) this.cancelStreamingCheckpointTimer(sessionId);
    }
    if (!this.isCurrentRequest(sessionId, requestId)) {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      return;
    }
    flushEmit();
    this.throwUnacceptedInput(sessionId, result, "grok",
      "（PATH 中找不到 grok；请安装 Grok Build CLI，或重跑 `wand service:install` 刷新服务 PATH）");
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "grok-headless-close",
      pid: execution.pid,
      spawnedAt: execution.spawnedAt,
      closedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      stderrTail: result.stderr.slice(-2048),
      primaryError: result.primaryError,
    });
    const current = this.currentSessionForRequest(sessionId, requestId);
    if (!current) return;
    const interruptedByUser = this.interruptedWith.has(sessionId);
    const interruptPrompt = this.interruptedWith.get(sessionId);
    if ((result.primaryError || (result.exitCode !== 0 && result.exitCode !== null) || result.signal) && !interruptedByUser) {
      const errorText = this.formatStructuredExitError(
        "grok",
        result.exitCode,
        result.signal,
        { stderr: result.stderr, primary: result.primaryError },
      );
      const failed = this.finishStructuredFailure(
        current,
        typeof result.exitCode === "number" ? result.exitCode : 1,
        errorText,
        result.state,
      );
      this.sessions.set(sessionId, failed);
      this.saveAuthoritativeSession(failed);
      this.emitStructuredSnapshot(failed);
      this.emitStructuredSnapshot(failed, "ended");
      throw new PersistedStructuredRunnerError(errorText);
    }
    const messages = this.buildCompletedAssistantMessages(current, result.state);
    const keepRunning = !!interruptPrompt;
    const finished: SessionSnapshot = {
      ...current,
      status: keepRunning ? "running" : "idle",
      exitCode: keepRunning ? null : 0,
      endedAt: keepRunning ? null : new Date().toISOString(),
      output: result.state.result,
      claudeSessionId: result.state.sessionId ?? current.claudeSessionId,
      messages,
      queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...this.settleTurn(sessionId, current.structuredState as StructuredSessionState),
        model: result.state.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
      },
    };
    this.sessions.set(sessionId, finished);
    this.saveAuthoritativeSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");
    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      this.preserveQueueOnInterrupt.delete(sessionId);
      setImmediate(() => this.sendMessage(sessionId, interruptPrompt).catch((error) => {
        console.error("[WAND] grok interrupt-and-send failed:", error);
      }));
      return;
    }
    setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
  }

  private async runOpenCodeStreaming(
    sessionId: string,
    session: SessionSnapshot,
    prompt: string,
    requestId: string,
  ): Promise<void> {
    let emitTimer: ReturnType<typeof setTimeout> | null = null;

    const syncSnapshot = (turnState: StructuredRunnerTurnState): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const turn: ConversationTurn = {
        role: "assistant",
        content: this.compactContentBlocks([...turnState.blocks], turnState.result),
        usage: turnState.usage,
      };
      const messages = upsertAssistantMessage(current.messages, turn);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
        // 每个 provider 帧都是本轮还在活动的证据：刷新 lastActivityAt 并重挂静默窗口。
        structuredState: this.noteTurnActivity(sessionId, current.structuredState as StructuredSessionState),
      };
      this.sessions.set(sessionId, patched);
      this.saveStreamingSnapshot(patched);
    };
    const flushEmit = (): void => {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      emitTimer = null;
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (current) {
        this.emit({
          type: "output",
          sessionId,
          data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}),
        });
      }
    };
    const scheduleEmit = (): void => {
      if (!emitTimer) {
        emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
      }
    };

    const execution = startEmployeeKnowledgeRunner(this.storage, this.openCodeRunner, {
      session,
      prompt,
      env: buildChildEnv(this.config.inheritEnv !== false),
    }, {
      isActive: () => this.isCurrentRequest(sessionId, requestId),
      onStdout: (text) => this.logger?.appendStructuredStdout(sessionId, text),
      onStderr: (text) => this.logger?.appendStructuredStderr(sessionId, text),
      onEvent: (event) => this.logger?.appendStreamEvent(sessionId, event),
      onUpdate: (turnState) => {
        syncSnapshot(turnState);
        scheduleEmit();
      },
    });
    this.pendingRunnerExecutions.set(sessionId, execution);
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "opencode-run",
      provider: "opencode",
      pid: execution.pid,
      cwd: session.cwd,
      args: execution.args,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      sessionId: session.claudeSessionId,
      spawnedAt: execution.spawnedAt,
    });

    let result;
    try {
      result = await execution.completion;
    } finally {
      const released = this.releasePendingRunnerExecution(sessionId, execution);
      if (released) this.cancelStreamingCheckpointTimer(sessionId);
    }
    if (!this.isCurrentRequest(sessionId, requestId)) {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      return;
    }
    flushEmit();

    this.throwUnacceptedInput(sessionId, result, "opencode run",
      "（PATH 中找不到 opencode；请安装 opencode-ai，或重跑 `wand service:install` 刷新服务 PATH）");

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "opencode-run-close",
      pid: execution.pid,
      spawnedAt: execution.spawnedAt,
      closedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      stderrTail: result.stderr.slice(-2048),
      primaryError: result.primaryError,
    });
    const current = this.currentSessionForRequest(sessionId, requestId);
    if (!current) return;

    const interruptedByUser = this.interruptedWith.has(sessionId);
    const interruptPrompt = this.interruptedWith.get(sessionId);
    if ((result.primaryError || (result.exitCode !== 0 && result.exitCode !== null) || result.signal) && !interruptedByUser) {
      const legacyHint = /unknown command|unknown flag|No help topic for 'run'/i.test(result.stderr)
        ? "\n检测到旧版 OpenCode CLI；请卸载 0.0.x 旧包并安装 `opencode-ai@latest`。"
        : "";
      const errorText = this.formatStructuredExitError(
        "opencode run",
        result.exitCode,
        result.signal,
        { stderr: result.stderr, primary: result.primaryError },
      ) + legacyHint;
      const failed = this.finishStructuredFailure(
        current,
        typeof result.exitCode === "number" ? result.exitCode : 1,
        errorText,
        result.state,
      );
      this.sessions.set(sessionId, failed);
      this.saveAuthoritativeSession(failed);
      this.emitStructuredSnapshot(failed);
      this.emitStructuredSnapshot(failed, "ended");
      throw new PersistedStructuredRunnerError(errorText);
    }

    const messages = this.buildCompletedAssistantMessages(current, result.state);
    const keepRunning = !!interruptPrompt;
    const finished: SessionSnapshot = {
      ...current,
      status: keepRunning ? "running" : "idle",
      exitCode: keepRunning ? null : 0,
      endedAt: keepRunning ? null : new Date().toISOString(),
      output: result.state.result,
      claudeSessionId: result.state.sessionId ?? current.claudeSessionId,
      messages,
      queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...this.settleTurn(sessionId, current.structuredState as StructuredSessionState),
        model: result.state.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
      },
    };
    this.sessions.set(sessionId, finished);
    this.saveAuthoritativeSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");

    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      this.preserveQueueOnInterrupt.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((error) => {
          console.error("[WAND] opencode interrupt-and-send failed:", error);
        });
      });
      return;
    }
    setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
  }
  // ---------------------------------------------------------------------------
  // Streaming claude -p execution
  // ---------------------------------------------------------------------------

  /**
   * Spawn `claude -p --output-format stream-json` and parse NDJSON lines as
   * they arrive, emitting incremental WebSocket events so the UI can render
   * text / thinking / tool_use blocks in real-time.
   *
   * Permission handling:
   * - Non-root + full-access/managed: --permission-mode bypassPermissions
   * - Non-root + auto-edit: --permission-mode acceptEdits
   * - Root: --permission-mode acceptEdits + --allowedTools (extends approval
   *   outside CWD). stdin is always "ignore" — no ACP bidirectional control.
   */
  private async runClaudeStreaming(
    sessionId: string,
    session: SessionSnapshot,
    prompt: string,
    requestId: string,
    options: {
      runner?: StructuredRunnerAdapter;
      provider?: SessionProvider;
      commandLabel?: string;
      logKind?: string;
      installHint?: string;
    } = {},
  ): Promise<void> {
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    const syncSnapshot = (turnState: StructuredRunnerTurnState): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const hasAssistantContent = turnState.blocks.length > 0 || !!turnState.result || !!turnState.resourceSelection;
      let messages = [...(current.messages ?? [])];
      if (hasAssistantContent) {
        const turn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
          ...(turnState.resourceSelection ? { resourceSelection: turnState.resourceSelection } : {}),
        };
        messages = upsertAssistantMessage(current.messages, turn);
      }
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
        structuredState: this.noteTurnActivity(sessionId, {
          ...(current.structuredState as StructuredSessionState),
          model: turnState.model ?? current.structuredState?.model,
          phase: turnState.phase ?? current.structuredState?.phase,
        }),
      };
      this.sessions.set(sessionId, patched);
      this.saveStreamingSnapshot(patched, hasAssistantContent ? undefined : { metadata: true });
    };
    const flushEmit = (): void => {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      emitTimer = null;
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (current) {
        this.emit({
          type: "output",
          sessionId,
          data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}),
        });
      }
    };
    const scheduleEmit = (): void => {
      if (!emitTimer) emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
    };

    const runner = options.runner ?? this.claudeCliRunner;
    const provider = options.provider ?? "claude";
    const commandLabel = options.commandLabel ?? "claude -p";
    const logKind = options.logKind ?? "claude-print";
    const execution = startEmployeeKnowledgeRunner(this.storage, runner, {
      session,
      prompt,
      env: buildChildEnv(this.config.inheritEnv !== false),
    }, {
      isActive: () => this.isCurrentRequest(sessionId, requestId),
      onStdout: (text) => this.logger?.appendStructuredStdout(sessionId, text),
      onStderr: (text) => this.logger?.appendStructuredStderr(sessionId, text),
      onEvent: (event) => this.logger?.appendStreamEvent(sessionId, event),
      onUpdate: (turnState) => {
        syncSnapshot(turnState);
        scheduleEmit();
      },
    });
    this.pendingRunnerExecutions.set(sessionId, execution);
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: logKind,
      provider,
      pid: execution.pid,
      cwd: session.cwd,
      args: execution.args,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      claudeSessionId: session.claudeSessionId,
      spawnedAt: execution.spawnedAt,
    });

    let result;
    try {
      result = await execution.completion;
    } finally {
      const released = this.releasePendingRunnerExecution(sessionId, execution);
      if (released) this.cancelStreamingCheckpointTimer(sessionId);
    }
    if (!this.isCurrentRequest(sessionId, requestId)) {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      return;
    }
    flushEmit();

    this.throwUnacceptedInput(sessionId, result, commandLabel,
      `（PATH 中找不到 ${provider === "qoder" ? "qodercli" : provider === "gemini" ? "gemini" : provider === "pi" ? "pi" : "claude"} 可执行文件；${options.installHint ?? "请确认 claude 已安装，或重跑 `wand service:install` 刷新服务的 PATH"}）`);

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: `${logKind}-close`,
      pid: execution.pid,
      spawnedAt: execution.spawnedAt,
      closedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      stderrTail: result.stderr.slice(-2048),
    });
    const current = this.currentSessionForRequest(sessionId, requestId);
    if (!current) return;

    const interruptedByUser = this.interruptedWith.has(sessionId);
    const interruptedForQuestion = result.stopReason === "ask-user-question";
    const failedExit = (result.exitCode !== null && result.exitCode !== 0) || result.signal !== null;
    // A protocol failure remains a failure even if the CLI exits 0 or already produced work.
    // Earlier work is preserved below and must never be replayed on another candidate.
    const failure = result.failure ?? classifyStructuredFailure(result);
    if (failure && !interruptedByUser && !interruptedForQuestion) {
      const errorText = !failedExit && result.primaryError
        ? result.primaryError!.trim()
        : this.formatStructuredExitError(commandLabel, result.exitCode, result.signal, {
          stderr: result.stderr,
          stdoutTail: result.stdoutTail,
          primary: result.primaryError,
        });
      const failed = this.finishStructuredFailure(
        current,
        failedExit && typeof result.exitCode === "number" ? result.exitCode : 1,
        errorText,
        result.state,
      );
      if (provider === "pi" && isMissingPiSession(result.stderr, current.claudeSessionId)) {
        failed.claudeSessionId = null;
      }
      if (provider === "gemini" && isMissingGeminiSession(`${result.stderr}\n${errorText}`)) {
        failed.claudeSessionId = null;
      }
      this.sessions.set(sessionId, failed);
      this.saveAuthoritativeSession(failed);
      this.emitStructuredSnapshot(failed);
      this.emitStructuredSnapshot(failed, "ended");
      throw new PersistedStructuredRunnerError(errorText);
    }

    const messages = this.buildCompletedAssistantMessages(current, result.state);
    const interruptPrompt = this.interruptedWith.get(sessionId);
    const keepRunning = interruptedForQuestion || !!interruptPrompt;
    const finished: SessionSnapshot = {
      ...current,
      status: keepRunning ? "running" : "idle",
      exitCode: keepRunning ? null : 0,
      endedAt: keepRunning ? null : new Date().toISOString(),
      output: result.state.result,
      claudeSessionId: result.state.sessionId ?? current.claudeSessionId,
      messages,
      queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...this.settleTurn(sessionId, current.structuredState as StructuredSessionState),
        model: result.state.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
        phase: undefined,
        ...(result.state.contextUsage ? { contextUsage: result.state.contextUsage } : {}),
        // core 压缩状态：历史不删，只记录切点与摘要，下一轮按它重建模型上下文。
        ...(result.state.compaction
          ? { compactions: result.state.compaction.compactions, harnessContext: compactionToSessionContext(result.state.compaction) }
          : {}),
      },
      ...(result.state.compaction ? { harnessContext: compactionToSessionContext(result.state.compaction) } : {}),
      ...(result.state.harnessExtensionState ? { harnessExtensionState: result.state.harnessExtensionState } : {}),
    };
    this.sessions.set(sessionId, finished);
    this.saveAuthoritativeSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");

    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      this.preserveQueueOnInterrupt.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((error) => {
          console.error("[WAND] interrupt-and-send failed:", error);
        });
      });
      return;
    }
    if (interruptedForQuestion) {
      if ((finished.queuedMessages?.length ?? 0) > 0) {
        setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
      }
      return;
    }
    const lastToolUse = [...result.state.blocks].reverse().find(
      (block): block is ContentBlock & { type: "tool_use" } => block.type === "tool_use",
    );
    if (lastToolUse?.name === "ExitPlanMode" && result.state.sessionId) {
      setImmediate(() => {
        this.sendMessage(sessionId, "Plan approved. Proceed with the implementation.").catch((error) => {
          console.error("[WAND] Auto-continue after ExitPlanMode failed:", error);
        });
      });
      return;
    }
    setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
  }

  // ---------------------------------------------------------------------------
  // Parsing helpers (unchanged logic, extracted from previous implementation)
  // ---------------------------------------------------------------------------


  private compactContentBlocks(blocks: ContentBlock[], fallbackResult: string): ContentBlock[] {
    const compacted: ContentBlock[] = [];
    for (const block of blocks) {
      const previous = compacted[compacted.length - 1];
      if (
        previous
        && previous.type === "text"
        && block.type === "text"
        // 子 agent 边界不合并：父 assistant 的 text 与子 agent 的 text 必须保持独立，
        // 渲染层才能切段并给子 agent 单独发头像。同一 subagent 内部允许合并。
        && (previous.__subagent?.taskId ?? null) === (block.__subagent?.taskId ?? null)
      ) {
        // 用新对象替换 compacted 末尾，**不要**就地改 previous.text —— previous
        // 通常和调用方持有的 turnState.blocks 共享引用，原地 mutate 会让下次
        // syncSnapshot 把已合并的内容再合并一次，呈指数级复制。
        const merged: ContentBlock = { type: "text", text: `${previous.text}${block.text}` };
        if (previous.__subagent) merged.__subagent = previous.__subagent;
        compacted[compacted.length - 1] = merged;
        continue;
      }
      compacted.push(block);
    }

    if (compacted.length === 0) {
      return [{ type: "text", text: fallbackResult || "(无输出)" }];
    }

    const hasVisibleText = compacted.some((block) => block.type === "text" && block.text.trim().length > 0);
    if (!hasVisibleText && fallbackResult) {
      compacted.push({ type: "text", text: fallbackResult });
    }
    return compacted;
  }

  private buildCompletedAssistantMessages(
    current: SessionSnapshot,
    turnState: StreamingTurnState,
    stampNewTools = true,
  ): ConversationTurn[] {
    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: this.compactContentBlocks([...turnState.blocks], turnState.result),
      usage: turnState.usage,
      ...(turnState.resourceSelection ? { resourceSelection: turnState.resourceSelection } : {}),
    };
    return upsertAssistantMessage(current.messages, assistantTurn, true, stampNewTools);
  }

  /**
   * Rebuild the trailing assistant turn when the replayed log was truncated.
   *
   * 重启后在 daemon 里继续跑的 CLI，它的 stdout 只保留最后
   * STRUCTURED_RUN_LOG_MAX_CHARS 字符，所以 replay 出来的 turn 是「半截尾巴」：
   * 直接覆盖会丢掉重启前用户已经看到的全部输出。这里用与流式期间同一个
   * TruncatedReplayView（本地已存 turn + replay 新增段），保证收尾视图和前端
   * 中途看到的完全一致。
   */
  private mergeTruncatedReplayTurn(
    current: SessionSnapshot,
    processor: ReplayProcessor,
    view: TruncatedReplayView,
    complete: boolean,
  ): ConversationTurn[] {
    const turn: ConversationTurn = {
      role: "assistant",
      content: this.compactContentBlocks(view.content([...processor.state.blocks]), processor.state.result),
      usage: processor.state.usage,
    };
    return upsertAssistantMessage([...(current.messages ?? [])], turn, complete, false);
  }

  private resolveQueuedMessagesAfterInterrupt(
    sessionId: string,
    current: SessionSnapshot,
    interruptPrompt: string | undefined,
  ): string[] | undefined {
    if (interruptPrompt && !this.preserveQueueOnInterrupt.has(sessionId)) return [];
    return current.queuedMessages;
  }


  private normalizeToolResultContent(content: unknown): string | Array<{ type: string; [key: string]: unknown }> {
    return normalizeStructuredToolResultContent(content);
  }


  /**
   * 组装结构化 runner 退出失败时的可读错误字符串。
   *
   * 痛点：之前 claude -p / codex exec 异常退出只把"stderr.trim() || `... exited
   * with code N`"塞给 UI。如果 stderr 是空的，用户在前端只能看到 "EXIT 1" 这种
   * 没有任何上下文的串，根本不知道是网络错误、参数错误还是 binary 找不着。
   *
   * 这里固定把"provider + 退出码 / 信号"放在最前面，再把 stderr / NDJSON 错误
   * 事件 / 最后一段 stdout 之类的上下文跟在后面，方便定位。
   */
  private formatStructuredExitError(
    provider: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    options: {
      /** stderr 累积内容；空字符串也行。 */
      stderr?: string;
      /** 从 NDJSON 解析出的最关键的错误消息（codex turn.failed / claude system.error）。 */
      primary?: string | null;
      /** 备用错误条目（按时间顺序排列，取最后一条）。 */
      extras?: string[];
      /** 当 stderr / primary / extras 都空时的兜底 tail，比如最后一行 stdout。 */
      stdoutTail?: string;
    } = {},
  ): string {
    const head = signal
      ? `${provider} terminated by signal ${signal}${code !== null ? ` (code ${code})` : ""}`
      : code !== null
        ? `${provider} exited with code ${code}`
        : `${provider} exited (unknown status)`;

    const primary = options.primary?.trim();
    const stderrTrim = options.stderr?.trim() ?? "";
    const lastExtra = options.extras && options.extras.length > 0
      ? options.extras[options.extras.length - 1].trim()
      : "";
    const stdoutTail = options.stdoutTail?.trim() ?? "";

    // 选第一个非空的"详情"作为正文展示，剩下的不再追加避免太长。
    const detail = primary || lastExtra || stderrTrim || stdoutTail;
    if (!detail) return head;
    // 控制长度，避免大段 stderr 撑爆 UI；保留尾部信息（最近的更相关）。
    const trimmed = detail.length > 2048 ? `...${detail.slice(-2048)}` : detail;
    return `${head}\n${trimmed}`;
  }

  private finishStructuredFailure(
    current: SessionSnapshot,
    code: number,
    errorText: string,
    turnState: StreamingTurnState,
    options: { keepTranscript?: boolean } = {},
  ): SessionSnapshot {
    const failureTurn: ConversationTurn = {
      role: "assistant",
      content: [{ type: "text", text: `结构化会话执行失败：${errorText}` }],
      ...(turnState.resourceSelection ? { resourceSelection: turnState.resourceSelection } : {}),
    };
    // Keep actual work and append the failure, including protocol errors with process exit 0.
    // A truncated replay must retain its complete local checkpoint rather than rebuild from a tail.
    const msgs = options.keepTranscript
      ? appendNoticeTurn(current.messages, failureTurn)
      : hasStructuredExecutionProgress(turnState)
        ? appendNoticeTurn(this.buildCompletedAssistantMessages(current, turnState), failureTurn)
        : upsertAssistantMessage(current.messages, failureTurn, true);
    return {
      ...current,
      status: "failed",
      exitCode: code,
      endedAt: new Date().toISOString(),
      output: errorText,
      claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
      messages: msgs,
      pendingEscalation: null,
      permissionBlocked: false,
      ...(turnState.compaction ? { harnessContext: compactionToSessionContext(turnState.compaction) } : {}),
      ...(turnState.harnessExtensionState ? { harnessExtensionState: turnState.harnessExtensionState } : {}),
      structuredState: {
        ...this.settleTurn(current.id, current.structuredState as StructuredSessionState),
        model: turnState.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: errorText,
        phase: undefined,
      },
    };
  }


  /** Extract usage from an SDKResultSuccess message (sdk runner). */
  private extractSdkUsage(result: Record<string, unknown>): ConversationTurn["usage"] {
    const usage = result?.usage as Record<string, unknown> | undefined;
    const value = {
      inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
      cacheReadInputTokens: typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
      cacheCreationInputTokens: typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
      totalCostUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    };
    if (Object.values(value).every(v => v === undefined)) return undefined;
    return value;
  }

}
