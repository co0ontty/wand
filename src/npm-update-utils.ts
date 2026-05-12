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
 * 我们的策略：每次 npm install 之前先清掉 `@co0ontty/.wand-*` 残留目录；
 * 如果第一次安装仍然撞上 ENOTEMPTY，清理后重试；再不行就 uninstall + force install。
 */

import { exec, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const PACKAGE_NAME = "@co0ontty/wand";
const PACKAGE_SCOPE = "@co0ontty";
const PACKAGE_BASENAME = "wand";

/**
 * 解析当前 `npm root -g` 的目录。失败返回 null。
 */
export function getNpmGlobalRoot(): string | null {
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 });
    if (res.status !== 0) return null;
    const out = (res.stdout || "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 清理上一次 npm install 失败留下的 `.wand-XXXXXX` 残留目录。
 *
 * 同步执行，best-effort：找不到 npm root、目录不存在、无权限删除等都不会抛错。
 * 返回被清理的目录列表，方便调用方记录日志。
 */
export function cleanupNpmLeftovers(): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  const root = getNpmGlobalRoot();
  if (!root) return { removed, errors };

  const scopeDir = path.join(root, PACKAGE_SCOPE);
  if (!existsSync(scopeDir)) return { removed, errors };

  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch (err) {
    errors.push(`readdir ${scopeDir}: ${err instanceof Error ? err.message : String(err)}`);
    return { removed, errors };
  }

  // 残留目录形如 `.wand-PdFXStca`：以点开头 + 包基名 + 短横线 + 随机后缀
  const leftoverPattern = new RegExp(`^\\.${PACKAGE_BASENAME}-[A-Za-z0-9]+$`);

  for (const name of entries) {
    if (!leftoverPattern.test(name)) continue;
    const fullPath = path.join(scopeDir, name);
    try {
      // 仅清理目录，避免误删同名文件
      if (!statSync(fullPath).isDirectory()) continue;
      rmSync(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    } catch (err) {
      errors.push(`rm ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { removed, errors };
}

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
export async function installPackageGloballyAsync(
  pkg: string,
  timeoutMs: number,
  log?: (line: string) => void,
): Promise<void> {
  const note = (line: string) => {
    if (log) log(line);
  };

  const cleanup = cleanupNpmLeftovers();
  if (cleanup.removed.length > 0) {
    note(`[wand] 清理 npm 残留目录: ${cleanup.removed.join(", ")}`);
  }

  try {
    await execAsync(`npm install -g ${pkg}`, { timeout: timeoutMs });
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/ENOTEMPTY|EEXIST/.test(msg)) {
      throw error;
    }
    note(`[wand] npm install 遇到 ENOTEMPTY/EEXIST，清理后重试一次...`);
  }

  cleanupNpmLeftovers();
  try {
    await execAsync(`npm install -g ${pkg}`, { timeout: timeoutMs });
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/ENOTEMPTY|EEXIST/.test(msg)) {
      throw error;
    }
    note(`[wand] 重试仍失败，尝试先卸载再强制安装...`);
  }

  // 终极兜底：uninstall + force install
  const baseName = pkg.replace(/@[^@/]*$/, ""); // strip @latest / @1.2.3
  try {
    await execAsync(`npm uninstall -g ${baseName}`, { timeout: timeoutMs });
  } catch {
    /* 卸载失败也继续，下一步 --force 可能仍然能装上 */
  }
  cleanupNpmLeftovers();
  await execAsync(`npm install -g --force ${pkg}`, { timeout: timeoutMs });
}

/**
 * 同步版本，给 TUI installUpdate 用。
 *
 * 返回值兼容 spawnSync：包含最后一次尝试的 stdout/stderr/status。
 */
export function installPackageGloballySync(
  pkg: string,
  timeoutMs: number,
): { status: number | null; stdout: string; stderr: string; attempts: string[] } {
  const attempts: string[] = [];
  const tryInstall = (extra: string[]): { status: number | null; stdout: string; stderr: string } => {
    const args = ["install", "-g", ...extra, pkg];
    attempts.push(`npm ${args.join(" ")}`);
    const r = spawnSync("npm", args, { encoding: "utf8", timeout: timeoutMs });
    return {
      status: r.status,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
    };
  };

  cleanupNpmLeftovers();

  let res = tryInstall([]);
  if (res.status === 0) return { ...res, attempts };

  const hitENOTEMPTY = (r: { stdout: string; stderr: string }): boolean =>
    /ENOTEMPTY|EEXIST/.test(r.stdout + r.stderr);

  if (!hitENOTEMPTY(res)) return { ...res, attempts };

  cleanupNpmLeftovers();
  res = tryInstall([]);
  if (res.status === 0) return { ...res, attempts };
  if (!hitENOTEMPTY(res)) return { ...res, attempts };

  // 终极兜底
  const baseName = pkg.replace(/@[^@/]*$/, "");
  attempts.push(`npm uninstall -g ${baseName}`);
  spawnSync("npm", ["uninstall", "-g", baseName], { encoding: "utf8", timeout: timeoutMs });
  cleanupNpmLeftovers();
  res = tryInstall(["--force"]);
  return { ...res, attempts };
}

export const NPM_UPDATE_PACKAGE_NAME = PACKAGE_NAME;
