import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WandStorage } from "../src/storage.ts";
import type { SessionSnapshot } from "../src/types.ts";
import { StorageCleanup } from "../src/storage-cleanup.ts";
import { openUploadCleanupStore } from "../src/storage/uploads-repository.ts";
import { STORAGE_SCHEMA_VERSION } from "../src/storage-schema.js";

const DAY = 86_400_000;
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wand-owned-uploads-test-")));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const cwd = path.join(root, "user-project"), file = path.join(cwd, ".wand-uploads", "owned.txt");
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "owned upload");
  const stat = lstatSync(file);
  storage.recordManagedUpload({ filePath: file, canonicalPath: file, cwd, canonicalCwd: cwd, sessionId: "owner",
    device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, createdAt: Date.now() });
  let now = Date.now();
  const options = { roots: [], uploads: storage.uploads, now: () => now, inspectOpenPaths: async () => [] as string[] };
  const session = (id: string, overrides: Partial<SessionSnapshot> = {}) => ({ id, sessionSource: "interactive", command: "test",
    cwd, mode: "managed", status: "stopped", exitCode: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    output: "", archived: false, archivedAt: null, claudeSessionId: null, ...overrides } as SessionSnapshot);
  return { root, storage, cwd, file, options, session, advance: () => { now += 8 * DAY; } };
}

test("npm-user uploads retain their owner; orphan retention starts when observed and survives restart", async t => {
  const h = fixture(t); h.storage.saveSession(h.session("owner"));
  const cleanup = new StorageCleanup(h.options);
  assert.equal((await cleanup.run(true)).removed, 0);
  h.storage.deleteSession("owner");
  assert.equal((await cleanup.run()).candidates, 0); assert.equal(h.storage.listManagedUploads()[0]!.orphanedAt, null);
  assert.equal((await cleanup.run(true)).removed, 0); assert.notEqual(h.storage.listManagedUploads()[0]!.orphanedAt, null);
  h.advance();
  const readonly = openUploadCleanupStore(path.join(h.root, "wand.db"))!;
  assert.equal(readonly.uploads.listManagedUploads().length, 1); readonly.close();
  const preview = await cleanup.run(); assert.equal(preview.candidates, 1); assert.equal(preview.byKind.upload, 1);
  assert.ok(readFileSync(h.file).length);
  const report = await cleanup.run(true); assert.equal(report.removed, 1); assert.equal(h.storage.listManagedUploads().length, 0);
  assert.throws(() => readFileSync(h.file), /ENOENT/);
});

test("a shared workspace, historical/queued exact reference and any active task protect upload data", async t => {
  const h = fixture(t); const cleanup = new StorageCleanup(h.options);
  await cleanup.run(true); h.advance();
  for (const overrides of [ {}, { cwd: h.root, output: `refer to ${h.file}` },
    { cwd: h.root, queuedMessages: [`refer to ${h.file}`] }, { cwd: h.root, status: "running" as const, sessionKind: "structured" as const } ]) {
    h.storage.saveSession(h.session("other", overrides));
    assert.equal((await cleanup.run(true)).removed, 0); assert.equal(h.storage.listManagedUploads()[0]!.orphanedAt, null);
    h.storage.deleteSession("other"); await cleanup.run(true); h.advance();
  }
});

test("cross-directory PTY input pins an orphan before unknown delivery; unrelated shells do not block cleanup forever", async t => {
  const h = fixture(t); const cleanup = new StorageCleanup(h.options);
  await cleanup.run(true); h.advance();
  h.storage.saveSession(h.session("pty-consumer", { cwd: h.root, status: "running" }));
  h.storage.retainManagedUploadReferences("pty-consumer", JSON.stringify({ input: `read '${h.file}'` }), h.options.now());
  assert.equal((await cleanup.run(true)).removed, 0);
  h.storage.deleteSession("pty-consumer");
  assert.equal((await cleanup.run(true)).removed, 0); h.advance();
  h.storage.saveSession(h.session("unrelated-shell", { cwd: h.root, status: "running" }));
  assert.equal((await cleanup.run(true)).removed, 1);
});

test("untracked user files, edited/replaced uploads, symlinks and failed open-file checks are preserved", async t => {
  const h = fixture(t); const cleanup = new StorageCleanup(h.options);
  const user = path.join(path.dirname(h.file), "untracked.txt"); writeFileSync(user, "user file");
  await cleanup.run(true); h.advance();
  const blocked = new StorageCleanup({ ...h.options, inspectOpenPaths: async () => { throw new Error("incomplete"); } });
  assert.equal((await blocked.run(true)).removed, 0);
  writeFileSync(h.file, "user modified upload"); assert.equal((await cleanup.run(true)).removed, 0);
  rmSync(h.file); symlinkSync(user, h.file); assert.equal((await cleanup.run(true)).removed, 0);
  assert.equal(readFileSync(user, "utf8"), "user file");
});

test("ownership records are atomic and legacy/missing databases are never initialized by the CLI store", t => {
  const h = fixture(t);
  const upload = h.storage.listManagedUploads()[0]!;
  assert.throws(() => h.storage.recordManagedUploads([{ ...upload, filePath: "first", canonicalPath: "first" }, upload]));
  assert.equal(h.storage.listManagedUploads().length, 1);
  const missing = path.join(h.root, "missing.db"); assert.equal(openUploadCleanupStore(missing), null);
  assert.throws(() => readFileSync(missing), /ENOENT/);
});

test("existing npm schema v4 upgrades upload receipts without changing sessions, preferences or vault keys", t => {
  const h = fixture(t), dbPath = path.join(h.root, "wand.db");
  h.storage.saveSession(h.session("owner", { output: "preserved historical attachment" }));
  h.storage.close();
  const key = readFileSync(path.join(h.root, "wand-vault.key"));
  const old = new DatabaseSync(dbPath);
  old.exec("DROP TABLE wand_upload_references; DROP TABLE wand_uploads; PRAGMA user_version = 4");
  old.prepare("INSERT INTO app_config(key,value) VALUES(?,?)").run("fixture-preserved-preference", "unchanged");
  const sessionBefore = old.prepare("SELECT * FROM command_sessions WHERE id='owner'").get(); old.close();
  assert.equal(openUploadCleanupStore(dbPath), null, "preview leaves the old database alone");
  const upgraded = new WandStorage(dbPath); t.after(() => upgraded.close());
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, STORAGE_SCHEMA_VERSION);
    assert.deepEqual(verify.prepare("SELECT * FROM command_sessions WHERE id='owner'").get(), sessionBefore);
    assert.equal(verify.prepare("SELECT value FROM app_config WHERE key='fixture-preserved-preference'").get()?.value, "unchanged");
  } finally { verify.close(); }
  assert.deepEqual(readFileSync(path.join(h.root, "wand-vault.key")), key);
  assert.ok(readdirSync(h.root).some(name => name.includes("pre-v4")), "existing database backed up before migration");
  assert.deepEqual(upgraded.listManagedUploads(), []);
  const receipt = { filePath: h.file, canonicalPath: h.file, cwd: h.cwd, canonicalCwd: h.cwd, sessionId: "owner",
    device: lstatSync(h.file).dev, inode: lstatSync(h.file).ino, size: lstatSync(h.file).size,
    mtimeMs: lstatSync(h.file).mtimeMs, ctimeMs: lstatSync(h.file).ctimeMs, createdAt: Date.now() };
  upgraded.recordManagedUploads([receipt]); assert.equal(upgraded.listManagedUploads().length, 1);
});
