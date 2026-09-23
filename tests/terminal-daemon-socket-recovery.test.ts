import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { connectExistingTerminalHost } from "../src/terminal-daemon-client.js";
import { terminalDaemonPaths } from "../src/terminal-daemon-protocol.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForDaemon(config: string) {
  for (let i = 0; i < 200; i++) {
    const client = await connectExistingTerminalHost(config);
    if (client) return client;
    await delay(25);
  }
  throw new Error("daemon did not become reachable");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

test("missing terminald socket recovers repeatedly without changing credentials or live process", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-socket-recovery-"));
  const config = path.join(root, "config.json");
  const paths = terminalDaemonPaths(config);
  const daemon = spawn(process.execPath, ["--import", "tsx",
    path.join(import.meta.dirname, "fixtures", "terminal-daemon-entry.ts"), config], {
    stdio: "ignore",
  });
  t.after(async () => { await stop(daemon); rmSync(root, { recursive: true, force: true }); });
  const client = await waitForDaemon(config);
  t.after(() => client.disconnect());
  const token = readFileSync(paths.tokenPath, "utf8");
  const pid = readFileSync(paths.pidPath, "utf8");
  const run = await client.spawnStructured({ runId: "keep-running", provider: "pi",
    file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root,
    env: process.env as Record<string, string> });
  for (let attempt = 0; attempt < 2; attempt++) {
    unlinkSync(paths.socketPath);
    assert.equal((await client.attachRun(run.runId))?.pid, run.pid, "existing connection survives unlink");
    const fresh = await waitForDaemon(config);
    try {
      const state = await fresh.attachRun(run.runId);
      assert.equal(state?.pid, run.pid);
      assert.equal(state?.incarnationId, run.incarnationId);
      assert.equal(state?.status, "running");
      assert.equal(statSync(paths.socketPath).mode & 0o777, 0o600);
      assert.equal(readFileSync(paths.tokenPath, "utf8"), token);
      assert.equal(readFileSync(paths.pidPath, "utf8"), pid);
    } finally { fresh.disconnect(); }
  }
  client.forgetRun(run.runId);
});
