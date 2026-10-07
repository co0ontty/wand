import * as React from "react";
import { Card, Tag, Typography } from "antd";
import type { ConversationTurn } from "../../../types.js";
import { conversationTaskLiveText, conversationTaskPreviewLabels } from "../../../conversation-task-preview.js";
import { subscribeAiTeamStepLive } from "../ai-teams/repository";

/** One fixed viewport per accepted DM message; no second transcript or execution channel. */
export function ConversationTaskPreview({ turn, active, onOpen }: {
  turn: ConversationTurn; active: boolean; onOpen(): void;
}): React.ReactElement {
  const preview = turn.taskPreview;
  const card = React.useRef<HTMLDivElement>(null);
  const body = React.useRef<HTMLPreElement>(null);
  const following = React.useRef(true);
  const [visible, setVisible] = React.useState(false);
  const [live, setLive] = React.useState<{ runId: string; text: string } | null>(null);
  React.useEffect(() => {
    if (!card.current || !active) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [active]);
  React.useEffect(() => {
    // A fresh HTTP projection repairs a missed WS frame/reconnect; never pin stale live text forever.
    setLive(null);
    if (!active || !visible || preview?.status !== "running" || !preview.runId) return;
    return subscribeAiTeamStepLive(update => {
      if (update.runId !== preview.runId) return;
      const text = conversationTaskLiveText(update.steps);
      setLive(text ? { runId: update.runId, text } : null);
    });
  }, [active, visible, preview?.runId, preview?.status, preview?.text]);
  const text = preview?.status === "running" && live?.runId === preview.runId ? live.text
    : preview?.text || "任务已接收，点击查看处理进展。";
  React.useLayoutEffect(() => {
    if (body.current && following.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text]);
  const disabled = preview?.status === "unavailable";
  return <div ref={card} className="conversation-task-preview" data-task-id={turn.conversationLink?.taskId}
    role="link" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={`打开任务群 · ${turn.conversationLink?.title}`}
    style={{ width: "min(360px, 100%)", flexShrink: 0, cursor: disabled ? "default" : "pointer" }}
    onClick={() => { if (!disabled && !window.getSelection()?.toString()) onOpen(); }}
    onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); if (!disabled) onOpen(); } }}>
    <Card size="small" title={<Typography.Text ellipsis>{turn.conversationLink?.title}</Typography.Text>}
      extra={<Tag style={{ marginInlineEnd: 0 }} color={preview?.status === "failed" ? "error" : preview?.status === "done" ? "success" : "default"}>{conversationTaskPreviewLabels[preview?.status ?? "starting"]}</Tag>}
      styles={{ root: { height: 196 }, body: { height: 156, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" } }}>
      <pre ref={body} tabIndex={0} aria-label="任务实时进展" onScroll={event => {
        const element = event.currentTarget; following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }} style={{ flex: 1, minHeight: 0, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>{text}</pre>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{disabled ? "原消息已保留" : "点击进入任务群 · 查看完整过程"}</Typography.Text>
    </Card>
  </div>;
}
