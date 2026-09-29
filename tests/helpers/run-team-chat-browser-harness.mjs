// Static development harness only: exercises the real React TeamChatView + Dialog in headless Chrome.
// Not an installed-service acceptance test and never reads ~/.wand credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "wand-team-chat-browser-"));
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const probe = process.argv.find((value) => value.startsWith("--probe="))?.slice(8) ?? "all";
const bundle = join(dir, "app.js");
const results = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const root = resolve(import.meta.dirname, "../..");
const lastBaseTurn = { role: "user", createdAt: "2026-09-29T10:00:03.000Z",
  content: [{ type: "text", text: `依据 @设计师 阅读报告\n${"报告正文。".repeat(155)}` }] };
let skewedTurn = null;
const uploadRequests = [];
const messageRequests = [];
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
const imagePath = join(dir, "harness-photo.png");
const documentPath = join(dir, "harness-notes.txt");
const rejectedPath = join(dir, "reject.txt");
const unknownPath = join(dir, "unknown.txt");
const failedUploadPath = join(dir, "upload-fail.txt");
writeFileSync(imagePath, imageBytes);
for (const path of [documentPath, rejectedPath, unknownPath, failedUploadPath]) {
  writeFileSync(path, `Browser harness fixture: ${path.split("/").at(-1)}\n`);
}
let acceptedAttachmentTurn = null;
await build({ entryPoints: [join(import.meta.dirname, "team-chat-browser-harness.tsx")],
  bundle: true, platform: "browser", format: "iife", outfile: bundle, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer(async (req, res) => {
  if (req.url === "/api/sessions/chat-1/upload" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const names = [...body.toString("latin1").matchAll(/filename="([^"]+)"/g)]
      .map((match) => match[1]);
    uploadRequests.push({ method: req.method, contentType: req.headers["content-type"],
      names, bytes: body.length, multipartFieldCount: [...body.toString("latin1").matchAll(/name="files"; filename=/g)].length });
    const failed = names.includes("upload-fail.txt");
    res.writeHead(failed ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(failed ? { error: "simulated upload failure" } : { files: names.map((name) => ({
      originalName: name, savedPath: `/tmp/wand-team-chat-harness/.wand-uploads/${name}`,
      size: name === "harness-photo.png" ? imageBytes.length : 40,
      mimeType: name.endsWith(".png") ? "image/png" : "text/plain",
    })) }));
    return;
  }
  if (req.url?.startsWith("/api/file-raw?path=")) {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(imageBytes);
    return;
  }
  if (req.url === "/api/structured-sessions/chat-1/messages") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body).input;
    messageRequests.push({ method: req.method, input });
    const attachmentSuccess = input.includes("附件发送成功");
    const accepted = input === "成功后回填" || input === "时钟偏差" || attachmentSuccess;
    if (input === "时钟偏差") skewedTurn = { role: "user",
      createdAt: new Date(Date.now() - 7 * 60_000).toISOString(),
      content: [{ type: "text", text: input }] };
    if (attachmentSuccess) acceptedAttachmentTurn = { role: "user",
      createdAt: new Date().toISOString(), content: [{ type: "text", text: input }] };
    const status = input.includes("附件明确拒收") ? 422 : accepted ? 200 : 503;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(input === "时钟偏差"
      ? { messages: [lastBaseTurn, skewedTurn] }
      : attachmentSuccess ? { messages: [lastBaseTurn, acceptedAttachmentTurn] }
      : accepted ? { ok: true } : { error: "simulated unknown delivery" }));
    return;
  }
  if (req.url === "/api/ai-team-runs/run-1" && acceptedAttachmentTurn) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      run: { id: "run-1", status: "done", chatSessionId: "chat-1", objective: "群聊验证",
        team: { id: "team", name: "测试团队", members: [] }, stepsUsed: 1, stepLimit: 8 },
      chatTurns: [lastBaseTurn, acceptedAttachmentTurn], steps: [], memberStates: {},
    }));
    return;
  }
  if (req.url === "/api/ai-team-runs/run-1" && skewedTurn) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ chatTurns: [lastBaseTurn, skewedTurn] }));
    return;
  }
  if (req.url === "/api/ai-team-runs/run-1/live") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ runId: "run-1", taskId: "task-1", steps: [] }));
    return;
  }
  const files = {
    "/app.js": [bundle, "text/javascript"],
    "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
    "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"],
  };
  const target = files[req.url];
  if (target) {
    res.setHeader("Content-Type", target[1]);
    res.end(readFileSync(target[0]));
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <link rel="stylesheet" href="/tailwind.css"/><link rel="stylesheet" href="/styles.css"/>
    <style>html,body,#root{height:100%;margin:0}#root{max-width:900px;margin:auto}
    .task-board-team-chat{height:100%;display:flex;flex-direction:column}
    .task-board-team-chat-list{flex:1;min-height:0;overflow:auto}</style></head><body>
    <div id="root"></div><div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals"></div></div>
    <script src="/app.js"></script></body></html>`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const httpPort = server.address().port;
let processHandle;
let socket;
try {
  processHandle = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${dir}/profile`,
    `http://127.0.0.1:${httpPort}/`], { stdio: "ignore" });
  const activePortFile = join(dir, "profile", "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(activePortFile); i++) await sleep(100);
  assert.ok(existsSync(activePortFile), "Chrome CDP must start");
  const cdpPort = readFileSync(activePortFile, "utf8").split("\n")[0];
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    const tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    page = tabs.find((tab) => tab.type === "page" && tab.url.startsWith(`http://127.0.0.1:${httpPort}/`));
    if (!page) await sleep(100);
  }
  assert.ok(page, "Chrome harness tab must be available");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const { resolvePending, rejectPending } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectPending(new Error(JSON.stringify(message.error)));
    else resolvePending(message.result);
  });
  const send = (method, params = {}) => new Promise((resolvePending, rejectPending) => {
    const next = ++id;
    pending.set(next, { resolvePending, rejectPending });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let i = 0; i < 60; i++) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`waitFor failed: ${expression}`);
  };
  const read = (expression) => evaluate(expression);
  const action = async (expression) => { await evaluate(expression); await sleep(30); };
  await send("Runtime.enable");
  await waitFor("Boolean(window.teamHarness && document.querySelectorAll('.team-chat-msg').length === 3)");
  const initial = await read(`(() => {
    const rows=[...document.querySelectorAll('.team-chat-msg')];
    return { previews:rows.map(r=>r.querySelector('.team-chat-preview')?.textContent?.length),
      mentions:rows.map(r=>r.querySelectorAll('.team-chat-mention').length),
      animation:rows.map(r=>getComputedStyle(r).animationName),
      ids:rows.map(r=>r.dataset.presentationId), longName:rows[1].querySelector('.team-chat-mention')?.textContent,
      inlineMax:getComputedStyle(rows[1].querySelector('.team-chat-mention')).maxWidth };
  })()`);
  assert.deepEqual(initial.mentions, [1, 1, 0]);
  assert.equal(await read("document.querySelectorAll('.chat-notice .team-chat-mention').length"), 1,
    "real notice branch highlights invitation without adding an avatar");
  assert.equal(await read("document.querySelectorAll('.chat-notice .team-chat-avatar').length"), 0);
  assert.deepEqual(initial.animation, ["none", "none", "none"]);
  assert.ok(initial.longName.length > 24 && initial.previews[1] === 421);
  results.push({ check: "initial/static/mention", ...initial });

  await action(`document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand').scrollIntoView({block:'center'})`);
  const point = await read(`(() => {const r=document.querySelectorAll('.team-chat-msg')[1]
    .querySelector('.team-chat-expand').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
  await waitFor("document.activeElement?.className === 'team-chat-doc-layer-text'");
  const opened = await read(`(() => {
    const panel=document.querySelector('[data-testid=team-chat-doc-dialog]');
    const trigger=document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand');
    const mention=panel.querySelector('.team-chat-mention');
    return { length:panel.querySelector('.team-chat-doc-layer-text').textContent.length,
      mentionLength:mention.textContent.length, mentionMax:getComputedStyle(mention).maxWidth,
      focus:document.activeElement?.className, rect:trigger.getBoundingClientRect().toJSON(),
      scroll:document.querySelector('.task-board-team-chat-list').scrollTop,
      direction:panel.className };
  })()`);
  assert.ok(opened.length > initial.previews[1]);
  assert.equal(opened.mentionMax, "100%");
  assert.equal(opened.focus, "team-chat-doc-layer-text");
  const beforeClose = await read(`(() => {const trigger=document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand');
    return { rect:trigger.getBoundingClientRect().toJSON(), scroll:document.querySelector('.task-board-team-chat-list').scrollTop };})()`);
  await action(`document.querySelector('[data-testid=team-chat-doc-dialog] [aria-label=关闭]').click()`);
  const closing = await read(`(() => {const panel=document.querySelector('[data-testid=team-chat-doc-dialog]');
    return { exists:!!panel, length:panel?.querySelector('.team-chat-doc-layer-text')?.textContent?.length,
      ending:panel?.hasAttribute('data-ending-style') };})()`);
  assert.ok(closing.exists && closing.length === opened.length, "outgoing payload retained");
  await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
  const restored = await read(`(() => {const trigger=document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand');
    return {focus:document.activeElement===trigger, rect:trigger.getBoundingClientRect().toJSON(),
      scroll:document.querySelector('.task-board-team-chat-list').scrollTop};})()`);
  assert.equal(restored.focus, true);
  assert.deepEqual(restored.rect, opened.rect, "opening/closing alone must not displace the trigger");
  assert.equal(restored.scroll, opened.scroll, "opening/closing alone must not scroll the list");
  results.push({ check: "dialog/button/payload/focus/geometry", opened, beforeClose, closing, restored });

  await action(`document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand').click()`);
  await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
  await action(`window.teamHarness.roster()`);
  assert.equal(await read("document.querySelectorAll('.team-chat-doc-layer .team-chat-mention').length"), 1, "snapshot roster retained");
  await action(`document.querySelector('[data-testid=team-chat-doc-dialog] [aria-label=关闭]').click()`);
  await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
  results.push({ check: "dialog/roster-snapshot", ok: true });

  await action(`document.querySelectorAll('.team-chat-msg')[2].querySelector('.team-chat-expand').click()`);
  await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
  assert.equal(await read("document.querySelectorAll('.team-chat-doc-layer .team-chat-mention').length"), 0, "own doc never highlights mention");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
  results.push({ check: "dialog/own-source/Escape", ok: true });

  await action(`document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand').click()`);
  await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
  await sleep(550); // shared Dialog's outside-press grace period; test driver only, not UI animation.
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
  await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
  results.push({ check: "dialog/backdrop", ok: true });

  await action(`document.querySelector('.task-board-team-chat-list').scrollTop=100000;
    document.querySelector('.task-board-team-chat-list').dispatchEvent(new Event('scroll',{bubbles:true}))`);
  await action(`window.teamHarness.append('新的尾部消息', 4)`);
  const arrival = await read(`(() => {const row=[...document.querySelectorAll('.team-chat-msg')].at(-1);
    return {name:getComputedStyle(row).animationName, height:row.getBoundingClientRect().height,
      arriving:row.hasAttribute('data-arriving')};})()`);
  assert.equal(arrival.name, "wand-team-msg-in");
  assert.ok(arrival.height > 0 && arrival.arriving, "row already occupies its full height");
  await waitFor("![...document.querySelectorAll('.team-chat-msg')].at(-1).hasAttribute('data-arriving')");
  await action(`window.teamHarness.repeat()`);
  assert.equal(await read("getComputedStyle([...document.querySelectorAll('.team-chat-msg')].at(-1)).animationName"), "none");
  await action(`document.querySelector('.task-board-team-chat-list').scrollTop=0;
    document.querySelector('.task-board-team-chat-list').dispatchEvent(new Event('scroll',{bubbles:true}))`);
  await action(`window.teamHarness.append('上滚时的新消息', 5)`);
  assert.equal(await read("getComputedStyle([...document.querySelectorAll('.team-chat-msg')].at(-1)).animationName"), "none");
  await action(`document.querySelector('.task-board-team-chat-list').scrollTop=100000;
    document.querySelector('.task-board-team-chat-list').dispatchEvent(new Event('scroll',{bubbles:true}))`);
  assert.equal(await read("getComputedStyle([...document.querySelectorAll('.team-chat-msg')].at(-1)).animationName"), "none");
  results.push({ check: "arrival/foreground-tail-once/upscroll-no-replay", arrival });

  // Native shell has no global reduce-motion fallback: local feature rules must still snap.
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await action(`document.documentElement.classList.add('is-wand-app')`);
  await action(`window.teamHarness.append('新消息在底部', 6)`);
  await waitFor("document.querySelectorAll('.team-chat-msg').length === 6");
  const reduced = await read(`(() => {const row=document.querySelectorAll('.team-chat-msg')[5];
    return { animation:getComputedStyle(row).animationName, translate:getComputedStyle(row).translate,
      opacity:getComputedStyle(row).opacity, arriving:row.hasAttribute('data-arriving') };})()`);
  assert.equal(reduced.animation, "none");
  assert.equal(reduced.arriving, false);
  results.push({ check: "native-shell/reduced-motion", ...reduced });

  await action(`document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand').click()`);
  await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
  const reducedPopup = await read(`(() => {const panel=document.querySelector('[data-testid=team-chat-doc-dialog]');
    const backdrop=document.querySelector('[data-slot=dialog-backdrop]');
    return { popupAnimation:getComputedStyle(panel).animationDuration,
      popupTransition:getComputedStyle(panel).transitionDuration,
      backdropTransition:getComputedStyle(backdrop).transitionDuration };})()`);
  assert.ok(parseFloat(reducedPopup.popupAnimation) < 0.001 && parseFloat(reducedPopup.popupTransition) < 0.001,
    "native shell overlay motion must be nearly instantaneous, while still completing exit");
  results.push({ check: "native-shell/reduced-dialog-overlay", ...reducedPopup });
  await action(`window.teamHarness.remove(2)`);
  await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
  assert.equal(await read("document.activeElement?.className"), "task-board-team-chat-list", "removed owner focuses visible list anchor");
  results.push({ check: "owner-removed/reduced/anchor", ok: true });
  await action(`document.querySelectorAll('.team-chat-msg')[1].querySelector('.team-chat-expand').click()`);
  await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
  await action(`window.teamHarness.switchRun()`);
  await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
  assert.equal(await read("document.activeElement?.className"), "task-board-team-chat-list", "old scope does not focus a same-numbered new row");
  results.push({ check: "run-switch/owner-invalid/anchor", ok: true });

  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await action(`window.teamHarness.repeat()`);
  assert.ok(await read("[...document.querySelectorAll('[data-presentation-id]')].every(n=>getComputedStyle(n).animationName==='none')"),
    "identical reload cannot reanimate history");
  assert.ok(await read("[...document.querySelectorAll('[data-presentation-id]')].every(n=>getComputedStyle(n).animationName==='none')"),
    "scope change loads static history");
  results.push({ check: "repeat/scope-static", ok: true });

  let freshCount = 0;
  async function fresh() {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    // Each scenario starts with an empty composer; continuity within a scenario is tested without navigating.
    await evaluate("localStorage.removeItem('wand-draft-chat-1')");
    const marker = ++freshCount;
    await send("Page.navigate", { url: `http://127.0.0.1:${httpPort}/?harness=${marker}` });
    await waitFor(`location.search === '?harness=${marker}' && Boolean(window.teamHarness)
      && document.querySelectorAll('.team-chat-msg').length === 3`);
  }
  const wants = (name) => probe === "all" || probe === name;
  const setReduced = async (native) => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await action(`document.documentElement.classList.toggle('is-wand-app', ${native})`);
  };
  if (wants("continuity")) {
    await fresh();
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "尚未确认的群聊消息" });
    await waitFor("document.querySelector('textarea[aria-label=\"群聊消息\"]').value === '尚未确认的群聊消息'");
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor("Boolean(document.querySelector('.wand-team-chat-unconfirmed'))");
    await action(`(() => {const field=document.querySelector('textarea[aria-label="群聊消息"]');
      field.focus();field.setSelectionRange(0,field.value.length);})()`);
    await send("Input.insertText", { text: "下一轮继续编辑的草稿" });
    await waitFor("document.querySelector('textarea[aria-label=\"群聊消息\"]').value === '下一轮继续编辑的草稿'");
    await action(`document.querySelector('.task-board-team-chat-list').scrollTop=0;
      document.querySelector('.task-board-team-chat-list').dispatchEvent(new Event('scroll',{bubbles:true}))`);
    const before = await read(`(() => ({
      ids:[...document.querySelectorAll('.team-chat-msg[data-presentation-id]')].map(n=>n.dataset.presentationId),
      scroll:document.querySelector('.task-board-team-chat-list').scrollTop,
      draft:document.querySelector('textarea[aria-label="群聊消息"]').value,
      local:document.querySelectorAll('.wand-team-chat-unconfirmed').length
    }))()`);
    await action("window.teamHarness.switchRunSameChat()");
    await waitFor("document.querySelector('.team-chat-context-title')?.textContent === '接续第二轮'");
    const after = await read(`(() => ({
      ids:[...document.querySelectorAll('.team-chat-msg[data-presentation-id]')].map(n=>n.dataset.presentationId),
      scroll:document.querySelector('.task-board-team-chat-list').scrollTop,
      draft:document.querySelector('textarea[aria-label="群聊消息"]').value,
      local:document.querySelectorAll('.wand-team-chat-unconfirmed').length
    }))()`);
    assert.deepEqual(after, before, "same relay run switch must retain draft, unknown row, handles, and scroll");
    results.push({ check: "same-chat-run/draft-local-handles-scroll", before, after });

    await fresh();
    await action("window.teamHarness.holdOldDetail()");
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "成功后回填" });
    await waitFor("document.querySelector('textarea[aria-label=\"群聊消息\"]').value === '成功后回填'");
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor("window.teamHarness.oldDetailHeld()");
    await action("window.teamHarness.switchRunSameChat()");
    await waitFor("document.querySelector('.team-chat-context-title')?.textContent === '接续第二轮'");
    await action("window.teamHarness.releaseOldDetail()");
    await waitFor("document.querySelector('.team-chat-compose-main .btn-circle-send')?.dataset.phase !== 'sending'");
    assert.equal(await read("document.querySelector('.team-chat-context-title')?.textContent"), "接续第二轮",
      "late old-run GET must not send onChange(old run)");
    results.push({ check: "same-chat-run/late-send-detail-ignored", ok: true });

    await fresh();
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "草稿可继续写" });
    await action("window.teamHarness.setStaleRun(true)");
    assert.equal(await read("document.querySelector('textarea[aria-label=\"群聊消息\"]').value"), "草稿可继续写");
    assert.equal(await read("document.querySelector('.task-board-team-chat-hint')?.textContent"),
      "正在接入新一轮，加载完成后可发送");
    assert.equal(await read("document.querySelector('.team-chat-compose-main .btn-circle-send')?.disabled"), true);
    await send("Input.insertText", { text: "，不会丢" });
    await waitFor("document.querySelector('textarea[aria-label=\"群聊消息\"]').value === '草稿可继续写，不会丢'");
    await action("window.teamHarness.setStaleRun(false)");
    assert.equal(await read("document.querySelector('.team-chat-compose-main .btn-circle-send')?.disabled"), false);
    results.push({ check: "stale-run/editable-draft-disabled-actions", ok: true });

    await fresh();
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "时钟偏差" });
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor(`(() => [...document.querySelectorAll('.team-chat-msg[data-presentation-id]')]
      .some(n=>n.textContent.includes('时钟偏差'))
      && document.querySelectorAll('.team-chat-msg:not([data-presentation-id])').length===0)()`);
    results.push({ check: "ack-server-time/skewed-user-echo-settles", ok: true });

    await fresh();
    await action("window.teamHarness.holdOldDetail()");
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "成功后回填" });
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor("window.teamHarness.oldDetailHeld()");
    await action("window.teamHarness.append('WS 已到的新尾', 8)");
    await waitFor("[...document.querySelectorAll('.team-chat-msg[data-presentation-id]')].some(n=>n.textContent.includes('WS 已到的新尾'))");
    await action("window.teamHarness.releaseOldDetail()");
    await sleep(100);
    assert.equal(await read("[...document.querySelectorAll('.team-chat-msg[data-presentation-id]')].some(n=>n.textContent.includes('WS 已到的新尾'))"), true,
      "same-run stale GET must not replace a later WS tail");
    results.push({ check: "same-run/stale-get-keeps-ws-tail", ok: true });

    await fresh();
    await action("window.teamHarness.holdOldDetail()");
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "成功后回填" });
    await waitFor("document.querySelector('textarea[aria-label=\"群聊消息\"]').value === '成功后回填'");
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor("window.teamHarness.oldDetailHeld()");
    await action("window.teamHarness.switchRun()");
    await waitFor("window.teamHarness.currentRun() === 'run-2'");
    await action("window.teamHarness.switchBack()");
    await waitFor("window.teamHarness.currentRun() === 'run-1'");
    await action("window.teamHarness.releaseOldDetail()");
    await sleep(100);
    assert.equal(await read("document.querySelectorAll('.team-chat-msg:not([data-presentation-id])').length"), 0,
      "A→B→A must not resurrect an old optimistic row after ownership changed twice");
    results.push({ check: "chat-owner-epoch/late-result-ignored", ok: true });

    await fresh();
    await action("window.teamHarness.holdPosts()");
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "第一条旧请求" });
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor("window.teamHarness.heldPostCount() === 1");
    await action("window.teamHarness.switchRun()");
    await waitFor("window.teamHarness.currentRun() === 'run-2'");
    await action("window.teamHarness.switchBack()");
    await waitFor("window.teamHarness.currentRun() === 'run-1'");
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "第二条新请求" });
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor("window.teamHarness.heldPostCount() === 2");
    await action("window.teamHarness.releasePost(0)");
    await sleep(100);
    assert.equal(await read("document.querySelector('.team-chat-compose-main .btn-circle-send')?.dataset.phase === 'sending'"), true,
      "old A response must not clear new A pending lock after A→B→A");
    await action("window.teamHarness.releasePost(1)");
    await waitFor("document.querySelector('.team-chat-compose-main .btn-circle-send')?.dataset.phase !== 'sending'");
    results.push({ check: "chat-owner-epoch/old-response-keeps-new-send-lock", ok: true });
  }
  if (wants("live")) {
    for (const native of [false, true]) {
      await fresh();
      await setReduced(native);
      await action("window.teamHarness.startLive()");
      await sleep(100); // Let the real live repository GET resolve and subscribe, not an animation queue.
      await action("window.teamHarness.pushLive(true)");
      await waitFor("Boolean(document.querySelector('.team-chat-live-head'))");
      const head = await read(`(() => {const node=document.querySelector('.team-chat-live-head');const s=getComputedStyle(node);
        return {duration:s.animationDuration,transform:s.transform,name:s.animationName};})()`);
      assert.ok(parseFloat(head.duration) < 0.001, `reduce live head must snap in ${native ? "native" : "browser"} shell: ${JSON.stringify(head)}`);
      assert.equal(head.transform, "none", "reduced live head must not translate");
      await action(`window.__leaving=[];new MutationObserver(()=>{const node=document.querySelector('.team-chat-live-row[data-leaving]');
        if(node){const s=getComputedStyle(node);window.__leaving.push({duration:s.animationDuration,transform:s.transform});}
      }).observe(document.querySelector('.task-board-team-chat-list'),{attributes:true,subtree:true,childList:true});`);
      await action("window.teamHarness.pushLive(false)");
      await waitFor("!document.querySelector('.team-chat-live-row')");
      const leaving = await read("window.__leaving");
      assert.ok(leaving.length > 0, "real live row must enter leaving before retirement");
      assert.ok(leaving.every((item) => item.transform === "none" && parseFloat(item.duration) < 0.001),
        `reduced leaving must not translate: ${JSON.stringify(leaving)}`);
      results.push({ check: `live/reduce/${native ? "native" : "browser"}`, head, leaving, retired: true });
    }
    // Switching reduce mid-flight must drop displacement and still retire the same live row.
    await fresh();
    await action("window.teamHarness.startLive()");
    await sleep(100);
    await action("window.teamHarness.pushLive(true)");
    await waitFor("Boolean(document.querySelector('.team-chat-live-row'))");
    await action("window.teamHarness.pushLive(false)");
    await waitFor("Boolean(document.querySelector('.team-chat-live-row[data-leaving]'))");
    await setReduced(true);
    const switched = await read(`(() => {const row=document.querySelector('.team-chat-live-row');
      return row ? getComputedStyle(row).transform : 'removed';})()`);
    assert.ok(switched === "none" || switched === "removed",
      "in-flight leaving must snap or already be retired when reduce toggles on");
    await waitFor("!document.querySelector('.team-chat-live-row')");
    results.push({ check: "live/reduce-switched-while-leaving", retired: true });
    await fresh();
    await action("window.teamHarness.startLive()");
    await sleep(100);
    await action("window.teamHarness.pushLive(true)");
    await waitFor("Boolean(document.querySelector('.team-chat-live-row'))");
    await action("window.teamHarness.pushLive(false)");
    await action(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
      document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor("!document.querySelector('.team-chat-live-row')");
    results.push({ check: "live/hidden-retirement", retired: true });
  }
  if (wants("focus")) {
    await fresh();
    const draft = "本地尚未确认的长消息。".repeat(65);
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: draft });
    await waitFor(`document.querySelector('textarea[aria-label="群聊消息"]').value.length > 420`);
    await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    await waitFor("Boolean(document.querySelector('.wand-team-chat-unconfirmed'))");
    const localRow = ".wand-team-chat-unconfirmed";
    const triggerExpr = `document.querySelector('${localRow}').closest('.team-chat-msg').querySelector('.team-chat-expand')`;
    await action(`${triggerExpr}.scrollIntoView({block:'center'})`);
    const before = await read(`(() => {const r=${triggerExpr}.getBoundingClientRect();return {
      rect:r.toJSON(),scroll:document.querySelector('.task-board-team-chat-list').scrollTop};})()`);
    const close = async (method) => {
      await action(`${triggerExpr}.click()`);
      await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
      if (method === "button") await action(`document.querySelector('[data-testid=team-chat-doc-dialog] [aria-label=关闭]').click()`);
      else if (method === "escape") {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      } else {
        await sleep(550); // Existing shared backdrop mis-click guard; driver only.
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
      }
      await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
      const after = await read(`(() => {const target=${triggerExpr};return {
        exists:!!target,connected:target?.isConnected,focused:document.activeElement===target,
        rect:target?.getBoundingClientRect().toJSON(),scroll:document.querySelector('.task-board-team-chat-list').scrollTop};})()`);
      assert.ok(after.exists && after.connected && after.focused, `local ${method}: restore connected owner, got ${JSON.stringify(after)}`);
      assert.deepEqual(after.rect, before.rect, `local ${method}: trigger geometry`);
      assert.equal(after.scroll, before.scroll, `local ${method}: scrollTop unchanged`);
      results.push({ check: `local-unknown/${method}`, ...after });
    };
    for (const method of ["button", "escape", "backdrop"]) await close(method);
    await setReduced(true);
    await close("button");
    // Losing the local owner during its exit must focus the visible list, not a detached trigger.
    await action(`${triggerExpr}.click()`);
    await waitFor("Boolean(document.querySelector('[data-testid=team-chat-doc-dialog][data-open]'))");
    await action(`document.querySelector('[data-testid=team-chat-doc-dialog] [aria-label=关闭]').click();
      window.teamHarness.switchRun()`);
    await waitFor("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
    assert.equal(await read("document.activeElement?.className"), "task-board-team-chat-list");
    results.push({ check: "local-unknown/owner-lost-during-exit", fallback: true });
  }
  if (wants("background")) {
    for (const reason of ["visibilitychange", "pagehide", "reduce"]) {
      await fresh();
      await action(`document.querySelector('.task-board-team-chat-list').scrollTop=100000;
        document.querySelector('.task-board-team-chat-list').dispatchEvent(new Event('scroll',{bubbles:true}))`);
      await action("window.teamHarness.append('真实新增尾项', 8)");
      await waitFor("Boolean([...document.querySelectorAll('[data-presentation-id]')].at(-1)?.hasAttribute('data-arriving'))");
      if (reason === "visibilitychange") {
        await action(`document.documentElement.style.setProperty('--motion-quick-exit','invalid');
          Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
          document.dispatchEvent(new Event('visibilitychange'))`);
      } else if (reason === "pagehide") await action("window.dispatchEvent(new Event('pagehide'))");
      else {
        await action(`window.__motionCount=0;matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>window.__motionCount++)`);
        await setReduced(true);
        await waitFor("window.__motionCount > 0");
        await waitFor("![...document.querySelectorAll('[data-presentation-id]')].at(-1).hasAttribute('data-arriving')");
      }
      const arriving = await read("[...document.querySelectorAll('[data-presentation-id]')].at(-1).hasAttribute('data-arriving')");
      assert.equal(arriving, false, `${reason}: consume current arrival now, not after animationend`);
      await action(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
        document.dispatchEvent(new Event('visibilitychange'))`);
      if (reason === "reduce") await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      assert.equal(await read("[...document.querySelectorAll('[data-presentation-id]')].at(-1).hasAttribute('data-arriving')"), false,
        `${reason}: coming back cannot replay`);
      results.push({ check: `arrival/${reason}-consumed`, stable: true });
    }
    await fresh();
    await action(`document.querySelector('.task-board-team-chat-list').scrollTop=100000;
      document.querySelector('.task-board-team-chat-list').dispatchEvent(new Event('scroll',{bubbles:true}));
      window.teamHarness.append('卸载前的一次入场',8)`);
    await waitFor("Boolean([...document.querySelectorAll('[data-presentation-id]')].at(-1)?.hasAttribute('data-arriving'))");
    await action("window.unmountTeamHarness()");
    assert.equal(await read("document.querySelector('.task-board-team-chat')"), null, "unmount releases in-flight row");
    await fresh();
    assert.ok(await read("[...document.querySelectorAll('[data-presentation-id]')].every(n=>!n.hasAttribute('data-arriving'))"),
      "remount starts as static history, not a delayed arrival");
    results.push({ check: "arrival/unmount-static-remount", stable: true });
  }
  if (wants("selector")) {
    for (const native of [false, true]) for (const rollback of [false, true]) for (const width of [390, 900]) {
      await fresh();
      await send("Emulation.setDeviceMetricsOverride", { width, height: 780, deviceScaleFactor: 1, mobile: width === 390 });
      await action(`document.documentElement.classList.toggle('is-wand-app', ${native});
        history.replaceState(null,'',${JSON.stringify(rollback ? "?reactUi=0" : "/")});
        document.querySelector('.team-chat-context').click(); window.teamHarness.addPlan()`);
      await waitFor("Boolean(document.querySelector('.team-chat-plan-list .team-chat-mention'))");
      await action(`document.querySelector('.team-chat-msg[data-shape="document"] .team-chat-expand')?.click()`);
      await action("window.teamHarness.startLive()");
      await sleep(100);
      await action("window.teamHarness.pushLive(true)");
      await waitFor("Boolean(document.querySelector('.team-chat-live-row'))");
      await action("document.querySelector('.team-chat-live-summary').click()");
      const old = await read("document.querySelectorAll('.team-chat-plan-member').length");
      assert.equal(old, 0, `dead selector in native=${native} rollback=${rollback} width=${width}`);
      results.push({ check: `selector/native=${native}/rollback=${rollback}/width=${width}`, old, plan: true });
    }
    await send("Emulation.clearDeviceMetricsOverride");
  }
  if (wants("attachments")) {
    await fresh();
    await send("Page.enable");
    await send("DOM.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    const evidenceDir = join(root, "output/team-chat-v2-resume");
    mkdirSync(evidenceDir, { recursive: true });
    const screenshot = async (name) => {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const path = join(evidenceDir, name);
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    };
    await action(`document.querySelector('.task-board-team-chat-list').scrollTop=0;
      window.__pickerCalls=[];
      for(const input of document.querySelectorAll('input[type=file]')){
        input.click=function(){window.__pickerCalls.push(this.getAttribute('aria-label'));};
      }
      document.querySelector('.composer-attach-trigger').click();`);
    await waitFor("document.querySelector('.composer-attach-trigger')?.getAttribute('aria-expanded') === 'true'");
    await sleep(250); // Measure the final anchored position after the shared popover transition.
    const menu = await read(`(() => {
      const trigger=document.querySelector('.composer-attach-trigger').getBoundingClientRect();
      const popup=document.querySelector('.task-board-team-chat-input .composer-plus-popover').getBoundingClientRect();
      const input=document.querySelector('.task-board-team-chat-input').getBoundingClientRect();
      const row=document.querySelector('.task-board-team-chat-input .input-composer-row').getBoundingClientRect();
      const composer=document.querySelector('.task-board-team-chat-input .input-composer').getBoundingClientRect();
      return { trigger:trigger.toJSON(), popup:popup.toJSON(),
        input:input.toJSON(), row:row.toJSON(), composer:composer.toJSON(),
        gap:trigger.top-popup.bottom,
        labels:[...document.querySelectorAll('.task-board-team-chat-input .plus-popover-item')]
          .map(node=>node.textContent.trim()) };
    })()`);
    const menuScreenshot = await screenshot("attachment-chat-390-menu.png");
    assert.deepEqual(menu.labels, ["上传图片", "上传附件"]);
    assert.ok(menu.gap >= 5 && menu.popup.top >= 0,
      `attachment menu stays attached above the + trigger: ${JSON.stringify(menu)}`);
    assert.ok(menu.popup.right <= 391, `attachment menu fits 390px viewport: ${JSON.stringify(menu)}`);
    await action(`document.querySelector('.task-board-team-chat-input .plus-popover-item').click()`);
    await action(`document.querySelector('.composer-attach-trigger').click()`);
    await waitFor("document.querySelector('.composer-attach-trigger')?.getAttribute('aria-expanded') === 'true'");
    await action(`document.querySelectorAll('.task-board-team-chat-input .plus-popover-item')[1].click()`);
    assert.deepEqual(await read("window.__pickerCalls"), ["选择图片", "选择附件"],
      "both shared + menu actions must invoke their own file picker");
    const viewport = await read(`(() => {
      const list=document.querySelector('.task-board-team-chat-list');
      const input=document.querySelector('.task-board-team-chat-input');
      const row=document.querySelector('.team-chat-msg');
      const notice=document.querySelector('.chat-notice-line');
      const noticeStyle=getComputedStyle(notice);
      const mentionStyle=getComputedStyle(notice.querySelector('.team-chat-mention'));
      const edge=list.getBoundingClientRect().right;
      const overflowing=[...list.querySelectorAll('*')].map(n=>({
        tag:n.tagName.toLowerCase(), className:String(n.className).slice(0,120),
        text:n.textContent?.slice(0,40), right:n.getBoundingClientRect().right,
        width:n.getBoundingClientRect().width,
      })).filter(n=>n.right>edge+1).sort((a,b)=>b.right-a.right).slice(0,8);
      return { width:innerWidth, scrollWidth:document.documentElement.scrollWidth,
        listClientWidth:list.clientWidth, listScrollWidth:list.scrollWidth,
        overflowing,
        list:list.getBoundingClientRect().toJSON(), input:input.getBoundingClientRect().toJSON(),
        row:row.getBoundingClientRect().toJSON(),
        notice:{height:notice.getBoundingClientRect().height,
          lineHeight:Number.parseFloat(noticeStyle.lineHeight),
          whiteSpace:noticeStyle.whiteSpace, background:noticeStyle.backgroundColor,
          borderWidth:noticeStyle.borderTopWidth, shadow:noticeStyle.boxShadow,
          timeCount:notice.querySelectorAll('.chat-notice-time').length,
          mentionBackground:mentionStyle.backgroundColor},
        centeredTimeLabels:document.querySelectorAll('.team-chat-time-marker').length,
        messageClocks:document.querySelectorAll('.team-chat-msg .chat-message-time').length,
        composerClass:document.querySelector('.task-board-team-chat-input .input-composer')?.className,
        attachmentListClass:document.querySelector('.task-board-team-chat-input .attachment-preview')?.className };
    })()`);
    assert.equal(viewport.width, 390, "mobile CSS viewport must be 390px");
    assert.ok(viewport.scrollWidth <= viewport.width + 1,
      `mobile chat must not overflow horizontally: ${JSON.stringify(viewport)}`);
    assert.equal(viewport.notice.whiteSpace, "nowrap", "system notice stays on one line");
    assert.ok(viewport.notice.height <= viewport.notice.lineHeight + 1,
      "system notice has only one text line");
    assert.equal(viewport.notice.background, "rgba(0, 0, 0, 0)");
    assert.equal(viewport.notice.mentionBackground, "rgba(0, 0, 0, 0)");
    assert.equal(viewport.notice.borderWidth, "0px");
    assert.equal(viewport.notice.shadow, "none");
    assert.equal(viewport.notice.timeCount, 0, "time is carried by the separate timeline marker");
    const initialScreenshot = await screenshot("attachment-chat-390-before.png");
    results.push({ check: "attachments/390-layout-before", viewport, menu,
      menuScreenshot, screenshot: initialScreenshot });

    const chooseFile = async (selector, file, count) => {
      const { root: documentNode } = await send("DOM.getDocument");
      const { nodeId } = await send("DOM.querySelector", { nodeId: documentNode.nodeId, selector });
      assert.ok(nodeId, `file input must exist: ${selector}`);
      await send("DOM.setFileInputFiles", { nodeId, files: [file] });
      await waitFor(`document.querySelectorAll('.task-board-team-chat-input .attachment-pill').length === ${count}`);
    };
    const sendDraft = async (text) => {
      await action(`(() => { const field=document.querySelector('textarea[aria-label="群聊消息"]');
        field.focus(); field.setSelectionRange(0, field.value.length); })()`);
      await send("Input.insertText", { text });
      await waitFor(`document.querySelector('textarea[aria-label="群聊消息"]').value === ${JSON.stringify(text)}`);
      await action(`document.querySelector('.team-chat-compose-main .btn-circle-send').click()`);
    };

    await chooseFile('input[aria-label="选择图片"]', imagePath, 1);
    await chooseFile('input[aria-label="选择附件"]', documentPath, 2);
    const pendingFiles = await read(`(() => ({
      names:[...document.querySelectorAll('.task-board-team-chat-input .attachment-pill .att-name')]
        .map(n=>n.textContent),
      preview:document.querySelector('.task-board-team-chat-input .attachment-pill img')?.getAttribute('src'),
      sendDisabled:document.querySelector('.team-chat-compose-main .btn-circle-send')?.disabled,
    }))()`);
    assert.deepEqual(pendingFiles.names, ["harness-photo.png", "harness-notes.txt"]);
    assert.ok(pendingFiles.preview?.startsWith("blob:"), "image chip must show its local thumbnail");
    assert.equal(pendingFiles.sendDisabled, false, "attachments alone enable send");
    await action(`document.querySelector('[aria-label="移除附件 harness-notes.txt"]').click()`);
    await waitFor("document.querySelectorAll('.task-board-team-chat-input .attachment-pill').length === 1");
    await chooseFile('input[aria-label="选择附件"]', documentPath, 2);
    await sendDraft("附件发送成功");
    await waitFor(`document.querySelector('.team-chat-msg[data-presentation-id] .team-chat-attachment[data-image] img')?.naturalWidth === 1
      && [...document.querySelectorAll('.team-chat-msg[data-presentation-id] .team-chat-attachment')]
        .some(n=>n.textContent.includes('harness-notes.txt'))`);
    const success = await read(`(() => ({
      chips:document.querySelectorAll('.task-board-team-chat-input .attachment-pill').length,
      draft:document.querySelector('textarea[aria-label="群聊消息"]').value,
      image:document.querySelector('.team-chat-msg[data-presentation-id] .team-chat-attachment[data-image] img')?.src,
      file:[...document.querySelectorAll('.team-chat-msg[data-presentation-id] .team-chat-attachment')]
        .find(n=>n.textContent.includes('harness-notes.txt'))?.textContent,
      unknown:document.querySelectorAll('.wand-team-chat-unconfirmed').length,
      local:document.querySelectorAll('.team-chat-msg:not([data-presentation-id])').length,
    }))()`);
    assert.equal(success.chips, 0);
    assert.equal(success.draft, "");
    assert.equal(success.unknown, 0);
    assert.equal(success.local, 0, "server echo replaces the optimistic attachment row");
    assert.ok(success.image?.includes("/api/file-raw?path="));
    assert.equal(uploadRequests.at(-1).multipartFieldCount, 2);
    assert.deepEqual(uploadRequests.at(-1).names, ["harness-photo.png", "harness-notes.txt"]);
    assert.ok(uploadRequests.at(-1).contentType.startsWith("multipart/form-data; boundary="));
    const sent = messageRequests.at(-1);
    assert.equal(sent.method, "POST");
    assert.ok(sent.input.startsWith("[附件已上传，请查看以下文件:\n"));
    assert.ok(sent.input.includes("/tmp/wand-team-chat-harness/.wand-uploads/harness-photo.png\n"));
    assert.ok(sent.input.includes("/tmp/wand-team-chat-harness/.wand-uploads/harness-notes.txt\n"));
    assert.ok(sent.input.endsWith("\n\n附件发送成功"));
    const sentScreenshot = await screenshot("attachment-chat-390-sent.png");
    results.push({ check: "attachments/pickers-chips-upload-message-echo-preview", pendingFiles,
      upload: uploadRequests.at(-1), success, screenshot: sentScreenshot });

    await fresh();
    await chooseFile('input[aria-label="选择附件"]', rejectedPath, 1);
    await sendDraft("附件明确拒收");
    await waitFor(`document.querySelector('textarea[aria-label="群聊消息"]').value === '附件明确拒收'
      && document.querySelectorAll('.task-board-team-chat-input .attachment-pill').length === 1`);
    assert.equal(await read("document.querySelectorAll('.team-chat-msg:not([data-presentation-id])').length"), 0,
      "definite refusal removes optimistic row");
    assert.ok(messageRequests.at(-1).input.includes("/reject.txt\n"));
    results.push({ check: "attachments/definite-refusal-restores-text-and-file", ok: true });

    await fresh();
    await chooseFile('input[aria-label="选择附件"]', unknownPath, 1);
    await sendDraft("附件送达未知");
    await waitFor("Boolean(document.querySelector('.wand-team-chat-unconfirmed'))");
    const unknown = await read(`(() => ({
      draft:document.querySelector('textarea[aria-label="群聊消息"]').value,
      chips:document.querySelectorAll('.task-board-team-chat-input .attachment-pill').length,
      row:document.querySelector('.wand-team-chat-unconfirmed')?.closest('.team-chat-msg')?.textContent,
      warning:document.querySelector('.task-board-team-chat-input .task-board-team-error[role=alert]')?.textContent,
      stored:localStorage.getItem('wand-draft-chat-1'),
    }))()`);
    assert.equal(unknown.draft, "附件送达未知");
    assert.equal(unknown.chips, 1);
    assert.equal(unknown.stored, null, "uncertain submitted draft must stay memory-only");
    assert.ok(unknown.row?.includes("unknown.txt") && unknown.row.includes("未确认"));
    assert.ok(unknown.warning?.includes("送达状态未知"), JSON.stringify(unknown));
    results.push({ check: "attachments/unknown-delivery-keeps-unconfirmed-row", unknown });

    await fresh();
    const beforeUploadFailure = messageRequests.length;
    await chooseFile('input[aria-label="选择附件"]', failedUploadPath, 1);
    await sendDraft("上传失败保留草稿");
    await waitFor(`document.querySelector('textarea[aria-label="群聊消息"]').value === '上传失败保留草稿'
      && document.querySelectorAll('.task-board-team-chat-input .attachment-pill').length === 1
      && Boolean(document.querySelector('.task-board-team-chat-input .task-board-team-error[role=alert]'))`);
    assert.equal(messageRequests.length, beforeUploadFailure, "upload failure must not send a message");
    results.push({ check: "attachments/upload-failure-keeps-text-and-file", ok: true });

    await fresh();
    await action("window.teamHarness.startLive()");
    await waitFor("document.querySelector('.team-chat-compose-main .btn-circle-send')?.dataset.phase === 'running'");
    const emptyRunning = await read(`(() => {
      const primary=document.querySelector('.team-chat-compose-main .btn-circle-send');
      return { phase:primary.dataset.phase, label:primary.getAttribute('aria-label'),
        stopCount:document.querySelectorAll('.team-chat-stop-action').length,
        rect:primary.getBoundingClientRect().toJSON() };
    })()`);
    assert.equal(emptyRunning.label, "停止团队");
    assert.equal(emptyRunning.stopCount, 0);
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "运行中继续写" });
    await waitFor("document.querySelector('textarea[aria-label=\"群聊消息\"]').value === '运行中继续写'");
    const draftingRunning = await read(`(() => {
      const primary=document.querySelector('.team-chat-compose-main .btn-circle-send');
      return { phase:primary.dataset.phase, label:primary.getAttribute('aria-label'),
        stopCount:document.querySelectorAll('.team-chat-stop-action').length,
        stopLabel:document.querySelector('.team-chat-stop-action')?.getAttribute('aria-label'),
        rect:primary.getBoundingClientRect().toJSON() };
    })()`);
    assert.equal(draftingRunning.phase, "idle");
    assert.equal(draftingRunning.label, "发送消息");
    assert.equal(draftingRunning.stopCount, 1);
    assert.equal(draftingRunning.stopLabel, "停止团队");
    assert.ok(Math.abs(emptyRunning.rect.x - draftingRunning.rect.x) <= 1
      && Math.abs(emptyRunning.rect.width - draftingRunning.rect.width) <= 1,
    "the shared primary control keeps its horizontal position and size while changing send/stop state");
    results.push({ check: "composer/running-send-stop-in-place", emptyRunning, draftingRunning });

    await fresh();
    await action(`document.querySelector('textarea[aria-label="群聊消息"]').focus()`);
    await send("Input.insertText", { text: "输入法候选还没确认" });
    const beforeIme = messageRequests.length;
    await action(`document.querySelector('textarea[aria-label="群聊消息"]')
      .dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(40);
    assert.equal(messageRequests.length, beforeIme, "IME confirmation must not submit the draft");
    assert.ok((await read("document.querySelector('textarea[aria-label=\"群聊消息\"]').value"))
      .includes("输入法候选还没确认"));
    results.push({ check: "composer/ime-enter-keeps-draft", ok: true });
    await send("Emulation.clearDeviceMetricsOverride");
  }

  mkdirSync(join(root, "output/team-chat-v2-resume"), { recursive: true });
  const evidencePath = process.env.TEAM_CHAT_HARNESS_RESULTS
    ? resolve(process.env.TEAM_CHAT_HARNESS_RESULTS)
    : join(root, `output/team-chat-v2-resume/rework-browser-results-${probe}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, checks: results.map((result) => result.check) }));
} finally {
  socket?.close();
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill();
    await once(processHandle, "exit");
  }
  server.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
