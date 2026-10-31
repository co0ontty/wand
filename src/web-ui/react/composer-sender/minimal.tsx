import * as React from "react";
import { flushSync } from "react-dom";
import { WandButton } from "../ui/button.js";
import { hasOpenOwnedPopupSurface, hasOpenPopupSurface } from "../ui/popup-lifecycle.js";

/** Presentation only: the original editor, draft and delivery owner stay mounted. */
export function useMinimalComposer({ owner, input, surface, phase, pending, locked, forceExpanded, defaultExpanded = true, onDismiss, popupOwners = [] }: {
  owner: string;
  input(): HTMLTextAreaElement | null | undefined;
  surface(): HTMLElement | null | undefined;
  phase: string;
  pending: boolean;
  locked?: boolean;
  forceExpanded?: boolean;
  defaultExpanded?: boolean;
  onDismiss?(reason: "outside" | "escape" | "back"): void;
  popupOwners?: readonly string[];
}) {
  const [editing, setEditing] = React.useState(defaultExpanded);
  const [recovery, setRecovery] = React.useState(false);
  const latest = React.useRef({ input, surface, locked, phase, popupOwners, onDismiss, forceExpanded });
  latest.current = { input, surface, locked, phase, popupOwners, onDismiss, forceExpanded };
  React.useLayoutEffect(() => { setEditing(defaultExpanded); setRecovery(false); }, [owner]);
  React.useEffect(() => {
    if (phase === "failed" || phase === "unknown") { setRecovery(true); setEditing(true); }
    if (phase === "sent" && !pending) setRecovery(false);
  }, [phase, pending]);
  const expanded = editing || recovery || !!locked || !!forceExpanded || phase === "sending";
  const expandedNow = React.useRef(expanded); expandedNow.current = expanded;
  React.useEffect(() => {
    const element = input(), host = surface();
    if (!element || !host) return;
    const borrowers = new Set<string>();
    const borrow = (event: Event): void => {
      if (!(event.target instanceof Node) || !host.contains(event.target)) return;
      const { owner, active } = (event as CustomEvent<{ owner: string; active: boolean }>).detail;
      if (active) borrowers.add(owner); else borrowers.delete(owner);
    };
    const focus = (): void => { setEditing(true); };
    const edited = (): void => { setRecovery(false); setEditing(true); };
    const dismiss = (reason: "outside" | "escape" | "back"): void => {
      const current = latest.current;
      if (borrowers.size || current.locked || ["sending", "failed", "unknown"].includes(current.phase)) return;
      setEditing(false); element.blur(); current.onDismiss?.(reason);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !expandedNow.current || event.defaultPrevented || event.isComposing || hasOpenPopupSurface()
        || !host.contains(document.activeElement)) return;
      if (hasOpenOwnedPopupSurface(latest.current.popupOwners)) return;
      // Editing Escape is consumed without hiding the draft or opening the
      // legacy stop-session confirmation. PTY keeps its explicit mode switch.
      event.preventDefault(); event.stopPropagation();
      if (latest.current.forceExpanded) dismiss("escape");
    };
    const back = (): void => { if (!hasOpenPopupSurface()) dismiss("back"); };
    document.addEventListener("wand-composer-focus-borrow", borrow);
    element.addEventListener("focus", focus);
    element.addEventListener("input", edited);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("popstate", back);
    return () => {
      document.removeEventListener("wand-composer-focus-borrow", borrow);
      element.removeEventListener("focus", focus); element.removeEventListener("input", edited);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("popstate", back);
    };
  }, [owner]);
  const currentOwner = React.useRef(owner); currentOwner.current = owner;
  React.useLayoutEffect(() => {
    const element = input();
    if (element) element.tabIndex = expanded ? 0 : -1;
  }, [expanded, owner]);
  const open = (): void => {
    flushSync(() => setEditing(true));
    const element = input();
    if (currentOwner.current !== owner || !element) return;
    element.focus({ preventScroll: true });
    // Sender's autosize pass and a disappearing entry can release focus after
    // the click. Restore only that editor, never a newer owner or another control.
    requestAnimationFrame(() => {
      if (currentOwner.current === owner && element === latest.current.input() && element.isConnected
        && document.activeElement === document.body) element.focus({ preventScroll: true });
    });
  };
  return { expanded, open };
}

export function MinimalComposerEntry({ text, attachments, placeholder, disabled, onOpen }: {
  text: string; attachments: number; placeholder: string; disabled?: boolean; onOpen(): void;
}): React.ReactElement {
  const preview = text.trim().split(/\n/).find(Boolean);
  const label = preview ? `草稿 · ${preview}` : attachments ? `草稿 · ${attachments} 个附件` : placeholder;
  return <WandButton kind="ghost" className="composer-compact-entry" disabled={disabled} aria-label={text || attachments ? "编辑未发送草稿及附件" : "展开文字输入"} onClick={onOpen}>{label}</WandButton>;
}
