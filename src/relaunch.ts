import process from "node:process";

/**
 * 重启策略（纯计算，无项目内依赖，便于被 server / TUI / commands 共用而不引入循环）。
 *
 * 背景：历史上三处重启（/api/restart、performAutoUpdate、TUI restartSelf）都无脑
 * `spawn(node, process.argv.slice(1), {detached}) → exit(0)`。这在两种场景下有坑：
 *   1. 应用内更新后 argv[1] 可能仍指向旧源码路径 → 重启跑回旧二进制；
 *   2. systemd 托管时，exit 本身就会触发 Restart=always 重启；再 spawn 一个 detached
 *      子进程会和 systemd 抢单实例 pidfile，旧 argv 的子进程可能先赢。
 */

export interface RelaunchPlan {
  /** "exit-only" = 仅退出，交由进程管理器（systemd Restart=always）拉起。 */
  mode: "exit-only" | "spawn";
  /** spawn 模式下要执行的 CLI 入口（全局 dist/cli.js 或 argv[1]）。 */
  bin?: string;
  /** spawn 模式下传给 CLI 的参数（不含 node 与 bin），即 process.argv.slice(2)。 */
  args?: string[];
}

/**
 * 计算重启方式。
 *
 * - systemd 托管（存在 INVOCATION_ID）且已装服务 → "exit-only"：仅退出，由 unit 里
 *   （更新自修复后可能刚被重写的）ExecStart 重新拉起，避免 spawn 抢 pidfile 的竞态。
 * - 否则 → "spawn"：bin 优先用刚装好的全局 CLI（更新后能跑到新版），回退 argv[1]。
 */
export function computeRelaunch(opts: {
  serviceInstalled: boolean;
  globalCli: string | null;
}): RelaunchPlan {
  const managedBySystemd = !!process.env.INVOCATION_ID;
  if (managedBySystemd && opts.serviceInstalled) {
    return { mode: "exit-only" };
  }
  const bin = opts.globalCli ?? process.argv[1] ?? "";
  const args = process.argv.slice(2);
  return { mode: "spawn", bin, args };
}
