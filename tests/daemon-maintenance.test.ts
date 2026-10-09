import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readRenderBinaryVersion } from "../src/render-binary.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonAdmission, DaemonMaintenance, type DaemonInspection, type DaemonMaintenanceTarget } from "../src/daemon-maintenance.js";
import { countRunningDaemonEntries, persistentDaemonTarget } from "../src/daemon-maintenance-targets.js";
import { daemonMaintenanceMessage } from "../src/daemon-maintenance-state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let now = 0, busy = false, available = true, drains = 0, releases = 0;
  const errors: unknown[] = [];
  const snapshots: DaemonInspection[] = [
    { identity: "render", pending: true, running: 0 },
    { identity: "terminald", pending: true, running: 0 },
    { identity: "structured", pending: false, running: 0 },
  ];
  const restarted: number[] = [];
  const targets: DaemonMaintenanceTarget[] = snapshots.map((_, i) => ({
    name: String(i), inspect: async () => ({ ...snapshots[i] }),
    restart: async () => { restarted.push(i); snapshots[i].pending = false; },
  }));
  const admission = new DaemonAdmission();
  const maintenance = new DaemonMaintenance({ targets, admission, busy: () => busy, available: () => available,
    beginCoreDrain: () => { drains++; return () => { releases++; }; }, log: error => errors.push(error), now: () => now, quietMs: 10 });
  return { maintenance, snapshots, targets, admission, restarted, errors, advance: () => { now += 10; },
    busy: (value: boolean) => { busy = value; }, available: (value: boolean) => { available = value; },
    drainCounts: () => [drains, releases] };
}

test("automatic update waits for all owners, live idle shells, Core and queued/finalizing work", async () => {
  const h = harness();
  for (let owner = 0; owner < h.snapshots.length; owner++) {
    h.snapshots[owner].running = 1;
    await h.maintenance.check(); h.advance(); await h.maintenance.check();
    assert.deepEqual(h.restarted, []);
    assert.deepEqual(h.maintenance.status(), { pending: true, phase: "waiting" });
    h.snapshots[owner].running = 0;
  }
  h.busy(true); await h.maintenance.check(); h.advance(); await h.maintenance.check();
  assert.deepEqual(h.restarted, []);
  h.busy(false); await h.maintenance.check();
  assert.deepEqual(h.restarted, [], "requires a fresh quiet window");
  h.advance(); await h.maintenance.check();
  assert.deepEqual(h.restarted, [0, 1]);
  assert.deepEqual(h.maintenance.status(), { pending: false, phase: "idle" });
  assert.deepEqual(h.drainCounts(), [1, 1]);
});

test("unchanged components remain silent across repeated checks and Server restarts", async () => {
  for (let server = 0; server < 2; server++) {
    const h = harness();
    for (const snapshot of h.snapshots) snapshot.pending = false;
    for (let poll = 0; poll < 3; poll++) {
      await h.maintenance.check(); h.advance();
      assert.deepEqual(h.maintenance.status(), { pending: false, phase: "idle" });
      assert.equal(daemonMaintenanceMessage(h.maintenance.status()), "");
    }
    assert.deepEqual(h.restarted, []);
    assert.deepEqual(h.drainCounts(), [0, 0]);
  }
});

test("one updated component does not restart any unchanged owners", async () => {
  const h = harness();
  h.snapshots[0].pending = false;
  await h.maintenance.check(); h.advance(); await h.maintenance.check();
  assert.deepEqual(h.restarted, [1]);
  assert.deepEqual(h.maintenance.status(), { pending: false, phase: "idle" });
});

test("unknown inventories prevent restart, preserve pending notice and retry later", async () => {
  const h = harness();
  const inspect = h.targets[2].inspect;
  h.targets[2].inspect = async () => { throw new Error("disconnected"); };
  await h.maintenance.check(); h.advance(); await h.maintenance.check();
  assert.deepEqual(h.restarted, []);
  assert.equal(h.maintenance.status().phase, "retrying");
  h.targets[2].inspect = inspect;
  await h.maintenance.check(); h.advance(); await h.maintenance.check();
  assert.deepEqual(h.restarted, [0, 1]);
});

test("busy owners only need version probes; omitted inventories never count as idle", async () => {
  const h = harness(); const modes: boolean[] = [];
  h.targets[0].inspect = async (full = true) => { modes.push(full); return { ...h.snapshots[0], running: null }; };
  h.busy(true); await h.maintenance.check();
  assert.deepEqual(modes, [false]);
  h.busy(false); h.advance(); await h.maintenance.check(); h.advance(); await h.maintenance.check();
  assert.deepEqual(h.restarted, []);
  assert.deepEqual(modes, [false, true, true]);
});

