export type WandTaskStatus = "todo" | "doing" | "done" | "archived";

/** 已确认或已归档：不再算未完成，也不会被未分组会话同步重新打开。 */
export function isClosedWandTaskStatus(status: WandTaskStatus): boolean {
  return status === "done" || status === "archived";
}
export type WandTaskPriority = "none" | "low" | "medium" | "high" | "urgent";

/** 新建任务的默认优先级：用户没挑就是「低」，不再落成「无优先级」。 */
export const DEFAULT_WAND_TASK_PRIORITY: WandTaskPriority = "low";

/** 任务派发时选择的 CLI 工具；空串表示尚未指定。 */
export type WandTaskAgentProvider = "claude" | "codex" | "opencode" | "grok" | "qoder" | "pi";
export type WandTaskAgentModel = string;
export type WandTaskAgentEffort = "off" | "standard" | "deep" | "max";

/**
 * 派发时的执行模式，只暴露三种：
 *   - managed：托管，自动确认全部权限并使用完全自主提示词；
 *   - full-access：全限，自动确认权限但仍保留交互语义；
 *   - default：标准，逐步确认操作。
 */
export type WandTaskAgentMode = "managed" | "full-access" | "default";

/** 合法执行模式清单；顺序即下拉顺序。 */
export const WAND_TASK_AGENT_MODES: readonly WandTaskAgentMode[] = ["managed", "full-access", "default"];

/** 历史行没有 mode 字段时的兜底：标准模式，与旧 `mode: "agent"` 的权限姿态一致。 */
export const DEFAULT_WAND_TASK_AGENT_MODE: WandTaskAgentMode = "default";

export function isWandTaskAgentMode(value: unknown): value is WandTaskAgentMode {
  return value === "managed" || value === "full-access" || value === "default";
}

/**
 * 各 provider 实际支持的工作模式。Codex 只有 full-access 一个有效值
 * （与新建会话的 `supportedModes` / `/api/sessions/:id/mode` 一致）；
 * 否则 `default` 会让 codex 以 `--sandbox read-only` 跑，派发的任务根本改不了代码。
 */
export function supportedWandTaskAgentModes(
  provider: WandTaskAgentProvider,
): readonly WandTaskAgentMode[] {
  if (provider === "codex") return ["full-access"];
  return WAND_TASK_AGENT_MODES;
}

/** 把任意（含旧数据 / 其它客户端缺省的）模式夹到该 provider 真正支持的值。 */
export function normalizeWandTaskAgentMode(
  provider: WandTaskAgentProvider,
  mode: unknown,
): WandTaskAgentMode {
  const supported = supportedWandTaskAgentModes(provider);
  if (isWandTaskAgentMode(mode) && supported.includes(mode)) return mode;
  return supported.includes(DEFAULT_WAND_TASK_AGENT_MODE)
    ? DEFAULT_WAND_TASK_AGENT_MODE
    : supported[0]!;
}

/**
 * 派发时创建的会话形态：
 *   - structured：结构化对话，走 provider 的结构化 runner；
 *   - pty：原始 CLI 终端，与「新建工作窗口」里的 PTY 一致。
 */
export type WandTaskAgentKind = "structured" | "pty";

/** 合法会话形态清单；顺序即下拉顺序。 */
export const WAND_TASK_AGENT_KINDS: readonly WandTaskAgentKind[] = ["structured", "pty"];

/** 历史行 / 老客户端没带 kind 时的兜底：结构化对话，与旧派发行为一致。 */
export const DEFAULT_WAND_TASK_AGENT_KIND: WandTaskAgentKind = "structured";

export function isWandTaskAgentKind(value: unknown): value is WandTaskAgentKind {
  return value === "structured" || value === "pty";
}

/** 任务上的默认派发配置：先选工具 / 模型 / 思考深度 / 工作模式 / 会话形态，再一键交给 Agent。 */
export interface WandTaskAgent {
  provider: WandTaskAgentProvider;
  /** 具体模型 ID；"default" 表示跟随服务端为该 provider 选择的默认模型。 */
  model: WandTaskAgentModel;
  thinkingEffort: WandTaskAgentEffort;
  /** 执行模式；缺省时按标准模式处理。 */
  mode: WandTaskAgentMode;
  /** 派发出来的会话是结构化对话还是 PTY 终端；缺省时按结构化处理。 */
  kind: WandTaskAgentKind;
}

