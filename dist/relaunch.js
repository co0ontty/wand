import process from "node:process";
/**
 * 计算重启方式。
 *
 * - systemd 托管（存在 INVOCATION_ID）且已装服务 → "exit-only"：仅退出，由 unit 里
 *   （更新自修复后可能刚被重写的）ExecStart 重新拉起，避免 spawn 抢 pidfile 的竞态。
 * - 否则 → "spawn"：bin 优先用刚装好的全局 CLI（更新后能跑到新版），回退 argv[1]。
 */
export function computeRelaunch(opts) {
    const managedBySystemd = !!process.env.INVOCATION_ID;
    if (managedBySystemd && opts.serviceInstalled) {
        return { mode: "exit-only" };
    }
    const bin = opts.globalCli ?? process.argv[1] ?? "";
    const args = process.argv.slice(2);
    return { mode: "spawn", bin, args };
}
