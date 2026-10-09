import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";

// Production form, picker, HTTP adapters and task store; fixture endpoints never execute a model.
test("new session task creation, existing selection, prefill and retry in browser", { skip: process.env.WAND_NEW_SESSION_TASK_BROWSER !== "1", timeout: 180_000 }, async () => {
  const { openBrowser } = await import("./helpers/sidebar-ux-browser.mjs");
  const source = `import*as React from'react';import{createRoot}from'react-dom/client';
import{WandUiProvider}from'./src/web-ui/react/theme';import{installReactUiStyles}from'./src/web-ui/react/styles';
import{NewSessionHost}from'./src/web-ui/react/new-session/host';import{newSessionController,configureNewSessionRuntime}from'./src/web-ui/react/new-session/controller';
installReactUiStyles();configureNewSessionRuntime({onOpen(){},onClose(){},getContext:()=>({effectiveCwd:'/project'}),rememberModel(){},prepareCreate:async()=>({}),completeCreate:async(r,s)=>{window.receipt={r,s}}});
window.openForm=options=>newSessionController.open(options);createRoot(document.getElementById('root')).render(<WandUiProvider><NewSessionHost/></WandUiProvider>);`;
  const built = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const tasks = [{ id: "task-existing", name: "已有任务", workspaceId: "project", cwd: "/project/tree", worktree: { path: "/project/tree" }, sessions: [], archived: false }];
  let taskCreates = 0, sessionCreates = 0, failSession = true, failTask = false;
  const writes: Array<{ path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
    if (path === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
    if (!path.startsWith("/api/")) { res.setHeader("content-type", "text/html;charset=utf-8"); res.end('<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'); return; }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text || "{}"); writes.push({ path, body });
      if (path.endsWith("/tasks")) {
        if (failTask) { res.statusCode = 400; res.end(JSON.stringify({ error: "任务创建被拒绝" })); return; }
        taskCreates++; const task = { ...tasks[0], id: "task-created-" + taskCreates, name: body.name, cwd: body.cwd, worktree: null }; tasks.push(task as any); res.end(JSON.stringify(task)); return;
      }
      if (path === "/api/commands") { sessionCreates++; if (failSession) { res.statusCode = 400; res.end(JSON.stringify({ error: "会话启动被拒绝" })); } else res.end(JSON.stringify({ id: "session-created" })); return; }
      res.end('{}'); return;
    }
    const data = path === "/api/tasks" ? [{ workspaceId: "project", workspaceName: "测试项目", workspaceCwd: "/project", tasks, standaloneSessions: [] }]
      : path === "/api/config" ? { defaultProvider: "claude", defaultSessionKind: "structured", defaultMode: "default", defaultCwd: "/project" }
      : path === "/api/workspaces" ? [{ id: "project", name: "测试项目", cwd: "/project" }]
      : path.includes("silicon-employees") ? { employees: [] }
      : path.includes("provider-usage") ? {} : [];
    res.end(JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  mkdirSync("output/task-session-20261009", { recursive: true });
  try {
    for (const width of [1280, 390]) {
      tasks.splice(1); taskCreates = 0; sessionCreates = 0; failSession = true; failTask = false; writes.length = 0;
      const b = await openBrowser(origin, width, 900);
      const select = async (text: string) => {
        await b.click('[aria-label="所属任务"]'); await b.wait('!!document.querySelector(".wand-ui-select-content input")');
        await b.click('.wand-ui-select-content input'); await b.send("Input.insertText", { text });
        await b.click('.wand-ui-select-content [role="option"]');
        assert.ok(await b.evaluate('!!document.querySelector("[data-testid=new-session-dialog]")'), "portal choice retains parent");
      };
      try {
        await b.wait('!!window.openForm');
        await b.evaluate("openForm({initialCwd:'/project',workspaceId:'project'})");
        await b.wait('!!document.querySelector(".wand-new-session-summary")');
        assert.ok(await b.evaluate("document.querySelector('.wand-new-session-summary').innerText.includes('模型')"));
        assert.ok(await b.evaluate("!!document.querySelector('[aria-label=执行模式]')"), "permissions remain visible without expanding details");
        assert.equal(await b.evaluate("document.querySelectorAll('.wand-new-session-subject-collapse input[type=radio]').length"), 0, "long execution list is initially collapsed");
        await b.click('.wand-new-session-subject-collapse .ant-collapse-header');
        await b.wait('!!document.querySelector("[aria-label=搜索执行对象]")');
        await b.click('[aria-label=搜索执行对象]'); await b.send("Input.insertText", { text: "没有这个对象" });
        await b.wait("document.body.innerText.includes('没有匹配的执行对象')");
        assert.equal(await b.evaluate("document.querySelector('.wand-new-session-summary').innerText.includes('Claude')"), true, "search does not change the selected execution object");
        await b.key("Escape");
        assert.equal(await b.evaluate("document.querySelector('[aria-label=搜索执行对象]').value"), "");
        assert.equal(await b.evaluate("document.activeElement.getAttribute('aria-label')"), "搜索执行对象");
        await b.send("Input.insertText", { text: "codex" });
        await b.wait(`!!document.querySelector('label:has(input[value="cli:codex"])')`);
        await b.click('label:has(input[value="cli:codex"])');
        await b.wait("document.querySelector('.wand-new-session-summary').innerText.includes('full access')");
        assert.ok(await b.evaluate("document.querySelector('.wand-new-session-summary').innerText.includes('关闭 Codex 的沙盒限制')"));
        assert.equal(sessionCreates, 0, "changing execution choices never starts an AI session");
        await b.screenshot(`output/task-session-20261009/refined-${width}-permission.png`);
        await b.click('[aria-label="关闭新建会话"]');
        await b.wait('!document.querySelector("[data-testid=new-session-dialog]")');
        await b.evaluate("openForm({initialKind:'shell',initialCwd:'/project',workspaceId:'project'})");
        await b.wait('!!document.querySelector("[aria-label=所属任务]")');
        await select("新建任务"); await b.wait('!!document.querySelector("#wand-new-session-task-name")');
        await b.click('.wand-new-session-submit'); await b.wait("document.body.innerText.includes('请输入任务名称')");
        assert.equal(taskCreates + sessionCreates, 0);
        await b.click('#wand-new-session-task-name'); await b.send("Input.insertText", { text: "新增任务" });
        await b.screenshot(`output/task-session-20261009/source-${width}-new.png`);
        failTask = true; await b.click('.wand-new-session-submit'); await b.wait("document.body.innerText.includes('任务创建被拒绝')");
        assert.equal(sessionCreates, 0); assert.equal(await b.evaluate("document.querySelector('#wand-new-session-task-name').value"), "新增任务");
        failTask = false; await b.click('.wand-new-session-submit'); await b.wait("document.body.innerText.includes('会话启动被拒绝')");
        assert.equal(taskCreates, 1); assert.equal(sessionCreates, 1);
        assert.equal(writes.find(x => x.path === "/api/commands")!.body.workspaceTaskId, "task-created-1");
        failSession = false; await b.click('.wand-new-session-submit'); await b.wait('!!window.receipt');
        assert.equal(taskCreates, 1); assert.equal(sessionCreates, 2);
        await b.wait('!document.querySelector("[data-testid=new-session-dialog]")');
        await b.evaluate("openForm({initialKind:'shell',initialCwd:'/project',workspaceId:'project'})");await b.wait('!!document.querySelector("[aria-label=所属任务]")');
        await select("已有任务");
        assert.equal(await b.evaluate("document.querySelector('#wand-new-session-cwd').value"), "/project/tree");
        assert.ok(await b.evaluate("document.querySelector('#wand-new-session-cwd').disabled"));
        await b.screenshot(`output/task-session-20261009/source-${width}-existing.png`);
        await b.click('[aria-label="所属任务"]'); await b.wait('!!document.querySelector(".wand-ui-select-content input")');await b.key("Escape");
        assert.ok(await b.evaluate('!!document.querySelector("[data-testid=new-session-dialog]")'));; await b.key("Escape");
        await b.wait('!document.querySelector("[data-testid=new-session-dialog]")');
        await b.evaluate("openForm({initialKind:'shell',initialCwd:'/project/tree',workspaceId:'project',workspaceTaskId:'task-existing',taskName:'已有任务'})");
        await b.wait('!!document.querySelector("#wand-new-session-cwd")');
        assert.equal(await b.evaluate("document.querySelector('[aria-label=所属任务]').innerText.includes('已有任务')"), true);
        await b.click('.wand-new-session-submit');await b.wait('!document.querySelector("[data-testid=new-session-dialog]")');
        assert.equal(writes.filter(x=>x.path==='/api/commands').at(-1)!.body.workspaceTaskId,'task-existing');
        assert.equal(taskCreates,1);assert.deepEqual(b.errors,[]);
      } catch (error) { console.error(await b.evaluate("document.body.innerText"), b.errors); await b.screenshot(`output/task-session-20261009/browser-failure-${width}.png`); throw error; } finally { await b.close(); }
    }
  } finally { server.close(); }
});
