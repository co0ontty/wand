import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";
import { blockWindowMessagesForTransport, messageWindowByteBudget } from "../src/message-truncator.js";
import type { ConversationTurn } from "../src/types.js";

// Actual scroll/renderer/pagination owners, synthetic history, no model calls.
test("viewport history keeps two screens above the reader and loads small pages on desktop/touch/native", {
  skip: process.env.WAND_BROWSER_E2E !== "1", timeout: 100_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const dir = mkdtempSync(join(tmpdir(), "wand-viewport-history-"));
  const output = join(root, "output/session-load-performance");
  mkdirSync(output, { recursive: true });
  const turns: ConversationTurn[] = Array.from({ length: 120 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", uuid: `history-${i}`,
    content: [{ type: "text", text: `HISTORY_${i}\n${"A readable fixture line\n".repeat(5)}` }],
  }));
  const blocks: ConversationTurn = { role: "assistant", uuid: "long-turn", content:
    Array.from({ length: 240 }, (_, i) => ({ type: "text", text: `BLOCK_${i}\n${"Block fixture line\n".repeat(3)}` })) };
  const shortBlocks: ConversationTurn = { role: "assistant", uuid: "short-blocks", content:
    Array.from({ length: 240 }, (_, i) => ({ type: "text", text: `Short block ${i}` })) };
  const folded: ConversationTurn = { role: "assistant", uuid: "folded-turn", content:
    Array.from({ length: 40 }, (_, i) => [
      { type: "tool_use" as const, id: `folded-${i}`, name: "Bash", input: { command: `printf ${i}` } },
      { type: "tool_result" as const, tool_use_id: `folded-${i}`, content: "done" },
    ]).flat() };
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let history = "turns";
  let failNext = false;
  let noProgressNext = false;
  const requests: Array<{ before?: number; turn?: number; blockOffset?: number; budget: number; byteBudget: number }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.test");
    const files: Record<string, [string, string]> = { "/app.js": [join(dir, "app.js"), "text/javascript"],
      "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
      "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"] };
    if (files[url.pathname]) { res.setHeader("Content-Type", files[url.pathname][1]); res.end(readFileSync(files[url.pathname][0])); return; }
    if (url.pathname.endsWith("/messages")) {
      const budget = Number(url.searchParams.get("blockBudget") ?? url.searchParams.get("blockLimit"));
      const byteBudget = messageWindowByteBudget(url.searchParams.get("byteBudget"));
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
      const blockOffset = url.searchParams.has("blockOffset") ? Number(url.searchParams.get("blockOffset")) : undefined;
      requests.push({ before, blockOffset, budget, byteBudget });
      if (failNext) { failNext = false; res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"synthetic rejection"}'); return; }
      if (noProgressNext) {
        noProgressNext = false;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ messages: [], offset: before, total: 120, leadingBlockOffset: 0,
          turnIndex: 0, blocks: [], blockOffset })); return;
      }
      const data = history === "turns" || history === "folded" && before !== undefined ? (() => {
        const page = blockWindowMessagesForTransport(turns.slice(0, before), {}, budget, byteBudget, true);
        return { ...page, offset: page.messageOffset, total: turns.length + (history === "folded" ? 1 : 0) };
      })() : (() => {
        const end = blockOffset!;
        const source = history === "folded" ? folded : history === "short-blocks" ? shortBlocks : blocks;
        const start = Math.max(0, end - budget);
        return { turnIndex: history === "folded" ? 120 : 0, blocks: source.content.slice(start, end), blockOffset: start,
          blockTotal: source.content.length, blockVisible: start };
      })();
      setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); }, 30);
      return;
    }
    if (url.pathname.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css">
      <style>#chat-output{height:600px;display:flex}.chat-messages{overflow:auto}</style></head>
      <body><div id="chat-output"></div><textarea id="input-box"></textarea><script src="/app.js"></script></body></html>`);
  });
  try {
    await build({ stdin: { resolveDir: root, loader: "ts", contents: `
      import './tests/helpers/realtime-refresh-focus-harness.ts';
      import { fetchEarlierMessages } from './src/web-ui/browser/session-engine';
      window.viewportHistory = {h:window.focusRefreshHarness, fetchEarlierMessages,
        inspect(){const el=document.querySelector('.chat-messages'),s=this.h.state.sessions[0];return{
          height:el.clientHeight,totalHeight:el.scrollHeight,scrollTop:el.scrollTop,
          buffer:Math.max(0,el.scrollHeight-el.clientHeight-Math.abs(el.scrollTop)),
          rows:el.querySelectorAll('.chat-message').length,offset:s.messageOffset,blockOffset:s.leadingBlockOffset,
          phase:document.querySelector('#chat-load-more-sentinel')?.dataset.historyLoad||'idle'};},
        anchor(){const root=document.querySelector('.chat-messages'),r=root.getBoundingClientRect();
          const visible=n=>{const x=n.getBoundingClientRect();return x.bottom>r.top+12&&x.top<r.bottom;};
          const block=Array.from(root.querySelectorAll('.chat-message-content [data-chat-key],.chat-message-text [data-chat-key]')).find(n=>n.getAttribute('data-chat-key').startsWith('["block",')&&visible(n));
          const row=block||Array.from(root.querySelectorAll('.chat-message')).reverse().find(visible);
          window.historyAnchor=row;return row?row.getBoundingClientRect().top:null;},
        async up(){const el=document.querySelector('.chat-messages');el.scrollTop=-Math.max(0,el.scrollHeight-el.clientHeight-el.clientHeight);
          el.dispatchEvent(new Event('scroll'));const top=this.anchor();await this.h.frames();return top;}
      };
    ` }, bundle: true, minify: true, platform: "browser", format: "iife", outfile: join(dir, "app.js"),
      define: { "process.env.NODE_ENV": '"production"' } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await openBrowser("about:blank", 1440, 900);
    const cases: unknown[] = [];
    for (const mode of ["desktop", "mobile", "native-reduced", "rollback"]) {
      const mobile = mode === "mobile";
      history = "turns"; requests.length = 0; failNext = false;
      await browser.send("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1440, height: 900, deviceScaleFactor: 1, mobile });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "native-reduced" ? "reduce" : "no-preference" }, { name: "pointer", value: mobile ? "coarse" : "fine" }] });
      await browser.evaluate("window.__historyBeforeNavigation=true");
      await browser.send("Page.navigate", { url: origin + (mode === "rollback" ? "/?reactUi=0" : "/") });
      await browser.wait("!window.__historyBeforeNavigation&&!!window.viewportHistory", "fixture ready");
      if (mode === "native-reduced") await browser.evaluate("document.documentElement.classList.add('is-wand-app');window.__wandIosNative=true");
      await browser.evaluate(`viewportHistory.h.fresh(${JSON.stringify(turns.slice(-8))},{messageOffset:112,messageTotal:120,leadingBlockOffset:0})`);
      await browser.wait("viewportHistory.inspect().buffer>=viewportHistory.inspect().height*2||viewportHistory.inspect().offset===0", "two-screen initial buffer");
      await browser.settle();
      const initial = await browser.evaluate("viewportHistory.inspect()");
      assert.ok(initial.rows < 40, `${mode}: first load does not render all 120 turns`);
      assert.ok(initial.offset > 0);
      assert.ok(requests.length > 0 && requests.length < 4, `${mode}: only enough pages to fill buffer`);
      const before = requests.length;
      const anchorTop = await browser.evaluate("viewportHistory.up()");
      await browser.wait(`viewportHistory.inspect().offset<${initial.offset}&&viewportHistory.inspect().buffer>=viewportHistory.inspect().height*2`, "history replenished above reader").catch(async error => {
        console.log("history diagnostics", { mode, initial, now:await browser!.evaluate("viewportHistory.inspect()"), anchorTop, requests });
        throw error;
      });
      await browser.settle();
      const anchorAfter = await browser.evaluate("({connected:historyAnchor?.isConnected,top:historyAnchor?.getBoundingClientRect().top})");
      assert.equal(anchorAfter.connected, true, `${mode}: existing reading row survives prepend`);
      assert.ok(Math.abs(anchorAfter.top - anchorTop) <= 1, `${mode}: prepend preserves reading anchor`);
      assert.ok(requests.length > before);
      const after = await browser.evaluate("viewportHistory.inspect()");
      if (mode === "desktop" || mode === "mobile") await browser.screenshot(join(output, `${mode}-viewport.png`));
      // An API failure pauses automatic retries at the same cursor; explicit retry remains available.
      failNext = true;
      await browser.evaluate("viewportHistory.up()");
      await browser.wait("viewportHistory.inspect().phase==='failed'", "load failure feedback");
      const failedRequests = requests.length;
      await browser.evaluate(`(()=>{const h=viewportHistory.h;const s=h.state.sessions[0];h.publish(s.messages.concat({role:'assistant',uuid:'new-tail-after-failure',content:[{type:'text',text:'New streaming tail'}]}));h.doRenderChat(false);})()`);
      await browser.evaluate("new Promise(r=>setTimeout(r,150))");
      assert.equal(requests.length, failedRequests, "new tail/observer notifications cannot automatically retry a failed head cursor");
      await browser.evaluate("document.querySelector('.chat-load-more-btn').click();void 0");
      await browser.wait("viewportHistory.inspect().phase!=='failed'&&viewportHistory.inspect().phase!=='loading'", "explicit retry accepted");
      assert.ok(requests.length > failedRequests);
      noProgressNext = true;
      await browser.evaluate("viewportHistory.up()");
      await browser.wait("viewportHistory.inspect().phase==='failed'", "non-progressing page stops");
      const noProgressRequests = requests.length;
      await browser.evaluate("new Promise(r=>setTimeout(r,150))");
      assert.equal(requests.length, noProgressRequests, "successful HTTP with an unchanged cursor cannot loop");
      assert.ok(requests.every(r => r.budget === 12 && r.byteBudget === 98304));
      cases.push({ mode, initial, after, anchorTop, anchorAfter, requests: [...requests] });
    }
    // Regression: several successful pages can still fit inside one viewport.
    // scrollHeight stays equal to clientHeight until enough short blocks arrive.
    for (const height of [600, 1100]) {
      history = "short-blocks"; requests.length = 0;
      await browser.evaluate("window.__historyBeforeNavigation=true");
      await browser.send("Page.navigate", { url: origin });
      await browser.wait("!window.__historyBeforeNavigation&&!!window.viewportHistory", "short blocks ready");
      await browser.evaluate(`document.getElementById('chat-output').style.height='${height}px'`);
      await browser.evaluate(`viewportHistory.h.fresh([{...${JSON.stringify(shortBlocks)},content:${JSON.stringify(shortBlocks.content.slice(-1))}}],{messageOffset:0,messageTotal:1,leadingBlockOffset:239,leadingBlockTotal:240})`);
      await browser.wait("viewportHistory.inspect().buffer>=viewportHistory.inspect().height*2", "short pages must fill viewport plus two screens").catch(async error => {
        console.log("underfill diagnostics", { height, page: await browser!.evaluate("viewportHistory.inspect()"), requests });
        throw error;
      });
      const filled = await browser.evaluate("viewportHistory.inspect()");
      assert.ok(requests.length > 2, "several short pages are required before geometry can grow");
      assert.ok(filled.blockOffset > 0, "stop prefetching after the buffer is filled, not at the end of history");
      const count = requests.length;
      await browser.evaluate("new Promise(r=>setTimeout(r,150))");
      assert.equal(requests.length, count, "sufficient buffer stops automatic requests");
      cases.push({ mode: `underfilled-short-blocks-${height}`, filled, requests: [...requests] });
    }
    history = "short-blocks"; requests.length = 0;
    await browser.evaluate("window.__historyBeforeNavigation=true");
    await browser.send("Page.navigate", { url: origin });
    await browser.wait("!window.__historyBeforeNavigation&&!!window.viewportHistory", "finite short history ready");
    await browser.evaluate(`viewportHistory.h.fresh([{...${JSON.stringify(shortBlocks)},content:${JSON.stringify(shortBlocks.content.slice(4, 5))}}],{messageOffset:0,messageTotal:1,leadingBlockOffset:4,leadingBlockTotal:5})`);
    await browser.wait("viewportHistory.inspect().blockOffset===0&&!document.getElementById('chat-load-more-sentinel')", "history end is the only short-screen success stop");
    const exhaustedCount = requests.length;
    await browser.evaluate("new Promise(r=>setTimeout(r,150))");
    assert.equal(requests.length, exhaustedCount, "exhausted short history does not fetch phantom pages");
    cases.push({ mode: "short-history-exhausted", page: await browser.evaluate("viewportHistory.inspect()"), requests: [...requests] });
    history = "blocks"; requests.length = 0;
    await browser.evaluate("window.__historyBeforeNavigation=true");
    await browser.send("Page.navigate", { url: origin });
    await browser.wait("!window.__historyBeforeNavigation&&!!window.viewportHistory", "block fixture ready");
    await browser.evaluate(`viewportHistory.h.fresh([{...${JSON.stringify(blocks)},content:${JSON.stringify(blocks.content.slice(-12))}}],{messageOffset:0,messageTotal:1,leadingBlockOffset:228,leadingBlockTotal:240})`);
    await browser.wait("viewportHistory.inspect().buffer>=viewportHistory.inspect().height*2", "long-turn buffer");
    const longTurn = await browser.evaluate("viewportHistory.inspect()");
    assert.ok(longTurn.blockOffset > 0 && longTurn.blockOffset < 240);
    const content = await browser.evaluate("viewportHistory.h.state.sessions[0].messages[0].content.length");
    assert.ok(content < 48, "one long turn remains block-windowed");
    assert.ok(requests.length > 0 && requests.every(r => r.blockOffset !== undefined && r.budget === 12));
    const blockAnchor = await browser.evaluate("viewportHistory.up()");
    await browser.wait(`viewportHistory.inspect().blockOffset<${longTurn.blockOffset}&&viewportHistory.inspect().buffer>=viewportHistory.inspect().height*2`, "long turn replenished");
    await browser.settle();
    const blockAfter = await browser.evaluate("({connected:historyAnchor?.isConnected,top:historyAnchor?.getBoundingClientRect().top})");
    assert.equal(blockAfter.connected, true);
    assert.ok(Math.abs(blockAfter.top - blockAnchor) <= 1, "block pagination preserves the visible content inside a long turn");
    cases.push({ mode: "single-long-turn", longTurn, content, blockAnchor, blockAfter, requests: [...requests] });
    history = "folded"; requests.length = 0;
    await browser.evaluate("window.__historyBeforeNavigation=true");
    await browser.send("Page.navigate", { url: origin });
    await browser.wait("!window.__historyBeforeNavigation&&!!window.viewportHistory", "folded head ready");
    await browser.evaluate(`viewportHistory.h.fresh([{...${JSON.stringify(folded)},content:${JSON.stringify(folded.content.slice(-12))}}],{messageOffset:120,messageTotal:121,leadingBlockOffset:68,leadingBlockTotal:80})`);
    await browser.wait("viewportHistory.inspect().offset<120&&viewportHistory.inspect().buffer>=viewportHistory.inspect().height*2", "completed closed head proceeds to older readable turns");
    assert.ok(requests.some(r => r.blockOffset !== undefined) && requests.some(r => r.before !== undefined));
    assert.ok(requests.filter(r => r.blockOffset !== undefined).length > 2, "consecutive folded pages must not stall while screen is underfilled");
    assert.ok(requests.length < 10, "stop once earlier readable turns fill the buffer");
    cases.push({ mode: "closed-head-to-earlier-turns", page: await browser.evaluate("viewportHistory.inspect()"), requests: [...requests] });
    history = "turns";
    await browser.evaluate(`(async()=>{const h=viewportHistory.h;h.publish([]);h.doRenderChat(false);
      h.publish(${JSON.stringify(turns.slice(-8))},{messageOffset:112,messageTotal:120,leadingBlockOffset:0});h.doRenderChat(false);await h.frames();
      h.state.chatStickToBottom=true;document.querySelector('.chat-messages').dispatchEvent(new WheelEvent('wheel',{deltaY:-20}));})()`);
    assert.equal(await browser.evaluate("viewportHistory.h.state.chatStickToBottom"), false,
      "empty-to-nonempty replaces/rebinds the scroll root instead of reusing its old listener owner");
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "viewport-browser.json"), JSON.stringify({ cases, errors: browser.errors }, null, 2));
  } finally {
    await browser?.close(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(r => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
