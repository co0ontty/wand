import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transformSync } from "esbuild";

import { versionWebAsset } from "../src/web-ui/asset-version.js";
import { EMBEDDED_WEB_ASSETS } from "../src/web-ui/embedded-assets.js";

const webUiDir = fileURLToPath(new URL("../src/web-ui/", import.meta.url));
const contentDir = path.join(webUiDir, "content");

function readContent(relativePath: string): string {
  return readFileSync(path.join(contentDir, relativePath), "utf8");
}

function md5(content: string): string {
  return createHash("md5").update(content).digest("hex").slice(0, 8);
}

test("compressed embedded assets preserve all published asset payloads including lazy 3D", () => {
  const expectedScript = transformSync(readContent("scripts.js"), {
    loader: "js", minify: true, legalComments: "none", charset: "utf8",
  }).code;
  const expectedStyles = transformSync(
    `${readContent("tailwind.css")}\n${readContent("styles.css")}`,
    { loader: "css", minify: true, legalComments: "none" },
  ).code;
  assert.equal(EMBEDDED_WEB_ASSETS.scriptsJs, expectedScript);
  assert.equal(EMBEDDED_WEB_ASSETS.stylesCss, expectedStyles);
  assert.equal(EMBEDDED_WEB_ASSETS.aiTeamsJs, readContent("ai-teams.js"));
  assert.equal(EMBEDDED_WEB_ASSETS.plushAvatarJs, readContent("plush-avatar.js"));

  for (const [assetPath, contentType] of [
    ["/vendor/xterm/xterm.bundle.js", "application/javascript"],
    ["/vendor/xterm/xterm.css", "text/css; charset=utf-8"],
    ["/vendor/qrcode/qrcode.bundle.js", "application/javascript"],
  ] as const) {
    const expected = readContent(assetPath.slice(1));
    assert.deepEqual(EMBEDDED_WEB_ASSETS.vendor[assetPath], {
      content: expected,
      contentType,
      hash: md5(expected),
    }, `the ${assetPath} fallback must match the published bytes and metadata`);
  }
});

test("the embedded fallback source stays smaller than half its plain base64 payloads", () => {
  const contents = [
    EMBEDDED_WEB_ASSETS.scriptsJs,
    EMBEDDED_WEB_ASSETS.stylesCss,
    EMBEDDED_WEB_ASSETS.aiTeamsJs,
    EMBEDDED_WEB_ASSETS.plushAvatarJs,
    ...Object.values(EMBEDDED_WEB_ASSETS.vendor).map((asset) => asset.content),
  ];
  const plainBase64Bytes = contents.reduce(
    (sum, content) => sum + Buffer.from(content).toString("base64").length, 0,
  );
  const sourceBytes = readFileSync(path.join(webUiDir, "embedded-assets.ts")).byteLength;
  assert.ok(sourceBytes < plainBase64Bytes / 2,
    `embedded source ${sourceBytes} B must stay below ${plainBase64Bytes / 2} B`);
});

test("asset readers keep serving correct strings and hashes when disk assets are absent", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-embedded-assets-"));
  try {
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
    for (const name of ["embedded-assets", "asset-version", "scripts", "styles"]) {
      const source = readFileSync(path.join(webUiDir, `${name}.ts`), "utf8");
      const compiled = transformSync(source, { loader: "ts", format: "esm", target: "es2022" });
      writeFileSync(path.join(dir, `${name}.js`), compiled.code);
    }
    assert.equal(existsSync(path.join(dir, "content")), false);
    const scripts = await import(pathToFileURL(path.join(dir, "scripts.js")).href) as
      typeof import("../src/web-ui/scripts.js");
    const styles = await import(pathToFileURL(path.join(dir, "styles.js")).href) as
      typeof import("../src/web-ui/styles.js");
    const configPath = path.join(dir, 'config "quoted" \\path.json');
    const expectedChunk = {
      content: EMBEDDED_WEB_ASSETS.aiTeamsJs,
      hash: md5(EMBEDDED_WEB_ASSETS.aiTeamsJs),
    };
    const expectedScript = EMBEDDED_WEB_ASSETS.scriptsJs
      .replace('"${wandConfigPath}"', JSON.stringify(configPath))
      .replace("${aiTeamsChunkSrc}", `/assets/ai-teams.js?v=${expectedChunk.hash}`)
      .replace("${plushAvatarChunkSrc}", `/assets/plush-avatar.js?v=${md5(EMBEDDED_WEB_ASSETS.plushAvatarJs)}`);
    const fallbackScript = scripts.getScriptAsset(configPath);
    assert.equal(fallbackScript.content, expectedScript);
    assert.equal(fallbackScript.hash, versionWebAsset(expectedScript).hash);
    assert.deepEqual(scripts.getAiTeamsChunk(), expectedChunk);
    const expectedPlush = { content: EMBEDDED_WEB_ASSETS.plushAvatarJs, hash: md5(EMBEDDED_WEB_ASSETS.plushAvatarJs) };
    assert.deepEqual(scripts.getPlushAvatarChunk(), expectedPlush);
    assert.deepEqual(styles.getStylesAsset(), versionWebAsset(EMBEDDED_WEB_ASSETS.stylesCss));

    // A running process also retains the latest disk copy across npm replacement.
    const fixtureContentDir = path.join(dir, "content");
    mkdirSync(fixtureContentDir);
    writeFileSync(path.join(fixtureContentDir, "scripts.js"), "console.log('updated build');\n");
    writeFileSync(path.join(fixtureContentDir, "ai-teams.js"), "console.log('updated teams');\n");
    writeFileSync(path.join(fixtureContentDir, "plush-avatar.js"), "console.log('updated plush');\n");
    writeFileSync(path.join(fixtureContentDir, "tailwind.css"), ":root{--fixture:1}");
    writeFileSync(path.join(fixtureContentDir, "styles.css"), "body{color:red}");
    const diskScript = scripts.getScriptAsset(configPath);
    const diskChunk = scripts.getAiTeamsChunk();
    const diskPlush = scripts.getPlushAvatarChunk();
    const diskStyles = styles.getStylesAsset();
    assert.equal(diskScript.content, "console.log('updated build');\n");
    assert.deepEqual(diskChunk, {
      content: "console.log('updated teams');\n", hash: md5("console.log('updated teams');\n"),
    });
    assert.deepEqual(diskStyles, versionWebAsset(":root{--fixture:1}\nbody{color:red}"));
    rmSync(fixtureContentDir, { recursive: true });
    assert.deepEqual(scripts.getScriptAsset(configPath), diskScript);
    assert.deepEqual(scripts.getAiTeamsChunk(), diskChunk);
    assert.deepEqual(scripts.getPlushAvatarChunk(), diskPlush);
    assert.deepEqual(styles.getStylesAsset(), diskStyles);

    // Requests from the old page must still resolve its original embedded build.
    assert.equal(scripts.getScriptAsset(configPath, fallbackScript.hash).content, expectedScript);
    assert.deepEqual(scripts.getAiTeamsChunk(expectedChunk.hash), expectedChunk);
    assert.deepEqual(scripts.getPlushAvatarChunk(expectedPlush.hash), expectedPlush);
    assert.deepEqual(
      styles.getStylesAsset(versionWebAsset(EMBEDDED_WEB_ASSETS.stylesCss).hash),
      versionWebAsset(EMBEDDED_WEB_ASSETS.stylesCss),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
