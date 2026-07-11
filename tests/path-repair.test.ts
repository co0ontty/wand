import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deepRepairRuntimePath, type PathRepairResult } from "../src/path-repair.js";

test("deepRepairRuntimePath follows login shell order for existing CLI directories", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-path-repair-"));
  const oldBin = path.join(root, "nvm-bin");
  const preferredBin = path.join(root, "homebrew-bin");
  const serviceOnlyBin = path.join(root, "service-only-bin");
  mkdirSync(oldBin);
  mkdirSync(preferredBin);
  mkdirSync(serviceOnlyBin);

  const makeExecutable = (file: string, body: string): void => {
    writeFileSync(file, body, "utf8");
    chmodSync(file, 0o755);
  };
  makeExecutable(path.join(oldBin, "codex"), "#!/bin/sh\necho old\n");
  makeExecutable(path.join(preferredBin, "codex"), "#!/bin/sh\necho preferred\n");

  const probeShell = path.join(root, "probe-shell");
  makeExecutable(probeShell, [
    "#!/bin/sh",
    "printf 'PATH\\037%s\\n' \"$WAND_TEST_LOGIN_PATH\"",
    "printf 'CODEX\\037%s\\n' \"$WAND_TEST_CODEX\"",
  ].join("\n") + "\n");

  const originalPath = process.env.PATH;
  const originalLoginPath = process.env.WAND_TEST_LOGIN_PATH;
  const originalCodex = process.env.WAND_TEST_CODEX;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLoginPath === undefined) delete process.env.WAND_TEST_LOGIN_PATH;
    else process.env.WAND_TEST_LOGIN_PATH = originalLoginPath;
    if (originalCodex === undefined) delete process.env.WAND_TEST_CODEX;
    else process.env.WAND_TEST_CODEX = originalCodex;
    rmSync(root, { recursive: true, force: true });
  });

  process.env.PATH = [oldBin, preferredBin, serviceOnlyBin, "/usr/bin", "/bin"].join(path.delimiter);
  process.env.WAND_TEST_LOGIN_PATH = [preferredBin, oldBin, "/usr/bin", "/bin"].join(path.delimiter);
  process.env.WAND_TEST_CODEX = path.join(preferredBin, "codex");

  const initial: PathRepairResult = {
    added: [],
    resolved: { claude: null, codex: path.join(oldBin, "codex") },
    finalPath: process.env.PATH,
    deepProbe: "skipped",
    warnings: [],
  };
  // The full suite runs test files in parallel; leave enough headroom for process startup
  // on a busy machine so this integration-style shell probe does not become flaky.
  const result = await deepRepairRuntimePath(initial, { shell: probeShell, timeoutMs: 5_000 });
  const segments = result.finalPath.split(path.delimiter);

  assert.equal(segments[0], preferredBin);
  assert.equal(segments[1], oldBin);
  assert.ok(segments.indexOf(serviceOnlyBin) > segments.indexOf(oldBin));
  assert.equal(result.resolved.codex, path.join(preferredBin, "codex"));
  assert.deepEqual(result.added, []);
  assert.equal(result.deepProbe, "success");
});
