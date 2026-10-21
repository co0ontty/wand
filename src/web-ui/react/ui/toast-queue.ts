/**
 * Toast 队列：与 antd 解耦的小型状态层。
 *
 * 队列独立于渲染层，所以普通浏览器模块可以在 React 区域挂载前先排队反馈；
 * 真正的 antd notification 实现只在真的出现 toast 时才下载。
 */
export type WandToastTone = "info" | "success" | "warning" | "error";
export interface WandToastOptions { description?: string; tone?: WandToastTone; duration?: number; }
export interface WandToastHandle { readonly id: string; dismiss(): void; }

export type ToastEntry = { id: string; message: string; options: WandToastOptions; expiresAt: number | null };

const queue = new Map<string, ToastEntry>();
const listeners = new Set<() => void>();
let serial = 0;

const notify = (): void => { for (const listener of listeners) listener(); };

/** 订阅队列变化；返回取消订阅函数。 */
export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToastEntries(): ToastEntry[] {
  return [...queue.values()];
}

/** 展示完成或过期后从队列移除，避免同一条反馈被再次弹出。 */
export function dismissToast(id: string): void {
  if (!queue.delete(id)) return;
  notify();
}

/** Plain browser modules may queue feedback before the React region mounts. */
export function showWandToast(message: string, options: WandToastOptions = {}): WandToastHandle {
  for (const [key, toast] of queue) if (toast.expiresAt !== null && toast.expiresAt <= Date.now()) queue.delete(key);
  while (queue.size >= 20) queue.delete(queue.keys().next().value!);
  const id = `wand-toast-${++serial}`;
  const duration = options.duration ?? 3200;
  queue.set(id, { id, message, options, expiresAt: duration > 0 ? Date.now() + duration : null });
  notify();
  return { id, dismiss() { queue.delete(id); notify(); } };
}
