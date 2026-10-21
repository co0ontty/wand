import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { openBrowser } from "./sidebar-ux-browser.mjs";

export async function runQueuedDirectoryBrowser() {
  const out = "output/architecture-stage2/employee-queued-ui/confirmed/browser";
  mkdirSync(out, { recursive: true });
  const source = `import React from 'react';import{createRoot}from'react-dom/client';
import{WandUiProvider}from'./src/web-ui/react/theme';import{installReactUiStyles}from'./src/web-ui/react/styles';
import{installSidebarStyles}from'./src/web-ui/react/shell/sidebar-styles';
import{WorkspacesPanel}from'./src/web-ui/react/workspaces/workspaces-panel';
import{MemoryUiAdapter}from'./src/web-ui/react/shell/ui-store';import{UiStoreProvider}from'./src/web-ui/react/shell/ui-store-react';
import{SidebarPresentationContext,useSidebarPresentation}from'./src/web-ui/react/workspaces/sidebar-display-mode';
import{configureWorkspacesRuntime}from'./src/web-ui/react/workspaces/controller';
import{setWandTheme}from'./src/web-ui/react/theme-preference';import{notifyTasksChanged}from'./src/web-ui/react/task-changes';
localStorage.setItem('wand.sidebar.displayMode','active');
const snapshot={auth:{phase:'authenticated'},viewport:{mobile:false,online:true},capabilities:{},layout:{sidebarAnchored:true,sidebarDrawer:false},selected:null,sidebar:{groups:[]},topbar:{}};
const store=new MemoryUiAdapter(snapshot);
window.queueFixture={selected:[],mutations:[],theme:setWandTheme};
configureWorkspacesRuntime({selectSession:id=>queueFixture.selected.push(id),openTask:({taskId})=>queueFixture.selected.push(taskId),refreshSessions:async()=>{},toast(){}});
const task=(id,name,extra={})=>({id,name,workspaceId:'w',status:'active',layout:null,cwd:'/fixture/wand',createdAt:'2026-10-01',worktree:null,sessions:[],...extra});
let groups=[{workspaceId:'w',workspaceName:'wand',workspaceCwd:'/fixture/wand',tasks:[
 task('goal','任务面板以用户目标为主任务'),
 task('child-q','明确任务验收状态与多会话归属',{parentWorkspaceTaskId:'goal',executionStatus:'queued',queuedExecutionCount:1}),
 task('child-r','任务看板负责人应保留员工身份',{parentWorkspaceTaskId:'goal',executionStatus:'running',queuedExecutionCount:1,sessions:[{id:'running-session',provider:'pi',sessionKind:'structured',title:'正在处理任务',status:'running',inFlight:true,cwd:'/fixture/wand'}]}),
 task('queued','修复 Web 批量删除目录功能这是一个很长的标题',{executionStatus:'queued',queuedExecutionCount:1}),
 task('idle','空闲但有历史的工作',{sessions:[{id:'idle-session',status:'idle',title:'空闲会话',sessionKind:'structured',provider:'pi'}]}),
],standaloneSessions:[]}];
window.fetch=async(input,init)=>{const url=String(input);if(init?.method&&init.method!=='GET'){queueFixture.mutations.push(url);throw Error('No mutations allowed');}let body=url.startsWith('/api/tasks')?{groups,revision:String(Date.now()),unchanged:false}:url.includes('ai-team-runs')?{runs:[]}:[];return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})};
queueFixture.state=value=>{groups=groups.map(g=>({...g,tasks:g.tasks.map(t=>t.id==='queued'?{...t,executionStatus:value,queuedExecutionCount:value==='queued'?1:0,sessions:value==='running'?[{id:'late-runner',provider:'pi',sessionKind:'structured',status:'running',inFlight:true,title:'开始执行',cwd:'/fixture/wand'}]:[]}:t)}));notifyTasksChanged()};
function App(){const presentation=useSidebarPresentation();queueFixture.mode=presentation.setMode;queueFixture.query=presentation.setQuery;return <WandUiProvider><UiStoreProvider store={store}><SidebarPresentationContext.Provider value={presentation}><aside className='sidebar sidebar-refined' id='queue-sidebar' style={{width:288,height:800,overflow:'auto',background:'var(--sidebar-surface)'}}><WorkspacesPanel/></aside></SidebarPresentationContext.Provider></UiStoreProvider></WandUiProvider>}
installReactUiStyles();installSidebarStyles();createRoot(document.getElementById('root')).render(<App/>);`;
  const bundle = await build({ stdin: { contents: source, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); }
    else if (req.url === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); }
    else { res.setHeader("content-type", "text/html;charset=utf-8"); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:var(--bg-primary)}#root{padding:16px}.workspace-task-children{min-width:0}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let b; const checks = [];
  const row = id => `[data-workspace-task-id="${id}"] > .workspace-task`;
  try {
    b = await openBrowser(`http://127.0.0.1:${server.address().port}`, 900, 900);
    await b.wait("!!window.queueFixture?.mode && !!document.querySelector('[data-workspace-task-id=queued] .sidebar-task-status')");
    const geometry = [];
    for (const theme of ["warm", "graphite"]) for (const width of [288, 240]) {
      await b.evaluate(`queueFixture.theme(${JSON.stringify(theme)});document.querySelector('#queue-sidebar').style.width='${width}px';true`);
      await b.settle();
      const facts = await b.evaluate(`(()=>{const root=document.querySelector('#queue-sidebar');return {overflow:root.scrollWidth>root.clientWidth,rows:[...root.querySelectorAll('.workspace-task')].filter(n=>n.getBoundingClientRect().height>0).map(n=>{const s=n.querySelector('.sidebar-task-status');const title=n.querySelector('.workspace-task-name');return {name:title?.textContent,icons:n.querySelectorAll(':scope > [data-wand-icon]').length,status:s?.textContent,statusHeight:s?.getBoundingClientRect().height,statusWhiteSpace:s&&getComputedStyle(s).whiteSpace,emptyCount:n.querySelector('.workspace-task-count')?.textContent==='0',titleWidth:title?.getBoundingClientRect().width}})}})()`);
      assert.equal(facts.overflow, false, JSON.stringify({ theme, width, facts }));
      for (const item of facts.rows) {
        assert.equal(item.icons, 0); assert.equal(item.emptyCount, false);
        assert.ok(item.titleWidth > 40, JSON.stringify(item));
        if (item.status) { assert.ok(item.statusHeight <= 20, JSON.stringify(item)); assert.equal(item.statusWhiteSpace, "nowrap"); }
      }
      geometry.push({ theme, width, facts });
      await b.screenshot(`${out}/${theme}-${width}.png`);
    }
    checks.push("real production task rows keep status horizontal at 288/240px in warm/graphite; no decorative prefix or zero counts");
    assert.equal(await b.evaluate("document.querySelector('[data-workspace-task-id=goal] .workspace-task-count').textContent"), "2 项");
    assert.equal(await b.evaluate("document.querySelector('[data-workspace-task-id=child-r] .sidebar-task-status').textContent.trim()"), "运行中");
    assert.equal(await b.evaluate("!!document.querySelector('[data-workspace-task-id=idle]')"), false);
    assert.equal(await b.evaluate("document.querySelector('#queue-sidebar').textContent.includes('子任务有执行记录')"), false);
    checks.push("queued zero-session work survives active filtering; running wins over queued follow-ups; parent shows real child count");
    await b.click('[data-workspace-task-id=goal] > .workspace-task .workspace-task-disclosure');
    await b.wait("document.querySelector('[data-workspace-task-id=child-q]')?.getBoundingClientRect().height===0 || !document.querySelector('[data-workspace-task-id=child-q]')");
    await b.click('[data-workspace-task-id=goal] > .workspace-task .workspace-task-disclosure');
    await b.wait("document.querySelector('[data-workspace-task-id=child-q]')?.getBoundingClientRect().height>0");
    checks.push("inline parent arrow collapses and reopens actual child rows");
    await b.evaluate("queueFixture.state('running');true");
    await b.wait("document.querySelector('[data-workspace-task-id=queued] .sidebar-task-status')?.textContent.trim()==='运行中'");
    await b.evaluate("queueFixture.state(null);true");
    await b.wait("!document.querySelector('[data-workspace-task-id=queued]')");
    await b.evaluate("queueFixture.mode('full');true");
    await b.wait("!!document.querySelector('[data-workspace-task-id=idle]')");
    await b.evaluate("queueFixture.query('明确任务');true");
    await b.wait("document.querySelector('[data-workspace-task-id=child-q]')?.getBoundingClientRect().height>0");
    checks.push("queue-to-running-to-cancelled refreshes the real projection; full and search retain the appropriate parent context");
    await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await b.evaluate("queueFixture.query('');queueFixture.state('queued');queueFixture.mode('active');true");
    await b.wait("!!document.querySelector('[data-workspace-task-id=queued] .sidebar-task-status')");
    await b.settle();
    assert.equal(await b.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
    const statusHeight = await b.evaluate("document.querySelector('[data-workspace-task-id=queued] .sidebar-task-status').getBoundingClientRect().height");
    assert.ok(statusHeight <= 20);
    assert.deepEqual(await b.evaluate("queueFixture.mutations"), []); assert.deepEqual(b.errors, []);
    await b.screenshot(`${out}/narrow-reduced.png`);
    writeFileSync(`${out}/result.json`, JSON.stringify({ passed: true, scope: "Production components + isolated HTTP-shaped data, not installed service", checks, geometry }, null, 2));
    console.log(JSON.stringify({ passed: true, checks }));
  } catch (error) {
    if (b) { await b.screenshot(`${out}/failure.png`); writeFileSync(`${out}/failure.json`, JSON.stringify({ error: String(error), checks, body: await b.evaluate("document.body.innerText.slice(0,2500)") }, null, 2)); }
    throw error;
  } finally { await b?.close(); await new Promise(resolve => server.close(resolve)); }
}
if (process.argv[1]?.endsWith("queue-directory-browser.mjs")) await runQueuedDirectoryBrowser();
