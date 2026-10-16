import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TEMP_LEASE, TEMP_ROOT_MARKER, createManagedTemporary, readTemporaryLease, registerTemporaryChild } from "../src/managed-temp.ts";
import { StorageCleanup } from "../src/storage-cleanup.ts";

const DAY = 86_400_000;
function fixture(t: { after(fn: () => void): void }) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wand-cleanup-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "managed");
  const temporary = createManagedTemporary("speech-voice", root);
  writeFileSync(path.join(temporary.directory, "audio.wav"), "audio");
  return { base, root, temporary, options: { roots: [root], now: () => Date.now() + 14 * DAY,
    isAlive: (_pid: number, _group?: boolean) => false, inspectOpenPaths: async () => [] as string[] } };
}

test("preview preserves all files; apply reclaims only leased expired temporaries with accurate stats", async t => {
  const h = fixture(t); const cleanup = new StorageCleanup(h.options);
  const user = path.join(h.base, "sessions", "messages.json"); mkdirSync(path.dirname(user)); writeFileSync(user, "history");
  mkdirSync(path.join(h.root, "speech-voice-unowned")); writeFileSync(path.join(h.root, "speech-voice-unowned", "important"), "keep");
  const preview = await cleanup.run();
  assert.equal(preview.candidates, 1); assert.equal(preview.removed, 0); assert.ok(preview.logicalBytes >= 5);
  assert.ok(existsSync(h.temporary.directory)); assert.equal(cleanup.status().lastRun, null);
  const removed = await cleanup.run(true);
  assert.equal(removed.removed, 1); assert.equal(removed.allocatedBytes, preview.allocatedBytes);
  assert.equal(existsSync(h.temporary.directory), false); assert.ok(existsSync(user));
  assert.ok(existsSync(path.join(h.root, "speech-voice-unowned", "important")));
  assert.equal(cleanup.status().lastRun?.removed, 1);
});

test("live owner, child and surviving child process group protect files even after seven days", async t => {
  const h = fixture(t); const lease = readTemporaryLease(h.temporary.directory);
  lease.children = [{ pid: 55555, group: true }]; writeFileSync(path.join(h.temporary.directory, TEMP_LEASE), JSON.stringify(lease));
  for (const alive of [(pid: number) => pid === process.pid, (pid: number, group?: boolean) => pid === 55555 && group === true]) {
    const result = await new StorageCleanup({ ...h.options, isAlive: alive }).run(true);
    assert.equal(result.removed, 0); assert.ok(existsSync(h.temporary.directory));
  }
});

test("fresh deep content retains an old directory and failed open-file checks remove nothing", async t => {
  const h = fixture(t);
  const fresh = new Date(h.options.now() - DAY); utimesSync(path.join(h.temporary.directory, "audio.wav"), fresh, fresh);
  assert.equal((await new StorageCleanup(h.options).run(true)).removed, 0);
  utimesSync(path.join(h.temporary.directory, "audio.wav"), new Date(), new Date());
  const report = await new StorageCleanup({ ...h.options, inspectOpenPaths: async () => { throw new Error("denied"); } }).run(true);
  assert.equal(report.removed, 0); assert.match(report.issues.join(), /Open-file/); assert.ok(existsSync(h.temporary.directory));
});

test("open file or cwd protects abandoned files; reactivation during inspection also protects them", async t => {
  const h = fixture(t);
  for (const opened of [h.temporary.directory, path.join(h.temporary.directory, "audio.wav")]) {
    assert.equal((await new StorageCleanup({ ...h.options, inspectOpenPaths: async () => [opened] }).run(true)).removed, 0);
  }
  const cleanup = new StorageCleanup({ ...h.options, inspectOpenPaths: async () => {
    const fresh = new Date(h.options.now()); utimesSync(path.join(h.temporary.directory, "audio.wav"), fresh, fresh); return [];
  } });
  assert.equal((await cleanup.run(true)).removed, 0); assert.ok(existsSync(h.temporary.directory));
});

