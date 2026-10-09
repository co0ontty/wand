import { cssEvidenceCapture } from "./helpers/antd-css-evidence.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { createHash } from "node:crypto";

test("Ant sidebar production components retain projection, library interactions and stable legacy hosts", { timeout: 420_000, skip: process.env.WAND_SIDEBAR_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-antd-sidebar-"));
  const artifact = join(root, process.env.WAND_SIDEBAR_ARTIFACT ?? "output/web-ui-library-migration/sidebar");
  const visualOnly = process.env.WAND_SIDEBAR_VISUAL_ONLY === "1";
  const artifactName = visualOnly ? "sidebar-visual-browser.json" : "sidebar-browser.json";
  const browserErrors: string[] = [];
  const clickLog: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const source = `import * as React from "react";
import { createRoot } from "react-dom/client";
import { ShellApp } from "./src/web-ui/react/shell/shell-app";
import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
import { WorkspacesHost } from "./src/web-ui/react/workspaces/host";
import { workspacesController, configureWorkspacesRuntime } from "./src/web-ui/react/workspaces/controller";
import { conversationUi } from "./src/web-ui/react/conversations/state";
import { NewSessionHost } from "./src/web-ui/react/new-session/host";
import { employeeProfile } from "./src/web-ui/react/agents/employee-profile";
import { configureNewSessionRuntime } from "./src/web-ui/react/new-session/controller";
// SessionPane validates vendor readiness before calling the mock terminal runtime below.
// The runtime owns fixture DOM; these markers satisfy the canonical loader contract only.
globalThis.XTermLib = { Terminal: class FixtureTerminal {}, FitAddon: class FixtureFitAddon {} };
conversationUi.mode("tasks"); conversationUi.suspend();
configureNewSessionRuntime({onOpen(){},onClose(){},getContext(){return {effectiveCwd:"/workspace/wand"};},rememberModel(){},prepareCreate:async()=>({}),completeCreate:async()=>{}});
import { UnifiedExecutionSubjectPicker } from "./src/web-ui/react/workspaces/unified-execution-subject-picker";
import { WandUiProvider } from "./src/web-ui/react/theme";
import { installReactUiStyles } from "./src/web-ui/react/styles";
import { setActiveWorkspaceContext, clearActiveWorkspaceContext } from "./src/web-ui/react/workspaces/workspace-context";
import { WandButton, WandDialog, WandDialogSurface } from "./src/web-ui/react/ui";
import { Alert } from "antd";
import { overlayStore } from "./src/web-ui/react/overlay-controller";
installReactUiStyles();
const mobile = new URL(location.href).searchParams.has("mobile");
const session = {id:"s1", source:"wand", provider:"codex", kind:"structured", title:"库迁移会话", description:"真实投影", cwd:"/workspace/wand", status:"idle", statusLabel:"空闲", active:true, selected:false, resumable:true, permissionBlocked:false, inFlight:false, turnActive:false, titleGenerating:false, startedAt:"2026-07-16T08:00:00Z", workspaceId:"ws", workspaceTaskId:"t1"};
let snapshot = { auth:{phase:"authenticated"}, viewport:{mobile,online:true,embedTerminal:false,nativeInput:false}, capabilities:{backToNative:true,switchServer:true}, layout:{sessionsDrawerOpen:true,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:mobile,sidebarAnchored:!mobile,sessionsBackdropVisible:mobile,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:"chat"}, selected:session, sidebar:{interactiveCount:1,totalCount:1,manageMode:false,selectedCount:0,groups:[{kind:"wand",label:"Wand 会话",expanded:true,entries:[session]},{kind:"history",label:"本机记录",expanded:true,entries:[{...session,id:"native:42",source:"codex-history",title:"本机 Codex 记录",active:false,workspaceId:undefined,workspaceTaskId:undefined}]}]}, topbar:{title:session.title,description:session.description,statusLabel:"空闲",statusTone:"idle",cwd:session.cwd,currentTask:"",titleGenerating:false,git:null}, legacyVisibility:{terminal:false,chat:true,blank:false,composer:true} };
const memory = new MemoryUiAdapter(snapshot);
window.sidebar = {overlay:()=>overlayStore.getSnapshot(),memory, selections:[], mutations:[], worktreeRequests:[], layoutSaves:[], terminalMounts:[], terminalScales:new Map(),terminalNodes:new Map(),terminalDisposals:[],disposeAllCalls:0,closeSplit:clearActiveWorkspaceContext, update:(layout)=>{snapshot={...snapshot,layout:{...snapshot.layout,...layout,sessionsBackdropVisible:mobile ? (layout.sessionsDrawerOpen ?? snapshot.layout.sessionsDrawerOpen) : false}};memory.setSnapshot(snapshot,{sync:true});}, openSplit:(dir)=>setActiveWorkspaceContext({workspaceId:"ws",workspaceName:"生产目录",taskId:"t1",taskName:"组件迁移任务",cwd:"/workspace/wand",layout:{type:"windows",activeWindowId:"split",windows:[{id:"split",activeTabId:"tab-s1",layout:{type:"split",dir,ratio:0.5,children:[{type:"pane",active:0,tabs:[{id:"tab-s1",kind:"session",sessionId:"s1"}]},{type:"pane",active:0,tabs:[{id:"tab-s2",kind:"session",sessionId:"s2"}]}]}}]}})};
window.sidebar.setCwd = cwd => {snapshot={...snapshot,topbar:{...snapshot.topbar,cwd}};memory.setSnapshot(snapshot,{sync:true});};
const store = { getSnapshot:()=>memory.getSnapshot(),subscribe:(cb)=>memory.subscribe(cb),dispatch:(action)=>{
  memory.dispatch(action);
  if(action.type==="workspace.new")workspacesController.open();
  if(action.type==="layout.drawer.close")sidebar.update({sessionsDrawerOpen:false});
  if(action.type==="layout.files.toggle")sidebar.update({filePanelOpen:!snapshot.layout.filePanelOpen,filePanelBackdropVisible:mobile&&!snapshot.layout.filePanelOpen});
  if(action.type==="layout.files.close")sidebar.update({filePanelOpen:false,filePanelBackdropVisible:false});
  if(action.type==="layout.drawer.toggle")sidebar.update({sessionsDrawerOpen:!snapshot.layout.sessionsDrawerOpen});
  if(action.type==="layout.drawer.collapse")sidebar.update({sidebarCollapsed:!snapshot.layout.sidebarCollapsed});
  if(action.type==="topbar.menu.toggle")sidebar.update({topbarMoreOpen:!snapshot.layout.topbarMoreOpen});
}};
configureWorkspacesRuntime({effectiveCwd(){return "/workspace/wand";},onOpen(){},onClose(){},modelPreference(){return "";},rememberModelPreference(){},toast(){},selectSession(id){sidebar.selections.push(id);},openTask(payload){setActiveWorkspaceContext({...payload,layout:null});},openWorkspace(){},closeWorkspace(){clearActiveWorkspaceContext();},refreshSessions:async()=>{},saveTaskLayout(layout){sidebar.layoutSaves.push(layout);setActiveWorkspaceContext({layout});},mountSessionTerminal(id,node){sidebar.terminalMounts.push(id);node.dataset.sessionId=id;let terminal=sidebar.terminalNodes.get(id);if(!terminal){terminal=document.createElement('div');terminal.dataset.poolTerminal=id;sidebar.terminalNodes.set(id,terminal);}node.append(terminal);return true;},unmountSessionTerminal(id){sidebar.terminalDisposals.push(id);sidebar.terminalNodes.get(id)?.remove();sidebar.terminalNodes.delete(id);sidebar.terminalScales.delete(id);},disposeAllSessionTerminals(){sidebar.disposeAllCalls++;sidebar.terminalNodes.forEach(node=>node.remove());sidebar.terminalNodes.clear();sidebar.terminalScales.clear();},getSessionTerminalScale(id){return sidebar.terminalScales.get(id)??1;},setSessionTerminalScale(id,scale){sidebar.terminalScales.set(id,scale);return scale;},closeTaskSessions:async()=>false,startWorktreeMergeAgent:async(payload)=>{sidebar.worktreeRequests.push(payload);throw Error("合并启动本地拒收");}});
function DraftDialog(){const state=React.useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot,overlayStore.getSnapshot);const dialog=state.activeDialog;return dialog ? <WandDialog open {...dialog.options} onAction={(action,inputValue)=>overlayStore.completeDialog(dialog.id,{dismissed:false,action,inputValue})} onDismiss={()=>overlayStore.completeDialog(dialog.id,{dismissed:true})}/> : null;}
function WindowPicker({open,onDismiss}){const [subject,setSubject]=React.useState({type:"cli",id:"codex",engine:"cli"});const [kind,setKind]=React.useState("structured");const [model,setModel]=React.useState("default");const [error,setError]=React.useState("");return <WandDialogSurface open={open} onOpenChange={(next)=>{if(!next)onDismiss();}} title="新建工作窗口" className="wand-task-library-dialog wand-workspace-agent-modal" closeLabel="关闭工作窗口选择" testId="workspace-agent-dialog" dismissable><form className="wand-ui-dialog-content" onSubmit={async(event)=>{event.preventDefault();try{sidebar.mutations.push([subject.id,kind,model==="default"?"":model]);throw Error("本地拒收，保留选择");}catch(cause){setError(String(cause.message));}}}><UnifiedExecutionSubjectPicker selectedSubject={subject} kind={kind} model={model} teams={null} teamWorkspaceId="" onSubjectChange={setSubject} onKindChange={setKind} onModelChange={setModel}/>{error?<Alert type="error" showIcon role="alert" title={error}/>:null}<button type="submit">创建</button></form></WandDialogSurface>;}
function Fixture(){const [agent,setAgent]=React.useState(false);return <><ShellApp store={store}/><WandUiProvider><WorkspacesHost/><NewSessionHost/><DraftDialog/><WandButton id="fixture-profile" onClick={event=>employeeProfile.open({id:"employee:real",name:"真实员工"},event.currentTarget)}>员工资料</WandButton><WandButton id="fixture-agent" onClick={()=>setAgent(true)}>窗口选择器</WandButton><WindowPicker open={agent} onDismiss={()=>setAgent(false)}/></WandUiProvider></>;}
createRoot(document.getElementById("root")).render(<Fixture/>);
`;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temporary, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const sourceBundleSha256 = createHash("sha256").update(readFileSync(join(temporary, "app.js"))).digest("hex");
  const globalCssSha256 = createHash("sha256").update(readFileSync(join(root, "src/web-ui/content/styles.css"))).digest("hex");
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) {
      const session = { id: "s1", provider: "codex", kind: "structured", title: "库迁移会话", status: "idle", cwd: "/workspace/wand", employeeId: "employee:real", startedAt: "2026-07-16T08:00:00Z" };
      const task = { id: "t1", workspaceId: "ws", name: "组件迁移任务", cwd: "/workspace/wand", createdAt: "2026-07-16T08:00:00Z", sessions: [session, { ...session, id: "s2", title: "第二工作窗口", provider: "pi" }], status: "active", worktree: {branch:"branch/t1", path:"/workspace/worktree", baseRef:"main"} };
      const group = { workspaceId: "ws", workspaceName: "生产目录", workspaceCwd: "/workspace/wand", tasks: [task], standaloneSessions: [] };
      const url = new URL(request.url, "http://local");
      const payload = url.pathname === "/api/tasks" ? { groups: [group] }
        : url.pathname === "/api/workspace-tasks/t1" ? task
        : url.pathname === "/api/workspaces/ws/worktrees" ? { workspaceId:"ws", repoRoot:"/workspace/wand", targetBranch:"main", worktrees:[
          {taskId:"t1",taskName:"组件迁移任务",taskStatus:"active",branch:"branch/t1",path:"/workspace/worktree",baseRef:"main",state:"ready",actionable:true,reason:"",aheadCount:1,hasUncommittedChanges:false,hasConflicts:false,commits:[]},
          {taskId:"t2",taskName:"另一任务",taskStatus:"active",branch:"branch/t2",path:"/workspace/worktree2",baseRef:"main",state:"dirty",actionable:true,reason:"",aheadCount:0,hasUncommittedChanges:true,hasConflicts:false,commits:[]},
          {taskId:"t3",taskName:"已同步任务",taskStatus:"active",branch:"branch/t3",path:"/workspace/worktree3",baseRef:"main",state:"empty",actionable:false,reason:"已同步",aheadCount:0,hasUncommittedChanges:false,hasConflicts:false,commits:[]},
        ] }
        : url.pathname === "/api/silicon-employees" ? { employees: [{ id: "employee:real", name: "真实员工", duty: "保留稳定身份", agents: [{provider:"codex"}], prompt: "", avatar: "" }] }
        : url.pathname === "/api/silicon-employees/employee%3Areal" ? { id:"employee:real",name:"真实员工",duty:"保留稳定身份",agents:[{provider:"codex"}],prompt:"",avatar:"",tags:[] }
        : url.pathname === "/api/attention" ? { items: [{ id:"attention:real",title:"会话需要处理",detail:"保留真实会话绑定",sessionId:"s1" }] }
        : url.pathname === "/api/config" ? { defaultProvider: "codex", defaultSessionKind: "structured", defaultTaskWorktree: false }
        : url.pathname === "/api/recent-paths" ? [{ path: "/workspace/wand", name: "生产目录" }]
        : url.pathname === "/api/path-suggestions" ? [{path:"/workspace/other",name:"另一真实目录"}]
        : url.pathname === "/api/conversations" ? { conversations: [] }
        : url.pathname === "/api/ai-team-runs" ? { runs: [] }
        : url.pathname === "/api/models" ? { codex: [{ id: "model:real", name: "真实模型" }] }
        : url.pathname === "/api/ai-teams" ? [] : {};
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/api/config") setTimeout(() => response.end(JSON.stringify(payload)), 1200);
      else response.end(JSON.stringify(payload));
    } else if (request.url === "/app.js") { response.setHeader("content-type", "application/javascript"); response.end(readFileSync(join(temporary, "app.js"))); }
    else if (request.url === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else if (request.url === "/tailwind.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/tailwind.css"))); }
    else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>#root{height:100vh}#fixture-agent{position:fixed;bottom:16px;right:16px;z-index:1000}#fixture-profile{position:fixed;bottom:16px;right:160px;z-index:1000}</style></head><body><div id="app" data-react-shell="enabled"><div id="root"></div></div><div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temporary}/profile`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  let diagnosticEvaluate: ((expression: string) => Promise<any>) | undefined;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const portFile = join(temporary, "profile/DevToolsActivePort");
    for (let attempt = 0; attempt < 120 && !existsSync(portFile); attempt++) await pause(50);
    assert.ok(existsSync(portFile), "Chrome debugging endpoint available");
    const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
    let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
    for (let attempt = 0; attempt < 80 && !targets.some(target => target.type === "page"); attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
        if (response.ok) targets = await response.json() as typeof targets;
      } catch { /* Chrome can publish its port before the page endpoint is ready. */ }
      if (!targets.some(target => target.type === "page")) await pause(30);
    }
    assert.ok(targets.some(target => target.type === "page"), "Chrome page endpoint available");
    socket = new WebSocket(targets.find(target => target.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params.exceptionDetails));
      const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
      message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    const captureCss = cssEvidenceCapture("sidebar");
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      await captureCss(send);
      return result.result.value;
    };
    diagnosticEvaluate = evaluate;
    // Feature lanes share this machine, so the budget tolerates a loaded browser rather than
    // turning slow frames into failures.
    const wait = async (expression: string): Promise<void> => {
      for (let attempt = 0; attempt < 300; attempt++) { if (await evaluate(expression)) return; await pause(40); }
      throw new Error(`Timed out: ${expression}; browserErrors=${JSON.stringify(browserErrors)}; ${await evaluate("JSON.stringify({text:document.body.innerText,visibility:document.visibilityState,active:document.activeElement?.outerHTML.slice(0,600),overlay:sidebar.overlay(),profile:Array.from(document.querySelectorAll('#object-profile-panel,[aria-label=\"关闭资料面板\"]')).map(n=>{let r=n.getBoundingClientRect();return {class:n.className,rect:r.toJSON(),visibility:getComputedStyle(n).visibility,transform:getComputedStyle(n).transform,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500)}}),popups:Array.from(document.querySelectorAll('.ant-dropdown')).map(n=>({class:n.className,css:getComputedStyle(n).cssText,transform:getComputedStyle(n).transform,animation:getComputedStyle(n).animation,rect:n.getBoundingClientRect().toJSON(),inner:n.querySelector('input')?.getBoundingClientRect().toJSON(),hit:(()=>{let r=n.querySelector('input')?.getBoundingClientRect();return r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500)})()}))})")}`);
    };
    const clickRetries: string[] = [];
    let currentMode = "";
    // Synthetic clicks are recorded so a failure can prove whether the browser delivered them.
    const dispatchClick = async (selector: string): Promise<{ matched: boolean; target: string }> => {
      const spot = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing target');if(!n.closest('.ant-dropdown,.ant-popover,.sidebar-peek'))n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(n!==hit&&!n.contains(hit))throw Error('Target obstructed: '+${JSON.stringify(selector)}+' hit '+hit?.outerHTML.slice(0,400)+' target '+n.outerHTML+' rect '+JSON.stringify(r.toJSON()));return{x,y}})()`);
      await evaluate("window.__sidebarLastClickTarget = null; window.__sidebarLastClickControl = null; true");
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...spot });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...spot, button: "left", buttons: 1, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...spot, button: "left", buttons: 0, clickCount: 1 });
      await pause(40);
      // A click that landed on a container of the control (a menu list, a dialog body) cannot have
      // run that control's action, so it may be re-issued. A press on the modal wrap is an outside
      // press with its own consequences and is never retried.
      const record = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const target=window.__sidebarLastClickTarget,control=window.__sidebarLastClickControl;if(!(target instanceof Element))return {target:"none",matched:false,wrapper:false};const html=String(target.outerHTML).slice(0,200);if(!n)return {target:html,matched:true,wrapper:false};const gate=n.closest('label,button,[role=tab],[role=menuitem],[role=radio],[role=checkbox],.ant-segmented-item,.ant-menu-item,.ant-tabs-tab,.ant-select-selector')||n;return {target:html,matched:target===n||n.contains(target)||target===gate||gate.contains(target)||control===gate,wrapper:target.contains(n)&&target.closest('.ant-modal-wrap,.ant-modal-mask,.ant-modal-root')===null}})()`);
      clickLog.push({ selector, ...record });
      return record;
    };
    const click = async (selector: string): Promise<void> => {
      // While a library surface runs its entry motion the modal is still scaling, so a press
      // measured now can land on the wrapping element instead of the control.
      await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;if(n.closest('.ant-zoom-appear,.ant-zoom-enter,.ant-zoom-leave,.ant-fade-appear,.ant-fade-enter'))return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden'})()`);
      await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(n&&!n.closest('.ant-dropdown,.ant-popover,.sidebar-peek'))n.scrollIntoView({block:'center',behavior:'instant'});return true})()`);
      // Hovering first matches a real pointer and reveals controls that stay inert until their row
      // is hovered; the 260ms pause also lets a just-opened library surface finish moving.
      const hoverPoint = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...hoverPoint });
      await pause(260);
      await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(n===hit||n.contains(hit))})()`);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const record = await dispatchClick(selector);
        if (record.matched) return;
        if (!record.wrapper) throw new Error(`Click at ${selector} landed on ${record.target}`);
        clickRetries.push(`${currentMode}:${selector}:wrapper`);
      }
      throw new Error(`Click never reached ${selector}`);
    };
    // A dropped or mis-landed synthetic click must not fail a toggle whose expected on-state is
    // unambiguous; every other step keeps a single click so a real defect cannot be retried away.
    const rightClick = async (selector: string): Promise<void> => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
      await pause(260);
      const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "right", buttons: 2, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "right", buttons: 0, clickCount: 1 });
      clickLog.push({ selector, contextMenu: true });
    };
    const clickUntil = async (selector: string, predicate: string, label: string): Promise<void> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await click(selector);
        if (await evaluate(predicate)) return;
        clickRetries.push(`${currentMode}:${label}`);
      }
      throw new Error(`Clicking ${selector} never produced ${label}`);
    };
    const key = async (key: string): Promise<void> => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: ({ Escape:27, Enter:13, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Tab:9, Home:36, End:35 } as Record<string, number>)[key] ?? 0 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
    };
    await send("Page.enable"); await send("Runtime.enable");
    for (const mode of process.env.WAND_SIDEBAR_TEST_MODES?.split(",") ?? ["desktop", "mobile", "native", "rollback", "reduced-motion"]) {
      currentMode = mode;
      const retriesBefore = clickRetries.length;
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "mobile" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", { url: `${origin}/?${mode === "rollback" ? "reactUi=0" : mode === "mobile" ? "mobile=1" : ""}` });
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'");
      await send("Page.bringToFront");
      await wait("!!window.sidebar && !!document.querySelector('[data-workspace-task-id=t1]')");
      await evaluate("document.addEventListener('click', event => { window.__sidebarLastClickTarget = event.target; window.__sidebarLastClickControl = event.target.closest?.('label,button,[role=tab],[role=menuitem],[role=radio],[role=checkbox],.ant-segmented-item,.ant-menu-item,.ant-tabs-tab,.ant-select-selector'); }, { capture: true }); true");
      if (mode === "native") await evaluate("document.documentElement.classList.add('is-wand-app','is-wand-ios')");
      await evaluate("sidebar.slots=Array.from(document.querySelectorAll('#output,#chat-output,.input-panel,#file-explorer'));true");
      if (visualOnly) {
        const heading = await evaluate("(()=>{const n=document.querySelector('.sidebar-title'),r=n.getBoundingClientRect();return {text:n.textContent,rect:r.toJSON()}})()");
        assert.equal(heading.text, "Wand");
        assert.ok(heading.rect.height > 0 && heading.rect.height < 32, `${mode}: sidebar title remains one line`);
        await evaluate("sidebar.openSplit('v');true");
        await wait("document.querySelectorAll('.ws-session-pane').length===2 && document.querySelectorAll('.ws-pane-title').length===2");
        await pause(350);
        mkdirSync(artifact, { recursive: true });
        const surface = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(artifact, `sidebar-${mode}.png`), Buffer.from(surface.data, "base64"));
        if (mode === "mobile") { await click('#close-drawer-button'); await wait("!sidebar.memory.getSnapshot().layout.sessionsDrawerOpen"); await pause(350); }
        const panes = await evaluate("Array.from(document.querySelectorAll('.ws-pane-toolbar')).map(n=>{const title=n.querySelector('.ws-pane-title'),logo=n.querySelector('.ws-pane-logo'),t=title.getBoundingClientRect(),l=logo.getBoundingClientRect();return {title:t.toJSON(),logo:l.toJSON(),scroll:n.scrollWidth,client:n.clientWidth}})");
        assert.ok(panes.every((pane: any) => pane.title.width > 0 && pane.scroll <= pane.client + 1), `${mode}: narrow pane toolbar keeps the title visible without horizontal overflow`);
        assert.ok(panes.every((pane: any) => Math.abs((pane.title.y+pane.title.height/2)-(pane.logo.y+pane.logo.height/2))<3), `${mode}: provider and pane title share one line`);
        assert.equal(await evaluate("sidebar.slots.every(node=>node.isConnected)"), true);
        const window = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(artifact, `splitter-${mode}.png`), Buffer.from(window.data, "base64"));
        evidence.push({mode,sourceBundleSha256,globalCssSha256,heading,panes,interactions:["latest source sidebar heading stays one line","provider and pane title stay aligned","mobile Drawer real close","stable legacy roots"]});
        console.log(`Sidebar visual browser passed: ${mode}`);
        continue;
      }
      await click('[data-claude-history-id="native:42"] .wand-sidebar-history-action');
      assert.equal(await evaluate("sidebar.memory.actionLog.some(action=>action.type==='session.resumeHistory'&&action.id==='native:42'&&action.provider==='codex')"), true, `${mode}: native history resume identity`);
      if (mode === "mobile") await click('#sessions-toggle-button');
      await click('#drawer-new-session-button');
      await wait("!!document.querySelector('#wand-new-session-cwd')");
      assert.equal(await evaluate("document.querySelector('#wand-new-session-cwd').classList.contains('ant-input')"), true, `${mode}: unified session form uses library Input`);
      await click('#wand-new-session-cwd');
      await send("Input.insertText", { text: "/other" });
      await wait("!!document.querySelector('.ant-select-dropdown .ant-select-item-option')");
      await key("ArrowDown"); await key("Enter");
      await wait("document.querySelector('#wand-new-session-cwd').value==='/workspace/other'");
      assert.equal(await evaluate("!!document.querySelector('[data-testid=new-session-dialog]')"), true, `${mode}: directory suggestion selection keeps canonical dialog`);
      await click('[aria-label="关闭新建会话"]');
      await wait("!document.querySelector('[data-testid=new-session-dialog]')");
      if (mode === "mobile") await click('#sessions-toggle-button');
      if (mode === "mobile") await click('#close-drawer-button');
      await click('#fixture-profile');
      await wait("document.querySelector('#object-profile-panel').classList.contains('open')");
      await click('[aria-label="关闭资料面板"]');
      await wait("document.activeElement.matches('#fixture-profile')");
      await click('#fixture-profile');
      await key("Escape");
      await wait("!document.querySelector('#object-profile-panel').classList.contains('open') && document.activeElement.matches('#fixture-profile')");
      await click('#topbar-file-button');
      await click('#file-explorer-cwd');
      await send("Input.insertText", {text:"/workspace/other"});
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));true");
      assert.equal(await evaluate("document.activeElement.id==='file-explorer-cwd'"), true, `${mode}: path input IME keeps focus`);
      await key("Escape");
      assert.equal(await evaluate("document.activeElement.id==='file-explorer-cwd' && document.activeElement.value==='/workspace/wand'"), true, `${mode}: Esc cancels path edit without closing the drawer`);
      await wait("document.activeElement.selectionStart===0 && document.activeElement.selectionEnd===document.activeElement.value.length");
      await send("Input.insertText", {text:"/workspace/after-escape"});
      await evaluate("window.sidebar.setCwd('/workspace/background-update')");
      assert.equal(await evaluate("document.querySelector('#file-explorer-cwd').value"), "/workspace/after-escape", `${mode}: continuing after Esc protects the focused path draft from snapshot refresh`);
      await key("Enter");
      await wait("document.activeElement.id!=='file-explorer-cwd'");
      await click('#file-side-panel-close');
      await wait("document.activeElement.id==='topbar-file-button'");
      if (mode === "mobile") await click('#sessions-toggle-button');
      await click('[aria-label="搜索任务或会话"]');

      await wait("document.querySelector('input[aria-label=\"搜索工作区、任务或会话\"]')===document.activeElement");
      await send("Input.insertText", { text: "组件迁移任务" });
      await wait("document.querySelector('input[aria-label=\"搜索工作区、任务或会话\"]').value==='组件迁移任务'");
      assert.equal(await evaluate("!!document.querySelector('[data-workspace-task-id=t1]')"), true, `${mode}: actual task projection`);
      await key("Escape");
      await wait("document.querySelector('[aria-label=\"搜索任务或会话\"]')===document.activeElement");
      // The old employee popover was replaced by root navigation; employee choice is verified below.
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.conversation-navigation .sidebar-nav-label')).map(n=>n.textContent).join(',')"), "对话,工作区,任务,团队,通讯录", `${mode}: current root navigation retains the directory entry`);
      await click('[data-sidebar-tree-directory-id="ws"] .workspace-row-main');
      await wait("document.querySelector('[data-sidebar-tree-directory-id=ws] .workspace-row-main').getAttribute('aria-expanded')==='false'");
      await key("ArrowRight");
      await wait("document.querySelector('[data-sidebar-tree-directory-id=ws] .workspace-row-main').getAttribute('aria-expanded')==='true'");
      await click('[data-workspace-task-id="t1"] .workspace-task-chevron-btn');
      await key("ArrowRight");
      await wait("document.querySelector('[aria-label=\"收起任务 组件迁移任务 的会话\"]').getAttribute('aria-expanded')==='true'");
      await rightClick('[data-workspace-task-id="t1"] .workspace-task');
      await wait("!!document.querySelector('.workspace-task-menu .ant-dropdown-menu')");
      await key("Escape");
      await wait("!document.querySelector('.workspace-task-menu .ant-dropdown-menu')");
      assert.equal(await evaluate("document.activeElement.matches('[data-workspace-task-id=t1] .workspace-task-main')"), true, `${mode}: task context menu focus`);
      await rightClick('[data-sidebar-tree-directory-id="ws"] .workspace-row');
      await wait("!!document.querySelector('.workspace-directory-menu .ant-dropdown-menu')");
      await evaluate("Array.from(document.querySelectorAll('.workspace-directory-menu .ant-dropdown-menu-item')).find(n=>n.textContent.includes('合并 Worktree')).id='fixture-merge-worktrees';true");
      await click('#fixture-merge-worktrees');
      await wait("document.querySelectorAll('[data-testid=workspace-worktree-dialog] .ant-checkbox-input').length===3");
      await clickUntil('[data-testid="workspace-worktree-dialog"] .ant-checkbox-input:first-of-type',
        "document.querySelector('[data-testid=workspace-worktree-dialog] .ant-checkbox-input').checked === true", "worktree selection");
      assert.equal(await evaluate("document.querySelector('[data-testid=workspace-worktree-dialog] .ant-checkbox-input').checked"), true, `${mode}: worktree selection identity`);
      assert.equal(await evaluate("document.querySelectorAll('[data-testid=workspace-worktree-dialog] .ant-checkbox-input')[2].disabled"), true, `${mode}: unavailable worktree stays disabled`);
      await click('[data-testid="workspace-worktree-dialog"] [data-slot="worktree-footer"] .ant-btn-primary');
      await wait("sidebar.worktreeRequests.length===1 && document.querySelector('[data-testid=workspace-worktree-dialog] .ant-alert-error')?.textContent.includes('本地拒收')");
      assert.equal(await evaluate("document.querySelector('[data-testid=workspace-worktree-dialog] .ant-checkbox-input').checked"), true, `${mode}: worktree failure retains selection`);
      await key("Escape");
      await wait("!document.querySelector('[data-testid=workspace-worktree-dialog]')");
      await click('[aria-label="会话列表选项"]');
      await wait("Array.from(document.querySelectorAll('.ant-menu-item')).some(n=>n.textContent==='批量管理')");
      await evaluate("Array.from(document.querySelectorAll('.ant-menu-item')).find(n=>n.textContent==='批量管理').id='fixture-manage';true");
      await click('#fixture-manage');
      await wait("!!document.querySelector('.wand-workspace-manage-check .ant-checkbox')");
      await click('[data-workspace-task-id="t1"] .workspace-task-main');
      assert.equal(await evaluate("document.querySelector('[data-workspace-task-id=t1] .ant-checkbox-input').checked"), true, `${mode}: controlled bulk selection`);
      await click('.sidebar-manage-bar .sidebar-manage-action:last-child');
      await wait("!!document.querySelector('[aria-label=\"会话列表选项\"]')");
      if (mode !== "mobile") {
        await click('[aria-label="收起为窄栏"]');
        await wait("document.querySelector('#sessions-drawer').classList.contains('collapsed')");
        await pause(400);
        const point = await evaluate("(()=>{const r=document.querySelector('[data-sidebar-directory-id=ws]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
        await send("Input.dispatchMouseEvent", {type:"mouseMoved", ...point});
        await wait("document.querySelector('#sidebar-peek')?.dataset.open==='true'");
        await rightClick('#sidebar-peek .workspace-task');
        await wait("!!document.querySelector('.workspace-task-menu .ant-dropdown-menu')");
        await evaluate("Array.from(document.querySelectorAll('.workspace-task-menu .ant-dropdown-menu-item')).find(n=>n.textContent.includes('重命名任务')).id='fixture-rename-task';true");
        await click('#fixture-rename-task');
        await wait("document.querySelector('#sidebar-peek input[aria-label=\"重命名任务 组件迁移任务\"]')===document.activeElement");
        assert.equal(await evaluate("document.querySelector('#sidebar-peek').dataset.open==='true'"), true, `${mode}: only the peek's own menu is inside`);
        await key("Escape");
        await wait("document.activeElement.matches('#sidebar-peek .workspace-task-main')");
        await key("Escape");
        await wait("document.querySelector('#sidebar-peek').dataset.open!=='true'");
        await click('[aria-label="展开完整侧边栏"]');
        await wait("!document.querySelector('#sessions-drawer').classList.contains('collapsed')");
      }
      await click('[data-workspace-task-id="t1"] .workspace-task-main');
      await wait("document.querySelectorAll('.wand-workspace-tabs [role=tab]').length===2");
      await click('.wand-workspace-tabs .ant-tabs-tab:first-child [role=tab]');
      await key("ArrowRight");
      await key("Enter");
      await wait("sidebar.memory.actionLog.some(action=>action.type==='session.select'&&action.id==='s2')");
      if (mode === "mobile") {
        await click('.workspace-tab-more');
        await wait("Array.from(document.querySelectorAll('[role=menuitem]')).some(n=>n.textContent==='新建 Agent 或空白终端')");
        await evaluate("Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='新建 Agent 或空白终端').id='fixture-mobile-create';true");
        await click('#fixture-mobile-create');
      } else await click('.workspace-tab-add');
      await wait("!!document.querySelector('[data-testid=new-session-dialog]')");
      await key("Escape");
      await wait("!document.querySelector('[data-testid=new-session-dialog]')");
      if (mode === "mobile") await click('[aria-label="打开任务"]');
      await click('#settings-button');
      await wait("!!document.querySelector('.sidebar-tools-menu .ant-dropdown-menu')");
      await key("Escape");
      await wait("document.activeElement.id==='settings-button'");
      await click('#back-to-native-button');
      assert.equal(await evaluate("sidebar.memory.actionLog.some(action=>action.type==='native.back')"), true, `${mode}: native back action`);
      assert.equal(await evaluate("sidebar.slots.length===4 && sidebar.slots.every(node=>node.isConnected)"), true, `${mode}: stable legacy nodes`);
      if (mode === "mobile") await wait("!sidebar.memory.getSnapshot().layout.sessionsDrawerOpen");
      await click('#fixture-agent');
      await wait("!!document.querySelector('[data-testid=workspace-agent-dialog] .ant-radio-group')");
      await clickUntil('[data-testid="workspace-agent-dialog"] input[value="employee:employee:real"]',
        "document.querySelector('[data-testid=workspace-agent-dialog] input[value=\"employee:employee:real\"]').checked === true", "employee radio");
      await pause(1300);
      assert.equal(await evaluate("document.querySelector('[data-testid=workspace-agent-dialog] input[value=\"employee:employee:real\"]').checked"), true, `${mode}: employee identity survives late preferences`);
      await click('[data-testid="workspace-agent-dialog"] .ant-segmented-item:last-child');
      await wait("!!document.querySelector('[data-testid=workspace-agent-dialog] [role=alert]') && document.querySelector('[data-testid=workspace-agent-dialog] input[value=\"cli:codex\"]').checked");
      assert.equal(await evaluate("!document.querySelector('[data-testid=workspace-agent-dialog] input[value=\"employee:employee:real\"]')"), true, `${mode}: PTY capability boundary`);
      await click('[data-testid="workspace-agent-dialog"] button[type=submit]');
      await wait("sidebar.mutations.length===1 && document.querySelector('[data-testid=workspace-agent-dialog] .ant-alert-error')?.textContent.includes('本地拒收')");
      assert.deepEqual(await evaluate("sidebar.mutations[0].slice(0,3)"), ["codex", "pty", ""], `${mode}: real picker payload`);
      assert.equal(await evaluate("document.querySelector('[data-testid=workspace-agent-dialog] input[value=\"cli:codex\"]').checked"), true, `${mode}: failed start retains input`);
      // The hand-written roving radio handlers are gone; the library radio group and the
      // platform own arrow navigation now, so prove it on the real inputs.
      await click('[data-testid="workspace-agent-dialog"] input[value="cli:codex"]');
      await key("ArrowRight");
      await wait("(()=>{const root=document.querySelector('[data-testid=workspace-agent-dialog]');return Array.from(root.querySelectorAll('input[type=radio]')).some(node=>node.checked && node.value!=='cli:codex')})()");
      assert.equal(await evaluate("document.querySelector('[data-testid=workspace-agent-dialog] input[value=\"cli:codex\"]').checked"), false, `${mode}: platform arrow navigation moves the execution subject`);
      await key("Escape");
      await wait("!document.querySelector('[data-testid=workspace-agent-dialog]')");
      assert.equal(await evaluate("document.activeElement.id==='fixture-agent'"), true, `${mode}: library modal focus return`);
      if (mode === "mobile") await evaluate("sidebar.update({sessionsDrawerOpen:false});true");
      for (const direction of ["h", "v"]) {
        await evaluate(`sidebar.openSplit(${JSON.stringify(direction)});true`);
        await wait("document.querySelectorAll('.workspace-window .ws-session-pane').length===2 && !!document.querySelector('.ws-split [role=separator]')");
        // Give independent gestures their own interval, beyond the library's double-click guard.
        await pause(350);
        await wait("document.querySelector('.ws-split [role=separator]').getAttribute('aria-valuenow')==='50'");
        if (direction === "v") {
          await wait("document.querySelector('.ws-pane-scale-value').textContent==='125%'");
          const terminalLease = await evaluate("({scale:sidebar.terminalScales.get('s1'),original:sidebar.originalTerminals.map(node=>({id:node.dataset.poolTerminal,connected:node.isConnected,same:sidebar.terminalNodes.get(node.dataset.poolTerminal)===node,parent:node.parentElement?.className})),current:Array.from(document.querySelectorAll('[data-pool-terminal]')).map(node=>({id:node.dataset.poolTerminal,parent:node.parentElement?.className})),mounts:sidebar.terminalMounts,disposals:sidebar.terminalDisposals,disposeAll:sidebar.disposeAllCalls})");
          evidence.push({mode,terminalLease});
          assert.equal(terminalLease.original.length, 2, `${mode}: both terminal DOM nodes were mounted before remount`);
          assert.equal(terminalLease.current.length, 2, `${mode}: both terminal DOM nodes remain attached after remount`);
          assert.equal(await evaluate("sidebar.terminalScales.get('s1')===1.25 && sidebar.originalTerminals.every(node=>node.isConnected && sidebar.terminalNodes.get(node.dataset.poolTerminal)===node)"), true, `${mode}: direction remount retains terminal DOM identity and per-session zoom: ${JSON.stringify(terminalLease)}`);
        }
        const start = await evaluate(`(()=>{const splitter=document.querySelector('.ws-split'),sash=splitter.querySelector('[role=separator]'),r=sash.getBoundingClientRect(),bounds=splitter.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,delta:Math.min(140,(${JSON.stringify(direction)}==='h'?bounds.width:bounds.height)*0.2),saves:sidebar.layoutSaves.length,orientation:sash.getAttribute('aria-orientation'),bounds:bounds.toJSON(),matched:sash===hit||sash.contains(hit),hit:hit?.outerHTML.slice(0,200),ancestors:Array.from((function*(node){while(node){yield node;node=node.parentElement;}})(sash)).map(n=>({class:n.className,rect:n.getBoundingClientRect().toJSON()}))}})()`);
        assert.ok(start.bounds.width > 160 && start.bounds.height > 160, `${mode}: ${direction} split uses available main surface`);
        assert.equal(start.orientation, direction === "h" ? "vertical" : "horizontal", `${mode}: library separator orientation`);
        assert.equal(start.matched, true, `${mode}: ${direction} real drag starts on separator: ${JSON.stringify(start)}`);
        await evaluate("window.__dragEvents=[];for(const type of ['mousedown','mouseup'])document.addEventListener(type,event=>window.__dragEvents.push({type,time:performance.now(),target:event.target.outerHTML.slice(0,200)}),{capture:true,once:true});true");
        await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:start.x,y:start.y});
        await send("Input.dispatchMouseEvent", {type:"mousePressed",x:start.x,y:start.y,button:"left",buttons:1,clickCount:1});
        for (let step=1;step<=4;step++) {
          await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:start.x+(direction==="h"?start.delta*step/4:0),y:start.y+(direction==="v"?start.delta*step/4:0),button:"left",buttons:1});
          await pause(30);
        }
        await send("Input.dispatchMouseEvent", {type:"mouseReleased",x:start.x+(direction==="h"?start.delta:0),y:start.y+(direction==="v"?start.delta:0),button:"left",buttons:0,clickCount:1});
        await wait(`sidebar.layoutSaves.length>${start.saves} && sidebar.layoutSaves.at(-1).windows[0].layout.ratio>0.56`);
        const savedRatio = await evaluate("sidebar.layoutSaves.at(-1).windows[0].layout.ratio");
        const expectedRatio = 0.5 + start.delta / (direction === "h" ? start.bounds.width : start.bounds.height);
        assert.ok(Math.abs(savedRatio - expectedRatio) < 0.01, `${mode}: ${direction} saves the pointer ratio for its current orientation (${savedRatio} vs ${expectedRatio})`);
        evidence.push({mode,direction,sourceBundleSha256,globalCssSha256,splitterDrag:{start,completed:await evaluate("({events:window.__dragEvents,ratio:sidebar.layoutSaves.at(-1).windows[0].layout.ratio})")}});
        assert.deepEqual(await evaluate("sidebar.layoutSaves.at(-1).windows[0].layout.children.map(pane=>pane.tabs[0].sessionId)"), ["s1","s2"], `${mode}: drag saves ratio without changing session ownership`);
        assert.equal(await evaluate("sidebar.slots.every(node=>node.isConnected) && ['#output','#chat-output','.input-panel'].every(selector=>getComputedStyle(document.querySelector(selector)).display==='none')"), true, `${mode}: split hides but preserves single legacy hosts`);
        if (direction === "h") {
          await click('.ws-pane [aria-label="放大终端"]');
          await wait("document.querySelector('.ws-pane-scale-value').textContent==='125%'");
          assert.equal(await evaluate("sidebar.terminalScales.get('s1')"), 1.25, `${mode}: real zoom control updates the session scale`);
          await wait("document.querySelectorAll('[data-pool-terminal]').length===2");
          await evaluate("sidebar.originalTerminals=Array.from(document.querySelectorAll('[data-pool-terminal]'));true");
          assert.equal(await evaluate("sidebar.originalTerminals.length"), 2, `${mode}: remount starts with two real fixture terminal nodes`);
        }
      }
      const disposeAllBefore = await evaluate("sidebar.disposeAllCalls");
      await evaluate("sidebar.closeSplit();true");
      await wait(`!document.querySelector('.workspace-window') && sidebar.disposeAllCalls>${disposeAllBefore} && sidebar.terminalNodes.size===0 && sidebar.terminalScales.size===0`);
      evidence.push({mode,sourceBundleSha256,globalCssSha256,terminalLease:"real zoom control to 125%; direction remount retains same stub terminal nodes and scale; genuine split exit disposes nodes and preferences. Real terminal-pool preservation is covered by the integration owner's pool unit tests."});
      const obsolete = await evaluate(`Object.fromEntries(['details','summary','.sidebar-disclosure','.sidebar-disclosure-inner','.workspace-manage-check','.session-manage-check','.wand-new-session-choice','.chat-width-toggle-option','.im-sidebar-item','.im-sidebar-group-toggle','.workspace-worktree-bubble','.workspace-worktree-bubble-check','.workspace-worktree-dialog'].map(selector=>[selector,document.querySelectorAll(selector).length]))`);
      assert.equal(await evaluate("!!document.querySelector('.ant-collapse')"), true, `${mode}: task disclosure uses the actual Ant control`);
      // In baseline 4a the standalone session's width preference already lives in its menu; the
      // inline task-window Segmented leaves the DOM when closeSplit clears its context.
      await click('#topbar-more-button');
      await wait("!!document.querySelector('#topbar-more-menu [role=menuitem]')");
      if (mode !== "mobile" && mode !== "native") {
        await wait("document.querySelectorAll('#topbar-more-menu [data-chat-width-mode]').length===2");
        await click('#topbar-more-menu [data-chat-width-mode="column"]');
        await wait("document.documentElement.dataset.chatWidth==='column' && !document.querySelector('#topbar-more-menu') && document.activeElement.id==='topbar-more-button'");
        assert.equal(await evaluate("localStorage.getItem('wand-chat-width')"), 'column', `${mode}: current-session menu commits the local width preference`);
        await click('#topbar-more-button');
        await wait("!!document.querySelector('#topbar-more-menu [data-chat-width-mode=full]')");
        await click('#topbar-more-menu [data-chat-width-mode="full"]');
        await wait("document.documentElement.dataset.chatWidth==='full' && !document.querySelector('#topbar-more-menu') && document.activeElement.id==='topbar-more-button'");
      } else {
        assert.equal(await evaluate("document.querySelectorAll('#topbar-more-menu [data-chat-width-mode]').length"), 0, `${mode}: width preference remains scoped to supported desktop chat surfaces`);
        await key('Escape');
        await wait("!document.querySelector('#topbar-more-menu') && document.activeElement.id==='topbar-more-button'");
      }
      evidence.push({ mode, obsolete, clickRetries: clickRetries.slice(retriesBefore), reduced: await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), interactions: ["production ShellApp and repository projection", "native history resume identity", "canonical new-session Input/directory AutoComplete keyboard/Escape; retired task form no longer mounted", "profile explicit/Escape focus return", "file path Input IME/Enter", "search focus/filter/Escape", "current root navigation and employee picker below", "directory ArrowRight", "controlled task Collapse", "Ant Menu/Escape/refocus", "Ant Checkbox bulk selection", "worktree selection/disabled/start failure and Escape", "owned peek menu clicks and rename Escape focus", "Ant Tabs keyboard selection", "native back action", "stable legacy hosts", "employee identity survives late preferences", "failed start keeps choices", "PTY capability downgrade", "platform arrow navigation within the library radio group", "Ant Modal focus return", "Ant Splitter horizontal and vertical real pointer drag saves ratio and preserves terminal ownership"] });
      if (mode === "desktop" || mode === "mobile") {
        if (mode === "mobile") { await click('#sessions-toggle-button'); await wait("document.querySelector('#sessions-drawer').classList.contains('open')"); await pause(350); }
        const screenshot = await send("Page.captureScreenshot", { format: "png" });
        mkdirSync(artifact, { recursive: true }); writeFileSync(join(artifact, `sidebar-${mode}.png`), Buffer.from(screenshot.data, "base64"));
      }
      console.log(`Sidebar browser passed: ${mode}`);
    }
    assert.deepEqual(browserErrors, [], "no browser runtime exceptions");
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, artifactName), JSON.stringify({ passed: true, sourceBundleSha256, globalCssSha256, evidence, browserErrors, scope: "Current production sidebar sources in real Chrome with local repository fixtures; installed acceptance and native-host acceptance remain integration-owned" }, null, 2));
  } catch (error) {
    mkdirSync(artifact, { recursive: true });
    if (diagnosticEvaluate) console.error(await diagnosticEvaluate("(()=>{const n=document.querySelector('#wand-new-session-cwd');if(!n)return {};const r=n.getBoundingClientRect();return {rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,600),parents:Array.from((function*(p){while(p){yield p;p=p.parentElement;}})(n)).map(p=>({class:p.className,overflow:getComputedStyle(p).overflow,rect:p.getBoundingClientRect().toJSON()}))}})()"));
    writeFileSync(join(artifact, artifactName), JSON.stringify({ passed: false, sourceBundleSha256, globalCssSha256, evidence, browserErrors, error: String(error), clickLog }, null, 2));
    throw error;
  } finally {
    socket?.close();
    if (chrome.exitCode === null) { const stopped = once(chrome, "exit"); chrome.kill(); await stopped; }
    server.close(); rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
