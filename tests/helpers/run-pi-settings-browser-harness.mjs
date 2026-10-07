// Development-only real browser regression. Installed-service acceptance is recorded separately.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'wand-resource-browser-'));
const bundle = join(temp, 'app.js');
await build({ entryPoints: [join(import.meta.dirname, 'pi-settings-browser-harness.tsx')], bundle: true,
  platform: 'browser', format: 'iife', jsx: 'automatic', outfile: bundle, define: { 'process.env.NODE_ENV': '"production"' } });
const skill = (n) => `skill-${n.repeat(24)}`;
const mcp = `mcp-${'d'.repeat(24)}`;
const items = [
  { id: skill('a'), name: 'radix-colors', description: '配色与状态层级', source: '已安装' },
  { id: skill('b'), name: 'shadcn-ui', description: '组件与焦点管理', source: '已安装' },
  { id: skill('c'), name: 'mermaid', description: '结构化图表', source: '已安装' },
];
const defaults = () => ({ codemode: 'off', globalTools: true, goalMode: false, tools: ['read', 'bash', 'edit', 'write'],
  localDecision: true, autoCompaction: true, resources: { skills: [], mcpServers: [] }, lockedSkills: [] });
let settings = { a: defaults(), b: defaults() }, fail = false, loadDelay = 0, saveDelay = 0, legacy = false, badAck = false, badLockAck = false;
const calls = [], reads = [], recommendationCalls = [];
const server = createServer(async (req, res) => {
  if (req.url?.endsWith('/pi-settings/recommend')) {
    recommendationCalls.push(req.url);
    res.writeHead(500); res.end('The client must not preflight resource selection.'); return;
  }
  const match = req.url?.match(/^\/api\/sessions\/(a|b)\/pi-settings$/);
  if (match) {
    res.setHeader('Content-Type', 'application/json'); const id = match[1];
    if (req.method === 'PATCH') {
      let body = ''; for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body); calls.push({ id, patch });
      if (saveDelay) await new Promise(r => setTimeout(r, saveDelay));
      if (fail) { res.statusCode = 500; res.end(JSON.stringify({ error: '保存失败：测试故障，原选择保持' })); return; }
      settings[id] = { ...settings[id], ...patch };
      res.end(JSON.stringify({ settings: { ...settings[id], ...(badAck ? { resources: undefined } : {}), ...(badLockAck ? { lockedSkills: undefined } : {}) } }));
    } else {
      reads.push(id);
      const snapshot = { settings: settings[id], engine: 'cli', available: false, toolsAvailable: true,
        reason: '', goalAvailable: true, globalExtensions: [], localDecisionAvailable: true,
        autoResourcesAvailable: !legacy, autoResourcesReason: '', autoCodemodeAvailable: !legacy, skillLocksAvailable: !legacy,
        controls: { codemodeOverride: !legacy },
        ...(legacy ? {} : { resourceCatalog: { skills: items, mcpServers: [{ id: mcp, name: 'docs', description: '文档检索 MCP', source: '用户配置' }], supported: true, reason: '' } }) };
      if (loadDelay) await new Promise(r => setTimeout(r, loadDelay));
      res.end(JSON.stringify(snapshot));
    }
  } else if (req.url === '/app.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(bundle));
  } else if (req.url === '/tailwind.css') {
    res.setHeader('Content-Type', 'text/css'); res.end(readFileSync(join(root, 'src/web-ui/content/tailwind.css')));
  } else if (req.url === '/styles.css') {
    res.setHeader('Content-Type', 'text/css'); res.end(readFileSync(join(root, 'src/web-ui/content/styles.css')));
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0}#root{max-width:820px;margin:auto;padding:16px}#switcher{display:flex;gap:12px}.input-panel{position:fixed;bottom:20px;left:16px;right:16px;max-width:800px;margin:auto}#input-box{min-width:0;min-height:50px;width:100%;box-sizing:border-box}.input-composer-row{overflow:visible}</style></head><body><div id="root"></div><div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>`);
  }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chrome, socket, count = 0;
