import type { ScheduledTaskDetail, ScheduledTaskInput, ScheduledTaskSummary, TaskSchedule, ScheduledTaskCalendarResponse, ScheduledTaskActivityResponse, ScheduledTaskRunView } from "../../../scheduled-task-types.js";
import { jsonBody, requestJson } from "../http-adapter.js";

export interface ScheduledTaskPatch {
  revision: number;
  employeeId?: string;
  workspaceId?: string | null;
  prompt?: string;
  title?: string;
  schedule?: TaskSchedule;
  enabled?: boolean;
  cancelled?: true;
}

export const scheduledTasksRepository = {
  async list(signal?: AbortSignal): Promise<ScheduledTaskSummary[]> {
    const result = await requestJson<{ tasks: ScheduledTaskSummary[] }>("/api/scheduled-tasks?includeCancelled=1", { cache: "no-store", signal });
    return result.tasks;
  },
  async calendar(from: string, to: string, timeZone: string, signal?: AbortSignal): Promise<ScheduledTaskCalendarResponse> {
    const query = new URLSearchParams({ from, to, timeZone });
    const result = await requestJson<ScheduledTaskCalendarResponse>(`/api/scheduled-tasks/calendar?${query}`, { cache: "no-store", signal });
    if (!Array.isArray(result.tasks) || !Array.isArray(result.entries) || !result.range || !Number.isFinite(Date.parse(result.generatedAt))) throw new Error("服务器返回的日历数据不完整。");
    return result;
  },
  async activity(id: string, timeZone: string, signal?: AbortSignal): Promise<ScheduledTaskActivityResponse> {
    const result = await requestJson<ScheduledTaskActivityResponse>(`/api/scheduled-tasks/${encodeURIComponent(id)}/activity?${new URLSearchParams({ timeZone })}`, { cache: "no-store", signal });
    if (!Array.isArray(result.runs) || !result.range || !Number.isFinite(Date.parse(result.generatedAt))) throw new Error("服务器返回的执行情况不完整。");
    return result;
  },
  async run(id: string, runId: string, signal?: AbortSignal): Promise<ScheduledTaskRunView> {
    const result = await requestJson<{ run: ScheduledTaskRunView }>(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`, { cache: "no-store", signal });
    if (!result.run || result.run.taskId !== id || result.run.id !== runId) throw new Error("执行记录与所选任务不一致。");
    return result.run;
  },
  detail(id: string, signal?: AbortSignal): Promise<ScheduledTaskDetail> {
    return requestJson(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { cache: "no-store", signal });
  },
  async create(input: ScheduledTaskInput): Promise<ScheduledTaskSummary> {
    const result = await requestJson<{ task: ScheduledTaskSummary }>("/api/scheduled-tasks", jsonBody(input));
    return result.task;
  },
  async update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTaskSummary> {
    const result = await requestJson<{ task: ScheduledTaskSummary }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, jsonBody(patch, "PATCH"));
    return result.task;
  },
};
