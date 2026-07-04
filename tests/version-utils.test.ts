import assert from "node:assert/strict";
import test from "node:test";
import { compareApkInstallOrder, compareSemver, extractSemver } from "../src/version-utils.js";

test("extractSemver supports prerelease and build metadata", () => {
  assert.equal(extractSemver("wand-v1.2.3+202607041230"), "1.2.3+202607041230");
  assert.equal(extractSemver("wand-v1.2.3-beta.1+202607041230"), "1.2.3-beta.1+202607041230");
});

test("compareSemver ignores build metadata for precedence", () => {
  assert.equal(compareSemver("1.2.3+202607041230", "1.2.3"), 0);
  assert.equal(compareSemver("1.2.4+202607041230", "1.2.3+202607041229"), 1);
  assert.equal(compareSemver("1.2.3-beta.2+202607041230", "1.2.3-beta.1+202607041229"), 1);
});

test("compareApkInstallOrder keeps debug builds newer than same release", () => {
  assert.equal(compareApkInstallOrder("1.2.3+202607041230", "1.2.3"), 0);
  assert.equal(compareApkInstallOrder("1.2.3-debug.07041230+202607041230", "1.2.3+202607041230"), 1);
  assert.equal(compareApkInstallOrder("1.2.4+202607041230", "1.2.3-debug.07041230+202607041230"), 1);
});
