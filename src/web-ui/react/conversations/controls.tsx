import * as React from "react";
import { createPortal } from "react-dom";
import { WandButton, WandIcon, WandIconButton } from "../ui";
import type { WandIconName } from "../ui/icons";
import { useReducedMotion } from "../ui/motion-tokens";
import { isWandPopupOwnedBy, registerPopupOwner, usePopupDismiss } from "../ui/popup-lifecycle";
import { PopupOwnerProvider, useParentPopupOwner, usePortalContainer } from "../ui/portal-context";

/** Both glyphs live in the same component; only the inner graphic morphs. */
export function ConversationMorphIcon({ active, from, to, size = 18 }: {
  active: boolean; from: WandIconName; to: WandIconName; size?: number;
}): React.ReactElement {
  const reduced = useReducedMotion();
  return <span className="conversation-morph-icon" style={{ width: size, height: size }} aria-hidden="true">
    {[from, to].map((name, index) => <span key={index} data-active={(index === 1) === active}
      style={{ opacity: (index === 1) === active ? 1 : 0,
        transform: reduced ? "none" : (index === 1) === active ? "rotate(0) scale(1)" : `rotate(${index ? -18 : 18}deg) scale(.9)`,
        transition: reduced ? "none" : undefined }}><WandIcon name={name} size={size}/></span>)}
  </span>;
}

export type ConversationSubmitPhase = "idle" | "sending" | "sent" | "result" | "failed" | "unknown";

