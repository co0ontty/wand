import type { WandTaskAgent, WandTaskAgentEffort, WandTaskAgentProvider, WandTaskStatus } from "../../../task-types";
import type { WandSelectOption } from "../ui";

export type IssueAgentProvider = WandTaskAgentProvider;

/** 可选 CLI 工具清单，顺序即 UI 顺序；与 /api/models 的字段一一对应。 */
export const ISSUE_AGENT_PROVIDERS: ReadonlyArray<{
  value: IssueAgentProvider;
  label: string;
  description: string;
}> = [
  { value: "claude", label: "Claude", description: "Claude Code" },
  { value: "codex", label: "Codex", description: "OpenAI Codex CLI" },
  { value: "opencode", label: "OpenCode", description: "OpenCode CLI" },
  { value: "grok", label: "Grok", description: "Grok Build CLI" },
  { value: "qoder", label: "Qoder", description: "Qoder CLI" },
  { value: "pi", label: "Pi", description: "Pi coding agent" },
];

export const ISSUE_AGENT_EFFORTS: ReadonlyArray<{ value: WandTaskAgentEffort; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "standard", label: "标准" },
  { value: "deep", label: "深入" },
  { value: "max", label: "最大" },
];

export const ISSUE_AGENT_DEFAULT_MODEL = "default";

export const ISSUE_COLUMNS: ReadonlyArray<{
  status: WandTaskStatus;
  label: string;
  empty: string;
}> = [
  { status: "todo", label: "待办", empty: "还没有待办任务" },
  { status: "doing", label: "进行中", empty: "暂无进行中的任务" },
  { status: "done", label: "已完成", empty: "还没有完成的任务" },
];

export function issueAgentProviderLabel(provider: string | null | undefined): string {
  return ISSUE_AGENT_PROVIDERS.find((entry) => entry.value === provider)?.label ?? (provider || "Agent");
}

export function issueAgentEffortLabel(effort: string | null | undefined): string {
  return ISSUE_AGENT_EFFORTS.find((entry) => entry.value === effort)?.label ?? (effort || "关闭");
}

/** 任务可绑定的项目；`cwd` 即派发 Agent 时的运行目录。 */
export interface IssueWorkspace {
  id: string;
  name: string;
  cwd: string;
  kind?: string;
}

/** `/api/models` 的浏览器侧视图；未加载 / 拉取失败时给空目录。 */
export interface IssueModelCatalog {
  byProvider: Record<IssueAgentProvider, WandSelectOption[]>;
  refreshedAt: string;
}

interface ModelEntry {
  id?: unknown;
  label?: unknown;
}

function modelEntryToOption(entry: ModelEntry): WandSelectOption | null {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id;
  return { value: id, label };
}

const MODEL_KEYS: ReadonlyArray<readonly [IssueAgentProvider, string, string]> = [
  ["claude", "models", "defaultModel"],
  ["codex", "codexModels", "defaultCodexModel"],
  ["opencode", "opencodeModels", "defaultOpenCodeModel"],
  ["grok", "grokModels", "defaultGrokModel"],
  ["qoder", "qoderModels", "defaultQoderModel"],
  ["pi", "piModels", "defaultPiModel"],
];

/**
 * 把 `/api/models` 的 payload 归一化成每个 provider 的下拉选项。
 * 模型列表里带 `default` 时直接用；否则补一项「跟随服务端默认」，
 * 这样用户即使只有一个候选模型也能派发，而不会卡在空列表。
 */
export function normalizeIssueModelCatalog(payload: unknown): IssueModelCatalog {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const defaults = root.defaultModels && typeof root.defaultModels === "object"
    ? root.defaultModels as Record<string, unknown>
    : {};
  const byProvider = {} as Record<IssueAgentProvider, WandSelectOption[]>;
  for (const [provider, listKey, defaultKey] of MODEL_KEYS) {
    const raw = Array.isArray(root[listKey]) ? root[listKey] as ModelEntry[] : [];
    const options = raw.map(modelEntryToOption).filter((option): option is WandSelectOption => option !== null);
    const hasDefault = options.some((option) => option.value === ISSUE_AGENT_DEFAULT_MODEL);
    if (!hasDefault) {
      const candidate = typeof defaults[provider] === "string"
        ? defaults[provider] as string
        : typeof root[defaultKey] === "string" ? root[defaultKey] as string : "";
      const fallback = candidate.trim();
      options.unshift({
        value: ISSUE_AGENT_DEFAULT_MODEL,
        label: fallback ? `跟随服务端默认（${fallback}）` : "跟随服务端默认",
      });
    }
    byProvider[provider] = options;
  }
  return {
    byProvider,
    refreshedAt: typeof root.refreshedAt === "string" ? root.refreshedAt : "",
  };
}

