import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationTurn, ToolUseBlock } from "../src/types.js";
import type { ConversationDetail } from "../src/conversation-types.js";
import { activityAnswerText, activityOperationCurrent, activityResults, activitySessionOwners, activitySource, activityToolKey,
  pendingActivityQuestions, type ActivitySession, type ActivityOperation } from "../src/web-ui/react/conversations/activity-model.js";
import { conversationActivityRepository as repository } from "../src/web-ui/react/conversations/activity-repository.js";

const question: ToolUseBlock = { type: "tool_use", id: "question-1", name: "request_user_input", input: {},
  semantic: { kind: "question_request", questions: [{ question: "在哪个环境执行？", multiSelect: false, options: [{ label: "测试环境" }, { label: "本机" }] }] } };
const turn = (sessionId: string, content: ConversationTurn["content"], role: ConversationTurn["role"] = "assistant"): ConversationTurn => ({
  role, author: { id: sessionId, name: sessionId, sessionId }, content,
});
function session(id: string, overrides: Partial<ActivitySession> = {}): ActivitySession {
  return { id, status: "idle", sessionKind: "structured", messages: [turn(id, [question])], ...overrides };
}
const answer: ActivityOperation = { kind: "answer", toolId: question.id, input: "测试环境" };

test("tool results pair across turns only inside the original session", () => {
  const turns = [turn("alice", [question]), turn("bob", [question]),
    turn("bob", [{ type: "tool_result", tool_use_id: question.id, content: "Bob result" }], "user")];
  const results = activityResults(turns, "channel");
  assert.equal(results.get(activityToolKey("alice", question.id)), undefined);
  assert.equal(results.get(activityToolKey("bob", question.id))?.content, "Bob result");
  const alice = session("alice", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: question.id, content: "Alice result" }] }] });
  assert.equal(activityResults(turns, "channel", [alice]).get(activityToolKey("alice", question.id))?.content, "Alice result");
  assert.equal(activitySource({ role: "assistant", content: [], conversationTarget: { taskId: "t", runId: "r" } }, "channel"), null);
  assert.equal(activitySource({ role: "assistant", content: [] }, "channel"), "channel");
});

test("only the current unanswered question accepts input; completed and historical cards do not", () => {
  const live = session("live");
  assert.equal(pendingActivityQuestions(live)[0]?.id, question.id);
  for (const messages of [
    [...live.messages!, turn("live", [{ type: "text", text: "新的问题" }], "user")],
    [...live.messages!, turn("live", [{ type: "text", text: "新的回复" }])],
    [...live.messages!, turn("live", [{ type: "tool_result", tool_use_id: question.id, content: "回答" }], "user")],
  ]) assert.deepEqual(pendingActivityQuestions({ ...live, messages }), []);
  assert.deepEqual(pendingActivityQuestions({ ...live, status: "stopped" }), []);
  assert.equal(activityOperationCurrent({ ...live, pendingEscalation: { requestId: "new", scope: "run_command", runner: "json", source: "tool_permission_request", reason: "确认" } },
    { kind: "permission", requestId: "old", resolution: "approve_once" }), false);
});

test("answers support choices and freeform without modifying the chat draft", () => {
  const questions = question.semantic!.kind === "question_request" ? question.semantic!.questions : [];
  assert.equal(activityAnswerText(questions, {}, {}), null);
  assert.equal(activityAnswerText(questions, { 0: ["本机"] }, { 0: "只读查看" }), "本机；只读查看");
  assert.equal(activityAnswerText(questions, {}, { 0: "  自己的回答  " }), "自己的回答");
  repository.editAnswer("draft-session", "draft-question", () => ({ selections: { 0: ["本机"] }, freeform: { 0: "只读" } }), "original-schema");
  assert.equal(repository.answerDraft("draft-session", "draft-question", "original-schema").freeform[0], "只读");
  assert.deepEqual(repository.answerDraft("draft-session", "draft-question", "changed-schema"), { selections: {}, freeform: {} });
});

