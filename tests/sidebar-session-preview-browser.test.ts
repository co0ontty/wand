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
import {OverlayHost} from "./src/web-ui/react/overlay-host";
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
createRoot(document.getElementById("root")).render(<WandUiProvider><UiStoreProvider store={store}><ShellSidebar/><OverlayHost/></UiStoreProvider></WandUiProvider>);
` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
  await build({ entryPoints: [join(root, "src/web-ui/react/avatars/renderer.ts")], bundle: true, platform: "browser", format: "iife", minify: true, outfile: join(temp, "plush-avatar.js"), logLevel: "warning" });
  writeFileSync(join(temp, "app.js"), readFileSync(join(temp, "app.js"), "utf8").replaceAll("${plushAvatarChunkSrc}", "/plush-avatar.js"));
  const session = (id: string, title: string, employeeId: string, extra = {}) => ({ id, title, employeeId, employeeName: "同名员工", sessionKind: "structured", provider: "pi", status: "idle", cwd: "/repo", startedAt: "2026-10-13T10:00:00Z", ...extra });
  const sessionsA = [session("a-design", "设计", "employee-a", { engine: "core", inFlight: true }),
    session("a-style", "样式", "employee-a", { provider: "claude", status: "thinking" }), session("a-check", "验收", "employee-a", { provider: undefined, sessionKind: "pty", command: "/bin/zsh" })];
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
      const sessions = directory.flatMap(group => [...group.tasks.flatMap(task => task.sessions), ...group.standaloneSessions]);
      const payload = url.pathname === "/api/sessions" ? sessions
        : url.pathname === "/api/tasks" ? { groups: directory, revision: "fixture" }
        : url.pathname === "/api/conversations" ? { conversations: [{ ...person("dm_a", "employee-a"), tasks: archivedFixture ? [{ task: { id: "archived-card", title: "旧工作", status: "archived" } }] : [] }, person("dm_b", "employee-b"), person("dm_empty", "employee-empty")] }
        : url.pathname === "/api/silicon-employees" ? { employees: [{ id: "employee-a", name: "同名员工", avatar: "cat:2" }, { id: "employee-b", name: "同名员工", avatar: "cat:3" }, { id: "employee-empty", name: "空会话员工", avatar: "cat:2" }] }
        : url.pathname === "/api/config" ? { userProfile: { name: "测试用户" } }
        : url.pathname === "/api/attention" ? { items: [] }
        : url.pathname === "/api/ai-team-runs" ? { runs: [] }
        : url.pathname === "/api/ai-teams" ? [] : {};
      res.end(JSON.stringify(payload)); return;
    }
    if (url.pathname === "/app.js" || url.pathname === "/plush-avatar.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, url.pathname.slice(1)))); return; }
    if (url.pathname === "/tailwind.css" || url.pathname === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content", url.pathname.slice(1)))); return; }
    res.setHeader("content-type", "text/html");
    // Match production's SVG preflight; without it the terminal mark's line break is invisible here.
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="height:100dvh;display:flex"></div><div id="overlay-root"><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>');
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
      assert.equal(await browser.evaluate("!!document.querySelector('[data-conversation-id=dm_empty]') && !!document.querySelector('.conversation-list-item:has([data-conversation-id=dm_empty]) .sidebar-session-area[data-empty]') && !document.querySelector('.conversation-list-item:has([data-conversation-id=dm_empty]) [data-preview-session-id], .conversation-list-item:has([data-conversation-id=dm_empty]) .conversation-session-toggle')"), true, "zero matched sessions keep the reserved empty preview band and the person entry");
      assert.ok(await browser.evaluate("document.querySelector('.conversation-list-item:has([data-conversation-id=dm_empty]) .sidebar-session-area[data-empty]').getBoundingClientRect().height") >= (mode === "mobile" ? 44 : 36), "reserved empty band keeps the person row from collapsing");
      const a = '.conversation-list-item:has([data-conversation-id="dm_a"])';
      const b = '.conversation-list-item:has([data-conversation-id="dm_b"])';
      assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('${a} [data-preview-session-id]')).map(n=>n.dataset.previewSessionId).join(',')`), "a-check,a-design,a-style", "same-name employees remain isolated");
      const shownB = await browser.evaluate(`document.querySelectorAll('${b} [data-preview-session-id]').length`);
      const hiddenB = await browser.evaluate(`Number(document.querySelector('${b} .sidebar-session-more[data-hidden-count]').dataset.hiddenCount)`);
      assert.ok(shownB > 0 && shownB < 12); assert.equal(shownB + hiddenB, 12);
      assert.equal(await browser.evaluate(`document.querySelector('${b} .sidebar-session-more[data-hidden-count]').textContent`), `+${hiddenB}`);
      assert.equal(await browser.evaluate(`(()=>{const row=document.querySelector('${b} .sidebar-session-preview-row'),css=getComputedStyle(row),tags=[...row.querySelectorAll('[data-preview-session-id]')],more=row.querySelector('[data-hidden-count]'),gap=parseFloat(css.columnGap),available=row.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight),used=tags.reduce((s,n)=>s+n.getBoundingClientRect().width,0)+more.getBoundingClientRect().width+gap*tags.length;return row.scrollWidth<=row.clientWidth && available-used<tags[0].getBoundingClientRect().width+gap})()`), true, "the measured visible region is filled without horizontal scrolling");
      assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('${b} [data-preview-session-id]')).every(n=>n.querySelector('[data-provider-logo=claude]'))`), true);
      const assertTagAlignment = async () => {
        const misaligned = await browser.evaluate(`Array.from(document.querySelectorAll('.sidebar-session-preview:not([data-expanded="true"]) [data-preview-session-id]')).flatMap(tag=>{
          const status=tag.querySelector('.sidebar-session-preview-status').getBoundingClientRect();
          const mark=tag.querySelector('.sidebar-provider-mark,[data-wand-icon="terminal"]').getBoundingClientRect();
          const button=tag.getBoundingClientRect(),center=button.y+button.height/2;
          return Math.abs(status.y+status.height/2-center)<=1 && Math.abs(mark.y+mark.height/2-center)<=1 && mark.left-status.right>=3 && mark.bottom<=button.bottom && mark.top>=button.top
            ? [] : [{terminal:!!tag.querySelector('[data-wand-icon="terminal"]'),statusCenter:status.y+status.height/2,markCenter:mark.y+mark.height/2,center,gap:mark.left-status.right}];
        })`);
        assert.deepEqual(misaligned, [], "status and terminal/provider mark share one centered row inside every preview button");
      };
      assert.equal(await browser.evaluate(`!!document.querySelector('${a} [data-preview-session-id="a-check"] [data-wand-icon="terminal"]')`), true);
      await assertTagAlignment();
      await browser.evaluate(`document.querySelector('${a} .sidebar-session-preview').style.width='128px';true`);
      await browser.wait(`document.querySelector('${a} .sidebar-session-preview-row').dataset.titleMode==='icons'`);
      await assertTagAlignment();
      await browser.screenshot(join(output, `${mode}-terminal-icons.png`));
      await browser.evaluate(`document.querySelector('${a} .sidebar-session-preview').style.width='';true`);
      await browser.screenshot(join(output, `${mode}-people-folded.png`));
      assert.equal(await browser.evaluate(`(()=>{const h=document.querySelector('${a} .conversation-session-toggle').getBoundingClientRect(),m=document.querySelector('${a} .conversation-row-more').getBoundingClientRect();return h.right<=m.left || m.right<=h.left || h.bottom<=m.top || m.bottom<=h.top})()`), true, "person disclosure and existing menu hit targets must not overlap");
      const headerBefore = await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getBoundingClientRect().toJSON()`);
      const personOpenedBeforeParent = await browser.evaluate("fixture.opened.length");
      await browser.click(`${a} .conversation-row-open`);
      assert.equal(await browser.evaluate("fixture.conversation.getSnapshot().selectedId"), "dm_a", "person header enters the employee conversation");
      assert.equal(await browser.evaluate("fixture.opened.length"), personOpenedBeforeParent, "person header does not select an execution session");
      assert.equal(await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getAttribute('aria-expanded')`), "false");
      assert.equal(await browser.evaluate(`(()=>{const g=document.querySelector('${a} .conversation-session-toggle').getBoundingClientRect(),tag=document.querySelector('${a} .sidebar-session-preview-row').getBoundingClientRect(),head=document.querySelector('${a} [data-conversation-id]').getBoundingClientRect();return g.top>=head.top-1 && g.bottom<=head.bottom+1 && tag.top>=head.bottom-1 && !document.querySelector('${a} .sidebar-session-area .sidebar-session-area-toggle')})()`), true, "header owns disclosure and the preview band does not reserve an arrow column");
      await browser.click(`${a} .conversation-session-toggle`);
      assert.equal(await browser.evaluate(`(()=>{const n=document.querySelector('${a} .sidebar-session-preview');return n.inert && n.getBoundingClientRect().height===0})()`), true);
      assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('${a} .conversation-person-sessions [data-session-id]')).every(n=>n.dataset.sessionId.startsWith('a-'))`), true);
      assert.equal(await browser.evaluate(`(()=>{const c=document.querySelector('${a} .conversation-person-sessions .im-sidebar-item-avatar-wrap').getBoundingClientRect(),p=document.querySelector('${a} .conversation-row-avatar').getBoundingClientRect();return c.left-p.left>=8 && c.left-p.left<=44})()`), true, "person child indentation is compact but keeps a visible hierarchy");
      await browser.click(`${a} .conversation-person-session:has([data-session-id="a-check"])`, "right");
      await browser.wait("!!document.querySelector('.workspace-session-menu')");
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.workspace-session-menu [role=menuitem]')].some(n=>n.textContent.includes('归档会话')) && [...document.querySelectorAll('.workspace-session-menu [role=menuitem]')].some(n=>n.textContent.includes('删除会话')) && !!document.querySelector('.workspace-session-menu .ant-dropdown-menu-submenu-title')"), true, "private conversation sessions share the complete management menu");
      await browser.click('.workspace-session-menu .ant-dropdown-menu-submenu-title');
      await browser.wait("!!document.querySelector('.workspace-session-move-menu')");
      await browser.key("Escape");
      await browser.key("Escape");
      await browser.wait("!document.querySelector('.workspace-session-menu')");
      assert.equal(await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getAttribute('aria-expanded')`), "true", "closing a session menu must not close its person list");
      await browser.click(`${a} .conversation-person-session:has([data-session-id="a-check"])`, "right");
      await browser.wait("!!document.querySelector('.workspace-session-menu')");
      const deleteHit = await browser.evaluate(`(()=>{const node=[...document.querySelectorAll('.workspace-session-menu [role=menuitem]')].find(n=>n.textContent.includes('删除会话'));if(!node)return null;const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:node===hit||node.contains(hit),actual:hit?.outerHTML.slice(0,180),text:node.textContent}})()`);
      assert.equal(deleteHit?.hit, true, `delete action is reachable: ${JSON.stringify(deleteHit)}`);
      await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: deleteHit.x, y: deleteHit.y, button: "left", clickCount: 1 });
      await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: deleteHit.x, y: deleteHit.y, button: "left", clickCount: 1 });
      await browser.settle();
      await browser.wait("!!document.querySelector('[data-wand-dialog-surface]')");
      await browser.key("Escape");
      await browser.wait("!document.querySelector('[data-wand-dialog-surface]')");
      assert.equal(await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getAttribute('aria-expanded')`), "true", "canceling the shared destructive confirmation preserves the list and session");
      const headerAfter = await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getBoundingClientRect().toJSON()`);
      assert.equal(headerBefore.x, headerAfter.x); assert.equal(headerBefore.y, headerAfter.y);
      const focusAfterCancel = await browser.evaluate("({tag:document.activeElement?.tagName,className:document.activeElement?.className,inSidebar:!!document.activeElement?.closest?.('#sessions-drawer'),menu:!!document.querySelector('.workspace-session-menu')})");
      await browser.key("Escape");
      assert.equal(await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getAttribute('aria-expanded')`), "false", JSON.stringify(focusAfterCancel));
      const openedBeforeMore = await browser.evaluate("fixture.opened.length");
      await browser.click(`${b} .sidebar-session-more[data-hidden-count]`);
      assert.equal(await browser.evaluate("fixture.opened.length"), openedBeforeMore, "+N expands the exact matching list without selecting any hidden session");
      assert.equal(await browser.evaluate(`document.querySelectorAll('${b} .conversation-person-sessions [data-session-id]').length`), 12);
      assert.equal(await browser.evaluate(`(()=>{const n=document.querySelector('${b} .conversation-person-sessions');return n.clientHeight<=Math.min(innerHeight*.45,360)&&n.scrollHeight>n.clientHeight})()`), true, "long second-level menus scroll internally instead of burying other people");
      await browser.click(`${b} .conversation-session-toggle`);
      await browser.click('.conversation-search-input input');
      await browser.send("Input.insertText", { text: "验收" });
      await browser.wait(`document.querySelectorAll('.conversation-list-item [data-preview-session-id]').length===1 && document.querySelector('${a} .sidebar-session-preview-row').dataset.titleMode==='full'`);
      await assertTagAlignment();
      await browser.click('.conversation-search-input [aria-label="清空搜索"]');
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
      await browser.wait("document.querySelectorAll('.conversation-row').length===3");
      await browser.click(`${a} [data-preview-session-id="a-design"]`);
      await browser.wait("fixture.opened.includes('a-design')");
      assert.equal(await browser.evaluate(`document.querySelector('${a} .conversation-session-toggle').getAttribute('aria-expanded')`), "false", "small person tag navigates without expanding");
      assert.ok(await browser.evaluate(`document.querySelector('${a} .sidebar-session-preview').getBoundingClientRect().height`)>0);
      await browser.screenshot(join(output, `${mode}-people-tag-navigation.png`));
      await browser.click(`${a} .conversation-session-toggle`);
      await browser.screenshot(join(output, `${mode}-people-expanded.png`));
      await browser.key("Escape");
      // Keep the original parent selection behavior; child navigation does not forge a new DM.
      await browser.click('.conversation-navigation [data-stretch-value="tasks"]');
      await browser.wait("!!document.querySelector('[data-workspace-task-id=ta] .sidebar-session-preview')");
      const ta = '[data-workspace-task-id="ta"]';
      assert.equal(await browser.evaluate(`document.querySelector('${ta} .workspace-task-disclosure').getAttribute('aria-expanded')`), "false", "changing selected session cannot force its task open");
      const taskOpenedBeforeParent = await browser.evaluate("fixture.opened.length");
      await browser.click(`${ta} .workspace-task-main`);
      assert.equal(await browser.evaluate(`document.querySelector('${ta} .workspace-task-disclosure').getAttribute('aria-expanded')`), "false", "task title opens the task and leaves the session disclosure closed");
      assert.equal(await browser.evaluate("fixture.opened.length"), taskOpenedBeforeParent + 1, "task title opens through the workspace runtime");
      await browser.click(`${ta} .workspace-task-disclosure`);
      assert.equal(await browser.evaluate(`document.querySelector('${ta} .workspace-task-disclosure').getAttribute('aria-expanded')`), "true");
      assert.equal(await browser.evaluate(`(()=>{const c=document.querySelector('${ta} .workspace-task-sessions').getBoundingClientRect(),p=document.querySelector('${ta}').getBoundingClientRect();return c.left-p.left<=36})()`), true, "directory-tree child indentation stays compact including the disclosure gutter");
      await browser.click(`${ta} .workspace-task-disclosure`);
      assert.equal(await browser.evaluate(`document.querySelector('${ta} .workspace-task-disclosure').getAttribute('aria-expanded')`), "false", "disclosure toggles exactly once");
      assert.equal(await browser.evaluate(`document.querySelectorAll('${ta} [data-preview-session-id]').length`), 3);
      await assertTagAlignment();
      await browser.click(`${ta} [data-preview-session-id="a-style"]`);
      await browser.wait("fixture.opened.includes('a-style')");
      assert.equal(await browser.evaluate(`document.querySelector('${ta} .workspace-task-disclosure').getAttribute('aria-expanded')`), "false", "task tag stays collapsed after owning-task selection and React effects");
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
      const recentPerson = '.sidebar-recent-groups .im-sidebar-group:has([data-preview-session-id="a-check"])';
      await browser.click(`${recentPerson} [data-preview-session-id="a-check"]`);
      await browser.wait("fixture.opened.includes('a-check')");
      assert.equal(await browser.evaluate(`document.querySelector('${recentPerson} .sidebar-session-area-toggle').getAttribute('aria-expanded')`), "false", "recent person tag also navigates without disclosure");
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.ant-tooltip')].some(n=>getComputedStyle(n).visibility!=='hidden'&&getComputedStyle(n).display!=='none'&&n.getBoundingClientRect().height>0)"), false, "tag navigation dismisses the tooltip before it can intercept the parent click");
      await browser.click(`${recentPerson} .wand-sidebar-group-toggle`);
      await browser.wait("fixture.conversation.getSnapshot().mode==='chats' && fixture.conversation.getSnapshot().selectedId==='dm_employee-a'");
      await browser.click('.conversation-navigation [data-stretch-value="tasks"]');
      await browser.wait("!!document.querySelector('.sidebar-recent-groups .im-sidebar-group .sidebar-session-area-toggle')");
      await browser.click(`${recentPerson} .sidebar-session-area-toggle`);
      assert.equal(await browser.evaluate(`document.querySelector('${recentPerson} .sidebar-session-area-toggle').getAttribute('aria-expanded')`), "true");
      await browser.key("Escape");
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
      await browser.click(`${a} .conversation-person-session:has([data-session-id="a-archived"])`, "right");
      await browser.wait("!!document.querySelector('.workspace-session-menu')");
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.workspace-session-menu [role=menuitem]')].some(n=>n.textContent.includes('恢复会话'))"), true, "archived private sessions offer the same restoration action");
      await browser.key("Escape");
      await browser.key("Escape");
      groups[0].tasks[0].sessions = [];
      await browser.evaluate("fixture.reload().then(()=>true)");
      await browser.wait(`!!document.querySelector('${a} [data-conversation-id]') && !!document.querySelector('${a} .sidebar-session-area[data-empty]') && !document.querySelector('${a} [data-preview-session-id]') && !document.querySelector('${a} .conversation-session-toggle')`);
      assert.ok(await browser.evaluate(`document.querySelector('${a} .sidebar-session-area[data-empty]').getBoundingClientRect().height`) >= (mode === "mobile" ? 44 : 36), "removing the last session keeps the reserved preview band");
      assert.equal(await browser.evaluate(`!!document.querySelector('${a} .conversation-row-open')`), true, "filtering or removing the last session preserves the top conversation entry");
      groups[0].tasks[0].sessions = [...sessionsA, session("a-archived", "旧工作", "employee-a", { archived: true, status: "stopped" })];
      await browser.evaluate("fixture.reload().then(()=>true)");
      await browser.wait(`!!document.querySelector('${a} .sidebar-session-area-toggle')`);
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.sidebar-session-preview')].every(n=>getComputedStyle(n).transitionProperty==='none')"), true);
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
      assert.deepEqual(browser.errors, []);
      results.push(`${mode}: terminal and provider tag alignment with production preflight in full-title and icon modes/person ownership/12 separate same-tool sessions/filter/adaptive titles/expansion/focus/navigation/workspace display scope/tag direct navigation without forced expansion/identity header opens employee chat/header-owned disclosure stays out of the preview band/task title opens without forcing disclosure; disclosure toggles independently/compact child indentation/+N count and maximum fit/no arbitrary hidden selection/recent full list/archive tier/session management menu and owned move submenu/restoration action/empty sessions keep the reserved preview band and recover when sessions return/reduced motion passed`);
      writeFileSync(join(output, "progress.json"), JSON.stringify({ results, mutationCount }, null, 2));
    } catch (error) {
      await browser.screenshot(join(output, `${mode}-failure.png`)).catch(() => {});
      throw error;
    } finally { await browser.close(); }
  }
  assert.equal(mutationCount, 0, "all browser verification stays read-only");
  writeFileSync(join(output, "verification.json"), JSON.stringify({ ok: true, results, mutationCount }, null, 2));
});
