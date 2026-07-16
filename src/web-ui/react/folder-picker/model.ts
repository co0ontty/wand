export type FolderPickerNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function nextFolderPickerIndex(
  current: number,
  itemCount: number,
  key: FolderPickerNavigationKey,
): number {
  if (itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % itemCount;
  return current < 0 ? itemCount - 1 : (current - 1 + itemCount) % itemCount;
}
