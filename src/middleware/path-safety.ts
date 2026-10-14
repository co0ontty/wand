import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** Check that targetPath is within basePath (or equal to it). */
export function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

/** System folders that should never be browsed. */
const BLOCKED_SYSTEM_PATHS = ["/etc", "/root", "/boot", "/private/etc", "/var/root"] as const;

/** Credential and app-data locations under the home directory (files or folders). */
const BLOCKED_HOME_SUBPATHS = [
  ".wand",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".config/gcloud",
  ".config/gh",
  "Library/Keychains",
] as const;

function blockedRoots(): string[] {
  const home = os.homedir();
  return [
    ...BLOCKED_SYSTEM_PATHS,
    ...BLOCKED_HOME_SUBPATHS.map((sub) => path.join(home, sub)),
  ];
}

/**
 * Resolve symlinks for the longest existing prefix of targetPath so a link
 * pointing into a blocked location is caught, while paths that do not exist
 * yet (create/rename targets) are still checked lexically.
 */
function canonicalizeExisting(targetPath: string): string {
  let current = path.resolve(targetPath);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Check if targetPath (after symlink resolution) is inside a blocked folder. */
export function isBlockedFolderPath(targetPath: string): boolean {
  const lexical = path.resolve(targetPath);
  const canonical = canonicalizeExisting(lexical);
  const roots = blockedRoots();
  const canonicalRoots = roots.map(canonicalizeExisting);
  return [lexical, canonical].some((candidate) =>
    roots.concat(canonicalRoots).some((root) => isPathWithinBase(candidate, root)));
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
