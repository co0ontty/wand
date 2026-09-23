import { lstatSync, readFileSync } from "node:fs";
import net from "node:net";

import { startDaemonHeartbeat, waitForDaemonSocket } from "./daemon-connection.js";
import { getErrorMessage } from "./error-utils.js";
import {
  STRUCTURED_RENDER_PROTOCOL_VERSION,
  decodeRenderFrames,
  encodeRenderFrame,
  structuredRenderPaths,
  type StructuredRenderAttachResult,
  type StructuredRenderEvent,
  type StructuredRenderHelloResult,
  type StructuredRenderListResult,
  type StructuredRenderMethod,
  type StructuredRenderReplayStream,
  type StructuredRenderRequest,
  type StructuredRenderRunState,
  type StructuredRenderSpawnResult,
} from "./render-structured-protocol.js";
import type { RenderResponse } from "./render-protocol.js";
import type {
  StructuredExecHost,
  StructuredExecProcess,
  StructuredExitEvent,
  StructuredRunState,
  StructuredSpawnRequest,
  StructuredStreamEvent,
} from "./structured-exec-host.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_QUEUED_EVENTS = 2048;

type RunEvent = Extract<StructuredRenderEvent, { event: "stream" | "exit" }>;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function checkSocket(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Structured Render socket is not a private socket owned by this user");
  }
}

function toState(state: StructuredRenderRunState, stdoutLog = "", stderrLog = ""): StructuredRunState {
  return { ...state, stdoutLog, stderrLog };
}

class RemoteRun implements StructuredExecProcess {
  private readonly streamListeners = new Set<(event: StructuredStreamEvent) => void>();
  private readonly exitListeners = new Set<(event: StructuredExitEvent) => void>();
  private readonly beforeListener: StructuredStreamEvent[] = [];
  private pendingExit: StructuredExitEvent | null = null;
  readonly seq = { stdout: 0, stderr: 0 };
  readonly queued: RunEvent[] = [];
  syncing = false;
  overflow = false;

  get exited(): boolean { return this.pendingExit !== null; }

  constructor(
    readonly runId: string,
    readonly incarnationId: string,
    readonly pid: number,
    private readonly client: RenderStructuredClient,
  ) {}

  interrupt(signal?: string): void {
    void this.client.request("interrupt", { runId: this.runId, signal }).catch((error) =>
      process.stderr.write(`[wand] structured Render interrupt failed: ${getErrorMessage(error)}\n`));
  }

  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void } {
    this.streamListeners.add(listener);
    const pending = this.beforeListener.splice(0);
    if (pending.length > 0) queueMicrotask(() => {
      if (this.streamListeners.has(listener)) for (const event of pending) listener(event);
    });
    return { dispose: () => this.streamListeners.delete(listener) };
  }

  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    const event = this.pendingExit;
    if (event) queueMicrotask(() => { if (this.exitListeners.has(listener)) listener(event); });
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  acceptStream(event: StructuredStreamEvent): void {
    const last = this.seq[event.stream];
    if (event.seq <= last || this.pendingExit) return;
    if (event.seq !== last + 1) throw new Error("non-contiguous structured Render stream");
    this.seq[event.stream] = event.seq;
    if (this.streamListeners.size === 0) {
      this.beforeListener.push(event);
      // Never silently lose bytes when a fast process finishes before its
      // consumer installs listeners: fail rather than dropping the head.
      if (this.beforeListener.length > MAX_QUEUED_EVENTS) this.fail();
      return;
    }
    for (const listener of this.streamListeners) listener(event);
  }

  acceptExit(event: StructuredExitEvent): void {
    if (this.pendingExit) return;
    this.pendingExit = event;
    for (const listener of this.exitListeners) listener(event);
  }

  fail(): void {
    this.client.dropHandle(this.runId, this);
    // Explicit failure is preferable to a successful but incomplete turn.
    this.acceptExit({ exitCode: 1, signal: null });
  }
}

/** v2-only StructuredExecHost. It never accesses the PTY v1 or terminald sockets. */
export class RenderStructuredClient implements StructuredExecHost {
  readonly persistent = true;
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private token = "";
  private requestId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly inventory = new Map<string, StructuredRenderRunState>();
  private readonly observed = new Map<string, { incarnationId: string; stdoutSeq: number; stderrSeq: number }>();
  private readonly handles = new Map<string, RemoteRun>();
  private readonly orphanEvents = new Map<string, RunEvent[]>();
  private readonly orphanOverflow = new Set<string>();
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private connected = false;
  private fatalProtocol: Error | null = null;
  private stopHeartbeat: (() => void) | null = null;
  private reconnectDelayMs = 500;

