import { createStartupPreload } from "../../startup-preload";
import { requestJson } from "../http-adapter";
import { subscribeTaskChanges } from "../task-changes";
import { httpWorkspacesRepository } from "../workspaces/repository";
import { currentTaskGroupsRevision } from "../workspaces/task-groups-store";
import type { WandTaskListed } from "./task-board-repository";

// 看板和侧栏共用 GET /api/tasks 快照。旧服务端没有 tasks 数组时才回退正式任务列表。
const startupTasks = createStartupPreload(() => loadTaskBoardList());
subscribeTaskChanges(() => startupTasks.clear());

export function preloadTaskBoardList(): void { startupTasks.preload(); }
export function clearTaskBoardPreload(): void { startupTasks.clear(); }
export async function loadTaskBoardList(workspaceId?: string): Promise<WandTaskListed[]> {
  const page = await httpWorkspacesRepository.listTaskGroups(currentTaskGroupsRevision());
  if (!page.formalTasksIncluded) {
    return requestJson<WandTaskListed[]>(workspaceId
      ? `/api/wand-tasks?workspaceId=${encodeURIComponent(workspaceId)}`
      : "/api/wand-tasks");
  }
  const tasks = page.tasks as WandTaskListed[];
  return workspaceId ? tasks.filter((task) => task.workspaceId === workspaceId) : tasks;
}
