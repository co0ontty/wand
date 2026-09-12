export type WandTaskStatus = "todo" | "doing" | "done";
export type WandTaskPriority = "none" | "low" | "medium" | "high" | "urgent";

/** 任务派发时选择的 CLI 工具；空串表示尚未指定。 */
export type WandTaskAgentProvider = "claude" | "codex" | "opencode" | "grok" | "qoder" | "pi";
export type WandTaskAgentModel = string;
export type WandTaskAgentEffort = "off" | "standard" | "deep" | "max";

/** 任务上的默认派发配置：先选工具 / 模型 / 思考深度，再一键交给 Agent。 */
export interface WandTaskAgent {
  provider: WandTaskAgentProvider;
  /** 具体模型 ID；"default" 表示跟随服务端为该 provider 选择的默认模型。 */
  model: WandTaskAgentModel;
  thinkingEffort: WandTaskAgentEffort;
}

/** 任务标题来源；标题是可选字段，留空时由服务端按描述自动生成。 */
export type WandTaskTitleSource = "user" | "auto";

export interface WandTask {
  id: string;
  workspaceId: string | null;
  /** 关联的侧栏工作任务；归档/新建时用来对账，不随 WorkspaceTask 删除而消失。 */
  workspaceTaskId: string | null;
  identifier: string;
  title: string;
  /** 'user' = 用户自己填的标题；'auto' = 用户留空后按描述自动生成。 */
  titleSource: WandTaskTitleSource;
  description: string;
  status: WandTaskStatus;
  priority: WandTaskPriority;
  labels: string[];
  dueDate: string | null;
  sortOrder: number;
  /** 该任务绑定的执行 Agent；null 表示还没指定。 */
  agent: WandTaskAgent | null;
  createdAt: string;
  updatedAt: string;
}

export interface WandTaskDetail extends WandTask {
  sessionIds: string[];
}
