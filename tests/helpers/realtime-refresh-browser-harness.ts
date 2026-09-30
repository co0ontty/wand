// Real browser modules/DOM with synthetic turns; no provider, service or login.
import { state, composer } from "../../src/web-ui/browser/state.js";
import { doRenderChat, renderChat } from "../../src/web-ui/browser/chat-render.js";
import { resetChatRenderCache } from "../../src/web-ui/browser/render.js";
import { applyExpandedState, persistElementExpandState } from "../../src/web-ui/browser/chat-scroll.js";
import { buildMessagesForRender } from "../../src/web-ui/browser/input.js";

const sessionId = "realtime-refresh-fixture";
function setMessages(turns: any[], patch: Record<string, unknown> = {}): void {
  state.selectedId = sessionId;
  const previous = state.sessions.find(session => session.id === sessionId);
  const session = Object.assign({ id: sessionId, command: "claude", sessionKind: "structured",
    status: "idle", structuredState: { inFlight: false }, messages: [] }, previous, patch,
  { messages: turns, messageOffset: 0, messageTotal: turns.length });
  state.sessions = [session];
  state.currentMessages = buildMessagesForRender(session, turns);
}

(window as any).realtimeRefreshHarness = {
  state, composer, setMessages, resetChatRenderCache, doRenderChat, renderChat,
  setExpanded(element: HTMLElement, kind: string, expanded: boolean) {
    applyExpandedState(element, kind, expanded);
    persistElementExpandState(element, kind);
  },
};
