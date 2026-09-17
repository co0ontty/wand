import { state, writeStoredBoolean } from "./state";
import { renderProviderLogoMarkup } from "../provider-identity";
import { iconSvg } from "./i18n";
import { escapeHtml, refreshTailMarqueePaths, renderTailMarqueePath, scrollPathElementToEnd, updateRunningIndicators } from "./utils";
import { getConfigCwd } from "./chat-scroll";
import { shortCommand } from "./chat-render";
import { attachEventListeners } from "./events";
import { shouldShowSessionsBackdrop, isMobileLayout } from "./file-browser";
import { loadGitStatus, renderTopbarGitBadgeHtml, renderTopbarMoreMenuHtml } from "./git-commit";
import { autoResizeInput, getSelectedSession } from "./input";
import { requestNotificationPermission, notifyUpdateAvailable, _apkVersion, _macAppVersion } from "./notifications";
import { applyCurrentView, checkApkAutoUpdate, checkDmgAutoUpdate, closeTransientSessionsDrawer, fetchAvailableModels, getComposerPlaceholder, hasNativeBackToApp, hasNativeSwitchServer, loadSessions, refreshAll, refreshClaudeSkillsPicker, syncComposerModeSelect, syncComposerModelSelect, updateDrawerState, updateShellChrome } from "./session-engine";
import { getSessionStatusClass, getSessionStatusLabel } from "./session-ui";
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
  state.lastRenderedHash = 0;
  state.lastRenderedMsgCount = 0;
  state.lastRenderedEmpty = null;
  state.renderPending = false;
  state.chatRenderedCount = state.chatPageSize;
  state.askUserSelections = {};
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
    el.textContent = 'You are offline - some features may be limited';
    document.body.appendChild(el);
  } else if (state.isOnline && banner) {
    banner.remove();
  }
}

export function renderBootLoading() {
  var app = document.getElementById("app");
  if (!app) return;
  app.innerHTML =
    '<div class="boot-loading">' +
      '<div class="boot-loading-card">' +
        '<div class="boot-loading-spinner"></div>' +
        '<div class="boot-loading-text">正在连接 Wand…</div>' +
      '</div>' +
    '</div>';
}

/**
 * React shell mount failure has no legacy shell left to fall back to, so the
 * user must not be left staring at an empty #app. Reuses the boot card markup
 * and its existing styles instead of introducing a second error surface.
 */
export function renderBootFailure() {
  var app = document.getElementById("app");
  if (!app) return;
  app.innerHTML =
    '<div class="boot-loading">' +
      '<div class="boot-loading-card">' +
        '<div class="boot-loading-text">界面加载失败，请刷新页面重试</div>' +
      '</div>' +
    '</div>';
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
      state.loginChecked = true;
      requestAnimationFrame(function() {
        try {
          render({ skipShellChrome: true });
        } catch (_e) {
          // render() may fail if external terminal assets failed to load;
          // continue with polling and session loading so the app remains functional
        }
        startPolling();
        refreshAll();
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
          app.innerHTML =
            '<div class="boot-loading">' +
              '<div class="boot-loading-card">' +
                '<div class="boot-loading-text" style="font-size:1.3em;margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:8px">' + iconSvg("signal", { size: 20, strokeWidth: 1.8 }) + '<span>无法连接到服务器</span></div>' +
                '<div class="boot-loading-text" style="opacity:0.7;font-size:0.95em">请检查网络连接或确认 Wand 服务正在运行。</div>' +
                '<button onclick="location.reload()" style="margin-top:18px;padding:8px 24px;border-radius:8px;border:1px solid rgba(150,118,85,0.3);background:rgba(255,255,255,0.8);cursor:pointer;font-size:0.95em">重试</button>' +
              '</div>' +
            '</div>';
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
  if (isMobileLayout()) return;
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
    ".modal-backdrop, .modal-overlay, .modal-container, " +
    "[role='dialog'], [role='menu'], " +
    ".topbar-more-menu, .sidebar-header-overflow, " +
    ".path-suggestions, " +
    ".permission-prompt-overlay"
  )) return;
  closeTransientSessionsDrawer();
}, true);

