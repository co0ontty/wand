import { browserButtonKey, isBrowserButtonPair, patchBrowserButton } from "./library-buttons.js";
import { patchChatPresentation, presentChat } from "../react/chat/presentation.js";
import { state } from "./state.js";

/** DOM-only interaction ownership. No draft, selection, submit or scroll state store. */
export interface ChatViewLease {
  id: number;
  sessionId: string | null;
  view: string;
  root: HTMLElement;
}
interface TurnOwner { key: string; displayKey: string; guard: string; blockOffset: number; }
let lease: ChatViewLease | null = null;
let sequence = 0;
let intent = 0;
let turnOwners = new Map<string, TurnOwner>();
let sourceReferences = new WeakMap<object, string>();
let mountObserver: MutationObserver | null = null;

export function invalidateChatInteraction(): void {
  lease = null;
  turnOwners.clear();
  sourceReferences = new WeakMap();
  sequence++;
}
export function retireChatTurnOwners(): void { turnOwners.clear(); sourceReferences = new WeakMap(); }
function removedRoot(records: MutationRecord[]): boolean {
  const root = lease?.root;
  return !!root && records.some(record => Array.from(record.removedNodes).some(node =>
    node === root || (node instanceof Element && node.contains(root))));
}
function checkMount(): void {
  if (mountObserver && removedRoot(mountObserver.takeRecords())) invalidateChatInteraction();
}
export function chatViewLease(root?: HTMLElement): ChatViewLease | null {
  if (typeof HTMLElement === "undefined") return null;
  checkMount();
  const current = root || document.querySelector<HTMLElement>("#chat-output > .chat-messages");
  const view = state.currentView || "chat";
  if (!current?.isConnected || view !== "chat") { invalidateChatInteraction(); return null; }
  if (!lease || lease.root !== current || lease.sessionId !== state.selectedId || lease.view !== view) {
    invalidateChatInteraction();
    lease = { id: ++sequence, sessionId: state.selectedId, view, root: current };
    if (!mountObserver) {
      mountObserver = new MutationObserver(records => { if (removedRoot(records)) invalidateChatInteraction(); });
      mountObserver.observe(document, { childList: true, subtree: true });
    }
  }
  return lease;
}
export function isChatLeaseCurrent(ticket: ChatViewLease | null): boolean {
  checkMount();
  return !!ticket && lease === ticket && ticket.root.isConnected && state.selectedId === ticket.sessionId
    && (state.currentView || "chat") === ticket.view
    && document.querySelector("#chat-output > .chat-messages") === ticket.root;
}
if (typeof document !== "undefined") {
  for (const event of ["focusin", "pointerdown", "wheel", "touchstart"]) {
    document.addEventListener(event, () => { intent++; }, { capture: true, passive: true });
  }
  document.addEventListener("keydown", event => { if (event.key === "Tab") intent++; }, true);
  window.addEventListener("blur", () => { intent++; });
  window.addEventListener("pagehide", invalidateChatInteraction);
  window.addEventListener("beforeunload", invalidateChatInteraction);
}

