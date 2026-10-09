import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigWithStorage, writePreferenceToStorage } from "../src/config.ts";
import { WandStorage } from "../src/storage.ts";
import { RuntimeConfigState } from "../src/runtime-config.ts";

test("legacy LAYA paths/enabled migrate once to preferences, persist through restart and remain hot-config coherent", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-laya-config-"));
  const cfg = path.join(root, "config.json"), storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const old = { enabled: true, pythonPath: path.join(root, "original-python"), modelPath: path.join(root, "original-model") };
  writeFileSync(cfg, JSON.stringify({ host: "127.0.0.1", port: 12345, localDecision: old }));
  const loaded = await loadConfigWithStorage(cfg, storage);
  assert.deepEqual(loaded.localDecision, old);
  assert.deepEqual(storage.getPreference("pref:localDecision", null), old);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(cfg, "utf8")), "localDecision"), false);
  const runtime = new RuntimeConfigState(loaded), candidate = runtime.createCandidate();
  const next = { ...old, enabled: false };
  writePreferenceToStorage(candidate, storage, "localDecision", next); runtime.commit(candidate, ["localDecision"]);
  assert.deepEqual(runtime.desiredSnapshot().localDecision, next); assert.deepEqual(loaded.localDecision, next);
  assert.deepEqual((await loadConfigWithStorage(cfg, storage)).localDecision, next);
  assert.equal(runtime.hasPendingRestart(), false);
  assert.throws(() => writePreferenceToStorage(loaded, storage, "localDecision", { ...next, pythonPath: "../x" }), /绝对路径/);
  assert.deepEqual(loaded.localDecision, next);
});
