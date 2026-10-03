import * as React from "react";

import { memberCoatIndex, PixelCat } from "../ai-teams/avatar";
import { ProviderLogo } from "../provider-logo";
import { WandIcon } from "../ui";
import { workspaceSessionProvider } from "./session-order";
import type { WorkspaceSessionTeamChat } from "./types";

/** 任务下每个会话窗口的 CLI 标识：有 provider 用品牌 logo，空白终端用终端图标。 */
export function SessionProviderMark({
  session,
  className,
  size = 13,
}: {
  session: { provider?: string; command?: string };
  className?: string;
  size?: number;
}): React.ReactElement {
  const provider = workspaceSessionProvider(session);
  if (!provider) {
    return <WandIcon name="terminal" size={size} className={className}/>;
  }
  return <ProviderLogo provider={provider} className={className}/>;
}

/** 群聊条目的头像组标记：叠两隻像素猫，毛色按 runId 散列，和普通会话的 CLI logo 区分。 */
export function TeamChatSessionMark({ teamChat }: { teamChat: WorkspaceSessionTeamChat }): React.ReactElement {
  const coats = Array.from(
    { length: Math.min(Math.max(teamChat.memberCount, 1), 2) },
    (_, index) => memberCoatIndex({ id: `${teamChat.runId}#${index}`, name: teamChat.teamName, avatar: "" }),
  );
  return <span className="workspace-session-team-cats">
    {coats.map((coat, index) => <PixelCat key={index} coat={coat}/>)}
  </span>;
}
