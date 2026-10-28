import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser, closeFixtureServer } from "./helpers/run-plush-avatar-browser-harness.mjs";

test("task overview actions survive list filters and open the existing acceptance owner without writes", { timeout: 120_000 }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-task-action-host-"));
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {TaskBoardHost} from "./src/web-ui/react/issues/task-board-host";
    import {taskBoardController} from "./src/web-ui/react/issues/task-board-controller";
    import {taskBoardRepository} from "./src/web-ui/react/issues/task-board-repository";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {PortalContainerProvider} from "./src/web-ui/react/ui";
    installReactUiStyles();window.__wandAiTeamsChunk={TaskTeamRunPanel:()=>null};
    const task={id:"review-task",identifier:"TASK-1",title:"行动验收目标",description:"已有证据，仍须明确验收",status:"done",workspaceId:null,workspaceTaskId:null,workspace:null,milestone:null,milestoneId:null,parentTaskId:null,priority:"low",dueDate:null,createdAt:"2026-01-01",updatedAt:"2026-01-01",sortOrder:0,labels:[],agent:null,executionSubject:null,sessions:[],acceptance:{evidence:"已有交付证据",blocker:"",acceptedAt:null}};
    window.qa={writes:0};
    Object.assign(taskBoardRepository,{list:async()=>[structuredClone(task)],get:async()=>structuredClone(task),workspaces:async()=>[],models:async()=>({models:[]}),agentDefaults:async()=>({provider:"pi",model:"default",thinkingEffort:"off",mode:"default",kind:"structured"}),comments:async()=>({comments:[],totalCount:0,nextCursor:null}),update:async()=>{qa.writes++;throw Error("unexpected write")}});
    taskBoardController.open();createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider><TaskBoardHost/></WandUiProvider></PortalContainerProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method !== "GET") writes++;
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); }
    else if (url.pathname === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else if (url.pathname === "/api/wand-task-actions") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ incompleteSources: 0, items: [{ key: "review", taskId: "review-task", identifier: "TASK-1", title: "行动验收目标", workspaceId: null, kind: "review", reason: "已有交付证据，请明确验收", source: {} }] })); }
    else if (url.pathname.startsWith("/api/")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(url.pathname.startsWith("/api/ai-teams") ? [] : { employees: [], milestones: [] })); }
    else res.end('<html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><div id="portals"></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const browser = await openPlushBrowser(); const { evaluate, send, wait } = browser;
  try {
    await send("Page.navigate", { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/?view=taskboard&boardView=dashboard&q=no-match` });
    await wait("document.body.textContent.includes('待我验收 1')");
    await evaluate("document.querySelector('[data-stretch-value=review]').closest('.ant-segmented-item').click()"); await browser.settle();
    await evaluate("document.querySelector('[data-task-action=review]').closest('.ant-collapse-header').click()"); await browser.settle();
    await evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='查看交付与验收').click()");
    await wait("!!document.querySelector('[aria-label=交付证据与产物]')");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('task')"), "review-task");
    assert.equal(await evaluate("document.querySelector('[aria-label=交付证据与产物]').value"), "已有交付证据");
    assert.equal(await evaluate("document.querySelector('.task-board-acceptance-collapse .ant-collapse-header').getAttribute('aria-expanded')"), "true");
    assert.equal(await evaluate("qa.writes"), 0); assert.equal(writes, 0);
    assert.deepEqual(browser.errors, []);
  } finally { await browser.close(); await closeFixtureServer(server); rmSync(temp, { recursive: true, force: true }); }
});
