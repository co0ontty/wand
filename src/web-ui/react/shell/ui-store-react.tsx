import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { UiAction, UiSnapshot, UiStore } from "./ui-store";

const UiStoreContext = createContext<UiStore | null>(null);

export interface UiStoreProviderProps {
  store: UiStore;
  children: ReactNode;
}

/**
 * The exact external-store surface consumed by React. Exporting this small
 * adapter keeps the subscription contract testable without a browser DOM.
 */
export interface UiStoreExternalSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): UiSnapshot;
}

export function createUiStoreExternalSource(store: UiStore): UiStoreExternalSource {
  return {
    subscribe: (listener) => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
  };
}

export function UiStoreProvider({ store, children }: UiStoreProviderProps) {
  return createElement(UiStoreContext.Provider, { value: store }, children);
}

export function useUiStore(): UiStore {
  const store = useContext(UiStoreContext);
  if (!store) {
    throw new Error("useUiStore must be used inside UiStoreProvider");
  }
  return store;
}

/** Subscribe to the cached shell snapshot using React's concurrency-safe API. */
export function useUiStoreSnapshot(): UiSnapshot {
  const store = useUiStore();
  const source = useMemo(() => createUiStoreExternalSource(store), [store]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

export function useUiDispatch(): (action: UiAction) => void | Promise<unknown> {
  const store = useUiStore();
  return useCallback((action: UiAction) => store.dispatch(action), [store]);
}
