import * as React from "react";
import { cachedComposerAvatarChoice, resolveComposerAvatarChoice, type AvatarRenderChoice } from "../../avatar-hardware.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { AvatarThinking } from "../avatars/thinking.js";
import { chatUsageMetrics } from "../../chat-message-meta.js";
import { RunningStatusBar } from "../chat/running-status-bar.js";
import { computeRunningPhase, type RunningActivityShape } from "../../running-activity.js";
import type { ConversationTurn } from "../../../types.js";
import { WandButton } from "../ui/button.js";
import { WandPopover } from "../ui/popover.js";

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

function useComposerAvatarChoice(): "pending" | AvatarRenderChoice {
  const [choice, setChoice] = React.useState<"pending" | AvatarRenderChoice>(() => cachedComposerAvatarChoice() ?? "pending");
  React.useEffect(() => {
    if (choice !== "pending") return;
    setChoice(resolveComposerAvatarChoice());
  }, [choice]);
  return choice;
}

/** Bottom identity. Live 3D only when this browser's hardware facts can afford it. */
export function ComposerIdentity({ employee, thinking = false, fileActivity = "idle" }: {
  employee: React.ComponentProps<typeof EmployeeAvatar>["employee"];
  thinking?: boolean;
  fileActivity?: import("../../composer-avatar-activity.js").AvatarFileActivity;
}): React.ReactElement {
  const choice = useComposerAvatarChoice();
  const executing = thinking && fileActivity === "idle";
  const staticMode = choice !== "live";
  // A flat head still has to say something while this browser's hardware facts are
  // being read, and while the employee is executing. Reply history stays pure static.
  const loading = choice === "pending";
  return <span className="composer-floating-avatar" role="img" aria-label={`${employee.name}${fileActivity === "reading" ? "，正在查看文件" : fileActivity === "writing" ? "，正在编写文件" : ""}`} data-file-activity={fileActivity} data-avatar-choice={choice}>
    <EmployeeAvatar employee={employee} provider="" size="composer" renderMode={staticMode ? "static" : "live"} loading={loading} thinking={executing} fileActivity={fileActivity}/>
    {staticMode && (loading || executing) ? <AvatarThinking/> : null}
  </span>;
}
