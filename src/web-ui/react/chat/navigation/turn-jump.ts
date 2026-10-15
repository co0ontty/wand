/** Synchronous DOM seek. Identity comes verbatim from the rendering owner. */
export function jumpToChatTurn(container: HTMLElement, ownerKey: string, attribute: "data-chat-owner" | "data-presentation-id" | "data-conversation-nav-owner"): boolean {
  if (!container.isConnected) return false;
  const target = Array.from(container.querySelectorAll<HTMLElement>(`[${attribute}]`))
    .find(node => node.getAttribute(attribute) === ownerKey);
  if (!target) return false;
  // Reuse the existing history disclosure, preserving its own persisted state.
  if (target.classList.contains("chat-history-hidden")) {
    container.querySelector<HTMLButtonElement>('.chat-history-summary button[aria-expanded="false"]')?.click();
  }
  if (!target.getClientRects().length) return false;
  const before = target.getAttribute("tabindex");
  target.setAttribute("tabindex", "-1");
  container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
  target.focus({ preventScroll: true });
  target.addEventListener("blur", () => {
    if (before === null) target.removeAttribute("tabindex");
    else target.setAttribute("tabindex", before);
  }, { once: true });
  return true;
}
