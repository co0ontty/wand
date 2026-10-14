import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import express from "express";

import { ScheduledTaskConflictError, ScheduledTaskService } from "../src/scheduled-task-service.js";
import type { ScheduledTaskRun } from "../src/scheduled-task-types.js";
import { nextScheduledTime } from "../src/scheduled-task-time.js";
import { registerScheduledTaskRoutes } from "../src/server-scheduled-task-routes.js";
import { WandStorage } from "../src/storage.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

function harness(t: Parameters<typeof conversationHarness>[0]) {
  const h = conversationHarness(t);
  let clock = new Date("2030-01-01T00:00:00.000Z");
  const scheduled = new ScheduledTaskService({ storage: h.storage, conversations: h.service,
    getSession: id => h.sessions.get(id) ?? h.storage.getSession(id), defaultCwd: () => h.config.defaultCwd, now: () => clock });
  return { ...h, scheduled, now: () => clock, setTime: (iso: string) => { clock = new Date(iso); },
    input: (requestId = "schedule-test-1") => ({ requestId, employeeId: "e_test_1", prompt: "  原样的帖子\n\n请整理  ",
      schedule: { kind: "once" as const, runAt: "2030-01-01T01:00:00.000Z" } }) };
}

test("schedules preserve prompt, use immutable creation idempotency and protect edits with revision", t => {
  const h = harness(t);
  const input = h.input();
  const task = h.scheduled.create(input);
  assert.equal(task.prompt, input.prompt);
  assert.equal(h.sent.length, 0);
  assert.equal(h.scheduled.create(input).id, task.id);
  const changed = h.scheduled.update(task.id, { revision: task.revision, title: "修改后的名称" });
  assert.equal(changed.revision, 2);
  assert.equal(h.scheduled.create(input).title, "修改后的名称");
  assert.throws(() => h.scheduled.create({ ...input, prompt: "另一份内容" }), ScheduledTaskConflictError);
  assert.throws(() => h.scheduled.update(task.id, { revision: 1, enabled: false }), ScheduledTaskConflictError);
  assert.throws(() => h.scheduled.create({ ...h.input("invalid-time"), schedule: { kind: "once", runAt: "2029-01-01T00:00:00Z" } }), /晚于当前/);
  assert.throws(() => h.scheduled.create({ ...h.input("invalid-employee"), employeeId: "missing" }), /员工不存在/);
  assert.throws(() => h.scheduled.create({ ...h.input("empty-prompt"), prompt: " \n " }), /提示词不能为空/);
  assert.throws(() => h.scheduled.create({ ...h.input("invalid-timezone"), schedule: { kind: "daily", time: "01:00", timeZone: "invalid" } }), /时区/);
  const cancelled = h.scheduled.update(task.id, { revision: changed.revision, cancelled: true });
  assert.equal(cancelled.enabled, false);
  assert.ok(cancelled.cancelledAt);
  assert.equal(h.scheduled.list().length, 0);
  assert.equal(h.scheduled.get(task.id).task.title, "修改后的名称");
  assert.equal(h.scheduled.create(input).cancelledAt, cancelled.cancelledAt);
  assert.throws(() => h.scheduled.update(task.id, { revision: cancelled.revision, enabled: true }), /已取消/);
});

