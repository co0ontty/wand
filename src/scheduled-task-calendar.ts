import type { ScheduledTaskRunView, ScheduledTaskRunFactView, ScheduledTaskSummary } from "./scheduled-task-types.js";
import { nextScheduledTime } from "./scheduled-task-time.js";
import { isScheduled } from "./scheduled-task-agenda.js";
import { dateKey } from "./scheduled-task-activity.js";

interface CalendarEntryBase { key: string; task: ScheduledTaskSummary; at: string; date: string; }
export type CalendarEntry<T extends ScheduledTaskRunFactView = ScheduledTaskRunView> = CalendarEntryBase & (
  | { kind: "planned"; waiting: boolean }
  | { kind: "execution"; waiting: false; run: T }
);
export interface CalendarProjection<T extends ScheduledTaskRunFactView = ScheduledTaskRunView> { entries: CalendarEntry<T>[]; issues: string[]; truncated: boolean; }

/** Future projections only: saved next trigger first, then the canonical calendar-time engine.
 * Never infer past executions from the current recurrence rule. This does not schedule work. */
export function calendarEntries<T extends ScheduledTaskRunFactView = ScheduledTaskRunView>(tasks: readonly ScheduledTaskSummary[], start: string, end: string, now: Date, displayZone: string, limit = 1000): CalendarProjection<T> {
  const result: CalendarProjection<T> = { entries: [], issues: [], truncated: false };
  const lower = Date.parse(`${start}T00:00:00Z`) - 36 * 3_600_000;
  const upper = Date.parse(`${end}T23:59:59Z`) + 36 * 3_600_000;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || end < start || upper - lower > 70 * 86_400_000) throw new Error("日历范围应限制在当前月的日期网格。");
  limit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 1000;
  const append = (task: ScheduledTaskSummary, at: string): boolean => {
    const date = dateKey(at, displayZone);
    if (date < start || date > end) return true;
    if (result.entries.length >= limit) { result.truncated = true; return false; }
    result.entries.push({ kind: "planned", key: `plan:${task.id}:${Date.parse(at)}`, task, at, date, waiting: Date.parse(at) <= now.getTime() });
    return true;
  };
  taskLoop: for (const task of tasks) {
    if (!isScheduled(task)) continue;
    if (!Number.isFinite(Date.parse(task.nextRunAt!))) { result.issues.push(`${task.title}：计划时间待确认`); continue; }
    try {
      let candidate: string | null = task.nextRunAt!;
      if (task.schedule.kind === "once") { if (!append(task, candidate)) break; continue; }
      const cursor = Math.max(now.getTime(), lower);
      if (Date.parse(candidate) < cursor) {
        if (Date.parse(candidate) <= now.getTime() && !append(task, candidate)) break;
        candidate = nextScheduledTime(task.schedule, new Date(cursor));
      }
      // A single supported recurrence produces at most one future occurrence per
      // local day. Bounded iteration also protects corrupt legacy input.
      for (let count = 0; candidate && Date.parse(candidate) <= upper && count < 74; count++) {
        if (!append(task, candidate)) break taskLoop;
        const next = nextScheduledTime(task.schedule, new Date(candidate));
        if (next && Date.parse(next) <= Date.parse(candidate)) throw new Error("计划未向后推进");
        candidate = next;
      }
    } catch { result.issues.push(`${task.title}：暂时无法推算日程，请核对计划与时区`); }
  }
  result.entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return result;
}

/** Historical bars are immutable execution facts. Their actual claim time wins
 * over a projected duplicate; old recurrences are never retroactively expanded. */
export function calendarData<T extends ScheduledTaskRunFactView>(tasks: readonly ScheduledTaskSummary[], records: Readonly<Record<string, readonly T[]>>, start: string, end: string, now: Date, zone: string): CalendarProjection<T> {
  const projected = calendarEntries<T>(tasks, start, end, now, zone);
  const known = new Set<string>();
  const actual: CalendarEntry<T>[] = [];
  for (const task of tasks) for (const run of records[task.id] ?? []) {
    if (!Number.isFinite(Date.parse(run.claimedAt))) continue;
    known.add(`${task.id}:${Date.parse(run.scheduledAt)}`);
    const date = dateKey(run.claimedAt, zone);
    if (date < start || date > end) continue;
    if (actual.length >= 1000) { projected.truncated = true; break; }
    actual.push({ kind: "execution", key: `run:${run.id}`, task, at: run.claimedAt, date, waiting: false, run });
  }
  const forecast = projected.entries.filter(entry => !known.has(`${entry.task.id}:${Date.parse(entry.at)}`));
  const entries = [...actual, ...forecast].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { ...projected, entries: entries.slice(0, 1000), truncated: projected.truncated || entries.length > 1000 };
}

export interface WeekPosition<T extends ScheduledTaskRunFactView = ScheduledTaskRunView> { entry: CalendarEntry<T>; day: number; minute: number; lane: number; lanes: number; }
/** Lane collisions are based on readable marker height, NOT invented execution
 * duration. Every marker remains anchored to its own exact wall-clock minute. */
export function weekPositions<T extends ScheduledTaskRunFactView>(entries: readonly CalendarEntry<T>[], weekStart: string, zone: string, hourPixels = 64, markerHeight = 44): WeekPosition<T>[] {
  const result: WeekPosition<T>[] = [];
  const byDay = new Map<number, Array<{ entry: CalendarEntry<T>; minute: number }>>();
  for (const entry of entries) {
    const day = Math.round((Date.parse(`${entry.date}T12:00:00Z`) - Date.parse(`${weekStart}T12:00:00Z`)) / 86_400_000);
    if (day < 0 || day > 6) continue;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(entry.at));
    const minute = Number(parts.find(part => part.type === "hour")!.value) * 60 + Number(parts.find(part => part.type === "minute")!.value);
    const list = byDay.get(day) ?? []; list.push({ entry, minute }); byDay.set(day, list);
  }
  for (const [day, items] of byDay) {
    items.sort((a, b) => a.minute - b.minute);
    let cluster: typeof items = [], end = -1;
    const flush = () => {
      const lanes: number[] = [], positioned: WeekPosition<T>[] = [];
      for (const item of cluster) {
        const top = item.minute * hourPixels / 60;
        let lane = lanes.findIndex(bottom => bottom <= top);
        if (lane < 0) lane = lanes.length;
        lanes[lane] = top + markerHeight;
        positioned.push({ ...item, day, lane, lanes: 0 });
      }
      for (const item of positioned) result.push({ ...item, lanes: lanes.length });
    };
    for (const item of items) {
      const top = item.minute * hourPixels / 60;
      if (cluster.length && top >= end) { flush(); cluster = []; end = -1; }
      cluster.push(item); end = Math.max(end, top + markerHeight);
    }
    if (cluster.length) flush();
  }
  return result;
}
