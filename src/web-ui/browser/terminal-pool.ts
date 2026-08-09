// 终端实例池（工作空间「分屏」专用）。
// 与 state.terminal 单例**完全隔离**：仅在用户显式分屏、<WorkspaceWindow/> 渲染多个窗格时
// 才创建池实例。非工作空间 / 单窗格的默认 UI 仍走单例 state.terminal，本模块零影响。
//
// 每个池实例：自己的 XTermLib.Terminal（深色主题/字体与 initTerminal 对齐）+ FitAddon，
// 挂到所属窗格容器，回放 state.sessions 里该会话的历史 output，并向 ws 订阅该 sessionId；
// websocket.ts 的输出分发里用 hasPooledTerminal() 把对应 chunk 路由进来（见 writePooledTerminal）。

import { clampClientTerminalOutput } from "./terminal";
import { state } from "./state";

/** 把 chunk 追加进该会话在 state.sessions 里的 output 缓冲（带 clamp），供将来 remount 回放，避免丢字。 */
function appendSessionOutput(sessionId: string, chunk: string): void {
  const sessions = state.sessions as Array<{ id?: string; output?: string }>;
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.output = clampClientTerminalOutput((session.output || "") + chunk);
}

/** 全量 output 覆盖会话缓冲（权威回放时调用）。 */
function setSessionOutput(sessionId: string, output: string): void {
  const sessions = state.sessions as Array<{ id?: string; output?: string }>;
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.output = clampClientTerminalOutput(output);
}

interface PooledTerminal {
  sessionId: string;
  terminal: any; // XTermLib.Terminal
  fitAddon: any;
  wrap: HTMLDivElement;
  container: HTMLElement;
  resizeObserver: ResizeObserver;
  writeQueue: Promise<void>;
  restoreGeneration: number;
  disposed: boolean;
}

const pool = new Map<string, PooledTerminal>();
const sessionScales = new Map<string, number>();

function clampScale(value: number): number {
  return Math.round(Math.max(0.5, Math.min(2, value)) * 4) / 4;
}

function ws(): WebSocket | null {
  return state.ws && state.ws.readyState === WebSocket.OPEN ? state.ws : null;
}

function sendJson(message: Record<string, unknown>): void {
  const socket = ws();
  if (socket) socket.send(JSON.stringify(message));
}

function terminalFontFamily(): string {
  // 与 initTerminal 保持一致：读 CSS 变量，兜底等宽。
  const candidate = typeof getComputedStyle === "function"
    ? getComputedStyle(document.documentElement).getPropertyValue("--term-font-family").trim()
    : "";
  return candidate || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
}

function terminalFontSize(scale = Number(state.terminalScale || 1)): number {
  const base = document.documentElement.classList.contains("is-wand-embed-terminal")
    ? 10
    : state.terminalBaseFontSize || 13;
  return Math.max(8, Math.round(base * scale));
}

function sendInput(sessionId: string, data: string): void {
  sendJson({ type: "pty_input", sessionId, data, userInput: state.terminalInteractive === true });
}

function sendResize(sessionId: string, cols: number, rows: number): void {
  const c = Math.max(20, Math.min(Math.floor(cols), 1000));
  const r = Math.max(5, Math.min(Math.floor(rows), 500));
  sendJson({ type: "pty_resize", sessionId, cols: c, rows: r });
}

/** FitAddon 只在 cols/rows 变化时触发 onResize；首次 fit 可能早于监听器，因此总是显式同步一次。 */
function fitAndSync(handle: Pick<PooledTerminal, "sessionId" | "terminal" | "fitAddon" | "disposed">): void {
  if (handle.disposed) return;
  try { handle.fitAddon.fit(); } catch { /* container not laid out yet */ }
  const cols = Number(handle.terminal.cols);
  const rows = Number(handle.terminal.rows);
  if (cols > 0 && rows > 0) sendResize(handle.sessionId, cols, rows);
}

/** 字体度量和递归 flex 在同一帧内可能尚未稳定；补两帧和一次短延迟校准。 */
function scheduleFitAndSync(handle: PooledTerminal): void {
  requestAnimationFrame(() => {
    fitAndSync(handle);
    requestAnimationFrame(() => fitAndSync(handle));
  });
  window.setTimeout(() => fitAndSync(handle), 120);
}

export function getPooledTerminalScale(sessionId: string): number {
  return sessionScales.get(sessionId) ?? clampScale(Number(state.terminalScale || 1));
}

/** 每个分屏终端独立缩放；改变字体后重新 fit，并把新的 PTY 尺寸同步给服务端。 */
export function setPooledTerminalScale(sessionId: string, value: number): number {
  const scale = clampScale(value);
  sessionScales.set(sessionId, scale);
  const handle = pool.get(sessionId);
  if (!handle || handle.disposed) return scale;
  handle.terminal.options.fontSize = terminalFontSize(scale);
  scheduleFitAndSync(handle);
  return scale;
}

