import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WandStorage } from "./storage.js";
import { normalizeProjectCwd, projectCwdForSession } from "./workspace-binding.js";

function canonical(value: string): string {
  try { return realpathSync(value); } catch { return normalizeProjectCwd(value); }
}

/** Presentation only: preserve sessions and files even when their generated directory is hidden. */
export function directoryCandidateFilter(storage: WandStorage): (cwd: string) => boolean {
  const manual = new Set(storage.listWorkspaces().filter(workspace => workspace.userAdded).map(workspace => canonical(workspace.cwd)));
  const roots = [os.tmpdir(), "/tmp", "/private/tmp", path.join(storage.directory(), "scratch"), path.join(storage.directory(), "cache", "temporary")]
    .flatMap(root => [normalizeProjectCwd(root), canonical(root)]);
  const worktrees = storage.loadSessionsSlim().flatMap(session => session.worktree?.path ? [canonical(session.worktree.path), normalizeProjectCwd(session.worktree.path)] : []);
  const excluded = [...new Set([...roots, ...worktrees])];
  return cwd => {
    if (!cwd.trim()) return false;
    const normalized = canonical(cwd);
    if (manual.has(normalized)) return true;
    return !excluded.some(root => {
      const relative = path.relative(root, normalized);
      return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    });
  };
}

export function usedDirectoryCandidates(storage: WandStorage): Array<{ path: string; name: string; lastUsedAt: string }> {
  const visible = directoryCandidateFilter(storage);
  const names = storage.listSessionDirectoryNames();
  const result = new Map<string, { path: string; name: string; lastUsedAt: string }>();
  for (const session of storage.listExecutedDirectorySessions()) {
    const cwd = projectCwdForSession(session);
    if (!visible(cwd) || result.has(cwd)) continue;
    result.set(cwd, { path: cwd, name: names.get(cwd) || path.basename(cwd) || cwd, lastUsedAt: session.endedAt || session.startedAt });
  }
  return [...result.values()];
}
