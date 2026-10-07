import * as React from "react";
import { Avatar } from "antd";

import { GeneratedAvatarGlyph, generatedAvatarBackground, generatedAvatarFace } from "../ai-teams/avatar";
import { ProviderLogo } from "../provider-logo";
import { WandIcon } from "../ui";
import { workspaceSessionProvider } from "./session-order";
import type { WorkspaceSessionTeamChat } from "./types";

/** 任务下每个会话窗口的 CLI 标识：有 provider 用品牌 logo，空白终端用终端图标。 */
export function SessionProviderMark({
  session,
  className,
  size,
}: {
  session: { provider?: string; command?: string };
  className?: string;
  size?: number;
}): React.ReactElement {
  const provider = workspaceSessionProvider(session);
  if (!provider) {
    return <WandIcon name="terminal" size={size ?? 13} className={className}/>;
  }
  if (size === undefined) return <ProviderLogo provider={provider} className={className}/>;
  // Explicit sidebar sizes get a local slot; the default tab/window contract is unchanged.
  return <span className={className ? `sidebar-provider-mark ${className}` : "sidebar-provider-mark"}
    data-mark-size={size} title={provider} style={{ display: "inline-flex", width: size, height: size, fontSize: size, lineHeight: 0 }}>
    <ProviderLogo provider={provider}/>
  </span>;
}

/** 群聊条目的头像组标记：叠两张按 runId 生成的字形头，和普通会话的 CLI logo 区分。 */
export function TeamChatSessionMark({ teamChat }: { teamChat: WorkspaceSessionTeamChat }): React.ReactElement {
  const faces = Array.from(
    { length: Math.min(Math.max(teamChat.memberCount, 1), 2) },
    (_, index) => generatedAvatarFace({ id: `${teamChat.runId}#${index}`, name: teamChat.teamName }),
  );
  return <Avatar.Group className="workspace-session-team-cats" size={18}>
    {faces.map((face, index) => <Avatar key={index} shape="square" size={18}
      style={generatedAvatarBackground(face)} icon={<GeneratedAvatarGlyph face={face} size={18}/>}/>)}
  </Avatar.Group>;
}
