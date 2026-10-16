import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendBoundedDiagnostic, diagnosticReceiptMatches, DIAGNOSTIC_LOG_MAX_BYTES, DIAGNOSTIC_RECEIPT_SUFFIX } from "../src/diagnostic-logs.ts";
import { StorageCleanup } from "../src/storage-cleanup.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wand-diagnostic-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("runtime diagnostics rotate at a byte ceiling and retain at most three owned archives", t => {
  const root = fixture(t), file = path.join(root, "web.log");
  for (let i = 0; i < 8; i++) appendBoundedDiagnostic(file, String(i).repeat(8), 8);
  assert.equal(readFileSync(file, "utf8"), "77777777");
  for (let i = 1; i <= 3; i++) { assert.equal(statSync(`${file}.${i}`).size, 8); assert.ok(diagnosticReceiptMatches(`${file}.${i}`)); }
  assert.equal(existsSync(`${file}.4`), false);
  appendBoundedDiagnostic(file, Buffer.alloc(100, 97), 8); assert.equal(statSync(file).size, 8);
});

test("expired archives are reclaimed while current logs, history and changed/unowned files remain", async t => {
  const root = fixture(t), file = path.join(root, "web.log");
  for (let i = 0; i < 5; i++) appendBoundedDiagnostic(file, "12345678", 8);
  const sessions = path.join(root, "sessions", "session"); mkdirSync(sessions, { recursive: true });
  for (const name of ["pty-output.log", "stream-events.jsonl", "messages.json", "structured-stdout.log"]) writeFileSync(path.join(sessions, name), "history or current");
  const cleanup = new StorageCleanup({ roots: [], configDirectory: root, now: () => Date.now() + 20 * 86_400_000, inspectOpenPaths: async () => [] });
  assert.equal((await cleanup.run()).byKind["diagnostic-log"], 3);
  writeFileSync(`${file}.2`, "edited archive");
  const removed = await cleanup.run(true); assert.equal(removed.removed, 2);
  assert.ok(existsSync(file)); assert.ok(existsSync(`${file}.2`));
  for (const name of ["pty-output.log", "stream-events.jsonl", "messages.json", "structured-stdout.log"]) assert.ok(existsSync(path.join(sessions, name)));
});

test("symbolic links and unowned archive collisions never overwrite user files", t => {
  const root = fixture(t), file = path.join(root, "web.log"), user = path.join(root, "valuable");
  writeFileSync(user, "keep"); symlinkSync(user, file);
  assert.throws(() => appendBoundedDiagnostic(file, "data", 8)); assert.equal(readFileSync(user, "utf8"), "keep");
  rmSync(file); appendBoundedDiagnostic(file, "12345678", 8); writeFileSync(`${file}.1`, "unowned");
  assert.throws(() => appendBoundedDiagnostic(file, "next", 8)); assert.equal(readFileSync(`${file}.1`, "utf8"), "unowned");
  rmSync(`${file}.1`); writeFileSync(`${file}.1${DIAGNOSTIC_RECEIPT_SUFFIX}`, "user metadata");
  assert.throws(() => appendBoundedDiagnostic(file, "next", 8));
  assert.equal(readFileSync(`${file}.1${DIAGNOSTIC_RECEIPT_SUFFIX}`, "utf8"), "user metadata");
});

test("npm service file redirections rotate through the real stream; pipes stay ordinary stdout", t => {
  const root = fixture(t), out = path.join(root, "web.log"), err = path.join(root, "web-error.log");
  const stdout = openSync(out, "a"), stderr = openSync(err, "a");
  const code = `import {installServiceDiagnosticRotation} from './src/diagnostic-logs.ts';
    installServiceDiagnosticRotation(${JSON.stringify(root)},'web');
    process.stdout.write('x'.repeat(${DIAGNOSTIC_LOG_MAX_BYTES}));process.stdout.write('new log',()=>process.stderr.write('callback ran'));`;
  // Isolate the stream-rotation contract from tsx\'s Node 26 loader deprecation;
  // keep all other warnings visible and the exact callback assertion intact.
  const result = spawnSync(process.execPath, ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", code], { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", stdout, stderr], timeout: 20_000 });
  closeSync(stdout); closeSync(stderr); assert.equal(result.status, 0);
  assert.equal(readFileSync(out, "utf8"), "new log"); assert.equal(readFileSync(err, "utf8"), "callback ran");
  assert.equal(statSync(`${out}.1`).size, DIAGNOSTIC_LOG_MAX_BYTES);
  const pipe = spawnSync(process.execPath, ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", `import {installServiceDiagnosticRotation} from './src/diagnostic-logs.ts';installServiceDiagnosticRotation(${JSON.stringify(root)},'web');console.log('ordinary');`],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 20_000 });
  assert.equal(pipe.stdout.trim(), "ordinary");
});
