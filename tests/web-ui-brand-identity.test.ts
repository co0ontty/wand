import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WAND_BRAND } from "../src/web-ui/brand-logo-data.js";
import { renderWandBrandMarkup, WAND_FAVICON_URL } from "../src/web-ui/brand-identity.js";
import { WandBrandMark } from "../src/web-ui/react/ui/brand-mark.js";

const root = new URL("../", import.meta.url);
const source = (path: string): string => readFileSync(new URL(path, root), "utf8");
const binary = (path: string): Buffer => readFileSync(new URL(path, root));

test("all generated brand resources stay in sync with the Android launcher source", () => {
  execFileSync(process.execPath, ["scripts/sync-brand-assets.js", "--check"], { cwd: root });
  const android = source("android/app/src/main/res/drawable/ic_launcher_foreground.xml");
  const paths = [...android.matchAll(/android:fillColor="([^"]+)"\s+android:pathData="([^"]+)"/g)]
    .map(([, fill, d]) => ({ fill, d }));
  assert.deepEqual(WAND_BRAND.paths, paths);
  assert.equal(WAND_BRAND.viewport, 108);
  assert.equal(WAND_BRAND.inset, 24);
  assert.match(source("android/app/src/main/res/drawable/ic_launcher_background.xml"),
    new RegExp(`android:fillColor="${WAND_BRAND.background}"`));
});

test("React, login, illustration and favicon reuse the same pixel-cat geometry and colors", () => {
  const markup = renderWandBrandMarkup("brand-logo");
  const react = renderToStaticMarkup(createElement(WandBrandMark, { className: "brand-logo" }));
  assert.equal(decodeURIComponent(WAND_FAVICON_URL.split(",")[1]), renderWandBrandMarkup());
  for (const svg of [markup, react]) {
    assert.match(svg, /viewBox="0 0 108 108"/);
    assert.match(svg, /data-wand-brand="pixel-cat"/);
    assert.match(svg, /transform="translate\(24 24\)"/);
    assert.match(svg, /fill="#E3E8EE"/);
    for (const { fill, d } of WAND_BRAND.paths) {
      assert.ok(svg.includes(`fill="${fill}"`));
      assert.ok(svg.includes(`d="${d}"`));
    }
    assert.doesNotMatch(svg, /M13 21l9|<text\b|<image\b/);
  }
  assert.match(source("src/web-ui/browser/render.ts"), /renderWandBrandMarkup\("brand-logo"\)/);
  assert.match(source("src/web-ui/index.ts"), /href="\$\{WAND_FAVICON_URL\}"/);
  assert.match(source("src/web-ui/browser/notifications.ts"), /icon: options.icon \|\| WAND_FAVICON_URL/);
  assert.match(renderWandBrandMarkup('" onload="bad<>&'), /class="&quot; onload=&quot;bad&lt;&gt;&amp;"/);
});

test("browser extension ships correctly sized PNG icons and native-color SVG headings", () => {
  const manifest = JSON.parse(source("browser-extension/manifest.json"));
  for (const size of [16, 32, 48, 128]) {
    const file = manifest.icons[String(size)];
    const png = binary(`browser-extension/${file}`);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 6, "Extension icons keep transparent rounded corners");
  }
  for (const size of [16, 32]) assert.equal(manifest.action.default_icon[size], manifest.icons[size]);
  for (const page of ["popup", "options"]) {
    assert.match(source(`browser-extension/src/${page}.html`), /<img src="\.\.\/icons\/wand.svg"/);
  }
  // Check the actual encoded pixels, not just manifest paths or PNG headers.
  const png = binary("browser-extension/icons/wand-128.png");
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.subarray(offset + 4, offset + 8).toString() === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(idat));
  assert.equal(pixels.length, 128 * (128 * 4 + 1));
  const pixel = (x: number, y: number): number[] => {
    const offset = y * 513 + x * 4 + 1;
    return [...pixels.subarray(offset, offset + 4)];
  };
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(10, 64), [227, 232, 238, 255]);
  assert.deepEqual(pixel(64, 67), [242, 139, 154, 255]);
});

test("native applications use the Android artwork instead of W or magic-wand marks", () => {
  for (const platform of ["ios", "macos"]) {
    assert.deepEqual(JSON.parse(source(`${platform}/scripts/wand-logo.json`)), WAND_BRAND);
    const mark = source(`${platform}/Wand/Theme.swift`).split("struct WandBrandMark: View")[1];
    assert.match(mark, /Image\("WandLogo"\)/);
    assert.match(mark, /renderingMode\(\.original\)/);
    assert.doesNotMatch(mark, /wand.and.stars|LinearGradient/);
    assert.doesNotMatch(source(`${platform}/scripts/generate-icons.swift`), /glyph = "W"|NSFont/);
    const catalog = `${platform}/Wand/Assets.xcassets/AppIcon.appiconset`;
    for (const image of JSON.parse(source(`${catalog}/Contents.json`)).images) {
      const png = binary(`${catalog}/${image.filename}`);
      const size = Number(image.size.split("x")[0]) * Number((image.scale ?? "1x").replace("x", ""));
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      if (platform === "ios") assert.equal(png[25], 2, "iOS app icon must be opaque RGB");
    }
  }
  const android = source("android/app/src/main/java/com/wand/app/ui/components/Wand.kt")
    .split("fun WandBrandMark(")[1];
  assert.match(android, /painterResource\(R.drawable.ic_launcher_foreground\)/);
  assert.match(android, /painterResource\(R.drawable.ic_launcher_background\)/);
  assert.doesNotMatch(android, /WandIcons.sparkle/);
  assert.match(source("ios/WandWidgets/WandWidgetsBundle.swift"), /Image\("WandLogo"\)/);
  assert.match(source("ios/Wand.xcodeproj/project.pbxproj"), /scripts\/wand-logo.json/);
});
