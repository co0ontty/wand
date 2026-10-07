// Development UI validation only. Does not replace acceptance against the installed Wand service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'output/model-groups-browser');
mkdirSync(output, { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, 'model-groups-browser-harness.tsx')], bundle: true,
  platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(output, 'app.js'),
  define: { 'process.env.NODE_ENV': '"production"' } });
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(join(output, 'app.js'))); }
  else if (req.url === '/styles.css' || req.url === '/tailwind.css') {
    res.setHeader('Content-Type', 'text/css'); res.end(readFileSync(join(root, 'src/web-ui/content', req.url.slice(1))));
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tailwind.css"><body><main id="root" data-wand-ui-root style="max-width:760px;margin:auto;padding:16px"></main><div data-wand-ui-root id="wand-react-ui-portals"></div><script src="/app.js"></script></body></html>');
  }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chrome, socket;
try {
  const profile = join(output, `profile-${Date.now()}`);
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu',
    '--no-first-run', '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let n = 0; n < 100 && !existsSync(portFile); n++) await sleep(50);
  assert.ok(existsSync(portFile), 'Chrome CDP required');
  const tabs = await (await fetch(`http://127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}/json`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl); await once(socket, 'open');
  let id = 0; const pending = new Map(); const exceptions = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    const call = pending.get(message.id); if (!call) return;
    pending.delete(message.id); message.error ? call.reject(Error('CDP error')) : call.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const data = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (data.exceptionDetails) throw Error(JSON.stringify(data.exceptionDetails));
    return data.result.value;
  };
  const wait = async (expression) => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await sleep(50); }
    throw Error(`condition missing: ${expression}`);
  };
  const click = async (selector) => {
    const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('invalid target');n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await sleep(320);
  };
  const clickText = async (text) => {
    const selector = await evaluate(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('missing button');n.setAttribute('data-test-target','yes');return'button[data-test-target="yes"]'})()`);
    await click(selector); await evaluate("document.querySelectorAll('[data-test-target]').forEach(n=>n.removeAttribute('data-test-target'))");
  };
  await send('Runtime.enable'); await send('Page.enable');
  for (const [mode, width, reduced] of [['desktop', 1280, false], ['mobile', 390, false], ['reduced', 390, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
    await send('Page.navigate', { url: origin });
    await wait('!!document.querySelector(".wand-model-group-heading")');
    assert.equal(await evaluate('document.querySelector(".wand-model-group-disclosure").inert'), true);
    const box = () => evaluate('(()=>{const r=document.querySelector(".wand-model-group-heading").getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()');
    const before = await box();
    await click('.wand-model-group-heading'); const after = await box();
    assert.ok(Object.keys(before).every((key) => Math.abs(before[key] - after[key]) < 1), 'trigger stays in place');
    assert.equal(await evaluate('document.querySelector(".wand-model-group-disclosure").inert'), false);
    await click('button[aria-label="上移模型 2"]');
    assert.match(await evaluate('document.querySelector(".wand-model-group-members li:first-child").textContent'), /备用模型/);
    await evaluate('window.scrollTo(0,0)');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(output, `${mode}.png`), Buffer.from(shot.data, 'base64'));
    await clickText('保存模型分组');
    await wait('window.groupHarness.saves === 1 && document.body.textContent.includes("顺序已保存")');
    assert.deepEqual(await evaluate('window.groupHarness.orders[0]'), ['second', 'first']);
    await evaluate('window.groupHarness.mode = "conflict"');
    await click('button[aria-label="上移模型 2"]');
    await wait('[...document.querySelectorAll("button")].some(n=>n.textContent.trim()==="保存模型分组" && !n.disabled)');
    await clickText('保存模型分组');
    await wait('document.body.textContent.includes("其他设备修改")');
    assert.match(await evaluate('document.querySelector(".wand-model-group-members li:first-child").textContent'), /首选模型/);
    assert.equal(await evaluate('window.groupHarness.saves'), 2, 'no blind retry after conflict');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'narrow-screen no horizontal overflow');
    await click('.wand-model-group-heading');
    assert.equal(await evaluate('document.querySelector(".wand-model-group-disclosure").inert'), true);
    console.log(`✔ ${mode}: collapse/expand, stable trigger, order, save, conflict/draft, narrow layout, inert`);
  }
  assert.deepEqual(exceptions, []);
  console.log('✔ production editor browser checks passed (development fixtures, not installed-service acceptance)');
} finally {
  socket?.close(); chrome?.kill('SIGTERM'); await new Promise((resolve) => server.close(resolve));
}
