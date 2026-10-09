import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

test("local model settings use native controls for download/init/progress/retry and preserve read-only permissions", {
  skip: process.env.WAND_MODEL_SETTINGS_BROWSER !== "1", timeout: 120_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-model-settings-"));
  const output = join(root, "output/model-settings/browser"); mkdirSync(output, { recursive: true });
  let failInit = true, counter = 0;
  const status: any = {
    laya: { kind: "laya", label: "LAYA 本地决策", supported: true, reason: "模型尚未下载", enabled: false,
      model: "aac6fef/laya-multilingual-mlx", modelSize: 678214509, downloaded: false, runtimeAvailable: false, initialized: false, busy: false, operation: null },
    speech: { kind: "speech", label: "服务端语音识别", supported: true, reason: null, enabled: false,
      model: "base", modelSize: 147951465, downloaded: true, runtimeAvailable: false, initialized: false, busy: false, operation: null },
  };
  const calls: Array<{ path: string; body: unknown }> = [];
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from 'react'; import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme'; import {installReactUiStyles} from './src/web-ui/react/styles';
    import {installSettingsLibraryStyles} from './src/web-ui/react/settings/styles';
    import {LocalModelsSettingsTab} from './src/web-ui/react/settings/local-models-panel';
    installReactUiStyles(); installSettingsLibraryStyles();
    createRoot(document.getElementById('root')).render(<WandUiProvider><LocalModelsSettingsTab admin={!location.search.includes('readonly')}/></WandUiProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/local-models")) {
      res.setHeader("content-type", "application/json");
      if (req.method !== "GET") {
        let text = ""; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text || "{}"); calls.push({ path: req.url, body });
        if (req.url.endsWith("/settings")) status.laya.enabled = body.enabled;
        else {
          const kind = req.url.includes("/laya/") ? "laya" : "speech", value = status[kind], action = req.url.split("/").pop();
          const id = ++counter;
          value.busy = true; value.operation = { id, action, phase: action === "download" ? "downloading" : "runtime", message: action === "download" ? "模型下载中" : "正在初始化独立运行时", received: 25, total: 100 };
          setTimeout(() => {
            value.busy = false;
            const failed = action === "initialize" && failInit;
            if (failed) failInit = false;
            value.operation = { ...value.operation, phase: failed ? "failed" : "completed", message: failed ? "初始化失败，请重试" : "完整性/运行时检查完成" };
            if (!failed && action === "download") { value.downloaded = true; value.reason = null; }
            if (!failed && action === "initialize") { value.runtimeAvailable = true; value.initialized = true; }
          }, 300);
        }
      }
      res.end(JSON.stringify(status)); return;
    }
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (req.url === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{margin:0}#root{max-width:840px;padding:16px;margin:auto}</style><div id="root"></div><script src="/app.js"></script></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    const portFile = join(temp, "profile/DevToolsActivePort");
    for (let i = 0; i < 120 && !existsSync(portFile); i += 1) await sleep(50);
    assert.ok(existsSync(portFile));
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[];
    socket = new WebSocket(tabs.find(value => value.type === "page").webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0; const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>(), errors: string[] = [];
    socket.addEventListener("message", event => { const value = JSON.parse(String(event.data));
      if (value.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(value.params));
      const callback = pending.get(value.id); if (callback) { pending.delete(value.id); value.error ? callback.reject(Error(JSON.stringify(value.error))) : callback.resolve(value.result); } });
    const send = (method: string, params = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = async (expression: string) => { for (let i = 0; i < 250; i += 1) { if (await evaluate(expression)) return; await sleep(40); } throw Error(`Missing ${expression}: ${await evaluate("document.body.innerText")}`); };
    const clickText = async (text: string) => {
      await wait(`[...document.querySelectorAll('button')].some(n=>!n.disabled&&n.innerText.trim()===${JSON.stringify(text)})`);
      const point = await evaluate(`(()=>{const node=[...document.querySelectorAll('button')].find(n=>n.innerText.trim()===${JSON.stringify(text)});if(!node||node.disabled)throw Error('button missing/disabled');node.scrollIntoView({block:'center',behavior:'instant'});const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 }); };
    await send("Runtime.enable"); await send("Page.enable"); await send("Page.navigate", { url: origin });
    await wait("document.body.textContent.includes('模型未就绪')");
    for (const width of [1280, 390]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, mobile: width === 390, deviceScaleFactor: 1 }); await sleep(200);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      const image = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(join(output, `setup-${width}.png`), Buffer.from(image.data, "base64"));
    }
    await clickText("下载模型（647 MiB）");
    await wait("!!document.querySelector('[aria-label=\"LAYA 本地决策下载进度\"]')");
    await wait("document.querySelectorAll('.wand-settings-library-section')[0].textContent.includes('模型校验通过')");
    assert.equal(status.laya.enabled, false);
    // Two kinds share the label; the first is LAYA.
    await clickText("初始化运行时与模型"); await wait("document.body.textContent.includes('初始化失败，请重试')");
    await clickText("重试初始化"); await wait("document.body.textContent.includes('完整性/运行时检查完成') && document.body.textContent.includes('已有运行时')");
    assert.equal(status.laya.enabled, false);
    await evaluate("document.querySelector('[role=switch][aria-label=\"启用 LAYA 本地决策\"]').click()");
    await wait("document.querySelector('[role=switch]').getAttribute('aria-checked')==='true'"); assert.equal(status.laya.enabled, true);
    const before = calls.length;
    await send("Page.navigate", { url: origin + "/?readonly" }); await wait("document.body.textContent.includes('当前连接可查看实际状态')");
    assert.equal(await evaluate("[...document.querySelectorAll('button')].filter(n=>n.innerText.includes('初始化运行时')||n.innerText.includes('模型已下载')).every(n=>n.disabled)"), true);
    assert.equal(calls.length, before); assert.deepEqual(errors, []);
    writeFileSync(join(output, "evidence.json"), JSON.stringify({ actualBrowser: "Chrome headless", mockedServer: true, cases: ["desktop/narrow no overflow", "download progress", "failed init and retry", "init does not enable", "explicit enable", "read-only cannot install"], calls }, null, 2));
  } finally { socket?.close(); const closed = once(chrome, "close"); chrome.kill(); await closed;
    await new Promise<void>(r => server.close(() => r())); rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
