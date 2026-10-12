import * as React from "react";
import { Avatar } from "antd";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { useUserProfile } from "../user-profile-repository";
import { conversationInitials } from "./presentation";

/** Every real member is represented; no synthetic roster or overflow counter. */
export function ConversationGroupAvatar({ title, members, size = 48 }: {
  title: string; size?: number; members: ReadonlyArray<{ id: string; employeeId?: string; name: string; avatar?: string }>;
}): React.ReactElement {
  const self = useUserProfile();
  const columns = Math.ceil(Math.sqrt(members.length + 1));
  const cell = (size - 4 - (columns - 1)) / columns;
  return <span className="conversation-group-avatar conversation-group-mosaic" role="img" aria-label={`群聊：${title}；${self.name || "我"}、${members.map(member => member.name).join("、")}`}
    style={{ width: size, height: size, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
    <span className="conversation-group-cell" aria-hidden="true"><Avatar shape="square" size={cell} src={self.avatar || undefined}>{conversationInitials(self.name || "我")}</Avatar></span>
    {members.map(member => <span className="conversation-group-cell" key={member.id} aria-hidden="true" title={member.name}>
      <span style={{ width: 36, height: 36, transform: `scale(${cell / 36})` }}><EmployeeAvatar employee={{ id: member.employeeId || member.id, name: member.name, avatar: member.avatar }} provider="" size="sm"/></span>
    </span>)}
  </span>;
}
