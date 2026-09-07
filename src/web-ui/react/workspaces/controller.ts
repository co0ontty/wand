import type { WorkspacesRuntimeAdapter } from "./types";

export type WorkspaceCreationKind = "project" | "task";

export interface WorkspacesControllerSnapshot {
  open: boolean;
  dismissable: boolean;
  /** 对话框打开时预填的项目目录（如从某目录「在此新建任务」触发）。 */
  initialCwd: string;
  /** 打开对话框时的创建分类；任务可以从任意目录入口独立创建。 */
  initialKind: WorkspaceCreationKind;
  revision: number;
}

type Listener = () => void;

let runtime: WorkspacesRuntimeAdapter | null = null;
let snapshot: WorkspacesControllerSnapshot = {
  open: false,
  dismissable: true,
  initialCwd: "",
  initialKind: "task",
  revision: 0,
};
const listeners = new Set<Listener>();

function publish(next: Partial<WorkspacesControllerSnapshot>): void {
  snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

export interface WandWorkspacesController {
  open(initialCwd?: string, kind?: WorkspaceCreationKind): boolean;
  close(): void;
  closeIfOpen(): boolean;
  isOpen(): boolean;
  setDismissable(dismissable: boolean): void;
}

export const workspacesController: WandWorkspacesController = {
  open(initialCwd?: string, kind: WorkspaceCreationKind = "task"): boolean {
    runtime?.onOpen();
    publish({ open: true, dismissable: true, initialCwd: initialCwd ?? "", initialKind: kind });
    return true;
  },
  close(): void {
    if (!snapshot.open) return;
    publish({ open: false });
    runtime?.onClose();
  },
  closeIfOpen(): boolean {
    if (!snapshot.open || !snapshot.dismissable) return false;
    this.close();
    return true;
  },
  isOpen(): boolean {
    return snapshot.open;
  },
  setDismissable(dismissable): void {
    if (!snapshot.open || snapshot.dismissable === dismissable) return;
    publish({ dismissable });
  },
};

export const workspacesStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): WorkspacesControllerSnapshot {
    return snapshot;
  },
  getRuntime(): WorkspacesRuntimeAdapter | null {
    return runtime;
  },
};

export function configureWorkspacesRuntime(adapter: WorkspacesRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (snapshot.open) workspacesController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactWorkspaces?: WandWorkspacesController;
  }
}
