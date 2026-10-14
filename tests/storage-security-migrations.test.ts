import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { encryptVaultSecret, hashAdminPassword, isVaultSecretV2, VaultDecryptError, verifyAdminPassword } from "../src/password-manager.js";
import { openStorageDatabase, readStorageSchemaVersion, STORAGE_SCHEMA_VERSION } from "../src/storage-schema.js";
import { openStorageReadonly } from "../src/storage/readonly.js";
import { WandStorage } from "../src/storage.js";

function tempDb(t: { after: (fn: () => void) => void }): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-secmig-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: path.join(dir, "wand.db") };
}

function runMigrationChild(dbPath: string, readyFile: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { openStorageDatabase } from "./src/storage-schema.ts";
    import { writeFileSync } from "node:fs";
    const dbPath = process.argv[1];
    const readyFile = process.argv[2];
    writeFileSync(readyFile, "ready");
    try {
      const db = openStorageDatabase(dbPath);
      db.close();
      process.stdout.write("opened\\n");
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error) + "\\n");
      process.exitCode = 1;
    }
  `, dbPath, readyFile], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("admin password hash helper verifies supported scrypt and legacy plaintext", () => {
  const stored = hashAdminPassword("correct horse");
  assert.match(stored, /^scrypt\$/);
  assert.equal(stored.includes("correct horse"), false);
  assert.equal(verifyAdminPassword("correct horse", stored), true);
  assert.equal(verifyAdminPassword("wrong horse", stored), false);
  // Legacy plaintext rows still verify, so an upgrade never locks the owner out.
  assert.equal(verifyAdminPassword("legacy-pass", "legacy-pass"), true);
  assert.equal(verifyAdminPassword("legacy-pass!", "legacy-pass"), false);
  assert.equal(verifyAdminPassword("anything", null), false);
  // A tampered local hash cannot choose a cheaper or unbounded scrypt cost.
  assert.equal(verifyAdminPassword("anything", "scrypt$1$8$1$YWJj$YWJj"), false);
});

test("vault key lives in a 0600 file outside the database and secrets are v2 ciphertext", (t) => {
  const { dbPath, dir } = tempDb(t);
  const storage = new WandStorage(dbPath);
  storage.saveConnector("openrouter", { token: "sk-or-secret-123", apiUrl: "" });
  storage.close();

  const keyFile = path.join(dir, "wand-vault.key");
  assert.equal(existsSync(keyFile), true);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);

  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT token FROM connectors WHERE provider = 'openrouter'").get() as { token: string };
  db.close();
  assert.equal(isVaultSecretV2(row.token), true);
  assert.equal(row.token.includes("sk-or-secret-123"), false);

  chmodSync(keyFile, 0o644);
  const readonly = openStorageReadonly(dbPath);
  assert.equal(readonly.getConnectorToken("openrouter"), "sk-or-secret-123");
  readonly.close();
  assert.equal(statSync(keyFile).mode & 0o777, 0o644, "readonly key reads do not repair or change file permissions");
  const reopened = new WandStorage(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.getConnectorToken("openrouter"), "sk-or-secret-123");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, "loading an existing key repairs overly broad permissions");
});

test("legacy v1 and plaintext connector tokens are re-encrypted transparently on open", (t) => {
  const { dbPath } = tempDb(t);
  const seed = new WandStorage(dbPath);
  seed.close();
  const db = new DatabaseSync(dbPath);
  const appSecret = "a".repeat(64);
  db.prepare("INSERT INTO app_config (key, value) VALUES ('appSecret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(appSecret);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO connectors (provider, token, api_url, created_at, updated_at) VALUES ('legacy-v1', ?, '', ?, ?)")
    .run(encryptVaultSecret("v1-token-value", appSecret), now, now);
  db.prepare("INSERT INTO connectors (provider, token, api_url, created_at, updated_at) VALUES ('legacy-plain', 'plain-token', '', ?, ?)")
    .run(now, now);
  db.close();

  const storage = new WandStorage(dbPath);
  t.after(() => storage.close());
  assert.equal(storage.getConnectorToken("legacy-v1"), "v1-token-value");
  assert.equal(storage.getConnectorToken("legacy-plain"), "plain-token");
  const after = new DatabaseSync(dbPath);
  const rows = after.prepare("SELECT provider, token FROM connectors WHERE provider IN ('legacy-v1','legacy-plain')").all() as Array<{ provider: string; token: string }>;
  after.close();
  for (const row of rows) assert.equal(isVaultSecretV2(row.token), true, row.provider);
});

test("a missing key file makes encrypted secrets fail loudly instead of reading as empty", (t) => {
  const { dbPath, dir } = tempDb(t);
  const storage = new WandStorage(dbPath);
  storage.saveConnector("openrouter", { token: "kept-secret" });
  storage.close();
  unlinkSync(path.join(dir, "wand-vault.key"));

  const reopened = new WandStorage(dbPath);
  t.after(() => reopened.close());
  assert.throws(() => reopened.getConnectorToken("openrouter"), (error: unknown) =>
    error instanceof VaultDecryptError && error.reason === "missing-key");
  assert.throws(() => reopened.saveConnector("another", { token: "must-not-create-new-key" }), (error: unknown) =>
    error instanceof VaultDecryptError && error.reason === "missing-key");
  assert.equal(existsSync(path.join(dir, "wand-vault.key")), false, "lost key must never be silently replaced");
});

test("auth tokens are stored as SHA-256 digests and lookups still succeed", (t) => {
  const { dbPath } = tempDb(t);
  const storage = new WandStorage(dbPath);
  t.after(() => storage.close());
  storage.saveAuthSession("raw-token-abc", Date.now() + 60_000);
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT token FROM auth_sessions").all() as Array<{ token: string }>;
  db.close();
  assert.deepEqual(rows.map((row) => row.token), [createHash("sha256").update("raw-token-abc").digest("hex")]);
  assert.ok(storage.getAuthSession("raw-token-abc"));
  storage.deleteAuthSession("raw-token-abc");
  assert.equal(storage.getAuthSession("raw-token-abc"), null);
});

test("a failed migration rolls back its step and retains the pre-migration backup", (t) => {
  const { dbPath, dir } = tempDb(t);
  new WandStorage(dbPath).close();
  const seed = new DatabaseSync(dbPath);
  seed.exec("PRAGMA user_version = 1");
  seed.prepare("DELETE FROM app_config WHERE key = 'pref:taskRecordsVersion'").run();
  seed.exec(`INSERT INTO workspaces (id, name, cwd, kind, created_at) VALUES ('failure-workspace', 'Failure', '/tmp/failure', 'project', '2026-01-01T00:00:00.000Z')`);
  seed.exec(`INSERT INTO workspace_tasks (id, workspace_id, name, status, created_at) VALUES ('failure-container', 'failure-workspace', 'Unlinked', 'active', '2026-01-01T00:00:00.000Z')`);
  seed.exec(`CREATE TRIGGER reject_migration_card BEFORE INSERT ON wand_tasks BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
  seed.close();

  assert.throws(() => openStorageDatabase(dbPath), /storage migration v2.*injected migration failure/);
  const verify = new DatabaseSync(dbPath);
  assert.equal(readStorageSchemaVersion(verify), 1);
  assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM wand_tasks").get() as { count: number }).count, 0);
  verify.close();
  const backups = readdirSync(dir).filter((name) => name.includes(".pre-v1-") && name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(dir, backups[0]!));
  assert.equal(readStorageSchemaVersion(backup), 1);
  assert.equal((backup.prepare("SELECT COUNT(*) AS count FROM wand_tasks").get() as { count: number }).count, 0);
  backup.close();
});

