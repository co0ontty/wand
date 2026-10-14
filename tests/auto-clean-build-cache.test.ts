import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireDeploymentLock, releaseDeploymentLock } from "../src/deployment-lock.ts";
import { checkCandidate } from "../scripts/clean-build-cache.js";
import { discoverArchiveCaches, main as clean, RETENTION_DAYS } from "../scripts/auto-clean-build-cache.js";
import { LABEL, main as install, makePlist } from "../scripts/install-build-cache-cleanup.js";

const DAY = 86_400_000;
const quiet = { write: () => {} };
function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wand-auto-cache-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(path.join(root, ".gitignore"), "output/\n.wand-build-lock/\n");
  writeFileSync(path.join(root, ".nvmrc"), "24.21.0\n");
  const options = {
    repoRoot: root, platform: "darwin", now: Date.now() + 14 * DAY,
    inspectActivity: (_scope: string): string | null => null, ...quiet,
  };
  return { root, options };
}
function file(root: string, name: string) {
  const p = path.join(root, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "keep or rebuild");
  return p;
}
function archive(root: string) {
  const base = "output/audit/ios-dd";
  file(root, `${base}/info.plist`);
  file(root, `${base}/Logs/test.xcresult/evidence`);
  const cache = file(root, `${base}/Build/Intermediates.noindex/object.o`);
  const module = file(root, `${base}/ModuleCache.noindex/module.pcm`);
  const products = file(root, `${base}/Build/Products/Release/Wand.app/binary`);
  const source = file(root, `${base}/SourcePackages/checkouts/term/.git/config`);
  return { cache, module, products, source, base };
}

test("automatic preview discovers archive caches but never products or native working trees", t => {
  const { root, options } = fixture(t);
  const a = archive(root);
  const native = file(root, "ios/build/dd/ModuleCache.noindex/native.pcm");
  file(root, "output/source-snapshot/Build/Intermediates.noindex/valuable");
  const paths = discoverArchiveCaches(root);
  assert.deepEqual(paths.sort(), [`${a.base}/Build/Intermediates.noindex`, `${a.base}/ModuleCache.noindex`].sort());
  const result = clean([], options);
  assert.equal(result.applied, false);
  assert.equal(result.candidates.length, 2);
  for (const p of [a.cache, a.module, a.products, a.source, native]) assert.ok(existsSync(p));
  assert.equal(existsSync(path.join(root, ".wand-build-lock")), false);
});

test("automatic apply removes only inactive intermediates and preserves reports/products/checkouts", t => {
  const { root, options } = fixture(t);
  const a = archive(root);
  const result = clean(["--apply"], options);
  assert.equal(result.removed.length, 2);
  assert.equal(existsSync(a.cache), false);
  assert.equal(existsSync(a.module), false);
  for (const p of [a.products, a.source, path.join(root, a.base, "Logs/test.xcresult/evidence")]) assert.ok(existsSync(p));
});

test("recent deep files and newly generated DerivedData markers retain all recent caches", t => {
  const { root, options } = fixture(t);
  const a = archive(root);
  const recent = new Date(options.now - DAY);
  utimesSync(a.cache, recent, recent);
  const result = clean(["--apply"], options);
  assert.equal(result.removed.length, 1);
  assert.ok(existsSync(a.cache));
  utimesSync(path.join(root, a.base, "info.plist"), recent, recent);
  assert.equal(clean(["--apply"], options).removed.length, 0);
  assert.ok(existsSync(a.cache));
  assert.equal(RETENTION_DAYS, 7);
});

test("activity and deployment locks skip without removal or stale-lock reclamation", t => {
  const { root, options } = fixture(t);
  const a = archive(root);
  const lock = acquireDeploymentLock(path.join(root, ".wand-build-lock"));
  assert.equal(clean(["--apply"], options).skipped, "build-lock-busy");
  assert.ok(existsSync(a.cache));
  releaseDeploymentLock(lock);
  for (const reason of ["compiler-active", "archive-in-use", "activity-check-failed"]) {
    assert.equal(clean(["--apply"], { ...options, inspectActivity: () => reason }).skipped, reason);
    assert.ok(existsSync(a.cache));
    assert.equal(existsSync(path.join(root, ".wand-build-lock")), false);
  }
});

test("activity and age are rechecked immediately before each removal", t => {
  const { root, options } = fixture(t);
  const a = archive(root);
  let calls = 0;
  const result = clean(["--apply"], { ...options, inspectActivity: () => ++calls > 1 ? "archive-in-use" : null });
  assert.equal(result.removed.length, 0);
  assert.ok(existsSync(a.cache));
  assert.ok(existsSync(a.module));
});

test("a file refreshed during activity inspection is retained", t => {
  const { root, options } = fixture(t);
  const a = archive(root);
  let calls = 0;
  const result = clean(["--apply"], { ...options, inspectActivity: () => {
    if (++calls > 1) {
      const recent = new Date(options.now);
      utimesSync(a.cache, recent, recent);
      utimesSync(a.module, recent, recent);
    }
    return null;
  } });
  assert.equal(result.removed.length, 0);
  assert.ok(existsSync(a.cache));
  assert.ok(existsSync(a.module));
});

