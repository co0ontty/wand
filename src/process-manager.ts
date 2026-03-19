import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import pty, { IPty } from "node-pty";
import { WandStorage } from "./storage.js";
import { ExecutionMode, SessionSnapshot, WandConfig } from "./types.js";

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
}

const MAX_SESSIONS = 50;

export class ProcessManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage
  ) {
    for (const snapshot of this.storage.loadSessions()) {
      this.sessions.set(snapshot.id, {
        ...snapshot,
        processId: null,
        ptyProcess: null,
        stopRequested: false,
        confirmWindow: "",
        lastAutoConfirmAt: 0
      });
    }
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
      processId: null,
      ptyProcess: null,
      stopRequested: false,
      confirmWindow: "",
      lastAutoConfirmAt: 0
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

    child.onData((chunk: string) => {
      this.appendOutput(id, chunk);
      if (mode === "full-access") {
        this.autoConfirm(id, chunk, child);
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
    });

    return this.snapshot(record);
  }

  list(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshot(session));
  }

  get(id: string): SessionSnapshot | null {
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
      output: record.output
    };
  }

  private appendOutput(id: string, text: string): void {
    const record = this.sessions.get(id);
    if (!record) {
      return;
    }

    const next = `${record.output}${text}`;
    record.output = next.length > 120000 ? next.slice(-120000) : next;
    this.persist(record);
  }

  private persist(record: SessionRecord): void {
    this.storage.saveSession(this.snapshot(record));
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

  private autoConfirm(id: string, output: string, ptyProcess: IPty): void {
    const record = this.sessions.get(id);
    if (!record) {
      return;
    }

    record.confirmWindow = `${record.confirmWindow}${output}`.slice(-800);
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

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
