import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { registerPublicUpdateRoutes } from "../src/server-update-routes.js";

import {
  absoluteUrl,
  buildIosInstallPage,
  buildIosOtaManifest,
  buildItmsServicesUrl,
  collectIosOtaBlockers,
  inspectIpa,
  publicOriginFromRequest,
} from "../src/ios-ota.js";

function createStoredZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 16);
    local.writeUInt32LE(data.length, 20);
    local.writeUInt16LE(nameBuf.length, 26);
    const localRecord = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

test("inspectIpa reads XML Info.plist and signing markers", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ios-ota-"));
  try {
    const unsignedPath = path.join(root, "unsigned.ipa");
    writeFileSync(unsignedPath, createStoredZip({
      "Payload/Wand.app/Info.plist": `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleIdentifier</key><string>com.wand.app</string>
<key>CFBundleShortVersionString</key><string>4.52.0-debug.09061350</string>
<key>CFBundleVersion</key><string>45200.09061350</string>
<key>CFBundleDisplayName</key><string>Wand</string>
</dict></plist>`,
    }));
    const unsigned = await inspectIpa(unsignedPath);
    assert.equal(unsigned.bundleId, "com.wand.app");
    assert.equal(unsigned.bundleVersion, "4.52.0-debug.09061350");
    assert.equal(unsigned.bundleBuild, "45200.09061350");
    assert.equal(unsigned.signed, false);

    const signedPath = path.join(root, "signed.ipa");
    writeFileSync(signedPath, createStoredZip({
      "Payload/Wand.app/Info.plist": unsignedPath ? `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleIdentifier</key><string>com.wand.app</string>
<key>CFBundleShortVersionString</key><string>4.52.1</string>
<key>CFBundleName</key><string>Wand</string>
</dict></plist>` : "",
      "Payload/Wand.app/embedded.mobileprovision": "profile",
    }));
    const signed = await inspectIpa(signedPath);
    assert.equal(signed.signed, true);
    assert.equal(signed.bundleVersion, "4.52.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OTA helpers encode itms-services URLs and HTTPS blockers", () => {
  const origin = publicOriginFromRequest({
    protocol: "http",
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "home.huniu.fun:8443",
    },
  });
  assert.equal(origin, "https://home.huniu.fun:8443");
  const manifestUrl = absoluteUrl(origin!, "/ios/manifest.plist");
  assert.equal(manifestUrl, "https://home.huniu.fun:8443/ios/manifest.plist");
  assert.equal(
    buildItmsServicesUrl(manifestUrl),
    "itms-services://?action=download-manifest&url=https%3A%2F%2Fhome.huniu.fun%3A8443%2Fios%2Fmanifest.plist",
  );
  assert.deepEqual(collectIosOtaBlockers({
    signed: false,
    origin,
    source: "local",
  }), ["unsigned-ipa"]);
  const manifest = buildIosOtaManifest({
    ipaUrl: "https://home.huniu.fun:8443/ios/download",
    bundleId: "com.wand.app",
    bundleVersion: "4.52.0",
    title: "Wand",
  });
  assert.match(manifest, /software-package/);
  assert.match(manifest, /com.wand.app/);
});

test("iOS install page requests confirmation once on load, retaining the manual link", () => {
  const installUrl = buildItmsServicesUrl("https://updates.example.test/ios/manifest.plist");
  const options = {
    title: "Wand",
    version: "4.96.0",
    sizeLabel: "30 MB",
    installUrl,
    downloadUrl: "https://updates.example.test/ios/download",
    signed: true,
    https: true,
  };
  const html = buildIosInstallPage(options);
  assert.match(html, /id="ios-install" class="install" href="itms-services:\/\//);
  assert.match(html, /若未弹出，请点击上方安装按钮/);
  assert.ok(html.indexOf('<a id="ios-install"') < html.indexOf("<script>"), "link exists before automatic handoff");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const [userAgent, platform, maxTouchPoints, expected] of [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", "iPhone", 5, 1],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", "iPad", 5, 1],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/26.0 Safari/605.1.15", "MacIntel", 5, 1],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15", "MacIntel", 0, 0],
    ["Mozilla/5.0 (Linux; Android 16)", "Linux", 5, 0],
  ] as const) {
    let clicks = 0;
    runInNewContext(scripts[0][1], {
      navigator: { userAgent, platform, maxTouchPoints },
      document: { getElementById: (id: string) => {
        assert.equal(id, "ios-install");
        return { click: () => { clicks += 1; } };
      } },
      // A rejected/cancelled handoff must never cause periodic re-prompts.
      setTimeout: () => assert.fail("must not schedule automatic retries"),
      setInterval: () => assert.fail("must not schedule automatic retries"),
      addEventListener: () => assert.fail("must not re-prompt when returning to the page"),
    });
    assert.equal(clicks, expected, userAgent);
  }
  for (const blocked of [
    { signed: false },
    { https: false },
    { installUrl: "#" },
  ]) {
    const page = buildIosInstallPage({ ...options, ...blocked });
    assert.doesNotMatch(page, /<script>/);
    assert.doesNotMatch(page, /会自动请求/);
    assert.match(page, /id="ios-install"/, "manual entry remains available");
  }
  const escaped = buildIosInstallPage({ ...options, title: '</script><script>alert("x")</script>' });
  assert.equal([...escaped.matchAll(/<script>/g)].length, 1, "metadata cannot inject scripts");
});

test("iOS install manifest uses the IPA build while update checks retain marketing versions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ios-ota-route-"));
  const filePath = path.join(root, "wand.ipa");
  const version = "4.96.0-debug.10162050";
  writeFileSync(filePath, createStoredZip({
    "Payload/Wand.app/Info.plist": `<?xml version="1.0"?><plist><dict>
<key>CFBundleIdentifier</key><string>com.example.wand</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>49600.10162050</string>
</dict></plist>`,
    "Payload/Wand.app/embedded.mobileprovision": "profile-marker",
  }));
  const app = express();
  registerPublicUpdateRoutes(app, {
    resolveLatestApk: async () => null,
    resolveAndroidDownload: async () => null,
    computeAssetSha256: async () => null,
    resolveLatestDmg: async () => null,
    resolveMacosDownload: async () => null,
    resolveLatestMacosBeta: async () => null,
    resolveMacosBetaDownload: async () => null,
    resolveLatestIpa: async () => ({ version, downloadUrl: "/ios/download", fileName: "wand.ipa", size: 1, source: "local" }),
    resolveIosDownload: async () => ({ filePath, fileName: "wand.ipa", size: 1 }),
  }, "https://updates.example.test");
  const server = createServer(app);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/ios/manifest.plist`);
    assert.equal(response.status, 200);
    const manifest = await response.text();
    assert.match(manifest, /<key>bundle-version<\/key>\s*<string>49600\.10162050<\/string>/);
    assert.doesNotMatch(manifest, /4\.96\.0-debug/);
    const update = await (await fetch(`${origin}/api/ios-ipa-update?currentVersion=0.0.0`)).json();
    assert.equal(update.latestVersion, version);
    assert.equal(update.bundleId, "com.example.wand");
    assert.equal(update.updateAvailable, true);
    assert.equal(update.otaReady, true);
    const installPage = await (await fetch(`${origin}/ios/install`)).text();
    assert.match(installPage, /document.getElementById\("ios-install"\).click\(\)/);
    assert.ok(installPage.includes(buildItmsServicesUrl(update.manifestUrl).replaceAll("&", "&amp;")));
    const same = await (await fetch(`${origin}/api/ios-ipa-update?currentVersion=${version}`)).json();
    assert.equal(same.updateAvailable, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
