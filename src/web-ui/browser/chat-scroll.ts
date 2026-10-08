import { state, CHAT_EXPAND_STATE_STORAGE_KEY } from "./state";
import { renderChat } from "./chat-render";
import { fetchEarlierMessages } from "./session-engine";
import { ChatHistoryPrefetchGate, chatHistoryRootMargin, needsChatHistoryBuffer } from "../chat-history-window.js";
import { updateBrowserButtonLabel } from "./library-buttons.js";
import "./events";
import "./render";
// import { iconSvg } from "./i18n";

// TODO: import from correct module when created

function getChatScrollElement() {
  var chatOutput = document.getElementById("chat-output");
  // Lookup must not replace the bound-listener owner. Otherwise an empty →
  // nonempty transcript makes bindChatScrollListener mistake a new root for
  // the old bound one, losing manual-scroll/sticky handlers.
  return chatOutput?.querySelector(".chat-messages") || null;
}

// column-reverse: scrollTop=0 是视觉底部，越往上看 scrollTop 绝对值越大。
// 部分浏览器历史上在 column-reverse 里给负 scrollTop，所以用绝对值更稳。
export function isChatNearBottom(chatMsgs?: any) {
  var el = chatMsgs || getChatScrollElement();
  if (!el) return true;
  return Math.abs(el.scrollTop) < state.chatScrollThreshold;
}

export function clearChatUnread(options?: any) {
  options = options || {};
  var hadUnread = state.chatUnreadCount > 0 || state.chatUnreadStartIndex >= 0;
  state.chatUnreadCount = 0;
  state.chatUnreadStartIndex = -1;
  if (options.removeDivider !== false) {
    var chatMsgs = getChatScrollElement();
    if (chatMsgs) {
      var divider = chatMsgs.querySelector(".chat-unread-divider");
      if (divider && divider.parentNode) divider.parentNode.removeChild(divider);
    }
  }
  if (hadUnread) updateChatUnreadBubble();
}

// 在 chatMessages 容器里把"未读分割线"放到正确位置——visually 在
// 最后一条已读和第一条未读中间。column-reverse 下 DOM[0] 是最新（视觉底部），
// 所以分割线在 DOM 里应该插到"第一条已读消息"之前。
export function refreshChatUnreadDivider(chatMessages?: any) {
  if (!chatMessages) chatMessages = getChatScrollElement();
  if (!chatMessages) return;
  var existing = chatMessages.querySelector(".chat-unread-divider");
  if (state.chatUnreadStartIndex < 0 || state.chatUnreadCount <= 0) {
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    return;
  }
  var startIdx = state.chatUnreadStartIndex;
  // 找到 DOM 里第一条 originalIndex < startIdx 的消息——它紧邻分割线下方（DOM 顺序），
  // 也就是视觉上紧贴在分割线"上方"（column-reverse）。
  var nodes = chatMessages.querySelectorAll(".chat-message");
  var boundary = null;
  for (var i = 0; i < nodes.length; i++) {
    var idxAttr = nodes[i].getAttribute("data-msg-index");
    if (idxAttr === null) continue;
    var idx = parseInt(idxAttr, 10);
    if (!isNaN(idx) && idx < startIdx) { boundary = nodes[i]; break; }
  }
  // 没找到 boundary：未读消息覆盖了整个可见窗口——把分割线挂到末尾即可。
  var label = state.chatUnreadCount + " 条新消息";
  if (!existing) {
    existing = document.createElement("div");
    existing.className = "chat-unread-divider";
    existing.setAttribute("role", "separator");
    existing.innerHTML = '<span class="chat-unread-divider-line"></span>'
      + '<span class="chat-unread-divider-label"></span>'
      + '<span class="chat-unread-divider-line"></span>';
  }
  existing.querySelector(".chat-unread-divider-label").textContent = label;
  if (boundary) {
    if (existing.nextSibling !== boundary || existing.parentNode !== chatMessages) {
      chatMessages.insertBefore(existing, boundary);
    }
  } else {
    if (existing.parentNode !== chatMessages || existing.nextSibling !== null) {
      chatMessages.appendChild(existing);
    }
  }
}

