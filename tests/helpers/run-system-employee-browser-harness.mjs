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
  await waitFor("Boolean(window.systemEmployeeHarness && document.querySelectorAll('.wand-employee-card').length === 3)");

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
      cliLogo: box.querySelector('.wand-employee-avatar-provider [data-provider-logo]')?.dataset.providerLogo,
    };
  })()`);
  assert.equal(owner.label, "系统 AI 执行者");
  assert.equal(owner.tag, "系统用户");
  assert.match(owner.name, /勤劳的初二/);
  assert.equal(owner.chain.length, 2);
  assert.match(owner.chain[0], /^01\s*Claude · 默认模型$/);
  assert.match(owner.chain[1], /^02\s*Grok · grok-4\.5$/);
  assert.match(owner.hint, /硅基员工/);
  assert.equal(owner.inputs, 0, "设置页只做投影，不在原地改候选");
  assert.equal(owner.cliLogo, "claude", "系统员工头像显示首选 CLI 角标");
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
      cliLogos: cards.map((card) => card.querySelector('.wand-employee-avatar-provider [data-provider-logo]')?.dataset.providerLogo),
      badgeGeometry: cards.map((card) => {
        const avatar = card.querySelector('.wand-employee-avatar').getBoundingClientRect();
        const badge = card.querySelector('.wand-employee-avatar-provider').getBoundingClientRect();
        return { size: badge.width, square: badge.width === badge.height,
          right: avatar.right - badge.right, bottom: avatar.bottom - badge.bottom };
      }),
    };
  })()`);
  assert.equal(layout.order.length, 3);
  assert.match(layout.order[0], /勤劳的初二/);
  assert.equal(layout.tags[0], "系统用户");
  assert.equal(layout.tags[1], "");
  assert.equal(layout.firstIsSystem, true, "内置员工卡片带 is-system 状态");
  assert.deepEqual(layout.cliLogos, ["claude", "claude", "claude"]);
  for (const badge of layout.badgeGeometry) {
    assert.equal(badge.square, true);
    assert.ok(badge.size >= 13 && badge.size <= 20);
    assert.equal(badge.right, -2, "角标贴头像右下角");
    assert.equal(badge.bottom, -2);
  }
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
  assert.match(systemBody.note, /系统用户/);
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
  assert.deepEqual(Object.keys(saved.body), ["agents"], "自动更新的锁定字段不能被旧表单回写");
  results.push({ check: "card/save-only-candidates", saved });

  // 设置页的投影必须自己跟上：不刷新页面也要变成新顺序（用户报的就是这一条）。
  await waitFor("document.querySelectorAll('.wand-settings-system-ai-chain li')[0]?.textContent.includes('Grok')");
  const afterSave = await evaluate(`[...document.querySelectorAll('.wand-settings-system-ai-chain li')].map((li) => li.textContent.trim())`);
  assert.equal(afterSave.length, 2);
  assert.match(afterSave[0], /^01\s*Grok · grok-4\.5$/);
  assert.match(afterSave[1], /^02\s*Claude · 默认模型$/);
  await waitFor("document.querySelector('.wand-settings-system-ai-owner .wand-employee-avatar-provider [data-provider-logo]')?.dataset.providerLogo === 'grok'");
  assert.equal(await evaluate("document.querySelector('[data-employee-id=e_wand_ops] .wand-team-member-head .wand-employee-avatar-provider [data-provider-logo]').dataset.providerLogo"), "grok");
  results.push({ check: "settings/follows-definition-change", afterSave, cliBadgeUpdated: true });

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

  // 普通员工的标签可编辑；保存中、成功、失败都留在同一个按钮，输入不丢失。
  const setTags = async (value) => action(`(() => {
    const input = document.getElementById('employee-e_user-tags');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await sleep(await evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-normal')) + 80"));
  await setTags("交付，Équipe，交付");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.wand-employees-layout')).overflowY"), "auto");
  await action("document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').scrollIntoView({block:'center',behavior:'instant'})");
  assert.equal(await evaluate("(() => {const b=document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit'),r=b.getBoundingClientRect();return r.y>=0 && r.bottom<=innerHeight && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), true, "长表单保存按钮必须真实可点击");
  const saveBefore = await evaluate(`(() => {
    const b = document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit');
    window.tagSaveButton = b;
    const r = b.getBoundingClientRect(); b.click();
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  })()`);
  await waitFor("document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').textContent === '保存中…'");
  await waitFor("document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').textContent === '已保存'");
  const saveAfter = await evaluate(`(() => {
    const b = document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit');
    const r = b.getBoundingClientRect(); return {geometry:{x:r.x,y:r.y,width:r.width,height:r.height},same:b===window.tagSaveButton};
  })()`);
  assert.deepEqual(saveAfter.geometry, saveBefore);
  assert.equal(saveAfter.same, true);
  assert.deepEqual(await evaluate("window.systemEmployeeHarness.updates[1].body.tags"), ["交付","Équipe"]);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-employee-id=e_user] .wand-employee-tag')].map(e=>e.textContent)"), ["交付","Équipe"]);

  await setTags("暂存标签");
  await evaluate("window.systemEmployeeHarness.failNextSave = true");
  await action("document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').click()");
  await waitFor("document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').textContent === '保存失败'");
  assert.equal(await evaluate("document.getElementById('employee-e_user-tags').value"), "暂存标签");
  const failureGeometry = await evaluate(`(() => {
    const r = document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  })()`);
  assert.deepEqual(failureGeometry, saveBefore, "失败提示不能推动提交按钮");
  await setTags("系统用户");
  await action("document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').click()");
  await waitFor("document.querySelector('[data-employee-id=e_user] [role=alert]')?.textContent.includes('内置标签')");
  assert.equal(await evaluate("window.systemEmployeeHarness.updates.length"), 2);
  assert.equal(await evaluate("document.getElementById('employee-e_user-tags').value"), "系统用户");
  await setTags("");
  await action("document.querySelector('[data-employee-id=e_user] .wand-employee-save-submit').click()");
  await waitFor("window.systemEmployeeHarness.updates.length === 3");
  assert.deepEqual(await evaluate("window.systemEmployeeHarness.updates[2].body.tags"), []);
  assert.equal(await evaluate("document.querySelectorAll('[data-employee-id=e_user] .wand-employee-tag').length"), 0);
  results.push({check:"card/custom-tags-and-in-place-feedback",saveBefore,saveAfter,inputRetained:true});


  assert.deepEqual(await evaluate("window.systemEmployeeHarness.mutations"), [], "内置员工不应发出归档/删除请求");

  assert.deepEqual(await evaluate("window.systemEmployeeHarness.memoryCalls"), [], "收起态不预取记忆");
  await action("document.querySelectorAll('.wand-employee-card .wand-team-member-head')[2].click()");
  await waitFor("document.querySelector('[data-employee-id=e_wand_default] .wand-employee-memory')?.textContent.includes('先结论后证据')");
  const defaultCard = await evaluate(`(() => {
    const card = document.querySelectorAll('.wand-employee-card')[2];
    return { tag: card.querySelector('.wand-employee-system-tag').textContent,
      promptReadOnly: card.querySelector('textarea').readOnly,
      actions: [...card.querySelectorAll('.wand-team-member-actions button')].map(b => b.textContent.trim()) };
  })()`);
  assert.equal(defaultCard.tag, '默认用户');
  assert.equal(defaultCard.promptReadOnly, true);
  assert.deepEqual(defaultCard.actions, ['保存修改', '取消']);
  await sleep(await evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-normal')) + 80"));
  for (const [index, result] of [[0, '已暂停'], [0, '已开启'], [1, '已更新'], [2, '已清空']]) {
    const before = await evaluate(`(() => {
      const b = document.querySelectorAll('.wand-employee-memory-actions button')[${index}];
      const r = b.getBoundingClientRect(); window.memoryButton = b;
      b.click(); return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    await waitFor(`document.querySelectorAll('.wand-employee-memory-actions button')[${index}]?.textContent === '${result}'`);
    const after = await evaluate(`(() => {
      const b = document.querySelectorAll('.wand-employee-memory-actions button')[${index}];
      const r = b.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,same:b===window.memoryButton};
    })()`);
    assert.equal(after.same, true);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    assert.equal(after.x, before.x);
    // Data above can shorten after clear, so keep the action row before the variable knowledge list.
    assert.equal(after.y, before.y);
  }
  await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  results.push({ check: 'default-role-memory-controls-stable-and-narrow', defaultCard });
  await waitFor("document.querySelector('[data-employee-id=e_wand_default] .wand-employee-knowledge-list')?.textContent.includes('默认伙伴的独立知识')");
  const namespaces = await evaluate(`[...document.querySelectorAll('.wand-employee-card')].map(c => ({id:c.dataset.employeeId,text:c.querySelector('.wand-employee-knowledge-list').textContent}))`);
  assert.deepEqual(namespaces.map(n => n.text), ['系统运维的独立知识','普通员工的独立知识','默认伙伴的独立知识']);
  await action("document.querySelectorAll('[data-employee-id=e_user] .wand-employee-knowledge-actions button')[1].click()");
  assert.equal(await evaluate("window.systemEmployeeHarness.knowledgeCalls.filter(c => c.method==='DELETE').length"),0,'清空须二次确认');
  await action("document.querySelectorAll('[data-employee-id=e_user] .wand-employee-knowledge-actions button')[1].click()");
  await waitFor("document.querySelector('[data-employee-id=e_user] .wand-employee-knowledge-list').textContent.includes('还没有明确记录')");
  assert.equal(await evaluate("document.querySelector('[data-employee-id=e_wand_default] .wand-employee-knowledge-list').textContent"),'默认伙伴的独立知识');
  assert.deepEqual(await evaluate("window.systemEmployeeHarness.knowledgeCalls.filter(c=>c.method==='DELETE').map(c=>c.employeeId)"),['e_user']);
  await action("document.querySelector('[data-employee-id=e_user] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('[data-employee-id=e_user]').dataset.open"),undefined);
  results.push({check:'per-employee-knowledge-isolation-confirm-clear-and-escape',namespaces});

  console.log("system employee browser harness passed");
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { processHandle?.kill("SIGKILL"); } catch { /* ignore */ }
  await new Promise((done) => server.close(() => done()));
  await sleep(200);
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp profile may still be flushing */ }
}
