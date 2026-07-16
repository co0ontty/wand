import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MemoryUiAdapter,
  ShellFilePanel,
  ShellTopbar,
  UiStoreProvider,
  getParentFilePanelCwd,
  normalizeFilePanelCwd,
  type UiSessionVm,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function selectedSession(): UiSessionVm {
  return {
    id: "session-1",
    source: "wand",
    provider: "codex",
    kind: "pty",
    title: "Chrome migration",
    description: "Move topbar and files",
    cwd: "/workspace/wand",
    status: "idle",
    statusLabel: "空闲",
    active: true,
    selected: false,
    resumable: true,
    permissionBlocked: false,
    inFlight: false,
    claudeSessionId: "codex-thread-1",
    worktree: {
      enabled: true,
      branch: "codex/chrome",
      path: "/workspace/.wand/worktrees/chrome",
      mergeStatus: "ready",
    },
  };
}

function fixture(overrides: Partial<UiSnapshotData> = {}): UiSnapshotData {
  const selected = selectedSession();
  return {
    auth: { phase: "authenticated" },
    viewport: { mobile: false, online: true, embedTerminal: false, nativeInput: false },
    capabilities: { backToNative: false, switchServer: false },
    layout: {
      sessionsDrawerOpen: true,
      sidebarPinned: true,
      sidebarCollapsed: false,
      sidebarAnchored: true,
      sessionsBackdropVisible: false,
      filePanelOpen: true,
      filePanelBackdropVisible: true,
      topbarMoreOpen: true,
      currentView: "terminal",
    },
    selected,
    sidebar: {
      interactiveCount: 1,
      totalCount: 1,
      manageMode: false,
      selectedCount: 0,
      groups: [{ kind: "wand", label: "Wand 会话", expanded: true, entries: [selected] }],
    },
    topbar: {
      title: selected.title,
      description: selected.description,
      statusLabel: selected.statusLabel,
      statusTone: "idle",
      cwd: selected.cwd,
      currentTask: "实现 Shell chrome",
      git: { branch: "codex/chrome", modifiedCount: 3, clean: false },
    },
    legacyVisibility: { terminal: true, chat: false, blank: false, composer: true },
    ...overrides,
  };
}

function renderWithStore(component: ReturnType<typeof createElement>, snapshot = fixture()): string {
  const store = new MemoryUiAdapter(snapshot);
  try {
    return renderToStaticMarkup(createElement(UiStoreProvider, { store }, component));
  } finally {
    store.dispose();
  }
}

test("ShellTopbar SSR preserves title, status, cwd, git, and menu contracts", () => {
  const html = renderWithStore(createElement(ShellTopbar));
  const requiredIds = [
    "sessions-toggle-button",
    "current-task",
    "topbar-cwd",
    "topbar-file-button",
    "topbar-git-slot",
    "topbar-git-badge",
    "topbar-more-button",
    "topbar-more-menu",
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);

  assert.match(html, /class="floating-sidebar-toggle active"/);
  assert.match(html, /class="topbar-brand"[^>]*>W</);
  assert.match(html, /class="topbar-session-title"[^>]*>Chrome migration</);
  assert.match(html, /class="session-status-pill idle"/);
  assert.match(html, /实现 Shell chrome/);
  assert.match(html, /class="topbar-cwd tail-marquee-path"/);
  assert.match(html, /class="topbar-git-branch">codex\/chrome</);
  assert.match(html, /class="topbar-git-count">·3</);
  assert.match(html, /id="topbar-more-button" class="topbar-btn square active"/);
  assert.match(html, /id="topbar-more-menu"[^>]*class="wand-ui-popover-content topbar-more-menu wand-shell-menu-popover"/);
  assert.match(html, /data-action="copy-claude-session-id"/);
  assert.match(html, /data-action="copy-cwd"/);
  assert.match(html, /data-action="copy-session-id"/);
  assert.match(html, /data-action="worktree-merge"/);
  assert.match(html, /data-action="delete-session"/);
});

test("ShellTopbar SSR renders the home state and an empty stable git slot", () => {
  const base = fixture();
  const html = renderWithStore(createElement(ShellTopbar), fixture({
    selected: null,
    layout: { ...base.layout, filePanelOpen: false, topbarMoreOpen: false },
    topbar: {
      title: "Wand 控制台",
      description: "",
      statusLabel: "",
      statusTone: "",
      cwd: "/workspace",
      currentTask: "",
      git: null,
    },
  }));

  assert.match(html, /class="topbar-tagline">Wand 控制台</);
  assert.match(html, /<span id="topbar-git-slot" class="topbar-git-slot"><\/span>/);
  assert.doesNotMatch(html, /id="topbar-more-button"/);
  assert.doesNotMatch(html, /id="topbar-cwd"/);
  assert.doesNotMatch(html, /id="topbar-git-badge"/);
});

test("file panel path helpers normalize navigation without accessing the DOM", () => {
  assert.equal(normalizeFilePanelCwd("  //workspace///wand//  "), "/workspace/wand");
  assert.equal(normalizeFilePanelCwd(" / "), "/");
  assert.equal(normalizeFilePanelCwd("   "), "");
  assert.equal(getParentFilePanelCwd("/workspace/wand"), "/workspace");
  assert.equal(getParentFilePanelCwd("/workspace"), "/");
  assert.equal(getParentFilePanelCwd("/"), "/");
});

test("ShellFilePanel SSR preserves controls and leaves #file-explorer childless", () => {
  const explorerRef = createRef<HTMLDivElement>();
  const html = renderWithStore(createElement(ShellFilePanel, { explorerRef }));
  const requiredIds = [
    "file-panel-backdrop",
    "file-side-panel",
    "file-explorer-refresh",
    "file-side-panel-close",
    "file-explorer-up",
    "file-explorer-cwd",
    "file-search-input",
    "file-search-clear",
    "file-explorer",
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);

  assert.match(html, /id="file-panel-backdrop" class="file-panel-backdrop open"/);
  assert.match(html, /id="file-side-panel" class="file-side-panel open"/);
  assert.match(html, /id="file-explorer-cwd"[^>]*value="\/workspace\/wand"/);
  assert.match(html, /<div class="file-explorer" id="file-explorer"><\/div>/);
  assert.doesNotMatch(html, /id="file-tree"|tree-loading|加载中/);
});

test("Shell chrome sources use UiStore hooks and no forbidden legacy seam", () => {
  for (const file of ["shell-topbar.tsx", "shell-file-panel.tsx"]) {
    const source = readFileSync(path.join(root, "src", "web-ui", "react", "shell", file), "utf8");
    assert.match(source, /useUiStoreSnapshot\(\)/, `${file} must subscribe to UiStore`);
    assert.match(source, /useUiDispatch\(\)/, `${file} must dispatch UiAction`);
    assert.doesNotMatch(source, /innerHTML|querySelector|getElementById|browser\/state|@radix-ui\//);
  }
  const panelSource = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-file-panel.tsx"),
    "utf8",
  );
  assert.match(panelSource, /<div className="file-explorer" id="file-explorer" ref=\{explorerRef\}\/>/);
});
