import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

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

/**
 * Stateful UTF-8 decoder for structured CLI stdout/stderr.
 * Incomplete sequences are held across chunks. end() discards a trailing
 * incomplete sequence instead of emitting U+FFFD replacement characters.
 * Call this at the byte-stream seam, before line splitting or log append.
 */
export interface Utf8TextDecoder {
  write(chunk: Buffer | string): string;
  end(): string;
}

export function createUtf8TextDecoder(): Utf8TextDecoder {
  const decoder = new StringDecoder("utf8");
  let ended = false;
  return {
    write(chunk: Buffer | string): string {
      if (ended) return "";
      if (typeof chunk === "string") return chunk;
      return decoder.write(chunk);
    },
    end(): string {
      if (ended) return "";
      ended = true;
      decoder.end();
      return "";
    },
  };
}

/** Resolve a stable daemon-side key for a session's active structured run. */
export function structuredRunId(sessionId: string): string {
  return `structured:${sessionId}`;
}

class InProcessStructuredExecProcess implements StructuredExecProcess {
  readonly incarnationId = randomUUID();
  private stdoutSeq = 0;
  private stderrSeq = 0;
  private readonly stdoutDecoder = createUtf8TextDecoder();
  private readonly stderrDecoder = createUtf8TextDecoder();
  private readonly streamEvents: StructuredStreamEvent[] = [];
  private readonly streamListeners = new Set<(event: StructuredStreamEvent) => void>();
  private readonly exitListeners = new Set<(event: StructuredExitEvent) => void>();
  private exitEvent: StructuredExitEvent | null = null;

  constructor(
    readonly runId: string,
    private readonly child: import("node:child_process").ChildProcess,
  ) {
    const emit = (stream: "stdout" | "stderr", data: string): void => {
      if (!data) return;
      const event: StructuredStreamEvent = {
        stream,
        data,
        seq: stream === "stdout" ? ++this.stdoutSeq : ++this.stderrSeq,
      };
      this.streamEvents.push(event);
      for (const listener of this.streamListeners) listener(event);
    };
    this.child.stdout?.on("data", (chunk: Buffer | string) => emit("stdout", this.stdoutDecoder.write(chunk)));
    this.child.stderr?.on("data", (chunk: Buffer | string) => emit("stderr", this.stderrDecoder.write(chunk)));
    const settleExit = (event: StructuredExitEvent): void => {
      if (this.exitEvent) return;
      // Flush pending bytes before announcing exit; decoders no-op once ended.
      emit("stdout", this.stdoutDecoder.end());
      emit("stderr", this.stderrDecoder.end());
      this.exitEvent = event;
      for (const listener of this.exitListeners) listener(event);
    };
    this.child.on("close", (code, signal) => {
      settleExit({
        exitCode: code,
        signal: signal === null || signal === undefined ? null : osSignalNumber(signal),
      });
    });
    this.child.on("error", () => settleExit({ exitCode: null, signal: null }));
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  interrupt(signal?: string): void {
    try { this.child.kill((signal ?? "SIGTERM") as NodeJS.Signals); } catch { /* best-effort */ }
  }

  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void } {
    for (const event of this.streamEvents) listener(event);
    this.streamListeners.add(listener);
    return { dispose: () => { this.streamListeners.delete(listener); } };
  }

  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void } {
    if (this.exitEvent) {
      listener(this.exitEvent);
      return { dispose: () => { /* already delivered */ } };
    }
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitListeners.delete(listener); } };
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
    // Keep exited records until forgetRun so a late attach can still answer.
    this.processes.set(request.runId, wrapped);
    return wrapped;
  }

  async attachRun(_runId: string): Promise<StructuredRunState | null> {
    return null;
  }

  async adoptRun(_runId: string): Promise<StructuredExecProcess | null> {
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