export function updateChatUnreadBubble() {
  var bubble = document.getElementById("chat-unread-bubble");
  if (!bubble) return;
  var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  var notAtBottom = !isChatNearBottom();
  // 显示条件：有选中会话 + 在 chat 视图 + 用户已经滚开了底部。
  // 不强制要求有未读——用户主动滚上去时也给一个"回到底部"的入口。
  var shouldShow = !!selectedSession && state.currentView === "chat" && notAtBottom;
  bubble.classList.toggle("visible", shouldShow);
  bubble.classList.toggle("has-unread", state.chatUnreadCount > 0);
  var countEl = bubble.querySelector(".chat-unread-bubble-count");
  if (countEl) {
    if (state.chatUnreadCount > 0) {
      countEl.textContent = state.chatUnreadCount > 99 ? "99+" : String(state.chatUnreadCount);
      countEl.classList.add("visible");
    } else {
      countEl.textContent = "";
      countEl.classList.remove("visible");
    }
  }
  var label = state.chatUnreadCount > 0
    ? (state.chatUnreadCount + " 条新消息，点击查看")
    : "回到最新消息";
  bubble.setAttribute("aria-label", label);
  bubble.setAttribute("title", label);
  var chatContainer = document.getElementById("chat-output");
  if (chatContainer) chatContainer.classList.toggle("has-jump-btn", shouldShow);
}

export function scrollChatToBottom(smooth?: boolean) {
  var chatMsgs = getChatScrollElement();
  if (!chatMsgs || !(chatMsgs as any).isConnected) return;
  state.chatIsProgrammaticScroll = true;
  var done = function() {
    state.chatIsProgrammaticScroll = false;
    state.chatStickToBottom = true;
    clearChatUnread({ removeDivider: true });
    updateChatUnreadBubble();
  };
  if (smooth && typeof (chatMsgs as any).scrollTo === "function") {
    (chatMsgs as any).scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(done, 260);
    return;
  }
  (chatMsgs as any).scrollTop = 0;
  requestAnimationFrame(done);
}

// 发送新消息前同步进入"贴底跟随"。和 scrollChatToBottom 不同，这里必须
// 立即更新状态；否则随后的 optimistic render 会先按"用户正在读历史"锚点恢复，
// 新消息/回复就不会出现在底部。
export function prepareChatBottomFollow() {
  var chatMsgs = getChatScrollElement();
  state.chatStickToBottom = true;
  clearChatUnread({ removeDivider: true });
  if (chatMsgs && (chatMsgs as any).isConnected) {
    state.chatIsProgrammaticScroll = true;
    state.chatProgrammaticScrollUntil = Date.now() + 180;
    (chatMsgs as any).scrollTop = 0;
    requestAnimationFrame(function() { state.chatIsProgrammaticScroll = false; });
  }
  updateChatUnreadBubble();
}

