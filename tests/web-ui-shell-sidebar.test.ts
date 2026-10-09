import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { confirmSidebarLogout } from "../src/web-ui/react/shell/shell-sidebar.js";
import { overlayStore } from "../src/web-ui/react/overlay-controller.js";

import {
  MemoryUiAdapter,
  SHELL_SESSION_DELETE_LABEL,
  SHELL_WORKTREE_CLEANUP_LABEL,
  SHELL_WORKTREE_MERGE_LABEL,
  ShellSidebar,
  UiStoreProvider,
  getShellSidebarEntryActions,
  getShellSidebarPrimaryAction,
  getSidebarEntryTarget,
  sidebarActionLeavesPage,
  type UiAction,
  type UiSessionVm,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sidebar logout waits for explicit confirmation and leaves cancellation in place", async () => {
  let exits = 0;
  let cancellations = 0;
  for (const result of [{ dismissed: true }, { dismissed: false, action: false }, { dismissed: false, action: true }] as const) {
    const pending = confirmSidebarLogout(() => { exits++; }, () => { cancellations++; });
    const dialog = overlayStore.getSnapshot().activeDialog;
    assert.ok(dialog);
    assert.equal(exits, 0, "opening the dialog must not log out");
    assert.equal(dialog.options.title, "退出登录？");
    assert.ok(dialog.options.actions.some(action => action.value === false && action.autoFocus));
    overlayStore.completeDialog(dialog.id, result);
    await pending;
    assert.equal(exits, !result.dismissed && result.action ? 1 : 0);
    assert.equal(cancellations, !result.dismissed && result.action ? 2 : result.dismissed ? 1 : 2);
  }
});

function session(overrides: Partial<UiSessionVm> = {}): UiSessionVm {
  return {
    id: "session-1",
    source: "wand",
    provider: "claude",
    kind: "pty",
    title: "Main session",
    description: "Primary work",
    cwd: "/workspace",
    status: "idle",
    statusLabel: "空闲",
    active: true,
    selected: false,
    resumable: true,
    permissionBlocked: false,
    inFlight: false,
    titleGenerating: false,
    startedAt: "2026-07-16T08:00:00.000Z",
    claudeSessionId: "provider-session-1",
    ...overrides,
  };
}

function fixture(overrides: Partial<UiSnapshotData> = {}): UiSnapshotData {
  const wand = session({
    worktree: {
      enabled: true,
      branch: "codex/sidebar",
      path: "/workspace/.wand/worktrees/sidebar",
      mergeStatus: "ready",
    },
  });
  const cleanup = session({
    id: "session-cleanup",
    title: "Cleanup worktree",
    active: false,
    resumable: false,
    worktree: {
      enabled: true,
      branch: "codex/cleanup",
      path: "/workspace/.wand/worktrees/cleanup",
      mergeStatus: "merged",
    },
  });
  const automation = session({
    id: "automation-1",
    source: "automation",
    title: "Nightly automation",
    active: false,
    resumable: false,
  });
  const claudeHistory = session({
    id: "claude-history-1",
    source: "claude-history",
    provider: "claude",
    title: "Claude history",
    active: false,
    description: "",
    status: "stopped",
    statusLabel: "历史",
    resumable: true,
    claudeSessionId: "claude-history-1",
  });
  const codexHistory = session({
    id: "codex-history-1",
    source: "codex-history",
    provider: "codex",
    title: "Codex history",
    active: false,
    description: "",
    status: "stopped",
    statusLabel: "历史",
    resumable: true,
    claudeSessionId: "codex-history-1",
  });
  return {
    auth: { phase: "authenticated" },
    viewport: { mobile: true, online: true, embedTerminal: false, nativeInput: true },
    capabilities: { backToNative: true, switchServer: false },
    layout: {
      sessionsDrawerOpen: true,
      sidebarPinned: true,
      sidebarCollapsed: false,
      sidebarDrawer: true,
      sidebarAnchored: true,
      sessionsBackdropVisible: true,
      filePanelOpen: false,
      filePanelBackdropVisible: false,
      topbarMoreOpen: false,
      currentView: "terminal",
    },
    selected: wand,
    sidebar: {
      interactiveCount: 2,
      totalCount: 5,
      manageMode: false,
      selectedCount: 0,
      groups: [
        { kind: "wand", label: "Wand 会话", expanded: true, entries: [wand, cleanup] },
        { kind: "automation", label: "自动化", expanded: false, entries: [automation] },
        { kind: "history", label: "非 Wand 会话", expanded: true, entries: [claudeHistory, codexHistory] },
      ],
    },
    topbar: {
      title: wand.title,
      description: wand.description,
      statusLabel: wand.statusLabel,
      statusTone: wand.status,
      cwd: wand.cwd,
      currentTask: "",
      titleGenerating: false,
      git: null,
    },
    legacyVisibility: { terminal: true, chat: false, blank: false, composer: true },
    ...overrides,
  };
}

