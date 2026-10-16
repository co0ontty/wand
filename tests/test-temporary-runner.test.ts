import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("project test runner isolates leaked fixtures and cleans them on success and failure", t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-runner-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = path.join(root, "receipt"), fixture = path.join(root, "example.test.mjs");
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const fail of [false, true]) {
    writeFileSync(fixture, `import test from 'node:test'; import {mkdirSync,writeFileSync} from 'node:fs'; import os from 'node:os'; import path from 'node:path';
      test('fixture',()=>{const root=os.tmpdir();writeFileSync(${JSON.stringify(receipt)},root);mkdirSync(path.join(root,'left-behind'));if(${fail})throw new Error('expected fixture failure');});`);
    let failed = false;
    try { execFileSync(process.execPath, ["scripts/run-tests.js", fixture], { cwd: path.resolve(import.meta.dirname, ".."), env, stdio: "pipe", timeout: 20_000 }); }
    catch { failed = true; }
    assert.equal(failed, fail);
    const temporary = readFileSync(receipt, "utf8"); assert.match(path.basename(temporary), /^test-run-/);
    assert.equal(existsSync(temporary), false);
  }
});
