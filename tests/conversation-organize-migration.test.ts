import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openStorageDatabase, STORAGE_SCHEMA_VERSION, readStorageSchemaVersion } from "../src/storage-schema.js";
import { STORAGE_MIGRATIONS } from "../src/storage/migrations.js";

test("existing v5 databases add organization tables without dropping history, with a private backup and idempotent reopen", t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-organize-upgrade-")), file = path.join(root, "wand.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = new DatabaseSync(file);
  old.exec(readFileSync(new URL("./fixtures/storage/schema-v4.sql", import.meta.url), "utf8"));
  STORAGE_MIGRATIONS.find(migration => migration.version === 5)!.up(old, { dataDir: root });
  old.exec("CREATE TABLE existing_history (id TEXT PRIMARY KEY, body TEXT); INSERT INTO existing_history VALUES ('history','must survive'); PRAGMA user_version = 5");old.close();
  const upgraded = openStorageDatabase(file);
  assert.equal(readStorageSchemaVersion(upgraded), STORAGE_SCHEMA_VERSION);
  assert.equal(upgraded.prepare("SELECT body FROM existing_history WHERE id='history'").get()?.body, "must survive");
  assert.equal(upgraded.prepare("SELECT count(*) n FROM conversation_organization_jobs").get()?.n, 0);
  assert.equal(upgraded.prepare("SELECT count(*) n FROM conversation_organization_cache").get()?.n, 0);
  upgraded.close();
  const backups = readdirSync(root).filter(name => name.includes(".pre-v5-"));assert.equal(backups.length, 1);
  assert.equal(statSync(path.join(root, backups[0]!)).mode & 0o777, 0o600);
  const reopened = openStorageDatabase(file);reopened.close();
  assert.equal(readdirSync(root).filter(name => name.includes(".pre-v5-")).length, 1);
});
