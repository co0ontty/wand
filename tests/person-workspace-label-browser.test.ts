import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

// Read-only fixtures with the real person sidebar, session index and UI components.
test("person sessions keep header disclosure compact and show workspace status without an arrow column", {
  skip: process.env.WAND_PERSON_WORKSPACE_BROWSER !== "1", timeout: 180_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-person-workspace-"));
  const output = join(root, process.env.WAND_PERSON_WORKSPACE_OUTPUT ?? "output/person-workspace-label/browser-focused");
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
import {conversationUi} from "./src/web-ui/react/conversations/state";
installReactUiStyles();
localStorage.setItem("wand.sidebar.displayMode", "folded");
const snapshot={auth:{phase:"authenticated"},viewport:{mobile:innerWidth<640,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},
layout:{sessionsDrawerOpen:true,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:innerWidth<640,sidebarAnchored:innerWidth>=640,sessionsBackdropVisible:false,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:"chat"},selected:null,
sidebar:{groups:[],interactiveCount:0,totalCount:0,manageMode:false,selectedCount:0},topbar:{title:"",description:"",statusLabel:"",statusTone:"idle",cwd:"",currentTask:"",titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:false,blank:true,composer:false}};
const memory=new MemoryUiAdapter(snapshot);
configureWorkspacesRuntime({selectSession(){},openTask(){},openWorkspace(){},closeWorkspace(){},refreshSessions:async()=>{},toast(){},onOpen(){},onClose(){}});
conversationUi.mode("chats");
createRoot(document.getElementById("root")).render(<WandUiProvider><UiStoreProvider store={memory}><ShellSidebar/></UiStoreProvider></WandUiProvider>);
` }, bundle: true, platform: "browser", format: "iife", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
  const cases = [
    { id: "wand", name: "wand", cwd: "/Users/me/projects/wand", expected: "wand" },
    { id: "alias", name: "产品工作区", cwd: "/repo/project", expected: "产品工作区" },
    { id: "path", name: "/Users/me/projects/other-project/", cwd: "/repo/other", expected: "other-project" },
    { id: "fallback", name: "", cwd: "/repo/fallback/", expected: "fallback" },
    { id: "long", name: "很长的工作区名称".repeat(15), cwd: "/repo/long", expected: "很长的工作区名称".repeat(15) },
    { id: "wand-global", name: "未归属工作区", cwd: "/scratch", expected: "", global: true },
  ];
  const groups = cases.map(item => {
    const session = { id: item.id, title: "同一人物下跨工作区的长任务标题".repeat(5), employeeId: "e", employeeName: "测试员工",
      sessionKind: "structured", provider: "pi", status: "running", inFlight: true, cwd: item.cwd, startedAt: "2026-10-28T00:00:00Z" };
    return { workspaceId: item.id, workspaceName: item.name, workspaceCwd: item.cwd, global: item.global,
      tasks: item.id === "wand" ? [{ id: "task-wand", workspaceId: item.id, name: "主任务", cwd: item.cwd, status: "active", createdAt: "", worktree: null, sessions: [session] }] : [],
      standaloneSessions: item.id === "wand" ? [] : [session] };
  });
  let mutations = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path.startsWith("/api/")) {
      if (req.method !== "GET") mutations++;
      const payload = path === "/api/tasks" ? { groups, revision: "fixture" }
        : path === "/api/sessions" ? []
        : path === "/api/conversations" ? { conversations: [{ id: "dm", kind: "dm", owner: "local-owner", peerEmployeeId: "e", title: "测试员工", name: "", nameSource: "auto", tasks: [], preview: "", messageAt: "", createdAt: "", updatedAt: "", communicationSessionId: null, sessionId: null, memberUnavailableReasons: {}, unavailableReason: null }] }
        : path === "/api/silicon-employees" ? { employees: [{ id: "e", name: "测试员工", avatar: "cat:2" }] }
        : path === "/api/config" ? { userProfile: { name: "测试用户" } }
        : path === "/api/attention" ? { items: [] }
        : path === "/api/ai-team-runs" ? { runs: [] }
        : path === "/api/ai-teams" ? [] : {};
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(payload)); return;
    }
    if (path === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (path === "/tailwind.css" || path === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content", path.slice(1)))); return; }
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="height:100dvh;display:flex"></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const verified: string[] = [];
  for (const mode of ["desktop", "mobile", "native", "rollback"]) {
    const browser = await openBrowser(`http://127.0.0.1:${address.port}/${mode === "rollback" ? "?reactUi=0" : ""}`, mode === "mobile" ? 390 : 1440, 1000);
    try {
      if (mode === "native") await browser.evaluate("document.documentElement.classList.add('is-wand-app');true");
      await browser.wait("!!document.querySelector('.conversation-session-toggle')");
      await browser.settle();
      assert.equal(await browser.evaluate("!!document.querySelector('.conversation-row .conversation-session-toggle')"), true,
        "the disclosure belongs to the identity header, not a column beside the expanded list");
      const triggerBounds = () => browser.evaluate("document.querySelector('.conversation-session-toggle').getBoundingClientRect().toJSON()");
      const closedBounds = await triggerBounds();
      const headerActions = await browser.evaluate(`(()=>{
        const toggle=document.querySelector('.conversation-session-toggle').getBoundingClientRect(),
          menu=document.querySelector('.conversation-row-more').getBoundingClientRect(),
          name=document.querySelector('.conversation-row-open').getBoundingClientRect(),
          header=document.querySelector('.conversation-row').getBoundingClientRect();
        return {separate:toggle.right<=menu.left && name.right<=toggle.left,inside:toggle.top>=header.top && toggle.bottom<=header.bottom,
          width:toggle.width,height:toggle.height,menuWidth:menu.width,nameWidth:name.width};
      })()`);
      assert.ok(headerActions.separate && headerActions.inside); assert.ok(headerActions.nameWidth >= 60);
      if (mode === "mobile") assert.ok(headerActions.width >= 44 && headerActions.height >= 44 && headerActions.menuWidth >= 44);
      await browser.click(".conversation-session-toggle");
      const openedBounds = await triggerBounds();
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(openedBounds[key] - closedBounds[key]) <= 1, `opening preserves trigger ${key}: ${JSON.stringify({ mode, closedBounds, openedBounds })}`);
      await browser.wait("document.querySelectorAll('.conversation-person-sessions [data-session-id]').length === 6");
      const rows = await browser.evaluate(`Array.from(document.querySelectorAll('.conversation-person-sessions [data-session-id]')).map(row=>{
        const title=row.querySelector('.im-sidebar-item-name'),meta=row.querySelector('.im-sidebar-item-summary');
        return {id:row.dataset.sessionId,text:meta.textContent,full:meta.title,secondLine:meta.getBoundingClientRect().top>=title.getBoundingClientRect().bottom-1,
          overflow:row.scrollWidth>row.clientWidth+1,ellipsis:getComputedStyle(meta).textOverflow};
      })`);
      for (const item of cases) {
        const row = rows.find((candidate: { id: string }) => candidate.id === item.id); assert.ok(row);
        assert.ok(row.text.startsWith(item.expected ? `运行中 · ${item.expected} · ` : "运行中 · Pi"), row.text);
        assert.equal(row.full, row.text); assert.ok(row.secondLine); assert.equal(row.overflow, false); assert.equal(row.ellipsis, "ellipsis");
        assert.ok(!row.text.includes("/Users/") && !row.text.includes("/repo/") && !row.text.includes("未归属工作区"));
      }
      const listLayout = await browser.evaluate(`(()=>{const parent=document.querySelector('.conversation-list-item').getBoundingClientRect(),
        list=document.querySelector('.conversation-person-sessions').getBoundingClientRect(),head=document.querySelector('.conversation-row').getBoundingClientRect();
        return {indent:list.left-parent.left,widthLoss:parent.width-list.width,topGap:list.top-head.bottom,
          noArrowColumn:!document.querySelector('.sidebar-session-area .sidebar-session-area-toggle')};})()`);
      assert.ok(listLayout.indent <= 16 && listLayout.widthLoss <= 16, "the whole expanded list keeps only a light indent, not a 24/36px arrow column");
      assert.ok(listLayout.topGap <= 4 && listLayout.noArrowColumn, "no standalone arrow row consumes vertical space");
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
      await browser.screenshot(join(output, `${mode}.png`));
      await browser.evaluate("document.querySelector('.conversation-person-sessions button').focus({preventScroll:true});true");
      const visibleTooltip = "[...document.querySelectorAll('.ant-tooltip')].some(n=>getComputedStyle(n).visibility!=='hidden' && getComputedStyle(n).display!=='none' && n.getBoundingClientRect().height>0)";
      await browser.wait(visibleTooltip, "long-name focus opens its owned tooltip");
      await browser.key("Escape");
      await browser.wait(`!(${visibleTooltip})`);
      assert.equal(await browser.evaluate("document.querySelector('.conversation-session-toggle').getAttribute('aria-expanded')"), "true", "first Escape closes the owned name tooltip, not its parent list");
      await browser.key("Escape");
      assert.equal(await browser.evaluate("document.querySelector('.conversation-session-toggle').getAttribute('aria-expanded')"), "false");
      assert.equal(await browser.evaluate("document.activeElement.matches('.conversation-session-toggle')"), true, "closing from a child returns focus to the same header control");
      await browser.key("ArrowRight");
      assert.equal(await browser.evaluate("document.querySelector('.conversation-session-toggle').getAttribute('aria-expanded')"), "true");
      await browser.key("ArrowLeft");
      assert.equal(await browser.evaluate("document.querySelector('.conversation-session-toggle').getAttribute('aria-expanded')"), "false");
      const restoredBounds = await triggerBounds();
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(restoredBounds[key] - closedBounds[key]) <= 1, `closing preserves trigger ${key}`);
      await browser.click('.conversation-row-more');
      await browser.wait("!!document.querySelector('[role=menu]')");
      await browser.key("Escape");
      await browser.wait("!document.querySelector('[role=menu]')");
      await browser.click('.conversation-navigation [data-stretch-value="tasks"]');
      await browser.wait("!!document.querySelector('.sidebar-view-switch')");
      await browser.click('.sidebar-view-switch [data-stretch-value="recent"]');
      await browser.wait("!!document.querySelector('.im-sidebar-group-header .sidebar-session-area-toggle')");
      await browser.click('.im-sidebar-group-header .sidebar-session-area-toggle');
      await browser.wait("document.querySelectorAll('.im-sidebar-group-inner [data-session-id]').length===6");
      assert.equal(await browser.evaluate("!document.querySelector('.im-sidebar-group .sidebar-session-area .sidebar-session-area-toggle')"), true);
      assert.equal(await browser.evaluate("(()=>{const a=document.querySelector('.im-sidebar-group').getBoundingClientRect(),b=document.querySelector('.im-sidebar-group-inner').getBoundingClientRect();return b.left-a.left<=16 && a.width-b.width<=16})()"), true, "recent-person projection reuses the full-width child layout");
      await browser.screenshot(join(output, `${mode}-recent.png`));
      await browser.key("Escape");
      if (mode === "rollback") {
        await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        assert.ok(await browser.evaluate("parseFloat(getComputedStyle(document.querySelector('.sidebar-disclosure-chevron')).transitionDuration) <= 0.00001"),
          "reduced motion retains only the shared theme's instantaneous lifecycle duration");
      }
      verified.push(mode);
    } catch (error) {
      await browser.screenshot(join(output, `${mode}-failure.png`));
      throw error;
    } finally { await browser.close(); }
  }
  assert.equal(mutations, 0);
  writeFileSync(join(output, "result.json"), JSON.stringify({ verified, cases: cases.length, mutations }, null, 2));
});