/** 目录尚未加载时也要能渲染下拉，给出「跟随服务端默认」占位。 */
export function issueAgentModelOptions(
  catalog: IssueModelCatalog | null,
  provider: IssueAgentProvider,
): WandSelectOption[] {
  const options = catalog?.byProvider[provider];
  return options && options.length > 0 ? options : [{ value: ISSUE_AGENT_DEFAULT_MODEL, label: "跟随服务端默认" }];
}

/**
 * 切换 CLI 工具时尽量保留已选模型；新 provider 的目录里没有该模型时，
 * 回退到目录首项，避免把上一个 provider 的模型 ID 提交给新 provider。
 */
export function withIssueAgentProvider(
  agent: WandTaskAgent,
  provider: IssueAgentProvider,
  catalog: IssueModelCatalog | null,
): WandTaskAgent {
  if (agent.provider === provider) return agent;
  const options = issueAgentModelOptions(catalog, provider);
  const model = options.some((option) => option.value === agent.model)
    ? agent.model
    : options[0]?.value ?? ISSUE_AGENT_DEFAULT_MODEL;
  return { ...agent, provider, model };
}

export function isDispatchableIssueAgent(agent: WandTaskAgent | null | undefined): agent is WandTaskAgent {
  if (!agent) return false;
  if (!ISSUE_AGENT_PROVIDERS.some((entry) => entry.value === agent.provider)) return false;
  if (!agent.model.trim()) return false;
  return ISSUE_AGENT_EFFORTS.some((entry) => entry.value === agent.thinkingEffort);
}

export function createDefaultIssueAgent(provider: IssueAgentProvider = "claude"): WandTaskAgent {
  return { provider, model: ISSUE_AGENT_DEFAULT_MODEL, thinkingEffort: "off" };
}

/** 任务卡片的稳定排序：先人工 sortOrder，再按更新时间倒序。 */
export function sortIssues<T extends { sortOrder: number; updatedAt: string; id: string }>(
  tasks: readonly T[],
): T[] {
  return [...tasks].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.id.localeCompare(right.id);
  });
}

export function groupIssuesByStatus<T extends { status: WandTaskStatus }>(
  tasks: readonly T[],
): Record<WandTaskStatus, T[]> {
  const grouped: Record<WandTaskStatus, T[]> = { todo: [], doing: [], done: [] };
  for (const task of tasks) grouped[task.status].push(task);
  return grouped;
}

/**
 * Radix Select 把空字符串保留为「无选中」，带 `value=""` 的 option 会直接抛错，
 * 因此「不指定项目」用哨兵值表示，读写时经 `issueWorkspaceSelectValue` 转换。
 */
export const ISSUE_NO_WORKSPACE = "__none__";

/** 项目下拉：首项为「不指定项目」，其余按传入顺序。 */
export function issueWorkspaceOptions(workspaces: readonly IssueWorkspace[]): WandSelectOption[] {
  return [
    { value: ISSUE_NO_WORKSPACE, label: "不指定项目（使用全局目录）" },
    ...workspaces.map((workspace) => ({
      value: workspace.id,
      label: `${workspace.name} · ${workspace.cwd}`,
    })),
  ];
}

/** workspaceId → Select value；null / 空串表示不指定项目。 */
export function issueWorkspaceSelectValue(workspaceId: string | null | undefined): string {
  return workspaceId?.trim() ? workspaceId.trim() : ISSUE_NO_WORKSPACE;
}

/** Select value → workspaceId；选到哨兵值时落库为 null。 */
export function issueWorkspaceIdFromSelect(value: string): string | null {
  return value === ISSUE_NO_WORKSPACE ? null : value;
}


export type IssueBoardView = "board" | "list";

