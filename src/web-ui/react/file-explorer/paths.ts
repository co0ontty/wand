/** Path helpers shared by the explorer tree and the move-to-folder dialog. */

export function joinExplorerPath(dir: string, name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) return dir;
  const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) return `/${trimmedName}`;
  return `${base}/${trimmedName}`;
}

export function explorerParentOf(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

export function explorerBaseName(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** True when `candidate` is `target` itself or lives inside it. */
export function isPathWithin(candidate: string, target: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = candidate.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedTarget) return false;
  return normalized === normalizedTarget || normalized.startsWith(`${normalizedTarget}/`);
}
