import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";

const { addressBrowserModules } = await import("../scripts/address-browser-modules.js");
const root = "/tmp/wand-addressing-test";
function graph(settings = "settings-v1", shared = "shared-v1", suffix = "AAAAAAAA") {
  const directory = path.join(root, "modules");
  const files = {
    runtime: path.join(directory, "runtime.js"),
    settings: path.join(directory, `host-${suffix}.js`),
    other: path.join(directory, "other-BBBBBBBB.js"),
    shared: path.join(directory, "chunk-CCCCCCCC.js"),
  };
  const outputs = [
    { path: files.runtime, code: `const counter={value:0};export{counter};export const load=()=>import("./host-${suffix}.js");` },
    { path: files.settings, code: `import{counter}from"./runtime.js";import{value}from"./chunk-CCCCCCCC.js";export const title=${JSON.stringify(settings)};export{counter,value};` },
    { path: files.other, code: 'import{value}from"./chunk-CCCCCCCC.js";export{value};' },
    { path: files.shared, code: `export const value=${JSON.stringify(shared)};` },
  ];
  const metadata = { outputs: Object.fromEntries(Object.entries(files).map(([name, file]) => [path.relative(root, file), {
    ...(name !== "shared" ? { entryPoint: `src/${name}.tsx` } : {}), inputs: { [`src/${name}.tsx`]: { bytesInOutput: 1 } },
  }])) };
  return addressBrowserModules(outputs, metadata, root);
}

test("optional changes do not invalidate runtime or unrelated modules; document lookup changes", () => {
  const before = graph(), after = graph("settings-v2");
  assert.equal(before.outputs[0].path, after.outputs[0].path);
  assert.equal(before.outputs[0].code, after.outputs[0].code);
  assert.equal(before.outputs[2].path, after.outputs[2].path);
  assert.notEqual(before.outputs[1].path, after.outputs[1].path);
  assert.notEqual(before.buildId, after.buildId);
  assert.deepEqual(Object.keys(before.imports), Object.keys(after.imports), "logical feature id survives edits");
  assert.notDeepEqual(before.imports, after.imports);
  assert.match(before.outputs[0].code, /globalThis\.__wandImportBrowserModule/);
  for (const output of after.outputs) transformSync(output.code, { loader: "js", format: "esm" });
});

test("esbuild output names are not cache identities; static dependencies still invalidate importers", () => {
  const before = graph(), renamed = graph("settings-v1", "shared-v1", "DDDDDDDD");
  assert.deepEqual(before.outputs, renamed.outputs);
  assert.equal(before.buildId, renamed.buildId);
  const changed = graph("settings-v1", "shared-v2");
  assert.equal(before.outputs[0].path, changed.outputs[0].path);
  for (const index of [1, 2, 3]) assert.notEqual(before.outputs[index].path, changed.outputs[index].path);
  assert.ok(changed.outputs[1].code.includes(`/assets/${changed.outputs[3].path}`));
});

test("static cycles share one deterministic component address and preserve exact edges", () => {
  const a = path.join(root, "a.js"), b = path.join(root, "b.js");
  const metadata = { outputs: { "a.js": { entryPoint: "src/a.ts" }, "b.js": { entryPoint: "src/b.ts" } } };
  const outputs = [{ path: a, code: 'import"./b.js";export const a=1;' }, { path: b, code: 'import"./a.js";export const b=2;' }];
  const result = addressBrowserModules(outputs, metadata, root);
  assert.equal(path.dirname(result.outputs[0].path), path.dirname(result.outputs[1].path));
  assert.ok(result.outputs[0].code.includes(`/assets/${result.outputs[1].path}`));
  assert.ok(result.outputs[1].code.includes(`/assets/${result.outputs[0].path}`));
  const reversed = addressBrowserModules([...outputs].reverse(), metadata, root);
  assert.equal(result.buildId, reversed.buildId);
  const changed = addressBrowserModules([outputs[0], { ...outputs[1], code: 'import"./a.js";export const b=3;' }], metadata, root);
  assert.notEqual(result.outputs[0].path, changed.outputs[0].path);
});

test("missing local dependencies abort rather than publishing a partial graph", () => {
  assert.throws(() => addressBrowserModules([{ path: path.join(root, "runtime.js"), code: 'import"./missing.js";' }], { outputs: {} }, root), /Missing static module/);
  assert.throws(() => addressBrowserModules([{ path: path.join(root, "runtime.js"), code: 'import("./missing.js")' }], { outputs: {} }, root), /Missing dynamic module/);
});
