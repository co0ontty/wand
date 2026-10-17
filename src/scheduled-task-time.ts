import type { TaskSchedule } from "./scheduled-task-types.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    // Validation can see arbitrary HTTP input; keep the cache bounded.
    if (formatters.size >= 100) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, value);
  }
  return value;
}

function localParts(timestamp: number, timeZone: string): number[] {
  const parts = formatter(timeZone).formatToParts(timestamp);
  return ["year", "month", "day", "hour", "minute", "second"].map(key => Number(parts.find(part => part.type === key)!.value));
}

function asUtc(parts: number[]): number {
  return Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);
}

export function parseTaskSchedule(value: unknown): TaskSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请选择执行计划。");
  const input = value as Record<string, unknown>;
  if (input.kind === "once") {
    if (typeof input.runAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.runAt)
      || !Number.isFinite(Date.parse(input.runAt))
      || new Date(`${input.runAt.slice(0, 19)}Z`).toISOString().slice(0, 19) !== input.runAt.slice(0, 19)) {
      throw new Error("请选择有效的执行日期和时间。");
    }
    return { kind: "once", runAt: new Date(input.runAt).toISOString() };
  }
  if (input.kind === "interval") {
    if (!Number.isInteger(input.everyHours) || Number(input.everyHours) < 1 || Number(input.everyHours) > 8760) {
      throw new Error("小时间隔须为 1–8760 的整数。");
    }
    if (typeof input.timeZone !== "string" || !input.timeZone || input.timeZone.length > 100) throw new Error("请选择有效的时区。");
    try { formatter(input.timeZone); } catch { throw new Error("请选择有效的时区。"); }
    const start = parseTaskSchedule({ kind: "once", runAt: input.startAt });
    if (start.kind !== "once") throw new Error("请选择有效的首次执行时间。");
    return { kind: "interval", everyHours: Number(input.everyHours), startAt: start.runAt, timeZone: input.timeZone };
  }
  if (input.kind !== "daily" && input.kind !== "weekly") throw new Error("执行计划仅支持单次、小时间隔、每天或每周。");
  if (typeof input.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error("执行时间须为 HH:mm。");
  if (typeof input.timeZone !== "string" || input.timeZone.length > 100) throw new Error("请选择有效的时区。");
  try { formatter(input.timeZone); } catch { throw new Error("请选择有效的时区。"); }
  if (input.kind === "weekly") {
    if (!Number.isInteger(input.weekday) || Number(input.weekday) < 0 || Number(input.weekday) > 6) throw new Error("请选择星期几执行。");
    return { kind: "weekly", time: input.time, timeZone: input.timeZone, weekday: Number(input.weekday) };
  }
  return { kind: "daily", time: input.time, timeZone: input.timeZone };
}

/** Daily/weekly use calendar time in the saved zone; intervals use elapsed hours from a saved absolute anchor.
 * A missing calendar DST time is skipped; a repeated calendar time runs once. */
export function nextScheduledTime(schedule: TaskSchedule, after: Date): string | null {
  const timestamp = after.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("当前时间无效。");
  if (schedule.kind === "once") return Date.parse(schedule.runAt) > timestamp ? schedule.runAt : null;
  if (schedule.kind === "interval") {
    // An immutable absolute anchor prevents drift after pauses, slow scans, or restarts.
    const anchor = Date.parse(schedule.startAt), step = schedule.everyHours * 3_600_000;
    if (!Number.isFinite(anchor) || !Number.isInteger(schedule.everyHours) || step < 3_600_000 || schedule.everyHours > 8760) throw new Error("小时间隔计划无效。");
    return new Date(anchor + Math.max(0, Math.floor((timestamp - anchor) / step) + 1) * step).toISOString();
  }
  const current = localParts(timestamp, schedule.timeZone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const today = Date.UTC(current[0]!, current[1]! - 1, current[2]!);
  // Two weeks includes the next weekly occurrence after a skipped spring-forward time.
  for (let day = 0; day <= 14; day++) {
    const date = new Date(today + day * 86_400_000);
    if (schedule.kind === "weekly" && date.getUTCDay() !== schedule.weekday) continue;
    const desired = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
    // The offsets surrounding this local date cover transitions, including 30-minute DST.
    const offsets = new Set<number>();
    for (const delta of [-36, -12, 0, 12, 36]) {
      const probe = desired + delta * 3_600_000;
      offsets.add(asUtc(localParts(probe, schedule.timeZone)) - probe);
    }
    const matches = [...offsets].map(offset => desired - offset)
      .filter(candidate => asUtc(localParts(candidate, schedule.timeZone)) === desired).sort((a, b) => a - b);
    // Always choose the first occurrence, even if after is between the two DST copies.
    const candidate = matches[0];
    if (candidate !== undefined && candidate > timestamp) return new Date(candidate).toISOString();
  }
  throw new Error("无法计算下次执行时间，请检查计划和时区。");
}
