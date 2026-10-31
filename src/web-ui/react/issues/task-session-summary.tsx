import * as React from "react";
import { Collapse, Flex, List, Tag, Typography } from "antd";
import { WandButton } from "../ui";
import { issueAgentLabel } from "./task-board-agent";
import { taskAcceptanceLabel, taskSessionActivity, taskSessionSummary } from "./task-delivery-state";
import type { WandTaskListed } from "./task-board-repository";

export function TaskSessionSummary({ task, onOpenSession, onNewParallel }: {
  task: WandTaskListed; onOpenSession?: (id: string) => void; onNewParallel(): void;
}): React.ReactElement {
  return <Flex vertical gap="small" aria-label="多会话交付汇总">
    <Typography.Text strong>{taskAcceptanceLabel(task.acceptance, task)}</Typography.Text>
    {task.acceptance?.blocker && <Typography.Text type="warning">待处理原因：{task.acceptance.blocker}</Typography.Text>}
    <Typography.Text>汇总负责人：{task.assignedExecutor?.name || "尚未指定"} · 由负责人核对各会话产物后，在交付与验收中统一记录证据。</Typography.Text>
    <Typography.Text type="secondary">继续已有会话保留原上下文；新建并行会话是独立执行。业务子任务须有独立交付标准，模型内部子 Agent 不计入业务子任务。</Typography.Text>
    <Typography.Text type="secondary">独立范围才并行；同目录或同文件重叠先协调串行，或隔离后合并。此处不改变并发、费用或权限。</Typography.Text>
    <Collapse ghost items={[{ key: "sessions", label: `${task.sessions.length} 个关联会话${task.sessions.length ? " · " + taskSessionSummary(task.sessions) : ""}`,
      children: <List size="small" dataSource={task.sessions} locale={{ emptyText: "尚无会话；需要执行时再新建。" }} renderItem={session =>
        <List.Item><Flex vertical gap="small" style={{ minWidth: 0, width: "100%" }}>
          <Flex wrap align="center" gap="small"><Typography.Text strong>{session.title || session.id}</Typography.Text><Tag>{taskSessionActivity(session)}</Tag></Flex>
          <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} ellipsis={{ rows: 3, expandable: true, symbol: "展开范围" }}>目的与范围：{session.purpose || session.title || "未记录，请在原会话核对"}</Typography.Paragraph>
          <Typography.Text type="secondary" style={{ overflowWrap: "anywhere" }}>{session.employeeName || issueAgentLabel(session.provider, session.engine)} · {session.cwd || "目录未记录"}</Typography.Text>
          <Typography.Text type="secondary">{session.taskCommentId ? "产物与本轮结果见对应评论执行记录；继续不会重放原派发。" : "产物请在原会话核对后由负责人汇总；空闲或结束不代表已交付。"}</Typography.Text>
          <WandButton kind="ghost" style={{ alignSelf: "flex-start" }} onClick={() => onOpenSession?.(session.id)} disabled={!onOpenSession} aria-label={`继续已有会话：${session.title || session.id}`}>继续已有会话</WandButton>
        </Flex></List.Item>}/>,
    }]}/>
    <WandButton style={{ alignSelf: "flex-start" }} disabled={task.status === "archived"} onClick={onNewParallel}>新建并行会话</WandButton>
  </Flex>;
}
