import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MemoryUiAdapter,
  ShellMainContent,
  UiStoreProvider,
  getShellLegacySlotClasses,
  getShellWelcomeQuickStartAction,
  type ShellMainContentRefs,
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
    title: "Main shell migration",
    description: "Preserve legacy slots",
    cwd: "/workspace/wand",
    status: "running",
    statusLabel: "运行中",
    active: true,
    selected: false,
    resumable: false,
    permissionBlocked: false,
    inFlight: false,
    titleGenerating: false,
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
      description: selected.description,
      statusLabel: selected.statusLabel,
      statusTone: "running",
      cwd: selected.cwd,
      currentTask: "",
      titleGenerating: false,
      git: null,
    },
    legacyVisibility: { terminal: true, chat: false, blank: false, composer: true },
    ...overrides,
  };
}

function renderMainContent(snapshot: UiSnapshotData, legacyRefs?: ShellMainContentRefs): string {
  const store = new MemoryUiAdapter(snapshot);
  try {
    return renderToStaticMarkup(createElement(
      UiStoreProvider,
      { store },
      createElement(ShellMainContent, { legacyRefs }),
    ));
  } finally {
    store.dispose();
  }
}

test("ShellMainContent SSR keeps all identity-stable legacy slots childless", () => {
  const refs: ShellMainContentRefs = {
    terminal: createRef<HTMLDivElement>(),
    chat: createRef<HTMLDivElement>(),
    composer: createRef<HTMLDivElement>(),
    fileExplorer: createRef<HTMLDivElement>(),
    crossSessionQueue: createRef<HTMLDivElement>(),
  };
  const html = renderMainContent(fixture(), refs);

  assert.match(html, /^<main class="main-content">/);
  assert.match(html, /<div id="output" class="terminal-container active"><\/div>/);
  assert.match(html, /<div id="chat-output" class="chat-container hidden"><\/div>/);
  assert.match(html, /<div class="input-panel"><\/div>.*<\/main>$/s);
  assert.match(html, /<div class="file-explorer legacy-file-explorer-host" id="file-explorer" hidden="" aria-hidden="true"><\/div>/);
  assert.match(html, /class="wand-file-explorer"/);
  assert.match(html, /<div id="blank-chat" class="blank-chat hidden">/);
  assert.match(html, /<div id="cross-session-queue-host"><\/div>/);
  assert.equal((html.match(/id="output"/g) ?? []).length, 1);
  assert.equal((html.match(/id="chat-output"/g) ?? []).length, 1);
});

test("ShellMainContent SSR renders the complete React welcome state contract", () => {
  const base = fixture();
  const html = renderMainContent(fixture({
    selected: null,
    layout: { ...base.layout, currentView: "terminal" },
    topbar: {
      title: "Wand 控制台",
      description: "",
      statusLabel: "",
      statusTone: "",
      cwd: "/chosen/project",
      currentTask: "",
      titleGenerating: false,
      git: null,
    },
    legacyVisibility: { terminal: false, chat: false, blank: true, composer: false },
  }));

  for (const id of [
    "welcome-new-task",
    "cross-session-queue-host",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  // 统一任务入口：欢迎页不再有按 provider 的快捷建会话按钮与目录选择器。
  assert.doesNotMatch(html, /welcome-tool-|blank-chat-cwd/);
  assert.match(html, /新建任务/);
  assert.match(html, /<div id="output" class="terminal-container hidden"><\/div>/);
  assert.match(html, /<div id="chat-output" class="chat-container hidden"><\/div>/);
  assert.match(html, /<div id="blank-chat" class="blank-chat">/);
  assert.match(html, /<div class="input-panel hidden"><\/div>.*<\/main>$/s);
});

test("legacy slot visibility projection preserves hidden and active semantics", () => {
  assert.deepEqual(getShellLegacySlotClasses({
    terminal: true,
    chat: false,
    blank: false,
    composer: true,
  }), {
    terminal: "terminal-container active",
    chat: "chat-container hidden",
    blank: "blank-chat hidden",
    composer: "input-panel",
  });
  assert.deepEqual(getShellLegacySlotClasses({
    terminal: false,
    chat: true,
    blank: false,
    composer: true,
  }), {
    terminal: "terminal-container hidden",
    chat: "chat-container active",
    blank: "blank-chat hidden",
    composer: "input-panel",
  });
});

test("welcome quick starts remain four exhaustive provider and kind actions", () => {
  const actions = (["claude", "codex", "opencode", "structured"] as const)
    .map(getShellWelcomeQuickStartAction);
  assert.deepEqual(actions, [
    { type: "session.quickStart.claude" },
    { type: "session.quickStart.codex" },
    { type: "session.quickStart.opencode" },
    { type: "session.quickStart.structured" },
  ]);
  assert.equal(new Set(actions.map((action) => action.type)).size, 4);
});

test("ShellMainContent uses UiStore actions and no forbidden legacy seam", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-main-content.tsx"),
    "utf8",
  );
  assert.match(source, /useUiStoreSnapshot\(\)/);
  assert.match(source, /useUiDispatch\(\)/);
  assert.match(source, /<div id="output" className=\{classes\.terminal\} ref=\{legacyRefs\?\.terminal\}\/>/);
  assert.match(source, /<div id="chat-output" className=\{classes\.chat\} ref=\{legacyRefs\?\.chat\}\/>/);
  assert.match(source, /<div className=\{classes\.composer\} ref=\{legacyRefs\?\.composer\}\/>/);
  assert.match(source, /id="cross-session-queue-host" ref=\{queueRef\}/);
  assert.match(source, /context\.taskId \? null : <ShellTopbar\/>/);
  assert.match(source, /<WorkspaceTabBar\/>/);
  assert.doesNotMatch(source, /inSplit \? null : <WorkspaceTabBar\/>/);
  assert.doesNotMatch(source, /innerHTML|querySelector|getElementById|browser\/state|@radix-ui\/|\bfetch\s*\(/);
});

test("no-task welcome steers to task creation instead of loose sessions", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-main-content.tsx"),
    "utf8",
  );
  // 欢迎页不再提供绕过任务的快捷建会话按钮，统一引导到「新建任务」。
  assert.match(source, /id="welcome-new-task"/);
  assert.match(source, /type: "workspace\.new"/);
  assert.doesNotMatch(source, /welcome-tool-claude|新建终端会话|新建结构化会话/);
});

test("workspace task blank state offers an explicit Agent or shell choice", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-main-content.tsx"),
    "utf8",
  );
  assert.match(source, /这个任务还没有工作窗口。选择一个 Agent，或直接打开空白终端。/);
  assert.match(source, /workspaceAgentDialogController\.open\(\)/);
  assert.match(source, /选择 Agent 或空白终端/);
});
