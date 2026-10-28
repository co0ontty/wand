import assert from "node:assert/strict";
import test from "node:test";
import { findTodoTurnSource, observeTodoTurn, todoExecutionPresentation, type TodoTurnEvidence, type TodoTurnSession } from "../src/web-ui/browser/todo-execution.js";
import type { ConversationTurn } from "../src/types.js";

const user = (requestId = "request-A"): ConversationTurn => ({ role: "user", requestId, content: [{ type: "text", text: "same input" }] });
const assistant: ConversationTurn = { role: "assistant", content: [{ type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [{ content: "done", status: "completed" }, { content: "last", status: "in_progress" }] } }] };
const session = (patch: Partial<TodoTurnSession> = {}): TodoTurnSession => ({ id: "A", status: "running", messages: [user(), assistant], structuredState: { inFlight: true, activeRequestId: "request-A" }, ...patch });
const event = (s: TodoTurnSession, extra = {}, type = "output") => ({ type, data: { messages: s.messages, structuredState: s.structuredState, ...extra } });
const view = (s: TodoTurnSession, evidence?: TodoTurnEvidence, connected = true) => todoExecutionPresentation(s, findTodoTurnSource(s)!, evidence, connected);

test("Todo source requires an accepted, identifiable user boundary and keeps absolute identity across history windows", () => {
  const full = session({ messages: [user("older"), { role: "assistant", content: [] }, user(), assistant] });
  const suffix = session({ messages: full.messages!.slice(2), messageOffset: 2 });
  assert.equal(findTodoTurnSource(full)?.key, findTodoTurnSource(suffix)?.key);
  assert.equal(findTodoTurnSource(session({ messages: [assistant] })), null);
  assert.equal(findTodoTurnSource(session({ messages: [{ role: "user", content: [{ type: "text", text: "legacy" }] }, assistant] })), null);
  assert.equal(findTodoTurnSource(session({ leadingBlockOffset: 1 })), null);
  assert.equal(findTodoTurnSource(session({ messages: [user(), assistant, { role: "user", content: [] }] })), null);
});

test("Same text on a new accepted input is a different turn; draft and queue placeholders are not", () => {
  const old = findTodoTurnSource(session())!;
  const next = session({ messages: [user(), assistant, user("request-B")], structuredState: { inFlight: false } });
  assert.notEqual(findTodoTurnSource(next)?.key, old.key);
  assert.equal(findTodoTurnSource(next)?.startIndex, 3);
  const queued = { role: "user", content: [{ type: "text", text: "queued", __queued: true }] } as any;
  assert.equal(findTodoTurnSource(session({ messages: [user(), assistant, queued] }))?.key, old.key);
  assert.notEqual(findTodoTurnSource(session({ id: "B" }))?.key, old.key);
  assert.equal(findTodoTurnSource(session({ structuredState: { inFlight: true, activeRequestId: "accepted-but-not-yet-in-transcript" } })), null);
});

test("Tool-result answers stay within the logical Todo turn, while the accepted request identity advances", () => {
  const source = findTodoTurnSource(session())!;
  const answered: ConversationTurn = { role: "user", requestId: "answer-B", content: [{ type: "tool_result", tool_use_id: "question", content: "chosen", is_error: false }] };
  const s = session({ messages: [user(), assistant, answered], structuredState: { inFlight: true, activeRequestId: "answer-B" } });
  assert.equal(findTodoTurnSource(s)?.key, source.key);
  assert.equal(findTodoTurnSource(s)?.requestId, "answer-B");
  assert.equal(findTodoTurnSource(s)?.startIndex, 1);
});

