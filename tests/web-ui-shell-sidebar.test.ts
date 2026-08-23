import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MemoryUiAdapter,
  ShellSidebar,
  UiStoreProvider,
  getShellSidebarEntryActions,
  getShellSidebarPrimaryAction,
  getSidebarEntryTarget,
  type UiSessionVm,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
      sidebarAnchored: true,
      sessionsBackdropVisible: true,
      filePanelOpen: true,
      filePanelBackdropVisible: true,
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
    "session-count",
    "sidebar-collapse-btn",
    "close-drawer-button",
    "sessions-panel",
    "sessions-list",
    "drawer-new-session-button",
    "file-panel-toggle-btn",
    "settings-button",
    "back-to-native-button",
    "logout-button",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id="switch-server-button"/);
  assert.doesNotMatch(html, /id="sidebar-pin-btn"/);
  // 统一任务视图：不再有「会话/任务」切换，也不再有独立的新会话主按钮。
  assert.doesNotMatch(html, />会话<\/button>/);
  assert.match(html, /aria-label="新建任务"/);
  assert.match(html, /id="sessions-drawer" class="sidebar open pinned"/);
  assert.match(html, /id="sessions-drawer-backdrop" class="drawer-backdrop open"/);
  assert.match(html, /id="file-panel-toggle-btn" class="btn btn-ghost btn-sm active"/);
  // 原生历史与自动化分组仍可达（附加在任务列表之后），但 wand 散会话平铺列表已下线。
  assert.match(html, /class="automation-session-group"/);
  assert.match(html, /class="non-wand-session-group" open=""/);
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
  }));

  assert.match(html, /class="sidebar-compact-toggle"[^>]*aria-label="收起为窄栏"[^>]*aria-pressed="false"/);
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
      sidebarCollapsed: true,
    },
  }));
  assert.match(
    compactHtml,
    /class="sidebar-compact-toggle active"[^>]*aria-label="展开完整侧边栏"[^>]*aria-pressed="true"/,
  );
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
    layout: {
      ...base.layout,
      sidebarCollapsed: true,
    },
  }));

  // 窄栏不再有散会话磁贴，改为极简任务轨：只有「新建任务」入口。
  assert.match(html, /id="sessions-drawer" class="sidebar open pinned collapsed"/);
  assert.doesNotMatch(html, /class="sidebar-collapsed-tiles"[^>]*>[\s\S]*任务列表/);
  assert.doesNotMatch(html, /aria-label="任务列表"/);
  assert.match(html, /aria-label="新建任务"/);
  assert.doesNotMatch(html, /class="session-manage-bar/);
});

test("ShellSidebar primary action is always 新任务", () => {
  assert.deepEqual(getShellSidebarPrimaryAction(), {
    action: { type: "workspace.new" },
    label: "新任务",
    ariaLabel: "新建任务",
  });
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
