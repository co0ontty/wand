import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isBlockedFolderPath } from "../src/middleware/path-safety.js";

test("blocks system and home credential locations", () => {
  const home = os.homedir();
  for (const blocked of [
    "/etc/passwd",
    "/root",
    path.join(home, ".ssh", "id_ed25519"),
    path.join(home, ".wand", "wand.db"),
    path.join(home, ".aws"),
    path.join(home, ".npmrc"),
  ]) {
    assert.equal(isBlockedFolderPath(blocked), true, blocked);
  }
});

test("allows ordinary project paths", () => {
  assert.equal(isBlockedFolderPath(path.join(os.homedir(), "Self", "project")), false);
  assert.equal(isBlockedFolderPath(path.join(os.tmpdir(), "anything")), false);
});

test("does not treat sibling names as blocked", () => {
  assert.equal(isBlockedFolderPath(path.join(os.homedir(), ".sshfoo")), false);
});

test("follows symlinks into blocked locations, including not-yet-existing children", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-path-safety-"));
  const link = path.join(dir, "link");
  symlinkSync(path.join(os.homedir(), ".ssh"), link);
  assert.equal(isBlockedFolderPath(link), true);
  assert.equal(isBlockedFolderPath(path.join(link, "new-file")), true);
  const ok = path.join(dir, "ok.txt");
  writeFileSync(ok, "x");
  assert.equal(isBlockedFolderPath(ok), false);
});