test("Stopped/done/failed are bound to a continuously observed real request, never idle or an ended event name", () => {
  const active = session();
  const evidence = observeTodoTurn(undefined, active, event(active));
  assert.equal(view(active, evidence).kind, "running");
  const idle = session({ status: "idle", structuredState: { inFlight: false, activeRequestId: null } });
  assert.equal(view(idle).kind, "unknown");
  assert.equal(observeTodoTurn(undefined, idle, event(idle, { turnOutcome: "stopped" }, "ended")), undefined);
  for (const [outcome, expected] of [["stopped", "stopped"], ["failed", "failed"], ["done", "ended"]] as const) {
    const terminal = observeTodoTurn(evidence, idle, event(idle, { turnOutcome: outcome }, "ended"));
    assert.equal(view(idle, terminal).kind, expected);
  }
  assert.equal(observeTodoTurn(evidence, idle, event(idle, {}, "ended"))?.outcome, undefined);
});

test("New source, wrong request, reconnect, and contradictory live state cannot borrow a terminal reason", () => {
  const active = session();
  const evidence = observeTodoTurn(undefined, active, event(active));
  const idle = session({ status: "idle", structuredState: { inFlight: false } });
  assert.equal(observeTodoTurn(evidence, idle, event(idle, { turnOutcome: "stopped", terminalRequestId: "wrong" }, "ended"))?.outcome, undefined);
  assert.equal(observeTodoTurn(evidence, idle, event(idle, { turnOutcome: "stopped", messages: undefined }, "ended"))?.outcome, undefined);
  const ended = observeTodoTurn(evidence, idle, event(idle, { turnOutcome: "stopped" }, "ended"));
  assert.equal(observeTodoTurn(ended, idle, event(idle, {}, "init")), undefined);
  assert.equal(view(active, ended).kind, "unknown");
  assert.equal(view(idle, ended, false).kind, "unknown");
  const next = session({ messages: [user(), assistant, user("request-B")], structuredState: { inFlight: true, activeRequestId: "request-B" } });
  assert.equal(observeTodoTurn(ended, next)?.outcome, undefined);
  assert.equal(view(next, ended).kind, "running");
  assert.equal(observeTodoTurn(ended, session({ id: "B" })), undefined);
});

test("Waiting requires a current unanswered protocol question and an execution that has yielded, terminal evidence wins", () => {
  const question: ConversationTurn = { role: "assistant", content: [{ type: "tool_use", id: "ask", name: "question", input: {}, semantic: { kind: "question_request", questions: [] } }] };
  const s = session({ messages: [user(), assistant, question], structuredState: { inFlight: false } });
  assert.equal(view(s).kind, "waiting");
  assert.equal(view({ ...s, status: "idle" }).kind, "unknown");
  assert.equal(view({ ...s, structuredState: { inFlight: true } }).kind, "running");
  assert.equal(view({ ...s, permissionBlocked: true }).kind, "permission");
  const answered: ConversationTurn = { role: "user", requestId: "answer-B", content: [{ type: "tool_result", tool_use_id: "ask", content: "yes" }] };
  assert.equal(view({ ...s, messages: [...s.messages!, answered] }).kind, "unknown");
  const active = session({ messages: s.messages });
  const marker = observeTodoTurn(undefined, active, event(active));
  const idle = { ...s, status: "idle" };
  const stopped = observeTodoTurn(marker, idle, event(idle, { turnOutcome: "stopped" }, "ended"));
  assert.equal(view(idle, stopped).kind, "stopped");
});

test("Todo completeness is orthogonal to running/done/acceptance, history never rewrites tool statuses", () => {
  const active = session();
  const original = JSON.stringify(active.messages);
  assert.equal(view(active).kind, "running");
  const evidence = observeTodoTurn(undefined, active, event(active));
  const idle = session({ status: "idle", structuredState: { inFlight: false } });
  const terminal = observeTodoTurn(evidence, idle, event(idle, { turnOutcome: "done" }, "ended"));
  assert.equal(view(idle, terminal).kind, "ended");
  assert.match(view(idle, terminal).note, /未完成项不自动补全/);
  assert.equal(JSON.stringify(active.messages), original);
  assert.equal(view({ ...active, archived: true }).kind, "unknown");
});
