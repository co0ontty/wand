import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { employeeConversationId } from "../src/conversation-types.js";
import { ConversationService } from "../src/conversation-service.js";
import { conversationSessionPreview } from "../src/conversation-session-preview.js";
import { WandStorage } from "../src/storage.js";

test("identical DM messages create fresh contexts, never tasks/groups; replaying a request does not send twice", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1"), request = randomUUID();
  const [a, b] = await Promise.all([h.service.send(dm, request, "整理发布清单", null), h.service.send(dm, randomUUID(), "整理发布清单", null)]);
  assert.equal(a.state, "accepted"); assert.equal(b.state, "accepted");
  assert.ok(a.sessionId); assert.ok(b.sessionId); assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.conversationId, dm); assert.equal(b.conversationId, dm);
  assert.deepEqual(await h.service.send(dm, request, "整理发布清单", null), a);
  assert.equal(h.storage.listWandTasks().length, 0); assert.equal(h.storage.listAiTeamRuns().length, 0);
  assert.equal(h.storage.listConversations().filter(item => item.kind === "group").length, 0);
  assert.equal(h.sent.length, 2); assert.ok(h.sent.every(item => item.text === "整理发布清单"));
  const turns = h.service.detail(dm).messages;
  assert.deepEqual(turns.map(turn => turn.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(turns.filter(turn => turn.sessionLink).map(turn => turn.sessionLink!.sessionId), [a.sessionId, b.sessionId]);
  assert.deepEqual(turns.filter(turn => turn.sessionLink).map(turn => turn.author?.sessionId), [a.sessionId, b.sessionId], "older clients keep an exact source-session entry");
  assert.ok(turns.filter(turn => turn.sessionLink).every(turn => turn.content.some(block => block.type === "text" && block.text.includes("对应会话"))));
  assert.ok(h.storage.conversationEvents(dm).filter(turn => turn.sessionLink).every(turn => turn.content.length === 0 && !turn.author?.sessionId), "compatibility is a read projection, not another writable association");
  for (const receipt of [a, b]) {
    const session = h.sessions.get(receipt.sessionId!)!;
    assert.equal(session.claudeSessionId, null); assert.equal(session.systemPrompt, "仅员工 1 的角色");
    assert.equal(session.employeeId, "e_test_1"); assert.equal(session.workspaceId, h.workspace.id);
    assert.equal(session.workspaceTaskId, undefined); assert.equal(session.employeeCandidates?.[0]?.engine, "sdk");
    assert.equal(session.messages?.filter(turn => turn.role === "user").length, 1);
  }
});

test("each fixed preview reads its exact session and survives reload without persisting a second transcript", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  const a = await h.service.send(dm, randomUUID(), "消息 A", null);
  const b = await h.service.send(dm, randomUUID(), "消息 B", null);
  const stored = JSON.stringify(h.storage.conversationEvents(dm));
  const session = h.sessions.get(a.sessionId!)!;
  const updated = { ...session, messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: "流式 A\n".repeat(2000) + "最新进度 A" }] }] };
  h.sessions.set(session.id, updated); h.storage.saveSession(updated);
  const cards = () => h.service.detail(dm).messages.filter(turn => turn.sessionLink);
  assert.match(cards()[0]?.sessionPreview?.text ?? "", /最新进度 A/);
  assert.ok(cards()[0]!.sessionPreview!.text.length <= 4000);
  assert.doesNotMatch(cards()[1]?.sessionPreview?.text ?? "", /最新进度 A/);
  assert.equal(JSON.stringify(h.storage.conversationEvents(dm)), stored);
  const reopened = new WandStorage(path.join(path.dirname(h.cwd), "wand.db")); t.after(() => reopened.close());
  assert.deepEqual(reopened.conversationSessionIds(dm), [a.sessionId, b.sessionId]);
  h.sessions.delete(a.sessionId!); h.storage.deleteSession(a.sessionId!);
  assert.equal(cards()[0]?.sessionPreview?.status, "unavailable");
  assert.equal(cards()[1]?.sessionPreview?.status, "done"); assert.equal(h.service.detail(dm).messages.length, 4);
});

test("DM uses explicit/default cwd, validates missing configuration, and legacy task forms no longer create groups", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  const cwd = path.join(h.cwd, "another"); mkdirSync(cwd);
  const a = await h.service.send(dm, randomUUID(), "新目录消息", null, cwd);
  assert.equal(h.sessions.get(a.sessionId!)?.cwd, cwd);
  await h.service.send(dm, randomUUID(), "同目录消息", null, cwd);
  assert.equal(h.storage.listWorkspaces().filter(item => item.cwd === cwd).length, 1);
  const legacy = await h.service.dispatch(dm, randomUUID(), { description: "旧版表单", workspaceId: h.workspace.id });
  assert.equal(legacy.state, "accepted"); assert.ok(legacy.sessionId); assert.equal(legacy.taskId, undefined);
  assert.equal(h.storage.listConversations().length, 1);
  h.config.defaultCwd = "";
  const count = h.sessions.size;
  const rejected = await h.service.send(dm, randomUUID(), "不能猜测目录", null);
  assert.equal(rejected.state, "rejected"); assert.match(rejected.error!, /目录/);
  assert.equal(h.sessions.size, count);
});

