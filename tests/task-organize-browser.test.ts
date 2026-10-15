import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { themeFixtureHtml } from "./helpers/theme-fixture.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("task board and directory menus choose auto/all with stable feedback and popup dismissal", {
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
const task={id:"card",workspaceTaskId:"task",title:"自动标题",titleSource:"auto",identifier:"TASK-1",description:"",status:"doing",priority:"low",labels:[],dueDate:null,milestoneId:null,parentTaskId:null,workspaceId:"w1",createdAt:"2026-10-01",updatedAt:"2026-10-01",sortOrder:0,sessions:[],agent:null};
Object.assign(taskBoardRepository,{list:async()=>[task],workspaces:async()=>[{id:"w1",name:"Project",cwd:"/tmp/project"}],models:async()=>({models:[]}),agentDefaults:async()=>({provider:"pi",model:"default",thinkingEffort:"off",mode:"default",kind:"structured"})});
function App(){const [page,setPage]=React.useState("board");React.useEffect(()=>{window.fixture={show:setPage};taskBoardController.open();},[]);return page==="board"?<TaskBoardHost/>:<div style={{width:280}}><WorkspacesPanel/></div>;}
createRoot(document.getElementById("root")).render(<WandUiProvider><App/></WandUiProvider>);`;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const requests: Array<{ mode: string; target: object }> = [];
  let release: (() => void) | null = null;
  let fail = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local");
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (url.pathname.endsWith(".css")) { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content", url.pathname.slice(1)))); return; }
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/tasks/organize-by-title") {
        let body = ""; req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          requests.push(JSON.parse(body));
          release = () => { res.statusCode = fail ? 503 : 200; res.end(JSON.stringify(fail ? { error: "归类测试失败" } : { ok: true, foundTasks: 1, eligibleTasks: 1, skippedTasks: 0, movedSessions: [], categorizedTasks: [], refused: [] })); };
        }); return;
      }
      const groups = [
        { workspaceId: "w1", workspaceName: "Project", workspaceCwd: "/tmp/project", tasks: [{id:"task",name:"自动标题",workspaceId:"w1",cwd:"/tmp/project",status:"active",createdAt:"2026-10-01",sessions:[]}], standaloneSessions: [] },
        { workspaceId: "cwd:/tmp/synthetic", workspaceName: "Synthetic", workspaceCwd: "/tmp/synthetic", synthetic: true, tasks: [], standaloneSessions: [] },
      ];
      const payload = url.pathname === "/api/tasks" ? { groups } : url.pathname.includes("silicon-employees") ? { employees: [] } : url.pathname.includes("ai-teams") ? [] : {};
      res.end(JSON.stringify(payload)); return;
    }
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end(themeFixtureHtml('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="app"><div id="root"></div></div><div id="wand-react-ui-portals"></div><script src="/app.js"></script></body></html>'));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    for (const width of [1280, 390]) {
      requests.length = 0; release = null; fail = false;
      const browser = await openBrowser(`http://127.0.0.1:${address.port}`, width, 900);
      const button = '.task-board-header-actions [aria-label="任务归类"]';
      const receipt = async () => {
        for (let i = 0; i < 150 && !release; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(release, `organization request received (requests=${requests.length})`);
      };
      const mark = async (text: string) => {
        await browser.wait(`[...document.querySelectorAll('[role="menuitem"]')].some(n=>n.textContent.trim()===${JSON.stringify(text)}&&n.getClientRects().length)`);
        await browser.evaluate(`(()=>{document.querySelectorAll('#click-option').forEach(n=>n.removeAttribute('id'));const n=[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&n.getClientRects().length);n.id="click-option";return true})()`);
      };
      try {
        await browser.wait(`!!document.querySelector('${button}')`);
        const rect = await browser.evaluate(`document.querySelector('${button}').getBoundingClientRect().toJSON()`);
        await browser.click(button); await mark("自动任务归类"); await browser.click("#click-option");
        await browser.wait(`document.querySelector('${button}').getAttribute('aria-busy')==='true'`);
        await receipt();
        assert.deepEqual(requests[0], { target: { kind: "all" }, mode: "auto" });
        assert.equal(await browser.evaluate(`document.querySelector('${button}').getBoundingClientRect().width`), rect.width);
        release(); release = null;
        await browser.wait(`document.querySelector('${button}').textContent.includes('查看结果')`);
        const after = await browser.evaluate(`document.querySelector('${button}').getBoundingClientRect().toJSON()`);
        assert.equal(after.x, rect.x); assert.equal(after.width, rect.width);
        await browser.click(button); await mark("所有任务归类"); await browser.key("Escape");
        assert.equal(await browser.evaluate(`document.querySelector('${button}').getAttribute('aria-expanded')`), "false");
        await browser.click(button); await mark("所有任务归类"); await browser.click("#click-option");
        await receipt();
        assert.equal(requests[1].mode, "all"); fail = true; release(); release = null;
        await browser.wait(`document.querySelector('${button}').textContent.includes('归类失败')`);
        assert.match(await browser.evaluate(`document.querySelector('${button}').title`), /归类测试失败/);
        fail = false;
        await browser.evaluate('fixture.show("sidebar");true');
        const row = '[data-sidebar-tree-directory-id="w1"] .workspace-row';
        await browser.wait(`!!document.querySelector('${row}')`);
        await browser.click(row, "right"); await mark("任务归类"); await browser.click("#click-option");
        await mark("所有任务归类"); await browser.click("#click-option");
        await receipt();
        assert.deepEqual(requests[2], { target: { kind: "workspace", workspaceId: "w1" }, mode: "all" });
        release(); release = null;
        await browser.wait(`!!document.querySelector('.sidebar-menu-submenus [role="status"]')`);
        await browser.key("Escape"); await browser.key("Escape");
        const synthetic = '[data-sidebar-tree-directory-id="cwd:/tmp/synthetic"] .workspace-row';
        await browser.click(synthetic, "right"); await mark("任务归类"); await browser.click("#click-option");
        await mark("自动任务归类"); await browser.click("#click-option");
        await receipt();
        assert.deepEqual(requests[3], { target: { kind: "directory", cwd: "/tmp/synthetic" }, mode: "auto" });
        release(); release = null;
        await browser.key("Escape"); await browser.key("Escape");
        assert.deepEqual(browser.errors, []);
      } finally { release?.(); release = null; await browser.close(); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(temp, { recursive: true, force: true }); }
});