export function bindChatScrollListener() {
  var chatMsgs = getChatScrollElement();
  if (!chatMsgs || !(chatMsgs as any).isConnected) return;
  if (state.chatScrollElement === chatMsgs && state.chatScrollHandler) {
    updateChatUnreadBubble();
    return;
  }
  if (state.chatScrollElement) {
    if (state.chatScrollHandler) {
      state.chatScrollElement.removeEventListener("scroll", state.chatScrollHandler);
    }
    if (state.chatScrollWheelHandler) {
      state.chatScrollElement.removeEventListener("wheel", state.chatScrollWheelHandler);
    }
    if (state.chatScrollTouchStartHandler) {
      state.chatScrollElement.removeEventListener("touchstart", state.chatScrollTouchStartHandler);
    }
    if (state.chatScrollTouchMoveHandler) {
      state.chatScrollElement.removeEventListener("touchmove", state.chatScrollTouchMoveHandler);
    }
  }
  state.chatScrollElement = chatMsgs;

  function handleManualHistoryScroll() {
    state.chatStickToBottom = false;
    if (chatMsgs.querySelector(".chat-history-summary")) {
      renderChat(true);
    }
    updateChatUnreadBubble();
  }

  state.chatScrollHandler = function() {
    if (!(chatMsgs as any).isConnected) return;
    checkChatHistoryBuffer();
    // 程序触发的滚动（点了气泡 / 发送后贴底）不算"用户翻页"——别把状态弄乱。
    if (state.chatIsProgrammaticScroll || Date.now() < state.chatProgrammaticScrollUntil) {
      updateChatUnreadBubble();
      return;
    }
    // 用户真的手动滚了——回到普通贴底逻辑。
    var atBottom = isChatNearBottom(chatMsgs);
    if (atBottom) {
      // 用户自己滚到底了——清未读、贴回底部、撤下气泡。
      state.chatStickToBottom = true;
      clearChatUnread({ removeDivider: true });
    } else {
      // 用户主动往上翻——脱离贴底状态。新消息只会累积到气泡，不滚视图。
      handleManualHistoryScroll();
      return;
    }
    updateChatUnreadBubble();
  };
  // wheel/touch 提前下台：浏览器要等惯性产生位移才触发 scroll 事件，
  // 这一帧空窗里如果有 streaming chunk 进来，会在 sticky=true 状态下
  // 被强制贴底。监听用户开始上滚的瞬间立刻把 sticky 翻成 false，
  // 避免那一帧的拽回。column-reverse 下 deltaY<0（滚轮上推）= 看历史。
  state.chatScrollWheelHandler = function(e: any) {
    if (state.chatIsProgrammaticScroll) return;
    if (e.deltaY < 0) {
      handleManualHistoryScroll();
    }
  };
  state.chatScrollTouchStartHandler = function(e: any) {
    if (!e.touches || e.touches.length === 0) return;
    state.chatTouchStartY = e.touches[0].clientY;
  };
  state.chatScrollTouchMoveHandler = function(e: any) {
    if (state.chatIsProgrammaticScroll) return;
    if (!e.touches || e.touches.length === 0) return;
    // column-reverse 下：手指向下拖（clientY 变大）= 内容向下走 = 看历史。
    var deltaY = e.touches[0].clientY - state.chatTouchStartY;
    if (deltaY > 4) {
      handleManualHistoryScroll();
    }
  };
  chatMsgs.addEventListener("scroll", state.chatScrollHandler, { passive: true });
  chatMsgs.addEventListener("wheel", state.chatScrollWheelHandler, { passive: true });
  chatMsgs.addEventListener("touchstart", state.chatScrollTouchStartHandler, { passive: true });
  chatMsgs.addEventListener("touchmove", state.chatScrollTouchMoveHandler, { passive: true });
  updateChatUnreadBubble();
}

const historyPrefetch = new ChatHistoryPrefetchGate();

/** First reveal a small local page, then request a bounded earlier server page. */
function loadMoreChatMessages(manual = false): void {
  var session = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  if (!session || state.currentView !== "chat") return;
  var scope = session.id + ":" + (state.chatRenderEpoch || 0);
  var local = state.chatRenderedCount < state.currentMessages.length;
  // A stream update at the tail is not progress on a failed history request.
  // Only the remote head cursor may unlock automatic server-page retries.
  var cursor = local ? "local:" + state.chatRenderedCount + ":" + state.currentMessages.length
    : "server:" + (session.messageOffset || 0) + ":" + (session.leadingBlockOffset || 0);
  if (!historyPrefetch.canAttempt(scope, cursor, manual)) return;
  if (local) {
    historyPrefetch.attempted(scope, cursor);
    state.chatRenderedCount = Math.min(state.currentMessages.length, state.chatRenderedCount + state.chatPageSize);
    renderChat(true);
  } else if ((session.messageOffset > 0 || session.leadingBlockOffset > 0) && fetchEarlierMessages()) {
    historyPrefetch.attempted(scope, cursor);
  }
}

function checkChatHistoryBuffer(): void {
  if (document.hidden || state.currentView !== "chat") return;
  var root = getChatScrollElement();
  if (!root?.isConnected || !document.getElementById("chat-load-more-sentinel")) return;
  if (needsChatHistoryBuffer(root)) loadMoreChatMessages();
}

