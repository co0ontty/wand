import { agentToolDisplayName } from "../../provider-identity";
import { sessionWorktree } from "../workspaces/worktree-presentation";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";
import { workspaceSessionProvider } from "../workspaces/session-order";
import { matchesSessionRuntime } from "./runtime-filter";
import { matchesWorkspaceSelection, matchesEmployeeSelection, personSessionWorkspace, personSessionEmployee,
  type ConversationListFilters } from "./list-filters";
import type { UnifiedSidebarEntry } from "./unified-sidebar-model";

export function matchesUnifiedSidebarSearch(entry: UnifiedSidebarEntry, query: string, title = ""): boolean {
  const tree = sessionWorktree(entry.group, entry.task, entry.session);
  return sidebarSearchMatches(query, title, entry.session.title ?? "", entry.taskName ?? "", entry.group.workspaceName,
    tree?.name ?? "", tree?.branch ?? "", entry.session.cwd ?? "", entry.session.employeeName ?? "",
    entry.conversation?.title ?? "", agentToolDisplayName(workspaceSessionProvider(entry.session), entry.session.engine));
}

/** Reveal the current row by relaxing only the dimensions that actually exclude it. */
export function revealUnifiedSidebarEntry(entry: UnifiedSidebarEntry, filters: ConversationListFilters,
  worktree: string, query: string, title = "") {
  return {
    runtime: matchesSessionRuntime({ ...entry.session, archived: entry.archived }, filters.runtime)
      ? filters.runtime ?? "all" : entry.archived ? "archived" as const : "all" as const,
    workspace: matchesWorkspaceSelection(filters.workspace, personSessionWorkspace(entry)) ? filters.workspace : "all",
    employee: matchesEmployeeSelection(filters.employee, personSessionEmployee(entry)) ? filters.employee : "all",
    worktree: !worktree || sessionWorktree(entry.group, entry.task, entry.session)?.path === worktree ? worktree : "",
    query: matchesUnifiedSidebarSearch(entry, query, title) ? query : "",
  };
}
