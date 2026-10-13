import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

// Execute the real panel module with deferred probes; never call launchctl/systemctl.
function harness() {
  const source = readFileSync(new URL("../src/tui/service-panel.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const probes: Array<(value: unknown) => void> = [];
  const commands = { serviceStatusAsync: () => new Promise(resolve => probes.push(resolve)) };
  const module = { exports: {} as { openServicePanel?: (deps: unknown) => void } };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", code)(
    (name: string) => name === "./commands.js" ? commands : require(name), module, module.exports,
  );
  const openings: Array<{ onClose(): void; onRefresh(): void }> = [];
  const updates: Array<{ statusLine: string }> = [];
  const layout = {
    openServicePanel: (callbacks: typeof openings[number]) => openings.push(callbacks),
    updateServicePanel: (view: typeof updates[number]) => updates.push(view),
    closeServicePanel() {}, showToast() {},
  };
  const open = () => module.exports.openServicePanel!({ layout, configPath: "/tmp/wand-panel-test.json" });
  const settle = async (index: number, description: string) => {
    probes[index]({ description, state: "active", installed: true, platform: "darwin" });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { open, openings, updates, settle };
}

test("service panel ignores a previous opening's late status after close and reopen", async () => {
  const h = harness();
  h.open();
  h.openings[0].onClose();
  h.open();
  await h.settle(1, "new active");
  await h.settle(0, "old inactive");
  assert.deepEqual(h.updates.map(view => view.statusLine), ["new active"]);
});

test("service panel ignores older refreshes within the same opening", async () => {
  const h = harness();
  h.open();
  h.openings[0].onRefresh();
  await h.settle(1, "new refresh");
  await h.settle(0, "old refresh");
  assert.deepEqual(h.updates.map(view => view.statusLine), ["new refresh"]);
});
