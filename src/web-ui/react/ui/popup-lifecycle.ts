import { useEffect, useRef } from "react";
import type { DropdownProps } from "antd";

export type PopupSide = "top" | "right" | "bottom" | "left";
export type PopupAlign = "start" | "center" | "end";

export function popupPlacement(side: PopupSide, align: PopupAlign): Exclude<NonNullable<DropdownProps["placement"]>, "topCenter" | "bottomCenter"> {
  if (side === "top" || side === "bottom") {
    return align === "center" ? side : `${side}${align === "end" ? "Right" : "Left"}`;
  }
  return align === "center" ? side : `${side}${align === "end" ? "Bottom" : "Top"}`;
}

export function popupOffset(side: PopupSide, distance: number): [number, number] {
  return side === "left" ? [-distance, 0] : side === "right" ? [distance, 0] : [0, side === "top" ? -distance : distance];
}

export type PopupDismissPriority = "normal" | "blocking";
interface PopupDismissLease { dismiss(): void; priority: PopupDismissPriority }
const dismissStack: PopupDismissLease[] = [];

function topDismissLease(): PopupDismissLease | undefined {
  // Service recovery owns input even if an ordinary dialog mounts afterwards.
  // Ordinary menus/dialogs retain registration order; visual z-index is not a dismissal policy.
  for (let index = dismissStack.length - 1; index >= 0; index -= 1) {
    if (dismissStack[index]?.priority === "blocking") return dismissStack[index];
  }
  return dismissStack.at(-1);
}

/** Page navigation yields Escape to an open Portal surface. */
export function hasOpenPopupSurface(): boolean {
  return dismissStack.length > 0 || Array.from(document.querySelectorAll("[role=dialog],[data-wand-dialog-surface],.ant-select-dropdown,.ant-dropdown,.ant-popover"))
    .some((element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
}
function dismissTopPopup(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.isComposing || !dismissStack.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  topDismissLease()?.dismiss();
}

function dismissTopOnHistory(): void { topDismissLease()?.dismiss(); }

/** Escape/back closes only the top popup; the enclosing dialog keeps its focus lease. */
export function registerPopupDismiss(dismiss: () => void, priority: PopupDismissPriority = "normal"): () => void {
  if (!dismissStack.length) {
    document.addEventListener("keydown", dismissTopPopup, true);
    window.addEventListener("popstate", dismissTopOnHistory);
  }
  const lease = { dismiss, priority };
  dismissStack.push(lease);
  return () => {
    const index = dismissStack.indexOf(lease);
    if (index >= 0) dismissStack.splice(index, 1);
    if (!dismissStack.length) {
      document.removeEventListener("keydown", dismissTopPopup, true);
      window.removeEventListener("popstate", dismissTopOnHistory);
    }
  };
}

const popupParents = new Map<string, string>();

/** Only an explicitly registered child belongs to a parent; unrelated Portals stay outside. */
export function registerPopupOwner(owner: string, parent: string | null): () => void {
  if (!parent || owner === parent) return () => {};
  popupParents.set(owner, parent);
  return () => { if (popupParents.get(owner) === parent) popupParents.delete(owner); };
}

/** Parent outside-press handlers recognize their registered ownership chain, never all popups. */
export function isWandPopupOwnedBy(target: EventTarget | null, owner: string): boolean {
  let current = target instanceof Element ? target.closest("[data-wand-popup-owner]")?.getAttribute("data-wand-popup-owner") : null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === owner) return true;
    seen.add(current); current = popupParents.get(current) ?? null;
  }
  return false;
}

/** Updating a callback must not reorder an already open popup's dismissal lease. */
export function usePopupDismiss(open: boolean, dismiss: () => void, priority: PopupDismissPriority = "normal"): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => open ? registerPopupDismiss(() => latest.current(), priority) : undefined, [open, priority]);
}
