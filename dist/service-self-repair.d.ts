import { type ServiceScope } from "./tui/commands.js";
/**
 * 应用内更新后的「服务单元自修复」，对齐 install.sh 的行为。
 *
 * install.sh 升级时会在 `npm install -g` 之后重跑 `wand service:install`，用当前 PATH
 * 重新烧 unit、并把 ExecStart 钉到新装的全局 wand。应用内的三条更新路径
 * （/api/update、performAutoUpdate、TUI installUpdate）过去缺这一步，于是源码安装的
 * 用户更新到 npm/GitHub 版后，systemd unit 的 ExecStart 仍指旧源码、baked PATH 失效，
 * 重启时「服务找不到 / claude 找不到」。
 *
 * 这里在装包成功后调用，best-effort：
 *   - 没装服务 → 跳过；
 *   - 装了服务 → 用 preferGlobalBin 重写 unit（ExecStart→全局 dist/cli.js，
 *     Environment=PATH 取当前已被 path-repair 修复过的 process.env.PATH）+ daemon-reload；
 *   - system scope 非 root 无法写 /etc → installService 返回失败，这里捕获成 warning，
 *     绝不抛错中断更新流程。
 */
export interface ServiceRepairResult {
    /** 是否成功重写了 unit。无服务、或重写失败都为 false。 */
    repaired: boolean;
    scope?: ServiceScope;
    /** 给日志 / 前端展示的一行说明。 */
    message: string;
}
export declare function repairServiceUnitAfterUpdate(configPath: string): ServiceRepairResult;