function realTurn(message: any): boolean {
  return !Array.isArray(message?.content) || !message.content.some((block: any) => block?.__processing || block?.__queued);
}
function turnGuard(message: any): string {
  // Guard the confirmed source coordinate; these fields are NOT stand-alone identities.
  return JSON.stringify([message?.role, message?.author?.id || null, !!message?.notice]);
}
export interface ChatOwnerPlan {
  messages: Array<TurnOwner | null>;
  commit(): void;
}
/** Map the projection to original source references, including hidden Agent-owned turns. */
export function prepareChatOwners(session: any, messages: any[], root: HTMLElement): ChatOwnerPlan | null {
  const view = chatViewLease(root);
  if (!view) return null;
  const raw = Array.isArray(session.messages) ? session.messages : [];
  const rawIndex = new Map<any, number>();
  const rawCounts = new Map<any, number>();
  let coordinate = 0;
  for (const message of raw) {
    if (realTurn(message)) {
      rawIndex.set(message, coordinate++);
      rawCounts.set(message, (rawCounts.get(message) || 0) + 1);
    }
  }
  const ids = new Map<string, number>();
  function idOf(message: any): string | null {
    for (const field of ["uuid", "id", "messageId", "turnId"]) {
      if (typeof message?.[field] === "string" && message[field]) return JSON.stringify([field, message[field]]);
    }
    return null;
  }
  for (const message of messages) {
    const id = idOf(message); if (id) ids.set(id, (ids.get(id) || 0) + 1);
  }
  const next = new Map<string, TurnOwner>();
  const owners = messages.map(message => {
    if (!realTurn(message)) return null;
    const id = idOf(message);
    const sourceIndex = rawIndex.get(message);
    // No cross-row guessing for reparsed PTY/unknown snapshots. Stable IDs still work.
    let reference: string | null = null;
    if (!id && sourceIndex !== undefined && session.sessionKind !== "structured" &&
      rawCounts.get(message) === 1) {
      reference = sourceReferences.get(message) || "reference:" + (++sequence);
      sourceReferences.set(message, reference);
    }
    const source = id && ids.get(id) === 1 ? "id:" + id
      : !id && session.sessionKind === "structured" && sourceIndex !== undefined
        ? "structured:" + ((session.messageOffset || 0) + sourceIndex) : reference;
    if (!source) return null;
    const guard = turnGuard(message);
    const previous = turnOwners.get(source);
    const owner = previous?.guard === guard ? previous : {
      key: "view:" + view.id + ":turn:" + (++sequence),
      displayKey: "source:" + source + ":" + (++sequence), guard, blockOffset: 0,
    };
    // Block cursor describes the first SOURCE turn, never the first visible DOM row.
    const blockOffset = sourceIndex === 0 && Number.isInteger(session.leadingBlockOffset)
      ? session.leadingBlockOffset : 0;
    const current = { ...owner, blockOffset };
    next.set(source, current);
    return current;
  });
  return { messages: owners, commit() { if (isChatLeaseCurrent(view)) turnOwners = next; } };
}

