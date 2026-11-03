import * as React from "react";
import { Collapse, Flex, List, Tag, Typography } from "antd";
import { WandButton } from "../ui";
import { SessionMoveButton } from "../workspaces/session-move-button";
import { issueAgentLabel } from "./task-board-agent";
import { taskAcceptanceLabel, taskSessionActivity, taskSessionSummary } from "./task-delivery-state";
import { TaskExpandableText } from "./task-expandable-text";
import type { WandTaskListed } from "./task-board-repository";

export function TaskSessionSummary({ task, onOpenSession, onNewParallel }: {
  task: WandTaskListed; onOpenSession?: (id: string) => void; onNewParallel(): void;
}): React.ReactElement {
  return <Flex vertical gap="small" aria-label="多会话交付汇总">
    <Typography.Text strong>{taskAcceptanceLabel(task.acceptance, task)}</Typography.Text>
    {task.acceptance?.blocker && <Typography.Text type="warning">待处理原因：{task.acceptance.blocker}</Typography.Text>}
    <Typography.Text type="secondary">汇总负责人：{task.assignedExecutor?.name || "尚未指定"}。负责人核对各会话产物后，在「交付与验收」统一记录证据；会话结束不等于交付完成。</Typography.Text>
    <Collapse ghost items={[{ key: "sessions", label: `${task.sessions.length} 个关联会话${task.sessions.length ? " · " + taskSessionSummary(task.sessions) : ""}`,
      children: <List size="small" dataSource={task.sessions} locale={{ emptyText: "尚无会话；需要执行时再新建。" }} renderItem={session =>
        <List.Item><Flex vertical gap="small" style={{ minWidth: 0, width: "100%" }}>
          <Flex wrap align="center" gap="small"><Typography.Text strong>{session.title || session.id}</Typography.Text><Tag>{taskSessionActivity(session)}</Tag></Flex>
          <TaskExpandableText plain lines={3}>目的与范围：{session.purpose || session.title || "未记录，请在原会话核对"}</TaskExpandableText>
          <Typography.Text type="secondary" style={{ overflowWrap: "anywhere" }}>{session.employeeName || issueAgentLabel(session.provider, session.engine)} · {session.cwd || "目录未记录"}</Typography.Text>
          <Typography.Text type="secondary">{session.taskCommentId ? "产物见对应评论执行记录；继续不重放原派发。" : "产物由负责人在原会话核对后汇总；空闲或结束不代表已交付。"}</Typography.Text>
          <Flex wrap align="center" gap="small">
            <WandButton kind="ghost" onClick={() => onOpenSession?.(session.id)} disabled={!onOpenSession} aria-label={`继续已有会话：${session.title || session.id}`}>继续已有会话</WandButton>
            <SessionMoveButton sessionId={session.id} taskId={task.workspaceTaskId ?? undefined}/>
          </Flex>
        </Flex></List.Item>}/>,
    }]}/>
    <WandButton style={{ alignSelf: "flex-start" }} disabled={task.status === "archived"} onClick={onNewParallel}>新建并行会话</WandButton>
  </Flex>;
}
