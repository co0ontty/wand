import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Component content, not the Wand release version or timestamp. The runtime
 * import graph is covered by tests/terminal-daemon-build.test.ts. */
function daemonBuildId(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const hash = createHash("sha256");
  hash.update(JSON.stringify([process.versions.node, process.platform, process.arch]));
  for (const name of ["terminal-daemon-server", "terminal-daemon-protocol", "terminal-daemon-build", "terminal-host",
    "structured-exec-host", "pty-terminal-state", "pty-shell-launch", "unix-socket-keepalive",
    "ensure-node-pty-helper", "signal-utils", "pty-text-utils", "shell-quote", "error-utils", "render-protocol"]) {
    hash.update(name).update("\0").update(readFileSync(new URL(`./${name}.${extension}`, import.meta.url)));
  }
  // Read installed versions afresh, not require()'s cached JSON. Unrelated
  // Server/UI dependencies and package metadata must not replace terminald.
  for (const name of ["node-pty", "@xterm/headless", "@xterm/addon-serialize", "@xterm/addon-unicode11"]) {
    const { version } = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8"));
    if (typeof version !== "string" || !version) throw new Error(`Missing daemon dependency version: ${name}`);
    hash.update(name).update("\0").update(version);
  }
  return hash.digest("hex");
}

/** Captured at process start: replacing files cannot make an old owner current. */
export const TERMINAL_DAEMON_BUILD_ID = daemonBuildId();

// The installation fence has a different purpose from component equality:
// even a Server-only install must pause the old worker until Server relaunch.
function installationId(buildId: string): string {
  const hash = createHash("sha256").update(buildId);
  for (const file of ["./build-info.json", "../package.json"]) {
    hash.update(file).update("\0");
    try { hash.update(readFileSync(new URL(file, import.meta.url))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing"); // source checkouts have no build stamp
    }
  }
  return hash.digest("hex");
}

const INSTALLATION_ID = installationId(TERMINAL_DAEMON_BUILD_ID);

/** Pause replacement while npm is changing this installation or awaiting Server relaunch. */
export function terminalDaemonBuildIsCurrent(): boolean {
  try { return installationId(daemonBuildId()) === INSTALLATION_ID; }
  catch { return false; }
}
