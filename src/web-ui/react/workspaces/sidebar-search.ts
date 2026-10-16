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
  const activeGroups = groups.map((group) => ({
    ...group,
    workspaceName: group.global ? "未归属工作区" : group.workspaceName,
    tasks: group.tasks.filter((task) => !task.archived && task.status !== "done"),
  })).filter((group) => !group.global || group.tasks.length > 0 || group.standaloneSessions.length > 0 || Boolean(group.archivedSessions?.length))
    .sort((left, right) => Number(Boolean(left.global)) - Number(Boolean(right.global)));
  if (!query.trim()) return activeGroups;
  const matches = (...values: (string | undefined)[]): boolean => sidebarSearchMatches(query, ...values);
  const sessionText = (session: WorkspaceSessionSummary): string => (
    [session.title, session.cwd, session.provider, liveTitles[session.id]].filter(Boolean).join(" ")
  );
  return activeGroups.flatMap((group) => {
    const name = group.workspaceName;
    if (matches(name, group.workspaceCwd)) return [group];
    const tasks = group.tasks.filter((task) => matches(
      name, task.name, task.cwd, ...task.sessions.map(sessionText), ...(task.archivedSessions ?? []).map(sessionText),
    ));
    const defaultName = defaultDirectoryTaskName(group);
    const standaloneSessions = group.standaloneSessions.filter((session) => (
      matches(defaultName, sessionText(session))
    ));
    const archivedSessions = group.archivedSessions?.filter((session) => matches(defaultName, sessionText(session)));
    return tasks.length || standaloneSessions.length || archivedSessions?.length || matches(defaultName)
      ? [{ ...group, tasks, standaloneSessions, archivedSessions }] : [];
  });
}
