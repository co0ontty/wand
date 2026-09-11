import type { WandStorage } from "./storage.js";
import type { WandTask } from "./task-types.js";
import type { Workspace, WorkspaceTask } from "./types.js";

function boardDescriptionFor(task: WorkspaceTask, workspace: Workspace): string {
  const lines = [`项目：${workspace.name}`];
  const cwd = task.worktree?.path || task.cwd || workspace.cwd;
  if (cwd) lines.push(`目录：${cwd}`);
  if (task.worktree?.branch) lines.push(`分支：${task.worktree.branch}`);
  return lines.join("\n");
}

/** 侧栏工作任务与看板卡片对账：已关联则复用，同项目同名未关联则挂上，否则新建。 */
export function ensureBoardTaskForWorkspaceTask(
  storage: WandStorage,
  task: WorkspaceTask,
  workspace: Workspace,
): WandTask {
  const linked = storage.getWandTaskByWorkspaceTaskId(task.id);
  if (linked) return linked;
  const reusable = storage.findUnlinkedWandTask(workspace.id, task.name);
  if (reusable) {
    return storage.updateWandTask(reusable.id, {
      workspaceTaskId: task.id,
      workspaceId: workspace.id,
    }) ?? reusable;
  }
  return storage.createWandTask({
    workspaceId: workspace.id,
    workspaceTaskId: task.id,
    title: task.name,
    description: boardDescriptionFor(task, workspace),
    status: task.status === "done" ? "done" : "todo",
  });
}

/** 看板归档：卡片进入已完成，并同步把关联的侧栏工作任务标成 done（不删会话）。 */
export function archiveBoardTask(storage: WandStorage, id: string): WandTask | null {
  const current = storage.getWandTask(id);
  if (!current) return null;
  const archived = storage.updateWandTask(id, { status: "done" });
  if (current.workspaceTaskId) {
    const workspaceTask = storage.getWorkspaceTask(current.workspaceTaskId);
    if (workspaceTask && workspaceTask.status !== "done") {
      storage.updateWorkspaceTask(workspaceTask.id, { status: "done" });
    }
  }
  return archived;
}

/** 侧栏工作任务完成/删除时，把对应看板卡片标成已完成。 */
export function archiveBoardTaskForWorkspaceTask(storage: WandStorage, workspaceTaskId: string): void {
  const linked = storage.getWandTaskByWorkspaceTaskId(workspaceTaskId);
  if (!linked || linked.status === "done") return;
  storage.updateWandTask(linked.id, { status: "done" });
}
