import * as React from "react";
import { WandPopover } from "../ui/popover";
import { SidebarSurfacesContext, useSidebarPopupOwner } from "./sidebar-popup-owner";

// A gesture threshold, not an animation duration. Scrolling always cancels the gesture.
const LONG_PRESS_MS = 500;

/** Ant owns the portal, placement, menu controls and dismissal; this adapts row input only. */
export function SidebarRowMenu({ row, children, open, onOpenChange, label, className, disabled = false, rowRef }: {
  row: React.ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }>;
  children: React.ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  className?: string;
  disabled?: boolean;
  rowRef?: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const popupOwner = useSidebarPopupOwner();
  const surfacesEnabled = React.useContext(SidebarSurfacesContext);
  const unavailable = disabled || !surfacesEnabled;
  const content = React.useRef<HTMLDivElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const pressed = React.useRef(false);
  const cancel = (): void => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  React.useEffect(() => {
    if (!open || unavailable) cancel();
    return cancel;
  }, [open, unavailable]);
  React.useEffect(() => {
    document.addEventListener("scroll", cancel, true);
    return () => { cancel(); document.removeEventListener("scroll", cancel, true); };
  }, []);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const focus = (): void => {
      if (cancelled) return;
      content.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]),button:not(:disabled),input:not(:disabled)')?.focus({ preventScroll: true });
    };
    const frame = requestAnimationFrame(() => {
      focus();
      const popup = content.current?.closest(".ant-popover");
      void Promise.allSettled(popup?.getAnimations({ subtree: true }).map(animation => animation.finished) ?? []).then(focus);
    });
    const cancelFocus = (): void => { cancelled = true; cancelAnimationFrame(frame); };
    document.addEventListener("pointerdown", cancelFocus, true);
    document.addEventListener("keydown", cancelFocus, true);
    return () => {
      cancelFocus();
      document.removeEventListener("pointerdown", cancelFocus, true);
      document.removeEventListener("keydown", cancelFocus, true);
    };
  }, [open]);
  const trigger = React.cloneElement(row, {
    ref: (node: HTMLElement | null) => { if (rowRef) rowRef.current = node; },
    tabIndex: -1,
    "aria-haspopup": unavailable ? undefined : "menu",
    "aria-expanded": unavailable ? undefined : open,
    "aria-description": "右键、长按或按 Shift+F10 打开操作菜单",
    onContextMenu: event => {
      event.preventDefault(); event.stopPropagation(); cancel();
      if (!unavailable) onOpenChange(true);
    },
    onKeyDown: event => {
      row.props.onKeyDown?.(event);
      if (unavailable || event.nativeEvent.isComposing) return;
      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
        event.preventDefault(); event.stopPropagation(); onOpenChange(true);
      }
    },
    onPointerDown: event => {
      row.props.onPointerDown?.(event);
      cancel(); pressed.current = false;
      if (unavailable || event.pointerType !== "touch") return;
      pointer.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => { timer.current = null; pressed.current = true; onOpenChange(true); }, LONG_PRESS_MS);
    },
    onPointerMove: event => {
      row.props.onPointerMove?.(event);
      if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 8) cancel();
    },
    onPointerUp: event => {
      cancel();
      if (pressed.current) { event.preventDefault(); event.stopPropagation(); }
      row.props.onPointerUp?.(event);
    },
    onTouchEnd: event => {
      // Prevent the compatibility mouse/click sequence from selecting the row after a long press.
      if (pressed.current) { event.preventDefault(); event.stopPropagation(); }
      row.props.onTouchEnd?.(event);
    },
    onPointerCancel: event => { cancel(); row.props.onPointerCancel?.(event); },
    onClickCapture: event => {
      if (pressed.current) { pressed.current = false; event.preventDefault(); event.stopPropagation(); }
      else row.props.onClickCapture?.(event);
    },
  });
  return <WandPopover popupOwner={popupOwner} trigger={trigger} triggerActions={unavailable ? [] : ["contextMenu"]}
    open={!unavailable && open} onOpenChange={next => { if (!unavailable) onOpenChange(next); }}
    align="start" ariaLabel={label} contentRole="menu" className={className}>
    <div ref={content}>{children}</div>
  </WandPopover>;
}
