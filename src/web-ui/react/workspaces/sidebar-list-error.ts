/**
 * 侧栏任务列表的两条报错（首次加载失败 / 列表未同步）不在列表里占位，
 * 只在品牌区右侧的徽标里出现。这里是从任务树（写入方）到侧栏头部（读取方）的通道。
 */
export type SidebarListErrorKind = "load" | "sync";

export interface SidebarListError {
  readonly kind: SidebarListErrorKind;
  readonly message: string;
  readonly retry: () => Promise<unknown>;
}

type Listener = () => void;

let snapshot: SidebarListError | null = null;
const listeners = new Set<Listener>();

export function reportSidebarListError(next: SidebarListError | null): void {
  if (snapshot && next && snapshot.kind === next.kind && snapshot.message === next.message) {
    // 轮询每 6s 重新上报同一条报错：留住原引用，徽标不重挂载（reload 本身是稳定回调）。
    return;
  }
  if (snapshot === null && next === null) return;
  snapshot = next ? { ...next } : null;
  listeners.forEach((listener) => listener());
}

export function getSidebarListError(): SidebarListError | null {
  return snapshot;
}

export function subscribeSidebarListError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
