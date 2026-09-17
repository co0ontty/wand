import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "./types";

export function sidebarSearchMatches(query: string, ...values: (string | undefined)[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => text.includes(word));
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
    tasks: group.tasks.filter((task) => task.status !== "done"),
  })).filter((group) => !group.global || group.tasks.length > 0 || group.standaloneSessions.length > 0)
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
      name, task.name, task.cwd, ...task.sessions.map(sessionText),
    ));
    const standaloneSessions = group.standaloneSessions.filter((session) => (
      matches(name, sessionText(session))
    ));
    return tasks.length || standaloneSessions.length ? [{ ...group, tasks, standaloneSessions }] : [];
  });
}
