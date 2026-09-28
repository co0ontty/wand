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

function checkCandidate(repoRoot, relativePath) {
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
  return { target, bytes: directoryBytes(target) };
}

function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.name === ".git") throw new Error(`Refusing nested Git metadata: ${target}`);
    const stat = lstatSync(target);
    bytes += stat.isDirectory() ? directoryBytes(target) : stat.size;
  }
  return bytes;
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
  for (const relativePath of CACHE_PATHS) {
    const cache = checkCandidate(repoRoot, relativePath);
    if (cache) candidates.push({ path: relativePath, bytes: cache.bytes });
  }
  const applied = argv.includes("--apply");
  const totalBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  for (const candidate of candidates) {
    if (applied) {
      const cache = checkCandidate(repoRoot, candidate.path);
      if (cache) rmSync(cache.target, { recursive: true });
    }
    write(`${applied ? "Removed" : "Would remove"} ${candidate.path} (${candidate.bytes} bytes)`);
  }
  write(`${applied ? "Removed" : "Preview"}: ${candidates.length} caches, ${totalBytes} bytes.`);
  if (!applied) write("Run with --apply to remove these caches. Release binaries and distribution files are preserved.");
  return { applied, candidates, totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
