import { readMotionTokenMs } from "../ui/motion-tokens.js";

const disclosureAnchors = new WeakMap<HTMLElement, () => void>();
const disclosurePadding = new WeakMap<HTMLElement, string>();
/** Keep the trigger stationary through the disclosure's height transition.
 * Explicit scrolling cancels the anchor immediately; it never follows new output. */
export function preserveDisclosurePosition(control: HTMLElement, change: () => void): void {
  // Execution transcripts are reversed; IM transcripts use their own forward
  // reading scroller. Both must keep the clicked header, not follow the new tail.
  const scroller = control.closest<HTMLElement>(".chat-messages, .conversation-message-scroll");
  const reverse = !!scroller && getComputedStyle(scroller).flexDirection === "column-reverse";
  const before = control.getBoundingClientRect();
  const bounds = scroller?.getBoundingClientRect();
  const visible = !!bounds && before.bottom > bounds.top && before.top < bounds.bottom;
  disclosureAnchors.get(scroller!)?.();
  const closing = control.getAttribute("aria-expanded") === "true";
  const owner = control.closest(".chat-message");
  const restore = () => {
    if (scroller && visible && control.isConnected) {
      scroller.scrollTop += control.getBoundingClientRect().top - before.top;
      const remaining = control.getBoundingClientRect().top - before.top;
      // A bottom-aligned short conversation has no scroll range yet. Reserve
      // reading space ABOVE it so disclosure can grow below its trigger rather
      // than lifting that trigger. The reserve is capped by viewport + detail.
      if (remaining < -1 && reverse) {
        if (!disclosurePadding.has(scroller)) disclosurePadding.set(scroller, scroller.style.paddingTop);
        const css = getComputedStyle(scroller);
        const rows = Array.from(scroller.children).filter(node => node.getBoundingClientRect().height > 0);
        const used = rows.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0)
          + Math.max(0, rows.length - 1) * (parseFloat(css.rowGap) || 0) + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
        scroller.style.paddingTop = (parseFloat(css.paddingTop) + Math.max(0, scroller.clientHeight - used) - remaining) + "px";
        scroller.scrollTop += control.getBoundingClientRect().top - before.top;
      }
    }
  };
  change(); restore();
  if (!scroller || !visible || !owner) return;
  const observer = new ResizeObserver(restore);
  observer.observe(owner);
  let frame = requestAnimationFrame(function anchorFrame() { restore(); frame = requestAnimationFrame(anchorFrame); });
  const cancel = () => {
    observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer);
    for (const event of ["wheel", "touchstart"]) scroller.removeEventListener(event, cancel);
    for (const event of ["pointerdown", "keydown"]) document.removeEventListener(event, cancel, true);
    disclosureAnchors.delete(scroller);
  };
  // History prepends and focus restoration emit synthetic scroll/focus events.
  // Only actual pointer/keyboard/touch/wheel input cancels this short layout
  // lease; focus restoration must not retire it before an async detail paints.
  const timer = setTimeout(() => {
    if (closing && disclosurePadding.has(scroller) && !scroller.querySelector('.chat-activity[data-expanded="true"], .chat-tool-card:not(.collapsed), .inline-terminal[data-expanded="true"], .inline-tool-open')) {
      scroller.style.paddingTop = disclosurePadding.get(scroller)!;
      disclosurePadding.delete(scroller);
      restore();
    }
    cancel();
  }, readMotionTokenMs("--motion-normal") + readMotionTokenMs("--motion-fast"));
  for (const event of ["wheel", "touchstart"]) scroller.addEventListener(event, cancel, { passive: true });
  for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, cancel, { capture: true, passive: true });
  disclosureAnchors.set(scroller, cancel);
}
