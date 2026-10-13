import assert from "node:assert/strict";
import test from "node:test";

import { LocalModelSetupService } from "../src/local-model-setup.js";
import { SpeechError, SpeechService } from "../src/speech-service.js";
import type { DecisionService } from "../src/decision-service.js";

function speechWithStorage() {
  const values = new Map<string, unknown>();
  const service = new SpeechService({
    getPreference: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
    setPreference: (key: string, value: unknown) => { values.set(key, value); },
  } as never, "/tmp/wand-boundary-unused");
  return { service, values };
}

function modelSetup() {
  const { service: speech } = speechWithStorage();
  const decisions = {} as unknown as DecisionService;
  const deps = {
    configDir: "/tmp/wand-boundary-unused",
    decisions,
    speech,
    decisionConfig: () => ({}) as never,
    configureDecision: () => {},
    supportedLaya: () => true,
  };
  return new LocalModelSetupService(deps as never);
}

test("speech configure rejects executable, path and URL keys and persists nothing", () => {
  const { service, values } = speechWithStorage();
  for (const key of ["executable", "binary", "path", "url", "command", "backend", "env"]) {
    assert.throws(
      () => service.configure({ enabled: true, [key]: "/bin/sh" }),
      (error: unknown) => error instanceof SpeechError && error.code === "INVALID_SETTINGS",
      `key ${key} must be rejected`,
    );
  }
  assert.equal(values.has("pref:speechRecognition"), false);
});

test("speech configure accepts only the fixed settings allowlist", () => {
  const { service, values } = speechWithStorage();
  const saved = service.configure({ enabled: false, model: "base", acceleration: "cpu", language: "zh", threads: 2 });
  assert.deepEqual(saved, { enabled: false, model: "base", acceleration: "cpu", language: "zh", threads: 2 });
  assert.equal(values.size, 1);
});

test("local model start rejects unknown kind and action before any work starts", () => {
  const models = modelSetup();
  assert.throws(() => models.start("shell" as never, "download", {}), /未知本地模型类型/);
  assert.throws(() => models.start("speech", "rm-rf" as never, {}), /未知模型操作/);
});

test("local model start drops nothing silently: body keys outside model/backend are rejected", () => {
  const models = modelSetup();
  for (const body of [
    { executable: "/bin/sh" },
    { path: "/tmp/evil" },
    { url: "https://example.com/model.bin" },
    { command: "id" },
    { model: "base", extra: true },
  ]) {
    assert.throws(() => models.start("speech", "download", body), /仅允许选择固定模型/, JSON.stringify(body));
  }
});

test("local model start rejects non-object bodies", () => {
  const models = modelSetup();
  assert.throws(() => models.start("speech", "download", "/bin/sh"), /模型操作参数无效/);
  assert.throws(() => models.start("speech", "download", ["base"]), /模型操作参数无效/);
});
