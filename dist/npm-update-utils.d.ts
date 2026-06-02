/**
 * npm 全局更新通用辅助。
 *
 * 共用于 server.ts 的 /api/update / performAutoUpdate，以及 TUI 的 installUpdate。
 *
 * 解决的核心问题：当 wand 进程正在运行（systemd/launchd/nohup/直接前台都算）时，
 * `npm install -g @co0ontty/wand@latest` 会把旧包目录 rename 成 `.wand-XXXXXX` 备份。
 * 如果安装中途失败，这个备份目录会留下，之后每次 npm install 都会因为目标 dest 已存在
 * 报 `ENOTEMPTY: directory not empty, rename ...`。
 *
 * 我们的策略：安装前备份当前全局包，补齐 npm 子进程 PATH，清掉
 * `@co0ontty/.wand-*` 残留目录；失败时恢复备份，避免运行中的服务被半成品安装拆掉。
 */
/**
 * 解析当前 `npm root -g` 的目录。失败返回 null。
 */
export declare function getNpmGlobalRoot(): string | null;
/**
 * 清理上一次 npm install 失败留下的 `.wand-XXXXXX` 残留目录。
 *
 * 同步执行，best-effort：找不到 npm root、目录不存在、无权限删除等都不会抛错。
 * 返回被清理的目录列表，方便调用方记录日志。
 */
export declare function cleanupNpmLeftovers(): {
    removed: string[];
    errors: string[];
};
/**
 * 异步版本的全局安装：
 * 1. 清理残留
 * 2. `npm install -g <pkg>`
 * 3. 撞上 ENOTEMPTY/EEXIST：再清一次 + 重试一次
 * 4. 再不行：`npm uninstall -g <pkg-no-tag>` + `npm install -g --force <pkg>`
 *
 * @param pkg 包名带版本，例如 `@co0ontty/wand@latest`
 * @param timeoutMs 单次 npm 调用超时
 * @param log 可选 logger，用来把过程写入控制台或前端日志
 */
export declare function installPackageGloballyAsync(pkg: string, timeoutMs: number, log?: (line: string) => void): Promise<void>;
/**
 * 同步版本，给 TUI installUpdate 用。
 *
 * 返回值兼容 spawnSync：包含最后一次尝试的 stdout/stderr/status。
 */
export declare function installPackageGloballySync(pkg: string, timeoutMs: number): {
    status: number | null;
    stdout: string;
    stderr: string;
    attempts: string[];
};
/**
 * 解析「刚装好的全局 wand CLI 入口」(dist/cli.js) 的绝对路径。
 *
 * 用途：应用内更新装完新包后，要把 systemd/launchd unit 的 ExecStart 钉到这个
 * 全局安装，而不是 process.argv[1]（源码安装场景下 argv[1] 是旧源码路径）。
 *
 * 优先 `npm root -g`/@co0ontty/wand/dist/cli.js（最准确）；失败回退 `which wand`
 * （npm 全局 bin 里的符号链接，node 跟随软链一样能跑）。都找不到返回 null。
 */
export declare function resolveGlobalWandCli(): string | null;
