import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = readFileSync(new URL("../android/debug.sh", import.meta.url), "utf8");
const functionSource = script.match(/^latest_tag_version\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(functionSource, "The same version resolver used by the distribution build must be tested");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
function init(cwd: string) {
  execFileSync("git", ["init", cwd], { stdio: "pipe" });
  git(cwd, "-c", "user.name=Version Test", "-c", "user.email=version-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
}
const resolve = (cwd: string) => execFileSync("bash", ["-c", `set -euo pipefail\n${functionSource}\nlatest_tag_version`], { cwd, encoding: "utf8" }).trim();

test("Android standalone builds use highest stable semantic tag, not lexicographic or prerelease order", () => {
  const dir = mkdtempSync(join(tmpdir(), "wand-android-version-"));
  try {
    init(dir);
    assert.equal(resolve(dir), "0.0.0");
    for (const tag of ["v4.9.9", "v4.89.2", "v4.100.1", "v5.0.0-beta.1", "v999-not-a-version"]) git(dir, "tag", tag);
    assert.equal(resolve(dir), "4.100.1");
    git(dir, "tag", "v10.0.0");
    assert.equal(resolve(dir), "10.0.0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Android submodule builds cannot be masked by a newer superproject release", () => {
  const dir = mkdtempSync(join(tmpdir(), "wand-android-superproject-version-"));
  try {
    const parent = join(dir, "parent");
    const source = join(dir, "android-source");
    init(parent); init(source);
    git(parent, "tag", "v4.89.3");
    git(source, "tag", "v4.89.2");
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", source, "android");
    const android = join(parent, "android");
    assert.equal(resolve(android), "4.89.3");
    git(android, "tag", "v4.90.0");
    assert.equal(resolve(android), "4.90.0");
    git(parent, "tag", "v5.0.0-beta.1");
    assert.equal(resolve(android), "4.90.0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
