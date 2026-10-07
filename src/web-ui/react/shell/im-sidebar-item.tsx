import { Badge, Flex, Typography } from "antd";
import { WandButton } from "../ui";
import * as React from "react";
import { classNames } from "../ui/class-names";
import type { GlowStatus, SidebarSessionState } from "../workspaces/sidebar-session-state";
import { sidebarGlowColor } from "../workspaces/sidebar-session-state";

export interface ImSidebarItemProps {
  id: string;
  avatarNode?: React.ReactNode;
  title: string;
  state: SidebarSessionState;
  glow?: GlowStatus;
  summary: string;
  active?: boolean;
  onClick(): void;
}

export function ImSidebarItem({
  id, avatarNode, title, state, glow, summary, active = false, onClick,
}: ImSidebarItemProps): React.ReactElement {
  const effectiveGlow = glow ?? (
    state.label === "运行中" ? "running"
      : state.label === "思考中" ? "thinking"
      : state.label === "刚完成" ? "just-completed"
      : state.tone === "warning" ? "permission"
      : state.label === "失败" ? "failed"
      : "none"
  );
  const descriptionId = React.useId();
  return (
    <WandButton kind={active ? "soft" : "ghost"} type="button" className={`session-item wand-sidebar-session-row${active ? " active" : ""}`}
      style={{ width: "100%", height: "auto", whiteSpace: "normal", justifyContent: "flex-start", padding: 8 }}
      data-session-id={id} aria-current={active ? "page" : undefined}
      aria-describedby={descriptionId} title={`${title} · ${summary}`} onClick={onClick}>
      <span
        className={classNames(
          "im-sidebar-item-avatar-wrap",
          effectiveGlow !== "none" && `wand-logo-glow glow-${effectiveGlow}`,
        )}
        style={{ width: 28, height: 28, display: "inline-flex", flexShrink: 0 }}
        data-glow={effectiveGlow}
        aria-hidden="true"
      >
        <Badge dot={effectiveGlow !== "none"} color={sidebarGlowColor(effectiveGlow)}>{avatarNode}</Badge>
      </span>
      <Flex vertical className="im-sidebar-item-body" style={{ minWidth: 0, textAlign: "start", flex: 1 }}>
        <Typography.Text ellipsis className="im-sidebar-item-name">{title}</Typography.Text>
        <Typography.Text ellipsis type="secondary" id={descriptionId} className="im-sidebar-item-summary" style={{ fontSize: 12 }}>{summary}</Typography.Text>
      </Flex>
    </WandButton>
  );
}