let historyRefillFrame: number | null = null;
function scheduleChatHistoryBufferCheck(): void {
  if (historyRefillFrame !== null) cancelAnimationFrame(historyRefillFrame);
  var sessionId = state.selectedId;
  var epoch = state.chatRenderEpoch || 0;
  historyRefillFrame = requestAnimationFrame(function() {
    historyRefillFrame = null;
    if (state.selectedId === sessionId && (state.chatRenderEpoch || 0) === epoch) checkChatHistoryBuffer();
  });
}

document.addEventListener("visibilitychange", function() {
  if (!document.hidden) scheduleChatHistoryBufferCheck();
});

/** Captured session/generation owns feedback; late requests cannot touch another view. */
export function setChatHistoryLoadState(sessionId: string, epoch: number, phase: "loading" | "idle" | "failed"): void {
  if (state.selectedId !== sessionId || (state.chatRenderEpoch || 0) !== epoch) return;
  var sentinel = document.getElementById("chat-load-more-sentinel");
  var button = sentinel?.querySelector<HTMLElement>(".chat-load-more-btn");
  if (!sentinel || !button) return;
  sentinel.dataset.historyLoad = phase;
  updateBrowserButtonLabel(button, phase === "loading" ? "正在加载更早内容…"
    : phase === "failed" ? "加载失败 · 点击重试" : "加载更早的消息", false);
  button.setAttribute("aria-busy", String(phase === "loading"));
  // Called after the single-flight lock is released. A same-height page may
  // trigger neither IntersectionObserver nor ResizeObserver again, so keep
  // filling explicitly, one request/layout frame at a time. Failed/no-progress
  // replies do not schedule another attempt.
  if (phase === "idle") scheduleChatHistoryBufferCheck();
}

var _loadMoreObserver: IntersectionObserver | null = null;
var _historyResizeObserver: ResizeObserver | null = null;
export function observeLoadMoreSentinel(): void {
  if (historyRefillFrame !== null) { cancelAnimationFrame(historyRefillFrame); historyRefillFrame = null; }
  _loadMoreObserver?.disconnect(); _loadMoreObserver = null;
  _historyResizeObserver?.disconnect(); _historyResizeObserver = null;
  var sentinel = document.getElementById("chat-load-more-sentinel");
  var root = getChatScrollElement();
  if (!sentinel || !root) return;
  var button = sentinel.querySelector<HTMLElement>(".chat-load-more-btn");
  if (button) button.onclick = function() { loadMoreChatMessages(true); };
  var sessionId = state.selectedId;
  var epoch = state.chatRenderEpoch || 0;
  var current = function() {
    return state.selectedId === sessionId && (state.chatRenderEpoch || 0) === epoch
      && root.isConnected && sentinel.isConnected && document.getElementById("chat-load-more-sentinel") === sentinel;
  };
  var observe = function() {
    _loadMoreObserver?.disconnect();
    if (!current() || root.clientHeight <= 0) return;
    if (typeof IntersectionObserver !== "undefined") {
      _loadMoreObserver = new IntersectionObserver(function(entries) {
        if (current() && entries.some(function(entry) { return entry.isIntersecting; })) checkChatHistoryBuffer();
      }, { root: root, rootMargin: chatHistoryRootMargin(root.clientHeight) });
      _loadMoreObserver.observe(sentinel);
    }
    checkChatHistoryBuffer();
  };
  // Desktop, touch and native WebViews share the same measured two-screen buffer.
  // Prepending preserves the renderer's existing reading anchor, not scroll-to-top.
  observe();
  if (typeof ResizeObserver !== "undefined") {
    _historyResizeObserver = new ResizeObserver(observe);
    _historyResizeObserver.observe(root);
  }
}

// Helper function to persist selected session ID to localStorage
export function persistSelectedId() {
  try {
    if (state.selectedId) {
      localStorage.setItem("wand-selected-session", state.selectedId);
    } else {
      localStorage.removeItem("wand-selected-session");
    }
  } catch (e) {
    // Ignore localStorage errors
  }
}

export function getStructuredQueuedInputs(session: any) {
  if (session && Array.isArray(session.queuedMessages)) {
    return session.queuedMessages;
  }
  return state.structuredInputQueue;
}

function getSelectedStructuredQueuedInputs() {
  var session = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  return getStructuredQueuedInputs(session);
}

