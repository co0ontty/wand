import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { StructuredTmuxHost } from "../src/structured-tmux-host.js";
import type { StructuredExecHost, StructuredExecProcess, StructuredRunState, StructuredSpawnRequest, StructuredStreamEvent, StructuredExitEvent } from "../src/structured-exec-host.js";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(25); }
  throw new Error(`timeout waiting for ${label}`);
};

class EmptyLegacy implements StructuredExecHost {
  readonly persistent = true;
  async spawnStructured(): Promise<StructuredExecProcess> { throw new Error("unexpected legacy spawn"); }
  async attachRun(): Promise<StructuredRunState | null> { return null; }
  async adoptRun(): Promise<StructuredExecProcess | null> { return null; }
  async listRuns(): Promise<StructuredRunState[]> { return []; }
  forgetRun(): void {}
}

function fixture(root: string, runId: string, requestId: string, script: string, stdinData?: string): StructuredSpawnRequest {
  return { runId, requestId, file: process.execPath, args: ["-e", script], cwd: root, env: process.env,
    ...(stdinData !== undefined ? { stdinData } : {}) };
}

async function finish(process: StructuredExecProcess): Promise<{ stdout: string; stderr: string; exit: StructuredExitEvent | null }> {
  let stdout = ""; let stderr = ""; let exit: StructuredExitEvent | null = null;
  process.onStream((event: StructuredStreamEvent) => { if (event.stream === "stdout") stdout += event.data; else stderr += event.data; });
  await new Promise<void>((resolve) => process.onExit((event) => { exit = event; resolve(); }));
  return { stdout, stderr, exit };
}

