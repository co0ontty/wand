import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ScheduledTaskService, ScheduledTaskNotFoundError } from "../src/scheduled-task-service.js";
import { registerScheduledTaskRoutes } from "../src/server-scheduled-task-routes.js";
import type { ScheduledTask, ScheduledTaskRun } from "../src/scheduled-task-types.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

function fixture(t: Parameters<typeof conversationHarness>[0]) {
  const h = conversationHarness(t), now = new Date("2026-10-14T10:30:00+08:00");
  const employee = h.storage.getSiliconEmployee("e_test_1")!;
  for (const id of ["calendar-a", "calendar-b", "calendar-c"]) h.storage.saveSiliconEmployee({ ...employee, id, name: id });
  const tasks: ScheduledTask[] = [];
  for (const [index, employeeId] of ["calendar-a", "calendar-b", "calendar-c"].entries()) {
    const task: ScheduledTask = { id: `calendar-task-${index}`, creationFingerprint: "read-fixture", employeeId, title: `计划${index}`, prompt: "FULL_PROMPT_SENTINEL_".repeat(2000), schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" }, workspaceId: null,
      enabled: true, nextRunAt: "2026-08-11T01:00:00.000Z", revision: 1, createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", cancelledAt: null };
    h.storage.createScheduledTask(task); tasks.push(task);
    const count = index === 0 ? 65 : 2;
    for (let day = 0; day < count; day++) {
      const current = h.storage.getScheduledTask(task.id)!;
      const at = current.nextRunAt!;
      const claimedAt = day === 0 && index === 0 ? "2026-10-14T02:00:00.000Z" : at;
      const run: ScheduledTaskRun = { id: `calendar-run-${index}-${day}`, taskId: task.id, requestId: `read-only-${index}-${day}`, scheduledAt: at, claimedAt, executionFinishedAt: claimedAt, executionOutcome: "completed", employeeId, workspaceId: null, cwd: "/original/immutable", prompt: task.prompt, state: "accepted", receipt: null, error: null };
      const next = new Date(Date.parse(at) + 86_400_000).toISOString();
      assert.equal(h.storage.claimScheduledTaskRun(current, run, next), true);
    }
  }
  const service = new ScheduledTaskService({ storage: h.storage, conversations: h.service, getSession: id => h.sessions.get(id) ?? null, defaultCwd: () => h.cwd, now: () => now });
  return { ...h, service, now, tasks };
}

test("global calendar and activity are date-bounded read projections, not last-fifty or prompt copies", t => {
  const h = fixture(t), before = JSON.stringify(h.storage.listScheduledTasks(true));
  const activity = h.service.activity(h.tasks[0].id, "Asia/Shanghai");
  assert.equal(activity.runs.length, 65); assert.equal(activity.range.complete, true);
  assert.equal(activity.runs[0].id, "calendar-run-0-0", "latest is actual claim time, not scheduled time");
  assert.equal(h.service.list(true).find(task => task.id === h.tasks[0].id)?.lastRun?.id, "calendar-run-0-0");
  assert.ok(!JSON.stringify(activity).includes("FULL_PROMPT_SENTINEL"));
  assert.ok(activity.runs.every(run => !("receipt" in run) && !("requestId" in run) && !("prompt" in run)));
  const calendar = h.service.calendar("2026-09-28", "2026-11-08", "Asia/Shanghai");
  assert.equal(new Set(calendar.tasks.map(task => task.employeeId)).size, 3);
  assert.ok(calendar.entries.some(entry => entry.kind === "execution") && calendar.entries.some(entry => entry.kind === "planned"));
  assert.ok(calendar.entries.every(entry => entry.date >= calendar.range.from && entry.date <= calendar.range.to && entry.minuteOfDay >= 0 && entry.minuteOfDay < 1440));
  assert.ok(calendar.entries.filter(entry => entry.kind === "execution").every(entry => !("prompt" in entry.run)));
  assert.equal(h.sent.length, 0); assert.equal(JSON.stringify(h.storage.listScheduledTasks(true)), before);
});

test("selected execution snapshot remains immutable and cannot be read under another task", t => {
  const h = fixture(t), original = h.service.getRun(h.tasks[0].id, "calendar-run-0-0");
  assert.equal(original.cwd, "/original/immutable"); assert.ok(original.prompt.startsWith("FULL_PROMPT_SENTINEL"));
  const task = h.storage.getScheduledTask(h.tasks[0].id)!;
  h.service.update(task.id, { revision: task.revision, title: "当前新标题", prompt: "当前新提示词" });
  assert.equal(h.service.getRun(task.id, original.id).prompt, original.prompt);
  assert.throws(() => h.service.getRun(h.tasks[1].id, original.id), ScheduledTaskNotFoundError);
  assert.equal(h.sent.length, 0);
});

test("range input is strict and invalid stored dates are visible as incomplete coverage", t => {
  const h = fixture(t);
  for (const [from, to, zone] of [["2026-02-30", "2026-03-01", "UTC"], ["2026-01-01", "2026-12-31", "UTC"], ["2026-10-02", "2026-10-01", "UTC"], ["2026-10-01", "2026-10-31", "not/a-zone"]]) assert.throws(() => h.service.calendar(from, to, zone));
  const old = h.storage.getScheduledTaskRun("calendar-run-0-1")!;
  h.storage.saveScheduledTaskRun({ ...old, claimedAt: "invalid" });
  const activity = h.service.activity(old.taskId, "UTC");
  assert.equal(activity.range.complete, false); assert.equal(activity.range.invalidDates, 1);
  const calendar = h.service.calendar("2026-10-01", "2026-10-31", "UTC");
  assert.equal(calendar.range.complete, false); assert.ok(calendar.issues.some(issue => issue.includes("时间待确认")));
});

test("calendar routes precede the id route and selected-run routes are read-only", async t => {
  const h = fixture(t), app = express(); app.use(express.json()); registerScheduledTaskRoutes(app, h.service);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(origin + "/api/scheduled-tasks/calendar?from=2026-10-01&to=2026-10-31&timeZone=Asia%2FShanghai")).status, 200);
  assert.equal((await fetch(origin + `/api/scheduled-tasks/${h.tasks[0].id}/activity?timeZone=Asia%2FShanghai`)).status, 200);
  assert.equal((await fetch(origin + `/api/scheduled-tasks/${h.tasks[0].id}/runs/calendar-run-0-0`)).status, 200);
  assert.equal((await fetch(origin + `/api/scheduled-tasks/${h.tasks[1].id}/runs/calendar-run-0-0`)).status, 404);
  assert.equal(h.sent.length, 0);
});
