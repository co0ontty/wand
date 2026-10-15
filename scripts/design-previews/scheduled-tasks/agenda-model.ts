import type { ScheduledTaskSummary } from "../../../src/scheduled-task-types.js";

export interface AgendaGroup {
  id: string;
  title: string;
  dateLabel: string;
  active: boolean;
  tasks: ScheduledTaskSummary[];
}

function dayParts(value: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  return ["year", "month", "day"].map(key => Number(parts.find(part => part.type === key)!.value));
}

function calendarDay(value: Date, timeZone: string): number {
  const [year, month, day] = dayParts(value, timeZone);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function appointment(value: string, now: Date, timeZone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { day: "时间待确认", time: "—", period: "", dateLabel: "", exact: "计划时间不可用" };
  const distance = calendarDay(date, timeZone) - calendarDay(now, timeZone);
  const [year] = dayParts(date, timeZone), [currentYear] = dayParts(now, timeZone);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "short" }).format(date);
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { timeZone, ...(year === currentYear ? {} : { year: "numeric" }), month: "long", day: "numeric" }).format(date);
  const day = distance === 0 ? "今天" : distance === 1 ? "明天" : distance === 2 ? "后天" : distance > 2 && distance < 7 ? weekday : dateLabel;
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date));
  const period = hour < 5 ? "凌晨" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : "晚上";
  const exact = new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return { day, time, period, dateLabel: `${dateLabel} · ${weekday}`, exact };
}

export function isScheduled(task: ScheduledTaskSummary): boolean {
  return task.enabled && !task.cancelledAt && Boolean(task.nextRunAt);
}

function orderedTasks(tasks: ScheduledTaskSummary[]): ScheduledTaskSummary[] {
  return [...tasks].sort((a, b) => {
    const left = isScheduled(a) ? Date.parse(a.nextRunAt!) : NaN;
    const right = isScheduled(b) ? Date.parse(b.nextRunAt!) : NaN;
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    return Number.isFinite(left) ? -1 : Number.isFinite(right) ? 1 : 0;
  });
}

/** Upcoming details and agenda share exactly the same scheduling facts, independent of local filters. */
export function nextTask(tasks: ScheduledTaskSummary[]): ScheduledTaskSummary | undefined {
  return orderedTasks(tasks).find(task => isScheduled(task) && Number.isFinite(Date.parse(task.nextRunAt!)));
}

/** Calendar dates, not elapsed 24h blocks; a saved nextRunAt is never recalculated by the view. */
export function groupAgenda(tasks: ScheduledTaskSummary[], now: Date, timeZone: string): AgendaGroup[] {
  const groups = new Map<string, AgendaGroup>();
  for (const task of orderedTasks(tasks)) {
    let id: string, title: string, dateLabel = "", active = false;
    if (isScheduled(task)) {
      const date = new Date(task.nextRunAt!);
      if (!Number.isFinite(date.getTime())) { id = "unconfirmed"; title = "时间待确认"; }
      else if (date.getTime() <= now.getTime()) { id = "due"; title = "已到计划时间"; active = true; }
      else {
        const description = appointment(task.nextRunAt!, now, timeZone);
        id = `day-${calendarDay(date, timeZone)}`; title = description.day; dateLabel = description.dateLabel; active = true;
      }
    } else if (!task.cancelledAt && task.nextRunAt && !task.enabled) { id = "paused"; title = "已暂停"; }
    else { id = "finished"; title = "已结束"; }
    let group = groups.get(id);
    if (!group) { group = { id, title, dateLabel, active, tasks: [] }; groups.set(id, group); }
    group.tasks.push(task);
  }
  const all = [...groups.values()];
  return [...all.filter(group => group.active), ...all.filter(group => !group.active && group.id === "unconfirmed"),
    ...all.filter(group => group.id === "paused"), ...all.filter(group => group.id === "finished")];
}
