import { lstatSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";

type SymlinkPolicy = "skip" | "include";

// Pi counts link metadata. All hosts walk directories without following child links.
function* descendants(directory: string, links: SymlinkPolicy): Generator<Stats> {
  for (const name of readdirSync(directory)) {
    const child = path.join(directory, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink() && links === "skip") continue;
    yield stat;
    if (stat.isDirectory()) yield* descendants(child, links);
  }
}

export function directoryLatestMtime(directory: string, links: SymlinkPolicy = "skip"): number {
  let latest = lstatSync(directory).mtimeMs;
  for (const stat of descendants(directory, links)) latest = Math.max(latest, stat.mtimeMs);
  return latest;
}

export function directoryBytes(directory: string, links: SymlinkPolicy = "skip"): number {
  let total = 0;
  for (const stat of descendants(directory, links)) {
    if (!stat.isDirectory()) total += stat.size;
  }
  return total;
}
