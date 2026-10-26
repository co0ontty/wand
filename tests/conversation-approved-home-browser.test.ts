import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { retainedGroupChatFixture } from "./conversation-group-visibility-fixture.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("approved home keeps the reading axis and real roster without a live head", {
  skip: process.env.WAND_APPROVED_HOME_BROWSER !== "1", timeout: 120_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), out = process.env.WAND_CHAT_SURFACE_OUTPUT || join(root, "output/home-approved-20261011/browser");
  mkdirSync(out, { recursive: true });
  const source = `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme';
    import {PortalContainerProvider,WandButton} from './src/web-ui/react/ui';
    import {installReactUiStyles} from './src/web-ui/react/styles';
    import {installSidebarStyles} from './src/web-ui/react/shell/sidebar-styles';
    import {notifyConversationSessionPreview} from './src/web-ui/react/conversations/session-preview';
    import {ConversationHome} from './src/web-ui/react/conversations/home';
    import {EmployeeProfileHost} from './src/web-ui/react/agents/employee-profile';
    import {ConversationNavigation,ConversationSidebarList,ConversationSidebarTools} from './src/web-ui/react/conversations/sidebar';
    import {conversationUi,conversationDraftKey} from './src/web-ui/react/conversations/state';
    import {ComposerStore} from './src/web-ui/browser/composer';
    import {configureTeamChatComposerRuntime} from './src/web-ui/react/ai-teams/composer-bridge';
    import {setWandTheme} from './src/web-ui/react/theme-preference';
    import './src/web-ui/react/ai-teams/chunk-entry';
    installReactUiStyles();installSidebarStyles();setWandTheme('blue');
    const store=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>store.read(id),edit:(id,c)=>store.edit(id,c),subscribe:f=>store.subscribe(f),submit:(id,text,f)=>store.submit(id,text,f),transfer:(a,b,r)=>store.transfer(a,b,r)});
    window.__homeLongTasks=[];new PerformanceObserver(l=>__homeLongTasks.push(...l.getEntries().map(e=>({duration:e.duration,start:e.startTime})))).observe({type:'longtask',buffered:true});
    conversationUi.select('dm_design');globalThis.fixture={store,ui:conversationUi,opened:[],preview:notifyConversationSessionPreview,key:conversationDraftKey,theme:setWandTheme};
    function Stage(){const [collapsed,setCollapsed]=React.useState(false),[mobileOpen,setMobileOpen]=React.useState(false);return <div className="design-stage app-container"><div className="main-layout" style={{display:"flex",height:"100%"}}>
      <aside className={'sidebar sidebar-refined sidebar-home '+(collapsed?'collapsed':'')} data-mobile-open={mobileOpen} style={{width:collapsed?112:344,display:'flex'}}>
        <div className="sidebar-navigation-rail"><div className="design-brand">W</div><ConversationNavigation activePage="chats" teamAttention={0} onNavigate={()=>{}}/></div>
        <div className="sidebar-list-panel"><div className="sidebar-header" style={{display:'flex',flexDirection:collapsed?'column':'row',alignItems:'center',gap:8,padding:collapsed?4:12}}><strong hidden={collapsed} className="sidebar-title">对话</strong><ConversationSidebarTools enabled onNavigate={()=>setMobileOpen(false)}/><WandButton kind="ghost" aria-label="收起或展开目录" onClick={()=>setCollapsed(!collapsed)}>{collapsed?'展开':'收起'}</WandButton></div>
          <div style={{overflow:'auto',height:'calc(100% - 70px)',padding:'0 8px'}}><ConversationSidebarList compact={collapsed} onNavigate={()=>setMobileOpen(false)}/></div></div>
      </aside><main className="main-content-conversation" style={{position:'relative',flex:1,minWidth:0}}><ConversationHome visible sidebarOpen={mobileOpen} onOpenSidebar={()=>setMobileOpen(!mobileOpen)} onOpenSession={id=>fixture.opened.push(id)}/></main>
    <EmployeeProfileHost mobile={false}/></div></div>}
    createRoot(document.getElementById('root')).render(<WandUiProvider><PortalContainerProvider container={document.getElementById('portals')}><Stage/></PortalContainerProvider></WandUiProvider>);
  `;
  await build({ plugins: [retainedGroupChatFixture], stdin: { contents: source, resolveDir: root, loader: "tsx" }, outfile: join(out, "app.js"), bundle: true, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const agent = { provider: "pi", engine: "cli", model: "fixture-only", mode: "default", kind: "structured" };
  const employees = [
    { id: "design", name: "示例伙伴", avatar: "plush-cat:v1:silver", agents: [agent], duty: "", createdAt: "", updatedAt: "" },
    { id: "other", name: "另一位伙伴", avatar: "plush-cat:v1:orange", agents: [agent], duty: "", createdAt: "", updatedAt: "" },
  ];
  const members = Array.from({ length: 12 }, (_, i) => ({ id: `member-${i}`, employeeId: i === 0 ? "design" : i === 1 ? "other" : `person-${i}`, name: `实际成员${i + 1}`, avatar: i < 2 ? employees[i].avatar : undefined, agents: [agent], duty: "", isLeader: i === 0 }));
  const reply = "## 建议保留历史，默认只看当前\n\n当前计划、历史计划与执行记录需要分别表达。\n\n" + Array.from({ length: 16 }, (_, i) => `### ${i + 1}. 清楚呈现执行结果\n\n保留已经完成的记录。用户可以继续同一项工作，失败时输入与附件不会消失。`).join("\n\n");
  const messages = [{ messageId: "reply", conversationId: "dm_design", role: "assistant", content: [], createdAt: "2026-10-11T01:00:00Z", sessionLink: { sessionId: "design-session", title: "整理当前计划与历史记录" }, sessionPreview: { status: "done", text: reply } }];
  const dm = { id: "dm_design", title: "示例伙伴", kind: "dm", peerEmployeeId: "design", messages, tasks: [], runDetails: [], preview: "建议保留历史，默认只看当前", messageAt: "2026-10-11T01:00:00Z", updatedAt: "", joinedVersions: {}, memberUnavailableReasons: {} };
  const group = { ...dm, id: "group-design", title: "成员组合示例", kind: "group", peerEmployeeId: null, team: { members }, messages: [], preview: "所有实际成员都在头像中", tasks: [] };
  let writes = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(out, "app.js"))); return; }
    if (path === "/tailwind.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/tailwind.css"))); return; }
    if (path === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    if (path.includes("ChunkSrc") || path.includes("plush-avatar")) { res.setHeader("content-type", "text/javascript"); res.end(path.toLowerCase().includes("plush") ? readFileSync(join(root, "src/web-ui/content/plush-avatar.js")) : ""); return; }
    if (path.startsWith("/api/")) {
      if (req.method !== "GET") { writes++; res.statusCode = 405; res.end("Readonly fixture"); return; }
      let body: unknown = {};
      if (path === "/api/config") body = { defaultCwd: "/tmp/fixture-only", userProfile: { name: "我" } };
      else if (path === "/api/ai-teams") body = [];
      else if (path === "/api/sessions") body = [];
      else if (path === "/api/silicon-employees") body = { employees };
      else if (path === "/api/silicon-employees/design") body = employees[0];
      else if (path === "/api/conversations") body = { conversations: [dm, { ...dm, id: "dm_other", title: "另一位伙伴", peerEmployeeId: "other", messages: [] }, group] };
      else if (path === "/api/conversations/dm_design") body = dm;
      else if (path === "/api/conversations/group-design") body = group;
      else if (path.startsWith("/api/sessions/")) body = { id: "design-session", status: "idle", messages: [{ role: "assistant", usage: { inputTokens: 128, outputTokens: 256 } }] };
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); return;
    }
    res.setHeader("content-type", "text/html"); res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}.design-stage{position:fixed;top:var(--conversation-frame-top,0px);left:var(--conversation-frame-inline,0px);right:var(--conversation-frame-inline,0px);height:calc(100% - var(--conversation-frame-top,0px) - var(--conversation-frame-bottom,0px));overflow:hidden}.design-brand{padding:12px;text-align:center;font-weight:700}.sidebar{position:relative!important;height:100%;flex:none}.sidebar-list-panel{min-width:0}@media(max-width:640px){.design-stage .sidebar{display:none!important}.design-stage .sidebar[data-mobile-open=true]{display:flex!important;position:absolute!important;inset:0 auto 0 0;z-index:20;width:calc(100vw - 32px)!important}}</style><div id="root"></div><div id="portals" class="wand-ui-portals"></div><script src="/app.js"></script>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}`, 1536, 1024);
  const checkInputHitTargets = async (width: number) => {
    const points = await browser.evaluate("(()=>{const r=document.querySelector('.conversation-sender textarea').getBoundingClientRect();return [[r.x+8,r.y+1],[r.right-8,r.y+1],[r.x+8,r.bottom-1],[r.right-8,r.bottom-1],[r.x+r.width/2,r.y+1]]})()");
    for (const [x, y] of points) {
      assert.equal(await browser.evaluate(`document.elementFromPoint(${x},${y})===document.querySelector('.conversation-sender textarea')`), true, `${width}px textarea edge must not be covered by the companion profile button at ${x},${y}`);
      await browser.evaluate("document.querySelector('.conversation-sender textarea').blur();true");
      for (const type of ["mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      assert.equal(await browser.evaluate("document.activeElement===document.querySelector('.conversation-sender textarea')"), true, `${width}px native edge click focuses the original input`);
    }
  };
  try {
    await browser.wait("!!document.querySelector('.conversation-sender textarea')");
    await browser.wait("document.querySelectorAll('.conversation-group-mosaic .conversation-group-cell').length===13"); await browser.settle();
    assert.equal(await browser.evaluate("document.querySelectorAll('.conversation-group-mosaic .conversation-group-cell').length"), 13);
    assert.equal(await browser.evaluate("!!document.querySelector('[aria-label=通讯录]')"), false);
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.conversation-reply-body')).overflowY"), "visible");
    await browser.wait("[\"live\",\"static\"].includes(document.querySelector('.conversation-companion .composer-floating-avatar')?.dataset.avatarChoice)");
    assert.equal(await browser.evaluate("document.querySelectorAll('.conversation-message-scroll canvas').length"), 0, "reply history stays on the flat face");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-companion .composer-floating-avatar').dataset.avatarChoice==='static' ? document.querySelectorAll('.conversation-companion canvas').length : 0"), 0, "a weak browser must not keep a live canvas");
    const desktopGeometry = await browser.evaluate("(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {frame:{x:r('.app-container').x,y:r('.app-container').y},sidebar:r('.sidebar').width,rail:r('.sidebar-navigation-rail').width,composer:r('.conversation-sender').height,bodyFont:parseFloat(getComputedStyle(document.querySelector('.conversation-reply-body')).fontSize)}})()");
    assert.ok(desktopGeometry.frame.x === 0 && desktopGeometry.frame.y === 0, "conversation page fills the window like every other page");
    assert.ok(desktopGeometry.sidebar === 344 && desktopGeometry.rail === 56, "wide chat shares the compact sidebar scale with workspaces");
    assert.ok(desktopGeometry.bodyFont <= 18, "conversation reading scale matches the app-wide density");
    await browser.evaluate("document.querySelector('main').classList.remove('main-content-conversation');true");
    assert.equal(await browser.evaluate("document.querySelector('.app-container').getBoundingClientRect().x"), 0, "a mounted hidden home cannot frame another active page");
    await browser.evaluate("document.querySelector('main').classList.add('main-content-conversation');true");
    await checkInputHitTargets(1536);
    await browser.click('.conversation-companion');
    await browser.wait("!!document.querySelector('[aria-label=\"关闭资料面板\"]')");
    await browser.click('[aria-label="关闭资料面板"]');
    await browser.settle();
    assert.equal(await browser.evaluate("document.activeElement===document.querySelector('.conversation-companion')"), true, "the companion still opens its profile and restores keyboard focus");
    await browser.screenshot(join(out, "desktop-long.png"));
    await browser.evaluate("document.querySelector('.conversation-message-scroll').scrollTop=0;true");
    await browser.wait("document.querySelector('.conversation-new-messages button')?.textContent.includes('回到最新')");
    let streamed = reply;
    let height = await browser.evaluate("document.querySelector('.conversation-message-scroll').scrollHeight");
    for (let index = 0; index < 3; index++) {
      streamed += `\n\n### 新进展 ${index + 1}\n\n这是一段真实换行的流式追加，用户仍在阅读较早的内容。`;
      messages[0].sessionPreview = { status: "running", text: streamed };
      await browser.evaluate(`fixture.preview({sessionId:'design-session',conversationId:'dm_design',preview:{status:'running',text:${JSON.stringify(streamed)}}});true`);
      await browser.settle();
      const nextHeight = await browser.evaluate("document.querySelector('.conversation-message-scroll').scrollHeight");
      assert.ok(nextHeight > height, "streamed paragraphs really increase the scroll height");
      height = nextHeight;
      assert.equal(await browser.evaluate("document.querySelector('.conversation-message-scroll').scrollTop"), 0, "same-turn growth preserves history position");
    }
    await browser.screenshot(join(out, "reading-history.png"));
    await browser.evaluate("document.querySelector('.conversation-new-messages button').focus();true");
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await browser.settle();
    assert.ok(await browser.evaluate("(()=>{const el=document.querySelector('.conversation-message-scroll');return el.scrollHeight-el.scrollTop-el.clientHeight})()") < 3, "native keyboard activation reaches the tail");
    streamed += "\n\n### 最后一次追加\n\n返回最新以后，这段回复继续增长，视口应该继续贴尾。";
    messages[0].sessionPreview = { status: "done", text: streamed };
    await browser.evaluate(`fixture.preview({sessionId:'design-session',conversationId:'dm_design',preview:{status:'done',text:${JSON.stringify(streamed)}}});true`);
    await browser.settle();
    const tail = await browser.evaluate("(()=>{const el=document.querySelector('.conversation-message-scroll');return {height:el.scrollHeight,gap:el.scrollHeight-el.scrollTop-el.clientHeight}})()");
    assert.ok(tail.height > height, "output grows again after the keyboard action");
    assert.ok(tail.gap < 3, `keyboard return to latest resumes following same-turn growth: ${JSON.stringify(tail)}`);
    assert.equal(await browser.evaluate("!!document.querySelector('.conversation-new-messages button')"), false);
    await browser.click('.conversation-sender textarea');
    await browser.send("Input.imeSetComposition", { text: "中文候选", selectionStart: 4, selectionEnd: 4 });
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
    assert.equal(writes, 0, "IME Enter never submits the candidate text");
    await browser.send("Input.insertText", { text: "中文确认" });
    await browser.send("Input.insertText", { text: "，继续输入" });
    assert.equal(await browser.evaluate("document.querySelector('.conversation-sender textarea').value"), "中文确认，继续输入");
    await browser.evaluate("fixture.input=document.querySelector('.conversation-sender textarea');fixture.input.setSelectionRange(2,4);true");
    await browser.click('.composer-expand-editor');
    assert.equal(await browser.evaluate("document.querySelector('.composer-expand-editor').getAttribute('aria-expanded')"), "true");
    await browser.click('.composer-expand-editor');
    assert.deepEqual(await browser.evaluate("({same:fixture.input===document.querySelector('.conversation-sender textarea'),value:fixture.input.value,start:fixture.input.selectionStart,end:fixture.input.selectionEnd,focused:document.activeElement===fixture.input})"), {same:true,value:"中文确认，继续输入",start:2,end:4,focused:true}, "expanded editing returns to the same draft, native node, caret and focus");
    await browser.click('.conversation-config-trigger');
    await browser.click('.conversation-preference-details');
    await browser.key('Escape');
    assert.equal(await browser.evaluate("fixture.input.value"), "中文确认，继续输入", "cancelling configuration preserves the current draft");
    await browser.evaluate("fixture.store.edit(fixture.key('dm_design'),{text:''});true");


    await browser.click('[aria-label="收起或展开目录"]'); await browser.screenshot(join(out, "desktop-collapsed.png"));
    await browser.click('[aria-label="收起或展开目录"]');
    await browser.wait("!document.querySelector('.sidebar').classList.contains('collapsed')");
    await browser.click('[data-conversation-id="group-design"] .conversation-row-open');
    await browser.wait("document.querySelector('.conversation-heading-title')?.textContent==='成员组合示例'");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-heading .conversation-group-mosaic').getAttribute('aria-label').includes('实际成员12')"), true);
    await browser.screenshot(join(out, "group-roster.png"));
    await browser.click('[data-conversation-id="dm_design"] .conversation-row-open');
    await browser.wait("!!document.querySelector('.conversation-companion')");
    for (const theme of ["warm", "blue", "forest", "mauve", "graphite"]) { await browser.evaluate(`fixture.theme('${theme}');true`); await browser.screenshot(join(out, `theme-${theme}.png`)); }
    await browser.evaluate("fixture.theme('blue');true");
    const approvedReply = "## 建议保留历史，默认只看当前\n\n当前计划、历史计划与执行记录需要分别表达。\n\n重复计划执行过一次，仍属于当前计划。计划结束不代表执行成功。\n\n取消记录放在历史中，避免混入正在执行的列表。";
    messages[0].sessionPreview = { status: "done", text: approvedReply };
    await browser.evaluate(`fixture.preview({sessionId:'design-session',conversationId:'dm_design',preview:{status:'done',text:${JSON.stringify(approvedReply)}}});true`);
    await browser.settle();
    await browser.screenshot(join(out, "desktop-approved.png"));
    for (const width of [1180, 768, 640, 390, 320]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: width === 768 ? 512 : 900, deviceScaleFactor: 1, mobile: false }); await browser.settle();
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      assert.equal(await browser.evaluate("(()=>{const r=document.querySelector('.conversation-submit').getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight})()"), true);
      await checkInputHitTargets(width);
      await browser.screenshot(join(out, `narrow-${width}.png`));
    }
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await browser.click('.conversation-config-trigger');
    await browser.click('.conversation-preference-details');
    assert.equal(await browser.evaluate("!!document.querySelector('.conversation-preference-details')"), true, "clicking inside the portal keeps its owner open");
    await browser.key('Escape');
    assert.equal(await browser.evaluate("document.activeElement.classList.contains('conversation-config-trigger')"), true);
    await browser.click('.conversation-reply-footer button');
    assert.equal(await browser.evaluate("fixture.opened.at(-1)"), "design-session");
    assert.equal(writes, 0); assert.deepEqual(browser.errors, []);
    const performance = await browser.evaluate("(()=>{const n=window.performance.getEntriesByType('navigation')[0];return {ttfbMs:n.responseStart-n.requestStart,domContentLoadedMs:n.domContentLoadedEventEnd,loadMs:n.loadEventEnd,longTasks:window.__homeLongTasks}})()");
    writeFileSync(join(out, "result.json"), JSON.stringify({ passed: true, desktopGeometry, performance, roster: 13, widths: [1536, 1180, 768, 640, 390, 320], themes: 5, writes, scope: "actual production components in Chrome, readonly fixture; no installed service deployment" }, null, 2));
  } catch (error) {
    writeFileSync(join(out, "failure.json"), JSON.stringify({ error: String(error), errors: browser.errors, body: await browser.evaluate("document.body.textContent"), avatars: await browser.evaluate("document.querySelectorAll('.conversation-group-cell').length") }, null, 2));
    throw error;
  } finally { await browser.close(); server.close(); }
});
