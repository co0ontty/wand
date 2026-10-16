import assert from "node:assert/strict";
import test from "node:test";
import type { AiTeamRun, AiTeamStep } from "../src/ai-team-types.js";
import { EmployeeImLifecycle } from "../src/employee-im-lifecycle.js";
import type { EmployeeImEvent } from "../src/employee-im-types.js";
import type { SessionSnapshot } from "../src/types.js";
function fixture() {
  const sessions = new Map<string, SessionSnapshot>();
  const sent: { employeeId: string; event: EmployeeImEvent; context: unknown }[] = [];
  let steps: AiTeamStep[] = [];
  const lifecycle = new EmployeeImLifecycle({ im: { notify: (employeeId, event, context) => { sent.push({ employeeId, event, context }); } },
    getSession: id => sessions.get(id) ?? null, getRunSteps: () => steps });
  const base = { id: "s1", employeeId: "e1", title: "任务", sessionKind: "structured", status: "idle", completionRevision: 0,
    structuredState: { runner: "pi-cli-json", lastError: null, inFlight: false, activeRequestId: null }, messages: [] } as unknown as SessionSnapshot;
  sessions.set(base.id, base);
  const change = (patch: Partial<SessionSnapshot>, type: "status" | "ended" | "started" = "status", data = {}) => {
    sessions.set(base.id, { ...sessions.get(base.id)!, ...patch }); lifecycle.ingest({ type, sessionId: base.id, data });
  };
  return { lifecycle, sessions, base, sent, change, events: () => sent.map(item => item.event), setSteps: (value: AiTeamStep[]) => { steps = value; } };
}

test("actual turn starts, durable completions, failures/stops dedupe; idle or process start is not completion", () => {
  const f = fixture(); f.lifecycle.seed([f.base]);
  f.change({}, "started"); assert.deepEqual(f.events(), []);
  f.change({ status: "running", structuredState: { ...f.base.structuredState!, inFlight: true } });
  f.change({}); assert.deepEqual(f.events(), ["task_started"]);
  f.change({ status: "idle", structuredState: f.base.structuredState }); assert.deepEqual(f.events(), ["task_started"]);
  f.change({}, "ended", { completionRevision: 1 });
  f.change({}, "ended", { completionRevision: 1 });
  f.change({ status: "failed", endedAt: "a" }); f.change({}, "ended");
  f.change({ status: "running", structuredState: { ...f.base.structuredState!, inFlight: true } });
  f.change({ status: "stopped", endedAt: "b" }, "ended");
  assert.deepEqual(f.events(), ["task_started", "task_completed", "task_failed", "task_started", "task_stopped"]);
  assert.equal(JSON.stringify(f.sent).includes("lastError"), false); f.lifecycle.dispose();
});

test("queue/permission/candidate edges are isolated, and recovered states do not replay history", () => {
  const f = fixture();
  f.lifecycle.seed([{ ...f.base, permissionBlocked: true, completionRevision: 5, queuedMessages: ["old"], status: "running", structuredState: { ...f.base.structuredState!, inFlight: true } }]);
  f.change({ permissionBlocked: true, completionRevision: 5, queuedMessages: ["old"], status: "running", structuredState: { ...f.base.structuredState!, inFlight: true } });
  assert.deepEqual(f.events(), []);
  f.change({ permissionBlocked: false }); f.change({ permissionBlocked: true }); f.change({});
  f.change({ queuedMessages: ["old", "new"] }); f.change({});
  f.change({ employeeCandidateIndex: 1 }); f.change({});
  assert.deepEqual(f.events(), ["waiting_permission", "message_queued", "candidate_switched"]);
  f.sessions.set("s2", { ...f.base, id: "s2", employeeId: "e2", status: "running", structuredState: { ...f.base.structuredState!, inFlight: true } });
  f.lifecycle.ingest({ type: "status", sessionId: "s2" }); assert.equal(f.sent.at(-1)?.employeeId, "e2");
  f.sessions.set("s3", { ...f.base, id: "s3", autoRecovered: true, status: "failed", completionRevision: 5 });
  f.lifecycle.ingest({ type: "ended", sessionId: "s3" }); assert.equal(f.sent.filter(item => (item.context as { sessionId: string }).sessionId === "s3").length, 0);
  f.lifecycle.dispose();
});

