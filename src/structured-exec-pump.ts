import { spawn } from "node:child_process";
import { appendDiagnosticTail, MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";
import { PiOutputFile, type PiOutputFileOptions } from "./pi-output-file.js";

import {
  createUtf8TextDecoder,
  type StructuredExecHost,
  type StructuredExecProcess,
} from "./structured-exec-host.js";
import { signalNameFromNumber } from "./signal-utils.js";
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
  /** Pi opts in: stdout is captured to a private file; only file reads feed processLine. */
  stdoutFile?: PiOutputFileOptions;
  nativePi?: boolean;
  requestId?: string;
  /** Provider-owned streaming projection; defaults to the strict shared line framer. */
  createProtocolReader?(onLine: (line: string) => void): { push(text: string): void; finish(): void };
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
    requestStop: () => requestStop(),
  };

  let source: PumpSource | null = null;
  let stdoutFile: PiOutputFile | null = null;
  const nativeLaunch = options.nativePi ? new AbortController() : null;
  let lineBuffer = "";
  let lineBytes = 0;
  const protocolReader = options.createProtocolReader?.((line) => options.processLine(line, ctx));
  let settled = false;
  let stopRequested = false;
  let stopDelivered = false;
  // A pending spawn has no cancellable handle yet. Remember one request and
  // deliver it once when ready; never install a self-referential placeholder.
  function interruptSource(): void {
    if (!source || stopDelivered) return;
    stopDelivered = true;
    try { source.interrupt(); } catch { /* best-effort interruption */ }
  }
  function requestStop(): void {
    if (settled || stopRequested) return;
    stopRequested = true;
    nativeLaunch?.abort();
    interruptSource();
  }
  let acknowledgeExit = () => {};
  const exited = new Promise<void>((resolve) => { acknowledgeExit = resolve; });
  let resolveCompletion!: (result: StructuredRunnerResult) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<StructuredRunnerResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const finish = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    spawnError?: NodeJS.ErrnoException,
    protocolError?: Error,
    beforeSpawn = false,
  ): void => {
    if (settled) return;
    if (!protocolError) {
      try {
        stdoutFile?.drain();
        // File consumption can itself settle a protocol failure.
        if (settled) return;
        protocolReader?.finish();
      } catch (error) { protocolError = error instanceof Error ? error : new Error(String(error)); }
      if (settled) return;
    }
    settled = true;
    try {
      if (!protocolError && lineBuffer.trim()) options.processLine(lineBuffer, ctx);
      const result = options.finalize(ctx, exitCode, signal, spawnError);
      resolveCompletion(beforeSpawn ? { ...result, primaryError: spawnError?.message ?? "Pi 实时事件文件初始化失败。",
        inputAccepted: false, retryForbidden: true, failure: { kind: "preflight", delivery: "rejected", retryable: false } }
        : protocolError ? { ...result, exitCode: 1, primaryError: protocolError.message,
            rejection: undefined, inputAccepted: result.inputAccepted === true ? true : undefined,
            retryForbidden: true, failure: { kind: "runtime", delivery: "unknown", retryable: false } } : result);
    } catch (error) {
      rejectCompletion(error);
    } finally {
      stdoutFile?.dispose();
      lineBuffer = "";
      lineBytes = 0;
    }
    if (protocolError) interruptSource();
  };

  const handleStdoutText = (text: string): void => {
    if (settled || !text || !observer.isActive()) return;
    observer.onStdout?.(text);
    options.onStdoutText?.(text);
    try {
      if (protocolReader) { protocolReader.push(text); return; }
      const parts = text.split("\n");
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        lineBytes += Buffer.byteLength(part, "utf8");
        if (lineBytes > MAX_PROTOCOL_LINE_BYTES) throw new Error("CLI 协议单行超过 8 MiB 上限；本轮已停止，送达结果不能据此推定为未接受。");
        lineBuffer += part;
        if (index < parts.length - 1) {
          options.processLine(lineBuffer, ctx);
          lineBuffer = "";
          lineBytes = 0;
        }
      }
    } catch (error) {
      // Settle the failure before kill can synchronously deliver a close event.
      finish(1, null, undefined, error instanceof Error ? error : new Error(String(error)));
      interruptSource();
    }
  };

  const handleStderrText = (text: string): void => {
    if (settled || !text || !observer.isActive()) return;
    observer.onStderr?.(text);
    ctx.stderr = appendDiagnosticTail(ctx.stderr, text);
  };

  const execution: StructuredRunnerExecution = {
    args: options.args,
    spawnedAt,
    get pid() { return source?.pid ?? null; },
    completion,
    exited,
    interrupt: requestStop,
  };
  const fileFailure = (error: Error): void => {
    finish(1, null, undefined, new Error(`Pi 实时事件文件读写失败：${error.message}`));
    interruptSource();
  };
  const captureStdout = (text: string): void => {
    if (settled || !text) return;
    if (!observer.isActive()) { stdoutFile?.dispose(); return; }
    if (!stdoutFile) { handleStdoutText(text); return; }
    try { stdoutFile.append(text); }
    catch (error) { fileFailure(error instanceof Error ? error : new Error(String(error))); }
  };
  if (options.stdoutFile) {
    try { stdoutFile = new PiOutputFile(options.stdoutFile, () => observer.isActive(), handleStdoutText, fileFailure); }
    catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      acknowledgeExit(); // No process was started.
      finish(null, null, Object.assign(new Error(`Pi 实时事件文件初始化失败：${cause}`), { code: "EFILESOURCE" }), undefined, true);
      return execution;
    }
  }

  const host = options.execHost;
  if (host?.persistent) {
    const request: Parameters<StructuredExecHost["spawnStructured"]>[0] = {
      runId: `structured:${options.sessionId}`,
      file: options.file,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      ...(options.stdinData !== undefined ? { stdinData: options.stdinData } : {}),
      ...(options.nativePi ? { nativePi: true, requestId: options.requestId, launchSignal: nativeLaunch!.signal } : {}),
    };
    const unavailable = (error?: unknown): void => {
      source = null;
      if (error && typeof error === "object" && "preflightBlocked" in error && error.preflightBlocked) {
        acknowledgeExit();
        finish(null, null, Object.assign(new Error(error instanceof Error ? error.message : "Pi 原生启动被拒绝。"), { code: "ENATIVE_PREFLIGHT" }), undefined, true);
        return;
      }
      if (error && typeof error === "object" && "deliveryUnknown" in error && error.deliveryUnknown) {
        finish(1, null, undefined, new Error("Pi 原生启动送达结果未知，不自动重试。"));
        return;
      }
      // Explicit pre-execution failure; existing providers retain their daemon contract.
      acknowledgeExit();
      finish(null, null, Object.assign(new Error(options.nativePi && error instanceof Error
        ? error.message : `terminal daemon unavailable for ${options.file}`), { code: "EDAEMON" }));
    };
    try {
      void host.spawnStructured(request).then((handle) => {
        source = { pid: handle.pid, interrupt: () => handle.interrupt() };
        // Replay and subscribe before applying a pending external cancellation.
        wireRemoteHandle(handle, captureStdout, handleStderrText, finish, acknowledgeExit);
        if (stopRequested && !settled) interruptSource();
      }, unavailable);
    } catch {
      unavailable();
    }
  } else {
    const spawnProcess = options.spawnProcess ?? spawn;
    const wantsStdin = typeof options.stdinData === "string";
    const child = spawnProcess(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: wantsStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    source = { pid: child.pid ?? null, interrupt: () => child.kill("SIGTERM") };
    const stdoutDecoder = createUtf8TextDecoder();
    const stderrDecoder = createUtf8TextDecoder();
    child.stdout?.on("data", (chunk: Buffer) => captureStdout(stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => handleStderrText(stderrDecoder.write(chunk)));
    child.on("error", (error) => finish(null, null, error as NodeJS.ErrnoException));
    child.stdin?.on("error", (error) => {
      requestStop();
      finish(null, null, error as NodeJS.ErrnoException);
    });
    child.on("close", (exitCode, signalName) => {
      acknowledgeExit();
      captureStdout(stdoutDecoder.end());
      handleStderrText(stderrDecoder.end());
      finish(exitCode, signalName === null || signalName === undefined ? null : signalName);
    });
    if (wantsStdin) child.stdin?.end(options.stdinData);
  }

  return execution;
}

function wireRemoteHandle(
  handle: StructuredExecProcess,
  onStdout: (text: string) => void,
  onStderr: (text: string) => void,
  finish: (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException) => void,
  acknowledgeExit: () => void,
): void {
  handle.onStream((event) => {
    if (event.stream === "stdout") onStdout(event.data);
    else onStderr(event.data);
  });
  handle.onExit((event) => {
    if (event.processExited !== false) acknowledgeExit();
    finish(event.exitCode, signalNameFromNumber(event.signal));
  });
}
