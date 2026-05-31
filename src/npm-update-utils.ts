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

import { execFile, type ExecFileOptions, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = "@co0ontty/wand";
const PACKAGE_SCOPE = "@co0ontty";
const PACKAGE_BASENAME = "wand";
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";
const COMMON_UNIX_PATHS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const INSTALL_MAX_BUFFER = 10 * 1024 * 1024;

function getChildEnv(): NodeJS.ProcessEnv {
  const entries = [
    path.dirname(process.execPath),
    ...(process.env.PATH || "").split(path.delimiter),
    ...(process.platform === "win32" ? [] : COMMON_UNIX_PATHS),
  ];
  const seen = new Set<string>();
  const pathEntries: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    pathEntries.push(entry);
  }
  return {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
  };
}

function runNpmSync(args: string[], timeoutMs: number) {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    timeout: timeoutMs,
    env: getChildEnv(),
    maxBuffer: INSTALL_MAX_BUFFER,
  };
  return spawnSync(NPM_BIN, args, options);
}

async function runNpmAsync(args: string[], timeoutMs: number): Promise<void> {
  const options: ExecFileOptions = {
    timeout: timeoutMs,
    env: getChildEnv(),
    maxBuffer: INSTALL_MAX_BUFFER,
  };
  await execFileAsync(NPM_BIN, args, options);
}

/**
 * 解析当前 `npm root -g` 的目录。失败返回 null。
 */
