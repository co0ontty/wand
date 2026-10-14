import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as ipcServer } from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { probeUpdatedService, waitForUpdatedService } from "../src/update-health.js";
import { countLegacyUpdateExecutions, waitForCompatibleUpdate } from "../src/update-legacy.js";
import { resolveInstalledNpmPrefix, selectPackageUpdateInfo } from "../src/npm-update-utils.js";
import { buildSystemdUpdateEnvironmentArgs, resolveVerifiedManagedScope, buildUpdateRecoveryCommand, readLatestDetachedUpdate } from "../src/update-helper.js";
import { selectBootstrapUpdateVersion } from "../scripts/update-target.js";
import { parseServiceArguments, discoverServiceConfig } from "../scripts/recover-web-update.mjs";

const rootFor = (t: any) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-update-compat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test("bootstrap and Web selectors agree across old beta/debug and new stable candidates", () => {
  for (const [stable, beta] of [["4.91.0", "4.91.0-beta.10"], ["4.91.0", "4.91.1-beta.11"],
    ["4.91.0", "4.91.0-debug.1"], ["4.91.0", null], [null, "4.91.1-beta.11"]]) {
    for (const channel of ["stable", "beta"] as const) {
      const web = selectPackageUpdateInfo("4.26.3", channel, stable, beta);
      if (!web.latest) assert.throws(() => selectBootstrapUpdateVersion({ latest: stable, beta }, channel));
      else assert.equal(selectBootstrapUpdateVersion({ latest: stable, beta }, channel), web.latest);
    }
  }
  assert.throws(() => selectBootstrapUpdateVersion({ latest: "04.91.0" }, "stable"));
});

test("service discovery reads a quoted custom configuration without executing unit text", t => {
  const root = rootFor(t);
  const config = path.join(root, "config with spaces.json");
  const unit = path.join(root, "wand.service");
  writeFileSync(unit, `ExecStart="/node path/node" "/wand path/wand" web -c "${config}"\n`);
  assert.deepEqual(parseServiceArguments(`"/node path/node" '/wand path/wand' web -c "${config}"`),
    ["/node path/node", "/wand path/wand", "web", "-c", config]);
  assert.equal(discoverServiceConfig(unit, "Linux"), config);
  assert.throws(() => parseServiceArguments('"unclosed'), /引号/);
});

test("updater stays bound to the running package including a retained rollback backup", t => {
  const root = rootFor(t);
  const prefix = path.join(root, "managed");
  const pkg = path.join(prefix, "lib/node_modules/@co0ontty/wand");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@co0ontty/wand" }));
  assert.deepEqual(resolveInstalledNpmPrefix(pathToFileURL(path.join(pkg, "dist/npm-update-utils.js")).href, "linux"),
    { root: path.join(prefix, "lib/node_modules"), prefix });
  const backup = path.join(prefix, "lib/node_modules/@co0ontty/.wand-safe-backup-AbCd12/wand");
  mkdirSync(backup, { recursive: true });
  writeFileSync(path.join(backup, "package.json"), JSON.stringify({ name: "@co0ontty/wand" }));
  assert.deepEqual(resolveInstalledNpmPrefix(pathToFileURL(path.join(backup, "dist/npm-update-utils.js")).href, "linux"),
    { root: path.join(prefix, "lib/node_modules"), prefix });
});

test("inherited service markers cannot masquerade as actual manager ownership", () => {
  assert.equal(resolveVerifiedManagedScope(["system"], { system: 100 }, 100), "system");
  assert.equal(resolveVerifiedManagedScope(["system"], { system: 100 }, 200), null);
  assert.equal(resolveVerifiedManagedScope(["system", "user"], { system: 100, user: 200 }, 200), "user");
  assert.throws(() => resolveVerifiedManagedScope(["system"], { system: null }, 200), /无法核实/);
});

test("systemd helper inherits npm/proxy names and retains the current identity without secret argv", () => {
  const env = { HTTPS_PROXY: "https://private-credential@proxy", npm_config_registry: "private-value", WAND_DECISION_TOKEN: "do-not-forward" };
  const args = buildSystemdUpdateEnvironmentArgs(env, true, 501, 20);
  assert.ok(args.includes("--setenv=HTTPS_PROXY"));
  assert.ok(args.includes("--setenv=npm_config_registry"));
  assert.ok(args.includes("--property=User=501"));
  assert.ok(args.includes("--property=Group=20"));
  assert.ok(args.every(value => !value.includes("private-") && !value.includes("WAND_DECISION")));
});

