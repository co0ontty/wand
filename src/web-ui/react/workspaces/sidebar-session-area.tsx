import * as React from "react";
import { installStyleSheet } from "../styles";
import { WandIconButton } from "../ui/button";
import { SidebarChevron, anchorSidebarDisclosure, sidebarDisclosureKeys } from "./sidebar-disclosure";

const styles = String.raw`
.sidebar-session-area { display:grid; grid-template-columns:24px minmax(0,1fr); align-items:start; min-width:0; }
/* 会话条高度不随晚到数据变化：还没有会话时也保留同一条预览带，
   否则任务目录到达后整列人物行会一起下移。 */
.sidebar-session-area[data-empty] { min-height:36px; }
.sidebar-session-area .sidebar-session-area-toggle.ant-btn { width:24px; min-width:24px; height:28px; padding:0; margin-block-start:2px; color:var(--text-secondary); }
.sidebar-session-area-content { min-width:0; }
.sidebar-session-area[data-inline-toggle] { display:block; padding-inline-start:18px; }
.sidebar-session-area-content > .sidebar-session-preview { margin-inline-start:0; }
.sidebar-session-area-content .conversation-person-sessions, .sidebar .sidebar-session-area-content .im-sidebar-group-inner { margin-inline-start:0; }
.sidebar .sidebar-session-area-content .workspace-task-sessions { margin-inline-start:0; }
@media (pointer:coarse), (max-width:640px) {
  .sidebar-session-area { grid-template-columns:36px minmax(0,1fr); }
  .sidebar-session-area[data-empty] { min-height:44px; }
  .sidebar-session-area .sidebar-session-area-toggle.ant-btn { width:32px; min-width:32px; height:44px; margin-block-start:0; }
}
`;

/** One stable disclosure control in the preview's left gutter, also reachable when the list is open. */
export function SidebarSessionArea({ id, open, label, toggleRef, toggleClassName = "", disabled = false, hasSessions = true, reserve = false, inlineToggle = false, onOpenChange, children }: {
  id: string;
  open: boolean;
  label: string;
  toggleRef?: React.Ref<HTMLButtonElement>;
  toggleClassName?: string;
  disabled?: boolean;
  hasSessions?: boolean;
  /** Keep the preview band's height before (or without) any session, so late directory data cannot move rows. */
  reserve?: boolean;
  /** Task rows host their disclosure inline; employee previews retain their gutter control. */
  inlineToggle?: boolean;
  onOpenChange(open: boolean): void;
  children: React.ReactNode;
}): React.ReactElement | null {
  React.useLayoutEffect(() => { installStyleSheet("wand-sidebar-session-area", styles); }, []);
  if (!hasSessions && !reserve) return null;
  return <div className="sidebar-session-area" data-empty={!hasSessions || undefined} data-inline-toggle={inlineToggle || undefined}>
    {hasSessions && !inlineToggle ? <WandIconButton ref={toggleRef} className={`sidebar-session-area-toggle ${toggleClassName}`} disabled={disabled}
      aria-label={`${open ? "收起" : "展开"}${label}的会话列表`} aria-expanded={open} aria-controls={id}
      onClick={event => { event.stopPropagation(); anchorSidebarDisclosure(event.currentTarget, () => onOpenChange(!open)); }}
      onKeyDown={event => sidebarDisclosureKeys(event, open, onOpenChange)}>
      <SidebarChevron open={open} size={14}/>
    </WandIconButton> : null}
    <div className="sidebar-session-area-content">{children}</div>
  </div>;
}
