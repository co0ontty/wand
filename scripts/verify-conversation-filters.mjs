// Current production unified sidebar; isolated fixtures, no model or service mutations.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { openPlushBrowser, closeFixtureServer } from "./design-previews/helpers/browser-harness.mjs";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, process.env.WAND_CONVERSATION_FILTER_OUTPUT || "output/conversation-filters/web");
mkdirSync(out, { recursive: true });
const avatar = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#aaa"/></svg>').toString("base64");
const session = (id, title, employeeId, status, extra = {}) => ({ id, title, employeeId, employeeName: employeeId === "e-a" ? "筛选测试甲" : "筛选测试乙", status,
  provider: "pi", sessionKind: "structured", workspaceTaskId: "task-" + (id === "s-b" ? "b" : "a"), ...extra });
const group = (id, sessions) => ({ workspaceId: id, workspaceName: id === "a" ? "Wand" : "DiPlay", workspaceCwd: "/fixture/" + id,
  userAdded: true, standaloneSessions: [], tasks: [{ id: "task-" + id, workspaceId: id, name: "任务" + id, status: "active", worktree: null,
    layout: null, createdAt: "", lastOpenedAt: null, isolated: false, boardTaskId: "board-" + id, boardTaskStatus: "doing", sessions }] });
const groups = [group("a", [session("s-a", "验收报告", "e-a", "running", { inFlight: true }), session("s-c", "乙的日志", "e-b", "idle"),
  session("s-d", "归档历史", "e-a", "idle", { archived: true })]), group("b", [session("s-b", "执行日志", "e-a", "idle")])];
