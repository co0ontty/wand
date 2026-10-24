// Real production React component; explicit loopback API doubles only. No DingTalk login, write or model.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";
const root = resolve(import.meta.dirname, "../.."), output = join(root, "output/architecture-stage2/dingtalk-implementation/browser"); mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wand-dingtalk-ui-"));
const employees = [1, 2].map(n => ({ id: `e_ui_${n}`, name: `测试员工${n}`, duty: "接口替身，非真实员工", avatar: "", tags: [], agents: [{ provider: "pi", engine: "sdk", kind: "structured", model: "fixture-model", thinkingEffort: "off", mode: "full-access" }], updatedAt: "fixture" }));
const choices = [{ id: "external-a", name: "群 A", memberCount: 10 }, { id: "external-b", name: "群 B", memberCount: 20 }];
let bindings = [{ id: "binding-a-1", groupId: "local-a", employeeId: "e_ui_1", robotId: "robot-1", state: "ready", allowedUsers: ["owner"], updatedAt: "fixture" }];
let groups = [{ id: "local-a", accountId: "corp:owner", corpId: "corp", externalId: "external-a", name: "群 A", conversationId: "dingtalk_a", syncState: "live", historyComplete: false, updatedAt: "fixture" }];
const writes = [], plans = new Map();
let installed = false, installRequests = 0, releaseInstall, onInstallRequested;
const status = () => ({ installed, diagnostic: installed ? undefined : 'DWS 不可用，请先安装连接器依赖。', accounts: installed ? [{ id: "corp:owner", corpId: "corp", userId: "owner", name: "接口测试账号", corpName: "接口替身组织" }] : [], groups, bindings, robots: [], jobs: [] });
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
 import * as React from 'react';import {createRoot} from 'react-dom/client';
 import {DingTalkSettingsPanel} from './src/web-ui/react/settings/dingtalk-panel';
 import {WandUiProvider} from './src/web-ui/react/theme';import {installReactUiStyles} from './src/web-ui/react/styles';
 installReactUiStyles();createRoot(document.getElementById('root')).render(<WandUiProvider><main style={{maxWidth:940,padding:16,margin:0}}><DingTalkSettingsPanel admin/></main></WandUiProvider>);
 ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture.invalid").pathname;
  const send = (data, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  let raw = ""; for await (const part of req) raw += part; const body = raw ? JSON.parse(raw) : {};
  if (path === "/api/silicon-employees") return send({ employees });
  if (path === "/api/connectors/dingtalk") return send(status());
  if (path === '/api/connectors/dingtalk/install') {
    assert.equal(req.method, 'POST'); writes.push({ path, body }); const attempt = ++installRequests;
    const gate = new Promise(resolve => { releaseInstall = resolve; }); onInstallRequested?.(); await gate;
    if (attempt === 1) return send({ error: '安装测试失败，请重试（接口替身）' }, 503);
    installed = attempt >= 3; return send({ installed: true });
  }
  if (path === "/api/connectors/dingtalk/groups") return send({ groups: choices, nextCursor: "", complete: true });
  if (path === "/api/connectors/dingtalk/plans") {
    writes.push({ path, body });
    const pairs = body.groupIds.flatMap(groupId => body.employeeIds.map(employeeId => ({ groupId, employeeId, existing: groupId === "external-a" && employeeId === "e_ui_1" }))).filter(p => !body.excluded.includes(`${p.groupId}:${p.employeeId}`));
    const plan = { ...body, id: `plan-${plans.size}`, expiresAt: new Date(Date.now() + 600000).toISOString(), groups: choices.filter(g => body.groupIds.includes(g.id)), employees: employees.filter(e => body.employeeIds.includes(e.id)).map(e => ({ ...e, robotName: e.name, appName: `wand-${e.id}`, agent: typeof body.candidateIndices?.[e.id] === 'number' ? e.agents[body.candidateIndices[e.id]] : undefined })), pairs, newRobots: 1, warning: "接口替身：仅当前授权人可触发，按员工已配置权限执行；不会真实建号。" };
    plans.set(plan.id, plan); return send(plan);
  }
  if (path === "/api/connectors/dingtalk/connections") {
    writes.push({ path, body }); const plan = plans.get(body.planId); assert.ok(plan); assert.equal(body.confirmed, true);
    for (const p of plan.pairs.filter(p => !p.existing)) {
      let group = groups.find(g => g.externalId === p.groupId);
      if (!group) { group = { ...groups[0], id: "local-b", externalId: p.groupId, name: "群 B", conversationId: "dingtalk_b" }; groups.push(group); }
      bindings.push({ id: `binding-${p.groupId}-${p.employeeId}`, groupId: group.id, employeeId: p.employeeId, robotId: "fixture-robot", fixedAgent: plan.employees.find(e=>e.id===p.employeeId)?.agent, state: "verifying", allowedUsers: ["owner"], updatedAt: "fixture" });
    }
    return send({ id: "fixture-job", state: "done" });
  }
  if (path.startsWith("/api/connectors/dingtalk/bindings/")) {
    writes.push({ path, body }); const id = path.split("/")[5]; const b = bindings.find(b => b.id === id); assert.ok(b);
    if (path.endsWith("/remove")) { assert.equal(body.confirmed, true); bindings = bindings.filter(x => x.id !== id); }
    else { if ("candidateIndex" in body) b.fixedAgent = body.candidateIndex === null ? undefined : employees.find(e=>e.id===b.employeeId).agents[body.candidateIndex]; if ("paused" in body) b.state = body.paused ? "paused" : "verifying"; if ("allowGroupMembers" in body) b.allowedUsers = body.allowGroupMembers ? ["*"] : ["owner"]; }
    return send(b);
  }
  if (path === "/app.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(readFileSync(join(temp, "app.js"))); }
  if (path === "/styles.css") { res.setHeader("Content-Type", "text/css"); return res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
  if (path.startsWith("/api/")) return send({ error: `unhandled fixture ${path}` }, 404);
  res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body style="overflow:auto;height:auto"><div id="root" data-wand-ui-root></div><script src="/app.js"></script></body></html>');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const browser = await openPlushBrowser(1280, 1000), e = browser.evaluate, cases = [];
const click = async selector => {
  await browser.wait(`!!document.querySelector(${JSON.stringify(selector)})`);
  await e(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center',behavior:'instant'})`);
  await browser.wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const c=n.matches('input,button')?n:n.querySelector('input,button');if(c?.disabled)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
  await browser.click(selector);
};
const clickLabel = async text => {
  await browser.wait(`[...document.querySelectorAll('button')].some(n=>n.innerText.replace(${/\s/g},'')===${JSON.stringify(text.replace(/\s/g, ""))}&&!n.disabled&&n.getClientRects().length)`);
  const selector = await e(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.innerText.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ""))}&&!n.disabled&&n.getClientRects().length);if(!n)throw Error('missing button: '+${JSON.stringify(text)});n.dataset.dingTest='target';return '[data-ding-test=target]'})()`);
  await click(selector); await e("document.querySelector('[data-ding-test=target]')?.removeAttribute('data-ding-test')");
};
const choose = async (label, query, title) => {
  await browser.wait(`(()=>{const n=document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});return !!n&&!n.disabled&&n.getBoundingClientRect().width>0})()`);
  const trigger = await e(`(()=>{const n=document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).closest('.ant-select');n.dataset.dingTest='select';return '[data-ding-test=select]'})()`);
  await click(trigger); await e("document.querySelector('[data-ding-test=select]')?.removeAttribute('data-ding-test')"); await browser.send("Input.insertText", { text: query });
  await browser.wait(`!!document.querySelector('.ant-select-item-option[title=${JSON.stringify(title)}]')`);
  await click(`.ant-select-item-option[title="${title}"]`); await browser.key("Escape");
};
try {
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await browser.wait("[...document.querySelectorAll('button')].some(n=>n.innerText.replace(/\\s/g,'')==='安装DWS'&&!n.disabled)");
  assert.equal(installRequests, 0); assert.equal(await e("document.body.innerText.includes('DWS 不可用，请先安装连接器依赖。')"), false);
  assert.equal(await e("[...document.querySelectorAll('button')].some(n=>n.innerText.includes('授权钉钉'))"), false);
  const installBox = await e("(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.innerText.replace(/\\s/g,'')==='安装DWS');n.dataset.dingInstall='trigger';const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()");
  await browser.screenshot(join(output, 'production-install-default.png'));
  const firstInstall = new Promise(resolve => { onInstallRequested = resolve; }); await clickLabel('安装 DWS'); await firstInstall;
  assert.equal(installRequests, 1); assert.equal(await e("document.querySelector('[data-ding-install=trigger]').getAttribute('aria-busy')"), 'true');
  await browser.screenshot(join(output, 'production-install-pending.png'));
  releaseInstall(); await browser.wait("document.body.innerText.includes('安装测试失败')");
  await browser.screenshot(join(output, 'production-install-retry.png'));
  assert.deepEqual(await e("(()=>{const r=document.querySelector('[data-ding-install=trigger]').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()"), installBox);
  const retryInstall = new Promise(resolve => { onInstallRequested = resolve; }); await clickLabel('重试安装'); await retryInstall;
  assert.equal(installRequests, 2); releaseInstall();
  await browser.wait("document.body.innerText.includes('安装后 DWS 仍不可用')");
  assert.equal(await e("document.querySelector('[data-ding-install=trigger]').disabled"), false);
  const verifiedInstall = new Promise(resolve => { onInstallRequested = resolve; }); await clickLabel('重试安装'); await verifiedInstall;
  assert.equal(installRequests, 3); releaseInstall();
  await browser.wait("document.body.textContent.includes('接口替身组织') && !!document.querySelector('[aria-label=" + JSON.stringify("钉钉授权账号") + "]')");
  assert.deepEqual(await e("(()=>{const r=document.querySelector('[data-ding-install=trigger]').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()"), installBox);
  assert.equal(await e("document.querySelector('[data-ding-install=trigger]').disabled"), true);
  cases.push('default page load never installs DWS; only an explicit click posts installation');
  cases.push('installation failure is retryable and verified success retains the same button position and instance');
  cases.push('a successful install response without a usable binary is not presented as installation success');
  await clickLabel("接入群聊");
  await choose("选择钉钉群", "群 A", "群 A · 10人"); await choose("选择钉钉群", "群 B", "群 B · 20人");
  await choose("选择钉钉应答员工", "测试员工1", "测试员工1"); await choose("选择钉钉应答员工", "测试员工2", "测试员工2");
  await click('[aria-label="钉钉初始Agent-e_ui_1"]');
  await browser.wait("[...document.querySelectorAll('[role=option]')].some(n=>n.textContent.includes('候选 1 · Wand Agent'))");
  const initialOption = await e("(()=>{const n=[...document.querySelectorAll('[role=option]')].find(n=>n.textContent.includes('候选 1 · Wand Agent'));n.dataset.dingTest='initial-option';return '[data-ding-test=initial-option]'})()");
  await click(initialOption);
  await browser.wait("[...document.querySelectorAll('button')].some(n=>n.textContent.includes('核对接入范围')&&!n.disabled)");
  await e("[...document.querySelectorAll('button')].find(n=>n.textContent.includes('核对接入范围')).scrollIntoView({block:'center',behavior:'instant'})"); await browser.settle();
  const before = await e("(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.includes('核对接入范围'));const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()");
  await clickLabel("核对接入范围");
  await browser.wait("document.body.textContent.includes('新增 3 项绑定')");
  const after = await e("(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.includes('自动创建并接入'));const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()");
  assert.deepEqual(after, before); cases.push("production multi-select Portal clicks keep setup open; confirmation button stays in place");
  await browser.screenshot(join(output, "production-plan-desktop.png"));
  const checkbox = await e("(()=>{const n=[...document.querySelectorAll('label.ant-checkbox-wrapper')].find(n=>n.textContent.includes('群 B')&&n.textContent.includes('测试员工2'));n.dataset.dingTest='exclude';return '[data-ding-test=exclude]'})()");
  await click(checkbox); await browser.wait("document.body.textContent.includes('组合已修改')");
  assert.equal(writes.filter(w => w.path.endsWith("/connections")).length, 0);
  await clickLabel("重新核对接入范围"); await browser.wait("document.body.textContent.includes('新增 2 项绑定')");
  await clickLabel("自动创建并接入"); await browser.wait("document.body.textContent.includes('接入任务已接受')");
  await clickLabel("收起接入配置");
  assert.equal(writes.filter(w => w.path.endsWith('/plans'))[0].body.candidateIndices.e_ui_1, 0);
  assert.equal(bindings.find(b=>b.id==='binding-a-1').fixedAgent, undefined, 'initial candidate choice does not overwrite an existing binding');
  assert.equal(writes.filter(w => w.path.endsWith("/connections")).length, 1); cases.push("combination exclusion forces fresh server plan before exactly one connection submission");
  assert.equal(await e("document.body.textContent.includes('待审批')"), false);
  const header = await e("(()=>{const n=[...document.querySelectorAll('.ant-collapse-header')].find(n=>n.innerText.includes('群 A')&&n.getClientRects().length);n.dataset.dingTest='group';return '[data-ding-test=group]'})()");
  await click(header);
  await browser.wait("[...document.querySelectorAll('.ant-collapse-header')].some(n=>n.innerText.includes('跟随员工配置')&&n.getClientRects().length)");
  const settings = await e("(()=>{const n=[...document.querySelectorAll('.ant-collapse-header')].find(n=>n.innerText.includes('跟随员工配置')&&n.getClientRects().length);n.dataset.dingTest='binding';return '[data-ding-test=binding]'})()");
  await click(settings);
  await browser.wait("[...document.querySelectorAll('label.ant-checkbox-wrapper')].some(n=>n.innerText.includes('允许本群同组织成员'))");
  const policy = await e("(()=>{const n=[...document.querySelectorAll('label.ant-checkbox-wrapper')].find(n=>n.innerText.includes('允许本群同组织成员'));n.dataset.dingTest='policy';return '[data-ding-test=policy]'})()");
  await click(policy);
  assert.equal(writes.some(w=>w.path.includes('/bindings/')), false, 'a checkbox alone does not expand authority');
  await clickLabel('应用此群使用范围');
  await browser.wait("document.body.textContent.includes('目前本群同组织成员可触发')");
  assert.equal(bindings.find(b=>b.id==='binding-a-1').allowedUsers[0], '*');
  cases.push('group-member access requires an explicit apply; no model or DingTalk operation is implied');
  const candidate = await e("(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.innerText.includes('固定候选 1')&&n.getClientRects().length);n.dataset.dingTest='candidate';return '[data-ding-test=candidate]'})()");
  await click(candidate);
  await browser.wait("document.body.textContent.includes('本群固定：Wand Agent')");
  assert.equal(bindings.find(b=>b.id==='binding-a-1').fixedAgent.engine, 'sdk');
  await clickLabel('暂停新输入');
  await browser.wait("document.body.textContent.includes('已暂停')");
  assert.equal(bindings.find(b=>b.id==='binding-a-1').state, 'paused');
  await clickLabel('移除此绑定'); await browser.wait("document.body.textContent.includes('不删除共享机器人')");
  await clickLabel('取消');
  assert.equal(writes.some(w=>w.path.endsWith('/remove')), false);
  cases.push('per-binding Agent changes and pause preserve other bindings; removal cancellation sends no delete');
  for (const width of [390, 320]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false }); await browser.settle();
    assert.equal(await e("document.documentElement.scrollWidth>innerWidth"), false);
    await browser.screenshot(join(output, `production-groups-${width}.png`)); cases.push(`${width}px production connector no page overflow`);
  }
  await e("history.replaceState(null,'','/settings/')"); await clickLabel('打开群聊');
  await browser.wait("location.pathname==='/'&&new URLSearchParams(location.search).get('conversation')==='dingtalk_a'");
  cases.push('standalone settings with trailing slash opens the canonical chat route, not another settings page');
  assert.deepEqual(browser.errors, []);
  const remote = browser.events.filter(v => v.method === "Network.requestWillBeSent").map(v => v.params.request.url).filter(url => /^https?:/.test(url) && !url.startsWith(`http://127.0.0.1:${server.address().port}`));
  assert.deepEqual(remote, []);
  const report = { productionComponents: true, fixtureApiOnly: true, cases, writes, errors: browser.errors, realDependencyInstallations: 0, realDingTalkRequests: 0, modelCalls: 0 };
  writeFileSync(join(output, "browser-report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ cases, errorCount: browser.errors.length, fixtureWrites: writes.length, realDingTalkRequests: 0 }));
} catch (error) { await browser.screenshot(join(output, "failure.png")); throw error; }
finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
