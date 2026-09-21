// 迭代提示词记录 + commit 生成上下文：只覆盖「记录什么、怎么隔离、选中什么」，
// 不碰模型调用（那部分在 git-quick-commit 的测试里）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  buildIterationCommitContext,
  iterationPromptDigest,
  MAX_ITERATION_PROMPT_CHARS,
  recordIterationPrompt,
  recordIterationPromptForTask,
  repoKeyForCwd,
  resetRepoKeyCache,
  resolveCommitContextInput,
  whenIterationPromptsSettled,
} from "../src/iteration-log.js";
import { WandStorage } from "../src/storage.js";
import { DEFAULT_ITERATION_NAME, type WandIterationPrompt } from "../src/task-types.js";

function tempRoot(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 建一个带初始提交的仓库；返回仓库根目录。 */
function initRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "wand-test@example.test");
  git(root, "config", "user.name", "Wand Test");
  writeFileSync(path.join(root, "tracked.txt"), "before\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "initial");
  return root;
}

function storageAt(t: TestContext, prefix: string): WandStorage {
  const storage = new WandStorage(path.join(tempRoot(t, prefix), "wand.db"));
  t.after(() => storage.close());
  return storage;
}

function promptEntry(overrides: Partial<WandIterationPrompt>): WandIterationPrompt {
  return {
    id: "entry",
    milestoneId: "milestone",
    workspaceId: null,
    sessionId: null,
    taskId: null,
    repoKey: null,
    cwd: "",
    title: "标题",
    detail: "",
    source: "session",
    consumedAt: null,
    consumedCommit: null,
    createdAt: "2026-02-14T09:05:00.000Z",
    ...overrides,
  };
}

test("repository identity merges worktrees and stays null outside a repo", async (t) => {
  resetRepoKeyCache();
  t.after(() => resetRepoKeyCache());
  const root = tempRoot(t, "wand-iteration-repokey-");
  const repo = initRepo(path.join(root, "main"));

  const key = await repoKeyForCwd(repo);
  assert.ok(key, "git 仓库必须能拿到仓库身份");
  assert.equal(await repoKeyForCwd(repo), key, "同一目录命中缓存，值不变");

  // 同一仓库的 worktree 共享一个身份：并行 worktree 的提示词会进同一份 commit 上下文。
  let supportsPathFormat = true;
  try {
    git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  } catch {
    supportsPathFormat = false;
  }
  if (supportsPathFormat) {
    const worktree = path.join(root, "wt");
    git(repo, "worktree", "add", "-q", worktree, "-b", "feature");
    assert.equal(await repoKeyForCwd(worktree), key);
  }

  // 不是仓库的目录：null，而不是抛错或空串。
  const plain = path.join(root, "plain");
  mkdirSync(plain);
  assert.equal(await repoKeyForCwd(plain), null);
  assert.equal(await repoKeyForCwd(""), null);
});

