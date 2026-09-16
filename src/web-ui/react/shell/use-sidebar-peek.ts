import * as React from "react";

/**
 * 折叠窄栏「悬浮目录树」的开关时序。
 *
 * 先等一小段悬停意图：鼠标快速扫过目录图标时不该弹出预览。
 * 指针离开后再留一点时间，让指针能从窄栏滑进弹出面板而不闪断。
 */
const OPEN_DELAY_MS = 140;
const CLOSE_DELAY_MS = 240;

export interface SidebarPeekHoverBindings {
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

/**
 * 弹出面板里的下拉 / 选择器都被 portal 到 `#overlay-root`（`data-wand-ui-root`）。
 * 指针从面板滑进这些浮层时不能把面板收掉，否则触发行会跟着面板一起消失。
 */
function insideFloatingLayer(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest("[data-wand-ui-root]") !== null;
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

  const clearTimers = React.useCallback((): void => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  const close = React.useCallback((): void => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  const scheduleOpen = React.useCallback((delay: number): void => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      setMounted(true);
      setOpen(true);
    }, delay);
  }, []);

  const scheduleClose = React.useCallback((): void => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);

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
    setOpen(false);
    setMounted(false);
  }, [enabled, clearTimers]);

  React.useEffect(() => clearTimers, [clearTimers]);

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
      close();
      // 焦点还在面板里时别把它交回窄栏：窄栏的 focusin 会立刻再把面板弹起来。
      if (focused instanceof HTMLElement && surfaceRef.current?.contains(focused)) {
        focused.blur();
      }
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
  }, [open, close, holds, surfaceRef, triggerRef]);

  const leave = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (insideFloatingLayer(event.relatedTarget)) return;
    scheduleClose();
  }, [scheduleClose]);

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
    onDirectory(id, trigger);
    requestOpen(delay);
  };

  return {
    mounted,
    open,
    close,
    triggerBindings: {
      // 目录之间可直接切换；头部、导航、页脚都不触发目录预览。
      onPointerOver: (event) => requestDirectory(event.target, OPEN_DELAY_MS),
      onClick: (event) => requestDirectory(event.target, 0),
      onPointerLeave: leave,
      onFocusCapture: (event) => requestDirectory(event.target, 0),
      onBlurCapture: (event) => {
        if (holds(event.relatedTarget) || insideFloatingLayer(event.relatedTarget)) return;
        scheduleClose();
      },
    },
    surfaceBindings: {
      onPointerEnter: () => window.clearTimeout(closeTimer.current),
      onPointerLeave: leave,
      onFocusCapture: () => window.clearTimeout(closeTimer.current),
      onBlurCapture: (event) => {
        if (holds(event.relatedTarget) || insideFloatingLayer(event.relatedTarget)) return;
        close();
      },
    },
  };
}
