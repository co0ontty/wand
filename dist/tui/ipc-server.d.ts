/**
 * IPC 服务端：监听 Unix socket，处理 attach 客户端发来的 snapshot/ping 请求。
 *
 * Windows 不支持（socketPath 返回空字符串），调用方应跳过 startIpcServer。
 */
import { IpcSnapshotData } from "./ipc-protocol.js";
export interface IpcServerDeps {
    socketPath: string;
    /** 由 TUI 上层组装。同步函数，避免在 socket callback 里做异步阻塞。 */
    snapshotProvider: () => IpcSnapshotData;
    /** attach 客户端发起 shutdown 时调用；返回 promise，resolve 后服务端退出。 */
    onShutdown?: () => void | Promise<void>;
}
export interface IpcServerHandle {
    close(): Promise<void>;
}
export declare function startIpcServer(deps: IpcServerDeps): IpcServerHandle | null;
