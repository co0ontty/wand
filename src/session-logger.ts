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

/**
 * SessionLogger saves raw session content to local files for debugging and analysis.
 *
 * Directory structure: .wand/sessions/{sessionId}/
 *   - pty-output.log       Raw PTY output (current, rotated when > 50 MB)
 *   - pty-output.log.1..3  Rotated PTY output backups
 *   - stream-events.jsonl  NDJSON events from native mode (append-only)
 *   - messages.json        Final structured messages (overwritten on each update)
 */
export class SessionLogger {
  private readonly baseDir: string;
  private readonly dirs = new Map<string, string>();
  private readonly shortcutLogMaxBytes: number;

  constructor(configDir: string, shortcutLogMaxBytes?: number) {
    this.baseDir = path.join(configDir, "sessions");
    this.shortcutLogMaxBytes = shortcutLogMaxBytes ?? DEFAULT_SHORTCUT_LOG_MAX_BYTES;
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
    const oldest = path.join(dir, `pty-output.log.${PTY_LOG_MAX_ROTATIONS}`);
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }

    // Shift existing rotations up by one
    for (let i = PTY_LOG_MAX_ROTATIONS - 1; i >= 1; i--) {
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
    try {
      const dir = this.ensureDir(sessionId);
      const logPath = path.join(dir, "pty-output.log");

      // Check size and rotate if needed
      if (existsSync(logPath)) {
        const stats = statSync(logPath);
        if (stats.size >= PTY_LOG_MAX_SIZE) {
          this.rotatePtyLog(dir);
        }
      }

      appendFileSync(logPath, chunk);
    } catch {
      // Non-critical — don't let logging failures affect main flow
    }
  }

  /** Append a native mode NDJSON event */
  appendStreamEvent(sessionId: string, event: unknown): void {
    try {
      const dir = this.ensureDir(sessionId);
      appendFileSync(path.join(dir, "stream-events.jsonl"), JSON.stringify(event) + "\n");
    } catch {
      // Non-critical
    }
  }

  /** Save the current structured messages snapshot */
  saveMessages(sessionId: string, messages: ConversationTurn[]): void {
    try {
      const dir = this.ensureDir(sessionId);
      writeFileSync(path.join(dir, "messages.json"), JSON.stringify(messages, null, 2) + "\n");
    } catch {
      // Non-critical
    }
  }

  /** Save session metadata */
  saveMetadata(sessionId: string, meta: Record<string, unknown>): void {
    try {
      const dir = this.ensureDir(sessionId);
      writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");
    } catch {
      // Non-critical
    }
  }

  /** Delete all log files for a session */
  deleteSession(sessionId: string): void {
    const dir = path.join(this.baseDir, sessionId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical
    }
    this.dirs.delete(sessionId);
  }

  /** Append a shortcut key interaction log entry (for analyzing auto-confirm gaps) */
  appendShortcutLog(sessionId: string, shortcutKey: string, tailLines: string, ctx?: ShortcutLogContext): void {
    if (this.shortcutLogMaxBytes <= 0) return;
    try {
      const dir = this.ensureDir(sessionId);
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

      // Check size and truncate if needed
      if (existsSync(logPath)) {
        const size = statSync(logPath).size;
        if (size + entry.length > this.shortcutLogMaxBytes) {
          this.truncateShortcutLog(logPath);
        }
      }

      appendFileSync(logPath, entry);
    } catch {
      // Non-critical
    }
  }

  /** Truncate shortcut log by keeping only the most recent half of entries */
  private truncateShortcutLog(logPath: string): void {
    try {
      const content = readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      // Keep the latter half
      const keepFrom = Math.floor(lines.length / 2);
      const trimmed = lines.slice(keepFrom).join("\n") + "\n";
      writeFileSync(logPath, trimmed);
    } catch {
      // If truncation fails, delete the file to prevent unbounded growth
      try { unlinkSync(logPath); } catch { /* ignore */ }
    }
  }
}
