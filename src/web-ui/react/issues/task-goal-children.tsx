import { TaskBoardAgentChips } from "./task-executor-chips";
import * as React from "react";
import { Collapse, Flex, Tag, Typography } from "antd";
import { WandButton } from "../ui";
import { issueStatusLabel } from "./task-board-agent";
import type { WandTaskListed } from "./task-board-repository";

const expandedGoals = new Map<string, boolean>();

/** One relationship surface across board, list, overview and timeline. */
export function TaskGoalChildren({ task, tasks, onOpen, path = [] }: {
  task: WandTaskListed; tasks: readonly WandTaskListed[]; onOpen(id: string): void; path?: string[];
}): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState(() => expandedGoals.get(task.id) ?? false);
  const children = tasks.filter(t => t.parentTaskId === task.id && !path.includes(t.id) && t.id !== task.id);
  if (!children.length) return null;
  const review = children.filter(t => t.acceptance?.acceptedAt).length;
  return <Collapse size="small" ghost activeKey={expanded ? [task.id] : []} onChange={keys => { const open = Array.isArray(keys) ? keys.length > 0 : Boolean(keys); expandedGoals.set(task.id, open); setExpanded(open); }} items={[{
    key: task.id, label: `${children.length} 个子任务 · ${review} 个已验收 · ${task.acceptance?.acceptedAt ? "主目标验收通过" : "主目标待整体验收"}`,
    children: <Flex vertical gap="small" aria-label={`${task.title} 的子任务计划`}>
      {children.map(child => <div key={child.id}>
        <WandButton kind="ghost" onClick={() => onOpen(child.id)} style={{ height: "auto", whiteSpace: "normal", textAlign: "left" }}>
          {child.identifier} · {child.title}
        </WandButton>
        <Flex gap={4} wrap><Tag>{issueStatusLabel(child.status)}</Tag>
          {child.dueDate && <Tag>截止 {child.dueDate}</Tag>}
          <Typography.Text type="secondary">{child.sessions.length ? `${child.sessions.length} 个执行会话 · 交付待验收` : "尚未派发"}</Typography.Text>
          <TaskBoardAgentChips sessions={child.sessions} assigned={child.agent} subject={child.executionSubject} assignee={child.assignedExecutor}/>
        </Flex>
        {child.description && <Typography.Paragraph ellipsis={{ rows: 2, expandable: true }}>{child.description}</Typography.Paragraph>}
        {child.acceptance?.blocker && <Typography.Text type="warning">阻塞：{child.acceptance.blocker}</Typography.Text>}
        {child.acceptance?.evidence && <Typography.Paragraph>交付证据：{child.acceptance.evidence}</Typography.Paragraph>}
        {child.sessions.some(s => ["failed", "waiting-input", "permission-blocked"].includes(s.status)) && <Typography.Text type="warning">执行受阻，请查看源会话</Typography.Text>}
        {child.sessions.length > 0 && <WandButton kind="ghost" onClick={() => onOpen(child.id)}>查看交付与执行记录</WandButton>}
        {tasks.some(t => t.parentTaskId === child.id) && <><Tag>历史深层关系 · 保留原记录，调整前需确认</Tag><TaskGoalChildren task={child} tasks={tasks} onOpen={onOpen} path={[...path, task.id]}/></>}
      </div>)}
    </Flex>,
  }]}/>;
}
