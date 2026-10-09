import { isStandaloneSettingsPage } from "../page.js";
import { readSpeechMode, speechInputDescription } from "../react/speech/repository";
import { clearNoticeView, paintBootNotice, paintOfflineNotice } from "./notice-view-adapter";
import { composer, state, writeStoredBoolean } from "./state";
import { invalidateChatInteraction } from "./chat-render-focus.js";
import { restoreActiveTask } from "./active-task";
import { iconSvg } from "./i18n";
import { escapeHtml, refreshTailMarqueePaths, scrollPathElementToEnd } from "./utils";
import { getConfigCwd } from "./chat-scroll";
import { attachEventListeners } from "./events";
import { isSidebarDrawerLayout } from "./file-browser";
import { loadGitStatus } from "./git-commit";
import { autoResizeInput, getSelectedSession } from "./input";
import { requestNotificationPermission, notifyUpdateAvailable, _apkVersion, _macAppVersion } from "./notifications";
import { applyCurrentView, applyConfigDefaultThinking, checkApkAutoUpdate, checkDmgAutoUpdate, closeTransientSessionsDrawer, COMPOSER_IDLE_HINT, fetchAvailableModels, getComposerPlaceholder, hasNativeSwitchServer, loadSessions, refreshAll, syncComposerModeSelect, syncComposerModelSelect, updateDrawerState, updateShellChrome } from "./session-engine";
import { maybeScrollTerminalToBottom } from "./terminal";
import { ensureTerminalFit, ensureTerminalFitWithRetry, teardownTerminal } from "./viewport";
import { initWebSocket, forceReconnectWebSocket, cancelWsReconnect, evaluateWsHeartbeatStale, startPolling, syncComposerBadges } from "./websocket";
import { syncComposerActionError } from "./composer-action-error";
import {
  isBrowserReactShellMounted,
  renderBrowserReactShell,
  unmountBrowserReactShell,
} from "./shell-runtime";

