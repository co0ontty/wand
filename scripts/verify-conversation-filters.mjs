// Real production sidebar/components; isolated fixture data, never model calls.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { openPlushBrowser, closeFixtureServer } from "design-previews/helpers/browser-harness.mjs";
const root = resolve(import.meta.dirname, "..");
const out = join(root, "output/conversation-filters/web"); mkdirSync(out, { recursive: true });
const person = (id, name) => ({ id, owner: "local-owner", kind: "dm", peerEmployeeId: id, title: name, name, nameSource: "auto", sourceTemplateId: null,
  team: null, memberVersion: 1, joinedVersions: {}, sessionId: null, communicationSessionId: null, createdAt: "", updatedAt: "", tasks: [], preview: "工作记录", messageAt: "" });
const people = [person("e-a", "筛选测试甲"), person("e-b", "筛选测试乙")];
const group = (id, stage, employee) => ({ workspaceId: id, workspaceName: id === "a" ? "Wand" : "DiPlay", workspaceCwd: "/fixture/" + id, standaloneSessions: [], tasks: [{
  id: "task-" + id, workspaceId: id, name: "任务" + id, status: "active", worktree: null, layout: null, createdAt: "", lastOpenedAt: null, isolated: false,
  boardTaskId: "board-" + id, boardTaskStatus: stage, sessions: [{ id: "s-" + id, title: id === "a" ? "验收报告" : "执行日志", employeeId: employee, workspaceTaskId: "task-" + id, status: "idle", provider: "pi" }],
}] });
const groups = [group("a", "review", "e-a"), group("b", "doing", "e-a")];
const source = `
import * as React from 'react'; import {createRoot} from 'react-dom/client';
import {ConversationSidebarList} from './src/web-ui/react/conversations/sidebar';
import {WandUiProvider} from './src/web-ui/react/theme';
import {PortalContainerProvider} from './src/web-ui/react/ui/portal-context';
import {installReactUiStyles} from './src/web-ui/react/styles';
import {installSidebarStyles} from './src/web-ui/react/shell/sidebar-styles';
import {conversationUi} from './src/web-ui/react/conversations/state';
import {taskGroupsStore} from './src/web-ui/react/workspaces/task-groups-store';
installReactUiStyles(); installSidebarStyles();
window.fixture={conversationUi,taskGroupsStore};
createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('portals')}><WandUiProvider><aside className='sidebar' style={{width:288,height:'100dvh',position:'static',display:'flex',padding:8}}><ConversationSidebarList compact={false} onNavigate={()=>{throw Error('Filter navigated')}} onOpenSession={()=>{}}/></aside><main id='outside'>当前对话保持不变<textarea aria-label='原对话草稿' defaultValue='保留我的草稿'/></main></WandUiProvider></PortalContainerProvider>);
`;
await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(out, "fixture.js"), define: { "process.env.NODE_ENV": '"production"' } });
let failGroups = false;
const requests = [];
const server = createServer((req, res) => {
  requests.push({ method: req.method, path: req.url.split("?")[0] });
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
  const path = req.url.split("?")[0];
  if (path === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(join(out,"fixture.js"))); return; }
  if (path === "/styles.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root,"src/web-ui/content/styles.css"))); return; }
  if (path.includes("plushAvatarChunkSrc")) { res.setHeader("Content-Type", "text/javascript"); res.end("/* fixture intentionally uses static avatars */"); return; }
  if (path.startsWith("/api/")) {
    res.setHeader("Content-Type","application/json");
    if(path==="/api/tasks" && failGroups) {res.writeHead(503);res.end(JSON.stringify({error:"fixture unavailable"}));return;}
    const body = path==="/api/conversations" ? {conversations:people} : path==="/api/tasks" ? groups
      : path==="/api/silicon-employees" ? {employees:people.map(person=>({id:person.id,name:person.name,duty:"fixture",candidates:[],tags:[],avatar:"data:image/svg+xml;base64,"+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#aaa"/></svg>').toString('base64')}))} : path==="/api/sessions" ? [] : path==="/api/user-profile" ? {name:"测试用户"} : {};
    res.end(JSON.stringify(body));return;
  }
  res.setHeader("Content-Type","text/html;charset=utf-8");
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="display:flex;height:100dvh"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
let browser; const cases=[];
try {
  browser=await openPlushBrowser(1000,850,false,"no-preference");
  const e=expression=>browser.evaluate(expression);
  const click=async selector=>{
    const s=JSON.stringify(selector);
    await browser.wait(`!!document.querySelector(${s})`);
    await e(`document.querySelector(${s}).scrollIntoView({block:'nearest',behavior:'instant'})`);
    await browser.settle();
    await browser.wait(`(()=>{const n=document.querySelector(${s}),r=n?.getBoundingClientRect();if(!r)return false;const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===n||!!h&&n.contains(h)})()`);
    const point=await e(`(()=>{const r=document.querySelector(${s}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for(const type of ["mousePressed","mouseReleased"])await browser.send("Input.dispatchMouseEvent",{type,...point,button:"left",clickCount:1});
    await browser.settle();
  };
  const byText=async text=>{const selector=await e(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.getClientRects().length&&n.textContent.trim().replaceAll(' ','')===${JSON.stringify(text)});if(!n)throw Error('missing button');n.dataset.fixtureClick='yes';return '[data-fixture-click=yes]'})()`);await click(selector);await e("document.querySelector('[data-fixture-click]')?.removeAttribute('data-fixture-click')");};
  const url=`http://127.0.0.1:${server.address().port}/`;
  for(const motion of ["no-preference","reduce"]) {
    await browser.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:motion}]});
    await browser.send("Page.navigate",{url});
    await browser.wait("document.querySelector('.conversation-list-count')?.textContent.includes('2 条关联会话')");
    await e("window.fixture.conversationUi.listFacets({taskStage:'all',workspace:'all',archive:'all',activityOnly:false})");
    await browser.settle();
    const trigger=".conversation-list-filter-trigger";
    const bounds=()=>e("(()=>{const r=document.querySelector('.conversation-search-host').getBoundingClientRect();return[r.x,r.y,r.width,r.height]})()");
    const before=await bounds();
    await click(trigger);
    await click('[data-conversation-filter-field="taskStage"] .ant-select');
    await click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="待验收"]');
    await click('[data-conversation-filter-field="workspace"] .ant-select');
    await browser.send("Input.insertText",{text:"Wand"});
    await browser.wait("document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').length===1");
    assert.equal(await e("!!document.querySelector('.conversation-list-filter-panel')"),true,'workspace search retains parent');
    await click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="Wand"]');
    await byText("应用筛选");
    await browser.wait("!document.querySelector('.conversation-list-filter-panel')");
    assert.deepEqual(await bounds(),before);
    assert.equal(await e("document.querySelectorAll('.conversation-row').length"),1);
    assert.match(await e("document.querySelector('.conversation-list-count').textContent"),/1 个对话 · 1 条关联会话匹配/);
    assert.match(await e("document.querySelector('.conversation-row-preview').textContent"),/1 条会话/);
    // Cancel/Escape must not commit a draft.
    await click(trigger);await click('[data-conversation-filter-field="taskStage"] .ant-select');
    await browser.key("Escape");
    assert.equal(await e("!!document.querySelector('.conversation-list-filter-panel')"),true,'first Escape closes child only');
    await click('[data-conversation-filter-field="taskStage"] .ant-select');
    await click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="执行中"]');
    await browser.key("Escape");
    assert.equal(await e("window.fixture.conversationUi.getSnapshot().listTaskStage"),"review");
    await click(trigger);await click('[aria-label="原对话草稿"]');await browser.wait("!document.querySelector('.conversation-list-filter-panel')");
    console.log('checkpoint',motion,'reset-cancel');
    await click(trigger);await byText("重置");await byText("取消");
    assert.equal(await e("window.fixture.conversationUi.getSnapshot().listWorkspace"),"id:a");
    console.log('checkpoint',motion,'query');
    await e("window.fixture.conversationUi.filter('list-query','执行日志')");
    await browser.wait("!!document.querySelector('.conversation-list-empty')");
    console.log('checkpoint',motion,'clear');
    await byText("清除筛选");
    assert.equal(await e("document.querySelector('[aria-label=\"搜索对话或任务\"]').value"),"执行日志");
    assert.equal(await e("document.querySelector('[aria-label=\"原对话草稿\"]').value"),"保留我的草稿");
    await e("window.fixture.conversationUi.filter('list-query','')");
    cases.push(motion+": production search/AND scopes/counts, apply/cancel/reset/outside/Escape, clear retains query/draft, stable toolbar");
  }
  for(const width of [390,320]){
    await browser.send("Emulation.setDeviceMetricsOverride",{width,height:740,deviceScaleFactor:1,mobile:false});
    await click('.conversation-list-filter-trigger');
    assert.equal(await e("(()=>{const r=document.querySelector('.conversation-list-filter-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"),true);
    assert.equal(await e("(()=>{const fields=[...document.querySelectorAll('.conversation-filter-field')].map(n=>n.getBoundingClientRect());const p=document.querySelector('.conversation-list-filter-panel');return fields.length===3&&fields.every(r=>r.top===fields[0].top&&r.left>=0&&r.right<=innerWidth)&&p.scrollHeight===p.clientHeight})()"),true,'all three fields share one visible row without parent scrolling');
    await browser.screenshot(join(out,`narrow-${width}.png`));
    await click('[data-conversation-filter-field="archive"] .ant-select');
    await click('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="已归档"]');
    assert.equal(await e("!!document.querySelector('.conversation-list-filter-panel')"),true,'third field selection retains parent');
    await browser.key("Escape");
    cases.push(`${width}px: three horizontal dropdowns visible without scrolling, third selector usable, bounded panel and footer`);
  }
  failGroups=true;await e("window.fixture.taskGroupsStore.reload()");
  assert.match(await e("document.body.textContent"),/任务与工作区信息读取失败/);
  assert.equal(await e("!!document.querySelector('.conversation-list-empty')"),false);
  assert.deepEqual(browser.errors,[]);
  assert.equal(requests.some(req=>req.method!=="GET"),false);
  writeFileSync(join(out,"verification.json"),JSON.stringify({ok:true,cases,requests},null,2));console.log(JSON.stringify({ok:true,cases},null,2));
}catch(error){if(browser){console.log(JSON.stringify({errors:browser.errors,body:await browser.evaluate("document.body.innerText.slice(0,1800)"),requests:requests.slice(-18)},null,2));await browser.screenshot(join(out,"failure.png"));}throw error;}finally{try{await browser?.close();}finally{await closeFixtureServer(server);}}
