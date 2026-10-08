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
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";
import {
  getSidebarListError,
  reportSidebarListError,
  subscribeSidebarListError,
} from "../src/web-ui/react/workspaces/sidebar-list-error.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sidebarSnapshot(): UiSnapshotData {
  return {
    auth: { phase: "authenticated" },
    viewport: { mobile: false, online: true, embedTerminal: false, nativeInput: false },
    capabilities: { backToNative: false, switchServer: false },
    layout: {
      sessionsDrawerOpen: false,
      sidebarPinned: true,
      sidebarCollapsed: false,
      sidebarDrawer: false,
      sidebarAnchored: true,
      sessionsBackdropVisible: false,
      filePanelOpen: false,
      filePanelBackdropVisible: false,
      topbarMoreOpen: false,
      currentView: "chat",
    },
    selected: null,
    sidebar: { interactiveCount: 0, totalCount: 0, manageMode: false, selectedCount: 0, groups: [] },
    topbar: {
      title: "", description: "", statusLabel: "", statusTone: "idle", cwd: "",
      currentTask: "", titleGenerating: false, git: null,
    },
    legacyVisibility: { terminal: false, chat: true, blank: false, composer: true },
  } as unknown as UiSnapshotData;
}

function renderSidebar(): string {
  const store = new MemoryUiAdapter(sidebarSnapshot());
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

test("侧栏报错只在内容变化时通知订阅者，重报不换 retry 引用", () => {
  reportSidebarListError(null);
  let notified = 0;
  const unsubscribe = subscribeSidebarListError(() => { notified += 1; });
  const retry = async (): Promise<void> => {};
  try {
    reportSidebarListError(null);
    assert.equal(notified, 0);
    reportSidebarListError({ kind: "load", message: "无法加载任务列表。", retry });
    assert.equal(notified, 1);
    reportSidebarListError({ kind: "load", message: "无法加载任务列表。", retry: async () => {} });
    assert.equal(notified, 1, "同一条报错的轮询重报不该再通知");
    assert.equal(getSidebarListError()?.retry, retry, "重报不该换掉 retry 引用");
    reportSidebarListError({ kind: "sync", message: "列表暂未同步。", retry });
    assert.equal(notified, 2);
    reportSidebarListError(null);
    assert.equal(notified, 3);
    assert.equal(getSidebarListError(), null);
  } finally {
    unsubscribe();
    reportSidebarListError(null);
  }
});

test("加载失败留在头部独立状态行，不挤占品牌与操作区", () => {
  reportSidebarListError({ kind: "load", message: "无法加载任务列表：连接被拒绝。", retry: async () => {} });
  let html = "";
  try {
    html = renderSidebar();
  } finally {
    reportSidebarListError(null);
  }
  const status = html.match(/<div[^>]*class="[^"]*\bsidebar-status\b[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
  const brand = html.match(/<div[^>]*class="[^"]*sidebar-header-main[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(status, /class="[^"]*\bsidebar-list-error\b/, "头部状态行承载可重试的错误徽标");
  assert.match(status, /加载失败/);
  assert.match(status, /无法加载任务列表：连接被拒绝。｜点击重新加载/);
  assert.doesNotMatch(brand, /sidebar-list-error/, "错误不挤动品牌与首行按钮");
  assert.ok(html.indexOf("sidebar-title") < html.indexOf("sidebar-list-error"), "状态行位于品牌之后");
  assert.doesNotMatch(renderSidebar(), /sidebar-list-error/);
});

test("未同步保留旧行，首次失败提供原位错误与重试", () => {
  reportSidebarListError({ kind: "sync", message: "列表暂未同步，正在显示上次结果。", retry: async () => {} });
  let html = "";
  try {
    html = renderSidebar();
  } finally {
    reportSidebarListError(null);
  }
  assert.match(html, /class="[^"]*\bsidebar-list-error\b[^"]*"[^>]*>[\s\S]*?未同步/);

  const panel = readFileSync(path.join(root, "src/web-ui/react/workspaces/workspaces-panel.tsx"), "utf8");
  assert.match(panel, /sidebar-load-error/);
  assert.match(panel, /任务列表加载失败/);
  assert.match(panel, /onClick=\{\(\) => void reload\(\)\}/);
  assert.match(panel, /reportSidebarListError\(\{/, "报错改由侧栏主树上报给头部徽标");
});
