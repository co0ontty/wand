import type { TaskLayoutSaveOptions, TaskWindowLayout, WorkspaceTaskDetail, WorkspacesRepository } from "./types";

type SaveResult = "saved" | "superseded" | "failed";
interface PendingSave {
  layout: TaskWindowLayout | null;
  automatic: boolean;
  resolve: (result: SaveResult) => void;
}
interface TaskWrites {
  revision?: number;
  epoch: number;
  automaticBlocked: boolean;
  pending?: PendingSave;
  running?: Promise<void>;
}
interface LayoutCallbacks {
  onSaved(taskId: string, revision: number | undefined): void;
  onError(taskId: string, error: unknown): void;
  onRestore(taskId: string, detail: WorkspaceTaskDetail): void;
}

/** All task layout writes share this queue, including restoration and session creation. */
export function createTaskLayoutController(
  repository: Pick<WorkspacesRepository, "getTask" | "saveTaskLayout">,
  callbacks: LayoutCallbacks,
) {
  const tasks = new Map<string, TaskWrites>();
  function writesFor(taskId: string): TaskWrites {
    let writes = tasks.get(taskId);
    if (!writes) {
      writes = { epoch: 0, automaticBlocked: false };
      tasks.set(taskId, writes);
    }
    return writes;
  }
  async function readRevision(taskId: string, writes: TaskWrites): Promise<WorkspaceTaskDetail> {
    const detail = await repository.getTask(taskId);
    if (detail.id !== taskId) throw new Error("任务详情与请求不匹配。");
    writes.revision = detail.layoutRevision ?? 0;
    return detail;
  }
  function settlePending(writes: TaskWrites, result: SaveResult): void {
    writes.pending?.resolve(result);
    writes.pending = undefined;
  }
  async function drain(taskId: string, writes: TaskWrites): Promise<void> {
    while (writes.pending) {
      const next = writes.pending;
      writes.pending = undefined;
      try {
        if (writes.revision === undefined) await readRevision(taskId, writes);
        const saved = await repository.saveTaskLayout(taskId, next.layout, writes.revision);
        writes.revision = saved.layoutRevision;
        if (!next.automatic) writes.automaticBlocked = false;
        callbacks.onSaved(taskId, saved.layoutRevision);
        next.resolve("saved");
      } catch (error) {
        // Cancel only edits queued before this failure, never edits made during recovery.
        const failedEpoch = writes.epoch;
        writes.automaticBlocked = true;
        settlePending(writes, "failed");
        writes.revision = undefined;
        callbacks.onError(taskId, error);
        try {
          const remote = await readRevision(taskId, writes);
          if (writes.epoch === failedEpoch) callbacks.onRestore(taskId, remote);
        } catch { /* Keep the draft; the next explicit save must first reload its revision. */ }
        next.resolve("failed");
      }
    }
  }
  function start(taskId: string, writes: TaskWrites): void {
    if (writes.running) return;
    writes.running = drain(taskId, writes).finally(() => {
      writes.running = undefined;
      if (writes.pending) start(taskId, writes);
    });
  }
  return {
    remember(taskId: string, revision: number | undefined): void {
      const writes = writesFor(taskId);
      if (!writes.running) writes.revision = revision ?? 0;
    },
    canSaveAutomatically(taskId: string): boolean {
      return !tasks.get(taskId)?.automaticBlocked;
    },
    save(taskId: string, layout: TaskWindowLayout | null, options: TaskLayoutSaveOptions = {}): Promise<SaveResult> {
      const writes = writesFor(taskId);
      if (options.automatic && writes.automaticBlocked) return Promise.resolve("failed");
      writes.epoch++;
      settlePending(writes, "superseded");
      const result = new Promise<SaveResult>((resolve) => {
        writes.pending = { layout, resolve, automatic: options.automatic === true };
      });
      start(taskId, writes);
      return result;
    },
    isSaving(taskId: string): boolean {
      return Boolean(tasks.get(taskId)?.running);
    },
    async flush(taskId: string): Promise<void> {
      const writes = tasks.get(taskId);
      while (writes?.running) await writes.running;
    },
  };
}
