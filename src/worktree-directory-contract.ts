export interface DirectoryWorktree {
  name: string;
  path: string;
  branch: string;
  repoRoot: string;
  parentWorkspaceId?: string;
}
