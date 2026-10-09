import { Dropdown, type MenuProps } from "antd";
import * as React from "react";
import { createPortal } from "react-dom";
import { classNames } from "../ui/class-names";
import { usePortalContainer } from "../ui/portal-context";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import { WandUiBoundary } from "../theme";
import { SidebarSurfacesContext, useSidebarPopupOwner } from "./sidebar-popup-owner";

// A gesture threshold, not an animation duration. Scrolling always cancels the gesture.
const LONG_PRESS_MS = 500;

/** Ant owns pointer alignment, collision handling, roving focus and submenu navigation. */
export function SidebarRowMenu({ row, menu, open, onOpenChange, label, title, description, error,
  className, disabled = false, rowRef }: {
  row: React.ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }>;
  menu: MenuProps;
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  title?: string;
  description?: string;
  error?: string;
  className?: string;
  disabled?: boolean;
  rowRef?: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const popupOwner = useSidebarPopupOwner();
  const portal = usePortalContainer();
  const surfacesEnabled = React.useContext(SidebarSurfacesContext);
  const unavailable = disabled || !surfacesEnabled;
  const shown = open && !unavailable;
  const id = React.useId();
  const content = React.useRef<HTMLDivElement>(null);
  const submenuContainer = React.useRef<HTMLDivElement>(null);
  const triggerNode = React.useRef<HTMLElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const synthetic = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const pressed = React.useRef(false);
  const [openKeys, setOpenKeys] = React.useState<string[]>([]);
  const cancel = (): void => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; pointer.current = null; };
  const changeKeys = (keys: string[]): void => {
    // Ant's menu and context dropdown share a native layer when there is no enclosing
    // dialog. Keep the child later in Portal paint order, without inventing a z-index.
    const container = submenuContainer.current;
    if (keys.length && container?.parentElement) container.parentElement.appendChild(container);
    setOpenKeys(keys); menu.onOpenChange?.(keys);
  };
  const restoreFocus = (): void => {
    const target = returnFocus.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
    else triggerNode.current?.querySelector<HTMLElement>("button,a[href]")?.focus({ preventScroll: true });
  };
  usePopupDismiss(shown, () => { onOpenChange(false); restoreFocus(); });
  usePopupDismiss(shown && openKeys.length > 0, () => {
    changeKeys([]);
    content.current?.querySelector<HTMLElement>(".ant-dropdown-menu-submenu-title")?.focus({ preventScroll: true });
  });
  React.useEffect(() => {
    if (!shown) { cancel(); setOpenKeys([]); }
    if (unavailable && open) onOpenChange(false);
    return cancel;
  }, [shown, unavailable]);
  React.useEffect(() => {
    document.addEventListener("scroll", cancel, true);
    return () => { cancel(); document.removeEventListener("scroll", cancel, true); };
  }, []);
  React.useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    const focus = (): void => {
      if (cancelled) return;
      content.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
    };
    const frame = requestAnimationFrame(() => {
      focus();
      const popup = content.current?.closest(".ant-dropdown");
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
  }, [shown]);
  const openAt = (x: number, y: number, target: HTMLElement | null): void => {
    returnFocus.current = target;
    synthetic.current = true;
    // Reuse Dropdown's native alignPoint path for keyboard and touch too.
    triggerNode.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    synthetic.current = false;
  };
  const trigger = React.cloneElement(row, {
    ref: (node: HTMLElement | null) => {
      triggerNode.current = node;
      if (rowRef) rowRef.current = node;
      if (typeof row.props.ref === "function") row.props.ref(node);
      else if (row.props.ref) row.props.ref.current = node;
    },
    tabIndex: row.props.tabIndex ?? -1,
    "aria-haspopup": unavailable ? undefined : "menu",
    "aria-expanded": unavailable ? undefined : shown,
    "aria-controls": shown ? id : undefined,
    "aria-description": unavailable ? undefined : "右键、长按或按 Shift+F10 打开操作菜单",
    "data-sidebar-menu-open": shown || undefined,
    onContextMenu: event => {
      event.preventDefault(); event.stopPropagation(); cancel();
      if (!synthetic.current && !pressed.current) returnFocus.current = (event.target as HTMLElement).closest<HTMLElement>("button,a[href],[tabindex]") ?? triggerNode.current;
      // Mobile browsers may emit their own contextmenu after our long-press threshold.
      // Treat it as the same gesture, not a second toggle that closes the menu.
      if (!unavailable && pressed.current && !synthetic.current) onOpenChange(true);
      row.props.onContextMenu?.(event);
    },
    onKeyDown: event => {
      row.props.onKeyDown?.(event);
      if (unavailable || event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
        event.preventDefault(); event.stopPropagation(); cancel();
        const target = event.target as HTMLElement;
        const bounds = target.getBoundingClientRect();
        openAt(bounds.left + 12, bounds.bottom, target);
      }
    },
    onPointerDown: event => {
      row.props.onPointerDown?.(event);
      cancel(); pressed.current = false;
      if (unavailable || event.pointerType !== "touch") return;
      const point = { x: event.clientX, y: event.clientY };
      pointer.current = point;
      const target = (event.target as HTMLElement).closest<HTMLElement>("button,a[href],[tabindex]") ?? triggerNode.current;
      timer.current = setTimeout(() => { timer.current = null; pressed.current = true; openAt(point.x, point.y, target); }, LONG_PRESS_MS);
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
      // Suppress the compatibility click after long press, without changing ordinary row clicks.
      if (pressed.current) { event.preventDefault(); event.stopPropagation(); }
      row.props.onTouchEnd?.(event);
    },
    onPointerCancel: event => { cancel(); row.props.onPointerCancel?.(event); },
    onClickCapture: event => {
      if (pressed.current) { pressed.current = false; event.preventDefault(); event.stopPropagation(); }
      else row.props.onClickCapture?.(event);
    },
  } as React.HTMLAttributes<HTMLElement>);
  const items = [
    ...(title ? [{ key: "context", type: "group" as const, label: <div className="sidebar-menu-heading">
      <strong title={title}>{title}</strong>
      {description ? <span title={description}>{description}</span> : null}
    </div>, children: [] }] : []),
    ...(menu.items ?? []),
    ...(error ? [{ key: "action-error", disabled: true, label: <span role="alert" className="sidebar-menu-error">{error}</span> }] : []),
  ];
  return <WandUiBoundary>
    <Dropdown open={shown} disabled={unavailable} trigger={["contextMenu"]}
    onOpenChange={(next, info) => { if (info.source === "trigger") onOpenChange(next); }}
    getPopupContainer={() => portal ?? document.body} placement="bottomLeft" destroyOnHidden
    align={{ overflow: { adjustX: true, adjustY: true, shiftX: 12, shiftY: 12 } }}
    classNames={{ root: classNames("sidebar-row-menu", className) }}
    styles={{ root: { minWidth: "min(224px, calc(100vw - 24px))", maxWidth: "min(288px, calc(100vw - 24px))" },
      itemContent: { whiteSpace: "normal", overflowWrap: "anywhere" } }}
    menu={{ ...menu, id, "aria-label": label, selectable: false, items, openKeys, onOpenChange: changeKeys,
      triggerSubMenuAction: "click", getPopupContainer: () => submenuContainer.current ?? portal ?? document.body,
      // On narrow screens two menus cannot fit side by side. Let Ant shift the child,
      // rather than clipping it or moving the parent when the child opens.
      builtinPlacements: {
        rightTop: { points: ["tl", "tr"], overflow: { adjustX: true, adjustY: true, shiftX: 12, shiftY: 12 } },
        leftTop: { points: ["tr", "tl"], overflow: { adjustX: true, adjustY: true, shiftX: 12, shiftY: 12 } },
        ...menu.builtinPlacements,
      },
      style: { maxHeight: "calc(100dvh - 24px)", overflowY: "auto", overscrollBehavior: "contain", ...menu.style } }}
    popupRender={nativeMenu => <div ref={content} data-wand-popup-owner={popupOwner} onKeyDown={event => {
      if (event.key === "Tab" && !event.nativeEvent.isComposing) {
        onOpenChange(false); restoreFocus(); event.stopPropagation();
      }
    }}>{nativeMenu}</div>}>
    {trigger}
  </Dropdown>
    {shown && createPortal(<div ref={submenuContainer} className="sidebar-menu-submenus" data-wand-popup-owner={popupOwner}/>, portal ?? document.body)}
  </WandUiBoundary>;
}
