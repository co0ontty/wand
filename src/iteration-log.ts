// 迭代提示词记录：把「我这一轮迭代到底让 Agent 改了什么」沉淀成一串提示词标题，
// 供 commit message / 汇报类生成直接引用，不必每次都让模型读 diff（省 token 也更快）。
//
// 两条不变式：
//   1. 记录一定挂在某个真实迭代上；用户没选迭代时落到全局「默认迭代」（惰性创建）。
//   2. 记录按仓库隔离（repoKey = git 的 common dir）：同一仓库的 worktree 共享，
//      别的项目的历史不会混进这次 commit message。

import path from "node:path";

import { getErrorMessage } from "./error-utils.js";
import { runGitAsync } from "./git-utils.js";
import { shouldGenerateSessionTopicFromInput, summarizeSessionTitleFromInput } from "./session-topic.js";
import type { WandStorage } from "./storage.js";
import {
  DEFAULT_ITERATION_NAME,
  WAND_ITERATION_PROMPT_DETAIL_MAX_LENGTH,
  WAND_ITERATION_PROMPT_TITLE_MAX_LENGTH,
  type WandIterationPrompt,
  type WandIterationPromptSource,
} from "./task-types.js";

/** commit 生成的输入模式：iteration = 只用本轮提示词（默认，省 token）；diff = 读完整 diff。 */
export type CommitContextMode = "iteration" | "diff";

/** 用户在上次选择后记住的模式；两条互不影响，互相切不会被覆盖。 */
export const COMMIT_CONTEXT_MODE_PREF_KEY = "pref:commitContextMode";

export function isCommitContextMode(value: unknown): value is CommitContextMode {
  return value === "iteration" || value === "diff";
}

/** 读取记住的模式；没存过 / 存坏了就用默认（提示词优先，省 token）。 */
export function readCommitContextMode(storage: WandStorage, override?: unknown): CommitContextMode {
  if (isCommitContextMode(override)) return override;
  const stored = storage.getPreference<string>(COMMIT_CONTEXT_MODE_PREF_KEY, "iteration");
  return isCommitContextMode(stored) ? stored : "iteration";
}

/** 记录时用到的会话信息：两个 manager 的 snapshot 都满足这个结构。 */
export interface IterationPromptSession {
  id: string;
  cwd?: string;
  workspaceId?: string;
  workspaceTaskId?: string;
}

export interface IterationPromptTarget {
  milestoneId: string;
  /** 这个迭代的名字；UI 上用来显示「本次迭代：默认迭代」。 */
  milestoneName: string;
  isDefaultIteration: boolean;
  workspaceId: string | null;
  taskId: string | null;
  repoKey: string | null;
}

/** 单次生成的提示词清单上限：够覆盖一轮迭代，又不至于把 prompt 撑爆。 */
export const MAX_ITERATION_PROMPT_ENTRIES = 120;

/** 提示词清单的总字符预算，超出后从最旧的开始丢。 */
export const MAX_ITERATION_PROMPT_CHARS = 12_000;

const REPO_KEY_TIMEOUT_MS = 5_000;
const DUPLICATE_WINDOW_MS = 120_000;

const repoKeyCache = new Map<string, string | null>();

/**
 * 仓库身份：`git rev-parse --git-common-dir` 的绝对路径。
 * worktree 与主仓库拿到同一个值，因此「同一项目的并行 worktree」会被算成一个仓库。
 * 结果按目录缓存；拿不到（不是 git 仓库 / 没有 git）时缓存 null，不反复重试。
 */
export async function repoKeyForCwd(cwd: string | undefined | null): Promise<string | null> {
  const directory = path.resolve(cwd?.trim() || "");
  if (!cwd?.trim()) return null;
  const cached = repoKeyCache.get(directory);
  if (cached !== undefined) return cached;
  let key: string | null = null;
  try {
    key = await runGitAsync(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      directory,
      { timeout: REPO_KEY_TIMEOUT_MS },
    ) || null;
  } catch {
    // 老版本 git 不认 --path-format：退回 --show-toplevel，至少能把「同一目录树」聚在一起。
    try {
      key = await runGitAsync(["rev-parse", "--show-toplevel"], directory, { timeout: REPO_KEY_TIMEOUT_MS }) || null;
    } catch {
      key = null;
    }
  }
  repoKeyCache.set(directory, key ?? null);
  return key ?? null;
}

