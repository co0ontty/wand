import type { WorkspacesRepository } from "../workspaces/types";
import type { NewSessionForm } from "./types";

export async function resolveNewSessionTask(
  form: NewSessionForm,
  cwd: string,
  repository: Pick<WorkspacesRepository, "createTask" | "createStandaloneTask">,
): Promise<NewSessionForm> {
  if (form.workspaceTaskId || form.taskName === undefined) return form;
  const name = form.taskName.trim();
  if (!name) throw new Error("请输入任务名称。");
  const request = { name, cwd, worktree: false };
  const task = form.workspaceId
    ? await repository.createTask(form.workspaceId, request)
    : await repository.createStandaloneTask(request);
  if (!task.id) throw new Error("服务端未返回新任务 ID，请刷新任务列表核对后再创建会话。");
  return { ...form, taskName: name, workspaceId: task.workspaceId, workspaceTaskId: task.id, cwd: task.cwd };
}
