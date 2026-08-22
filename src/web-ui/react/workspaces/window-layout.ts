import { findLayoutTab, removeTab } from "./layout-tree";
import type {
  LayoutNode,
  PaneTab,
  TaskWindowLayout,
  WorkWindowLayout,
} from "./types";

export type PersistedTaskLayout = TaskWindowLayout | LayoutNode | null;

function sessionPaneTab(sessionId: string): PaneTab {
  return { id: `tab-${sessionId}`, kind: "session", sessionId };
}

function paneWith(tab: PaneTab): LayoutNode {
  return { type: "pane", tabs: [tab], active: 0 };
}

function layoutTabs(node: LayoutNode): PaneTab[] {
  return node.type === "pane"
    ? node.tabs
    : [...layoutTabs(node.children[0]), ...layoutTabs(node.children[1])];
}

export function layoutSessionIds(node: LayoutNode): string[] {
  return layoutTabs(node)
    .filter((tab): tab is Extract<PaneTab, { kind: "session" }> => tab.kind === "session")
    .map((tab) => tab.sessionId);
}

export function activeLayoutTab(node: LayoutNode, preferredId?: string): PaneTab | undefined {
  if (preferredId) {
    const preferred = findLayoutTab(node, preferredId);
    if (preferred) return preferred;
  }
  if (node.type === "pane") return node.tabs[node.active] ?? node.tabs[0];
  return activeLayoutTab(node.children[0]) ?? activeLayoutTab(node.children[1]);
}

export function activeWorkWindow(layout: TaskWindowLayout | null): WorkWindowLayout | null {
  if (!layout || layout.windows.length === 0) return null;
  return layout.windows.find((window) => window.id === layout.activeWindowId) ?? layout.windows[0] ?? null;
}

export function activeWorkWindowTab(layout: TaskWindowLayout | null): PaneTab | undefined {
  const window = activeWorkWindow(layout);
  return window ? activeLayoutTab(window.layout, window.activeTabId) : undefined;
}

function isTaskWindowLayout(value: PersistedTaskLayout): value is TaskWindowLayout {
  return Boolean(value && value.type === "windows" && Array.isArray(value.windows));
}

function uniqueWindowId(base: string, used: Set<string>): string {
  let candidate = base || "window";
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base || "window"}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function windowIdForTab(tab: PaneTab): string {
  if (tab.kind === "session") return `window-${tab.sessionId}`;
  return `window-${tab.id}`;
}

interface NormalizedNode {
  node: LayoutNode;
  extras: PaneTab[];
}

/**
 * 一个 pane 只保留一个内容标签；历史 tabset 中的其它终端被提升成独立工作窗口。
 * 同时清理已不属于任务的 session 与跨窗口重复引用。
 */
function normalizeNode(
  node: LayoutNode,
  validSessions: ReadonlySet<string>,
  seenTabs: Set<string>,
): NormalizedNode {
  if (node.type === "pane") {
    const valid = node.tabs.filter((tab) => {
      if (seenTabs.has(tab.id)) return false;
      if (tab.kind === "session" && !validSessions.has(tab.sessionId)) return false;
      seenTabs.add(tab.id);
      return true;
    });
    if (valid.length === 0) return { node: { type: "pane", tabs: [], active: 0 }, extras: [] };
    const preferred = node.tabs[node.active];
    const keep = preferred && valid.some((tab) => tab.id === preferred.id) ? preferred : valid[0];
    return {
      node: paneWith(keep),
      extras: valid.filter((tab) => tab.id !== keep.id),
    };
  }

  const left = normalizeNode(node.children[0], validSessions, seenTabs);
  const right = normalizeNode(node.children[1], validSessions, seenTabs);
  const leftEmpty = layoutTabs(left.node).length === 0;
  const rightEmpty = layoutTabs(right.node).length === 0;
  const extras = [...left.extras, ...right.extras];
  if (leftEmpty && rightEmpty) return { node: left.node, extras };
  if (leftEmpty) return { node: right.node, extras };
  if (rightEmpty) return { node: left.node, extras };
  return {
    node: { ...node, children: [left.node, right.node] },
    extras,
  };
}

/**
 * 把 null、旧版单棵 LayoutNode 或新版窗口集合统一成窗口模型，并补齐任务会话。
 * 这是布局不变量的唯一入口：每个任务 session 恰好出现一次，每个 pane 最多一个内容。
 */
