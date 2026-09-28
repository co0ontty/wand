import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const startScript = readFileSync(new URL("../start.sh", import.meta.url), "utf8");

function classifiedAsBudgetFailure(log: string): boolean {
  const match = startScript.match(/if grep -q '([^']+)' "\$BUILD_LOG"; then/);
  assert.ok(match, "start.sh must classify build failures from an explicit log marker");
  const result = spawnSync("grep", ["-q", match[1]], { input: log, encoding: "utf8" });
  assert.ok(result.status === 0 || result.status === 1, result.stderr || "grep failed");
  return result.status === 0;
}

test("start.sh reports a budget failure only when the budget gate actually fails", () => {
  const buildCommand = "> npm run build && node scripts/check-bundle-budget.js && tsc -p tsconfig.json\n";
  assert.equal(classifiedAsBudgetFailure(`${buildCommand}src/foo.ts(1,1): error TS1234\n`), false);
  assert.equal(classifiedAsBudgetFailure(`${buildCommand}[bundle-budget] ok - first load\n`), false);
  assert.equal(classifiedAsBudgetFailure(`${buildCommand}[bundle-budget] FAILED:\n  first load +631 B\n`), true);
});

test("development and both publish workflows use the same pinned Node version", () => {
  const required = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines: { node: string }; scripts: Record<string, string>;
  };
  assert.equal(pkg.engines.node, `>=${required}`);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages: { "": { engines: { node: string } } };
  };
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  assert.ok(readFileSync(new URL("../install.sh", import.meta.url), "utf8")
    .includes(`REQUIRED_NODE_VERSION="${required}"`));
  for (const command of ["build", "check", "test", "dev", "check:bundle-budget"]) {
    assert.match(pkg.scripts[command] ?? "", /^node scripts\/check-node-version\.js && /);
  }
  for (const workflow of ["npm-release.yml", "beta-branch.yml"]) {
    assert.match(readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8"),
      /node-version-file: \.nvmrc/);
  }
});