export const ISSUE_BOARD_VIEWS: ReadonlyArray<{ value: IssueBoardView; label: string }> = [
  { value: "board", label: "看板" },
  { value: "list", label: "列表" },
];

/** 卡片是否展示正文；主列之外的状态进「其他任务」。 */
export interface IssueBoardDisplay {
  body: boolean;
  mainStatuses: WandTaskStatus[];
}

export const DEFAULT_ISSUE_BOARD_DISPLAY: IssueBoardDisplay = {
  body: false,
  mainStatuses: ["todo", "doing", "done"],
};

export const ISSUE_BOARD_DISPLAY_KEY = "wand.issue-board.display";

export function readIssueBoardDisplay(): IssueBoardDisplay {
  if (typeof window === "undefined") return DEFAULT_ISSUE_BOARD_DISPLAY;
  try {
    const raw = window.localStorage.getItem(ISSUE_BOARD_DISPLAY_KEY);
    if (!raw) return DEFAULT_ISSUE_BOARD_DISPLAY;
    const parsed = JSON.parse(raw) as Partial<IssueBoardDisplay>;
    const allowed = new Set(ISSUE_COLUMNS.map((column) => column.status));
    const mainStatuses = Array.isArray(parsed.mainStatuses)
      ? parsed.mainStatuses.filter((status): status is WandTaskStatus => allowed.has(status as WandTaskStatus))
      : [];
    return {
      body: parsed.body === true,
      mainStatuses: mainStatuses.length > 0 ? mainStatuses : DEFAULT_ISSUE_BOARD_DISPLAY.mainStatuses,
    };
  } catch {
    return DEFAULT_ISSUE_BOARD_DISPLAY;
  }
}

export function writeIssueBoardDisplay(display: IssueBoardDisplay): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ISSUE_BOARD_DISPLAY_KEY, JSON.stringify(display));
  } catch {
    /* ignore quota / private mode */
  }
}

export function issueStatusTone(status: WandTaskStatus): "todo" | "progress" | "done" {
  if (status === "doing") return "progress";
  if (status === "done") return "done";
  return "todo";
}

export function filterIssues<T extends {
  title: string;
  identifier: string;
  description: string;
  labels: string[];
  workspaceId: string | null;
}>(
  tasks: readonly T[],
  query: string,
  workspaceId: string,
): T[] {
  const needle = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (workspaceId && (task.workspaceId ?? "") !== workspaceId) return false;
    if (!needle) return true;
    const haystack = [
      task.title,
      task.identifier,
      task.description,
      ...task.labels,
    ].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * 把被拖动的任务插入目标列 `beforeIndex`，并同时压紧源列 / 目标列的 sortOrder。
 * 返回需要 PATCH 的字段，调用方按 id 合并回列表。
 */
export function reorderIssues<T extends { id: string; status: WandTaskStatus; sortOrder: number }>(
  tasks: readonly T[],
  taskId: string,
  status: WandTaskStatus,
  beforeIndex: number,
): Array<{ id: string; status: WandTaskStatus; sortOrder: number }> {
  const moving = tasks.find((task) => task.id === taskId);
  if (!moving) return [];
  const sourceStatus = moving.status;
  const destination = tasks.filter((task) => task.status === status && task.id !== taskId);
  const index = Math.max(0, Math.min(beforeIndex, destination.length));
  destination.splice(index, 0, { ...moving, status });
  const patches = destination.map((task, sortOrder) => ({ id: task.id, status, sortOrder }));
  if (sourceStatus === status) return patches;
  const source = tasks.filter((task) => task.status === sourceStatus && task.id !== taskId);
  patches.push(...source.map((task, sortOrder) => ({ id: task.id, status: sourceStatus, sortOrder })));
  return patches;
}

/** 用卡片中线判断应插在哪条前面；正在拖的那张不参与计算。 */
export function dropIndexFromPoint(list: HTMLElement, clientY: number, draggedId: string): number {
  const cards = [...list.querySelectorAll<HTMLElement>("[data-task-id]")]
    .filter((node) => node.dataset.taskId !== draggedId);
  for (let index = 0; index < cards.length; index += 1) {
    const rect = cards[index]!.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return cards.length;
}

export function formatIssueStamp(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : value;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
