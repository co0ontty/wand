import assert from "node:assert/strict";
import test from "node:test";
import { elevateServiceCommand, resolveServiceCommandScope, type ServicePrivilegeRuntime } from "../src/service-command-privilege.js";

function fixture(overrides: Partial<ServicePrivilegeRuntime> = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const messages: string[] = [];
  const runtime: ServicePrivilegeRuntime = {
    platform: "darwin", uid: 501, interactive: true,
    node: "/opt/node/bin/node", cli: "/opt/wand/dist/cli.js", execArgv: [],
    run: async (file, args) => { calls.push({ file, args }); return 0; },
    report: (message) => { messages.push(message); }, ...overrides,
  };
  return { runtime, calls, messages };
}

test("system restart requests foreground sudo with pinned node, CLI, scope and config", async () => {
  const h = fixture();
  assert.equal(await elevateServiceCommand("service:restart", ["service:restart", "--system", "-c", "/tmp/user config.json", "--timeout", "8"], "/tmp/user config.json", "system", h.runtime), 0);
  assert.deepEqual(h.calls, [{ file: "sudo", args: ["--", "/opt/node/bin/node", "/opt/wand/dist/cli.js", "service:restart", "--timeout", "8", "--system", "-c", "/tmp/user config.json"] }]);
  assert.match(h.messages[0], /输入密码/);
});

test("all mutating system commands request sudo, never read-only commands", async () => {
  for (const action of ["install", "uninstall", "start", "stop", "restart", "status", "logs"]) {
    const h = fixture();
    const code = await elevateServiceCommand(`service:${action}`, [`service:${action}`], "/tmp/config.json", "system", h.runtime);
    assert.equal(code, ["status", "logs"].includes(action) ? null : 0);
    assert.equal(h.calls.length, code === null ? 0 : 1);
  }
});

test("root, user scope and unsupported platforms never recurse into sudo", async () => {
  for (const [overrides, scope] of [[{ uid: 0 }, "system"], [{}, "user"], [{ platform: "win32" }, "system"]] as const) {
    const h = fixture(overrides);
    assert.equal(await elevateServiceCommand("service:restart", ["service:restart"], "/tmp/config.json", scope, h.runtime), null);
    assert.equal(h.calls.length, 0);
  }
  assert.equal(resolveServiceCommandScope("service:restart", ["--system", "--user"]), "user");
});

test("no terminal uses noninteractive sudo only, and authorization failure never continues locally", async () => {
  const h = fixture({ interactive: false });
  h.runtime.run = async (file, args) => { h.calls.push({ file, args }); return 1; };
  assert.equal(await elevateServiceCommand("service:restart", ["service:restart"], "/tmp/config.json", "system", h.runtime), 1);
  assert.equal(h.calls[0].args[0], "-n");
  assert.match(h.messages[0], /没有交互终端/);
});

test("cancel or missing sudo fails closed and preserves the child exit code", async () => {
  const h = fixture({ run: async () => 130 });
  assert.equal(await elevateServiceCommand("service:restart", ["service:restart"], "/tmp/config.json", "system", h.runtime), 130);
  const missing = fixture({ run: async () => { throw new Error("spawn sudo ENOENT"); } });
  assert.equal(await elevateServiceCommand("service:restart", ["service:restart"], "/tmp/config.json", "system", missing.runtime), 1);
  assert.match(missing.messages.at(-1)!, /ENOENT/);
});
