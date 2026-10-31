import { execFileSync } from "node:child_process";

export interface TmuxProbeResult {
  ok: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export const TMUX_MINIMUM_VERSION = "2.9";

/** 探测系统 tmux 可用性与版本能力（最低要求 2.9+ 以支持 pane 管道与用户元数据）。 */
export function probeTmuxSupport(env: NodeJS.ProcessEnv = process.env): TmuxProbeResult {
  if (process.platform === "win32") {
    return { ok: false, error: "tmux 执行环境仅支持 POSIX 主机系统。" };
  }
  const childEnv = { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG };
  let rawVersion: string;
  try {
    rawVersion = execFileSync("tmux", ["-V"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000, env: childEnv,
    }).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      ok: false,
      error: err.code === "ENOENT"
        ? "未找到 tmux 可执行文件，请确认 tmux 已安装且在系统 PATH 中。"
        : `tmux 探测失败: ${(error as Error).message}`,
    };
  }

  const match = rawVersion.match(/(\d+)\.(\d+)/);
  if (!match) {
    return { ok: true, version: rawVersion, path: resolveTmuxPath(childEnv) };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 9)) {
    return {
      ok: false,
      version: rawVersion,
      error: `tmux 版本过低（当前 ${rawVersion}，最低需要 ${TMUX_MINIMUM_VERSION}+ 以支持 pane 管道与用户元数据）。`,
    };
  }

  return { ok: true, version: rawVersion, path: resolveTmuxPath(childEnv) };
}

function resolveTmuxPath(env: Record<string, string | undefined>): string {
  try {
    return execFileSync("which", ["tmux"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
  } catch {
    return "tmux";
  }
}

/** Configuration selects new executions only; existing owners remain recoverable. */
export function tmuxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.WAND_TMUX_MODE;
  if (mode !== undefined && mode !== "required" && mode !== "off") {
    throw new Error("WAND_TMUX_MODE must be required or off");
  }
  if (mode) return mode === "required";
  return env.WAND_TEST_MODE !== "1" && !env.NODE_TEST_CONTEXT;
}
