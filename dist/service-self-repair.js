import process from "node:process";
import { detectInstalledScope, installService } from "./tui/commands.js";
export function repairServiceUnitAfterUpdate(configPath) {
    // 仅 Linux(systemd) / macOS(launchd) 有服务模型。
    if (process.platform !== "linux" && process.platform !== "darwin") {
        return { repaired: false, message: "当前平台无服务模型，跳过 unit 自修复" };
    }
    let scope = null;
    try {
        scope = detectInstalledScope();
    }
    catch {
        scope = null;
    }
    if (!scope) {
        return { repaired: false, message: "未安装系统服务，跳过 unit 自修复" };
    }
    try {
        const result = installService({ configPath, scope, preferGlobalBin: true });
        if (result.ok) {
            return {
                repaired: true,
                scope,
                message: `已用全局安装重写 ${scope} 服务 unit（刷新 ExecStart / PATH）`,
            };
        }
        const tail = scope === "system"
            ? "；系统级 unit 需要 root 才能重写，重启后可手动跑 `sudo wand service:install` 修复"
            : "";
        return {
            repaired: false,
            scope,
            message: `服务 unit 重写失败（${result.message}）${tail}`,
        };
    }
    catch (err) {
        return {
            repaired: false,
            scope,
            message: `服务 unit 重写异常: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
