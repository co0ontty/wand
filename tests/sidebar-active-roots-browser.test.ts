import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

// Source DOM coverage for data states absent from the user's installed dataset. No mutations or models.
test("activity filtering keeps workspace and identity roots across responsive sidebar variants", {
  skip: process.env.WAND_SIDEBAR_ACTIVE_BROWSER !== "1", timeout: 240_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const output = join(root, process.env.WAND_SIDEBAR_ACTIVE_OUTPUT ?? "output/architecture-stage2/sidebar-active-roots/browser");
  mkdirSync(output, { recursive: true });
  const bundle = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { ShellSidebar } from "./src/web-ui/react/shell/shell-sidebar";
    import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
    import { UiStoreProvider } from "./src/web-ui/react/shell/ui-store-react";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { conversationUi } from "./src/web-ui/react/conversations/state";
    import { notifyTasksChanged } from "./src/web-ui/react/task-changes";
    installReactUiStyles(); conversationUi.mode("tasks");
    const directoryName = "活动过滤仍保留完整工作区名称".repeat(3);
    const session = (id, employeeId, extra = {}) => ({ id, title:id, employeeId, provider:"pi", sessionKind:"structured",
      status:"idle", startedAt:"2026-10-10T08:00:00Z", ...extra });
    let groups = [
      { workspaceId:"busy", workspaceName:directoryName, workspaceCwd:"/fixture/busy", tasks:[{
        id:"task", workspaceId:"busy", name:"有活动的任务", cwd:"/fixture/busy", status:"active", createdAt:"2026-10-10T08:00:00Z",
        sessions:[session("busy-session", "e1", {inFlight:true}), session("current-idle", "e1")],
      }], standaloneSessions:[session("idle-employee", "e2"), session("idle-shell", null, {provider:undefined,sessionKind:"pty"})] },
      { workspaceId:"idle", workspaceName:"空闲工作区", workspaceCwd:"/fixture/idle", synthetic:true, tasks:[], standaloneSessions:[session("older-idle", "e2")] },
      { workspaceId:"empty", workspaceName:"空工作区", workspaceCwd:"/fixture/empty", tasks:[], standaloneSessions:[] },
    ];
    let revision = 0;
    window.fixture = { mutations:[], directoryName };
    window.fetch = async (input, init) => {
      const url = String(input);
      if (init?.method && init.method !== "GET") { fixture.mutations.push(url); throw new Error("No fixture mutations"); }
      const body = url.startsWith("/api/tasks") ? { groups, revision:String(revision), unchanged:false }
        : url.startsWith("/api/silicon-employees") ? {employees:[{id:"e1",name:"运行员工",avatar:"cat:1",agents:[]},{id:"e2",name:"空闲员工",avatar:"cat:2",agents:[]}]}
        : url.startsWith("/api/attention") ? {items:[]} : url.startsWith("/api/ai-team-runs") ? {runs:[]}
        : url.startsWith("/api/conversations") ? {conversations:[]} : {};
      return new Response(JSON.stringify(body), {headers:{"content-type":"application/json"}});
    };
    const mobile = innerWidth < 600;
    const initial = {auth:{phase:"authenticated"},viewport:{mobile,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},
      layout:{sessionsDrawerOpen:true,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:mobile,sidebarAnchored:!mobile,sessionsBackdropVisible:mobile,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:"chat"},
      selected:null,sidebar:{groups:[],interactiveCount:5,totalCount:5,manageMode:false,selectedCount:0},
      topbar:{title:"",description:"",statusLabel:"",statusTone:"idle",cwd:"",currentTask:"",titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:false,blank:true,composer:false}};
    const memory = new MemoryUiAdapter(initial,{batchMs:0});
    fixture.selectIdle = () => memory.setSnapshot({...initial,selected:{id:"current-idle",source:"wand",provider:"pi",kind:"structured",workspaceId:"busy",workspaceTaskId:"task"}}, {sync:true});
    fixture.clearSelection = () => memory.setSnapshot(initial, {sync:true});
    fixture.stop = () => { groups = groups.map(group => ({...group,tasks:group.tasks.map(task => ({...task,sessions:task.sessions.map(session => ({...session,inFlight:false}))}))})); revision++; notifyTasksChanged(); };
    createRoot(document.getElementById("root")).render(<WandUiProvider><UiStoreProvider store={memory}><ShellSidebar/></UiStoreProvider></WandUiProvider>);
  ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const reports: unknown[] = [];
  for (const mode of ["desktop", "mobile", "narrow", "native", "reduced"]) {
    const width = mode === "mobile" ? 390 : mode === "narrow" ? 320 : 1280;
    const browser = await openBrowser("about:blank", width, 900);
    try {
      if (mode === "reduced") await browser.send("Emulation.setEmulatedMedia", { features:[{name:"prefers-reduced-motion",value:"reduce"}] });
      if (mode === "mobile" || mode === "narrow") await browser.send("Emulation.setTouchEmulationEnabled", { enabled:true,maxTouchPoints:1 });
      const { frameTree } = await browser.send("Page.getFrameTree");
      await browser.send("Page.setDocumentContent", { frameId:frameTree.frame.id,html:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app" data-react-shell="enabled"><div id="root"></div></div><div id="overlay-root"><div id="wand-react-ui-portals"></div></div></body></html>' });
      await browser.evaluate(`for (const css of ${JSON.stringify([readFileSync(join(root,"src/web-ui/content/tailwind.css"),"utf8"),readFileSync(join(root,"src/web-ui/content/styles.css"),"utf8"),'html,body,#app,#root{height:100%;margin:0}#root{display:flex}'])}) { const style=document.createElement('style');style.textContent=css;document.head.append(style); }`);
      if (mode === "native") await browser.evaluate("document.documentElement.classList.add('is-wand-app');true");
      await browser.evaluate(bundle.outputFiles[0].text);
      await browser.wait("document.querySelectorAll('.workspace-item').length===3");
      await browser.settle();
      const roots = () => browser.evaluate("Array.from(document.querySelectorAll('.workspace-row-title')).map(n=>n.textContent)");
      const full = await roots();
      await browser.click('[aria-label="只看活动会话"]');
      assert.deepEqual(await roots(), full);
      assert.equal(await browser.evaluate("document.querySelector('[data-sidebar-tree-directory-id=busy] .workspace-row-count').textContent.trim()"), "1/4");
      assert.equal(await browser.evaluate("document.querySelector('[data-sidebar-tree-directory-id=idle] .workspace-row-count').textContent.trim()"), "0/1");
      assert.equal(await browser.evaluate("document.querySelector('[data-sidebar-tree-directory-id=idle] .workspace-row-main').getAttribute('aria-expanded')"), "false");
      await browser.click('[data-sidebar-tree-directory-id=idle] .workspace-row-main');
      assert.equal(await browser.evaluate("document.querySelector('[data-sidebar-tree-directory-id=idle] .workspace-tasks').innerText.trim()"), "暂无活动会话");
      assert.equal(await browser.evaluate("document.querySelector('[data-sidebar-tree-directory-id=idle] .workspaces-empty-action')===null"), true);
      // A truncated root shares its button's hover/focus tooltip and Escape dismissal.
      await browser.evaluate("document.querySelector('[data-sidebar-tree-directory-id=busy] .workspace-row-main').focus();true");
      await browser.wait("Array.from(document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)')).some(n=>n.textContent.includes(fixture.directoryName))", "full directory name tooltip");
      await browser.key("Escape");
      await browser.click('.sidebar-view-switch [data-stretch-value=recent]');
      await browser.wait("document.querySelectorAll('.im-sidebar-group').length===3");
      assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('.im-sidebar-group-title')).map(n=>n.textContent)"), ["运行员工", "空闲员工", "空白终端"]);
      assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('.im-sidebar-group-count')).map(n=>n.textContent)"), ["1/2", "0/2", "0/1"]);
      assert.equal(await browser.evaluate("!!document.querySelector('[aria-label=\"与空闲员工新建对话\"]')"), true);
      const geometry = await browser.evaluate("Array.from(document.querySelectorAll('.im-sidebar-group-header')).map(n=>{const avatar=n.querySelector('.im-sidebar-group-avatar').getBoundingClientRect(),title=n.querySelector('.im-sidebar-group-title').getBoundingClientRect();return {avatar:avatar.width,overlap:avatar.right>title.left,title:title.width}})");
      assert.ok(geometry.every((g: {avatar:number;overlap:boolean;title:number}) => g.avatar === 36 && !g.overlap && g.title > 0));
      await browser.evaluate("document.querySelector('[aria-label^=\"空闲员工 ·\"]').focus();true");
      const before = await browser.evaluate("document.querySelector('[aria-label^=\"空闲员工 ·\"]').getBoundingClientRect().toJSON()");
      await browser.key("ArrowRight");
      assert.equal(await browser.evaluate("document.querySelector('[aria-label^=\"空闲员工 ·\"]').getAttribute('aria-expanded')"), "true");
      const after = await browser.evaluate("document.querySelector('[aria-label^=\"空闲员工 ·\"]').getBoundingClientRect().toJSON()");
      assert.equal(after.y, before.y); assert.equal(after.width, before.width); assert.equal(after.height, before.height);
      await browser.key("ArrowLeft");
      await browser.evaluate("fixture.selectIdle();true");
      await browser.wait("!!document.querySelector('.sidebar-recent [data-session-id=\"current-idle\"]')");
      assert.equal(await browser.evaluate("document.querySelector('.im-sidebar-group-count').textContent"), "2");
      await browser.evaluate("fixture.clearSelection();true");
      await browser.click('[aria-label="搜索任务或会话"]');
      await browser.send("Input.insertText", {text:"空闲员工"});
      await browser.wait("document.querySelectorAll('.im-sidebar-group').length===1");
      assert.equal(await browser.evaluate("document.querySelector('.im-sidebar-group-title').textContent"), "空闲员工");
      assert.equal(await browser.evaluate("document.querySelector('.im-sidebar-group-count').textContent"), "0/2");
      await browser.key("Escape");
      await browser.wait("document.querySelectorAll('.im-sidebar-group').length===3");
      await browser.evaluate("fixture.stop();true");
      await browser.wait("Array.from(document.querySelectorAll('.im-sidebar-group-count')).every(n=>n.textContent.startsWith('0/'))");
      assert.match(await browser.evaluate("document.querySelector('.sidebar-recent').innerText"), /现在没有活动会话/);
      await browser.screenshot(join(output, `${mode}-recent.png`));
      await browser.click('.sidebar-view-switch [data-stretch-value=directory]');
      assert.deepEqual(await roots(), full);
      assert.equal(await browser.evaluate("document.querySelector('.workspace-row-count').textContent.trim()"), "0/4");
      assert.match(await browser.evaluate("document.querySelector('.sidebar-results').innerText"), /现在没有活动会话/);
      await browser.screenshot(join(output, `${mode}-directory.png`));
      const overflow = await browser.evaluate("({page:document.documentElement.scrollWidth>innerWidth,list:document.querySelector('.sidebar-list-panel').scrollWidth>document.querySelector('.sidebar-list-panel').clientWidth})");
      assert.deepEqual(overflow, {page:false,list:false});
      assert.deepEqual(browser.errors, []);
      assert.deepEqual(await browser.evaluate("fixture.mutations"), []);
      reports.push({ mode,width,rootsPreserved:true,emptyCounts:true,avatarGeometry:geometry,overflow,keyboard:true,currentSession:true,search:true });
    } catch (error) {
      const state = await browser.evaluate("({focus:document.activeElement?.outerHTML.slice(0,1000),titles:Array.from(document.querySelectorAll('.workspace-row-title')).map(n=>({text:n.textContent,client:n.clientWidth,scroll:n.scrollWidth,rect:n.getBoundingClientRect().toJSON()})),tooltips:Array.from(document.querySelectorAll('.ant-tooltip')).map(n=>({text:n.textContent,display:getComputedStyle(n).display})),errors:fixture.mutations})");
      writeFileSync(join(output, `${mode}-failure.json`), JSON.stringify(state, null, 2));
      await browser.screenshot(join(output, `${mode}-failure.png`));
      throw error;
    } finally { await browser.close(); }
  }
  writeFileSync(join(output, "evidence.json"), JSON.stringify(reports, null, 2));
});
