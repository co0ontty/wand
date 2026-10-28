import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

test("Todo and pending messages retain horizontal equal-width slots on Web and macOS", () => {
  const css = read("src/web-ui/content/styles.css");
  assert.match(css, /\.composer-top-row \{[^\n]*display:grid;[^\n]*grid-auto-flow:column;[^\n]*grid-auto-columns:minmax\(0,1fr\)/);
  if (existsSync(join(root, "macos/Wand/ChatView.swift"))) {
    const chat = read("macos/Wand/ChatView.swift");
    const begin = chat.indexOf("private var composerProgress:");
    const end = chat.indexOf("private var inputBar:", begin);
    const row = chat.slice(begin, end);
    assert.match(row, /HStack\(spacing: 8\)/);
    assert.match(row, /TodoProgressBar\([^\n]+\.frame\(maxWidth: \.infinity\)/);
    assert.match(row, /ComposerQueue\([\s\S]*?\)\s*\.frame\(maxWidth: \.infinity\)/);
  }
});

test("production Todo detail stays compact, complete and accessible without changing half-width slots", {
  timeout: 240000, skip: process.env.WAND_TODO_DENSITY_BROWSER !== "1",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "wand-todo-density-"));
  const evidenceDirectory = process.env.WAND_TODO_DENSITY_EVIDENCE;
  if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true });
  const evidence: any = { kind: "product-source-adapters-synthetic-data", cases: [], errors: [], ok: false };
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let exited: Promise<any> | undefined;
  try {
    const bundle = await build({ entryPoints: [join(root, "tests/helpers/todo-detail-density-harness.tsx")], bundle: true,
      platform: "browser", format: "iife", jsx: "automatic", write: false, define: { "process.env.NODE_ENV": '"production"' } });
    server = createServer((request, response) => {
      const path = new URL(request.url!, "http://fixture.local").pathname;
      if (path === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].text); return; }
      if (path === "/styles.css" || path === "/tailwind.css") { response.setHeader("Content-Type", "text/css"); response.end(read(`src/web-ui/content${path}`)); return; }
      if (path !== "/") { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:var(--bg-primary)}#fixture{box-sizing:border-box;max-width:900px;margin:auto;padding:16px;min-height:90dvh;display:flex;flex-direction:column;justify-content:flex-end}#draft{width:100%;height:64px;color:var(--text-primary);background:var(--bg-surface)}#submit{width:96px;height:44px;align-self:flex-end}</style></head><body><main id="fixture"></main><script src="/app.js"></script></body></html>`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    browser = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${directory}/profile`, origin], { stdio: "ignore" });
    exited = once(browser, "exit");
    const portFile = join(directory, "profile/DevToolsActivePort");
    for (let i = 0; i < 120 && !existsSync(portFile); i++) await sleep(50);
    assert.ok(existsSync(portFile), "Chrome launch must succeed");
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find((target: any) => target.type === "page").webSocketDebuggerUrl);
    await once(socket, "open");
    let id = 0;
    const pending = new Map<number, any>();
    const send = (method: string, params: any = {}): Promise<any> => new Promise((done, fail) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); fail(new Error(`CDP timeout ${method}`)); }, 15000);
      pending.set(requestId, { done, fail, timer }); socket!.send(JSON.stringify({ id: requestId, method, params }));
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") evidence.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") evidence.errors.push(message.params.args.map((arg: any) => arg.value || arg.description).join(" "));
      const next = pending.get(message.id); if (!next) return;
      pending.delete(message.id); clearTimeout(next.timer);
      message.error ? next.fail(new Error(JSON.stringify(message.error))) : next.done(message.result);
    });
    const e = async (expression: string) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async (expression: string) => {
      for (let i = 0; i < 150; i++) { if (await e(expression)) return; await sleep(20); }
      throw new Error(`Condition failed: ${expression}`);
    };
    const click = async (selector: string, touch = false) => {
      await e(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`);
      await e("todoDensity.frame()");
      const point = await e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,hit:h===n||n.contains(h)}})()`);
      assert.ok(point.hit, `real hit target ${selector}`);
      if (touch) {
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      }
      await e("todoDensity.frame()");
    };
    const key = async (key: string) => {
      const code = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Tab" ? 9 : 35;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, ...(key === "Enter" ? { text: "\r" } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
      await e("todoDensity.frame()");
    };
    await send("Runtime.enable"); await send("Page.enable"); await send("Page.bringToFront");
    await wait("Boolean(window.todoDensity)");
    const short = "最后一项：确认完整列表可滚动到达，历史记录与用户草稿都不被修改。";
    const long = "核对长标题与完整任务正文：在320px和390px窄窗下检查数量、当前事项、状态图标与全文入口。".repeat(5);
    const rows = [{ content: "核对现有组件", status: "completed" }, { content: long, activeForm: "整理详情", status: "in_progress" },
      ...Array.from({ length: 15 }, (_, i) => ({ content: `第${i + 3}项：保留任务正文和完整列表`, status: "pending" })), { content: short, status: "pending" }];
    for (const mode of ["desktop", "390px-touch", "320px-touch", "native-shell", "reactUi=0", "dark-reduced"]) {
      const width = mode.startsWith("320") ? 320 : mode.startsWith("390") || mode === "dark-reduced" ? 390 : 1280;
      await e("window.densityNavigating=true");
      await send("Page.navigate", { url: origin + (mode === "reactUi=0" ? "/?reactUi=0" : "/") });
      await wait("!window.densityNavigating && Boolean(window.todoDensity)");
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mode.includes("touch"), maxTouchPoints: 1 });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "dark-reduced" ? "reduce" : "no-preference" }] });
      await e(`document.documentElement.classList.toggle('is-wand-app',${mode === "native-shell"});todoDensity.theme('${mode === "dark-reduced" ? "graphite" : "warm"}');todoDensity.show(${JSON.stringify(rows)},true)`);
      await e("todoDensity.frame()");
      const geometry = await e("(()=>{const r=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {todo:r('#todo-progress'),queue:r('#queue-bar-host'),send:r('#submit')}})()");
      assert.ok(Math.abs(geometry.todo.width - geometry.queue.width) < 1, `equal halves ${mode}`);
      assert.ok(Math.abs(geometry.todo.top - geometry.queue.top) < 1 && geometry.todo.right <= geometry.queue.left, `horizontal ${mode}`);
      await click("#draft"); await send("Input.insertText", { text: "开合期间保留的新草稿" });
      await e("window.editorNode=document.querySelector('#draft');editorNode.setSelectionRange(2,5)");
      await click("#todo-progress-toggle", mode.includes("touch")); await wait("!!document.querySelector('#todo-progress-body')");
      const detail = await e("(()=>{const b=document.querySelector('#todo-progress-body'),r=b.getBoundingClientRect();return {text:b.innerText,width:r.width,left:r.left,right:r.right,rows:b.querySelectorAll('li').length,progress:b.querySelectorAll('[role=progressbar]').length,footer:b.querySelector('.composer-work-footer')?.textContent,current:b.querySelector('[aria-current=step]')?.textContent}})()");
      assert.equal(detail.rows, 18); assert.equal(detail.progress, 0); assert.equal(detail.footer, undefined);
      assert.equal(await e("document.querySelectorAll('#todo-progress-list [role=img][aria-label]').length"), 18);
      assert.ok(detail.text.includes("已完成 1/18")); assert.ok(detail.current?.includes("第 2 项"));
      assert.ok(detail.left >= 0 && detail.right <= width, `detail within viewport ${mode}: ${JSON.stringify(detail)}`);
      await click("#todo-progress-list li:nth-child(2) .composer-work-read-more", mode.includes("touch"));
      assert.equal(await e("document.querySelector('#todo-progress-list li:nth-child(2) .composer-work-text').dataset.full"), "true");
      const textBoxes = await e("[...document.querySelectorAll('#todo-progress-list .composer-work-text')].map(n=>({visible:n.clientHeight,needed:n.scrollHeight}))");
      assert.ok(textBoxes.every((box: any) => box.visible >= box.needed), `no inaccessible short text ${mode}`);
      await click("#todo-progress-list li:nth-child(2) .composer-work-read-more", mode.includes("touch"));
      await e("document.querySelector('.composer-work-scroll').focus()"); await key("End");
      await wait("(()=>{const s=document.querySelector('.composer-work-scroll');return s.scrollTop+s.clientHeight>=s.scrollHeight-1})()");
      const after = await e("(()=>{const r=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {todo:r('#todo-progress'),queue:r('#queue-bar-host'),send:r('#submit')}})()");
      assert.deepEqual(after, geometry, `opening details does not resize/reflow halves ${mode}`);
      if (evidenceDirectory) {
        const image = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(evidenceDirectory, `${mode}.png`), Buffer.from(image.data, "base64"));
      }
      await key("Escape"); await wait("document.querySelector('#todo-progress-toggle').getAttribute('aria-expanded')==='false'");
      assert.equal(await e("document.activeElement.id"), "todo-progress-toggle");
      assert.equal(await e("editorNode===document.querySelector('#draft')&&editorNode.selectionStart===2&&editorNode.selectionEnd===5&&editorNode.value.includes('新草稿')"), true);
      await click("#todo-progress-toggle"); await click(".queue-bar-toggle");
      assert.equal(await e("document.querySelector('#todo-progress-toggle').getAttribute('aria-expanded')"), "false");
      await key("Escape");
      await e(`todoDensity.show(${JSON.stringify(rows)},false)`);
      const single = await e("(()=>{const t=document.querySelector('#todo-progress').getBoundingClientRect(),r=document.querySelector('.composer-top-row').getBoundingClientRect();return {slot:t.width,row:r.width}})()");
      assert.ok(Math.abs(single.slot - single.row) < 1, "single visible Todo keeps full width");
      for (const status of ["pending", "completed"]) {
        await e(`todoDensity.show(${JSON.stringify(rows.slice(0, 4).map(row => ({ ...row, status })))},true)`);
        await click("#todo-progress-toggle");
        assert.equal(await e(`document.querySelector('#todo-progress-body').textContent.includes('已完成 ${status === "completed" ? 4 : 0}/4')`), true);
        assert.equal(await e("document.querySelectorAll('#todo-progress-list [aria-current]').length"), 0);
        if (status === "completed") assert.equal(await e("document.querySelectorAll('#todo-progress-list [role=img][aria-label=已完成]').length"), 4);
        await key("Escape");
      }
      await e(`todoDensity.show(${JSON.stringify(rows)},true,{sourceKey:'density-stopped-turn',kind:'stopped',label:'已停止',note:'本轮已停止。以下是停止前最后记录，不提供续跑操作。'})`);
      await click("#todo-progress-toggle");
      assert.equal(await e("document.querySelector('#todo-progress-body').textContent.includes('最后记录 · 第 2 项')"), true);
      assert.equal(await e("document.querySelectorAll('#todo-progress-list [aria-current]').length"), 0);
      assert.equal(await e("document.querySelector('#todo-progress-body').textContent.includes('不提供续跑操作')"), true);
      await key("Escape");
      evidence.cases.push({ mode, width, geometry, detail: { ...detail, text: undefined, current: undefined }, single, basicStates: ["pending", "completed", "stopped"] });
    }
    assert.equal(await e("todoDensity.unintendedActions"), 0);
    assert.deepEqual(evidence.errors, []); evidence.ok = true;
  } catch (error) {
    evidence.failure = String(error); throw error;
  } finally {
    socket?.close(); browser?.kill("SIGTERM"); if (exited) await exited;
    if (server) await new Promise<void>(done => server!.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
    if (evidenceDirectory) writeFileSync(join(evidenceDirectory, "VERIFICATION.json"), JSON.stringify(evidence, null, 2));
  }
});
