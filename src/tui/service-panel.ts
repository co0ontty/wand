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
  installService,
  isServiceInstalled,
  serviceLogs,
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
  uninstallService,
} from "./commands.js";
import { LayoutHandle, ServicePanelView } from "./layout.js";

export interface ServicePanelDeps {
  layout: LayoutHandle;
  configPath: string;
}

export function openServicePanel(deps: ServicePanelDeps): void {
  const { layout, configPath } = deps;
  let lastAction: string | undefined;

  function computeView(): ServicePanelView {
    const s = serviceStatus();
    return {
      statusLine: s.description,
      state: s.state,
      installed: s.installed,
      platform: s.platform,
      lastAction,
    };
  }

  function setLastAction(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    lastAction = `${ts} ${msg}`;
    layout.updateServicePanel(computeView());
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
      onStart: () => {
        handleResult("start", serviceStart());
      },
      onStop: async () => {
        const ok = await layout.confirm({
          title: "停止服务",
          body: "将停止 wand.service / launchd 代理；如果你正 attach 到它，连接会断开。",
        });
        if (!ok) return;
        handleResult("stop", serviceStop());
      },
      onRestart: async () => {
        const ok = await layout.confirm({
          title: "重启服务",
          body: "将 restart wand.service / 重新 load 代理；attach 连接会短暂断开后自动重连。",
        });
        if (!ok) return;
        handleResult("restart", serviceRestart());
      },
      onInstall: async () => {
        if (isServiceInstalled()) {
          layout.showToast("服务已安装，按 u 先卸载再重装", "warn", 2500);
          return;
        }
        const ok = await layout.confirm({
          title: "注册服务",
          body: "将写入 unit / plist 并启用（无需 sudo，使用用户级服务）。",
        });
        if (!ok) return;
        handleResult("install", installService({ configPath }));
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
        handleResult("uninstall", uninstallService());
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
        layout.updateServicePanel(computeView());
        layout.showToast("已刷新状态", "info", 1000);
      },
      onClose: () => {
        layout.closeServicePanel();
      },
    },
    computeView(),
  );
}
