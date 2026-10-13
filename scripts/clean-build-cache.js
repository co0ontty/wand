#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DERIVED_DATA_PATHS = [
  "ios/build/dd",
  "macos/build/dd",
  "macos/.debug-derived-data",
  "macos/.release-derived-data",
];
const DERIVED_CACHE_DIRS = [
  "Build", "ModuleCache.noindex", "SDKStatCaches.noindex",
  "SDKExplicitPrecompiledModules", "Index.noindex", "CompilationCache.noindex",
];

export const CACHE_PATHS = Object.freeze([
  "android/app/build",
  "android/build",
  "android/.gradle",
  // Keep SourcePackages Git checkouts and diagnostic logs in every derived-data tree.
  ...DERIVED_DATA_PATHS.flatMap((base) => DERIVED_CACHE_DIRS.map((name) => `${base}/${name}`)),
  "render/target/debug",
]);

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));

function assertNoSymlink(target) {
  const parts = [];
  for (let current = target; ; current = path.dirname(current)) {
    parts.unshift(current);
    if (current === path.dirname(current)) break;
  }
  for (const current of parts) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing symbolic link: ${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

function git(cwd, args, allowedStatuses = [0]) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowedStatuses.includes(error.status)) return null;
    throw new Error(`Git safety check failed in ${cwd}; no further cache will be removed.`);
  }
}

export function checkCandidate(repoRoot, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Refusing cache outside repository: ${relativePath}`);
  }
  const target = path.join(repoRoot, relativePath);
  if (!assertNoSymlink(target)) return null;
  if (!lstatSync(target).isDirectory()) {
    throw new Error(`Refusing non-directory cache: ${relativePath}`);
  }
  const worktree = git(path.dirname(target), ["rev-parse", "--show-toplevel"]).trim();
  const submoduleRoot = path.join(repoRoot, relativePath.split("/")[0]);
  if (worktree !== repoRoot && worktree !== submoduleRoot) {
    throw new Error(`Unexpected Git worktree for ${relativePath}`);
  }
  const gitPath = path.relative(worktree, target).split(path.sep).join("/");
  if (git(worktree, ["ls-files", "-z", "--", gitPath]).length > 0) {
    throw new Error(`Refusing cache containing tracked files: ${relativePath}`);
  }
  if (git(worktree, ["check-ignore", "--quiet", "--", gitPath], [1]) === null) {
    throw new Error(`Refusing cache not ignored by Git: ${relativePath}`);
  }
  return { target, ...directoryStats(target) };
}

function directoryStats(directory) {
  const rootStat = lstatSync(directory);
  let bytes = 0;
  let allocatedBytes = rootStat.blocks * 512;
  let lastActivityMs = Math.max(rootStat.mtimeMs, rootStat.ctimeMs);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.name === ".git") throw new Error(`Refusing nested Git metadata: ${target}`);
    const stat = lstatSync(target);
    const child = stat.isDirectory() ? directoryStats(target) : {
      bytes: stat.size,
      allocatedBytes: stat.blocks * 512,
      lastActivityMs: Math.max(stat.mtimeMs, stat.ctimeMs),
    };
    bytes += child.bytes;
    allocatedBytes += child.allocatedBytes;
    lastActivityMs = Math.max(lastActivityMs, child.lastActivityMs);
  }
  return { bytes, allocatedBytes, lastActivityMs };
}

export function main(argv = process.argv.slice(2), options = {}) {
  for (const arg of argv) {
    if (arg !== "--apply" && arg !== "--help") throw new Error(`Unknown argument: ${arg}`);
  }
  const write = options.write ?? console.log;
  if (argv.includes("--help")) {
    write("Usage: node scripts/clean-build-cache.js [--apply]\nDefaults to preview; removes only ignored, untracked build caches from a fixed list.");
    return { applied: false, candidates: [], totalBytes: 0 };
  }
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_ROOT);
  if (!assertNoSymlink(repoRoot)) throw new Error("Repository root does not exist.");
  if (git(repoRoot, ["rev-parse", "--show-toplevel"]).trim() !== repoRoot) {
    throw new Error("The cache cleaner must run against the repository root.");
  }
  const candidates = [];
  for (const relativePath of options.cachePaths ?? CACHE_PATHS) {
    const cache = checkCandidate(repoRoot, relativePath);
    if (cache && (!options.eligible || options.eligible(cache))) {
      candidates.push({ path: relativePath, ...cache });
    }
  }
  const applied = argv.includes("--apply");
  const totalBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  const totalAllocatedBytes = candidates.reduce((total, candidate) => total + candidate.allocatedBytes, 0);
  const removed = [];
  for (const candidate of candidates) {
    let displayed = candidate;
    if (applied) {
      const cache = checkCandidate(repoRoot, candidate.path);
      if (!cache || (options.eligible && !options.eligible(cache))
        || (options.beforeRemove && !options.beforeRemove(cache))) {
        write(`Skipped ${candidate.path} (missing, changed, or in use)`);
        continue;
      }
      // Activity inspection can take time; revalidate age/paths after it as well.
      const latest = options.beforeRemove ? checkCandidate(repoRoot, candidate.path) : cache;
      if (!latest || (options.eligible && !options.eligible(latest))) {
        write(`Skipped ${candidate.path} (changed during activity inspection)`);
        continue;
      }
      rmSync(latest.target, { recursive: true });
      displayed = { path: candidate.path, ...latest };
      removed.push(displayed);
    }
    write(`${applied ? "Removed" : "Would remove"} ${candidate.path} (${displayed.allocatedBytes} allocated bytes; ${displayed.bytes} logical bytes)`);
  }
  const allocatedBytes = applied
    ? removed.reduce((total, candidate) => total + candidate.allocatedBytes, 0) : totalAllocatedBytes;
  write(`${applied ? "Removed" : "Preview"}: ${applied ? removed.length : candidates.length} caches, ${allocatedBytes} allocated bytes (APFS shared blocks may differ from free-space gain).`);
  if (!applied) write("Run with --apply to remove these caches. Release binaries and distribution files are preserved.");
  return { applied, candidates, removed, totalBytes, totalAllocatedBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