function renderSidebar(snapshot: UiSnapshotData): string {
  const store = new MemoryUiAdapter(snapshot);
  try {
    return renderToStaticMarkup(createElement(
      UiStoreProvider,
      { store },
      createElement(ShellSidebar),
    ));
  } finally {
    store.dispose();
  }
}

test("sidebar entry helpers map primary and secondary actions without legacy state", () => {
  const regular = session({
    worktree: { enabled: true, branch: "codex/sidebar", path: "/worktree", mergeStatus: "ready" },
  });
  const cleanup = session({
    id: "cleanup",
    resumable: false,
    worktree: { enabled: true, branch: "codex/cleanup", path: "/cleanup", mergeStatus: "merged" },
  });
  const history = session({
    id: "history-id",
    source: "codex-history",
    provider: "codex",
    cwd: "/history",
  });

  assert.equal(getSidebarEntryTarget(regular), "session");
  assert.equal(getSidebarEntryTarget(history), "codex-history");
  assert.deepEqual(getShellSidebarEntryActions(regular, false), {
    primary: { type: "session.select", id: "session-1" },
    resume: { type: "session.resume", id: "session-1" },
    delete: { type: "session.delete", target: "session", id: "session-1" },
    merge: { type: "session.merge", id: "session-1" },
    cleanup: null,
  });
  assert.deepEqual(getShellSidebarEntryActions(cleanup, false), {
    primary: { type: "session.select", id: "cleanup" },
    resume: null,
    delete: { type: "session.delete", target: "session", id: "cleanup" },
    merge: null,
    cleanup: { type: "session.cleanup", id: "cleanup" },
  });
  assert.deepEqual(getShellSidebarEntryActions(history, false), {
    primary: { type: "session.resumeHistory", provider: "codex", id: "history-id", cwd: "/history" },
    resume: { type: "session.resumeHistory", provider: "codex", id: "history-id", cwd: "/history" },
    delete: { type: "session.delete", target: "codex-history", id: "history-id" },
    merge: null,
    cleanup: null,
  });
  assert.deepEqual(getShellSidebarEntryActions(history, true), {
    primary: { type: "session.manage.select", target: "codex-history", id: "history-id" },
    resume: null,
    delete: null,
    merge: null,
    cleanup: null,
  });
});