test("a due occurrence starts a fresh employee session through the durable conversation protocol only once", async t => {
  const h = harness(t);
  const task = h.scheduled.create(h.input());
  await h.scheduled.tick();
  assert.equal(h.sent.length, 0);
  const employee = h.storage.getSiliconEmployee("e_test_1")!;
  h.storage.saveSiliconEmployee({ ...employee, prompt: "执行时最新角色", agents: [{ ...employee.agents[0]!, model: "latest-configured-model" }] });
  h.setTime("2030-01-01T01:00:01.000Z");
  await h.scheduled.tick();
  const detail = h.scheduled.get(task.id);
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.runs[0]!.state, "accepted");
  assert.equal(detail.runs[0]!.executionStatus, "pending", "an initial idle snapshot is not a completed execution");
  assert.equal(detail.task.enabled, false);
  assert.equal(detail.task.nextRunAt, null);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.text, h.input().prompt.trim(), "normal conversation submission trims boundary whitespace only");
  const session = h.sessions.get(detail.runs[0]!.sessionId!)!;
  assert.equal(session.employeeId, "e_test_1");
  assert.equal(session.systemPrompt, "执行时最新角色");
  assert.equal(session.selectedModel, "latest-configured-model");
  assert.equal(session.employeeCandidates?.[session.employeeCandidateIndex!]!.engine, "sdk");
  assert.ok(h.service.receipt(detail.runs[0]!.requestId)?.sessionId);
  assert.equal(h.storage.listWandTasks().length, 0);
  await h.scheduled.tick();
  h.sessions.set(session.id, { ...session, status: "running", structuredState: { ...session.structuredState!, inFlight: true } });
  const reopened = new WandStorage(path.join(path.dirname(h.cwd), "wand.db"));
  try {
    const resumed = new ScheduledTaskService({ storage: reopened, conversations: h.service,
      getSession: id => h.sessions.get(id) ?? reopened.getSession(id), now: h.now });
    await resumed.tick();
    assert.equal(h.sent.length, 1);
    assert.equal(resumed.get(task.id).runs.length, 1);
    await resumed.dispose();
  } finally { reopened.close(); }
  h.setTime("2030-01-02T00:00:00.000Z");
  assert.equal(h.scheduled.create(h.input()).id, task.id, "an expired creation retry returns its original occurrence");
  h.sessions.set(session.id, { ...session, endedAt: h.now().toISOString() });
  await h.scheduled.tick();
  assert.equal(h.scheduled.get(task.id).runs[0]!.executionStatus, "completed");
  assert.equal(h.storage.listOpenScheduledTaskRuns(task.id).length, 0);
});

test("missed repeating periods catch up once and advance from now without replaying a backlog", async t => {
  const h = harness(t);
  const task = h.scheduled.create({ ...h.input(), schedule: { kind: "daily", time: "01:00", timeZone: "UTC" } });
  h.setTime("2030-01-05T12:00:00.000Z");
  await h.scheduled.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.scheduled.get(task.id).runs[0]!.scheduledAt, "2030-01-01T01:00:00.000Z");
  assert.equal(h.scheduled.get(task.id).task.nextRunAt, "2030-01-06T01:00:00.000Z");
  await h.scheduled.tick();
  assert.equal(h.sent.length, 1);
});

test("unfinished employee execution still blocks overlap after more than fifty skipped periods", async t => {
  const h = harness(t);
  const task = h.scheduled.create({ ...h.input(), schedule: { kind: "daily", time: "01:00", timeZone: "UTC" } });
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const first = h.scheduled.get(task.id).runs[0]!;
  const session = h.sessions.get(first.sessionId!)!;
  h.sessions.set(session.id, { ...session, status: "running", structuredState: { ...session.structuredState!, inFlight: true } });
  for (let index = 1; index <= 55; index++) {
    h.setTime(new Date(Date.parse("2030-01-01T01:00:00.000Z") + index * 86_400_000).toISOString());
    await h.scheduled.tick();
  }
  assert.equal(h.sent.length, 1);
  assert.equal(h.scheduled.get(task.id).runs.length, 50);
  assert.equal(h.scheduled.get(task.id).runs[0]!.state, "skipped");
  assert.equal(h.storage.listOpenScheduledTaskRuns(task.id).length, 1);
  h.sessions.set(session.id, { ...session, status: "idle", endedAt: h.now().toISOString() });
  h.setTime("2030-02-26T01:00:00.000Z");
  await h.scheduled.tick();
  assert.equal(h.sent.length, 2);
  assert.ok(h.storage.getScheduledTaskRun(first.id)?.executionFinishedAt);
});

