import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("cleanup CLI previews a missing config without initialization and rejects path/flag confusion", t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-cleanup-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, "missing");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "storage:cleanup", ...args],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 20_000 });
  const preview = run(["-c", path.join(missing, "config.json")]);
  assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).applied, false);
  assert.equal(existsSync(missing), false);
  for (const args of [["--config", "--apply"], ["-c"], ["--path", "/"], ["--days", "0"]]) {
    const result = run(args); assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
  }
});
