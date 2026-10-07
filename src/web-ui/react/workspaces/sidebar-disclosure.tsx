import * as React from "react";
import { Collapse } from "antd";
import { WandUiBoundary } from "../theme";
import { WandIcon } from "../ui/icons";
import {
  SidebarPresentationContext,
  sidebarExpansionOpen,
} from "./sidebar-display-mode";

/** The library chevron points down: closed points right, open points into the children. */
export function SidebarChevron({ open, size = 16, className = "" }: {
  open: boolean; size?: number; className?: string;
}): React.ReactElement {
  return <span className="sidebar-disclosure-chevron" data-open={open} aria-hidden="true">
    <WandIcon name="chevronDown" size={size} className={className}/>
  </span>;
}

export function useSidebarCollapsed(
  key: string,
  defaultCollapsed = false,
): [boolean, () => void, (collapsed: boolean) => void] {
  const scope = React.useContext(SidebarPresentationContext);
  const storageKey = `wand.sidebar.${key}`;
  const read = (): boolean => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved === null ? defaultCollapsed : saved === "true";
    } catch {
      return defaultCollapsed;
    }
  };
  const [local, setLocal] = React.useState(read);
  const collapsed = scope?.normal[key] ?? local;
  const update = (next: boolean): void => {
    setLocal(next);
    scope?.setNormal(key, next);
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      return;
    }
  };
  return [collapsed, () => update(!collapsed), update];
}

/** Temporary modes never read/write the old recentFolded / expandedTask storage. */
export function useSidebarExpansion(
  key: string,
  defaultCollapsed = false,
  foldedOpen = false,
  fullOpen?: boolean,
): [boolean, (open: boolean) => void] {
  const scope = React.useContext(SidebarPresentationContext);
  const [collapsed, , setCollapsed] = useSidebarCollapsed(key, defaultCollapsed);
  const [normalTouched, setNormalTouched] = React.useState(() => {
    try { return window.localStorage.getItem(`wand.sidebar.${key}`) !== null; }
    catch { return false; }
  });
  const hasNormalChoice = normalTouched || scope?.normal[key] !== undefined;
  const open = sidebarExpansionOpen(
    scope?.mode ?? "full",
    hasNormalChoice ? !collapsed : fullOpen ?? !collapsed,
    scope?.overrides[key],
    foldedOpen,
    Boolean(scope?.query.trim()),
  );
  const update = (next: boolean): void => {
    if (scope?.query.trim()) return;
    if (!scope || scope.mode === "full") { setNormalTouched(true); setCollapsed(!next); }
    else scope.setOverride(key, next);
  };
  return [open, update];
}

/** Anchor a closing head even when the browser clamps scrollTop at the bottom. */
export function anchorSidebarDisclosure(trigger: HTMLElement, change: () => void): void {
  const scroller = trigger.closest<HTMLElement>(".sidebar-peek-body, .sidebar-body");
  if (!scroller) { change(); return; }
  const y = trigger.getBoundingClientRect().top;
  const id = trigger.getAttribute("aria-controls");
  const contentToClose = id ? scroller.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) : null;
  if (trigger.getAttribute("aria-expanded") === "true" && contentToClose?.contains(document.activeElement)) {
    trigger.focus({ preventScroll: true });
  }
  let spacer = scroller.querySelector<HTMLElement>(":scope > .sidebar-scroll-compensation");
  if (!spacer) {
    spacer = document.createElement("div");
    spacer.className = "sidebar-scroll-compensation";
    spacer.setAttribute("aria-hidden", "true");
    spacer.inert = true;
    scroller.append(spacer);
  }
  const tail = spacer;
  const restore = (): void => {
    if (!trigger.isConnected) { release(); return; }
    const delta = trigger.getBoundingClientRect().top - y;
    if (Math.abs(delta) < 1) return;
    const target = scroller.scrollTop + delta;
    const missing = Math.max(0, target - (scroller.scrollHeight - scroller.clientHeight));
    if (missing) tail.style.height = `${tail.offsetHeight + missing}px`;
    scroller.scrollTop = target;
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
  const content = scroller.firstElementChild;
  if (content) observer?.observe(content);
  const release = (): void => {
    observer?.disconnect();
    tail.remove();
    scroller.removeEventListener("wheel", release);
    scroller.removeEventListener("touchstart", release);
    scroller.removeEventListener("pointerdown", release);
    scroller.removeEventListener("keydown", release);
    window.removeEventListener("resize", release);
  };
  // Only the next deliberate scroll/resize releases compensation, not our scroll writes.
  scroller.addEventListener("wheel", release, { once: true, passive: true });
  scroller.addEventListener("touchstart", release, { once: true, passive: true });
  scroller.addEventListener("pointerdown", release, { once: true });
  scroller.addEventListener("keydown", release, { once: true });
  window.addEventListener("resize", release, { once: true });
  change();
  requestAnimationFrame(restore);
}

export function sidebarDisclosureKeys(
  event: React.KeyboardEvent<HTMLElement>,
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  event.preventDefault();
  const next = event.key === "ArrowRight";
  if (next !== open) anchorSidebarDisclosure(event.currentTarget, () => setOpen(next));
}

export function SidebarDisclosure({
  id,
  open,
  children,
}: {
  id: string;
  open: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const content = ref.current;
    if (!content) return;
    const sidebar = content.closest(".sidebar");
    const panel = content.closest(".workspaces-panel");
    const root = sidebar ?? panel;
    const owner = root?.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`);
    // Capture ancestors and the peek's public exit before React detaches the task row.
    // The preview panel itself has neither a directory head nor global tools.
    const candidates: Array<HTMLElement | null | undefined> = [owner];
    let ancestor = content.parentElement?.closest<HTMLElement>(".wand-sidebar-disclosure");
    while (ancestor) {
      candidates.push(root?.querySelector<HTMLElement>(
        `[aria-controls="${CSS.escape(ancestor.id)}"]`,
      ));
      ancestor = ancestor.parentElement?.closest<HTMLElement>(".wand-sidebar-disclosure");
    }
    candidates.push(...Array.from(content.closest(".sidebar-peek")?.querySelectorAll<HTMLElement>(
      ".sidebar-peek-header button",
    ) ?? []), ...Array.from(root?.querySelectorAll<HTMLElement>(
      ".sidebar-list-actions button, .sidebar-header-actions button",
    ) ?? []));
    const restoreFocus = (): void => {
      candidates.find((candidate) => candidate?.isConnected
        && !candidate.matches(":disabled")
        && !candidate.closest('[inert], [aria-hidden="true"]')
        && candidate.getClientRects().length > 0
        && getComputedStyle(candidate).visibility !== "hidden")?.focus({ preventScroll: true });
    };
    if (!open && content.contains(document.activeElement)) restoreFocus();
    return () => {
      if (!content.contains(document.activeElement)) return;
      restoreFocus();
      queueMicrotask(() => {
        // A head focused before removal may have gone too. Do not steal a new external focus.
        if (document.activeElement !== document.body && !content.contains(document.activeElement)) return;
        restoreFocus();
      });
    };
  }, [id, open]);
  return (
    <div ref={ref} id={id} className="wand-sidebar-disclosure" data-open={open}
      inert={!open} aria-hidden={!open}>
      <WandUiBoundary><Collapse ghost activeKey={open ? [id] : []}
        items={[{ key: id, label: null, showArrow: false, collapsible: "disabled",
          forceRender: true, children,
          styles: { header: { display: "none" }, body: { padding: 0 } },
        }]}/></WandUiBoundary>
    </div>
  );
}
