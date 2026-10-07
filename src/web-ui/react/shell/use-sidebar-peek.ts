import * as React from "react";
import { readMotionTokenMs, useReducedMotion } from "../ui/motion-tokens";

/**
 * 折叠窄栏「悬浮目录树」的开关时序。
 *
 * 先等一小段悬停意图：鼠标快速扫过目录图标时不该弹出预览。
 * 指针离开后再留一点时间，让指针能从窄栏滑进弹出面板而不闪断。
 */


export interface SidebarPeekHoverBindings {
  onKeyDown(event: React.KeyboardEvent<HTMLElement>): void;
  onPointerLeave(event: React.PointerEvent<HTMLElement>): void;
  onFocusCapture(event: React.FocusEvent<HTMLElement>): void;
  onBlurCapture(event: React.FocusEvent<HTMLElement>): void;
}

/** 绑在窄栏上，仅目录图标的指针和焦点事件请求展开。 */
export interface SidebarPeekTriggerBindings extends SidebarPeekHoverBindings {
  onPointerOver(event: React.PointerEvent<HTMLElement>): void;
  onClick(event: React.MouseEvent<HTMLElement>): void;
}

/** 绑在弹出面板上：指针或焦点落进面板就保持展开。 */
export interface SidebarPeekSurfaceBindings extends SidebarPeekHoverBindings {
  onPointerEnter(event: React.PointerEvent<HTMLElement>): void;
}


export interface SidebarPeek {
  /** 只有真正悬停过才挂载面板：折叠态常驻会多跑一份目录树轮询。 */
  readonly mounted: boolean;
  readonly open: boolean;
  /** 绑在窄栏上：只响应带目录标识的图标。 */
  readonly triggerBindings: SidebarPeekTriggerBindings;
  /** 绑在弹出面板上：指针或焦点落进面板就保持展开。 */
  readonly surfaceBindings: SidebarPeekSurfaceBindings;
  close(): void;
}

/**
 * 触摸优先的设备没有悬停语义，右侧弹出的目录树会变成「点一下弹出、盖住内容」。
 * 只有真实指针设备才启用，其余场景继续用窄栏图标 + 展开按钮。
 */
