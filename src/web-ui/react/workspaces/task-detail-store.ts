import { useCallback, useSyncExternalStore } from "react";
import { httpWorkspacesRepository } from "./repository";
import type { WorkspaceTaskDetail, WorkspacesRepository } from "./types";

type Listener = () => void;
interface TaskEntry {
  detail: WorkspaceTaskDetail | null;
  listeners: Set<Listener>;
  pending?: Promise<WorkspaceTaskDetail>;
  timer?: ReturnType<typeof setInterval>;
}

/** One task-scoped poll shared by tab and split views; no cache outlives its subscribers. */
export function createTaskDetailStore(repository: Pick<WorkspacesRepository, "getTask">) {
  const entries = new Map<string, TaskEntry>();
  function entryFor(taskId: string): TaskEntry {
    let entry = entries.get(taskId);
    if (!entry) {
      entry = { detail: null, listeners: new Set() };
      entries.set(taskId, entry);
    }
    return entry;
  }
  function load(taskId: string): Promise<WorkspaceTaskDetail> {
    const entry = entryFor(taskId);
    if (entry.pending) return entry.pending;
    const pending = repository.getTask(taskId).then((detail) => {
      if (detail.id !== taskId) throw new Error("任务详情与请求不匹配。");
      if (entries.get(taskId) === entry && entry.pending === pending) {
        entry.detail = detail;
        for (const listener of entry.listeners) listener();
      }
      return detail;
    }).finally(() => {
      if (entry.pending !== pending) return;
      entry.pending = undefined;
      if (entry.listeners.size === 0 && entries.get(taskId) === entry) entries.delete(taskId);
    });
    entry.pending = pending;
    return pending;
  }
  return {
    load,
    reload(taskId: string): Promise<WorkspaceTaskDetail> {
      // A mutation needs a read started after it, not a pre-mutation in-flight poll.
      entryFor(taskId).pending = undefined;
      return load(taskId);
    },
    getSnapshot(taskId: string | null): WorkspaceTaskDetail | null {
      return taskId ? entries.get(taskId)?.detail ?? null : null;
    },
    subscribe(taskId: string | null, listener: Listener): () => void {
      if (!taskId) return () => {};
      const entry = entryFor(taskId);
      entry.listeners.add(listener);
      if (!entry.timer) {
        void load(taskId).catch(() => { /* Keep only this task's last successful detail. */ });
        entry.timer = setInterval(() => void load(taskId).catch(() => {}), 4_000);
      }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        clearInterval(entry.timer);
        if (entries.get(taskId) === entry) entries.delete(taskId);
      };
    },
  };
}

export const taskDetailStore = createTaskDetailStore(httpWorkspacesRepository);

export function useTaskDetail(taskId: string | null): WorkspaceTaskDetail | null {
  const subscribe = useCallback((listener: Listener) => taskDetailStore.subscribe(taskId, listener), [taskId]);
  const getSnapshot = useCallback(() => taskDetailStore.getSnapshot(taskId), [taskId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
