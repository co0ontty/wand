// Deferred ambient avatar initialization. Loopback fixture only; no service/model calls.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, stop } from 'esbuild';
import { openPlushBrowser } from './run-plush-avatar-browser-harness.mjs';

const root = resolve(import.meta.dirname, '../..'), output = join(root, 'output/plush-avatar');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'wand-plush-defer-'));
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const result = { fixtureOnly: true, cases: [], runtimeRequests: [], browserErrors: [] };
let activeScenario = '';
const holds = new Map();

await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
 import * as React from 'react';import {createRoot} from 'react-dom/client';
 import {PlushAvatar} from './src/web-ui/react/avatars/plush-avatar';
 const scenario=new URL(location.href).searchParams.get('scenario');
 const config={version:1,shape:'heart',color:'coral',glasses:'none',hat:'none'};
 const controls={setCount:null,unmount:null};window.deferFixture=controls;
 function App(){const[count,setCount]=React.useState(scenario==='switch'?6:1);
  controls.setCount=n=>setCount(n);controls.unmount=()=>setCount(0);
  return <div id='avatar-host' style={{padding:20}}>{scenario==='offscreen'?<div style={{height:2400}}/>:null}
   {Array.from({length:count},(_,n)=><PlushAvatar key={n} config={config} size={48} interactive={scenario==='interactive'}/>)}</div>}
 createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(temp, 'app.js'), define: { 'process.env.NODE_ENV': '"production"' } });
await build({ entryPoints: [join(root, 'src/web-ui/react/avatars/renderer.ts')], bundle: true, platform: 'browser', format: 'iife', minify: true, outfile: join(temp, 'runtime.js') });
const app = readFileSync(join(temp, 'app.js'), 'utf8').replaceAll('${plushAvatarChunkSrc}', '/assets/plush-avatar.js');
const runtime = readFileSync(join(temp, 'runtime.js'));
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid'), path = url.pathname;
  if (path.startsWith('/api/')) { response.writeHead(403); response.end('fixture blocks business API'); return; }
  if (path === '/app.js') { response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(app); return; }
  if (path === '/assets/plush-avatar.js') {
    result.runtimeRequests.push({ at: Date.now(), scenario: activeScenario });
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(runtime); return;
  }
  if (path === '/hold.png') {
    const scenario = url.searchParams.get('scenario') || '';
    (holds.get(scenario) ?? Promise.resolve()).then(() => { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); });
    return;
  }
  const scenario = url.searchParams.get('scenario') || '';
  response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html><meta name='viewport' content='width=device-width,initial-scale=1'><body><div id='root'></div><img id="hold" src="/hold.png?scenario=${scenario}" alt=""><script src='/app.js?scenario=${scenario}'></script></body></html>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browsers = [];