test("update status survives a server instance replacement and recovery commands quote paths", t => {
  const root = rootFor(t);
  const config = path.join(root, "config.json");
  const logDir = mkdtempSync(path.join(os.tmpdir(), "wand-update-"));
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const logPath = path.join(logDir, "update.log");
  writeFileSync(`${logPath}.status.json`, JSON.stringify({ phase: "verifying", message: "checking" }));
  writeFileSync(path.join(root, "web-update-operation.json"), JSON.stringify({ configPath: config, logPath, version: "4.91.1" }));
  assert.equal(readLatestDetachedUpdate(config)?.status?.phase, "verifying");
  assert.match(buildUpdateRecoveryCommand("/tmp/a'$(false)/config.json"), /WAND_CONFIG_PATH='/);
});

test("health proof rejects the old instance and mismatched headers, accepts the new target", async t => {
  const root = rootFor(t);
  const configPath = path.join(root, "config.json");
  let version = "4.91.1";
  const server = ipcServer(socket => socket.on("data", data => {
    const req = JSON.parse(String(data));
    socket.write(JSON.stringify({ id: req.id, ok: true, data: { header: { pid: process.pid, version, configPath } } }) + "\n");
  }));
  server.listen(path.join(root, "wand.sock"));
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => server.close());
  writeFileSync(path.join(root, "wand.pid"), JSON.stringify({ pid: process.pid, version: "4.91.1", configPath }));
  await assert.rejects(probeUpdatedService(configPath, "4.91.1", process.pid), /新服务实例/);
  version = "4.91.0";
  await assert.rejects(probeUpdatedService(configPath, "4.91.1", 1), /不一致/);
  version = "4.91.1";
  assert.equal((await waitForUpdatedService(configPath, "4.91.1", 1, 1000)).version, "4.91.1");
});

test("legacy execution contract counts in-flight and queued work and rejects unknown state", () => {
  assert.equal(countLegacyUpdateExecutions([{ id: "terminal", command: "zsh", status: "running" }]), 0);
  assert.equal(countLegacyUpdateExecutions([{ id: "a", sessionKind: "structured", structuredState: { inFlight: true }, queuedMessages: [] }]), 1);
  assert.equal(countLegacyUpdateExecutions([{ id: "a", sessionKind: "structured", structuredState: { inFlight: false }, queuedMessages: ["queued"] }]), 1);
  assert.throws(() => countLegacyUpdateExecutions([{ id: "a", sessionKind: "structured", queuedMessages: [] }]), /状态不完整/);
});

for (const unknown of [false, true]) {
  test(`pre-Core recovery negotiates the actual old protocol and ${unknown ? "rejects unknown work" : "waits for active work"}`, async t => {
    const root = rootFor(t);
    const configPath = path.join(root, "config.json");
    const marker = path.join(root, "applied");
    let reads = 0, logouts = 0;
    const http = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/login") { res.setHeader("set-cookie", "wand_session_local=fixture; HttpOnly"); res.end('{"ok":true}'); }
      else if (req.url === "/api/logout") { logouts++; res.end('{"ok":true}'); }
      else {
        reads++;
        res.end(JSON.stringify([{ id: "old", sessionKind: "structured", queuedMessages: [],
          ...(unknown ? {} : { structuredState: { inFlight: reads === 1 } }) }]));
      }
    });
    http.listen(0, "127.0.0.1"); await new Promise<void>(resolve => http.once("listening", resolve));
    const port = (http.address() as AddressInfo).port;
    const ipc = ipcServer(socket => socket.on("data", data => {
      const req = JSON.parse(String(data));
      socket.write(JSON.stringify(req.cmd === "core-status"
        ? { id: req.id, ok: false, error: "unknown cmd: core-status" }
        : { id: req.id, ok: true, data: { header: { pid: process.pid, configPath, url: `http://127.0.0.1:${port}` } } }) + "\n");
    }));
    ipc.listen(path.join(root, "wand.sock")); await new Promise<void>(resolve => ipc.once("listening", resolve));
    t.after(() => { http.close(); ipc.close(); });
    writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", port, password: "isolated-fixture-password" }));
    const run = () => waitForCompatibleUpdate(configPath, 5, [process.execPath, "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'applied')`]);
    if (unknown) { await assert.rejects(run(), /状态不完整/); assert.equal(existsSync(marker), false); }
    else { assert.equal(await run(), 0); assert.equal(readFileSync(marker, "utf8"), "applied"); assert.ok(reads >= 3); }
    assert.equal(logouts, 1);
  });
}
