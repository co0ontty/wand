import { reportClientError } from "../client-feedback";
import { clearNoticeView, paintNotificationNotice, paintUpdateNotice, type UpdateNoticeOptions } from "./notice-view-adapter";
import { readMotionTokenMs } from "../react/ui/motion-tokens";
import { state, writeStoredBoolean } from "./state";
import { WAND_FAVICON_URL } from "../brand-identity.js";
import { HttpResponseError, parseJsonResponse } from "../react/http-adapter";
import { getErrorMessage } from "../../error-utils.js";
import { iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import { persistSelectedId } from "./chat-scroll";
import { setFilePanelOpen, isMobileLayout, isSidebarDrawerLayout } from "./file-browser";
import { render } from "./render";
import { selectSession, closeSessionsDrawer } from "./session-engine";
import "./session-ui";
import { openOwnedLegacyDialog, openReactLegacyDialog, showReactLegacyToast } from "../react/legacy-overlays";
import { closeOwnedDialog } from "../react/owned-dialog";
import {
  restartOverlayController,
  showAutoUpdate as showReactAutoUpdate,
  showRestart as showReactRestart,
} from "../react/restart-overlay/controller";
import { piExecutionController } from "../react/pi-execution/controller";
import { imageViewerController } from "../react/image-viewer/controller";

// TODO: import from correct modules when created

// ── Error & Toast ──

export function showError(el: any, msg: string) {
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  // Add error state to associated input field
  var inputEl = el.previousElementSibling;
  while (inputEl) {
    if (inputEl.tagName === "INPUT") {
      inputEl.setAttribute("data-error", "true");
      break;
    }
    inputEl = inputEl.previousElementSibling;
  }
}

export function hideError(el: any) {
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
  // Remove error state from associated input field
  var inputEl = el.previousElementSibling;
  while (inputEl) {
    if (inputEl.tagName === "INPUT") {
      inputEl.setAttribute("data-error", "false");
      break;
    }
    inputEl = inputEl.previousElementSibling;
  }
}

export function showToast(message: string, type?: string) {
  // "danger" 是 dialog 那套词表，在 toast 侧等同 error（React 通道由 toastTone 映射成 error）。
  var isError = type === "error" || type === "danger";
  var duration = isError ? 4000 : 2200;
  if (showReactLegacyToast(message, type, duration)) return;

  // The feature-flag fallback reuses the existing notification channel instead
  // of maintaining a second hand-written toast DOM implementation.
  showNotificationBubble({
    title: message,
    type: isError ? "error" : type === "success" ? "success" : "info",
    duration: duration,
  });
}

// ── Wand Dialog (alert / confirm / prompt) ──
// In-page dialogs keep confirmations consistent inside desktop browsers and
// iOS / Android WebViews without invoking platform JavaScript alert chrome.

/**
 * Open a Wand-styled in-page dialog. Returns a Promise resolving to the
 * value returned by the clicked button's `value`, or `cancelValue` if
 * dismissed via Esc / backdrop click / cancel button.
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.message]
 * @param {"info"|"warning"|"danger"|"success"|"question"} [opts.type]
 * @param {string} [opts.icon] - Override icon glyph.
 * @param {Array<{label:string, value:any, kind?:"primary"|"secondary"|"ghost"|"outline"|"danger", autofocus?:boolean}>} opts.buttons
 * @param {boolean} [opts.input] - Show a single-line text input (prompt).
 * @param {string} [opts.inputValue] - Initial text input value.
 * @param {string} [opts.inputPlaceholder]
 * @param {any} [opts.cancelValue] - Value resolved on Esc / backdrop click. Default: false for confirm, null for prompt, undefined for alert.
 * @param {boolean} [opts.dismissable] - Allow Esc / backdrop close (default true).
 * @returns {Promise<any>}
 */
export function openWandDialog(opts: any) {
  opts = opts || {};
  var reactDialog = openReactLegacyDialog(opts);
  if (reactDialog) return reactDialog.catch(function() { return openOwnedLegacyDialog(opts); });
  return openOwnedLegacyDialog(opts);
}

/**
 * In-page replacement for window.alert.
 * @param {string} message
 * @param {object} [options] - { title, type, okLabel }
 * @returns {Promise<void>}
 */
export function wandAlert(message: any, options?: any) {
  options = options || {};
  return openWandDialog({
    title: options.title || "提示",
    message: typeof message === "string" ? message : String(message == null ? "" : message),
    type: options.type || "info",
    dismissable: options.dismissable,
    buttons: [
      { label: options.okLabel || "好", value: undefined, kind: "primary", autofocus: true },
    ],
  });
}

/**
 * In-page replacement for window.confirm. Resolves to true/false.
 * @param {string} message
 * @param {object} [options] - { title, type ("question"|"warning"|"danger"), okLabel, cancelLabel, danger }
 * @returns {Promise<boolean>}
 */
export function wandConfirm(message: any, options?: any) {
  options = options || {};
  var danger = !!options.danger || options.type === "danger";
  return openWandDialog({
    title: options.title || (danger ? "确认操作" : "请确认"),
    message: typeof message === "string" ? message : String(message == null ? "" : message),
    type: options.type || (danger ? "danger" : "question"),
    cancelValue: false,
    dismissable: options.dismissable,
    buttons: [
      { label: options.cancelLabel || "取消", value: false, kind: "secondary" },
      {
        label: options.okLabel || (danger ? "删除" : "确定"),
        value: true,
        kind: danger ? "danger" : "primary",
        autofocus: !danger,
      },
    ],
  }).then(function(v: any) { return v === true; });
}

/**
 * In-page replacement for window.prompt. Resolves to entered string,
 * or null if cancelled.
 * @param {string} message
 * @param {string} [defaultValue]
 * @param {object} [options] - { title, placeholder, okLabel, cancelLabel }
 * @returns {Promise<string|null>}
 */
export function wandPrompt(message: any, defaultValue?: any, options?: any): Promise<string | null> {
  options = options || {};
  return openWandDialog({
    title: options.title || "请输入",
    message: typeof message === "string" ? message : String(message == null ? "" : message),
    type: options.type || "question",
    input: true,
    inputValue: defaultValue == null ? "" : String(defaultValue),
    inputPlaceholder: options.placeholder || "",
    cancelValue: null,
    dismissable: options.dismissable,
    buttons: [
      { label: options.cancelLabel || "取消", value: null, kind: "secondary" },
      { label: options.okLabel || "确定", value: undefined, kind: "primary" },
    ],
  }).then(function(value) { return value == null ? null : String(value); });
}

// Expose globally for ad-hoc use from inline handlers / future code
(window as any).wandAlert = wandAlert;
(window as any).wandConfirm = wandConfirm;
(window as any).wandPrompt = wandPrompt;
(window as any).openWandDialog = openWandDialog;
(window as any).showToast = showToast;

// ── Notification Bubble System ──

interface NotificationEntry {
  id: number;
  el: HTMLElement;
  timer?: number;
  returnFocus: HTMLElement | null;
}
const notificationStack = new Map<number, NotificationEntry>();
let notificationIdCounter = 0;
let notificationRegion: HTMLElement | null = null;

function createNotification(): NotificationEntry {
  if (!notificationRegion?.isConnected) {
    notificationRegion = document.createElement("div");
    notificationRegion.className = "wand-notification-stack";
    notificationRegion.setAttribute("aria-label", "通知");
    document.body.appendChild(notificationRegion);
  }
  const el = document.createElement("div");
  el.className = "notification-bubble";
  const entry: NotificationEntry = { id: ++notificationIdCounter, el,
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
  el.setAttribute("data-nid", String(entry.id));
  notificationRegion.appendChild(el);
  notificationStack.set(entry.id, entry);
  return entry;
}

/** In-app notices share a normal-flow stack, including while their views load. */
export function showNotificationBubble(opts: {
  title: string;
  body?: string;
  type?: string;
  duration?: number;
  actionLabel?: string;
  action?: () => void;
  playSound?: boolean;
}) {
  if (opts.actionLabel || opts.playSound) playNotificationSound();
  if (!state.notifBubble) return { dismiss() {} };

  const entry = createNotification();
  const dismiss = () => dismissNotification(entry.id);
  const duration = opts.duration ?? 8000;
  let remaining = duration;
  let deadline = 0;
  let ready = false;
  const pause = () => {
    if (!notificationStack.has(entry.id) || !entry.timer) return;
    remaining = Math.max(0, deadline - Date.now());
    clearTimeout(entry.timer);
    entry.timer = undefined;
  };
  const resume = () => {
    if (!ready || !notificationStack.has(entry.id) || entry.timer || duration <= 0
      || entry.el.matches(":hover, :focus-within")) return;
    if (remaining <= 0) { dismiss(); return; }
    deadline = Date.now() + remaining;
    entry.timer = window.setTimeout(dismiss, remaining);
  };
  entry.el.addEventListener("pointerenter", pause);
  entry.el.addEventListener("pointerleave", resume);
  entry.el.addEventListener("focusin", pause);
  entry.el.addEventListener("focusout", event => {
    if (!entry.el.contains(event.relatedTarget as Node | null)) resume();
  });

  void paintNotificationNotice(entry.el, {
    title: opts.title,
    body: opts.body,
    type: opts.type,
    actionLabel: opts.actionLabel,
    onAction: opts.action ? () => {
      if (!notificationStack.has(entry.id)) return;
      try { opts.action!(); } finally { dismiss(); }
    } : undefined,
    onClose: dismiss,
  }).then(painted => {
    ready = painted;
    resume();
  });
  return { dismiss };
}

function dismissNotification(id: number): void {
  const entry = notificationStack.get(id);
  if (!entry) return;
  notificationStack.delete(id);
  clearTimeout(entry.timer);
  if (entry.el.contains(document.activeElement) && entry.returnFocus?.isConnected) entry.returnFocus.focus({ preventScroll: true });
  entry.el.inert = true;
  const remove = () => {
    clearTimeout(entry.timer);
    clearNoticeView(entry.el);
    entry.el.remove();
    if (!notificationRegion?.childElementCount) {
      notificationRegion?.remove();
      notificationRegion = null;
    }
  };
  if (!entry.el.childElementCount || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    remove();
    return;
  }
  entry.el.classList.add("slide-out");
  entry.el.addEventListener("animationend", event => {
    if (event.target === entry.el) remove();
  }, { once: true });
  entry.timer = window.setTimeout(remove, readMotionTokenMs("--motion-fast"));
}

// ── Browser Notification API ──

// macOS WKWebView shim: Android shell injects a global WandNative via
// addJavascriptInterface, but WKWebView only exposes
// webkit.messageHandlers.<name>.postMessage(...). To keep call-sites
// identical across platforms, we synthesize a WandNative-shaped object
// when running inside the macOS shell.
try {
  var _macUaMatch = navigator.userAgent.match(/WandPlatform\/macOS/);
  var _macHandler = ((window as any).webkit && (window as any).webkit.messageHandlers && (window as any).webkit.messageHandlers.wandNative) || null;
  if (_macUaMatch && _macHandler && typeof (window as any).WandNative === "undefined") {
    (window as any).WandNative = {
      // Only downloadUpdate is wired for now; other Android-specific
      // methods (notifications, haptics, screen wake) intentionally
      // omitted so feature detection falls back to web APIs on macOS.
      downloadUpdate: function(url: string, fileName: string, source: string) {
        try {
          _macHandler.postMessage({
            type: "downloadUpdate",
            url: String(url || ""),
            fileName: String(fileName || "wand-update.dmg"),
            source: String(source || "local"),
          });
        } catch (_e) {}
      },
    };
  }
} catch (_e) {}

// Detect Android APK native bridge
export var _hasNativeBridge = typeof WandNative !== "undefined" && typeof WandNative.sendNotification === "function";
// Extract WandApp/<version> from User-Agent (set by both Android and macOS shells).
// We distinguish platforms by the additional WandPlatform/<name> token —
// macOS UA ends with "WandApp/X WandPlatform/macOS".
var _wandAppMatch = navigator.userAgent.match(/WandApp\/([^\s]+)/);
var _isMacApp = /WandPlatform\/macOS/.test(navigator.userAgent);
var _isAndroidApp = !!_wandAppMatch && !_isMacApp;
export var _apkVersion = (_wandAppMatch && _isAndroidApp) ? _wandAppMatch[1] : null;
export var _macAppVersion = (_wandAppMatch && _isMacApp) ? _wandAppMatch[1] : null;

export function _syncWakeLock() {
  if (!_hasNativeBridge) return;
  var anyActive = state.sessions.some(function(s: any) {
    return !s.archived && (s.status === "running" || s.status === "thinking" || s.status === "initializing");
  });
  if (typeof WandNative.setKeepScreenOn === "function") {
    try { WandNative.setKeepScreenOn(anyActive); } catch (_e) {}
  }
  if (anyActive) {
    if (typeof WandNative.startKeepAlive === "function") {
      try { WandNative.startKeepAlive(); } catch (_e) {}
    }
  } else {
    if (typeof WandNative.stopKeepAlive === "function") {
      try { WandNative.stopKeepAlive(); } catch (_e) {}
    }
  }
}

export function _getNativePermission() {
  if (_hasNativeBridge && typeof WandNative.getPermission === "function") {
    try { return WandNative.getPermission(); } catch (_e) {}
  }
  return null;
}

export function requestNotificationPermission() {
  if (_hasNativeBridge) {
    var perm = _getNativePermission();
    if (perm === "default" || perm === "denied") {
      try { WandNative.requestPermission(); } catch (_e) {}
    }
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function _shouldSendSystemNotification(opts?: any) {
  var options = opts || {};
  if (options.onlyWhenHidden && !document.hidden) return false;
  if (options.skipWhenSelectedSessionId && options.skipWhenSelectedSessionId === state.selectedId && !document.hidden) {
    return false;
  }
  return true;
}

function _isNotificationThrottled(tag: string, minIntervalMs: number) {
  if (!tag || !minIntervalMs || minIntervalMs <= 0) return false;
  var lastAt = state.notificationHistory[tag] || 0;
  var now = Date.now();
  if (now - lastAt < minIntervalMs) return true;
  state.notificationHistory[tag] = now;
  return false;
}

export function sendBrowserNotification(title: string, body?: string, opts?: any) {
  var options = opts || {};
  var tag = options.tag || "";
  if (!_shouldSendSystemNotification(options)) return;
  if (_isNotificationThrottled(tag, options.minIntervalMs || 0)) return;
  // Native Android bridge path
  if (_hasNativeBridge) {
    var perm = _getNativePermission();
    if (perm !== "granted") return;
    try {
      var nativeTag = tag;
      if (options.kind) {
        nativeTag = options.kind + (tag ? ":" + tag : "");
      }
      WandNative.sendNotification(title || "Wand", body || "", nativeTag || "");
    } catch (_e) {}
    return;
  }
  // Browser Notification API path
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return; // Only notify when tab is in background
  try {
    var n = new Notification(title, {
      body: body || "",
      icon: options.icon || WAND_FAVICON_URL,
      tag: tag || undefined,
    });
    n.onclick = function() {
      window.focus();
      n.close();
      if (options.onClick) options.onClick();
    };
    // Auto-close after 10s
    setTimeout(function() { n.close(); }, 10000);
  } catch (_e) {
    // Notification constructor may fail in some contexts (e.g. insecure origin)
  }
}

export function notifyTaskProgress(sessionId: string, task: any) {
  if (!task || !task.title) return;
  var session = state.sessions.find(function(s: any) { return s.id === sessionId; });
  if (!session) return;
  var sessionLabel = session.summary || session.command || sessionId;
  sendBrowserNotification(
    "任务进行中",
    sessionLabel + "\n" + task.title,
    {
      kind: "task",
      tag: "wand-task-" + sessionId + "-" + task.title,
      minIntervalMs: 90000,
      onlyWhenHidden: true,
      skipWhenSelectedSessionId: sessionId,
      onClick: function() {
        if (sessionId !== state.selectedId) selectSession(sessionId);
      }
    }
  );
}

export function notifyUpdateAvailable(currentVersion: string, latestVersion: string) {
  // /api/update 需要 admin scope；Android/iOS/macOS 原生壳与浏览器插件都以 connected-app
  // 身份登录，点「立即更新」必然 403（当前连接没有执行此操作的权限）。这些客户端有各自
  // 的原生更新通道（UpdateManager / DMG / IPA），不需要走服务器 npm 升级。
  if (!state.config || state.config.canManageSettings === false) return;
  showUpdateBubble(currentVersion || "-", latestVersion || "-");
  sendBrowserNotification(
    "Wand 发现新版本",
    "当前 " + (currentVersion || "-") + " → 最新 " + (latestVersion || "-"),
    {
      kind: "update",
      tag: "wand-update",
      minIntervalMs: 300000,
    }
  );
}

export function notifyPermissionRequest(sessionId: string, body: string) {
  sendBrowserNotification(
    "需要你的授权",
    body,
    {
      kind: "permission",
      tag: "wand-perm-" + sessionId,
      minIntervalMs: 60000,
      onlyWhenHidden: true,
      skipWhenSelectedSessionId: sessionId,
      onClick: function() {
        if (sessionId !== state.selectedId) {
          selectSession(sessionId);
        }
      }
    }
  );
}

export function notifyTaskEnded(sessionId: string, title: string, body: string) {
  sendBrowserNotification(
    title,
    body,
    {
      kind: "task-ended",
      tag: "wand-ended-" + sessionId,
      minIntervalMs: 10000,
      onClick: function() {
        if (sessionId !== state.selectedId) selectSession(sessionId);
      }
    }
  );
}

// ── Native Live Progress Sync ──

var _progressSyncTimers: Record<string, any> = {};
var _PROGRESS_SYNC_DEBOUNCE_MS = 30;

// Strip markdown formatting and clamp to a single short line so the
// native Live Activity / lock-screen card stays readable. 100 chars
// matches getLastAssistantSummary; OPPO truncates harder anyway.
function _compactNotificationText(text: string) {
  if (!text) return "";
  var t = String(text)
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
  var firstLine = t.split("\n")[0].trim();
  if (firstLine.length > 100) firstLine = firstLine.slice(0, 100) + "…";
  return firstLine;
}

export function syncSessionProgressToNative(sessionId: string) {
  if (!_hasNativeBridge || typeof WandNative.updateSessionProgress !== "function") return;
  if (!sessionId) return;
  if (_progressSyncTimers[sessionId]) {
    clearTimeout(_progressSyncTimers[sessionId]);
  }
  _progressSyncTimers[sessionId] = setTimeout(function() {
    delete _progressSyncTimers[sessionId];
    _doSyncSessionProgress(sessionId);
  }, _PROGRESS_SYNC_DEBOUNCE_MS);
}

function _doSyncSessionProgress(sessionId: string) {
  var session = state.sessions.find(function(s: any) { return s.id === sessionId; });
  if (!session) return;

  var sessionLabel = session.summary || session.command || sessionId;
  var sessionStatus = session.status || "running";

  // Clear notification for inactive sessions
  if (sessionStatus === "idle" || sessionStatus === "archived" || sessionStatus === "exited") {
    clearSessionProgressNative(sessionId);
    return;
  }

  // Get latest todos from session messages, plus the most recent user
  // prompt and assistant text in the same scan. sessionLabel is frozen
  // to the first prompt (session.summary), so without these fields the
  // OPPO Live Activity / lock-screen card stays stuck on round-1 text
  // forever. We carry the latest round across so native can refresh.
  var todos: any = null;
  var latestUserText = "";
  var latestAssistantText = "";
  var recentUserTexts: string[] = [];
  var messages = session.messages || [];
  for (var i = messages.length - 1; i >= 0; i--) {
    var msg = messages[i];
    if (!msg.content || !Array.isArray(msg.content)) continue;

    if (!latestAssistantText && msg.role === "assistant") {
      for (var ai = msg.content.length - 1; ai >= 0; ai--) {
        var ablock = msg.content[ai];
        if (ablock && ablock.type === "text" && ablock.text && ablock.text.trim()) {
          latestAssistantText = _compactNotificationText(ablock.text);
          break;
        }
      }
    }

    if (msg.role === "user") {
      // Skip queued / synthetic placeholder turns — they don't represent
      // user-visible "I just asked this" prompts.
      var isPlaceholder = msg.content.some(function(b: any) { return b && b.__queued; });
      if (!isPlaceholder) {
        for (var ui = 0; ui < msg.content.length; ui++) {
          var ublock = msg.content[ui];
          if (ublock && ublock.type === "text" && ublock.text && ublock.text.trim()) {
            var utext = _compactNotificationText(ublock.text);
            if (!latestUserText) latestUserText = utext;
            if (recentUserTexts.length < 4) recentUserTexts.push(utext);
            break;
          }
        }
      }
    }

    if (!todos) {
      for (var j = msg.content.length - 1; j >= 0; j--) {
        var block = msg.content[j];
        if (block && block.type === "tool_use" && block.name === "TodoWrite"
            && block.input && block.input.todos) {
          todos = block.input.todos;
          break;
        }
      }
    }

    if (todos && recentUserTexts.length >= 4 && latestAssistantText) break;
  }
  recentUserTexts.reverse();

  // Get current task
  var currentTask = "";
  if (sessionId === state.selectedId && state.currentTask && state.currentTask.title) {
    currentTask = state.currentTask.title;
  }

  var data = {
    sessionLabel: sessionLabel,
    status: sessionStatus,
    currentTask: currentTask,
    latestUserText: latestUserText,
    latestAssistantText: latestAssistantText,
    todos: todos || [],
    recentUserTexts: recentUserTexts
  };

  try {
    WandNative.updateSessionProgress(sessionId, JSON.stringify(data));
  } catch (_e) {}
}

export function clearSessionProgressNative(sessionId: string) {
  if (!_hasNativeBridge || typeof WandNative.clearSessionProgress !== "function") return;
  if (_progressSyncTimers[sessionId]) {
    clearTimeout(_progressSyncTimers[sessionId]);
    delete _progressSyncTimers[sessionId];
  }
  try { WandNative.clearSessionProgress(sessionId); } catch (_e) {}
}

// ── Android back button handler ──
(window as any).handleNativeBack = function() {
  // Restart/update is intentionally non-dismissable. Consume the native back
  // action so the WebView cannot reveal a half-restarted application state.
  if (restartOverlayController.isOpen()) return true;
  if (closeOwnedDialog()) return true;
  var reactOverlay = (window as any).__wandReactUi;
  if (reactOverlay && typeof reactOverlay.closeTopmost === "function") {
    try {
      if (reactOverlay.closeTopmost()) return true;
    } catch (_e) {}
  }
  var reactFilePreview = (window as any).__wandReactFilePreview;
  if (reactFilePreview && typeof reactFilePreview.closeTopmost === "function") {
    try {
      if (reactFilePreview.closeTopmost()) return true;
    } catch (_e) {}
  }
  if (piExecutionController.closeIfOpen()) return true;
  if (imageViewerController.closeIfOpen()) return true;
  var reactQuickCommit = (window as any).__wandReactQuickCommit;
  if (reactQuickCommit && typeof reactQuickCommit.closeTopmost === "function") {
    try {
      if (reactQuickCommit.closeTopmost()) return true;
    } catch (_e) {}
  }
  var reactNewSession = (window as any).__wandReactNewSession;
  if (reactNewSession && typeof reactNewSession.closeTopmost === "function") {
    try {
      if (reactNewSession.closeTopmost()) return true;
    } catch (_e) {}
  }
  var reactFolderPicker = (window as any).__wandReactFolderPicker;
  if (reactFolderPicker && typeof reactFolderPicker.closeTopmost === "function") {
    try {
      if (reactFolderPicker.closeTopmost()) return true;
    } catch (_e) {}
  }
  var reactWorktreeMerge = (window as any).__wandReactWorktreeMerge;
  if (reactWorktreeMerge && typeof reactWorktreeMerge.closeTopmost === "function") {
    try {
      if (reactWorktreeMerge.closeTopmost()) return true;
    } catch (_e) {}
  }
  var reactSettings = (window as any).__wandReactSettings;
  if (reactSettings && typeof reactSettings.closeTopmost === "function") {
    try {
      if (reactSettings.closeTopmost()) return true;
    } catch (_e) {}
  }
  if (state.filePanelOpen && isMobileLayout()) {
    setFilePanelOpen(false);
    return true;
  }
  if (state.sessionsDrawerOpen && isSidebarDrawerLayout()) {
    closeSessionsDrawer();
    return true;
  }
  if (isMobileLayout() && state.selectedId) {
    state.selectedId = null;
    persistSelectedId();
    state.sessionsDrawerOpen = true;
    writeStoredBoolean("wand-sidebar-open", true);
    render();
    return true;
  }
  return false;
};

// ── Notification Sound ──

/**
 * Play a soft, rounded notification chime using Web Audio API.
 * Two ascending sine tones with smooth gain envelope — gentle on the ears.
 */
function playNotificationSound() {
  if (!state.notifSound) return;
  _doPlaySound();
}

/**
 * Try to play the notification sound regardless of user preference.
 * Returns true if playback was initiated successfully.
 * Used by the test function to always attempt playback.
 */
function _doPlaySound() {
  try {
    var AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return false;
    var ctx = new AudioCtx();

    // Some browsers suspend AudioContext until user gesture — resume it
    if (ctx.state === "suspended") ctx.resume();

    var vol = (state.notifVolume || 0) / 100;

    function tone(freq: number, start: number, dur: number) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.5 * vol, ctx.currentTime + start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    }

    // Two-tone ascending chime: C5 → E5, soft and brief
    tone(523, 0, 0.25);
    tone(659, 0.12, 0.3);

    // Clean up context after playback
    setTimeout(function() { ctx.close(); }, 600);
    return true;
  } catch (_e) {
    // Web Audio not available or blocked
    return false;
  }
}

// ── Update & Restart ──

/**
 * Show an interactive update bubble that allows updating and restarting
 * directly from the notification, without navigating to settings.
 */
function showUpdateBubble(currentVer: string, latestVer: string) {
  // Dismissing this reminder lasts for the current page, like the native Mac reminder.
  if (state._updateBubbleShown) return;
  state._updateBubbleShown = true;
  playNotificationSound();

  const entry = createNotification();
  entry.el.classList.add("update-card");
  let phase: UpdateNoticeOptions["phase"] = "idle";
  let message = "";
  let retryRestart = false;
  const paint = () => {
    if (!notificationStack.has(entry.id)) return;
    paintUpdateNotice(entry.el, { current: currentVer, latest: latestVer, phase, message, retryRestart,
      onClose: () => dismissNotification(entry.id), onUpdate: () => { void update(); } });
  };
  const fail = (text: string) => {
    phase = "failed";
    message = text;
    paint();
  };
  const restarting = (previousInstanceId?: string | null, version?: string | null) => {
    dismissNotification(entry.id);
    showRestartOverlay(previousInstanceId, version);
  };
  const restart = async () => {
    phase = "restarting";
    message = "更新已完成，正在重启服务…";
    paint();
    try {
      const response = await fetch("/api/restart", { method: "POST",
        headers: { "Content-Type": "application/json" }, credentials: "same-origin" });
      await parseJsonResponse(response);
      restarting();
    } catch (error) {
      // A definite rejection stays on the card. A disconnected service is probed by the existing overlay.
      if (error instanceof HttpResponseError && error.status > 0) {
        fail(getErrorMessage(error, "重启失败，请重试。"));
        return;
      }
      restarting();
    }
  };
  async function update(): Promise<void> {
    if (phase === "updating" || phase === "restarting" || phase === "complete") return;
    if (retryRestart) { await restart(); return; }
    phase = "updating";
    message = "正在下载并安装新版本…";
    paint();
    try {
      const response = await fetch("/api/update", { method: "POST",
        headers: { "Content-Type": "application/json" }, credentials: "same-origin" });
      const data = await parseJsonResponse<{ detachedUpdate?: boolean; previousInstanceId?: string;
        version?: string; restartRequired?: boolean; message?: string }>(response);
      if (data.detachedUpdate) {
        restarting(data.previousInstanceId || null, data.version || null);
      } else if (data.restartRequired === false) {
        phase = "complete";
        message = data.message || "更新完成。";
        paint();
      } else {
        retryRestart = true;
        await restart();
      }
    } catch (error) {
      reportClientError("update_failed", error);
      fail(error instanceof HttpResponseError ? getErrorMessage(error, "更新失败，请重试。") : "请检查网络连接后重试。");
    }
  }
  paint();
}

/**
 * Full-screen overlay shown during server restart or detached update.
 * An update only completes after both the process instance and package version change.
 */
export function showRestartOverlay(previousInstanceId?: string | null, expectedVersion?: string | null) {
  showReactRestart(previousInstanceId, expectedVersion);
}

export function showAutoUpdateOverlay(
  currentVer: string,
  latestVer: string,
  previousInstanceId?: string | null,
) {
  showReactAutoUpdate(currentVer, latestVer, previousInstanceId);
}
