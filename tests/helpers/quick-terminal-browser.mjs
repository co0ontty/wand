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
import{configureWorkspacesRuntime}from'./src/web-ui/react/workspaces/controller.ts';
import{subscribeTaskChanges}from'./src/web-ui/react/task-changes.ts';
window.XTermLib={Terminal:class{},FitAddon:class{}};
const fixtureOptions=JSON.parse(new URLSearchParams(location.search).get('fixture')||'{}');
window.fixture={mounts:0,posts:0,claims:0,refreshes:0,taskChanges:0,attempts:0,requests:[],mountIds:[],disposed:[],sources:{},statuses:{},nextId:'quick-1',node:null,listener:null,failMount:new URLSearchParams(location.search).has('mountFailure'),...fixtureOptions};
window.fetch=async(url,init)=>{const creating=init?.method==='POST',claiming=init?.method==='PUT';fixture.requests.push({url,method:init?.method,body:init?.body});if(creating)fixture.posts++;if(claiming)fixture.claims++;const failure=creating?fixture.postFailure:claiming?fixture.claimFailure:fixture.getFailure;if(failure==='network')throw new TypeError('Failed to fetch');if(typeof failure==='number')return new Response('unavailable',{status:failure});if(failure==='parse')return new Response('{broken');if(claiming&&fixture.holdClaim)await new Promise(resolve=>{fixture.releaseClaim=resolve});const pieces=String(url).split('/'),id=creating?fixture.nextId:decodeURIComponent(pieces[pieces.length-(claiming?2:1)]);if(claiming)fixture.sources[id]='quick-terminal';return new Response(JSON.stringify({id,sessionKind:'pty',sessionSource:fixture.sources[id]||'quick-terminal',cwd:'/workspace/worktree',status:fixture.statuses[id]||'running'}))};
configureWorkspacesRuntime({refreshSessions:async()=>{fixture.refreshes++}});subscribeTaskChanges(()=>{fixture.taskChanges++});
configureQuickTerminalRuntime({mount(id,node){fixture.attempts++;if(fixture.failMount){fixture.failMount=false;return false}if(!fixture.node){fixture.mounts++;fixture.mountIds.push(id);fixture.node=document.createElement('textarea');fixture.node.id='terminal-input';fixture.node.value='终端已有输出';node.appendChild(fixture.node)}setTimeout(()=>fixture.listener?.({type:'init',sessionId:id,data:{status:fixture.statuses[id]||'running',cwd:'/workspace/worktree'}}),20);return true},dispose(id){fixture.disposed.push(id);fixture.node?.remove();fixture.node=null},retain(){},focus(){fixture.node?.focus()},reconnect(id){fixture.listener?.({type:'init',sessionId:id,data:{status:fixture.statuses[id]||'running'}})},observe(listener){fixture.listener=listener;return()=>{fixture.listener=null}}});
const snapshot={auth:{phase:fixture.authPhase||'authenticated'},viewport:{mobile:false,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},layout:{sessionsDrawerOpen:false,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:false,sidebarAnchored:true,sessionsBackdropVisible:false,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:'chat'},selected:null,sidebar:{interactiveCount:0,totalCount:0,manageMode:false,selectedCount:0,groups:[]},topbar:{title:'Wand',description:'',statusLabel:'',statusTone:'',cwd:'',currentTask:'',titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:false,blank:true,composer:true}};
const uiStore=new MemoryUiAdapter(snapshot);fixture.authenticate=()=>uiStore.setSnapshot({...snapshot,auth:{phase:'authenticated'}});
setActiveWorkspaceContext({cwd:'/workspace/worktree'});
function Draft(){const[value,set]=React.useState('主编辑器草稿');return <textarea id='draft' value={value} onChange={e=>set(e.target.value)} style={{width:'100%',height:'100%',boxSizing:'border-box'}}/>}
function Fixture(){const[topbar,set]=React.useState(false);const[shown,show]=React.useState(true);const[,tick]=React.useReducer(x=>x+1,0);fixture.topbar=set;fixture.show=show;React.useEffect(()=>{if(!new URLSearchParams(location.search).has('manual'))return;const timer=setInterval(tick,100);return()=>clearInterval(timer)},[]);return <>{new URLSearchParams(location.search).has('manual')&&<div style={{position:'absolute',bottom:0,left:0,zIndex:100,background:'white'}}><button onClick={()=>fixture.listener?.({type:'error'})}>模拟其他操作错误</button><button onClick={()=>fixture.listener?.({type:'pty_error',sessionId:'quick-1'})}>模拟终端错误</button><button onClick={()=>fixture.listener?.({type:'init',sessionId:'quick-1',data:{status:'running'}})}>恢复连接</button><button onClick={()=>show(!shown)}>切换工作区挂载</button><output id='fixture-counts'>创建 {fixture.posts} · 挂载尝试 {fixture.attempts} · 实例 {fixture.mounts}</output></div>}{shown&&<QuickTerminalWorkspace>{topbar&&<ShellTopbar/>}<Draft/></QuickTerminalWorkspace>}</>}

