import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("board task creation shares the work page, retains drafts and guards accepted requests", {
  skip: process.env.WAND_TASK_CREATION_BROWSER !== "1", timeout: 240_000,
}, async t => {
  const source = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme';import {installReactUiStyles} from './src/web-ui/react/styles';
    import {NewSessionHost} from './src/web-ui/react/new-session/host';
    import {newSessionController,newSessionStore,configureNewSessionRuntime} from './src/web-ui/react/new-session/controller';
    import {TaskBoardHost} from './src/web-ui/react/issues/task-board-host';
    import {taskBoardController} from './src/web-ui/react/issues/task-board-controller';
    import {ComposerStore} from './src/web-ui/browser/composer';import {configureTeamChatComposerRuntime} from './src/web-ui/react/ai-teams/composer-bridge';
    import {PortalContainerProvider} from './src/web-ui/react/ui/portal-context';
    import {overlayStore} from './src/web-ui/react/overlay-controller';import {WandDialog} from './src/web-ui/react/ui/dialog';
    const store=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>store.read(id),edit:(id,c)=>store.edit(id,c),subscribe:f=>store.subscribe(f),submit:(id,text,f)=>store.submit(id,text,f),transfer:(a,b,r)=>store.transfer(a,b,r)});
    configureNewSessionRuntime({onOpen(){},onClose(){},getContext:()=>({effectiveCwd:'/project'}),prepareCreate:async()=>({}),completeCreate:async()=>{throw Error('No execution expected')},rememberModel(){}});
    installReactUiStyles();window.fixture={open:newSessionController.open,close:()=>newSessionController.close(),store,state:newSessionStore.getSnapshot};
    function Fixture(){const creation=React.useSyncExternalStore(newSessionStore.subscribe,newSessionStore.getSnapshot);
      const dialog=React.useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot).activeDialog;
      return <><div hidden={creation.open}><TaskBoardHost/></div><NewSessionHost/>{dialog?<WandDialog open title={dialog.options.title} description={dialog.options.description} actions={dialog.options.actions}
        onAction={action=>overlayStore.completeDialog(dialog.id,{dismissed:false,action})} onDismiss={()=>overlayStore.completeDialog(dialog.id,{dismissed:true})}/>:null}</>}
    taskBoardController.open('project');createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('wand-react-ui-portals')}><WandUiProvider><Fixture/></WandUiProvider></PortalContainerProvider>);`;
  const built = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const agent = { provider: "claude", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" };
  const base = { workspaceId: "project", workspaceTaskId: "workspace-parent", workspace: { id: "project", name: "Project", cwd: "/project" }, milestone: null,
    milestoneId: "iteration", status: "todo", priority: "low", dueDate: null, parentTaskId: null, createdAt: "2026-10-25", updatedAt: "2026-10-25", sortOrder: 0, labels: [], agent: null, executionSubject: null, sessions: [] };
  const tasks: any[] = [{ ...base, id: "parent", identifier: "TASK-1", title: "父目标", description: "父任务交付约束" }];
  const writes: Array<{ path: string; body: any }> = [];
  let refusal = 0, dispatchRefusal = 0, malformed = false;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
    if (/ChunkSrc|\.js$/.test(path)) { res.setHeader("content-type", "text/javascript"); res.end(""); return; }
    if (path === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
    if (!path.startsWith("/api/")) { res.setHeader("content-type", "text/html;charset=utf-8"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body,#root{height:100%;margin:0;position:relative}#root>div[hidden]{display:none}</style><div id="root"></div><div id="wand-react-ui-portals"></div><script src="/bundle.js"></script>'); return; }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text || "{}"); writes.push({ path, body });
      if (path === "/api/wand-tasks") {
        if (refusal) { res.statusCode = refusal; refusal = 0; res.end(JSON.stringify({ error: "Fixture rejected task" })); return; }
        if (malformed) { malformed = false; res.end("{}"); return; }
        const created = { ...base, ...body, id: "created-" + writes.length, identifier: "TASK-" + (writes.length + 1), title: body.title || "自动标题" };
        tasks.push(created); res.end(JSON.stringify(created)); return;
      }
      if (path.endsWith("/dispatch")) {
        if (dispatchRefusal) { res.statusCode = dispatchRefusal; dispatchRefusal = 0; res.end(JSON.stringify({ error: "Fixture dispatch failed" })); }
        else res.end(JSON.stringify({ ok: true, session: null, queued: true }));
        return;
      }
      if (path === "/api/client-feedback") { res.end("{}"); return; }
      res.statusCode = 400; res.end(JSON.stringify({ error: "Unexpected mutation " + path })); return;
    }
    const data = path === "/api/config" ? { defaultProvider: "claude", defaultSessionKind: "structured", defaultMode: "default", defaultCwd: "/project" }
      : path.includes("silicon-employees") ? { employees: [{ id: "e_wand_default", name: "默认伙伴", duty: "", agents: [agent] }] }
      : path === "/api/ai-teams" ? [] : path === "/api/workspaces" ? [{ id: "project", kind: "project", cwd: "/project", name: "Project" }, { id: "second", kind: "project", cwd: "/second", name: "Second project" }]
      : path === "/api/wand-tasks" ? tasks : path.startsWith("/api/wand-tasks/") ? { comments: [], totalCount: 0, nextCursor: null }
      : path === "/api/wand-task-agent-defaults" ? agent : path === "/api/models" ? { models: [] }
      : path === "/api/recent-paths" ? [{ path: "/project", name: "Project" }]
      : path === "/api/wand-milestones" ? { milestones: [{ id: "iteration", name: "本轮迭代", workspaceId: "project", isDefault: true, taskCount: 1 }, { id: "next-iteration", name: "下一轮迭代", workspaceId: "project", isDefault: false, taskCount: 0 }] }
      : path === "/api/tasks/groups" ? { groups: [], revision: "1" } : [];
    res.end(JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const output = "output/task-creation-browser"; mkdirSync(output, { recursive: true });
  const b = await openBrowser(origin, 1280, 950); t.after(() => b.close());
  const input = async (selector: string, text: string) => { await b.click(selector === 'textarea' ? '.new-work-page textarea' : selector); await b.send("Input.insertText", { text }); };
  const titleInput = '[data-wand-popup-owner="task-create-properties"] input[aria-label="任务标题"]';
  const openTaskTitle = async () => {
    await b.click('.task-create-page .new-work-context button[aria-label="任务标题"]');
    await b.wait("!!document.querySelector('[data-wand-popup-owner=task-create-properties] input[aria-label=任务标题]')?.checkVisibility()");
    assert.equal(await b.evaluate("document.querySelector('[data-wand-popup-owner=task-create-properties] input').getAttribute('aria-label')"), "任务标题", "the task slot opens title editing as the first property");
  };
  const closeProperties = async () => {
    const point = await b.evaluate("({x:innerWidth-4,y:Math.floor(innerHeight/2)})");
    await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    await b.wait("!document.querySelector('[data-wand-popup-owner=task-create-properties]')?.checkVisibility()");
  };
  const editTaskTitle = async (text: string) => { await openTaskTitle(); await input(titleInput, text); await closeProperties(); };
  const readTaskTitle = async () => {
    await openTaskTitle();
    const value = await b.evaluate("document.querySelector('[data-wand-popup-owner=task-create-properties] input[aria-label=任务标题]').value");
    await closeProperties();
    return value;
  };
  try {
    await b.wait("!!document.querySelector('[aria-label=新建任务]')");
    await b.click('[aria-label="新建任务"]'); await b.wait("!!document.querySelector('.task-create-page .conversation-sender')");
    assert.equal(await b.evaluate("fixture.state().newTask"), true);
    assert.equal(writes.length, 0, "all entry points only open an editor");
    assert.match(await b.evaluate("document.querySelector('.task-create-page h1').textContent"), /今天你想与.*在.*的.*中创造些什么？/, "planning keeps the sentence-style invitation");
    assert.equal(await b.evaluate("document.querySelectorAll('.task-create-page .new-work-context input').length"), 0, "title editing belongs in the task properties popup");
    await b.click('.task-create-page .new-work-context .new-work-inline-avatar');
    await b.wait("!!document.querySelector('[data-wand-popup-owner=task-create-subject]')?.checkVisibility()");
    await b.key("Escape");
    await b.wait("!document.querySelector('[data-wand-popup-owner=task-create-subject]')?.checkVisibility()");
    await b.click('.task-create-page .new-work-context .new-work-inline-directory');
    await b.wait("!!document.querySelector('[aria-label=新工作运行目录路径]')?.checkVisibility()");
    assert.equal(await b.evaluate("document.querySelector('[aria-label=新工作运行目录路径]').value"), "/project");
    await b.key("Escape");
    await b.wait("!document.querySelector('[aria-label=新工作运行目录路径]')?.checkVisibility()");
    await editTaskTitle("统一任务");
    assert.match(await b.evaluate("document.querySelector('.task-create-page .new-work-context button[aria-label=任务标题]').textContent"), /统一任务/, "editing the popup title updates its invitation slot");
    await input('textarea', "执行前先保留计划");
    await b.evaluate("fixture.input=document.querySelector('.task-create-page textarea');fixture.input.focus();fixture.input.setSelectionRange(2,5);true");
    await b.click('.task-create-page .composer-expand-editor');
    assert.deepEqual(await b.evaluate("({same:fixture.input===document.querySelector('.task-create-page textarea'),start:fixture.input.selectionStart,end:fixture.input.selectionEnd,expanded:document.querySelector('.task-create-page .conversation-input-wrap').dataset.editorExpanded})"),
      { same: true, start: 2, end: 5, expanded: "true" }, "expansion retains the shared input node and selection");
    await b.click('.task-create-page .composer-expand-editor');
    await openTaskTitle();
    await b.click('[data-wand-popup-owner="task-create-properties"] [aria-label="归属父任务"]'); await b.wait("!!document.querySelector('[aria-label=搜索主任务编号或标题]')");
    await input('[aria-label="搜索主任务编号或标题"]', "父目标");
    assert.equal(await b.evaluate("document.querySelector('[data-wand-popup-owner=task-create-properties]').checkVisibility()"), true, "nested search keeps the properties panel open");
    await b.click('[data-wand-popup-owner="归属父任务"] [role="option"][title^="TASK-1"]');
    assert.equal(await b.evaluate("document.querySelector('[data-wand-popup-owner=task-create-properties]').checkVisibility()"), true);
    await b.click('[data-wand-popup-owner="task-create-properties"] [aria-label="归属父任务"]'); await b.key("Escape");
    assert.equal(await b.evaluate("document.querySelector('[data-wand-popup-owner=task-create-properties]').checkVisibility()"), true, "first Escape closes the nested selector");
    await b.key("Escape");
    await b.wait("!document.querySelector('[data-wand-popup-owner=task-create-properties]')?.checkVisibility()");
    await b.click('.task-create-page button[aria-label="任务属性"]'); await closeProperties();
    await b.click('[id$="-tab-work"]'); await b.wait("!document.querySelector('.task-create-page') && !!document.querySelector('textarea')");
    assert.equal(await b.evaluate("document.querySelector('.new-work-page textarea').value"), "执行前先保留计划");
    await b.click('[id$="-tab-task"]'); await b.wait("!!document.querySelector('.task-create-page')");
    assert.equal(await readTaskTitle(), "统一任务");
    assert.equal(await b.evaluate("document.querySelector('.new-work-page textarea').value"), "执行前先保留计划");
    await b.screenshot(`${output}/01-shared-task-page.png`);
    await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await b.settle();
    assert.equal(await b.evaluate("document.documentElement.scrollWidth<=document.documentElement.clientWidth"), true, "task mode keeps the same bounded composer at narrow widths");
    assert.equal(await b.evaluate("(()=>{const r=document.querySelector('.task-create-page h1').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()"), true, "the sentence-style invitation fits a 390px viewport");
    await b.screenshot(`${output}/01b-shared-task-page-narrow.png`);
    await openTaskTitle();
    assert.equal(await b.evaluate("(()=>{const r=document.querySelector('[data-wand-popup-owner=task-create-properties] input[aria-label=任务标题]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()"), true, "title editing remains visible in the narrow popup");
    await b.screenshot(`${output}/01c-task-properties-narrow.png`);
    await closeProperties();
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
    refusal = 400; await b.click('[aria-label="仅创建任务"].conversation-submit');
    await b.wait("document.body.innerText.includes('Fixture rejected task')");
    assert.equal(await b.evaluate("document.querySelector('.new-work-page textarea').value"), "执行前先保留计划");
    assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), false, "explicit refusal allows correction and retry");
    await b.click('[aria-label="仅创建任务"].conversation-submit'); await b.wait("!document.querySelector('.task-create-page')");
    const saved = writes.filter(item => item.path === "/api/wand-tasks").at(-1)!.body;
    assert.equal(saved.parentTaskId, "parent"); assert.equal(saved.workspaceId, "project"); assert.equal(saved.milestoneId, "iteration");
    assert.equal(saved.status, "backlog"); assert.equal(writes.some(item => item.path.endsWith("/dispatch")), false);
    await b.evaluate("fixture.open({newTask:true,taskDraft:{workspaceId:'project',status:'todo',parentTaskId:''}});true");
    await b.wait("!!document.querySelector('.task-create-page textarea')");
    await editTaskTitle("跨列草稿"); await input("textarea", "切换入口保留正文");
    await b.click('.task-create-page button[aria-label="任务属性"]');
    await b.click('[data-wand-popup-owner="task-create-properties"] [aria-label="归属父任务"]'); await b.wait("!!document.querySelector('[aria-label=搜索主任务编号或标题]')");
    await b.click('[data-wand-popup-owner="归属父任务"] [role="option"][title^="TASK-1"]');
    await b.evaluate("fixture.close();true"); await b.wait("!document.querySelector('.task-create-page')");
    await b.evaluate("fixture.open({newTask:true,taskDraft:{workspaceId:'project',status:'doing',priority:'high',milestoneId:'next-iteration',parentTaskId:''}});true");
    await b.wait("!!document.querySelector('.task-create-page textarea')");
    assert.equal(await b.evaluate("document.querySelector('.task-create-page textarea').value"), "切换入口保留正文");
    assert.equal(await readTaskTitle(), "跨列草稿");
    await b.click('.task-create-page button[aria-label="任务属性"]');
    assert.match(await b.evaluate("document.querySelector('[data-wand-popup-owner=task-create-properties] [aria-label=状态]').textContent"), /处理中/, "the explicit new column overrides the cached Todo status");
    assert.doesNotMatch(await b.evaluate("document.querySelector('[data-wand-popup-owner=task-create-properties] [aria-label=归属父任务]').textContent"), /父目标/, "an explicit empty parent clears the previous manual choice");
    await b.evaluate("fixture.close();true"); await b.wait("!document.querySelector('.task-create-page')");
    await b.evaluate("fixture.open({newTask:true,taskDraft:{workspaceId:'project'}});true");
    await b.wait("!!document.querySelector('.task-create-page textarea')");
    await b.click('[aria-label="仅创建任务"].conversation-submit'); await b.wait("!document.querySelector('.task-create-page')");
    const resumed = writes.filter(item => item.path === "/api/wand-tasks").at(-1)!.body;
    assert.equal(resumed.title, "跨列草稿"); assert.equal(resumed.description, "切换入口保留正文");
    assert.equal(resumed.status, "doing"); assert.equal(resumed.priority, "high"); assert.equal(resumed.milestoneId, "next-iteration");
    assert.equal(resumed.parentTaskId, null, "omitted entry metadata keeps the latest explicit context without reviving a parent");
    await b.evaluate("fixture.open({newTask:true,initialCwd:'/project',taskDraft:{workspaceId:'project',draftKey:'qa-switch',title:'切换草稿'}});true");
    await b.wait("!!document.querySelector('.task-create-page textarea')"); await input("textarea", "随后清空");
    await b.click('[id$="-tab-work"]'); await b.wait("!document.querySelector('.task-create-page')");
    await b.click('.new-work-page .new-work-directory'); await b.wait("!!document.querySelector('[aria-label=新工作运行目录路径]')");
    await b.evaluate("const path=document.querySelector('[aria-label=新工作运行目录路径]');path.focus();path.select();true");
    await b.send("Input.insertText", { text: "/second" }); await b.key("Enter");
    await b.evaluate("const input=document.querySelector('.new-work-page textarea');input.focus();input.select();true"); await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }); await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await b.wait("document.querySelector('.new-work-page textarea').value===''", "work-mode clear is accepted before switching");
    await b.click('[id$="-tab-task"]'); await b.wait("!!document.querySelector('.task-create-page textarea')");
    assert.equal(await b.evaluate("document.querySelector('.task-create-page textarea').value"), "", "clearing text in work mode cannot revive the old task seed");
    assert.match(await b.evaluate("document.querySelector('.task-create-page .new-work-directory').textContent"), /Second project/, "returning to a saved task draft applies the newly selected work directory");
    assert.equal(await readTaskTitle(), "切换草稿", "task-only metadata survives work-mode edits");
    await b.evaluate("fixture.close();true");
    await b.evaluate("fixture.open({newTask:true,taskDraft:{workspaceId:'project',status:'doing',title:'显式执行'}});true");
    await b.wait("!!document.querySelector('.task-create-page textarea')"); await input("textarea", "一次执行");
    await b.click('[aria-label="保存并派发"]'); dispatchRefusal = 503;
    await b.click('[aria-label="创建并开始执行"].conversation-submit'); await b.wait("!!document.querySelector('[role=dialog]')");
    await b.evaluate("[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(n=>n.textContent==='创建并开始执行').click();true");
    await b.wait("document.body.innerText.includes('任务已创建。')");
    const acceptedCreates = writes.filter(item => item.path === "/api/wand-tasks").length;
    await b.key("Enter"); assert.equal(writes.filter(item => item.path === "/api/wand-tasks").length, acceptedCreates);
    assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), true, "dispatch failure cannot create a second task");
    await b.evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent==='打开已创建的任务').click();true");
    await b.wait("!document.querySelector('.task-create-page')");
    malformed = true;
    await b.evaluate("fixture.open({newTask:true,taskDraft:{workspaceId:'project',parentTaskId:'parent',draftKey:'qa-unknown',title:'未知结果'}});true");
    await b.wait("!!document.querySelector('.task-create-page')"); await b.click('[aria-label="仅创建任务"].conversation-submit');
    await b.wait("document.body.innerText.includes('创建结果未确认')");
    const unknownCreates = writes.filter(item => item.path === "/api/wand-tasks").length;
    await b.key("Enter"); assert.equal(writes.filter(item => item.path === "/api/wand-tasks").length, unknownCreates);
    await b.evaluate("fixture.close();fixture.open({newTask:true,taskDraft:{workspaceId:'project',parentTaskId:'parent',draftKey:'qa-unknown'}});true");
    await b.wait("!!document.querySelector('.task-create-page')");
    assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), true, "unknown result survives close/reopen");
    await b.screenshot(`${output}/02-unknown-result.png`);
    await b.evaluate("fixture.close();fixture.open({initialCwd:'/project',taskDraft:{draftKey:'qa-unknown'}});true");
    await b.wait("!document.querySelector('.task-create-page') && !!document.querySelector('.conversation-submit')");
    assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), true, "another work intent cannot bypass the shared unknown receipt");
    assert.deepEqual(b.errors, []);
  } catch (error) { await b.screenshot(`${output}/failure.png`); throw error; }
});
