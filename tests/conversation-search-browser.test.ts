import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import express from "express";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";

/** IM-01: the sidebar search stays visible, preserves the query, and keeps one clear action. */
test("conversation sidebar search stays inside the sidebar across viewports and modes", {
  skip: process.env.WAND_CONVERSATIONS_BROWSER !== "1", timeout: 240_000,
}, t => runSearchBrowser(t));

async function runSearchBrowser(t: TestContext): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-conversation-search-"));
  const evidenceRoot = process.env.WAND_CONVERSATION_EVIDENCE_DIR || join(root, ".wand-team/conversation-search-browser");
  const evidenceDir = join(evidenceRoot, "search"); mkdirSync(evidenceDir, { recursive: true });
  const h = conversationHarness(t);
  // Isolated fixture rows only: empty groups carry no messages, tasks or model calls.
  for (const [name, employeeId] of [["IM搜索边界甲", "e_test_1"], ["IM搜索边界乙", "e_test_2"], ["IM搜索边界丙丁", "e_test_3"]] as const) {
    const receipt = await h.service.createGroup(randomUUID(), { name, employeeIds: [employeeId] });
    assert.equal(receipt.state, "accepted", receipt.error);
  }
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { ShellSidebar } from "./src/web-ui/react/shell/shell-sidebar";
    import { ShellMainContent } from "./src/web-ui/react/shell/shell-main-content";
    import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
    import { UiStoreProvider } from "./src/web-ui/react/shell/ui-store-react";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { PortalContainerProvider } from "./src/web-ui/react/ui";
    import { ComposerStore } from "./src/web-ui/browser/composer";
    import { configureTeamChatComposerRuntime } from "./src/web-ui/react/ai-teams/composer-bridge";
    import { conversationUi } from "./src/web-ui/react/conversations/state";
    import "./src/web-ui/react/ai-teams/chunk-entry";
    installReactUiStyles();
    const composer = new ComposerStore({ storage: () => localStorage, isUnloading: () => false, disposeAttachment: () => {} });
    configureTeamChatComposerRuntime({ read: id => composer.read(id), edit: (id,c) => composer.edit(id,c),
      subscribe: f => composer.subscribe(f), submit: (id,text,deliver) => composer.submit(id,text,deliver), transfer: (a,b,r) => composer.transfer(a,b,r) });
    let snapshot = { auth: { phase: "authenticated" }, viewport: { mobile: innerWidth < 640, online: true, embedTerminal: false, nativeInput: false },
      capabilities: { backToNative: false, switchServer: false }, selected: null,
      layout: { sessionsDrawerOpen: innerWidth >= 640, sidebarPinned: true, sidebarCollapsed: false, sidebarDrawer: innerWidth < 640,
        sidebarAnchored: innerWidth >= 640, sessionsBackdropVisible: false, filePanelOpen: false, filePanelBackdropVisible: false, topbarMoreOpen: false, currentView: "chat" },
      sidebar: { interactiveCount: 0, totalCount: 0, manageMode: false, selectedCount: 0, groups: [] },
      topbar: { title: "Wand", description: "", statusLabel: "", statusTone: "", cwd: "", currentTask: "", titleGenerating: false, git: null },
      legacyVisibility: { terminal: false, chat: false, blank: true, composer: false } };
    const store = new MemoryUiAdapter(snapshot, { batchMs: 0 });
    store.dispatch = action => {
      if (action.type === "layout.drawer.toggle" || action.type === "layout.drawer.close") {
        const open = action.type === "layout.drawer.toggle" && !snapshot.layout.sessionsDrawerOpen;
        snapshot = { ...snapshot, layout: { ...snapshot.layout, sessionsDrawerOpen: open, sessionsBackdropVisible: open && snapshot.layout.sidebarDrawer } };
        store.setSnapshot(snapshot);
      }
    };
    globalThis.conversationFixture = { composer, conversationUi, store };
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}>
      <WandUiProvider><UiStoreProvider store={store}><div style={{height:"100dvh",display:"flex",minHeight:0}}><ShellSidebar/><ShellMainContent/></div></UiStoreProvider></WandUiProvider>
    </PortalContainerProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
    outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const app = express(); app.use(express.json()); registerConversationRoutes(app, h.service);
  app.get("/api/silicon-employees", (_req, res) => res.json({ employees: h.storage.listSiliconEmployees({ includeArchived: true }) }));
  app.get("/api/ai-teams", (_req, res) => res.json(h.storage.listAiTeams()));
  app.get("/api/workspaces", (_req, res) => res.json(h.storage.listWorkspaces()));
  app.get("/api/tasks", (_req, res) => res.json([]));
  app.get("/api/ai-team-runs", (_req, res) => res.json([]));
  app.get("/api/attention", (_req, res) => res.json({ items: [] }));
  app.get("/api/*", (_req, res) => res.json({}));
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/styles.css"))));
  app.get("/tailwind.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/tailwind.css"))));
  app.get("*", (req, res) => {
    if (req.path.includes("aiTeamsChunkSrc")) { res.type("js").send("/* real chunk components already bundled into this test harness */"); return; }
    const native = req.query.native === "1" ? "is-wand-app" : "";
    res.type("html").send(`<!doctype html><html class="${native}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><div id="overlay-root"><div class="wand-ui-portals" id="portals"></div></div><script src="/app.js"></script></body></html>`);
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));
  const rows: unknown[] = [], errors: string[] = []; let socket: WebSocket | null = null;
  try {
    for (let n = 0; n < 120 && !existsSync(join(temp, "profile/DevToolsActivePort")); n++) await pause(50);
    const port = readFileSync(join(temp, "profile/DevToolsActivePort"), "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(tabs.find(tab => tab.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0; const pending = new Map<number, (value: any) => void>();
    socket.addEventListener("message", event => { const m = JSON.parse(String(event.data));
      if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params));
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(resolvePromise => {
      const id = ++sequence; pending.set(id, resolvePromise); socket!.send(JSON.stringify({ id, method, params }));
    }).then((m: any) => { if (m.error) throw new Error(JSON.stringify(m.error)); return m.result; });
    const evaluate = async (expression: string): Promise<any> => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await pause(40); }
      throw new Error(`Timeout: ${expression}; ${await evaluate("document.body.innerText.slice(-400)")}; errors=${errors.slice(0, 2)}`);
    };
    const visibleSelector = (selector: string): string =>
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(n=>n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && n.getBoundingClientRect().width>1 && n.getBoundingClientRect().height>1 && !n.closest('[inert],[hidden]'))`;
    const click = async (selector: string): Promise<void> => {
      let point: { x: number; y: number; hit: boolean } | null = null;
      for (let attempt = 0; attempt < 150 && !point?.hit; attempt++) {
        await pause(40);
        point = await evaluate(`(()=>{const n=${visibleSelector(selector)};if(!n)return null;n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const h=document.elementFromPoint(x,y);return {x,y,hit:h===n||n.contains(h)}})()`);
      }
      if (!point?.hit) {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(evidenceDir, `blocked-click-${selector.replace(/[^a-z]/gi, "")}.png`), Buffer.from(shot.data, "base64"));
      }
      assert.ok(point?.hit, `actual click target visible: ${selector}; point=${JSON.stringify(point)}`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    };
    const key = async (name: string): Promise<void> => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: name === "Escape" ? 27 : name === "Enter" ? 13 : 0 });
      }
    };
    const rect = (selector: string) => evaluate(`(()=>{const n=${visibleSelector(selector)};if(!n)return null;const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,left:r.left}})()`);
    const shot = async (name: string): Promise<void> => {
      const image = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidenceDir, `${name}.png`), Buffer.from(image.data, "base64"));
    };
    await send("Page.enable"); await send("Runtime.enable");
    const geometry = () => evaluate(`(()=>{
      const input=document.querySelector('.conversation-search-input input');
      const box=document.querySelector('.conversation-search-input');
      const side=document.getElementById('sessions-drawer');
      const r=input?.getBoundingClientRect(), s=side?.getBoundingClientRect();
      const chain=Array.from(document.querySelectorAll('.conversation-search-input,.conversation-search-host,.conversation-sidebar-tools,.sidebar-header-actions,.sidebar-header-primary,.sidebar-header')).map(n=>{
        const b=n.getBoundingClientRect();const st=getComputedStyle(n);
        return {cls:n.className.slice(0,40),x:b.x,width:b.width,display:st.display,position:st.position,widthStyle:st.width};});
      return { input:r&&{x:r.x,y:r.y,left:r.left,right:r.right,width:r.width,height:r.height},
        host:box?.getBoundingClientRect().x ?? null, chain,
        sidebar:s&&{left:s.left,right:s.right,width:s.width},
        viewport:{w:innerWidth,h:innerHeight}, scrollWidth:document.documentElement.scrollWidth, bodyScrollWidth:document.body.scrollWidth };
    })()`);
    const searchState = () => evaluate(`(()=>{
      const trigger=Array.from(document.querySelectorAll('.conversation-search-host button'))[0];
      const input=document.querySelector('.conversation-search-input input');
      const host=document.querySelector('.conversation-search-host');
      return { open:host?.dataset.open??null, triggerLabel:trigger?.getAttribute('aria-label'),
        focused:document.activeElement===input, triggerFocused:document.activeElement===trigger,
        value:input?.value??null, inert:document.querySelector('.conversation-search-input')?.hasAttribute('inert')??null,
        rows:document.querySelectorAll('.conversation-sidebar-list .conversation-row').length,
        empty:document.body.innerText.includes('没有匹配的对话或任务') };
    })()`);

    for (const scenario of [
      { name: "desktop-1440", width: 1440, height: 1000, drawer: false, native: false, reduced: false },
      { name: "narrow-390", width: 390, height: 844, drawer: true, native: false, reduced: false },
      { name: "edge-320", width: 320, height: 720, drawer: true, native: false, reduced: false },
      { name: "native-390", width: 390, height: 844, drawer: true, native: true, reduced: false },
      { name: "reduced-1440", width: 1440, height: 1000, drawer: false, native: false, reduced: true },
    ]) {
      await send("Emulation.setDeviceMetricsOverride", { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: scenario.reduced ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `${origin}/?mode=${scenario.name}${scenario.native ? "&native=1&reactUi=0" : ""}` });
      await wait("!!document.querySelector('.conversation-search-host')");
      if (scenario.drawer) await click('[aria-label="打开列表"]');
      await evaluate("conversationFixture.conversationUi.filter('list-query','')");
      await wait("document.querySelectorAll('.conversation-sidebar-list .conversation-row').length>1");
      const allRows = (await searchState()).rows;
      const opened = await geometry();
      assert.ok(opened.input.width >= 160, `${scenario.name}: always-visible search has usable width`);
      assert.ok(opened.input.left >= opened.sidebar.left && opened.input.right <= opened.sidebar.right);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      const toolsBefore = await rect('.sidebar-header-actions');
      await click('.conversation-search-input input');
      await send("Input.insertText", { text: "边界甲" });
      await wait("document.querySelectorAll('.conversation-sidebar-list .conversation-row').length===1");
      assert.equal(await evaluate("document.querySelector('.conversation-row-title').textContent.includes('边界甲')"), true);
      assert.deepEqual(await rect('.sidebar-header-actions'), toolsBefore, "search never hides or moves the header actions");
      await shot(`${scenario.name}-01-filtered`);
      const composingEscape = await evaluate(`(()=>{const i=document.querySelector('.conversation-search-input input');
        const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:true});
        const stop=()=>e.stopPropagation();document.body.addEventListener('keydown',stop,{once:true});i.dispatchEvent(e);
        return {value:i.value,consumed:e.defaultPrevented};})()`);
      assert.equal(composingEscape.value, "边界甲"); assert.equal(composingEscape.consumed, false);
      await send("Input.insertText", { text: "不存在" });
      await wait("document.querySelectorAll('.conversation-sidebar-list .conversation-row').length===0");
      assert.equal((await searchState()).empty, true);
      await click('[aria-label="清空搜索"]');
      await wait("document.querySelector('.conversation-search-input input')?.value===''");
      assert.equal((await searchState()).focused, true);
      assert.equal((await searchState()).rows, allRows);
      await send("Input.insertText", { text: "边界乙" });
      await key("Escape");
      await wait("document.querySelector('.conversation-search-input input')?.value===''");
      assert.equal((await searchState()).focused, true);
      assert.equal(await evaluate("!!document.getElementById('sessions-drawer')?.checkVisibility()"), true);
      await send("Input.insertText", { text: "边界甲" });
      await click('[data-stretch-value="tasks"]');
      await wait("conversationFixture.conversationUi.getSnapshot().mode==='tasks'");
      await click('[data-stretch-value="chats"]');
      await wait("conversationFixture.conversationUi.getSnapshot().mode==='chats'");
      assert.equal((await searchState()).value, "边界甲", "switching sections preserves the chat search");
      if (scenario.drawer) {
        await click('#close-drawer-button');
        await click('[aria-label="打开列表"]');
        assert.equal((await searchState()).value, "边界甲", "reopening the list preserves its search");
      }
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.conversation-search-input')).transform"), "none");
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      await shot(`${scenario.name}-02-preserved`);
      rows.push({ scenario: scenario.name, opened, persistentSearch: true, preservedQuery: true });
    }

    // 01-A6: the run never sends a message, creates a task, or starts a model.
    assert.equal(h.sent.length, 0, "no messages sent");
    assert.equal(h.executions.length, 0, "no model execution started");
    assert.equal(h.storage.listWandTasks().length, 0, "no tasks created");
    assert.deepEqual(errors, [], "no page exceptions");
    writeFileSync(join(evidenceDir, "result.json"), JSON.stringify({
      passed: true, scope: "Real Chrome + source React shell + isolated SQLite/API; no installed-service acceptance",
      chrome: process.env.CHROME_BIN ?? "system Chrome", rows,
      note: "reactUi=0 path is exercised only as html.is-wand-app + ?reactUi=0 query; this harness always mounts the React shell.",
    }, null, 2));
  } catch (error) {
    writeFileSync(join(evidenceDir, "result.json"), JSON.stringify({ passed: false, rows, errors, error: String(error) }, null, 2));
    throw error;
  } finally {
    socket?.close(); if (chrome.exitCode === null) { const exit = once(chrome, "exit"); chrome.kill(); await exit; }
    server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}
