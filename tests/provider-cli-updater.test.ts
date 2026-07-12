import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkProviderCliUpdates,
  parseProviderCliVersion,
  providerCliUpdateAvailable,
  updateProviderClis,
  verifyProviderCliUpdateResults,
} from "../src/provider-cli-updater.js";

function executable(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
}

test("provider CLI updater detects versions and only updates outdated tools", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-updater-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "updates.log");
  mkdirSync(bin);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  executable(path.join(bin, "npm"), `
case "$2" in
  @anthropic-ai/claude-code@latest) echo 2.2.0 ;;
  @openai/codex@latest) echo 0.144.1 ;;
  opencode-ai@latest) echo 1.1.0 ;;
  *) exit 1 ;;
esac`);
  executable(path.join(bin, "claude"), `[ "$1" = "--version" ] && echo '2.1.0 (Claude Code)' || echo claude >> "$UPDATE_LOG"`);
  executable(path.join(bin, "codex"), `[ "$1" = "--version" ] && echo 'codex-cli 0.144.1' || echo codex >> "$UPDATE_LOG"`);
  executable(path.join(bin, "opencode"), `[ "$1" = "--version" ] && echo '1.0.0' || echo opencode >> "$UPDATE_LOG"`);

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, WAND_NPM_BIN: path.join(bin, "npm"), UPDATE_LOG: log };
  const statuses = await checkProviderCliUpdates({ env });
  assert.deepEqual(statuses.map((item) => [item.id, item.currentVersion, item.latestVersion, item.updateAvailable]), [
    ["claude", "2.1.0", "2.2.0", true],
    ["codex", "0.144.1", "0.144.1", false],
    ["opencode", "1.0.0", "1.1.0", true],
  ]);

  const results = await updateProviderClis(statuses, undefined, { env });
  assert.deepEqual(results.map((item) => [item.id, item.ok, item.skipped]), [
    ["claude", true, false],
    ["opencode", true, false],
  ]);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["claude", "opencode"]);
});

test("legacy OpenCode is reported without running an unsafe automatic migration", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-legacy-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  executable(path.join(bin, "npm"), `echo 1.1.0`);
  executable(path.join(bin, "opencode"), `echo 0.0.55`);

  const env = { PATH: `${bin}${path.delimiter}/usr/bin:/bin`, WAND_NPM_BIN: path.join(bin, "npm") };
  const statuses = await checkProviderCliUpdates({ env });
  const opencode = statuses.find((item) => item.id === "opencode");
  assert.equal(opencode?.currentVersion, "0.0.55");
  assert.equal(opencode?.updateAvailable, true);
  assert.equal(opencode?.updateSupported, false);
  assert.equal(opencode?.installKind, "legacy");
  assert.match(opencode?.error ?? "", /opencode-ai@latest/);
});

test("provider CLI version helpers use semantic versions", () => {
  assert.equal(parseProviderCliVersion("codex-cli 0.144.1"), "0.144.1");
  assert.equal(providerCliUpdateAvailable("1.9.0", "1.10.0"), true);
  assert.equal(providerCliUpdateAvailable("2.0.0", "1.10.0"), false);
});

test("provider CLI update verification detects a stale active binary", () => {
  const result = verifyProviderCliUpdateResults([{
    id: "codex",
    label: "Codex",
    ok: true,
    skipped: false,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    message: "done",
  }], [{
    id: "codex",
    label: "Codex",
    command: "codex",
    executable: "/tmp/codex",
    installed: true,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateAvailable: true,
    updateSupported: true,
    installKind: "npm",
  }]);
  assert.equal(result[0]?.ok, false);
  assert.match(result[0]?.message ?? "", /多份安装/);
});
