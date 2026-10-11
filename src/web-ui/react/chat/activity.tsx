import * as React from "react";
import { WandIcon } from "../ui";
import { installChatSurfaceStyles } from "./styles";

export function ChatDisclosureChevron({ expanded }: { expanded: boolean }): React.ReactElement {
  return <span className="chat-disclosure-chevron" data-expanded={expanded} aria-hidden="true"><WandIcon name="chevronDown" size={13}/></span>;
}
export function ChatDisclosureBody({ expanded, children, id }: { expanded: boolean; children: React.ReactNode; id?: string }): React.ReactElement {
  return <div id={id} className="chat-disclosure-body" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}><div>{children}</div></div>;
}

export function ChatActivity({ expanded, summary, children, onToggle, className }: {
  expanded: boolean; summary: React.ReactNode; children: React.ReactNode; className?: string;
  onToggle(event: React.MouseEvent<HTMLButtonElement>): void;
}): React.ReactElement {
  const bodyId = React.useId();
  React.useInsertionEffect(installChatSurfaceStyles, []);
  return <div className={className} data-chat-activity-renderer="canonical">
    <button type="button" className="chat-disclosure-trigger chat-process-summary" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
      {summary}<ChatDisclosureChevron expanded={expanded}/>
    </button><ChatDisclosureBody id={bodyId} expanded={expanded}>{children}</ChatDisclosureBody>
  </div>;
}

export function ChatActivityEntry({ expanded, status, label, stateLabel, clock, occurredAt, preview, result, tool = false, children, onToggle }: {
  expanded: boolean; status?: string; label: string; stateLabel: string; clock?: string; occurredAt?: string;
  preview?: string; result?: string; tool?: boolean; children: React.ReactNode;
  onToggle(event: React.MouseEvent<HTMLButtonElement>): void;
}): React.ReactElement {
  const bodyId = React.useId();
  React.useInsertionEffect(installChatSurfaceStyles, []);
  return <div className="wand-chat-entry" data-chat-entry-renderer="canonical">
    <span className="chat-call-mark" data-status={status} aria-hidden="true"/>
    <div className="wand-chat-entry-body">
      <button type="button" className="chat-disclosure-trigger chat-call-button" aria-expanded={expanded} aria-controls={bodyId} aria-label={`${label}，${stateLabel}`} onClick={onToggle}>
        <span className="chat-call-copy"><span className="chat-call-line">
          {clock ? <time className="chat-call-time" dateTime={occurredAt}>{clock}</time> : null}
          <span className="chat-call-label" title={label}>{label}</span></span>
          {tool || preview ? <span className="chat-call-preview" title={preview || undefined}>{preview}</span> : null}
          {tool ? <span className="chat-call-result" data-error={status === "error" ? "" : undefined} title={result || undefined}>{result}</span> : null}
        </span><ChatDisclosureChevron expanded={expanded}/>
      </button><ChatDisclosureBody id={bodyId} expanded={expanded}>{children}</ChatDisclosureBody>
    </div>
  </div>;
}