test("invalid structured process IDs never reach group signalling", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-invalid-pid-"));
  try {
    const host = new StructuredTmuxHost(root, new EmptyLegacy(), true);
    host.state = () => ({ status: "running", pid: -1, workerPid: process.pid, exitCode: null, signal: null });
    await assert.rejects(host.kill({ incarnationId: "invalid" } as Parameters<typeof host.kill>[0]), /process identity is unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("structured tmux host retires exited runs and preserves completion through recovery", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-tmux-test-"));
  const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
  t.after(async () => {
    try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* isolated socket already gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  const host = new StructuredTmuxHost(root, new EmptyLegacy());
  const request = fixture(root, "structured:recovery", "turn-1", "process.stdout.write('alpha'); setTimeout(() => process.stdout.write('omega'), 250); setTimeout(() => process.exit(0), 350);");
  const handle = await host.spawnStructured(request);
  let live = "";
  const first = finish(handle);
  const recovery = new StructuredTmuxHost(root, new EmptyLegacy());
  const listed = await recovery.listRuns();
  assert.equal(listed.length, 1);
  const attached = await recovery.attachRun(request.runId);
  assert.ok(attached);
  assert.equal(attached!.incarnationId, handle.incarnationId);
  assert.equal(attached!.stdoutSeq >= 0, true);
  const adopted = await recovery.adoptRun(request.runId);
  assert.ok(adopted);
  adopted!.onStream((event) => { if (event.stream === "stdout") live += event.data; });
  const result = await first;
  await waitFor(() => live.includes("omega"), "post-adoption output");
  assert.equal(result.exit?.exitCode, 0);
  assert.ok(live === "alphaomega" || live === "omega", `unexpected recovery stream ${JSON.stringify(live)}`);
  assert.equal((await host.listRuns())[0]?.status, "exited");
  const slot = path.join(root, "structured-tmux", createHash("sha256").update(request.runId).digest("hex").slice(0, 24));
  const currentPath = path.join(slot, "current.json");
  const current = JSON.parse(readFileSync(currentPath, "utf8")) as { ack: string };
  host.forgetRun(request.runId);
  await waitFor(() => existsSync(current.ack), "forget acknowledgement");
  assert.ok(existsSync(currentPath));
  const next = await host.spawnStructured(fixture(root, request.runId, "turn-2", "process.stdout.write('second');"));
  const second = await finish(next);
  assert.equal(second.exit?.exitCode, 0);
  assert.equal(second.stdout, "second");
});

test("concurrent identical structured tmux starts share one delivery", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-tmux-race-"));
  const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
  t.after(async () => {
    try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* isolated socket already gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  const host = new StructuredTmuxHost(root, new EmptyLegacy());
  const request = fixture(root, "structured:race", "same-request", "require('fs').appendFileSync(process.env.RACE_FILE, 'x'); setTimeout(() => process.exit(0), 100);" );
  request.env = { ...process.env, RACE_FILE: path.join(root, "deliveries") };
  const [first, second] = await Promise.all([host.spawnStructured(request), host.spawnStructured(request)]);
  assert.equal(first.incarnationId, second.incarnationId);
  const output = await finish(first);
  assert.equal(output.exit?.exitCode, 0);
  assert.equal(readFileSync(path.join(root, "deliveries"), "utf8"), "x");
  host.forgetRun(request.runId);
});

for (const enabled of [true, false]) {
  test(`recovery preserves attach watermarks and ownership with tmux enabled=${enabled}`, { timeout: 30_000 }, async (t) => {
    if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-st-watermark-"));
    const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
    const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
    t.after(async () => {
      try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* test owner already exited */ }
      rmSync(root, { recursive: true, force: true });
    });
    const host = new StructuredTmuxHost(root, new EmptyLegacy());
    const request = fixture(root, "structured:watermark", "one", "process.stdout.write('before'); const t=setInterval(()=>{if(require('fs').existsSync('release')){clearInterval(t);process.stdout.write('between');}},10);");
    const handle = await host.spawnStructured(request);
    const completed = finish(handle);
    const recovery = new StructuredTmuxHost(root, new EmptyLegacy(), enabled);
    let attached = await recovery.attachRun(request.runId);
    while (!attached?.stdoutLog.includes("before")) { await delay(25); attached = await recovery.attachRun(request.runId); }
    assert.equal((await recovery.listRuns()).length, 1);
    await assert.rejects(recovery.spawnStructured({ ...request, requestId: "different" }), /already owned/);
    writeFileSync(path.join(root, "release"), "go");
    await completed;
    const adopted = await recovery.adoptRun(request.runId);
    assert.ok(adopted);
    assert.equal((await finish(adopted)).stdout, "between", "output emitted after attach and before adopt must not disappear");
    const slot = path.join(root, "structured-tmux", createHash("sha256").update(request.runId).digest("hex").slice(0, 24));
    writeFileSync(path.join(slot, "current.json"), "{broken");
    await assert.rejects(recovery.listRuns());
    await assert.rejects(recovery.spawnStructured({ ...request, requestId: "new" }));
  });
}

test("snapshot UTF-8 boundaries and truncated replay resume without duplication", { timeout: 30_000 }, async (t) => {
  if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-st-utf8-"));
  const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
  t.after(async () => {
    try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* test owner already exited */ }
    rmSync(root, { recursive: true, force: true });
  });
  const host = new StructuredTmuxHost(root, new EmptyLegacy());
  const handle = await host.spawnStructured(fixture(root, "structured:utf8", "utf8", `
    process.stdout.write(Buffer.alloc(9*1024*1024, 97));
    process.stdout.write(Buffer.from([0xe4]));
    const timer=setInterval(()=>{if(require('fs').existsSync('release')) {
      clearInterval(timer); process.stdout.end(Buffer.from([0xb8,0xad]));
    }},10);
  `));
  let snapshot = await host.attachRun(handle.runId);
  while (!snapshot || snapshot.stdoutSeq < 9 * 1024 * 1024) { await delay(25); snapshot = await host.attachRun(handle.runId); }
  assert.equal(snapshot.stdoutTruncated, true);
  assert.equal(snapshot.stdoutLog.includes("�"), false);
  writeFileSync(path.join(root, "release"), "go");
  const adopted = await host.adoptRun(handle.runId);
  assert.ok(adopted);
  assert.equal((await finish(adopted)).stdout, "中");
});

test("worker spawn and log failures settle without orphaning the child", { timeout: 30_000 }, async (t) => {
  if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-st-failure-"));
  const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
  t.after(async () => {
    try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* test owner already exited */ }
    rmSync(root, { recursive: true, force: true });
  });
  const host = new StructuredTmuxHost(root, new EmptyLegacy());
  const missing = await host.spawnStructured({ ...fixture(root, "structured:missing", "missing", ""), file: path.join(root, "nonexistent") });
  assert.equal((await finish(missing)).exit?.exitCode, 1);
  const handle = await host.spawnStructured(fixture(root, "structured:limit", "limit", `
    const timer=setInterval(()=>{if(require('fs').existsSync('release')) {
      clearInterval(timer); const bytes=Buffer.alloc(1024*1024, 97);
      const write=()=>{while(process.stdout.write(bytes)){};}; process.stdout.on('drain',write); write();
    }},10);
  `));
  const pid = handle.pid;
  writeFileSync(path.join(root, "release"), "go");
  const result = await finish(handle);
  assert.equal(result.exit?.exitCode, 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("detached supervisor reaps the CLI after worker SIGKILL without replaying input", { timeout: 30_000 }, async (t) => {
  if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-st-worker-kill-"));
  const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
  t.after(async () => {
    try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* isolated owner gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  const host = new StructuredTmuxHost(root, new EmptyLegacy());
  const handle = await host.spawnStructured(fixture(root, "structured:worker-kill", "once", `
    require('fs').appendFileSync('deliveries','x');
    process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
  `));
  await waitFor(() => existsSync(path.join(root, "deliveries")), "CLI ready");
  const pid = handle.pid;
  const slot = path.join(root, "structured-tmux", createHash("sha256").update(handle.runId).digest("hex").slice(0, 24));
  const job = JSON.parse(readFileSync(path.join(slot, "current.json"), "utf8"));
  const state = JSON.parse(readFileSync(job.state, "utf8"));
  const ended = finish(handle);
  process.kill(state.workerPid, "SIGKILL");
  assert.equal((await ended).exit?.exitCode, 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const recovered = new StructuredTmuxHost(root, new EmptyLegacy(), false);
  assert.equal((await recovered.listRuns())[0]?.status, "exited");
  assert.equal(readFileSync(path.join(root, "deliveries"), "utf8"), "x");
  recovered.forgetRun(handle.runId);
  await waitFor(() => existsSync(job.ack), "confirmed forget after worker loss");
});

for (const loseWorker of [false, true]) {
  test(`supervisor retires surviving process-group descendants (worker loss=${loseWorker})`, { timeout: 30_000 }, async (t) => {
    if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-st-descendant-"));
    const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
    const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
    t.after(async () => {
      try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* isolated owner gone */ }
      rmSync(root, { recursive: true, force: true });
    });
    const host = new StructuredTmuxHost(root, new EmptyLegacy());
    const grandchildScript = "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('descendant',String(process.pid)); setInterval(()=>{},1000);";
    const handle = await host.spawnStructured(fixture(root, "structured:descendant", "one", `
      require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:'inherit'});
      const timer=setInterval(()=>{if(require('fs').existsSync('release'))process.exit(0)},10);
    `));
    await waitFor(() => existsSync(path.join(root, "descendant")), "descendant ready");
    const descendant = Number(readFileSync(path.join(root, "descendant"), "utf8"));
    const ended = finish(handle);
    if (loseWorker) {
      const slot = path.join(root, "structured-tmux", createHash("sha256").update(handle.runId).digest("hex").slice(0, 24));
      const job = JSON.parse(readFileSync(path.join(slot, "current.json"), "utf8"));
      process.kill(JSON.parse(readFileSync(job.state, "utf8")).workerPid, "SIGKILL");
    } else writeFileSync(path.join(root, "release"), "go");
    const result = await ended;
    assert.notEqual(result.exit?.processExited, false);
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    assert.equal((await host.listRuns())[0]?.status, "exited");
  });
}

test("structured tmux interrupt confirms real child exit", { timeout: 30_000 }, async (t) => {
  if (spawnSync("tmux", ["-V"]).status !== 0) { t.skip("tmux unavailable"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-st-stop-"));
  const suffix = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  const socket = path.join(os.tmpdir(), `wand-st-${process.getuid?.() ?? 0}-${suffix}.sock`);
  t.after(async () => {
    try { await exec("tmux", ["-S", socket, "kill-server"]); } catch { /* test owner already exited */ }
    rmSync(root, { recursive: true, force: true });
  });
  const host = new StructuredTmuxHost(root, new EmptyLegacy());
  const handle = await host.spawnStructured(fixture(root, "structured:stop", "stop", "setInterval(()=>{},1000)"));
  const pid = handle.pid;
  const ended = finish(handle);
  handle.interrupt();
  assert.notEqual((await ended).exit?.processExited, false);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await host.attachRun(handle.runId))?.status, "exited");
});
