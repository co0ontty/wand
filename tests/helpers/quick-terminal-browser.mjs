import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { openBrowser } from "./sidebar-ux-browser.mjs";

const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{WandUiProvider}from'./src/web-ui/react/theme.tsx';
import{QuickTerminalWorkspace}from'./src/web-ui/react/quick-terminal/workspace.tsx';
import{ShellTopbar}from'./src/web-ui/react/shell/shell-topbar.tsx';
import{configureQuickTerminalRuntime}from'./src/web-ui/react/quick-terminal/runtime.ts';
import{MemoryUiAdapter}from'./src/web-ui/react/shell/ui-store.ts';
import{UiStoreProvider}from'./src/web-ui/react/shell/ui-store-react.tsx';
import{setActiveWorkspaceContext}from'./src/web-ui/react/workspaces/workspace-context.ts';
window.XTermLib={Terminal:class{},FitAddon:class{}};
window.fixture={mounts:0,posts:0,requests:[],node:null,listener:null};
window.fetch=async(url,init)=>{fixture.requests.push({url,body:init?.body});if(init?.method==='POST')fixture.posts++;return new Response(JSON.stringify({id:'quick-1',sessionKind:'pty',cwd:'/workspace/worktree',status:'running'}))};
configureQuickTerminalRuntime({mount(id,node){if(!fixture.node){fixture.mounts++;fixture.node=document.createElement('textarea');fixture.node.id='terminal-input';fixture.node.value='终端已有输出';node.appendChild(fixture.node)}setTimeout(()=>fixture.listener?.({type:'init',sessionId:id,data:{status:'running',cwd:'/workspace/worktree'}}),20);return true},dispose(){},retain(){},focus(){fixture.node?.focus()},reconnect(id){fixture.listener?.({type:'init',sessionId:id,data:{status:'running'}})},observe(listener){fixture.listener=listener;return()=>{fixture.listener=null}}});
const snapshot={auth:{phase:'authenticated'},viewport:{mobile:false,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},layout:{sessionsDrawerOpen:false,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:false,sidebarAnchored:true,sessionsBackdropVisible:false,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:'chat'},selected:null,sidebar:{interactiveCount:0,totalCount:0,manageMode:false,selectedCount:0,groups:[]},topbar:{title:'Wand',description:'',statusLabel:'',statusTone:'',cwd:'',currentTask:'',titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:false,blank:true,composer:true}};
setActiveWorkspaceContext({cwd:'/workspace/worktree'});
function Draft(){const[value,set]=React.useState('主编辑器草稿');return <textarea id='draft' value={value} onChange={e=>set(e.target.value)} style={{width:'100%',height:'100%',boxSizing:'border-box'}}/>}
function Fixture(){const[topbar,set]=React.useState(false);fixture.topbar=set;return <QuickTerminalWorkspace>{topbar&&<ShellTopbar/>}<Draft/></QuickTerminalWorkspace>}
createRoot(document.getElementById('root')).render(<WandUiProvider><UiStoreProvider store={new MemoryUiAdapter(snapshot)}><Fixture/></UiStoreProvider></WandUiProvider>);`;
const built = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="display:flex;height:100vh;width:100vw"></div><script src="/app.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await openBrowser(origin, 1280, 900);
  await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
  await browser.evaluate("window.draftNode=document.querySelector('#draft');true");
  await browser.click('[aria-label="打开终端"]');
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.posts"), 1);
  assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').dataset.dock"), "right", "first use docks on the right");
  assert.equal(await browser.evaluate("JSON.parse(fixture.requests[0].body).cwd"), "/workspace/worktree");
  const position = await browser.evaluate("(()=>{let r=document.querySelector('[aria-label=打开终端]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()");
  await browser.click('[aria-label="停靠位置：右侧"]');
  await browser.wait("!!document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')");
  await browser.evaluate("[...document.querySelectorAll('.ant-dropdown-menu-item')].find(n=>n.textContent.includes('底部')).id='dock-bottom';true");
  await browser.click('#dock-bottom');
  await browser.wait("document.querySelector('#quick-terminal-panel').dataset.dock==='bottom'");
  assert.equal(await browser.evaluate("document.querySelector('#draft')===draftNode"), true);
  assert.equal(await browser.evaluate("document.querySelector('#terminal-input')===fixture.node"), true);
  assert.equal(await browser.evaluate("fixture.mounts"), 1);
  assert.deepEqual(await browser.evaluate("(()=>{let r=document.querySelector('[aria-label=打开终端]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()"), position);
  await browser.click('[aria-label="停靠位置：底部"]');
  await browser.key("Escape");
  await browser.wait("document.querySelector('[aria-label=\"停靠位置：底部\"]').getAttribute('aria-expanded')==='false'");
  await browser.click('[aria-label="关闭终端面板"]');
  await browser.click('[aria-label="打开终端"]');
  assert.equal(await browser.evaluate("document.activeElement.id"), "terminal-input", "explicit reopen focuses the retained terminal");
  assert.equal(await browser.evaluate("fixture.posts"), 1);
  assert.equal(await browser.evaluate("document.querySelector('#draft').value"), "主编辑器草稿");
  // A delayed reconnect may not refocus over an editor the user returned to.
  await browser.evaluate("document.querySelector('#draft').focus();fixture.listener({type:'disconnected'});fixture.listener({type:'init',sessionId:'quick-1',data:{status:'running'}});true");
  assert.equal(await browser.evaluate("document.activeElement.id"), "draft");
  mkdirSync("output/quick-terminal", { recursive: true });
  await browser.screenshot("output/quick-terminal/web-layout-mock-desktop.png");
  await browser.send("Page.navigate", { url: origin });
  await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
  await browser.click('[aria-label="打开终端"]');
  await browser.wait("!!document.querySelector('#terminal-input')");
  assert.equal(await browser.evaluate("fixture.posts"), 0, "refresh reconnects the saved session instead of creating a shell");
  assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').dataset.dock"), "bottom");
  for (const [width,height] of [[390,844],[320,568],[1280,400]]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 640 });
    await browser.settle();
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth+1"), false);
    const rect = await browser.evaluate("(()=>{const r=document.querySelector('[aria-label=\"关闭终端面板\"]').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()");
    assert.ok(rect.x >= 0 && rect.right <= width + 1 && rect.y >= 0 && rect.bottom <= height, JSON.stringify(rect));
  }
  await browser.screenshot("output/quick-terminal/web-layout-mock-low-height.png");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await browser.evaluate("fixture.topbar(true);true");
  await browser.wait("!!document.querySelector('.main-header-row [aria-label=打开终端]')");
  await browser.settle();
  const headerButton = await browser.evaluate("(()=>{const r=document.querySelector('[aria-label=打开终端]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()");
  await browser.click('[aria-label="停靠位置：底部"]');
  await browser.evaluate("[...document.querySelectorAll('.ant-dropdown-menu-item')].find(n=>n.textContent.includes('右侧')).id='dock-right';true");
  await browser.click('#dock-right');
  await browser.wait("document.querySelector('#quick-terminal-panel').dataset.dock==='right'");
  assert.deepEqual(await browser.evaluate("(()=>{const r=document.querySelector('[aria-label=打开终端]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()"), headerButton, "existing header stays at full workspace width");
  assert.equal(await browser.evaluate("[...document.querySelectorAll('[aria-label=打开终端]')].filter(n=>n.getBoundingClientRect().width>0).length"), 1);
  await browser.click('[aria-label="停靠位置：右侧"]');
  await browser.click('#draft');
  await browser.wait("document.querySelector('[aria-label=\"停靠位置：右侧\"]').getAttribute('aria-expanded')==='false'");
  assert.equal(await browser.evaluate("fixture.mounts"), 1);
  const geometry = await browser.evaluate("(()=>{const root=document.querySelector('.quick-terminal-split').getBoundingClientRect();const terminal=document.querySelector('#quick-terminal-panel').getBoundingClientRect();return {rootWidth:root.width,terminalWidth:terminal.width,right:terminal.right,rootRight:root.right}})()");
  assert.ok(Math.abs(geometry.terminalWidth / geometry.rootWidth - .4) < .03, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.right - geometry.rootRight) < 2, JSON.stringify(geometry));
  await browser.screenshot("output/quick-terminal/web-existing-topbar-mock.png");
  await browser.send("Page.navigate", { url: origin });
  await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
  await browser.click('[aria-label="打开终端"]');
  await browser.wait("!!document.querySelector('#terminal-input')");
  assert.equal(await browser.evaluate("fixture.posts"), 0);
  assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').dataset.dock"), "right", "right dock is also restored after refresh");
  assert.deepEqual(browser.errors, []);
  console.log(JSON.stringify({ passed: true, scope: "isolated layout with mock transport, not installed-service acceptance", checks: ["single creation", "same terminal and draft nodes", "dock persistence", "refresh GET only", "Escape", "focus preservation", "narrow/low-height"] }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
