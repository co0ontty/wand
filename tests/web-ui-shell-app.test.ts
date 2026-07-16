import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MemoryUiAdapter,
  ShellApp,
  getShellLayoutClassName,
  type ShellMainContentRefs,
  type UiSessionVm,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function selectedSession(): UiSessionVm {
  return {
    id: "session-1",
    source: "wand",
    provider: "claude",
    kind: "pty",
    title: "Shell app",
    description: "Compose the migrated shell",
    cwd: "/workspace/wand",
    status: "idle",
    statusLabel: "空闲",
    active: true,
    selected: false,
    resumable: true,
    permissionBlocked: false,
    inFlight: false,
  };
}

function fixture(layout: Partial<UiSnapshotData["layout"]> = {}): UiSnapshotData {
  const selected = selectedSession();
  return {
    auth: { phase: "authenticated" },
    viewport: { mobile: false, online: true, embedTerminal: false, nativeInput: false },
    capabilities: { backToNative: false, switchServer: false },
    layout: {
      sessionsDrawerOpen: true,
      sidebarPinned: false,
      sidebarCollapsed: false,
      sidebarAnchored: true,
      sessionsBackdropVisible: false,
      filePanelOpen: false,
      filePanelBackdropVisible: false,
      topbarMoreOpen: false,
      currentView: "terminal",
      ...layout,
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
      currentTask: "",
      git: null,
    },
    legacyVisibility: { terminal: true, chat: false, blank: false, composer: true },
  };
}

function legacyRefs(): ShellMainContentRefs {
  return {
    terminal: createRef<HTMLDivElement>(),
    chat: createRef<HTMLDivElement>(),
    composer: createRef<HTMLDivElement>(),
    fileExplorer: createRef<HTMLDivElement>(),
    crossSessionQueue: createRef<HTMLDivElement>(),
  };
}

test("getShellLayoutClassName projects drawer, anchored, and collapsed states", () => {
  assert.equal(getShellLayoutClassName({
    sessionsDrawerOpen: false,
    sidebarAnchored: false,
    sidebarPinned: false,
    sidebarCollapsed: false,
  }), "main-layout");
  assert.equal(getShellLayoutClassName({
    sessionsDrawerOpen: true,
    sidebarAnchored: false,
    sidebarPinned: false,
    sidebarCollapsed: false,
  }), "main-layout sidebar-open");
  assert.equal(getShellLayoutClassName({
    sessionsDrawerOpen: true,
    sidebarAnchored: true,
    sidebarPinned: false,
    sidebarCollapsed: false,
  }), "main-layout sidebar-open sidebar-pinned");
  assert.equal(getShellLayoutClassName({
    sessionsDrawerOpen: true,
    sidebarAnchored: true,
    sidebarPinned: true,
    sidebarCollapsed: true,
  }), "main-layout sidebar-open sidebar-pinned sidebar-collapsed");
});

test("ShellApp provides the store and composes one sidebar and one main content", () => {
  const store = new MemoryUiAdapter(fixture());
  try {
    const html = renderToStaticMarkup(createElement(ShellApp, { store, legacyRefs: legacyRefs() }));
    assert.match(html, /^<div class="app-container"><div class="main-layout sidebar-open sidebar-pinned">/);
    assert.equal((html.match(/id="sessions-drawer-backdrop"/g) ?? []).length, 1);
    assert.equal((html.match(/id="sessions-drawer"/g) ?? []).length, 1);
    assert.equal((html.match(/class="main-content"/g) ?? []).length, 1);
    assert.equal((html.match(/id="output"/g) ?? []).length, 1);
    assert.equal((html.match(/id="chat-output"/g) ?? []).length, 1);
    assert.match(html, /<div id="output" class="terminal-container active"><\/div>/);
    assert.match(html, /<div id="chat-output" class="chat-container hidden"><\/div>/);
    assert.match(html, /<div class="input-panel"><\/div><\/main><\/div><\/div>$/);
  } finally {
    store.dispose();
  }
});

test("MemoryUiAdapter snapshot replacement preserves every legacy slot contract", () => {
  const store = new MemoryUiAdapter(fixture());
  const refs = legacyRefs();
  try {
    const initial = renderToStaticMarkup(createElement(ShellApp, { store, legacyRefs: refs }));
    store.setSnapshot(fixture({
      sessionsDrawerOpen: false,
      sidebarPinned: true,
      sidebarCollapsed: true,
      sidebarAnchored: true,
      currentView: "chat",
    }), { sync: true });
    const updatedSnapshot = store.getSnapshot();
    store.setSnapshot({
      ...fixture(updatedSnapshot.layout),
      layout: updatedSnapshot.layout,
      legacyVisibility: { terminal: false, chat: true, blank: false, composer: true },
    }, { sync: true });
    const updated = renderToStaticMarkup(createElement(ShellApp, { store, legacyRefs: refs }));

    assert.match(initial, /class="main-layout sidebar-open sidebar-pinned"/);
    assert.match(updated, /class="main-layout sidebar-pinned sidebar-collapsed"/);
    for (const html of [initial, updated]) {
      assert.equal((html.match(/id="output"/g) ?? []).length, 1);
      assert.equal((html.match(/id="chat-output"/g) ?? []).length, 1);
      assert.equal((html.match(/class="input-panel(?: hidden)?"/g) ?? []).length, 1);
      assert.equal((html.match(/id="file-explorer"/g) ?? []).length, 1);
    }
    assert.match(updated, /<div id="output" class="terminal-container hidden"><\/div>/);
    assert.match(updated, /<div id="chat-output" class="chat-container active"><\/div>/);
  } finally {
    store.dispose();
  }
});

test("ShellApp source forwards refs without recreating slots or legacy seams", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-app.tsx"),
    "utf8",
  );
  assert.match(source, /<UiStoreProvider store=\{store\}>/);
  assert.match(source, /<ShellSidebar\/>/);
  assert.match(source, /<ShellMainContent legacyRefs=\{legacyRefs\}\/>/);
  assert.doesNotMatch(source, /sessions-drawer-backdrop/);
  assert.doesNotMatch(source, /innerHTML|querySelector|getElementById|browser\/state|@radix-ui\/|\bfetch\s*\(/);
});
