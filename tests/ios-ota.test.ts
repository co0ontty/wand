import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { registerPublicUpdateRoutes } from "../src/server-update-routes.js";
import { DistributionManager } from "../src/distribution-manager.js";
import { jsonErrorHandler } from "../src/express-async.js";
import type { WandConfig } from "../src/types.js";

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
    assert.match(installPage, /aria-label="可安装的应用"/);
    assert.match(installPage, /aria-current="page"/);
    assert.doesNotMatch(installPage, /app=huniu-helper/, "missing independent app is not listed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent iOS app OTA stays isolated, compares builds, pins artifacts and rejects invalid selectors", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ios-independent-"));
  const directory = path.join(root, "apps/huniu-helper/ios");
  mkdirSync(directory, { recursive: true });
  mkdirSync(path.join(root, "ios"));
  const config = { ios: { enabled: true, ipaDir: "ios", currentIpaFile: "wand-v5.0.0.ipa" } } as WandConfig;
  const configPath = path.join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const packageData = (bundle: string, build: string, title = bundle === "com.wand.app" ? "Wand" : "虎妞帮手") => createStoredZip({
    "Payload/App.app/Info.plist": `<plist><dict>
<key>CFBundleIdentifier</key><string>${bundle}</string>
<key>CFBundleDisplayName</key><string>${title}</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>${build}</string></dict></plist>`,
    "Payload/App.app/embedded.mobileprovision": "signing-marker",
  });
  const fileName = "huniu-helper-v0.1.0-2-abcdef.ipa";
  const data = packageData("dev.tigertools.PlaylistBridge", "2");
  writeFileSync(path.join(directory, fileName), data);
  const pointTo = (name: string) => writeFileSync(path.join(directory, "current.json"), JSON.stringify({ fileName: name }));
  pointTo(fileName);
  writeFileSync(path.join(root, "ios/wand-v5.0.0.ipa"), packageData("com.wand.app", "50000"));
  writeFileSync(path.join(root, "ios/wand-v4.0.0.ipa"), "old-wand");
  let remoteRequests = 0;
  const manager = new DistributionManager({
    configDir: root, configPath, config, repositoryUrl: "https://github.com/example/wand",
    fetch: async () => { remoteRequests++; return new Response("[]"); },
  });
  const app = express();
  registerPublicUpdateRoutes(app, manager, "https://updates.example.test");
  app.use(jsonErrorHandler);
  const server = createServer(app);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const get = (route: string) => fetch(origin + route);
    const check = (build: string) => get(`/api/ios-ipa-update?app=huniu-helper&currentVersion=0.1.0&currentBuild=${build}`);
    const metadata = await (await check("1")).json();
    assert.equal(metadata.updateAvailable, true);
    assert.equal(metadata.latestBuild, "2");
    assert.equal(metadata.bundleId, "dev.tigertools.PlaylistBridge");
    assert.equal(metadata.otaReady, true);
    assert.ok(metadata.manifestUrl.includes("app=huniu-helper&fileName="));
    assert.equal((await (await check("2")).json()).updateAvailable, false);
    assert.equal((await (await check("3")).json()).updateAvailable, false);
    const page = await (await get("/ios/install?app=huniu-helper")).text();
    assert.match(page, /安装 虎妞帮手/);
    assert.match(page, /0\.1\.0（2）/);
    assert.match(page, /<nav class="app-list" aria-label="可安装的应用">/);
    assert.ok(page.indexOf('class="app-list"') > page.indexOf('class="hint"'), "app links appear at the bottom");
    assert.match(page, /href="https:\/\/updates\.example\.test\/ios\/install">Wand<\/a>/);
    assert.match(page, /href="https:\/\/updates\.example\.test\/ios\/install\?app=huniu-helper" aria-current="page">虎妞帮手<\/a>/);
    const wandPage = await (await get("/ios/install")).text();
    assert.match(wandPage, /href="https:\/\/updates\.example\.test\/ios\/install" aria-current="page">Wand<\/a>/);
    assert.match(wandPage, /href="https:\/\/updates\.example\.test\/ios\/install\?app=huniu-helper">虎妞帮手<\/a>/);
    const manifestPath = new URL(metadata.manifestUrl).pathname + new URL(metadata.manifestUrl).search;
    const newer = "huniu-helper-v0.1.0-3-fedcba.ipa";
    writeFileSync(path.join(directory, newer), packageData("dev.tigertools.PlaylistBridge", "3", "石一造物"));
    pointTo(newer);
    const renamedPage = await (await get("/ios/install?app=huniu-helper")).text();
    assert.match(renamedPage, /安装 石一造物/);
    assert.match(await (await get("/ios/install")).text(), /app=huniu-helper">石一造物<\/a>/);
    const renamedMetadata = await (await check("2")).json();
    const renamedManifest = await (await get(new URL(renamedMetadata.manifestUrl).pathname + new URL(renamedMetadata.manifestUrl).search)).text();
    assert.match(renamedManifest, /<key>title<\/key>\s*<string>石一造物<\/string>/);
    const manifest = await (await get(manifestPath)).text();
    assert.match(manifest, /<key>title<\/key>\s*<string>虎妞帮手<\/string>/);
    assert.match(manifest, /<key>bundle-version<\/key>\s*<string>2<\/string>/);
    assert.ok(manifest.includes(fileName));
    const downloadPath = new URL(metadata.downloadUrl).pathname + new URL(metadata.downloadUrl).search;
    assert.deepEqual(Buffer.from(await (await get(downloadPath)).arrayBuffer()), data);
    const range = await fetch(origin + downloadPath, { headers: { Range: "bytes=0-7" } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), data.subarray(0, 8));
    assert.ok(existsSync(path.join(root, "ios/wand-v4.0.0.ipa")), "independent download does not prune Wand");
    assert.equal(remoteRequests, 0, "independent app does not fetch Wand releases");
    for (const route of ["/ios/install", "/ios/manifest.plist", "/ios/download", "/api/ios-ipa-update?currentVersion=0.0.0"]) {
      assert.equal((await get(route + (route.includes("?") ? "&" : "?") + "app=unknown")).status, 404);
    }
    assert.equal((await get("/ios/install?app=huniu-helper&app=unknown")).status, 404);
    assert.equal((await get("/ios/download?app=huniu-helper&fileName=../../config.json")).status, 404);
    symlinkSync(configPath, path.join(directory, "huniu-helper-v9.ipa"));
    assert.equal(await manager.resolveIosAppDownload("huniu-helper", "huniu-helper-v9.ipa"), null);
    assert.equal(await manager.resolveIosAppDownload("../../ios"), null);
    const wrong = "huniu-helper-v9.ipa";
    pointTo(wrong);
    assert.equal((await get("/ios/install?app=huniu-helper")).status, 404);
    writeFileSync(path.join(directory, "huniu-helper-v8.ipa"), packageData("com.other.app", "8"));
    pointTo("huniu-helper-v8.ipa");
    assert.equal((await get("/ios/install?app=huniu-helper")).status, 503);
    assert.doesNotMatch(await (await get("/ios/install")).text(), /app=huniu-helper/, "wrong-bundle package is not listed");
    pointTo("huniu-helper-v0.0.0-missing.ipa");
    assert.equal((await get("/ios/install?app=huniu-helper")).status, 404);
    const wand = await (await get("/api/ios-ipa-update?currentVersion=0.0.0")).json();
    assert.equal(wand.bundleId, "com.wand.app");
    assert.equal(wand.manifestUrl, "https://updates.example.test/ios/manifest.plist");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
