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

/**
 * 写路径的迭代兑底：用户没选（或没传）迭代就落到默认迭代，
 * 这样「每个任务都属于一个迭代」在前端和后续 commit 总结里都成立。
 */
export function defaultMilestoneIdForWrite(storage: WandStorage): string {
  return storage.ensureDefaultWandMilestone().id;
}

export interface ResolvedTaskMilestone {
  /** 要展示 / 回传的迭代 id；任务本身没指定时就是默认迭代的 id。 */
  milestoneId: string | null;
  milestone: { id: string; name: string; isDefault: boolean } | null;
}

/**
 * 读出任务该显示的迭代：库里仍然用 NULL 表示「没单独指定」
 * （历史数据不动，写入时才开始落默认迭代），读的时候统一兑成默认迭代。
 */
export function resolvedMilestoneFields(
  storage: WandStorage,
  milestoneId: string | null | undefined,
): ResolvedTaskMilestone {
  const milestone = milestoneId
    ? storage.getWandMilestone(milestoneId)
    : storage.ensureDefaultWandMilestone();
  if (!milestone) return { milestoneId: null, milestone: null };
  return {
    milestoneId: milestone.id,
    milestone: { id: milestone.id, name: milestone.name, isDefault: milestone.isDefault },
  };
}
