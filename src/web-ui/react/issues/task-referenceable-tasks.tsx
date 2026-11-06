import * as React from "react";
import { resolveTaskDelivery } from "./task-delivery-state";
import { Flex, Typography } from "antd";
import type { WandTaskListed } from "./task-board-repository";
import { WandButton } from "../ui";
import { TaskChildStreamRow } from "./task-stream-row";

/** One child list in the goal detail; the same identifiers remain available to # references. */
export function TaskReferenceableTasks({ children, displayTasks = children, onOpenTask, onOpenSession, onCreateChild }: {
  children: readonly WandTaskListed[];
  displayTasks?: readonly WandTaskListed[];
  onOpenTask?(id: string): void;
  onOpenSession?(id: string): void;
  onCreateChild?(): void;
}): React.ReactElement | null {
  if (!children.length && !onCreateChild) return null;
  // 没有子任务时只留一行入口，不占一个带统计的大标题。
  if (!children.length) return <Flex align="center" justify="space-between" gap="small" className="task-board-child-empty" role="region" aria-label="子任务">
    <Typography.Text type="secondary">子任务 · 暂无，可把独立交付目标拆开分别验收</Typography.Text>
    <WandButton kind="ghost" size="small" onClick={onCreateChild}>添加子任务</WandButton>
  </Flex>;
  const states = children.map(child => resolveTaskDelivery(child, displayTasks));
  const accepted = states.filter(state => state.completed).length;
  const gaps = states.length - accepted;
  return <section className="task-board-child-stream" role="region" aria-label="子任务">
    <Flex wrap align="center" justify="space-between" gap="small" className="task-stream-heading">
      <Flex wrap align="center" gap="small">
        <Typography.Title level={4} style={{ margin: 0 }}>子任务</Typography.Title>
        <Typography.Text type="secondary">{[`${children.length} 项`, gaps ? `${gaps} 项待完成/核对` : "", `${accepted} 项已完成`].filter(Boolean).join(" · ")}</Typography.Text>
      </Flex>
      {onCreateChild && <WandButton kind="ghost" size="small" onClick={onCreateChild}>添加子任务</WandButton>}
    </Flex>
    <Flex vertical gap="small" className="task-board-detail-content">
      {!children.length && <Typography.Text type="secondary">把独立交付目标拆成子任务，再分别派发与验收。</Typography.Text>}
      {children.map(child => <TaskChildStreamRow key={child.id} task={child} displayTasks={displayTasks} onOpen={id => onOpenTask?.(id)} onOpenSession={onOpenSession}/>)}
    </Flex>
    {children.length > 0 && <Typography.Text type="secondary">评论中输入 # 可引用子任务；提交后独立验收，通过自动完成归档；兼容旧流程的待确认记录单独标明。</Typography.Text>}
  </section>;
}