createRoot(document.getElementById('root')).render(<WandUiProvider><UiStoreProvider store={uiStore}><Fixture/></UiStoreProvider></WandUiProvider>);`;
const built = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="display:flex;height:100vh;width:100vw"></div><script src="/app.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
if (process.env.WAND_QUICK_TERMINAL_MANUAL === '1') {
  console.log(`Manual fixture: http://127.0.0.1:${server.address().port}/?manual&mountFailure`);
  await new Promise(() => {});
}
async function verifyLiveStatusClearsReplacement(browser, sessionId) {
  const originalPosts = await browser.evaluate("fixture.posts");
  const hasReplacement = "[...document.querySelectorAll('#quick-terminal-panel .ant-alert button')].some(n=>n.textContent==='新建终端')";
  for (const status of ["running", "idle"]) {
    await browser.wait(hasReplacement);
    await browser.evaluate(`fixture.listener({type:'status',sessionId:${JSON.stringify(sessionId)},data:{status:${JSON.stringify(status)}}});true`);
    await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
    assert.equal(await browser.evaluate(hasReplacement), false, `${status} supersedes the old ended state`);
    await browser.evaluate("fixture.listener({type:'disconnected'});true");
    await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已断开')");
    assert.equal(await browser.evaluate(hasReplacement), false, "a later transport disconnect cannot revive stale replacement eligibility");
    await browser.evaluate(`fixture.listener({type:'ended',sessionId:${JSON.stringify(sessionId)}});true`);
    await browser.wait(hasReplacement);
  }
  assert.equal(await browser.evaluate("fixture.posts"), originalPosts, "status transitions never create a process");
}
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await openBrowser(origin, 1280, 900);
  await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
  await browser.evaluate("window.draftNode=document.querySelector('#draft');true");
  await browser.click('[aria-label="打开终端"]');
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  if (process.env.WAND_QUICK_TERMINAL_STATUS_ONLY === "1") {
    await browser.evaluate("fixture.nextId='status-replacement';fixture.listener({type:'ended',sessionId:'quick-1'});true");
    await verifyLiveStatusClearsReplacement(browser, "quick-1");
    await browser.click("#quick-terminal-panel .ant-alert button");
    await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
    assert.equal(await browser.evaluate("fixture.posts"), 2, "one initial shell and one explicitly requested replacement");
    assert.equal(await browser.evaluate("JSON.parse(localStorage.getItem('wand.quick-terminal.v1')).sessionId"), "status-replacement");
    assert.deepEqual(browser.errors, []);
    console.log(JSON.stringify({ passed: true, scope: "isolated status recovery with mock transport", checks: ["ended→running→disconnected", "ended→idle→disconnected", "fresh ended state permits explicit replacement"] }));
  } else {
  assert.equal(await browser.evaluate("fixture.posts"), 1);
  assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').dataset.dock"), "right", "first use docks on the right");
  assert.equal(await browser.evaluate("JSON.parse(fixture.requests[0].body).cwd"), "/workspace/worktree");
  assert.equal(await browser.evaluate("JSON.parse(fixture.requests[0].body).sessionSource"), "quick-terminal");
  assert.equal(await browser.evaluate("fixture.refreshes"), 1, "creation refreshes session navigation");
  assert.equal(await browser.evaluate("fixture.taskChanges"), 1, "creation invalidates task groups");
  const position = await browser.evaluate("(()=>{let r=document.querySelector('[aria-label=打开终端]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()");
  await browser.click('[aria-label="终端选项"]');
  await browser.wait("!!document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')");
  await browser.evaluate("[...document.querySelectorAll('.ant-dropdown-menu-item')].find(n=>n.textContent.includes('底部')).id='dock-bottom';true");
  await browser.click('#dock-bottom');
  await browser.wait("document.querySelector('#quick-terminal-panel').dataset.dock==='bottom'");
  assert.equal(await browser.evaluate("document.querySelector('#draft')===draftNode"), true);
  assert.equal(await browser.evaluate("document.querySelector('#terminal-input')===fixture.node"), true);
  assert.equal(await browser.evaluate("fixture.mounts"), 1);
  assert.deepEqual(await browser.evaluate("(()=>{let r=document.querySelector('[aria-label=打开终端]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()"), position);
  await browser.click('[aria-label="终端选项"]');
  await browser.key("Escape");
  await browser.wait("document.querySelector('[aria-label=\"终端选项\"]').getAttribute('aria-expanded')==='false'");
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
  await browser.click('[aria-label="终端选项"]');
  await browser.evaluate("[...document.querySelectorAll('.ant-dropdown-menu-item')].find(n=>n.textContent.includes('右侧')).id='dock-right';true");
  await browser.click('#dock-right');
  await browser.wait("document.querySelector('#quick-terminal-panel').dataset.dock==='right'");
  assert.deepEqual(await browser.evaluate("(()=>{const r=document.querySelector('[aria-label=打开终端]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()"), headerButton, "existing header stays at full workspace width");
  assert.equal(await browser.evaluate("[...document.querySelectorAll('[aria-label=打开终端]')].filter(n=>n.getBoundingClientRect().width>0).length"), 1);
  await browser.click('[aria-label="终端选项"]');
  await browser.click('#draft');
  await browser.wait("document.querySelector('[aria-label=\"终端选项\"]').getAttribute('aria-expanded')==='false'");
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
  await browser.send("Page.navigate", { url: origin + "/?mountFailure" });
  await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
  await browser.click('[aria-label="打开终端"]');
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('终端组件加载失败')");
  await browser.click('[aria-label="关闭终端面板"]');
  await browser.click('[aria-label="打开终端"]');
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.attempts"), 2, "reopen retries a failed mount even though its session ID is already known");
  assert.equal(await browser.evaluate("fixture.posts"), 0, "mount recovery must not create another process");
  await browser.evaluate("fixture.listener({type:'error'});true");
  assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')"), true, "unscoped errors are not terminal failures");

  const preference = sessionId => ({ dock: "right", sessionId });
  const savedPreference = "JSON.parse(localStorage.getItem('wand.quick-terminal.v1'))";
  const actionText = "document.querySelector('#quick-terminal-panel .ant-alert button')?.textContent";
  const action = "#quick-terminal-panel .ant-alert button";
  const reopen = async (saved, configuration = {}, open = true) => {
    await browser.evaluate(`localStorage.setItem('wand.quick-terminal.v1',${JSON.stringify(JSON.stringify(saved))});true`);
    await browser.send("Page.navigate", { url: origin + "/?fixture=" + encodeURIComponent(JSON.stringify(configuration)) });
    await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
    if (open) await browser.click('[aria-label="打开终端"]');
  };
  const dockBottom = async () => {
    await browser.click('[aria-label="终端选项"]');
    await browser.evaluate("[...document.querySelectorAll('.ant-dropdown-menu-item')].find(n=>n.textContent.includes('底部')).id='dock-bottom';true");
    await browser.click('#dock-bottom');
  };

  await reopen(preference("legacy-shell"), { authPhase: "anonymous", sources: { "legacy-shell": "interactive" } }, false);
  await browser.settle();
  assert.equal(await browser.evaluate("fixture.requests.length"), 0, "a saved reference is not claimed before authentication");
  await browser.evaluate("fixture.authenticate();true");
  await browser.wait("fixture.refreshes===1 && fixture.taskChanges===1");
  assert.deepEqual(await browser.evaluate("fixture.requests.map(r=>({url:r.url,method:r.method||'GET'}))"), [
    { url: "/api/sessions/legacy-shell", method: "GET" },
    { url: "/api/sessions/legacy-shell/quick-terminal", method: "PUT" },
  ]);
  assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').dataset.open"), "false");
  assert.equal(await browser.evaluate("fixture.mounts"), 0, "background claiming leaves the terminal unmounted");
  assert.equal(await browser.evaluate("fixture.posts"), 0, "background claiming never starts a shell");
  await browser.click('[aria-label="打开终端"]');
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.claims"), 1, "opening reuses the background claim");
  assert.equal(await browser.evaluate("fixture.refreshes"), 1);
  assert.equal(await browser.evaluate(`${savedPreference}.sessionId`), "legacy-shell");

  await reopen(preference("claim-in-flight"), { sources: { "claim-in-flight": "interactive" }, holdClaim: true }, false);
  await browser.wait("!!fixture.releaseClaim");
  await browser.click('[aria-label="打开终端"]');
  assert.equal(await browser.evaluate("fixture.mounts"), 0);
  assert.equal(await browser.evaluate("fixture.claims"), 1);
  await browser.evaluate("fixture.releaseClaim();true");
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.claims"), 1, "background and explicit opening serialize the same saved claim");
  assert.equal(await browser.evaluate("fixture.posts"), 0);

  for (const claimFailure of [404, 503, "parse"]) {
    await reopen(preference("legacy-claim-failure"), { sources: { "legacy-claim-failure": "interactive" }, claimFailure });
    await browser.wait(`${actionText}==='重新连接'`);
    assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').textContent.includes('新建终端')"), false, "failed migration is not a missing shell");
    assert.equal(await browser.evaluate("fixture.posts"), 0);
    assert.equal(await browser.evaluate("fixture.mounts"), 0);
    assert.equal(await browser.evaluate("fixture.refreshes"), 0, "unconfirmed claiming does not invalidate navigation as if successful");
    assert.equal(await browser.evaluate(`${savedPreference}.sessionId`), "legacy-claim-failure");
    await browser.click(action);
    assert.equal(await browser.evaluate("fixture.posts"), 0);
  }

  for (const status of [404, 410]) {
    await reopen(preference("missing-shell"), { getFailure: status, nextId: "replacement-" + status });
    await browser.wait(`${actionText}==='新建终端'`);
    assert.equal(await browser.evaluate("fixture.posts"), 0, `HTTP ${status} does not itself create a shell`);
    await browser.evaluate("fixture.getFailure=null;window.draftNode=document.querySelector('#draft');true");
    // Two synchronous clicks exercise the submission guard before React disables the action.
    await browser.evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(action)});button.click();button.click();return true})()`);
    await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
    assert.equal(await browser.evaluate("fixture.posts"), 1);
    assert.equal(await browser.evaluate(`${savedPreference}.sessionId`), "replacement-" + status);
    assert.equal(await browser.evaluate("document.querySelector('#draft')===draftNode"), true);
    assert.equal(await browser.evaluate("fixture.requests.every(r=>!r.method||r.method==='POST')"), true, "replacement does not delete or stop the old session");
    await browser.send("Page.navigate", { url: origin });
    await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
    await browser.click('[aria-label="打开终端"]');
    await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
    assert.equal(await browser.evaluate("fixture.posts"), 0, "refresh only reconnects the replacement");
    assert.equal(await browser.evaluate("fixture.requests[0].url"), "/api/sessions/replacement-" + status);
  }

  for (const failure of [401, 403, 503, "network"]) {
    await reopen(preference("temporarily-unavailable"), { getFailure: failure });
    await browser.wait(`${actionText}==='重新连接'`);
    assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').textContent.includes('新建终端')"), false);
    await browser.click(action);
    assert.equal(await browser.evaluate("fixture.posts"), 0, `${failure} cannot turn into replacement creation`);
    assert.equal(await browser.evaluate(`${savedPreference}.sessionId`), "temporarily-unavailable");
  }

  await reopen(preference("ended-shell"), { statuses: { "ended-shell": "exited" }, nextId: "after-exit" });
  await browser.wait(`${actionText}==='新建终端'`);
  assert.equal(await browser.evaluate("fixture.posts"), 0);
  await verifyLiveStatusClearsReplacement(browser, "ended-shell");
  await browser.click(action);
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.posts"), 1);
  assert.deepEqual(await browser.evaluate("fixture.disposed"), ["ended-shell"], "only the previous client terminal is disposed");
  assert.deepEqual(await browser.evaluate("fixture.mountIds"), ["ended-shell", "after-exit"]);
  assert.equal(await browser.evaluate("fixture.requests.some(r=>r.method==='DELETE'||String(r.url).includes('/stop'))"), false);

  await reopen(preference("mounted-then-removed"), { nextId: "after-removal" });
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  await browser.evaluate("fixture.getFailure=404;true");
  await browser.click('[aria-label="终端选项"]');
  await browser.evaluate("[...document.querySelectorAll('.ant-dropdown-menu-item')].find(n=>n.textContent.includes('重新连接')).id='reconnect-terminal';true");
  await browser.click('#reconnect-terminal');
  await browser.wait(`${actionText}==='新建终端'`);
  assert.equal(await browser.evaluate("fixture.requests.at(-1).url"), "/api/sessions/mounted-then-removed", "reconnect checks the mounted reference still exists");
  await browser.evaluate("fixture.getFailure=null;true");
  await browser.click(action);
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.posts"), 1);
  assert.deepEqual(await browser.evaluate("fixture.disposed"), ["mounted-then-removed"]);

  for (const failure of [503, "network", "parse"]) {
    await reopen(preference("ended-shell"), { statuses: { "ended-shell": "exited" }, postFailure: failure });
    await browser.wait(`${actionText}==='新建终端'`);
    await browser.click(action);
    await browser.wait(`${savedPreference}.creationPending===true && !!document.querySelector('#quick-terminal-panel .ant-alert')`);
    assert.equal(await browser.evaluate("fixture.posts"), 1);
    await browser.evaluate("fixture.listener({type:'init',sessionId:'ended-shell',data:{status:'running'}});true");
    assert.equal(await browser.evaluate("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')"), false, "late old-session events cannot confirm unknown creation");
    await browser.click(action);
    await browser.click('[aria-label="关闭终端面板"]');
    await browser.click('[aria-label="打开终端"]');
    assert.equal(await browser.evaluate("fixture.posts"), 1, "reconnect/reopen cannot retry unknown creation");
    await browser.send("Page.navigate", { url: origin });
    await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
    await browser.click('[aria-label="打开终端"]');
    assert.equal(await browser.evaluate("fixture.posts"), 0, "refresh retains the unknown-creation guard");
    assert.equal(await browser.evaluate(`${savedPreference}.creationPending`), true);
    assert.equal(await browser.evaluate(actionText), undefined);
  }

  await reopen(preference("ended-shell"), { statuses: { "ended-shell": "exited" }, nextId: "after-storage-recovery" });
  await browser.wait(`${actionText}==='新建终端'`);
  await browser.evaluate("fixture.storageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='wand.quick-terminal.v1')throw new DOMException('storage write denied','QuotaExceededError');return fixture.storageSet.call(this,key,value)};true");
  await browser.click(action);
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('尚未创建新终端')");
  assert.equal(await browser.evaluate("fixture.posts"), 0, "a failed durable pending write prevents the POST entirely");
  assert.equal(await browser.evaluate(`${savedPreference}.sessionId`), "ended-shell");
  await dockBottom();
  await browser.evaluate("Storage.prototype.setItem=fixture.storageSet;true");
  await browser.click("#quick-terminal-panel .ant-alert-error button");
  await browser.wait(`${actionText}==='新建终端'`);
  await browser.click(action);
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.posts"), 1);
  assert.equal(await browser.evaluate(`${savedPreference}.sessionId`), "after-storage-recovery");

  await reopen(preference("missing-shell"), { getFailure: 404, nextId: "created-but-id-write-failed" });
  await browser.wait(`${actionText}==='新建终端'`);
  await browser.evaluate("fixture.getFailure=null;fixture.storageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='wand.quick-terminal.v1'&&JSON.parse(value).sessionId==='created-but-id-write-failed')throw new DOMException('final binding write denied','QuotaExceededError');return fixture.storageSet.call(this,key,value)};true");
  await browser.click(action);
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.posts"), 1);
  assert.equal(await browser.evaluate(`${savedPreference}.creationPending`), true, "the durable guard survives a failed final ID write");
  await browser.send("Page.navigate", { url: origin });
  await browser.wait("!!document.querySelector('[aria-label=打开终端]')");
  await browser.click('[aria-label="打开终端"]');
  assert.equal(await browser.evaluate("fixture.posts"), 0, "a refresh cannot recreate the shell whose final ID was not saved");
  assert.equal(await browser.evaluate(`${savedPreference}.creationPending`), true);

  await reopen(preference("missing-in-this-window"), { getFailure: 404 });
  await browser.wait(`${actionText}==='新建终端'`);
  await browser.evaluate(`fixture.getFailure=null;localStorage.setItem('wand.quick-terminal.v1',${JSON.stringify(JSON.stringify(preference("created-by-other-window")))});true`);
  await dockBottom();
  assert.deepEqual(await browser.evaluate(savedPreference), { dock: "bottom", sessionId: "created-by-other-window" }, "docking cannot overwrite another window's replacement");
  await browser.click(action);
  await browser.wait("document.querySelector('#quick-terminal-panel').textContent.includes('已连接')");
  assert.equal(await browser.evaluate("fixture.posts"), 0, "a stale recovery click adopts the other window's replacement");
  assert.equal(await browser.evaluate("fixture.requests.at(-1).url"), "/api/sessions/created-by-other-window");

  await reopen(preference("missing-in-this-window"), { getFailure: 404 });
  await browser.wait(`${actionText}==='新建终端'`);
  await browser.evaluate("localStorage.setItem('wand.quick-terminal.v1',JSON.stringify({dock:'right',sessionId:'',creationPending:true}));true");
  await browser.click(action);
  assert.equal(await browser.evaluate("fixture.posts"), 0, "the other window's in-flight creation is never duplicated");
  assert.notEqual(await browser.evaluate(actionText), "新建终端", "shared pending state removes the stale replacement action");
  await dockBottom();
  assert.deepEqual(await browser.evaluate(savedPreference), { dock: "bottom", sessionId: "", creationPending: true }, "docking preserves another window's unknown-creation guard");

  await reopen(preference("old-binding"), { getFailure: 404 });
  await browser.wait(`${actionText}==='新建终端'`);
  await browser.evaluate("localStorage.setItem('wand.quick-terminal.v1',JSON.stringify({dock:'right',sessionId:'',creationPending:true}));fixture.lockDone=navigator.locks.request('wand.quick-terminal.v1',()=>new Promise(resolve=>{fixture.releaseLock=resolve}));true");
  await browser.wait("!!fixture.releaseLock");
  await dockBottom();
  assert.equal(await browser.evaluate(`${savedPreference}.dock`), "right", "docking waits for in-flight creation to release its shared lock");
  await browser.evaluate("localStorage.setItem('wand.quick-terminal.v1',JSON.stringify({dock:'right',sessionId:'created-while-dock-waited'}));fixture.releaseLock();fixture.lockDone.then(()=>navigator.locks.request('wand.quick-terminal.v1',()=>true))");
  assert.deepEqual(await browser.evaluate(savedPreference), { dock: "bottom", sessionId: "created-while-dock-waited" }, "docking rereads the binding after acquiring the lock");
  assert.equal(await browser.evaluate("fixture.posts"), 0);

  await reopen(preference(""), {}, false);
  await browser.evaluate("fixture.lockDone=navigator.locks.request('wand.quick-terminal.v1',()=>new Promise(resolve=>{fixture.releaseLock=resolve}));true");
  await browser.wait("!!fixture.releaseLock");
  await browser.click('[aria-label="打开终端"]');
  await browser.evaluate("fixture.show(false);true");
  await browser.wait("!document.querySelector('#quick-terminal-panel')");
  await browser.evaluate("fixture.releaseLock();fixture.lockDone.then(()=>navigator.locks.request('wand.quick-terminal.v1',()=>true))");
  assert.equal(await browser.evaluate("fixture.requests.length"), 0, "an unmounted workspace cannot create after acquiring its delayed lock");
  assert.deepEqual(browser.errors, []);
  console.log(JSON.stringify({ passed: true, scope: "isolated layout with mock transport, not installed-service acceptance", checks: ["single creation", "same terminal and draft nodes", "dock persistence", "refresh GET only", "Escape", "focus preservation", "narrow/low-height", "404/410 explicit replacement", "authentication/network failure retry", "ended shell replacement", "mounted shell deletion", "unknown-creation persistence", "cross-window adoption and pending guard", "docking respects newer binding and shared creation lock", "unmount during lock wait"] }));
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
