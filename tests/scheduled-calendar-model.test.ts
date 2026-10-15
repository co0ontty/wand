import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarData, calendarEntries, weekPositions, type CalendarEntry } from "../src/scheduled-task-calendar.js";
import { DISPLAY_ZONE, PREVIEW_NOW, histories, initialTasks } from "./helpers/scheduled-calendar-fixtures.js";

const changelog = initialTasks().find(task => task.id === "changelog")!;
test("calendar expands future recurrences, not just each plan's saved next trigger", () => {
  const result = calendarEntries(initialTasks(), "2026-09-28", "2026-11-08", PREVIEW_NOW, DISPLAY_ZONE);
  assert.equal(result.entries.length, 33);
  assert.equal(result.entries.filter(entry => entry.task.id === "changelog").length, 25);
  assert.equal(result.entries.filter(entry => entry.task.id === "review").length, 3);
  assert.equal(result.entries.some(entry => ["digest", "completed"].includes(entry.task.id)), false);
  assert.equal(new Set(result.entries.map(entry => entry.key)).size, result.entries.length);
  assert.deepEqual(result.issues, []); assert.equal(result.truncated, false);
});
test("global projection mixes all supplied employees without an employee detail context", () => {
  const result = calendarData(initialTasks(), histories, "2026-09-28", "2026-11-08", PREVIEW_NOW, DISPLAY_ZONE);
  const actual = result.entries.filter(entry => entry.kind === "execution");
  const future = result.entries.filter(entry => entry.kind === "planned");
  assert.equal(new Set(actual.map(entry => entry.kind === "execution" ? entry.run.employeeId : "")).size, 3);
  assert.equal(new Set(future.map(entry => entry.task.employeeId)).size, 3);
  assert.equal(result.entries.length, 53);
});
test("current rules never manufacture past execution or past daily appointments", () => {
  assert.equal(calendarEntries([changelog], "2026-10-01", "2026-10-13", PREVIEW_NOW, DISPLAY_ZONE).entries.length, 0);
  const actual = calendarData([changelog], histories, "2026-10-01", "2026-10-13", PREVIEW_NOW, DISPLAY_ZONE);
  assert.ok(actual.entries.length > 0);
  assert.ok(actual.entries.every(entry => entry.kind === "execution"));
});
test("single future occurrence is shown exactly once, even when earlier records exist", () => {
  const task = initialTasks().find(task => task.id === "docs")!;
  const entries = calendarData([task], histories, "2026-10-12", "2026-10-18", PREVIEW_NOW, DISPLAY_ZONE).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "execution"); assert.equal(entries[1].kind, "planned");
  assert.equal(entries[1].at, task.nextRunAt);
});
test("canonical engine skips nonexistent DST time and retains saved timezone", () => {
  const task = { ...changelog, schedule: { kind: "daily" as const, time: "02:30", timeZone: "America/New_York" }, nextRunAt: "2026-03-07T02:30:00-05:00" };
  const result = calendarEntries([task], "2026-03-07", "2026-03-09", new Date("2026-03-07T00:30:00-05:00"), "America/New_York");
  assert.deepEqual(result.entries.map(entry => entry.date), ["2026-03-07", "2026-03-09"]);
  assert.deepEqual(result.issues, []);
});
test("actual catch-up date wins and suppresses a duplicate waiting projection", () => {
  const task = { ...changelog, nextRunAt: "2026-10-13T09:00:00+08:00" };
  const run = { ...histories.changelog[0], id: "catch-up", scheduledAt: task.nextRunAt, claimedAt: "2026-10-14T10:15:00+08:00" };
  const records = { [task.id]: [run] }, before = structuredClone(records);
  const entries = calendarData([task], records, "2026-10-12", "2026-10-18", PREVIEW_NOW, DISPLAY_ZONE).entries;
  assert.equal(entries.some(entry => entry.kind === "planned" && entry.at === run.scheduledAt), false);
  assert.equal(entries.find(entry => entry.kind === "execution")?.date, "2026-10-14");
  assert.deepEqual(records, before);
});
test("paused/cancelled plans retain historical bars but no projected future bars", () => {
  const task = { ...changelog, enabled: false, cancelledAt: PREVIEW_NOW.toISOString(), nextRunAt: null };
  const entries = calendarData([task], histories, "2026-10-01", "2026-10-31", PREVIEW_NOW, DISPLAY_ZONE).entries;
  assert.ok(entries.length > 0 && entries.every(entry => entry.kind === "execution"));
});
test("bad time/zone is explicit and projection cap is marked rather than hidden", () => {
  const bad = calendarEntries([{ ...changelog, nextRunAt: "invalid" }], "2026-10-01", "2026-10-31", PREVIEW_NOW, DISPLAY_ZONE);
  assert.equal(bad.issues.length, 1); assert.equal(bad.entries.length, 0);
  const capped = calendarEntries([changelog], "2026-10-01", "2026-10-31", PREVIEW_NOW, DISPLAY_ZONE, 1);
  assert.equal(capped.entries.length, 1); assert.equal(capped.truncated, true);
});
test("week markers use the precise display day/minute, not an invented duration", () => {
  const entry: CalendarEntry = { kind: "planned", key: "point", task: changelog, at: "2026-10-14T02:30:00Z", date: "2026-10-14", waiting: false };
  const position = weekPositions([entry], "2026-10-12", DISPLAY_ZONE)[0];
  assert.equal(position.day, 2); assert.equal(position.minute, 630);
  assert.equal(position.lane, 0); assert.equal(position.lanes, 1);
  assert.equal("end" in entry, false);
});
test("nearby readable markers use separate lanes, unrelated times regain full width", () => {
  const entries = ["09:00", "09:30", "12:00"].map((time, index): CalendarEntry => ({ kind: "planned", key: String(index), task: changelog, at: `2026-10-14T${time}:00+08:00`, date: "2026-10-14", waiting: false }));
  const result = weekPositions(entries, "2026-10-12", DISPLAY_ZONE);
  assert.deepEqual(result.map(entry => [entry.minute, entry.lane, entry.lanes]), [[540, 0, 2], [570, 1, 2], [720, 0, 1]]);
});
