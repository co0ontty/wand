export type WandTaskStatus = "todo" | "doing" | "done";
export type WandTaskPriority = "none" | "low" | "medium" | "high" | "urgent";

export interface WandTask {
  id: string;
  workspaceId: string | null;
  identifier: string;
  title: string;
  description: string;
  status: WandTaskStatus;
  priority: WandTaskPriority;
  labels: string[];
  dueDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface WandTaskDetail extends WandTask {
  sessionIds: string[];
}
