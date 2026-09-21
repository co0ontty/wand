import type {
  WandTaskAgent,
  WandTaskAgentEffort,
  WandTaskAgentKind,
  WandTaskAgentMode,
  WandTaskAgentProvider,
  WandTaskPriority,
  WandTaskStatus,
} from "../../../task-types";
import {
  DEFAULT_WAND_TASK_AGENT_KIND,
  DEFAULT_WAND_TASK_AGENT_MODE,
  isClosedWandTaskStatus,
  isWandTaskAgentKind,
  normalizeWandTaskAgentMode,
  supportedWandTaskAgentModes,
} from "../../../task-types";
import type { WandSelectOption } from "../ui";
import {
  MODEL_CATALOG_DEFAULT_VALUE,
  normalizeWandModelCatalog,
  wandModelOptions,
  type WandModelCatalog,
} from "../model-catalog";

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

/**
 * 派发时的执行模式。只开放三种：托管（全自动）/ 全限（自动确认权限）/ 标准（逐步确认）。
 * auto-edit / native 仍属于新建会话的高级选项，不进任务看板。
 */
export const ISSUE_AGENT_MODES: ReadonlyArray<{
  value: WandTaskAgentMode;
  label: string;
  description: string;
}> = [
  { value: "managed", label: "托管", description: "全自动完成任务，不再逐条确认" },
  { value: "full-access", label: "全限", description: "自动确认权限，适合确认环境后的连续修改" },
  { value: "default", label: "标准", description: "逐步确认操作" },
];

export const ISSUE_AGENT_DEFAULT_MODEL = MODEL_CATALOG_DEFAULT_VALUE;

/** 当前 provider 支持的工作模式选项；Codex 只支持全限一种。 */
export function issueAgentModeOptions(provider: IssueAgentProvider): WandSelectOption[] {
  const supported = supportedWandTaskAgentModes(provider);
  return ISSUE_AGENT_MODES
    .filter((entry) => supported.includes(entry.value))
    .map((entry) => ({ value: entry.value, label: entry.label }));
}

export const ISSUE_COLUMNS: ReadonlyArray<{
  status: WandTaskStatus;
  label: string;
  empty: string;
}> = [
  { status: "todo", label: "等待认领", empty: "还没有等待认领的任务" },
  { status: "doing", label: "处理中", empty: "暂无处理中的任务" },
  { status: "done", label: "等你确认", empty: "还没有待确认的任务" },
];

/** 归档不是第四列，而是「等你确认」下面的独立目录。 */
export const ISSUE_ARCHIVE_COLUMN: {
  status: Extract<WandTaskStatus, "archived">;
  label: string;
  empty: string;
} = { status: "archived", label: "归档任务", empty: "还没有归档的任务" };

/**
 * 新建任务是否顺带完成第一次指派。
 * 「等待认领」列只创建任务；「处理中」列代表已经决定要跑，所以创建后立刻派给所选 Agent。
 */
export function issueCreateDispatches(status: WandTaskStatus): boolean {
  return status === "doing";
}

/**
 * 拖进「处理中」是否要顺带派发 Agent。
 * 只有还没派发过（没有绑定会话）的任务才自动派发：已经在跑 / 跑过的卡再拖回来只改状态，
 * 避免拖一次就多开一个 session。
 */
export function issueDropDispatches(status: WandTaskStatus, sessionCount: number): boolean {
  return status === "doing" && sessionCount === 0;
}

/** 拖拽派发用的提示词：优先任务描述，其次标题，最后给一句兜底指令。 */
export function issueDropDispatchPrompt(task: { title: string; description: string }): string {
  return task.description.trim() || task.title.trim() || "执行此任务";
}

export const ISSUE_STATUS_FILTERS: ReadonlyArray<{
  status: WandTaskStatus;
  label: string;
}> = [
  ...ISSUE_COLUMNS.map((column) => ({ status: column.status, label: column.label })),
  { status: ISSUE_ARCHIVE_COLUMN.status, label: ISSUE_ARCHIVE_COLUMN.label },
];

