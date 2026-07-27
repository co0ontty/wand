import { mkdirSync, rmSync, appendFileSync, writeFileSync, readFileSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
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

// ── Constants ──

/** Max size for a single PTY log file before rotation (50 MB) */
const PTY_LOG_MAX_SIZE = 50 * 1024 * 1024;
/** Maximum number of rotated log files to keep */
const PTY_LOG_MAX_ROTATIONS = 3;
/** Default max size for shortcut interaction logs per session (10 MB) */
const DEFAULT_SHORTCUT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Delay used to coalesce hot-path append calls without adding noticeable log latency. */
const DEFAULT_FLUSH_INTERVAL_MS = 40;
/** Bound memory retained by one hot log file. */
const DEFAULT_PER_FILE_BUFFER_MAX_BYTES = 256 * 1024;
/** Bound memory retained across all sessions owned by one logger instance. */
const DEFAULT_TOTAL_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

interface PendingAppendBuffer {
  sessionId: string;
  chunks: string[];
  byteLength: number;
  sizeKind?: keyof SessionLogSizes;
}

interface SessionLogSizes {
  pty: number;
  shortcut: number;
}

/** Optional tuning and I/O injection used by focused logger tests. */
export interface SessionLoggerOptions {
  flushIntervalMs?: number;
  perFileBufferMaxBytes?: number;
  totalBufferMaxBytes?: number;
  ptyLogMaxBytes?: number;
  ptyLogMaxRotations?: number;
  appendFile?: (filePath: string, data: string) => void;
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
export class SessionLogger {
  private readonly baseDir: string;
  private readonly dirs = new Map<string, string>();
  /** Cached logical size (disk + pending buffer) so rotation does not stat every chunk. */
  private readonly logSizes = new Map<string, SessionLogSizes>();
  private readonly shortcutLogMaxBytes: number;
  private readonly flushIntervalMs: number;
  private readonly perFileBufferMaxBytes: number;
  private readonly totalBufferMaxBytes: number;
  private readonly ptyLogMaxBytes: number;
  private readonly ptyLogMaxRotations: number;
  private readonly appendFile: (filePath: string, data: string) => void;
  private readonly appendBuffers = new Map<string, PendingAppendBuffer>();
  private totalBufferedBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(configDir: string, shortcutLogMaxBytes?: number, options: SessionLoggerOptions = {}) {
    this.baseDir = path.join(configDir, "sessions");
    this.shortcutLogMaxBytes = shortcutLogMaxBytes ?? DEFAULT_SHORTCUT_LOG_MAX_BYTES;
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    this.perFileBufferMaxBytes = positiveInteger(options.perFileBufferMaxBytes, DEFAULT_PER_FILE_BUFFER_MAX_BYTES);
    this.totalBufferMaxBytes = positiveInteger(options.totalBufferMaxBytes, DEFAULT_TOTAL_BUFFER_MAX_BYTES);
    this.ptyLogMaxBytes = positiveInteger(options.ptyLogMaxBytes, PTY_LOG_MAX_SIZE);
    this.ptyLogMaxRotations = positiveInteger(options.ptyLogMaxRotations, PTY_LOG_MAX_ROTATIONS);
    this.appendFile = options.appendFile ?? ((filePath, data) => appendFileSync(filePath, data));
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch {
      process.stderr.write(`[wand] Warning: Could not create session log dir: ${this.baseDir}\n`);
    }
  }

  private ensureDir(sessionId: string): string {
    let dir = this.dirs.get(sessionId);
    if (dir) return dir;
    dir = path.join(this.baseDir, sessionId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
    this.dirs.set(sessionId, dir);
    // Seed the size cache from disk on first use; subsequent appends maintain
    // the counter in memory so the hot path no longer touches stat/exists.
    const sizes = { pty: tryStatSize(path.join(dir, "pty-output.log")), shortcut: tryStatSize(path.join(dir, "shortcut-interactions.jsonl")) };
    this.logSizes.set(sessionId, sizes);
    return dir;
  }

  /**
   * Rotate PTY log files if the current one exceeds the size limit.
   * pty-output.log.2 → pty-output.log.3 (deleted if at max)
   * pty-output.log.1 → pty-output.log.2
   * pty-output.log   → pty-output.log.1
   */
  private rotatePtyLog(dir: string): void {
    // Delete oldest if it exists (beyond max rotations)
    const oldest = path.join(dir, `pty-output.log.${this.ptyLogMaxRotations}`);
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }

    // Shift existing rotations up by one
    for (let i = this.ptyLogMaxRotations - 1; i >= 1; i--) {
      const src = path.join(dir, `pty-output.log.${i}`);
      const dst = path.join(dir, `pty-output.log.${i + 1}`);
      if (existsSync(src)) {
        renameSync(src, dst);
      }
    }

    // Rotate current to .1
    const current = path.join(dir, "pty-output.log");
    if (existsSync(current)) {
      renameSync(current, path.join(dir, "pty-output.log.1"));
    }
  }

  /** Append raw PTY output chunk */
  appendPtyOutput(sessionId: string, chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    try {
      const dir = this.ensureDir(sessionId);
      const sizes = this.logSizes.get(sessionId)!;
      const logPath = path.join(dir, "pty-output.log");
      if (sizes.pty >= this.ptyLogMaxBytes) {
        // Pending bytes must reach the current file before it is renamed.
        this.flushFile(logPath);
        this.rotatePtyLog(dir);
        sizes.pty = 0;
      }
      const chunkBytes = Buffer.byteLength(chunk);
      sizes.pty += chunkBytes;
      this.enqueueAppend(sessionId, logPath, chunk, chunkBytes, "pty");
    } catch {
      // Non-critical — don't let logging failures affect main flow
    }
  }

  /** Read the full PTY transcript including rotated logs, oldest first. */
  readPtyOutput(sessionId: string): string | null {
    try {
      this.flushSession(sessionId);
      const dir = this.ensureDir(sessionId);
      const parts: string[] = [];
      for (let index = this.ptyLogMaxRotations; index >= 1; index -= 1) {
        const rotatedPath = path.join(dir, `pty-output.log.${index}`);
        if (existsSync(rotatedPath)) {
          parts.push(readFileSync(rotatedPath, "utf8"));
        }
      }
      const currentPath = path.join(dir, "pty-output.log");
      if (existsSync(currentPath)) {
        parts.push(readFileSync(currentPath, "utf8"));
      }
      if (parts.length === 0) return null;
      return parts.join("");
    } catch {
      return null;
    }
  }

  /** Append a native mode NDJSON event */
  appendStreamEvent(sessionId: string, event: unknown): void {
    if (this.disposed) return;
    try {
      const dir = this.ensureDir(sessionId);
      this.enqueueAppend(sessionId, path.join(dir, "stream-events.jsonl"), JSON.stringify(event) + "\n");
    } catch {
      // Non-critical
    }
  }

  /** Append raw stdout chunk from a structured-mode child process. */
  appendStructuredStdout(sessionId: string, chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    try {
      const dir = this.ensureDir(sessionId);
      this.enqueueAppend(sessionId, path.join(dir, "structured-stdout.log"), chunk);
    } catch {
      // Non-critical
    }
  }

  /** Append raw stderr chunk from a structured-mode child process. */
  appendStructuredStderr(sessionId: string, chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    try {
      const dir = this.ensureDir(sessionId);
      this.enqueueAppend(sessionId, path.join(dir, "structured-stderr.log"), chunk);
    } catch {
      // Non-critical
    }
  }

  /** Append a spawn metadata record (args, pid, cwd, exit, errors, …) for a structured run. */
  appendStructuredSpawn(sessionId: string, meta: Record<string, unknown>): void {
    if (this.disposed) return;
    try {
      const dir = this.ensureDir(sessionId);
      const entry = JSON.stringify({ ts: new Date().toISOString(), ...meta }) + "\n";
      this.enqueueAppend(sessionId, path.join(dir, "structured-spawns.jsonl"), entry);
    } catch {
      // Non-critical
    }
  }

  /** Read recent stderr tail (for surfacing in failure messages). */
  readStructuredStderrTail(sessionId: string, maxBytes = 4096): string {
    try {
      this.flushSession(sessionId);
      const dir = this.ensureDir(sessionId);
      const filePath = path.join(dir, "structured-stderr.log");
      if (!existsSync(filePath)) return "";
      const content = readFileSync(filePath, "utf8");
      return content.length <= maxBytes ? content : content.slice(content.length - maxBytes);
    } catch {
      return "";
    }
  }

  /** Save the current structured messages snapshot */
  saveMessages(sessionId: string, messages: ConversationTurn[]): void {
    if (this.disposed) return;
    try {
      const dir = this.ensureDir(sessionId);
      writeFileSync(path.join(dir, "messages.json"), JSON.stringify(messages, null, 2) + "\n");
    } catch {
      // Non-critical
    }
  }

  /** Save session metadata */
  saveMetadata(sessionId: string, meta: Record<string, unknown>): void {
    if (this.disposed) return;
    try {
      const dir = this.ensureDir(sessionId);
      writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");
    } catch {
      // Non-critical
    }
  }

  /** Delete all log files for a session */
  deleteSession(sessionId: string): void {
    // Flush and remove every pending entry before deleting the directory so a
    // later timer cannot recreate files for a deleted session.
    this.flushSession(sessionId);
    const dir = path.join(this.baseDir, sessionId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical
    }
    this.dirs.delete(sessionId);
    this.logSizes.delete(sessionId);
  }

  /** Append a shortcut key interaction log entry (for analyzing auto-confirm gaps) */
  appendShortcutLog(sessionId: string, shortcutKey: string, tailLines: string, ctx?: ShortcutLogContext): void {
    if (this.disposed || this.shortcutLogMaxBytes <= 0) return;
    try {
      const dir = this.ensureDir(sessionId);
      const sizes = this.logSizes.get(sessionId)!;
      const logPath = path.join(dir, "shortcut-interactions.jsonl");
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        key: shortcutKey,
        mode: ctx?.mode,
        autoApprove: ctx?.autoApprove,
        permissionBlocked: ctx?.permissionBlocked,
        input: ctx?.input,
        tail: tailLines,
      }) + "\n";

      const entryBytes = Buffer.byteLength(entry);
      if (sizes.shortcut + entryBytes > this.shortcutLogMaxBytes) {
        this.flushFile(logPath);
        sizes.shortcut = this.truncateShortcutLog(logPath);
      }

      sizes.shortcut += entryBytes;
      this.enqueueAppend(sessionId, logPath, entry, entryBytes, "shortcut");
    } catch {
      // Non-critical
    }
  }

  /** Truncate shortcut log by keeping only the most recent half of entries. Returns the new on-disk size. */
  private truncateShortcutLog(logPath: string): number {
    try {
      const content = readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const keepFrom = Math.floor(lines.length / 2);
      const trimmed = lines.slice(keepFrom).join("\n") + "\n";
      writeFileSync(logPath, trimmed);
      return Buffer.byteLength(trimmed);
    } catch {
      try { unlinkSync(logPath); } catch { /* ignore */ }
      return 0;
    }
  }

  /** Synchronously persist all pending append logs owned by one session. */
  flushSession(sessionId: string): void {
    for (const [filePath, pending] of Array.from(this.appendBuffers.entries())) {
      if (pending.sessionId === sessionId) this.flushFile(filePath);
    }
    this.clearFlushTimerIfIdle();
  }

  /** Synchronously persist every pending append log owned by this logger. */
  flushAll(): void {
    this.clearFlushTimer();
    for (const filePath of Array.from(this.appendBuffers.keys())) {
      this.flushFile(filePath);
    }
  }

  /** Stop the coalescing timer and synchronously persist the final batch. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flushAll();
  }

  private enqueueAppend(
    sessionId: string,
    filePath: string,
    chunk: string,
    byteLength = Buffer.byteLength(chunk),
    sizeKind?: keyof SessionLogSizes,
  ): void {
    let pending = this.appendBuffers.get(filePath);
    if (!pending) {
      pending = { sessionId, chunks: [], byteLength: 0, sizeKind };
      this.appendBuffers.set(filePath, pending);
    }
    pending.chunks.push(chunk);
    pending.byteLength += byteLength;
    this.totalBufferedBytes += byteLength;

    if (pending.byteLength >= this.perFileBufferMaxBytes) {
      this.flushFile(filePath);
    }
    if (this.totalBufferedBytes >= this.totalBufferMaxBytes) {
      this.flushAll();
    } else if (this.totalBufferedBytes > 0) {
      this.scheduleFlush();
    }
  }

  private flushFile(filePath: string): void {
    const pending = this.appendBuffers.get(filePath);
    if (!pending) return;
    this.appendBuffers.delete(filePath);
    this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - pending.byteLength);
    try {
      this.appendFile(filePath, pending.chunks.join(""));
    } catch {
      // Match the previous best-effort behavior. Do not retain a failing batch
      // indefinitely, but remove its bytes from logical rotation accounting.
      if (pending.sizeKind) {
        const sizes = this.logSizes.get(pending.sessionId);
        if (sizes) sizes[pending.sizeKind] = Math.max(0, sizes[pending.sizeKind] - pending.byteLength);
      }
    }
    this.clearFlushTimerIfIdle();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushAll();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimerIfIdle(): void {
    if (this.totalBufferedBytes === 0) this.clearFlushTimer();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

function tryStatSize(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
