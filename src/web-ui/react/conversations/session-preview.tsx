import * as React from "react";
import { ChatMessage } from "../chat/message";
import { Flex, Typography, theme } from "antd";
import type { ConversationTurn } from "../../../types.js";
import type { ConversationSessionUpdate } from "../../../conversation-types.js";
import { conversationSessionPreviewLabels } from "../../../conversation-session-preview.js";
import { MarkdownPreview } from "../file-preview/markdown.js";
import { WandButton, WandIcon } from "../ui/index.js";
import { executionFailure } from "./execution-failure.js";
import { subscribeConversationSessionPreview } from "./session-preview-events.js";

/** The transcript shares the conversation's reading scroller and keeps its live controls. */
export function ConversationSessionReply({ turn, active, onOpen, onModelSettings, statusProvided = false, children }: {
  turn: ConversationTurn; active: boolean; onOpen(): void; onModelSettings?(event: React.MouseEvent<HTMLButtonElement>): void;
  /** The exact source session already projects its current state in children. */
  statusProvided?: boolean; children?: React.ReactNode;
}): React.ReactElement {
  const { token } = theme.useToken();
  const [live, setLive] = React.useState<ConversationSessionUpdate | null>(null);
  const sessionId = turn.sessionLink!.sessionId;
  React.useEffect(() => {
    setLive(null);
    if (!active) return;
    return subscribeConversationSessionPreview(update => {
      if (update.sessionId === sessionId && update.conversationId === turn.conversationId) setLive(update);
    });
  }, [active, sessionId, turn.conversationId]);
  // HTTP detail is the reconnect/reload repair path; it must not be shadowed forever by an old WS frame.
  React.useEffect(() => { setLive(null); }, [turn.sessionPreview]);
  const preview = live?.sessionId === sessionId ? live.preview : turn.sessionPreview;
  const unavailable = preview?.status === "unavailable";
  const text = preview?.text || "消息已接收，正在启动独立会话。";
  const failure = preview?.status === "failed" ? executionFailure(text) : null;
  return <ChatMessage className="conversation-session-reply" data-session-id={sessionId} surface="preview"
    // Long replies use the conversation reading axis; code/table overflow stays local.
    styles={{ root: { width: "100%", minWidth: 0, flexShrink: 0 }, body: { width: "100%" },
      content: { boxSizing: "border-box", display: "flex", flexDirection: "column", gap: token.marginSM, background: "transparent", padding: 0 } }}
    content={<>
      <Typography.Text type="secondary" className="conversation-reply-context" ellipsis title={turn.sessionLink?.title}>{turn.sessionLink?.title}</Typography.Text>
      <div role="region" aria-label="会话实时回复" className="conversation-reply-body" style={{ minHeight: 0, overflowWrap: "anywhere" }}>
        {failure ? <div className="conversation-execution-failure">
          <Typography.Paragraph type="danger">{failure.summary}</Typography.Paragraph>
          <WandButton size="small" onClick={failure.action === "model" && onModelSettings ? onModelSettings : onOpen}>{failure.action === "model" && !onModelSettings ? "查看执行记录" : failure.actionLabel}</WandButton>
          <details><summary>错误详情</summary><pre>{text}</pre></details>
        </div> : <MarkdownPreview content={text} variant="inline" wrap fileContext={{ sessionId }}/ >}
      </div>
      {children ? <div className="conversation-session-actions">{children}</div> : null}
      <Flex align="center" gap={token.marginSM} className="conversation-reply-footer" style={{ flexShrink: 0 }}>
        {!statusProvided ? <Typography.Text role="status" type={preview?.status === "failed" ? "danger" : "secondary"}>
          {conversationSessionPreviewLabels[preview?.status ?? "starting"]}
        </Typography.Text> : null}
        <WandButton kind="ghost" size="small" disabled={unavailable} title="进入此工作的执行会话，补充指令会继续同一项工作" onClick={onOpen}>继续此工作 <WandIcon name="up" size={14} className="conversation-continue-arrow"/></WandButton>
      </Flex>
    </>}/>;
}