test("ShellSidebar SSR preserves native ids, key classes, groups, and action contracts", () => {
  const html = renderSidebar(fixture());
  const requiredIds = [
    "sessions-drawer-backdrop",
    "sessions-drawer",
    "close-drawer-button",
    "sessions-panel",
    "sessions-list",
    "drawer-new-session-button",
    "file-panel-toggle-btn",
    "settings-button",
    "back-to-native-button",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  // 抽屉态只有一个关闭入口：抽屉态没有「折叠成窄栏」形态（sidebarCollapsed 在 sidebarDrawer 下恒为 false），
  // 原先的 chevron 与 ✕ 派发同一个 layout.drawer.close，且被 CSS 藏成 display:none 的死节点。
  assert.doesNotMatch(html, /id="sidebar-collapse-btn"/);
  assert.equal((html.match(/id="close-drawer-button"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="switch-server-button"/);
  assert.doesNotMatch(html, /id="sidebar-pin-btn"/);
  // 创建器不会自动建任务，入口准确命名为会话。
  assert.doesNotMatch(html, />会话<\/button>/);
  assert.match(html, /aria-label="新建会话"/);
  assert.doesNotMatch(html, /<button[^>]*title="首页"/);
  assert.match(html, /<aside(?=[^>]*id="sessions-drawer")(?=[^>]*class="[^"]*sidebar sidebar-refined open[^"]*")/);
  assert.match(html, /id="sessions-drawer-backdrop" class="drawer-backdrop open"/);
  // Ant Button reports the selected file action through its accessible pressed state.
  assert.match(html, /id="file-panel-toggle-btn"[^>]*aria-pressed="false"/);
  assert.match(html, /ant-layout-sider/);
  // 自动化会话不再占用侧栏底部；原生历史仍可达。
  assert.doesNotMatch(html, /class="automation-session-group"/);
  assert.match(html, /class="[^"]*non-wand-session-group[^"]*"[\s\S]*?aria-expanded="true"/);
  assert.match(html, /data-claude-history-id="codex-history-1"/);
  assert.match(html, /data-action="resume-codex-history"/);
  assert.match(html, /data-action="delete-codex-history"/);
  assert.doesNotMatch(html, /class="session-manage-bar/);
});

test("ShellSidebar desktop exposes one full-to-compact toggle", () => {
  const base = fixture();
  const html = renderSidebar(fixture({
    viewport: { ...base.viewport, mobile: false },
    capabilities: { backToNative: false, switchServer: false },
    layout: { ...base.layout, sidebarDrawer: false },
  }));

  // Appica's IconButton renders `aria-label`/`aria-pressed` ahead of the class
  // list, so assert the identity hook and the state contract independently.
  assert.match(html, /class="[^"]*sidebar-compact-toggle[^"]*"/);
  assert.match(html, /aria-label="收起为窄栏"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(html, /sidebar-layout-switch|data-layout-mode/);
  assert.doesNotMatch(html, /id="sidebar-pin-btn"/);
  assert.doesNotMatch(html, /id="sidebar-collapse-btn"/);
  assert.doesNotMatch(html, /id="close-drawer-button"/);
  assert.doesNotMatch(html, /id="file-panel-toggle-btn"/);

  const compactHtml = renderSidebar(fixture({
    viewport: { ...base.viewport, mobile: false },
    capabilities: { backToNative: false, switchServer: false },
    layout: {
      ...base.layout,
      sidebarDrawer: false,
      sidebarCollapsed: true,
    },
  }));
  assert.match(compactHtml, /class="[^"]*sidebar-compact-toggle active"[^>]*/);
  assert.match(compactHtml, /aria-label="展开完整侧边栏"[^>]*aria-pressed="true"/);
});

test("ShellSidebar SSR retires manage mode but keeps capability-gated controls", () => {
  const base = fixture();
  const html = renderSidebar(fixture({
    capabilities: { backToNative: false, switchServer: true },
    sidebar: {
      ...base.sidebar,
      manageMode: true,
      selectedCount: 1,
    },
  }));

  // 批量管理模式随散会话列表一起下线。
  assert.doesNotMatch(html, /class="session-manage-bar/);
  assert.doesNotMatch(html, /data-action="delete-selected"/);
  assert.doesNotMatch(html, /data-action="toggle-selection"/);
  // 能力开关按钮仍在。
  assert.doesNotMatch(html, /id="back-to-native-button"/);
  assert.match(html, /id="switch-server-button"/);
});

test("ShellSidebar collapsed rail still renders the unified task panel", () => {
  const base = fixture();
  const html = renderSidebar(fixture({
    viewport: { ...base.viewport, mobile: false },
    layout: {
      ...base.layout,
      sidebarDrawer: false,
      sidebarCollapsed: true,
    },
  }));

  // 窄栏不再有散会话磁贴，改为极简任务轨：展开入口 + 新建任务。
  assert.match(html, /<aside(?=[^>]*id="sessions-drawer")(?=[^>]*class="[^"]*sidebar sidebar-refined open pinned collapsed[^"]*")/);
  assert.doesNotMatch(html, /class="sidebar-collapsed-tiles"[^>]*>[\s\S]*任务列表/);
  assert.doesNotMatch(html, /aria-label="任务列表"/);
  assert.match(html, /aria-label="展开完整侧边栏"/);
  assert.match(html, /aria-label="新建会话"/);
  assert.doesNotMatch(html, /class="session-manage-bar/);

});

test("ShellSidebar primary action accurately names the unified session creator", () => {
  assert.deepEqual(getShellSidebarPrimaryAction(), {
    action: { type: "workspace.new" },
    label: "新建会话",
    ariaLabel: "新建会话",
  });
});

test("sidebar temporary tools preserve the page while navigation leaves it", () => {
  const temporaryActions: UiAction[] = [
    { type: "settings.open" },
    { type: "missions.open" },
    { type: "workspace.new" },
    { type: "workspace.newAt", cwd: "/workspace" },
    { type: "layout.files.toggle" },
  ];
  for (const action of temporaryActions) {
    assert.equal(sidebarActionLeavesPage(action), false, `${action.type} must preserve the current page`);
  }
  const navigationActions: UiAction[] = [
    { type: "nav.home" },
    { type: "session.select", id: "session-1" },
    { type: "session.resume", id: "session-1" },
    { type: "session.resumeHistory", provider: "codex", id: "thread-1", cwd: "/workspace" },
    { type: "native.back" },
    { type: "native.switchServer" },
    { type: "auth.logout" },
  ];
  for (const action of navigationActions) {
    assert.equal(sidebarActionLeavesPage(action), true, `${action.type} must leave the current page`);
  }
});

test("ShellSidebar keeps creation above the directory task tree and profile settings at the rail bottom", () => {
  const html = renderSidebar(fixture());
  const createIndex = html.indexOf('id="drawer-new-session-button"');
  const treeIndex = html.indexOf('class="workspaces-panel"');
  assert.ok(createIndex > 0 && createIndex < treeIndex);
  assert.ok(html.indexOf("sidebar-feature-nav") < createIndex);
  assert.ok(html.indexOf('id="settings-button"') < html.indexOf('sidebar-list-panel'));
  assert.match(html, /sidebar-profile-button/);
  assert.match(html, /sidebar-navigation-rail/);
  assert.equal(html.match(/id="drawer-new-session-button"/g)?.length, 1);
  assert.doesNotMatch(html, /aria-label="新建项目"/);
  assert.doesNotMatch(html, /aria-label="独立任务"/);
  assert.doesNotMatch(html, /aria-label="项目"/);
});

test("mobile drawer ignores the desktop compact preference", () => {
  const base = fixture();
  const html = renderSidebar(fixture({ layout: { ...base.layout, sidebarCollapsed: true } }));
  assert.doesNotMatch(html, /class="sidebar sidebar-refined open pinned collapsed"/);
  assert.match(html, /aria-label="正在加载任务列表"/);
  assert.doesNotMatch(html, /aria-label="新建项目"/);
});

test("a desktop file panel borrows the list space without changing the compact preference", () => {
  const base = fixture();
  const open = fixture({
    viewport: { ...base.viewport, mobile: false },
    layout: { ...base.layout, sidebarDrawer: false, sidebarCollapsed: true, filePanelOpen: true },
  });
  const html = renderSidebar(open);
  assert.match(html, /sidebar-refined[^\"]*context-rail/);
  assert.match(html, /width:56px/);
  assert.match(html, /sidebar-list-panel[^>]*hidden=\"\" inert=\"\"/);
  assert.equal(open.layout.sidebarCollapsed, true);
  const restored = renderSidebar(fixture({ ...open, layout: { ...open.layout, filePanelOpen: false } }));
  assert.match(restored, /sidebar-refined[^\"]*collapsed/);
  assert.doesNotMatch(restored, /context-rail/);
});

test("ShellSidebar removes redundant tools and retains a closed account menu", () => {
  const html = renderSidebar(fixture());
  assert.match(html, /class="sidebar-brand-mark"/);
  assert.match(html, /id="task-board-button"/);
  assert.match(html, /aria-label="任务看板"/);
  assert.match(html, /aria-label="账户与设置"/);
  const source = readFileSync(new URL("../src/web-ui/react/shell/shell-sidebar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /missions-button|github-issues-button|sidebar-home-btn|sidebar-refresh-btn/);
  for (const id of ["missions-button", "github-issues-button", "logout-button"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /sidebar-list-title[^>]*><strong>执行会话<\/strong>/);
  // 搜索框现在常驻 DOM（靠 CSS 展开、inert 收起），所以收起时断言「不可交互」，
  // 而不是「不存在」（旧断言是 placeholder 不出现）。
  assert.match(html, /class="sidebar-search-expand[^"]*"[^>]*inert=/);
  assert.match(html, /aria-expanded="false"/);
});

test("ShellSidebar source uses the UiStore hooks and no forbidden legacy seam", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-sidebar.tsx"),
    "utf8",
  );

  assert.match(source, /useUiStoreSnapshot\(\)/);
  assert.match(source, /useUiDispatch\(\)/);
  assert.match(source, /onToggle=/);
  assert.match(source, /layout\.drawer\.group\.set/);
  assert.doesNotMatch(source, /innerHTML|querySelector|getElementById|browser\/state|@radix-ui\//);
});

test("worktree / 删除会话的动作名只有一个来源，顶栏和侧栏都引用常量", () => {
  // 这三条文案曾经是顶栏与侧栏各写一份，改一处漏一处；现在只允许从 shell-sidebar 导出。
  const sidebar = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-sidebar.tsx"), "utf8");
  const topbar = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-topbar.tsx"), "utf8");
  const labels: Array<[string, string, string]> = [
    ["SHELL_WORKTREE_MERGE_LABEL", SHELL_WORKTREE_MERGE_LABEL, "合并到主分支…"],
    ["SHELL_WORKTREE_CLEANUP_LABEL", SHELL_WORKTREE_CLEANUP_LABEL, "重试 worktree 清理"],
    ["SHELL_SESSION_DELETE_LABEL", SHELL_SESSION_DELETE_LABEL, "删除会话"],
  ];
  for (const [name, value, text] of labels) {
    assert.equal(value, text, `${name} 的动作名不许悄悄换词`);
    assert.match(sidebar, new RegExp(`export const ${name} = `), `${name} 由 shell-sidebar 导出`);
    assert.ok((topbar.match(new RegExp(name, "g")) ?? []).length >= 2,
      `topbar 要 import 并使用 ${name}，不能再写字面量`);
    assert.ok((sidebar.match(new RegExp(`${name}\\b`, "g")) ?? []).length >= 2,
      `sidebar 要在导出之外实际用上 ${name}`);
    assert.equal(topbar.includes(`"${text}"`), false, `topbar 里不该再出现 ${text} 的字面量`);
  }
});

// 侧栏时间戳是整站最后一处写死 locale 的日期格式（第 24 步 ①-丁 登记）。
// 英文环境的用户在同一页里看到两种日期写法比看到「非本语言的格式」更糟。
test("侧栏日期跟浏览器 locale 走，web 源码里没有写死的 locale", () => {
  const sidebar = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-sidebar.tsx"), "utf8");
  assert.match(sidebar, /parsed\.toLocaleDateString\(\[\], \{ month: "numeric", day: "numeric" \}\)/,
    "空 locale 数组 = 跟浏览器走");
  assert.doesNotMatch(sidebar, /toLocale\w+\("zh-CN"/, "侧栏不许再写死 zh-CN");

  const formatters = /toLocale(?:String|DateString|TimeString)\(\s*("[^"]+")/g;
  const offenders: string[] = [];
  for (const file of localeFormattableSources(path.join(root, "src", "web-ui"))) {
    const hits = [...readFileSync(file, "utf8").matchAll(formatters)];
    if (hits.length) offenders.push(`${file.slice(root.length + 1)}: ${hits.map((h) => h[1]).join(", ")}`);
  }
  assert.deepEqual(offenders, [], "日期/时刻格式化只能传空 locale");
});

test("员工资料面板外点与 Escape 都可关闭，面板和触发按钮属于内部", () => {
  const profile = readFileSync(
    new URL("../src/web-ui/react/shell/object-profile-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(profile, /e\.key === "Escape"/);
  assert.match(profile, /document\.addEventListener\("pointerdown", onPointerDown, true\)/);
  assert.match(profile, /panelRef\.current\?\.contains\(target\)/);
  assert.match(profile, /isWandPopupOwnedBy\(target, "object-profile"\)/);
  assert.match(profile, /triggerRef\.current\?\.contains\(target\)/);
  assert.match(profile, /document\.removeEventListener\("pointerdown", onPointerDown, true\)/);
});

/** 前端源码（不含生成的 bundle / 内联资产），用来扫有没有重新写死 locale。 */
function localeFormattableSources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) localeFormattableSources(full, into);
    else if (/\.tsx?$/.test(entry.name)) into.push(full);
  }
  return into;
}
