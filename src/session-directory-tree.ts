import path from "node:path";

export interface SessionDirectorySource<T> {
  entry: T;
  cwd: string;
  sortTimestamp: number;
}

export interface SessionDirectoryNode<T> {
  /** Exact path used when starting a new session. Empty only for the synthetic unknown group. */
  path: string;
  /** Compact path segment label. Single-child ancestors are folded into this label. */
  name: string;
  /** User-defined workspace label. Clients display this in preference to name. */
  customName?: string;
  synthetic: boolean;
  /** Sessions whose cwd is exactly this node. */
  directCount: number;
  /** Sessions at this node or any descendant node. */
  totalCount: number;
  latestTimestamp: number;
  entries: T[];
  children: SessionDirectoryNode<T>[];
}

export interface SessionDirectoryTree<T> {
  roots: SessionDirectoryNode<T>[];
  totalSessions: number;
  /** Number of distinct real working directories, excluding ancestor-only and unknown nodes. */
  directoryCount: number;
}

interface MutableDirectoryNode<T> {
  path: string;
  name: string;
  synthetic: boolean;
  entries: Array<{ entry: T; sortTimestamp: number }>;
  children: Map<string, MutableDirectoryNode<T>>;
}

function pathApiFor(value: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
    ? path.win32
    : path.posix;
}

export function normalizeSessionDirectory(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const api = pathApiFor(trimmed);
  const normalized = api.normalize(trimmed);
  const root = api.parse(normalized).root;
  let end = normalized.length;
  while (end > root.length && normalized[end - 1] === api.sep) end -= 1;
  return normalized.slice(0, end);
}

function ensureChild<T>(
  parent: Map<string, MutableDirectoryNode<T>>,
  nodePath: string,
  name: string,
): MutableDirectoryNode<T> {
  const existing = parent.get(nodePath);
  if (existing) return existing;
  const created: MutableDirectoryNode<T> = {
    path: nodePath,
    name,
    synthetic: false,
    entries: [],
    children: new Map(),
  };
  parent.set(nodePath, created);
  return created;
}

function insertPath<T>(
  roots: Map<string, MutableDirectoryNode<T>>,
  cwd: string,
): MutableDirectoryNode<T> {
  const api = pathApiFor(cwd);
  const parsed = api.parse(cwd);
  const parts = cwd
    .slice(parsed.root.length)
    .split(api.sep)
    .filter(Boolean);
  let container = roots;
  let currentPath = parsed.root;
  let current: MutableDirectoryNode<T> | null = null;

  if (parsed.root) {
    current = ensureChild(container, parsed.root, parsed.root);
    container = current.children;
  }

  for (const part of parts) {
    currentPath = currentPath ? api.join(currentPath, part) : part;
    current = ensureChild(container, currentPath, part);
    container = current.children;
  }

  // path.normalize(".") has no segments or root. Keep it as a usable node.
  return current ?? ensureChild(roots, cwd, cwd);
}

function compactLabel(parent: string, child: string, childPath: string): string {
  const separator = pathApiFor(childPath).sep;
  if (parent === separator) return `${separator}${child}`;
  if (parent.endsWith(separator)) return `${parent}${child}`;
  return `${parent}${separator}${child}`;
}

function finalizeNode<T>(
  node: MutableDirectoryNode<T>,
  customNames: ReadonlyMap<string, string>,
): SessionDirectoryNode<T> {
  let children = [...node.children.values()].map((child) => finalizeNode(child, customNames));
  const sortedEntries = node.entries
    .slice()
    .sort((left, right) => right.sortTimestamp - left.sortTimestamp);
  const customName = customNames.get(node.path);
  let result: SessionDirectoryNode<T> = {
    path: node.path,
    name: node.name,
    ...(customName ? { customName } : {}),
    synthetic: node.synthetic,
    directCount: sortedEntries.length,
    totalCount: sortedEntries.length + children.reduce((sum, child) => sum + child.totalCount, 0),
    latestTimestamp: Math.max(
      0,
      ...sortedEntries.map((item) => item.sortTimestamp),
      ...children.map((child) => child.latestTimestamp),
    ),
    entries: sortedEntries.map((item) => item.entry),
    children,
  };

  // A filesystem root followed by a single unambiguous chain is visual noise in
  // a 280-300px sidebar. Fold it while retaining the exact descendant path.
  while (!result.synthetic && !result.customName && result.directCount === 0 && result.children.length === 1) {
    const child = result.children[0];
    result = {
      ...child,
      name: compactLabel(result.name, child.name, child.path),
    };
  }

  children = result.children.slice().sort((left, right) => {
    const latestOrder = right.latestTimestamp - left.latestTimestamp;
    return latestOrder || (left.customName ?? left.name).localeCompare(right.customName ?? right.name);
  });
  return { ...result, children };
}

export function buildDirectoryTree<T>(
  sources: readonly SessionDirectorySource<T>[],
  unknownLabel = "未知目录",
  customNames: ReadonlyMap<string, string> = new Map(),
): SessionDirectoryTree<T> {
  const roots = new Map<string, MutableDirectoryNode<T>>();
  let unknown: MutableDirectoryNode<T> | null = null;
  const realDirectories = new Set<string>();

  for (const source of sources) {
    const cwd = normalizeSessionDirectory(source.cwd);
    let node: MutableDirectoryNode<T>;
    if (!cwd) {
      unknown ??= {
        path: "",
        name: unknownLabel,
        synthetic: true,
        entries: [],
        children: new Map(),
      };
      node = unknown;
    } else {
      realDirectories.add(cwd);
      node = insertPath(roots, cwd);
    }
    node.entries.push({ entry: source.entry, sortTimestamp: source.sortTimestamp });
  }

  const finalized = [...roots.values()].map((node) => finalizeNode(node, customNames));
  if (unknown) finalized.push(finalizeNode(unknown, customNames));
  finalized.sort((left, right) => {
    if (left.synthetic !== right.synthetic) return left.synthetic ? 1 : -1;
    const latestOrder = right.latestTimestamp - left.latestTimestamp;
    return latestOrder || (left.customName ?? left.name).localeCompare(right.customName ?? right.name);
  });

  return {
    roots: finalized,
    totalSessions: sources.length,
    directoryCount: realDirectories.size,
  };
}
