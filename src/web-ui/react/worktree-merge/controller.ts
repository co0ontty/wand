import type { WorktreeMergeOpenContext, WorktreeMergeRuntimeAdapter } from "./types";

export interface WorktreeMergeControllerSnapshot {
  open: boolean;
  dismissable: boolean;
  context: WorktreeMergeOpenContext | null;
  revision: number;
}

export interface WandWorktreeMergeController {
  open(context: WorktreeMergeOpenContext): boolean;
  close(): void;
  closeIfOpen(): boolean;
  closeTopmost(): boolean;
  isOpen(): boolean;
  setDismissable(dismissable: boolean): void;
}

type Listener = () => void;

let runtime: WorktreeMergeRuntimeAdapter | null = null;
let snapshot: WorktreeMergeControllerSnapshot = {
  open: false,
  dismissable: true,
  context: null,
  revision: 0,
};
const listeners = new Set<Listener>();

function publish(open: boolean, context: WorktreeMergeOpenContext | null): void {
  snapshot = { open, dismissable: true, context, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

function publishDismissable(dismissable: boolean): void {
  if (!snapshot.open || snapshot.dismissable === dismissable) return;
  snapshot = { ...snapshot, dismissable };
  for (const listener of listeners) listener();
}

export const worktreeMergeController: WandWorktreeMergeController = {
  open(context): boolean {
    const sessionId = context.sessionId.trim();
    if (!sessionId) return false;
    const nextContext = { ...context, sessionId };
    if (
      snapshot.open
      && snapshot.context?.sessionId === sessionId
      && snapshot.context.intent === nextContext.intent
    ) return true;
    runtime?.onOpen(nextContext);
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

export const worktreeMergeStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): WorktreeMergeControllerSnapshot {
    return snapshot;
  },

  getRuntime(): WorktreeMergeRuntimeAdapter | null {
    return runtime;
  },
};

export function configureWorktreeMergeRuntime(adapter: WorktreeMergeRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (snapshot.open) worktreeMergeController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactWorktreeMerge?: WandWorktreeMergeController;
  }
}
