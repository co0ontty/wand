import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import express from "express";
import { ConversationService } from "../src/conversation-service.js";
import { employeeConversationId } from "../src/conversation-types.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";
import { WandStorage } from "../src/storage.js";
import type { WandConfig } from "../src/types.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

// Real isolated SQLite + existing service/routes/runner. All execution/relay I/O is an explicit double.
test("F1 explicit group relay failure after atomic acceptance returns the original group/task", async t => {
  const h = conversationHarness(t), dm = await h.group(), requestId = randomUUID();
  const input = { title: "原任务", description: "仅运行明确测试替身", workspaceId: h.workspace.id };
  const originalRelay = h.structured.createRelaySession;
  let attempted = 0;
  h.structured.createRelaySession = () => {
    attempted++;
    const receipt = h.service.receipt(requestId)!;
    assert.equal(receipt.state, "accepted"); assert.equal(receipt.startup, "pending");
    assert.ok(h.storage.getConversation(receipt.conversationId));
    assert.ok(h.storage.getWandTask(receipt.taskId!));
    assert.equal(h.storage.conversationTasks(receipt.conversationId)[0]?.taskId, receipt.taskId);
    assert.equal(receipt.conversationId, dm);
    throw new Error("明确替身 relay 创建失败");
  };
  const app = express(); app.use(express.json()); registerConversationRoutes(app, h.service);
  const server = app.listen(0, "127.0.0.1"); t.after(() => server.close());
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/api/conversations/${dm}/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, ...input }),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json() as Awaited<ReturnType<ConversationService["dispatch"]>>;
  assert.equal(receipt.state, "accepted"); assert.equal(receipt.startup, "failed");
  assert.match(receipt.error!, /relay 创建失败/); assert.equal(receipt.conversationId, dm); assert.ok(receipt.taskId);
  assert.deepEqual(await h.service.dispatch(dm, requestId, input), receipt);
  assert.deepEqual(await (await fetch(`${origin}/api/conversations/requests/${requestId}`)).json(), receipt);
  assert.equal(attempted, 1); assert.equal(h.storage.listWandTasks().length, 1);
  const reopened = new WandStorage(path.join(path.dirname(h.cwd), "wand.db")); t.after(() => reopened.close());
  assert.deepEqual(reopened.getConversationRequest(requestId)?.receipt, receipt);
  assert.equal(reopened.conversationTasks(dm)[0]?.taskId, receipt.taskId);
  assert.equal(h.service.detail(receipt.conversationId).tasks[0]?.startup?.state, "failed");
  h.structured.createRelaySession = originalRelay;
  const continuationId = randomUUID(), continuation = { ...input, continueTaskId: receipt.taskId };
  const next = await h.service.dispatch(receipt.conversationId, continuationId, continuation); await h.runner.idle();
  assert.equal(next.state, "accepted"); assert.equal(next.conversationId, receipt.conversationId);
  assert.equal(next.taskId, receipt.taskId); assert.ok(next.runId);
  assert.deepEqual(await h.service.dispatch(receipt.conversationId, continuationId, continuation), next);
  assert.equal(h.storage.listWandTasks().length, 1); assert.equal(h.storage.listConversations().filter(c => c.kind === "group").length, 1);
  assert.equal(h.storage.listAiTeamRuns().length, 1); assert.equal(h.storage.conversationTasks(dm).length, 1);
});

test("F1 task acceptance survives runner failure before and after persistent run metadata", async t => {
  for (const partiallySaved of [false, true]) {
    const h = conversationHarness(t), requestId = randomUUID(), dm = await h.group();
    const input = { title: `启动失败-${partiallySaved}`, description: "明确替身失败注入", workspaceId: h.workspace.id };
    const start = h.runner.start.bind(h.runner);
    h.runner.start = async options => {
      const receipt = h.service.receipt(requestId)!;
      assert.equal(receipt.state, "accepted"); assert.equal(receipt.startup, "pending");
      assert.equal(h.storage.conversationTasks(dm)[0]?.taskId, receipt.taskId);
      if (partiallySaved) {
        // Persist using the real runner, then mark this explicit double's startup as failed.
        const detail = await start(options);
        h.storage.saveAiTeamRun({ ...detail.run, status: "failed", statusDetail: "明确替身持久化后启动失败" });
      }
      throw new Error("明确替身 runner 启动失败");
    };
    const receipt = await h.service.dispatch(dm, requestId, input); await h.runner.idle();
    await new Promise(resolve => setImmediate(resolve));
    const fact = h.service.receipt(requestId)!;
    assert.equal(fact.state, "accepted"); assert.equal(fact.startup, "failed"); assert.ok(fact.taskId);
    assert.equal(!!fact.runId, partiallySaved); assert.equal(fact.conversationId, receipt.conversationId);
    assert.deepEqual(await h.service.dispatch(dm, requestId, input), fact);
    assert.equal(h.storage.listWandTasks().length, 1); assert.equal(h.storage.conversationTasks(dm).length, 1);
    h.runner.start = start;
    const next = await h.service.dispatch(fact.conversationId, randomUUID(), { ...input, continueTaskId: fact.taskId }); await h.runner.idle();
    assert.equal(next.taskId, fact.taskId); assert.equal(next.conversationId, fact.conversationId);
    assert.equal(h.storage.listWandTasks().length, 1);
  }
});

test("F1 failure inside acceptance transaction rolls back identifiers/card and remains a definite rejection", async t => {
  const h = conversationHarness(t), requestId = randomUUID(), dm = employeeConversationId("e_test_1");
  const save = h.storage.saveConversationRequest.bind(h.storage);
  h.storage.saveConversationRequest = request => {
    if (request.id === requestId && request.receipt.state === "accepted") throw new Error("明确替身接受事务写入失败");
    save(request);
  };
  const receipt = await h.service.dispatch(dm, requestId, { title: "未接受", description: "事务回滚", workspaceId: h.workspace.id });
  assert.equal(receipt.state, "rejected"); assert.equal(receipt.conversationId, dm);
  assert.equal(receipt.taskId, undefined); assert.equal(receipt.startup, undefined);
  assert.equal(h.storage.listWandTasks().length, 0); assert.equal(h.storage.listConversations().length, 0);
  assert.equal(h.storage.conversationEvents(dm).length, 0); assert.equal(h.executions.length, 0);
  assert.deepEqual(h.service.receipt(requestId), receipt);
  assert.equal((await h.service.dispatch(dm, randomUUID(), { description: "工作项目明确拒收", workspaceId: "missing" })).state, "rejected");
});

test("F1 first empty group and accepted receipt are one atomic commit", async t => {
  const h = conversationHarness(t), requestId = randomUUID();
  const save = h.storage.saveConversationRequest.bind(h.storage);
  h.storage.saveConversationRequest = request => {
    if (request.id === requestId && request.receipt.state === "accepted") throw new Error("明确替身空群接受事务失败");
    save(request);
  };
  const receipt = await h.service.createGroup(requestId, { employeeIds: ["e_test_1"] });
  assert.equal(receipt.state, "rejected"); assert.equal(receipt.conversationId, "");
  assert.equal(h.storage.listConversations().length, 0); assert.equal(h.sessions.size, 0);
});
