import * as React from "react";
import { WandButton } from "../ui";

/** A fixed-size, text-only toggle shared by conversation and workspace lists. */
export function SidebarActivityFilter({ active, onChange, label = "只看活动会话" }: {
  active: boolean;
  onChange(active: boolean): void;
  label?: string;
}): React.ReactElement {
  return <WandButton kind="outline" size="small" className="sidebar-activity-filter"
    aria-label={label} aria-pressed={active} title="在跑、待处理及尚未查看的刚完成内容"
    onClick={() => onChange(!active)}>活动</WandButton>;
}
