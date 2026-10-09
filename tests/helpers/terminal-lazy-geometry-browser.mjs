import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { openBrowser } from "./sidebar-ux-browser.mjs";

const productionChrome = process.env.WAND_TERMINAL_PRODUCTION_CHROME === "1";
const built = await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
import{state}from'./src/web-ui/browser/state.ts';
import{ensureTerminalReady,withTerminalDimensions}from'./src/web-ui/browser/session-engine.ts';
import{fitTerminalToContainer}from'./src/web-ui/browser/terminal-fit.ts';
import{initTerminal}from'./src/web-ui/browser/terminal.ts';
import{teardownTerminal}from'./src/web-ui/browser/viewport.ts';
import{conversationUi}from'./src/web-ui/react/conversations/state.ts';
import{Layout}from'antd';import*as React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{ShellTopbarChrome}from'./src/web-ui/react/shell/shell-topbar.tsx';import{WandUiProvider}from'./src/web-ui/react/theme.tsx';
import{deriveLegacyUiSnapshot}from'./src/web-ui/react/shell/legacy-snapshot.ts';
import{FirstStandaloneSessionChrome,FirstWorkspaceWindowChrome}from'./src/web-ui/react/workspaces/workspace-tab-chrome.tsx';
import{TerminalShortcutsChrome}from'./src/web-ui/react/composer-rail/terminal-shortcuts.tsx';import{ComposerRailSubmitChrome}from'./src/web-ui/react/composer-rail/host.tsx';import{Card}from'antd';import{WandButton}from'./src/web-ui/react/ui/index.tsx';
import{workspaceContextStore,setActiveWorkspaceContext,clearActiveWorkspaceContext}from'./src/web-ui/react/workspaces/workspace-context.ts';import{taskDetailStore}from'./src/web-ui/react/workspaces/task-detail-store.ts';import{installSidebarStyles}from'./src/web-ui/react/shell/sidebar-styles.ts';
const chrome=${productionChrome};const futureCwd='/tmp/wand-terminal-creation-long-owned-fixture-cwd';let future={kind:'shell',cwd:futureCwd};if(chrome)installSidebarStyles();let taskMode=false,taskSubscribe;
const headerHost=document.querySelector('#fixture-header');const headerRoot=chrome?createRoot(headerHost):null;
const main=document.querySelector('.main-content'),appHost=document.createElement('div');appHost.style.height='100%';if(chrome){main.before(appHost);const appRoot=createRoot(appHost);flushSync(()=>appRoot.render(React.createElement(WandUiProvider,null,React.createElement(Layout,{style:{height:'100%'},ref:n=>{if(n&&!n.contains(main))n.appendChild(main)}}))))}
const composerRoot=chrome?createRoot(document.querySelector('.input-panel')):null;let shortcutMounted=false;
function drawComposer(){if(!composerRoot)return;const interactive=!!state.selectedId&&state.sessions[0]?.sessionKind==='pty';if(interactive)shortcutMounted=true;flushSync(()=>composerRoot.render(React.createElement(WandUiProvider,null,React.createElement(React.Fragment,null,
React.createElement('div',{className:'composer-top-row'},!interactive?[React.createElement('div',{key:'todo',id:'todo-progress',className:'todo-progress expanded'},React.createElement('button',{className:'todo-progress-header',type:'button'},'own prior todo')),React.createElement('div',{key:'body',id:'todo-progress-body',className:'todo-progress-body expanded'},React.createElement('div',{id:'todo-progress-content'},'own prior expanded body')),React.createElement('div',{key:'status',className:'structured-status-bar'},React.createElement('span',{className:'status-bar-dot'}),React.createElement('span',{className:'status-bar-label'},'own prior reply'),React.createElement('span',{className:'status-bar-timer'},'0.0s'))]:null),React.createElement('div',{id:'terminal-shortcuts',className:'terminal-shortcuts',hidden:!interactive},shortcutMounted?React.createElement(TerminalShortcutsChrome,{disabled:false}):null),
React.createElement('div',{className:'input-composer-row'},React.createElement('div',{className:'input-composer'+(interactive?' is-terminal-interactive':'')},React.createElement(Card,{size:'small',className:'composer-surface'},React.createElement('div',{className:'composer-main-row'},
React.createElement('div',{className:'composer-input-wrap'},React.createElement('div',{'data-composer-sender':''},React.createElement('textarea',{id:'input-box',className:'input-textarea',rows:1}))),
React.createElement('div',{className:'composer-actions-left'},React.createElement(WandButton,{size:'small'},'+')),
React.createElement('div',{className:'composer-actions-right'},React.createElement('span',{className:'composer-rail-host','data-composer-rail-host':'pty'},interactive?React.createElement(ComposerRailSubmitChrome):null),React.createElement(WandButton,{id:'voice-record-btn'},'语音'),React.createElement(WandButton,{id:'send-input-button','data-phase':'idle'},'发送'))))))))))}
function drawHeader(){if(!headerRoot)return;const snapshot=deriveLegacyUiSnapshot(state,{width:innerWidth,height:innerHeight,online:true});const chromeNode=taskMode?[snapshot.layout.sidebarDrawer?React.createElement('div',{key:'nav',className:'workspace-mobile-navigation',style:{height:36,flexShrink:0}}):null,state.selectedId?React.createElement(FirstWorkspaceWindowChrome,{key:'tabs',mobile:snapshot.viewport.mobile,taskName:'own-empty-task',session:state.sessions[0]}):null]:[React.createElement(ShellTopbarChrome,{key:'header',snapshot,measurement:true}),state.selectedId?React.createElement(FirstStandaloneSessionChrome,{key:'tabs',mobile:snapshot.viewport.mobile,session:state.sessions[0]}):null];flushSync(()=>headerRoot.render(React.createElement(WandUiProvider,null,React.createElement(Layout,{style:{flex:'none'}},chromeNode))))}
function newSelection(){if(!future.workspaceTaskId){taskMode=false;clearActiveWorkspaceContext()}state.sessions=[{id:'future-session',sessionKind:'pty',status:'running',cwd:future.cwd,workspaceTaskId:future.workspaceTaskId,provider:future.kind==='pty'?future.provider:undefined,command:future.kind==='pty'?future.provider:'Shell'}];state.selectedId='future-session';drawHeader();drawComposer();const input=document.querySelector('#input-box');if(input){input.value='';input.style.height='';input.style.minHeight=''}}
window.addEventListener('resize',drawHeader);
const originalRect=Element.prototype.getBoundingClientRect;window.probeRects=[];Element.prototype.getBoundingClientRect=function(){const r=originalRect.call(this);if((this.classList.contains('main-header-row')||this.classList.contains('workspace-tab-bar'))&&this.closest('[data-terminal-creation-measure]')){if(window.probeThrow)throw new Error('probe rectangle failure');window.probeRects.push({height:r.height,width:r.width,font:getComputedStyle(this).font,gap:getComputedStyle(this).gap,children:Array.from(this.children).map(n=>({class:n.className,height:originalRect.call(n).height,width:originalRect.call(n).width,text:n.textContent,font:getComputedStyle(n).font}))})}return r};