test("tracked files, nested Git metadata and symlink archives fail closed", t => {
  const { root, options } = fixture(t);
  const a = archive(root);
  execFileSync("git", ["-C", root, "add", "-f", path.relative(root, a.cache)]);
  assert.throws(() => clean(["--apply"], options), /tracked files/);
  assert.ok(existsSync(a.cache));
  execFileSync("git", ["-C", root, "reset", "--quiet"]);
  file(root, `${a.base}/ModuleCache.noindex/.git`);
  assert.throws(() => clean(["--apply"], options), /nested Git/);
  assert.ok(existsSync(a.cache));
  assert.equal(existsSync(path.join(root, ".wand-build-lock")), false);
  rmSync(path.join(root, "output"), { recursive: true });
  symlinkSync(path.dirname(root), path.join(root, "output"), "dir");
  assert.throws(() => clean(["--apply"], options), /symbolic link/);
});

test("allocated byte reports do not mistake sparse logical size for occupied disk space", t => {
  const { root } = fixture(t);
  const relative = "output/sparse-cache";
  mkdirSync(path.join(root, relative), { recursive: true });
  const fd = openSync(path.join(root, relative, "huge"), "w");
  try {
    ftruncateSync(fd, 256 * 1024 * 1024);
    const stat = fstatSync(fd);
    const info = checkCandidate(root, relative);
    assert.equal(info.bytes, stat.size);
    assert.ok(info.allocatedBytes < info.bytes);
    assert.ok(info.allocatedBytes >= stat.blocks * 512);
  } finally { closeSync(fd); }
  assert.throws(() => checkCandidate(root, "../outside"), /outside repository/);
});

test("LaunchAgent preview uses a pinned absolute Node, escaped paths and no hooks or shell", t => {
  const { root } = fixture(t);
  const plist = makePlist({ repoRoot: `${root}/a&b`, nodePath: "/node path/bin/node", logPath: "/logs/a&b.log" });
  assert.ok(plist.includes("a&amp;b"));
  assert.ok(plist.includes("<key>Hour</key><integer>4</integer>"));
  assert.ok(plist.includes("<key>Minute</key><integer>30</integer>"));
  assert.equal(plist.includes("RunAtLoad"), false);
  assert.equal(plist.includes("/bin/sh"), false);
  const result = install([], { repoRoot: root, home: root, uid: 1234, platform: "darwin", ...quiet });
  assert.equal(result.installed, false);
  assert.equal(existsSync(result.target), false);
});

test("LaunchAgent install and uninstall manage only their own label and retain logs", t => {
  const { root } = fixture(t);
  let loaded = false;
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[0] === "--version") return "v24.21.0\n";
    if (args[0] === "print" && !loaded) throw Object.assign(new Error("not loaded"), { status: 113 });
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return "ok";
  };
  const options = { repoRoot: root, home: root, uid: 1234, platform: "darwin", run, ...quiet };
  const installed = install(["--install"], options);
  assert.ok(existsSync(installed.target));
  assert.ok(loaded);
  assert.ok(calls.some(c => c.includes(`gui/1234/${LABEL}`)));
  writeFileSync(installed.logPath, "evidence");
  install(["--install"], options);
  install(["--uninstall"], options);
  assert.equal(loaded, false);
  assert.equal(existsSync(installed.target), false);
  assert.equal(readFileSync(installed.logPath, "utf8"), "evidence");
  install(["--uninstall"], options);
});

test("installer never replaces or stops an orphan loaded agent without ownership proof", t => {
  const { root } = fixture(t);
  const options = { repoRoot: root, home: root, uid: 1234, platform: "darwin", ...quiet,
    run: (_command: string, args: string[]) => {
      if (args[0] === "--version") return "v24.21.0";
      assert.notEqual(args[0], "bootout");
      return "loaded";
    },
  };
  assert.throws(() => install(["--install"], options), /no managed plist/);
  assert.throws(() => install(["--uninstall"], options), /no managed plist/);
});

test("installer refuses foreign agents and restores its configuration on installation failure", t => {
  const { root } = fixture(t);
  const target = file(root, `Library/LaunchAgents/${LABEL}.plist`);
  const options = { repoRoot: root, home: root, uid: 1234, platform: "darwin", ...quiet };
  assert.throws(() => install(["--install"], options), /not managed/);
  assert.throws(() => install(["--uninstall"], options), /not managed/);
  rmSync(target);
  assert.throws(() => install(["--install"], { ...options, run: (_command: string, args: string[]) => {
    if (args[0] === "--version") return "v24.21.0\n";
    if (args[0] === "print") throw Object.assign(new Error("not loaded"), { status: 113 });
    if (args[0] === "bootstrap") throw new Error("bootstrap failed");
    return "ok";
  } }), /bootstrap failed/);
  assert.equal(existsSync(target), false);
});
