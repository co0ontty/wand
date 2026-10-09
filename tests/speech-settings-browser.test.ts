import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("speech setup has one immediate switch, truthful support, progress, cancel, failure/retry and read-only states", {
  skip: process.env.WAND_SPEECH_BROWSER !== "1", timeout: 120_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-speech-settings-"));
  const output = join(root, "output/speech-one-click"); mkdirSync(output, { recursive: true });
  let enabled = false, supported = true, operation: any = null, sequence = 0;
  const writes: boolean[] = [];
  const models = () => ({ speech: { enabled, supported, supportReason: supported ? null : "缺少可用的 CMake", busy: !!operation && !["completed", "failed", "cancelled"].includes(operation.phase), operation }, laya: {} });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from 'react'; import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme'; import {installReactUiStyles} from './src/web-ui/react/styles';
    import {installSettingsLibraryStyles} from './src/web-ui/react/settings/styles';
    import {SpeechSettingsTab} from './src/web-ui/react/settings/speech-panel';
    installReactUiStyles(); installSettingsLibraryStyles();
    createRoot(document.getElementById('root')).render(<WandUiProvider><SpeechSettingsTab admin={!location.search.includes('readonly')}/></WandUiProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/local-models/speech/settings") {
      let text = ""; for await (const chunk of req) text += chunk;
      const value = JSON.parse(text).enabled; writes.push(value);
      const id = ++sequence;
      if (value) operation = { id, action: "activate", phase: "downloading", message: "正在自动下载模型", received: 25, total: 100 };
      else { enabled = false; operation = { id, action: "activate", phase: "cancelled", message: "已取消" }; }
      res.end(JSON.stringify(models())); return;
    }
    if (req.url === "/api/local-models/status") { res.end(JSON.stringify(models())); return; }
    if (req.url === "/api/speech/status") {
      res.end(JSON.stringify({ settings: { enabled }, ready: enabled, reason: enabled ? null : "未启用", runtime: { available: enabled, platform: "darwin", arch: "arm64", backend: "metal" }, models: [], download: null })); return;
    }
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (req.url === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{margin:0}#root{max-width:840px;padding:16px;margin:auto}</style><div id="root"></div><script src="/app.js"></script></html>');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const b = await openBrowser(origin, 1280, 900);
  const toggle = '[role="switch"][aria-label="启用服务端语音输入"]';
  const checked = `document.querySelector('${toggle}').getAttribute('aria-checked')==='true'`;
  try {
    await b.wait("document.body.innerText.includes('当前机器支持服务端语音识别')");
    assert.equal(await b.evaluate("!!document.querySelector('#settings-speech-model') || document.body.innerText.includes('保存服务端语音设置')"), false);
    for (const width of [1280, 390, 320]) {
      await b.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await b.settle(); assert.equal(await b.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
      if (width !== 320) await b.screenshot(join(output, `settings-${width}.png`));
    }
    await b.click(toggle); await b.wait(checked);
    assert.deepEqual(writes, [true]);
    await b.wait("document.body.innerText.includes('正在自动下载模型')");
    await b.click(toggle); await b.wait(`!(${checked})`); assert.deepEqual(writes, [true, false]);
    await b.click(toggle); await b.wait(checked);
    operation = { ...operation, phase: "failed", error: "模型校验失败", message: "模型校验失败" };
    await b.wait("document.body.innerText.includes('模型校验失败')"); await b.wait(`!(${checked})`);
    await b.click(toggle); await b.wait(checked);
    enabled = true; operation = { ...operation, phase: "completed", message: "已启用" };
    await b.wait("document.body.innerText.includes('已启用，按住麦克风')");
    await b.click(toggle); await b.wait(`!(${checked})`);
    supported = false; await b.wait("document.body.innerText.includes('缺少可用的 CMake')");
    assert.equal(await b.evaluate(`document.querySelector('${toggle}').disabled`), true);
    await b.screenshot(join(output, "unsupported.png"));
    supported = true;
    await b.send("Page.navigate", { url: origin + "?readonly" });
    await b.wait("document.body.innerText.includes('启用或关闭需要服务器管理权限')");
    assert.equal(await b.evaluate(`document.querySelector('${toggle}').disabled`), true);
    assert.deepEqual(writes, [true, false, true, true, false]);
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); await new Promise<void>(r => server.close(() => r())); rmSync(temp, { recursive: true, force: true }); }
});
