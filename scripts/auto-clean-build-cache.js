#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDeploymentLock, releaseDeploymentLock } from "../src/deployment-lock.ts";
import { main as cleanCaches } from "./clean-build-cache.js";

export const RETENTION_DAYS = 7;
const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ARCHIVE_CACHE_NAMES = [
  "Build/Intermediates.noindex", "ModuleCache.noindex", "SDKStatCaches.noindex",
  "SDKExplicitPrecompiledModules", "Index.noindex", "CompilationCache.noindex",
];
const PRUNED_NAMES = new Set([".git", "node_modules", "SourcePackages", "Build", "Logs"]);

function assertPlainPath(target) {
  for (let current = target; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link: ${current}`);
    }
    if (current === path.dirname(current)) break;
  }
}

/** Discover Xcode's own DerivedData marker, not arbitrary directories named Build. */
export function discoverArchiveCaches(repoRoot) {
  const output = path.join(repoRoot, "output");
  assertPlainPath(output);
  if (!existsSync(output)) return [];
  const found = [];
  let visited = 0;
  function visit(directory, depth) {
    if (++visited > 10_000) throw new Error("Archive discovery limit exceeded; nothing removed.");
    const marker = path.join(directory, "info.plist");
    if (existsSync(marker) && !lstatSync(marker).isSymbolicLink()
      && lstatSync(marker).isFile()
      && existsSync(path.join(directory, "Logs"))) {
      for (const name of ARCHIVE_CACHE_NAMES) {
        const target = path.join(directory, name);
        if (existsSync(target)) found.push(path.relative(repoRoot, target));
      }
      return;
    }
    if (depth >= 6) return;
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some(entry => entry.name === ".git")) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !PRUNED_NAMES.has(entry.name)
        && !entry.name.startsWith("node_modules-")) {
        visit(path.join(directory, entry.name), depth + 1);
      }
    }
  }
  visit(output, 0);
  return found;
}

function archiveRoot(target) {
  return path.basename(target) === "Intermediates.noindex"
    ? path.dirname(path.dirname(target)) : path.dirname(target);
}

/** No command-line arguments, environment values or open-file lists enter logs. */
export function inspectActivity(scope) {
  try {
    const processes = execFileSync("/bin/ps", ["-axo", "comm="], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    });
    // Xcode may reopen cache files later; absence of a currently open FD is not sufficient.
    if (processes.split("\n").some(command =>
      /^(xcodebuild|swift-frontend|clang|clang\+\+)$/.test(path.basename(command.trim())))) {
      return "compiler-active";
    }
    // Initial global check is compiler-only. A runtime under an unrelated output/
    // subtree must not prevent cleanup of every old archive indefinitely.
    if (scope === null) return null;
    const result = spawnSync("/usr/sbin/lsof", ["-nP", "-F", "n"], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || result.stderr.trim()) return "activity-check-failed";
    if (result.stdout.split("\n").some(line => line === `n${scope}` || line.startsWith(`n${scope}/`))) {
      return "archive-in-use";
    }
    return null;
  } catch {
    return "activity-check-failed";
  }
}

export function main(argv = process.argv.slice(2), options = {}) {
  for (const arg of argv) {
    if (arg !== "--apply" && arg !== "--help") throw new Error(`Unknown argument: ${arg}`);
  }
  const write = options.write ?? console.log;
  if (argv.includes("--help")) {
    write("Usage: node scripts/auto-clean-build-cache.js [--apply]\nDaily-safe archive-only cleanup: seven days of inactivity, build lock and open-file checks. Defaults to preview.");
    return { skipped: "help" };
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Automatic cleanup requires macOS activity checks.");
  }
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_ROOT);
  assertPlainPath(repoRoot);
  const now = options.now ?? Date.now();
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const activity = options.inspectActivity ?? inspectActivity;
  const lockPath = path.join(repoRoot, ".wand-build-lock");
  assertPlainPath(lockPath);
  let lock;
  try {
    lock = acquireDeploymentLock(lockPath);
  } catch (error) {
    if (existsSync(lockPath)) {
      write("Skipped: project build/deployment lock busy (never reclaim stale locks automatically).");
      return { skipped: "build-lock-busy" };
    }
    throw error;
  }
  try {
    const busy = activity(null);
    if (busy) {
      write(`Skipped: ${busy}.`);
      return { skipped: busy };
    }
    const cachePaths = discoverArchiveCaches(repoRoot);
    const eligible = cache => {
      const marker = lstatSync(path.join(archiveRoot(cache.target), "info.plist"));
      return Math.max(cache.lastActivityMs, marker.mtimeMs, marker.ctimeMs) < cutoff;
    };
    const result = cleanCaches(argv.includes("--apply") ? ["--apply"] : [], {
      repoRoot, cachePaths, eligible, write,
      beforeRemove: cache => {
        const reason = activity(archiveRoot(cache.target));
        if (reason) write(`Skipped: ${reason} (${path.relative(repoRoot, cache.target)}).`);
        return !reason;
      },
    });
    return { ...result, retentionDays: RETENTION_DAYS };
  } finally {
    releaseDeploymentLock(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`[${new Date().toISOString()}] Archive cache cleanup`);
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Automatic cleanup failed.");
    process.exitCode = 1;
  }
}
