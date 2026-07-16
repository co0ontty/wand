import type { QuickCommitOpenContext, QuickCommitRuntimeAdapter } from "./types";

export interface QuickCommitControllerSnapshot {
  open: boolean;
  dismissable: boolean;
  context: QuickCommitOpenContext | null;
  revision: number;
}

export interface WandQuickCommitController {
  open(context: QuickCommitOpenContext): boolean;
  close(): void;
  closeIfOpen(): boolean;
  closeTopmost(): boolean;
  isOpen(): boolean;
  setDismissable(dismissable: boolean): void;
}

type Listener = () => void;

let runtime: QuickCommitRuntimeAdapter | null = null;
let snapshot: QuickCommitControllerSnapshot = {
  open: false,
  dismissable: true,
  context: null,
  revision: 0,
};
const listeners = new Set<Listener>();

function publish(open: boolean, context: QuickCommitOpenContext | null): void {
  snapshot = { open, dismissable: true, context, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

function publishDismissable(dismissable: boolean): void {
  if (!snapshot.open || snapshot.dismissable === dismissable) return;
  snapshot = { ...snapshot, dismissable };
  for (const listener of listeners) listener();
}

export const quickCommitController: WandQuickCommitController = {
  open(context): boolean {
    const sessionId = context.sessionId.trim();
    if (!runtime || !sessionId) return false;
    if (snapshot.open && snapshot.context?.sessionId === sessionId) return true;
    const nextContext = { sessionId };
    runtime.onOpen(nextContext);
    publish(true, nextContext);
    return true;
  },

  close(): void {
    if (!snapshot.open || !snapshot.context) return;
    const context = snapshot.context;
    publish(false, null);
    runtime?.onClose(context);
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

export const quickCommitStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): QuickCommitControllerSnapshot {
    return snapshot;
  },

  getRuntime(): QuickCommitRuntimeAdapter | null {
    return runtime;
  },
};

export function configureQuickCommitRuntime(adapter: QuickCommitRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (snapshot.open) quickCommitController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactQuickCommit?: WandQuickCommitController;
  }
}
