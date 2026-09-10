import type { WandTask, WandTaskDetail, WandTaskPriority, WandTaskStatus } from "../../../task-types";
async function request<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init); const value = await response.json().catch(() => ({})) as { error?: string }; if (!response.ok || value.error) throw new Error(value.error || `请求失败（${response.status}）`); return value as T; }
const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const taskBoardRepository = {
  list(workspaceId?: string): Promise<WandTaskDetail[]> { return request(`/api/wand-tasks${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`); },
  create(input: { workspaceId: string | null; title: string; description: string; status: WandTaskStatus; priority: WandTaskPriority; labels: string[]; dueDate?: string | null }): Promise<WandTaskDetail> { return request("/api/wand-tasks", json(input)); },
  update(id: string, patch: Partial<Pick<WandTask, "title" | "description" | "status" | "priority" | "labels" | "dueDate" | "workspaceId" | "sortOrder">>): Promise<WandTaskDetail> { return request(`/api/wand-tasks/${encodeURIComponent(id)}`, json(patch, "PATCH")); },
  remove(id: string): Promise<void> { return request(`/api/wand-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined); },
  bind(id: string, sessionId: string): Promise<WandTaskDetail> { return request(`/api/wand-tasks/${encodeURIComponent(id)}/sessions`, json({ sessionId })); },
};
