import { CONVERSATION_OWNER, employeeConversationId, type ConversationSummary } from "../../../conversation-types.js";
import { agentToolDisplayName } from "../../provider-identity";
import { compareRecentEntries, type SidebarRecentEntry } from "../workspaces/sidebar-recent";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";
import { workspaceSessionProvider } from "../workspaces/session-order";
import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "../workspaces/types";
import type { ConversationListFilter } from "./state";
import { isSessionActive } from "../workspaces/sidebar-display-mode";
import { isSystemAiCall } from "../../../system-ai-call.js";
import { matchesConversationFacets, type ConversationListFacets } from "./list-filters";

export interface PersonSessionEntry extends SidebarRecentEntry {
  readonly archived: boolean;
  readonly task?: TaskSummary;
}
export type PersonSessionIndex = ReadonlyMap<string, readonly PersonSessionEntry[]>;

/** Stable employee IDs own sessions. Names, paths, group membership and legacy DM channel IDs do not. */
export function indexPersonSessions(groups: readonly TaskDirectoryGroup[], systemSessions: readonly WorkspaceSessionSummary[] = []): PersonSessionIndex {
  const index = new Map<string, PersonSessionEntry[]>();
  const seen = new Set<string>();
  const push = (group: TaskDirectoryGroup, session: WorkspaceSessionSummary, taskName: string | null, archived = false, task?: TaskSummary): void => {
    if (!session.employeeId || session.teamChat || seen.has(session.id)) return;
    seen.add(session.id);
    const entries = index.get(session.employeeId) ?? [];
    entries.push({ group, session, taskName, task, archived: archived || session.archived === true });
    index.set(session.employeeId, entries);
  };
  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) push(group, session, task.name, task.archived === true, task);
      for (const session of task.archivedSessions ?? []) push(group, session, task.name, true, task);
    }
    for (const session of group.standaloneSessions) push(group, session, null);
    for (const session of group.archivedSessions ?? []) push(group, session, null, true);
  }
  // Employee-only projection. Never add these synthetic containers to the shared
  // workspace store, where feature audit logs must remain excluded.
  for (const session of systemSessions) {
    if (!isSystemAiCall(session)) continue;
    push({ workspaceId: `system-calls:${session.employeeId}`, workspaceName: "系统调用记录",
      workspaceCwd: session.cwd ?? "", synthetic: true, tasks: [], standaloneSessions: [] }, session, null);
  }
  for (const entries of index.values()) entries.sort(compareRecentEntries);
  return index;
}

/** Sessions with no employee stay reachable after the person view leaves the workspace. */
export function collectUnboundSessions(groups: readonly TaskDirectoryGroup[]): PersonSessionEntry[] {
  const entries: PersonSessionEntry[] = [];
  const seen = new Set<string>();
  const push = (group: TaskDirectoryGroup, session: WorkspaceSessionSummary, taskName: string | null, archived = false, task?: TaskSummary): void => {
    if (session.employeeId || session.teamChat || session.sessionSource === "quick-terminal" || seen.has(session.id)) return;
    seen.add(session.id);
    entries.push({ group, session, taskName, task, archived: archived || session.archived === true });
  };
  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) push(group, session, task.name, task.archived === true, task);
      for (const session of task.archivedSessions ?? []) push(group, session, task.name, true, task);
    }
    for (const session of group.standaloneSessions) push(group, session, null);
    for (const session of group.archivedSessions ?? []) push(group, session, null, true);
  }
  return entries.sort(compareRecentEntries);
}

export function filterUnboundSessions(
  entries: readonly PersonSessionEntry[],
  filter: ConversationListFilter,
  query: string,
  liveTitles: Readonly<Record<string, string>> = {},
  activityOnly = false,
  facets?: ConversationListFacets,
): PersonSessionEntry[] {
  return entries.filter(entry => {
    if (facets && !matchesConversationFacets(entry, facets)) return false;
    if (filter === "archived" ? !entry.archived : filter === "active" ? entry.archived : false) return false;
    if (activityOnly && (entry.archived || !isSessionActive(entry.session))) return false;
    return sidebarSearchMatches(query, entry.session.title ?? "", liveTitles[entry.session.id] ?? "", entry.taskName ?? "",
      entry.group.workspaceName, entry.session.cwd ?? "", entry.session.provider ?? "");
  });
}

/** Display-only rows. Opening uses the pending DM id and does not write a conversation. */
export function provisionalPersonConversations(
  index: PersonSessionIndex,
  existing: readonly Pick<ConversationSummary, "kind" | "peerEmployeeId">[],
  employees: readonly { id: string; name?: string }[],
): ConversationSummary[] {
  const owned = new Set(existing.filter(item => item.kind === "dm" && item.peerEmployeeId).map(item => item.peerEmployeeId!));
  const rows: ConversationSummary[] = [];
  for (const [employeeId, entries] of index) {
    if (owned.has(employeeId) || entries.length === 0) continue;
    const latest = entries.find(entry => !entry.archived) ?? entries[0]!;
    const employee = employees.find(item => item.id === employeeId);
    const name = employee?.name?.trim() || latest.session.employeeName?.trim() || "员工";
    rows.push({
      id: employeeConversationId(employeeId), owner: CONVERSATION_OWNER, kind: "dm", peerEmployeeId: employeeId,
      name, nameSource: "auto", sourceTemplateId: null, team: null, memberVersion: 1, joinedVersions: {},
      sessionId: null, communicationSessionId: null, createdAt: "", updatedAt: "",
      title: name, unavailableReason: null, memberUnavailableReasons: {}, tasks: [],
      preview: latest.session.title?.trim() || "有工作会话，尚未开始私聊", messageAt: latest.session.startedAt ?? "",
    });
  }
  return rows;
}

export function provisionalPersonVisible(entries: readonly PersonSessionEntry[], filter: ConversationListFilter): boolean {
  if (!entries.length) return false;
  if (filter === "archived") return entries.some(entry => entry.archived);
  if (filter === "active") return entries.some(entry => !entry.archived);
  return true;
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
  activityOnly = false,
  _selectedSessionId: string | null = null,
  facets?: ConversationListFacets,
): PersonSessionEntry[] {
  if (item.kind !== "dm" || !item.peerEmployeeId) return [];
  return (index.get(item.peerEmployeeId) ?? []).filter(entry => {
    if (facets && !matchesConversationFacets(entry, facets)) return false;
    if (filter === "archived" ? !entry.archived : filter === "active" ? entry.archived : false) return false;
    if (activityOnly && (entry.archived || !isSessionActive(entry.session))) return false;
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
