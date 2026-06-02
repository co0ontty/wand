import { Express } from "express";
import { ProcessManager } from "./process-manager.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { WandStorage } from "./storage.js";
import { ExecutionMode, WandConfig } from "./types.js";
export declare function getErrorMessage(error: unknown, fallback: string): string;
export declare function registerSessionRoutes(app: Express, processes: ProcessManager, structured: StructuredSessionManager, storage: WandStorage, defaultMode: ExecutionMode, config: WandConfig, onSessionCreated?: (cwd: string | undefined | null) => void): void;
export declare function registerClaudeHistoryRoutes(app: Express, processes: ProcessManager, storage: WandStorage): void;
