import { isOpenRouterFreeSelector } from "./openrouter-free-models.js";
import { isAutoAssignSelector, defaultModelGroupSelector, resolveModelGroupModels } from "./model-groups.js";
import { resolveAutoAssign } from "./model-auto-assign.js";
import type { DecisionResult } from "./decision-types.js";
import { getDefaultModelForProvider } from "./config.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";


import { WandStorage } from "./storage.js";
import { SessionLogger, ShortcutLogContext } from "./session-logger.js";
import { ApprovalPolicy, AutonomyPolicy, ChatOutputData, ConversationTurn, EscalationRequest, EscalationScope, ExecutionMode, ProcessEvent, ProcessEventHandler, SessionEvent, SessionProvider, SessionSnapshot, SessionSource, WandConfig } from "./types.js";
import { ClaudePtyBridge, type PermissionResolution } from "./claude-pty-bridge.js";
import { SessionTimers, type ProviderDiscoveryKind } from "./process-manager-timers.js";
import { truncateMessagesForTransport } from "./message-truncator.js";
import { appendWindow, hasExplicitConfirmSyntax, hasPermissionActionContext, normalizePromptText, PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";
import { buildChildEnv, isRunningAsRoot, systemEnvValue } from "./env-utils.js";
import { coreHarnessAgentDir } from "./harness-engine.js";
import { waitForSessionProcessExit } from "./session-artifact-cleanup.js";
import { buildLanguageDirective, buildManagedAutonomyDirective } from "./language-prompt.js";
import { prepareSessionWorktree } from "./git-worktree.js";
import { getProviderCommandSessionId, getProviderResumeCommandSessionId } from "./resume-policy.js";
import { commandWithSystemPrompt, composeSystemFallback, normalizeThinkingEffort, systemPromptFlag, thinkingEffortToClaudeCliEffort, thinkingEffortToClaudeSlashEffort, thinkingEffortToCodexReasoningEffort, thinkingEffortToGrokEffort, thinkingEffortToPiLevel, thinkingEffortToQoderEffort } from "./structured-provider-common.js";
import { consumePtyInputForTopic, createPtyTopicLineBuffer, SessionNativeTitleTracker, SessionTopicCoordinator, type PtyTopicLineBuffer } from "./session-topic.js";
import { SessionMetadataService } from "./session-metadata-service.js";


import { TurnQuietHeartbeat } from "./turn-heartbeat.js";
import { recordIterationPrompt } from "./iteration-log.js";
import { describePtySpawnFailure } from "./ensure-node-pty-helper.js";
import type { EmployeeTextDeps } from "./employee-text.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { inferProviderFromCommand, isSessionProvider, providerCliCommand } from "./session-provider.js";
import { PtyTerminalState, type PtyTerminalSnapshot, type PtyHistoryPage } from "./pty-terminal-state.js";
import { isPtySubmitInput } from "./pty-turn-activity.js";
import { samplePtyForegrounds } from "./pty-foreground.js";
import { buildPtyShellLaunchPlan, PtyCliExitMarker } from "./pty-shell-launch.js";
import { InProcessTerminalHost, type TerminalAttachResult, type TerminalDataEvent, type TerminalHost, type TerminalProcess, type TerminalSessionState } from "./terminal-host.js";
import { ProviderHistoryScanner, type ClaudeHistorySession, type CodexHistorySession, type OpenCodeHistorySession, type QoderHistorySession } from "./provider-history-scanner.js";
import { logInfo } from "./runtime-log.js";

import { isCommandAllowedByPrefixes } from "./process-manager-command-policy.js";
import { getClaudeProjectDir, getLatestClaudeProjectSessionId, getLatestCodexSessionId, isClaudeSessionFileAvailable, listClaudeProjectSessionMtimes, listCodexSessionMtimes, listOpenCodeSessionMtimes, listRecentClaudeProjectSessionIds, recoverClaudeSessionIdFromHistory, recoverCodexSessionIdFromHistory, selectClaudeProjectSessionForTimeWindow, selectCodexSessionForTimeWindow, selectOpenCodeSessionForRecord, selectOpenCodeSessionForTimeWindow } from "./process-manager-native-history.js";
import { PersistedMessageState, deriveSessionSummary, getPersistedMessageState, recoverMessagesFromSnapshot, shouldPersistMessages } from "./process-manager-message-state.js";
export { isCommandAllowedByPrefixes };
export type {
  ClaudeHistorySession,
  CodexHistorySession,
  OpenCodeHistorySession,
  QoderHistorySession,
} from "./provider-history-scanner.js";


export type { ProcessEvent, ProcessEventHandler } from "./types.js";

export class SessionInputError extends Error {
  constructor(
    message: string,
    readonly code: "SESSION_NOT_FOUND" | "SESSION_NOT_RUNNING" | "SESSION_NO_PTY",
    readonly sessionId: string,
    readonly sessionStatus?: SessionSnapshot["status"]
  ) {
    super(message);
    this.name = "SessionInputError";
  }
}

/** Write outcome is unknown to the caller; do not record this as accepted input. */
export class PtyInputDeliveryError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super("PTY input delivery could not be confirmed.", { cause });
    this.name = "PtyInputDeliveryError";
  }
}


export interface SessionRecord extends SessionSnapshot {
  provider?: SessionProvider;
  processId: number | null;
  ptyProcess: TerminalProcess | null;
  terminalState: PtyTerminalState | null;
  providerShellMarker: PtyCliExitMarker | null;
  providerCliActive: boolean;
  providerCliExitCode: number | null;
  stopRequested: boolean;
  confirmWindow: string;
  ptyPermissionBlocked: boolean;
  lastAutoConfirmAt: number;
  autoApprovePermissions: boolean;
  pendingEscalation: EscalationRequest | null;
  lastEscalationResult: SessionSnapshot["lastEscalationResult"];
  autonomyPolicy: AutonomyPolicy;
  approvalPolicy: ApprovalPolicy;
  allowedScopes: EscalationScope[];
  rememberedEscalationScopes: Set<EscalationScope>;
  rememberedEscalationTargets: Set<string>;
  /** 从存储加载的初始输出（用于重启后恢复） */
  storedOutput: string;
  /** Structured conversation messages derived from PTY chat output */
  messages: ConversationTurn[];
  /** Child process reference reserved for compatibility */
  childProcess: ChildProcess | null;
  /** PTY bridge for parsing output and emitting events */
  ptyBridge: ClaudePtyBridge | null;
  /** 运行时每轮忙碌信号（对齐 structured inFlight）；由 bridge 事件驱动，不持久化 */
  ptyBusy?: boolean;
  /**
   * 本轮时间锚点，语义与 structuredState.turnStartedAt / lastActivityAt 一致，
   * 和 ptyBusy 同生命周期：openPtyTurn / bridge 翻转为 busy 时写入，clearPtyTurn
   * （退回提示符、CLI 退出、stop、cleanup）连同 ptyBusy 一起清 null。
   * 同样是运行时信号，不持久化（存储里没有对应列），服务重启后为 null。
   */
  ptyTurnStartedAt?: string | null;
  ptyLastActivityAt?: string | null;
  /** Quiet-window timer for the non-Claude PTY turn tracker (no bridge). */
  /**
   * 实时前台状态：终端的前台进程组不是 shell 自己（即有 CLI 在前台运行）。
   * `undefined` = 还没采到（平台不支持或采样失败），回退一次性的 providerCliActive。
   */
  ptyForeground?: boolean;
  /** Last published chat sequence boundary; never persisted or exposed as a DTO field. */
  ptyChatMessageCount?: number;
  /** Current PTY dimensions, last applied by resize(). */
  ptyCols: number;
  ptyRows: number;
  /** Claude task ids visible before this session started */
  knownClaudeTaskIds?: Set<string>;
  /** Timers for PTY turn tracking, delayed initial input and provider id discovery (see SessionTimers). */
  timers: SessionTimers;
  /** Assembles terminal-view keystrokes into a prompt for session titles. */
  ptyTopicDraft?: PtyTopicLineBuffer;
  /** Claude project jsonl mtimes visible before this session started */
  knownClaudeProjectMtimes?: Map<string, number>;
  /** Codex rollout mtimes visible before this session started */
  knownCodexSessionMtimes?: Map<string, number>;
  /** OpenCode sessions visible before this PTY started, keyed by provider session id. */
  knownOpenCodeSessionMtimes?: Map<string, number>;
  /** Auto-approval stats per session */
  approvalStats: { tool: number; command: number; file: number; total: number };
}



interface SessionDirtyState {
  metadata: boolean;
  output: boolean;
  messages: boolean;
}


function snapshotMessages(record: Pick<SessionRecord, "ptyBridge" | "messages">): ConversationTurn[] {
  return record.ptyBridge?.getMessages() ?? record.messages;
}

function restoreTerminalState(state: TerminalSessionState): PtyTerminalState {
  const snapshot = state.terminalSnapshot;
  const terminal = new PtyTerminalState(
    snapshot?.cols ?? state.cols,
    snapshot?.rows ?? state.rows,
    snapshot?.data ?? state.output,
  );
  for (const operation of snapshot?.pending ?? []) {
    if (operation.type === "data") terminal.write(operation.data);
    else terminal.resize(operation.cols, operation.rows);
  }
  return terminal;
}

const CONFIRM_WINDOW_SIZE = 800;
/**
 * Quiet window for the non-Claude PTY turn tracker: a submitted turn stays busy
 * until the CLI has produced no output for this long (see pty-turn-activity.ts).
 * Matches the bridge's own idle-probe delay so both paths make the same call.
 */
export const PTY_TURN_IDLE_MS = 3000;
/**
 * 采样间隔：多久向内核问一次「这个 PTY 的前台进程组还是 CLI 吗」。
 * 只查运行中的 PTY 会话，一次 `ps` 拿全部会话，开销与间隔同量级（毫秒）。
 */
export const PTY_FOREGROUND_SAMPLE_MS = 1000;


export interface ProcessManagerOptions {
  free?: EmployeeTextDeps["free"];
  /** Overrides the non-Claude PTY turn quiet window (tests use a short one). */
  ptyTurnIdleMs?: number;
  /** Overrides the foreground-process-group sampling interval (tests use a short one). */
  ptyForegroundSampleMs?: number;
  /** Overrides the foreground probe itself, so tests can drive it deterministically. */
  samplePtyForegrounds?: typeof samplePtyForegrounds;
  /** 本地决策入口；只有带首条提示词创建终端会话时用来结算「智能分配」。 */
  resolveDecisionEvaluate?: () => ((value: unknown, caller: string, signal?: AbortSignal) => Promise<DecisionResult>) | undefined;
}

export interface ProcessStartOptions extends Pick<SessionSnapshot, "employeeId" | "employeeName" | "employeeAvatar"> {
  resumedFromSessionId?: string;
  autoRecovered?: boolean;
  worktreeEnabled?: boolean;
  provider?: SessionProvider;
  model?: string;
  reuseId?: string;
  cols?: number;
  rows?: number;
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  sessionSource?: SessionSource;
  automationId?: string;
  workspaceId?: string;
  workspaceTaskId?: string;
  interactiveShell?: boolean;
  systemPrompt?: string;
}

