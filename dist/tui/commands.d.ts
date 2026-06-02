/**
 * TUI 运维操作命令集合。
 *
 * 所有命令统一返回 CommandResult，UI 层负责把结果渲染到 toast / 弹窗 / 日志。
 * 命令本身不直接写 stdout / stderr —— TUI 模式下 stderr 已经被 log-bus 劫持。
 */
export interface CommandResult {
    ok: boolean;
    /** 给用户看的简短状态行（一行）。 */
    message: string;
    /** 可选的详细输出（多行），供"详情"折叠展示。 */
    detail?: string;
}
/**
 * 重启当前进程。
 * 通过 spawn 一个 detached 子进程复用同一份 argv，然后退出父进程，
 * 让 systemd / 用户终端把控制权交给新进程。
 */
export declare function restartSelf(): CommandResult;
export interface UpdateInfo {
    current: string;
    latest: string | null;
    hasUpdate: boolean;
}
/** 通过 npm view 拿到最新版本号。失败返回 latest=null。 */
export declare function checkUpdate(currentVersion: string): UpdateInfo;
/**
 * 执行 `npm install -g @co0ontty/wand@latest`。
 *
 * 此调用同步阻塞（TUI 上层应在另一线程的 setImmediate 调度，或直接 await）。
 * 通过 npm-update-utils 自动处理 `.wand-XXXXXX` 残留目录和 ENOTEMPTY 回退，
 * 行为与 server.ts 的 /api/update / performAutoUpdate 保持一致。
 *
 * 返回 npm 输出供调试。
 */
export declare function installUpdate(): CommandResult;
export declare function openInBrowser(url: string): CommandResult;
export declare function copyToClipboard(text: string): CommandResult;
/**
 * 服务安装的作用域：
 *   - "system" = Linux 写 /etc/systemd/system/wand.service；macOS 写 /Library/LaunchDaemons/
 *                需要 root，开机自启，所有用户可用，不依赖 login session。
 *   - "user"   = Linux 写 ~/.config/systemd/user/wand.service；macOS 写 ~/Library/LaunchAgents/
 *                不要 root，登出会被回收（除非 loginctl enable-linger）。
 *
 * 默认 system。
 */
export type ServiceScope = "system" | "user";
export declare const DEFAULT_SERVICE_SCOPE: ServiceScope;
export interface ServiceContext {
    configPath: string;
    /** wand 可执行文件路径。优先使用 process.argv[1]，回退到 which wand。 */
    wandBin?: string;
    /** 显式指定作用域。不传走 DEFAULT_SERVICE_SCOPE。 */
    scope?: ServiceScope;
    /**
     * 更新后自修复场景：优先把 ExecStart 钉到「全局安装的 wand」(npm root -g 下的
     * dist/cli.js)，而不是 process.argv[1]。源码安装的用户更新到 npm/GitHub 版后，
     * argv[1] 仍是旧源码路径，沿用它会让重启跑回旧二进制。
     */
    preferGlobalBin?: boolean;
}
export interface ServiceOpts {
    /** 不传 = 自动检测已装的那个；都没装就用 default。 */
    scope?: ServiceScope;
}
/** 自动检测哪个 scope 已经装了 unit；优先 system，找不到就 user。两个都没装返回 null。 */
export declare function detectInstalledScope(): ServiceScope | null;
export declare function isServiceInstalled(scope?: ServiceScope): boolean;
export interface ServiceStatus {
    /** 是否已安装服务文件。 */
    installed: boolean;
    /** active(running) / inactive / failed / unknown 等；解析自 systemctl/launchctl。 */
    state: "active" | "inactive" | "failed" | "loaded" | "unknown" | "unsupported";
    /** 给用户看的描述行（例如 "active (running) since Mon 2025-05-11 08:23:45 CST; 12min ago"）。 */
    description: string;
    /** 原始命令输出，供 Detail 面板展示。 */
    raw: string;
    /** 平台。 */
    platform: NodeJS.Platform;
}
export declare function serviceStatus(opts?: ServiceOpts): ServiceStatus;
export declare function serviceStart(opts?: ServiceOpts): CommandResult;
export declare function serviceStop(opts?: ServiceOpts): CommandResult;
export declare function serviceRestart(opts?: ServiceOpts): CommandResult;
/** 取最近 N 行服务日志。 */
export declare function serviceLogs(lines?: number, opts?: ServiceOpts): CommandResult;
export declare function installService(ctx: ServiceContext): CommandResult;
export declare function uninstallService(opts?: ServiceOpts): CommandResult;
