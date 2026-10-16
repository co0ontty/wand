export type TaskOrganizeMode = "auto" | "all";

export interface OrganizeByTitleResult {
  ok: true;
  foundTasks: number;
  eligibleTasks: number;
  skippedTasks: number;
  movedSessions: Array<{ sessionId: string; taskId: string; taskName: string }>;
  categorizedTasks: Array<{ taskId: string; parentTaskId: string; parentTitle: string }>;
  refused: Array<{ id: string; kind: "session" | "task"; reason: string }>;
}

/** Server resolves full membership, independent of sidebar pagination or search. */
export type TaskOrganizeTarget =
  | { kind: "all" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "directory"; cwd: string };

export const TASK_ORGANIZE_OPTIONS = [
  { value: "auto" as const, label: "默认范围会话", hint: "未分组及系统自动任务中的工作会话；不挪动人工命名任务中的会话" },
  { value: "all" as const, label: "所有工作会话", hint: "包含人工任务中的会话；仍跳过归档、私聊、自动化执行和系统日志" },
];