export class ProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();
  /** Own the full start handshake, including model resolution and late host replies. */
  private readonly startingSessions = new Map<string, { cancelled: boolean }>();
  private readonly nativeCleanupBarriers = new Map<string, Promise<void>>();
  private readonly logger: SessionLogger;
  private readonly providerHistory: ProviderHistoryScanner;
  /** Quiet window for the non-Claude PTY turn tracker. */
  private readonly ptyTurnIdleMs: number;
  /** Foreground-process-group sampling interval. */
  private readonly ptyForegroundSampleMs: number;
  /** Foreground probe; injectable so tests can drive it without a real process table. */
  private readonly probePtyForegrounds: typeof samplePtyForegrounds;
  private readonly free: EmployeeTextDeps["free"];
  private readonly resolveDecisionEvaluate: NonNullable<ProcessManagerOptions["resolveDecisionEvaluate"]>;
  /** 前台进程组采样定时器（见 samplePtyForegrounds） */
  private ptyForegroundTimer: NodeJS.Timeout | null = null;
  /** 采样是 async 的，避免慢 ps 重叠成多个进程 */
  private ptyForegroundSampling = false;
  /** Per-session debounce timers for throttled persist calls */
  private readonly persistDebounceTimers = new Map<string, NodeJS.Timeout>();
  /** Last persisted message state per session — used to skip redundant message writes */
  private readonly lastPersistedMessageState = new Map<string, PersistedMessageState>();
  /** Columns that changed since the last per-session checkpoint. */
  private readonly dirtySessions = new Map<string, SessionDirtyState>();
  /** 启动时被识别为孤儿 PTY 并标记为 exited 的旧会话数（旧服务器进程已死） */
  private orphanRecoveredCount = 0;
  private readonly topicCoordinator = new SessionTopicCoordinator();
  /** Topic/native-title policy shared with the structured manager; see SessionMetadataService. */
  private readonly metadata: SessionMetadataService<SessionRecord>;
  private readonly nativeTitles = new SessionNativeTitleTracker();
  /**
   * 静默期心跳：ptyBusy 且连续 TURN_QUIET_HEARTBEAT_MS 没有任何输出时，用现有的 status
   * 事件重发一次 ptyBusy 事实与本轮锚点，证明「还在跑」。timer 只在回合在飞期间存在，
   * clearPtyTurn / cleanupRecord / dispose 立即撤销。
   */
  private readonly ptyHeartbeat = new TurnQuietHeartbeat((sessionId) => this.publishPtyQuietHeartbeat(sessionId));
  private disposed = false;
  private readonly terminalHost: TerminalHost;

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage,
    configDir?: string,
    terminalHost?: TerminalHost,
    options: ProcessManagerOptions = {},
  ) {
    super();
    const cliEnv = buildChildEnv(config.inheritEnv !== false);
    this.providerHistory = new ProviderHistoryScanner({
      claudeHome: cliEnv.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"),
      codexHome: cliEnv.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
      openCodeDatabasePath: path.join(cliEnv.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db"),
    });
    this.ptyTurnIdleMs = options.ptyTurnIdleMs ?? PTY_TURN_IDLE_MS;
    this.ptyForegroundSampleMs = options.ptyForegroundSampleMs ?? PTY_FOREGROUND_SAMPLE_MS;
    this.probePtyForegrounds = options.samplePtyForegrounds ?? samplePtyForegrounds;
    this.free = options.free;
    this.resolveDecisionEvaluate = options.resolveDecisionEvaluate ?? (() => undefined);
    this.terminalHost = terminalHost ?? new InProcessTerminalHost();
    this.logger = new SessionLogger(configDir || path.join(process.env.HOME || process.cwd(), ".wand"), config.shortcutLogMaxBytes);
    this.metadata = new SessionMetadataService<SessionRecord>({
      isDisposed: () => this.disposed,
      current: (id) => this.sessions.get(id),
      messagesOf: (record) => snapshotMessages(record),
      commitTopic: (id, title, description) => { this.setSessionTopic(id, title, description); },
      commitTopicGenerating: (id, generating) => this.setSessionTopicGenerating(id, generating),
      topicCoordinator: () => this.topicCoordinator,
      nativeTitles: () => this.nativeTitles,
    }, {
      logPrefix: "[ProcessManager]",
      config,
      storage,
      free: this.free,
    });
    let startupCodexHistory: CodexHistorySession[] | null = null;
    const getStartupCodexHistory = (): CodexHistorySession[] => {
      startupCodexHistory ??= this.providerHistory.listCodexHistorySessions();
      return startupCodexHistory;
    };

    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "pty") {
        continue;
      }
      this.lastPersistedMessageState.set(snapshot.id, getPersistedMessageState(snapshot.messages ?? []));
      const provider = snapshot.provider ?? inferProviderFromCommand(snapshot.command);
      const isClaudeCmd = provider === "claude";
      const isCodexCmd = provider === "codex";
      const isOpenCodeCmd = provider === "opencode";
      const resumeCommandSessionId = provider
        ? getProviderCommandSessionId(provider, snapshot.command)
        : null;
      const orphanEndedAt = snapshot.status === "running" ? new Date().toISOString() : null;
      const sessionIdFromHistory = isClaudeCmd
        ? recoverClaudeSessionIdFromHistory({
            ...snapshot,
            provider: "claude",
            endedAt: snapshot.endedAt ?? orphanEndedAt,
          })
        : isCodexCmd
          ? recoverCodexSessionIdFromHistory({
              ...snapshot,
              provider: "codex",
              endedAt: snapshot.endedAt ?? orphanEndedAt,
            }, getStartupCodexHistory())
          : isOpenCodeCmd
            ? selectOpenCodeSessionForTimeWindow({
                cwd: snapshot.cwd,
                startedAt: snapshot.startedAt,
                endedAt: snapshot.endedAt ?? orphanEndedAt,
              })?.id ?? null
          : null;
      const restoredSessionId = resumeCommandSessionId ?? snapshot.claudeSessionId ?? sessionIdFromHistory;
      const attached = snapshot.status === "running"
        ? this.terminalHost.attach(snapshot.id, snapshot.ptyOutputSeq ?? 0)
        : null;
      const live = attached?.process && attached.state.status === "running" ? attached : null;
      const daemonEnded = attached && attached.state.status === "exited" ? attached : null;
      const recoveredMessages = recoverMessagesFromSnapshot(snapshot);
      const updated: SessionSnapshot = live
        ? {
            ...snapshot,
            sessionSource: snapshot.sessionSource ?? "interactive",
            status: "running",
            exitCode: null,
            endedAt: null,
            output: live.state.output,
            ptyOutputSeq: live.state.seq,
            ptyLaunchMarkerToken: live.state.launchMarkerToken,
            ptyCols: live.state.cols,
            ptyRows: live.state.rows,
            claudeSessionId: restoredSessionId ?? null,
          }
        : snapshot.status === "running"
          ? {
              ...snapshot,
              sessionSource: snapshot.sessionSource ?? "interactive",
              status: daemonEnded?.state.exitCode === 0 ? "exited" : daemonEnded ? "failed" : "exited",
              exitCode: daemonEnded?.state.exitCode ?? null,
              endedAt: orphanEndedAt,
              output: daemonEnded?.state.output ?? snapshot.output,
              ptyOutputSeq: daemonEnded?.state.seq ?? snapshot.ptyOutputSeq,
              claudeSessionId: restoredSessionId ?? null,
              messages: recoveredMessages.length > 0 ? recoveredMessages : snapshot.messages,
            }
          : restoredSessionId && restoredSessionId !== snapshot.claudeSessionId
            ? { ...snapshot, claudeSessionId: restoredSessionId }
            : snapshot;

      if (updated !== snapshot || live) {
        if (snapshot.status === "running") this.storage.saveSession(updated);
        else this.storage.saveSessionMetadata(updated);
      }
      if (restoredSessionId && restoredSessionId !== snapshot.claudeSessionId) {
        const label = isCodexCmd ? "Codex thread" : isOpenCodeCmd ? "OpenCode session" : "Claude session";
        logInfo(`Recovered ${label} ID for ${live ? "reattached" : "saved"} PTY ${snapshot.id}: ${restoredSessionId}`);
      }

      const record = this.makeRestoredRecord(updated, provider, live?.process ?? null, live?.state ?? null, {
        isClaudeCmd,
        isCodexCmd,
        isOpenCodeCmd,
        startupCodexHistory: getStartupCodexHistory,
      });
      this.sessions.set(snapshot.id, record);
      if (live?.process) {
        this.bindRestoredTerminal(record, live);
        logInfo(`Reattached live terminal ${snapshot.id} (pid ${live.process.pid}).`);
      } else if (snapshot.status === "running") {
        this.orphanRecoveredCount += 1;
      }
    }
    this.ptyForegroundTimer = setInterval(() => { void this.samplePtyForegrounds(); }, this.ptyForegroundSampleMs);
    this.ptyForegroundTimer.unref?.();
  }

  /**
   * 采样每个运行中 PTY 会话的终端前台进程组，得出「CLI 是否还在前台」。
   *
   * 这是 ptyBusy 的实时资格判断，取代一次性启动标记：CLI 退出后又被重新拉起
   * （自更新、手动重跑）时，前台进程组会自然回到 CLI，于是新一轮仍然能被跟踪。
   * 采样不到（不支持的平台、ps 失败、pid 已消失）就保持上次结论，绝不因此清状态。
   */
  private async samplePtyForegrounds(): Promise<void> {
    if (this.disposed || this.ptyForegroundSampling) return;
    const candidates = [...this.sessions.values()].filter((record) => (
      record.status === "running"
      && record.ptyProcess !== null
      && !record.ptyBridge
      && typeof record.processId === "number"
      && record.processId > 0
    )).map((record) => ({ record, pid: record.processId as number, process: record.ptyProcess }));
    if (candidates.length === 0) return;

    this.ptyForegroundSampling = true;
    try {
      const samples = await this.probePtyForegrounds(candidates.map(({ pid }) => pid));
      if (!samples || this.disposed) return;
      for (const { record, pid, process } of candidates) {
        // ps is asynchronous: a stopped/replaced terminal must not inherit an old probe.
        if (this.sessions.get(record.id) !== record || record.status !== "running"
          || record.ptyProcess !== process || record.processId !== pid) continue;
        const next = samples.get(pid);
        if (next === undefined || record.ptyForeground === next) continue;
        const wasForeground = record.ptyForeground === true;
        record.ptyForeground = next;
        // CLI 退回提示符：这一轮立刻结束，不必再等静默窗口。
        if (!next) this.closePtyTurn(record);
        // 空白终端里的手动命令也有运行事实，但没有 provider 回合边界。
        // 不复用 ptyBusy，避免一次前台切换冒充 AI 成功完成；静默命令也保持活动。
        if (!record.provider && wasForeground !== next) {
          this.emitEvent({ type: "status", sessionId: record.id, data: { ptyCommandRunning: next } });
        }
      }
    } catch {
      // 探测失败只意味着这一轮没有新信息，保留上次结论。
    } finally {
      this.ptyForegroundSampling = false;
    }
  }

  private makeRestoredRecord(
    snapshot: SessionSnapshot,
    provider: SessionProvider | undefined,
    ptyProcess: TerminalProcess | null,
    terminal: TerminalSessionState | null,
    history: {
      isClaudeCmd: boolean;
      isCodexCmd: boolean;
      isOpenCodeCmd: boolean;
      startupCodexHistory: () => CodexHistorySession[];
    },
  ): SessionRecord {
    return {
      ...snapshot,
      sessionSource: snapshot.sessionSource ?? "interactive",
      provider,
      processId: ptyProcess?.pid ?? null,
      ptyProcess,
      terminalState: terminal ? restoreTerminalState(terminal) : null,
      providerShellMarker: terminal?.launchMarkerToken ? new PtyCliExitMarker(terminal.launchMarkerToken) : null,
      providerCliActive: ptyProcess ? snapshot.providerCliActive ?? provider !== undefined : false,
      providerCliExitCode: snapshot.providerCliExitCode ?? null,
      stopRequested: false,
      confirmWindow: "",
      ptyPermissionBlocked: false,
      lastAutoConfirmAt: 0,
      autoApprovePermissions: snapshot.autoApprovePermissions
        ?? this.shouldAutoApprovePermissions(snapshot.command, snapshot.mode, provider),
      pendingEscalation: snapshot.pendingEscalation ?? null,
      lastEscalationResult: snapshot.lastEscalationResult ?? null,
      autonomyPolicy: snapshot.autonomyPolicy ?? this.defaultAutonomyPolicy(snapshot.mode),
      approvalPolicy: snapshot.approvalPolicy ?? "ask-every-time",
      allowedScopes: snapshot.allowedScopes ?? [],
      rememberedEscalationScopes: new Set(),
      rememberedEscalationTargets: new Set(),
      storedOutput: terminal?.output ?? snapshot.output,
      output: terminal?.output ?? snapshot.output,
      messages: snapshot.messages ?? [],
      childProcess: null,
      ptyBridge: null,
      knownClaudeTaskIds: undefined,
      timers: new SessionTimers(),
      knownClaudeProjectMtimes: history.isClaudeCmd ? listClaudeProjectSessionMtimes(snapshot.cwd) : undefined,
      knownCodexSessionMtimes: history.isCodexCmd ? listCodexSessionMtimes(history.startupCodexHistory()) : undefined,
      knownOpenCodeSessionMtimes: history.isOpenCodeCmd ? listOpenCodeSessionMtimes() : undefined,
      claudeSessionId: snapshot.claudeSessionId ?? null,
      approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
      titleGenerating: false,
      ptyCols: terminal?.cols ?? snapshot.ptyCols ?? 120,
      ptyRows: terminal?.rows ?? snapshot.ptyRows ?? 36,
      ptyOutputSeq: terminal?.seq ?? snapshot.ptyOutputSeq ?? 0,
      ptyLaunchMarkerToken: terminal?.launchMarkerToken ?? snapshot.ptyLaunchMarkerToken ?? null,
    };
  }

  private bindRestoredTerminal(record: SessionRecord, attached: TerminalAttachResult): void {
    const child = attached.process;
    if (!child) return;

    this.initializeClaudeBridge(record, record.output);

    this.bindTerminalProcess(record, child);

    // The daemon snapshot already contains replayed bytes. Consume only the
    // private provider boundary marker here so semantic CLI state catches up
    // without duplicating terminal output or bridge transcripts.
    for (const event of attached.replay) {
      const boundary = record.providerShellMarker?.consume(event.data);
      record.ptyOutputSeq = Math.max(record.ptyOutputSeq ?? 0, event.seq);
      if (boundary?.exitCode !== null && boundary?.exitCode !== undefined) {
        this.finishProviderCli(record, boundary.exitCode);
      }
    }
  }

  private initializeClaudeBridge(record: SessionRecord, initialOutput: string): void {
    if (record.provider !== "claude" || !record.providerCliActive) return;
    // 新 bridge 接管 ptyBusy 与本轮锚点：从干净的一轮起步，锚点由 bridge 的翻转写入。
    this.clearPtyTurn(record);
    record.ptyBridge?.removeAllListeners();
    record.ptyBridge = new ClaudePtyBridge({
      sessionId: record.id,
      isClaudeCommand: true,
      autoApprove: record.autoApprovePermissions,
      initialMessages: record.messages,
      initialOutput,
    });
    record.ptyBridge.on("event", (event: SessionEvent) => {
      if (this.sessions.get(record.id) !== record) return;
      this.handleBridgeEvent(record, event);
    });
  }

  /**
   * 这一轮的终端是否值得跟踪：这个会话有 provider CLI，且它现在就在前台
   * （实时采样的内核事实）；采样不可用时退回一次性的 providerCliActive 标记。
   *
   * 纯 shell 会话（没有 provider）不跟踪：用户在终端里随手敲一条命令不应该
   * 把任务标成「运行中 / 刚完成」。
   */
  private canTrackPtyTurn(record: SessionRecord): boolean {
    if (record.ptyForeground !== undefined) {
      return record.ptyForeground && record.provider !== undefined;
    }
    return record.providerCliActive;
  }

  /**
   * Open a non-Claude PTY turn and start its quiet-window timer. Claude's bridge
   * owns ptyBusy, so bridged sessions are left untouched.
   */
  private openPtyTurn(record: SessionRecord): void {
    if (record.ptyBridge || !this.canTrackPtyTurn(record) || record.status !== "running") return;
    if (record.ptyBusy !== true) {
      record.ptyBusy = true;
      // 本轮起点：两个锚点同时落下，客户端据此算「这一轮跑了多久 / 多久没动静」。
      const at = new Date().toISOString();
      record.ptyTurnStartedAt = at;
      record.ptyLastActivityAt = at;
      this.ptyHeartbeat.observe(record.id);
      this.emitEvent({
        type: "status",
        sessionId: record.id,
        data: { ptyBusy: true, ptyTurnStartedAt: at, ptyLastActivityAt: at },
      });
    }
    this.refreshPtyTurn(record);
  }

  /** Extend the quiet window because the CLI is still producing output. */
  private refreshPtyTurn(record: SessionRecord): void {
    if (record.ptyBridge || !this.canTrackPtyTurn(record)) return;
    // 输出续期只动 lastActivityAt；turnStartedAt 留在本轮开始处，否则「已运行多久」
    // 会被每次 chunk 重置。静默窗口跟着往后推。
    record.ptyLastActivityAt = new Date().toISOString();
    this.ptyHeartbeat.observe(record.id);
    record.timers.clearPtyTurn();
    const timer = setTimeout(() => {
      record.timers.ptyTurn = null;
      if (this.sessions.get(record.id) !== record) return;
      this.closePtyTurn(record);
    }, this.ptyTurnIdleMs);
    timer.unref?.();
    record.timers.ptyTurn = timer;
  }

  /** The quiet window elapsed: the CLI is back at its prompt, so the turn is done. */
  private closePtyTurn(record: SessionRecord): void {
    this.clearPtyTurn(record);
    if (record.ptyBusy !== true) return;
    record.ptyBusy = false;
    this.emitEvent({
      type: "status",
      sessionId: record.id,
      // 锚点与 ptyBusy 一起收敛成 null，不残留「还在跑」的读数。
      data: { ptyBusy: false, ptyTurnStartedAt: null, ptyLastActivityAt: null },
    });
  }

  private clearPtyTurn(record: SessionRecord): void {
    record.timers.clearPtyTurn();
    // ptyBusy 清 false 的一切路径（退回提示符、CLI 退出、finishProviderCli、stop、
    // cleanupRecord）都经过这里：撤掉静默心跳，锚点一并回 null。
    this.ptyHeartbeat.cancel(record.id);
    record.ptyTurnStartedAt = null;
    record.ptyLastActivityAt = null;
  }

  /**
   * 静默窗口到期：确认这一轮仍在飞才补发，payload 与一次普通 ptyBusy status 事件同形
   * （不带新字段、不用新事件类型）。停在权限裁决上的回合不广播「仍在运行」——那一屏
   * 已有 pendingEscalation 这个显式指示，再说在跑是错的（保留窗口，等输出恢复）。
   */
  private publishPtyQuietHeartbeat(id: string): boolean {
    if (this.disposed) return false;
    const record = this.sessions.get(id);
    if (!record || record.ptyBusy !== true) return false;
    if (record.pendingEscalation || this.isPermissionBlocked(record)) return true;
    this.emitEvent({
      type: "status",
      sessionId: id,
      data: {
        ptyBusy: true,
        ptyTurnStartedAt: record.ptyTurnStartedAt ?? null,
        ptyLastActivityAt: record.ptyLastActivityAt ?? null,
      },
    });
    return true;
  }

  private bindTerminalProcess(
    record: SessionRecord,
    child: TerminalProcess,
    onVisibleChunk?: (chunk: string) => void,
  ): void {
    child.onResync?.((state) => this.handleTerminalResync(record, child, state));
    child.onData((event) => this.handleTerminalData(record, child, event, onVisibleChunk));
    child.onExit(({ exitCode }) => this.handleTerminalExit(record, child, exitCode));
    if (record.ptyBridge) {
      record.ptyBridge.setPtyWrite((input: string) => {
        if (this.sessions.get(record.id) !== record || record.ptyProcess !== child) return;
        child.write(input);
      });
    }
  }

  private handleTerminalResync(
    record: SessionRecord,
    child: TerminalProcess,
    state: TerminalSessionState,
  ): void {
    const current = this.sessions.get(record.id);
    if (current !== record || current.ptyProcess !== child) return;
    current.terminalState?.dispose();
    current.terminalState = restoreTerminalState(state);
    current.output = state.output;
    current.storedOutput = state.output;
    current.ptyOutputSeq = state.seq;
    current.ptyCols = state.cols;
    current.ptyRows = state.rows;
    current.ptyLaunchMarkerToken = state.launchMarkerToken;
    current.providerShellMarker = state.launchMarkerToken
      ? new PtyCliExitMarker(state.launchMarkerToken)
      : null;
    if (current.ptyBridge) current.messages = current.ptyBridge.getMessages();
    this.initializeClaudeBridge(current, state.output);
    current.ptyBridge?.setPtyWrite((input: string) => {
      if (this.sessions.get(record.id) === current && current.ptyProcess === child) child.write(input);
    });
    this.flushPersist(current, true);
    this.emitEvent({ type: "resync", sessionId: record.id, data: { reason: "render_replay_gap" } });
  }

  private handleTerminalExit(record: SessionRecord, child: TerminalProcess, exitCode: number): void {
    const current = this.sessions.get(record.id);
    // A stopped session can be resumed under the same public id before the old
    // PTY emits its asynchronous exit event. Ignore that stale incarnation.
    if (current !== record || current.ptyProcess !== child) return;
    current.timers.clearAll();
    if (current.ptyBridge) {
      current.ptyBridge.onExit(exitCode);
      current.messages = current.ptyBridge.getMessages();
      current.ptyBridge.removeAllListeners();
      current.ptyBridge = null;
    }
    current.providerShellMarker = null;
    current.ptyLaunchMarkerToken = null;
    if (current.providerCliActive) {
      current.providerCliActive = false;
      current.providerCliExitCode = exitCode;
    }
    this.clearPtyTurn(current);
    current.ptyBusy = false;
    current.pendingEscalation = null;
    current.ptyPermissionBlocked = false;
    this.captureClaudeSessionId(current, { allowTimeWindowFallback: true });
    this.captureCodexSessionId(current, { allowTimeWindowFallback: true });
    this.captureOpenCodeSessionId(current, { allowTimeWindowFallback: true });
    current.status = current.stopRequested ? "stopped" : exitCode === 0 ? "exited" : "failed";
    current.exitCode = current.stopRequested ? null : exitCode;
    current.endedAt = new Date().toISOString();
    current.ptyProcess = null;
    this.flushPersist(current, true);
    this.emitEvent({ type: "ended", sessionId: record.id, data: this.snapshot(current) });
  }

  private handleTerminalData(
    record: SessionRecord,
    child: TerminalProcess,
    event: TerminalDataEvent,
    onVisibleChunk?: (chunk: string) => void,
  ): void {
    const current = this.sessions.get(record.id);
    if (current !== record || current.ptyProcess !== child) return;

    current.ptyOutputSeq = Math.max(current.ptyOutputSeq ?? 0, event.seq);
    const boundary = current.providerShellMarker?.consume(event.data) ?? { data: event.data, exitCode: null };
    const chunk = boundary.data;
    if (chunk) current.terminalState?.write(chunk);

    if (chunk && current.ptyBridge) {
      current.ptyBridge.processChunk(chunk);
      current.output = current.ptyBridge.getRawOutput();
    } else if (chunk) {
      current.output = appendWindow(current.output, chunk, PTY_OUTPUT_MAX_SIZE);
    }
    if (chunk) this.logger.appendPtyOutput(record.id, chunk);

    if (chunk && !current.ptyBridge) {
      this.emitEvent({
        type: "output",
        sessionId: record.id,
        data: {
          incremental: true,
          chunk,
          permissionBlocked: this.isPermissionBlocked(current),
        },
      });
    }

    const bridgeSessionId = current.ptyBridge?.getClaudeSessionId();
    if (bridgeSessionId && bridgeSessionId !== current.claudeSessionId) {
      current.claudeSessionId = bridgeSessionId;
      this.markDirty(current.id, { metadata: true });
      this.providerHistory.invalidate("claude");
      logInfo(`Captured Claude session ID: ${bridgeSessionId}`);
    }

    if (current.providerCliActive && boundary.exitCode === null && !current.claudeSessionId && current.knownClaudeTaskIds) {
      current.messages = snapshotMessages(current);
      const discoveredTaskId = getLatestClaudeProjectSessionId({
        cwd: current.cwd,
        startedAt: current.startedAt,
        knownClaudeProjectMtimes: current.knownClaudeProjectMtimes,
        messages: current.messages,
      });
      if (discoveredTaskId) {
        current.claudeSessionId = discoveredTaskId;
        this.markDirty(current.id, { metadata: true });
        current.knownClaudeTaskIds.add(discoveredTaskId);
        logInfo(`Captured Claude project session ID: ${discoveredTaskId}`);
      }
    }

    if (chunk && current.providerCliActive && current.autoApprovePermissions && !current.ptyBridge && current.provider === "claude") {
      this.autoConfirmWithRecord(current, chunk, child);
    }
    // Non-Claude CLIs have no parsed turn boundary: output keeps an open turn
    // open, and output while the CLI is in the foreground opens one — the CLI may
    // have (re)started in this terminal long after the one-shot launch marker was
    // consumed (see pty-turn-activity.ts / pty-foreground.ts).
    if (chunk && this.canTrackPtyTurn(current)) {
      if (current.ptyBusy === true) this.refreshPtyTurn(current);
      else this.openPtyTurn(current);
    }
    if (chunk) onVisibleChunk?.(chunk);
    if (boundary.exitCode !== null) this.finishProviderCli(current, boundary.exitCode);
    this.schedulePersist(current);
  }

  on(_event: "process", listener: ProcessEventHandler): this {
    return super.on("process", listener);
  }

  /** 启动时被识别为孤儿 PTY 并标记为 exited 的旧会话数量（仅用于启动摘要展示）。 */
  getOrphanRecoveredCount(): number {
    return this.orphanRecoveredCount;
  }

  /** Stop all live work and flush pending state before storage is closed. */
  dispose(): void {
    if (this.disposed) return;
    this.terminalHost.flush?.();
    this.disposed = true;
    // 静默心跳不跨服务关闭存活；每个会话的 timer 也在 cleanupRecord 里单独撤销。
    this.ptyHeartbeat.dispose();

    if (this.ptyForegroundTimer) {
      clearInterval(this.ptyForegroundTimer);
      this.ptyForegroundTimer = null;
    }
    const pendingPersistIds = new Set(this.persistDebounceTimers.keys());
    for (const timer of this.persistDebounceTimers.values()) clearTimeout(timer);
    this.persistDebounceTimers.clear();

    for (const record of this.sessions.values()) {
      const wasRunning = record.status === "running";
      if (record.ptyBridge) {
        record.messages = record.ptyBridge.getMessages();
      }
      this.cleanupRecord(record, !this.terminalHost.persistent);
      if (wasRunning && !this.terminalHost.persistent) {
        record.stopRequested = true;
        record.status = "stopped";
        record.exitCode = null;
        record.endedAt = new Date().toISOString();
        record.pendingEscalation = null;
        record.ptyPermissionBlocked = false;
      }
      if (wasRunning || pendingPersistIds.has(record.id)) {
        try { this.persist(record, { forceFullSave: wasRunning, metadataDirty: true }); } catch { /* best-effort shutdown flush */ }
      }
    }

    this.topicCoordinator.clear();
    this.nativeTitles.clear();
    this.removeAllListeners("process");
    this.logger.dispose();
    this.terminalHost.disconnect();
  }

  private emitEvent(event: ProcessEvent): void {
    if (this.disposed) return;
    this.emit("process", event);
  }

  async start(command: string, cwd: string | undefined, mode: ExecutionMode, initialInput?: string, opts?: ProcessStartOptions): Promise<SessionSnapshot> {
    if (this.disposed) throw new Error("ProcessManager has been disposed.");
    if (opts?.provider != null && !isSessionProvider(opts.provider)) {
      throw new Error(`不支持的终端 provider：${String(opts.provider)}`);
    }
    const id = opts?.reuseId || randomUUID();
    // Host operations are keyed by session id, not by the manager record. A
    // second handshake must not adopt/forget a cancelled first incarnation.
    if (this.startingSessions.has(id)) throw new Error("终端启动仍在进行，请等待本次启动结束后再恢复。");
    const start = { cancelled: false };
    this.startingSessions.set(id, start);
    try {
      return await this.startSession(id, start, command, cwd, mode, initialInput, opts);
    } finally {
      this.startingSessions.delete(id);
    }
  }

  private async startSession(
    id: string,
    start: { cancelled: boolean },
    command: string,
    cwd: string | undefined,
    mode: ExecutionMode,
    initialInput?: string,
    opts?: ProcessStartOptions,
  ): Promise<SessionSnapshot> {
    if (isOpenRouterFreeSelector(opts?.model)) throw new Error("免费分组仅支持 Pi 结构化对话。");
    if (!opts?.interactiveShell) this.assertCommandAllowed(command);

    const groupProvider = opts?.interactiveShell ? undefined : opts?.provider ?? inferProviderFromCommand(command);
    const configured = groupProvider ? getDefaultModelForProvider(this.config, groupProvider) : "";
    const requested = opts?.model?.trim();
    let selector = requested && requested !== "default" ? requested : configured;
    /** 「智能分配」在终端里结算后的落地选择器；不让会话停在哨兵上说不清实际用了什么。 */
    let autoAssignedSelector: string | undefined;
    // 终端在创建时就带着首条提示词（任务派发 / API）时，可以按提示词结算「智能分配」；
    // 交互式终端没有提示词，只能回落默认分组，不能靠猜。
    if (groupProvider && isAutoAssignSelector(selector)) {
      const prompt = initialInput?.trim() ?? "";
      // 没有提示词时的落地值：默认分组（没有分组时才是该工具配置的默认模型）。
      const fallbackGroup = defaultModelGroupSelector(this.config.modelGroups, groupProvider, undefined) ?? "";
      const fallback = fallbackGroup || (isAutoAssignSelector(configured) ? "" : configured);
      if (prompt) {
        const assigned = await resolveAutoAssign({
          provider: groupProvider,
          prompt,
          groups: this.config.modelGroups,
          evaluate: this.resolveDecisionEvaluate(),
          ai: resolveSystemAiContext({
            provider: groupProvider, runner: undefined, command: providerCliCommand(groupProvider),
            structuredState: undefined, selectedModel: null, thinkingEffort: opts?.thinkingEffort,
          }, this.config, this.storage.getSystemSiliconEmployee(), this.free, { storage: this.storage }),
          cwd: resolveSessionCwd(cwd, this.config.defaultCwd),
          language: this.config.language,
        });
        selector = assigned.selector || fallback;
        autoAssignedSelector = assigned.selector || fallback || undefined;
        if (assigned.group) console.info(`[AutoAssign] 终端会话使用分组「${assigned.group.name}」（${assigned.strategy}）`);
      } else {
        console.info("[AutoAssign] 终端会话没有首条提示词，使用默认分组");
        selector = fallback;
        autoAssignedSelector = fallback || undefined;
      }
    }
    const preferredModels = groupProvider ? resolveModelGroupModels(this.config.modelGroups, groupProvider, selector, {
      preferDefault: !requested || requested === "default",
    }) : [requested ?? ""];
    if (preferredModels.some(isOpenRouterFreeSelector)) throw new Error("免费模型分组仅支持 Pi 结构化对话。");
    const baseCwd = resolveSessionCwd(cwd, this.config.defaultCwd);

    if (this.disposed || start.cancelled) throw new Error("终端启动已取消。");
    // When a session is being resumed under the same id, capture its prior
    // structured messages so the new bridge can present them as the chat
    // history. We deliberately do NOT carry over rawOutput — `claude --resume`
    // re-prints its own banner and replayed history into the new PTY, and
    // mixing the two would surface every line twice in the terminal view.
    let priorMessages: ConversationTurn[] = [];
    let inheritedSessionSource: SessionSource | undefined;
    let inheritedAutomationId: string | undefined;
    let inheritedWorkspaceId: string | undefined;
    let inheritedWorkspaceTaskId: string | undefined;
    let inheritedRole: Pick<SessionSnapshot, "employeeId" | "employeeName" | "employeeAvatar" | "systemPrompt"> | undefined;
    if (opts?.reuseId) {
      const oldRecord = this.sessions.get(id);
      if (oldRecord) {
        priorMessages = oldRecord.ptyBridge?.getMessages() ?? oldRecord.messages ?? [];
        inheritedSessionSource = oldRecord.sessionSource;
        inheritedAutomationId = oldRecord.automationId;
        inheritedWorkspaceId = oldRecord.workspaceId;
        inheritedWorkspaceTaskId = oldRecord.workspaceTaskId;
        inheritedRole = oldRecord;
        this.cleanupRecord(oldRecord);
        this.sessions.delete(id);
      } else {
        const stored = this.storage.getSession(id);
        priorMessages = stored?.messages ?? [];
        inheritedSessionSource = stored?.sessionSource;
        inheritedAutomationId = stored?.automationId;
        inheritedWorkspaceId = stored?.workspaceId;
        inheritedWorkspaceTaskId = stored?.workspaceTaskId;
        inheritedRole = stored ?? undefined;
      }
      this.terminalHost.forget(id);
    }
    const worktreeSetup = opts?.worktreeEnabled
      ? prepareSessionWorktree({ cwd: baseCwd, sessionId: id })
      : null;
    const resolvedCwd = worktreeSetup?.cwd ?? baseCwd;
    const provider = opts?.interactiveShell
      ? undefined
      : opts?.provider ?? inferProviderFromCommand(command);
    const effectiveMode = provider === "codex" ? "full-access" : mode;
    const isClaudeProvider = provider === "claude";
    const selectedModel = autoAssignedSelector ?? (opts?.model?.trim() || undefined);
    // Resolve before touching a resume record/worktree; invalid groups must not disturb prior work.
    // PTY has no reliable pre-input acceptance fact: use the preferred member, never replay automatically.
    const initialThinkingEffort = normalizeThinkingEffort(opts?.thinkingEffort);
    let processedCommand = this.processCommandForMode(command, effectiveMode, provider, preferredModels[0], initialThinkingEffort);
    // 会话级系统提示：provider 有系统提示开关就走开关（PTY 与结构化行为一致），没有就并进首条输入。
    const systemPrompt = (opts?.systemPrompt ?? inheritedRole?.systemPrompt)?.trim() || undefined;
    const initialInputText = initialInput && systemPrompt && !systemPromptFlag(provider)
      ? composeSystemFallback(systemPrompt, initialInput)
      : initialInput;
    processedCommand = commandWithSystemPrompt(processedCommand, provider, systemPrompt);
    const isCodexProvider = provider === "codex";
    const isOpenCodeProvider = provider === "opencode";
    const existingProviderSessionId = provider
      ? getProviderCommandSessionId(provider, processedCommand)
        ?? getProviderCommandSessionId(provider, command)
      : null;
    // Grok / Qoder accept caller-selected IDs for new conversations. Assigning
    // one up front avoids depending on provider-specific TUI rendering to learn
    // the durable ID later.
    const assignedProviderSessionId = !existingProviderSessionId && (provider === "grok" || provider === "qoder")
      ? randomUUID()
      : null;
    if (assignedProviderSessionId) {
      processedCommand = `${processedCommand} --session-id ${assignedProviderSessionId}`;
    }
    const knownClaudeTaskIds = isClaudeProvider ? new Set(listRecentClaudeProjectSessionIds(resolvedCwd, new Date().toISOString())) : null;
    const knownClaudeProjectMtimes = isClaudeProvider ? listClaudeProjectSessionMtimes(resolvedCwd) : null;
    const knownCodexSessionMtimes = isCodexProvider && !existingProviderSessionId
      ? listCodexSessionMtimes(this.providerHistory.listCodexHistorySessions())
      : null;
    const knownOpenCodeSessionMtimes = isOpenCodeProvider && !existingProviderSessionId
      ? listOpenCodeSessionMtimes()
      : null;
    const initialClaudeSessionId = existingProviderSessionId ?? assignedProviderSessionId;
    const startedAt = new Date().toISOString();
    const launchPlan = buildPtyShellLaunchPlan({
      shell: this.config.shell,
      command: processedCommand,
      bareShell: opts?.interactiveShell === true,
      providerCommand: provider !== undefined,
    });

    const record: SessionRecord = {
      id,
      sessionSource: opts?.sessionSource ?? inheritedSessionSource ?? "interactive",
      automationId: opts?.automationId ?? inheritedAutomationId,
      systemPrompt: systemPrompt ?? null,
      employeeId: opts?.employeeId ?? inheritedRole?.employeeId,
      employeeName: opts?.employeeName ?? inheritedRole?.employeeName,
      employeeAvatar: opts?.employeeAvatar ?? inheritedRole?.employeeAvatar,
      workspaceId: opts?.workspaceId ?? inheritedWorkspaceId,
      workspaceTaskId: opts?.workspaceTaskId ?? inheritedWorkspaceTaskId,
      provider,
      command,
      cwd: resolvedCwd,
      mode: effectiveMode,
      worktreeEnabled: Boolean(worktreeSetup),
      worktree: worktreeSetup?.worktree ?? null,
      autonomyPolicy: this.defaultAutonomyPolicy(effectiveMode),
      approvalPolicy: "ask-every-time",
      allowedScopes: [],
      status: "running",
      exitCode: null,
      startedAt,
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      permissionBlocked: undefined,
      pendingEscalation: null,
      lastEscalationResult: null,
      claudeSessionId: initialClaudeSessionId,
      processId: null,
      ptyProcess: null,
      terminalState: new PtyTerminalState(
        opts?.cols !== undefined ? clampDimension(opts.cols, 20, 1000) : 120,
        opts?.rows !== undefined ? clampDimension(opts.rows, 5, 500) : 36,
      ),
      providerShellMarker: launchPlan.cliExitMarker,
      providerCliActive: provider !== undefined,
      providerCliExitCode: null,
      stopRequested: false,
      confirmWindow: "",
      ptyPermissionBlocked: false,
      lastAutoConfirmAt: 0,
      autoApprovePermissions: this.shouldAutoApprovePermissions(command, effectiveMode, provider),
      resumedFromSessionId: opts?.resumedFromSessionId ?? (opts?.reuseId ? opts.reuseId : null),
      autoRecovered: opts?.autoRecovered ?? false,
      rememberedEscalationScopes: new Set(),
      rememberedEscalationTargets: new Set(),
      storedOutput: "",
      messages: priorMessages,
      childProcess: null,
      ptyBridge: null,
      knownClaudeTaskIds: knownClaudeTaskIds ?? undefined,
      timers: new SessionTimers(),
      knownClaudeProjectMtimes: knownClaudeProjectMtimes ?? undefined,
      knownCodexSessionMtimes: knownCodexSessionMtimes ?? undefined,
      knownOpenCodeSessionMtimes: knownOpenCodeSessionMtimes ?? undefined,
      approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
      selectedModel: selectedModel ?? null,
      thinkingEffort: initialThinkingEffort,
      ptyCols: opts?.cols !== undefined ? clampDimension(opts.cols, 20, 1000) : 120,
      ptyRows: opts?.rows !== undefined ? clampDimension(opts.rows, 5, 500) : 36,
      ptyOutputSeq: 0,
      ptyLaunchMarkerToken: launchPlan.cliExitMarker?.token ?? null,
    };

    this.sessions.set(id, record);
    this.persist(record, { forceFullSave: true });
    if (initialClaudeSessionId && (provider === "claude" || provider === "codex")) {
      this.providerHistory.invalidate(provider);
    }

    let child: TerminalProcess;
    try {
      const attached = await this.terminalHost.createOrAttach({
        sessionId: id,
        file: this.config.shell,
        args: launchPlan.shellArgs,
        cwd: resolvedCwd,
        env: buildChildEnv(this.config.inheritEnv !== false, {
          WAND_MODE: effectiveMode,
          WAND_AUTO_CONFIRM: record.autoApprovePermissions ? "1" : "0",
          WAND_AUTO_EDIT: effectiveMode === "auto-edit" ? "1" : "0",
          SHELL: this.config.shell,
          LANG: systemEnvValue("LANG") || systemEnvValue("LC_ALL") || systemEnvValue("LC_CTYPE") || "C.UTF-8",
          LC_CTYPE: systemEnvValue("LC_CTYPE") || systemEnvValue("LANG") || systemEnvValue("LC_ALL") || "C.UTF-8",
        }),
        name: "xterm-256color",
        // 使用 record 上由前端协商好的真实尺寸，避免"先 120 列、几百毫秒后再 resize"
        // 期间 provider TUI 用错列宽渲染出 \x1b[120G 这类绝对列定位序列。
        cols: record.ptyCols,
        rows: record.ptyRows,
        launchMarkerToken: launchPlan.cliExitMarker?.token,
      }, record.ptyOutputSeq);
      if (!attached.process || attached.state.status !== "running") {
        throw new Error("Terminal host did not return a running process");
      }
      child = attached.process;
      if (this.disposed || start.cancelled || this.sessions.get(id) !== record) {
        // Explicit stop/delete still owns cancellation. Ordinary server shutdown
        // only detaches persistent hosts: the next server must be able to adopt
        // this in-progress spawn from the durable provisional record.
        if (start.cancelled || !this.terminalHost.persistent) {
          try { child.kill(); } catch { /* best-effort cancellation */ }
        }
        if (!this.disposed) this.terminalHost.forget(id);
        throw new Error("终端启动已取消。");
      }
      record.output = attached.state.output;
      record.storedOutput = attached.state.output;
      record.ptyOutputSeq = attached.state.seq;
      record.ptyLaunchMarkerToken = attached.state.launchMarkerToken;
      record.ptyCols = attached.state.cols;
      record.ptyRows = attached.state.rows;
      record.terminalState?.dispose();
      record.terminalState = restoreTerminalState(attached.state);
      this.initializeClaudeBridge(record, attached.state.output);
    } catch (err) {
      // stop/delete/dispose already committed the authoritative state. Neither
      // a late success nor failure may remove or resurrect that state.
      if (this.disposed || start.cancelled || this.sessions.get(id) !== record) {
        throw new Error("终端启动已取消。");
      }
      console.error("[ProcessManager] terminal spawn failed", { sessionId: id, error: String(err) });
      this.cleanupRecord(record, false);
      this.sessions.delete(id);
      this.lastPersistedMessageState.delete(id);
      this.dirtySessions.delete(id);
      this.terminalHost.forget(id);
      try { this.storage.deleteSession(id); } catch { /* best-effort spawn-failure cleanup */ }
      try { this.logger.deleteSession(id); } catch { /* best-effort spawn-failure cleanup */ }
      throw new Error(describePtySpawnFailure(err));
    }

    record.processId = child.pid;
    record.ptyProcess = child;
    record.status = "running";

    let initialInputSent = false;
    const sendInitialInput = () => {
      if (initialInputSent || !initialInputText) return;
      initialInputSent = true;
      const current = this.sessions.get(id);
      if (current !== record || current.ptyProcess !== child || current.status !== "running") {
        logInfo(`Cannot send initial input: session not ready`);
        return;
      }
      logInfo(`Sending initial input (${initialInputText.length} chars)`);

      if (current.ptyBridge) {
        current.ptyBridge.onUserInput(initialInputText);
      }

      child.write(initialInputText);
      child.write("\r");
      if (!current.ptyBridge) this.openPtyTurn(current);
    };

    this.bindTerminalProcess(record, child, (chunk) => {
      if (initialInputText && !initialInputSent && (chunk.includes("❯") || chunk.includes("›"))) sendInitialInput();
    });
    this.emitEvent({ type: "started", sessionId: id, data: this.snapshot(record) });
    if (initialInputText) this.maybeGenerateSessionTopic(id, initialInputText);

    if (launchPlan.commandToWrite) {
      child.write(launchPlan.commandToWrite);
      child.write("\r");
    }

    if (initialInput) {
      record.timers.initialInput = setTimeout(() => {
        record.timers.initialInput = null;
        if (!initialInputSent) sendInitialInput();
      }, 3000);
      record.timers.initialInput.unref?.();
    }

    // Provider-id discovery polls the provider's on-disk history after launch.
    // Each loop is bounded (attempt cap, backoff, deadline) and is cancelled by
    // exit, stop, cleanup and delete through record.timers.clearAll().
    const isCurrentLiveRecord = (): SessionRecord | null => {
      if (this.disposed) return null;
      const current = this.sessions.get(id);
      if (current !== record || current.ptyProcess !== child || current.status !== "running") return null;
      return current;
    };
    const onDiscoveryExhausted = (kind: ProviderDiscoveryKind) => (attempts: number) => {
      logInfo(`Stopped ${kind} session discovery for ${id} after ${attempts} attempts without a provider session id.`);
    };

    if (record.knownClaudeTaskIds) {
      record.timers.startDiscovery("claude", () => {
        const current = isCurrentLiveRecord();
        if (!current || current.claudeSessionId || !current.knownClaudeTaskIds) return true;
        if (getProviderResumeCommandSessionId("claude", current.command)) return true;
        current.messages = snapshotMessages(current);
        const discoveredTaskId = getLatestClaudeProjectSessionId({
          cwd: current.cwd,
          startedAt: current.startedAt,
          knownClaudeProjectMtimes: current.knownClaudeProjectMtimes,
          messages: current.messages
        });
        if (!discoveredTaskId) return false;
        current.claudeSessionId = discoveredTaskId;
        current.knownClaudeTaskIds.add(discoveredTaskId);
        logInfo(`Discovered Claude resumable project session ID: ${discoveredTaskId}`);
        this.persist(current);
        return true;
      }, onDiscoveryExhausted("claude"));
    }

    if (record.knownCodexSessionMtimes) {
      record.timers.startDiscovery("codex", () => {
        const current = isCurrentLiveRecord();
        if (!current || current.claudeSessionId || !current.knownCodexSessionMtimes) return true;
        if (getProviderResumeCommandSessionId("codex", current.command)) return true;
        if (!this.captureCodexSessionId(current)) return false;
        this.persist(current);
        return true;
      }, onDiscoveryExhausted("codex"));
    }

    if (record.knownOpenCodeSessionMtimes) {
      record.timers.startDiscovery("opencode", () => {
        const current = isCurrentLiveRecord();
        if (!current || current.claudeSessionId || !current.knownOpenCodeSessionMtimes) return true;
        if (getProviderResumeCommandSessionId("opencode", current.command)) return true;
        if (!this.captureOpenCodeSessionId(current)) return false;
        this.persist(current);
        return true;
      }, onDiscoveryExhausted("opencode"));
    }

    return this.snapshot(record);
  }


  list(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshot(session));
  }

  /** Return lightweight snapshots for the session list (no output/messages). */
  listSlim(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshotSlim(session));
  }

  hasClaudeSessionFile(cwd: string, claudeSessionId: string): boolean {
    return isClaudeSessionFileAvailable(cwd, claudeSessionId);
  }

  listClaudeHistorySessions(): ClaudeHistorySession[] {
    return this.markManagedHistory(this.providerHistory.listClaudeHistorySessions(), "claude");
  }

  deleteClaudeHistoryFiles(sessions: { claudeSessionId: string; cwd: string }[]): number {
    return this.providerHistory.deleteClaudeHistoryFiles(sessions);
  }

  listCodexHistorySessions(): CodexHistorySession[] {
    // codex 的 thread id 也存在 claudeSessionId 字段，见 markManagedHistory。
    return this.markManagedHistory(this.providerHistory.listCodexHistorySessions(), "codex");
  }

  /** Flags history rows that wand already manages, keyed by the provider id stored on the record. */
  private markManagedHistory<T extends { claudeSessionId: string; managedByWand?: boolean }>(
    sessions: T[],
    provider: "claude" | "codex",
  ): T[] {
    const managedIds = new Set<string>();
    for (const record of this.sessions.values()) {
      if (record.provider === provider && record.claudeSessionId) managedIds.add(record.claudeSessionId);
    }
    for (const session of sessions) {
      if (managedIds.has(session.claudeSessionId)) session.managedByWand = true;
    }
    return sessions;
  }

  hasCodexSessionFile(threadId: string): boolean {
    return this.providerHistory.hasCodexSessionFile(threadId);
  }

  deleteCodexHistoryFiles(threadIds: string[]): number {
    return this.providerHistory.deleteCodexHistoryFiles(threadIds);
  }

  listOpenCodeHistorySessions(): OpenCodeHistorySession[] {
    return this.providerHistory.listOpenCodeHistorySessions();
  }

  deleteOpenCodeHistorySessions(sessionIds: string[]): number {
    return this.providerHistory.deleteOpenCodeHistorySessions(sessionIds);
  }

  listQoderHistorySessions(): QoderHistorySession[] {
    return this.providerHistory.listQoderHistorySessions();
  }

  deleteQoderHistoryFiles(sessionIds: string[]): number {
    return this.providerHistory.deleteQoderHistoryFiles(sessionIds);
  }

  deletePiHistoryFiles(sessionIds: string[]): number {
    // Structured Pi uses harness.agentDir, which may differ from the CLI default.
    // PTY Pi uses the default root. Remove the exact IDs from both, never a root.
    const configured = path.join(coreHarnessAgentDir(this.config.harness), "sessions");
    const defaults = path.join(buildChildEnv(this.config.inheritEnv !== false).PI_CODING_AGENT_DIR?.trim()
      || path.join(os.homedir(), ".pi", "agent"), "sessions");
    let deleted = new ProviderHistoryScanner({ piSessionsDir: configured }).deletePiHistoryFiles(sessionIds);
    if (path.resolve(defaults) !== path.resolve(configured)) {
      deleted += new ProviderHistoryScanner({ piSessionsDir: defaults }).deletePiHistoryFiles(sessionIds);
    }
    return deleted;
  }

  deleteGrokHistoryFiles(sessionIds: string[]): number {
    return this.providerHistory.deleteGrokHistoryFiles(sessionIds);
  }


  private captureCodexSessionId(record: SessionRecord, options?: { allowTimeWindowFallback?: boolean }): boolean {
    if (record.provider !== "codex" || record.claudeSessionId) {
      return false;
    }
    const discoveredThreadId = record.knownCodexSessionMtimes
      ? getLatestCodexSessionId({
          cwd: record.cwd,
          startedAt: record.startedAt,
          knownCodexSessionMtimes: record.knownCodexSessionMtimes,
        }, this.providerHistory.listCodexHistorySessions())
      : null;
    const fallbackThreadId = discoveredThreadId
      ? null
      : options?.allowTimeWindowFallback
        ? selectCodexSessionForTimeWindow(record, this.providerHistory.listCodexHistorySessions())?.claudeSessionId ?? null
        : null;
    const threadId = discoveredThreadId ?? fallbackThreadId;
    if (!threadId) {
      return false;
    }
    record.claudeSessionId = threadId;
    record.knownCodexSessionMtimes?.set(threadId, Date.now());
    this.providerHistory.invalidate("codex");
    logInfo(`Captured Codex thread ID: ${threadId}`);
    return true;
  }

  private captureOpenCodeSessionId(record: SessionRecord, options?: { allowTimeWindowFallback?: boolean }): boolean {
    if (record.provider !== "opencode" || record.claudeSessionId) return false;
    const discovered = record.knownOpenCodeSessionMtimes
      ? selectOpenCodeSessionForRecord(record)
      : null;
    const fallback = discovered
      ? null
      : options?.allowTimeWindowFallback
        ? selectOpenCodeSessionForTimeWindow(record)
        : null;
    const providerSessionId = discovered?.id ?? fallback?.id ?? null;
    if (!providerSessionId) return false;
    record.claudeSessionId = providerSessionId;
    record.knownOpenCodeSessionMtimes?.set(providerSessionId, discovered?.updatedAtMs ?? fallback?.updatedAtMs ?? Date.now());
    logInfo(`Captured OpenCode session ID: ${providerSessionId}`);
    return true;
  }

  private captureClaudeSessionId(record: SessionRecord, options?: { allowTimeWindowFallback?: boolean }): boolean {
    if (record.provider !== "claude" || record.claudeSessionId) {
      return false;
    }
    record.messages = snapshotMessages(record);
    const discoveredSessionId = record.knownClaudeProjectMtimes
      ? getLatestClaudeProjectSessionId({
          cwd: record.cwd,
          startedAt: record.startedAt,
          knownClaudeProjectMtimes: record.knownClaudeProjectMtimes,
          messages: record.messages,
        })
      : null;
    const fallbackSessionId = discoveredSessionId
      ? null
      : options?.allowTimeWindowFallback
        ? selectClaudeProjectSessionForTimeWindow(record)?.id ?? null
        : null;
    const sessionId = discoveredSessionId ?? fallbackSessionId;
    if (!sessionId) {
      return false;
    }
    record.claudeSessionId = sessionId;
    record.knownClaudeProjectMtimes?.set(sessionId, Date.now());
    this.providerHistory.invalidate("claude");
    logInfo(`Captured Claude session ID: ${sessionId}`);
    return true;
  }

  get(id: string): SessionSnapshot | null {
    const record = this.sessions.get(id);
    if (!record) {
      return this.storage.getSession(id) ?? null;
    }
    const result = this.snapshot(record);
    if (!record.output && record.storedOutput) {
      result.output = record.storedOutput;
    }
    return result;
  }

  /** Return only a session owned by this manager, without the SQLite fallback used by get(). */
  getOwned(id: string): SessionSnapshot | null {
    this.terminalHost.flush?.();
    const record = this.sessions.get(id);
    if (!record) return null;
    const result = this.snapshot(record);
    if (!record.output && record.storedOutput) result.output = record.storedOutput;
    return result;
  }

  getOwnedSlim(id: string): SessionSnapshot | null {
    this.terminalHost.flush?.();
    const record = this.sessions.get(id);
    return record ? this.snapshotSlim(record) : null;
  }

  getPtyTranscript(id: string): string | null {
    return this.logger.readPtyOutputTail(id);
  }

  /**
   * Set the Claude model for an existing PTY session. Persists the selection
   * and, when the session is live, pipes a `/model <id>` slash command into
   * the PTY so Claude Code switches on the fly.
   */
  setSessionModel(id: string, model: string | null): SessionSnapshot {
    const record = this.mustGet(id);
    const normalized = model?.trim() || null;
    const configured = record.provider ? getDefaultModelForProvider(this.config, record.provider) : "";
    const selector = normalized && normalized !== "default" ? normalized : configured;
    const members = resolveModelGroupModels(this.config.modelGroups, record.provider ?? "claude", selector, {
      preferDefault: !normalized || normalized === "default",
    });
    if (members.some(isOpenRouterFreeSelector)) throw new Error("免费分组仅支持 Pi 结构化对话。");
    record.selectedModel = normalized;
    if (record.providerCliActive && record.provider === "claude" && record.status === "running" && record.ptyProcess) {
      const value = members[0] && members[0] !== "default" ? members[0] : "default";
      record.ptyProcess.write(`/model ${value}\r`);
    }
    this.persist(record);
    this.emitEvent({ type: "status", sessionId: id, data: { selectedModel: normalized } });
    return this.snapshot(record);
  }

  /**
   * 归档只写标记，保留正在运行的终端、会话 ID 和 provider session id。
   * 取消归档只清标记；重新拉起由恢复入口负责。
   */
  setSessionArchived(id: string, archived: boolean): SessionSnapshot {
    const record = this.mustGet(id);
    record.archived = archived;
    record.archivedAt = archived ? (record.archivedAt ?? new Date().toISOString()) : null;
    this.persist(record);
    this.emitEvent({
      type: "status",
      sessionId: id,
      data: { archived, archivedAt: record.archivedAt, claudeSessionId: record.claudeSessionId },
    });
    return this.snapshot(record);
  }

  /**
   * Set the thinking-effort level for a PTY session. Interactive Claude supports
   * this through /effort; off maps to auto, which restores the model default.
   */
  setSessionThinkingEffort(id: string, effort: SessionSnapshot["thinkingEffort"]): SessionSnapshot {
    const record = this.mustGet(id);
    const normalized = normalizeThinkingEffort(effort);
    record.thinkingEffort = normalized;
    if (record.providerCliActive && record.provider === "claude" && record.status === "running" && record.ptyProcess) {
      record.ptyProcess.write(`/effort ${thinkingEffortToClaudeSlashEffort(normalized)}\r`);
    }
    this.persist(record);
    this.emitEvent({ type: "status", sessionId: id, data: { thinkingEffort: normalized } });
    return this.snapshot(record);
  }

  /**
   * Switch the execution mode of a PTY session mid-flight. The already-launched
   * provider process keeps its original CLI flags, but wand's own permission
   * auto-approval (shouldAutoApprovePermissions / escalation handling) reads
   * record.mode, so this changes the permission posture for subsequent prompts.
   * Mirrors setSessionModel/setSessionThinkingEffort.
   */
  setSessionMode(id: string, mode: ExecutionMode): SessionSnapshot {
    const record = this.mustGet(id);
    record.mode = mode;
    record.autoApprovePermissions = this.shouldAutoApprovePermissions(
      record.command,
      mode,
      record.provider ?? "claude",
    );
    if (record.ptyBridge) {
      record.ptyBridge.setAutoApprove(record.autoApprovePermissions);
    }
    this.persist(record);
    this.emitEvent({
      type: "status",
      sessionId: id,
      data: { mode, autoApprovePermissions: record.autoApprovePermissions },
    });
    return this.snapshot(record);
  }

  sendInput(id: string, input: string, view?: "chat" | "terminal", shortcutKey?: string, trackUserInput = true): SessionSnapshot {
    const record = this.preparePtyInput(id, input, view, shortcutKey, trackUserInput);
    record.ptyProcess!.write(input);
    this.persist(record);
    return this.snapshot(record);
  }

  async sendInputConfirmed(
    id: string,
    input: string,
    view?: "chat" | "terminal",
    shortcutKey?: string,
    trackUserInput = true,
  ): Promise<SessionSnapshot> {
    const record = this.validatePtyInput(id);
    const terminal = record.ptyProcess!;
    try {
      if (terminal.writeConfirmed) await terminal.writeConfirmed(input);
      else terminal.write(input);
    } catch (cause) {
      throw new PtyInputDeliveryError(id, cause);
    }
    const current = this.sessions.get(id);
    if (current !== record || record.ptyProcess !== terminal) {
      // The write reached an old PTY, but the caller cannot treat it as input
      // accepted by the current incarnation or persist the stale record.
      throw new PtyInputDeliveryError(id, new Error("PTY incarnation changed during write"));
    }
    this.trackPtyInput(record, input, view, shortcutKey, trackUserInput);
    this.persist(record);
    return this.snapshot(record);
  }

  private preparePtyInput(
    id: string,
    input: string,
    view?: "chat" | "terminal",
    shortcutKey?: string,
    trackUserInput = true,
  ): SessionRecord {
    const record = this.validatePtyInput(id);
    this.trackPtyInput(record, input, view, shortcutKey, trackUserInput);
    return record;
  }

  private validatePtyInput(id: string): SessionRecord {
    if (this.disposed) throw new Error("ProcessManager has been disposed.");
    const record = this.mustGet(id);

    if (record.status !== "running") {
      console.error(`[ProcessManager] Rejecting input: session ${id} not running (${record.status})`);
      throw new SessionInputError("Session is not running.", "SESSION_NOT_RUNNING", id, record.status);
    }

    // Update lifecycle

    if (!record.ptyProcess) {
      console.error(`[ProcessManager] Rejecting input: session ${id} has no PTY`);
      throw new SessionInputError("Session is not running.", "SESSION_NO_PTY", id, record.status);
    }
    return record;
  }

  private trackPtyInput(
    record: SessionRecord,
    input: string,
    view?: "chat" | "terminal",
    shortcutKey?: string,
    trackUserInput = true,
  ): void {
    const id = record.id;
    if (!record.ptyTopicDraft) record.ptyTopicDraft = createPtyTopicLineBuffer();
    const topicInput = consumePtyInputForTopic(record.ptyTopicDraft, input, view, shortcutKey);
    if (topicInput) this.maybeGenerateSessionTopic(id, topicInput);

    // Log shortcut key interactions for auto-confirm and mode analysis
    if (shortcutKey) {
      const outputLines = record.output.split("\n");
      const tailLines = outputLines.slice(-15).join("\n");
      const ctx: ShortcutLogContext = {
        mode: record.mode,
        autoApprove: record.autoApprovePermissions,
        permissionBlocked: this.isPermissionBlocked(record),
        input,
      };
      this.logger.appendShortcutLog(id, shortcutKey, tailLines, ctx);
    }

    // Track user input via bridge for Chat mode
    if (record.ptyBridge && trackUserInput) {
      record.ptyBridge.onUserInput(input);
    }
    // Non-Claude CLIs report no parsed boundary, so a line submit opens a turn
    // that a quiet window later closes.
    if (trackUserInput && !record.ptyBridge && isPtySubmitInput(input)) {
      this.openPtyTurn(record);
    }

  }

  resize(id: string, cols: number, rows: number): SessionSnapshot {
    const record = this.mustGet(id);
    if (!record.ptyProcess || record.status !== "running") {
      return this.snapshot(record);
    }

    const safeCols = clampDimension(cols, 20, 1000);
    const safeRows = clampDimension(rows, 5, 500);
    const changed = safeCols !== record.ptyCols || safeRows !== record.ptyRows;
    if (!changed) return this.snapshot(record);
    record.ptyProcess.resize(safeCols, safeRows);
    record.terminalState?.resize(safeCols, safeRows);
    record.ptyCols = safeCols;
    record.ptyRows = safeRows;
    // Notify every subscribed client of the new authoritative dimensions so
    // any other tab/device can re-fit its terminal instead of rendering
    // wrap-broken output sized for someone else's viewport.
    this.emitEvent({
      type: "status",
      sessionId: id,
      data: { ptyCols: safeCols, ptyRows: safeRows },
    });
    return this.snapshot(record);
  }

  getTerminalState(id: string): PtyTerminalSnapshot | null {
    this.terminalHost.flush?.();
    const record = this.sessions.get(id);
    if (!record) return null;
    if (!record.terminalState) {
      record.terminalState = new PtyTerminalState(record.ptyCols, record.ptyRows, record.output || record.storedOutput);
    }
    return record.terminalState.snapshot();
  }

  async getTerminalHistoryPage(id: string, before: number, revision: number): Promise<PtyHistoryPage | null> {
    const record = this.sessions.get(id);
    if (!record) return null;
    if (!record.terminalState) this.getTerminalState(id);
    return record.terminalState?.historyPage(before, revision) ?? null;
  }

  /**
   * Finalize provider-only state while leaving the owning PTY shell alive. The
   * session itself remains running so terminal input can continue normally.
   */
  private finishProviderCli(record: SessionRecord, exitCode: number): void {
    if (!record.providerCliActive) return;

    record.providerCliActive = false;
    record.providerCliExitCode = exitCode;
    record.providerShellMarker = null;
    record.ptyLaunchMarkerToken = null;
    this.clearPtyTurn(record);
    record.ptyBusy = false;

    record.timers.clearAll();

    if (record.ptyBridge) {
      record.ptyBridge.onExit(exitCode);
      record.messages = record.ptyBridge.getMessages();
    }
    record.pendingEscalation = null;
    record.ptyPermissionBlocked = false;
    this.captureClaudeSessionId(record, { allowTimeWindowFallback: true });
    this.captureCodexSessionId(record, { allowTimeWindowFallback: true });
    this.captureOpenCodeSessionId(record, { allowTimeWindowFallback: true });
    if (record.ptyBridge) {
      record.output = record.ptyBridge.getRawOutput();
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }

    this.flushPersist(record);
    this.emitEvent({
      type: "status",
      sessionId: record.id,
      data: {
        providerCliActive: false,
        providerCliExitCode: exitCode,
        permissionBlocked: false,
      },
    });
  }

  stop(id: string): SessionSnapshot {
    const record = this.mustGet(id);
    const start = this.startingSessions.get(id);
    if (start) start.cancelled = true;
    if (record.status !== "running") {
      return this.snapshot(record);
    }

    record.timers.clearAll();

    record.stopRequested = true;
    record.providerCliActive = false;
    record.providerShellMarker = null;
    record.ptyLaunchMarkerToken = null;
    this.clearPtyTurn(record);
    record.ptyBusy = false;
    // Kill any running child process (from JSON chat turns)
    if (record.childProcess) {
      record.childProcess.kill();
      record.childProcess = null;
    }
    // Kill the PTY process
    if (record.ptyProcess) {
      record.ptyProcess.kill();
    }

    // Immediately update status and clear PTY references so the session no longer
    // appears "running" and subsequent sendInput() calls are rejected cleanly.
    // Clearing the handle also makes a later onExit callback stale; stop() owns
    // the terminal state transition and persistence from this point onward.
    record.status = "stopped";
    record.exitCode = null;
    record.endedAt = new Date().toISOString();
    record.ptyProcess = null;
    // Update lifecycle before dropping the bridge so Claude project-session
    // discovery can still inspect the latest parsed turns.
    this.captureClaudeSessionId(record, { allowTimeWindowFallback: true });
    this.captureCodexSessionId(record, { allowTimeWindowFallback: true });
    this.captureOpenCodeSessionId(record, { allowTimeWindowFallback: true });
    if (record.ptyBridge) {
      record.messages = record.ptyBridge.getMessages();
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }

    this.flushPersist(record, true);
    // handleTerminalExit 会因为 ptyProcess 已被清空而把这次异步退出判定为过期回调并
    // return，所以主动停止必须自己广播 ended。少了这一步，各端会一直以为会话还在跑：
    // 直通输入框不关闭，附件/发送全都打进已经死掉的 PTY。结构化 stop() 同样发 ended。
    this.emitEvent({ type: "ended", sessionId: record.id, data: this.snapshot(record) });
    return this.snapshot(record);
  }

  private cleanupRecord(record: SessionRecord, terminateTerminal = true): void {
    this.clearPtyTurn(record);
    record.timers.clearAll();
    const pendingPersist = this.persistDebounceTimers.get(record.id);
    if (pendingPersist) {
      clearTimeout(pendingPersist);
      this.persistDebounceTimers.delete(record.id);
    }
    if (record.status === "running") {
      if (terminateTerminal) record.stopRequested = true;
      if (record.childProcess) {
        const child = record.childProcess;
        record.childProcess = null;
        child.kill();
      }
      if (record.ptyProcess && terminateTerminal) {
        const ptyProcess = record.ptyProcess;
        ptyProcess.kill();
      }
      record.ptyProcess = null;
    }
    if (record.ptyBridge) {
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }
    record.terminalState?.dispose();
    record.terminalState = null;
  }

  /** Capture before delete drops the process handles. Never unlink a live CLI's history. */
  nativeHistoryCleanupBarrier(id: string): Promise<void> | null {
    const existing = this.nativeCleanupBarriers.get(id);
    if (existing) return existing;
    const record = this.sessions.get(id);
    if (!record) return null;
    if (this.startingSessions.has(id)) {
      return Promise.reject(new Error("CLI startup is still pending; session artifacts were preserved."));
    }
    const waits: Promise<void>[] = [];
    if (record.ptyProcess) {
      const terminal = record.ptyProcess;
      waits.push(waitForSessionProcessExit((done) => {
        const listener = terminal.onExit((event) => {
          // A missing remote inventory entry is reported as -1, not an OS exit.
          if (event.exitCode >= 0) done();
        });
        return () => listener.dispose();
      }));
    }
    const child = record.childProcess;
    if (child && child.exitCode === null && child.signalCode === null) {
      waits.push(waitForSessionProcessExit((done) => {
        child.once("close", done);
        return () => { child.off("close", done); };
      }));
    }
    if (!waits.length) return null;
    const barrier = Promise.all(waits).then(() => {});
    this.nativeCleanupBarriers.set(id, barrier);
    return barrier;
  }

  delete(id: string): void {
    const record = this.mustGet(id);
    const start = this.startingSessions.get(id);
    if (start) start.cancelled = true;

    // Always clear pending timers
    // 会话删除后迟到的回合回调要失效，静默心跳也不能再给不存在的会话发事件。
    this.ptyHeartbeat.cancel(id);
    record.timers.clearAll();
    const pendingPersist = this.persistDebounceTimers.get(id);
    if (pendingPersist) {
      clearTimeout(pendingPersist);
      this.persistDebounceTimers.delete(id);
    }

    // Kill live processes if still running
    if (record.status === "running") {
      try {
        record.stopRequested = true;
        // For native mode, kill the child process
        if ((record.mode === "native" || record.mode === "managed") && record.childProcess) {
          record.childProcess.kill();
        }
        // For PTY mode, kill the pty process
        if (record.ptyProcess) {
          record.ptyProcess.kill();
        }
      } catch {
        // Ignore and continue deleting persisted state.
      }
    }

    // Always clean up all state references, regardless of current status
    record.childProcess = null;
    record.ptyProcess = null;
    if (record.ptyBridge) {
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }
    record.terminalState?.dispose();
    record.terminalState = null;

    const barrier = this.nativeCleanupBarriers.get(id);
    if (barrier) {
      const forget = () => {
        this.nativeCleanupBarriers.delete(id);
        if (!this.sessions.has(id)) this.terminalHost.forget(id);
      };
      // Keep remote handles until their exit event has reached the barrier.
      void barrier.then(forget, forget);
    } else this.terminalHost.forget(id);

    // Delete from persistent storage BEFORE removing from in-memory map,
    // so a storage failure doesn't leave orphan records in the database.
    this.storage.deleteSession(id);
    this.logger.deleteSession(id);
    if (record.provider === "claude") {
      this.deleteClaudeCache(record);
    }
    this.sessions.delete(id);
    this.lastPersistedMessageState.delete(id);
    this.dirtySessions.delete(id);
    if (record.claudeSessionId) {
      if (record.provider === "codex") {
        this.providerHistory.invalidate("codex");
      } else {
        this.providerHistory.invalidate("claude");
      }
    }
  }

  private deleteClaudeCache(record: Pick<SessionRecord, "claudeSessionId" | "cwd">): void {
    if (!record.claudeSessionId) return;
    const id = record.claudeSessionId;

    // 1. Delete the project JSONL file
    const jsonlPath = path.join(getClaudeProjectDir(record.cwd), `${id}.jsonl`);
    try {
      if (existsSync(jsonlPath)) unlinkSync(jsonlPath);
    } catch {
      // Non-critical — best-effort
    }

    // 2. Delete related directories under ~/.claude/
    const claudeHome = path.join(os.homedir(), ".claude");
    for (const sub of ["session-env", "tasks", "todos"]) {
      const dir = path.join(claudeHome, sub, id);
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch {
        // Non-critical — best-effort
      }
    }
  }

  async runStartupCommands(): Promise<SessionSnapshot[]> {
    return Promise.all(this.config.startupCommands.map((command) =>
      this.start(command, this.config.defaultCwd, this.config.defaultMode, undefined, { sessionSource: "startup" })
    ));
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    // Get messages from bridge if available, otherwise use stored messages
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    return {
      id: record.id,
      sessionKind: "pty",
      sessionSource: record.sessionSource ?? "interactive",
      automationId: record.automationId,
      // 会话级系统提示要跟着快照回库（persist 就是走 snapshot），否则重启后 resume 会丢掉角色与规则。
      systemPrompt: record.systemPrompt ?? null,
      employeeId: record.employeeId,
      employeeName: record.employeeName,
      employeeAvatar: record.employeeAvatar,
      provider: record.provider,
      providerCliActive: record.providerCliActive,
      providerCliExitCode: record.providerCliExitCode,
      ptyBusy: record.ptyBridge ? record.ptyBridge.isResponding() : record.ptyBusy === true,
      ptyCommandRunning: record.status === "running" && record.ptyProcess !== null
        && !record.provider && record.ptyForeground === true,
      // 与 ptyBusy 同生命周期的本轮锚点。运行时事实：存储没有对应列，重启后为 null。
      ptyTurnStartedAt: record.ptyTurnStartedAt ?? null,
      ptyLastActivityAt: record.ptyLastActivityAt ?? null,
      runner: "pty",
      command: record.command,
      cwd: record.cwd,
      mode: record.mode,
      worktreeEnabled: record.worktreeEnabled ?? false,
      worktree: record.worktree ?? null,
      worktreeMergeStatus: record.worktreeMergeStatus,
      worktreeMergeInfo: record.worktreeMergeInfo ?? null,
      autonomyPolicy: record.autonomyPolicy,
      approvalPolicy: record.approvalPolicy,
      allowedScopes: record.allowedScopes,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      output: record.output,
      archived: record.archived,
      archivedAt: record.archivedAt,
      permissionBlocked: this.isPermissionBlocked(record),
      pendingEscalation: record.pendingEscalation || undefined,
      lastEscalationResult: record.lastEscalationResult || undefined,
      claudeSessionId: record.claudeSessionId || null,
      messages: messages.length > 0 ? messages : undefined,
      resumedFromSessionId: record.resumedFromSessionId ?? undefined,
      autoRecovered: record.autoRecovered ?? false,
      // `false` is an intentional user setting and must survive metadata
      // persistence/restarts; truthiness would silently drop it.
      autoApprovePermissions: record.autoApprovePermissions,
      approvalStats: record.approvalStats.total > 0 ? record.approvalStats : undefined,
      currentTaskTitle: record.currentTaskTitle,
      summary: record.description ?? record.summary ?? deriveSessionSummary(messages),
      title: record.title,
      description: record.description,
      selectedModel: record.selectedModel ?? null,
      thinkingEffort: record.thinkingEffort ?? null,
      ptyCols: record.ptyCols,
      ptyRows: record.ptyRows,
      ptyOutputSeq: record.ptyOutputSeq ?? 0,
      ptyLaunchMarkerToken: record.ptyLaunchMarkerToken ?? null,
      workspaceId: record.workspaceId,
      workspaceTaskId: record.workspaceTaskId,
    };
  }

  /** Lightweight snapshot for list views — omits output and messages. */
  private snapshotSlim(record: SessionRecord): SessionSnapshot {
    const snapshot = this.snapshot(record);
    return {
      ...snapshot,
      output: "",
      messages: undefined,
    };
  }

  private isPermissionBlocked(record: SessionRecord): boolean {
    return record.ptyPermissionBlocked || record.pendingEscalation !== null;
  }

  setSessionWorkspace(id: string, membership: Pick<SessionSnapshot, "workspaceId" | "workspaceTaskId">): void {
    Object.assign(this.mustGet(id), membership);
    this.emitEvent({ type: "status", sessionId: id, data: membership });
  }

  setSessionTopic(id: string, title: string, description: string): SessionSnapshot {
    const record = this.mustGet(id);
    record.title = title;
    record.description = description;
    const snapshot = this.snapshot(record);
    this.storage.updateSessionRuntimeMetadata({ ...snapshot, titleGenerating: undefined });
    // status, not output: PTY chunks share the output debounce window, and a
    // merged incremental+chunk frame is treated as chunk-only by the web client.
    this.emitEvent({ type: "status", sessionId: id, data: { title, description, summary: description } });
    return snapshot;
  }

  private setSessionTopicGenerating(id: string, titleGenerating: boolean): void {
    const record = this.sessions.get(id);
    if (!record || record.titleGenerating === titleGenerating) return;
    record.titleGenerating = titleGenerating;
    this.emitEvent({ type: "status", sessionId: id, data: { titleGenerating } });
  }

  /**
   * Persist worktree merge progress through the manager that owns the live
   * session record. Returning null lets callers fall back to another owner (or
   * directly to storage for a row that is not currently loaded by a manager).
   */
  setWorktreeMergeState(
    id: string,
    status: SessionSnapshot["worktreeMergeStatus"],
    info: SessionSnapshot["worktreeMergeInfo"],
  ): SessionSnapshot | null {
    const record = this.sessions.get(id);
    if (!record) return null;
    record.worktreeMergeStatus = status;
    record.worktreeMergeInfo = info ?? null;
    const snapshot = this.snapshot(record);
    this.storage.updateSessionRuntimeMetadata(snapshot);
    this.emitEvent({
      type: "status",
      sessionId: id,
      data: {
        sessionKind: "pty",
        worktreeMergeStatus: status,
        worktreeMergeInfo: snapshot.worktreeMergeInfo,
      },
    });
    return snapshot;
  }

  private maybeGenerateSessionTopic(id: string, input: string): void {
    const prompt = input.trim();
    const record = this.sessions.get(id);
    if (this.disposed || !prompt || !record) return;
    // 迭代提示词记录：和会话标题共用同一套「有没有信息量」判断，用户不用多做一步。
    recordIterationPrompt(this.storage, record, prompt, "session");
    // 空白终端只执行 Shell 命令，不生成会话标题或调用系统员工总结。
    if (!isSessionProvider(record.provider)) return;
    this.metadata.generateTopicForPrompt(id, prompt);
  }

  private defaultAutonomyPolicy(mode: ExecutionMode): AutonomyPolicy {
    if (mode === "agent" || mode === "agent-max" || mode === "managed" || mode === "native" || mode === "full-access") {
      return "agent";
    }
    return "assist";
  }

  resolveEscalation(id: string, requestId: string, resolution?: PermissionResolution): SessionSnapshot {
    return this.resolvePermission(id, resolution ?? "approve_once", requestId);
  }

  approvePermission(id: string): SessionSnapshot {
    return this.resolvePermission(id, "approve_once");
  }

  denyPermission(id: string): SessionSnapshot {
    return this.resolvePermission(id, "deny");
  }

  toggleAutoApprove(id: string): SessionSnapshot {
    const record = this.mustGet(id);
    record.autoApprovePermissions = !record.autoApprovePermissions;
    if (record.ptyBridge) {
      record.ptyBridge.setAutoApprove(record.autoApprovePermissions);
    }
    this.persist(record);
    return this.snapshot(record);
  }

  /**
   * Canonical permission resolution method.
   * All other permission methods delegate to this.
   * @param resolution - "approve_once", "approve_turn", or "deny"
   * @param requestId - Optional escalation request ID for validation
   */
  resolvePermission(id: string, resolution: PermissionResolution, requestId?: string): SessionSnapshot {
    const record = this.mustGet(id);

    if (resolution !== "approve_once" && resolution !== "approve_turn" && resolution !== "deny") {
      throw new Error("Invalid permission resolution.");
    }

    // A permission response is only meaningful for the currently pending
    // prompt. In particular, never turn a stale/missing escalation request into
    // an unconditional Enter key sent to the live provider process.
    const pendingEscalation = record.pendingEscalation;
    if (!pendingEscalation) {
      throw new Error("Escalation request not found.");
    }
    if (requestId !== undefined && pendingEscalation.requestId !== requestId) {
      throw new Error("Escalation request not found.");
    }

    // Record escalation result for audit trail
    record.lastEscalationResult = {
      requestId: pendingEscalation.requestId,
      resolution,
      reason: pendingEscalation.reason,
    };

    // Handle "approve_turn" memory — only in ProcessManager for non-bridge sessions
    if (resolution === "approve_turn" && !record.ptyBridge) {
      record.rememberedEscalationScopes.add(pendingEscalation.scope);
      if (pendingEscalation.target) {
        record.rememberedEscalationTargets.add(pendingEscalation.target);
      }
    }

    // Resolve via bridge or direct PTY write
    if (record.ptyBridge) {
      record.ptyBridge.resolvePermission(resolution);
    } else if (record.ptyProcess && record.status === "running") {
      record.ptyProcess.write(resolution === "deny" ? "n\r" : "\r");
    }

    record.ptyPermissionBlocked = false;
    record.pendingEscalation = null;
    this.persist(record);
    return this.snapshot(record);
  }

  private persist(
    record: SessionRecord,
    options: {
      forceFullSave?: boolean;
      metadataDirty?: boolean;
      outputDirty?: boolean;
      messagesDirty?: boolean;
    } = {},
  ): void {
    this.markDirty(record.id, {
      metadata: options.metadataDirty ?? true,
      output: options.outputDirty,
      messages: options.messagesDirty,
    });
    // Update messages from bridge before persisting
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    if (messages !== record.messages) {
      record.messages = messages;
    }
    const snapshot = this.snapshot(record);
    const dirty = this.dirtySessions.get(record.id)!;
    if (shouldPersistMessages(this.lastPersistedMessageState.get(record.id), messages)) {
      dirty.messages = true;
    }
    const shouldSaveMessages = options.forceFullSave === true || dirty.messages;
    const shouldSaveMetadata = options.forceFullSave === true || dirty.metadata;

    if (options.forceFullSave === true) {
      this.storage.saveSession(snapshot);
    } else {
      if (dirty.metadata) this.storage.updateSessionRuntimeMetadata(snapshot);
      if (dirty.messages) {
        this.storage.checkpointSessionMessages(
          record.id,
          messages,
          snapshot.structuredState,
          dirty.output ? snapshot.output : undefined,
          dirty.output ? snapshot.ptyOutputSeq : undefined,
        );
        dirty.output = false;
      } else if (dirty.output) {
        this.storage.checkpointSessionOutput(record.id, snapshot.output, snapshot.ptyOutputSeq);
      }
    }
    if (shouldSaveMessages) this.lastPersistedMessageState.set(record.id, getPersistedMessageState(messages));
    this.dirtySessions.delete(record.id);

    if (shouldSaveMetadata) {
      this.logger.saveMetadata(record.id, {
        id: record.id,
        command: record.command,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        claudeSessionId: record.claudeSessionId,
        resumedFromSessionId: record.resumedFromSessionId ?? null,
        autoRecovered: record.autoRecovered ?? false,
      });
    }
    if (shouldSaveMessages) {
      this.logger.saveMessages(record.id, messages);
    }
  }

  private markDirty(sessionId: string, next: Partial<SessionDirtyState>): SessionDirtyState {
    const dirty = this.dirtySessions.get(sessionId) ?? { metadata: false, output: false, messages: false };
    if (next.metadata) dirty.metadata = true;
    if (next.output) dirty.output = true;
    if (next.messages) dirty.messages = true;
    this.dirtySessions.set(sessionId, dirty);
    return dirty;
  }

  /**
   * Schedule a debounced persist call for the given record.
   * Multiple calls within the debounce window are coalesced into a single write.
   * Use this in hot paths (e.g. onData) to reduce I/O pressure.
   */
  private schedulePersist(record: SessionRecord): void {
    if (this.disposed) return;
    this.markDirty(record.id, { output: true });
    const existing = this.persistDebounceTimers.get(record.id);
    // This is a throttle window, not a quiet-period debounce: continuous PTY
    // output still reaches SQLite at least once per second.
    if (existing) return;
    const timer = setTimeout(() => {
      this.persistDebounceTimers.delete(record.id);
      if (this.disposed) return;
      this.persist(record, { metadataDirty: false });
    }, 1000);
    timer.unref?.();
    this.persistDebounceTimers.set(record.id, timer);
  }

  /**
   * Immediately persist any pending debounced write and clear the timer.
   * Use this at critical points (exit, stop, delete) to ensure no data loss.
   */
  private flushPersist(record: SessionRecord, forceFullSave = false): void {
    const existing = this.persistDebounceTimers.get(record.id);
    if (existing) {
      clearTimeout(existing);
      this.persistDebounceTimers.delete(record.id);
    }
    this.persist(record, {
      forceFullSave,
      metadataDirty: true,
      outputDirty: true,
      messagesDirty: forceFullSave,
    });
  }

  private assertCommandAllowed(command: string): void {
    if (!isCommandAllowedByPrefixes(command, this.config.allowedCommandPrefixes)) {
      throw new Error("Command is not allowed by current configuration.");
    }
  }

  /**
   * @deprecated Only retained for non-Claude-CLI sessions without ptyBridge.
   * For Claude CLI sessions, auto-approval is handled by ClaudePtyBridge.detectPermission().
   */
  private autoConfirmWithRecord(record: SessionRecord, output: string, ptyProcess: TerminalProcess): void {
    if (!record.autoApprovePermissions) {
      return;
    }
    record.confirmWindow = appendWindow(record.confirmWindow, output, CONFIRM_WINDOW_SIZE);
    const normalized = normalizePromptText(record.confirmWindow);
    const now = Date.now();

    const trustFolderPrompt =
      /\byes,\s*i\s*trust\s*this\s*folder\b/i.test(normalized) &&
      /\benter to confirm\b/i.test(normalized);

    const claudeConfirmPrompt =
      /\bdo you want to\b/i.test(normalized) &&
      (hasExplicitConfirmSyntax(normalized) || hasPermissionActionContext(normalized));

    // Check for Claude's tool permission prompt patterns
    const toolPermissionPrompt =
      /\bdo you want to\b/i.test(normalized) &&
      /\(yes\b/i.test(normalized);

    // Reduced cooldown for faster response
    if (now - record.lastAutoConfirmAt < 500) {
      return;
    }

    const shouldConfirm = trustFolderPrompt
      || claudeConfirmPrompt
      || toolPermissionPrompt
      || (hasExplicitConfirmSyntax(normalized)
        && hasPermissionActionContext(normalized));

    if (shouldConfirm) {
      record.lastAutoConfirmAt = now;
      // Always auto-confirm by sending Enter directly
      ptyProcess.write("\r");
    }
  }

  /**
   * Handle events from ClaudePtyBridge
   */
  private handleBridgeEvent(record: SessionRecord, event: SessionEvent): void {
    switch (event.type) {
      case "output.raw": {
        record.output = record.ptyBridge?.getRawOutput() ?? record.output;
        this.emitEvent({
          type: "output",
          sessionId: event.sessionId,
          data: {
            incremental: true,
            chunk: (event.data as { chunk: string }).chunk,
            permissionBlocked: this.isPermissionBlocked(record),
          },
        });
        break;
      }

      case "output.chat": {
        record.output = record.ptyBridge?.getRawOutput() ?? record.output;
        const rawMessages = record.ptyBridge?.getMessages() ?? [];
        const bridgeData = event.data as ChatOutputData | undefined;
        const sequenceChanged = record.ptyChatMessageCount !== rawMessages.length;
        const isStreaming = record.status === "running" && bridgeData?.isResponding === true;
        record.ptyChatMessageCount = rawMessages.length;

        // 每轮忙碌信号：turn 开始置 true，回复结束清 false。只在翻转时广播，
        // 避免流式期间每个 chunk 都发 status 事件。
        const responding = bridgeData?.isResponding === true;
        if (record.ptyBusy !== responding) {
          record.ptyBusy = responding;
          // Claude 的 bridge 精确知道回合边界：翻转为 busy 时落下本轮锚点并挂静默
          // 心跳；回复结束就一起清回 null。
          const at = responding ? new Date().toISOString() : null;
          record.ptyTurnStartedAt = at;
          record.ptyLastActivityAt = at;
          if (responding) this.ptyHeartbeat.observe(record.id);
          else this.ptyHeartbeat.cancel(record.id);
          this.emitEvent({
            type: "status",
            sessionId: event.sessionId,
            data: { ptyBusy: responding, ptyTurnStartedAt: at, ptyLastActivityAt: at },
          });
        } else if (responding) {
          // 回合仍在飞：每个 chat 事件都是活动证据，只续 lastActivityAt 与静默窗口，
          // 不额外广播（流式期间每 chunk 一条 status 会把 WS 刷爆）。
          record.ptyLastActivityAt = new Date().toISOString();
          this.ptyHeartbeat.observe(record.id);
        }

        const data: Record<string, unknown> = {
          permissionBlocked: this.isPermissionBlocked(record),
        };
        // 透传 bridge 给出的 isResponding（true=流式中, false=本轮已完成）。
        // 前端用它检测 thinking→idle 边界并主动做一次终端 resync，把 provider TUI
        // 在流式渲染过程中残留的错位光标定位序列洗掉（等价于按一次右上角缩放）。
        if (bridgeData && typeof bridgeData.isResponding === "boolean") {
          data.isResponding = bridgeData.isResponding;
        }

        // A new round can append user + assistant at once. Last-only payloads
        // cannot establish that sequence for any of the existing clients.
        // Idle is a turn boundary even when the shell process remains running.
        if (isStreaming && !sequenceChanged && rawMessages.length > 0) {
          data.incremental = true;
          const lastTurn = rawMessages[rawMessages.length - 1];
          const truncatedLast = truncateMessagesForTransport([lastTurn], this.config.cardDefaults ?? {}, 0);
          data.lastMessage = truncatedLast[0];
          data.messageCount = rawMessages.length;
        } else {
          data.output = record.output;
          data.messages = truncateMessagesForTransport(rawMessages, this.config.cardDefaults ?? {}, rawMessages.length - 1);
        }
        this.emitEvent({
          type: "output",
          sessionId: event.sessionId,
          data,
        });
        break;
      }

      case "permission.prompt": {
        const data = event.data as { prompt: string; scope: EscalationScope; target?: string };
        record.pendingEscalation = {
          requestId: `bridge-${Date.now()}`,
          scope: data.scope,
          runner: "pty",
          source: "tool_permission_request",
          target: data.target,
          reason: data.prompt,
        };
        record.ptyPermissionBlocked = true;
        this.markDirty(record.id, { metadata: true });
        // Emit status event with full permission details for UI
        this.emitEvent({
          type: "status",
          sessionId: event.sessionId,
          data: {
            permissionBlocked: true,
            permissionRequest: {
              scope: data.scope,
              target: data.target,
              prompt: data.prompt,
            },
          },
        });
        break;
      }

      case "permission.resolved": {
        // Increment approval stats before clearing pendingEscalation
        const resolvedScope = record.pendingEscalation?.scope;
        if (resolvedScope) {
          if (resolvedScope === "run_command" || resolvedScope === "dangerous_shell") {
            record.approvalStats.command++;
          } else if (resolvedScope === "write_file") {
            record.approvalStats.file++;
          } else {
            record.approvalStats.tool++;
          }
          record.approvalStats.total++;
        }
        record.pendingEscalation = null;
        record.ptyPermissionBlocked = false;
        this.markDirty(record.id, { metadata: true });
        this.emitEvent({
          type: "status",
          sessionId: event.sessionId,
          data: {
            permissionBlocked: false,
            approvalStats: record.approvalStats,
          },
        });
        // Log auto-approve events to shortcut-interactions.jsonl for analysis
        const resolvedData = event.data as Record<string, unknown> | undefined;
        if (resolvedData?.autoApproved) {
          const outputLines = record.output.split("\n");
          const tailLines = outputLines.slice(-8).join("\n");
          this.logger.appendShortcutLog(record.id, "auto_approve", tailLines, {
            mode: record.mode,
            scope: resolvedScope ?? "unknown",
            autoApprove: record.autoApprovePermissions,
            permissionBlocked: true,
            input: "\r",
            approveType: resolvedData.approveType as string | undefined,
            score: resolvedData.score as number | undefined,
            matched: resolvedData.matched as string[] | undefined,
            falsePositive: resolvedData.falsePositive as boolean | undefined,
          });
        }
        break;
      }

      case "session.id":
        // Claude session ID captured - already handled in onData
        break;

      case "chat.turn":
        // Turn completed - persist full messages snapshot
        record.messages = record.ptyBridge?.getMessages() ?? record.messages;
        // Clear remembered permissions at turn boundaries
        record.ptyBridge?.clearRememberedPermissions();
        record.rememberedEscalationScopes.clear();
        record.rememberedEscalationTargets.clear();
        this.persist(record, { metadataDirty: true, outputDirty: true, messagesDirty: true });
        break;

      case "ended":
        // Session ended - handled in onExit
        break;
    }
  }

  private mustGet(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) {
      console.error("[ProcessManager] Session lookup failed", { sessionId: id });
      throw new SessionInputError("Session not found.", "SESSION_NOT_FOUND", id);
    }
    return record;
  }

  /** Start a bare interactive login shell without a provider CLI. */
  async startShell(cwd: string | undefined, mode: ExecutionMode, opts?: {
    worktreeEnabled?: boolean;
    cols?: number;
    rows?: number;
    sessionSource?: SessionSource;
    automationId?: string;
    workspaceId?: string;
    workspaceTaskId?: string;
  }): Promise<SessionSnapshot> {
    return this.start(this.config.shell, cwd, mode, undefined, {
      ...opts,
      interactiveShell: true,
    });
  }

  private shouldAutoApprovePermissions(command: string, mode: ExecutionMode, provider?: SessionProvider): boolean {
    if (provider !== "claude") {
      return false;
    }

    if (!/^(?:claude|npx\s+claude|[^\s]+\/claude)(?:\s|$)/.test(command)) {
      return false;
    }

    if (isRunningAsRoot()) {
      return true;
    }

    if (mode === "full-access" || mode === "auto-edit") {
      return true;
    }

    if (mode === "managed" || mode === "native") {
      return true;
    }

    return false;
  }

  private processCommandForMode(
    command: string,
    mode: ExecutionMode,
    provider?: SessionProvider,
    model?: string,
    thinkingEffort?: SessionSnapshot["thinkingEffort"],
  ): string {
    if (!provider) return command;
    if (provider === "codex") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model\s/.test(command) && !/-m\s/.test(command)) {
        const escapedModel = trimmedModel.replace(/'/g, "'\\''");
        result += ` --model '${escapedModel}'`;
      }
      const reasoningEffort = thinkingEffortToCodexReasoningEffort(thinkingEffort ?? null);
      if (reasoningEffort && !/model_reasoning_effort\s*=/.test(command)) {
        result += ` -c 'model_reasoning_effort="${reasoningEffort}"'`;
      }
      if (mode === "full-access") {
        if (!/--dangerously-bypass-approvals-and-sandbox(?:\s|$)/.test(result)) {
          result += " --dangerously-bypass-approvals-and-sandbox";
        }
      }
      return result;
    }

    if (provider === "opencode") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model(?:\s|=)/.test(result) && !/(?:^|\s)-m(?:\s|$)/.test(result)) {
        const escapedModel = trimmedModel.replace(/'/g, "'\\''");
        result += ` --model '${escapedModel}'`;
      }
      // thinkingEffort → --variant 仅适用于 `opencode run`（结构化 runner）；
      // 交互 TUI（裸 `opencode`）没有该选项，注入会导致 CLI 直接报错退出。
      if ((mode === "managed" || mode === "full-access" || mode === "auto-edit") && !/--auto(?:\s|$)/.test(result)) {
        result += " --auto";
      }
      return result;
    }

    if (provider === "grok") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model(?:\s|=)/.test(result) && !/(?:^|\s)-m(?:\s|$)/.test(result)) {
        result += ` --model '${trimmedModel.replace(/'/g, "'\\''")}'`;
      }
      const effort = thinkingEffortToGrokEffort(thinkingEffort ?? null);
      if (effort && !/--(?:reasoning-)?effort(?:\s|=)/.test(result)) {
        result += ` --effort '${effort.replace(/'/g, "'\\''")}'`;
      }
      if ((mode === "managed" || mode === "full-access" || mode === "auto-edit") && !/--(?:always-approve|yolo)(?:\s|$)/.test(result)) {
        result += " --always-approve";
      }
      return result;
    }

    if (provider === "qoder") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model(?:\s|=)/.test(result)) {
        result += ` --model '${trimmedModel.replace(/'/g, "'\\''")}'`;
      }
      // Qoder 一律以 yolo（bypass_permissions）启动：PTY 与结构化 runner 都没有运行时
      // 权限桥，保持 Qoder 自身确认只会让会话卡在 TUI 弹窗或直接拒绝工具调用。
      if (!/--(?:yolo|dangerously-skip-permissions|permission-mode)(?:\s|=|$)/.test(result)) {
        result += " --permission-mode bypass_permissions";
      }
      const qoderEffort = thinkingEffortToQoderEffort(thinkingEffort ?? null);
      if (qoderEffort && !/--reasoning-effort(?:\s|=)/.test(result)) {
        result += ` --reasoning-effort '${qoderEffort.replace(/'/g, "'\\''")}'`;
      }
      return result;
    }

    if (provider === "pi") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model(?:\s|=)/.test(result)) {
        result += ` --model '${trimmedModel.replace(/'/g, "'\\''")}'`;
      }
      const level = thinkingEffortToPiLevel(thinkingEffort ?? null);
      if (level && !/--thinking(?:\s|=)/.test(result)) result += ` --thinking '${level}'`;
      return result;
    }


    const isClaudeCmd = /^(?:claude|npx\s+claude|[^\s]+\/claude)(?:\s|$)/.test(command);
    if (!isClaudeCmd) return command;

    let result = command;

    const trimmedModel = model?.trim();
    if (trimmedModel && trimmedModel !== "default" && !/--model\s/.test(command)) {
      const escapedModel = trimmedModel.replace(/'/g, "'\\''");
      result += ` --model '${escapedModel}'`;
    }

    const claudeEffort = thinkingEffortToClaudeCliEffort(thinkingEffort ?? null);
    if (claudeEffort && !/--effort(?:\s|=|$)/.test(command)) {
      result += ` --effort ${claudeEffort}`;
    }

    const hasPermFlag = /--permission-mode\s/.test(command);

    if (!hasPermFlag) {
      if (isRunningAsRoot()) {
        if (mode === "managed" || mode === "full-access" || mode === "auto-edit") {
          result += " --permission-mode acceptEdits";
          result += " --allowedTools Bash Edit Write Read Glob Grep NotebookEdit WebFetch WebSearch";
        }
      } else {
        if (mode === "full-access" || mode === "managed") {
          result += " --permission-mode bypassPermissions";
        } else if (mode === "auto-edit") {
          result += " --permission-mode acceptEdits";
        }
      }
    }

    const language = this.config.language?.trim();
    const isChinese = language === "中文";

    if (mode === "managed") {
      const autonomousPrompt = buildManagedAutonomyDirective(isChinese);
      const escaped = autonomousPrompt.replace(/'/g, "'\\''");
      result += ` --append-system-prompt '${escaped}'`;
    }

    if (language) {
      // 与 structured-session-manager.ts 走同一个 buildLanguageDirective，保证 PTY 与
      // structured 两种 runner 用同一条强约束指令——避免"换个模式 Claude 又开始夹英文"。
      const langPrompt = buildLanguageDirective(language);
      if (langPrompt) {
        const escaped = langPrompt.replace(/'/g, "'\\''");
        result += ` --append-system-prompt '${escaped}'`;
      }
    }

    return result;
  }
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