test("long DM and attachment envelope remain intact in model input; the link title never contains uploaded paths", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  const input = "[附件已上传，请查看以下文件:\n/tmp/fixture-only.png\n]\n\n分析截图\n" + "详细要求".repeat(1500);
  const receipt = await h.service.send(dm, randomUUID(), input, null);
  assert.equal(receipt.state, "accepted", receipt.error); assert.equal(h.sent[0]?.text, input);
  assert.deepEqual(h.service.detail(dm).messages[0]?.content, [{ type: "text", text: input }]);
  assert.equal(h.service.detail(dm).messages[1]?.sessionLink?.title, "分析截图");
});

test("model failure after acceptance retains both messages; replay only reconciles and never repeats input", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1"), request = randomUUID();
  h.structured.sendMessage = async () => { throw new Error("明确测试替身执行失败"); };
  await h.service.send(dm, request, "消息原文", null); await new Promise(resolve => setImmediate(resolve));
  const receipt = h.service.receipt(request)!;
  assert.equal(receipt.state, "accepted"); assert.equal(receipt.startup, "failed");
  const turns = h.service.detail(dm).messages;
  assert.equal(turns.length, 2); assert.equal(turns[1]?.sessionPreview?.status, "failed");
  assert.match(turns[1]?.sessionPreview?.text ?? "", /执行失败/);
  assert.deepEqual(await h.service.send(dm, request, "消息原文", null), receipt);
  assert.equal(h.sessions.size, 1); assert.equal(h.storage.listWandTasks().length, 0);
});

test("an acceptance rollback leaves no session/link/input and reports a definite rejection", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1"), request = randomUUID();
  const append = h.storage.appendConversationEvent.bind(h.storage);
  h.storage.appendConversationEvent = (id, turn) => { if (turn.sessionLink) throw new Error("link write failed"); append(id, turn); };
  const receipt = await h.service.send(dm, request, "原子消息", null);
  assert.equal(receipt.state, "rejected"); assert.equal(receipt.sessionId, undefined);
  assert.equal(h.sessions.size, 0); assert.equal(h.storage.loadSessionsSlim().length, 0);
  assert.equal(h.storage.listConversations().length, 0); assert.equal(h.storage.conversationEvents(dm).length, 0);
  assert.equal(h.sent.length, 0);
});

test("session previews coalesce streaming events and isolate conversation identity and deletion", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  const updates: unknown[] = [];
  const service = new ConversationService({ storage: h.storage, structured: h.structured, runner: h.runner, config: h.config,
    notifySession: update => updates.push(update), deleteSession: id => { h.sessions.delete(id); h.storage.deleteSession(id); } });
  t.after(() => service.dispose());
  const receipt = await service.send(dm, randomUUID(), "实时消息", null);
  for (let n = 0; n < 50; n++) service.ingestSessionEvent({ type: "output", sessionId: receipt.sessionId!, data: {} });
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { conversationId: dm, sessionId: receipt.sessionId, preview: service.detail(dm).messages[1]?.sessionPreview });
  service.ingestSessionEvent({ type: "output", sessionId: receipt.sessionId!, data: {} });
  await service.remove(dm); await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(updates.length, 1); assert.equal(h.sessions.has(receipt.sessionId!), false);
});

test("session status, permission and stop are factual, not inferred from a new IM message", async t => {
  const h = conversationHarness(t), receipt = await h.service.send(employeeConversationId("e_test_1"), randomUUID(), "状态", null);
  const session = h.sessions.get(receipt.sessionId!)!;
  assert.equal(conversationSessionPreview({ ...session, status: "running" }).status, "running");
  assert.equal(conversationSessionPreview({ ...session, status: "stopped" }).status, "stopped");
  assert.equal(conversationSessionPreview({ ...session, status: "failed" }).status, "failed");
  assert.equal(conversationSessionPreview(null).status, "unavailable");
  const failedReceipt = { startup: "failed" as const, error: "首轮失败" };
  assert.equal(conversationSessionPreview({ ...session, status: "running" }, failedReceipt).status, "running");
  const continued = { ...session, messages: [...session.messages!,
    { role: "user" as const, content: [{ type: "text" as const, text: "明确在原会话继续" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "本轮已完成" }] }] };
  assert.deepEqual(conversationSessionPreview(continued, failedReceipt), { status: "done", text: "本轮已完成" });
  const answered = { ...session, messages: [{ role: "assistant" as const, content: [
    { type: "tool_use" as const, id: "ask", name: "AskUserQuestion", input: {} },
    { type: "tool_result" as const, tool_use_id: "ask", content: "回答", is_error: false },
  ] }] };
  assert.equal(conversationSessionPreview(answered).status, "done", "answered questions cannot keep a session waiting");
  assert.doesNotMatch(conversationSessionPreview(answered).text, /正在调用/);
});
