import type {
  WandTaskAgent,
  WandTaskAgentEffort,
  WandTaskAgentProvider,
  WandTaskPriority,
  WandTaskStatus,
} from "../../../task-types";
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
  { status: "todo", label: "等待认领", empty: "还没有等待认领的任务" },
  { status: "doing", label: "处理中", empty: "暂无处理中的任务" },
  { status: "done", label: "等你确认", empty: "还没有待确认的任务" },
];

export const ISSUE_PRIORITIES: ReadonlyArray<{ value: WandTaskPriority; label: string }> = [
  { value: "none", label: "无优先级" },
  { value: "urgent", label: "紧急" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

const LABEL_PALETTE = ["#5e6ad2", "#d25e5e", "#5eccd2", "#f9ac28", "#85d254", "#5482d2", "#bf49d7"];

export function issuePriorityLabel(priority: WandTaskPriority): string {
  return ISSUE_PRIORITIES.find((entry) => entry.value === priority)?.label ?? priority;
}

export function issueLabelTone(name: string): "bug" | "feature" | null {
  const upper = name.trim().toUpperCase();
  if (name === "缺陷" || upper === "BUG") return "bug";
  if (name === "特性" || name === "新功能") return "feature";
  return null;
}

export function issueLabelColor(name: string): string {
  const tone = issueLabelTone(name);
  if (tone === "bug") return "#eb5757";
  if (tone === "feature") return "#bb87fc";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return LABEL_PALETTE[hash % LABEL_PALETTE.length]!;
}

export function issueLabelName(name: string): string {
  if (name === "缺陷" || name.trim().toUpperCase() === "BUG") return "BUG";
  if (name === "特性") return "新功能";
  return name;
}

export function issueSessionRunning(status: string | null | undefined): boolean {
  return status === "running";
}

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

export function isIssueAgentProvider(value: string | null | undefined): value is IssueAgentProvider {
  return ISSUE_AGENT_PROVIDERS.some((entry) => entry.value === value);
}

/** 看板会话按 CLI 工具分组；同一任务可以派给多个 Agent。 */
export interface IssueAgentGroup {
  provider: string;
  agent: WandTaskAgent | null;
  sessions: Array<{
    id: string;
    provider: string;
    title: string;
    status: string;
    model: string;
    thinkingEffort: string;
  }>;
}

function assignedAgents(
  assigned: WandTaskAgent | null | readonly WandTaskAgent[] | undefined,
): WandTaskAgent[] {
  if (!assigned) return [];
  return (Array.isArray(assigned) ? assigned : [assigned]).filter(isDispatchableIssueAgent);
}

function agentFromSession(session: IssueAgentGroup["sessions"][number]): WandTaskAgent | null {
  if (!isIssueAgentProvider(session.provider)) return null;
  const thinkingEffort = ISSUE_AGENT_EFFORTS.some((entry) => entry.value === session.thinkingEffort)
    ? session.thinkingEffort as WandTaskAgent["thinkingEffort"]
    : "off";
  return {
    provider: session.provider,
    model: session.model.trim() || ISSUE_AGENT_DEFAULT_MODEL,
    thinkingEffort,
  };
}

/**
 * 打开任务时按 CLI 工具列出已执行 / 已指派的 Agent。
 * 先保留任务上的指派，再把绑定会话归进对应组；未识别的会话单独成组。
 */
export function groupIssueSessionsByAgent(
  sessions: readonly IssueAgentGroup["sessions"][number][],
  assigned?: WandTaskAgent | null | readonly WandTaskAgent[],
): IssueAgentGroup[] {
  const groups: IssueAgentGroup[] = [];
  const index = new Map<string, IssueAgentGroup>();
  const ensure = (provider: string, agent: WandTaskAgent | null): IssueAgentGroup => {
    const key = provider || "session";
    const existing = index.get(key);
    if (existing) {
      if (!existing.agent && agent) existing.agent = agent;
      return existing;
    }
    const group: IssueAgentGroup = { provider: key, agent, sessions: [] };
    index.set(key, group);
    groups.push(group);
    return group;
  };
  for (const agent of assignedAgents(assigned)) ensure(agent.provider, agent);
  for (const session of sessions) {
    const agent = agentFromSession(session);
    ensure(agent?.provider ?? session.provider, agent).sessions.push(session);
  }
  return groups;
}

export function listIssueAgents(
  sessions: readonly IssueAgentGroup["sessions"][number][],
  assigned?: WandTaskAgent | null | readonly WandTaskAgent[],
): WandTaskAgent[] {
  return groupIssueSessionsByAgent(sessions, assigned)
    .map((group) => group.agent)
    .filter(isDispatchableIssueAgent);
}

export function createDefaultIssueAgent(provider: IssueAgentProvider = "claude"): WandTaskAgent {
  return { provider, model: ISSUE_AGENT_DEFAULT_MODEL, thinkingEffort: "off" };
}

/** 任务已指派则用任务上的配置，否则沿用面板上次选择。 */
export function resolveIssueAgent(
  taskAgent: WandTaskAgent | null | undefined,
  lastAgent?: WandTaskAgent | null,
): WandTaskAgent {
  if (isDispatchableIssueAgent(taskAgent)) return taskAgent;
  if (isDispatchableIssueAgent(lastAgent)) {
    return {
      provider: lastAgent.provider,
      model: lastAgent.model.trim(),
      thinkingEffort: lastAgent.thinkingEffort,
    };
  }
  return createDefaultIssueAgent();
}

/** `/api/wand-task-agent-defaults` 的读侧校验；坏数据回落到 Claude 默认。 */
export function normalizeIssueAgentDefaults(payload: unknown): WandTaskAgent {
  return resolveIssueAgent(null, payload as WandTaskAgent);
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


export type IssueBoardView = "dashboard" | "board" | "list" | "gantt";

export const ISSUE_BOARD_VIEWS: ReadonlyArray<{ value: IssueBoardView; label: string }> = [
  { value: "dashboard", label: "仪表盘" },
  { value: "board", label: "议题看板" },
  { value: "list", label: "列表视图" },
  { value: "gantt", label: "甘特图" },
];

export type IssueGanttZoom = "day" | "week" | "month";

export const ISSUE_GANTT_ZOOMS: ReadonlyArray<{ value: IssueGanttZoom; label: string }> = [
  { value: "day", label: "日视图" },
  { value: "week", label: "周视图" },
  { value: "month", label: "月视图" },
];

export interface IssueBoardFilters {
  statuses: WandTaskStatus[];
  priorities: WandTaskPriority[];
  labels: string[];
}

export const EMPTY_ISSUE_FILTERS: IssueBoardFilters = {
  statuses: [],
  priorities: [],
  labels: [],
};

export function issueFilterCount(filters: IssueBoardFilters): number {
  return Number(filters.statuses.length > 0)
    + Number(filters.priorities.length > 0)
    + Number(filters.labels.length > 0);
}

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
  status: WandTaskStatus;
  priority?: WandTaskPriority;
}>(
  tasks: readonly T[],
  query: string,
  workspaceId: string,
  filters: IssueBoardFilters = EMPTY_ISSUE_FILTERS,
): T[] {
  const needle = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (workspaceId && (task.workspaceId ?? "") !== workspaceId) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(task.status)) return false;
    if (filters.priorities.length > 0 && (task.priority == null || !filters.priorities.includes(task.priority))) return false;
    if (filters.labels.length > 0 && !filters.labels.some((label) => task.labels.includes(label))) return false;
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

export function collectIssueLabels<T extends { labels: string[] }>(tasks: readonly T[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const task of tasks) {
    for (const label of task.labels) {
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.sort((left, right) => left.localeCompare(right, "zh"));
}

export function isoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addIsoDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

export function issueDueStamp(value: string | null | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
  }
  return formatIssueStamp(value);
}

export function issueIsOverdue(dueDate: string | null | undefined, status: WandTaskStatus, today = isoDate(new Date())): boolean {
  return Boolean(dueDate && status !== "done" && dueDate < today);
}

export interface IssueBoardStats {
  total: number;
  todo: number;
  doing: number;
  done: number;
  overdue: number;
  high: number;
  remaining: number;
}

export function issueBoardStats<T extends {
  status: WandTaskStatus;
  priority: WandTaskPriority;
  dueDate: string | null;
}>(tasks: readonly T[]): IssueBoardStats {
  const today = isoDate(new Date());
  let todo = 0;
  let doing = 0;
  let done = 0;
  let overdue = 0;
  let high = 0;
  for (const task of tasks) {
    if (task.status === "todo") todo += 1;
    else if (task.status === "doing") doing += 1;
    else done += 1;
    if (issueIsOverdue(task.dueDate, task.status, today)) overdue += 1;
    if (task.priority === "high" || task.priority === "urgent") high += 1;
  }
  return { total: tasks.length, todo, doing, done, overdue, high, remaining: todo + doing };
}

export interface IssueProgressPoint {
  timestamp: number;
  scope: number;
  started: number;
  completed: number;
}

export function issueProgressSeries<T extends { status: WandTaskStatus; createdAt: string; updatedAt: string }>(
  tasks: readonly T[],
): IssueProgressPoint[] {
  const now = Date.now();
  const created = tasks.map((task) => new Date(task.createdAt).getTime()).filter((value) => !Number.isNaN(value));
  const start = created.length > 0 ? Math.min(...created) : now - 12 * 86_400_000;
  const interval = Math.max(1, (now - start) / 12);
  return Array.from({ length: 13 }, (_, index) => {
    const timestamp = index === 12 ? now : start + interval * index;
    return {
      timestamp,
      scope: tasks.filter((task) => new Date(task.createdAt).getTime() <= timestamp).length,
      started: tasks.filter((task) => {
        const createdAt = new Date(task.createdAt).getTime();
        const updatedAt = new Date(task.updatedAt).getTime();
        if (Number.isNaN(createdAt)) return false;
        if (task.status === "todo") return false;
        return (Number.isNaN(updatedAt) ? createdAt : Math.max(createdAt, updatedAt)) <= timestamp;
      }).length,
      completed: tasks.filter((task) => task.status === "done" && new Date(task.updatedAt).getTime() <= timestamp).length,
    };
  });
}

export function issueGanttRange<T extends { createdAt: string; dueDate: string | null; updatedAt: string }>(
  tasks: readonly T[],
  zoom: IssueGanttZoom,
): { start: string; days: number; columns: string[] } {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const span = zoom === "day" ? 14 : zoom === "week" ? 42 : 90;
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - Math.floor(span / 4));
  const start = isoDate(startDate);
  const columns = Array.from({ length: span }, (_, index) => addIsoDays(start, index));
  return { start, days: span, columns };
}

export function issueGanttSpan<T extends { createdAt: string; dueDate: string | null; updatedAt: string; status: WandTaskStatus }>(
  task: T,
  start: string,
  days: number,
): { offset: number; length: number } {
  const created = isoDate(new Date(task.createdAt));
  const finish = task.dueDate || (task.status === "done" ? isoDate(new Date(task.updatedAt)) : addIsoDays(created, 3));
  const startMs = new Date(`${start}T12:00:00`).getTime();
  const createdMs = new Date(`${created}T12:00:00`).getTime();
  const finishMs = new Date(`${finish}T12:00:00`).getTime();
  const offset = Math.max(0, Math.round((createdMs - startMs) / 86_400_000));
  const end = Math.min(days, Math.max(offset + 1, Math.round((finishMs - startMs) / 86_400_000) + 1));
  return { offset: Math.min(offset, days - 1), length: Math.max(1, end - Math.min(offset, days - 1)) };
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
