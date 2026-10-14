import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};

// npm ignores package-lock.json and dependency-owned overrides when installing a
// published tarball. Exact direct dependencies must keep the SDK's whole Pi
// family paired, including dependencies reached indirectly through pi-ai.
test("published Wand pins every Pi SDK peer to the tested release", () => {
  const release = pkg.dependencies["@earendil-works/pi-coding-agent"];
  assert.match(release, /^\d+\.\d+\.\d+$/);
  const pending = ["@earendil-works/pi-coding-agent"];
  const seen = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    assert.equal(pkg.dependencies[name], release, `${name} must be an exact published dependency`);
    assert.equal(lock.packages[""].dependencies?.[name], release, `${name} root lock pin`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} must exist in the lockfile`);
    assert.equal(entry.version, release, `${name} locked release`);
    pending.push(...Object.keys(entry.dependencies ?? {}).filter((peer) => peer.startsWith("@earendil-works/")));
  }
  assert.ok(seen.has("@earendil-works/pi-codemode"));
  assert.ok(seen.has("@earendil-works/pi-mcp"));
  assert.ok(seen.has("@earendil-works/pi-telemetry"));
  for (const [location, entry] of Object.entries(lock.packages)) {
    for (const name of seen) {
      if (location.endsWith(`/node_modules/${name}`)) {
        assert.equal(entry.version, release, `${location} must not contain a mismatched nested Pi release`);
      }
    }
  }
});

test("structured startup loads the real Pi SDK and resource bridge in a fresh process", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { loadPiCodingAgent } = await import("./src/harness-engine.ts");
    const sdk = await loadPiCodingAgent();
    for (const name of ["ModelRuntime", "createCodemodeExtension", "createMcpExtension", "createToolSearchExtension"]) {
      assert.equal(typeof sdk[name], "function", name);
    }
    const bridge = await import("./src/pi-resource-bridge.ts");
    assert.equal(typeof bridge.default, "function");
    console.log("structured Pi SDK imports OK");
  `], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /structured Pi SDK imports OK/);
});
