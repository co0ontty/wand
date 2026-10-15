import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { parseConversationExecutionPreference } from "../src/conversation-execution-preference.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

const preference = { provider: "pi", engine: "cli", model: "temporary-model", thinkingEffort: "pi:high" } as const;

test("manual conversation configuration reaches execution, never employee defaults or its fallback chain", async t => {
  const h = conversationHarness(t);
  const saved = h.storage.getSiliconEmployee("e_test_1")!;
  const id = "dm_e_test_1";
  for (let i = 0; i < 2; i++) {
    const receipt = await h.service.send(id, randomUUID(), `work ${i}`, null, undefined, true, undefined, preference);
    assert.equal(receipt.state, "accepted", receipt.error);
    const session = h.sessions.get(receipt.sessionId!)!;
    assert.equal(session.provider, "pi");
    assert.equal(session.selectedModel, preference.model);
    assert.equal(session.thinkingEffort, preference.thinkingEffort);
    assert.equal(session.employeeCandidates?.length, 1);
    assert.equal(session.employeeCandidates?.[0]?.engine, "cli");
    assert.equal(session.employeeId, saved.id);
    assert.equal(session.systemPrompt, saved.prompt);
  }
  assert.deepEqual(h.storage.getSiliconEmployee(saved.id), saved);
  const normal = await h.service.send(id, randomUUID(), "no page override", null);
  assert.equal(h.sessions.get(normal.sessionId!)?.selectedModel, saved.agents[0]!.model);
  assert.equal(h.sessions.get(normal.sessionId!)?.employeeCandidates?.[0]?.engine, "sdk");
});

test("HTTP validates the preference, fingerprints it and refuses to alter group or running work", async t => {
  const h = conversationHarness(t);
  const app = express(); app.use(express.json()); registerConversationRoutes(app, h.service);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const post = (id: string, executionPreference: unknown, requestId = randomUUID()) => fetch(`http://127.0.0.1:${address.port}/api/conversations/${id}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, input: "temporary work", target: null, executionPreference }),
  });
  const requestId = randomUUID();
  const response = await post("dm_e_test_1", preference, requestId); assert.equal(response.status, 202);
  const receipt = await response.json(); assert.equal(h.sessions.get(receipt.sessionId)?.selectedModel, preference.model);
  assert.equal((await post("dm_e_test_1", preference, requestId)).status, 202);
  assert.equal((await post("dm_e_test_1", { ...preference, model: "other" }, requestId)).status, 409);
  for (const invalid of [null, [], { ...preference, provider: "shell" }, { ...preference, provider: "codex", engine: "sdk" },
    { ...preference, thinkingEffort: "codex:high" }, { ...preference, model: "" }]) {
    assert.equal((await post("dm_e_test_1", invalid)).status, 400);
  }
  const group = await h.group();
  assert.equal((await post(group, preference)).status, 400);
  const run = await h.dispatch(group, "existing work");
  const rejected = await h.service.send(group, randomUUID(), "do not alter", { taskId: run.taskId!, runId: run.runId! }, undefined, true, undefined, preference);
  assert.equal(rejected.state, "rejected");
});

test("preference payload cannot inject permission, identity, prompts or execution commands", () => {
  assert.deepEqual(parseConversationExecutionPreference({ ...preference, mode: "managed", systemPrompt: "injected", employeeId: "other", command: "evil" }), preference);
});
