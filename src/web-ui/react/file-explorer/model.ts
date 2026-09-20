import { explorerBaseName, explorerParentOf } from "./paths";
import { formatFilePreviewSize } from "../file-preview/model";
import type { FileExplorerEntry, FileExplorerSearchFilter } from "./types";

/**
 * Search-result shaping for the file explorer. The server decides *which*
 * entries match (substring on the basename, sorted by match position); this
 * module only derives presentation data so grouping, highlighting, and
 * filtering stay pure and testable.
 */

export interface FileExplorerSearchMatch {
  start: number;
  end: number;
}

export interface FileExplorerSearchSegment {
  value: string;
  match: boolean;
}

export interface FileExplorerSearchGroup {
  /** Parent directory path; also the React key. */
  key: string;
  /** Relative directory label shown above the group's rows. */
  label: string;
  entries: FileExplorerEntry[];
}

export function normalizeFileExplorerSearchQuery(query: string): string {
  return query.trim();
}

/**
 * Case-insensitive, non-overlapping occurrence ranges of `query` inside
 * `name`. Falls back to a case-sensitive scan when lowercasing would change
 * the string length (a few Unicode names), so offsets always index `name`.
 */
export function fileExplorerSearchMatches(name: string, query: string): FileExplorerSearchMatch[] {
  const needle = normalizeFileExplorerSearchQuery(query);
  if (!needle) return [];
  const lowered = name.toLowerCase();
  const haystack = lowered.length === name.length ? lowered : name;
  const target = lowered.length === name.length ? needle.toLowerCase() : needle;
  const matches: FileExplorerSearchMatch[] = [];
  let index = haystack.indexOf(target);
  while (index !== -1) {
    matches.push({ start: index, end: index + target.length });
    index = haystack.indexOf(target, index + target.length);
  }
  return matches;
}

/** Splits `name` into plain and matched segments for rendering highlights. */
export function fileExplorerSearchSegments(name: string, query: string): FileExplorerSearchSegment[] {
  const matches = fileExplorerSearchMatches(name, query);
  if (matches.length === 0) return [{ value: name, match: false }];
  const segments: FileExplorerSearchSegment[] = [];
  let offset = 0;
  for (const match of matches) {
    if (match.start > offset) segments.push({ value: name.slice(offset, match.start), match: false });
    segments.push({ value: name.slice(match.start, match.end), match: true });
    offset = match.end;
  }
  if (offset < name.length) segments.push({ value: name.slice(offset), match: false });
  return segments;
}

/** Directory of `target` relative to `root`, or the absolute path when outside it. */
export function fileExplorerRelativeDir(target: string, root: string): string {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) return normalized;
  if (normalized === base) return "";
  if (!normalized.startsWith(`${base}/`)) return normalized;
  return normalized.slice(base.length + 1);
}

function groupLabel(dir: string, root: string): string {
  const relative = fileExplorerRelativeDir(dir, root);
  if (relative) return relative;
  return explorerBaseName(root) || "/";
}

/**
 * Groups results under their parent directory, keeping the server's relevance
 * order at group level (first appearance wins) and inside each group.
 */
export function groupFileExplorerSearchResults(
  entries: ReadonlyArray<FileExplorerEntry>,
  root: string,
): FileExplorerSearchGroup[] {
  const groups: FileExplorerSearchGroup[] = [];
  const byKey = new Map<string, FileExplorerSearchGroup>();
  for (const entry of entries) {
    const key = explorerParentOf(entry.path);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: groupLabel(key, root), entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

export function filterFileExplorerSearchResults(
  entries: ReadonlyArray<FileExplorerEntry>,
  filter: FileExplorerSearchFilter,
): FileExplorerEntry[] {
  if (filter === "all") return [...entries];
  const wanted = filter === "dir" ? "dir" : "file";
  return entries.filter((entry) => entry.type === wanted);
}

/** Human size for a file row; directories stay unlabelled. */
export function fileExplorerEntrySizeLabel(entry: FileExplorerEntry): string {
  if (entry.type !== "file" || typeof entry.size !== "number") return "";
  return formatFilePreviewSize(entry.size);
}

/** Local `YYYY-MM-DD HH:mm` for tooltips; the UI never shifts dates to UTC. */
export function formatFileExplorerTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface FileExplorerSearchCounts {
  all: number;
  file: number;
  dir: number;
}

export function countFileExplorerSearchResults(
  entries: ReadonlyArray<FileExplorerEntry>,
): FileExplorerSearchCounts {
  let file = 0;
  let dir = 0;
  for (const entry of entries) {
    if (entry.type === "dir") dir += 1;
    else file += 1;
  }
  return { all: entries.length, file, dir };
}
