import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { themeFixtureHtml } from "./helpers/theme-fixture.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("unknown organization start can recover the original receipt and its sidebar members without resubmitting", {
  skip: process.env.WAND_TASK_ORGANIZE_BROWSER !== "1", timeout: 180_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-organize-recovery-"));
  await build({ stdin: { contents: `
import * as React from "react";import{createRoot}from"react-dom/client";
import{WandUiProvider}from"./src/web-ui/react/theme";import{installReactUiStyles}from"./src/web-ui/react/styles";
import{TaskOrganizeButton}from"./src/web-ui/react/workspaces/task-organization";
import{WorkspacesPanel}from"./src/web-ui/react/workspaces/workspaces-panel";
import{configureWorkspacesRuntime}from"./src/web-ui/react/workspaces/controller";
import{taskGroupsStore}from"./src/web-ui/react/workspaces/task-groups-store";
installReactUiStyles();window.fixture={reloads:0,opened:null};
configureWorkspacesRuntime({selectSession(id){window.fixture.opened=id},openTask(){},openWorkspace(){},closeWorkspace(){},refreshSessions:async()=>{},toast(){},onOpen(){},onClose(){}});
createRoot(document.getElementById("root")).render(<WandUiProvider><TaskOrganizeButton target={{kind:"directory",cwd:"/repo/wand"}} onChanged={async()=>{window.fixture.reloads++;await taskGroupsStore.reload()}}/><div style={{width:280}}><WorkspacesPanel/></div></WandUiProvider>);`, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  let receiptReady = false;
  const requests: Array<{ action?: string; path: string }> = [];
  const members = ["one", "two"].map(id => ({ id, title: `工作 ${id}`, provider: "pi", status: "idle", sessionKind: "structured", cwd: "/repo/wand", startedAt: "2026-10-01" }));
  const outcome = { ok: true, foundSessions: 2, eligibleSessions: 2, analyzedSessions: 2, skippedSessions: 0, skippedManualSessions: 0, createdTasks: [{ taskId: "created-task", cardId: "created-card", title: "通知保存", sessionCount: 2 }], reusedTasks: [], updatedTasks: [], movedSessions: members.map(s => ({ sessionId: s.id, taskId: "created-task", taskName: "通知保存" })), unassignedSessions: [], refused: [] };
  const job = { id: "original-job", status: "completed", stage: "已完成", processedSessions: 2, totalSessions: 2, modelRequests: 1, result: outcome };
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (path === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (path.endsWith(".css")) { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content", path.slice(1)))); return; }
    if (path === "/api/sessions/auto-organize" && req.method === "POST") {
      let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
        const parsed = JSON.parse(body); requests.push({ path, action: parsed.action });
        if (parsed.action === "preview") { json({ kind: "preview", preview: { token: "original-token", sessionCount: 2, manualSessionCount: 0, skippedSessionCount: 0, existingTaskCount: 0, contentCharacters: 1200, estimatedModelRequests: 2, unchanged: false } }); return; }
        json({ error: "提交已接受，但回执连接中断" }, 503);
      }); return;
    }
    if (path.startsWith("/api/sessions/auto-organize/by-token/")) {
      requests.push({ path });
      assert.equal(path, "/api/sessions/auto-organize/by-token/original-token");
      json(receiptReady ? { job } : { error: "暂时无法查询原回执" }, receiptReady ? 200 : 503); return;
    }
    if (path === "/api/tasks") {
      json({ groups: [{ workspaceId: "wand", workspaceName: "wand", workspaceCwd: "/repo/wand", tasks: receiptReady ? [{ id: "created-task", name: "通知保存", workspaceId: "wand", cwd: "/repo/wand", status: "active", createdAt: "2026-10-01", sessions: members }] : [], standaloneSessions: receiptReady ? [] : members }] }); return;
    }
    if (path.startsWith("/api/")) { json(path.includes("silicon-employees") ? { employees: [] } : []); return; }
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end(themeFixtureHtml('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="app"><div id="root"></div></div><div id="wand-react-ui-portals"></div><script src="/app.js"></script></body></html>'));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    for (const width of [1280, 390]) {
      receiptReady = false; requests.length = 0;
      const browser = await openBrowser(`http://127.0.0.1:${address.port}`, width, 900);
      const choose = async (text: string) => {
        await browser.wait(`(()=>{const n=[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.getClientRects().length&&n.textContent.trim()===${JSON.stringify(text)});if(!n)return false;document.querySelectorAll('#choice').forEach(x=>x.removeAttribute('id'));n.id='choice';return true})()`, text);
        await browser.click("#choice");
      };
      try {
        await browser.wait(`!!document.querySelector('[aria-label="会话自动归类"]')`);
        await browser.click('[aria-label="会话自动归类"]'); await choose("默认范围会话"); await choose("确认整理 2 个会话");
        await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('提交已接受')`);
        await browser.key("Escape"); await browser.click('[aria-label="会话自动归类"]');
        await browser.wait(`[...document.querySelectorAll('[role="menuitem"]')].some(n=>n.getClientRects().length&&n.textContent.trim()==='查询原确认请求')`, "unknown receipt recovery must remain reachable after closing");
        assert.equal(await browser.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.trim()==='默认范围会话')?.getAttribute('aria-disabled')`), "true");
        assert.equal(requests.filter(r => r.action === "start").length, 1);
        receiptReady = true; await choose("查询原确认请求");
        await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('新建 1 个任务')`);
        await browser.wait(`window.fixture.reloads===1`);
        await browser.key("Escape");
        await browser.wait(`!!document.querySelector('[data-workspace-task-id="created-task"]')`);
        const groups = await browser.evaluate(`({formal:[...document.querySelectorAll('[data-workspace-task-id="created-task"] [data-session-id]')].map(n=>n.dataset.sessionId),unassigned:[...document.querySelectorAll('[data-sidebar-default-task-id] [data-session-id]')].map(n=>n.dataset.sessionId)})`);
        assert.deepEqual(groups.unassigned, []);
        // Task children may start collapsed; opening the task reveals exactly the moved source members.
        if (!await browser.evaluate(`document.querySelector('[data-sidebar-tree-directory-id="wand"] .workspace-row-main')?.getAttribute('aria-expanded')==='true'`)) {
          await browser.click('[data-sidebar-tree-directory-id="wand"] .workspace-row-main');
        }
        if (!await browser.evaluate(`document.querySelector('[data-workspace-task-id="created-task"] .workspace-task-main')?.getAttribute('aria-expanded')==='true'`)) {
          await browser.click('[data-workspace-task-id="created-task"] .workspace-task-main');
        }
        await browser.wait(`document.querySelectorAll('[data-workspace-task-id="created-task"] [data-session-id]').length===2`);
        assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[data-workspace-task-id="created-task"] [data-session-id]')].map(n=>n.dataset.sessionId)`), ["one", "two"]);
        assert.equal(requests.filter(r => r.action === "start").length, 1, "recovery never submits another model request");
        assert.equal(requests.filter(r => r.action === "preview").length, 1);
        assert.deepEqual(browser.errors, []);
      } finally { await browser.close(); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(temp, { recursive: true, force: true }); }
});
