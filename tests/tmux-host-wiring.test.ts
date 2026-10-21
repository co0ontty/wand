import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiTmuxHost } from "../src/pi-tmux-host.js";
import { DaemonAdmission } from "../src/daemon-maintenance.js";
import { structuredHostMaintenance } from "../src/structured-host-maintenance.js";
import { tmuxEnabled } from "../src/tmux-policy.js";
import type { StructuredExecHost, StructuredRunState } from "../src/structured-exec-host.js";

function host(): StructuredExecHost {
  return { persistent: true, piNativeTui: true,
    spawnStructured: async () => { throw new Error("not used"); },
    attachRun: async () => null, adoptRun: async () => null,
    listRuns: async () => [], forgetRun() {},
    collectGarbage: () => ({ removedSlots: 1, removedTurns: 2, freedBytes: 3 }),
  };
}

test("tmux defaults on in production and explicit required overrides test isolation", () => {
  assert.equal(tmuxEnabled({}), true);
  assert.equal(tmuxEnabled({ WAND_TEST_MODE: "1" }), false);
  assert.equal(tmuxEnabled({ NODE_TEST_CONTEXT: "child-v8" }), false);
  assert.equal(tmuxEnabled({ WAND_TEST_MODE: "1", WAND_TMUX_MODE: "required" }), true);
  assert.equal(tmuxEnabled({ WAND_TMUX_MODE: "off" }), false);
  assert.throws(() => tmuxEnabled({ WAND_TMUX_MODE: "auto" }), /required or off/);
});

test("disabling native Pi retains existing owner and blocks a duplicate non-native launch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-wiring-"));
  try {
    const runId = "structured:old-native";
    const slot = path.join(root, "pi-native", createHash("sha256").update(runId).digest("hex").slice(0, 24));
    const dir = path.join(slot, "turn-fixture");
    mkdirSync(dir, { recursive: true });
    const job = { runId, requestId: "request", incarnationId: "incarnation", tmux: "unused",
      state: path.join(dir, "state.json"), events: path.join(dir, "events.jsonl"),
      stderr: path.join(dir, "stderr.log"), ack: path.join(dir, "ack") };
    writeFileSync(path.join(slot, "current.json"), JSON.stringify(job));
    writeFileSync(job.state, JSON.stringify({ status: "running", pid: process.pid, exitCode: null, signal: null }));
    writeFileSync(job.events, "native events\n");
    writeFileSync(job.stderr, "");
    const native = new PiTmuxHost(root, host(), false);
    assert.equal(native.piNativeTui, false);
    assert.equal((await native.attachRun(runId))?.incarnationId, "incarnation");
    assert.equal((await native.listRuns()).length, 1);
    await assert.rejects(native.spawnStructured({ runId, file: "pi", args: [], cwd: root, env: {} }), /尚未释放/);
    let killed!: () => void;
    native.kill = () => new Promise<void>(resolve => { killed = resolve; });
    native.forgetRun(runId);
    assert.equal(existsSync(job.ack), false, "forget cannot acknowledge an unconfirmed stop");
    assert.equal((await native.attachRun(runId))?.incarnationId, "incarnation");
    writeFileSync(job.state, JSON.stringify({ status: "exited", pid: process.pid, exitCode: 0, signal: null }));
    killed();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(existsSync(job.ack), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt native ownership never falls through to a new CLI launch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-corrupt-"));
  try {
    const runId = "structured:corrupt";
    const slot = path.join(root, "pi-native", createHash("sha256").update(runId).digest("hex").slice(0, 24));
    mkdirSync(slot, { recursive: true });
    writeFileSync(path.join(slot, "current.json"), "{broken");
    const native = new PiTmuxHost(root, host(), false);
    await assert.rejects(native.attachRun(runId), SyntaxError);
    await assert.rejects(native.spawnStructured({ runId, file: "pi", args: [], cwd: root, env: {} }), SyntaxError);
    await assert.rejects(native.listRuns(), SyntaxError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native observation failure still reports the subsequent actual process exit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-observation-"));
  try {
    const runId = "structured:observe";
    const slot = path.join(root, "pi-native", createHash("sha256").update(runId).digest("hex").slice(0, 24));
    mkdirSync(slot, { recursive: true });
    const job = { runId, incarnationId: "original", state: path.join(slot, "state.json"),
      events: path.join(slot, "events.jsonl"), stderr: path.join(slot, "stderr.log"), ack: path.join(slot, "ack") };
    writeFileSync(path.join(slot, "current.json"), JSON.stringify(job));
    writeFileSync(job.state, JSON.stringify({ status: "running", pid: process.pid }));
    writeFileSync(job.events, ""); writeFileSync(job.stderr, "");
    const native = new PiTmuxHost(root, host(), false);
    native.kill = async () => {};
    const handle = (await native.adoptRun(runId))!;
    rmSync(job.events);
    const events: boolean[] = [];
    const subscription = handle.onExit(event => events.push(event.processExited !== false));
    try {
      const wait = async (count: number) => {
        const deadline = Date.now() + 3000;
        while (events.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(events.length, count);
      };
      await wait(1);
      assert.deepEqual(events, [false]);
      writeFileSync(job.state, JSON.stringify({ status: "exited", pid: process.pid, exitCode: 0, signal: null }));
      await wait(2);
      assert.deepEqual(events, [false, true]);
    } finally { subscription.dispose(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("admission preserves native Pi capability and garbage collection", () => {
  const wrapped = new DaemonAdmission().structured(host());
  assert.equal(wrapped.piNativeTui, true);
  assert.deepEqual(wrapped.collectGarbage?.({ liveSessionIds: new Set(), retentionMs: 0 }),
    { removedSlots: 1, removedTurns: 2, freedBytes: 3 });
});

test("maintenance counts independent structured owners and fails closed on inventory errors", async () => {
  const original = host();
  original.listRuns = async () => [
    { runId: "running", status: "running" }, { runId: "done", status: "exited" },
  ] as StructuredRunState[];
  const target = structuredHostMaintenance(original);
  assert.equal((await target.inspect()).running, 1);
  assert.equal((await target.inspect(false)).running, null);
  original.listRuns = async () => { throw new Error("unknown owner"); };
  await assert.rejects(target.inspect(), /unknown owner/);
});

test("maintenance refuses to interrupt a different execution generation", async () => {
  const original = host();
  original.listRuns = async () => [{ runId: "run", incarnationId: "old", status: "running" }] as StructuredRunState[];
  let interrupted = false;
  original.adoptRun = async () => ({ runId: "run", incarnationId: "new", pid: 1,
    interrupt: () => { interrupted = true; },
    onStream: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  });
  const target = structuredHostMaintenance(original);
  await assert.rejects(target.interrupt!({ identity: "structured-executions", pending: false, running: 1 }), /ownership changed/);
  assert.equal(interrupted, false);
});
