import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { CoreTurnTracker } from "../src/core-turn-tracker.js";
import { startIpcServer, type IpcServerDeps } from "../src/tui/ipc-server.js";
import type { IpcSnapshotData } from "../src/tui/ipc-protocol.js";

const source = fileURLToPath(new URL("../src/core-status-cli.ts", import.meta.url));
const startScript = readFileSync(new URL("../start.sh", import.meta.url), "utf8");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.ok(predicate(), "condition did not become true");
}

async function fixture(t: TestContext, deps: Partial<IpcServerDeps> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-guard-"));
  const config = path.join(root, "config.json");
  writeFileSync(config, JSON.stringify({ port: 1, https: false }));
  const handle = startIpcServer({ socketPath: path.join(root, "wand.sock"),
    snapshotProvider: () => ({} as IpcSnapshotData), ...deps });
  assert.ok(handle);
  t.after(async () => { await handle.close(); rmSync(root, { recursive: true, force: true }); });
  await eventually(() => existsSync(path.join(root, "wand.sock")));
  return { root, config, handle };
}

function run(config: string, args: string[] = []) {
  const child = spawn(process.execPath, [source, "-c", config, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); });
  child.stderr.on("data", (data) => { output += String(data); });
  const completion = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
  return { child, completion, output: () => output };
}

function stopCommand(marker: string): string[] {
  return ["--", process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'stopped')", marker];
}

function trackerStatus() {
  return { hasActiveTurns: CoreTurnTracker.hasActiveTurns(), activeTurnCount: CoreTurnTracker.getActiveTurnCount(),
    activeTurnIds: CoreTurnTracker.getActiveTurnIds() };
}

test("restart waits for both real-process turns, holding the barrier through the stop command", async (t) => {
  const first = CoreTurnTracker.startTurn("first");
  const second = CoreTurnTracker.startTurn("second");
  t.after(() => { CoreTurnTracker.endTurn(first); CoreTurnTracker.endTurn(second); });
  let draining = false;
  let releases = 0;
  const { root, config } = await fixture(t, { coreStatusProvider: trackerStatus,
    beginCoreDrain: () => { draining = true; return () => { draining = false; releases++; }; } });
  const marker = path.join(root, "stopped");
  const execution = run(config, stopCommand(marker));
  t.after(() => execution.child.kill());
  await eventually(() => draining);
  assert.equal(existsSync(marker), false);
  CoreTurnTracker.endTurn(first);
  await delay(1100);
  assert.equal(existsSync(marker), false, "one remaining turn still blocks service:stop");
  assert.equal(draining, true);
  CoreTurnTracker.endTurn(second);
  const result = await execution.completion;
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(marker, "utf8"), "stopped");
  await eventually(() => releases === 1);
});

test("a separate CLI sees busy while its own tracker is empty", async (t) => {
  const turn = CoreTurnTracker.startTurn("server-owned");
  t.after(() => CoreTurnTracker.endTurn(turn));
  const { config } = await fixture(t, { coreStatusProvider: trackerStatus });
  const result = await run(config, ["--status"]).completion;
  assert.equal(result.code, 1, result.output);
  const status = JSON.parse(result.output.trim());
  assert.equal(status.activeTurnCount, 1);
  assert.equal(status.status, "busy");
});

test("timeout cancels restart, releases admission and never runs stop", async (t) => {
  let draining = false;
  const { root, config } = await fixture(t, { coreStatusProvider: () => ({ hasActiveTurns: true, activeTurnCount: 2 }),
    beginCoreDrain: () => { draining = true; return () => { draining = false; }; } });
  const marker = path.join(root, "stopped");
  const result = await run(config, ["--timeout", "0.15", ...stopCommand(marker)]).completion;
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /超时.*未停止.*取消重启/);
  assert.equal(existsSync(marker), false);
  await eventually(() => !draining);
});

test("malformed Core status fails closed instead of being treated as idle", async (t) => {
  const { root, config } = await fixture(t, { coreStatusProvider: () => ({ hasActiveTurns: false, activeTurnCount: 3 }) });
  const marker = path.join(root, "stopped");
  const result = await run(config, stopCommand(marker)).completion;
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /状态响应无效/);
  assert.equal(existsSync(marker), false);
});

test("lost IPC while waiting does not run stop or silently switch to an idle fallback", async (t) => {
  let draining = false;
  const { root, config, handle } = await fixture(t, {
    coreStatusProvider: () => ({ hasActiveTurns: true, activeTurnCount: 1 }),
    beginCoreDrain: () => { draining = true; return () => {}; },
  });
  const marker = path.join(root, "stopped");
  const execution = run(config, stopCommand(marker));
  t.after(() => execution.child.kill());
  await eventually(() => draining);
  await handle.close();
  const result = await execution.completion;
  assert.equal(result.code, 2, result.output);
  assert.equal(existsSync(marker), false);
});

