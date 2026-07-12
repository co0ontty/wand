import path from "node:path";
import os from "node:os";

/** Check that targetPath is within basePath (or equal to it). */
export function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/** Blocked folder paths that should never be browsed. */
const BLOCKED_FOLDER_PATHS = ["/etc", "/root", "/boot"] as const;

/** Check if targetPath is inside any blocked system folder. */
export function isBlockedFolderPath(targetPath: string): boolean {
  return BLOCKED_FOLDER_PATHS.some((blockedPath) => isPathWithinBase(targetPath, blockedPath));
}

/** Expand shell-style home shortcuts accepted by the UI. */
export function expandHomePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** Normalize a folder path to its absolute form. */
export function normalizeFolderPath(inputPath: string, basePath = process.cwd()): string {
  return path.resolve(basePath, expandHomePath(inputPath));
}