const source = `
import * as React from 'react'; import {createRoot} from 'react-dom/client';
import {SidebarFilterCapsules, UnifiedSidebarList, useUnifiedSidebar} from './src/web-ui/react/conversations/unified-sidebar';
import {WandSearchField} from './src/web-ui/react/ui/search-field';
import {WandUiProvider} from './src/web-ui/react/theme';
import {PortalContainerProvider} from './src/web-ui/react/ui/portal-context';
import {installReactUiStyles} from './src/web-ui/react/styles';
import {installSidebarStyles} from './src/web-ui/react/shell/sidebar-styles';
import {conversationUi} from './src/web-ui/react/conversations/state';
import {taskGroupsStore} from './src/web-ui/react/workspaces/task-groups-store';
installReactUiStyles(); installSidebarStyles();
window.fixture={conversationUi,taskGroupsStore};
const titles={};
function Host(){const model=useUnifiedSidebar(true,titles);return <>
  <div style={{width:64,flexShrink:0}}><SidebarFilterCapsules model={model} enabled/></div>
  <aside className='sidebar' style={{width:256,minWidth:0,height:'100dvh',position:'static',display:'flex'}}>
    <WandSearchField className='fixture-search' label='搜索会话' value={model.query} onValueChange={value=>conversationUi.filter('list-query',value)}/>
    <UnifiedSidebarList model={model} titles={titles} selectedSessionId={null} selectedConversationId={null} onOpen={()=>{throw Error('Filter navigated')}} onCreate={()=>{throw Error('Filter created session')}} enabled/>
  </aside><main id='outside'>当前对话保持不变<textarea aria-label='原对话草稿' defaultValue='保留我的草稿'/></main></>}
createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('portals')}><WandUiProvider><Host/></WandUiProvider></PortalContainerProvider>);
`;
await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  outfile: join(out, "fixture.js"), define: { "process.env.NODE_ENV": '"production"' } });
let failGroups = false;
const requests = [];
const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  requests.push({ method: req.method, path });
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
  if (path === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(join(out, "fixture.js"))); return; }
  if (path === "/styles.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
  if (path.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    if (path === "/api/tasks" && failGroups) { res.writeHead(503); res.end(JSON.stringify({ error: "fixture unavailable" })); return; }
    const body = path === "/api/tasks" ? groups : path === "/api/conversations" ? { conversations: [] }
      : path === "/api/silicon-employees" ? { employees: ["e-a", "e-b"].map((id, index) => ({ id, name: index ? "筛选测试乙" : "筛选测试甲", duty: "fixture", agents: [], tags: [], avatar })) }
        : path === "/api/sessions" ? [] : path === "/api/user-profile" ? { name: "测试用户" } : {};
    res.end(JSON.stringify(body)); return;
  }
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="display:flex;height:100dvh"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
let browser;
const cases = [];
try {
  browser = await openPlushBrowser(1000, 850, false, "no-preference");
  const e = expression => browser.evaluate(expression);
  const button = label => `button[aria-label=${JSON.stringify(label)}]`;
  const rows = () => e("[...document.querySelectorAll('[data-unified-session]')].map(n=>n.dataset.unifiedSession).sort()");
  const expectRows = async ids => {
    await browser.wait(`JSON.stringify([...document.querySelectorAll('[data-unified-session]')].map(n=>n.dataset.unifiedSession).sort())===${JSON.stringify(JSON.stringify(ids.slice().sort()))}`);
    assert.deepEqual(await rows(), ids.slice().sort());
    assert.match(await e("document.querySelector('.unified-sidebar-tools [role=status]').textContent"), new RegExp(`^${ids.length} 个会话`));
  };
  const focusCapsule = async label => {
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 800 });
    await e(`document.querySelector('[aria-label=原对话草稿]').focus();document.querySelector(${JSON.stringify(button(label))}).focus()`);
    await browser.settle();
  };
  const choose = async label => { await browser.click(button(label)); };
  const clear = async () => { await browser.clickText("清除筛选"); await browser.settle(); };
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const motion of ["no-preference", "reduce"]) {
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
    await browser.send("Page.navigate", { url });
    await browser.wait("!!window.fixture && document.querySelectorAll('[data-unified-session]').length===3");
    await expectRows(["s-a", "s-b", "s-c"]);
    const before = await e("(()=>{const r=document.querySelector('.fixture-search').getBoundingClientRect();return[r.x,r.y,r.width,r.height]})()");
    await focusCapsule("筛选运行状态：全部"); await choose("筛选运行状态：运行中");
    await expectRows(["s-a"]);
    await focusCapsule("筛选工作区：全部工作区"); await choose("筛选工作区：Wand");
    await focusCapsule("筛选员工：全部员工"); await choose("筛选员工：筛选测试甲");
    await expectRows(["s-a"]);
    await e("window.fixture.conversationUi.filter('list-query','执行日志')");
    await expectRows([]);
    await clear(); await expectRows(["s-b"]);
    assert.equal(await e("document.querySelector('[aria-label=搜索会话]').value"), "执行日志");
    assert.equal(await e("document.querySelector('[aria-label=原对话草稿]').value"), "保留我的草稿");
    await e("window.fixture.conversationUi.filter('list-query','')");
    await expectRows(["s-a", "s-b", "s-c"]);
    await focusCapsule("筛选工作区：全部工作区"); await choose("筛选工作区：Wand");
    await choose("筛选工作区：DiPlay"); await expectRows(["s-a", "s-b", "s-c"]);
    await focusCapsule("筛选员工：全部员工"); await choose("筛选员工：筛选测试乙");
    await expectRows(["s-c"]);
    await clear(); await expectRows(["s-a", "s-b", "s-c"]);
    await focusCapsule("筛选运行状态：全部"); await choose("筛选运行状态：已归档");
    await expectRows(["s-d"]); await clear();
    assert.deepEqual(await e("(()=>{const r=document.querySelector('.fixture-search').getBoundingClientRect();return[r.x,r.y,r.width,r.height]})()"), before);
    await focusCapsule("筛选工作区：全部工作区"); await choose("搜索工作区");
    await browser.wait("!!document.querySelector('.sidebar-capsule-picker input[aria-label=搜索工作区]')");
    await browser.click('.sidebar-capsule-picker input[aria-label="搜索工作区"]');
    await browser.send("Input.insertText", { text: "Wand" });
    assert.equal(await e("!!document.querySelector('.sidebar-capsule-picker')"), true, "search input retains its popup");
    await browser.key("Escape"); await browser.wait("!document.querySelector('.sidebar-capsule-picker')");
    await focusCapsule("筛选工作区：全部工作区"); await choose("搜索工作区");
    await browser.wait("!!document.querySelector('.sidebar-capsule-picker')");
    await browser.click("#outside"); await browser.wait("!document.querySelector('.sidebar-capsule-picker')");
    await focusCapsule("筛选员工：全部员工"); await choose("搜索员工");
    await browser.wait("!!document.querySelector('.sidebar-capsule-picker input[aria-label=搜索员工]')");
    await browser.click('.sidebar-capsule-picker input[aria-label="搜索员工"]');
    await browser.send("Input.insertText", { text: "筛选测试乙" });
    await browser.wait("document.querySelector('.sidebar-capsule-options').textContent.includes('筛选测试乙') && !document.querySelector('.sidebar-capsule-options').textContent.includes('筛选测试甲')");
    await browser.clickText("筛选测试乙"); await expectRows(["s-c"]);
    await browser.key("Escape"); await browser.wait("!document.querySelector('.sidebar-capsule-picker')");
    await clear();
    assert.equal(await e("document.querySelector('[aria-label=原对话草稿]').value"), "保留我的草稿");
    cases.push(`${motion}: current unified list, runtime/workspace/employee AND, workspace multi-select, counts, archived opt-in, clear retains search/draft, stable search bounds, popup search/selection/outside/Escape`);
  }
  for (const width of [390, 320]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await focusCapsule("筛选员工：全部员工"); await choose("搜索员工");
    await browser.wait("!!document.querySelector('.sidebar-capsule-picker')");
    assert.equal(await e("(()=>{const r=document.querySelector('.sidebar-capsule-picker').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"), true);
    await browser.screenshot(join(out, `narrow-${width}.png`));
    await browser.key("Escape"); await browser.wait("!document.querySelector('.sidebar-capsule-picker')");
    cases.push(`${width}px: current employee picker remains in viewport and closes with Escape`);
  }
  failGroups = true; await e("window.fixture.taskGroupsStore.reload()");
  await browser.wait("!!document.querySelector('.unified-sidebar-tools [role=alert]')");
  await expectRows(["s-a", "s-b", "s-c"]);
  assert.equal(await e("!!document.querySelector('.unified-sidebar-empty')"), false, "failed reload retains last successful snapshot");
  assert.deepEqual(browser.errors, []);
  assert.equal(requests.some(req => req.method !== "GET"), false);
  writeFileSync(join(out, "verification.json"), JSON.stringify({ ok: true, fixtureOnly: true, installedService: false, modelCalls: 0, cases, requests }, null, 2));
  console.log(JSON.stringify({ ok: true, cases, out }, null, 2));
} catch (error) {
  if (browser) {
    console.log(JSON.stringify({ errors: browser.errors, body: await browser.evaluate("document.body.innerText.slice(0,1800)"), capsules: await browser.evaluate("[...document.querySelectorAll('.sidebar-filter-capsule')].map(n=>({label:n.getAttribute('aria-label'),expanded:n.dataset.expanded,buttons:[...n.querySelectorAll('button')].map(b=>b.getAttribute('aria-label'))}))"), requests: requests.slice(-18) }, null, 2));
    await browser.screenshot(join(out, "failure.png"));
  }
  throw error;
} finally {
  try { await browser?.close(); } finally { await closeFixtureServer(server); }
}
