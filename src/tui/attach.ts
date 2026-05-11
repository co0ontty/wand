/**
 * Attach 模式 TUI：当本机已有 wand 主进程在跑时，新启动的 `wand web` 会进入此模式。
 *
 * 数据来源：通过 wand.sock IPC 拉 snapshot（每秒一次），渲染同一套 layout。
 * 日志面板：因为日志在主进程里，attach 端没法直接看；这里改成"活动流"——
 *   监听 snapshot 差分，把会话起止 / 总数变化打到 log 面板。
 */

import {
  checkUpdate,
  copyToClipboard,
  installService,
  installUpdate,
  isServiceInstalled,
  openInBrowser,
  uninstallService,
} from "./commands.js";
import { spawnSync } from "node:child_process";
import { IpcClient } from "./ipc-client.js";
import { IpcSnapshotData } from "./ipc-protocol.js";
import { PidInfo } from "../pidfile.js";
import { buildLayout, HeaderInfo, LayoutHandle } from "./layout.js";
import { SessionRow } from "./session-formatter.js";
import { openServicePanel } from "./service-panel.js";

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
          `会话计数: ${h.sessionCounts.active} active · ${h.sessionCounts.archived} archived · ${h.sessionCounts.total} total`,
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
  layout.screen.key(["u", "U"], () => { if (idle()) void handleUpdate(); });
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
  layout.screen.key(["s"], () => { if (idle()) void handleInstallService(); });
  layout.screen.key(["S-s"], () => { if (idle()) void handleUninstallService(); });

  async function handleRestart(): Promise<void> {
    const installed = safeServiceInstalled();
    if (installed && process.platform === "linux") {
      const ok = await layout.confirm({
        title: "重启 wand 服务",
        body: "将执行 systemctl --user restart wand.service。当前 attach 会话会随主进程重启被踢掉。",
      });
      if (!ok) return;
      layout.showToast("systemctl --user restart wand.service …", "info", 3000);
      const r = spawnSync("systemctl", ["--user", "restart", "wand.service"], { encoding: "utf8" });
      if (r.status === 0) {
        layout.showToast("已请求重启，IPC 会自动重连", "success", 3000);
      } else {
        layout.showToast(`systemctl 失败 (exit ${r.status})`, "error", 4000);
        layout.showDetail("systemctl 输出", (r.stdout || "") + "\n" + (r.stderr || ""));
      }
      return;
    }
    if (installed && process.platform === "darwin") {
      const ok = await layout.confirm({
        title: "重启 wand 服务",
        body: "将依次 launchctl unload / load com.wand.web。",
      });
      if (!ok) return;
      const plist = `${process.env.HOME}/Library/LaunchAgents/com.wand.web.plist`;
      const u = spawnSync("launchctl", ["unload", plist], { encoding: "utf8" });
      const l = spawnSync("launchctl", ["load", plist], { encoding: "utf8" });
      const ok2 = u.status === 0 && l.status === 0;
      layout.showToast(ok2 ? "已请求 launchd 重启" : "launchctl 调用失败", ok2 ? "success" : "error", 3500);
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

  async function handleUpdate(): Promise<void> {
    layout.showToast("正在检查更新…", "info", 2000);
    const info = await runOffMicrotask(() => checkUpdate(deps.pidInfo.version));
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
      body: `当前 v${info.current} → 最新 v${info.latest}，立即升级？升级后请按 R 重启服务。`,
      yes: "回车 / y 安装",
      no: "Esc / n 取消",
    });
    if (!go) return;
    layout.showToast("正在执行 npm install -g …", "info", 5000);
    const r = await runOffMicrotask(() => installUpdate());
    layout.showToast(r.message, r.ok ? "success" : "error", 5000);
    if (r.detail) layout.showDetail(r.ok ? "更新输出" : "更新失败", r.detail);
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
          ? "将写入 ~/.config/systemd/user/wand.service。"
          : process.platform === "darwin"
            ? "将写入 ~/Library/LaunchAgents/com.wand.web.plist。"
            : "当前平台暂不支持。",
    });
    if (!ok) return;
    const r = await runOffMicrotask(() => installService({ configPath: deps.configPath }));
    layout.showToast(r.message, r.ok ? "success" : "error", 5000);
    if (r.detail) layout.showDetail(r.ok ? "服务安装详情" : "服务安装失败", r.detail);
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

function safeServiceInstalled(): boolean {
  try { return isServiceInstalled(); } catch { return false; }
}

function runOffMicrotask<T>(fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(fn()); } catch (err) { reject(err); }
    });
  });
}
