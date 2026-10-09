import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./sidebar-ux-browser.mjs";

const fixtureSession = (id, title, extra = {}) => ({
  id, title, provider: "pi", sessionKind: "structured", sessionSource: "wand",
  cwd: "/fixture/sandbox", status: "idle", startedAt: "2026-10-09T08:00:00Z",
  messages: [], output: "", mode: "default", ...extra,
});
const ownSession = (id, title, extra = {}) => fixtureSession(id, title, {
  startedAt: `2026-10-09T08:00:0${id.at(-1)}Z`, ...extra,
});
const sessions = [
  ownSession("loose1", "第一条未分组会话：标签切换与草稿保留"),
  ownSession("loose2", "第二条未分组会话：检验很长标题仍可操作"),
  ownSession("loose3", "第三条未分组会话：键盘切换与刷新恢复"),
  fixtureSession("other", "异目录会话", { cwd: "/fixture/other" }),
  fixtureSession("archived", "归档会话", { archived: true }),
  fixtureSession("relay", "团队转发会话", { teamChat: { teamId: "fixture-team", runId: "fixture-run", teamName: "Fixture", memberCount: 2 } }),
  fixtureSession("grouped1", "任务第一窗口", { cwd: "/fixture/project", workspaceId: "fixture-project", workspaceTaskId: "fixture-task" }),
  fixtureSession("grouped2", "任务第二窗口", { cwd: "/fixture/project", workspaceId: "fixture-project", workspaceTaskId: "fixture-task" }),
  ownSession("project1", "项目未分组会话一", { cwd: "/fixture/project", workspaceId: "fixture-project" }),
  ownSession("project2", "项目未分组会话二", { cwd: "/fixture/project", workspaceId: "fixture-project" }),
  ownSession("project3", "项目未分组会话三", { cwd: "/fixture/project/.wand-worktrees/fixture-own", workspaceId: "fixture-project" }),
  fixtureSession("global1", "全局目录会话", { cwd: "/fixture/global", workspaceId: "fixture-global" }),
];

