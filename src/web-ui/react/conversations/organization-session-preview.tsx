import * as React from "react";
import { Alert, Flex, Skeleton, Typography } from "antd";
import type { ConversationTurn } from "../../../types";
import { requestJson } from "../http-adapter";
import { WandDialogSurface } from "../ui/dialog";
import { WandButton } from "../ui";
import { MarkdownPreview } from "../file-preview/markdown";

export function OrganizationSessionPreview({ id, title, onClose }: { id: string; title: string; onClose(): void }) {
  const [messages, setMessages] = React.useState<ConversationTurn[] | null>(null), [error, setError] = React.useState("");
  const [truncated, setTruncated] = React.useState(false);
  React.useEffect(() => {
    const abort = new AbortController();
    void requestJson<{ messages: ConversationTurn[]; messageOffset?: number }>(`/api/sessions/${encodeURIComponent(id)}?format=chat&blockBudget=80&byteBudget=196608&output=omit`, { signal: abort.signal, headers: { "X-Wand-Tool-Projection": "compact" } }).then(value => {
      if (!abort.signal.aborted) { setMessages(value.messages ?? []); setTruncated((value.messageOffset ?? 0) > 0); }
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取原会话。"); });
    return () => abort.abort();
  }, [id]);
  const readable = messages?.map(turn => ({ turn, text: turn.content?.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n").trim() ?? "" })).filter(item => item.text);
  return <WandDialogSurface open title={title} description="原会话正文 · 只读预览" width={680} popupOwner="organization-source" onOpenChange={open => { if (!open) onClose(); }}>
    <Flex vertical gap={16}>
      {error ? <Alert type="error" title={error}/> : !messages ? <Skeleton active/> : null}
      {truncated ? <Typography.Text type="secondary">这里只显示最近一段正文，完整历史可从侧栏原会话查看。</Typography.Text> : null}
      {readable?.map(({ turn, text }, index) => {
        return text ? <div key={turn.messageId ?? index}><Typography.Text strong>{turn.role === "user" ? "用户" : "助手"}</Typography.Text><MarkdownPreview content={text} variant="inline" wrap fileContext={{ sessionId: id }}/></div> : null;
      })}
      {readable && !readable.length ? <Typography.Text type="secondary">没有可读取的正文，请保留待确认。</Typography.Text> : null}
      <WandButton onClick={onClose}>返回整理建议</WandButton>
    </Flex>
  </WandDialogSurface>;
}
