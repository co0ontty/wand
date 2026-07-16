import type {
  WorktreeMergeInspection,
  WorktreeMergeOpenContext,
  WorktreeMergeResult,
} from "./types";

export interface WorktreeMergeAvailability {
  allowed: boolean;
  reason: string;
}

export function worktreeMergeAvailability(
  context: WorktreeMergeOpenContext,
): WorktreeMergeAvailability {
  if (!context.sessionId.trim()) {
    return { allowed: false, reason: "未找到对应会话。" };
  }
  if (context.sessionStatus === "running") {
    return { allowed: false, reason: "会话仍在运行，请结束后再合并或清理。" };
  }
  if (context.mergeStatus === "merging") {
    return { allowed: false, reason: "Worktree 正在合并，请等待当前操作完成。" };
  }
  if (context.intent === "cleanup") {
    return context.cleanupPending === true
      ? { allowed: true, reason: "" }
      : { allowed: false, reason: "当前 worktree 无需补偿清理。" };
  }
  if (!context.sourceBranch?.trim() || !context.worktreePath?.trim()) {
    return { allowed: false, reason: "该会话没有可合并的 worktree 信息。" };
  }
  if (context.mergeStatus === "merged") {
    return context.cleanupPending
      ? { allowed: false, reason: "分支已经合并，请改为重试 worktree 清理。" }
      : { allowed: false, reason: "该 worktree 已完成合并和清理。" };
  }
  return { allowed: true, reason: "" };
}

export function canConfirmWorktreeMerge(
  inspection: WorktreeMergeInspection | null,
): boolean {
  return !!inspection
    && inspection.ok
    && inspection.recommendedAction === "merge"
    && inspection.aheadCount > 0
    && !inspection.hasUncommittedChanges
    && !inspection.hasConflicts;
}

export function worktreeMergeResultMessage(result: WorktreeMergeResult): string {
  const target = result.targetBranch || "主分支";
  return result.cleanupDone
    ? `已合并到 ${target} 并完成 worktree 清理。`
    : `已合并到 ${target}，但工作树仍待清理。`;
}

export function inspectionStatusMessage(inspection: WorktreeMergeInspection): string {
  if (inspection.ok) return `检查通过，可将 ${inspection.aheadCount} 个提交合并到 ${inspection.targetBranch || "目标分支"}。`;
  if (inspection.reason) return inspection.reason;
  if (inspection.hasUncommittedChanges) return "Worktree 中仍有未提交改动，请先提交后再合并。";
  if (inspection.hasConflicts) return "检测到冲突风险，请先手动处理。";
  if (inspection.aheadCount <= 0) return "当前 worktree 没有可合并的新提交。";
  return "当前 worktree 暂不可合并。";
}
