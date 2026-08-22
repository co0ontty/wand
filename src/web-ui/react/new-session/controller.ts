import type { NewSessionRuntimeAdapter } from "./types";

export interface NewSessionControllerSnapshot {
  open: boolean;
  dismissable: boolean;
  initialCwd: string;
  revision: number;
}

interface NewSessionOpenOptions {
  initialCwd?: string;
}

export interface WandNewSessionController {
  open(options?: NewSessionOpenOptions): boolean;
  close(): void;
  closeIfOpen(): boolean;
  closeTopmost(): boolean;
  isOpen(): boolean;
  setDismissable(dismissable: boolean): void;
}

type Listener = () => void;

let runtime: NewSessionRuntimeAdapter | null = null;
let snapshot: NewSessionControllerSnapshot = {
  open: false,
  dismissable: true,
  initialCwd: "",
  revision: 0,
};
const listeners = new Set<Listener>();

function publish(open: boolean, initialCwd = ""): void {
  snapshot = {
    open,
    dismissable: true,
    initialCwd: open ? initialCwd.trim() : "",
    revision: snapshot.revision + 1,
  };
  for (const listener of listeners) listener();
}

function publishDismissable(dismissable: boolean): void {
  if (!snapshot.open || snapshot.dismissable === dismissable) return;
  // Dismissability is transient operation state, not a new open lifecycle.
  // Keep revision stable so Host initialization effects are not replayed.
  snapshot = { ...snapshot, dismissable };
  for (const listener of listeners) listener();
}

export const newSessionController: WandNewSessionController = {
  open(options = {}): boolean {
    if (!runtime) return false;
    runtime.onOpen();
    publish(true, options.initialCwd);
    return true;
  },

  close(): void {
    if (!snapshot.open) return;
    publish(false);
    runtime?.onClose();
  },

  closeIfOpen(): boolean {
    if (!snapshot.open || !snapshot.dismissable) return false;
    this.close();
    return true;
  },

  closeTopmost(): boolean {
    if (!snapshot.open) return false;
    if (snapshot.dismissable) this.close();
    return true;
  },

  isOpen(): boolean {
    return snapshot.open;
  },

  setDismissable(dismissable): void {
    publishDismissable(dismissable);
  },
};

export const newSessionStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): NewSessionControllerSnapshot {
    return snapshot;
  },

  getRuntime(): NewSessionRuntimeAdapter | null {
    return runtime;
  },
};

export function configureNewSessionRuntime(adapter: NewSessionRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (snapshot.open) newSessionController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactNewSession?: WandNewSessionController;
  }
}
