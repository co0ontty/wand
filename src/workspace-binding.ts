import path from "node:path";

import { normalizeSessionDirectory } from "./session-directory-tree.js";
import type { WandStorage } from "./storage.js";
import type { Workspace, WorkspaceDefaultProvider, WorktreeInfo } from "./types.js";

/** Normalize a project/session cwd so `/foo/bar/` and `/foo/bar` match. */
export function normalizeProjectCwd(cwd: string | null | undefined): string {
  const trimmed = cwd?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return normalizeSessionDirectory(path.resolve(trimmed));
  } catch {
    return normalizeSessionDirectory(trimmed);
  }
}

/**
 * Directory that should own this session in the project list.
 * Worktree sessions belong to the repo root, not `.wand-worktrees/...`.
 */
export function projectCwdForSession(session: {
  cwd?: string | null;
  worktree?: Pick<WorktreeInfo, "repoRoot" | "path"> | null;
}): string {
  const repoRoot = session.worktree?.repoRoot?.trim();
  if (repoRoot) return normalizeProjectCwd(repoRoot);
  const worktreePath = session.worktree?.path?.trim();
  if (worktreePath) {
    const marker = `${path.sep}.wand-worktrees${path.sep}`;
    const index = worktreePath.indexOf(marker);
    if (index > 0) return normalizeProjectCwd(worktreePath.slice(0, index));
  }
  return normalizeProjectCwd(session.cwd);
}

export function findWorkspaceByCwd(storage: WandStorage, cwd: string): Workspace | null {
  const normalized = normalizeProjectCwd(cwd);
  if (!normalized) return null;
  return storage.listWorkspaces().find((workspace) => normalizeProjectCwd(workspace.cwd) === normalized) ?? null;
}

export function defaultWorkspaceNameForCwd(storage: WandStorage, cwd: string): string {
  const normalized = normalizeProjectCwd(cwd);
  if (!normalized) return "未命名项目";
  const custom = storage.listSessionDirectoryNames().get(normalized);
  if (custom?.trim()) return custom.trim();
  const base = path.basename(normalized);
  return base || normalized;
}

/** Find the project for this directory, or create one named after the folder. */
export function ensureWorkspaceForCwd(
  storage: WandStorage,
  cwd: string,
  options: { name?: string; defaultProvider?: WorkspaceDefaultProvider } = {},
): Workspace {
  const normalized = normalizeProjectCwd(cwd);
  if (!normalized) throw new Error("项目目录不能为空。");
  const existing = findWorkspaceByCwd(storage, normalized);
  if (existing) return existing;
  return storage.createWorkspace({
    name: options.name?.trim() || defaultWorkspaceNameForCwd(storage, normalized),
    cwd: normalized,
    defaultProvider: options.defaultProvider,
  });
}

/**
 * Workspace id to persist on a newly created session.
 * An explicit id wins; otherwise find-or-create the project for `cwd`.
 */
export function resolveWorkspaceIdForNewSession(
  storage: WandStorage,
  cwd: string | null | undefined,
  explicitWorkspaceId?: string | null,
): string | undefined {
  const explicit = explicitWorkspaceId?.trim();
  if (explicit) return explicit;
  const normalized = normalizeProjectCwd(cwd);
  if (!normalized) return undefined;
  return ensureWorkspaceForCwd(storage, normalized).id;
}

export function attachUnboundSessionsToWorkspace(storage: WandStorage, workspace: Workspace): number {
  const target = normalizeProjectCwd(workspace.cwd);
  if (!target) return 0;
  let bound = 0;
  for (const session of storage.listUnboundSessionBindings()) {
    if (projectCwdForSession(session) !== target) continue;
    storage.setSessionWorkspaceId(session.id, workspace.id);
    bound += 1;
  }
  return bound;
}

export function backfillSessionWorkspaces(storage: WandStorage): { created: number; bound: number } {
  let created = 0;
  let bound = 0;
  const known = new Map<string, Workspace>();
  for (const workspace of storage.listWorkspaces()) {
    const key = normalizeProjectCwd(workspace.cwd);
    if (key && !known.has(key)) known.set(key, workspace);
  }
  for (const session of storage.listUnboundSessionBindings()) {
    const cwd = projectCwdForSession(session);
    if (!cwd) continue;
    let workspace = known.get(cwd);
    if (!workspace) {
      workspace = ensureWorkspaceForCwd(storage, cwd);
      known.set(cwd, workspace);
      created += 1;
    }
    storage.setSessionWorkspaceId(session.id, workspace.id);
    bound += 1;
  }
  return { created, bound };
}
