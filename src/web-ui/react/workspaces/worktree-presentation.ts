import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "./types";

export function sessionWorktree(group: TaskDirectoryGroup, task?: TaskSummary, session?: WorkspaceSessionSummary) {
  const tree = task?.worktree ?? session?.worktree ?? group.worktree;
  if (!tree) return null;
  return { path: tree.path, branch: tree.branch, name: tree.path.split("/").filter(Boolean).at(-1) || tree.branch };
}

/** Presentation only; keep the original group identity and mutation ownership. */
export function worktreeDirectoryHierarchy(groups: readonly TaskDirectoryGroup[]) {
  const ids = new Set(groups.map(group => group.workspaceId));
  const children = new Map<string, TaskDirectoryGroup[]>();
  const roots: TaskDirectoryGroup[] = [];
  for (const group of groups) {
    const parent = group.worktree?.parentWorkspaceId;
    if (parent && parent !== group.workspaceId && ids.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(group); children.set(parent, list);
    } else roots.push(group);
  }
  return { roots, children };
}
