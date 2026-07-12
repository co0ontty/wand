import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPackageUpdateInfo,
  installPackageGloballySync,
  requiredUpdateFreeBytes,
  resolveGlobalWandBin,
} from "../src/npm-update-utils.js";

const MIB = 1024 * 1024;

test("npm dist-tags remain authoritative for every local version state", () => {
  assert.equal(buildPackageUpdateInfo("2.0.0", "stable", "3.0.0").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("4.0.0", "stable", "3.0.0").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("3.0.0-local.1", "stable", "3.0.0").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("dev", "stable", "3.0.0").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("v3.0.0", "stable", "3.0.0").updateAvailable, false);

  assert.equal(buildPackageUpdateInfo("4.0.0-beta.local", "beta", "3.0.0-beta.remote").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("3.0.0-beta.remote", "beta", "3.0.0-beta.remote").updateAvailable, false);
});

test("requiredUpdateFreeBytes keeps rollback and reserve headroom", () => {
  assert.equal(requiredUpdateFreeBytes(0), 512 * MIB);
  assert.equal(requiredUpdateFreeBytes(306 * MIB), (306 * 3 + 512) * MIB);
});

test("requiredUpdateFreeBytes normalizes invalid sizes", () => {
  assert.equal(requiredUpdateFreeBytes(-1), 512 * MIB);
  assert.equal(requiredUpdateFreeBytes(Number.NaN), 512 * MIB);
  assert.equal(requiredUpdateFreeBytes(1.9), 512 * MIB + 3);
});

