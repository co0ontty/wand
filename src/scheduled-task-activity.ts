import type { ScheduledTaskRunView, ScheduledTaskRunFactView } from "./scheduled-task-types.js";

export type DayOutcome = ScheduledTaskRunView["executionStatus"] | "mixed" | "empty";
export interface ExecutionDay<T extends ScheduledTaskRunFactView = ScheduledTaskRunView> {
  key: string;
  records: T[];
  outcome: DayOutcome;
  counts: Partial<Record<ScheduledTaskRunView["executionStatus"], number>>;
  available: boolean;
  level: number;
}

/** A date-only key in the explicit display zone, never the browser's implicit zone. */
export function dateKey(value: string | Date, timeZone: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}

export function addDateDays(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function latestExecution<T extends ScheduledTaskRunFactView>(records: readonly T[]): T | undefined {
  return [...records].filter(record => Number.isFinite(Date.parse(record.claimedAt))).sort((a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt))[0];
}

/** Executions belong to the actual claim date. A late catch-up is not painted into its old scheduled day. */
export function executionDays<T extends ScheduledTaskRunFactView>(records: readonly T[], now: Date, createdAt: string, timeZone: string, weeks = 12): ExecutionDay<T>[] {
  weeks = Number.isFinite(weeks) ? Math.max(1, Math.min(53, Math.trunc(weeks))) : 12;
  const today = dateKey(now, timeZone);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDateDays(today, -weekday - (weeks - 1) * 7);
  const created = dateKey(createdAt, timeZone);
  const buckets = new Map<string, T[]>();
  for (const record of records) {
    if (!Number.isFinite(Date.parse(record.claimedAt))) continue;
    const key = dateKey(record.claimedAt, timeZone);
    const bucket = buckets.get(key) ?? [];
    bucket.push(record); buckets.set(key, bucket);
  }
  return Array.from({ length: weeks * 7 }, (_, index) => {
    const key = addDateDays(start, index);
    const daily = [...(buckets.get(key) ?? [])].sort((a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt));
    const available = key >= created && key <= today || daily.length > 0;
    const counts: ExecutionDay["counts"] = {};
    for (const record of daily) counts[record.executionStatus] = (counts[record.executionStatus] ?? 0) + 1;
    const states = Object.keys(counts) as ScheduledTaskRunView["executionStatus"][];
    const outcome: DayOutcome = states.length > 1 ? "mixed" : states[0] ?? "empty";
    return { key, records: daily, counts, outcome, available, level: Math.min(3, daily.length) };
  });
}