test("symlinks, nested Git, malformed leases, public roots and scan overflow fail closed", async t => {
  const h = fixture(t); const outside = path.join(h.base, "valuable"); writeFileSync(outside, "keep");
  symlinkSync(outside, path.join(h.temporary.directory, "redirect"));
  assert.equal((await new StorageCleanup(h.options).run(true)).removed, 0);
  rmSync(path.join(h.temporary.directory, "redirect")); mkdirSync(path.join(h.temporary.directory, ".git"));
  assert.equal((await new StorageCleanup(h.options).run(true)).removed, 0);
  rmSync(path.join(h.temporary.directory, ".git"), { recursive: true });
  const lease = readFileSync(path.join(h.temporary.directory, TEMP_LEASE));
  writeFileSync(path.join(h.temporary.directory, TEMP_LEASE), "{}");
  assert.equal((await new StorageCleanup(h.options).run(true)).removed, 0);
  writeFileSync(path.join(h.temporary.directory, TEMP_LEASE), lease);
  if (process.platform !== "win32") {
    chmodSync(h.root, 0o755); assert.equal((await new StorageCleanup(h.options).run(true)).removed, 0); chmodSync(h.root, 0o700);
  }
  assert.equal((await new StorageCleanup({ ...h.options, maxEntries: 1 }).run(true)).removed, 0);
  assert.ok(existsSync(outside)); assert.ok(existsSync(h.temporary.directory));
});

test("lease and root symlink substitution are refused without following user data", async t => {
  const h = fixture(t);
  const lease = path.join(h.temporary.directory, TEMP_LEASE), backup = path.join(h.base, "lease");
  writeFileSync(backup, readFileSync(lease)); rmSync(lease); symlinkSync(backup, lease);
  assert.equal((await new StorageCleanup(h.options).run(true)).removed, 0);
  assert.equal(h.temporary.close(), false);
  const redirect = path.join(h.base, "root-link"); symlinkSync(h.root, redirect);
  assert.throws(() => createManagedTemporary("speech-voice", redirect), /symbolic link/);
  assert.equal((await new StorageCleanup({ ...h.options, roots: [redirect] }).run(true)).removed, 0);
});

test("explicitly disposable test and installer checkouts can be reclaimed; other temporary purposes retain Git", async t => {
  const h = fixture(t);
  for (const kind of ["test-run", "speech-setup"] as const) {
    const temp = createManagedTemporary(kind, h.root);
    mkdirSync(path.join(temp.directory, ".git")); writeFileSync(path.join(temp.directory, ".git", "config"), "fixture or fixed installer clone");
  }
  mkdirSync(path.join(h.temporary.directory, ".git"));
  const report = await new StorageCleanup(h.options).run(true);
  assert.equal(report.removed, 2); assert.equal(report.byKind["test-run"], 1); assert.equal(report.byKind["speech-setup"], 1);
  assert.ok(existsSync(h.temporary.directory));
});

test("normal completion cleans immediately; live child retains files and lease registration validates owner", t => {
  const h = fixture(t);
  registerTemporaryChild(h.temporary.directory, process.pid);
  assert.equal(h.temporary.close(), false);
  const lease = readTemporaryLease(h.temporary.directory); lease.children = [];
  writeFileSync(path.join(h.temporary.directory, TEMP_LEASE), JSON.stringify(lease));
  assert.equal(h.temporary.close(), true); assert.equal(h.temporary.close(), true);
  assert.ok(existsSync(path.join(h.root, TEMP_ROOT_MARKER)));
});

test("one worker owns a sweep; stopping waits for inspection and prevents late deletion", async t => {
  const h = fixture(t);
  let finish!: (paths: string[]) => void, reached!: () => void;
  const inspected = new Promise<void>(resolve => { reached = resolve; });
  const cleanup = new StorageCleanup({ ...h.options, inspectOpenPaths: () => { reached(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = cleanup.run(true); await inspected;
  await assert.rejects(cleanup.run(true), /busy/);
  const stop = cleanup.stop(); finish([]); await stop; await pending;
  assert.ok(existsSync(h.temporary.directory)); assert.equal(cleanup.status().running, false);
  await assert.rejects(cleanup.run(), /stopping/);
});
