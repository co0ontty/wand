import { showWandToast, type WandButtonKind, type WandDialogTone, type WandToastTone } from "./ui";
import * as React from "react";

interface OverlayDialogAction<T> {
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

interface OverlayToastHandle {
  readonly id: string;
  dismiss(): void;
}

/**
 * External seam for all React-owned overlays. Callers learn two operations;
 * Base UI lifecycle, focus handling, portals, queueing, and rendering stay
 * behind the module.
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

export interface OverlaySnapshot {
  activeDialog: DialogEntry | null;
}

type Listener = () => void;

let nextId = 0;
let dialogQueue: DialogEntry[] = [];
let snapshot: OverlaySnapshot = { activeDialog: null };
const listeners = new Set<Listener>();

function publish(): void {
  snapshot = { activeDialog: dialogQueue[0] ?? null };
  for (const listener of listeners) listener();
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
    // Toast lifecycle (stacking, timers, swipe) lives in Appica's toast manager,
    // not in the overlay snapshot, so publishing here would be pointless churn.
    return showWandToast(message, options);
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
};
