export interface WorkspaceDirectory {
  workspaceId: string;
  isGit: boolean;
  root: string;
  branch: string;
  head: string;
  worktrees: { path: string; name: string; branch: string; head: string }[];
}