const open = async scenario => {
  activeScenario = scenario;
  let release = () => {};
  holds.set(scenario, new Promise(resolveHold => { release = resolveHold; }));
  const browser = await openPlushBrowser(960, 900, false, 'no-preference');
  browsers.push(browser); result.browserErrors.push(browser.errors);
  await browser.send('Page.navigate', { url: `${origin}/?scenario=${scenario}` });
  await browser.wait('!!window.deferFixture && !!document.querySelector("[data-plush-avatar]")');
  return { browser, release };
};
const waitFor = async (browser, expression, timeout = 12_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await browser.evaluate(expression)) return true; await pause(50); }
  throw new Error(`Timed out: ${expression}`);
};
const requestsFor = scenario => result.runtimeRequests.filter(item => item.scenario === scenario).length;
const diagnostics = browser => browser.evaluate('window.__wandPlushDiagnostics?.()');
const closeBrowser = async browser => { await browser.close(); browsers.splice(browsers.indexOf(browser), 1); };
try {
  {
    const { browser, release } = await open('ambient');
    assert.equal(await browser.evaluate("document.querySelector('[data-plush-avatar]').dataset.renderer"), 'deferred', 'Ambient identity stays deferred');
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.wand-plush-avatar-fallback')).visibility"), 'visible', 'Static identity is visible as the stable first frame');
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('[data-plush-avatar] canvas')).opacity"), '0', 'Canvas stays hidden until a real frame exists');
    assert.equal(requestsFor('ambient'), 0, 'Runtime is not requested during the critical phase');
    assert.equal((await browser.evaluate('window.__wandPlushLoaderDiagnostics?.()')).status, 'idle');
    const releaseAt = Date.now(); release();
    await waitFor(browser, "document.querySelector('[data-plush-avatar]').dataset.renderer==='webgl'");
    assert.equal(requestsFor('ambient'), 1, 'One shared runtime request after the critical phase');
    assert.ok(result.runtimeRequests.find(item => item.scenario === 'ambient').at - releaseAt >= 500, 'Download starts after load plus the quiet settle window');
    const stats = await diagnostics(browser);
    assert.equal(stats.contexts, 1); assert.equal(stats.createdContexts, 1); assert.equal(stats.registrations, 1);
    result.cases.push({ name: 'Ambient identity keeps the static first frame and downloads after the critical phase', stats });
    await closeBrowser(browser);
  }
  {
    const { browser, release } = await open('interactive');
    await waitFor(browser, "document.querySelector('[data-plush-avatar]').dataset.renderer==='webgl'");
    assert.equal(requestsFor('interactive'), 1, 'Interactive preview bypasses the ambient gate while the page is still loading');
    result.cases.push({ name: 'Interactive authoring preview stays immediate' });
    release(); await closeBrowser(browser);
  }
  {
    const { browser, release } = await open('offscreen');
    release();
    await pause(1_600);
    assert.equal(await browser.evaluate("document.querySelector('[data-plush-avatar]').dataset.renderer"), 'deferred', 'Offscreen identity remains deferred after the gate opens');
    assert.equal(requestsFor('offscreen'), 0, 'Offscreen identity never downloads the runtime');
    await browser.evaluate("document.querySelector('[data-plush-avatar]').scrollIntoView({block:'center'})");
    await waitFor(browser, "document.querySelector('[data-plush-avatar]').dataset.renderer==='webgl'");
    assert.equal(requestsFor('offscreen'), 1);
    result.cases.push({ name: 'Offscreen identity stays static with no runtime request until it becomes visible' });
    await closeBrowser(browser);
  }
  {
    const { browser, release } = await open('unmount');
    await browser.evaluate('window.deferFixture.unmount()');
    await browser.wait('!document.querySelector("[data-plush-avatar]")');
    release();
    await pause(3_500);
    assert.equal(requestsFor('unmount'), 0, 'Unmounted identity cancels the deferred initialization');
    result.cases.push({ name: 'Unmount before the gate cancels the deferred initialization' });
    await closeBrowser(browser);
  }
  {
    const { browser, release } = await open('hidden');
    const background = await browser.send('Target.createTarget', { url: 'about:blank', background: false });
    try {
      await browser.send('Target.activateTarget', { targetId: background.targetId });
      await browser.wait("document.visibilityState==='hidden'");
      release();
      await pause(2_000);
      assert.equal(requestsFor('hidden'), 0, 'Hidden page does not initialize the runtime');
    } finally {
      await browser.send('Target.closeTarget', { targetId: background.targetId });
      await browser.send('Page.bringToFront');
    }
    await browser.wait("document.visibilityState==='visible'");
    await waitFor(browser, "document.querySelector('[data-plush-avatar]')?.dataset.renderer==='webgl'");
    assert.equal(requestsFor('hidden'), 1, 'Visible page resumes exactly one bounded request');
    result.cases.push({ name: 'Background page defers the runtime until visible' });
    await closeBrowser(browser);
  }
  {
    const { browser, release } = await open('switch');
    release();
    await waitFor(browser, "document.querySelectorAll('[data-plush-avatar][data-renderer=webgl]').length===6");
    const first = await diagnostics(browser);
    await browser.evaluate('window.deferFixture.setCount(3)');
    await browser.wait("document.querySelectorAll('[data-plush-avatar]').length===3");
    await waitFor(browser, "document.querySelectorAll('[data-plush-avatar][data-renderer=webgl]').length===3");
    await browser.evaluate('window.deferFixture.setCount(6)');
    await browser.wait("document.querySelectorAll('[data-plush-avatar]').length===6");
    await waitFor(browser, "document.querySelectorAll('[data-plush-avatar][data-renderer=webgl]').length===6");
    const second = await diagnostics(browser);
    assert.equal(second.createdContexts, 1, 'Fast identity switches never create a second WebGL context');
    assert.equal(second.contexts, 1);
    assert.equal(second.registrations, 6, 'Disposed registrations do not leak across the switch');
    assert.equal(requestsFor('switch'), 1, 'One shared runtime asset for the whole page lifetime');
    result.cases.push({ name: 'Fast list switches reuse the single context without leaked registrations', first, second });
    await closeBrowser(browser);
  }
  result.ok = true;
  writeFileSync(join(output, 'deferral-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, cases: result.cases.length, runtimeRequests: result.runtimeRequests.length, output }));
} catch (error) {
  result.ok = false; result.error = error.stack; result.browserErrors = browsers.map(browser => browser.errors);
  writeFileSync(join(output, 'deferral-result.json'), JSON.stringify(result, null, 2) + '\n');
  throw error;
} finally {
  for (const browser of browsers) await browser.close();
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  rmSync(temp, { recursive: true, force: true });
  stop();
}
