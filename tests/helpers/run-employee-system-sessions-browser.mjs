import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

const root = resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(join(tmpdir(), "wand-employee-system-sessions-"));
const employee = { id: "e_wand_ops", name: "勤劳的初二", duty: "系统运维", prompt: "fixture", avatar: "", tags: [], agents: [], createdAt: "", updatedAt: "" };
const conversation = { id: "dm_e_wand_ops", kind: "dm", peerEmployeeId: employee.id, title: employee.name, name: employee.name,
  tasks: [], preview: "系统调用", messageAt: "2026-10-19T00:00:00Z" };
const git = { id: "git-audit", automationId: "system-ai:git-commit:git-audit", title: "系统调用 · 提交说明生成",
  employeeId: employee.id, provider: "pi", command: "system-ai", cwd: "/fixture/repo", status: "failed", startedAt: "2026-10-19T00:00:00Z" };
let sessions = [];
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import * as React from 'react';import {createRoot} from 'react-dom/client';
import {ConversationSidebarList} from './src/web-ui/react/conversations/sidebar';
import {notifyConversationChanges} from './src/web-ui/react/conversations/repository';
import {WandUiProvider} from './src/web-ui/react/theme';
import {PortalContainerProvider} from './src/web-ui/react/ui';
import {installReactUiStyles} from './src/web-ui/react/styles';
installReactUiStyles();window.refreshEmployeeList=notifyConversationChanges;window.opened=[];
createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('portals')}><WandUiProvider><ConversationSidebarList compact={false} onNavigate={()=>{}} onOpenSession={id=>window.opened.push(id)}/></WandUiProvider></PortalContainerProvider>);
` }, bundle: true, platform: "browser", format: "iife", outfile: join(tmp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  if (path.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    const body = path === "/api/conversations" ? { conversations: [conversation] } : path === "/api/sessions" ? sessions
      : path === "/api/tasks" ? [] : path === "/api/silicon-employees" ? { employees: [employee] }
      : path === "/api/config" ? { userProfile: { name: "我" } } : {};
    res.end(JSON.stringify(body)); return;
  }
  if (path === "/app.js" || path === "/styles.css") {
    res.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : "text/css");
    res.end(readFileSync(path === "/app.js" ? join(tmp, "app.js") : join(root, "src/web-ui/content/styles.css"))); return;
  }
  res.setHeader("content-type", "text/html");
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{margin:0}#root{width:min(320px,100vw);height:100vh}</style><div id="root" data-wand-ui-root></div><div id="portals" data-wand-ui-root></div><script src="/app.js"></script>');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const browser = await openPlushBrowser(1280, 900), e = browser.evaluate;
try {
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await browser.wait("!!document.querySelector('[data-conversation-id=\"dm_e_wand_ops\"]')");
  assert.equal(await e("document.querySelectorAll('.conversation-session-toggle').length"), 0);
  sessions = [git]; await e("window.refreshEmployeeList()");
  await browser.wait("!!document.querySelector('.conversation-session-toggle')");
  await browser.click('.conversation-session-toggle');
  await browser.wait("!!document.querySelector('[data-session-id=\"git-audit\"]')");
  assert.ok(await e("document.querySelector('.conversation-person-sessions').textContent.includes('提交说明生成')"));
  await browser.settle();
  const rect = await e("(()=>{const r=document.querySelector('[data-session-id=\"git-audit\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "right", clickCount: 1, ...rect });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "right", clickCount: 1, ...rect });
  await browser.wait("!!document.querySelector('.workspace-session-menu')");
  const menu = await e("document.querySelector('.workspace-session-menu').textContent");
  assert.ok(menu.includes("打开会话")); assert.ok(menu.includes("删除会话"));
  assert.ok(!menu.includes("移动到任务")); assert.ok(menu.includes("归档会话"), "read-only history retains its supported archive action");
  await browser.key("Escape");
  await browser.click('[data-session-id="git-audit"]');
  await browser.wait("window.opened.includes('git-audit')");
  for (const width of [1280, 390]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.settle(); assert.equal(await e("document.documentElement.scrollWidth<=innerWidth"), true);
  }
  sessions = []; await e("window.refreshEmployeeList()");
  await browser.wait("document.querySelectorAll('.conversation-session-toggle').length===0");
  console.log(JSON.stringify({ ok: true, fixtureOnly: true, modelCalls: 0, cases: ["late audit arrival", "employee disclosure", "exact session navigation", "read-only menu", "desktop and narrow width", "retention removal refresh"] }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(tmp, { recursive: true, force: true }); }
