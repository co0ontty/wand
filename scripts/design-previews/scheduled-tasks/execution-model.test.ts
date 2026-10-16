import assert from "node:assert/strict";
import { test } from "node:test";
import { dateKey, executionDays, latestExecution } from "./execution-model.js";
import { DISPLAY_ZONE, PREVIEW_NOW, histories, initialTasks } from "./fixtures.js";

const task = initialTasks().find(item => item.id === "changelog")!;
test("latest execution is chosen by actual claim time without mutating input", () => {
  const reversed = [...histories.changelog].reverse(), before = [...reversed];
  assert.equal(latestExecution(reversed)?.claimedAt, "2026-10-14T09:00:00+08:00");
  assert.deepEqual(reversed, before); assert.equal(latestExecution([]), undefined);
});
test("twelve week heatmap has Monday rows, unavailable future dates and neutral gaps", () => {
  const days = executionDays(histories.changelog, PREVIEW_NOW, task.createdAt, DISPLAY_ZONE);
  assert.equal(days.length, 84); assert.equal(days[0].key, "2026-07-27");
  assert.equal(days.at(-1)?.key, "2026-10-18");
  assert.equal(days.find(day => day.key === "2026-10-15")?.available, false);
  assert.equal(days.find(day => day.key === "2026-10-10")?.outcome, "empty");
});
test("mixed outcomes and same-day intensity derive only from supplied records", () => {
  const days = executionDays(histories.changelog, PREVIEW_NOW, task.createdAt, DISPLAY_ZONE);
  assert.equal(histories.changelog.length, 50);
  assert.equal(days.reduce((sum, day) => sum + day.records.length, 0), 50);
  const mixed = days.find(day => day.key === "2026-10-09")!;
  assert.equal(mixed.outcome, "mixed"); assert.deepEqual(mixed.counts, { failed: 1, completed: 1 });
  assert.equal(days.find(day => day.key === "2026-10-08")?.level, 2);
  assert.equal(days.find(day => day.key === "2026-10-08")?.outcome, "completed");
  const sessions = histories.changelog.map(run => run.sessionId).filter((id): id is string => Boolean(id));
  assert.equal(sessions.length, 48); assert.equal(new Set(sessions).size, 48);
  assert.ok(histories.changelog.filter(run => run.executionStatus === "skipped").every(run => run.sessionId === null));
});
test("late catch-up is counted on the actual claim date, not its planned date", () => {
  const run = { ...histories.changelog[0], scheduledAt: "2026-10-12T09:00:00+08:00", claimedAt: "2026-10-13T01:00:00Z" };
  const days = executionDays([run], PREVIEW_NOW, task.createdAt, DISPLAY_ZONE);
  assert.equal(days.find(day => day.key === "2026-10-12")?.records.length, 0);
  assert.equal(days.find(day => day.key === "2026-10-13")?.records.length, 1);
  assert.equal(dateKey(run.claimedAt, "America/New_York"), "2026-10-12");
});
test("known records survive changed creation metadata; unknown and skipped are not success", () => {
  const records = [histories.archive[0], histories.changelog.find(run => run.executionStatus === "skipped")!];
  const days = executionDays(records, PREVIEW_NOW, "2026-10-14T10:00:00+08:00", DISPLAY_ZONE);
  assert.equal(days.find(day => day.key === "2026-10-13")?.outcome, "unknown");
  assert.equal(days.find(day => day.key === "2026-10-12")?.outcome, "skipped");
  assert.equal(days.find(day => day.key === "2026-10-13")?.available, true);
});
