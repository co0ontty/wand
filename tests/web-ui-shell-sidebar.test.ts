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
  getSessionDirectoryLabels,
  getShellSidebarEntryActions,
  getShellSidebarPrimaryAction,
  getSidebarEntryTarget,
  normalizeSessionDirectoryCustomName,
  type UiSessionVm,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";
import { HttpSessionDirectoryRepository } from "../src/web-ui/react/shell/session-directory-repository.js";

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

test("directory labels prefer a custom workspace name without losing the real directory", () => {
  assert.deepEqual(getSessionDirectoryLabels({
    name: "wand",
    customName: "  核心工作区  ",
    path: "/workspace/wand",
  }), {
    displayName: "核心工作区",
    directoryName: "wand",
    path: "/workspace/wand",
  });
  assert.deepEqual(getSessionDirectoryLabels({
    name: "wand",
    customName: "   ",
    path: "/workspace/wand",
  }), {
    displayName: "wand",
    directoryName: "",
    path: "/workspace/wand",
  });
  assert.deepEqual(getSessionDirectoryLabels({
    name: "wand",
    customName: "wand",
    path: "/workspace/wand",
  }), {
    displayName: "wand",
    directoryName: "",
    path: "/workspace/wand",
  });
  assert.equal(normalizeSessionDirectoryCustomName("  wand  ", "wand"), "");
  assert.equal(normalizeSessionDirectoryCustomName("  核心工作区  ", "wand"), "核心工作区");
});

test("session directory repository saves trimmed workspace names and surfaces server errors", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const repository = new HttpSessionDirectoryRepository((async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        roots: [{
          path: "/workspace/wand",
          name: "wand",
          customName: "核心工作区",
          synthetic: false,
          directCount: 0,
          totalCount: 0,
          latestTimestamp: 0,
          entries: [],
          children: [],
        }],
        totalSessions: 0,
        directoryCount: 1,
        revision: "r1",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true,
      path: "/workspace/wand",
      name: "新名称",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);

  const tree = await repository.load();
  assert.equal(tree.roots[0]?.customName, "核心工作区");
  assert.deepEqual(await repository.rename("/workspace/wand", "  新名称  "), {
    ok: true,
    path: "/workspace/wand",
    name: "新名称",
  });
  assert.equal(calls[1]?.url, "/api/session-directories/name");
  assert.equal(calls[1]?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    path: "/workspace/wand",
    name: "新名称",
  });

  const denied = new HttpSessionDirectoryRepository((async () => new Response(JSON.stringify({
    error: "该目录不存在",
  }), { status: 404, headers: { "Content-Type": "application/json" } })) as typeof fetch);
  await assert.rejects(denied.rename("/missing", "name"), /该目录不存在/);
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
  assert.match(html, />项目<\/button>/);
  assert.match(html, /id="sessions-drawer" class="sidebar open pinned"/);
  assert.match(html, /id="sessions-drawer-backdrop" class="drawer-backdrop open"/);
  assert.match(html, /id="file-panel-toggle-btn" class="btn btn-ghost btn-sm active"/);
  assert.match(html, /class="automation-session-group"/);
  assert.match(html, /class="non-wand-session-group" open=""/);
  assert.match(html, /data-session-id="session-1"/);
  assert.match(html, /data-claude-history-id="codex-history-1"/);
  assert.match(html, /data-action="resume"/);
  assert.match(html, /data-action="resume-codex-history"/);
  assert.match(html, /data-action="delete-codex-history"/);
  assert.match(html, /data-action="swipe-delete-session"/);
  assert.match(html, /data-action="worktree-merge"/);
  assert.match(html, /data-action="worktree-cleanup"/);
  assert.match(html, /class="session-item active"/);
  assert.match(html, /class="session-kind-badge worktree-merge ready"/);
  assert.match(html, /data-provider-logo="claude"/);
  assert.match(html, /data-provider-logo="codex"/);
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

test("ShellSidebar SSR renders managed selection and capability-gated controls", () => {
  const base = fixture();
  const selectedGroups = base.sidebar.groups.map((group) => ({
    ...group,
    entries: group.entries.map((entry, index) => ({
      ...entry,
      selected: group.kind === "wand" && index === 0,
    })),
  }));
  const html = renderSidebar(fixture({
    capabilities: { backToNative: false, switchServer: true },
    sidebar: {
      ...base.sidebar,
      manageMode: true,
      selectedCount: 1,
      groups: selectedGroups,
    },
  }));

  assert.match(html, /class="session-manage-bar active"/);
  assert.match(html, /data-action="delete-selected"/);
  assert.match(html, /data-action="clear-selection"|data-action="select-all-visible"/);
  assert.match(html, /data-action="toggle-selection"/);
  assert.match(html, /class="session-item active selected session-managing"/);
  assert.doesNotMatch(html, /data-action="resume"/);
  assert.doesNotMatch(html, /data-action="delete-session"/);
  assert.doesNotMatch(html, /id="back-to-native-button"/);
  assert.match(html, /id="switch-server-button"/);
  assert.match(html, /class="automation-session-group manage-mode" open=""/);
  assert.match(html, /class="non-wand-session-group manage-mode" open=""/);
});

test("ShellSidebar SSR keeps the collapsed legacy tile contract", () => {
  const base = fixture();
  const groups = base.sidebar.groups.map((group) => group.kind === "wand"
    ? {
        ...group,
        entries: group.entries.map((entry, index) => index === 1
          ? { ...entry, provider: "codex" as const }
          : entry),
      }
    : group);
  const html = renderSidebar(fixture({
    layout: {
      ...base.layout,
      sidebarCollapsed: true,
    },
    sidebar: {
      ...base.sidebar,
      groups,
    },
  }));

  assert.match(html, /id="sessions-drawer" class="sidebar open pinned collapsed"/);
  assert.match(html, /class="sidebar-collapsed-tiles"/);
  assert.match(html, /data-collapsed-session-id="session-1"/);
  const collapsedSessionButtons = html.match(
    /<button[^>]+data-collapsed-session-id="[^"]+"[^>]*>[\s\S]*?<\/button>/g,
  ) ?? [];
  assert.equal(collapsedSessionButtons.length, 2);
  assert.match(collapsedSessionButtons[0] ?? "", /class="sidebar-collapsed-tile provider-claude active"/);
  assert.match(collapsedSessionButtons[1] ?? "", /class="sidebar-collapsed-tile provider-codex"/);
  assert.match(collapsedSessionButtons[0] ?? "", /data-provider-logo="claude"/);
  assert.match(collapsedSessionButtons[1] ?? "", /data-provider-logo="codex"/);
  assert.doesNotMatch(collapsedSessionButtons.join(""), />\s*[12]\s*<\/button>/);
  assert.match(collapsedSessionButtons[0] ?? "", /aria-label="Main session · Claude"/);
  assert.match(html, /data-expand-session-group="automation"/);
  assert.match(html, /data-expand-session-group="non-wand"/);
  assert.match(html, /data-collapsed-new-session="1"/);
  assert.doesNotMatch(html, /class="session-manage-bar/);
});

test("ShellSidebar primary action follows the active sidebar mode", () => {
  assert.deepEqual(getShellSidebarPrimaryAction("sessions"), {
    action: { type: "session.new" },
    label: "新会话",
    ariaLabel: "新建会话",
  });
  assert.deepEqual(getShellSidebarPrimaryAction("workspaces"), {
    action: { type: "workspace.new" },
    label: "新项目",
    ariaLabel: "新建项目",
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
