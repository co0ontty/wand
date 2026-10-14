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
  if (input.kind !== "daily" && input.kind !== "weekly") throw new Error("执行计划仅支持单次、每天或每周。");
  if (typeof input.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error("执行时间须为 HH:mm。");
  if (typeof input.timeZone !== "string" || input.timeZone.length > 100) throw new Error("请选择有效的时区。");
  try { formatter(input.timeZone); } catch { throw new Error("请选择有效的时区。"); }
  if (input.kind === "weekly") {
    if (!Number.isInteger(input.weekday) || Number(input.weekday) < 0 || Number(input.weekday) > 6) throw new Error("请选择星期几执行。");
    return { kind: "weekly", time: input.time, timeZone: input.timeZone, weekday: Number(input.weekday) };
  }
  return { kind: "daily", time: input.time, timeZone: input.timeZone };
}

/** Calendar time in the saved zone. A missing DST time is skipped; a repeated time runs once. */
export function nextScheduledTime(schedule: TaskSchedule, after: Date): string | null {
  const timestamp = after.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("当前时间无效。");
  if (schedule.kind === "once") return Date.parse(schedule.runAt) > timestamp ? schedule.runAt : null;
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
