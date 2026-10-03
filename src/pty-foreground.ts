import { execFile } from "node:child_process";

/**
 * PTY 前台进程组探测。
 *
 * 非 Claude 的 provider CLI 都写在 PTY 里，Server 看不到它们的回合边界，
 * 只能靠「输出活动」猜（见 `pty-turn-activity.ts`）。猜的前提是「CLI 还在前台」，
 * 而这件事以前靠一次性启动标记 `providerCliActive` 判断：标记只在 CLI **第一次**
 * 退出时被消费，之后同一个 PTY 里再启动 CLI（自更新重启、手动重跑）就再也认不出来，
 * 会话会永久停在「不像在跑」的状态（ptyBusy 永远为 false），任务列表也就不显示运行中。
 *
 * 这里换成读内核事实：终端的前台进程组（`tpgid`）。CLI 在前台时
 * `tpgid != shell 自己的 pgid`；CLI 退回提示符后两者相等。这个判断对任意 provider 成立，
 * 且 CLI 每次重新启动都会自动重新成立，不需要任何一次性标记。
 *
 * 平台覆盖 darwin / linux（两边的 `ps` 都提供 `tpgid`）。其他平台返回 null，
 * 调用方回退到旧的 providerCliActive 判定。
 */

export interface PtyForegroundRow {
  pid: number;
  pgid: number;
  tpgid: number;
}

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

/** 解析 `ps -o pid=,pgid=,tpgid=` 的输出（空行与不可解析行直接跳过）。 */
export function parsePtyForegroundRows(stdout: string): PtyForegroundRow[] {
  const rows: PtyForegroundRow[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const pgid = Number(parts[1]);
    const tpgid = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid) || !Number.isInteger(tpgid)) continue;
    if (pid <= 0) continue;
    rows.push({ pid, pgid, tpgid });
  }
  return rows;
}

/**
 * shell 进程的终端上是否有别的进程组在前台。
 * tpgid 为 0（没有控制终端）或等于 shell 自己的进程组时都是「CLI 不在前台」。
 */
export function cliIsForeground(row: PtyForegroundRow): boolean {
  return row.tpgid > 0 && row.tpgid !== row.pgid;
}

export interface SamplePtyForegroundsOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/**
 * 采样若干 shell 进程的前台状态。返回 pid → 是否有前台 CLI 的映射：
 * 输出里缺失的 pid 不会出现在结果里（调用方保留上次结论）。整体不可用时返回 null。
 */
export function samplePtyForegrounds(
  pids: readonly number[],
  options: SamplePtyForegroundsOptions = {},
): Promise<Map<number, boolean> | null> {
  const platform = options.platform ?? process.platform;
  const wanted = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!SUPPORTED_PLATFORMS.has(platform) || wanted.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", wanted.join(","), "-o", "pid=,pgid=,tpgid="],
      { timeout: options.timeoutMs ?? 2000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const text = typeof stdout === "string" ? stdout : "";
        const rows = parsePtyForegroundRows(text);
        // `ps` 对含「已退出 pid」的列表会以非 0 退出码仍然打印存活行，所以先看解析结果；
        // 一行都没有才算整体失败（例如 ps 不可用），交给调用方保留上次结论。
        if (rows.length === 0) {
          resolve(error ? null : new Map());
          return;
        }
        const result = new Map<number, boolean>();
        for (const row of rows) {
          if (!wanted.includes(row.pid)) continue;
          result.set(row.pid, cliIsForeground(row));
        }
        resolve(result);
      },
    );
  });
}
