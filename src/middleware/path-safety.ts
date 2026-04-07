import path from "node:path";

/** Check that targetPath is within basePath (or equal to it). */
export function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/** Blocked folder paths that should never be browsed. */
const BLOCKED_FOLDER_PATHS = ["/etc", "/root", "/boot"] as const;

/** Check if targetPath is inside any blocked system folder. */
export function isBlockedFolderPath(targetPath: string): boolean {
  return BLOCKED_FOLDER_PATHS.some((blockedPath) => {
    const relativePath = path.relative(blockedPath, targetPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  });
}

/** Normalize a folder path to its absolute form. */
export function normalizeFolderPath(inputPath: string): string {
  return path.resolve(inputPath);
}
