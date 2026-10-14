import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acquireDeploymentLock, acquireDeploymentLocks, releaseDeploymentLock } from "../src/deployment-lock.js";

const cli = fileURLToPath(new URL("../src/deployment-lock.ts", import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(path.join(tmpdir(), "wand-deployment-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("deployment lock is exclusive and only its owner can release it", t => {
  const root = fixture(t), file = path.join(root, ".wand-update-lock");
  const lock = acquireDeploymentLock(file);
  assert.throws(() => acquireDeploymentLock(file), /另一个 wand 更新正在进行中/);
  releaseDeploymentLock({ ...lock, token: "not-owner" });
  assert.equal(existsSync(file), true);
  releaseDeploymentLock({ ...lock, ownerPid: process.pid + 1 });
  assert.equal(existsSync(file), true);
  releaseDeploymentLock(lock);
  assert.equal(existsSync(file), false);
});

test("nested build can reuse a live parent lease without releasing the parent lock", t => {
  const root = fixture(t), file = path.join(root, ".wand-build-lock");
  const parent = acquireDeploymentLock(file);
  const nested = acquireDeploymentLock(file, { inherited: [parent] });
  assert.equal(nested.owned, false);
  releaseDeploymentLock(nested);
  assert.equal(existsSync(file), true);
  assert.throws(() => acquireDeploymentLock(file, { inherited: [{ ...parent, token: "stale" }] }), /另一个 wand 更新/);
  releaseDeploymentLock(parent);
});

test("failure to acquire global update lock releases only the newly acquired project lock", t => {
  const root = fixture(t), project = path.join(root, ".wand-build-lock"), global = path.join(root, ".wand-update-lock");
  const updater = acquireDeploymentLock(global);
  assert.throws(() => acquireDeploymentLocks([project, global]), /另一个 wand 更新/);
  assert.equal(existsSync(project), false);
  assert.equal(existsSync(global), true);
  releaseDeploymentLock(updater);
});

test("Bash receipt and updater use the same lock protocol across processes", t => {
  const root = fixture(t), file = path.join(root, ".wand-update-lock");
  const held = spawnSync(process.execPath, [cli, "--acquire", "--owner-pid", String(process.pid), "--lock", file], { encoding: "utf8" });
  assert.equal(held.status, 0, held.stderr);
  assert.throws(() => acquireDeploymentLock(file), /另一个 wand 更新/);
  const release = spawnSync(process.execPath, [cli, "--release", "--owner-pid", String(process.pid)], { input: held.stdout, encoding: "utf8" });
  assert.equal(release.status, 0, release.stderr);
  assert.equal(existsSync(file), false);
});

test("build wrapper refuses busy project before running a command and supports a held parent lease", t => {
  const root = fixture(t), file = path.join(root, ".wand-build-lock"), marker = path.join(root, "ran");
  const lock = acquireDeploymentLock(file);
  const args = [cli, "--run-project", "--", process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'done')", marker];
  const rejected = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, WAND_DEPLOYMENT_LOCKS: "" } });
  assert.equal(rejected.status, 1); assert.equal(existsSync(marker), false);
  const nested = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, WAND_DEPLOYMENT_LOCKS: JSON.stringify([lock]) } });
  assert.equal(nested.status, 0, nested.stderr); assert.equal(readFileSync(marker, "utf8"), "done");
  assert.equal(existsSync(file), true); releaseDeploymentLock(lock);
});

test("project command failure releases its own lock and preserves the child's exit status", t => {
  const root = fixture(t);
  const failed = spawnSync(process.execPath, [cli, "--run-project", "--", process.execPath, "-e", "process.exit(7)"], {
    cwd: root, encoding: "utf8", env: { ...process.env, WAND_DEPLOYMENT_LOCKS: "" },
  });
  assert.equal(failed.status, 7, failed.stderr);
  assert.equal(existsSync(path.join(root, ".wand-build-lock")), false);
});

test("interrupted project command retains its lock until a slow owned writer exits", { timeout: 10_000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX process group fixture");
  const root = fixture(t), ready = path.join(root, "ready"), done = path.join(root, "done");
  const childScript = path.join(root, "writer.cjs"), parentScript = path.join(root, "parent.cjs");
  writeFileSync(childScript, `const fs=require('node:fs');process.on('SIGTERM',()=>{setTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'done');process.exit(0)},250)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
  writeFileSync(parentScript, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [cli, "--run-project", "--", process.execPath, parentScript], {
    cwd: root, env: { ...process.env, WAND_DEPLOYMENT_LOCKS: "" }, stdio: "ignore",
  });
  for (let i = 0; i < 100 && !existsSync(ready); i++) await pause(20);
  assert.equal(existsSync(ready), true);
  const stopped = once(child, "exit"); child.kill("SIGTERM");
  await pause(80);
  const heldUntilWriterExit = existsSync(path.join(root, ".wand-build-lock"));
  await stopped;
  for (let i = 0; i < 100 && !existsSync(done); i++) await pause(20);
  assert.equal(existsSync(done), true);
  assert.equal(heldUntilWriterExit, true, "a surviving package writer still excludes another build");
  assert.equal(existsSync(path.join(root, ".wand-build-lock")), false);
});
