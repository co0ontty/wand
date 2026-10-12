import assert from "node:assert/strict";
import test from "node:test";
import { computeBetaVersion, computeLocalBaseVersion } from "../scripts/beta-version.js";
import { publish } from "../scripts/publish-npm.js";
import { compareSemver } from "../src/version-utils.js";

test("local Beta base includes installed npm releases without lowering the source version", () => {
  assert.equal(computeLocalBaseVersion(["4.89.2", "v4.89.2", "4.89.4"]), "4.89.4");
  assert.equal(computeLocalBaseVersion(["4.90.0", "v4.89.2", "4.89.4-debug.t10101400"]), "4.90.0");
  assert.equal(computeLocalBaseVersion(["4.89.2", "", ""]), "4.89.2");
  assert.throws(() => computeLocalBaseVersion(["", "invalid"]));
});

test("Beta versions follow stable tags and local npm releases with monotonic CI ordering", () => {
  const tags = ["v4.89.2", "v4.90.0-beta.9", "v4.9.99", "invalid"];
  const first = computeBetaVersion(tags, "4.89.4", "99", "1", "fffffff");
  const second = computeBetaVersion(tags, "4.89.4", "100", "1", "0000000");
  const retry = computeBetaVersion(tags, "4.89.4", "100", "2", "0000000");
  assert.equal(first, "4.89.5-beta.99.1.gfffffff");
  for (const [a, b] of [[first, "4.89.4"], [second, first], [retry, second], ["4.89.5", retry]]) {
    assert.ok(compareSemver(a, b) > 0);
  }
  assert.equal(computeBetaVersion(["v5.0.0"], "4.89.4", "1", "1", "aaaaaaa"), "5.0.1-beta.1.1.gaaaaaaa");
  assert.throws(() => computeBetaVersion(tags, "unknown", "1", "1", "aaaaaaa"));
  assert.throws(() => computeBetaVersion(tags, "4.89.4", undefined, "1", "aaaaaaa"));
});

test("publish rejects prereleases on latest before performing any registry writes", async () => {
  await assert.rejects(publish("4.89.5-beta.1", "latest", {
    read: () => { throw new Error("must not read registry"); },
    npm: () => { throw new Error("must not publish"); },
  }), /only accepts stable/);
});
