import { SessionLogger } from "./session-logger.js";
import { WandStorage } from "./storage.js";
import { ExecutionMode, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, WandConfig } from "./types.js";
interface CreateStructuredSessionOptions {
    cwd: string;
    mode: ExecutionMode;
    prompt?: string;
    provider?: SessionProvider;
    runner?: SessionRunner;
    worktreeEnabled?: boolean;
    /** 用户指定的 Claude 模型（别名或完整 ID）。留空则 spawn 时不加 --model。 */
    model?: string;
    /** 用户预设的思考深度。留空 / null 视为 off。 */
    thinkingEffort?: SessionSnapshot["thinkingEffort"];
    /**
     * 恢复用的初始会话 id：
     *   - Codex：历史 thread id，首条消息即 `codex exec ... resume <id>` 续接。
     *   - Claude：历史 session id，首条消息即 `--resume` / SDK resume 续接。
     * 留空表示新建会话。
     */
    claudeSessionId?: string;
}
/**
 * 把任意外部输入收敛到合法的 thinkingEffort 枚举值。`null` / 非法值都视为
 * "未设置"——上层调用方再根据 provider 决定是否填默认值。
 */
export declare function normalizeThinkingEffort(value: unknown): SessionSnapshot["thinkingEffort"];
/** Claude SDK 用：把 thinkingEffort 映射成 `thinking.budget_tokens`。off / 空 → 0（不启用）。 */
export declare function thinkingEffortToSdkBudget(effort: SessionSnapshot["thinkingEffort"]): number;
/**
 * Claude CLI 用：在 prompt 前注入魔法词，让 claude code 自动识别为思考请求。
 * off → 原 prompt 不变。
 */
