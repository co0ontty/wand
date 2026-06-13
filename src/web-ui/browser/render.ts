import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { computeRunningSignal, escapeHtml, updateRunningIndicators } from "./utils";
import { getConfigCwd } from "./chat-scroll";
import { renderChatEmptyState, shortCommand } from "./chat-render";
import { attachEventListeners } from "./events";
import { shouldShowSessionsBackdrop, isMobileLayout, refreshFileExplorer, renderFileExplorer, wandFileIcon } from "./file-browser";
import { loadGitStatus, renderTopbarGitBadgeHtml, renderWorktreeMergeModal, renderSettingsModal, renderQuickCommitModal, renderTopbarMoreMenuHtml } from "./git-commit";
import { getSelectedSession, updateInteractiveControls } from "./input";
import { requestNotificationPermission, notifyUpdateAvailable, _apkVersion, _macAppVersion } from "./notifications";
import { applyCurrentView, checkApkAutoUpdate, checkDmgAutoUpdate, closeTransientSessionsDrawer, fetchAvailableModels, getComposerPlaceholder, getComposerTool, getSafeModeForTool, hasNativeBackToApp, hasNativeSwitchServer, loadOutput, loadSessions, login, logout, refreshAll, renderAutoApproveChip, renderChatModeTrioHtml, syncComposerModeSelect, syncComposerModelSelect, syncSessionModalUI, toggleSidebarCollapsed, updateDrawerState, updateShellChrome } from "./session-engine";
import { renderSessionModal, getSessionStatusClass, getSessionStatusLabel } from "./session-ui";
import { renderSessionsListContent, renderSessions, loadClaudeHistory, ensureClaudeHistoryLoaded } from "./sidebar";
import { initTerminal, maybeScrollTerminalToBottom, syncTerminalBuffer } from "./terminal";
import { ensureTerminalFit, ensureTerminalFitWithRetry, setupVisualViewportHandlers, teardownTerminal } from "./viewport";
import { initWebSocket, forceReconnectWebSocket, cancelWsReconnect, evaluateWsHeartbeatStale, startPolling } from "./websocket";

// 这些函数的实际 import 会在其他模块创建后补全
// import { initTerminal, teardownTerminal, ensureTerminalFit, ensureTerminalFitWithRetry, maybeScrollTerminalToBottom } from "./terminal";
// import { attachEventListeners } from "./events";
// import { renderSessionsListContent, renderSessions, loadSessions, getSelectedSession } from "./sessions";
// import { updateDrawerState, closeTransientSessionsDrawer, shouldShowSessionsBackdrop, isMobileLayout } from "./layout";
// import { syncComposerModeSelect, syncComposerModelSelect, getComposerTool, getSafeModeForTool, getComposerPlaceholder, renderChatModeTrioHtml, renderAutoApproveChip } from "./composer";
// import { applyCurrentView, updateShellChrome, syncSessionModalUI } from "./view";
// import { refreshFileExplorer, renderFileExplorer, wandFileIcon } from "./file-explorer";
// import { initWebSocket, forceReconnectWebSocket, cancelWsReconnect, evaluateWsHeartbeatStale } from "./websocket";
// import { startPolling, refreshAll } from "./polling";
// import { fetchAvailableModels } from "./models";
// import { requestNotificationPermission, notifyUpdateAvailable } from "./notification";
// import { checkApkAutoUpdate, checkDmgAutoUpdate } from "./native-update";
// import { loadClaudeHistory, ensureClaudeHistoryLoaded } from "./claude-history";
// import { loadGitStatus, renderTopbarGitBadgeHtml } from "./git";
// import { renderSessionModal, renderWorktreeMergeModal, renderSettingsModal, renderQuickCommitModal } from "./modals";
// import { shortCommand, getSessionStatusClass, getSessionStatusLabel } from "./session-utils";
// import { hasNativeSwitchServer } from "./native";
// import { renderTopbarMoreMenuHtml } from "./topbar";
// import { updateQueueBar } from "./queue";

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

