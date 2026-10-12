import * as React from "react";
import { Badge, Flex, Typography } from "antd";
import { WandButton } from "../ui/index.js";
import { SidebarLabelTooltip } from "../workspaces/sidebar-label-tooltip";
import {
  SidebarChevron,
  SidebarDisclosure,
  anchorSidebarDisclosure,
  sidebarDisclosureKeys,
} from "../workspaces/sidebar-disclosure";

/** Fixed identity head, including one-session groups; independent action slot. */
export function ImSidebarGroup({
  label,
  count,
  totalCount = count,
  description,
  activity,
  containsCurrent = false,
  avatarNode,
  action,
  expanded = true,
  onToggle,
  onSetOpen,
  children,
}: {
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
  children: React.ReactNode;
}): React.ReactElement {
  const id = React.useId();
  const descriptionId = React.useId();
  return (
    <div className={`im-sidebar-group${expanded ? " is-expanded" : ""}`}>
      <Flex align="center" gap={4} className="im-sidebar-group-header">
        <SidebarLabelTooltip title={`${label} · ${description ?? `${totalCount} 个会话`}`} selector=".im-sidebar-group-title">
        <WandButton kind="ghost" type="button" className="wand-sidebar-group-toggle"
          style={{ flex: 1, minWidth: 0, height: "auto", justifyContent: "flex-start", whiteSpace: "normal" }}
          aria-expanded={expanded} aria-controls={id} aria-describedby={descriptionId}
          aria-label={`${label} · 显示 ${count} 个会话，共 ${totalCount} 个会话${containsCurrent ? " · 包含当前会话" : ""}`}
          title={`${label} · ${description ?? `${count} 个会话`}${containsCurrent ? " · 包含当前会话" : ""}`}
          onClick={(event) => anchorSidebarDisclosure(event.currentTarget, () => onToggle?.())}
          onKeyDown={(event) => sidebarDisclosureKeys(event, expanded,
            (open) => onSetOpen ? onSetOpen(open) : onToggle?.())}>
          <SidebarChevron open={expanded}/>
          <span className="im-sidebar-group-avatar" aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, flexShrink: 0 }}>{avatarNode}</span>
          <Typography.Text ellipsis className="im-sidebar-group-title" style={{ flex: 1, textAlign: "start" }}>{label}</Typography.Text>
          <span className="im-sidebar-group-meta">
            <Typography.Text type="secondary" className="im-sidebar-group-count" title={`显示 ${count} / 共 ${totalCount} 个会话`}>
              {count === totalCount ? count : `${count}/${totalCount}`}
            </Typography.Text>
            <span className={`im-sidebar-group-attention-slot tone-${activity?.tone ?? "muted"}`}
              title={activity?.label} aria-label={activity?.label || undefined}>
              {activity?.label ? <Badge status={activity.tone === "warning" ? "warning" : activity.tone === "success" ? "success" : "processing"}/> : null}
            </span>
          </span>
        </WandButton>
        </SidebarLabelTooltip>
        {action ? <span className="im-sidebar-group-action">{action}</span> : null}
      </Flex>
      <span id={descriptionId} className="sidebar-visually-hidden" hidden>
        {description}{containsCurrent ? "，包含当前会话" : ""}
      </span>
      <SidebarDisclosure id={id} open={expanded}>
        <div className="im-sidebar-group-inner" style={{ paddingInlineStart: 8 }}>{children}</div>
      </SidebarDisclosure>
    </div>
  );
}
