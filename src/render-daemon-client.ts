import { lstatSync, readFileSync } from "node:fs";
import net from "node:net";
import process from "node:process";

import { startDaemonHeartbeat, waitForDaemonSocket } from "./daemon-connection.js";
import { getErrorMessage } from "./error-utils.js";
import { appendWindow, PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";
import type { PtyTerminalSnapshot } from "./pty-terminal-state.js";
import {
  MAX_FRAME_BYTES,
  RENDER_PROTOCOL_VERSION,
  encodeRenderFrame,
  renderPaths,
  type RenderCreateOrAttachParams,
  type RenderEvent,
  type RenderHelloResult,
  type RenderMethod,
  type RenderRequest,
  type RenderResponse,
} from "./render-protocol.js";
import {
  appendTerminalChunkWindow,
  type TerminalAttachResult,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalHost,
  type TerminalProcess,
  type TerminalSessionState,
  type TerminalSpawnRequest,
} from "./terminal-host.js";

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/**
 * 鉴权被同一个活着的 daemon 拒过之后的重试间隔。
 *
 * 这种情况（连接被接受、请求发出后被静默关闭）不是网络抖动：同一个 socket 路径上
 * 有一个持有**别的** token 的 Render。按 10s 重试只是给自己刷日志，所以拉开到一分钟；
 * 每次重试仍会重读 token 文件，daemon 重启（轮换 token）或文件被修正后会自愈。
 */
const AUTH_FAILURE_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** 未挂上 listener 时的缓存上限，与 legacy 客户端保持一致。 */
const MAX_PENDING_EVENTS = 512;

interface PendingRequest {
  method: RenderMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * 鉴权层面的失败（与网络抖动区分）。
 *
 * 特征：连接建立成功、hello 发出后对端**一个字节都没回**就关闭 —— Render 对
 * token 不符/协议不符的处理就是直接 `close()`。单独一个类型是为了让重连策略
 * 能把「同一把废 token」和「daemon 不在了」区分开，而不是一律 10s 重试。
 */
export class RenderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderAuthError";
  }
}

/**
 * 远端 PTY 句柄。Render 可能在这个对象挂上 listener 之前就推来 data/exit
 * （大输出场景几乎必然发生），所以先做有界缓存，挂上后按序补发。
 */
class RemoteRenderProcess implements TerminalProcess {
  private readonly dataListeners = new Set<(event: TerminalDataEvent) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>();
  private readonly resyncListeners = new Set<(state: TerminalSessionState) => void>();
  private undeliveredEvents: TerminalDataEvent[] = [];
  private pendingExit: TerminalExitEvent | null = null;
  private pendingResync: TerminalSessionState | null = null;
  private resyncGeneration = 0;

  constructor(
    readonly sessionId: string,
    readonly incarnationId: string,
    readonly pid: number,
    private readonly client: RenderDaemonClient,
  ) {}

  write(data: string): void {
    this.client.fireOperation(this.sessionId, "write", { sessionId: this.sessionId, data });
  }

  async writeConfirmed(data: string): Promise<void> {
    await this.client.confirmWrite(this.sessionId, data);
  }

  resize(cols: number, rows: number): void {
    // daemon 的 data 事件不带尺寸，inventory 又是 attach() 的唯一来源：
    // 不同步这一步，attach() 会一直返回 resize 之前的 cols/rows。
    this.client.noteTerminalResize(this.sessionId, cols, rows);
    this.client.fireOperation(this.sessionId, "resize", { sessionId: this.sessionId, cols, rows });
  }

  kill(signal?: string): void {
    this.client.fireOperation(this.sessionId, "kill", { sessionId: this.sessionId, signal });
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
      // 退出事件只发生一次，但可能早于 listener 到达；补发语义必须与 data 一致。
      queueMicrotask(() => {
        if (this.exitListeners.has(listener)) listener(pending);
      });
    }
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  onResync(listener: (state: TerminalSessionState) => void): { dispose(): void } {
    this.resyncListeners.add(listener);
    const pending = this.pendingResync;
    if (pending) {
      const generation = this.resyncGeneration;
      queueMicrotask(() => {
        if (this.resyncGeneration !== generation) return;
        if (this.resyncListeners.has(listener)) listener(pending);
        if (this.pendingResync === pending) this.pendingResync = null;
      });
    }
    return { dispose: () => this.resyncListeners.delete(listener) };
  }

  acceptResync(state: TerminalSessionState): void {
    this.resyncGeneration += 1;
    this.pendingResync = this.resyncListeners.size === 0
      ? { ...state, chunks: [...state.chunks] }
      : null;
    this.undeliveredEvents = [];
    for (const listener of Array.from(this.resyncListeners)) listener(state);
  }

