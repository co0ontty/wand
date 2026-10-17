import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import { startStructuredCli, type StructuredCliPumpOptions } from "../src/structured-exec-pump.js";
import type { StructuredExecHost, StructuredExecProcess, StructuredExitEvent, StructuredStreamEvent } from "../src/structured-exec-host.js";
import type { StructuredRunnerTurnState } from "../src/structured-runner.js";

function options(): StructuredCliPumpOptions<StructuredRunnerTurnState> {
  return {
    sessionId: "pump-lifecycle", file: "fake-only", args: [], cwd: process.cwd(), env: {},
    observer: { isActive: () => true, onUpdate() {} },
    createState: () => ({ blocks: [], result: "", sessionId: null }),
    processLine(line, ctx) { ctx.state.result += line; },
    finalize: (ctx, exitCode, signal, spawnError) => ({ state: ctx.state, exitCode, signal, spawnError,
      stderr: ctx.stderr, primaryError: spawnError?.message ?? null }),
  };
}

function remoteHarness() {
  let resolve!: (handle: StructuredExecProcess) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<StructuredExecProcess>((yes, no) => { resolve = yes; reject = no; });
  let stream: ((event: StructuredStreamEvent) => void) | undefined;
  let exit: ((event: StructuredExitEvent) => void) | undefined;
  let interrupts = 0;
  const handle: StructuredExecProcess = {
    runId: "pump-lifecycle", incarnationId: "fixture", pid: 42,
    interrupt() { interrupts++; },
    onStream(listener) { stream = listener; return { dispose() {} }; },
    onExit(listener) { exit = listener; return { dispose() {} }; },
  };
  const host = { persistent: true, spawnStructured: () => pending } as StructuredExecHost;
  return { host, handle, resolve, reject, interrupts: () => interrupts,
    stdout: (data: string) => stream?.({ stream: "stdout", data, seq: 1 }),
    exit: (event: StructuredExitEvent = { exitCode: 0, signal: null }) => exit?.(event),
  };
}

test("failed remote start can be interrupted before/after completion without starving timers", () => {
  // Isolate a regression in a child: the former bug starved node:test's own timeout.
  const moduleUrl = new URL("../src/structured-exec-pump.ts", import.meta.url).href;
  const code = `import { startStructuredCli } from ${JSON.stringify(moduleUrl)};
    for (const before of [true, false]) {
      const run = startStructuredCli({sessionId:"fixture",file:"fake",args:[],cwd:process.cwd(),env:{},
        observer:{isActive:()=>true,onUpdate(){}},
        execHost:{persistent:true,spawnStructured:()=>Promise.reject(new Error("offline"))},
        createState:()=>({blocks:[],result:"",sessionId:null}),processLine(){},
        finalize:(ctx,exitCode,signal,spawnError)=>({state:ctx.state,exitCode,signal,spawnError,stderr:"",primaryError:null})});
      if (before) run.interrupt();
      const result=await run.completion;
      if (!result.spawnError) throw new Error("missing spawn failure");
      run.interrupt(); run.interrupt();
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    console.log("timer-reached");`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /timer-reached/);
});

for (const before of [true, false]) {
  test(`remote cancellation is delivered once (${before ? "pending" : "ready"})`, async () => {
    const h = remoteHarness();
    const run = startStructuredCli({ ...options(), execHost: h.host });
    if (before) { run.interrupt(); run.interrupt(); }
    h.resolve(h.handle);
    await new Promise(resolve => setImmediate(resolve));
    run.interrupt(); run.interrupt();
    assert.equal(h.interrupts(), 1);
    h.exit();
    await run.completion;
    run.interrupt();
    assert.equal(h.interrupts(), 1);
  });
}

test("synchronous host startup failure settles through the runner result", async () => {
  const run = startStructuredCli({ ...options(), execHost: {
    persistent: true, spawnStructured() { throw new Error("host is closed"); },
  } as unknown as StructuredExecHost });
  const result = await run.completion;
  assert.equal(result.spawnError?.code, "EDAEMON");
  assert.doesNotThrow(() => run.interrupt());
});

test("a completed pump ignores late remote output and cancellation", async () => {
  const h = remoteHarness();
  const run = startStructuredCli({ ...options(), execHost: h.host });
  h.resolve(h.handle);
  await new Promise(resolve => setImmediate(resolve));
  h.stdout("before\n"); h.exit();
  const result = await run.completion;
  h.stdout("late\n"); run.interrupt();
  assert.equal(result.state.result, "before");
  assert.equal(h.interrupts(), 0);
});

test("transport observation failure cannot authorize deleting a live CLI's files", async () => {
  const h = remoteHarness();
  const run = startStructuredCli({ ...options(), execHost: h.host });
  h.resolve(h.handle);
  await new Promise(resolve => setImmediate(resolve));
  let exited = false;
  void run.exited!.then(() => { exited = true; });
  h.exit({ exitCode: 1, signal: null, processExited: false });
  await run.completion;
  assert.equal(exited, false);
});

test("protocol failure completion is not a CLI process exit acknowledgement", async () => {
  const h = remoteHarness();
  const run = startStructuredCli({ ...options(), execHost: h.host,
    processLine() { throw new Error("broken protocol"); },
  });
  h.resolve(h.handle);
  await new Promise(resolve => setImmediate(resolve));
  let exited = false;
  void run.exited!.then(() => { exited = true; });
  h.stdout("bad\n");
  assert.match((await run.completion).primaryError ?? "", /broken protocol/);
  assert.equal(exited, false);
  assert.equal(h.interrupts(), 1);
  h.exit();
  await run.exited;
  assert.equal(exited, true);
});

test("local protocol stop and external cancellation share one idempotent stop", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 42,
    kill() { kills++; return true; },
  });
  let kills = 0;
  const run = startStructuredCli({ ...options(), spawnProcess: (() => child as unknown as ChildProcess) as typeof import("node:child_process").spawn,
    processLine(_line, ctx) { ctx.requestStop(); ctx.requestStop(); },
  });
  child.stdout.emit("data", Buffer.from("stop\n"));
  run.interrupt();
  assert.equal(kills, 1);
  child.emit("close", 0, null);
  await run.completion;
  run.interrupt();
  assert.equal(kills, 1);
});
