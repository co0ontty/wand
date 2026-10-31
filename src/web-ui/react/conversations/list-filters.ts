import { sessionRuntimeLabel, type SessionRuntimeFilter } from "./runtime-filter";
import { isWandTaskStatus, taskWorkflowStage } from "../../../task-types.js";
import type { ConversationSummary } from "../../../conversation-types.js";
import type { TaskDirectoryGroup } from "../workspaces/types";
import type { PersonSessionEntry } from "./sidebar-sessions";
import type { ConversationListFilter } from "./state";

export const CONVERSATION_TASK_STAGES = [
  { value: "all", label: "全部状态" },
  { value: "backlog", label: "待立项" },
  { value: "todo", label: "等待认领" },
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
}
export interface ConversationListFilters extends ConversationListFacets {
  runtime?: SessionRuntimeFilter;
  archive: ConversationListFilter;
  activityOnly: boolean;
}
export const DEFAULT_CONVERSATION_FILTERS: ConversationListFilters = {
  taskStage: "all", workspace: "all", archive: "all", activityOnly: false, runtime: "all",
};
export function normalizeConversationTaskStage(value: unknown): ConversationTaskStage {
  return CONVERSATION_TASK_STAGES.some(option => option.value === value) ? value as ConversationTaskStage : "all";
}
export function hasConversationFacets(filters: ConversationListFacets): boolean {
  return filters.taskStage !== "all" || filters.workspace !== "all";
}
export function conversationFilterCount(filters: ConversationListFilters): number {
  return Number(filters.taskStage !== "all") + Number(filters.workspace !== "all")
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
  return entry.group.synthetic || entry.group.global || entry.group.workspaceId === "wand-global"
    ? "none" : `id:${entry.group.workspaceId}`;
}
export function matchesConversationFacets(entry: PersonSessionEntry, filters: ConversationListFacets): boolean {
  return (filters.taskStage === "all" || personSessionTaskStage(entry) === filters.taskStage)
    && (filters.workspace === "all" || personSessionWorkspace(entry) === filters.workspace);
}
export function conversationWorkspaceOptions(groups: readonly TaskDirectoryGroup[]): { value: string; label: string }[] {
  const options = new Map<string, string>();
  for (const group of groups) {
    if (!group.synthetic && !group.global && group.workspaceId !== "wand-global") options.set(`id:${group.workspaceId}`, group.workspaceName);
  }
  return [{ value: "all", label: "全部工作区" }, { value: "none", label: "未分配工作区" },
    ...Array.from(options, ([value, label]) => ({ value, label }))];
}
export function conversationFilterSummary(filters: ConversationListFilters, options: readonly { value: string; label: string }[]): string {
  return [sessionRuntimeLabel(filters.runtime ?? (filters.activityOnly ? "active" : "all")), filters.taskStage === "all" ? "" : `任务阶段：${conversationTaskStageLabel(filters.taskStage)}`, options.find(option => option.value === filters.workspace)?.label ?? "工作区不可用",
    filters.archive === "all" ? "" : filters.archive === "archived" ? "会话已归档" : "会话未归档",
    filters.activityOnly && filters.runtime !== "active" ? "仅活动" : ""].filter(Boolean).join(" · ");
}
/** Group task facets must be satisfied by the same linked task, never by two siblings. */
export function matchingConversationTasks(item: ConversationSummary, filters: ConversationListFacets, query = ""): ConversationSummary["tasks"] {
  const needle = query.trim().toLowerCase();
  const parentMatches = [item.title, item.name, item.preview].some(value => value.toLowerCase().includes(needle));
  return item.tasks.filter(({ task }) => (filters.taskStage === "all" || taskWorkflowStage(task.status) === filters.taskStage)
    && (filters.workspace === "all" || (task.workspaceId && task.workspaceId !== "wand-global" ? `id:${task.workspaceId}` : "none") === filters.workspace)
    && (!needle || parentMatches || task.title.toLowerCase().includes(needle)));
}
