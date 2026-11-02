import { taskWorkflowStage } from "../../../task-types.js";
import * as React from "react";
import type { ConversationSummary } from "../../../conversation-types.js";
import { isSidebarConversationVisible } from "../../group-chat-visibility.js";
import { agentToolDisplayName } from "../../provider-identity";
import { sessionWorktree } from "../workspaces/worktree-presentation";
import { matchesSessionRuntime, runtimeSelections, isSessionNeedsConfirmation } from "./runtime-filter";
import { workspaceSessionProvider } from "../workspaces/session-order";
import { isSessionActive, isSessionAttention } from "../workspaces/sidebar-display-mode";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";
import { useTaskGroups, taskGroupsStore } from "../workspaces/task-groups-store";
import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "../workspaces/types";
import {
  DEFAULT_CONVERSATION_FILTERS,
  conversationWorkspaceOptions,
  conversationEmployeeOptions,
  matchesWorkspaceSelection,
  matchesEmployeeSelection,
  matchesConversationFacets,
  type ConversationListFilters,
} from "./list-filters";
import { useSiliconEmployees } from "../agents/employee-repository";
import { useConversations } from "./repository";
import { useConversationUi } from "./state";
import type { PersonSessionEntry } from "./sidebar-sessions";

export interface UnifiedSidebarEntry extends PersonSessionEntry {
  conversation?: ConversationSummary;
}

/** One row per real session; employee identity and directory are metadata, never parent rows. */
export function collectUnifiedSessions(groups: readonly TaskDirectoryGroup[], conversations: readonly ConversationSummary[]): UnifiedSidebarEntry[] {
  const entries = new Map<string, UnifiedSidebarEntry>();
  const add = (group: TaskDirectoryGroup, session: WorkspaceSessionSummary, task?: TaskSummary, archived = false): void => {
    if (session.sessionSource === "quick-terminal" || entries.has(session.id)) return;
    entries.set(session.id, { group, session, task, taskName: task?.name ?? null, archived: archived || session.archived === true });
  };
  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) add(group, session, task, task.archived === true);
      for (const session of task.archivedSessions ?? []) add(group, session, task, true);
    }
    for (const session of group.standaloneSessions) add(group, session);
    for (const session of group.archivedSessions ?? []) add(group, session, undefined, true);
  }
  // Legacy direct/group chats keep their own history entry. Never fabricate an empty employee chat.
  for (const conversation of conversations.filter(isSidebarConversationVisible)) {
    const id = conversation.communicationSessionId || conversation.sessionId;
    if (!id) continue;
    const existing = entries.get(id);
    if (existing) { entries.set(id, { ...existing, conversation }); continue; }
    entries.set(id, {
      conversation,
      group: {
        workspaceId: "wand-global",
        workspaceName: "未分配工作区",
        workspaceCwd: "",
        synthetic: true,
        tasks: [],
        standaloneSessions: [],
      },
      taskName: null,
      archived: Boolean(conversation.dissolvedAt),
      session: {
        id,
        title: conversation.title,
        employeeId: conversation.peerEmployeeId ?? undefined,
        startedAt: conversation.createdAt,
      },
    });
  }
  return [...entries.values()].sort((a, b) => Number(Boolean(b.conversation?.pinnedAt)) - Number(Boolean(a.conversation?.pinnedAt))
    || (b.conversation?.pinnedAt ?? "").localeCompare(a.conversation?.pinnedAt ?? "")
    || (b.session.startedAt ?? "").localeCompare(a.session.startedAt ?? "")
    || a.session.id.localeCompare(b.session.id));
}

export function orderUnifiedSidebarRows(rows: readonly UnifiedSidebarEntry[]): UnifiedSidebarEntry[] {
  const attentionRows = rows.filter(entry => isSessionAttention(entry.session) || isSessionNeedsConfirmation(entry.session));
  const otherRows = rows.filter(entry => !isSessionAttention(entry.session) && !isSessionNeedsConfirmation(entry.session));
  return [...attentionRows, ...otherRows];
}