test("failed global install restores the package and CLI while preserving unrelated files", (t) => {
  if (process.platform === "win32") {
    t.skip("fixture uses POSIX npm shims");
    return;
  }

  const fixture = mkdtempSync(path.join(os.tmpdir(), "wand-npm-update-test-"));
  const prefix = path.join(fixture, "prefix");
  const root = path.join(prefix, "lib", "node_modules");
  const scopeDir = path.join(root, "@co0ontty");
  const packageDir = path.join(scopeDir, "wand");
  const binDir = path.join(prefix, "bin");
  const npmStub = path.join(fixture, "npm-stub");
  const originalNpmBin = process.env.WAND_NPM_BIN;
  const originalRoot = process.env.WAND_TEST_NPM_ROOT;
  const originalPrefix = process.env.WAND_TEST_NPM_PREFIX;
  t.after(() => {
    if (originalNpmBin === undefined) delete process.env.WAND_NPM_BIN;
    else process.env.WAND_NPM_BIN = originalNpmBin;
    if (originalRoot === undefined) delete process.env.WAND_TEST_NPM_ROOT;
    else process.env.WAND_TEST_NPM_ROOT = originalRoot;
    if (originalPrefix === undefined) delete process.env.WAND_TEST_NPM_PREFIX;
    else process.env.WAND_TEST_NPM_PREFIX = originalPrefix;
    rmSync(fixture, { recursive: true, force: true });
  });

  const runtimeFiles = [
    "package.json",
    "dist/cli.js",
    "dist/server.js",
    "dist/web-ui/index.js",
    "dist/web-ui/embedded-assets.js",
    "dist/web-ui/scripts.js",
    "dist/web-ui/styles.js",
    "dist/web-ui/content/scripts.js",
    "dist/web-ui/content/styles.css",
    "dist/web-ui/content/vendor/wterm/wterm.bundle.js",
    "dist/web-ui/content/vendor/qrcode/qrcode.bundle.js",
  ];
  for (const rel of runtimeFiles) {
    const file = path.join(packageDir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      rel === "package.json"
        ? `${JSON.stringify({ name: "@co0ontty/wand", version: "old", bin: { wand: "dist/cli.js" } })}\n`
        : `old:${rel}\n`,
      "utf8",
    );
  }
  chmodSync(path.join(packageDir, "dist", "cli.js"), 0o755);
  mkdirSync(binDir, { recursive: true });
  symlinkSync("../lib/node_modules/@co0ontty/wand/dist/cli.js", path.join(binDir, "wand"));

  // These look similar to npm leftovers but are not owned by wand and must survive cleanup.
  mkdirSync(path.join(scopeDir, ".wand-backup"));
  const unrelatedPackage = path.join(scopeDir, ".wand-QQQQQQQQ");
  mkdirSync(unrelatedPackage);
  writeFileSync(path.join(unrelatedPackage, "package.json"), JSON.stringify({ name: "not-wand" }));
  writeFileSync(path.join(binDir, ".wand-WWWWWWWW"), "unrelated\n");

  writeFileSync(npmStub, `#!/usr/bin/env bash
set -euo pipefail
ROOT="\${WAND_TEST_NPM_ROOT:?}"
PREFIX="\${WAND_TEST_NPM_PREFIX:?}"
if [ "\${1:-}" = "root" ] && [ "\${2:-}" = "-g" ]; then printf '%s\\n' "$ROOT"; exit 0; fi
if [ "\${1:-}" = "prefix" ] && [ "\${2:-}" = "-g" ]; then printf '%s\\n' "$PREFIX"; exit 0; fi
if [ "\${1:-}" = "install" ]; then
  mv "$ROOT/@co0ontty/wand" "$ROOT/@co0ontty/.wand-AbCd1234"
  if [ -e "$PREFIX/bin/wand" ] || [ -L "$PREFIX/bin/wand" ]; then
    mv "$PREFIX/bin/wand" "$PREFIX/bin/.wand-ZyXw9876"
  fi
  mkdir -p "$ROOT/@co0ontty/wand/dist"
  printf 'partial\\n' > "$ROOT/@co0ontty/wand/dist/cli.js"
  printf 'npm ERR! code ENOSPC\\n' >&2
  exit 1
fi
exit 64
`, "utf8");
  chmodSync(npmStub, 0o755);
  process.env.WAND_NPM_BIN = npmStub;
  process.env.WAND_TEST_NPM_ROOT = root;
  process.env.WAND_TEST_NPM_PREFIX = prefix;

  const result = installPackageGloballySync("@co0ontty/wand@latest", 5_000);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOSPC/);
  assert.match(result.stderr, /已恢复更新前的全局安装/);
  assert.equal(JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version, "old");
  assert.equal(realpathSync(path.join(binDir, "wand")), realpathSync(path.join(packageDir, "dist", "cli.js")));
  assert.equal(resolveGlobalWandBin(), path.join(binDir, "wand"));
  assert.equal(existsSync(path.join(scopeDir, ".wand-AbCd1234")), false);
  assert.equal(existsSync(path.join(binDir, ".wand-ZyXw9876")), false);
  assert.equal(existsSync(path.join(scopeDir, ".wand-backup")), true);
  assert.equal(existsSync(unrelatedPackage), true);
  assert.equal(existsSync(path.join(binDir, ".wand-WWWWWWWW")), true);
  assert.equal(existsSync(path.join(root, ".wand-update-lock")), false);

  // A missing shim must not block repair; rollback recreates the POSIX link from package metadata.
  rmSync(path.join(binDir, "wand"));
  const missingBinResult = installPackageGloballySync("@co0ontty/wand@latest", 5_000);
  assert.equal(missingBinResult.status, 1);
  assert.match(missingBinResult.stderr, /已恢复更新前的全局安装/);
  assert.equal(realpathSync(path.join(binDir, "wand")), realpathSync(path.join(packageDir, "dist", "cli.js")));

  const lockPath = path.join(root, ".wand-update-lock");
  mkdirSync(lockPath);
  writeFileSync(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
  );
  const lockedResult = installPackageGloballySync("@co0ontty/wand@latest", 5_000);
  assert.equal(lockedResult.status, 1);
  assert.deepEqual(lockedResult.attempts, []);
  assert.match(lockedResult.stderr, /另一个 wand 更新正在进行中/);
  rmSync(lockPath, { recursive: true, force: true });
});
