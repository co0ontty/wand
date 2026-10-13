import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stageLocalPackage } from "../scripts/stage-local-package.js";

const version = "4.89.5-debug.t10101630";
function fixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(path.join(tmpdir(), "wand-local-package-")), root = path.join(base, "project"), stage = path.join(base, "stage");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@co0ontty/wand", version: "4.89.2", files: ["dist"] }));
  writeFileSync(path.join(root, "package-lock.json"), "preserved lock metadata");
  writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ version, channel: "beta" }));
  writeFileSync(path.join(root, "dist/cli.js"), "original artifact");
  writeFileSync(path.join(root, ".npmrc"), "fixture-only-not-to-be-packaged");
  writeFileSync(path.join(root, "README.md"), "Product documentation");
  return { base, root, stage };
}

test("local package snapshot pins version and bytes without rewriting shared metadata", t => {
  const { root, stage } = fixture(t);
  const original = readFileSync(path.join(root, "package.json")), lock = readFileSync(path.join(root, "package-lock.json"));
  stageLocalPackage(root, stage, version);
  assert.deepEqual(readFileSync(path.join(root, "package.json")), original);
  assert.deepEqual(readFileSync(path.join(root, "package-lock.json")), lock);
  assert.equal(JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8")).version, version);
  assert.equal(JSON.parse(readFileSync(path.join(stage, "dist/build-info.json"), "utf8")).version, version);
  assert.equal(existsSync(path.join(stage, ".npmrc")), false);
  assert.equal(existsSync(path.join(stage, "package-lock.json")), false);
  assert.equal(readFileSync(path.join(stage, "README.md"), "utf8"), "Product documentation");
  writeFileSync(path.join(root, "dist/cli.js"), "later build");
  writeFileSync(path.join(root, "package.json"), '{"version":"5.0.0"}');
  assert.equal(readFileSync(path.join(stage, "dist/cli.js"), "utf8"), "original artifact");
  assert.equal(JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8")).version, version);
});

test("mismatched or incomplete local artifact is rejected before any stage is created", t => {
  const { root, stage } = fixture(t);
  assert.throws(() => stageLocalPackage(root, stage, "4.89.4-debug.t10101630"), /does not match/);
  assert.equal(existsSync(stage), false);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ files: ["missing"] }));
  assert.throws(() => stageLocalPackage(root, stage, version), /file is missing/);
  assert.equal(existsSync(stage), false);
});

test("staging refuses unsafe file entries and a destination inside the workspace", t => {
  const { root, stage } = fixture(t);
  assert.throws(() => stageLocalPackage(root, path.join(root, "stage"), version), /outside the shared workspace/);
  for (const entry of ["../outside", "dist/*", "/tmp/outside", "."]) {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ files: [entry] }));
    assert.throws(() => stageLocalPackage(root, stage, version), /repository-relative paths/);
    assert.equal(existsSync(stage), false);
  }
});

test("build stamp uses explicit immutable version instead of a changing package manifest", t => {
  const { root } = fixture(t), scripts = path.join(root, "scripts");
  mkdirSync(scripts);
  cpSync(fileURLToPath(new URL("../scripts/stamp-build-info.js", import.meta.url)), path.join(scripts, "stamp-build-info.js"));
  writeFileSync(path.join(root, "package.json"), '{"type":"module","version":"old-metadata"}');
  const stamped = spawnSync(process.execPath, [path.join(scripts, "stamp-build-info.js")], {
    encoding: "utf8", env: { ...process.env, WAND_BUILD_VERSION: version, WAND_BUILD_CHANNEL: "beta" },
  });
  assert.equal(stamped.status, 0, stamped.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(root, "dist/build-info.json"), "utf8")).version, version);
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, "old-metadata");
  const invalid = spawnSync(process.execPath, [path.join(scripts, "stamp-build-info.js")], {
    encoding: "utf8", env: { ...process.env, WAND_BUILD_VERSION: "bad\nversion" },
  });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Invalid WAND_BUILD_VERSION/);
});
