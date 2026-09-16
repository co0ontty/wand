import * as React from "react";

/** Keyboard and focus behavior for the temporary mobile/sidebar overlay. */
export function useSidebarDrawer(open: boolean, close: () => void): React.RefObject<HTMLElement | null> {
  const ref = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    const drawer = ref.current;
    if (!open || !drawer) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !drawer.contains(event.target as Node)) return;
      if (event.key === "Tab") {
        // Traverse only the React-owned drawer ref; never query legacy hosts.
        const controls: HTMLElement[] = [];
        const walker = document.createTreeWalker(drawer, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const element = walker.currentNode;
          if (element instanceof HTMLElement && element.tabIndex >= 0
            && !element.matches(":disabled")
            && !element.closest('[inert], [aria-hidden="true"]')
            && element.getClientRects().length > 0
            && getComputedStyle(element).visibility !== "hidden") {
            controls.push(element);
          }
        }
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || (event.shiftKey
          ? document.activeElement === first || document.activeElement === drawer
          : document.activeElement === last || document.activeElement === drawer)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (drawer.contains(document.activeElement)) {
        previous?.focus({ preventScroll: true });
      }
    };
  }, [open]);
  return ref;
}
