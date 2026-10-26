import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runTestProcess } from "./helpers/test-process.js";

test("test subprocesses preserve success and bounded failure diagnostics", async () => {
  assert.equal(await runTestProcess({ args: ["-e", "console.log('fixture complete')"], timeoutMs: 2_000 }), "fixture complete\n");
  await assert.rejects(runTestProcess({
    args: ["-e", "process.stderr.write('x'.repeat(10000)+'END');process.exitCode=7"], timeoutMs: 2_000, outputLimit: 32,
  }), (error: unknown) => error instanceof Error && error.message.includes("exited with 7")
    && error.message.endsWith("END") && error.message.length < 100);
});

test("aborting a test reaps its stubborn child group and preserves buffered output", { skip: process.platform === "win32", timeout: 6_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-test-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "pids.json");
  const controller = new AbortController();
  const source = `
    const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));
    console.log('fixture ready');setInterval(()=>{},1000);
  `;
  const running = runTestProcess({ args: ["-e", source, marker], timeoutMs: 3_000, graceMs: 150, signal: controller.signal });
  let finished = false;
  const settled = running.then(() => { finished = true; return null; }, error => { finished = true; return error; });
  let error: unknown;
  try {
    const readyDeadline = Date.now() + 2_000;
    while (!existsSync(marker) && !finished && Date.now() < readyDeadline) await delay(10);
    assert.ok(existsSync(marker), "owned fixture publishes its child ids before cancellation");
    await delay(60);
  } finally {
    controller.abort(new Error("fixture cancellation"));
    error = await settled;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /Test process cancelled[\s\S]*fixture ready/);
  const pids = JSON.parse(readFileSync(marker, "utf8")) as number[];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 2_000;
  while (pids.some(alive) && Date.now() < deadline) await delay(20);
  assert.ok(pids.every(pid => !alive(pid)), "neither the harness nor its ignored-stdio descendant survives");
});

test("a child that never closes fails within its own deadline", async () => {
  const start = Date.now();
  await assert.rejects(runTestProcess({ args: ["-e", "console.log('pending');setInterval(()=>{},1000)"],
    timeoutMs: 150, graceMs: 100 }), /exceeded 150ms[\s\S]*pending/);
  assert.ok(Date.now() - start < 2_000);
});

test("leader exit starts descendant cleanup before inherited output pipes close", {
  skip: process.platform === "win32", timeout: 5_000,
}, async (t) => {
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{console.error('descendant cleanup');process.exit(0)});console.log('descendant ready');setInterval(()=>{},1000)"],
      {stdio:['ignore','pipe',2]});
    child.stdout.once('data',()=>{console.log('leader complete');process.exit(0)});`;
  const output = await runTestProcess({ args: ["-e", source], signal: t.signal, timeoutMs: 2_000, graceMs: 200 });
  assert.match(output, /leader complete/);
  assert.match(output, /descendant cleanup/, "output written while the owned group is closing is preserved");
});

test("terminating the test runner cleans a detached harness before temporary ownership is released", {
  skip: process.platform === "win32", timeout: 10_000,
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-runner-signal-"));
  const marker = path.join(root, "child.json");
  const fixture = path.join(root, "fixture.test.mjs");
  const childSource = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],
    JSON.stringify({pid:process.pid,tmpdir:process.env.TMPDIR}));setInterval(()=>{},1000);`;
  writeFileSync(fixture, `import test from 'node:test';
    import {runTestProcess} from ${JSON.stringify(new URL("./helpers/test-process.ts", import.meta.url).href)};
    test('owned cancellation fixture',{timeout:8000},async(t)=>{
      await runTestProcess({args:['-e',${JSON.stringify(childSource)},${JSON.stringify(marker)}],
        signal:t.signal,timeoutMs:6000,graceMs:100});
    });`);
  const runner = spawn(process.execPath, ["scripts/run-tests.js", fixture], {
    cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  runner.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
  runner.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
  let closed = false;
  runner.once("close", () => { closed = true; });
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let child: { pid: number; tmpdir: string } | undefined;
  t.after(async () => {
    if (child && alive(child.pid)) process.kill(-child.pid, "SIGKILL");
    if (!closed) runner.kill("SIGTERM");
    const deadline = Date.now() + 500;
    while (!closed && Date.now() < deadline) await delay(20);
    if (!closed) runner.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  const readyDeadline = Date.now() + 4_000;
  while (!existsSync(marker) && !closed && Date.now() < readyDeadline) await delay(20);
  assert.ok(existsSync(marker), `nested fixture starts: ${output}`);
  child = JSON.parse(readFileSync(marker, "utf8"));
  runner.kill("SIGTERM");
  const runnerDeadline = Date.now() + 3_000;
  while (!closed && Date.now() < runnerDeadline) await delay(20);
  assert.ok(closed, `runner exits after signal: ${output}`);
  if (alive(child!.pid)) assert.ok(existsSync(child!.tmpdir), "a still-live child must retain its managed temporary files");
  const exitDeadline = Date.now() + 1_000;
  while (alive(child!.pid) && Date.now() < exitDeadline) await delay(20);
  assert.equal(alive(child!.pid), false, `detached harness must not outlive runner shutdown: ${output}`);
});
