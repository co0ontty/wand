import { createStartupPreload } from "../../startup-preload";
import { requestJson } from "../http-adapter";
import { subscribeTaskChanges } from "../task-changes";
import type { WandTaskListed } from "./task-board-repository";

// Keep startup's one visible read independent of the board's mutation, comment
// and dispatch implementation, so preloading does not pull them into runtime.
const startupTasks = createStartupPreload(() => requestJson<WandTaskListed[]>("/api/wand-tasks"));
subscribeTaskChanges(() => startupTasks.clear());

export function preloadTaskBoardList(): void { startupTasks.preload(); }
export function clearTaskBoardPreload(): void { startupTasks.clear(); }
export function loadTaskBoardList(workspaceId?: string): Promise<WandTaskListed[]> {
  return workspaceId
    ? requestJson(`/api/wand-tasks?workspaceId=${encodeURIComponent(workspaceId)}`)
    : startupTasks.load();
}
