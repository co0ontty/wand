import { lstatSync, rmSync } from "node:fs";
import path from "node:path";

import { logInfo } from "./runtime-log.js";

/** Remove only a caller-identified session artifact beneath a trusted CLI root.
 * Never traverse project/cache symlinks into another directory. rm itself does
 * not follow symlinks inside a session-owned directory either.
 */
export function removeSessionArtifact(root: string, relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..") || path.isAbsolute(relative)) return false;
  let target = root;
  try {
    for (const part of parts) {
      target = path.join(target, part);
      if (lstatSync(target).isSymbolicLink()) {
        logInfo("[SessionCleanup] Skipped a symlink in a CLI session artifact path.");
        return false;
      }
    }
    rmSync(target, { recursive: true });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") logInfo(`[SessionCleanup] CLI session artifact removal failed (${code ?? "unknown"}).`);
    return false;
  }
}

/** A stop signal is not an exit acknowledgement. Fail closed on timeout. */
export function waitForSessionProcessExit(subscribe: (done: () => void) => () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let dispose = () => {};
    let acknowledged = false;
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("CLI exit was not acknowledged; session artifacts were preserved."));
    }, 30_000);
    timer.unref();
    dispose = subscribe(() => { acknowledged = true; clearTimeout(timer); dispose(); resolve(); });
    if (acknowledged) dispose();
  });
}
