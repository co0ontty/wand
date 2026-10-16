import { httpWorkspacesRepository } from "../workspaces/repository";
import type { WorkspaceTaskDetail } from "../workspaces/types";
import { newSessionController, newSessionStore, type NewSessionOpenOptions } from "../new-session/controller";
import type { WandTaskListed } from "./task-board-repository";

export async function openTaskSessionCreation(task: Pick<WandTaskListed, "status" | "workspaceTaskId">, options: {
  getTask?(id: string): Promise<WorkspaceTaskDetail>;
  getCreationState?(): { open: boolean; revision: number };
  open?(input: NewSessionOpenOptions): boolean;
  canContinue?(): boolean;
} = {}): Promise<boolean> {
  if (task.status === "archived" || !task.workspaceTaskId) throw new Error("请先恢复任务，再新建会话。");
  const getState = options.getCreationState ?? newSessionStore.getSnapshot;
  const before = getState();
  if (before.open) return false;
  // The container owns the real cwd (including a worktree); never guess it from the card's project.
  const owner = await (options.getTask ?? (id => httpWorkspacesRepository.getTask(id)))(task.workspaceTaskId);
  if (owner.id !== task.workspaceTaskId || owner.archived || owner.status === "done") throw new Error("任务容器已变化，请恢复任务后重试。");
  const current = getState();
  if (current.open || current.revision !== before.revision || options.canContinue?.() === false) return false;
  const opened = (options.open ?? newSessionController.open)({ initialCwd: owner.cwd, workspaceId: owner.workspaceId,
    workspaceTaskId: owner.id, taskName: owner.name });
  if (!opened) throw new Error("新建会话环境尚未就绪，请刷新页面后重试。");
  return true;
}
