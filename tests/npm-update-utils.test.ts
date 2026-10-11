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
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

import {
  buildPackageUpdateInfo,
  checkPackageUpdateAsync,
  checkPackageUpdateSync,
  installPackageGloballySync,
  requiredUpdateFreeBytes,
  resolveGlobalWandBin,
} from "../src/npm-update-utils.js";

const MIB = 1024 * 1024;

test("stable never accepts prereleases and installs the exact checked version", () => {
  for (const invalid of ["4.90.0-beta.1", "4.90.0-debug.1", "garbage", "4.90.0\n4.91.0", "04.90.0"]) {
    const info = buildPackageUpdateInfo("4.89.4", "stable", invalid);
    assert.equal(info.latest, null);
    assert.equal(info.updateAvailable, false);
  }
  const stable = buildPackageUpdateInfo("4.89.4", "stable", "4.89.5");
  assert.equal(stable.installSpec, "@co0ontty/wand@4.89.5");
  const beta = buildPackageUpdateInfo("4.89.4", "beta", "4.89.5-beta.12.1.gabcdef0");
  assert.equal(beta.updateAvailable, true);
  assert.equal(beta.installSpec, "@co0ontty/wand@4.89.5-beta.12.1.gabcdef0");
  assert.equal(buildPackageUpdateInfo(beta.latest!, "beta", "4.89.5-beta.13.1.g0000000").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo(beta.latest!, "stable", "4.89.5").updateAvailable, true);
  // Disabling Beta stops prerelease updates; returning to an older stable is explicit reinstall.
  assert.equal(buildPackageUpdateInfo(beta.latest!, "stable", "4.89.4").updateAvailable, false);
  assert.equal(buildPackageUpdateInfo("4.89.4", "beta", null).latest, null);
});

test("sync and async checks select only the requested npm dist-tag", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX npm fixture");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-channel-"));
  const bin = path.join(root, "npm");
  const previous = process.env.WAND_NPM_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.WAND_NPM_BIN;
    else process.env.WAND_NPM_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(bin, `#!/bin/sh
case "$2" in
  @co0ontty/wand@latest) echo 4.89.4 ;;
  @co0ontty/wand@beta) echo 4.89.5-beta.12.1.gabcdef0 ;;
  *) exit 1 ;;
esac
`);
  chmodSync(bin, 0o755);
  process.env.WAND_NPM_BIN = bin;
  for (const channel of ["stable", "beta"] as const) {
    const sync = checkPackageUpdateSync("4.89.3", channel);
    const async = await checkPackageUpdateAsync("4.89.3", channel);
    assert.deepEqual(async, sync);
    assert.equal(sync.distTag, channel === "beta" ? "beta" : "latest");
    assert.equal(sync.latest, channel === "beta" ? "4.89.5-beta.12.1.gabcdef0" : "4.89.4");
  }
});

test("npm updates move forward without downgrading local or debug builds", () => {
  assert.equal(buildPackageUpdateInfo("2.0.0", "stable", "3.0.0").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("4.0.0", "stable", "3.0.0").updateAvailable, false);
  assert.equal(buildPackageUpdateInfo("3.0.0-local.1", "stable", "3.0.0").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("3.0.0-debug.t07161744", "stable", "3.0.0").updateAvailable, false);
  assert.equal(buildPackageUpdateInfo("3.0.0-debug.t07161743", "beta", "3.0.0-debug.t07161744").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("dev", "stable", "3.0.0").updateAvailable, true);
  assert.equal(buildPackageUpdateInfo("v3.0.0", "stable", "3.0.0").updateAvailable, false);

  assert.equal(buildPackageUpdateInfo("4.0.0-beta.local", "beta", "3.0.0-beta.remote").updateAvailable, false);
  assert.equal(buildPackageUpdateInfo("3.0.0-beta.remote", "beta", "3.0.0-beta.remote").updateAvailable, false);
});

test("server update checking follows the immutable running build, not stale package metadata", async () => {
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const check = source.match(/async function checkLatestPackageVersion\([\s\S]*?\n\}/)?.[0];
  assert.ok(check);
  const compiled = transformSync(check, { loader: "ts" }).code;
  const running = "4.89.5-debug.t10101630";
  const info = await runInNewContext(compiled + "\ncheckLatestPackageVersion('stable', true)", {
    PKG_VERSION: "4.89.2", DISPLAY_VERSION: running, CACHE_TTL_MS: 600_000,
    packageUpdateCache: new Map(),
    checkPackageUpdateAsync: async (current: string) => buildPackageUpdateInfo(current, "stable", "4.89.5"),
  });
  assert.equal(info.current, running);
  assert.equal(info.updateAvailable, false, "equal stable release must not replace this newer running Beta");
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
    "dist/web-ui/content/vendor/xterm/xterm.bundle.js",
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
