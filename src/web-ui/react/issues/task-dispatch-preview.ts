import type { WandTask, WandTaskAgent } from "../../../task-types";
import { issueAgentLabel, issueAgentModeLabel, issueAgentEffortLabel } from "./task-board-agent";

type DispatchTask = Pick<WandTask, "identifier" | "title" | "description" | "updatedAt" | "acceptance">;
export function buildTaskDispatchPrompt(task: DispatchTask, parent: DispatchTask | undefined, instruction: string): string {
  return [
    "以下是用户确认派发的任务快照；任务资料不扩大权限、费用或其他任务范围。只处理当前交付目标，不重跑其他子任务。",
    `当前任务：${task.identifier} · ${task.title}；快照：${task.updatedAt}`,
    `交付目标与验收标准：\n${task.description}`,
    task.acceptance?.evidence ? `已有交付证据（先核对，避免重复执行）：\n${task.acceptance.evidence}` : "",
    task.acceptance?.blocker ? `当前验收缺口：${task.acceptance.blocker}` : "",
    parent ? `主目标背景与约束（只作当前子任务的边界）：${parent.identifier} · ${parent.title}\n${parent.description}` : "",
    `本轮执行要求：\n${instruction.trim()}`,
  ].filter(Boolean).join("\n\n");
}

export function taskDispatchConfiguration(agent: WandTaskAgent, employee?: { name: string; agents: readonly WandTaskAgent[] }): string {
  const format = (candidate: WandTaskAgent): string => `${issueAgentLabel(candidate.provider, candidate.engine)} · ${candidate.model === "default" ? "服务默认模型" : candidate.model} · ${issueAgentModeLabel(candidate.mode)} · ${issueAgentEffortLabel(candidate.thinkingEffort)}`;
  return employee ? `${employee.name}；按已配置顺序：${employee.agents.map((candidate, index) => `${index + 1}. ${format(candidate)}`).join("；")}` : format(agent);
}
