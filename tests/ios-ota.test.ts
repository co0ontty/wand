import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  absoluteUrl,
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
