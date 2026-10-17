import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";

test("goal board four views, planning and execution tree use production components", { timeout: 240_000, skip: process.env.WAND_GOAL_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-goal-browser-"));
  const output = join(root, "output/task-hierarchy-dispatch-2026-10-17/implementation/browser"); mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {WorkspacesPanel} from "./src/web-ui/react/workspaces/workspaces-panel";
    import {configureWorkspacesRuntime} from "./src/web-ui/react/workspaces/controller";
    import {TaskBoardHost} from "./src/web-ui/react/issues/task-board-host";
    import {taskBoardController} from "./src/web-ui/react/issues/task-board-controller";
    import {taskBoardRepository} from "./src/web-ui/react/issues/task-board-repository";
    import {notifyTasksChanged} from "./src/web-ui/react/task-changes";
    import {filterSidebarGroups} from "./src/web-ui/react/workspaces/sidebar-search";
    import {PortalContainerProvider} from "./src/web-ui/react/ui";
    installReactUiStyles(); window.__wandAiTeamsChunk={TaskTeamRunPanel:()=>null};
    const base={workspaceId:null,workspaceTaskId:null,workspace:null,milestone:null,milestoneId:null,status:"todo",priority:"low",dueDate:null,parentTaskId:null,createdAt:"2026-10-17",updatedAt:"2026-10-17",sortOrder:0,labels:[],agent:null,executionSubject:null,sessions:[]};
    const goal={...base,id:"goal",identifier:"QA-1",title:"目标验收",description:"一个可验收的用户目标"};
    const children=[1,2,3].map(n=>({...base,id:"child"+n,identifier:"QA-"+(n+1),title:"独立交付"+n,description:"交付标准"+n,parentTaskId:"goal"}));
    window.qa={tasks:[goal,...children],creates:0,dispatches:0,refresh:notifyTasksChanged,sidebar:()=>filterSidebarGroups([{workspaceId:"qa",workspaceName:"QA",workspaceCwd:"/qa",standaloneSessions:[],tasks:qa.tasks.map(t=>({id:t.id,name:t.title,parentWorkspaceTaskId:t.parentTaskId,sessions:t.sessions,status:"active"}))}],"")};
    qa.source=()=>[{workspaceId:"qa",workspaceName:"QA",workspaceCwd:"/qa",standaloneSessions:[],tasks:qa.tasks.map(t=>({id:t.id,workspaceId:"qa",name:t.title,parentWorkspaceTaskId:t.parentTaskId,sessions:t.sessions,status:"active",createdAt:"2026-10-17",worktree:null,layout:null,cwd:"/qa",isolated:false,lastOpenedAt:null}))}];
    globalThis.fetch=async input=>new Response(JSON.stringify(String(input).startsWith("/api/tasks")?{groups:qa.source(),revision:String(Date.now())}:String(input).includes("workspaces")?[]:{employees:[],milestones:[]}),{headers:{"content-type":"application/json"}});
    configureWorkspacesRuntime({selectSession(){},openTask(){},openWorkspace(){},closeWorkspace(){},refreshSessions:async()=>{},toast(){},onOpen(){},onClose(){}});
    Object.assign(taskBoardRepository,{list:async()=>structuredClone(qa.tasks),workspaces:async()=>[],models:async()=>({models:[]}),agentDefaults:async()=>({provider:"claude",model:"default",thinkingEffort:"off",mode:"default",kind:"structured"}),
      create:async input=>{qa.creates++;const task={...base,...input,id:"saved",identifier:"QA-5",sessions:[]};qa.tasks.push(task);return task;},
      dispatch:async()=>{qa.dispatches++;throw Error("unexpected execution");},get:async id=>qa.tasks.find(t=>t.id===id),comments:async()=>[]});
    function App(){const [sidebar,setSidebar]=React.useState(false);qa.showSidebar=()=>setSidebar(true);return sidebar?<div style={{width:360,maxWidth:"100vw"}}><WorkspacesPanel/></div>:<TaskBoardHost/>;}
    taskBoardController.open();createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req,res) => { if(req.url === "/app.js") { res.setHeader("content-type","application/javascript");res.end(readFileSync(join(temp,"app.js"))); } else if(req.url === "/styles.css") {res.setHeader("content-type","text/css");res.end(readFileSync(join(root,"src/web-ui/content/styles.css")));} else {res.setHeader("content-type","text/html");res.end('<html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><div id="portals"></div><script src="/app.js"></script></body></html>');} });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address==="object");
  const browser=await openPlushBrowser();const {evaluate,wait,send}=browser;const cases=[];
  const click = async (selector: string) => {await browser.settle();await wait("!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))");await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`);await browser.settle();const p=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect();return {x:r.x+Math.min(r.width/2,80),y:r.y+r.height/2}})()`);assert.ok(p,selector);for(const type of ["mousePressed","mouseReleased"])await send("Input.dispatchMouseEvent",{type,...p,button:"left",clickCount:1});await browser.settle();await wait("!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))");};
  try {
    for(const mode of ["desktop","narrow","reduced-motion"]) {
      await send("Emulation.setDeviceMetricsOverride",{width:mode==="narrow"?390:1280,height:1000,deviceScaleFactor:1,mobile:false});
      await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:mode==="reduced-motion"?"reduce":"no-preference"}]});
      await send("Page.navigate",{url:`http://127.0.0.1:${address.port}/`});await wait("!!document.querySelector('[data-task-id=goal]')");
      assert.equal(await evaluate("document.querySelectorAll('.task-board-card').length"),1);
      assert.deepEqual(await evaluate("qa.sidebar()"),[]);
      if (!await evaluate("document.querySelector('[data-task-id=goal] .ant-collapse-header').getAttribute('aria-expanded')==='true'")) await click('[data-task-id=goal] .ant-collapse-header');await wait("document.body.innerText.includes('独立交付3')");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"目标验收 的子任务计划\"]').textContent.includes('尚未派发')"),true);
      await browser.screenshot(join(output,mode+"-goal-expanded.png"));
      for(const label of ["列表","甘特图","概览"]) {await click(`[data-stretch-value="${({列表:"list",甘特图:"gantt",概览:"dashboard"} as Record<string,string>)[label]}"]`);await wait("!!document.querySelector('.ant-collapse-header')");if (!await evaluate("document.querySelector('.ant-collapse-header').getAttribute('aria-expanded')==='true'")) await click('.ant-collapse-header');await wait("document.body.innerText.includes('独立交付3')");assert.equal(await evaluate("document.body.innerText.includes('独立交付3')"),true,label+" retains children");if(label==="甘特图"){await evaluate("qa.tasks[0].status='done';qa.refresh()");await wait("!!document.querySelector('.task-board-gantt-group.is-done')");await click('.task-board-gantt-hide input');assert.ok(await evaluate("!!document.querySelector('.task-board-gantt-group.is-done .task-board-gantt-row')"),"unfinished children retain the filtered parent context");await evaluate("qa.tasks[0].status='todo';qa.refresh()");await wait("!!document.querySelector('.task-board-gantt-group.is-todo')");}}
      await click('[data-stretch-value="board"]');await wait("!!document.querySelector('[data-task-id=goal]')");
      await evaluate("qa.tasks[1].sessions=[{id:'qa-execution',title:'QA execution',status:'idle',provider:'pi',sessionKind:'structured',cwd:'/qa',model:'fixture',thinkingEffort:'off'}];qa.refresh()");
      await browser.settle();assert.deepEqual(await evaluate("qa.sidebar()[0].tasks.map(t=>t.id)"),["goal","child1"]);
      assert.equal(await evaluate("qa.tasks.length"),4);assert.equal(await evaluate("qa.tasks[0].status"),"todo");
      await click('[aria-label="新建任务"]');await wait("!!document.querySelector('.task-board-create-title-input')");await click('.task-board-create-title-input');await send("Input.insertText",{text:"仅保存的计划"});
      await click('[aria-label="归属父任务"]');await wait("!!document.querySelector('[data-wand-popup-owner=归属父任务] input')");
      await click('[data-wand-popup-owner=归属父任务] input');await send("Input.insertText",{text:"目标验收"});
      assert.ok(await evaluate("!!document.querySelector('.task-board-create-title-input')"),"portal search keeps the parent form open");
      await click('[data-wand-popup-owner=归属父任务] [role=option][title^="QA-1 · 目标验收"]');
      assert.ok(await evaluate("!!document.querySelector('.task-board-create-title-input')"),"portal selection keeps the parent form open");
      await click('[aria-label="归属父任务"]');await wait("!!document.querySelector('[data-wand-popup-owner=归属父任务] input')");
      await browser.key("Escape");assert.ok(await evaluate("!!document.querySelector('.task-board-create-title-input')"),"Escape closes only the child popup");
      await click('[aria-label="归属父任务"]');await wait("!!document.querySelector('[data-wand-popup-owner=归属父任务] [role=option][title=无父任务]')");
      await click('[data-wand-popup-owner=归属父任务] [role=option][title=无父任务]');
      await click('[aria-label="归属父任务"]');await click('.task-board-create-title-input');
      assert.ok(await evaluate("!!document.querySelector('.task-board-create-title-input')"),"outside popup click preserves the task draft");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"保存并派发\"]').getAttribute('aria-checked')"),"false");
      await click('button.task-board-create-submit');await wait("qa.creates===1");assert.equal(await evaluate("qa.dispatches"),0);assert.equal(await evaluate("qa.sidebar()[0].tasks.length"),2);
      await browser.screenshot(join(output,mode+".png"));
      await evaluate("qa.showSidebar()");await wait("document.querySelectorAll('[data-workspace-task-id]').length===2");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-workspace-task-id]')].map(n=>n.dataset.workspaceTaskId)"),["goal","child1"]);
      await browser.screenshot(join(output,mode+"-execution-tree.png"));
      await evaluate("qa.tasks[1].sessions=[];qa.refresh()");await wait("document.querySelectorAll('[data-workspace-task-id]').length===0");
      assert.equal(await evaluate("qa.tasks.length"),5,"removing the visible session only prunes the projection");
      cases.push({mode,fourViews:true,plannedWithoutExecution:true,portalOwnership:true,filteredParentContext:true,childOnlyExecutionRetainsParent:true,modelCalls:0});
    }
    assert.deepEqual(browser.errors,[]);writeFileSync(join(output,"result.json"),JSON.stringify({ok:true,cases},null,2));
  } catch(error) {await browser.screenshot(join(output,"failure.png"));writeFileSync(join(output,"failure.json"),JSON.stringify({error:String(error),errors:browser.errors,state:await evaluate("document.body.innerText")},null,2));throw error;}
  finally {await browser.close();server.close();rmSync(temp,{recursive:true,force:true});}
});
