#!/usr/bin/env node
// Read only: reject an incompatible deployment before stopping the current service.
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

try {
  const [packageRoot, configPath] = process.argv.slice(2);
  if (!packageRoot || !configPath) throw new Error("缺少包目录或配置路径");
  const root = path.resolve(packageRoot);
  const [{ STORAGE_SCHEMA_VERSION }, { resolveDatabasePath }] = await Promise.all([
    import(pathToFileURL(path.join(root, "dist/storage-schema.js")).href),
    import(pathToFileURL(path.join(root, "dist/storage/internal.js")).href),
  ]);
  if (!Number.isSafeInteger(STORAGE_SCHEMA_VERSION) || STORAGE_SCHEMA_VERSION < 1) {
    throw new Error("无法确认目标程序支持的数据库版本");
  }
  const dbPath = resolveDatabasePath(path.resolve(configPath));
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const { user_version: version } = db.prepare("PRAGMA user_version").get();
      if (version > STORAGE_SCHEMA_VERSION) {
        throw new Error(`数据库 v${version} 高于目标程序支持的 v${STORAGE_SCHEMA_VERSION}，请先补齐迁移代码再部署`);
      }
      console.log(`[wand] 数据库兼容性检查通过：v${version}，目标支持 v${STORAGE_SCHEMA_VERSION}`);
    } finally {
      db.close();
    }
  }
} catch (error) {
  console.error(`[wand] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
