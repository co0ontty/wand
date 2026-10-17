import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { emptyEmployeeImConfig } from "../src/employee-im-types.js";
import { migrateStorageSchema, openStorageDatabase, readStorageSchemaVersion, STORAGE_SCHEMA_VERSION } from "../src/storage-schema.js";
import { STORAGE_MIGRATIONS } from "../src/storage/migrations.js";
import { WandStorage } from "../src/storage.js";

// This complete schema was exported by the real v4 opener at commit 3bfbf35.
// Do not replace it with a fresh current DB followed by DROP TABLE: that masks
// new columns/indexes that were accidentally added to the baseline alone.
const historicalSchema = readFileSync(new URL("./fixtures/storage/schema-v4.sql", import.meta.url), "utf8");
const timestamp = "2026-01-01T00:00:00.000Z";

function fixture(t: test.TestContext, version = 4): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "wand-additive-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "wand.db");
  const db = new DatabaseSync(dbPath);
  db.exec(historicalSchema);
  db.prepare("INSERT INTO app_config (key, value) VALUES ('password', 'fixture-password')").run();
  db.prepare("INSERT INTO app_config (key, value) VALUES ('pref:taskRecordsVersion', '1')").run();
  db.prepare("INSERT INTO silicon_employees (id, name, agents_json, created_at, updated_at) VALUES ('legacy-employee', 'Historical employee', '[]', ?, ?)")
    .run(timestamp, timestamp);
  db.prepare(`INSERT INTO command_sessions (id, command, cwd, mode, status, started_at, output)
    VALUES ('legacy-session', 'fixture-command', '/fixture', 'default', 'exited', ?, 'historical output')`).run(timestamp);
  db.prepare("INSERT INTO scheduled_tasks (id, task_json, enabled, revision, next_run_at) VALUES ('legacy-schedule', '{}', 0, 1, NULL)").run();
  db.prepare("INSERT INTO scheduled_task_runs (id, task_id, scheduled_at, run_json) VALUES ('legacy-run', 'legacy-schedule', ?, ?)")
    .run(timestamp, JSON.stringify({ id: "legacy-run", taskId: "legacy-schedule", claimedAt: timestamp }));
  for (const migration of STORAGE_MIGRATIONS.filter(migration => migration.version > 4 && migration.version <= version)) {
    migration.up(db, { dataDir: dir });
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  assert.equal(readStorageSchemaVersion(db), version);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'employee_im_settings'").get(), undefined);
  db.close();
  return { dir, dbPath };
}

function backups(dir: string): string[] {
  return readdirSync(dir).filter(name => /\.pre-v\d+-.*\.bak$/.test(name));
}

function assertHistory(db: DatabaseSync): void {
  assert.equal(db.prepare("SELECT output FROM command_sessions WHERE id = 'legacy-session'").get()?.output, "historical output");
  assert.equal(db.prepare("SELECT name FROM silicon_employees WHERE id = 'legacy-employee'").get()?.name, "Historical employee");
  assert.equal(db.prepare("SELECT value FROM app_config WHERE key = 'password'").get()?.value, "fixture-password");
  assert.equal(db.prepare("SELECT count(*) AS n FROM scheduled_task_runs WHERE id = 'legacy-run'").get()?.n, 1);
}

for (const version of [4, 5, 6, 7]) {
  test(`real historical v${version} upgrades before vault queries, preserves history and reopens idempotently`, t => {
    const { dir, dbPath } = fixture(t, version);
    const storage = new WandStorage(dbPath);
    try {
      assert.deepEqual(storage.getEmployeeImConfig("legacy-employee"), emptyEmployeeImConfig());
      storage.saveEmployeeImConfig("legacy-employee", {
        events: ["task_started"], telegram: { enabled: true, botToken: `123456:${"x".repeat(30)}`, chatId: "42" }, dingtalk: { enabled: false },
      });
    } finally { storage.close(); }
    const db = new DatabaseSync(dbPath);
    assertHistory(db);
    assert.equal(readStorageSchemaVersion(db), STORAGE_SCHEMA_VERSION);
    const before = db.prepare("SELECT * FROM employee_im_settings").all();
    assert.match(String(before[0]?.credentials), /^enc:v2:/);
    for (const name of ["idx_scheduled_task_runs_claimed", "idx_scheduled_task_runs_task_claimed"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name), name);
    }
    db.close();
    assert.equal(backups(dir).length, 1);
    const backupPath = path.join(dir, backups(dir)[0]!);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(readStorageSchemaVersion(backup), version);
    assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'employee_im_settings'").get(), undefined);
    assertHistory(backup);
    backup.close();
    new WandStorage(dbPath).close();
    const reopened = new DatabaseSync(dbPath);
    assert.deepEqual(reopened.prepare("SELECT * FROM employee_im_settings").all(), before);
    assertHistory(reopened);
    reopened.close();
    assert.equal(backups(dir).length, 1, "reopening must not replay a migration or create another backup");
  });
}