export const ISSUE_PRIORITIES: ReadonlyArray<{ value: WandTaskPriority; label: string }> = [
  { value: "none", label: "无优先级" },
  { value: "urgent", label: "紧急" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

const LABEL_PALETTE = ["#c5653d", "#4f7a58", "#a96a2f", "#4a6fa5", "#b24f45", "#6f6da3", "#8a6b4a"];

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
  if (tone === "bug") return "#b24f45";
  if (tone === "feature") return "#4a6fa5";
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
  if (provider === "session" || provider === "shell") return "终端";
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

/**
 * `/api/models` 的浏览器侧视图；看板与新任务选择器共用同一份归一化实现
 * （见 `../model-catalog`）。未加载 / 拉取失败时给空目录。
 */
export type IssueModelCatalog = WandModelCatalog;

/** 把 `/api/models` 的 payload 归一化成每个 provider 的下拉选项。 */
export const normalizeIssueModelCatalog = normalizeWandModelCatalog;

/** 目录尚未加载时也要能渲染下拉，给出「跟随服务端默认」占位。 */
export const issueAgentModelOptions = wandModelOptions;

/**
 * 切换 CLI 工具时尽量保留已选模型与工作模式；新 provider 不支持时回退到合法值，
 * 避免把上一个 provider 的模型 ID / 执行模式提交给新 provider（如 Codex 只收 full-access）。
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
  return {
    ...agent,
    provider,
    model,
    mode: normalizeWandTaskAgentMode(provider, agent.mode),
  };
}

export function isDispatchableIssueAgent(agent: WandTaskAgent | null | undefined): agent is WandTaskAgent {
  if (!agent) return false;
  if (!ISSUE_AGENT_PROVIDERS.some((entry) => entry.value === agent.provider)) return false;
  if (!agent.model.trim()) return false;
  if (!ISSUE_AGENT_EFFORTS.some((entry) => entry.value === agent.thinkingEffort)) return false;
  return ISSUE_AGENT_MODES.some((entry) => entry.value === agent.mode);
}

/** 执行模式标签；未知值回落到默认模式，避免旧任务显示空标签。 */
export function issueAgentModeLabel(mode: string | null | undefined): string {
  const found = ISSUE_AGENT_MODES.find((entry) => entry.value === mode);
  if (found) return found.label;
  return ISSUE_AGENT_MODES.find((entry) => entry.value === DEFAULT_WAND_TASK_AGENT_MODE)?.label ?? "标准";
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
    mode?: string;
    sessionKind?: string;
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
  const mode = normalizeWandTaskAgentMode(session.provider, session.mode);
  return {
    provider: session.provider,
    model: session.model.trim() || ISSUE_AGENT_DEFAULT_MODEL,
    thinkingEffort,
    mode,
    kind: session.sessionKind === "pty" ? "pty" : DEFAULT_WAND_TASK_AGENT_KIND,
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
  return {
    provider,
    model: ISSUE_AGENT_DEFAULT_MODEL,
    thinkingEffort: "off",
    mode: normalizeWandTaskAgentMode(provider, DEFAULT_WAND_TASK_AGENT_MODE),
    kind: DEFAULT_WAND_TASK_AGENT_KIND,
  };
}

/** 把任意来源的 kind 收敛成合法值；缺省/脏数据按结构化处理。 */
export function normalizeIssueAgentKind(kind: unknown): WandTaskAgentKind {
  return isWandTaskAgentKind(kind) ? kind : DEFAULT_WAND_TASK_AGENT_KIND;
}

/**
 * 任务已指派则用任务上的配置，否则沿用面板上次选择。
 * 两条来源都会把 mode 夹到该 provider 支持的值，避免下拉出现无法选中的值。
 */
export function resolveIssueAgent(
  taskAgent: WandTaskAgent | null | undefined,
  lastAgent?: WandTaskAgent | null,
): WandTaskAgent {
  if (isDispatchableIssueAgent(taskAgent)) {
    return {
      ...taskAgent,
      mode: normalizeWandTaskAgentMode(taskAgent.provider, taskAgent.mode),
      kind: normalizeIssueAgentKind(taskAgent.kind),
    };
  }
  if (isDispatchableIssueAgent(lastAgent)) {
    return {
      provider: lastAgent.provider,
      model: lastAgent.model.trim(),
      thinkingEffort: lastAgent.thinkingEffort,
      mode: normalizeWandTaskAgentMode(lastAgent.provider, lastAgent.mode),
      kind: normalizeIssueAgentKind(lastAgent.kind),
    };
  }
  return createDefaultIssueAgent();
}

/** `/api/wand-task-agent-defaults` 的读侧校验；坏数据回落到 Claude 默认。 */
export function normalizeIssueAgentDefaults(payload: unknown): WandTaskAgent {
  return resolveIssueAgent(null, payload as WandTaskAgent);
}

export function emptyIssueGroups<T>(): Record<WandTaskStatus, T[]> {
  return { todo: [], doing: [], done: [], archived: [] };
}

export function groupIssuesByStatus<T extends { status: WandTaskStatus }>(
  tasks: readonly T[],
): Record<WandTaskStatus, T[]> {
  const grouped = emptyIssueGroups<T>();
  for (const task of tasks) {
    const bucket = grouped[task.status] ?? grouped.todo;
    bucket.push(task);
  }
  return grouped;
}

/** 归档目录默认折叠；搜索或勾选「归档任务」时自动展开，避免匹配结果被藏住。 */
export function issueArchiveFolderOpen(
  collapsed: boolean,
  query: string,
  filters: IssueBoardFilters,
): boolean {
  if (!collapsed) return true;
  if (query.trim()) return true;
  return filters.statuses.includes("archived");
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
  { value: "dashboard", label: "概览" },
  { value: "board", label: "看板" },
  { value: "list", label: "列表" },
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
  return Boolean(dueDate && !isClosedWandTaskStatus(status) && dueDate < today);
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
    else if (task.status === "done") done += 1;
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
      completed: tasks.filter((task) => isClosedWandTaskStatus(task.status) && new Date(task.updatedAt).getTime() <= timestamp).length,
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
  const finish = task.dueDate || (isClosedWandTaskStatus(task.status) ? isoDate(new Date(task.updatedAt)) : addIsoDays(created, 3));
  const startMs = new Date(`${start}T12:00:00`).getTime();
  const createdMs = new Date(`${created}T12:00:00`).getTime();
  const finishMs = new Date(`${finish}T12:00:00`).getTime();
  const offset = Math.max(0, Math.round((createdMs - startMs) / 86_400_000));
  const end = Math.min(days, Math.max(offset + 1, Math.round((finishMs - startMs) / 86_400_000) + 1));
  return { offset: Math.min(offset, days - 1), length: Math.max(1, end - Math.min(offset, days - 1)) };
}

export function formatIssueStamp(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : value;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
