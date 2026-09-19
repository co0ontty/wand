import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkProviderCliUpdates,
  homebrewUpdateHint,
  parseBrewInfoVersion,
  parseCliLatestVersionJson,
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
  @qoder-ai/qodercli@latest) echo 0.8.0 ;;
  @earendil-works/pi-coding-agent@latest) echo 0.75.0 ;;
  *) exit 1 ;;
esac`);
  executable(path.join(bin, "claude"), `[ "$1" = "--version" ] && echo '2.1.0 (Claude Code)' || echo claude >> "$UPDATE_LOG"`);
  executable(path.join(bin, "codex"), `[ "$1" = "--version" ] && echo 'codex-cli 0.144.1' || echo codex >> "$UPDATE_LOG"`);
  executable(path.join(bin, "opencode"), `[ "$1" = "--version" ] && echo '1.0.0' || echo opencode >> "$UPDATE_LOG"`);
  executable(path.join(bin, "qodercli"), `[ "$1" = "--version" ] && echo '0.7.0' || echo qoder >> "$UPDATE_LOG"`);
  executable(path.join(bin, "pi"), `[ "$1" = "--version" ] && echo '0.74.0' || echo pi >> "$UPDATE_LOG"`);
  // Grok CLI 没有 npm 渠道，最新版只能问它自己；装在自己的 ~/.grok/bin 下。
  const grokBin = path.join(root, "home", ".grok", "bin");
  mkdirSync(grokBin, { recursive: true });
  executable(path.join(grokBin, "grok"), `
case "$1" in
  --version) echo 'grok 1.0.20 (3736acbc8658)' ;;
  update) [ "$2" = "--check" ] && echo '{"channel":"stable","currentVersion":"1.0.20","latestVersion":"1.0.30","updateAvailable":true}' || echo grok >> "$UPDATE_LOG" ;;
  *) exit 1 ;;
esac`);

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${grokBin}${path.delimiter}${process.env.PATH ?? ""}`, WAND_NPM_BIN: path.join(bin, "npm"), UPDATE_LOG: log };
  const statuses = await checkProviderCliUpdates({ env });
  assert.deepEqual(statuses.map((item) => [item.id, item.currentVersion, item.latestVersion, item.updateAvailable]), [
    ["claude", "2.1.0", "2.2.0", true],
    ["codex", "0.144.1", "0.144.1", false],
    ["opencode", "1.0.0", "1.1.0", true],
    ["grok", "1.0.20", "1.0.30", true],
    ["qoder", "0.7.0", "0.8.0", true],
    ["pi", "0.74.0", "0.75.0", true],
  ]);
  assert.equal(statuses.find((item) => item.id === "grok")?.installKind, "native");

  const results = await updateProviderClis(statuses, undefined, { env });
  assert.deepEqual(results.map((item) => [item.id, item.ok, item.skipped]), [
    ["claude", true, false],
    ["opencode", true, false],
    ["grok", true, false],
    ["qoder", true, false],
    ["pi", true, false],
  ]);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["claude", "opencode", "grok", "qoder", "pi"]);
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

test("self-hosted CLI latest version is parsed from its own JSON check", () => {
  assert.equal(
    parseCliLatestVersionJson('{"channel":"stable","latestVersion":"1.0.30","updateAvailable":true}'),
    "1.0.30",
  );
  assert.equal(parseCliLatestVersionJson('checking...\n{"latestVersion":"1.0.151-alpha.2"}\n'), "1.0.151-alpha.2");
  assert.equal(parseCliLatestVersionJson("no json here"), null);
  assert.equal(parseCliLatestVersionJson('{"currentVersion":"1.0.20"}'), null);
});

test("brew info parsing covers casks and formulae", () => {
  assert.equal(parseBrewInfoVersion('{"formulae":[],"casks":[{"version":"2.1.267"}]}', "cask"), "2.1.267");
  assert.equal(parseBrewInfoVersion('{"formulae":[{"versions":{"stable":"1.2.3"}}]}', "formula"), "1.2.3");
  assert.equal(parseBrewInfoVersion("not json", "cask"), null);
  assert.equal(parseBrewInfoVersion('{"casks":[]}', "cask"), null);
});

test("unreadable CLI versions keep their reason instead of silently showing nothing", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-broken-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  executable(path.join(bin, "npm"), `echo 2.0.0`);
  executable(path.join(bin, "codex"), `exit 1`);

  const env = { PATH: `${bin}${path.delimiter}/usr/bin:/bin`, WAND_NPM_BIN: path.join(bin, "npm") };
  const codex = (await checkProviderCliUpdates({ env })).find((item) => item.id === "codex");
  assert.equal(codex?.installed, true);
  assert.equal(codex?.currentVersion, null);
  assert.equal(codex?.updateAvailable, false);
  assert.match(codex?.error ?? "", /--version/);
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

test("Homebrew-managed CLIs get the brew command instead of a fake failure", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-brew-"));
  const caskroom = path.join(root, "opt", "homebrew", "Caskroom", "claude-code", "2.1.149");
  const bin = path.join(root, "bin");
  mkdirSync(caskroom, { recursive: true });
  mkdirSync(bin, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  executable(path.join(caskroom, "claude"), `[ "$1" = "--version" ] && echo '2.1.149 (Claude Code)' || echo SHOULD_NOT_RUN >> "${path.join(root, "ran.log")}"`);
  symlinkSync(path.join(caskroom, "claude"), path.join(bin, "claude"));
  // npm 故意失败：Homebrew 安装必须走 brew info，而不是拿 npm 的 latest 硬比。
  executable(path.join(bin, "npm"), `exit 1`);
  executable(path.join(bin, "brew"), `[ "$1" = "info" ] && echo '{"formulae":[],"casks":[{"token":"claude-code","version":"2.2.0"}]}' || exit 1`);

  const env = { PATH: `${bin}${path.delimiter}/usr/bin:/bin`, WAND_NPM_BIN: path.join(bin, "npm") };
  const statuses = await checkProviderCliUpdates({ env });
  const claude = statuses.find((item) => item.id === "claude");
  assert.equal(claude?.installKind, "brew");
  assert.equal(claude?.latestVersion, "2.2.0");
  assert.equal(claude?.updateAvailable, true);
  assert.equal(homebrewUpdateHint(claude?.executable ?? null), "brew upgrade claude-code");

  const results = await updateProviderClis(statuses, ["claude"], { env });
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.skipped, true);
  assert.match(results[0]?.message ?? "", /brew upgrade claude-code/);
  assert.throws(() => readFileSync(path.join(root, "ran.log"), "utf8"));
});
