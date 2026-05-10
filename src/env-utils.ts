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

/**
 * 根据 inheritEnv 配置组装子进程的环境变量。
 *
 * - inheritEnv=true（默认）：继承父进程全部 env，再合并 extras 覆盖。
 * - inheritEnv=false：仅保留 MINIMAL_ENV_KEYS 中存在的字段，再合并 extras 覆盖。
 *
 * extras 中的 undefined 字段会被剔除（spawn 不允许 env 值为 undefined）。
 */
export function buildChildEnv(
  inheritEnv: boolean,
  extras: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  if (inheritEnv) {
    Object.assign(base, process.env);
  } else {
    for (const key of MINIMAL_ENV_KEYS) {
      const v = process.env[key];
      if (typeof v === "string") base[key] = v;
    }
  }
  for (const [k, v] of Object.entries(extras)) {
    if (typeof v === "string") base[k] = v;
  }
  return base;
}
