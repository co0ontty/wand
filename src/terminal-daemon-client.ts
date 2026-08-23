import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import process from "node:process";

import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  terminalDaemonPaths,
  type TerminalDaemonAttachPayload,
  type TerminalDaemonEvent,
  type TerminalDaemonRequest,
  type TerminalDaemonResponse,
} from "./terminal-daemon-protocol.js";
import {
  appendTerminalChunkWindow,
  InProcessTerminalHost,
  type TerminalAttachResult,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalHost,
  type TerminalProcess,
  type TerminalSessionState,
  type TerminalSpawnRequest,
} from "./terminal-host.js";
import {
  STRUCTURED_RUN_LOG_MAX_CHARS,
  type StructuredExecHost,
  type StructuredExecProcess,
  type StructuredExitEvent,
  type StructuredSpawnRequest,
  type StructuredStreamEvent,
  type StructuredRunState,
} from "./structured-exec-host.js";
import { appendWindow, PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";

const TERMINAL_DAEMON_RECONNECT_INITIAL_MS = 500;
const TERMINAL_DAEMON_RECONNECT_MAX_MS = 10_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class RemoteTerminalProcess implements TerminalProcess {
  private readonly dataListeners = new Set<(event: TerminalDataEvent) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>();
  private paused = false;
  private pausedEvents: TerminalDataEvent[] = [];
  private undeliveredEvents: TerminalDataEvent[] = [];
  private pendingExit: TerminalExitEvent | null = null;

  constructor(
    readonly sessionId: string,
    readonly incarnationId: string,
    readonly pid: number,
    private readonly client: TerminalDaemonClient,
  ) {}

  write(data: string): void {
    void this.client.request("write", { sessionId: this.sessionId, data }).catch((error) => {
      this.client.reportOperationError(this.sessionId, error);
    });
  }

  resize(cols: number, rows: number): void {
    void this.client.request("resize", { sessionId: this.sessionId, cols, rows }).catch((error) => {
      this.client.reportOperationError(this.sessionId, error);
    });
  }

  kill(signal?: string): void {
    void this.client.request("kill", { sessionId: this.sessionId, signal }).catch((error) => {
      this.client.reportOperationError(this.sessionId, error);
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const pending = this.pausedEvents;
    this.pausedEvents = [];
    for (const event of pending) this.emitData(event);
  }

  onData(listener: (event: TerminalDataEvent) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    if (this.undeliveredEvents.length > 0) {
      const pending = this.undeliveredEvents;
      this.undeliveredEvents = [];
      queueMicrotask(() => {
        if (!this.dataListeners.has(listener)) return;
        for (const event of pending) listener(event);
      });
    }
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: TerminalExitEvent) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    const pending = this.pendingExit;
    if (pending) {
      queueMicrotask(() => {
        if (this.exitListeners.has(listener)) listener(pending);
      });
    }
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  acceptData(event: TerminalDataEvent): void {
    if (this.paused) {
      this.pausedEvents = appendTerminalChunkWindow(this.pausedEvents, event);
      return;
    }
    if (this.dataListeners.size === 0) {
      this.undeliveredEvents = appendTerminalChunkWindow(this.undeliveredEvents, event);
      return;
    }
    this.emitData(event);
  }

  acceptExit(event: TerminalExitEvent): void {
    this.pendingExit = event;
    for (const listener of Array.from(this.exitListeners)) listener(event);
  }

  private emitData(event: TerminalDataEvent): void {
    for (const listener of Array.from(this.dataListeners)) listener(event);
  }
}

/** Client-side handle for a daemon-owned structured CLI run. */
class RemoteStructuredProcess implements StructuredExecProcess {
  private readonly streamListeners = new Set<(event: StructuredStreamEvent) => void>();
  private readonly exitListeners = new Set<(event: StructuredExitEvent) => void>()
  private paused = false;
  private pausedEvents: StructuredStreamEvent[] = [];
  private undeliveredEvents: StructuredStreamEvent[] = [];
  private pendingExit: StructuredExitEvent | null = null;
  private lastStdoutSeq = 0;
  private lastStderrSeq = 0;

  constructor(
    readonly runId: string,
    readonly incarnationId: string,
    readonly pid: number,
    private readonly client: TerminalDaemonClient,
  ) {}

  interrupt(signal?: string): void {
    void this.client.request("structuredKill", { runId: this.runId, signal }).catch((error) =>
      this.client.reportOperationError(this.runId, error),
    );
  }

  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void } {
    this.streamListeners.add(listener);
    if (this.undeliveredEvents.length > 0) {
      const pending = this.undeliveredEvents;
      this.undeliveredEvents = [];
      queueMicrotask(() => {
        if (!this.streamListeners.has(listener)) return;
        for (const event of pending) listener(event);
      });
    }
    return { dispose: () => this.streamListeners.delete(listener) };
  }

  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    const pending = this.pendingExit;
    if (pending) {
      queueMicrotask(() => {
        if (this.exitListeners.has(listener)) listener(pending);
      });
    }
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  acceptStream(event: StructuredStreamEvent): void {
    this.deliveredChars[event.stream] += event.data.length;
    if (event.stream === "stdout") this.lastStdoutSeq = Math.max(this.lastStdoutSeq, event.seq);
    else this.lastStderrSeq = Math.max(this.lastStderrSeq, event.seq);
    if (this.paused) {
      this.pausedEvents.push(event);
      return;
    }
    if (this.streamListeners.size === 0) {
      this.undeliveredEvents.push(event);
      if (this.undeliveredEvents.length > 4096) this.undeliveredEvents.shift();
      return;
    }
    this.emitStream(event);
  }

  acceptExit(event: StructuredExitEvent): void {
    this.pendingExit = event;
    for (const listener of Array.from(this.exitListeners)) listener(event);
  }

  /** Gap-free catch-up from the daemon's full replay logs after a reconnect. */
  replayFromLogs(state: StructuredRunState): void {
    const stdoutDelta = alignedDelta(state.stdoutLog, state.stdoutTruncated, this.deliveredChars.stdout);
    if (stdoutDelta === null) {
      process.stderr.write(`[wand] structured run ${this.runId} stdout log no longer aligns with delivered output; skipping catch-up\n`);
    } else if (stdoutDelta) {
      this.acceptStream({ stream: "stdout", data: stdoutDelta, seq: ++this.syntheticSeq });
    }
    const stderrDelta = alignedDelta(state.stderrLog, state.stderrTruncated, this.deliveredChars.stderr);
    if (stderrDelta === null) {
      process.stderr.write(`[wand] structured run ${this.runId} stderr log no longer aligns with delivered output; skipping catch-up\n`);
    } else if (stderrDelta) {
      this.acceptStream({ stream: "stderr", data: stderrDelta, seq: ++this.syntheticSeq });
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const pending = this.pausedEvents;
    this.pausedEvents = [];
    for (const event of pending) this.emitStream(event);
  }

  private emitStream(event: StructuredStreamEvent): void {
    for (const listener of Array.from(this.streamListeners)) listener(event);
  }

  private readonly deliveredChars = { stdout: 0, stderr: 0 };
  private syntheticSeq = 1_000_000_000_000;
}

/**
 * Deliver the suffix of the daemon's replay log beyond what this handle has
 * already seen. Returns null when alignment is impossible (head-truncated log
 * or watermark beyond the log), in which case callers skip catch-up.
 */
function alignedDelta(log: string, truncated: boolean, deliveredChars: number): string | null {
  if (truncated) return null;
  if (log.length < deliveredChars) return null;
  return log.slice(deliveredChars);
}

export class TerminalDaemonClient implements TerminalHost, StructuredExecHost {
  readonly persistent = true;
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inventory = new Map<string, TerminalSessionState>();
  private readonly handles = new Map<string, RemoteTerminalProcess>();
  private readonly pendingEvents = new Map<string, TerminalDaemonEvent[]>();
  private readonly structuredInventory = new Map<string, StructuredRunState>();
  private readonly structuredHandles = new Map<string, RemoteStructuredProcess>();
  private readonly pendingStructuredEvents = new Map<string, TerminalDaemonEvent[]>();
  private disposed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = TERMINAL_DAEMON_RECONNECT_INITIAL_MS;
  private reconnectFailureLogged = false;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("Terminal daemon client disposed");
    if (this.socket && !this.socket.destroyed) return;
    const socket = net.createConnection(this.socketPath);
    socket.setNoDelay(true);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.on("data", (data) => this.consume(data.toString("utf8")));
    socket.on("close", () => this.handleDisconnect());
    socket.on("error", (error) => {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      this.handleDisconnect();
    });
    try {
      await this.request("hello");
      const previous = new Map(this.inventory);
      const sessions = await this.request("list") as TerminalSessionState[];
      this.inventory.clear();
      for (const session of sessions) this.inventory.set(session.sessionId, session);
      if (previous.size > 0) {
        this.reconcileAfterReconnect(previous);
        process.stderr.write("[wand] Reconnected to terminal daemon; reconciled PTY inventory.\n");
      }
      await this.refreshStructuredAfterReconnect();
    } catch (error) {
      if (!this.disposed) {
        try { socket.destroy(); } catch { /* best-effort cleanup */ }
        this.handleDisconnect();
      }
      throw error;
    }
  }

  attach(sessionId: string, afterSeq = 0): TerminalAttachResult | null {
    const state = this.inventory.get(sessionId);
    if (!state) return null;
    return this.resultFromState(state, false, afterSeq);
  }

  async createOrAttach(request: TerminalSpawnRequest, afterSeq = 0): Promise<TerminalAttachResult> {
    const existing = this.inventory.get(request.sessionId);
    if (existing) return this.resultFromState(existing, false, afterSeq);
    const payload = await this.request("createOrAttach", { ...request, afterSeq }) as TerminalDaemonAttachPayload;
    this.inventory.set(payload.state.sessionId, payload.state);
    return this.resultFromState(payload.state, payload.isNew, afterSeq);
  }

  forget(sessionId: string): void {
    this.inventory.delete(sessionId);
    this.handles.delete(sessionId);
    this.pendingEvents.delete(sessionId);
    void this.request("forget", { sessionId }).catch((error) => this.reportOperationError(sessionId, error));
  }

  // ---------------------------------------------------------------------------
  // StructuredExecHost: daemon-owned CLI runs that survive web restarts.
  // ---------------------------------------------------------------------------

  async spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    const existingHandle = this.structuredHandles.get(request.runId);
    const existing = this.structuredInventory.get(request.runId);
    if (existingHandle && existing?.status === "running" && existing.incarnationId === existingHandle.incarnationId) {
      return existingHandle;
    }
    this.structuredHandles.delete(request.runId);
    const state = await this.request("structuredSpawn", { ...request }) as StructuredRunState;
    return this.handleFromState(state, existingHandle ?? null);
  }

  async attachRun(runId: string): Promise<StructuredRunState | null> {
    const payload = await this.request("structuredAttach", { runId }) as { state: StructuredRunState | null };
    if (!payload.state) return null;
    this.structuredInventory.set(runId, payload.state);
    return payload.state;
  }

  async adoptRun(runId: string): Promise<StructuredExecProcess | null> {
    const state = await this.attachRun(runId);
    if (!state || state.status !== "running") return null;
    const existing = this.structuredHandles.get(runId);
    if (existing && existing.incarnationId === state.incarnationId) return existing;
    return this.handleFromState(state, existing ?? null);
  }

  async listRuns(): Promise<StructuredRunState[]> {
    const result = await this.request("structuredList") as unknown;
    // Defensive against protocol skew with older daemons that answer unknown
    // methods with a generic { ok: true }.
    return Array.isArray(result) ? (result as StructuredRunState[]) : [];
  }

  forgetRun(runId: string): void {
    this.structuredInventory.delete(runId);
    this.structuredHandles.delete(runId);
    this.pendingStructuredEvents.delete(runId);
    void this.request("structuredForget", { runId }).catch((error) => this.reportOperationError(runId, error));
  }

  /** Refresh the structured inventory and catch live handles up after a reconnect. */
  private async refreshStructuredAfterReconnect(): Promise<void> {
    const previous = new Map(this.structuredInventory);
    let runs: StructuredRunState[];
    try {
      runs = await this.listRuns();
    } catch {
      return; // socket died again mid-refresh; next reconnect retries
    }
    this.structuredInventory.clear();
    for (const run of runs) this.structuredInventory.set(run.runId, run);
    for (const [runId, oldState] of previous) {
      const current = this.structuredInventory.get(runId);
      const handle = this.structuredHandles.get(runId);
      if (!handle || handle.incarnationId !== oldState.incarnationId) continue;
      if (current && current.status === "running") {
        handle.replayFromLogs(current);
        continue;
      }
      // Run exited while we were disconnected.
      this.structuredHandles.delete(runId);
      handle.acceptExit({ exitCode: current?.exitCode ?? -1, signal: current?.signal ?? null });
    }
  }

  private handleFromState(state: StructuredRunState, reuse: RemoteStructuredProcess | null): RemoteStructuredProcess {
    this.structuredInventory.set(state.runId, state);
    if (state.status !== "running") {
      this.structuredHandles.delete(state.runId);
      return reuse ?? new RemoteStructuredProcess(state.runId, state.incarnationId, state.pid, this);
    }
    let process = this.structuredHandles.get(state.runId) ?? null;
    if (!process || process.incarnationId !== state.incarnationId) {
      process = new RemoteStructuredProcess(state.runId, state.incarnationId, state.pid, this);
      this.structuredHandles.set(state.runId, process);
      const pending = this.pendingStructuredEvents.get(state.runId) ?? [];
      this.pendingStructuredEvents.delete(state.runId);
      for (const event of pending) this.routeStructuredEvent(event);
    }
    return process;
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new Error("Terminal daemon client disposed"));
    this.handles.clear();
    this.pendingEvents.clear();
    this.structuredHandles.clear();
    this.pendingStructuredEvents.clear();
  }

  /**
   * Socket teardown path. Without a reconnect, a daemon restart would leave
   * every RemoteTerminalProcess silently dead while ProcessManager keeps the
   * session status at "running" forever.
   */
  private handleDisconnect(): void {
    if (this.socket?.destroyed) this.socket = null;
    this.rejectPending(new Error("Terminal daemon disconnected"));
    if (this.disposed) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, TERMINAL_DAEMON_RECONNECT_MAX_MS);
  }

  private async tryReconnect(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.connect();
      this.reconnectDelayMs = TERMINAL_DAEMON_RECONNECT_INITIAL_MS;
      this.reconnectFailureLogged = false;
    } catch (error) {
      if (this.disposed) return;
      if (!this.reconnectFailureLogged) {
        this.reconnectFailureLogged = true;
        process.stderr.write(`[wand] Terminal daemon reconnect failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      this.scheduleReconnect();
    }
  }

  /**
   * Diff the pre-disconnect inventory against the daemon's fresh `list`.
   * Sessions that vanished (daemon restart/forget) or exited while we were
   * disconnected get a synthetic exit delivered to their existing handle so
   * ProcessManager finalizes them; live sessions replay chunks missed during
   * the gap.
   */
  private reconcileAfterReconnect(previous: Map<string, TerminalSessionState>): void {
    for (const [sessionId, oldState] of previous) {
      const current = this.inventory.get(sessionId);
      const handle = this.handles.get(sessionId);
      const handleMatches = !!handle && handle.incarnationId === oldState.incarnationId;
      const stillRunning = !!current
        && current.incarnationId === oldState.incarnationId
        && current.status === "running";
      if (stillRunning && handleMatches) {
        for (const chunk of current!.chunks) {
          if (chunk.seq > oldState.seq) handle!.acceptData(chunk);
        }
        continue;
      }
      const exitedOnDaemon = !!current
        && current.incarnationId === oldState.incarnationId
        && current.status === "exited";
      const exitCode = exitedOnDaemon ? current!.exitCode ?? -1 : -1;
      this.handles.delete(sessionId);
      if (handleMatches) handle!.acceptExit({ exitCode });
    }
  }

  async request(method: TerminalDaemonRequest["method"], params?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new Error("Terminal daemon is unavailable");
    const id = this.nextRequestId++;
    const request: TerminalDaemonRequest = {
      kind: "request",
      id,
      token: this.token,
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      method,
      params,
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Terminal daemon ${method} timed out`));
      }, 10_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  reportOperationError(sessionId: string, error: unknown): void {
    if (!this.socket || this.socket.destroyed) return;
    process.stderr.write(`[wand] terminal daemon operation failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  private resultFromState(state: TerminalSessionState, isNew: boolean, afterSeq: number): TerminalAttachResult {
    let process = this.handles.get(state.sessionId) ?? null;
    if (state.status === "running" && (!process || process.incarnationId !== state.incarnationId)) {
      process = new RemoteTerminalProcess(state.sessionId, state.incarnationId, state.pid, this);
      this.handles.set(state.sessionId, process);
      const pending = this.pendingEvents.get(state.sessionId) ?? [];
      this.pendingEvents.delete(state.sessionId);
      for (const event of pending) {
        const alreadyInSnapshot = event.event === "data"
          ? typeof event.seq === "number" && event.seq <= state.seq
          : false;
        if (!alreadyInSnapshot) this.routeEvent(event);
      }
    }
    if (state.status !== "running") process = null;
    return {
      process,
      state,
      replay: state.chunks.filter((chunk) => chunk.seq > afterSeq),
      isNew,
    };
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: TerminalDaemonResponse | TerminalDaemonEvent;
      try { message = JSON.parse(line) as TerminalDaemonResponse | TerminalDaemonEvent; }
      catch { continue; }
      if (message.kind === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error));
      } else {
        this.routeEvent(message);
      }
    }
  }

  private routeEvent(event: TerminalDaemonEvent): void {
    if (event.event === "sdata" || event.event === "sexit") {
      this.routeStructuredEvent(event);
      return;
    }
    const state = this.inventory.get(event.sessionId);
    if (state && state.incarnationId === event.incarnationId) {
      if (event.event === "data" && typeof event.data === "string" && typeof event.seq === "number") {
        state.seq = Math.max(state.seq, event.seq);
        state.output = appendWindow(state.output, event.data, PTY_OUTPUT_MAX_SIZE);
        state.chunks = appendTerminalChunkWindow(state.chunks, { data: event.data, seq: event.seq });
      } else if (event.event === "exit") {
        state.status = "exited";
        state.exitCode = event.exitCode ?? -1;
      }
    }
    const handle = this.handles.get(event.sessionId);
    if (!handle || handle.incarnationId !== event.incarnationId) {
      const pending = this.pendingEvents.get(event.sessionId) ?? [];
      pending.push(event);
      this.pendingEvents.set(event.sessionId, pending.slice(-512));
      return;
    }
    if (event.event === "data" && typeof event.data === "string" && typeof event.seq === "number") {
      handle.acceptData({ data: event.data, seq: event.seq });
    } else if (event.event === "exit") {
      handle.acceptExit({ exitCode: event.exitCode ?? -1, signal: event.signal });
      this.handles.delete(event.sessionId);
    }
  }

  /** Structured run events update the inventory and feed live handles. */
  private routeStructuredEvent(event: TerminalDaemonEvent): void {
    const state = this.structuredInventory.get(event.sessionId);
    if (state && state.incarnationId === event.incarnationId) {
      if (event.event === "sdata" && typeof event.data === "string" && typeof event.seq === "number") {
        const stream = event.stream === "stderr" ? "stderr" : "stdout";
        if (stream === "stdout") state.stdoutSeq = Math.max(state.stdoutSeq, event.seq);
        else state.stderrSeq = Math.max(state.stderrSeq, event.seq);
        if (stream === "stdout") {
          state.stdoutLog += event.data;
          if (state.stdoutLog.length > STRUCTURED_RUN_LOG_MAX_CHARS) {
            state.stdoutLog = state.stdoutLog.slice(-STRUCTURED_RUN_LOG_MAX_CHARS);
            state.stdoutTruncated = true;
          }
        } else {
          state.stderrLog += event.data;
          if (state.stderrLog.length > STRUCTURED_RUN_LOG_MAX_CHARS) {
            state.stderrLog = state.stderrLog.slice(-STRUCTURED_RUN_LOG_MAX_CHARS);
            state.stderrTruncated = true;
          }
        }
      } else if (event.event === "sexit") {
        state.status = "exited";
        state.exitCode = event.exitCode ?? null;
        state.signal = event.signal ?? null;
      }
    }
    const handle = this.structuredHandles.get(event.sessionId);
    if (!handle || handle.incarnationId !== event.incarnationId) {
      const pending = this.pendingStructuredEvents.get(event.sessionId) ?? [];
      pending.push(event);
      this.pendingStructuredEvents.set(event.sessionId, pending.slice(-2048));
      return;
    }
    if (event.event === "sdata" && typeof event.data === "string" && typeof event.seq === "number") {
      handle.acceptStream({ stream: event.stream === "stderr" ? "stderr" : "stdout", data: event.data, seq: event.seq });
    } else if (event.event === "sexit") {
      handle.acceptExit({ exitCode: event.exitCode ?? null, signal: event.signal ?? null });
      this.structuredHandles.delete(event.sessionId);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function createTerminalHost(configPath: string): Promise<TerminalHost> {
  if (process.env.WAND_TEST_MODE === "1" || process.env.NODE_TEST_CONTEXT) return new InProcessTerminalHost();
  const paths = terminalDaemonPaths(configPath);
  const endpointExists = process.platform === "win32" || existsSync(paths.socketPath);

  if (endpointExists) {
    const adopted = await tryConnect(paths.socketPath, paths.tokenPath);
    if (adopted) return adopted;
    if (await probeSocket(paths.socketPath)) {
      const starting = await waitForTerminalDaemon(paths.socketPath, paths.tokenPath, 5_000);
      if (starting) return starting;
      process.stderr.write("[wand] Existing terminal daemon rejected adoption; using non-persistent PTYs without replacing it.\n");
      return new InProcessTerminalHost();
    }
  }

  // Service managers can start terminald and the web process at nearly the
  // same time. The daemon writes its pid before opening the socket, so give
  // that owner time to become ready instead of spawning a competing daemon.
  if (hasLiveDaemonPid(paths.pidPath)) {
    const adopted = await waitForTerminalDaemon(paths.socketPath, paths.tokenPath, 5_000);
    if (adopted) return adopted;
    process.stderr.write("[wand] Terminal daemon process is alive but its socket is unavailable; using non-persistent PTYs without replacing it.\n");
    return new InProcessTerminalHost();
  }

  try {
    startDetachedDaemon(configPath);
    const client = await waitForTerminalDaemon(paths.socketPath, paths.tokenPath, 5_000);
    if (client) return client;
  } catch (error) {
    process.stderr.write(`[wand] Failed to start terminal daemon: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stderr.write("[wand] Terminal daemon unavailable; falling back to in-process PTYs.\n");
  return new InProcessTerminalHost();
}

async function waitForTerminalDaemon(
  socketPath: string,
  tokenPath: string,
  timeoutMs: number,
): Promise<TerminalDaemonClient | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = await tryConnect(socketPath, tokenPath);
    if (client) return client;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function hasLiveDaemonPid(pidPath: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(pidPath, "utf8").trim()); }
  catch { return false; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryConnect(socketPath: string, tokenPath: string): Promise<TerminalDaemonClient | null> {
  let token: string;
  try { token = readFileSync(tokenPath, "utf8").trim(); }
  catch { return null; }
  if (!token) return null;
  const client = new TerminalDaemonClient(socketPath, token);
  try {
    await client.connect();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

/** Connect to an already-running terminal daemon without starting a replacement. */
export async function connectExistingTerminalHost(configPath: string): Promise<TerminalDaemonClient | null> {
  const paths = terminalDaemonPaths(configPath);
  return tryConnect(paths.socketPath, paths.tokenPath);
}

function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (alive: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    const timer = setTimeout(() => finish(false), 300);
    timer.unref?.();
  });
}

function startDetachedDaemon(configPath: string): void {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) throw new Error("Cannot resolve Wand CLI entrypoint");
  const runtimeArgs = entry.endsWith(".ts") ? process.execArgv : [];
  const child = spawn(process.execPath, [...runtimeArgs, entry, "terminald", "-c", configPath], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
}
