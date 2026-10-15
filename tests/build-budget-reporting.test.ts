import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nodeMinimum, compareNodeVersions } from "../scripts/node-version.js";

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
  assert.match(startScript, /npm run budget:accept/,
    "预算失败提示必须指向基线刷新命令，而不是只让人手改数字");
});

test("runtime minimum is separate from the shared development/publish build pin", () => {
  const required = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines: { node: string }; scripts: Record<string, string>;
  };
  assert.equal(pkg.engines.node, `>=${nodeMinimum}`);
  assert.ok(compareNodeVersions(required, nodeMinimum) >= 0);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages: { "": { engines: { node: string } } };
  };
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  assert.ok(readFileSync(new URL("../install.sh", import.meta.url), "utf8")
    .includes('REQUIRED_NODE_VERSION="$WAND_MINIMUM_NODE_VERSION"'));
  for (const command of ["build", "check"]) {
    assert.equal(pkg.scripts[command], `node src/deployment-lock.ts --run-project -- npm run ${command}:body`,
      `${command} must acquire the shared build lock before mutating generated assets`);
    if (command === "build") {
      assert.equal(pkg.scripts["build:body"], "node scripts/build-body.js", "build must run the build body script");
    } else {
      assert.match(pkg.scripts[`${command}:body`] ?? "", /^node scripts\/check-node-version\.js && /,
        `${command} still checks Node before executing its body`);
    }
  }
  // build-body.js owns the step order; Node version is checked first, before any mutation.
  const buildBody = readFileSync(new URL("../scripts/build-body.js", import.meta.url), "utf8");
  assert.match(buildBody, /const STEPS = \[\n  \(\) => node\("scripts\/check-node-version\.js"\),\n  \(\) => rmSync\(/,
    "build body must check Node before removing dist");
  for (const command of ["test", "dev", "check:bundle-budget", "budget:accept"]) {
    assert.match(pkg.scripts[command] ?? "", /^node scripts\/check-node-version\.js && /);
  }
  assert.match(pkg.scripts["budget:accept"] ?? "", /check-bundle-budget\.js --accept-baseline/,
    "budget:accept must refresh scripts/bundle-budget-baseline.json through the budget script");
  for (const workflow of ["npm-release.yml", "beta-branch.yml"]) {
    assert.match(readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8"),
      /node-version-file: \.nvmrc/);
  }
});