try {
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${temp}/profile`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(temp, 'profile/DevToolsActivePort');
  for (let i = 0; i < 120 && !existsSync(portFile); i++) await sleep(50);
  assert.ok(existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await once(socket, 'open');
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const msg = JSON.parse(event.data), call = pending.get(msg.id); if (!call) return;
    pending.delete(msg.id); msg.error ? call.reject(Error(JSON.stringify(msg.error))) : call.resolve(msg.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const wait = async expression => { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await sleep(30); }
    throw Error(`Missing ${expression}; ${await evaluate('document.body.textContent')}`); };
  const click = async selector => {
    await sleep(280);
    let pos;
    for (let attempt = 0; attempt < 60; attempt++) {
      const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (point && await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const hit=document.elementFromPoint(${point.x},${point.y});return !n.disabled && (n===hit || n.contains(hit))})()`)) break;
      await sleep(50);
    }
    pos = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing');n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const hittable = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const hit=document.elementFromPoint(${pos.x},${pos.y});return !n.disabled && (n===hit || n.contains(hit))})()`);
    if (!hittable) console.error(await evaluate(`JSON.stringify({point:${JSON.stringify(pos)},hit:document.elementFromPoint(${pos.x},${pos.y})?.outerHTML,node:document.querySelector(${JSON.stringify(selector)})?.outerHTML,parents:(()=>{const all=[];for(let n=document.querySelector(${JSON.stringify(selector)});n;n=n.parentElement){const c=getComputedStyle(n);all.push({name:n.tagName,id:n.id,class:n.className,pointer:c.pointerEvents,display:c.display,visibility:c.visibility,z:c.zIndex,opacity:c.opacity});}return all;})()})`));
    assert.equal(hittable, true, `Not hittable: ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...pos, button: 'left', clickCount: 1 });
  };
  const skillSelector = name => `[role="slider"][aria-label="Skill ${name} 使用设置"]`;
  const chooseSkill = async (name, index) => {
    await sleep(280);
    const selector = skillSelector(name);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
    const r = await rect(selector);
    const point = { x: r.x + r.w * (index + .5) / 3, y: r.y + r.h / 2 };
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  const toggleSkill = async name => {
    const index = await evaluate(`Number(document.querySelector(${JSON.stringify(skillSelector(name))}).getAttribute("aria-valuenow"))`);
    await chooseSkill(name, index === 0 ? 1 : 0);
  };
  const dragSkill = async (name, from, to, checkMiddle, touch = false) => {
    const selector = skillSelector(name);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
    await sleep(280);
    const r = await rect(selector);
    const point = index => ({x:r.x+r.w*(index+.5)/3,y:r.y+r.h/2});
    if (touch) await send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point(from)]});
    else await send('Input.dispatchMouseEvent', {type:'mousePressed',...point(from),button:'left',clickCount:1});
    if (touch) await send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[point(1)]});
    else await send('Input.dispatchMouseEvent', {type:'mouseMoved',...point(1),buttons:1});
    if (checkMiddle) await checkMiddle();
    if (touch) {
      await send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[point(to)]});
      await send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    } else {
      await send('Input.dispatchMouseEvent', {type:'mouseMoved',...point(to),buttons:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased',...point(to),button:'left',clickCount:1});
    }
  };
  const draft = text => evaluate(`(()=>{const n=document.getElementById('input-box');n.value=${JSON.stringify(text)};n.dispatchEvent(new Event('input',{bubbles:true}));n.focus()})()`);
  const check = async (name, expression) => {
    const actual = await evaluate(expression);
    if (actual !== true) console.error(await evaluate('JSON.stringify({active:document.activeElement?.outerHTML,search:document.querySelector("input[type=search]")?.outerHTML,pending:piHarness.piSettingsController.hasPendingFocus()})'));
    assert.equal(actual, true, name); ++count; console.log(`✔ ${name}`);
  };
  const rect = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  const settle = async selector => {
    let previous = '', stable = 0;
    for (let i = 0; i < 100; i++) {
      const geometry = JSON.stringify(await rect(selector));
      stable = geometry === previous ? stable + 1 : 0; previous = geometry;
      if (stable >= 5) return;
      await sleep(50);
    }
    throw Error(`Geometry did not settle: ${selector}`);
  };
  const ready = 'document.querySelector(".wand-pi-settings.is-open") && document.querySelector(".wand-pi-settings-feedback").dataset.phase === "ready"';
  await send('Page.enable');
  for (const mode of process.env.WAND_PI_TEST_MODES?.split(',') ?? ['desktop', '390px', 'dark', 'native', 'rollback', 'reduced-motion']) {
    settings = { a: defaults(), b: defaults() }; calls.length = 0; reads.length = 0;
    fail = false; loadDelay = 0; saveDelay = 0; legacy = false; badAck = false; badLockAck = false;
    recommendationCalls.length = 0;
    await send('Emulation.setDeviceMetricsOverride', { width: mode === '390px' ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mode === '390px' });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: mode === 'reduced-motion' ? 'reduce' : 'no-preference' },
      { name: 'prefers-color-scheme', value: mode === 'dark' ? 'dark' : 'light' }] });
    await send('Page.navigate', { url: mode === 'rollback' ? `${origin}/?reactUi=0` : origin });
    await wait('!!document.getElementById("input-box") && !!document.querySelector(".composer-pi-settings-toggle")');
    if (mode === 'native') await evaluate('document.documentElement.classList.add("is-wand-app")');
    await check(`[${mode}] 初始收起且不预取资源`, '!document.querySelector(".wand-pi-settings.is-open")');
    assert.equal(reads.length, 0);
    await evaluate('piHarness.composer.edit("a",{addAttachment:{file:new File(["attachment"],"keep.txt"),name:"keep.txt",size:10}})');
    await draft('保留我的草稿');
    const before = await rect('#input-box');
    const triggerBefore = await rect('.composer-pi-settings-toggle');
    await click('.composer-pi-settings-toggle'); await wait(ready); await sleep(300);
    assert.deepEqual(await rect('#input-box'), before, 'input stays in place');
    assert.deepEqual(await rect('.composer-pi-settings-toggle'), triggerBefore, 'trigger stays in place'); ++count;
    await check(`[${mode}] 图标展开后焦点进面板`, 'document.activeElement.getAttribute("aria-label") === "搜索 Skills / MCP"');
    await check(`[${mode}] 精确资源面板没有通用工具复选框`, 'document.querySelectorAll(".wand-pi-tool-grid,.wand-pi-settings-row,.wand-pi-settings fieldset").length === 0');
    await check(`[${mode}] 面板与触发器关联唯一`, 'document.getElementById(document.querySelector(".composer-pi-settings-toggle").getAttribute("aria-controls")) === document.querySelector(".wand-pi-settings-inner")');
    await check(`[${mode}] 面板不越窄屏`, '(()=>{const r=document.querySelector(".wand-pi-settings-inner").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0})()');
    await click('button[aria-label="CodeMode 模式"]');
    await wait('!!document.querySelector("[role=option][title=启用]")');
    await click('[role=option][title=启用]');
    await wait('document.querySelector("button.wand-ui-select-trigger").textContent.includes("启用") && document.querySelector(".wand-pi-settings-feedback").dataset.phase === "saved"');
    assert.deepEqual(calls.at(-1).patch, { codemodeOverride: 'on' });
    await check(`[${mode}] CodeMode 浮层选择不误关面板不改资源`, '!!document.querySelector(".wand-pi-settings.is-open") && piHarness.state.sessions[0].piSettings.resources.skills.length === 0');
    await toggleSkill('radix-colors');
    await wait('(Number(document.querySelector("[role=slider][aria-label*=radix]")?.getAttribute("aria-valuenow")) > 0)');
    await toggleSkill('shadcn-ui');
    await wait('(Number(document.querySelector("[role=slider][aria-label*=shadcn]")?.getAttribute("aria-valuenow")) > 0)');
    await click('label:has(input[aria-label="启用 docs"])');
    await wait('document.querySelector("input[aria-label*=docs]").checked === true');
    assert.deepEqual(calls.at(-1).patch, { resources: { skills: [skill('a'), skill('b')], mcpServers: [mcp] } });
    const slider = skillSelector('mermaid');
    await evaluate(`document.querySelector(${JSON.stringify(slider)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
    await sleep(300);
    const controlBefore = await rect(slider);
    const gesturesBefore = calls.length;
    await dragSkill('mermaid', 0, 2, async () => {
      await wait('document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "on" && getComputedStyle(document.querySelector("[role=slider][aria-label*=mermaid] .wand-pi-skill-switch-lock")).opacity !== "0"');
      await check(`[${mode}] 滑到开档才出现小锁`, 'document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "on" && getComputedStyle(document.querySelector("[role=slider][aria-label*=mermaid] .wand-pi-skill-switch-lock")).opacity !== "0"');
      assert.equal(calls.length, gesturesBefore, 'passing the On detent must not save intermediate state');
    }, mode === '390px');
    await wait('document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "locked" && document.querySelector(".wand-pi-settings-feedback").dataset.phase === "saved"');
    assert.equal(calls.length, gesturesBefore + 1, 'one drag saves exactly once');
    assert.deepEqual(calls.at(-1).patch.lockedSkills, [skill('c')]);
    assert.deepEqual(await rect(slider), controlBefore, 'three detents have identical geometry');
    await check(`[${mode}] 三段拖动只提交最终锁定档且不误关面板`, '!!document.querySelector(".wand-pi-settings.is-open") && piHarness.state.sessions[0].piSettings.lockedSkills.length === 1');
    await evaluate(`document.querySelector(${JSON.stringify(slider)}).focus()`);
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowLeft',code:'ArrowLeft'});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowLeft',code:'ArrowLeft'});
    await wait('document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "on" && document.querySelector(".wand-pi-settings-feedback").dataset.phase === "saved"');
    assert.deepEqual(settings.a.lockedSkills, []);
    assert.ok(settings.a.resources.skills.includes(skill('c')));
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Home',code:'Home'});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Home',code:'Home'});
    await wait('document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "off" && document.querySelector(".wand-pi-settings-feedback").dataset.phase === "saved"');
    await check(`[${mode}] 左滑解锁保留开启再退到关闭`, '!piHarness.state.sessions[0].piSettings.resources.skills.includes(' + JSON.stringify(skill('c')) + ') && piHarness.state.sessions[0].piSettings.lockedSkills.length === 0');
    badLockAck = true;
    await chooseSkill('mermaid', 2);
    await wait('document.querySelector(".wand-pi-settings-feedback").textContent.includes("未确认 Skill 锁定")');
    await wait('document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "off"');
    await check(`[${mode}] 缺少锁定确认不伪造锁定`, 'document.querySelector("[role=slider][aria-label*=mermaid]").getAttribute("aria-valuenow") === "0"');
    badLockAck = false;
    await click('.composer-pi-settings-toggle'); await click('.composer-pi-settings-toggle'); await wait(ready);
    await wait('document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "locked"');
    await chooseSkill('mermaid', 0);
    await wait('document.querySelector("[role=slider][aria-label*=mermaid]").dataset.mode === "off" && document.querySelector(".wand-pi-settings-feedback").dataset.phase === "saved"');
    await check(`[${mode}] 三档设置重开持久化、关闭同时解锁`, 'piHarness.state.sessions[0].piSettings.lockedSkills.length === 0');
    await check(`[${mode}] 仅资源选择不改变通用工具`, 'piHarness.state.sessions[0].piSettings.globalTools === true && piHarness.state.sessions[0].piSettings.tools.length === 4 && document.getElementById("input-box").value === "保留我的草稿" && piHarness.composer.read("a").attachments.length === 1');
    await evaluate('(()=>{const n=document.querySelector("input[type=search]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(n,"radix");n.dispatchEvent(new Event("input",{bubbles:true}));n.focus()})()');
    await wait('document.querySelectorAll(".wand-pi-resource-item").length === 1');
    await check(`[${mode}] 搜索只筛展示不清选择`, 'piHarness.state.sessions[0].piSettings.resources.skills.length === 2');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await wait('document.querySelectorAll(".wand-pi-resource-item").length === 4');
    await check(`[${mode}] Escape 先清搜索保持面板`, '!!document.querySelector(".wand-pi-settings.is-open")');
    fail = true;
    await toggleSkill('radix-colors');
    await wait('document.querySelector(".wand-pi-settings-feedback").dataset.phase === "failed"');
    await check(`[${mode}] 保存失败保留真实选择且反馈原位`, '(Number(document.querySelector("[role=slider][aria-label*=radix]").getAttribute("aria-valuenow")) > 0) && document.querySelector(".wand-pi-settings-feedback").textContent.includes("原选择保持")'); fail = false;
    await draft('继续写，不收起');
    await check(`[${mode}] 继续写字不会收起`, '!!document.querySelector(".wand-pi-settings.is-open")');
    await click('.composer-pi-settings-toggle');
    await check(`[${mode}] 再点图标原位收起并归还焦点`, '!document.querySelector(".wand-pi-settings.is-open") && document.activeElement === document.querySelector(".composer-pi-settings-toggle")');
    await click('.composer-pi-settings-toggle'); await wait(ready);
    await click('#submit');
    await check(`[${mode}] 普通消息发送关闭面板但不被吞掉`, '!document.querySelector(".wand-pi-settings.is-open") && window.lastSubmitHandled === false && document.getElementById("input-box").value === "继续写，不收起"');
    await draft('/settings'); await wait(ready); await click('#submit');
    await check(`[${mode}] 设置命令不提交模型不清草稿附件`, 'window.lastSubmitHandled === true && piHarness.composer.read("a").text === "/settings" && piHarness.composer.read("a").attachments.length === 1');
    await click('#switch-pty'); await check(`[${mode}] PTY 没有入口`, '!document.querySelector(".composer-pi-settings-toggle")');
    await click('#switch-codex'); await check(`[${mode}] 其它工具没有入口`, '!document.querySelector(".composer-pi-settings-toggle")');
    await click('#switch-a'); await draft('/tools'); await wait(ready);
    await draft('ordinary'); loadDelay = 550; await draft('/settings');
    await wait('document.querySelector(".wand-pi-settings-feedback").dataset.phase === "loading"');
    loadDelay = 0; await click('#switch-b'); await draft('/'); await wait(ready); await sleep(650);
    await check(`[${mode}] 迟到读取不覆盖另一会话`, 'piHarness.state.selectedId === "b" && (Number(document.querySelector("[role=slider][aria-label*=radix]").getAttribute("aria-valuenow")) === 0)');
    await click('#switch-a'); await draft('/tools'); await wait(ready);
    saveDelay = 550; await toggleSkill('radix-colors');
    await wait('document.querySelector(".wand-pi-settings-feedback").dataset.phase === "saving"');
    await click('#switch-b'); await draft('/'); await wait(ready); await sleep(650); saveDelay = 0;
    await check(`[${mode}] 迟到保存不串会话`, 'piHarness.state.selectedId === "b" && !piHarness.state.sessions[1].piSettings && (Number(document.querySelector("[role=slider][aria-label*=radix]").getAttribute("aria-valuenow")) === 0)');
    await draft('normal'); legacy = true; await draft('/settings');
    await wait('document.querySelector(".wand-pi-settings-feedback").textContent.includes("更新服务端")');
    await check(`[${mode}] 旧服务端如实禁用而非假装生效`, 'document.querySelectorAll(".wand-pi-resource-item").length === 0'); legacy = false;
    await draft('normal'); await click('.composer-pi-settings-toggle'); await wait(ready);
    loadDelay = 550;
    await evaluate('piHarness.piSettingsController.dismiss(); piHarness.piSettingsController.toggle("b")');
    await wait('document.querySelector(".wand-pi-settings-feedback").dataset.phase === "loading"');
    await sleep(90); loadDelay = 0;
    settings.b = { ...defaults(), resources: { skills: [skill('b')], mcpServers: [] } };
    await evaluate('piHarness.piSettingsController.dismiss(); piHarness.piSettingsController.toggle("b")');
    await wait('(Number(document.querySelector("[role=slider][aria-label*=shadcn]")?.getAttribute("aria-valuenow")) > 0)'); await sleep(650);
    await check(`[${mode}] 同会话 ABA 重开不被迟到读取覆盖`, '(Number(document.querySelector("[role=slider][aria-label*=shadcn]").getAttribute("aria-valuenow")) > 0)');
    badAck = true;
    await toggleSkill('radix-colors');
    await wait('document.querySelector(".wand-pi-settings-feedback").textContent.includes("未确认")');
    await check(`[${mode}] 缺失确认不伪造已保存`, '(Number(document.querySelector("[role=slider][aria-label*=radix]").getAttribute("aria-valuenow")) === 0)');
    await click('.composer-pi-settings-toggle'); badAck = false; await click('.composer-pi-settings-toggle');
    await wait('(Number(document.querySelector("[role=slider][aria-label*=radix]")?.getAttribute("aria-valuenow")) > 0)');
    await check(`[${mode}] 重开核对未知回执的真实选择`, '(Number(document.querySelector("[role=slider][aria-label*=radix]").getAttribute("aria-valuenow")) > 0) && (Number(document.querySelector("[role=slider][aria-label*=shadcn]").getAttribute("aria-valuenow")) > 0)');
    await check(`[${mode}] 重开面板标题不被焦点滚动裁掉`, '(()=>{const p=document.querySelector(".wand-pi-settings-inner");const h=p.querySelector(".ant-card-head").getBoundingClientRect();return p.scrollTop===0 && h.top>=p.getBoundingClientRect().top})()');
    if (mode === 'reduced-motion') await check('reduce-motion 无位移动画', '(()=>{const nodes=[document.querySelector(".wand-pi-settings"),document.querySelector(".composer-pi-settings-toggle"),document.querySelector(".wand-pi-skill-switch .ant-segmented")];return nodes.every(n=>n && [getComputedStyle(n).transitionDuration,getComputedStyle(n).animationDuration].every(v=>v.split(",").every(d=>parseFloat(d)<=0.00002)))})()');
    await draft('发送后自动挑选图表技能');
    const manualBefore = structuredClone(settings.b.resources);
    const toggleSelector = '[role="switch"][aria-label="按提示词自动配置"]';
    await settle(toggleSelector);
    await check(`[${mode}] 自动选择默认关闭、没有发送前推荐按钮`, 'document.querySelector("[role=switch]").getAttribute("aria-checked") === "false" && !document.querySelector(".wand-pi-recommendation")');
    await click(toggleSelector);
    await wait('document.querySelector("[role=switch]").getAttribute("aria-checked") === "true"');
    await check(`[${mode}] 开启自动选择保留手选和草稿`, '(Number(document.querySelector("[role=slider][aria-label*=radix]").getAttribute("aria-valuenow")) > 0) && (Number(document.querySelector("[role=slider][aria-label*=shadcn]").getAttribute("aria-valuenow")) > 0) && document.getElementById("input-box").value === "发送后自动挑选图表技能"');
    assert.deepEqual(calls.at(-1).patch, { autoResources: true });
    await check(`[${mode}] CodeMode 跟随项明确显示自动判断`, 'document.querySelector(".wand-ui-select-value").textContent.includes("按提示词自动判断")');
    assert.deepEqual(settings.b.resources, manualBefore);
    assert.equal(recommendationCalls.length, 0, 'settings do not run prompt matching');
    await click('#submit');
    await check(`[${mode}] 发送无需先等待推荐`, '!document.querySelector(".wand-pi-settings.is-open") && window.lastSubmitHandled === false');
    assert.equal(recommendationCalls.length, 0, 'ordinary submit never starts a preflight recommendation');
    await click('.composer-pi-settings-toggle'); await wait(ready);
    await check(`[${mode}] 自动选择开关重开后保持`, 'document.querySelector("[role=switch]").getAttribute("aria-checked") === "true"');
    await settle(toggleSelector);
    fail = true;
    await click(toggleSelector);
    await wait('document.querySelector(".wand-pi-settings-feedback").dataset.phase === "failed"');
    await check(`[${mode}] 开关保存失败保留真实启用态`, 'document.querySelector("[role=switch]").getAttribute("aria-checked") === "true"');
    fail = false;
    await click(toggleSelector);
    await wait('document.querySelector("[role=switch]").getAttribute("aria-checked") === "false"');
    await check(`[${mode}] 关闭自动选择保留手选`, '(Number(document.querySelector("[role=slider][aria-label*=radix]").getAttribute("aria-valuenow")) > 0) && (Number(document.querySelector("[role=slider][aria-label*=shadcn]").getAttribute("aria-valuenow")) > 0)');
    assert.deepEqual(settings.b.resources, manualBefore);
    if (process.env.WAND_RESOURCE_SHOTS_DIR) {
      mkdirSync(process.env.WAND_RESOURCE_SHOTS_DIR, { recursive: true });
      const image = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.WAND_RESOURCE_SHOTS_DIR, `panel-${mode}.png`), Buffer.from(image.data, 'base64'));
    }
  }
  console.log(`Pi slash/settings browser checks passed: ${count}`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { const stopped = once(chrome, 'exit'); chrome.kill(); await stopped; }
  await new Promise(r => server.close(r));
  rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
