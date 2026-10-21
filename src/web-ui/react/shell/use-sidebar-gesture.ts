import * as React from "react";

export interface SidebarGestureOptions {
  readonly drawerRef: React.RefObject<HTMLElement | null>;
  readonly backdropRef: React.RefObject<HTMLElement | null>;
  readonly enabled: boolean;
  readonly isOpen: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}

interface TouchPoint {
  readonly x: number;
  readonly y: number;
  readonly time: number;
}

const TOUCH_SLOP = 8;
const MIN_VELOCITY_COMMIT = 0.28; // px/ms, threshold for flick/fling gesture
const ACCELERATION_MOMENTUM_WEIGHT = 50; // ms, velocity boost factor from acceleration
const POSITION_COMMIT_RATIO = 0.35; // Commit to open if pulled past 35%
const DEFAULT_TRIGGER_EDGE_WIDTH = 56; // Generous trigger zone from screen left

/**
 * Interactive edge-swipe gesture with velocity and acceleration tracking for the sidebar drawer.
 * Follows mobile UI motion best practices: generous touch hit area, 1:1 real-time drag tracking,
 * acceleration/fling recognition, and physics-based spring deceleration.
 */
export function useSidebarGesture({
  drawerRef,
  backdropRef,
  enabled,
  isOpen,
  onOpen,
  onClose,
}: SidebarGestureOptions): void {
  const onOpenRef = React.useRef(onOpen);
  const onCloseRef = React.useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  const stateRef = React.useRef<{
    phase: "idle" | "tracking" | "dragging" | "animating";
    startX: number;
    startY: number;
    startTime: number;
    currentX: number;
    currentY: number;
    initialOpen: boolean;
    samples: TouchPoint[];
    drawerWidth: number;
    cleanups: Array<() => void>;
  }>({
    phase: "idle",
    startX: 0,
    startY: 0,
    startTime: 0,
    currentX: 0,
    currentY: 0,
    initialOpen: false,
    samples: [],
    drawerWidth: 320,
    cleanups: [],
  });

  React.useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const state = stateRef.current;

    const getDrawerWidth = (): number => {
      const drawer = drawerRef.current;
      if (drawer && drawer.offsetWidth > 0) return drawer.offsetWidth;
      return Math.min(344, Math.max(260, window.innerWidth - 24));
    };

    const isInteractiveExcluded = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      const editable = target.closest("input, textarea, select, [contenteditable='true']");
      if (editable && document.activeElement === editable) return true;
      if (target.closest(".ant-tabs-nav, pre, code, [data-scroll-x], [data-no-drawer-gesture]")) return true;
      return false;
    };

    const cleanupStyles = (): void => {
      const drawer = drawerRef.current;
      const backdrop = backdropRef.current;
      if (drawer) {
        drawer.style.transform = "";
        drawer.style.transition = "";
        drawer.style.willChange = "";
        drawer.style.pointerEvents = "";
        delete drawer.dataset.drawerGesture;
      }
      if (backdrop) {
        backdrop.style.opacity = "";
        backdrop.style.transition = "";
        backdrop.style.willChange = "";
        backdrop.style.pointerEvents = "";
        delete backdrop.dataset.drawerGesture;
      }
    };

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1 || state.phase === "animating") return;
      const touch = event.touches[0];
      if (!touch) return;
      if (isInteractiveExcluded(event.target)) return;

      const triggerWidth = Math.max(DEFAULT_TRIGGER_EDGE_WIDTH, Math.round(window.innerWidth * 0.16));
      const inEdgeZone = touch.clientX <= triggerWidth;
      const drawer = drawerRef.current;
      const backdrop = backdropRef.current;
      const inDrawerZone = (drawer && drawer.contains(event.target as Node)) ||
        (backdrop && backdrop.contains(event.target as Node));

      if (!isOpen && !inEdgeZone) return;
      if (isOpen && !inDrawerZone) return;

      state.phase = "tracking";
      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.startTime = Date.now();
      state.currentX = touch.clientX;
      state.currentY = touch.clientY;
      state.initialOpen = isOpen;
      state.drawerWidth = getDrawerWidth();
      state.samples = [{ x: touch.clientX, y: touch.clientY, time: state.startTime }];
    };

    const onTouchMove = (event: TouchEvent): void => {
      if (state.phase === "idle" || state.phase === "animating") return;
      const touch = event.touches[0];
      if (!touch) return;

      const now = Date.now();
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;

      if (state.phase === "tracking") {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx < TOUCH_SLOP && absDy < TOUCH_SLOP) return;

        // If predominantly vertical movement, release to native page scroll
        if (absDy >= absDx) {
          state.phase = "idle";
          return;
        }

        // Closed drawer only opens right; opened drawer only closes left
        if (!state.initialOpen && dx <= 0) {
          state.phase = "idle";
          return;
        }
        if (state.initialOpen && dx >= 0) {
          state.phase = "idle";
          return;
        }

        state.phase = "dragging";
        const drawer = drawerRef.current;
        const backdrop = backdropRef.current;
        if (drawer) {
          drawer.dataset.drawerGesture = "active";
          drawer.style.display = "flex";
          drawer.style.willChange = "transform";
          drawer.style.transition = "none";
          drawer.style.pointerEvents = "auto";
        }
        if (backdrop) {
          backdrop.dataset.drawerGesture = "active";
          backdrop.style.display = "block";
          backdrop.style.willChange = "opacity";
          backdrop.style.transition = "none";
          backdrop.style.pointerEvents = "auto";
        }
      }

      if (state.phase !== "dragging") return;

      if (event.cancelable) {
        event.preventDefault();
      }

      state.currentX = touch.clientX;
      state.currentY = touch.clientY;

      // Keep recent 140ms samples for velocity and acceleration calculation
      state.samples.push({ x: touch.clientX, y: touch.clientY, time: now });
      const cutoff = now - 140;
      while (state.samples.length > 2 && (state.samples[0]?.time ?? 0) < cutoff) {
        state.samples.shift();
      }

      const W = state.drawerWidth;
      let progress = 0;
      let offsetPx = 0;

      if (!state.initialOpen) {
        // Dragging open: dx moves from 0 to W
        progress = Math.min(1, Math.max(0, dx / W));
        offsetPx = -W + dx;
        offsetPx = Math.min(0, offsetPx);
      } else {
        // Dragging closed: dx is negative, offset moves from 0 to -W
        progress = Math.min(1, Math.max(0, 1 + dx / W));
        offsetPx = Math.min(0, Math.max(-W, dx));
      }

      const drawer = drawerRef.current;
      const backdrop = backdropRef.current;
      if (drawer) {
        drawer.style.transform = `translate3d(${offsetPx}px, 0, 0)`;
      }
      if (backdrop) {
        backdrop.style.opacity = String(progress * 0.98);
      }
    };

    const onTouchEnd = (): void => {
      if (state.phase !== "dragging") {
        state.phase = "idle";
        return;
      }

      state.phase = "animating";
      const now = Date.now();
      const samples = state.samples;
      let velocity = 0;
      let acceleration = 0;

      if (samples.length >= 2) {
        const first = samples[0]!;
        const last = samples[samples.length - 1]!;
        const dt = Math.max(1, last.time - first.time);
        velocity = (last.x - first.x) / dt;

        if (samples.length >= 3) {
          const mid = samples[Math.floor(samples.length / 2)]!;
          const dt1 = Math.max(1, mid.time - first.time);
          const dt2 = Math.max(1, last.time - mid.time);
          const v1 = (mid.x - first.x) / dt1;
          const v2 = (last.x - mid.x) / dt2;
          acceleration = (v2 - v1) / dt2;
        }
      }

      // Effective velocity with acceleration momentum
      const effectiveVelocity = velocity + acceleration * ACCELERATION_MOMENTUM_WEIGHT;

      const W = state.drawerWidth;
      const dx = state.currentX - state.startX;
      let progress = state.initialOpen ? Math.max(0, 1 + dx / W) : Math.max(0, dx / W);
      progress = Math.min(1, progress);

      let shouldOpen = false;
      if (!state.initialOpen) {
        if (effectiveVelocity >= MIN_VELOCITY_COMMIT) {
          shouldOpen = true;
        } else if (effectiveVelocity <= -MIN_VELOCITY_COMMIT) {
          shouldOpen = false;
        } else {
          shouldOpen = progress >= POSITION_COMMIT_RATIO;
        }
      } else {
        if (effectiveVelocity <= -MIN_VELOCITY_COMMIT) {
          shouldOpen = false;
        } else if (effectiveVelocity >= MIN_VELOCITY_COMMIT) {
          shouldOpen = true;
        } else {
          shouldOpen = progress >= (1 - POSITION_COMMIT_RATIO);
        }
      }

      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const drawer = drawerRef.current;
      const backdrop = backdropRef.current;

      const finalize = (): void => {
        cleanupStyles();
        state.phase = "idle";
        if (shouldOpen) {
          onOpenRef.current();
        } else {
          onCloseRef.current();
        }
      };

      if (prefersReducedMotion || !drawer) {
        finalize();
        return;
      }

      // Physics-based spring deceleration transition
      const targetOffset = shouldOpen ? 0 : -W;
      const targetOpacity = shouldOpen ? 1 : 0;
      const remainingDistance = Math.abs((shouldOpen ? 0 : -W) - (state.initialOpen ? dx : -W + dx));
      const durationMs = Math.round(Math.min(260, Math.max(140, (remainingDistance / Math.max(0.8, Math.abs(effectiveVelocity) * 1.5)))));

      drawer.style.transition = `transform ${durationMs}ms cubic-bezier(0.16, 1, 0.3, 1)`;
      drawer.style.transform = `translate3d(${targetOffset}px, 0, 0)`;

      if (backdrop) {
        backdrop.style.transition = `opacity ${durationMs}ms cubic-bezier(0.16, 1, 0.3, 1)`;
        backdrop.style.opacity = String(targetOpacity);
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      const onTransitionEnd = (event: TransitionEvent): void => {
        if (event.target !== drawer || event.propertyName !== "transform") return;
        drawer.removeEventListener("transitionend", onTransitionEnd);
        if (timer) clearTimeout(timer);
        finalize();
      };

      drawer.addEventListener("transitionend", onTransitionEnd);
      timer = setTimeout(() => {
        drawer.removeEventListener("transitionend", onTransitionEnd);
        finalize();
      }, durationMs + 40);
    };

    const onTouchCancel = (): void => {
      if (state.phase === "dragging") {
        cleanupStyles();
      }
      state.phase = "idle";
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchCancel);
      cleanupStyles();
    };
  }, [enabled, isOpen, drawerRef, backdropRef]);
}
