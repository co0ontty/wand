import * as React from "react";
import { WandIcon } from "../ui";
import { useReducedMotion } from "../ui/motion-tokens";
import { useServerAnchoredClock } from "../shell/use-server-anchored-clock.js";
import {
  computeRunningPhase,
  runningStatusText,
  runStatusText,
  silenceNotice,
  type RunningActivityShape,
  type RunningPhase,
} from "../../running-activity";

const PHASE_ICONS = {
  received: "enter",
  executing: "spark",
  waiting: "shield",
  idle: "spark",
} as const;

/**
 * 持续可见的「正在执行」状态条（私聊会话与团队群聊共用同一语义）。
 * 全部读数来自服务端运行事实与本轮锚点：非运行中直接不渲染（立即收敛，不留残影），
 * 静默超过阈值时升级为「仍在运行 · 已 N 分钟无新消息」，而不是一片静止历史。
 */
export function RunningStatusBar(props: {
  activity: RunningActivityShape | null | undefined;
  /** 团队 run 模式：锚点在 run 自身上，不走会话 structuredState。 */
  runMode?: boolean;
}): React.ReactElement | null {
  const activity = props.activity;
  const runMode = props.runMode === true;
  // 相位为准：排队未空也算「这一轮还没完」，不能被会话级 idle 吞掉。
  const phase = computeRunningPhase(activity, runMode);
  const running = phase !== "idle";
  const now = useServerAnchoredClock(running);
  const reduced = useReducedMotion();
  if (!running || !activity) return null;
  const waitingRun = runMode
    && (activity.status === "awaiting_approval" || activity.status === "waiting_user");
  const shownPhase: RunningPhase = waitingRun ? "waiting" : phase;
  const text = runMode ? runStatusText(activity, now) : runningStatusText(activity, now, runMode);
  if (!text) return null;
  const waiting = shownPhase === "waiting";
  return (
    <div
      className={`chat-running-bar${waiting ? " is-waiting" : ""}`}
      data-phase={shownPhase}
      data-silent={silenceNotice(activity, now) ? "true" : undefined}
      role="status"
      aria-live="polite"
    >
      <span
        className={`chat-running-pulse${reduced ? " is-instant" : ""}`}
        data-phase={shownPhase}
        aria-hidden="true"
      >
        <WandIcon name={PHASE_ICONS[shownPhase]} size={13} />
      </span>
      <span className="chat-running-text">{text}</span>
    </div>
  );
}
