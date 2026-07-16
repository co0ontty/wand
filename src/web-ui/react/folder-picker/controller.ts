import type { FolderPickerRuntimeAdapter } from "./types";

export interface FolderPickerControllerSnapshot {
  open: boolean;
  dismissable: boolean;
  initialPath: string;
  revision: number;
}

export interface WandFolderPickerController {
  open(initialPath?: string): boolean;
  close(): void;
  closeIfOpen(): boolean;
  closeTopmost(): boolean;
  isOpen(): boolean;
  setDismissable(dismissable: boolean): void;
  choose(path: string): Promise<boolean>;
}

type Listener = () => void;

let runtime: FolderPickerRuntimeAdapter | null = null;
let snapshot: FolderPickerControllerSnapshot = {
  open: false,
  dismissable: true,
  initialPath: "",
  revision: 0,
};
const listeners = new Set<Listener>();

function publish(open: boolean, initialPath = snapshot.initialPath): void {
  snapshot = { open, dismissable: true, initialPath, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

function publishDismissable(dismissable: boolean): void {
  if (!snapshot.open || snapshot.dismissable === dismissable) return;
  snapshot = { ...snapshot, dismissable };
  for (const listener of listeners) listener();
}

export const folderPickerController: WandFolderPickerController = {
  open(initialPath?: string): boolean {
    if (!runtime) return false;
    const resolved = (initialPath ?? runtime.getInitialPath()).trim();
    if (!resolved) return false;
    runtime.onOpen?.();
    publish(true, resolved);
    return true;
  },

  close(): void {
    if (!snapshot.open) return;
    publish(false);
    runtime?.onClose?.();
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

  async choose(path: string): Promise<boolean> {
    const selectedPath = path.trim();
    const activeRuntime = runtime;
    if (!snapshot.open || !activeRuntime || !selectedPath) return false;
    await activeRuntime.applySelection(selectedPath);
    this.close();
    return true;
  },
};

export const folderPickerStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): FolderPickerControllerSnapshot {
    return snapshot;
  },
};

export function configureFolderPickerRuntime(adapter: FolderPickerRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (snapshot.open) folderPickerController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactFolderPicker?: WandFolderPickerController;
  }
}
