import * as React from "react";
import { Alert, Flex, Typography } from "antd";
import { TaskTextArea } from "./task-form";
import { WandButton } from "../ui";
import type { WandTaskListed } from "./task-board-repository";
import type { TaskAcceptance } from "../../../task-types";

export function TaskAcceptanceEditor({ task, children, busy, onSave }: {
  task: WandTaskListed; children: WandTaskListed[]; busy: boolean; onSave(value: TaskAcceptance): Promise<boolean>;
}): React.ReactElement {
  const [evidence, setEvidence] = React.useState(task.acceptance?.evidence ?? "");
  const [blocker, setBlocker] = React.useState(task.acceptance?.blocker ?? "");
  const gaps = children.filter(child => !child.acceptance?.acceptedAt);
  return <Flex vertical gap="small" aria-label="交付与验收">
    <Typography.Title level={5}>交付与验收</Typography.Title>
    <Typography.Text type="secondary">会话结束、失败或归档均不代表验收通过。交付目标与验收标准见任务描述。</Typography.Text>
    <TaskTextArea aria-label="交付证据与产物" placeholder="记录产物路径、源会话与验证证据" value={evidence} onChange={event => setEvidence(event.target.value)} autoSize={{ minRows: 3 }}/>
    <TaskTextArea aria-label="验收阻塞" placeholder="仍缺少什么；无阻塞时留空" value={blocker} onChange={event => setBlocker(event.target.value)} autoSize={{ minRows: 2 }}/>
    {gaps.length > 0 && <Alert type="warning" showIcon title={`${gaps.length} 个子任务尚未验收通过`} description={gaps.map(child => child.identifier).join("、")}/>}
    {children.length > 0 && !gaps.length && !task.acceptance?.acceptedAt && <Alert type="info" title="子任务均已验收，主目标仍待整体验收"/>}
    {task.acceptance?.acceptedAt && <Alert type="success" title="已由用户确认验收通过"/>}
    <Flex gap="small" wrap>
      <WandButton disabled={busy} onClick={() => void onSave({ evidence, blocker, acceptedAt: null })}>保存交付与缺口</WandButton>
      <WandButton kind="primary" disabled={busy || !evidence.trim() || Boolean(blocker.trim()) || gaps.length > 0 || Boolean(task.acceptance?.acceptedAt)} onClick={() => void onSave({ evidence, blocker, acceptedAt: new Date().toISOString() })}>确认验收通过</WandButton>
    </Flex>
  </Flex>;
}
