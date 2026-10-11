import * as React from "react";
import { ChatMessage } from "../chat/message";
import { Flex, Typography, theme } from "antd";
import type { ConversationTurn } from "../../../types.js";
import type { ConversationSessionUpdate } from "../../../conversation-types.js";
import { conversationSessionPreviewLabels } from "../../../conversation-session-preview.js";
import { MarkdownPreview } from "../file-preview/markdown.js";
import { WandButton } from "../ui/index.js";
import { CONVERSATION_TAIL_PX } from "./presentation.js";
import { executionFailure } from "./execution-failure.js";

const listeners = new Set<(update: ConversationSessionUpdate) => void>();
export function notifyConversationSessionPreview(update: ConversationSessionUpdate): void {
  for (const listener of listeners) listener(update);
}

/** A bounded transcript with its own live controls, not an embedded session page or task container. */
export function ConversationSessionReply({ turn, active, onOpen, onModelSettings, children }: {
  turn: ConversationTurn; active: boolean; onOpen(): void; onModelSettings?(event: React.MouseEvent<HTMLButtonElement>): void; children?: React.ReactNode;
}): React.ReactElement {
  const { token } = theme.useToken();
  const [live, setLive] = React.useState<ConversationSessionUpdate | null>(null);
  const body = React.useRef<HTMLDivElement>(null);
  // 跟底判据用「上一帧的真实几何 + 当前滚动位置」算，不信一个独立的布尔 ref：
  // 滚动事件是异步送达的，用户（或测试）刚把视图拉到顶部、事件还没到就把新内容写进来时，
  // 只靠 ref 会把读者拽回底部。位置变小 = 有人主动往上翻，一帧内就能识别。
  const geometry = React.useRef({ scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
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
  const failure = preview?.status === "failed" ? executionFailure(text) : null;
  React.useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const previous = geometry.current;
    const distanceToTail = previous.scrollHeight - previous.scrollTop - previous.clientHeight;
    const readerStayed = element.scrollTop >= previous.scrollTop - 1;
    if (readerStayed && distanceToTail <= CONVERSATION_TAIL_PX) element.scrollTop = element.scrollHeight;
    geometry.current = { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop };
  }, [text]);
  return <ChatMessage className="conversation-session-reply" data-session-id={sessionId} surface="preview"
    // IM 层的回复是「装着这条会话转录的气泡」：宽度按聊天气泡收口（不铺满整页），
    // 内容按转录自然增长，只有超过上限才在气泡内部滚动。
    styles={{ root: { width: "min(100%, 620px)", minWidth: 0, flexShrink: 0 }, body: { width: "100%" },
      content: { boxSizing: "border-box", display: "flex", flexDirection: "column", gap: token.marginXS } }}
    content={<>
      <Typography.Text strong ellipsis title={turn.sessionLink?.title}>{turn.sessionLink?.title}</Typography.Text>
      <div ref={body} role="region" tabIndex={0} aria-label="会话实时回复" style={{ minHeight: 0, maxHeight: "min(60dvh, 520px)", overflow: "auto", overflowWrap: "anywhere" }}
        onScroll={event => { const el = event.currentTarget; geometry.current = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop }; }}>
        {failure ? <div className="conversation-execution-failure">
          <Typography.Paragraph type="danger">{failure.summary}</Typography.Paragraph>
          <WandButton size="small" onClick={failure.action === "model" && onModelSettings ? onModelSettings : onOpen}>{failure.action === "model" && !onModelSettings ? "查看执行记录" : failure.actionLabel}</WandButton>
          <details><summary>错误详情</summary><pre>{text}</pre></details>
        </div> : <MarkdownPreview content={text} variant="inline" wrap fileContext={{ sessionId }}/ >}
      </div>
      {children ? <div className="conversation-session-actions">{children}</div> : null}
      <Flex justify="space-between" align="center" gap={token.marginXS} style={{ flexShrink: 0 }}>
        <Typography.Text role="status" type={preview?.status === "failed" ? "danger" : "secondary"}>
          {conversationSessionPreviewLabels[preview?.status ?? "starting"]}
        </Typography.Text>
        <WandButton size="small" disabled={unavailable} title="进入此工作的执行会话，补充指令会继续同一项工作" onClick={onOpen}>继续此工作</WandButton>
      </Flex>
    </>}/>;
}
