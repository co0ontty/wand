import { state, CHAT_EXPAND_STATE_STORAGE_KEY } from "./state";
import { renderChat } from "./chat-render";
import { fetchEarlierMessages } from "./session-engine";
import { snapCollapsedSubagentPanelsToBottom } from "./events";
import { render } from "./render";
// import { iconSvg } from "./i18n";

// TODO: import from correct module when created

export function getChatScrollElement() {
  var chatOutput = document.getElementById("chat-output");
  if (!chatOutput) {
    state.chatScrollElement = null;
    return null;
  }
  var chatMessages = chatOutput.querySelector(".chat-messages");
  if (chatMessages) {
    state.chatScrollElement = chatMessages;
    return chatMessages;
  }
  state.chatScrollElement = null;
  return null;
}

// column-reverse: scrollTop=0 是视觉底部，越往上看 scrollTop 绝对值越大。
// 部分浏览器历史上在 column-reverse 里给负 scrollTop，所以用绝对值更稳。
export function isChatNearBottom(chatMsgs?: any) {
  var el = chatMsgs || getChatScrollElement();
  if (!el) return true;
  return Math.abs(el.scrollTop) < state.chatScrollThreshold;
}

// 没有手动 toggle 了——是否贴底完全由用户的滚动行为决定。
// 这个函数只用来在某些场景（点未读气泡）下显式把状态扳回 true。
export function setChatStickToBottom(enabled: any) {
  state.chatStickToBottom = !!enabled;
  if (state.chatStickToBottom) clearChatUnread({ removeDivider: true });
  updateChatUnreadBubble();
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
  var shouldShow = !!selectedSession && state.currentView === "chat" && notAtBottom && !state.chatPinTurnToTop;
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

// ===== ChatGPT 风格"顶置最新轮次" =====
// 发送新消息时调用：进入 pin 模式，记下"不能钉到比这更早的用户消息"的下界。
// minUserIndex 通常是发送瞬间 currentMessages 的长度——保证 PTY 路径下
// 真正的用户回显到达后才会被钉，不会误钉上一轮的旧用户消息。
export function startChatTurnPin(minUserIndex: number) {
  state.chatPinTurnToTop = true;
  state.chatPinMinUserIndex = typeof minUserIndex === "number" ? minUserIndex : 0;
  // 进入 pin 模式即脱离贴底，避免两套滚动逻辑打架。
  state.chatStickToBottom = false;
  clearChatUnread({ removeDivider: true });
}

// 用户一旦主动滚动/滚轮/触摸，或点了"回到底部"气泡，就退出 pin 模式。
export function releaseChatTurnPin() {
  if (!state.chatPinTurnToTop) return;
  state.chatPinTurnToTop = false;
  state.chatPinMinUserIndex = 0;
  removeChatPinSpacer();
}

// pin 占位元素：column-reverse 下 DOM 第一个子节点 = 视觉底部，所以把 spacer
// 插到最前面，就是在内容下方撑出可滚动空间——回复很短时也能把用户消息推到顶。
function getChatPinSpacer(el: any, create: boolean) {
  var spacer = el.querySelector(".chat-pin-spacer");
  if (!spacer && create) {
    spacer = document.createElement("div");
    spacer.className = "chat-pin-spacer";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.flex = "0 0 auto";
    spacer.style.width = "100%";
    spacer.style.height = "0px";
    spacer.style.pointerEvents = "none";
    el.insertBefore(spacer, el.firstChild);
  }
  return spacer || null;
}

export function removeChatPinSpacer(chatMsgs?: any) {
  var el = chatMsgs || getChatScrollElement();
  if (!el) return;
  var spacer = el.querySelector(".chat-pin-spacer");
  if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
}

// 把最新一条（且 index >= chatPinMinUserIndex）的用户消息钉到视口顶部。
// column-reverse 下 scrollTop 含义特殊，但 anchor 公式（按 getBoundingClientRect
// 计算 delta 再加到 scrollTop）与布局方向无关，所以这里直接复用。
export function applyChatTurnPin(chatMsgs?: any) {
  if (!state.chatPinTurnToTop) return false;
  var el = chatMsgs || getChatScrollElement();
  if (!el || !el.isConnected) return false;
  var msgs = state.currentMessages || [];
  var targetIdx = -1;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "user") { targetIdx = i; break; }
  }
  if (targetIdx < 0 || targetIdx < state.chatPinMinUserIndex) return false;
  var userEl = el.querySelector('.chat-message[data-msg-index="' + targetIdx + '"]');
  if (!userEl) return false;
  var PIN_TOP_OFFSET = 12;

  // 回复很短时，用户消息 + 回复的总高度不足一屏，没有足够的可滚动内容
  // 把用户消息推到顶部。先把 spacer 归零量一遍真实内容高度，缺多少补多少。
  var spacer = getChatPinSpacer(el, true);
  if (spacer) spacer.style.height = "0px";
  // 视觉最底部的真实内容：跳过 spacer 后的第一个 DOM 子节点（column-reverse）。
  var bottomEl: any = null;
  var children = el.children;
  for (var c = 0; c < children.length; c++) {
    if (!children[c].classList || !children[c].classList.contains("chat-pin-spacer")) {
      bottomEl = children[c];
      break;
    }
  }
  if (bottomEl) {
    var available = bottomEl.getBoundingClientRect().bottom - userEl.getBoundingClientRect().top;
    var needed = el.clientHeight - PIN_TOP_OFFSET;
    var spacerHeight = needed - available;
    if (spacer) spacer.style.height = (spacerHeight > 0 ? Math.ceil(spacerHeight) : 0) + "px";
  }

  var containerTop = el.getBoundingClientRect().top;
  var delta = (userEl.getBoundingClientRect().top - containerTop) - PIN_TOP_OFFSET;
  if (Math.abs(delta) > 0.5) {
    state.chatIsProgrammaticScroll = true;
    // scroll 事件常晚于 rAF 才派发，单 rAF 复位会被随后到来的程序 scroll 漏过，
    // 误触发 releaseChatTurnPin。用时间戳兜底：宽限期内的 scroll 一律忽略。
    state.chatProgrammaticScrollUntil = Date.now() + 350;
    el.scrollTop += delta;
    requestAnimationFrame(function() { state.chatIsProgrammaticScroll = false; });
  }
  return true;
}

