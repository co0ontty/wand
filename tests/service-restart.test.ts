import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

function harness({ uid = 0, guardError = false, stopError = false, platform = "linux", installedConfig = "/tmp/custom/config.json" } = {}) {
  const source = readFileSync(new URL("../src/tui/commands.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const events: string[] = [];
  let loaded = true;
  const module = { exports: {} as { serviceRestart: (opts: unknown) => Promise<{ ok: boolean; detail?: string }> } };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "node:process") return { ...process, platform, getuid: () => uid };
    if (name === "node:fs") return { existsSync: () => true };
    if (name === "../service-manager/index.js") return { servicePathFor: () => "/test/wand.service", readServiceConfigPath: () => installedConfig, DEFAULT_SERVICE_SCOPE: "system" };
    if (name === "../config.js") return { resolveConfigPath: (config: string) => config };
    if (name === "../error-utils.js") return { getErrorMessage: (error: Error) => error.message };
    if (name === "../core-status-cli.js") return { waitForCoreTurnsComplete: async (config: string, timeout: number, action: () => Promise<number>) => {
      assert.equal(config, "/tmp/custom/config.json"); assert.equal(timeout, 2);
      events.push("drain"); if (guardError) throw new Error("busy timeout");
      return await action();
    } };
    if (name === "../run-command.js") return {
      runCommand: async () => ({ code: 0, stdout: platform === "darwin" ? "state = running\npid = 42\n" : "active", stderr: "" }),
      runCommandSync: (file: string, args: string[]) => {
        assert.equal(file, platform === "darwin" ? "launchctl" : "systemctl"); events.push(args[0]);
        if (platform === "darwin") {
          assert.ok(!args.some((arg) => /terminald|render/.test(arg)));
          if (args[0] === "bootout" && !stopError) loaded = false;
          if (args[0] === "bootstrap") loaded = true;
          return { status: args[0] === "print" && !loaded ? 1 : 0, stdout: loaded ? "state = running\npid = 42\n" : "", stderr: "" };
        }
        return { status: args[0] === "stop" && stopError ? 1 : 0, stdout: "", stderr: "" };
      },
    };
    if (name.startsWith("../")) return {};
    return require(name);
  }, module, module.exports);
  return { events, restart: () => module.exports.serviceRestart({ scope: "system", configPath: "/tmp/custom/config.json", timeoutSeconds: 2 }) };
}

test("restart drains the live server before graceful stop/start, without touching daemon services", async () => {
  const h = harness(); assert.equal((await h.restart()).ok, true);
  assert.deepEqual(h.events, ["drain", "stop", "start"]);
});

test("macOS restart gracefully bootouts/bootstrap only the Server, never kickstart -k", async () => {
  const h = harness({ platform: "darwin" }); assert.equal((await h.restart()).ok, true);
  assert.deepEqual(h.events.filter((event) => event !== "print"), ["drain", "bootout", "bootout", "bootstrap", "enable"]);
});

test("mismatching installed config cannot drain an unrelated process or restart the service", async () => {
  const h = harness({ installedConfig: "/tmp/other/config.json" });
  assert.equal((await h.restart()).ok, false); assert.deepEqual(h.events, []);
});

test("guard failure never runs any stop or start", async () => {
  const h = harness({ guardError: true }); const result = await h.restart();
  assert.equal(result.ok, false); assert.match(result.detail!, /busy timeout/);
  assert.deepEqual(h.events, ["drain"]);
});

test("failed stop cannot fall through to start; missing authorization does not touch services", async () => {
  const stop = harness({ stopError: true }); assert.equal((await stop.restart()).ok, false);
  assert.deepEqual(stop.events, ["drain", "stop"]);
  const denied = harness({ uid: 501 }); assert.equal((await denied.restart()).ok, false);
  assert.deepEqual(denied.events, []);
});
