import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { openBrowser } from "./sidebar-ux-browser.mjs";

const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{WandUiProvider}from'./src/web-ui/react/theme.tsx';
import{ShellTopbar}from'./src/web-ui/react/shell/shell-topbar.tsx';
import{MemoryUiAdapter}from'./src/web-ui/react/shell/ui-store.ts';
import{UiStoreProvider}from'./src/web-ui/react/shell/ui-store-react.tsx';
const selected={id:'topbar-fixture',source:'wand',provider:'codex',kind:'structured',title:'保留完整会话标题',description:'真实执行信息在输入区',cwd:'/workspace/wand',status:'running',statusLabel:'思考中',active:true,selected:true,resumable:true,permissionBlocked:false,inFlight:true,turnActive:true,titleGenerating:false,turnStartedAt:'2026-10-10T00:00:00Z',lastActivityAt:'2026-10-10T00:00:00Z'};
let snapshot={auth:{phase:'authenticated'},viewport:{mobile:innerWidth<640,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},layout:{sessionsDrawerOpen:false,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:innerWidth<640,sidebarAnchored:innerWidth>=640,sessionsBackdropVisible:false,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:'chat'},selected,sidebar:{interactiveCount:1,totalCount:1,manageMode:false,selectedCount:0,groups:[]},topbar:{title:selected.title,description:selected.description,statusLabel:selected.statusLabel,statusTone:'running',cwd:selected.cwd,currentTask:'',titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:true,blank:false,composer:true}};
const store=new MemoryUiAdapter(snapshot);
store.dispatch=action=>{if(action.type==='topbar.menu.toggle')snapshot={...snapshot,layout:{...snapshot.layout,topbarMoreOpen:!snapshot.layout.topbarMoreOpen}};if(action.type==='layout.drawer.toggle')snapshot={...snapshot,layout:{...snapshot.layout,sessionsDrawerOpen:!snapshot.layout.sessionsDrawerOpen}};store.setSnapshot(snapshot)};
window.topbarFixture={setPhase(phase){const active=phase==='running'||phase==='permission';snapshot={...snapshot,selected:{...selected,status:phase,turnActive:active,inFlight:active,permissionBlocked:phase==='permission'},topbar:{...snapshot.topbar,statusLabel:phase,statusTone:phase}};store.setSnapshot(snapshot)}};
createRoot(document.getElementById('root')).render(<WandUiProvider><UiStoreProvider store={store}><ShellTopbar/></UiStoreProvider></WandUiProvider>);`;
const built = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const native = new URL(req.url, "http://localhost").searchParams.has("native");
  res.end(`<!doctype html><html lang="zh-CN" class="${native ? "is-wand-app" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const cases = [];
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await openBrowser(origin, 1280, 900);
  for (const [width, suffix, reduced] of [[1280, "", false], [390, "", false], [320, "", false], [390, "?native=1", false], [390, "?reactUi=0", false], [390, "", true]]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 640 });
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: width < 640 });
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
    await browser.send("Page.navigate", { url: origin + "/" + suffix });
    await browser.wait("!!window.topbarFixture && !!document.querySelector('#topbar-more-button')");
    for (const phase of ["idle", "running", "permission", "error"]) {
      await browser.evaluate(`window.topbarFixture.setPhase(${JSON.stringify(phase)})`);
      await browser.settle();
      const shape = await browser.evaluate(`(()=>{const selectors=['.topbar-metadata','.topbar-provider','.topbar-cwd','.session-status-pill','.session-status-text','.session-status-elapsed','.session-status-silent'];return {title:document.querySelector('.topbar-session-title').textContent,counts:Object.fromEntries(selectors.map(s=>[s,document.querySelectorAll(s).length])),overflow:document.documentElement.scrollWidth>innerWidth+1,file:!!document.querySelector('#topbar-file-button'),preview:!!document.querySelector('#topbar-local-preview-button')}})()`);
      assert.equal(shape.title, "保留完整会话标题");
      assert.ok(Object.values(shape.counts).every(count => count === 0));
      assert.equal(shape.overflow, false);
      assert.ok(shape.file && shape.preview);
      cases.push({ width, suffix, reduced, phase, counts: shape.counts });
    }
    if (width < 640) {
      await browser.click("#sessions-toggle-button");
      await browser.wait("document.querySelector('#sessions-toggle-button').getAttribute('aria-expanded')==='true'");
      await browser.click("#sessions-toggle-button");
    }
    await browser.click("#topbar-more-button");
    await browser.wait("!!document.querySelector('#topbar-more-menu')");
    assert.equal(await browser.evaluate("document.querySelectorAll('.topbar-metadata,.topbar-provider,.topbar-cwd,.session-status-pill').length"), 0);
    assert.equal(await browser.evaluate("[...document.querySelectorAll('[data-action]')].some(el=>el.dataset.action==='copy-cwd')"), true);
    await browser.key("Escape");
    await browser.wait("document.querySelector('#topbar-more-button').getAttribute('aria-expanded')==='false'");
  }
  assert.deepEqual(browser.errors, []);
  console.log(JSON.stringify({ passed: true, cases }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
