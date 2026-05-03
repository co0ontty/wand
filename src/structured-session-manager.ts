import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";

import { prepareSessionWorktree } from "./git-worktree.js";

import { SessionLogger } from "./session-logger.js";
import { WandStorage } from "./storage.js";
import {
  ContentBlock, ConversationTurn, EscalationRequest, EscalationScope,
  ExecutionMode, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, StructuredSessionState,
  WandConfig,
} from "./types.js";

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

function buildIncrementalStructuredPayload(snapshot: SessionSnapshot): ProcessEvent["data"] {
  const messages = snapshot.messages ?? [];
  return {
    incremental: true,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    lastMessage: messages.length > 0 ? messages[messages.length - 1] : undefined,
    messageCount: messages.length,
  };
}

export class StructuredSessionManager {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly pendingChildren = new Map<string, ChildProcess>();
  private readonly interruptedWith = new Map<string, string>();
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

  async sendMessage(id: string, input: string, opts?: { interrupt?: boolean }): Promise<SessionSnapshot> {
    let session = this.requireSession(id);
    const prompt = input.trim();
    if (!prompt) return session;
    console.log("[WAND] StructuredSessionManager.sendMessage id:", id, "inFlight:", session.structuredState?.inFlight, "hasPendingChild:", this.pendingChildren.has(id), "status:", session.status);
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
    this.sessions.delete(id);
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
      console.log("[WAND] runCodexStreaming sessionId:", sessionId, "mode:", session.mode, "threadId:", session.claudeSessionId);
      const spawnedAt = new Date().toISOString();
      const child = spawn("codex", args, {
        cwd: session.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log("[WAND] spawned codex exec pid:", child.pid, "args:", args.join(" "));
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
        this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current) });
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
        this.storage.saveSession(patched);
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
          if (message) {
            console.log("[WAND] codex error event:", message.slice(0, 300));
            codexErrors.push(message);
          }
          return;
        }
        if (parsed?.type === "turn.failed") {
          const errObj = (parsed.error && typeof parsed.error === "object") ? parsed.error as Record<string, unknown> : null;
          const message = (errObj && typeof errObj.message === "string" && errObj.message)
            || (typeof parsed.message === "string" ? parsed.message : "")
            || "codex turn failed";
          console.log("[WAND] codex turn.failed:", message.slice(0, 300));
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
        console.log("[WAND] codex exec child error:", error.message);
        this.pendingChildren.delete(sessionId);
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
        console.log("[WAND] codex exec child close code:", code, "stderr:", stderr.substring(0, 200), "errors:", codexErrors.length, "turnFailed:", codexTurnFailed?.slice(0, 100));
        this.pendingChildren.delete(sessionId);
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
        // codex 把模型/网络/沙箱等错误写到 stdout 的 NDJSON 流（type: error / turn.failed），
        // 而不是 stderr。我们以 turn.failed 的 message 为准，其次是最后一个 error 事件。
        const codexFailed = codexTurnFailed !== null;
        if (codexFailed || (code !== 0 && code !== null)) {
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
        const finished: SessionSnapshot = {
          ...current,
          status: "idle",
          exitCode: 0,
          endedAt: new Date().toISOString(),
          output: turnState.result,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages: msgs,
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
        this.emitStructuredSnapshot(finished, "ended");
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
      console.log("[WAND] runClaudeStreaming sessionId:", sessionId, "mode:", session.mode, "claudeSessionId:", session.claudeSessionId);

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
      console.log("[WAND] spawned claude -p pid:", child.pid, "args:", args.join(" "));
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
          data: buildIncrementalStructuredPayload(current),
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
        // latest assistant turn to the pre-stream snapshot.
        this.storage.saveSession(patched);
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
          if (extracted.content.length > 0) {
            turnState.blocks.push(...extracted.content);
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
          for (const block of parsed.message.content) {
            if (block && block.type === "tool_result") {
              turnState.blocks.push({
                type: "tool_result",
                tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
                content: this.normalizeToolResultContent(block.content),
                is_error: block.is_error === true,
              });
            }
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
        console.log("[WAND] claude -p child error:", error.message);
        this.pendingChildren.delete(sessionId);
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
        console.log("[WAND] claude -p child close code:", code, "stderr:", stderr.substring(0, 200));
        this.pendingChildren.delete(sessionId);
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

        if (code !== 0 && code !== null) {
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
          console.log("[WAND] interrupt-and-send for session:", sessionId, "prompt:", interruptPrompt.substring(0, 50));
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((err) => {
              console.error("[WAND] interrupt-and-send failed:", err);
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
          console.log("[WAND] ExitPlanMode detected – auto-continuing plan execution for session:", sessionId);
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
        previous.text = `${previous.text}${block.text}`;
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
