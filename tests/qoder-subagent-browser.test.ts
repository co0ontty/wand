import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { ClaudeCliProtocolReducer } from "../src/structured-claude-protocol.js";
import type { SessionSnapshot } from "../src/types.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("Qoder child details distinguish receipt-only unknown from native completion/failure", {
  skip: process.env.WAND_QODER_BROWSER !== "1", timeout: 120_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-qoder-lifecycle-"));
  const evidence = join(root, "output/task-71/browser"); mkdirSync(evidence, { recursive: true });
  await build({ entryPoints: [join(root, "tests/helpers/realtime-refresh-focus-harness.ts")], bundle: true,
    platform: "browser", format: "iife", outfile: join(temp, "app.js"), logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url === "/app.js" || req.url === "/styles.css") {
      res.setHeader("Content-Type", req.url.endsWith("js") ? "text/javascript" : "text/css");
      res.end(readFileSync(req.url === "/app.js" ? join(temp, "app.js") : join(root, "src/web-ui/content/styles.css"))); return;
    }
    if (req.url?.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css">
      <style>body{margin:0}#chat-output{height:650px;display:flex;flex-direction:column;position:relative;overflow:hidden}.chat-messages{overflow:auto}#input-box{width:90%;height:60px}</style>
      <div id="chat-output"></div><textarea id="input-box">本轮草稿</textarea><script src="/app.js"></script></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const browser = await openBrowser(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 1440, 900);
  t.after(async () => { await browser.close(); server.close(); rmSync(temp, { recursive: true, force: true }); });
  const e = (source: string) => browser.evaluate(source);
  const reducer = new ClaudeCliProtocolReducer({ provider: "qoder", runner: "qoder-cli-print" } as SessionSnapshot);
  for (const id of ["a", "b"]) {
    reducer.apply({ type: "assistant", message: { id, content: [
      { type: "tool_use", id, name: "Agent", input: { description: `检查 ${id}`, subagent_type: "general-purpose", run_in_background: true } },
    ] } }, true);
    reducer.apply({ type: "user", tool_use_result: { isAsync: true }, message: { content: [
      { type: "tool_result", tool_use_id: id, content: `Async agent launched successfully.\nagentId: native-${id}\noutput_file: /tmp/task-${id}.output` },
    ] } }, true);
  }
  const turns = () => [{ role: "user", content: [{ type: "text", text: "启动两个子任务" }] },
    { role: "assistant", messageId: "children", content: [...reducer.state.blocks] },
    { role: "assistant", messageId: "parent", content: [{ type: "text", text: "两个子代理均已完成（父模型自述，不作为运行事实）" }] }];
  try {
    await browser.wait("!!window.focusRefreshHarness");
    await e(`window.h=focusRefreshHarness;h.fresh(${JSON.stringify(turns())},{status:'idle'})`);
    await browser.wait("!!document.querySelector('.chat-subtasks-trigger, .agent-run-summary')");
    const panel = await e("!!document.querySelector('.chat-subtasks-trigger')");
    if (panel) await browser.click(".chat-subtasks-trigger");
    else if (await e("document.querySelector('.agent-run-summary').getAttribute('aria-expanded')!=='true'")) await browser.click(".agent-run-summary");
    const current = panel ? ".chat-subtasks-scroll:not([hidden])" : ".agent-run-detail-panel:not([hidden])";
    await browser.wait(`document.querySelector(${JSON.stringify(current)})?.textContent.includes('运行状态未知')`);
    assert.match(await e(`document.querySelector(${JSON.stringify(current)}).textContent`), /仅收到后台派发回执/);
    assert.doesNotMatch(await e(`document.querySelector(${JSON.stringify(current)}).textContent`), /仍在后台执行/);
    const selectB = panel ? ".chat-subtasks-item:nth-child(2)" : '[data-agent-task-id="b"]';
    await browser.click(selectB);
    await browser.screenshot(join(evidence, "receipt-only-unknown.png"));
    reducer.apply({ type: "system", subtype: "task_notification", task_id: "native-a", tool_use_id: "a", status: "completed", summary: "Agent A finished" }, true);
    reducer.apply({ type: "system", subtype: "task_notification", task_id: "native-b", tool_use_id: "b", status: "failed", summary: "Agent B failed" }, true);
    await e(`h.publish(${JSON.stringify(turns())});h.doRenderChat(false);h.frames()`);
    await browser.wait(`document.querySelector(${JSON.stringify(current)})?.textContent.includes('Agent B failed')`);
    assert.match(await e(`document.querySelector(${JSON.stringify(current)}).textContent`), /失败/);
    assert.match(await e(`document.querySelector(${JSON.stringify(current)}).textContent`), /未提供结果正文/);
    await browser.screenshot(join(evidence, "native-failed.png"));
    await browser.click(panel ? ".chat-subtasks-item:nth-child(1)" : '[data-agent-task-id="a"]');
    await browser.wait(`document.querySelector(${JSON.stringify(current)})?.textContent.includes('Agent A finished')`);
    assert.match(await e(`document.querySelector(${JSON.stringify(current)}).textContent`), /已完成/);
    assert.equal(await e("document.getElementById('input-box').value"), "本轮草稿");
    await browser.screenshot(join(evidence, "native-completed.png"));
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, sourceRenderer: true, nativeProtocolProjection: true,
      syntheticData: true, installedAcceptance: false, modelCalls: 0, draftPreserved: true, cases: ["receipt-only", "parent-claim-ignored", "native-completed", "native-failed", "no-result-body"] }, null, 2));
  } catch (error) {
    writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), errors: browser.errors, dom: await e("document.body.innerText.slice(0,6000)") }, null, 2));
    throw error;
  }
});
