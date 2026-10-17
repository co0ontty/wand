import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OpenCodeFreeModelsService, OPENCODE_FREE_REFRESH_MS, registerOpenCodeFreePool } from "../src/opencode-system-fallback.js";
import { WandStorage } from "../src/storage.js";
import { defaultConfig } from "../src/config.js";
import { resolveSystemAiContext } from "../src/session-ai-context.js";
import { OPENCODE_FREE_GROUP_SELECTOR } from "../src/opencode-free-selection.js";
import { systemEmployeeDefaultAgents } from "../src/system-employee.js";

function catalog(ids: string[]): string {
  return ids.map(id => `${id}\n${JSON.stringify({
    id: id.slice("opencode/".length), providerID: "opencode", status: "active",
    api: { id: id.slice("opencode/".length), url: "https://opencode.ai/inference/v1", npm: "@ai-sdk/openai-compatible" },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: { input: { text: true }, output: { text: true }, toolcall: true },
  }, null, 2)}`).join("\n");
}

test("system employee defaults to the managed OpenCode free group, not a fixed model or paid candidate", () => {
  const agents = systemEmployeeDefaultAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].provider, "opencode");
  assert.equal(agents[0].model, OPENCODE_FREE_GROUP_SELECTOR);
  assert.notEqual(agents[0].engine, "sdk");
});

test("fresh HR can execute its inherited free group without enabling cloud fallback for unrelated roles", t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-free-group-roles-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const pool = { execution: { cwd: root, env: (base: NodeJS.ProcessEnv) => base }, candidates: async () => [] };
  const unregister = registerOpenCodeFreePool(storage, pool);
  t.after(() => { unregister(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const ops = storage.ensureSystemSiliconEmployee();
  const hr = storage.ensureHrEmployee(ops.agents);
  const snapshot = { provider: "pi" as const, command: "pi", selectedModel: null, thinkingEffort: "off" as const };
  assert.equal(hr.agents[0]!.model, OPENCODE_FREE_GROUP_SELECTOR);
  assert.equal(resolveSystemAiContext(snapshot, defaultConfig(), hr, undefined, { storage }).opencodeFree, pool);
  assert.equal(resolveSystemAiContext(snapshot, defaultConfig(), storage.ensureDecisionExpertEmployee(), undefined, { storage }).opencodeFree, undefined);
});

test("managed free pool persists verified members and periodically adds new/removes retired models", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-free-group-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = new Map<string, string>(), published: string[][] = [], probes: string[] = [];
  let now = 1_000, ids = ["opencode/big-pickle", "opencode/new-free"], blocked = "opencode/new-free", failDiscovery = false;
  const options = {
    configDir: root, now: () => now, find: () => "/offline/opencode",
    storage: {
      getConfigValue: (key: string) => saved.get(key) ?? null,
      setConfigValue: (key: string, value: string) => { saved.set(key, value); },
      getPreference: <T>(_key: string, fallback: T): T => fallback,
    },
    run: async (_file: string, args: string[]) => {
      if (args[0] === "--version") return { stdout: "1.19.1" };
      if (failDiscovery) throw new Error("offline");
      return { stdout: catalog(ids) };
    },
    probe: async (model: string) => { probes.push(model); return model !== blocked; },
    onModelsChanged: (models: string[]) => { published.push(models); },
  };
  const pool = new OpenCodeFreeModelsService(options); t.after(() => pool.dispose());
  await pool.refresh();
  assert.deepEqual(published.at(-1), ["opencode/big-pickle"]);
  assert.ok([...saved.values()].some(value => JSON.parse(value).models.includes("opencode/big-pickle")));
  const count = probes.length;
  const restored = new OpenCodeFreeModelsService(options); t.after(() => restored.dispose());
  assert.deepEqual((await restored.candidates()).map(c => c.model), ["opencode/big-pickle"]);
  assert.equal(probes.length, count, "fresh persisted proof avoids another inference probe");

  ids = ["opencode/new-free", "opencode/added-free"]; blocked = "";
  now += OPENCODE_FREE_REFRESH_MS;
  assert.deepEqual((await restored.candidates()).map(c => c.model), ["opencode/added-free", "opencode/new-free"]);
  assert.deepEqual(published.at(-1), ["opencode/added-free", "opencode/new-free"]);
  assert.ok(!JSON.stringify(published.at(-1)).includes("big-pickle"));

  const snapshot = [...saved.entries()];
  failDiscovery = true;
  await assert.rejects(restored.refresh(), /offline/);
  assert.deepEqual([...saved.entries()], snapshot, "failed discovery does not destroy the saved group");
  await assert.rejects(restored.candidates(), /offline/, "unverifiable prices fail closed rather than call a stale or paid model");
});
