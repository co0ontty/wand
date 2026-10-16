import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shellQuote } from "../src/shell-quote.js";
import { compareNodeVersions, nodeBaseline, nodeMinimum } from "../scripts/node-version.js";

test("runtime minimum is independent of the reproducible build pin and matches the installer", () => {
  assert.equal(nodeMinimum, "22.19.0");
  assert.ok(compareNodeVersions(nodeBaseline, nodeMinimum) >= 0);
  const script = readFileSync("scripts/update-node.sh", "utf8");
  assert.ok(script.includes(`WAND_MINIMUM_NODE_VERSION="${nodeMinimum}"`));
  assert.equal(readFileSync("install.sh", "utf8").includes('REQUIRED_NODE_VERSION="$(<"$NODE_VERSION_FILE")"'), false);
  for (const version of ["22.19.0", "22.23.0", "24.0.0", "24.19.0", "24.21.0", "26.10.0"]) {
    assert.ok(compareNodeVersions(version, nodeMinimum) >= 0, version);
  }
  for (const version of ["20.19.0", "22.18.0"]) assert.ok(compareNodeVersions(version, nodeMinimum) < 0);
});

function versionNode(file: string, version: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/bash
if [ "\${1:-}" = "-e" ]; then
  exec ${shellQuote(process.execPath)} -e '
    const have=process.argv[1].split(".").map(Number),need=process.argv[2].split(".").map(Number);
    for(let i=0;i<3;i++){if(have[i]>need[i])process.exit(0);if(have[i]<need[i])process.exit(1);}
  ' ${shellQuote(version)} "\${@: -1}"
fi
if [ "\${1:-}" = "-p" ]; then echo ${shellQuote(version)}; exit 0; fi
if [ "\${1:-}" = "-v" ]; then echo ${shellQuote("v" + version)}; exit 0; fi
exec ${shellQuote(process.execPath)} "$@"
`, { mode: 0o755 });
}

test("an older shell Node uses the configured compatible runtime without changing aliases", t => {
  if (process.platform === "win32") return t.skip("Bash bootstrap");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-node-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, "old/bin/node");
  const current = path.join(root, "nvm/versions/node/v24.21.0/bin/node");
  versionNode(old, "24.19.0"); versionNode(current, "24.21.0");
  const alias = path.join(root, "nvm/alias/default");
  mkdirSync(path.dirname(alias), { recursive: true }); writeFileSync(alias, "24.19.0\n");
  const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail
. ${shellQuote(path.resolve("scripts/update-node.sh"))}
wand_ensure_update_node 24.21.0
command -v node
`], { encoding: "utf8", env: { ...process.env, NVM_DIR: path.join(root, "nvm"), PATH: `${path.dirname(old)}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").at(-1), current);
  assert.equal(readFileSync(alias, "utf8"), "24.19.0\n");
});

test("nvm bootstrap installs and uses only the requested runtime in its own process", t => {
  if (process.platform === "win32") return t.skip("Bash bootstrap");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-nvm-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nvm = path.join(root, "nvm"); mkdirSync(nvm);
  const node = path.join(nvm, "versions/node/v24.21.0/bin/node"); versionNode(node, "24.21.0");
  const events = path.join(root, "events");
  writeFileSync(path.join(nvm, "nvm.sh"), `nvm() {
  printf '%s\\n' "$*" >> ${shellQuote(events)}
  if [ "$1" = "use" ]; then export PATH=${shellQuote(path.dirname(node))}:"$PATH"; fi
}
`);
  const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail
. ${shellQuote(path.resolve("scripts/update-node.sh"))}
wand_install_nvm_node 24.21.0
wand_node_satisfies "$(command -v node)" 24.21.0
`], { encoding: "utf8", env: { ...process.env, NVM_DIR: nvm } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), ["install --no-progress 24.21.0", "use 24.21.0"]);
});
