import { createDialogLifecycle, type DialogControls, type DialogLifecycle } from "../dialog-lifecycle";
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

export interface NewSessionControllerSnapshot extends DialogLifecycle {
  initialCwd: string;
  initialEmployeeId: string;
  /** 侧栏新建空白终端等入口可指定会话形态；空串表示用默认形态。 */
  initialKind: NewSessionKind | "";
  workspaceId: string;
  workspaceTaskId: string;
  taskName: string;
  newTask: boolean;
  taskDraft?: NewTaskDraftOptions;
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

export interface WandNewSessionController extends DialogControls {
  open(options?: NewSessionOpenOptions): boolean;
  getUnknownCreation(scope: string): NewSessionUnknownCreation | undefined;
  markUnknownCreation(value: NewSessionUnknownCreation): void;
  getAcceptedCreation(draftKey: string): NewSessionAcceptedCreation | undefined;
  setAcceptedCreation(draftKey: string, value: NewSessionAcceptedCreation | null): void;
}

let runtime: NewSessionRuntimeAdapter | null = null;
const emptyFields: Omit<NewSessionControllerSnapshot, keyof DialogLifecycle> = {
  initialCwd: "",
  initialEmployeeId: "",
  initialKind: "",
  workspaceId: "",
  workspaceTaskId: "",
  taskName: "",
  newTask: false,
};
const dialog = createDialogLifecycle(emptyFields);
const unknownCreations = new Map<string, NewSessionUnknownCreation>();
const acceptedCreations = new Map<string, NewSessionAcceptedCreation>();

export const newSessionController: WandNewSessionController = {
  ...dialog.controls,
  open(options = {}): boolean {
    if (!runtime || (dialog.snapshot.open && !dialog.snapshot.dismissable)) return false;
    runtime.onOpen();
    dialog.publish(true, {
      initialCwd: (options.initialCwd ?? "").trim(),
      initialEmployeeId: (options.initialEmployeeId ?? "").trim(),
      initialKind: options.initialKind ?? "",
      workspaceId: (options.workspaceId ?? "").trim(),
      workspaceTaskId: (options.workspaceTaskId ?? "").trim(),
      taskName: (options.taskName ?? "").trim(),
      newTask: options.newTask ?? false,
      taskDraft: options.taskDraft,
    });
    return true;
  },

  close(): void {
    if (!dialog.snapshot.open) return;
    dialog.publish(false, { ...emptyFields, taskDraft: undefined });
    runtime?.onClose();
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
  ...dialog.store,

  getRuntime(): NewSessionRuntimeAdapter | null {
    return runtime;
  },
};

export function configureNewSessionRuntime(adapter: NewSessionRuntimeAdapter): () => void {
  runtime = adapter;
  return () => {
    if (runtime !== adapter) return;
    if (dialog.snapshot.open) newSessionController.close();
    runtime = null;
  };
}

declare global {
  interface Window {
    __wandReactNewSession?: WandNewSessionController;
  }
}
