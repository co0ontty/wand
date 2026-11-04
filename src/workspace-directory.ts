import { realpath } from "node:fs/promises";
import path from "node:path";
import { listGitWorktrees } from "./git-worktree-batch.js";
import { runGitAsync } from "./git-utils.js";

import type { WorkspaceDirectory } from "./workspace-directory-contract.js";

/** Git inventory, not task/session counts. A linked checkout remains its own selected project. */
export async function readWorkspaceDirectory(workspaceId: string, cwd: string): Promise<WorkspaceDirectory> {
  const root = await realpath(cwd);
  let checkout: string;
  try { checkout = await runGitAsync(["rev-parse", "--show-toplevel"], root); }
  catch (error) {
    if (String((error as { stderr?: string }).stderr).includes("not a git repository")) {
      return { workspaceId, isGit: false, root, branch: "", head: "", worktrees: [] };
    }
    throw error;
  }
  const trees = await listGitWorktrees(root);
  const current = trees.find(tree => path.resolve(tree.path) === path.resolve(checkout));
  return { workspaceId, isGit: true, root: checkout, branch: current?.branch ?? "", head: current?.head ?? "",
    worktrees: trees.filter(tree => tree !== current).map(tree => ({ ...tree, name: path.basename(tree.path) })) };
}
