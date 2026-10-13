import { state } from "./state";
import { ensureChatMessagesContainer } from "./chat-host";
export { ensureChatMessagesContainer } from "./chat-host";
import { mountChatLoadState } from "./chat-load-state";

import { chatRuntime, type ChatRuntime } from "./chat-render-runtime";
function runtime(): ChatRuntime | null { return loaded ?? (loaded = chatRuntime()); }
interface PaintRequest { sessionId: string; epoch: number; generation: number; root: HTMLElement; force: boolean; }
let loaded: ChatRuntime | null = null;
let pending: Promise<ChatRuntime> | null = null;
let request: PaintRequest | null = null;
let failed: PaintRequest | null = null;
let generation = 0;
let feedback: { root: HTMLElement; failed: boolean; dispose(): void } | null = null;

function current(ticket: PaintRequest): boolean {
  return generation === ticket.generation && state.selectedId === ticket.sessionId
    && (state.chatRenderEpoch || 0) === ticket.epoch && (state.currentView || "chat") === "chat"
    && ticket.root.isConnected && document.querySelector("#chat-output > .chat-messages") === ticket.root;
}
function clearFeedback(): void {
  feedback?.dispose();
  feedback = null;
}
function showFeedback(ticket: PaintRequest, failure: boolean): void {
  if (!current(ticket)) return;
  if (feedback?.root === ticket.root && feedback.failed === failure) return;
  clearFeedback();
  feedback = { root: ticket.root, failed: failure, dispose: mountChatLoadState(ticket.root, failure, () => {
    if (!request || !current(request)) return;
    failed = null;
    renderChat(true);
  }) };
}

/** Download only view code. On completion paint the authoritative latest state,
 * never a copied message snapshot; selection/epoch/root guards reject late work. */
function load(): void {
  if (pending) return;
  pending = import("./chat-render").then(runtime => {
    loaded = runtime;
    const latest = request;
    request = null;
    failed = null;
    // Any clear while the module was loading also retires its internal view cache.
    runtime.clearActivityDetailState();
    clearFeedback();
    if (latest && current(latest)) runtime.renderChat(latest.force);
    return runtime;
  }).catch((error: unknown) => {
    const latest = request;
    if (latest && current(latest)) { failed = latest; showFeedback(latest, true); }
    else clearFeedback();
    // A failed URL is retried only by an explicit action or a new view, not by WS polling.
    console.warn("[wand] chat component download failed");
    return Promise.reject(error);
  }).finally(() => { pending = null; });
  // The failure is represented by owned feedback, not an unhandled rejection.
  void pending.catch(() => {});
}

export function renderChat(forceFullRender = false): void {
  const active = runtime();
  if (active) { active.renderChat(forceFullRender); return; }
  if (!state.selectedId || (state.currentView || "chat") !== "chat") return;
  const root = ensureChatMessagesContainer(document.getElementById("chat-output"));
  if (!root) return;
  const ticket: PaintRequest = { sessionId: state.selectedId, epoch: state.chatRenderEpoch || 0, generation, root,
    force: !!forceFullRender || !!request?.force };
  request = ticket;
  if (failed && failed.generation === generation && failed.sessionId === state.selectedId && failed.root === root) return;
  showFeedback(ticket, false);
  load();
}
export function scheduleChatRender(immediate = false): void {
  const active = runtime();
  if (active) active.scheduleChatRender(immediate);
  else renderChat();
}
export function clearActivityDetailState(): void {
  generation++;
  request = null;
  failed = null;
  clearFeedback();
  runtime()?.clearActivityDetailState();
}

// Scroll and disclosure delegates keep their existing entrypoint while cold.
if (typeof window !== "undefined") (window as any).__scheduleChatRender = () => scheduleChatRender(true);
