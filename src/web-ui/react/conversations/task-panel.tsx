import * as React from "react";
import { Collapse, Drawer, Empty, Flex, Tag, Typography } from "antd";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "../../../ai-team-types.js";
import type { ConversationDetail, ConversationTarget } from "../../../conversation-types.js";
import { WandButton } from "../ui";
import { usePortalContainer } from "../ui/portal-context";
import { conversationTaskStateLabel } from "./presentation";

const runLabels: Record<string, string> = { running: "进行中", awaiting_approval: "等你批准计划", waiting_user: "等你回复", done: "已完成", failed: "失败", stopped: "已停止" };

/** Browsing history changes the reading filter only. Replying is a separate explicit action. */
export function ConversationTaskPanel({ detail, open, filter, onClose, onFilter, onReply, onContinue, onOpenSession }: {
  detail: ConversationDetail | null; open: boolean; filter: string; onClose(): void;
  onFilter(id: string): void; onReply(target: ConversationTarget): void; onContinue(id: string): void; onOpenSession(id: string): void;
}): React.ReactElement {
  const container = usePortalContainer();
  const pendingContinue = React.useRef<{ conversationId: string; taskId: string } | null>(null);
  return <Drawer title="群任务" open={open} onClose={onClose} getContainer={container ?? false}
    afterOpenChange={shown => {
      if (shown) return;
      const pending = pendingContinue.current; pendingContinue.current = null;
      // Release the Drawer focus lease before the composer options take focus.
      if (pending && pending.conversationId === detail?.id) onContinue(pending.taskId);
    }}
    size="min(480px, 100vw)" className="conversation-task-drawer" styles={{ body: { padding: 16, overflowX: "hidden" } }}>
    <Flex vertical gap={16} className="conversation-task-details">
      <Typography.Text type="secondary">{detail?.dissolvedAt ? "群聊已解散，当前仅查看消息与执行记录。" : "查看任务进度与执行记录；需要补充内容时，选择「回复此任务」。"}</Typography.Text>
      <WandButton onClick={() => { onFilter(""); onClose(); }}>查看全部消息</WandButton>
      {!detail?.tasks.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任务，先在群里聊聊。"/> : null}
      <Collapse defaultActiveKey={filter ? [filter] : undefined} items={detail?.tasks.map(entry => {
        const run = entry.runs[0];
        const active = entry.task.status !== "archived" && run && AI_TEAM_ACTIVE_RUN_STATUSES.includes(run.status);
        return { key: entry.task.id,
          label: <Flex vertical gap={4}><Typography.Text strong>{entry.task.title}</Typography.Text><span><Tag>{conversationTaskStateLabel(entry)}</Tag>{run ? `第 ${run.roundNumber ?? entry.runs.length} 轮` : ""}</span></Flex>,
          children: <Flex vertical gap={12} className="conversation-task-detail">
            {entry.task.description ? <Typography.Paragraph style={{ whiteSpace: "pre-wrap", maxHeight: 176, overflow: "auto", marginBottom: 0 }}>{entry.task.description}</Typography.Paragraph> : null}
            {entry.startup?.error ? <Typography.Text type="danger">启动失败：{entry.startup.error}。请继续此任务，无需重新派发。</Typography.Text> : null}
            <Flex gap={8} wrap>
              <WandButton onClick={() => { onFilter(entry.task.id); onClose(); }}>查看任务消息</WandButton>
              {active ? <WandButton kind="primary" disabled={!!detail.dissolvedAt} onClick={() => { onReply({ taskId: entry.task.id, runId: run.id }); onClose(); }}>回复此任务</WandButton>
                : <WandButton aria-label={`继续任务 ${entry.task.title}`} disabled={!!detail.dissolvedAt || entry.task.status === "archived"} onClick={() => {
                  pendingContinue.current = { conversationId: detail.id, taskId: entry.task.id }; onClose();
                }}>继续此任务</WandButton>}
            </Flex>
            {detail.runDetails.filter(value => value.run.taskId === entry.task.id).map(value => <Flex key={value.run.id} vertical gap={8}>
              <Typography.Text strong>第 {value.run.roundNumber ?? 1} 轮 · {runLabels[value.run.status] ?? value.run.status}</Typography.Text>
              {value.steps.map(step => <Flex key={step.id} vertical gap={4} className="conversation-task-step">
                <Typography.Text>{step.seq}. {step.title} · {runLabels[step.status] ?? step.status}</Typography.Text>
                {step.instructions ? <Typography.Paragraph type="secondary" ellipsis={{ rows: 3, expandable: "collapsible", symbol: expanded => expanded ? "收起" : "查看完整步骤" }} style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{step.instructions}</Typography.Paragraph> : null}
                {step.report ? <Typography.Paragraph ellipsis={{ rows: 3, expandable: "collapsible", symbol: expanded => expanded ? "收起" : "查看完整结果" }} style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{step.report}</Typography.Paragraph> : null}
                {step.sessionId ? <WandButton onClick={() => { onClose(); onOpenSession(step.sessionId!); }}>查看本轮执行窗口</WandButton> : null}
              </Flex>)}
            </Flex>)}
          </Flex> };
      })}/>
    </Flex>
  </Drawer>;
}
