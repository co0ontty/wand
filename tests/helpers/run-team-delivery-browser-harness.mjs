// Real Chrome, synthetic HTTP fixtures only. Does not contact the installed service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { teamDeliveryFixture } from "./team-delivery-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "wand-team-delivery-"));
const root = resolve(import.meta.dirname, "../..");
const bundle = join(temp, "app.js");
await build({ entryPoints: [join(import.meta.dirname, "team-delivery-browser-harness.tsx")],
  bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: bundle,
  define: { "process.env.NODE_ENV": '"production"' } });
let filesRead = 0, knowledgeReads = 0;
let details = { "run-a": teamDeliveryFixture(), "run-b": teamDeliveryFixture("task-b", "run-b") };
// Repository hosts now project the canonical transcript, rather than the legacy
// TeamChatView announcement. Keep actual task-associated messages in their DTOs.
function appendContext(detail, text) {
  detail.chatTitle = text;
  // Deliberately equal title timestamps also exercise request generations: a
  // late GET/action receipt must not restore a superseded task label.
  detail.chatTitleUpdatedAt = "2026-10-03T10:00:00.000Z";
  detail.chatTurns.push({
    messageId: `${detail.run.id}:${detail.chatTurns.length}`,
    role: "assistant", content: [{ type: "text", text }],
    conversationTarget: { taskId: detail.run.taskId, runId: detail.run.id },
    createdAt: detail.run.updatedAt, completedAt: detail.run.updatedAt,
  });
}
let holdNext = false, holdReply = false;
const held = [];
const calls = [];
const server = createServer(async (req, res) => {
  calls.push(req.url);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.url.startsWith("/api/file-preview?")) {
    filesRead++;
    const path = new URL(req.url, "http://localhost").searchParams.get("path");
    res.end(JSON.stringify({ kind: "text", path, name: path.split("/").at(-1), ext: ".md", size: 100,
      content: "# 公共预览正文\n这是点击后才读取的真实合成文件响应" }));
  } else if (req.url.includes("knowledge")) { knowledgeReads++; res.end("{}");
  } else if (/^\/api\/sessions\/(relay-[ab]|step-session)\?/.test(req.url)) {
    const id = new URL(req.url, "http://localhost").pathname.split("/").at(-1);
    res.end(JSON.stringify({ id, status: "idle", messages: [] }));
  } else if (req.url.includes("/team-runs")) {
    const id = req.url.includes("task-b") ? "run-b" : "run-a";
    res.end(JSON.stringify([details[id].run]));
  } else if (/\/api\/ai-team-runs\/run-[ab]$/.test(req.url)) {
    const body = JSON.stringify(details[req.url.split("/").at(-1)]);
    if (holdNext) { holdNext = false; await new Promise((release) => held.push(release)); }
    res.end(body);
  } else if (req.url.endsWith("/reply")) {
    const body = JSON.stringify(details[req.url.split("/").at(-2)]);
    if (holdReply) await new Promise((release) => held.push(release));
    res.end(body);
  } else if (req.url.endsWith("/live")) { res.end(JSON.stringify({ runId: "run-a", steps: [] }));
  } else if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(bundle));
  } else if (req.url === "/styles.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css")));
  } else if (req.url.startsWith("/api/")) { res.end("{}");
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <link rel="stylesheet" href="/styles.css"/><style>body{margin:0}#root{max-width:900px;margin:auto;padding:14px}#card{margin-bottom:14px}#chat{height:650px;display:flex;flex-direction:column}#chat>.task-board-team-chat{min-height:0;flex:1}</style></head>
      <body><div id="root" data-wand-ui-root></div><div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>`);
  }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chrome, socket;
const results = [];
try {
  chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const portFile = join(temp, "profile/DevToolsActivePort");
  for (let n = 0; n < 100 && !existsSync(portFile); n++) await sleep(50);
  assert.ok(existsSync(portFile));
  const tabs = await (await fetch(`http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}/json`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl); await once(socket, "open");
  let seq = 0, errors = 0; const pending = new Map();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") { errors++; console.error(msg.params.exceptionDetails); }
    const call = pending.get(msg.id); if (!call) return; pending.delete(msg.id);
    msg.error ? call.reject(Error(JSON.stringify(msg.error))) : call.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(expression.slice(0, 180) + ": " + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await sleep(40); }
    throw Error(`condition missing: ${expression}; calls: ${JSON.stringify(calls)}; ${await evaluate('document.querySelector("#root").textContent')}`);
  };
  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
    await sleep(220);
    const pos = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${pos.x},${pos.y}))`), true, selector);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...pos, button: "left", clickCount: 1 });
    await sleep(400);
  };
  const clickText = async (owner, label) => {
    const marker = "fixture-" + Math.random().toString(36).slice(2);
    await evaluate(`(()=>{const n=Array.from(document.querySelectorAll(${JSON.stringify(owner)}+' button')).find(n=>n.textContent.includes(${JSON.stringify(label)}));if(!n)throw Error('button missing');n.setAttribute('data-fixture-click',${JSON.stringify(marker)})})()`);
    await click(`[data-fixture-click="${marker}"]`);
  };
  const text = async (selector, value) => {
    await click(selector);
    await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  };
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(600);
  };
  const rect = (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return[r.x,r.y+scrollY,r.width,r.height]})()`);
  const publish = (detail) => evaluate(`window.deliveryHarness.setDetail(${JSON.stringify(detail)})`);
  const panelChat = '#panel .task-board-team-view[data-view="chat"] .conversation-stream';
  const runsChat = '#runs .task-board-team-view[data-view="chat"] .conversation-stream';
  const visibleContext = async (selector, title) => {
    await wait(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(title)})`);
    assert.equal(await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n.checkVisibility() && !n.closest('[inert]') && n.closest('[role=tabpanel]').getAttribute('aria-hidden')==='false'})()`), true, "canonical context is actually visible and interactive");
    assert.equal(await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}+' .ant-tag')).some(n=>n.textContent===${JSON.stringify(title)})`), true, "current task label belongs to the visible transcript");
    assert.equal(await evaluate('document.body.textContent.includes("部分执行状态暂时无法读取")'), false, "relay fixture supplies the current activity contract");
  };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  for (const mode of ["desktop", "390px", "reduce-motion"]) {
    await send("Emulation.setDeviceMetricsOverride", { width: mode === "390px" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduce-motion" ? "reduce" : "no-preference" }] });
    await send("Page.navigate", { url: origin + `/?mode=${mode}` });
    await wait(`location.search === '?mode=${mode}' && !!document.querySelector('#chat .team-chat-context')`);
    const beforeReads = filesRead;
    assert.ok((await evaluate('document.querySelector(".team-chat-context").textContent')).includes("23 文件 · 8 接力"));
    const before = await rect("#card .team-delivery-trigger");
    await click("#card .team-delivery-trigger");
    assert.deepEqual(await rect("#card .team-delivery-trigger"), before, "task disclosure anchored");
    assert.ok((await evaluate('document.querySelector("#card").textContent')).includes("2/23"));
    assert.ok((await evaluate('document.querySelector("#card").textContent')).includes("1/8"));
    assert.equal(filesRead, beforeReads, "opening delivery makes no file request");
    await click("#card .ant-file-card"); await wait('!!document.querySelector("[data-testid=file-preview-dialog]")');
    await wait('document.body.textContent.includes("公共预览正文")');
    assert.equal(filesRead, beforeReads + 1, "actual public preview controller fetched exactly once");
    assert.ok((await evaluate('document.querySelector(".wand-file-preview-download").getAttribute("href")')).startsWith("/api/file-raw?download=1&path="));
    await escape(); await wait('!document.querySelector("[data-testid=file-preview-dialog]")');
    await click("#card .team-delivery-trigger");
    await click("#card .team-delivery-trigger"); await escape();
    assert.equal(await evaluate('document.querySelector("#card .team-delivery-trigger").getAttribute("aria-expanded")'), "false");
    assert.deepEqual(await rect("#card .team-delivery-trigger"), before);
    const chatBefore = await rect(".team-chat-context");
    await click(".team-chat-context");
    assert.deepEqual(await rect(".team-chat-context"), chatBefore, "announcement anchored");
    await text("#chat textarea", "保留群聊草稿");
    const fresh = teamDeliveryFixture(); fresh.run.status = "done"; fresh.run.updatedAt = "2026-10-03T10:02:00Z";
    fresh.delivery.updatedAt = fresh.run.updatedAt; fresh.delivery.conclusion = "负责人晚到的交付说明";
    await click("#card .team-delivery-trigger");
    await publish(fresh); await publish(teamDeliveryFixture());
    const emptyPreview = structuredClone(fresh);
    emptyPreview.delivery.files[0].file.preview = { title: "", excerpt: "" };
    await publish(emptyPreview);
    assert.ok((await evaluate('document.querySelector("#chat .team-delivery-details").textContent')).includes("仅显示服务器提供的摘录"), "same-timestamp empty preview cannot regress complete delivery");
    assert.equal(await evaluate('document.querySelector("#card .team-delivery-trigger").getAttribute("aria-expanded")'), "true", "same-run card refresh preserves choice");
    await click("#card .team-delivery-trigger");
    assert.equal(await evaluate('document.querySelector(".team-chat-context").getAttribute("aria-expanded")'), "true");
    assert.equal(await evaluate('document.querySelector("#chat textarea").value'), "保留群聊草稿");
    assert.ok((await evaluate('document.querySelector(".team-chat-context").textContent')).includes("负责人晚到的交付说明"));
    await click(".team-chat-context"); await click(".team-chat-context"); await escape();
    assert.equal(await evaluate('document.querySelector(".team-chat-context").getAttribute("aria-expanded")'), "false");
    await publish({ ...fresh, delivery: undefined });
    assert.equal(await evaluate('document.querySelector(".team-chat-context").getAttribute("aria-expanded")'), "false", "late missing field cannot reset choice");
    const old = teamDeliveryFixture(); delete old.delivery;
    await evaluate(`window.deliveryHarness.replaceDetail(${JSON.stringify(old)})`);
    assert.ok((await evaluate('document.querySelector(".team-chat-context").textContent')).includes("群公告"));
    assert.equal(await evaluate('document.querySelector("#chat textarea").value'), "保留群聊草稿");
    await publish(fresh); assert.equal(await evaluate('document.querySelector(".team-chat-context").getAttribute("aria-expanded")'), "false", "first late delivery respects explicit collapse");
    const capped = structuredClone(fresh);
    capped.run.updatedAt = "2026-10-03T10:03:00Z"; capped.delivery.updatedAt = capped.run.updatedAt;
    const fileTemplate = capped.delivery.files[1];
    const fileWindow = (newest) => Array.from({ length: 20 }, (_, index) => {
      const seq = newest - index;
      return { ...fileTemplate, stepId: `step-${seq}`, seq,
        file: { ...fileTemplate.file, stepId: `step-${seq}`, name: `report-${seq}.md`, path: `/synthetic/report-${seq}.md` } };
    });
    capped.delivery.files = fileWindow(25); capped.delivery.totalFiles = 25;
    await publish(capped); await click(".team-chat-context");
    const cappedTrigger = await rect(".team-chat-context");
    for (const [totalFiles, files] of [[24, fileWindow(24)], [24, fileWindow(25)], [25, fileWindow(24)]]) {
      await publish({ ...capped, delivery: { ...capped.delivery, totalFiles, files } });
      assert.ok((await evaluate('document.querySelector(".team-chat-context").textContent')).includes("25 文件"));
      const names = await evaluate('Array.from(document.querySelectorAll("#chat .team-delivery-files .ant-file-card")).map(n=>n.textContent)');
      assert.equal(names.length, 20);
      assert.ok(names[0].includes("report-25.md")); assert.ok(names.at(-1).includes("report-6.md"));
      assert.equal(names.some((name) => name.includes("report-5.md")), false, "retain snapshot, never union windows");
      assert.equal(await evaluate('document.querySelector(".team-chat-context").getAttribute("aria-expanded")'), "true");
      assert.deepEqual(await rect(".team-chat-context"), cappedTrigger);
    }
    const enriched = structuredClone(capped);
    enriched.delivery.files.at(-1).file.preview = { title: "满额窗口晚到的冻结标题", excerpt: "完整摘录" };
    await publish(enriched);
    assert.ok((await evaluate('document.querySelector("#chat .team-delivery-details").textContent')).includes("满额窗口晚到的冻结标题"));
    const newerMissing = structuredClone(enriched);
    newerMissing.run.updatedAt = "2026-10-03T10:04:00Z"; delete newerMissing.delivery;
    await publish(newerMissing);
    assert.ok((await evaluate('document.querySelector(".team-chat-context").textContent')).includes("群公告"));
    assert.equal(await evaluate('!!document.querySelector("#chat .team-delivery-details")'), false, "newer field-less source removes old delivery, not only its label");
    assert.equal(await evaluate('document.querySelector(".team-chat-context").getAttribute("aria-expanded")'), "true", "compatibility fallback retains explicit disclosure choice");
    assert.equal(await evaluate('document.querySelector("#chat textarea").value'), "保留群聊草稿");
    assert.equal(filesRead, beforeReads + 1, "window refresh/enrichment/fallback perform no file IO");
    await click(".team-chat-context");
    const next = { ...fresh, run: { ...fresh.run, id: "run-next", createdAt: "2026-10-04T10:00:00Z" }, delivery: { ...fresh.delivery, runId: "run-next" } };
    await click(".team-chat-context"); await publish(next);
    assert.equal(await evaluate('document.querySelector(".team-chat-context").getAttribute("aria-expanded")'), "false", "new run resets disclosure");
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, "no narrow overflow");
    if (mode === "reduce-motion") {
      assert.equal(await evaluate('!!document.querySelector("#card .ant-collapse")'), true);
      assert.ok(await evaluate('parseFloat(getComputedStyle(document.querySelector("#card .ant-collapse-panel")).transitionDuration) <= 0.001'), "library disclosure is instantaneous under reduced motion");
      assert.ok(await evaluate('parseFloat(getComputedStyle(document.querySelector(".team-chat-details")).transitionDuration) <= 0.001'));
    }
    results.push({ mode, summaryAndTotals: true, noPrefetch: true, publicPreviewAndDownload: true,
      triggerStable: true, closeAndEscape: true, lateDeliveryChoicePreserved: true, latePreviewProtected: true,
      cappedWindowProtected: true, newerMissingDeliveryFallback: true, draftPreserved: true, oldServerFallback: true });
  }
  // Real repository requests against the synthetic HTTP server exercise TaskTeamRunPanel's generations.
  details = { "run-a": teamDeliveryFixture(), "run-b": teamDeliveryFixture("task-b", "run-b") };
  details["run-b"].run.chatSessionId = "relay-b";
  appendContext(details["run-a"], "任务A上下文");
  appendContext(details["run-b"], "任务B结果");
  await send("Page.navigate", { url: origin + "/?panel=1" }); await visibleContext(panelChat, "任务A上下文");
  holdNext = true; await evaluate('window.deliveryHarness.refresh()');
  for (let n = 0; n < 100 && !held.length; n++) await sleep(25); assert.equal(held.length, 1);
  details["run-a"].run.updatedAt = "2026-10-03T10:03:00Z"; details["run-a"].delivery.headline = "任务A新结果";
  appendContext(details["run-a"], "任务A新结果");
  await evaluate('window.deliveryHarness.refresh()'); await visibleContext(panelChat, "任务A新结果");
  held.splice(0).forEach((release) => release()); await sleep(300);
  await visibleContext(panelChat, "任务A新结果");
  // Status notifications preserve the original approval/reply draft.
  await text('textarea[aria-label="回复负责人"]', "任务回复草稿");
  details["run-a"].run.status = "awaiting_approval"; details["run-a"].run.updatedAt = "2026-10-03T10:04:00Z";
  await evaluate('window.deliveryHarness.refresh()'); await wait('!!document.querySelector("textarea[aria-label=退回意见]")');
  assert.equal(await evaluate('document.querySelector("textarea[aria-label=退回意见]").value'), "任务回复草稿");
  details["run-a"].run.status = "waiting_user"; details["run-a"].run.updatedAt = "2026-10-03T10:05:00Z";
  await evaluate('window.deliveryHarness.refresh()'); await wait('!!document.querySelector("textarea[aria-label=回复负责人]")');
  holdReply = true;
  await clickText(".task-board-team-respond", "发送回复");
  for (let n = 0; n < 100 && !held.length; n++) await sleep(25); assert.equal(held.length, 1);
  await text('textarea[aria-label="回复负责人"]', "提交期间的新草稿");
  held.splice(0).forEach((release) => release()); holdReply = false; await sleep(300);
  assert.equal(await evaluate('document.querySelector("textarea[aria-label=回复负责人]").value'), "提交期间的新草稿");
  // A same-timestamp action receipt must invalidate a previously started GET, not just rely on merge dates.
  holdNext = true; await evaluate('window.deliveryHarness.refresh()');
  for (let n = 0; n < 100 && !held.length; n++) await sleep(25); assert.equal(held.length, 1);
  details["run-a"].delivery.headline = "操作回执的新结果";
  appendContext(details["run-a"], "操作回执的新结果");
  await wait(`Array.from(document.querySelectorAll('.task-board-team-respond button')).some(n=>n.textContent.includes('发送回复'))`);
  await clickText(".task-board-team-respond", "发送回复");
  await visibleContext(panelChat, "操作回执的新结果");
  held.splice(0).forEach((release) => release()); await sleep(300);
  await visibleContext(panelChat, "操作回执的新结果");
  holdNext = true; await evaluate('window.deliveryHarness.refresh()');
  for (let n = 0; n < 100 && !held.length; n++) await sleep(25); assert.equal(held.length, 1);
  await evaluate('window.deliveryHarness.setTaskId("task-b")'); await visibleContext(panelChat, "任务B结果");
  held.splice(0).forEach((release) => release()); await sleep(300);
  await visibleContext(panelChat, "任务B结果");
  // Old action acknowledgement must not inject the other task after switching scope.
  await evaluate('window.deliveryHarness.setTaskId("task-a")'); await wait('!!document.querySelector("textarea[aria-label=回复负责人]")');
  await text('textarea[aria-label="回复负责人"]', "旧任务回复"); holdReply = true;
  await clickText(".task-board-team-respond", "发送回复");
  for (let n = 0; n < 100 && !held.length; n++) await sleep(25); assert.equal(held.length, 1);
  await evaluate('window.deliveryHarness.setTaskId("task-b")'); await visibleContext(panelChat, "任务B结果");
  held.splice(0).forEach((release) => release()); holdReply = false; await sleep(300);
  await visibleContext(panelChat, "任务B结果");
  // The team's run-history host is another consumer of the same delivery; its old GETs are scoped too.
  await send("Page.navigate", { url: origin + "/?runs=1" });
  await wait('!!document.querySelector("#runs .wand-team-run-head")');
  await click("#runs .wand-team-run-head");
  await visibleContext(runsChat, "操作回执的新结果");
  holdNext = true; await evaluate('window.deliveryHarness.refresh()');
  for (let n = 0; n < 100 && !held.length; n++) await sleep(25); assert.equal(held.length, 1);
  details["run-a"].run.updatedAt = "2026-10-03T10:06:00Z";
  details["run-a"].delivery.headline = "运行记录的新交付";
  appendContext(details["run-a"], "运行记录的新交付");
  await evaluate('window.deliveryHarness.refresh()');
  await visibleContext(runsChat, "运行记录的新交付");
  held.splice(0).forEach((release) => release()); await sleep(300);
  await visibleContext(runsChat, "运行记录的新交付");
  holdNext = true; await evaluate('window.deliveryHarness.refresh()');
  for (let n = 0; n < 100 && !held.length; n++) await sleep(25); assert.equal(held.length, 1);
  await click("#runs .wand-team-run-head");
  held.splice(0).forEach((release) => release()); await sleep(300);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(runsChat)})`), null);
  await click("#runs .wand-team-run-head");
  await visibleContext(runsChat, "运行记录的新交付");
  const executionModes = [];
  for (const mode of ["desktop", "390px", "reduce-motion"]) {
    await send("Emulation.setDeviceMetricsOverride", { width: mode === "390px" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduce-motion" ? "reduce" : "no-preference" }] });
    await send("Page.navigate", { url: origin + `/?execution=1&mode=${mode}` });
    await wait('!!document.querySelector("#execution .ant-tabs-tab")');
    await click('#execution .ant-tabs-tab[data-node-key="timeline"]');
    const timeline = '#execution .task-board-team-view[data-view="timeline"]';
    await wait('!!document.querySelector("#execution .ant-timeline")');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(timeline)}).closest('[role=tabpanel]').getAttribute('aria-hidden')`), "false");
    await click(timeline + ' .task-board-team-step-head');
    await text(timeline + ' textarea[aria-label="手动完成的报告"]', '视图切换保留的手动报告');
    await evaluate(`(()=>{window.__timelineDraftNode=document.querySelector(${JSON.stringify(timeline)}+' textarea');return true})()`);
    await click('#execution .ant-tabs-tab[data-node-key="members"]');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(timeline)}).hasAttribute('inert')`), true);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(timeline)}).closest('[role=tabpanel]')).display`), "none", "hidden library panel does not reserve height");
    await click('#execution .ant-tabs-tab[data-node-key="timeline"]');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(timeline)}+' textarea')===window.__timelineDraftNode`), true, "forceRender retains the original editor node");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(timeline)}+' textarea').value`), '视图切换保留的手动报告');
    await click(timeline + ' .task-board-team-step-skip-head');
    await wait(`document.querySelector(${JSON.stringify(timeline)}+' .task-board-team-step-skip-head').getAttribute('aria-expanded')==='true'`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(timeline)}+' .task-board-team-step-skip-body').hasAttribute('inert')`), false);
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(timeline)}+' .ant-list').textContent.includes('合成候选不可用')`));
    await escape();
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(timeline)}+' .task-board-team-step-skip-head').getAttribute('aria-expanded')`), "false");
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(timeline)}+' .task-board-team-step-skip-head')`), true);
    await click(timeline + ' .task-board-team-step-head');
    await click(timeline + ' .task-board-team-step-head');
    await escape();
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(timeline)}+' .task-board-team-step-head').getAttribute('aria-expanded')`), "false");
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(timeline)}+' .task-board-team-step-head')`), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${mode}: execution pane has no horizontal overflow`);
    executionModes.push({ mode, timeline: true, editorNodePreserved: true, draftPreserved: true, hiddenPaneInert: true, skippedList: true, escapeFocus: true, noOverflow: true });
  }
  assert.equal(knowledgeReads, 0); assert.equal(errors, 0);
  console.log(JSON.stringify({ ok: true, fixture: "synthetic, not live acceptance", results, executionModes,
    runHistoryOldGetProtected: true, runHistoryClosedScopeProtected: true,
    canonicalContextVisible: true, relayActivityLoaded: calls.some(url=>url.startsWith("/api/sessions/relay-a?")),
    taskRequestGeneration: true, actionReceiptInvalidatesOldGet: true, taskSwitchProtected: true, oldActionProtected: true, replyRevisionProtected: true,
    statusDraftPreserved: true, filesRead, knowledgeReads, errors }));
} finally {
  held.splice(0).forEach((release) => release()); socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill("SIGKILL"); await once(chrome, "exit"); }
  server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