export function scrollChatToBottom(smooth?: boolean) {
  var chatMsgs = getChatScrollElement();
  if (!chatMsgs || !(chatMsgs as any).isConnected) return;
  releaseChatTurnPin();
  removeChatPinSpacer(chatMsgs);
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
  releaseChatTurnPin();
  if (chatMsgs) removeChatPinSpacer(chatMsgs);
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
  state.chatScrollHandler = function() {
    if (!(chatMsgs as any).isConnected) return;
    // 程序触发的滚动（点了气泡 / pin 重定位）不算"用户翻页"——别把状态弄乱。
    // 宽限期兜底：pin 重定位的 scroll 事件可能晚于 rAF 复位才到，这里一并忽略。
    if (state.chatIsProgrammaticScroll || Date.now() < state.chatProgrammaticScrollUntil) {
      updateChatUnreadBubble();
      return;
    }
    // 用户真的手动滚了——退出 pin 模式，回到普通贴底逻辑。
    releaseChatTurnPin();
    var atBottom = isChatNearBottom(chatMsgs);
    if (atBottom) {
      // 用户自己滚到底了——清未读、贴回底部、撤下气泡。
      state.chatStickToBottom = true;
      clearChatUnread({ removeDivider: true });
    } else {
      // 用户主动往上翻——脱离贴底状态。新消息只会累积到气泡，不滚视图。
      state.chatStickToBottom = false;
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
      releaseChatTurnPin();
      state.chatStickToBottom = false;
      updateChatUnreadBubble();
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
      releaseChatTurnPin();
      state.chatStickToBottom = false;
      updateChatUnreadBubble();
    }
  };
  chatMsgs.addEventListener("scroll", state.chatScrollHandler, { passive: true });
  chatMsgs.addEventListener("wheel", state.chatScrollWheelHandler, { passive: true });
  chatMsgs.addEventListener("touchstart", state.chatScrollTouchStartHandler, { passive: true });
  chatMsgs.addEventListener("touchmove", state.chatScrollTouchMoveHandler, { passive: true });
  updateChatUnreadBubble();
}

/** Load older messages: first expand the local window, then fetch earlier pages from the server. */
export function loadMoreChatMessages() {
  // 本地还有没展开的：先扩大渲染窗口。
  if (state.chatRenderedCount < state.currentMessages.length) {
    state.chatRenderedCount += state.chatPageSize;
    renderChat(true);
    return;
  }
  // 本地已全展开，但服务端还有更早的（窗口化）：拉下一页。
  var sess = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  if (sess && typeof sess.messageOffset === "number" && sess.messageOffset > 0) {
    fetchEarlierMessages();
  }
}

// Observe the "load more" sentinel for auto-loading when scrolled into view
export var _loadMoreObserver: any = null;
export function observeLoadMoreSentinel() {
  if (_loadMoreObserver) { _loadMoreObserver.disconnect(); _loadMoreObserver = null; }
  var sentinel = document.getElementById("chat-load-more-sentinel");
  if (!sentinel) return;
  // Click handler for the button
  var btn = sentinel.querySelector(".chat-load-more-btn");
  if (btn) (btn as any).onclick = function() { loadMoreChatMessages(); };
  // 移动端 App 里不要靠惯性滚动自动翻页：用户一拉到顶就连着加载历史，
  // 容易把阅读位置带到很上面。保留显式按钮，桌面继续自动预取。
  var coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  var mobileViewport = window.innerWidth <= 768;
  if (coarsePointer || mobileViewport || window.__wandImeNative || window.__wandIosNative) return;
  // IntersectionObserver for auto-load on scroll
  if (typeof IntersectionObserver === "undefined") return;
  _loadMoreObserver = new IntersectionObserver(function(entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) {
        loadMoreChatMessages();
        break;
      }
    }
  }, { root: getChatScrollElement(), rootMargin: "200px" });
  _loadMoreObserver.observe(sentinel);
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

