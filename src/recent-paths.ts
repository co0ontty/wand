import path from "node:path";
import { isBlockedFolderPath, normalizeFolderPath } from "./middleware/path-safety.js";
import type { WandStorage } from "./storage.js";

/** Recently used folder list (persisted in config values). Shared by REST routes and session creation hooks. */
export const MAX_RECENT_PATHS = 10;

export interface RecentPath {
  path: string;
  name: string;
  lastUsedAt: string;
}

/** Persist a cwd to recent paths. Used by REST and session creation hooks. */
export function recordRecentPath(storage: WandStorage, cwd: string | undefined | null): void {
  if (!cwd) return;
  const trimmed = cwd.trim();
  if (!trimmed) return;
  let resolved: string;
  try {
    resolved = normalizeFolderPath(trimmed);
  } catch {
    return;
  }
  if (isBlockedFolderPath(resolved)) return;
  const stored = storage.getConfigValue("recent_paths");
  let recent = parseStoredPathList<RecentPath>(stored);
  recent = recent.filter((item) => normalizeFolderPath(item.path) !== resolved);
  recent.unshift({
    path: resolved,
    name: path.basename(resolved),
    lastUsedAt: new Date().toISOString(),
  });
  storage.setConfigValue("recent_paths", JSON.stringify(recent.slice(0, MAX_RECENT_PATHS)));
}

export function parseStoredPathList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}
