import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../start.sh", import.meta.url), "utf8");
const readiness = source.match(/wait_for_service_ready\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(readiness);

// Run the production readiness loop with a virtual clock and no real service.
function probe(readyAt: number, ownsListener = true, expectedCommand = true) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail
fixture_seconds=0
NODE_FOR_WAND=/fixture/node
WAND_BIN=/fixture/wand
CONFIG_PATH=/fixture/config.json
SCOPE=system
config_value() { if [[ "$1" == port ]]; then echo 8181; else echo false; fi; }
service_pid() { echo 123; }
ps() { echo ${expectedCommand ? "/fixture/node /fixture/wand web -c /fixture/config.json" : "/other/server"}; }
lsof() { echo ${ownsListener ? "123" : "456"}; }
curl() { (( fixture_seconds >= ${readyAt} )); }
sleep() { fixture_seconds=$((fixture_seconds + 1)); }
msg() { printf '%s\\n' "$*"; }
ok() { printf 'READY %s\\n' "$fixture_seconds"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
${readiness!.replace(/\bSECONDS\b/g, "fixture_seconds")}
wait_for_service_ready
`], { encoding: "utf8", timeout: 5000 });
}

test("cold startup succeeds after the former 12-second window", () => {
  const result = probe(25);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /READY 25/);
  assert.match(result.stdout, /服务仍在初始化/);
});

test("startup remains bounded and reports readiness timeout accurately", () => {
  const result = probe(100);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /等待 90 秒后服务仍未就绪/);
});

test("an HTTP response from a different process cannot satisfy readiness", () => {
  for (const result of [probe(0, false), probe(0, true, false)]) {
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /READY/);
  }
});
