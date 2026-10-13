import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";

test("task assignments retain explicit choices through refresh, reopen and reload", {
  timeout: 420_000, skip: process.env.WAND_ASSIGNMENT_BROWSER !== "1",
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-assignment-"));
  const output = join(root, "output/agent-assignment/browser");
  mkdirSync(output, { recursive: true });
  const source = String.raw`
    import * as React from "react";
    import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {TaskBoardHost} from "./src/web-ui/react/issues/task-board-host";
    import {taskBoardController} from "./src/web-ui/react/issues/task-board-controller";
    import {taskBoardRepository} from "./src/web-ui/react/issues/task-board-repository";
    import {notifyTasksChanged} from "./src/web-ui/react/task-changes";
    import {notifySiliconEmployeeDefinitionChanged} from "./src/web-ui/react/agents/employee-repository";
    import {PortalContainerProvider} from "./src/web-ui/react/ui";
    installReactUiStyles();
    window.__wandAiTeamsChunk={TaskTeamRunPanel:()=>null};
    const defaults={provider:"claude",model:"default",thinkingEffort:"off",mode:"default",kind:"structured"};
    const sdk={provider:"pi",model:"test/model",thinkingEffort:"deep",mode:"managed",kind:"structured",engine:"sdk"};
    const catalog={models:[{id:"default",label:"Default"}],piModels:[{id:"test/model",label:"Fixture model"}]};
    const base={identifier:"TASK-1",title:"First assignment",description:"Read-only UI fixture",workspaceId:null,workspaceTaskId:null,workspace:null,milestone:null,milestoneId:null,status:"todo",priority:"low",dueDate:null,parentTaskId:null,createdAt:"2026-01-01",updatedAt:"2026-01-01",sortOrder:0,labels:[],agent:null,executionSubject:null,sessions:[]};
    const employee={id:"employee-test",name:"Test employee",duty:"Fixture only",prompt:"",avatar:"",tags:[],agents:[defaults]};
    const team={id:"team-test",name:"Test team",members:[]};
    window.assignment={tasks:[{...base,id:"first"},{...base,id:"second",identifier:"TASK-2",title:"Second assignment"},{...base,id:"configured",identifier:"TASK-3",title:"Configured SDK",agent:sdk,executionSubject:{type:"cli",id:"pi"}}],employees:[employee],teams:[team],defaults,reads:0,writes:[],refresh:notifyTasksChanged,refreshEmployees:notifySiliconEmployeeDefinitionChanged};
    const qa=window.assignment;
    globalThis.fetch=async(input,init)=>{
      const url=String(input);
      if(init?.method&&init.method!=="GET"){qa.writes.push(url);throw Error("Unexpected fixture mutation");}
      const body=url.includes("provider-usage")?{}:url.includes("models")?catalog:url.includes("silicon-employees")?{employees:qa.employees}:url.includes("ai-teams")?qa.teams:url.includes("wand-milestones")?{milestones:[]}:url.includes("team-runs")?[]:{};
      return new Response(JSON.stringify(body),{headers:{"content-type":"application/json"}});
    };
    Object.assign(taskBoardRepository,{
      list:async()=>{qa.reads++;return JSON.parse(JSON.stringify(qa.tasks));},workspaces:async()=>[],
      models:async()=>catalog,
      agentDefaults:async()=>new Promise(resolve=>{qa.releaseDefaults=()=>resolve(qa.defaults);}),
      saveAgentDefaults:async()=>{qa.writes.push("defaults");throw Error("Unexpected global defaults mutation");},
    });
    taskBoardController.open();
    const app=createRoot(document.getElementById("root"));
    app.render(<PortalContainerProvider container={document.getElementById("wand-react-ui-portals")}><WandUiProvider><TaskBoardHost/></WandUiProvider></PortalContainerProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url?.includes("aiTeamsChunkSrc")) { res.setHeader("content-type", "application/javascript"); res.end(""); }
    else if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(readFileSync(join(temp, "app.js"))); }
    else if (req.url === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/`;
  const browser = await openPlushBrowser();
  const { evaluate, wait, clickText, key, send } = browser;
  async function click(selector: string): Promise<void> {
    await browser.settle();
    await wait("!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))", "finite UI motion complete");
    await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n?.closest('[data-wand-popup-owner]'))n?.scrollIntoView({block:'nearest',behavior:'instant'})})()`);
    await browser.settle();
    const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return h===n||n.contains(h)?{x,y}:null})()`);
    assert.ok(point, `Pointer target reachable: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    await browser.settle();
    await wait("!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))", "target interaction complete");
  }
  const evidence: Array<Record<string, unknown>> = [];
  const field = (name: string) => `[aria-label="任务${name}"]`;
  const value = (name = "指派给") => evaluate(`document.querySelector(${JSON.stringify(field(name))})?.textContent`);
  async function openTask(id: string): Promise<void> {
    await click(`[data-task-id="${id}"] .task-board-card-open`);
    await wait(`document.querySelector('[data-task-id="${id}"]').classList.contains('is-open')`);
    await click(`[data-task-id="${id}"] .task-board-card-detail-open`);
    await wait("!!document.querySelector('[aria-label=派发提示词]') && !!document.querySelector('[aria-label=任务指派给]')");
  }
  async function back(): Promise<void> { await clickText("任务看板"); await wait("!!document.querySelector('[data-task-id=first]')"); }
  async function pick(name: string, title: string): Promise<void> {
    await click(field(name));
    const option = `[data-wand-popup-owner="任务${name}"] [role=option][title="${title}"]`;
    await wait(`!!document.querySelector(${JSON.stringify(option)})`); await click(option);
  }
  try {
    const modes = process.env.WAND_ASSIGNMENT_TEST_MODES?.split(",") ?? ["desktop", "mobile", "native-shell", "rollback", "reduced-motion"];
    for (const mode of modes) {
      const width = mode === "mobile" || mode === "native-shell" ? 390 : 1280;
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: url + (mode === "rollback" ? "?reactUi=0" : "") });
      await wait("!!window.assignment?.releaseDefaults && !!document.querySelector('[data-task-id=first]')");
      await evaluate("localStorage.clear()");
      // Recreate the production host after removing only this isolated browser's preferences.
      await send("Page.reload");
      await wait("!!window.assignment?.releaseDefaults && !!document.querySelector('[data-task-id=first]')");
      if (mode === "native-shell") await evaluate("document.documentElement.classList.add('is-wand-app')");
      await openTask("first");
      await pick("指派给", "Wand Agent");
      assert.equal(await value(), "Wand Agent", `${mode}: SDK target uses provider + engine`);
      await pick("模型", "Fixture model"); await pick("思考深度", "深入"); await pick("工作模式", "托管");
      await click('[aria-label="派发提示词"]'); await send("Input.insertText", { text: "Keep this draft" });
      await evaluate("assignment.promptNode=document.querySelector('[aria-label=派发提示词]');assignment.releaseDefaults();assignment.refresh()");
      await wait("assignment.reads>=2"); await browser.settle();
      assert.equal(await value(), "Wand Agent", `${mode}: polling and late defaults cannot reset explicit choices`);
      assert.equal(await evaluate("document.querySelector('[aria-label=派发提示词]')===assignment.promptNode && assignment.promptNode.value==='Keep this draft'"), true);
      await back(); await openTask("second");
      assert.equal(await value(), "Wand Agent", `${mode}: second assignment reuses the last choice`);
      assert.equal(await value("模型"), "Fixture model"); assert.equal(await value("工作模式"), "托管"); assert.equal(await value("思考深度"), "深入");
      assert.equal(await evaluate("document.querySelector('[aria-label=派发提示词]').value"), "", `${mode}: remembering the target does not copy the previous prompt`);
      await pick("指派给", "员工 · Test employee"); await back(); await openTask("first");
      assert.equal(await value(), "员工 · Test employee", `${mode}: stable employee ID is remembered`);
      await pick("指派给", "团队 · Test team"); await back(); await openTask("second");
      assert.equal(await value(), "团队 · Test team", `${mode}: team ID is remembered independently of CLI config`);
      await send("Page.reload");
      await wait("!!window.assignment?.releaseDefaults && !!document.querySelector('[data-task-id=first]')");
      await evaluate("assignment.releaseDefaults()"); await openTask("second");
      assert.equal(await value(), "团队 · Test team", `${mode}: page reload retains the last assignment`);
      await back(); await openTask("configured");
      assert.equal(await value(), "Wand Agent", `${mode}: task-specific saved config wins over recent team selection`);
      await pick("指派给", "员工 · Test employee");
      await evaluate("assignment.employees=[];assignment.refreshEmployees('employee-test')");
      await wait("document.querySelector('[aria-label=任务指派给]')?.textContent==='Wand Agent'", "removed active employee falls back to the task's saved SDK config");
      await back(); await openTask("first");
      assert.equal(await value(), "Claude", `${mode}: a removed employee does not stay silently selected`);
      assert.deepEqual(await evaluate("assignment.writes"), [], `${mode}: no implicit server defaults or execution`);
      await browser.screenshot(join(output, `${mode}.png`));
      evidence.push({ mode, recentCliModelEffortModeEngine: true, employeeAndTeam: true, pollingAndLateDefaults: true, reload: true, explicitTaskWins: true, removedEmployee: true });
      writeFileSync(join(output, "progress.json"), JSON.stringify(evidence, null, 2));
      console.log(`Assignment browser verified: ${mode}`);
    }
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, evidence, productionComponents: true, isolatedData: true, modelCalls: 0 }, null, 2));
  } catch (error) {
    await browser.screenshot(join(output, "failure.png"));
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: false, evidence, error: String(error), errors: browser.errors, state: await evaluate("({recent:localStorage.getItem('wand.task-board.last-assignment'),fields:[...document.querySelectorAll('.task-board-native-assign button')].map(n=>({label:n.getAttribute('aria-label'),text:n.textContent})),writes:assignment.writes})") }, null, 2));
    throw error;
  } finally {
    await browser.close(); server.close(); rmSync(temp, { recursive: true, force: true });
  }
});
