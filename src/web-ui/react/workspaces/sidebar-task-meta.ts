import type { TaskDirectoryGroup, TaskSummary } from "./types";

interface SidebarSelection {
  workspaceId: string | null;
  taskId: string | null;
}

export function sidebarSelection(
  groups: readonly TaskDirectoryGroup[],
  context: SidebarSelection,
  selectedSessionId: string | null,
): SidebarSelection {
  if (context.workspaceId) return { workspaceId: context.workspaceId, taskId: context.taskId };
  if (selectedSessionId) {
    for (const group of groups) {
      const task = group.tasks.find((candidate) => candidate.sessions.some((session) => session.id === selectedSessionId));
      if (task || group.standaloneSessions.some((session) => session.id === selectedSessionId)) {
        return { workspaceId: group.workspaceId, taskId: task?.id ?? null };
      }
    }
  }
  return { workspaceId: null, taskId: null };
}

export function taskRecency(task: TaskSummary): string {
  return task.lastOpenedAt ?? task.createdAt;
}

/** Newer createdAt first; missing timestamps sink; id is a stable tiebreaker. */
export function compareCreatedDesc(
  left?: string | null,
  right?: string | null,
  leftId = "",
  rightId = "",
): number {
  const a = (left ?? "").trim();
  const b = (right ?? "").trim();
  if (a !== b) {
    if (!a) return 1;
    if (!b) return -1;
    return b.localeCompare(a);
  }
  return rightId.localeCompare(leftId);
}

export function orderSidebarTasks<T extends { id: string; createdAt?: string | null }>(
  tasks: readonly T[],
): T[] {
  return [...tasks].sort((left, right) => (
    compareCreatedDesc(left.createdAt, right.createdAt, left.id, right.id)
  ));
}

export function groupCreatedAt(group: TaskDirectoryGroup): string {
  if (group.createdAt?.trim()) return group.createdAt.trim();
  const times = [
    ...group.tasks.map((task) => task.createdAt),
    ...group.standaloneSessions.map((session) => session.startedAt ?? ""),
  ].filter((value) => value.trim());
  if (times.length === 0) return "";
  return times.reduce((oldest, value) => (value < oldest ? value : oldest));
}

/** Global group first, then newest folders. Opening a task must not reshuffle. */
export function orderSidebarGroups(
  groups: readonly TaskDirectoryGroup[],
): TaskDirectoryGroup[] {
  return [...groups].sort((left, right) => {
    const global = Number(Boolean(right.global)) - Number(Boolean(left.global));
    if (global) return global;
    return compareCreatedDesc(
      groupCreatedAt(left),
      groupCreatedAt(right),
      left.workspaceId,
      right.workspaceId,
    );
  });
}

export function formatTaskRecency(timestamp: string, now: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}时`;
  if (minutes < 10_080) return `${Math.floor(minutes / 1_440)}天`;
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? monthDay
    : `${date.getFullYear()}/${monthDay}`;
}

export function taskActivity(task: TaskSummary): "attention" | "running" | null {
  if (task.sessions.some((session) => (
    ["failed", "waiting-input", "waiting_input", "permission-blocked", "reconnecting"].includes(session.status ?? "")
  ))) return "attention";
  if (task.sessions.some((session) => (
    session.ptyBusy || session.inFlight || session.status === "thinking"
  ))) return "running";
  return null;
}
