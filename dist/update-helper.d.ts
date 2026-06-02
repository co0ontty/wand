export interface DetachedUpdateOptions {
    installSpec: string;
    configPath: string;
    parentPid: number;
    cliArgs: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
}
export interface DetachedUpdateResult {
    started: boolean;
    scriptPath: string;
    logPath: string;
    pid?: number;
    message: string;
}
export declare function startDetachedUpdateHelper(opts: DetachedUpdateOptions): DetachedUpdateResult;
export declare function canUseDetachedUpdateHelper(): boolean;
