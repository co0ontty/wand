import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import express from "express";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("real browser incrementally loads conversation history, preserves rows and renders small screens", {
  skip: process.env.WAND_CONVERSATIONS_BROWSER !== "1", timeout: 120_000,
}, async t => {
  const h = conversationHarness(t), id = await h.group();
  for (let n = 0; n < 125; n++) h.storage.appendConversationEvent(id, { messageId: `m${n}`, role: "user",
    createdAt: new Date(1700000000000 + n).toISOString(), content: [{ type: "text", text: `history-message-${n}` }] });
  const temp = mkdtempSync(join(tmpdir(), "wand-sync-browser-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import * as React from "react";
    import {createRoot} from "react-dom/client";
    import {conversationsRepository as repo} from "./src/web-ui/react/conversations/repository";
    import {ConversationMessages} from "./src/web-ui/react/ai-teams/team-chat-view";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    installReactUiStyles();
    function App(){const [detail,setDetail]=React.useState(null);const ref=React.useRef(null);const [loading,setLoading]=React.useState(false);
      const load=async(older=false)=>{setLoading(true);try{const d=await repo.detail(${JSON.stringify(id)},ref.current,older);ref.current=d;setDetail(d);globalThis.syncResult={count:d.messages.length,total:d.history?.total,hasEarlier:d.history?.hasEarlier};}finally{setLoading(false)}};
      React.useEffect(()=>{globalThis.syncRefresh=()=>load();void load()},[]);
      return <div className="conversation-message-scroll" style={{height:'90vh',overflow:'auto'}}><ConversationMessages turns={detail?.messages??[]} ready={!!detail} taskLabels={{}} group={false} hasEarlier={detail?.history?.hasEarlier} loadingEarlier={loading} onLoadEarlier={()=>load(true)} onOpenConversation={()=>{}}/></div>
    }
    createRoot(document.getElementById('root')).render(<WandUiProvider><App/></WandUiProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
  const app = express(); app.use(express.json()); registerConversationRoutes(app, h.service);
  const responses: Array<{ length: number; unchanged: boolean; changed: number }> = [];
  app.get("/metrics", (_req, res) => res.json(responses));
  app.get("/api/config", (_req, res) => res.json({}));
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync("src/web-ui/content/styles.css")));
  app.get("*", (_req, res) => res.type("html").send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser("about:blank", 1280, 900);
  const output = resolve("output/architecture-stage2/web-latency-complete/browser-sync"); mkdirSync(output, { recursive: true });
  try {
    await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}` });
    await browser.wait("globalThis.syncResult?.count===40", "first history page");
    assert.equal(await browser.evaluate("syncResult.total"), 125);
    await browser.evaluate("syncRefresh()");
    assert.equal(await browser.evaluate("syncResult.count"), 40);
    // Reveal the locally windowed rows until the canonical history button reaches server history.
    for (let i = 0; i < 5 && await browser.evaluate("syncResult.count===40"); i++) {
      await browser.evaluate("document.querySelector('.conversation-history-more button')?.click()");
      await new Promise(r => setTimeout(r, 120));
    }
    await browser.wait("syncResult.count===80", "server-side history prepend");
    h.storage.appendConversationEvent(id, { messageId: "newest", role: "assistant", createdAt: new Date().toISOString(), content: [{ type: "text", text: "new-update" }] });
    await browser.evaluate("syncRefresh()");
    assert.equal(await browser.evaluate("syncResult.count"), 81);
    const snapshots = [];
    for (const width of [1280, 390]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
      await new Promise(r => setTimeout(r, 120));
      const geometry = await browser.evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,rows:document.querySelectorAll('.conversation-message').length})");
      assert.ok(geometry.scroll <= geometry.width + 1); snapshots.push(geometry);
      const shot = await browser.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(output, `${width}.png`), Buffer.from(shot.data, "base64"));
    }
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, snapshots, count: await browser.evaluate("syncResult.count"), scope: "source UI + SQLite, no real model" }, null, 2));
  } finally { await browser.close(); }
});
