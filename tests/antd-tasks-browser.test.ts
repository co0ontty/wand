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

test("Ant Design task pages preserve date-only, portals, draft refs and owned forms", { timeout: 360_000, skip: process.env.WAND_TASKS_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-antd-tasks-"));
  const artifact = join(root, "output/web-ui-library-migration/tasks");
  const subjectAudit = process.env.WAND_SUBJECT_CSS_AUDIT === "1";
  const boardOnly = process.env.WAND_TASK_BOARD_BROWSER_ONLY === "1";
  const artifactName = boardOnly ? "task-board-browser.json" : subjectAudit ? `subject-css-audit-${process.env.WAND_SUBJECT_AUDIT_LABEL ?? "latest"}.json` : "tasks-browser.json";
  const browserErrors: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const source = String.raw`
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles, installStyleSheet } from "./src/web-ui/react/styles";
    import { aiTeamsChunkStyles } from "./src/web-ui/react/ai-teams/styles";
    import { installSidebarStyles } from "./src/web-ui/react/shell/sidebar-styles";
    import { WorkspaceAgentPicker } from "./src/web-ui/react/workspaces/workspace-agent-picker";
    import { notifySiliconEmployeeDefinitionChanged } from "./src/web-ui/react/agents/employee-repository";
    import { installSharedLibraryBridge } from "./src/web-ui/react/library-bridge";
    import { WandButton, WandSelect, WandDialogSurface, PortalContainerProvider } from "./src/web-ui/react/ui";
    import { TaskBoardHost } from "./src/web-ui/react/issues/task-board-host";
    import { taskBoardController, taskBoardStore } from "./src/web-ui/react/issues/task-board-controller";
    import { taskBoardRepository } from "./src/web-ui/react/issues/task-board-repository";
    import { GithubIssuesHost } from "./src/web-ui/react/issues/host";
    import { githubIssuesController } from "./src/web-ui/react/issues/controller";
    import { issuesRepository } from "./src/web-ui/react/issues/repository";
    import { TaskTeamRunPanel, TeamRunView } from "./src/web-ui/react/issues/team-run-panel";
    import { MilestonePicker } from "./src/web-ui/react/milestones/picker";
    import { TaskDatePicker, TaskTextArea, TaskForm } from "./src/web-ui/react/issues/form-controls";
    import { NewSessionHost } from "./src/web-ui/react/new-session/host";
    import { configureNewSessionRuntime, newSessionController } from "./src/web-ui/react/new-session/controller";
    import { FolderPickerHost } from "./src/web-ui/react/folder-picker/host";
    import { configureFolderPickerRuntime, folderPickerController } from "./src/web-ui/react/folder-picker/controller";
    import { MemoryFolderPickerRepository } from "./src/web-ui/react/folder-picker/memory-repository";
    import { QuickCommitHost } from "./src/web-ui/react/quick-commit/host";
    import { configureQuickCommitRuntime, quickCommitController } from "./src/web-ui/react/quick-commit/controller";
    import { MemoryQuickCommitRepository } from "./src/web-ui/react/quick-commit/memory-repository";
    import { WorktreeMergeHost } from "./src/web-ui/react/worktree-merge/host";
    import { configureWorktreeMergeRuntime, worktreeMergeController } from "./src/web-ui/react/worktree-merge/controller";
    import { MissionsHost } from "./src/web-ui/react/missions/host";
    import { configureMissionsRuntime, missionsController } from "./src/web-ui/react/missions/controller";
    import { PiSettingsHost } from "./src/web-ui/react/pi-settings/host";
    import { PiExecutionHost } from "./src/web-ui/react/pi-execution/host";
    import { piExecutionController } from "./src/web-ui/react/pi-execution/controller";
    import { piSettingsController } from "./src/web-ui/react/pi-settings/controller";
    import { piSettingsRepository } from "./src/web-ui/react/pi-settings/repository";
    import { TeamDispatchRoster, useTeamDispatchFlow, initialDispatchSelection } from "./src/web-ui/react/team-dispatch/roster";
    import { ComposerStore } from "./src/web-ui/browser/composer";
    import { configureTeamChatComposerRuntime } from "./src/web-ui/react/ai-teams/composer-bridge";
    import { aiTeamsRepository } from "./src/web-ui/react/ai-teams/repository";
    installReactUiStyles(); installSharedLibraryBridge();
    if(new URL(location.href).searchParams.has("subjectAudit")){installSidebarStyles();installStyleSheet("wand-ai-teams-styles",aiTeamsChunkStyles);}
    const memory = new Map();
    const composer = new ComposerStore({storage:()=>({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)}),isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>composer.read(id),edit:(id,change)=>composer.edit(id,change),subscribe:listener=>composer.subscribe(listener),submit:(id,text,deliver)=>composer.submit(id,text,deliver)});
    window.__wandAiTeamsChunk = { TaskTeamRunPanel };
    const noop = () => {};
    const agent = { provider:"claude", model:"default", thinkingEffort:"default", mode:"default", kind:"structured" };
    const task = { id:"t1", identifier:"TASK-1", title:"Actual task card", description:("Full inline description with details. ").repeat(60), labels:["UI","Regression","Complete"], workspaceId:"w1", workspaceTaskId:"wt1", workspace:{id:"w1",name:"Project",cwd:"/tmp"}, milestone:{id:"m1",name:"Iteration"}, milestoneId:"m1", status:"doing", priority:"high", dueDate:"2028-02-29", parentTaskId:null, createdAt:"2026-01-01", updatedAt:"2026-01-01", sortOrder:0, sessions:[{id:"s1",provider:"codex",model:"gpt-5",title:"Real session " + "long-unbroken-directory-name/".repeat(12),status:"idle",sessionKind:"structured",cwd:"/tmp/worktree",thinkingEffort:"high"}], agent:null };
    window.tasks = { selection:"", date:"", refs:false, chosen:"", saved:null, requests:[], deferred:null, employees:[], teams:[{id:"audit-team",name:"审计团队",description:"只读验收",instructions:"",requirePlanApproval:true,maxSteps:8,createdAt:"2026-01-01",updatedAt:"2026-01-01",members:[{id:"m1",name:"负责人",duty:"拆解与验收",isLeader:true,agents:[agent],agent}]}], board:null, baseTask:task, boardTasks:null, teamRun:null };
    window.tasks.board = () => taskBoardStore.getSnapshot();
    const milestones = [{id:"m1",name:"Iteration",workspaceId:"w1",isDefault:false,taskCount:1},{id:"m0",name:"Default",workspaceId:null,isDefault:true,taskCount:0}];
    globalThis.fetch = async (input, init) => {
      const url=String(input); window.tasks.requests.push({url,method:init?.method??"GET"});
      if (url.includes("wand-milestones") && init?.method === "POST") return new Response(JSON.stringify({error:"Milestone rejected locally"}), {status:400,headers:{"content-type":"application/json"}});
      // 团队直发：只接这一条写路径，响应形状就是 host 读的 run.chatSessionId。
      if (url.includes("ai-teams") && url.includes("/runs") && init?.method === "POST") {
        window.tasks.teamRun = JSON.parse(String(init.body));
        return new Response(JSON.stringify({taskId:"t-team",run:{id:"audit-team-run",chatSessionId:"audit-chat-session"}}), {status:200,headers:{"content-type":"application/json"}});
      }
      if (url.includes("/pi-execution/")) return new Response(JSON.stringify({toolId:"execution-real",toolName:"subagent",input:{workflow:"fixture"},script:"Read-only fixture script",snapshot:{version:1,source:"tool-result",mode:"workflow",state:"completed",inventoryComplete:true,nodes:[{id:"real-parent",label:"Actual parent",kind:"step",state:"completed",task:"Parent task"},{id:"real-child",parentId:"real-parent",label:"Actual child",kind:"step",state:"failed",task:"Child task",error:"Fixture node failed"}],trace:[],omittedNodes:0,omittedTrace:0}}),{status:200,headers:{"content-type":"application/json"}});
      if (init?.method && init.method!=="GET") throw new Error("Unexpected fixture HTTP mutation: "+url);
      let data = url.includes("provider-usage")?{}:url.includes("silicon-employees")?{employees:window.tasks.employees}:url.includes("ai-teams")?window.tasks.teams:url.includes("workspaces")?[{id:"w-audit",name:"Audit project",cwd:"/tmp",kind:"project"}]:url.includes("wand-milestones")?{milestones}:url.includes("team-runs")?[]:url.includes("models")?{models:[{id:"default",label:"Default"},{id:"alpha",label:"Alpha"}]}:{};
      return new Response(JSON.stringify(data), {status:200,headers:{"content-type":"application/json"}});
    };
    Object.assign(taskBoardRepository,{list:async()=>window.tasks.boardTasks??[task,{...task,id:"old",identifier:"TASK-2",title:"Archived",status:"archived"}],workspaces:async()=>[{id:"w1",name:"Project",cwd:"/tmp"}],models:async()=>({models:[{id:"default",label:"Default"}]}),agentDefaults:async()=>window.tasks.agentDefaults??agent,saveAgentDefaults:async()=>{throw Error("Implicit defaults mutation")},create:async input=>new Promise(resolve=>{window.tasks.createdInputs??=[];window.tasks.createdInputs.push(input);window.tasks.createReceipt=()=>{if(input.rememberAgentDefaults)window.tasks.agentDefaults=input.agent;resolve({...task,...input,id:"new"})}})});
    Object.assign(issuesRepository,{list:async()=>[{number:1,title:"Library migration",state:"open",labels:[{name:"UI"}]}],bindings:async()=>({bindings:[]}),create:async()=>new Promise(resolve=>{window.tasks.issueReceipt=()=>resolve({number:2})})});
    configureNewSessionRuntime({onOpen:noop,onClose:noop,getContext:()=>({effectiveCwd:"/tmp",selectedModels:{}}),rememberModel:noop,prepareCreate:async()=>({}),completeCreate:async()=>{}});
    const newRepo={load:async()=>({config:{defaultProvider:"claude",defaultSessionKind:"structured",defaultMode:"default",defaultCwd:"/tmp"},recentPaths:[{path:"/tmp",name:"tmp"}]}),suggestPaths:async()=>[{path:"/tmp/project",name:"project"}],savePreferences:async()=>{},create:async()=>{throw Error("Local rejection keeps inputs");}};
    configureFolderPickerRuntime({getInitialPath:()=>"/tmp",applySelection:path=>{window.tasks.chosen=path}});
    const folders=new MemoryFolderPickerRepository([{currentPath:"/tmp",items:[{type:"parent",name:"..",path:"/"},{type:"directory",name:"project",path:"/tmp/project"}]}]);
    configureQuickCommitRuntime({onOpen:noop,onClose:noop,nextStatusRequestTime:()=>1,onStatusLoaded:noop,toast:noop});
    const quick=new MemoryQuickCommitRepository({status:{isGit:true,branch:"fixture",modifiedCount:1,files:[{path:"src/sample.ts",status:" M",isSubmodule:false}],head:"abc",ahead:0,behind:0,latestTag:"",hasSubmodule:true},context:{iteration:{id:"m1",name:"Iteration",isDefault:false},entries:[{id:"entry",title:"Prompt entry",detail:"Full prompt",createdAt:"2026-01-01",consumed:false,consumedCommit:"",source:"user"}],defaultEntryIds:["entry"],selectableIds:["entry"],truncated:false,effectiveMode:"iteration",mode:"iteration"}});
    configureWorktreeMergeRuntime({onOpen:noop,onClose:noop,onRepositoryChanged:noop,toast:noop});
    const merge={inspect:async()=>({ok:true,sourceBranch:"feature",targetBranch:"main",worktreePath:"/tmp/fixture",repoRoot:"/tmp",hasUncommittedChanges:false,aheadCount:1,hasConflicts:false,recommendedAction:"merge",reason:"",commits:[{hash:"abc123",shortHash:"abc",subject:"Actual inspection row"}]}),merge:async()=>{throw Error("No real merge")},cleanup:async()=>{throw Error("No real cleanup")}};
    configureMissionsRuntime({onOpen:noop,onClose:noop,openSession:async()=>{},effectiveCwd:()=>"/tmp"});
    const mission={id:"mission",title:"Parallel task",prompt:"Full mission goal",cwd:"/tmp",status:"running",worktree:{baseRef:"main"},attempts:[{id:"attempt",missionId:"mission",sessionId:"s",provider:"claude",state:"done",branch:"feature",worktreePath:"/tmp/work",baseRef:"main",summary:"Full result",error:null,updatedAt:"2026-01-01"}],comments:[],createdAt:"2026-01-01",updatedAt:"2026-01-01"};
    const missions={list:async()=>[mission],listInbox:async()=>[],create:async()=>{throw Error("No execution")},diff:async()=>({missionId:"mission",attemptId:"attempt",baseRef:"main",files:[{path:"sample.ts",status:"M"}],patch:"--- a/sample.ts\n+++ b/sample.ts\n@@ -1 +1 @@\n-old\n+new",truncated:false}),addComment:async()=>{},sendReview:async()=>[]};
    const pi={settings:{codemodeOverride:null,autoResources:false,resources:{skills:[],mcpServers:[]}},controls:{codemodeOverride:true},autoResourcesAvailable:false,resourceCatalog:{supported:true,skills:[{id:"skill-real",name:"Installed Skill",description:"Actual stable ID"}],mcpServers:[],reason:""}};
    Object.assign(piSettingsRepository,{load:async()=>pi,save:async(_id,patch)=>{window.tasks.saved=patch;pi.settings={...pi.settings,...patch};return {settings:pi.settings}}});
    const member=(id,name,isLeader=false)=>({employeeId:id,name,duty:"Complete duty text",tags:[],avatar:"",probability:.8,isLeader});
    const plan={members:[member("a","First",true),member("b","Second")],bench:[member("c","Third")],note:"Fixture plan, no model call",maxMembers:3};
    const teamDetail={run:{id:"r1",taskId:"t1",teamId:"team",team:{id:"team",name:"Team",members:[]},status:"waiting_user",objective:"Fixture objective",createdAt:"2026-01-01",stepsUsed:1,stepLimit:10,statusDetail:"Question",updatedAt:"2026-01-01"},steps:[],memberStates:{},chatTurns:[]};
    Object.assign(aiTeamsRepository,{reply:async()=>new Promise(resolve=>{window.tasks.deferred=()=>resolve(teamDetail)})});
    function Dispatch(){const flow=useTeamDispatchFlow();React.useEffect(()=>{flow.updateSelection(initialDispatchSelection(plan))},[]);return <><TeamDispatchRoster flow={flow}/><TeamDispatchRoster flow={{...flow,hasPlan:true,plan}}/><pre id="selection">{JSON.stringify(flow.selection)}</pre></>}
    function SubjectAudit(){
      const [kind,setKind]=React.useState("structured"),[target,setTarget]=React.useState("codex"),[model,setModel]=React.useState("default"),[employeeId,setEmployeeId]=React.useState(""),[teamId,setTeamId]=React.useState(""),[teams,setTeams]=React.useState([]),[workspace,setWorkspace]=React.useState("audit-project");
      const roster=(filled)=>{window.tasks.employees=filled?[{id:"audit-employee",name:"审计员工",duty:"主体身份",prompt:"",tags:[],avatar:"cat:0",agents:[agent]}]:[];setTeams(filled?[{id:"audit-team",name:"审计团队",detail:"主体身份"}]:[]);notifySiliconEmployeeDefinitionChanged("audit-employee");};
      return <WandDialogSurface open title="主体样式审计" testId="subject-audit-dialog" onOpenChange={()=>{}}>
        <div id="subject-audit-actions"><WandButton id="subject-fill" onClick={()=>roster(true)}>填充主体</WandButton><WandButton id="subject-empty" onClick={()=>roster(false)}>清空样本</WandButton><WandButton id="subject-project" onClick={()=>setWorkspace(value=>value?"":"audit-project")}>切换项目</WandButton></div>
        <WorkspaceAgentPicker persistPreferences={false} target={target} kind={kind} model={model} teams={teams} teamWorkspaceId={workspace} employeeId={employeeId} teamId={teamId} onTargetChange={setTarget} onKindChange={setKind} onModelChange={setModel} onEmployeeChange={setEmployeeId} onTeamChange={setTeamId}/>
      </WandDialogSurface>;
    }
    function App(){const [page,setPage]=React.useState("controls"),[value,setValue]=React.useState("a"),[date,setDate]=React.useState("2028-02-29"),[open,setOpen]=React.useState(true),[detail,setDetail]=React.useState(teamDetail);const textarea=React.useRef(null);
      React.useEffect(()=>{window.tasks.readRef=()=>textarea.current instanceof HTMLTextAreaElement;window.tasks.show=(next)=>{setPage(next);setOpen(true);if(next==="board")taskBoardController.open();if(next==="github")githubIssuesController.open("s");if(next==="new")newSessionController.open();if(next==="new-task")newSessionController.open({initialCwd:"/tmp",workspaceId:"w-audit",workspaceTaskId:"wt-audit",taskName:"Fixture task"});if(next==="folder")folderPickerController.open();if(next==="quick")quickCommitController.open({sessionId:"s"});if(next==="merge")worktreeMergeController.open({sessionId:"s",intent:"merge",sourceBranch:"feature",worktreePath:"/tmp/fixture",sessionStatus:"idle"});if(next==="missions")missionsController.open();if(next==="execution")piExecutionController.open("s","execution-real",document.getElementById("outside"));};},[]);
      React.useEffect(()=>{if(page!=="pi")return;piSettingsController.sync([{key:"pi",target:document.getElementById("pi-target"),toggleTarget:document.getElementById("pi-toggle"),sessionId:"s",draft:"",open:true,onSaved:noop,returnFocus:()=>document.getElementById("outside").focus()}]);return()=>piSettingsController.sync([])},[page]);
      return <><WandButton id="outside">Outside</WandButton>
      {page==="controls"&&<WandDialogSurface open={open} title="Task controls" testId="task-controls" onOpenChange={setOpen}><TaskForm style={{display:"flex",flexDirection:"column",gap:16}} onSubmit={event=>event.preventDefault()}><TaskTextArea ref={textarea} aria-label="Native ref" value="Draft" readOnly/><WandSelect searchable ariaLabel="Task model" popupOwner="task-controls" options={[{value:"a",label:"Alpha"},{value:"b",label:"Beta"}]} value={value} onValueChange={v=>{setValue(v);window.tasks.selection=v}}/><TaskDatePicker ariaLabel="Date only" popupOwner="task-controls" value={date} onValueChange={v=>{setDate(v);window.tasks.date=v}}/><MilestonePicker value="m1" workspaceId="w1" onChange={noop}/></TaskForm></WandDialogSurface>}
      {page==="subject"&&<SubjectAudit/>}{page==="board"&&<TaskBoardHost/>}{page==="github"&&<GithubIssuesHost/>}{(page==="new"||page==="new-task")&&<NewSessionHost repository={newRepo}/>}{page==="folder"&&<FolderPickerHost repository={folders}/>}{page==="quick"&&<QuickCommitHost repository={quick}/>}{page==="merge"&&<WorktreeMergeHost repository={merge}/>}{page==="missions"&&<MissionsHost repository={missions}/>}{page==="dispatch"&&<Dispatch/>}{page==="team"&&<TeamRunView detail={detail} onChange={setDetail}/>}{page==="execution"&&<PiExecutionHost/>}{page==="pi"&&<><div id="pi-target"/><div id="pi-toggle"/><PiSettingsHost/></>}
      </>;
    }
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("wand-react-ui-portals")}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temporary, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    if (request.url?.includes("aiTeamsChunkSrc")) { response.setHeader("content-type", "application/javascript"); response.end(""); }
    else if (request.url === "/app.js") { response.setHeader("content-type", "application/javascript"); response.end(readFileSync(join(temporary, "app.js"))); }
    else if (request.url === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else if (request.url === "/tailwind.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/tailwind.css"))); }
    else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>#root{padding:16px;max-width:100%;height:95vh;overflow:auto}#outside{margin:4px}</style></head><body><div id="root"></div><div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temporary}/profile`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const portFile = join(temporary, "profile/DevToolsActivePort");
    for (let attempt = 0; attempt < 120 && !existsSync(portFile); attempt++) await pause(50);
    assert.ok(existsSync(portFile), "Chrome debugging endpoint available");
    const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
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
    const captureCss = cssEvidenceCapture("tasks");
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      await captureCss(send);
      return result.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(expression)) return; await pause(30); }
      throw new Error(`Timed out: ${expression}; ${await evaluate("JSON.stringify({text:document.body.innerText,visibility:document.visibilityState,inputs:Array.from(document.querySelectorAll('input,textarea')).map(n=>({value:n.value,cls:n.className})),buttons:Array.from(document.querySelectorAll('button')).map(n=>({text:n.textContent,disabled:n.disabled,type:n.type})),pickers:Array.from(document.querySelectorAll('.ant-picker-dropdown,.wand-ui-select-content')).map(n=>({class:n.className,opacity:getComputedStyle(n).opacity,transform:getComputedStyle(n).transform,rect:n.getBoundingClientRect().toJSON()})),popups:Array.from(document.querySelectorAll('.ant-dropdown')).map(n=>({class:n.className,css:getComputedStyle(n).cssText,transform:getComputedStyle(n).transform,animation:getComputedStyle(n).animation,rect:n.getBoundingClientRect().toJSON(),inner:n.querySelector('input')?.getBoundingClientRect().toJSON(),hit:(()=>{let r=n.querySelector('input')?.getBoundingClientRect();return r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500)})()}))})")}`);
    };
    const settle = async (): Promise<void> => {
      // Library surfaces animate in; a rect read mid-motion is a scaled/offset box, and a popup
      // that is still entering has opacity 0 even though it already answers hit tests.
      // A prepare/enter phase has no running animation yet still moves the box on the next frame,
      // so wait for the motion classes themselves to clear (anchored on ant-* tokens only).
      const quiet = "(()=>{const motion=/(^|\\s)ant-[\\w-]*-(enter|appear|leave)(-active|-prepare)?(\\s|$)/;const moving=Array.from(document.querySelectorAll('[class]')).some(n=>typeof n.className==='string'&&motion.test(n.className));return document.getAnimations().every(a=>a.playState!=='running')&&!moving})()";
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await evaluate(quiet)) return;
        await pause(30);
      }
    };
    const click = async (selector: string): Promise<void> => {
      await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden'})()`);
      // Settle the entrance animation, then re-scroll: a height taken mid-zoom would leave the
      // target below the fold once the surface reaches its final size.
      for (let attempt = 0; attempt < 3; attempt++) {
        await settle();
        // Center the target: `nearest` can leave it hidden under a sticky footer inside the scroller.
        await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:"center",behavior:"instant"})`);
        await pause(160);
        const reachable = `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(n===hit||n.contains(hit))})()`;
        if (await evaluate(reachable)) break;
        if (attempt === 2) await wait(reachable);
      }
      const probe = `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing target');if(!n.closest('.ant-dropdown,.ant-picker-dropdown,.ant-popover,.ant-tooltip,.ant-select-dropdown'))n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(n!==hit&&!n.contains(hit))throw Error('Target obstructed: '+${JSON.stringify(selector)}+' hit '+hit?.outerHTML.slice(0,500)+' target '+n.outerHTML+' pointer '+getComputedStyle(n).pointerEvents+' rect '+JSON.stringify(r.toJSON())+' ancestors '+JSON.stringify((()=>{let a=n,result=[];while(a){let s=getComputedStyle(a);result.push({tag:a.tagName,cls:a.className,display:s.display,visibility:s.visibility,transform:s.transform,animation:s.animation,width:s.width,height:s.height,inline:a.getAttribute('style')});a=a.parentElement}return result})()));return{x,y}})()`;
      // Real pointers move before they press; library popups finish positioning on that move,
      // so hover, then re-aim with a fresh rect instead of reusing the pre-move point.
      const first = await evaluate(probe);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...first });
      await pause(80);
      const point = await evaluate(probe);
      if (selector === '.milestone-picker-trigger') await evaluate("(()=>{window.__milestoneEvents=[];for(const type of ['pointerdown','mousedown','mouseup','click'])document.addEventListener(type,e=>{if(e.target.closest('.milestone-picker-trigger'))__milestoneEvents.push({type,target:e.target.tagName,cls:e.target.className,active:document.activeElement?.tagName})},{capture:true,once:true});})()");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      const afterPress = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n?.getBoundingClientRect();return {x:r?.x,y:r?.y,width:r?.width,height:r?.height,active:document.activeElement?.tagName}})()`);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      if (selector === '.milestone-picker-trigger') {
        const diagnostic={mode:'pointer-diagnostic',selector,point,afterPress,triggerState:await evaluate("document.querySelector('.milestone-picker-trigger')?.getAttribute('aria-expanded')"),events:await evaluate("window.__milestoneEvents")};
        evidence.push(diagnostic); console.log("Milestone pointer: "+JSON.stringify(diagnostic));
      }
    };
    // Ant keeps the calendar mounted and parks it off screen while it still reports as open, and a
    // closing panel is briefly on screen with the leave motion. "Usable" therefore means: motion
    // finished, no leave/hidden marker, positioned inside the viewport.
    const calendarVisible = "Array.from(document.querySelectorAll('.ant-picker-dropdown')).filter(n=>!/-(leave|hidden)/.test(n.className)).find(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&getComputedStyle(n).opacity!=='0'})";
    const calendarInView = `!!(${calendarVisible})`;
    const calendarFlaggedOpen = "document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)')";
    const openCalendar = async (): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await settle();
        if (await evaluate(calendarInView)) return;
        // 库可能仍认为面板是打开的（没有 -hidden）却已停在屏幕外：先按 Escape 关掉它。
        // TaskDatePicker 的浮层租约只在自身打开时接管 Escape，不会关掉外层对话框。
        if (await evaluate(`!!${calendarFlaggedOpen}`)) {
          await key("Escape");
          await pause(150);
        }
        await click('[aria-label="Date only"]');
        await pause(250);
      }
      await settle();
      await wait(calendarInView);
    };
    // 入场动画结束后，单元格的坐标要在连续两帧里一致才按下去，否则会落到相邻的那天。
    const pickCalendarDay = async (title: string, expected: string): Promise<void> => {
      const cell = `${calendarVisible}?.querySelector('[title="${title}"] .ant-picker-cell-inner')`;
      for (let attempt = 0; attempt < 3; attempt++) {
        await openCalendar();
        await wait(`(()=>{document.querySelector('[data-task-test-day]')?.removeAttribute('data-task-test-day');const n=${cell};n?.setAttribute('data-task-test-day','');return !!n})()`);
        await evaluate("window.__wandDayBox = null");
        await wait(`(()=>{const n=document.querySelector('[data-task-test-day]');if(!n)return false;const r=n.getBoundingClientRect();const box=[r.x,r.y,r.width,r.height].join(':');const stable=window.__wandDayBox===box;window.__wandDayBox=box;return stable})()`);
        await click('[data-task-test-day]');
        await evaluate("document.querySelector('[data-task-test-day]')?.removeAttribute('data-task-test-day')");
        await pause(120);
        if (await evaluate(`tasks.date===${JSON.stringify(expected)}`)) return;
      }
      await wait(`tasks.date===${JSON.stringify(expected)}`);
    };
    const clickText = async (text: string): Promise<void> => {
      await wait(`Array.from(document.querySelectorAll('button')).some(n=>n.textContent.replaceAll(' ','')===${JSON.stringify(text.replaceAll(' ', ''))})`);
      await evaluate(`(()=>{document.querySelector('[data-task-test-click]')?.removeAttribute('data-task-test-click');const n=Array.from(document.querySelectorAll('button')).find(n=>n.textContent.replaceAll(' ','')===${JSON.stringify(text.replaceAll(' ', ''))});n.setAttribute('data-task-test-click','')})()`);
      await click('[data-task-test-click]');
    };
    const clickTab = async (text: string): Promise<void> => {
      // 视图切换是 StretchTabs（Ant Segmented）：条目是 label + radio，不是 button。
      const label = JSON.stringify(text.replaceAll(' ', ''));
      await wait(`Array.from(document.querySelectorAll('.ant-segmented-item,button,.ant-tabs-tab')).some(n=>n.textContent.replaceAll(' ','')===${label})`);
      await evaluate(`(()=>{document.querySelector('[data-task-test-tab]')?.removeAttribute('data-task-test-tab');Array.from(document.querySelectorAll('.ant-segmented-item,button,.ant-tabs-tab')).find(n=>n.textContent.replaceAll(' ','')===${label}).setAttribute('data-task-test-tab','')})()`);
      await click('[data-task-test-tab]');
    };
    const key = async (key: string): Promise<void> => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: key === "Escape" ? 27 : key === "Enter" ? 13 : 40 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
    };
    await send("Page.enable"); await send("Runtime.enable");
    const featureOnly = process.env.WAND_TASKS_FEATURE_ONLY === "1";
    const inventory = featureOnly ? ["new", "folder", "quick", "merge", "missions", "dispatch", "pi"]
      : ["controls", "board", "github", "new", "folder", "quick", "merge", "missions", "dispatch", "pi", "team"];
    const screenshot = async (name: string) => {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(artifact, { recursive: true }); writeFileSync(join(artifact, `${name}.png`), Buffer.from(shot.data, "base64"));
    };
    for (const mode of process.env.WAND_TASKS_TEST_MODES?.split(",") ?? ["desktop", "mobile", "native", "rollback", "reduced-motion"]) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "mobile" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", { url: subjectAudit ? `${origin}/?subjectAudit=1&mode=${mode}${mode === "rollback" ? "&reactUi=0" : ""}` : `${origin}/${mode === "rollback" ? "?reactUi=0" : ""}` });
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'"); await send("Page.bringToFront");
      await wait("!!window.tasks?.show && !!document.querySelector('[data-testid=task-controls]')");
      if (mode === "native") await evaluate("document.documentElement.classList.add('is-wand-app','is-wand-ios')");
      if(subjectAudit){
        const selectors=[".wand-execution-subject-picker",".wand-subject-group",".wand-subject-group-title",".wand-subject-empty-row",".wand-link-btn",".wand-link-btn:hover",".wand-subject-options",".wand-subject-options > div",".wand-subject-options h4",".wand-subject-label",".wand-subject-label > span",".wand-subject-label small"];
        const audit=async(state:string)=>{
          const sample=await evaluate(`({counts:${JSON.stringify(selectors)}.map(selector=>document.querySelectorAll(selector).length),provider:document.querySelectorAll('.wand-subject-provider').length,width:innerWidth,native:document.documentElement.classList.contains('is-wand-app'),rollback:location.search.includes('reactUi=0'),reduced:matchMedia('(prefers-reduced-motion:reduce)').matches})`);
          assert.deepEqual(sample.counts,selectors.map(()=>0),`${mode}/${state}: retired subject selectors have no runtime owner`);
          assert.ok(sample.provider>0,`${mode}/${state}: surviving ProviderLogo class has a real owner`);
          evidence.push({mode,state,selectors,...sample});
        };
        await evaluate("tasks.show('new')");await wait("document.body.innerText.includes('还没有硅基员工')");await audit('new-empty');
        await clickTab("终端");await wait("!document.querySelector('[data-testid=new-session-dialog] [role=group][aria-label=硅基员工]')");await audit('new-pty');
        await key("Escape");await wait("!document.querySelector('[data-testid=new-session-dialog]')");
        await evaluate("tasks.show('subject')");await wait("document.body.innerText.includes('还没有硅基员工')");await audit('workspace-empty');
        await click('#subject-fill');await wait("!!document.querySelector('input[value=\"employee:audit-employee\"]') && !!document.querySelector('input[value=\"team:audit-team\"]')");await audit('workspace-filled');
        await click('label:has(input[value="employee:audit-employee"])');await wait("document.querySelector('input[value=\"employee:audit-employee\"]').checked");await audit('workspace-employee');
        await clickTab("终端");await wait("!document.querySelector('input[value^=\"employee:\"]') && !document.querySelector('input[value^=\"team:\"]')");await audit('workspace-pty');
        await clickTab("对话");await click('label:has(input[value="team:audit-team"])');await wait("document.querySelector('input[value=\"team:audit-team\"]').checked");await audit('workspace-team');
        await click('#subject-project');await wait("document.querySelector('input[value=\"team:audit-team\"]').disabled");await audit('workspace-team-blocked');
        await click('#subject-project');await wait("!document.querySelector('input[value=\"team:audit-team\"]').disabled");await audit('workspace-team-available');
        await evaluate("tasks.show('new')");await wait("!!document.querySelector('[data-testid=new-session-dialog] input[value=\"employee:audit-employee\"]')");
        await click('[data-testid=new-session-dialog] label:has(input[value="employee:audit-employee"])');await wait("document.querySelector('[data-testid=new-session-dialog] input[value=\"employee:audit-employee\"]').checked");await audit('new-employee');
        await screenshot(`${mode}-subject-audit`);
        await key("Escape");await wait("!document.querySelector('[data-testid=new-session-dialog]')");
        console.log(`Subject CSS audit passed: ${mode}`);continue;
      }
      if (!featureOnly) {
      assert.equal(await evaluate("tasks.readRef()"), true, `${mode}: native textarea lease`);
      await click('[aria-label="Task model"]'); await wait("!!document.querySelector('.wand-ui-select-content input')");
      await click('.wand-ui-select-content input'); await send("Input.insertText", {text:"Beta"});
      await click('.wand-ui-select-content [role=option]'); await wait("tasks.selection==='b'");
      assert.equal(await evaluate("!!document.querySelector('[data-testid=task-controls]')"), true, `${mode}: option keeps parent`);
      // 浮层所有权：日历打开时 Escape 只关日历，父对话框还在。
      await click('[aria-label="Date only"]'); await wait(`!!${calendarFlaggedOpen}`);
      await key("Escape"); await wait(`!${calendarFlaggedOpen}`);
      assert.equal(await evaluate("!!document.querySelector('[data-testid=task-controls]')"), true, `${mode}: calendar Escape keeps parent`);
      // Every mode uses a real pointer day click, including reduced motion.
      // YYYY-MM-DD must survive the America/Los_Angeles date-only roundtrip.
      await openCalendar();
      await wait(`!!document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell-selected[title="2028-02-29"]')`);
      await pickCalendarDay("2028-02-21", "2028-02-21");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"Date only\"]').value"), "2028-02-21", `${mode}: grid click keeps date-only display`);
      // 手输日期同样只走 YYYY-MM-DD，不经 Date/UTC 转换。
      await click('[aria-label="Date only"]');
      await evaluate("document.querySelector('[aria-label=\"Date only\"]').select()");
      await send("Input.insertText", { text: "2040-02-29" }); await key("Enter");
      await wait("tasks.date==='2040-02-29'");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"Date only\"]').value"), "2040-02-29", `${mode}: typed leap day keeps date-only display`);
      await click('.milestone-picker-trigger'); await wait("!!document.querySelector('.milestone-picker-add')");
      await click('.milestone-picker-add'); await wait("document.activeElement.getAttribute('aria-label')==='新里程碑名称'");
      await send("Input.insertText", {text:"Retained milestone draft"});
      await click('.milestone-picker-create-actions .wand-ui-button-primary');
      await wait("document.querySelector('.milestone-picker-error')?.textContent.includes('Milestone rejected locally')");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"新里程碑名称\"]').value"), "Retained milestone draft", `${mode}: milestone failure retains input`);
      await click('.milestone-picker-create-cancel'); await key('Escape');
      assert.equal(await evaluate("!!document.querySelector('[data-testid=task-controls]')"), true, `${mode}: milestone Escape retains parent`);
      await screenshot(`${mode}-controls`);
      await evaluate("tasks.show('board')"); await wait("!!document.querySelector('[data-task-id=t1]')"); await settle();
      const countBefore = await evaluate("document.querySelector('.task-board-result-summary').textContent");
      assert.match(countBefore, /活动 1 · 归档 1/);
      await click('.task-board-archive-header');
      await wait("document.querySelector('.task-board-archive-header').getAttribute('aria-expanded')==='true'");
      assert.equal(await evaluate("document.querySelector('.task-board-result-summary').textContent"), countBefore, `${mode}: archive disclosure preserves counts`);
      await click('.task-board-archive-header');
      await wait("document.querySelector('.task-board-archive-header').getAttribute('aria-expanded')==='false'");
      assert.equal(await evaluate("!!document.querySelector('.task-board-archive-hint')"), false, `${mode}: empty columns do not contain an archive drop hint`);
      await evaluate("document.querySelector('[data-task-id=t1]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:new DataTransfer()}))");
      await wait("!!document.querySelector('.task-board-archive-zone')");
      assert.equal(await evaluate("!document.querySelector('.task-board-archive-zone').closest('.task-board-column') && !!document.querySelector('.task-board-archive-hint')"), true, `${mode}: dragging reveals a separate archive destination`);
      await evaluate("document.querySelector('[data-task-id=t1]').dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:new DataTransfer()}))");
      await wait("!document.querySelector('.task-board-archive-hint')");
      // 看板卡片保留 article 业务容器（拖拽 / 直接子元素规则），卡片里的控件才是库组件。
      assert.equal(await evaluate("document.querySelector('[data-task-id=t1]').classList.contains('task-board-card') && !document.querySelector('[data-task-id=t1]').classList.contains('ant-card')"), true, `${mode}: card stays the drag container`);
      assert.equal(await evaluate("!!document.querySelector('[data-task-id=t1] .task-board-label.ant-tag') && !!document.querySelector('[data-task-id=t1] .task-board-priority')"), true, `${mode}: card chips come from the library`);
      const sessionTitle = await evaluate(`(()=>{const card=document.querySelector('[data-task-id=t1]'),button=card.querySelector('.task-board-session-open'),text=button.querySelector('.ant-typography'),move=card.querySelector('.task-board-session-row button:not(.task-board-session-open)');const r=button.getBoundingClientRect(),c=card.getBoundingClientRect(),m=move?.getBoundingClientRect();return {buttonContained:r.left>=c.left&&r.right<=c.right,ellipsis:getComputedStyle(text).textOverflow==='ellipsis',fullTextRetained:text.textContent.includes('long-unbroken-directory-name/'),moveContained:!!m&&m.right<=c.right}})()`);
      assert.deepEqual(sessionTitle, { buttonContained: true, ellipsis: true, fullTextRetained: true, moveContained: true }, `${mode}: long session title stays inside the card and keeps its action reachable`);
      await click('.task-board-card-open'); await wait("document.querySelector('.task-board-card-open').getAttribute('aria-expanded')==='true'");
      assert.equal(await evaluate("document.querySelector('.task-board-card-detail').textContent.includes('Full inline description')"), true);
      assert.equal(await evaluate(`(()=>{const card=document.querySelector('[data-task-id=t1]');const list=card.querySelector('.task-board-session-list');return {display:list?getComputedStyle(list).display:null,doubled:(card.innerText.match(/Real session/g)||[]).length}})()`).then((state) => state.display === "none" && state.doubled === 1), true, `${mode}: expanded card does not list the same session twice`);
      await settle(); await screenshot(`${mode}-board-expanded`);
      // 展开后面板盖住整卡 overlay，非点击收起走 Escape（一次只退一层），焦点回到卡片触发区。
      await key('Escape'); await wait("document.querySelector('.task-board-card-open').getAttribute('aria-expanded')==='false'");
      assert.equal(await evaluate("document.activeElement===document.querySelector('.task-board-card-open')"), true, `${mode}: Escape collapse keeps focus on the card trigger`);
      await settle(); await screenshot(`${mode}-board`);
      await click('[aria-label="任务菜单 TASK-1"]');
      await wait("!!document.querySelector('[data-wand-popup-owner=task-board-context] [role=menuitem]')");
      await key('Escape'); await wait("!document.querySelector('[data-wand-popup-owner=task-board-context]')");
      assert.equal(await evaluate("!!document.querySelector('[data-task-id=t1]')"), true, `${mode}: menu Escape retains board`);
      await evaluate("document.querySelector('.task-board-card-open').focus()");
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'F10',code:'F10',modifiers:8,windowsVirtualKeyCode:121});
      await wait("!!document.querySelector('[data-wand-popup-owner=task-board-context]')");
      await key('Escape'); await wait("!document.querySelector('[data-wand-popup-owner=task-board-context]')");
      await evaluate("tasks.boardTasks=Array.from({length:14},(_,i)=>({...tasks.baseTask,id:'sample-'+i,identifier:'SAMPLE-'+i,title:'合成验收任务 '+i,description:'用于验证列滚动与排序的合成样本',priority:i===8?'urgent':'low',dueDate:i===8?'2026-10-10':null,sessions:i===0?Array.from({length:4},(_,j)=>({...tasks.baseTask.sessions[0],id:'sample-session-'+j})):[]}))");
      await click('[aria-label="刷新任务"]'); await wait("document.querySelectorAll('.task-board-column.is-doing [data-task-id]').length===14");
      const columnGeometry = await evaluate("(()=>{const c=document.querySelector('.task-board-column.is-doing'),l=c.querySelector('.task-board-column-list'),h=c.querySelector('header'),p=document.querySelector('.task-board-native-page');const before=h.getBoundingClientRect().y;l.scrollTop=120;return{overflow:l.scrollHeight>l.clientHeight,headStable:before===h.getBoundingClientRect().y,pageOverflow:p.scrollWidth>p.clientWidth,columnWidth:c.getBoundingClientRect().width,pageWidth:p.clientWidth,previewCount:c.querySelector('[data-task-id=sample-0]').querySelectorAll('.task-board-session-row').length}})()");
      assert.equal(columnGeometry.overflow, true, `${mode}: long columns scroll internally`);
      assert.equal(columnGeometry.headStable, true);
      assert.equal(columnGeometry.pageOverflow, false, `${mode}: horizontal scrolling stays inside the board`);
      assert.equal(columnGeometry.previewCount, 2, `${mode}: multiple sessions have a bounded preview`);
      if(mode==='mobile')assert.ok(columnGeometry.columnWidth<columnGeometry.pageWidth, 'mobile leaves the adjacent column discoverable');
      await click('.task-board-sort');
      await click('[data-wand-popup-owner="任务排序"] [role=option][title="优先级优先"]');
      await wait("document.querySelector('.task-board-column.is-doing [data-task-id]')?.dataset.taskId==='sample-8'");
      assert.equal(await evaluate("document.querySelector('.task-board-column.is-doing .task-board-column-list').scrollTop"), 0, `${mode}: sorted leading tasks are visible`);
      assert.equal(await evaluate("JSON.parse(sessionStorage.getItem('wand.task-board.view-state')).sort"), 'priority');
      await settle(); await screenshot(`${mode}-board-dense`);
      await click('.task-board-sort'); await click('[data-wand-popup-owner="任务排序"] [role=option][title="默认顺序"]');
      await evaluate('tasks.boardTasks=null'); await click('[aria-label="刷新任务"]'); await wait("!!document.querySelector('[data-task-id=t1]')");
      // 其余视图分支同样过一遍库组件：列表行、概览指标卡、甘特图。
      await clickTab("列表"); await wait("!!document.querySelector('.task-board-list-row.ant-card')");
      assert.equal(await evaluate("!!document.querySelector('.task-board-list-title.ant-btn') && !!document.querySelector('.task-board-list-row .ant-tag')"), true, `${mode}: list rows use the library`);
      await click('.task-board-list-title');
      await wait("!!document.querySelector('.task-board-list-description .ant-typography-expand')");
      const collapsedDescriptionHeight = await evaluate("document.querySelector('.task-board-list-description').getBoundingClientRect().height");
      await click('.task-board-list-description .ant-typography-expand');
      assert.equal(await evaluate("document.querySelector('.task-board-list-description').getBoundingClientRect().height") > collapsedDescriptionHeight, true, `${mode}: full task description remains reachable`);
      await clickTab("概览"); await wait("!!document.querySelector('.task-board-metric.ant-card')");
      assert.equal(await evaluate("!!document.querySelector('.task-board-metric .ant-progress') && !!document.querySelector('.task-board-dashboard')"), true, `${mode}: dashboard metrics use the library`);
      assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"任务状态\"] .task-board-metric').length===3 && !!document.querySelector('.task-board-risk-panel') && !document.querySelector('.task-board-progress-chart')"), true, `${mode}: snapshot status distribution and overlapping risks are separate`);
      await screenshot(`${mode}-dashboard`);
      await clickTab("甘特图"); await wait("!!document.querySelector('.task-board-gantt')");
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `${mode}: gantt does not overflow`);
      const gantt = await evaluate("(()=>{const row=document.querySelector('.task-board-gantt-row');return {height:row.getBoundingClientRect().height,months:document.querySelector('.task-board-gantt-months').textContent,today:!!document.querySelector('.task-board-gantt [aria-current=date]'),line:!!document.querySelector('.task-board-gantt-today-line')}})()");
      assert.equal(gantt.height, 48, `${mode}: one task occupies one compact row`);
      assert.match(gantt.months, /年.*月/);
      const monthLabels = await evaluate("Array.from(document.querySelectorAll('.task-board-gantt-months .ant-typography')).map((n,i,a)=>({label:n.getAttribute('aria-label'),title:n.title,overflow:getComputedStyle(n).overflow,overlap:!!a[i+1]&&n.getBoundingClientRect().right>a[i+1].getBoundingClientRect().left+1}))");
      assert.ok(monthLabels.every((month) => month.title === month.label && /年.*月/.test(month.label) && month.overflow === 'hidden' && !month.overlap), `${mode}: narrow month segments preserve full labels without overlap`);
      assert.equal(gantt.today && gantt.line, true, `${mode}: dates are anchored to today`);
      await screenshot(`${mode}-gantt`);
      await clickTab("看板"); await wait("!!document.querySelector('[data-task-id=t1]')"); await settle();
      assert.equal(await evaluate("!!document.querySelector('[aria-label=\"筛选\"]')"), true, `${mode}: board toolbar keeps its controls`);
      await click('[aria-label="筛选"]'); await wait("!!document.querySelector('.task-board-filter-menu .ant-checkbox')");
      await click('.task-board-filter-menu .ant-checkbox-wrapper');
      assert.equal(await evaluate("!!document.querySelector('.task-board-filter-clear,button') && document.body.innerText.includes('清除筛选')"), true, `${mode}: filter applies in place`);
      await key("Escape"); await wait("!document.querySelector('.task-board-filter-menu')");
      assert.equal(await evaluate("!!document.querySelector('[aria-label^=\"移除状态筛选\"]')"), true, `${mode}: selected filters remain visible after closing the popup`);
      await click('[aria-label^="移除状态筛选"]');
      await wait("!document.querySelector('[aria-label^=\"移除状态筛选\"]')");
      // 看板筛选会持久化，清掉再跑下一种视口，避免下一种模式开局就是被筛选过的空列表。
      await wait("!document.body.innerText.includes('清除筛选')");
      await wait("!!document.querySelector('[data-task-id=t1]')");
      await click('[aria-label="新建任务"]'); await wait("!!document.querySelector('.task-board-create-title-input')");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"同时设为以后默认\"]').getAttribute('aria-checked')"), "false", `${mode}: future defaults opt-in starts unchecked`);
      const formGrid = await evaluate("(()=>{const n=document.querySelector('.task-board-create-properties');return{columns:getComputedStyle(n).gridTemplateColumns.split(' ').length,overflow:n.scrollWidth>n.clientWidth}})()");
      assert.equal(formGrid.columns, mode === 'mobile' ? 1 : 2);
      assert.equal(formGrid.overflow, false);
      // Changing and cancelling execution settings must leave later defaults untouched.
      await click('[aria-label="运行模式"]');
      await click('[data-wand-popup-owner="运行模式"] [role=option][title="完全访问"]');
      await wait("!!document.querySelector('.task-board-create-permission-note')");
      assert.equal(await evaluate("!!tasks.agentDefaults"), false);
      await key('Escape'); await wait("!document.querySelector('.task-board-create-title-input')");
      await click('[aria-label="新建任务"]'); await wait("!!document.querySelector('.task-board-create-title-input')");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"运行模式\"]').textContent"), '标准', `${mode}: cancelling execution choices preserves later defaults`);
      await click('[aria-label="运行模式"]');
      await click('[data-wand-popup-owner="运行模式"] [role=option][title="完全访问"]');
      await wait("!!document.querySelector('.task-board-create-permission-note')");
      await settle();
      await wait("document.querySelector('.task-board-create-title-input').getBoundingClientRect().width>0 && getComputedStyle(document.querySelector('.ant-modal-wrap')).visibility!=='hidden'");
      await click('.task-board-create-title-input');
      await screenshot(`${mode}-create-task`);
      await click('.task-board-create-title-input'); await send('Input.insertText',{text:'Submitted title'});
      await wait("document.querySelector('.task-board-create-title-input').value==='Submitted title' && !document.querySelector('.task-board-create-submit').disabled");
      await click('.task-board-create-submit'); await wait("!!tasks.createReceipt");
      await click('.task-board-create-title-input'); await send('Input.insertText',{text:' revised'});
      await evaluate("tasks.createReceipt()");
      await wait("document.querySelector('.task-board-create-title-input')?.value==='Submitted title revised'");
      assert.equal(await evaluate("tasks.createdInputs[0].rememberAgentDefaults"), false, `${mode}: unchecked create preserves defaults`);
      assert.equal(await evaluate("!!tasks.agentDefaults"), false);
      await click('[aria-label="同时设为以后默认"]');
      await click('.task-board-create-submit');
      await wait("tasks.createdInputs.length===2");
      assert.equal(await evaluate("!!tasks.agentDefaults"), false, `${mode}: opt-in waits for accepted create`);
      await evaluate("tasks.createReceipt()");
      await wait("!document.querySelector('.task-board-create-title-input')");
      assert.equal(await evaluate("tasks.createdInputs[1].rememberAgentDefaults"), true);
      assert.deepEqual(await evaluate("tasks.agentDefaults"), await evaluate("tasks.createdInputs[1].agent"));
      await click('[aria-label="新建任务"]');
      await wait("!!document.querySelector('.task-board-create-title-input')");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"同时设为以后默认\"]').getAttribute('aria-checked')"), 'false', `${mode}: each new task requires fresh opt-in`);
      await key('Escape');
      await wait("!document.querySelector('.task-board-create-title-input')");
      // Empty dataset and filtered dataset offer different next actions.
      await evaluate('tasks.boardTasks=[]'); await click('[aria-label="刷新任务"]');
      await wait("document.querySelector('.task-board-no-results h2')?.textContent==='还没有创建任务'");
      await click('[aria-label="搜索任务"]'); await send('Input.insertText',{text:'unmatched'});
      await wait("document.querySelector('.task-board-no-results h2')?.textContent==='没有找到匹配的任务'");
      await clickText('清除筛选');
      await wait("document.querySelector('.task-board-no-results h2')?.textContent==='还没有创建任务'");
      await evaluate('tasks.boardTasks=[{...tasks.baseTask,id:"archived-only",status:"archived"}]'); await click('[aria-label="刷新任务"]');
      await wait("document.body.innerText.includes('当前没有活动任务')");
      assert.match(await evaluate("document.querySelector('.task-board-result-summary').textContent"), /活动 0 · 归档 1/);
      await clickText('展开归档');
      await wait("document.querySelector('.task-board-archive-header')?.getAttribute('aria-expanded')==='true'");
      assert.match(await evaluate("document.querySelector('.task-board-result-summary').textContent"), /活动 0 · 归档 1/);
      await evaluate('tasks.boardTasks=null'); await click('[aria-label="刷新任务"]');
      await wait("!!document.querySelector('[data-task-id=t1]')");
      }
      if (boardOnly) {
        evidence.push({ mode, workflows: ["independent archive destination", "description disclosure", "status and risk grouping", "month and today markers", "compact Gantt rows", "stable active/archive counts", "explicit future-default opt-in", "grouped responsive task form", "first-use/filtered/archive-only empty states"] });
        console.log(`Task board browser passed: ${mode}`);
        continue;
      }
      await evaluate("tasks.show('new')"); await wait("!!document.getElementById('wand-new-session-cwd')");
      await click('[data-testid="new-session-dialog"] .ant-collapse-header'); await wait("!!document.querySelector('.ant-radio-group')");
      await click('#wand-new-session-cwd'); await send("Input.insertText",{text:"/tmp/project"});
      await click('.wand-new-session-submit'); await wait("document.body.innerText.includes('Local rejection keeps inputs')");
      assert.equal(await evaluate("document.getElementById('wand-new-session-cwd').value"), "/tmp/project", `${mode}: rejected creation retains draft`);
      await screenshot(`${mode}-new-session`);
      // 统一新建会话页的团队旁路（§5.1 修正 B8）：选团队 → 填本轮说明 → 直接开工，
      // 只发 note + workspaceId（不建会话、不下发 cwd），落地时开的是这次运行的群聊页。
      // 再开一次就是新的一次打开周期：表单按 initialCwd（空）重置，目录回落到运行时当前目录。
      await evaluate("tasks.show('new')");
      await wait("!!document.querySelector('[data-testid=new-session-dialog] input[value=\"team:audit-team\"]:not(:disabled)')");
      await click('[data-testid="new-session-dialog"] label:has(input[value="team:audit-team"])');
      await wait("document.querySelector('[data-testid=new-session-dialog] input[value=\"team:audit-team\"]').checked");
      await wait("!!document.getElementById('wand-new-session-team-note')");
      await wait("document.activeElement===document.getElementById('wand-new-session-team-note')");
      await send('Input.insertText',{text:'把登录页的错误提示改到原位'});
      await wait("document.getElementById('wand-new-session-team-note').value==='把登录页的错误提示改到原位'");
      assert.equal(await evaluate("document.querySelector('input[value=\"team:audit-team\"]').disabled"), false, `${mode}: 已有项目时团队可选`);
      await click('.wand-new-session-submit');
      await wait("!!tasks.teamRun");
      const directRun = await evaluate(`JSON.stringify({body:tasks.teamRun,post:tasks.requests.filter(r=>r.method==='POST').map(r=>r.url)})`);
      const direct = JSON.parse(String(directRun));
      assert.deepEqual(direct.body, { note: '把登录页的错误提示改到原位', workspaceId: 'w-audit' }, `${mode}: 团队直发只发 note + workspaceId`);
      assert.equal(direct.post.some((url: string) => url.includes('/api/ai-teams/audit-team/runs')), true, `${mode}: 团队直发走直发路由`);
      await wait("!document.querySelector('[data-testid=new-session-dialog]')");
      await wait("tasks.board()?.page==='teamchat'");
      assert.equal(await evaluate("tasks.board().runId"), "audit-team-run", `${mode}: 开团后落到这次运行的群聊页`);
      // 说明是必填的：清空后提交原位报错，不发第二次请求。
      await evaluate("tasks.teamRun=null");
      await evaluate("tasks.show('new')");
      await wait("!!document.querySelector('[data-testid=new-session-dialog] input[value=\"team:audit-team\"]')");
      await click('[data-testid="new-session-dialog"] label:has(input[value="team:audit-team"])');
      await wait("!!document.getElementById('wand-new-session-team-note')");
      await click('.wand-new-session-submit');
      await wait("document.body.innerText.includes('先写一句本轮说明')");
      assert.equal(await evaluate("tasks.teamRun===null && !!document.querySelector('[data-testid=new-session-dialog]')"), true, `${mode}: 缺说明不发请求、对话框留在原位`);
      await clickText("取消"); await wait("!document.querySelector('[data-testid=new-session-dialog]')");
      // 任务上下文不给团队：那张卡已经在了，从这里开团只会多建一张卡（§5.1）。
      await evaluate("tasks.show('new-task')");
      await wait("!!document.getElementById('wand-new-session-cwd')");
      assert.equal(await evaluate("!!document.querySelector('[data-testid=new-session-dialog] input[value^=\"team:\"]')"), false, `${mode}: 任务上下文不提供团队`);
      await clickText("取消"); await wait("!document.querySelector('[data-testid=new-session-dialog]')");
      await evaluate("tasks.show('folder')"); await wait("!!document.getElementById('wand-folder-picker-option-1')");
      await click('#wand-folder-picker-input'); await key('ArrowDown'); await key('ArrowDown'); await key('Enter');
      await wait("tasks.chosen==='/tmp/project'");
      await evaluate("tasks.show('quick')"); await wait("!!document.getElementById('wand-quick-message')");
      assert.equal(await evaluate("!!document.querySelector('.wand-quick-action-grid.ant-radio-group') && !!document.querySelector('.wand-quick-iteration .ant-checkbox')"), true);
      // 迭代/完整 diff 是一组单选：默认选迭代提示词，整组只占一个 Tab 停靠点，点击与方向键/Home 都换选中。
      const iterationMode = "document.querySelector('.wand-quick-iteration .ant-segmented-item-selected')?.innerText.trim()";
      const focusIterationMode = async (): Promise<void> => {
        // 对话框打开时会把焦点交给正文输入框，键盘用例先把焦点放回这组单选的选中项。
        await evaluate("document.querySelector('.wand-quick-iteration .ant-segmented-item-selected .ant-segmented-item-input').focus()");
      };
      assert.equal(await evaluate(`${iterationMode} === '迭代提示词' && Array.from(document.querySelectorAll('.wand-quick-iteration .ant-segmented-item-input')).filter(input => input.checked).length === 1`), true, `${mode}: iteration context defaults to a single checked prompt-entry mode`);
      assert.equal(await evaluate("(()=>{const group=document.querySelector('.wand-quick-iteration [role=radiogroup]');return group?.tabIndex===0})()"), true, `${mode}: the mode radio group is a single tab stop`);
      await click('.wand-quick-iteration .ant-segmented-item:has([data-stretch-value=diff])');
      await wait(`${iterationMode} === '完整 diff'`);
      await focusIterationMode();
      await key('ArrowLeft');
      await wait(`${iterationMode} === '迭代提示词'`);
      await click('.wand-quick-iteration .ant-segmented-item:has([data-stretch-value=diff])');
      await wait(`${iterationMode} === '完整 diff'`);
      await focusIterationMode();
      await key('Home');
      await wait(`${iterationMode} === '迭代提示词'`);
      await screenshot(`${mode}-quick`);
      await evaluate("tasks.show('merge')"); await wait("document.body.innerText.includes('Actual inspection row')");
      assert.equal(await evaluate("!!document.querySelector('.wand-worktree-commit-list.ant-list')"), true);
      if (!featureOnly) {
      await evaluate("tasks.show('github')"); await wait("!!document.querySelector('[placeholder=仓库所有者]')");
      await click('[placeholder=仓库所有者]'); await send('Input.insertText',{text:'fixture'});
      await click('[placeholder=仓库名]'); await send('Input.insertText',{text:'project'});
      await clickText("加载");
      await wait("document.body.innerText.includes('Library migration')");
      assert.equal(await evaluate("!!document.querySelector('.github-issue-card.ant-card')"), true);
      await click('[placeholder=新议题标题]'); await send('Input.insertText',{text:'Submitted issue'});
      await clickText("创建议题"); await wait("!!tasks.issueReceipt");
      await click('[placeholder=新议题标题]'); await send('Input.insertText',{text:' revised'}); await evaluate("tasks.issueReceipt()");
      await wait("document.querySelector('[placeholder=新议题标题]').value==='Submitted issue revised'");
      }
      await evaluate("tasks.show('missions')"); await wait("!!document.querySelector('.wand-missions-attempt.ant-card')");
      await clickText("审查 Diff");
      await wait("!!document.querySelector('.wand-missions-diff')");
      await clickText("新任务");
      await wait("!!document.querySelector('.wand-missions-create .ant-collapse')");
      await click('.wand-missions-create .ant-collapse-header'); await wait("document.body.innerText.includes('共享目录')");
      await screenshot(`${mode}-missions`);
      if (!featureOnly) {
      await evaluate("tasks.show('execution')"); await wait("document.body.innerText.includes('Actual child')");
      await click('.pi-execution-node:nth-child(3)');
      await wait("document.querySelector('.pi-execution-detail')?.textContent.includes('Child task')");
      assert.equal(await evaluate("document.querySelector('.pi-execution-detail').textContent.includes('Fixture node failed')"), true, `${mode}: real node error retained`);
      assert.equal(await evaluate("document.querySelectorAll('.pi-execution-node.ant-btn').length"), 2, `${mode}: executor node identities use library controls`);
      await screenshot(`${mode}-execution`); await key('Escape');
      await wait("document.activeElement.id==='outside'");
      }
      await evaluate("tasks.show('dispatch')"); await wait("!!document.getElementById('dispatch-member-a')");
      await click('#dispatch-member-a'); await wait("!JSON.parse(document.getElementById('selection').textContent).members.some(m=>m.employeeId==='a')");
      assert.equal(await evaluate("JSON.parse(document.getElementById('selection').textContent).leaderId"), 'b');
      await evaluate("tasks.show('pi')"); await wait("!!document.querySelector('[aria-label=\"CodeMode 模式\"]')");
      await click('[aria-label="CodeMode 模式"]'); await wait("!!document.querySelector('.wand-pi-codemode-s')");
      await click('.wand-pi-codemode-s [role=option]');
      assert.equal(await evaluate("document.querySelector('.wand-pi-settings').getAttribute('aria-hidden')"), 'false', `${mode}: Pi option keeps parent`);
      await click('[aria-label="启用 Installed Skill"]'); await wait("tasks.saved?.resources?.skills?.[0]==='skill-real'");
      await click('#outside'); await wait("document.querySelector('.wand-pi-settings').getAttribute('aria-hidden')==='true'");
      if (!featureOnly) {
      await evaluate("tasks.show('team')"); await wait("!!document.querySelector('[aria-label=回复负责人]')");
      await click('[aria-label=回复负责人]'); await send('Input.insertText',{text:'First reply'});
      await clickText("发送回复");
      await wait("!!tasks.deferred");
      await click('[aria-label=回复负责人]'); await send('Input.insertText',{text:' revised'}); await evaluate("tasks.deferred()");
      await wait("document.querySelector('[aria-label=回复负责人]').value==='First reply revised'");
      }
      const counts=await evaluate("({buttons:document.querySelectorAll('.ant-btn').length, overflow:document.documentElement.scrollWidth>innerWidth})");
      evidence.push({mode,pages:inventory,counts,scope:"actual production components with local repository fixtures; no installed acceptance"});
      console.log(`Task browser passed: ${mode}`);
    }
    assert.deepEqual(browserErrors, [], "no browser runtime exceptions");
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, artifactName), JSON.stringify({ passed: true, evidence, browserErrors, scope: "Task production-source fixtures in Chrome; final installed service acceptance remains integration-owned" }, null, 2));
  } catch (error) {
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, artifactName), JSON.stringify({ passed: false, evidence, browserErrors, error: String(error) }, null, 2));
    throw error;
  } finally {
    socket?.close();
    if (chrome.exitCode === null) { const stopped = once(chrome, "exit"); chrome.kill(); await stopped; }
    server.close(); rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
