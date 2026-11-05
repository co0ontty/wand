import { sessionRuntimeLabel, type SessionRuntimeFilter } from "./runtime-filter";
import { isWandTaskStatus, taskWorkflowStage } from "../../../task-types.js";
import type { ConversationSummary } from "../../../conversation-types.js";
import type { TaskDirectoryGroup } from "../workspaces/types";
import type { PersonSessionEntry } from "./sidebar-sessions";
import type { ConversationListFilter } from "./state";

export const CONVERSATION_TASK_STAGES = [
  { value: "all", label: "全部状态" },
  { value: "backlog", label: "待立项" },
  { value: "todo", label: "待派遣" },
  { value: "doing", label: "执行中" },
  { value: "review", label: "待验收" },
  { value: "ready", label: "待归档" },
  { value: "archived", label: "已归档" },
  { value: "none", label: "未关联任务" },
] as const;
export type ConversationTaskStage = typeof CONVERSATION_TASK_STAGES[number]["value"];
export interface ConversationListFacets {
  taskStage: ConversationTaskStage;
  /** all / none are reserved; real workspace values use the id: prefix. */
  workspace: string;
  /** all / none are reserved; real employee values are server IDs. */
  employee: string;
}
export interface ConversationListFilters extends ConversationListFacets {
  runtime?: SessionRuntimeFilter;
  archive: ConversationListFilter;
  activityOnly: boolean;
}
export const DEFAULT_CONVERSATION_FILTERS: ConversationListFilters = {
  taskStage: "all", workspace: "all", employee: "all", archive: "all", activityOnly: false, runtime: "all",
};
/** Empty selection means all; JSON encoding keeps arbitrary workspace IDs unambiguous. */
export function workspaceSelections(value: string): string[] {
  try {
    const values: unknown = value.startsWith("[") ? JSON.parse(value) : value === "all" ? [] : [value];
    return Array.isArray(values) ? [...new Set(values.filter((item): item is string => typeof item === "string" && (item === "none" || item.startsWith("id:"))))] : [];
  } catch { return []; }
}
export function normalizeWorkspaceSelection(value: string): string {
  const selected = workspaceSelections(value);
  return selected.length > 1 ? JSON.stringify(selected) : selected[0] ?? "all";
}
export function toggleWorkspaceSelection(value: string, option: string): string {
  if (option === "all") return "all";
  const selected = workspaceSelections(value);
  return normalizeWorkspaceSelection(JSON.stringify(selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option]));
}
export function matchesWorkspaceSelection(value: string, workspace: string | undefined): boolean {
  const selected = workspaceSelections(value);
  return !selected.length || workspace !== undefined && selected.includes(workspace);
}
/** Employee IDs are opaque, so unlike workspaces only non-empty strings are filtered out. */
export function employeeSelections(value: string): string[] {
  try {
    const values: unknown = value.startsWith("[") ? JSON.parse(value) : value === "all" ? [] : [value];
    return Array.isArray(values) ? [...new Set(values.filter((item): item is string => typeof item === "string" && item.length > 0))] : [];
  } catch { return []; }
}
export function normalizeEmployeeSelection(value: string): string {
  const selected = employeeSelections(value);
  return selected.length > 1 ? JSON.stringify(selected) : selected[0] ?? "all";
}
export function toggleEmployeeSelection(value: string, option: string): string {
  if (option === "all") return "all";
  const selected = employeeSelections(value);
  return normalizeEmployeeSelection(JSON.stringify(selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option]));
}
export function matchesEmployeeSelection(value: string, employee: string | undefined): boolean {
  const selected = employeeSelections(value);
  return !selected.length || employee !== undefined && selected.includes(employee);
}
export function normalizeConversationTaskStage(value: unknown): ConversationTaskStage {
  return CONVERSATION_TASK_STAGES.some(option => option.value === value) ? value as ConversationTaskStage : "all";
}
export function hasConversationFacets(filters: ConversationListFacets): boolean {
  return filters.taskStage !== "all" || filters.workspace !== "all" || filters.employee !== "all";
}
export function conversationFilterCount(filters: ConversationListFilters): number {
  return Number(filters.taskStage !== "all") + Number(filters.workspace !== "all") + Number(filters.employee !== "all")
    + Number(filters.archive !== "all") + Number(filters.runtime !== undefined && filters.runtime !== "all" || filters.activityOnly);
}
export function conversationTaskStageLabel(stage: string | null | undefined): string {
  if (stage === undefined || stage === null) return "任务状态未知";
  const normalized = isWandTaskStatus(stage) ? taskWorkflowStage(stage) : stage;
  return CONVERSATION_TASK_STAGES.find(option => option.value === normalized)?.label ?? "任务状态未知";
}
export function personSessionTaskStage(entry: PersonSessionEntry): string | undefined {
  if (entry.task) return isWandTaskStatus(entry.task.boardTaskStatus) ? taskWorkflowStage(entry.task.boardTaskStatus) : undefined;
  // Missing joins/old server fields are not proof of no task.
  return entry.session.workspaceTaskId ? undefined : "none";
}
export function personSessionWorkspace(entry: PersonSessionEntry): string | undefined {
  if (entry.group.workspaceId.startsWith("system-calls:")) return undefined;
  if (!entry.group.userAdded) return "none";
  if (entry.group.worktree?.parentWorkspaceId) return `id:${entry.group.worktree.parentWorkspaceId}`;
  return entry.group.synthetic || entry.group.global || entry.group.workspaceId === "wand-global"
    ? "none" : `id:${entry.group.workspaceId}`;
}
/** Unassigned sessions use the reserved "none" value so the capsule option can match them. */
export function personSessionEmployee(entry: PersonSessionEntry): string {
  return entry.session.employeeId || "none";
}
export function matchesConversationFacets(entry: PersonSessionEntry, filters: ConversationListFacets): boolean {
  return (filters.taskStage === "all" || personSessionTaskStage(entry) === filters.taskStage)
    && matchesWorkspaceSelection(filters.workspace, personSessionWorkspace(entry))
    && matchesEmployeeSelection(filters.employee, personSessionEmployee(entry));
}
export function conversationWorkspaceOptions(groups: readonly TaskDirectoryGroup[]): { value: string; label: string }[] {
  const options = new Map<string, string>();
  for (const group of groups) {
    if (group.userAdded && !group.synthetic && !group.global && group.workspaceId !== "wand-global") options.set(`id:${group.workspaceId}`, group.workspaceName);
  }
  return [{ value: "all", label: "全部工作区" }, { value: "none", label: "未分配工作区" },
    ...Array.from(options, ([value, label]) => ({ value, label }))];
}
export interface ConversationEmployeeOption {
  value: string;
  label: string;
  avatar?: string;
}

