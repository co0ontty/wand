import * as React from "react";
import { Flex, Tag, Typography } from "antd";
import type { WandTaskComment } from "../../../task-types";
import { DeferredMarkdownPreview } from "../file-preview/deferred-markdown";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { statusLabel, statusTones } from "../../../task-comment-status.js";
import { TaskReferenceText } from "./task-stream-row.js";

/**
 * 员工执行卡片。
 *
 * 结构与任务面板里的其他卡片一致：头（身份 + 状态 + 度量）、体（任务 / 回复两行）、
 * 展开的动作明细。度量只来自真实数据：动作数来自本轮结果里的工具调用计数，
 * 耗时来自本轮结果的真实时间戳；拿不到就��写，不猜。
 */

export interface TaskExecutionCardResult {
  messages: Array<{ role: string; content: Array<{ type: string; name?: string; text?: string }> }>;
  outcome: string;
  loading: boolean;
  failed?: boolean;
  retryOffset?: number;
  unavailable?: string;
}

/** 动作明细：按工具名统计本轮工具调用次数。 */
export function taskExecutionActionBreakdown(result: TaskExecutionCardResult | undefined): { counts: Array<[string, number]>; total: number; thinking: number; replies: number } {
  const counts = new Map<string, number>();
  let thinking = 0;
  let replies = 0;
  for (const turn of result?.messages ?? []) {
    for (const block of turn.content ?? []) {
      if (block.type === "tool_use" && block.name) counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
      if (block.type === "thinking") thinking += 1;
    }
    if (turn.role === "assistant" && turn.content.some(block => block.type === "text" && block.text?.trim())) replies += 1;
  }
  return { counts: [...counts.entries()].sort((a, b) => b[1] - a[1]), total: [...counts.values()].reduce((sum, value) => sum + value, 0), thinking, replies };
}

