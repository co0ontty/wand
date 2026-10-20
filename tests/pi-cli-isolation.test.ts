import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvePiCliPackage } from "../src/pi-cli-runtime.js";

function cliPackage(root: string) {
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" },
  }));
  const entry = path.join(root, "dist/cli.js");
  writeFileSync(entry, "#!/usr/bin/env node\n");
  chmodSync(entry, 0o755);
  return entry;
}

test("CLI resource lookup follows the actual npm/managed install and never falls back to Wand SDK", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wand-pi-cli-lookup-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const npmRoot = path.join(root, "npm-package");
  const npmEntry = cliPackage(npmRoot);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  // A symlink is how npm and pnpm expose their real entrypoint.
  symlinkSync(npmEntry, path.join(bin, "pi"));
  assert.equal(resolvePiCliPackage({ PATH: bin }, root), npmRoot);
  const managed = path.join(root, "managed");
  mkdirSync(path.join(managed, "bin"), { recursive: true });
  const launcher = path.join(managed, "bin/pi");
  writeFileSync(launcher, "#!/bin/sh\n# Official managed launcher: PI_MANAGED_INSTALL_ROOT, install/current-version\n");
  chmodSync(launcher, 0o755);
  for (const version of ["1.0.2", "1.2.0"]) {
    const release = path.join(managed, "install/releases", version, "node_modules");
    const entry = cliPackage(path.join(release, "@earendil-works/pi-coding-agent"));
    mkdirSync(path.join(release, ".bin"), { recursive: true });
    symlinkSync(entry, path.join(release, ".bin/pi"));
  }
  const env = { PATH: `${path.join(managed, "bin")}${path.delimiter}${bin}` };
  for (const version of ["1.0.2", "1.2.0"]) {
    writeFileSync(path.join(managed, "install/current-version"), version);
    assert.equal(resolvePiCliPackage(env, root), path.join(managed, "install/releases", version, "node_modules/@earendil-works/pi-coding-agent"));
  }
  writeFileSync(path.join(managed, "install/current-version"), "../../other");
  assert.throws(() => resolvePiCliPackage(env, root), /没有加载 Wand SDK/);
  writeFileSync(launcher, "#!/bin/sh\n# An arbitrary wrapper must not be guessed or executed.\n");
  assert.throws(() => resolvePiCliPackage(env, root), /没有加载 Wand SDK/);
});

for (const allowSdk of [false, true]) test(`real server and CLI settings never load SDK; explicit SDK ${allowSdk ? "loads on demand" : "fails closed"}`, () => {
  const guard = fileURLToPath(new URL("./fixtures/block-pi-sdk.mjs", import.meta.url));
  const source = `
    import assert from "node:assert/strict";
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { defaultConfig } from "./src/config.ts";
    import { startServer } from "./src/server.ts";
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-no-sdk-"));
    const agentDir = path.join(root, "agent");
    mkdirSync(path.join(agentDir, "skills/probe"), { recursive: true });
    writeFileSync(path.join(agentDir, "skills/probe/SKILL.md"), "---\\nname: cli-probe\\ndescription: CLI-only resource\\n---\\n# CLI probe\\n");
    writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-only-not-a-real-key" } }));
    const config = { ...defaultConfig(), host: "127.0.0.1", port: 0, https: false,
      defaultCwd: root, defaultProvider: "pi", startupCommands: [], password: "fixture-only",
      harness: { ...defaultConfig().harness, engine: "auto", agentDir } };
    let handle;
    try {
      handle = await startServer(config, path.join(root, "config.json"));
      const origin = handle.urls[0].url;
      const login = await fetch(origin + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "fixture-only", client: "browser-extension" }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
      const headers = { Cookie: cookie, "Content-Type": "application/json" };
      const cli = await fetch(origin + "/api/sessions", { method: "POST", headers,
        body: JSON.stringify({ kind: "structured", provider: "pi", engine: "cli", cwd: root, mode: "managed", systemPrompt: "CLI isolation probe" }) });
      assert.equal(cli.status, 201, await cli.clone().text());
      const session = await cli.json();
      const settings = await fetch(origin + "/api/sessions/" + session.id + "/pi-settings", { headers });
      assert.equal(settings.status, 200, await settings.clone().text());
      const state = await settings.json();
      assert.equal(state.engine, "cli");
      assert.ok(state.resourceCatalog.skills.some(s => s.name === "cli-probe"));
      assert.equal(globalThis[Symbol.for("wand.sdk.importAttempts")] ?? 0, 0, "CLI startup/settings must never probe SDK");
      const sdk = await fetch(origin + "/api/sessions", { method: "POST", headers,
        body: JSON.stringify({ kind: "structured", provider: "pi", engine: "sdk", cwd: root }) });
      if (${allowSdk}) {
        assert.equal(sdk.status, 201, await sdk.clone().text());
        assert.equal((await sdk.json()).structuredState.engine, "core");
      } else {
        assert.equal(sdk.status, 400);
        assert.match((await sdk.json()).error, /WAND_PI_SDK_IMPORT_BLOCKED/);
        assert.equal(handle.structuredSessions.list().length, 1, "failed SDK selection must leave no session");
      }
      assert.ok(globalThis[Symbol.for("wand.sdk.importAttempts")] > 0, "only explicit SDK selection loads it");
      console.log("CLI_SERVER_WITHOUT_SDK_OK");
    } finally {
      if (handle) await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", guard, "--input-type=module", "-e", source], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, WAND_TEST_MODE: "1", WAND_PATH_REPAIR_DEEP_DISABLE: "1", WAND_SHELL_ENV_DISABLE: "1",
      WAND_PI_SDK_PROBE_ALLOW: allowSdk ? "1" : "0", PI_OFFLINE: "1" },
  });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CLI_SERVER_WITHOUT_SDK_OK/);
});
