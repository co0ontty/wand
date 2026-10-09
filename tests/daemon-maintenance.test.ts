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
