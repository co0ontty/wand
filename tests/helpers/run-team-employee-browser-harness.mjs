// Development-only synthetic fixtures; real team editor/select/portal/styles in Chrome.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const temp = mkdtempSync(join(tmpdir(), "wand-team-employee-"));
const root = resolve(import.meta.dirname, "../..");
const bundle = join(temp, "app.js");
await build({ entryPoints: [join(import.meta.dirname, "team-employee-browser-harness.tsx")],
  bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: bundle,
  define: { "process.env.NODE_ENV": '"production"' } });
const tailwind = join(temp, "tailwind.css");
execFileSync(process.execPath, [join(root, "node_modules/@tailwindcss/cli/dist/index.mjs"),
  "-i", join(root, "src/web-ui/css/appica.css"), "-o", tailwind], { cwd: root, stdio: "pipe" });
const agent = { provider: "pi", model: "default", mode: "default", thinkingEffort: "default", kind: "structured" };
const employees = [
  { id: "e_one", name: "员工甲", duty: "研发", avatar: "cat:2", agents: [agent] },
  { id: "e_two", name: "员工乙", duty: "评审", avatar: "cat:3", agents: [agent] },
  { id: "e_three", name: "员工丙", duty: "规划", avatar: "cat:4", agents: [agent] },
  { id: "e_archived", name: "归档员工", archivedAt: "today", agents: [agent] },
  { id: "e_pty", name: "终端候选", agents: [{ ...agent, kind: "pty" }] },
];
let employeeReads = 0, knowledgeReads = 0, listFails = 0, saveMode = "reject";
const writes = [];
let holdList = false;
const heldLists = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.startsWith("/api/silicon-employees?")) {
    employeeReads++;
    const list = holdList ? employees.map((employee) => ({ ...employee, name: "迟到资料" })) : employees;
    if (holdList) await new Promise((resolve) => heldLists.push(resolve));
    if (listFails-- > 0) { res.statusCode = 503; res.end(JSON.stringify({ error: "synthetic list failure" })); }
    else res.end(JSON.stringify({ employees: list }));
  } else if (req.url.includes("knowledge")) {
    knowledgeReads++; res.statusCode = 500; res.end("{}");
  } else if (req.url === "/api/ai-teams/t_fixture" && req.method === "PUT") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const draft = JSON.parse(raw); writes.push(draft);
    if (saveMode !== "success") { res.statusCode = saveMode === "reject" ? 400 : 500; res.end(JSON.stringify({ error: "synthetic save failure" })); }
    else res.end(JSON.stringify({ ...draft, id: "t_fixture", createdAt: "", updatedAt: "now" }));
  } else if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(bundle));
  } else if (req.url === "/styles.css" || req.url === "/tailwind.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(readFileSync(req.url === "/tailwind.css" ? tailwind : join(root, "src/web-ui/content/styles.css")));
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <link rel="stylesheet" href="/styles.css"/><link rel="stylesheet" href="/tailwind.css"/>
      <style>body{margin:0}#root{max-width:900px;margin:auto;padding:14px}</style></head>
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
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0",
      `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const portFile = join(temp, "profile/DevToolsActivePort");
  for (let n = 0; n < 100 && !existsSync(portFile); n++) await sleep(50);
  assert.ok(existsSync(portFile), "Chrome CDP must be available");
  const tabs = await (await fetch(`http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}/json`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl); await once(socket, "open");
  let seq = 0, errors = 0; const pending = new Map();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") { errors++; console.error(msg.params.exceptionDetails); }
    const call = pending.get(msg.id); if (!call) return; pending.delete(msg.id);
    msg.error ? call.reject(Error("CDP failed")) : call.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await sleep(50); }
    throw Error(`condition missing: ${expression}; body: ${await evaluate('document.body.textContent')}`);
  };
  const click = async (selector) => {
    await sleep(350);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(350);
    const pos = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.equal(await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n.disabled || n.contains(document.elementFromPoint(${pos.x},${pos.y}))})()`), true,
      `click target obscured: ${selector} ${JSON.stringify(pos)} ${await evaluate(`document.elementFromPoint(${pos.x},${pos.y})?.outerHTML.slice(0,300)`)}`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...pos, button: "left", clickCount: 1 });
  };
  const text = async (selector, value) => {
    await click(selector);
    await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  };
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  };
  const invite = ".wand-team-section[aria-label='成员'] > .wand-team-employee-invite";
  const inviteTrigger = `${invite} > button`;
  const save = ".wand-settings-save-bar button";
  await send("Runtime.enable"); await send("Page.enable");
  for (const mode of ["desktop", "390px", "reduce-motion"]) {
    const narrow = mode === "390px", reduced = mode === "reduce-motion";
    await send("Emulation.setDeviceMetricsOverride", { width: narrow ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
    saveMode = "reject"; listFails = 1;
    const before = employeeReads;
    await send("Page.navigate", { url: origin });
    await wait('!!document.querySelector("#mount-editor")');
    assert.equal(employeeReads, before, "employees are not fetched before editing");
    await click("#mount-editor");
    assert.equal(employeeReads, before, "retained runs-only editor does not load employees");
    await click("#notify-employee"); assert.equal(employeeReads, before, "hidden definition notifications do not load employees");
    await click("#show-members");
    await wait('document.body.textContent.includes("通讯录加载失败")');
    await text("#ai-team-t_fixture-name", "保留团队草稿");
    await click(inviteTrigger);
    await click(`${invite} .wand-new-session-error button`);
    await wait(`${JSON.stringify(invite)} && !!document.querySelector(${JSON.stringify(invite + " .wand-ui-select-trigger")})`);
    assert.equal(await evaluate('document.querySelector("#ai-team-t_fixture-name").value'), "保留团队草稿");
    const loadedReads = employeeReads;
    holdList = true; await click("#notify-employee");
    for (let n = 0; n < 100 && !heldLists.length; n++) await sleep(25);
    assert.equal(heldLists.length, 1);
    await click("#show-runs"); await click("#notify-employee");
    assert.equal(employeeReads, loadedReads + 1, "hidden notifications must not reload the retained editor");
    holdList = false; heldLists.splice(0).forEach((release) => release());
    await sleep(200);
    assert.equal(await evaluate('document.querySelector("#team-member-0-name").value'), "员工甲", "late list does not update inactive component");
    await click("#show-members");
    await wait(`!document.querySelector(${JSON.stringify(invite)}).textContent.includes('正在加载通讯录')`);
    assert.equal(employeeReads, loadedReads + 2);
    assert.equal(await evaluate('document.querySelector("#ai-team-t_fixture-name").value'), "保留团队草稿", "tab switches preserve draft");
    await click(inviteTrigger);
    await wait(`document.activeElement===document.querySelector(${JSON.stringify(invite + " .wand-ui-select-trigger")})`);
    const rectBefore = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(inviteTrigger)}).getBoundingClientRect();return[r.x,r.y+scrollY,r.width,r.height]})()`);
    await click(`${invite} .wand-ui-select-trigger`);
    await wait('!!document.querySelector(".wand-ui-select-content [role=option]")');
    const optionState = await evaluate(`Array.from(document.querySelectorAll('.wand-ui-select-content [role=option]')).map(n=>({text:n.textContent,disabled:n.getAttribute('aria-disabled')}))`);
    for (const label of ["员工甲", "归档员工", "终端候选"]) assert.equal(optionState.find((entry) => entry.text.includes(label))?.disabled, "true");
    const option = await evaluate(`Array.from(document.querySelectorAll('.wand-ui-select-content [role=option]')).find(n=>n.textContent.includes('员工乙')).id`);
    await click(`[id=${JSON.stringify(option)}]`);
    await wait('document.querySelectorAll(".wand-team-member").length===3');
    await wait(`document.querySelector(${JSON.stringify(inviteTrigger)}).getAttribute('aria-pressed')==='false'`);
    await wait(`document.activeElement===document.querySelector(${JSON.stringify(inviteTrigger)})`);
    const rectAfter = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(inviteTrigger)}).getBoundingClientRect();return[r.x,r.y+scrollY,r.width,r.height]})()`);
    // Scroll changes are irrelevant to the anchored trigger's document position.
    assert.equal(rectBefore[0], rectAfter[0]); assert.ok(Math.abs(rectBefore[1]-rectAfter[1])<1);
    assert.equal(rectBefore[2], rectAfter[2]); assert.equal(rectBefore[3], rectAfter[3]);
    const readOnly = await evaluate(`(()=>{const n=document.querySelectorAll('.wand-team-member')[2];return {name:n.querySelector('#team-member-2-name').disabled,avatar:Array.from(n.querySelectorAll('.wand-team-coat')).every(b=>b.disabled),candidates:Array.from(n.querySelectorAll('.wand-team-candidate button')).every(b=>b.disabled),duty:n.querySelector('textarea').disabled,role:n.querySelector('[aria-label$="的团队角色"]').disabled}})()`);
    assert.deepEqual(readOnly, { name: true, avatar: true, candidates: true, duty: false, role: false });
    await click(inviteTrigger);
    await click(`${invite} .wand-ui-select-trigger`);
    await wait('!!document.querySelector(".wand-ui-select-content [role=option]")');
    await click('.wand-ui-select-content input');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(inviteTrigger)}).getAttribute('aria-pressed')`), "true", "portal search click belongs to invitation");
    await escape();
    await wait('!document.querySelector(".wand-ui-select-content")');
    await escape();
    await wait(`document.querySelector(${JSON.stringify(inviteTrigger)}).getAttribute('aria-pressed')==='false'`);
    await click(inviteTrigger);
    await click("#outside");
    await wait(`document.querySelector(${JSON.stringify(inviteTrigger)}).getAttribute('aria-pressed')==='false'`);
    await click(save);
    await wait('document.body.textContent.includes("synthetic save failure")');
    assert.equal(writes.at(-1).members[2].employeeId, "e_two");
    assert.equal(writes.at(-1).members[2].duty, "评审", "new invitation starts with the employee duty");
    assert.equal(writes.at(-1).members[0].employeeId, "e_one");
    assert.equal(writes.at(-1).members[1].employeeId, undefined);
    assert.equal(writes.at(-1).name, "保留团队草稿");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(save)}).disabled`), false, "explicit rejection preserves an editable draft");
    const unlink = await evaluate(`Array.from(document.querySelectorAll('.wand-team-member')[2].querySelectorAll('button')).find(n=>n.textContent.includes('解除绑定')).disabled`);
    assert.equal(unlink, false);
    await evaluate(`Array.from(document.querySelectorAll('.wand-team-member')[2].querySelectorAll('button')).find(n=>n.textContent.includes('解除绑定')).click()`);
    await wait('!document.querySelector("#team-member-2-name").disabled');
    // Replace an already bound member without changing its team-local identity or responsibilities.
    await click(".wand-team-org-leader .wand-team-member-head");
    const replace = ".wand-team-org-leader .wand-team-employee-invite";
    await click(`${replace} > button`); await click(`${replace} .wand-ui-select-trigger`);
    await wait('!!document.querySelector(".wand-ui-select-content [role=option]")');
    const replacement = await evaluate(`Array.from(document.querySelectorAll('.wand-ui-select-content [role=option]')).find(n=>n.textContent.includes('员工丙')).id`);
    await click(`[id=${JSON.stringify(replacement)}]`);
    await wait('document.querySelector("#team-member-0-name").value==="员工丙"');
    saveMode = "success"; await click(save); await wait('!!window.savedTeam');
    assert.equal(writes.at(-1).members[0].employeeId, "e_three");
    assert.equal(writes.at(-1).members[0].id, "m_leader");
    assert.equal(writes.at(-1).members[0].duty, "负责验收");
    assert.equal(writes.at(-1).members[0].role, "verify");
    assert.equal(writes.at(-1).members[0].isLeader, true);
    assert.equal(writes.at(-1).members[2].employeeId, null, "explicit unlink is sent as null");
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false,
      `no ${mode} overflow: ${await evaluate("Array.from(document.querySelectorAll('#root *')).filter(n=>n.getBoundingClientRect().right>innerWidth+1).slice(0,15).map(n=>n.className+':'+n.getBoundingClientRect().width).join(',')")}`);
    if (reduced) assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(invite + " .wand-team-candidate-slot")})).transitionProperty`), "none");
    results.push({ mode, lazyEmployees: true, retryPreservesDraft: true, duplicateDisabled: true, readonly: true,
      portalOwned: true, hiddenNoFetch: true, staleListIgnored: true, tabDraftRetained: true, escape: true, outside: true, replacePreservesDuty: true, triggerAnchored: true, refFocusReturned: true, newDutySeeded: true, explicitNull: true, overflow: false });
  }
  // Missing linked employee remains bound/read-only until explicit action; unknown save cannot be retried.
  listFails = 0; saveMode = "unknown";
  await send("Page.navigate", { url: origin + "/?missing=1" });
  await wait('!!document.querySelector("#mount-editor")'); await click("#mount-editor"); await click("#show-members");
  await wait('document.body.textContent.includes("绑定员工已归档或删除")');
  await click(".wand-team-org-leader .wand-team-member-head");
  assert.equal(await evaluate('document.querySelector("#team-member-0-name").disabled'), true);
  await text("#ai-team-t_fixture-name", "未知保存草稿");
  const beforeWrites = writes.length; await click(save);
  await wait('document.body.textContent.includes("保存结果尚未确认")');
  assert.equal(writes.at(-1).members[0].employeeId, "e_missing");
  await click(save); assert.equal(writes.length, beforeWrites + 1, "unknown save must not auto-resubmit");
  assert.equal(await evaluate('document.querySelector("#ai-team-t_fixture-name").value'), "未知保存草稿");
  assert.equal(knowledgeReads, 0); assert.equal(errors, 0);
  console.log(JSON.stringify({ ok: true, results, missingBindingRetained: true, unknownSaveProtected: true,
    knowledgeReads, errors }));
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill("SIGKILL"); await once(chrome, "exit"); }
  server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
