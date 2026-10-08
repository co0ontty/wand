// Production adapters and owners; only data/HTTP transport are synthetic.
import { composer, composerQueue, state } from "../../src/web-ui/browser/state.js";
import { renderAppShell, render, renderBootLoading, updateOfflineBanner, resetChatRenderCache } from "../../src/web-ui/browser/render.js";
import { updateQueueBar, attachQueueBarDelegates, buildMessagesForRender, updateTerminalShortcuts, reconcileInteractiveState, captureTerminalInput } from "../../src/web-ui/browser/input.js";
import { doRenderChat } from "../../src/web-ui/browser/chat-render.js";
import { attachEventListeners } from "../../src/web-ui/browser/events.js";
import { showNotificationBubble, wandAlert, wandConfirm, wandPrompt } from "../../src/web-ui/browser/notifications.js";
import { mountBrowserButtons } from "../../src/web-ui/browser/library-buttons.js";
import { installReactUiStyles } from "../../src/web-ui/react/styles.js";
import { startReactUi } from "../../src/web-ui/react/index.js";
import { wandOverlay } from "../../src/web-ui/react/overlay-controller.js";
import { updateSessionSnapshot } from "../../src/web-ui/browser/session-engine.js";

installReactUiStyles();
const frames = async () => {
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  while (document.getAnimations().some(animation => animation.playState === "running"
    && Number.isFinite(animation.effect?.getComputedTiming().endTime)
    && (animation.effect as KeyframeEffect)?.target instanceof Element
    && ((animation.effect as KeyframeEffect).target as Element).getClientRects().length > 0)) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
};
const stats = { actions: 0, queueReplies: 0 };
const realFetch = window.fetch.bind(window);
window.fetch = async (...arguments_) => {
  const response = await realFetch(...arguments_);
  if (String(arguments_[0]).includes("/queued")) stats.queueReplies++;
  return response;
};
function session(queue: string[] = []): any {
  return { id: "panels-A", command: "claude", provider: "claude", sessionKind: "structured", status: "running",
    structuredState: { inFlight: true }, queuedMessages: queue, messages: [], messageTotal: 0, messageOffset: 0 };
}
function publish(next: any): void {
  state.sessions = [next]; state.selectedId = next.id; state.currentView = "chat";
  state.currentMessages = buildMessagesForRender(next, next.messages);
}
(window as any).composerPanels = {
  state, composer, stats, frames, rawOverlay: wandOverlay,
  async setup() {
    publish(session());
    state.notifBubble = true; state.notifSound = false;
    const host = document.createElement("main"); host.id = "panels-source-host";
    host.innerHTML = renderAppShell(); document.body.appendChild(host);
    document.getElementById("output")?.classList.add("hidden");
    document.getElementById("chat-output")?.classList.remove("hidden");
    mountBrowserButtons(host); attachQueueBarDelegates(); attachQueueBarDelegates();
    startReactUi();
    doRenderChat(false); await frames();
  },
  async queue(items: string[]) {
    await fetch("/_fixture/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(items) });
    const next = Object.assign({}, state.sessions[0], { queuedMessages: items });
    publish(next); updateQueueBar(); await frames();
  },
  queueTexts(id = state.selectedId) { return state.sessions.find(item => item.id === id)?.queuedMessages || []; },
  serverQueue(items: string[]) {
    composerQueue.advance(state.selectedId!, "server");
    updateSessionSnapshot({ id: state.selectedId, queuedMessages: items }); updateQueueBar();
  },
  switchFixture(id: string, items: string[]) {
    if (!state.sessions.some(item => item.id === id)) state.sessions.push(Object.assign({}, session(items), { id }));
    state.selectedId = id; updateQueueBar();
    const input = document.getElementById("input-box") as HTMLTextAreaElement;
    composer.edit(id, { text: "new owner's draft" }); input.value = composer.read(id).text;
  },
  dialog(kind: string) {
    return kind === "owned" ? wandPrompt("Owned fallback layer request", "owned-layer-value", { title: "Owned fallback layer probe" })
      : kind === "confirm" ? wandConfirm("Synthetic confirmation")
      : kind === "guarded" ? wandConfirm("Synthetic guarded confirmation", { dismissable: false })
      : kind === "alert" ? wandAlert("Synthetic alert") : wandPrompt("Synthetic input", "kept input");
  },
  async todos(items: any[] | null) {
    const messages = [{ role: "user", uuid: "todo-user", content: [{ type: "text", text: "Synthetic checklist" }] }];
    if (items) messages.push({ role: "assistant", uuid: "todo-assistant", content: [
      { type: "tool_use", id: "panels-todo", name: "TodoWrite", input: { todos: items } },
      { type: "tool_result", tool_use_id: "panels-todo", content: "Updated" },
    ] } as any);
    const next = Object.assign({}, session(), { messages, messageTotal: messages.length });
    publish(next); resetChatRenderCache(); doRenderChat(false); await frames();
  },
  async terminal() {
    publish(Object.assign({}, session(), { sessionKind: "pty" }));
    state.currentView = "terminal"; state.wsConnected = true; state.ws = null;
    composer.edit(state.selectedId!, { text: "", attachments: [] });
    (document.getElementById("input-box") as HTMLTextAreaElement).value = "";
    reconcileInteractiveState(); attachEventListeners();
    updateTerminalShortcuts(); updateTerminalShortcuts(); await frames();
  },
  updateTerminalShortcuts, captureTerminalInput,
  notification(action = false) {
    return showNotificationBubble({ title: "Synthetic notice", body: "Local browser test", duration: 0,
      ...(action ? { actionLabel: "执行测试动作", action: () => { stats.actions++; } } : {}) });
  },
  offline(value: boolean) { state.isOnline = !value; updateOfflineBanner(); },
  async bootToLogin() {
    let app = document.getElementById("app");
    if (!app) { app = document.createElement("div"); app.id = "app"; document.body.appendChild(app); }
    renderBootLoading(); const old = app.querySelector(".boot-loading");
    state.config = null; state.loginChecked = true; render(); await frames();
    return { oldConnected: old?.isConnected, bootCount: app.querySelectorAll(".boot-loading").length,
      passwords: app.querySelectorAll(".ant-input-password").length };
  },
};
