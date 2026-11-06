import * as React from "react";
import { Flex, Tag, Typography } from "antd";
import type { TaskExecutionSubject, WandTaskAgent } from "../../../task-types";
import type { IssueSessionSummary, WandTaskListed } from "./task-board-repository";
import { taskExecutors, taskExecutorToolLabels } from "./task-executors";
import { useSiliconEmployees } from "../agents/employee-repository";
import { TaskPersonAvatar } from "./task-person-avatar";
import { WandButton, WandPopover } from "../ui";

function PersonMark({ person }: { person: ReturnType<typeof taskExecutors>[number] }): React.ReactElement {
  const kind = person.key.startsWith("team:") ? "team" : person.employeeId || person.key.startsWith("legacy-employee:") ? "employee" : "tool";
  return <TaskPersonAvatar kind={kind} id={person.employeeId} name={person.name} avatar={person.avatar} provider={kind === "tool" ? person.provider : undefined}/>;
}

export function TaskBoardAgentChips({ sessions, assigned, subject, assignee, compact = false }: {
  sessions: IssueSessionSummary[]; assigned: WandTaskAgent | null; subject?: TaskExecutionSubject | null; assignee?: WandTaskListed["assignedExecutor"]; compact?: boolean;
}): React.ReactElement {
  const { employees } = useSiliconEmployees();
  const executors = taskExecutors(sessions, assigned, subject, employees, assignee);
  if (!executors.length) return <Typography.Text type="secondary">未配置负责人</Typography.Text>;
  const personChip = (person: typeof executors[number]) => <Tag key={person.key} style={{ maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }}>
    <Flex align="center" gap={6}>
      <PersonMark person={person}/>
      <Flex vertical style={{ minWidth: 0 }}>
        <span>{person.name} · {person.state === "running" ? "运行中" : person.state === "current" ? `${person.configured ? "负责人" : "会话"} · ${person.activity}` : person.state === "assigned" ? "负责人已配置 · 暂无关联会话" : "历史执行"}</span>
        {person.employeeId || person.key.startsWith("legacy-employee:") ? <Typography.Text type="secondary">{taskExecutorToolLabels(person).join(" · ")}</Typography.Text> : null}
      </Flex>
    </Flex>
  </Tag>;
  if (compact) {
    const person = executors[0]!;
    const state = person.state === "running" ? "运行中" : person.state === "current" ? `${person.configured ? "负责人" : "会话"} · ${person.activity}` : person.state === "assigned" ? "负责人已配置" : "历史执行";
    return <Flex align="center" gap={4} className="task-board-executors-compact" aria-label="任务执行者">
      <span className="task-board-executor-summary" title={`${person.name} · ${state} · ${taskExecutorToolLabels(person).join(" · ")}`}>
        <PersonMark person={person}/>
        <span>{person.name}</span><small>{state}</small>
      </span>
      {executors.length > 1 && <WandPopover ariaLabel="全部执行者" align="start" trigger={<WandButton kind="ghost" size="small" aria-label={`查看全部 ${executors.length} 位执行者`}>+{executors.length - 1}</WandButton>}><Flex vertical gap={6}>{executors.map(personChip)}</Flex></WandPopover>}
    </Flex>;
  }
  return <Flex wrap gap={6} aria-label="任务执行者">{executors.slice(0, 3).map(personChip)}
    {executors.length > 3 && <WandPopover ariaLabel="全部执行者" trigger={<WandButton kind="ghost" size="small">还有 {executors.length - 3} 位执行者</WandButton>}><Flex vertical gap={6}>{executors.map(personChip)}</Flex></WandPopover>}
  </Flex>;
}

