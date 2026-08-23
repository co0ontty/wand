import * as React from "react";

import { ProviderLogo } from "../provider-logo";
import { WandIcon } from "../ui";
import { workspaceSessionProvider } from "./session-order";

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