test("crash recovery never resends a claimed occurrence with absent or pending durable receipts", async t => {
  for (const pendingReceipt of [false, true]) {
    const h = harness(t);
    const task = h.scheduled.create({ ...h.input(`recovery-${pendingReceipt}`), schedule: { kind: "daily", time: "01:00", timeZone: "UTC" } });
    h.setTime("2030-01-01T01:00:00.000Z");
    const run: ScheduledTaskRun = { id: `recovery-run-${pendingReceipt}`, taskId: task.id, requestId: `recovery-request-${pendingReceipt}`,
      scheduledAt: task.nextRunAt!, claimedAt: h.now().toISOString(), executionFinishedAt: null,
      employeeId: task.employeeId, prompt: task.prompt, state: "claimed", receipt: null, error: null };
    assert.equal(h.storage.claimScheduledTaskRun(task, run, nextScheduledTime(task.schedule, h.now())), true);
    if (pendingReceipt) h.storage.saveConversationRequest({ id: run.requestId, fingerprint: "explicit-recovery-double",
      receipt: { requestId: run.requestId, state: "pending", conversationId: "dm_e_test_1" }, updatedAt: h.now().toISOString() });
    await h.scheduled.tick();
    await h.scheduled.tick();
    assert.equal(h.sent.length, 0);
    const recovered = h.scheduled.get(task.id).runs[0]!;
    assert.equal(recovered.state, "unknown");
    assert.equal(recovered.executionStatus, "unknown");
    assert.ok(recovered.executionFinishedAt);
    h.setTime("2030-01-02T01:00:00.000Z");
    await h.scheduled.tick();
    assert.equal(h.sent.length, 1, "a later explicitly scheduled period may run without replaying the unknown occurrence");
  }
});

test("archived employees reject the scheduled occurrence without executing or substituting another employee", async t => {
  const h = harness(t);
  const task = h.scheduled.create(h.input());
  const employee = h.storage.getSiliconEmployee("e_test_1")!;
  h.storage.saveSiliconEmployee({ ...employee, archivedAt: h.now().toISOString() });
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const run = h.scheduled.get(task.id).runs[0]!;
  assert.equal(h.sent.length, 0);
  assert.equal(run.state, "rejected");
  assert.equal(run.executionStatus, "failed");
  assert.match(run.error!, /归档/);
  assert.match(h.scheduled.get(task.id).task.employeeUnavailableReason!, /归档/);
});

test("recovery follows a durable accepted receipt and settles a deleted session without another execution", async t => {
  const h = harness(t);
  const task = h.scheduled.create(h.input());
  h.setTime("2030-01-01T01:00:00.000Z");
  const run: ScheduledTaskRun = { id: "accepted-crash-run", taskId: task.id, requestId: "accepted-crash-request",
    scheduledAt: task.nextRunAt!, claimedAt: h.now().toISOString(), executionFinishedAt: null,
    employeeId: task.employeeId, prompt: task.prompt, state: "claimed", receipt: null, error: null };
  assert.equal(h.storage.claimScheduledTaskRun(task, run, null), true);
  const receipt = await h.service.send("dm_e_test_1", run.requestId, task.prompt, null);
  assert.equal(receipt.state, "accepted");
  const active = h.sessions.get(receipt.sessionId!)!;
  h.sessions.set(active.id, { ...active, status: "running", structuredState: { ...active.structuredState!, inFlight: true } });
  await h.scheduled.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.scheduled.get(task.id).runs[0]!.state, "accepted");
  assert.equal(h.scheduled.get(task.id).runs[0]!.sessionId, receipt.sessionId);
  h.sessions.delete(receipt.sessionId!);
  h.storage.deleteSession(receipt.sessionId!);
  await h.scheduled.tick();
  assert.equal(h.scheduled.get(task.id).runs[0]!.executionStatus, "unknown");
  assert.ok(h.storage.getScheduledTaskRun(run.id)?.executionFinishedAt);
  assert.equal(h.storage.listOpenScheduledTaskRuns().length, 0);
  assert.equal(h.sent.length, 1);
});

test("restart keeps accepted idle startup unknown without replay or permanently blocking future periods", async t => {
  const h = harness(t);
  const task = h.scheduled.create({ ...h.input(), schedule: { kind: "daily", time: "01:00", timeZone: "UTC" } });
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  assert.equal(h.scheduled.get(task.id).runs[0]!.executionStatus, "pending");
  await h.scheduled.dispose();
  const resumed = new ScheduledTaskService({ storage: h.storage, conversations: h.service,
    getSession: id => h.sessions.get(id) ?? h.storage.getSession(id), now: h.now });
  await resumed.tick();
  const recovered = resumed.get(task.id).runs[0]!;
  assert.equal(recovered.state, "unknown");
  assert.equal(recovered.executionStatus, "unknown");
  assert.ok(recovered.executionFinishedAt);
  assert.equal(h.storage.listOpenScheduledTaskRuns().length, 0);
  assert.equal(h.sent.length, 1);
  h.setTime("2030-01-02T01:00:00.000Z");
  await resumed.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(resumed.get(task.id).runs[0]!.executionStatus, "pending", "this process's fresh idle startup remains pending");
  await resumed.dispose();
});

