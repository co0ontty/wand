import { EventEmitter } from "node:events";
import { WandStorage } from "./storage.js";
import { ExecutionMode, ProcessEventHandler, SessionProvider, SessionSnapshot, WandConfig } from "./types.js";
export type { ProcessEvent, ProcessEventHandler } from "./types.js";
/** Human-readable task information for the UI */
export interface TaskInfo {
    title: string;
    tool?: string;
}
export declare class SessionInputError extends Error {
    readonly code: "SESSION_NOT_FOUND" | "SESSION_NOT_RUNNING" | "SESSION_NO_PTY";
    readonly sessionId: string;
    readonly sessionStatus?: SessionSnapshot["status"] | undefined;
    constructor(message: string, code: "SESSION_NOT_FOUND" | "SESSION_NOT_RUNNING" | "SESSION_NO_PTY", sessionId: string, sessionStatus?: SessionSnapshot["status"] | undefined);
}
/** A Claude Code session discovered by scanning ~/.claude/projects/ directories. */
export interface ClaudeHistorySession {
    claudeSessionId: string;
    projectDir: string;
    cwd: string;
    firstUserMessage: string;
    timestamp: string;
    mtimeMs: number;
    hasConversation: boolean;
    managedByWand: boolean;
}
/** A Codex session discovered by scanning ~/.codex/sessions/ rollout files. */
export interface CodexHistorySession {
    /** Codex thread id（存进 claudeSessionId 字段以复用前端/路由）。 */
    claudeSessionId: string;
    cwd: string;
    firstUserMessage: string;
    timestamp: string;
    mtimeMs: number;
    hasConversation: boolean;
    managedByWand: boolean;
    provider: "codex";
}
export declare class ProcessManager extends EventEmitter {
    private readonly config;
    private readonly storage;
    private readonly sessions;
    private readonly logger;
    /** 24h archive scan timer */
    private archiveTimer;
    /** Per-session debounce timers for throttled persist calls */
    private readonly persistDebounceTimers;
    /** Last persisted message state per session — used to skip redundant message writes */
    private readonly lastPersistedMessageState;
    /** 启动时被识别为孤儿 PTY 并标记为 exited 的旧会话数（旧服务器进程已死） */
    private orphanRecoveredCount;
    constructor(config: WandConfig, storage: WandStorage, configDir?: string);
    on(event: "process", listener: ProcessEventHandler): this;
    /** 启动时被识别为孤儿 PTY 并标记为 exited 的旧会话数量（仅用于启动摘要展示）。 */
    getOrphanRecoveredCount(): number;
    private emitEvent;
    private cleanupOldSessions;
    start(command: string, cwd: string | undefined, mode: ExecutionMode, initialInput?: string, opts?: {
        resumedFromSessionId?: string;
        autoRecovered?: boolean;
        worktreeEnabled?: boolean;
        provider?: SessionProvider;
        model?: string;
        reuseId?: string;
        cols?: number;
        rows?: number;
        thinkingEffort?: SessionSnapshot["thinkingEffort"];
    }): SessionSnapshot;
    list(): SessionSnapshot[];
    /** Return lightweight snapshots for the session list (no output/messages). */
    listSlim(): SessionSnapshot[];
    hasClaudeSessionFile(cwd: string, claudeSessionId: string): boolean;
    private claudeHistoryCache;
    private static readonly HISTORY_CACHE_TTL_MS;
    listClaudeHistorySessions(): ClaudeHistorySession[];
    deleteClaudeHistoryFiles(sessions: {
        claudeSessionId: string;
        cwd: string;
    }[]): number;
    private codexHistoryCache;
    listCodexHistorySessions(): CodexHistorySession[];
    hasCodexSessionFile(threadId: string): boolean;
    deleteCodexHistoryFiles(threadIds: string[]): number;
    private captureCodexSessionId;
    get(id: string): SessionSnapshot | null;
    getPtyTranscript(id: string): string | null;
    /**
     * Set the Claude model for an existing PTY session. Persists the selection
     * and, when the session is live, pipes a `/model <id>` slash command into
     * the PTY so Claude Code switches on the fly.
     */
    setSessionModel(id: string, model: string | null): SessionSnapshot;
    /**
     * Set the thinking-effort level for a PTY session. For interactive Claude PTY
     * we don't intercept raw key input; the effort is applied only when wand UI
     * sends a chat-view message (see sendInput → applyThinkingEffortToPrompt).
     */
    setSessionThinkingEffort(id: string, effort: SessionSnapshot["thinkingEffort"]): SessionSnapshot;
    sendInput(id: string, input: string, view?: "chat" | "terminal", shortcutKey?: string): SessionSnapshot;
    /** Emit a task event for a session, debounced to avoid flooding */
    private emitTask;
    resize(id: string, cols: number, rows: number): SessionSnapshot;
    stop(id: string): SessionSnapshot;
    private cleanupRecord;
    delete(id: string): void;
    private deleteClaudeCache;
    runStartupCommands(): SessionSnapshot[];
    private snapshot;
    /** Lightweight snapshot for list views — omits output and messages. */
    private snapshotSlim;
    private isPermissionBlocked;
    private defaultAutonomyPolicy;
    resolveEscalation(id: string, requestId: string, resolution?: "approve_once" | "approve_turn" | "deny"): SessionSnapshot;
    approvePermission(id: string): SessionSnapshot;
    denyPermission(id: string): SessionSnapshot;
    toggleAutoApprove(id: string): SessionSnapshot;
    /**
     * Canonical permission resolution method.
     * All other permission methods delegate to this.
     * @param resolution - "approve_once", "approve_turn", or "deny"
     * @param requestId - Optional escalation request ID for validation
     */
    resolvePermission(id: string, resolution: "approve_once" | "approve_turn" | "deny", requestId?: string): SessionSnapshot;
    private persist;
    /**
     * Schedule a debounced persist call for the given record.
     * Multiple calls within the debounce window are coalesced into a single write.
     * Use this in hot paths (e.g. onData) to reduce I/O pressure.
     */
    private schedulePersist;
    /**
     * Immediately persist any pending debounced write and clear the timer.
     * Use this at critical points (exit, stop, delete) to ensure no data loss.
     */
    private flushPersist;
    private archiveExpiredSessions;
    private assertCommandAllowed;
    /**
     * @deprecated Only retained for non-Claude-CLI sessions without ptyBridge.
     * For Claude CLI sessions, auto-approval is handled by ClaudePtyBridge.detectPermission().
     */
    private autoConfirmWithRecord;
    /**
     * Handle events from ClaudePtyBridge
     */
    private handleBridgeEvent;
    private mustGet;
    private buildShellArgs;
    private shouldAutoApprovePermissions;
    private processCommandForMode;
}
