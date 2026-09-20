// 布局树纯函数（P2 分屏的基石）。全部不可变：返回新 LayoutNode，不改入参。
// 对应 plan 的 split / moveTab / removeTab / wrapInSplit，外加 addTab/activateTab/emptyLayout。
// 服务端 layout_json 存的就是这棵树（saveWorkspaceTaskLayout）；这些函数是它在浏览器侧的运算核，
// 可被 <WorkspaceWindow/> 递归渲染器与自研 DnD 落区复用。先单独实现 + 单测，再接渲染器。

import type { LayoutNode, PaneTab } from "./types";

export type SplitDir = "h" | "v";

/** 空布局：单个空窗格。打开一个无布局的任务时的起点。 */
export function emptyLayout(): LayoutNode {
  return { type: "pane", active: 0, tabs: [] };
}

/**
 * 把一个节点包进 split，挂一个兄弟节点。
 * wrapInSplit(pane, "h", emptyPane) → { type:"split", dir:"h", children:[pane, emptyPane] }
 */
export function wrapInSplit(node: LayoutNode, dir: SplitDir, sibling: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: "split", dir, ratio, children: [node, sibling] };
}

/** 在「第一个窗格」（DFS 优先）上施加变换，重建整棵树。 */
function mapFirstPane(node: LayoutNode, fn: (pane: Extract<LayoutNode, { type: "pane" }>) => LayoutNode): LayoutNode {
  if (node.type === "pane") return fn(node);
  const [left, right] = node.children;
  return { ...node, children: [mapFirstPane(left, fn), right] as [LayoutNode, LayoutNode] };
}

/** 对所有窗格施加变换，重建整棵树。 */
function mapPanes(node: LayoutNode, fn: (pane: Extract<LayoutNode, { type: "pane" }>) => LayoutNode): LayoutNode {
  if (node.type === "pane") return fn(node);
  const [left, right] = node.children;
  return { ...node, children: [mapPanes(left, fn), mapPanes(right, fn)] as [LayoutNode, LayoutNode] };
}

/** 给 path 定位到的 split 设分隔比例（sash 拖完后回写持久化）。 */
export function setRatioAtPath(layout: LayoutNode, path: readonly number[], ratio: number): LayoutNode {
  return setRatioAt(layout, path, 0, ratio);
}

function setRatioAt(node: LayoutNode, path: readonly number[], depth: number, ratio: number): LayoutNode {
  if (node.type === "pane") return node;
  if (depth >= path.length) return { ...node, ratio };
  const index = path[depth] ?? 0;
  const [left, right] = node.children;
  const next = index === 0
    ? setRatioAt(left, path, depth + 1, ratio)
    : setRatioAt(right, path, depth + 1, ratio);
  return { ...node, children: (index === 0 ? [next, right] : [left, next]) as [LayoutNode, LayoutNode] };
}

/** 往第一个窗格追加一个标签，并把它设为活动标签。 */
export function addTab(layout: LayoutNode, tab: PaneTab): LayoutNode {
  return mapFirstPane(layout, (pane) => ({
    type: "pane",
    active: pane.tabs.length,
    tabs: [...pane.tabs, tab],
  }));
}

/** 把包含 tabId 的窗格的活动下标指向该标签（不存在则不变）。 */
export function activateTab(layout: LayoutNode, tabId: string): LayoutNode {
  return mapPanes(layout, (pane) => {
    const index = pane.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0 || index === pane.active) return pane;
    return { type: "pane", active: index, tabs: pane.tabs };
  });
}

function clampActive(pane: Extract<LayoutNode, { type: "pane" }>): Extract<LayoutNode, { type: "pane" }> {
  const max = Math.max(0, pane.tabs.length - 1);
  const active = pane.tabs.length === 0 ? 0 : Math.min(Math.max(0, pane.active), max);
  return active === pane.active ? pane : { type: "pane", active, tabs: pane.tabs };
}

/**
 * 折叠空窗格：split 的某个子是空窗格时，用另一个子替换整个 split；
 * 两个都空则塌缩成一个空窗格（保证根始终是合法 LayoutNode）。
 */
function pruneEmpty(node: LayoutNode): LayoutNode {
  if (node.type === "pane") return node;
  const [left, right] = node.children.map(pruneEmpty) as [LayoutNode, LayoutNode];
  const leftEmpty = left.type === "pane" && left.tabs.length === 0;
  const rightEmpty = right.type === "pane" && right.tabs.length === 0;
  if (leftEmpty && rightEmpty) return left;
  if (leftEmpty) return right;
  if (rightEmpty) return left;
  return { ...node, children: [left, right] };
}

/** 删除某标签；若其窗格因此变空，折叠掉对应的 split。 */
export function removeTab(layout: LayoutNode, tabId: string): LayoutNode {
  const next = mapPanes(layout, (pane) => {
    const index = pane.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return pane;
    return { type: "pane", active: pane.active, tabs: pane.tabs.filter((tab) => tab.id !== tabId) };
  });
  return pruneEmpty(mapPanes(next, (pane) => clampActive(pane)));
}

export function findLayoutTab(node: LayoutNode, tabId: string): PaneTab | undefined {
  if (node.type === "pane") return node.tabs.find((tab) => tab.id === tabId);
  return findLayoutTab(node.children[0], tabId) ?? findLayoutTab(node.children[1], tabId);
}

/**
 * 把 tabId 这个标签移动到「包含 anchorTabId 的窗格」（追加到末尾并激活）。
 * 对应 DnD「拖到另一个标签栏中心 = 作为新标签入栈」。origin 窗格若空则折叠。
 * tabId === anchorTabId 或任一缺失时原样返回。
 */
export function moveTab(layout: LayoutNode, tabId: string, anchorTabId: string): LayoutNode {
  if (tabId === anchorTabId) return layout;
  const moving = findLayoutTab(layout, tabId);
  if (!moving) return layout;
  if (!findLayoutTab(layout, anchorTabId)) return layout;

  // 1) 先从 origin 摘掉（不折叠），2) 再插入到 anchor 所在窗格。
  const detached = mapPanes(layout, (pane) => ({
    type: "pane" as const,
    active: pane.active,
    tabs: pane.tabs.filter((tab) => tab.id !== tabId),
  }));
  let inserted = mapPanes(detached, (pane) => {
    if (!pane.tabs.some((tab) => tab.id === anchorTabId)) return pane;
    const tabs = [...pane.tabs, moving];
    return { type: "pane" as const, active: tabs.length - 1, tabs };
  });
  inserted = mapPanes(inserted, (pane) => clampActive(pane));
  return pruneEmpty(inserted);
}
