import * as React from "react";
import { Flex, Typography } from "antd";
import { taskHumanAccepted, taskWorkflowStage } from "../../../task-types";
import type { WandTaskListed } from "./task-board-repository";
import { taskAcceptanceLabel } from "./task-delivery-state";
import { TaskExpandableText } from "./task-expandable-text";
import { WandButton } from "../ui/button";

/**
 * 详情首屏的「交付结论」：卡片上的状态（AI 已通过 / 交付已提交…）在这里要能看到依据。
 * 结论、证据摘录、会话事实各一行；完整证据与操作仍在下方「交付与验收」。
 */
export function TaskDeliverySummary({ task, onOpenAcceptance }: { task: WandTaskListed; onOpenAcceptance(): void }): React.ReactElement | null {
  const stage = taskWorkflowStage(task.status);
  const evidence = (task.acceptance?.evidence || task.verification?.evidence || "").trim();
  const inFlow = ["doing", "review", "ready"].includes(stage);
  if (!inFlow && !evidence) return null;
  // 执行中但还没有任何交付证据时，结论与阶段已由头部概况条表达，这里不再放一条空结论占位。
  if (stage === "doing" && !evidence) return null;
  // 有未解除的缺口且还没有证据时，结论与操作已由上方 TaskFocus 警示块承担，这里不再重复一条同义行。
  if (task.acceptance?.blocker?.trim() || task.verification?.blocker?.trim()) return null;
  const noSessions = task.sessions.length === 0;
  const tone = taskHumanAccepted(task) ? "success" : task.status === "ready" ? "passed" : task.acceptance?.blocker?.trim() ? "warning" : "neutral";
  return <section className="task-delivery-summary" data-tone={tone} aria-label="交付结论">
    <Flex align="center" justify="space-between" gap="small" wrap>
      <Typography.Text strong>{taskAcceptanceLabel(task.acceptance, task)}{task.deliveryRevision ? ` · 交付 v${task.deliveryRevision}` : ""}</Typography.Text>
      <WandButton kind="ghost" size="small" onClick={onOpenAcceptance}>查看交付与验收</WandButton>
    </Flex>
    {evidence
      ? <TaskExpandableText plain className="task-delivery-evidence">{evidence}</TaskExpandableText>
      : <Typography.Text type="secondary">还没有记录交付证据。</Typography.Text>}
    {inFlow && noSessions && <Typography.Text type="secondary" className="task-delivery-note">
      没有关联会话记录（会话可能已清理或未绑定到此任务）；上面的结论来自已保存的交付/验收记录，不代表仍有会话在执行。
    </Typography.Text>}
  </section>;
}
