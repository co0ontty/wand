import { ClaudeModelInfo } from "./types.js";
interface ModelCache {
    models: ClaudeModelInfo[];
    codexModels: ClaudeModelInfo[];
    claudeVersion: string | null;
    refreshedAt: string;
}
export declare function getCachedModels(): ModelCache;
export declare function refreshModels(): Promise<ModelCache>;
export {};
