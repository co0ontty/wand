import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

// Real production controls and Chrome input; repository fixtures never execute a model.
test("sidebar hierarchy, menu ownership, navigation and responsive geometry", {
  skip: process.env.WAND_SIDEBAR_UX_BROWSER !== "1", timeout: 600_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-sidebar-ux-test-"));
  const artifacts = join(root, process.env.WAND_SIDEBAR_UX_OUTPUT ?? "output/sidebar-ux");
  mkdirSync(artifacts, { recursive: true });
  const source = `import * as React from "react";
import { createRoot } from "react-dom/client";
import { ShellSidebar } from "./src/web-ui/react/shell/shell-sidebar";
import { ShellTopbar } from "./src/web-ui/react/shell/shell-topbar";
import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
import { UiStoreProvider } from "./src/web-ui/react/shell/ui-store-react";
import { WandUiProvider } from "./src/web-ui/react/theme";
import { installReactUiStyles } from "./src/web-ui/react/styles";
import { configureWorkspacesRuntime } from "./src/web-ui/react/workspaces/controller";
import { setActiveWorkspaceContext } from "./src/web-ui/react/workspaces/workspace-context";
import { newSessionController, newSessionStore, configureNewSessionRuntime } from "./src/web-ui/react/new-session/controller";
import { conversationUi } from "./src/web-ui/react/conversations/state";
import { overlayStore } from "./src/web-ui/react/overlay-controller";
import { WandDialog } from "./src/web-ui/react/ui";
installReactUiStyles();
const mobile = innerWidth < 600;
let snapshot = {auth:{phase:"authenticated"},viewport:{mobile,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},
layout:{sessionsDrawerOpen:true,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:mobile,sidebarAnchored:!mobile,sessionsBackdropVisible:mobile,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:"chat"},
selected:{id:"s1",source:"wand",provider:"pi",kind:"structured",workspaceId:"w1",workspaceTaskId:"t1"},sidebar:{groups:[],interactiveCount:4,totalCount:4,manageMode:false,selectedCount:0},
topbar:{title:"",description:"",statusLabel:"",statusTone:"idle",cwd:"/work/atlas",currentTask:"",titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:true,blank:false,composer:true}};
const memory = new MemoryUiAdapter(snapshot);
const update = (layout)=>{snapshot={...snapshot,layout:{...snapshot.layout,...layout}};memory.setSnapshot(snapshot,{sync:true});};
window.fixture={memory,update,selected:[],closed:0,setContext:setActiveWorkspaceContext,creation:()=>newSessionStore.getSnapshot(),closeCreation:()=>newSessionController.close(),conversation:conversationUi};
const store={getSnapshot:()=>memory.getSnapshot(),subscribe:memory.subscribe.bind(memory),dispatch(action){memory.dispatch(action);if(action.type==="layout.drawer.collapse")update({sidebarCollapsed:!snapshot.layout.sidebarCollapsed});if(action.type==="layout.drawer.close")update({sessionsDrawerOpen:false,sessionsBackdropVisible:false});if(action.type==="workspace.new")newSessionController.open();}};
configureWorkspacesRuntime({selectSession(id){fixture.selected.push(id);},openTask(payload){fixture.selected.push(payload.preferredSessionId||payload.taskId);},openWorkspace(){},closeWorkspace(){fixture.closed++;},refreshSessions:async()=>{},toast(){},onOpen(){},onClose(){}});
configureNewSessionRuntime({onOpen(){},onClose(){}});
function DialogHost(){const state=React.useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot,overlayStore.getSnapshot);const dialog=state.activeDialog;
  return dialog?<WandDialog key={dialog.id} open title={dialog.options.title} description={dialog.options.description} tone={dialog.options.tone} icon={dialog.options.icon} actions={dialog.options.actions} input={dialog.options.input} dismissable={dialog.options.dismissable} onAction={(action,inputValue)=>overlayStore.completeDialog(dialog.id,{dismissed:false,action,inputValue})} onDismiss={()=>overlayStore.completeDialog(dialog.id,{dismissed:true})}/>:null;}
conversationUi.mode("tasks");
createRoot(document.getElementById("root")).render(<WandUiProvider><UiStoreProvider store={store}><ShellSidebar/><div style={{flex:1,minWidth:0}}><ShellTopbar/></div><DialogHost/></UiStoreProvider></WandUiProvider>);`;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const session = (id: string, title: string, extra = {}) => ({ id, title, provider: "pi", kind: "structured", cwd: "/work/atlas", status: "idle", startedAt: "2026-10-07T08:00:00Z", ...extra });
  const task = (id: string, name: string, sessions: unknown[]) => ({ id, name, workspaceId: "w1", cwd: "/work/atlas", sessions, status: "active", createdAt: "2026-10-07T08:00:00Z" });
  const groups = [
    { workspaceId: "w1", workspaceName: "Atlas 客户端", workspaceCwd: "/work/atlas", tasks: [
      task("t1", "完善消息交互", [session("s1", "侧边栏布局与交互检查", { inFlight: true }), session("s2", "检验长名称会话不会挤掉菜单按钮与状态标记"), session("archived", "旧版布局记录", { archived: true })]),
      task("t2", "整理交付文档", [session("s3", "文档检查")]),
    ], standaloneSessions: [session("loose", "目录内的独立会话")] },
    { workspaceId: "synthetic:/work/sandbox", workspaceName: "Sandbox 试验目录", workspaceCwd: "/work/sandbox", synthetic: true, tasks: [], standaloneSessions: [session("sandbox", "临时验证会话", { cwd: "/work/sandbox" })] },
  ];
  const conversations = [{ id: "group-menu", owner: "local-owner", kind: "group", peerEmployeeId: null,
    name: "菜单交互验证群", nameSource: "custom", title: "菜单交互验证群", sourceTemplateId: null, team: null,
    memberVersion: 1, joinedVersions: {}, sessionId: null, communicationSessionId: null,
    createdAt: "2026-10-07T08:00:00Z", updatedAt: "2026-10-07T08:00:00Z", messageAt: "2026-10-07T08:00:00Z",
    tasks: [], preview: "右键、键盘与长按使用同一个菜单", unavailableReason: null, memberUnavailableReasons: {} }];
  for (let index = 0; index < 40; index++) conversations.push({ ...conversations[0], id: `dense-${index}`,
    title: `长名称会话 ${index}：核验桌面工具密度、完整名称访问与大量条目下的独立滚动`,
    preview: "很长的最近消息摘要应当省略，不能挤掉日期、菜单与名称。" });
  let failList = false;
  let delayArchive = false;
  let releaseArchive: (() => void) | null = null;
  let releaseTaskArchive: (() => void) | null = null;
  const mutations: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      if (req.method !== "GET") {
        mutations.push(`${req.method} ${url.pathname}`);
        const reject = (): void => { res.statusCode = 503; res.end(JSON.stringify({ error: "明确测试失败，请重试" })); };
        if (delayArchive && url.pathname === "/api/sessions/batch-archive") { releaseArchive = reject; return; }
        if (url.pathname === "/api/workspace-tasks/t1/archive") { releaseTaskArchive = () => res.end(JSON.stringify({ id: "t1" })); return; }
        reject(); return;
      }
      if (url.pathname === "/api/tasks" && failList) { res.statusCode = 503; res.end(JSON.stringify({ error: "列表同步失败" })); return; }
      const payload = url.pathname === "/api/tasks" ? { groups }
        : url.pathname === "/api/silicon-employees" ? { employees: [] }
        : url.pathname === "/api/attention" ? { items: [{ id: "sidebar-alert", title: "会话需要处理", detail: "验证状态提示不挤动主导航", sessionId: "s1" }] }
        : url.pathname === "/api/ai-team-runs" ? { runs: [] }
        : url.pathname === "/api/conversations" ? { conversations }
        : url.pathname === "/api/ai-teams" ? []
        : url.pathname === "/api/config" ? { userProfile: { name: "测试用户", avatar: "cat:2" } } : {};
      res.end(JSON.stringify(payload)); return;
    }
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (url.pathname.endsWith(".css")) { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content", url.pathname.slice(1)))); return; }
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>html,body,#app,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="app" data-react-shell="enabled"><div id="root"></div></div><div id="overlay-root"><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const reports = [];
  try {
    for (const mode of process.env.WAND_SIDEBAR_UX_MODES?.split(",") ?? ["desktop", "mobile", "narrow", "native", "rollback", "reduced"]) {
      const width = mode === "mobile" ? 390 : mode === "narrow" ? 320 : 1280;
      mutations.length = 0;
      const browser = await openBrowser("about:blank", width, 900);
      try {
        if (mode === "reduced") await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        if (mode === "mobile" || mode === "narrow") await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
        await browser.send("Page.navigate", { url: origin + (mode === "rollback" ? "/?reactUi=0" : "/") });
        await browser.wait('!!document.querySelector(".workspace-session")');
        if (mode === "native") await browser.evaluate('document.documentElement.classList.add("is-wand-app"); true');
        await browser.settle();
        // Title generation follows WS state in both chrome and task rows, with no layout shift.
        await browser.evaluate(`(()=>{const s=fixture.memory.getSnapshot();fixture.memory.setSnapshot({...s,
          topbar:{...s.topbar,title:"侧边栏布局与交互检查",titleGenerating:true},
          sidebar:{...s.sidebar,groups:[{kind:"wand",label:"Wand 会话",expanded:true,entries:[{id:"s1",source:"wand",title:"侧边栏布局与交互检查",titleGenerating:true}]}]}
        },{sync:true});return true})()`);
        await browser.wait(`!!document.querySelector('.workspace-session[data-session-id="s1"] .title-generating')`);
        const titleRect = await browser.evaluate('document.querySelector(".topbar-session-title").getBoundingClientRect().toJSON()');
        const motion = await browser.evaluate(`(()=>{const n=document.querySelector('.workspace-session[data-session-id="s1"] .title-generating');return {busy:n.getAttribute('aria-busy'),label:n.getAttribute('aria-label'),animation:getComputedStyle(n,'::after').animationName,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
        assert.equal(motion.busy, "true"); assert.match(motion.label, /AI 正在生成标题/);
        assert.equal(motion.animation, mode === "reduced" ? "none" : "session-title-generate");
        assert.equal(motion.overflow, false);
        if (process.env.WAND_TITLE_MOTION_ONLY === "1") {
          await browser.click('.sidebar-view-switch [data-stretch-value=recent]');
          await browser.wait(`!!document.querySelector('.sidebar-recent [data-session-id="s1"] .title-generating')`);
          assert.equal(await browser.evaluate(`document.querySelector('.sidebar-recent [data-session-id="s1"] .title-generating').getAttribute('aria-busy')`), "true");
          await browser.click('.sidebar-view-switch [data-stretch-value=directory]');
        }
        await browser.evaluate(`(()=>{const s=fixture.memory.getSnapshot();fixture.memory.setSnapshot({...s,topbar:{...s.topbar,titleGenerating:false},sidebar:{...s.sidebar,groups:s.sidebar.groups.map(g=>({...g,entries:g.entries.map(e=>({...e,titleGenerating:false}))}))}},{sync:true});return true})()`);
        await browser.wait('!document.querySelector(".title-generating")');
        const completedRect = await browser.evaluate('document.querySelector(".topbar-session-title").getBoundingClientRect().toJSON()');
        assert.equal(completedRect.width, titleRect.width); assert.equal(completedRect.height, titleRect.height);
        if (process.env.WAND_TITLE_MOTION_ONLY === "1") {
          await browser.screenshot(join(artifacts, `title-motion-${mode}.png`));
          reports.push({ mode, motion, noLayoutShift: true, stopsOnCompletion: true });
          continue;
        }
        const visible = `(n)=>!!n && n.getClientRects().length>0 && !n.closest('[inert],[hidden],[aria-hidden="true"]') && getComputedStyle(n).visibility!=="hidden"`;
        // 关闭后的 Modal 容器会留在 DOM 里，选择器必须只认当前可见的那一个。
        const VISIBLE_DIALOG = "[...document.querySelectorAll('[data-wand-dialog-surface]')].find(n=>n.getClientRects().length>0)??null";
        // 对话框有入场动画，坐标必须在动画稳定后取；点完仍不关就重试，避免假失败。
        const clickDialogAction = async (text: string): Promise<void> => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await browser.settle();
            const point = await browser.evaluate(`(()=>{const dialog=${VISIBLE_DIALOG};if(!dialog)return null;const norm=(value)=>String(value||'').replace(/\\s+/g,'');const node=[...dialog.querySelectorAll('.wand-ui-dialog-actions button')].find(n=>norm(n.innerText).includes(norm(${JSON.stringify(text)})));if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
            if (!point) break;
            await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
            await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
            await browser.settle();
            if (await browser.evaluate(`!(${VISIBLE_DIALOG})`)) return;
          }
          assert.ok(false, `dialog action did not close the dialog: ${text}`);
        };
        // 菜单项按文案定位后用真实鼠标事件点击：不依赖子元素顺序和动画中的命中测试。
        const clickMenuText = async (scope: string, text: string): Promise<void> => {
          await browser.settle();
          const point = await browser.evaluate(`(()=>{const scope=${JSON.stringify(scope)};const node=[...document.querySelectorAll(scope+' [role=menuitem]')].find(n=>(n.innerText||'').includes(${JSON.stringify(text)}));if(!node)return null;const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:node===hit||node.contains(hit),actual:hit?.className,rect:r.toJSON()}})()`);
          assert.ok(point, `menu item exists: ${text}`);
          assert.equal(point.hit, true, `menu action is actually reachable: ${text} (${JSON.stringify(point)})`);
          await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
          await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
          await browser.settle();
        };
        const headerGeometry = `(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {nav:rect('.conversation-navigation'),footer:rect('#settings-button'),width:rect('#sessions-drawer').width}})()`;
        const workspaceHeader = await browser.evaluate(headerGeometry);
        await browser.click('.conversation-navigation [data-stretch-value="chats"]');
        await browser.wait('fixture.conversation.getSnapshot().mode === "chats"');
        await browser.settle();
        const chatHeader = await browser.evaluate(headerGeometry);
        assert.equal(chatHeader.nav.y, workspaceHeader.nav.y, `${mode}: switching modes keeps navigation anchored`);
        assert.equal(chatHeader.footer.y, workspaceHeader.footer.y, `${mode}: account button stays anchored`);
        assert.equal(chatHeader.footer.height, 44, `${mode}: account action has a touch-sized target`);
        assert.ok(chatHeader.footer.height <= 64, `${mode}: footer does not consume a second row`);
        assert.equal(chatHeader.width, Math.min(344, width - 24));
        const rail = await browser.evaluate(`(()=>{const rail=document.querySelector('.sidebar-navigation-rail'),r=rail.getBoundingClientRect(),avatar=document.querySelector('#settings-button').getBoundingClientRect();return {width:r.width,avatarBottom:avatar.bottom,railBottom:r.bottom,buttons:[...rail.querySelectorAll('.conversation-navigation button')].map(n=>({label:n.getAttribute('aria-label'),x:n.getBoundingClientRect().x,size:n.getBoundingClientRect().width})),profile:document.querySelector('#settings-button').title}})()`);
        assert.equal(rail.width, 56);
        assert.ok(rail.railBottom - rail.avatarBottom <= 9, `${mode}: profile stays at the bottom`);
        assert.equal(new Set(rail.buttons.map(b => b.x)).size, 1, `${mode}: destinations form a vertical rail`);
        assert.ok(rail.buttons.every(b => b.size === 44));
        assert.equal(rail.profile, "测试用户 · 设置");
        assert.deepEqual(rail.buttons.map(b => b.label), ["对话", "工作区", "任务看板", "团队", "通讯录"]);
        await browser.click('.sidebar-notification-button');
        await browser.wait('!!document.querySelector("#sidebar-notifications .wand-attention-item")', "notifications open from rail");
        await browser.click('#sidebar-notifications strong');
        assert.equal(await browser.evaluate('document.querySelector(".sidebar-notification-button").getAttribute("aria-expanded")'), "true", "clicking notification content leaves it open");
        await browser.key("Escape");
        await browser.wait('!document.querySelector("#sidebar-notifications")');
        assert.equal(await browser.evaluate('document.activeElement===document.querySelector(".sidebar-notification-button")'), true, await browser.evaluate('document.activeElement.outerHTML.slice(0,500)'));
        assert.equal(await browser.evaluate('fixture.memory.getSnapshot().layout.sessionsDrawerOpen'), true, "notification Escape preserves the drawer");
        await browser.click('.sidebar-notification-button');
        await browser.wait('!!document.querySelector("#sidebar-notifications")');
        await browser.click('.sidebar-title');
        await browser.wait('!document.querySelector("#sidebar-notifications")', "outside click closes notifications");
        // The chat list uses the very same native menu and keyboard/confirmation protocol.
        await browser.wait('!!document.querySelector(".conversation-row")');
        const density = await browser.evaluate(`(()=>{const row=document.querySelector('.conversation-row'),avatar=row.querySelector('.ant-avatar'),body=document.querySelector('.sidebar-body'),title=document.querySelector('[data-conversation-id="dense-0"] .conversation-row-title');return {row:row.getBoundingClientRect().height,avatar:avatar.getBoundingClientRect().width,scrolls:body.scrollHeight>body.clientHeight,truncated:title.scrollWidth>title.clientWidth,overflow:body.scrollWidth>body.clientWidth+1,labels:[...document.querySelectorAll('.conversation-navigation .sidebar-nav-label')].map(n=>n.textContent)}})()`);
        assert.equal(density.row, 56, `${mode}: compact conversation row`);
        assert.equal(density.avatar, 32, `${mode}: small identity image`);
        assert.equal(density.scrolls, true, `${mode}: large list scrolls inside the sidebar`);
        assert.equal(density.truncated, true, `${mode}: long name does not expand the list`);
        assert.equal(density.overflow, false, `${mode}: no horizontal overflow`);
        assert.deepEqual(density.labels, ["对话", "工作区", "任务", "团队", "通讯录"]);
        await browser.click('.conversation-row', "right");
        await browser.wait('!!document.querySelector(".conversation-row-menu")');
        await browser.screenshot(join(artifacts, `chat-menu-${mode}.png`));
        assert.equal(await browser.evaluate('document.querySelectorAll(".conversation-row-menu .wand-ui-menu-item").length'), 0);
        await browser.key("ArrowUp");
        assert.match(await browser.evaluate('document.activeElement.textContent'), /删除群聊/);
        await browser.key("Enter");
        await browser.wait(`!!(${VISIBLE_DIALOG})`, "keyboard delete chat confirmation");
        await browser.wait('!document.querySelector(".conversation-row-menu")');
        await clickDialogAction("取消");
        assert.equal(mutations.length, 0);
        await browser.click('.conversation-row-more');
        await browser.wait('!!document.querySelector(".conversation-row-menu")', "more button shares the context menu");
        await browser.click('.conversation-search-input input');
        await browser.wait('!document.querySelector(".conversation-row-menu")', "outside press closes the chat menu");
        await browser.send("Input.insertText", { text: "搜索检查" });
        await browser.wait('document.querySelector(".conversation-search-input input").value === "搜索检查"');
        assert.equal(await browser.evaluate('!!document.querySelector(".conversation-list-empty[role=status]") && !document.querySelector(".conversation-row")'), true, `${mode}: no-results state is actionable`);
        const searchGeometry = await browser.evaluate(`(()=>{const input=document.querySelector('.conversation-search-host'),clear=document.querySelector('[aria-label="清空搜索"]');const a=input.getBoundingClientRect(),b=clear.getBoundingClientRect();return {contained:b.x>=a.x&&b.right<=a.right,width:a.width}})()`);
        assert.equal(searchGeometry.contained, true, `${mode}: clear action is inside the search field`);
        await browser.click('[aria-label="清空搜索"]');
        assert.equal(await browser.evaluate('document.activeElement === document.querySelector(".conversation-search-input input") && document.activeElement.value === ""'), true, `${mode}: clearing preserves typing focus`);
        await browser.send("Input.insertText", { text: "没有这个会话" });
        await browser.key("Escape");
        assert.equal(await browser.evaluate('document.activeElement === document.querySelector(".conversation-search-input input") && document.activeElement.value === "" && fixture.memory.getSnapshot().layout.sessionsDrawerOpen'), true, `${mode}: search Escape preserves focus and the drawer`);
        await browser.click('.conversation-row', "right");
        await browser.wait('!!document.querySelector(".conversation-row-menu")');
        await browser.click('.conversation-navigation [data-stretch-value="tasks"]');
        await browser.wait('fixture.conversation.getSnapshot().mode === "tasks"');
        await browser.wait('!document.querySelector(".conversation-row-menu")', "hidden chat projection cannot leave a Portal menu behind");
        await browser.settle();
        const initial = await browser.evaluate(`(()=>{const v=${visible}; const root=document.querySelector('#sessions-drawer');return {recent:v(root.querySelector('.sidebar-recent')),loose:v(root.querySelector('.workspace-session[data-session-id=loose]')),sandbox:v(root.querySelector('.workspace-session[data-session-id=sandbox]')),standaloneFold:root.textContent.includes('未分组任务'),singleAction:root.querySelector('.workspace-session[data-session-id=loose]').querySelectorAll('button').length,overflow:root.scrollWidth>root.clientWidth+1,childNameWidth:root.querySelector('.workspace-session[data-session-id=s2] .workspace-session-name').getBoundingClientRect().width,t2:root.querySelector('[data-workspace-task-id=t2] .workspace-task-chevron-btn').getAttribute('aria-expanded')}})()`);
        assert.equal(initial.recent, false); assert.equal(initial.loose, true); assert.equal(initial.sandbox, true);
        assert.equal(initial.standaloneFold, false); assert.equal(initial.singleAction, 1); assert.equal(initial.overflow, false);
        assert.equal(await browser.evaluate(`document.querySelectorAll('.workspace-row-folder,.workspace-task-marker,.workspace-row-actions,.workspace-task-actions,.workspace-session-action').length`), 0, "no decorative directory/task logos or row action buttons");
        assert.ok(initial.childNameWidth >= 110, `${mode}: usable session title width`); assert.equal(initial.t2, "false");
        await browser.screenshot(join(artifacts, `after-${mode}.png`));
        // Search transforms in its existing slot, restores focus and reveals ancestor paths.
        const before = await browser.evaluate(`document.querySelector('[aria-label="搜索任务或会话"]').getBoundingClientRect().toJSON()`);
        await browser.click('[aria-label="搜索任务或会话"]');
        await browser.wait(`document.activeElement===document.querySelector('input[aria-label="搜索工作区、任务或会话"]')`);
        await browser.send("Input.insertText", { text: "旧版布局记录" });
        await browser.wait(`(${visible})(document.querySelector('.workspace-session[data-session-id=archived]'))`);
        const after = await browser.evaluate(`document.querySelector('[aria-label="收起搜索"]').getBoundingClientRect().toJSON()`);
        assert.ok(Math.abs(before.x - after.x) < 1 && before.width === after.width, "search trigger must not move");
        await browser.key("Escape");
        await browser.wait(`document.activeElement===document.querySelector('[aria-label="搜索任务或会话"]')`);
        // A collapsed task also contains its archive; no orphaned fourth-level fold.
        await browser.click('[data-workspace-task-id=t1] .workspace-task-chevron-btn');
        assert.equal(await browser.evaluate(`(${visible})(document.querySelector('.workspace-session[data-session-id=archived]'))`), false);
        await browser.key("ArrowRight");
        // The row itself owns its context menu; there are no per-row toolbars.
        const sessionRow = '.workspace-session[data-session-id=loose]';
        if (mode === "mobile" || mode === "narrow") {
          await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
          const point = await browser.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(sessionRow)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
          await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
          await browser.wait('!!document.querySelector(".workspace-session-menu .ant-dropdown-menu")', "long press opens row menu");
          await browser.evaluate(`document.querySelector(${JSON.stringify(sessionRow)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:${point.x},clientY:${point.y},button:2}));true`);
          await browser.settle();
          assert.equal(await browser.evaluate('!!document.querySelector(".workspace-session-menu .ant-dropdown-menu")'), true, "the browser's own long-press contextmenu cannot toggle the menu closed");
          await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await browser.settle();
          assert.equal(await browser.evaluate('fixture.selected.length'), 0, "long press must not also activate the session");
        } else await browser.click(sessionRow, "right");
        await browser.wait('!!document.querySelector(".workspace-session-menu .ant-dropdown-menu")');
        await browser.settle();
        const menuShape = await browser.evaluate(`(()=>{const menu=document.querySelector('.workspace-session-menu'),row=document.querySelector(${JSON.stringify(sessionRow)});const r=menu.getBoundingClientRect(),a=row.getBoundingClientRect();const heights=[...menu.querySelectorAll('[role=menuitem]')].map(n=>n.getBoundingClientRect().height);return {x:r.x,y:r.y,width:r.width,height:r.height,rowCenter:a.x+a.width/2,fits:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,heights,focus:document.activeElement.textContent,customRows:menu.querySelectorAll('.wand-ui-menu-item').length}})()`);
        assert.equal(menuShape.fits, true, `${mode}: menu remains inside the viewport`);
        assert.equal(new Set(menuShape.heights).size, 1, `${mode}: every action has the same row height`);
        assert.equal(menuShape.customRows, 0, "all actions use Ant's native menu rows");
        assert.ok(menuShape.focus.includes("打开会话"), "menu focuses its first native action");
        if (!["mobile", "narrow"].includes(mode)) assert.ok(Math.abs(menuShape.x - menuShape.rowCenter) <= 12, "right click is anchored to the cursor, not the row's left edge");
        await browser.screenshot(join(artifacts, `menu-${mode}.png`));
        await browser.key("ArrowDown");
        assert.match(await browser.evaluate('document.activeElement.textContent'), /移动到任务/);
        await browser.key("ArrowRight");
        await browser.wait(`(${visible})(document.querySelector('.workspace-session-move-menu'))`, "ArrowRight opens the native move submenu");
        await browser.settle();
        const submenuShape = await browser.evaluate(`(()=>{const menu=document.querySelector('.workspace-session-move-menu'),r=menu.getBoundingClientRect(),root=document.querySelector('.workspace-session-menu').getBoundingClientRect();return {rect:r.toJSON(),root:root.toJSON(),fits:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,owned:!!menu.closest('[data-wand-popup-owner]')}})()`);
        assert.equal(submenuShape.fits, true, `${mode}: native submenu flips within the viewport (${JSON.stringify(submenuShape.rect)})`);
        assert.ok(Math.abs(submenuShape.root.x - menuShape.x) <= 1 && Math.abs(submenuShape.root.y - menuShape.y) <= 1, "opening a submenu must not move the root menu");
        assert.equal(submenuShape.owned, true, "the submenu belongs to this sidebar Portal");
        await browser.screenshot(join(artifacts, `submenu-${mode}.png`));
        assert.equal(await browser.evaluate('!!document.querySelector(".workspace-session-menu .ant-dropdown-menu")'), true);
        await browser.key("Escape");
        await browser.wait(`!(${visible})(document.querySelector('.workspace-session-move-menu'))`, "native submenu is hidden after Escape");
        await browser.key("Escape");
        await browser.wait('!document.querySelector(".workspace-session-menu")');
        assert.equal(await browser.evaluate('fixture.memory.getSnapshot().layout.sessionsDrawerOpen'), true, "nested Escape must leave the drawer open");
        assert.equal(await browser.evaluate(`document.activeElement===document.querySelector('${sessionRow} .workspace-session-main')`), true, "Escape restores the row control, not an unfocusable wrapper");
        // 键盘路径用行内按钮的真实焦点 + Shift+F10；不依赖 Chrome 的修饰键残留状态。
        const openKeyboardMenu = `(()=>{const row=document.querySelector('${sessionRow} .workspace-session-main');row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}));return true;})()`;
        await browser.evaluate(openKeyboardMenu);
        await browser.wait('!!document.querySelector(".workspace-session-menu .ant-dropdown-menu")');
        await browser.settle();
        await browser.key("Tab");
        await browser.wait('!document.querySelector(".workspace-session-menu")', "Tab leaves the menu without trapping focus");
        assert.equal(await browser.evaluate('!!document.activeElement.closest("#sessions-drawer") && document.activeElement !== document.body'), true);
        await browser.evaluate(openKeyboardMenu);
        await browser.wait('!!document.querySelector(".workspace-session-menu .ant-dropdown-menu")');
        await clickMenuText('.workspace-session-menu', '删除会话');
        await browser.wait(`!!(${VISIBLE_DIALOG})`, "tree delete confirmation");
        assert.equal(mutations.length, 0, "opening confirmation must not delete");
        await clickDialogAction("取消");
        await browser.wait(`!(${VISIBLE_DIALOG})`, "tree confirmation cancel");
        await browser.wait('!document.querySelector(".workspace-session-menu")');
        assert.equal(mutations.length, 0, "cancelling the confirmation deletes nothing");
        assert.equal(await browser.evaluate('fixture.memory.getSnapshot().layout.sessionsDrawerOpen'), true, "confirmation Escape must leave the drawer open");
        await browser.click('.sidebar-view-switch [data-stretch-value=recent]');
        await browser.wait(`(${visible})(document.querySelector('.sidebar-recent'))`, "recent view");
        // 菜单经 Portal 渲染在抽屉之外，不能按侧栏祖先选择器取。
        await browser.click('.sidebar-recent .sidebar-recent-row', "right");
        await browser.wait('!!document.querySelector(".workspace-session-menu .ant-dropdown-menu")', "recent row context menu");
        const recentItems = await browser.evaluate('Array.from(document.querySelectorAll(".workspace-session-menu .ant-dropdown-menu-item, .workspace-session-menu .ant-dropdown-menu-submenu-title")).filter(n=>!n.closest(".ant-dropdown-menu-submenu-popup")).map(n=>n.innerText)');
        assert.equal(recentItems.length, 4, "recent rows offer the same open/move/archive/delete actions as the tree");
        assert.ok(recentItems.some((text) => text.includes("移动到任务")), "recent rows keep the move action");
        await clickMenuText('.workspace-session-menu', '删除会话');
        await browser.wait(`!!(${VISIBLE_DIALOG})`, "shared delete confirmation");
        assert.match(await browser.evaluate(`(${VISIBLE_DIALOG}).innerText`), /无法撤销。任务和其他会话保留/);
        assert.equal(mutations.length, 0, "confirming must not delete before approval");
        await clickDialogAction("取消");
        await browser.wait(`!(${VISIBLE_DIALOG})`, "recent confirmation cancel");
        assert.equal(mutations.length, 0, "cancelling the confirmation deletes nothing");
        await browser.key("Escape");
        await browser.wait('!document.querySelector(".workspace-session-menu")', "recent row menu Escape");
        assert.equal(await browser.evaluate('fixture.selected.length'), 0, "opening a recent row menu must not open the session");
        await browser.click('.sidebar-view-switch [data-stretch-value=directory]');
        await browser.wait('document.querySelector(".sidebar-view-switch .ant-segmented-item-selected [data-stretch-value]")?.dataset.stretchValue === "directory"', "back to the directory view");
        // Switching views, including while a row menu is open, closes its portalled surfaces.
        await browser.click(sessionRow, "right");
        await browser.click('.sidebar-view-switch [data-stretch-value=recent]');
        await browser.wait('!document.querySelector(".workspace-session-menu")');
        assert.equal(await browser.evaluate(`(${visible})(document.querySelector('.sidebar-recent'))`), true);
        assert.equal(await browser.evaluate(`(${visible})(document.querySelector('.workspaces-list'))`), false);
        await browser.click('.sidebar-view-switch [data-stretch-value=directory]');
        await browser.click('[aria-label="只看活动会话"]');
        assert.equal(await browser.evaluate('!!document.querySelector("[data-session-id=sandbox]")'), false);
        assert.equal(await browser.evaluate('!!document.querySelector("[data-session-id=s1]")'), true);
        await browser.click('[aria-label="只看活动会话"]');
        // Task context actions remain available, without a plus or more button in the row.
        await browser.click('[data-workspace-task-id=t1] .workspace-task', "right");
        await browser.wait('!!document.querySelector(".workspace-task-menu .ant-dropdown-menu")');
        await clickMenuText('.workspace-task-menu', '重命名任务');
        await browser.wait(`document.activeElement?.getAttribute('aria-label')==='重命名任务 完善消息交互'`);
        await browser.key("Escape");
        assert.equal(await browser.evaluate('!!document.querySelector("[data-workspace-task-id=t1]")'), true);
        // Synthetic directories are usable creation contexts, without a fabricated workspace ID.
        await browser.click('[data-sidebar-tree-directory-id="synthetic:/work/sandbox"] .workspace-row', "right");
        await browser.wait('!!document.querySelector(".workspace-directory-menu .ant-dropdown-menu")');
        await clickMenuText('.workspace-directory-menu', '在此新建会话');
        const creation = await browser.evaluate('fixture.creation()');
        assert.equal(creation.initialCwd, "/work/sandbox"); assert.equal(creation.workspaceId, "");
        await browser.evaluate('fixture.closeCreation();fixture.update({sessionsDrawerOpen:true,sessionsBackdropVisible:innerWidth<600});true');
        // Destructive actions leave the menu before confirmation; cancellation is read-only.
        await browser.click('[data-workspace-task-id=t1] .workspace-task', "right");
        await clickMenuText('.workspace-task-menu', '清空所列会话');
        await browser.wait(`!!(${VISIBLE_DIALOG})`, "clear task confirmation");
        await browser.wait('!document.querySelector(".workspace-task-menu")', "no menu over the confirmation");
        assert.match(await browser.evaluate(`(${VISIBLE_DIALOG}).innerText`), /全部 2 个会话.*无法撤销/);
        await clickDialogAction("取消");
        assert.equal(mutations.length, 0);
        await browser.click('[data-sidebar-tree-directory-id=w1] .workspace-row', "right");
        await browser.screenshot(join(artifacts, `directory-menu-${mode}.png`));
        await clickMenuText('.workspace-directory-menu', '删除目录');
        await browser.wait(`!!(${VISIBLE_DIALOG})`, "delete directory confirmation");
        await browser.wait('!document.querySelector(".workspace-directory-menu")');
        await clickDialogAction("取消");
        assert.equal(mutations.length, 0);
        // Explicit HTTP failures are visible, release the action lock and never execute a model.
        await browser.click(sessionRow, "right");
        await clickMenuText('.workspace-session-menu', '归档会话');
        await browser.wait(`document.querySelector('.workspace-session-menu [role=alert]')?.textContent.includes('明确测试失败')`, "archive failure remains readable");
        await browser.key("Escape");
        if (mode === "desktop") {
          delayArchive = true; releaseArchive = null;
          await browser.click(sessionRow, "right");
          await clickMenuText('.workspace-session-menu', '归档会话');
          await browser.wait(`document.querySelector(${JSON.stringify(sessionRow)})?.getAttribute('aria-busy')==='true'`, "delayed archive started");
          await browser.click('.sidebar-title');
          await browser.wait('!document.querySelector(".workspace-session-menu")', "user dismissed a pending action");
          assert.ok(releaseArchive, "the fixture owns the pending response");
          (releaseArchive as () => void)(); delayArchive = false;
          await browser.wait(`document.querySelector(${JSON.stringify(sessionRow)})?.getAttribute('aria-busy')!=='true'`, "late failure released the lock");
          assert.equal(await browser.evaluate('!!document.querySelector(".workspace-session-menu")'), false, "late failure cannot reopen a dismissed menu");
          await browser.click(sessionRow, "right");
          await browser.wait(`document.querySelector('.workspace-session-menu [role=alert]')?.textContent.includes('明确测试失败')`, "failure remains available when the user reopens the row");
          await browser.key("Escape");
        }
        await browser.click(sessionRow, "right");
        await clickMenuText('.workspace-session-menu', '移动到任务');
        await browser.wait(`(${visible})(document.querySelector('.workspace-session-move-menu'))`);
        await clickMenuText('.workspace-session-move-menu', '整理交付文档');
        await browser.wait(`document.querySelector('.workspace-session-move-menu [role=alert]')?.textContent.includes('明确测试失败')`, "move failure keeps a retryable target list");
        assert.ok(await browser.evaluate(`document.querySelectorAll('.workspace-session-move-menu [role=menuitem]:not([aria-disabled=true])').length >= 2`));
        assert.equal(await browser.evaluate(`(${visible})(document.querySelector('.workspace-session-move-menu'))`), true, "failure feedback is visible, not merely retained in a hidden submenu");
        await browser.key("Escape"); await browser.key("Escape");
        assert.equal(await browser.evaluate('fixture.memory.getSnapshot().layout.sessionsDrawerOpen'), true, "closing a failed move never dismisses the drawer");
        if (mode === "desktop") {
          await browser.evaluate("fixture.setContext({workspaceId:'w1',taskId:'t1'});true");
          await browser.click('[data-workspace-task-id=t1] .workspace-task', "right");
          await clickMenuText('.workspace-task-menu', '归档任务');
          await browser.wait(`!!(${VISIBLE_DIALOG})`);
          await clickDialogAction("确认归档任务");
          assert.ok(releaseTaskArchive, "the fixture owns the pending task mutation");
          await browser.evaluate("fixture.setContext({workspaceId:'w1',taskId:'t2'});true");
          (releaseTaskArchive as () => void)();
          await browser.wait("document.querySelector('[data-workspace-task-id=t1]').getAttribute('aria-busy')!=='true'", "task archive settled");
          assert.equal(await browser.evaluate("fixture.closed"), 0, "a late archive must not close the newly opened task");
        }
        // Reduced height and the narrow right edge cannot make the last action unreachable.
        await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 420, deviceScaleFactor: 1, mobile: false });
        await browser.click(sessionRow, "right");
        await browser.wait('!!document.querySelector(".workspace-session-menu")', "short viewport context menu");
        await browser.settle();
        const edgeFits = await browser.evaluate(`(()=>{const r=document.querySelector('.workspace-session-menu').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`);
        assert.equal(edgeFits, true, `${mode}: edge collision handling keeps the complete menu visible`);
        await browser.screenshot(join(artifacts, `edge-menu-${mode}.png`));
        await browser.key("Escape");
        await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        if (mode === "mobile" || mode === "narrow") {
          await browser.settle();
          const point = await browser.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(sessionRow)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
          await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
          await browser.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - 24, id: 1 }] });
          await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await browser.evaluate('new Promise(resolve=>setTimeout(resolve,550))');
          assert.equal(await browser.evaluate('!!document.querySelector(".workspace-session-menu")'), false, "scrolling cancels a pending long press");
        }
        if (mode === "desktop") {
          await browser.click('[aria-label="收起为窄栏"]');
          await browser.wait('document.querySelector("#sessions-drawer").classList.contains("collapsed")');
          await browser.click('[data-sidebar-directory-id="w1"]');
          await browser.wait('!document.querySelector("#sessions-drawer").classList.contains("collapsed")');
          assert.equal(await browser.evaluate('document.activeElement.matches(".workspace-row-main")'), true);
          failList = true;
          await browser.click('[aria-label="会话列表选项"]');
          await browser.click('[aria-label="会话列表选项"][role=menu] .ant-menu-item:last-child');
          await browser.wait('!!document.querySelector(".sidebar-list-error")');
          assert.equal(await browser.evaluate('!!document.querySelector("[data-session-id=s1]")'), true, "failed sync retains existing rows");
          failList = false;
        }
        assert.deepEqual(browser.errors, []);
        reports.push({ mode, initial, searchStable: true, menuOwnership: true, menuShape, nativeSubmenu: submenuShape, confirmationsReadOnly: true, failureRecovery: true, lateFailureIsolation: mode === "desktop" ? true : null, edgeFits, mutations: mutations.length });
        console.log(`sidebar menu scenario passed: ${mode}`);
      } catch (cause) {
        console.error({ mode, browserErrors: browser.errors, state: await browser.evaluate(`({body:document.body.innerText.slice(0,600),recent:!!document.querySelector('.sidebar-recent'),recentRect:document.querySelector('.sidebar-recent')?.getBoundingClientRect().toJSON()??null,view:document.querySelector('.sidebar-view-switch .ant-segmented-item-selected [data-stretch-value]')?.dataset.stretchValue??null,rows:document.querySelectorAll('.sidebar-recent-row').length,switches:document.querySelectorAll('.sidebar-view-switch').length})`) });
        throw cause;
      } finally { await browser.close(); }
    }
    writeFileSync(join(artifacts, "browser-results.json"), JSON.stringify({ ok: true, sourceFixtures: true, reports }, null, 2));
  } finally {
    server.close(); server.closeAllConnections();
    rmSync(temp, { recursive: true, force: true });
  }
});
