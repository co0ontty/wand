import { createDialogLifecycle, type DialogControls, type DialogLifecycle } from "../dialog-lifecycle";
import type { FolderPickerRuntimeAdapter } from "./types";

export interface FolderPickerControllerSnapshot extends DialogLifecycle {
  initialPath: string;
}

export interface WandFolderPickerController extends DialogControls {
  open(initialPath?: string): boolean;
  choose(path: string): Promise<boolean>;
}

let runtime: FolderPickerRuntimeAdapter | null = null;
const dialog = createDialogLifecycle<Omit<FolderPickerControllerSnapshot, keyof DialogLifecycle>>({
  initialPath: "",
});

export const folderPickerController: WandFolderPickerController = {
  ...dialog.controls,
  open(initialPath?: string): boolean {
    if (!runtime) return false;
    const resolved = (initialPath ?? runtime.getInitialPath()).trim();
    if (!resolved) return false;
    runtime.onOpen?.();
    dialog.publish(true, { initialPath: resolved });
    return true;
  },

  close(): void {
    if (!dialog.snapshot.open) return;
    dialog.publish(false, { initialPath: dialog.snapshot.initialPath });
    runtime?.onClose?.();
  },

  async choose(path: string): Promise<boolean> {
    const selectedPath = path.trim();
    const activeRuntime = runtime;
    if (!dialog.snapshot.open || !activeRuntime || !selectedPath) return false;
    await activeRuntime.applySelection(selectedPath);
    this.close();
    return true;
  },
};

export const folderPickerStore = dialog.store;

export function configureFolderPickerRuntime(adapter: FolderPickerRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (dialog.snapshot.open) folderPickerController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactFolderPicker?: WandFolderPickerController;
  }
}
