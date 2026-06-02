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
import { LayoutHandle } from "./layout.js";
export interface ServicePanelDeps {
    layout: LayoutHandle;
    configPath: string;
}
export declare function openServicePanel(deps: ServicePanelDeps): void;
