import * as React from "react";
import { Flex, Tag, Typography } from "antd";
import type { TaskExecutionSubject, WandTaskAgent } from "../../../task-types";
import type { IssueSessionSummary, WandTaskListed } from "./task-board-repository";
import { taskExecutors } from "./task-executors";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { useSiliconEmployees } from "../agents/employee-repository";
import { ProviderLogo } from "../provider-logo";
import { WandButton, WandPopover } from "../ui";

export function TaskBoardAgentChips({ sessions, assigned, subject, assignee }: {
  sessions: IssueSessionSummary[]; assigned: WandTaskAgent | null; subject?: TaskExecutionSubject | null; assignee?: WandTaskListed["assignedExecutor"];
}): React.ReactElement {
  const { employees } = useSiliconEmployees();
  const executors = taskExecutors(sessions, assigned, subject, employees, assignee);
  if (!executors.length) return <Typography.Text type="secondary">待指派</Typography.Text>;
  const personChip = (person: typeof executors[number]) => <Tag key={person.key}>
    <Flex align="center" gap={6}>
      {person.employeeId || person.key.startsWith("legacy-employee:") ? <EmployeeAvatar employee={{ id: person.employeeId ?? person.key, name: person.name, avatar: person.avatar }} size="sm"/> : person.provider ? <ProviderLogo provider={person.provider} className="task-board-agent-logo"/> : null}
      <span>{person.name} · {person.state === "running" ? "执行中" : person.state === "assigned" ? "已指派 · 未启动" : "历史执行"}</span>
    </Flex>
  </Tag>;
  return <Flex wrap gap={6} aria-label="任务执行者">{executors.slice(0, 3).map(personChip)}
    {executors.length > 3 && <WandPopover ariaLabel="全部执行者" trigger={<WandButton kind="ghost" size="small">还有 {executors.length - 3} 位执行者</WandButton>}><Flex vertical gap={6}>{executors.map(personChip)}</Flex></WandPopover>}
  </Flex>;
}

