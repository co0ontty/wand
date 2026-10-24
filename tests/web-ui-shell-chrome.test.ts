import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WandDropdownMenu } from "../src/web-ui/react/ui/dropdown-menu.js";
import {
  MemoryUiAdapter,
  ShellFilePanel,
  ShellTopbar,
  TopbarMoreMenu,
  UiStoreProvider,
  getParentFilePanelCwd,
  getShellSidebarEntryActions,
  getTopbarMoreActions,
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
    titleGenerating: true,
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
      sidebarDrawer: false,
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
      titleGenerating: true,
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

test("ShellTopbar SSR preserves title, git, and menu contracts without duplicate metadata", () => {
  const html = renderWithStore(createElement(ShellTopbar));
  const requiredIds = [
    "current-task",
    "topbar-more-button",
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);

  // The action panel is portalled by the popover layer and only mounts while
  // open, so SSR keeps the trigger contract only. The `data-action` hooks the
  // browser layer dispatches through are asserted by the TopbarMoreMenu test
  // below, which renders the panel body directly.
  assert.doesNotMatch(html, /id="topbar-more-menu"/);

  assert.doesNotMatch(html, /id="sessions-toggle-button"/);
  assert.doesNotMatch(html, /class="topbar-brand"/);
  assert.match(html, /(?=[^<]*class="[^"]*topbar-session-title title-generating[^"]*")[^>]*aria-busy="true"/);
  assert.match(html, /Chrome migration/);
  assert.match(html, /实现 Shell chrome/);
  assert.doesNotMatch(html, /topbar-metadata|session-status-pill|topbar-provider|topbar-cwd/);
  assert.equal((html.match(/id="topbar-more-button"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="当前会话操作"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="topbar-file-button"|id="topbar-local-preview-button"|topbar-git-slot/, "secondary actions mount inside the menu");
  // Appica's icon button reports its pressed state through `data-pressed`.
  assert.match(html, /id="topbar-more-button"[^>]*data-pressed="true"/);
  assert.match(html, /id="topbar-more-button"[^>]*wand-ui-icon-button/);
  // Appica's trigger carries the popup contract itself; the menu body is
  // portalled and only mounts while open, so SSR keeps the closed state.
  assert.match(html, /<button(?=[^>]*id="topbar-more-button")(?=[^>]*aria-haspopup="menu")(?=[^>]*aria-expanded="true")/);
  assert.match(readFileSync(new URL("../src/web-ui/react/shell/shell-topbar.tsx", import.meta.url), "utf8"), /WandDropdownMenuTrigger/);
  // 聊天宽度开关只在聊天在屏时出现（本 fixture 是 terminal 视图）。
  assert.doesNotMatch(html, /chat-width-toggle/);
});

test("ShellTopbar omits duplicate execution metadata in every session phase and view", () => {
  const base = fixture();
  for (const chat of [false, true]) {
    for (const phase of ["idle", "running", "permission", "error"] as const) {
      const active = phase === "running" || phase === "permission";
      const selected: UiSessionVm = {
        ...selectedSession(),
        status: phase === "permission" ? "running" : phase,
        statusLabel: phase === "permission" ? "等待确认" : phase === "running" ? "思考中" : phase === "error" ? "失败" : "空闲",
        turnActive: active,
        permissionBlocked: phase === "permission",
        turnStartedAt: "2026-10-10T00:00:00Z",
        lastActivityAt: "2026-10-10T00:00:00Z",
      };
      const html = renderWithStore(createElement(ShellTopbar), {
        ...base,
        selected,
        topbar: { ...base.topbar, statusLabel: selected.statusLabel, statusTone: phase },
        layout: { ...base.layout, currentView: chat ? "chat" : "terminal" },
        legacyVisibility: { terminal: !chat, chat, blank: false, composer: true },
      });
      assert.match(html, /Chrome migration/);
      assert.match(html, /aria-label="当前会话操作"/);
      assert.doesNotMatch(html, /topbar-metadata|topbar-provider|topbar-cwd|session-status-(?:pill|text|elapsed|silent)/);
    }
  }
});

test("ShellTopbar keeps a session menu instead of a permanent width control", () => {
  const chat = renderWithStore(
    createElement(ShellTopbar),
    fixture({ legacyVisibility: { terminal: false, chat: true, blank: false, composer: true } }),
  );
  assert.match(chat, /aria-label="当前会话操作"/);
  assert.doesNotMatch(chat, /ant-segmented/);
  assert.doesNotMatch(readFileSync(new URL("../src/web-ui/react/shell/shell-topbar.tsx", import.meta.url), "utf8"), /ChatWidthMenuItems|chat-width-toggle/);

});

test("TopbarMoreMenu keeps every action hook the browser layer dispatches", () => {
  const selected = selectedSession();
  // Appica's DropdownMenu sub-components require the root's size/reduced-motion
  // context, so render the panel body inside an open root.
  const html = renderToStaticMarkup(
    createElement(
      WandDropdownMenu,
      { open: true },
      createElement(TopbarMoreMenu, {
        selected,
        actions: getShellSidebarEntryActions(selected, false),
        onAction: () => {},
      }),
    ),
  );

  assert.equal(html, "", "composed library items are portals, not duplicate visible SSR menus");
  const source = readFileSync(new URL("../src/web-ui/react/shell/shell-topbar.tsx", import.meta.url), "utf8");
  for (const action of ["copy-claude-session-id", "copy-cwd", "copy-session-id", "worktree-merge", "delete-session"]) {
    assert.ok(getTopbarMoreActions(selected, getShellSidebarEntryActions(selected, false)).some(item => item.actionName === action), `missing real action ${action}`);
  }
  assert.match(source, /WandDropdownMenuItem/);
  assert.ok(getTopbarMoreActions(selected, getShellSidebarEntryActions(selected, false)).some(item => item.actionName === "delete-session" && item.tone === "danger"));
  assert.match(source, /WandDropdownMenuSeparator/);

});

test("ShellTopbar SSR renders the home state and an empty stable git slot", () => {
  const base = fixture();
  const html = renderWithStore(createElement(ShellTopbar), fixture({
    viewport: { ...base.viewport, mobile: true },
    selected: null,
    layout: {
      ...base.layout,
      sessionsDrawerOpen: false,
      sidebarPinned: false,
      sidebarDrawer: true,
      sidebarAnchored: false,
      filePanelOpen: false,
      topbarMoreOpen: false,
    },
    topbar: {
      title: "Wand 控制台",
      description: "",
      statusLabel: "",
      statusTone: "",
      cwd: "/workspace",
      currentTask: "",
      titleGenerating: false,
      git: null,
    },
  }));

  assert.match(html, /id="sessions-toggle-button"[^>]*class="[^"]*floating-sidebar-toggle/);
  assert.match(html, /class="topbar-tagline">Wand 控制台</);
  assert.match(html, /<svg class="topbar-brand"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /class="topbar-brand"[^>]*>W</);
  assert.match(html, /id="topbar-more-button"/, "file and preview remain available without a selected session");
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

test("ShellFilePanel keeps the legacy slot outside its client Drawer portal", () => {
  const explorerRef = createRef<HTMLDivElement>();
  const html = renderWithStore(createElement(ShellFilePanel, { explorerRef }));
  assert.match(html, /id="file-panel-backdrop"/);
  assert.match(html, /<div class="file-explorer legacy-file-explorer-host" id="file-explorer" hidden="" aria-hidden="true"><\/div>/);
  const source = readFileSync(new URL("../src/web-ui/react/shell/shell-file-panel.tsx", import.meta.url), "utf8");
  // 抽屉本体（antd Drawer）单独成块：面板只在真的打开时才下载。
  const drawerSource = readFileSync(new URL("../src/web-ui/react/shell/shell-file-panel-drawer.tsx", import.meta.url), "utf8");
  assert.match(source, /import\("\.\/shell-file-panel-drawer"\)/);
  assert.match(drawerSource, /<Drawer forceRender open=\{snapshot\.layout\.filePanelOpen && !suspended\}/);
  for (const id of ["file-side-panel", "file-explorer-refresh", "file-side-panel-close", "file-explorer-up", "file-explorer-cwd"]) {
    assert.match(drawerSource, new RegExp(`id="${id}"`), `missing #${id}`);
  }
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
  const drawerSource = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-file-panel-drawer.tsx"),
    "utf8",
  );
  assert.match(panelSource, /className="file-explorer legacy-file-explorer-host"/);
  // root 必须来自 state，不能是 ref：commitCwd 的 setCwd 常与当前值相同
  // （输入期间 onChange 已同步），ref 更新不会触发 FileExplorerHost 重挂。
  assert.match(drawerSource, /const \[committedCwd, setCommittedCwd\] = React\.useState\(snapshotCwd\)/);
  assert.match(drawerSource, /<FileExplorerHost root=\{committedCwd\} enabled=\{snapshot.layout.filePanelOpen && !suspended\}\/>/);
  assert.match(drawerSource, /import\("\.\.\/file-explorer\/host"\)/);
});
