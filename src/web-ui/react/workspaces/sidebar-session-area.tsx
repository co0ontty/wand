import * as React from "react";
import { installStyleSheet } from "../styles";
import { WandIconButton } from "../ui/button";
import { SidebarChevron, anchorSidebarDisclosure, sidebarDisclosureKeys } from "./sidebar-disclosure";

const styles = String.raw`
.sidebar-session-area { min-width:0; padding-inline-start:12px; }
/* Reserve the preview band while directory data is loading, without a separate disclosure column. */
.sidebar-session-area[data-empty] { min-height:36px; }
.sidebar-session-area-toggle.ant-btn { width:24px; min-width:24px; height:32px; padding:0; flex-shrink:0; color:var(--text-secondary); }
.sidebar-session-area-content { min-width:0; }
.sidebar-session-area-content > .sidebar-session-preview { margin-inline-start:0; }
.sidebar-session-area-content .conversation-person-sessions, .sidebar .sidebar-session-area-content .im-sidebar-group-inner { margin-inline-start:0; }
.sidebar .sidebar-session-area-content .workspace-task-sessions { margin-inline-start:0; }
@media (pointer:coarse), (max-width:640px) {
  .sidebar-session-area[data-empty] { min-height:44px; }
  .sidebar-session-area-toggle.ant-btn { width:44px; min-width:44px; height:44px; }
}
`;

/** The header owns disclosure; the child list never reserves an entire column for its arrow. */
export function SidebarSessionToggle({ id, open, label, toggleRef, className = "", disabled = false, onOpenChange }: {
  id: string;
  open: boolean;
  label: string;
  toggleRef?: React.Ref<HTMLButtonElement>;
  className?: string;
  disabled?: boolean;
  onOpenChange(open: boolean): void;
}): React.ReactElement {
  React.useLayoutEffect(() => { installStyleSheet("wand-sidebar-session-area", styles); }, []);
  return <WandIconButton ref={toggleRef} className={`sidebar-session-area-toggle ${className}`} disabled={disabled}
    aria-label={`${open ? "收起" : "展开"}${label}的会话列表`} aria-expanded={open} aria-controls={id}
    onClick={event => { event.stopPropagation(); anchorSidebarDisclosure(event.currentTarget, () => onOpenChange(!open)); }}
    onKeyDown={event => sidebarDisclosureKeys(event, open, onOpenChange)}>
    <SidebarChevron open={open} size={14}/>
  </WandIconButton>;
}

export function SidebarSessionArea({ hasSessions = true, reserve = false, children }: {
  hasSessions?: boolean;
  /** Keep the preview band's height before (or without) any session, so late directory data cannot move rows. */
  reserve?: boolean;
  children: React.ReactNode;
}): React.ReactElement | null {
  React.useLayoutEffect(() => { installStyleSheet("wand-sidebar-session-area", styles); }, []);
  if (!hasSessions && !reserve) return null;
  return <div className="sidebar-session-area" data-empty={!hasSessions || undefined}>
    <div className="sidebar-session-area-content">{children}</div>
  </div>;
}
