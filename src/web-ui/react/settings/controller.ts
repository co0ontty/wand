import type { SettingsTab } from "./types";

export type SettingsNestedView = "environment" | "qr" | null;

export interface SettingsControllerSnapshot {
  open: boolean;
  tab: SettingsTab;
  nested: SettingsNestedView;
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
  tab: "general",
  nested: null,
  revision: 0,
};

const listeners = new Set<Listener>();

function publish(next: Omit<SettingsControllerSnapshot, "revision">): void {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

export const settingsController: WandSettingsController = {
  open(tab = "general"): void {
    publish({ open: true, tab, nested: null });
  },

  close(): void {
    if (!snapshot.open && snapshot.nested === null) return;
    publish({ open: false, tab: "general", nested: null });
  },

  closeTopmost(): boolean {
    if (snapshot.nested !== null) {
      publish({ ...snapshot, nested: null });
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
    if (snapshot.tab === tab) return;
    publish({ ...snapshot, tab });
  },

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
