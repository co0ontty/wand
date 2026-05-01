import { ProcessManager } from "../process-manager.js";
import { StructuredSessionManager } from "../structured-session-manager.js";
import { ProcessEvent, SessionSnapshot } from "../types.js";
import { buildLayout, HeaderInfo, LayoutHandle } from "./layout.js";
import { installLogBus, restoreLogBus } from "./log-bus.js";
import { formatSession, sortRows } from "./session-formatter.js";

/** 触发 sessions 列表重渲的事件类型。output 太频繁，不订阅。 */
const SESSIONS_REFRESH_EVENTS = new Set(["status", "started", "ended", "task"]);

const RELATIVE_TIME_TICK_MS = 5_000;

export interface TuiDeps {
  processManager: ProcessManager;
  structuredSessions: StructuredSessionManager;
  version: string;
  configPath: string;
  dbPath: string;
  bindAddr: string;
  httpsEnabled: boolean;
  urls: Array<{ url: string; scheme: "HTTP" | "HTTPS" }>;
  orphanRecoveredCount: number;
  /** 退出 TUI 时调用。返回的 Promise resolve 后 cli 才会 process.exit。 */
  onExit: (reason: ExitReason) => void | Promise<void>;
}

export type ExitReason = "user" | "signal" | "error";

export interface TuiHandle {
  isActive: boolean;
  stop(reason: ExitReason): Promise<void>;
}

export function startTui(deps: TuiDeps): TuiHandle {
  const layout: LayoutHandle = buildLayout();
  let active = true;
  let stopping = false;

  const handle: TuiHandle = {
    get isActive() { return active; },
    stop,
  };

  // 让 server 端的 wandError/wandWarn 能感知 TUI 在线。
  (globalThis as any).__wandTui = handle;

  installLogBus((record) => {
    if (!active) return;
    layout.appendLog(record);
  });

  const headerInfo = (): HeaderInfo => {
    const all = collectSessions();
    const counts = countSessions(all);
    const primary = deps.urls[0];
    return {
      version: deps.version,
      url: primary ? primary.url : `${deps.httpsEnabled ? "https" : "http"}://${deps.bindAddr}`,
      scheme: primary ? primary.scheme : (deps.httpsEnabled ? "HTTPS" : "HTTP"),
      bindAddr: deps.bindAddr,
      configPath: deps.configPath,
      dbPath: deps.dbPath,
      orphanRecoveredCount: deps.orphanRecoveredCount,
      sessionCounts: counts,
    };
  };

  function collectSessions(): SessionSnapshot[] {
    const ptyList = deps.processManager.listSlim();
    const structuredList = safeStructuredList(deps.structuredSessions);
    // 同 id 去重，PTY 优先（PM 是主路径）
    const seen = new Set<string>();
    const merged: SessionSnapshot[] = [];
    for (const s of ptyList) { seen.add(s.id); merged.push(s); }
    for (const s of structuredList) { if (!seen.has(s.id)) merged.push(s); }
    return sortRows(merged);
  }

  function countSessions(all: SessionSnapshot[]): { active: number; archived: number; total: number } {
    let act = 0, arch = 0;
    for (const s of all) {
      if (s.archived) arch += 1;
      else if (s.status === "running") act += 1;
    }
    return { active: act, archived: arch, total: all.length };
  }

  function refreshAll(): void {
    if (!active) return;
    const all = collectSessions();
    layout.refreshHeader(headerInfo());
    layout.refreshSessions(all.map((s) => formatSession(s)));
  }

  // —— 数据订阅 ——
  const onPmEvent = (ev: ProcessEvent) => {
    if (!active) return;
    if (SESSIONS_REFRESH_EVENTS.has(ev.type)) {
      scheduleSessionsRefresh();
    }
  };
  deps.processManager.on("process", onPmEvent);

  // structuredSessions 当前没有公开 EventEmitter 接口；本版本仅靠定时刷新覆盖其变化。
  // 若后续暴露 .on("process", ...) 可以在此追加监听。

  let pendingRefresh = false;
  function scheduleSessionsRefresh(): void {
    if (pendingRefresh) return;
    pendingRefresh = true;
    setImmediate(() => {
      pendingRefresh = false;
      if (active) refreshAll();
    });
  }

  const tickTimer = setInterval(() => {
    if (active) refreshAll();
  }, RELATIVE_TIME_TICK_MS);
  tickTimer.unref?.();

  // —— 键位 ——
  layout.screen.key(["q", "Q"], () => { void stop("user"); });
  layout.screen.key(["C-c"], () => { void stop("user"); });
  layout.screen.key(["r", "R"], () => { refreshAll(); });

  // 首次渲染
  refreshAll();

  async function stop(reason: ExitReason): Promise<void> {
    if (stopping || !active) return;
    stopping = true;
    active = false;
    clearInterval(tickTimer);
    try { deps.processManager.off("process", onPmEvent); } catch { /* noop */ }
    try { layout.destroy(); } catch { /* destroyed */ }
    restoreLogBus();
    if ((globalThis as any).__wandTui === handle) {
      delete (globalThis as any).__wandTui;
    }
    try {
      await deps.onExit(reason);
    } catch (err) {
      // 此时 stderr 已经还原，安全打印。
      process.stderr.write(`[wand] TUI 退出回调失败: ${String(err)}\n`);
    }
  }

  return handle;
}

function safeStructuredList(mgr: StructuredSessionManager): SessionSnapshot[] {
  try {
    return mgr.listSlim();
  } catch {
    return [];
  }
}