export function reconcileTaskWindowLayout(
  persisted: PersistedTaskLayout,
  sessionIds: readonly string[],
  preferredSessionId?: string | null,
): TaskWindowLayout {
  const validSessions = new Set(sessionIds);
  const sourceWindows: WorkWindowLayout[] = isTaskWindowLayout(persisted)
    ? persisted.windows
    : persisted
      ? [{ id: "window-legacy", layout: persisted }]
      : [];
  const seenTabs = new Set<string>();
  const usedWindowIds = new Set<string>();
  const windows: WorkWindowLayout[] = [];

  for (const source of sourceWindows) {
    const normalized = normalizeNode(source.layout, validSessions, seenTabs);
    const tabs = layoutTabs(normalized.node);
    if (tabs.length > 0) {
      const id = uniqueWindowId(source.id, usedWindowIds);
      const active = activeLayoutTab(normalized.node, source.activeTabId);
      windows.push({ id, layout: normalized.node, activeTabId: active?.id });
    }
    for (const extra of normalized.extras) {
      const id = uniqueWindowId(windowIdForTab(extra), usedWindowIds);
      windows.push({ id, layout: paneWith(extra), activeTabId: extra.id });
    }
  }

  for (const sessionId of sessionIds) {
    const tab = sessionPaneTab(sessionId);
    if (seenTabs.has(tab.id)) continue;
    seenTabs.add(tab.id);
    const id = uniqueWindowId(windowIdForTab(tab), usedWindowIds);
    windows.push({ id, layout: paneWith(tab), activeTabId: tab.id });
  }

  const persistedActive = isTaskWindowLayout(persisted) ? persisted.activeWindowId : null;
  const preferredWindow = preferredSessionId
    ? windows.find((window) => layoutSessionIds(window.layout).includes(preferredSessionId))
    : undefined;
  const activeWindowId = preferredWindow?.id
    ?? windows.find((window) => window.id === persistedActive)?.id
    ?? windows[0]?.id
    ?? null;
  return { type: "windows", windows, activeWindowId };
}

export function activateWorkWindow(layout: TaskWindowLayout, windowId: string): TaskWindowLayout {
  if (!layout.windows.some((window) => window.id === windowId) || layout.activeWindowId === windowId) return layout;
  return { ...layout, activeWindowId: windowId };
}

export function focusWorkWindowTab(
  layout: TaskWindowLayout,
  windowId: string,
  tabId: string,
): TaskWindowLayout {
  let changed = layout.activeWindowId !== windowId;
  const windows = layout.windows.map((window) => {
    if (window.id !== windowId || !findLayoutTab(window.layout, tabId)) return window;
    if (window.activeTabId === tabId) return window;
    changed = true;
    return { ...window, activeTabId: tabId };
  });
  return changed ? { ...layout, activeWindowId: windowId, windows } : layout;
}

export function replaceWorkWindowLayout(
  layout: TaskWindowLayout,
  windowId: string,
  nextRoot: LayoutNode,
  activeTabId?: string,
): TaskWindowLayout {
  const windows = layout.windows.map((window) => window.id === windowId
    ? {
      ...window,
      layout: nextRoot,
      activeTabId: activeLayoutTab(nextRoot, activeTabId ?? window.activeTabId)?.id,
    }
    : window);
  return { ...layout, windows };
}

export function addSessionWindow(
  layout: TaskWindowLayout,
  sessionId: string,
  activate = true,
): TaskWindowLayout {
  const existing = layout.windows.find((window) => layoutSessionIds(window.layout).includes(sessionId));
  if (existing) return activate ? activateWorkWindow(layout, existing.id) : layout;
  const tab = sessionPaneTab(sessionId);
  const used = new Set(layout.windows.map((window) => window.id));
  const window: WorkWindowLayout = {
    id: uniqueWindowId(windowIdForTab(tab), used),
    layout: paneWith(tab),
    activeTabId: tab.id,
  };
  return {
    ...layout,
    windows: [...layout.windows, window],
    activeWindowId: activate ? window.id : layout.activeWindowId ?? window.id,
  };
}

function findSessionTab(layout: TaskWindowLayout, sessionId: string): PaneTab | undefined {
  for (const window of layout.windows) {
    const tab = layoutTabs(window.layout).find((candidate) => (
      candidate.kind === "session" && candidate.sessionId === sessionId
    ));
    if (tab) return tab;
  }
  return undefined;
}

function splitBesideTab(node: LayoutNode, targetTabId: string, moving: PaneTab, dir: "h" | "v"): LayoutNode {
  if (node.type === "pane") {
    if (!node.tabs.some((tab) => tab.id === targetTabId)) return node;
    return {
      type: "split",
      dir,
      ratio: 0.5,
      children: [node, paneWith(moving)],
    };
  }
  if (findLayoutTab(node.children[0], targetTabId)) {
    return { ...node, children: [splitBesideTab(node.children[0], targetTabId, moving, dir), node.children[1]] };
  }
  if (findLayoutTab(node.children[1], targetTabId)) {
    return { ...node, children: [node.children[0], splitBesideTab(node.children[1], targetTabId, moving, dir)] };
  }
  return node;
}

