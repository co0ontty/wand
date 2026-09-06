import type { ShellView } from "./shell-navigation-types";

export type { ShellView } from "./shell-navigation-types";

let view: ShellView = "tasks";
const listeners = new Set<() => void>();

export const shellNavigationStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ShellView {
    return view;
  },
  setView(next: ShellView): void {
    if (view === next) return;
    view = next;
    for (const listener of listeners) listener();
  },
};
