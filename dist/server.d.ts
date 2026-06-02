import { ProcessManager } from "./process-manager.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { WandStorage } from "./storage.js";
import { type PathRepairResult } from "./path-repair.js";
import { WandConfig } from "./types.js";
/** Persist a cwd to recent paths. Used by both REST and session creation hooks. */
export declare function recordRecentPath(storage: WandStorage, cwd: string | undefined | null): void;
export interface ServerUrl {
    url: string;
    scheme: "HTTP" | "HTTPS";
}
export interface ServerHandle {
    processManager: ProcessManager;
    structuredSessions: StructuredSessionManager;
    configPath: string;
    dbPath: string;
    urls: ServerUrl[];
    bindAddr: string;
    httpsEnabled: boolean;
    version: string;
    orphanRecoveredCount: number;
    pathRepair: PathRepairResult;
    close(): Promise<void>;
}
export declare function startServer(config: WandConfig, configPath: string): Promise<ServerHandle>;
