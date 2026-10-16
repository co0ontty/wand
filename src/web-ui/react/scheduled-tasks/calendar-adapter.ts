import type { ScheduledTaskCalendarResponse, ScheduledTaskRunFactView, ScheduledTaskSummary } from "../../../scheduled-task-types.js";
import type { CalendarProjection } from "../../../scheduled-task-calendar.js";
import { isScheduled } from "../../../scheduled-task-agenda.js";

/** Feed facts are server projections. Never regenerate recurrence in the page,
 * never paint an old range or an obsolete pre-mutation schedule as current. */
export function calendarProjection(feed: ScheduledTaskCalendarResponse | null, tasks: readonly ScheduledTaskSummary[], from: string, to: string, timeZone: string): CalendarProjection<ScheduledTaskRunFactView> {
  if (!feed || feed.range.from !== from || feed.range.to !== to || feed.range.timeZone !== timeZone) return { entries: [], issues: [], truncated: false };
  const visible = new Map(tasks.map(task => [task.id, task]));
  const saved = new Map(feed.tasks.map(task => [task.id, task]));
  return { entries: feed.entries.flatMap(entry => {
    const task = visible.get(entry.taskId);
    if (!task || entry.kind === "planned" && (!isScheduled(task) || saved.get(task.id)?.revision !== task.revision)) return [];
    return [{ ...entry, task }];
  }), issues: feed.issues, truncated: feed.range.truncated };
}
