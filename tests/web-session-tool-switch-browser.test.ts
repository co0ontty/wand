import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("blank session tool switching preserves engine, input ownership, geometry and late response isolation", {
  skip: process.env.WAND_BROWSER_E2E !== "1", timeout: 120_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-tool-switch-browser-"));
  const output = join(root, "output/pi-engine-continuation-20261008");
  mkdirSync(output, { recursive: true });
  const report: any = { ok: false, cases: [], requests: [], errors: [], evidence: "production composer/state + explicit HTTP doubles + real Chrome" };
  const blank = { id: "tool-A", provider: "pi", employeeId: "fixture-employee", status: "idle", sessionKind: "structured",
    runner: "pi-cli-json", cwd: "/tmp", mode: "default", messages: [], messageTotal: 0, queuedMessages: [], structuredState: { inFlight: false, engine: "cli" } };
  let failNext = false;
  let deferred: (() => void) | null = null;
  let deferNext = false;
  let browser: any;
  await build({ stdin: { loader: "tsx", resolveDir: root, contents: `
    import * as React from "react";
    import {createRoot} from "react-dom/client";
    import {state,composer} from "./src/web-ui/browser/state";
    import {refreshAllChatModeTrios, onChatToolChange, canSendComposer} from "./src/web-ui/browser/session-engine";
    import {ComposerConfigHost} from "./src/web-ui/react/composer-config/host";
    import {ComposerSelectHost} from "./src/web-ui/react/composer-select/host";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    installReactUiStyles();
    createRoot(document.getElementById("root")).render(<WandUiProvider><ComposerConfigHost/><ComposerSelectHost/></WandUiProvider>);
    const blank=${JSON.stringify(blank)};
    window.toolSwitchHarness={state,composer,refresh:refreshAllChatModeTrios,switch:onChatToolChange,canSendComposer,
      setup(){state.sessions=[structuredClone(blank),{...structuredClone(blank),id:"tool-B",employeeId:"another-employee"}];
        state.selectedId="tool-A";state.currentMessages=[];state.sessionTool="pi";state.chatMode="default";
        composer.edit("tool-A",{text:"保留 A 草稿"});composer.edit("tool-B",{text:"保留 B 草稿"});
        document.getElementById("input-box").value="保留 A 草稿";refreshAllChatModeTrios();}};
    window.toolSwitchHarness.setup();
    requestAnimationFrame(refreshAllChatModeTrios);
  ` }, bundle: true, format: "iife", platform: "browser", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://fixture").pathname;
    if (pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (pathname === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    if (pathname.endsWith("/provider")) {
      let body = ""; for await (const part of req) body += part;
      const input = JSON.parse(body); report.requests.push({ method: req.method, pathname, body: input });
      const failure = failNext; failNext = false;
      const reply = () => {
        res.writeHead(failure ? 400 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(failure ? { error: "Wand Agent 不支持当前 Skills / MCP，请先关闭。" }
          : { ...blank, provider: input.provider, structuredState: { inFlight: false, engine: input.engine === "sdk" ? "core" : "cli" } }));
      };
      if (deferNext) { deferNext = false; deferred = reply; } else setTimeout(reply, 450);
      return;
    }
    if (pathname.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><div data-composer-config-host="runtime"></div><div id="chat-output"></div><div class="input-panel"><textarea id="input-box"></textarea></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    browser = await openBrowser(origin);
    const { evaluate: e, wait, click, key, send } = browser;
    for (const mode of ["desktop", "390px", "320px", "native-shell", "rollback", "reduced-motion"]) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "320px" ? 320 : mode === "390px" ? 390 : 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: origin + (mode === "rollback" ? "/?reactUi=0" : "/") });
      await wait("!!window.toolSwitchHarness && !!document.querySelector('[data-composer-select-host]')");
      await e(`window.h=toolSwitchHarness;h.refresh();document.documentElement.classList.toggle('is-wand-app',${mode === "native-shell"});true`);
      await wait("!!document.querySelector('[aria-label=\"更换执行工具\"]')");
      const selector = '[aria-label="更换执行工具"]';
      const before = await e(`(()=>{window.originalTool=document.querySelector(${JSON.stringify(selector)});return originalTool.getBoundingClientRect().toJSON()})()`);
      await click(selector);
      await wait("document.querySelectorAll('[data-wand-popup-owner] [role=option]').length===8");
      await e("Array.from(document.querySelectorAll('[role=option]')).find(n=>n.textContent==='Wand Agent').id='sdk-choice';true");
      deferNext = true;
      await click("#sdk-choice");
      for (let i = 0; i < 100 && !deferred; i++) await new Promise(r => setTimeout(r, 20));
      assert.ok(deferred);
      assert.equal(await e("h.canSendComposer('发送', 'tool-A')"), false, mode + ": switching gates the original send owner");
      const loading = await e("originalTool.getBoundingClientRect().toJSON()");
      assert.equal(before.width, loading.width); assert.equal(before.height, loading.height);
      assert.equal(before.x, loading.x); assert.equal(before.y, loading.y);
      deferred!(); deferred = null;
      await wait("h.state.sessions[0].structuredState.engine==='core' && !document.querySelector('[aria-label=\"更换执行工具\"]').disabled");
      assert.equal(await e("document.querySelector('[aria-label=\"更换执行工具\"]').textContent.includes('Wand Agent')"), true);
      assert.equal(await e("document.querySelector('[aria-label=\"更换执行工具\"]')===originalTool"), true, mode + ": stable instance");
      const after = await e("originalTool.getBoundingClientRect().toJSON()");
      assert.equal(before.width, after.width); assert.equal(before.height, after.height);
      assert.equal(before.x, after.x); assert.equal(before.y, after.y);
      assert.deepEqual(await e("[h.composer.read('tool-A').text,h.composer.read('tool-B').text,document.getElementById('input-box').value]"), ["保留 A 草稿", "保留 B 草稿", "保留 A 草稿"]);
      await click(selector); await key("Escape");
      await wait("!document.querySelector('[role=listbox]')");
      if (mode === "desktop" || mode === "390px") await browser.screenshot(join(output, `tool-switch-${mode}.png`));
      await e("h.state.sessions[0].messages=[{role:'user'}];h.refresh();true");
      assert.equal(await e("!!document.querySelector('[aria-label=\"更换执行工具\"]')"), false, mode + ": accepted conversation hides action");
      report.cases.push({ mode, before, after, engine: "core", draftPreserved: true });
    }
    await e("h.setup();true"); failNext = true;
    await e("h.pending=h.switch('wand-agent');true");
    await wait("document.querySelector('[aria-label=\"更换执行工具\"]').textContent.includes('切换失败')");
    assert.equal(await e("h.state.sessions[0].structuredState.engine"), "cli");
    assert.match(await e("document.querySelector('[aria-label=\"更换执行工具\"]').title"), /Skills/);
    deferNext = true;
    await e("h.pending=h.switch('wand-agent');true");
    for (let i = 0; i < 100 && !deferred; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(deferred);
    await e("h.state.selectedId='tool-B';h.state.currentMessages=[];document.getElementById('input-box').value='B 新编辑';h.composer.edit('tool-B',{text:'B 新编辑'});h.refresh();true");
    deferred!(); deferred = null; await e("h.pending");
    assert.equal(await e("h.state.sessions.find(s=>s.id==='tool-B').structuredState.engine"), "cli");
    assert.equal(await e("h.composer.read('tool-B').text"), "B 新编辑");
    await e("h.setup();true"); deferNext = true;
    await e("h.pending=h.switch('wand-agent');true");
    for (let i = 0; i < 100 && !deferred; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(deferred);
    await e("h.state.sessions=h.state.sessions.filter(s=>s.id!=='tool-A');h.state.selectedId='tool-B';h.refresh();true");
    deferred!(); deferred = null; await e("h.pending");
    assert.equal(await e("h.state.sessions.some(s=>s.id==='tool-A')"), false, "late success cannot resurrect a deleted session");
    report.errors = browser.errors; assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.errors = browser?.errors ?? [];
    if (browser) report.dom = await browser.evaluate("document.body.innerHTML.slice(0,6000)");
    console.error(JSON.stringify({ errors: report.errors, dom: report.dom }));
    throw error;
  } finally {
    deferred?.(); await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    mkdirSync(output, { recursive: true }); writeFileSync(join(output, "tool-switch-browser.json"), JSON.stringify(report, null, 2));
    rmSync(temp, { recursive: true, force: true });
  }
});
