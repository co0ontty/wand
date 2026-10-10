import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { versionWebAsset } from "../src/web-ui/asset-version.js";
import { getScriptAsset } from "../src/web-ui/scripts.js";
import { EMBEDDED_WEB_ASSETS } from "../src/web-ui/embedded-assets.js";

const hashOf = (content: string): string => versionWebAsset(content).hash;

test("the shell transfers only HTML repeatedly and serves versioned, cacheable assets", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-web-assets-"));
  const configPath = path.join(dir, "config.json");
  const config = {
    ...defaultConfig(),
    host: "127.0.0.1", port: 0, https: false, password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
  };
  const handle = await startServer(config, configPath);
  try {
    const base = handle.urls[0]!.url;
    const shell = await fetch(`${base}/`);
    const html = await shell.text();
    assert.equal(shell.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
    assert.ok(Buffer.byteLength(html) < 8_192, "the shell should not contain entire bundles");
    assert.doesNotMatch(html, /<style\b|<script(?!\s+src=)/i);
    const cssHref = html.match(/href="(\/assets\/app\.css\?v=[a-f0-9]{16})"/)?.[1];
    const jsSrc = html.match(/src="(\/assets\/app\.js\?v=[a-f0-9]{16})"/)?.[1];
    const themeSrc = html.match(/src="(\/assets\/theme\.js\?v=[a-f0-9]{16})"/)?.[1];
    assert.ok(cssHref && jsSrc && themeSrc);
    assert.ok(html.indexOf(themeSrc) < html.indexOf(cssHref));
    assert.ok(html.indexOf("/vendor/xterm/xterm.css") < html.indexOf(cssHref));
    assert.match(html, /name="wand-qrcode-script" content="\/vendor\/qrcode\/qrcode\.bundle\.js\?v=[a-f0-9]{8}"/);
    assert.match(html, /name="wand-xterm-script" content="\/vendor\/xterm\/xterm\.bundle\.js\?v=[a-f0-9]{8}"/);
    assert.doesNotMatch(html, /<script src="\/vendor\//);
    assert.doesNotMatch(html, /maximum-scale|user-scalable/);

    for (const [url, type, cache] of [
      [jsSrc, "javascript", "private"],
      [cssHref, "css", "public"],
      [themeSrc, "javascript", "public"],
    ] as const) {
      const response = await fetch(`${base}${url}`);
      const content = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", new RegExp(type));
      assert.match(response.headers.get("cache-control") ?? "", new RegExp(`${cache}.*immutable`));
      assert.equal(hashOf(content), url.split("v=")[1], "URL hashes the bytes actually delivered");
      const etag = response.headers.get("etag");
      assert.ok(etag);
      // Node's fetch adds Cache-Control: no-cache to conditional requests;
      // send only If-None-Match to exercise the HTTP validator itself.
      const status = await new Promise<number>((resolve, reject) => {
        get(`${base}${url}`, { headers: { "If-None-Match": etag } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }).on("error", reject);
      });
      assert.equal(status, 304);
    }
    const script = await (await fetch(`${base}${jsSrc}`)).text();
    assert.ok(script.includes(JSON.stringify(configPath)), "the script still receives the instance config path");
    const unusualPath = `${configPath} & "quoted" \\test`;
    assert.ok(getScriptAsset(unusualPath).content.includes(JSON.stringify(unusualPath)),
      "paths with quotes and backslashes must remain valid JS string literals");
    assert.match(script, /\/assets\/ai-teams\.js\?v=[a-f0-9]{8}/);

    for (const url of ["/assets/app.js?v=outdated", "/assets/app.css?v=outdated",
      "/vendor/xterm/xterm.css?v=outdated", "/assets/ai-teams.js?v=outdated"]) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 200, `an old open page must stay usable: ${url}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }

    // An old process knows its embedded build even if the disk has been replaced.
    const embeddedCssHash = hashOf(EMBEDDED_WEB_ASSETS.stylesCss);
    const oldCss = await fetch(`${base}/assets/app.css?v=${embeddedCssHash}`);
    assert.equal(await oldCss.text(), EMBEDDED_WEB_ASSETS.stylesCss);
    assert.match(oldCss.headers.get("cache-control") ?? "", /immutable/);
    const chunkHash = createHash("md5").update(EMBEDDED_WEB_ASSETS.aiTeamsJs).digest("hex").slice(0, 8);
    const embeddedJs = EMBEDDED_WEB_ASSETS.scriptsJs
      .replace('"${wandConfigPath}"', JSON.stringify(configPath))
      .replace("${aiTeamsChunkSrc}", `/assets/ai-teams.js?v=${chunkHash}`);
    const oldJs = await fetch(`${base}/assets/app.js?v=${hashOf(embeddedJs)}`);
    assert.equal(await oldJs.text(), embeddedJs);
    assert.match(oldJs.headers.get("cache-control") ?? "", /private.*immutable/);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