export function useUnifiedSidebar(enabled: boolean, titles: Readonly<Record<string, string>>) {
  const groups = useTaskGroups();
  const conversations = useConversations(false, enabled);
  const ui = useConversationUi();
  useSiliconEmployees({ enabled });
  const facets: ConversationListFilters = {
    ...DEFAULT_CONVERSATION_FILTERS,
    workspace: ui.listWorkspace,
    employee: ui.listEmployee,
    runtime: ui.listRuntime,
  };
  const entries = React.useMemo(() => collectUnifiedSessions(groups.groups, conversations.items), [groups.groups, conversations.items]);
  const query = ui.filters["list-query"] ?? "";
  const rows = React.useMemo(() => entries.filter(entry => matchesSessionRuntime({ ...entry.session, archived: entry.archived }, facets.runtime)
    && matchesConversationFacets(entry, facets)
    && (!ui.listWorktree || sessionWorktree(entry.group, entry.task, entry.session)?.path === ui.listWorktree)
    && (facets.archive === "all" || (facets.archive === "archived" ? entry.archived : !entry.archived))
    && (!facets.activityOnly || (!entry.archived && isSessionActive(entry.session)))
    && sidebarSearchMatches(
      query,
      titles[entry.session.id] ?? "",
      entry.session.title ?? "",
      entry.taskName ?? "",
      entry.group.workspaceName,
      sessionWorktree(entry.group, entry.task, entry.session)?.name ?? "",
      sessionWorktree(entry.group, entry.task, entry.session)?.branch ?? "",
      entry.session.cwd ?? "",
      entry.session.employeeName ?? "",
      entry.conversation?.title ?? "",
      agentToolDisplayName(workspaceSessionProvider(entry.session), entry.session.engine),
    )), [entries, facets, ui.listWorktree, query, titles]);
  const queuedTasks = groups.groups.flatMap(group => group.tasks.flatMap(task => {
    const count = task.queuedDispatchCount ?? (task.executionStatus === "queued" ? task.queuedExecutionCount ?? 0 : 0);
    if (!task.boardTaskId || task.archived || count <= 0) return [];
    const runtime = facets.runtime ?? "all";
    if ((runtime !== "all" && !runtimeSelections(runtime).includes("queued"))
      || (facets.taskStage !== "all" && (!task.boardTaskStatus || taskWorkflowStage(task.boardTaskStatus) !== facets.taskStage))
      || facets.archive === "archived"
      || !matchesWorkspaceSelection(facets.workspace, !group.userAdded || group.synthetic || group.global ? "none" : `id:${group.worktree?.parentWorkspaceId ?? group.workspaceId}`)
      || !matchesEmployeeSelection(facets.employee, task.assignedExecutor?.id ?? "none")
      || (ui.listWorktree && sessionWorktree(group, task)?.path !== ui.listWorktree)
      || !sidebarSearchMatches(query, task.name, task.boardTaskIdentifier ?? "", group.workspaceName, task.assignedExecutor?.name ?? "")) return [];
    return [{ group, task, count }];
  }));
  const employees = conversationEmployeeOptions(entries);
  for (const group of groups.groups) for (const task of group.tasks) {
    const assignee = task.assignedExecutor;
    if ((task.queuedDispatchCount ?? 0) > 0 && assignee && !employees.some(option => option.value === assignee.id)) {
      employees.push({ value: assignee.id, label: assignee.name, avatar: assignee.avatar });
    }
  }
  const orderedRows = React.useMemo(() => orderUnifiedSidebarRows(rows), [rows]);
  return {
    entries,
    rows,
    orderedRows,
    queuedTasks,
    worktree: ui.listWorktree,
    groups: groups.groups,
    workspaces: conversationWorkspaceOptions(groups.groups),
    employees,
    facets,
    query,
    loading: groups.loading && !groups.groups.length,
    error: groups.error || conversations.error,
    refresh: () => {
      conversations.refresh();
      void taskGroupsStore.reload();
    },
  };
}

export type UnifiedSidebarModel = ReturnType<typeof useUnifiedSidebar>;
