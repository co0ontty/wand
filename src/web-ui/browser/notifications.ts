import { state, writeStoredBoolean } from "./state";
import { escapeHtml } from "./utils";
import { persistSelectedId } from "./chat-scroll";
import { setFilePanelOpen, isMobileLayout } from "./file-browser";
import { render } from "./render";
import { selectSession, closeSettingsModal, closeSessionModal, closeWorktreeMergeModal, closeSessionsDrawer } from "./session-engine";
import { getLastAssistantSummary } from "./session-ui";

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
  var toast = document.createElement("div");
  toast.className = "toast-message" + (type === "error" ? " toast-error" : "");
  if (type !== "error") {
    toast.style.background = "var(--accent)";
    toast.style.color = "white";
  }
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.remove();
  }, type === "error" ? 4000 : 2200);
}

// ── Wand Dialog (alert / confirm / prompt) ──
// In-page dialogs keep confirmations consistent inside desktop browsers and
// iOS / Android WebViews without invoking platform JavaScript alert chrome.

export var _wandDialogStack: Function[] = [];
export var _wandDialogIdCounter = 0;

export function _wandDialogIcon(type: string) {
  switch (type) {
    case "warning": return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
    case "danger": return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
    case "success": return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    case "question": return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 4.5 1.5c-.9.8-2.2 1.2-2.2 2.5"/><path d="M12 17h.01"/></svg>';
    default: return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
  }
}

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
  var dismissable = opts.dismissable !== false;
  var type = opts.type || "info";
  var iconSvg = _wandDialogIcon(type);
  var hasInput = !!opts.input;

  return new Promise(function(resolve) {
    var dialogId = "wand-dialog-" + (++_wandDialogIdCounter);
    var previouslyFocused = document.activeElement as HTMLElement | null;
    var backdrop = document.createElement("div");
    backdrop.className = "wand-dialog-backdrop";
    backdrop.setAttribute("role", "presentation");

    var dialog = document.createElement("div");
    dialog.className = "wand-dialog";
    dialog.setAttribute("role", hasInput ? "dialog" : "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    // Header
    var header = document.createElement("div");
    header.className = "wand-dialog-header";

    var iconEl = document.createElement("div");
    iconEl.className = "wand-dialog-icon " + type;
    iconEl.setAttribute("aria-hidden", "true");
    if (opts.icon) {
      iconEl.textContent = String(opts.icon);
    } else {
      iconEl.innerHTML = iconSvg;
    }
    header.appendChild(iconEl);

    var textWrap = document.createElement("div");
    textWrap.className = "wand-dialog-textwrap";
    if (opts.title) {
      var titleEl = document.createElement("div");
      titleEl.className = "wand-dialog-title";
      titleEl.id = dialogId + "-title";
      titleEl.textContent = opts.title;
      textWrap.appendChild(titleEl);
      dialog.setAttribute("aria-labelledby", titleEl.id);
    }
    if (opts.message) {
      var msgEl = document.createElement("div");
      msgEl.className = "wand-dialog-message";
      msgEl.id = dialogId + "-message";
      msgEl.textContent = opts.message;
      textWrap.appendChild(msgEl);
      dialog.setAttribute("aria-describedby", msgEl.id);
    }
    if (!opts.title) dialog.setAttribute("aria-label", type === "danger" ? "确认操作" : "提示");
    header.appendChild(textWrap);
    dialog.appendChild(header);

    // Optional input (prompt mode)
    var inputEl: HTMLInputElement | null = null;
    if (hasInput) {
      var bodyEl = document.createElement("div");
      bodyEl.className = "wand-dialog-body";
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "wand-dialog-input";
      inputEl.setAttribute("aria-label", opts.inputLabel || opts.title || "输入内容");
      inputEl.autocomplete = "off";
      inputEl.spellcheck = false;
      if (opts.inputPlaceholder) inputEl.placeholder = opts.inputPlaceholder;
      if (opts.inputValue != null) inputEl.value = String(opts.inputValue);
      bodyEl.appendChild(inputEl);
      dialog.appendChild(bodyEl);
    }

    // Footer / buttons
    var buttons = (opts.buttons && opts.buttons.length) ? opts.buttons : [
      { label: "好", value: true, kind: "primary", autofocus: true },
    ];

    var footer = document.createElement("div");
    footer.className = "wand-dialog-footer";

    var firstFocusable: HTMLButtonElement | null = null;
    var autofocusTarget: HTMLButtonElement | null = null;

    function close(value: any) {
      if (backdrop.classList.contains("closing")) return;
      backdrop.classList.add("closing");
      document.removeEventListener("keydown", keyHandler, true);
      var idx = _wandDialogStack.indexOf(close);
      if (idx >= 0) _wandDialogStack.splice(idx, 1);
      var reduceMotion = false;
      try { reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (_e) {}
      setTimeout(function() {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === "function") {
          try { previouslyFocused.focus(); } catch (_e) {}
        }
        resolve(value);
      }, reduceMotion || document.hidden ? 0 : 140);
    }

    buttons.forEach(function(btnSpec: any) {
      var btn = document.createElement("button");
      var kind = btnSpec.kind || "secondary";
      btn.className = "btn btn-" + kind;
      btn.type = "button";
      btn.textContent = btnSpec.label;
      btn.addEventListener("click", function() {
        if (hasInput && btnSpec.kind === "primary") {
          close(inputEl ? inputEl.value : "");
        } else {
          close(btnSpec.value);
        }
      });
      if (!firstFocusable) firstFocusable = btn;
      if (btnSpec.autofocus) autofocusTarget = btn;
      footer.appendChild(btn);
    });
    dialog.appendChild(footer);

    backdrop.appendChild(dialog);

    // Backdrop click → cancel (if dismissable)
    backdrop.addEventListener("click", function(e) {
      if (e.target === backdrop && dismissable) {
        close(opts.cancelValue !== undefined ? opts.cancelValue : (hasInput ? null : false));
      }
    });

    // Key handler — Esc cancels, Enter triggers primary (when not in textarea-like input)
    function keyHandler(e: KeyboardEvent) {
      // Only handle keys for the topmost dialog
      if (_wandDialogStack[_wandDialogStack.length - 1] !== close) return;
      if (e.key === "Escape" && dismissable) {
        e.preventDefault();
        e.stopPropagation();
        close(opts.cancelValue !== undefined ? opts.cancelValue : (hasInput ? null : false));
        return;
      }
      if (e.key === "Enter") {
        // For prompt: Enter on input → submit. For alert/confirm: Enter → primary action.
        var primary: any = null;
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].kind === "primary") {
            primary = buttons[i];
            break;
          }
        }
        if (!primary) primary = buttons[buttons.length - 1];
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          if (hasInput && primary.kind === "primary") {
            close(inputEl ? inputEl.value : "");
          } else {
            close(primary.value);
          }
        }
        return;
      }
      if (e.key === "Tab") {
        var focusables = dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!focusables.length) return;
        var first = focusables[0] as HTMLElement;
        var last = focusables[focusables.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", keyHandler, true);
    _wandDialogStack.push(close);

    document.body.appendChild(backdrop);

    // Focus the most appropriate target
    requestAnimationFrame(function() {
      if (hasInput && inputEl) {
        inputEl.focus();
        try { inputEl.select(); } catch (e2) {}
      } else if (autofocusTarget) {
        autofocusTarget.focus();
      } else if (firstFocusable) {
        firstFocusable.focus();
      }
    });
  });
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
export function wandPrompt(message: any, defaultValue?: any, options?: any) {
  options = options || {};
  return openWandDialog({
    title: options.title || "请输入",
    message: typeof message === "string" ? message : String(message == null ? "" : message),
    type: options.type || "question",
    input: true,
    inputValue: defaultValue == null ? "" : String(defaultValue),
    inputPlaceholder: options.placeholder || "",
    cancelValue: null,
    buttons: [
      { label: options.cancelLabel || "取消", value: null, kind: "secondary" },
      { label: options.okLabel || "确定", value: undefined, kind: "primary" },
    ],
  });
}

