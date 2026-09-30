// Development self-test only. Real renderer, expand/scroll logic and DOM;
// synthetic turns, no installed service, credentials, provider or screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "wand-realtime-refresh-browser-"));
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const results = [], exceptions = [], logs = [];
const bundle = join(dir, "app.js");
let browser, socket, server;
try {
  await build({ entryPoints: [join(import.meta.dirname, "realtime-refresh-browser-harness.ts")],
    bundle: true, platform: "browser", format: "iife", outfile: bundle,
    define: { "process.env.NODE_ENV": '"production"' } });
  server = createServer((req, res) => {
    const files = { "/app.js": [bundle, "text/javascript"],
      "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
      "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"] };
    const target = files[new URL(req.url, "http://fixture.test").pathname];
    if (target) { res.setHeader("Content-Type", target[1]); res.end(readFileSync(target[0])); return; }
    if (req.url.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <link rel="stylesheet" href="/tailwind.css"/><link rel="stylesheet" href="/styles.css"/>
      <style>#chat-output { height: 480px; display: flex; } .chat-messages { overflow-y: auto; }
      #fixture-input { width: 240px; height: 44px; }</style></head><body>
      <div id="chat-output"></div><textarea id="fixture-input"></textarea>
      <script src="/app.js"></script></body></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const httpPort = server.address().port;
  browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*",
    "--remote-debugging-port=0", `--user-data-dir=${dir}/profile`, `http://127.0.0.1:${httpPort}/`], { stdio: "ignore" });
  const activePortFile = join(dir, "profile/DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(activePortFile); i++) await sleep(50);
  assert.ok(existsSync(activePortFile), "Chrome must expose CDP");
  const cdpPort = readFileSync(activePortFile, "utf8").split("\n")[0];
  const tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  const page = tabs.find(tab => tab.type === "page" && tab.url.startsWith(`http://127.0.0.1:${httpPort}/`));
  assert.ok(page); socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, "open");
  let id = 0; const pending = new Map();
  socket.addEventListener("message", event => {
    const response = JSON.parse(event.data);
    if (response.method === "Runtime.exceptionThrown") exceptions.push(response.params.exceptionDetails.text);
    if (response.method === "Runtime.consoleAPICalled" && response.params.type === "error") {
      logs.push(response.params.args.map(arg => arg.value || arg.description).join(" "));
    }
    const request = pending.get(response.id); if (!request) return; pending.delete(response.id);
    if (response.error) request.reject(new Error(JSON.stringify(response.error))); else request.resolve(response.result);
  });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve: resolveSend, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  await send("Runtime.enable");
  for (let i = 0; i < 100 && !await evaluate("Boolean(window.realtimeRefreshHarness)"); i++) await sleep(50);
  assert.ok(await evaluate("Boolean(window.realtimeRefreshHarness)"), `harness load: ${exceptions.join("; ")}`);

  for (const mode of ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion"]) {
    await send("Emulation.setDeviceMetricsOverride", { width: mode === "390px" ? 390 : 1280,
      height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduce-motion" ? "reduce" : "no-preference" }] });
    await evaluate(`document.documentElement.classList.toggle("is-wand-app", ${mode === "native-shell"});
      history.replaceState(null, "", ${JSON.stringify(mode === "reactUi=0" ? "/?reactUi=0" : "/")});`);
    const result = await evaluate(`(async () => {
      const h = window.realtimeRefreshHarness;
      const turn = (text, i) => ({ role: "assistant", uuid: "fixture-" + i,
        createdAt: "2026-09-30T00:00:00Z", content: [{ type: "text", text }] });
      const frames = async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(resolve));
      };
      const row = i => document.querySelector('.chat-message[data-msg-index="' + i + '"]');
      const body = i => row(i)?.querySelector(".chat-message-content")?.textContent || "";
      h.resetChatRenderCache();
      let turns = Array.from({ length: 12 }, (_, i) => turn("fixture row " + i + "\\n" + "fixture body\\n".repeat(12), i));
      h.setMessages(turns); h.doRenderChat(false); await frames();
      const container = document.querySelector(".chat-messages");
      const unchanged = row(5); container.scrollTop = -1200; await frames();
      const anchor = row(8); const before = anchor.getBoundingClientRect().top;
      const bounds = container.getBoundingClientRect();
      const anchorBounds = anchor.getBoundingClientRect();
      if (anchorBounds.bottom <= bounds.top || anchorBounds.top >= bounds.bottom) throw new Error("reading anchor must be visible");
      const input = document.querySelector("#fixture-input"); input.value = "fixture draft"; input.focus();
      const rectBefore = input.getBoundingClientRect().toJSON();
      turns = turns.slice(); turns[0] = turn("RRQA_A_05", 0); turns[11] = turn("RRQA_A_05", 11);
      h.setMessages(turns); h.doRenderChat(false); await frames();
      const afterEarlierAndTail = { old: body(0).includes("RRQA_A_05"), tail: body(11).includes("RRQA_A_05"),
        unchanged: row(5) === unchanged, anchorDelta: anchor.getBoundingClientRect().top - before };
      turns[0] = turn("RRQA_B_05", 0); turns[11] = turn("RRQA_B_05", 11);
      h.setMessages(turns); h.doRenderChat(false); await frames();
      const afterEqual = { old: body(0).includes("RRQA_B_05"), tail: body(11).includes("RRQA_B_05"),
        unchanged: row(5) === unchanged, focus: document.activeElement === input, draft: input.value === "fixture draft",
        geometry: JSON.stringify(input.getBoundingClientRect().toJSON()) === JSON.stringify(rectBefore) };
      // Existing activity expansion state and child Agent Run suppression are real.
      const toolTurns = [{ role: "assistant", uuid: "tool-fixture", content: [
        { type: "thinking", thinking: "fixture thinking AAAA" },
        { type: "tool_use", id: "fixture-tool", name: "Read", input: { file_path: "fixture.txt" } },
        { type: "tool_result", tool_use_id: "fixture-tool", content: [{ type: "text", text: "AAAA" }] }] }];
      h.setMessages(toolTurns); h.doRenderChat(false); await frames();
      const expandable = document.querySelector('[data-expand-key][data-expand-kind="activity"]');
      if (!expandable) throw new Error("fixture must have a real activity expansion element");
      const expandKey = expandable.dataset.expandKey; h.setExpanded(expandable, "activity", true);
      toolTurns[0].content[0].thinking = "fixture thinking BBBB";
      toolTurns[0].content[2].content[0].text = "BBBB";
      h.setMessages(toolTurns); h.doRenderChat(false); await frames();
      const expanded = document.querySelector('[data-expand-key="' + CSS.escape(expandKey) + '"]');
      const preservedExpand = expanded?.getAttribute("data-expanded") === "true";
      const nested = row(0)?.textContent.includes("BBBB");
      const meta = { taskId: "fixture-child", agentType: "Explore", taskDescription: "fixture" };
      const runTurns = [{ role: "assistant", uuid: "dispatch", content: [{ type: "tool_use", name: "Task",
        id: "fixture-child", input: { subagent_type: "Explore" }, __subagent: meta }] },
        { role: "assistant", uuid: "child", content: [{ type: "text", text: "AAAA", __subagent: meta }] }];
      h.setMessages(runTurns); h.doRenderChat(false); await frames();
      const runContainer = document.querySelector(".chat-messages");
      const mutateRecords = []; const observer = new MutationObserver(records => mutateRecords.push(...records));
      observer.observe(runContainer, { childList: true });
      runTurns[1].content[0].text = "BBBB"; h.setMessages(runTurns); h.doRenderChat(false); await frames();
      observer.disconnect();
      const localRunUpdate = mutateRecords.every(record => record.removedNodes.length <= 1 && record.addedNodes.length <= 1);
      const runChanged = runContainer.textContent.includes("BBBB");
      return { afterEarlierAndTail, afterEqual, preservedExpand, nested, localRunUpdate, runChanged };
    })()`);
    assert.equal(result.afterEarlierAndTail.old, true); assert.equal(result.afterEarlierAndTail.tail, true);
    assert.equal(result.afterEarlierAndTail.unchanged, true);
    // Native browser scroll anchoring must keep the unchanged reading row stable.
    assert.ok(Math.abs(result.afterEarlierAndTail.anchorDelta) <= 1, `${mode}: anchor moved ${result.afterEarlierAndTail.anchorDelta}`);
    for (const value of Object.values(result.afterEqual)) assert.equal(value, true, `${mode}: equal-revision/focus/draft/geometry`);
    assert.equal(result.preservedExpand, true); assert.equal(result.nested, true);
    assert.equal(result.localRunUpdate, true); assert.equal(result.runChanged, true);
    results.push({ mode, ...result });
  }
  assert.deepEqual(exceptions, []); assert.deepEqual(logs, []);
  console.log(JSON.stringify({ ok: true, evidence: "source modules + synthetic data + real Chrome DOM; not installed-service acceptance",
    modes: results, runtimeExceptions: exceptions.length, consoleErrors: logs.length }, null, 2));
} finally {
  try { socket?.close(); } catch { /* own CDP only */ }
  if (browser && browser.exitCode === null) { browser.kill("SIGKILL"); await once(browser, "exit"); }
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
