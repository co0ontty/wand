import { type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { isAutoAssignSelector, resolveModelGroupModels } from "./model-groups.js";
import { resolveAutoAssign } from "./model-auto-assign.js";
import { withModelGroups } from "./model-group-runner.js";
import { classifyStructuredFailure, hasStructuredExecutionProgress, type StructuredFailure } from "./structured-failure.js";
import { withAutomaticPiResources } from "./pi-auto-resources.js";
import { randomUUID } from "node:crypto";

import { prepareSessionWorktree, type WorktreeSetupSpec } from "./git-worktree.js";

import { SessionLogger } from "./session-logger.js";
import { BoundedKeySet } from "./structured-bounded-keys.js";
import { WandStorage } from "./storage.js";
import { ContentBlock, ConversationTurn, EscalationScope, ExecutionMode, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, SessionSource, StructuredSessionState, WandConfig } from "./types.js";


import { buildChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";

import { fallbackProviderModel } from "./session-model.js";
import { isLocalDecisionModel } from "./decision-expert-identity.js";
import type { WandTaskAgent } from "./task-types.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import { recordIterationPrompt } from "./iteration-log.js";
import { startEmployeeKnowledgeRunner } from "./employee-knowledge.js";
import { CoreRunner } from "./core-runner.js";
import { CoreTurnTracker } from "./core-turn-tracker.js";
import type { CoreStatus } from "./core-status-cli.js";
import { coreHarnessAgentDir, resolveHarnessEngine, resolveHarnessEngineSync, type EngineResolution } from "./harness-engine.js";
import { cliPiSettingsRejection, defaultPiCliSessionSettings, defaultPiSessionSettings, patchPiSessionSettings, type PiSessionSettings } from "./pi-session-settings.js";
import { withDecisionAccess, type DecisionRuntimeAccess } from "./decision-runner.js";
import { signalNameFromNumber } from "./signal-utils.js";
import { SessionNativeTitleTracker, SessionTopicCoordinator } from "./session-topic.js";
import { SessionMetadataService } from "./session-metadata-service.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { isScheduledConversationSession } from "./conversation-session-preview.js";
import { isSessionProvider, providerCliCommand } from "./session-provider.js";
import { resolveSystemAiContext } from "./session-ai-context.js";

import { CodexRunner } from "./structured-codex-adapter.js";

import { ClaudeCliRunner } from "./structured-claude-adapter.js";


import { OpenCodeRunner } from "./structured-opencode-adapter.js";
import { GrokRunner } from "./structured-grok-adapter.js";
import { QoderRunner } from "./structured-qoder-adapter.js";
import { PiRunner, isMissingPiSession } from "./structured-pi-adapter.js";
import { PiOutputFile, type PiOutputFileOptions } from "./pi-output-file.js";
import { PiProtocolReader } from "./pi-protocol-reader.js";
import { PiTmuxHost } from "./pi-tmux-host.js";
import { GeminiRunner, isMissingGeminiSession } from "./structured-gemini-adapter.js";
import { structuredRunId, type StructuredExecHost, type StructuredRunState } from "./structured-exec-host.js";
import type { StructuredRunnerAdapter, StructuredRunnerExecution, StructuredRunnerResult, StructuredRunnerTurnState } from "./structured-runner.js";
import { defaultStructuredRunner, defaultStructuredState, isStructuredRunnerForProvider, normalizeThinkingEffort, resolveStructuredRunner } from "./structured-provider-common.js";
import { TurnQuietHeartbeat } from "./turn-heartbeat.js";

import { logInfo } from "./runtime-log.js";


import { ReplayProcessor, StreamingCheckpointDirty, TruncatedReplayView, appendNoticeTurn, buildIncrementalStructuredPayload, buildReplayProcessor, buildStructuredOutputPayload, cancelPendingResourceSelection, compactionToSessionContext, findUnpairedAskUserQuestion, isDuplicateStructuredQueueInput, isoNow, recoveredCommandLabel, shouldAutoApproveForMode, structuredQuietStatusData, upsertAssistantMessage, withSummary } from "./structured-session-manager-replay.js";

// Public helpers moved to the replay module; re-exported so existing importers keep working.
export { structuredQuietStatusData, getLastSubmittedStructuredInput, isDuplicateStructuredQueueInput } from "./structured-session-manager-replay.js";
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
  /**
   * 已裁决的执行引擎；只对 pi 结构化会话有意义。
   * `core` = Wand Agent（进程内 SDK harness），`cli` = Pi CLI。
   * 调用方（新建会话路由）负责先裁决可用性，这里只负责落库与后续回合沿用。
   */
  engine?: "core" | "cli";
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
const STREAM_EMIT_DEBOUNCE_MS = 16;

/**
 * 员工候选链的启动看门狗：CLI 进程起来后这么久没有任何协议事件，就认定这一候选本轮没有开始
 * 执行（无输出、无用量、无工具调用），按未接受输入处理并沿候选链降级，而不是让会话无限停在
 * 「运行中」。取 3 分钟：慢模型的首个事件与真正卡死之间留出足够余量。
 */
const EMPLOYEE_CANDIDATE_STARTUP_TIMEOUT_MS = 180_000;
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
/** Upper bound on remembered (session, idempotency key) pairs; oldest half is dropped past it. */
const IDEMPOTENCY_KEY_LIMIT = 1024;


/** The turn recorded for one user prompt; an open AskUserQuestion is answered by it as a tool_result. */
function buildUserTurn(
  prompt: string,
  pendingAsk: { id: string } | null | undefined,
  createdAt: string,
): ConversationTurn {
  if (pendingAsk) {
    return {
      role: "user",
      createdAt,
      content: [{ type: "tool_result", tool_use_id: pendingAsk.id, content: prompt, is_error: false }],
    };
  }
  return { role: "user", createdAt, content: [{ type: "text", text: prompt }] };
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
  private readonly seenIdempotencyKeys = new BoundedKeySet(IDEMPOTENCY_KEY_LIMIT);
  private readonly relayHandlers = new Map<string, StructuredRelayHandler>();
  private emitEvent: ((event: ProcessEvent) => void) | null = null;
  /**
   * 静默期心跳：回合在飞且连续 TURN_QUIET_HEARTBEAT_MS 没有任何事件时，用现有的
   * status 事件重发一次权威快照（含最新 turn 锚点）。timer 只在 inFlight 期间存在。
   */
  private readonly turnHeartbeat = new TurnQuietHeartbeat((sessionId) => this.publishQuietHeartbeat(sessionId));
  private readonly topicCoordinator = new SessionTopicCoordinator();
  private readonly nativeTitles = new SessionNativeTitleTracker();
  /** Topic/native-title policy shared with the PTY manager; see SessionMetadataService. */
  private readonly metadata: SessionMetadataService;
  private readonly streamEmitTimers = new Set<NodeJS.Timeout>();
  /** 员工候选链的「本轮还没开始执行」看门狗，按会话一个；首个协议事件或回合收敛即撤销。 */
  private readonly candidateStartupWatchdogs = new Map<string, NodeJS.Timeout>();
  private readonly claudeCliRunner: StructuredRunnerAdapter;
  private readonly codexRunner: StructuredRunnerAdapter;
  private readonly openCodeRunner: StructuredRunnerAdapter;
  private readonly grokRunner: StructuredRunnerAdapter;
  private readonly qoderRunner: StructuredRunnerAdapter;
  private readonly piRunner: StructuredRunnerAdapter;
  /** 进程内 core 引擎供员工候选显式启用；普通 Pi 主功能不使用它。 */
  private readonly coreRunner: StructuredRunnerAdapter;
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
    private readonly openRouter?: OpenRouterFreeModelsService,
    /** 「智能分配」专用的本地决策入口：只有真正能跑时才注入，没注入则用系统员工回退。 */
    private readonly autoAssignEvaluate: () => DecisionRuntimeAccess["evaluate"] = () => undefined,
  ) {
    if (logger && execHost?.persistent && !runners.pi && process.env.WAND_PI_NATIVE_TMUX !== "0"
      && process.env.WAND_TEST_MODE !== "1" && !process.env.NODE_TEST_CONTEXT) {
      this.execHost = new PiTmuxHost(logger.getConfigDirectory(), execHost);
    }
    const wrap = (runner: StructuredRunnerAdapter): StructuredRunnerAdapter =>
      withModelGroups(withDecisionAccess(runner, storage, decisionRuntime), config);
    this.claudeCliRunner = wrap(runners.claudeCli ?? new ClaudeCliRunner({ language: () => this.config.language }, this.execHost));
    this.codexRunner = wrap(runners.codex ?? new CodexRunner(undefined, this.execHost));
    this.openCodeRunner = wrap(runners.opencode ?? new OpenCodeRunner(undefined, this.execHost));
    this.grokRunner = wrap(runners.grok ?? new GrokRunner(undefined, this.execHost));
    this.qoderRunner = wrap(runners.qoder ?? new QoderRunner(undefined, this.execHost));
    this.piRunner = wrap(withAutomaticPiResources(
      runners.pi ?? new PiRunner(undefined, this.execHost, coreHarnessAgentDir(config.harness),
        openRouter ? { storage, service: openRouter } : undefined,
        (id) => this.piOutputFileOptions(id)), config,
      { evaluate: () => this.decisionRuntime()?.evaluate }));
    this.coreRunner = withModelGroups(runners.core ?? new CoreRunner({ config: this.config,
      decisionAccess: decisionRuntime, openRouter }), config);
    this.coreRunnerSupplied = runners.core !== undefined;
    this.geminiRunner = wrap(runners.gemini ?? new GeminiRunner(undefined, this.execHost));
    this.metadata = new SessionMetadataService({
      isDisposed: () => this.disposed,
      current: (id) => this.sessions.get(id),
      messagesOf: (snapshot) => snapshot.messages,
      commitTopic: (id, title, description) => { this.setSessionTopic(id, title, description); },
      commitTopicGenerating: (id, generating) => this.setSessionTopicGenerating(id, generating),
      topicCoordinator: () => this.topicCoordinator,
      nativeTitles: () => this.nativeTitles,
    }, {
      logPrefix: "[StructuredSessionManager]",
      config,
      storage,
      free: openRouter,
    });
    // SDK capability is probed only when Wand Agent is explicitly selected.
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

    for (const [, execution] of this.pendingRunnerExecutions) {
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
    for (const timer of this.candidateStartupWatchdogs.values()) clearTimeout(timer);
    this.candidateStartupWatchdogs.clear();
    for (const id of this.sessions.keys()) this.disposeSession(id, "session");
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
        logInfo(`structured run recovery waiting for terminal daemon: ${getErrorMessage(error)}`);
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

  private piOutputFileOptions(sessionId: string): PiOutputFileOptions {
    return {
      ...(this.logger ? { directory: this.logger.protocolDirectory(sessionId) } : {}),
      onCreated: (file) => this.logger?.appendStructuredSpawn(sessionId, { kind: "pi-file-source", file }),
    };
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
    logInfo(`resuming structured run for session ${sessionId} (daemon pid ${initialState.pid})`);
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
    const piReader = resumed.provider === "pi" && resumed.structuredState?.engine !== "core"
      ? new PiProtocolReader(feedLine, { truncatedHead: initialState.stdoutTruncated }) : null;
    const feedDelta = (text: string): void => {
      if (piReader) { piReader.push(text); return; }
      carry += text;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) feedLine(line);
    };
    let carry = "";

    let stdoutFile: PiOutputFile | null = null;
    let fileFailed = false;
    const fileFailure = (error: Error): void => {
      if (fileFailed) return;
      fileFailed = true;
      stdoutFile?.dispose();
      processor.primaryError = `Pi 实时事件文件读写失败：${error.message}；送达结果未知，不自动重试。`;
      this.finalizeRecoveredRun(sessionId, requestId, processor, replayView, {
        exitCode: 1, signal: null, stderr: processor.stderr, stdoutTruncated: true,
      });
      flushEmit();
    };
    const captureStdout = (text: string): void => {
      if (fileFailed) return;
      try {
        if (!stdoutFile) { feedDelta(text); return; }
        stdoutFile.append(text); stdoutFile.drain();
      }
      catch (error) { fileFailure(error instanceof Error ? error : new Error(String(error))); }
    };
    if (resumed.provider === "pi" && resumed.structuredState?.engine !== "core" && !initialState.nativeFile) {
      try {
        stdoutFile = new PiOutputFile(this.piOutputFileOptions(sessionId),
          () => this.isCurrentRequest(sessionId, requestId), feedDelta, fileFailure);
      } catch (error) {
        fileFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    const finishProtocol = (): void => {
      if (piReader) piReader.finish();
      else if (carry.trim()) feedLine(carry);
      carry = "";
    };
    const feedFullLog = (): void => {
      if (stdoutFile || piReader) {
        try {
          captureStdout(initialState.stdoutLog);
          if (!fileFailed) finishProtocol();
        } catch (error) { fileFailure(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      const log = initialState.stdoutLog;
      const lines = log.split("\n");
      const tail = lines.pop() ?? "";
      for (const line of lines) feedLine(line);
      if (tail.trim()) feedLine(tail);
    };

    if (initialState.status === "exited") {
      feedFullLog();
      stdoutFile?.dispose();
      if (fileFailed) return;
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
    if (stdoutFile || piReader) {
      captureStdout(initialState.stdoutLog);
      if (fileFailed) return;
    } else {
      const lines = initialState.stdoutLog.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) feedLine(line);
    }
    try {
      runningHandle = await this.execHost.adoptRun(structuredRunId(sessionId));
    } catch (error) {
      stdoutFile?.dispose();
      this.releasePendingRunnerExecution(sessionId, execution, false);
      throw error;
    }
    // Server shutdown detaches persistent runs; only an explicit stop/delete
    // should cancel a handle that arrived after its request was invalidated.
    if (this.disposed) { stdoutFile?.dispose(); return; }
    if (!this.isCurrentRequest(sessionId, requestId)) {
      stdoutFile?.dispose();
      runningHandle?.interrupt();
      this.releasePendingRunnerExecution(sessionId, execution);
      return;
    }
    if (!runningHandle) {
      stdoutFile?.dispose();
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
        captureStdout(event.data);
        return;
      }
      if (event.seq <= lastStderrSeq) return;
      lastStderrSeq = event.seq;
      this.logger?.appendStructuredStderr(sessionId, event.data);
      processor.stderr += event.data;
    });
    runningHandle.onExit((event) => {
      if (fileFailed) return;
      try { stdoutFile?.drain(); finishProtocol(); }
      catch (error) { fileFailure(error instanceof Error ? error : new Error(String(error))); return; }
      stdoutFile?.dispose();
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

  /**
   * Per-session teardown of timers and transient bookkeeping.
   * "run" (stop): the session stays resumable, so duplicate-submit keys, the
   * unaccepted-start record and the message-persistence state survive.
   * "session" (delete, and dispose for each live session): forgets everything kept for the id.
   */
  private disposeSession(sessionId: string, scope: "run" | "session"): void {
    const pendingAssign = this.autoAssignPending.get(sessionId);
    if (pendingAssign) {
      pendingAssign.cancelled = true;
      this.autoAssignPending.delete(sessionId);
    }
    this.interruptedWith.delete(sessionId);
    this.preserveQueueOnInterrupt.delete(sessionId);
    this.clearStreamingCheckpoint(sessionId);
    this.disarmCandidateStartupWatchdog(sessionId);
    this.turnHeartbeat.cancel(sessionId);
    if (scope === "run") return;
    this.unacceptedTeamStarts.delete(sessionId);
    const keyPrefix = `${sessionId}:`;
    this.seenIdempotencyKeys.deleteMatching((key) => key.startsWith(keyPrefix));
  }

  /**
   * Arms the per-session "no protocol output yet" watchdog. It is unref'd so it can
   * never keep the process alive, and it is registered so stop/delete/dispose and
   * settlement can cancel it through disarmCandidateStartupWatchdog.
   */
  private armCandidateStartupWatchdog(sessionId: string, onTimeout: () => void): void {
    this.disarmCandidateStartupWatchdog(sessionId);
    const timer = setTimeout(() => {
      this.candidateStartupWatchdogs.delete(sessionId);
      onTimeout();
    }, EMPLOYEE_CANDIDATE_STARTUP_TIMEOUT_MS);
    timer.unref?.();
    this.candidateStartupWatchdogs.set(sessionId, timer);
  }

  private disarmCandidateStartupWatchdog(sessionId: string): void {
    const timer = this.candidateStartupWatchdogs.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.candidateStartupWatchdogs.delete(sessionId);
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

  getSlim(id: string): SessionSnapshot | null {
    const session = this.get(id);
    if (!session) return null;
    const { messages: _messages, output: _output, ...metadata } = session;
    return { ...metadata, output: "" };
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

  /** 归档只写标记，正在执行的回合和历史继续保留。 */
  setSessionArchived(id: string, archived: boolean): SessionSnapshot {
    const current = this.requireSession(id);
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
    // The plan names this execution. Preserve that name and avoid a second model
    // call merely to rename background work before it reaches its chosen employee.
    if (isScheduledConversationSession(session)) return;
    this.metadata.generateTopicForPrompt(id, input);
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
    // 显式引擎优先：用户新建会话时选了 Wand Agent（core）就不要再被员工候选或默认推断改口。
    const explicitEngine = provider === "pi" ? options.engine : undefined;
    // 员工 SDK 会话不静默继承用户的全局扩展，也不继承 CLI 专属的资源/CodeMode 默认。
    const sdkEmployeeSession = provider === "pi"
      && (explicitEngine ? explicitEngine === "core"
        : options.employeeCandidates?.[options.employeeCandidateIndex ?? 0]?.engine === "sdk");
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
        ...(explicitEngine ? { engine: explicitEngine } : {}),
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
    return agent.model === "default" ? fallbackProviderModel(this.config, agent.provider) ?? null : agent.model;
  }

  /**
   * A turn the provider rejected before it accepted any input may replay on the next candidate.
   * Same-tool switches carry the conversation as it stood before this turn — history plus the native
   * session it already had — so they also cover an already-started chat. A cross-tool switch cannot
   * hand that context over, so it stays limited to conversations that have not produced a turn yet.
   */
  private retryEmployeeCandidate(
    id: string,
    original: SessionSnapshot,
    prompt: string,
    error: unknown,
  ): Promise<SessionSnapshot> | null {
    // Team runs own candidate scheduling; keep the snapshot without a second retry loop.
    if (original.automationId?.startsWith("ai-team:") || !(error instanceof UnacceptedStructuredInputError)) return null;
    if (!original.employeeId || !error.failure.retryable) return null;
    const candidates = original.employeeCandidates ?? [];
    const index = original.employeeCandidateIndex ?? 0;
    const selected = candidates[index];
    let nextIndex = index + 1;
    // LAYA has no chat adapter; keep original candidate indices while skipping bounded-only models.
    while (nextIndex < candidates.length && isLocalDecisionModel(candidates[nextIndex]!.model)) nextIndex += 1;
    if (nextIndex >= candidates.length) return null;
    // Explicit tool/model changes, including changes during the pending request, remain authoritative.
    if (!selected || original.provider !== selected.provider
      || (original.structuredState?.engine && (original.structuredState.engine === "core" ? "sdk" : "cli") !== (selected.engine ?? "cli"))
      || (original.selectedModel && original.selectedModel !== this.employeeCandidateModel(selected))) return null;
    const next = candidates[nextIndex]!;
    const sameTool = next.provider === selected.provider && (next.engine ?? "cli") === (selected.engine ?? "cli");
    if (!sameTool && ((original.messages?.length ?? 0) !== 0 || original.claudeSessionId)) return null;
    const current = this.sessions.get(id);
    if (!current || current.status !== "running" || current.provider !== original.provider
      || current.selectedModel !== original.selectedModel || current.mode !== original.mode
      || current.piSettings !== original.piSettings) return null;
    const runner = resolveStructuredRunner(next.provider, undefined);
    const model = this.employeeCandidateModel(next);
    const piSettings = next.provider !== "pi" ? undefined : sameTool ? current.piSettings
      : next.engine === "sdk" ? defaultPiSessionSettings(this.config.harness?.compaction?.enabled ?? true)
      : { ...(this.storage.getPiSessionDefaults() ?? defaultPiCliSessionSettings()),
        autoCompaction: this.config.harness?.compaction?.enabled ?? true };
    const carried = current.structuredState as StructuredSessionState | undefined;
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
      // Replay resumes the state this turn started from, not what the rejected attempt produced:
      // its native session may already hold the input we are about to send again.
      claudeSessionId: sameTool ? original.claudeSessionId : null,
      harnessContext: sameTool ? original.harnessContext : undefined,
      harnessExtensionState: sameTool ? original.harnessExtensionState : undefined,
      messages: sameTool ? original.messages ?? [] : [],
      output: sameTool ? original.output ?? "" : "",
      status: "idle",
      exitCode: null,
      endedAt: null,
      structuredState: {
        ...defaultStructuredState(next.provider, runner),
        ...(sameTool ? { engine: carried?.engine, engineReason: carried?.engineReason,
          contextUsage: carried?.contextUsage, compactions: carried?.compactions } : {}),
        model: model ?? undefined,
      },
    };
    this.logger?.appendStructuredSpawn(id, { kind: "candidate-fallback", failureKind: error.failure.kind,
      fromProvider: original.provider, toProvider: next.provider, candidateIndex: nextIndex, sameTool });
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
    // Only await on branches that really need it: an unconditional await would
    // defer every send past its synchronous state transition (requestId/turn start).
    const relay = this.relayHandlerFor(session);
    if (relay) return await this.relayUserMessage(id, prompt, relay);
    if (opts?.idempotencyKey) this.claimIdempotencyKey(id, opts.idempotencyKey);
    // Pi 主功能现在固定走 CLI；core SDK 重启 drain 不影响 CLI 会话入场。
    this.maybeGenerateSessionTopic(id, prompt);
    // 「智能分配」结算窗口：还没有 runner 归属，新输入先排队，不能另起一轮。
    if (this.autoAssignPending.has(id)) return this.enqueueInput(session, prompt);
    const inFlight = this.resolveInFlightSend(id, session, prompt, opts);
    if ("result" in inFlight) return inFlight.result;
    session = inFlight.session;

    if (isAutoAssignSelector(session.selectedModel)) {
      const assigned = await this.settleAutoAssignForSend(id, session, prompt);
      if ("result" in assigned) return assigned.result;
      session = assigned.session;
    }

    // 检测上一轮 assistant 是否有未配对的 AskUserQuestion tool_use（说明前一次
    // child 是被 SIGTERM 主动 kill 的，正在等用户回答）。如果有，把这次的输入打包
    // 成 tool_result 注入到 messages，让 UI 把卡片渲染为 answered。
    const pendingAsk = findUnpairedAskUserQuestion(session.messages ?? []);
    const userTurnAt = isoNow();
    const userTurn = buildUserTurn(prompt, pendingAsk, userTurnAt);
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

    // 续接 AskUserQuestion：CLI runner（`claude -p`）没有 tool_result 回传通道，只能把
    // 答案当作普通文本塞回去，靠提示词让 Claude 理解这是工具回答。
    const cliClaudePrompt = pendingAsk
      ? `[对刚才 AskUserQuestion 工具的回答 — 结构化模式不支持工具结果回传，下面是用户从选项中的选择]\n${prompt}`
      : prompt;

    try {
      const provider = updated.provider ?? updated.structuredState?.provider ?? "claude";
      const runner = updated.runner ?? updated.structuredState?.runner;
      if (!isStructuredRunnerForProvider(provider, runner)) {
        throw new Error(`会话 runner ${String(runner)} 与 provider ${provider} 不匹配。`);
      }
      await this.runProviderTurn(id, updated, prompt, cliClaudePrompt, requestId);
      const finished = this.requireSession(id);
      return finished;
    } catch (error) {
      return await this.recoverFromSendFailure(id, session, prompt, requestId, error);
    }
  }

  /** 群聊不起 CLI：先落下用户这句话，再交给转发方；转发失败以提示行告诉用户。 */
  private async relayUserMessage(id: string, prompt: string, relay: StructuredRelayHandler): Promise<SessionSnapshot> {
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

  /** Rejects a repeated (session, key) pair; otherwise remembers it (bounded). */
  private claimIdempotencyKey(id: string, idempotencyKey: string): void {
    const mapKey = `${id}:${idempotencyKey}`;
    if (this.seenIdempotencyKeys.has(mapKey)) {
      const err = new Error("检测到重复发送，已拦截。") as Error & { code?: string };
      err.code = "duplicate_idempotency_key";
      throw err;
    }
    // Bounded: BoundedKeySet drops the oldest half past IDEMPOTENCY_KEY_LIMIT.
    this.seenIdempotencyKeys.add(mapKey);
  }

  /**
   * While a turn is in flight, decide what this send does: recover a turn whose
   * runner is gone, interrupt the current turn, or queue the input. Returns the
   * session to continue with, or the value sendMessage should return now.
   */
  private resolveInFlightSend(
    id: string,
    session: SessionSnapshot,
    prompt: string,
    opts: { interrupt?: boolean; preserveQueue?: boolean; queueAlreadyRemoved?: boolean } | undefined,
  ): { session: SessionSnapshot } | { result: SessionSnapshot } {
    if (!session.structuredState?.inFlight) return { session };
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
      return { session: recovered };
    }
    if (!opts?.interrupt) return { result: this.enqueueInput(session, prompt) };

    this.requireRecoveryControl(id);
    this.interruptedWith.set(id, prompt);
    let current = session;
    if (opts.preserveQueue) {
      this.preserveQueueOnInterrupt.add(id);
      // 「立即发送」排队条某一条：interrupt 把它作为新输入重发，但该条仍留在
      // queuedMessages 里。必须在这里把它从队列摘掉一次，否则 preserveQueue 会
      // 原样保留整条队列，待 interruptPrompt 跑完 flushNextQueuedMessage 会把它
      // 当成普通排队再发一遍（重复发送）。旧客户端没有走 promote endpoint，
      // 服务端只能按文本删第一处匹配；新客户端会带 queueAlreadyRemoved 跳过这里。
      if (!opts.queueAlreadyRemoved) {
        const queue = current.queuedMessages ?? [];
        const removeAt = queue.indexOf(prompt);
        if (removeAt !== -1) {
          const trimmedQueue = queue.slice(0, removeAt).concat(queue.slice(removeAt + 1));
          current = { ...current, queuedMessages: trimmedQueue };
          this.sessions.set(id, current);
          this.storage.updateSessionRuntimeMetadata(current);
          this.emitStructuredSnapshot(current);
        }
      }
    } else {
      this.preserveQueueOnInterrupt.delete(id);
    }
    runnerExecution?.interrupt();
    return { result: current };
  }

  /**
   * 「智能分配」：只有真拿到这一轮提示词才能结算成本次使用的分组。结算后钉在会话上，
   * 后续轮次用同一个分组（不在会话中途换模型）；客户端选择器同步显示实际分组。
   */
  private async settleAutoAssignForSend(
    id: string,
    session: SessionSnapshot,
    prompt: string,
  ): Promise<{ session: SessionSnapshot } | { result: SessionSnapshot }> {
    if (!isAutoAssignSelector(session.selectedModel)) return { session };
    const token = { cancelled: false };
    this.autoAssignPending.set(id, token);
    let assigned: Awaited<ReturnType<typeof resolveAutoAssign>>;
    try {
      assigned = await resolveAutoAssign({
        provider: session.provider ?? "claude",
        prompt,
        groups: this.config.modelGroups,
        evaluate: this.autoAssignEvaluate(),
        ai: resolveSystemAiContext(session, this.config, this.storage.getSystemSiliconEmployee(), this.openRouter),
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
    if (!latest || token.cancelled || this.disposed) return { result: latest ?? session };
    // 结算期间用户可能自己换了模型；那是更强的意愿，不覆盖。
    if (!isAutoAssignSelector(latest.selectedModel)) return { session: latest };
    const resolved: SessionSnapshot = {
      ...latest,
      selectedModel: assigned.selector || null,
      structuredState: {
        ...(latest.structuredState ?? defaultStructuredState(latest.provider ?? "claude", latest.runner)),
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
    if (assigned.group) {
      console.info(`[AutoAssign] ${id} → 分组「${assigned.group.name}」（${assigned.strategy}${assigned.probability === undefined ? "" : `, p=${assigned.probability.toFixed(2)}`}）`);
    }
    return { session: resolved };
  }

  /** Runs one turn through the runner that owns the session's provider (and, for Pi, its engine). */
  private async runProviderTurn(
    id: string,
    updated: SessionSnapshot,
    prompt: string,
    cliClaudePrompt: string,
    requestId: string,
  ): Promise<void> {
    const provider = updated.provider ?? updated.structuredState?.provider ?? "claude";
    if (provider === "codex") {
      await this.runStructuredStreaming(id, updated, prompt, requestId, {
        runner: this.codexRunner, provider: "codex", commandLabel: "codex exec", logKind: "codex-exec",
      });
    } else if (provider === "opencode") {
      await this.runStructuredStreaming(id, updated, prompt, requestId, {
        runner: this.openCodeRunner, provider: "opencode", commandLabel: "opencode run", logKind: "opencode-run",
        installHint: "请安装 opencode-ai，或重跑 `wand service:install` 刷新服务 PATH",
      });
    } else if (provider === "grok") {
      await this.runStructuredStreaming(id, updated, prompt, requestId, {
        runner: this.grokRunner, provider: "grok", commandLabel: "grok", logKind: "grok-headless",
        installHint: "请安装 Grok Build CLI，或重跑 `wand service:install` 刷新服务 PATH",
      });
    } else if (provider === "qoder") {
      await this.runStructuredStreaming(id, updated, prompt, requestId, {
        runner: this.qoderRunner,
        provider: "qoder",
        commandLabel: "qodercli -p",
        logKind: "qoder-print",
        installHint: "请安装 @qoder-ai/qodercli，或重跑 `wand service:install` 刷新服务的 PATH",
      });
    } else if (provider === "pi") {
      await this.runPiTurn(id, updated, prompt, requestId);
    } else if (provider === "gemini") {
      await this.runStructuredStreaming(id, updated, prompt, requestId, {
        runner: this.geminiRunner,
        provider: "gemini",
        commandLabel: "gemini -p --output-format stream-json",
        logKind: "gemini-json",
        installHint: "请安装 @google/gemini-cli ≥ 0.11（`npm i -g @google/gemini-cli@latest`），或重跑 `wand service:install` 刷新服务的 PATH",
      });
    } else {
      await this.runStructuredStreaming(id, updated, cliClaudePrompt, requestId);
    }
  }

  private async runPiTurn(id: string, updated: SessionSnapshot, prompt: string, requestId: string): Promise<void> {
    const employeeAgent = updated.employeeCandidates?.[updated.employeeCandidateIndex ?? 0];
    // 会话已裁决过引擎就沿用（新建会话选了 Wand Agent 或 Pi CLI）；未裁决的旧会话/员工会话回落到候选配置。
    const decidedEngine = updated.structuredState?.engine;
    const sdkRequested = decidedEngine ? decidedEngine === "core" : employeeAgent?.engine === "sdk";
    // 没显式选择时对话框固定走 CLI；只有选定 Wand Agent 或员工候选配置 SDK 才是 core。
    // Register the selected Core runner synchronously before its lazy SDK/model
    // preparation. This preserves cancellation ownership and the restart drain;
    // a restored SDK session must not require a global startup prewarm.
    const resolution = sdkRequested
      ? { engine: "core" as const, reason: "" }
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
      await this.runStructuredStreaming(id, enginePatched, prompt, requestId, {
        runner: this.coreRunner,
        provider: "pi",
        commandLabel: "Wand Agent（SDK）",
        logKind: "pi-core",
      });
    } else {
      await this.runStructuredStreaming(id, enginePatched, prompt, requestId, {
        runner: this.piRunner,
        provider: "pi",
        commandLabel: "pi --mode json --print",
        logKind: "pi-json",
        installHint: "请安装 @earendil-works/pi-coding-agent（或兼容的 Pi CLI），或重跑 `wand service:install` 刷新服务的 PATH",
      });
    }
  }

  /**
   * A turn threw before the runner reported its own outcome. Re-throws errors that
   * were already persisted, ignores stale turns, offers the employee-candidate
   * fallback, and otherwise records the failure on the session.
   */
  private async recoverFromSendFailure(
    id: string,
    session: SessionSnapshot,
    prompt: string,
    requestId: string,
    error: unknown,
  ): Promise<SessionSnapshot> {
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

  /** 空白对话原位换执行工具；引擎也是工具身份，不跨工具搬历史或能力设置。 */
  setSessionProvider(sessionId: string, provider: SessionProvider, engine?: "cli" | "sdk"): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (!isSessionProvider(provider)) throw new Error("请选择有效的执行工具。");
    if (engine !== undefined && engine !== "cli" && engine !== "sdk") throw new Error("执行引擎必须是 cli 或 sdk。");
    if (engine === "sdk" && provider !== "pi") throw new Error("Wand Agent 只支持 Pi 结构化会话。");
    this.requireBlankSessionSelection(session);
    const updated = this.blankSessionToolSelection(session, provider, engine);
    if (updated === session) return session;
    return this.saveBlankSessionSelection(updated);
  }

  /** 首次发送前显式选择真实员工；同一会话、目录和未发送输入的归属不变。 */
  setSessionEmployee(sessionId: string, employeeId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    this.requireBlankSessionSelection(session);
    const employee = this.storage.getSiliconEmployee(employeeId);
    if (!employee || employee.archivedAt) throw new Error("硅基员工不存在或已归档。");
    const selected = selectEmployeeCandidate(employee);
    if (session.employeeId === employee.id) return session;
    const role: SessionSnapshot = {
      ...session,
      employeeId: employee.id,
      employeeName: employee.name,
      employeeAvatar: employee.avatar,
      systemPrompt: employee.prompt,
      runtimeSystemPrompt: undefined,
      employeeCandidates: employee.agents,
      employeeCandidateIndex: selected.index,
    };
    return this.saveBlankSessionSelection(this.blankSessionToolSelection(
      role, selected.agent.provider, selected.agent.engine ?? "cli", selected.index,
    ));
  }

  private requireBlankSessionSelection(session: SessionSnapshot): void {
    if (session.status !== "idle" || session.archived || session.structuredState?.inFlight ||
        session.structuredState?.activeRequestId ||
        this.pendingRunnerExecutions.has(session.id) || session.claudeSessionId ||
        session.resumedFromSessionId || session.autoRecovered ||
        (session.messages?.length ?? 0) > 0 || (session.queuedMessages?.length ?? 0) > 0 ||
        session.automationId || (session.sessionSource && session.sessionSource !== "interactive") ||
        this.relayHandlerFor(session)) {
      throw new Error("只有尚未发送消息的新建空白对话可以更换员工或工具。");
    }
  }

  private blankSessionToolSelection(
    session: SessionSnapshot, provider: SessionProvider, engine?: "cli" | "sdk", selectedCandidateIndex?: number,
  ): SessionSnapshot {
    const candidates = session.employeeCandidates ?? [];
    const currentCandidate = candidates[session.employeeCandidateIndex ?? 0];
    const currentEngine = session.provider === "pi" && (session.structuredState?.engine === "core"
      || (!session.structuredState?.engine && currentCandidate?.provider === "pi" && currentCandidate.engine === "sdk")) ? "sdk" : "cli";
    // 旧客户端只发 provider 时，同 provider 保持原引擎；显式 Pi 选项始终传 cli。
    const targetEngine = provider === "pi" ? engine ?? (session.provider === provider ? currentEngine : "cli") : "cli";
    if (selectedCandidateIndex === undefined && session.provider === provider && currentEngine === targetEngine) return session;
    if (targetEngine === "sdk" && session.provider === "pi" && (session.piSettings?.resources?.skills.length
      || session.piSettings?.resources?.mcpServers.length || session.piSettings?.lockedSkills?.length
      || session.piSettings?.autoResources || session.piSettings?.codemodeOverride !== undefined)) {
      throw new Error("Wand Agent 不支持会话级 Skills / MCP、自动选择或 CodeMode 覆盖；请先在 Pi 设置中关闭这些选项再切换。");
    }
    const resolution = provider === "pi" ? targetEngine === "sdk"
      ? resolveHarnessEngineSync({ ...this.config.harness, engine: "core" }, "pi", { coreRunnerSupplied: this.coreRunnerSupplied })
      : { engine: "cli" as const, reason: "Pi 主功能固定使用 CLI JSON" } : undefined;
    const candidateIndex = selectedCandidateIndex ?? candidates.findIndex((candidate) => candidate.provider === provider
      && (candidate.engine ?? "cli") === targetEngine);
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    const runner = defaultStructuredRunner(provider);
    const model = candidate && candidate.model !== "default" ? candidate.model
      : fallbackProviderModel(this.config, provider) ?? null;
    const effort = normalizeThinkingEffort(candidate?.thinkingEffort ?? this.config.defaultThinkingEffort);
    const thinkingEffort = effort?.includes(":") && !effort.startsWith(`${provider}:`) ? "off" : effort;
    const requestedMode = candidate?.mode ?? session.mode;
    const unsupportedMode = (requestedMode === "native" && provider !== "claude") ||
      (requestedMode === "auto-edit" && ["opencode", "grok", "pi"].includes(provider));
    const mode: ExecutionMode = provider === "codex" ? "full-access"
      : unsupportedMode ? "default" : requestedMode;
    return {
      ...session,
      provider,
      runner,
      // 换引擎也是换工具：使用目标自己的默认设置，不复用另一路的能力配置。
      piSettings: provider !== "pi" ? undefined : targetEngine === "sdk"
        ? defaultPiSessionSettings(this.config.harness?.compaction?.enabled ?? true)
        : { ...(this.storage.getPiSessionDefaults() ?? defaultPiCliSessionSettings(this.config.harness?.compaction?.enabled ?? true)),
          autoCompaction: this.config.harness?.compaction?.enabled ?? true },
      command: targetEngine === "sdk" ? "Wand Agent（SDK）" : recoveredCommandLabel(runner),
      mode,
      autoApprovePermissions: shouldAutoApproveForMode(mode),
      selectedModel: model,
      thinkingEffort,
      employeeCandidateIndex: candidateIndex >= 0 ? candidateIndex : undefined,
      structuredState: { ...defaultStructuredState(provider, runner), model: model ?? undefined,
        ...(resolution ? { engine: resolution.engine, engineReason: resolution.reason } : {}) },
    };
  }

  private saveBlankSessionSelection(updated: SessionSnapshot): SessionSnapshot {
    this.storage.saveSession(updated);
    this.sessions.set(updated.id, updated);
    this.emit({
      type: "status",
      sessionId: updated.id,
      data: { ...(buildStructuredOutputPayload(updated) as Record<string, unknown>), command: updated.command,
        mode: updated.mode, autoApprovePermissions: updated.autoApprovePermissions,
        employeeAvatar: updated.employeeAvatar },
    });
    return updated;
  }

  /**
   * 新建 pi 结构化会话前的引擎裁决。
   *
   * 用户在新建会话里选的是两个不同的东西：Pi CLI（`cli`）与 Wand Agent（`sdk`，进程内 harness）。
   * 显式选了 Wand Agent 就必须真的可用：不可用时抛错由路由告诉用户，不静默退回 CLI 冒充。
   */
  async resolveNewSessionPiEngine(engine: "cli" | "sdk" | undefined): Promise<EngineResolution> {
    if (engine !== "sdk") return { engine: "cli", reason: "Pi 主功能固定使用 CLI JSON" };
    return await resolveHarnessEngine({ ...this.config.harness, engine: "core" }, "pi", {
      coreRunnerSupplied: this.coreRunnerSupplied,
    });
  }

  getPiSettings(sessionId: string): { settings: PiSessionSettings; resolution: EngineResolution } {
    const session = this.requireSession(sessionId);
    if (session.provider !== "pi") throw new Error("这些设置仅适用于 Pi 结构化会话。");
    const employeeAgent = session.employeeCandidates?.[session.employeeCandidateIndex ?? 0];
    const decidedEngine = session.structuredState?.engine;
    const sdkRequested = decidedEngine ? decidedEngine === "core" : employeeAgent?.engine === "sdk";
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
      throw new Error("Wand Agent 尚不支持此会话级设置；没有改用全局资源或 CodeMode 配置。");
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
    this.disposeSession(id, "run");
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
    const runnerExecution = this.pendingRunnerExecutions.get(id);
    // Invalidate callback ownership before signalling the runner. Cancellation
    // can synchronously wake listeners in some adapter implementations.
    this.sessions.delete(id);
    if (runnerExecution) {
      runnerExecution.interrupt();
      this.releasePendingRunnerExecution(id, runnerExecution);
    }
    // 会话被删除后迟到的回合回调必须失效，静默心跳也不能再给一个不存在的会话发事件。
    this.disposeSession(id, "session");
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
        ...structuredQuietStatusData(session),
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

  /** One turn lifecycle for every structured adapter; provider protocol reducers stay separate. */
  private async runStructuredStreaming(
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
    // 只在有多条候选可退的员工会话上看门：单候选会话没有可退的下一条链路，终止它只会丢工作。
    const candidateChain = !!session.employeeId && (session.employeeCandidates?.length ?? 0) > 1;
    let startupTimedOut = false;
    let turnCompleted = false;
    const disarmStartupWatchdog = (): void => this.disarmCandidateStartupWatchdog(sessionId);
    const execution = startEmployeeKnowledgeRunner(this.storage, runner, {
      session,
      prompt,
      env: buildChildEnv(this.config.inheritEnv !== false),
    }, {
      isActive: () => this.isCurrentRequest(sessionId, requestId),
      onStdout: (text) => {
        if (text) disarmStartupWatchdog();
        this.logger?.appendStructuredStdout(sessionId, text);
      },
      onStderr: (text) => this.logger?.appendStructuredStderr(sessionId, text),
      onEvent: (event) => this.logger?.appendStreamEvent(sessionId, event),
      onUpdate: (turnState) => {
        disarmStartupWatchdog();
        syncSnapshot(turnState);
        scheduleEmit();
      },
    });
    this.pendingRunnerExecutions.set(sessionId, execution);
    if (candidateChain) {
      this.armCandidateStartupWatchdog(sessionId, () => {
        if (turnCompleted || !this.isCurrentRequest(sessionId, requestId)) return;
        startupTimedOut = true;
        execution.interrupt();
      });
    }
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: logKind,
      provider,
      pid: execution.pid,
      cwd: session.cwd,
      args: execution.args,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      claudeSessionId: session.claudeSessionId,
      ...(provider === "codex" ? { threadId: session.claudeSessionId } : { sessionId: session.claudeSessionId }),
      spawnedAt: execution.spawnedAt,
    });

    let result;
    try {
      result = await execution.completion;
    } finally {
      turnCompleted = true;
      disarmStartupWatchdog();
      const released = this.releasePendingRunnerExecution(sessionId, execution);
      if (released) this.cancelStreamingCheckpointTimer(sessionId);
    }
    if (!this.isCurrentRequest(sessionId, requestId)) {
      if (emitTimer) this.clearStreamEmitTimer(emitTimer);
      return;
    }
    flushEmit();

    // 看门狗只在本轮确实没有产出任何东西时才算「未开始执行」；已经出过内容的那一轮维持原判定。
    if (startupTimedOut && !hasStructuredExecutionProgress(result.state)) {
      const unaccepted: StructuredFailure = { kind: "preflight", delivery: "rejected", retryable: true };
      result = {
        ...result,
        inputAccepted: false,
        primaryError: result.primaryError?.trim()
          || `${commandLabel} 在 ${EMPLOYEE_CANDIDATE_STARTUP_TIMEOUT_MS / 1000} 秒内没有任何协议输出，本轮未开始执行。`,
        failure: unaccepted,
      };
    }

    this.throwUnacceptedInput(sessionId, result, commandLabel,
      `（PATH 中找不到 ${providerCliCommand(provider)} 可执行文件；${options.installHint ?? `请确认 ${providerCliCommand(provider)} 已安装，或重跑 wand service:install 刷新服务的 PATH`}）`);

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: `${logKind}-close`,
      pid: execution.pid,
      spawnedAt: execution.spawnedAt,
      closedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      stderrTail: result.stderr.slice(-2048),
      primaryError: result.primaryError,
      ...(provider === "codex" ? { codexErrors: result.errors, codexTurnFailed: result.primaryError } : {}),
    });
    const current = this.currentSessionForRequest(sessionId, requestId);
    if (!current) return;

    const interruptedByUser = this.interruptedWith.has(sessionId);
    const supportsToolContinuation = provider !== "codex" && provider !== "opencode" && provider !== "grok";
    const interruptedForQuestion = supportsToolContinuation && result.stopReason === "ask-user-question";
    const failedExit = (result.exitCode !== null && result.exitCode !== 0) || result.signal !== null;
    // A protocol failure remains a failure even if the CLI exits 0 or already produced work.
    // Earlier work is preserved below and must never be replayed on another candidate.
    const failure = result.failure ?? classifyStructuredFailure(result);
    if (failure && !interruptedByUser && !interruptedForQuestion) {
      let errorText = supportsToolContinuation && !failedExit && result.primaryError
        ? result.primaryError!.trim()
        : this.formatStructuredExitError(commandLabel, result.exitCode, result.signal, {
          stderr: result.stderr,
          stdoutTail: result.stdoutTail,
          primary: result.primaryError,
          extras: result.errors,
        });
      if (provider === "opencode" && /unknown command|unknown flag|No help topic for 'run'/i.test(result.stderr)) {
        errorText += "\n检测到旧版 OpenCode CLI；请卸载 0.0.x 旧包并安装 `opencode-ai@latest`。";
      }
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
    if (supportsToolContinuation && lastToolUse?.name === "ExitPlanMode" && result.state.sessionId) {
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


}
