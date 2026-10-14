import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNodeVersionForUpdate, finalizeDeferredGlobalUpdate, installPackageGloballyAsync, withGlobalUpdateLock } from "../src/npm-update-utils.js";

test("target engine minimum rejects old Node before installation", () => {
  assert.throws(() => assertNodeVersionForUpdate(">=24.21.0", "24.19.0"), /请先升级 Node.js.*旧安装未修改/);
  assert.throws(() => assertNodeVersionForUpdate(">=24.21.0", "22.5.0"), /新版本要求 Node.js/);
  assert.doesNotThrow(() => assertNodeVersionForUpdate(">=24.21.0", "24.21.0"));
  assert.doesNotThrow(() => assertNodeVersionForUpdate(">=24.21.0", "26.10.0"));
});

test("independent helper retains the global lock after nested npm install until restart handoff finishes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX npm fixture");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-update-lock-lifetime-"));
  const prefix = path.join(root, "prefix");
  const npmRoot = path.join(prefix, "lib/node_modules");
  const pkg = path.join(npmRoot, "@co0ontty/wand");
  const files = ["package.json", "dist/cli.js", "dist/server.js", "dist/web-ui/index.js",
    "dist/web-ui/embedded-assets.js", "dist/web-ui/scripts.js", "dist/web-ui/styles.js",
    "dist/web-ui/content/scripts.js", "dist/web-ui/content/styles.css",
    "dist/web-ui/content/vendor/xterm/xterm.bundle.js", "dist/web-ui/content/vendor/qrcode/qrcode.bundle.js"];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(pkg, file)), { recursive: true });
    writeFileSync(path.join(pkg, file), file === "package.json"
      ? JSON.stringify({ name: "@co0ontty/wand", version: "1.0.0" }) : "fixture");
  }
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/@co0ontty/wand/dist/cli.js", path.join(prefix, "bin/wand"));
  const npm = path.join(root, "npm");
  writeFileSync(npm, `#!/bin/sh
case "$1" in
  root) echo '${npmRoot}' ;;
  prefix) echo '${prefix}' ;;
  view) echo '>=0.0.0' ;;
  install) exit 0 ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  const previousNpm = process.env.WAND_NPM_BIN;
  const previousLocks = process.env.WAND_DEPLOYMENT_LOCKS;
  process.env.WAND_NPM_BIN = npm;
  t.after(() => {
    if (previousNpm === undefined) delete process.env.WAND_NPM_BIN; else process.env.WAND_NPM_BIN = previousNpm;
    if (previousLocks === undefined) delete process.env.WAND_DEPLOYMENT_LOCKS; else process.env.WAND_DEPLOYMENT_LOCKS = previousLocks;
    rmSync(root, { recursive: true, force: true });
  });
  const lockPath = path.join(npmRoot, ".wand-update-lock");
  await withGlobalUpdateLock(async () => {
    assert.equal(existsSync(lockPath), true);
    assert.equal(await installPackageGloballyAsync("@co0ontty/wand@1.0.0", 5000), path.join(pkg, "dist/cli.js"));
    assert.equal(existsSync(lockPath), true, "npm completion must not unlock initialization/restart");
    assert.equal(JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")).pid, process.pid);
  });
  assert.equal(existsSync(lockPath), false);
  assert.equal(process.env.WAND_DEPLOYMENT_LOCKS, previousLocks);
  await withGlobalUpdateLock(async () => {
    const receipt = path.join(root, "backup.json");
    await installPackageGloballyAsync("@co0ontty/wand@1.0.0", 5000, undefined, { backupReceiptPath: receipt });
    const backup = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(existsSync(backup.backupDir), true, "successful npm install must retain the pre-update runtime");
    writeFileSync(path.join(pkg, "dist/server.js"), "changed-after-install");
    assert.equal(finalizeDeferredGlobalUpdate(receipt, true), true);
    assert.equal(readFileSync(path.join(pkg, "dist/server.js"), "utf8"), "fixture");
    assert.equal(existsSync(backup.backupDir), true, "rollback boot may still use the retained recovery runtime");
    const committed = path.join(root, "committed.json");
    await installPackageGloballyAsync("@co0ontty/wand@1.0.0", 5000, undefined, { backupReceiptPath: committed });
    const committedBackup = JSON.parse(readFileSync(committed, "utf8"));
    assert.equal(finalizeDeferredGlobalUpdate(committed), true);
    assert.equal(existsSync(committedBackup.backupRoot), false);
  });
});