/** 测试用：清掉目录 → 仓库身份缓存。 */
export function resetRepoKeyCache(): void {
  repoKeyCache.clear();
}

/**
 * 这条提示词应该记到哪个迭代下：
 *   会话绑定的看板任务 → 它所属工作区的任务 → 都没绑就落到默认迭代。
 * 只有写路径调用，所以这里会惰性把默认迭代建出来。
 */
export function resolveIterationPromptTarget(
  storage: WandStorage,
  session: IterationPromptSession,
): IterationPromptTarget {
  const workspaceTask = session.workspaceTaskId ? storage.getWorkspaceTask(session.workspaceTaskId) : null;
  // 会话多数是从侧栏任务起的（有 workspaceTaskId），直接按它反查卡片；没绑时才看 wand_task_sessions。
  const task = workspaceTask
    ? storage.getWandTaskByWorkspaceTaskId(workspaceTask.id)
    : (() => {
        const taskId = storage.getWandTaskIdForSession(session.id);
        return taskId ? storage.getWandTask(taskId) : null;
      })();
  // 任务上的迭代优先，其次看它所属侧栏任务的迭代，最后兜底默认迭代。
  const explicitId = task?.milestoneId || workspaceTask?.milestoneId || null;
  const explicit = explicitId ? storage.getWandMilestone(explicitId) : null;
  // 只有写路径会走到这里，所以可以惰性把默认迭代建出来。
  const milestone = explicit ?? storage.ensureDefaultWandMilestone();
  return {
    milestoneId: milestone.id,
    milestoneName: milestone.name,
    isDefaultIteration: milestone.isDefault,
    workspaceId: session.workspaceId ?? task?.workspaceId ?? workspaceTask?.workspaceId ?? null,
    taskId: task?.id ?? null,
    repoKey: null,
  };
}

/** 提示词摘要清洗：去掉控制字符、压空白；保留用户原话，不做二次总结。 */
export function cleanIterationPromptText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

/** 本地标题：取提示词第一条有效行，不调模型（省一次调用，也不阻塞输入）。 */
export function iterationPromptTitle(prompt: string): string {
  const cleaned = cleanIterationPromptText(prompt);
  if (!cleaned) return "";
  return clip(summarizeSessionTitleFromInput(cleaned) || cleaned, WAND_ITERATION_PROMPT_TITLE_MAX_LENGTH);
}

let writeChain: Promise<void> = Promise.resolve();

/** 测试用：等待排队中的记录写入全部落地。 */
export function whenIterationPromptsSettled(): Promise<void> {
  return writeChain;
}

/**
 * 记录一条提示词。调用点都在用户提交输入的热路径上，所以它：
 *   - 同步过滤没信息量的输入（y / 单条命令 / 斜杠命令），不产生任何 IO；
 *   - 把真正的写入排进串行队列，不阻塞输入；
 *   - 永不抛错（记录失败不该影响会话）。
 */
export function recordIterationPrompt(
  storage: WandStorage,
  session: IterationPromptSession,
  prompt: string,
  source: WandIterationPromptSource = "session",
  options: { skipFilter?: boolean } = {},
): void {
  const raw = prompt?.trim();
  if (!raw) return;
  // 与会话标题共用同一把尺子：太短的输入不值得进迭代记录。
  if (!options.skipFilter && !shouldGenerateSessionTopicFromInput(raw)) return;
  const run = async (): Promise<void> => {
    try {
      const detail = clip(cleanIterationPromptText(raw), WAND_ITERATION_PROMPT_DETAIL_MAX_LENGTH);
      const title = iterationPromptTitle(raw) || clip(detail, WAND_ITERATION_PROMPT_TITLE_MAX_LENGTH);
      if (!title) return;
      const previous = storage.latestIterationPromptForSession(session.id);
      if (
        previous
        && previous.title === title
        && previous.detail === detail
        && Date.now() - Date.parse(previous.createdAt) < DUPLICATE_WINDOW_MS
      ) {
        return;
      }
      const target = resolveIterationPromptTarget(storage, session);
      const repoKey = await repoKeyForCwd(session.cwd);
      storage.createIterationPrompt({
        milestoneId: target.milestoneId,
        workspaceId: target.workspaceId,
        sessionId: session.id,
        taskId: target.taskId,
        repoKey,
        cwd: session.cwd ?? "",
        title,
        detail,
        source,
      });
    } catch (error) {
      console.error(`[Iteration] Failed to record prompt for session ${session.id}:`, getErrorMessage(error));
    }
  };
  writeChain = writeChain.then(run, run);
}