/** Add semantic scope to real existing markup, without a layout wrapper or new control. */
export function scopeChatMarkup(html: string, scope: string): string {
  if (!html || typeof HTMLElement === "undefined") return html;
  const template = document.createElement("template"); template.innerHTML = html;
  Array.from(template.content.children).forEach((element, slot) => {
    element.setAttribute("data-chat-key", JSON.stringify(["block", scope, slot]));
  });
  return template.innerHTML;
}
function explicitKey(element: Element): string | null {
  const libraryButton = browserButtonKey(element); if (libraryButton) return libraryButton;
  if (element.matches(".chat-file-attachment")) return "attachment:" + element.getAttribute("data-path");
  const own = element.getAttribute("data-chat-key"); if (own) return own;
  const entry = element.getAttribute("data-entry-key"); if (entry) return "entry:" + entry;
  if (element.classList.contains("agent-run-agent") || element.classList.contains("agent-run-detail-panel")) {
    return element.tagName + ":agent:" + element.getAttribute("data-agent-run-id") + ":" + element.getAttribute("data-agent-task-id");
  }
  const expand = element.getAttribute("data-expand-key"); if (expand) return "expand:" + expand;
  const tool = element.getAttribute("data-tool-use-id");
  if (tool) return element.tagName + ":tool:" + tool;
  if (element.matches("a[href]")) return "link:" + element.getAttribute("href");
  if (element.matches(".ask-user-option")) return element.tagName + ":option:" +
    element.getAttribute("data-question-index") + ":" + element.getAttribute("data-option-index");
  if (element.matches("button, summary, [role='button']")) {
    return "control:" + structure(element) + ":" + (element.getAttribute("onclick") || "");
  }
  return null;
}
function postChild(node: Node): boolean {
  return node instanceof Element && node.matches(".assistant-reply-disclosure, .assistant-reply-host, .msg-copy-btn");
}
function structure(node: Node): string {
  if (!(node instanceof Element)) return String(node.nodeType);
  // Dynamic state classes don't define the purpose/owner of a node.
  return node.tagName + ":" + Array.from(node.classList).filter(name =>
    !/^(?:is-|collapsed$|expanded$|selected$|copied$|visible$|inline-tool-open$|assistant-reply-(?:collapsed|expanded)$)/.test(name)).join(" ");
}
function attributes(current: Element, next: Element): void {
  const nativeOpen = current instanceof HTMLDetailsElement ? current.open : null;
  const copied = current.matches(".code-copy, .msg-copy-btn") && current.classList.contains("copied");
  const visible = current.matches(".msg-copy-btn") && current.classList.contains("visible");
  const postClasses = current.matches(".chat-message")
    ? ["assistant-reply-collapsed", "assistant-reply-expanded"].filter(name => current.classList.contains(name)) : [];
  if (copied) postClasses.push("copied");
  if (visible) postClasses.push("visible");
  for (const attribute of Array.from(current.attributes)) {
    if (!next.hasAttribute(attribute.name) && attribute.name !== "open" && attribute.name !== "data-x-presentation") current.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) {
    if (attribute.name === "open" && nativeOpen !== null) continue;
    const value = attribute.name === "class" && postClasses.length
      ? Array.from(new Set(attribute.value.split(/\s+/).concat(postClasses))).join(" ") : attribute.value;
    if (current.getAttribute(attribute.name) !== value) current.setAttribute(attribute.name, value);
  }
  if (nativeOpen !== null) (current as HTMLDetailsElement).open = nativeOpen;
  if (copied) current.classList.add("copied");
  if (visible) current.classList.add("visible");
}
function morph(current: Node, next: Node): void {
  if (current.isEqualNode(next)) return;
  if (!(current instanceof Element) || !(next instanceof Element)) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  if (patchBrowserButton(current, next)) return;
  attributes(current, next);
  if (current.matches(".code-copy.copied, .msg-copy-btn.copied")) return;
  const left = current.scrollLeft, top = current.scrollTop;
  // A block-page prepend changes row offsets inside the timeline, not the outer chat.
  // Preserve the actual reading row/control rather than merely restoring its old scrollTop.
  const reading = timelineReadingAnchor(current);
  if (!patchChatPresentation(current, next, morph)) morphChildren(current, next);
  if (current instanceof HTMLElement && current.matches(".chat-activity-timeline")) presentChat(current);
  if (current.scrollLeft !== left) current.scrollLeft = left;
  const nextTop = reading?.node.isConnected && current.contains(reading.node)
    ? top + reading.node.getBoundingClientRect().top - current.getBoundingClientRect().top - reading.top
    : top;
  // Browser clamps legitimately when content is shorter; never jump to its tail.
  if (current.scrollTop !== nextTop) current.scrollTop = nextTop;
}
function timelineReadingAnchor(current: Element): { node: HTMLElement; top: number } | null {
  if (!current.matches(".chat-activity-timeline") || current.closest("[inert]")) return null;
  const bounds = current.getBoundingClientRect();
  const visible = (node: HTMLElement): boolean => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > bounds.top && rect.top < bounds.bottom;
  };
  const active = document.activeElement;
  const node = active instanceof HTMLElement && current.contains(active) && visible(active) ? active
    : Array.from(current.querySelectorAll<HTMLElement>(".chat-call")).find(visible);
  return node ? { node, top: node.getBoundingClientRect().top - bounds.top } : null;
}
function morphChildren(current: Element, next: Element): void {
  const old = Array.from(current.childNodes).filter(node => !postChild(node));
  const fresh = Array.from(next.childNodes);
  const keyed = new Map<string, Node>(); const duplicate = new Set<string>();
  for (const node of old) {
    const key = node instanceof Element ? explicitKey(node) : null;
    if (key) { if (keyed.has(key)) duplicate.add(key); else keyed.set(key, node); }
  }
  const freshKeys = new Set<string>();
  for (const node of fresh) {
    const key = node instanceof Element ? explicitKey(node) : null;
    if (key) { if (freshKeys.has(key)) duplicate.add(key); freshKeys.add(key); }
  }
  const used = new Set<Node>();
  let cursor: ChildNode | null = current.firstChild;
  while (cursor && postChild(cursor)) cursor = cursor.nextSibling;
  fresh.forEach((node, index) => {
    const key = node instanceof Element ? explicitKey(node) : null;
    let existing = key && !duplicate.has(key) ? keyed.get(key) : undefined;
    if (!key) {
      const compatible = (candidate: Node) => !(candidate instanceof Element && explicitKey(candidate))
        && structure(candidate) === structure(node);
      const candidates = old.filter(compatible);
      if (candidates.length === 1 && fresh.filter(compatible).length === 1) existing = candidates[0];
      else if (old.length === fresh.length && old[index] && compatible(old[index])) existing = old[index];
    }
    if (existing && (used.has(existing) || existing.nodeType !== node.nodeType
      || existing instanceof Element && node instanceof Element && existing.tagName !== node.tagName && !isBrowserButtonPair(existing, node))) existing = undefined;
    if (existing) {
      used.add(existing);
      morph(existing, node);
      // Do not detach/reinsert the active ancestor chain. New nodes are inserted around it.
      if (existing !== cursor) {
        if (existing instanceof Element && existing.contains(document.activeElement)) {
          // Move non-active siblings, never remove/reinsert the active ancestor.
          while (cursor && cursor !== existing) {
            const following = cursor.nextSibling; current.appendChild(cursor); cursor = following;
          }
        } else current.insertBefore(existing, cursor);
      }
      cursor = existing.nextSibling;
    } else {
      current.insertBefore(node, cursor); used.add(node);
    }
  });
  for (const node of old) { if (!used.has(node) && node.parentNode === current) current.removeChild(node); }
}
export function patchChatRow(current: HTMLElement, next: HTMLElement): HTMLElement {
  morph(current, next); return current;
}
export function patchChatContents(current: HTMLElement, html: string): void {
  const next = document.createElement(current.tagName);
  next.innerHTML = html;
  morphChildren(current, next);
}
/** Full is a plan scope, not permission to unmount same-owner rows. */
export function reconcileChatRows(root: HTMLElement, html: string): void {
  const template = document.createElement("template"); template.innerHTML = html;
  const old = Array.from(root.children);
  const owners = new Map<string, HTMLElement>();
  for (const node of old) {
    const owner = node.getAttribute("data-chat-owner");
    if (owner) owners.set(owner, node as HTMLElement);
  }
  const wanted = Array.from(template.content.children);
  const used = new Set<Element>();
  let cursor: Element | null = root.firstElementChild;
  for (const node of wanted) {
    const owner = node.getAttribute("data-chat-owner");
    const existing = owner ? owners.get(owner) : null;
    if (existing && !used.has(existing)) {
      patchChatRow(existing, node as HTMLElement); used.add(existing);
      if (existing !== cursor) {
        if (existing.contains(document.activeElement)) {
          while (cursor && cursor !== existing) {
            const following = cursor.nextElementSibling; root.appendChild(cursor); cursor = following;
          }
        } else root.insertBefore(existing, cursor);
      }
      cursor = existing.nextElementSibling;
    } else { root.insertBefore(node, cursor); used.add(node); }
  }
  for (const node of old) { if (!used.has(node) && node.parentElement === root) node.remove(); }
}