// Expose globally for ad-hoc use from inline handlers / future code
(window as any).wandAlert = wandAlert;
(window as any).wandConfirm = wandConfirm;
(window as any).wandPrompt = wandPrompt;
(window as any).openWandDialog = openWandDialog;

// ── Notification Bubble System ──

export var notificationStack: { id: number; el: HTMLElement }[] = [];
export var notificationIdCounter = 0;
export var NOTIFICATION_GAP = 6;
export var NOTIFICATION_TOP = 16;

/**
 * Show an in-app notification bubble at bottom-right.
 * @param {object} opts
 * @param {string} opts.title - Notification title
 * @param {string} [opts.body] - Body text
 * @param {string} [opts.type] - "info" | "warning" | "success" (default "info")
 * @param {string} [opts.icon] - Icon character (default derived from type)
 * @param {number} [opts.duration] - Auto-dismiss ms, 0 = manual only (default 8000)
 * @param {string} [opts.actionLabel] - Action button label
 * @param {function} [opts.action] - Action button callback
 * @returns {{ dismiss: function }} handle
 */
export function showNotificationBubble(opts: any) {
  // Play sound for important notifications — independent of bubble setting
  if (opts.actionLabel || opts.playSound) playNotificationSound();

  // Respect user preference (skip if bubbles disabled)
  if (!state.notifBubble) return { dismiss: function() {} };

  var id = ++notificationIdCounter;
  var type = opts.type || "info";
  var icon = opts.icon || (type === "warning" ? "!" : type === "success" ? "✓" : "i");
  var duration = opts.duration !== undefined ? opts.duration : 8000;

  var bubble = document.createElement("div");
  bubble.className = "notification-bubble";
  bubble.setAttribute("data-nid", String(id));

  var headerHtml =
    '<div class="notification-bubble-header">' +
      '<span class="notification-bubble-icon ' + type + '">' + icon + '</span>' +
      '<span class="notification-bubble-title">' + escapeHtml(opts.title) + '</span>' +
      '<button class="notification-bubble-close" title="关闭">×</button>' +
    '</div>';

  var bodyHtml = opts.body
    ? '<div class="notification-bubble-body">' + escapeHtml(opts.body).replace(/\n/g, '<br>') + '</div>'
    : '';

  var actionsHtml = opts.actionLabel
    ? '<div class="notification-bubble-actions">' +
        '<button class="primary">' + escapeHtml(opts.actionLabel) + '</button>' +
      '</div>'
    : '';

  bubble.innerHTML = headerHtml + bodyHtml + actionsHtml;
  document.body.appendChild(bubble);

  // Stack position
  var entry = { id: id, el: bubble };
  notificationStack.push(entry);
  repositionNotifications();

  // Wire close button
  var closeBtn = bubble.querySelector(".notification-bubble-close") as HTMLElement | null;
  if (closeBtn) closeBtn.onclick = function() { dismissNotification(id); };

  // Wire action button
  if (opts.actionLabel && opts.action) {
    var actionBtn = bubble.querySelector(".notification-bubble-actions button") as HTMLElement | null;
    if (actionBtn) actionBtn.onclick = function() {
      opts.action();
      dismissNotification(id);
    };
  }

  // Auto-dismiss
  var timer: any = null;
  if (duration > 0) {
    timer = setTimeout(function() { dismissNotification(id); }, duration);
  }

  return {
    dismiss: function() { dismissNotification(id); }
  };
}

