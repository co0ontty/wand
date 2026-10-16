import type { TaskDirectoryGroup, TaskSummary } from "./types";
import type { SidebarManageSelection } from "./sidebar-manage";

export function isDefaultTaskSelected(selection: SidebarManageSelection, group: TaskDirectoryGroup): boolean {
  return group.standaloneSessions.length > 0
    && group.standaloneSessions.every(session => selection.sessionIds.includes(session.id));
}

/** Selecting this fixed row selects its real sessions, never the directory or a synthetic task. */
export function toggleDefaultTaskSelection(selection: SidebarManageSelection, group: TaskDirectoryGroup): SidebarManageSelection {
  const ids = new Set(group.standaloneSessions.map(session => session.id));
  return { ...selection, sessionIds: isDefaultTaskSelected(selection, group)
    ? selection.sessionIds.filter(id => !ids.has(id))
    : [...new Set([...selection.sessionIds, ...ids])] };
}

export function defaultDirectoryTaskName(group: Pick<TaskDirectoryGroup, "workspaceName">): string {
  return `${group.workspaceName} - 未分组任务`;
}

/** Sidebar-only container: never persist this id or use it with a task mutation API. */
export function defaultDirectoryTask(group: TaskDirectoryGroup): TaskSummary {
  return {
    id: `ungrouped:${group.workspaceId}`,
    workspaceId: group.workspaceId,
    name: defaultDirectoryTaskName(group),
    cwd: group.workspaceCwd,
    worktree: null,
    isolated: false,
    layout: null,
    status: "active",
    createdAt: group.createdAt ?? "",
    lastOpenedAt: null,
    canArchive: false,
    sessions: group.standaloneSessions,
    archivedSessions: group.archivedSessions,
  };
}
