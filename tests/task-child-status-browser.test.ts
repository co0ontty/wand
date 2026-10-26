import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";

test("goal detail has one child list and separates submitted work, user acceptance and archival", { timeout: 180_000, skip: process.env.WAND_GOAL_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-child-status-"));
  const output = join(root, "output/task-panel-completion-review/browser"); mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {TaskBoardHost} from "./src/web-ui/react/issues/task-board-host";
    import {taskBoardController} from "./src/web-ui/react/issues/task-board-controller";
    import {taskBoardRepository} from "./src/web-ui/react/issues/task-board-repository";
    import {PortalContainerProvider} from "./src/web-ui/react/ui";
    installReactUiStyles();window.__wandAiTeamsChunk={TaskTeamRunPanel:()=>null};
    const base={workspaceId:null,workspaceTaskId:null,workspace:null,milestone:null,milestoneId:null,status:"doing",priority:"low",dueDate:null,parentTaskId:null,createdAt:"2026-10-21",updatedAt:"2026-10-21",sortOrder:0,labels:[],agent:null,executionSubject:null,sessions:[],acceptance:null};
    const goal={...base,id:"goal",identifier:"GOAL",title:"主任务",description:"协调各项独立交付，逐项验收"};
    const tasks=[goal,...["working","submitted","accepted","archived"].map((id,i)=>({...base,id,identifier:"CHILD-"+i,title:"长标题子任务"+i+"：保留完整目标与各自独立的状态",parentTaskId:"goal",status:i===0?"doing":i===3?"archived":"done",assignedExecutor:{id:"owner",name:"负责人"},acceptance:i===2?{evidence:"报告",blocker:"",acceptedAt:"2026-10-21"}:i===1?{evidence:"实现及回归证据",blocker:"设备验收待核对",acceptedAt:null}:null}))];
    window.qa={tasks,patches:0,dispatches:0};
    globalThis.fetch=async input=>new Response(JSON.stringify(String(input).startsWith("/api/ai-teams")?[]:{employees:[],milestones:[]}),{headers:{"content-type":"application/json"}});
    Object.assign(taskBoardRepository,{list:async()=>structuredClone(tasks),get:async id=>tasks.find(t=>t.id===id),workspaces:async()=>[],models:async()=>({models:[]}),agentDefaults:async()=>({provider:"pi",model:"default",thinkingEffort:"off",mode:"managed",kind:"structured"}),comments:async()=>({comments:[],totalCount:0,nextCursor:null}),update:async()=>{qa.patches++;throw Error("unexpected mutation")},dispatch:async()=>{qa.dispatches++;throw Error("unexpected dispatch")}});
    taskBoardController.open();createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider><TaskBoardHost/></WandUiProvider></PortalContainerProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const file = req.url?.split("?")[0];
    if (file === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); }
    else if (file === "/styles.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else res.end('<html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><div id="portals"></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const browser = await openPlushBrowser(); const { send, wait, evaluate } = browser;
  try {
    for (const [mode, width] of [["desktop", 1440], ["narrow", 430], ["native-reduced", 900]] as const) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "native-reduced" ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/?view=taskboard&task=goal${mode === "native-reduced" ? "&reactUi=0" : ""}` });
      await wait("document.querySelectorAll('[aria-label=子任务] [data-stream-row^=child-]').length===4");
      if (mode === "native-reduced") await evaluate("document.documentElement.classList.add('is-wand-app')");
      assert.equal(await evaluate("document.querySelectorAll('[data-stream-row^=child-]').length"), 4, "one occurrence per child including archived");
      assert.equal(await evaluate("document.querySelector('[data-stream-row=child-submitted]').innerText.includes('工作：已完成') && document.querySelector('[data-stream-row=child-submitted]').innerText.includes('验收：等待你验收')"), true);
      assert.equal(await evaluate("document.querySelector('[data-stream-row=child-accepted]').innerText.includes('验收：已通过')"), true);
      assert.equal(await evaluate("document.querySelector('[data-stream-row=child-archived]').innerText.includes('工作：未确认') && document.querySelector('[data-stream-row=child-archived]').innerText.includes('已归档')"), true);
      assert.equal(await evaluate("document.querySelector('[aria-label=子任务]').innerText.includes('1 项等待验收 · 1 项验收通过')"), true);
      assert.equal(await evaluate("document.body.innerText.includes('可引用任务') || document.body.innerText.includes('子任务与员工执行')"), false, "duplicate sections removed");
      await browser.click('[data-stream-row=child-submitted] .task-stream-row-summary');
      await wait("document.querySelector('[data-stream-row=child-submitted]').innerText.includes('实现及回归证据')");
      assert.equal(await evaluate("document.querySelectorAll('[data-stream-row^=child-]').length"), 4);
      assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false, "no page overflow");
      await browser.screenshot(join(output, mode + ".png"));
      await browser.click('[data-stream-row=child-submitted] .task-stream-row-summary');
      await wait("!document.querySelector('#detail-child-submitted')");
      assert.deepEqual(await evaluate("[qa.patches,qa.dispatches,qa.tasks[0].status,qa.tasks[1].status]"), [0, 0, "doing", "doing"]);
    }
  } catch (error) {
    console.error("browser errors", browser.errors, await evaluate("document.body?.innerText?.slice(0,3000)"));
    throw error;
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(temp, { recursive: true, force: true }); }
});