  acceptData(event: TerminalDataEvent): void {
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

/**
 * Render（常驻 PTY 持有者）的 Node 客户端。
 *
 * 与 legacy `TerminalDaemonClient` 的关键差异：**这里只有 PTY**，没有结构化运行；
 * 另外 `disconnect()` 只解绑 socket，Render 进程与其 PTY 全部保留 —— 这正是
 * Server 因 `npm update` 重启而 PTY 不丢的前提。
 */
export class RenderDaemonClient implements TerminalHost {
  readonly persistent = true;
  private socket: net.Socket | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inventory = new Map<string, TerminalSessionState>();
  private readonly handles = new Map<string, RemoteRenderProcess>();
  private readonly pendingEvents = new Map<string, RenderEvent[]>();
  private readonly pendingEventOverflows = new Set<string>();
  private readonly refreshingSessions = new Set<string>();
  private reconciling = false;
  private eventsDuringReconcile: RenderEvent[] = [];
  private reconcileDuringSync: RenderEvent | null = null;
  // socket 帧解码状态：长度前缀最多 4 字节；正文按到达顺序分片，避免大帧反复整块拷贝。
  private headerParts: Buffer[] = [];
  private headerBytes = 0;
  private bodyParts: Buffer[] = [];
  private bodyBytes = 0;
  private frameLength: number | null = null;
  private disposed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_INITIAL_MS;
  private reconnectFailureLogged = false;
  private offlineOperationLogged = false;
  /** 协议版本不匹配是终态：重试无意义，也不允许降级运行。 */
  private fatalProtocolError: Error | null = null;
  private daemonVersion = "";
  /** 最近一次 connect 时实际使用的凭据。 */
  private activeToken = "";
  /** 最后一次成功读到的凭据；token 文件暂时读不到时用它，避免重连因一次 IO 失败直接放弃。 */
  private lastKnownToken = "";
  /** 已经因为「读不到 token 文件」告警过，避免每次重连都刷一行。 */
  private tokenReadFailureLogged = false;
  /** 当前 socket 上已解出的帧数，用来区分「未鉴权被直接关闭」与网络错误。 */
  private framesOnCurrentSocket = 0;
  private connecting: Promise<void> | null = null;
  private stopHeartbeat: (() => void) | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    /**
     * token 文件路径。给了它就在**每次 connect 时重读**：Render 崩溃/升级重启后
     * 会 `generate_token()` 轮换 token，只缓存构造期的那一把会让重连永远鉴权失败
     * （现象是 `createOrAttach` 全部失败、错误只显示 unavailable，旧会话被永久报成 running）。
     */
    private readonly tokenPath: string | null = null,
    /** Persisted PTY IDs used only if v1 `list` exceeds its aggregate frame limit. */
    private readonly knownSessionIds: readonly string[] = [],
  ) {
    this.lastKnownToken = token;
  }

  get version(): string {
    return this.daemonVersion;
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Render client disposed"));
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    const connecting = this.open();
    this.connecting = connecting;
    void connecting.finally(() => {
      if (this.connecting === connecting) this.connecting = null;
    }).catch(() => {});
    return connecting;
  }

  private async open(): Promise<void> {
    // 先校验对端再送 token：/tmp 是全局可写的，任何人都能抢注同名 socket 路径，
    // 抢注者拿到 token 就等于拿到该 config 全部 PTY 的完整读写权限。
    assertSocketOwnership(this.socketPath);
    this.activeToken = this.readToken();
    const socket = net.createConnection(this.socketPath);
    this.framesOnCurrentSocket = 0;
    socket.setNoDelay(true);
    this.socket = socket;
    try {
      await waitForDaemonSocket(socket);
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      throw error;
    }
    // 新 socket 从干净状态开始解码：上一条连接留下的半帧不能污染这一条。
    this.resetFrameDecoder();
    this.offlineOperationLogged = false;
    socket.on("data", (data) => {
      if (this.socket === socket) this.consume(data);
    });
    // 传 socket 引用：旧连接的迟到 close/error 不能影响当前连接上的在途请求。
    socket.on("close", () => this.handleDisconnect(socket));
    socket.on("error", () => this.handleDisconnect(socket));
    this.reconciling = true;
    try {
      const hello = this.parseHello(await this.request("hello", undefined, "hello"));
      if (hello.protocolVersion !== RENDER_PROTOCOL_VERSION) {
        const fatal = new Error(
          `Render protocol version mismatch: daemon reports ${hello.protocolVersion}, Server requires ${RENDER_PROTOCOL_VERSION}. ` +
          "Refusing to run degraded; upgrade the Render binary or switch render.engine back to legacy.",
        );
        this.fatalProtocolError = fatal;
        throw fatal;
      }
      this.fatalProtocolError = null;
      this.daemonVersion = hello.version;
      const previous = new Map(this.inventory);
      const sessions = await this.loadAuthoritativeSessions();
      this.inventory.clear();
      for (const state of sessions) this.inventory.set(state.sessionId, state);
      if (previous.size > 0) {
        this.reconcileAfterReconnect(previous);
        process.stderr.write("[wand] Reconnected to Render; reconciled PTY inventory.\n");
      }
      this.reconciling = false;
      const queued = this.eventsDuringReconcile;
      this.eventsDuringReconcile = [];
      const reconcile = this.reconcileDuringSync;
      this.reconcileDuringSync = null;
      for (const event of queued) this.routeEvent(event);
      if (reconcile) this.routeEvent(reconcile);
      for (const sessionId of this.pendingEventOverflows) {
        const handle = this.handles.get(sessionId);
        if (handle) void this.refreshSession(sessionId, handle);
      }
      if (this.disposed || this.socket !== socket) throw new Error("Render disconnected during adoption");
      this.stopHeartbeat?.();
      this.stopHeartbeat = startDaemonHeartbeat(socket, () => this.request("ping"), { socketPath: this.socketPath });
    } catch (error) {
      this.reconciling = false;
      this.eventsDuringReconcile = [];
      this.reconcileDuringSync = null;
      if (!this.disposed) {
        try { socket.destroy(); } catch { /* best-effort cleanup */ }
        this.handleDisconnect(socket);
      }
      throw this.describeConnectFailure(error);
    }
  }

  /**
   * 对端一个字节都没回就断开：daemon 对 token/协议不符的处理是直接 `close()`
   * （`wand-renderd` 的 `server.rs`），所以这是鉴权/版本问题的特征，不是网络抖动。
   * 归类为 `RenderAuthError`，由重连策略决定「别再 10s 一次拿同一把废 token 试」。
   */
  private describeConnectFailure(error: unknown): Error {
    const message = getErrorMessage(error);
    if (this.framesOnCurrentSocket > 0 || !/disconnected|unavailable/i.test(message)) {
      return error instanceof Error ? error : new Error(message);
    }
    return new RenderAuthError(
      `Render closed the connection without answering the hello (${message}); ` +
      "the daemon is likely holding a different token or protocol version than " +
      `${this.tokenPath ?? "the configured token"}. Refusing to retry the same credential blindly.`,
    );
  }

  /**
   * 读取当前凭据：每次都用 token 文件里的**最新**值（daemon 重启会轮换）。
   * 文件暂时读不到（渲染器正在退出、路径还没建）不是致命错误，回落到上一次成功
   * 读到的值并告警一次；下一次连接会重试读文件。
   */
  private readToken(): string {
    if (!this.tokenPath) return this.token;
    try {
      const token = readFileSync(this.tokenPath, "utf8").trim();
      if (token) {
        this.lastKnownToken = token;
        this.tokenReadFailureLogged = false;
        return token;
      }
      this.warnTokenFileUnusable("is empty");
    } catch (error) {
      this.warnTokenFileUnusable(getErrorMessage(error));
    }
    if (!this.lastKnownToken) {
      throw new Error(
        `Render token file ${this.tokenPath} cannot be read and no previous credential is known; refusing to connect anonymously.`,
      );
    }
    return this.lastKnownToken;
  }

  private warnTokenFileUnusable(reason: string): void {
    if (this.tokenReadFailureLogged) return;
    this.tokenReadFailureLogged = true;
    process.stderr.write(
      `[wand] Render token file ${this.tokenPath} ${reason}; reusing the last known credential and retrying the file on the next attempt.\n`,
    );
  }

  /** resize 走的是异步 RPC，但 inventory 必须立刻反映新尺寸（见 RemoteRenderProcess.resize）。 */
  noteTerminalResize(sessionId: string, cols: number, rows: number): void {
    const state = this.inventory.get(sessionId);
    if (!state) return;
    state.cols = cols;
    state.rows = rows;
  }

  attach(sessionId: string, afterSeq = 0): TerminalAttachResult | null {
    const state = this.inventory.get(sessionId);
    if (!state) return null;
    return this.resultFromState(state, false, afterSeq);
  }

  async createOrAttach(request: TerminalSpawnRequest, afterSeq = 0): Promise<TerminalAttachResult> {
    const existing = this.inventory.get(request.sessionId);
    if (existing) return this.resultFromState(existing, false, afterSeq);
    const params: RenderCreateOrAttachParams = {
      sessionId: request.sessionId,
      file: request.file,
      args: request.args,
      cwd: request.cwd,
      env: toRenderEnv(request.env),
      name: request.name,
      cols: request.cols,
      rows: request.rows,
      ...(request.launchMarkerToken ? { launchMarkerToken: request.launchMarkerToken } : {}),
      afterSeq,
    };
    const payload = await this.request("createOrAttach", { ...params }) as {
      state?: unknown;
      isNew?: unknown;
    } | null;
    const state = normalizeRenderSessionState(payload?.state);
    if (!state) {
      throw new Error(
        `Render returned an unusable createOrAttach payload for session ${request.sessionId}; refusing to guess the session state.`,
      );
    }
    this.inventory.set(state.sessionId, state);
    return this.resultFromState(state, payload?.isNew === true, afterSeq);
  }

  forget(sessionId: string): void {
    this.inventory.delete(sessionId);
    this.handles.delete(sessionId);
    this.pendingEvents.delete(sessionId);
    this.pendingEventOverflows.delete(sessionId);
    this.refreshingSessions.delete(sessionId);
    this.fireOperation(sessionId, "forget", { sessionId });
  }

  /**
   * 只解绑：关闭 socket、清掉内存句柄，**Render 进程与它的所有 PTY 都保持运行**。
   * 这是 Server / Render 分离的核心 —— 下一次启动 attach 回来仍拿到同一批会话。
   */
  disconnect(): void {
    this.disposed = true;
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new Error("Render client disposed"));
    this.handles.clear();
    this.pendingEvents.clear();
    this.pendingEventOverflows.clear();
    this.refreshingSessions.clear();
    this.eventsDuringReconcile = [];
    this.reconcileDuringSync = null;
    // inventory 只保留到本进程结束：它是内存快照，不写盘、不影响 Render。
  }

