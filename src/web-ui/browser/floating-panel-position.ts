export interface FloatingPanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingPanelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingPanelPosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Positions a floating panel near its anchor while keeping it inside visible bounds. */
export function computeFloatingPanelPosition(
  anchor: FloatingPanelRect,
  bounds: FloatingPanelBounds,
  panelWidth: number,
  panelHeight: number,
  gap = 10,
  margin = 8,
): FloatingPanelPosition {
  const minLeft = bounds.left + margin;
  const maxLeft = bounds.right - margin - panelWidth;
  const left = clamp(anchor.right - panelWidth, minLeft, maxLeft);
  const aboveTop = anchor.top - gap - panelHeight;
  const belowTop = anchor.bottom + gap;
  const roomAbove = anchor.top - gap - (bounds.top + margin);
  const roomBelow = bounds.bottom - margin - (anchor.bottom + gap);
  const placement = roomAbove >= panelHeight || roomAbove >= roomBelow ? "above" : "below";
  const preferredTop = placement === "above" ? aboveTop : belowTop;
  const minTop = bounds.top + margin;
  const maxTop = bounds.bottom - margin - panelHeight;

  return {
    left,
    top: clamp(preferredTop, minTop, maxTop),
    placement,
  };
}
