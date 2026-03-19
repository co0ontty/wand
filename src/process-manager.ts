import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import pty, { IPty } from "node-pty";
import { ExecutionMode, SessionSnapshot, WandConfig } from "./types.js";

interface SessionRecord extends SessionSnapshot {
  processId: number | null;
  ptyProcess: IPty | null;
  stopRequested: boolean;
  confirmWindow: string;
  lastAutoConfirmAt: number;
}

export class ProcessManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly config: WandConfig) {}

  start(command: string, cwd: string | undefined, mode: ExecutionMode): SessionSnapshot {
    this.assertCommandAllowed(command);

    const resolvedCwd = cwd
      ? path.resolve(process.cwd(), cwd)
      : path.resolve(process.cwd(), this.config.defaultCwd);
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

    const shellArgs = this.buildShellArgs(command);
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

    child.onData((chunk: string) => {
      this.appendOutput(id, chunk);
      if (mode === "full-access") {
        this.autoConfirm(chunk, child);
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

  private autoConfirm(output: string, ptyProcess: IPty): void {
    const record = Array.from(this.sessions.values()).find((session) => session.ptyProcess === ptyProcess);
    if (!record) {
      return;
    }

    record.confirmWindow = `${record.confirmWindow}${output}`.slice(-400);
    const normalized = normalizePromptText(record.confirmWindow);
    const now = Date.now();
    const promptPatterns = [
      /(?:^|\b)(?:press\s+)?(?:y|yes)\s*(?:\/|\bor\b)\s*(?:n|no)(?:\b|$)/i,
      /\[(?:y|yes)\s*\/\s*(?:n|no)\]/i,
      /\((?:y|yes)\s*\/\s*(?:n|no)\)/i,
      /\((?:y|yes)\s*\/\s*(?:n|no)\s*\/\s*always\)/i,
      /\bcontinue\?\s*(?:\((?:y|yes)\s*\/\s*(?:n|no)\))?/i,
      /\bare you sure\??/i,
      /\bdo you want to continue\??/i,
      /\bconfirm(?:\s+execution|\s+changes|\s+action)?\??/i,
      /\bproceed\??/i
    ];

    if (now - record.lastAutoConfirmAt < 900) {
      return;
    }

    if (promptPatterns.some((pattern) => pattern.test(normalized))) {
      record.lastAutoConfirmAt = now;
      ptyProcess.write("y\r");
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
}

function normalizePromptText(value: string): string {
  return value
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
