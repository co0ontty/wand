import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    async computeAssetSha256(asset) {
      return createHash("sha256").update(readFileSync(asset.filePath)).digest("hex");
    },
    async resolveLatestDmg() { return null; },
    async resolveMacosDownload() { return null; },
    async resolveLatestIpa() { return null; },
    async resolveIosDownload() { return null; },
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
      sha256: null,
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
      sha256: null,
    });

    const range = await fetch(`${baseUrl}/android/download?channel=stable`, { headers: { Range: "bytes=4-10" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 4-10/11");
    assert.equal(await range.text(), "payload");

    // 下载响应必须携带实际发送字节的 SHA-256，客户端以响应头为准做完整性校验。
    const full = await fetch(`${baseUrl}/android/download?channel=stable`);
    assert.equal(full.status, 200);
    const body = await full.arrayBuffer();
    assert.equal(
      full.headers.get("x-apk-sha256"),
      createHash("sha256").update(new Uint8Array(body)).digest("hex"),
    );

    const missingDmg = await fetch(`${baseUrl}/macos/download`);
    assert.equal(missingDmg.status, 404);
    const missingIpa = await fetch(`${baseUrl}/ios/download`);
    assert.equal(missingIpa.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub APK downloads are proxied through the wand server", async () => {
  const remote = createServer((req, res) => {
    assert.equal(req.headers["user-agent"], "wand-server");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": "11",
    });
    res.end("apk-payload");
  });
  await new Promise<void>((resolve, reject) => {
    remote.once("error", reject);
    remote.listen(0, "127.0.0.1", () => {
      remote.off("error", reject);
      resolve();
    });
  });

  const app = express();
  const remoteAddress = remote.address() as AddressInfo;
  registerPublicUpdateRoutes(app, {
    async resolveLatestApk() { return null; },
    async resolveAndroidDownload() { return null; },
    async resolveGitHubApkDownload() {
      return {
        remoteUrl: `http://127.0.0.1:${remoteAddress.port}/wand-v3.0.0%2B1.apk`,
        fileName: "wand-v3.0.0-1.apk",
        size: 11,
        sha256: "abc123",
      };
    },
    async computeAssetSha256() { return null; },
    async resolveLatestDmg() { return null; },
    async resolveMacosDownload() { return null; },
    async resolveLatestIpa() { return null; },
    async resolveIosDownload() { return null; },
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
    const missing = await fetch(`http://127.0.0.1:${address.port}/android/download?source=github`);
    assert.equal(missing.status, 200);
    assert.equal(missing.headers.get("x-apk-sha256"), "abc123");
    assert.equal(missing.headers.get("content-length"), "11");
    assert.equal(await missing.text(), "apk-payload");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
  }
});
