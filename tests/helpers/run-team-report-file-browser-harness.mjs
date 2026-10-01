// Development-only synthetic data; real TeamChatView and FilePreviewHost in Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
const temp = mkdtempSync(join(tmpdir(), "wand-report-card-"));
const root = resolve(import.meta.dirname, "../..");
const bundle = join(temp, "app.js");
await build({ entryPoints: [join(import.meta.dirname, "team-report-file-browser-harness.tsx")],
  bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: bundle,
  define: { "process.env.NODE_ENV": '"production"' } });
let previews = 0, downloads = 0;
const server = createServer((req, res) => {
  if (req.url.startsWith("/api/file-preview?")) {
    previews++;
    assert.equal(new URL(req.url, "http://localhost").searchParams.get("path"), "/tmp/报告 & 结果.md");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ kind: "text", path: "/tmp/报告 & 结果.md", name: "报告 & 结果.md",
      ext: ".md", size: 2048, mime: "text/markdown", lang: "markdown", content: "# 报告文件卡片 · 实现与验证\n完整正文只在预览中出现。\nFULL_REPORT_ONLY_TAIL" }));
  } else if (req.url.startsWith("/api/file-raw?")) {
    downloads++;
    res.writeHead(200, { "Content-Type": "text/markdown", "Content-Disposition": "attachment; filename=report.md" });
    res.end("# 报告文件卡片 · 实现与验证\n完整正文只在预览中出现。\nFULL_REPORT_ONLY_TAIL");
  } else if (req.url === "/api/ai-team-runs/run-1/live") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ runId: "run-1", taskId: "task-1", steps: [] }));
  } else if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(bundle));
  } else if (req.url === "/styles.css" || req.url === "/tailwind.css") {
    res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content", req.url.slice(1))));
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <link rel="stylesheet" href="/styles.css"/><link rel="stylesheet" href="/tailwind.css"/>
      <style>html,body,#root{height:100%;margin:0}#root{max-width:900px;margin:auto}.task-board-team-chat{height:100%;display:flex;flex-direction:column}.task-board-team-chat-list{flex:1;min-height:0;overflow:auto}</style>
      </head><body><div id="root"></div><div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>`);
  }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chrome, socket;
const results = [];
try {
  chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const portFile = join(temp, "profile/DevToolsActivePort");
  for (let n = 0; n < 100 && !existsSync(portFile); n++) await sleep(50);
  assert.ok(existsSync(portFile));
  const tabs = await (await fetch(`http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}/json`)).json();
  socket = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl); await once(socket, "open");
  let seq = 0, errors = 0; const pending = new Map();
  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data); if (msg.method === "Runtime.exceptionThrown") { errors++; console.error(msg.params.exceptionDetails); }
    const call = pending.get(msg.id); if (!call) return; pending.delete(msg.id);
    msg.error ? call.reject(Error("CDP failed")) : call.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error("browser evaluation failed"); return r.result.value; };
  const wait = async expression => { for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await sleep(50); } throw Error(`condition missing: ${expression}`); };
  const click = async selector => { const pos = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...pos, button: "left", clickCount: 1 }); };
  await send("Runtime.enable"); await send("Page.enable");
  mkdirSync(join(temp, "downloads"));
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(temp, "downloads") });
  for (const mode of ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion", "390px-native-reduce"]) {
    const startPreview = previews, startDownload = downloads;
    const narrow = mode.includes("390px"), native = mode.includes("native"), reduced = mode.includes("reduce");
    await send("Emulation.setDeviceMetricsOverride", { width: narrow ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
    await send("Page.navigate", { url: origin + (mode === "reactUi=0" ? "/?reactUi=0" : "/") });
    await wait('!!document.querySelector(".team-chat-file-card")');
    if (native) await evaluate('document.documentElement.classList.add("is-wand-app")');
    const initial = await evaluate(`(()=>{const n=document.querySelector('.team-chat-file-card');const r=n.getBoundingClientRect();return{width:r.width,overflow:document.documentElement.scrollWidth>innerWidth,body:document.querySelector('.team-chat-msg-content').textContent,preview:!!n.querySelector('.team-chat-preview'),expand:!!n.querySelector('.team-chat-expand')}})()`);
    assert.equal(initial.overflow, false); assert.equal(initial.preview, false); assert.equal(initial.expand, false);
    assert.ok(initial.body.includes("报告 & 结果.md") && initial.body.includes("2.0 KB"));
    assert.ok(initial.body.includes("报告文件卡片 · 实现与验证") && initial.body.includes("群聊保留标题与结论预览"));
    assert.ok(!initial.body.includes("正文不应在消息中出现") && !initial.body.includes("FULL_REPORT_ONLY_TAIL"));
    const excerpt = await evaluate(`(()=>{const n=document.querySelector('.team-chat-file-excerpt');const s=getComputedStyle(n);return{height:n.getBoundingClientRect().height,lineHeight:parseFloat(s.lineHeight),clamp:s.webkitLineClamp,thumbnail:document.querySelector('.team-chat-file-icon').textContent.includes('群聊保留标题与结论预览')}})()`);
    assert.equal(excerpt.clamp, "3"); assert.ok(excerpt.height <= excerpt.lineHeight * 3 + 1); assert.equal(excerpt.thumbnail, true);
    assert.equal(previews, startPreview, "no prefetch"); assert.equal(downloads, startDownload);
    if (mode === "desktop" || mode === "390px") {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(join(root, "output/team-report-preview"), { recursive: true });
      writeFileSync(join(root, `output/team-report-preview/card-${mode}.png`), Buffer.from(shot.data, "base64"));
    }
    await click(".team-chat-file-open");
    await wait('!!document.querySelector(".wand-file-preview-dialog") && document.querySelector(".wand-file-preview-dialog").textContent.includes("FULL_REPORT_ONLY_TAIL")');
    assert.equal(previews, startPreview + 1, "one click reads one report");
    await click(".wand-file-preview-dialog a.wand-file-preview-download");
    for (let n = 0; n < 100 && downloads === startDownload; n++) await sleep(30);
    assert.equal(downloads, startDownload + 1);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait('!document.querySelector(".wand-file-preview-dialog")');
    await wait('document.activeElement === document.querySelector(".team-chat-file-open")');
    results.push({ mode, width: initial.width, boundedExcerpt: true, thumbnail: true, noFullBody: true, noPrefetch: true, previews: 1, downloads: 1, focusRestored: true, overflow: false });
  }
  assert.equal(errors, 0); console.log(JSON.stringify({ ok: true, results, errors }));
} finally {
  socket?.close(); if (chrome && chrome.exitCode === null) { chrome.kill("SIGKILL"); await once(chrome, "exit"); }
  server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