test("active group owners use real step sessions and never the relay session", () => {
  const detail = { id: "group", kind: "group", communicationSessionId: "communication", messages: [],
    runDetails: [{ run: { id: "run", status: "running", chatSessionId: "relay", team: { members: [{ id: "member", name: "研究员" }] } },
      steps: [{ sessionId: "worker", status: "running", memberId: "member" }, { sessionId: "old-worker", status: "done" }] }] } as unknown as ConversationDetail;
  assert.deepEqual([...activitySessionOwners(detail).keys()], ["communication", "worker"]);
  assert.deepEqual([...activitySessionOwners(detail, { taskId: "task", runId: "run" }).keys()], ["worker"]);
  assert.deepEqual([...activitySessionOwners({ ...detail, dissolvedAt: "now" }).keys()], []);
  assert.deepEqual([...activitySessionOwners({ ...detail, deleting: true }).keys()], []);
});

test("activity writes keep source ownership, prevent duplicate requests, and preserve unknown delivery", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const scenario of ["structured", "pty", "reject", "unknown", "invalid-ack", "pty-partial", "pty-stop", "pending-delivery", "stale", "switched", "permission"] as const) {
    const id = `session-${scenario}`;
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const pty = scenario.startsWith("pty") || scenario === "pending-delivery";
    let current = true;
    const operation: ActivityOperation = scenario === "permission" ? { kind: "permission", requestId: "permission-1", resolution: "approve_once" }
      : scenario === "pty-stop" ? { kind: "stop", anchor: "pty-turn" } : answer;
    globalThis.fetch = (async (url, init) => {
      const route = String(url);
      assert.ok(route.startsWith(`/api/sessions/${id}`), "every read and write belongs to the captured session");
      if (init?.method !== "POST") {
        if (scenario === "switched") current = false;
        const fresh = session(id, { sessionKind: pty ? "pty" : "structured", ...(scenario === "stale" ? { messages: [] } : {}),
          ...(scenario === "pty-stop" ? { status: "running", provider: "claude", ptyBusy: true, ptyTurnStartedAt: "pty-turn" } : {}),
          ...(scenario === "permission" ? { pendingEscalation: { requestId: "permission-1", scope: "run_command", source: "tool_permission_request", runner: "json", reason: "确认" } } : {}) });
        return Response.json(fresh);
      }
      posts.push({ url: route, body: JSON.parse(String(init.body)) });
      if (scenario === "reject" || scenario === "pty-partial" && posts.length === 2) return Response.json({ error: "拒绝" }, { status: 403 });
      if (scenario === "unknown") return Response.json({ error: "超时" }, { status: 504 });
      if (scenario === "invalid-ack") return new Response("broken-json", { status: 202 });
      if (scenario === "pending-delivery") return Response.json({ accepted: true, deliveryConfirmed: false }, { status: 202 });
      return Response.json({ accepted: true }, { status: 202 });
    }) as typeof fetch;
    const first = repository.submit(id, operation, () => current);
    await repository.submit(id, operation, () => current);
    await first;
    if (scenario === "stale" || scenario === "switched") { assert.equal(posts.length, 0); continue; }
    assert.equal(posts.length, scenario === "pty" || scenario === "pty-partial" ? 2 : 1);
    if (scenario === "pty") assert.deepEqual(posts.map(post => post.body.input), ["测试环境", "\r"]);
    if (scenario === "structured") assert.equal(posts[0]?.body.respondImmediately, true);
    if (scenario === "pty-stop") {
      assert.ok(posts[0]?.url.endsWith("/input"));
      assert.deepEqual(posts[0]?.body, { input: "\u001b", view: "chat", shortcutKey: "esc", responseMode: "accepted" });
    }
    if (scenario === "permission") {
      assert.ok(posts[0]?.url.endsWith("/escalations/permission-1/resolve"));
      assert.deepEqual(posts[0]?.body, { resolution: "approve_once" });
    }
    const phase = repository.submission(id, operation)?.phase;
    assert.equal(phase, scenario === "reject" ? "failed" : ["unknown", "invalid-ack", "pty-partial", "pending-delivery"].includes(scenario) ? "unknown" : "sent");
    if (phase !== "failed") {
      const count = posts.length;
      await repository.submit(id, operation, () => true);
      assert.equal(posts.length, count, "unknown or accepted requests must never be sent twice");
    }
  }
});
