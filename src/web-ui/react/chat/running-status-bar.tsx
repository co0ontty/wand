import * as React from "react";
import { WandIcon } from "../ui/icons";
import { useReducedMotion } from "../ui/motion-tokens";
import { useServerAnchoredClock } from "../shell/use-server-anchored-clock.js";
import {
  projectRunningStatus,
  runningStatusText,
  silenceDurationMs,
  SILENCE_NOTICE_MS,
  type RunningActivityShape,
  type RunningStatusStage,
} from "../../running-activity";

const PHASE_ICONS = {
  received: "enter",
  executing: "spark",
  tool: "wrench",
  output: "enter",
  thinking: "spark",
  background: "history",
  waiting: "shield",
  failed: "warning",
  stopped: "stop",
  idle: "spark",
} as const satisfies Record<RunningStatusStage, string>;

/**
 * 阶段与当前动作合并成一条状态。终态按真实 failed/stopped 展示并停止计时；
 * 运行读数只差分服务端锚点，不把输出正文当阶段、不借用其他会话事实。
 */
export function RunningStatusBar(props: {
  activity: RunningActivityShape | null | undefined;
  /** 团队 run 模式：锚点在 run 自身上，不走会话 structuredState。 */
  runMode?: boolean;
}): React.ReactElement | null {
  const activity = props.activity;
  const runMode = props.runMode === true;
  const projection = projectRunningStatus(activity, runMode);
  const now = useServerAnchoredClock(projection.active && projection.phase !== "received");
  const reduced = useReducedMotion();
  const text = runningStatusText(activity, now, runMode);
  if (!text) return null;
  const waiting = projection.phase === "waiting";
  const silent = projection.active && projection.phase !== "received"
    && silenceDurationMs(activity, now, runMode) >= SILENCE_NOTICE_MS;
  return (
    <div
      className={`chat-running-bar${waiting ? " is-waiting" : ""}`}
      data-phase={projection.stage}
      data-source-session={runMode ? undefined : activity?.id}
      data-silent={silent ? "true" : undefined}
      role="status"
      aria-live="polite"
    >
      <span
        className={`chat-running-pulse${reduced || !projection.active ? " is-instant" : ""}`}
        data-phase={projection.stage}
        aria-hidden="true"
      >
        <WandIcon name={PHASE_ICONS[projection.stage]} size={13} />
      </span>
      <span className="chat-running-text">{text}</span>
    </div>
  );
}
