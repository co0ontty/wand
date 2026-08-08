import { randomUUID } from "node:crypto";

import pty from "node-pty";

import { ensureNodePtyHelperExecutable } from "./ensure-node-pty-helper.js";
import { PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";
import type { PtyTerminalSnapshot } from "./pty-terminal-state.js";

export interface TerminalDataEvent {
  data: string;
  /** Monotonic per-incarnation chunk sequence used for gap-free reattach. */
  seq: number;
}

export interface TerminalExitEvent {
  exitCode: number;
  signal?: number;
}

export interface TerminalProcess {
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(listener: (event: TerminalDataEvent) => void): { dispose(): void };
  onExit(listener: (event: TerminalExitEvent) => void): { dispose(): void };
}

export interface TerminalSessionState {
  sessionId: string;
  incarnationId: string;
  pid: number;
  status: "running" | "exited";
  exitCode: number | null;
  cols: number;
  rows: number;
  seq: number;
  output: string;
  chunks: TerminalDataEvent[];
  terminalSnapshot: PtyTerminalSnapshot | null;
  launchMarkerToken: string | null;
}

export interface TerminalAttachResult {
  process: TerminalProcess | null;
  state: TerminalSessionState;
  replay: TerminalDataEvent[];
  isNew: boolean;
}

export interface TerminalSpawnRequest {
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  name: string;
  cols: number;
  rows: number;
  launchMarkerToken?: string;
}

/**
 * Owns terminal processes behind one small seam. Persistent adapters may outlive
 * their caller; in-process adapters deliberately retain the legacy lifecycle.
 */
export interface TerminalHost {
  readonly persistent: boolean;
  attach(sessionId: string, afterSeq?: number): TerminalAttachResult | null;
  createOrAttach(request: TerminalSpawnRequest, afterSeq?: number): Promise<TerminalAttachResult>;
  forget(sessionId: string): void;
  disconnect(): void;
}

class InProcessTerminalProcess implements TerminalProcess {
  readonly incarnationId = randomUUID();
  private seq = 0;

  constructor(
    readonly sessionId: string,
    private readonly child: import("node-pty").IPty,
  ) {}

  get pid(): number {
    return this.child.pid;
  }

  write(data: string): void {
    this.child.write(data);
  }

  resize(cols: number, rows: number): void {
    this.child.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.child.kill(signal);
  }

  pause(): void {
    this.child.pause();
  }

  resume(): void {
    this.child.resume();
  }

  onData(listener: (event: TerminalDataEvent) => void): { dispose(): void } {
    return this.child.onData((data) => listener({ data, seq: ++this.seq }));
  }

  onExit(listener: (event: TerminalExitEvent) => void): { dispose(): void } {
    return this.child.onExit(({ exitCode, signal }) => listener({ exitCode, signal }));
  }
}

/** Legacy/local adapter and deterministic test adapter for the TerminalHost seam. */
export class InProcessTerminalHost implements TerminalHost {
  readonly persistent = false;
  private readonly processes = new Map<string, InProcessTerminalProcess>();

  attach(): TerminalAttachResult | null {
    return null;
  }

  async createOrAttach(request: TerminalSpawnRequest): Promise<TerminalAttachResult> {
    const existing = this.processes.get(request.sessionId);
    if (existing) {
      return {
        process: existing,
        state: emptyRunningState(existing, request.cols, request.rows, request.launchMarkerToken),
        replay: [],
        isNew: false,
      };
    }

    ensureNodePtyHelperExecutable();
    const child = pty.spawn(request.file, request.args, {
      cwd: request.cwd,
      env: request.env,
      name: request.name,
      cols: request.cols,
      rows: request.rows,
    });
    const process = new InProcessTerminalProcess(request.sessionId, child);
    this.processes.set(request.sessionId, process);
    process.onExit(() => {
      if (this.processes.get(request.sessionId) === process) {
        this.processes.delete(request.sessionId);
      }
    });
    return {
      process,
      state: emptyRunningState(process, request.cols, request.rows, request.launchMarkerToken),
      replay: [],
      isNew: true,
    };
  }

  forget(sessionId: string): void {
    this.processes.delete(sessionId);
  }

  disconnect(): void {
    for (const process of this.processes.values()) {
      try { process.kill(); } catch { /* best-effort legacy shutdown */ }
    }
    this.processes.clear();
  }
}

function emptyRunningState(
  process: TerminalProcess,
  cols: number,
  rows: number,
  launchMarkerToken?: string,
): TerminalSessionState {
  return {
    sessionId: process.sessionId,
    incarnationId: process.incarnationId,
    pid: process.pid,
    status: "running",
    exitCode: null,
    cols,
    rows,
    seq: 0,
    output: "",
    chunks: [],
    terminalSnapshot: null,
    launchMarkerToken: launchMarkerToken ?? null,
  };
}

/** Keep a bounded replay log while preserving chunk sequence numbers. */
export function appendTerminalChunkWindow(
  chunks: readonly TerminalDataEvent[],
  event: TerminalDataEvent,
): TerminalDataEvent[] {
  const boundedEvent = event.data.length > PTY_OUTPUT_MAX_SIZE
    ? { ...event, data: event.data.slice(-PTY_OUTPUT_MAX_SIZE) }
    : event;
  const next = [...chunks, boundedEvent];
  let size = 0;
  let first = next.length;
  while (first > 0) {
    const candidate = next[first - 1].data.length;
    if (size > 0 && size + candidate > PTY_OUTPUT_MAX_SIZE) break;
    size += candidate;
    first -= 1;
  }
  return next.slice(first);
}
