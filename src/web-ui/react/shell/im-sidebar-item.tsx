import * as React from "react";
import { WandIcon } from "../ui/index.js";
import type { EmployeePresence } from "../agents/employee-presence.js";

export interface ImSidebarItemProps {
  id: string;
  avatarNode?: React.ReactNode;
  title: string;
  presence?: EmployeePresence;
  summary: string;
  time?: string;
  unreadCount?: number;
  active?: boolean;
  compact?: boolean;
  onClick(): void;
}

export function ImSidebarItem({
  id,
  avatarNode,
  title,
  presence,
  summary,
  time,
  unreadCount = 0,
  active = false,
  compact = false,
  onClick,
}: ImSidebarItemProps): React.ReactElement {
  const showChip = presence && presence.text !== "空闲" && presence.text !== "未开始";

  const itemCls = [
    "session-item",
    "im-sidebar-item",
    active ? "active" : "",
    compact ? "is-compact" : "",
  ].filter(Boolean).join(" ");

  const dotCls = presence ? [
    "im-sidebar-presence-dot",
    `tone-${presence.tone}`,
    presence.dotKind === "solid-spin" ? "is-spin" : "",
    presence.dotKind === "hollow" ? "is-hollow" : "",
  ].filter(Boolean).join(" ") : "";

  return (
    <button
      type="button"
      className={itemCls}
      data-session-id={id}
      title={`${title}${presence ? ` · ${presence.text}` : ""}`}
      onClick={onClick}
    >
      <div className="im-sidebar-item-avatar-wrap">
        {avatarNode}
        {presence ? <span className={dotCls} aria-hidden="true" /> : null}
      </div>

      {!compact ? (
        <div className="im-sidebar-item-body">
          <div className="im-sidebar-item-row-top">
            <span className="im-sidebar-item-name">{title}</span>
            {showChip ? (
              <span className={`im-sidebar-presence-chip tone-${presence.tone}`}>
                {presence.text}
              </span>
            ) : null}
            {time ? <span className="im-sidebar-item-time">{time}</span> : null}
          </div>
          <div className="im-sidebar-item-row-bottom">
            <span className="im-sidebar-item-summary">{summary || "暂无消息"}</span>
            {unreadCount > 0 ? (
              <span className="im-sidebar-unread-badge">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </button>
  );
}