export function getSelectedStructuredQueuedInputs() {
  var session = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  return getStructuredQueuedInputs(session);
}

export function syncStructuredQueueFromSession(session: any) {
  var queued = getStructuredQueuedInputs(session);
  state.structuredInputQueue = Array.isArray(queued) ? queued.slice() : [];
}

export function hasRenderOnlyStructuredBlock(message: any, marker: string) {
  return !!(message && Array.isArray(message.content) && message.content.some(function(block: any) {
    return block && typeof block === "object" && block[marker];
  }));
}

export function isQueuedStructuredMessage(message: any) {
  return !!(message && message.role === "user" && hasRenderOnlyStructuredBlock(message, "__queued"));
}

export function isProcessingStructuredMessage(message: any) {
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
    var queued = getSelectedStructuredQueuedInputs();
    if (!state.selectedId || queued.length === 0) {
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

export function loadChatExpandStateMap() {
  try {
    var saved = localStorage.getItem(CHAT_EXPAND_STATE_STORAGE_KEY);
    if (!saved) return {};
    var parsed = JSON.parse(saved);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

export function saveChatExpandStateMap(map: any) {
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

export function getCurrentChatExpandState() {
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

export function isElementExpanded(el: any, kind: string) {
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
    case "tool-group":
      return el.getAttribute("data-expanded") === "true";
    case "subagent-reply":
      return el.getAttribute("data-expanded") === "true";
    case "subagent-panel":
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
      el.classList.toggle("collapsed", !expanded);
      el.classList.toggle("expanded", !!expanded);
      var previewEl = el.querySelector(".thinking-inline-preview");
      if (previewEl) {
        var fullText = el.dataset.thinking || "";
        var preview = fullText.slice(0, 57) + (fullText.length > 60 ? "…" : "");
        previewEl.textContent = expanded ? fullText : preview;
      }
      var actionEl = el.querySelector(".thinking-inline-action");
      if (actionEl) actionEl.textContent = expanded ? "收起" : "展开";
      break;
    }
    case "inline-tool": {
      el.classList.toggle("inline-tool-open", !!expanded);
      var inlineBody = el.querySelector(".inline-tool-expanded");
      if (inlineBody) inlineBody.style.display = expanded ? "block" : "none";
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
    case "tool-group": {
      el.setAttribute("data-expanded", expanded ? "true" : "false");
      var groupBody = el.querySelector(".tool-group-body");
      if (groupBody) groupBody.style.display = expanded ? "block" : "none";
      var chevron = el.querySelector(".tool-group-chevron");
      if (chevron) chevron.style.transform = expanded ? "rotate(180deg)" : "";
      break;
    }
    case "subagent-reply": {
      el.setAttribute("data-expanded", expanded ? "true" : "false");
      var subLabel = el.querySelector(".subagent-reply-toggle-label");
      if (subLabel) subLabel.textContent = expanded ? "收起" : "展开";
      var subToggleBtn = el.querySelector(".subagent-reply-toggle");
      if (subToggleBtn) {
        subToggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
        subToggleBtn.setAttribute("aria-label", expanded ? "收起子代理回复" : "展开子代理回复全文");
      }
      break;
    }
    case "subagent-panel": {
      el.setAttribute("data-expanded", expanded ? "true" : "false");
      // 头/尾两个按钮都得同步——label、aria-expanded、aria-label
      var panelBtns = el.querySelectorAll(".subagent-panel-toggle");
      for (var pbi = 0; pbi < panelBtns.length; pbi++) {
        var pb = panelBtns[pbi];
        pb.setAttribute("aria-expanded", expanded ? "true" : "false");
        pb.setAttribute("aria-label", expanded ? "收起子代理输出" : "展开子代理输出");
        var pblbl = pb.querySelector(".subagent-panel-toggle-label");
        if (pblbl) pblbl.textContent = expanded ? "收起" : "展开";
      }
      var pbody = el.querySelector(".subagent-panel-body");
      if (pbody) {
        if (expanded) {
          // 展开时把 body 滚到顶，避免延续上次的滚动位置造成"展开后看到一半"
          pbody.scrollTop = 0;
        } else {
          // 折叠回去时滚到底——折叠预览窗口要展示的是"最新到达的内容"，
          // 跟 snapCollapsedSubagentPanelsToBottom 在 re-render 后的行为对齐。
          pbody.scrollTop = pbody.scrollHeight;
        }
      }
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
