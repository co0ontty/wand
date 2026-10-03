// Production renderer with synthetic turns; installed-service acceptance is separate.
import { state } from "../../src/web-ui/browser/state.js";
import { doRenderChat, clearActivityDetailState } from "../../src/web-ui/browser/chat-render.js";
import { resetChatRenderCache } from "../../src/web-ui/browser/render.js";
import { buildMessagesForRender } from "../../src/web-ui/browser/input.js";

let turns: any[] = [];
function publish(next: any[], running = false): void {
  turns = next;
  const session: any = { id: "timeline-fixture", command: "claude", sessionKind: "structured",
    status: running ? "running" : "idle", structuredState: { inFlight: running }, messages: next,
    messageOffset: 0, messageTotal: next.length };
  state.sessions = [session];
  state.selectedId = session.id;
  state.currentMessages = buildMessagesForRender(session, next);
  doRenderChat(false);
}
async function settle(): Promise<void> {
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  while (document.getAnimations().some(animation => animation.playState === "running"
    && Number.isFinite(animation.effect?.getComputedTiming().endTime))) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
}
(window as any).toolTimelineHarness = {
  state, publish, settle, turns: () => turns,
  async fresh(next: any[]) {
    clearActivityDetailState(); state.toolContentCache = {}; state.sessions = [];
    state.selectedId = "timeline-fixture"; state.currentView = "chat";
    resetChatRenderCache(); publish(next); await settle();
  },
};
