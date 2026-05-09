import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import type { query as SdkQueryFn, Options as SdkOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { prepareSessionWorktree } from "./git-worktree.js";

import { SessionLogger } from "./session-logger.js";
import { WandStorage } from "./storage.js";
import {
  CardExpandDefaults, ContentBlock, ConversationTurn, EscalationRequest, EscalationScope,
  ExecutionMode, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, StructuredSessionState,
  WandConfig,
} from "./types.js";
import { truncateMessagesForTransport } from "./message-truncator.js";

interface CreateStructuredSessionOptions {
  cwd: string;
  mode: ExecutionMode;
  prompt?: string;
  provider?: SessionProvider;
  runner?: SessionRunner;
  worktreeEnabled?: boolean;
  /** 用户指定的 Claude 模型（别名或完整 ID）。留空则 spawn 时不加 --model。 */
  model?: string;
}

function defaultStructuredRunner(provider: SessionProvider): SessionRunner {
  return provider === "codex" ? "codex-cli-exec" : "claude-cli-print";
}

function defaultStructuredState(provider: SessionProvider, runner = defaultStructuredRunner(provider)): StructuredSessionState {
  return {
    provider,
    runner,
    lastError: null,
    inFlight: false,
    activeRequestId: null,
  };
}

/** Accumulated state while streaming a single claude -p response. */
interface StreamingTurnState {
  blocks: ContentBlock[];
  result: string;
  sessionId: string | null;
  model?: string;
  usage?: ConversationTurn["usage"];
}

const STREAM_EMIT_DEBOUNCE_MS = 16;
/** Min interval between full saveSession() calls for an in-progress streaming turn.
 *  saveSession serializes the entire messages array, so doing it on every NDJSON
 *  event is N². close-path always calls saveSession unconditionally to take the
 *  authoritative final snapshot. */
const STREAM_SAVE_THROTTLE_MS = 200;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;

function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0 || process.geteuid?.() === 0;
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
  };
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
  private readonly pendingChildren = new Map<string, ChildProcess>();
  private readonly pendingSdkAbort = new Map<string, AbortController>();
  private readonly interruptedWith = new Map<string, string>();
  /** Last wall-clock time (ms) we did a full saveSession for a streaming session. */
  private readonly lastStreamSaveAt = new Map<string, number>();
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

  constructor(
    private readonly storage: WandStorage,
    private readonly config: WandConfig,
    private readonly logger: SessionLogger | null = null,
  ) {
    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "structured") continue;
      const restoredStatus = snapshot.status === "running" ? "idle" : snapshot.status;
      const restored: SessionSnapshot = {
        ...snapshot,
        sessionKind: "structured",
        provider: snapshot.provider ?? snapshot.structuredState?.provider ?? "claude",
        runner: snapshot.runner ?? snapshot.structuredState?.runner ?? defaultStructuredRunner(snapshot.provider ?? snapshot.structuredState?.provider ?? "claude"),
        status: restoredStatus,
        autoApprovePermissions: snapshot.autoApprovePermissions ?? shouldAutoApproveForMode(snapshot.mode),
        approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
        queuedMessages: snapshot.queuedMessages ?? [],
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          provider: snapshot.structuredState?.provider ?? snapshot.provider ?? "claude",
          runner: snapshot.runner ?? snapshot.structuredState?.runner ?? defaultStructuredRunner(snapshot.structuredState?.provider ?? snapshot.provider ?? "claude"),
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
      this.storage.saveSession(session);
    }
  }

  setEventEmitter(emitEvent: (event: ProcessEvent) => void): void {
    this.emitEvent = emitEvent;
  }

  /**
   * In-memory snapshot is updated unconditionally; the SQLite write is rate-
   * limited to once per STREAM_SAVE_THROTTLE_MS. Caller must still invoke
   * `storage.saveSession` directly at terminal events (close / failure) so the
   * final state is durable.
   */
  private saveStreamingSnapshot(snapshot: SessionSnapshot): void {
    const now = Date.now();
    const last = this.lastStreamSaveAt.get(snapshot.id) ?? 0;
    if (now - last < STREAM_SAVE_THROTTLE_MS) return;
    this.lastStreamSaveAt.set(snapshot.id, now);
    this.storage.saveSession(snapshot);
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

  createSession(options: CreateStructuredSessionOptions): SessionSnapshot {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const prompt = options.prompt?.trim();
    const provider: SessionProvider = options.provider === "codex" ? "codex" : "claude";
    const runner = options.runner ?? defaultStructuredRunner(provider);
    const worktreeSetup = options.worktreeEnabled
      ? prepareSessionWorktree({ cwd: options.cwd, sessionId: id })
      : null;
    const selectedModel = options.model?.trim() || null;
    const snapshot: SessionSnapshot = {
      id,
      sessionKind: "structured",
      provider,
      runner,
      command: provider === "codex" ? "codex exec --json" : "claude -p --output-format stream-json",
      cwd: worktreeSetup?.cwd ?? options.cwd,
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
      claudeSessionId: null,
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
    };

    this.sessions.set(id, snapshot);
    this.storage.saveSession(snapshot);
    this.emit({ type: "started", sessionId: id, data: { sessionKind: "structured" } });

    return snapshot;
  }

  async sendMessage(
    id: string,
    input: string,
    opts?: { interrupt?: boolean; idempotencyKey?: string },
  ): Promise<SessionSnapshot> {
    let session = this.requireSession(id);
    const prompt = input.trim();
    if (!prompt) return session;
    if (opts?.idempotencyKey) {
      const mapKey = `${id}:${opts.idempotencyKey}`;
      if (this.seenIdempotencyKeys.has(mapKey)) {
        console.log("[WAND] sendMessage: duplicate idempotency key rejected", { id, key: opts.idempotencyKey });
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
      const child = this.pendingChildren.get(id);
      const childAlive = child && !child.killed && child.exitCode === null;
      if (!childAlive) {
        if (child) this.pendingChildren.delete(id);
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
        this.storage.saveSession(recovered);
        session = recovered;
      } else if (opts?.interrupt) {
        this.interruptedWith.set(id, prompt);
        try { child.kill("SIGTERM"); } catch (_err) { /* ignore */ }
        const sdkAbort = this.pendingSdkAbort.get(id);
        if (sdkAbort) sdkAbort.abort();
        return session;
      } else {
        const queue = [...(session.queuedMessages ?? [])];
        if (queue.length >= 10) {
          throw new Error("排队消息已满（最多 10 条），请等待当前消息处理完成。");
        }
        const queued: SessionSnapshot = {
          ...session,
          queuedMessages: [...queue, prompt],
        };
        this.sessions.set(id, queued);
        this.storage.saveSession(queued);
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
    this.storage.saveSession(updated);
    this.emitStructuredSnapshot(updated);
    this.emit({
      type: "status",
      sessionId: id,
      data: { status: "running", sessionKind: "structured", queuedMessages: updated.queuedMessages, structuredState: updated.structuredState },
    });

    // 续接 AskUserQuestion 时给 Claude 加上下文，避免它把刚才悬挂的 tool_use 当作
    // 异常重试。结构化模式 (claude -p) 没有 tool_result 回传通道，所以用文本告知。
    const claudePrompt = pendingAsk
      ? `[对刚才 AskUserQuestion 工具的回答 — 结构化模式不支持工具结果回传，下面是用户从选项中的选择]\n${prompt}`
      : prompt;

    try {
      if ((updated.provider ?? "claude") === "codex") {
        await this.runCodexStreaming(id, updated, prompt);
      } else if (this.config.structuredRunner === "sdk") {
        await this.runClaudeSdkStreaming(id, updated, claudePrompt);
      } else {
        await this.runClaudeStreaming(id, updated, claudePrompt);
      }
      const finished = this.requireSession(id);
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.sessions.get(id);
      if (!current) throw error;
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
      this.storage.saveSession(failed);
      this.emit({
        type: "status",
        sessionId: id,
        data: { status: failed.status, error: message, sessionKind: "structured", queuedMessages: failed.queuedMessages, structuredState: failed.structuredState },
      });
      this.emitStructuredSnapshot(failed, "ended");
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Permission resolution (called from server routes)
  // ---------------------------------------------------------------------------

  /** Approve a pending permission request. */
  approvePermission(sessionId: string): SessionSnapshot {
    return this.resolvePermission(sessionId, true);
  }

  /** Deny a pending permission request. */
  denyPermission(sessionId: string): SessionSnapshot {
    return this.resolvePermission(sessionId, false);
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
    this.storage.saveSession(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", selectedModel: normalized, structuredState: updated.structuredState },
    });
    return updated;
  }

  /** Toggle auto-approve for the session. */
  toggleAutoApprove(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const newVal = !session.autoApprovePermissions;
    const updated: SessionSnapshot = { ...session, autoApprovePermissions: newVal };
    this.sessions.set(sessionId, updated);
    this.storage.saveSession(updated);
    return updated;
  }

  /** Resolve a specific escalation by requestId. */
  resolveEscalation(sessionId: string, requestId: string, resolution?: "approve_once" | "approve_turn" | "deny"): SessionSnapshot {
    const approved = resolution !== "deny";
    const session = this.requireSession(sessionId);
    const scope = session.pendingEscalation?.scope;
    if (approved && scope) {
      this.incrementApprovalStats(session, scope);
    }
    const updated: SessionSnapshot = {
      ...session,
      pendingEscalation: null,
      permissionBlocked: false,
      lastEscalationResult: session.pendingEscalation ? {
        requestId: session.pendingEscalation.requestId,
        resolution: approved ? "approve_once" : "deny",
        reason: approved ? "user_approved" : "user_denied",
      } : session.lastEscalationResult ?? null,
    };
    this.sessions.set(sessionId, updated);
    this.storage.saveSession(updated);
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
    const child = this.pendingChildren.get(id);
    if (child) {
      child.kill();
      this.pendingChildren.delete(id);
    }
    const sdkAbort = this.pendingSdkAbort.get(id);
    if (sdkAbort) {
      sdkAbort.abort();
      this.pendingSdkAbort.delete(id);
    }
    const stopped: SessionSnapshot = {
      ...session,
      status: "stopped",
      endedAt: new Date().toISOString(),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        inFlight: false,
        activeRequestId: null,
      },
    };
    this.sessions.set(id, stopped);
    this.storage.saveSession(stopped);
      this.emitStructuredSnapshot(stopped, "ended");
    return stopped;
  }

  delete(id: string): void {
    const child = this.pendingChildren.get(id);
    if (child) {
      child.kill();
      this.pendingChildren.delete(id);
    }
    const sdkAbort = this.pendingSdkAbort.get(id);
    if (sdkAbort) {
      sdkAbort.abort();
      this.pendingSdkAbort.delete(id);
    }
    this.sessions.delete(id);
    this.lastStreamSaveAt.delete(id);
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

  private buildQueuedPlaceholderTurns(session: SessionSnapshot): ConversationTurn[] {
    return (session.queuedMessages ?? []).map((text) => ({
      role: "user",
      content: [{ type: "text", text, __queued: true } as ContentBlock],
    }));
  }

  private buildRenderableMessages(session: SessionSnapshot): ConversationTurn[] {
    return [
      ...(session.messages ?? []),
      ...this.buildQueuedPlaceholderTurns(session),
    ];
  }

  private emitStructuredSnapshot(session: SessionSnapshot, eventType: "output" | "ended" = "output"): void {
    const payload = buildStructuredOutputPayload(session) as Record<string, unknown>;
    const data = {
      ...payload,
      messages: this.buildRenderableMessages(session),
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
    this.storage.saveSession(nextSession);
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
        this.storage.saveSession(rescued);
        this.emitStructuredSnapshot(rescued);
      }
    }
  }

  private emit(event: ProcessEvent): void {
    if (this.emitEvent) {
      this.emitEvent(event);
    }
  }

  private resolvePermission(sessionId: string, approved: boolean): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const scope = session.pendingEscalation?.scope;
    if (approved && scope) {
      this.incrementApprovalStats(session, scope);
    }
    const updated: SessionSnapshot = {
      ...session,
      pendingEscalation: null,
      permissionBlocked: false,
      lastEscalationResult: session.pendingEscalation ? {
        requestId: session.pendingEscalation.requestId,
        resolution: approved ? "approve_once" : "deny",
        reason: approved ? "user_approved" : "user_denied",
      } : session.lastEscalationResult ?? null,
    };
    this.sessions.set(sessionId, updated);
    this.storage.saveSession(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { permissionBlocked: false, approvalStats: updated.approvalStats, sessionKind: "structured" },
    });
    return updated;
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
  // CLI argument construction
  // ---------------------------------------------------------------------------
  private buildPermissionArgs(mode: ExecutionMode, autoApprove: boolean): string[] {
    const shouldBypass = autoApprove || mode === "full-access" || mode === "managed";
    const shouldAcceptEdits = mode === "auto-edit";

    if (!isRunningAsRoot()) {
      if (shouldBypass) {
        return ["--permission-mode", "bypassPermissions"];
      }
      if (shouldAcceptEdits) {
        return ["--permission-mode", "acceptEdits"];
      }
      return [];
    }

    // Root: Claude CLI refuses bypassPermissions.
    // acceptEdits auto-approves within CWD; --allowedTools extends to all paths.
    if (shouldBypass || shouldAcceptEdits) {
      return [
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep",
        "NotebookEdit", "WebFetch", "WebSearch",
      ];
    }
    return [];
  }

  private buildCodexArgs(session: SessionSnapshot): string[] {
    const args = ["exec", "--json", "--color", "never"];
    const shouldBypass = session.autoApprovePermissions === true || session.mode === "full-access" || session.mode === "managed";
    if (shouldBypass) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (session.mode === "auto-edit" || session.mode === "agent" || session.mode === "agent-max") {
      args.push("--sandbox", "workspace-write");
    } else {
      args.push("--sandbox", "read-only");
    }
    args.push("--skip-git-repo-check");
    const modelChoice = session.selectedModel?.trim();
    if (modelChoice && modelChoice !== "default") {
      args.push("--model", modelChoice);
    }
    if (session.claudeSessionId) {
      args.push("resume", session.claudeSessionId, "-");
    } else {
      args.push("-");
    }
    return args;
  }

  // ---------------------------------------------------------------------------
  // Streaming codex exec --json execution
  // ---------------------------------------------------------------------------

  private runCodexStreaming(sessionId: string, session: SessionSnapshot, prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = this.buildCodexArgs(session);
      const spawnedAt = new Date().toISOString();
      const child = spawn("codex", args, {
        cwd: session.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.logger?.appendStructuredSpawn(sessionId, {
        kind: "codex-exec",
        provider: "codex",
        pid: child.pid ?? null,
        cwd: session.cwd,
        args,
        prompt: prompt.slice(0, 2048),
        promptLength: prompt.length,
        threadId: session.claudeSessionId,
        spawnedAt,
      });
      this.pendingChildren.set(sessionId, child);
      child.stdin?.end(prompt);

      const turnState: StreamingTurnState = {
        blocks: [],
        result: "",
        sessionId: session.claudeSessionId,
        model: session.selectedModel ?? session.structuredState?.model,
        usage: undefined,
      };
      let lineBuf = "";
      let stderr = "";
      let emitTimer: ReturnType<typeof setTimeout> | null = null;
      // codex 把所有错误（包括重试日志和最终失败原因）都通过 stdout 的 NDJSON 事件
      // 输出，stderr 通常是空的。我们在 processLine 里收集这些，然后在 close 中
      // 决定真正的报错文本。
      const codexErrors: string[] = [];
      let codexTurnFailed: string | null = null;

      const flushEmit = (): void => {
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = null;
        }
        const current = this.sessions.get(sessionId);
        if (!current) return;
        this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
      };

      const scheduleEmit = (): void => {
        if (!emitTimer) emitTimer = setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS);
      };

      const syncSnapshot = (): void => {
        const current = this.sessions.get(sessionId);
        if (!current) return;
        const inProgressTurn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          msgs[msgs.length - 1] = inProgressTurn;
        } else {
          msgs.push(inProgressTurn);
        }
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

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try { parsed = JSON.parse(trimmed); } catch { return; }
        this.logger?.appendStreamEvent(sessionId, parsed);
        if (parsed?.type === "thread.started" && typeof parsed.thread_id === "string") {
          turnState.sessionId = parsed.thread_id;
          syncSnapshot();
          return;
        }
        if (parsed?.type === "item.started" && parsed.item) {
          const block = this.extractCodexItemBlock(parsed.item, false);
          if (block) {
            turnState.blocks.push(block);
            syncSnapshot();
            scheduleEmit();
          }
          return;
        }
        if (parsed?.type === "item.completed" && parsed.item) {
          const block = this.extractCodexItemBlock(parsed.item, true);
          if (block) {
            if (block.type === "text") turnState.result = block.text;
            this.upsertCodexBlock(turnState.blocks, block);
            syncSnapshot();
            scheduleEmit();
          }
          return;
        }
        if (parsed?.type === "turn.completed") {
          turnState.usage = this.extractCodexUsage(parsed.usage) ?? turnState.usage;
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (parsed?.type === "error") {
          const message = typeof parsed.message === "string" ? parsed.message : "";
          if (message) codexErrors.push(message);
          return;
        }
        if (parsed?.type === "turn.failed") {
          const errObj = (parsed.error && typeof parsed.error === "object") ? parsed.error as Record<string, unknown> : null;
          const message = (errObj && typeof errObj.message === "string" && errObj.message)
            || (typeof parsed.message === "string" ? parsed.message : "")
            || "codex turn failed";
          codexTurnFailed = message;
          return;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.logger?.appendStructuredStdout(sessionId, text);
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.logger?.appendStructuredStderr(sessionId, text);
        stderr += text;
      });

      child.on("error", (error) => {
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        if (emitTimer) clearTimeout(emitTimer);
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "codex-exec-error",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt: new Date().toISOString(),
          spawnError: error.message,
        });
        reject(error);
      });

      child.on("close", (code) => {
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        if (lineBuf.trim()) {
          processLine(lineBuf);
          lineBuf = "";
        }
        flushEmit();
        const closedAt = new Date().toISOString();
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "codex-exec-close",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt,
          exitCode: code,
          stderrTail: stderr.slice(-2048),
          codexErrors,
          codexTurnFailed,
        });
        const current = this.sessions.get(sessionId);
        if (!current) {
          reject(new Error("Session removed during execution."));
          return;
        }
        // 主动中断时（interruptedWith 里有新消息），不走失败路径
        const interruptedByUser = this.interruptedWith.has(sessionId);
        const interruptPrompt = this.interruptedWith.get(sessionId);
        // codex 把模型/网络/沙箱等错误写到 stdout 的 NDJSON 流（type: error / turn.failed），
        // 而不是 stderr。我们以 turn.failed 的 message 为准，其次是最后一个 error 事件。
        const codexFailed = codexTurnFailed !== null;
        if ((codexFailed || (code !== 0 && code !== null)) && !interruptedByUser) {
          const errorText = (codexTurnFailed && codexTurnFailed.trim())
            || (codexErrors.length > 0 ? codexErrors[codexErrors.length - 1] : "")
            || stderr.trim()
            || `codex exec exited with code ${code}`;
          const exitForSnapshot = typeof code === "number" ? code : 1;
          const failed = this.finishStructuredFailure(current, exitForSnapshot, errorText, turnState);
          this.sessions.set(sessionId, failed);
          this.storage.saveSession(failed);
          this.emitStructuredSnapshot(failed);
          this.emitStructuredSnapshot(failed, "ended");
          reject(new Error(errorText));
          return;
        }
        const assistantTurn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = assistantTurn;
        else msgs.push(assistantTurn);
        const keepRunning = !!interruptPrompt;
        const finished: SessionSnapshot = {
          ...current,
          status: keepRunning ? "running" : "idle",
          exitCode: keepRunning ? null : 0,
          endedAt: keepRunning ? null : new Date().toISOString(),
          output: turnState.result,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages: msgs,
          queuedMessages: interruptPrompt ? [] : current.queuedMessages,
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
        this.storage.saveSession(finished);
        this.emitStructuredSnapshot(finished);
        if (!keepRunning) {
          this.emitStructuredSnapshot(finished, "ended");
        }
        if (interruptPrompt) {
          this.interruptedWith.delete(sessionId);
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((err) => {
              console.error("[WAND] codex interrupt-and-send failed:", err);
              const afterFail = this.sessions.get(sessionId);
              if (afterFail) {
                const recovered: SessionSnapshot = {
                  ...afterFail,
                  status: "idle",
                  exitCode: 0,
                  endedAt: new Date().toISOString(),
                  structuredState: {
                    ...(afterFail.structuredState as StructuredSessionState),
                    inFlight: false,
                    activeRequestId: null,
                  },
                };
                this.sessions.set(sessionId, recovered);
                this.storage.saveSession(recovered);
                this.emitStructuredSnapshot(recovered);
              }
            });
          });
          return;
        }
        resolve();
        setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
      });
    });
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
  private runClaudeStreaming(sessionId: string, session: SessionSnapshot, prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = ["-p", "--verbose", "--output-format", "stream-json"];

      // Add permission args based on mode + autoApprovePermissions toggle
      const permArgs = this.buildPermissionArgs(session.mode, session.autoApprovePermissions ?? false);
      args.push(...permArgs);

      // Append language-aware system prompts
      const language = this.config.language?.trim();
      const isChinese = language === "中文";

      // In managed mode, append autonomous system prompt
      if (session.mode === "managed") {
        args.push(
          "--append-system-prompt",
          isChinese
            ? "你正在完全托管的自主模式下运行。用户可能无法及时回复问题或确认。你必须独立做出所有决策——自行选择最佳方案，而不是向用户询问偏好、确认或澄清。如果有多种可行方案，选择你认为最合适的并继续执行。除非任务本身存在根本性的歧义且无法合理推断，否则不要等待用户输入。果断行动，自主决策。"
            : "You are running in a fully managed, autonomous mode. The user may not be available to respond to questions or confirmations in a timely manner. You MUST make all decisions independently — choose the best approach yourself instead of asking the user for preferences, confirmations, or clarifications. If multiple approaches are viable, pick the one you judge most appropriate and proceed. Never block on user input unless the task is fundamentally ambiguous and cannot be reasonably inferred. Be decisive and self-directed.",
        );
      }

      // Append language preference if configured
      if (language) {
        args.push(
          "--append-system-prompt",
          isChinese
            ? "请使用中文回复。所有解释、注释和对话文本都使用中文。"
            : `Please respond in ${language}. Use ${language} for all your explanations, comments, and conversational text.`,
        );
      }

      const modelChoice = session.selectedModel?.trim();
      if (modelChoice && modelChoice !== "default") {
        args.push("--model", modelChoice);
      }

      // 托管模式：禁用 AskUserQuestion，让 agent 自己拍板，不要等用户决策。
      // 非托管模式：保留工具，靠 processLine 检测后主动 kill child 触发"中断+续接"流程。
      const isManaged = session.mode === "managed";
      if (isManaged) {
        args.push("--disallowedTools", "AskUserQuestion");
      }

      if (session.claudeSessionId) {
        args.push("--resume", session.claudeSessionId);
      }

      // 通过 stdin 传 prompt，避免被 --allowedTools / --disallowedTools 这类
      // variadic 参数贪婪吞掉（commander 的 <tools...> 会一直吃 positional 直到
      // 下一个 flag）。表现为 claude 报 "Input must be provided either through
      // stdin or as a prompt argument when using --print"。
      const spawnedAt = new Date().toISOString();
      const child = spawn("claude", args, {
        cwd: session.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.logger?.appendStructuredSpawn(sessionId, {
        kind: "claude-print",
        provider: "claude",
        pid: child.pid ?? null,
        cwd: session.cwd,
        args,
        prompt: prompt.slice(0, 2048),
        promptLength: prompt.length,
        claudeSessionId: session.claudeSessionId,
        spawnedAt,
      });
      this.pendingChildren.set(sessionId, child);
      child.stdin?.end(prompt);

      const turnState: StreamingTurnState = {
        blocks: [],
        result: "",
        sessionId: null,
        model: undefined,
        usage: undefined,
      };

      // claude -p --output-format stream-json 在同一条消息流式生成期间会重复
      // emit 同一个 message.id 的 "assistant" 事件，每次 content 略多一些；子
      // agent 流（Task 工具）则会插入若干 parent_tool_use_id 不同的 message.id。
      // 朴素的 push(...content) 会让早期片段被反复合并复制，最终被 compact 出
      // 怪异结果，导致 UI 上 tool_use / 子 agent 输出"显示一下就消失"。
      // 这里按 (message.id) 去重，相同 id 视作同一消息的更新覆盖；tool_result
      // 用单调递增的合成 key 顺序追加。每次事件后用插入顺序重建 turnState.blocks。
      const blocksByKey = new Map<string, ContentBlock[]>();
      const keyOrder: string[] = [];
      let toolResultSeq = 0;
      const upsertBlocks = (key: string, blocks: ContentBlock[]): void => {
        if (!blocksByKey.has(key)) keyOrder.push(key);
        blocksByKey.set(key, blocks);
      };
      const rebuildTurnBlocks = (): void => {
        const flat: ContentBlock[] = [];
        for (const key of keyOrder) {
          const entry = blocksByKey.get(key);
          if (entry && entry.length > 0) flat.push(...entry);
        }
        turnState.blocks = flat;
      };

      // Line buffer for NDJSON: chunks from stdout may split mid-line.
      let lineBuf = "";

      // Debounce output events to avoid flooding the WebSocket.
      let emitTimer: ReturnType<typeof setTimeout> | null = null;

      // 当 Claude 在非托管模式调用 AskUserQuestion 时，stdin 关闭导致它会 hang 等
      // tool_result。我们检测到后主动 kill child，让它顺利退出，UI 把 tool_use 卡片
      // 渲染成可交互选项；用户提交后由 sendMessage() 通过 --resume 续接。
      let killedForAskUserQuestion = false;

      const flushEmit = (): void => {
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = null;
        }
        const current = this.sessions.get(sessionId);
        if (!current) return;
        this.emit({
          type: "output",
          sessionId,
          data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}),
        });
      };

      const scheduleEmit = (): void => {
        if (!emitTimer) {
          emitTimer = setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS);
        }
      };

      /** Update the session snapshot with the current in-progress assistant turn. */
      const syncSnapshot = (): void => {
        const current = this.sessions.get(sessionId);
        if (!current) return;
        const inProgressTurn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        // Replace or append the in-progress assistant turn at the end of messages.
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          msgs[msgs.length - 1] = inProgressTurn;
        } else {
          msgs.push(inProgressTurn);
        }
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
        // Persist streaming progress so a server restart does not roll back the
        // latest assistant turn to the pre-stream snapshot. Throttled because
        // saveSession serializes the full messages array.
        this.saveStreamingSnapshot(patched);
      };

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        this.logger?.appendStreamEvent(sessionId, parsed);

        if (parsed && parsed.type === "assistant" && parsed.message) {
          const extracted = this.extractAssistantMessage(parsed.message);
          // 用 message.id 作为 key：claude -p 流式重发同一条消息时整段覆盖
          // （而不是与早期片段累加），子 agent 的不同消息 id 各占一格、保留
          // 父子完整顺序。没有 id 时退化为合成 key 走追加模式。
          const msgId = typeof parsed.message.id === "string" && parsed.message.id
            ? `assistant:${parsed.message.id}`
            : `assistant:anon:${keyOrder.length}`;
          if (extracted.content.length > 0) {
            upsertBlocks(msgId, extracted.content);
            rebuildTurnBlocks();
          }
          // NOTE: usage from streaming "assistant" events contains partial/incremental
          // token counts (e.g. output_tokens=1 during streaming) and is NOT accurate.
          // We only use the authoritative usage from the final "result" event.
          syncSnapshot();
          scheduleEmit();

          // 非托管模式下检测 AskUserQuestion：claude -p 的 stdin 被 ignore，无法回传
          // tool_result，进程会 hang 住。主动 SIGTERM 让它退出；后续用户提交答案时由
          // sendMessage() 注入伪造的 tool_result 并通过 --resume 续接。
          if (!isManaged && !killedForAskUserQuestion) {
            const askBlock = extracted.content.find(
              (b): b is ContentBlock & { type: "tool_use" } =>
                b.type === "tool_use" && b.name === "AskUserQuestion",
            );
            if (askBlock) {
              killedForAskUserQuestion = true;
              flushEmit();
              try { child.kill("SIGTERM"); } catch (_err) { /* ignore */ }
            }
          }
          return;
        }

        if (parsed && parsed.type === "user" && parsed.message && Array.isArray(parsed.message.content)) {
          // tool_result 没有自身 id，按到达顺序用合成 key 追加（永远不被覆盖）。
          const collected: ContentBlock[] = [];
          for (const block of parsed.message.content) {
            if (block && block.type === "tool_result") {
              collected.push({
                type: "tool_result",
                tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
                content: this.normalizeToolResultContent(block.content),
                is_error: block.is_error === true,
              });
            }
          }
          if (collected.length > 0) {
            upsertBlocks(`tool_result:${toolResultSeq++}`, collected);
            rebuildTurnBlocks();
          }
          syncSnapshot();
          scheduleEmit();
          return;
        }

        if (parsed && parsed.type === "result") {
          if (typeof parsed.result === "string") {
            turnState.result = parsed.result.trim();
          }
          if (typeof parsed.session_id === "string") {
            turnState.sessionId = parsed.session_id;
          }
          turnState.model = this.extractModelName(parsed.modelUsage) ?? turnState.model;
          turnState.usage = this.extractUsage(parsed) ?? turnState.usage;
          syncSnapshot();
          scheduleEmit();
        }
      };

      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.logger?.appendStructuredStdout(sessionId, text);
        lineBuf += text;
        const lines = lineBuf.split("\n");
        // Keep the last (possibly incomplete) segment in the buffer.
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.logger?.appendStructuredStderr(sessionId, text);
        stderr += text;
      });

      child.on("error", (error) => {
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        if (emitTimer) clearTimeout(emitTimer);
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-print-error",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt: new Date().toISOString(),
          spawnError: error.message,
        });
        reject(error);
      });

      child.on("close", (code) => {
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-print-close",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt: new Date().toISOString(),
          exitCode: code,
          stderrTail: stderr.slice(-2048),
        });

        // Process any remaining data in the line buffer.
        if (lineBuf.trim()) {
          processLine(lineBuf);
          lineBuf = "";
        }

        // Flush any pending debounced emit before finalizing.
        flushEmit();

        // Finalize the session snapshot.
        const current = this.sessions.get(sessionId);
        if (!current) {
          reject(new Error("Session removed during execution."));
          return;
        }

        // 如果是用户主动中断（interruptedWith 里有新消息），claude -p 收到 SIGTERM 后
        // 可能以非零 exit code 退出（内部 handler 调了 exit(1)）。这种情况属于正常
        // 中断流程，不应走失败路径——后续 interruptedWith 逻辑会发送新消息。
        const interruptedByUser = this.interruptedWith.has(sessionId);
        if (code !== 0 && code !== null && !interruptedByUser) {
          const errorText = stderr.trim() || `claude -p exited with code ${code}`;
          const failureTurn: ConversationTurn = {
            role: "assistant",
            content: [{ type: "text", text: `结构化会话执行失败：${errorText}` }],
          };
          const msgs = [...(current.messages ?? [])];
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            msgs[msgs.length - 1] = failureTurn;
          } else {
            msgs.push(failureTurn);
          }
          const failed: SessionSnapshot = {
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
          this.sessions.set(sessionId, failed);
          this.storage.saveSession(failed);
          this.emitStructuredSnapshot(failed);
          this.emitStructuredSnapshot(failed, "ended");
          reject(new Error(errorText));
          return;
        }

        // Build the final assistant turn.
        const finalContent = this.compactContentBlocks([...turnState.blocks], turnState.result);
        const assistantTurn: ConversationTurn = {
          role: "assistant",
          content: finalContent,
          usage: turnState.usage,
        };

        // Ensure the final messages list has the completed assistant turn.
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          msgs[msgs.length - 1] = assistantTurn;
        } else {
          msgs.push(assistantTurn);
        }

        // 被 AskUserQuestion 检测或用户中断主动 kill 时，保持 status="running"
        // 让 UI 不跳到"已停止"。inFlight=false 才能触发后续 sendMessage。
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
          queuedMessages: interruptPrompt ? [] : current.queuedMessages,
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
        this.storage.saveSession(finished);

        this.emitStructuredSnapshot(finished);
        if (!keepRunning) {
          this.emitStructuredSnapshot(finished, "ended");
        }

        // 等待用户回答 AskUserQuestion 时，跳过后续自续接和队列推进。
        if (killedForAskUserQuestion) {
          resolve();
          return;
        }

        // 用户中断当前回复：保存部分回复后立即发送新消息。
        if (interruptPrompt) {
          this.interruptedWith.delete(sessionId);
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((err) => {
              console.error("[WAND] interrupt-and-send failed:", err);
              // 续接失败：把状态回滚到 idle，让用户可以重新输入而不是卡在 running 状态
              const afterFail = this.sessions.get(sessionId);
              if (afterFail) {
                const recovered: SessionSnapshot = {
                  ...afterFail,
                  status: "idle",
                  exitCode: 0,
                  endedAt: new Date().toISOString(),
                  structuredState: {
                    ...(afterFail.structuredState as StructuredSessionState),
                    inFlight: false,
                    activeRequestId: null,
                  },
                };
                this.sessions.set(sessionId, recovered);
                this.storage.saveSession(recovered);
                this.emitStructuredSnapshot(recovered);
              }
            });
          });
          return;
        }

        // Auto-continue after plan mode exit: when Claude calls ExitPlanMode,
        // the `-p` process exits because stdin is "ignore" and it cannot get
        // user confirmation.  Detect this and automatically resume execution
        // so the plan is actually carried out.
        const lastToolUse = [...turnState.blocks].reverse().find(
          (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
        );
        if (lastToolUse && lastToolUse.name === "ExitPlanMode" && turnState.sessionId) {
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, "Plan approved. Proceed with the implementation.").catch((err) => {
              console.error("[WAND] Auto-continue after ExitPlanMode failed:", err);
            });
          });
          return;
        }

        resolve();
        setImmediate(() => {
          void this.flushNextQueuedMessage(sessionId);
        });
      });    });
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
  private runClaudeSdkStreaming(sessionId: string, session: SessionSnapshot, prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void this._runClaudeSdkStreamingAsync(sessionId, session, prompt).then(resolve, reject);
    });
  }

  private async _runClaudeSdkStreamingAsync(sessionId: string, session: SessionSnapshot, prompt: string): Promise<void> {
    let sdkQuery: typeof SdkQueryFn;
    try {
      const sdkMod = await import("@anthropic-ai/claude-agent-sdk");
      sdkQuery = sdkMod.query as typeof SdkQueryFn;
    } catch {
      throw new Error("@anthropic-ai/claude-agent-sdk 未安装，无法使用 SDK runner。");
    }

    const abortController = new AbortController();
    this.pendingSdkAbort.set(sessionId, abortController);

    const isManaged = session.mode === "managed";
    let killedForAskUserQuestion = false;

    // Derive permission mode (mirrors buildPermissionArgs logic)
    const shouldBypass = (session.autoApprovePermissions ?? false) || session.mode === "full-access" || session.mode === "managed";
    const shouldAcceptEdits = session.mode === "auto-edit";

    let permissionMode: SdkOptions["permissionMode"] = "default";
    let allowedToolsForRoot: string[] | undefined;
    if (!isRunningAsRoot()) {
      if (shouldBypass) permissionMode = "bypassPermissions";
      else if (shouldAcceptEdits) permissionMode = "acceptEdits";
    } else {
      // Root: acceptEdits + allowedTools (same workaround as CLI runner)
      if (shouldBypass || shouldAcceptEdits) {
        permissionMode = "acceptEdits";
        allowedToolsForRoot = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch"];
      }
    }

    // System prompt additions
    const isChinese = this.config.language?.trim() === "中文";
    const systemPromptParts: string[] = [];
    if (isManaged) {
      systemPromptParts.push(
        isChinese
          ? "你正在完全托管的自主模式下运行。用户可能无法及时回复问题或确认。你必须独立做出所有决策——自行选择最佳方案，而不是向用户询问偏好、确认或澄清。如果有多种可行方案，选择你认为最合适的并继续执行。除非任务本身存在根本性的歧义且无法合理推断，否则不要等待用户输入。果断行动，自主决策。"
          : "You are running in a fully managed, autonomous mode. The user may not be available to respond to questions or confirmations in a timely manner. You MUST make all decisions independently — choose the best approach yourself instead of asking the user for preferences, confirmations, or clarifications. If multiple approaches are viable, pick the one you judge most appropriate and proceed. Never block on user input unless the task is fundamentally ambiguous and cannot be reasonably inferred. Be decisive and self-directed.",
      );
    }
    const language = this.config.language?.trim();
    if (language) {
      systemPromptParts.push(
        isChinese
          ? "请使用中文回复。所有解释、注释和对话文本都使用中文。"
          : `Please respond in ${language}. Use ${language} for all your explanations, comments, and conversational text.`,
      );
    }

    const sdkOptions: SdkOptions = {
      cwd: session.cwd,
      abortController,
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(allowedToolsForRoot ? { allowedTools: allowedToolsForRoot } : {}),
      ...(isManaged ? { disallowedTools: ["AskUserQuestion"] } : {}),
      includePartialMessages: true,
      ...(systemPromptParts.length > 0 ? { appendSystemPrompt: systemPromptParts.join("\n\n") } : {}),
    };

    if (session.claudeSessionId) (sdkOptions as Record<string, unknown>).resume = session.claudeSessionId;

    const modelChoice = session.selectedModel?.trim();
    if (modelChoice && modelChoice !== "default") sdkOptions.model = modelChoice;

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
    const streamingBlockByIndex = new Map<number, {
      type: "text" | "thinking" | "tool_use";
      id?: string;
      name?: string;
      text: string;
      thinking: string;
      partialInput: string;
      finalized: boolean;
    }>();

    // Blocks from messages that have already completed within this turn — including
    // the parent assistant's prior messages, every subagent assistant message, and
    // every tool_result. Subagent (Task tool) flows produce many assistant messages
    // back-to-back; without this list, each new streaming message would visually
    // erase everything that came before it in the same turn.
    const finalizedBlocks: ContentBlock[] = [];

    let emitTimer: ReturnType<typeof setTimeout> | null = null;

    const flushEmit = (): void => {
      if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
      const current = this.sessions.get(sessionId);
      if (!current) return;
      this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
    };

    const scheduleEmit = (): void => {
      if (!emitTimer) emitTimer = setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS);
    };

    // Rebuild ContentBlock[] from finalized history + the in-progress streaming map.
    // Returning only the streaming blocks would drop every prior parent/subagent
    // message in this turn (the original disappearing-output bug).
    const rebuildStreamingBlocks = (): ContentBlock[] => {
      const sorted = [...streamingBlockByIndex.entries()].sort((a, b) => a[0] - b[0]);
      const streaming: ContentBlock[] = [];
      for (const [, sb] of sorted) {
        if (sb.type === "text") {
          streaming.push({ type: "text", text: sb.text });
        } else if (sb.type === "thinking") {
          streaming.push({ type: "thinking", thinking: sb.thinking });
        } else if (sb.type === "tool_use" && sb.id && sb.name) {
          let input: Record<string, unknown> = {};
          if (sb.finalized && sb.partialInput) {
            try { input = JSON.parse(sb.partialInput) as Record<string, unknown>; } catch { /* partial json */ }
          }
          streaming.push({ type: "tool_use", id: sb.id, name: sb.name, input });
        }
      }
      return [...finalizedBlocks, ...streaming];
    };

    const syncSnapshot = (): void => {
      const current = this.sessions.get(sessionId);
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
      permissionMode,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      claudeSessionId: session.claudeSessionId,
      spawnedAt,
    });

    try {
      for await (const msg of sdkQuery({ prompt, options: sdkOptions }) as AsyncIterable<SDKMessage>) {
        if (abortController.signal.aborted) break;

        // Incremental streaming events (opt-in via includePartialMessages: true)
        if (msg.type === "stream_event") {
          const ev = (msg as unknown as { type: "stream_event"; event: Record<string, unknown> }).event;
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
          const assistantMsg = msg as unknown as { type: "assistant"; message: Record<string, unknown>; session_id: string };
          const extracted = this.extractAssistantMessage(assistantMsg.message);
          finalizedBlocks.push(...extracted.content);
          streamingBlockByIndex.clear();
          turnState.blocks = rebuildStreamingBlocks();
          if (assistantMsg.session_id) turnState.sessionId = assistantMsg.session_id;
          syncSnapshot();
          scheduleEmit();

          // Non-managed mode: detect AskUserQuestion, abort to let user answer
          if (!isManaged && !killedForAskUserQuestion) {
            const askBlock = extracted.content.find(
              (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use" && b.name === "AskUserQuestion",
            );
            if (askBlock) {
              killedForAskUserQuestion = true;
              flushEmit();
              abortController.abort();
            }
          }
          continue;
        }

        // Tool results fed back from the claude subprocess (parent's view of a
        // tool call, or a subagent's tool_result during Task execution).
        if (msg.type === "user") {
          const userMsg = msg as unknown as { type: "user"; message: Record<string, unknown> };
          const content = Array.isArray(userMsg.message?.content) ? userMsg.message.content as unknown[] : [];
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b?.type === "tool_result") {
              finalizedBlocks.push({
                type: "tool_result",
                tool_use_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
                content: this.normalizeToolResultContent(b.content),
                is_error: b.is_error === true,
              });
            }
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
          turnState.model = this.extractModelName(resultMsg.modelUsage as Record<string, unknown> | undefined) ?? turnState.model;
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
        this.pendingSdkAbort.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        if (emitTimer) clearTimeout(emitTimer);
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-sdk-error",
          spawnedAt,
          closedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // Cleanup
    this.pendingSdkAbort.delete(sessionId);
    this.lastStreamSaveAt.delete(sessionId);
    if (emitTimer) clearTimeout(emitTimer);
    flushEmit();

    const current = this.sessions.get(sessionId);
    if (!current) throw new Error("Session removed during execution.");

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "claude-sdk-close",
      spawnedAt,
      closedAt: new Date().toISOString(),
      killedForAskUserQuestion,
      sessionId: turnState.sessionId,
    });

    const interruptedByUser = this.interruptedWith.has(sessionId);

    // Build final assistant turn
    const finalContent = this.compactContentBlocks([...turnState.blocks], turnState.result);
    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: finalContent,
      usage: turnState.usage,
    };
    const msgs = [...(current.messages ?? [])];
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = assistantTurn;
    else msgs.push(assistantTurn);

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
      queuedMessages: interruptPrompt ? [] : current.queuedMessages,
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
    this.storage.saveSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");

    if (killedForAskUserQuestion) return;

    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((err) => {
          console.error("[WAND] sdk interrupt-and-send failed:", err);
          const afterFail = this.sessions.get(sessionId);
          if (afterFail) {
            const recovered: SessionSnapshot = {
              ...afterFail,
              status: "idle",
              exitCode: 0,
              endedAt: new Date().toISOString(),
              structuredState: {
                ...(afterFail.structuredState as StructuredSessionState),
                inFlight: false,
                activeRequestId: null,
              },
            };
            this.sessions.set(sessionId, recovered);
            this.storage.saveSession(recovered);
            this.emitStructuredSnapshot(recovered);
          }
        });
      });
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

  private extractAssistantMessage(message: Record<string, unknown>): {
    content: ContentBlock[];
    usage?: ConversationTurn["usage"];
  } {
    const rawContent = Array.isArray(message.content) ? message.content : [];
    const content: ContentBlock[] = [];
    for (const block of rawContent) {
      if (!block || typeof block !== "object") continue;
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
        content.push({ type: "text", text: typedBlock.text });
        continue;
      }
      if (typedBlock.type === "thinking" && typeof typedBlock.thinking === "string") {
        content.push({ type: "thinking", thinking: typedBlock.thinking });
        continue;
      }
      if (typedBlock.type === "tool_use" && typeof typedBlock.id === "string" && typeof typedBlock.name === "string") {
        content.push({
          type: "tool_use",
          id: typedBlock.id,
          name: typedBlock.name,
          description: typeof typedBlock.description === "string" ? typedBlock.description : undefined,
          input: this.normalizeToolInput(typedBlock.input),
        });
      }
    }
    return {
      content,
      usage: this.extractUsage({ usage: message.usage }),
    };
  }

  private compactContentBlocks(blocks: ContentBlock[], fallbackResult: string): ContentBlock[] {
    const compacted: ContentBlock[] = [];
    for (const block of blocks) {
      const previous = compacted[compacted.length - 1];
      if (
        previous
        && previous.type === "text"
        && block.type === "text"
      ) {
        // 用新对象替换 compacted 末尾，**不要**就地改 previous.text —— previous
        // 通常和调用方持有的 turnState.blocks 共享引用，原地 mutate 会让下次
        // syncSnapshot 把已合并的内容再合并一次，呈指数级复制。
        compacted[compacted.length - 1] = { type: "text", text: `${previous.text}${block.text}` };
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

  private normalizeToolInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {};
    }
    return input as Record<string, unknown>;
  }

  private normalizeToolResultContent(content: unknown): string | Array<{ type: string; [key: string]: unknown }> {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.filter((item): item is { type: string; [key: string]: unknown } => !!item && typeof item === "object" && typeof (item as any).type === "string");
    }
    return typeof content === "undefined" || content === null ? "" : String(content);
  }

  private extractCodexText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) {
      return value.map((item) => this.extractCodexText(item)).filter(Boolean).join("");
    }

    const record = value as Record<string, unknown>;
    for (const key of ["text", "output_text", "message", "content", "summary"]) {
      const extracted = this.extractCodexText(record[key]);
      if (extracted) return extracted;
    }
    return "";
  }

  private extractCodexItemBlock(item: Record<string, unknown>, completed: boolean): ContentBlock | null {
    const id = typeof item.id === "string" ? item.id : randomUUID();
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "agent_message") {
      const text = this.extractCodexText(item);
      return text ? { type: "text", text } : null;
    }
    if (type === "reasoning") {
      const text = this.extractCodexText(item);
      return text ? { type: "thinking", thinking: text } : null;
    }
    if (type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "";
      const aggregatedOutput = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const status = typeof item.status === "string" ? item.status : completed ? "completed" : "in_progress";
      if (!completed) {
        return {
          type: "tool_use",
          id,
          name: "Bash",
          input: { command, status },
        };
      }
      return {
        type: "tool_result",
        tool_use_id: id,
        content: aggregatedOutput || (exitCode === null ? "" : `exit_code: ${exitCode}`),
        is_error: typeof exitCode === "number" && exitCode !== 0,
      };
    }
    if (completed) {
      const text = this.extractCodexText(item);
      if (text) return { type: "text", text };
    }
    return null;
  }

  private upsertCodexBlock(blocks: ContentBlock[], block: ContentBlock): void {
    if (block.type === "tool_result") {
      const toolUseIndex = blocks.findIndex((existing) => existing.type === "tool_use" && existing.id === block.tool_use_id);
      if (toolUseIndex >= 0) {
        const nextIndex = toolUseIndex + 1;
        if (blocks[nextIndex]?.type === "tool_result" && blocks[nextIndex].tool_use_id === block.tool_use_id) {
          blocks[nextIndex] = block;
        } else {
          blocks.splice(nextIndex, 0, block);
        }
        return;
      }
    }
    blocks.push(block);
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

  private extractModelName(modelUsage: Record<string, unknown> | undefined): string | undefined {
    if (!modelUsage) return undefined;
    const names = Object.keys(modelUsage);
    return names.length > 0 ? names[0] : undefined;
  }

  private extractUsage(source: Record<string, unknown> | undefined): ConversationTurn["usage"] {
    if (!source || !source.usage || typeof source.usage !== "object") {
      return undefined;
    }
    const usage = source.usage as Record<string, unknown>;
    const value = {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
      cacheReadInputTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
      cacheCreationInputTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
      totalCostUsd: typeof source.total_cost_usd === "number" ? source.total_cost_usd : undefined,
    };
    if (
      value.inputTokens === undefined
      && value.outputTokens === undefined
      && value.cacheReadInputTokens === undefined
      && value.cacheCreationInputTokens === undefined
      && value.totalCostUsd === undefined
    ) {
      return undefined;
    }
    return value;
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

  private extractCodexUsage(source: Record<string, unknown> | undefined): ConversationTurn["usage"] {
    if (!source || typeof source !== "object") return undefined;
    const value = {
      inputTokens: typeof source.input_tokens === "number" ? source.input_tokens : undefined,
      outputTokens: typeof source.output_tokens === "number" ? source.output_tokens : undefined,
      cacheReadInputTokens: typeof source.cached_input_tokens === "number" ? source.cached_input_tokens : undefined,
    };
    if (value.inputTokens === undefined && value.outputTokens === undefined && value.cacheReadInputTokens === undefined) {
      return undefined;
    }
    return value;
  }
}
