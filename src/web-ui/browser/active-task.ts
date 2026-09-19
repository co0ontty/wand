// 「当前任务」的持久化与启动恢复。
//
// 页面刷新只持久化了会话选中态（wand-selected-session）：顶部标签栏、分屏和任务
// 欢迎页都由 workspaceContextStore 驱动，缺了这里的恢复就会「从侧栏点进任务有
// 标签栏，刷新后没了」，主区退回一条裸会话。任务 id 单独记一个键，因为刷新时
// 会话可能已被关闭、任务也可能已经空了，只靠选中会话推不出当前任务。

import { workspacesStore } from "../react/workspaces/controller";
import { httpWorkspacesRepository } from "../react/workspaces/repository";
import { findTaskContext, taskOpenPayload } from "../react/workspaces/session-open";

const ACTIVE_TASK_KEY = "wand-active-task";
const SELECTED_SESSION_KEY = "wand-selected-session";

/** 记录当前打开的任务；传 null 清空（退回项目 / 关闭工作区）。 */
export function persistActiveTask(taskId: string | null): void {
  try {
    if (taskId) localStorage.setItem(ACTIVE_TASK_KEY, taskId);
    else localStorage.removeItem(ACTIVE_TASK_KEY);
  } catch (e) {
    // 隐私模式 / 存储被禁用：只是失去刷新恢复能力，不影响当前会话。
  }
}

export function readActiveTaskId(): string {
  try {
    return (localStorage.getItem(ACTIVE_TASK_KEY) || "").trim();
  } catch (e) {
    return "";
  }
}

// 刷新前主区显示的会话。loadSessions 会把本次启动自动挑中的会话写回同一个键
// （见 session-engine 的 getPreferredSessionId / persistSelectedId），所以必须在
// 它之前读一次：模块加载早于任何会话加载，正是这个时机。
const selectionOnLoad = readStoredSelection();

/**
 * 启动（刷新页面 / 重新登录）后恢复上次打开的任务上下文。
 *
 * @param selection 刷新前显示的会话；恢复任务后重新选中它，避免把主区从用户
 *   刚看的会话抢走（任务外的会话，例如从看板点进来的独立会话）。默认用启动时
 *   读到的那一份。
 */
export async function restoreActiveTask(selection: string | null = selectionOnLoad): Promise<void> {
  const taskId = readActiveTaskId();
  if (!taskId) return;
  // 原生嵌入终端（?embed=terminal）只要一个终端黑窗，不恢复网页侧的任务壳。
  if (isEmbeddedTerminalView()) return;
  const runtime = workspacesStore.getRuntime();
  if (!runtime) return;
  try {
    const page = await httpWorkspacesRepository.listTaskGroups();
    const found = findTaskContext(page.groups, taskId);
    // 已删除；或已完成（归档）——后者已不在侧栏，不能把它拉回主区。
    if (!found || found.task.status === "done") {
      persistActiveTask(null);
      return;
    }
    await runtime.openTask(taskOpenPayload(found));
    // openTask 恢复的是任务的标签布局，选中态可能落在任务的活动标签上；
    // 刷新要还原用户真正在看的会话（不属于本任务时也一样）。
    if (selection) runtime.selectSession(selection);
  } catch (e) {
    // 离线 / 详情加载失败：保留游标，下次刷新再试。
  }
}

function readStoredSelection(): string | null {
  try {
    return (localStorage.getItem(SELECTED_SESSION_KEY) || "").trim() || null;
  } catch (e) {
    return null;
  }
}

function isEmbeddedTerminalView(): boolean {
  return typeof document !== "undefined"
    && document.documentElement?.classList?.contains("is-wand-embed-terminal") === true;
}
