import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { themeFixtureHtml } from "./helpers/theme-fixture.js";

test("scheduled task page preserves save identity, employee selection, revisions, history and mobile layout", {
  skip: process.env.WAND_SCHEDULED_TASKS_BROWSER !== "1", timeout: 240_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-scheduled-task-browser-"));
  const evidence = join(root, "output/architecture-stage2/scheduled-tasks-browser"); mkdirSync(evidence, { recursive: true });
  const source = String.raw`
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { PortalContainerProvider, WandDialog } from "./src/web-ui/react/ui";
    import { overlayStore } from "./src/web-ui/react/overlay-controller";
    import { ScheduledTasksPage } from "./src/web-ui/react/scheduled-tasks/page";
    installReactUiStyles();
    // LAN HTTP retains getRandomValues but lacks secure-context randomUUID.
    Object.defineProperty(globalThis.crypto,"randomUUID",{value:undefined,configurable:true});
    const employee = { id:"e1",name:"员工甲",duty:"测试",prompt:"",avatar:"",agents:[{provider:"codex",model:"fixture",kind:"structured"}],tags:[],createdAt:"2026-01-01",updatedAt:"2026-01-01" };
    const agentless = {...employee,id:"e-none",name:"无工具员工",agents:[]};
    const archived = {...employee,id:"e-old",name:"归档员工",archivedAt:"2026-01-01"};
    const workspaces = [{id:"w-global",name:"全局（不可选）",kind:"global",cwd:"/tmp/global"},
      {id:"w1",name:"工作区甲",kind:"project",cwd:"/tmp/acceptance/workspace-alpha"},
      {id:"w2",name:"工作区乙",kind:"project",cwd:"/tmp/acceptance/workspace-beta/long-project-directory-for-mobile-layout-verification"}];
    window.fixture = {tasks:[],requests:[],runs:[],failSave:true,openSession:"",openedSessions:[],backCount:0,intervals:new Map()};
    const interval=globalThis.setInterval,clear=globalThis.clearInterval;
    globalThis.setInterval=(callback,delay,...args)=>{const id=interval(callback,delay,...args);if(delay===15000)fixture.intervals.set(id,callback);return id;};
    globalThis.clearInterval=id=>{fixture.intervals.delete(id);return clear(id);};
    fixture.poll=()=>{fixture.intervals.forEach(callback=>callback());};
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
    globalThis.fetch=async(input,init)=>{
      const url=String(input),method=init?.method??"GET",body=init?.body?JSON.parse(String(init.body)):null;
      fixture.requests.push({url,method,body});
      if(url.startsWith("/api/silicon-employees"))return json({employees:[employee,agentless,archived]});
      if(url.startsWith("/api/workspaces"))return json(workspaces);
      if(url.startsWith("/api/scheduled-tasks")) {
        const id=url.split("/")[3]?.split("?")[0];
        if(method==="GET")return json(id?{task:fixture.tasks.find(t=>t.id===id),runs:fixture.runs}:{tasks:fixture.tasks});
        if(method==="POST"){
          let task=fixture.tasks.find(t=>t.requestId===body.requestId);
          if(!task){const workspace=workspaces.find(item=>item.id===body.workspaceId);task={...body,id:"task-"+(fixture.tasks.length+1),title:body.prompt.trim().split("\n")[0].slice(0,80),enabled:true,nextRunAt:body.schedule.kind==="once"?body.schedule.runAt:"2027-01-01T00:00:00Z",revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),cancelledAt:null,employeeName:"员工甲",employeeUnavailableReason:null,workspaceName:workspace.name,workspaceCwd:workspace.cwd,workspaceUnavailableReason:null,lastRun:null};fixture.tasks.push(task);}
          if(fixture.failSave){fixture.failSave=false;throw Error("Simulated lost save receipt");}
          return json({task});
        }
        if(method==="PATCH"){
          const current=fixture.tasks.find(t=>t.id===id);
          if(body.revision!==current.revision)return json({error:"Revision conflict"},409);
          Object.assign(current,body,{revision:current.revision+1,updatedAt:new Date().toISOString()},body.cancelled?{cancelledAt:new Date().toISOString(),enabled:false}:{});
          const workspace=workspaces.find(item=>item.id===current.workspaceId);Object.assign(current,{workspaceName:workspace.name,workspaceCwd:workspace.cwd});
          return json({task:current});
        }
      }
      throw Error("Unexpected fixture request "+method+" "+url);
    };
    function DraftDialog(){const current=React.useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot,overlayStore.getSnapshot);const dialog=current.activeDialog;return dialog?<WandDialog open title={dialog.options.title} description={dialog.options.description} actions={dialog.options.actions} onAction={(action,inputValue)=>overlayStore.completeDialog(dialog.id,{dismissed:false,action,inputValue})} onOpenChange={open=>{if(!open)overlayStore.completeDialog(dialog.id,{dismissed:true})}}/>:null;}
    function App(){const[visible,setVisible]=React.useState(true);React.useEffect(()=>{fixture.visible=setVisible;},[]);return <><ScheduledTasksPage visible={visible} onBack={()=>fixture.backCount++} onOpenSession={id=>{fixture.openSession=id;fixture.openedSessions.push(id);}}/><DraftDialog/></>;}
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
    outfile: join(temporary, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    if (request.url === "/app.js") { response.setHeader("content-type", "application/javascript"); response.end(readFileSync(join(temporary, "app.js"))); }
    else if (request.url === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(themeFixtureHtml('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>#root{position:relative;height:100dvh;min-width:0}body{margin:0}</style></head><body><div id="root"></div><div id="overlay-root"><div class="wand-ui-portals" id="portals"></div></div><script src="/app.js"></script></body></html>')); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temporary}/profile`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const pause = (ms: number) => new Promise(resolvePause => setTimeout(resolvePause, ms));
  const errors: string[] = [];
  try {
    for (let count = 0; count < 150 && !existsSync(join(temporary, "profile/DevToolsActivePort")); count++) await pause(40);
    const port = readFileSync(join(temporary, "profile/DevToolsActivePort"), "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(tabs.find(tab => tab.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0; const pending = new Map<number, (result: any) => void>();
    socket.addEventListener("message", event => { const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(message.params));
      if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); } });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(resolveSend => {
      const id = ++sequence; pending.set(id, resolveSend); socket!.send(JSON.stringify({ id, method, params }));
    }).then(message => { if (message.error) throw Error(JSON.stringify(message.error)); return message.result; });
    const evaluate = async (expression: string): Promise<any> => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = async (expression: string): Promise<void> => { for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate(expression)) return; await pause(40); } throw Error(`Timeout ${expression}: ${await evaluate("document.body.innerText.slice(-500)")}`); };
    const element = (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(n=>n.checkVisibility({checkVisibilityCSS:true})&&!n.closest('[hidden],[inert]'))`;
    const click = async (selector: string): Promise<void> => {
      await wait(`!!(${element(selector)})`);
      let point: { x: number; y: number; hit: boolean } | null = null;
      for (let attempt = 0; attempt < 100 && !point?.hit; attempt++) {
        await pause(40);
        point = await evaluate(`(()=>{const n=${element(selector)};if(!n)return null;n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,hit:h===n||n.contains(h)};})()`);
      }
      assert.ok(point?.hit, `click is not covered by an animating portal: ${selector}`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    };
    const button = async (label: string): Promise<void> => { await evaluate(`Array.from(document.querySelectorAll('button')).find(n=>n.checkVisibility()&&n.textContent.replace(/\\s/g,'')===${JSON.stringify(label.replace(/\s/g, ''))})?.setAttribute('data-test-click','')`); await click("[data-test-click]"); await evaluate("document.querySelector('[data-test-click]')?.removeAttribute('data-test-click')"); };
    const escape = async (): Promise<void> => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); };
    const screenshot = async (name: string): Promise<void> => {
      await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))");
      const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, `${name}.png`), Buffer.from(shot.data, "base64"));
    };
    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    await wait("document.body.innerText.includes('还没有定时任务')");
    assert.equal(await evaluate("typeof globalThis.crypto.randomUUID"), "undefined", "the page renders without secure-context randomUUID");
    await button("新建定时任务");
    await click('[aria-label="执行员工"]');
    await click('[aria-label="搜索员工"]'); await send("Input.insertText", { text: "归档" });
    await wait("document.querySelector('[role=option][aria-disabled=true]')?.textContent.includes('归档员工')");
    await escape();
    assert.equal(await evaluate("!!document.querySelector('#scheduled-task-prompt')"), true, "Escape closes the employee portal first");
    await click('[aria-label="执行员工"]'); await click('[aria-label="搜索员工"]'); await send("Input.insertText", { text: "员工甲" });
    await click('[role="option"][title="员工甲"]');
    await wait("document.querySelector('[aria-label=执行员工]').textContent.includes('员工甲')");
    assert.equal(await evaluate("document.querySelector('[aria-label=执行员工]').textContent.includes('员工甲')"), true);
    const prompt = "  帖子原文\n第二段：完整保留输入。\n  ";
    await click("#scheduled-task-prompt"); await send("Input.insertText", { text: prompt });
    assert.equal(await evaluate("document.querySelector('form.scheduled-task-form').hasAttribute('novalidate')"), true);
    await button("创建定时任务"); await wait("document.getElementById('scheduled-task-workspace-help').textContent.includes('请选择执行工作区')");
    assert.equal(await evaluate("document.activeElement?.id"), "scheduled-task-workspace");
    assert.equal(await evaluate("document.getElementById('scheduled-task-workspace').getAttribute('aria-invalid')"), "true");
    assert.equal(await evaluate("fixture.requests.filter(r=>r.method==='POST').length"), 0);
    await click('[aria-label="执行工作区"]'); await click('[aria-label="搜索工作区"]');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('[role=option]')).some(n=>n.textContent.includes('全局'))"), false, "global workspace cannot be selected");
    await send("Input.insertText", { text: "工作区甲" }); await click('[role=option][title="工作区甲"]');
    await wait("document.querySelector('.scheduled-task-directory')?.textContent.includes('/tmp/acceptance/workspace-alpha')");
    assert.equal(await evaluate("document.getElementById('scheduled-task-workspace').hasAttribute('aria-invalid')"), false);
    await click('[aria-label="执行日期和时间"]');
    await wait("!!document.querySelector('.ant-picker-panel-container')");
    await wait("document.querySelector('.ant-picker-month-btn')?.textContent.includes('月')");
    assert.equal(await evaluate("document.querySelector('.ant-picker-content thead')?.textContent.includes('一')"), true, "calendar uses shared Chinese locale");
    await escape();
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').value"), prompt);
    assert.equal(await evaluate("fixture.backCount"), 0, "date popup Escape never navigates the parent page");
    await screenshot("desktop-form");
    await button("创建定时任务");
    await wait("document.body.innerText.includes('保存回执尚未确认')");
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').value"), prompt);
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').disabled"), true, "unknown creation preserves original request payload");
    await button("确认保存结果"); await wait("document.querySelectorAll('.scheduled-task-row').length===1");
    const createRequests = await evaluate("fixture.requests.filter(r=>r.method==='POST')");
    assert.equal(createRequests.length, 2); assert.deepEqual(createRequests[0].body, createRequests[1].body);
    assert.match(createRequests[0].body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "getRandomValues fallback produces a UUID v4 request ID");
    assert.equal(createRequests[0].body.prompt, prompt); assert.equal(await evaluate("fixture.tasks.length"), 1);
    assert.equal(createRequests[0].body.workspaceId, "w1");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.scheduled-task-row button')).filter(n=>n.textContent.trim()==='查看会话').length"), 0, "a saved plan has no session before its first execution");
    assert.equal(await evaluate("document.querySelector('.scheduled-tasks-intro').textContent.includes('每次执行都会创建独立会话')"), true);
    await screenshot("desktop-list");

    await evaluate("fixture.runs=[{id:'run1',scheduledAt:'2026-10-11T00:00:00Z',executionStatus:'completed',sessionId:'scheduled-run-exact-session',workspaceId:'w1',cwd:'/tmp/acceptance/workspace-alpha',error:null}];fixture.tasks[0].lastRun=fixture.runs[0];fixture.poll()");
    await wait("Array.from(document.querySelectorAll('.scheduled-task-row button')).some(n=>n.textContent.trim()==='查看会话')");
    await button("查看会话");
    assert.equal(await evaluate("fixture.openSession"), "scheduled-run-exact-session", "poll exposes and opens this exact execution session");
    await evaluate("fixture.poll()");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.scheduled-task-row button')).filter(n=>n.textContent.trim()==='查看会话').length"), 1, "repeated reads do not duplicate the session action");
    for (const state of ["skipped", "unknown"]) {
      await evaluate(`fixture.tasks[0].lastRun={id:${JSON.stringify(`run-${state}`)},scheduledAt:'2026-10-12T00:00:00Z',executionStatus:${JSON.stringify(state)},sessionId:null,error:null};fixture.poll()`);
      await wait("!Array.from(document.querySelectorAll('.scheduled-task-row button')).some(n=>n.textContent.trim()==='查看会话')");
      assert.equal(await evaluate("fixture.runs[0].sessionId"), "scheduled-run-exact-session", "an older run remains in history");
      assert.deepEqual(await evaluate("fixture.openedSessions"), ["scheduled-run-exact-session"], "a skipped or unconfirmed run without a session cannot reuse older history");
    }
    await evaluate("fixture.tasks[0].lastRun=fixture.runs[0];fixture.poll()");
    await wait("Array.from(document.querySelectorAll('.scheduled-task-row button')).some(n=>n.textContent.trim()==='查看会话')");

    await button("编辑");
    await click('[aria-label="执行工作区"]'); await click('[aria-label="搜索工作区"]'); await send("Input.insertText", { text: "工作区乙" });
    await click('[role=option][title="工作区乙"]'); await wait("document.querySelector('.scheduled-task-directory')?.textContent.includes('workspace-beta')");
    await click('[aria-label="执行计划"]'); await click('[role=option][title="每周"]');
    await click('[aria-label="执行星期"]'); await click('[role=option][title="周五"]');
    await click('[aria-label="执行时间"]'); await wait("!!document.querySelector('.ant-picker-panel-container')"); await escape();
    await click('[aria-label="执行时区"]'); await click('[aria-label="搜索时区"]'); await send("Input.insertText", { text: "Asia/Shanghai" });
    await click('[role=option][title^="Asia/Shanghai"]');
    await evaluate("fixture.tasks[0].revision++");
    await button("保存修改"); await wait("document.body.innerText.includes('计划已在其他页面修改')");
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').value"), prompt, "revision conflict preserves the full input");
    await button("保存修改"); await wait("document.querySelectorAll('.scheduled-task-row').length===1");
    assert.deepEqual(await evaluate("fixture.tasks[0].schedule"), { kind: "weekly", time: "09:00", timeZone: "Asia/Shanghai", weekday: 5 });
    assert.equal(await evaluate("fixture.tasks[0].workspaceId"), "w2");
    assert.equal(await evaluate("fixture.requests.filter(r=>r.method==='PATCH'&&r.body.prompt!==undefined).every(r=>r.body.workspaceId==='w2')"), true, "every edit and conflict retry binds the selected workspace");
    await button("暂停"); await wait("document.querySelector('.scheduled-task-row').textContent.includes('已暂停')");
    await button("恢复"); await wait("document.querySelector('.scheduled-task-row').textContent.includes('待执行')");
    await button("取消计划"); await button("确认取消");
    await wait("document.querySelector('.scheduled-task-row').textContent.includes('已取消')");
    assert.equal(await evaluate("fixture.tasks.length"), 1, "cancellation keeps the task and its records");
    await button("查看会话");
    assert.equal(await evaluate("fixture.openSession"), "scheduled-run-exact-session", "cancelled plans retain their execution session action");
    await button("执行记录"); await wait("document.body.innerText.includes('已完成')"); await button("查看会话");
    assert.equal(await evaluate("fixture.openSession"), "scheduled-run-exact-session");
    assert.equal(await evaluate("document.querySelector('.scheduled-task-run .scheduled-task-directory').textContent.includes('/tmp/acceptance/workspace-alpha')"), true, "run directory remains its original execution snapshot after plan workspace changes");
    await click('[aria-label="返回定时任务"]');

    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.scheduled-task-row button')).every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})"), true, "the direct session action fits the 390px list alongside history");
    await button("查看会话");
    assert.equal(await evaluate("fixture.openSession"), "scheduled-run-exact-session", "the session action remains reachable on mobile");
    await screenshot("mobile-list");
    await button("新建定时任务");
    await click('[aria-label="执行工作区"]'); await click('[aria-label="搜索工作区"]'); await send("Input.insertText", { text: "工作区乙" }); await click('[role=option][title="工作区乙"]');
    await click("#scheduled-task-prompt"); await send("Input.insertText", { text: "手机草稿，返回后继续填写" });
    await screenshot("mobile-form");
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
    await button("返回列表"); await button("新建定时任务");
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').value"), "手机草稿，返回后继续填写");
    await click('[aria-label="执行日期和时间"]'); await wait("!!document.querySelector('.ant-picker-panel-container')");
    await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))");
    const popupBounds = async (): Promise<any> => {
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      return evaluate("(()=>{const n=document.querySelector('.scheduled-task-date-popup:not(.ant-picker-dropdown-hidden) .ant-picker-panel-container');const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};})()");
    };
    const datePopup = await popupBounds();
    assert.ok(datePopup.left >= 0 && datePopup.right <= 390 && datePopup.top >= 0 && datePopup.bottom <= 844, JSON.stringify(datePopup));
    await screenshot("mobile-date-popup");
    await click(".scheduled-task-date-popup .ant-picker-ok button");
    await wait("!document.querySelector('.scheduled-task-date-popup:not(.ant-picker-dropdown-hidden)')");
    await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 720, deviceScaleFactor: 1, mobile: false });
    await click('[aria-label="执行日期和时间"]');
    await wait("!!document.querySelector('.scheduled-task-date-popup:not(.ant-picker-dropdown-hidden)')");
    await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))");
    const smallDatePopup = await popupBounds();
    assert.ok(smallDatePopup.left >= 0 && smallDatePopup.right <= 320 && smallDatePopup.top >= 0 && smallDatePopup.bottom <= 720, JSON.stringify(smallDatePopup));
    await click(".scheduled-task-date-popup .ant-picker-ok button");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await click('[aria-label="执行日期和时间"]');
    await evaluate("fixture.visible(false)"); await wait("fixture.intervals.size===0 && !document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)')");
    const hiddenReads = await evaluate("fixture.requests.length"); await evaluate("fixture.poll()");
    assert.equal(await evaluate("fixture.requests.length"), hiddenReads, "hidden page never polls");
    await evaluate("fixture.visible(true)"); await wait("fixture.intervals.size===1");
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').value"), "手机草稿，返回后继续填写");
    // Only a deliberate switch of edit target may discard an unsaved draft.
    await button("返回列表");
    await evaluate("fixture.tasks.push({...fixture.tasks[0],id:'task-2',cancelledAt:null,enabled:true,prompt:'已有计划 B',title:'已有计划 B',revision:1})");
    await wait("Array.from(document.querySelectorAll('button')).some(n=>n.textContent.trim()==='刷新'&&!n.disabled)");
    await button("刷新");
    await wait("document.querySelectorAll('.scheduled-task-row').length===2");
    await button("编辑"); await wait("document.body.innerText.includes('放弃未创建的任务')");
    await button("继续编辑"); await button("新建定时任务");
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').value"), "手机草稿，返回后继续填写", "cancel target switch keeps draft A");
    await button("返回列表"); await button("编辑"); await button("放弃草稿");
    await wait("document.querySelector('#scheduled-task-prompt')?.value==='已有计划 B'");
    await click('[aria-label="执行工作区"]'); await click('[aria-label="搜索工作区"]'); await send("Input.insertText", { text: "工作区甲" }); await click('[role=option][title="工作区甲"]');
    await button("返回列表"); await button("新建定时任务"); await wait("document.body.innerText.includes('放弃未创建的任务')");
    await button("继续编辑"); await button("编辑");
    assert.equal(await evaluate("document.getElementById('scheduled-task-workspace').textContent.includes('工作区甲')"), true, "changing only the workspace marks the draft dirty and cancelling preserves it");
    await click("#scheduled-task-prompt"); await send("Input.insertText", { text: "（未保存的编辑）" });
    const editedDraft = await evaluate("document.querySelector('#scheduled-task-prompt').value");
    await button("返回列表"); await button("新建定时任务"); await button("继续编辑");
    await button("编辑");
    assert.equal(await evaluate("document.querySelector('#scheduled-task-prompt').value"), editedDraft, "cancel new task switch keeps edited B");
    await button("返回列表"); await button("新建定时任务"); await button("放弃草稿");
    await wait("document.querySelector('#scheduled-task-prompt')?.value===''");
    assert.deepEqual(errors, [], "no page exceptions");
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, promptPreserved: true, stableCreateRequest: true,
      revisionConflict: true, cancellationPreservesHistory: true, mobileLayout: true, workspaceSelection: true, immutableRunDirectory: true,
      inlineWorkspaceValidation: true, workspaceOnlyDirtyGuard: true, chineseCalendar: true, mobileDatePopup: datePopup, smallDatePopup,
      hiddenPollingStopped: true, insecureContextRequestId: true, exactSessionFromList: true, noSessionBeforeExecution: true,
      absentRunSessionNeverReusesHistory: true, cancelledPlanSessionAccessible: true, errors }, null, 2));
  } finally {
    socket?.close();
    if (chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, "exit"); chrome.kill("SIGTERM"); await exited; }
    await new Promise<void>(done => server.close(() => done()));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