export function useHoverPointer(): boolean {
  const query = "(hover: hover) and (pointer: fine)";
  // SSR / 测试环境没有 window：退回「不启用浮层」，窄栏保持原样。
  const read = (): boolean => (
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(query).matches
  );
  const [hoverable, setHoverable] = React.useState(read);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = (): void => setHoverable(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return hoverable;
}

export function useSidebarPeek(
  enabled: boolean,
  triggerRef: React.RefObject<HTMLElement | null>,
  surfaceRef: React.RefObject<HTMLElement | null>,
  onDirectory: (id: string, trigger: HTMLElement) => void,
): SidebarPeek {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const openTimer = React.useRef(0);
  const closeTimer = React.useRef(0);
  const activeTrigger = React.useRef<HTMLElement | null>(null);
  const suppressedTrigger = React.useRef<HTMLElement | null>(null);
  const desiredOpen = React.useRef(false);
  const reduced = useReducedMotion();

  const clearTimers = React.useCallback((): void => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  const close = React.useCallback((): void => {
    clearTimers();
    desiredOpen.current = false;
    setOpen(false);
  }, [clearTimers]);

  const scheduleOpen = React.useCallback((delay: number): void => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    desiredOpen.current = true;
    openTimer.current = window.setTimeout(() => {
      setMounted(true);
      setOpen(true);
    }, delay);
  }, []);

  const scheduleClose = React.useCallback((): void => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    desiredOpen.current = false;
    if (reduced) { setOpen(false); return; }
    closeTimer.current = window.setTimeout(() => setOpen(false), readMotionTokenMs("--motion-normal"));
  }, [reduced]);

  /**
   * 窄栏在展开态也会收到指针/焦点事件（折叠按钮就在侧栏里）。
   * 所有「请求展开」都必须先过 `enabled`，否则收起侧栏的那一下点击会顺手把面板点亮。
   */
  const requestOpen = React.useCallback((delay: number): void => {
    if (!enabled) return;
    scheduleOpen(delay);
  }, [enabled, scheduleOpen]);

  /** 指针/焦点是否落在面板自己身上：窄栏的 pointerover 会冒泡穿过面板。 */
  const insideSurface = React.useCallback((next: EventTarget | null): boolean => (
    next instanceof Node && surfaceRef.current?.contains(next) === true
  ), [surfaceRef]);

  React.useEffect(() => {
    if (enabled) return;
    // 展开成完整侧栏后卸载面板：否则会多出一份隐藏的目录树在后台轮询。
    clearTimers();
    desiredOpen.current = false;
    setOpen(false);
    setMounted(false);
  }, [enabled, clearTimers]);

  React.useEffect(() => clearTimers, [clearTimers]);
  React.useEffect(() => {
    if (!reduced) return;
    clearTimers();
    if (enabled && desiredOpen.current) setMounted(true);
    setOpen(enabled && desiredOpen.current);
  }, [reduced, enabled, clearTimers]);

  const insideFloatingLayer = React.useCallback((node: EventTarget | null): boolean => {
    if (!(node instanceof Element)) return false;
    const owner = node.closest<HTMLElement>("[data-wand-popup-owner]")?.dataset.wandPopupOwner;
    if (!owner) return false;
    // Only the active peek's projection owns these portalled controls.
    return Array.from(surfaceRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-popup-owner]") ?? [])
      .some((projection) => projection.dataset.sidebarPopupOwner === owner);
  }, [surfaceRef]);

  const holds = React.useCallback((next: EventTarget | null): boolean => (
    next instanceof Node
    && (surfaceRef.current?.contains(next) === true || triggerRef.current?.contains(next) === true)
  ), [surfaceRef, triggerRef]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 只有焦点真在侧栏里才接管 Esc：焦点在终端 / 聊天框时 Esc 属于它们
      // （xterm 会把 Esc 发给 CLI），悬停面板不抢这个键。
      const focused = document.activeElement;
      if (!holds(focused)) return;
      // 面板里开着端口浮层（行内下拉 / 弹窗）：让浮层自己收。
      if (insideFloatingLayer(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      suppressedTrigger.current = activeTrigger.current;
      close();
      activeTrigger.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // 点窄栏自己（含展开按钮、图标）不算外部点击：交给各自的点击逻辑。
      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // 端口浮层（行内下拉 / 弹窗）里的点击同样不算：否则重命名完面板已经没了。
      if (insideFloatingLayer(target)) return;
      close();
    };
    // 捕获阶段先关，避免同一次点击既落在主内容上又留着浮层。
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close, holds, insideFloatingLayer, surfaceRef, triggerRef]);

  const leave = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (insideFloatingLayer(event.relatedTarget)) return;
    suppressedTrigger.current = null;
    scheduleClose();
  }, [scheduleClose, insideFloatingLayer]);

  const requestDirectory = (target: EventTarget | null, delay: number): void => {
    if (!enabled || insideSurface(target) || insideFloatingLayer(target)) return;
    const trigger = target instanceof Element
      ? target.closest<HTMLElement>("[data-sidebar-directory-id]")
      : null;
    const id = trigger?.dataset.sidebarDirectoryId;
    if (!trigger || !id || !triggerRef.current?.contains(trigger)) {
      scheduleClose();
      return;
    }
    if (suppressedTrigger.current === trigger) return;
    activeTrigger.current = trigger;
    onDirectory(id, trigger);
    requestOpen(reduced ? 0 : delay);
  };

  return {
    mounted,
    open,
    close,
    triggerBindings: {
      onKeyDown: (event) => {
        if (event.key !== "Tab" || event.shiftKey || !open || event.defaultPrevented) return;
        if (document.activeElement !== activeTrigger.current) return;
        const first = surfaceRef.current?.querySelector<HTMLElement>("button, [tabindex='0']");
        if (!first) return;
        event.preventDefault();
        first.focus({ preventScroll: true });
      },
      // 目录之间可直接切换；头部、导航、页脚都不触发目录预览。
      onPointerOver: (event) => requestDirectory(event.target, readMotionTokenMs("--motion-fast")),
      onClick: (event) => {
        const trigger = event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-sidebar-directory-id]") : null;
        suppressedTrigger.current = null;
        if (open && trigger === activeTrigger.current) { close(); return; }
        requestDirectory(event.target, 0);
      },
      onPointerLeave: leave,
      onFocusCapture: (event) => requestDirectory(event.target, 0),
      onBlurCapture: (event) => {
        if (holds(event.relatedTarget) || insideFloatingLayer(event.relatedTarget)) return;
        scheduleClose();
      },
    },
    surfaceBindings: {
      onKeyDown: (event) => {
        if (event.key !== "Tab" || !event.shiftKey) return;
        const first = surfaceRef.current?.querySelector<HTMLElement>("button, [tabindex='0']");
        if (document.activeElement !== first) return;
        event.preventDefault();
        activeTrigger.current?.focus({ preventScroll: true });
      },
      onPointerEnter: () => { desiredOpen.current = true; window.clearTimeout(closeTimer.current); },
      onPointerLeave: leave,
      onFocusCapture: () => { desiredOpen.current = true; window.clearTimeout(closeTimer.current); },
      onBlurCapture: (event) => {
        if (holds(event.relatedTarget) || insideFloatingLayer(event.relatedTarget)) return;
        close();
      },
    },
  };
}
