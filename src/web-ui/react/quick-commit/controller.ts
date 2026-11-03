import { createDialogLifecycle, type DialogControls, type DialogLifecycle } from "../dialog-lifecycle";
import type { QuickCommitOpenContext, QuickCommitRuntimeAdapter } from "./types";

export interface QuickCommitControllerSnapshot extends DialogLifecycle {
  context: QuickCommitOpenContext | null;
}

export interface WandQuickCommitController extends DialogControls {
  open(context: QuickCommitOpenContext): boolean;
  isCurrentLifecycle(revision: number, sessionId: string): boolean;
}

let runtime: QuickCommitRuntimeAdapter | null = null;
const dialog = createDialogLifecycle<Omit<QuickCommitControllerSnapshot, keyof DialogLifecycle>>({
  context: null,
});

export const quickCommitController: WandQuickCommitController = {
  ...dialog.controls,
  open(context): boolean {
    const sessionId = context.sessionId.trim();
    if (!runtime || !sessionId) return false;
    if (dialog.snapshot.open && dialog.snapshot.context?.sessionId === sessionId) return true;
    const nextContext = { sessionId };
    runtime.onOpen(nextContext);
    dialog.publish(true, { context: nextContext });
    return true;
  },

  close(): void {
    if (!dialog.snapshot.open || !dialog.snapshot.context) return;
    const context = dialog.snapshot.context;
    dialog.publish(false, { context: null });
    runtime?.onClose(context);
  },

  isCurrentLifecycle(revision, sessionId): boolean {
    return dialog.snapshot.open
      && dialog.snapshot.revision === revision
      && dialog.snapshot.context?.sessionId === sessionId;
  },
};

export const quickCommitStore = {
  ...dialog.store,

  getRuntime(): QuickCommitRuntimeAdapter | null {
    return runtime;
  },
};

export function configureQuickCommitRuntime(adapter: QuickCommitRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (dialog.snapshot.open) quickCommitController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactQuickCommit?: WandQuickCommitController;
  }
}