export function conversationEmployeeOptions(entries: readonly (PersonSessionEntry & { conversation?: { title?: string } })[]): ConversationEmployeeOption[] {
  const options = new Map<string, { label: string; avatar?: string }>();
  for (const entry of entries) {
    const id = entry.session.employeeId;
    if (!id) continue;
    const existing = options.get(id);
    const label = existing?.label || entry.session.employeeName || entry.conversation?.title || "员工";
    const avatar = existing?.avatar || entry.session.employeeAvatar;
    options.set(id, { label, avatar });
  }
  return [{ value: "all", label: "全部员工" }, { value: "none", label: "未分配员工" },
    ...Array.from(options, ([value, item]) => ({ value, label: item.label, avatar: item.avatar })).sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"))];
}
export function conversationFilterSummary(filters: ConversationListFilters, options: readonly { value: string; label: string }[], employees: readonly { value: string; label: string }[] = []): string {
  const selectedEmployees = employeeSelections(filters.employee);
  return [sessionRuntimeLabel(filters.runtime ?? (filters.activityOnly ? "active" : "all")), filters.taskStage === "all" ? "" : `任务阶段：${conversationTaskStageLabel(filters.taskStage)}`, (workspaceSelections(filters.workspace).length ? workspaceSelections(filters.workspace).map(value => options.find(option => option.value === value)?.label ?? "工作区不可用").join("、") : "全部工作区"),
    selectedEmployees.length ? `员工：${selectedEmployees.map(value => employees.find(option => option.value === value)?.label ?? "员工不可用").join("、")}` : "",
    filters.archive === "all" ? "" : filters.archive === "archived" ? "会话已归档" : "会话未归档",
    filters.activityOnly && filters.runtime !== "active" ? "仅活动" : ""].filter(Boolean).join(" · ");
}
/** Group task facets must be satisfied by the same linked task, never by two siblings. */
export function matchingConversationTasks(item: ConversationSummary, filters: ConversationListFacets, query = ""): ConversationSummary["tasks"] {
  const needle = query.trim().toLowerCase();
  const parentMatches = [item.title, item.name, item.preview].some(value => value.toLowerCase().includes(needle));
  return item.tasks.filter(({ task }) => (filters.taskStage === "all" || taskWorkflowStage(task.status) === filters.taskStage)
    && matchesWorkspaceSelection(filters.workspace, task.workspaceId && task.workspaceId !== "wand-global" ? `id:${task.workspaceId}` : "none")
    && (!needle || parentMatches || task.title.toLowerCase().includes(needle)));
}