test("semantic questions and real plan steps notify, arbitrary assistant text cannot trigger notifications", () => {
  const f = fixture(); f.lifecycle.seed([f.base]);
  f.change({ status: "running", structuredState: { ...f.base.structuredState!, inFlight: true } });
  f.change({ messages: [{ role: "user", content: [{ type: "text", text: "input" }] }, { role: "assistant", content: [{ type: "text", text: "任务完成，等待用户输入，completed" }] }] });
  assert.deepEqual(f.events(), ["task_started"]); // A late first message is not another start.
  f.change({ messages: [{ role: "user", content: [{ type: "text", text: "input" }] }, { role: "assistant", content: [
    { type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: "选择", options: [{ label: "A" }] }] } },
    { type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [{ id: "1", content: "一步", status: "pending" }] } },
    { type: "tool_result", tool_use_id: "todo", content: "ok" },
  ] }] });
  assert.equal(f.events().at(-1), "waiting_input"); f.change({});
  const messages = structuredClone(f.sessions.get("s1")!.messages!);
  const todo = messages[1].content[1]; if (todo.type === "tool_use") todo.input = { todos: [{ id: "1", content: "一步", status: "completed" }] };
  f.change({ messages }); f.change({}, "ended");
  assert.equal(f.events().filter(event => event === "waiting_input").length, 1);
  assert.equal(f.events().filter(event => event === "step_completed").length, 1);
  const failed = structuredClone(messages);
  failed[1].content = [{ type: "tool_use", id: "bad", name: "TodoWrite", input: { todos: [{ id: "2", content: "失败步骤", status: "completed" }] } },
    { type: "tool_result", tool_use_id: "bad", content: "failed", is_error: true }];
  f.change({ messages: failed });
  assert.equal(f.events().filter(event => event === "step_completed").length, 1);
  f.lifecycle.dispose();
});

test("team statuses and asynchronous saved step completion notify the correct leader/member once", () => {
  const f = fixture();
  const run = { id: "r1", status: "running", chatSessionId: "chat", team: { name: "测试团队", members: [{ id: "lead", isLeader: true, employeeId: "e1" }, { id: "work", employeeId: "e2" }] } } as AiTeamRun;
  const step = { id: "step", memberId: "work", status: "running", sessionId: "s2", title: "步骤" } as AiTeamStep;
  f.setSteps([step]); f.lifecycle.seed([], [run]); f.lifecycle.ingestRun(run); assert.deepEqual(f.events(), []);
  f.lifecycle.ingestRun({ ...run, status: "awaiting_approval" });
  f.lifecycle.ingestRun({ ...run, status: "waiting_user" });
  f.lifecycle.ingestRun(run);
  f.setSteps([{ ...step, status: "done" }]); f.lifecycle.ingestRun(run); f.lifecycle.ingestRun(run);
  f.lifecycle.ingestRun({ ...run, status: "done" }); f.lifecycle.ingestRun({ ...run, status: "done" });
  assert.deepEqual(f.events(), ["waiting_permission", "waiting_input", "team_started", "step_completed", "team_completed"]);
  assert.equal(f.sent.find(item => item.event === "step_completed")?.employeeId, "e2"); f.lifecycle.dispose();
});

test("a structured stop preserves idle session semantics but explicitly notifies once without success", () => {
  const f = fixture(); f.lifecycle.seed([f.base]);
  f.change({ status: "running", structuredState: { ...f.base.structuredState!, inFlight: true } });
  f.change({ status: "idle", exitCode: null, endedAt: null, structuredState: f.base.structuredState }, "ended", { turnOutcome: "stopped" });
  f.change({}, "ended", { turnOutcome: "stopped" }); f.change({});
  assert.deepEqual(f.events(), ["task_started", "task_stopped"]); f.lifecycle.dispose();
});

test("short-lived queue events and successive permission request IDs are not lost by output coalescing", () => {
  const f = fixture(); f.lifecycle.seed([f.base]);
  f.sessions.set("s1", { ...f.base, queuedMessages: ["pending"] });
  f.lifecycle.ingest({ type: "output", sessionId: "s1", data: { queuedMessages: ["pending"] } });
  f.change({ queuedMessages: [] });
  f.change({ pendingEscalation: { requestId: "a" } as SessionSnapshot["pendingEscalation"] });
  f.change({ pendingEscalation: { requestId: "b" } as SessionSnapshot["pendingEscalation"] }); f.change({});
  assert.deepEqual(f.events(), ["message_queued", "waiting_permission", "waiting_permission"]); f.lifecycle.dispose();
});

test("PTY completion requires durable receipt and busy transitions, and notification exceptions cannot break execution", () => {
  const f = fixture(); f.lifecycle.seed([{ ...f.base, sessionKind: "pty", status: "running" }]);
  f.change({ sessionKind: "pty", status: "running", providerCliActive: true }); assert.deepEqual(f.events(), []);
  f.change({ ptyBusy: true }); f.change({ ptyBusy: false }); assert.deepEqual(f.events(), ["task_started"]);
  f.change({}, "status", { completionRevision: 1 }); assert.equal(f.events().at(-1), "task_completed");
  f.change({ providerCliActive: false, providerCliExitCode: 1 }); f.change({});
  assert.equal(f.events().filter(event => event === "task_failed").length, 1); f.lifecycle.dispose();
  const lifecycle = new EmployeeImLifecycle({ im: { notify: () => { throw new Error("failure"); } }, getSession: () => ({ ...f.base, status: "failed" }) });
  assert.doesNotThrow(() => lifecycle.ingest({ type: "ended", sessionId: "s1" })); lifecycle.dispose();
});