// options.preserveStickState=true：仅清渲染缓存，不动 sticky/未读
// 状态。用于 page-refresh、ws 重连等"用户停留在当前会话，只是想刷新
// DOM"的场景——不能把用户从历史位置拽回底部。
// 默认（false）：切会话 / 新建 / home 等真正"换上下文"路径用，全清。
export function resetChatRenderCache(options?: any) {
  var opts = options || {};
  state.chatRenderCache?.reset();
  state.chatRenderEpoch = (state.chatRenderEpoch || 0) + 1;
  state.chatRenderPendingToken = null;
  state.lastRenderedMsgCount = 0;
  state.lastRenderedEmpty = null;
  state.renderPending = false;
  if (!opts.preserveStickState) {
    state.chatRenderedCount = state.chatPageSize;
    state.chatRenderWindowMessageCount = 0;
    invalidateChatInteraction();
    state.askUserSelections = {};
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
  state.chatScrollElement = null;
  state.chatScrollHandler = null;
  state.chatScrollWheelHandler = null;
  state.chatScrollTouchStartHandler = null;
  state.chatScrollTouchMoveHandler = null;
  state.chatIsProgrammaticScroll = false;
  if (!opts.preserveStickState) {
    // 切会话时未读状态归零、贴底重置——避免上一个会话残留的"未读气泡"。
    state.chatStickToBottom = true;
    state.chatUnreadCount = 0;
    state.chatUnreadStartIndex = -1;
    // 真正换会话时才允许首帧贴底；preserve 路径下保留旧 initial 状态。
    state.chatInitialRenderDone = false;
  }
}

export function getEffectiveCwd() {
  return state.workingDir || getConfigCwd();
}

window.addEventListener('online', function() {
  state.isOnline = true;
  updateOfflineBanner();
});

window.addEventListener('offline', function() {
  state.isOnline = false;
  updateOfflineBanner();
});

export function updateOfflineBanner() {
  var banner = document.getElementById('offline-banner');
  if (!state.isOnline && !banner) {
    var el = document.createElement('div');
    el.id = 'offline-banner';
    el.className = 'offline-banner';
    // 全站提示都是中文，这条也不例外（原来那句英文只在真断线时才看得见）。
    el.style.cssText = "position:fixed;top:var(--wand-safe-top);left:50%;transform:translateX(-50%);z-index:20030;width:min(440px,calc(100vw - 32px))";
    document.body.appendChild(el);
    paintOfflineNotice(el);
  } else if (state.isOnline && banner) {
    clearNoticeView(banner);
    banner.remove();
  }
}

export function renderBootLoading() {
  if (isStandaloneSettingsPage()) return;
  var app = document.getElementById("app");
  if (!app) return;
  paintBootNotice(app);
}

/**
 * React shell mount failure has no legacy shell left to fall back to, so the
 * user must not be left staring at an empty #app. Reuses the boot card markup
 * and its existing styles instead of introducing a second error surface.
 */
export function renderBootFailure() {
  var app = document.getElementById("app");
  if (!app) return;
  paintBootNotice(app, "界面加载失败，请刷新页面重试");
}

export function scheduleForegroundSync(reason: string, opts?: any) {
  if (!state.config) return;
  if (document.hidden) return;
  var immediate = opts && opts.immediate === true;
  var now = Date.now();
  // 节流只是为了防止 visibilitychange/focus/pageshow 在前台切换时
  // 连珠炮式触发同一份重连工作，不再借此延迟实际同步——之前用
  // 80ms 兜延迟的版本会在前台事件后再去 loadOutput 全量重写
  // terminal，但终端尺寸那时还没适配到稳定后的视口，
  // 写进去的全是按错列宽排版的内容，结果"切回前台/刷新页面 →
  // 中间一大段都看不到"反而成了常态。
  if (!immediate && now - state.lastForegroundSyncAt < 1500) return;
  state.lastForegroundSyncAt = now;
  if (state.foregroundSyncTimer) {
    clearTimeout(state.foregroundSyncTimer);
    state.foregroundSyncTimer = null;
  }
  syncOnForeground(reason, immediate);
}

export function syncOnForeground(reason: string, force?: boolean) {
  if (!state.config) return Promise.resolve();
  if (document.hidden) return Promise.resolve();
  // 切回前台时立刻评估一次心跳 stale。setInterval 在 background 会被
  // 浏览器节流（最低 1Hz，部分浏览器更慢），所以如果挂了 1 分钟回来，
  // 不主动跑这一次的话要等到下一个 10s tick 才会发现，前 10s 会继续
  // 往一条死 socket 上推消息。
  if (!force) evaluateWsHeartbeatStale();
  // On Android resume the previous WS may still report OPEN/CONNECTING
  // for a few seconds because the close frame hasn't been delivered
  // yet (TCP keepalive / Doze suspended the network stack). Force a
  // fresh socket so we don't sit on a zombie connection.
  if (force) {
    forceReconnectWebSocket("resume-force");
  } else if (!state.ws || (state.ws.readyState !== WebSocket.OPEN && state.ws.readyState !== WebSocket.CONNECTING)) {
    initWebSocket();
  }
  // 离开浏览器期间 agent / 别的终端也可能改过工作区：回前台就把 git 徽章取新。
  if (state.selectedId) {
    void loadGitStatus(state.selectedId, { force: true });
  }
  // 不再 loadOutput 当前会话——WS 重连后服务端会主动推一条 init
  // 消息，那条路径已经走 ensureTerminalFitWithRetry 强制按真实
  // cols 重排 history，足够覆盖前台恢复时的同步需求。这里多加
  // 一次 fetch + syncTerminalBuffer 反而会在 ws/http 两路的 output
  // 之间来回 reset，导致 alt-screen 中正在绘制的 Claude TUI 被
  // 中途清掉。只把会话列表刷一下，保证状态条/会话名等元数据是新的。
  return loadSessions({ skipSelectedOutputReload: true }).catch(function(e: any) {
    console.error("[wand] foreground sync failed:", reason, e);
  });
}

export function bindForegroundSyncListeners() {
  if ((window as any).__wandForegroundSyncBound) return;
  (window as any).__wandForegroundSyncBound = true;

  document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
      // Stop the reconnect backoff while hidden — the OS may freeze
      // timers and then deliver them in a burst when we resume,
      // creating a thundering-herd of connect attempts. The resume
      // event will trigger one decisive reconnect instead.
      cancelWsReconnect();
    } else {
      scheduleForegroundSync("visibility");
      ensureTerminalFitWithRetry("visibility");
    }
  });

  window.addEventListener("focus", function() {
    scheduleForegroundSync("focus");
  });

  window.addEventListener("pageshow", function() {
    scheduleForegroundSync("pageshow");
  });

  window.addEventListener("resume", function() {
    scheduleForegroundSync("resume");
  });

  // Bridge from Android WebView host: MainActivity.onResume() calls
  // evaluateJavascript to dispatch this event, which is the only
  // reliable foreground signal once Doze/process-suspension has
  // frozen page-level events (visibilitychange/focus/pageshow may
  // fire late or not at all after a long suspend). Force-reconnect
  // and force-refit immediately rather than waiting for the
  // throttled scheduleForegroundSync path.
  window.addEventListener("wand-android-resume", function() {
    scheduleForegroundSync("android-resume", { immediate: true });
    ensureTerminalFitWithRetry("android-resume");
  });

  // Bridge from Android IME animation. State values: "start" / "shown" / "hidden".
  // 原生层用 setPadding 在 WebView 父容器上 resize WebView, 视觉上键盘
  // 动画跟系统同步, 但带来一个副作用: window.innerHeight === visualViewport.height,
  // 导致 setupVisualViewportHandlers 里的 isKeyboardOpen 检测 (基于
  // offsetBottom) 永远是 false, 不会进 keyboard-open / keyboard-close 分支,
  // 终端 fit 路径也就不跑了。
  //
  // 这里直接听原生层的"键盘动画收尾"事件, 触发 ensureTerminalFit
  // 把 xterm 网格按真实视口重新 fit。
  window.addEventListener("wand-ime-state", function(e: any) {
    var which = e && e.detail && e.detail.state;
    if (which === "shown" || which === "hidden") {
      try {
        ensureTerminalFit("native-ime-" + which, { forceReplay: true });
        maybeScrollTerminalToBottom("native-ime");
      } catch (_e) {}
    }
  });

  // Bridge from Android ConnectivityManager.NetworkCallback. State values:
  //   "available"  — 默认网络刚刚可用 (启动期没网 → 接上)
  //   "changed"    — 已有网络切到另一个 (Wi-Fi ↔ 4G), socket 必死
  //   "validated"  — captive portal / VPN 验证完成, internet 才真正通
  //   "lost"       — 默认网络断了, 还没有备援网络
  // 前三种都强制重连; "lost" 不动 socket, 只更新 isOnline 让 UI 提示。
  // 这条路径比 navigator.online / visibilitychange 早 2-8 秒触发,
  // 切网后用户基本看不到断线提示。
  window.addEventListener("wand-android-network", function(e: any) {
    var which = e && e.detail && e.detail.state;
    if (which === "lost") {
      state.isOnline = false;
      try { updateOfflineBanner(); } catch (_e) {}
      return;
    }
    if (which === "available" || which === "changed" || which === "validated") {
      // 以原生信号为权威, 立刻翻 isOnline 给 UI; 有些 ROM 上
      // navigator.onLine 要等几秒才更新, 否则 banner 会闪一下。
      state.isOnline = true;
      try { updateOfflineBanner(); } catch (_e) {}
      forceReconnectWebSocket("android-network-" + which);
    }
  });
}