/** 本轮耗时：从本轮第一条消息到���后一条消息；没有真实时间戳就不给数字。 */
export function taskExecutionElapsed(result: TaskExecutionCardResult | undefined): string | null {
  const stamps = (result?.messages ?? [])
    .flatMap(turn => (turn as { createdAt?: string; completedAt?: string }).createdAt ? [String((turn as { createdAt?: string }).createdAt)] : [])
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value));
  if (stamps.length < 2) return null;
  const seconds = Math.max(0, Math.round((stamps[stamps.length - 1]! - stamps[0]!) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const statusTone = statusTones;

export function TaskExecutionCard({ comment, result, onOpenSession, onLocateComment, onLoadResult, onOpenTask }: {
  comment: WandTaskComment;
  result?: TaskExecutionCardResult;
  onOpenSession?(id: string): void;
  onLocateComment?(): void;
  onLoadResult?(commentId: string, offset?: number): void;
  onOpenTask?(identifier: string): void;
}): React.ReactElement {
  const dispatch = comment.dispatch!;
  const [open, setOpen] = React.useState(false);
  const status = dispatch.status ?? dispatch.state ?? "unknown";
  const breakdown = taskExecutionActionBreakdown(result);
  const elapsed = taskExecutionElapsed(result);
  const delivered = dispatch.state === "accepted" || dispatch.state === "pending";
  const queued = dispatch.state === "queued";
  const replyText = result?.messages
    .filter(turn => turn.role === "assistant")
    .flatMap(turn => turn.content.filter(block => block.type === "text").map(block => block.text ?? ""))
    .join("\n\n")
    .trim();
  return <section className="task-execution-card" aria-label={`${dispatch.employeeName} 的执行`}>
    <header className="task-execution-card-head">
      <EmployeeAvatar employee={{ id: dispatch.employeeId, name: dispatch.employeeName }} size="sm" className="task-execution-card-avatar"/>
      <span className="task-execution-card-name">{dispatch.employeeName}</span>
      <Tag color={statusTone[status] ?? "default"}>{statusLabel(status)}</Tag>
      <div className="task-execution-card-meta">
        {breakdown.total > 0 ? <button type="button" className="task-execution-card-actions-toggle" aria-expanded={open}
          onClick={() => setOpen(value => !value)}>{breakdown.total} 个动作</button> : null}
        {delivered ? <span className="task-execution-card-delivered">▷ 已送达</span> : null}
        {elapsed ? <span className="task-execution-card-elapsed">{elapsed}</span> : null}
      </div>
    </header>
    <div className="task-execution-card-body">
      <div className="task-execution-card-row">
        <span className="task-execution-card-node" data-status={status}/>
        <div className="task-execution-card-text">
          <span className="task-execution-card-tag">任务</span>
          <DeferredMarkdownPreview content={comment.body} variant="inline" wrap renderText={value => <TaskReferenceText text={value} onOpenTask={onOpenTask}/>}/>
        </div>
      </div>
      <div className="task-execution-card-row">
        <span className="task-execution-card-node" data-status={status}/>
        <div className="task-execution-card-text">
          <span className="task-execution-card-tag is-reply">回复</span>
          {replyText
            ? <DeferredMarkdownPreview content={replyText} variant="inline" wrap/>
            : dispatch.state === "paused" ? <Typography.Text type="secondary">已暂停，指令已保留；不会自动开始。</Typography.Text>
              : queued ? <Typography.Text type="secondary">排队中，前序任务结束后会自动开始。</Typography.Text>
              : <Typography.Text type="secondary">{result?.loading ? "正在读取本轮结果…" : result?.unavailable === "still_running" ? "本轮执行仍在进行，完成后可读取结果。" : "本轮结果尚未读取。"}</Typography.Text>}
        </div>
      </div>
    </div>
    <Flex wrap gap="small" align="center" className="task-execution-card-actions">
      {dispatch.error && <Typography.Text type="warning">{dispatch.error}</Typography.Text>}
      {onLocateComment && <WandButton size="small" kind="ghost" onClick={onLocateComment}>定位原评论</WandButton>}
      {dispatch.sessionId && <WandButton size="small" kind="ghost" onClick={() => onOpenSession?.(dispatch.sessionId!)}>查看本次执行</WandButton>}
      {dispatch.resultAnchor && <WandButton size="small" kind="ghost" disabled={result?.loading}
        onClick={() => onLoadResult?.(comment.id, 0)}>{result?.messages.length ? "刷新本轮结果" : "查看本轮结果"}</WandButton>}
      <TaskExecutionReferences comment={comment} onOpenTask={onOpenTask}/>
    </Flex>
    {open && breakdown.total > 0 ? <div className="task-execution-card-detail">
      <div className="task-execution-card-detail-head">动作明细 · {breakdown.total} 个动作 / {breakdown.thinking} 段思考 / {breakdown.replies} 段回复</div>
      <ul className="task-execution-card-tool-list">
        {breakdown.counts.map(([name, count]) => <li key={name}><span className="task-execution-card-tool-name">{name}</span><span className="task-execution-card-tool-count">×{count}</span></li>)}
      </ul>
    </div> : null}
  </section>;
}

/** 引用目标提示：评论里引用了哪些子任务（用编号展示，编号才是用户写进正文的句柄）。 */
export function TaskExecutionReferences({ comment, onOpenTask }: { comment: WandTaskComment; onOpenTask?(identifier: string): void }): React.ReactElement | null {
  const identifiers = comment.referencedTaskIdentifiers ?? [];
  if (!identifiers.length) return null;
  return <Flex align="center" gap={6} wrap className="task-execution-card-references">
    <Typography.Text type="secondary" style={{ fontSize: "var(--font-size-xs)" }}>目标</Typography.Text>
    {identifiers.map(identifier => <button type="button" key={identifier} className="task-comment-reference-token"
      onClick={() => onOpenTask?.(identifier)}>#{identifier}</button>)}
  </Flex>;
}
