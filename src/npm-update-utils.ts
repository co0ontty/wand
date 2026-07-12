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
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { whichSync } from "./path-repair.js";
import { getErrorMessage } from "./error-utils.js";

const execFileAsync = promisify(execFile);

export const PACKAGE_NAME = "@co0ontty/wand";
const PACKAGE_SCOPE = "@co0ontty";
const PACKAGE_BASENAME = "wand";
const DEFAULT_NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";
const COMMON_UNIX_PATHS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const INSTALL_MAX_BUFFER = 10 * 1024 * 1024;
const NPM_VIEW_TIMEOUT_MS = 15_000;
const UPDATE_DISK_RESERVE_BYTES = 512 * 1024 * 1024;

export type UpdateChannel = "stable" | "beta";

export interface PackageUpdateInfo {
  channel: UpdateChannel;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  distTag: "latest" | "beta";
  installSpec: string;
}

function npmBin(): string {
  return process.env.WAND_NPM_BIN || DEFAULT_NPM_BIN;
}

export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return value === "beta" ? "beta" : "stable";
}

export function getUpdateDistTag(channel: UpdateChannel): "latest" | "beta" {
  return channel === "beta" ? "beta" : "latest";
}

export function getInstallSpecForChannel(channel: UpdateChannel): string {
  return `${PACKAGE_NAME}@${getUpdateDistTag(channel)}`;
}

function cleanVersion(value: string): string {
  return value.trim().replace(/^v/, "");
}

export function getStableTagVersion(version: string): string {
  return cleanVersion(version).split("+")[0]?.split("-")[0] ?? cleanVersion(version);
}

function computeUpdateAvailable(currentVersion: string, latestVersion: string | null, channel: UpdateChannel): boolean {
  if (!latestVersion) return false;

  const current = cleanVersion(currentVersion);
  const target = channel === "stable"
    ? getStableTagVersion(latestVersion)
    : cleanVersion(latestVersion);

  // npm's selected dist-tag is authoritative. Manual/local builds can have a
  // numerically higher, lower, invalid, or suffixed version; any mismatch must
  // still allow switching to the exact package selected by @latest or @beta.
  return current !== target;
}

export function buildPackageUpdateInfo(
  currentVersion: string,
  channel: UpdateChannel,
  latestVersion: string | null,
): PackageUpdateInfo {
  const latest = latestVersion?.trim() || null;
  const stableLatest = channel === "stable" && latest ? getStableTagVersion(latest) : latest;
  return {
    channel,
    current: cleanVersion(currentVersion),
    latest: stableLatest,
    updateAvailable: computeUpdateAvailable(currentVersion, stableLatest, channel),
    distTag: getUpdateDistTag(channel),
    installSpec: getInstallSpecForChannel(channel),
  };
}

async function viewPackageVersionAsync(channel: UpdateChannel, timeoutMs = NPM_VIEW_TIMEOUT_MS): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      npmBin(),
      ["view", getInstallSpecForChannel(channel), "version"],
      { timeout: timeoutMs, env: getChildEnv(), maxBuffer: INSTALL_MAX_BUFFER },
    );
    const version = String(stdout || "").trim();
    return version || null;
  } catch {
    return null;
  }
}

function viewPackageVersionSync(channel: UpdateChannel, timeoutMs = NPM_VIEW_TIMEOUT_MS): string | null {
  const res = runNpmSync(["view", getInstallSpecForChannel(channel), "version"], timeoutMs);
  if (res.status !== 0 || !res.stdout) return null;
  const version = res.stdout.trim();
  return version || null;
}

export async function checkPackageUpdateAsync(
  currentVersion: string,
  channel: UpdateChannel,
  timeoutMs = NPM_VIEW_TIMEOUT_MS,
): Promise<PackageUpdateInfo> {
  const latest = await viewPackageVersionAsync(channel, timeoutMs);
  return buildPackageUpdateInfo(currentVersion, channel, latest);
}

export function checkPackageUpdateSync(
  currentVersion: string,
  channel: UpdateChannel,
  timeoutMs = NPM_VIEW_TIMEOUT_MS,
): PackageUpdateInfo {
  const latest = viewPackageVersionSync(channel, timeoutMs);
  return buildPackageUpdateInfo(currentVersion, channel, latest);
}

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
  return spawnSync(npmBin(), args, options);
}

