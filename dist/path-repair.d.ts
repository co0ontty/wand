/**
 * 运行时 PATH 自修复。
 *
 * 背景：用户把 wand 装成 systemd / launchd 服务时，service unit 文件里的 PATH
 * 是"安装那一刻"的快照（见 src/tui/commands.ts:buildServicePath）。之后：
 *   - 用户切 node 版本（nvm/fnm/volta），claude 装到新的 bin 目录；
 *   - 或 `npm install -g @co0ontty/wand` 重装，但没重新跑 `wand service:install`，
 *     install.sh 只 `systemctl start`，unit 里的 PATH 一直是老的；
 *   - 或 claude 装到 `~/.bun/bin`、`~/.local/bin` 等当时不在 PATH 里的位置。
 *
 * 服务进程的 process.env.PATH 就是这份陈旧快照。process-manager 给 PTY 子进程
 * 用 buildChildEnv(inheritEnv=true) 时把这份 PATH 直接透传，于是 spawn 出来的
 * shell 里 `claude` 找不到 → "command not found"。
 *
 * 修复分两层（都在 startServer() 开头跑）：
 *   1. repairRuntimePath()（同步、cheap）：扫常见工具链 bin 目录，把存在但 PATH
 *      里缺的"追加"到 process.env.PATH 末尾。
 *   2. deepRepairRuntimePath()（异步、贵一点）：起一个 login shell 拉用户实际的
 *      PATH（覆盖 ~/.bashrc、~/.zshrc、nvm/fnm/volta 的 shell-init 等所有动态
 *      逻辑），把里面 PATH 里我们还没的目录"前插"到 process.env.PATH 前面。这
 *      是真正能修好"unit 里 PATH 太旧、用户 shell 里却好好的"这种场景的关键。
 *
 * 设计决策：
 *   - 同步那层只追加不前插：尊重用户已有顺序；异步那层愿意前插，因为它拿到的是
 *     用户实际"会用的"PATH，比 unit 里的更可信。
 *   - 只加 existsSync 真实存在的：避免 PATH 里塞一堆死路径。
 *   - 用 path.delimiter：Windows 用 `;`，POSIX 用 `:`，跨平台安全。
 *   - 不重写 service unit：那需要 sudo，且语义太重；只在 install.sh 主动调
 *     `wand service:install` 时才重新烧 PATH。
 *   - login shell 用 -lc 跑，4 秒超时；失败就静默走同步路径，不阻塞启动。
 *
 * WAND_PATH_REPAIR_DISABLE=1 可以彻底关掉同步那层（极端情况下用户想完全控制 PATH 时用）。
 * WAND_PATH_REPAIR_DEEP_DISABLE=1 只关掉 login shell 探测，但保留同步追加。
 */
export interface PathRepairResult {
    /** 实际新追加进 PATH 的目录（按追加顺序）。 */
    added: string[];
    /** 关键命令的解析结果（PATH 修复后 `which` 出来的）。null = 没找到。 */
    resolved: Record<string, string | null>;
    /** 修复后的 PATH 整体；调试用。 */
    finalPath: string;
    /** login shell 探测阶段的状态：success / disabled / failed / skipped。 */
    deepProbe: "success" | "disabled" | "failed" | "skipped";
    /** 异步阶段产生的告警信息（login shell 超时、解析失败等）。 */
    warnings: string[];
}
/**
 * 把候选目录中"存在 + 未在 PATH 中"的追加到 process.env.PATH。
 *
 * 不会去重已经在 PATH 里的项（即使顺序不理想也保持原样），只往末尾补。
 */
export declare function repairRuntimePath(): PathRepairResult;
/**
 * 在 repairRuntimePath() 同步追加完之后，再用 login shell 拉一份用户实际的 PATH
 * 合并进来。这是真正能修好"unit 里 PATH 太旧、用户 shell 里 claude 好好的"那种
 * 升级回归的关键——同步阶段只能扫已知路径，login shell 才能拿到 nvm/fnm/volta
 * 这种动态注入的 PATH。
 *
 * 行为：
 *   - 跑 `${shell} -l -c '...'` 拉 $PATH 和 command -v claude/codex（4s 超时）
 *   - 把 login shell PATH 里我们还没收录的目录 **前插** 到 process.env.PATH（注意
 *     是前插，不是追加 —— 它比 unit 里的更可信）
 *   - 失败时静默走同步那一版结果
 *
 * 接受一个已经跑过同步阶段的 result，在上面 mutate。
 */
export declare function deepRepairRuntimePath(result: PathRepairResult, opts?: {
    shell?: string;
    timeoutMs?: number;
}): Promise<PathRepairResult>;
export declare function whichSync(cmd: string, options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}): string | null;
/**
 * 把修复结果格式化为一行可读摘要（startServer 启动日志用）。
 *
 * 例：
 *   `[wand] PATH augmented (+3 dirs); claude=/usr/local/bin/claude, codex=<missing>`
 *   `[wand] PATH already complete; claude=/Users/foo/.bun/bin/claude`
 */
export declare function formatPathRepairSummary(result: PathRepairResult): string;
