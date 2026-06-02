import { ProcessManager } from "../process-manager.js";
import { StructuredSessionManager } from "../structured-session-manager.js";
export interface TuiDeps {
    processManager: ProcessManager;
    structuredSessions: StructuredSessionManager;
    version: string;
    configPath: string;
    dbPath: string;
    bindAddr: string;
    httpsEnabled: boolean;
    urls: Array<{
        url: string;
        scheme: "HTTP" | "HTTPS";
    }>;
    orphanRecoveredCount: number;
    /** 退出 TUI 时调用。返回的 Promise resolve 后 cli 才会 process.exit。 */
    onExit: (reason: ExitReason) => void | Promise<void>;
}
export type ExitReason = "user" | "signal" | "error";
export interface TuiHandle {
    isActive: boolean;
    stop(reason: ExitReason): Promise<void>;
}
export declare function startTui(deps: TuiDeps): TuiHandle;
