import type { ConversationSummary } from "../../../conversation-types.js";
import { agentToolDisplayName } from "../../provider-identity";
import { compareRecentEntries, type SidebarRecentEntry } from "../workspaces/sidebar-recent";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";
import { workspaceSessionProvider } from "../workspaces/session-order";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../workspaces/types";
import type { ConversationListFilter } from "./state";

export interface PersonSessionEntry extends SidebarRecentEntry {
  readonly archived: boolean;
}
export type PersonSessionIndex = ReadonlyMap<string, readonly PersonSessionEntry[]>;

/** Stable employee IDs own sessions. Names, paths, group membership and legacy DM channel IDs do not. */
export function indexPersonSessions(groups: readonly TaskDirectoryGroup[]): PersonSessionIndex {
  const index = new Map<string, PersonSessionEntry[]>();
  const seen = new Set<string>();
  const push = (group: TaskDirectoryGroup, session: WorkspaceSessionSummary, taskName: string | null, archived = false): void => {
    if (!session.employeeId || session.teamChat || seen.has(session.id)) return;
    seen.add(session.id);
    const entries = index.get(session.employeeId) ?? [];
    entries.push({ group, session, taskName, archived: archived || session.archived === true });
    index.set(session.employeeId, entries);
  };
  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) push(group, session, task.name, task.archived === true);
      for (const session of task.archivedSessions ?? []) push(group, session, task.name, true);
    }
    for (const session of group.standaloneSessions) push(group, session, null);
    for (const session of group.archivedSessions ?? []) push(group, session, null, true);
  }
  for (const entries of index.values()) entries.sort(compareRecentEntries);
  return index;
}

function sessionSearchValues(entry: PersonSessionEntry, liveTitles: Readonly<Record<string, string>>): string[] {
  const session = entry.session;
  return [session.title ?? "", liveTitles[session.id] ?? "", entry.taskName ?? "", entry.group.workspaceName,
    session.cwd ?? "", session.employeeName ?? "", session.teamStep?.title ?? "",
    agentToolDisplayName(workspaceSessionProvider(session), session.engine)];
}

export function filterPersonSessions(
  item: Pick<ConversationSummary, "kind" | "peerEmployeeId" | "title" | "name">,
  index: PersonSessionIndex,
  filter: ConversationListFilter,
  query: string,
  liveTitles: Readonly<Record<string, string>> = {},
): PersonSessionEntry[] {
  if (item.kind !== "dm" || !item.peerEmployeeId) return [];
  return (index.get(item.peerEmployeeId) ?? []).filter(entry => {
    if (filter === "archived" ? !entry.archived : filter === "active" ? entry.archived : false) return false;
    return sidebarSearchMatches(query, item.title, item.name, ...sessionSearchValues(entry, liveTitles));
  });
}

/** Parent search may match a child's live title without issuing one HTTP request per person. */
export function personSessionSearchValues(
  item: Pick<ConversationSummary, "kind" | "peerEmployeeId" | "title" | "name">,
  index: PersonSessionIndex,
  filter: ConversationListFilter,
  liveTitles: Readonly<Record<string, string>> = {},
): string[] {
  return filterPersonSessions(item, index, filter, "", liveTitles).flatMap(entry => sessionSearchValues(entry, liveTitles));
}
