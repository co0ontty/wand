import { getPersistedExpandState, setPersistedExpandState } from "./chat-scroll.js";

interface TimelineReading {
  expanded: boolean;
  pinned: boolean;
  expectedTop: number;
}

const reading = new WeakMap<HTMLElement, TimelineReading>();
let viewport: HTMLElement | null = null;
let viewportObserver: ResizeObserver | null = null;

function keepOpen(group: HTMLElement): void {
  const key = group.dataset.expandKey;
  if (key && getPersistedExpandState(key) !== true) setPersistedExpandState(key, true);
}

/** Inspecting a row is an explicit reading choice, just like Android onInspect. */
export function holdActivityTimeline(group: HTMLElement): void {
  keepOpen(group);
  const timeline = group.querySelector<HTMLElement>(".chat-activity-timeline");
  const current = timeline && reading.get(timeline);
  if (current) current.pinned = false;
}

export function clearActivityTimelines(): void {
  viewportObserver?.disconnect();
  viewportObserver = null;
  viewport = null;
}

/** Post-presentation only: Ant rows must have their final geometry before following.
 * This owns only the inner scroll position; the chat's outer reading anchor stays
 * with chat-render/chat-scroll. No tool details are fetched by opening a timeline. */
export function syncActivityTimelines(root: HTMLElement): void {
  if (viewport !== root) {
    clearActivityTimelines();
    viewport = root;
    viewportObserver = new ResizeObserver(() => {
      if (root.isConnected && viewport === root) syncActivityTimelines(root);
    });
    viewportObserver.observe(root);
  }
  const height = Math.max(120, Math.min(240, root.clientHeight / 3));
  root.style.setProperty("--chat-activity-panel-height", height + "px");
  for (const group of root.querySelectorAll<HTMLElement>('.chat-activity[data-expand-kind="activity"]')) {
    const timeline = group.querySelector<HTMLElement>(".chat-activity-timeline");
    if (!timeline) continue;
    const expanded = group.dataset.expanded === "true";
    let current = reading.get(timeline);
    if (!expanded) {
      if (current) current.expanded = false;
      continue;
    }
    if (!current) {
      current = { expanded: false, pinned: false, expectedTop: timeline.scrollTop };
      reading.set(timeline, current);
      const position = current;
      const pause = () => {
        if (group.dataset.expanded !== "true") return;
        keepOpen(group);
        position.pinned = false;
      };
      timeline.addEventListener("wheel", event => { if (event.deltaY) pause(); }, { passive: true });
      timeline.addEventListener("touchstart", pause, { passive: true });
      // Scrollbar dragging is reading intent; ordinary row clicks use onInspect.
      timeline.addEventListener("pointerdown", event => { if (event.target === timeline) pause(); }, { passive: true });
      timeline.addEventListener("keydown", event => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pause();
      });
      timeline.addEventListener("scroll", () => {
        if (group.dataset.expanded !== "true" || Math.abs(timeline.scrollTop - position.expectedTop) <= 1) return;
        // Ignore our own tail writes and DOM morph/anchor corrections. A user's
        // scroll can resume following at the bottom, unless a detail is open.
        position.expectedTop = timeline.scrollTop;
        position.pinned = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2;
        keepOpen(group);
      }, { passive: true });
    }
    if (!current.expanded) current.pinned = group.dataset.live === "true";
    current.expanded = true;
    const inspecting = !!group.querySelector('.chat-call[data-expanded="true"]');
    if (current.pinned && !inspecting && !group.closest("[inert]")) {
      timeline.scrollTop = timeline.scrollHeight;
    }
    current.expectedTop = timeline.scrollTop;
  }
}