export async function runStandaloneSessionTabsBrowser() {
  const root = resolve(import.meta.dirname, "../..");
  const output = resolve(root, process.env.WAND_STANDALONE_TABS_OUTPUT ?? "output/standalone-session-tabs-20261009");
  mkdirSync(output, { recursive: true });
  const grouped = sessions.filter(session => session.workspaceTaskId);
  const taskLayout = { type: "windows", windows: grouped.map(session => ({
    id: `window-${session.id}`,
    layout: { type: "pane", tabs: [{ id: `tab-${session.id}`, kind: "session", sessionId: session.id }], active: 0 },
    activeTabId: `tab-${session.id}`,
  })), activeWindowId: "window-grouped1" };
  const task = { id: "fixture-task", name: "Fixture 任务", workspaceId: "fixture-project", cwd: "/fixture/project",
    sessions: grouped, layout: taskLayout, layoutRevision: 1, status: "active", createdAt: "2026-10-09T08:00:00Z" };
  const groups = [
    { workspaceId: "synthetic:/fixture/sandbox", workspaceName: "Sandbox", workspaceCwd: "/fixture/sandbox", synthetic: true, tasks: [],
      standaloneSessions: sessions.filter(session => session.cwd === "/fixture/sandbox") },
    { workspaceId: "synthetic:/fixture/other", workspaceName: "Other", workspaceCwd: "/fixture/other", synthetic: true, tasks: [],
      standaloneSessions: sessions.filter(session => session.cwd === "/fixture/other") },
    { workspaceId: "fixture-project", workspaceName: "Fixture 项目", workspaceCwd: "/fixture/project", tasks: [task],
      standaloneSessions: sessions.filter(session => session.workspaceId === "fixture-project" && !session.workspaceTaskId) },
    { workspaceId: "fixture-global", workspaceName: "Global", workspaceCwd: "/fixture/global", global: true, tasks: [],
      standaloneSessions: sessions.filter(session => session.id === "global1") },
  ];
  // Actual browser owners perform selection, draft capture, context exit and restoration.
  // Only HTTP data is a local fixture; no dispatcher fabricates context or input changes.
  const source = `import*as React from'react';import{createRoot}from'react-dom/client';import{Layout}from'antd';
import{state,composer}from'./src/web-ui/browser/state';
import{selectSession,goHome}from'./src/web-ui/browser/session-engine';
import{installWorkspacesLegacyAdapter}from'./src/web-ui/browser/workspaces-adapter';
import{createBrowserUiStoreBridge}from'./src/web-ui/browser/ui-store-bridge';
import{restoreActiveTask,readActiveTaskId}from'./src/web-ui/browser/active-task';
import{openSessionWithOwningTask}from'./src/web-ui/react/workspaces/session-open';
import{workspacesStore}from'./src/web-ui/react/workspaces/controller';
import{workspaceContextStore}from'./src/web-ui/react/workspaces/workspace-context';
import{WorkspaceTabBar}from'./src/web-ui/react/workspaces/workspace-tab-bar';
import{UiStoreProvider}from'./src/web-ui/react/shell/ui-store-react';
import{WandUiProvider}from'./src/web-ui/react/theme';import{installReactUiStyles}from'./src/web-ui/react/styles';
import{newSessionStore,newSessionController,configureNewSessionRuntime}from'./src/web-ui/react/new-session/controller';
import{taskGroupsStore}from'./src/web-ui/react/workspaces/task-groups-store';
import{installSidebarStyles}from'./src/web-ui/react/shell/sidebar-styles';
import{ShellMainContent}from'./src/web-ui/react/shell/shell-main-content';
delete document.documentElement.dataset.wandPage;installReactUiStyles();installSidebarStyles();
const loadedSelection=state.selectedId;state.sessions=${JSON.stringify(sessions)};state.config={language:'zh',defaultCwd:'/fixture/sandbox'};state.loginChecked=true;state.isOnline=true;state.ws=null;state.sessionsDrawerOpen=false;state.sidebarPinned=false;
const noop=()=>{};const commands=new Proxy({selectSession,goHome},{get:(target,key)=>target[key]??noop});
const store=createBrowserUiStoreBridge(commands,{batchMs:0});installWorkspacesLegacyAdapter();
configureNewSessionRuntime({onOpen(){},onClose(){}});
window.tabsFixture={documentId:crypto.randomUUID(),state,composer,store,select:selectSession,open:(id)=>openSessionWithOwningTask(id,selectSession),
context:()=>workspaceContextStore.getSnapshot(),activeTask:readActiveTaskId,groups:()=>taskGroupsStore.getSnapshot(),
creation:()=>newSessionStore.getSnapshot(),closeCreation:()=>newSessionController.close(),
openTask:()=>workspacesStore.getRuntime().openTask({workspaceId:'fixture-project',workspaceName:'Fixture 项目',taskId:'fixture-task',taskName:'Fixture 任务',cwd:'/fixture/project',preferredSessionId:'grouped1'})};
const defaultFocusMode=new URL(location.href).searchParams.has('defaultFocus');
const legacyRefs={composer:(node)=>{if(node&&!node.firstChild)node.innerHTML='<div class="input-composer"><textarea id="input-box" class="input-textarea" aria-label="Fixture draft"></textarea></div>';},chat:(node)=>{if(node&&!node.firstChild)node.innerHTML='<div id="chat-messages"></div>';}};
createRoot(document.querySelector('#fixture-tabs')).render(<WandUiProvider><UiStoreProvider store={store}><Layout style={{minWidth:0,height:'100%'}}>{defaultFocusMode?<ShellMainContent legacyRefs={legacyRefs}/>:<WorkspaceTabBar/>}</Layout></UiStoreProvider></WandUiProvider>);
async function start(){if(!defaultFocusMode){await restoreActiveTask(loadedSelection);await selectSession(loadedSelection&&state.sessions.some(s=>s.id===loadedSelection)?loadedSelection:'loose1');}window.tabsFixture.ready=true;}void start();`;
  const built = await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true,
    format: "iife", platform: "browser", write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const mutations = [];
  let failGroups = false;
  let delayNextSessionReadId = null;
  let heldSessionRead = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json;charset=utf-8");
      if (req.method !== "GET") {
        const mutation = { method: req.method, layout: /\/layout$/.test(url.pathname), path: url.pathname, stage: failedAt?.stage };
        mutations.push(mutation);
        let body = ""; req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          try { const value = JSON.parse(body); mutation.unchangedCanonicalLayout = JSON.stringify(value.layout) === JSON.stringify(taskLayout); mutation.windowCount = value.layout?.windows?.length; mutation.activeIsFirst = value.layout?.activeWindowId === "window-grouped1"; } catch {}
          res.statusCode = 409; res.end(JSON.stringify({ error: "Fixture refuses business writes" }));
        }); return;
      }
      if (url.pathname === "/api/tasks" && failGroups) {
        res.statusCode = 503; res.end(JSON.stringify({ error: "Fixture list read failed" })); return;
      }
      const sessionId = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)?.[1];
      if (sessionId && sessionId === delayNextSessionReadId) {
        delayNextSessionReadId = null;
        heldSessionRead = () => { res.end(JSON.stringify(sessions.find(session => session.id === sessionId))); heldSessionRead = null; };
        return;
      }
      const payload = url.pathname === "/api/tasks" ? { groups }
        : url.pathname === "/api/workspace-tasks/fixture-task" ? task
        : sessionId ? sessions.find(session => session.id === sessionId)
        : url.pathname.endsWith("/git-status") ? { isGit: false }
        : url.pathname === "/api/silicon-employees" ? { employees: [] }
        : url.pathname === "/api/pi-resource-packages" ? { packages: [] }
        : url.pathname === "/api/ai-teams" ? [] : {};
      res.end(JSON.stringify(payload ?? {})); return;
    }
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript;charset=utf-8"); res.end(built.outputFiles[0].text); return; }
    if (url.pathname === "/styles.css" || url.pathname === "/tailwind.css") {
      res.setHeader("content-type", "text/css;charset=utf-8"); res.end(readFileSync(join(root, "src/web-ui/content", url.pathname.slice(1)))); return;
    }
    res.setHeader("content-type", "text/html;charset=utf-8");
    if (url.searchParams.has("defaultFocus")) {
      res.end('<!doctype html><html lang="zh-CN" data-wand-page="settings"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>html,body,#fixture-tabs{margin:0;width:100%;height:100%}</style></head><body><div id="fixture-tabs"></div><div id="overlay-root"><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>'); return;
    }
    res.end('<!doctype html><html lang="zh-CN" data-wand-page="settings"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>html,body{margin:0;width:100%;height:100%}.main-content{display:flex;flex-direction:column;width:100%;height:100%;min-width:0}#fixture-tabs{flex:none;min-width:0}#chat-output{flex:1;min-height:0}#input-box{max-width:100%;width:100%;box-sizing:border-box}</style></head><body><main id="app" class="main-content" data-react-shell="enabled"><div id="fixture-tabs"></div><div id="output" class="hidden"></div><div id="chat-output"><div id="chat-messages"></div></div><div id="blank-chat" class="hidden"></div><div class="input-panel"><div class="input-composer"><textarea id="input-box" class="input-textarea" aria-label="Fixture draft"></textarea></div></div></main><div id="overlay-root"><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const reports = [];
  let failedAt = null;
  let failureDiagnostics = null;
  const waitForFreshDocument = async (browser, previousDocumentId) => {
    const expression = `!!window.tabsFixture?.ready&&window.tabsFixture.documentId!==${JSON.stringify(previousDocumentId)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await browser.wait(expression, "new fixture document ready"); return; }
      catch (error) { if (error.message !== "Browser command rejected: Runtime.evaluate" || attempt === 2) throw error; }
    }
  };
  const assertLabel = async browser => {
    await browser.wait("!!document.querySelector('[data-session-tabs=standalone] [role=tab]')", "standalone bar");
    assert.equal(await browser.evaluate("document.querySelector('[data-session-tabs=standalone] .wand-workspace-tabs').getAttribute('aria-label')"), "未分组会话标签");
  };
  const keys = browser => browser.evaluate("[...document.querySelectorAll('[data-session-tabs=standalone] [role=tab]')].map(n=>n.closest('[data-node-key]').dataset.nodeKey)");
  const clickReachable = async (browser, selector) => {
    await browser.settle();
    const point = await browser.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,reachable:!!r.width&&!!r.height&&(n===hit||n.contains(hit))}})()`);
    assert.ok(point?.reachable, `Actual pointer target is reachable: ${selector}`);
    await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await browser.settle();
  };
  const tab = id => `[data-session-tabs=standalone] [data-node-key="${id}"] [role=tab]`;
  const visibleActive = async browser => {
    await browser.settle();
    const geometry = await browser.evaluate("(()=>{const n=document.querySelector('[data-session-tabs=standalone] [role=tab][aria-selected=true]'),clip=n?.closest('.ant-tabs-nav-wrap');if(!n||!clip)return null;const r=n.getBoundingClientRect(),c=clip.getBoundingClientRect();return{left:r.left,right:r.right,clipLeft:c.left,clipRight:c.right,width:r.width,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth}})()");
    assert.ok(geometry, "Active native tab exists");
    assert.ok(geometry.documentWidth <= geometry.viewport + 1, "Tabs never widen the document");
    assert.ok(geometry.left >= geometry.clipLeft - 1 && geometry.right <= geometry.clipRight + 1,
      `Active tab remains inside the native scrolling rail (${JSON.stringify(geometry)})`);
    return geometry;
  };
  try {
    {
      const browser = await openBrowser("about:blank", 1280, 900);
      try {
        failedAt = { width: 1280, stage: "default-home-hidden-composer-focus" };
        await browser.send("Page.navigate", { url: origin + "?defaultFocus=1" });
        await browser.wait("!!window.tabsFixture?.ready&&!!document.querySelector('#input-box')");
        assert.equal(await browser.evaluate("document.querySelector('#input-box').getClientRects().length===0||!!document.querySelector('#input-box').closest('[inert]')"), true,
          "Production Shell begins with the Home composer hidden/inert");
        delayNextSessionReadId = "loose1";
        await browser.evaluate("tabsFixture.defaultSelection=tabsFixture.select('loose1');tabsFixture.syncFocusReachedInput=document.activeElement===document.querySelector('#input-box');true");
        assert.equal(await browser.evaluate("tabsFixture.syncFocusReachedInput"), false,
          "Sync view focus cannot focus the still-hidden production Shell composer");
        await browser.wait("document.querySelector('#input-box').getClientRects().length>0&&!document.querySelector('#input-box').closest('[inert]')");
        for (let n = 0; !heldSessionRead && n < 30; n++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(heldSessionRead, "Default detail request is held independently of React publication");
        heldSessionRead();
        await browser.evaluate("tabsFixture.defaultSelection"); await browser.settle();
        assert.equal(await browser.evaluate("document.activeElement===document.querySelector('#input-box')"), true,
          "Production Shell default selection retains the necessary post-output focus");
        assert.deepEqual(mutations, []);
        assert.deepEqual(browser.errors, []);
        reports.push({ mode: "production-shell-default-focus", hiddenComposerBeforeSelection: true,
          synchronousFocusReachedInput: false, afterOutputInputFocused: true, businessWrites: 0 });
      } finally { if (heldSessionRead) heldSessionRead(); await browser.close(); }
    }
    for (const width of [1280, 390, 320]) {
      mutations.length = 0; failGroups = false;
      const browser = await openBrowser("about:blank", width, 900);
      const stage = value => { failedAt = { width, stage: value }; };
      try {
        if (width < 600) await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
        stage("initial-directory-filter");
        await browser.send("Page.navigate", { url: origin });
        await browser.wait("!!window.tabsFixture?.ready");
        await assertLabel(browser);
        await browser.wait("document.querySelectorAll('[data-session-tabs=standalone] [role=tab]').length===3");
        assert.deepEqual(await keys(browser), ["loose1", "loose2", "loose3"]);
        assert.equal(await browser.evaluate("document.querySelectorAll('[data-session-tabs=standalone] .ant-tabs-tab-remove,[data-session-tabs=standalone] .workspace-tab-move').length"), 0);
        await visibleActive(browser);
        stage("pointer-and-drafts");
        await browser.click("#input-box");
        await browser.send("Input.insertText", { text: "Fixture draft one" });
        // Native overflow menu is an accessible sibling picker when another tab is clipped.
        if (width >= 600) await clickReachable(browser, tab("loose2"));
        else {
          await browser.evaluate("document.querySelector('[data-session-tabs=standalone] [role=tab][aria-selected=true]').focus();true");
          await browser.key("ArrowRight"); await browser.key("Enter");
        }
        await browser.wait("tabsFixture.state.selectedId==='loose2'");
        assert.equal(await browser.evaluate("document.querySelector('#input-box').value"), "");
        assert.equal(await browser.evaluate("tabsFixture.composer.read('loose1').text"), "Fixture draft one");
        await browser.click("#input-box"); await browser.send("Input.insertText", { text: "Fixture draft two" });
        stage("keyboard-selection");
        await browser.evaluate("document.querySelector('[data-session-tabs=standalone] [role=tab][aria-selected=true]').focus();true");
        await browser.key("ArrowRight"); await browser.key("Enter");
        await browser.wait("tabsFixture.state.selectedId==='loose3'", "native ArrowRight/Enter selects third session");
        await browser.settle();
        assert.equal(await browser.evaluate("document.activeElement?.getAttribute('role')"), "tab", "Completed detail GET retains native tab keyboard focus");
        const thirdGeometry = await visibleActive(browser);
        await browser.screenshot(join(output, `source-own-tabs-${width}.png`));
        await browser.key("ArrowLeft"); await browser.key("Enter");
        await browser.wait("tabsFixture.state.selectedId==='loose2'");
        assert.equal(await browser.evaluate("document.querySelector('#input-box').value"), "Fixture draft two");
        await browser.key("ArrowLeft"); await browser.key("Enter");
        await browser.wait("tabsFixture.state.selectedId==='loose1'");
        assert.equal(await browser.evaluate("document.querySelector('#input-box').value"), "Fixture draft one");
        stage("delayed-default-selection-ABA-focus");
        delayNextSessionReadId = "loose1";
        await browser.evaluate("tabsFixture.delayedSelection=tabsFixture.select('loose1');true");
        assert.equal(await browser.evaluate("document.activeElement===document.querySelector('#input-box')"), width >= 600,
          "Default desktop focus remains available while touch selection keeps the software keyboard closed");
        for (let n = 0; !heldSessionRead && n < 30; n++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(heldSessionRead, "Old A output is delayed");
        await browser.evaluate("document.querySelector('[data-session-tabs=standalone] [role=tab][aria-selected=true]').focus();true");
        await browser.key("ArrowRight"); await browser.key("Enter");
        await browser.wait("tabsFixture.state.selectedId==='loose2'");
        await browser.key("ArrowLeft"); await browser.key("Enter");
        await browser.wait("tabsFixture.state.selectedId==='loose1'"); await browser.settle();
        assert.equal(await browser.evaluate("document.activeElement?.getAttribute('role')"), "tab");
        heldSessionRead(); await browser.evaluate("tabsFixture.delayedSelection"); await browser.settle();
        assert.equal(await browser.evaluate("document.activeElement?.getAttribute('role')"), "tab",
          "Late default A detail cannot steal focus after native A→B→A Tab selection");
        stage("new-session-directory");
        await clickReachable(browser, "[data-session-tabs=standalone] .workspace-tab-add");
        assert.equal(await browser.evaluate("tabsFixture.creation().initialCwd"), "/fixture/sandbox");
        assert.equal(await browser.evaluate("!!tabsFixture.creation().workspaceId"), false);
        if (width < 600) assert.equal(await browser.evaluate("document.querySelector('[data-session-tabs=standalone] .workspace-tab-add').getBoundingClientRect().height"), 44);
        await browser.evaluate("tabsFixture.closeCreation();true");
        stage("known-global-new-session-identity");
        await browser.evaluate("tabsFixture.select('global1')"); await assertLabel(browser);
        await clickReachable(browser, "[data-session-tabs=standalone] .workspace-tab-add");
        assert.equal(await browser.evaluate("tabsFixture.creation().initialCwd"), "/fixture/global");
        assert.equal(await browser.evaluate("!!tabsFixture.creation().workspaceId"), false,
          "Known global directory never turns into an explicit project ID");
        await browser.evaluate("tabsFixture.closeCreation();tabsFixture.select('loose1')");
        stage("existing-task-native-tabs");
        await browser.evaluate("tabsFixture.openTask()");
        await browser.wait("document.querySelectorAll('[data-session-tabs=task] [role=tab]').length===2");
        assert.match(await browser.evaluate("document.querySelector('[data-session-tabs=task] .wand-workspace-tabs').getAttribute('aria-label')"), /Fixture 任务/);
        assert.equal(await browser.evaluate("tabsFixture.context().taskId"), "fixture-task");
        assert.equal(await browser.evaluate("document.querySelectorAll('[data-session-tabs=standalone]').length"), 0);
        stage("task-to-synthetic-production-owner");
        await browser.evaluate("tabsFixture.open('loose2')");
        await assertLabel(browser);
        assert.deepEqual(await keys(browser), ["loose1", "loose2", "loose3"]);
        assert.equal(await browser.evaluate("tabsFixture.context().taskId"), null);
        assert.equal(await browser.evaluate("tabsFixture.context().workspaceId"), null);
        assert.equal(await browser.evaluate("tabsFixture.activeTask()"), "");
        assert.equal(await browser.evaluate("tabsFixture.state.selectedId"), "loose2");
        stage("task-to-project-production-owner");
        await browser.evaluate("tabsFixture.openTask();");
        await browser.evaluate("tabsFixture.open('project1')");
        await assertLabel(browser);
        assert.deepEqual(await keys(browser), ["project1", "project2", "project3"]);
        assert.equal(await browser.evaluate("tabsFixture.context().taskId"), null);
        assert.equal(await browser.evaluate("tabsFixture.context().workspaceId"), "fixture-project");
        assert.equal(await browser.evaluate("tabsFixture.activeTask()"), "");
        await clickReachable(browser, "[data-session-tabs=standalone] .workspace-tab-add");
        assert.equal(await browser.evaluate("tabsFixture.creation().workspaceId"), "fixture-project");
        await browser.evaluate("tabsFixture.closeCreation();true");
        stage("canonical-direct-select-exits-task");
        await browser.evaluate("tabsFixture.openTask()");
        await browser.evaluate("tabsFixture.select('loose3')");
        await assertLabel(browser);
        assert.equal(await browser.evaluate("tabsFixture.context().taskId"), null);
        assert.equal(await browser.evaluate("tabsFixture.activeTask()"), "");
        stage("refresh-selection-and-draft");
        await browser.evaluate("tabsFixture.select('loose2')");
        const beforeRefresh = await browser.evaluate("tabsFixture.documentId");
        await browser.send("Page.reload"); await waitForFreshDocument(browser, beforeRefresh);
        await browser.wait("!!window.tabsFixture?.ready&&tabsFixture.state.selectedId==='loose2'");
        await assertLabel(browser); assert.deepEqual(await keys(browser), ["loose1", "loose2", "loose3"]);
        assert.equal(await browser.evaluate("tabsFixture.context().taskId"), null);
        assert.equal(await browser.evaluate("document.querySelector('#input-box').value"), "Fixture draft two");
        stage("failed-list-no-cwd-inference");
        // A fresh document has no directory cache. Failed GET shows only the selected live VM.
        const beforeFailedRead = await browser.evaluate("tabsFixture.documentId");
        failGroups = true; await browser.send("Page.reload"); await waitForFreshDocument(browser, beforeFailedRead);
        await browser.wait("!!window.tabsFixture?.ready"); await assertLabel(browser);
        assert.deepEqual(await keys(browser), ["loose2"]);
        stage("failed-list-known-worktree-project-identity");
        await browser.evaluate("tabsFixture.select('project3')"); await assertLabel(browser);
        assert.deepEqual(await keys(browser), ["project3"], "Failed list never infers project peers");
        await clickReachable(browser, "[data-session-tabs=standalone] .workspace-tab-add");
        assert.equal(await browser.evaluate("tabsFixture.creation().initialCwd"), "/fixture/project/.wand-worktrees/fixture-own");
        assert.equal(await browser.evaluate("tabsFixture.creation().workspaceId"), "fixture-project",
          "Unknown directory projection retains the selected worktree's known project identity");
        await browser.evaluate("tabsFixture.closeCreation();true");
        failGroups = false;
        stage("guard-and-console");
        assert.deepEqual(mutations, [], "Standalone navigation never writes task layout or other business data");
        assert.deepEqual(browser.errors, [], "Production owners raise no browser exception");
        reports.push({ width, directoryCount: 3, excluded: ["different-directory", "task-owned", "archived", "relay"],
          nativeKeyboardSelected: true, draftsRetained: true, refreshRestored: true, activeTabGeometry: thirdGeometry,
          taskTabsPreserved: true, syntheticContextExited: true, projectContextRetainedWithoutTask: true,
          canonicalSelectionExitedTask: true, failedListSelfOnly: true, delayedDefaultSelectionABAFocusRetained: true,
          knownGlobalOmitsProjectId: true, unknownWorktreeRetainsKnownProjectId: true,
          businessWrites: 0, layoutPuts: 0, browserExceptions: 0 });
      } catch (error) {
        failureDiagnostics = { exceptions: browser.errors.slice(), state: await browser.evaluate("({fixture:!!window.tabsFixture,ready:!!window.tabsFixture?.ready,selected:window.tabsFixture?.state.selectedId,context:window.tabsFixture?.context(),ids:[...document.querySelectorAll('[id]')].map(n=>n.id),tabs:[...document.querySelectorAll('[role=tab]')].map(n=>({text:n.textContent,selected:n.getAttribute('aria-selected')}))})").catch(() => null) };
        throw error;
      } finally { if (heldSessionRead) heldSessionRead(); await browser.close(); }
    }
    const result = { capturedAt: new Date().toISOString(), scope: "production source with read-only HTTP fixtures; no installed service", passed: true, reports };
    writeFileSync(join(output, "source-browser-result.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    const capturedAt = new Date().toISOString();
    const failure = JSON.stringify({ capturedAt, passed: false,
      failedAt, message: String(error.message), diagnostics: failureDiagnostics, completed: reports, mutations }, null, 2) + "\n";
    writeFileSync(join(output, "source-browser-failure.json"), failure);
    writeFileSync(join(output, "source-browser-failure-" + capturedAt.replace(/[^0-9]/g, "") + ".json"), failure);
    throw error;
  } finally { await new Promise(resolve => server.close(resolve)); }
}
