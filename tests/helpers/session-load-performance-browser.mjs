import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openBrowser } from "./sidebar-ux-browser.mjs";

// Production renderer + synthetic turns in real Chrome. No model or installed data.
export async function runSessionLoadPerformance() {
  const root = resolve(import.meta.dirname, "../..");
  const dir = mkdtempSync(join(tmpdir(), "wand-session-perf-source-"));
  let browser, server;
  try {
    const file = join(dir, "app.js");
    await build({ stdin: { resolveDir: root, loader: "ts", contents: `
      import "./tests/helpers/realtime-refresh-focus-harness.ts";
      window.sessionPerf = {
        turns: [{role:"assistant",uuid:"performance-turn",createdAt:"2026-10-08T00:00:00Z",content:
          Array.from({length:200},(_,i)=>[
            {type:"tool_use",id:"perf-"+i,name:"Bash",input:{command:"printf proof-"+i},activity:{kind:"run_command",fileKey:"fixture-"+i}},
            {type:"tool_result",tool_use_id:"perf-"+i,content:"result-"+i}
          ]).flat()}],
        async load() {
          const h=window.focusRefreshHarness;h.state.config={...h.state.config,cardDefaults:{}};
          const start=performance.now();h.clearActivityDetailState();h.state.toolContentCache={};h.state.sessions=[];h.state.selectedId="focus-A";
          h.state.currentView="chat";h.resetChatRenderCache();h.publish(this.turns);h.doRenderChat(false);
          const renderMs=performance.now()-start;await h.frames();return renderMs;
        },
        inspect() { return { calls:document.querySelectorAll('.chat-call').length,
          mountedCalls:document.querySelectorAll('.chat-call[data-x-presentation="call"]').length,
          mountedDetails:document.querySelectorAll('.chat-call-detail [data-x-presentation]').length,
          activityCount:document.querySelectorAll('.chat-activity').length,
          expanded:document.querySelector('.chat-activity')?.dataset.expanded,
          summary:document.querySelector('.chat-process-summary')?.textContent,
          nestedButtons:document.querySelectorAll('button button').length,
          themeNamespaces:Array.from(new Set(Array.from(document.querySelectorAll('#chat-output [class]')).flatMap(n=>Array.from(n.classList).filter(c=>c.startsWith('css-var-')||c==='wand-ui'||c==='wand-ui-reduced')))) }; }
      };
    ` }, bundle: true, minify: true, platform: "browser", format: "iife", outfile: file,
      define: { "process.env.NODE_ENV": '"production"' } });
    server = createServer((req, res) => {
      const path = new URL(req.url, "http://fixture.test").pathname;
      const files = { "/app.js": [file, "text/javascript"],
        "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
        "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"] };
      if (files[path]) { res.setHeader("Content-Type", files[path][1]); res.end(readFileSync(files[path][0])); return; }
      if (path.includes("/tool-content/")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ input: { command: "printf proof" }, content: "Full result", pending: false, resultAvailable: true })); return;
      }
      if (path.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css">
        <style>#chat-output{height:600px;display:flex}.chat-messages{overflow:auto}</style></head>
        <body><div id="chat-output"></div><textarea id="input-box"></textarea><script src="/app.js"></script></body></html>`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await openBrowser("about:blank", 1440, 900);
    const cases = [];
    for (const mode of ["desktop", "390px", "native-reduced"]) {
      const mobile = mode === "390px";
      await browser.send("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1440, height: 900, deviceScaleFactor: 1, mobile });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "native-reduced" ? "reduce" : "no-preference" }] });
      await browser.send("Page.navigate", { url: base });
      await browser.wait("!!window.sessionPerf", "real renderer ready");
      if (mode === "native-reduced") await browser.evaluate("document.documentElement.classList.add('is-wand-app')");
      const renderMs = await browser.evaluate("localStorage.removeItem('wand-chat-expand-state-v1');sessionPerf.load()");
      const collapsed = await browser.evaluate("sessionPerf.inspect()");
      await browser.evaluate("(()=>{const summary=document.querySelector('.chat-process-summary');summary.focus({preventScroll:true});summary.click();})()");
      await browser.wait("document.querySelector('.chat-activity')?.dataset.expanded==='true'", "timeline expanded");
      await browser.settle();
      const expanded = await browser.evaluate("sessionPerf.inspect()");
      await browser.evaluate("(()=>{const control=document.querySelector('.chat-call-button');control.focus({preventScroll:true});control.click();})()");
      await browser.settle();
      await browser.wait("!!document.querySelector('.chat-call[data-expanded=true] .chat-call-detail')?.textContent.trim()", "full tool detail").catch(async error => {
        console.log("detail diagnostics", await browser.evaluate("({snapshot:sessionPerf.inspect(),entry:document.querySelector('.chat-call')?.outerHTML.slice(0,1400),open:Array.from(document.querySelectorAll('.chat-call[data-expanded=true]')).map(n=>({text:n.textContent.slice(0,100),html:n.outerHTML.slice(-700)}))})"), browser.errors);
        throw error;
      });
      const detailed = await browser.evaluate("sessionPerf.inspect()");
      await browser.evaluate("(()=>{const summary=document.querySelector('.chat-process-summary');summary.focus({preventScroll:true});summary.click();})()");
      await browser.wait("document.querySelector('.chat-activity')?.dataset.expanded==='false'", "timeline closed");
      await browser.settle();
      const closed = await browser.evaluate("sessionPerf.inspect()");
      // A repeated snapshot must not create roots in the now closed timeline.
      const repaintMs = await browser.evaluate("(()=>{const h=focusRefreshHarness;const start=performance.now();h.publish(sessionPerf.turns);h.doRenderChat(true);return performance.now()-start})()");
      await browser.settle();
      const reloaded = await browser.evaluate("sessionPerf.inspect()");
      // A same-source repaint must honor the explicitly expanded timeline.
      await browser.evaluate("(()=>{const summary=document.querySelector('.chat-process-summary');summary.focus({preventScroll:true});summary.click();})()");
      await browser.wait("document.querySelector('.chat-activity')?.dataset.expanded==='true'", "timeline reopened");
      await browser.settle();
      await browser.evaluate("focusRefreshHarness.doRenderChat(true);void 0");
      await browser.settle();
      const persistedOpen = await browser.evaluate("sessionPerf.inspect()");
      // Report the existing cross-generation key drift separately from the
      // lazy-mount regression; do not silently change expansion preferences.
      const beforeRestore = await browser.evaluate("({key:document.querySelector('.chat-activity')?.dataset.expandKey,saved:JSON.parse(localStorage.getItem('wand-chat-expand-state-v1')||'{}'),expanded:document.querySelector('.chat-activity')?.dataset.expanded})");
      await browser.evaluate("focusRefreshHarness.fresh(sessionPerf.turns)");
      await browser.settle();
      const restored = await browser.evaluate("sessionPerf.inspect()");
      cases.push({ mode, renderMs, repaintMs, collapsed, expanded, detailed, closed, reloaded, persistedOpen, restored, beforeRestore, restoredKey:await browser.evaluate("document.querySelector('.chat-activity')?.dataset.expandKey") });
    }
    return { cases, exceptions: browser.errors };
  } finally {
    await browser?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}
