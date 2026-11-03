import { createDialogLifecycle, type DialogControls, type DialogLifecycle } from "../dialog-lifecycle";
import type { WorktreeMergeOpenContext, WorktreeMergeRuntimeAdapter } from "./types";

export interface WorktreeMergeControllerSnapshot extends DialogLifecycle {
  context: WorktreeMergeOpenContext | null;
}

export interface WandWorktreeMergeController extends DialogControls {
  open(context: WorktreeMergeOpenContext): boolean;
}

let runtime: WorktreeMergeRuntimeAdapter | null = null;
const dialog = createDialogLifecycle<Omit<WorktreeMergeControllerSnapshot, keyof DialogLifecycle>>({
  context: null,
});

export const worktreeMergeController: WandWorktreeMergeController = {
  ...dialog.controls,
  open(context): boolean {
    const sessionId = context.sessionId.trim();
    if (!sessionId) return false;
    const nextContext = { ...context, sessionId };
    if (
      dialog.snapshot.open
      && dialog.snapshot.context?.sessionId === sessionId
      && dialog.snapshot.context.intent === nextContext.intent
    ) return true;
    runtime?.onOpen(nextContext);
    dialog.publish(true, { context: nextContext });
    return true;
  },

  close(): void {
    if (!dialog.snapshot.open || !dialog.snapshot.context) return;
    const context = dialog.snapshot.context;
    dialog.publish(false, { context: null });
    runtime?.onClose(context);
  },
};

export const worktreeMergeStore = {
  ...dialog.store,

  getRuntime(): WorktreeMergeRuntimeAdapter | null {
    return runtime;
  },
};

export function configureWorktreeMergeRuntime(adapter: WorktreeMergeRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (dialog.snapshot.open) worktreeMergeController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactWorktreeMerge?: WandWorktreeMergeController;
  }
}
