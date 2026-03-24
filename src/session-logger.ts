import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ConversationTurn } from "./types.js";

/**
 * SessionLogger saves raw session content to local files for debugging and analysis.
 *
 * Directory structure: .wand/sessions/{sessionId}/
 *   - pty-output.log     Raw PTY output (append-only)
 *   - stream-events.jsonl NDJSON events from native mode (append-only)
 *   - messages.json       Final structured messages (overwritten on each update)
 */
export class SessionLogger {
  private readonly baseDir: string;
  private readonly dirs = new Map<string, string>();

  constructor(configDir: string) {
    this.baseDir = path.join(configDir, "sessions");
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

  /** Append raw PTY output chunk */
  appendPtyOutput(sessionId: string, chunk: string): void {
    try {
      const dir = this.ensureDir(sessionId);
      appendFileSync(path.join(dir, "pty-output.log"), chunk);
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
}