export function hasPooledTerminal(sessionId: string): boolean {
  return pool.has(sessionId);
}

export function getPooledTerminal(sessionId: string): PooledTerminal | undefined {
  return pool.get(sessionId);
}

function writeTerminal(handle: PooledTerminal, data: string): Promise<void> {
  if (!data || handle.disposed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      handle.terminal.write(data, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** 在 container 内为 sessionId 创建一个独立的终端实例并订阅其输出。幂等：已存在则先释放重建。 */
export function createPooledTerminal(sessionId: string, container: HTMLElement): boolean {
  if (!sessionId || !container) return false;
  const existing = pool.get(sessionId);
  if (existing && !existing.disposed) {
    // 标签跨窗格移动时 React 会给同一会话一个新容器。复用终端可以避免闪烁，
    // 但必须把实际 DOM 和 ResizeObserver 一并迁过去，否则目标窗格只会是空白。
    if (existing.container !== container) {
      try { existing.resizeObserver.disconnect(); } catch { /* ignore */ }
      container.appendChild(existing.wrap);
      existing.container = container;
      existing.resizeObserver.observe(container);
    }
    scheduleFitAndSync(existing);
    return true;
  }
  const XTermLib = (globalThis as { XTermLib?: any }).XTermLib;
  if (!XTermLib || !XTermLib.Terminal || !XTermLib.FitAddon) return false;

  const wrap = document.createElement("div");
  wrap.className = "terminal-scroll-wrap pooled-terminal-wrap";
  container.appendChild(wrap);

  const term = new XTermLib.Terminal({
    cols: 120,
    rows: 36,
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: false,
    disableStdin: false,
    fontFamily: terminalFontFamily(),
    fontSize: terminalFontSize(getPooledTerminalScale(sessionId)),
    lineHeight: 1.25,
    scrollback: 5000,
    theme: {
      background: "#1f1b17",
      foreground: "#f4eee6",
      cursor: "#d88d60",
      selectionBackground: "rgba(216, 141, 96, 0.3)",
    },
  });
  const fitAddon = new XTermLib.FitAddon();
  let unicodeAddon: any = null;
  try {
    if (XTermLib.Unicode11Addon) {
      unicodeAddon = new XTermLib.Unicode11Addon();
      term.loadAddon(unicodeAddon);
      term.unicode.activeVersion = "11";
    }
  } catch { /* optional */ }
  term.loadAddon(fitAddon);
  term.open(wrap);

  // 先按真实容器尺寸 fit，再回放 ANSI 历史。否则 120 列历史会在窄窗格中被
  // xterm 二次折行，出现竖排字符和破碎 banner。
  try { fitAddon.fit(); } catch { /* ResizeObserver 会在布局稳定后补一次 */ }

  term.onData((data: string) => sendInput(sessionId, data));
  term.onBinary((data: string) => {
    if (state.terminalInteractive) sendInput(sessionId, data);
  });
  term.onResize((size: { cols: number; rows: number }) => sendResize(sessionId, size.cols, size.rows));

  const resizeObserver = new ResizeObserver(() => {
    const current = pool.get(sessionId);
    if (current) fitAndSync(current);
  });
  resizeObserver.observe(container);

  const handle: PooledTerminal = {
    sessionId,
    terminal: term,
    fitAddon,
    wrap,
    container,
    resizeObserver,
    writeQueue: Promise.resolve(),
    restoreGeneration: 0,
    disposed: false,
  };
  pool.set(sessionId, handle);

  // 优先恢复服务端的 xterm 序列化快照。它记录了原始 cols/rows 与 resize
  // 操作，能在 fit 到半宽窗格前保持 ANSI 光标语义；raw output 只作旧会话兜底。
  const session = (state.sessions as Array<{ id?: string; output?: string; terminalState?: unknown }>)
    .find((item) => item.id === sessionId);
  const cachedState = state.terminalStatesBySession?.[sessionId];
  if (!restorePooledTerminalState(sessionId, session?.terminalState ?? cachedState, session?.output || "")) {
    replacePooledTerminalOutput(sessionId, session?.output || "");
  }

  // 订阅该会话的实时输出（服务端支持多会话并发订阅）。
  sendJson({ type: "subscribe", mode: "add", sessionId, capabilities: { ptyAck: true } });

  // React/flex 布局通常要到下一帧才稳定。无论 fit 是否改变 xterm 尺寸，都显式
  // 把当前 cols/rows 发给 PTY，避免“前端已半宽、后端仍是合并前全宽”的换行错位。
  scheduleFitAndSync(handle);
  return true;
}

/** WebSocket 重连后，服务端会清掉旧连接的订阅；恢复全部可见池终端。 */
export function resubscribePooledTerminals(): void {
  for (const sessionId of pool.keys()) {
    sendJson({ type: "subscribe", mode: "add", sessionId, capabilities: { ptyAck: true } });
  }
}

/** websocket 输出分发调用：把增量 chunk 写入对应池实例，并释放服务端流控（ack）。 */
export function writePooledTerminal(sessionId: string, data: string, ackBytes?: number): void {
  appendSessionOutput(sessionId, data);
  const handle = pool.get(sessionId);
  if (!handle || handle.disposed) {
    if (ackBytes && sessionId) sendJson({ type: "pty_ack", sessionId, bytes: ackBytes });
    return;
  }
  handle.writeQueue = handle.writeQueue.catch(() => {}).then(async () => {
    await writeTerminal(handle, data);
    if (!handle.disposed) {
      try { handle.terminal.scrollToBottom(); } catch { /* ignore */ }
    }
    if (ackBytes && sessionId) sendJson({ type: "pty_ack", sessionId, bytes: ackBytes });
  });
}

/** 全量 output 回放（无 chunk 时的兜底）：重置后整体写入。 */
export function replacePooledTerminalOutput(sessionId: string, output: string): void {
  setSessionOutput(sessionId, output);
  const handle = pool.get(sessionId);
  if (!handle || handle.disposed) return;
  const generation = ++handle.restoreGeneration;
  handle.writeQueue = handle.writeQueue.catch(() => {}).then(async () => {
    if (handle.disposed || generation !== handle.restoreGeneration) return;
    try {
      handle.terminal.reset();
      handle.terminal.clear();
    } catch { /* ignore */ }
    await writeTerminal(handle, output);
    if (handle.disposed || generation !== handle.restoreGeneration) return;
    try { handle.terminal.scrollToBottom(); } catch { /* ignore */ }
  });
}

/** 与单例终端 restoreTerminalState 相同的快照恢复流程，目标改为池实例。 */
export function restorePooledTerminalState(
  sessionId: string,
  snapshot: any,
  fallbackOutput = "",
): boolean {
  if (!snapshot || snapshot.version !== 1) return false;
  if (sessionId) state.terminalStatesBySession[sessionId] = snapshot;
  setSessionOutput(sessionId, fallbackOutput);
  const handle = pool.get(sessionId);
  if (!handle || handle.disposed) return true;
  const generation = ++handle.restoreGeneration;
  handle.writeQueue = handle.writeQueue.catch(() => {}).then(async () => {
    if (handle.disposed || generation !== handle.restoreGeneration) return;
    try {
      handle.terminal.reset();
      handle.terminal.clear();
      if (snapshot.cols > 0 && snapshot.rows > 0) {
        handle.terminal.resize(snapshot.cols, snapshot.rows);
      }
    } catch { /* ignore */ }
    await writeTerminal(handle, String(snapshot.data || ""));
    const pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
    for (const operation of pending) {
      if (handle.disposed || generation !== handle.restoreGeneration) return;
      if (operation?.type === "resize" && operation.cols > 0 && operation.rows > 0) {
        try { handle.terminal.resize(operation.cols, operation.rows); } catch { /* ignore */ }
      } else if (operation?.type === "data") {
        await writeTerminal(handle, String(operation.data || ""));
      }
    }
    if (handle.disposed || generation !== handle.restoreGeneration) return;
    try {
      fitAndSync(handle);
      handle.terminal.scrollToBottom();
    } catch { /* ignore */ }
  });
  return true;
}

export function fitPooledTerminal(sessionId: string): void {
  const handle = pool.get(sessionId);
  if (!handle || handle.disposed) return;
  fitAndSync(handle);
}

export function focusPooledTerminal(sessionId: string): void {
  const handle = pool.get(sessionId);
  if (!handle || handle.disposed) return;
  try { handle.terminal.focus(); } catch { /* ignore */ }
}

/** 释放单个池实例（窗格关闭 / 会话移除时）。 */
export function disposePooledTerminal(sessionId: string): void {
  const handle = pool.get(sessionId);
  if (!handle) return;
  handle.disposed = true;
  try { handle.resizeObserver.disconnect(); } catch { /* ignore */ }
  try { handle.terminal.dispose(); } catch { /* ignore */ }
  if (handle.wrap.parentNode) handle.wrap.parentNode.removeChild(handle.wrap);
  pool.delete(sessionId);
  sendJson({ type: "unsubscribe", sessionId });
}

/** 退出分屏模式时清空整个池。 */
export function disposeAllPooledTerminals(): void {
  for (const sessionId of [...pool.keys()]) disposePooledTerminal(sessionId);
}
