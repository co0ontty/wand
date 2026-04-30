// node-pty's prebuilt `spawn-helper` ships in node_modules without the
// executable bit on some npm/tar combinations (npm/cli#8131). On macOS,
// posix_spawn against a non-executable file returns EACCES and node-pty
// throws "posix_spawnp failed." — every PTY session fails before it starts.
//
// Run once on server startup. Locates node-pty wherever it actually lives
// (dev repo, hoisted global, pnpm store …) via require.resolve, finds the
// per-arch prebuilds dir the loaded binary is in, and ensures the helper
// next to it is +x. Idempotent and best-effort: silent on the happy path,
// warns on failure but never blocks startup.

import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const requireFromHere = createRequire(import.meta.url);

export function ensureNodePtyHelperExecutable(): void {
  // spawn-helper is only used on Unix-likes. Windows uses winpty / conpty.
  if (process.platform === "win32") return;

  let nodePtyEntry: string;
  try {
    nodePtyEntry = requireFromHere.resolve("node-pty");
  } catch {
    return;
  }

  // node-pty's lib/index.js sits at <pkg>/lib/index.js; helper lives at
  // <pkg>/prebuilds/<platform>-<arch>/spawn-helper.
  const pkgRoot = path.resolve(path.dirname(nodePtyEntry), "..");
  const arch = `${process.platform}-${process.arch}`;
  const helper = path.join(pkgRoot, "prebuilds", arch, "spawn-helper");

  if (!existsSync(helper)) return;

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
      `[wand] Warning: could not chmod +x ${helper}: ${err instanceof Error ? err.message : String(err)}\n`
        + `[wand] PTY sessions may fail to start. Run: chmod +x ${JSON.stringify(helper)}\n`,
    );
  }
}
