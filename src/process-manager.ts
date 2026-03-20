import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import pty, { IPty } from "node-pty";
import { WandStorage } from "./storage.js";
import { ExecutionMode, SessionSnapshot, WandConfig } from "./types.js";

export interface ProcessEvent {
  type: "output" | "status" | "started" | "ended";
  sessionId: string;
  data?: unknown;
}

export type ProcessEventHandler = (event: ProcessEvent) => void;

const PROMPT_PATTERNS = [
  /(?:^|\b)(?:press\s+)?(?:y|yes)\s*(?:\/|\bor\b)\s*(?:n|no)(?:\b|$)/i,
  /\[(?:y|yes)\s*\/\s*(?:n|no)\]/i,
  /\((?:y|yes)\s*\/\s*(?:n|no)\)/i,
  /\((?:y|yes)\s*\/\s*(?:n|no)\s*\/\s*always\)/i,
  /\bcontinue\?\s*(?:\((?:y|yes)\s*\/\s*(?:n|no)\))?/i,
  /\bare you sure\??/i,
  /\bdo you want to continue\??/i,
  /\bdo you want to (?:create|write|delete|modify|execute)/i,
  /\bconfirm(?:\s+execution|\s+changes|\s+action)?\??/i,
  /\bproceed\??/i,
  /\benter to confirm\b/i,
  /\bwould you like to\b/i,
  /\bshall i\b/i,
  /\bcan i\b/i,
  /\bpermission\b/i,
  /\bgrant\b.*\bpermission\b/i
];

// Patterns that indicate a selection-based prompt (needs Enter, not 'y')
const SELECTION_PROMPT_PATTERNS = [
  /\bwould you like to\b/i,
  /\bgrant.*permission\b/i,
  /\bpermission\b/i,
  /\btrust.*folder\b/i,
  /\bconfirm\b/i
];

interface SessionRecord extends SessionSnapshot {
  processId: number | null;
  ptyProcess: IPty | null;
  stopRequested: boolean;
  confirmWindow: string;
  lastAutoConfirmAt: number;
  /** 用于解析会话 ID 的输出窗口 */
  sessionIdWindow: string;
}

const MAX_SESSIONS = 50;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;
const OUTPUT_WINDOW_SIZE = 4096;
const CONFIRM_WINDOW_SIZE = 800;
const OUTPUT_MAX_SIZE = 120000;

// Claude 会话 ID 格式：UUID v4
const CLAUDE_SESSION_ID_PATTERN = /"session_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/** Append text to a windowed buffer, trimming from start if over max size. */
function appendWindow(buffer: string, chunk: string, maxSize: number): string {
  const next = buffer + chunk;
  return next.length > maxSize ? next.slice(-maxSize) : next;
}

