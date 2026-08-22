import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DistributionManager, extractUpdateSummary } from "../src/distribution-manager.js";
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

test("DistributionManager compares local and GitHub APKs and caches the external adapter", async () => {
  const fixture = createFixture([{
    tag_name: "v3.0.0",
    body: "## 更新内容\n\n- Android 修复\n\n---\n\n## macOS DMG\n\nmacOS 安装说明",
    assets: [{
      name: "wand-v3.0.0.apk",
      browser_download_url: "https://example.test/wand-v3.0.0.apk",
      size: 42,
    }],
  }]);
  try {
    writeFileSync(path.join(fixture.root, "android", "wand-v2.0.0.apk"), "old");

    const first = await fixture.manager.resolveLatestApk("stable");
    const second = await fixture.manager.resolveLatestApk("stable");

    assert.equal(first?.source, "github");
    assert.equal(first?.version, "3.0.0");
    assert.equal(first?.releaseNotes, "## 更新内容\n\n- Android 修复");
    assert.deepEqual(second, first);
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