export function scheduleForegroundSync(reason: string, opts?: any) {
  if (!state.config) return;
  if (document.hidden) return;
  var immediate = opts && opts.immediate === true;
  var now = Date.now();
  // 节流只是为了防止 visibilitychange/focus/pageshow 在前台切换时
  // 连珠炮式触发同一份重连工作，不再借此延迟实际同步——之前用
  // 80ms 兜延迟的版本会在前台事件后再去 loadOutput 全量重写
  // terminal，但 wterm cols 那时还没被 ResizeObserver 自适应到，
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
  evaluateWsHeartbeatStale();
  // On Android resume the previous WS may still report OPEN/CONNECTING
  // for a few seconds because the close frame hasn't been delivered
  // yet (TCP keepalive / Doze suspended the network stack). Force a
  // fresh socket so we don't sit on a zombie connection.
  if (force) {
    forceReconnectWebSocket("resume-force");
  } else if (!state.ws || (state.ws.readyState !== WebSocket.OPEN && state.ws.readyState !== WebSocket.CONNECTING)) {
    initWebSocket();
  }
  if (state.claudeHistoryLoaded) {
    loadClaudeHistory();
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
  // 终端 forceReplay 路径也就不跑了。
  //
  // 这里直接听原生层的"键盘动画收尾"事件, 触发 ensureTerminalFit
  // (forceReplay=true), 把 wterm 的网格按真实视口重排一遍。
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
          // render() may fail if external scripts (wterm) failed to load;
          // continue with polling and session loading so the app remains functional
        }
        bindForegroundSyncListeners();
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
        // Warm up history in the background a beat after first paint so
        // the inline 历史会话 count is real (not "···") and recent CLI
        // sessions merge into the list without a manual expand. Deferred
        // to avoid competing with the initial session/output load.
        if (!state.claudeHistoryLoaded) {
          setTimeout(function() {
            if (!state.claudeHistoryLoaded) ensureClaudeHistoryLoaded();
          }, 600);
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
    ".folder-picker-dropdown, .path-suggestions, " +
    ".permission-prompt-overlay, .restart-overlay"
  )) return;
  closeTransientSessionsDrawer();
}, true);

renderBootLoading();
restoreLoginSession();

