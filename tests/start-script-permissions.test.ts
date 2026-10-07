import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const startScript = readFileSync(new URL("../start.sh", import.meta.url), "utf8");
const repairFunction = startScript.match(/repair_global_package_permissions\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(repairFunction);

function runRepair(setup: string): { status: number | null; stdout: string; stderr: string; mode: number } {
  const prefix = mkdtempSync(path.join(os.tmpdir(), "wand-start-permissions-"));
  const scopeDir = path.join(prefix, "lib/node_modules/@co0ontty");
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(path.join(scopeDir, "package.json"), "{}\n", { mode: 0o600 });
  chmodSync(scopeDir, 0o700);
  try {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
WAND_PREFIX="$1"
warn() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
${repairFunction}
${setup}
repair_global_package_permissions
`, "repair-test", prefix], {
      encoding: "utf8",
      env: { ...process.env, SUDO_UID: "", SUDO_GID: "" },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      mode: statSync(scopeDir).mode & 0o777,
    };
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

test("start repairs private package directories and preserves executable traversal", () => {
  const result = runRepair(String.raw`
sudo() {
  [[ "$1" != "-n" ]] || return 0
  "$@"
}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /修复 npm 全局包目录权限/);
  assert.equal(result.mode, 0o755);
});

test("start leaves an accessible package alone without requesting sudo", () => {
  const result = runRepair(String.raw`
chmod 755 "$WAND_PREFIX/lib/node_modules/@co0ontty"
chmod 644 "$WAND_PREFIX/lib/node_modules/@co0ontty/package.json"
sudo() { echo 'unexpected sudo' >&2; return 1; }
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.mode, 0o755);
});

test("start does not ignore an unreadable global directory before stopping the service", () => {
  const result = runRepair(String.raw`
id() { [[ "$1" == "-u" ]] && echo 501 || echo 20; }
find() { echo 'Permission denied' >&2; return 1; }
sudo() { return 1; }
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /权限异常.*当前环境不能输入 sudo 密码/);
  assert.equal(result.mode, 0o700);
  const preflight = startScript.indexOf('[[ "$DO_INSTALL" != "1" ]] || repair_global_package_permissions');
  assert.ok(preflight > 0 && preflight < startScript.indexOf('PACKAGE_VERSION="'));
});

test("sudo start hands packages back to the original user even with a private umask", () => {
  const result = runRepair(String.raw`
id() { echo 0; }
SUDO_UID=501
SUDO_GID=20
find() { printf '%s\n' "$*"; return 1; }
chown() { printf 'chown %s\n' "$*"; }
sudo() { echo 'unexpected sudo' >&2; return 1; }
umask 077
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /chown -R 501:20 /);
  assert.equal(result.mode, 0o755);
  assert.match(startScript, /\(umask 022; "\$NPM_FOR_WAND" install -g/);
});