export function syncStructuredQueueFromSession(session: any) {
  var queued = getStructuredQueuedInputs(session);
  state.structuredInputQueue = Array.isArray(queued) ? queued.slice() : [];
}

function hasRenderOnlyStructuredBlock(message: any, marker: string) {
  return !!(message && Array.isArray(message.content) && message.content.some(function(block: any) {
    return block && typeof block === "object" && block[marker];
  }));
}

function isQueuedStructuredMessage(message: any) {
  return !!(message && message.role === "user" && hasRenderOnlyStructuredBlock(message, "__queued"));
}

function isProcessingStructuredMessage(message: any) {
  return !!(message && message.role === "assistant" && hasRenderOnlyStructuredBlock(message, "__processing"));
}

export function stripRenderOnlyStructuredMessages(messages: any) {
  if (!Array.isArray(messages)) return [];
  var removed = false;
  var filtered = [];
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    if (isQueuedStructuredMessage(message) || isProcessingStructuredMessage(message)) {
      removed = true;
      continue;
    }
    filtered.push(message);
  }
  return removed ? filtered : messages;
}

export function normalizeStructuredSnapshot(snapshot: any, existingSession?: any) {
  if (!snapshot || !Array.isArray(snapshot.messages)) {
    return snapshot;
  }
  var sessionKind = snapshot.sessionKind || (existingSession && existingSession.sessionKind);
  if (sessionKind !== "structured") {
    return snapshot;
  }
  var sanitizedMessages = stripRenderOnlyStructuredMessages(snapshot.messages);
  if (sanitizedMessages === snapshot.messages) {
    return snapshot;
  }
  return Object.assign({}, snapshot, { messages: sanitizedMessages });
}

export function saveStructuredQueue() {
  try {
    if (!state.selectedId) return;
    var queued = getSelectedStructuredQueuedInputs();
    if (queued.length === 0) {
      // 队列排空时必须把遗留记录删掉：只写不清会让上一次的排队文本永久留在
      // localStorage 里。刷新后如果当前会话快照没有 queuedMessages 字段（历史 /
      // 精简会话），restoreStructuredQueue 会回退到这份旧值 —— 一条「已经发出去
      // 的消息」就会以排队气泡的形式重新出现，而且气泡上的 ⚡ / × 会按 index
      // 打到服务端真实队列上（删除 / 抢先发送错条目）。
      clearStructuredQueuePersistence(state.selectedId);
      return;
    }
    localStorage.setItem("wand-structured-queue", JSON.stringify({
      sessionId: state.selectedId,
      items: queued
    }));
  } catch (e) {
    // Ignore localStorage errors
  }
}

export function clearStructuredQueuePersistence(sessionId?: string) {
  try {
    var saved = localStorage.getItem("wand-structured-queue");
    if (!saved) return;
    var parsed = JSON.parse(saved);
    if (!sessionId || !parsed || parsed.sessionId === sessionId) {
      localStorage.removeItem("wand-structured-queue");
    }
  } catch (e) {
    localStorage.removeItem("wand-structured-queue");
  }
}

export function restoreStructuredQueue() {
  var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  if (selectedSession && Array.isArray(selectedSession.queuedMessages)) {
    syncStructuredQueueFromSession(selectedSession);
    saveStructuredQueue();
    return;
  }
  // 服务端快照没带 queuedMessages（历史 / 精简会话）时才回退读 localStorage，
  // 且只在「会话还没加载出来」或「会话仍在跑」时信任它：排队只存在于 turn 执行中，
  // turn 结束 / 会话退出时服务端会把队列清空并推送。会话已知且已停止却还留着旧
  // 记录 = 上一次页在这一步被关掉留下的残渣，画出来就是一条「已经发出去的消息」
  // 以排队气泡复活（气泡上的 ⚡ / × 还会按 index 打到服务端真实队列上）。
  if (selectedSession && selectedSession.status !== "running") {
    state.structuredInputQueue = [];
    clearStructuredQueuePersistence(selectedSession.id);
    return;
  }
  try {
    var saved = localStorage.getItem("wand-structured-queue");
    if (!saved) return;
    var parsed = JSON.parse(saved);
    if (!parsed || parsed.sessionId !== state.selectedId || !Array.isArray(parsed.items)) {
      return;
    }
    state.structuredInputQueue = parsed.items.slice(0, 10);
  } catch (e) {
    state.structuredInputQueue = [];
  }
}

