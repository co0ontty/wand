import type { NewSessionCreated, NewSessionCreateRequest, NewSessionKind, NewSessionRuntimeAdapter } from "./types";
import type { TaskExecutionSubject, WandTaskAgent, WandTaskPriority, WandTaskStatus } from "../../../task-types.js";

/** Entry points supply context; the new-work page owns the only task editor. */
export interface NewTaskDraftOptions {
  workspaceId?: string;
  cwd?: string;
  status?: WandTaskStatus;
  priority?: WandTaskPriority;
  parentTaskId?: string;
  milestoneId?: string;
  title?: string;
  description?: string;
  executionSubject?: TaskExecutionSubject;
  agent?: WandTaskAgent;
  draftKey?: string;
  scope?: string;
}

export interface NewSessionControllerSnapshot {
  open: boolean;
  dismissable: boolean;
  initialCwd: string;
  initialEmployeeId: string;
  /** 侧栏新建空白终端等入口可指定会话形态；空串表示用默认形态。 */
  initialKind: NewSessionKind | "";
  workspaceId: string;
  workspaceTaskId: string;
  taskName: string;
  newTask: boolean;
  taskDraft?: NewTaskDraftOptions;
  revision: number;
}

export interface NewSessionOpenOptions {
  initialCwd?: string;
  initialEmployeeId?: string;
  initialKind?: NewSessionKind;
  workspaceId?: string;
  workspaceTaskId?: string;
  taskName?: string;
  newTask?: boolean;
  taskDraft?: NewTaskDraftOptions;
}

export interface NewSessionUnknownCreation {
  scope: string;
  message: string;
}
export interface NewSessionAcceptedCreation { request: NewSessionCreateRequest; created: NewSessionCreated; }

export interface WandNewSessionController {
  open(options?: NewSessionOpenOptions): boolean;
  close(): void;
  closeIfOpen(): boolean;
  closeTopmost(): boolean;
  isOpen(): boolean;
  setDismissable(dismissable: boolean): void;
  getUnknownCreation(scope: string): NewSessionUnknownCreation | undefined;
  markUnknownCreation(value: NewSessionUnknownCreation): void;
  getAcceptedCreation(draftKey: string): NewSessionAcceptedCreation | undefined;
  setAcceptedCreation(draftKey: string, value: NewSessionAcceptedCreation | null): void;
}

type Listener = () => void;

let runtime: NewSessionRuntimeAdapter | null = null;
let snapshot: NewSessionControllerSnapshot = {
  open: false,
  dismissable: true,
  initialCwd: "",
  initialEmployeeId: "",
  initialKind: "",
  workspaceId: "",
  workspaceTaskId: "",
  taskName: "",
  newTask: false,
  revision: 0,
};
const listeners = new Set<Listener>();
const unknownCreations = new Map<string, NewSessionUnknownCreation>();
const acceptedCreations = new Map<string, NewSessionAcceptedCreation>();

function publish(
  open: boolean,
  initialCwd = "",
  initialEmployeeId = "",
  initialKind: NewSessionKind | "" = "",
  workspaceId = "",
  workspaceTaskId = "",
  taskName = "",
  newTask = false,
  taskDraft?: NewTaskDraftOptions,
): void {
  snapshot = {
    open,
    dismissable: true,
    initialCwd: open ? initialCwd.trim() : "",
    initialEmployeeId: open ? initialEmployeeId.trim() : "",
    initialKind: open ? initialKind : "",
    workspaceId: open ? workspaceId.trim() : "",
    workspaceTaskId: open ? workspaceTaskId.trim() : "",
    taskName: open ? taskName.trim() : "",
    newTask: open && newTask,
    taskDraft: open ? taskDraft : undefined,
    revision: snapshot.revision + 1,
  };
  for (const listener of listeners) listener();
}

function publishDismissable(dismissable: boolean): void {
  if (!snapshot.open || snapshot.dismissable === dismissable) return;
  // Dismissability is transient operation state, not a new open lifecycle.
  // Keep revision stable so Host initialization effects are not replayed.
  snapshot = { ...snapshot, dismissable };
  for (const listener of listeners) listener();
}

export const newSessionController: WandNewSessionController = {
  open(options = {}): boolean {
    if (!runtime || (snapshot.open && !snapshot.dismissable)) return false;
    runtime.onOpen();
    publish(
      true,
      options.initialCwd,
      options.initialEmployeeId,
      options.initialKind ?? "",
      options.workspaceId,
      options.workspaceTaskId,
      options.taskName,
      options.newTask,
      options.taskDraft,
    );
    return true;
  },

  close(): void {
    if (!snapshot.open) return;
    publish(false);
    runtime?.onClose();
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

  getUnknownCreation(scope): NewSessionUnknownCreation | undefined {
    return unknownCreations.get(scope);
  },

  markUnknownCreation(value): void {
    unknownCreations.set(value.scope, value);
  },
  getAcceptedCreation(draftKey) { return acceptedCreations.get(draftKey); },
  setAcceptedCreation(draftKey, value) {
    if (value) acceptedCreations.set(draftKey, value);
    else acceptedCreations.delete(draftKey);
  },
};

export const newSessionStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): NewSessionControllerSnapshot {
    return snapshot;
  },

  getRuntime(): NewSessionRuntimeAdapter | null {
    return runtime;
  },
};

export function configureNewSessionRuntime(adapter: NewSessionRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (snapshot.open) newSessionController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactNewSession?: WandNewSessionController;
  }
}
