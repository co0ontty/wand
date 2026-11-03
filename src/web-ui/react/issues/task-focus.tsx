import * as React from "react";
import { Flex, Typography } from "antd";
import type { WandTaskListed } from "./task-board-repository";
import { taskBoardRepository } from "./task-board-repository";
import type { WandTaskComment } from "../../../task-types";
import { WandButton } from "../ui";
import { TaskExpandableText } from "./task-expandable-text";


export function TaskFocus({ task, children, onHandle, onAcceptance }: { task: WandTaskListed; children: WandTaskListed[];
  onHandle(commentId: string | null, instruction: string): void; onAcceptance(): void }): React.ReactElement {
  const [latest, setLatest] = React.useState<{ taskId: string; comments: WandTaskComment[] } | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const load = () => { void taskBoardRepository.comments(task.id, { limit: 50, signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) setLatest({ taskId: task.id, comments: page.comments });
    }).catch(() => undefined); };
    load(); const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [task.id, task.updatedAt]);
  const comments = latest?.taskId === task.id ? latest.comments : [];
  const gaps = [task, ...children].flatMap(item => {
    const blocker = item.acceptance?.blocker?.trim() || item.verification?.blocker?.trim();
    if (!blocker) return [];
    const source = [...comments].reverse().find(comment => comment.dispatch?.executionTaskId === item.id || comment.taskId === item.id && comment.dispatch);
    return [{ task: item, blocker, commentId: source?.id ?? null }];
  });
  const evidence = (task.acceptance?.evidence || task.verification?.evidence || "").trim();
  if (!gaps.length) return <></>;
  return <section className="task-workflow-focus" aria-label="当前待处理条件">
    <Flex align="center" justify="space-between" gap={12} wrap>
      <Typography.Text strong>{gaps.length === 1 ? "还有一项条件待完成" : `${gaps.length} 项任务有待处理条件`}</Typography.Text>
      <WandButton kind="ghost" size="small" onClick={onAcceptance}>查看交付与验收</WandButton>
    </Flex>
    {gaps.map(gap => <div key={gap.task.id} className="task-workflow-gap">
      {gap.task.id !== task.id && <Typography.Text strong>{gap.task.identifier} · {gap.task.title}</Typography.Text>}
      <TaskExpandableText plain lines={2} className="task-focus-blocker">{gap.blocker}</TaskExpandableText>
      <WandButton size="small" onClick={() => onHandle(gap.commentId, `请处理 ${gap.task.identifier} 当前阻塞：${gap.blocker}\n请先读取最新上下文，保留已有交付，回填实际证据及未解除条件。`)}>准备交接处理</WandButton>
    </div>)}
    {evidence && <details className="task-workflow-evidence"><summary>查看已有证据</summary><TaskExpandableText plain>{evidence}</TaskExpandableText></details>}
  </section>;
}
