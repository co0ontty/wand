import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CACHE_PATHS, main } from "../scripts/clean-build-cache.js";

function fixture(t: { after: (cleanup: () => void) => void }): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wand-cache-cleaner-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(path.join(root, ".gitignore"), `${CACHE_PATHS.map((p) => `/${p}/`).join("\n")}\n`);
  return root;
}

function file(root: string, relativePath: string, content = "cache"): string {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

const silent = { write: () => {} };

test("cache cleaner defaults to preview and reports all fixed candidates", (t) => {
  const root = fixture(t);
  for (const candidate of CACHE_PATHS) file(root, `${candidate}/generated`);
  const report = main([], { repoRoot: root, ...silent });
  assert.equal(report.applied, false);
  assert.equal(report.candidates.length, CACHE_PATHS.length);
  assert.equal(report.totalBytes, CACHE_PATHS.length * "cache".length);
  for (const candidate of CACHE_PATHS) assert.ok(existsSync(path.join(root, candidate, "generated")));
});

test("cache cleaner applies only the whitelist and preserves release and distribution files", (t) => {
  const root = fixture(t);
  for (const candidate of CACHE_PATHS) file(root, `${candidate}/generated`);
  const protectedFiles = [
    "dist/app.js", "node_modules/tool/index.js", "android/dist/wand.apk",
    "android/local.properties", "android/wand-release.keystore", "ios/build/Wand.app/binary",
    "ios/dist/wand.ipa", "macos/build/Wand.app/binary", "macos/dist/wand.dmg",
    "macos/build/dd/SourcePackages/checkouts/SwiftTerm/.git/config",
    "macos/.debug-derived-data/SourcePackages/checkouts/SwiftTerm/source.swift",
    "ios/build/dd/Logs/build.log",
    "render/target/release/wand-render", "render-bin/v1/darwin-arm64/wand-render", "wand.db",
  ].map((name) => file(root, name));
  const report = main(["--apply"], { repoRoot: root, ...silent });
  assert.equal(report.applied, true);
  for (const candidate of CACHE_PATHS) assert.equal(existsSync(path.join(root, candidate)), false);
  for (const target of protectedFiles) assert.ok(existsSync(target));
  assert.ok(existsSync(path.join(root, ".git")));
});

test("cache cleaner refuses tracked content before removing any cache", (t) => {
  const root = fixture(t);
  const first = file(root, "android/app/build/generated");
  const tracked = file(root, "macos/build/dd/Build/valuable.txt");
  execFileSync("git", ["-C", root, "add", "-f", "macos/build/dd/Build/valuable.txt"]);
  assert.throws(() => main(["--apply"], { repoRoot: root, ...silent }), /tracked files/);
  assert.ok(existsSync(first));
  assert.ok(existsSync(tracked));
});

test("cache cleaner refuses a non-ignored cache", (t) => {
  const root = fixture(t);
  const target = file(root, "android/app/build/valuable.txt");
  writeFileSync(path.join(root, ".gitignore"), "");
  assert.throws(() => main(["--apply"], { repoRoot: root, ...silent }), /not ignored/);
  assert.ok(existsSync(target));
});

test("cache cleaner refuses a candidate symlink to external files", (t) => {
  const root = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "wand-cache-outside-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const protectedFile = file(outside, "keep.txt");
  mkdirSync(path.join(root, "android/app"), { recursive: true });
  symlinkSync(outside, path.join(root, "android/app/build"), "dir");
  assert.throws(() => main(["--apply"], { repoRoot: root, ...silent }), /symbolic link/);
  assert.ok(existsSync(protectedFile));
});

test("cache cleaner refuses an ancestor symlink to external files", (t) => {
  const root = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "wand-cache-outside-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const protectedFile = file(outside, "app/build/keep.txt");
  symlinkSync(outside, path.join(root, "android"), "dir");
  assert.throws(() => main(["--apply"], { repoRoot: root, ...silent }), /symbolic link/);
  assert.ok(existsSync(protectedFile));
});

test("cache cleaner fails closed when Git cannot read the index", (t) => {
  const root = fixture(t);
  const target = file(root, "android/app/build/keep.txt");
  writeFileSync(path.join(root, ".git/index"), "broken git index");
  assert.throws(() => main(["--apply"], { repoRoot: root, ...silent }), /Git safety check failed/);
  assert.ok(existsSync(target));
});

test("cache cleaner protects nested Git directories and worktree metadata", (t) => {
  const root = fixture(t);
  const first = file(root, "android/app/build/generated");
  const nested = path.join(root, "macos/build/dd/Build/nested-project");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init", "--quiet", nested]);
  assert.throws(() => main(["--apply"], { repoRoot: root, ...silent }), /nested Git metadata/);
  assert.ok(existsSync(first));
  assert.ok(existsSync(path.join(nested, ".git")));
  rmSync(path.join(nested, ".git"), { recursive: true });
  writeFileSync(path.join(nested, ".git"), "gitdir: /external/valuable-history\n");
  assert.throws(() => main(["--apply"], { repoRoot: root, ...silent }), /nested Git metadata/);
  assert.ok(existsSync(first));
  assert.ok(existsSync(path.join(nested, ".git")));
});

test("cache cleaner handles independent native Git worktrees", (t) => {
  const root = fixture(t);
  const nativeRoot = path.join(root, "android");
  mkdirSync(nativeRoot);
  execFileSync("git", ["init", "--quiet", nativeRoot]);
  writeFileSync(path.join(nativeRoot, ".gitignore"), "/app/build/\n");
  file(root, "android/app/build/generated");
  main(["--apply"], { repoRoot: root, ...silent });
  assert.equal(existsSync(path.join(root, "android/app/build")), false);
  assert.ok(existsSync(path.join(nativeRoot, ".git")));
});

test("cache cleaner rejects unknown paths and arguments before deleting", (t) => {
  const root = fixture(t);
  const target = file(root, "android/app/build/keep.txt");
  for (const argument of ["--all", "--root", "dist", "../", "--apply=true"]) {
    assert.throws(() => main(["--apply", argument], { repoRoot: root, ...silent }), /Unknown argument/);
  }
  assert.ok(existsSync(target));
});