/** 任务 / 派发这类没有会话输入的入口：直接用任务标题当记录。 */
export function recordIterationPromptForTask(
  storage: WandStorage,
  input: {
    sessionId?: string | null;
    cwd?: string;
    workspaceId?: string | null;
    milestoneId?: string | null;
    taskId?: string | null;
    title: string;
    detail?: string;
    source: WandIterationPromptSource;
  },
): void {
  const raw = input.detail?.trim() || input.title.trim();
  if (!raw) return;
  const run = async (): Promise<void> => {
    try {
      const milestone = input.milestoneId
        ? storage.getWandMilestone(input.milestoneId)
        : null;
      const fallback = milestone ?? storage.ensureDefaultWandMilestone();
      const repoKey = await repoKeyForCwd(input.cwd);
      storage.createIterationPrompt({
        milestoneId: fallback.id,
        workspaceId: input.workspaceId ?? null,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        repoKey,
        cwd: input.cwd ?? "",
        title: clip(cleanIterationPromptText(input.title), WAND_ITERATION_PROMPT_TITLE_MAX_LENGTH),
        detail: clip(cleanIterationPromptText(raw), WAND_ITERATION_PROMPT_DETAIL_MAX_LENGTH),
        source: input.source,
      });
    } catch (error) {
      console.error("[Iteration] Failed to record task prompt:", getErrorMessage(error));
    }
  };
  writeChain = writeChain.then(run, run);
}

/** `2026-02-14T09:05:00.000Z` → `02-14 09:05`（UTC，稳定可测）。 */
function shortStamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : iso;
}

/**
 * 把记录拼成给模型看的清单：按时间正序，附时间、标题与摘要；
 * 已被上一轮提交用掉的条目会被标出来，方便模型少写重复内容。
 */
