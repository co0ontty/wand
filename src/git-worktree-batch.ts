import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { getGitErrorMessage, runGitAsync, runGitRawAsync } from "./git-utils.js";
import { runPush } from "./git-quick-commit.js";
import { conflict } from "./http-error.js";

interface GitWorktree {
  path: string;
  head: string;
  branch: string;
}

export interface WorktreeBatchResult {
  ok: boolean;
  targetBranch: string;
  head: string;
  mergedBranches: string[];
  skippedBranches: string[];
  pushed: boolean;
  failedBranch?: string;
  error?: string;
}

/** NUL porcelain preserves worktree paths containing spaces, quotes or newlines. */
export async function listGitWorktrees(cwd: string): Promise<GitWorktree[]> {
  const raw = await runGitRawAsync(["worktree", "list", "--porcelain", "-z"], cwd);
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const field of raw.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), head: "", branch: "" };
      worktrees.push(current);
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice(5);
    } else if (current && field.startsWith("branch refs/heads/")) {
      current.branch = field.slice(18);
    }
  }
  return worktrees;
}

const activeRepositories = new Set<string>();

/** All HTTP Git writes share one lock, including sessions in linked worktrees. */
export async function withGitRepositoryOperation<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const commonDir = realpathSync(resolve(cwd, await runGitAsync(["rev-parse", "--git-common-dir"], cwd)));
  if (activeRepositories.has(commonDir)) throw conflict("这个仓库正在执行 Git 操作，请等待当前操作结束。", "GIT_OPERATION_BUSY");
  activeRepositories.add(commonDir);
  try { return await operation(); }
  finally { activeRepositories.delete(commonDir); }
}

const pendingOperations = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];

async function assertClean(cwd: string): Promise<void> {
  for (const operation of pendingOperations) {
    const gitPath = await runGitAsync(["rev-parse", "--git-path", operation], cwd);
    if (existsSync(resolve(cwd, gitPath))) throw new Error(`${cwd} 有未完成的 Git 操作，请先处理。`);
  }
  if ((await runGitRawAsync(["status", "--porcelain=v1", "--untracked-files=all"], cwd)).trim()) {
    throw new Error(`${cwd} 有未提交修改，请先提交后再合并 Worktree。`);
  }
}

/** Merge the initial worktree snapshot into this checkout; never switch branches or delete worktrees. */
export async function mergeAllWorktreesAndPush(options: {
  cwd: string;
  expectedBranch: string;
  expectedHead: string;
}): Promise<WorktreeBatchResult> {
  const result: WorktreeBatchResult = {
    ok: false, targetBranch: options.expectedBranch, head: options.expectedHead,
    mergedBranches: [], skippedBranches: [], pushed: false,
  };
  const git = (args: string[]) => runGitAsync(args, options.cwd);
  return withGitRepositoryOperation(options.cwd, async () => {
    try {
      const root = realpathSync(await git(["rev-parse", "--show-toplevel"]));
      const assertTarget = async () => {
        const branch = await git(["branch", "--show-current"]);
        const head = await git(["rev-parse", "HEAD"]);
        if (!branch || branch !== options.expectedBranch || head !== result.head) {
          throw new Error("当前分支或提交已经变化，请刷新 Git 状态后重试。");
        }
      };
      await assertTarget();
      await assertClean(options.cwd);
      const worktrees = (await listGitWorktrees(options.cwd)).filter((item) => {
        return !existsSync(item.path) || realpathSync(item.path) !== root;
      });
      if (worktrees.length === 0) throw new Error("当前仓库没有其它 Worktree。");
      const sources = new Map<string, GitWorktree>();
      for (const worktree of worktrees) {
        if (!existsSync(worktree.path)) throw new Error(`Worktree 路径不可用：${worktree.path}`);
        await assertClean(worktree.path);
        if (!worktree.branch) throw new Error(`Worktree 处于 detached HEAD，请先创建分支：${worktree.path}`);
        if (worktree.branch !== options.expectedBranch) sources.set(worktree.branch, worktree);
      }
      const assertSources = async () => {
        for (const source of sources.values()) {
          await assertClean(source.path);
          if (await runGitAsync(["rev-parse", "HEAD"], source.path) !== source.head
            || await runGitAsync(["branch", "--show-current"], source.path) !== source.branch) {
            throw new Error(`Worktree ${source.branch} 已经变化，请刷新后重试。`);
          }
        }
      };
      for (const [branch, source] of sources) {
        result.failedBranch = branch;
        await assertTarget();
        await assertSources();
        await assertClean(options.cwd);
        const ahead = Number(await git(["rev-list", "--count", `${result.head}..${source.head}`]));
        if (ahead === 0) {
          result.skippedBranches.push(branch);
          continue;
        }
        try {
          await git(["merge", "--no-edit", "--no-gpg-sign", source.head]);
        } catch (error) {
          const mergePath = await git(["rev-parse", "--git-path", "MERGE_HEAD"]);
          let rollbackError = "";
          if (existsSync(resolve(options.cwd, mergePath))) {
            try { await git(["merge", "--abort"]); }
            catch (abortError) { rollbackError = `；撤销失败，请在当前工作区处理：${getGitErrorMessage(abortError)}`; }
          }
          throw new Error(`合并 ${branch} 失败，已停止，未推送：${getGitErrorMessage(error)}${rollbackError}`);
        }
        result.head = await git(["rev-parse", "HEAD"]);
        result.mergedBranches.push(branch);
      }
      delete result.failedBranch;
      await assertTarget();
      await assertSources();
      await assertClean(options.cwd);
      const pushed = await runPush({ cwd: options.cwd, pushCommits: true, pushTags: false,
        expectedBranch: options.expectedBranch, expectedHead: result.head });
      result.pushed = pushed.pushedCommits;
      result.ok = pushed.ok && pushed.pushedCommits;
      if (!result.ok) result.error = `已合并 ${result.mergedBranches.length} 个 Worktree；${pushed.error || "推送失败，请重试推送。"}`;
    } catch (error) {
      const progress = result.mergedBranches.length ? `已合并 ${result.mergedBranches.join("、")}；` : "";
      result.error = `${progress}${getGitErrorMessage(error)}`;
    }
    return result;
  });
}
