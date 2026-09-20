export function findDialogFocusTarget(
  container: HTMLElement | null,
  selector: string,
): HTMLElement | null {
  if (!container) return null;
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).find((node) => (
    !node.matches(":disabled, [aria-disabled='true']") && node.getClientRects().length > 0
  )) ?? null;
}

/** Hand initial focus to a delayed form only while the user has not started interacting. */
export function watchDialogAutofocus(
  container: HTMLElement,
  fallback: HTMLElement | null,
): () => void {
  const owner = container.ownerDocument;
  const Observer = owner.defaultView?.MutationObserver;
  if (!Observer) return () => {};
  let active = true;
  const observer = new Observer(() => {
    if (!active) return;
    const target = findDialogFocusTarget(container, "[data-wand-autofocus]");
    if (!target) return;
    const stillAtInitialFocus = owner.activeElement === (fallback ?? container);
    stop();
    if (stillAtInitialFocus) target.focus();
  });

  function stop(): void {
    if (!active) return;
    active = false;
    observer.disconnect();
    owner.removeEventListener("pointerdown", stop, true);
    owner.removeEventListener("keydown", stop, true);
  }

  owner.addEventListener("pointerdown", stop, true);
  owner.addEventListener("keydown", stop, true);
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-wand-autofocus", "disabled", "aria-disabled", "hidden", "style", "class"],
  });
  return stop;
}