async function runNpmAsync(args: string[], timeoutMs: number): Promise<void> {
  const options: ExecFileOptions = {
    timeout: timeoutMs,
    env: getChildEnv(),
    maxBuffer: INSTALL_MAX_BUFFER,
  };
  await execFileAsync(npmBin(), args, options);
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

function getNpmGlobalPrefix(): string | null {
  try {
    const res = runNpmSync(["prefix", "-g"], 10_000);
    if (res.status !== 0) return null;
    const out = (res.stdout || "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function getGlobalWandBinPaths(): string[] {
  const prefix = getNpmGlobalPrefix();
  if (!prefix) return [];
  if (process.platform === "win32") {
    return [
      path.join(prefix, PACKAGE_BASENAME),
      path.join(prefix, `${PACKAGE_BASENAME}.cmd`),
      path.join(prefix, `${PACKAGE_BASENAME}.ps1`),
    ];
  }
  return [path.join(prefix, "bin", PACKAGE_BASENAME)];
}

function pathEntryExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
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

  // npm 的 rename 临时项固定为 `.wand-` + 8 位随机字串。不要用宽泛前缀，
  // 否则会误删用户/运维留下的 `.wand-backup` 等人工备份。
  const leftoverPattern = new RegExp(`^\\.${PACKAGE_BASENAME}-[A-Za-z0-9]{8}$`);

  const isWandPackageLeftover = (fullPath: string): boolean => {
    try {
      if (!lstatSync(fullPath).isDirectory()) return false;
      const manifest = JSON.parse(readFileSync(path.join(fullPath, "package.json"), "utf8")) as {
        name?: unknown;
      };
      return manifest.name === PACKAGE_NAME;
    } catch {
      return false;
    }
  };

  const isWandBinLeftover = (fullPath: string): boolean => {
    try {
      const entry = lstatSync(fullPath);
      if (entry.isDirectory()) return false;
      const marker = entry.isSymbolicLink()
        ? readlinkSync(fullPath)
        : readFileSync(fullPath, "utf8").slice(0, 16 * 1024);
      return marker.includes(`${PACKAGE_SCOPE}/${PACKAGE_BASENAME}`)
        || marker.includes(`${PACKAGE_SCOPE}${path.sep}${PACKAGE_BASENAME}`);
    } catch {
      return false;
    }
  };

  const cleanupDir = (dir: string, directoriesOnly: boolean): void => {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      errors.push(`readdir ${dir}: ${getErrorMessage(err)}`);
      return;
    }
    for (const name of entries) {
      if (!leftoverPattern.test(name)) continue;
      const fullPath = path.join(dir, name);
      try {
        const belongsToWand = directoriesOnly
          ? isWandPackageLeftover(fullPath)
          : isWandBinLeftover(fullPath);
        if (!belongsToWand) continue;
        // bin 目录绝不递归删除目录；scope 里只删除已验证 manifest 的 wand 包。
        rmSync(fullPath, { recursive: directoriesOnly, force: true });
        removed.push(fullPath);
      } catch (err) {
        errors.push(`rm ${fullPath}: ${getErrorMessage(err)}`);
      }
    }
  };

  cleanupDir(path.join(root, PACKAGE_SCOPE), true);
  const binPaths = getGlobalWandBinPaths();
  if (binPaths.length > 0) cleanupDir(path.dirname(binPaths[0]), false);
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

function directorySizeSync(targetPath: string): number {
  const entry = lstatSync(targetPath);
  if (entry.isSymbolicLink()) return 0;
  if (!entry.isDirectory()) return entry.size;
  let total = 0;
  for (const name of readdirSync(targetPath)) {
    total += directorySizeSync(path.join(targetPath, name));
  }
  return total;
}

/**
 * 更新时同时存在旧包备份、npm 正在解包的新版本和下载/回滚余量。
 * 旧包大小按三倍计（安全备份、新包、回滚 staging），再保留 512 MiB，
 * 避免 ENOSPC 把全局 CLI 拆成半包。
 */
export function requiredUpdateFreeBytes(currentInstallBytes: number): number {
  const normalized = Number.isFinite(currentInstallBytes)
    ? Math.max(0, Math.floor(currentInstallBytes))
    : 0;
  return normalized * 3 + UPDATE_DISK_RESERVE_BYTES;
}

function formatBytes(bytes: number): string {
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MiB`;
}

function nearestExistingAncestor(targetPath: string): string {
  let current = path.resolve(targetPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function assertUpdateDiskSpace(packageDir: string, note?: (line: string) => void): void {
  const currentInstallBytes = existsSync(packageDir) ? directorySizeSync(packageDir) : 0;
  const probePath = nearestExistingAncestor(packageDir);
  const stats = statfsSync(probePath, { bigint: true });
  const availableBytes = Number(stats.bavail * stats.bsize);
  const requiredBytes = requiredUpdateFreeBytes(currentInstallBytes);
  if (availableBytes < requiredBytes) {
    throw new Error(
      `磁盘空间不足，已取消更新以保护当前安装：可用 ${formatBytes(availableBytes)}，` +
      `至少需要 ${formatBytes(requiredBytes)}（当前 wand ${formatBytes(currentInstallBytes)}）。`,
    );
  }
  note?.(
    `[wand] 更新磁盘预检通过: 可用 ${formatBytes(availableBytes)}，` +
    `需要 ${formatBytes(requiredBytes)}`,
  );
}

function validateWandPackageDir(packageDir: string): { ok: true } | { ok: false; message: string } {
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
        message: `全局 wand CLI 无法设置执行权限: ${cliPath}: ${getErrorMessage(err)}`,
      };
    }
  }
  return { ok: true };
}

function validateGlobalWandInstall(): { ok: true; packageDir: string } | { ok: false; message: string } {
  const packageDir = getGlobalPackageDir();
  if (!packageDir) {
    return { ok: false, message: "无法解析 npm 全局安装目录。" };
  }
  const packageValidation = validateWandPackageDir(packageDir);
  if (!packageValidation.ok) return packageValidation;
  const binPaths = getGlobalWandBinPaths();
  const cliPath = path.join(packageDir, "dist", "cli.js");
  const hasWorkingBin = process.platform === "win32"
    ? binPaths.length > 0 && binPaths.every((binPath) => {
      try {
        return statSync(binPath).isFile();
      } catch {
        return false;
      }
    })
    : binPaths.length === 1 && (() => {
      try {
        return realpathSync(binPaths[0]) === realpathSync(cliPath);
      } catch {
        return false;
      }
    })();
  if (!hasWorkingBin) {
    return {
      ok: false,
      message: `全局 wand 命令入口缺失: ${binPaths.join(", ") || "无法解析 npm prefix"}`,
    };
  }
  return { ok: true, packageDir };
}

function assertGlobalWandInstallComplete(): string {
  const result = validateGlobalWandInstall();
  if (!result.ok) {
    throw new Error(result.message);
  }
  return path.join(result.packageDir, "dist", "cli.js");
}

interface GlobalInstallBackup {
  packageDir: string;
  backupRoot: string | null;
  backupDir: string | null;
  binEntries: Array<{ originalPath: string; backupPath: string }>;
}

function createGlobalInstallBackup(note?: (line: string) => void): GlobalInstallBackup {
  const packageDir = getGlobalPackageDir();
  if (!packageDir) {
    throw new Error("无法解析 npm 全局安装目录，已取消更新以保护当前安装。");
  }
  if (!existsSync(packageDir)) {
    assertUpdateDiskSpace(packageDir, note);
    return { packageDir, backupRoot: null, backupDir: null, binEntries: [] };
  }
  // 备份前只要求包体完整；bin shim 本身可能正是待修复对象。
  const validation = validateWandPackageDir(packageDir);
  if (!validation.ok) {
    throw new Error(`${validation.message}；已取消更新，请先修复当前安装。`);
  }
  assertUpdateDiskSpace(packageDir, note);
  const scopeDir = path.dirname(packageDir);
  mkdirSync(scopeDir, { recursive: true });
  // 与全局包同盘并避开 npm 的 `.wand-XXXXXXXX` 命名，崩溃/重启后仍可作为救援运行时。
  const backupRoot = mkdtempSync(path.join(scopeDir, ".wand-safe-backup-"));
  const backupDir = path.join(backupRoot, PACKAGE_BASENAME);
  const binEntries: Array<{ originalPath: string; backupPath: string }> = [];
  try {
    cpSync(packageDir, backupDir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    const binBackupDir = path.join(backupRoot, "bin");
    for (const [index, originalPath] of getGlobalWandBinPaths().entries()) {
      if (!pathEntryExists(originalPath)) continue;
      mkdirSync(binBackupDir, { recursive: true });
      const backupPath = path.join(binBackupDir, `${index}-${path.basename(originalPath)}`);
      cpSync(originalPath, backupPath, {
        dereference: false,
        verbatimSymlinks: true,
      });
      binEntries.push({ originalPath, backupPath });
    }
    note?.(`[wand] 已备份当前全局安装: ${backupDir}`);
    return { packageDir, backupRoot, backupDir, binEntries };
  } catch (err) {
    rmSync(backupRoot, { recursive: true, force: true });
    throw new Error(`全局安装备份失败，已取消更新: ${getErrorMessage(err)}`);
  }
}

function cleanupGlobalInstallBackup(backup: GlobalInstallBackup): void {
  if (!backup.backupRoot) return;
  rmSync(backup.backupRoot, { recursive: true, force: true });
}

function removeGlobalBinEntry(binPath: string): void {
  try {
    if (lstatSync(binPath).isDirectory()) {
      throw new Error(`拒绝递归删除异常的 wand bin 目录: ${binPath}`);
    }
    rmSync(binPath, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function pointPosixBinAtRecoveryBackup(backup: GlobalInstallBackup): void {
  if (process.platform === "win32" || !backup.backupDir) return;
  const binPaths = getGlobalWandBinPaths();
  if (binPaths.length !== 1) throw new Error("无法解析 npm 全局 bin 目录。");
  const binPath = binPaths[0];
  const recoveryCli = path.join(backup.backupDir, "dist", "cli.js");
  const recoveryValidation = validateWandPackageDir(backup.backupDir);
  if (!recoveryValidation.ok) throw new Error(recoveryValidation.message);

  const binDir = path.dirname(binPath);
  mkdirSync(binDir, { recursive: true });
  const pendingLink = path.join(binDir, `.wand-recovery-${randomUUID()}`);
  try {
    symlinkSync(path.relative(binDir, recoveryCli), pendingLink);
    // rename 覆盖文件/符号链接是原子的；若目标异常地是目录则拒绝并保留原状。
    if (pathEntryExists(binPath) && lstatSync(binPath).isDirectory()) {
      throw new Error(`拒绝替换异常的 wand bin 目录: ${binPath}`);
    }
    renameSync(pendingLink, binPath);
  } catch (err) {
    rmSync(pendingLink, { force: true });
    throw err;
  }
}

function restoreGlobalBinEntries(backup: GlobalInstallBackup): void {
  const binPaths = getGlobalWandBinPaths();
  if (process.platform !== "win32") {
    if (binPaths.length !== 1) throw new Error("无法解析 npm 全局 bin 目录。");
    const binPath = binPaths[0];
    const cliPath = path.join(backup.packageDir, "dist", "cli.js");
    mkdirSync(path.dirname(binPath), { recursive: true });
    removeGlobalBinEntry(binPath);
    symlinkSync(path.relative(path.dirname(binPath), cliPath), binPath);
    return;
  }

  for (const entry of backup.binEntries) {
    removeGlobalBinEntry(entry.originalPath);
    mkdirSync(path.dirname(entry.originalPath), { recursive: true });
    cpSync(entry.backupPath, entry.originalPath, {
      dereference: false,
      verbatimSymlinks: true,
    });
  }
}

function restoreGlobalInstallBackup(backup: GlobalInstallBackup, note?: (line: string) => void): boolean {
  if (!backup.packageDir || !backup.backupDir || !existsSync(backup.backupDir)) return false;
  const scopeDir = path.dirname(backup.packageDir);
  let stageRoot: string | null = null;
  let quarantinePath: string | null = null;
  try {
    // 回滚复制/目录切换期间，即使进程或机器硬退出，launchd/systemd 仍能从同盘完整备份启动。
    pointPosixBinAtRecoveryBackup(backup);
    // 先在 npm root 同盘 staging 复制并校验。复制失败时不碰当前目录，也不消费备份；
    // staging 完整后才用同盘 rename 原子替换，避免回滚自身再次留下半包。
    mkdirSync(scopeDir, { recursive: true });
    stageRoot = mkdtempSync(path.join(scopeDir, ".wand-restore-"));
    const stagedPackage = path.join(stageRoot, PACKAGE_BASENAME);
    cpSync(backup.backupDir, stagedPackage, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    const stagedValidation = validateWandPackageDir(stagedPackage);
    if (!stagedValidation.ok) throw new Error(stagedValidation.message);

    // 不先 rm 当前目录：把它原子挪到同盘 quarantine，再 promote staging。
    // promote 若失败，立即把原目录原子放回，避免失败路径留下空安装。
    if (existsSync(backup.packageDir)) {
      quarantinePath = path.join(scopeDir, `.wand-quarantine-${randomUUID()}`);
      renameSync(backup.packageDir, quarantinePath);
    }
    try {
      renameSync(stagedPackage, backup.packageDir);
    } catch (promoteError) {
      if (quarantinePath && !existsSync(backup.packageDir) && existsSync(quarantinePath)) {
        renameSync(quarantinePath, backup.packageDir);
        quarantinePath = null;
      }
      throw promoteError;
    }
    restoreGlobalBinEntries(backup);
    const validation = validateGlobalWandInstall();
    if (!validation.ok) throw new Error(validation.message);
    if (quarantinePath) {
      rmSync(quarantinePath, { recursive: true, force: true });
      quarantinePath = null;
    }
    rmSync(stageRoot, { recursive: true, force: true });
    stageRoot = null;
    note?.(`[wand] 已恢复更新前的全局安装: ${backup.packageDir}`);
    return true;
  } catch (err) {
    if (stageRoot) rmSync(stageRoot, { recursive: true, force: true });
    note?.(
      `[wand] 恢复更新前安装失败: ${getErrorMessage(err)}；` +
      `备份保留在 ${backup.backupRoot ?? backup.backupDir}` +
      `${quarantinePath ? `；替换前目录保留在 ${quarantinePath}` : ""}`,
    );
    return false;
  }
}

async function npmInstallGlobalAsync(pkg: string, timeoutMs: number, extra: string[] = []): Promise<void> {
  await runNpmAsync(["install", "-g", ...extra, pkg], timeoutMs);
}

function isRecoverableInstallError(message: string): boolean {
  return /ENOTEMPTY|EEXIST|全局 wand 安装不完整|无法解析 npm 全局安装目录|全局 wand CLI 无法设置执行权限|全局 wand 命令入口缺失/.test(message);
}

interface GlobalUpdateLock {
  lockPath: string;
  token: string;
}

function acquireGlobalUpdateLock(): GlobalUpdateLock {
  const root = getNpmGlobalRoot();
  if (!root) throw new Error("无法解析 npm 全局安装目录，不能建立更新锁。");
  const scopeDir = path.join(root, PACKAGE_SCOPE);
  // 放在 npm root，而不是 @scope 内；npm uninstall 可能清理空 scope 目录。
  const lockPath = path.join(root, ".wand-update-lock");
  const token = randomUUID();
  mkdirSync(scopeDir, { recursive: true });

  try {
    mkdirSync(lockPath);
    writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`,
      "utf8",
    );
    return { lockPath, token };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // 只有本次成功 mkdir 后写 owner 失败时才清；owner token 防止误删别人的锁。
      try {
        const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
          token?: unknown;
        };
        if (owner.token === token) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* 无法证明归属，不删除 */
      }
      throw err;
    }
  }

  let ownerPid = 0;
  try {
    const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
    ownerPid = typeof owner.pid === "number" ? owner.pid : 0;
  } catch {
    /* owner may still be writing; the directory itself is the atomic lock */
  }
  throw new Error(
    `另一个 wand 更新正在进行中（锁: ${lockPath}${ownerPid ? `, PID ${ownerPid}` : ""}）。` +
    "若确认没有更新进程，请手动删除该锁目录。",
  );
}

