import type { Workspace, WorkspacesRuntimeAdapter } from "./types";
import { newSessionController } from "../new-session/controller";

export type WorkspaceCreationKind = "project" | "task";

export interface WorkspacesControllerSnapshot {
  open: boolean;
  dismissable: boolean;
  /** 对话框打开时预填的项目目录（如从某目录「在此新建任务」触发）。 */
  initialCwd: string;
  /** 打开对话框时的创建分类；任务可以从任意目录入口独立创建。 */
  initialKind: WorkspaceCreationKind;
  popupOwner?: string;
  revision: number;
  addRevision?: number;
}

type Listener = () => void;

let runtime: WorkspacesRuntimeAdapter | null = null;
let createdCallback: ((workspace: Workspace) => void) | undefined;
let addWorkspaceRevision = 0;
export function requestAddWorkspace(initialCwd: string, onCreated?: (workspace: Workspace) => void, popupOwner?: string): void {
  createdCallback = onCreated;
  publish({ open: true, dismissable: true, initialCwd, initialKind: "project", popupOwner, addRevision: ++addWorkspaceRevision });
}
export function completeAddWorkspace(workspace: Workspace): void {
  const callback = createdCallback;
  createdCallback = undefined;
  publish({ open: false });
  callback?.(workspace);
}
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

function publishDismissable(dismissable: boolean): void {
  if (!snapshot.open || snapshot.dismissable === dismissable) return;
  // Dismissability is transient operation state, not a new open lifecycle.
  // Keep revision stable so Host initialization effects are not replayed —
  // otherwise submitting would wipe the form (including the picked directory)
  // and re-enable the button while the create request is still in flight.
  snapshot = { ...snapshot, dismissable };
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
    if (kind === "project") { requestAddWorkspace(initialCwd ?? ""); return true; }
    newSessionController.open({ initialCwd, newTask: true });
    runtime?.onOpen();
    publish({ open: true, dismissable: true, initialCwd: initialCwd ?? "", initialKind: kind });
    return true;
  },
  close(): void {
    if (snapshot.initialKind !== "project") newSessionController.close();
    createdCallback = undefined;
    if (!snapshot.open) return;
    publish({ open: false });
    runtime?.onClose();
  },
  closeIfOpen(): boolean {
    if (snapshot.initialKind !== "project") newSessionController.closeIfOpen();
    if (!snapshot.open || !snapshot.dismissable) return false;
    this.close();
    return true;
  },
  isOpen(): boolean {
    return snapshot.open || newSessionController.isOpen();
  },
  setDismissable(dismissable): void {
    if (snapshot.initialKind !== "project") newSessionController.setDismissable(dismissable);
    publishDismissable(dismissable);
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
  /** The legacy request has been handed to NewSessionHost; do not dismiss the live form. */
  consumeOpen(): void {
    if (snapshot.open) publish({ open: false });
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
