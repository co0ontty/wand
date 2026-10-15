import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";
import { acquireDeploymentLock, releaseDeploymentLock } from "../src/deployment-lock.js";

for (const scenario of ["success", "init-failure", "unknown-core", "stopped-core", "legacy-db", "legacy-target", "data-only-node-switch", "parent-lock", "competing-lock", "stale-lock", "init-failure-parent-lock", "downloaded-install", "downloaded-parent-lock", "packaged-install"] as const) {
  test(`standalone recovery transaction: ${scenario}`, async (t) => {
    if (process.platform === "win32") return t.skip("POSIX recovery");
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-recovery-test-"));
    const globalRoot = path.join(root, "global/lib/node_modules");
    const binDir = path.join(root, "global/bin");
    const old = path.join(globalRoot, "@co0ontty/wand");
    const fixture = path.join(root, "prepared");
    const home = path.join(root, "home");
    const configDir = path.join(home, ".wand");
    for (const dir of [old, binDir, path.join(fixture, "dist/web-ui"), configDir, path.join(root, "commands")]) mkdirSync(dir, { recursive: true });
    // Simulate a failed old npm install: incomplete package plus dangling shim.
    writeFileSync(path.join(old, "old-user-marker"), "preserve me");
    let previousPackage = old;
    if (scenario === "data-only-node-switch") {
      previousPackage = path.join(root, "old-node/lib/node_modules/@co0ontty/wand");
      mkdirSync(path.dirname(previousPackage), { recursive: true });
      renameSync(old, previousPackage);
    }
    symlinkSync("../lib/node_modules/@co0ontty/wand/dist/cli.js", path.join(binDir, "wand"));
    const unrelated = path.join(globalRoot, "@co0ontty/.wand-safe-backup-existing");
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, "marker"), "rescue backup");
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "@co0ontty/wand", version: "4.91.0", type: "module" }));
    writeFileSync(path.join(fixture, "dist/server.js"), "export {};\n");
    writeFileSync(path.join(fixture, "dist/web-ui/embedded-assets.js"), "export {};\n");
    if (scenario !== "legacy-target") writeFileSync(path.join(fixture, "dist/deployment-lock.js"), transformSync(readFileSync("src/deployment-lock.ts", "utf8"), { loader: "ts", format: "esm" }).code);
    writeFileSync(path.join(fixture, "dist/cli.js"), `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.WAND_RECOVERY_TEST_EVENTS, process.argv[2] + "\\n");
if (process.argv[2] === "init" && process.env.WAND_RECOVERY_TEST_INIT_FAIL === "1") process.exit(1);
`);
    let coreReads = 0;
    const server = createServer((_req, res) => {
      coreReads++;
      res.writeHead(scenario === "unknown-core" ? 503 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hasActiveTurns: false, activeTurnCount: 0 }));
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const config = path.join(configDir, "config.json");
    writeFileSync(config, JSON.stringify({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, updateChannel: "beta" }));
    if (scenario === "legacy-db") {
      const db = new DatabaseSync(path.join(configDir, "wand.db"));
      db.exec("CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data VALUES ('preserved');");
      db.close();
    }
    if (scenario === "stopped-core") {
      const stale = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise<void>(resolve => stale.once("exit", () => resolve()));
      writeFileSync(path.join(configDir, "wand.pid"), JSON.stringify({ pid: stale.pid }));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const lockPath = path.join(globalRoot, ".wand-update-lock");
    const parentLock = ["parent-lock", "competing-lock", "init-failure-parent-lock", "downloaded-parent-lock"].includes(scenario)
      ? acquireDeploymentLock(lockPath) : null;
    const inherited = ["parent-lock", "init-failure-parent-lock", "downloaded-parent-lock"].includes(scenario);
    if (scenario === "stale-lock") {
      const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise<void>(resolve => exited.once("exit", () => resolve()));
      mkdirSync(lockPath);
      writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: exited.pid, createdAt: Date.now() }));
    }
    const events = path.join(root, "events");
    const npm = path.join(root, "commands/npm");
    writeFileSync(npm, `#!/bin/bash
set -euo pipefail
case "$1" in
 view)
   if [ "\${3:-}" = "engines.node" ]; then echo '>=22.19.0';
   else echo '{"latest":"4.91.0","beta":"4.91.0-beta.1"}'; fi
   ;;
 root) echo "$WAND_RECOVERY_TEST_ROOT/global/lib/node_modules" ;;
 prefix) echo "$WAND_RECOVERY_TEST_ROOT/global" ;;
 install)
   while [ "$1" != "--prefix" ]; do shift; done
   mkdir -p "$2/lib/node_modules/@co0ontty/wand"
   cp -R "$WAND_RECOVERY_TEST_ROOT/prepared/." "$2/lib/node_modules/@co0ontty/wand/"
   ;;
 *) exit 64 ;;
esac
`, { mode: 0o755 });
    // Keep platform discovery within this fixture, even on the real macOS host.
    writeFileSync(path.join(root, "commands/uname"), "#!/bin/sh\necho Linux\n", { mode: 0o755 });
    let entry = path.resolve(["data-only-node-switch", "parent-lock", "competing-lock", "stale-lock", "init-failure-parent-lock"].includes(scenario) ? "install.sh" : "scripts/recover-web-update.sh");
    if (scenario.startsWith("downloaded-") || scenario === "packaged-install") {
      const download = path.join(root, "download");
      mkdirSync(download);
      entry = path.join(download, "install.sh");
      copyFileSync("install.sh", entry);
      if (scenario === "packaged-install") {
        mkdirSync(path.join(download, "scripts"));
        mkdirSync(path.join(download, "dist"));
        for (const name of ["update-node.sh", "update-target.js", "recover-web-update.sh", "recover-web-update.mjs"]) {
          copyFileSync(path.join("scripts", name), path.join(download, "scripts", name));
        }
        for (const name of ["core-status-cli", "update-health", "update-legacy", "deployment-lock"]) {
          writeFileSync(path.join(download, "dist", name + ".js"),
            transformSync(readFileSync(path.join("src", name + ".ts"), "utf8"), { loader: "ts", format: "esm" }).code);
        }
      }
      // A downloaded script has neither .nvmrc nor neighboring control modules.
      // Serve the exact source tree without contacting GitHub or npm.
      writeFileSync(path.join(root, "commands/curl"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const url = args.find(value => value.startsWith("https://"));
const relative = url?.replace("https://raw.githubusercontent.com/co0ontty/wand/master/", "");
if (!relative || !/^(scripts|src)\\/[a-z-]+\\.(sh|js|mjs|ts)$/.test(relative)) process.exit(64);
fs.copyFileSync(path.join(process.env.WAND_RECOVERY_TEST_REPO, relative), args[args.indexOf("-o") + 1]);
`, { mode: 0o755 });
    }
    const child = spawn("/bin/bash", [entry], {
      env: { ...process.env, HOME: home, WAND_CONFIG_PATH: config, WAND_UPDATE_CHANNEL: scenario === "legacy-db" || scenario === "data-only-node-switch" ? "" : "beta",
        PATH: path.join(root, "commands") + path.delimiter + process.env.PATH,
        WAND_RECOVERY_TEST_ROOT: root, WAND_RECOVERY_TEST_EVENTS: events, WAND_RECOVERY_TEST_REPO: process.cwd(),
        WAND_DEPLOYMENT_LOCKS: inherited ? JSON.stringify([parentLock]) : "",
        WAND_RECOVERY_TEST_INIT_FAIL: scenario.startsWith("init-failure") ? "1" : "0" },
      stdio: "pipe",
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
    assert.equal(readFileSync(path.join(unrelated, "marker"), "utf8"), "rescue backup");
    const blocked = scenario === "competing-lock" || scenario === "stale-lock";
    assert.equal(existsSync(lockPath), !!parentLock || scenario === "stale-lock");
    if (parentLock) releaseDeploymentLock(parentLock);
    if (!["init-failure", "init-failure-parent-lock", "unknown-core", "competing-lock", "stale-lock"].includes(scenario)) {
      assert.equal(code, 0, output);
      assert.equal(JSON.parse(readFileSync(path.join(old, "package.json"), "utf8")).version, "4.91.0");
      const backup = readdirSync(path.dirname(old)).find(name => name.startsWith(".wand-recovery-backup-"));
      assert.ok(backup);
      if (scenario === "data-only-node-switch") assert.equal(readFileSync(path.join(previousPackage, "old-user-marker"), "utf8"), "preserve me");
      else assert.equal(readFileSync(path.join(path.dirname(old), backup, "wand/old-user-marker"), "utf8"), "preserve me");
      if (scenario === "legacy-db") {
        const db = new DatabaseSync(path.join(configDir, "wand.db"), { readOnly: true });
        assert.equal(db.prepare("SELECT value FROM legacy_data").get()?.value, "preserved");
        db.close();
      }
      assert.match(output, /4.91.0 \(beta subscription\)/);
    } else {
      assert.notEqual(code, 0, output);
      assert.equal(readFileSync(path.join(old, "old-user-marker"), "utf8"), "preserve me");
      assert.equal(readlinkSync(path.join(binDir, "wand")), "../lib/node_modules/@co0ontty/wand/dist/cli.js");
      if (blocked) {
        assert.match(output, /另一个 wand 更新/);
        assert.equal(coreReads, 0, "lock contention must be rejected before the old service is drained");
        assert.equal(existsSync(events), false, "a competing install must not run the prepared CLI");
        if (scenario === "stale-lock") assert.match(output, /进程已退出/);
      }
      if (scenario === "unknown-core") {
        assert.match(output, /HTTP 503/);
        assert.equal(existsSync(events), false, "unknown Core must not run staged CLI or change the installation");
      }
    }
  });
}
