import type { SettingsTab } from "./types";

export type SettingsNestedView = "environment" | null;

export interface SettingsControllerSnapshot {
  open: boolean;
  tab: SettingsTab;
  nested: SettingsNestedView;
  detail: boolean;
  revision: number;
}

export interface WandSettingsController {
  open(tab?: SettingsTab): void;
  close(): void;
  closeTopmost(): boolean;
  closeIfOpen(): boolean;
  isOpen(): boolean;
}

type Listener = () => void;

let snapshot: SettingsControllerSnapshot = {
  open: false,
  tab: "profile",
  nested: null,
  detail: false,
  revision: 0,
};

const listeners = new Set<Listener>();
let compact = false;

function publish(next: Omit<SettingsControllerSnapshot, "revision">): void {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

export const settingsController: WandSettingsController = {
  open(tab): void {
    publish({ open: true, tab: tab ?? "profile", nested: null, detail: tab !== undefined });
  },

  close(): void {
    if (!snapshot.open && snapshot.nested === null) return;
    publish({ ...snapshot, open: false, nested: null, detail: false });
  },

  closeTopmost(): boolean {
    if (snapshot.nested !== null) {
      publish({ ...snapshot, nested: null });
      return true;
    }
    if (snapshot.open && snapshot.detail && compact) {
      settingsStore.showDirectory();
      return true;
    }
    return this.closeIfOpen();
  },

  closeIfOpen(): boolean {
    if (!snapshot.open) return false;
    this.close();
    return true;
  },

  isOpen(): boolean {
    return snapshot.open;
  },
};

export const settingsStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): SettingsControllerSnapshot {
    return snapshot;
  },

  setTab(tab: SettingsTab): void {
    if (snapshot.tab === tab && snapshot.detail) return;
    publish({ ...snapshot, tab, detail: true });
  },

  showDirectory(): void {
    if (!snapshot.detail) return;
    publish({ ...snapshot, detail: false, nested: null });
  },

  setCompact(value: boolean): void { compact = value; },

  setNested(nested: SettingsNestedView): void {
    if (snapshot.nested === nested) return;
    publish({ ...snapshot, nested });
  },
};

declare global {
  interface Window {
    __wandReactSettings?: WandSettingsController;
  }
}
