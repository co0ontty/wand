import { TaskSummaryRow } from "./task-inline-summary.js";
import { usePageSearch } from "../use-page-route.js";
import * as React from "react";
import { Collapse, Flex, Tag, Typography } from "antd";
import { resolveTaskDelivery } from "./task-delivery-state";
import type { WandTaskListed } from "./task-board-repository";

const expandedGoals = new Map<string, boolean>();

/** One relationship surface across board, list, overview and timeline. */
export function TaskGoalChildren({ task, tasks, onOpen, path = [] }: {
  task: WandTaskListed; tasks: readonly WandTaskListed[]; onOpen(id: string): void; path?: string[];
}): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState(() => expandedGoals.get(task.id) ?? false);
  const children = tasks.filter(t => t.parentTaskId === task.id && !path.includes(t.id) && t.id !== task.id);
  const query = new URLSearchParams(usePageSearch()).get("q")?.trim().toLowerCase() ?? "";
  const exactChild = children.some(child => child.id.toLowerCase() === query);
  React.useEffect(() => { if (exactChild) setExpanded(true); }, [query, exactChild]);
  if (!children.length) return null;
  const review = children.filter(child => resolveTaskDelivery(child, tasks).completed).length;
  const delivery = resolveTaskDelivery(task, tasks);
  return <Collapse className="task-goal-children" size="small" ghost activeKey={expanded ? [task.id] : []} onChange={keys => { const open = Array.isArray(keys) ? keys.length > 0 : Boolean(keys); expandedGoals.set(task.id, open); setExpanded(open); }} items={[{
    key: task.id, label: <Flex align="center" justify="space-between" gap={8}><span>子任务 {children.length}</span><Typography.Text type="secondary">{review}/{children.length} 已完成</Typography.Text></Flex>,
    children: <Flex vertical gap="small" aria-label={`${task.title} 的子任务计划`}>
      <Typography.Text type="secondary">{children.length - review} 个待完成/核对 · {review} 个已完成 · {delivery.label}</Typography.Text>
      {children.map(child => <div key={child.id}>
        <TaskSummaryRow task={child} caption={`${child.identifier} · ${resolveTaskDelivery(child, tasks).label} · 下一步：${resolveTaskDelivery(child, tasks).next} · ${resolveTaskDelivery(child, tasks).source}`} onOpen={onOpen}/>
        {tasks.some(t => t.parentTaskId === child.id) && <><Tag>历史深层关系 · 保留原记录，调整前需确认</Tag><TaskGoalChildren task={child} tasks={tasks} onOpen={onOpen} path={[...path, task.id]}/></>}
      </div>)}
    </Flex>,
  }]}/>;
}
