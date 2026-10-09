import { getPersistedExpandState, setPersistedExpandState } from "./chat-scroll.js";

interface TimelineReading {
  expanded: boolean;
  paused: boolean;
  expectedTop: number;
}

const reading = new WeakMap<HTMLElement, TimelineReading>();
let viewport: HTMLElement | null = null;
let viewportObserver: ResizeObserver | null = null;

function keepOpen(group: HTMLElement): void {
  const key = group.dataset.expandKey;
  if (key && getPersistedExpandState(key) !== true) setPersistedExpandState(key, true);
}

function isAtTail(timeline: HTMLElement): boolean {
  return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2;
}

/** Opening a row is an explicit reading choice, just like Android onInspect, and makes
 * the open state a user choice. The freeze itself comes from the open detail, so closing
 * it releases the drawer without leaving a pause behind. */
export function holdActivityTimeline(group: HTMLElement): void {
  keepOpen(group);
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
      // A closed drawer holds no reading state: the next open starts at the newest row.
      if (current) { current.expanded = false; current.paused = false; }
      continue;
    }
    if (!current) {
      current = { expanded: false, paused: false, expectedTop: timeline.scrollTop };
      reading.set(timeline, current);
      const position = current;
      const pause = () => {
        if (group.dataset.expanded !== "true") return;
        keepOpen(group);
        position.paused = true;
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
        // Reading intent is recorded at the input event: a wheel that the tail write
        // cancels in the same frame never reaches this handler. A browser clamp after
        // a row reflow or panel animation always lands on the tail, so it only ever
        // releases the pause here, never creates one.
        position.expectedTop = timeline.scrollTop;
        position.paused = !isAtTail(timeline);
        if (position.paused) keepOpen(group);
      }, { passive: true });
    }
    current.expanded = true;
    const inspecting = !!group.querySelector('.chat-call[data-expanded="true"]');
    // Re-derived every frame instead of latched on the open transition, so a live drawer
    // the user never touched cannot drift away from the newest row for good.
    const following = !current.paused || isAtTail(timeline);
    if (group.dataset.live === "true" && following && !inspecting && !group.closest("[inert]")) {
      timeline.scrollTop = timeline.scrollHeight;
    }
    current.expectedTop = timeline.scrollTop;
  }
}
