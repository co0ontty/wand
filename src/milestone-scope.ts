// 迭代（里程碑）按工作区归属，规则只有一条：
// 项目里的任务只能挂「本项目的迭代」或「全局迭代（没绑工作区的）」。
// 没归属项目的任务（未分配 / 隐藏的全局工作区）不受限，避免把独立任务限制死。
// 移动端只会 PATCH `workspaceId`，不会自己清里程碑，所以这条规则必须由服务端兜住。

import type { WandStorage } from "./storage.js";

/**
 * 把里程碑 id 收敛到「任务所在工作区能用」的范围；不兼容就返回 null（解绑）。
 * 调用方负责先校验 id 是否存在。
 */
export function scopedMilestoneId(
  storage: WandStorage,
  milestoneId: string | null | undefined,
  workspaceId: string | null | undefined,
): string | null {
  if (!milestoneId) return null;
  const milestone = storage.getWandMilestone(milestoneId);
  // 里程碑没了 / 是全局迭代：原样保留。
  if (!milestone || !milestone.workspaceId) return milestoneId;
  // 任务不在项目里：不限。
  if (!workspaceId) return milestoneId;
  return milestone.workspaceId === workspaceId ? milestoneId : null;
}
