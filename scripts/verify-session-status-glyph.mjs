// 真实生产统一会话列表 + 隔离 fixture 会话，逐个运行状态核对行尾动效标记；不做模型调用。
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeFixtureServer, openPlushBrowser } from "./design-previews/helpers/browser-harness.mjs";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "output/session-status-glyph/web");
mkdirSync(out, { recursive: true });

const session = (id, status, extra = {}) => ({
  id: `s-${id}`, title: `会话 ${id}`, provider: "pi", sessionKind: "structured", cwd: "/fixture/wand",
  workspaceTaskId: "task-wand", employeeId: "e-a", employeeName: "测试伙伴", status, ...extra,
});
const sessions = [
  session("running", "running", { inFlight: true }),
  session("thinking", "thinking"),
  session("queued", "queued", { executionStatus: "queued" }),
  session("just", "idle", { completionRevision: 3, viewedCompletionRevision: 2 }),
  session("failed", "failed"),
  session("permission", "permission-blocked"),
  session("waiting", "waiting-input"),
  session("reconnecting", "reconnecting"),
  session("idle", "idle"),
  session("exited", "exited"),
];
const groups = [{
  workspaceId: "wand", workspaceName: "Wand", workspaceCwd: "/fixture/wand", standaloneSessions: [],
  tasks: [{
    id: "task-wand", workspaceId: "wand", name: "会话状态验收", status: "active", worktree: null, layout: null,
    createdAt: "", lastOpenedAt: null, isolated: false, boardTaskId: "board-wand", boardTaskStatus: "doing", sessions,
  }],
}];

const source = `
import * as React from 'react'; import {createRoot} from 'react-dom/client';
import {WandUiProvider} from './src/web-ui/react/theme';
import {PortalContainerProvider} from './src/web-ui/react/ui/portal-context';
import {installReactUiStyles} from './src/web-ui/react/styles';
import {installSidebarStyles} from './src/web-ui/react/shell/sidebar-styles';
import {UnifiedSidebarList, useUnifiedSidebar} from './src/web-ui/react/conversations/unified-sidebar';
installReactUiStyles(); installSidebarStyles();
function Host(){
  const titles = {};
  const model = useUnifiedSidebar(true, titles);
  return <UnifiedSidebarList model={model} titles={titles} selectedSessionId={null} selectedConversationId={null}
    onOpen={()=>{}} onCreate={()=>{}} historyCount={0} enabled/>;
}
createRoot(document.getElementById('root')).render(
  <PortalContainerProvider container={document.getElementById('portals')}><WandUiProvider>
    <aside className='sidebar' style={{width:320,height:'100dvh',position:'static',display:'flex',padding:8}}><Host/></aside>
  </WandUiProvider></PortalContainerProvider>);
`;
await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", format: "iife",
  outfile: join(out, "fixture.js"), define: { "process.env.NODE_ENV": '"production"' } });

const server = createServer((request, response) => {
  const path = request.url.split("?")[0];
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  if (path === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(readFileSync(join(out, "fixture.js"))); return; }
  if (path === "/styles.css") { response.setHeader("Content-Type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
  if (path.includes("plushAvatarChunkSrc")) { response.setHeader("Content-Type", "text/javascript"); response.end("/* fixture uses static avatars */"); return; }
  if (!path.startsWith("/api/")) {
    response.setHeader("Content-Type", "text/html;charset=utf-8");
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="display:flex;height:100dvh"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/fixture.js"></script></body></html>');
    return;
  }
  response.setHeader("Content-Type", "application/json");
  const body = path === "/api/tasks" ? groups : path === "/api/conversations" ? { conversations: [] }
    : path === "/api/silicon-employees" ? { employees: [] } : path === "/api/sessions" ? [] : path === "/api/user-profile" ? { name: "测试用户" } : {};
  response.end(JSON.stringify(body));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));

// 期望的行尾标记：等你处理（授权/回答/重连）是琥珀等待，不是红色失败。
const expected = [
  ["running", "is-running", "运行中"],
  ["thinking", "is-running", "思考中"],
  ["queued", "is-queued", "排队中"],
  ["just", "is-completed", "刚完成"],
  ["failed", "is-failed", "失败"],
  ["permission", "is-attention", "等待授权"],
  ["waiting", "is-attention", "等待回答"],
  ["reconnecting", "is-attention", "重连中"],
  ["idle", null, null],
  ["exited", null, null],
];
const probe = `(()=>{const rows=${JSON.stringify(expected.map(([id])=>id))};return rows.map(id=>{const row=document.querySelector('[data-unified-session="s-'+id+'"]');
  const mark=row?.querySelector('.im-sidebar-item-status-mark [role=img]');const glyph=mark?.querySelector('.wand-status-glyph');
  const style=glyph?getComputedStyle(glyph):null;return{id,mark:!!mark,cls:glyph?[...glyph.classList].filter(c=>c.startsWith('is-')).join(' '):null,
    label:mark?.getAttribute('aria-label')??null,breath:style?style.animationName:null,color:style?style.color:null,background:style?style.backgroundColor:null}})})()`;
const cases = [];
let browser;
try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await openPlushBrowser(1000, 900, false, "no-preference");
  const e = expression => browser.evaluate(expression);
  await browser.send("Page.navigate", { url });
  await browser.wait(`document.querySelectorAll('[data-unified-session]').length===${expected.length}`);
  await browser.settle();
  assert.deepEqual(await e("document.querySelectorAll('.im-sidebar-item-status-mark .is-failed').length"), 1, "only a real failure renders the red mark");
  const observed = Object.fromEntries((await e(probe)).map(item => [item.id, item]));
  for (const [id, cls, label] of expected) {
    const item = observed[id];
    assert.equal(item?.mark, cls !== null, `${id} mark presence`);
    if (cls) {
      assert.equal(item.cls, cls, `${id} glyph class`);
      assert.equal(item.label, label, `${id} accessible label`);
    }
  }
  const attention = observed.permission;
  assert.equal(attention.breath, "chat-running-breathe", "attention badge breathes while it waits");
  assert.notEqual(attention.color, observed.failed.color, "attention colour differs from failure colour");
  assert.equal(observed.idle.mark, false, "an idle CLI is not running work");
  cases.push("10 production rows: running/thinking/queued/completed/failed/attention x3/idle+exited silent, amber attention differs from red failure, exactly one red mark");

  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await e("location.reload()").catch(() => null);
  await browser.wait(`document.querySelectorAll('[data-unified-session]').length===${expected.length}`);
  await browser.settle();
  const reduced = Object.fromEntries((await e(probe)).map(item => [item.id, item]));
  assert.equal(reduced.permission.breath, "none", "reduced motion keeps the attention badge static");
  assert.equal(reduced.running.cls, "is-running", "reduced motion keeps the state vocabulary identical");
  cases.push("prefers-reduced-motion: same states, breathing animation disabled");
  await browser.screenshot(join(out, "attention-badge.png"));
  assert.deepEqual(browser.errors, [], "no console errors");
  writeFileSync(join(out, "verification.json"), JSON.stringify({ ok: true, cases }, null, 2));
  console.log(JSON.stringify({ ok: true, cases }, null, 2));
} catch (error) {
  if (browser) console.log(JSON.stringify({ errors: browser.errors, probe: await browser.evaluate(probe), body: await browser.evaluate("document.body.innerText.slice(0,1200)") }, null, 2));
  await browser?.screenshot?.(join(out, "failure.png"));
  throw error;
} finally {
  try { await browser?.close(); } finally { await closeFixtureServer(server); }
}
