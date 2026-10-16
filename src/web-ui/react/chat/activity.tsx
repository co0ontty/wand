import * as React from "react";
import { WandIcon } from "../ui";
import type { WandIconName } from "../ui/icons.js";
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

export function ChatActivityEntry({ expanded, status, label, stateLabel, clock, occurredAt, preview, result, tool = false,
  icon = tool ? "wrench" : "brain", context, children, onToggle }: {
  expanded: boolean; status?: string; label: string; stateLabel: string; clock?: string; occurredAt?: string;
  icon?: WandIconName; context?: string; preview?: string; result?: string; tool?: boolean; children: React.ReactNode;
  onToggle(event: React.MouseEvent<HTMLButtonElement>): void;
}): React.ReactElement {
  const bodyId = React.useId();
  React.useInsertionEffect(installChatSurfaceStyles, []);
  return <div className="wand-chat-entry" data-chat-entry-renderer="canonical" data-status={status} data-tool={tool ? "true" : undefined}>
    <div className="wand-chat-entry-body">
      <button type="button" className="chat-disclosure-trigger chat-call-button" aria-expanded={expanded} aria-controls={bodyId} aria-label={`${label}，${stateLabel}`} onClick={onToggle}>
        <span className="chat-call-mark" data-status={status} aria-hidden="true"><WandIcon name={icon} size={16}/></span>
        <span className="chat-call-copy"><span className="chat-call-line">
          <span className="chat-call-label" title={label}>{label}</span>
          <span className="chat-call-state" data-status={status}>{stateLabel}</span></span>
          {preview ? <span className="chat-call-preview" title={preview}>{preview}</span> : null}
          {status === "error" && result ? <span className="chat-call-result" data-error="" title={result}>{result}</span> : null}
          {context || clock ? <span className="chat-call-meta">{context ? <span>{context}</span> : null}
            {clock ? <time className="chat-call-time" dateTime={occurredAt}>{clock}</time> : null}</span> : null}
        </span><ChatDisclosureChevron expanded={expanded}/>
      </button><ChatDisclosureBody id={bodyId} expanded={expanded}>{children}</ChatDisclosureBody>
    </div>
  </div>;
}
