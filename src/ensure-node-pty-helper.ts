// node-pty's prebuilt `spawn-helper` ships in node_modules without the
// executable bit on some npm/tar combinations (npm/cli#8131). On macOS,
// posix_spawn against a non-executable file returns EACCES and node-pty
// throws "posix_spawnp failed." — every PTY session fails before it starts.
//
// Locates node-pty wherever it actually lives (dev repo, hoisted global,
// pnpm store …) via require.resolve, finds the per-arch prebuilds dir the
// loaded binary is in, and ensures the helper next to it is +x. Idempotent
// and best-effort: silent on the happy path, warns on failure but never
// blocks startup.
//
// Called both once at server startup AND right before every PTY spawn. The
// per-spawn call is what makes this self-heal: a self-update (`npm install
// -g`) reinstalls node-pty and re-drops the bit, and that extraction can
// land *after* the relaunched server already ran its startup chmod — so a
// startup-only fix leaves every subsequent PTY launch broken until the next
// restart. Re-checking before each spawn closes that race (the resolve is
// cached, the happy path is a single stat + early return).

import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { getErrorMessage } from "./error-utils.js";

const requireFromHere = createRequire(import.meta.url);

// Cache the resolved helper path: `null` = not yet resolved, `""` = resolved
// to "no helper on this platform/install" (don't retry).
let cachedHelperPath: string | null | "" = null;

function resolveHelperPath(): string {
  if (cachedHelperPath !== null) return cachedHelperPath;
  // spawn-helper is only used on Unix-likes. Windows uses winpty / conpty.
  if (process.platform === "win32") return (cachedHelperPath = "");
  let nodePtyEntry: string;
  try {
    nodePtyEntry = requireFromHere.resolve("node-pty");
  } catch {
    return (cachedHelperPath = "");
  }
  // node-pty's lib/index.js sits at <pkg>/lib/index.js; helper lives at
  // <pkg>/prebuilds/<platform>-<arch>/spawn-helper.
  const pkgRoot = path.resolve(path.dirname(nodePtyEntry), "..");
  const arch = `${process.platform}-${process.arch}`;
  return (cachedHelperPath = path.join(pkgRoot, "prebuilds", arch, "spawn-helper"));
}

export function ensureNodePtyHelperExecutable(): void {
  const helper = resolveHelperPath();
  if (!helper || !existsSync(helper)) return;

  let mode: number;
  try {
    mode = statSync(helper).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o111) === 0o111) return;

  try {
    chmodSync(helper, mode | 0o755);
    process.stderr.write(`[wand] Restored +x on ${helper} (npm dropped the bit on install)\n`);
  } catch (err) {
    process.stderr.write(
      `[wand] Warning: could not chmod +x ${helper}: ${getErrorMessage(err)}\n`
        + `[wand] PTY sessions may fail to start. Run: chmod +x ${JSON.stringify(helper)}\n`,
    );
  }
}