state.sessions=[{id:'structured-before-create',sessionKind:'structured',status:'idle',output:''}];
state.selectedId='structured-before-create';state.currentView='chat';state.config={};
window.geometryFixture={state,initTerminal,conversationUi,async prepareTask(){if(!taskSubscribe)taskSubscribe=taskDetailStore.subscribe('source-empty-task',()=>{});await taskDetailStore.load('source-empty-task');this.configure('task');future={...future,workspaceTaskId:'source-empty-task'}},setTarget(value){future={...future,...value};if(value.kind==='shell'){future.provider=undefined;future.command=undefined}},configure(kind){conversationUi.suspend();state.currentView='chat';teardownTerminal();taskMode=kind==='task';if(taskMode)setActiveWorkspaceContext({workspaceId:'source-workspace',taskId:'source-empty-task',taskName:'own-empty-task',cwd:futureCwd,layout:{type:'windows',windows:[],activeWindowId:null}});else{clearActiveWorkspaceContext();future.workspaceTaskId=undefined}state.sessions=kind==='structured'?[{id:'structured-before-create',sessionKind:'structured',status:'idle',output:''}]:[];state.selectedId=kind==='structured'?'structured-before-create':null;
document.querySelector('#output').style.display='none';document.querySelector('#chat-output').style.display=kind==='structured'?'flex':'none';document.querySelector('#blank-chat').style.display=kind!=='structured'?'flex':'none';document.querySelector('.input-panel').style.display=kind==='structured'?'block':'none';shortcutMounted=false;drawHeader();drawComposer();document.querySelector('.composer-top-row')?.style.setProperty('display','flex','important')},
hideExisting(keepTabs=false){if(!keepTabs)state.selectedId=null;document.querySelector('#output').style.display='none';document.querySelector('#chat-output').style.display='flex';document.querySelector('#blank-chat').style.display='none';drawHeader();drawComposer()},
async prepare(){await ensureTerminalReady();return withTerminalDimensions(future.kind==='shell'?{shell:true}:{provider:future.provider,command:future.provider},chrome?future:undefined)},
show(){if(chrome)newSelection();document.querySelector('#chat-output').style.display='none';document.querySelector('#blank-chat').style.display='none';document.querySelector('.input-panel').style.display='block';const node=document.querySelector('#output');node.classList.remove('hidden');node.style.display='flex';node.style.visibility='visible';
fitTerminalToContainer(state.terminal,state.terminalFitAddon);return{cols:state.terminal.cols,rows:state.terminal.rows}},
styles(){return Array.from(document.querySelectorAll("#output,#chat-output,#blank-chat,.input-panel,.composer-top-row,.main-header-row,.workspace-tab-bar,.workspace-mobile-navigation")).map(n=>n.style.cssText)},stats(){return{cols:state.terminal?.cols,rows:state.terminal?.rows,display:getComputedStyle(document.querySelector('#output')).display,visibility:getComputedStyle(document.querySelector('#output')).visibility,chatDisplay:getComputedStyle(document.querySelector('#chat-output')).display,blankDisplay:getComputedStyle(document.querySelector('#blank-chat')).display,composerDisplay:getComputedStyle(document.querySelector('.input-panel')).display,composerTopHeight:document.querySelector('.composer-top-row')?.getBoundingClientRect().height,legacyStatusPresent:!!document.querySelector('.composer-top-row .structured-status-bar'),legacyTodoExpanded:document.querySelector('.composer-top-row .todo-progress')?.classList.contains('expanded')??false,headerHeight:document.querySelector('.main-header-row')?.getBoundingClientRect().height,headerGeometry:(()=>{const n=document.querySelector('.main-header-row');if(!n)return null;const c=getComputedStyle(n),r=n.getBoundingClientRect();return {font:c.font,lineHeight:c.lineHeight,boxSizing:c.boxSizing,width:r.width,children:Array.from(n.children).map(n=>({class:n.className,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}))}})(),workspaceTabbarHeight:document.querySelector('.workspace-tab-bar')?.getBoundingClientRect().height,standaloneTabCount:document.querySelectorAll('[data-session-tabs="standalone"]').length,workspaceNavHeight:document.querySelector('.workspace-mobile-navigation')?.getBoundingClientRect().height,composerHeight:document.querySelector('.input-panel').getBoundingClientRect().height,outputHeight:document.querySelector('#output').getBoundingClientRect().height}}};
` }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
let terminalScriptRequests = 0;
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/xterm.js") { terminalScriptRequests++; res.setHeader("content-type", "text/javascript"); res.end(readFileSync("src/web-ui/content/vendor/xterm/xterm.bundle.js")); return; }
  if (req.url === "/xterm.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/vendor/xterm/xterm.css")); return; }
  if (req.url === "/style.css") { res.setHeader("content-type", "text/css"); res.end((productionChrome ? readFileSync("src/web-ui/content/tailwind.css", "utf8") : "") + readFileSync("src/web-ui/content/styles.css", "utf8")); return; }
  if (req.url === "/api/workspace-tasks/source-empty-task") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id:"source-empty-task", workspaceId:"source-workspace", name:"own-empty-task", cwd:"/tmp/wand-terminal-creation-long-owned-fixture-cwd", sessions:[], layout:{type:"windows",windows:[],activeWindowId:null} })); return; }
  if (req.url.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wand-xterm-script" content="/xterm.js"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/xterm.css"><style>html,body{margin:0;height:100%}.main-content{display:flex;flex-direction:column;height:100%;position:relative}.header{height:52px;flex:none}.composer{height:120px;flex:none}#output,#chat-output,#blank-chat{position:relative;flex:1;min-height:0;overflow:hidden}#chat-output{display:flex}</style></head><body><main class="main-content">${productionChrome ? '<div id="fixture-header" style="display:contents"></div>' : '<div class="header">已有对话保持可见</div>'}<div id="output" class="hidden" style="display:none"></div><div id="chat-output">已有对话内容</div><div id="blank-chat" style="display:none">首次空白页面</div><div class="input-panel${productionChrome ? '' : ' composer'}">输入区</div></main><script src="/app.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, 390, 900);
  await browser.wait("!!window.geometryFixture");
  await browser.evaluate("geometryFixture.conversationUi.show();geometryFixture.state.sessions=[{id:'restored-pty',sessionKind:'pty',status:'running',output:''}];geometryFixture.state.selectedId='restored-pty';geometryFixture.state.currentView='terminal';document.querySelector('#output').setAttribute('inert','');geometryFixture.initTerminal()");
  await browser.settle();
  const conversationOwner = await browser.evaluate("({active:geometryFixture.conversationUi.getSnapshot().active,terminalVendorLoaded:!!globalThis.XTermLib,terminalCreated:!!geometryFixture.state.terminal})");
  conversationOwner.terminalScriptRequests=terminalScriptRequests;
  assert.equal(conversationOwner.active,true);assert.equal(conversationOwner.terminalVendorLoaded,false);assert.equal(conversationOwner.terminalCreated,false);assert.equal(terminalScriptRequests,0,"persisted conversation ownership does not request xterm");
  // Explicit navigation changes the owner before React's old inert DOM is committed.
  await browser.evaluate("geometryFixture.conversationUi.suspend();geometryFixture.initTerminal()");
  await browser.wait("!!geometryFixture.state.terminal"); await browser.settle();
  assert.equal(await browser.evaluate("document.querySelector('#output').hasAttribute('inert')"),true);
  assert.equal(await browser.evaluate("!!geometryFixture.state.terminal"),true);
  conversationOwner.explicitNavigationWithStaleInert=true;
  const cases = [];
  for (const width of productionChrome ? [320,390,1440] : [390]) for (const kind of ["structured", "blank", ...(productionChrome ? ["codex", "opencode"] : [])]) {
    await browser.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await browser.evaluate(`geometryFixture.setTarget(${JSON.stringify(kind==="codex"||kind==="opencode"?{kind:"pty",provider:kind}:{kind:"shell",provider:undefined})});geometryFixture.configure(${JSON.stringify(kind==="codex"||kind==="opencode"?"blank":kind)})`);
    const initial = await browser.evaluate("geometryFixture.stats()");
    const beforeStyles = await browser.evaluate("geometryFixture.styles()");
    if(productionChrome)await browser.evaluate("window.__oldTopRowNodes=Array.from(document.querySelector('.composer-top-row').childNodes);true");
    const posted = await browser.evaluate("geometryFixture.prepare()");
    await browser.settle(); const prepared = await browser.evaluate("geometryFixture.stats()");
    assert.deepEqual(await browser.evaluate("geometryFixture.styles()"), beforeStyles, "projection restores exact inline styles");
    if(productionChrome){assert.equal(await browser.evaluate("window.__oldTopRowNodes.every((n,index)=>document.querySelector('.composer-top-row').childNodes[index]===n)"),true,"old status and todo nodes survive prediction");assert.equal(prepared.legacyStatusPresent,true);assert.equal(prepared.legacyTodoExpanded,true)}
    await browser.evaluate("geometryFixture.show()");
    await browser.settle(); const actual = await browser.evaluate("geometryFixture.show()");
    for (const field of ["display", "visibility", "chatDisplay", "blankDisplay", "composerDisplay"]) assert.equal(prepared[field], initial[field], `measurement restores ${field}`);
    if(posted.cols!==actual.cols||posted.rows!==actual.rows)console.log(JSON.stringify({mismatch:{kind,initial,posted,prepared,actual,shownStats:await browser.evaluate("geometryFixture.stats()"),probeRects:await browser.evaluate("window.probeRects")}}));
    assert.deepEqual({cols:posted.cols,rows:posted.rows}, actual, "first POST dimensions match the first displayed terminal");
    const shown = await browser.evaluate("geometryFixture.stats()");
    if (productionChrome) {assert.equal(shown.standaloneTabCount,1,"ungrouped creation has exactly one native tab row");assert.equal(shown.composerTopHeight,0);assert.equal(shown.legacyStatusPresent,false);assert.equal(shown.legacyTodoExpanded,false)}
    cases.push({ kind, width, initial, posted, prepared, actual, shown, dimensionsMatch: true, layoutStylesRestored: true });
  }
  const emptyTaskCases=[];
  if(productionChrome) {
    for(const {kind,width} of [{kind:"shell",width:390},{kind:"codex",width:390},{kind:"shell",width:1440},{kind:"codex",width:1440}]) {
      await browser.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
      await browser.evaluate(`geometryFixture.setTarget(${JSON.stringify(kind==="shell"?{kind:"shell",provider:undefined,command:undefined}:{kind:"pty",provider:"codex",command:"codex"})});geometryFixture.prepareTask()`);
      const initial=await browser.evaluate("geometryFixture.stats()");const beforeStyles=await browser.evaluate("geometryFixture.styles()");
      const posted=await browser.evaluate("geometryFixture.prepare()");const prepared=await browser.evaluate("geometryFixture.stats()");
      assert.deepEqual(await browser.evaluate("geometryFixture.styles()"),beforeStyles);
      assert.equal(await browser.evaluate("document.querySelectorAll('[data-terminal-creation-space]').length"),0);
      const actual=await browser.evaluate("geometryFixture.show()");const shown=await browser.evaluate("geometryFixture.stats()");
      assert.deepEqual({cols:posted.cols,rows:posted.rows},actual,"first active empty task POST dimensions match its first window");
      assert.equal(initial.headerHeight,undefined);assert.equal(shown.headerHeight,undefined);
      assert.ok(shown.workspaceTabbarHeight>0);assert.equal(shown.workspaceNavHeight,initial.workspaceNavHeight);
      emptyTaskCases.push({kind,width,initial,posted,prepared,shown,actual,dimensionsMatch:true,stylesRestored:true});
    }
    await browser.send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:false});
    await browser.evaluate("geometryFixture.configure('blank');geometryFixture.setTarget({kind:'shell',workspaceTaskId:undefined});geometryFixture.prepare().then(()=>geometryFixture.show())");
  }
  const taskExitCases=[];
  if(productionChrome) for(const width of [320,390,1440]) for(const existing of [false,true]) {
    await browser.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await browser.evaluate("geometryFixture.setTarget({kind:'shell'});geometryFixture.prepareTask()");
    if(existing) await browser.evaluate("geometryFixture.prepare().then(()=>geometryFixture.show())");
    await browser.evaluate("geometryFixture.setTarget({kind:'shell',workspaceTaskId:undefined})");
    const initial=await browser.evaluate("geometryFixture.stats()"),beforeStyles=await browser.evaluate("geometryFixture.styles()");
    const posted=await browser.evaluate("geometryFixture.prepare()"),prepared=await browser.evaluate("geometryFixture.stats()");
    assert.deepEqual(await browser.evaluate("geometryFixture.styles()"),beforeStyles,"unbound projection restores the old task chrome");
    if(existing){assert.equal(prepared.cols,initial.cols);assert.equal(prepared.rows,initial.rows)}
    const actual=await browser.evaluate("geometryFixture.show()"),shown=await browser.evaluate("geometryFixture.stats()");
    assert.deepEqual({cols:posted.cols,rows:posted.rows},actual,"task exit predicts the new header plus standalone tabs");
    assert.equal(initial.headerHeight,undefined);assert.ok(shown.headerHeight>0);assert.equal(shown.workspaceNavHeight,undefined);assert.equal(shown.standaloneTabCount,1);
    taskExitCases.push({width,existing,initial,posted,prepared,actual,shown,dimensionsMatch:true,stylesRestored:true,oldInstanceUnresized:!existing||(prepared.cols===initial.cols&&prepared.rows===initial.rows)});
  }
  let visiblePrediction = null, predictionFailureRestores = null;
  if(productionChrome) {
    await browser.send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:false});
    const beforeProbes=await browser.evaluate("window.probeRects.length");
    await browser.evaluate("geometryFixture.setTarget({kind:'shell',provider:undefined})");
    const visiblePosted=await browser.evaluate("geometryFixture.prepare()");
    const visibleActual=await browser.evaluate("geometryFixture.show()");
    assert.deepEqual({cols:visiblePosted.cols,rows:visiblePosted.rows},visibleActual);
    assert.ok(await browser.evaluate("window.probeRects.length")>beforeProbes,"explicit creation context projects the future header even when output already has geometry");
    visiblePrediction={posted:visiblePosted,actual:visibleActual,projected:true,standaloneTabCount:await browser.evaluate("geometryFixture.stats().standaloneTabCount")};
    assert.equal(visiblePrediction.standaloneTabCount,1);
    await browser.evaluate("geometryFixture.hideExisting(true);document.querySelector('[data-session-tabs=standalone]').style.setProperty('display','none','important')");
    const hiddenRowBefore=await browser.evaluate("geometryFixture.styles()"),hiddenRowInitial=await browser.evaluate("geometryFixture.stats()");
    const hiddenRowPosted=await browser.evaluate("geometryFixture.prepare()"),hiddenRowPrepared=await browser.evaluate("geometryFixture.stats()");
    assert.deepEqual(await browser.evaluate("geometryFixture.styles()"),hiddenRowBefore);
    assert.equal(hiddenRowPrepared.cols,hiddenRowInitial.cols);assert.equal(hiddenRowPrepared.rows,hiddenRowInitial.rows);
    const hiddenRowActual=await browser.evaluate("document.querySelector('[data-session-tabs=standalone]').style.removeProperty('display');geometryFixture.show()");
    assert.deepEqual({cols:hiddenRowPosted.cols,rows:hiddenRowPosted.rows},hiddenRowActual,"an existing hidden standalone row is counted once");
    visiblePrediction.hiddenRow={posted:hiddenRowPosted,actual:hiddenRowActual,stylesRestored:true,oldInstanceUnresized:true};
    await browser.evaluate("geometryFixture.hideExisting();window.probeThrow=true");
    const failureStyles=await browser.evaluate("geometryFixture.styles()");
    await browser.evaluate("geometryFixture.prepare()");
    assert.deepEqual(await browser.evaluate("geometryFixture.styles()"),failureStyles,"a failed future chrome projection restores styles");
    assert.equal(await browser.evaluate("document.querySelectorAll('[data-terminal-creation-measure]').length"),0);
    await browser.evaluate("window.probeThrow=false");
    predictionFailureRestores=true;
  }
  if(process.env.WAND_TERMINAL_REUSE_PROBE==="1") {
    await browser.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await browser.evaluate("geometryFixture.setTarget({kind:'shell'});geometryFixture.configure('blank');geometryFixture.prepare()");
    await browser.settle(); await browser.evaluate("geometryFixture.show();geometryFixture.hideExisting()");
    await browser.send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:false});
    await browser.settle(); const reuseInitial=await browser.evaluate("geometryFixture.stats()");
    const reusePosted=await browser.evaluate("geometryFixture.prepare()");
    const reusePrepared=await browser.evaluate("geometryFixture.stats()");
    const reuseActual=await browser.evaluate("geometryFixture.show()");
    const dimensionsMatch=reusePosted.cols===reuseActual.cols&&reusePosted.rows===reuseActual.rows;
    console.log(JSON.stringify({reuseCase:{initial:reuseInitial,posted:reusePosted,prepared:reusePrepared,actual:reuseActual,dimensionsMatch,oldInstanceUnresized:reusePrepared.cols===reuseInitial.cols&&reusePrepared.rows===reuseInitial.rows}}));
    assert.ok(dimensionsMatch,"hidden reused terminal yields future slot dimensions");
    assert.equal(reusePrepared.cols,reuseInitial.cols,"new session measurement does not resize the old terminal");
    assert.equal(reusePrepared.rows,reuseInitial.rows,"new session measurement does not resize the old terminal rows");
    if(productionChrome) {
      await browser.evaluate("geometryFixture.hideExisting();const n=document.querySelector('#input-box');n.value='own draft\\n'.repeat(30);n.style.height='160px';n.style.minHeight='160px';n.setSelectionRange(7,19);n.scrollTop=80;window.ownDraftBefore={value:n.value,style:n.style.cssText,selectionStart:n.selectionStart,selectionEnd:n.selectionEnd,scrollTop:n.scrollTop,composerClass:document.querySelector('.input-composer').className}");
      const blankPrediction=await browser.evaluate("geometryFixture.prepare()");
      const retained=await browser.evaluate("(()=>{const n=document.querySelector('#input-box');return{value:n.value,style:n.style.cssText,selectionStart:n.selectionStart,selectionEnd:n.selectionEnd,scrollTop:n.scrollTop,composerClass:document.querySelector('.input-composer').className}})()");
      assert.deepEqual(retained,await browser.evaluate("window.ownDraftBefore"),"future blank input measurement preserves the old draft, inline styles and presentation class");
      const blankActual=await browser.evaluate("geometryFixture.show()");
      assert.deepEqual({cols:blankPrediction.cols,rows:blankPrediction.rows},blankActual,"a tall old draft cannot inflate the new blank Shell dimensions");
      console.log(JSON.stringify({futureBlankDraft:{posted:blankPrediction,actual:blankActual,draftAndStylesRetained:true}}));
    }
  }
  await browser.evaluate("geometryFixture.configure('blank');window.originalOpen=XTermLib.Terminal.prototype.open;XTermLib.Terminal.prototype.open=function(){throw new Error('fixture open failure')}");
  const failureBefore = await browser.evaluate("geometryFixture.stats()");
  await browser.evaluate("geometryFixture.prepare()");
  const failureAfter = await browser.evaluate("geometryFixture.stats()");
  await browser.evaluate("XTermLib.Terminal.prototype.open=window.originalOpen");
  for (const field of ["display", "visibility", "chatDisplay", "blankDisplay", "composerDisplay"]) assert.equal(failureAfter[field], failureBefore[field], `failure restores ${field}`);
  assert.equal(await browser.evaluate("geometryFixture.state.terminalInitializing"), false);
  const probeLeaks=await browser.evaluate("({count:document.querySelectorAll('[data-terminal-creation-measure],[data-terminal-creation-space]').length,duplicateIds:Array.from(document.querySelectorAll('[id]')).map(n=>n.id).filter((id,i,a)=>a.indexOf(id)!==i).length})");
  assert.equal(probeLeaks.count,0);assert.equal(probeLeaks.duplicateIds,0);
  assert.deepEqual(browser.errors,[],"the source browser has no uncaught runtime errors");
  console.log(JSON.stringify({ productionChrome, conversationOwner, cases, emptyTaskCases, taskExitCases, probeRects:await browser.evaluate("window.probeRects"), visiblePrediction, predictionFailureRestores, failureRestoresLayout: true, probeLeaks, pageErrors:browser.errors }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
