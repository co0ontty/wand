import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { DistributionManager } from "../src/distribution-manager.js";
import { registerPublicUpdateRoutes } from "../src/server-update-routes.js";
import type { WandConfig } from "../src/types.js";

for (const reject of [false, true]) test(`public native downloads preserve distribution receiver and tolerate cleanup failure (${reject})`, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-bound-prune-"));
  const configPath = path.join(root, "config.json");
  const config = { android: { enabled: true, apkDir: "android", currentApkFile: "" },
    macos: { enabled: true, dmgDir: "macos", currentDmgFile: "" },
    ios: { enabled: true, ipaDir: "ios", currentIpaFile: "" } } as WandConfig;
  writeFileSync(configPath, JSON.stringify(config));
  const files = [["android", "apk"], ["macos", "zip"], ["ios", "ipa"]] as const;
  for (const [platform, ext] of files) {
    mkdirSync(path.join(root, platform));
    writeFileSync(path.join(root, platform, `wand-v1.0.0.${ext}`), "old");
    writeFileSync(path.join(root, platform, `wand-v1.0.1-debug.10211200.${ext}`), platform + " payload");
  }
  class ObservedDistribution extends DistributionManager {
    readonly calls: Array<{ platform: string; file?: string }> = [];
    override async pruneAndroidApkDirectory(file?: string) {
      this.calls.push({ platform: "android", file });
      if (reject) throw new Error("simulated cleanup failure");
      return super.pruneAndroidApkDirectory(file);
    }
    override async pruneMacosBetaDirectory(file?: string) {
      this.calls.push({ platform: "macos", file });
      if (reject) throw new Error("simulated cleanup failure");
      return super.pruneMacosBetaDirectory(file);
    }
    override async pruneIosIpaDirectory(file?: string) {
      this.calls.push({ platform: "ios", file });
      if (reject) throw new Error("simulated cleanup failure");
      return super.pruneIosIpaDirectory(file);
    }
  }
  const manager = new ObservedDistribution({ configDir: root, configPath, config,
    repositoryUrl: "https://github.com/example/wand", fetch: async () => new Response("[]") });
  const app = express(); registerPublicUpdateRoutes(app, manager);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const routes = ["/android/download?channel=beta", "/macos/update-download?fileName=wand-v1.0.1-debug.10211200.zip", "/ios/download"];
  assert.equal(manager.calls.length, 0, "registering/read setup never prunes files");
  for (const [index, [platform, ext]] of files.entries()) {
    const response = await fetch(base + routes[index]);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), platform + " payload", "cleanup failure must not block downloads");
    assert.equal(existsSync(path.join(root, platform, `wand-v1.0.0.${ext}`)), reject);
    assert.ok(existsSync(path.join(root, platform, `wand-v1.0.1-debug.10211200.${ext}`)), "never prune the asset being sent");
  }
  assert.deepEqual(manager.calls, files.map(([platform, ext]) => ({ platform, file: `wand-v1.0.1-debug.10211200.${ext}` })));
});
