/** Shared employee IM configuration contract. Credentials are write-only. */
export const EMPLOYEE_IM_EVENTS = [
  { value: "task_started", label: "开始处理任务" },
  { value: "task_completed", label: "任务完成" },
  { value: "task_failed", label: "任务失败" },
  { value: "task_stopped", label: "任务停止" },
  { value: "waiting_permission", label: "等待权限或计划审批" },
  { value: "waiting_input", label: "等待用户输入" },
  { value: "message_queued", label: "消息进入队列" },
  { value: "step_completed", label: "步骤完成" },
  { value: "candidate_switched", label: "执行候选切换" },
  { value: "team_started", label: "团队开始任务" },
  { value: "team_completed", label: "团队任务完成" },
  { value: "team_failed", label: "团队任务失败" },
  { value: "team_stopped", label: "团队任务停止" },
] as const;
export type EmployeeImEvent = typeof EMPLOYEE_IM_EVENTS[number]["value"];
export type EmployeeImProvider = "telegram" | "dingtalk";
/** Shared notification choices; selected events go to every enabled channel for this employee. */
export const EMPLOYEE_IM_EVENT_GROUPS: ReadonlyArray<{ label: string; events: readonly EmployeeImEvent[] }> = [
  { label: "处理进度", events: ["task_started", "message_queued", "step_completed", "candidate_switched"] },
  { label: "需要你介入", events: ["waiting_permission", "waiting_input"] },
  { label: "执行结果", events: ["task_completed", "task_failed", "task_stopped"] },
  { label: "团队任务", events: ["team_started", "team_completed", "team_failed", "team_stopped"] },
];
export const EMPLOYEE_IM_PRIMARY_EVENTS: readonly EmployeeImEvent[] = [
  "task_started", "task_completed", "task_failed", "task_stopped", "waiting_permission", "waiting_input",
];
export const EMPLOYEE_IM_MORE_EVENT_GROUPS = EMPLOYEE_IM_EVENT_GROUPS
  .map(group => ({ ...group, events: group.events.filter(event => !EMPLOYEE_IM_PRIMARY_EVENTS.includes(event)) }))
  .filter(group => group.events.length > 0);

export interface EmployeeImChannel {
  enabled: boolean;
  /** Telegram destination; not a credential. */
  chatId?: string;
  botTokenConfigured?: boolean;
  webhookConfigured?: boolean;
  secretConfigured?: boolean;
}
export interface EmployeeImConfig {
  events: EmployeeImEvent[];
  telegram: EmployeeImChannel;
  dingtalk: EmployeeImChannel;
}
export interface EmployeeImChannelInput {
  enabled: boolean;
  chatId?: string;
  /** undefined/empty preserves an existing credential; null explicitly clears it. */
  botToken?: string | null;
  webhook?: string | null;
  secret?: string | null;
}
export interface EmployeeImConfigInput {
  events: EmployeeImEvent[];
  telegram: EmployeeImChannelInput;
  dingtalk: EmployeeImChannelInput;
}
export function emptyEmployeeImConfig(): EmployeeImConfig {
  return { events: [], telegram: { enabled: false, chatId: "" }, dingtalk: { enabled: false } };
}
