/**
 * 把主进程当前状态打包成 IPC snapshot。
 *
 * 这里同时被 IPC 服务端（远端 attach 客户端拉数据）调用。本地 TUI 仍然直接读
 * processManager / structuredSessions（避免一次额外的对象拷贝）。
 */
import { SessionSnapshot } from "../types.js";
import { IpcSnapshotData } from "./ipc-protocol.js";
export interface SnapshotInputs {
    version: string;
    url: string;
    scheme: "HTTP" | "HTTPS";
    bindAddr: string;
    configPath: string;
    dbPath: string;
    orphanRecoveredCount: number;
    startedAtMs: number;
    pid: number;
    processManager: {
        listSlim(): SessionSnapshot[];
    };
    structuredSessions: {
        listSlim(): SessionSnapshot[];
    };
}
export declare function buildSnapshotData(inputs: SnapshotInputs): IpcSnapshotData;
