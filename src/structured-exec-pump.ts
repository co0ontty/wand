import { spawn } from "node:child_process";

import type { StructuredExecHost, StructuredExecProcess } from "./structured-exec-host.js";
import type {
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
  StructuredRunnerTurnState,
} from "./structured-runner.js";

/**
 * Shared pump for CLI-backed structured runners. One implementation drives both
 * ownership modes: a local ChildProcess (legacy lifecycle, test injection) and
 * a daemon-backed StructuredExecProcess whose streams survive web restarts.
 * Per-provider differences stay in the adapter via processLine/finalize hooks.
 */

export interface StructuredCliPumpContext<S extends StructuredRunnerTurnState> {
  state: S;
  stderr: string;
  observer: StructuredRunnerObserver;
  /** Ask the underlying CLI to stop early (e.g. Claude ask-user-question). */
  requestStop(): void;
}

export interface StructuredCliPumpOptions<S extends StructuredRunnerTurnState> {
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin once then closed; omit for stdio-ignore CLIs. */
  stdinData?: string;
  observer: StructuredRunnerObserver;
  /** When set and persistent, the run is owned by terminald instead of us. */
  execHost?: StructuredExecHost;
  /** Local/test spawn injection; ignored when the execHost takes over. */
  spawnProcess?: typeof spawn;
  /** Fresh per-run state (or reducer-owned state) for the pump context. */
  createState(): S;
  processLine(line: string, ctx: StructuredCliPumpContext<S>): void;
  /** Raw stdout text hook (e.g. Claude stdoutTail bookkeeping). */
  onStdoutText?(text: string): void;
  finalize(
    ctx: StructuredCliPumpContext<S>,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    spawnError?: NodeJS.ErrnoException,
  ): StructuredRunnerResult;
}

interface PumpSource {
  pid: number | null;
  interrupt(): void;
}

export function startStructuredCli<S extends StructuredRunnerTurnState>(
  options: StructuredCliPumpOptions<S>,
): StructuredRunnerExecution {
  const spawnedAt = new Date().toISOString();
  const observer = options.observer;

  const ctx: StructuredCliPumpContext<S> = {
    state: options.createState(),
    stderr: "",
    observer,
    requestStop: () => source?.interrupt(),
  };

  let source: PumpSource | null = null;
  let sourceReady: Promise<void>;
  let lineBuffer = "";
  let settled = false;
  let resolveCompletion!: (result: StructuredRunnerResult) => void;
  const completion = new Promise<StructuredRunnerResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const finish = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    spawnError?: NodeJS.ErrnoException,
  ): void => {
    if (settled) return;
    settled = true;
    if (lineBuffer.trim()) options.processLine(lineBuffer, ctx);
    lineBuffer = "";
    resolveCompletion(options.finalize(ctx, exitCode, signal, spawnError));
  };

  const handleStdoutText = (text: string): void => {
    if (!observer.isActive()) return;
    observer.onStdout?.(text);
    options.onStdoutText?.(text);
    lineBuffer += text;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) options.processLine(line, ctx);
  };

  const handleStderrText = (text: string): void => {
    if (!observer.isActive()) return;
    observer.onStderr?.(text);
    ctx.stderr += text;
  };

  const useRemoteHost = options.execHost?.persistent === true;
  if (useRemoteHost) {
    const host = options.execHost!;
    const request: Parameters<StructuredExecHost["spawnStructured"]>[0] = {
      runId: `structured:${options.sessionId}`,
      file: options.file,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      ...(options.stdinData !== undefined ? { stdinData: options.stdinData } : {}),
    };
    let pendingInterrupt: string | null = null;
    sourceReady = host.spawnStructured(request).then(
      (handle) => {
        source = { pid: handle.pid, interrupt: () => handle.interrupt() };
        if (pendingInterrupt !== null) handle.interrupt(pendingInterrupt);
        wireRemoteHandle(handle, handleStdoutText, handleStderrText, finish);
      },
      () => {
        // Daemon vanished between health check and spawn; surface as spawn error.
        finish(null, null, Object.assign(new Error(`terminal daemon unavailable for ${options.file}`), { code: "EDAEMON" }));
      },
    );
    source = {
      pid: null,
      interrupt: (signal?: string) => {
        pendingInterrupt = signal ?? "SIGTERM";
        void sourceReady.then(() => source?.interrupt());
      },
    };
  } else {
    const spawnProcess = options.spawnProcess ?? spawn;
    const wantsStdin = typeof options.stdinData === "string";
    const child = spawnProcess(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: wantsStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    if (wantsStdin) child.stdin?.end(options.stdinData);
    source = { pid: child.pid ?? null, interrupt: () => child.kill("SIGTERM") };
    child.stdout?.on("data", (chunk: Buffer) => handleStdoutText(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => handleStderrText(chunk.toString()));
    child.on("error", (error) => finish(null, null, error as NodeJS.ErrnoException));
    child.on("close", (exitCode, signalName) =>
      finish(exitCode, signalName === null || signalName === undefined ? null : signalName),
    );
    sourceReady = Promise.resolve();
  }

  return {
    args: options.args,
    spawnedAt,
    get pid() {
      return source?.pid ?? null;
    },
    completion,
    interrupt: () => {
      try { source?.interrupt(); } catch { /* best-effort external interruption */ }
    },
  };
}

function wireRemoteHandle(
  handle: StructuredExecProcess,
  onStdout: (text: string) => void,
  onStderr: (text: string) => void,
  finish: (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException) => void,
): void {
  handle.onStream((event) => {
    if (event.stream === "stdout") onStdout(event.data);
    else onStderr(event.data);
  });
  handle.onExit((event) => {
    finish(event.exitCode, numericToSignalName(event.signal));
  });
}

function numericToSignalName(signal: number | null): NodeJS.Signals | null {
  if (signal === null || signal === 0) return null;
  const names: Record<number, NodeJS.Signals> = {
    1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT",
    7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2",
    13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 17: "SIGCHLD", 18: "SIGCONT",
    19: "SIGSTOP", 20: "SIGTSTP",
  };
  return names[signal] ?? ("SIGTERM" satisfies NodeJS.Signals);
}
