import { parseJsonResponse } from "../http-adapter";
import type { WorkspaceDirectory } from "../../../workspace-directory-contract.js";
import type { WorktreeMergeInspection } from "../worktree-merge/types";
export type { WorkspaceDirectory };
export interface DirectoryMergeInspection extends WorktreeMergeInspection {
  sourceHead: string; targetHead: string; targetCwd: string; workspaceId: string;
  targetDirty: boolean; agentAllowed: boolean; agentPrompt: string;
}
export async function readDirectory(id: string, signal?: AbortSignal): Promise<WorkspaceDirectory> {
  return parseJsonResponse(await fetch(`/api/workspaces/${encodeURIComponent(id)}/directory`, { credentials: "same-origin", signal }));
}
export async function inspectDirectoryMerge(id: string, sourcePath: string, signal?: AbortSignal): Promise<DirectoryMergeInspection> {
  return parseJsonResponse(await fetch(`/api/workspaces/${encodeURIComponent(id)}/directory/merge-check`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourcePath }), signal,
  }));
}
export async function mergeDirectory(inspection: DirectoryMergeInspection): Promise<{ ok: boolean; cleanupDone: boolean }> {
  return parseJsonResponse(await fetch(`/api/workspaces/${encodeURIComponent(inspection.workspaceId)}/directory/merge`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: inspection.worktreePath, sourceBranch: inspection.sourceBranch, targetBranch: inspection.targetBranch,
      sourceHead: inspection.sourceHead, targetHead: inspection.targetHead }),
  }));
}