  /**
   * Best-effort 操作：Render 不可用时打 stderr，绝不把异常抛回调用方，
   * 否则一次 PTY 抖动会顺着 ProcessManager 把整个会话路径打断。
   */
  fireOperation(sessionId: string, method: RenderMethod, params?: Record<string, unknown>): void {
    void this.request(method, params).catch((error) => this.reportOperationError(sessionId, method, error));
  }

  async confirmWrite(sessionId: string, data: string): Promise<void> {
    await this.request("write", { sessionId, data });
  }

  reportOperationError(sessionId: string, method: RenderMethod, error: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      // socket 断开时每个输入包都会失败，只提示一次，避免刷满日志。
      if (this.offlineOperationLogged) return;
      this.offlineOperationLogged = true;
      process.stderr.write(
        `[wand] Render 未连接，${method} ${sessionId} 失败（后续同类失败不再重复提示；PTY 仍在 Render 侧运行）\n`,
      );
      return;
    }
    process.stderr.write(`[wand] Render ${method} failed for ${sessionId}: ${getErrorMessage(error)}\n`);
  }

  private async listSessions(): Promise<TerminalSessionState[]> {
    const result = await this.request("list") as { sessions?: unknown } | null;
    const raw = result?.sessions;
    if (!Array.isArray(raw)) {
      throw new Error(`Render list returned ${raw === undefined ? "no sessions array" : typeof raw}; refusing to adopt an unknown inventory.`);
    }
    const states: TerminalSessionState[] = [];
    for (const entry of raw) {
      const state = normalizeRenderSessionState(entry);
      if (state) states.push(state);
    }
    return states;
  }

  /** `list` locates sessions; each `attach` is the authoritative recovery state. */
  private async loadAuthoritativeSessions(): Promise<TerminalSessionState[]> {
    let sessionIds: string[];
    try {
      sessionIds = (await this.listSessions()).map((state) => state.sessionId);
    } catch (error) {
      // Protocol v1's list still includes bounded output/chunks per session,
      // so a large inventory can exceed one 64 MiB frame. The persisted PTY
      // IDs let this Server recover its own sessions via individual attaches.
      if (!/Render list failed \(internal\).*?(frame limit|MAX_FRAME_BYTES|exceeds)/i.test(getErrorMessage(error))) {
        throw error;
      }
      sessionIds = [...new Set([...this.knownSessionIds, ...this.inventory.keys(), ...this.handles.keys()])];
      process.stderr.write(`[wand] Render list exceeded its frame limit; attaching ${sessionIds.length} known PTY sessions individually.\n`);
    }
    const states: TerminalSessionState[] = [];
    // Keep in-flight full terminal snapshots bounded on a busy Render.
    for (let index = 0; index < sessionIds.length; index += 4) {
      const batch = sessionIds.slice(index, index + 4);
      const attached = await Promise.all(batch.map(async (sessionId) => {
        let result: { state?: unknown } | null;
        try {
          result = await this.request("attach", { sessionId, afterSeq: 0 }) as { state?: unknown } | null;
        } catch (error) {
          if (/Render attach failed \(notFound\)/.test(getErrorMessage(error))) return null;
          throw error;
        }
        const state = normalizeRenderSessionState(result?.state);
        if (!state || state.sessionId !== sessionId) {
          throw new Error(`Render attach returned an unusable state for ${sessionId}; refusing partial recovery.`);
        }
        return state;
      }));
      states.push(...attached.filter((state): state is TerminalSessionState => state !== null));
    }
    return states;
  }

  private parseHello(value: unknown): RenderHelloResult {
    if (!value || typeof value !== "object") {
      throw new Error("Render hello returned an unusable payload; refusing to adopt this daemon.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.protocolVersion !== "number") {
      throw new Error("Render hello did not report protocolVersion; refusing to adopt this daemon.");
    }
    return {
      version: typeof record.version === "string" ? record.version : "",
      protocolVersion: record.protocolVersion,
      pid: typeof record.pid === "number" ? record.pid : 0,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
      sessions: typeof record.sessions === "number" ? record.sessions : 0,
    };
  }

  private async request(
    method: RenderMethod,
    params?: Record<string, unknown>,
    // hello 是唯一允许在 fatalProtocolError 之后仍尝试的请求：它正是判定该错误的地方。
    bypassFatalGuard?: string,
  ): Promise<unknown> {
    if (this.fatalProtocolError && bypassFatalGuard !== "hello") throw this.fatalProtocolError;
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new Error("Render is unavailable");
    const id = this.nextRequestId++;
    const request: RenderRequest = {
      id,
      token: this.activeToken || this.token,
      protocolVersion: RENDER_PROTOCOL_VERSION,
      method,
      params,
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Render ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      socket.write(encodeRenderFrame(request));
    });
  }

  private consume(chunk: Buffer): void {
    // 逐帧解码：大帧（list 的 replay 可能几十 MB）必须以分片累积，
    // 每次 socket read 都整块 concat 会退化成 O(n²) 拷贝。
    let offset = 0;
    while (offset < chunk.length) {
      if (this.frameLength === null) {
        const take = Math.min(4 - this.headerBytes, chunk.length - offset);
        this.headerParts.push(chunk.subarray(offset, offset + take));
        this.headerBytes += take;
        offset += take;
        if (this.headerBytes < 4) return;
        const header = this.headerParts.length === 1
          ? this.headerParts[0]
          : Buffer.concat(this.headerParts, 4);
        this.headerParts = [];
        this.headerBytes = 0;
        const length = header.readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) {
          process.stderr.write(
            `[wand] Render frame length ${length} exceeds the ${MAX_FRAME_BYTES} byte limit; closing the connection.\n`,
          );
          this.socket?.destroy();
          return;
        }
        this.frameLength = length;
        this.bodyParts = [];
        this.bodyBytes = 0;
        continue;
      }
      const take = Math.min(this.frameLength - this.bodyBytes, chunk.length - offset);
      this.bodyParts.push(chunk.subarray(offset, offset + take));
      this.bodyBytes += take;
      offset += take;
      if (this.bodyBytes < this.frameLength) return;
      const body = this.bodyParts.length === 1
        ? this.bodyParts[0]
        : Buffer.concat(this.bodyParts, this.bodyBytes);
      this.frameLength = null;
      this.bodyParts = [];
      this.bodyBytes = 0;
      this.handleFrame(body);
    }
  }

  private resetFrameDecoder(): void {
    this.headerParts = [];
    this.headerBytes = 0;
    this.bodyParts = [];
    this.bodyBytes = 0;
    this.frameLength = null;
  }

  private handleFrame(body: Buffer): void {
    if (body.length === 0) return;
    this.framesOnCurrentSocket += 1;
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch (error) {
      process.stderr.write(`[wand] Render sent an undecodable frame: ${getErrorMessage(error)}\n`);
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.event === undefined) {
      this.handleResponse(message as RenderResponse);
      return;
    }
    this.routeEvent(message as RenderEvent);
  }

  private handleResponse(message: RenderResponse): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const code = message.error?.code ?? "unknown";
    const detail = message.error?.message ?? "";
    pending.reject(new Error(`Render ${pending.method} failed (${code})${detail ? `: ${detail}` : ""}`));
  }

  private routeEvent(event: RenderEvent): void {
    if (this.reconciling) {
      if (event.event === "reconcile") {
        this.reconcileDuringSync = event;
        return;
      }
      this.eventsDuringReconcile.push(event);
      if (this.eventsDuringReconcile.length > MAX_PENDING_EVENTS) {
        const dropped = this.eventsDuringReconcile.shift();
        if (dropped && "sessionId" in dropped) this.pendingEventOverflows.add(dropped.sessionId);
      }
      return;
    }
    if (event.event === "reconcile") {
      this.handleReconcileEvent(event.sessionIds);
      return;
    }
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    const incarnationId = typeof event.incarnationId === "string" ? event.incarnationId : "";
    if (!sessionId || !incarnationId) {
      process.stderr.write("[wand] Render sent an event without sessionId/incarnationId; ignoring it.\n");
      return;
    }
    const state = this.inventory.get(sessionId);
    const handle = this.handles.get(sessionId);
    if (this.refreshingSessions.has(sessionId) || !handle || handle.incarnationId !== incarnationId) {
      // Keep the authoritative attach state immutable until a process handle
      // exists. A later resultFromState filters events already in that state.
      this.queuePendingEvent(sessionId, event);
      return;
    }
    if (state && state.incarnationId === incarnationId) {
      if (event.event === "data" && typeof event.data === "string" && typeof event.seq === "number") {
        if (event.seq <= state.seq) return;
        if (event.seq > state.seq + 1) {
          this.queuePendingEvent(sessionId, event);
          void this.refreshSession(sessionId, handle);
          return;
        }
        state.seq = Math.max(state.seq, event.seq);
        state.output = appendWindow(state.output, event.data, PTY_OUTPUT_MAX_SIZE);
        state.chunks = appendTerminalChunkWindow(state.chunks, { data: event.data, seq: event.seq });
      } else if (event.event === "exit") {
        state.status = "exited";
        state.exitCode = event.exitCode ?? -1;
      }
    }
    if (event.event === "data" && typeof event.data === "string" && typeof event.seq === "number") {
      handle.acceptData({ data: event.data, seq: event.seq });
    } else if (event.event === "exit") {
      handle.acceptExit({ exitCode: event.exitCode ?? -1, signal: event.signal ?? undefined });
      this.handles.delete(sessionId);
    }
  }

  private queuePendingEvent(sessionId: string, event: RenderEvent): void {
    const buffered = this.pendingEvents.get(sessionId) ?? [];
    buffered.push(event);
    if (buffered.length > MAX_PENDING_EVENTS) {
      buffered.shift();
      this.pendingEventOverflows.add(sessionId);
    }
    this.pendingEvents.set(sessionId, buffered);
  }

  /** Repair a bounded event-buffer overflow without replaying a partial stream. */
  private async refreshSession(sessionId: string, handle: RemoteRenderProcess): Promise<void> {
    if (this.refreshingSessions.has(sessionId) || this.disposed) return;
    this.refreshingSessions.add(sessionId);
    try {
      const result = await this.request("attach", { sessionId, afterSeq: 0 }) as { state?: unknown } | null;
      const state = normalizeRenderSessionState(result?.state);
      if (!state || state.sessionId !== sessionId || state.incarnationId !== handle.incarnationId) {
        throw new Error(`Render attach returned an unusable state while refreshing ${sessionId}`);
      }
      if (this.handles.get(sessionId) !== handle) {
        this.refreshingSessions.delete(sessionId);
        return;
      }
      this.inventory.set(sessionId, state);
      handle.acceptResync(state);
      if (state.status === "exited") {
        this.handles.delete(sessionId);
        handle.acceptExit({ exitCode: state.exitCode ?? -1 });
      }
      const pending = this.pendingEvents.get(sessionId) ?? [];
      this.pendingEvents.delete(sessionId);
      this.pendingEventOverflows.delete(sessionId);
      this.refreshingSessions.delete(sessionId);
      if (state.status === "running") {
        for (const event of pending) this.routeEvent(event);
      }
    } catch (error) {
      this.refreshingSessions.delete(sessionId);
      this.reportOperationError(sessionId, "attach", error);
      // A fresh connection will reattach all sessions; keeping this socket
      // alive would leave its missing output invisible indefinitely.
      this.socket?.destroy();
    }
  }

  /**
   * Render 主动告知当前会话集合（例如自身清掉了已 forget 的会话）。不在
   * 集合里的会话要给既有句柄补一个退出事件，否则 ProcessManager 会永远停在 running。
   */
  private handleReconcileEvent(sessionIds: unknown): void {
    if (!Array.isArray(sessionIds)) {
      process.stderr.write("[wand] Render sent a reconcile event without a sessionIds array; ignoring it.\n");
      return;
    }
    const live = new Set(sessionIds.filter((id): id is string => typeof id === "string"));
    for (const sessionId of Array.from(this.inventory.keys())) {
      if (!live.has(sessionId)) {
        this.inventory.delete(sessionId);
        this.pendingEvents.delete(sessionId);
        this.pendingEventOverflows.delete(sessionId);
      }
    }
    for (const sessionId of Array.from(this.handles.keys())) {
      if (live.has(sessionId)) continue;
      const handle = this.handles.get(sessionId)!;
      this.handles.delete(sessionId);
      handle.acceptExit({ exitCode: -1 });
    }
  }

  /**
   * Socket 断开后的重连。不做重连的话，Render 重启一次所有
   * RemoteRenderProcess 就会静默失效，而 ProcessManager 仍显示 running。
   */
  private handleDisconnect(origin: net.Socket): void {
    if (this.socket !== origin) return;
    this.socket = null;
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
    origin.destroy();
    this.rejectPending(new Error("Render disconnected"));
    if (this.disposed || this.fatalProtocolError) return;
    this.scheduleReconnect();
  }

  /** 被同一个凭据反复拒绝时置位：下一次重连改用长退避（见 `scheduleReconnect`）。 */
  private authBackoff = false;

  /**
   * 安排下一次重连（已有定时器时不重排：一次失败可能会从 close/error 两条路径
   * 各调一次，重排会把退避倍率叠成指数增长）。需要**覆盖**已有定时器的场景
   * （鉴权失败要把 10s 换成 60s）由调用方显式清掉再调。
   */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delayMs = this.authBackoff ? AUTH_FAILURE_RETRY_MS : this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, delayMs);
    this.reconnectTimer.unref?.();
    if (!this.authBackoff) {
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    }
  }

  private async tryReconnect(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.connect();
      this.reconnectDelayMs = RECONNECT_INITIAL_MS;
      this.reconnectFailureLogged = false;
      this.authBackoff = false;
    } catch (error) {
      if (this.disposed) return;
      const stalled = this.noteReconnectFailure(error);
      if (stalled && this.reconnectTimer) {
        // 断线路径已经按普通退避排过一次；用 60s 的长退避覆盖它。
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.scheduleReconnect();
    }
  }

  /**
   * 重连失败的日志与「同一把废 token」判定。
   *
   * 判定依据：刚刚用掉的那把凭据（`activeToken`，每次连接开头从 token 文件重读）
   * 与文件里**现在**这一把相同 → 再试同一个值不可能成功（对端持有的是别的 token，
   * 多来自 `-c` 指到了另一个 config 或有人在手工改 token 文件），摆成 60s 长退避。
   * 文件已经变了就按普通退避重试 —— 那正是 daemon 重启轮换 token 后的自愈路径。
   * @returns 是否处于「同一把废凭据」状态（调用方据此换长退避）
   */
  private noteReconnectFailure(error: unknown): boolean {
    if (!(error instanceof RenderAuthError)) {
      this.authBackoff = false;
      if (!this.reconnectFailureLogged) {
        this.reconnectFailureLogged = true;
        process.stderr.write(`[wand] Render reconnect failed: ${getErrorMessage(error)}\n`);
      }
      return false;
    }
    const current = this.currentTokenFileValue();
    const stalled = current !== null && current === this.activeToken;
    this.authBackoff = stalled;
    if (!this.reconnectFailureLogged) {
      this.reconnectFailureLogged = true;
      process.stderr.write(
        `[wand] Render rejected the credential (${error.message})` +
        `${stalled ? ` — retrying every ${AUTH_FAILURE_RETRY_MS / 1000}s instead of ${RECONNECT_MAX_MS / 1000}s until the daemon restarts` : ""}; ` +
        "the token file is re-read on every attempt.\n",
      );
    }
    return stalled;
  }

  /** 只读 token 文件当前值（不改状态）；读不到返回 null。 */
  private currentTokenFileValue(): string | null {
    if (!this.tokenPath) return null;
    try {
      return readFileSync(this.tokenPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * 断线期间 Render 可能新建/结束会话。用断线前的 inventory 与新的 `list` 对账：
   * 活着的补发缺口 chunk；消失或已退出的给句柄补合成退出。
   */
  private reconcileAfterReconnect(previous: Map<string, TerminalSessionState>): void {
    for (const [sessionId, oldState] of previous) {
      const current = this.inventory.get(sessionId);
      const handle = this.handles.get(sessionId);
      const handleMatches = !!handle && handle.incarnationId === oldState.incarnationId;
      const sameIncarnation = !!current && current.incarnationId === oldState.incarnationId;
      if (sameIncarnation && handleMatches) {
        const missing = current!.chunks.filter((chunk) => chunk.seq > oldState.seq);
        const contiguous = current!.seq === oldState.seq
          || (missing.length > 0
            && missing[0].seq === oldState.seq + 1
            && missing[missing.length - 1].seq === current!.seq
            && missing.every((chunk, index) => index === 0 || chunk.seq === missing[index - 1].seq + 1));
        if (contiguous) {
          for (const chunk of missing) handle!.acceptData(chunk);
        } else {
          handle!.acceptResync(current!);
          process.stderr.write(`[wand] Render replay gap for ${sessionId}: ${oldState.seq} → ${current!.seq}; rebuilt from attach snapshot.\n`);
        }
        if (current!.status === "running") continue;
      }
      const exitedOnRender = sameIncarnation && current!.status === "exited";
      const exitCode = exitedOnRender ? current!.exitCode ?? -1 : -1;
      this.handles.delete(sessionId);
      if (handleMatches) handle!.acceptExit({ exitCode });
    }
  }

  private resultFromState(state: TerminalSessionState, isNew: boolean, afterSeq: number): TerminalAttachResult {
    let process = this.handles.get(state.sessionId) ?? null;
    if (state.status === "running" && (!process || process.incarnationId !== state.incarnationId)) {
      process = new RemoteRenderProcess(state.sessionId, state.incarnationId, state.pid, this);
      this.handles.set(state.sessionId, process);
      const buffered = this.pendingEvents.get(state.sessionId) ?? [];
      this.pendingEvents.delete(state.sessionId);
      if (this.pendingEventOverflows.delete(state.sessionId)) {
        // We have dropped at least one event before the caller could attach.
        // Fetch the current screen after it binds listeners; stale buffered
        // bytes must not be emitted as though they were contiguous.
        queueMicrotask(() => void this.refreshSession(state.sessionId, process!));
      } else {
        for (const event of buffered) {
          // 已经在 state.seq 里的 data 重复投递会造成终端重复输出，必须过滤。
          const alreadyInSnapshot = event.event === "data"
            ? typeof event.seq === "number" && event.seq <= state.seq
            : false;
          if (!alreadyInSnapshot) this.routeEvent(event);
        }
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

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** `TerminalSpawnRequest.env` 允许 undefined 值，协议里只接受字符串。 */
function toRenderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function warnStateIssue(message: string): void {
  process.stderr.write(`[wand] Render session state rejected: ${message}\n`);
}

/**
 * 运行期校验 Render 的 SessionState。
 *
 * 协议是跨语言契约（Rust 侧字段名漂移过一次就是静默的空终端），所以这里不做
 * 结构断言直接使用，而是逐字段检查：能修的补默认值，修不了的整条丢弃并打警告。
 */
export function normalizeRenderSessionState(value: unknown): TerminalSessionState | null {
  if (!value || typeof value !== "object") {
    warnStateIssue(`expected an object, got ${value === null ? "null" : typeof value}`);
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionId = asString(record.sessionId);
  const incarnationId = asString(record.incarnationId);
  if (!sessionId || !incarnationId) {
    warnStateIssue(`missing sessionId/incarnationId (${JSON.stringify(record.sessionId)}/${JSON.stringify(record.incarnationId)})`);
    return null;
  }
  const problems: string[] = [];
  const pid = asNumber(record.pid, 0, problems, "pid");
  const cols = asNumber(record.cols, 80, problems, "cols");
  const rows = asNumber(record.rows, 24, problems, "rows");
  const seq = asNumber(record.seq, 0, problems, "seq");
  const status = record.status === "exited" ? "exited" : record.status === "running" ? "running" : null;
  if (status === null) problems.push(`status=${JSON.stringify(record.status)}`);
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
  const output = typeof record.output === "string" ? record.output : "";
  if (typeof record.output !== "string") problems.push(`output=${typeof record.output}`);
  const chunks = normalizeChunks(record.chunks, problems);
  const terminalSnapshot = normalizeSnapshot(record.terminalSnapshot, problems);
  const launchMarkerToken = typeof record.launchMarkerToken === "string" ? record.launchMarkerToken : null;
  if (problems.length > 0) {
    // 补齐后继续用，比整条会话变成空终端好；但一定要留痕。
    process.stderr.write(`[wand] Render session state for ${sessionId} has unexpected fields: ${problems.join(", ")}\n`);
  }
  return {
    sessionId,
    incarnationId,
    pid,
    status: status ?? "exited",
    exitCode,
    cols,
    rows,
    seq,
    output,
    chunks,
    terminalSnapshot,
    launchMarkerToken,
  };
}

function normalizeChunks(value: unknown, problems: string[]): { data: string; seq: number }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`chunks=${typeof value}`);
    return [];
  }
  const out: { data: string; seq: number }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.data !== "string" || typeof record.seq !== "number") continue;
    out.push({ data: record.data, seq: record.seq });
  }
  if (out.length !== value.length) problems.push(`chunks dropped ${value.length - out.length}/${value.length} malformed entries`);
  return out;
}

function normalizeSnapshot(
  value: unknown,
  problems: string[],
): PtyTerminalSnapshot | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") {
    problems.push(`terminalSnapshot=${typeof value}`);
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    // 版本不同的快照语义未知，写进客户端可能得到错误屏幕；宁可退回重放 chunks。
    problems.push(`terminalSnapshot.version=${JSON.stringify(record.version)}`);
    return null;
  }
  if (typeof record.data !== "string" || typeof record.cols !== "number" || typeof record.rows !== "number") {
    problems.push("terminalSnapshot shape mismatch");
    return null;
  }
  const pending: PtyTerminalSnapshot["pending"] = [];
  if (!Array.isArray(record.pending)) {
    problems.push(`terminalSnapshot.pending=${typeof record.pending}`);
    return { version: 1, data: record.data, cols: record.cols, rows: record.rows, pending };
  }
  for (const entry of record.pending) {
    if (!entry || typeof entry !== "object") {
      problems.push("terminalSnapshot.pending has a malformed entry");
      continue;
    }
    const op = entry as Record<string, unknown>;
    if (op.type === "data" && typeof op.data === "string") pending.push({ type: "data", data: op.data });
    else if (op.type === "resize" && typeof op.cols === "number" && typeof op.rows === "number") {
      pending.push({ type: "resize", cols: op.cols, rows: op.rows });
    } else {
      // 丢掉未知 pending 会让客户端屏幕与 Render 不一致，必须留痕。
      problems.push(`terminalSnapshot.pending dropped ${JSON.stringify(op.type)}`);
    }
  }
  return { version: 1, data: record.data, cols: record.cols, rows: record.rows, pending };
}

