import type { MissionsRuntimeAdapter } from "./types";

export interface MissionsControllerSnapshot {
  open: boolean;
  revision: number;
}

type Listener = () => void;
let snapshot: MissionsControllerSnapshot = { open: false, revision: 0 };
let runtime: MissionsRuntimeAdapter | null = null;
const listeners = new Set<Listener>();

function publish(open: boolean): void {
  snapshot = { open, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

export const missionsController = {
  open(): boolean {
    runtime?.onOpen();
    publish(true);
    return true;
  },
  close(): void {
    if (!snapshot.open) return;
    publish(false);
    runtime?.onClose();
  },
  closeIfOpen(): boolean {
    if (!snapshot.open) return true;
    this.close();
    return true;
  },
  isOpen(): boolean { return snapshot.open; },
};

export const missionsStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): MissionsControllerSnapshot { return snapshot; },
  getRuntime(): MissionsRuntimeAdapter | null { return runtime; },
};

export function configureMissionsRuntime(adapter: MissionsRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactMissions?: typeof missionsController;
  }
}