test("an interrupted Core snapshot with no ended timestamp is failed and no longer an open execution", async t => {
  const h = harness(t);
  const task = h.scheduled.create(h.input());
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const run = h.scheduled.get(task.id).runs[0]!;
  const session = h.sessions.get(run.sessionId!)!;
  h.sessions.set(session.id, { ...session, status: "idle", endedAt: null,
    structuredState: { ...session.structuredState!, inFlight: false, engine: "core", lastError: "服务重启，上一轮已中断。" } });
  await h.scheduled.tick();
  const settled = h.scheduled.get(task.id).runs[0]!;
  assert.equal(settled.executionStatus, "failed");
  assert.match(settled.error!, /已中断/);
  assert.ok(settled.executionFinishedAt);
  assert.equal(h.storage.listOpenScheduledTaskRuns().length, 0);
  assert.equal(h.sent.length, 1);
});

test("settled completed, failed and unknown occurrences retain their original outcome through later session turns", async t => {
  for (const outcome of ["completed", "failed", "unknown"] as const) {
    const h = harness(t);
    const task = h.scheduled.create(h.input(`stable-${outcome}`));
    h.setTime("2030-01-01T01:00:00.000Z");
    await h.scheduled.tick();
    const original = h.scheduled.get(task.id).runs[0]!;
    const session = h.sessions.get(original.sessionId!)!;
    let scheduled = h.scheduled;
    if (outcome === "unknown") {
      await scheduled.dispose();
      scheduled = new ScheduledTaskService({ storage: h.storage, conversations: h.service,
        getSession: id => h.sessions.get(id) ?? h.storage.getSession(id), now: h.now });
      await scheduled.tick();
    } else {
      h.sessions.set(session.id, { ...session, status: outcome === "failed" ? "failed" : "idle", endedAt: h.now().toISOString(),
        exitCode: outcome === "failed" ? 1 : 0,
        structuredState: { ...session.structuredState!, inFlight: false, lastError: outcome === "failed" ? "原轮失败" : null } });
      scheduled.ingestSessionEvent({ type: "ended", sessionId: session.id });
    }
    assert.equal(h.storage.getScheduledTaskRun(original.id)?.executionOutcome, outcome);
    assert.equal(scheduled.get(task.id).runs[0]!.executionStatus, outcome);
    h.sessions.set(session.id, { ...session, status: "running", endedAt: null,
      structuredState: { ...session.structuredState!, inFlight: true, lastError: null } });
    scheduled.ingestSessionEvent({ type: "status", sessionId: session.id });
    assert.equal(scheduled.get(task.id).runs[0]!.executionStatus, outcome, "a follow-up turn does not reopen the original occurrence");
    h.sessions.set(session.id, { ...session, status: "failed", endedAt: new Date(h.now().getTime() + 1000).toISOString(),
      structuredState: { ...session.structuredState!, inFlight: false, lastError: "后续追问失败" } });
    scheduled.ingestSessionEvent({ type: "ended", sessionId: session.id });
    await scheduled.tick();
    const current = scheduled.get(task.id).runs[0]!;
    assert.equal(current.executionStatus, outcome);
    assert.equal(current.executionOutcome, outcome);
    if (outcome === "failed") assert.equal(current.error, "原轮失败");
    assert.equal(h.storage.listOpenScheduledTaskRuns().length, 0);
    await scheduled.dispose();
  }
});

