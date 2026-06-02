import type { ConversationTurn, ExecutionMode } from "./types.js";
/** Context passed alongside a shortcut key interaction for richer logging */
export interface ShortcutLogContext {
    /** Execution mode the session is running in (e.g. "managed", "full-access") */
    mode: ExecutionMode;
    /** Permission scope that was approved (e.g. "run_command", "write_file") */
    scope?: string;
    /** Whether auto-approve is active for this session */
    autoApprove: boolean;
    /** Whether a permission prompt was blocking at the time of the keypress */
    permissionBlocked: boolean;
    /** The actual input string sent to PTY */
    input: string;
    /** Auto-approve detection type: "strict" | "fallback" | "idle_probe" */
    approveType?: string;
    /** Fallback detection score */
    score?: number;
    /** Fallback detection matched keywords */
    matched?: string[];
    /** Whether the auto-approve was a false positive */
    falsePositive?: boolean;
}
/**
 * SessionLogger saves raw session content to local files for debugging and analysis.
 *
 * Directory structure: .wand/sessions/{sessionId}/
 *   - pty-output.log              Raw PTY output (current, rotated when > 50 MB)
 *   - pty-output.log.1..3         Rotated PTY output backups
 *   - stream-events.jsonl         NDJSON events from native mode (append-only)
 *   - messages.json               Final structured messages (overwritten on each update)
 *   - structured-stdout.log       Raw stdout from `codex exec` / `claude -p` child (append-only)
 *   - structured-stderr.log       Raw stderr from the same child (append-only)
 *   - structured-spawns.jsonl     One line per spawn: args/pid/cwd/exit/error metadata
 */
export declare class SessionLogger {
    private readonly baseDir;
    private readonly dirs;
    /** Cached on-disk size of hot-path log files so we can rotate without stat'ing on every chunk. */
    private readonly logSizes;
    private readonly shortcutLogMaxBytes;
    constructor(configDir: string, shortcutLogMaxBytes?: number);
    private ensureDir;
    /**
     * Rotate PTY log files if the current one exceeds the size limit.
     * pty-output.log.2 → pty-output.log.3 (deleted if at max)
     * pty-output.log.1 → pty-output.log.2
     * pty-output.log   → pty-output.log.1
     */
    private rotatePtyLog;
    /** Append raw PTY output chunk */
    appendPtyOutput(sessionId: string, chunk: string): void;
    /** Read the full PTY transcript including rotated logs, oldest first. */
    readPtyOutput(sessionId: string): string | null;
    /** Append a native mode NDJSON event */
    appendStreamEvent(sessionId: string, event: unknown): void;
    /** Append raw stdout chunk from a structured-mode child process. */
    appendStructuredStdout(sessionId: string, chunk: string): void;
    /** Append raw stderr chunk from a structured-mode child process. */
    appendStructuredStderr(sessionId: string, chunk: string): void;
    /** Append a spawn metadata record (args, pid, cwd, exit, errors, …) for a structured run. */
    appendStructuredSpawn(sessionId: string, meta: Record<string, unknown>): void;
    /** Read recent stderr tail (for surfacing in failure messages). */
    readStructuredStderrTail(sessionId: string, maxBytes?: number): string;
    /** Save the current structured messages snapshot */
    saveMessages(sessionId: string, messages: ConversationTurn[]): void;
    /** Save session metadata */
    saveMetadata(sessionId: string, meta: Record<string, unknown>): void;
    /** Delete all log files for a session */
    deleteSession(sessionId: string): void;
    /** Append a shortcut key interaction log entry (for analyzing auto-confirm gaps) */
    appendShortcutLog(sessionId: string, shortcutKey: string, tailLines: string, ctx?: ShortcutLogContext): void;
    /** Truncate shortcut log by keeping only the most recent half of entries. Returns the new on-disk size. */
    private truncateShortcutLog;
}
