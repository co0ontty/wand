import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import express from "express";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";

/** F1–F5 only: actual Chrome input, production components/routes and real isolated SQLite. No paid execution. */
test("F1–F5 conversation defect regression in real Chrome", { skip: process.env.WAND_CONVERSATION_FIXES_BROWSER !== "1", timeout: 180_000 }, async t => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-conversation-fixes-"));
  const evidence = join(root, ".wand-team/run_5cc8a794a8ba/fixes-evidence/browser"); mkdirSync(evidence, { recursive: true });
  const h = conversationHarness(t);
  h.storage.saveSiliconEmployee({ ...h.storage.getSiliconEmployee("e_test_1")!, id: "e_wand_default", name: "默认伙伴（明确替身）" });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { ShellSidebar } from "./src/web-ui/react/shell/shell-sidebar";
    import { ShellMainContent } from "./src/web-ui/react/shell/shell-main-content";
    import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
    import { UiStoreProvider } from "./src/web-ui/react/shell/ui-store-react";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { PortalContainerProvider } from "./src/web-ui/react/ui";
    import { ComposerStore } from "./src/web-ui/browser/composer";
    import { configureTeamChatComposerRuntime } from "./src/web-ui/react/ai-teams/composer-bridge";
    import { conversationUi, conversationDraftKey } from "./src/web-ui/react/conversations/state";
    import "./src/web-ui/react/ai-teams/chunk-entry";
    installReactUiStyles();
    const composer = new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>composer.read(id),edit:(id,c)=>composer.edit(id,c),subscribe:f=>composer.subscribe(f),submit:(id,text,f)=>composer.submit(id,text,f),transfer:(a,b,r)=>composer.transfer(a,b,r)});
    let snapshot = {auth:{phase:"authenticated"},viewport:{mobile:innerWidth<640,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},selected:null,
      layout:{sessionsDrawerOpen:innerWidth>=640,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:innerWidth<640,sidebarAnchored:innerWidth>=640,sessionsBackdropVisible:false,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:"chat"},
      sidebar:{interactiveCount:0,totalCount:0,manageMode:false,selectedCount:0,groups:[]},topbar:{title:"Wand",description:"",statusLabel:"",statusTone:"",cwd:"",currentTask:"",titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:false,blank:true,composer:false}};
    const store = new MemoryUiAdapter(snapshot,{batchMs:0});
    store.dispatch=action=>{if(action.type==="layout.drawer.toggle"||action.type==="layout.drawer.close"){const open=action.type==="layout.drawer.toggle"&&!snapshot.layout.sessionsDrawerOpen;snapshot={...snapshot,layout:{...snapshot.layout,sessionsDrawerOpen:open,sessionsBackdropVisible:open&&snapshot.layout.sidebarDrawer}};store.setSnapshot(snapshot);}};
    globalThis.fixture={composer,ui:conversationUi,key:conversationDraftKey};
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider><UiStoreProvider store={store}><div style={{height:"100dvh",display:"flex",minHeight:0}}><ShellSidebar/><ShellMainContent/></div></UiStoreProvider></WandUiProvider></PortalContainerProvider>);
  ` }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  let releaseApproval: (() => void) | null = null, blockApproval = false, rejectApproval = false;
  let releaseGroup: (() => void) | null = null, blockGroup = false;
  const app = express(); app.use(express.json());
  app.use(async (req, res, next) => {
    if (req.method === "POST" && req.path.endsWith("/actions") && req.body.action === "approve") {
      if (rejectApproval) { rejectApproval = false; res.status(400).json({ error: "明确批准拒收替身" }); return; }
      if (blockApproval) await new Promise<void>(resolve => { releaseApproval = resolve; });
    }
    if (blockGroup && req.method === "POST" && req.path === "/api/conversations") await new Promise<void>(resolve => { releaseGroup = resolve; });
    next();
  });
  registerConversationRoutes(app, h.service);
  app.get("/api/silicon-employees", (_req, res) => res.json({ employees: h.storage.listSiliconEmployees({ includeArchived: true }) }));
  app.get("/api/ai-teams", (_req, res) => res.json(h.storage.listAiTeams()));
  app.get("/api/workspaces", (_req, res) => res.json(h.storage.listWorkspaces()));
  for (const path of ["/api/tasks", "/api/ai-team-runs"]) app.get(path, (_req, res) => res.json([]));
  app.get("/api/attention", (_req, res) => res.json({ items: [] })); app.get("/api/*", (_req, res) => res.json({}));
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  for (const file of ["styles.css", "tailwind.css"]) app.get(`/${file}`, (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content", file))));
  app.get("*", (req, res) => res.type("html").send(req.path.includes("aiTeamsChunkSrc") ? "" : `<!doctype html><html class="${req.query.native === "1" ? "is-wand-app" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><div id="overlay-root"><div class="wand-ui-portals" id="portals"></div></div><script src="/app.js"></script></body></html>`));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let socket: WebSocket | null = null; const rows: unknown[] = [], errors: string[] = [], failures: string[] = [];
  try {
    for (let n = 0; n < 120 && !existsSync(join(temp, "profile/DevToolsActivePort")); n++) await pause(50);
    const port = readFileSync(join(temp, "profile/DevToolsActivePort"), "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(tabs.find(row => row.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0; const pending = new Map<number, (value: any) => void>();
    socket.addEventListener("message", event => { const m = JSON.parse(String(event.data)); if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params)); if (pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
    const cdp = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params })); }).then((m: any) => { if (m.error) throw new Error(JSON.stringify(m.error)); return m.result; });
    const evaluate = async (expression: string): Promise<any> => { const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const wait = async (expression: string) => { for (let n = 0; n < 180; n++) { if (await evaluate(expression)) return; await pause(30); } throw new Error(`Timeout: ${expression}`); };
    const node = (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(n=>n.getClientRects().length&&!n.closest('[inert],[hidden],.ant-select-dropdown-hidden')&&getComputedStyle(n).visibility!=='hidden')`;
    const box = (selector: string) => evaluate(`(()=>{const r=${node(selector)}?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null})()`);
    const click = async (selector: string, settle = true) => {
      await evaluate(`(()=>{const n=${node(selector)};n?.scrollIntoView({block:'nearest'});return true})()`);
      if (settle) await pause(280);
      let point: any;
      for (let frame = 0; frame < 20; frame++) {
        point = await evaluate(`(()=>{const n=${node(selector)};if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,hit:h===n||n.contains(h),hitElement:h?.outerHTML.slice(0,200)}})()`);
        if (point?.hit) break;
        await pause(50); // Wait for Ant's actual align/layout, never force a click on hidden geometry.
      }
      assert.ok(point?.hit, `real point hits ${selector}: ${JSON.stringify(point)}`);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    };
    const escape = async () => { for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await pause(50); };
    const selectEmployee = async (owner: string, employee: number) => {
      await click(`#${owner} .ant-select input`);
      await wait(`document.activeElement===document.querySelector(${JSON.stringify(`#${owner} .ant-select input`)})`);
      await cdp("Input.insertText", { text: `员工 ${employee}` });
      await wait(`!!${node(`[data-wand-popup-owner="${owner}"] .ant-select-item-option`)}`);
      await click(`[data-wand-popup-owner="${owner}"] .ant-select-item-option`);
      await escape();
    };
    const openCreate = async () => { await click('[aria-label="对话操作"]'); await click('#conversation-create-panel button'); await wait('document.querySelector("#conversation-create-panel .conversation-group-editor")?.getClientRects().length>0'); };
    const preparePlan = async (id: string) => {
      const receipt = await h.dispatch(id, `批准回归-${randomUUID().slice(0, 6)}`);
      const detail = h.runner.detail(receipt.runId!), step = detail.steps.find(s => s.kind === "leader")!;
      mkdirSync(join(h.cwd, step.reportPath, ".."), { recursive: true });
      writeFileSync(join(h.cwd, step.reportPath), JSON.stringify({ action: "assign", message: "明确替身计划", steps: [{ member: detail.run.team.members[0]!.id, title: "工作", instructions: "只调用明确执行替身" }] }));
      const session = h.sessions.get(step.sessionId!)!; h.sessions.set(session.id, { ...session, structuredState: { ...session.structuredState!, inFlight: false } });
      h.runner.ingest({ type: "status", sessionId: session.id }); await h.runner.idle();
      assert.equal(h.runner.detail(receipt.runId!).run.status, "awaiting_approval");
      await evaluate(`fixture.ui.select(${JSON.stringify(receipt.conversationId)});fixture.ui.target(${JSON.stringify(receipt.conversationId)},{taskId:${JSON.stringify(receipt.taskId)},runId:${JSON.stringify(receipt.runId)}})`);
      await wait('!!document.querySelector("[data-approval-phase=idle]")'); return receipt;
    };
    await cdp("Page.enable"); await cdp("Runtime.enable");
    for (const mode of ["desktop", "mobile-dark", "desktop-reduced", "mobile-native-rollback"]) {
      const mobile = mode.startsWith("mobile"), reduced = mode.includes("reduced") || mode.includes("native");
      await cdp("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode.includes("dark") ? "dark" : "light" }, { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await cdp("Page.navigate", { url: `${origin}/?mode=${mode}${mode.includes("native") ? "&native=1&reactUi=0" : ""}` });
      await wait('!!document.querySelector(".conversation-sender textarea")');
      if (mobile) await click('[aria-label="打开列表"]');
      const groupsBefore = h.storage.listConversations().filter(c => c.kind === "group").length;
      await openCreate(); await selectEmployee("conversation-create-panel", 1);
      const submitBox = await box('#conversation-create-panel .conversation-form-submit');
      await click('#conversation-create-panel .conversation-form-submit');
      await wait('document.querySelector("#conversation-create-panel .conversation-form-submit")?.textContent.includes("已完成")');
      assert.equal(await evaluate('document.querySelector("#conversation-create-panel .conversation-form-submit").disabled'), true);
      assert.deepEqual(await box('#conversation-create-panel .conversation-form-submit'), submitBox);
      await click('#conversation-create-panel .conversation-form-submit', false); // Real disabled second click, not DOM .click().
      await wait('fixture.ui.getSnapshot().selectedId.startsWith("group_")');
      await wait('document.querySelector("#conversation-create-panel").dataset.open==="false"'); await pause(100);
      assert.equal(h.storage.listConversations().filter(c => c.kind === "group").length, groupsBefore + 1);
      const group = await evaluate('fixture.ui.getSnapshot().selectedId');
      assert.equal(await evaluate('document.activeElement===document.querySelector(".conversation-sender textarea")'), !mobile, "F4 success focus only after desktop layout");
      rows.push({ mode, F2: "one accepted group, same box and locked success", F4: !mobile ? "composer focused after layout" : "no automatic composer focus", submitBox });
      await click('.conversation-heading-title');
      await wait('document.querySelector("#conversation-members-panel").dataset.open==="true"');
      assert.equal(await evaluate('document.querySelector(".conversation-heading-title").getAttribute("aria-expanded")'), "true");
      assert.equal(await evaluate('document.querySelector(".conversation-heading-title").getAttribute("aria-controls")'), "conversation-members-panel");
      await escape();
      assert.equal(await evaluate('document.querySelector(".conversation-heading-title").getAttribute("aria-expanded")'), "false");
      assert.equal(await evaluate('document.activeElement===document.querySelector(".conversation-heading-title")'), true, "Escape restores the actual title trigger");
      rows.push({ mode, titleMembersAriaAndFocus: true });
      try {
      await click('.conversation-heading >button[aria-expanded="false"]');
      await wait('document.querySelector("#conversation-members-panel").dataset.open==="true"');
      await click('#conversation-members-panel button[aria-expanded="false"]');
      await wait('document.querySelector("#conversation-invite-panel").dataset.open==="true"');
      await click('#conversation-invite-panel .ant-select input');
      await wait('document.activeElement===document.querySelector("#conversation-invite-panel .ant-select input")');
      await cdp("Input.insertText", { text: "员工 2" });
      await wait(`!!${node('.ant-select-item-option')}`); await click('.ant-select-item-option');
      assert.equal(await evaluate('document.querySelector("#conversation-members-panel").dataset.open'), "true");
      assert.equal(await evaluate('document.querySelector("#conversation-invite-panel").dataset.open'), "true");
      await escape(); assert.equal(await evaluate('document.querySelector("#conversation-invite-panel").dataset.open'), "true", "F3 first Escape closes only employee dropdown, keeping invitation open");
      await escape(); assert.equal(await evaluate('document.querySelector("#conversation-invite-panel").dataset.open'), "false", "F3 second Escape closes invitation");
      assert.equal(await evaluate('document.querySelector("#conversation-members-panel").dataset.open'), "true", "F3 second Escape keeps enclosing members open");
      const sentBeforeOutside = h.sent.length, executionsBeforeOutside = h.executions.length;
      assert.equal(await evaluate('document.querySelector(".conversation-sender textarea").value'), "", "F3 outside target is the empty sender");
      if (mobile) assert.equal(await evaluate('document.querySelector(".conversation-sender textarea").hasAttribute("data-idle-speech")'), true, "F3 mobile outside target has idle speech pointer capture");
      await click('.conversation-sender textarea');
      assert.equal(await evaluate('document.querySelector("#conversation-members-panel").dataset.open'), "false", "F3 pointer outside closes remaining members panel");
      assert.equal(await evaluate('document.activeElement===document.querySelector(".conversation-sender textarea")'), true, "outside point keeps its own focus");
      assert.equal(h.sent.length, sentBeforeOutside, "F3 outside input click does not send a message");
      assert.equal(h.executions.length, executionsBeforeOutside, "F3 outside input click does not start execution");
      rows.push({ mode, F3: "nested search/candidate and layered Escape/outside passed", mobileEmptySenderOutside: mobile, outsideKeptFocus: true, outsideSentMessages: 0 });
      } catch (error) {
        failures.push(`${mode} F3: ${String(error)}`);
        rows.push({ mode, F3: "blocked actual input hit; no second product repair", error: String(error) });
        await click('.conversation-sender textarea');
      }
      assert.equal(h.service.detail(group).tasks.length, 0);
      const shot = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, `${mode}.png`), Buffer.from(shot.data, "base64"));
      rows.push({ mode, darkIsExistingLightBaseline: mode.includes("dark"), noPaidCalls: true });
      if (mode === "desktop") {
        const approval = await preparePlan(group), target = { taskId: approval.taskId!, runId: approval.runId! };
        await evaluate('globalThis.approvalNode=document.querySelector(".conversation-approval");true');
        const approvalBox = await box('.conversation-approval');
        rejectApproval = true; await click('.conversation-approval');
        await wait('document.querySelector("[data-approval-phase=failed]")!==null');
        assert.deepEqual(await box('.conversation-approval'), approvalBox);
        assert.equal(await evaluate('document.querySelector(".conversation-submit-slots").dataset.phase'), "idle");
        assert.equal(h.runner.detail(target.runId).run.status, "awaiting_approval");
        await wait('document.querySelector("[data-approval-phase=idle]")!==null');
        blockApproval = true; await click('.conversation-approval');
        await wait('document.querySelector("[data-approval-phase=sending]")!==null');
        assert.deepEqual(await box('.conversation-approval'), approvalBox);
        assert.equal(await evaluate('approvalNode===document.querySelector(".conversation-approval")'), true);
        assert.equal(await evaluate('document.querySelector(".conversation-submit-slots").dataset.phase'), "idle");
        blockApproval = false; assert.ok(releaseApproval); releaseApproval!();
        await wait('document.querySelector("[data-approval-phase=sent]")!==null');
        assert.equal(await evaluate('approvalNode===document.querySelector(".conversation-approval")'), true);
        await wait('document.querySelector("[data-approval-phase=result]")!==null');
        assert.deepEqual(await box('.conversation-approval'), approvalBox);
        assert.equal(await evaluate('approvalNode===document.querySelector(".conversation-approval")'), true);
        await wait('!document.querySelector(".conversation-approval")');
        rows.push({ F5: "same approval instance and box: rejection, loading, approved, result; send slot idle", approvalBox });
        // F1 UI projects accepted startup failure into the real group and explicitly continues the original task.
        const firstTaskGroup = await h.service.createGroup(randomUUID(), { name: "首次任务启动失败替身", employeeIds: ["e_test_1"] });
        await evaluate(`fixture.ui.select(${JSON.stringify(firstTaskGroup.conversationId)})`);
        await wait('document.querySelector(".conversation-heading-title").textContent.includes("首次任务启动失败替身")');
        await click('.conversation-sender textarea'); await cdp("Input.insertText", { text: "接受后失败原任务" });
        await click('[aria-label="更多聊天操作"]'); await click('#conversation-task-panel button');
        await wait('!!document.activeElement?.closest("#conversation-task-panel") && !document.activeElement.closest("[hidden],[inert]")');
        await click('#conversation-task-panel [aria-label="工作项目"]');
        await wait(`!!${node('[data-wand-popup-owner="conversation-task-panel"] [role="option"]')}`);
        await click('[data-wand-popup-owner="conversation-task-panel"] [role="option"]');
        const relay = h.structured.createRelaySession; h.structured.createRelaySession = () => { throw new Error("明确替身relay启动失败"); };
        const taskCount = h.storage.listWandTasks().length, calls = h.executions.length;
        await click('[aria-label="派发任务"]'); await wait('fixture.ui.getSnapshot().selectedId.startsWith("group_")').catch(async error => {
          console.log("dispatch diagnostics", await evaluate('({selected:fixture.ui.getSnapshot().selectedId,feedback:document.querySelector(".conversation-feedback")?.textContent,phase:document.querySelector(".conversation-submit-slots")?.dataset.phase,project:document.querySelector("[aria-label=工作项目]")?.textContent,input:document.querySelector(".conversation-sender textarea")?.value,disabled:document.querySelector("[aria-label=派发任务]")?.disabled,details:document.querySelector(".conversation-heading-context")?.textContent})'));
          throw error;
        });
        const failedGroup = await evaluate('fixture.ui.getSnapshot().selectedId');
        assert.equal(h.service.detail(failedGroup).tasks[0]?.startup?.state, "failed");
        assert.equal(h.storage.listWandTasks().length, taskCount + 1); assert.equal(h.executions.length, calls);
        assert.equal(await evaluate('document.querySelector(".conversation-sender textarea").value'), "");
        await click('.conversation-task-index button'); await click('.conversation-task-drawer .ant-collapse-header'); await wait('document.querySelector(".conversation-task-details").textContent.includes("明确替身relay启动失败")');
        h.structured.createRelaySession = relay;
        await click('[aria-label="继续任务 接受后失败原任务"]');
        await wait('!!document.activeElement?.closest("#conversation-task-panel") && !document.activeElement.closest("[hidden],[inert]")').catch(async error => {
          rows.push({ F1ContinueFocus: await evaluate('({panelOpen:document.querySelector("#conversation-task-panel")?.dataset.open,activeTag:document.activeElement?.tagName,activeOwner:document.activeElement?.closest("[data-wand-popup-owner]")?.getAttribute("data-wand-popup-owner"),drawerOpen:document.querySelector(".conversation-task-drawer")?.className,controls:Array.from(document.querySelectorAll("#conversation-task-panel input,#conversation-task-panel button")).map(n=>({label:n.getAttribute("aria-label"),disabled:n.disabled,visible:n.checkVisibility()}))})') });
          throw error;
        });
        await click('.conversation-sender textarea');
        assert.equal(await evaluate(`!!document.querySelector('[aria-label="确认继续此任务"]')`), true, "editing task input preserves dispatch mode");
        await click('[aria-label="确认继续此任务"]'); await wait('document.querySelector(".conversation-task-context")?.textContent.includes("接受后失败原任务")');
        await pause(1000); assert.equal(h.storage.listWandTasks().length, taskCount + 1);
        assert.equal(h.service.detail(failedGroup).tasks.length, 1); assert.equal(h.service.detail(failedGroup).tasks[0]?.runs.length, 1);
        rows.push({ F1: "startup failure accepted, original group/task continued, no recreated task", originalGroup: failedGroup });
        // Closing an in-flight creation detaches UI, not the request; later acceptance cannot steal selection/focus.
        blockGroup = true; await openCreate(); await click('#conversation-create-panel .conversation-form-submit');
        await wait('document.querySelector("#conversation-create-panel .conversation-form-submit").textContent.includes("处理中")');
        await click('[aria-label="关闭对话操作"]'); await evaluate('fixture.ui.select("dm_e_test_3")');
        await click('.conversation-sender textarea'); await cdp("Input.insertText", { text: "另一对象的新输入" });
        blockGroup = false; assert.ok(releaseGroup); releaseGroup!(); await pause(1000);
        assert.equal(await evaluate('fixture.ui.getSnapshot().selectedId'), "dm_e_test_3");
        assert.equal(await evaluate('document.querySelector(".conversation-sender textarea").value'), "另一对象的新输入");
        rows.push({ F2F4: "detached late creation preserved fact without navigation/focus theft" });
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, [], "Remaining confirmed nested invitation hit boundary; do not claim full browser pass");
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, rows, errors, scope: "Chrome/source UI + isolated real SQLite/API/execution doubles; not installed UI or Android device proof" }, null, 2));
  } catch (error) {
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, rows, errors, failures, error: String(error) }, null, 2)); throw error;
  } finally { socket?.close(); const exited = once(chrome, "exit"); chrome.kill(); await exited; server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); }
});