test("first upgrade reads the old server HTTP status rather than the broken installed CLI", async (t) => {
  const { root, config } = await fixture(t); // old IPC protocol: no core commands
  let count = 2;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ hasActiveTurns: count > 0, activeTurnCount: count }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(config, JSON.stringify({ port: address.port, https: false }));
  const marker = path.join(root, "stopped");
  const execution = run(config, stopCommand(marker));
  t.after(() => execution.child.kill());
  await eventually(() => execution.output().includes("2 个原生"));
  count = 1;
  await eventually(() => execution.output().includes("1 个原生"));
  assert.equal(existsSync(marker), false);
  count = 0;
  const result = await execution.completion;
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(marker), true);
});

test("only a confirmed stopped service may skip a refused listener, not a live PID", async (t) => {
  const { root, config, handle } = await fixture(t);
  await handle.close();
  const marker = path.join(root, "stopped");
  let result = await run(config, stopCommand(marker)).completion;
  assert.equal(result.code, 2, result.output);
  assert.equal(existsSync(marker), false);
  writeFileSync(path.join(root, "wand.pid"), JSON.stringify({ pid: process.pid }));
  result = await run(config, ["--allow-stopped", ...stopCommand(marker)]).completion;
  assert.equal(result.code, 2, result.output);
  assert.equal(existsSync(marker), false);
  rmSync(path.join(root, "wand.pid"));
  result = await run(config, ["--allow-stopped", ...stopCommand(marker)]).completion;
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(marker), true);
});

test("execution tokens prevent a cancelled turn from forgetting its replacement", () => {
  const first = CoreTurnTracker.startTurn("same-session");
  const replacement = CoreTurnTracker.startTurn("same-session");
  try {
    assert.equal(CoreTurnTracker.getActiveTurnCount(), 2);
    CoreTurnTracker.endTurn(first);
    CoreTurnTracker.endTurn(first);
    assert.equal(CoreTurnTracker.getActiveTurnCount(), 1);
    assert.deepEqual(CoreTurnTracker.getActiveTurnIds(), ["same-session"]);
  } finally { CoreTurnTracker.endTurn(first); CoreTurnTracker.endTurn(replacement); }
});

