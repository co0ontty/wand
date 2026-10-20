import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStorageReadonly } from "../src/storage/readonly.js";

test("read-only CLI facts wait for a transient writer lock without migrations or capability replay", { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-readonly-lock-"));
  const file = join(root, "fixture.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE app_config(key TEXT PRIMARY KEY, value TEXT); INSERT INTO app_config VALUES ('fixture', 'unchanged')");
  db.close();
  const reader = openStorageReadonly(file);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE'); process.send('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, 180);
  `, file], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); reader.close(); rmSync(root, { recursive: true, force: true }); });
  const exited = once(child, "exit");
  await once(child, "message");
  assert.equal(reader.getConfigValue("fixture"), "unchanged", "a confirmed active writer must not cause a false immediate delivery/capability failure");
  const [code] = await exited; assert.equal(code, 0);
  assert.equal(reader.getConfigValue("fixture"), "unchanged");
});
