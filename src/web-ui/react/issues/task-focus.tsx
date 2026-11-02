import * as React from "react";
import { Alert, Flex, Typography } from "antd";
import type { WandTaskListed } from "./task-board-repository";
import { taskBoardRepository } from "./task-board-repository";
import type { WandTaskComment } from "../../../task-types";
import { WandButton } from "../ui";
import { TaskExpandableText } from "./task-expandable-text";
import { DeferredMarkdownPreview } from "../file-preview/deferred-markdown";

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
  const recent = [...comments].reverse().find(comment => comment.sourceCommentId && !comment.dispatch);
  const submitted = children.filter(child => ["review", "ready", "archived"].includes(child.status));
  const title = gaps.length ? `${gaps.length} 项任务有待处理缺口` : task.status === "review" ? `交付 v${task.deliveryRevision ?? 0} · 等待验收`
    : task.status === "ready" ? "验收已通过 · 等待人工确认" : task.status === "doing" ? "执行中 · 尚未提交整体验收" : "需求规划";
  // 只在有未解除的缺口时出现：状态与交付依据已由「交付结论」呈现，这里不再重复一个大色块。
  if (!gaps.length) return <></>;
  return <Alert type={gaps.length ? "warning" : "info"} className="task-board-focus" title={<Typography.Text strong>{title}</Typography.Text>} description={<Flex vertical gap={10}>
    <Typography.Text type="secondary">{children.length ? `实现子任务：${submitted.length} / ${children.length} 已提交交付。` : "尚无正式子任务；已有历史与会话保持原归属。"}会话结束与交付完成分别记录。</Typography.Text>
    {gaps.map(gap => <div key={gap.task.id}><Typography.Text strong ellipsis={{ tooltip: gap.task.title }} style={{ display: "block", maxWidth: "100%" }}>{gap.task.identifier} · {gap.task.title}</Typography.Text>
      <TaskExpandableText plain lines={3} className="task-focus-blocker">{gap.blocker}</TaskExpandableText>
      <WandButton kind="primary" size="small" onClick={() => onHandle(gap.commentId, `请处理 ${gap.task.identifier} 当前阻塞：${gap.blocker}\n请先读取最新上下文，保留已有交付，回填实际证据及未解除条件。`)}>@ 指派处理此缺口</WandButton></div>)}
    {!gaps.length && recent && task.status === "doing" && <details><summary>查看最新回填 · {new Date(recent.createdAt).toLocaleString()}</summary><DeferredMarkdownPreview content={recent.body} variant="inline" wrap/></details>}
    <Flex wrap gap={8}>{task.status !== "archived" && !gaps.length && <WandButton kind="primary" size="small" onClick={() => onHandle(recent?.sourceCommentId ?? null, "请读取当前需求与子任务的最新上下文，处理尚未解除的阻塞；已有修复先复核，回填实际证据和剩余条件。")}>评论 @ 处理当前阻塞</WandButton>}
      <WandButton size="small" onClick={onAcceptance}>查看交付与验收</WandButton></Flex>
  </Flex>}/>;
}
