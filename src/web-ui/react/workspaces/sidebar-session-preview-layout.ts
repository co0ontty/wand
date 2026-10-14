export interface SidebarPreviewLayout {
  titles: boolean;
  count: number;
}

/** Every dimension comes from the rendered controls. Reserve +N before filling icon slots. */
export function fitSidebarSessionPreview(
  available: number,
  titleWidths: readonly number[],
  iconWidth: number,
  gap: number,
  moreWidth: (hiddenCount: number) => number,
): SidebarPreviewLayout {
  const total = titleWidths.length;
  if (!total || !Number.isFinite(available) || available <= 0) return { titles: false, count: 0 };
  const spacing = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  if (titleWidths.every(width => Number.isFinite(width) && width > 0)
    && titleWidths.reduce((sum, width) => sum + width, 0) + spacing * (total - 1) <= available) {
    return { titles: true, count: total };
  }
  if (!Number.isFinite(iconWidth) || iconWidth <= 0) return { titles: false, count: 0 };
  if (iconWidth * total + spacing * (total - 1) <= available) return { titles: false, count: total };
  let count = 0;
  for (let visible = 0; visible < total; visible++) {
    const overflow = moreWidth(total - visible);
    if (!Number.isFinite(overflow) || overflow <= 0 || visible * (iconWidth + spacing) + overflow > available) break;
    count = visible;
  }
  return { titles: false, count };
}
