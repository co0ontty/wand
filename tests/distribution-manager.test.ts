import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DistributionManager,
  extractUpdateSummary,
  parseGithubDigest,
  sanitizeApkFileName,
} from "../src/distribution-manager.js";
import type { WandConfig } from "../src/types.js";

function createFixture(releases: unknown[] = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-distribution-"));
  const configPath = path.join(root, "config.json");
  const config = {
    android: { enabled: true, apkDir: "android", currentApkFile: "" },
    macos: { enabled: true, dmgDir: "macos", currentDmgFile: "" },
    ios: { enabled: true, ipaDir: "ios", currentIpaFile: "" },
  } as WandConfig;
  writeFileSync(configPath, JSON.stringify(config));
  mkdirSync(path.join(root, "android"));
  mkdirSync(path.join(root, "macos"));
  mkdirSync(path.join(root, "ios"));
  let fetchCount = 0;
  const manager = new DistributionManager({
    configDir: root,
    configPath,
    config,
    repositoryUrl: "https://github.com/example/wand",
    fetch: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify(releases), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { root, configPath, config, manager, fetchCount: () => fetchCount };
}

test("DistributionManager applies stable and beta APK selection behind one interface", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.root, "android", "wand-v2.0.0.apk"), "release");
    writeFileSync(path.join(fixture.root, "android", "wand-v2.0.0-debug.07151230.apk"), "debug");

    const stable = await fixture.manager.resolveLatestApk("stable");
    const beta = await fixture.manager.resolveLatestApk("beta");

    assert.equal(stable?.fileName, "wand-v2.0.0.apk");
    assert.equal(stable?.downloadUrl, "/android/download?channel=stable");
    assert.equal(beta?.fileName, "wand-v2.0.0-debug.07151230.apk");
    assert.equal(beta?.downloadUrl, "/android/download?channel=beta");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("macOS Beta selects local ZIP over DMG, never GitHub, and pins its download", async () => {
  const fixture = createFixture([{
    tag_name: "v99.0.0",
    assets: [{ name: "wand-v99.0.0.dmg", browser_download_url: "https://example.test/remote.dmg", size: 10 }],
  }]);
  try {
    const directory = path.join(fixture.root, "macos");
    writeFileSync(path.join(directory, "wand-v4.72.2.dmg"), "old");
    writeFileSync(path.join(directory, "wand-v4.72.2-debug.09230741.dmg"), "dmg");
    writeFileSync(path.join(directory, "wand-v4.72.2-debug.09230741.zip"), "zip");
    const latest = await fixture.manager.resolveLatestMacosBeta();
    assert.equal(latest?.version, "4.72.2-debug.09230741");
    assert.equal(latest?.fileName, "wand-v4.72.2-debug.09230741.zip");
    assert.equal(latest?.downloadUrl, "/macos/update-download?fileName=wand-v4.72.2-debug.09230741.zip");
    assert.equal(latest?.sha256, (await import("node:crypto")).createHash("sha256").update("zip").digest("hex"));
    assert.equal(fixture.fetchCount(), 0);
    assert.equal((await fixture.manager.resolveMacosBetaDownload(latest!.fileName))?.fileName, latest?.fileName);
    assert.equal(await fixture.manager.resolveMacosBetaDownload("../config.json"), null);
    assert.equal(await fixture.manager.resolveMacosBetaDownload("wand-v4.72.2.update.json"), null);
    symlinkSync(fixture.configPath, path.join(directory, "wand-v4.72.2-debug.09230742.zip"));
    assert.equal(await fixture.manager.resolveMacosBetaDownload("wand-v4.72.2-debug.09230742.zip"), null);
    writeFileSync(path.join(directory, "wand-v4.72.3-debug.09231234.dmg"), "newer");
    assert.equal((await fixture.manager.resolveLatestMacosBeta())?.fileName, "wand-v4.72.3-debug.09231234.dmg");
    assert.equal((await fixture.manager.resolveMacosBetaDownload(latest!.fileName))?.fileName, latest?.fileName);
    writeFileSync(fixture.configPath, JSON.stringify({ macos: { enabled: false } }));
    assert.equal(await fixture.manager.resolveLatestMacosBeta(), null);
    assert.equal(await fixture.manager.resolveMacosBetaDownload(latest!.fileName), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DistributionManager compares local and GitHub APKs and caches the external adapter", async () => {
  const fixture = createFixture([{
    tag_name: "v3.0.0",
    body: "## 更新内容\n\n- Android 修复\n\n---\n\n## macOS DMG\n\nmacOS 安装说明",
    assets: [{
      name: "wand-v3.0.0+202607041230.apk",
      browser_download_url: "https://example.test/wand-v3.0.0%2B202607041230.apk",
      size: 42,
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }],
  }]);
  try {
    writeFileSync(path.join(fixture.root, "android", "wand-v2.0.0.apk"), "old");

    const first = await fixture.manager.resolveLatestApk("stable");
    const second = await fixture.manager.resolveLatestApk("stable");
    const proxied = await fixture.manager.resolveGitHubApkDownload();

    assert.equal(first?.source, "github");
    assert.equal(first?.version, "3.0.0+202607041230");
    assert.equal(first?.fileName, "wand-v3.0.0-202607041230.apk");
    assert.equal(first?.downloadUrl, "/android/download?channel=stable&source=github");
    assert.equal(first?.sha256, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(first?.releaseNotes, "## 更新内容\n\n- Android 修复");
    assert.deepEqual(second, first);
    assert.equal(proxied?.remoteUrl, "https://example.test/wand-v3.0.0%2B202607041230.apk");
    assert.equal(proxied?.fileName, "wand-v3.0.0-202607041230.apk");
    assert.equal(fixture.fetchCount(), 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("extractUpdateSummary excludes platform download instructions from Android dialogs", () => {
  assert.equal(
    extractUpdateSummary("更新内容\r\n---\r\n## Android APK\r\n安装说明"),
    "更新内容",
  );
});

test("sanitizeApkFileName replaces GitHub build-metadata plus signs", () => {
  assert.equal(
    sanitizeApkFileName("wand-v4.48.0+202608232136.apk"),
    "wand-v4.48.0-202608232136.apk",
  );
  assert.equal(sanitizeApkFileName("../evil+name.apk"), "evil-name.apk");
});

test("parseGithubDigest only accepts sha256 hex digests", () => {
  assert.equal(
    parseGithubDigest("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(parseGithubDigest("sha256:deadbeef"), undefined);
  assert.equal(parseGithubDigest(undefined), undefined);
});

test("DistributionManager hot-refreshes config and builds settings for both artifacts", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.root, "android", "wand-v2.1.0.apk"), "apk");
    writeFileSync(path.join(fixture.root, "macos", "wand-v2.2.0.dmg"), "dmg");
    writeFileSync(path.join(fixture.root, "ios", "wand-v2.3.0.ipa"), "ipa");

    const settings = await fixture.manager.getSettings();
    assert.equal(settings.androidApk.fileName, "wand-v2.1.0.apk");
    assert.equal(settings.androidApk.hasApk, true);
    assert.equal(settings.macosDmg.fileName, "wand-v2.2.0.dmg");
    assert.equal(settings.macosDmg.hasDmg, true);
    assert.equal(settings.iosIpa.fileName, "wand-v2.3.0.ipa");
    assert.equal(settings.iosIpa.hasIpa, true);

    writeFileSync(fixture.configPath, JSON.stringify({
      android: { enabled: false },
      macos: { enabled: false },
      ios: { enabled: false },
    }));
    assert.equal(await fixture.manager.resolveAndroidDownload("beta"), null);
    assert.equal(await fixture.manager.resolveMacosDownload(), null);
    assert.equal(await fixture.manager.resolveIosDownload(), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pruneAndroidApkDirectory keeps only the newest APK", async () => {
  const fixture = createFixture();
  try {
    const dir = path.join(fixture.root, "android");
    writeFileSync(path.join(dir, "wand-v4.44.0-debug.08211000.apk"), "old-1");
    writeFileSync(path.join(dir, "wand-v4.45.0.apk"), "stable");
    writeFileSync(path.join(dir, "wand-v4.46.0-debug.08221200.apk"), "newest");
    // 非 APK 文件不受影响。
    writeFileSync(path.join(dir, "notes.txt"), "keep me");

    const pruned = await fixture.manager.pruneAndroidApkDirectory(
      "wand-v4.46.0-debug.08221200.apk");

    assert.deepEqual(pruned.deleted.sort(), [
      "wand-v4.44.0-debug.08211000.apk",
      "wand-v4.45.0.apk",
    ]);
    assert.equal(pruned.freedBytes, "old-1".length + "stable".length);
    const remaining = (await import("node:fs")).readdirSync(dir).sort();
    assert.deepEqual(remaining, ["notes.txt", "wand-v4.46.0-debug.08221200.apk"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pruneAndroidApkDirectory never deletes the pinned currentApkFile", async () => {
  const fixture = createFixture();
  try {
    const dir = path.join(fixture.root, "android");
    writeFileSync(path.join(dir, "wand-v4.44.0.apk"), "pinned-stable");
    writeFileSync(path.join(dir, "wand-v4.45.0.apk"), "mid");
    writeFileSync(path.join(dir, "wand-v4.46.0-debug.08221200.apk"), "newest");
    writeFileSync(fixture.configPath, JSON.stringify({
      android: { enabled: true, apkDir: "android", currentApkFile: "wand-v4.44.0.apk" },
      macos: { enabled: false },
      ios: { enabled: false },
    }));

    const pruned = await fixture.manager.pruneAndroidApkDirectory(
      "wand-v4.46.0-debug.08221200.apk");

    assert.deepEqual(pruned.deleted, ["wand-v4.45.0.apk"]);
    const remaining = (await import("node:fs")).readdirSync(dir).sort();
    assert.deepEqual(remaining, [
      "wand-v4.44.0.apk",
      "wand-v4.46.0-debug.08221200.apk",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pruneAndroidApkDirectory is a no-op when android distribution is disabled", async () => {
  const fixture = createFixture();
  try {
    const dir = path.join(fixture.root, "android");
    writeFileSync(path.join(dir, "wand-v4.44.0.apk"), "a");
    writeFileSync(path.join(dir, "wand-v4.45.0.apk"), "b");
    writeFileSync(fixture.configPath, JSON.stringify({
      android: { enabled: false },
      macos: { enabled: false },
      ios: { enabled: false },
    }));

    const pruned = await fixture.manager.pruneAndroidApkDirectory();
    assert.deepEqual(pruned, { deleted: [], freedBytes: 0 });
    assert.equal((await import("node:fs")).readdirSync(dir).length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pruneMacosBetaDirectory keeps the newest complete set and drops older builds with sidecars", async () => {
  const fixture = createFixture();
  try {
    const dir = path.join(fixture.root, "macos");
    // 旧版本：zip + dmg + update.json 一整套，应整体删除。
    writeFileSync(path.join(dir, "wand-v4.96.0-debug.10181200.zip"), "old-zip");
    writeFileSync(path.join(dir, "wand-v4.96.0-debug.10181200.dmg"), "old-dmg");
    writeFileSync(path.join(dir, "wand-v4.96.0-debug.10181200.update.json"), "{}");
    // 同版本更早一次构建，同样应删除。
    writeFileSync(path.join(dir, "wand-v4.97.1-debug.10181725.zip"), "mid-zip");
    writeFileSync(path.join(dir, "wand-v4.97.1-debug.10181725.update.json"), "{}");
    // 最新版本（同版本里构建时间戳最大的那次）：zip + dmg + update.json 整套保留。
    writeFileSync(path.join(dir, "wand-v4.97.1-debug.10181740.zip"), "new-zip");
    writeFileSync(path.join(dir, "wand-v4.97.1-debug.10181740.dmg"), "new-dmg");
    writeFileSync(path.join(dir, "wand-v4.97.1-debug.10181740.update.json"), "{}");

    const pruned = await fixture.manager.pruneMacosBetaDirectory("wand-v4.97.1-debug.10181740.zip");

    assert.deepEqual(pruned.deleted.sort(), [
      "wand-v4.96.0-debug.10181200.dmg",
      "wand-v4.96.0-debug.10181200.update.json",
      "wand-v4.96.0-debug.10181200.zip",
      "wand-v4.97.1-debug.10181725.update.json",
      "wand-v4.97.1-debug.10181725.zip",
    ]);
    assert.ok(pruned.freedBytes > 0);
    const remaining = (await import("node:fs")).readdirSync(dir).sort();
    assert.deepEqual(remaining, [
      "wand-v4.97.1-debug.10181740.dmg",
      "wand-v4.97.1-debug.10181740.update.json",
      "wand-v4.97.1-debug.10181740.zip",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pruneMacosBetaDirectory keeps the whole set for the pinned currentDmgFile version", async () => {
  const fixture = createFixture();
  try {
    const dir = path.join(fixture.root, "macos");
    writeFileSync(path.join(dir, "wand-v4.90.0.zip"), "pinned-zip");
    writeFileSync(path.join(dir, "wand-v4.90.0.dmg"), "pinned-dmg");
    writeFileSync(path.join(dir, "wand-v4.91.0.zip"), "older-unpinned");
    writeFileSync(path.join(dir, "wand-v4.99.0-debug.10190000.zip"), "newest");
    writeFileSync(fixture.configPath, JSON.stringify({
      android: { enabled: false },
      macos: { enabled: true, dmgDir: "macos", currentDmgFile: "wand-v4.90.0.dmg" },
      ios: { enabled: false },
    }));

    const pruned = await fixture.manager.pruneMacosBetaDirectory();

    // 固定指向 v4.90.0 时该版本整套保留；最新一套（v4.99.0）也总保留；只删两者之间的。
    assert.deepEqual(pruned.deleted, ["wand-v4.91.0.zip"]);
    const remaining = (await import("node:fs")).readdirSync(dir).sort();
    assert.deepEqual(remaining, [
      "wand-v4.90.0.dmg",
      "wand-v4.90.0.zip",
      "wand-v4.99.0-debug.10190000.zip",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pruneIosIpaDirectory keeps only the newest IPA and honours currentIpaFile", async () => {
  const fixture = createFixture();
  try {
    const dir = path.join(fixture.root, "ios");
    writeFileSync(path.join(dir, "wand-v4.95.0-debug.10181000.ipa"), "pinned");
    writeFileSync(path.join(dir, "wand-v4.96.0-debug.10181100.ipa"), "mid");
    writeFileSync(path.join(dir, "wand-v4.97.0-debug.10181440.ipa"), "newest");
    writeFileSync(fixture.configPath, JSON.stringify({
      android: { enabled: false },
      macos: { enabled: false },
      ios: { enabled: true, ipaDir: "ios", currentIpaFile: "wand-v4.95.0-debug.10181000.ipa" },
    }));

    const pruned = await fixture.manager.pruneIosIpaDirectory();

    assert.deepEqual(pruned.deleted, ["wand-v4.96.0-debug.10181100.ipa"]);
    const remaining = (await import("node:fs")).readdirSync(dir).sort();
    assert.deepEqual(remaining, [
      "wand-v4.95.0-debug.10181000.ipa",
      "wand-v4.97.0-debug.10181440.ipa",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("macOS pruning and update selection agree on the same newest candidate", async () => {
  const fixture = createFixture();
  try {
    const dir = path.join(fixture.root, "macos");
    // 同版本 zip 与 dmg 的 mtime 顺序与「zip 优先」相反，用来固定 tie-break 方向。
    writeFileSync(path.join(dir, "wand-v4.97.1-debug.10181725.dmg"), "dmg");
    writeFileSync(path.join(dir, "wand-v4.97.1-debug.10181725.zip"), "zip");
    const selected = await fixture.manager.resolveLatestMacosBeta();
    assert.equal(selected?.fileName, "wand-v4.97.1-debug.10181725.zip");

    writeFileSync(path.join(dir, "wand-v4.97.0-debug.10181440.zip"), "old");
    const pruned = await fixture.manager.pruneMacosBetaDirectory();
    // 被清理的必须正好是「更新检查不会选」的那些。
    assert.deepEqual(pruned.deleted, ["wand-v4.97.0-debug.10181440.zip"]);
    assert.equal((await fixture.manager.resolveLatestMacosBeta())?.fileName, selected?.fileName);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