test("the idle check is repeated under admission and a newly arrived run cancels replacement", async () => {
  const h = harness();
  await h.maintenance.check(); h.advance();
  let probes = 0;
  h.targets[1].inspect = async () => ({ ...h.snapshots[1], running: ++probes === 2 ? 1 : 0 });
  await h.maintenance.check();
  assert.deepEqual(h.restarted, []);
  assert.deepEqual(h.drainCounts(), [1, 1]);
});

test("admission waits for in-flight starts, queues later starts once, and reopens on failure", async () => {
  const gate = new DaemonAdmission();
  const starting = deferred(), updating = deferred();
  const order: string[] = [];
  const first = gate.run(async () => { order.push("start"); await starting.promise; order.push("started"); });
  const update = gate.exclusive(async () => { order.push("update"); await updating.promise; throw new Error("retry"); });
  const caught = update.catch(() => { order.push("failed"); });
  const second = gate.run(async () => { order.push("next"); });
  await Promise.resolve(); assert.deepEqual(order, ["start"]);
  starting.resolve(); await first; await Promise.resolve();
  assert.deepEqual(order, ["start", "started", "update"]);
  updating.resolve(); await Promise.all([caught, second]);
  assert.equal(order.filter(x => x === "next").length, 1);
  assert.ok(order.indexOf("next") > order.indexOf("update"));
});

test("checks are single-flight; errors release Core drain and do not claim success", async () => {
  const h = harness(); await h.maintenance.check(); h.advance();
  const waiting = deferred();
  h.targets[0].restart = async () => { await waiting.promise; throw new Error("replacement unavailable"); };
  const one = h.maintenance.check(), two = h.maintenance.check();
  assert.equal(one, two);
  waiting.resolve(); await one;
  assert.deepEqual(h.maintenance.status(), { pending: true, phase: "retrying" });
  assert.deepEqual(h.drainCounts(), [1, 1]);
  await h.admission.run(async () => {});
});

test("shutdown or an installation cancels late maintenance", async () => {
  const h = harness(); await h.maintenance.check(); h.advance();
  h.available(false); await h.maintenance.check();
  assert.deepEqual(h.restarted, []);
  h.available(true); await h.maintenance.stop(); await h.maintenance.check();
  assert.deepEqual(h.restarted, []);
  const next = harness(); const waiting = deferred();
  next.targets[0].inspect = async () => { await waiting.promise; return next.snapshots[0]; };
  const check = next.maintenance.check(); const stop = next.maintenance.stop();
  waiting.resolve(); await Promise.all([check, stop]);
  assert.deepEqual(next.restarted, []);
});

test("only explicit daemon running/exited states are trusted, not retained-record counts", () => {
  assert.equal(countRunningDaemonEntries([{ status: "exited" }, { status: "running" }]), 1);
  assert.equal(countRunningDaemonEntries([{ status: "exited" }]), 0);
  for (const invalid of [undefined, {}, { ok: true }, [null], [{ status: "idle" }]]) {
    assert.throws(() => countRunningDaemonEntries(invalid));
  }
});

test("an ambiguous shutdown is never sent twice, even after worker recreation", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-daemon-checkpoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpointPath = path.join(root, "intent.json");
  const snapshot = { pid: process.pid, identity: "incarnation-not-a-secret", pending: true, running: 0 };
  let calls = 0;
  const make = () => persistentDaemonTarget({ name: "test", checkpointPath, snapshot: async () => snapshot,
    shutdown: async () => { calls++; throw new Error("lost ack"); }, ensure: async () => {}, reconnect: async () => {} });
  await assert.rejects(make().restart(snapshot), /lost ack/);
  assert.equal(JSON.parse(readFileSync(checkpointPath, "utf8")).pid, process.pid);
  await assert.rejects(make().restart(snapshot), /still draining/);
  assert.equal(calls, 1, "a second drain could force-kill a Render session");
});

test("explicit busy refusal can retry, unlike unknown delivery", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-daemon-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = { pid: process.pid, identity: "owner", pending: true, running: 0 };
  let calls = 0;
  const target = persistentDaemonTarget({ name: "test", checkpointPath: path.join(root, "intent.json"),
    snapshot: async () => snapshot, shutdown: async () => { calls++; return false; }, ensure: async () => {}, reconnect: async () => {} });
  await assert.rejects(target.restart(snapshot), /became busy/);
  await assert.rejects(target.restart(snapshot), /became busy/);
  assert.equal(calls, 2);
});

test("separately released structured Render reads its own version, not the PTY sibling", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-daemon-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "wand-render.version"), "0.1.3");
  const structured = path.join(root, "wand-structured-renderd");
  writeFileSync(`${structured}.version`, "0.2.0");
  assert.equal(await readRenderBinaryVersion(path.join(root, "wand-render")), "0.1.3");
  assert.equal(await readRenderBinaryVersion(structured, `${structured}.version`), "0.2.0");
});

