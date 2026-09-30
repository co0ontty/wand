// Static development harness only: exercises the real employee list/card with the
// built-in 「系统运维」employee in headless Chrome. Not an installed-service
// acceptance test and never reads ~/.wand credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "wand-system-employee-browser-"));
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const bundle = join(dir, "app.js");
const results = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const root = resolve(import.meta.dirname, "../..");

await build({
  entryPoints: [join(import.meta.dirname, "system-employee-browser-harness.tsx")],
  bundle: true, platform: "browser", format: "iife", outfile: bundle,
  define: { "process.env.NODE_ENV": '"production"' },
});

const server = createServer((req, res) => {
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
    <link rel="stylesheet" href="/tailwind.css"/><link rel="stylesheet" href="/styles.css"/></head>
    <body><div id="root"></div><div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals"></div></div>
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
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
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
    for (let i = 0; i < 80; i++) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`waitFor failed: ${expression}`);
  };
  const action = async (expression) => { await evaluate(expression); await sleep(60); };

  await send("Runtime.enable");
  await waitFor("Boolean(window.systemEmployeeHarness && document.querySelectorAll('.wand-employee-card').length === 2)");

  // 设置页「系统 AI」的执行者投影：只读展示候选链，不提供编辑入口。
  const owner = await evaluate(`(() => {
    const box = document.querySelector('.wand-settings-system-ai-owner');
    const style = getComputedStyle(box);
    return {
      label: box.getAttribute('aria-label'),
      tag: box.querySelector('.wand-employee-system-tag')?.textContent?.trim() ?? '',
      name: box.querySelector('strong')?.textContent?.trim() ?? '',
      chain: [...box.querySelectorAll('.wand-settings-system-ai-chain li')].map((li) => li.textContent.trim()),
      hint: box.querySelector('.wand-settings-system-ai-hint')?.textContent?.trim() ?? '',
      inputs: box.querySelectorAll('input, select, textarea').length,
      background: style.backgroundColor,
    };
  })()`);
  assert.equal(owner.label, "系统 AI 执行者");
  assert.equal(owner.tag, "系统运维");
  assert.match(owner.name, /勤劳的初二/);
  assert.equal(owner.chain.length, 2);
  assert.match(owner.chain[0], /^01\s*Claude · 默认模型$/);
  assert.match(owner.chain[1], /^02\s*Grok · grok-4\.5$/);
  assert.match(owner.hint, /硅基员工/);
  assert.equal(owner.inputs, 0, "设置页只做投影，不在原地改候选");
  assert.ok(owner.background && owner.background !== "rgba(0, 0, 0, 0)", "投影卡片有背景样式");
  results.push({ check: "settings/system-ai-owner-projection", owner });

  // 内置员工排在最前，带「系统运维」标识与候选链摘要。
  const layout = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.wand-employee-card')];
    return {
      order: cards.map((card) => card.querySelector('.wand-team-member-copy strong').textContent.trim()),
      tags: cards.map((card) => card.querySelector('.wand-employee-system-tag')?.textContent?.trim() ?? ''),
      firstIsSystem: cards[0].classList.contains('is-system'),
      agents: cards[0].querySelector('.wand-team-member-agent').textContent.trim(),
    };
  })()`);
  assert.equal(layout.order.length, 2);
  assert.match(layout.order[0], /勤劳的初二/);
  assert.equal(layout.tags[0], "系统运维");
  assert.equal(layout.tags[1], "");
  assert.equal(layout.firstIsSystem, true, "内置员工卡片带 is-system 状态");
  assert.match(layout.agents, /备用/, "候选链摘要要显示备用数量");
  results.push({ check: "list/system-first-with-tag", layout });

  // 展开内置员工：锁定字段不可编辑、没有归档/删除，但候选可改。
  await action("document.querySelectorAll('.wand-employee-card .wand-team-member-head')[0].click()");
  await waitFor("document.querySelectorAll('.wand-employee-card')[0].dataset.open === 'true'");
  const systemBody = await evaluate(`(() => {
    const card = document.querySelectorAll('.wand-employee-card')[0];
    return {
      note: card.querySelector('.wand-employee-system-note')?.textContent?.trim().slice(0, 20) ?? '',
      nameInputs: card.querySelectorAll('input[type="text"]').length,
      textareas: card.querySelectorAll('textarea').length,
      candidateRows: card.querySelectorAll('.wand-team-candidate[data-candidate-id]').length,
      actions: [...card.querySelectorAll('.wand-team-member-actions button')].map((b) => b.textContent.trim()),
    };
  })()`);
  assert.match(systemBody.note, /系统运维/);
  assert.equal(systemBody.nameInputs, 0, "内置员工不提供名字输入框");
  assert.equal(systemBody.textareas, 0, "内置员工不提供职责/Prompt 输入框");
  assert.ok(systemBody.candidateRows >= 2, "候选仍然可编辑");
  assert.deepEqual(systemBody.actions, ["保存修改", "取消"], "内置员工没有归档/删除");
  results.push({ check: "card/system-locked-fields", systemBody });

  // 改候选顺序后保存：只提交候选，锁定字段原样回传服务端定义。
  await action(`(() => {
    const card = document.querySelectorAll('.wand-employee-card')[0];
    const down = [...card.querySelectorAll(".wand-team-candidate")][0].querySelector("button[aria-label*=下移]");
    down.click();
  })()`);
  await action(`(() => {
    const card = document.querySelectorAll('.wand-employee-card')[0];
    [...card.querySelectorAll('.wand-team-member-actions button')].find((b) => b.textContent.trim() === '保存修改').click();
  })()`);
  await waitFor("window.systemEmployeeHarness.updates.length === 1");
  const saved = await evaluate("window.systemEmployeeHarness.updates[0]");
  assert.equal(saved.id, "e_wand_ops");
  assert.deepEqual(saved.body.agents.map((agent) => agent.provider), ["grok", "claude"], "候选顺序按界面保存");
  assert.equal(saved.body.name, "勤劳的初二");
  assert.equal(saved.body.prompt, "你是 Wand 的系统运维「勤劳的初二」。……");
  assert.equal(saved.body.avatar, "");
  results.push({ check: "card/save-only-candidates", saved });

  // 设置页的投影必须自己跟上：不刷新页面也要变成新顺序（用户报的就是这一条）。
  await waitFor("document.querySelectorAll('.wand-settings-system-ai-chain li')[0]?.textContent.includes('Grok')");
  const afterSave = await evaluate(`[...document.querySelectorAll('.wand-settings-system-ai-chain li')].map((li) => li.textContent.trim())`);
  assert.equal(afterSave.length, 2);
  assert.match(afterSave[0], /^01\s*Grok · grok-4\.5$/);
  assert.match(afterSave[1], /^02\s*Claude · 默认模型$/);
  results.push({ check: "settings/follows-definition-change", afterSave });

  // 普通员工保持原有编辑能力。
  await action("document.querySelectorAll('.wand-employee-card .wand-team-member-head')[1].click()");
  await waitFor("document.querySelectorAll('.wand-employee-card')[1].dataset.open === 'true'");
  const userBody = await evaluate(`(() => {
    const card = document.querySelectorAll('.wand-employee-card')[1];
    return {
      systemTag: Boolean(card.querySelector('.wand-employee-system-tag')),
      nameInput: Boolean(card.querySelector('input[type="text"]')),
      actions: [...card.querySelectorAll('.wand-team-member-actions button')].map((b) => b.textContent.trim()),
    };
  })()`);
  assert.equal(userBody.systemTag, false);
  assert.equal(userBody.nameInput, true);
  assert.deepEqual(userBody.actions, ["保存修改", "取消", "归档", "删除"]);
  results.push({ check: "card/user-unchanged", userBody });

  assert.deepEqual(await evaluate("window.systemEmployeeHarness.mutations"), [], "内置员工不应发出归档/删除请求");

  console.log("system employee browser harness passed");
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { processHandle?.kill("SIGKILL"); } catch { /* ignore */ }
  await new Promise((done) => server.close(() => done()));
  await sleep(200);
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp profile may still be flushing */ }
}
