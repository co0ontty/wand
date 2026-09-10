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
  if (!query.trim()) return groups;
  const matches = (...values: (string | undefined)[]): boolean => sidebarSearchMatches(query, ...values);
  const sessionText = (session: WorkspaceSessionSummary): string => (
    [session.title, session.cwd, session.provider, liveTitles[session.id]].filter(Boolean).join(" ")
  );
  return groups.flatMap((group) => {
    const name = group.global ? "独立任务" : group.workspaceName;
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

export function compactTaskLabel(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join("") || "任务";
}