export class ProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage
  ) {
    super();
    for (const snapshot of this.storage.loadSessions()) {
      this.sessions.set(snapshot.id, {
        ...snapshot,
        processId: null,
        ptyProcess: null,
        stopRequested: false,
        confirmWindow: "",
        lastAutoConfirmAt: 0,
        sessionIdWindow: ""
      });
    }
    this.archiveExpiredSessions();
  }

  on(event: "process", listener: ProcessEventHandler): this {
    return super.on("process", listener);
  }

  private emitEvent(event: ProcessEvent): void {
    this.emit("process", event);
  }

  private cleanupOldSessions(): void {
    // Remove oldest finished sessions if we're at the limit
    if (this.sessions.size < MAX_SESSIONS) return;

    const finishedIds: string[] = [];
    for (const [id, record] of this.sessions) {
      if (record.status !== "running") {
        finishedIds.push(id);
      }
    }

    // Remove oldest finished sessions first
    finishedIds
      .sort((a, b) => {
        const ra = this.sessions.get(a);
        const rb = this.sessions.get(b);
        return (ra?.endedAt || "").localeCompare(rb?.endedAt || "");
      })
      .slice(0, this.sessions.size - MAX_SESSIONS + 1)
      .forEach((id) => {
        this.sessions.delete(id);
        this.storage.deleteSession(id);
      });
  }

  start(command: string, cwd: string | undefined, mode: ExecutionMode): SessionSnapshot {
    this.assertCommandAllowed(command);

    const resolvedCwd = cwd
      ? path.resolve(process.cwd(), cwd)
      : path.resolve(process.cwd(), this.config.defaultCwd);

    // For full-access mode with claude, add permission flags
    const processedCommand = this.processCommandForMode(command, mode);

    const id = randomUUID();
    const record: SessionRecord = {
      id,
      command,
      cwd: resolvedCwd,
      mode,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      claudeSessionId: null,
      processId: null,
      ptyProcess: null,
      stopRequested: false,
      confirmWindow: "",
      lastAutoConfirmAt: 0,
      sessionIdWindow: ""
    };

    const shellArgs = this.buildShellArgs(processedCommand);
    const child = pty.spawn(this.config.shell, shellArgs, {
      cwd: resolvedCwd,
      env: {
        ...process.env,
        WAND_MODE: mode,
        WAND_AUTO_CONFIRM: mode === "full-access" ? "1" : "0",
        WAND_AUTO_EDIT: mode === "auto-edit" ? "1" : "0"
      },
      name: "xterm-color",
      cols: 120,
      rows: 36
    });

    record.processId = child.pid;
    record.ptyProcess = child;
    this.sessions.set(id, record);
    this.persist(record);
    this.cleanupOldSessions();

    // Emit started event
    this.emitEvent({ type: "started", sessionId: id, data: this.snapshot(record) });

    child.onData((chunk: string) => {
      const record = this.sessions.get(id);
      if (!record) return;

      // Update output buffer
      record.output = appendWindow(record.output, normalizePtyOutput(chunk), OUTPUT_MAX_SIZE);
      this.persist(record);

      // Emit output event for WebSocket clients
      this.emitEvent({ type: "output", sessionId: id, data: { chunk, output: record.output } });

      // Extract Claude session ID (early exit if already found)
      if (!record.claudeSessionId) {
        record.sessionIdWindow = appendWindow(record.sessionIdWindow, chunk, OUTPUT_WINDOW_SIZE);
        const match = CLAUDE_SESSION_ID_PATTERN.exec(record.sessionIdWindow);
        if (match?.[1]) {
          record.claudeSessionId = match[1];
          process.stderr.write(`[wand] Captured Claude session ID: ${match[1]}\n`);
          this.persist(record);
        }
      }

      // Auto-confirm in full-access mode
      if (mode === "full-access") {
        this.autoConfirmWithRecord(record, chunk, child);
      }
    });

    child.onExit(({ exitCode }) => {
      const current = this.sessions.get(id);
      if (!current) {
        return;
      }
      current.status = current.stopRequested ? "stopped" : exitCode === 0 ? "exited" : "failed";
      current.exitCode = current.stopRequested ? null : exitCode;
      current.endedAt = new Date().toISOString();
      current.ptyProcess = null;
      this.persist(current);

      // Emit ended event
      this.emitEvent({ type: "ended", sessionId: id, data: this.snapshot(current) });
    });

    return this.snapshot(record);
  }

  list(): SessionSnapshot[] {
    this.archiveExpiredSessions();
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshot(session));
  }

  get(id: string): SessionSnapshot | null {
    this.archiveExpiredSessions();
    const record = this.sessions.get(id);
    return record ? this.snapshot(record) : null;
  }

  sendInput(id: string, input: string): SessionSnapshot {
    const record = this.mustGet(id);
    if (!record.ptyProcess || record.status !== "running") {
      throw new Error("Session is not running.");
    }
    record.ptyProcess.write(input);
    this.persist(record);
    return this.snapshot(record);
  }

  resize(id: string, cols: number, rows: number): SessionSnapshot {
    const record = this.mustGet(id);
    if (!record.ptyProcess || record.status !== "running") {
      return this.snapshot(record);
    }

    const safeCols = clampDimension(cols, 20, 400);
    const safeRows = clampDimension(rows, 10, 160);
    record.ptyProcess.resize(safeCols, safeRows);
    return this.snapshot(record);
  }

  stop(id: string): SessionSnapshot {
    const record = this.mustGet(id);
    if (!record.ptyProcess || record.status !== "running") {
      return this.snapshot(record);
    }

    try {
      record.stopRequested = true;
      record.ptyProcess.kill();
    } catch {
      record.status = "failed";
      record.endedAt = new Date().toISOString();
      record.output += "\n[wand] Failed to stop session cleanly.\n";
    }

    this.persist(record);
    return this.snapshot(record);
  }

  delete(id: string): void {
    const record = this.mustGet(id);
    if (record.ptyProcess && record.status === "running") {
      try {
        record.stopRequested = true;
        record.ptyProcess.kill();
      } catch {
        // Ignore and continue deleting persisted state.
      }
    }
    this.sessions.delete(id);
    this.storage.deleteSession(id);
  }

  async runStartupCommands(): Promise<SessionSnapshot[]> {
    return this.config.startupCommands.map((command) =>
      this.start(command, this.config.defaultCwd, this.config.defaultMode)
    );
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    return {
      id: record.id,
      command: record.command,
      cwd: record.cwd,
      mode: record.mode,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      output: record.output,
      archived: record.archived,
      archivedAt: record.archivedAt,
      claudeSessionId: record.claudeSessionId
    };
  }

  private persist(record: SessionRecord): void {
    this.storage.saveSession(this.snapshot(record));
  }

  private archiveExpiredSessions(): void {
    const now = Date.now();
    for (const record of this.sessions.values()) {
      if (record.archived || record.status === "running") {
        continue;
      }
      const referenceTime = record.endedAt ?? record.startedAt;
      const endedAtMs = Date.parse(referenceTime);
      if (!Number.isFinite(endedAtMs) || now - endedAtMs < ARCHIVE_AFTER_MS) {
        continue;
      }
      record.archived = true;
      record.archivedAt = new Date(now).toISOString();
      this.persist(record);
    }
  }

  private assertCommandAllowed(command: string): void {
    if (this.config.allowedCommandPrefixes.length === 0) {
      return;
    }

    const isAllowed = this.config.allowedCommandPrefixes.some((prefix) => command.startsWith(prefix));
    if (!isAllowed) {
      throw new Error("Command is not allowed by current configuration.");
    }
  }

  private autoConfirmWithRecord(record: SessionRecord, output: string, ptyProcess: IPty): void {
    record.confirmWindow = appendWindow(record.confirmWindow, output, CONFIRM_WINDOW_SIZE);
    const normalized = normalizePromptText(record.confirmWindow);
    const now = Date.now();

    const trustFolderPrompt =
      /\byes,\s*i\s*trust\s*this\s*folder\b/i.test(normalized) &&
      /\benter to confirm\b/i.test(normalized);

    const claudeConfirmPrompt =
      /\bdo you want to\b/i.test(normalized) &&
      /\byes\b/i.test(normalized);

    // Check for Claude's tool permission prompt patterns
    const toolPermissionPrompt =
      /\bdo you want to\b/i.test(normalized) &&
      /\(yes\b/i.test(normalized);

    // Check if this is a selection-based prompt (needs Enter, not 'y')
    const isSelectionPrompt = SELECTION_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));

    // Reduced cooldown for faster response
    if (now - record.lastAutoConfirmAt < 500) {
      return;
    }

    const shouldConfirm = trustFolderPrompt || claudeConfirmPrompt || toolPermissionPrompt || PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));

    if (shouldConfirm) {
      record.lastAutoConfirmAt = now;
      process.stderr.write(`[wand] Auto-confirming prompt in full-access mode\n`);
      // For Claude Code's selection UI, Enter confirms the selected option
      // For other prompts, "y" + Enter confirms
      if (trustFolderPrompt || claudeConfirmPrompt || toolPermissionPrompt || isSelectionPrompt) {
        ptyProcess.write("\r");
      } else {
        ptyProcess.write("y\r");
      }
    }
  }

  private mustGet(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) {
      throw new Error("Session not found.");
    }
    return record;
  }

  private buildShellArgs(command: string): string[] {
    if (os.platform() === "win32") {
      return ["/d", "/s", "/c", command];
    }
    return ["-ic", command];
  }

  private processCommandForMode(command: string, mode: ExecutionMode): string {
    // For full-access mode with claude commands, add permission flags
    if (mode === "full-access" && /^claude\s/.test(command)) {
      // Check if permission-mode is already specified
      if (!/--permission-mode\b/.test(command)) {
        // Add --permission-mode acceptEdits for full-access mode
        return command.replace(/^claude\s/, "claude --permission-mode acceptEdits ");
      }
    }
    return command;
  }
}

function normalizePromptText(value: string): string {
  return value
    .replace(/\u001b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count) || 1))
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function normalizePtyOutput(value: string): string {
  return value.replace(/\r\r\n/g, "\r\n");
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
