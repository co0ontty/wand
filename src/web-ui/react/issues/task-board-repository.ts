import type {
  WandTask,
  WandTaskAgent,
  WandTaskDetail,
  WandTaskPriority,
  WandTaskStatus,
} from "../../../task-types";
import { normalizeIssueAgentDefaults, type IssueWorkspace } from "./task-board-agent";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok || value.error) throw new Error(value.error || `请求失败（${response.status}）`);
  return value as T;
}

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

let agentDefaultsWrite = Promise.resolve();


/** GET /api/wand-tasks 返回的任务：附带头部所需的工作空间与已绑定会话。 */
export interface WandTaskListed extends WandTaskDetail {
  workspace: { id: string; name: string; cwd: string } | null;
  sessions: IssueSessionSummary[];
}

export interface IssueSessionSummary {
  id: string;
  provider: string;
  sessionKind: string;
  title: string;
  status: string;
  cwd: string;
  model: string;
  thinkingEffort: string;
}

export interface IssueDispatchResult {
  ok: boolean;
  taskId: string;
  session: {
    id: string;
    provider: string;
    model: string | null;
    thinkingEffort: string;
    cwd: string;
  };
}

export const taskBoardRepository = {
  list(workspaceId?: string): Promise<WandTaskListed[]> {
    return request(`/api/wand-tasks${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`);
  },
  workspaces(): Promise<IssueWorkspace[]> {
    return request("/api/workspaces");
  },
  /** 服务端模型目录；派发下拉需要按 provider 过滤可选模型。 */
  models(): Promise<unknown> {
    return request("/api/models");
  },
  create(input: {
    workspaceId: string | null;
    /** 可选：留空时由服务端按描述自动生成标题。 */
    title: string;
    description: string;
    status: WandTaskStatus;
    priority: WandTaskPriority;
    labels: string[];
    dueDate?: string | null;
    agent?: WandTaskAgent | null;
  }): Promise<WandTaskListed> {
    return request("/api/wand-tasks", json(input));
  },
  /** 单条任务：新建后用来确认后台自动标题是否已经生成。 */
  get(id: string): Promise<WandTaskListed> {
    return request(`/api/wand-tasks/${encodeURIComponent(id)}`);
  },
  update(
    id: string,
    patch: Partial<Pick<WandTask, "title" | "titleSource" | "description" | "status" | "priority" | "labels" | "dueDate" | "workspaceId" | "sortOrder" | "agent">>,
  ): Promise<WandTaskListed> {
    return request(`/api/wand-tasks/${encodeURIComponent(id)}`, json(patch, "PATCH"));
  },
  remove(id: string): Promise<void> {
    return request(`/api/wand-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined);
  },
  /** 用任务上选定的 CLI 工具开一个结构化会话并绑定回该任务。 */
  dispatch(id: string, agent: WandTaskAgent): Promise<IssueDispatchResult> {
    return request(`/api/wand-tasks/${encodeURIComponent(id)}/dispatch`, json({ agent }));
  },
  /** 任务面板上次选用的 CLI 工具 / 模型 / 思考深度。 */
  agentDefaults(): Promise<WandTaskAgent> {
    return request("/api/wand-task-agent-defaults")
      .then((payload) => normalizeIssueAgentDefaults(payload))
      .catch(() => normalizeIssueAgentDefaults(null));
  },
  saveAgentDefaults(agent: WandTaskAgent): Promise<void> {
    const write = agentDefaultsWrite
      .catch(() => undefined)
      .then(async () => {
        await request("/api/wand-task-agent-defaults", json(agent, "PUT"));
      });
    agentDefaultsWrite = write;
    return write;
  },
};

export type { IssueWorkspace };
