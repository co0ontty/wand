import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser, closeFixtureServer } from "./helpers/run-plush-avatar-browser-harness.mjs";
import type { TaskActionsSnapshot } from "../src/task-action-types.js";

// Loopback only: actual production component, no live models, permissions or acceptance writes.
test("task action browser separates source navigation from acceptance, scopes and source freshness", { timeout: 180_000 }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-task-actions-"));
  const output = join(root, "output/architecture-stage2/qoderwake-p1-previews/TASK-163/implementation-browser");
  mkdirSync(output, { recursive: true });
  const initial: TaskActionsSnapshot = { incompleteSources: 0, items: [
    { key: "permission", taskId: "t", identifier: "TASK-1", title: "授权操作", workspaceId: null, kind: "permission", reason: "确认一次文件写入", source: { sessionId: "session-p", requestId: "request-p" } },
    { key: "question", taskId: "t", identifier: "TASK-1", title: "待回答问题", workspaceId: null, kind: "question", reason: "请补充测试项目名称", source: { sessionId: "session-q", toolId: "question-q" } },
    { key: "plan", taskId: "team", identifier: "TASK-2", title: "计划等待批准", workspaceId: null, kind: "plan", reason: "计划已准备好", source: { runId: "run-exact" } },
    { key: "blocker", taskId: "blocked", identifier: "TASK-3", title: "长任务名称与窄屏回归检查：需要完整显示标题与验收缺口，不能因为摘要被截断而失去来源定位", workspaceId: null, kind: "blocker", reason: "尚未完成设备与触控验收，没有结构化处理人；需要负责人补齐证据并核对下一步。", source: {} },
    { key: "review", taskId: "review-task", identifier: "TASK-4", title: "交付待验收", workspaceId: null, kind: "review", reason: "已有交付证据，请明确验收", source: {} },
  ] };
  let payload = structuredClone(initial), status = 200, writes = 0;
  const scopes: string[] = [];
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {setWandTheme} from "./src/web-ui/react/theme-preference";
    import {TaskActions} from "./src/web-ui/react/issues/task-actions";
    import {notifyTasksChanged} from "./src/web-ui/react/task-changes";
    window.qa={sessions:[],acceptance:[],changed:notifyTasksChanged,theme:setWandTheme};
    function App(){const [scope,setScope]=React.useState("");qa.scope=setScope;return <main style={{maxWidth:1000,padding:16}}><TaskActions workspaceId={scope} onOpenSession={id=>qa.sessions.push(id)} onOpenAcceptance={id=>qa.acceptance.push(id)}/></main>}
    createRoot(document.getElementById("root")).render(<WandUiProvider><App/></WandUiProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.method !== "GET") writes++;
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/api/wand-task-actions") { scopes.push(url.searchParams.get("workspaceId") ?? ""); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(status === 200 ? payload : { error: "读取暂时失败" })); }
    else if (url.pathname === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(readFileSync(join(temp, "app.js"))); }
    else if (url.pathname === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const browser = await openPlushBrowser();
  const { evaluate, send, wait } = browser;
  const button = (text: string) => `[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)})`;
  const row = (key: string) => `document.querySelector('[data-task-action="${key}"]').closest('.ant-collapse-header')`;
  const click = async (expression: string) => {
    await evaluate(`(${expression}).scrollIntoView({block:'center'})`); await browser.settle();
    assert.equal(await evaluate(`(()=>{const e=${expression};const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>=1&&r.height>=1&&(e===hit||e.contains(hit))})()`), true, "visible and hittable target");
    await evaluate(`(${expression}).focus();(${expression}).click()`); await browser.settle();
  };
  const tab = async (value: string) => {
    await click(`document.querySelector('[data-stretch-value="${value}"]').closest('.ant-segmented-item')`);
    await browser.settle();
  };
  try {
    await send("Page.navigate", { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` });
    await wait("document.body.textContent.includes('等我处理 3')");
    await click(row("permission"));
    assert.equal(await evaluate("document.body.textContent.includes('请求 request-p')"), true);
    await click(button("查看授权请求"));
    assert.deepEqual(await evaluate("qa.sessions"), ["session-p"]);
    assert.equal(await evaluate("document.body.textContent.includes('等我处理 3')"), true, "navigation isn't a receipt");
    await click(row("question")); await click(button("定位待答问题"));
    assert.deepEqual(await evaluate("qa.sessions"), ["session-p", "session-q"]);
    await tab("review"); await click(row("review"));
    assert.deepEqual(await evaluate("qa.acceptance"), []);
    await click(button("查看交付与验收"));
    assert.deepEqual(await evaluate("qa.acceptance"), ["review-task"]);
    assert.equal(await evaluate("document.body.textContent.includes('待我验收 1')"), true);
    assert.equal(writes, 0, "opening and reading cannot mutate or accept tasks");
    await browser.screenshot(join(output, "01-review.png"));
    payload.items = payload.items.filter(x => x.kind !== "review"); await evaluate("qa.changed()"); await wait("document.body.textContent.includes('待我验收 0')");
    assert.equal(await evaluate("document.body.textContent.includes('交付待验收')"), false, "source refresh, not reading, clears the item");
    await tab("handle");
    await click(row("plan")); await click(button("查看运行请求"));
    assert.equal(await evaluate("new URLSearchParams(location.search).get('run')"), "run-exact");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), "teamchat");
    await click(row("blocker")); await click(button("核对交付缺口"));
    assert.deepEqual(await evaluate("qa.acceptance"), ["review-task", "blocked"]);
    assert.equal(await evaluate("document.body.textContent.includes('原记录未明确处理人')"), true);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" }); await browser.settle();
    assert.equal(await evaluate("document.querySelectorAll('.ant-collapse-item-active').length"), 0);
    status = 500; await evaluate("qa.changed()"); await wait("document.body.textContent.includes('行动刷新失败')");
    assert.equal(await evaluate("document.body.textContent.includes('等我处理 3 · 未确认')"), true);
    await browser.screenshot(join(output, "02-refresh-error.png"));
    status = 403; await evaluate("qa.changed()"); await wait("document.body.textContent.includes('行动读取失败')");
    assert.equal(await evaluate("document.querySelectorAll('[data-task-action]').length"), 0, "permission loss clears cached details");
    status = 200; payload = { items: [], incompleteSources: 2 }; await evaluate("qa.changed()"); await wait("document.body.textContent.includes('部分运行来源')");
    assert.equal(await evaluate("document.body.textContent.includes('暂未发现可确认的事项')"), true);
    payload = { items: [], incompleteSources: 0 }; await evaluate("qa.changed()"); await wait("document.body.textContent.includes('暂时没有需要你处理的请求')");
    await browser.screenshot(join(output, "03-empty.png"));
    payload = structuredClone(initial); await evaluate("qa.scope('workspace-next')"); await wait("document.body.textContent.includes('等我处理 3')");
    assert.equal(scopes.at(-1), "workspace-next");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate("qa.theme('graphite')"); await browser.settle(); await evaluate("scrollTo(0,0)");
    const geometry = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,heights:[...document.querySelectorAll('.ant-collapse-header,.ant-segmented-item-label')].map(e=>e.getBoundingClientRect().height)})");
    assert.ok(geometry.scrollWidth <= geometry.width); assert.ok(geometry.heights.every((height: number) => height >= 44));
    await browser.screenshot(join(output, "04-narrow-dark.png"));
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await tab("review"); await click(row("review"));
    assert.equal(await evaluate("document.body.textContent.includes('不会自动确认验收')"), true);
    assert.equal(writes, 0);
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, writes, scopes, geometry, sourceNavigation: true, noImplicitAcceptance: true, sourceRefreshOnly: true, staleAndIncomplete: true, keyboardEscape: true, reducedMotion: true, scopeIsolation: true }, null, 2));
  } catch (cause) { await browser.screenshot(join(output, "failure.png")); throw cause; }
  finally { await browser.close(); await closeFixtureServer(server); rmSync(temp, { recursive: true, force: true }); }
});
