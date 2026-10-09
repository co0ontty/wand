import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { buildSync } from "esbuild";

// Derive the fixture from the real runtime graph, so a new daemon import cannot
// silently escape the component fingerprint. No daemon or model is started.
const root = path.resolve(import.meta.dirname, "..");
const graph = buildSync({ absWorkingDir: root, entryPoints: ["src/terminal-daemon-server.ts"],
  bundle: true, packages: "external", platform: "node", format: "esm", write: false, metafile: true });
const modules = Object.keys(graph.metafile!.inputs);
const packages = ["node-pty", "@xterm/headless", "@xterm/addon-serialize", "@xterm/addon-unicode11"];

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-component-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file: string, value: string) => {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  for (const file of modules) write(file, readFileSync(path.join(root, file), "utf8"));
  write("package.json", JSON.stringify({ type: "module", version: "1.0.0" }));
  write("src/build-info.json", JSON.stringify({ version: "1.0.0", builtAt: "first-build" }));
  for (const name of [...packages, "express"]) write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.0.0" }));
  let serial = 0;
  const load = () => {
    const file = `src/component-probe-${serial++}.ts`;
    write(file, readFileSync(path.join(dir, "src/terminal-daemon-build.ts"), "utf8"));
    return import(pathToFileURL(path.join(dir, file)).href) as Promise<typeof import("../src/terminal-daemon-build.js")>;
  };
  const initial = await load();
  assert.equal(initial.terminalDaemonBuildIsCurrent(), true);
  return { dir, write, load, initial };
}

test("repackaging, Wand version and Web/Server-only changes do not change the daemon build", async (t) => {
  const f = await fixture(t);
  f.write("package.json", JSON.stringify({ type: "module", version: "2.0.0-debug.t10082000", description: "server release" }));
  f.write("src/build-info.json", JSON.stringify({ version: "2.0.0-debug.t10082000", builtAt: "new-build" }));
  f.write("src/server.ts", "// changed HTTP server\n");
  f.write("src/web-ui/content/styles.css", "body { color: red; }\n");
  f.write("node_modules/express/package.json", JSON.stringify({ name: "express", version: "2.0.0" }));
  const next = await f.load();
  assert.equal(next.TERMINAL_DAEMON_BUILD_ID, f.initial.TERMINAL_DAEMON_BUILD_ID);
  assert.equal(f.initial.terminalDaemonBuildIsCurrent(), false, "the old Server must still pause maintenance during installation");
  assert.equal(next.terminalDaemonBuildIsCurrent(), true, "the relaunched Server captures the new installation");
});

test("every runtime module in the terminald graph participates in its fingerprint", async (t) => {
  const f = await fixture(t);
  for (const file of modules) {
    const original = readFileSync(path.join(f.dir, file), "utf8");
    f.write(file, `${original}\n// changed component module\n`);
    assert.equal(f.initial.terminalDaemonBuildIsCurrent(), false, file);
    assert.notEqual((await f.load()).TERMINAL_DAEMON_BUILD_ID, f.initial.TERMINAL_DAEMON_BUILD_ID, file);
    f.write(file, original);
    assert.equal(f.initial.terminalDaemonBuildIsCurrent(), true, file);
  }
});

test("only installed daemon runtime dependency updates change its fingerprint", async (t) => {
  const f = await fixture(t);
  for (const name of packages) {
    const file = `node_modules/${name}/package.json`;
    f.write(file, JSON.stringify({ name, version: "1.1.0" }));
    assert.notEqual((await f.load()).TERMINAL_DAEMON_BUILD_ID, f.initial.TERMINAL_DAEMON_BUILD_ID, name);
    assert.equal(f.initial.terminalDaemonBuildIsCurrent(), false, name);
    f.write(file, JSON.stringify({ name, version: "1.0.0" }));
  }
});

test("partial package replacement remains unavailable, never a current installation", async (t) => {
  const f = await fixture(t);
  rmSync(path.join(f.dir, "src/terminal-daemon-server.ts"));
  assert.equal(f.initial.terminalDaemonBuildIsCurrent(), false);
});
