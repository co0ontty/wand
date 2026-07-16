import { randomUUID } from "node:crypto";
import { query as sdkQuery, type Options as SdkOptions, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { prepareSessionWorktree } from "./git-worktree.js";

import { SessionLogger } from "./session-logger.js";
import { WandStorage } from "./storage.js";
import {
  CardExpandDefaults, ContentBlock, ConversationTurn, EscalationScope,
  ExecutionMode, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, SessionSource, StructuredSessionState,
  ToolUseBlock, WandConfig,
} from "./types.js";
import { truncateMessagesForTransport } from "./message-truncator.js";
import { buildChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";
import { resolveSdkClaudeBinary } from "./claude-sdk-runner.js";
import { generateSessionTopic } from "./session-topic.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { CodexRunner } from "./structured-codex-adapter.js";
import { normalizeStructuredToolResultContent } from "./structured-content.js";
import {
  buildAppendSystemPromptParts,
  buildClaudeSdkThinking,
  ClaudeCliRunner,
  derivePermissionPolicy,
} from "./structured-claude-adapter.js";
import {
  captureTaskMeta,
  extractClaudeAssistantMessage,
  extractClaudeModelName,
  normalizeClaudeToolInput,
  stampParentTaskResults,
  stampSelfTask,
  tagSubagentBlocks,
  type TaskMetaMap,
} from "./structured-claude-protocol.js";
import { OpenCodeRunner } from "./structured-opencode-adapter.js";
import type { StructuredRunnerAdapter, StructuredRunnerExecution, StructuredRunnerTurnState } from "./structured-runner.js";
import {
  defaultStructuredRunner,
  defaultStructuredState,
  isStructuredRunnerForProvider,
  normalizeThinkingEffort,
  resolveStructuredRunner,
} from "./structured-provider-common.js";

export {
  isStructuredRunnerForProvider,
  normalizeThinkingEffort,
  resolveStructuredRunner,
  thinkingEffortToClaudeCliEffort,
  thinkingEffortToCodexReasoningEffort,
  thinkingEffortToOpenCodeVariant,
  thinkingEffortToSdkBudget,
} from "./structured-provider-common.js";
export interface StructuredSessionManagerRunners {
  claudeCli?: StructuredRunnerAdapter;
  codex?: StructuredRunnerAdapter;
  opencode?: StructuredRunnerAdapter;
}

interface CreateStructuredSessionOptions {
  cwd: string;
  mode: ExecutionMode;
  provider?: SessionProvider;
  runner?: SessionRunner;
  worktreeEnabled?: boolean;
  /** 用户指定的模型（别名或完整 ID）。留空则 spawn 时不加 --model。 */
  model?: string;
  /** 用户预设的思考深度。留空 / null 视为 off。 */
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  sessionSource?: SessionSource;
  automationId?: string;
  /**
   * 恢复用的初始会话 id：
   *   - Codex：历史 thread id，首条消息即 `codex exec ... resume <id>` 续接。
   *   - Claude：历史 session id，首条消息即 `--resume` / SDK resume 续接。
   * 留空表示新建会话。
   */
  claudeSessionId?: string;
}

/** The runner already persisted/emitted its detailed terminal snapshot. */
class PersistedStructuredRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedStructuredRunnerError";
  }
}

interface StreamingTurnState extends StructuredRunnerTurnState {}


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
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;

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
    output: snapshot.output,
    messages: snapshot.messages,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
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
  const lastTurn = messages.length > 0 ? messages[messages.length - 1] : undefined;
  // Streaming turn (index 0 here) is preserved verbatim; truncation only kicks
  // in if the live response is already bigger than the transport threshold,
  // matching the PTY runner's behaviour in process-manager.ts.
  const lastMessage = lastTurn ? truncateMessagesForTransport([lastTurn], cardDefaults, 0)[0] : undefined;
  return {
    incremental: true,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    lastMessage,
    messageCount: messages.length,
  };
}

export class StructuredSessionManager {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly pendingRunnerExecutions = new Map<string, StructuredRunnerExecution>();
  private readonly pendingSdkAbort = new Map<string, AbortController>();
  /**
   * Active SDK Query handle per session, kept around so we can call
   * `query.interrupt()` for a graceful stop instead of aborting via signal.
   * Only populated while an SDK call is in flight.
   */
  private readonly pendingSdkQueries = new Map<string, { interrupt(): Promise<void> }>();
  private readonly interruptedWith = new Map<string, string>();
  /**
   * Sessions where the current interrupt is a "queue promote" (用户从排队条点了「立即」
   * 把队首插队到 now)。退出处理三个分支默认会把 queuedMessages 清空——因为常规的
   * interrupt 语义是"算了，做这个"，把队列也作废。但 queue-promote 的语义是
   * "先做这条，剩下的队列还要继续"，所以这里打个标记，让退出 handler 保留 queue。
   * 收到后必须 delete 掉，避免下一次普通 interrupt 误带 flag。
   */
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
  private emitEvent: ((event: ProcessEvent) => void) | null = null;
  private archiveTimer: NodeJS.Timeout | null = null;
  private readonly topicRequests = new Set<string>();
  private readonly streamEmitTimers = new Set<NodeJS.Timeout>();
  private readonly claudeCliRunner: StructuredRunnerAdapter;
  private readonly codexRunner: StructuredRunnerAdapter;
  private readonly openCodeRunner: StructuredRunnerAdapter;
  private disposed = false;

