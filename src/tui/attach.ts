/**
 * Attach 模式 TUI：当本机已有 wand 主进程在跑时，新启动的 `wand web` 会进入此模式。
 *
 * 数据来源：通过 wand.sock IPC 拉 snapshot（每秒一次），渲染同一套 layout。
 * 日志面板：因为日志在主进程里，attach 端没法直接看；这里改成"活动流"——
 *   监听 snapshot 差分，把会话起止 / 总数变化打到 log 面板。
 */

import {
  copyToClipboard,
  openInBrowser,
  serviceRestart,
} from "./commands.js";
import { IpcClient } from "./ipc-client.js";
import { IpcSnapshotData } from "./ipc-protocol.js";
import { PidInfo } from "../pidfile.js";
import { buildLayout, HeaderInfo, LayoutHandle } from "./layout.js";
import { SessionRow } from "./session-formatter.js";
import { openServicePanel } from "./service-panel.js";
import { runOffMicrotask, safeServiceInstalled } from "./runtime-utils.js";
import { createServiceActions } from "./service-actions.js";

export interface AttachTuiDeps {
  pidInfo: PidInfo;
  configPath: string;
  /** 退出时调用。 */
  onExit: () => void | Promise<void>;
}

export interface AttachTuiHandle {
  stop(): Promise<void>;
}

const POLL_INTERVAL_MS = 1000;

