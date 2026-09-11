// node-pty's prebuilt `spawn-helper` ships in node_modules without the
// executable bit on some npm/tar combinations (npm/cli#8131). On macOS,
// posix_spawn against a non-executable file returns EACCES and node-pty
// throws "posix_spawnp failed." — every PTY session fails before it starts.
//
// Locates node-pty wherever it actually lives (dev repo, hoisted global,
// pnpm store …) via require.resolve, finds the per-arch prebuilds dir the
// loaded binary is in, and ensures the helper is actually executable.
//
// Two repair paths:
//   1. chmod +x the vendor helper (works when we own the file).
//   2. If chmod is denied (root-owned global install), copy the helper to a
//      user-writable cache and rewrite node-pty's native `fork` helperPath.
//      In-place chmod cannot fix a root-owned 644 file, and the native addon
//      receives the helper path as an argument, so a writable copy is enough.
//
// Called both once at server/daemon startup AND right before every PTY spawn.
// The per-spawn call is what makes this self-heal: a self-update (`npm install
// -g`) reinstalls node-pty and re-drops the bit, and that extraction can
// land *after* the relaunched server already ran its startup chmod.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { getErrorMessage } from "./error-utils.js";

const requireFromHere = createRequire(import.meta.url);

// Cache the resolved vendor helper path: `null` = not yet resolved, `""` =
// resolved to "no helper on this platform/install" (don't retry).
let cachedVendorHelperPath: string | null | "" = null;
let nativeForkPatched = false;
let patchedVendorHelperPath: string | null = null;
let patchedExecutableHelperPath: string | null = null;

function resolveVendorHelperPath(): string {
  if (cachedVendorHelperPath !== null) return cachedVendorHelperPath;
  // spawn-helper is only used on Unix-likes. Windows uses winpty / conpty.
  if (process.platform === "win32") return (cachedVendorHelperPath = "");
  let nodePtyEntry: string;
  try {
    nodePtyEntry = requireFromHere.resolve("node-pty");
  } catch {
    return (cachedVendorHelperPath = "");
  }
  // node-pty's lib/index.js sits at <pkg>/lib/index.js; helper lives at
  // <pkg>/prebuilds/<platform>-<arch>/spawn-helper.
  const pkgRoot = path.resolve(path.dirname(nodePtyEntry), "..");
  const arch = `${process.platform}-${process.arch}`;
  return (cachedVendorHelperPath = path.join(pkgRoot, "prebuilds", arch, "spawn-helper"));
}

function isExecutable(filePath: string): boolean {
  try {
    return (statSync(filePath).mode & 0o111) === 0o111;
  } catch {
    return false;
  }
}

function helperCacheDir(): string {
  return path.join(os.tmpdir(), "wand-pty-helpers");
}

function copyHelperToWritableCache(source: string): string {
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const dir = helperCacheDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `${digest}-spawn-helper`);
  if (!existsSync(dest)) {
    copyFileSync(source, dest);
  }
  if (!isExecutable(dest)) {
    chmodSync(dest, 0o755);
  }
  return dest;
}

function installNativeHelperPathPatch(vendorPath: string, executablePath: string): void {
  patchedVendorHelperPath = vendorPath;
  patchedExecutableHelperPath = executablePath;
  if (nativeForkPatched || process.platform === "win32" || vendorPath === executablePath) return;

  const utils = requireFromHere("node-pty/lib/utils.js") as {
    loadNativeModule: (name: string) => { module: { fork: (...args: unknown[]) => unknown } };
  };
  const native = utils.loadNativeModule("pty");
  const originalFork = native.module.fork.bind(native.module);
  native.module.fork = (...args: unknown[]) => {
    if (typeof args[9] === "string" && patchedVendorHelperPath && patchedExecutableHelperPath) {
      const requested = args[9];
      const resolvedRequested = path.resolve(requested);
      if (
        requested === patchedVendorHelperPath
        || resolvedRequested === patchedVendorHelperPath
        || resolvedRequested === path.resolve(patchedVendorHelperPath)
      ) {
        args[9] = patchedExecutableHelperPath;
      }
    }
    return originalFork(...args);
  };
  nativeForkPatched = true;
  process.stderr.write(
    `[wand] Using writable node-pty spawn-helper copy at ${executablePath}\n`,
  );
}

export interface SpawnHelperRepair {
  vendorPath: string;
  helperPath: string;
  copied: boolean;
}

/** Repair one spawn-helper file. Exported for tests. */
export function repairSpawnHelperFile(vendorPath: string): SpawnHelperRepair {
  if (!vendorPath || !existsSync(vendorPath)) {
    return { vendorPath, helperPath: vendorPath, copied: false };
  }
  if (isExecutable(vendorPath)) {
    return { vendorPath, helperPath: vendorPath, copied: false };
  }

  try {
    const mode = statSync(vendorPath).mode & 0o777;
    chmodSync(vendorPath, mode | 0o755);
    process.stderr.write(`[wand] Restored +x on ${vendorPath} (npm dropped the bit on install)\n`);
    return { vendorPath, helperPath: vendorPath, copied: false };
  } catch (err) {
    try {
      const copiedPath = copyHelperToWritableCache(vendorPath);
      process.stderr.write(
        `[wand] Warning: could not chmod +x ${vendorPath}: ${getErrorMessage(err)}\n`
          + `[wand] Copied spawn-helper to ${copiedPath}\n`,
      );
      return { vendorPath, helperPath: copiedPath, copied: true };
    } catch (copyErr) {
      process.stderr.write(
        `[wand] Warning: could not chmod +x ${vendorPath}: ${getErrorMessage(err)}\n`
          + `[wand] Also failed to copy spawn-helper: ${getErrorMessage(copyErr)}\n`
          + `[wand] PTY sessions may fail to start. Run: chmod +x ${JSON.stringify(vendorPath)}\n`,
      );
      return { vendorPath, helperPath: vendorPath, copied: false };
    }
  }
}

export function ensureNodePtyHelperExecutable(): void {
  const vendorPath = resolveVendorHelperPath();
  if (!vendorPath) return;
  const repaired = repairSpawnHelperFile(vendorPath);
  if (repaired.copied) {
    try {
      installNativeHelperPathPatch(repaired.vendorPath, repaired.helperPath);
    } catch (err) {
      process.stderr.write(
        `[wand] Warning: could not redirect node-pty spawn-helper: ${getErrorMessage(err)}\n`,
      );
    }
  }
}

export function describePtySpawnFailure(error: unknown): string {
  const message = getErrorMessage(error, "无法启动终端。");
  if (/posix_spawnp failed/i.test(message)) {
    return "无法启动终端：node-pty 的 spawn-helper 不可执行。请重新安装 Wand，或对该文件执行 chmod +x。";
  }
  return message;
}
