import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getErrorMessage } from "./error-utils.js";
import { currentRenderTriple, isExecutableFile } from "./render-binary.js";
import { RenderStructuredClient } from "./render-structured-client.js";
import { structuredRenderPaths } from "./render-structured-protocol.js";
import type {
  StructuredExecHost, StructuredExecProcess, StructuredRunState, StructuredSpawnRequest,
} from "./structured-exec-host.js";

const READY_TIMEOUT_MS = 5_000;

type Owner = "legacy" | "rust";

/** Resolve the separate v2 executable; do not confuse it with PTY v1 wand-render. */
export function resolveStructuredRenderBinary(configPath: string): string | null {
  const explicit = process.env.WAND_STRUCTURED_RENDER_BIN?.trim();
  if (explicit) {
    if (!isExecutableFile(explicit)) throw new Error("WAND_STRUCTURED_RENDER_BIN is not executable");
    return explicit;
  }
  const binary = process.platform === "win32" ? "wand-structured-renderd.exe" : "wand-structured-renderd";
  const root = path.resolve(import.meta.dirname, "..");
  const choices = [
    path.join(root, "render", "target", "release", binary),
    path.join(root, "render", "target", "debug", binary),
    path.join(path.dirname(configPath), "bin", binary),
    path.join(root, "dist", "native", currentRenderTriple(), binary),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, binary)),
  ];
  return choices.find(isExecutableFile) ?? null;
}

function livePid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? -1 : null;
  }
}

async function socketIsListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let done = false;
    const finish = (listening: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => finish(false), 250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function connectExisting(configPath: string): Promise<RenderStructuredClient | null> {
  const paths = structuredRenderPaths(configPath);
  if (!existsSync(paths.socketPath)) return null;
  const client = new RenderStructuredClient(configPath);
  try {
    await client.connect();
    return client;
  } catch (error) {
    client.disconnect();
    if (await socketIsListening(paths.socketPath) || livePid(paths.pidPath) !== null) {
      throw new Error(`Structured Render endpoint exists but refused adoption: ${getErrorMessage(error)}`);
    }
    // Only remove our own private, unlistened stale socket. Never unlink a
    // foreign path or race a live daemon's startup/credential rotation.
    const stat = lstatSync(paths.socketPath);
    const ownUid = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isSocket() || !ownUid || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Structured Render endpoint is not a private socket; refusing cleanup");
    }
    unlinkSync(paths.socketPath);
    return null;
  }
}

async function startV2(configPath: string): Promise<RenderStructuredClient> {
  const existing = await connectExisting(configPath);
  if (existing) return existing;
  const paths = structuredRenderPaths(configPath);
  if (livePid(paths.pidPath) !== null) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const starting = await connectExisting(configPath);
      if (starting) return starting;
      await delay(50);
    }
    throw new Error("Structured Render PID is alive but its socket is unavailable; refusing a competing daemon");
  }
  const binary = resolveStructuredRenderBinary(configPath);
  if (!binary) throw new Error("structured.processHost=rust requires a v2 binary; build wand-structured-renderd or set WAND_STRUCTURED_RENDER_BIN");
  const child = spawn(binary, ["--config", configPath], {
    detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env,
  });
  child.on("error", (error) => process.stderr.write(`[wand] Structured Render launch failed: ${getErrorMessage(error)}\n`));
  child.unref();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const client = await connectExisting(configPath);
      if (client) return client;
    } catch (error) {
      // A live but incompatible owner must not be replaced or silently downgraded.
      throw error;
    }
    await delay(50);
  }
  if (child.pid) { try { process.kill(child.pid, "SIGTERM"); } catch { /* child already exited */ } }
  throw new Error("Structured Render v2 did not become ready; refusing legacy fallback");
}

/**
 * A stable runId can belong to exactly one persistent daemon. Configuration
 * chooses only new runs; existing owners are always resolved by inventories.
 */
export class CompositeStructuredExecHost implements StructuredExecHost {
  readonly persistent = true;
  private readonly owners = new Map<string, Owner>();
  private readonly starting = new Map<string, Promise<StructuredExecProcess>>();

  constructor(
    private readonly legacy: StructuredExecHost | null,
    private readonly rust: StructuredExecHost | null,
    private readonly newOwner: Owner,
  ) {
    if (!legacy && !rust) throw new Error("at least one structured daemon is required");
  }

  private getHost(owner: Owner): StructuredExecHost | null {
    return owner === "legacy" ? this.legacy : this.rust;
  }

  async listRuns(): Promise<StructuredRunState[]> {
    const [legacyRuns, rustRuns] = await Promise.all([
      this.legacy?.listRuns() ?? Promise.resolve([]),
      this.rust?.listRuns() ?? Promise.resolve([]),
    ]);
    const legacyIds = new Set(legacyRuns.map((run) => run.runId));
    for (const run of rustRuns) {
      if (legacyIds.has(run.runId)) throw new Error(`structured run ${run.runId} has competing owners; refusing adoption`);
    }
    for (const run of legacyRuns) this.owners.set(run.runId, "legacy");
    for (const run of rustRuns) this.owners.set(run.runId, "rust");
    return [...legacyRuns, ...rustRuns];
  }

  private async ownerOf(runId: string): Promise<Owner | null> {
    const cached = this.owners.get(runId);
    if (cached) return cached;
    await this.listRuns();
    return this.owners.get(runId) ?? null;
  }

  async spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    const pending = this.starting.get(request.runId);
    if (pending) return pending;
    const attempt = (async () => {
      const owner = (await this.ownerOf(request.runId)) ?? this.newOwner;
      const host = this.getHost(owner);
      if (!host) throw new Error(`structured owner ${owner} is unavailable; no fallback across owners`);
      const handle = await host.spawnStructured(request);
      this.owners.set(request.runId, owner);
      return handle;
    })();
    this.starting.set(request.runId, attempt);
    try { return await attempt; }
    finally { if (this.starting.get(request.runId) === attempt) this.starting.delete(request.runId); }
  }

  async attachRun(runId: string): Promise<StructuredRunState | null> {
    const owner = await this.ownerOf(runId);
    return owner ? this.getHost(owner)?.attachRun(runId) ?? null : null;
  }

  async adoptRun(runId: string): Promise<StructuredExecProcess | null> {
    const owner = await this.ownerOf(runId);
    return owner ? this.getHost(owner)?.adoptRun(runId) ?? null : null;
  }

  forgetRun(runId: string): void {
    const owner = this.owners.get(runId);
    this.owners.delete(runId);
    if (owner) this.getHost(owner)?.forgetRun(runId);
  }
}

/** Default legacy. v2 is adopted even on rollback when it still owns runs. */
export async function createUpgradeAwareStructuredHost(
  configPath: string,
  legacy: StructuredExecHost | null,
  processHost: "legacy" | "rust" = "legacy",
): Promise<{ host: StructuredExecHost | undefined; rustClient: RenderStructuredClient | null }> {
  if (process.env.WAND_TEST_MODE === "1" || process.env.NODE_TEST_CONTEXT) {
    return { host: legacy ?? undefined, rustClient: null };
  }
  const rustClient = processHost === "rust" ? await startV2(configPath) : await connectExisting(configPath);
  if (!rustClient && !legacy) return { host: undefined, rustClient: null };
  return { host: new CompositeStructuredExecHost(legacy, rustClient, processHost), rustClient };
}