renderBootLoading();
restoreLoginSession();

export function render(options?: any) {
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
  if (state.sidebarPinned && !state.sidebarCollapsed && !isMobileLayout()) {
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
  refreshClaudeSkillsPicker();
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

  // DOM 整体重渲后，重新挂上"运行中"指示器（顶部进度条/徽章计时/气泡呼吸条）
  if (isLoggedIn) {
    var __sel = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
    updateRunningIndicators(__sel);
  }

  // 长路径元素（topbar 的 cwd）滚到末尾展示末尾目录。
  // 渲染刚完成，元素可能尚未完成布局，scrollPathElementToEnd 内部用 rAF 兜底。
  // blank-chat 的 cwd 路径元素只存在于已删除的 legacy Shell markup 里，
  // React Shell 的空白页不再渲染 #blank-chat-cwd-path。
  scrollPathElementToEnd(document.getElementById("topbar-cwd"));
  refreshTailMarqueePaths();
}

// 品牌标记：与 index.ts 的 favicon data-URI 同源（深色圆角方块 + 赤陶色折线），
// 内联成 SVG，保证本地控制台离线可用、不依赖任何外部 CDN。
var LOGIN_BRAND_MARK =
  '<svg class="brand-logo" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    '<rect width="64" height="64" rx="18" fill="#17120f"/>' +
    '<path d="M13 21l9 24 10-15 10 15 9-24" fill="none" stroke="#c5653d" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

var LOGIN_TRUST_LINE =
  '<p class="trust-line">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
    '<span>凭据只发送到当前 Wand 服务</span>' +
  '</p>';

export function renderLogin() {
  if (!state.loginChecked) {
    return '<div class="login-page">' +
      '<div class="login-left">' +
        '<div class="brand-row">' +
          LOGIN_BRAND_MARK +
          '<span class="brand-wordmark">Wand</span>' +
        '</div>' +
        '<p class="brand-statement">重新连接到这台设备上的 Wand 服务。</p>' +
        '<div class="left-spacer"></div>' +
        LOGIN_TRUST_LINE +
      '</div>' +
      '<div class="login-right">' +
        '<div class="form-col">' +
          '<p class="eyebrow">本地控制台</p>' +
          '<h1 class="login-title">正在恢复会话</h1>' +
          '<div class="login-status">' +
            '<span class="login-spinner" aria-hidden="true"></span>' +
            '<div>' +
              '<p class="login-hint">正在检查本地登录会话，请稍候。</p>' +
              '<p class="login-muted">如果你刚刷新页面，这是正常现象。</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  return '<div class="login-page">' +
    '<div class="login-left">' +
      '<div class="brand-row">' +
        LOGIN_BRAND_MARK +
        '<span class="brand-wordmark">Wand</span>' +
      '</div>' +
      '<p class="brand-statement">连接到本机终端、会话和工作区。</p>' +
      '<div class="left-spacer"></div>' +
      LOGIN_TRUST_LINE +
    '</div>' +
    '<div class="login-right">' +
      '<form id="login-form" class="form-col" autocomplete="on">' +
        '<input type="text" name="username" autocomplete="username" value="wand" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none" readonly />' +
        '<p class="eyebrow">本地控制台</p>' +
        '<h1 class="login-title">欢迎回来</h1>' +
        '<p class="login-hint">使用当前 Wand 服务的访问密码继续。</p>' +
        '<div class="field">' +
          '<label class="field-label" for="password">访问密码</label>' +
          '<div class="password-field">' +
            '<input id="password" type="password" class="password-input" placeholder="输入访问密码" autocomplete="current-password" data-error="false" aria-describedby="password-hint login-error" aria-invalid="false" />' +
            '<button id="toggle-password-button" type="button" class="password-toggle" aria-label="显示密码" aria-pressed="false">显示</button>' +
          '</div>' +
          '<p id="password-hint" class="hint">密码由当前服务验证，不会保存在此页面。</p>' +
          '<p id="login-error" class="error-message hidden" role="alert"></p>' +
        '</div>' +
        '<div id="login-cert-hint" class="login-cert-hint hidden" role="alert">' +
          '<div class="login-cert-hint-title">证书不受信任，登录态无法保存</div>' +
          '<p class="login-cert-hint-body">密码是对的，但当前 HTTPS 证书不受浏览器信任，浏览器因此拒绝保存登录 Cookie，所以进不了控制台。<br/>解决办法（任选其一）：改用 HTTP 访问本服务；或把本服务证书设为「受信任」（推荐 mkcert）；或在本机将该自签证书设为完全信任后重试。</p>' +
          '<a id="login-cert-http-link" class="btn btn-ghost btn-block" href="#" rel="noopener">改用 HTTP 访问</a>' +
        '</div>' +
        '<button id="login-button" type="submit" class="btn btn-primary btn-block">进入控制台</button>' +
        (hasNativeSwitchServer() ?
          '<button id="login-switch-server-button" class="login-switch-server" type="button">切换服务器</button>'
          : ''
        ) +
      '</form>' +
    '</div>' +
  '</div>';
}

export function renderAppShell() {
  var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  var currentDraft = state.selectedId ? (state.drafts[state.selectedId] || "") : "";
  var drawerClass = state.sessionsDrawerOpen ? " open" : "";
  var backdropClass = shouldShowSessionsBackdrop() ? " open" : "";

  // 手机端不允许「pin 但不窄条」（300px 固定边栏太占地），只允许窄条形态。
  // isAnchored = 边栏占据布局空间（推开主内容）。桌面 pin 或 任意端窄条都算 anchored。
  var isMobile = isMobileLayout();
  var isCollapsed = !!state.sidebarPinned && !!state.sidebarCollapsed;
  // 桌面端任何「可见」的侧栏都停靠（推开内容），绝不悬浮遮挡——避免主区被压到
  // 侧栏下面。pinned 只表示「锁定常驻」，open 则是临时可见，两者都算停靠。
  var isAnchored = isCollapsed || (!isMobile && (!!state.sidebarPinned || !!state.sessionsDrawerOpen));
  var collapsedCls = isCollapsed ? ' sidebar-collapsed' : '';
  var sidebarCollapsedCls = isCollapsed ? ' collapsed' : '';
  return '<div class="app-container">' +
    '<div id="sessions-drawer-backdrop" class="drawer-backdrop' + backdropClass + '"></div>' +
    '<div class="main-layout' + (state.sessionsDrawerOpen ? ' sidebar-open' : '') + (isAnchored ? ' sidebar-pinned' : '') + collapsedCls + '">' +
      '<aside id="sessions-drawer" class="sidebar' + drawerClass + (isAnchored ? ' pinned' : '') + sidebarCollapsedCls + '">' +
        '<div class="sidebar-header">' +
          '<div class="sidebar-header-main">' +
            '<div class="topbar-logo-icon">W</div>' +
            '<span class="sidebar-title">会话</span>' +
            '<span class="session-count" id="session-count">' + String(state.sessions.filter(function(session: any) { var source = String(session && session.sessionSource || "").toLowerCase(); return source !== "automation" && source !== "startup"; }).length) + '</span>' +
          '</div>' +
          '<div class="sidebar-header-actions">' +
            '<div class="sidebar-header-more">' +
              '<button id="sidebar-more-btn" class="btn btn-ghost btn-sm" type="button" title="更多操作">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>' +
              '</button>' +
              '<div class="sidebar-header-overflow" id="sidebar-overflow-menu">' +
                '<button class="overflow-item" id="sidebar-home-btn" type="button">' +
                  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' +
                  '<span>回到首页</span>' +
                '</button>' +
                '<button class="overflow-item" id="sidebar-refresh-btn" type="button">' +
                  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
                  '<span>刷新页面</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<button id="sidebar-pin-btn" class="btn btn-ghost btn-sm sidebar-pin-toggle' + (state.sidebarPinned ? ' pinned' : '') + '" type="button" title="' + (state.sidebarPinned ? '已固定常驻（点击解除锁定）' : '固定侧栏常驻') + '" aria-label="' + (state.sidebarPinned ? '解除固定常驻' : '固定侧栏常驻') + '" aria-pressed="' + (state.sidebarPinned ? 'true' : 'false') + '">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>' +
            '</button>' +
            '<button id="sidebar-collapse-btn" class="btn btn-ghost btn-sm sidebar-collapse-toggle' + (isCollapsed ? ' collapsed' : '') + '" type="button" title="' + (isCollapsed ? '展开为全尺寸' : '收起为窄条') + '" aria-label="' + (isCollapsed ? '展开为全尺寸' : '收起为窄条') + '">' +
              (isCollapsed
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 6 16 12 10 18"/><line x1="20" y1="5" x2="20" y2="19"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="14 6 8 12 14 18"/><line x1="4" y1="5" x2="4" y2="19"/></svg>') +
            '</button>' +
            '<button id="close-drawer-button" class="btn btn-ghost btn-icon sidebar-close drawer-close-btn" type="button" aria-label="关闭菜单"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
          '</div>' +
        '</div>' +
        '<div class="sidebar-body">' +
          '<div id="sessions-panel">' +
            '<div class="sessions-list" id="sessions-list"></div>' +
          '</div>' +
        '</div>' +
        '<div class="sidebar-footer">' +
          '<button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> 新会话</button>' +
          '<div class="sidebar-footer-actions">' +
            '<button id="missions-button" class="btn btn-ghost btn-sm" type="button" title="并行任务">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16l2 10v6H2v-6L4 4zM2 14h6l2 3h4l2-3h6"/></svg>' +
              '<span>任务</span>' +
            '</button>' +
            '<button id="file-panel-toggle-btn" class="btn btn-ghost btn-sm' + (state.filePanelOpen ? " active" : "") + '" type="button" title="查看文件">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
              '<span>文件</span>' +
            '</button>' +
            '<button id="settings-button" class="btn btn-ghost btn-sm" type="button" title="设置">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
              '<span>设置</span>' +
            '</button>' +
            (hasNativeBackToApp() ?
              '<button id="back-to-native-button" class="btn btn-ghost btn-sm sidebar-back-to-native" type="button" title="返回 App 原生界面">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="3" width="11" height="18" rx="2"/><line x1="14" y1="17" x2="17" y2="17"/><polyline points="7 8 3 12 7 16"/></svg>' +
                '<span>返回App</span>' +
              '</button>'
              : ''
            ) +
            (hasNativeSwitchServer() ?
              '<button id="switch-server-button" class="btn btn-ghost btn-sm sidebar-switch-server" type="button" title="切换服务器">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg>' +
                '<span>切换</span>' +
              '</button>'
              : ''
            ) +
            '<button id="logout-button" class="btn btn-ghost btn-sm sidebar-logout" type="button" title="退出登录">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
              '<span>退出</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</aside>' +
      '<main class="main-content">' +
        '<div class="main-header-row">' +
          '<div class="topbar-left">' +
            '<button id="sessions-toggle-button" class="floating-sidebar-toggle' + (state.sessionsDrawerOpen ? ' active' : '') + '" aria-label="切换会话侧栏" type="button">' +
              '<span class="hamburger-icon">' +
                '<span></span><span></span><span></span>' +
              '</span>' +
            '</button>' +
            '<span class="topbar-brand" aria-hidden="true">W</span>' +
          '</div>' +
          '<div class="topbar-center">' +
            (selectedSession
              ? (
                  '<span class="topbar-session-title' + (selectedSession.titleGenerating ? ' title-generating' : '') + '"' + (selectedSession.titleGenerating ? ' aria-busy="true"' : '') + ' title="' + escapeHtml(selectedSession.description || selectedSession.command || "") + '">' + escapeHtml(selectedSession.title || shortCommand(selectedSession.command)) + '</span>' +
                  '<span class="session-status-pill ' + getSessionStatusClass(selectedSession) + '" title="' + escapeHtml(getSessionStatusLabel(selectedSession)) + '"><span class="session-status-dot"></span><span class="session-status-text">' + escapeHtml(getSessionStatusLabel(selectedSession)) + '</span></span>' +
                  '<span class="current-task hidden" id="current-task"></span>' +
                  (selectedSession.cwd ? renderTailMarqueePath(selectedSession.cwd, "topbar-cwd", ' id="topbar-cwd" role="button" tabindex="0"') : '')
                )
              : '<span class="topbar-tagline">Wand 控制台</span>' +
                '<span class="current-task hidden" id="current-task"></span>'
            ) +
          '</div>' +
          '<div class="topbar-right">' +
            '<button id="topbar-file-button" class="topbar-btn square' + (state.filePanelOpen ? ' active' : '') + '" type="button" aria-label="文件" title="查看文件（可修改路径）"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>' +
            '<span id="topbar-git-slot" class="topbar-git-slot">' + renderTopbarGitBadgeHtml() + '</span>' +
            (selectedSession ? renderTopbarMoreMenuHtml(selectedSession) : '') +
          '</div>' +
        '</div>' +
        // 文件面板（含 backdrop、头部、搜索框）归 React Shell 渲染；
        // 只保留 #file-explorer 槽位锚点，legacy 不再往里写内容。
        '<div class="file-explorer" id="file-explorer"></div>' +
        '<div id="output" class="terminal-container' + (state.selectedId ? "" : " hidden") + ' active">' +
          '<div class="terminal-scale-overlay" aria-label="终端缩放控件">' +
            '<button id="terminal-scale-down-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="缩小">−</button>' +
            '<span class="terminal-scale-overlay-label terminal-scale-label" id="terminal-scale-label-top">' + Math.round(state.terminalScale * 100) + '%</span>' +
            '<button id="terminal-scale-up-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="放大">+</button>' +
            '<span class="terminal-scale-overlay-divider"></span>' +
            '<button id="page-refresh-btn" class="terminal-scale-overlay-btn" type="button" title="刷新页面">' + iconSvg("refresh", { size: 13, strokeWidth: 2 }) + '</button>' +
          '</div>' +
          '<button id="terminal-jump-bottom" class="terminal-jump-bottom' + (state.showTerminalJumpToBottom ? ' visible' : '') + '" type="button" title="回到底部" aria-label="回到底部"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></button>' +
        '</div>' +
        '<div id="chat-output" class="chat-container hidden">' +
          '<div id="chat-fold-bar" class="chat-fold-bar hidden" aria-live="polite"></div>' +
          '<button id="chat-unread-bubble" class="chat-unread-bubble" type="button" title="回到最新消息" aria-label="回到最新消息">' +
            '<span class="chat-unread-bubble-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></span>' +
            '<span class="chat-unread-bubble-count" aria-hidden="true"></span>' +
          '</button>' +
        '</div>' +
        '<div id="blank-chat" class="blank-chat' + (state.selectedId ? " hidden" : "") + '">' +
          '<div class="blank-chat-inner">' +
            '<div class="blank-chat-logo">W</div>' +
            '<h2 class="blank-chat-title">Wand</h2>' +
            '<p class="blank-chat-subtitle">支持终端 PTY 会话与结构化 chat 会话，两种模式可并存。</p>' +
            '<div class="blank-chat-tools">' +
              '<button class="blank-chat-tool-btn" id="welcome-tool-claude" type="button">' +
                '<span class="tool-icon">' + renderProviderLogoMarkup("claude") + '</span>新建终端会话' +
              '</button>' +
              '<button class="blank-chat-tool-btn" id="welcome-tool-codex" type="button">' +
                '<span class="tool-icon">' + renderProviderLogoMarkup("codex") + '</span>新建 Codex 会话' +
              '</button>' +
              '<button class="blank-chat-tool-btn" id="welcome-tool-opencode" type="button">' +
                '<span class="tool-icon">' + renderProviderLogoMarkup("opencode") + '</span>新建 OpenCode 会话' +
              '</button>' +
              '<button class="blank-chat-tool-btn" id="welcome-tool-structured" type="button">' +
                '<span class="tool-icon">' + iconSvg("chat", { size: 16, strokeWidth: 1.8 }) + '</span>新建结构化会话' +
              '</button>' +
            '</div>' +
            '<div class="blank-chat-cwd-wrap">' +
              '<div class="blank-chat-cwd" id="blank-chat-cwd" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false" title="点击切换工作目录">' +
                '<span class="blank-chat-cwd-icon">' + iconSvg("folder", { size: 13, strokeWidth: 1.8 }) + '</span>' +
                renderTailMarqueePath(getEffectiveCwd(), "blank-chat-cwd-path", ' id="blank-chat-cwd-path"') +
                '<span class="blank-chat-cwd-arrow">' + iconSvg("chevronDown", { size: 11, strokeWidth: 2 }) + '</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div id="cross-session-queue-host"></div>' +
        '</div>' +
        '<div class="input-panel' + (state.selectedId ? "" : " hidden") + '">' +
          '<div class="composer-top-row">' +
            '<div id="todo-progress" class="todo-progress hidden">' +
              '<button class="todo-progress-header" id="todo-progress-toggle" type="button" aria-expanded="false" aria-controls="todo-progress-body" aria-label="展开待办列表">' +
                '<div class="todo-progress-fill" id="todo-progress-fill" aria-hidden="true" style="--progress:0"></div>' +
                '<div class="todo-progress-left">' +
                  '<span class="todo-progress-ring" id="todo-progress-ring" aria-hidden="true" style="--progress:0">' +
                    '<svg width="16" height="16" viewBox="0 0 36 36">' +
                      '<circle class="todo-ring-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="4"/>' +
                      '<circle class="todo-ring-fill" cx="18" cy="18" r="15.5" fill="none" stroke-width="4" stroke-linecap="round"/>' +
                    '</svg>' +
                  '</span>' +
                  '<span class="todo-progress-counter" id="todo-progress-counter"></span>' +
                '</div>' +
                // 当前任务描述占满中间剩余空间，过长时单行截断；细进度轨道独立贴底。
                '<div class="todo-progress-task-wrap">' +
                  '<span class="todo-progress-task" id="todo-progress-task"></span>' +
                '</div>' +
                iconSvg("chevronDown", { size: 14, strokeWidth: 2 }) +
              '</button>' +
            '</div>' +
            '<div class="todo-progress-body hidden" id="todo-progress-body">' +
              '<ul class="todo-progress-list" id="todo-progress-list"></ul>' +
            '</div>' +
          '</div>' +
          // 排队气泡宿主：绝对定位浮在 .input-panel 顶边线「上方」、右侧贴边。
          // 垂直排列，一行一个液态玻璃气泡（编号 + 文本 + 立即/删除）。
          // updateQueueBar() 在 queuedMessages 非空时去掉 hidden。
          '<div id="queue-bar-host" class="queue-bar-host" hidden></div>' +
          // 输入主行：正文独占上层书写区域；下层按参考布局分为
          // 「添加 / 权限」与「模型 / 思考 / 发送」两组，键盘顺序与视觉顺序一致。
          '<div class="input-composer-row">' +
          '<div class="input-composer' + (String(currentDraft || "").trim() ? ' has-text' : '') + (state.terminalInteractive ? ' is-terminal-interactive' : '') + '" role="group" aria-label="消息编辑器">' +
            // 附件预览条由 React portal 渲染（见 composer-attachments 组件）。
            '<span class="composer-attachments-host" data-composer-attachments-host="main"></span>' +
            '<div class="composer-main-row">' +
              '<div class="composer-input-wrap">' +
                '<textarea id="input-box" class="input-textarea" aria-label="消息输入" placeholder="' + getComposerPlaceholder(selectedSession, state.terminalInteractive) + '" rows="1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">' + escapeHtml(currentDraft) + '</textarea>' +
              '</div>' +
              '<div class="composer-actions-left" role="group" aria-label="添加内容与权限">' +
                // 加号按钮 —— 点击向上展开 popover：附件 / 终端交互 / 三件套（模式·模型·思考）
                '<button id="attach-btn" class="btn-circle btn-circle-action" type="button" title="更多" aria-label="更多操作" aria-haspopup="dialog" aria-controls="composer-plus-popover" aria-expanded="false">' +
                  iconSvg("plus", { size: 18, strokeWidth: 2.2 }) +
                '</button>' +
                // tabindex="-1": 把 file input 移出 iOS Safari 表单导航链，避免软键盘顶部工具条出现 ⌃ ⌄ ✓。
                '<input type="file" id="file-upload-input" multiple tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0);pointer-events:none">' +
                '<div class="composer-status-row" id="composer-status-row">' +
                  // 三件套 chip 的内容全部由 React portal 渲染（见 composer-config 组件），
                  // 宿主常驻；chip 内还会长出 select 宿主，所以配置同步要先于 select 同步。
                  '<span class="composer-config-host" data-composer-config-host="mode"></span>' +
                  // 徽章内容由 React portal 渲染（见 composer-badges 组件），宿主常驻，
                  // 空状态用宿主上的 `.hidden` 表达。
                  '<span class="composer-badge-host" data-composer-badge-host="auto-approve"></span>' +
                  '<span class="permission-actions hidden" id="permission-actions">' +
                    '<span class="permission-actions-label" id="permission-actions-label" role="status" aria-live="polite" aria-atomic="true">等待授权</span>' +
                    '<button id="approve-permission-btn" class="btn btn-permission btn-permission-approve" type="button">批准</button>' +
                    '<button id="approve-turn-permission-btn" class="btn btn-permission btn-permission-approve hidden" type="button">本轮允许</button>' +
                    '<button id="deny-permission-btn" class="btn btn-permission btn-permission-deny" type="button">拒绝</button>' +
                  '</span>' +
                  '<span class="composer-badge-host" data-composer-badge-host="approval-stats"></span>' +
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
                '<button class="prompt-optimize-btn" id="prompt-optimize-btn" type="button" title="优化提示词" aria-label="优化提示词">' +
                  iconSvg("sparkle", { size: 15, strokeWidth: 1.9, cls: "prompt-optimize-icon" }) +
                  '<span class="prompt-optimize-label">优化</span>' +
                  '<span class="prompt-optimize-spinner" aria-hidden="true"></span>' +
                '</button>' +
                // 停止按钮默认隐藏；updateInteractiveControls() 根据 computeRunningSignal
                // 判断「真有 reply 在跑」时再露出，平时让位给主操作减少视觉噪声。
                '<button id="stop-button" class="btn-circle btn-circle-stop hidden" type="button" title="停止" aria-label="停止生成">' +
                  '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>' +
                '</button>' +
                // 语音按钮位于输入框内部、发送按钮左侧；只在按钮自身处理长按。
                '<button id="voice-record-btn" class="btn-circle btn-circle-action btn-circle-voice" type="button" title="按住语音输入" aria-label="按住语音输入" aria-pressed="false"' + (state.terminalInteractive ? ' disabled' : '') + '>' +
                  iconSvg("mic", { size: 19, strokeWidth: 2 }) +
                '</button>' +
                // 「立即发送」按钮已下线 —— 默认行为永远是排队（气泡），想插队点输入框上方那条气泡。
                '<button id="send-input-button" class="btn-circle btn-circle-send" type="button" title="发送" aria-label="发送消息">' +
                  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>' +
                '</button>' +
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
              '<span class="composer-config-host" data-composer-config-host="all"></span>' +
            '</div>' +
          '</div>' +
          // Skills 弹层由 React portal 渲染（见 composer-skills 组件）：宿主常驻，
          // 关闭时不发布 mount。落点与旧实现 insertAdjacentElement("afterend") 一致。
          '<span class="composer-skills-host" data-composer-skills-host="main"></span>' +
          // 语音实时转写气泡 —— 浮在输入框上方（.input-composer 之外，绕开它的
          // overflow:hidden）。**内容由 React portal 渲染**（见 composer-voice 组件）：
          // 非录音态不发布 mount，整条气泡不渲染，等价于原来的 .hidden。
          '<span class="composer-voice-host" data-composer-voice-host="main"></span>' +
          // 错误条由 React portal 渲染（见 composer-action-error 组件），
          // legacy 通过 state.actionError 表达文案。
          '<span class="composer-action-error-host" data-composer-action-error-host="main"></span>' +
        '</div>' +
      '</main>' +
    '</div>' +
  '</div>';
}
