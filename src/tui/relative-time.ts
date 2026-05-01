/** 把绝对时间字符串（ISO）转为简短的相对时长，例：`2m`、`10m`、`1h`、`3d`。 */
export function relativeAge(fromIso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** 计算两个时间点之间的相对时长（结束 - 开始）。 */
export function durationBetween(startIso: string, endIso: string | null): string {
  if (!endIso) return relativeAge(startIso);
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  return relativeAge(startIso, end);
}
