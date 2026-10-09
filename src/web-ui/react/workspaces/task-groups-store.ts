import { useEffect, useRef, useSyncExternalStore } from "react";
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