test("terminal session events settle promptly without scanning output or treating initial idle as completed", async t => {
  const h = harness(t);
  const task = h.scheduled.create(h.input());
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const run = h.scheduled.get(task.id).runs[0]!;
  const session = h.sessions.get(run.sessionId!)!;
  const targeted = h.storage.getOpenScheduledTaskRunsForSession.bind(h.storage);
  let targetedQueries = 0;
  h.storage.getOpenScheduledTaskRunsForSession = id => { targetedQueries++; return targeted(id); };
  h.storage.listOpenScheduledTaskRuns = () => { throw new Error("event ingestion must not scan every open occurrence"); };
  h.scheduled.ingestSessionEvent({ type: "output", sessionId: session.id });
  h.scheduled.ingestSessionEvent({ type: "started", sessionId: session.id });
  assert.equal(targetedQueries, 0);
  h.scheduled.ingestSessionEvent({ type: "status", sessionId: session.id });
  assert.equal(targetedQueries, 1);
  assert.equal(h.storage.getScheduledTaskRun(run.id)?.executionFinishedAt, null);
  assert.equal(h.scheduled.get(task.id).runs[0]!.executionStatus, "pending");
  h.sessions.set(session.id, { ...session, endedAt: h.now().toISOString(), exitCode: 0, queuedMessages: ["用户提前排队的追问"] });
  h.scheduled.ingestSessionEvent({ type: "ended", sessionId: session.id });
  assert.equal(h.storage.getScheduledTaskRun(run.id)?.executionOutcome, "completed");
  // A follow-up can start before the next 15-second scheduler scan; the original outcome is already durable.
  h.sessions.set(session.id, { ...session, status: "running", endedAt: null,
    structuredState: { ...session.structuredState!, inFlight: true } });
  h.scheduled.ingestSessionEvent({ type: "status", sessionId: session.id });
  assert.equal(h.scheduled.get(task.id).runs[0]!.executionStatus, "completed");
  assert.equal(targeted(session.id).length, 0);
});

test("pausing and cancelling schedules preserve active sessions and execution history", async t => {
  const h = harness(t);
  const task = h.scheduled.create({ ...h.input(), schedule: { kind: "daily", time: "01:00", timeZone: "UTC" } });
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const run = h.scheduled.get(task.id).runs[0]!;
  const session = h.sessions.get(run.sessionId!)!;
  h.sessions.set(session.id, { ...session, status: "running", structuredState: { ...session.structuredState!, inFlight: true } });
  const paused = h.scheduled.update(task.id, { revision: h.scheduled.get(task.id).task.revision, enabled: false });
  h.setTime("2030-01-03T12:00:00.000Z");
  await h.scheduled.tick();
  assert.equal(h.sent.length, 1);
  const enabled = h.scheduled.update(task.id, { revision: paused.revision, enabled: true });
  assert.equal(enabled.nextRunAt, "2030-01-04T01:00:00.000Z");
  h.scheduled.update(task.id, { revision: enabled.revision, cancelled: true });
  assert.equal(h.sessions.get(session.id)?.status, "running");
  assert.equal(h.scheduled.get(task.id).runs.length, 1);
  h.setTime("2030-01-10T00:00:00.000Z");
  await h.scheduled.tick();
  assert.equal(h.sent.length, 1);
});

test("concurrent scans share one claim and dispose waits for its receipt before closing storage", async t => {
  const h = harness(t);
  let calls = 0;
  let finish!: () => void;
  const released = new Promise<void>(resolve => { finish = resolve; });
  const scheduled = new ScheduledTaskService({ storage: h.storage, conversations: {
    receipt: () => null,
    async send(_id, requestId) { calls++; await released; return { requestId, state: "accepted", conversationId: "dm_e_test_1" }; },
  }, getSession: () => null, now: h.now });
  const task = scheduled.create(h.input());
  h.setTime("2030-01-01T01:00:00.000Z");
  const first = scheduled.tick();
  assert.equal(scheduled.tick(), first);
  assert.equal(calls, 1);
  let disposed = false;
  const closing = scheduled.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  finish();
  await closing;
  assert.equal(h.storage.listScheduledTaskRuns(task.id).length, 1);
  assert.equal(disposed, true);
  await scheduled.tick();
  assert.equal(calls, 1);
});

