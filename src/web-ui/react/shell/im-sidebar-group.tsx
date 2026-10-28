import * as React from "react";
import { Badge, Flex, Typography } from "antd";
import { WandButton } from "../ui/button.js";
import { SidebarLabelTooltip } from "../workspaces/sidebar-label-tooltip";
import { SidebarSessionArea, SidebarSessionToggle } from "../workspaces/sidebar-session-area";
import { SidebarChevron, SidebarDisclosure, anchorSidebarDisclosure, sidebarDisclosureKeys } from "../workspaces/sidebar-disclosure";

/** Identity navigation and child disclosure are independent when a session preview is present. */
export function ImSidebarGroup({ label, count, totalCount = count, description, activity, containsCurrent = false,
  avatarNode, action, expanded = true, onToggle, onSetOpen, onActivate, toggleRef, collapsedPreview, children }: {
  label: string;
  count: number;
  totalCount?: number;
  description?: string;
  activity?: { label: string; tone: string };
  containsCurrent?: boolean;
  avatarNode?: React.ReactNode;
  action?: React.ReactNode;
  expanded?: boolean;
  onToggle?(): void;
  onSetOpen?(open: boolean): void;
  onActivate?(): void;
  toggleRef?: React.Ref<HTMLButtonElement>;
  collapsedPreview?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const id = React.useId();
  const descriptionId = React.useId();
  const withPreview = collapsedPreview !== undefined;
  const setOpen = (open: boolean): void => { if (onSetOpen) onSetOpen(open); else if (open !== expanded) onToggle?.(); };
  const content = <SidebarDisclosure id={id} open={expanded}>
    <div className="im-sidebar-group-inner" style={{ paddingInlineStart: 4 }}>{children}</div>
  </SidebarDisclosure>;
  return <div className={`im-sidebar-group${expanded ? " is-expanded" : ""}`} onKeyDown={event => {
    if (event.key !== "Escape" || event.defaultPrevented || !expanded || (!onSetOpen && !onToggle)
      || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault(); event.stopPropagation();
    const trigger = event.currentTarget.querySelector<HTMLElement>(withPreview ? ".sidebar-session-area-toggle" : ".wand-sidebar-group-toggle");
    trigger?.focus({ preventScroll: true });
    if (trigger) anchorSidebarDisclosure(trigger, () => setOpen(false));
  }}>
    <Flex align="center" gap={4} className="im-sidebar-group-header">
      <SidebarLabelTooltip title={`${label} · ${description ?? `${totalCount} 个会话`}`} selector=".im-sidebar-group-title">
        <WandButton ref={withPreview ? undefined : toggleRef} kind="ghost" type="button" className="wand-sidebar-group-toggle"
          style={{ flex: 1, minWidth: 0, height: "auto", justifyContent: "flex-start", whiteSpace: "normal" }}
          aria-expanded={onActivate ? undefined : expanded} aria-controls={onActivate ? undefined : id} aria-describedby={descriptionId}
          aria-label={onActivate ? `打开${label}的对话` : `${label} · 显示 ${count} 个会话，共 ${totalCount} 个会话${containsCurrent ? " · 包含当前会话" : ""}`}
          title={`${label} · ${description ?? `${count} 个会话`}${containsCurrent ? " · 包含当前会话" : ""}`}
          onClick={event => onActivate ? onActivate() : anchorSidebarDisclosure(event.currentTarget, () => setOpen(!expanded))}
          onKeyDown={onActivate ? undefined : event => sidebarDisclosureKeys(event, expanded, setOpen)}>
          {!withPreview ? <SidebarChevron open={expanded}/> : null}
          <span className="im-sidebar-group-avatar" aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, flexShrink: 0 }}>{avatarNode}</span>
          <Typography.Text ellipsis className="im-sidebar-group-title" style={{ flex: 1, textAlign: "start" }}>{label}</Typography.Text>
          <span className="im-sidebar-group-meta">
            <Typography.Text type="secondary" className="im-sidebar-group-count" title={`显示 ${count} / 共 ${totalCount} 个会话`}>{count === totalCount ? count : `${count}/${totalCount}`}</Typography.Text>
            <span className={`im-sidebar-group-attention-slot tone-${activity?.tone ?? "muted"}`} title={activity?.label} aria-label={activity?.label || undefined}>
              {activity?.label ? <Badge status={activity.tone === "warning" ? "warning" : activity.tone === "success" ? "success" : "processing"}/> : null}
            </span>
          </span>
        </WandButton>
      </SidebarLabelTooltip>
      {withPreview && count > 0 ? <SidebarSessionToggle id={id} open={expanded} label={label}
        toggleRef={toggleRef} onOpenChange={setOpen}/> : null}
      {action ? <span className="im-sidebar-group-action">{action}</span> : null}
    </Flex>
    <span id={descriptionId} className="sidebar-visually-hidden" hidden>{description}{containsCurrent ? "，包含当前会话" : ""}</span>
    {withPreview ? <SidebarSessionArea hasSessions={count > 0}>
      {collapsedPreview}{content}
    </SidebarSessionArea> : content}
  </div>;
}