export function iterationPromptDigest(entries: readonly WandIterationPrompt[]): string {
  let budget = MAX_ITERATION_PROMPT_CHARS;
  const kept: string[] = [];
  // 从最新的往回装：预算不够时丢掉的总是最早的历史，越新的改动越不会丢。
  for (let index = entries.length - 1; index >= 0 && budget > 0; index -= 1) {
    const entry = entries[index];
    const consumed = entry.consumedAt ? "（上一轮已提交）" : "";
    // 标题往往是详情被裁短的前缀，这时只给详情，避免同一句话重复两遍。
    const body = entry.detail && entry.detail !== entry.title && !entry.detail.startsWith(entry.title)
      ? `${entry.title} — ${entry.detail}`
      : entry.detail || entry.title;
    const line = `${shortStamp(entry.createdAt)} ${body}${consumed}`;
    if (line.length > budget && kept.length > 0) break;
    kept.unshift(line);
    budget -= line.length + 1;
  }
  return kept.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

/** 迭代为空时给模型的一句话，避免它把「没有输入」理解成「没有改动」。 */
export const EMPTY_ITERATION_DIGEST_HINT = `（本迭代还没有记录到提示词，改为依据文件改动判断。）`;

/** 默认迭代的名字；UI 与文档共用，避免各处硬编码。 */
export const DEFAULT_ITERATION_LABEL = DEFAULT_ITERATION_NAME;

// ── 一屏可选的「本轮变更」上下文 ──

/** 面板里的一行：就是一条提示词记录 + 是否已被上一轮提交用掉。 */
export interface IterationCommitEntry {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  consumed: boolean;
  consumedCommit: string | null;
  source: WandIterationPromptSource;
}

export interface IterationCommitContext {
  /** 会话当前所属迭代（未选迭代时就是默认迭代）。 */
  iteration: { id: string; name: string; isDefault: boolean };
  repoKey: string | null;
  /** 面板可展示的条目，新的在前（从上往下看就是「最近改了什么」）。 */
  entries: IterationCommitEntry[];
  /** 默认勾选：还没被上一轮提交用掉的那些（= 上次提交以来的变更），时间正序。 */
  defaultEntryIds: string[];
  /** 允许提交的 id 全集（比 entries 宽），用于校验前端传回来的勾选。 */
  selectableIds: string[];
  /** 是否还有更早的历史没被取到（面板据此提示「更多历史」）。 */
  truncated: boolean;
  /** 默认模式下后端会用哪个输入：有未提交提示词就 iteration，否则 diff。 */
  effectiveMode: CommitContextMode;
}

function toCommitEntry(entry: WandIterationPrompt): IterationCommitEntry {
  return {
    id: entry.id,
    title: entry.title,
    detail: entry.detail,
    createdAt: entry.createdAt,
    consumed: !!entry.consumedAt,
    consumedCommit: entry.consumedCommit,
    source: entry.source,
  };
}

/**
 * 组装 commit 生成面板要的上下文：
 *   - 会话 → 迭代（没选迭代就是默认迭代）；
 *   - 按仓库隔离（同一仓库的 worktree 共享，不混别的项目）；
 *   - 默认勾选尚未被提交消费的条目，也就是「两次迭代之间」的提示词。
 * 纯读操作，不写库。
 */
export async function buildIterationCommitContext(
  storage: WandStorage,
  input: { session: IterationPromptSession; milestoneId?: string | null; limit?: number },
): Promise<IterationCommitContext> {
  const explicit = input.milestoneId ? storage.getWandMilestone(input.milestoneId) : null;
  const target = explicit
    ? { id: explicit.id, name: explicit.name, isDefault: explicit.isDefault }
    : (() => {
        const resolved = resolveIterationPromptTarget(storage, input.session);
        return { id: resolved.milestoneId, name: resolved.milestoneName, isDefault: resolved.isDefaultIteration };
      })();
  // 拿不到仓库身份（不是 git 仓库 / 没装 git）时不按仓库过滤，宁可多给几条也不给空面板。
  const repoKey = await repoKeyForCwd(input.session.cwd);
  const displayLimit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 60)));
  // 取「展示窗口」和「未提交集合」两次：展示只要最近的，默认勾选则要拿全。
  const rows = storage.listIterationPrompts({
    milestoneId: target.id,
    repoKey,
    includeConsumed: true,
    limit: 200,
  });
  const pending = storage.listIterationPrompts({
    milestoneId: target.id,
    repoKey,
    includeConsumed: false,
    limit: MAX_ITERATION_PROMPT_ENTRIES,
  });
  const defaultEntryIds = pending.map((entry) => entry.id);
  return {
    iteration: target,
    repoKey,
    entries: rows.slice(-displayLimit).reverse().map(toCommitEntry),
    defaultEntryIds,
    selectableIds: rows.map((entry) => entry.id),
    truncated: rows.length >= 200 || pending.length >= MAX_ITERATION_PROMPT_ENTRIES,
    effectiveMode: defaultEntryIds.length > 0 ? "iteration" : "diff",
  };
}

/**
 * 把用户勾选的条目（不传就是默认的「上次提交以来」）转成给模型的输入。
 *   - `entryIds`：本次算作已提交的条目（提交成功后由调用方标记，构成下一轮的窗口起点）；
 *     diff 模式下也返回，因为「提交发生了」是仓库事实，不取决于 message 是谁写的。
 *   - `digest`：空表示调用方应该退回读 diff（切了 diff 模式、或没有可用提示词）。
 */
export function resolveCommitContextInput(
  storage: WandStorage,
  context: IterationCommitContext,
  body: { mode?: unknown; entryIds?: unknown },
): { mode: CommitContextMode; digest: string; entryIds: string[] } {
  const mode = readCommitContextMode(storage, body.mode);
  const selected = Array.isArray(body.entryIds)
    ? body.entryIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : null;
  // 只认这个迭代（而且同仓库）里的条目：前端传错 / 传了别的迭代也不会串味。
  const allowed = new Set(context.selectableIds);
  const ids = (selected ?? context.defaultEntryIds).filter((id) => allowed.has(id));
  if (mode !== "iteration" || ids.length === 0) return { mode, digest: "", entryIds: ids };
  const digest = iterationPromptDigest(storage.listIterationPromptsByIds(ids));
  return digest ? { mode, digest, entryIds: ids } : { mode, digest: "", entryIds: ids };
}