test("prompts are recorded on the session's iteration, filtered and deduped", async (t) => {
  resetRepoKeyCache();
  t.after(() => resetRepoKeyCache());
  const root = tempRoot(t, "wand-iteration-record-");
  const repo = initRepo(path.join(root, "repo"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());

  const project = storage.createWorkspace({ name: "wand", cwd: repo });
  const iteration = storage.createWandMilestone({ name: "v2 迭代", workspaceId: project.id });
  const sidebarTask = storage.createWorkspaceTask({ workspaceId: project.id, name: "登录改造" });
  storage.createWandTask({ title: "登录改造", workspaceId: project.id, workspaceTaskId: sidebarTask.id, milestoneId: iteration.id });
  const session = { id: "session-1", cwd: repo, workspaceId: project.id, workspaceTaskId: sidebarTask.id };

  // 没信息量的输入（批准、单条命令）不进记录：普通输入零额外成本。
  recordIterationPrompt(storage, session, "y");
  recordIterationPrompt(storage, session, "/clear");
  await whenIterationPromptsSettled();
  assert.equal(storage.listIterationPrompts({ includeConsumed: true }).length, 0);

  const prompt = "把登录页的错误提示改成中文，并补一条覆盖空密码的测试";
  recordIterationPrompt(storage, session, prompt);
  await whenIterationPromptsSettled();
  const rows = storage.listIterationPrompts({ includeConsumed: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.milestoneId, iteration.id);
  assert.equal(rows[0]?.workspaceId, project.id);
  assert.equal(rows[0]?.sessionId, session.id);
  assert.equal(rows[0]?.taskId, storage.getWandTaskByWorkspaceTaskId(sidebarTask.id)?.id, "按侧栏任务反查看板卡片，不依赖会话↔任务绑定行");
  assert.equal(rows[0]?.title, prompt.slice(0, rows[0]!.title.length), "标题是提示词的本地摘要，不调模型");
  assert.equal(rows[0]?.detail, prompt, "详情保留原话，不二次总结");
  assert.equal(rows[0]?.repoKey, await repoKeyForCwd(repo));
  assert.equal(rows[0]?.consumedAt, null);

  // 同一条提示词短时间内重复提交（重发 / 重连补发）只留一条。
  recordIterationPrompt(storage, session, prompt);
  await whenIterationPromptsSettled();
  assert.equal(storage.listIterationPrompts({ includeConsumed: true }).length, 1);

  // 派发 / 建任务这类没有会话输入的入口：直接用任务标题当记录，落在同一个迭代。
  recordIterationPromptForTask(storage, {
    sessionId: null, cwd: repo, workspaceId: project.id, milestoneId: iteration.id, taskId: null,
    title: "补齐设置页的导出入口", source: "dispatch",
  });
  await whenIterationPromptsSettled();
  const all = storage.listIterationPrompts({ includeConsumed: true });
  assert.equal(all.length, 2);
  assert.equal(all[1]?.title, "补齐设置页的导出入口");
  assert.equal(all[1]?.source, "dispatch");
});

test("tasks without an iteration land on the default one", async (t) => {
  const root = tempRoot(t, "wand-iteration-default-");
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());

  // 还没人建过：第一条记录会把默认迭代惰性建出来。
  assert.equal(storage.findDefaultWandMilestone(), null);
  recordIterationPrompt(storage, { id: "session-bare", cwd: "" }, "把首页改成暗色主题并截图对比");
  recordIterationPromptForTask(storage, { title: "顺手把 README 的截图换成新的", source: "task" });
  await whenIterationPromptsSettled();

  const fallback = storage.findDefaultWandMilestone();
  assert.ok(fallback, "写路径必须保证默认迭代存在");
  assert.equal(fallback.name, DEFAULT_ITERATION_NAME);
  assert.equal(fallback.isDefault, true);
  assert.equal(fallback.workspaceId, null);
  const rows = storage.listIterationPrompts({ includeConsumed: true });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.milestoneId), [fallback.id, fallback.id]);

  // 惰性创建幂等：读多少次都只有一行默认迭代。
  assert.equal(storage.ensureDefaultWandMilestone().id, fallback.id);
  assert.equal(storage.listWandMilestones().filter((item) => item.isDefault).length, 1);
});

test("an existing milestone named 默认迭代 is adopted instead of duplicated", (t) => {
  const root = tempRoot(t, "wand-iteration-adopt-");
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());

  const existing = storage.createWandMilestone({ name: DEFAULT_ITERATION_NAME, workspaceId: null });
  assert.equal(existing.isDefault, false);
  const adopted = storage.ensureDefaultWandMilestone();
  assert.equal(adopted.id, existing.id);
  assert.equal(adopted.isDefault, true);
  assert.equal(storage.listWandMilestones().length, 1);
});

test("the default iteration is global, undeletable, and absorbs legacy rows", (t) => {
  const root = tempRoot(t, "wand-iteration-guard-");
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());

  const fallback = storage.ensureDefaultWandMilestone();
  const project = storage.createWorkspace({ name: "wand", cwd: path.join(root, "repo") });

  // 默认迭代永远全局：不允许改挂到某个项目，否则别的项目就看不到兜底迭代。
  assert.equal(storage.updateWandMilestone(fallback.id, { workspaceId: project.id })?.workspaceId, null);
  assert.equal(storage.updateWandMilestone(fallback.id, { name: "随便改个名" })?.name, "随便改个名");
  // 删除被拒绝，行还在。
  assert.equal(storage.deleteWandMilestone(fallback.id), false);
  assert.ok(storage.getWandMilestone(fallback.id));

  // 历史行（milestone_id IS NULL）算在默认迭代下，数量提示才不会漏。
  storage.createWandTask({ title: "老卡片" });
  storage.createWandTask({ title: "新卡片", milestoneId: fallback.id });
  const explicit = storage.createWandMilestone({ name: "v3" });
  storage.createWandTask({ title: "指定迭代的卡片", milestoneId: explicit.id });
  const counts = storage.countWandTasksByMilestone();
  assert.equal(counts[fallback.id], 2);
  assert.equal(counts[explicit.id], 1);
});

