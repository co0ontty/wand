// 里程碑的网络边界：所有任务面板的「新建任务 / 新建里程碑」都走这里。
// 与 /api/wand-milestones 一一对应（全局列表，不按项目隔离）。

import type { WandTaskMilestone } from "../../../task-types";
import { jsonBody, requestJson } from "../http-adapter";

/** 下拉里展示的里程碑：里程碑本体 + 看板任务数量。 */
export interface MilestoneOption extends WandTaskMilestone {
  taskCount: number;
}

export interface MilestonesRepository {
  list(): Promise<MilestoneOption[]>;
  create(input: { name: string; dueDate?: string | null }): Promise<MilestoneOption>;
}

export const httpMilestonesRepository: MilestonesRepository = {
  list() {
    return requestJson<{ milestones?: MilestoneOption[] }>("/api/wand-milestones")
      .then((payload) => payload.milestones ?? []);
  },
  create(input) {
    return requestJson<MilestoneOption>("/api/wand-milestones", jsonBody(input));
  },
};