/** 把一个终端从来源工作窗口摘下，作为目标终端旁边的新 pane；来源空窗口自动消失。 */
export function moveSessionBeside(
  layout: TaskWindowLayout,
  sourceSessionId: string,
  targetWindowId: string,
  targetTabId: string | undefined,
  dir: "h" | "v",
): TaskWindowLayout {
  const moving = findSessionTab(layout, sourceSessionId);
  const targetBefore = layout.windows.find((window) => window.id === targetWindowId);
  const target = targetBefore && activeLayoutTab(targetBefore.layout, targetTabId ?? targetBefore.activeTabId);
  if (!moving || !target || moving.id === target.id) return layout;

  let windows = layout.windows
    .map((window) => findLayoutTab(window.layout, moving.id)
      ? { ...window, layout: removeTab(window.layout, moving.id) }
      : window)
    .filter((window) => layoutTabs(window.layout).length > 0);
  const targetIndex = windows.findIndex((window) => window.id === targetWindowId);
  if (targetIndex < 0) return layout;
  const targetWindow = windows[targetIndex];
  const nextTarget: WorkWindowLayout = {
    ...targetWindow,
    layout: splitBesideTab(targetWindow.layout, target.id, moving, dir),
    activeTabId: moving.id,
  };
  windows = windows.map((window, index) => index === targetIndex ? nextTarget : window);
  return { ...layout, windows, activeWindowId: targetWindowId };
}

/** 把分屏中的一个终端提升成独立工作窗口 Tab。 */
export function extractSessionWindow(layout: TaskWindowLayout, sessionId: string): TaskWindowLayout {
  const sourceIndex = layout.windows.findIndex((window) => layoutSessionIds(window.layout).includes(sessionId));
  if (sourceIndex < 0) return layout;
  const source = layout.windows[sourceIndex];
  const moving = findSessionTab(layout, sessionId);
  if (!moving) return layout;
  if (layoutTabs(source.layout).length <= 1) return activateWorkWindow(layout, source.id);

  const remaining = removeTab(source.layout, moving.id);
  const used = new Set(layout.windows.map((window) => window.id));
  const extracted: WorkWindowLayout = {
    id: uniqueWindowId(windowIdForTab(moving), used),
    layout: paneWith(moving),
    activeTabId: moving.id,
  };
  const windows = [...layout.windows];
  windows.splice(sourceIndex, 1, { ...source, layout: remaining, activeTabId: activeLayoutTab(remaining)?.id }, extracted);
  return { ...layout, windows, activeWindowId: extracted.id };
}

function activeWindowAfterRemoval(
  layout: TaskWindowLayout,
  removedIndex: number,
  removedWindowId: string,
  windows: readonly WorkWindowLayout[],
): string | null {
  if (windows.length === 0) return null;
  if (layout.activeWindowId !== removedWindowId) {
    return windows.some((window) => window.id === layout.activeWindowId)
      ? layout.activeWindowId
      : windows[0].id;
  }
  return windows[Math.max(0, removedIndex - 1)]?.id ?? windows[0].id;
}

/** 关闭一个顶部工作窗口 Tab；活动 Tab 被关闭时优先回到左侧相邻窗口。 */
export function closeWorkWindow(layout: TaskWindowLayout, windowId: string): TaskWindowLayout {
  const index = layout.windows.findIndex((window) => window.id === windowId);
  if (index < 0) return layout;
  const windows = layout.windows.filter((window) => window.id !== windowId);
  return {
    ...layout,
    windows,
    activeWindowId: activeWindowAfterRemoval(layout, index, windowId, windows),
  };
}

/** 关闭一个终端窗格；removeTab 会同步折叠只剩一侧的 split。 */
export function closeSessionPane(layout: TaskWindowLayout, sessionId: string): TaskWindowLayout {
  const windowIndex = layout.windows.findIndex((window) => layoutSessionIds(window.layout).includes(sessionId));
  if (windowIndex < 0) return layout;
  const source = layout.windows[windowIndex];
  const tab = layoutTabs(source.layout).find((candidate) => (
    candidate.kind === "session" && candidate.sessionId === sessionId
  ));
  if (!tab) return layout;

  const nextRoot = removeTab(source.layout, tab.id);
  if (layoutTabs(nextRoot).length === 0) return closeWorkWindow(layout, source.id);

  const windows = layout.windows.map((window, index) => index === windowIndex
    ? {
      ...source,
      layout: nextRoot,
      activeTabId: activeLayoutTab(nextRoot, source.activeTabId)?.id,
    }
    : window);
  return { ...layout, windows };
}

/** 把一个分屏工作窗口一次拆回多个独立工作窗口 Tab。 */
export function ungroupWorkWindow(layout: TaskWindowLayout, windowId: string): TaskWindowLayout {
  const index = layout.windows.findIndex((window) => window.id === windowId);
  if (index < 0) return layout;
  const source = layout.windows[index];
  const tabs = layoutTabs(source.layout);
  if (tabs.length <= 1) return layout;
  const used = new Set(layout.windows.filter((window) => window.id !== windowId).map((window) => window.id));
  const replacements = tabs.map((tab): WorkWindowLayout => ({
    id: uniqueWindowId(windowIdForTab(tab), used),
    layout: paneWith(tab),
    activeTabId: tab.id,
  }));
  const activeTab = activeLayoutTab(source.layout, source.activeTabId) ?? tabs[0];
  const active = replacements[tabs.findIndex((tab) => tab.id === activeTab.id)] ?? replacements[0];
  const windows = [...layout.windows];
  windows.splice(index, 1, ...replacements);
  return { ...layout, windows, activeWindowId: active?.id ?? null };
}

