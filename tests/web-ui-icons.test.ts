import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WandIcon, workspaceTaskIconName } from "../src/web-ui/react/ui/icons.js";
import {
  MemoryUiAdapter,
  ShellSidebar,
  UiStoreProvider,
  type UiSessionVm,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";

test("workspace task markers distinguish isolated worktrees from shared directories", () => {
  assert.equal(workspaceTaskIconName(true), "branch");
  assert.equal(workspaceTaskIconName(false), "task");
});

test("git commit, branch, and merge glyphs stay visually distinct", () => {
  const git = renderToStaticMarkup(createElement(WandIcon, { name: "git" }));
  const branch = renderToStaticMarkup(createElement(WandIcon, { name: "branch" }));
  const merge = renderToStaticMarkup(createElement(WandIcon, { name: "merge" }));
  assert.match(git, /data-icon="git"/);
  assert.match(branch, /data-icon="branch"/);
  assert.match(merge, /data-icon="merge"/);
  assert.notEqual(git, branch);
  assert.notEqual(branch, merge);
  assert.notEqual(git, merge);
});

test("WandIcon stamps a data-icon matching the semantic name", () => {
  const html = renderToStaticMarkup(createElement(WandIcon, { name: "gear", size: 16 }));
  assert.match(html, /data-icon="gear"/);
  assert.match(html, /<circle cx="12" cy="12" r="3"/);
  assert.match(html, /M12\.22 2h-\.44/);
  assert.doesNotMatch(html, /M12 2v4M12 18v4/);
});

test("sidebar footer maps settings and missions to distinct glyphs", () => {
  const selected: UiSessionVm = {
    id: "session-1",
    source: "wand",
    provider: "claude",
    kind: "pty",
    title: "Main",
    description: "",
    cwd: "/workspace",
    status: "idle",
    statusLabel: "空闲",
    active: true,
    selected: false,
    resumable: false,
    permissionBlocked: false,
    inFlight: false,
    titleGenerating: false,
  };
  const snapshot: UiSnapshotData = {
    auth: { phase: "authenticated" },
    viewport: { mobile: true, online: true, embedTerminal: false, nativeInput: true },
    capabilities: { backToNative: false, switchServer: false },
    layout: {
      sessionsDrawerOpen: true,
      sidebarPinned: true,
      sidebarCollapsed: false,
      sidebarAnchored: true,
      sessionsBackdropVisible: true,
      filePanelOpen: false,
      filePanelBackdropVisible: false,
      topbarMoreOpen: false,
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
      description: "",
      statusLabel: selected.statusLabel,
      statusTone: selected.status,
      cwd: selected.cwd,
      currentTask: "",
      titleGenerating: false,
      git: null,
    },
    legacyVisibility: { terminal: true, chat: false, blank: false, composer: true },
  };
  const store = new MemoryUiAdapter(snapshot);
  try {
    const html = renderToStaticMarkup(createElement(
      UiStoreProvider,
      { store },
      createElement(ShellSidebar),
    ));
    assert.match(html, /id="settings-button"[^>]*>[\s\S]*?data-icon="gear"/);
    assert.match(html, /id="missions-button"[^>]*>[\s\S]*?data-icon="parallel"/);
    assert.match(html, /id="file-panel-toggle-btn"[^>]*>[\s\S]*?data-icon="explorer"/);
    assert.doesNotMatch(html, /data-icon="inbox"/);
  } finally {
    store.dispose();
  }
});