test("user-facing notices are quiet, truthful and never request a manual restart", () => {
  assert.equal(daemonMaintenanceMessage({ pending: false, phase: "idle" }), "");
  for (const phase of ["waiting", "updating", "retrying"] as const) {
    const text = daemonMaintenanceMessage({ pending: true, phase });
    assert.match(text, /自动/); assert.match(text, /无需操作/);
    assert.doesNotMatch(text, /restart-daemons|手动|立即|警告|部分功能|暂时异常|恢复正常/);
  }
  assert.match(daemonMaintenanceMessage({ pending: true, phase: "waiting" }), /等待执行与队列结束/);
});

test("manual update interrupts live owners once, retains queued-work barriers and only replaces pending components", async () => {
  const h = harness();
  h.busy(true); // accepted queued input remains busy after current executions stop
  h.snapshots[0].running = 1;
  h.snapshots[2].running = 1; // unchanged component also holds an execution
  const interrupted: number[] = [];
  const stopping = deferred();
  for (const [i, target] of h.targets.entries()) target.interrupt = async () => {
    interrupted.push(i); await stopping.promise; h.snapshots[i].running = 0;
  };
  const first = h.maintenance.forceUpdate();
  assert.equal(first, h.maintenance.forceUpdate(), "double submission is single-flight");
  await Promise.resolve(); await Promise.resolve();
  let admitted = false;
  const next = h.admission.run(async () => { admitted = true; });
  assert.equal(admitted, false);
  stopping.resolve();
  assert.deepEqual(await first, { pending: false, phase: "idle" });
  await next;
  assert.equal(admitted, true);
  assert.deepEqual(interrupted, [0, 1, 2]);
  assert.deepEqual(h.restarted, [0, 1]);
  assert.deepEqual(h.drainCounts(), [1, 1]);
});

test("manual update is a no-op without new components and refuses unavailable or unknown inventories", async () => {
  const h = harness();
  h.snapshots.forEach(snapshot => { snapshot.pending = false; });
  let stops = 0;
  h.targets[0].interrupt = async () => { stops++; };
  assert.deepEqual(await h.maintenance.forceUpdate(), { pending: false, phase: "idle" });
  assert.equal(stops, 0);
  h.available(false);
  await assert.rejects(h.maintenance.forceUpdate(), /当前无法更新/);
  h.available(true); h.snapshots[0].pending = true;
  h.targets[1].inspect = async () => { throw new Error("unknown inventory"); };
  await assert.rejects(h.maintenance.forceUpdate(), /unknown inventory/);
  assert.equal(stops, 0);
  assert.deepEqual(h.restarted, []);
});

test("failed manual update releases admission, preserves retry state and never auto-interrupts on polling", async () => {
  const h = harness();
  let calls = 0;
  h.targets[0].interrupt = async () => { calls++; throw new Error("lost interrupt ack"); };
  await assert.rejects(h.maintenance.forceUpdate(), /lost interrupt ack/);
  assert.deepEqual(h.maintenance.status(), { pending: true, phase: "retrying" });
  assert.deepEqual(h.drainCounts(), [1, 1]);
  await h.admission.run(async () => {});
  h.busy(true); await h.maintenance.check();
  assert.equal(calls, 1);
  assert.deepEqual(h.restarted, []);
});

test("manual failures await all interruption receipts before reopening admission; missing inventories never stop work", async () => {
  const h = harness();
  h.snapshots[0].running = null;
  let stops = 0;
  h.targets[0].interrupt = async () => { stops++; };
  await assert.rejects(h.maintenance.forceUpdate(), /执行清单不可用/);
  assert.equal(stops, 0);
  assert.equal(h.maintenance.status().phase, "retrying");
  h.snapshots[0].running = 0;
  const late = deferred();
  h.targets[0].interrupt = async () => { throw new Error("lost ack"); };
  h.targets[1].interrupt = async () => { await late.promise; };
  const updating = h.maintenance.forceUpdate();
  await Promise.resolve(); await Promise.resolve();
  let admitted = false;
  const start = h.admission.run(async () => { admitted = true; });
  await Promise.resolve(); assert.equal(admitted, false);
  late.resolve();
  await assert.rejects(updating, /lost ack/); await start;
  assert.equal(admitted, true);
});

test("manual interruption refuses a changed authenticated daemon owner", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-manual-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const target = persistentDaemonTarget({ name: "test", checkpointPath: path.join(root, "update.json"),
    snapshot: async () => ({ pid: process.pid, identity: "replacement", pending: true, running: 1 }),
    interrupt: async () => { calls++; }, shutdown: async () => {}, ensure: async () => {}, reconnect: async () => {} });
  await assert.rejects(target.interrupt!({ identity: "original", pending: true, running: 1 }), /owner changed/);
  assert.equal(calls, 0);
});
