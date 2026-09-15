import type { LayoutNode } from "./types.js";

/**
 * 取布局树中最左上角可用的 tab id：pane 优先用它记住的 active，
 * 否则取第一个 tab；split 递归左侧再右侧。
 */
export function firstLayoutTabId(node: LayoutNode): string | undefined {
  if (node.type === "pane") return node.tabs[node.active]?.id ?? node.tabs[0]?.id;
  return firstLayoutTabId(node.children[0]) ?? firstLayoutTabId(node.children[1]);
}
