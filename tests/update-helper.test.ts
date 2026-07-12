import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildDetachedUpdateHelperScript,
  isStableServiceEntrypoint,
  resolveManagedServiceScope,
  resolveManagedServiceScopeCandidates,
  shouldUseSystemdRunForDetachedUpdate,
  type DetachedUpdateOptions,
} from "../src/update-helper.js";

interface Fixture {
  root: string;
  eventsPath: string;
  logPath: string;
  scriptPath: string;
  updateUtilsPath: string;
  opts: DetachedUpdateOptions;
}

function makeExecutable(file: string, body: string): void {
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
}

function createFixture(parentPid: number, installFails = false): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-update-helper-test-"));
  const fakeBin = path.join(root, "bin");
  const globalRoot = path.join(root, "global");
  const globalCliDir = path.join(globalRoot, "@co0ontty", "wand", "dist");
  const eventsPath = path.join(root, "events.log");
  const logPath = path.join(root, "update.log");
  const scriptPath = path.join(root, "update.sh");
  const updateUtilsPath = path.join(root, "npm-update-utils.mjs");
  const configPath = path.join(root, "config with spaces", "config.json");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(globalCliDir, { recursive: true });
  mkdirSync(path.dirname(configPath), { recursive: true });

  makeExecutable(path.join(fakeBin, "npm"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "root" ] && [ "\${2:-}" = "-g" ]; then
  printf '%s\\n' '${globalRoot}'
  exit 0
fi
exit 64
`);

  writeFileSync(path.join(globalCliDir, "cli.js"), `
const fs = require("node:fs");
fs.appendFileSync(process.env.WAND_TEST_EVENTS, "cli:" + process.argv.slice(2).join(" ") + "\\n");
`, "utf8");

  writeFileSync(updateUtilsPath, `
import fs from "node:fs";
export async function installPackageGloballyAsync(spec, timeoutMs, log) {
  fs.appendFileSync(process.env.WAND_TEST_EVENTS, "install:" + spec + ":" + timeoutMs + "\\n");
  log("[stub] install invoked");
  if (process.env.WAND_TEST_INSTALL_FAIL === "1") {
    throw new Error("stub install failure");
  }
}
`, "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    WAND_TEST_EVENTS: eventsPath,
    WAND_TEST_INSTALL_FAIL: installFails ? "1" : "0",
  };
  const opts: DetachedUpdateOptions = {
    installSpec: "@co0ontty/wand@latest",
    configPath,
    parentPid,
    cliArgs: ["web", "-c", configPath],
    cwd: root,
    env,
    timeoutMs: 30_000,
  };
  return { root, eventsPath, logPath, scriptPath, updateUtilsPath, opts };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await delay(20);
  }
}

async function spawnParent(root: string, eventsPath: string): Promise<ChildProcess> {
  const readyPath = path.join(root, "parent.ready");
  const code = `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
process.on("SIGTERM", () => {
  fs.appendFileSync(${JSON.stringify(eventsPath)}, "parent:term\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: "ignore",
  });
  await waitFor(() => {
    try {
      return readFileSync(readyPath, "utf8") === "ready";
    } catch {
      return false;
    }
  });
  return parent;
}

async function runScript(fixture: Fixture, serviceScope: "system" | "user" | null): Promise<number | null> {
  const script = buildDetachedUpdateHelperScript(
    fixture.opts,
    fixture.logPath,
    serviceScope,
    fixture.updateUtilsPath,
  );
  writeFileSync(fixture.scriptPath, script, { encoding: "utf8", mode: 0o700 });
  return await new Promise<number | null>((resolve, reject) => {
    const child = spawn("/bin/bash", [fixture.scriptPath], {
      env: fixture.opts.env,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("update helper test timed out"));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function isAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("an installed but unmanaged service manifest falls back to standalone relaunch", () => {
  assert.equal(
    resolveManagedServiceScope("system", "darwin", { XPC_SERVICE_NAME: "0" }, 123),
    null,
  );
  assert.equal(
    resolveManagedServiceScope("system", "darwin", { XPC_SERVICE_NAME: "com.wand.web" }, 123),
    "system",
  );
  assert.equal(
    resolveManagedServiceScope(null, "darwin", { XPC_SERVICE_NAME: "com.wand.web" }, 123),
    "system",
  );
  assert.equal(
    resolveManagedServiceScope("user", "linux", { SYSTEMD_EXEC_PID: "123" }, 123),
    "user",
  );
  assert.equal(
    resolveManagedServiceScope(
      "user",
      "linux",
      { SYSTEMD_EXEC_PID: "999", INVOCATION_ID: "inherited" },
      123,
    ),
    null,
  );
  assert.equal(
    resolveManagedServiceScope("system", "linux", {}, 123),
    null,
  );
  assert.equal(shouldUseSystemdRunForDetachedUpdate(null), false);
  assert.equal(shouldUseSystemdRunForDetachedUpdate("system"), true);
  assert.throws(
    () => resolveManagedServiceScopeCandidates(
      ["system", "user"],
      "darwin",
      { XPC_SERVICE_NAME: "com.wand.web" },
      123,
    ),
    /同时检测到 system 与 user/,
  );
  assert.equal(
    isStableServiceEntrypoint("/opt/node/bin/wand", "/opt/node/bin/wand"),
    true,
  );
  assert.equal(
    isStableServiceEntrypoint(
      "/opt/node/lib/node_modules/@co0ontty/wand/dist/cli.js",
      "/opt/node/bin/wand",
    ),
    false,
  );
});

test("helper uses the shared installer and keeps the parent alive when install fails", async (t) => {
  if (process.platform === "win32") {
    t.skip("bash helper is not supported on Windows");
    return;
  }
  const fixture = createFixture(process.pid, true);
  const parent = await spawnParent(fixture.root, fixture.eventsPath);
  fixture.opts.parentPid = parent.pid!;
  t.after(() => {
    if (isAlive(parent)) parent.kill("SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const code = await runScript(fixture, null);
  assert.notEqual(code, 0);
  assert.equal(isAlive(parent), true);

  const script = readFileSync(fixture.scriptPath, "utf8");
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /installPackageGloballyAsync/);
  assert.doesNotMatch(script, /npm uninstall|npm install|--force|systemctl|launchctl|service:install/);

  const log = readFileSync(fixture.logPath, "utf8");
  assert.match(log, /stub install failure/);
  assert.match(log, /install failed; keeping parent service online/);
  assert.match(log, /parent service was left running/);
  assert.deepEqual(readFileSync(fixture.eventsPath, "utf8").trim().split("\n"), [
    "install:@co0ontty/wand@latest:30000",
  ]);
});

test("helper can import the TypeScript installer used by npm run dev", async (t) => {
  if (process.platform === "win32") {
    t.skip("bash helper is not supported on Windows");
    return;
  }
  const fixture = createFixture(process.pid, true);
  const sourceInstaller = path.join(fixture.root, "npm-update-utils.ts");
  writeFileSync(sourceInstaller, `
import fs from "node:fs";
const eventName: string = "typescript-install";
export async function installPackageGloballyAsync(spec: string, timeoutMs: number): Promise<void> {
  fs.appendFileSync(process.env.WAND_TEST_EVENTS!, eventName + ":" + spec + ":" + timeoutMs + "\\n");
  throw new Error("expected TypeScript installer failure");
}
`, "utf8");
  fixture.updateUtilsPath = sourceInstaller;
  fixture.opts.nodeLoaderArgs = ["--import", import.meta.resolve("tsx")];
  const parent = await spawnParent(fixture.root, fixture.eventsPath);
  fixture.opts.parentPid = parent.pid!;
  t.after(() => {
    if (isAlive(parent)) parent.kill("SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const code = await runScript(fixture, null);
  assert.notEqual(code, 0);
  assert.equal(isAlive(parent), true);
  assert.match(readFileSync(fixture.logPath, "utf8"), /expected TypeScript installer failure/);
  assert.equal(
    readFileSync(fixture.eventsPath, "utf8").trim(),
    "typescript-install:@co0ontty/wand@latest:30000",
  );
});

test("standalone helper initializes, terminates the parent, then starts the global CLI", async (t) => {
  if (process.platform === "win32") {
    t.skip("bash helper is not supported on Windows");
    return;
  }
  const fixture = createFixture(process.pid);
  const parent = await spawnParent(fixture.root, fixture.eventsPath);
  fixture.opts.parentPid = parent.pid!;
  t.after(() => {
    if (isAlive(parent)) parent.kill("SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const code = await runScript(fixture, null);
  assert.equal(code, 0);
  await waitFor(() => {
    try {
      return readFileSync(fixture.eventsPath, "utf8").includes("cli:web");
    } catch {
      return false;
    }
  });

  const events = readFileSync(fixture.eventsPath, "utf8").trim().split("\n");
  assert.equal(events[0], "install:@co0ontty/wand@latest:30000");
  assert.match(events[1] ?? "", /^cli:init -c /);
  assert.equal(events[2], "parent:term");
  assert.match(events[3] ?? "", /^cli:web -c /);
  assert.equal(isAlive(parent), false);
});

test("service-scoped helper relies on Restart/KeepAlive without launching another CLI", async (t) => {
  if (process.platform === "win32") {
    t.skip("bash helper is not supported on Windows");
    return;
  }
  const fixture = createFixture(process.pid);
  const parent = await spawnParent(fixture.root, fixture.eventsPath);
  fixture.opts.parentPid = parent.pid!;
  t.after(() => {
    if (isAlive(parent)) parent.kill("SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const code = await runScript(fixture, "user");
  assert.equal(code, 0);
  await delay(200);

  const events = readFileSync(fixture.eventsPath, "utf8").trim().split("\n");
  assert.equal(events[0], "install:@co0ontty/wand@latest:30000");
  assert.match(events[1] ?? "", /^cli:init -c /);
  assert.equal(events[2], "parent:term");
  assert.equal(events.some((line) => line.startsWith("cli:web")), false);
  assert.match(readFileSync(fixture.logPath, "utf8"), /user service detected; waiting for Restart\/KeepAlive relaunch/);
});
