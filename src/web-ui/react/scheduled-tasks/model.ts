import type { ScheduledTaskInput, ScheduledTaskRunView, ScheduledTaskSummary, TaskSchedule } from "../../../scheduled-task-types.js";
import { HttpResponseError } from "../http-adapter.js";

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function scheduleLabel(schedule: TaskSchedule): string {
  if (schedule.kind === "once") return `一次 · ${scheduleDate(schedule.runAt)}`;
  return `${schedule.kind === "daily" ? "每天" : `每${WEEKDAYS[schedule.weekday]}`} ${schedule.time} · ${schedule.timeZone}`;
}

export function scheduleDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }) : "时间无效";
}

export function scheduledTaskState(task: ScheduledTaskSummary): string {
  if (task.cancelledAt) return "已取消";
  if (task.schedule.kind === "once" && !task.nextRunAt) return "计划已结束";
  if (!task.enabled) return "已暂停";
  if (!task.nextRunAt) return "计划已结束";
  return task.employeeUnavailableReason ? "员工不可用" : task.workspaceUnavailableReason ? "工作区不可用" : "待执行";
}

export function scheduledRunState(run: ScheduledTaskRunView): string {
  return ({ pending: "等待执行", running: "执行中", completed: "已完成", failed: "执行失败", unknown: "执行结果待确认", skipped: "已跳过" })[run.executionStatus];
}

/** A retry must reuse the original payload whenever creation may have succeeded. */
export function scheduleSaveUnknown(error: unknown): boolean {
  return !(error instanceof HttpResponseError) || error.status === 0 || error.status === 408
    || error.status >= 500 || error.status >= 200 && error.status < 300;
}

export function scheduleInputError(input: ScheduledTaskInput, now = Date.now()): string {
  if (!input.employeeId) return "请选择执行员工。";
  if (!input.workspaceId) return "请选择执行工作区。";
  if (!input.prompt.trim()) return "请填写员工要执行的提示词。";
  if (input.schedule.kind === "once") {
    if (!Number.isFinite(Date.parse(input.schedule.runAt))) return "请选择执行日期和时间。";
    if (Date.parse(input.schedule.runAt) <= now) return "执行时间需要晚于现在。";
  } else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.schedule.time)) return "请选择执行时间。";
    try { new Intl.DateTimeFormat([], { timeZone: input.schedule.timeZone }); }
    catch { return "请选择有效的时区。"; }
  }
  return "";
}

export function scheduleTimeZones(): Array<{ value: string; label: string }> {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const values = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone")
    ?? ["Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles"];
  return [...new Set([local, "UTC", ...values])].map(value => ({ value, label: value === local ? `${value}（本机时区）` : value }));
}
