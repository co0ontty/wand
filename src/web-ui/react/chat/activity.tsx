import * as React from "react";
import { Button } from "antd";
import { ThoughtChain } from "@ant-design/x";
import { WandIcon } from "../ui";

export function ChatDisclosureChevron({ expanded }: { expanded: boolean }): React.ReactElement {
  return <span className="chat-disclosure-chevron" data-expanded={expanded} aria-hidden="true"><WandIcon name="chevronDown" size={13}/></span>;
}
export function ChatDisclosureBody({ expanded, children }: { expanded: boolean; children: React.ReactNode }): React.ReactElement {
  return <div className="chat-disclosure-body" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}><div>{children}</div></div>;
}

export function ChatActivity({ expanded, summary, children, onToggle }: {
  expanded: boolean; summary: React.ReactNode; children: React.ReactNode;
  onToggle(event: React.MouseEvent<HTMLButtonElement>): void;
}): React.ReactElement {
  return <div data-chat-activity-renderer="canonical">
    <Button type="text" block className="chat-process-summary" aria-expanded={expanded} onClick={onToggle}>
      {summary}<ChatDisclosureChevron expanded={expanded}/>
    </Button><ChatDisclosureBody expanded={expanded}>{children}</ChatDisclosureBody>
  </div>;
}

export function ChatActivityEntry({ expanded, status, label, stateLabel, clock, occurredAt, preview, result, tool = false, children, onToggle }: {
  expanded: boolean; status?: string; label: string; stateLabel: string; clock?: string; occurredAt?: string;
  preview?: string; result?: string; tool?: boolean; children: React.ReactNode;
  onToggle(event: React.MouseEvent<HTMLButtonElement>): void;
}): React.ReactElement {
  return <div data-chat-entry-renderer="canonical"><ThoughtChain line={false}
    styles={{ itemHeader: { padding: 0 }, itemIcon: { width: 12, minWidth: 12, marginInlineEnd: 8, alignSelf: "flex-start", marginTop: 14 }, itemContent: { marginTop: 0, marginBottom: 0, padding: 0, background: "transparent" } }}
    items={[{ key: "entry", icon: <span className="chat-call-mark" data-status={status} aria-hidden="true"/>,
      title: <Button type="text" block className="chat-call-button" aria-expanded={expanded} aria-label={`${label}，${stateLabel}`} onClick={onToggle}>
        <span className="chat-call-copy"><span className="chat-call-line">
          {clock ? <time className="chat-call-time" dateTime={occurredAt}>{clock}</time> : null}
          <span className="chat-call-label" title={label}>{label}</span></span>
          {tool || preview ? <span className="chat-call-preview" title={preview || undefined}>{preview}</span> : null}
          {tool ? <span className="chat-call-result" data-error={status === "error" ? "" : undefined} title={result || undefined}>{result}</span> : null}
        </span><ChatDisclosureChevron expanded={expanded}/>
      </Button>, content: <ChatDisclosureBody expanded={expanded}>{children}</ChatDisclosureBody>, collapsible: false }]}/></div>;
}
