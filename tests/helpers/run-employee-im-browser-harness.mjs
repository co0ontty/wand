// Real Chrome/production settings components, loopback fixtures only; never calls an IM service/model.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, stop } from "esbuild";
import { closeBrowserFixture, openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";
const root = resolve(import.meta.dirname, "../.."), output = join(root, "output/architecture-stage2/employee-im-browser");
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wand-im-browser-"));
const empty = () => ({ events: [], telegram: { enabled: false, chatId: "", botTokenConfigured: false }, dingtalk: { enabled: false, webhookConfigured: false, secretConfigured: false } });
const configs = { one: empty(), two: empty() }, writes = [], tests = [];
let failSave = false, releaseSave = null, holdSave = false;
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
 import * as React from 'react'; import {createRoot} from 'react-dom/client';
 import {EmployeeImEditor} from './src/web-ui/react/agents/employee-im-editor';
 import {WandUiProvider} from './src/web-ui/react/theme'; import {installReactUiStyles} from './src/web-ui/react/styles';
 installReactUiStyles();function App(){const[id,setId]=React.useState('one'),[dirty,setDirty]=React.useState(false),[busy,setBusy]=React.useState(false);
 window.imFixture={switch:setId};return <><header style={{display:'none'}}><span id='employee'>{id}</span><span id='dirty'>{String(dirty)}</span><span id='busy'>{String(busy)}</span></header><main style={{maxWidth:940,margin:'auto',padding:16}}><EmployeeImEditor key={id} employeeId={id} onDirtyChange={setDirty} onBusyChange={setBusy}/></main></>}
 createRoot(document.getElementById('root')).render(<WandUiProvider><App/></WandUiProvider>);
 ` }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture.invalid").pathname;
  const send = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const match = path.match(/^\/api\/silicon-employees\/(one|two)\/im(\/test)?$/);
  if (match) {
    const id = match[1]; let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === "GET") return send(configs[id]);
    if (match[2]) { tests.push({ id, ...body }); return send({ ok: true }); }
    writes.push({ id, body });
    if (holdSave) await new Promise(resolve => { releaseSave = resolve; });
    if (failSave) return send({ error: "模拟保存失败" }, 503);
    const next = structuredClone(body), previous = configs[id];
    for (const [provider, fields] of [["telegram", ["botToken"]], ["dingtalk", ["webhook", "secret"]]]) for (const field of fields) {
      const value = next[provider][field]; next[provider][field + "Configured"] = value === null ? false : value ? true : previous[provider][field + "Configured"];
      delete next[provider][field];
    }
    configs[id] = next; return send(next);
  }
  if (path === "/app.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(readFileSync(join(temp, "app.js"))); }
  if (path === "/styles.css") { res.setHeader("Content-Type", "text/css"); return res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
  res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body style="margin:0"><div id="root" data-wand-ui-root></div><script src="/app.js"></script></body></html>');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const browser = await openPlushBrowser(1280, 1000), e = browser.evaluate;
const button = async text => {
  await browser.wait(`[...document.querySelectorAll('button')].some(n=>n.innerText.trim()===${JSON.stringify(text)}&&!n.disabled)`);
  const selector = await e(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.innerText.trim()===${JSON.stringify(text)});if(!n)throw Error('button missing');n.dataset.imTarget='yes';return '[data-im-target=yes]'})()`);
  await browser.click(selector); await e("document.querySelector('[data-im-target]')?.removeAttribute('data-im-target')");
};
const label = async text => {
  const selector = await e(`(()=>{const n=[...document.querySelectorAll('label')].find(n=>(n.innerText.trim()===${JSON.stringify(text)}||n.querySelector('input')?.getAttribute('aria-label')===${JSON.stringify(text)}));if(!n)throw Error('label missing');n.dataset.imTarget='yes';return '[data-im-target=yes]'})()`);
  await browser.click(selector); await e("document.querySelector('[data-im-target]')?.removeAttribute('data-im-target')");
};
const fill = async (selector, text) => { await browser.click(selector); await e(`document.querySelector(${JSON.stringify(selector)}).select()`); await browser.send("Input.insertText", { text }); await browser.settle(); };
const id = suffix => `#employee-im-one-${suffix}`;
try {
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await browser.wait("!!document.querySelector('.employee-im-events')");
  assert.equal(await e("!!document.querySelector('#employee-im-one-chat-id')"), false);
  assert.equal(await e("[...document.querySelectorAll('input[type=checkbox]')].length"), 6);
  for (const width of [1280, 390]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.settle(); assert.equal(await e("document.documentElement.scrollWidth>innerWidth"), false);
    await browser.screenshot(join(output, `employee-im-default-${width}.png`));
  }
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const headingY = await e("document.querySelector('.employee-im-heading').getBoundingClientRect().y+scrollY");
  await browser.click('.employee-im-channel-telegram .ant-collapse-header');
  await browser.wait("!!document.querySelector('#employee-im-one-chat-id')");
  assert.equal(await e("document.querySelector('.employee-im-heading').getBoundingClientRect().y+scrollY"), headingY);
  assert.equal(writes.length, 0); assert.equal(tests.length, 0);
  await fill(id("telegram-botToken"), `123456:${"x".repeat(30)}`); await fill(id("chat-id"), "-1234");
  await label("开始处理任务"); await label("任务完成");
  await browser.click('.employee-im-more .ant-collapse-header');
  await browser.wait("[...document.querySelectorAll('input[type=checkbox]')].length===13");
  await label("步骤完成");
  await browser.click('.employee-im-more .ant-collapse-header');
  await browser.wait("document.querySelector('.employee-im-more [role=button]').getAttribute('aria-expanded')==='false'");
  assert.equal(await e("document.querySelector('.employee-im-more .ant-collapse-extra').textContent"), "1 项已选");
  assert.equal(await e("document.querySelector('#dirty').textContent"), "true");
  assert.equal(await e("document.querySelector('[aria-label=\"发送Telegram测试消息\"]').disabled"), true);
  await button("保存"); await browser.wait("document.querySelector('#dirty').textContent==='false'");
  assert.equal(writes.length, 1); assert.equal(writes[0].body.events.join(","), "task_started,task_completed,step_completed");
  assert.equal(await e(`document.querySelector('${id("telegram-botToken")}').value`), "");
  await browser.click('[aria-label="发送Telegram测试消息"]'); await browser.wait("document.querySelector('#busy').textContent==='false'"); assert.deepEqual(tests, [{ id: "one", provider: "telegram" }]);
  // Saving errors retain input and have no credential echo from GET.
  await browser.click('.employee-im-channel-dingtalk .ant-collapse-header');
  await browser.wait("!!document.querySelector('#employee-im-one-dingtalk-webhook')");
  await fill(id("dingtalk-webhook"), "https://oapi.dingtalk.com/robot/send?access_token=fixture_only");
  failSave = true; await button("保存"); await browser.wait("!!document.querySelector('.ant-alert-error')");
  assert.equal(await e(`document.querySelector('${id("dingtalk-webhook")}').value.includes('fixture_only')`), true);
  assert.equal(await e("document.querySelector('#dirty').textContent"), "true");
  failSave = false;
  await button("撤销"); await browser.wait("document.querySelector('#dirty').textContent==='false'");
  await browser.click('.employee-im-channel-telegram .ant-collapse-header');
  await browser.wait("document.querySelector('#employee-im-one-telegram-botToken')?.checkVisibility?.({visibilityProperty:true})");
  await label("清除已保存的Bot Token");
  assert.equal(await e(`document.querySelector('${id("telegram-botToken")}').disabled`), true);
  // A late acknowledgement for a previous employee must not erase another employee's draft.
  await fill(id("chat-id"), "7"); holdSave = true;
  // Wait for the previous action's success flash before pressing its stable button again.
  await browser.wait("[...document.querySelectorAll('button')].some(n=>n.innerText.trim()==='保存'&&!n.disabled)");
  await button("保存");
  await browser.wait("document.querySelector('#busy').textContent==='true'");
  await e("imFixture.switch('two')"); await browser.wait("document.querySelector('#employee').textContent==='two'&&!!document.querySelector('.employee-im-channel-telegram')");
  await browser.click('[aria-label="启用 Telegram 通知"]'); await browser.wait("!!document.querySelector('#employee-im-two-chat-id')");
  await browser.wait("document.activeElement?.id==='employee-im-two-telegram-botToken'");
  await fill("#employee-im-two-chat-id", "999"); releaseSave(); holdSave = false;
  await browser.settle(); assert.equal(await e("document.querySelector('#employee-im-two-chat-id').value"), "999");
  await e("window.__imOriginalInput=document.querySelector('#employee-im-two-chat-id');true");
  await browser.key('Escape');
  await browser.wait("document.querySelector('.employee-im-channel-telegram [role=button]').getAttribute('aria-expanded')==='false'");
  assert.equal(await e("document.querySelector('#employee-im-two-chat-id').value"), '999');
  await browser.key('Enter');
  await browser.wait("document.querySelector('.employee-im-channel-telegram [role=button]').getAttribute('aria-expanded')==='true'");
  assert.equal(await e("window.__imOriginalInput===document.querySelector('#employee-im-two-chat-id')"), true);
  assert.equal(await e("[...document.querySelectorAll('.employee-im-events .ant-checkbox-wrapper')].every(n=>{const r=n.getBoundingClientRect();return r.width>=44&&r.height>=44})"), true);
  assert.equal(writes.at(-1).body.telegram.botToken, null);
  for (const width of [1280, 390]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); await browser.settle();
    assert.equal(await e("document.documentElement.scrollWidth>innerWidth"), false);
    await browser.screenshot(join(output, `employee-im-${width}.png`));
  }
  assert.deepEqual(browser.errors, []);
  writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, fixtureOnly: true, writes: writes.length, testMessages: tests.length, realProviderCalls: 0, widths: [1280, 390], cases: ["opt-in", "shared-events", "progressive-disclosure", "hidden-selection-count", "selected-events", "masked-credentials", "saved-only-test", "failed-save-preserves-input", "explicit-clear", "late-ack-isolation", "inline-disclosure", "escape-and-enter", "input-instance-preserved", "44px-event-targets", "narrow-layout", "reduced-motion"] }, null, 2));
  console.log("Employee IM browser fixture passed (no real IM/model calls)");
} finally { releaseSave?.(); await closeBrowserFixture(browser, server, () => { stop(); rmSync(temp, { recursive: true, force: true }); }); }