export function restoreLoginSession() {
  if (isStandaloneSettingsPage()) return;
  // Probe an unauthenticated endpoint first so an anonymous visit
  // does not leave a noisy 401 on /api/config in DevTools.
  fetch("/api/session-check", { credentials: "same-origin" })
    .then(function(res) { return res.ok ? res.json() : { authed: false }; })
    .then(function(info: any) {
      if (!info || !info.authed) {
        state.loginChecked = true;
        render();
        return null;
      }
      return fetch("/api/config", { credentials: "same-origin" }).then(function(res) {
        if (!res.ok) {
          state.loginChecked = true;
          render();
          return null;
        }
        return res.json();
      });
    })
    .then(function(config: any) {
      if (!config) return;
      state.config = config;
      applyConfigDefaultThinking(config);
      state.loginChecked = true;
      requestAnimationFrame(function() {
        try {
          render({ skipShellChrome: true });
        } catch (_e) {
          // render() may fail if external terminal assets failed to load;
          // continue with polling and session loading so the app remains functional
        }
        startPolling();
        // 会话加载完再恢复任务上下文：弹回上次打开的任务（标签栏 / 分屏），
        // 否则主区只剩一条裸会话（会话选中态是持久化的，任务上下文不是）。
        refreshAll().then(function() { return restoreActiveTask(); });
        fetchAvailableModels();
        requestNotificationPermission();
        if (config.updateAvailable && config.latestVersion) {
          notifyUpdateAvailable(config.currentVersion || "-", config.latestVersion);
        }
        // APK auto-update check on startup
        if (_apkVersion) {
          checkApkAutoUpdate();
        }
        // macOS DMG auto-update check on startup
        if (_macAppVersion) {
          checkDmgAutoUpdate();
        }
      });
    })
    .catch(function() {
      state.loginChecked = true;
      if (!navigator.onLine) {
        var app = document.getElementById("app");
        if (app) {
          paintBootNotice(app, "无法连接到服务器", "请检查网络连接或确认 Wand 服务正在运行。");
        }
        window.addEventListener('online', function() { location.reload(); }, { once: true });
        return;
      }
      render();
    });
}

