import type { AiTeamLiveStep } from "./ai-team-types.js";
import type { ConversationTurn } from "./types.js";

export const conversationTaskPreviewLabels: Record<NonNullable<ConversationTurn["taskPreview"]>["status"], string> = {
  starting: "正在启动", running: "处理中", awaiting_approval: "等你批准计划", waiting_user: "等你回复",
  done: "已完成", failed: "执行失败", stopped: "已停止", unavailable: "任务不可用",
};

/** Shared by the HTTP snapshot and WS projection; only this run’s real output, bounded at the tail. */
export function conversationTaskLiveText(steps: readonly AiTeamLiveStep[]): string {
  return steps.filter(step => step.text.trim()).map(step => `${step.memberName}：\n${step.text.slice(-4000)}`).join("\n\n").slice(-4000);
}