export function dismissNotification(id: number) {
  var idx = -1;
  for (var i = 0; i < notificationStack.length; i++) {
    if (notificationStack[i].id === id) { idx = i; break; }
  }
  if (idx === -1) return;
  var entry = notificationStack[idx];
  entry.el.classList.add("slide-out");
  notificationStack.splice(idx, 1);
  repositionNotifications();
  setTimeout(function() {
    if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
  }, 300);
}

export function repositionNotifications() {
  var top = NOTIFICATION_TOP;
  for (var i = 0; i < notificationStack.length; i++) {
    notificationStack[i].el.style.top = top + "px";
    top += notificationStack[i].el.offsetHeight + NOTIFICATION_GAP;
  }
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
export var _wandAppMatch = navigator.userAgent.match(/WandApp\/([^\s]+)/);
export var _isMacApp = /WandPlatform\/macOS/.test(navigator.userAgent);
export var _isAndroidApp = !!_wandAppMatch && !_isMacApp;
export var _apkVersion = (_wandAppMatch && _isAndroidApp) ? _wandAppMatch[1] : null;
export var _macAppVersion = (_wandAppMatch && _isMacApp) ? _wandAppMatch[1] : null;

export function _vibrate(pattern?: string) {
  if (!_hasNativeBridge || typeof WandNative.vibrate !== "function") return;
  try { WandNative.vibrate(pattern || "light"); } catch (_e) {}
}

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

export function _shouldSendSystemNotification(opts?: any) {
  var options = opts || {};
  if (options.onlyWhenHidden && !document.hidden) return false;
  if (options.skipWhenSelectedSessionId && options.skipWhenSelectedSessionId === state.selectedId && !document.hidden) {
    return false;
  }
  return true;
}

export function _isNotificationThrottled(tag: string, minIntervalMs: number) {
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
      icon: options.icon || "/favicon.ico",
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

export var _progressSyncTimers: Record<string, any> = {};
export var _PROGRESS_SYNC_DEBOUNCE_MS = 30;

// Strip markdown formatting and clamp to a single short line so the
// native Live Activity / lock-screen card stays readable. 100 chars
// matches getLastAssistantSummary; OPPO truncates harder anyway.
export function _compactNotificationText(text: string) {
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

export function _doSyncSessionProgress(sessionId: string) {
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
  var settingsModal = document.getElementById("settings-modal");
  if (settingsModal && !settingsModal.classList.contains("hidden")) {
    closeSettingsModal();
    return true;
  }
  var sessionModal = document.getElementById("session-modal");
  if (sessionModal && !sessionModal.classList.contains("hidden")) {
    closeSessionModal();
    return true;
  }
  var worktreeModal = document.getElementById("worktree-merge-modal");
  if (worktreeModal && !worktreeModal.classList.contains("hidden")) {
    closeWorktreeMergeModal();
    return true;
  }
  if (state.filePanelOpen && isMobileLayout()) {
    setFilePanelOpen(false);
    return true;
  }
  if (state.sessionsDrawerOpen && isMobileLayout()) {
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
export function playNotificationSound() {
  if (!state.notifSound) return;
  _doPlaySound();
}

/**
 * Try to play the notification sound regardless of user preference.
 * Returns true if playback was initiated successfully.
 * Used by the test function to always attempt playback.
 */
export function tryPlayNotificationSound() {
  return _doPlaySound();
}

export function _doPlaySound() {
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
export function showUpdateBubble(currentVer: string, latestVer: string) {
  // Prevent duplicate bubbles
  if (state._updateBubbleShown) return;
  state._updateBubbleShown = true;

  playNotificationSound();

  var id = ++notificationIdCounter;
  var card = document.createElement("div");
  // Reuse the notification stacking system but with a richer card style.
  card.className = "notification-bubble update-card";
  card.setAttribute("data-nid", String(id));

  card.innerHTML =
    '<div class="update-card-shine" aria-hidden="true"></div>' +
    '<div class="update-card-header">' +
      '<div class="update-card-icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>' +
        '</svg>' +
      '</div>' +
      '<div class="update-card-heading">' +
        '<div class="update-card-title">发现新版本</div>' +
        '<div class="update-card-subtitle" id="update-card-subtitle">点击下方按钮一键更新</div>' +
      '</div>' +
      '<button class="update-card-close" title="稍后提醒" aria-label="关闭">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>' +
        '</svg>' +
      '</button>' +
    '</div>' +
    '<div class="update-card-version">' +
      '<span class="update-card-version-chip update-card-version-current">v' + escapeHtml(String(currentVer).replace(/^v/, "")) + '</span>' +
      '<svg class="update-card-version-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 12h14"/><path d="M13 5l7 7-7 7"/>' +
      '</svg>' +
      '<span class="update-card-version-chip update-card-version-latest">v' + escapeHtml(String(latestVer).replace(/^v/, "")) + '</span>' +
    '</div>' +
    '<div class="update-card-progress" id="update-card-progress" aria-hidden="true">' +
      '<div class="update-card-progress-track"><div class="update-card-progress-fill"></div></div>' +
    '</div>' +
    '<div class="update-card-status hidden" id="update-card-status"></div>' +
    '<div class="update-card-actions">' +
      '<button class="update-card-action update-card-action-primary" id="update-bubble-action" type="button">' +
        '<span class="update-card-action-label">立即更新</span>' +
      '</button>' +
    '</div>';

  document.body.appendChild(card);

  var entry = { id: id, el: card };
  notificationStack.push(entry);
  repositionNotifications();

  var closeBtn = card.querySelector(".update-card-close") as HTMLElement | null;
  if (closeBtn) closeBtn.onclick = function() {
    dismissNotification(id);
    state._updateBubbleShown = false;
  };

  var actionBtn = card.querySelector("#update-bubble-action") as HTMLButtonElement | null;
  var actionLabel = card.querySelector(".update-card-action-label") as HTMLElement | null;
  var subtitleEl = card.querySelector("#update-card-subtitle") as HTMLElement | null;
  var statusEl = card.querySelector("#update-card-status") as HTMLElement | null;
  var progressEl = card.querySelector("#update-card-progress") as HTMLElement | null;

  function setStatus(text: string, kind?: string) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.remove("hidden", "error", "success");
    if (!text) { statusEl.classList.add("hidden"); return; }
    if (kind) statusEl.classList.add(kind);
  }
  function setSubtitle(text: string) {
    if (subtitleEl) subtitleEl.textContent = text || "";
  }
  function setProgress(active: boolean) {
    if (!progressEl) return;
    progressEl.classList.toggle("active", !!active);
  }

  if (actionBtn) actionBtn.onclick = function() {
    // Phase 1: Performing update
    actionBtn!.disabled = true;
    card.classList.add("is-busy");
    if (actionLabel) actionLabel.textContent = "更新中…";
    setSubtitle("正在下载并安装新版本…");
    setProgress(true);
    setStatus("");

    fetch("/api/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin"
    })
    .then(function(res) { return res.json(); })
    .then(function(data: any) {
      if (data.error) {
        // Update failed
        setProgress(false);
        card.classList.remove("is-busy");
        setSubtitle("更新未完成");
        setStatus(data.error, "error");
        actionBtn!.disabled = false;
        if (actionLabel) actionLabel.textContent = "重试";
        return;
      }
      // Phase 2: 安装成功，自动调用 /api/restart，由 restart overlay 接管 UX。
      card.classList.add("is-success");
      setSubtitle((data.message || "更新完成") + "，正在重启服务…");
      setStatus("");
      if (actionLabel) actionLabel.textContent = "正在重启…";
      if (data.detachedUpdate) {
        showRestartOverlay();
        return;
      }
      if (data.restartRequired === false) {
        setProgress(false);
        card.classList.remove("is-busy");
        actionBtn!.disabled = false;
        if (actionLabel) actionLabel.textContent = "已完成";
        return;
      }
      performRestartCard(actionBtn!, actionLabel, subtitleEl, statusEl, progressEl);
    })
    .catch(function() {
      setProgress(false);
      card.classList.remove("is-busy");
      setSubtitle("更新未完成");
      setStatus("请检查网络连接后重试", "error");
      actionBtn!.disabled = false;
      if (actionLabel) actionLabel.textContent = "重试";
    });
  };
}

// Restart driver used by the new update card.
export function performRestartCard(btn: HTMLButtonElement, labelEl: HTMLElement | null, subtitleEl: HTMLElement | null, statusEl: HTMLElement | null, progressEl: HTMLElement | null) {
  fetch("/api/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin"
  })
  .then(function(res) { return res.json(); })
  .then(function() {
    showRestartOverlay();
  })
  .catch(function() {
    // Network error likely means the server already shut down — show overlay anyway
    showRestartOverlay();
  });
}

/**
 * Call POST /api/restart and show the restart overlay.
 */
export function performRestart(btn?: HTMLButtonElement | null, msgEl?: HTMLElement | null) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在重启…";
  }
  if (msgEl) {
    msgEl.textContent = "服务正在重启…";
    msgEl.style.color = "var(--text-secondary)";
  }

  fetch("/api/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin"
  })
  .then(function(res) { return res.json(); })
  .then(function() {
    showRestartOverlay();
  })
  .catch(function() {
    // Network error likely means server already shut down — show overlay anyway
    showRestartOverlay();
  });
}

