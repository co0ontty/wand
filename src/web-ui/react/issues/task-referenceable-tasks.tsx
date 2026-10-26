import * as React from "react";
import { Flex, Typography } from "antd";
import type { WandTaskListed } from "./task-board-repository";
import { WandButton } from "../ui";
import { TaskChildStreamRow } from "./task-stream-row";

/** One child list in the goal detail; the same identifiers remain available to # references. */
export function TaskReferenceableTasks({ children, onOpenTask, onOpenSession, onCreateChild }: {
  children: readonly WandTaskListed[];
  onOpenTask?(id: string): void;
  onOpenSession?(id: string): void;
  onCreateChild?(): void;
}): React.ReactElement | null {
  if (!children.length && !onCreateChild) return null;
  const awaiting = children.filter(child => child.status === "done" && !child.acceptance?.acceptedAt).length;
  const accepted = children.filter(child => child.acceptance?.acceptedAt).length;
  return <section className="task-board-child-stream" role="region" aria-label="子任务">
    <Flex wrap align="center" justify="space-between" gap="small" className="task-stream-heading">
      <Flex wrap align="center" gap="small">
        <Typography.Title level={4} style={{ margin: 0 }}>子任务</Typography.Title>
        <Typography.Text type="secondary">{children.length} 项 · {awaiting} 项等待验收 · {accepted} 项验收通过</Typography.Text>
      </Flex>
      {onCreateChild && <WandButton kind="ghost" size="small" onClick={onCreateChild}>添加子任务</WandButton>}
    </Flex>
    <Flex vertical gap="small" className="task-board-detail-content">
      {!children.length && <Typography.Text type="secondary">把独立交付目标拆成子任务，再分别派发与验收。</Typography.Text>}
      {children.map(child => <TaskChildStreamRow key={child.id} task={child} onOpen={id => onOpenTask?.(id)} onOpenSession={onOpenSession}/>)}
    </Flex>
    {children.length > 0 && <Typography.Text type="secondary">评论中输入 # 可引用子任务；工作完成后等待你验收，归档保留原任务。</Typography.Text>}
  </section>;
}
