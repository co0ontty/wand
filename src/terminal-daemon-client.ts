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
import { appendWindow, PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";

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

export class TerminalDaemonClient implements TerminalHost {
  readonly persistent = true;
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inventory = new Map<string, TerminalSessionState>();
  private readonly handles = new Map<string, RemoteTerminalProcess>();
  private readonly pendingEvents = new Map<string, TerminalDaemonEvent[]>();

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
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
    socket.on("close", () => this.rejectPending(new Error("Terminal daemon disconnected")));
    socket.on("error", (error) => this.rejectPending(error));
    await this.request("hello");
    const sessions = await this.request("list") as TerminalSessionState[];
    this.inventory.clear();
    for (const session of sessions) this.inventory.set(session.sessionId, session);
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

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new Error("Terminal daemon client disposed"));
    this.handles.clear();
    this.pendingEvents.clear();
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
