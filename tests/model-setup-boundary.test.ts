import assert from "node:assert/strict";
import test from "node:test";

import { LocalModelSetupService } from "../src/local-model-setup.js";
import type { DecisionService } from "../src/decision-service.js";

function modelSetup() {
  const decisions = {} as unknown as DecisionService;
  const deps = {
    configDir: "/tmp/wand-boundary-unused",
    decisions,
    decisionConfig: () => ({}) as never,
    configureDecision: () => {},
    supportedLaya: () => true,
  };
  return new LocalModelSetupService(deps as never);
}

test("local model start rejects unknown kind and action before any work starts", () => {
  const models = modelSetup();
  assert.throws(() => models.start("shell" as never, "download", {}), /未知本地模型类型/);
  assert.throws(() => models.start("laya", "rm-rf" as never, {}), /未知模型操作/);
});

test("local model start drops nothing silently: body keys outside model are rejected", () => {
  const models = modelSetup();
  for (const body of [
    { executable: "/bin/sh" },
    { path: "/tmp/evil" },
    { url: "https://example.com/model.bin" },
    { command: "id" },
    { model: "base", extra: true },
  ]) {
    assert.throws(() => models.start("laya", "download", body), /仅允许选择固定模型/, JSON.stringify(body));
  }
});

test("local model start rejects non-object bodies", () => {
  const models = modelSetup();
  assert.throws(() => models.start("laya", "download", "/bin/sh"), /模型操作参数无效/);
  assert.throws(() => models.start("laya", "download", ["base"]), /模型操作参数无效/);
});
