import assert from "node:assert/strict";
import test from "node:test";
import { startEmployeeKnowledgeRunner } from "../src/employee-knowledge.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerObserver } from "../src/structured-runner.js";
import type { WandStorage } from "../src/storage.js";

test("external group execution retains employee identity but gets no knowledge or owner Web-login capability", () => {
  let captured: StructuredRunnerContext | undefined, granted = false;
  const runner = { start(context: StructuredRunnerContext) { captured = context; return { completion: Promise.resolve({}), interrupt() {} }; } } as unknown as StructuredRunnerAdapter;
  const storage = { getSiliconEmployee() { throw new Error("must not read private employee projection"); }, issueEmployeeKnowledgeAccess() { throw new Error("must not grant knowledge"); } } as unknown as WandStorage;
  const context = { session: { id: "external-session", employeeId: "e_test_1", automationId: "dingtalk:trusted-request" }, env: {
    WAND_KNOWLEDGE_DB: "private-db", WAND_KNOWLEDGE_TOKEN: "private-token", WAND_WEB_LOGIN_PROOF: "owner-proof", DWS_CLIENT_SECRET: "integration-secret", DWS_TOKEN: "integration-token", DWS_CONFIG_DIR: "private-dws-config",
  }, prompt: "群内问题" } as unknown as StructuredRunnerContext;
  startEmployeeKnowledgeRunner(storage, runner, context, {} as StructuredRunnerObserver, () => { granted = true; return { proof: "must-not-mint", revoke() {} }; });
  assert.equal(granted, false); assert.equal(captured?.session.employeeId, "e_test_1");
  assert.equal(captured?.env.WAND_KNOWLEDGE_TOKEN, undefined); assert.equal(captured?.env.WAND_KNOWLEDGE_DB, undefined); assert.equal(captured?.env.WAND_WEB_LOGIN_PROOF, undefined);
  assert.equal(captured?.env.DWS_CLIENT_SECRET, undefined); assert.equal(captured?.env.DWS_TOKEN, undefined); assert.equal(captured?.env.DWS_CONFIG_DIR, undefined);
});
