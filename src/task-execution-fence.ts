import type { WandStorage } from "./storage.js";
export interface TaskStatusChangeReceipt {
  requestId: string; status: string; state: "stopping" | "completed" | "failed"; requestedAt: string;
  stoppedSessions: number; cancelledDispatches: number; error?: string;
}
export const taskStatusChangeKey = (id: string) => `pref:taskStatusChange:${id}`;
export const taskStatusChangeReceipt = (storage: WandStorage, id: string) => storage.getPreference<TaskStatusChangeReceipt | null>(taskStatusChangeKey(id), null);
export function taskDispatchFence(storage: WandStorage, id: string): { epoch: string; blocked: boolean; requestedAt: string } {
  const seen = new Set<string>(), epochs: string[] = []; let cursor: string | null = id, blocked = false, requestedAt = "";
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor); const change = taskStatusChangeReceipt(storage, cursor);
    if (change) { epochs.push(change.requestId); if (change.requestedAt > requestedAt) requestedAt = change.requestedAt; blocked ||= change.state !== "completed"; }
    cursor = storage.getWandTask(cursor)?.parentTaskId ?? null;
  }
  return { epoch: epochs.join(":"), blocked, requestedAt };
}
const active = new WeakMap<WandStorage, Map<string, Set<Promise<unknown>>>>();
export function trackTaskDispatch<T>(storage: WandStorage, id: string, run: () => Promise<T>): Promise<T> {
  let tasks = active.get(storage); if (!tasks) { tasks = new Map(); active.set(storage, tasks); }
  const pending = tasks.get(id) ?? new Set(); tasks.set(id, pending);
  const promise = run(); pending.add(promise);
  void promise.finally(() => { pending.delete(promise); if (!pending.size) tasks!.delete(id); }).catch(() => {});
  return promise;
}
export async function waitForTaskDispatches(storage: WandStorage, ids: readonly string[]): Promise<void> {
  const pending = ids.flatMap(id => [...(active.get(storage)?.get(id) ?? [])]);
  if (!pending.length) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.allSettled(pending), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("仍有启动请求未确认结束，状态未修改；请稍后重试。")), 30_000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}