export function render(options?: any) {
  var skipShellChrome = options && options.skipShellChrome;
  var app = document.getElementById("app");
  var isLoggedIn = state.config !== null;
  var wasModalOpen = state.modalOpen;
  var shouldResetShell = !isLoggedIn || !!document.getElementById("output");

  if (shouldResetShell) {
    teardownTerminal();
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
  app!.innerHTML = isLoggedIn ? renderAppShell() : renderLogin();
  // Reset chat render tracking since DOM was fully replaced
  resetChatRenderCache();
  attachEventListeners();
  updateDrawerState();
  syncComposerModeSelect();
  syncComposerModelSelect(getSelectedSession());
  applyCurrentView();
  if (!skipShellChrome) {
    updateShellChrome();
  }
  if (isLoggedIn && state.filePanelOpen) {
    refreshFileExplorer();
  }

  // Force reflow then re-enable transitions after layout settles
  void document.body.offsetHeight;
  requestAnimationFrame(function() {
    document.documentElement.classList.remove("no-transition");
  });

  // Restore modal state if it was open
  if (wasModalOpen && state.modalOpen) {
    var modal = document.getElementById("session-modal");
    if (modal) {
      modal.classList.remove("hidden");
      var cwdEl = document.getElementById("cwd") as HTMLInputElement | null;
      if (cwdEl) cwdEl.value = state.cwdValue;
      syncSessionModalUI();
    }
  }

  // 初始加载或会话切换后惰性触发 git 状态拉取（loadGitStatus 自带节流）。
  if (isLoggedIn && state.selectedId && state.gitStatusSessionId !== state.selectedId) {
    loadGitStatus(state.selectedId);
  }

  // DOM 整体重渲后，重新挂上"运行中"指示器（顶部进度条/徽章计时/气泡呼吸条）
  if (isLoggedIn) {
    var __sel = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
    updateRunningIndicators(__sel);
  }
}

export function renderApprovalStatsBadge() {
  var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  var stats = selectedSession && selectedSession.approvalStats;
  if (!stats || stats.total === 0) return '<span class="approval-stats hidden" id="approval-stats"></span>';
  return '<span class="approval-stats" id="approval-stats">' +
    '<span class="approval-stats-divider"></span>' +
    '<span class="approval-stats-badge" id="approval-stats-badge" title="本次会话自动批准统计">' +
      '<svg class="approval-stats-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
      '<span class="approval-stats-total">' + stats.total + '</span>' +
    '</span>' +
    '<span class="approval-stats-popup" id="approval-stats-popup">' +
      '<span class="approval-stats-popup-title">自动批准统计</span>' +
      (stats.command > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("terminal", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">命令执行</span><span class="approval-stats-row-count">' + stats.command + '</span></span>' : '') +
      (stats.file > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("edit", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">文件写入</span><span class="approval-stats-row-count">' + stats.file + '</span></span>' : '') +
      (stats.tool > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("wrench", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">其他工具</span><span class="approval-stats-row-count">' + stats.tool + '</span></span>' : '') +
      '<span class="approval-stats-row approval-stats-row-total"><span class="approval-stats-row-icon">' + iconSvg("sigma", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">合计</span><span class="approval-stats-row-count">' + stats.total + '</span></span>' +
    '</span>' +
  '</span>';
}

export function renderLogin() {
  if (!state.loginChecked) {
    return '<div class="login-container">' +
      '<div class="login-card login-card-loading">' +
        '<div class="login-header">' +
          '<div class="login-logo">' +
            '<div class="login-logo-icon">W</div>' +
            '<span class="login-logo-text">Wand</span>' +
          '</div>' +
          '<div class="login-subtitle">正在恢复登录状态</div>' +
        '</div>' +
        '<div class="login-body">' +
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
  return '<div class="login-container">' +
    '<div class="login-card">' +
      '<div class="login-header">' +
        '<div class="login-logo">' +
          '<div class="login-logo-icon">W</div>' +
          '<span class="login-logo-text">Wand</span>' +
        '</div>' +
        '<div class="login-subtitle">在浏览器中运行本机终端</div>' +
      '</div>' +
      '<form id="login-form" class="login-body" autocomplete="on">' +
        '<input type="text" name="username" autocomplete="username" value="wand" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none" readonly />' +
        '<p class="login-hint">输入 Wand 访问密码以进入控制台。</p>' +
        '<div class="field">' +
          '<label class="field-label" for="password">密码</label>' +
          '<div class="password-field">' +
            '<input id="password" type="password" class="field-input password-input" placeholder="输入访问密码" autocomplete="current-password" data-error="false" aria-describedby="password-hint login-error" aria-invalid="false" />' +
            '<button id="toggle-password-button" type="button" class="password-toggle" aria-label="显示密码" aria-pressed="false">显示</button>' +
          '</div>' +
          '<p id="password-hint" class="hint">使用你在 Wand 中设置的访问密码。</p>' +
          '<p id="login-error" class="error-message hidden" role="alert"></p>' +
        '</div>' +
        '<button id="login-button" type="submit" class="btn btn-primary btn-block">进入控制台</button>' +
        (hasNativeSwitchServer() ?
          '<button id="login-switch-server-button" class="btn btn-ghost btn-block login-switch-server" type="button">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg>' +
            '<span>切换服务器</span>' +
          '</button>'
          : ''
        ) +
      '</form>' +
    '</div>' +
  '</div>';
}

export function renderAppShell() {
  var scriptClose = String.fromCharCode(60) + String.fromCharCode(47) + "script>";
  var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
  var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "未选择会话";
  var terminalInfo = selectedSession ? (selectedSession.mode + " | " + selectedSession.status) : "点击上方「新对话」开始";
  var currentDraft = state.selectedId ? (state.drafts[state.selectedId] || "") : "";
  var drawerClass = state.sessionsDrawerOpen ? " open" : "";
  var backdropClass = shouldShowSessionsBackdrop() ? " open" : "";
  var preferredTool = getComposerTool();
  var composerMode = getSafeModeForTool(preferredTool, state.chatMode);

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
            '<span class="session-count" id="session-count">' + String(state.sessions.length) + '</span>' +
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
            '<div class="sessions-list" id="sessions-list">' + renderSessionsListContent() + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="sidebar-footer">' +
          '<button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> 新会话</button>' +
          '<div class="sidebar-footer-actions">' +
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
                  '<span class="topbar-session-title" title="' + escapeHtml(selectedSession.description || selectedSession.command || "") + '">' + escapeHtml(selectedSession.title || shortCommand(selectedSession.command)) + '</span>' +
                  '<span class="session-status-pill ' + getSessionStatusClass(selectedSession) + '" title="' + escapeHtml(getSessionStatusLabel(selectedSession)) + '"><span class="session-status-dot"></span><span class="session-status-text">' + escapeHtml(getSessionStatusLabel(selectedSession)) + '</span></span>' +
                  '<span class="current-task hidden" id="current-task"></span>' +
                  (selectedSession.cwd ? '<span class="topbar-cwd" id="topbar-cwd" title="' + escapeHtml(selectedSession.cwd) + '" role="button" tabindex="0">' + escapeHtml(selectedSession.cwd) + '</span>' : '')
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
        // File panel backdrop (mobile)
        '<div id="file-panel-backdrop" class="file-panel-backdrop' + (state.filePanelOpen ? " open" : "") + '"></div>' +
        // File side panel
        '<div id="file-side-panel" class="file-side-panel' + (state.filePanelOpen ? " open" : "") + '">' +
          '<div class="file-side-panel-header">' +
            '<div class="file-side-panel-title-group">' +
              '<span class="file-side-panel-icon">' + wandFileIcon("folder-open", { size: 16 }) + '</span>' +
              '<span class="file-side-panel-title">文件</span>' +
            '</div>' +
            '<div class="file-side-panel-header-actions">' +
              '<button class="file-side-panel-iconbtn" id="file-explorer-refresh" type="button" title="刷新" aria-label="刷新文件列表">' +
                wandFileIcon("refresh", { size: 15 }) +
              '</button>' +
              '<button id="file-side-panel-close" class="file-side-panel-iconbtn close" type="button" aria-label="关闭文件面板" title="关闭">' +
                wandFileIcon("x", { size: 16 }) +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="file-side-panel-body">' +
            '<div class="file-explorer-header">' +
              '<button class="file-explorer-up" id="file-explorer-up" type="button" title="返回上级目录" aria-label="返回上级目录">' +
                wandFileIcon("arrow-up", { size: 15 }) +
              '</button>' +
              '<input type="text" class="file-explorer-path" id="file-explorer-cwd" value="' + escapeHtml(selectedSession && selectedSession.cwd ? selectedSession.cwd : getConfigCwd()) + '" title="' + escapeHtml(selectedSession && selectedSession.cwd ? selectedSession.cwd : getConfigCwd()) + '" placeholder="输入路径并回车..." spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="当前路径，可直接修改后回车" />' +
            '</div>' +
            '<div class="file-search-box">' +
              '<span class="file-search-icon">' + wandFileIcon("search", { size: 14 }) + '</span>' +
              '<input type="text" id="file-search-input" class="file-search-input" placeholder="搜索当前目录…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />' +
              '<button class="file-search-clear" id="file-search-clear" type="button" aria-label="清除搜索" title="清除">' +
                wandFileIcon("x", { size: 13 }) +
              '</button>' +
            '</div>' +
            '<div class="file-explorer" id="file-explorer">' + renderFileExplorer(selectedSession && selectedSession.cwd ? selectedSession.cwd : getConfigCwd()) + '</div>' +
          '</div>' +
        '</div>' +
        '<div id="output" class="terminal-container' + (state.selectedId ? "" : " hidden") + ' active">' +
          '<div class="terminal-scale-overlay" aria-label="终端缩放控件">' +
            '<button id="terminal-scale-down-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="缩小">−</button>' +
            '<span class="terminal-scale-overlay-label terminal-scale-label" id="terminal-scale-label-top">' + Math.round(state.terminalScale * 100) + '%</span>' +
            '<button id="terminal-scale-up-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="放大">+</button>' +
            '<span class="terminal-scale-overlay-divider"></span>' +
            '<button id="page-refresh-btn" class="terminal-scale-overlay-btn" type="button" title="刷新页面">↻</button>' +
          '</div>' +
          '<button id="terminal-jump-bottom" class="terminal-jump-bottom' + (state.showTerminalJumpToBottom ? ' visible' : '') + '" type="button" title="回到底部" aria-label="回到底部"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></button>' +
        '</div>' +
        '<div id="chat-output" class="chat-container hidden">' +
          '<button id="chat-unread-bubble" class="chat-unread-bubble" type="button" title="回到最新消息" aria-label="回到最新消息">' +
            '<span class="chat-unread-bubble-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></span>' +
            '<span class="chat-unread-bubble-count" aria-hidden="true"></span>' +
          '</button>' +
          // 排队气泡宿主：贴在对话显示区域的右下角（在"回复中"状态线上方），
          // 不进输入框 panel。updateQueueBar() 仅在 queuedMessages 非空时显形。
          '<div id="queue-bar-host" class="queue-bar-host" hidden></div>' +
        '</div>' +
        '<div id="blank-chat" class="blank-chat' + (state.selectedId ? " hidden" : "") + '">' +
          '<div class="blank-chat-inner">' +
            '<div class="blank-chat-logo">W</div>' +
            '<h2 class="blank-chat-title">Wand</h2>' +
            '<p class="blank-chat-subtitle">支持终端 PTY 会话与结构化 chat 会话，两种模式可并存。</p>' +
            '<div class="blank-chat-tools">' +
              '<button class="blank-chat-tool-btn" id="welcome-tool-claude" type="button">' +
                '<span class="tool-icon">' + iconSvg("terminal", { size: 16, strokeWidth: 1.8 }) + '</span>新建终端会话' +
              '</button>' +
              '<button class="blank-chat-tool-btn" id="welcome-tool-codex" type="button">' +
                '<span class="tool-icon tool-icon-text">⌘</span>新建 Codex 会话' +
              '</button>' +
              '<button class="blank-chat-tool-btn" id="welcome-tool-structured" type="button">' +
                '<span class="tool-icon">' + iconSvg("chat", { size: 16, strokeWidth: 1.8 }) + '</span>新建结构化会话' +
              '</button>' +
            '</div>' +
            '<div class="blank-chat-cwd-wrap">' +
              '<div class="blank-chat-cwd" id="blank-chat-cwd" role="button" tabindex="0" title="点击切换工作目录">' +
                '<span class="blank-chat-cwd-icon">' + iconSvg("folder", { size: 13, strokeWidth: 1.8 }) + '</span>' +
                '<span class="blank-chat-cwd-path" id="blank-chat-cwd-path">' + escapeHtml(getEffectiveCwd()) + '</span>' +
                '<span class="blank-chat-cwd-arrow" id="blank-chat-cwd-arrow">' + iconSvg("chevronDown", { size: 11, strokeWidth: 2 }) + '</span>' +
              '</div>' +
              '<div class="blank-chat-cwd-dropdown hidden" id="blank-chat-cwd-dropdown"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="input-panel' + (state.selectedId ? "" : " hidden") + '">' +
          // #queue-bar-host 已搬到 #chat-output 内部（对话区右下角），不在这里了。
          '<div class="composer-top-row">' +
            '<div id="todo-progress" class="todo-progress hidden">' +
              '<div class="todo-progress-header" id="todo-progress-toggle">' +
                '<div class="todo-progress-left">' +
                  '<span class="todo-progress-ring" id="todo-progress-ring" aria-hidden="true" style="--progress:0">' +
                    '<svg width="16" height="16" viewBox="0 0 36 36">' +
                      '<circle class="todo-ring-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="4"/>' +
                      '<circle class="todo-ring-fill" cx="18" cy="18" r="15.5" fill="none" stroke-width="4" stroke-linecap="round"/>' +
                    '</svg>' +
                  '</span>' +
                  '<span class="todo-progress-counter" id="todo-progress-counter"></span>' +
                  '<span class="todo-progress-task" id="todo-progress-task"></span>' +
                '</div>' +
                '<svg class="todo-progress-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg>' +
              '</div>' +
            '</div>' +
            '<div class="todo-progress-body hidden" id="todo-progress-body">' +
              '<ul class="todo-progress-list" id="todo-progress-list"></ul>' +
            '</div>' +
          '</div>' +
          // v2 单行布局：
          //   ┌─────────────────────────────────────────────────────────────────────┐
          //   │ [+] [🎤] [⌨]  ────textarea（空时浮 mode·model·thinking 鬼影）──── [⏹] [➤] │
          //   └─────────────────────────────────────────────────────────────────────┘
          // 关键点：
          //  · 三件套（mode / model / thinking）从 bar 搬到 textarea 上方的 ghost layer，
          //    空输入时浮在 placeholder 位上显示；用户开始输入即淡出隐藏。
          //  · 附件改成 + 图标；新增麦克风按钮，整体输入框可切到「按住说话」语音模式。
          //  · 提示词优化按钮（✨）改成只在 textarea 有内容时显示，绝对定位浮在右侧。
          //  · 自动批准 / 权限操作行统一搬到 textarea 上方的状态行，
          //    输入主行保持极简。
          '<div class="input-composer' + (currentDraft ? ' has-text' : '') + '">' +
            // 顶部状态行：自动批准 / 权限审批 / 统计 —— 仅在有内容时占位，
            // 否则折叠成 0 高度。避免与下方"主输入行"挤在一行。
            '<div class="composer-status-row" id="composer-status-row">' +
              renderAutoApproveChip(selectedSession) +
              '<span class="permission-actions hidden" id="permission-actions">' +
                '<span class="permission-actions-label" id="permission-actions-label">等待授权</span>' +
                '<button id="approve-permission-btn" class="btn btn-permission btn-permission-approve" type="button">批准</button>' +
                '<button id="deny-permission-btn" class="btn btn-permission btn-permission-deny" type="button">拒绝</button>' +
              '</span>' +
              renderApprovalStatsBadge() +
            '</div>' +
            // 主输入行（单行）：左动作 / 输入区 / 右动作
            '<div class="composer-main-row">' +
              '<div class="composer-actions-left">' +
                // 加号按钮 —— 点击向上展开 popover：附件 / 终端交互 / 三件套（模式·模型·思考）
                '<button id="attach-btn" class="btn-circle btn-circle-action" type="button" title="更多" aria-label="更多" aria-haspopup="menu" aria-expanded="false">' +
                  iconSvg("plus", { size: 18, strokeWidth: 2.2 }) +
                '</button>' +
                // tabindex="-1": 把 file input 移出 iOS Safari 表单导航链，避免软键盘顶部工具条出现 ⌃ ⌄ ✓。
                '<input type="file" id="file-upload-input" multiple tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0);pointer-events:none">' +
                // 语音按钮已暂时隐藏（按住说话交互保留，等接 STT 后再放出）；终端交互按钮搬进了 popover。
              '</div>' +
              '<div class="composer-input-wrap">' +
                '<textarea id="input-box" class="input-textarea" placeholder="' + getComposerPlaceholder(selectedSession, state.terminalInteractive) + '" rows="1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">' + escapeHtml(currentDraft) + '</textarea>' +
                // 提示词优化按钮 —— 浮在输入区右侧（在 send 按钮的「左边」，不再撞车）。
                // 默认隐藏，CSS 只在 .input-composer.has-text 时显示。
                '<button id="prompt-optimize-btn" class="prompt-optimize-btn" type="button" title="提示词优化（AI）" aria-label="提示词优化">' +
                  '<svg class="prompt-optimize-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" fill="currentColor" opacity="0.25"/>' +
                    '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>' +
                    '<path d="M19 14l.7 1.9L21.6 17l-1.9.7L19 19.6l-.7-1.9L16.4 17l1.9-.7z" fill="currentColor" opacity="0.35"/>' +
                    '<path d="M5 4l.5 1.4L7 6l-1.5.6L5 8l-.5-1.4L3 6l1.5-.6z" fill="currentColor" opacity="0.35"/>' +
                  '</svg>' +
                  '<span class="prompt-optimize-spinner" aria-hidden="true"></span>' +
                '</button>' +
                // 三件套（mode/model/thinking）的入口已从输入框搬走（避免与 placeholder 视觉重合）：
                //   · 结构化会话空状态 → renderChatEmptyState 那条提示下方的下拉
                //   · 结构化会话进行中 → 每条用户消息头像左侧的徽章按钮
                // PTY 模式整体不展示。
                // 语音模式 UI（v1 仅 UI scaffolding；MediaRecorder 接入留待后续）
                '<div class="voice-input-mode hidden" id="voice-input-mode">' +
                  '<button id="voice-record-btn" class="voice-record-btn" type="button">' +
                    '<span class="voice-record-pulse" aria-hidden="true"></span>' +
                    '<span class="voice-record-label">按住 说话</span>' +
                  '</button>' +
                  '<button id="voice-cancel-btn" class="voice-cancel-btn" type="button" title="退出语音模式" aria-label="退出语音模式">' +
                    iconSvg("x", { size: 14, strokeWidth: 2 }) +
                  '</button>' +
                '</div>' +
              '</div>' +
              '<div class="composer-actions-right">' +
                // 停止按钮默认隐藏；updateInteractiveControls() 根据 computeRunningSignal
                // 判断「真有 reply 在跑」时再露出，平时让位给主操作减少视觉噪声。
                '<button id="stop-button" class="btn-circle btn-circle-stop hidden" title="停止">' +
                  '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>' +
                '</button>' +
                // 「立即发送」按钮已下线 —— 默认行为永远是排队（气泡），想插队点输入框上方那条气泡。
                '<button id="send-input-button" class="btn-circle btn-circle-send" title="发送">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div id="attachment-preview" class="attachment-preview hidden"></div>' +
          '</div>' +
          // 加号气泡 —— 浮在 + 按钮上方（.input-composer 之外，绕开它的 overflow:hidden）。
          // 内容：附件 / 终端交互 / 三件套（模式·模型·思考）。默认 hidden，点 + 切换；
          // 点 popover 外部 / Esc / 选完任一项后自动关闭。
          '<div class="composer-plus-popover hidden" id="composer-plus-popover" role="menu" aria-label="更多操作">' +
            '<button class="plus-popover-item" id="plus-attach-item" type="button" role="menuitem">' +
              iconSvg("paperclip", { size: 14, strokeWidth: 1.8, cls: "plus-popover-icon" }) +
              '<span class="plus-popover-label">上传附件</span>' +
            '</button>' +
            '<button class="plus-popover-item' + (state.terminalInteractive ? " is-on" : "") + '" id="terminal-interactive-toggle-top" type="button" role="menuitemcheckbox" aria-checked="' + (state.terminalInteractive ? "true" : "false") + '">' +
              iconSvg("keyboard", { size: 14, strokeWidth: 1.8, cls: "plus-popover-icon" }) +
              '<span class="plus-popover-label">终端交互</span>' +
              '<span class="plus-popover-toggle-state">' + (state.terminalInteractive ? "开" : "关") + '</span>' +
            '</button>' +
            // 三件套：复用 renderChatModeTrioHtml 的 select 委托链，
            // 用 kind:"popover" 由 CSS 切到纵向列表。对所有会话都展示——
            // PTY 会话当前进程的 mode/model/thinking 改不了，但 state 变更会
            // 影响"新建会话"的默认值，所以露出来仍有意义；省去的话用户会困惑
            // "为什么我点开加号没看到这三个开关"。
            '<div class="plus-popover-sep" aria-hidden="true"></div>' +
            '<div class="plus-popover-trio-wrap">' +
              renderChatModeTrioHtml(selectedSession, { kind: "popover" }) +
            '</div>' +
          '</div>' +
          // 语音实时转写气泡 —— 浮在输入框上方（.input-composer 之外，绕开它的 overflow:hidden）。
          // 按住录音时显示，逐字展示识别文字；松手填回输入框。默认 hidden。
          '<div class="voice-transcript-bubble hidden" id="voice-transcript-bubble" aria-live="polite">' +
            '<div class="voice-transcript-text" id="voice-transcript-text"></div>' +
            '<div class="voice-transcript-hint" id="voice-transcript-hint">' +
              '<span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
              '<span class="voice-transcript-status" id="voice-transcript-status">正在聆听…上滑取消</span>' +
            '</div>' +
            '<span class="voice-bubble-arrow" aria-hidden="true"></span>' +
          '</div>' +
          '<p id="action-error" class="error-message hidden"></p>' +
        '</div>' +
        // Folder picker modal (hidden by default)
        '<section id="folder-picker-modal" class="modal-backdrop hidden">' +
          '<div class="modal folder-picker-modal">' +
            '<div class="modal-header">' +
              '<h2 class="modal-title">选择工作目录</h2>' +
              '<button id="close-folder-picker" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="folder-picker-quick-row">' +
                '<button class="folder-picker-quick-btn btn-with-icon" data-path="/tmp">' + iconSvg("trash", { size: 13, strokeWidth: 1.7 }) + '<span>临时目录</span></button>' +
                '<button class="folder-picker-quick-btn btn-with-icon" data-path="/">' + iconSvg("folder", { size: 13, strokeWidth: 1.7 }) + '<span>根目录</span></button>' +
              '</div>' +
              '<div id="folder-breadcrumb" class="folder-breadcrumb"></div>' +
              '<div class="folder-picker">' +
                '<span class="folder-picker-icon">' + iconSvg("folder", { size: 15, strokeWidth: 1.7 }) + '</span>' +
                '<input type="text" id="folder-picker-input" class="folder-picker-input" value="" placeholder="输入或选择工作目录..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />' +
              '</div>' +
              '<div id="folder-picker-dropdown" class="folder-picker-dropdown hidden"></div>' +
              '<div id="folder-picker-validation" class="folder-picker-validation"></div>' +
            '</div>' +
          '</div>' +
        '</section>' +
      '</main>' +
    '</div>' +
  '</div>' + renderSessionModal() + renderWorktreeMergeModal() + renderSettingsModal() + renderQuickCommitModal();
}
