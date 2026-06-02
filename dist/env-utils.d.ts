/** 是否以 root 身份运行（uid 或 euid 为 0）。供 PTY runner 与 structured runner 共用。 */
export declare function isRunningAsRoot(): boolean;
/**
 * 根据 inheritEnv 配置组装子进程的环境变量。
 *
 * - inheritEnv=true（默认）：继承父进程全部 env，再合并 extras 覆盖。
 * - inheritEnv=false：仅保留 MINIMAL_ENV_KEYS 中存在的字段，再合并 extras 覆盖。
 *
 * extras 中的 undefined 字段会被剔除（spawn 不允许 env 值为 undefined）。
 */
export declare function buildChildEnv(inheritEnv: boolean, extras?: Record<string, string | undefined>): NodeJS.ProcessEnv;
