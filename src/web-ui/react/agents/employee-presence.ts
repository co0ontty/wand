import type { AgentActivityState } from "../../../mission-types.js";

export type EmployeePresenceTone = "warning" | "accent" | "neutral" | "muted";

export interface EmployeePresence {
  text: string;
  tone: EmployeePresenceTone;
  dotKind: "solid-spin" | "solid" | "hollow";
}

/**
 * 依据设计规格 §2.2 员工在线状态唯一映射
 * 优先级（高 → 低）：
 * 1. 需要你 (needs_permission / permissionBlocked) -> 等待授权, warning, 实心 + 呼吸
 * 2. 等待回答 (needs_input / waiting-input) -> 等待回答, warning, 实心 + 呼吸
 * 3. 执行任务中 (本轮运行中工具调用 / running) -> 执行任务中, accent, 实心 + 呼吸
 * 4. 思考中 (inFlight / turnActive) -> 思考中, accent, 实心 + 呼吸
 * 5. 空闲 (有会话且无以上任何命中) -> 空闲, neutral, 实心
 * 6. 离线 (全部候选不可用) -> 离线, muted, 空心
 * 7. 未开始 (还没有任何会话) -> 未开始, muted, 空心
 */
export function getEmployeePresence(params: {
  hasSession?: boolean;
  isAllOffline?: boolean;
  permissionBlocked?: boolean;
  activityState?: AgentActivityState | string;
  status?: string;
  inFlight?: boolean;
  hasRunningTools?: boolean;
}): EmployeePresence {
  const {
    hasSession = false,
    isAllOffline = false,
    permissionBlocked = false,
    activityState,
    status = "",
    inFlight = false,
    hasRunningTools = false,
  } = params;

  if (permissionBlocked || activityState === "needs_permission") {
    return { text: "等待授权", tone: "warning", dotKind: "solid-spin" };
  }

  if (
    activityState === "needs_input" ||
    status === "waiting-input" ||
    status === "waiting_input"
  ) {
    return { text: "等待回答", tone: "warning", dotKind: "solid-spin" };
  }

  if (hasRunningTools || activityState === "working") {
    return { text: "执行任务中", tone: "accent", dotKind: "solid-spin" };
  }

  if (inFlight) {
    return { text: "思考中", tone: "accent", dotKind: "solid-spin" };
  }

  if (hasSession) {
    return { text: "空闲", tone: "neutral", dotKind: "solid" };
  }

  if (isAllOffline) {
    return { text: "离线", tone: "muted", dotKind: "hollow" };
  }

  return { text: "未开始", tone: "muted", dotKind: "hollow" };
}