test("scheduled task HTTP routes expose details, revision conflicts and soft cancellation", async t => {
  const h = harness(t);
  const app = express();
  app.use(express.json());
  registerScheduledTaskRoutes(app, h.scheduled);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}/api/scheduled-tasks`;
  const request = async (url: string, method: string, body: unknown) => fetch(url, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const created = await request(origin, "POST", h.input());
  assert.equal(created.status, 201);
  const { task } = await created.json() as { task: ReturnType<ScheduledTaskService["create"]> };
  assert.equal((await fetch(`${origin}/missing`)).status, 404);
  assert.equal((await request(`${origin}/${task.id}`, "PATCH", { revision: 0, enabled: false })).status, 409);
  assert.equal((await request(`${origin}/${task.id}`, "PATCH", { revision: 1, cancelled: true })).status, 200);
  assert.deepEqual(await (await fetch(origin)).json(), { tasks: [] });
  assert.equal(((await (await fetch(`${origin}?includeCancelled=1`)).json()) as { tasks: unknown[] }).tasks.length, 1);
  const detail = await (await fetch(`${origin}/${task.id}`)).json() as ReturnType<ScheduledTaskService["get"]>;
  assert.ok(detail.task.cancelledAt);
  assert.deepEqual(detail.runs, []);
  assert.equal(h.sent.length, 0);
});

test("a selected second project supplies its current directory and exact runtime/storage session ownership", async t => {
  const h = harness(t);
  const secondCwd = path.join(path.dirname(h.cwd), "second-project"); mkdirSync(secondCwd);
  const latestCwd = path.join(path.dirname(h.cwd), "moved-second-project"); mkdirSync(latestCwd);
  const second = h.storage.createWorkspace({ name: "第二个项目", cwd: secondCwd });
  const input = { ...h.input(), workspaceId: second.id };
  const task = h.scheduled.create(input);
  assert.equal(task.workspaceId, second.id);
  assert.equal(task.workspaceName, "第二个项目");
  assert.equal(task.workspaceCwd, secondCwd);
  assert.equal(task.workspaceUnavailableReason, null);
  h.storage.updateWorkspace(second.id, { cwd: latestCwd });
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const run = h.scheduled.get(task.id).runs[0]!;
  const session = h.sessions.get(run.sessionId!)!;
  assert.equal(run.workspaceId, second.id);
  assert.equal(run.cwd, latestCwd);
  assert.equal(session.cwd, latestCwd);
  assert.equal(session.workspaceId, second.id);
  assert.equal(h.storage.getSession(session.id)?.workspaceId, second.id);
  assert.equal(session.workspaceTaskId, undefined);
  assert.equal(h.storage.listWandTasks().length, 0);
  h.scheduled.update(task.id, { revision: h.scheduled.get(task.id).task.revision, workspaceId: h.workspace.id, prompt: "下一轮新内容" });
  h.storage.updateWorkspace(second.id, { name: "之后改名", cwd: secondCwd });
  assert.equal(h.scheduled.get(task.id).runs[0]!.workspaceId, second.id);
  assert.equal(h.scheduled.get(task.id).runs[0]!.cwd, latestCwd);
  assert.equal(h.scheduled.get(task.id).runs[0]!.prompt, task.prompt);
  assert.equal(h.scheduled.create(input).workspaceId, h.workspace.id, "creation retries return the existing edited plan");
  assert.throws(() => h.scheduled.create({ ...input, workspaceId: h.workspace.id }), ScheduledTaskConflictError);
});

test("duplicate directories still bind the scheduled execution to the explicitly selected project ID", async t => {
  const h = harness(t);
  const second = h.storage.createWorkspace({ name: "同目录第二项目", cwd: h.cwd });
  const task = h.scheduled.create({ ...h.input(), workspaceId: second.id });
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const run = h.scheduled.get(task.id).runs[0]!;
  assert.equal(run.state, "accepted");
  assert.equal(run.workspaceId, second.id);
  assert.equal(run.cwd, h.cwd);
  assert.equal(h.sessions.get(run.sessionId!)?.workspaceId, second.id);
  assert.equal(h.storage.getSession(run.sessionId!)?.workspaceId, second.id);
  assert.equal(h.storage.getSession(run.sessionId!)?.workspaceTaskId, undefined);
});

test("deleted projects and vanished directories reject an occurrence with no default-directory fallback", async t => {
  for (const failure of ["deleted-project", "vanished-directory"] as const) {
    const h = harness(t);
    const cwd = path.join(path.dirname(h.cwd), `target-${failure}`); mkdirSync(cwd);
    const workspace = h.storage.createWorkspace({ name: failure, cwd });
    const input = { ...h.input(), workspaceId: workspace.id };
    const task = h.scheduled.create(input);
    if (failure === "deleted-project") h.storage.deleteWorkspace(workspace.id);
    else rmSync(cwd, { recursive: true, force: true });
    assert.ok(h.scheduled.get(task.id).task.workspaceUnavailableReason);
    assert.throws(() => h.scheduled.update(task.id, { revision: task.revision, prompt: "不能因编辑丢失执行项目" }), /项目不存在|目录不存在/);
    h.setTime("2030-01-01T01:00:00.000Z");
    await h.scheduled.tick();
    const detail = h.scheduled.get(task.id);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0]!.state, "rejected");
    assert.equal(detail.runs[0]!.executionStatus, "failed");
    assert.equal(detail.runs[0]!.workspaceId, workspace.id);
    assert.match(detail.runs[0]!.error!, /项目不存在|目录不存在/);
    assert.equal(detail.runs[0]!.sessionId, null);
    assert.equal(detail.task.enabled, false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.sessions.size, 0);
    assert.equal(h.storage.listConversations().length, 0);
    await h.scheduled.tick();
    assert.equal(h.scheduled.get(task.id).runs.length, 1);
    assert.equal(h.scheduled.create(input).id, task.id, "expired retries keep the original rejected plan even if its project vanished");
    h.scheduled.update(task.id, { revision: detail.task.revision, cancelled: true });
    assert.ok(h.scheduled.get(task.id).task.cancelledAt, "invalid execution targets may still be cancelled");
  }
});

test("workspace input rejects global, missing, relative and non-directory projects while legacy requests retain defaults", async t => {
  const h = harness(t);
  const global = h.storage.ensureGlobalWorkspace();
  const relative = h.storage.createWorkspace({ name: "相对目录", cwd: "relative-target" });
  const file = path.join(path.dirname(h.cwd), "target-file"); writeFileSync(file, "fixture");
  const nonDirectory = h.storage.createWorkspace({ name: "文件目录", cwd: file });
  for (const id of [global.id, "missing-workspace", relative.id, nonDirectory.id]) {
    assert.throws(() => h.scheduled.create({ ...h.input(`invalid-${id}`), workspaceId: id }), /项目不存在|绝对工作目录|不是目录/);
  }
  const task = h.scheduled.create(h.input("legacy-default"));
  assert.equal(task.workspaceName, "服务默认目录");
  assert.equal(task.workspaceCwd, h.cwd);
  assert.equal(h.scheduled.create({ ...h.input("legacy-default"), workspaceId: null }).id, task.id);
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const run = h.scheduled.get(task.id).runs[0]!;
  assert.equal(run.workspaceId, null);
  assert.equal(run.cwd, h.cwd);
  assert.equal(h.sessions.get(run.sessionId!)?.cwd, h.cwd);
});

test("editing a plan after its claim cannot redirect or rewrite that occurrence's project and prompt", async t => {
  const h = harness(t);
  const cwd = path.join(path.dirname(h.cwd), "claimed-project"); mkdirSync(cwd);
  const workspace = h.storage.createWorkspace({ name: "当次执行项目", cwd });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let sendCwd: string | undefined;
  const scheduled = new ScheduledTaskService({ storage: h.storage, conversations: {
    receipt: id => h.service.receipt(id),
    async send(...args) { sendCwd = args[4]; await pending; return h.service.send(...args); },
  }, getSession: id => h.sessions.get(id) ?? h.storage.getSession(id), defaultCwd: () => h.config.defaultCwd, now: h.now });
  const task = scheduled.create({ ...h.input(), workspaceId: workspace.id });
  h.setTime("2030-01-01T01:00:00.000Z");
  const tick = scheduled.tick();
  const claimed = h.storage.listScheduledTaskRuns(task.id)[0]!;
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.workspaceId, workspace.id);
  assert.equal(claimed.cwd, cwd);
  scheduled.update(task.id, { revision: h.storage.getScheduledTask(task.id)!.revision,
    workspaceId: h.workspace.id, prompt: "之后修改的新提示词" });
  release();
  await tick;
  const run = scheduled.get(task.id).runs[0]!;
  assert.equal(sendCwd, cwd);
  assert.equal(run.workspaceId, workspace.id);
  assert.equal(run.cwd, cwd);
  assert.equal(run.prompt, task.prompt);
  assert.equal(h.sessions.get(run.sessionId!)?.workspaceId, workspace.id);
  assert.equal(h.sessions.get(run.sessionId!)?.cwd, cwd);
  assert.equal(h.sent[0]!.text, task.prompt.trim());
  assert.equal(scheduled.get(task.id).task.workspaceId, h.workspace.id);
  await scheduled.dispose();
});

test("the internal conversation execution target rejects directory mismatches and participates in receipt idempotency", async t => {
  const h = harness(t);
  const otherCwd = path.join(path.dirname(h.cwd), "other-target"); mkdirSync(otherCwd);
  const other = h.storage.createWorkspace({ name: "另一个目录", cwd: otherCwd });
  const mismatch = await h.service.send("dm_e_test_1", "target-mismatch", "明确测试", null, h.cwd, true, { workspaceId: other.id });
  assert.equal(mismatch.state, "rejected");
  assert.match(mismatch.error!, /目录已变更/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.sessions.size, 0);
  const duplicate = h.storage.createWorkspace({ name: "同目录目标", cwd: h.cwd });
  const accepted = await h.service.send("dm_e_test_1", "target-idempotency", "明确测试", null, h.cwd, true, { workspaceId: duplicate.id });
  assert.equal(accepted.state, "accepted");
  assert.equal(h.sessions.get(accepted.sessionId!)?.workspaceId, duplicate.id);
  assert.deepEqual(await h.service.send("dm_e_test_1", "target-idempotency", "明确测试", null, h.cwd, true, { workspaceId: duplicate.id }), accepted);
  await assert.rejects(() => h.service.send("dm_e_test_1", "target-idempotency", "明确测试", null, h.cwd, true, { workspaceId: h.workspace.id }), /requestId 已用于另一项/);
  assert.equal(h.sent.length, 1);
});

test("a selected project's directory changing after claim rejects dispatch while preserving the claimed target", async t => {
  const h = harness(t);
  const cwd = path.join(path.dirname(h.cwd), "claim-before-change"); mkdirSync(cwd);
  const workspace = h.storage.createWorkspace({ name: "执行前移动项目", cwd });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const scheduled = new ScheduledTaskService({ storage: h.storage, conversations: {
    receipt: id => h.service.receipt(id), async send(...args) { await pending; return h.service.send(...args); },
  }, getSession: id => h.sessions.get(id) ?? h.storage.getSession(id), defaultCwd: () => h.config.defaultCwd, now: h.now });
  const task = scheduled.create({ ...h.input(), workspaceId: workspace.id });
  h.setTime("2030-01-01T01:00:00.000Z");
  const tick = scheduled.tick();
  h.storage.updateWorkspace(workspace.id, { cwd: h.cwd });
  release();
  await tick;
  const run = scheduled.get(task.id).runs[0]!;
  assert.equal(run.state, "rejected");
  assert.equal(run.executionStatus, "failed");
  assert.equal(run.workspaceId, workspace.id);
  assert.equal(run.cwd, cwd);
  assert.match(run.error!, /目录已变更/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.sessions.size, 0);
  await scheduled.dispose();
});

test("changing the service default after claim cannot redirect a legacy plan's captured directory", async t => {
  const h = harness(t);
  const otherCwd = path.join(path.dirname(h.cwd), "changed-default"); mkdirSync(otherCwd);
  h.storage.createWorkspace({ name: "后续默认项目", cwd: otherCwd });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const scheduled = new ScheduledTaskService({ storage: h.storage, conversations: {
    receipt: id => h.service.receipt(id), async send(...args) { await pending; return h.service.send(...args); },
  }, getSession: id => h.sessions.get(id) ?? h.storage.getSession(id), defaultCwd: () => h.config.defaultCwd, now: h.now });
  const task = scheduled.create(h.input("legacy-claimed-default"));
  h.setTime("2030-01-01T01:00:00.000Z");
  const tick = scheduled.tick();
  assert.equal(h.storage.listScheduledTaskRuns(task.id)[0]!.cwd, h.cwd);
  h.config.defaultCwd = otherCwd;
  release();
  await tick;
  const run = scheduled.get(task.id).runs[0]!;
  assert.equal(run.state, "accepted");
  assert.equal(run.workspaceId, null);
  assert.equal(run.cwd, h.cwd);
  assert.equal(h.sessions.get(run.sessionId!)?.cwd, h.cwd);
  assert.equal(h.sessions.get(run.sessionId!)?.workspaceId, h.workspace.id);
  assert.equal(scheduled.get(task.id).task.workspaceCwd, otherCwd);
  await scheduled.dispose();
});
