import * as React from "react";
import { Flex, Typography } from "antd";
import type { WandTaskListed } from "../../../task-types";
import { WandIcon } from "../ui/icons";

/**
 * 可引用任务：挂在主描述下方。
 *
 * 子任务在这里是「引用对象」而不是平铺的执行条目——评论里用 `#TASK-133` 引用它们，
 * 编号本身就是句柄。这里只做导航与可发现性，执行状态仍在各自子任务里。
 */
export function TaskReferenceableTasks({ children, onOpenTask }: {
  children: readonly WandTaskListed[];
  onOpenTask?(id: string): void;
}): React.ReactElement | null {
  if (!children.length) return null;
  return <section className="task-board-referenceable" role="region" aria-label="可引用任务">
    <Flex align="center" gap={8} className="task-board-referenceable-head">
      <Typography.Text strong>可引用任务</Typography.Text>
      <Typography.Text type="secondary">{children.length} 个子任务 · 评论里输入 # 即可引用</Typography.Text>
    </Flex>
    <div className="task-board-referenceable-grid">
      {children.map(child => <button type="button" key={child.id} className="task-board-referenceable-item"
        aria-label={`打开 ${child.identifier} ${child.title}`} onClick={() => onOpenTask?.(child.id)}>
        <span className="task-board-referenceable-id">#{child.identifier}</span>
        <span className="task-board-referenceable-title">{child.title}</span>
        <span className="task-board-referenceable-status" data-status={child.status}>{child.status}</span>
        <WandIcon name="chevron" size={12}/>
      </button>)}
    </div>
  </section>;
}
