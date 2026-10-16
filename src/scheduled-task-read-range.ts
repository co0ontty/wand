import { addDateDays, dateKey } from "./scheduled-task-activity.js";
import type { ScheduledTaskReadRange } from "./scheduled-task-types.js";

export function scheduledReadZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 100) throw new Error("请提供有效的显示时区。");
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); }
  catch { throw new Error("请提供有效的显示时区。"); }
  return value;
}
function dateOnly(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("日期须为有效的 YYYY-MM-DD。");
  return value;
}
export function scheduledReadRange(from: unknown, to: unknown, zone: unknown, limit = 1000): ScheduledTaskReadRange {
  const start = dateOnly(from), end = dateOnly(to), timeZone = scheduledReadZone(zone);
  const days = (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000;
  if (days < 0 || days > 61) throw new Error("日历一次最多读取 62 天。");
  return { from: start, to: end, timeZone, complete: true, truncated: false, limit, invalidDates: 0 };
}
export function scheduledActivityRange(now: Date, zone: unknown): ScheduledTaskReadRange {
  const timeZone = scheduledReadZone(zone), today = dateKey(now, timeZone);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  return { from: addDateDays(today, -weekday - 77), to: addDateDays(today, 6 - weekday), timeZone, complete: true, truncated: false, limit: 5000, invalidDates: 0 };
}
/** Offset guard band lets SQLite use the normalized date index; exact IANA date
 * filtering follows in the service, without approximating local days as 24h. */
export function scheduledReadBounds(range: ScheduledTaskReadRange): [string, string] {
  return [new Date(Date.parse(`${range.from}T00:00:00Z`) - 36 * 3_600_000).toISOString(), new Date(Date.parse(`${range.to}T23:59:59Z`) + 36 * 3_600_000).toISOString()];
}
