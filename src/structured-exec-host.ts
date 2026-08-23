import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Ownership seam for structured CLI runs, mirroring TerminalHost for PTYs.
 * Persistent adapters (terminald) outlive web restarts; the in-process adapter
 * deliberately keeps the legacy "die with the server" lifecycle.
 */

/** Per-stream replay log cap inside the daemon. Reducers need full history. */
export const STRUCTURED_RUN_LOG_MAX_CHARS = 8 * 1024 * 1024;

export interface StructuredSpawnRequest {
  /** Stable across restarts: `structured:<sessionId>`. One run per session. */
  runId: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin once, then stdin is closed. Omit for stdio-ignore CLIs. */
  stdinData?: string;
}

export interface StructuredRunState {
  runId: string;
  incarnationId: string;
  pid: number;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  stdoutSeq: number;
  stderrSeq: number;
  stdoutLog: string;
  stderrLog: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface StructuredStreamEvent {
  stream: "stdout" | "stderr";
  data: string;
  seq: number;
}

export interface StructuredExitEvent {
  exitCode: number | null;
  signal: number | null;
}

export interface StructuredExecProcess {
  readonly runId: string;
  readonly incarnationId: string;
  readonly pid: number;
  interrupt(signal?: string): void;
  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void };
  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void };
}

export interface StructuredExecHost {
  readonly persistent: boolean;
  spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess>;
  /** Full state incl. replay logs; null when the host does not know the run. */
  attachRun(runId: string): Promise<StructuredRunState | null>;
  /** Subscribe to a known running run without spawning anything. */
  adoptRun(runId: string): Promise<StructuredExecProcess | null>;
  listRuns(): Promise<StructuredRunState[]>;
  forgetRun(runId: string): void;
}

/** Resolve a stable daemon-side key for a session's active structured run. */
export function structuredRunId(sessionId: string): string {
  return `structured:${sessionId}`;
}

class InProcessStructuredExecProcess implements StructuredExecProcess {
  readonly incarnationId = randomUUID();
  private stdoutSeq = 0;
  private stderrSeq = 0;

  constructor(
    readonly runId: string,
    private readonly child: import("node:child_process").ChildProcess,
  ) {}

  get pid(): number {
    return this.child.pid ?? -1;
  }

  interrupt(signal?: string): void {
    try { this.child.kill((signal ?? "SIGTERM") as NodeJS.Signals); } catch { /* best-effort */ }
  }

  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void } {
    const stdoutHandler = (chunk: Buffer | string): void =>
      listener({ stream: "stdout", data: chunk.toString(), seq: ++this.stdoutSeq });
    const stderrHandler = (chunk: Buffer | string): void =>
      listener({ stream: "stderr", data: chunk.toString(), seq: ++this.stderrSeq });
    this.child.stdout?.on("data", stdoutHandler);
    this.child.stderr?.on("data", stderrHandler);
    return {
      dispose: () => {
        this.child.stdout?.off("data", stdoutHandler);
        this.child.stderr?.off("data", stderrHandler);
      },
    };
  }

  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void } {
    let settled = false;
    const closeHandler = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      listener({ exitCode: code, signal: signal === null || signal === undefined ? null : osSignalNumber(signal) });
    };
    const errorHandler = (): void => {
      if (settled) return;
      settled = true;
      listener({ exitCode: null, signal: null });
    };
    this.child.on("close", closeHandler);
    this.child.on("error", errorHandler);
    return {
      dispose: () => {
        this.child.off("close", closeHandler);
        this.child.off("error", errorHandler);
      },
    };
  }
}

/** Legacy/local adapter and deterministic test adapter for the structured seam. */
export class InProcessStructuredExecHost implements StructuredExecHost {
  readonly persistent = false;
  private readonly processes = new Map<string, InProcessStructuredExecProcess>();

  async spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    const existing = this.processes.get(request.runId);
    if (existing && existing.pid > 0) return existing;
    const wantsStdin = typeof request.stdinData === "string";
    const child = spawn(request.file, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: wantsStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    if (wantsStdin) child.stdin?.end(request.stdinData);
    const wrapped = new InProcessStructuredExecProcess(request.runId, child);
    this.processes.set(request.runId, wrapped);
    wrapped.onExit(() => {
      // Keep exited records until forgetRun so attachRun can still answer.
    });
    return wrapped;
  }

  async attachRun(): Promise<StructuredRunState | null> {
    return null;
  }

  async adoptRun(): Promise<StructuredExecProcess | null> {
    return null;
  }

  async listRuns(): Promise<StructuredRunState[]> {
    return [];
  }

  forgetRun(runId: string): void {
    const wrapped = this.processes.get(runId);
    this.processes.delete(runId);
    if (wrapped) wrapped.interrupt();
  }
}

/** Map a NodeJS.Signals name to the numeric value used by waitpid-style APIs. */
export function osSignalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
    SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
    SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18,
    SIGSTOP: 19, SIGTSTP: 20,
  };
  return table[signal] ?? 0;
}
