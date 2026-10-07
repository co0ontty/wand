import * as React from "react";
import { Avatar } from "antd";
import { WandIcon } from "../ui";
import { conversationInitials } from "./presentation";

/** A group has its own identity; changing its roster must not change its logo. */
export function ConversationGroupAvatar({ title, size = 48 }: { title: string; size?: number }): React.ReactElement {
  return <span className="conversation-group-avatar" aria-label={`群聊：${title}`}>
    <Avatar size={size} className="conversation-group-monogram">{conversationInitials(title)}</Avatar>
    <span className="conversation-group-mark" aria-hidden="true"><WandIcon name="parallel" size={12}/></span>
  </span>;
}
