import { readdirSync, lstatSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * 迁移前 SQLite 快照（`wand.db.pre-v<N>-<时间戳>-<随机>.bak`）的有界保留。
 *
 * 每次 schema 升级都会 `VACUUM INTO` 一份完整副本，而快照体积等于整库大小，
 * 没有上限时旧备份会无限累积。这里只做「有界保留」，不做数据清理：
 *
 * - 迁移**失败**时绝不调用（调用方保证只在迁移成功且健康检查通过后调用）；
 * - 默认保留最近 `keep` 份，外加调用方明确要求保留的那一份（刚成功这次迁移的回滚点）；
 * - 只认迁移备份的命名，不碰 `wand.db`、`backups/` 里的人工恢复点或配置快照；
 * - 删除失败不影响迁移结果。
 */

/** 迁移前快照的命名：`<db>.pre-v12-2026-10-18T09-58-41-937Z-ca8636.bak`。 */
const MIGRATION_BACKUP_PATTERN = /\.pre-v\d+-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{6}\.bak$/;
/** 人工标记的迁移前快照，例如 `pre-organization-baseline-repair-<时间戳>.bak`。 */
const MANUAL_BACKUP_PATTERN = /\.pre-(?!v\d+-)[A-Za-z0-9-]+-\d{4}-\d{2}-\d{2}T[\d-]+Z\.bak$/;

export const DEFAULT_MIGRATION_BACKUP_KEEP = 2;

export interface MigrationBackupPruneResult {
  deleted: string[];
  freedBytes: number;
  kept: string[];
}

/**
 * 保留最近若干份迁移快照。`keepPath` 是本次刚生成、必须保留的回滚点。
 *
 * `keep` 统计的是「自动迁移快照」，人工命名的快照不计入额度，单独保留最近一份，
 * 避免把开发者手工留的基线修复点一起清掉。
 */
export function pruneMigrationBackups(
  dbPath: string,
  options: { keepPath?: string | null; keep?: number; dryRun?: boolean } = {},
): MigrationBackupPruneResult {
  const result: MigrationBackupPruneResult = { deleted: [], freedBytes: 0, kept: [] };
  const keepCount = Math.max(1, options.keep ?? DEFAULT_MIGRATION_BACKUP_KEEP);
  const directory = path.dirname(dbPath);
  const base = path.basename(dbPath);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  const automatic: { name: string; filePath: string; mtimeMs: number; size: number }[] = [];
  const manual: typeof automatic = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(`${base}.pre-`)) continue;
    const filePath = path.join(directory, entry.name);
    let stat;
    try {
      stat = lstatSync(filePath);
      // 符号链接一律不碰：备份文件必须是普通文件。
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const record = { name: entry.name, filePath, mtimeMs: stat.mtimeMs, size: stat.size };
    if (MIGRATION_BACKUP_PATTERN.test(entry.name)) automatic.push(record);
    else if (MANUAL_BACKUP_PATTERN.test(entry.name)) manual.push(record);
  }
  const keepName = options.keepPath ? path.basename(options.keepPath) : null;
  const newestFirst = (a: { mtimeMs: number }, b: { mtimeMs: number }) => b.mtimeMs - a.mtimeMs;
  automatic.sort(newestFirst);
  manual.sort(newestFirst);

  const keep = new Set<string>();
  if (keepName) keep.add(keepName);
  for (const record of automatic.slice(0, keepCount)) keep.add(record.name);
  // 人工快照只留最近一份，其余按同一规则回收。
  if (manual.length > 0) keep.add(manual[0]!.name);

  for (const record of [...automatic, ...manual]) {
    if (keep.has(record.name)) { result.kept.push(record.name); continue; }
    if (options.dryRun) { result.deleted.push(record.name); result.freedBytes += record.size; continue; }
    try {
      unlinkSync(record.filePath);
      result.deleted.push(record.name);
      result.freedBytes += record.size;
    } catch {
      // 删不掉（权限/占用）就留着，下次扫描再试。
    }
  }
  return result;
}
