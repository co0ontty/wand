import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { transformSync } from "esbuild";
import { EMBEDDED_WEB_ASSETS } from "../src/web-ui/embedded-assets.js";
import { getBrowserModule, getBrowserModuleManifest, getScriptAsset } from "../src/web-ui/scripts.js";

// Build-time JS helpers intentionally stay outside the TypeScript package.
const { coalesceBrowserRuntime } = await import("../scripts/coalesce-browser-runtime.js");

test("real Chrome loads production modules on demand and preserves close/retry paths", {
  skip: process.env.WAND_BROWSER_MODULES_TEST !== "1", timeout: 180_000,
}, async () => {
  process.env.WAND_TEST_MODE = "1";
  const { defaultConfig } = await import("../src/config.js");
  const { startServer } = await import("../src/server.js");
  const { verifyBrowserModuleLoading } = await import("./helpers/browser-module-loading.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "wand-module-browser-"));
  const fixturePath = path.join(dir, "read-only-example.txt");
  writeFileSync(fixturePath, "Read-only module loading acceptance.\n");
  const handle = await startServer({ ...defaultConfig(), host: "127.0.0.1", port: 0, https: false,
    password: "module-test-password", appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef", startupCommands: [],
  }, path.join(dir, "config.json"));
  try {
    const result = await verifyBrowserModuleLoading(handle.urls[0]!.url, { fixturePath });
    const { verifyChatModuleLoading } = await import("./helpers/chat-module-loading.mjs");
    result.chat = await verifyChatModuleLoading(handle.urls[0]!.url);
    mkdirSync("output/architecture-stage2", { recursive: true });
    writeFileSync("output/architecture-stage2/app-split-stage3-browser.json", JSON.stringify(result, null, 2));
    assert.equal(result.cases.length, 5);
  } finally { await handle.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("published graph has one eager runtime and real optional feature boundaries", () => {
  const manifest = getBrowserModuleManifest();
  assert.equal(manifest.eager.length, 1, "no waterfall of tiny eager requests");
  assert.equal(manifest.eager[0], manifest.entry);
  for (const source of ["src/web-ui/react/settings/host.tsx", "src/web-ui/react/issues/task-board-host.tsx",
    "src/web-ui/react/file-preview/host.tsx", "src/web-ui/react/code-editor/host.tsx",
    "src/web-ui/react/new-session/host.tsx", "src/web-ui/react/quick-commit/host.tsx",
    "src/web-ui/react/file-explorer/host.tsx", "src/web-ui/react/pi-settings/panel.tsx",
    "src/web-ui/react/pi-execution/host.tsx", "src/web-ui/react/workspaces/workspace-agent-picker.tsx",
    "src/web-ui/react/agents/employee-card.tsx", "src/web-ui/react/workspaces/workspace-window.tsx",
    "src/web-ui/browser/chat-render.ts"]) {
    const file = manifest.features?.[source];
    assert.ok(file, source);
    assert.ok(!manifest.eager.includes(file), `${source} must not be eagerly loaded`);
    assert.ok(manifest.files.includes(file));
  }
  const boot = getScriptAsset('/tmp/config "quoted".json').content;
  assert.ok(boot.includes(`/assets/${manifest.entry}`));
  assert.ok(Buffer.byteLength(boot) < 4_096);
  for (const file of manifest.files) {
    const code = getBrowserModule(file);
    assert.ok(code);
    assert.doesNotMatch(code, /\$\{browserModuleSrc\}/);
    // Validate top-level module syntax: IIFE CSS pooling must not wrap ESM exports.
    transformSync(code, { loader: "js", format: "esm", target: "es2020" });
    assert.equal(EMBEDDED_WEB_ASSETS.browserModules[file], readFileSync(new URL(`../src/web-ui/content/${file}`, import.meta.url), "utf8"));
  }
  assert.equal(getBrowserModule("modules/../../scripts.ts"), undefined);
});

test("optional view implementations and heavy controls are absent from the eager dependency graph", () => {
  const graph = JSON.parse(readFileSync(new URL("../output/web-ui-library-migration/bundle-graphs/main.js.json", import.meta.url), "utf8"));
  const entry = Object.keys(graph.outputs).find(file => graph.outputs[file].entryPoint === "src/web-ui/browser/main.ts");
  assert.ok(entry);
  const visited = new Set<string>();
  const bytes = new Map<string, number>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const [input, value] of Object.entries(graph.outputs[file].inputs)) {
      bytes.set(input, (bytes.get(input) ?? 0) + (value as { bytesInOutput: number }).bytesInOutput);
    }
    for (const edge of graph.outputs[file].imports) if (!edge.external && edge.kind !== "dynamic-import") visit(edge.path);
  };
  visit(entry);
  for (const file of ["src/web-ui/react/file-explorer/host.tsx", "src/web-ui/react/pi-settings/panel.tsx",
    "src/web-ui/react/pi-settings/recommender.tsx", "src/web-ui/react/pi-execution/host.tsx",
    "src/web-ui/react/agents/employee-card.tsx", "src/web-ui/react/agents/employee-avatar-workspace.tsx",
    "src/web-ui/react/workspaces/workspace-agent-picker.tsx", "src/web-ui/react/issues/date-picker.tsx",
    "src/web-ui/browser/chat-render.ts", "src/web-ui/react/chat/presentation.tsx",
    "src/web-ui/react/workspaces/workspace-window.tsx",
    "node_modules/antd/es/date-picker/index.js", "node_modules/antd/es/result/serverError.js",
    "node_modules/antd/es/result/noFound.js", "node_modules/antd/es/result/unauthorized.js"]) {
    assert.equal(bytes.get(file) ?? 0, 0, `${file} must not be eagerly shipped just behind a lazy stub`);
  }
});

test("coalescing keeps eager and lazy consumers on one shared runtime instance", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wand-module-singleton-"));
  try {
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
    const main = path.join(dir, "main.js");
    const shared = path.join(dir, "shared.js");
    const feature = path.join(dir, "feature.js");
    const files = [
      { path: main, code: 'import{counter}from"./shared.js";counter.value++;const load=()=>import("./feature.js");export{load};' },
      { path: shared, code: 'const counter={value:0};export{counter};' },
      { path: feature, code: 'import{counter as state}from"./shared.js";const read=()=>state;export{read};' },
    ];
    const outputs = await coalesceBrowserRuntime(files, new Set([main, shared]), main, dir, true);
    assert.equal(outputs.length, 2);
    for (const file of outputs) writeFileSync(file.path, file.code);
    const runtime = await import(pathToFileURL(path.join(dir, "runtime.js")).href);
    const lazy = await runtime.shared0_load();
    assert.equal(lazy.read(), runtime.shared1_counter);
    assert.equal(lazy.read().value, 1, "initialization happens once, not once per feature");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