test("concurrent processes serialize pending migrations and preserve one backfill result", async (t) => {
  const { dbPath, dir } = tempDb(t);
  new WandStorage(dbPath).close();
  const seed = new DatabaseSync(dbPath);
  seed.exec("PRAGMA user_version = 1");
  seed.prepare("DELETE FROM app_config WHERE key = 'pref:taskRecordsVersion'").run();
  seed.exec(`INSERT INTO workspaces (id, name, cwd, kind, created_at) VALUES ('concurrent-workspace', 'Concurrent', '/tmp/concurrent', 'project', '2026-01-01T00:00:00.000Z')`);
  seed.exec(`INSERT INTO workspace_tasks (id, workspace_id, name, status, created_at) VALUES ('concurrent-container', 'concurrent-workspace', 'Unlinked', 'active', '2026-01-01T00:00:00.000Z')`);
  seed.close();

  const readyFiles = [path.join(dir, "first.ready"), path.join(dir, "second.ready")];
  const results = [runMigrationChild(dbPath, readyFiles[0]!), runMigrationChild(dbPath, readyFiles[1]!)];
  const deadline = Date.now() + 10_000;
  while (!readyFiles.every(existsSync) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(readyFiles.every(existsSync), "both child processes reached the migration barrier");
  const outcomes = await Promise.all(results);
  assert.deepEqual(outcomes.map(({ code }) => code), [0, 0], outcomes.map(({ stderr }) => stderr).join("\\n"));
  assert.ok(outcomes.every(({ stdout }) => stdout.includes("opened")));

  const verify = new DatabaseSync(dbPath);
  assert.equal(readStorageSchemaVersion(verify), STORAGE_SCHEMA_VERSION);
  assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM wand_tasks WHERE workspace_task_id = 'concurrent-container'").get() as { count: number }).count, 1);
  verify.close();
  assert.ok(readdirSync(dir).some((name) => name.includes(".pre-v1-") && name.endsWith(".bak")));
});

test("pending migrations take a 0600 backup first, and a newer database is refused unchanged", (t) => {
  const { dbPath, dir } = tempDb(t);
  new WandStorage(dbPath).close();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 2");
  db.close();

  const opened = openStorageDatabase(dbPath);
  assert.equal(readStorageSchemaVersion(opened), STORAGE_SCHEMA_VERSION);
  opened.close();
  const backups = readdirSync(dir).filter((name) => name.includes(".pre-v2-") && name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(statSync(path.join(dir, backups[0]!)).mode & 0o777, 0o600);

  const future = new DatabaseSync(dbPath);
  future.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION + 5}`);
  future.prepare("INSERT INTO app_config (key, value) VALUES ('future-sentinel', 'untouched')").run();
  future.close();
  assert.throws(() => openStorageDatabase(dbPath), /newer than this build.*refusing to open/);
  const verify = new DatabaseSync(dbPath);
  assert.equal(readStorageSchemaVersion(verify), STORAGE_SCHEMA_VERSION + 5);
  assert.equal((verify.prepare("SELECT value FROM app_config WHERE key = 'future-sentinel'").get() as { value: string }).value, "untouched");
  verify.close();
  assert.equal(readdirSync(dir).filter((name) => name.includes(".pre-v9-")).length, 0);
});
