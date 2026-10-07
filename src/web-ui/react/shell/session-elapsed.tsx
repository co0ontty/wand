import * as React from "react";
import { formatElapsedShort } from "../../session-activity";
import { turnStartedAtMs } from "../../running-activity";
import { useServerAnchoredClock } from "./use-server-anchored-clock";

/**
 * 时长读数只来自服务端本轮锚点；锚点缺失（旧快照、重启降级）时整块不渲染，
 * 不回落到本地挂载时刻起表 —— 那会让刷新后从 0s 重新数，等于伪造进度。
 */
export function SessionElapsed(props: {
  anchor: string | null | undefined;
}): React.ReactElement | null {
  const started = turnStartedAtMs({ turnStartedAt: props.anchor });
  const now = useServerAnchoredClock(started !== null);
  if (started === null) return null;
  return (
    <span className="session-status-elapsed">{formatElapsedShort(Math.max(0, now - started))}</span>
  );
}
