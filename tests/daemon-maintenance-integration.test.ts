import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DaemonAdmission, DaemonMaintenance } from "../src/daemon-maintenance.js";
import { countRunningDaemonEntries, createDaemonMaintenanceTargets, persistentDaemonTarget } from "../src/daemon-maintenance-targets.js";
import { connectExistingTerminalHost, type TerminalDaemonClient } from "../src/terminal-daemon-client.js";
import { TERMINAL_DAEMON_BUILD_ID } from "../src/terminal-daemon-build.js";

async function waitFor<T>(probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = await probe(); if (value !== null) return value;
    await delay(25);
  }
  throw new Error("Fixture did not become ready");
}

test("real terminald protects PTY + structured runs, then updates automatically and reuses the same client", { timeout: 25_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell fixture");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-auto-daemon-"));
  const configPath = path.join(root, "config.json");
  const children: ChildProcess[] = [];
  const launch = () => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "fixtures/terminal-daemon-entry.ts"), configPath],
      { stdio: "ignore", env: process.env });
    children.push(child); return child;
  };
  const original = launch();
  let client: TerminalDaemonClient | null = null;
  t.after(async () => {
    client?.disconnect();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  client = await waitFor(() => connectExistingTerminalHost(configPath));
  const stable = client;
  const hello = await stable.request("hello") as { pid: number; buildId: string; shutdownIfIdle: boolean };
  assert.equal(hello.buildId, TERMINAL_DAEMON_BUILD_ID);
  assert.equal(hello.shutdownIfIdle, true);
  // Recreating Server maintenance against the same current, idle daemon must
  // neither display an update nor enter the drain/restart path.
  for (let server = 0; server < 2; server++) {
    let drains = 0;
    const current = new DaemonMaintenance({
      targets: await createDaemonMaintenanceTargets(configPath, { host: stable, legacyHost: stable, renderHost: null }, null),
      admission: new DaemonAdmission(), busy: () => false, available: () => true, quietMs: 0,
      beginCoreDrain: () => { drains++; return () => {}; }, log: error => { throw error; },
    });
    try {
      await current.check(); await current.check();
      assert.deepEqual(current.status(), { pending: false, phase: "idle" });
      assert.equal(drains, 0);
      assert.equal((await stable.request("hello") as { pid: number }).pid, hello.pid);
    } finally { await current.stop(); }
  }
  const terminal = await stable.createOrAttach({ sessionId: "shell", file: "/bin/sh", args: [], cwd: root,
    env: { PATH: process.env.PATH ?? "" }, name: "xterm", cols: 80, rows: 24 });
  const run = await stable.spawnStructured({ runId: "cli", file: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 30000)"], cwd: root, env: { PATH: process.env.PATH ?? "" } });
  assert.deepEqual(await stable.request("shutdownIfIdle"), { accepted: false });
  process.kill(terminal.process.pid, 0); process.kill(run.pid, 0);

  let replacement: ChildProcess | null = null;
  const target = persistentDaemonTarget({ name: "terminald", checkpointPath: path.join(root, "update.json"),
    async snapshot() {
      const current = await stable.request("hello") as { pid: number };
      const [sessions, runs] = await Promise.all([stable.request("list"), stable.request("structuredList")]);
      return { pid: current.pid, identity: String(current.pid), pending: current.pid === hello.pid,
        running: countRunningDaemonEntries(sessions) + countRunningDaemonEntries(runs) };
    },
    async shutdown() {
      const result = await stable.request("shutdownIfIdle") as { accepted: boolean };
      return result.accepted;
    },
    async ensure() {
      replacement ??= launch();
      const temporary = await waitFor(() => connectExistingTerminalHost(configPath)); temporary.disconnect();
    },
    reconnect: () => stable.connect(),
  });
  const maintenance = new DaemonMaintenance({ targets: [target], admission: new DaemonAdmission(),
    busy: () => false, available: () => true, beginCoreDrain: () => () => {}, quietMs: 0,
    log: error => { throw error; } });
  t.after(() => maintenance.stop());
  await maintenance.check();
  assert.equal(original.exitCode, null); assert.equal(replacement, null);
  await terminal.process.writeConfirmed?.("exit\r");
  await waitFor(async () => countRunningDaemonEntries(await stable.request("list")) === 0 ? true : null);
  await maintenance.check(); assert.equal(replacement, null, "structured run also blocks PTY daemon updates");
  const runExited = new Promise<void>(resolve => run.onExit(() => resolve()));
  run.interrupt(); await runExited;
  maintenance.start();
  await waitFor(async () => maintenance.status().pending ? null : true);
  assert.deepEqual(maintenance.status(), { pending: false, phase: "idle" });
  assert.equal(original.exitCode, 0);
  const after = await stable.request("hello") as { pid: number };
  assert.notEqual(after.pid, hello.pid);
  const next = await stable.createOrAttach({ sessionId: "new-shell", file: "/bin/sh", args: ["-c", "printf updated"], cwd: root,
    env: { PATH: process.env.PATH ?? "" }, name: "xterm", cols: 80, rows: 24 });
  assert.ok(next.process.pid > 0, "original host reference accepts starts after replacement");
});

test("confirmed manual maintenance interrupts real terminald PTY and structured inventories and reopens admission", { timeout: 20_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell fixture");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-manual-daemon-"));
  const configPath = path.join(root, "config.json");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "fixtures/terminal-daemon-entry.ts"), configPath],
    { stdio: "ignore", env: process.env });
  let client: TerminalDaemonClient | null = null;
  t.after(async () => {
    client?.disconnect();
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; }
    rmSync(root, { recursive: true, force: true });
  });
  client = await waitFor(() => connectExistingTerminalHost(configPath));
  const stable = client;
  await stable.createOrAttach({ sessionId: "manual-shell", file: "/bin/sh", args: [], cwd: root,
    env: { PATH: process.env.PATH ?? "" }, name: "xterm", cols: 80, rows: 24 });
  await stable.spawnStructured({ runId: "manual-cli", file: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 30000)"], cwd: root, env: { PATH: process.env.PATH ?? "" } });
  const [target] = await createDaemonMaintenanceTargets(configPath, { host: stable, legacyHost: stable, renderHost: null }, null);
  const inspect = target.inspect;
  let pending = true, replacements = 0;
  // Exercise the production authenticated interrupt RPCs, using a simulated
  // version replacement so this test never touches installed daemons/binaries.
  target.inspect = async full => ({ ...await inspect(full), pending });
  target.restart = async () => {
    assert.equal(countRunningDaemonEntries(await stable.request("list")), 0);
    assert.equal(countRunningDaemonEntries(await stable.request("structuredList")), 0);
    replacements++; pending = false;
  };
  const admission = new DaemonAdmission();
  const worker = new DaemonMaintenance({ targets: [target], admission, busy: () => true,
    available: () => true, beginCoreDrain: () => () => {}, log: () => {} });
  t.after(() => worker.stop());
  await worker.check(); assert.equal(replacements, 0);
  assert.deepEqual(await worker.forceUpdate(), { pending: false, phase: "idle" });
  assert.equal(replacements, 1);
  assert.equal(child.exitCode, null, "interruption does not itself shut down the daemon");
  await admission.run(async () => {
    const next = await stable.createOrAttach({ sessionId: "after-manual", file: "/bin/sh", args: ["-c", "printf ready"], cwd: root,
      env: { PATH: process.env.PATH ?? "" }, name: "xterm", cols: 80, rows: 24 });
    assert.ok(next.process.pid > 0);
  });
});