export declare function applyThinkingEffortToPrompt(prompt: string, effort: SessionSnapshot["thinkingEffort"]): string;
/** Codex CLI 用：把 thinkingEffort 映射到 model_reasoning_effort 配置。off → minimal。 */
export declare function thinkingEffortToCodexReasoningEffort(effort: SessionSnapshot["thinkingEffort"]): string | null;
export declare class StructuredSessionManager {
    private readonly storage;
    private readonly config;
    private readonly logger;
    private readonly sessions;
    private readonly pendingChildren;
    private readonly pendingSdkAbort;
    /**
     * Active SDK Query handle per session, kept around so we can call
     * `query.interrupt()` for a graceful stop instead of aborting via signal.
     * Only populated while an SDK call is in flight.
     */
    private readonly pendingSdkQueries;
    private readonly interruptedWith;
    /**
     * Sessions where the current interrupt is a "queue promote" (用户从排队条点了「立即」
     * 把队首插队到 now)。退出处理三个分支默认会把 queuedMessages 清空——因为常规的
     * interrupt 语义是"算了，做这个"，把队列也作废。但 queue-promote 的语义是
     * "先做这条，剩下的队列还要继续"，所以这里打个标记，让退出 handler 保留 queue。
     * 收到后必须 delete 掉，避免下一次普通 interrupt 误带 flag。
     */
    private readonly preserveQueueOnInterrupt;
    /** Last wall-clock time (ms) we did a full saveSession for a streaming session. */
    private readonly lastStreamSaveAt;
    /**
     * Idempotency keys we've already accepted, mapped to their wall-clock timestamp.
     * Android WebView 在进程恢复时偶尔会重发上一个未收到响应的 POST（HTTP/2 stream
     * reset 等场景），客户端 JS 没有重试逻辑也拦不住。这里用 (sessionId, key) 永
     * 久去重，重复就抛错让前端弹 toast 提示，**不**做任何处理。timestamp 仅用于
     * map 大小溢出时按时间裁剪。
     */
    private readonly seenIdempotencyKeys;
    private emitEvent;
    private archiveTimer;
    constructor(storage: WandStorage, config: WandConfig, logger?: SessionLogger | null);
    private archiveExpiredSessions;
    setEventEmitter(emitEvent: (event: ProcessEvent) => void): void;
    /**
     * In-memory snapshot is updated unconditionally; the SQLite write is rate-
     * limited to once per STREAM_SAVE_THROTTLE_MS. Caller must still invoke
     * `storage.saveSession` directly at terminal events (close / failure) so the
     * final state is durable.
     */
    private saveStreamingSnapshot;
    list(): SessionSnapshot[];
    /** Return lightweight snapshots for the session list (no output/messages). */
    listSlim(): SessionSnapshot[];
    get(id: string): SessionSnapshot | null;
    createSession(options: CreateStructuredSessionOptions): SessionSnapshot;
    sendMessage(id: string, input: string, opts?: {
        interrupt?: boolean;
        idempotencyKey?: string;
        preserveQueue?: boolean;
    }): Promise<SessionSnapshot>;
    /**
     * Reorder the pending queued messages. `order` is a permutation of the current
     * indices, e.g. `[2, 0, 1]` means "move the third queued message to the front,
     * push the original first to position #2". Throws if the permutation is
     * malformed (length mismatch / duplicate / out-of-range). 不允许在 inFlight
     * 期间改"已经被 flushNextQueuedMessage 拿走的队首"，但本方法只动 queue 数组
     * 本身，flushNext 在另一段时序里读 sessions.get(...) 当前快照，已经天然安全。
     */
    reorderQueuedMessages(sessionId: string, order: number[]): SessionSnapshot;
    /** Remove a single queued message by index. */
    deleteQueuedMessage(sessionId: string, index: number): SessionSnapshot;
    /** Clear all queued messages. No-op when queue is already empty. */
    clearQueuedMessages(sessionId: string): SessionSnapshot;
    /** Update the selected model for a structured session. Takes effect on the next spawn. */
    setSessionModel(sessionId: string, model: string | null): SessionSnapshot;
    /**
     * Update the thinking-effort level for a structured session. Takes effect on
     * the next spawn / next message (SDK runner injects `thinking`, CLI runner
     * prepends magic words, codex runner overrides `model_reasoning_effort`).
     */
    setSessionThinkingEffort(sessionId: string, effort: SessionSnapshot["thinkingEffort"]): SessionSnapshot;
    /** Toggle auto-approve for the session. */
    toggleAutoApprove(sessionId: string): SessionSnapshot;
    /** Resolve a specific escalation by requestId. */
    resolveEscalation(sessionId: string, requestId: string, resolution?: "approve_once" | "approve_turn" | "deny"): SessionSnapshot;
    stop(id: string): SessionSnapshot;
    delete(id: string): void;
    private requireSession;
    private buildQueuedPlaceholderTurns;
    private buildRenderableMessages;
    private emitStructuredSnapshot;
    private flushNextQueuedMessage;
    private emit;
    private incrementApprovalStats;
    private buildCodexArgs;
    private runCodexStreaming;
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
    private runClaudeStreaming;
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
    private runClaudeSdkStreaming;
    private extractAssistantMessage;
    private compactContentBlocks;
    private normalizeToolInput;
    private normalizeToolResultContent;
    private extractCodexText;
    /**
     * Merge one codex `item.*` event into `turnState.blocks`.
     *
     * 三种 phase 行为：
     *   - "started":   首次出现的 item，块直接 push（tool_result 走 upsert 配对）。
     *                  text/thinking/TodoWrite 这种"靠 id 替换"的块记录到
     *                  codexBlockIndex 里，方便后续 updated/completed 找回原位。
     *   - "updated":   codex 重发完整 ThreadItem（不是 delta）。已记录过的块就
     *                  替换；新块按 started 路径处理。
     *   - "completed": 把"in_progress"卡片定型——text 同时更新 turnState.result
     *                  以便 result fallback 不为空；tool_use ↔ tool_result 通过
     *                  共享 id 配对到一起（包括 file_change 子项的 `${id}#i`）。
     */
    private applyCodexItem;
    /**
     * Map a codex `item.{started,updated,completed}` payload into wand's
     * `ContentBlock[]` so the chat UI's existing tool/diff/todo cards just work.
     *
     * Codex `exec --json` emits 8 item.type values (see
     * `codex-rs/exec/src/exec_events.rs`); below they're routed to whatever wand
     * tool name reuses an existing renderer:
     *
     *   agent_message     → text
     *   reasoning         → thinking
     *   command_execution → tool_use "Bash" + tool_result
     *   file_change       → one tool_use per file, named Edit/Write/Bash by `kind`
     *                       (codex does NOT carry old_string/new_string in the
     *                       exec stream, only the path list; diff card body is
     *                       empty but the file row + status still render)
     *   mcp_tool_call     → tool_use named "<server>__<tool>" + tool_result
     *   web_search        → tool_use "WebSearch" + tool_result (results not in stream)
     *   todo_list         → tool_use "TodoWrite" (replaced in place on each update)
     *   error             → text block prefixed with ❌
     *
     * Returns [] when there is nothing to emit yet (e.g. agent_message at
     * `item.started` before any text has been produced).
     *
     * Callers handle in-place replacement for `item.updated` via
     * `turnState.codexBlockIndex`; tool_use ↔ tool_result pairing still goes
     * through `upsertCodexBlock` by matching ids.
     */
    private extractCodexItemBlock;
    private upsertCodexBlock;
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
    private formatStructuredExitError;
    private finishStructuredFailure;
    private extractModelName;
    private extractUsage;
    /** Extract usage from an SDKResultSuccess message (sdk runner). */
    private extractSdkUsage;
    private extractCodexUsage;
}
export {};
