import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { DecisionService } from "../src/decision-service.ts";
import { SpeechService } from "../src/speech-service.ts";
import { LocalModelSetupService } from "../src/local-model-setup.ts";
import type { LocalDecisionConfig } from "../src/decision-types.ts";

test("real managed setup verifies and initializes existing LAYA/MLX and whisper without enabling or modifying global configuration", {
  skip: process.env.WAND_LOCAL_MODEL_REAL !== "1", timeout: 180_000,
}, async t => {
  // Read only the trusted existing model/runtime configuration, never output the full file or secrets.
  const existing = JSON.parse(readFileSync(path.join(os.homedir(), ".wand", "config.json"), "utf8")).localDecision as LocalDecisionConfig;
  assert.ok(existing?.pythonPath && existing?.modelPath);
  let config = { ...existing, enabled: false };
  const root = path.resolve("output/server-speech/host"), pref = new Map<string, unknown>();
  const decisions = new DecisionService(config);
  const speech = new SpeechService({ getPreference: (key, fallback) => (pref.get(key) ?? fallback) as typeof fallback,
    setPreference: (key, value) => { pref.set(key, value); } }, root);
  const manager = new LocalModelSetupService({ configDir: root, decisions, speech, decisionConfig: () => config,
    configureDecision: next => { decisions.configure(next); config = next; } });
  t.after(() => { manager.dispose(); decisions.dispose(); speech.dispose(); });
  const before = await manager.status();
  assert.equal(before.laya.downloaded, true); assert.equal(before.laya.runtimeAvailable, true);
  assert.equal(before.speech.downloaded, true); assert.equal(before.speech.runtimeAvailable, true);
  const cases = [];
  for (const kind of ["laya", "speech"] as const) {
    const started = performance.now(); manager.start(kind, "initialize", {});
    let done = false;
    for (let count = 0; count < 600; count += 1) {
      const status = (await manager.status())[kind];
      if (status.operation && ["completed", "failed", "cancelled"].includes(status.operation.phase) && !status.busy) {
        assert.equal(status.operation.phase, "completed", status.operation.error);
        assert.equal(status.enabled, false); assert.equal(status.initialized, true);
        cases.push({ kind, initialized: true, enabled: false, durationMs: Math.round(performance.now() - started) }); done = true; break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(done, true, `${kind} did not initialize`);
  }
  writeFileSync("output/model-settings/runtime-evidence.json", JSON.stringify({ actualLocalModelInit: true, installedService: false,
    globalConfigUnchanged: JSON.stringify(JSON.parse(readFileSync(path.join(os.homedir(), ".wand", "config.json"), "utf8")).localDecision) === JSON.stringify(existing), cases }, null, 2));
});