// ===== 桌面：点 sidebar 外的空白处自动收起 =====
// 只对「临时打开但未锁定」的全尺寸侧栏生效；已锁定的 pinned 侧栏
// 必须保持常驻，除非用户明确点 X 关闭。
// - 仅 desktop + 未锁定 + 全尺寸（非窄条）+ 已打开 时生效
// - 窄条态不触发（窄条本来就是稳定常驻形态）
// - 手机端由 .drawer-backdrop 元素自己接住点击，不在这里重复处理
// - 各类弹层（modal / topbar-more / overflow 菜单 / 文件夹下拉等）不算
//   「sidebar 外的空白」，否则点弹层会顺带把 sidebar 关掉
// 用 capture 阶段是为了绕过下游按钮自己的 stopPropagation。
document.addEventListener("click", function(e) {
  if (isSidebarDrawerLayout()) return;
  if (state.sidebarPinned) return;
  if (state.sidebarCollapsed) return;
  if (!state.sessionsDrawerOpen) return;
  var target = e.target;
  if (!target || !(target instanceof Element)) return;
  if (target.closest("#sessions-drawer")) return;
  if (target.closest("#sessions-toggle-button")) return;
  if (target.closest(".floating-sidebar-toggle")) return;
  if (target.closest(".sidebar-tile-bubble")) return;
  if (target.closest(
    // 权限弹窗现在是 chat/terminal 面板内的既有 React 覆盖层（composer 之外），
    // 不再需要一个 .permission-prompt-overlay 类；这里只列真实存在的宿主。
    ".modal-backdrop, .modal-overlay, .modal-container, " +
    "[role='dialog'], [role='menu'], " +
    ".topbar-more-menu, .sidebar-header-overflow, " +
    ".path-suggestions"
  )) return;
  closeTransientSessionsDrawer();
}, true);

