import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("session subtask workspace preserves main input, reading, selection and independent scroll", {
  skip: process.env.WAND_SUBTASK_BROWSER !== "1", timeout: 180_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-subtasks-"));
  const evidence = process.env.WAND_SUBTASK_EVIDENCE_DIR || join(root, "output/architecture-stage2/task-70/browser"); mkdirSync(evidence, { recursive: true });
  await build({ entryPoints: [join(root, "tests/helpers/realtime-refresh-focus-harness.ts")], bundle: true,
    platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture.test").pathname;
    if (path === "/app.js" || path === "/styles.css") {
      res.setHeader("Content-Type", path.endsWith("js") ? "text/javascript" : "text/css");
      res.end(readFileSync(path === "/app.js" ? join(temp, "app.js") : join(root, "src/web-ui/content/styles.css"))); return;
    }
    if (path.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css">
      <style>body{margin:0}#chat-output{height:650px;margin-left:344px;width:calc(100% - 344px);display:flex;flex-direction:column;position:relative;overflow:hidden}.chat-messages{overflow:auto}#input-box{width:90%;height:60px}</style>
      <div id="chat-output"></div><textarea id="input-box">保留草稿</textarea><script src="/app.js"></script></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await openBrowser(url, 1778, 1267);
  t.after(async () => { await browser.close(); server.close(); rmSync(temp, { recursive: true, force: true }); });
  // Device metrics alone change CSS geometry, not Chrome's native input bounds.
  // The right-pane wheel target is outside the default 800px headless window.
  const { windowId } = await browser.send("Browser.getWindowForTarget");
  await browser.send("Browser.setWindowBounds", { windowId, bounds: { width: 1778, height: 1267 } });
  const e = (source: string) => browser.evaluate(source);
  const dispatch = (id: string) => ({ type: "tool_use", id, name: "Task", input: { subagent_type: "general-purpose", description: `检查 ${id}`, prompt: `任务说明 ${id}` }, __subagent: { taskId: id, taskDescription: `检查 ${id}` } });
  const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: `# ${id} 结果\n\n${"完整结果内容\n\n".repeat(100)}` });
  const turns = [
    { role: "user", messageId: "question", content: [{ type: "text", text: "两个子任务" }] },
    { role: "assistant", messageId: "children", content: [dispatch("a"), dispatch("b"),
      { type: "tool_use", id: "a-read", name: "Read", input: { file_path: "/tmp/task70-fixture.txt" }, __subagent: { taskId: "a" } },
      { type: "tool_result", tool_use_id: "a-read", content: "只作为渲染样本的工具结果", __subagent: { taskId: "a" } },
      result("a"), { ...result("b"), is_error: true }] },
    ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", messageId: `history-${i}`, content: [{ type: "text", text: `主对话 ${i}\n${"完整正文必须随分屏宽度自然换行，不能藏在子任务面板下面。".repeat(18)}\n${"阅读位置\n".repeat(15)}` }] })),
  ];
  try {
    await browser.wait("!!window.focusRefreshHarness");
    await e("window.h=focusRefreshHarness;h.fresh([])");
    await browser.wait("!!document.querySelector('.chat-subtasks-trigger')");
    assert.equal(await e("document.querySelector('.chat-subtasks-host').getBoundingClientRect().height"), 0, "no subtasks must leave no empty toolbar");
    await e(`window.turns=${JSON.stringify(turns)};h.fresh(turns)`);
    assert.equal(await e("document.querySelector('.chat-subtasks-host').getBoundingClientRect().height"), 42, "the toolbar appears only when child work exists");
    assert.equal(await e("document.querySelector('.chat-subtasks-trigger').getAttribute('aria-expanded')"), "false");
    assert.equal(await e("document.querySelectorAll('.chat-subtask-link').length"), 1);
    assert.equal(await e("document.querySelectorAll('.chat-messages .agent-run-detail-panel').length"), 0);
    await e("window.input=document.getElementById('input-box');window.main=document.querySelector('.chat-messages');main.scrollTop=-350;main.dispatchEvent(new Event('scroll'));window.before=main.scrollTop;window.mainBefore=main.getBoundingClientRect().toJSON();window.wrapProbe=main.querySelector('.chat-message-content p');window.wrapBefore=wrapProbe.getBoundingClientRect().toJSON();window.triggerRect=document.querySelector('.chat-subtasks-trigger').getBoundingClientRect().toJSON()");
    await e("(()=>{const bounds=main.getBoundingClientRect();window.readAnchor=Array.from(main.querySelectorAll('.chat-message-content p,.chat-message-content li,.chat-message-text')).filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>bounds.top&&r.top<bounds.bottom}).sort((a,b)=>Math.abs(a.getBoundingClientRect().top-bounds.top)-Math.abs(b.getBoundingClientRect().top-bounds.top))[0];window.readTop=readAnchor.getBoundingClientRect().top})()");
    await browser.click(".chat-subtasks-trigger");
    await browser.wait("document.getElementById('chat-output').dataset.subtasksOpen==='true'");
    assert.equal(await e("document.getElementById('input-box')===input"), true);
    const geometry = await e("(()=>{const panel=document.querySelector('.chat-subtasks-panel').getBoundingClientRect();const m=main.getBoundingClientRect(),p=wrapProbe.getBoundingClientRect();return{main:m.toJSON(),panel:panel.toJSON(),paragraph:p.toJSON(),before:mainBefore,wrapBefore,scrollLeft:main.parentElement.scrollLeft}})()");
    writeFileSync(join(evidence, "split-geometry.json"), JSON.stringify(geometry, null, 2));
    assert.ok(geometry.main.right <= geometry.panel.left + 1, "main viewport must end before the detail panel, not underneath it");
    assert.ok(geometry.main.width < geometry.before.width - 200, "opening details must reduce actual main layout width");
    assert.ok(geometry.paragraph.right <= geometry.panel.left + 1, "paragraph must be completely inside the main column");
    assert.ok(geometry.paragraph.height > geometry.wrapBefore.height, "long prose must genuinely rewrap, not merely clip");
    assert.equal(geometry.scrollLeft, 0, "detail focus must not horizontally scroll the work area");
    const readingReflow = await e("({before:readTop,after:readAnchor.getBoundingClientRect().top,connected:readAnchor.isConnected,scroll:main.scrollTop})");
    writeFileSync(join(evidence, "reading-reflow.json"), JSON.stringify(readingReflow, null, 2));
    assert.ok(Math.abs(readingReflow.after - readingReflow.before) <= 2, "actual main reading node must stay stationary during reflow: " + JSON.stringify(readingReflow));
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').textContent.includes('a 结果')"), true);
    const flat = await e(`(()=>{
      const panel=document.querySelector('.chat-subtasks-panel');
      const style=n=>{const s=getComputedStyle(n);return{radius:s.borderTopLeftRadius,shadow:s.boxShadow,background:s.backgroundColor}};
      return{list:style(panel.querySelector(':scope > .ant-collapse')),activity:style(panel.querySelector('.chat-subtasks-latest')),
        secondary:style(panel.querySelector('.chat-subtasks-secondary')),row:style(panel.querySelector('.chat-subtasks-item')),
        duplicateResultTitle:panel.querySelector('.agent-run-output-label')?.textContent || ''};
    })()`);
    assert.equal(flat.list.radius, "0px"); assert.equal(flat.secondary.radius, "0px");
    assert.equal(flat.list.background, "rgba(0, 0, 0, 0)");
    assert.equal(flat.activity.background, "rgba(0, 0, 0, 0)"); assert.equal(flat.activity.radius, "0px");
    assert.equal(flat.row.radius, "0px"); assert.equal(flat.row.shadow, "none");
    assert.equal(flat.duplicateResultTitle, "", "result body must not nest a second final-result heading");
    await browser.click('.chat-subtasks-scroll:not([hidden]) .agent-run-process .ant-collapse-header');
    assert.equal(await e("document.querySelector('.agent-run-process').dataset.expanded"), "true");
    assert.equal(await e("document.querySelector('.agent-run-process').textContent.includes('task70-fixture.txt')"), true);
    await e("(()=>{const scroll=document.querySelector('.chat-subtasks-scroll:not([hidden])');scroll.scrollTop=scroll.scrollHeight})()");
    await browser.screenshot(join(evidence, "expanded-process.png"));
    await browser.click('.chat-subtasks-scroll:not([hidden]) .agent-run-process .ant-collapse-header');
    await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').scrollTop=200");
    await browser.click(".chat-subtasks-item:nth-child(2)");
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').dataset.subtaskId"), "b");
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden]) .chat-subtasks-current').textContent.includes('失败')"), true);
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').textContent.includes('b 结果')"), true, "flattening must keep failed child output readable");
    await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').scrollTop=120;window.mainBeforeWheel=main.scrollTop");
    await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: geometry.main.left + 100, y: 200, deltaX: 0, deltaY: -120 });
    await browser.settle();
    assert.notEqual(await e("main.scrollTop"), await e("mainBeforeWheel"), "main reading pane must scroll independently");
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').scrollTop"), 120, "main wheel must not move the selected child's viewport");
    await e("input.focus();input.selectionStart=2;input.selectionEnd=2");
    const streamed = [...turns, { role: "assistant", messageId: "new-child", content: [dispatch("c")] }];
    await e(`h.publish(${JSON.stringify(streamed)});h.doRenderChat(false);h.frames()`);
    assert.equal(await e("document.activeElement===input"), true, "new task never steals composer focus");
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').dataset.subtaskId"), "b");
    await browser.key("Escape");
    assert.equal(await e("document.querySelector('.chat-subtasks-trigger').getAttribute('aria-expanded')"), "false");
    assert.equal(await e("document.activeElement.matches('.chat-subtasks-trigger')"), true, "Escape restores focus to the fixed entrance");
    await browser.click(".chat-subtasks-trigger");
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').scrollTop"), 120);
    // Closing/reopening separates physical gestures so Chrome cannot latch
    // this wheel packet to the preceding main-pane scroll gesture.
    const childWheel = await e("(()=>{const s=document.querySelector('.chat-subtasks-scroll:not([hidden])'),r=s.getBoundingClientRect();return{x:r.left+100,y:r.top+Math.min(100,r.height/2),main:main.scrollTop}})()");
    await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: childWheel.x, y: childWheel.y, deltaX: 0, deltaY: 120 });
    await browser.wait("document.querySelector('.chat-subtasks-scroll:not([hidden])').scrollTop > 120", "detail wheel scroll");
    assert.equal(await e("main.scrollTop"), childWheel.main, "detail wheel must not move the main reading pane");
    await browser.click(".chat-subtasks-item:nth-child(1)");
    assert.equal(await e("document.querySelector('.chat-subtasks-scroll:not([hidden])').scrollTop"), 200);
    assert.equal(await e("(()=>{const r=document.querySelector('.chat-subtasks-trigger').getBoundingClientRect();return r.x===triggerRect.x&&r.width===triggerRect.width})()"), true);
    await browser.screenshot(join(evidence, "wide.png"));
    await browser.click('[aria-label="关闭子任务详情"]');
    await browser.click(".chat-subtasks-trigger"); await browser.click(".chat-subtasks-trigger");
    assert.equal(await e("input.value"), "保留草稿");
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await browser.click(".chat-subtasks-trigger");
    assert.equal(await e("getComputedStyle(main).visibility"), "hidden");
    assert.equal(await e("Math.round(document.querySelector('.chat-subtasks-panel').getBoundingClientRect().width)"), await e("document.getElementById('chat-output').clientWidth"));
    await browser.screenshot(join(evidence, "900px-reduced.png"));
    await browser.key("Escape");
    assert.equal(await e("getComputedStyle(main).visibility"), "visible");
    assert.equal(await e("input.value"), "保留草稿");
    // Check actual workspace width, not just viewport breakpoints. The 344px
    // navigation means 1304/1305px straddle the 960px container boundary.
    const layoutCases = [];
    for (const mode of [
      { name: "wide", width: 1778, column: false, native: false, reduced: false },
      { name: "column", width: 2560, column: true, native: false, reduced: false },
      { name: "column-shrink", width: 1778, column: true, native: false, reduced: false },
      { name: "native-reduced", width: 1778, column: false, native: true, reduced: true },
      { name: "container-961", width: 1305, column: false, native: false, reduced: false },
      { name: "container-960", width: 1304, column: true, native: false, reduced: false },
    ]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width: mode.width, height: 900, deviceScaleFactor: 1, mobile: false });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode.reduced ? "reduce" : "no-preference" }] });
      await e(`document.documentElement.dataset.chatWidth=${JSON.stringify(mode.column ? "column" : "full")};document.documentElement.classList.toggle('is-wand-app',${mode.native})`);
      await browser.settle();
      const closed = await e("({main:main.getBoundingClientRect().toJSON(),paragraph:wrapProbe.getBoundingClientRect().toJSON()})");
      await browser.click(".chat-subtasks-trigger");
      const opened = await e(`(()=>{const root=document.getElementById('chat-output'),panel=document.querySelector('.chat-subtasks-panel');return{
        available:root.clientWidth,main:main.getBoundingClientRect().toJSON(),panel:panel.getBoundingClientRect().toJSON(),
        paragraph:wrapProbe.getBoundingClientRect().toJSON(),visibility:getComputedStyle(main).visibility,
        transition:getComputedStyle(panel).transitionDuration,overflow:root.scrollWidth>root.clientWidth,
        sameInput:document.getElementById('input-box')===input,draft:input.value}})()`);
      if (opened.available > 960) {
        assert.ok(opened.main.right <= opened.panel.left + 1, mode.name + ": non-overlapping panes");
        assert.ok(opened.paragraph.right <= opened.main.right + 1, mode.name + ": prose stays inside main pane");
        if (opened.available * 0.62 < closed.main.width - 1) {
          assert.ok(opened.main.width < closed.main.width, mode.name + ": opening genuinely shrinks main width");
          assert.ok(opened.paragraph.height > closed.paragraph.height, mode.name + ": prose rewraps instead of clipping");
        } else {
          assert.ok(Math.abs(opened.main.width - closed.main.width) <= 1, mode.name + ": capped reading column keeps its width when there is enough room");
        }
        if (mode.column) assert.ok(Math.abs((opened.main.left - 344) - (opened.panel.left - opened.main.right)) <= 2, "reading column is centered within the remaining main pane");
      } else {
        assert.equal(opened.visibility, "hidden", mode.name + ": narrow workspace switches views");
        assert.ok(Math.abs(opened.panel.width - opened.available) <= 1, mode.name + ": details use the full workspace");
      }
      assert.equal(opened.overflow, false, mode.name + ": work area does not escape horizontally");
      assert.equal(opened.sameInput, true); assert.equal(opened.draft, "保留草稿");
      if (mode.reduced) assert.equal(opened.transition, "0s");
      await browser.screenshot(join(evidence, mode.name + ".png"));
      await browser.key("Escape");
      assert.equal(await e("getComputedStyle(main).visibility"), "visible");
      assert.ok(Math.abs(await e("main.getBoundingClientRect().width") - closed.main.width) <= 1, mode.name + ": closing restores main width");
      layoutCases.push({ mode: mode.name, closed, opened });
    }
    writeFileSync(join(evidence, "layout-matrix.json"), JSON.stringify(layoutCases, null, 2));
    await e("h.state.selectedId='focus-B';h.publish([{role:'user',messageId:'other',content:[{type:'text',text:'另一会话'}]}]);h.doRenderChat(true);h.frames()");
    assert.equal(await e("document.getElementById('chat-output').dataset.subtasksOpen"), "false");
    assert.equal(await e("document.querySelectorAll('.chat-subtasks-scroll').length"), 0, "session switch cannot retain another session's results");
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, realProductionRenderer: true,
      modes: ["1778px-with-344px-navigation", "900px-reduced", ...layoutCases.map(item => item.mode)], bidirectionalWheelIsolation: true, modelCalls: 0, errors: browser.errors }, null, 2));
  } catch (error) {
    writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), errors: browser.errors, dom: await e("document.body.innerText.slice(0,5000)") }, null, 2));
    throw error;
  }
});
