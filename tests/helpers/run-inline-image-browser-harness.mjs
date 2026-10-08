// 真实 Chrome 回归：工具结果内联图片的加载态。
//
// 复用的是生产渲染器（tests/helpers/tool-timeline-browser-harness.ts 的 publish/fresh/settle），
// 只在这里补一条带延迟的 /api/file-raw：加载期间要有可见的占位反馈、图片到达后占位收掉，
// 失败时整块隐藏（不留虚线框，也不留 0×0 的空位）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "wand-inline-image-"));
const output = process.env.WAND_INLINE_IMAGE_OUTPUT;
const report = { ok: false, cases: [], errors: [], requests: [], states: [] };
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const IMAGE_MS = 1200;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** 现场生成一张真 PNG（宽高可断言，不依赖仓库外的二进制样本）。 */
function pngBytes(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    raw[at] = 240; raw[at + 1] = 122; raw[at + 2] = 42;
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let browser, socket, server;
try {
  const bundle = join(temp, "app.js");
  await build({ entryPoints: [join(root, "tests/helpers/tool-timeline-browser-harness.ts")],
    bundle: true, platform: "browser", format: "iife", outfile: bundle,
    define: { "process.env.NODE_ENV": '"production"' } });
  const shot = pngBytes(48, 32);
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.test");
    if (url.pathname === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(bundle)); return; }
    if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    if (url.pathname === "/api/file-raw") {
      const path = url.searchParams.get("path") || "";
      report.requests.push(path);
      if (path.endsWith("missing.png")) { res.writeHead(404); res.end(); return; }
      // 慢响应：加载态必须在图片到达之前就已经看得见。
      setTimeout(() => { res.setHeader("Content-Type", "image/png"); res.setHeader("Cache-Control", "no-store"); res.end(shot); }, IMAGE_MS);
      return;
    }
    if (url.pathname.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<link rel="stylesheet" href="/style.css"><style>#chat-output{height:720px;display:flex}</style>' +
      '</head><body><div id="chat-output"></div><script src="/app.js"></script></body></html>');
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
  const tab = tabs.find(candidate => candidate.type === "page" && candidate.url.startsWith(origin));
  socket = new WebSocket(tab.webSocketDebuggerUrl); await once(socket, "open");
  const pending = new Map(); let sequence = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") report.errors.push(message.params.exceptionDetails.text);
    const call = pending.get(message.id); if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(Error(JSON.stringify(message.error))); else call.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout: " + method)); }, 20000);
    pending.set(id, { resolve: resolveSend, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const e = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression, label) => {
    for (let n = 0; n < 160; n++) { if (await e(expression)) return; await sleep(50); }
    throw Error("condition missing: " + label);
  };
  // 一张图的可观测事实：容器状态、占位行几何、图片几何与解码结果。
  const IMAGE_PROBE = `(()=>{const box=document.querySelector(".inline-tool-image");if(!box)return null;const wait=box.querySelector(".inline-tool-image-loading");const img=box.querySelector("img.inline-tool-image-thumb");const rect=node=>node?node.getBoundingClientRect():null;const box_=rect(box);
    return {state:box.dataset.imageState,boxDisplay:getComputedStyle(box).display,boxHeight:box_?Math.round(box_.height):null,
      boxWidth:box_?Math.round(box_.width):null,placeholder:!!wait,placeholderDisplay:wait?getComputedStyle(wait).display:null,
      placeholderHeight:wait?Math.round(rect(wait).height):null,
      spinnerAnimation:wait?getComputedStyle(wait.querySelector(".inline-tool-image-spinner")).animationName:null,
      imageHeight:img?Math.round(rect(img).height):null,imageSrcAttr:img?String(img.getAttribute("src")||"").slice(0,28):null,
      natural:[img?img.naturalWidth:0,img?img.naturalHeight:0],hasStateGlobal:typeof window.__inlineToolImageState==="function"}})()`;
  await send("Runtime.enable"); await send("Network.enable"); await send("Page.bringToFront");
  await wait("!!window.toolTimelineHarness", "production harness");

  const modes = process.env.WAND_INLINE_IMAGE_MODES?.split(",") || ["desktop", "reduce-motion", "native-shell"];
  for (const mode of modes) {
    const reduce = mode.includes("reduce");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Network.clearBrowserCache");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });
    await e(`document.documentElement.classList.toggle("is-wand-app",${mode.includes("native")})`);
    const requestsBefore = report.requests.length;
    // ① Read 读图：图片走 /api/file-raw（慢响应），加载期间必须已经有可见反馈。
    await e(`(async()=>{window.h=toolTimelineHarness;await h.fresh([{role:"assistant",uuid:"read-image",content:[
      {type:"tool_use",id:"read-shot",name:"Read",input:{file_path:"/tmp/wand-shot.png"}},
      {type:"tool_result",tool_use_id:"read-shot",content:"",preview:"已读取 1 张图片"}]}])})()`);
    const loading = await e(IMAGE_PROBE);
    assert.ok(loading, mode + ": inline image renders: " + await e('document.querySelector("#chat-output").innerHTML.slice(0,700)'));
    assert.equal(loading.state, "loading", mode + ": state starts at loading");
    assert.equal(loading.hasStateGlobal, true, mode + ": the load-state handler is installed");
    assert.equal(loading.placeholder, true, mode + ": loading shows a placeholder");
    assert.ok(loading.placeholderHeight > 0, mode + ": the placeholder occupies real space: " + JSON.stringify(loading));
    assert.equal(loading.imageHeight, 0, mode + ": the not-yet-loaded image is still 0px tall: " + JSON.stringify(loading));
    assert.equal(loading.spinnerAnimation, reduce ? "none" : "wand-tool-icon-spin",
      mode + ": the spinner is motion-gated: " + JSON.stringify(loading));
    assert.equal(loading.imageSrcAttr, "/api/file-raw?path=%2Ftmp%2F", mode + ": the real image URL is kept (file preview keeps its path)");
    report.states.push({ mode, phase: "loading", ...loading });
    if (output && mode === "desktop") {
      mkdirSync(output, { recursive: true });
      const shotPng = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(output, "inline-image-loading.png"), Buffer.from(shotPng.data, "base64"));
    }
    await wait('document.querySelector(".inline-tool-image")?.dataset.imageState==="ready"', mode + ": image reaches ready");
    const ready = await e(IMAGE_PROBE);
    assert.equal(ready.placeholderDisplay, "none", mode + ": the placeholder is gone once loaded: " + JSON.stringify(ready));
    assert.deepEqual(ready.natural, [48, 32], mode + ": the real PNG is decoded: " + JSON.stringify(ready));
    assert.ok(ready.imageHeight > 0 && ready.imageHeight <= 32, mode + ": the image takes its real box: " + JSON.stringify(ready));
    assert.notEqual(ready.boxDisplay, "none", mode + ": a loaded image stays visible");
    report.states.push({ mode, phase: "ready", ...ready });
    if (output && mode === "desktop") {
      const shotPng = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(output, "inline-image-ready.png"), Buffer.from(shotPng.data, "base64"));
    }
    // ② 重新画一遍（会话回放 / 流式刷新）：已解码的图不能再卡在占位态。
    await e('(async()=>{h.publish(h.turns(),false);await h.settle()})()');
    await wait('document.querySelector(".inline-tool-image")?.dataset.imageState==="ready"', mode + ": repaint reaches ready");
    assert.equal(await e('document.querySelectorAll(".inline-tool-image").length'), 1, mode + ": a repaint keeps one inline image");
    assert.equal(await e('getComputedStyle(document.querySelector(".inline-tool-image .inline-tool-image-loading")).display'), "none",
      mode + ": a repaint of an already-loaded image does not keep the placeholder");
    // ③ 取图失败：整块隐藏，不留虚线占位，也不留空位。
    await e(`(async()=>{await h.fresh([{role:"assistant",uuid:"read-missing",content:[
      {type:"tool_use",id:"read-missing",name:"Read",input:{file_path:"/tmp/missing.png"}}]}])})()`);
    await wait('document.querySelector(".inline-tool-image")?.dataset.imageState==="error"', mode + ": failed image reaches error");
    const failed = await e(IMAGE_PROBE);
    assert.equal(failed.boxDisplay, "none", mode + ": a failed image hides its whole block: " + JSON.stringify(failed));
    assert.equal(failed.boxHeight, 0, mode + ": a failed image leaves no gap: " + JSON.stringify(failed));
    report.states.push({ mode, phase: "error", ...failed });
    // ④ 工具结果内联的 base64 图（截图类工具）走同一条路径，也要有加载态与终态。
    await e(`(async()=>{await h.fresh([{role:"assistant",uuid:"tool-image",content:[
      {type:"tool_use",id:"shot-call",name:"screenshot",input:{}},
      {type:"tool_result",tool_use_id:"shot-call",content:[{type:"image",source:{type:"base64",media_type:"image/png",data:${JSON.stringify(shot.toString("base64"))}}}]}]}])})()`);
    await wait('document.querySelector(".inline-tool-image")?.dataset.imageState==="ready"', mode + ": base64 image reaches ready");
    const inline64 = await e(IMAGE_PROBE);
    assert.equal(inline64.placeholderDisplay, "none", mode + ": base64 image also drops its placeholder");
    assert.deepEqual(inline64.natural, [48, 32], mode + ": inline base64 image decodes: " + JSON.stringify(inline64));
    assert.ok(inline64.imageSrcAttr.startsWith("data:image/png"), mode + ": inline content keeps its data URI");
    report.states.push({ mode, phase: "base64", ...inline64 });
    assert.ok(report.requests.length > requestsBefore, mode + ": the fixture served real bytes");
  }
  assert.deepEqual(report.errors, []);
  report.ok = true;
} finally {
  try { socket?.close(); } catch (error) {}
  try { browser?.kill(); } catch (error) {}
  try { server?.close(); } catch (error) {}
  try { rmSync(temp, { recursive: true, force: true }); } catch (error) {}
}
console.log(JSON.stringify(report));
