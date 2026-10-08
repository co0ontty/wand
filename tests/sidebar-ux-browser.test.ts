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
  skip: process.env.WAND_SIDEBAR_UX_BROWSER !== "1", timeout: 180_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-sidebar-ux-test-"));
  const artifacts = join(root, "output/sidebar-ux");
  mkdirSync(artifacts, { recursive: true });
  const source = `import * as React from "react";
import { createRoot } from "react-dom/client";
import { ShellSidebar } from "./src/web-ui/react/shell/shell-sidebar";
import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
import { UiStoreProvider } from "./src/web-ui/react/shell/ui-store-react";
import { WandUiProvider } from "./src/web-ui/react/theme";
import { installReactUiStyles } from "./src/web-ui/react/styles";
import { configureWorkspacesRuntime } from "./src/web-ui/react/workspaces/controller";
import { newSessionController, newSessionStore, configureNewSessionRuntime } from "./src/web-ui/react/new-session/controller";
import { conversationUi } from "./src/web-ui/react/conversations/state";
import { overlayStore } from "./src/web-ui/react/overlay-controller";
import { WandDialog } from "./src/web-ui/react/ui";
installReactUiStyles();
const mobile = innerWidth < 600;
let snapshot = {auth:{phase:"authenticated"},viewport:{mobile,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},
layout:{sessionsDrawerOpen:true,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:mobile,sidebarAnchored:!mobile,sessionsBackdropVisible:mobile,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:"chat"},
selected:{id:"s1",workspaceId:"w1",workspaceTaskId:"t1"},sidebar:{groups:[],interactiveCount:4,totalCount:4,manageMode:false,selectedCount:0},
topbar:{title:"",description:"",statusLabel:"",statusTone:"idle",cwd:"/work/atlas",currentTask:"",titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:true,blank:false,composer:true}};
const memory = new MemoryUiAdapter(snapshot);
const update = (layout)=>{snapshot={...snapshot,layout:{...snapshot.layout,...layout}};memory.setSnapshot(snapshot,{sync:true});};
window.fixture={memory,update,selected:[],creation:()=>newSessionStore.getSnapshot(),closeCreation:()=>newSessionController.close(),conversation:conversationUi};
const store={getSnapshot:()=>memory.getSnapshot(),subscribe:memory.subscribe.bind(memory),dispatch(action){memory.dispatch(action);if(action.type==="layout.drawer.collapse")update({sidebarCollapsed:!snapshot.layout.sidebarCollapsed});if(action.type==="layout.drawer.close")update({sessionsDrawerOpen:false,sessionsBackdropVisible:false});if(action.type==="workspace.new")newSessionController.open();}};
configureWorkspacesRuntime({selectSession(id){fixture.selected.push(id);},openTask(payload){fixture.selected.push(payload.preferredSessionId||payload.taskId);},openWorkspace(){},closeWorkspace(){},refreshSessions:async()=>{},toast(){},onOpen(){},onClose(){}});
configureNewSessionRuntime({onOpen(){},onClose(){}});
function DialogHost(){const state=React.useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot,overlayStore.getSnapshot);const dialog=state.activeDialog;
  return dialog?<WandDialog key={dialog.id} open title={dialog.options.title} description={dialog.options.description} tone={dialog.options.tone} icon={dialog.options.icon} actions={dialog.options.actions} input={dialog.options.input} dismissable={dialog.options.dismissable} onAction={(action,inputValue)=>overlayStore.completeDialog(dialog.id,{dismissed:false,action,inputValue})} onDismiss={()=>overlayStore.completeDialog(dialog.id,{dismissed:true})}/>:null;}
conversationUi.mode("tasks");
createRoot(document.getElementById("root")).render(<WandUiProvider><UiStoreProvider store={store}><ShellSidebar/><DialogHost/></UiStoreProvider></WandUiProvider>);`;
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
  let failList = false;
  const mutations: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      if (req.method !== "GET") { mutations.push(`${req.method} ${url.pathname}`); res.statusCode = 503; res.end(JSON.stringify({ error: "明确测试失败，请重试" })); return; }
      if (url.pathname === "/api/tasks" && failList) { res.statusCode = 503; res.end(JSON.stringify({ error: "列表同步失败" })); return; }
      const payload = url.pathname === "/api/tasks" ? { groups }
        : url.pathname === "/api/silicon-employees" ? { employees: [] }
        : url.pathname === "/api/attention" ? { items: [{ id: "sidebar-alert", title: "会话需要处理", detail: "验证状态提示不挤动主导航", sessionId: "s1" }] }
        : url.pathname === "/api/ai-team-runs" ? { runs: [] }
        : url.pathname === "/api/conversations" ? { conversations: [] }
        : url.pathname === "/api/ai-teams" ? []
        : url.pathname === "/api/config" ? {} : {};
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
      const browser = await openBrowser("about:blank", width, 900);
      try {
        if (mode === "reduced") await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        if (mode === "mobile" || mode === "narrow") await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
        await browser.send("Page.navigate", { url: origin + (mode === "rollback" ? "/?reactUi=0" : "/") });
        await browser.wait('!!document.querySelector(".workspace-session")');
        if (mode === "native") await browser.evaluate('document.documentElement.classList.add("is-wand-app"); true');
        await browser.settle();
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
          const point = await browser.evaluate(`(()=>{const scope=${JSON.stringify(scope)};const node=[...document.querySelectorAll(scope+' .ant-menu-item,'+scope+' .wand-ui-menu-item')].find(n=>(n.innerText||'').includes(${JSON.stringify(text)}));if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
          assert.ok(point, `menu item exists: ${text}`);
          await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
          await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
          await browser.settle();
        };
        const headerGeometry = `(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {nav:rect('.conversation-navigation'),more:rect('#sidebar-more-btn'),footer:rect('.sidebar-footer'),width:rect('#sessions-drawer').width}})()`;
        const workspaceHeader = await browser.evaluate(headerGeometry);
        await browser.click('.conversation-navigation [data-stretch-value="chats"]');
        await browser.wait('fixture.conversation.getSnapshot().mode === "chats"');
        await browser.settle();
        const chatHeader = await browser.evaluate(headerGeometry);
        assert.equal(chatHeader.nav.y, workspaceHeader.nav.y, `${mode}: switching modes keeps navigation anchored`);
        assert.equal(chatHeader.more.y, workspaceHeader.more.y, `${mode}: header buttons do not jump`);
        assert.equal(chatHeader.more.height, 44, `${mode}: header actions have touch-sized targets`);
        assert.ok(chatHeader.footer.height <= 64, `${mode}: footer does not consume a second row`);
        assert.equal(chatHeader.width, Math.min(320, width - 24));
        await browser.click('.conversation-search-input input');
        await browser.send("Input.insertText", { text: "搜索检查" });
        await browser.wait('document.querySelector(".conversation-search-input input").value === "搜索检查"');
        const searchGeometry = await browser.evaluate(`(()=>{const input=document.querySelector('.conversation-search-host'),clear=document.querySelector('[aria-label="清空搜索"]');const a=input.getBoundingClientRect(),b=clear.getBoundingClientRect();return {contained:b.x>=a.x&&b.right<=a.right,width:a.width}})()`);
        assert.equal(searchGeometry.contained, true, `${mode}: clear action is inside the search field`);
        await browser.click('[aria-label="清空搜索"]');
        assert.equal(await browser.evaluate('document.activeElement === document.querySelector(".conversation-search-input input") && document.activeElement.value === ""'), true, `${mode}: clearing preserves typing focus`);
        await browser.click('.conversation-navigation [data-stretch-value="tasks"]');
        await browser.wait('fixture.conversation.getSnapshot().mode === "tasks"');
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
          await browser.wait('!!document.querySelector(".workspace-session-menu .ant-menu")', "long press opens row menu");
          await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await browser.settle();
          assert.equal(await browser.evaluate('fixture.selected.length'), 0, "long press must not also activate the session");
        } else await browser.click(sessionRow, "right");
        await browser.wait('!!document.querySelector(".workspace-session-menu .ant-menu")');
        await clickMenuText('.workspace-session-menu', '移动到任务');
        await browser.wait('!!document.querySelector(".workspace-session-move-menu")');
        assert.equal(await browser.evaluate('!!document.querySelector(".workspace-session-menu .ant-menu")'), true);
        await browser.key("Escape");
        await browser.wait('!document.querySelector(".workspace-session-move-menu")');
        await browser.key("Escape");
        await browser.wait('!document.querySelector(".workspace-session-menu")');
        assert.equal(await browser.evaluate('fixture.memory.getSnapshot().layout.sessionsDrawerOpen'), true, "nested Escape must leave the drawer open");
        // 键盘路径用行内按钮的真实焦点 + Shift+F10；不依赖 Chrome 的修饰键残留状态。
        await browser.evaluate(`(()=>{const row=document.querySelector('${sessionRow} .workspace-session-main');row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}));return document.activeElement===row;})()`);
        await browser.wait('!!document.querySelector(".workspace-session-menu .ant-menu")');
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
        await browser.wait('!!document.querySelector(".workspace-session-menu .ant-menu")', "recent row context menu");
        const recentItems = await browser.evaluate('Array.from(document.querySelectorAll(".workspace-session-menu .ant-menu-item, .workspace-session-menu .wand-ui-menu-item")).map(n=>n.innerText)');
        assert.equal(recentItems.length, 3, "recent rows offer the same move/archive/delete actions as the tree");
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
        await browser.wait('!!document.querySelector(".workspace-task-menu .ant-menu")');
        await clickMenuText('.workspace-task-menu', '重命名任务');
        await browser.wait(`document.activeElement?.getAttribute('aria-label')==='重命名任务 完善消息交互'`);
        await browser.key("Escape");
        assert.equal(await browser.evaluate('!!document.querySelector("[data-workspace-task-id=t1]")'), true);
        // Synthetic directories are usable creation contexts, without a fabricated workspace ID.
        await browser.click('[data-sidebar-tree-directory-id="synthetic:/work/sandbox"] .workspace-row', "right");
        await browser.wait('!!document.querySelector(".workspace-directory-menu .ant-menu")');
        await clickMenuText('.workspace-directory-menu', '在此新建会话');
        const creation = await browser.evaluate('fixture.creation()');
        assert.equal(creation.initialCwd, "/work/sandbox"); assert.equal(creation.workspaceId, "");
        await browser.evaluate('fixture.closeCreation();fixture.update({sessionsDrawerOpen:true,sessionsBackdropVisible:innerWidth<600});true');
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
        reports.push({ mode, initial, searchStable: true, menuOwnership: true, mutations: mutations.length });
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
