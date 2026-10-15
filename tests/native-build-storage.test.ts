import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const entries = [
  ["macos/build.sh", "bash"], ["macos/debug.sh", "bash"],
  ["macos/scripts/run-tests.sh", "bash"], ["ios/build.sh", "bash"],
  ["ios/debug.sh", "zsh"], ["android/debug.sh", "bash"], ["android/gradlew", "sh"],
] as const;

for (const [entry, shell] of entries) {
  test(`${entry} stops before tools/outputs when local storage policy refuses`, (t) => {
    const script = path.join(repo, entry);
    try { readFileSync(script); } catch { t.skip("platform submodule is not checked out"); return; }
    if (spawnSync(shell, ["-c", "exit 0"]).error) { t.skip(`${shell} unavailable`); return; }
    const tmp = mkdtempSync(path.join(os.tmpdir(), "wand-native-policy-"));
    try {
      const envFile = path.join(tmp, "policy.sh");
      writeFileSync(envFile, "echo 'external-storage-refused' >&2\nreturn 73\n");
      const result = spawnSync(shell, [script], {
        cwd: repo, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, WAND_NATIVE_BUILD_ENV: envFile },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /external-storage-refused/);
      const missing = spawnSync(shell, [script], {
        cwd: repo, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, WAND_NATIVE_BUILD_ENV: path.join(tmp, "missing.sh") },
      });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /Native build environment file not found/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test("Gradle wrapper sends project cache to the configured root and preserves argv spaces", (t) => {
  const script = path.join(repo, "android/gradlew");
  try { readFileSync(script); } catch { t.skip("Android not checked out"); return; }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wand-gradle-policy-"));
  try {
    const home = path.join(tmp, "fake jdk");
    mkdirSync(path.join(home, "bin"), { recursive: true });
    const resultFile = path.join(tmp, "args.json");
    writeFileSync(path.join(home, "bin/java"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(process.env.ARGV_RESULT, JSON.stringify(process.argv.slice(1)))' -- "$@"\n`, { mode: 0o755 });
    const root = path.join(tmp, "external build root");
    const envFile = path.join(tmp, "policy.sh");
    writeFileSync(envFile, `export WAND_BUILD_STORAGE_ROOT=${JSON.stringify(root)}\n`);
    const env = { ...process.env, JAVA_HOME: home, JAVA_OPTS: "", GRADLE_OPTS: "", ARGV_RESULT: resultFile, WAND_NATIVE_BUILD_ENV: envFile };
    const result = spawnSync("sh", [script, "help", "-Pmessage=two words"], { cwd: repo, encoding: "utf8", timeout: 10_000, env });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(resultFile, "utf8")) as string[];
    const index = args.indexOf("--project-cache-dir");
    assert.ok(index > args.indexOf("org.gradle.wrapper.GradleWrapperMain"));
    assert.ok(args[index + 1].startsWith(`${root}/android/`));
    assert.ok(args[index + 1].endsWith("/project-cache"));
    assert.ok(args.includes("-Pmessage=two words"));
    writeFileSync(envFile, `export WAND_BUILD_STORAGE_ROOT=${JSON.stringify(root)}\nwand_assert_external_build_path() { case "$1" in "$WAND_BUILD_STORAGE_ROOT"/*) return 0;; *) echo cache-path-refused >&2; return 1;; esac; }\n`);
    const custom = path.join(root, "custom cache");
    for (const option of [["--project-cache-dir", custom], [`--project-cache-dir=${custom}`]]) {
      const customResult = spawnSync("sh", [script, "help", ...option], { cwd: repo, encoding: "utf8", timeout: 10_000, env });
      assert.equal(customResult.status, 0, customResult.stderr);
      const customArgs = JSON.parse(readFileSync(resultFile, "utf8")) as string[];
      assert.equal(customArgs.filter(arg => arg === "--project-cache-dir" || arg.startsWith("--project-cache-dir=")).length, 1);
      assert.ok(customArgs.includes(custom) || customArgs.includes(`--project-cache-dir=${custom}`));
    }
    rmSync(resultFile);
    const rejected = spawnSync("sh", [script, "help", "--project-cache-dir", path.join(tmp, "internal-cache")], { cwd: repo, encoding: "utf8", timeout: 10_000, env });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /cache-path-refused/);
    assert.equal(existsSync(resultFile), false, "Java must not start for an internal cache override");
    const plainFile = path.join(tmp, "plain.sh");
    writeFileSync(plainFile, "unset WAND_BUILD_STORAGE_ROOT\n");
    const plain = spawnSync("sh", [script, "--version"], { cwd: repo, encoding: "utf8", timeout: 10_000, env: { ...env, WAND_NATIVE_BUILD_ENV: plainFile } });
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(!(JSON.parse(readFileSync(resultFile, "utf8")) as string[]).includes("--project-cache-dir"));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
