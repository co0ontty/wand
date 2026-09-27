import type {
  Workspace,
  WorkspaceWorktreeOverview,
  WorkspaceWorktreeReview,
} from "./types";

/** Prefer the task's intent; a recent commit adds concrete implementation context. */
export function workspaceWorktreeSummary(worktree: WorkspaceWorktreeReview): string {
  const commit = worktree.commits[0]?.subject.trim();
  if (commit && commit !== worktree.taskName.trim()) return `${worktree.taskName} · ${commit}`;
  return worktree.taskName || commit || worktree.branch;
}

/**
 * 合并 Agent 的提示词分两段：角色与规则走会话的系统提示（`system`），
 * 本次任务的实际内容（路径、目标分支、Worktree 清单）走用户消息（`message`）。
 */
export interface WorkspaceMergeAgentBrief {
  system: string;
  message: string;
}

/**
 * Build the complete merge mission behind one small interface. The Agent gets
 * canonical paths and refs from the server review, never from unchecked UI text.
 */
export function buildWorkspaceMergeAgentBrief(
  workspace: Workspace,
  overview: WorkspaceWorktreeOverview,
  selectedTaskIds: readonly string[],
): WorkspaceMergeAgentBrief {
  const selected = new Set(selectedTaskIds);
  const worktrees = overview.worktrees.filter((worktree) => selected.has(worktree.taskId) && worktree.actionable);
  if (!overview.targetBranch) throw new Error("无法识别项目默认分支。");
  if (worktrees.length === 0) throw new Error("请至少选择一个有待合并改动的 Worktree。");

  const manifest = worktrees.map((worktree, index) => ({
    order: index + 1,
    task: worktree.taskName,
    branch: worktree.branch,
    worktreePath: worktree.path,
    baseRef: worktree.baseRef || null,
    uncommittedChanges: worktree.hasUncommittedChanges,
    potentialConflict: worktree.hasConflicts,
    commitsAhead: worktree.aheadCount,
    commitSubjects: worktree.commits.map((commit) => commit.subject).filter(Boolean),
  }));

  return {
    system: [
      `你是 Wand 为项目「${workspace.name}」启动的 Worktree 合并 Agent。`,
      `项目主工作区：${overview.repoRoot || workspace.cwd}`,
      `唯一目标分支：${overview.targetBranch}`,
      "",
      "## 执行要求",
      "1. 先读取项目内适用的 AGENTS.md/agent.md 与仓库约定，再检查主工作区和每个 Worktree 的真实 Git 状态。",
      "2. 对有未提交改动的 Worktree，先理解改动、完成必要验证，并创建清晰的提交；不得丢弃或覆盖现有用户改动。",
      `3. 只把清单中的分支合并到 ${overview.targetBranch}，按清单顺序逐个处理；不要改为其他目标分支。`,
      "4. 遇到冲突时理解双方意图后解决并验证；若无法安全判断，停止在可恢复状态并清楚报告，不要强行覆盖。",
      "5. 合并完成后运行与改动相称的测试。不要 push，也不要删除 Worktree、任务分支或 Wand 的项目任务记录。",
      "6. 最后汇报每个 Worktree 的提交/合并结果、测试结果，以及任何仍需人工处理的问题。",
    ].join("\n"),
    message: [
      "## 本次要合并的 Worktree（按此顺序处理）",
      JSON.stringify(manifest, null, 2),
    ].join("\n"),
  };
}