test("all restart paths share the pre-stop guard; a guard error never falls through to cleanup", () => {
  const stop = startScript.match(/stop_service_for_install\(\) \{[\s\S]*?\n\}/)?.[0];
  const ensure = startScript.match(/ensure_service_installed_and_running\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(stop && ensure);
  assert.match(ensure, /stop_service_for_install/);
  assert.doesNotMatch(ensure, /run_privileged.*service:stop/);
  assert.match(startScript, /restart-only\)\s+trap restore_stopped_service EXIT\s+ensure_service_installed_and_running/);
  assert.match(stop, /WAND_CORE_WAIT_TIMEOUT:-0/);
  for (const guardExit of [1, 2, 127, 130]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
NODE_BIN=node; NODE_FOR_WAND=node; WAND_BIN=/fake/wand; REPO_ROOT=/fake/repo
CONFIG_PATH=/fake/config.json; SCOPE=user; SCOPE_FLAG=--user; SERVICE_STOPPED_FOR_INSTALL=0
run_privileged() { printf 'guard: %s\n' "$*"; return ${guardExit}; }
service_confirmed_stopped() { return 0; }
cleanup_stale_wand() { echo 'UNSAFE CLEANUP'; }
warn() { echo "$*"; }; ok() { echo "$*"; }; die() { echo "$*" >&2; exit 1; }
${stop}
stop_service_for_install
`], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /core-status-cli\.ts.*-- service:stop|core-status-cli\.ts.*\/fake\/wand service:stop/);
    assert.doesNotMatch(result.stdout, /UNSAFE CLEANUP/);
  }
});

test("a server with status but without an admission barrier cannot authorize stop", async (t) => {
  const { root, config } = await fixture(t, { coreStatusProvider: () => ({ hasActiveTurns: false, activeTurnCount: 0 }) });
  const marker = path.join(root, "stopped");
  const result = await run(config, stopCommand(marker)).completion;
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /unknown cmd: core-drain/);
  assert.equal(existsSync(marker), false);
});

test("a missing legacy HTTP endpoint is an error, never evidence of no native turns", async (t) => {
  const { root, config } = await fixture(t);
  const server = createServer((_req, res) => { res.statusCode = 404; res.end("Not found"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(config, JSON.stringify({ port: address.port, https: false }));
  const marker = path.join(root, "stopped");
  const result = await run(config, stopCommand(marker)).completion;
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /HTTP 404/);
  assert.equal(existsSync(marker), false);
});

test("invalid timeouts reject before any stop command can run", async (t) => {
  const { root, config } = await fixture(t);
  const marker = path.join(root, "stopped");
  for (const value of ["-1", "NaN", "300seconds"]) {
    const result = await run(config, ["--timeout", value, ...stopCommand(marker)]).completion;
    assert.equal(result.code, 2, result.output);
    assert.equal(existsSync(marker), false);
  }
});

test("legacy HTTPS probing trusts the configured certificate and rejects a different peer", async (t) => {
  const { createServer: createHttpsServer } = await import("node:https");
  const { ensureCertificates } = await import("../src/cert.js");
  const { root, config } = await fixture(t);
  const ssl = ensureCertificates(path.join(root, "actual"));
  const wrong = ensureCertificates(path.join(root, "wrong"));
  const server = createHttpsServer({ cert: ssl.cert, key: ssl.key }, (_req, res) => {
    res.end(JSON.stringify({ hasActiveTurns: false, activeTurnCount: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(config, JSON.stringify({ port: address.port, https: true, tls: { certPath: ssl.certPath } }));
  let result = await run(config, ["--status"]).completion;
  assert.equal(result.code, 0, result.output);
  writeFileSync(config, JSON.stringify({ port: address.port, https: true, tls: { certPath: wrong.certPath } }));
  const marker = path.join(root, "stopped");
  result = await run(config, stopCommand(marker)).completion;
  assert.equal(result.code, 2, result.output);
  assert.equal(existsSync(marker), false);
});

test("the wait deadline includes the initial IPC handshake, not just busy polling", async (t) => {
  const { createServer: createNetServer } = await import("node:net");
  const { root, config, handle } = await fixture(t);
  await handle.close();
  const sockets = new Set<import("node:net").Socket>();
  const server = createNetServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(path.join(root, "wand.sock"), resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const marker = path.join(root, "stopped");
  const start = Date.now();
  const result = await run(config, ["--timeout", "0.1", ...stopCommand(marker)]).completion;
  assert.equal(result.code, 2, result.output);
  assert.ok(Date.now() - start < 2000, "an unresponsive IPC peer cannot extend a short deadline to five seconds");
  assert.equal(existsSync(marker), false);
});

test("cancelling the waiting CLI releases the barrier without stopping the service", async (t) => {
  let draining = false;
  const { root, config } = await fixture(t, {
    coreStatusProvider: () => ({ hasActiveTurns: true, activeTurnCount: 1 }),
    beginCoreDrain: () => { draining = true; return () => { draining = false; }; },
  });
  const marker = path.join(root, "stopped");
  const execution = run(config, stopCommand(marker));
  t.after(() => execution.child.kill());
  await eventually(() => draining);
  execution.child.kill("SIGINT");
  await execution.completion;
  await eventually(() => !draining);
  assert.equal(existsSync(marker), false);
});

test("a failed stop command releases admission and is distinguished from a failed guard", async (t) => {
  let draining = false;
  const { config } = await fixture(t, {
    coreStatusProvider: () => ({ hasActiveTurns: false, activeTurnCount: 0 }),
    beginCoreDrain: () => { draining = true; return () => { draining = false; }; },
  });
  const result = await run(config, ["--", process.execPath, "-e", "process.exit(2)"]).completion;
  assert.equal(result.code, 3, result.output);
  await eventually(() => !draining);
});

test("HTTP and auto restart wait before closing tools or arming a forced-exit timer", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const relaunch = server.slice(server.indexOf("function relaunchAfterShutdown()"), server.indexOf('app.post("/api/restart"'));
  assert.match(relaunch, /beginCoreRestartDrain\(\)/);
  const wait = relaunch.indexOf("while (structuredSessions.getCoreTurnStatus().hasActiveTurns)");
  assert.ok(wait > 0);
  assert.ok(wait < relaunch.indexOf("const forceExitTimer"));
  assert.ok(wait < relaunch.indexOf("await close()"));
  assert.doesNotMatch(relaunch.slice(0, wait), /dispose\(\)|process\.exit|await close\(\)/);
  assert.match(server.slice(server.indexOf("// Manual and automatic restarts share")), /setTimeout\(\(\) => relaunchAfterShutdown\(\), 1000\)/);
});

test("the running-service guard works in macOS Bash 3.2 under nounset without an optional flag", () => {
  const stop = startScript.match(/stop_service_for_install\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(stop);
  const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail
NODE_BIN=node; NODE_FOR_WAND=node; WAND_BIN=/fake/wand; REPO_ROOT=/fake/repo
CONFIG_PATH=/fake/config.json; SCOPE=user; SCOPE_FLAG=--user; SERVICE_STOPPED_FOR_INSTALL=0
STOPPED=0
run_privileged() { printf 'guard: %s\n' "$*"; STOPPED=1; }
service_confirmed_stopped() { [[ "$STOPPED" == 1 ]]; }
cleanup_stale_wand() { echo 'SAFE CLEANUP'; }
warn() { echo "$*"; }; ok() { echo "$*"; }; die() { echo "$*" >&2; exit 1; }
${stop}
stop_service_for_install
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /core-status-cli\.ts.*--timeout 0.*service:stop/);
  assert.doesNotMatch(result.stdout, /--allow-stopped/);
  assert.match(result.stdout, /SAFE CLEANUP/);
});
