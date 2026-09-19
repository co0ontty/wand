// 跨会话排队条插入位置的锚点解析。
//
// 背景：`renderCrossSessionQueue()` 用 `parent.insertBefore(container, refNode)` 把排队条
// 插到「状态栏 / 输入框」之前。但 `insertBefore` 要求 refNode 是 parent 的**直接子节点**，
// 而这两者在 React shell 里都埋在更深层：
//
//   .input-panel
//     ├─ .composer-top-row          ← .structured-status-bar 在这里
//     ├─ #queue-bar-host
//     └─ .input-composer-row
//          └─ .input-composer       ← 输入框在这里
//
// 只要队列里还剩 ≥1 条（不是刚好排空），渲染就会走 insertBefore 分支并抛
// NotFoundError。更糟的是 `flushCrossSessionQueue()` 是「先 shift + persist 出队、
// 再渲染、最后才 launchQueueItem」，异常一路抛到 loadSessions 的 promise 链里被当成
// 普通错误吞掉 —— 已经出队并落盘消失的消息**再也不会被发送**。队列 3 条时只有最后
// 一条能活下来，前面的依次蒸发。
//
// 所以这里只做一件事：把任意候选节点上溯成 parent 的直接子节点；解析不出来就返回
// null，让调用方退回 append，而不是把错节点丢给 insertBefore。

export interface DomNodeLike {
  parentNode: DomNodeLike | null;
}

/**
 * 把 node 上溯成 parent 的直接子节点；node 不在 parent 子树内时返回 null。
 *
 * 泛型只用来把调用方的具体节点类型（真实 DOM 里的 Element）原样带回去，让
 * `parent.insertBefore(container, anchor)` 不需要 cast —— 返回的始终是 node 的祖先，
 * 在真实 DOM 里与 node 同型。
 */
export function directChildAnchor<T extends DomNodeLike>(
  parent: DomNodeLike | null | undefined,
  node: T | null | undefined,
): T | null {
  if (!parent || !node) return null;
  var current: DomNodeLike | null = node;
  while (current && current.parentNode && current.parentNode !== parent) {
    current = current.parentNode;
  }
  if (!current || current.parentNode !== parent) return null;
  return current as T;
}

/**
 * 依次尝试候选节点，返回第一个能当作 parent 直接子节点锚点的祖先。
 * 返回 null 表示没有安全锚点，调用方应当 append。
 */
export function resolveInsertBeforeAnchor<T extends DomNodeLike>(
  parent: DomNodeLike | null | undefined,
  candidates: ReadonlyArray<T | null | undefined>,
): T | null {
  if (!parent) return null;
  for (var i = 0; i < candidates.length; i++) {
    var anchor = directChildAnchor(parent, candidates[i]);
    if (anchor) return anchor;
  }
  return null;
}