/** One persistent button/box; only its overlaid label layers change with the existing submit owner. */
export function ConversationApprovalButton({ phase, disabled, onClick }: {
  phase: ConversationSubmitPhase; disabled: boolean; onClick(): void;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const labels = { idle: "明确批准本轮计划", sending: "批准中", sent: "已批准", result: "批准已接受", failed: "批准失败", unknown: "批准未确认" };
  return <WandButton className="conversation-approval" aria-label={labels[phase]} disabled={disabled} onClick={onClick}
    style={{ minWidth: 96, height: 44, flexShrink: 0 }}>
    <span data-approval-phase={phase} style={{ display: "grid" }} aria-live="polite">
      {Object.entries(labels).map(([state, label]) => <span key={state} aria-hidden={state !== phase}
        style={{ gridArea: "1 / 1", opacity: state === phase ? 1 : 0,
          transition: reduced ? "none" : "opacity var(--motion-fast) var(--ease-in-out-smooth)" }}>{label}</span>)}
    </span>
  </WandButton>;
}

export function ConversationSubmitButton({ phase, stops, disabled, label, onClick }: {
  phase: ConversationSubmitPhase; stops: boolean; disabled?: boolean; label: string; onClick(): void;
}): React.ReactElement {
  return <WandIconButton kind="primary" className="conversation-submit" aria-label={label} title={label}
    disabled={disabled} onClick={onClick} style={{ width: 44, height: 44, flexShrink: 0 }}>
    <span className="conversation-submit-slots" data-phase={phase}>
      <span data-slot="idle"><ConversationMorphIcon active={stops} from="up" to="stop"/></span>
      <span data-slot="sending"><WandIcon name="refresh"/></span>
      <span data-slot="sent"><WandIcon name="check"/></span>
      <span data-slot="failed"><WandIcon name="warning"/></span>
      <span data-slot="unknown"><WandIcon name="question"/></span>
    </span>
  </WandIconButton>;
}

export function ConversationPanel({ open, owner, anchorRef, triggerRef, onClose, direction = "down", focusKey, children }: {
  open: boolean; owner: string; anchorRef: React.RefObject<HTMLElement | null>;
  triggerRef: React.RefObject<HTMLButtonElement | null>; onClose(): void; direction?: "up" | "down"; focusKey?: string; children: React.ReactNode;
}): React.ReactElement {
  const reduced = useReducedMotion();
  const ref = React.useRef<HTMLDivElement>(null);
  const close = React.useRef(onClose); close.current = onClose;
  const parentOwner = useParentPopupOwner();
  const portal = usePortalContainer();
  React.useLayoutEffect(() => open ? registerPopupOwner(owner, parentOwner) : undefined, [open, owner, parentOwner]);
  usePopupDismiss(open, () => { close.current(); triggerRef.current?.focus({ preventScroll: true }); });
  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (anchorRef.current?.contains(event.target as Node) || isWandPopupOwnedBy(event.target, owner)) return;
      close.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => { document.removeEventListener("pointerdown", outside, true); };
  }, [open, anchorRef, triggerRef, owner]);
  React.useLayoutEffect(() => {
    const anchor = anchorRef.current, panel = ref.current;
    if (!open || !anchor || !panel) return;
    // Composer options must sit above the input, not cover the textarea above
    // the action row. Other panels keep their original trigger-row anchor.
    const placementAnchor = direction === "up" ? anchor.closest<HTMLElement>(".conversation-composer") ?? anchor : anchor;
    const place = (): void => {
      const pane = anchor.closest<HTMLElement>(".sidebar,.conversation-root")?.getBoundingClientRect();
      const box = placementAnchor.getBoundingClientRect();
      const left = pane?.left ?? 0, right = pane?.right ?? window.innerWidth;
      const width = Math.min(direction === "up" ? box.width : 360, right - left - 24, window.innerWidth - 24);
      const x = direction === "up" ? box.left : Math.max(left + 12, Math.min(box.right - width, right - width - 12));
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(12, Math.min(x, window.innerWidth - width - 12))}px`;
      panel.style.right = "auto";
      const above = direction === "up" || (window.innerHeight - box.bottom < Math.min(panel.scrollHeight, 280) && box.top > window.innerHeight - box.bottom);
      panel.style.top = above ? "auto" : `${box.bottom + 4}px`;
      panel.style.bottom = above ? `${window.innerHeight - box.top + 4}px` : "auto";
      panel.style.maxHeight = `${Math.max(80, Math.min(window.innerHeight * .66, (above ? box.top : window.innerHeight - box.bottom) - 16))}px`;
    };
    place();
    // The opening commit (and even its next paint) can still report hidden while
    // the panel's visibility transition runs. Focus only after it is visible;
    // when needed, use the actual animation completion instead of a fixed delay.
    let focusCancelled = false;
    let focused = false;
    let focusFrame = 0;
    const focusVisibleControl = (): boolean => {
      if (focusCancelled || focused) return focused;
      const control = Array.from(panel.querySelectorAll<HTMLElement>("input,button,[tabindex='0']"))
        .find(node => !node.matches(":disabled") && !node.closest("[hidden],[inert]")
          && node.getClientRects().length && getComputedStyle(node).visibility === "visible");
      control?.focus({ preventScroll: true });
      focused = !!control && document.activeElement === control;
      return focused;
    };
    focusFrame = requestAnimationFrame(() => {
      if (focusVisibleControl() || focusCancelled) return;
      const animations = panel.getAnimations();
      if (!animations.length) return;
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (!focusCancelled) focusFrame = requestAnimationFrame(focusVisibleControl);
      });
    });
    const cancelPendingFocus = (): void => { focusCancelled = true; cancelAnimationFrame(focusFrame); };
    // Async options may make the first eligible control available after the opening animation.
    const focusObserver = new MutationObserver(() => {
      if (focusCancelled || focused) return;
      cancelAnimationFrame(focusFrame); focusFrame = requestAnimationFrame(focusVisibleControl);
    });
    focusObserver.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden", "inert"] });
    // A newer pointer/keyboard action owns focus, including during the animation.
    document.addEventListener("pointerdown", cancelPendingFocus, true);
    document.addEventListener("keydown", cancelPendingFocus, true);
    const observer = new ResizeObserver(place); observer.observe(anchor); observer.observe(panel);
    if (placementAnchor !== anchor) observer.observe(placementAnchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelPendingFocus();
      focusObserver.disconnect();
      document.removeEventListener("pointerdown", cancelPendingFocus, true);
      document.removeEventListener("keydown", cancelPendingFocus, true);
      observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, direction, focusKey]);
  const content = <div ref={ref} id={owner} className={`conversation-panel conversation-panel-${direction}`}
    data-open={open} data-wand-popup-owner={owner} aria-hidden={!open} inert={!open}
    style={{ position: "fixed", transition: reduced ? "none" : undefined }}>
    <PopupOwnerProvider owner={owner}>{children}</PopupOwnerProvider>
  </div>;
  return typeof document === "undefined" ? content : createPortal(content, portal ?? document.body);
}
