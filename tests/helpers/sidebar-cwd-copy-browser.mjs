import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { openBrowser } from "./sidebar-ux-browser.mjs";

const out = "output/architecture-stage2/sidebar-cwd-copy";
mkdirSync(out, { recursive: true });
const source = `import React from 'react';import{createRoot}from'react-dom/client';
import{WandUiProvider}from'./src/web-ui/react/theme';import{installReactUiStyles}from'./src/web-ui/react/styles';
import{WorkspacesPanel}from'./src/web-ui/react/workspaces/workspaces-panel';
import{SidebarSessionMenu}from'./src/web-ui/react/workspaces/sidebar-session-menu';
import{WorkbarLeading}from'./src/web-ui/react/shell/workbar-actions';
import{MemoryUiAdapter}from'./src/web-ui/react/shell/ui-store';import{UiStoreProvider}from'./src/web-ui/react/shell/ui-store-react';
import{configureWorkspacesRuntime}from'./src/web-ui/react/workspaces/controller';
window.fixture={copies:[],nativeCopies:[],selected:[],actions:[],fail:false,mutations:[]};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(fixture.fail)throw Error('剪贴板访问被拒绝');fixture.copies.push(text)}}});
fixture.native=()=>{document.documentElement.classList.add('is-wand-app');window.WandNative={copyToClipboard:text=>{fixture.nativeCopies.push(text);return 'ok'}}};
configureWorkspacesRuntime({selectSession:id=>fixture.selected.push(id),openTask:()=>fixture.selected.push('task'),refreshSessions:async()=>{},toast(){}});
const snapshot={auth:{phase:'authenticated'},viewport:{mobile:false,online:true},capabilities:{},layout:{sidebarAnchored:true,sidebarDrawer:false},selected:{id:'active',cwd:'/active'},sidebar:{groups:[]},topbar:{}};
const memory=new MemoryUiAdapter(snapshot);const store={getSnapshot:()=>memory.getSnapshot(),subscribe:f=>memory.subscribe(f),dispatch:a=>fixture.actions.push(a)};
const sessions=[{id:'other',cwd:'/server/另一目录 with spaces ',title:'非当前会话'},{id:'empty',cwd:'  ',title:'目录尚未读取'},{id:'archived',cwd:'/server/archive',title:'归档会话',archived:true}];
installReactUiStyles();createRoot(document.getElementById('root')).render(<WandUiProvider><UiStoreProvider store={store}><div className='wand-workbar-host'><WorkbarLeading/></div><div style={{display:'flex',gap:24}}><div style={{width:320}}><WorkspacesPanel selectedSessionId='active'/></div><div>{sessions.map(s=><SidebarSessionMenu key={s.id} session={s} label={s.title} onOpen={()=>fixture.selected.push(s.id)} row={<div id={'row-'+s.id} style={{padding:16}}><button>{s.title}</button></div>}/>)}</div></div></UiStoreProvider></WandUiProvider>);`;
const bundle = await build({ stdin: { contents: source, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
const groups = [{ workspaceId: "w", workspaceName: "项目目录", workspaceCwd: "/server/project", tasks: [{ id: "t", name: "隔离任务", cwd: "/server/project", worktree: { path: "/server/worktree", branch: "feature" }, sessions: [{ id: "task-session", title: "任务会话", provider: "pi", cwd: "/server/worktree", status: "idle", startedAt: "2026-10-01" }], status: "active", createdAt: "2026-10-01" }], standaloneSessions: [] }];
let mutations = 0;
const server = createServer((req, res) => {
  if (req.method !== "GET") mutations++;
  if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); }
  else if (req.url === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); }
  else if (req.url.startsWith("/api/")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url.startsWith("/api/tasks") ? { groups } : req.url.includes("ai-team-runs") ? { runs: [] } : {})); }
  else { res.setHeader("content-type", "text/html;charset=utf-8"); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const checks = [];
try {
  browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, 1280, 900);
  await browser.wait("!!document.querySelector('.workspace-task')");
  const menu = ".ant-dropdown:not(.ant-dropdown-hidden)";
  const open = async selector => { await browser.click(selector, "right"); await browser.wait(`!!document.querySelector('${menu} [role=menu]')`); };
  const copy = async () => {
    await browser.evaluate(`[...document.querySelectorAll('${menu} [role=menuitem]')].find(n=>n.textContent==='复制工作目录').id='copy-target';true`);
    await browser.click("#copy-target");
  };
  const closed = () => browser.wait(`!document.querySelector('${menu}')`);
  assert.equal(await browser.evaluate("!document.querySelector('.workbar-context')"), true);
  checks.push("workbar renders no directory label, dropdown or disclosure arrow");
  await open("#row-other"); await copy(); await closed();
  assert.deepEqual(await browser.evaluate("fixture.copies"), ["/server/另一目录 with spaces "]);
  assert.deepEqual(await browser.evaluate("fixture.selected"), []);
  assert.deepEqual(await browser.evaluate("fixture.actions"), []);
  checks.push("right-clicking an inactive session copies its own exact path without selecting it");
  await open("#row-empty");
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('${menu} [role=menuitem]')].some(n=>n.textContent==='复制工作目录')`), false);
  await browser.key("Escape"); await closed();
  await open("#row-archived"); await copy(); await closed();
  assert.equal(await browser.evaluate("fixture.copies.at(-1)"), "/server/archive");
  checks.push("missing paths have no copy action; archived sessions retain it; Escape closes");
  await browser.evaluate("fixture.fail=true;true");
  await open("#row-other"); await copy();
  await browser.wait(`!!document.querySelector('${menu} [role=alert]')`);
  assert.match(await browser.evaluate(`document.querySelector('${menu} [role=alert]').textContent`), /剪贴板访问被拒绝/);
  await browser.evaluate("fixture.fail=false;true"); await copy(); await closed();
  checks.push("clipboard denial stays in the same menu and supports retry");
  await open(".workspace-row-main"); await copy(); await closed();
  assert.equal(await browser.evaluate("fixture.copies.at(-1)"), "/server/project");
  await open(".workspace-task-main"); await copy(); await closed();
  assert.equal(await browser.evaluate("fixture.copies.at(-1)"), "/server/worktree");
  checks.push("directory and task menus copy their own paths; isolated tasks use worktree path");
  await browser.evaluate("fixture.native();true");
  await open("#row-other"); await copy(); await closed();
  assert.equal(await browser.evaluate("fixture.nativeCopies.at(-1)"), "/server/另一目录 with spaces ");
  checks.push("native web shell uses the existing native clipboard bridge");
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?reactUi=0` });
  await browser.wait("!!document.querySelector('#row-other')");
  await open("#row-other"); await browser.key("Escape"); await closed();
  checks.push("rollback query retains the shared context menu and Escape close");
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await open(".workspace-row-main"); await copy(); await closed();
  assert.equal(await browser.evaluate("fixture.copies.at(-1)"), "/server/project");
  assert.equal(mutations, 0);
  assert.deepEqual(browser.errors, []);
  checks.push("narrow/reduced-motion context copy works; no business mutations or page errors");
  await browser.screenshot(`${out}/browser.png`);
  writeFileSync(`${out}/browser.json`, JSON.stringify({ passed: true, checks, scope: "Production components with isolated data, not installed-service acceptance" }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  if (browser) { await browser.screenshot(`${out}/failure.png`); writeFileSync(`${out}/failure.json`, JSON.stringify({ error: String(error), checks, errors: browser.errors, body: await browser.evaluate('document.body.innerText.slice(0,3000)') }, null, 2)); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