  constructor(private readonly configPath: string) {}

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Structured Render client disposed"));
    if (this.fatalProtocol) return Promise.reject(this.fatalProtocol);
    if (this.connected && this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const connecting = this.open();
    this.connecting = connecting;
    void connecting.finally(() => { if (this.connecting === connecting) this.connecting = null; })
      .catch(() => this.scheduleReconnect());
    return connecting;
  }

  private async open(): Promise<void> {
    const paths = structuredRenderPaths(this.configPath);
    checkSocket(paths.socketPath);
    this.token = readFileSync(paths.tokenPath, "utf8").trim();
    if (!this.token) throw new Error("Structured Render token missing");
    const socket = net.createConnection(paths.socketPath);
    socket.setNoDelay(true);
    this.socket = socket;
    try {
      await waitForDaemonSocket(socket);
    } catch (error) {
      socket.destroy();
      if (this.socket === socket) this.socket = null;
      throw error;
    }
    this.buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      if (this.socket === socket) this.consume(data);
    });
    socket.on("close", () => this.onDisconnect(socket));
    socket.on("error", (error: Error) => this.onDisconnect(socket, error));
    try {
      const hello = await this.request("hello") as StructuredRenderHelloResult;
      if (hello.protocolVersion !== STRUCTURED_RENDER_PROTOCOL_VERSION) {
        this.fatalProtocol = new Error("Structured Render protocol mismatch; refusing degraded mode");
        throw this.fatalProtocol;
      }
      const result = await this.request("list") as StructuredRenderListResult;
      this.inventory.clear();
      for (const state of result.runs) this.inventory.set(state.runId, state);
      for (const [runId, handle] of this.handles) {
        const state = this.inventory.get(runId);
        if (!state || state.incarnationId !== handle.incarnationId) {
          handle.fail();
          continue;
        }
        await this.catchUp(handle);
      }
      if (this.disposed || this.socket !== socket) throw new Error("Structured Render disconnected during adoption");
      this.connected = true;
      this.reconnectDelayMs = 500;
      this.stopHeartbeat?.();
      this.stopHeartbeat = startDaemonHeartbeat(socket, () => this.request("ping"), { socketPath: paths.socketPath });
    } catch (error) {
      if (/protocolMismatch/.test(getErrorMessage(error))) {
        this.fatalProtocol = new Error("Structured Render v2 protocol mismatch; refusing degraded mode");
      }
      socket.destroy();
      this.onDisconnect(socket);
      throw this.fatalProtocol ?? error;
    }
  }

  async request(method: StructuredRenderMethod, params?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Structured Render unavailable");
    const id = ++this.requestId;
    const frame = encodeRenderFrame({ id, token: this.token,
      protocolVersion: STRUCTURED_RENDER_PROTOCOL_VERSION, method, params } satisfies StructuredRenderRequest);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Structured Render ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(frame, (error?: Error | null) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); }
        }
      });
    });
  }

  private consume(data: Buffer): void {
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      const decoded = decodeRenderFrames<RenderResponse | StructuredRenderEvent>(this.buffer);
      this.buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if ("event" in frame) { this.acceptEvent(frame); continue; }
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(`Structured Render ${frame.error?.code ?? "error"}: ${frame.error?.message ?? "unknown"}`));
      }
    } catch (error) {
      this.socket?.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private acceptEvent(event: StructuredRenderEvent): void {
    if (event.event === "reconcile") return;
    const runId = event.runId;
    const handle = this.handles.get(runId);
    if (handle && handle.incarnationId === event.incarnationId) {
      if (handle.syncing || !this.connected) {
        this.queue(handle.queued, event, runId);
        if (handle.queued.length >= MAX_QUEUED_EVENTS) handle.overflow = true;
      } else if (event.event === "exit") {
        void this.catchUp(handle).then(() => handle.acceptExit(event)).catch(() => handle.fail());
      } else if (event.seq !== handle.seq[event.stream] + 1) {
        void this.catchUp(handle).catch(() => handle.fail());
        this.queue(handle.queued, event, runId);
      } else {
        handle.acceptStream(event);
      }
      return;
    }
    const pending = this.orphanEvents.get(runId) ?? [];
    this.queue(pending, event, runId);
    this.orphanEvents.set(runId, pending);
  }

  private queue(queue: RunEvent[], event: RunEvent, runId: string): void {
    if (queue.length >= MAX_QUEUED_EVENTS) {
      queue.shift();
      this.orphanOverflow.add(runId);
    }
    queue.push(event);
  }

  private async catchUp(handle: RemoteRun): Promise<void> {
    if (handle.syncing) return;
    handle.syncing = true;
    try {
      for (let pages = 0; pages < 2048; pages++) {
        const page = await this.request("attach", { runId: handle.runId,
          afterStdoutSeq: handle.seq.stdout, afterStderrSeq: handle.seq.stderr }) as StructuredRenderAttachResult;
        if (page.state.incarnationId !== handle.incarnationId) throw new Error("structured owner changed");
        this.replayStream(handle, "stdout", page.stdout);
        this.replayStream(handle, "stderr", page.stderr);
        this.inventory.set(handle.runId, page.state);
        if (page.stdout.complete && page.stderr.complete) break;
        if (pages === 2047) throw new Error("structured replay page cap exceeded");
      }
      if (handle.overflow || this.orphanOverflow.has(handle.runId)) {
        handle.overflow = false;
        this.orphanOverflow.delete(handle.runId);
        // A bounded event queue overflow is recoverable from the authoritative
        // replay. Recheck the tail before draining any surviving events.
        handle.queued.splice(0);
        for (let pages = 0; pages < 2048; pages++) {
          const tail = await this.request("attach", { runId: handle.runId,
            afterStdoutSeq: handle.seq.stdout, afterStderrSeq: handle.seq.stderr }) as StructuredRenderAttachResult;
          this.replayStream(handle, "stdout", tail.stdout);
          this.replayStream(handle, "stderr", tail.stderr);
          this.inventory.set(handle.runId, tail.state);
          if (tail.stdout.complete && tail.stderr.complete) break;
          if (pages === 2047) throw new Error("structured overflow replay page cap exceeded");
        }
      }
      if (handle.overflow || this.orphanOverflow.has(handle.runId)) {
        throw new Error("structured event queue overflowed again during replay");
      }
      const latest = this.inventory.get(handle.runId);
      const queued = handle.queued.splice(0);
      for (const event of queued) {
        if (event.incarnationId !== handle.incarnationId) continue;
        if (event.event === "stream") {
          if (event.seq <= handle.seq[event.stream]) continue;
          if (event.seq !== handle.seq[event.stream] + 1) throw new Error("structured live event gap");
          handle.acceptStream(event);
        } else if (event.event === "exit") handle.acceptExit(event);
      }
      if (latest?.status === "exited") {
        handle.acceptExit({ exitCode: latest.exitCode, signal: latest.signal });
      }
    } catch (error) {
      process.stderr.write(`[wand] structured Render replay failed for ${handle.runId}: ${getErrorMessage(error)}\n`);
      handle.fail();
      throw error;
    } finally {
      handle.syncing = false;
    }
  }

  private replayStream(handle: RemoteRun, stream: "stdout" | "stderr", replay: StructuredRenderReplayStream): void {
    if (replay.resetRequired && handle.seq[stream] !== 0) {
      throw new Error("structured replay window lost a live stream segment");
    }
    // A new adoption with a truncated head is handled by the recovery manager;
    // an active handle may not quietly skip that head.
    if (replay.resetRequired && replay.chunks[0]?.seq !== 1) {
      throw new Error("structured replay cannot rebuild an active turn from a truncated head");
    }
    for (const chunk of replay.chunks) {
      if (chunk.seq > handle.seq[stream]) handle.acceptStream({ stream, ...chunk });
    }
  }

  private async collect(runId: string): Promise<StructuredRunState | null> {
    const logs = { stdout: [] as string[], stderr: [] as string[] };
    const cursor = { stdout: 0, stderr: 0 };
    for (let pages = 0; pages < 2048; pages++) {
      let page: StructuredRenderAttachResult;
      try {
        page = await this.request("attach", { runId, afterStdoutSeq: cursor.stdout,
          afterStderrSeq: cursor.stderr }) as StructuredRenderAttachResult;
      } catch (error) {
        if (/notFound/.test(getErrorMessage(error))) return null;
        throw error;
      }
      for (const stream of ["stdout", "stderr"] as const) {
        const replay = page[stream];
        if (replay.resetRequired && cursor[stream] !== 0) throw new Error("structured snapshot changed during replay");
        if (replay.resetRequired && !page.state[`${stream}Truncated`]) {
          throw new Error("structured replay cursor gap without truncation");
        }
        for (const chunk of replay.chunks) logs[stream].push(chunk.data);
        cursor[stream] = replay.nextSeq;
      }
      if (page.stdout.complete && page.stderr.complete) {
        const state = toState(page.state, logs.stdout.join(""), logs.stderr.join(""));
        this.inventory.set(runId, page.state);
        this.observed.set(runId, { incarnationId: state.incarnationId,
          stdoutSeq: state.stdoutSeq, stderrSeq: state.stderrSeq });
        return state;
      }
    }
    throw new Error("structured snapshot exceeded replay page cap");
  }

  /** Events can overtake the spawn response. Feed the contiguous prefix before
   * paging so a fast >8 MiB child does not falsely lose its already-received head. */
  private primeBuffered(handle: RemoteRun): void {
    const buffered = this.orphanEvents.get(handle.runId) ?? [];
    this.orphanEvents.delete(handle.runId);
    for (const event of buffered) {
      if (event.incarnationId !== handle.incarnationId) continue;
      if (event.event === "exit") { handle.queued.push(event); continue; }
      if (event.seq <= handle.seq[event.stream]) continue;
      if (event.seq !== handle.seq[event.stream] + 1) {
        handle.queued.push(event);
        continue;
      }
      handle.acceptStream(event);
    }
  }

  async spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    await this.connect();
    const existing = this.handles.get(request.runId);
    if (existing && !existing.exited) return existing;
    if (existing) this.handles.delete(request.runId);
    const env = Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"));
    const result = await this.request("spawn", { ...request, env }) as StructuredRenderSpawnResult;
    const handle = new RemoteRun(request.runId, result.state.incarnationId, result.state.pid, this);
    this.handles.set(request.runId, handle);
    this.primeBuffered(handle);
    try {
      await this.catchUp(handle);
      if (result.state.status === "exited") handle.acceptExit({ exitCode: result.state.exitCode, signal: result.state.signal });
      return handle;
    } catch (error) {
      this.dropHandle(request.runId, handle);
      throw error;
    }
  }

  async attachRun(runId: string): Promise<StructuredRunState | null> {
    await this.connect();
    return this.collect(runId);
  }

  async adoptRun(runId: string): Promise<StructuredExecProcess | null> {
    await this.connect();
    const prior = this.observed.get(runId);
    const known = this.inventory.get(runId);
    if (!known || known.status !== "running") return null;
    const handle = new RemoteRun(runId, known.incarnationId, known.pid, this);
    if (prior?.incarnationId === known.incarnationId) {
      handle.seq.stdout = prior.stdoutSeq;
      handle.seq.stderr = prior.stderrSeq;
    }
    this.handles.set(runId, handle);
    this.primeBuffered(handle);
    await this.catchUp(handle);
    return handle;
  }

  async listRuns(): Promise<StructuredRunState[]> {
    await this.connect();
    const result = await this.request("list") as StructuredRenderListResult;
    for (const state of result.runs) this.inventory.set(state.runId, state);
    return result.runs.map((state) => toState(state));
  }

  forgetRun(runId: string): void {
    this.handles.delete(runId);
    this.inventory.delete(runId);
    this.observed.delete(runId);
    this.orphanEvents.delete(runId);
    this.orphanOverflow.delete(runId);
    void this.request("forget", { runId }).catch(() => {});
  }

  dropHandle(runId: string, handle: RemoteRun): void {
    if (this.handles.get(runId) === handle) this.handles.delete(runId);
  }

  disconnect(): void {
    this.disposed = true;
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    this.rejectPending(new Error("Structured Render client disconnected"));
    this.handles.clear();
  }

  private onDisconnect(socket: net.Socket, error?: Error): void {
    if (this.socket !== socket) return;
    this.connected = false;
    this.socket = null;
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
    socket.destroy();
    this.buffer = Buffer.alloc(0);
    this.rejectPending(error ?? new Error("Structured Render disconnected"));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.fatalProtocol || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => { /* rejection schedules the next attempt */ });
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
    this.reconnectTimer.unref?.();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
