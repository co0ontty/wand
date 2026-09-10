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