/**
 * Full-screen overlay shown during server restart.
 * Polls /api/config until the server comes back, then reloads the page.
 */
export function showRestartOverlay() {
  // Avoid duplicates
  if (document.getElementById("restart-overlay")) return;

  var overlay = document.createElement("div");
  overlay.id = "restart-overlay";
  overlay.className = "restart-overlay";
  overlay.innerHTML =
    '<div class="restart-overlay-content">' +
      '<div class="restart-spinner"></div>' +
      '<div class="restart-title">服务正在重启</div>' +
      '<div class="restart-subtitle">稍后将自动刷新页面…</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var attempts = 0;
  var maxAttempts = 180; // 180 * 2s = 6min; beta git installs can be slow
  var timer = setInterval(function() {
    attempts++;
    fetch("/api/config", { credentials: "same-origin" })
      .then(function(res) {
        if (res.ok) {
          clearInterval(timer);
          location.reload();
        }
      })
      .catch(function() {
        // Server not ready yet
      });
    if (attempts >= maxAttempts) {
      clearInterval(timer);
      var subtitle = overlay.querySelector(".restart-subtitle");
      if (subtitle) {
        subtitle.innerHTML = '重启超时，请 <a href="javascript:location.reload()" style="color:var(--accent);text-decoration:underline">手动刷新</a> 页面。';
      }
    }
  }, 2000);
}

export function showAutoUpdateOverlay(currentVer: string, latestVer: string) {
  if (document.getElementById("restart-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "restart-overlay";
  overlay.className = "restart-overlay";
  overlay.innerHTML =
    '<div class="restart-overlay-content">' +
      '<div class="restart-spinner"></div>' +
      '<div class="restart-title">自动更新中</div>' +
      '<div class="restart-subtitle">' +
        escapeHtml(currentVer) + ' → ' + escapeHtml(latestVer) +
        '<br>正在下载并安装新版本，稍后将自动重启…' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
}
