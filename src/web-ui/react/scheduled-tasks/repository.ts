import type { ScheduledTaskDetail, ScheduledTaskInput, ScheduledTaskSummary, TaskSchedule } from "../../../scheduled-task-types.js";
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