export function persistCrossSessionQueue() {
  try {
    if (state.crossSessionQueue.length === 0) {
      localStorage.removeItem("wand-cross-session-queue");
      return;
    }
    localStorage.setItem("wand-cross-session-queue", JSON.stringify(state.crossSessionQueue));
  } catch (e) {
    // Ignore localStorage errors
  }
}

export function getConfigCwd() {
  return (state.config && state.config.defaultCwd) || "/tmp";
}

function loadChatExpandStateMap() {
  try {
    var saved = localStorage.getItem(CHAT_EXPAND_STATE_STORAGE_KEY);
    if (!saved) return {};
    var parsed = JSON.parse(saved);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveChatExpandStateMap(map: any) {
  try {
    if (!map || Object.keys(map).length === 0) {
      localStorage.removeItem(CHAT_EXPAND_STATE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CHAT_EXPAND_STATE_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // Ignore localStorage errors
  }
}

function getCurrentChatExpandState() {
  var sessionId = state.selectedId;
  if (!sessionId) return {};
  var map = loadChatExpandStateMap();
  var sessionState = map[sessionId];
  return sessionState && typeof sessionState === "object" ? sessionState : {};
}

export function getPersistedExpandState(itemKey: string) {
  if (!itemKey || !state.selectedId) return null;
  var sessionState = getCurrentChatExpandState();
  return typeof sessionState[itemKey] === "boolean" ? sessionState[itemKey] : null;
}

export function setPersistedExpandState(itemKey: string, expanded: boolean) {
  if (!itemKey || !state.selectedId) return;
  var map = loadChatExpandStateMap();
  var sessionId = state.selectedId;
  var sessionState = map[sessionId];
  if (!sessionState || typeof sessionState !== "object") {
    sessionState = {};
  }
  sessionState[itemKey] = !!expanded;
  map[sessionId] = sessionState;
  saveChatExpandStateMap(map);
}

var AGENT_RUN_SELECTION_STORAGE_KEY = "wand-agent-run-selection-v1";

function loadAgentRunSelectionMap() {
  try {
    var saved = localStorage.getItem(AGENT_RUN_SELECTION_STORAGE_KEY);
    if (!saved) return {};
    var parsed = JSON.parse(saved);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveAgentRunSelectionMap(map: any) {
  try {
    if (!map || Object.keys(map).length === 0) {
      localStorage.removeItem(AGENT_RUN_SELECTION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(AGENT_RUN_SELECTION_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // Ignore localStorage errors
  }
}

// 每个会话独立记忆“当前查看的 Agent”，避免切会话时互相覆盖，也避免刷新后跳回第一个。
export function getPersistedAgentSelection(runId: string) {
  if (!runId || !state.selectedId) return null;
  var map = loadAgentRunSelectionMap();
  var sessionState = map[state.selectedId];
  if (!sessionState || typeof sessionState !== "object") return null;
  var taskId = sessionState[runId];
  return typeof taskId === "string" && taskId ? taskId : null;
}

export function setPersistedAgentSelection(runId: string, taskId: string) {
  if (!runId || !taskId || !state.selectedId) return;
  var map = loadAgentRunSelectionMap();
  var sessionId = state.selectedId;
  var sessionState = map[sessionId];
  if (!sessionState || typeof sessionState !== "object") sessionState = {};
  sessionState[runId] = taskId;
  map[sessionId] = sessionState;
  saveAgentRunSelectionMap(map);
}

export function getMessageKey(msg: any, fallbackIndex?: number) {
  if (!msg) {
    return "msg:unknown-" + (typeof fallbackIndex === "number" ? fallbackIndex : 0);
  }
  if (msg.uuid) return "msg:" + msg.uuid;
  if (msg.id) return "msg:" + msg.id;
  if (msg.messageId) return "msg:" + msg.messageId;
  if (msg.turnId) return "msg:" + msg.turnId;
  return "msg:" + (typeof fallbackIndex === "number" ? fallbackIndex : 0);
}

export function buildExpandKey(kind: string, parts: any[]) {
  var filtered = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part === undefined || part === null || part === "") continue;
    filtered.push(String(part));
  }
  return kind + ":" + filtered.join(":");
}

export function getElementExpandKey(el: any) {
  if (!el || !el.dataset) return "";
  return el.dataset.expandKey || "";
}

function isElementExpanded(el: any, kind: string) {
  if (!el) return false;
  switch (kind) {
    case "tool-card":
    case "diff":
      return !el.classList.contains("collapsed");
    case "thinking":
      return el.classList.contains("expanded") && !el.classList.contains("collapsed");
    case "inline-tool":
      return el.classList.contains("inline-tool-open");
    case "terminal": {
      var body = el.querySelector(".term-body");
      if (body) return body.style.display !== "none";
      return el.dataset.expanded === "true";
    }
    case "agent-run":
      return el.getAttribute("data-expanded") === "true";
    case "activity":
      return el.getAttribute("data-expanded") === "true";
    default:
      return false;
  }
}

export function applyExpandedState(el: any, kind: string, expanded: boolean) {
  if (!el) return;
  switch (kind) {
    case "tool-card":
    case "diff": {
      el.classList.toggle("collapsed", !expanded);
      break;
    }
    case "thinking": {
      // 预览文案与展开/收起文案由 Ant Design X 的 Think 接手（见 react/chat/presentation.tsx），
      // 宿主只保留展开状态；这里不再读写已经不存在的手写 preview / action 节点。
      el.classList.toggle("collapsed", !expanded);
      el.classList.toggle("expanded", !!expanded);
      break;
    }
    case "inline-tool": {
      el.classList.toggle("inline-tool-open", !!expanded);
      el.setAttribute("aria-expanded", expanded ? "true" : "false");
      var inlineBody = el.querySelector(".inline-tool-expanded");
      if (inlineBody) {
        inlineBody.toggleAttribute("inert", !expanded);
        if (expanded) inlineBody.removeAttribute("aria-hidden");
        else inlineBody.setAttribute("aria-hidden", "true");
      }
      break;
    }
    case "terminal": {
      var body = el.querySelector(".term-body");
      if (body) body.style.display = expanded ? "block" : "none";
      el.dataset.expanded = expanded ? "true" : "false";
      var toggleIcon = el.querySelector(".term-toggle-icon");
      if (toggleIcon) toggleIcon.textContent = expanded ? "▼" : "▶";
      break;
    }
    case "activity": {
      el.setAttribute("data-expanded", expanded ? "true" : "false");
      var activityMenu = el.querySelector(".chat-activity-menu");
      if (activityMenu) {
        activityMenu.toggleAttribute("inert", !expanded);
        if (expanded) activityMenu.removeAttribute("aria-hidden");
        else activityMenu.setAttribute("aria-hidden", "true");
      }
      var activitySummary = el.querySelector(".chat-process-summary");
      if (activitySummary) activitySummary.setAttribute("aria-expanded", expanded ? "true" : "false");
      break;
    }
    case "agent-run": {
      el.setAttribute("data-expanded", expanded ? "true" : "false");
      var runSummary = el.querySelector(".agent-run-summary");
      if (runSummary) runSummary.setAttribute("aria-expanded", expanded ? "true" : "false");
      var runBody = el.querySelector(".agent-run-body");
      if (runBody) runBody.setAttribute("aria-hidden", expanded ? "false" : "true");
      break;
    }
  }
}

export function persistElementExpandState(el: any, kind: string) {
  var itemKey = getElementExpandKey(el);
  if (!itemKey) return;
  setPersistedExpandState(itemKey, isElementExpanded(el, kind));
}

export function applyPersistedExpandState(container: any) {
  if (!container || !state.selectedId) return;
  container.querySelectorAll("[data-expand-key]").forEach(function(el: any) {
    var itemKey = getElementExpandKey(el);
    var kind = el.dataset.expandKind || "";
    var persisted = getPersistedExpandState(itemKey);
    if (persisted === null || !kind) return;
    applyExpandedState(el, kind, persisted);
  });
}
