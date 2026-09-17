import type {
  WandTask,
  WandTaskAgent,
  WandTaskDetail,
  WandTaskPriority,
  WandTaskStatus,
} from "../../../task-types";
import { normalizeIssueAgentDefaults, type IssueWorkspace } from "./task-board-agent";
import { jsonBody, requestJson } from "../http-adapter";
import { taskMutationCompleted } from "../task-changes";

function mutateTask<T>(url: string, init: RequestInit): Promise<T> {
  return requestJson<T>(url, init).then(taskMutationCompleted);
}

let agentDefaultsWrite = Promise.resolve();


/** GET /api/wand-tasks 返回的任务：附带头部所需的工作空间、里程碑与已绑定会话。 */
export interface WandTaskListed extends WandTaskDetail {
  workspace: { id: string; name: string; cwd: string } | null;
  /** 服务端已解出的里程碑（含名称），卡片可以直接显示。 */
  milestone: { id: string; name: string } | null;
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
  /** 会话实际跑的执行模式；旧会话可能为空。 */
  mode?: string;
}

export interface IssueDispatchResult {
  ok: boolean;
  taskId: string;
  session: {
    id: string;
    provider: string;
    model: string | null;
    thinkingEffort: string;
    mode?: string;
    cwd: string;
  };
}

export const taskBoardRepository = {
  list(workspaceId?: string): Promise<WandTaskListed[]> {
    return requestJson(`/api/wand-tasks${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`);
  },
  workspaces(): Promise<IssueWorkspace[]> {
    return requestJson("/api/workspaces");
  },
  /** 服务端模型目录；派发下拉需要按 provider 过滤可选模型。 */
  models(): Promise<unknown> {
    return requestJson("/api/models");
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
    /** 里程碑 id；null / 省略表示不归入里程碑。 */
    milestoneId?: string | null;
    agent?: WandTaskAgent | null;
  }): Promise<WandTaskListed> {
    return mutateTask("/api/wand-tasks", jsonBody(input));
  },
  /** 单条任务：新建后用来确认后台自动标题是否已经生成。 */
  get(id: string): Promise<WandTaskListed> {
    return requestJson(`/api/wand-tasks/${encodeURIComponent(id)}`);
  },
  update(
    id: string,
    patch: Partial<Pick<WandTask, "title" | "titleSource" | "description" | "status" | "priority" | "labels" | "dueDate" | "milestoneId" | "workspaceId" | "sortOrder" | "agent">>,
  ): Promise<WandTaskListed> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}`, jsonBody(patch, "PATCH"));
  },
  remove(id: string): Promise<void> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined);
  },
  /** 用选定的 CLI 工具开一个结构化会话；prompt 作为这次派发的首条消息。 */
  dispatch(
    id: string,
    agent: WandTaskAgent,
    extra?: { prompt?: string; workspaceId?: string | null },
  ): Promise<IssueDispatchResult> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}/dispatch`, jsonBody({
      agent,
      ...(extra?.prompt != null ? { prompt: extra.prompt } : {}),
      ...(extra && "workspaceId" in extra ? { workspaceId: extra.workspaceId ?? null } : {}),
    }));
  },
  moveSession(id: string, sessionId: string): Promise<WandTaskListed> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}/sessions`, jsonBody({ sessionId }));
  },
  /** 任务面板上次选用的 CLI 工具 / 模型 / 思考深度 / 工作模式。 */
  agentDefaults(): Promise<WandTaskAgent> {
    return requestJson("/api/wand-task-agent-defaults")
      .then((payload) => normalizeIssueAgentDefaults(payload))
      .catch(() => normalizeIssueAgentDefaults(null));
  },
  saveAgentDefaults(agent: WandTaskAgent): Promise<void> {
    const write = agentDefaultsWrite
      .catch(() => undefined)
      .then(async () => {
        await requestJson("/api/wand-task-agent-defaults", jsonBody(agent, "PUT"));
      });
    agentDefaultsWrite = write;
    return write;
  },
};

export type { IssueWorkspace };
