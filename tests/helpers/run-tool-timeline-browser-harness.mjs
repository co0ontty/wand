import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "wand-tool-timeline-"));
const output = process.env.WAND_TIMELINE_OUTPUT;
const report = { ok: false, cases: [], requests: [], errors: [], removedSelectorHits: [] };
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
let browser, socket, server;
try {
  const bundle = join(temp, "app.js");
  await build({ entryPoints: [join(root, "tests/helpers/tool-timeline-browser-harness.ts")],
    bundle: true, platform: "browser", format: "iife", outfile: bundle,
    define: { "process.env.NODE_ENV": '"production"' } });
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.test").pathname;
    if (path === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(bundle)); return; }
    if (path === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    if (path.startsWith("/api/sessions/timeline-fixture/tool-content/")) {
      report.requests.push(path.split("/").pop());
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ input: { file_path: "src/main.ts" }, content: "DETAIL_ONLY",
        pending: false, resultAvailable: true })); return;
    }
    if (path.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<link rel="stylesheet" href="/style.css"><style>#chat-output{height:600px;display:flex}.chat-messages{overflow-y:auto}</style>' +
      '</head><body><div id="chat-output"></div><button id="outside">外部</button><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0",
      `--user-data-dir=${temp}/profile`, origin], { stdio: "ignore" });
  const portFile = join(temp, "profile/DevToolsActivePort");
  for (let n = 0; n < 100 && !existsSync(portFile); n++) await sleep(50);
  assert.ok(existsSync(portFile), "real Chrome required");
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs.find(tab => tab.type === "page" && tab.url.startsWith(origin));
  socket = new WebSocket(tab.webSocketDebuggerUrl); await once(socket, "open");
  const pending = new Map(); let sequence = 0;
  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") report.errors.push(msg.params.exceptionDetails.text);
    const call = pending.get(msg.id); if (!call) return;
    pending.delete(msg.id); clearTimeout(call.timer);
    if (msg.error) call.reject(Error(JSON.stringify(msg.error))); else call.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout: " + method)); }, 15000);
    pending.set(id, { resolve: resolveSend, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const e = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let n = 0; n < 100; n++) { if (await e(expression)) return; await sleep(25); }
    throw Error("condition missing: " + expression);
  };
  const click = async selector => {
    const rect = await e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:"nearest"});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...rect, button: "left", clickCount: 1 });
  };
  await send("Runtime.enable"); await send("Page.bringToFront");
  await wait("!!window.toolTimelineHarness");
  const modes = ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion", "390px-native-reduce"];
  for (const mode of modes) {
    await send("Emulation.setDeviceMetricsOverride", { width: mode.includes("390px") ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode.includes("reduce") ? "reduce" : "no-preference" }] });
    await e(`document.documentElement.classList.toggle("is-wand-app",${mode.includes("native")});history.replaceState(null,"",${JSON.stringify(mode === "reactUi=0" ? "/?reactUi=0" : "/")});`);
    await e(`(async()=>{window.h=toolTimelineHarness;window.fixture=[{role:"assistant",uuid:"timeline-row",content:Array.from({length:40},(_,i)=>({type:"tool_use",id:"call-"+i,name:"Read",input:{},activity:{kind:i%2?"edit_file":"read_file",label:(i%2?"修改":"查看")+" src/main.ts",fileKey:"same-file",occurredAt:"2026-09-30T12:00:"+String(i).padStart(2,"0")+"Z"}}))}];await h.fresh(fixture)})()`);
    assert.equal(await e('document.querySelectorAll(".assistant-reply-disclosure,.chat-avatar").length'), 0, "no outer reply card/avatar");
    const initialRequests = report.requests.length;
    const before = await e('document.querySelector(".chat-activity-summary").getBoundingClientRect().toJSON()');
    await click(".chat-activity-summary"); await e("h.settle()");
    assert.equal(report.requests.length, initialRequests, "timeline expansion must not fetch any detail");
    assert.equal(await e('document.querySelectorAll(".chat-activity-entry").length'), 40);
    assert.deepEqual(await e('Array.from(document.querySelectorAll(".chat-activity-entry[data-tool-ids]")).map(n=>JSON.parse(n.dataset.toolIds))'), Array.from({length:40},(_,i)=>["call-"+i]));
    const metrics = await e('(()=>{const n=document.querySelector(".chat-activity-timeline");return{height:n.clientHeight,overflow:n.scrollHeight>n.clientHeight,detail:!!n.querySelector("pre,.tool-use-card,.inline-diff,.inline-terminal"),summary:document.querySelector(".chat-activity-summary").getBoundingClientRect().toJSON(),wide:document.documentElement.scrollWidth>innerWidth}})()');
    assert.equal(metrics.height, 240); assert.equal(metrics.overflow, true); assert.equal(metrics.detail, false); assert.equal(metrics.wide, false);
    assert.equal(await e('Array.from(document.querySelectorAll(".chat-activity-entry-button")).every(row=>{const clock=row.querySelector("time");const label=row.querySelector(".chat-activity-entry-label");return !clock || clock.getBoundingClientRect().right <= label.getBoundingClientRect().left})'), true, "each time is rendered at the beginning, before its file/tool label");
    for (const axis of ["x","y","width","height"]) assert.ok(Math.abs(metrics.summary[axis]-before[axis])<=1, "summary stays in place: " + axis);
    if (output && (mode === "desktop" || mode === "390px")) {
      mkdirSync(output,{recursive:true});
      const shot = await send("Page.captureScreenshot",{format:"png"}); writeFileSync(join(output,`timeline-summary-${mode}.png`),Buffer.from(shot.data,"base64"));
    }
    report.removedSelectorHits.push({ mode, groups: await e('document.querySelectorAll(".chat-activity-group,.chat-activity-group-title").length'), oldAnimation: await e('document.getAnimations().filter(a=>a.animationName==="activity-menu-in").length') });
    await click('.chat-activity-entry:nth-child(1) .chat-activity-entry-button');
    await wait('document.querySelector(".chat-activity-entry-detail")?.textContent.includes("DETAIL_ONLY")'); await e("h.settle()");
    assert.deepEqual(report.requests.slice(initialRequests), ["call-0"], "only the explicitly opened call is loaded");
    assert.equal(await e('document.querySelector(".chat-activity-timeline").clientHeight'), 240, "details cannot grow the window");
    await click('.chat-activity-entry:nth-child(3) .chat-activity-entry-button');
    await wait('document.querySelectorAll(".chat-activity-entry-detail .inline-tool-result-text").length===2');
    assert.deepEqual(report.requests.slice(initialRequests), ["call-0", "call-2"], "same file does not batch-load other invocations");
    await e("h.settle()");
    for (let n=0;n<80 && !await e('document.activeElement.matches(".chat-activity-summary")');n++) {
      await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9,modifiers:8});
      await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9,modifiers:8});
    }
    assert.equal(await e('document.activeElement.matches(".chat-activity-summary")'),true);
    await e('window.originalSummary=document.activeElement;window.originalGlyph=originalSummary.querySelector("svg");document.querySelector(".chat-activity-timeline").scrollTop=180');
    const top = await e('document.querySelector(".chat-activity-timeline").scrollTop');
    await e('(async()=>{fixture[0].content.push({...fixture[0].content[0],id:"call-40"});h.publish(fixture);await h.settle()})()');
    assert.equal(await e('document.activeElement===originalSummary && originalSummary.isConnected && originalSummary.contains(originalGlyph)'),true,"actual keyboard-focused summary/glyph survives streaming");
    assert.equal(await e('document.querySelector(".chat-activity-timeline").scrollTop'), top, "streaming keeps inner scroll position");
    assert.equal(report.requests.length, initialRequests+2);
    if (output && (mode === "desktop" || mode === "390px")) {
      mkdirSync(output,{recursive:true});
      const shot = await send("Page.captureScreenshot",{format:"png"}); writeFileSync(join(output,`timeline-${mode}.png`),Buffer.from(shot.data,"base64"));
    }
    await click(".chat-activity-summary"); await e("h.settle()");
    assert.equal(await e('document.querySelector(".chat-activity-menu").getBoundingClientRect().height'), 0);
    assert.equal(await e('document.querySelector(".chat-activity-menu").inert'), true);
    await click(".chat-activity-summary"); await e("h.settle()");
    await send("Input.dispatchKeyEvent", { type:"keyDown", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
    await send("Input.dispatchKeyEvent", { type:"keyUp", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
    await e("h.settle()"); assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"false");
    await click(".chat-activity-summary"); await click("#outside"); await e("h.settle()");
    assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"false");
    // Body-bearing replies retain their existing disclosure and regular copy/identity.
    await e('(async()=>{fixture[0].content.push({type:"text",text:"正式回复"});await h.fresh(fixture)})()');
    assert.equal(await e('document.querySelectorAll(".assistant-reply-disclosure").length'),1);
    report.cases.push({ mode, fixedHeight:240, rows:40, requestCount:2, stableScroll:true, closePaths:true });
  }
  assert.deepEqual(report.errors, []); assert.ok(report.removedSelectorHits.every(x=>x.groups===0 && x.oldAnimation===0));
  report.ok = true; console.log(JSON.stringify(report));
} catch (error) {
  report.failure=String(error.stack||error); throw error;
} finally {
  if (output) { mkdirSync(output,{recursive:true}); writeFileSync(join(output,"browser-results.json"),JSON.stringify(report,null,2)); }
  socket?.close();
  if (browser && browser.exitCode===null) { browser.kill("SIGKILL"); await once(browser,"exit"); }
  if (server?.listening) await new Promise(resolveClose=>server.close(resolveClose));
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
