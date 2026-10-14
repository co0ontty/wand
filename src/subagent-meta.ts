/**
 * 子 Agent 派发判据：Web 服务端（`structured-client-protocol.ts` 盖章，Android/iOS/macOS
 * 都消费这份章）与 Web 前端（`web-ui/browser/agent-runs.ts` 现场补判）共用同一份实现，
 * 不再各写一套——判据只留一个地方，就不会再出现「一端改了另一端没改」的漂移。
 *
 * 判据只问一件事：pi 的 `subagent` 工具带不带 `action`。
 * pi 自己把 `action` 定义成「管理/控制专用，省略才是执行」
 * （pi-subagents schemas：`Management action (when present, tool operates in management mode)`、
 * `Management/control only; omit for execution`），所以：
 *   - 带 `action` ⇒ 管理调用（status / list / validate / steer / lane.* / schedule.* / command.* …），
 *     不进子 Agent 面板，正文照常留在转录里；
 *   - 不带 `action` ⇒ 真正的派发（agent+task、tasks/chain、workflow 脚本、`workflow: true`、
 *     命名工作流资源、resume、mission …），一律进面板。
 *
 * 这里刻意**不枚举**派发形态、也**不枚举**管理动作：pi 以后新增派发参数或新增 action 值，
 * 都自动落到正确一侧，不用再回来补名单。历史实现按「有没有 agent/task」判，于是
 * `subagent({ workflow: "…", async: true })` 这种真派发被当成管理调用丢掉，界面上什么都不显示。
 *
 * Claude Code 的 `Task` / `Agent` 是另一套形状：工具名本身即派发语义，`subagent_type` 可省；
 * 其他 provider 只要真给了 `subagent_type`，同样按派发处理。
 */

/** pi 扩展工具经 `piToolName` 映射后带 `Pi/` 前缀。 */
export const PI_SUBAGENT_TOOL_NAME = "Pi/subagent";
export const PI_TODO_TOOL_NAME = "Pi/todo";
/** Claude Code 的派发工具名。 */
export const CLAUDE_SUBAGENT_TOOL_NAMES: readonly string[] = ["Task", "Agent"];
/** workflow 形态没有 agent 名，面板用这个类型标识；标题另取脚本名。 */
export const WORKFLOW_SUBAGENT_AGENT_TYPE = "workflow";

export interface SubagentDispatchMeta {
  taskId: string;
  agentType?: string;
  taskDescription?: string;
}

/** 已有的 `__subagent` 盖章（服务端 `SubagentMeta` / 各端 DTO 的结构投影）。 */
export interface SubagentStampLike {
  taskId?: string;
  agentType?: string;
  taskDescription?: string;
}

export interface SubagentToolUseLike {
  type?: string;
  name?: string;
  id?: string;
  input?: unknown;
  __subagent?: SubagentStampLike | null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inputRecord(block: SubagentToolUseLike): Record<string, unknown> {
  const input = block.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * workflow 派发的可读标题：脚本路径取末段（`…/continuation.js` → `continuation.js`），
 * 命名工作流资源取资源名。`workflow: true`（用同一条回复里的代码块）没有名字，返回 undefined。
 */
export function subagentWorkflowLabel(workflow: unknown): string | undefined {
  if (typeof workflow !== "string") return undefined;
  const raw = workflow.trim();
  if (!raw || raw === "true") return undefined;
  const segments = raw.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : raw;
}

/**
 * 从一次 tool_use 派生子 Agent 元数据；不是派发（或不是工具调用）时返回 null。
 * 已盖章的块直接回投影，保证服务端盖的章在各端读出来一致。
 */
export function deriveSubagentDispatchMeta(
  block: SubagentToolUseLike | null | undefined,
): SubagentDispatchMeta | null {
  if (!block) return null;

  const stamped = block.__subagent;
  const stampedTaskId = textValue(stamped?.taskId);
  if (stampedTaskId) {
    const stampedAgentType = textValue(stamped?.agentType);
    const stampedDescription = textValue(stamped?.taskDescription);
    return {
      taskId: stampedTaskId,
      ...(stampedAgentType ? { agentType: stampedAgentType } : {}),
      ...(stampedDescription ? { taskDescription: stampedDescription } : {}),
    };
  }

  if (block.type !== "tool_use") return null;
  const taskId = textValue(block.id);
  if (!taskId) return null;
  const input = inputRecord(block);

  if (block.name === "workflow" || block.name === "Pi/workflow") {
    return { taskId, agentType: WORKFLOW_SUBAGENT_AGENT_TYPE, taskDescription: "工作流" };
  }

  if (block.name === PI_SUBAGENT_TOOL_NAME || block.name === "subagent") {
    // 有 action 就是管理/控制调用：面板不收，正文照旧。省略 action 才是执行。
    if (textValue(input.action)) return null;
    const agent = textValue(input.agent);
    const task = textValue(input.task);
    const workflow = input.workflow;
    const description = task ?? subagentWorkflowLabel(workflow);
    const agentType = agent ?? (workflow === undefined ? undefined : WORKFLOW_SUBAGENT_AGENT_TYPE);
    return {
      taskId,
      ...(agentType ? { agentType } : {}),
      ...(description ? { taskDescription: description } : {}),
    };
  }

  const agentType = textValue(input.subagent_type);
  if (CLAUDE_SUBAGENT_TOOL_NAMES.indexOf(String(block.name)) < 0 && !agentType) return null;
  const description = textValue(input.description);
  return {
    taskId,
    ...(agentType ? { agentType } : {}),
    ...(description ? { taskDescription: description } : {}),
  };
}
