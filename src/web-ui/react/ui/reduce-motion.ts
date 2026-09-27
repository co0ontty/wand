/**
 * 系统「减少动画」偏好。位移 / 缩放 / 淡入在真值下一律退化成瞬时；
 * 结果停留（MOTION_DWELL_*）是读信息的等待，不归这里管。
 */
export function reduceMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
