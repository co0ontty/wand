import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import express from "express";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";

/** Real Chrome + production Shell/composer + SQLite/routes/runner, explicit execution doubles only. */
test("conversation browser matrix retains roots/drafts and creates real empty/single-employee groups", {
  skip: process.env.WAND_CONVERSATIONS_BROWSER !== "1", timeout: 300_000,
}, t => runConversationBrowser(t, false));

test("@ coordinator browser matrix keeps composer ownership and starts the selected member only", {
  skip: process.env.WAND_CONVERSATIONS_BROWSER !== "1", timeout: 300_000,
}, t => runConversationBrowser(t, true));

async function runConversationBrowser(t: TestContext, mentions: boolean): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-conversation-browser-"));
  const evidenceRoot = process.env.WAND_CONVERSATION_EVIDENCE_DIR || join(root, ".wand-team/run_5cc8a794a8ba/implementation-evidence/browser");
  const evidenceDir = mentions ? join(evidenceRoot, "mentions") : evidenceRoot; mkdirSync(evidenceDir, { recursive: true });
  const h = conversationHarness(t);
  const defaultPeer = h.storage.getSiliconEmployee("e_test_1")!;
  h.storage.saveSiliconEmployee({ ...defaultPeer, id: "e_wand_default", name: "默认伙伴（测试替身）" });
  // Presentation fixtures are isolated stored history, not messages sent to any model.
  await h.service.prepare("dm_e_wand_default", "visual-prepare-default");
  const visualGroup = await h.service.createGroup("visual-create-group", { employeeIds: ["e_test_1", "e_test_2"], name: "设计协作群（测试）" });
  // 归档核对用群：既解散又任务已归档，用来核对它不会和未归档的排成一样。
  const archivedGroup = await h.service.createGroup("visual-archive-group", { employeeIds: ["e_test_1"], name: "归档核对群（测试）" });
  h.service.updateListState(archivedGroup.conversationId, { dissolved: true });
  for (const conversationId of ["dm_e_wand_default", visualGroup.conversationId]) {
    const createdAt = new Date().toISOString();
    h.storage.appendConversationEvent(conversationId, { role: "user", createdAt, messageId: `visual-user-${conversationId}`,
      content: [{ type: "text", text: "请核对这轮界面调整，保留原有草稿与发送行为。" }] });
    h.storage.appendConversationEvent(conversationId, { role: "assistant", createdAt, messageId: `visual-peer-${conversationId}`,
      author: { id: "e_test_1", name: "员工 1" }, content: [{ type: "text", text: "标题与消息正文应有清晰层级。\n" + "这是一段用于验证长文原位展开与窄屏阅读的测试资料。".repeat(32) }] });
    h.storage.appendConversationEvent(conversationId, { role: "assistant", createdAt, messageId: `visual-file-${conversationId}`,
      author: { id: "e_test_2", name: "员工 2" }, reportFile: { stepId: "visual-step", path: "/tmp/visual-fixture/report.md", name: "界面核对报告.md", size: 128, preview: { title: "界面核对报告", excerpt: "隔离测试文件卡；非真实交付，不下载。" } },
      content: [{ type: "text", text: "文件卡测试" }] });
    // 消息正文的 Markdown 固定样本：长正文（展开态）/ 短发言 / 自己的短发言。
    h.storage.appendConversationEvent(conversationId, { role: "assistant", createdAt, messageId: `visual-markdown-${conversationId}`,
      author: { id: "e_test_1", name: "员工 1" },
      content: [{ type: "text", text: "## 本轮核对\n\n**标题与消息正文应有清晰层级。**\n\n- 长文原位展开\n- 窄屏阅读\n\n```ts\nconst checked = 1;\n```\n\n- **@员工 1** 负责本轮\n" }] });
    h.storage.appendConversationEvent(conversationId, { role: "assistant", createdAt, messageId: `visual-markdown-short-${conversationId}`,
      author: { id: "e_test_1", name: "员工 1" }, content: [{ type: "text", text: "**已核对的短发言**" }] });
    h.storage.appendConversationEvent(conversationId, { role: "user", createdAt, messageId: `visual-markdown-own-${conversationId}`,
      content: [{ type: "text", text: "**不加粗**：自己写的原文保留" }] });
  }
  // 会话转录：IM 页现在用与会话详情同一套工具行（状态点 + 时钟 + 标签 + 等宽摘录）。
  const activityAt = new Date().toISOString();
  h.storage.appendConversationEvent("dm_e_wand_default", { role: "assistant", createdAt: activityAt,
    messageId: "visual-activity-dm", author: { id: "e_test_1", name: "员工 1", sessionId: "visual-activity-session" },
    content: [
      { type: "thinking", thinking: "先核对页面结构，再决定改哪一层。", occurredAt: activityAt },
      { type: "tool_use", id: "visual-read", name: "Read", input: { file_path: "src/main.ts" }, preview: "src/main.ts",
        activity: { kind: "read_file", label: "查看 src/main.ts", occurredAt: activityAt } },
      { type: "tool_result", tool_use_id: "visual-read", content: "const checked = 1;", preview: "已读取 12 行" },
    ] });
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { EmployeeProfileHost } from "./src/web-ui/react/agents/employee-profile";
    import { OverlayHost } from "./src/web-ui/react/overlay-host";
    import { ShellSidebar } from "./src/web-ui/react/shell/shell-sidebar";
    import { ShellMainContent } from "./src/web-ui/react/shell/shell-main-content";
    import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
    import { UiStoreProvider } from "./src/web-ui/react/shell/ui-store-react";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { PortalContainerProvider } from "./src/web-ui/react/ui";
    import { ComposerStore } from "./src/web-ui/browser/composer";
    import { configureTeamChatComposerRuntime } from "./src/web-ui/react/ai-teams/composer-bridge";
    import { taskBoardController } from "./src/web-ui/react/issues/task-board-controller";
    import { conversationUi } from "./src/web-ui/react/conversations/state";
    import { notifyAiTeamStepLive } from "./src/web-ui/react/ai-teams/repository";
    import { notifyConversationSessionPreview } from "./src/web-ui/react/conversations/session-preview";
    import "./src/web-ui/react/ai-teams/chunk-entry";
    installReactUiStyles();
    const composer = new ComposerStore({ storage: () => localStorage, isUnloading: () => false, disposeAttachment: () => {} });
    configureTeamChatComposerRuntime({ read: id => composer.read(id), edit: (id,c) => composer.edit(id,c),
      discardScope: prefix => composer.discardScope(prefix), subscribe: f => composer.subscribe(f), submit: (id,text,deliver) => composer.submit(id,text,deliver), transfer: (a,b,r) => composer.transfer(a,b,r) });
    let snapshot = { auth: { phase: "authenticated" }, viewport: { mobile: innerWidth < 640, online: true, embedTerminal: false, nativeInput: false },
      capabilities: { backToNative: false, switchServer: false }, selected: null,
      layout: { sessionsDrawerOpen: innerWidth >= 640, sidebarPinned: true, sidebarCollapsed: false, sidebarDrawer: innerWidth < 640,
        sidebarAnchored: innerWidth >= 640, sessionsBackdropVisible: false, filePanelOpen: false, filePanelBackdropVisible: false, topbarMoreOpen: false, currentView: "chat" },
      sidebar: { interactiveCount: 0, totalCount: 0, manageMode: false, selectedCount: 0, groups: [] },
      topbar: { title: "Wand", description: "", statusLabel: "", statusTone: "", cwd: "", currentTask: "", titleGenerating: false, git: null },
      legacyVisibility: { terminal: false, chat: false, blank: true, composer: false } };
    const store = new MemoryUiAdapter(snapshot, { batchMs: 0 });
    store.dispatch = action => {
      if (action.type === "session.select") globalThis.conversationFixture.openedSession = action.id;
      if (action.type === "layout.drawer.toggle" || action.type === "layout.drawer.close") {
        const open = action.type === "layout.drawer.toggle" && !snapshot.layout.sessionsDrawerOpen;
        snapshot = { ...snapshot, layout: { ...snapshot.layout, sessionsDrawerOpen: open, sessionsBackdropVisible: open && snapshot.layout.sidebarDrawer } };
        store.setSnapshot(snapshot);
      }
    };
    globalThis.conversationFixture = { composer, conversationUi, taskBoardController, store, live: notifyAiTeamStepLive, sessionLive: notifyConversationSessionPreview, roots: null,
      // 模拟“已经有选中的 PTY 会话且当前是终端视图”：页面层盖住主区时的遗留槽位可见性靠它回归。
      setLegacyTerminal(active) { snapshot = { ...snapshot, legacyVisibility: { ...snapshot.legacyVisibility, terminal: !!active } }; store.setSnapshot(snapshot); } };
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}>
      <WandUiProvider><UiStoreProvider store={store}><div style={{height:"100dvh",display:"flex",minHeight:0}}><ShellSidebar/><ShellMainContent/><EmployeeProfileHost mobile={innerWidth < 640}/></div><OverlayHost portalContainer={document.getElementById("portals")}/></UiStoreProvider></WandUiProvider>
    </PortalContainerProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
    outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const app = express(); app.use(express.json()); registerConversationRoutes(app, h.service);
  app.get("/api/silicon-employees", (_req, res) => res.json({ employees: h.storage.listSiliconEmployees({ includeArchived: true }) }));
  let rejectProfileSave = false;
  app.get("/api/silicon-employees/:id", (req, res) => { const employee = h.storage.getSiliconEmployee(req.params.id); if (!employee) res.status(404).json({ error: "员工不存在" }); else res.json(employee); });
  app.put("/api/silicon-employees/:id", (req, res) => {
    if (rejectProfileSave) { rejectProfileSave = false; res.status(400).json({ error: "明确保存失败，输入保留" }); return; }
    const employee = h.storage.getSiliconEmployee(req.params.id)!;
    const next = { ...employee, ...req.body }; h.storage.saveSiliconEmployee(next); res.json(next);
  });
  app.get("/api/sessions/:id", (req, res) => { const session = h.sessions.get(req.params.id); if (session) res.json(session); else res.status(404).json({ error: "会话不存在" }); });
  app.get("/api/ai-teams", (_req, res) => res.json(h.storage.listAiTeams()));
  app.get("/api/workspaces", (_req, res) => res.json(h.storage.listWorkspaces()));
  app.get("/api/tasks", (_req, res) => res.json([]));
  app.get("/api/ai-team-runs", (_req, res) => res.json([]));
  app.get("/api/ai-team-runs/:id", (req, res) => {
    try { res.json(h.runner.detail(req.params.id)); } catch { res.status(404).json({ error: "运行不存在" }); }
  });
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
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const rows: unknown[] = [], errors: string[] = []; let socket: WebSocket | null = null;
  try {
    for (let n = 0; n < 120 && !existsSync(join(temp, "profile/DevToolsActivePort")); n++) await pause(50);
    const port = readFileSync(join(temp, "profile/DevToolsActivePort"), "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(tabs.find(t => t.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0; const pending = new Map<number, (value: any) => void>();
    socket.addEventListener("message", event => { const m = JSON.parse(String(event.data));
      if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params));
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params })); }).then((m: any) => { if (m.error) throw new Error(JSON.stringify(m.error)); return m.result; });
    const evaluate = async (expression: string): Promise<any> => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const wait = async (expression: string): Promise<void> => { for (let n = 0; n < 120; n++) { if (await evaluate(expression)) return; await pause(40); } throw new Error(`Timeout: ${expression}; ${await evaluate("document.body.innerText.slice(-600)")}; errors=${errors.slice(0, 2)}`); };
    const visibleSelector = (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(n=>n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && n.getBoundingClientRect().width>1 && n.getBoundingClientRect().height>1 && !n.closest('[inert],[hidden]'))`;
    const click = async (selector: string): Promise<void> => {
      let point: { x: number; y: number; hit: boolean } | null = null;
      let previous: typeof point = null;
      for (let attempt = 0; attempt < 120 && !point?.hit; attempt++) {
        await pause(40);
        const candidate: typeof point = await evaluate(`(()=>{const n=${visibleSelector(selector)};if(!n)return null;n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const h=document.elementFromPoint(x,y);return {x,y,hit:h===n||n.contains(h)}})()`);
        // A scaled panel can be hittable while its option is still moving between pointerdown/up.
        point = candidate ? { ...candidate, hit: candidate.hit && !!previous && Math.abs(candidate.x - previous.x) < .5 && Math.abs(candidate.y - previous.y) < .5 } : null;
        previous = candidate;
      }
      if (!point?.hit) { const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidenceDir, "blocked-click.png"), Buffer.from(shot.data, "base64"));
        writeFileSync(join(evidenceDir, "blocked-geometry.json"), JSON.stringify(await evaluate("({active:document.activeElement?.outerHTML.slice(0,500),scrollY,nodes:Array.from(document.querySelectorAll('.ant-drawer-body,.wand-ui-select-trigger,.wand-ui-select-content')).map(n=>({class:n.className,rect:n.getBoundingClientRect().toJSON(),scroll:n.scrollTop}))})"), null, 2)); }
      assert.ok(point?.hit, `actual click target visible: ${selector}; point=${JSON.stringify(point)}`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    };
    const key = async (name: string): Promise<void> => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: name === "Escape" ? 27 : name === "Enter" ? 13 : 0 }); };
    const rect = (selector: string) => evaluate(`(()=>{const n=${visibleSelector(selector)};if(!n)return null;const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    /** 归档的任务在列表里必须与未归档的不同：顶部三档筛选 + 归档行自带标记，且两档真的互斥。 */
    const checkArchivedTier = async (): Promise<void> => {
      const archivedRow = `.conversation-row[data-conversation-id=${JSON.stringify(archivedGroup.conversationId)}]`;
      const liveRow = `.conversation-row[data-conversation-id=${JSON.stringify(visualGroup.conversationId)}]`;
      await wait("!!document.querySelector('.conversation-list-filter .ant-segmented-item')");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.conversation-list-filter .ant-segmented-item')).map(n=>n.textContent.trim()).join('/')"), "全部/未归档/已归档", "list filter exposes the archive tiers like the sidebar filter");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(archivedRow)})?.dataset.archived`), "true", "archived conversation row is flagged");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(archivedRow + ' .conversation-archived-tag')})?.textContent`), "已归档", "archived row carries the visible tag");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(liveRow)})?.dataset.archived ?? 'none'`), "none", "unarchived conversation row stays unflagged");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(liveRow + ' .conversation-archived-tag')}) ? 'tagged' : 'plain'`), "plain", "unarchived row shows no archive tag");
      assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(archivedRow + ' .conversation-row-title')})).color !== getComputedStyle(document.querySelector(${JSON.stringify(liveRow + ' .conversation-row-title')})).color`), true, "archived rows read one step quieter than unarchived ones");
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidenceDir, "archive-tier-all.png"), Buffer.from(shot.data, "base64"));
      await click('.conversation-list-filter .ant-segmented-item:has([data-stretch-value="archived"])');
      await wait(`!!document.querySelector(${JSON.stringify(archivedRow)}) && document.querySelectorAll('.conversation-row').length === 1`);
      await click('.conversation-list-filter .ant-segmented-item:has([data-stretch-value="active"])');
      await wait(`!document.querySelector(${JSON.stringify(archivedRow)}) && !!document.querySelector(${JSON.stringify(liveRow)})`);
      await click('.conversation-list-filter .ant-segmented-item:has([data-stretch-value="all"])');
      await wait(`!!document.querySelector(${JSON.stringify(archivedRow)}) && !!document.querySelector(${JSON.stringify(liveRow)})`);
    };
    /**
     * 消息正文的 Markdown（与 Android `document -> MarkdownText` 同口径）：
     * 展开态/短发言走共享 Markdown 预览器、@ 仍在 token 里，收起预览仍是两端同一份纯文本原文。
     */
    const checkMessageMarkdown = async (): Promise<void> => {
      const longRow = `[data-presentation-id=${JSON.stringify(`visual-markdown-${visualGroup.conversationId}`)}]`;
      const shortRow = `[data-presentation-id=${JSON.stringify(`visual-markdown-short-${visualGroup.conversationId}`)}]`;
      const ownRow = `[data-presentation-id=${JSON.stringify(`visual-markdown-own-${visualGroup.conversationId}`)}]`;
      await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await pause(200);
      assert.equal(await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(`${longRow} .team-chat-preview`)});return !!n && n.textContent.includes('**标题与消息正文应有清晰层级。**')})()`), true,
        "collapsed preview stays the plain-text projection both ends share");
      assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(`${shortRow} .wand-markdown-preview-inline strong`)})`), true,
        "short peer message renders Markdown right away");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(ownRow)}).textContent.includes('**不加粗**')`), true,
        "own short message keeps the literal text the user wrote");
      // 展开后才长成正文：先把收起态点开（触发点在行内，位置不因展开改变）。
      await click(`${longRow} .team-chat-expand`);
      await wait(`(()=>{const n=document.querySelector(${JSON.stringify(`${longRow} .team-chat-body-text-text`)});return !!n && n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !!n.querySelector('.wand-markdown-preview-inline')})()`);
      const rendered = await evaluate(`(()=>{const md=document.querySelector(${JSON.stringify(`${longRow} .team-chat-body-text-text .wand-markdown-preview-inline`)});
        return { headings:md.querySelectorAll('h1,h2,h3,h4,h5,h6').length, strong:md.querySelectorAll('strong').length, items:md.querySelectorAll('li').length,
          code:md.querySelectorAll('pre code').length, literal:/[*#]/.test(md.textContent) || md.textContent.includes(String.fromCharCode(96)), mention:md.querySelectorAll('.team-chat-mention').length,
          mentionInsideBold:md.querySelector('strong .team-chat-mention')!==null,
          cardWidth:Math.round(md.getBoundingClientRect().width), rowWidth:Math.round(document.querySelector(${JSON.stringify(longRow)}).getBoundingClientRect().width),
          padding:getComputedStyle(md).paddingLeft, background:getComputedStyle(md).backgroundColor }})()`);
      assert.equal(rendered.literal, false, "markdown syntax is rendered, never printed as source");
      assert.ok(rendered.headings >= 1 && rendered.strong >= 1 && rendered.items >= 2 && rendered.code >= 1, `report content renders as a document: ${JSON.stringify(rendered)}`);
      assert.equal(rendered.mentionInsideBold, true, "@ member names stay highlighted inside rendered Markdown");
      assert.equal(rendered.padding, "0px", "the inline variant drops the paper padding of the file preview");
      assert.equal(rendered.background, "rgba(0, 0, 0, 0)", "the inline variant has no paper background");
      assert.ok(rendered.cardWidth <= rendered.rowWidth, `markdown body stays inside its row: ${JSON.stringify(rendered)}`);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true, "markdown body adds no horizontal overflow");
      const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidenceDir, "message-markdown.png"), Buffer.from(shot.data, "base64"));
      rows.push({ mode: "message-markdown", ...rendered });
    };
    /**
     * 页面层盖住主区时，遗留槽位（#output / #chat-output / 输入区）不能只是被盖住：
     * 它内部的浮层 z-index（终端缩放 11、拖拽把手 12、未读气泡 20、排队气泡 40）高于页面层，
     * 必须整体不参与绘制，且槽位自身保留布局（终端实例不重建、几何不塌）。
     */
    const checkPageLayerSuppression = async (): Promise<void> => {
      await evaluate("conversationFixture.setLegacyTerminal(true)");
      await wait("getComputedStyle(document.getElementById('output')).display === 'flex'");
      const suppressed = await evaluate(`(()=>{const host=document.getElementById('output');
        const probe=document.createElement('div');probe.className='terminal-scale-overlay';probe.style.cssText='position:absolute;top:8px;right:24px;z-index:11;width:120px;height:24px';
        host.appendChild(probe);const cs=getComputedStyle(probe);const rect=probe.getBoundingClientRect();
        const out={ mainClass:document.querySelector('main.main-content').className.replace(/css-[^ ]*/g,'').trim(),
          pageLayer:document.querySelectorAll('.main-content-page-layer').length,
          hostDisplay:getComputedStyle(host).display, hostVisibility:getComputedStyle(host).visibility,
          probeVisibility:cs.visibility, probeHitTested:document.elementFromPoint(rect.x+10,rect.y+10)===probe,
          chatVisibility:getComputedStyle(document.getElementById('chat-output')).visibility };
        probe.remove();return out})()`);
      assert.equal(suppressed.pageLayer, 1, "the conversation page marks itself as the page layer");
      assert.match(suppressed.mainClass, /main-content-conversation/, "the page layer class rides with the conversation view");
      assert.equal(suppressed.hostDisplay, "flex", "the singleton terminal slot keeps its layout (no terminal rebuild)");
      assert.equal(suppressed.hostVisibility, "hidden", "the slot is hidden instead of only covered");
      assert.equal(suppressed.chatVisibility, "hidden", "the chat slot is hidden with it");
      assert.equal(suppressed.probeVisibility, "hidden", "a legacy overlay inside the slot cannot paint over the conversation page");
      assert.equal(suppressed.probeHitTested, false, "a legacy overlay inside the slot cannot be hit either");
      await evaluate("conversationFixture.setLegacyTerminal(false)");
      assert.equal(await evaluate("getComputedStyle(document.getElementById('output')).visibility"), "hidden", "closing the legacy terminal does not uncover it over the chat");
      await evaluate("conversationFixture.conversationUi.suspend()");
      await wait("getComputedStyle(document.getElementById('output')).visibility === 'visible'");
      await evaluate("conversationFixture.conversationUi.show()");
      rows.push({ mode: "page-layer-suppression", ...suppressed });
    };
    await send("Page.enable"); await send("Runtime.enable");
    if (!mentions && process.env.WAND_PROFILES_ONLY !== "1") {
    for (const mode of ["desktop-light", "mobile-dark", "desktop-reduced", "mobile-native-rollback"]) {
      const mobile = mode.startsWith("mobile"), reduced = mode.includes("reduced") || mode.includes("native"), native = mode.includes("native");
      await send("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode.includes("dark") ? "dark" : "light" }, { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `${origin}/?mode=${mode}${native ? "&native=1&reactUi=0" : ""}` });
      await wait("!!document.querySelector('.conversation-sender textarea')");
      await wait("document.querySelector('.conversation-heading')?.textContent.includes('默认伙伴')");
      const started = h.sent.length + h.executions.length;
      await evaluate("globalThis.conversationFixture.roots = { output:document.getElementById('output'),chat:document.getElementById('chat-output'),input:document.querySelector('.conversation-sender textarea') }; true");
      await click(".conversation-sender textarea"); await send("Input.insertText", { text: "中文草稿保留" });
      const before = await rect(".conversation-submit");
      await click('[aria-label="更多聊天操作"]');
      assert.deepEqual(await rect(".conversation-submit"), before, "plus panel does not move submit");
      await key("Escape");
      if (mobile) await click('[aria-label="打开列表"]');
      await click('[data-stretch-value="tasks"]');
      await click('[data-stretch-value="chats"]');
      await click('[aria-label="对话操作"]');
      await wait("document.querySelector('#conversation-create-panel')?.getAttribute('data-open')==='true'");
      await click('#conversation-create-panel button');
      await wait("Array.from(document.querySelectorAll('[aria-label=\"选择员工\"]')).some(n=>n.getClientRects().length)");
      await click('#conversation-create-panel .ant-select input');
      await send("Input.insertText", { text: "员工 2" });
      await wait("Array.from(document.querySelectorAll('.ant-select-item-option')).some(n=>n.textContent.includes('员工 2'))");
      await click('.ant-select-item-option');
      assert.equal(await evaluate("document.querySelector('#conversation-create-panel').getAttribute('data-open')"), "true", "owned Portal option keeps editor open");
      await key("Escape");
      assert.equal(await evaluate("document.querySelector('#conversation-create-panel').getAttribute('data-open')"), "true", "first Escape closes only child Select");
      const tasksBefore = h.storage.listWandTasks().length, runsBefore = h.storage.listAiTeamRuns().length;
      await click('#conversation-create-panel .conversation-form-submit');
      await wait("globalThis.conversationFixture.conversationUi.getSnapshot().selectedId.startsWith('group_')");
      assert.equal(h.storage.listWandTasks().length, tasksBefore, "creating an empty group creates no tasks");
      assert.equal(h.storage.listAiTeamRuns().length, runsBefore); assert.equal(h.sent.length + h.executions.length, started, "opening/creating never starts a model");
      await evaluate("globalThis.conversationFixture.conversationUi.select('dm_e_wand_default')");
      await wait("document.querySelector('.conversation-sender textarea')?.value === '中文草稿保留'");
      assert.equal(await evaluate("conversationFixture.roots.input === document.querySelector('.conversation-sender textarea') && conversationFixture.roots.output === document.getElementById('output') && conversationFixture.roots.chat === document.getElementById('chat-output')"), true, "stable composer and legacy roots survive all switches");
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true, "no horizontal overflow");
      const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidenceDir, `${mode}.png`), Buffer.from(shot.data, "base64"));
      rows.push({ mode, before, after: await rect('.conversation-submit'), emptyGroup: true, stableRoots: true, portal: true, modelCalls: 0 });
      await evaluate("conversationFixture.composer.edit('conversation-draft:' + location.origin + ':local-owner:dm_e_wand_default:talk',{text:''})");
    }
    // Ordinary DM input creates a session directly: no task form, relay, group or task.
    await click('.conversation-sender textarea'); await send("Input.insertText", { text: "浏览器消息甲" });
    const taskCount = h.storage.listWandTasks().length, groupCount = h.storage.listConversations().filter(item => item.kind === "group").length;
    const submitBefore = await rect('.conversation-submit');
    await click('[aria-label="发送消息"]');
    await wait("!!document.querySelector('.conversation-session-reply')");
    await wait("document.querySelector('.conversation-submit')?.getAttribute('aria-label') === '发送消息'");
    assert.equal(await evaluate("conversationFixture.conversationUi.getSnapshot().selectedId"), "dm_e_wand_default");
    const cardTurn = h.service.detail("dm_e_wand_default").messages.find(turn => turn.sessionLink)!;
    const sessionId = cardTurn.sessionLink!.sessionId;
    const cardSelector = `.conversation-session-reply[data-session-id="${sessionId}"]`;
    await evaluate(`document.querySelector(${JSON.stringify(cardSelector)}).scrollIntoView({block:'nearest'})`);
    const cardBefore = await rect(cardSelector);
    const liveText = "仅测试替身进展\n".repeat(120) + "可核对的最新片段";
    const update = (text: string) => ({ conversationId: "dm_e_wand_default", sessionId, preview: { status: "running", text } });
    await evaluate(`conversationFixture.sessionLive(${JSON.stringify(update(liveText))})`);
    await wait(`document.querySelector(${JSON.stringify(cardSelector)})?.textContent.includes('可核对的最新片段')`);
    // 回复气泡装的是这条会话的转录：内容变长会撑高气泡（上限封顶），但列宽与左边距不变，
    // 读者也不会被流式内容顶走（下面单独验阅读位置）。
    const cardAfter = await rect(cardSelector);
    assert.equal(cardAfter.width, cardBefore.width, "the reply column keeps its width while the transcript grows");
    assert.equal(cardAfter.x, cardBefore.x, "the reply column keeps its place");
    assert.ok(cardAfter.height >= cardBefore.height, "a longer transcript grows the reply");
    assert.ok(cardAfter.height - cardBefore.height <= 600, "the transcript viewport stays bounded");
    assert.deepEqual(await rect('.conversation-submit'), submitBefore, "acceptance and streaming preserve submit geometry");
    const scrollSelector = cardSelector + ' [aria-label="会话实时回复"]';
    // 转录用内容自适应 + 上限封顶，不再是固定 232px 的小窗口。
    const transcriptShape = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(scrollSelector)});const cs=getComputedStyle(b);return {height:cs.height,maxHeight:cs.maxHeight,overflowY:cs.overflowY}})()`);
    assert.match(transcriptShape.maxHeight, /\d+px/, "the transcript viewport is capped, not fixed");
    assert.equal(transcriptShape.overflowY, "auto", "a transcript taller than the cap scrolls inside the bubble");
    assert.equal(await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(scrollSelector)});return b.scrollHeight>b.clientHeight && b.scrollHeight-b.clientHeight-b.scrollTop<2})()`), true);
    await evaluate(`document.querySelector(${JSON.stringify(scrollSelector)}).scrollTop=0`); await pause(100);
    await evaluate(`conversationFixture.sessionLive(${JSON.stringify(update(liveText + "新增不抢阅读"))})`);
    await wait(`document.querySelector(${JSON.stringify(cardSelector)})?.textContent.includes('新增不抢阅读')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scrollSelector)}).scrollTop`), 0, "reading position wins over new stream data");
    // IM 会话转录：展开摘要后是共享的行骨架，不再有自己的 Ant Collapse 外壳。
    const activitySection = '.conversation-turn-activity';
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(activitySection)})`), true, "the IM page renders the turn transcript");
    const collapsedActivity = await evaluate(`(()=>{const block=document.querySelector(${JSON.stringify(activitySection)});
      const summary=block.querySelector('.chat-process-summary');
      return {expanded:summary?.getAttribute('aria-expanded'),rows:block.querySelectorAll('.chat-call-inline').length,legacyCollapse:!!block.querySelector('.ant-collapse')}})()`);
    assert.equal(collapsedActivity.expanded, "false", "the transcript summary starts collapsed while the turn is idle");
    assert.equal(collapsedActivity.legacyCollapse, false, "the IM transcript drops its own collapse chrome");
    assert.equal(collapsedActivity.rows, 0, "collapsed rows stay unrendered");
    await click(`${activitySection} .chat-process-summary`);
    await pause(150);
    const activityRows = await evaluate(`(()=>{const block=document.querySelector(${JSON.stringify(activitySection)});
      const rows=[...block.querySelectorAll('.chat-call-inline')];
      const tool=rows.find(row=>row.dataset.toolId);
      const thinking=rows.find(row=>row.dataset.thinkingEntry==="true");
      const mark=tool?.querySelector('.chat-call-mark');
      return {rows:rows.length,summary:block.querySelector('.chat-process-summary')?.innerText||'',
        expanded:block.querySelector('.chat-process-summary')?.getAttribute('aria-expanded'),
        markColor:mark?getComputedStyle(mark).backgroundColor:'', label:tool?.querySelector('.chat-call-label')?.innerText||'',
        clock:tool?.querySelector('.chat-call-time')?.innerText||'', input:tool?.querySelector('.chat-call-preview')?.innerText||'',
        result:tool?.querySelector('.chat-call-result')?.innerText||'', thinkingLabel:thinking?.querySelector('.chat-call-label')?.innerText||''}})()`);
    assert.equal(activityRows.expanded, "true");
    assert.equal(activityRows.rows, 2, "thinking and tool rows share one row skeleton");
    assert.match(activityRows.summary, /条记录/);
    assert.equal(activityRows.thinkingLabel, "思考过程");
    assert.match(activityRows.label, /查看 src\/main\.ts/);
    assert.match(activityRows.clock, /^\d{2}:\d{2}:\d{2}$/);
    assert.equal(activityRows.input, "src/main.ts");
    assert.equal(activityRows.result, "已读取 12 行");
    assert.notEqual(activityRows.markColor, "rgba(0, 0, 0, 0)", "each row carries a status mark");
    await click(`${activitySection} .chat-call-inline[data-tool-id=visual-read] .chat-call-button`);
    await pause(150);
    const activityDetail = await evaluate(`(()=>{const row=document.querySelector('.chat-call-inline[data-tool-id=visual-read]');
      const body=row.querySelector('.chat-disclosure-body'); return {open:row.dataset.expanded, height:Math.round(body.getBoundingClientRect().height),
        headings:[...row.querySelectorAll('.chat-activity-detail-section h4')].map(node=>node.innerText), text:body.innerText}})()`);
    assert.equal(activityDetail.open, "true");
    assert.ok(activityDetail.height > 0, "expanding a row reveals its detail in place");
    assert.deepEqual(activityDetail.headings, ["调用输入", "结果"]);
    // 结果正文按需从会话取（这里会话不在测试替身里，取到的是空详情），行内摘录已经给过结果。
    assert.match(activityDetail.text, /file_path/);
    const activityShot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidenceDir, "im-transcript-rows.png"), Buffer.from(activityShot.data, "base64"));
    rows.push({ mode: "im-transcript", sharedRowSkeleton: true, statusMarks: true, monospaceExcerpts: true, inlineDetail: true, noLegacyCollapse: true });
    const executing = h.sessions.get(sessionId)!;
    h.sessions.set(sessionId, { ...executing, messages: [{ role: "assistant", content: [{ type: "text", text: "轮询恢复的新进展" }] }] });
    await wait(`document.querySelector(${JSON.stringify(cardSelector)})?.textContent.includes('轮询恢复的新进展')`);
    const cardRestored = await rect(cardSelector);
    assert.equal(cardRestored.width, cardBefore.width, "a polled transcript keeps the same column");
    assert.equal(cardRestored.x, cardBefore.x);
    assert.equal(h.storage.listWandTasks().length, taskCount); assert.equal(h.storage.listConversations().filter(item => item.kind === "group").length, groupCount);
    await click(cardSelector + " button");
    await wait(`conversationFixture.openedSession===${JSON.stringify(sessionId)}`);
    await evaluate("conversationFixture.conversationUi.select('dm_e_wand_default')");
    await wait("document.querySelector('.conversation-heading-context')?.textContent.includes('私聊')");
    await click('.conversation-sender textarea'); await send("Input.insertText", { text: "浏览器消息乙" });
    await click('[aria-label="发送消息"]');
    await wait("document.querySelectorAll('.conversation-session-reply').length === 2");
    const cards = h.service.detail("dm_e_wand_default").messages.filter(turn => turn.sessionLink);
    assert.notEqual(cards[0]?.sessionLink?.sessionId, cards[1]?.sessionLink?.sessionId);
    assert.equal(h.storage.listWandTasks().length, taskCount);
    const previewShot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidenceDir, "dm-independent-sessions.png"), Buffer.from(previewShot.data, "base64"));
    rows.push({ mode: "dm-sessions", stayInPrivateChat: true, independentSessions: true, noTasksOrGroups: true, inlineSessionTranscript: true, exactSessionNavigation: true });
    // Explicit group task history stays separate and keeps its existing reply/navigation semantics.
    const dispatchedId = await h.group();
    const dispatched = await h.dispatch(dispatchedId, "浏览器群任务");
    await evaluate(`conversationFixture.conversationUi.openTask(${JSON.stringify(dispatchedId)}, ${JSON.stringify(dispatched.taskId)}, ${JSON.stringify(dispatched.runId)})`);
    await wait("document.querySelector('.conversation-task-context')?.textContent.includes('浏览器群任务')");
    const targetBeforeHistory = await evaluate("conversationFixture.conversationUi.getSnapshot().targets[conversationFixture.conversationUi.getSnapshot().selectedId]");
    await click('.conversation-task-index button');
    await wait("!!document.querySelector('.conversation-task-drawer .ant-collapse-header')");
    await click('.conversation-task-drawer .ant-collapse-header');
    await click('.conversation-task-detail button');
    assert.deepEqual(await evaluate("conversationFixture.conversationUi.getSnapshot().targets[conversationFixture.conversationUi.getSnapshot().selectedId]"), targetBeforeHistory);
    rows.push({ mode: "explicit-group", exactTaskNavigation: true });
    const executionsBeforeAlias = h.sent.length + h.executions.length;
    await evaluate(`conversationFixture.taskBoardController.open("", "", "teamchat", ${JSON.stringify(dispatched.runId)})`);
    await wait(`!document.querySelector('.wand-team-chat-page') && conversationFixture.conversationUi.getSnapshot().selectedId===${JSON.stringify(dispatchedId)}`);
    assert.equal(await evaluate(`conversationFixture.conversationUi.getSnapshot().filters[${JSON.stringify(dispatchedId)}]`), dispatched.taskId);
    assert.equal(h.sent.length + h.executions.length, executionsBeforeAlias, "run aliases only navigate; never replay execution");
    rows.push({ mode: "legacy-run-alias", canonicalConversation: true, exactTask: true, noExecution: true });

    }
    if (mentions) for (const mode of ["desktop", "mobile", "reduced", "native-rollback"]) {
      const mobile = mode === "mobile" || mode === "native-rollback";
      await send("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced" ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `${origin}/?mode=mentions-${mode}${mode === "native-rollback" ? "&native=1&reactUi=0" : ""}` });
      await wait("!!document.querySelector('.conversation-sender textarea')");
      const created = await h.service.createGroup(`mention-browser-${mode}`, { employeeIds: ["e_test_1", "e_test_2", "e_test_3"] });
      await evaluate(`conversationFixture.conversationUi.select(${JSON.stringify(created.conversationId)})`);
      await wait("document.querySelector('.conversation-receiver')?.textContent.includes('群内沟通')");
      const originalInput = await evaluate("conversationFixture.roots = { input: document.querySelector('.conversation-sender textarea') }; true");
      assert.equal(originalInput, true);
      await click('.conversation-heading > button');
      await wait("document.querySelector('#conversation-members-panel')?.getAttribute('data-open')==='true'");
      await click('[aria-label="@员工 2 负责本轮"]');
      await wait("document.querySelector('.conversation-sender textarea')?.value === '@员工 2 '");
      assert.equal(await evaluate("document.activeElement === conversationFixture.roots.input"), true, "@ selection focuses the original input");
      assert.equal(await evaluate("document.querySelector('#conversation-members-panel')?.getAttribute('data-open')"), "false");
      await send("Input.insertText", { text: `浏览器协作-${mode}` });
      await wait("document.querySelector('.conversation-receiver')?.textContent.includes('@员工 2 · 本轮负责人')");
      const before = await rect('.conversation-submit');
      const executionsBefore = h.executions.length;
      await click('[aria-label="发送消息"]');
      await wait(`!!conversationFixture.conversationUi.getSnapshot().targets[${JSON.stringify(created.conversationId)}]?.runId`);
      await h.runner.idle();
      const actual = h.service.detail(created.conversationId);
      const run = actual.runDetails[0]!.run;
      assert.equal(run.team.members.find(m => m.isLeader)?.employeeId, "e_test_2");
      assert.equal(actual.team?.members.find(m => m.isLeader)?.employeeId, "e_test_1", "permanent leader is unchanged");
      assert.equal(actual.tasks.length, 1); assert.equal(h.executions.length, executionsBefore + 1);
      assert.equal(h.executions.at(-1)?.employee?.id, "e_test_2");
      assert.equal(actual.communicationSessionId, null);
      assert.equal(await evaluate("conversationFixture.roots.input === document.querySelector('.conversation-sender textarea')"), true);
      assert.deepEqual(await rect('.conversation-submit'), before, "@ acceptance preserves submit geometry");
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
      const screenshot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidenceDir, `mention-${mode}.png`), Buffer.from(screenshot.data, "base64"));
      rows.push({ mode: `mention-${mode}`, originalInput: true, coordinator: "e_test_2", tasks: 1, execution: "explicit test double" });
      await h.runner.stop(run.id);
    }
    if (!mentions && process.env.WAND_PROFILES_ONLY !== "1") for (const mode of ["desktop-light", "mobile-dark", "desktop-reduced", "mobile-native-rollback"]) {
      const mobile = mode.startsWith("mobile");
      await send("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode.includes("dark") ? "dark" : "light" }, { name: "prefers-reduced-motion", value: mode.includes("reduced") || mode.includes("native") ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `${origin}/?mode=visual-${mode}${mode.includes("native") ? "&native=1&reactUi=0" : ""}` });
      await wait("!!document.querySelector('.conversation-sender textarea')");
      for (const [kind, id] of [["dm", "dm_e_wand_default"], ["group", visualGroup.conversationId]]) {
        await evaluate(`conversationFixture.conversationUi.select(${JSON.stringify(id)})`);
        await wait(`document.querySelector('.conversation-heading-context')?.textContent.includes(${JSON.stringify(kind === "dm" ? "私聊" : "群聊 · 我 + 2 位员工")})`);
        await wait("document.querySelector('.team-chat-file-card')?.textContent.includes('界面核对报告')");
        assert.equal(await evaluate("Array.from(document.querySelectorAll('.conversation-root .team-chat-avatar')).every(n=>Math.abs(n.getBoundingClientRect().width-32)<1)"), true, "all sender avatars retain their 32px identity on narrow screens");
        await evaluate("document.querySelector('.conversation-message-scroll').scrollTop = 0");
        await pause(250);
        const compactScreenshot = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(evidenceDir, `visual-${kind}-${mode}.png`), Buffer.from(compactScreenshot.data, "base64"));
        const before = await rect('.conversation-submit');
        await click('.conversation-root .team-chat-expand');
        assert.deepEqual(await rect('.conversation-submit'), before, "long text expands in the scroll region, not the composer frame");
        assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
        assert.equal(await evaluate("document.querySelector('.conversation-feedback').hidden"), true, "empty feedback does not reserve a blank row");
        if (!mobile) {
          await wait("!!document.querySelector('.conversation-row time')");
          assert.equal(await evaluate("Array.from(document.querySelectorAll('.conversation-row time')).every(n => Number.isFinite(Date.parse(n.dateTime)))"), true, "list times come from real stored history");
          await checkArchivedTier();
        }
        await evaluate("document.querySelector('.conversation-message-scroll').scrollTop = 0");
        await pause(200);
        const screenshot = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(evidenceDir, `visual-${kind}-${mode}-expanded.png`), Buffer.from(screenshot.data, "base64"));
        const surfaceColor = await evaluate("getComputedStyle(document.querySelector('.conversation-root')).backgroundColor");
        rows.push({ mode: `visual-${kind}-${mode}`, storedFixtureOnly: true, longText: true, fileCard: true, headerIdentity: true, fixedFeedback: true, overflow: false, surfaceColor,
          themeNote: "Current production WandUiProvider uses a fixed light palette; dark is a system preference test, not dark-theme acceptance." });
      }
    }
    if (!mentions && process.env.WAND_PROFILES_ONLY !== "1") {
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      await evaluate(`conversationFixture.conversationUi.select(${JSON.stringify(visualGroup.conversationId)})`);
      await wait("document.querySelector('.conversation-heading-context')?.textContent.includes('群聊')");
      await pause(400);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.conversation-stream')).filter(n=>n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length"), 1, "retiring projection is not a duplicate visible history");
      await evaluate(`globalThis.imArrivals=[]; new MutationObserver(() => document.querySelectorAll('[data-im-arriving]').forEach(n=>{if(!imArrivals.includes(n.dataset.presentationId))imArrivals.push(n.dataset.presentationId)})).observe(document.querySelector('.conversation-message-scroll'),{subtree:true,attributes:true,attributeFilter:['data-im-arriving'],childList:true})`);
      for (let n = 0; n < 20; n++) h.storage.appendConversationEvent(visualGroup.conversationId, {
        role: "assistant", createdAt: new Date().toISOString(), messageId: `im-history-${n}`,
        author: { id: "e_test_1", name: "员工 1" }, content: [{ type: "text", text: `分组消息 ${n}：用于核对新消息抵达与阅读历史时的滚动行为。` }],
      });
      await wait("!!document.querySelector('[data-presentation-id=im-history-19]')");
      await pause(400);
      assert.equal(await evaluate("document.querySelector('[data-presentation-id=im-history-19]').dataset.joined"), "true");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-presentation-id=im-history-18] .conversation-peer-avatar')).visibility"), "hidden");
      await evaluate("document.querySelector('.conversation-message-scroll').scrollTop=0"); await pause(100);
      const top = await evaluate("document.querySelector('.conversation-message-scroll').scrollTop");
      h.storage.appendConversationEvent(visualGroup.conversationId, { role: "assistant", createdAt: new Date().toISOString(), messageId: "im-incoming",
        author: { id: "e_test_1", name: "员工 1" }, content: [{ type: "text", text: "新收到的一条消息" }] });
      await wait("!!document.querySelector('.conversation-new-messages')");
      assert.equal(await evaluate("document.querySelector('.conversation-message-scroll').scrollTop"), top, "incoming messages must not pull a history reader to the bottom");
      assert.equal(await evaluate("(()=>{const b=document.querySelector('.conversation-new-messages button').getBoundingClientRect(),s=document.querySelector('.conversation-message-scroll').getBoundingClientRect();return b.top>=s.top&&b.bottom<=s.bottom})()"), true, "new-message shortcut is visible without scrolling to find it");
      await click('.conversation-new-messages button');
      await wait("!document.querySelector('.conversation-new-messages')");
      await evaluate("imArrivals=[]");
      h.storage.appendConversationEvent(visualGroup.conversationId, { role: "user", createdAt: new Date().toISOString(), messageId: "im-outgoing",
        content: [{ type: "text", text: "服务端接受的发送记录" }] });
      await wait("imArrivals.includes('im-outgoing')");
      await pause(400);
      assert.equal(await evaluate("document.querySelector('[data-presentation-id=im-outgoing] [aria-label=已发送到服务端]') !== null"), true);
      assert.equal(await evaluate("(()=>{const s=document.querySelector('.conversation-message-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<3})()"), true);
      const arrivals = await evaluate("JSON.stringify(imArrivals)"); await pause(3300);
      assert.equal(await evaluate("JSON.stringify(imArrivals)"), arrivals, "polling does not replay arrivals");
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await pause(100); await evaluate("imArrivals=[]");
      h.storage.appendConversationEvent(visualGroup.conversationId, { role: "assistant", createdAt: new Date().toISOString(), messageId: "im-reduced",
        author: { id: "e_test_2", name: "员工 2" }, content: [{ type: "text", text: "减少动态效果时直接显示" }] });
      await wait("!!document.querySelector('[data-presentation-id=im-reduced]')");
      assert.equal(await evaluate("imArrivals.length"), 0, "reduced motion suppresses entrance effects");
      await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 780, deviceScaleFactor: 1, mobile: false });
      await pause(200);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidenceDir, "im-arrivals-320.png"), Buffer.from(shot.data,"base64"));
      rows.push({ mode: "im-arrivals", grouping: true, initialAndPollingSuppressed: true, preservesHistoryScroll: true, jumpToNew: true, outgoingCheck: "server-accepted-only", reducedMotion: true, width320: true });
      await checkMessageMarkdown();
      /**
       * 会话恢复与消息行身份：切走再切回必须回到尾部（真实缺陷：换会话时把清空后的 0 写回存档），
       * 名字在气泡外、头像挂在一次连续发言的首条上，输入操作行与正文同属一张输入面板。
       */
      const streamShape = () => evaluate(`(()=>{const s=document.querySelector('.conversation-message-scroll');
        const r=s.getBoundingClientRect(); const last=s.lastElementChild.getBoundingClientRect();
        const lead=document.querySelector('.conversation-message[data-side=start][data-lead=true]');
        const joined=document.querySelector('.conversation-message[data-side=start][data-joined=true][data-lead=false]');
        const author=lead?.querySelector('.conversation-message-author'); const bubble=lead?.querySelector('.ant-bubble-content');
        return { tailGap:Math.round(s.scrollHeight-s.scrollTop-s.clientHeight), scrollable:s.scrollHeight>s.clientHeight+1,
          contentBottomGap:Math.round(r.bottom-parseFloat(getComputedStyle(s).paddingBottom)-last.bottom),
          authorOutsideBubble:!!author&&!!bubble&&!bubble.contains(author)&&author.getBoundingClientRect().bottom<=bubble.getBoundingClientRect().top,
          leadAvatarOnAuthor:!!author&&Math.abs(lead.querySelector('.conversation-peer-avatar').getBoundingClientRect().top-author.getBoundingClientRect().top)<=1,
          leadAvatarVisible:!!lead&&getComputedStyle(lead.querySelector('.conversation-peer-avatar')).visibility==='visible',
          joinedKeepsAvatarSlot:!!joined&&Math.round(joined.querySelector('.conversation-peer-avatar').getBoundingClientRect().width)===32,
          selfAvatarSlots:document.querySelectorAll('.conversation-message[data-side=end] .conversation-peer-avatar').length,
          actionRowInsideSurface:!!document.querySelector('.conversation-sender .ant-sender-footer .conversation-action-row')};})()`);
      await evaluate(`conversationFixture.conversationUi.select(${JSON.stringify(visualGroup.conversationId)})`);
      await pause(500);
      const groupShape = await streamShape();
      assert.equal(groupShape.selfAvatarSlots, 0, "自己的发言不再挂头像：右对齐气泡已经表达了身份");
      assert.equal(groupShape.actionRowInsideSurface, true, "输入操作行属于发送器自己的面板，不再另起一条工具栏");
      assert.equal(groupShape.authorOutsideBubble, true, "发言人名字在气泡外、气泡正上方");
      assert.equal(groupShape.leadAvatarOnAuthor, true, "头像与发言人名字顶部对齐");
      assert.equal(groupShape.leadAvatarVisible, true, "一次连续发言的首条带头像");
      assert.equal(groupShape.joinedKeepsAvatarSlot, true, "后续各条保留头像占位，气泡仍对齐在同一列");
      await evaluate("document.querySelector('.conversation-message-scroll').scrollTop=document.querySelector('.conversation-message-scroll').scrollHeight");
      await pause(200);
      await evaluate(`conversationFixture.conversationUi.select('dm_e_wand_default')`);
      await wait("document.querySelector('.conversation-heading-context')?.textContent.includes('私聊')");
      await pause(300);
      await evaluate(`conversationFixture.conversationUi.select(${JSON.stringify(visualGroup.conversationId)})`);
      await wait("document.querySelector('.conversation-heading-context')?.textContent.includes('群聊')");
      await pause(600);
      assert.equal((await streamShape()).tailGap, 0, "回到会话时落在尾部，不停在上面（换会话不许把清空后的位置写回存档）");
      // 内容比视口短时必须贴底：聊天记录从底部往上长，不在顶部留一片空场。
      await evaluate(`conversationFixture.conversationUi.select('dm_e_test_1')`);
      await wait("document.querySelector('.conversation-heading-title')?.textContent==='员工 1' && !!document.querySelector('.conversation-stream')");
      await pause(400);
      assert.equal(await evaluate("document.querySelector('.conversation-stream').innerText.trim()"), "", "empty conversations do not invent transcript messages");
      assert.equal(await evaluate("document.querySelector('.conversation-empty')?.getAttribute('role')"), "status", "empty guidance is a separate status, never a chat message renderer");
      assert.equal(await evaluate("document.querySelector('.conversation-sender textarea').placeholder"), "输入消息…");
      const emptyShape = await streamShape();
      assert.equal(emptyShape.scrollable, false, "空会话用来核对短内容贴底");
      assert.ok(Math.abs(emptyShape.contentBottomGap) <= 1, `短内容贴着输入区上沿：${JSON.stringify(emptyShape)}`);
      rows.push({ mode: "im-restore-and-identity", tailRestored: true, shortContentBottomAligned: true, authorOutsideBubble: true, noSelfAvatar: true, singleComposerSurface: true });
      await checkPageLayerSuppression();
    }
    if (!mentions) for (const width of [1280, 390]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: `${origin}/?profile=${width}` });
      await wait("!!document.querySelector('.conversation-sender textarea')");
      await evaluate("conversationFixture.conversationUi.select('dm_e_test_1')");
      await wait("document.querySelector('.conversation-heading-title')?.textContent==='员工 1'");
      await click('.conversation-sender textarea'); await send("Input.insertText", { text: "资料操作保留的草稿" });
      const preservedDraft = await evaluate("document.querySelector('.conversation-sender textarea').value");
      await click('.conversation-heading .conversation-avatar-button');
      await wait("document.querySelector('.object-profile-name')?.textContent==='员工 1'");
      const textClick = async (text: string, selector = 'button,[role=menuitem]') => {
        await wait(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(n=>n.textContent.replace(/\\s/g,'').replace(/…$/,'')===${JSON.stringify(text.replace(/\s/g, ""))}&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`);
        await evaluate(`Array.from(document.querySelectorAll('[data-test-click]')).forEach(n=>n.removeAttribute('data-test-click')); Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(n=>n.textContent.replace(/\\s/g,'').replace(/…$/,'')===${JSON.stringify(text.replace(/\s/g, ""))}&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))?.setAttribute('data-test-click','yes')`);
        await click('[data-test-click=yes]');
      };
      await textClick("编辑", '.wand-object-profile-drawer button');
      await wait("!!document.querySelector('#employee-e_test_1-duty')");
      await click('#employee-e_test_1-duty'); await send("Input.insertText", { text: "新的职责" });
      const duty = await evaluate("document.querySelector('#employee-e_test_1-duty').value");
      rejectProfileSave = true; await textClick("保存修改", '.wand-object-profile-drawer button');
      await wait("document.querySelector('.wand-object-profile-drawer')?.textContent.includes('明确保存失败')");
      assert.equal(await evaluate("document.querySelector('#employee-e_test_1-duty').value"), duty);
      // A real portalled candidate selector belongs to the editor and cannot close the drawer.
      await click('.wand-object-profile-drawer .wand-ui-select-trigger[aria-label$="模型"]');
      await wait("!!document.querySelector('.wand-ui-select-content:not(.ant-dropdown-hidden)')");
      const selectionGeometry = () => evaluate("({active:document.activeElement?.getAttribute('aria-label'),body:Array.from(document.querySelectorAll('.wand-object-profile-drawer .ant-drawer-body')).map(n=>n.scrollTop),popup:document.querySelector('.wand-ui-select-content:not(.ant-dropdown-hidden)')?.getBoundingClientRect().toJSON()})");
      const selectBefore = await selectionGeometry();
      await click('.wand-ui-select-content:not(.ant-dropdown-hidden) input[type=search]');
      writeFileSync(join(evidenceDir, `select-geometry-${width}.json`), JSON.stringify({before:selectBefore,after:await selectionGeometry()}, null, 2));
      assert.equal(await evaluate("!!document.querySelector('#employee-e_test_1-duty')"), true);
      await click('.wand-ui-select-content:not(.ant-dropdown-hidden) [role=option]');
      assert.equal(await evaluate("!!document.querySelector('#employee-e_test_1-duty')"), true);
      await key("Escape"); // close any remaining child popup first
      if (await evaluate("!!document.querySelector('.wand-object-profile-drawer [role=alert]') && document.querySelector('.wand-object-profile-drawer').textContent.includes('放弃尚未保存')")) await textClick("继续编辑");
      await textClick(await evaluate("Array.from(document.querySelectorAll('.wand-object-profile-drawer button')).some(n=>n.textContent.trim()==='保存修改')") ? "保存修改" : "保存失败", '.wand-object-profile-drawer button');
      await wait("!!document.querySelector('.object-profile-name')");
      assert.equal(h.storage.getSiliconEmployee("e_test_1")!.duty, duty);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      const profileShot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidenceDir, `profile-${width}.png`), Buffer.from(profileShot.data, "base64"));
      await click('[aria-label="关闭资料面板"]'); await pause(400);
      assert.equal(await evaluate("document.querySelector('.conversation-sender textarea').value"), preservedDraft);
      await click('.conversation-heading .conversation-avatar-button');
      await wait("!!document.querySelector('.wand-object-profile-drawer.ant-drawer-open')");
      if (width === 1280) await click('.conversation-sender textarea');
      else await key("Escape");
      await wait("!document.querySelector('.wand-object-profile-drawer.ant-drawer-open')");
      await pause(400);
      if (width === 390) await click('[aria-label="打开列表"]');
      const lifecycle = await h.service.createGroup(randomUUID(), { employeeIds: ["e_test_1"], name: `菜单验收群-${width}` });
      await evaluate("window.dispatchEvent(new Event('focus'))"); await pause(6200);
      const rowSelector = `[data-conversation-id="${lifecycle.conversationId}"]`;
      await wait(`!!document.querySelector(${JSON.stringify(rowSelector)})`);
      const more = async () => {
        const bounds = await rect(rowSelector); assert.ok(bounds);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bounds.x + bounds.width/2, y: bounds.y + bounds.height/2 });
        await pause(200); await click(`${rowSelector} .conversation-row-more`);
      };
      const box = await rect(rowSelector); assert.ok(box);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x + box.width/2, y: box.y+box.height/2, button: "right", clickCount: 1 });
      await textClick("置顶", '[role=menuitem]');
      await wait(`document.querySelector(${JSON.stringify(rowSelector)})?.getAttribute('data-pinned')==='true'`);
      await more(); await textClick("解散群聊", '[role=menuitem]');
      await textClick("解散群聊", '.ant-modal button');
      await wait(`document.querySelector(${JSON.stringify(rowSelector)})?.textContent.includes('已解散')`);
      await click(`${rowSelector} .conversation-row-open`);
      await wait("document.querySelector('.conversation-dissolved')?.textContent.includes('我解散了群聊')");
      assert.equal(await evaluate("document.querySelector('.conversation-composer').hidden"), true);
      await click('.conversation-restore-link'); await wait("!document.querySelector('.conversation-dissolved')");
      if (width === 390) await click('[aria-label="打开列表"]');
      await more(); await textClick("删除群聊", '[role=menuitem]');
      await textClick("取消", '.ant-modal button'); assert.ok(h.storage.getConversation(lifecycle.conversationId));
      await more(); await textClick("删除群聊", '[role=menuitem]');
      await textClick("删除对话", '.ant-modal button');
      await wait(`!document.querySelector(${JSON.stringify(rowSelector)})`); assert.equal(h.storage.getConversation(lifecycle.conversationId), null);
      rows.push({ mode: `profile-menu-${width}`, profileSaveAndFailure: true, ownedPopup: true, draftPreserved: true, contextPinDissolveRestoreDelete: true });
    }
    assert.deepEqual(errors, []);
    writeFileSync(join(evidenceDir, "result.json"), JSON.stringify({ passed: true, scope: "Real browser and source UI + isolated SQLite/API; execution doubles only; not installed-service acceptance", rows, errors }, null, 2));
  } catch (error) {
    writeFileSync(join(evidenceDir, "result.json"), JSON.stringify({ passed: false, rows, errors, error: String(error) }, null, 2)); throw error;
  } finally {
    socket?.close(); if (chrome.exitCode === null) { const exit = once(chrome, "exit"); chrome.kill(); await exit; }
    server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}