export function getNpmGlobalRoot(): string | null {
  try {
    const res = runNpmSync(["root", "-g"], 10_000);
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

const REQUIRED_RUNTIME_FILES = [
  "package.json",
  path.join("dist", "cli.js"),
  path.join("dist", "server.js"),
  path.join("dist", "web-ui", "index.js"),
  path.join("dist", "web-ui", "embedded-assets.js"),
  path.join("dist", "web-ui", "scripts.js"),
  path.join("dist", "web-ui", "styles.js"),
  path.join("dist", "web-ui", "content", "scripts.js"),
  path.join("dist", "web-ui", "content", "styles.css"),
  path.join("dist", "web-ui", "content", "vendor", "wterm", "wterm.bundle.js"),
  path.join("dist", "web-ui", "content", "vendor", "qrcode", "qrcode.bundle.js"),
];

function getGlobalPackageDir(): string | null {
  const root = getNpmGlobalRoot();
  return root ? path.join(root, PACKAGE_SCOPE, PACKAGE_BASENAME) : null;
}

function validateGlobalWandInstall(): { ok: true; packageDir: string } | { ok: false; message: string } {
  const packageDir = getGlobalPackageDir();
  if (!packageDir) {
    return { ok: false, message: "无法解析 npm 全局安装目录。" };
  }
  const missing: string[] = [];
  for (const rel of REQUIRED_RUNTIME_FILES) {
    const fullPath = path.join(packageDir, rel);
    try {
      if (!statSync(fullPath).isFile()) {
        missing.push(rel);
      }
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message: `全局 wand 安装不完整: ${packageDir} 缺少 ${missing.join(", ")}`,
    };
  }
  if (process.platform !== "win32") {
    const cliPath = path.join(packageDir, "dist", "cli.js");
    try {
      const mode = statSync(cliPath).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(cliPath, mode | 0o755);
      }
    } catch (err) {
      return {
        ok: false,
        message: `全局 wand CLI 无法设置执行权限: ${cliPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { ok: true, packageDir };
}

function assertGlobalWandInstallComplete(): void {
  const result = validateGlobalWandInstall();
  if (!result.ok) {
    throw new Error(result.message);
  }
}

interface GlobalInstallBackup {
  packageDir: string;
  backupDir: string | null;
}

function createGlobalInstallBackup(note?: (line: string) => void): GlobalInstallBackup {
  const packageDir = getGlobalPackageDir();
  if (!packageDir) {
    return { packageDir: "", backupDir: null };
  }
  if (!existsSync(packageDir)) {
    return { packageDir, backupDir: null };
  }
  const backupRoot = mkdtempSync(path.join(os.tmpdir(), "wand-global-backup-"));
  const backupDir = path.join(backupRoot, PACKAGE_BASENAME);
  try {
    cpSync(packageDir, backupDir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    note?.(`[wand] 已备份当前全局安装: ${backupDir}`);
    return { packageDir, backupDir };
  } catch (err) {
    rmSync(backupRoot, { recursive: true, force: true });
    note?.(`[wand] 全局安装备份失败，继续尝试更新: ${err instanceof Error ? err.message : String(err)}`);
    return { packageDir, backupDir: null };
  }
}

function cleanupGlobalInstallBackup(backup: GlobalInstallBackup): void {
  if (!backup.backupDir) return;
  rmSync(path.dirname(backup.backupDir), { recursive: true, force: true });
}

function restoreGlobalInstallBackup(backup: GlobalInstallBackup, note?: (line: string) => void): boolean {
  if (!backup.packageDir || !backup.backupDir || !existsSync(backup.backupDir)) return false;
  try {
    rmSync(backup.packageDir, { recursive: true, force: true });
    cpSync(backup.backupDir, backup.packageDir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    note?.(`[wand] 已恢复更新前的全局安装: ${backup.packageDir}`);
    return true;
  } catch (err) {
    note?.(`[wand] 恢复更新前安装失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function npmInstallGlobalAsync(pkg: string, timeoutMs: number, extra: string[] = []): Promise<void> {
  await runNpmAsync(["install", "-g", ...extra, pkg], timeoutMs);
}

function isRecoverableInstallError(message: string): boolean {
  return /ENOTEMPTY|EEXIST|全局 wand 安装不完整|无法解析 npm 全局安装目录|全局 wand CLI 无法设置执行权限/.test(message);
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

  const backup = createGlobalInstallBackup(note);
  let success = false;
  try {
    const cleanup = cleanupNpmLeftovers();
    if (cleanup.removed.length > 0) {
      note(`[wand] 清理 npm 残留目录: ${cleanup.removed.join(", ")}`);
    }

    try {
      await npmInstallGlobalAsync(pkg, timeoutMs);
      assertGlobalWandInstallComplete();
      success = true;
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isRecoverableInstallError(msg)) {
        throw error;
      }
      if (/全局 wand 安装不完整|无法解析 npm 全局安装目录|全局 wand CLI 无法设置执行权限/.test(msg)) {
        note(`[wand] npm install 后安装目录不完整，尝试强制重装...`);
      } else {
        note(`[wand] npm install 遇到 ENOTEMPTY/EEXIST，清理后重试一次...`);
        cleanupNpmLeftovers();
        try {
          await npmInstallGlobalAsync(pkg, timeoutMs);
          assertGlobalWandInstallComplete();
          success = true;
          return;
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          if (!isRecoverableInstallError(retryMsg)) {
            throw retryError;
          }
        }
        note(`[wand] 重试仍失败，尝试先卸载再强制安装...`);
      }
    }

    // 终极兜底：uninstall + force install
    // 卸载用固定包名 PACKAGE_NAME，而不是从 install spec 反推：spec 可能是 git
    // 形式（`github:co0ontty/wand#beta`），用正则 strip @tag 反推会得到错误的卸载目标。
    try {
      await runNpmAsync(["uninstall", "-g", PACKAGE_NAME], timeoutMs);
    } catch {
      /* 卸载失败也继续，下一步 --force 可能仍然能装上 */
    }
    cleanupNpmLeftovers();
    await npmInstallGlobalAsync(pkg, timeoutMs, ["--force"]);
    assertGlobalWandInstallComplete();
    success = true;
  } finally {
    if (!success) {
      if (restoreGlobalInstallBackup(backup, note)) {
        cleanupNpmLeftovers();
      }
    }
    cleanupGlobalInstallBackup(backup);
  }
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
  const backupNotes: string[] = [];
  const backup = createGlobalInstallBackup((line) => backupNotes.push(line));
  const withValidation = (
    res: { status: number | null; stdout: string; stderr: string },
  ): { status: number | null; stdout: string; stderr: string } => {
    if (res.status !== 0) return res;
    const validation = validateGlobalWandInstall();
    if (validation.ok) return res;
    return {
      status: 1,
      stdout: res.stdout,
      stderr: `${res.stderr ? `${res.stderr}\n` : ""}${validation.message}`,
    };
  };
  const tryInstall = (extra: string[]): { status: number | null; stdout: string; stderr: string } => {
    const args = ["install", "-g", ...extra, pkg];
    attempts.push(`npm ${args.join(" ")}`);
    const r = runNpmSync(args, timeoutMs);
    return withValidation({
      status: r.status,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
    });
  };
  const withBackupNotes = (res: { status: number | null; stdout: string; stderr: string }) => ({
    ...res,
    stderr: [res.stderr, ...backupNotes].filter(Boolean).join("\n"),
    attempts,
  });
  const finishSuccess = (res: { status: number | null; stdout: string; stderr: string }) => {
    cleanupGlobalInstallBackup(backup);
    return withBackupNotes(res);
  };
  const finishFailure = (res: { status: number | null; stdout: string; stderr: string }) => {
    if (restoreGlobalInstallBackup(backup, (line) => backupNotes.push(line))) {
      cleanupNpmLeftovers();
    }
    cleanupGlobalInstallBackup(backup);
    return withBackupNotes(res);
  };

  cleanupNpmLeftovers();

  let res = tryInstall([]);
  if (res.status === 0) {
    return finishSuccess(res);
  }

  const hitRecoverableInstallError = (r: { stdout: string; stderr: string }): boolean =>
    isRecoverableInstallError(r.stdout + r.stderr);

  if (!hitRecoverableInstallError(res)) {
    return finishFailure(res);
  }

  cleanupNpmLeftovers();
  res = tryInstall([]);
  if (res.status === 0) {
    return finishSuccess(res);
  }
  if (!hitRecoverableInstallError(res)) {
    return finishFailure(res);
  }

  // 终极兜底（卸载用固定包名，兼容 git spec，见 async 版同样注释）
  attempts.push(`npm uninstall -g ${PACKAGE_NAME}`);
  runNpmSync(["uninstall", "-g", PACKAGE_NAME], timeoutMs);
  cleanupNpmLeftovers();
  res = tryInstall(["--force"]);
  if (res.status === 0) {
    return finishSuccess(res);
  }
  return finishFailure(res);
}

/**
 * 解析「刚装好的全局 wand CLI 入口」(dist/cli.js) 的绝对路径。
 *
 * 用途：应用内更新装完新包后，要把 systemd/launchd unit 的 ExecStart 钉到这个
 * 全局安装，而不是 process.argv[1]（源码安装场景下 argv[1] 是旧源码路径）。
 *
 * 优先 `npm root -g`/@co0ontty/wand/dist/cli.js（最准确）；失败回退 `which wand`
 * （npm 全局 bin 里的符号链接，node 跟随软链一样能跑）。都找不到返回 null。
 */
export function resolveGlobalWandCli(): string | null {
  const root = getNpmGlobalRoot();
  if (root) {
    const cli = path.join(root, PACKAGE_SCOPE, PACKAGE_BASENAME, "dist", "cli.js");
    try {
      if (existsSync(cli)) return cli;
    } catch {
      /* ignore */
    }
  }
  try {
    const tool = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(tool, ["wand"], { encoding: "utf8", timeout: 10_000, env: getChildEnv() });
    if (r.status === 0) {
      const first = (r.stdout || "").split(/\r?\n/).find((line) => line.trim().length > 0);
      if (first) return first.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}
