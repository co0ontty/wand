import { cssEvidenceCapture } from "./helpers/antd-css-evidence.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

/**
 * Real-Chrome gate for the viewer lane. It mounts the production hosts (file
 * explorer, code editor, file preview, local preview, image viewer, restart
 * overlay) against a stub HTTP surface and drives genuine library interactions:
 * Ant Segmented filters, WandInput search/create, MenuItem context actions,
 * Dropdown-free nested surfaces and Modal focus/scroll ownership.
 */
test("viewer hosts run on Ant Design in real Chrome", { timeout: 300_000, skip: process.env.WAND_VIEWERS_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-antd-viewers-"));
  const artifact = join(root, "output/style-ant-next/viewers");
  const restartOnly = process.env.WAND_VIEWERS_RESTART_ONLY === "1";
  const explorerOnly = process.env.WAND_VIEWERS_EXPLORER_ONLY === "1";
  const evidenceName = explorerOnly ? "explorer-browser.json" : restartOnly ? "restart-browser.json" : "viewers-browser.json";
  const browserErrors: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { isReactUiEnabled } from "./src/web-ui/react/feature-flags";
    import { PortalContainerProvider, WandDialog } from "./src/web-ui/react/ui";
    import { overlayStore, wandOverlay } from "./src/web-ui/react/overlay-controller";
    import { FileExplorerHost } from "./src/web-ui/react/file-explorer/host";
    import { fileExplorerController, fileExplorerStore } from "./src/web-ui/react/file-explorer/controller";
    import { CodeEditorHost } from "./src/web-ui/react/code-editor/host";
    import { codeEditorController, codeEditorStore } from "./src/web-ui/react/code-editor/controller";
    import { FilePreviewHost } from "./src/web-ui/react/file-preview/host";
    import { filePreviewController, filePreviewStore } from "./src/web-ui/react/file-preview/controller";
    import { LocalPreviewHost } from "./src/web-ui/react/local-preview/host";
    import { localPreviewController } from "./src/web-ui/react/local-preview/controller";
    import { ImageViewerHost } from "./src/web-ui/react/image-viewer/host";
    import { imageViewerController } from "./src/web-ui/react/image-viewer/controller";
    import { RestartOverlayHost } from "./src/web-ui/react/restart-overlay/host";
    import { createRestartOverlayController } from "./src/web-ui/react/restart-overlay/controller";

    installReactUiStyles();
    const portal = document.getElementById("wand-react-ui-portals");

    // Deterministic clock: only the deadline timer is fired, so the overlay is
    // driven into its real timed-out state without waiting for 180 probes.
    const timers = [];
    let timerId = 0;
    const manualClock = {
      setInterval(callback, delayMs) { timers.push({ id: ++timerId, delayMs, callback }); return timerId; },
      clearInterval(handle) { const at = timers.findIndex(entry => entry.id === handle); if (at >= 0) timers.splice(at, 1); },
      setTimeout(callback, delayMs) { timers.push({ id: ++timerId, delayMs, callback }); return timerId; },
      clearTimeout(handle) { const at = timers.findIndex(entry => entry.id === handle); if (at >= 0) timers.splice(at, 1); },
    };
    const restartController = createRestartOverlayController({
      repository: { loadConfig: () => new Promise(() => {}) },
      clock: manualClock,
      reloadPage: () => { window.viewers.reloadCalls += 1; },
    });

    function FixtureDialogs() {
      const snapshot = React.useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot, overlayStore.getSnapshot);
      const dialog = snapshot.activeDialog;
      return dialog ? <WandDialog key={dialog.id} open {...dialog.options}
        onAction={(action, inputValue) => { window.viewers.dialogActions.push(action); overlayStore.completeDialog(dialog.id, { dismissed: false, action, inputValue }); }}
        onDismiss={() => overlayStore.completeDialog(dialog.id, { dismissed: true })}/> : null;
    }
    function mount(id, node) {
      createRoot(document.getElementById(id)).render(
        <PortalContainerProvider container={portal}><WandUiProvider>{node}</WandUiProvider></PortalContainerProvider>,
      );
    }

    window.viewers = { reloadCalls: 0, generic: isReactUiEnabled(), lastKeys: [], dialogActions: [], fixtureDialogResults: [], fixtureDialogRequests: 0 };
    window.addEventListener("keydown", event => { window.viewers.lastKeys.push({ key: event.key, composing: event.isComposing, target: event.target?.getAttribute("aria-label") ?? event.target?.className }); window.viewers.lastKeys = window.viewers.lastKeys.slice(-12); }, true);
    window.viewers.fireDeadline = () => {
      const at = timers.reduce((best, entry, index) => entry.delayMs >= (timers[best]?.delayMs ?? -1) ? index : best, 0);
      const entry = timers.splice(at, 1)[0];
      if (entry) void entry.callback();
      return Boolean(entry);
    };
    window.viewers.closeFixtureDialog = () => {
      const dialog = overlayStore.getSnapshot().activeDialog;
      if (dialog) overlayStore.completeDialog(dialog.id, { dismissed: true });
    };
    window.viewers.explorer = fileExplorerController;
    window.viewers.explorerSnapshot = fileExplorerStore.getSnapshot;
    window.viewers.openEditor = path => codeEditorController.open(path);
    window.viewers.editorSnapshot = codeEditorStore.getSnapshot;
    window.viewers.editor = codeEditorController;
    window.viewers.openPreview = request => filePreviewController.open(request);
    window.viewers.previewSnapshot = filePreviewStore.getSnapshot;
    window.viewers.openLocalPreview = value => localPreviewController.show(value);
    window.viewers.openImage = (src, label) => imageViewerController.open(src, label);
    window.viewers.showRestart = () => restartController.showRestart("previous-instance", "9.9.9");
    window.viewers.hideRestart = () => restartController.dispose();
    window.viewers.openFixtureDialog = () => {
      window.viewers.fixtureDialogRequests += 1;
      void wandOverlay.dialog({ title: "重启优先级验收", description: "服务重启期间，普通弹窗不能遮挡手动刷新。",
        actions: [{ label: "保留弹窗", value: false, autoFocus: true }, { label: "普通确认", value: true, kind: "primary" }],
      }).then(result => window.viewers.fixtureDialogResults.push(result));
    };

    mount("fixture-controls", <button id="fixture-generic-launch" onClick={() => window.viewers.openFixtureDialog()}>打开普通弹窗</button>);
    mount("explorer-panel", <FileExplorerHost root="/app"/>);
    mount("editor-panel", <div className="editor-frame"><CodeEditorHost/></div>);
    mount("overlay-panel", <><FilePreviewHost/><LocalPreviewHost/><ImageViewerHost/><RestartOverlayHost controller={restartController}/><FixtureDialogs/></>);
    window.viewers.ready = true;
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temporary, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });

  const tree = {
    "/app": [
      { path: "/app/src", name: "src", type: "dir", mtime: "2026-01-02T03:04:05.000Z" },
      { path: "/app/readme.md", name: "readme.md", type: "file", size: 128, mtime: "2026-01-02T03:04:05.000Z" },
      { path: "/app/a.ts", name: "a.ts", type: "file", size: 26, mtime: "2026-01-02T03:04:05.000Z", gitStatus: { unstaged: "modified" } },
    ],
    "/app/src": [{ path: "/app/src/index.ts", name: "index.ts", type: "file", size: 18, mtime: "2026-01-02T03:04:05.000Z" }],
  };
  const markdown = [
    "# 顶层标题",
    "",
    "[本地页](/docs/index.html) [外链](https://example.com) [危险](javascript:alert(1))",
    "",
    "<script>window.__xss = 1</script>",
  ].join("\n");

  let failNextWrite = false;
  let holdNextWrite = false;
  let resumeWrite: (() => void) | null = null;
  const failLoads = new Set<string>();
  const writtenFiles = new Map<string, string>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/fixture/reset") { failNextWrite = false; holdNextWrite = false; resumeWrite?.(); resumeWrite = null; failLoads.clear(); writtenFiles.clear(); return json({ ok: true }); }
    if (url.pathname === "/fixture/fail-next-save") { failNextWrite = true; return json({ ok: true }); }
    if (url.pathname === "/fixture/hold-next-save") { holdNextWrite = true; return json({ ok: true }); }
    if (url.pathname === "/fixture/release-save") { resumeWrite?.(); resumeWrite = null; return json({ ok: true }); }
    if (url.pathname === "/fixture/fail-next-load") { failLoads.add(url.searchParams.get("path") ?? ""); return json({ ok: true }); }
    if (url.pathname === "/api/file-write") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (failNextWrite) { failNextWrite = false; return json({ error: "测试保存失败，请重试" }, 503); }
      if (holdNextWrite) {
        holdNextWrite = false;
        await new Promise<void>((resolve) => { resumeWrite = resolve; });
      }
      writtenFiles.set(body.path, body.content);
      return json({ path: body.path, size: Buffer.byteLength(body.content), mtime: "fixture-saved" });
    }
    if (url.pathname === "/api/file-raw" || url.pathname === "/img.png") {
      response.setHeader("Content-Type", "image/svg+xml");
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect x="120" y="100" width="900" height="560" rx="70" fill="#efa777"/><circle cx="600" cy="350" r="180" fill="#324456"/><text x="600" y="710" text-anchor="middle" font-size="42">Wand image fixture 1200 × 800</text></svg>'); return;
    }
    if (url.pathname === "/app.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(readFileSync(join(temporary, "app.js")));
      return;
    }
    if (url.pathname === "/styles.css" || url.pathname === "/tailwind.css") {
      response.setHeader("content-type", "text/css");
      response.end(readFileSync(join(root, `src/web-ui/content/${url.pathname === "/styles.css" ? "styles.css" : "tailwind.css"}`)));
      return;
    }
    if (url.pathname === "/api/directory") return json({ items: tree[url.searchParams.get("q") ?? ""] ?? [] });
    if (url.pathname === "/api/file-search") {
      const generated = url.searchParams.get("includeGenerated") === "true";
      return json({ truncated: generated, results: [
        { path: "/app/src/index.ts", name: "index.ts", type: "file", size: 18 },
        { path: "/app/src", name: "src", type: "dir" },
        ...(generated ? [{ path: "/app/node_modules/index.ts", name: "index.ts", type: "file" }] : []),
      ] });
    }
    if (url.pathname === "/api/file-preview") {
      const path = url.searchParams.get("path") ?? "";
      const name = path.split("/").pop() ?? "file";
      const isMarkdown = /\.md$/i.test(path);
      if (failLoads.delete(path)) return json({ error: "测试读取失败，请重试" }, 503);
      const content = writtenFiles.get(path) ?? (isMarkdown ? markdown : "const a = 1;");
      const kind = path.endsWith(".png") ? "image" : path.endsWith(".bin") ? "binary" : "text";
      return json({
        kind, path, name, size: content.length,
        mime: isMarkdown ? "text/markdown" : "text/typescript",
        lang: isMarkdown ? "markdown" : "typescript",
        content,
      });
    }
    if (url.pathname.startsWith("/api/local-preview/")) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>local preview</title>ok");
      return;
    }
    if (url.pathname.startsWith("/api/")) return json({ ok: true });
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css">
      <style>
        html, body { margin: 0; }
        body { max-width: 100vw; overflow-x: hidden; }
        #explorer-panel { height: 520px; width: min(320px, 100%); display: flex; }
        .editor-frame { position: relative; height: 420px; width: min(720px, 100%); }
        #overlay-panel { display: none; }
      </style></head><body>
      <div id="fixture-controls" style="position:fixed;bottom:0;left:0"></div>
      <div id="explorer-panel"></div>
      <div class="editor-frame" id="editor-panel"></div>
      <div id="overlay-panel"></div>
      <div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div>
      <script src="/app.js"></script></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temporary}/profile`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  try {
    const portFile = join(temporary, "profile/DevToolsActivePort");
    for (let attempt = 0; attempt < 120 && !existsSync(portFile); attempt++) await pause(50);
    assert.ok(existsSync(portFile), "Chrome debugging endpoint available");
    const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
    await once(socket, "open");
    let sequence = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params.exceptionDetails));
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve_, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: resolve_, reject });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const captureCss = cssEvidenceCapture("viewers");
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      await captureCss(send);
      return result.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await evaluate(expression)) return;
        await pause(30);
      }
      throw new Error(`Timed out: ${expression}; body=${await evaluate("document.body.innerText.slice(0,600)")}; keys=${JSON.stringify(await evaluate("window.viewers.lastKeys"))}; preview=${JSON.stringify(await evaluate("({editing:window.viewers.previewSnapshot().editing,saving:window.viewers.previewSnapshot().saving,dirty:window.viewers.previewSnapshot().dirty})"))}`);
    };
    /** Clicks the first match; `text` filters by visible label (library rows keep no value attr). */
    const settleMotion = async (): Promise<void> => {
      // rc-motion first mounts its prepare frame, then starts the CSS animation.
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await wait("[...document.querySelectorAll('.ant-modal')].every(node => getComputedStyle(node).opacity === '1' && node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).every(animation => animation.playState !== 'running'))");
    };
    const click = async (selector: string, text?: string): Promise<void> => {
      await settleMotion();
      const point = await evaluate(`(() => {
        const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const node = ${text === undefined ? "all[0]" : `all.find(candidate => candidate.textContent.replace(/\\s/g, "").includes(${JSON.stringify(text?.replace(/\s/g, ""))}))`};
        if (!node) throw new Error("missing target " + ${JSON.stringify(selector)} + ${JSON.stringify(text ?? "")} + " labels=" + all.map(node => node.textContent).join("|"));
        node.scrollIntoView({ block: "nearest", behavior: "instant" });
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) throw new Error("zero-size target " + ${JSON.stringify(selector)});
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      }
    };
    const rightClick = async (selector: string): Promise<void> => {
      const point = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error("missing target " + ${JSON.stringify(selector)});
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, ...point, button: "right", clickCount: 1 });
      }
    };
    const key = async (value: string, modifiers = 0): Promise<void> => {
      const code = ({ Escape: 27, Enter: 13, ArrowDown: 40, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Tab: 9, s: 83 } as Record<string, number>)[value] ?? 0;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code: value, windowsVirtualKeyCode: code, modifiers, ...(value === "Enter" ? { text: "\r" } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code: value, modifiers });
    };
    const type = async (text: string): Promise<void> => {
      await send("Input.insertText", { text });
    };
    const screenshot = async (name: string): Promise<void> => {
      await settleMotion();
      mkdirSync(artifact, { recursive: true });
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(artifact, `${name}.png`), Buffer.from(result.data, "base64"));
    };
    await send("Page.enable");
    await send("Runtime.enable");

    const modes = process.env.WAND_VIEWERS_TEST_MODES?.split(",") ?? ["desktop", "mobile", "native", "reduced-motion", "rollback"];
    for (const mode of modes) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "mobile" ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", { url: `${origin}/${mode === "rollback" ? "?reactUi=0" : ""}` });
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'");
      await send("Page.bringToFront");
      await wait("!!window.viewers?.ready");
      await evaluate("fetch('/fixture/reset')");
      if (mode === "native") await evaluate("document.documentElement.classList.add('is-wand-app','is-wand-ios')");
      assert.equal(await evaluate("window.viewers.generic"), mode !== "rollback", `${mode}: generic rollback flag`);

      // ---- file explorer ----
      await wait("document.querySelectorAll('.wand-explorer-row[role=treeitem]').length === 3");
      assert.equal(
        await evaluate("document.querySelectorAll('.wand-file-explorer-btn.ant-btn').length"),
        2,
        `${mode}: 新建入口是库按钮`,
      );
      assert.equal(await evaluate("!!document.querySelector('.wand-explorer-dots .ant-spin')"), false, `${mode}: 无搜索结果时不渲染 Spin`);

      {
        if (!restartOnly) {
        await click('[role=treeitem][aria-label="src"]');
        await wait("document.querySelectorAll('.wand-explorer-row[aria-label=\"index.ts\"]').length === 1");
        assert.equal(await evaluate("document.querySelector('[role=treeitem][aria-label=\"src\"]').getAttribute('aria-expanded')"), "true", "点击文件夹展开");

        // roving keyboard focus stays on the tree rows (clicking a file would hand
        // the caret to the editor, so the row is focused directly)
        await evaluate("document.querySelector('[role=treeitem][aria-label=\"index.ts\"]').focus()");
        await key("ArrowDown");
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-label') === 'readme.md'"), true, "方向键在树内走位");

        // right-click opens the shared context menu on the row that owns it
        await evaluate("document.querySelector('[role=treeitem][aria-label=\"a.ts\"]').focus()");
        await rightClick('[role=treeitem][aria-label="a.ts"]');
        await wait("!!document.querySelector('.wand-explorer-context-menu')");
        assert.equal(await evaluate("document.querySelector('#wand-react-ui-portals').contains(document.querySelector('.wand-explorer-context-menu'))"), true, "文件菜单通过共享 Portal 渲染");
        assert.equal(await evaluate("document.querySelectorAll('.wand-explorer-context-menu .wand-ui-menu-item.ant-btn').length >= 8"), true, `${mode}: 菜单行是库按钮`);
        assert.equal(await evaluate("!!document.querySelector('.wand-explorer-context-menu .wand-ui-menu-separator.ant-divider')"), true, "分隔线是库组件");
        await wait("document.activeElement.classList.contains('wand-ui-menu-item')");
        const firstItemText = await evaluate("document.activeElement.textContent");
        await key("ArrowDown");
        assert.equal(await evaluate("document.activeElement.classList.contains('wand-ui-menu-item')"), true, "方向键在菜单行间走位");
        assert.notEqual(await evaluate("document.activeElement.textContent"), firstItemText, "方向键真的移动了焦点");
        await key("End");
        assert.equal(await evaluate("document.activeElement.textContent.replaceAll(' ', '')"), "删除", "End 到达菜单末项");
        await key("Home");
        assert.equal(await evaluate("document.activeElement.textContent"), firstItemText, "Home 返回菜单首项");
        await key("Escape");
        await wait("!document.querySelector('.wand-explorer-context-menu')");
        await wait("document.activeElement.getAttribute('aria-label') === 'a.ts'");

        // inline create is a library input, and IME/Escape cancel keeps the tree intact
        await rightClick('[role=treeitem][aria-label="a.ts"]');
        await wait("!!document.querySelector('.wand-explorer-context-menu')");
        await click('.wand-explorer-context-menu .wand-ui-menu-item');
        await wait("!!document.querySelector('.wand-explorer-rename .wand-ui-input')");
        await wait("document.activeElement.classList.contains('ant-input')");
        await key("Escape");
        await wait("!document.querySelector('.wand-explorer-rename')");

        // search + Segmented filter + pointer focus hand-back
        await click('[aria-label="搜索文件"]');
        await type("index");
        await wait("!!document.querySelector('.wand-explorer-search-panel')");
        await wait("document.querySelectorAll('.wand-explorer-result[role=option]').length === 2");
        assert.equal(await evaluate("document.querySelector('.wand-explorer-search-scope input').checked"), false, "默认只搜索项目文件");
        await click('.wand-explorer-search-scope .ant-checkbox-wrapper');
        await wait("document.querySelectorAll('.wand-explorer-result[role=option]').length === 3");
        assert.equal(await evaluate("document.querySelector('.wand-explorer-search-limit').textContent.includes('继续查找')"), true, "截断反馈提供继续查找方式");
        await screenshot(`file-search-scope-${mode}`);
        await click('.wand-explorer-search-scope .ant-checkbox-wrapper');
        await wait("document.querySelectorAll('.wand-explorer-result[role=option]').length === 2");
        assert.equal(
          await evaluate("document.querySelector('.wand-explorer-search-filters').className.includes('ant-segmented')"),
          true,
          "结果筛选是 Ant Segmented",
        );
        assert.equal(await evaluate("document.querySelector('.wand-explorer-search-progress')?.classList.contains('ant-progress') ?? true"), true, "搜索进度是 Ant Progress");
        // rc-segmented keeps the option value in React state, so the row is
        // addressed by position inside the group (全部 / 文件 / 文件夹).
        await click('.wand-explorer-search-filters .ant-segmented-item', "文件夹");
        await wait("document.querySelectorAll('.wand-explorer-result[role=option]').length === 1");
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-label') === '搜索文件'"), true, "点筛选后焦点回到搜索框");
        await key("Escape");
        await wait("!document.querySelector('.wand-explorer-search-panel')");
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-label') === '搜索文件'"), true, "Esc 清空保留搜索焦点");
        assert.equal(await evaluate("document.querySelectorAll('.wand-explorer-row[role=treeitem]').length > 0"), true, "清空后恢复文件树");
        if (explorerOnly) {
          evidence.push({ mode, scope: "file explorer", generatedScope: true, truncatedFeedback: true, portalMenu: true, keyboardAndClear: true });
          await screenshot(`file-tree-${mode}`);
          console.log(`File explorer browser passed: ${mode}`);
          continue;
        }

        // ---- code editor ----
        assert.equal(await window_open("/app/a.ts"), true, "编辑器打开文件");
        await wait("!!document.querySelector('.wand-code-editor-toolbar')");
        assert.equal(await evaluate("document.querySelectorAll('.wand-code-editor-toolbar .ant-btn').length >= 6"), true, "工具栏全部是库按钮");
        assert.equal(await evaluate("document.querySelectorAll('.wand-code-editor-tab-close.ant-tabs-tab-remove').length > 0"), true, "标签关闭由 Ant Tabs 渲染");
        assert.equal(await evaluate("document.querySelector('.wand-code-editor-dirty-mark').classList.contains('ant-tag')"), true, "未保存标记是库 Tag");
        await click('[title="在文件中查找 (⌘F)"]');
        await wait("!!document.querySelector('.wand-code-editor-find .wand-ui-input')");
        await wait("document.activeElement.classList.contains('ant-input')");
        await type("1");
        await wait("document.querySelector('.wand-code-editor-find-count').textContent === '1/1'");
        assert.equal(await evaluate("document.querySelectorAll('.wand-code-editor-find .ant-btn').length >= 4"), true, "查找按钮是库按钮");
        await key("Escape");
        await wait("!document.querySelector('.wand-code-editor-find')");

        await click('.wand-code-editor-textarea');
        await send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
        const composingEditor = await evaluate("document.querySelector('.wand-code-editor-textarea').value");
        await key("Tab");
        assert.equal(await evaluate("document.querySelector('.wand-code-editor-textarea').value"), composingEditor, `${mode}: IME Tab does not insert spaces`);
        await send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
        await click('.wand-code-editor-textarea');
        await type("中文");
        await click('.wand-code-editor-textarea');
        await type(" // edited");
        const editorDraft = await evaluate("window.viewers.editorSnapshot().file.draft");
        await key("Escape");
        await wait("document.querySelectorAll('.wand-ui-dialog-actions .ant-btn').length === 2");
        await click('.wand-ui-dialog-actions .ant-btn', "继续编辑");
        await wait("!document.querySelector('.wand-ui-dialog-actions') && document.activeElement === document.querySelector('.wand-code-editor-textarea')");
        assert.equal(await evaluate("window.viewers.editorSnapshot().file.draft"), editorDraft);
        assert.equal(await evaluate("window.viewers.dialogActions.at(-1)"), false, `${mode}: editor cancel keeps caret and draft`);

        await evaluate("fetch('/fixture/fail-next-save')");
        await key("s", 2);
        await wait("!!document.querySelector('.wand-code-editor-inline-error.ant-alert')");
        assert.equal(await evaluate("window.viewers.editorSnapshot().file.draft"), editorDraft, `${mode}: failed editor save keeps draft`);
        assert.equal(await evaluate("window.viewers.editorSnapshot().file.dirty"), true);
        await click('.wand-code-editor-toolbar .ant-btn', "保存");
        await wait("!window.viewers.editorSnapshot().file.dirty && !document.querySelector('.wand-code-editor-inline-error')");
        await wait("document.activeElement === document.querySelector('.wand-code-editor-textarea')");
        await screenshot(`editor-${mode}`);

        // Markdown rendering through Marked: headings shift below the dialog/panel title
        await window_open("/app/readme.md");
        await wait("document.querySelector('.wand-code-editor-tab.active .wand-code-editor-tab-name')?.textContent === 'readme.md'");
        await click('.ant-tabs-tab-active [role=tab]');
        await key("Home");
        await wait("window.viewers.editorSnapshot().activePath === '/app/a.ts'");
        assert.equal(await evaluate("document.activeElement.getAttribute('role')"), "tab", `${mode}: arrow focus stays in Tabs`);
        await key("End");
        await wait("window.viewers.editorSnapshot().activePath === '/app/readme.md'");
        assert.equal(await evaluate("document.querySelectorAll('.wand-code-editor-tabs [role=tab][tabindex=\"0\"]').length"), 1, `${mode}: one tab stop`);
        assert.equal(await evaluate("[...document.querySelectorAll('.wand-code-editor-tabs [role=tab]')].every(node => node.getAttribute('aria-controls') === 'wand-code-editor-panel')"), true);
        // Markdown opens rendered; the toolbar toggle owns the switch back to source.
        await wait("!!document.querySelector('.wand-code-editor-markdown h2')");
        assert.equal(await evaluate("!document.querySelector('.wand-code-editor-markdown h1')"), true, "编辑器预览不产出 h1");
        assert.equal(await evaluate("!document.querySelector('.wand-code-editor-markdown script')"), true, "原始 HTML 只当文本");
        assert.equal(
          await evaluate("[...document.querySelectorAll('.wand-code-editor-markdown a')].some(node => (node.getAttribute('href')||'').startsWith('/api/local-file/'))"),
          true,
          "服务端 HTML 链接走本地预览代理",
        );
        await click('.wand-code-editor-toolbar .ant-btn[title="显示 Markdown 源码"]');
        await wait("!!document.querySelector('.wand-code-editor-textarea')");
        await click('.wand-code-editor-toolbar .ant-btn[title="渲染 Markdown 预览"]');
        await wait("!!document.querySelector('.wand-code-editor-markdown h2')");

        // ---- file preview ----
        await window_open("/app/readme.md", "preview");
        await wait("!!document.querySelector('[data-testid=file-preview-dialog]')");
        assert.equal(await evaluate("!!document.querySelector('[data-testid=file-preview-dialog] h2')"), true, "预览标题下移到 h2");
        assert.equal(await evaluate("!document.querySelector('[data-testid=file-preview-dialog] h1')"), true, "预览正文没有 h1");
        assert.equal(await evaluate("!document.querySelector('[data-testid=file-preview-dialog] script')"), true, "预览里原始 HTML 只是文本");
        assert.equal(
          await evaluate("document.querySelector('.wand-file-preview-download').tagName === 'A' && document.querySelector('.wand-file-preview-download').getAttribute('href').startsWith('/api/file-raw?download=1&path=')"),
          true,
          "下载链接仍是带 class 的锚点，由库按钮渲染",
        );
        assert.equal(await evaluate("document.querySelector('.wand-file-preview-download').classList.contains('ant-btn')"), true, "下载链接是库按钮外观");
        assert.equal(await evaluate("document.querySelectorAll('.wand-file-preview-toolbar .ant-btn').length >= 8"), true, "预览工具栏是库按钮");
        await screenshot(`file-preview-before-edit-${mode}`);
        await click('.wand-file-preview-toolbar .ant-btn', "编辑");
        await wait("document.activeElement?.tagName === 'TEXTAREA'");
        await send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
        const composingPreview = await evaluate("document.querySelector('.wand-file-preview-editor textarea').value");
        await key("Tab");
        assert.equal(await evaluate("document.querySelector('.wand-file-preview-editor textarea').value"), composingPreview, `${mode}: attachment IME Tab preserves composition`);
        await send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
        await click('.wand-file-preview-editor textarea');
        await type("中文");
        await click('.wand-file-preview-editor textarea');
        await type(" // attachment edited");
        const previewDraft = await evaluate("window.viewers.previewSnapshot().draft");
        await evaluate("fetch('/fixture/fail-next-save')");
        await key("s", 2);
        await wait("!!document.querySelector('.wand-file-preview-inline-error.ant-alert')");
        assert.equal(await evaluate("window.viewers.previewSnapshot().draft"), previewDraft, `${mode}: failed attachment save keeps draft`);
        assert.equal(await evaluate("window.viewers.previewSnapshot().editing && window.viewers.previewSnapshot().dirty"), true);
        await evaluate("fetch('/fixture/hold-next-save')");
        await click('.wand-file-preview-edit-actions .ant-btn', "保存");
        await wait("window.viewers.previewSnapshot().saving");
        await key("Escape");
        assert.equal(await evaluate("window.viewers.previewSnapshot().open && window.viewers.previewSnapshot().editing && window.viewers.previewSnapshot().saving"), true, `${mode}: Escape during save retains editing preview`);
        assert.equal(await evaluate("window.viewers.previewSnapshot().draft"), previewDraft, `${mode}: Escape during save retains draft`);
        assert.equal(await evaluate("document.querySelectorAll('.wand-ui-dialog-actions .ant-btn').length"), 0, `${mode}: saving does not open discard confirmation`);
        await evaluate("fetch('/fixture/release-save')");
        await wait("!window.viewers.previewSnapshot().dirty && !document.querySelector('.wand-file-preview-inline-error')");
        await screenshot(`file-preview-${mode}`);
        await click('.wand-file-preview-editor textarea');
        await type(" retained draft");
        await key("Escape");
        await wait("document.querySelectorAll('.wand-ui-dialog-actions .ant-btn').length === 2");
        await screenshot(`discard-confirm-${mode}`);
        await click('.wand-ui-dialog-actions .ant-btn', "继续编辑");
        await wait("!document.querySelector('.wand-ui-dialog-actions') && window.viewers.previewSnapshot().editing");
        assert.equal(await evaluate("window.viewers.dialogActions.at(-1)"), false, `${mode}: continue actually clicks its action`);
        await wait("document.activeElement === document.querySelector('.wand-file-preview-editor textarea')");
        assert.equal(await evaluate("window.viewers.previewSnapshot().draft.includes('retained draft')"), true);
        await click('.wand-file-preview-editor textarea');
        await key("Escape");
        await wait("document.querySelectorAll('.wand-ui-dialog-actions .ant-btn').length === 2");
        await click('.wand-ui-dialog-actions .ant-btn', "放弃修改");
        await wait("!window.viewers.previewSnapshot().editing && !document.querySelector('.wand-ui-dialog-actions')");
        assert.equal(await evaluate("window.viewers.dialogActions.at(-1)"), true, `${mode}: discard actually clicks its action`);
        await click('.wand-file-preview-toolbar .ant-btn', "编辑");
        await wait("document.activeElement?.tagName === 'TEXTAREA'");
        await key("Escape");
        await wait("!document.querySelector('.wand-file-preview-editor') && !!document.querySelector('[data-testid=file-preview-dialog]')");
        await key("Escape");
        await wait("!document.querySelector('[data-testid=file-preview-dialog]')");

        await evaluate("fetch('/fixture/fail-next-load?path=/app/retry.ts')");
        await window_open("/app/retry.ts", "preview");
        await wait("!!document.querySelector('.wand-file-preview-error')");
        await click('.wand-file-preview-error .ant-btn', "重新加载");
        await wait("window.viewers.previewSnapshot().status === 'ready'");
        await key("Escape");
        await wait("!document.querySelector('[data-testid=file-preview-dialog]')");
        await window_open("/app/image.png", "preview");
        await wait("!!document.querySelector('.wand-media-stage .ant-image')");
        await click('.wand-media-stage');
        await wait("window.viewers.previewSnapshot().imageZoomed");
        await key("Escape");
        await wait("!document.querySelector('[data-testid=file-preview-dialog]')");
        await window_open("/app/archive.bin", "preview");
        await wait("!!document.querySelector('.wand-file-preview-binary.ant-card')");
        await screenshot(`binary-preview-${mode}`);
        await key("Escape");
        await wait("!document.querySelector('[data-testid=file-preview-dialog]')");

        // ---- local preview ----
        await evaluate("window.viewers.openLocalPreview('3000')");
        await wait("!!document.querySelector('.wand-local-preview-modes.ant-segmented')");
        await wait("document.activeElement.classList.contains('ant-input')");
        await click('.wand-local-preview-modes .ant-segmented-item', "本地文件");
        await wait("document.querySelector('.wand-local-preview-field .ant-input').getAttribute('placeholder').includes('/path/to')");
        await click('.wand-local-preview-modes .ant-segmented-item', "Web 服务");
        await wait("document.querySelector('.wand-local-preview-field .ant-input').getAttribute('placeholder').includes('3000')");
        await click('.wand-local-preview-actions .ant-btn');
        await wait("!!document.querySelector('.wand-local-preview-frame')");
        assert.equal(await evaluate("document.querySelector('.wand-local-preview-frame').getAttribute('sandbox')"), "allow-scripts allow-forms allow-popups allow-modals", "iframe 沙箱不放宽");
        await screenshot(`local-preview-${mode}`);
        await key("Escape");
        await wait("!document.querySelector('.wand-local-preview-frame')");

        // ---- image viewer ----
        await evaluate("window.viewers.openImage('/img.png', '示例图')");
        await wait("!!document.querySelector('[data-testid=image-viewer-dialog] .wand-media-stage')");
        assert.equal(await evaluate("document.querySelector('[data-testid=image-viewer-dialog]').classList.contains('ant-modal') || !!document.querySelector('[data-testid=image-viewer-dialog]')"), true);
        await click('[data-testid=image-viewer-dialog] .wand-media-stage');
        await wait("document.querySelector('.wand-media-stage').classList.contains('zoomed')");
        await screenshot(`image-zoom-${mode}`);
        await click('[data-testid=image-viewer-dialog] .wand-media-stage');
        await wait("!document.querySelector('.wand-media-stage').classList.contains('zoomed')");
        await screenshot(`image-fit-${mode}`);
        await key("Escape");
        await wait("!document.querySelector('[data-testid=image-viewer-dialog]')");

        }
        // ---- restart overlay, above an already-open generic dialog ----
        await evaluate("window.viewers.openFixtureDialog()");
        await wait("[...document.querySelectorAll('[data-wand-dialog-surface]')].some(node => node.textContent.includes('重启优先级验收'))");
        await settleMotion();
        await evaluate("window.viewers.showRestart()");
        await wait("!!document.querySelector('[data-testid=restart-overlay]')");
        assert.equal(await evaluate("!!document.querySelector('[data-testid=restart-overlay] .ant-spin')"), true, "等待态用库 Spinner");
        assert.equal(await evaluate("document.querySelector('.wand-restart-progress')?.getAttribute('role') === 'progressbar'"), true, "进度是库 progressbar");
        assert.equal(await evaluate("!!document.querySelector('[aria-label=\"服务重启期间无法关闭\"]')"), false, "重启遮罩不再渲染关闭按钮");
        await settleMotion();
        await evaluate("window.viewers.fireDeadline()");
        await wait("!!document.querySelector('.wand-restart-manual')");
        assert.equal(await evaluate("document.querySelector('.wand-restart-manual').classList.contains('ant-btn')"), true, "手动刷新是库按钮");
        await wait("document.activeElement === document.querySelector('.wand-restart-manual')");
        await settleMotion();
        const layer = await evaluate(`(() => {
          const manual = document.querySelector('.wand-restart-manual');
          const rect = manual.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          const surfaces = [...document.querySelectorAll('[data-wand-dialog-surface]')].map(surface => {
            const wrapper = surface.closest('.ant-modal-wrap');
            const ancestors = [];
            for (let parent = wrapper; parent && parent !== document.body; parent = parent.parentElement) {
              ancestors.push({ tag: parent.tagName, id: parent.id, class: parent.className, zIndex: getComputedStyle(parent).zIndex });
            }
            return { title: surface.textContent.slice(0, 45), testId: surface.dataset.testid, wrapperZ: getComputedStyle(wrapper).zIndex, ancestors };
          });
          return { manualHit: hit === manual || manual.contains(hit), hitTag: hit?.tagName,
            hitClass: hit?.className, hitSurface: hit?.closest('[data-wand-dialog-surface]')?.dataset.testid ?? null, surfaces };
        })()`);
        evidence.push({ mode, restartLayer: layer });
        await screenshot(`restart-over-generic-${mode}`);
        assert.equal(layer.manualHit, true, `${mode}: restart manual button owns its actual mouse hit point`);
        await key("Tab");
        await key("Tab", 1);
        assert.equal(await evaluate("document.activeElement === document.querySelector('.wand-restart-manual')"), true, `${mode}: restart owns keyboard focus loop`);
        await key("Escape");
        assert.equal(await evaluate("!!document.querySelector('[data-testid=restart-overlay]')"), true, `${mode}: restart is non-dismissible`);
        assert.deepEqual(await evaluate("window.viewers.fixtureDialogResults"), [], `${mode}: Escape never dismisses obscured generic dialog`);
        await screenshot(`restart-timeout-${mode}`);
        assert.equal(await evaluate("document.activeElement === document.querySelector('.wand-restart-manual')"), true, `${mode}: timeout autofocus survives Modal afterOpenChange`);
        await key("Enter");
        assert.equal(await evaluate("window.viewers.reloadCalls"), 1, `${mode}: Enter refreshes the top restart surface`);
        await click(".wand-restart-manual");
        assert.equal(await evaluate("window.viewers.reloadCalls"), 2, `${mode}: actual mouse refresh remains reachable above generic dialog`);
        assert.deepEqual(await evaluate("window.viewers.fixtureDialogResults"), [], `${mode}: restart actions leave underlying dialog intact`);
        // Reverse user order: restarting is already visible. A genuine click on
        // the underlying launcher must be intercepted by the takeover mask.
        await click("#fixture-generic-launch");
        assert.equal(await evaluate("window.viewers.fixtureDialogRequests"), 1, `${mode}: restarting blocks opening a lower surface by user click`);
        await evaluate("window.viewers.closeFixtureDialog()");
        await wait("document.querySelectorAll('[data-wand-dialog-surface]').length === 1");
        await evaluate("window.viewers.openFixtureDialog()");
        await settleMotion();
        const lateFocus = await evaluate("({ restartHasFocus: document.querySelector('[data-testid=restart-overlay]').contains(document.activeElement), activeText: document.activeElement.textContent, requests: window.viewers.fixtureDialogRequests })");
        evidence.push({ mode, lateFocus });
        assert.equal(lateFocus.restartHasFocus, true, `${mode}: a late generic dialog cannot steal focus during restarting`);
        await key("Tab");
        await key("Tab", 1);
        await key("Escape");
        assert.equal(await evaluate("document.activeElement === document.querySelector('.wand-restart-manual')"), true, `${mode}: late dialog preserves restart keyboard loop`);
        assert.equal(await evaluate("window.viewers.fixtureDialogResults.length"), 1, `${mode}: late underlying dialog is not dismissed by Escape`);
        await key("Enter");
        assert.equal(await evaluate("window.viewers.reloadCalls"), 3, `${mode}: late dialog cannot intercept keyboard refresh`);
        await click(".wand-restart-manual");
        assert.equal(await evaluate("window.viewers.reloadCalls"), 4, `${mode}: restart stays clickable after a late dialog`);
        await screenshot(`restart-over-late-generic-${mode}`);
        await evaluate("window.viewers.hideRestart()");
        await wait("!document.querySelector('[data-testid=restart-overlay]')");
        await click(".wand-ui-dialog-actions .ant-btn", "保留弹窗");
        await wait("window.viewers.fixtureDialogResults.length === 2");
        assert.equal(await evaluate("window.viewers.fixtureDialogResults.at(-1).action"), false, `${mode}: retained late dialog becomes interactive after restarting closes`);
        await evaluate("window.viewers.openFixtureDialog()");
        await settleMotion();
        await key("Escape");
        await wait("window.viewers.fixtureDialogResults.length === 3");
        assert.equal(await evaluate("window.viewers.fixtureDialogResults.at(-1).dismissed"), true, `${mode}: closing restart releases Escape ownership`);
      }

      // ---- retired selectors are gone from every runtime mode ----
      const retired = await evaluate(`(() => {
        const selectors = [".wand-file-explorer-btn:not(.ant-btn)", ".wand-explorer-filter", ".wand-explorer-dots i",
          ".wand-explorer-context-divider", ".wand-explorer-context-item", ".wand-code-editor-btn",
          ".wand-code-editor-find-btn", ".wand-code-editor-find-input:not(.ant-input)", ".wand-code-editor-tab-close:not(.ant-tabs-tab-remove)",
          ".wand-restart-spinner", ".wand-file-preview-image", ".wand-file-preview-container"];
        return Object.fromEntries(selectors.map(selector => [selector, document.querySelectorAll(selector).length]));
      })()`);
      assert.deepEqual(
        Object.entries(retired).filter(([, count]) => count !== 0),
        [],
        `${mode}: 退役选择器在运行态不应命中任何节点`,
      );
      const overflow = await evaluate("document.documentElement.scrollWidth > innerWidth + 1");
      assert.equal(overflow, false, `${mode}: no horizontal overflow`);
      evidence.push({
        mode,
        interactions: restartOnly ? ["restart deadline/focus/non-dismissible", "generic-before-and-after/restart hit/Tab/Enter/Escape"] : ["tree arrows/context/rename", "Segmented filter/focus", "IME Tab", "CtrlS/save failure/draft recovery", "Tabs Home/End/roving", "attachment TextArea", "nested discard cancel/focus/confirm", "image fit/original", "local iframe sandbox", "restart deadline/focus/non-dismissible"],
        nestedActions: await evaluate("window.viewers.dialogActions"),
        retired,
        library: await evaluate(`({
          explorerSegmented: !!document.querySelector(".wand-explorer-search-filters.ant-segmented"),
          explorerButtons: document.querySelectorAll(".wand-file-explorer-btn.ant-btn").length,
          inputs: document.querySelectorAll("#explorer-panel .ant-input").length,
          antButtons: document.querySelectorAll(".ant-btn").length,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        })`),
      });
      console.log(`Viewer browser passed: ${mode}`);
    }

    async function window_open(path: string, target = "editor"): Promise<boolean> {
      return await evaluate(target === "editor"
        ? `window.viewers.openEditor(${JSON.stringify(path)})`
        : `window.viewers.openPreview({ path: ${JSON.stringify(path)} })`);
    }

    assert.deepEqual(browserErrors, [], "no browser runtime exceptions");
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, evidenceName), JSON.stringify({
      passed: true,
      scope: explorerOnly ? "File explorer mounted from production source in real Chrome against an isolated stub HTTP surface" : "Viewer lane hosts mounted from production source in real Chrome against a stub HTTP surface",
      evidence,
      browserErrors,
    }, null, 2));
  } catch (error) {
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, evidenceName), JSON.stringify({ passed: false, evidence, browserErrors, error: String(error) }, null, 2));
    throw error;
  } finally {
    resumeWrite?.();
    socket?.close();
    if (chrome.exitCode === null) {
      const stopped = once(chrome, "exit");
      chrome.kill();
      await stopped;
    }
    server.close();
    rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
