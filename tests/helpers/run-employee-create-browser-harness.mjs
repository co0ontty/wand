// Static development harness only: exercises the real EmployeeCreateForm in headless Chrome.
// Not an installed-service acceptance test and never reads ~/.wand credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "wand-employee-create-browser-"));
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const bundle = join(dir, "app.js");
const results = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const root = resolve(import.meta.dirname, "../..");

await build({
  entryPoints: [join(import.meta.dirname, "employee-create-browser-harness.tsx")],
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
  const action = async (expression) => { await evaluate(expression); await sleep(30); };
  const setValue = async (selector, value) => action(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);

  await send("Runtime.enable");
  await waitFor("Boolean(window.employeeHarness && document.querySelector('.wand-employee-create-submit'))");

  // 默认态：只有期望输入框 + 创建按钮，手动字段收进收起的高级配置。
  const initial = await evaluate(`(() => {
    const section = document.querySelector('.wand-employee-advanced');
    return {
      hasExpectation: Boolean(document.getElementById('new-employee-expectation')),
      focus: document.activeElement?.id,
      sectionHeight: section.getBoundingClientRect().height,
      ariaHidden: section.getAttribute('aria-hidden'),
      inert: section.hasAttribute('inert'),
      submitLabel: document.querySelector('.wand-employee-create-submit').textContent.trim(),
      toggleLabel: document.querySelector('.wand-employee-advanced-toggle button').textContent.trim(),
    };
  })()`);
  assert.equal(initial.hasExpectation, true);
  assert.equal(initial.focus, "new-employee-expectation", "默认焦点落在期望输入框");
  assert.ok(initial.sectionHeight < 1, "高级配置默认收起");
  assert.equal(initial.ariaHidden, "true");
  assert.equal(initial.inert, true);
  assert.equal(initial.submitLabel, "创建员工");
  assert.equal(initial.toggleLabel, "高级配置");
  results.push({ check: "default/single-input", initial });

  // 只填期望 → 自动生成并创建。
  await setValue("#new-employee-expectation", "帮我盯着线上接口");
  await action(`document.querySelector('.wand-employee-create-submit').click()`);
  await waitFor("window.employeeHarness.saved.length === 1");
  const autoSaved = await evaluate("window.employeeHarness.saved[0]");
  const draftRequest = await evaluate("window.employeeHarness.draftRequests[0]");
  assert.deepEqual(draftRequest, { expectation: "帮我盯着线上接口" });
  assert.equal(autoSaved.name, "接口守夜人");
  assert.equal(autoSaved.duty, "守护线上接口稳定");
  assert.equal(autoSaved.prompt, "你是值守接口的工程师。");
  assert.equal(autoSaved.avatar, "");
  assert.equal(autoSaved.agents.length, 1);
  assert.equal(autoSaved.agents[0].provider, "claude");
  assert.equal(autoSaved.agents[0].kind, "structured");
  results.push({ check: "auto-create/from-expectation", autoSaved });

  // 展开高级配置：触发按钮不位移，字段原位长出来。
  const triggerBefore = await evaluate("document.querySelector('.wand-employee-advanced-toggle button').getBoundingClientRect().toJSON()");
  await action("document.querySelector('.wand-employee-advanced-toggle button').click()");
  await waitFor("document.querySelector('.wand-employee-advanced').getBoundingClientRect().height > 100");
  await sleep(350);
  const expanded = await evaluate(`(() => {
    const section = document.querySelector('.wand-employee-advanced');
    const toggle = document.querySelector('.wand-employee-advanced-toggle button');
    const chevron = toggle.querySelector('svg:last-child');
    return {
      trigger: toggle.getBoundingClientRect().toJSON(),
      expanded: toggle.getAttribute('aria-expanded'),
      chevron: getComputedStyle(chevron).transform,
      sectionHeight: section.getBoundingClientRect().height,
      ariaHidden: section.getAttribute('aria-hidden'),
      inert: section.hasAttribute("inert"),
    };
  })()`);
  assert.deepEqual(expanded.trigger, triggerBefore, "展开高级配置不得移动或改动触发按钮");
  assert.equal(expanded.expanded, "true");
  assert.match(expanded.chevron, /matrix\(-1, 0, 0, -1, 0, 0\)/, "箭头同实例旋转 180 度");
  assert.ok(expanded.sectionHeight > 100);
  assert.equal(expanded.ariaHidden, "false");
  assert.equal(expanded.inert, false);
  results.push({ check: "advanced/in-place-expand", triggerBefore, expanded });

  // 高级配置里的「按期望生成」只填充字段，不落库。
  const savesAfterAuto = await evaluate("window.employeeHarness.saved.length");
  await action("document.querySelector('.wand-employee-advanced-tools button').click()");
  await waitFor("window.employeeHarness.draftRequests.length === 2");
  const filled = await evaluate(`({
    name: document.getElementById('new-employee-name').value,
    duty: document.getElementById('new-employee-duty').value,
    prompt: document.getElementById('new-employee-prompt').value,
    saved: window.employeeHarness.saved.length,
    agent: document.querySelector('.wand-team-candidate [data-candidate-id]')?.textContent?.trim().slice(0, 20) ?? '',
  })`);
  assert.equal(filled.name, "接口守夜人");
  assert.equal(filled.duty, "守护线上接口稳定");
  assert.equal(filled.saved, savesAfterAuto, "「按期望生成」不得直接落库");
  results.push({ check: "advanced/fill-from-expectation", filled });

  // 手动填了名字 → 直接按手动配置创建，不再调模型。
  const draftsBeforeManual = await evaluate("window.employeeHarness.draftRequests.length");
  await setValue("#new-employee-name", "手动员工");
  await action(`document.querySelector('.wand-employee-create-submit').click()`);
  await waitFor("window.employeeHarness.saved.length === 2");
  const manualSaved = await evaluate("window.employeeHarness.saved[1]");
  assert.equal(manualSaved.name, "手动员工");
  assert.equal(
    await evaluate("window.employeeHarness.draftRequests.length"),
    draftsBeforeManual,
    "手动创建不得再调模型",
  );
  results.push({ check: "advanced/manual-create-without-model", manualSaved });

  // 收起：倒放回触发的按钮，字段回到收起态。
  await action("document.querySelector('.wand-employee-advanced-toggle button').click()");
  await waitFor("document.querySelector('.wand-employee-advanced').getBoundingClientRect().height < 1");
  results.push({ check: "advanced/collapse", ok: true });

  // 原生壳没有全局 reduce-motion 兜底，高级配置必须瞬时。
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await action("document.documentElement.classList.add('is-wand-app')");
  const reduced = await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.wand-employee-advanced'));
    return { transition: style.transitionDuration, margin: style.marginBlockStart };
  })()`);
  assert.ok(parseFloat(reduced.transition) < 0.001, `原生壳 reduce-motion 过渡必须瞬时: ${reduced.transition}`);
  results.push({ check: "native-shell/reduced-motion", reduced });

  console.log("employee create browser harness passed");
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { processHandle?.kill("SIGKILL"); } catch { /* ignore */ }
  await new Promise((done) => server.close(() => done()));
  await sleep(200);
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp profile may still be flushing */ }
}
