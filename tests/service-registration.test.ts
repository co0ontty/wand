import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { currentServiceManager } from "../src/service-manager/index.js";
import { SystemdServiceManager } from "../src/service-manager/systemd.js";
import ts from "typescript";
import { createRequire } from "node:module";

test("service registration uses platform-specific scope paths and refuses unsupported platforms", () => {
  const linux = currentServiceManager("linux");
  assert.ok(linux);
  assert.equal(linux.unitPath("system"), "/etc/systemd/system/wand.service");
  assert.equal(linux.unitPath("user"), path.join(os.homedir(), ".config/systemd/user/wand.service"));
  const darwin = currentServiceManager("darwin");
  assert.ok(darwin);
  assert.equal(darwin.unitPath("system"), "/Library/LaunchDaemons/com.wand.web.plist");
  assert.equal(darwin.unitPath("user"), path.join(os.homedir(), "Library/LaunchAgents/com.wand.web.plist"));
  assert.equal(currentServiceManager("win32"), null);
});

test("systemd restart reads the installed config, accepting quoted paths and failing closed on missing config", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-service-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unit = path.join(root, "wand.service");
  const manager = new SystemdServiceManager();
  manager.unitPath = () => unit;
  for (const option of ["-c /tmp/custom.json", "--config=/tmp/custom.json", '-c "/tmp/custom config.json"']) {
    writeFileSync(unit, `ExecStart=/opt/node /opt/wand/cli.js web ${option}\n`);
    assert.equal(manager.readConfigPath("system"), option.includes('"') ? "/tmp/custom config.json" : "/tmp/custom.json");
  }
  writeFileSync(unit, "ExecStart=/opt/node /opt/wand/cli.js web\n");
  assert.equal(manager.readConfigPath("system"), null);
});

test("launchd reads ProgramArguments rather than assuming a fixed config index", () => {
  const source = readFileSync(new URL("../src/service-manager/launchd.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} as { LaunchdServiceManager: new () => { readConfigPath(scope: string): string | null } } };
  const require = createRequire(import.meta.url);
  let output = JSON.stringify(["/opt/node", "/opt/wand/cli.js", "web", "--verbose", "-c", "/tmp/custom config.json"]);
  new Function("require", "module", "exports", code)((name: string) => name === "../run-command.js"
    ? { runCommandSync: () => ({ status: 0, stdout: output }) } : require(name), module, module.exports);
  const manager = new module.exports.LaunchdServiceManager();
  assert.equal(manager.readConfigPath("system"), "/tmp/custom config.json");
  output = "not json"; assert.equal(manager.readConfigPath("system"), null);
  output = JSON.stringify(["node", "cli", "web"]); assert.equal(manager.readConfigPath("system"), null);
});