function usable(node: Element | null): node is HTMLElement {
  return node instanceof HTMLElement && node.isConnected && !node.closest("[hidden], [inert], .assistant-reply-collapsed .chat-message-content")
    && !node.matches(":disabled, [aria-disabled='true']") && node.getClientRects().length > 0
    && node.matches("button, a[href], summary, [tabindex]");
}
export interface ChatInteractionTicket {
  finish(): void;
  anchor: { node: HTMLElement; top: number } | null;
  current(): boolean;
}
export function beginChatInteraction(root: HTMLElement): ChatInteractionTicket | null {
  const view = chatViewLease(root); if (!view) return null;
  const active = document.activeElement;
  const candidate = active instanceof HTMLElement && root.contains(active) ? active : null;
  const row = candidate?.closest<HTMLElement>(".chat-message");
  const node = !row || row.getAttribute("data-chat-owner")?.startsWith("view:" + view.id + ":") ? candidate : null;
  const version = intent;
  const scopes = node ? [node.closest(".chat-tool-card, .inline-terminal, .inline-diff"), node.closest(".chat-call"),
    node.closest(".chat-activity"), node.closest(".agent-run-process"), node.closest(".agent-run"), row] : [];
  const fallbacks: HTMLElement[] = [];
  for (const scope of scopes) {
    const candidate = scope?.querySelector<HTMLElement>(".chat-tool-header[tabindex], .term-header, .diff-header, .chat-call-button, .chat-process-summary, .agent-run-process-summary, .agent-run-summary, .assistant-reply-disclosure");
    if (candidate && candidate !== node) fallbacks.push(candidate);
  }
  const bounds = root.getBoundingClientRect();
  const rect = node?.getBoundingClientRect();
  const anchor = node && rect && rect.bottom > bounds.top && rect.top < bounds.bottom
    ? { node, top: rect.top - bounds.top } : null;
  const current = () => isChatLeaseCurrent(view) && version === intent;
  return { anchor, current, finish() {
    if (!node || !current() || usable(node) || !document.hasFocus()) return;
    const now = document.activeElement;
    if (now !== node && now !== document.body) return;
    const target = fallbacks.find(usable);
    if (target) target.focus({ preventScroll: true });
    else { root.setAttribute("tabindex", "-1"); root.focus({ preventScroll: true }); }
  } };
}
