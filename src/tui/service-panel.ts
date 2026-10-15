/**
 * 服务控制面板的业务回调。本地 TUI 和 attach TUI 复用同一份逻辑。
 *
 * 面板按键与处理函数：
 *   s — 启动服务
 *   t — 停止服务 (有确认)
 *   r — 重启服务 (有确认)
 *   R — 仅刷新状态行
 *   i — 安装到系统
 *   u — 卸载
 *   l — 查看最近日志
 *   Esc / q — 关闭面板
 */

import {
  isServiceInstalled,
  serviceLogs,
  serviceStatusAsync,
} from "./commands.js";
import { LayoutHandle, ServicePanelView } from "./layout.js";
import { runTuiServiceCommand } from "./service-command.js";

export interface ServicePanelDeps {
  layout: LayoutHandle;
  configPath: string;
}

const panelOpenings = new WeakMap<LayoutHandle, object>();

export function openServicePanel(deps: ServicePanelDeps): void {
  const { layout, configPath } = deps;
  const opening = {};
  panelOpenings.set(layout, opening);
  let lastAction: string | undefined;

  // Status probes are async; a sequence guard keeps a slow older probe from overwriting a newer view.
  let viewSeq = 0;
  async function computeView(): Promise<ServicePanelView> {
    const s = await serviceStatusAsync();
    return {
      statusLine: s.description,
      state: s.state,
      installed: s.installed,
      platform: s.platform,
      lastAction,
    };
  }

  async function refreshView(): Promise<void> {
    const seq = ++viewSeq;
    const view = await computeView();
    if (seq === viewSeq && panelOpenings.get(layout) === opening) layout.updateServicePanel(view);
  }

  function setLastAction(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    lastAction = `${ts} ${msg}`;
    void refreshView();
  }

  function handleResult(label: string, result: { ok: boolean; message: string; detail?: string }): void {
    layout.showToast(result.message, result.ok ? "success" : "error", 3500);
    if (result.detail) {
      layout.showDetail(`${label} ${result.ok ? "输出" : "失败"}`, result.detail);
    }
    setLastAction(`${label}: ${result.message}`);
  }

  layout.openServicePanel(
    {
      onStart: async () => {
        handleResult("start", await runTuiServiceCommand(layout, "service:start", configPath));
      },
      onStop: async () => {
        const ok = await layout.confirm({
          title: "停止服务",
          body: "将停止 wand.service / launchd 代理；如果你正 attach 到它，连接会断开。",
        });
        if (!ok) return;
        handleResult("stop", await runTuiServiceCommand(layout, "service:stop", configPath));
      },
      onRestart: async () => {
        const ok = await layout.confirm({
          title: "重启服务",
          body: "将 restart wand.service / 重新 load 代理；attach 连接会短暂断开后自动重连。",
        });
        if (!ok) return;
        handleResult("restart", await runTuiServiceCommand(layout, "service:restart", configPath));
      },
      onInstall: async () => {
        if (isServiceInstalled()) {
          layout.showToast("服务已安装，按 u 先卸载再重装", "warn", 2500);
          return;
        }
        const isRoot = typeof process.getuid === "function" ? process.getuid() === 0 : false;
        const body = `默认装 system-wide(/etc/systemd/system/ 或 /Library/LaunchDaemons/),开机自启、登出不停。${
          isRoot ? "" : "\n需要管理员权限，将自动申请 sudo，请在终端输入密码。"
        }`;
        const ok = await layout.confirm({ title: "注册服务", body });
        if (!ok) return;
        handleResult("install", await runTuiServiceCommand(layout, "service:install", configPath));
      },
      onUninstall: async () => {
        if (!isServiceInstalled()) {
          layout.showToast("当前未安装", "warn", 2500);
          return;
        }
        const ok = await layout.confirm({
          title: "卸载服务",
          body: "将禁用并删除服务配置文件。",
        });
        if (!ok) return;
        handleResult("uninstall", await runTuiServiceCommand(layout, "service:uninstall", configPath));
      },
      onLogs: () => {
        const r = serviceLogs(80);
        if (r.ok) {
          layout.showDetail("Service Logs (最近 80 行)", r.detail || "(空)");
          setLastAction("logs: 已展开");
        } else {
          layout.showToast(r.message, "error", 3000);
          if (r.detail) layout.showDetail("Service Logs 失败", r.detail);
        }
      },
      onRefresh: () => {
        void refreshView();
        layout.showToast("已刷新状态", "info", 1000);
      },
      onClose: () => {
        if (panelOpenings.get(layout) !== opening) return;
        panelOpenings.delete(layout);
        ++viewSeq;
        layout.closeServicePanel();
      },
    },
    {
      statusLine: "检测中…",
      state: "unknown",
      installed: false,
      platform: process.platform,
    },
  );
  void refreshView();
}
