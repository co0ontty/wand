import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { themeFixtureHtml } from "./helpers/theme-fixture.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("conversation organization previews content, confirms background creation, preserves controls and directory scopes", {
  skip: process.env.WAND_TASK_ORGANIZE_BROWSER !== "1", timeout: 240_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-organize-browser-"));
  const source = `import * as React from "react";
import { createRoot } from "react-dom/client";
import { WandUiProvider } from "./src/web-ui/react/theme";
import { installReactUiStyles } from "./src/web-ui/react/styles";
import { TaskBoardHost } from "./src/web-ui/react/issues/task-board-host";
import { taskBoardController } from "./src/web-ui/react/issues/task-board-controller";
import { taskBoardRepository } from "./src/web-ui/react/issues/task-board-repository";
import { WorkspacesPanel } from "./src/web-ui/react/workspaces/workspaces-panel";
import { configureWorkspacesRuntime } from "./src/web-ui/react/workspaces/controller";
installReactUiStyles();
configureWorkspacesRuntime({selectSession(){},openTask(){},openWorkspace(){},closeWorkspace(){},refreshSessions:async()=>{},toast(){},onOpen(){},onClose(){}});
Object.assign(taskBoardRepository,{list:async()=>{const response=await fetch('/api/wand-tasks');return response.json();},workspaces:async()=>[{id:"w1",name:"Project",cwd:"/tmp/project"}],models:async()=>({models:[]}),agentDefaults:async()=>({provider:"pi",model:"default",thinkingEffort:"off",mode:"default",kind:"structured"})});
function App(){const [page,setPage]=React.useState("board");React.useEffect(()=>{window.fixture={show:setPage};taskBoardController.open();},[]);return page==="board"?<TaskBoardHost/>:<div style={{width:280}}><WorkspacesPanel/></div>;}
createRoot(document.getElementById("root")).render(<WandUiProvider><App/></WandUiProvider>);`;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const requests: Array<Record<string, any>> = [];
  let previewCount = 2, failPreview = false, complete = false, created = false, cancelled = false, jobNumber = 0, completedPolls = 0;
  let currentJob: any;
  const result = () => ({ ok: true, eligibleSessions: previewCount, analyzedSessions: complete ? previewCount : 0, skippedManualSessions: 1, skippedSessions: 0,
    createdTasks: complete && !cancelled ? [{ taskId: "new-task", cardId: "new-card", title: "修复通知保存", sessionCount: 2 }] : [], reusedTasks: [], updatedTasks: [],
    movedSessions: complete && !cancelled ? [{ sessionId: "work-1" }, { sessionId: "work-2" }] : [], refused: [], unassignedSessions: [], cancelled });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local");
    const json = (payload: unknown, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json");res.end(JSON.stringify(payload)); };
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript");res.end(readFileSync(join(temp, "app.js")));return; }
    if (url.pathname.endsWith(".css")) { res.setHeader("content-type", "text/css");res.end(readFileSync(join(root, "src/web-ui/content", url.pathname.slice(1))));return; }
    if (url.pathname === "/api/sessions/auto-organize" && req.method === "POST") {
      let body = "";req.on("data", chunk => { body += chunk; });req.on("end", () => {
        const parsed = JSON.parse(body);requests.push(parsed);
        if (parsed.action === "preview") {
          if (failPreview) { json({ error: "正文预览测试失败" }, 503);return; }
          json({ kind: "preview", preview: { token: "confirmation-" + requests.length, sessionCount: previewCount, manualSessionCount: previewCount ? 1 : 3, skippedSessionCount: 0, existingTaskCount: 0, contentCharacters: 1500, estimatedModelRequests: 1, unchanged: false } });return;
        }
        complete = false;cancelled = false;jobNumber++;
        currentJob = { id: "job-" + jobNumber, status: "running", stage: "正在按真实正文生成分组", totalSessions: previewCount, processedSessions: 0, modelRequests: 1, logSessionId: "audit-" + jobNumber, result: result() };
        json({ kind: "job", job: currentJob }, 202);
      });return;
    }
    if (url.pathname.startsWith("/api/sessions/auto-organize/")) {
      if (url.pathname.endsWith("/cancel")) { cancelled = true;complete = true; }
      const job = { ...currentJob, status: complete ? cancelled ? "cancelled" : "completed" : "running", processedSessions: complete ? previewCount : 0, stage: complete ? "已处理完成" : "正在按真实正文生成分组", result: result() };
      if (complete && !cancelled) { created = true;completedPolls++; }
      json({ kind: "job", job });return;
    }
    if (url.pathname.startsWith("/api/")) {
      const groups = [
        { workspaceId: "w1", workspaceName: "Project", workspaceCwd: "/tmp/project", tasks: [], standaloneSessions: [{ id: "work-1", provider: "pi", title: "待归属工作", status: "idle", sessionKind: "structured", cwd: "/tmp/project", startedAt: "2026-10-01" }] },
        { workspaceId: "cwd:/tmp/synthetic", workspaceName: "Synthetic", workspaceCwd: "/tmp/synthetic", synthetic: true, tasks: [], standaloneSessions: [] },
        { workspaceId: "wand-global", workspaceName: "全局", workspaceCwd: "/tmp/global", global: true, tasks: [{ id: "global-task", name: "全局工作", workspaceId: "wand-global", cwd: "/tmp/global", status: "active", createdAt: "2026-10-01", sessions: [] }], standaloneSessions: [] },
      ];
      const card = { id: "new-card", workspaceTaskId: "new-task", title: "修复通知保存", titleSource: "auto", identifier: "TASK-1", description: "由正文归类自动创建", status: "doing", priority: "low", labels: [], dueDate: null, milestoneId: null, parentTaskId: null, workspaceId: "w1", createdAt: "2026-10-01", updatedAt: "2026-10-01", sortOrder: 0, sessions: [], agent: null };
      json(url.pathname === "/api/wand-tasks" ? created ? [card] : [] : url.pathname === "/api/tasks" ? { groups } : url.pathname.includes("silicon-employees") ? { employees: [] } : url.pathname.includes("ai-teams") ? [] : {});return;
    }
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end(themeFixtureHtml('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="app"><div id="root"></div></div><div id="wand-react-ui-portals"></div><script src="/app.js"></script></body></html>'));
  });
  server.listen(0, "127.0.0.1");await once(server, "listening");const address = server.address();assert.ok(address && typeof address === "object");
  try {
    for (const width of [1280, 390]) {
      requests.length = 0;previewCount = 2;failPreview = false;complete = false;created = false;cancelled = false;
      const browser = await openBrowser(`http://127.0.0.1:${address.port}`, width, 900);
      const button = '.task-board-header-actions [aria-label="会话自动归类"]';
      const status = `document.querySelector('.wand-ui-dropdown-content [role="status"]')?.textContent`;
      const mark = async (text: string) => {
        await browser.wait(`(()=>{const n=[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&n.getClientRects().length);if(!n)return false;document.querySelectorAll('#click-option').forEach(n=>n.removeAttribute('id'));n.id="click-option";return true})()`);
      };
      const choose = async (text: string) => {
        await mark(text);await browser.settle();
        const point = await browser.evaluate(`(()=>{const n=document.querySelector('#click-option');if(!n)return null;const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,reachable:!!hit&&n.contains(hit),hit:hit?.textContent?.slice(0,200)}})()`);
        assert.ok(point?.reachable, `menu item must be visibly pointer-accessible: ${text}; ${JSON.stringify(point)}`);
        // An actual pointer click does not programmatically scroll the context-menu host.
        await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await browser.settle();
      };
      try {
        await browser.wait(`!!document.querySelector('${button}')`);
        const rect = await browser.evaluate(`document.querySelector('${button}').getBoundingClientRect().toJSON()`);
        await browser.click(button);await mark("默认范围会话");
        await browser.wait(`[...document.querySelectorAll('[role="menuitem"]')].some(n=>n.textContent.trim()==="所有工作会话")`);
        await browser.click("#click-option");await mark("确认整理 2 个会话");
        assert.equal(requests.length, 1, "opening a scope only previews; zero model starts before confirmation");
        assert.deepEqual(requests[0], { action: "preview", target: { kind: "all" }, mode: "auto" });
        assert.match(await browser.evaluate(status), /正文 1500 字符.*预计 1 个系统模型请求/);
        await browser.key("Escape");await browser.click(button);
        assert.equal(requests.length, 1, "reopening a preview cannot submit it");
        await choose("确认整理 2 个会话");
        await browser.wait(`document.querySelector('${button}').getAttribute('aria-busy')==='true'`);
        await mark("取消后续归类（保留已完成部分）");
        const starts = requests.filter(r => r.action === "start").length;
        await browser.click(button);await browser.click(button);assert.equal(requests.filter(r => r.action === "start").length, starts);
        complete = true;
        await browser.wait(`${status}?.includes('新建 1 个任务')`);
        await browser.wait(`!!document.querySelector('[data-task-id="new-card"]')`);
        assert.match(await browser.evaluate(status), /归入 2 个会话/);
        await mark("查看初二的本次归类日志");
        const after = await browser.evaluate(`document.querySelector('${button}').getBoundingClientRect().toJSON()`);
        assert.equal(after.x, rect.x);assert.equal(after.width, rect.width);
        failPreview = true;await choose("所有工作会话");
        await browser.wait(`${status}?.includes('正文预览测试失败')`);
        assert.equal(requests.at(-1)?.mode, "all");assert.equal(requests.filter(r => r.action === "start").length, starts);
        failPreview = false;await choose("所有工作会话");await choose("确认整理 2 个会话");
        await mark("取消后续归类（保留已完成部分）");await browser.click("#click-option");
        await browser.wait(`${status}?.includes('已取消后续会话归类')`);
        await browser.key("Escape");await browser.evaluate('fixture.show("sidebar");true');
        const directory = async (id: string, mode: string, expected: object) => {
          const row = `[data-sidebar-tree-directory-id="${id}"] .workspace-row`;
          await browser.wait(`!!document.querySelector('${row}')`);await browser.click(row, "right");
          await choose("会话自动归类");await choose(mode);
          await browser.wait(`!!document.querySelector('.sidebar-menu-submenus [role="status"]')`);
          assert.deepEqual(requests.at(-1), { action: "preview", ...expected });
        };
        previewCount = 2;await directory("w1", "所有工作会话", { target: { kind: "workspace", workspaceId: "w1" }, mode: "all" });
        await choose("确认整理 2 个会话");await mark("取消后续归类（保留已完成部分）");
        const previousStarts = requests.filter(r => r.action === "start").length, beforePolls = completedPolls;
        // Native context menus intentionally close when their scroll host moves.
        // Long-running work must survive that closure, and reopening must show its result, not start again.
        await browser.evaluate("window.dispatchEvent(new Event('scroll'));true");
        await browser.wait(`document.querySelector('[data-sidebar-tree-directory-id="w1"] .workspace-row').getAttribute('aria-expanded')==='false'`);
        complete = true;
        for (let n = 0; n < 150 && completedPolls === beforePolls; n++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(completedPolls > beforePolls, "the same background job continues polling after its menu closes");
        await browser.click('[data-sidebar-tree-directory-id="w1"] .workspace-row', "right");
        await browser.wait(`[...document.querySelectorAll('[role="menuitem"]')].some(n=>n.getClientRects().length&&['已完成','会话归类结果'].includes(n.textContent.trim()))`);
        const resultLabel = await browser.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.getClientRects().length&&['已完成','会话归类结果'].includes(n.textContent.trim())).textContent.trim()`);
        await choose(resultLabel);
        await browser.wait(`document.querySelector('.sidebar-menu-submenus [role="status"]')?.textContent.includes('新建 1 个任务')`);
        assert.equal(requests.filter(r => r.action === "start").length, previousStarts, "reopening a completed job result cannot resubmit a model request");
        await browser.key("Escape");await browser.key("Escape");
        previewCount = 0;await directory("cwd:/tmp/synthetic", "默认范围会话", { target: { kind: "directory", cwd: "/tmp/synthetic" }, mode: "auto" });
        await browser.wait(`document.querySelector('.sidebar-menu-submenus [role="status"]')?.textContent.includes('没有符合范围且有正文')`);
        assert.match(await browser.evaluate(`document.querySelector('.sidebar-menu-submenus [role="status"]').textContent`), /跳过 3 个人工任务/);
        await browser.key("Escape");await browser.key("Escape");
        previewCount = 2;await directory("wand-global", "所有工作会话", { target: { kind: "directory", cwd: "/tmp/global" }, mode: "all" });
        await browser.key("Escape");await browser.key("Escape");
        assert.deepEqual(browser.errors, []);
      } catch (error) {
        const dom = await browser.evaluate(`({text:document.body.innerText.slice(0,10000),menus:[...document.querySelectorAll('[role="menuitem"]')].map(n=>({text:n.textContent,shown:!!n.getClientRects().length})),errors:[]})`);
        writeFileSync(join(root, "output/architecture-stage2/conversation-auto-organize/browser-failure.json"), JSON.stringify({ width, requests, dom, errors: browser.errors }, null, 2));
        throw error;
      } finally { complete = true;await browser.close(); }
    }
  } finally { server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(temp, { recursive: true, force: true }); }
});
