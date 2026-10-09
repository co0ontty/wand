import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SidebarPresentationContext,
  filterActiveGroups,
  isSessionRunning,
  sidebarExpansionOpen,
  sidebarModeOverrides,
  type SidebarPresentation,
} from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import { SidebarRecentSection } from "../src/web-ui/react/workspaces/sidebar-recent-section.js";
import { sidebarAggregateState, sidebarSessionState } from "../src/web-ui/react/workspaces/sidebar-session-state.js";
import { anchorSidebarDisclosure, sidebarDisclosureKeys } from "../src/web-ui/react/workspaces/sidebar-disclosure.js";
import { sidebarSafeError } from "../src/web-ui/react/workspaces/sidebar-safe-error.js";
import { SessionProviderMark } from "../src/web-ui/react/workspaces/session-mark.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const group: TaskDirectoryGroup = {
  workspaceId: "w", workspaceName: "Wand", workspaceCwd: "/repo", tasks: [], standaloneSessions: [],
};
function scope(overrides: Partial<SidebarPresentation> = {}): SidebarPresentation {
  return { mode: "full", query: "", normal: {}, overrides: {}, setMode() {}, setQuery() {},
    setNormal() {}, setOverride() {}, ...overrides };
}
function renderRecent(count: number, presentation = scope(), extra = {}): string {
  const entries = Array.from({ length: count }, (_, index) => ({
    group, taskName: "侧栏优化", session: { id: `s${index}`, employeeId: "employee-1", provider: "pi" as const,
      title: `会话${index}`, status: "idle", startedAt: "2026-10-04T00:00:00Z" },
  }));
  return renderToStaticMarkup(createElement(SidebarPresentationContext.Provider, { value: presentation },
    createElement(SidebarRecentSection, { entries, employees: [{ id: "employee-1", name: "华杰" }],
      displayMode: presentation.mode, selectedSessionId: null, now: 0, onOpen() {}, ...extra })));
}