export function startAttachTui(deps: AttachTuiDeps): AttachTuiHandle {
  const layout: LayoutHandle = buildLayout();
  let active = true;
  let stopping = false;

  const client = new IpcClient(deps.pidInfo.socket);
  client.start();

  // 渲染一个"等连接"的初始 header
  const placeholderHeader: HeaderInfo = {
    version: deps.pidInfo.version,
    url: deps.pidInfo.url,
    scheme: deps.pidInfo.scheme,
    bindAddr: deps.pidInfo.bindAddr,
    configPath: deps.pidInfo.configPath,
    dbPath: deps.pidInfo.dbPath,
    orphanRecoveredCount: 0,
    sessionCounts: { active: 0, archived: 0, total: 0 },
    startedAtMs: deps.pidInfo.startedAt,
    rssBytes: 0,
    serviceInstalled: safeServiceInstalled(),
  };
  layout.refreshHeader(placeholderHeader);
  layout.refreshSessions([]);

  appendActivity(`已 attach 到主进程 PID ${deps.pidInfo.pid}`);
  appendActivity(`URL: ${deps.pidInfo.url}`);
  appendActivity("正在连接 IPC 套接字…", "info");

  client.on("connect", () => {
    appendActivity("IPC 已连接，开始轮询 snapshot", "info");
    void pollOnce();
  });
  client.on("disconnect", () => {
    appendActivity("IPC 已断开，等待重连…", "warn");
  });
  client.on("error", (err: Error) => {
    appendActivity(`IPC 错误: ${err.message}`, "error");
  });

  let lastSessionsKey = "";
  let lastTotal = -1;

  async function pollOnce(): Promise<void> {
    if (!active) return;
    try {
      const snap = await client.snapshot();
      applySnapshot(snap);
    } catch (err) {
      // 静默失败：断开后会自动重连，下个 tick 会再试
      if ((err as Error).message !== "ipc not connected" && (err as Error).message !== "ipc disconnected") {
        appendActivity(`snapshot 失败: ${(err as Error).message}`, "warn");
      }
    }
  }

  function applySnapshot(snap: IpcSnapshotData): void {
    const h = snap.header;
    const header: HeaderInfo = {
      version: h.version,
      url: h.url,
      scheme: h.scheme,
      bindAddr: h.bindAddr,
      configPath: h.configPath,
      dbPath: h.dbPath,
      orphanRecoveredCount: h.orphanRecoveredCount,
      sessionCounts: h.sessionCounts,
      startedAtMs: h.startedAtMs,
      rssBytes: h.rssBytes,
      serviceInstalled: safeServiceInstalled(),
    };
    layout.refreshHeader(header);
    layout.refreshSessions(snap.sessions);

    // 活动流：会话集合变化时输出一行
    const key = snap.sessions.map((s) => `${s.id}:${s.state}`).join("|");
    if (key !== lastSessionsKey) {
      diffActivity(snap.sessions);
      lastSessionsKey = key;
    }
    if (h.sessionCounts.total !== lastTotal) {
      if (lastTotal !== -1) {
        appendActivity(
          `会话计数: ${h.sessionCounts.total}`,
          "info",
        );
      }
      lastTotal = h.sessionCounts.total;
    }
  }

  let lastRowState = new Map<string, string>();
  function diffActivity(rows: SessionRow[]): void {
    const next = new Map<string, string>();
    for (const r of rows) next.set(r.id, r.state);
    // 新增
    for (const [id, state] of next) {
      if (!lastRowState.has(id)) {
        appendActivity(`+ ${id.slice(0, 8)} ${state}`, "info");
      } else if (lastRowState.get(id) !== state) {
        appendActivity(`~ ${id.slice(0, 8)} ${lastRowState.get(id)} → ${state}`, "info");
      }
    }
    // 离开
    for (const [id, state] of lastRowState) {
      if (!next.has(id)) appendActivity(`- ${id.slice(0, 8)} ${state}`, "info");
    }
    lastRowState = next;
  }

  function appendActivity(line: string, level: "info" | "warn" | "error" = "info"): void {
    layout.appendLog({ level, line: `[attach] ${line}`, ts: Date.now() });
  }

  const pollTimer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  pollTimer.unref?.();

  const serviceActions = createServiceActions({
    configPath: deps.configPath,
    version: deps.pidInfo.version,
    layout,
    updateConfirmBody: ({ current, latest, channelLabel }) =>
      `通道 ${channelLabel}：当前 ${current} → 最新 ${latest}，立即升级？升级后请按 R 重启服务。`,
    installServiceBody: (isRoot) => process.platform === "linux"
      ? `将写入 /etc/systemd/system/wand.service，systemctl enable --now，开机自启。\n${
          isRoot ? "当前是 root，可以直接装。" : "⚠ 需要 root,可以 Ctrl+C 退出 TUI 后跑 sudo wand service:install。"
        }`
      : process.platform === "darwin"
        ? `将写入 /Library/LaunchDaemons/com.wand.web.plist，launchctl load，开机自启。\n${
            isRoot ? "当前是 root,可以直接装。" : "⚠ 需要 root,退出 TUI 跑 sudo wand service:install。"
          }`
        : "当前平台暂不支持。",
  });

  // —— 键位 —— 服务面板打开时，屏幕级快捷键让位
  const idle = () => !layout.isServicePanelOpen();

  layout.screen.key(["q", "Q"], () => { if (idle()) void stop(); });
  layout.screen.key(["C-c"], () => { void stop(); });
  layout.screen.key(["r"], () => {
    if (!idle()) return;
    void pollOnce();
    layout.showToast("已请求刷新", "info", 1200);
  });
  layout.screen.key(["l", "L"], () => { if (idle()) layout.clearLogs(); });
  layout.screen.key(["?", "h", "H"], () => { if (idle()) layout.toggleHelp(); });

  // 运维快捷键 — 与本地模式行为一致，但 R 走"重启系统服务"路径
  layout.screen.key(["g", "G"], () => { if (idle()) openServicePanel({ layout, configPath: deps.configPath }); });
  layout.screen.key(["S-r"], () => { if (idle()) void handleRestart(); });
  layout.screen.key(["u", "U"], () => { if (idle()) void serviceActions.handleUpdate(); });
  layout.screen.key(["o", "O"], () => {
    if (!idle()) return;
    const r = openInBrowser(deps.pidInfo.url);
    layout.showToast(r.message, r.ok ? "success" : "error", 2500);
  });
  layout.screen.key(["c", "C"], () => {
    if (!idle()) return;
    const r = copyToClipboard(deps.pidInfo.url);
    layout.showToast(r.message, r.ok ? "success" : "error", 2500);
  });
  layout.screen.key(["s"], () => { if (idle()) void serviceActions.handleInstallService(); });
  layout.screen.key(["S-s"], () => { if (idle()) void serviceActions.handleUninstallService(); });

  async function handleRestart(): Promise<void> {
    const installed = safeServiceInstalled();
    if (installed) {
      const ok = await layout.confirm({
        title: "重启 wand 服务",
        body: "将重启已安装的 wand systemd / launchd 服务。当前 attach 会话会随主进程重启短暂断开。",
      });
      if (!ok) return;
      layout.showToast("正在请求服务重启…", "info", 3000);
      const r = await runOffMicrotask(() => serviceRestart());
      layout.showToast(r.ok ? "已请求重启，IPC 会自动重连" : r.message, r.ok ? "success" : "error", 4000);
      if (r.detail) layout.showDetail(r.ok ? "服务重启输出" : "服务重启失败", r.detail);
      return;
    }
    // 没注册成服务：尝试通过 IPC 让主进程自我退出，再由用户手动重启
    const ok = await layout.confirm({
      title: "主进程未注册为系统服务",
      body: "无法自动重启。要请求主进程关闭吗？关闭后请手动 `wand web` 重启。",
    });
    if (!ok) return;
    const accepted = await client.shutdownDaemon();
    layout.showToast(accepted ? "已请求主进程退出" : "请求未被接受", accepted ? "success" : "warn", 3500);
  }

  async function stop(): Promise<void> {
    if (stopping || !active) return;
    stopping = true;
    active = false;
    clearInterval(pollTimer);
    try { client.close(); } catch { /* noop */ }
    try { layout.destroy(); } catch { /* destroyed */ }
    try {
      await deps.onExit();
    } catch (err) {
      process.stderr.write(`[wand] attach TUI 退出回调失败: ${String(err)}\n`);
    }
  }

  return { stop };
}

