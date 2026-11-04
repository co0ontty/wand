import { StringDecoder } from "node:string_decoder";

/**
 * Ownership seam for structured CLI runs, mirroring TerminalHost for PTYs.
 * Persistent adapters outlive web restarts; the local execution path lives in
 * structured-exec-pump.ts.
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
  /** Internal opt-in: a real Pi native TUI in an owned tmux pane. Never supplied by HTTP command text. */
  nativePi?: boolean;
  nativeInputMessageId?: string;
  requestId?: string;
  /** Native launch cancellation before input has been accepted; not sent to daemon RPCs. */
  launchSignal?: AbortSignal;
}

export interface StructuredRunState {
  /** Owner and process group are absent; original exit status was not recorded. */
  ownerLost?: boolean;
  runId: string;
  incarnationId: string;
  /** Original execution identity retained by the persistent owner. */
  requestId?: string;
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
  /** Already-file-backed native output; no Server-side stdout capture copy is required. */
  nativeFile?: string;
  /** Validated native replay starts after this durable parsed checkpoint. */
  stdoutFrom?: number;
}

export interface StructuredStreamEvent {
  stream: "stdout" | "stderr";
  data: string;
  seq: number;
}

export interface StructuredExitEvent {
  ownerLost?: boolean;
  exitCode: number | null;
  signal: number | null;
  /** false for observation/transport failure, not an OS process exit. */
  processExited?: boolean;
}

export interface StructuredExecProcess {
  readonly runId: string;
  readonly incarnationId: string;
  readonly pid: number;
  /** Immutable identity of the native journal, used only by internal checkpoints. */
  readonly protocolSource?: { file: string; dev: number; ino: number };
  interrupt(signal?: string): void;
  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void };
  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void };
}

export interface StructuredExecHost {
  readonly persistent: boolean;
  readonly piNativeTui?: boolean;
  offerPiInput?(runId: string, boundaryId: string, take: (identity: import("./pi-native-input.js").PiInputHandoff) => string | null): boolean;
  resolvePiInput?(runId: string, handoff: import("./pi-native-input.js").PiInputHandoff): import("./pi-native-input.js").PiInputResolution;
  collectGarbage?(options: { liveSessionIds: ReadonlySet<string>; activeSessionIds?: ReadonlySet<string>; retentionMs: number; now?: number }): { removedSlots: number; removedTurns: number; freedBytes: number };
  spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess>;
  /** Full state incl. replay logs; null when the host does not know the run. */
  attachRun(runId: string, checkpoint?: import("./pi-cli-checkpoint.js").PiCliCheckpoint): Promise<StructuredRunState | null>;
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
