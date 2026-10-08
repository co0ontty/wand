// Real production renderer; synthetic source/cached HTTP data only. No fake message controls.
import { state, composer } from "../../src/web-ui/browser/state.js";
import { doRenderChat, renderChat, clearActivityDetailState } from "../../src/web-ui/browser/chat-render.js";
import { resetChatRenderCache } from "../../src/web-ui/browser/render.js";
import { applyCurrentView } from "../../src/web-ui/browser/session-engine.js";
import { buildMessagesForRender } from "../../src/web-ui/browser/input.js";
import { parseJsonResponse } from "../../src/web-ui/react/http-adapter.js";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ImageViewerHost } from "../../src/web-ui/react/image-viewer/host.js";
import { imageViewerController } from "../../src/web-ui/react/image-viewer/controller.js";
import { attachEventListeners } from "../../src/web-ui/browser/events.js";

// Bind the real composer composition/keyboard/draft owner once on its real DOM id.
attachEventListeners();

const frames = async (): Promise<void> => {
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  // A native details close can retire a CSS transition while its old finished
  // promise remains pending. Observe current finite animations, not stale promises.
  while (document.getAnimations().some(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)
      && target instanceof Element && target.getClientRects().length > 0;
  })) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
};
let turns: any[] = [];
let imageHostMounted = false;
function publish(next = turns, patch: Record<string, unknown> = {}): void {
  turns = next;
  const id = state.selectedId || "focus-A";
  const previous = state.sessions.find(session => session.id === id);
  const session: any = Object.assign({ id, command: "claude", sessionKind: "structured", status: "idle",
    structuredState: { inFlight: false }, messageOffset: 0 }, previous, patch, { messages: next });
  session.messageTotal = session.messageOffset + next.length;
  state.sessions = [session];
  state.selectedId = id;
  state.currentMessages = buildMessagesForRender(session, next);
}
(window as any).focusRefreshHarness = {
  state, composer, frames, publish, doRenderChat, renderChat, resetChatRenderCache, clearActivityDetailState, applyCurrentView,
  turns: () => turns,
  openRealImagePreview() {
    if (!imageHostMounted) {
      const host = document.createElement("div"); document.body.appendChild(host);
      createRoot(host).render(React.createElement(ImageViewerHost)); imageHostMounted = true;
    }
    imageViewerController.open("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+1sAAAAASUVORK5CYII=", "合成图片");
  },
  imageViewerController,
  async fresh(next: any[], patch: Record<string, unknown> = {}) {
    clearActivityDetailState(); state.toolContentCache = {}; state.sessions = [];
    state.selectedId = "focus-A"; state.currentView = "chat";
    resetChatRenderCache();
    // Focus/reading fixtures explicitly put their whole small transcript in the
    // local window; viewport pagination has its own real-browser regression.
    state.chatRenderedCount = next.length;
    publish(next, patch); doRenderChat(false); await frames();
  },
  // A synthetic second on-demand HTTP response is accepted in the existing detail cache.
  // No DOM stub, default prefetch or real service: only the data arrival is controlled.
  async acceptDetail(toolId: string) {
    const data = await parseJsonResponse<any>(await fetch("/api/sessions/" + state.selectedId + "/tool-content/" + toolId));
    state.toolContentCache[state.selectedId + ":" + toolId] = data;
  },
  watch(selector: string) {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node || node !== document.activeElement) throw new Error("Real focused message control required: " + selector);
    const chain: Element[] = []; let ancestor: Element | null = node;
    while (ancestor && ancestor !== document.body) { chain.push(ancestor); ancestor = ancestor.parentElement; }
    const glyph = node.querySelector(".chat-activity-chevron, .chat-activity-entry-arrow, svg, .assistant-reply-chevron");
    const row = node.closest(".chat-message");
    const rect = node.getBoundingClientRect().toJSON();
    const container = document.querySelector<HTMLElement>(".chat-messages")!;
    const scroll = container.scrollTop; const triggerText = node.textContent;
    const initialScrollHeight = container.scrollHeight; const initialClientHeight = container.clientHeight;
    let disconnected = false; let blurCount = 0; let replayCount = 0; const changes: MutationRecord[] = [];
    const replay = (event: Event) => {
      if (event.target instanceof Element && row?.contains(event.target) && event.target.matches(
        ".chat-activity-menu, .chat-activity-entry-detail, .agent-run-body, .chat-activity-chevron, .chat-activity-entry-arrow, .assistant-reply-chevron")) replayCount++;
    };
    document.addEventListener("animationstart", replay); document.addEventListener("transitionrun", replay);
    const observer = new MutationObserver(records => {
      changes.push(...records);
      if (records.some(record => Array.from(record.removedNodes).some(removed =>
        chain.some(part => removed === part || (removed instanceof Element && removed.contains(part)))))) disconnected = true;
    });
    observer.observe(document.querySelector("#chat-output")!, { childList: true, subtree: true, characterData: true });
    const blurred = () => { blurCount++; }; node.addEventListener("blur", blurred);
    return {
      node, chain, row, glyph, rect, scroll,
      result() {
        const records = observer.takeRecords();
        if (records.some(record => Array.from(record.removedNodes).some(removed =>
          chain.some(part => removed === part || (removed instanceof Element && removed.contains(part)))))) disconnected = true;
        changes.push(...records); observer.disconnect(); node.removeEventListener("blur", blurred);
        document.removeEventListener("animationstart", replay); document.removeEventListener("transitionrun", replay);
        return { focusedBefore: true, focusedAfter: document.activeElement === node,
          activeTag: document.activeElement?.tagName, originalConnected: node.isConnected,
          chainContinuous: !disconnected && chain.every(part => part.isConnected), blurCount,
          glyphSame: !glyph || node.contains(glyph), rectBefore: rect, rectAfter: node.getBoundingClientRect().toJSON(),
          triggerTextBefore: triggerText, triggerTextAfter: node.textContent,
          scrollBefore: scroll, scrollAfter: container.scrollTop,
          scrollHeightBefore: initialScrollHeight, clientHeightBefore: initialClientHeight,
          scrollHeightAfter: container.scrollHeight, clientHeightAfter: container.clientHeight,
          flexDirection: getComputedStyle(container).flexDirection,
          documentScroll: document.scrollingElement?.scrollTop, visualViewportTop: visualViewport?.offsetTop,
          mutationCount: changes.length, replayCount, owner: row?.getAttribute("data-chat-owner") || row?.getAttribute("data-message-key") };
      },
    };
  },
};
