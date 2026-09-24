export interface StretchIndicatorBox {
  left: number;
  width: number;
}

/**
 * Shared tab indicator: first cover every pixel between the old tab and the
 * new one, then settle on the new tab. Reduced motion skips the stretch.
 */
export function stretchIndicatorFrames(
  previous: StretchIndicatorBox | null,
  next: StretchIndicatorBox,
  reduceMotion: boolean,
): StretchIndicatorBox[] {
  if (!previous || reduceMotion) return [next];
  const left = Math.min(previous.left, next.left);
  const right = Math.max(previous.left + previous.width, next.left + next.width);
  const stretched = { left, width: right - left };
  if (stretched.left === next.left && stretched.width === next.width) return [next];
  return [stretched, next];
}
