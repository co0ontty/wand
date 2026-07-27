import type { WandButtonKind, WandDialogTone, WandToastTone } from "./ui";

export interface OverlayDialogAction<T> {
  label: string;
  value: T;
  kind?: WandButtonKind;
  autoFocus?: boolean;
}

export interface OverlayDialogOptions<T> {
  title: string;
  description?: string;
  tone?: WandDialogTone;
  icon?: string;
  actions: ReadonlyArray<OverlayDialogAction<T>>;
  input?: {
    value?: string;
    placeholder?: string;
    label?: string;
  };
  dismissable?: boolean;
}

export type OverlayDialogResult<T> =
  | { dismissed: true }
  | { dismissed: false; action: T; inputValue?: string };

export interface OverlayToastOptions {
  description?: string;
  tone?: WandToastTone;
  duration?: number;
}

export interface OverlayToastHandle {
  readonly id: number;
  dismiss(): void;
}

/**
 * External seam for all React-owned overlays. Callers learn two operations;
 * Radix lifecycle, focus handling, portals, queueing, and rendering stay behind
 * the module.
 */
export interface WandOverlay {
  dialog<T>(options: OverlayDialogOptions<T>): Promise<OverlayDialogResult<T>>;
  toast(message: string, options?: OverlayToastOptions): OverlayToastHandle;
  /** Dismisses the active dialog when its contract permits dismissal. */
  closeTopmost(): boolean;
}

interface DialogEntry {
  id: number;
  options: OverlayDialogOptions<unknown>;
  resolve(result: OverlayDialogResult<unknown>): void;
}

export interface ToastEntry {
  id: number;
  message: string;
  options: OverlayToastOptions;
  open: boolean;
}

export interface OverlaySnapshot {
  activeDialog: DialogEntry | null;
  toasts: ReadonlyArray<ToastEntry>;
}

type Listener = () => void;

let nextId = 0;
let dialogQueue: DialogEntry[] = [];
let toasts: ToastEntry[] = [];
let snapshot: OverlaySnapshot = { activeDialog: null, toasts: [] };
const listeners = new Set<Listener>();

function publish(): void {
  snapshot = {
    activeDialog: dialogQueue[0] ?? null,
    toasts: [...toasts],
  };
  for (const listener of listeners) listener();
}

function dismissToast(id: number): void {
  const entry = toasts.find((toast) => toast.id === id);
  if (!entry || !entry.open) return;
  toasts = toasts.map((toast) => toast.id === id ? { ...toast, open: false } : toast);
  publish();
  window.setTimeout(() => {
    toasts = toasts.filter((toast) => toast.id !== id);
    publish();
  }, 180);
}

export const wandOverlay: WandOverlay = {
  dialog<T>(options: OverlayDialogOptions<T>): Promise<OverlayDialogResult<T>> {
    const id = ++nextId;
    return new Promise((resolve) => {
      dialogQueue = [
        ...dialogQueue,
        {
          id,
          options: options as OverlayDialogOptions<unknown>,
          resolve: resolve as (result: OverlayDialogResult<unknown>) => void,
        },
      ];
      publish();
    });
  },

  toast(message: string, options: OverlayToastOptions = {}): OverlayToastHandle {
    const id = ++nextId;
    toasts = [...toasts, { id, message, options, open: true }];
    publish();
    return { id, dismiss: () => dismissToast(id) };
  },

  closeTopmost(): boolean {
    const entry = dialogQueue[0];
    if (!entry || entry.options.dismissable === false) return false;
    overlayStore.completeDialog(entry.id, { dismissed: true });
    return true;
  },
};

export const overlayStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): OverlaySnapshot {
    return snapshot;
  },

  completeDialog(
    id: number,
    result: OverlayDialogResult<unknown>,
  ): void {
    const entry = dialogQueue.find((dialog) => dialog.id === id);
    if (!entry) return;
    dialogQueue = dialogQueue.filter((dialog) => dialog.id !== id);
    publish();
    entry.resolve(result);
  },

  dismissToast,
};
