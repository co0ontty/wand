import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

// Production Shell / controllers / components with read-only repository fixtures. No model execution.
test("real sidebar session previews adapt, filter, expand and preserve person ownership", {
  skip: process.env.WAND_SESSION_PREVIEW_BROWSER !== "1", timeout: 300_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-session-preview-"));
  const output = join(root, process.env.WAND_SESSION_PREVIEW_OUTPUT ?? "output/sidebar-session-preview");
  mkdirSync(output, { recursive: true });
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import * as React from "react";
import {createRoot} from "react-dom/client";
import {ShellSidebar} from "./src/web-ui/react/shell/shell-sidebar";
import {MemoryUiAdapter} from "./src/web-ui/react/shell/ui-store";
import {UiStoreProvider} from "./src/web-ui/react/shell/ui-store-react";
import {WandUiProvider} from "./src/web-ui/react/theme";
import {installReactUiStyles} from "./src/web-ui/react/styles";
import {configureWorkspacesRuntime} from "./src/web-ui/react/workspaces/controller";
import {setActiveWorkspaceContext} from "./src/web-ui/react/workspaces/workspace-context";
import {conversationUi} from "./src/web-ui/react/conversations/state";
import {taskGroupsStore} from "./src/web-ui/react/workspaces/task-groups-store";
import {notifyConversationChanges} from "./src/web-ui/react/conversations/repository";
installReactUiStyles();
localStorage.setItem("wand.sidebar.displayMode", "folded");
let snapshot={auth:{phase:"authenticated"},viewport:{mobile:innerWidth<640,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},
layout:{sessionsDrawerOpen:true,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:innerWidth<640,sidebarAnchored:innerWidth>=640,sessionsBackdropVisible:false,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:"chat"},selected:null,
sidebar:{groups:[],interactiveCount:0,totalCount:0,manageMode:false,selectedCount:0},topbar:{title:"",description:"",statusLabel:"",statusTone:"idle",cwd:"",currentTask:"",titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:false,blank:true,composer:false}};
const memory=new MemoryUiAdapter(snapshot);
const selectSession=id=>{fixture.opened.push(id);snapshot={...snapshot,selected:{id,source:"wand",provider:"pi",kind:"structured",workspaceId:"w",workspaceTaskId:id.startsWith("b-")?"tb":"ta"}};memory.setSnapshot(snapshot,{sync:true});};
window.fixture={opened:[],conversation:conversationUi,reload:taskGroupsStore.reload,refreshConversations:notifyConversationChanges,liveTitle:(id,title)=>{snapshot={...snapshot,sidebar:{...snapshot.sidebar,groups:[{kind:"interactive",label:"",entries:[{id,title}]}]}};memory.setSnapshot(snapshot,{sync:true});}};
const store={getSnapshot:()=>memory.getSnapshot(),subscribe:memory.subscribe.bind(memory),dispatch(action){memory.dispatch(action);if(action.type==="session.select")selectSession(action.id);}};
configureWorkspacesRuntime({selectSession,openTask(payload){setActiveWorkspaceContext({...payload,layout:null});selectSession(payload.preferredSessionId||"a-design");},openWorkspace(){},closeWorkspace(){},refreshSessions:async()=>{},toast(){},onOpen(){},onClose(){}});
conversationUi.mode("chats");
createRoot(document.getElementById("root")).render(<WandUiProvider><UiStoreProvider store={store}><ShellSidebar/></UiStoreProvider></WandUiProvider>);
` }, bundle: true, platform: "browser", format: "iife", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
  const session = (id: string, title: string, employeeId: string, extra = {}) => ({ id, title, employeeId, employeeName: "同名员工", sessionKind: "structured", provider: "pi", status: "idle", cwd: "/repo", startedAt: "2026-10-13T10:00:00Z", ...extra });
  const sessionsA = [session("a-design", "设计", "employee-a", { engine: "core", inFlight: true }),
    session("a-style", "样式", "employee-a", { provider: "claude", status: "thinking" }), session("a-check", "验收", "employee-a", { provider: "codex" })];
  const sessionsB = Array.from({ length: 12 }, (_, i) => session(`b-${i}`, `另一个人物的独立会话 ${i}`, "employee-b", { provider: "claude", inFlight: i === 0 }));
  const task = (id: string, name: string, sessions: unknown[]) => ({ id, name, workspaceId: "w", cwd: "/repo", sessions, status: "active", createdAt: "", worktree: null });
  const groups = [{ workspaceId: "w", workspaceName: "产品项目", workspaceCwd: "/repo", tasks: [task("ta", "侧栏交互", sessionsA), task("tb", "团队检查", sessionsB)], standaloneSessions: [] }];
  const person = (id: string, employee: string) => ({ id, kind: "dm", owner: "local-owner", peerEmployeeId: employee, title: "同名员工", name: "", nameSource: "auto", tasks: [], preview: "最近回复", messageAt: "", createdAt: "", updatedAt: "", communicationSessionId: null, sessionId: null, memberUnavailableReasons: {}, unavailableReason: null });
  let mutationCount = 0;
  let archivedFixture = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      if (req.method !== "GET") { mutationCount++; res.statusCode = 400; res.end('{}'); return; }
      const directory = archivedFixture && url.searchParams.get("includeArchived") !== "1"
        ? groups.map(g => ({ ...g, tasks: g.tasks.map(task => ({ ...task, sessions: task.sessions.filter((s: any) => !s.archived) })) })) : groups;
      const payload = url.pathname === "/api/tasks" ? { groups: directory, revision: "fixture" }
        : url.pathname === "/api/conversations" ? { conversations: [{ ...person("dm_a", "employee-a"), tasks: archivedFixture ? [{ task: { id: "archived-card", title: "旧工作", status: "archived" } }] : [] }, person("dm_b", "employee-b")] }
        : url.pathname === "/api/silicon-employees" ? { employees: [{ id: "employee-a", name: "同名员工", avatar: "cat:2" }, { id: "employee-b", name: "同名员工", avatar: "cat:3" }] }
        : url.pathname === "/api/config" ? { userProfile: { name: "测试用户" } }
        : url.pathname === "/api/attention" ? { items: [] }
        : url.pathname === "/api/ai-team-runs" ? { runs: [] }
        : url.pathname === "/api/ai-teams" ? [] : {};
      res.end(JSON.stringify(payload)); return;
    }
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (url.pathname === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="height:100dvh;display:flex"></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const results: string[] = [];
  for (const mode of ["desktop", "native", "rollback", "mobile"]) {
    archivedFixture = false;
    groups[0].tasks[0].sessions = sessionsA;
    const browser = await openBrowser(`http://127.0.0.1:${address.port}/${mode === "rollback" ? "?reactUi=0" : ""}`, mode === "mobile" ? 390 : 1440, 1000);
    try {
      await browser.wait("!!document.documentElement && !!window.fixture", "production React fixture bootstrapped before native shell flags");
      if (mode === "native") await browser.evaluate("document.documentElement.classList.add('is-wand-app');true");
      await browser.wait("document.querySelectorAll('[data-conversation-id=dm_a]').length===1 && document.querySelectorAll('[data-conversation-id=dm_b]').length===1 && !!document.querySelector('.conversation-list-item:has([data-conversation-id=dm_b]) .sidebar-session-more[data-hidden-count]')");
      const a = '.conversation-list-item:has([data-conversation-id="dm_a"])';
      const b = '.conversation-list-item:has([data-conversation-id="dm_b"])';
      assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('${a} [data-preview-session-id]')).map(n=>n.dataset.previewSessionId).join(',')`), "a-check,a-design,a-style", "same-name employees remain isolated");
      const shownB = await browser.evaluate(`document.querySelectorAll('${b} [data-preview-session-id]').length`);
      const hiddenB = await browser.evaluate(`Number(document.querySelector('${b} .sidebar-session-more[data-hidden-count]').dataset.hiddenCount)`);
      assert.ok(shownB > 0 && shownB < 12); assert.equal(shownB + hiddenB, 12);
      assert.equal(await browser.evaluate(`document.querySelector('${b} .sidebar-session-more[data-hidden-count]').textContent`), `+${hiddenB}`);
      assert.equal(await browser.evaluate(`(()=>{const row=document.querySelector('${b} .sidebar-session-preview-row'),css=getComputedStyle(row),tags=[...row.querySelectorAll('[data-preview-session-id]')],more=row.querySelector('[data-hidden-count]'),gap=parseFloat(css.columnGap),available=row.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight),used=tags.reduce((s,n)=>s+n.getBoundingClientRect().width,0)+more.getBoundingClientRect().width+gap*tags.length;return row.scrollWidth<=row.clientWidth && available-used<tags[0].getBoundingClientRect().width+gap})()`), true, "the measured visible region is filled without horizontal scrolling");
      assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('${b} [data-preview-session-id]')).every(n=>n.querySelector('[data-provider-logo=claude]'))`), true);
      await browser.screenshot(join(output, `${mode}-people-folded.png`));
      assert.equal(await browser.evaluate(`(()=>{const h=document.querySelector('${a} .conversation-session-toggle').getBoundingClientRect(),m=document.querySelector('${a} .conversation-row-more').getBoundingClientRect();return h.right<=m.left || m.right<=h.left || h.bottom<=m.top || m.bottom<=h.top})()`), true, "person disclosure and existing menu hit targets must not overlap");
      const headerBefore = await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getBoundingClientRect().toJSON()`);
      await browser.click(`${a} .conversation-session-toggle`);
      assert.equal(await browser.evaluate(`(()=>{const n=document.querySelector('${a} .sidebar-session-preview');return n.inert && n.getBoundingClientRect().height===0})()`), true);
      assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('${a} .conversation-person-sessions [data-session-id]')).every(n=>n.dataset.sessionId.startsWith('a-'))`), true);
      const headerAfter = await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getBoundingClientRect().toJSON()`);
      assert.equal(headerBefore.x, headerAfter.x); assert.equal(headerBefore.y, headerAfter.y);
      await browser.key("Escape");
      assert.equal(await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getAttribute('aria-expanded')`), "false");
      const openedBeforeMore = await browser.evaluate("fixture.opened.length");
      await browser.click(`${b} .sidebar-session-more[data-hidden-count]`);
      assert.equal(await browser.evaluate("fixture.opened.length"), openedBeforeMore, "+N expands the exact matching list without selecting any hidden session");
      assert.equal(await browser.evaluate(`document.querySelectorAll('${b} .conversation-person-sessions [data-session-id]').length`), 12);
      assert.equal(await browser.evaluate(`(()=>{const n=document.querySelector('${b} .conversation-person-sessions');return n.clientHeight<=Math.min(innerHeight*.45,360)&&n.scrollHeight>n.clientHeight})()`), true, "long second-level menus scroll internally instead of burying other people");
      await browser.click(`${b} .conversation-session-toggle`);
      await browser.click('.conversation-search-input input');
      await browser.send("Input.insertText", { text: "设计" });
      await browser.wait("document.querySelectorAll('.conversation-row').length===1 && document.querySelectorAll('.conversation-list-item [data-preview-session-id]').length===1");
      await browser.wait(`document.querySelector('${a} .sidebar-session-preview-row').dataset.titleMode==='full'`);
      const title = await browser.evaluate(`document.querySelector('${a} .sidebar-session-tag-title').textContent`);
      assert.equal(title, "设计");
      await browser.evaluate(`document.querySelector('${a} .sidebar-session-preview').style.width='48px';true`);
      await browser.wait(`document.querySelector('${a} .sidebar-session-preview-row').dataset.titleMode==='icons'`);
      assert.equal(await browser.evaluate(`document.querySelectorAll('${a} [data-preview-session-id]').length`), 1);
      await browser.evaluate(`document.querySelector('${a} .sidebar-session-preview').style.width='';true`);
      await browser.wait(`document.querySelector('${a} .sidebar-session-preview-row').dataset.titleMode==='full'`);
      await browser.click('.conversation-search-input [aria-label="清空搜索"]');
      await browser.wait("document.querySelectorAll('.conversation-row').length===2");
      await browser.click(`${a} [data-preview-session-id="a-design"]`);
      await browser.wait("fixture.opened.includes('a-design')");
      assert.equal(await browser.evaluate(`document.querySelector('${a} .sidebar-session-preview').getBoundingClientRect().height`), 0);
      await browser.screenshot(join(output, `${mode}-people-expanded.png`));
      await browser.key("Escape");
      // Keep the original parent selection behavior; child navigation does not forge a new DM.
      await browser.click('.conversation-navigation [data-stretch-value="tasks"]');
      await browser.wait("!!document.querySelector('[data-workspace-task-id=ta] .sidebar-session-preview')");
      const ta = '[data-workspace-task-id="ta"]';
      // It was opened by the real owning-task path; fold it to view the same three tags.
      if (await browser.evaluate(`document.querySelector('${ta} .workspace-task-chevron-btn').getAttribute('aria-expanded')==='true'`)) await browser.click(`${ta} .workspace-task-chevron-btn`);
      assert.equal(await browser.evaluate(`document.querySelectorAll('${ta} [data-preview-session-id]').length`), 3);
      const tb = '[data-workspace-task-id="tb"]';
      const taskOpenedBeforeMore = await browser.evaluate("fixture.opened.length");
      await browser.click(`${tb} .sidebar-session-more[data-hidden-count]`);
      assert.equal(await browser.evaluate(`document.querySelectorAll('${tb} .workspace-task-sessions .workspace-session').length`), 12);
      assert.equal(await browser.evaluate(`document.querySelector('${tb} .sidebar-session-preview').getBoundingClientRect().height`), 0);
      assert.equal(await browser.evaluate("fixture.opened.length"), taskOpenedBeforeMore, "workspace +N also only expands the matching list");
      await browser.key("Escape");
      await browser.click('.sidebar-list-actions [aria-label="搜索任务或会话"]');
      await browser.click('.sidebar-search-input input');
      await browser.send("Input.insertText", { text: "设计" });
      await browser.wait(`document.querySelectorAll('${ta} [data-preview-session-id]').length===1`);
      assert.equal(await browser.evaluate(`document.querySelectorAll('${ta} .workspace-task-sessions .workspace-session').length`), 1, "preview and actual session list share the child display filter");
      // The full scope remains a three-session task, even though only one child matches the search.
      assert.equal(await browser.evaluate(`document.querySelector('${ta} .workspace-task-count').textContent.trim()`), "1/3");
      await browser.click('.sidebar-search-input [aria-label="清空工作区搜索"]');
      await browser.click('.sidebar-view-switch [data-stretch-value="recent"]');
      await browser.wait("document.querySelectorAll('.sidebar-recent-groups .im-sidebar-group').length===2");
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.sidebar-recent-groups .im-sidebar-group')].map(g=>Number(g.querySelector('.sidebar-session-preview-row').dataset.totalCount)).sort((a,b)=>a-b).join(',')"), "3,12");
      const recent = '.sidebar-recent-groups .im-sidebar-group:has([data-preview-session-id="b-0"])';
      await browser.click(`${recent} .sidebar-session-more[data-hidden-count]`);
      assert.equal(await browser.evaluate(`document.querySelector('${recent} .sidebar-session-preview').getBoundingClientRect().height`), 0);
      assert.equal(await browser.evaluate(`document.querySelectorAll('${recent} .im-sidebar-group-inner [data-session-id]').length`), 12);
      assert.equal(await browser.evaluate(`document.querySelector('${recent} .im-sidebar-group-inner').clientHeight<=360`), true);
      await browser.key("Escape");
      // The real API omits this tier unless the shared repository opts in.
      archivedFixture = true;
      groups[0].tasks[0].sessions = [...sessionsA, session("a-archived", "旧工作", "employee-a", { archived: true, status: "stopped" })];
      await browser.evaluate("fixture.refreshConversations();fixture.reload().then(()=>true)");
      await browser.click('.conversation-navigation [data-stretch-value="chats"]');
      await browser.wait(`!!document.querySelector('${a} [data-preview-session-id="a-archived"]')`);
      await browser.click('.conversation-list-filter [data-stretch-value="archived"]');
      await browser.wait("document.querySelectorAll('.conversation-row').length===1 && document.querySelectorAll('.conversation-list-item [data-preview-session-id]').length===1");
      assert.equal(await browser.evaluate("document.querySelector('.conversation-list-item [data-preview-session-id]').dataset.previewSessionId"), "a-archived");
      await browser.click(`${a} .conversation-session-toggle`);
      assert.equal(await browser.evaluate(`document.querySelectorAll('${a} .conversation-person-sessions [data-session-id]').length`), 1);
      assert.equal(await browser.evaluate(`document.querySelector('${a} .conversation-person-sessions [data-session-id]').dataset.sessionId`), "a-archived");
      await browser.key("Escape");
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.sidebar-session-preview')].every(n=>getComputedStyle(n).transitionProperty==='none')"), true);
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
      assert.deepEqual(browser.errors, []);
      results.push(`${mode}: person ownership/12 separate same-tool sessions/filter/adaptive titles/expansion/focus/navigation/workspace display scope/+N count and maximum fit/no arbitrary hidden selection/recent full list/archive tier/reduced motion passed`);
      writeFileSync(join(output, "progress.json"), JSON.stringify({ results, mutationCount }, null, 2));
    } catch (error) {
      await browser.screenshot(join(output, `${mode}-failure.png`)).catch(() => {});
      throw error;
    } finally { await browser.close(); }
  }
  assert.equal(mutationCount, 0, "all browser verification stays read-only");
  writeFileSync(join(output, "verification.json"), JSON.stringify({ ok: true, results, mutationCount }, null, 2));
});
