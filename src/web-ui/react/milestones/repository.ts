// 里程碑的网络边界：所有任务面板的「新建任务 / 新建里程碑」都走这里。
// 与 /api/wand-milestones 一一对应（全局列表，不按项目隔离）。

import type { WandTaskMilestone } from "../../../task-types";

/** 下拉里展示的里程碑：里程碑本体 + 看板任务数量。 */
export interface MilestoneOption extends WandTaskMilestone {
  taskCount: number;
}

export interface MilestonesRepository {
  list(): Promise<MilestoneOption[]>;
  create(input: { name: string; dueDate?: string | null }): Promise<MilestoneOption>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok || body.error) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

function json(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const httpMilestonesRepository: MilestonesRepository = {
  list() {
    return request<{ milestones?: MilestoneOption[] }>("/api/wand-milestones")
      .then((payload) => payload.milestones ?? []);
  },
  create(input) {
    return request<MilestoneOption>("/api/wand-milestones", json(input));
  },
};