/**
 * 连接前的对端校验：必须是属于当前用户、且 group/other 不可写的 unix socket。
 *
 * socket 路径固定派生在 /tmp，抢注竞态是真实威胁：抢注者能拿到随首个 hello
 * 发出的 token。属于别的用户直接拒绝；同用户其余情况（权限过宽）也拒绝。
 * 不校验 0600 是因为 `net.Server.listen` 的默认 umask 结果是 0755，而真正
 * 决定安全性的「谁能写」已由 group/other 位覆盖。
 */
function assertSocketOwnership(socketPath: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(socketPath);
  } catch (error) {
    throw new Error(`Render socket ${socketPath} is not accessible: ${getErrorMessage(error)}`);
  }
  if (!stats.isSocket()) {
    throw new Error(`Render socket ${socketPath} is not a unix socket; refusing to hand over the Render token.`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stats.uid !== uid) {
    throw new Error(
      `Render socket ${socketPath} is owned by uid ${stats.uid}, not by this user (${uid}); ` +
      "refusing to hand over the Render token.",
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(
      `Render socket ${socketPath} is writable by group/other (mode ${(stats.mode & 0o777).toString(8)}); ` +
      "refusing to hand over the Render token.",
    );
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number, problems: string[], label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  problems.push(`${label}=${JSON.stringify(value)}`);
  return fallback;
}

/**
 * 连接一个已经存在的 Render（socket + token 都在）。**不 spawn**，找不到就返回 null，
 * 这样调用方可以区分「已被别处 adopt」和「需要自己拉起」。
 */
export async function connectExistingRenderClient(
  configPath: string,
  knownSessionIds: readonly string[] = [],
): Promise<RenderDaemonClient | null> {
  const { socketPath, tokenPath } = renderPaths(configPath);
  let token: string;
  try { token = readFileSync(tokenPath, "utf8").trim(); }
  catch { return null; }
  if (!token) return null;
  // 传 tokenPath 让重连路径在 daemon 轮换 token 后能自愈（见构造函数注释）。
  const client = new RenderDaemonClient(socketPath, token, tokenPath, knownSessionIds);
  try {
    await client.connect();
    return client;
  } catch (error) {
    if (process.env.WAND_RENDER_DEBUG === "1") {
      process.stderr.write(`[wand] Render adoption failed: ${getErrorMessage(error)}\n`);
    }
    client.disconnect();
    return null;
  }
}
