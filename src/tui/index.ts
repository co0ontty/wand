import { ProcessManager } from "../process-manager.js";
import { StructuredSessionManager } from "../structured-session-manager.js";
import { ProcessEvent, SessionSnapshot } from "../types.js";
import {
  checkUpdate,
  copyToClipboard,
  installService,
  installUpdate,
  isServiceInstalled,
  openInBrowser,
  restartSelf,
  uninstallService,
} from "./commands.js";
import { buildLayout, HeaderInfo, LayoutHandle } from "./layout.js";
import { installLogBus, restoreLogBus } from "./log-bus.js";
import { formatSession, sortRows } from "./session-formatter.js";
import { openServicePanel } from "./service-panel.js";

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
  const startedAtMs = Date.now();

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
      startedAtMs,
      rssBytes: safeRss(),
      serviceInstalled: safeServiceInstalled(),
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

  // 服务面板打开时，屏幕级快捷键全部让位给面板自身按键。
  const idle = () => !layout.isServicePanelOpen();

  // —— 基本键位 ——
  layout.screen.key(["q", "Q"], () => { if (idle()) void stop("user"); });
  layout.screen.key(["C-c"], () => { void stop("user"); });
  layout.screen.key(["r"], () => {
    if (!idle()) return;
    refreshAll();
    layout.showToast("已刷新", "info", 1500);
  });
  layout.screen.key(["l", "L"], () => {
    if (!idle()) return;
    layout.clearLogs();
    layout.showToast("日志已清空", "info", 1500);
  });
  layout.screen.key(["?", "h", "H"], () => {
    if (!idle()) return;
    const visible = layout.toggleHelp();
    if (!visible) refreshAll();
  });

  // —— 运维快捷键 ——
  layout.screen.key(["g", "G"], () => { if (idle()) openServicePanel({ layout, configPath: deps.configPath }); });
  layout.screen.key(["S-r"], () => { if (idle()) void handleRestart(); });
  layout.screen.key(["u", "U"], () => { if (idle()) void handleUpdate(); });
  layout.screen.key(["o", "O"], () => { if (idle()) handleOpenBrowser(); });
  layout.screen.key(["c", "C"], () => { if (idle()) handleCopyUrl(); });
  layout.screen.key(["s"], () => { if (idle()) void handleInstallService(); });
  layout.screen.key(["S-s"], () => { if (idle()) void handleUninstallService(); });

  // 首次渲染
  refreshAll();

  // —— 操作处理函数 ——
  async function handleRestart(): Promise<void> {
    const ok = await layout.confirm({
      title: "重启 wand",
      body: "将派生新进程并退出当前进程，活跃会话会因 PTY 中断而中止，是否继续？",
    });
    if (!ok) return;
    layout.showToast("正在重启…", "info", 5000);
    // 让 toast 有时间渲染，再触发 restart
    setTimeout(() => {
      const r = restartSelf();
      if (!r.ok) layout.showToast(r.message, "error", 4000);
    }, 200);
  }

  async function handleUpdate(): Promise<void> {
    layout.showToast("正在检查更新…", "info", 2000);
    const info = await runOffMicrotask(() => checkUpdate(deps.version));
    if (!info.latest) {
      layout.showToast("无法连接到 npm registry", "error", 3500);
      return;
    }
    if (!info.hasUpdate) {
      layout.showToast(`已是最新版本 (v${info.current})`, "success", 3000);
      return;
    }
    const go = await layout.confirm({
      title: "发现新版本",
      body: `当前 v${info.current} → 最新 v${info.latest}，是否立即升级？`,
      yes: "回车 / y 安装",
      no: "Esc / n 取消",
    });
    if (!go) return;
    layout.showToast("正在执行 npm install -g …", "info", 5000);
    const r = await runOffMicrotask(() => installUpdate());
    layout.showToast(r.message, r.ok ? "success" : "error", 5000);
    if (r.detail) layout.showDetail(r.ok ? "更新输出" : "更新失败", r.detail);
  }

  function handleOpenBrowser(): void {
    const url = deps.urls[0]?.url;
    if (!url) {
      layout.showToast("没有可用 URL", "warn", 2000);
      return;
    }
    const r = openInBrowser(url);
    layout.showToast(r.message, r.ok ? "success" : "error", 2500);
  }

  function handleCopyUrl(): void {
    const url = deps.urls[0]?.url;
    if (!url) {
      layout.showToast("没有可用 URL", "warn", 2000);
      return;
    }
    const r = copyToClipboard(url);
    layout.showToast(r.message, r.ok ? "success" : "error", 2500);
  }

  async function handleInstallService(): Promise<void> {
    if (isServiceInstalled()) {
      layout.showToast("服务已安装，按 Shift+S 卸载", "warn", 2500);
      return;
    }
    const ok = await layout.confirm({
      title: "注册为系统服务",
      body:
        process.platform === "linux"
          ? "将写入 ~/.config/systemd/user/wand.service 并 systemctl --user enable --now。"
          : process.platform === "darwin"
            ? "将写入 ~/Library/LaunchAgents/com.wand.web.plist 并 launchctl load。"
            : "当前平台暂不支持。",
    });
    if (!ok) return;
    const r = await runOffMicrotask(() => installService({ configPath: deps.configPath }));
    layout.showToast(r.message, r.ok ? "success" : "error", 5000);
    if (r.detail) layout.showDetail(r.ok ? "服务安装详情" : "服务安装失败", r.detail);
    refreshAll();
  }

  async function handleUninstallService(): Promise<void> {
    if (!isServiceInstalled()) {
      layout.showToast("当前未安装系统服务", "warn", 2500);
      return;
    }
    const ok = await layout.confirm({
      title: "卸载系统服务",
      body: "将禁用并删除 wand 的 systemd / launchd 配置，确认继续？",
    });
    if (!ok) return;
    const r = await runOffMicrotask(() => uninstallService());
    layout.showToast(r.message, r.ok ? "success" : "error", 4000);
    if (r.detail) layout.showDetail(r.ok ? "服务卸载详情" : "服务卸载失败", r.detail);
    refreshAll();
  }

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

function safeRss(): number {
  try {
    return process.memoryUsage().rss;
  } catch {
    return 0;
  }
}

function safeServiceInstalled(): boolean {
  try {
    return isServiceInstalled();
  } catch {
    return false;
  }
}

/** 把同步阻塞操作放到下一 microtask，给 TUI 留出一帧把 toast 画出来。 */
function runOffMicrotask<T>(fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(fn()); } catch (err) { reject(err); }
    });
  });
}
