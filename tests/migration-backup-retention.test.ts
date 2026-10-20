import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_MIGRATION_BACKUP_KEEP, pruneMigrationBackups } from "../src/migration-backup-retention.js";

const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-migration-backup-"));
  const dbPath = path.join(root, "wand.db");
  writeFileSync(dbPath, "live-database");
  return { root, dbPath };
}

/** 写一份迁移快照，并把它做旧 ageDays 天。 */
function writeBackup(root: string, name: string, ageDays: number, body = "backup"): string {
  const filePath = path.join(root, name);
  writeFileSync(filePath, body);
  const stamp = new Date(Date.now() - ageDays * DAY);
  utimesSync(filePath, stamp, stamp);
  return filePath;
}

test("pruneMigrationBackups keeps the newest N snapshots and always keeps this run's backup", () => {
  const { root, dbPath } = fixture();
  try {
    const oldest = writeBackup(root, "wand.db.pre-v8-2026-10-01T00-00-00-000Z-aaaaaa.bak", 30);
    const middle = writeBackup(root, "wand.db.pre-v9-2026-10-10T00-00-00-000Z-bbbbbb.bak", 20);
    const newer = writeBackup(root, "wand.db.pre-v10-2026-10-15T00-00-00-000Z-cccccc.bak", 10);
    const newest = writeBackup(root, "wand.db.pre-v11-2026-10-18T00-00-00-000Z-dddddd.bak", 1);

    const result = pruneMigrationBackups(dbPath);

    // 默认保留最近 2 份。
    assert.equal(DEFAULT_MIGRATION_BACKUP_KEEP, 2);
    assert.deepEqual(result.deleted.sort(), [path.basename(oldest), path.basename(middle)].sort());
    assert.deepEqual(readdirSync(root).sort(), [
      "wand.db",
      path.basename(newer),
      path.basename(newest),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneMigrationBackups always keeps keepPath even when it is the oldest", () => {
  const { root, dbPath } = fixture();
  try {
    // 本次迁移刚生成的这份，因为文件名里时间戳排序等原因可能最旧，必须保留。
    const keep = writeBackup(root, "wand.db.pre-v11-2026-09-01T00-00-00-000Z-eeeeee.bak", 60);
    writeBackup(root, "wand.db.pre-v12-2026-10-17T00-00-00-000Z-ffffff.bak", 2);
    writeBackup(root, "wand.db.pre-v13-2026-10-18T00-00-00-000Z-111111.bak", 1);

    const result = pruneMigrationBackups(dbPath, { keepPath: keep });

    assert.ok(readdirSync(root).includes(path.basename(keep)));
    assert.ok(result.kept.includes(path.basename(keep)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneMigrationBackups never touches the live database, other backups or unrelated files", () => {
  const { root, dbPath } = fixture();
  try {
    writeBackup(root, "wand.db.pre-v8-2026-10-01T00-00-00-000Z-aaaaaa.bak", 30);
    writeBackup(root, "wand.db.pre-v9-2026-10-10T00-00-00-000Z-bbbbbb.bak", 20);
    writeBackup(root, "wand.db.pre-v10-2026-10-15T00-00-00-000Z-cccccc.bak", 10);
    writeBackup(root, "wand.db.pre-v11-2026-10-18T00-00-00-000Z-dddddd.bak", 1);
    // 人工恢复点、配置快照、普通备份都不在清理范围。
    writeBackup(root, "wand.db.pre-organization-baseline-repair-2026-10-15T16-30-42-485Z.bak", 40);
    writeBackup(root, "config.json.before-ios-adhoc-20261016", 40);
    writeBackup(root, "before-purge-archived-20261007203336.db", 40);

    pruneMigrationBackups(dbPath);

    const remaining = readdirSync(root).sort();
    assert.ok(remaining.includes("wand.db"));
    assert.ok(remaining.includes("config.json.before-ios-adhoc-20261016"));
    assert.ok(remaining.includes("before-purge-archived-20261007203336.db"));
    // 人工命名的迁移前快照保留最近一份。
    assert.ok(remaining.includes("wand.db.pre-organization-baseline-repair-2026-10-15T16-30-42-485Z.bak"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneMigrationBackups dryRun reports candidates without deleting anything", () => {
  const { root, dbPath } = fixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      writeBackup(root, `wand.db.pre-v${index + 5}-2026-10-0${index + 1}T00-00-00-000Z-aaaaa${index}.bak`, 30 - index * 5, "x".repeat(100));
    }
    const before = readdirSync(root).length;

    const result = pruneMigrationBackups(dbPath, { dryRun: true });

    assert.equal(readdirSync(root).length, before);
    assert.ok(result.deleted.length > 0);
    assert.ok(result.freedBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneMigrationBackups refuses symlinked snapshots", () => {
  const { root, dbPath } = fixture();
  try {
    // 目标文件不是迁移快照命名，不会被当作候选。
    const target = path.join(root, "elsewhere.bak");
    writeFileSync(target, "outside");
    writeBackup(root, "wand.db.pre-v9-2026-10-10T00-00-00-000Z-bbbbbb.bak", 30);
    writeBackup(root, "wand.db.pre-v10-2026-10-15T00-00-00-000Z-cccccc.bak", 20);
    writeBackup(root, "wand.db.pre-v11-2026-10-18T00-00-00-000Z-dddddd.bak", 10);
    // 用一个指向外部文件的符号链接冒充旧快照：不能被删，更不能顺着链接删目标。
    const link = path.join(root, "wand.db.pre-v7-2026-09-01T00-00-00-000Z-eeeeee.bak");
    symlinkSync(target, link);

    pruneMigrationBackups(dbPath);

    assert.ok(readdirSync(root).includes(path.basename(link)));
    assert.ok(readdirSync(root).includes(path.basename(target)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneMigrationBackups is a no-op when the directory has no snapshots", () => {
  const { root, dbPath } = fixture();
  try {
    const result = pruneMigrationBackups(dbPath);
    assert.deepEqual(result, { deleted: [], freedBytes: 0, kept: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