renderBootLoading();
restoreLoginSession();

export function render(options?: any) {
  if (isStandaloneSettingsPage()) return;
  const boot = document.getElementById("app");
  if (boot) clearNoticeView(boot);
  var skipShellChrome = options && options.skipShellChrome;
  var app = document.getElementById("app");
  if (!app) return;
  var isLoggedIn = state.config !== null;
  var reactShellWasMounted = isBrowserReactShellMounted();
  var shouldResetShell = !isLoggedIn
    || (!reactShellWasMounted && !!document.getElementById("output"));

  if (shouldResetShell) {
    teardownTerminal();
  }
  if (!isLoggedIn && reactShellWasMounted) {
    unmountBrowserReactShell();
  }

  // Suppress CSS transitions during initial DOM build
  document.documentElement.classList.add("no-transition");

  // Apply persisted pin state before rendering.
  // 窄条（collapsed）形态不靠 .open 显示，靠 .pinned.collapsed 的 width:56px
  // 常驻；此时强制 sessionsDrawerOpen=true 会与 toggleSidebarCollapsed 里设的
  // false 打架，并在手机端误触发背景遮罩。窄条态下不强制 open。
  if (state.sidebarPinned && !state.sidebarCollapsed && !isSidebarDrawerLayout()) {
    state.sessionsDrawerOpen = true;
    writeStoredBoolean("wand-sidebar-open", true);
  }
  var shellRenderResult: "mounted" | "updated";
  var rebuiltLegacyHosts = false;
  if (isLoggedIn) {
    try {
      shellRenderResult = renderBrowserReactShell(app, renderAppShell);
    } catch (error) {
      console.error("[wand] React shell mount failed", error);
      unmountBrowserReactShell();
      document.documentElement.classList.remove("no-transition");
      renderBootFailure();
      return;
    }
    rebuiltLegacyHosts = shellRenderResult === "mounted";
  } else {
    app.innerHTML = renderLogin();
    rebuiltLegacyHosts = true;
  }

  // Stable React slots bind once. Legacy fallback still rebuilds and rebinds.
  if (rebuiltLegacyHosts) {
    resetChatRenderCache();
    attachEventListeners();
  }
  updateDrawerState();
  syncComposerModeSelect();
  syncComposerModelSelect(getSelectedSession());
  syncComposerBadges();
  syncComposerActionError();
  applyCurrentView();
  if (!skipShellChrome) {
    updateShellChrome();
  }

  // Force reflow then re-enable transitions after layout settles
  void document.body.offsetHeight;
  requestAnimationFrame(function() {
    // The React shell can reveal its stable composer host during this frame.
    // Resize after that reveal as well as during event binding; otherwise a
    // persisted multi-line draft may have been measured while the host still
    // had no usable width and remain clipped at the one-line minimum.
    if (isLoggedIn) {
      autoResizeInput(document.getElementById("input-box"));
    }
    document.documentElement.classList.remove("no-transition");
  });

  // 初始加载或会话切换后惰性触发 git 状态拉取（loadGitStatus 自带节流）。
  if (isLoggedIn && state.selectedId && state.gitStatusSessionId !== state.selectedId) {
    loadGitStatus(state.selectedId);
  }

  // 长路径元素（topbar 的 cwd）滚到末尾展示末尾目录。
  // 渲染刚完成，元素可能尚未完成布局，scrollPathElementToEnd 内部用 rAF 兜底。
  // blank-chat 的 cwd 路径元素只存在于已删除的 legacy Shell markup 里，
  // React Shell 的空白页不再渲染 #blank-chat-cwd-path。
  scrollPathElementToEnd(document.getElementById("topbar-cwd"));
  refreshTailMarqueePaths();
}