function releaseGlobalUpdateLock(lock: GlobalUpdateLock): void {
  try {
    const owner = JSON.parse(readFileSync(path.join(lock.lockPath, "owner.json"), "utf8")) as {
      token?: unknown;
    };
    if (owner.token === lock.token) {
      rmSync(lock.lockPath, { recursive: true, force: true });
    }
  } catch {
    // 无法确认 owner 时宁可留下陈旧锁，也不能删掉另一个更新者的锁。
  }
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
 * @returns 与本次安装使用同一个 npm root 校验出的 dist/cli.js 绝对路径
 */
export async function installPackageGloballyAsync(
  pkg: string,
  timeoutMs: number,
  log?: (line: string) => void,
): Promise<string> {
  const note = (line: string) => {
    if (log) log(line);
  };

  const updateLock = acquireGlobalUpdateLock();
  let backup: GlobalInstallBackup | null = null;
  let success = false;
  try {
    backup = createGlobalInstallBackup(note);
    const cleanup = cleanupNpmLeftovers();
    if (cleanup.removed.length > 0) {
      note(`[wand] 清理 npm 残留目录: ${cleanup.removed.join(", ")}`);
    }

    try {
      await npmInstallGlobalAsync(pkg, timeoutMs);
      const installedCli = assertGlobalWandInstallComplete();
      success = true;
      return installedCli;
    } catch (error) {
      const msg = getErrorMessage(error);
      if (!isRecoverableInstallError(msg)) {
        throw error;
      }
      if (/全局 wand 安装不完整|无法解析 npm 全局安装目录|全局 wand CLI 无法设置执行权限|全局 wand 命令入口缺失/.test(msg)) {
        note(`[wand] npm install 后安装目录不完整，尝试强制重装...`);
      } else {
        note(`[wand] npm install 遇到 ENOTEMPTY/EEXIST，清理后重试一次...`);
        cleanupNpmLeftovers();
        try {
          await npmInstallGlobalAsync(pkg, timeoutMs);
          const installedCli = assertGlobalWandInstallComplete();
          success = true;
          return installedCli;
        } catch (retryError) {
          const retryMsg = getErrorMessage(retryError);
          if (!isRecoverableInstallError(retryMsg)) {
            throw retryError;
          }
        }
        note(`[wand] 重试仍失败，尝试先卸载再强制安装...`);
      }
    }

    // 终极兜底：uninstall + force install
    // 卸载用固定包名 PACKAGE_NAME，而不是从 install spec 反推：spec 带 npm tag
    // 或版本号时，用正则 strip @tag 反推会误伤 scoped package 名。
    try {
      await runNpmAsync(["uninstall", "-g", PACKAGE_NAME], timeoutMs);
    } catch {
      /* 卸载失败也继续，下一步 --force 可能仍然能装上 */
    }
    cleanupNpmLeftovers();
    await npmInstallGlobalAsync(pkg, timeoutMs, ["--force"]);
    const installedCli = assertGlobalWandInstallComplete();
    success = true;
    return installedCli;
  } finally {
    try {
      let restored = false;
      if (!success && backup) {
        restored = restoreGlobalInstallBackup(backup, note);
        if (restored) {
          cleanupNpmLeftovers();
        }
      }
      // 恢复失败时绝不能再删唯一完整备份，留给人工恢复。
      if (backup && (success || restored)) cleanupGlobalInstallBackup(backup);
    } finally {
      releaseGlobalUpdateLock(updateLock);
    }
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
  let updateLock: GlobalUpdateLock;
  try {
    updateLock = acquireGlobalUpdateLock();
  } catch (err) {
    return { status: 1, stdout: "", stderr: getErrorMessage(err), attempts };
  }
  let backup: GlobalInstallBackup;
  try {
    backup = createGlobalInstallBackup((line) => backupNotes.push(line));
  } catch (err) {
    releaseGlobalUpdateLock(updateLock);
    return {
      status: 1,
      stdout: "",
      stderr: getErrorMessage(err),
      attempts,
    };
  }
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
    try {
      cleanupGlobalInstallBackup(backup);
      return withBackupNotes(res);
    } finally {
      releaseGlobalUpdateLock(updateLock);
    }
  };
  const finishFailure = (res: { status: number | null; stdout: string; stderr: string }) => {
    try {
      const restored = restoreGlobalInstallBackup(backup, (line) => backupNotes.push(line));
      if (restored) {
        cleanupNpmLeftovers();
        cleanupGlobalInstallBackup(backup);
      }
      return withBackupNotes(res);
    } finally {
      releaseGlobalUpdateLock(updateLock);
    }
  };

  try {
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
  } catch (err) {
    return finishFailure({ status: 1, stdout: "", stderr: getErrorMessage(err) });
  }
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
  const found = whichSync("wand", { env: getChildEnv(), timeoutMs: 10_000 });
  if (found) return found;
  return null;
}

/**
 * 返回 npm 全局命令 shim 的稳定路径。服务 unit 应固定到这个入口，而不是包目录内的
 * dist/cli.js；更新回滚期间 shim 会临时指向同盘安全备份，始终保持可启动。
 */
export function resolveGlobalWandBin(): string | null {
  const candidates = getGlobalWandBinPaths();
  for (const candidate of candidates) {
    if (pathEntryExists(candidate)) return candidate;
  }
  return null;
}
