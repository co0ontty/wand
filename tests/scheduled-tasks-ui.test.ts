import assert from "node:assert/strict";
import test from "node:test";
import { scheduleInputError, scheduleLabel, scheduleSaveUnknown, scheduledTaskState } from "../src/web-ui/react/scheduled-tasks/model.js";
import { HttpResponseError } from "../src/web-ui/react/http-adapter.js";
import { isTaskBoardView, taskBoardPageOf, taskBoardSearch } from "../src/web-ui/react/issues/task-board-controller.js";
import type { ScheduledTaskSummary } from "../src/scheduled-task-types.js";

test("scheduled task route preserves other URL parameters and has its own destination", () => {
  const search = taskBoardSearch("?session=existing&reactUi=0&run=old", true, "schedules");
  assert.equal(isTaskBoardView(search), true);
  assert.equal(taskBoardPageOf(search), "schedules");
  assert.equal(new URLSearchParams(search).get("session"), "existing");
  assert.equal(new URLSearchParams(search).has("run"), false);
  assert.equal(taskBoardSearch(search, false), "?session=existing&reactUi=0");
});

test("scheduled task input validates real time and keeps the supplied prompt unchanged", () => {
  const input = { requestId: "test", employeeId: "e1", workspaceId: "w1", prompt: "  完整帖子\n第二段\n  ", schedule: { kind: "once" as const, runAt: "2027-01-01T00:00:00Z" } };
  assert.equal(scheduleInputError(input, Date.parse("2026-01-01T00:00:00Z")), "");
  assert.equal(input.prompt, "  完整帖子\n第二段\n  ");
  assert.match(scheduleInputError({ ...input, workspaceId: "" }), /执行工作区/);
  assert.match(scheduleInputError(input, Date.parse("2028-01-01T00:00:00Z")), /晚于现在/);
  assert.match(scheduleInputError({ ...input, schedule: { kind: "daily", time: "24:00", timeZone: "Asia/Shanghai" } }), /执行时间/);
  assert.match(scheduleInputError({ ...input, schedule: { kind: "daily", time: "09:00", timeZone: "missing" } }), /时区/);
  assert.equal(scheduleLabel({ kind: "weekly", weekday: 1, time: "09:00", timeZone: "Asia/Shanghai" }), "每周一 09:00 · Asia/Shanghai");
});

test("completed one-time plans have a distinct state and unknown saves retain their identity", () => {
  const base = { schedule: { kind: "once", runAt: "2026-01-01T00:00:00Z" }, nextRunAt: null, enabled: false, cancelledAt: null } as ScheduledTaskSummary;
  assert.equal(scheduledTaskState(base), "计划已结束");
  assert.equal(scheduledTaskState({ ...base, cancelledAt: "2026-01-01" }), "已取消");
  assert.equal(scheduledTaskState({ ...base, nextRunAt: "2027-01-01" }), "已暂停");
  assert.equal(scheduledTaskState({ ...base, enabled: true, nextRunAt: "2027-01-01", workspaceUnavailableReason: "目录已移走" }), "工作区不可用");
  for (const status of [0, 200, 408, 500, 503]) assert.equal(scheduleSaveUnknown(new HttpResponseError("unknown", status)), true);
  for (const status of [400, 403, 404]) assert.equal(scheduleSaveUnknown(new HttpResponseError("rejected", status)), false);
});