test("digest keeps the newest prompts in order and marks already-committed ones", () => {
  const entries = [
    promptEntry({ id: "a", title: "先加登录页", createdAt: "2026-02-14T09:05:00.000Z" }),
    promptEntry({ id: "b", title: "再修登录页的空密码", detail: "顺便补测试", createdAt: "2026-02-14T10:30:00.000Z", consumedAt: "2026-02-14T11:00:00.000Z", consumedCommit: "abc1234" }),
    promptEntry({ id: "c", title: "最后改文案", createdAt: "2026-02-14T12:00:00.000Z" }),
  ];
  const digest = iterationPromptDigest(entries);
  assert.match(digest, /^1\. 02-14 09:05 先加登录页/m);
  assert.match(digest, /2\. 02-14 10:30 再修登录页的空密码 — 顺便补测试（上一轮已提交）/);
  assert.match(digest, /3\. 02-14 12:00 最后改文案/);

  // 预算不足时丢最早的历史，保留最新的几条。
  const many: WandIterationPrompt[] = [];
  for (let index = 0; index < 300; index += 1) {
    many.push(promptEntry({
      id: `e${index}`,
      title: `第 ${index} 条改动：${"很长很长".repeat(20)}`,
      createdAt: `2026-02-14T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
  }
  const bounded = iterationPromptDigest(many);
  // 预算是软的：最后一条放不下时仍会保留（宁可多一行，也不能让最新改动丢失）。
  assert.ok(bounded.length <= MAX_ITERATION_PROMPT_CHARS + 700, `摘要必须受预算约束，实际 ${bounded.length}`);
  assert.ok(bounded.includes("第 299 条改动"), "最新的改动不能被丢掉");
  assert.ok(bounded.split("\n").length < many.length, "超预算时必须丢掉最早的历史");
  assert.ok(!bounded.includes("第 0 条改动"), "最早的条目应该被丢掉");

  assert.equal(iterationPromptDigest([]), "");
});

test("commit context isolates repositories and preselects uncommitted prompts", async (t) => {
  resetRepoKeyCache();
  t.after(() => resetRepoKeyCache());
  const root = tempRoot(t, "wand-iteration-context-");
  const repoA = initRepo(path.join(root, "repo-a"));
  const repoB = initRepo(path.join(root, "repo-b"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());

  recordIterationPrompt(storage, { id: "sa", cwd: repoA }, "把 A 项目的登录页改成中文");
  recordIterationPrompt(storage, { id: "sb", cwd: repoB }, "把 B 项目的首页换成暗色");
  await whenIterationPromptsSettled();

  const context = await buildIterationCommitContext(storage, { session: { id: "sa", cwd: repoA } });
  assert.equal(context.iteration.isDefault, true);
  assert.equal(context.entries.length, 1, "别的仓库的记录不能混进来");
  assert.equal(context.entries[0]?.title, "把 A 项目的登录页改成中文");
  assert.equal(context.entries[0]?.consumed, false);
  assert.deepEqual(context.defaultEntryIds, [context.entries[0]!.id]);
  assert.equal(context.effectiveMode, "iteration");
  assert.equal(context.repoKey, await repoKeyForCwd(repoA));

  // 默认输入 = 上次提交以来的提示词。
  const auto = resolveCommitContextInput(storage, context, {});
  assert.equal(auto.mode, "iteration");
  assert.match(auto.digest, /把 A 项目的登录页改成中文/);
  assert.deepEqual(auto.entryIds, context.defaultEntryIds);

  // 提交成功后标记已用：默认勾选清空，模式自动回落 diff，历史仍可见。
  const consumedId = context.entries[0]!.id;
  assert.equal(storage.markIterationPromptsConsumed([consumedId], "deadbee"), 1);
  const afterCommit = await buildIterationCommitContext(storage, { session: { id: "sa", cwd: repoA } });
  assert.deepEqual(afterCommit.defaultEntryIds, []);
  assert.equal(afterCommit.effectiveMode, "diff");
  assert.equal(afterCommit.entries[0]?.consumed, true);
  assert.equal(afterCommit.entries[0]?.consumedCommit, "deadbee");
  assert.equal(resolveCommitContextInput(storage, afterCommit, {}).digest, "");

  // 手动勾回历史条目：明确用它们做输入，digest 会标出「上一轮已提交」。
  const manual = resolveCommitContextInput(storage, afterCommit, { mode: "iteration", entryIds: [consumedId] });
  assert.match(manual.digest, /上一轮已提交/);
  assert.deepEqual(manual.entryIds, [consumedId]);

  // 别的仓库 / 别的迭代的 id 一律不认。
  const foreign = storage.listIterationPrompts({ includeConsumed: true, repoKey: await repoKeyForCwd(repoB) });
  assert.equal(foreign.length, 1);
  assert.equal(resolveCommitContextInput(storage, afterCommit, { mode: "iteration", entryIds: [foreign[0]!.id] }).digest, "");
  assert.equal(resolveCommitContextInput(storage, afterCommit, { entryIds: ["不存在"] }).digest, "");

  // 切到 diff 模式：digest 为空（调用方去读 diff），但「本次算已提交」的集合照旧返回。
  const diffMode = resolveCommitContextInput(storage, context, { mode: "diff" });
  assert.equal(diffMode.mode, "diff");
  assert.equal(diffMode.digest, "");
  assert.deepEqual(diffMode.entryIds, context.defaultEntryIds);

  // 模式偏好按库记忆：写进偏好后，不传 mode 也读得到。
  storage.setPreference("pref:commitContextMode", "diff");
  assert.equal(resolveCommitContextInput(storage, context, {}).mode, "diff");
  storage.setPreference("pref:commitContextMode", "乱写的值");
  assert.equal(resolveCommitContextInput(storage, context, {}).mode, "iteration");
});
