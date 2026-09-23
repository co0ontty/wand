import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  structuredRunId,
  type StructuredExecHost,
  type StructuredExecProcess,
  type StructuredExitEvent,
  type StructuredStreamEvent,
} from "../../src/structured-exec-host.js";

/** Supply a fresh client to the SAME daemon on every call (not a fresh daemon). */
export interface ContractClient extends StructuredExecHost {
  disconnect(): void;
}

export interface ContractSnapshot {
  stdio: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    duplicatePid: boolean;
    duplicateIncarnation: boolean;
    duplicateAfterExit: boolean;
    replayMatches: boolean;
    ordered: boolean;
  };
  utf8: { stdout: string; stderr: string; noReplacement: boolean; ordered: boolean };
  fast: { stdout: string; stderr: string; exitCode: number | null };
  empty: { stdout: string; stderr: string; exitCode: number | null };
  error: { spawnFailed: boolean; signal: number | null };
  inputFailure: { exitCode: number | null; replayExitCode: number | null };
  reconnect: { samePid: boolean; sameIncarnation: boolean; before: string; tail: string; full: string; stderr: string; exitCode: number | null };
  cancel: { stdout: string; exitCode: number | null; signal: number | null };
}

const CLI = path.resolve("tests/fixtures/structured-exec-contract-cli.mjs");
const NODE = process.execPath;
const PREFIX = "contract-";

function request(root: string, name: string, mode: string, args: string[] = []) {
  return {
    runId: structuredRunId(`${PREFIX}${name}`),
    file: NODE,
    args: [CLI, mode, ...args],
    cwd: root,
    env: {},
  };
}

function collect(handle: StructuredExecProcess): {
  events: StructuredStreamEvent[];
  done: Promise<StructuredExitEvent>;
} {
  const events: StructuredStreamEvent[] = [];
  const done = new Promise<StructuredExitEvent>((resolve) => {
    handle.onStream((event) => { events.push(event); });
    handle.onExit(resolve);
  });
  return { events, done };
}

async function exitWithin(done: Promise<StructuredExitEvent>): Promise<StructuredExitEvent> {
  return Promise.race([
    done,
    delay(8_000).then(() => { throw new Error("structured CLI did not exit in 8s"); }),
  ]);
}

function text(events: StructuredStreamEvent[], stream: "stdout" | "stderr"): string {
  return events.filter((event) => event.stream === stream).map((event) => event.data).join("");
}

