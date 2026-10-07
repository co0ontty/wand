import * as React from "react";
import { Bubble } from "@ant-design/x";
import { Flex, Typography, theme } from "antd";
import type { ConversationTurn } from "../../../types.js";
import type { ConversationSessionUpdate } from "../../../conversation-types.js";
import { conversationSessionPreviewLabels } from "../../../conversation-session-preview.js";
import { MarkdownPreview } from "../file-preview/markdown.js";
import { WandButton } from "../ui/index.js";
import { CONVERSATION_TAIL_PX } from "./presentation.js";

const listeners = new Set<(update: ConversationSessionUpdate) => void>();
export function notifyConversationSessionPreview(update: ConversationSessionUpdate): void {
  for (const listener of listeners) listener(update);
}

/** A fixed message viewport, not an embedded session page or a task/group container. */
export function ConversationSessionReply({ turn, active, onOpen, children }: {
  turn: ConversationTurn; active: boolean; onOpen(): void; children?: React.ReactNode;
}): React.ReactElement {
  const { token } = theme.useToken();
  const [live, setLive] = React.useState<ConversationSessionUpdate | null>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  const sessionId = turn.sessionLink!.sessionId;
  React.useEffect(() => {
    setLive(null);
    if (!active) return;
    const listener = (update: ConversationSessionUpdate): void => {
      if (update.sessionId === sessionId && update.conversationId === turn.conversationId) setLive(update);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [active, sessionId, turn.conversationId]);
  // HTTP detail is the reconnect/reload repair path; it must not be shadowed forever by an old WS frame.
  React.useEffect(() => { setLive(null); }, [turn.sessionPreview]);
  const preview = live?.sessionId === sessionId ? live.preview : turn.sessionPreview;
  const unavailable = preview?.status === "unavailable";
  const text = preview?.text || "消息已接收，正在启动独立会话。";
  React.useLayoutEffect(() => {
    if (body.current && following.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text]);
  return <Bubble className="conversation-session-reply" data-session-id={sessionId} placement="start" variant="filled"
    styles={{ root: { width: "min(420px, 100%)", flexShrink: 0 }, body: { width: "100%" },
      content: { height: 232, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: token.marginXS, overflow: "hidden" } }}
    content={<>
      <Typography.Text strong ellipsis title={turn.sessionLink?.title}>{turn.sessionLink?.title}</Typography.Text>
      <div ref={body} role="region" tabIndex={0} aria-label="会话实时回复" style={{ flex: 1, minHeight: 0, overflow: "auto", overflowWrap: "anywhere" }}
        onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= CONVERSATION_TAIL_PX; }}>
        <MarkdownPreview content={text} variant="inline" wrap/>{children}
      </div>
      <Flex justify="space-between" align="center" gap={token.marginXS} style={{ flexShrink: 0 }}>
        <Typography.Text role="status" type={preview?.status === "failed" ? "danger" : "secondary"}>
          {conversationSessionPreviewLabels[preview?.status ?? "starting"]}
        </Typography.Text>
        <WandButton size="small" disabled={unavailable} onClick={onOpen}>查看会话</WandButton>
      </Flex>
    </>}/>;
}
