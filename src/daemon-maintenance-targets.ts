import { createHash } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { DaemonInspection, DaemonMaintenanceTarget } from "./daemon-maintenance.js";
import { readRenderBinaryVersion, resolveRenderBinaryPath } from "./render-binary.js";
import { RenderDaemonClient } from "./render-daemon-client.js";
import { createRenderTerminalHost, shouldUpgradeRenderDaemon, type UpgradeAwareTerminalHost } from "./render-host.js";
import { renderPaths } from "./render-protocol.js";
import { resolveStructuredRenderBinary, startStructuredRenderHost } from "./render-structured-host.js";
import type { RenderStructuredClient } from "./render-structured-client.js";
import { structuredRenderPaths } from "./render-structured-protocol.js";
import { createTerminalHost } from "./terminal-daemon-client.js";
import { TERMINAL_DAEMON_BUILD_ID } from "./terminal-daemon-build.js";
import { terminalDaemonPaths } from "./terminal-daemon-protocol.js";

interface OwnerSnapshot extends DaemonInspection { pid: number; atomicShutdown?: boolean }
interface ShutdownCheckpoint { identity: string; pid: number }

function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error; // permission/unknown is never evidence of an idle or dead owner
  }
}

function readCheckpoint(file: string): ShutdownCheckpoint | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as ShutdownCheckpoint;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.identity !== "string") {
      throw new Error("Invalid daemon maintenance checkpoint");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function identity(pid: unknown, tokenPath: string): { identity: string; pid: number } {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Daemon did not report an authenticated PID");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error("Daemon credentials are unavailable");
  return { pid, identity: `${pid}:${createHash("sha256").update(token).digest("hex")}` };
}

/** Unknown/malformed inventories must not be interpreted as zero live sessions. */
export function countRunningDaemonEntries(value: unknown): number {
  if (!Array.isArray(value)) throw new Error("Daemon inventory is unavailable");
  let running = 0;
  for (const entry of value) {
    if (!entry || (entry.status !== "running" && entry.status !== "exited")) throw new Error("Daemon inventory has unknown state");
    if (entry.status === "running") running++;
  }
  return running;
}

/** Persist the once-only shutdown intent: a second Render drain escalates to kill. */
export function persistentDaemonTarget(options: {
  name: string;
  checkpointPath: string;
  snapshot(includeInventory?: boolean): Promise<OwnerSnapshot>;
  shutdown(snapshot: OwnerSnapshot): Promise<boolean | void>;
  ensure(): Promise<void>;
  reconnect(): Promise<void>;
}): DaemonMaintenanceTarget {
  const recover = async (): Promise<void> => {
    const checkpoint = readCheckpoint(options.checkpointPath);
    if (checkpoint && !live(checkpoint.pid)) {
      await options.ensure();
      await options.reconnect();
    }
  };
  return {
    name: options.name,
    async inspect(includeInventory = true) {
      await recover();
      const snapshot = await options.snapshot(includeInventory);
      if (!snapshot.pending && readCheckpoint(options.checkpointPath)) unlinkSync(options.checkpointPath);
      return snapshot;
    },
    async restart(expected) {
      const current = await options.snapshot();
      if (current.identity !== expected.identity || !current.pending || current.running !== 0) {
        throw new Error(`${options.name} changed while preparing its update`);
      }
      const checkpoint = readCheckpoint(options.checkpointPath);
      if (checkpoint?.identity !== current.identity) {
        const temporary = `${options.checkpointPath}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ identity: current.identity, pid: current.pid }), { mode: 0o600 });
        renameSync(temporary, options.checkpointPath);
        if (await options.shutdown(current) === false) {
          unlinkSync(options.checkpointPath); // explicit refusal: no shutdown was accepted
          throw new Error(`${options.name} became busy; leaving it alive`);
        }
      }
      const deadline = Date.now() + 5_000;
      while (live(current.pid)) {
        if (Date.now() >= deadline) throw new Error(`${options.name} is still draining; leaving it alive`);
        await delay(50);
      }
      await options.ensure();
      // Existing manager/host references remain valid across token rotation.
      await options.reconnect();
      const replacement = await options.snapshot();
      if (replacement.identity === current.identity || replacement.pending) throw new Error(`${options.name} replacement is not current`);
      unlinkSync(options.checkpointPath);
    },
  };
}

export async function createDaemonMaintenanceTargets(
  configPath: string,
  pty: UpgradeAwareTerminalHost,
  structured: RenderStructuredClient | null,
  configuredRenderBinary?: string,
): Promise<DaemonMaintenanceTarget[]> {
  const targets: DaemonMaintenanceTarget[] = [];
  const render = pty.renderHost;
  if (render instanceof RenderDaemonClient) {
    const binary = configuredRenderBinary?.trim() || resolveRenderBinaryPath(configPath);
    const version = binary ? await readRenderBinaryVersion(binary) : null;
    const paths = renderPaths(configPath);
    targets.push(persistentDaemonTarget({
      name: "Render", checkpointPath: `${paths.tokenPath}.update.json`,
      async snapshot(includeInventory = true) {
        const { hello, sessions } = await render.maintenanceSnapshot(includeInventory);
        return { ...identity(hello.pid, paths.tokenPath),
          pending: shouldUpgradeRenderDaemon(hello.version, version, 0), running: includeInventory ? countRunningDaemonEntries(sessions) : null };
      },
      shutdown: () => render.requestShutdownDrain(),
      async ensure() { const client = await createRenderTerminalHost(configPath, { binaryPath: binary ?? undefined }); client.disconnect(); },
      reconnect: () => render.connect(),
    }));
  }
  const legacy = pty.legacyHost;
  if (legacy) {
    const paths = terminalDaemonPaths(configPath);
    targets.push(persistentDaemonTarget({
      name: "terminald", checkpointPath: `${paths.tokenPath}.update.json`,
      async snapshot(includeInventory = true) {
        const hello = await legacy.request("hello") as { pid: number; buildId?: string; shutdownIfIdle?: boolean };
        let running: number | null = null;
        if (includeInventory) {
          const [sessions, runs] = await Promise.all([legacy.request("list"), legacy.request("structuredList")]);
          running = countRunningDaemonEntries(sessions) + countRunningDaemonEntries(runs);
        }
        return { ...identity(hello.pid, paths.tokenPath), pending: hello.buildId !== TERMINAL_DAEMON_BUILD_ID,
          running, atomicShutdown: hello.shutdownIfIdle === true };
      },
      async shutdown(snapshot) {
        if (snapshot.atomicShutdown) {
          const result = await legacy.request("shutdownIfIdle") as { accepted?: boolean };
          if (result?.accepted === false) return false;
          if (result?.accepted !== true) throw new Error("terminald shutdown result is unknown");
        } else {
          // One-time migration for pre-capability terminald. Server is the sole
          // execution admission owner; both RPC inventories were checked under
          // its shared barrier. Never signal a guessed pid or escalate to KILL.
          const hello = await legacy.request("hello") as { pid: number };
          if (identity(hello.pid, paths.tokenPath).identity !== snapshot.identity) throw new Error("terminald owner changed");
          process.kill(snapshot.pid, "SIGTERM");
        }
      },
      async ensure() { const client = await createTerminalHost(configPath); client.disconnect(); },
      reconnect: () => legacy.connect(),
    }));
  }
  if (structured) {
    const binary = resolveStructuredRenderBinary(configPath);
    // v1 and v2 are separately released; never read the sibling PTY sidecar.
    const version = binary ? await readRenderBinaryVersion(binary, `${binary}.version`) : null;
    const paths = structuredRenderPaths(configPath);
    targets.push(persistentDaemonTarget({
      name: "Structured Render", checkpointPath: `${paths.tokenPath}.update.json`,
      async snapshot(includeInventory = true) {
        const hello = await structured.request("hello") as { pid: number; version: string };
        const result = includeInventory ? await structured.request("list") as { runs: unknown } : null;
        return { ...identity(hello.pid, paths.tokenPath), pending: shouldUpgradeRenderDaemon(hello.version, version, 0),
          running: result ? countRunningDaemonEntries(result.runs) : null };
      },
      async shutdown() { await structured.request("shutdown", { mode: "drain" }); },
      async ensure() { const client = await startStructuredRenderHost(configPath); client.disconnect(); },
      reconnect: () => structured.connect(),
    }));
  }
  return targets;
}