/** 任务标题来源；标题是可选字段，留空时由服务端按描述自动生成。 */
export type WandTaskTitleSource = "user" | "auto";

/** 里程碑名上限；所有任务面板的新增入口共用同一约束。 */
export const WAND_MILESTONE_NAME_MAX_LENGTH = 60;

/** 兜底迭代的名字；用户没选迭代时任务/会话都归到它下面。 */
export const DEFAULT_ITERATION_NAME = "默认迭代";

/**
 * 里程碑（迭代）：归属某个工作区，新建任务时按所选工作区过滤展示，也可以不选。
 * workspaceId 为 null 表示全局里程碑（历史数据，或未指定工作区时创建），任何工作区都能选。
 * 任务只保存 milestoneId，删除里程碑时只解绑任务（并改挂默认迭代）、不删除任务。
 */
export interface WandTaskMilestone {
  id: string;
  name: string;
  /** YYYY-MM-DD，可为空。 */
  dueDate: string | null;
  /** 所属工作区；null = 全局里程碑。 */
  workspaceId: string | null;
  /**
   * 是否为兜底「默认迭代」：全局唯一、不可删除，用户没选迭代时一切新建都落到它这里。
   * 同一个工作区可见的迭代里最多只有一个 isDefault，服务端保证惰性创建。
   */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 迭代提示词记录的来源：会话里用户输入的 / 任务派发的。 */
export type WandIterationPromptSource = "session" | "dispatch";

/** 记录标题上限（列表里显示的一行）。 */
export const WAND_ITERATION_PROMPT_TITLE_MAX_LENGTH = 60;

/** 记录详情上限：够模型总结，又不至于把整段提示词全量灌进 commit 生成。 */
export const WAND_ITERATION_PROMPT_DETAIL_MAX_LENGTH = 600;

/**
 * 迭代提示词记录（「两次迭代之间我到底改了什么」的输入源）：
 * 用户每发一条有信息量的提示词就追加一行，commit / 汇报类生成直接读它，
 * 不用每次都让模型去读 diff。
 */
export interface WandIterationPrompt {
  id: string;
  /** 归属迭代；默认迭代也有自己真实的行 id，不会留下 null。 */
  milestoneId: string;
  /** 记录时所属项目；null = 未指定项目的会话 / 任务。 */
  workspaceId: string | null;
  sessionId: string | null;
  /** 关联的看板任务（wand_tasks.id）。 */
  taskId: string | null;
  /**
   * 仓库身份：`git rev-parse --git-common-dir` 的绝对路径，同一仓库的 worktree 共享同一个值。
   * 用来把提示词按仓库隔离，避免把别的项目的历史混进这次 commit message。
   * 拿不到仓库信息时为 null。
   */
  repoKey: string | null;
  /** 记录时的会话工作目录。 */
  cwd: string;
  /** 提示词的本地标题（不调模型，取第一行有效内容）。 */
  title: string;
  /** 提示词摘要，已经过清洗与截断。 */
  detail: string;
  source: WandIterationPromptSource;
  /** 已被某次 commit message 用掉的时间；null = 还没提交。 */
  consumedAt: string | null;
  /** 用掉它的 commit hash；提交失败或只生成不提交时为 null。 */
  consumedCommit: string | null;
  createdAt: string;
}

export interface WandTask {
  id: string;
  workspaceId: string | null;
  /** 关联的侧栏工作任务；归档/新建时用来对账，不随 WorkspaceTask 删除而消失。 */
  workspaceTaskId: string | null;
  identifier: string;
  title: string;
  /** 'user' = 用户自己填的标题；'auto' = 用户留空后按描述/会话内容自动生成。 */
  titleSource: WandTaskTitleSource;
  /**
   * 最近一次自动命名用到的输入指纹（描述 + 所有会话摘要）；内容没变就不再重复总结。
   * 标题来源为 user 或从未自动命名过时为 null。
   */
  autoTitleSignature: string | null;
  description: string;
  status: WandTaskStatus;
  priority: WandTaskPriority;
  labels: string[];
  dueDate: string | null;
  /** 所属里程碑；null 表示未归入任何里程碑。 */
  milestoneId: string | null;
  sortOrder: number;
  /** 该任务绑定的执行 Agent；null 表示还没指定。 */
  agent: WandTaskAgent | null;
  createdAt: string;
  updatedAt: string;
}

export interface WandTaskDetail extends WandTask {
  sessionIds: string[];
}
