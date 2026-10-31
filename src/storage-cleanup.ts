import { execFile } from "node:child_process";
import { lstat, readdir, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TEMP_ROOT_MARKER, configTemporaryRoot, readTemporaryLease, systemTemporaryRoot, testTemporaryRoot, temporaryPidAlive, validateTemporaryRoot, type TempLease, type TempKind } from "./managed-temp.js";
import { assertPlainTempPath } from "./managed-temp.js";
import { DIAGNOSTIC_LOG_RETENTION_DAYS, DIAGNOSTIC_RECEIPT_SUFFIX, diagnosticReceiptMatches, isDiagnosticArchive } from "./diagnostic-logs.js";
import type { UploadRepository, ManagedUpload } from "./storage/uploads-repository.js";
import type { PtyTmuxGcReport } from "./pty-tmux-backend.js";

export const STORAGE_CLEANUP_RETENTION_DAYS = 7;
const DAY = 86_400_000;
const exec = promisify(execFile);

export interface CleanupReport {
  applied: boolean;
  checkedAt: string;
  retentionDays: number;
  candidates: number;
  removed: number;
  logicalBytes: number;
  allocatedBytes: number;
  skipped: number;
  issues: string[];
  byKind: Partial<Record<TempKind | "upload" | "diagnostic-log" | "distribution-package" | "native-run" | "migration-snapshot" | "pty-tmux", number>>;
}

/** pi-native 回收结果（与 PiTmuxHost.collectGarbage 的返回一致）。 */
export interface PiNativeGcReport {
  removedSlots: number;
  removedTurns: number;
  freedBytes: number;
}

/** 分发包清理结果（由 DistributionManager 提供，只保留最新一套产物）。 */
export interface DistributionPruneResult {
  deleted: string[];
  freedBytes: number;
}

interface TreeStats { logicalBytes: number; allocatedBytes: number; latest: number; dev: number; ino: number }
interface CleanupOptions {
  roots: string[];
  now?: () => number;
  isAlive?: (pid: number, group?: boolean) => boolean;
  inspectOpenPaths?: () => Promise<string[]>;
  maxEntries?: number;
  configDirectory?: string;
  uploads?: Pick<UploadRepository, "listManagedUploads" | "managedUploadReferenced" | "observeManagedUpload" | "forgetManagedUpload">;
  uploadsActive?: () => boolean;
  onUploadRemoved?: (cwd: string) => void;
  /**
   * 清理分发目录里的历史构建包（Android APK / macOS zip+dmg / iOS IPA）。
   * 只在 apply 时调用：预览不能删文件。保留规则由 DistributionManager 统一持有，
   * 这里不重复一份「哪个是最新」的判断。
   */
  pruneDistributionArtifacts?: () => Promise<DistributionPruneResult>;
  /**
   * 回收 pi-native 下废弃的回合目录。同样只在 apply 时调用，失败不阻断其他回收。
   */
  collectNativeArtifacts?: () => PiNativeGcReport | null;
  /**
   * 修剪迁移前 SQLite 快照（旧版本遗留的无上限堆积）。迁移成功路径已经在
   * storage-schema 里修剪一次，这里只是把历史遗留的一起收掉。
   */
  pruneMigrationSnapshots?: () => { deleted: string[]; freedBytes: number };
  /**
   * 回收 pty-tmux 下废弃的会话记录与 /tmp 遗留的失效 socket。
   */
  collectPtyTmuxArtifacts?: () => PtyTmuxGcReport | null;
}

async function openPaths(): Promise<string[]> {
  if (process.platform === "win32") throw new Error("Open-file inspection unavailable.");
  const { stdout, stderr } = await exec("lsof", ["-nP", "-F", "n"], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  if (stderr.trim()) throw new Error("Open-file inspection incomplete.");
  return stdout.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1));
}

/** Runtime-only, explicit ownership. User history, downloads and rollback inputs are never candidates. */
export class StorageCleanup {
  private busy = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private startup: NodeJS.Timeout | null = null;
  private active: Promise<CleanupReport> | null = null;
  private last: CleanupReport | null = null;
  constructor(private readonly options: CleanupOptions) {}

  status() { return { enabled: this.timer !== null, running: this.busy, retentionDays: STORAGE_CLEANUP_RETENTION_DAYS, lastRun: this.last }; }