function schemaObjects(db: DatabaseSync): unknown[] {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name")
    .all() as Array<{ type: string; name: string; sql: string }>;
  return objects.map(object => object.type === "table" ? {
    type: object.type, name: object.name,
    columns: db.prepare(`PRAGMA table_info("${object.name}")`).all().map(({ cid: _cid, ...column }) => column).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    foreignKeys: db.prepare(`PRAGMA foreign_key_list("${object.name}")`).all(),
  } : { ...object, sql: object.sql.replace(/\s+/g, " ").trim() });
}

test("an upgraded historical schema has the same tables, columns and indexes as a fresh install", t => {
  const { dir, dbPath } = fixture(t);
  const upgraded = openStorageDatabase(dbPath);
  const fresh = openStorageDatabase(path.join(dir, "fresh", "wand.db"));
  try { assert.deepEqual(schemaObjects(upgraded), schemaObjects(fresh)); }
  finally { upgraded.close(); fresh.close(); }
});

test("already-created IM settings and ciphertext survive the missing versioned migration", t => {
  const { dir, dbPath } = fixture(t, 7);
  const migration = STORAGE_MIGRATIONS.find(migration => migration.name === "employee-im-settings");
  assert.ok(migration, "employee IM needs its own registered migration, not just baseline SQL");
  const db = new DatabaseSync(dbPath);
  migration.up(db, { dataDir: dir });
  db.prepare("INSERT INTO employee_im_settings (employee_id, config_json, credentials) VALUES ('legacy-employee', ?, ?)")
    .run('{"events":[],"telegram":{"enabled":false},"dingtalk":{"enabled":false}}', "enc:v2:fixture-opaque-must-not-change");
  const before = db.prepare("SELECT * FROM employee_im_settings").all();
  db.close();
  const migrated = openStorageDatabase(dbPath);
  assert.deepEqual(migrated.prepare("SELECT * FROM employee_im_settings").all(), before);
  assert.equal(readStorageSchemaVersion(migrated), STORAGE_SCHEMA_VERSION);
  migrated.close();
});

test("a failed IM migration rolls back DDL and version, reports its cause and keeps the original backup", t => {
  const { dbPath, dir } = fixture(t, 7);
  const db = new DatabaseSync(dbPath);
  const originalExec = db.exec.bind(db);
  db.exec = sql => {
    originalExec(sql);
    if (sql.includes("CREATE TABLE IF NOT EXISTS employee_im_settings")) throw new Error("injected IM migration failure");
  };
  try {
    assert.throws(() => migrateStorageSchema(db, { dbPath }), /storage migration v8 \(employee-im-settings\) failed: injected IM migration failure/);
    assert.equal(readStorageSchemaVersion(db), 7);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'employee_im_settings'").get(), undefined);
    assertHistory(db);
    assert.equal(backups(dir).length, 1);
    db.exec = originalExec;
    migrateStorageSchema(db, { dbPath });
    assert.equal(readStorageSchemaVersion(db), STORAGE_SCHEMA_VERSION);
    assertHistory(db);
  } finally { db.close(); }
});

async function child(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const processChild = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, WAND_SHELL_ENV_DISABLE: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  let stdout = "", stderr = "";
  processChild.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  processChild.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("the actual wand init entry upgrades an old database and succeeds twice without resetting it", async t => {
  const { dbPath, dir } = fixture(t, 6);
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, "{}\n");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await child(["--import", "tsx", "src/cli.ts", "init", "-c", configPath]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /SQLite database ready/);
  }
  const db = new DatabaseSync(dbPath);
  assertHistory(db);
  assert.equal(readStorageSchemaVersion(db), STORAGE_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT count(*) AS n FROM employee_im_settings").get()?.n, 0);
  db.close();
  assert.equal(backups(dir).length, 1);
});

test("concurrent old-database openers both finish after the schema migration", async t => {
  const { dbPath } = fixture(t, 6);
  const args = ["--import", "tsx", "--input-type=module", "-e", `
    import { WandStorage } from "./src/storage.ts";
    const storage = new WandStorage(process.argv[1]);
    storage.getEmployeeImConfig("legacy-employee");
    storage.close();
  `, dbPath];
  const results = await Promise.all([child(args), child(args)]);
  assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.stderr).join("\n"));
  const db = new DatabaseSync(dbPath);
  assert.equal(readStorageSchemaVersion(db), STORAGE_SCHEMA_VERSION);
  assertHistory(db);
  db.close();
});