  constructor(
    private readonly storage: WandStorage,
    private readonly config: WandConfig,
    private readonly logger: SessionLogger | null = null,
    private readonly sdkQueryFactory: typeof sdkQuery = sdkQuery,
    runners: StructuredSessionManagerRunners = {},
  ) {
    this.claudeCliRunner = runners.claudeCli ?? new ClaudeCliRunner({ language: () => this.config.language });
    this.codexRunner = runners.codex ?? new CodexRunner();
    this.openCodeRunner = runners.opencode ?? new OpenCodeRunner();
    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "structured") continue;
      const restoredStatus = snapshot.status === "running" ? "idle" : snapshot.status;
      const storedProvider = snapshot.provider ?? snapshot.structuredState?.provider;
      const provider: SessionProvider = storedProvider === "codex" || storedProvider === "opencode"
        ? storedProvider
        : "claude";
      const storedRunner = snapshot.runner ?? snapshot.structuredState?.runner;
      // Legacy/corrupt snapshots are normalized on restore so send dispatch can
      // rely on the provider/runner invariant without making startup fail.
      const runner = isStructuredRunnerForProvider(provider, storedRunner)
        ? storedRunner
        : defaultStructuredRunner(provider, this.config.structuredRunner);
      const restored: SessionSnapshot = {
        ...snapshot,
        sessionKind: "structured",
        sessionSource: snapshot.sessionSource ?? "interactive",
        automationId: snapshot.automationId,
        provider,
        runner,
        status: restoredStatus,
        autoApprovePermissions: snapshot.autoApprovePermissions ?? shouldAutoApproveForMode(snapshot.mode),
        approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
        queuedMessages: snapshot.queuedMessages ?? [],
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          provider,
          runner,
          model: snapshot.structuredState?.model ?? snapshot.selectedModel ?? undefined,
          lastError: snapshot.structuredState?.lastError ?? null,
          inFlight: false,
          activeRequestId: null,
        },
        selectedModel: snapshot.selectedModel ?? null,
      };
      this.sessions.set(restored.id, restored);
      this.storage.saveSession(restored);
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

  /** Stop every runner and flush terminal state before storage is closed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = null;
    }
    for (const timer of this.streamEmitTimers) clearTimeout(timer);
    this.streamEmitTimers.clear();

    const activeSessionIds = new Set<string>([
      ...this.pendingRunnerExecutions.keys(),
      ...this.pendingSdkQueries.keys(),
      ...this.pendingSdkAbort.keys(),
      ...Array.from(this.sessions.values())
        .filter((session) => session.structuredState?.inFlight)
        .map((session) => session.id),
    ]);
    for (const id of activeSessionIds) {
      const session = this.sessions.get(id);
      if (!session) continue;
      const cancelled: SessionSnapshot = {
        ...session,
        status: "idle",
        exitCode: null,
        endedAt: null,
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
          inFlight: false,
          activeRequestId: null,
          lastError: null,
        },
      };
      this.sessions.set(id, cancelled);
      try { this.saveAuthoritativeSession(cancelled); } catch { /* best-effort shutdown flush */ }
    }

    for (const execution of this.pendingRunnerExecutions.values()) execution.interrupt();
    for (const query of this.pendingSdkQueries.values()) {
      void query.interrupt().catch(() => { /* ignore */ });
    }
    for (const controller of this.pendingSdkAbort.values()) controller.abort();
    this.pendingRunnerExecutions.clear();
    this.pendingSdkQueries.clear();
    this.pendingSdkAbort.clear();
    this.interruptedWith.clear();
    this.preserveQueueOnInterrupt.clear();
    for (const timer of this.streamCheckpointTimers.values()) clearTimeout(timer);
    this.streamCheckpointTimers.clear();
    this.streamCheckpointDirty.clear();
    this.lastStreamSaveAt.clear();
    this.topicRequests.clear();
    this.emitEvent = null;
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

  setSessionTopic(id: string, title: string, description: string): SessionSnapshot {
    const current = this.requireSession(id);
    const updated: SessionSnapshot = { ...current, title, description, summary: description };
    this.sessions.set(id, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
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
    if (this.disposed || !session || session.title || this.topicRequests.has(id)) return;
    this.topicRequests.add(id);
    void generateSessionTopic(input, session.cwd, this.config.language, this.config.systemAi)
      .then(({ title, description }) => {
        if (!this.disposed && this.sessions.has(id)) this.setSessionTopic(id, title, description);
      })
      .catch((error) => console.error(`[StructuredSessionManager] Failed to generate session topic ${id}:`, getErrorMessage(error)))
      .finally(() => this.topicRequests.delete(id));
  }

  createSession(options: CreateStructuredSessionOptions): SessionSnapshot {
    if (this.disposed) throw new Error("StructuredSessionManager has been disposed.");
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const requestedProvider: unknown = options.provider ?? "claude";
    if (requestedProvider !== "claude" && requestedProvider !== "codex" && requestedProvider !== "opencode") {
      throw new Error(`不支持的结构化 provider: ${String(requestedProvider)}`);
    }
    const provider: SessionProvider = requestedProvider;
    const runner = resolveStructuredRunner(provider, options.runner, this.config.structuredRunner);
    const baseCwd = resolveSessionCwd(options.cwd, this.config.defaultCwd);
    const worktreeSetup = options.worktreeEnabled
      ? prepareSessionWorktree({ cwd: baseCwd, sessionId: id })
      : null;
    const selectedModel = options.model?.trim() || null;
    const initialThinkingEffort = normalizeThinkingEffort(options.thinkingEffort);
    const snapshot: SessionSnapshot = {
      id,
      sessionKind: "structured",
      sessionSource: options.sessionSource ?? "interactive",
      automationId: options.automationId,
      provider,
      runner,
      command:
        provider === "codex"
          ? "codex exec --json"
          : provider === "opencode"
            ? "opencode run --format json"
          : runner === "claude-sdk"
            ? "claude-agent-sdk (stream-json)"
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

  async sendMessage(
    id: string,
    input: string,
    opts?: { interrupt?: boolean; idempotencyKey?: string; preserveQueue?: boolean; queueAlreadyRemoved?: boolean },
  ): Promise<SessionSnapshot> {
    if (this.disposed) throw new Error("StructuredSessionManager has been disposed.");
    let session = this.requireSession(id);
    const prompt = input.trim();
    if (!prompt) return session;
    this.maybeGenerateSessionTopic(id, prompt);
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
    if (session.structuredState?.inFlight) {
      const runnerExecution = this.pendingRunnerExecutions.get(id);
      const sdkAbort = this.pendingSdkAbort.get(id);
      const sdkQueryHandle = this.pendingSdkQueries.get(id);
      // interrupt() only requests cancellation; completion can settle later.
      // Treat runner-map ownership as the authoritative in-flight state.
      const childActive = Boolean(runnerExecution);
      const sdkAlive = Boolean(sdkQueryHandle || (sdkAbort && !sdkAbort.signal.aborted));
      if (!childActive && !sdkAlive) {
        if (runnerExecution) this.releasePendingRunnerExecution(id, runnerExecution);
        if (sdkAbort) this.releasePendingSdkAbort(id, sdkAbort);
        const recovered: SessionSnapshot = {
          ...session,
          status: "idle",
          endedAt: session.endedAt ?? new Date().toISOString(),
          structuredState: {
            ...(session.structuredState as StructuredSessionState),
            inFlight: false,
            activeRequestId: null,
          },
        };
        this.sessions.set(id, recovered);
        this.storage.updateSessionRuntimeMetadata(recovered);
        session = recovered;
      } else if (opts?.interrupt) {
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
        if (sdkQueryHandle) {
          void sdkQueryHandle.interrupt().catch(() => { /* ignore */ });
        }
        if (sdkAbort) sdkAbort.abort();
        return session;
      } else {
        const queue = [...(session.queuedMessages ?? [])];
        if (isDuplicateStructuredQueueInput(session, prompt)) {
          const err = new Error("与上一条消息相同，已忽略，不会加入排队。") as Error & { code?: string };
          err.code = "duplicate_queued_message";
          throw err;
        }
        if (queue.length >= 10) {
          throw new Error("排队消息已满（最多 10 条），请等待当前消息处理完成。");
        }
        const queued: SessionSnapshot = {
          ...session,
          queuedMessages: [...queue, prompt],
        };
        this.sessions.set(id, queued);
        this.storage.updateSessionRuntimeMetadata(queued);
        this.emitStructuredSnapshot(queued);
        return queued;
      }
    }

    // 检测上一轮 assistant 是否有未配对的 AskUserQuestion tool_use（说明前一次
    // child 是被 SIGTERM 主动 kill 的，正在等用户回答）。如果有，把这次的输入打包
    // 成 tool_result 注入到 messages，让 UI 把卡片渲染为 answered。
    const pendingAsk = findUnpairedAskUserQuestion(session.messages ?? []);
    const userTurn: ConversationTurn = pendingAsk
      ? {
          role: "user",
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
          content: [{ type: "text", text: prompt }],
        };
    const requestId = randomUUID();
    const updated: SessionSnapshot = {
      ...session,
      status: "running",
      exitCode: null,
      endedAt: null,
      messages: [...(session.messages ?? []), userTurn],
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        inFlight: true,
        activeRequestId: requestId,
        lastError: null,
      },
    };
    this.sessions.set(id, updated);
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
      } else if (runner === "claude-sdk") {
        await this.runClaudeSdkStreaming(id, updated, prompt, requestId);
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
      const failed: SessionSnapshot = {
        ...current,
        status: "failed",
        exitCode: 1,
        endedAt: new Date().toISOString(),
        structuredState: {
          ...(current.structuredState as StructuredSessionState),
          inFlight: false,
          activeRequestId: null,
          lastError: message,
        },
      };
      this.sessions.set(id, failed);
      this.saveAuthoritativeSession(failed);
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
    const updated: SessionSnapshot = { ...session, queuedMessages: reordered };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** Remove a single queued message by index. */
  deleteQueuedMessage(sessionId: string, index: number): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const queue = session.queuedMessages ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      throw new Error("队列中没有该条消息（可能已被处理）。");
    }
    const next = queue.slice(0, index).concat(queue.slice(index + 1));
    const updated: SessionSnapshot = { ...session, queuedMessages: next };
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
    const updated: SessionSnapshot = { ...session, queuedMessages: remaining };
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

  /** Update the selected model for a structured session. Takes effect on the next spawn. */
  setSessionModel(sessionId: string, model: string | null): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const normalized = model?.trim() || null;
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
    const updated: SessionSnapshot = { ...session, autoApprovePermissions: newVal };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    return updated;
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

  stop(id: string): SessionSnapshot {
    const session = this.requireSession(id);
    this.interruptedWith.delete(id);
    this.preserveQueueOnInterrupt.delete(id);
    // Clearing activeRequestId is the generation barrier: late data/close callbacks
    // from the cancelled runner can no longer mutate this session or a replacement turn.
    // 主动停止只是取消「当前回合」，结构化会话本身并没有结束——置为 idle 而非 stopped。
    // 这样前端不会进入"会话已结束/恢复会话"终止态，输入框保持可用，直接展示历史内容。
    const cancelled: SessionSnapshot = {
      ...session,
      status: "idle",
      exitCode: null,
      endedAt: null,
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
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
    // SDK runner：先尝试 query.interrupt() 优雅停止，失败再走 abort。
    // 两个都清掉避免后续重复操作。
    const sdkQuery = this.pendingSdkQueries.get(id);
    if (sdkQuery) {
      void sdkQuery.interrupt().catch(() => { /* ignore */ });
      this.releasePendingSdkQuery(id, sdkQuery);
    }
    const sdkAbort = this.pendingSdkAbort.get(id);
    if (sdkAbort) {
      sdkAbort.abort();
      this.releasePendingSdkAbort(id, sdkAbort);
    }
    this.saveAuthoritativeSession(cancelled);
    // 仍发 "ended" 事件让各端停掉"回复中"指示 / 灵动岛，但携带的 status 是 idle。
    this.emitStructuredSnapshot(cancelled, "ended");
    return cancelled;
  }

  delete(id: string): void {
    const runnerExecution = this.pendingRunnerExecutions.get(id);
    const sdkQuery = this.pendingSdkQueries.get(id);
    const sdkAbort = this.pendingSdkAbort.get(id);
    // Invalidate callback ownership before signalling the runner. Cancellation
    // can synchronously wake listeners in some SDK/adapter implementations.
    this.sessions.delete(id);
    if (runnerExecution) {
      runnerExecution.interrupt();
      this.releasePendingRunnerExecution(id, runnerExecution);
    }
    if (sdkQuery) {
      void sdkQuery.interrupt().catch(() => { /* ignore */ });
      this.releasePendingSdkQuery(id, sdkQuery);
    }
    if (sdkAbort) {
      sdkAbort.abort();
      this.releasePendingSdkAbort(id, sdkAbort);
    }
    this.clearStreamingCheckpoint(id);
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
    return this.sessions.get(sessionId)?.structuredState?.activeRequestId === requestId;
  }

  private currentSessionForRequest(sessionId: string, requestId: string): SessionSnapshot | null {
    if (!this.isCurrentRequest(sessionId, requestId)) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  /** Delete a handle only if it still belongs to the execution doing cleanup. */
  private releasePendingRunnerExecution(sessionId: string, execution: StructuredRunnerExecution): boolean {
    if (this.pendingRunnerExecutions.get(sessionId) !== execution) return false;
    this.pendingRunnerExecutions.delete(sessionId);
    return true;
  }

  private releasePendingSdkAbort(sessionId: string, controller: AbortController): boolean {
    if (this.pendingSdkAbort.get(sessionId) !== controller) return false;
    this.pendingSdkAbort.delete(sessionId);
    return true;
  }

  private releasePendingSdkQuery(sessionId: string, query: { interrupt(): Promise<void> }): boolean {
    if (this.pendingSdkQueries.get(sessionId) !== query) return false;
    this.pendingSdkQueries.delete(sessionId);
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
      const messages = [...(current.messages ?? [])];
      if (messages[messages.length - 1]?.role === "assistant") messages[messages.length - 1] = turn;
      else messages.push(turn);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
        structuredState: {
          ...(current.structuredState as StructuredSessionState),
          model: turnState.model ?? current.structuredState?.model,
        },
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

    const execution = this.codexRunner.start({
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

    if (result.spawnError) {
      const hint = result.spawnError.code === "ENOENT"
        ? "（PATH 中找不到 codex 可执行文件；请确认 codex 已安装，或重跑 `wand service:install` 刷新服务的 PATH）"
        : "";
      throw new Error(`codex exec 启动失败：${result.spawnError.message}${hint}`);
    }

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
        ...(current.structuredState as StructuredSessionState),
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
      const messages = [...(current.messages ?? [])];
      if (messages[messages.length - 1]?.role === "assistant") messages[messages.length - 1] = turn;
      else messages.push(turn);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
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

    const execution = this.openCodeRunner.start({
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

    if (result.spawnError) {
      const hint = result.spawnError.code === "ENOENT"
        ? "（PATH 中找不到 opencode；请安装 opencode-ai，或重跑 `wand service:install` 刷新服务 PATH）"
        : "";
      throw new Error(`opencode run 启动失败：${result.spawnError.message}${hint}`);
    }

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
        ...(current.structuredState as StructuredSessionState),
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
  ): Promise<void> {
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    const syncSnapshot = (turnState: StructuredRunnerTurnState): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const hasAssistantContent = turnState.blocks.length > 0 || !!turnState.result;
      const messages = [...(current.messages ?? [])];
      if (hasAssistantContent) {
        const turn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        if (messages[messages.length - 1]?.role === "assistant") messages[messages.length - 1] = turn;
        else messages.push(turn);
      }
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages,
        output: turnState.result || current.output,
        structuredState: {
          ...(current.structuredState as StructuredSessionState),
          model: turnState.model ?? current.structuredState?.model,
        },
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

    const execution = this.claudeCliRunner.start({
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
      kind: "claude-print",
      provider: "claude",
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

    if (result.spawnError) {
      const hint = result.spawnError.code === "ENOENT"
        ? "（PATH 中找不到 claude 可执行文件；请确认 claude 已安装，或重跑 `wand service:install` 刷新服务的 PATH）"
        : "";
      throw new Error(`claude -p 启动失败：${result.spawnError.message}${hint}`);
    }

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "claude-print-close",
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
    if (failedExit && !interruptedByUser && !interruptedForQuestion) {
      const errorText = this.formatStructuredExitError("claude -p", result.exitCode, result.signal, {
        stderr: result.stderr,
        stdoutTail: result.stdoutTail,
      });
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
        ...(current.structuredState as StructuredSessionState),
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
  // Streaming claude-agent-sdk execution
  // ---------------------------------------------------------------------------

  /**
   * Use @anthropic-ai/claude-agent-sdk instead of spawning claude -p directly.
   * The SDK still spawns the claude binary but provides typed AsyncGenerator<SDKMessage>
   * messages, so we skip NDJSON parsing. Options are 1:1 with the CLI flags.
   *
   * Streaming is enabled via includePartialMessages: true — the SDK emits
   * SDKPartialAssistantMessage (type: "stream_event") with BetaRawMessageStreamEvent
   * payloads for incremental text/thinking/tool_use updates, followed by a final
   * SDKAssistantMessage with the authoritative complete content.
   */
  private async runClaudeSdkStreaming(sessionId: string, session: SessionSnapshot, prompt: string, requestId: string): Promise<void> {
    const abortController = new AbortController();
    this.pendingSdkAbort.set(sessionId, abortController);

    const isManaged = session.mode === "managed";
    let killedForAskUserQuestion = false;

    // 权限策略 + 系统提示词都通过共享 helper 派生，与 CLI runner 一字不差。
    const permPolicy = derivePermissionPolicy(session.mode, session.autoApprovePermissions ?? false, session.cwd);
    const systemPromptParts = buildAppendSystemPromptParts(this.config.language, session.mode);

    const sdkClaudeBinary = resolveSdkClaudeBinary();
    // SDK 默认会把整个 process.env 透传给 claude 子进程；这里显式按 inheritEnv 配置组装，
    // 否则关闭"继承环境变量"开关时 SDK 路径会被静默忽略。
    const sdkEnv = buildChildEnv(this.config.inheritEnv !== false);
    const sdkThinking = buildClaudeSdkThinking(session.thinkingEffort);

    const sdkOptions: SdkOptions = {
      cwd: session.cwd,
      abortController,
      env: sdkEnv as Record<string, string | undefined>,
      permissionMode: permPolicy.permissionMode,
      ...(permPolicy.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(permPolicy.allowedTools ? { allowedTools: permPolicy.allowedTools } : {}),
      ...(isManaged ? { disallowedTools: ["AskUserQuestion"] } : {}),
      thinking: sdkThinking,
      includePartialMessages: true,
      // 把子 agent 的 text/thinking 也转发回来，UI 才能把"被 Task 召唤来的协作者"
      // 渲染成独立角色的群聊消息。关掉这个开关时只会收到子 agent 的 tool_use/tool_result，
      // text/thinking 被 SDK 吞掉。
      forwardSubagentText: true,
      ...(systemPromptParts.length > 0 ? { appendSystemPrompt: systemPromptParts.join("\n\n") } : {}),
      ...(sdkClaudeBinary ? { pathToClaudeCodeExecutable: sdkClaudeBinary } : {}),
    };

    if (session.claudeSessionId) sdkOptions.resume = session.claudeSessionId;

    const modelChoice = session.selectedModel?.trim();
    if (modelChoice && modelChoice !== "default") sdkOptions.model = modelChoice;

    // Streaming input mode：把这一轮的 user turn 重建成一条 SDKUserMessage 喂给 SDK。
    // 上层 sendMessage 已经把 userTurn 写进 session.messages 末尾——如果它的内容是
    // tool_result，说明本次是用户在回答上一轮 AskUserQuestion，否则就是普通文本。
    // 走 streaming input 而非 string prompt 的好处：tool_result 是真的 tool_result
    // block，对 Claude 来说就是标准工具回传，不需要 "[对刚才工具的回答…]" 这种文本
    // 提示让模型脑补语义。
    const lastUserTurn = (session.messages ?? []).slice().reverse().find((m) => m.role === "user");
    const lastUserBlock = lastUserTurn?.content?.[0];

    let sdkInitialMessage: SDKUserMessage;
    if (lastUserBlock?.type === "tool_result") {
      // Anthropic 的 tool_result.content 原生支持 string 或 content-block 数组（text/image
      // 等）。wand 内部 ToolResultBlock 的 array 形态是 `{type: string; ...}` 比官方 union
      // 宽，但实际取值都是 `{type: "text", text}`，结构上兼容；用 `as` 把宽类型缩到 SDK
      // 接受的形态即可，比 JSON.stringify 把数组拍成一坨 JSON 文本更忠实。
      sdkInitialMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: lastUserBlock.tool_use_id,
              content: lastUserBlock.content as string | Array<{ type: "text"; text: string }>,
              is_error: lastUserBlock.is_error === true,
            },
          ],
        },
        parent_tool_use_id: null,
      };
    } else {
      sdkInitialMessage = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
        parent_tool_use_id: null,
      };
    }

    async function* singleShotPrompt(): AsyncGenerator<SDKUserMessage> {
      yield sdkInitialMessage;
    }

    const turnState: StreamingTurnState = {
      blocks: [],
      result: "",
      sessionId: null,
      model: undefined,
      usage: undefined,
    };

    // Tracks in-progress streaming blocks keyed by content_block index from stream_event.
    // The map is cleared whenever a complete `assistant` message arrives — its blocks
    // are then promoted into `finalizedBlocks` below.
    //
    // `parentToolUseId` carries through from SDKPartialAssistantMessage so we can
    // stamp streaming blocks with subagent persona *during* streaming, not only
    // after the completion event. Without it, subagent text shows up under the
    // parent's avatar for tens of ms then snaps to the subagent — visible flicker.
    const streamingBlockByIndex = new Map<number, {
      type: "text" | "thinking" | "tool_use";
      id?: string;
      name?: string;
      text: string;
      thinking: string;
      partialInput: string;
      finalized: boolean;
      parentToolUseId: string | null;
    }>();

    // Blocks from messages that have already completed within this turn — including
    // the parent assistant's prior messages, every subagent assistant message, and
    // every tool_result. Subagent (Task tool) flows produce many assistant messages
    // back-to-back; without this list, each new streaming message would visually
    // erase everything that came before it in the same turn.
    const finalizedBlocks: ContentBlock[] = [];

    // Per-turn Task tool_use_id → meta map; populated from the parent assistant's
    // Task tool_use blocks and consulted when subagent messages arrive.
    const taskMetaRegistry: TaskMetaMap = new Map();

    let emitTimer: ReturnType<typeof setTimeout> | null = null;

    const flushEmit = (): void => {
      if (emitTimer) { this.clearStreamEmitTimer(emitTimer); emitTimer = null; }
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
    };

    const scheduleEmit = (): void => {
      if (!emitTimer) emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
    };

    // Rebuild ContentBlock[] from finalized history + the in-progress streaming map.
    // Returning only the streaming blocks would drop every prior parent/subagent
    // message in this turn (the original disappearing-output bug).
    const rebuildStreamingBlocks = (): ContentBlock[] => {
      const sorted = [...streamingBlockByIndex.entries()].sort((a, b) => a[0] - b[0]);
      const streaming: ContentBlock[] = [];
      for (const [, sb] of sorted) {
        let block: ContentBlock | null = null;
        if (sb.type === "text") {
          block = { type: "text", text: sb.text };
        } else if (sb.type === "thinking") {
          block = { type: "thinking", thinking: sb.thinking };
        } else if (sb.type === "tool_use" && sb.id && sb.name) {
          let input: Record<string, unknown> = {};
          if (sb.finalized && sb.partialInput) {
            try { input = JSON.parse(sb.partialInput) as Record<string, unknown>; } catch { /* partial json */ }
          }
          block = { type: "tool_use", id: sb.id, name: sb.name, input: normalizeClaudeToolInput(sb.name, input) };
        }
        if (!block) continue;
        if (sb.parentToolUseId) {
          const [stamped] = tagSubagentBlocks([block], sb.parentToolUseId, taskMetaRegistry);
          streaming.push(stamped);
        } else {
          streaming.push(block);
        }
      }
      // 流式阶段就给 Task/Agent tool_use 本身盖章，防止"先显示工具卡片几秒再跳为
      // handoff 行"的闪烁。content_block_start 阶段就有 name=Task/Agent，
      // stampSelfTask 据此即可命中；agentType 字段藏在 input 里，delta 累计后再由
      // 后续 captureTaskMeta 回填 registry，下次 rebuild 自动补上更完整的 stamp。
      captureTaskMeta(streaming, taskMetaRegistry);
      const stampedStreaming = stampSelfTask(streaming, taskMetaRegistry);
      return [...finalizedBlocks, ...stampedStreaming];
    };

    const syncSnapshot = (): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const inProgressTurn: ConversationTurn = {
        role: "assistant",
        content: this.compactContentBlocks([...turnState.blocks], turnState.result),
        usage: turnState.usage,
      };
      const msgs = [...(current.messages ?? [])];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = inProgressTurn;
      else msgs.push(inProgressTurn);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages: msgs,
        output: turnState.result || current.output,
        structuredState: {
          ...(current.structuredState as StructuredSessionState),
          model: turnState.model ?? current.structuredState?.model,
        },
      };
      this.sessions.set(sessionId, patched);
      this.saveStreamingSnapshot(patched);
    };

    const spawnedAt = new Date().toISOString();
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "claude-sdk",
      provider: "claude",
      cwd: session.cwd,
      permissionMode: permPolicy.permissionMode,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      claudeSessionId: session.claudeSessionId,
      spawnedAt,
    });

    let queryHandle: ReturnType<typeof sdkQuery>;
    try {
      queryHandle = this.sdkQueryFactory({ prompt: singleShotPrompt(), options: sdkOptions });
    } catch (error) {
      this.releasePendingSdkAbort(sessionId, abortController);
      throw error;
    }
    this.pendingSdkQueries.set(sessionId, queryHandle);

    try {
      for await (const msg of queryHandle as AsyncIterable<SDKMessage>) {
        if (abortController.signal.aborted || !this.isCurrentRequest(sessionId, requestId)) break;

        // 同 CLI runner 的关键修复：从任何带 session_id 的 SDK 消息（system / assistant /
        // user / result）即时捕获并落库。AskUserQuestion 的 interrupt 发生在 assistant
        // 之后、result 之前，若只在 result 捕获，被 interrupt 的轮次会丢掉 session_id，
        // 续接时不 resume → 上下文丢失。stream_event 等无 session_id 的消息被 guard 跳过。
        const msgSessionId = (msg as { session_id?: unknown }).session_id;
        if (typeof msgSessionId === "string" && msgSessionId && turnState.sessionId !== msgSessionId) {
          turnState.sessionId = msgSessionId;
          const cur = this.currentSessionForRequest(sessionId, requestId);
          if (cur && cur.claudeSessionId !== msgSessionId) {
            const patched: SessionSnapshot = { ...cur, claudeSessionId: msgSessionId };
            this.sessions.set(sessionId, patched);
            this.saveStreamingSnapshot(patched, { metadata: true });
          }
        }

        // Incremental streaming events (opt-in via includePartialMessages: true)
        if (msg.type === "stream_event") {
          const partial = msg as unknown as {
            type: "stream_event";
            event: Record<string, unknown>;
            parent_tool_use_id?: string | null;
          };
          const ev = partial.event;
          const partialParentId = partial.parent_tool_use_id ?? null;
          if (ev.type === "content_block_start") {
            const cb = ev.content_block as Record<string, unknown>;
            const blockType = cb.type as string;
            if (blockType === "text" || blockType === "thinking" || blockType === "tool_use") {
              streamingBlockByIndex.set(ev.index as number, {
                type: blockType as "text" | "thinking" | "tool_use",
                id: typeof cb.id === "string" ? cb.id : undefined,
                name: typeof cb.name === "string" ? cb.name : undefined,
                text: typeof cb.text === "string" ? cb.text : "",
                thinking: typeof cb.thinking === "string" ? cb.thinking : "",
                partialInput: "",
                finalized: false,
                parentToolUseId: partialParentId,
              });
              turnState.blocks = rebuildStreamingBlocks();
              syncSnapshot();
              scheduleEmit();
            }
          } else if (ev.type === "content_block_delta") {
            const sb = streamingBlockByIndex.get(ev.index as number);
            if (sb) {
              const delta = ev.delta as Record<string, unknown>;
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                sb.text += delta.text;
                turnState.result = sb.text;
              } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                sb.thinking += delta.thinking;
              } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                sb.partialInput += delta.partial_json;
              }
              turnState.blocks = rebuildStreamingBlocks();
              syncSnapshot();
              scheduleEmit();
            }
          } else if (ev.type === "content_block_stop") {
            const sb = streamingBlockByIndex.get(ev.index as number);
            if (sb) {
              sb.finalized = true;
              turnState.blocks = rebuildStreamingBlocks();
              syncSnapshot();
              scheduleEmit();
            }
          }
          continue;
        }

        // Complete assistant turn — promote streaming content into the finalized
        // history so subsequent messages (subagents, follow-up parent messages)
        // append to it instead of erasing it.
        if (msg.type === "assistant") {
          const assistantMsg = msg as unknown as {
            type: "assistant";
            message: Record<string, unknown>;
            session_id: string;
            parent_tool_use_id?: string | null;
          };
          const extracted = extractClaudeAssistantMessage(assistantMsg.message);
          // 父 assistant 的 Task tool_use → 注册到本轮 taskMeta map；
          // 子 agent 的 message（parent_tool_use_id 非空）→ 给每个 block 盖章。
          const parentToolUseId = assistantMsg.parent_tool_use_id ?? null;
          if (parentToolUseId === null) {
            captureTaskMeta(extracted.content, taskMetaRegistry);
            finalizedBlocks.push(...stampSelfTask(extracted.content, taskMetaRegistry));
          } else {
            finalizedBlocks.push(...tagSubagentBlocks(extracted.content, parentToolUseId, taskMetaRegistry));
          }
          streamingBlockByIndex.clear();
          turnState.blocks = rebuildStreamingBlocks();
          if (assistantMsg.session_id) turnState.sessionId = assistantMsg.session_id;
          syncSnapshot();
          scheduleEmit();

          // Non-managed mode: detect AskUserQuestion. Prefer query.interrupt()
          // (streaming input mode 的 control message，让 SDK 优雅地停掉当前 turn）
          // 而不是 abortController.abort()——abort 会让 SDK throw AbortError，整段
          // try/catch 走异常路径；interrupt 让 for-await 自然结束，行为更干净。
          // 失败时 fallback 到 abort，保证一定能跳出。
          //
          // 注意：interrupt 之后下一次 sendMessage 会重新 spawn 一次 SDK 调用并通过
          // resume 续接 + tool_result block 回答，不用文本伪造。
          if (!isManaged && !killedForAskUserQuestion) {
            const askBlock = extracted.content.find(
              (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use" && b.name === "AskUserQuestion",
            );
            if (askBlock) {
              killedForAskUserQuestion = true;
              flushEmit();
              try {
                await queryHandle.interrupt();
              } catch (_err) {
                // interrupt 在某些情况下（已经结束 / SDK 版本不支持）会 reject，
                // 兜底用 abort 强制退出。
                abortController.abort();
              }
            }
          }
          continue;
        }

        // Tool results fed back from the claude subprocess (parent's view of a
        // tool call, or a subagent's tool_result during Task execution).
        if (msg.type === "user") {
          const userMsg = msg as unknown as {
            type: "user";
            message: Record<string, unknown>;
            parent_tool_use_id?: string | null;
          };
          const parentToolUseId = userMsg.parent_tool_use_id ?? null;
          const content = Array.isArray(userMsg.message?.content) ? userMsg.message.content as unknown[] : [];
          const collected: ContentBlock[] = [];
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b?.type === "tool_result") {
              collected.push({
                type: "tool_result",
                tool_use_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
                content: this.normalizeToolResultContent(b.content),
                is_error: b.is_error === true,
              });
            }
          }
          if (parentToolUseId === null) {
            finalizedBlocks.push(...stampParentTaskResults(collected, taskMetaRegistry));
          } else {
            finalizedBlocks.push(...tagSubagentBlocks(collected, parentToolUseId, taskMetaRegistry));
          }
          turnState.blocks = rebuildStreamingBlocks();
          syncSnapshot();
          scheduleEmit();
          continue;
        }

        // Final result — capture session_id, usage, model
        if (msg.type === "result") {
          const resultMsg = msg as Record<string, unknown>;
          if (typeof resultMsg.result === "string") turnState.result = resultMsg.result.trim();
          if (typeof resultMsg.session_id === "string") turnState.sessionId = resultMsg.session_id;
          turnState.model = extractClaudeModelName(resultMsg.modelUsage as Record<string, unknown> | undefined) ?? turnState.model;
          turnState.usage = this.extractSdkUsage(resultMsg);
          syncSnapshot();
          scheduleEmit();
          continue;
        }
      }
    } catch (err) {
      // AbortError from abortController.abort() is intentional — fall through to finish logic
      const isAbort = abortController.signal.aborted || (err instanceof Error && err.name === "AbortError");
      if (!isAbort) {
        const releasedAbort = this.releasePendingSdkAbort(sessionId, abortController);
        const releasedQuery = this.releasePendingSdkQuery(sessionId, queryHandle);
        if (releasedAbort || releasedQuery) this.cancelStreamingCheckpointTimer(sessionId);
        if (emitTimer) this.clearStreamEmitTimer(emitTimer);
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-sdk-error",
          spawnedAt,
          closedAt: new Date().toISOString(),
          error: getErrorMessage(err),
        });
        throw err;
      }
    }

    // Cleanup
    const releasedAbort = this.releasePendingSdkAbort(sessionId, abortController);
    const releasedQuery = this.releasePendingSdkQuery(sessionId, queryHandle);
    if (releasedAbort || releasedQuery) this.cancelStreamingCheckpointTimer(sessionId);
    if (emitTimer) this.clearStreamEmitTimer(emitTimer);
    if (!this.isCurrentRequest(sessionId, requestId)) return;
    flushEmit();

    const current = this.currentSessionForRequest(sessionId, requestId);
    if (!current) return;

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "claude-sdk-close",
      spawnedAt,
      closedAt: new Date().toISOString(),
      killedForAskUserQuestion,
      sessionId: turnState.sessionId,
    });

    const msgs = this.buildCompletedAssistantMessages(current, turnState);

    const interruptPrompt = this.interruptedWith.get(sessionId);
    const keepRunning = killedForAskUserQuestion || !!interruptPrompt;
    const finished: SessionSnapshot = {
      ...current,
      status: keepRunning ? "running" : "idle",
      exitCode: keepRunning ? null : 0,
      endedAt: keepRunning ? null : new Date().toISOString(),
      output: turnState.result,
      claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
      messages: msgs,
      queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...(current.structuredState as StructuredSessionState),
        model: turnState.model ?? current.structuredState?.model,
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
      // 与 codex/cli runner 对齐：清掉"保留队列"标记，避免 stale flag 影响下一次普通 interrupt。
      this.preserveQueueOnInterrupt.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((err) => {
          console.error("[WAND] sdk interrupt-and-send failed:", err);
        });
      });
      return;
    }

    if (killedForAskUserQuestion) {
      if ((finished.queuedMessages?.length ?? 0) > 0) {
        setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
      }
      return;
    }

    // Auto-continue after ExitPlanMode (same as CLI runner)
    const lastToolUse = [...turnState.blocks].reverse().find(
      (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
    );
    if (lastToolUse && lastToolUse.name === "ExitPlanMode" && turnState.sessionId) {
      setImmediate(() => {
        this.sendMessage(sessionId, "Plan approved. Proceed with the implementation.").catch((err) => {
          console.error("[WAND] sdk auto-continue after ExitPlanMode failed:", err);
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

  private buildCompletedAssistantMessages(current: SessionSnapshot, turnState: StreamingTurnState): ConversationTurn[] {
    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: this.compactContentBlocks([...turnState.blocks], turnState.result),
      usage: turnState.usage,
    };
    const msgs = [...(current.messages ?? [])];
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = assistantTurn;
    else msgs.push(assistantTurn);
    return msgs;
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
    provider: "claude -p" | "codex exec" | "opencode run",
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
  ): SessionSnapshot {
    const failureTurn: ConversationTurn = {
      role: "assistant",
      content: [{ type: "text", text: `结构化会话执行失败：${errorText}` }],
    };
    const msgs = [...(current.messages ?? [])];
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = failureTurn;
    else msgs.push(failureTurn);
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
      structuredState: {
        ...(current.structuredState as StructuredSessionState),
        model: turnState.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: errorText,
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
