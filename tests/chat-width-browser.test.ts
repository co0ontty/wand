import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

// Actual production host CSS + Ant settings control; the layout samples do not execute models.
test("Display width control unifies IM and workspace host geometry without replacing drafts", {
  skip: process.env.WAND_CHAT_WIDTH_BROWSER !== "1", timeout: 90_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), output = join(root, "output/private-chat-width/width-browser");
  mkdirSync(output, { recursive: true });
  const source = `
    import * as React from "react"; import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {ChatWidthSettings} from "./src/web-ui/react/shell/chat-width-toggle";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    installReactUiStyles();
    createRoot(document.getElementById("settings")).render(<WandUiProvider><ChatWidthSettings/></WandUiProvider>);
    window.originalDrafts = [...document.querySelectorAll("textarea")];
  `;
  const bundled = await build({ stdin: { contents: source, loader: "tsx", resolveDir: root }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(bundled.outputFiles[0]!.text); }
    else if (req.url === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else { res.setHeader("content-type", "text/html;charset=utf-8"); res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>#settings{padding:8px 20px}.sample{position:relative;width:100%;height:260px;display:flex;flex-direction:column}.conversation-root{height:100%}.conversation-message-scroll{height:100px}.chat-messages{height:100px;flex:none}textarea{max-width:100%}</style></head><body><div id="settings"></div><main class="sample"><div class="chat-messages">工作区正文</div><div class="chat-running-bar">真实状态投影的几何样本</div><div class="input-panel"><textarea aria-label="工作区草稿">保留工作区草稿</textarea></div></main><main class="sample"><section class="conversation-root"><div class="conversation-message-scroll"><div>私聊正文</div></div><div class="conversation-session-activity">未绑定回复的历史执行反馈</div><div class="conversation-task-context">群任务上下文</div><div class="conversation-composer"><textarea aria-label="私聊草稿">保留私聊草稿</textarea></div></section></main><div id="overlay-root"><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>`); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof openBrowser>> | null = null;
  const cases = [];
  try {
    browser = await openBrowser(`http://127.0.0.1:${address.port}`, 1920, 900);
    await browser.wait("!!document.querySelector('input[name=wand-chat-width]')");
    for (const native of [false, true]) for (const width of [1920, 1280, 1024, 390, 320]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await browser.evaluate(`document.documentElement.classList.toggle("is-wand-app",${native})`);
      for (const mode of ["full", "column"]) {
        await browser.click(`input[name="wand-chat-width"][value="${mode}"]`);
        const actual = await browser.evaluate(`(() => {
          const selectors=[".chat-messages",".chat-running-bar",".input-panel",".conversation-message-scroll > div",".conversation-composer",".conversation-session-activity",".conversation-task-context"];
          return selectors.map(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();return {selector,width:r.width,x:r.x,box:getComputedStyle(n).boxSizing}});
        })()`);
        const expected = mode === "column" && width >= 1280 ? 940 : width;
        for (const rect of actual) {
          assert.equal(rect.width, expected, `${width}/${native}/${mode}: ${rect.selector} uses the same column`);
          assert.equal(rect.x, (width - expected) / 2, `${width}/${native}/${mode}: ${rect.selector} aligns`);
          assert.equal(rect.box, "border-box");
        }
        assert.equal(await browser.evaluate("originalDrafts.every((n,i)=>n===document.querySelectorAll('textarea')[i])"), true);
        assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('textarea')].map(n=>n.value)"), ["保留工作区草稿", "保留私聊草稿"]);
        assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
        cases.push({ width, native, mode, expected });
      }
    }
    await browser.send("Page.reload", {});
    await browser.wait("document.documentElement.dataset.chatWidth==='column' && document.querySelector('input[value=column]')?.checked", "persisted preference adopts before UI");
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, cases, reload: true, draftNodesRetained: true, scope: "production CSS and settings component; not installed-service acceptance" }, null, 2));
  } finally { await browser?.close(); server.close(); }
});
