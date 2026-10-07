import * as React from "react";
import { Badge, Flex, Typography } from "antd";
import { WandButton } from "../ui/index.js";
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
        <WandButton kind="ghost" type="button" className="wand-sidebar-group-toggle"
          style={{ flex: 1, minWidth: 0, height: "auto", justifyContent: "flex-start", whiteSpace: "normal" }}
          aria-expanded={expanded} aria-controls={id} aria-describedby={descriptionId}
          title={`${label} · ${description ?? `${count} 个会话`}${containsCurrent ? " · 包含当前会话" : ""}`}
          onClick={(event) => anchorSidebarDisclosure(event.currentTarget, () => onToggle?.())}
          onKeyDown={(event) => sidebarDisclosureKeys(event, expanded,
            (open) => onSetOpen ? onSetOpen(open) : onToggle?.())}>
          <SidebarChevron open={expanded}/>
          <span className="im-sidebar-group-avatar" aria-hidden="true" style={{ display: "inline-flex", width: 20, height: 20, flexShrink: 0 }}>{avatarNode}</span>
          <Typography.Text ellipsis className="im-sidebar-group-title" style={{ flex: 1, textAlign: "start" }}>{label}</Typography.Text>
          <span className="im-sidebar-group-meta">
            <Badge count={count} color="var(--text-tertiary)"/>
            <span className={`im-sidebar-group-attention-slot tone-${activity?.tone ?? "muted"}`}
              title={activity?.label} aria-label={activity?.label || undefined}>
              {activity?.label ? <Badge status={activity.tone === "danger" ? "error" : "warning"}/> : null}
            </span>
          </span>
        </WandButton>
        <span className="im-sidebar-group-action">{action}</span>
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
