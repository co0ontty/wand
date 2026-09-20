// 从任务外部（刷新恢复、看板卡片、里程碑、通知等）打开会话或任务时，必须先恢复
// 所属任务的工作区上下文：顶部标签栏（含「＋ 新建会话」）与主区的任务态都以它为准，
// 否则主区只剩一条裸会话标题——既没有标签，也没有新建会话的入口。
// 侧栏点击走的是同一条恢复路径（workspaces-panel 的 openSession），这里补上看板、
// 页面刷新等入口缺的那一步；会话不属于任何任务时保持原行为。

import { workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import { workspaceContextStore } from "./workspace-context";
import type { OpenWorkspaceTaskPayload, TaskDirectoryGroup, TaskSummary } from "./types";

export interface SessionOwningTask {
  group: TaskDirectoryGroup;
  task: TaskSummary;
}

/** 会话归属的目录组 + 任务；未分组会话（standaloneSessions）返回 null。 */
export function findSessionOwningTask(
  groups: readonly TaskDirectoryGroup[],
  sessionId: string,
): SessionOwningTask | null {
  for (const group of groups) {
    const task = group.tasks.find((candidate) =>
      candidate.sessions.some((session) => session.id === sessionId));
    if (task) return { group, task };
  }
  return null;
}

/** 任务 id 归属的目录组 + 任务；任务已删除 / 归档时返回 null。 */
export function findTaskContext(
  groups: readonly TaskDirectoryGroup[],
  taskId: string,
): SessionOwningTask | null {
  const id = taskId.trim();
  if (!id) return null;
  for (const group of groups) {
    const task = group.tasks.find((candidate) => candidate.id === id);
    if (task) return { group, task };
  }
  return null;
}

/** 目录组 + 任务 → openTask 载荷（与侧栏打开任务用的是同一份上下文）。 */
export function taskOpenPayload(found: SessionOwningTask, preferredSessionId?: string): OpenWorkspaceTaskPayload {
  const payload: OpenWorkspaceTaskPayload = {
    workspaceId: found.task.workspaceId,
    workspaceName: found.group.global ? "" : found.group.workspaceName,
    taskId: found.task.id,
    taskName: found.task.name,
    cwd: found.task.cwd,
  };
  if (preferredSessionId) payload.preferredSessionId = preferredSessionId;
  return payload;
}

/**
 * 打开会话，并在必要时先恢复它所属任务的工作区上下文。
 *
 * @param sessionId 目标会话 id。
 * @param openFallback 会话不属于任何任务、属于当前已打开任务、或恢复失败时的
 *   兜底打开方式（保持调用方原有行为）。
 */
export async function openSessionWithOwningTask(
  sessionId: string,
  openFallback: (sessionId: string) => void,
): Promise<void> {
  const runtime = workspacesStore.getRuntime();
  const id = sessionId.trim();
  if (!runtime || !id) {
    openFallback(sessionId);
    return;
  }
  try {
    const page = await httpWorkspacesRepository.listTaskGroups();
    const found = findSessionOwningTask(page.groups, id);
    // 已在该任务里：上下文无需切换，直接选中会话，避免重复 flush/重载布局。
    if (!found || workspaceContextStore.getSnapshot().taskId === found.task.id) {
      openFallback(sessionId);
      return;
    }
    await runtime.openTask(taskOpenPayload(found, id));
    // openTask 恢复的是任务的标签布局；点击的那一个会话已经作为 preferredSessionId
    // 在布局恢复时就选中了，这里再选中一次只是为了兜住「会话不在任务列表里」的边界。
    runtime.selectSession(id);
  } catch {
    openFallback(sessionId);
  }
}
