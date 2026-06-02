/**
 * 单实例 pidfile + IPC 套接字路径。
 *
 * 用途：
 * 1. `wand web` 启动时先看 pidfile 是否活着，活着则进入 attach 模式（不再重复启动服务）。
 * 2. 主进程通过 wand.sock 暴露控制平面 IPC，attach 客户端通过它拉 snapshot / 发命令。
 *
 * 文件位置：均放在 configPath 的同目录（与 wand.db 一致）。
 *
 * 平台说明：
 * - Linux / macOS 使用 Unix domain socket。
 * - Windows 不支持，attach 模式直接跳过；新启的 `wand web` 仍会按老逻辑启动（端口冲突时报错）。
 */
export interface PidInfo {
    pid: number;
    version: string;
    /** 主进程启动时间 (ms epoch)。 */
    startedAt: number;
    url: string;
    scheme: "HTTP" | "HTTPS";
    bindAddr: string;
    configPath: string;
    dbPath: string;
    /** Unix socket 绝对路径；Windows 下为空字符串。 */
    socket: string;
}
export declare function pidfilePath(configPath: string): string;
export declare function socketPath(configPath: string): string;
/** 原子写：先写到 .tmp 再 rename。 */
export declare function writePidfile(configPath: string, info: PidInfo): void;
/** 读取并校验。文件不存在 / 损坏 / 进程不在 → 返回 null。 */
export declare function readPidfile(configPath: string): PidInfo | null;
/** 通过 `kill 0` 判断 PID 是否还活着（不发送信号，只检查存在性）。 */
export declare function isPidAlive(pid: number): boolean;
export declare function removePidfile(configPath: string): void;
export declare function removeSocketFile(configPath: string): void;
/** 读取 pidfile 并校验进程是否还活着。Stale 文件会自动清理。 */
export declare function readLiveInstance(configPath: string): PidInfo | null;
