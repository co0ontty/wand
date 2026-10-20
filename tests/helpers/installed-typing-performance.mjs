import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

// Read-only installed-service probe. Drafts exist only in this fresh browser
// context; never submit text, invoke models, or modify existing server data.
export async function measureInstalledTyping({ sourceAssets = false, output } = {}) {
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const evidence = { installedService: true, sourceAssets, cpuThrottle: 4, cases: [] };
  try {
    assert.equal((await context.request.post(origin + "/api/login", { data: { appToken: decoded.slice(decoded.lastIndexOf("#") + 1) } })).status(), 200);
    const sessions = await (await context.request.get(origin + "/api/sessions")).json();
    const candidates = sessions.filter(s => s.sessionKind === "structured" && s.command !== "system-ai" && !s.automationId?.startsWith("system-ai:") && !s.archivedAt && ["idle", "completed", "stopped"].includes(s.status));
    candidates.sort((a, b) => (b.messageTotal || b.messages?.length || 0) - (a.messageTotal || a.messages?.length || 0));
    const target = candidates[0];
    assert.ok(target, "Need an existing idle structured session");
    const page = await context.newPage();
    const errors = [], unexpectedWrites = [];
    page.on("pageerror", error => errors.push(error.message.split(origin).join("<service>")));
    // Abort any accidental execution before it reaches the service.
    await page.route("**/api/**", route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (!["GET", "HEAD"].includes(request.method()) && !path.endsWith("/completion/view")) {
        unexpectedWrites.push(request.method() + " " + path.replace(/\/[a-zA-Z0-9_-]{12,}/g, "/:id"));
        return route.abort();
      }
      return route.continue();
    });
    if (sourceAssets) {
      const dir = "src/web-ui/content";
      const manifest = JSON.parse(readFileSync(join(dir, "module-manifest.json"), "utf8"));
      const bootstrap = readFileSync(join(dir, "scripts.js"), "utf8")
        .replace("${browserModuleSrc}", "/assets/" + manifest.entry)
        .replace('"${browserModuleImports}"', JSON.stringify(manifest.imports))
        .replace("${aiTeamsChunkSrc}", "/assets/ai-teams.js")
        .replace("${plushAvatarChunkSrc}", "/assets/plush-avatar.js");
      await page.route("**/assets/**", route => {
        const path = new URL(route.request().url()).pathname.slice("/assets/".length);
        if (path === "app.css") return route.fulfill({ body: readFileSync(join(dir, "tailwind.css"), "utf8") + "\n" + readFileSync(join(dir, "styles.css"), "utf8"), contentType: "text/css" });
        if (path === "app.js") return route.fulfill({ body: bootstrap, contentType: "application/javascript" });
        if (/^(?:(?:modules|vendor)\/[a-zA-Z0-9_./-]+|plush-avatar|ai-teams)\.js$/.test(path)) {
          try { return route.fulfill({ body: readFileSync(join(dir, path)), contentType: "application/javascript" }); } catch {}
        }
        return route.continue();
      });
    }
    await page.addInitScript(() => {
      window.__typing = { handlers: [], mutations: 0, longTasks: [], frames: [] };
      const original = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (type !== "input" || !(this instanceof HTMLTextAreaElement) || this.id !== "input-box" || typeof listener !== "function") return original.call(this, type, listener, options);
        return original.call(this, type, function(...args) {
          const start = performance.now();
          try { return listener.apply(this, args); }
          finally { window.__typing.handlers.push(performance.now() - start); }
        }, options);
      };
      new PerformanceObserver(list => window.__typing.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: "longtask", buffered: false });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto(origin + "/?session=" + encodeURIComponent(target.id));
    const input = page.locator("#input-box");
    await input.waitFor({ state: "attached" });
    await page.locator("#chat-output [data-chat-renderer=canonical]").first().waitFor({ state: "attached" });
    const entry = page.locator(".composer-compact-entry:visible");
    if (await entry.count()) await entry.click();
    await input.focus();
    await page.waitForTimeout(1500);
    assert.ok(!(await input.getAttribute("placeholder"))?.includes("只能查看日志"), "Selected session must allow drafting");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    for (const draft of ["short", "multiline"]) {
      await input.fill(draft === "short" ? "" : "性能测试，不发送。".repeat(100));
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        window.__typing.handlers = []; window.__typing.longTasks = []; window.__typing.mutations = 0; window.__typing.frames = [];
        window.__typing.observer = new MutationObserver(records => window.__typing.mutations += records.length);
        window.__typing.observer.observe(document.querySelector(".input-panel"), { attributes: true, childList: true, characterData: true, subtree: true });
        let last = performance.now();
        const frame = now => { window.__typing.frames.push(now - last); last = now; window.__typing.raf = requestAnimationFrame(frame); };
        window.__typing.raf = requestAnimationFrame(frame);
      });
      const before = await cdp.send("Performance.getMetrics");
      await cdp.send("Profiler.enable"); await cdp.send("Profiler.start");
      const start = performance.now();
      await input.pressSequentially("performance typing test 0123456789 ".repeat(2), { delay: 25 });
      const elapsedMs = performance.now() - start;
      const { profile } = await cdp.send("Profiler.stop");
      const after = await cdp.send("Performance.getMetrics");
      const result = await page.evaluate(() => {
        const t = window.__typing; t.observer.disconnect(); cancelAnimationFrame(t.raf);
        const summarize = values => { const v = values.slice().sort((a,b) => a-b); return { count:v.length, totalMs:v.reduce((a,b)=>a+b,0), p95Ms:v[Math.floor(v.length*.95)] || 0, maxMs:v.at(-1) || 0 }; };
        const n = document.getElementById("input-box"), s = getComputedStyle(n);
        return { handlers:summarize(t.handlers), frames:summarize(t.frames), longTasks:summarize(t.longTasks), mutations:t.mutations,
          mountedMessages:document.querySelectorAll(".chat-message").length, domNodes:document.getElementsByTagName("*").length,
          height:n.getBoundingClientRect().height, maxHeight:parseFloat(s.maxHeight), clipped:n.classList.contains("has-clipped-draft"),
          plush:window.__wandPlushDiagnostics?.() ?? null };
      });
      const first = Object.fromEntries(before.metrics.map(m=>[m.name,m.value]));
      const delta = Object.fromEntries(after.metrics.filter(m=>/^(LayoutCount|RecalcStyleCount|LayoutDuration|RecalcStyleDuration|ScriptDuration|TaskDuration)$/.test(m.name)).map(m=>[m.name,m.value-first[m.name]]));
      const hits = new Map(); for (const id of profile.samples || []) hits.set(id,(hits.get(id)||0)+1);
      const hotspots = profile.nodes.map(n=>({ name:n.callFrame.functionName || "(anonymous)", file:basename(n.callFrame.url), line:n.callFrame.lineNumber+1, samples:hits.get(n.id)||0 })).sort((a,b)=>b.samples-a.samples).slice(0,12);
      evidence.cases.push({ draft, elapsedMs, ...result, metrics:delta, hotspots });
    }
    await input.fill("");
    assert.deepEqual(unexpectedWrites, []);
    assert.deepEqual(errors, []);
    evidence.errors = errors; evidence.noExecutionRequests = true;
    if (output) { mkdirSync(join(output, ".."), { recursive:true }); writeFileSync(output, JSON.stringify(evidence,null,2)+"\n"); }
    return evidence;
  } finally {
    await context.request.post(origin + "/api/logout");
    await context.close(); await browser.close();
  }
}
