import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  describePtySpawnFailure,
  repairSpawnHelperFile,
} from "../src/ensure-node-pty-helper.js";

test("repairSpawnHelperFile restores the executable bit in place", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pty-helper-"));
  const helper = path.join(root, "spawn-helper");
  writeFileSync(helper, "#!/bin/sh\n");
  chmodSync(helper, 0o644);

  try {
    const repaired = repairSpawnHelperFile(helper);
    assert.equal(repaired.copied, false);
    assert.equal(repaired.helperPath, helper);
    assert.equal(statSync(helper).mode & 0o111, 0o111);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repairSpawnHelperFile copies the helper when chmod is denied", (t) => {
  if (process.platform !== "darwin") {
    t.skip("chflags uchg is macOS-only");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pty-helper-copy-"));
  const helper = path.join(root, "spawn-helper");
  writeFileSync(helper, "#!/bin/sh\necho ok\n");
  chmodSync(helper, 0o644);
  try {
    execFileSync("chflags", ["uchg", helper]);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip("chflags uchg is unavailable");
    return;
  }

  try {
    const repaired = repairSpawnHelperFile(helper);
    assert.equal(repaired.copied, true);
    assert.notEqual(repaired.helperPath, helper);
    assert.equal(existsSync(repaired.helperPath), true);
    assert.equal(statSync(repaired.helperPath).mode & 0o111, 0o111);
  } finally {
    try { execFileSync("chflags", ["nouchg", helper]); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("describePtySpawnFailure maps the macOS helper error to a repair hint", () => {
  assert.match(
    describePtySpawnFailure(new Error("posix_spawnp failed.")),
    /spawn-helper/,
  );
  assert.equal(describePtySpawnFailure(new Error("cwd missing")), "cwd missing");
});