  start(): void {
    if (this.timer || this.stopped) return;
    const sweep = () => { if (!this.busy && !this.stopped) void this.run(true).catch(() => {}); };
    this.startup = setTimeout(sweep, 30_000); this.startup.unref();
    this.timer = setInterval(sweep, 6 * 60 * 60_000); this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.startup) clearTimeout(this.startup);
    if (this.timer) clearInterval(this.timer);
    this.startup = this.timer = null;
    await this.active?.catch(() => {});
  }

  async run(apply = false): Promise<CleanupReport> {
    if (this.busy || this.stopped) throw new Error("Storage cleanup is busy or stopping.");
    this.busy = true;
    const task = this.sweep(apply);
    this.active = task;
    try {
      const report = await task;
      if (apply) this.last = report;
      return report;
    } finally { this.active = null; this.busy = false; }
  }

  private async sweep(apply: boolean): Promise<CleanupReport> {
    const report = await this.sweepTemporary(apply);
    if (this.stopped) return report;
    const now = (this.options.now ?? Date.now)();
    const files: { file: string; kind: "upload" | "diagnostic-log"; upload?: ManagedUpload; size: number; blocks: number }[] = [];
    if (this.options.uploads && !this.options.uploadsActive?.()) {
      try {
        for (const upload of this.options.uploads.listManagedUploads()) {
          const referenced = this.options.uploads.managedUploadReferenced(upload);
          if (apply) this.options.uploads.observeManagedUpload(upload, referenced, now);
          if (referenced || upload.orphanedAt === null || upload.orphanedAt >= now - STORAGE_CLEANUP_RETENTION_DAYS * DAY) { report.skipped++; continue; }
          try {
            assertPlainTempPath(upload.canonicalPath);
            if (path.dirname(upload.canonicalPath) !== path.join(upload.canonicalCwd, ".wand-uploads")) throw new Error("invalid upload scope");
            if (await realpath(upload.canonicalCwd) !== upload.canonicalCwd) throw new Error("upload cwd changed");
            const stat = await lstat(upload.canonicalPath);
            if (!stat.isFile() || stat.dev !== upload.device || stat.ino !== upload.inode || stat.size !== upload.size
              || stat.mtimeMs !== upload.mtimeMs || stat.ctimeMs !== upload.ctimeMs) { report.skipped++; continue; }
            files.push({ file: upload.canonicalPath, kind: "upload", upload, size: stat.size, blocks: stat.blocks });
          } catch { report.skipped++; }
        }
      } catch { report.issues.push("Upload ownership/reference inspection failed; uploads preserved."); }
    }
    if (this.options.configDirectory) {
      const directory = this.options.configDirectory;
      const inspect = async (root: string) => {
        assertPlainTempPath(root);
        let entries;
        try { entries = await readdir(root, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        for (const entry of entries) {
          if (!entry.isFile() || !isDiagnosticArchive(entry.name)) continue;
          const file = path.join(root, entry.name);
          try {
            if (!diagnosticReceiptMatches(file)) { report.skipped++; continue; }
            const stat = await lstat(file);
            if (Math.max(stat.ctimeMs, stat.mtimeMs) >= now - DIAGNOSTIC_LOG_RETENTION_DAYS * DAY) { report.skipped++; continue; }
            files.push({ file, kind: "diagnostic-log", size: stat.size, blocks: stat.blocks });
          } catch { report.skipped++; }
        }
      };
      try {
        await inspect(directory);
        const sessionRoot = path.join(directory, "sessions");
        assertPlainTempPath(sessionRoot);
        const entries = await readdir(sessionRoot, { withFileTypes: true }).catch(error => {
          if (error.code === "ENOENT") return []; throw error;
        });
        if (entries.length > 1000) report.issues.push("Diagnostic session scan limit reached; session archives preserved.");
        else for (const entry of entries) { if (entry.isDirectory()) await inspect(path.join(sessionRoot, entry.name)); }
      } catch { report.issues.push("Diagnostic archive inspection failed; uncertain files preserved."); }
    }
    report.candidates += files.length;
    let opened: string[] = [];
    if (apply && files.length) {
      try { opened = await (this.options.inspectOpenPaths ?? openPaths)(); }
      catch { report.skipped += files.length; report.issues.push("Open-file inspection failed; uploaded files and diagnostic archives preserved."); return report; }
    }
    for (const file of files) {
      if (this.stopped) break;
      try {
        if (opened.some(entry => entry === file.file || entry === path.dirname(file.file))) { report.skipped++; continue; }
        assertPlainTempPath(file.file);
        const stat = await lstat(file.file);
        if (file.upload) {
          const upload = file.upload;
          if (stat.dev !== upload.device || stat.ino !== upload.inode || stat.size !== upload.size
            || stat.mtimeMs !== upload.mtimeMs || stat.ctimeMs !== upload.ctimeMs || this.options.uploadsActive?.()
            || this.options.uploads!.managedUploadReferenced(upload)) { report.skipped++; continue; }
        } else if (!diagnosticReceiptMatches(file.file) || Math.max(stat.ctimeMs, stat.mtimeMs) >= now - DIAGNOSTIC_LOG_RETENTION_DAYS * DAY) {
          report.skipped++; continue;
        }
        if (apply) {
          await unlink(file.file); report.removed++;
          if (file.upload) { this.options.uploads!.forgetManagedUpload(file.upload); this.options.onUploadRemoved?.(file.upload.cwd); }
          else await unlink(file.file + DIAGNOSTIC_RECEIPT_SUFFIX).catch(() => {});
        }
        report.logicalBytes += stat.size; report.allocatedBytes += stat.blocks * 512;
        report.byKind[file.kind] = (report.byKind[file.kind] ?? 0) + 1;
      } catch { report.skipped++; }
    }
    await this.sweepDistributionArtifacts(apply, report);
    return report;
  }

  /**
   * 历史构建包回收。这是唯一需要把「版本比较」交给外部的清理：哪个包是「最新」
   * 必须和更新检查同一个答案，所以保留规则住在 DistributionManager，这里只调用。
   * 失败不阻断其他回收。
   */
  private async sweepDistributionArtifacts(apply: boolean, report: CleanupReport): Promise<void> {
    if (!apply || this.stopped) return;
    const detail: string[] = [];
    if (this.options.pruneDistributionArtifacts) {
      try {
        const pruned = await this.options.pruneDistributionArtifacts();
        if (pruned.deleted.length > 0) {
          report.removed += pruned.deleted.length;
          report.logicalBytes += pruned.freedBytes;
          report.byKind["distribution-package"] = pruned.deleted.length;
          detail.push(`分发构建包 ${pruned.deleted.length} 个（${(pruned.freedBytes / 1024 / 1024).toFixed(1)} MB）：${pruned.deleted.join(", ")}`);
        }
      } catch { report.issues.push("Distribution package cleanup failed; packages preserved."); }
    }
    if (this.options.collectNativeArtifacts) {
      try {
        const native = this.options.collectNativeArtifacts();
        const removed = (native?.removedSlots ?? 0) + (native?.removedTurns ?? 0);
        if (native && removed > 0) {
          report.removed += removed;
          report.logicalBytes += native.freedBytes;
          report.byKind["native-run"] = removed;
          detail.push(`Pi 原生产物 ${removed} 个（${(native.freedBytes / 1024 / 1024).toFixed(1)} MB）`
            + `：slot ${native.removedSlots} 个 / turn ${native.removedTurns} 个`);
        }
      } catch { report.issues.push("Native run artifact cleanup failed; artifacts preserved."); }
    }
    if (this.options.pruneMigrationSnapshots) {
      try {
        const snapshots = this.options.pruneMigrationSnapshots();
        if (snapshots.deleted.length > 0) {
          report.removed += snapshots.deleted.length;
          report.logicalBytes += snapshots.freedBytes;
          report.byKind["migration-snapshot"] = snapshots.deleted.length;
          detail.push(`迁移快照 ${snapshots.deleted.length} 份（${(snapshots.freedBytes / 1024 / 1024).toFixed(1)} MB）：${snapshots.deleted.join(", ")}`);
        }
      } catch { report.issues.push("Migration snapshot cleanup failed; snapshots preserved."); }
    }
    if (this.options.collectPtyTmuxArtifacts) {
      try {
        const ptyReport = this.options.collectPtyTmuxArtifacts();
        const removed = (ptyReport?.removedRecords ?? 0) + (ptyReport?.removedSockets ?? 0);
        if (ptyReport && removed > 0) {
          report.removed += removed;
          report.logicalBytes += ptyReport.freedBytes;
          report.byKind["pty-tmux"] = removed;
          detail.push(`PTY tmux 产物 ${removed} 项（${(ptyReport.freedBytes / 1024 / 1024).toFixed(1)} MB）`
            + `：记录 ${ptyReport.removedRecords} 条 / socket ${ptyReport.removedSockets} 个`);
        }
      } catch { report.issues.push("PTY tmux artifact cleanup failed; artifacts preserved."); }
    }
    // 后台删除必须留痕迹：这些路径不是用户主动触发，没有日志就无法事后追溯删了什么。
    if (detail.length > 0) process.stdout.write(`[storage-cleanup] 已回收 ${detail.join("；")}\n`);
    for (const issue of report.issues) process.stdout.write(`[storage-cleanup] ${issue}\n`);
  }

  private async sweepTemporary(apply: boolean): Promise<CleanupReport> {
    const now = (this.options.now ?? Date.now)();
    const cutoff = now - STORAGE_CLEANUP_RETENTION_DAYS * DAY;
    const report: CleanupReport = { applied: apply, checkedAt: new Date(now).toISOString(), retentionDays: STORAGE_CLEANUP_RETENTION_DAYS,
      candidates: 0, removed: 0, logicalBytes: 0, allocatedBytes: 0, skipped: 0, issues: [], byKind: {} };
    const alive = this.options.isAlive ?? temporaryPidAlive;
    const active = (lease: TempLease) => alive(lease.ownerPid) || lease.children.some(child => alive(child.pid, child.group));
    let visited = 0;
    const budget = this.options.maxEntries ?? 20_000;
    const count = () => { if (++visited > budget) throw new Error("scan-limit"); };
    const stats = async (directory: string, device: number, disposableCheckout: boolean, depth = 0): Promise<TreeStats> => {
      count();
      const stat = await lstat(directory);
      if (depth > 32 || stat.dev !== device || stat.isSymbolicLink()) throw new Error("unsafe-tree");
      const result = { logicalBytes: stat.isFile() ? stat.size : 0, allocatedBytes: stat.blocks * 512,
        latest: Math.max(stat.mtimeMs, stat.ctimeMs), dev: stat.dev, ino: stat.ino };
      if (stat.isDirectory()) {
        for (const entry of await readdir(directory)) {
          if (entry === ".git" && !disposableCheckout) throw new Error("git-metadata");
          const child = await stats(path.join(directory, entry), device, disposableCheckout, depth + 1);
          result.logicalBytes += child.logicalBytes; result.allocatedBytes += child.allocatedBytes;
          result.latest = Math.max(result.latest, child.latest);
        }
      } else if (!stat.isFile()) throw new Error("special-file");
      return result;
    };
    const candidates: { root: string; directory: string; lease: TempLease; stat: TreeStats }[] = [];
    for (const root of new Set(this.options.roots)) {
      try {
        validateTemporaryRoot(root);
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          count();
          if (entry.name === TEMP_ROOT_MARKER) continue;
          const directory = path.join(root, entry.name);
          try {
            if (!entry.isDirectory()) { report.skipped++; continue; }
            const lease = readTemporaryLease(directory);
            if (active(lease)) { report.skipped++; continue; }
            const stat = await stats(directory, (await lstat(root)).dev, lease.kind === "test-run");
            if (stat.latest >= cutoff) { report.skipped++; continue; }
            candidates.push({ root, directory, lease, stat });
          } catch (error) {
            if (error instanceof Error && error.message === "scan-limit") throw error;
            report.skipped++;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        // Discovery failure never falls back to prefix-based /tmp deletion.
        report.issues.push("Temporary root unavailable, unsafe, or scan limit reached.");
        return report;
      }
    }
    report.candidates = candidates.length;
    let opened: string[] = [];
    if (apply && candidates.length) {
      try { opened = await (this.options.inspectOpenPaths ?? openPaths)(); }
      catch { report.skipped += candidates.length; report.issues.push("Open-file inspection failed; nothing removed."); return report; }
    }
    for (const candidate of candidates) {
      if (this.stopped) break;
      try {
        validateTemporaryRoot(candidate.root);
        const lease = readTemporaryLease(candidate.directory);
        if (lease.id !== candidate.lease.id || active(lease)
          || opened.some(file => file === candidate.directory || file.startsWith(candidate.directory + path.sep))) { report.skipped++; continue; }
        const latest = await stats(candidate.directory, candidate.stat.dev, lease.kind === "test-run");
        if (latest.ino !== candidate.stat.ino || latest.latest >= cutoff) { report.skipped++; continue; }
        // The final synchronous lease/PID/path check leaves no await before removal starts.
        validateTemporaryRoot(candidate.root);
        const final = readTemporaryLease(candidate.directory);
        if (final.id !== lease.id || active(final)) { report.skipped++; continue; }
        if (apply) { await rm(candidate.directory, { recursive: true, force: false }); report.removed++; }
        report.logicalBytes += latest.logicalBytes; report.allocatedBytes += latest.allocatedBytes;
        report.byKind[lease.kind] = (report.byKind[lease.kind] ?? 0) + 1;
      } catch { report.skipped++; }
    }
    return report;
  }
}

export function createStorageCleanup(configDir: string, options: Pick<CleanupOptions, "uploads" | "uploadsActive" | "onUploadRemoved" | "pruneDistributionArtifacts" | "collectNativeArtifacts" | "pruneMigrationSnapshots" | "collectPtyTmuxArtifacts"> = {}): StorageCleanup {
  const root = configTemporaryRoot(configDir);
  return new StorageCleanup({ roots: [root, systemTemporaryRoot(), testTemporaryRoot()], configDirectory: path.dirname(path.dirname(root)), ...options });
}
