// 里程碑（迭代）的网络边界：所有任务面板的「新建任务 / 新建里程碑」都走这里。
// 服务端返回全量列表（带 workspaceId），面板按当前工作区本地过滤。

import type { WandTaskMilestone } from "../../../task-types";
import { jsonBody, requestJson } from "../http-adapter";

/** 下拉里展示的里程碑：里程碑本体 + 看板任务数量。 */
export interface MilestoneOption extends WandTaskMilestone {
  taskCount: number;
}

export interface MilestonesRepository {
  list(): Promise<MilestoneOption[]>;
  create(input: { name: string; dueDate?: string | null; workspaceId?: string | null }): Promise<MilestoneOption>;
  /** 改挂工作区；null 表示变回全局迭代。 */
  update(id: string, patch: { workspaceId: string | null }): Promise<MilestoneOption>;
}

export const httpMilestonesRepository: MilestonesRepository = {
  list() {
    return requestJson<{ milestones?: MilestoneOption[] }>("/api/wand-milestones")
      .then((payload) => payload.milestones ?? []);
  },
  create(input) {
    return requestJson<MilestoneOption>("/api/wand-milestones", jsonBody(input));
  },
  update(id, patch) {
    return requestJson<MilestoneOption>(`/api/wand-milestones/${encodeURIComponent(id)}`, jsonBody(patch, "PATCH"));
  },
};