export function renderLogin() {
  return '<div data-login-controls style="height:100%" data-checking="' + (!state.loginChecked) +
    '" data-switch-server="' + hasNativeSwitchServer() + '"></div>';
}

// Seeds only the imperative host children. Shell chrome and welcome content
// are rendered exclusively by React; this markup is never mounted as a page.
export function renderAppShell() {
  var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  var currentDraft = composer.read(state.selectedId).text;
  return (
        // 文件面板（含 backdrop、头部、搜索框）归 React Shell 渲染；
        // 只保留 #file-explorer 槽位锚点，legacy 不再往里写内容。
        '<div class="file-explorer" id="file-explorer"></div>' +
        '<div id="output" class="terminal-container' + (state.selectedId ? "" : " hidden") + ' active">' +
          '<div class="terminal-scale-overlay" aria-label="终端缩放控件">' +
            // 只有 title 时读屏在图标 / 符号按钮上只能念出「减号 / 加号」，够不到动作本身
            // （UX-CONTRACT 的 WCAG 2.2 AA 4.1.2）；aria-label 与 title 同步写明动作。
            '<button data-antd-control id="terminal-scale-down-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="缩小" aria-label="缩小终端字号">−</button>' +
            '<span class="terminal-scale-overlay-label terminal-scale-label" id="terminal-scale-label-top">' + Math.round(state.terminalScale * 100) + '%</span>' +
            '<button data-antd-control id="terminal-scale-up-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="放大" aria-label="放大终端字号">+</button>' +
            '<span class="terminal-scale-overlay-divider"></span>' +
            '<button data-antd-control id="page-refresh-btn" class="terminal-scale-overlay-btn" type="button" title="刷新页面" aria-label="刷新页面">' + iconSvg("refresh", { size: 13, strokeWidth: 2 }) + '</button>' +
          '</div>' +
          '<button data-antd-control id="terminal-jump-bottom" class="terminal-jump-bottom' + (state.showTerminalJumpToBottom ? ' visible' : '') + '" type="button" title="回到底部" aria-label="回到底部"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></button>' +
        '</div>' +
        '<div id="chat-output" class="chat-container hidden">' +
          '<div id="chat-fold-bar" class="chat-fold-bar hidden" aria-live="polite"></div>' +
          '<button data-antd-control id="chat-unread-bubble" class="chat-unread-bubble" type="button" title="回到最新消息" aria-label="回到最新消息">' +
            '<span class="chat-unread-bubble-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></span>' +
            '<span class="chat-unread-bubble-count" aria-hidden="true"></span>' +
          '</button>' +
        '</div>' +
        // 持续可见的「正在执行」状态条宿主（React 投影，读数来自服务端本轮锚点）。
        // 固定占位在聊天区与输入区之间：出现/消失只改自身高度，不推动触发点。
        '<div id="chat-running-host"></div>' +
        '<div id="cross-session-queue-host"></div>' +
        '<div class="input-panel' + (state.selectedId ? "" : " hidden") + '">' +
          '<div class="composer-top-row">' +
            '<div id="todo-progress" class="todo-progress hidden">' +
              '<button data-antd-control class="todo-progress-header" id="todo-progress-toggle" type="button" aria-expanded="false" aria-controls="todo-progress-body" aria-label="展开待办列表">' +
                '<span id="todo-progress-summary"></span>' +
              '</button>' +
            '</div>' +
            '<div class="todo-progress-body hidden" id="todo-progress-body">' +
              '<div id="todo-progress-content"></div>' +
            '</div>' +
          '</div>' +
          // 排队气泡宿主：绝对定位浮在 .input-panel 顶边线「上方」、右侧贴边。
          // 垂直排列，一行一个液态玻璃气泡（编号 + 文本 + 立即/删除）。
          // updateQueueBar() 在 queuedMessages 非空时去掉 hidden。
          '<div id="queue-bar-host" class="queue-bar-host" hidden></div>' +
          '<div id="terminal-shortcuts" class="terminal-shortcuts" hidden></div>' +
          // 输入主行：正文独占上层书写区域；下层按参考布局分为
          // 「添加 / 权限」与「模型 / 思考 / 发送」两组，键盘顺序与视觉顺序一致。
          '<div class="input-composer-row" data-pi-composer="">' +
          '<span data-pi-settings-host=""></span>' +
          '<div class="input-composer' + (String(currentDraft || "").trim() ? ' has-text' : '') + (state.terminalInteractive ? ' is-terminal-interactive' : '') + '" role="group" aria-label="消息编辑器">' +
            // 附件预览条由 React portal 渲染（见 composer-attachments 组件）。
            '<span class="composer-attachments-host" data-composer-attachments-host="main"></span>' +
            '<div class="composer-main-row">' +
              '<div class="composer-input-wrap">' +
                '<button data-antd-control class="prompt-optimize-btn" id="prompt-optimize-btn" type="button" title="优化提示词" aria-label="优化提示词">' +
                  iconSvg("sparkle", { size: 15, strokeWidth: 1.9, cls: "prompt-optimize-icon" }) +
                  '<span class="prompt-optimize-label">优化</span>' +
                '</button>' +
                '<div data-composer-sender><textarea id="input-box" class="input-textarea" aria-label="消息输入" placeholder="' + getComposerPlaceholder(selectedSession, state.terminalInteractive) + '" rows="1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">' + escapeHtml(currentDraft) + '</textarea></div>' +
              '</div>' +
              '<div class="composer-actions-left" role="group" aria-label="添加内容与权限">' +
                // 加号按钮 —— 点击向上展开 popover：附件 / 终端交互 / 三件套（模式·模型·思考）
                '<button id="attach-btn" data-antd-control class="composer-attach-trigger" type="button" title="附件与执行选项（思考深度、模型和权限）" aria-label="更多操作" aria-haspopup="dialog" aria-controls="composer-plus-popover" aria-expanded="false">' +
                  iconSvg("plus", { size: 18, strokeWidth: 2.2 }) +
                '</button>' +
                '<button id="voice-record-btn" data-antd-control type="button" title="' + escapeHtml(speechInputDescription(readSpeechMode())) + '" aria-label="按住语音输入" aria-pressed="false"' + (state.terminalInteractive ? ' disabled' : '') + '>' +
                  iconSvg("mic", { size: 18, strokeWidth: 1.8 }) +
                '</button>' +
                // tabindex="-1": 把 file input 移出 iOS Safari 表单导航链，避免软键盘顶部工具条出现 ⌃ ⌄ ✓。
                '<input type="file" id="file-upload-input" multiple tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0);pointer-events:none">' +
                // Pi 会话设置图标（React portal，见 pi-settings 组件）：只在 Pi 结构化会话
                // 挂载，点开就在输入框上方原位展开设置面板；非 Pi 会话宿主为空、不占位。
                '<span class="composer-pi-settings-toggle-host" data-pi-settings-toggle-host=""></span>' +
                '<div class="composer-status-row" id="composer-status-row">' +
                  // 三件套 chip 的内容全部由 React portal 渲染（见 composer-config 组件），
                  // 宿主常驻；chip 内还会长出 select 宿主，所以配置同步要先于 select 同步。
                  '<span class="composer-config-host" data-composer-config-host="mode"></span>' +
                  // 徽章内容由 React portal 渲染（见 composer-badges 组件），宿主常驻，
                  // 空状态用宿主上的 `.hidden` 表达。
                  '<span class="composer-badge-host" data-composer-badge-host="auto-approve"></span>' +
                  '<span class="composer-badge-host hidden" data-composer-badge-host="permissions"></span>' +
                  '<span class="composer-badge-host" data-composer-badge-host="approval-stats"></span>' +
                  // 输入区的原位结果行：空闲时常驻快捷键教学（这句话原来挂在已死的
                  // .input-hint 上，没有任何宿主），发送时依次显示 加载 → 完成/失败 → 结果，
                  // 不再用浮层 Toast 承担。aria-live 让读屏播报失败原因；成功态只是文字换色，
                  // 不抢焦点（焦点留在输入框，用户可以接着打字）。
                  '<span class="composer-status-line" id="composer-status-line" role="status" aria-live="polite">' + escapeHtml(COMPOSER_IDLE_HINT) + '</span>' +
                '</div>' +
              '</div>' +
              '<div class="composer-actions-right" role="group" aria-label="模型与发送">' +
                // 直通模式的 Appica 发送按钮挂在这里（其余 legacy 按钮在直通下收起）。
                '<span class="composer-rail-host" data-composer-rail-host="pty"></span>' +
                '<div class="composer-inline-config">' +
                  // 注意：`.composer-inline-config` 的闭合由紧邻它的这个 `</div>` 承担，
                  // 后续按钮因此落在 `.composer-actions-right` 内。删改这段时必须保持标签平衡，
                  // 否则 `.input-panel` 会提前闭合，其后面的浮层（popover/语音气泡/错误条）会被
                  // React 外壳的 `replaceChildren()` 丢弃。
                  '<span class="composer-config-host" data-composer-config-host="runtime"></span>' +
                '</div>' +
                // 「立即发送」按钮已下线 —— 默认行为永远是排队（气泡），想插队点输入框上方那条气泡。
                // 输入控制器只更新data-phase；Ant投影单个发送/停止/结果图标。
                '<button id="send-input-button" data-antd-control="primary" type="button" data-phase="idle" title="发送" aria-label="发送消息"></button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '</div>' +
          // 加号气泡 —— 浮在 + 按钮上方（.input-composer 之外，绕开它的 overflow:hidden）。
          // 内容：附件 / 终端交互 / 三件套（模式·模型·思考）。默认 hidden，点 + 切换；
          // 点 popover 外部 / Esc / 选完任一项后自动关闭。
          '<div class="composer-plus-popover hidden" id="composer-plus-popover" role="dialog" aria-modal="false" aria-label="更多操作" aria-hidden="true">' +
            // 两个条目（上传附件 / 终端交互）由 React portal 渲染（见 composer-popover
            // 组件），宿主常驻；容器本身的开关与键盘导航仍然归 legacy。
            '<span class="plus-popover-items-host" data-composer-popover-host="items"></span>' +
            // 模式 + 模型/思考：复用 data-mode-control 的 select 委托链。
            // 对所有会话都展示；服务端负责落盘当前会话可变的设置，不能即时应用的
            // CLI 启动参数会作为后续轮次 / 新会话默认值生效。
            '<div class="plus-popover-sep" aria-hidden="true"></div>' +
            '<div class="plus-popover-trio-wrap">' +
              '<p class="composer-settings-scope">执行选项 · 应用于当前会话；模型和思考深度同时记为此设备的新会话偏好。已启动的终端参数保持不变。</p>' +
              '<span class="composer-config-host" data-composer-config-host="all"></span>' +
            '</div>' +
          '</div>' +
          // 关闭时不发布 mount。落点与旧实现 insertAdjacentElement("afterend") 一致。
          // 语音实时转写气泡 —— 浮在输入框上方（.input-composer 之外，绕开它的
          // overflow:hidden）。**内容由 React portal 渲染**（见 composer-voice 组件）：
          // 非录音态不发布 mount，整条气泡不渲染，等价于原来的 .hidden。
          '<span class="composer-voice-host" data-composer-voice-host="main"></span>' +
          // 错误条由 React portal 渲染（见 composer-action-error 组件），
          // legacy 通过 state.actionError 表达文案。
          '<span class="composer-action-error-host" data-composer-action-error-host="main"></span>' +
        '</div>'
  );
}
