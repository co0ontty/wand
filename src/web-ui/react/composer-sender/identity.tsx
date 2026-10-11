import * as React from "react";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { chatUsageMetrics } from "../../chat-message-meta.js";
import { RunningStatusBar } from "../chat/running-status-bar.js";
import { computeRunningPhase, type RunningActivityShape } from "../../running-activity.js";
import type { ConversationTurn } from "../../../types.js";
import { WandButton, WandPopover } from "../ui/index.js";

export function ComposerUsage({ usage, activity, employeeName, legacyStatus = false, showName = true }: { usage: ConversationTurn["usage"]; activity?: RunningActivityShape; employeeName?: string; legacyStatus?: boolean; showName?: boolean }): React.ReactElement | null {
  const metrics = chatUsageMetrics(usage);
  if (!employeeName && !metrics.length && computeRunningPhase(activity) === "idle") return null;
  return <div className="composer-usage-line" role="status" aria-label={employeeName ? `${employeeName}，状态与用量` : "最近一轮用量"} tabIndex={0}
    title={metrics.map(metric => metric.title).join(" · ")}>
    {employeeName && showName ? <span className="composer-identity-name" title={employeeName}>{employeeName}：</span> : null}
    {legacyStatus ? <span data-composer-running-host=""/> : <RunningStatusBar activity={activity}/>}
    {metrics.length ? <WandPopover side="top" ariaLabel="最近一轮用量详情" trigger={<WandButton kind="ghost" size="small" className="composer-usage-caption">用量</WandButton>}>
    <div className="composer-usage-details">{metrics.map(metric => <span className="composer-usage-metric" key={metric.key} title={metric.title}>
      {metric.label} <span className="composer-usage-number">{metric.value}</span>
    </span>)}</div></WandPopover> : null}
  </div>;
}

/** Identity only: draft, focus and send ownership stay with the existing composer. */
export function ComposerIdentity({ employee, thinking = false, fileActivity = "idle" }: {
  employee: React.ComponentProps<typeof EmployeeAvatar>["employee"];
  thinking?: boolean;
  fileActivity?: import("../../composer-avatar-activity.js").AvatarFileActivity;
}): React.ReactElement {
  return <span className="composer-floating-avatar" role="img" aria-label={`${employee.name}${fileActivity === "reading" ? "，正在查看文件" : fileActivity === "writing" ? "，正在编写文件" : ""}`} data-file-activity={fileActivity}>
    <EmployeeAvatar employee={employee} provider="" size="composer" thinking={thinking && fileActivity === "idle"} fileActivity={fileActivity}/>
  </span>;
}
