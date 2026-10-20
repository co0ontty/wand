import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeTaskChanges } from "../task-changes";
import { describeError } from "../errors";
import { httpWorkspacesRepository } from "./repository";
import { groupSessionsByArchive } from "./session-archive";
import { sidebarSafeError } from "./sidebar-safe-error";
import type { TaskDirectoryGroup, WorkspacesRepository } from "./types";

type Listener = () => void;
export interface TaskGroupsSnapshot {
  groups: TaskDirectoryGroup[];
  loading: boolean;
  error: string;
}

interface TaskGroupsStoreOptions {
  subscribeChanges?: (listener: Listener) => () => void;
  setInterval?: (listener: Listener, delay: number) => TaskGroupsTimer;
  clearInterval?: (timer: TaskGroupsTimer) => void;
}

type TaskGroupsTimer = number | ReturnType<typeof setInterval>;

const EMPTY: TaskGroupsSnapshot = { groups: [], loading: true, error: "" };

/** Sidebar, peek and standalone tabs share the server's directory projection and one poll. */
export function createTaskGroupsStore(
  repository: Pick<WorkspacesRepository, "listTaskGroups">,
  options: TaskGroupsStoreOptions = {},
) {
  const listeners = new Set<Listener>();
  const subscribeChanges = options.subscribeChanges ?? subscribeTaskChanges;
  const startInterval = options.setInterval ?? setInterval;
  const stopInterval = options.clearInterval ?? clearInterval;
  let snapshot = EMPTY;
  let revision: string | undefined;
  let generation = 0;
  let pending: Promise<void> | undefined;
  let dirty = false;
  let timer: TaskGroupsTimer | undefined;
  let unsubscribeChanges: (() => void) | undefined;

  function publish(next: TaskGroupsSnapshot): void {
    if (snapshot.groups === next.groups && snapshot.loading === next.loading && snapshot.error === next.error) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function load(invalidate: boolean): Promise<void> {
    if (pending) {
      // Mutations need a read begun after the mutation; ordinary polls just join the current read.
      if (invalidate) dirty = true;
      return pending;
    }
    const currentGeneration = generation;
    const operation = Promise.resolve().then(async () => {
      if (currentGeneration !== generation) return;
      do {
        dirty = false;
        try {
          const page = await repository.listTaskGroups(revision);
          if (currentGeneration !== generation) return;
          revision = page.revision ?? (page.unchanged ? revision : undefined);
          publish({
            groups: page.unchanged ? snapshot.groups : groupSessionsByArchive(page.groups),
            loading: true,
            error: "",
          });
        } catch (error) {
          if (currentGeneration !== generation) return;
          publish({ ...snapshot, error: sidebarSafeError(describeError(error, "无法加载任务列表。")) });
        }
      } while (dirty && currentGeneration === generation);
    }).finally(() => {
      if (currentGeneration !== generation || pending !== operation) return;
      pending = undefined;
      publish({ ...snapshot, loading: false });
    });
    pending = operation;
    publish({ ...snapshot, loading: true });
    return operation;
  }

  return {
    getSnapshot: (): TaskGroupsSnapshot => snapshot,
    getServerSnapshot: (): TaskGroupsSnapshot => EMPTY,
    reload: (): Promise<void> => load(true),
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeChanges = subscribeChanges(() => { void load(true); });
        timer = startInterval(() => { void load(false); }, 6_000);
        void load(false);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribeChanges?.();
        unsubscribeChanges = undefined;
        if (timer !== undefined) stopInterval(timer);
        timer = undefined;
        // A later subscriber (including a new login) must not receive an old read or cached directory.
        generation += 1;
        pending = undefined;
        dirty = false;
        revision = undefined;
        snapshot = EMPTY;
      };
    },
  };
}

export const taskGroupsStore = createTaskGroupsStore(httpWorkspacesRepository);

/** 空闲前返回的占位快照：必须是稳定引用，`useSyncExternalStore` 不能每次读到新对象。 */
const IDLE_TASK_GROUPS: TaskGroupsSnapshot = Object.freeze({ groups: [], loading: true, error: "" });

export function useTaskGroups(refreshKey = 0): TaskGroupsSnapshot & { reload: () => Promise<void> } {
  const snapshot = useSyncExternalStore(taskGroupsStore.subscribe, taskGroupsStore.getSnapshot, taskGroupsStore.getServerSnapshot);
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void taskGroupsStore.reload();
  }, [refreshKey]);
  return { ...snapshot, reload: taskGroupsStore.reload };
}

/**
 * 对话列表只用目录投影做私聊的会话归属与「活动」筛选，不是首屏主体。
 * 先让列表自己的读发出并落地，再在空闲时加入共享订阅：store 的第一位订阅者
 * 就是发起那份较重读取的人，所以推迟订阅而不是推迟渲染。
 * 工作区树可见时会用 `useTaskGroups` 立即读取同一份数据，这里只是晚一点接入。
 */
export function useTaskGroupsAfterIdle(): TaskGroupsSnapshot {
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    if (subscribed) return undefined;
    let cancelled = false;
    const start = (): void => { if (!cancelled) setSubscribed(true); };
    const idle = typeof window !== "undefined" && typeof window.requestIdleCallback === "function";
    const handle = idle
      ? window.requestIdleCallback(start, { timeout: 1_500 })
      : window.setTimeout(start, 0);
    return () => {
      cancelled = true;
      if (idle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [subscribed]);
  const subscribe = useCallback((listener: () => void) => (
    subscribed ? taskGroupsStore.subscribe(listener) : () => {}
  ), [subscribed]);
  const getSnapshot = useCallback(() => (
    subscribed ? taskGroupsStore.getSnapshot() : IDLE_TASK_GROUPS
  ), [subscribed]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
