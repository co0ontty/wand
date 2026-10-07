import process from "node:process";

/**
 * 用于子进程 spawn 时的环境变量白名单（当用户关闭"继承环境变量"时使用）。
 * 仅保留运行 CLI 工具所需的最小集合，避免把 API key、token 等敏感凭据继承到子命令。
 */
const MINIMAL_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
];

/** 子进程 env：显式传入 env 优先，否则按 inheritEnv 生成环境。 */
export function resolveChildEnv(options: { env?: NodeJS.ProcessEnv; inheritEnv?: boolean }): NodeJS.ProcessEnv {
  return options.env ?? buildChildEnv(options.inheritEnv !== false);
}

/**
 * 用户默认登录 shell 的完整环境（由 src/path-repair.ts 的 `-lic` 探测捕获）。
 * 服务被 launchd / systemd 拉起时进程 env 是安装那一刻的快照，shell rc 里导出的
 * 变量（工具链、代理、模型相关的配置）都不在其中；这里把它按系统默认环境补回来。
 */
let loginShellEnv: NodeJS.ProcessEnv | undefined;

export function setLoginShellEnv(env: NodeJS.ProcessEnv | undefined): void {
  loginShellEnv = env && Object.keys(env).length > 0 ? env : undefined;
}

export function getLoginShellEnv(): NodeJS.ProcessEnv | undefined {
  return loginShellEnv;
}

/**
 * 子进程环境的底座：系统默认登录 shell 环境 + 当前进程环境。
 * 两者冲突时进程环境优先（本轮显式启动值最大），shell 环境只填补进程里缺失的变量；
 * PATH 的顺序由 deepRepairRuntimePath() 单独按登录 shell 重排回 process.env。
 */
function systemEnv(): NodeJS.ProcessEnv {
  return loginShellEnv ? { ...loginShellEnv, ...process.env } : { ...process.env };
}

/** 读取系统默认环境里的单个变量：进程 env 优先，其次登录 shell。 */
export function systemEnvValue(name: string): string | undefined {
  return process.env[name] ?? loginShellEnv?.[name];
}

/** 是否以 root 身份运行（uid 或 euid 为 0）。供 PTY runner 与 structured runner 共用。 */
export function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0 || process.geteuid?.() === 0;
}

/**
 * 根据 inheritEnv 配置组装子进程的环境变量。
 *
 * - inheritEnv=true（默认）：复用系统默认环境（登录 shell + 当前进程 env），再合并 extras 覆盖。
 * - inheritEnv=false：在同一底座上只保留 MINIMAL_ENV_KEYS 中存在的字段，再合并 extras 覆盖。
 *
 * extras 中的 undefined 字段会被剔除（spawn 不允许 env 值为 undefined）。
 */
export function buildChildEnv(
  inheritEnv: boolean,
  extras: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const source = systemEnv();
  const base: NodeJS.ProcessEnv = {};
  if (inheritEnv) {
    Object.assign(base, source);
  } else {
    for (const key of MINIMAL_ENV_KEYS) {
      const v = source[key];
      if (typeof v === "string") base[key] = v;
    }
  }
  // Do not let nested Wand/PTY or one-shot automation inherit another run's decision capability.
  for (const key of ["WAND_DECISION_URL", "WAND_DECISION_TOKEN", "WAND_DECISION_CA", "WAND_DECISION_NODE", "WAND_DECISION_CLI"]) delete base[key];
  for (const [k, v] of Object.entries(extras)) {
    if (typeof v === "string") base[k] = v;
  }
  return base;
}
