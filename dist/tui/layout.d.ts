import { LogRecord } from "./log-bus.js";
import { SessionRow } from "./session-formatter.js";
export interface HeaderInfo {
    version: string;
    url: string;
    scheme: "HTTP" | "HTTPS";
    bindAddr: string;
    configPath: string;
    dbPath: string;
    orphanRecoveredCount: number;
    sessionCounts: {
        active: number;
        archived: number;
        total: number;
    };
    /** 服务启动时间（ms epoch），用于计算 uptime。 */
    startedAtMs: number;
    /** 当前进程 RSS 内存（字节），由调用方传入。 */
    rssBytes: number;
    /** 是否已注册系统服务（systemd / launchd），用于在 header 显示标签。 */
    serviceInstalled: boolean;
}
export type ToastLevel = "info" | "warn" | "error" | "success";
export interface ConfirmOptions {
    title: string;
    body: string;
    yes?: string;
    no?: string;
}
export interface ServicePanelView {
    /** 第一行状态描述，例如 "active (running) since ..." */
    statusLine: string;
    /** active / inactive / failed / unsupported / unknown / loaded。决定状态行颜色。 */
    state: "active" | "inactive" | "failed" | "loaded" | "unknown" | "unsupported";
    installed: boolean;
    platform: NodeJS.Platform;
    /** 用于"上次操作"提示行，可为空。 */
    lastAction?: string;
}
export interface ServicePanelHandlers {
    onStart: () => void | Promise<void>;
    onStop: () => void | Promise<void>;
    onRestart: () => void | Promise<void>;
    onInstall: () => void | Promise<void>;
    onUninstall: () => void | Promise<void>;
    onLogs: () => void | Promise<void>;
    onRefresh: () => void | Promise<void>;
    onClose: () => void;
}
export interface LayoutHandle {
    screen: any;
    refreshHeader(info: HeaderInfo): void;
    refreshSessions(rows: SessionRow[]): void;
    appendLog(record: LogRecord): void;
    setSelectionListener(listener: (index: number) => void): void;
    showHelp(visible: boolean): void;
    toggleHelp(): boolean;
    showToast(message: string, level?: ToastLevel, ttlMs?: number): void;
    confirm(opts: ConfirmOptions): Promise<boolean>;
    showDetail(title: string, body: string): void;
    hideDetail(): void;
    clearLogs(): void;
    openServicePanel(handlers: ServicePanelHandlers, initial: ServicePanelView): void;
    updateServicePanel(view: ServicePanelView): void;
    closeServicePanel(): void;
    isServicePanelOpen(): boolean;
    destroy(): void;
}
export declare function buildLayout(): LayoutHandle;