function ordered(events: StructuredStreamEvent[]): boolean {
  return (["stdout", "stderr"] as const).every((stream) => {
    let previous = 0;
    return events.filter((event) => event.stream === stream).every((event) => {
      if (!Number.isSafeInteger(event.seq) || event.seq <= previous) return false;
      previous = event.seq;
      return true;
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("structured contract condition did not become true in 5s");
}

/**
 * Shared S0 contract baseline: can be called with legacy terminald now and
 * Render v2 later. Normalizes only scheduling-dependent chunk boundaries,
 * PID and incarnation UUID; all user-visible stream/exit/replay fields remain.
 */
export async function captureStructuredExecContract(
  connect: () => Promise<ContractClient>,
  root: string,
): Promise<ContractSnapshot> {
  let client = await connect();
  try {
    const stdioRequest = {
      ...request(root, "stdio", "stdio", ["--resume", "fixture-id"]),
      stdinData: "样例🙂",
    };
    const stdioHandle = await client.spawnStructured(stdioRequest);
    const stdioEvents = collect(stdioHandle);
    const duplicate = await client.spawnStructured(stdioRequest);
    const stdioExit = await exitWithin(stdioEvents.done);
    const stdioState = await client.attachRun(stdioRequest.runId);
    assert.ok(stdioState, "stdio run must be attachable even after exit");
    const lateRetry = await client.spawnStructured(stdioRequest);
    const lateResult = collect(lateRetry);
    assert.deepEqual(await exitWithin(lateResult.done), stdioExit);
    const stdio = {
      stdout: text(stdioEvents.events, "stdout"),
      stderr: text(stdioEvents.events, "stderr"),
      exitCode: stdioExit.exitCode,
      duplicatePid: duplicate.pid === stdioHandle.pid && stdioHandle.pid > 0,
      duplicateIncarnation: duplicate.incarnationId === stdioHandle.incarnationId,
      duplicateAfterExit: lateRetry.pid === stdioHandle.pid
        && lateRetry.incarnationId === stdioHandle.incarnationId
        && text(lateResult.events, "stdout") === text(stdioEvents.events, "stdout"),
      replayMatches: stdioState.stdoutLog === text(stdioEvents.events, "stdout")
        && stdioState.stderrLog === text(stdioEvents.events, "stderr")
        && stdioState.stdoutTruncated === false && stdioState.stderrTruncated === false,
      ordered: ordered(stdioEvents.events),
    };
    assert.equal(stdioState.status, "exited");
    client.forgetRun(stdioRequest.runId);

    const utf8Request = request(root, "utf8", "utf8");
    const utf8Events = collect(await client.spawnStructured(utf8Request));
    await exitWithin(utf8Events.done);
    const utf8State = await client.attachRun(utf8Request.runId);
    const utf8 = {
      stdout: text(utf8Events.events, "stdout"),
      stderr: text(utf8Events.events, "stderr"),
      noReplacement: !JSON.stringify(utf8State).includes("\uFFFD")
        && !text(utf8Events.events, "stdout").includes("\uFFFD")
        && !text(utf8Events.events, "stderr").includes("\uFFFD"),
      ordered: ordered(utf8Events.events),
    };
    assert.equal(utf8State?.stdoutLog, utf8.stdout);
    assert.equal(utf8State?.stderrLog, utf8.stderr);
    client.forgetRun(utf8Request.runId);

    const fastRequest = request(root, "fast", "fast");
    const fastEvents = collect(await client.spawnStructured(fastRequest));
    const fastExit = await exitWithin(fastEvents.done);
    const fast = {
      stdout: text(fastEvents.events, "stdout"),
      stderr: text(fastEvents.events, "stderr"),
      exitCode: fastExit.exitCode,
    };
    client.forgetRun(fastRequest.runId);

    const emptyRequest = request(root, "empty", "empty");
    const emptyEvents = collect(await client.spawnStructured(emptyRequest));
    const emptyExit = await exitWithin(emptyEvents.done);
    const empty = {
      stdout: text(emptyEvents.events, "stdout"),
      stderr: text(emptyEvents.events, "stderr"),
      exitCode: emptyExit.exitCode,
    };
    client.forgetRun(emptyRequest.runId);

    // A nonexistent executable is a spawn error, not an invitation to retry
    // this runId on a different owner. Its exit remains observable on attach.
    const errorId = structuredRunId(`${PREFIX}error`);
    const errorEvents = collect(await client.spawnStructured({
      runId: errorId, file: path.join(root, "absent-cli"), args: [], cwd: root, env: {},
    }));
    const errorExit = await exitWithin(errorEvents.done);
    const errorState = await client.attachRun(errorId);
    assert.equal(errorState?.status, "exited");
    assert.ok(errorState && errorState.pid <= 0, "failed spawn must not claim a live PID");
    assert.equal(errorState?.stdoutLog, "");
    assert.equal(errorState?.stderrLog, "");
    // libuv uses a negative errno (e.g. -2/ENOENT); Rust may report a
    // different platform code. Only the externally observable failure is fixed.
    const error = { spawnFailed: errorExit.exitCode === null || errorExit.exitCode < 0, signal: errorExit.signal };
    client.forgetRun(errorId);

    // Large enough to force a pipe write even when the child closes stdin
    // immediately. Exit 0 must never conceal a prompt that was not delivered.
    const brokenInput = { ...request(root, "input-failure", "empty"), stdinData: "x".repeat(2 * 1024 * 1024) };
    const brokenEvents = collect(await client.spawnStructured(brokenInput));
    const brokenExit = await exitWithin(brokenEvents.done);
    const brokenState = await client.attachRun(brokenInput.runId);
    const inputFailure = { exitCode: brokenExit.exitCode, replayExitCode: brokenState?.exitCode ?? null };
    client.forgetRun(brokenInput.runId);

    const reconnectRequest = request(root, "reconnect", "reconnect");
    const original = await client.spawnStructured(reconnectRequest);
    await waitFor(async () => (await client.attachRun(reconnectRequest.runId))?.stdoutLog === "one\n");
    const before = await client.attachRun(reconnectRequest.runId);
    assert.equal(before?.status, "running");
    client.disconnect();
    client = await connect();
    await waitFor(async () => (await client.attachRun(reconnectRequest.runId))?.stdoutLog.includes("two\n") ?? false);
    const after = await client.attachRun(reconnectRequest.runId);
    assert.ok(after, "reconnected client must see original owner");
    assert.equal(after.status, "running");
    const adopted = await client.adoptRun(reconnectRequest.runId);
    assert.ok(adopted, "running run must be adoptable");
    const tailEvents = collect(adopted);
    const reconnectExit = await exitWithin(tailEvents.done);
    const final = await client.attachRun(reconnectRequest.runId);
    assert.ok(final);
    const reconnect = {
      samePid: after.pid === original.pid && adopted.pid === original.pid,
      sameIncarnation: after.incarnationId === original.incarnationId
        && adopted.incarnationId === original.incarnationId,
      before: before?.stdoutLog ?? "",
      tail: text(tailEvents.events, "stdout"),
      full: final.stdoutLog,
      stderr: final.stderrLog,
      exitCode: reconnectExit.exitCode,
    };
    client.forgetRun(reconnectRequest.runId);

    const cancelRequest = request(root, "cancel", "cancel");
    const cancelHandle = await client.spawnStructured(cancelRequest);
    const cancelEvents = collect(cancelHandle);
    await waitFor(() => text(cancelEvents.events, "stdout") === "ready\n");
    cancelHandle.interrupt("SIGTERM");
    const cancelExit = await exitWithin(cancelEvents.done);
    const cancel = {
      stdout: text(cancelEvents.events, "stdout"),
      exitCode: cancelExit.exitCode,
      signal: cancelExit.signal,
    };
    client.forgetRun(cancelRequest.runId);

    return { stdio, utf8, fast, empty, error, inputFailure, reconnect, cancel };
  } finally {
    // Cleanup on both success and assertion failure, without killing any
    // unrelated daemon run. The test daemon itself is stopped by the caller.
    try {
      for (const run of await client.listRuns()) {
        if (run.runId.startsWith(`structured:${PREFIX}`)) client.forgetRun(run.runId);
      }
    } catch {
      // A disconnected daemon cannot be cleaned up through this client; the
      // test fixture stops its dedicated daemon in t.after instead.
    } finally {
      client.disconnect();
    }
  }
}

export const EXPECTED_STRUCTURED_CONTRACT: ContractSnapshot = {
  stdio: {
    stdout: '{"input":"样例🙂","args":["--resume","fixture-id"]}\n',
    stderr: "诊断🙂\n",
    exitCode: 0,
    duplicatePid: true,
    duplicateIncarnation: true,
    duplicateAfterExit: true,
    replayMatches: true,
    ordered: true,
  },
  utf8: { stdout: '{"text":"你好🙂"}\n', stderr: "诊断🙂\n", noReplacement: true, ordered: true },
  fast: { stdout: "fast\n", stderr: "failed\n", exitCode: 7 },
  empty: { stdout: "", stderr: "", exitCode: 0 },
  error: { spawnFailed: true, signal: null },
  inputFailure: { exitCode: -1, replayExitCode: -1 },
  reconnect: {
    samePid: true,
    sameIncarnation: true,
    before: "one\n",
    tail: "three\n",
    full: "one\ntwo\nthree\n",
    stderr: "diagnostic\n",
    exitCode: 0,
  },
  cancel: { stdout: "ready\n", exitCode: null, signal: 15 },
};

/** A Rust adapter must match the same semantic fields, not merely avoid throwing. */
export function assertStructuredContractEquivalent(
  reference: ContractSnapshot,
  candidate: ContractSnapshot,
): void {
  assert.deepEqual(candidate, reference);
}
