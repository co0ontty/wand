import assert from "node:assert/strict";
import { test } from "node:test";
import { appointment, groupAgenda, nextTask } from "../src/scheduled-task-agenda.js";
import { DISPLAY_ZONE, PREVIEW_NOW, initialTasks } from "./helpers/scheduled-calendar-fixtures.js";

test("agenda sorts by saved nextRunAt without changing the source list", () => {
  const tasks = initialTasks(), before = structuredClone(tasks);
  assert.equal(nextTask(tasks)?.id, "docs");
  const groups = groupAgenda(tasks, PREVIEW_NOW, DISPLAY_ZONE);
  assert.deepEqual(groups.flatMap(group => group.tasks.map(task => task.id)), ["docs", "changelog", "archive", "review", "digest", "completed"]);
  assert.deepEqual(groups.map(group => group.title), ["今天", "明天", "后天", "周一", "已暂停", "已结束"]);
  assert.deepEqual(tasks, before);
});

test("pausing/cancelling the next plan reveals the actual next scheduled task", () => {
  const tasks = initialTasks();
  tasks.find(task => task.id === "docs")!.enabled = false;
  assert.equal(nextTask(tasks)?.id, "changelog");
  tasks.find(task => task.id === "changelog")!.cancelledAt = PREVIEW_NOW.toISOString();
  assert.equal(nextTask(tasks)?.id, "archive");
});

test("unavailable configuration is visible, never hidden by upcoming selection", () => {
  const tasks = initialTasks();
  Object.assign(tasks[0], { nextRunAt: "2026-10-14T11:00:00+08:00", employeeUnavailableReason: "员工不可用" });
  assert.equal(nextTask(tasks)?.id, "changelog");
  assert.equal(groupAgenda(tasks, PREVIEW_NOW, DISPLAY_ZONE)[0].tasks[0].id, "changelog");
});

test("paused and ended plans never receive an upcoming day group", () => {
  const groups = groupAgenda(initialTasks().filter(task => ["digest", "completed"].includes(task.id)), PREVIEW_NOW, DISPLAY_ZONE);
  assert.deepEqual(groups.map(group => [group.title, group.active]), [["已暂停", false], ["已结束", false]]);
  assert.equal(nextTask(groups.flatMap(group => group.tasks)), undefined);
});

test("a running past occurrence does not make an ended plan upcoming", () => {
  const task = initialTasks().find(task => task.id === "docs")!;
  task.nextRunAt = null;
  assert.equal(task.lastRun?.executionStatus, "running");
  assert.equal(nextTask([task]), undefined);
  assert.equal(groupAgenda([task], PREVIEW_NOW, DISPLAY_ZONE)[0].id, "finished");
});

test("relative days use the display zone, not browser zone or elapsed hours", () => {
  const now = new Date("2026-10-14T16:30:00Z"), value = "2026-10-15T10:00:00Z";
  assert.equal(appointment(value, now, "Asia/Shanghai").day, "今天");
  assert.equal(appointment(value, now, "America/New_York").day, "明天");
  assert.equal(appointment(value, now, "Asia/Shanghai").time, "18:00");
});

test("25-hour fall DST day is still one calendar day later", () => {
  const now = new Date("2026-10-31T11:00:00-04:00");
  const description = appointment("2026-11-01T11:00:00-05:00", now, "America/New_York");
  assert.equal(description.day, "明天"); assert.equal(description.time, "11:00");
});

test("the same local DST fall day is today even when 24 hours apart", () => {
  const now = new Date("2026-11-01T00:30:00-04:00");
  assert.equal(appointment("2026-11-01T23:30:00-05:00", now, "America/New_York").day, "今天");
});

test("a short interval across midnight is tomorrow and dates include the new year", () => {
  assert.equal(appointment("2026-03-08T00:15:00-05:00", new Date("2026-03-07T23:30:00-05:00"), "America/New_York").day, "明天");
  assert.match(appointment("2027-01-05T09:00:00+08:00", PREVIEW_NOW, DISPLAY_ZONE).day, /2027/);
});

test("overdue and malformed saved times are explicit, not invented future slots", () => {
  const tasks = initialTasks().slice(0, 2);
  tasks[0].nextRunAt = "2026-10-14T08:00:00+08:00";
  tasks[1].nextRunAt = "invalid";
  const groups = groupAgenda(tasks, PREVIEW_NOW, DISPLAY_ZONE);
  assert.deepEqual(groups.map(group => group.id), ["due", "unconfirmed"]);
  assert.equal(nextTask(tasks)?.id, "changelog");
  assert.equal(appointment("invalid", PREVIEW_NOW, DISPLAY_ZONE).day, "时间待确认");
});
