import type { Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { asyncRoute } from "./express-async.js";
import { badRequest, conflict, notFound } from "./http-error.js";
import { sendRouteError } from "./server-request.js";
import type { WandStorage } from "./storage.js";
import type { SessionRegistry } from "./session-registry.js";
import { sessionExecutionStatus } from "./execution-state.js";
import { readWorkspaceDirectory } from "./workspace-directory.js";
import { checkSessionWorktreeMergeabilityAsync, mergeSessionWorktreeAsync } from "./git-worktree.js";
import { withGitRepositoryOperation } from "./git-worktree-batch.js";
import { runGitAsync } from "./git-utils.js";

export function registerWorkspaceDirectoryRoutes(app: Express, storage: WandStorage, sessions?: SessionRegistry): void {
  const workspace = (id: string) => {
    const value = storage.getWorkspace(id);
    if (!value || !value.userAdded) throw notFound("未找到手动添加的工作区。");
    return value;
  };
  app.get("/api/workspaces/:id/directory", asyncRoute(async (req, res) => {
    try { const project = workspace(req.params.id); res.json(await readWorkspaceDirectory(project.id, project.cwd)); }
    catch (error) { sendRouteError(res, error, "无法读取目录分支与 Worktree。"); }
  }));
  const inspect = async (id: string, sourcePath: unknown) => {
    const project = workspace(id);
    const directory = await readWorkspaceDirectory(id, project.cwd);
    const source = directory.worktrees.find(tree => tree.path === sourcePath);
    if (!source || !source.branch || !directory.branch || source.branch === directory.branch) throw badRequest("请选择当前仓库中有分支的独立 Worktree。");
    const allSessions = sessions?.listSlim() ?? storage.loadSessionsSlim();
    for (const session of allSessions) {
      const active = sessionExecutionStatus(session) !== null || session.structuredState?.inFlight || session.ptyBusy || session.ptyCommandRunning
        || session.permissionBlocked || session.pendingEscalation || (session.queuedMessages?.length ?? 0) > 0;
      if (!active) continue;
      const cwd = await realpath(session.worktree?.path || session.cwd || "/").catch(() => path.resolve(session.cwd || "/"));
      if ([directory.root, source.path].some(root => cwd === root || cwd.startsWith(`${root}${path.sep}`))) {
        throw conflict("来源或目标目录仍有会话在运行、等待确认或排队，请结束后再合并。", "WORKTREE_BUSY");
      }
    }
    const targetDirty = Boolean(await runGitAsync(["status", "--porcelain", "--untracked-files=all"], directory.root));
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      for (const cwd of [directory.root, source.path]) {
        const markerPath = await runGitAsync(["rev-parse", "--git-path", marker], cwd);
        if (existsSync(path.resolve(cwd, markerPath))) throw conflict("目录内有未完成的 Git 操作，请先处理后再合并。", "GIT_OPERATION_PENDING");
      }
    }
    const result = await checkSessionWorktreeMergeabilityAsync({ worktree: { ...source, repoRoot: directory.root }, targetBranch: directory.branch });
    // The legacy merge implementation operates on the main checkout; never switch an unrelated checkout.
    const sameTarget = path.resolve(result.repoRoot) === path.resolve(directory.root);
    return { ...result, ok: result.ok && !targetDirty && sameTarget,
      reason: targetDirty ? "目标目录有未提交改动，需要 Agent 检查并保留已有工作。" : !sameTarget ? "目标不是主工作目录，请交给 Agent 在指定目录合并。" : result.reason,
      agentPrompt: [
        `请将工作区「${project.name}」的 ${source.branch} 合并到 ${directory.branch}。`,
        `来源 Worktree：${source.path}`, `目标工作目录：${directory.root}`,
        `检查结果：${targetDirty ? "目标有未提交改动；" : ""}${result.reason || "请重新核对仓库状态"}`,
        "先读取项目约定并重新检查来源、目标分支与所有关联会话；有运行或排队中的工作时等待，不并发修改。",
        "保留已有改动，理解双方意图后解决冲突并运行必要验证；业务取舍不明确时先询问。不得强制覆盖、丢弃改动或自动 push。",
        "确认合并和验证结果后汇报；不要自动清理 Worktree 或任务分支。",
      ].join("\n"),
      targetDirty, agentAllowed: !result.ok || targetDirty || !sameTarget,
      sourceHead: source.head, targetHead: directory.head, targetCwd: directory.root,
      workspaceId: id, sourceBranch: source.branch, targetBranch: directory.branch, worktreePath: source.path };
  };
  app.post("/api/workspaces/:id/directory/merge-check", asyncRoute(async (req, res) => {
    try { res.json(await inspect(req.params.id, req.body?.sourcePath)); }
    catch (error) { sendRouteError(res, error, "无法检查合并状态。"); }
  }));
  app.post("/api/workspaces/:id/directory/merge", asyncRoute(async (req, res) => {
    try {
      const project = workspace(req.params.id);
      const result = await withGitRepositoryOperation(project.cwd, async () => {
        const checked = await inspect(project.id, req.body?.sourcePath);
        if (!checked.ok) throw conflict(checked.reason || "当前无法一键合并，请重新检查。", "WORKTREE_NOT_READY");
        if (req.body?.sourceHead !== checked.sourceHead || req.body?.targetHead !== checked.targetHead
          || req.body?.sourceBranch !== checked.sourceBranch || req.body?.targetBranch !== checked.targetBranch) {
          throw conflict("来源或目标分支已变化，请重新检查后确认。", "WORKTREE_CHANGED");
        }
        const merged = await mergeSessionWorktreeAsync({ worktree: { path: checked.worktreePath, branch: checked.sourceBranch, repoRoot: checked.repoRoot }, targetBranch: checked.targetBranch, expectedSourceHead: checked.sourceHead, expectedTargetHead: checked.targetHead });
        for (const session of sessions?.listSlim() ?? []) {
          if (session.worktree?.path !== checked.worktreePath) continue;
          sessions?.updateWorktreeState(session.id, "merged", {
            targetBranch: merged.targetBranch, mergedAt: merged.mergedAt, mergeCommit: merged.mergeCommit,
            cleanupDone: merged.cleanupDone, conflict: false, lastError: undefined,
          });
        }
        return merged;
      });
      res.json(result);
    } catch (error) { sendRouteError(res, error, "合并未完成，请刷新 Git 状态后核对结果，勿重复提交。"); }
  }));
}
