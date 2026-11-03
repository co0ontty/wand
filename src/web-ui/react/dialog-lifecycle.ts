export interface DialogLifecycle {
  open: boolean;
  dismissable: boolean;
  revision: number;
}

export interface DialogControls {
  close(): void;
  closeIfOpen(): boolean;
  closeTopmost(): boolean;
  isOpen(): boolean;
  setDismissable(dismissable: boolean): void;
}

export function createDialogLifecycle<T extends object>(initial: T) {
  let snapshot = { ...initial, open: false, dismissable: true, revision: 0 };
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    get snapshot() { return snapshot; },
    store: {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(open: boolean, fields: T): void {
      snapshot = { ...fields, open, dismissable: true, revision: snapshot.revision + 1 };
      notify();
    },
    controls: {
      isOpen: () => snapshot.open,
      closeIfOpen(this: DialogControls): boolean {
        if (!snapshot.open || !snapshot.dismissable) return false;
        this.close();
        return true;
      },
      closeTopmost(this: DialogControls): boolean {
        if (!snapshot.open) return false;
        if (snapshot.dismissable) this.close();
        return true;
      },
      setDismissable(dismissable: boolean): void {
        if (!snapshot.open || snapshot.dismissable === dismissable) return;
        // A busy dialog keeps its revision so host initialization does not replay.
        snapshot = { ...snapshot, dismissable };
        notify();
      },
    },
  };
}
