import assert from "node:assert/strict";
import test from "node:test";
import { nextScheduledTime, parseTaskSchedule } from "../src/scheduled-task-time.js";

test("once accepts explicit offsets, normalizes UTC and expires after its occurrence", () => {
  const schedule = parseTaskSchedule({ kind: "once", runAt: "2026-10-12T09:00:00+08:00" });
  assert.deepEqual(schedule, { kind: "once", runAt: "2026-10-12T01:00:00.000Z" });
  assert.equal(nextScheduledTime(schedule, new Date("2026-10-12T00:59:59Z")), "2026-10-12T01:00:00.000Z");
  assert.equal(nextScheduledTime(schedule, new Date("2026-10-12T01:00:00Z")), null);
  assert.throws(() => parseTaskSchedule({ kind: "once", runAt: "2026-10-12T09:00" }));
  assert.throws(() => parseTaskSchedule({ kind: "once", runAt: "2026-02-30T09:00:00Z" }));
});

test("daily and weekly follow the saved zone independent of server timezone", () => {
  const daily = parseTaskSchedule({ kind: "daily", time: "09:30", timeZone: "Asia/Shanghai" });
  assert.equal(nextScheduledTime(daily, new Date("2026-10-11T01:00:00Z")), "2026-10-11T01:30:00.000Z");
  assert.equal(nextScheduledTime(daily, new Date("2026-10-11T01:30:00Z")), "2026-10-12T01:30:00.000Z");
  const weekly = parseTaskSchedule({ kind: "weekly", time: "09:30", timeZone: "Asia/Shanghai", weekday: 1 });
  assert.equal(nextScheduledTime(weekly, new Date("2026-10-11T02:00:00Z")), "2026-10-12T01:30:00.000Z");
  assert.equal(nextScheduledTime(weekly, new Date("2026-10-12T01:30:00Z")), "2026-10-19T01:30:00.000Z");
});

test("spring forward skips a missing local time, including weekly schedules", () => {
  assert.equal(nextScheduledTime({ kind: "daily", time: "02:30", timeZone: "America/New_York" },
    new Date("2026-03-08T05:00:00Z")), "2026-03-09T06:30:00.000Z");
  assert.equal(nextScheduledTime({ kind: "weekly", time: "02:30", timeZone: "America/New_York", weekday: 0 },
    new Date("2026-03-08T05:00:00Z")), "2026-03-15T06:30:00.000Z");
});

test("fall back uses only the first copy of a repeated local time", () => {
  const schedule = { kind: "daily" as const, time: "01:30", timeZone: "America/New_York" };
  assert.equal(nextScheduledTime(schedule, new Date("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextScheduledTime(schedule, new Date("2026-11-01T05:30:00Z")), "2026-11-02T06:30:00.000Z");
});

test("fractional offsets and half-hour DST transitions are calendar times", () => {
  assert.equal(nextScheduledTime({ kind: "daily", time: "09:00", timeZone: "Asia/Kathmandu" },
    new Date("2026-10-11T00:00:00Z")), "2026-10-11T03:15:00.000Z");
  assert.equal(nextScheduledTime({ kind: "daily", time: "02:15", timeZone: "Australia/Lord_Howe" },
    new Date("2026-10-03T13:30:00Z")), "2026-10-04T15:15:00.000Z");
});

test("invalid schedules reject malformed fields without guessing", () => {
  for (const input of [null, [], { kind: "cron" }, { kind: "daily", time: "24:00", timeZone: "UTC" },
    { kind: "daily", time: "09:00", timeZone: "not/a-zone" }, { kind: "weekly", time: "09:00", timeZone: "UTC", weekday: "1" },
    { kind: "weekly", time: "09:00", timeZone: "UTC", weekday: 7 }]) assert.throws(() => parseTaskSchedule(input));
});
