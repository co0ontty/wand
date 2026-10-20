import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";

// Large real renderer fixture, real pointer events, no model or installed data.
// Counting parsed history catches wasted work even when reconciliation preserves
// node identity and a fast test machine hides the resulting interaction latency.
test("opening chat activity only regenerates its owning message, not unrelated history", {
  skip: process.env.WAND_CHAT_DISCLOSURE_PERF !== "1", timeout: 180_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-chat-disclosure-perf-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import "./tests/helpers/realtime-refresh-focus-harness";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    installReactUiStyles();
  ` }, bundle: true, platform: "browser", format: "iife", outfile: join(temp, "app.js"),
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const files: Record<string, [string, string]> = {
      "/app.js": [join(temp, "app.js"), "text/javascript"],
      "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
      "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"],
    };
    if (files[path]) { res.setHeader("Content-Type", files[path][1]); res.end(readFileSync(files[path][0])); return; }
    if (path.includes("plush-avatar") || path.includes("plushAvatarChunkSrc")) {
      res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(join(root, "src/web-ui/content/plush-avatar.js"))); return;
    }
    if (path.includes("/tool-content/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ input: { command: "printf fixture" }, content: "isolated result", pending: false, resultAvailable: true })); return;
    }
    if (path.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>#chat-output{height:700px;display:flex}.chat-messages{overflow-y:auto}</style><div id="chat-output"></div><textarea id="input-box"></textarea><script src="/app.js"></script>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openPlushBrowser(1280, 900, false, "reduce");
  t.after(() => browser.close());
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
  await browser.wait("!!window.focusRefreshHarness");
  await browser.evaluate(`(async () => {
    window.h = window.focusRefreshHarness;
    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", uuid: "user-" + i, content: [{ type: "text", text: "问题 " + i }] });
      messages.push({ role: "assistant", uuid: "assistant-" + i, completedAt: "2026-10-18T00:01:00Z", content: [
        { type: "text", text: (i === 29 ? "TARGET_ROW" : "UNRELATED_ROW_" + i) + " 正文与列表\\n\\n" + "详细内容\\n".repeat(60) },
        { type: "thinking", thinking: "思考详情 " + i },
        { type: "tool_use", id: "command-" + i, name: "Bash", input: {}, activity: { kind: "run_command" } },
        { type: "tool_result", tool_use_id: "command-" + i, content: "合成结果" }
      ] });
    }
    await h.fresh(messages);
    window.parsedHistory = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    Object.defineProperty(Element.prototype, "innerHTML", { ...descriptor, set(value) {
      if (typeof value === "string" && value.includes("UNRELATED_ROW_")) parsedHistory.push(value.length);
      descriptor.set.call(this, value);
    }});
  })()`);
  const owner = '.chat-message[data-msg-index="59"]';
  await browser.click(`${owner} .chat-process-summary`);
  await browser.wait(`document.querySelector('${owner} .chat-process-summary').getAttribute('aria-expanded')==='true'`);
  assert.equal(await browser.evaluate("parsedHistory.length"), 0, "opening a process must not parse completed history");
  await browser.click(`${owner} [data-thinking-entry="true"] .chat-call-button`);
  await browser.wait(`document.querySelector('${owner} [data-thinking-entry="true"]').dataset.expanded==='true'`);
  assert.equal(await browser.evaluate("parsedHistory.length"), 0, "opening thinking must stay local");
  await browser.click(`${owner} [data-thinking-entry="true"] .chat-call-button`);
  await browser.click(`${owner} .chat-call[data-tool-ids]:not([data-thinking-entry="true"]) .chat-call-button`);
  await browser.wait(`document.querySelector('${owner}').textContent.includes('isolated result')`);
  assert.equal(await browser.evaluate("parsedHistory.length"), 0, "loading and accepting a tool result must stay local");
  // A concurrently changed source row must still participate in the normal cache plan.
  await browser.evaluate(`h.publish(h.turns().map((message, index) => index === 57 ? { ...message, content: [{ type: "text", text: "CONCURRENT_UPDATE" }] } : message)); true`);
  await browser.click(`${owner} .chat-process-summary`);
  await browser.click(`${owner} .chat-process-summary`);
  assert.equal(await browser.evaluate("document.querySelector('.chat-message[data-msg-index=\"57\"]').textContent.includes('CONCURRENT_UPDATE')"), true);
  assert.equal(await browser.evaluate("parsedHistory.length"), 0, "unchanged rows remain cached during concurrent updates");
  assert.deepEqual(browser.errors, []);
  t.diagnostic(JSON.stringify({ messageRows: 60, unrelatedHistoryParses: await browser.evaluate("parsedHistory.length"),
    checked: ["process toggle", "thinking toggle", "tool loading", "tool result", "concurrent source update"] }));
});
