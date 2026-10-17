import { readMotionTokenMs } from "../react/ui/motion-tokens.js";

/** Reflow the existing viewport, retaining a real reading node rather than a
 * pixel distance from the (column-reverse) tail. User input retires this short
 * geometry lease immediately; new output never starts one. */
export interface ChatSubtaskReadingLease {
  restore(): void;
  cancel(): void;
  active(): boolean;
}

export function captureChatSubtaskReading(output: HTMLElement): ChatSubtaskReadingLease {
  const scroll = output.querySelector<HTMLElement>(":scope > .chat-messages");
  const bounds = scroll?.getBoundingClientRect();
  const top = scroll?.scrollTop || 0;
  const atTail = Math.abs(top) < 2;
  const anchor = scroll && bounds ? Array.from(scroll.querySelectorAll<HTMLElement>(
    ".chat-message-content p, .chat-message-content li, .chat-message-text",
  )).filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
  }).sort((a, b) => Math.abs(a.getBoundingClientRect().top - bounds.top)
    - Math.abs(b.getBoundingClientRect().top - bounds.top))[0] : null;
  const anchorTop = anchor && bounds ? anchor.getBoundingClientRect().top - bounds.top : 0;
  if (!scroll) return { restore() {}, cancel() {}, active: () => false };
  let frame = 0;
  let stopped = false;
  const restore = (): void => {
    if (!scroll.isConnected || stopped) return;
    if (atTail) scroll.scrollTop = 0;
    else if (anchor?.isConnected) scroll.scrollTop += anchor.getBoundingClientRect().top
      - scroll.getBoundingClientRect().top - anchorTop;
    else scroll.scrollTop = top;
  };
  const cancel = (): void => {
    stopped = true; cancelAnimationFrame(frame); clearTimeout(timer);
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) document.removeEventListener(name, onIntent, true);
  };
  const onIntent = (event: Event): void => {
    // Working in the other pane must not retire a still-reflowing main reader.
    if (event.target instanceof Node && scroll.contains(event.target)) cancel();
  };
  const timer = setTimeout(cancel, readMotionTokenMs("--motion-normal") + readMotionTokenMs("--motion-fast"));
  for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) document.addEventListener(name, onIntent, { capture: true, passive: true });
  restore();
  frame = requestAnimationFrame(function track() { restore(); if (!stopped) frame = requestAnimationFrame(track); });
  return { restore, cancel, active: () => !stopped };
}
