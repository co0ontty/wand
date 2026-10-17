import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "./types";
import { defaultDirectoryTaskName } from "./sidebar-default-task";

export function sidebarSearchMatches(query: string, ...values: (string | undefined)[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

/** Child display projection only: do not feed this array back into task mutation scope. */
export function filterSidebarTaskSessions(
  group: TaskDirectoryGroup,
  task: TaskSummary,
  query: string,
  liveTitles: Readonly<Record<string, string>> = {},
): readonly WorkspaceSessionSummary[] {
  if (task.archived || task.status === "done") return [];
  if (group.tasks.some(parent => parent.id === task.parentWorkspaceTaskId && sidebarSearchMatches(query, parent.name))) return task.sessions;
  if (sidebarSearchMatches(query, group.workspaceName, group.workspaceCwd, task.name, task.cwd)) return task.sessions;
  return task.sessions.filter(session => sidebarSearchMatches(query,
    session.title, liveTitles[session.id], session.cwd, session.provider, session.employeeName,
    session.teamStep?.title, session.teamStep?.memberName, session.teamChat?.chatTitle,
  ));
}

/** Keep complete tasks: filtering must never change the scope of rename/delete/clear actions. */
export function filterSidebarGroups(
  groups: readonly TaskDirectoryGroup[],
  query: string,
  liveTitles: Readonly<Record<string, string>> = {},
): readonly TaskDirectoryGroup[] {
  // Hide completed containers only in the sidebar, including their sessions.
  // Keep the source snapshot intact for the board, navigation and task history.
  // Grouping keys may represent cwd/worktrees; business children follow their root in the projection.
  const taskGroups = new Map(groups.flatMap(group => group.tasks.map(task => [task.id, group.workspaceId] as const)));
  const allTasks = new Map(groups.flatMap(group => group.tasks.map(task => [task.id, task] as const)));
  const home = (task: TaskSummary): string | undefined => {
    let root = task; const seen = new Set([root.id]);
    while (root.parentWorkspaceTaskId && allTasks.has(root.parentWorkspaceTaskId) && !seen.has(root.parentWorkspaceTaskId)) {
      root = allTasks.get(root.parentWorkspaceTaskId)!; seen.add(root.id);
    }
    return taskGroups.get(root.id);
  };
  const projected = groups.map(group => ({ ...group, tasks: groups.flatMap(source => source.tasks.filter(task => task.parentWorkspaceTaskId ? home(task) === group.workspaceId : source.workspaceId === group.workspaceId)) }));
  const activeGroups = projected.map((group) => {
    const candidates = group.tasks;
    const keep = new Set(candidates.filter(task => !task.archived && task.status !== "done" && (task.sessions.length > 0 || (query.trim() && sidebarSearchMatches(query, task.name, task.cwd)))).map(task => task.id));
    const byId = new Map(candidates.map(task => [task.id, task]));
    for (const id of [...keep]) {
      let parent = byId.get(id)?.parentWorkspaceTaskId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) { seen.add(parent); keep.add(parent); parent = byId.get(parent)?.parentWorkspaceTaskId; }
    }
    return { ...group, workspaceName: group.global ? "未归属工作区" : group.workspaceName,
      tasks: candidates.filter(task => keep.has(task.id)) };
  }).filter(group => group.tasks.length > 0 || group.standaloneSessions.length > 0 || Boolean(query.trim() && group.archivedSessions?.length))
    .sort((left, right) => Number(Boolean(left.global)) - Number(Boolean(right.global)));
  if (!query.trim()) return activeGroups;
  const matches = (...values: (string | undefined)[]): boolean => sidebarSearchMatches(query, ...values);
  const sessionText = (session: WorkspaceSessionSummary): string => (
    [session.title, session.cwd, session.provider, liveTitles[session.id]].filter(Boolean).join(" ")
  );
  return activeGroups.flatMap((group) => {
    const name = group.workspaceName;
    if (matches(name, group.workspaceCwd)) return [group];
    const matching = group.tasks.filter((task) => matches(
      name, task.name, task.cwd, ...task.sessions.map(sessionText), ...(task.archivedSessions ?? []).map(sessionText),
    ));
    const keep = new Set(matching.map(task => task.id));
    for (const task of group.tasks) {
      if (task.parentWorkspaceTaskId && matching.some(parent => parent.id === task.parentWorkspaceTaskId)) keep.add(task.id);
    }
    for (const task of matching) {
      let parent = task.parentWorkspaceTaskId; const seen = new Set<string>();
      while (parent && !seen.has(parent)) { seen.add(parent); keep.add(parent); parent = group.tasks.find(t => t.id === parent)?.parentWorkspaceTaskId; }
    }
    const tasks = group.tasks.filter(task => keep.has(task.id));
    const defaultName = defaultDirectoryTaskName(group);
    const standaloneSessions = group.standaloneSessions.filter((session) => (
      matches(defaultName, sessionText(session))
    ));
    const archivedSessions = group.archivedSessions?.filter((session) => matches(defaultName, sessionText(session)));
    return tasks.length || standaloneSessions.length || archivedSessions?.length || matches(defaultName)
      ? [{ ...group, tasks, standaloneSessions, archivedSessions }] : [];
  });
}
