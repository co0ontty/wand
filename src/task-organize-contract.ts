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
  { value: "auto" as const, label: "自动任务归类", hint: "仅系统自动标题，跳过用户自定标题" },
  { value: "all" as const, label: "所有任务归类", hint: "包含用户自定标题的任务" },
];
