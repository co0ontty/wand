/**
 * 两种 TUI 模式（前台主进程 / attach）共用的"服务与升级"操作。
 *
 * 流程完全一致，只有两处随模式而异：
 *   - 升级确认弹窗文案（attach 模式要提醒按 R 重启服务）
 *   - 注册系统服务的说明正文（attach 模式没有本地会话列表，装卸后不刷新界面）
 */

import {
  checkUpdate,
  installService,
  installUpdate,
  isServiceInstalled,
  readUpdateChannel,
  uninstallService,
} from "./commands.js";
import { repairServiceUnitAfterUpdate } from "../service-self-repair.js";
import type { LayoutHandle } from "./layout.js";
import { runOffMicrotask } from "./runtime-utils.js";

export interface UpdateConfirmContext {
  current: string;
  latest: string;
  channelLabel: string;
}

export interface ServiceActionsOptions {
  configPath: string;
  /** 当前版本；attach 模式传主进程版本。 */
  version: string;
  layout: LayoutHandle;
  /** 升级确认弹窗正文。 */
  updateConfirmBody(context: UpdateConfirmContext): string;
  /** 注册系统服务的说明正文，随平台 / 权限而变。 */
  installServiceBody(isRoot: boolean): string;
  /** 服务安装 / 卸载后刷新界面；attach 模式没有本地会话列表，可不传。 */
  onServiceChanged?(): void;
}

export interface ServiceActions {
  handleUpdate(): Promise<void>;
  handleInstallService(): Promise<void>;
  handleUninstallService(): Promise<void>;
}

export function createServiceActions(options: ServiceActionsOptions): ServiceActions {
  const { layout } = options;

  async function handleUpdate(): Promise<void> {
    layout.showToast("正在检查更新…", "info", 2000);
    const channel = await runOffMicrotask(() => readUpdateChannel(options.configPath));
    const info = await runOffMicrotask(() => checkUpdate(options.version, channel));
    if (!info.latest) {
      layout.showToast(
        info.channel === "beta" ? "无法读取 npm beta 版本" : "无法连接到 npm registry",
        "error",
        3500,
      );
      return;
    }
    if (!info.hasUpdate) {
      layout.showToast(
        info.channel === "beta" ? `已是最新 Beta 版本 (${info.current})` : `已是最新版本 (v${info.current})`,
        "success",
        3000,
      );
      return;
    }
    const go = await layout.confirm({
      title: "发现新版本",
      body: options.updateConfirmBody({
        current: info.current,
        latest: info.latest,
        channelLabel: info.channel === "beta" ? "Beta" : "正式版",
      }),
      yes: "回车 / y 安装",
      no: "Esc / n 取消",
    });
    if (!go) return;
    layout.showToast("正在执行 npm install -g …", "info", 5000);
    const r = await runOffMicrotask(() => installUpdate(info.channel));
    layout.showToast(r.message, r.ok ? "success" : "error", 5000);
    if (r.detail) layout.showDetail(r.ok ? "更新输出" : "更新失败", r.detail);
    if (r.ok) {
      // 镜像 install.sh：装完用全局安装刷新服务 unit（ExecStart/PATH），再按 R 重启生效。
      const repair = await runOffMicrotask(() => repairServiceUnitAfterUpdate(options.configPath));
      if (repair.scope) layout.showToast(repair.message, repair.repaired ? "success" : "warn", 4500);
    }
  }

  async function handleInstallService(): Promise<void> {
    if (isServiceInstalled()) {
      layout.showToast("服务已安装，按 Shift+S 卸载", "warn", 2500);
      return;
    }
    // 默认装 system-wide。非 root 时 installService 会返回明确错误,toast 自然展示。
    const isRoot = typeof process.getuid === "function" ? process.getuid() === 0 : false;
    const ok = await layout.confirm({
      title: "注册为系统服务",
      body: options.installServiceBody(isRoot),
    });
    if (!ok) return;
    const r = await runOffMicrotask(() => installService({ configPath: options.configPath }));
    layout.showToast(r.message, r.ok ? "success" : "error", 5000);
    if (r.detail) layout.showDetail(r.ok ? "服务安装详情" : "服务安装失败", r.detail);
    options.onServiceChanged?.();
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
    options.onServiceChanged?.();
  }

  return { handleUpdate, handleInstallService, handleUninstallService };
}
