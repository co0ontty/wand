import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { jsonErrorHandler } from "../src/express-async.js";
import { registerPublicUpdateRoutes } from "../src/server-update-routes.js";

test("extracted public update routes preserve metadata, channel, range, and missing-asset behavior", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-update-routes-"));
  const apkPath = path.join(root, "wand.apk");
  writeFileSync(apkPath, "apk-payload");
  const app = express();
  registerPublicUpdateRoutes(app, {
    async resolveLatestApk(channel) {
      return {
        version: channel === "beta" ? "2.0.0-debug.07150800" : "2.0.0",
        downloadUrl: `/android/download?channel=${channel}`,
        fileName: "wand.apk",
        size: 11,
        source: "local",
        releaseNotes: "notes",
      };
    },
    async resolveAndroidDownload(channel) {
      return channel === "stable" ? { fileName: "wand.apk", filePath: apkPath, size: 11 } : null;
    },
    async resolveLatestDmg() { return null; },
    async resolveMacosDownload() { return null; },
  });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const missingVersion = await fetch(`${baseUrl}/api/android-apk-update`);
    assert.equal(missingVersion.status, 400);

    const metadata = await fetch(`${baseUrl}/api/android-apk-update?currentVersion=1.0.0&channel=stable`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), {
      updateAvailable: true,
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      downloadUrl: "/android/download?channel=stable",
      fileName: "wand.apk",
      size: 11,
      source: "local",
      channel: "stable",
      releaseNotes: "notes",
    });

    const betaAfterRelease = await fetch(
      `${baseUrl}/api/android-apk-update?currentVersion=2.0.0&channel=beta`,
    );
    assert.equal(betaAfterRelease.status, 200);
    assert.deepEqual(await betaAfterRelease.json(), {
      updateAvailable: true,
      currentVersion: "2.0.0",
      latestVersion: "2.0.0-debug.07150800",
      downloadUrl: "/android/download?channel=beta",
      fileName: "wand.apk",
      size: 11,
      source: "local",
      channel: "beta",
      releaseNotes: "notes",
    });

    const range = await fetch(`${baseUrl}/android/download?channel=stable`, { headers: { Range: "bytes=4-10" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 4-10/11");
    assert.equal(await range.text(), "payload");

    const missingDmg = await fetch(`${baseUrl}/macos/download`);
    assert.equal(missingDmg.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
