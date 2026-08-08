import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { WandStorage } from "../src/storage.js";
import { connectExistingTerminalHost } from "../src/terminal-daemon-client.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null, message: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(message);
}

async function waitForDaemon(configPath: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const client = await connectExistingTerminalHost(configPath);
    if (client) return client;
    await delay(25);
  }
  throw new Error("terminal daemon did not become ready");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

test("ProcessManager reattaches the same live PTY after the web owner restarts", async (t) => {
  if (process.platform === "win32") t.skip("node-pty shell fixture is POSIX-specific");

  const root = mkdtempSync(path.join(os.tmpdir(), "wand-terminal-daemon-"));
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "wand.db");
  const fixture = path.join(import.meta.dirname, "fixtures", "terminal-daemon-entry.ts");
  const daemon = spawn(process.execPath, ["--import", "tsx", fixture, configPath], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonError = "";
  daemon.stderr?.on("data", (chunk) => { daemonError += chunk.toString(); });
  let successor: ChildProcess | null = null;

  let firstStorage: WandStorage | null = null;
  let secondStorage: WandStorage | null = null;
  let firstManager: ProcessManager | null = null;
  let secondManager: ProcessManager | null = null;
  t.after(async () => {
    try { secondManager?.dispose(); } catch { /* best effort */ }
    try { firstManager?.dispose(); } catch { /* best effort */ }
    try { secondStorage?.close(); } catch { /* best effort */ }
    try { firstStorage?.close(); } catch { /* best effort */ }
    if (successor) await stopChild(successor);
    await stopChild(daemon);
    rmSync(root, { recursive: true, force: true });
  });

  const config = {
    ...defaultConfig(),
    shell: "/bin/sh",
    defaultCwd: root,
    startupCommands: [],
  };

  const firstHost = await waitForDaemon(configPath).catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${daemonError}`);
  });
  firstStorage = new WandStorage(dbPath);
  firstManager = new ProcessManager(config, firstStorage, root, firstHost);
  const started = await firstManager.startShell(root, "default", { cols: 100, rows: 30 });
  const firstAttachment = firstHost.attach(started.id);
  assert.ok(firstAttachment?.process);
  const originalPid = firstAttachment.process.pid;

  // Starting a newly installed/versioned terminal service must wait behind the
  // current owner instead of replacing its socket or killing its live PTYs.
  successor = spawn(process.execPath, ["--import", "tsx", fixture, configPath], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: process.env,
    stdio: "ignore",
  });
  await delay(250);
  assert.equal(successor.exitCode, null);
  const competingClient = await waitForDaemon(configPath);
  assert.equal(competingClient.attach(started.id)?.process?.pid, originalPid);
  competingClient.disconnect();
  await stopChild(successor);
  successor = null;

  firstManager.sendInput(
    started.id,
    "printf 'before-restart\\n'; sleep 0.25; printf 'while-web-was-down\\n'\r",
    "terminal",
  );
  await waitFor(
    () => firstManager?.get(started.id)?.output.includes("before-restart") ? true : null,
    "initial terminal output was not observed",
  );

  firstManager.dispose();
  firstManager = null;
  firstStorage.close();
  firstStorage = null;
  await delay(500);

  const secondHost = await waitForDaemon(configPath);
  secondStorage = new WandStorage(dbPath);
  secondManager = new ProcessManager(config, secondStorage, root, secondHost);
  const restored = secondManager.get(started.id);
  assert.equal(restored?.status, "running");
  assert.equal(secondHost.attach(started.id)?.process?.pid, originalPid);
  assert.match(restored?.output ?? "", /while-web-was-down/);

  secondManager.sendInput(started.id, "printf 'after-reconnect\\n'\r", "terminal");
  await waitFor(
    () => secondManager?.get(started.id)?.output.includes("after-reconnect") ? true : null,
    "reattached terminal did not accept input",
  );
  secondManager.delete(started.id);
});