test("1→2→1 and filtered one-session employee keep the same identity and action level", () => {
  for (const count of [1, 2, 1]) {
    const html = renderRecent(count);
    assert.equal((html.match(/class="im-sidebar-group /g) ?? []).length, 1);
    assert.equal((html.match(/class="im-sidebar-group-avatar"/g) ?? []).length, 1);
    assert.match(html, /class="[^"]*im-sidebar-group-title[^"]*"[^>]*>[\s\S]*?华杰/);
    assert.match(html, /aria-label="与华杰新建对话"/);
    assert.equal((html.match(/class="im-sidebar-item-avatar-wrap"/g) ?? []).length, count);
    assert.doesNotMatch(html, /sidebar-recent-flat|暂无消息|im-sidebar-presence-chip/);
    assert.ok(html.indexOf("im-sidebar-group-avatar") < html.indexOf("im-sidebar-item-avatar-wrap"));
  }
  assert.match(renderRecent(1, scope({ mode: "active" })), /im-sidebar-group-title[^"]*"[^>]*>[\s\S]*?华杰/);
});

test("recent employee groups omit CLI badges while child sessions retain actual tool logos", () => {
  const entries = ["codex", "pi"].map((provider, index) => ({
    group, taskName: "侧栏优化", session: { id: `mixed-${index}`, employeeId: "employee-1",
      employeeName: "华杰", employeeAvatar: "cat:2", provider, status: "idle" },
  }));
  for (const employees of [[], [{ id: "employee-1", name: "华杰", avatar: "cat:2",
    agents: [{ provider: "codex" }, { provider: "pi" }] }]]) {
    const html = renderToStaticMarkup(createElement(SidebarPresentationContext.Provider, { value: scope() },
      createElement(SidebarRecentSection, { entries, employees, displayMode: "full",
        selectedSessionId: null, now: 0, onOpen() {} })));
    assert.match(html, /wand-employee-avatar/);
    assert.doesNotMatch(html, /wand-employee-avatar-provider/);
    for (const provider of ["codex", "pi"]) {
      assert.equal(html.split(`data-provider-logo="${provider}"`).length - 1, 1,
        "only the actual child session shows its tool");
    }
  }
});

test("temporary folds and search do not inherit or overwrite normal collapsed choices", () => {
  const normal = { "recent.employee:employee-1": true };
  assert.match(renderRecent(1, scope({ mode: "folded", normal })), /aria-expanded="false"/);
  const temporary = { "recent.employee:employee-1": true };
  const expanded = renderRecent(1, scope({ mode: "folded", normal, overrides: temporary }));
  assert.match(expanded, /class="im-sidebar-group is-expanded"/);
  assert.match(renderRecent(1, scope({ mode: "active", overrides: { "recent.employee:employee-1": false } })),
    /class="im-sidebar-group"/);
  assert.equal(sidebarExpansionOpen("folded", false, true, false, false), true);
  assert.equal(sidebarExpansionOpen("active", false, false, false, false), false);
  assert.equal(sidebarExpansionOpen("folded", false, false, false, true), true);
  assert.equal(sidebarExpansionOpen("folded", false, false, false, false), false);
  assert.equal(sidebarExpansionOpen("folded", false, undefined, true, false), true, "directories default open");
  assert.equal(sidebarExpansionOpen("folded", true, undefined, false, false), false, "single sessions/empty tasks close");
  assert.equal(sidebarExpansionOpen("full", false, true, true, false), false);
  assert.deepEqual(sidebarModeOverrides("folded", "full", temporary), {});
  assert.deepEqual(sidebarModeOverrides("active", "folded", temporary), {});
  assert.equal(sidebarModeOverrides("folded", "folded", temporary), temporary);
  assert.deepEqual(normal, { "recent.employee:employee-1": true });
});

test("sidebar status prioritizes attention, real turns and unseen completion, not CLI liveness", () => {
  const cases: Array<[Partial<WorkspaceSessionSummary>, string]> = [
    [{ status: "failed", ptyBusy: true }, "失败"], [{ status: "permission-blocked" }, "等待授权"],
    [{ status: "waiting-input" }, "等待回答"], [{ status: "waiting_input" }, "等待回答"],
    [{ status: "reconnecting" }, "重连中"], [{ status: "thinking" }, "思考中"],
    [{ ptyBusy: true }, "运行中"], [{ inFlight: true }, "运行中"],
    [{ status: "idle", completionRevision: 2, viewedCompletionRevision: 1 }, "刚完成"],
    [{ status: "running", providerCliActive: true }, "空闲"], [{ status: "idle" }, "空闲"],
    [{ status: "exited" }, "已结束"], [{ status: "stopped" }, "已停止"], [{}, "状态未知"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sidebarSessionState({ id: "s", ...input }).label, expected);
  }
  assert.equal(isSessionRunning({ id: "alive", status: "running", providerCliActive: true }), false);
  const completed = { id: "completed", status: "idle", completionRevision: 2, viewedCompletionRevision: 1 };
  assert.equal(sidebarAggregateState([completed]).label, "刚完成");
  assert.match(sidebarAggregateState([completed]).description, /0 个运行中，1 个刚完成/);
  assert.equal(sidebarAggregateState([completed, { id: "busy", ptyBusy: true }]).label, "运行中");
  assert.equal(sidebarAggregateState([completed, { id: "failed", status: "failed" }]).label, "待处理");
  assert.equal(completed.viewedCompletionRevision, 1, "projection must not mark completion viewed");
  const active = filterActiveGroups([{ ...group, standaloneSessions: [completed,
    { id: "idle", status: "idle" }, { id: "alive", status: "running", providerCliActive: true }] }], "idle");
  assert.deepEqual(active[0].standaloneSessions.map((session) => session.id), ["completed", "idle"]);
});

test("first read placeholders and contact failures remain in place, without a false business empty", () => {
  const loading = renderRecent(0, scope(), { listLoading: true, contactsLoading: true });
  assert.match(loading, /ant-skeleton/);
  assert.doesNotMatch(loading, /还没有对话|还没有硅基员工/);
  const failed = renderRecent(0, scope(), { listError: true, contactsError: "not authorized" });
  assert.match(failed, /联系人加载失败/);
  assert.match(failed, />重试<\/span><\/button>/);
  assert.doesNotMatch(failed, /还没有对话|还没有硅基员工/);
  const retained = renderRecent(1, scope(), { contactsError: "offline" });
  assert.match(retained, /会话0/);
  assert.match(retained, /联系人加载失败/);
});

test("sidebar only sizes explicit provider slots; default window and tab output is compatible", () => {
  for (const provider of ["claude", "codex", "opencode", "grok", "qoder", "pi", "gemini"]) {
    const sized = renderToStaticMarkup(createElement(SessionProviderMark, { session: { provider }, size: 14 }));
    assert.match(sized, /class="sidebar-provider-mark" data-mark-size="14"/);
    assert.match(sized, new RegExp(`data-provider-logo="${provider}"`));
    const defaultMark = renderToStaticMarkup(createElement(SessionProviderMark, { session: { provider } }));
    assert.match(defaultMark, /^<svg/);
    assert.doesNotMatch(defaultMark, /sidebar-provider-mark/);
  }
  assert.match(renderToStaticMarkup(createElement(SessionProviderMark, { session: {}, size: 14 })),
    /<svg width="14" height="14"/);
  const sized = renderToStaticMarkup(createElement(SessionProviderMark, { session: { provider: "pi" }, size: 18 }));
  assert.match(sized, /width:18px;height:18px;font-size:18px/);
  const row = source("src/web-ui/react/shell/im-sidebar-item.tsx");
  assert.match(row, /<Badge dot=\{effectiveGlow !== "none"\}/);
  assert.match(row, /sidebarGlowColor\(effectiveGlow\)/);

});

test("task arrow, rail and peek share the projection through Ant layout and controls", () => {
  const shell = source("src/web-ui/react/shell/shell-sidebar.tsx");
  const panel = source("src/web-ui/react/workspaces/workspaces-panel.tsx");
  assert.match(shell, /SidebarPresentationContext.Provider value=\{presentation\}/);
  assert.match(shell, /searchQuery=\{searchQuery\}/);
  assert.doesNotMatch(panel, /useSidebarDisplayMode\(|useSidebarCollapsed\(`expandedTask/);
  assert.match(panel, /displayMode === "active"\s*\? filterActiveGroups\(searchedGroups, selectedSessionId\)/);
  assert.match(panel, /anchorSidebarDisclosure\(event.currentTarget, toggleSessionsOpen\)/);
  assert.match(panel, /onClick=\{\(\) => setDisplayMode\("full"\)\}/);
  assert.match(panel, /nativeEvent.isComposing/);
  assert.match(shell, /<Layout.Sider/);
  assert.match(shell, /width="min\(376px, calc\(100vw - 24px\)\)" collapsedWidth=\{128\}/);
  const peek = source("src/web-ui/react/shell/sidebar-peek.tsx");
  assert.match(peek, /<Card size="small"/);
  assert.match(peek, /width: "min\(320px, calc\(100vw - 144px\)\)"/);
  assert.match(panel, /<Flex align="center" gap=\{4\}/);
  assert.match(panel, /hidden=\{!searchVisible\} inert=\{!searchVisible \|\| undefined\}/);

});

test("disclosure directions operate only on their own trigger and respect IME", () => {
  const trigger = { closest: () => null };
  const changed: boolean[] = [];
  const event = (key: string, composing = false) => ({ key, target: trigger, currentTarget: trigger,
    nativeEvent: { isComposing: composing }, preventDefault() {} } as unknown as KeyboardEvent<HTMLElement>);
  sidebarDisclosureKeys(event("ArrowRight"), false, (open) => changed.push(open));
  sidebarDisclosureKeys(event("ArrowLeft"), true, (open) => changed.push(open));
  sidebarDisclosureKeys(event("ArrowRight", true), false, (open) => changed.push(open));
  assert.deepEqual(changed, [true, false]);
});

test("bottom-clamped collapse compensates tail space and preserves the source coordinate", () => {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  let baseHeight = 1000;
  const tail = { style: { height: "0px" }, get offsetHeight() { return Number.parseFloat(this.style.height); }, remove() {} };
  const scroller = { scrollTop: 500, clientHeight: 500, firstElementChild: null,
    get scrollHeight() { return baseHeight + tail.offsetHeight; }, querySelector: () => tail,
    addEventListener() {}, removeEventListener() {} };
  const trigger = { isConnected: true, closest: () => scroller, getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 600 - scroller.scrollTop }) };
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: () => void) => callback() });
    anchorSidebarDisclosure(trigger as unknown as HTMLElement, () => { baseHeight = 700; scroller.scrollTop = 200; });
    assert.equal(tail.offsetHeight, 300);
    assert.equal(trigger.getBoundingClientRect().top, 100);
  } finally {
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
    if (savedFrame) Object.defineProperty(globalThis, "requestAnimationFrame", savedFrame); else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
});

test("inline reasons do not echo credential-bearing URLs or paths", () => {
  assert.equal(sidebarSafeError("连接失败 https://server.test/api?appToken=secret /home/user/private"),
    "连接失败 [服务地址] [路径]");
  assert.equal(sidebarSafeError("认证失败 Bearer secret"), "认证失败 [凭据已隐藏]");
});

test("sidebar review regression: long contact names remain accessible with Ant typography", () => {
  const name = "很长的联系人姓名".repeat(5);
  const html = renderRecent(0, scope(), { employees: [{ id: "long", name, duty: "负责侧栏验证" }] });
  assert.match(html, /class="[^"]*sidebar-contact-picker-name[^"]*"/);
  assert.ok(html.includes(`title="${name}"`));
  assert.ok(html.includes(name));
  assert.ok(html.includes(`title="${name} · 负责侧栏验证"`));
  const picker = source("src/web-ui/react/workspaces/sidebar-recent-section.tsx");
  assert.match(picker, /<Typography.Text ellipsis className="sidebar-contact-picker-name"/);
  assert.match(picker, /style=\{\{ flex: 1, textAlign: "start" \}\}/);

});

// Opt-in development DOM regression, never an installed-service acceptance test.
// Actual Shell/WorkspacesPanel/SidebarPeek + the production CSS installation order.
// No web server, real authentication, API mutations or writes outside the worktree.
test("sidebar review regression: real browser cascade and peek unmount focus", { timeout: 90_000 }, async (t) => {
  if (process.env.WAND_SIDEBAR_BROWSER_TEST !== "1") {
    t.skip("set WAND_SIDEBAR_BROWSER_TEST=1 to run the related Chrome DOM regression");
    return;
  }
  const { spawn } = await import("node:child_process");
  const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { resolve, sep } = await import("node:path");
  const { once } = await import("node:events");
  const { build } = await import("esbuild");
  const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome)) { t.skip("Chrome executable is unavailable"); return; }
  const root = resolve(import.meta.dirname, "..");
  const output = resolve(root, process.env.WAND_SIDEBAR_TEST_OUTPUT || ".wand-team/sidebar-regression");
  assert.ok(output.startsWith(root + sep), "test output must stay within the worktree");
  mkdirSync(output, { recursive: true });
  const profile = mkdtempSync(resolve(output, "chrome-profile-"));
  const bundle = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import * as React from "react";
      import { createRoot } from "react-dom/client";
      import { ShellSidebar } from "./src/web-ui/react/shell/shell-sidebar";
      import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
      import { UiStoreProvider } from "./src/web-ui/react/shell/ui-store-react";
      import { SidebarPeek } from "./src/web-ui/react/shell/sidebar-peek";
      import { WorkspacesPanel } from "./src/web-ui/react/workspaces/workspaces-panel";
      import { conversationUi } from "./src/web-ui/react/conversations/state";
      conversationUi.mode("tasks");
      import { Layout } from "antd";
      import { WandUiProvider } from "./src/web-ui/react/theme";
      import { notifyTasksChanged } from "./src/web-ui/react/task-changes";
      import { installReactUiStyles } from "./src/web-ui/react/styles";
      const name = "联系人员".repeat(10);
      const session = (id) => ({ id, title: id, provider: "pi", status: "idle",
        employeeId: "employee", sessionKind: "structured", cwd: "/fixture/repo",
        startedAt: "2026-10-04T00:00:00Z" });
      const task = (id, worktree) => ({ id, name: id, workspaceId: "w", worktree,
        status: "active", layout: null, cwd: "/fixture/repo", createdAt: "2026-10-04T00:00:00Z",
        lastOpenedAt: null, sessions: [session(id + "-session")] });
      const initialGroups = [{ workspaceId: "w", workspaceName: "回归目录", workspaceCwd: "/fixture/repo",
        tasks: [task("normal", null), task("isolated", { branch: "fixture", path: "/fixture/worktree" })],
        standaloneSessions: [] }];
      let groups = initialGroups;
      let revision = 0;
      window.fetch = async (input, init) => {
        if (init?.method && init.method !== "GET") throw new Error("No API mutations in DOM regression");
        const url = String(input);
        let body;
        if (url.startsWith("/api/tasks")) body = { groups, revision: String(revision), unchanged: false };
        else if (url.startsWith("/api/silicon-employees")) body = { employees: [{ id: "employee", name,
          avatar: "", agents: [], duty: "负责定点验证与长职责文案检查" }] };
        else if (url.startsWith("/api/conversations")) body = { conversations: [] };
        else if (url.startsWith("/api/attention")) body = { items: [] };
        else if (url.startsWith("/api/ai-team-runs")) body = { runs: [] };
        else if (url.startsWith("/api/")) body = [];
        else throw new Error("Unexpected fixture network request");
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      };
      window.sidebarErrors = [];
      window.addEventListener("error", event => window.sidebarErrors.push(event.message));
      installReactUiStyles();
      const initial = { auth: { phase: "authenticated" },
        viewport: { mobile: false, online: true, embedTerminal: false, nativeInput: false },
        capabilities: { backToNative: false, switchServer: false },
        layout: { sessionsDrawerOpen: true, sidebarPinned: true, sidebarCollapsed: false,
          sidebarDrawer: false, sidebarAnchored: true, sessionsBackdropVisible: false,
          filePanelOpen: false, filePanelBackdropVisible: false, topbarMoreOpen: false, currentView: "chat" },
        selected: null, sidebar: { interactiveCount: 0, totalCount: 0, manageMode: false,
          selectedCount: 0, groups: [] }, topbar: { title: "", description: "", statusLabel: "",
          statusTone: "idle", cwd: "", currentTask: "", titleGenerating: false, git: null },
        legacyVisibility: { terminal: false, chat: false, blank: true, composer: false } };
      const store = new MemoryUiAdapter(initial, { batchMs: 0 });
      const renderer = createRoot(document.getElementById("fixture"));
      renderer.render(<WandUiProvider><UiStoreProvider store={store}><ShellSidebar/></UiStoreProvider></WandUiProvider>);
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      const settle = async () => {
        await frame(); await frame();
        await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})));
        await frame(); await frame();
      };
      const peekRef = React.createRef();
      window.sidebarFixture = {
        name, settle,
        setCompact(value) { store.setSnapshot({ ...initial, layout: { ...initial.layout,
          sidebarCollapsed: value } }, { sync: true }); },
        removeTask(id) { groups = groups.map((g) => ({ ...g, tasks: g.tasks.filter((task) => task.id !== id) }));
          revision++; notifyTasksChanged(); },
        resetTasks() { groups = initialGroups; revision++; notifyTasksChanged(); },
        showPeek() {
          renderer.render(<WandUiProvider><Layout.Sider id="sessions-drawer" className="sidebar sidebar-refined open pinned collapsed"
            collapsed collapsedWidth={72} width={296} style={{height:"100vh",position:"relative",overflow:"visible"}}>
            <SidebarPeek open title="回归目录" surfaceRef={peekRef} onExpand={() => {}}
              onPointerEnter={() => {}} onPointerLeave={() => {}} onFocusCapture={() => {}} onBlurCapture={() => {}}>
              <div className="sessions-list"><WorkspacesPanel directoryId="w"/></div>
            </SidebarPeek>
          </Layout.Sider></WandUiProvider>);
        },
      };
    ` },
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-breakpad", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = once(browser, "exit");
  const input = browser.stdio[3] as import("node:stream").Writable;
  const pipe = browser.stdio[4] as import("node:stream").Readable;
  let sequence = 0;
  let buffer = "";
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  pipe.setEncoding("utf8");
  pipe.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const callback = pending.get(message.id);
      if (!callback) continue;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    }
  });
  const send = (method: string, params = {}, sessionId?: string): Promise<any> =>
    new Promise((resolveMessage, rejectMessage) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); rejectMessage(new Error(`CDP timeout: ${method}`)); }, 15_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveMessage(value); },
        reject: (error) => { clearTimeout(timer); rejectMessage(error); },
      });
      input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  const evidence: Record<string, any> = { method: "source component DOM regression; about:blank; no installed service", loginAttempts: 0 };
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method: string, params = {}) => send(method, params, sessionId);
    const evaluate = async (expression: string): Promise<any> => {
      const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = (expression: string) => evaluate(`(async () => {
      const start = performance.now();
      while (!(${expression})) {
        if (performance.now() - start > 10000) throw new Error("DOM condition timed out");
        await new Promise((done) => requestAnimationFrame(done));
      }
      await window.sidebarFixture.settle();
    })()`);
    const screenshot = async (name: string): Promise<void> => {
      const { data } = await page("Page.captureScreenshot", { format: "png" });
      writeFileSync(resolve(output, `7-${name}.png`), Buffer.from(data, "base64"));
    };
    await page("Page.enable");
    await page("Runtime.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const { frameTree } = await page("Page.getFrameTree");
    await page("Page.setDocumentContent", { frameId: frameTree.frame.id, html: `<!doctype html>
      <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>#fixture{height:100dvh}</style></head>
      <body><div id="app" data-react-shell="enabled"><div id="fixture"></div></div>
      <div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals"></div></div></body></html>` });
    await evaluate(`for (const css of ${JSON.stringify([
      source("src/web-ui/content/tailwind.css"), source("src/web-ui/content/styles.css"),
    ])}) { const style = document.createElement("style"); style.textContent = css; document.head.append(style); }`);
    await evaluate(bundle.outputFiles[0].text);
    await waitFor("document.querySelectorAll('.workspace-task').length === 2").catch(async cause => {
      console.error(await evaluate("({body:document.body.innerText.slice(0,1500),tasks:document.querySelectorAll('.workspace-task').length,errors:window.sidebarErrors})"));
      throw cause;
    });
    await evaluate("document.querySelector('[data-workspace-task-id=normal] .workspace-task-chevron-btn').click()");
    await evaluate(`window.measureRect = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };`);
    evidence.markers = await evaluate(`Array.from(document.querySelectorAll('.workspace-task-marker')).map((marker) => {
      const svg = marker.querySelector('svg'), rect = svg.getBoundingClientRect();
      return { slot: [marker.offsetWidth, marker.offsetHeight], icon: svg.dataset.icon,
        svg: [rect.width, rect.height], display: getComputedStyle(svg).display,
        background: getComputedStyle(marker).backgroundColor, radius: getComputedStyle(marker).borderRadius };
    })`);
    await evaluate("document.querySelector('.sidebar-view-switch [data-stretch-value=recent]').click()");
    await evaluate("document.querySelector('.sidebar-section-add').click()");
    await waitFor("document.querySelector('.sidebar-section-add').getAttribute('aria-expanded') === 'true'");
    evidence.contacts = await evaluate(`(() => {
      const list = document.querySelector('.sidebar-contact-picker-list');
      const name = list.querySelector('.sidebar-contact-picker-name');
      const duty = list.querySelector('.sidebar-contact-picker-duty');
      const avatar = list.querySelector('.sidebar-contact-avatar .wand-employee-avatar');
      return { length: name.textContent.length, title: name.title, name: name.textContent,
        client: list.clientWidth, scroll: list.scrollWidth, nameWidth: name.offsetWidth, dutyWidth: duty.offsetWidth,
        avatar: [avatar.offsetWidth, avatar.offsetHeight], shrink: getComputedStyle(name).flexShrink,
        overflow: getComputedStyle(name).textOverflow, whiteSpace: getComputedStyle(name).whiteSpace };
    })()`);
    await screenshot("full-source-dom");
    await evaluate("document.querySelector('.sidebar-section-add').click(); document.querySelector('.sidebar-view-switch [data-stretch-value=directory]').click(); document.querySelector('[data-workspace-task-id=normal] .workspace-session-main').focus({ preventScroll: true }); document.querySelector('[data-workspace-task-id=normal] .workspace-task-chevron-btn').click()");
    await waitFor("document.querySelector('[data-workspace-task-id=normal] .workspace-task-chevron-btn').getAttribute('aria-expanded') === 'false'");
    evidence.closeFocus = await evaluate("document.activeElement.classList.contains('workspace-task-chevron-btn')");
    await evaluate("document.querySelector('[data-workspace-task-id=normal] .workspace-task-chevron-btn').click()");
    await waitFor("document.querySelector('[data-workspace-task-id=normal] .workspace-task-chevron-btn').getAttribute('aria-expanded') === 'true'");
    await evaluate("document.querySelector('[data-workspace-task-id=normal] .workspace-session-main').focus({ preventScroll: true }); window.sidebarFixture.removeTask('normal')");
    await waitFor("!document.querySelector('[data-workspace-task-id=normal]')");
    evidence.fullUnmountFocus = await evaluate("document.activeElement.classList.contains('workspace-row-main')");
    await evaluate("window.sidebarFixture.resetTasks()");
    await waitFor("document.querySelectorAll('.workspace-task').length === 2");
    await page("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await waitFor("matchMedia('(pointer: coarse)').matches");
    evidence.coarseFull = await evaluate("measureRect('.sidebar-compact-toggle')");
    await evaluate("window.sidebarFixture.setCompact(true)");
    await waitFor("document.querySelector('.sidebar.collapsed') && Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - 72) < 0.1");
    evidence.coarseRail = await evaluate(`({ source: measureRect('.sidebar-compact-toggle'),
      directory: measureRect('.sidebar-collapsed-rail-task'), newTask: measureRect('#drawer-new-session-button'),
      board: measureRect('#task-board-button'), team: measureRect('#ai-teams-button'),
      settings: measureRect('#settings-button'), more: measureRect('#sidebar-more-btn') })`);
    await screenshot("coarse-rail-source-dom");
    await page("Emulation.setTouchEmulationEnabled", { enabled: false });
    await waitFor("matchMedia('(pointer: fine)').matches");
    evidence.fineRail = await evaluate("measureRect('.sidebar-compact-toggle')");
    await screenshot("fine-rail-source-dom");
    await evaluate("window.sidebarFixture.showPeek()");
    await waitFor("document.querySelector('.sidebar-peek [data-workspace-task-id=normal] .workspace-session-main')");
    await evaluate("const head=document.querySelector('.sidebar-peek [data-workspace-task-id=normal] .workspace-task-chevron-btn'); if(head.getAttribute('aria-expanded')==='false') head.click()");
    await waitFor("document.querySelector('.sidebar-peek [data-workspace-task-id=normal] .workspace-task-chevron-btn').getAttribute('aria-expanded')==='true'");
    await evaluate("document.querySelector('.sidebar-peek [data-workspace-task-id=normal] .workspace-session-main').focus({ preventScroll: true }); window.sidebarFixture.removeTask('normal')");
    await waitFor("!document.querySelector('.sidebar-peek [data-workspace-task-id=normal]')");
    evidence.peekUnmountFocus = await evaluate(`({ isExit: document.activeElement.classList.contains('sidebar-peek-expand'),
      tag: document.activeElement.tagName, connected: document.activeElement.isConnected,
      hidden: Boolean(document.activeElement.closest('[inert], [aria-hidden=true]')) })`);
    await screenshot("peek-focus-source-dom");
    writeFileSync(resolve(output, "7-sidebar-review-dom.json"), JSON.stringify(evidence, null, 2));
    assert.deepEqual(evidence.markers, [], "directory/task decoration no longer consumes row width");
    assert.equal(evidence.contacts.length, 40);
    assert.equal(evidence.contacts.title, evidence.contacts.name);
    assert.ok(evidence.contacts.avatar[0] >= 24 && evidence.contacts.avatar[1] >= 24);
    assert.equal(evidence.contacts.scroll, evidence.contacts.client);
    assert.equal(evidence.contacts.shrink, "1");
    assert.equal(evidence.contacts.overflow, "ellipsis");
    assert.equal(evidence.contacts.whiteSpace, "nowrap");
    assert.ok(evidence.contacts.dutyWidth > 0 && evidence.contacts.nameWidth > 0);
    assert.ok(evidence.coarseFull.width >= 24 && evidence.coarseFull.height >= 24);
    for (const rect of Object.values(evidence.coarseRail) as any[]) {
      assert.ok(rect.width >= 24 && rect.height >= 24, "Ant rail control has a pointer target");
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 72, "control remains inside the Ant collapsed width");
    }
    assert.deepEqual(evidence.fineRail, evidence.coarseRail.source, "library sizing is stable across pointer modes");
    assert.equal(evidence.closeFocus, true);
    assert.equal(evidence.fullUnmountFocus, true);
    assert.deepEqual(evidence.peekUnmountFocus, { isExit: true, tag: "BUTTON", connected: true, hidden: false });
    t.diagnostic(`source-only DOM evidence written to ${output}`);
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    writeFileSync(resolve(output, "7-sidebar-review-dom.json"), JSON.stringify(evidence, null, 2));
    throw error;
  } finally {
    browser.kill("SIGTERM");
    await exited;
    // Chrome helpers can still flush profile files after the parent exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
