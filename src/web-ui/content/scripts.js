    // Register Service Worker for PWA
    // For self-signed certificates, we need to handle certificate errors gracefully
    if ('serviceWorker' in navigator) {
      // First, try to fetch the service worker script with a custom handler for certificate errors
      fetch('/sw.js', { cache: 'no-cache' })
        .then(function(response) {
          if (response.ok) {
            return navigator.serviceWorker.register('/sw.js');
          }
          // If fetch fails (e.g., certificate error), skip service worker registration
          console.log('SW fetch failed, skipping service worker registration');
          return Promise.reject('Service worker script not available');
        })
        .catch(function(e) {
          // Distinguish between certificate errors and other failures
          if (e.name === 'TypeError' || e.message.includes('certificate')) {
            console.log('SW registration skipped: likely self-signed certificate issue');
          } else {
            console.log('SW registration failed:', e.message || e);
          }
        });

      // Auto-reload when a new service worker takes control (e.g. after update)
      // But skip reload during initial page load to avoid breaking initialization
      var reloading = false;
      var pageReady = false;
      setTimeout(function() { pageReady = true; }, 3000);
      navigator.serviceWorker.addEventListener('controllerchange', function() {
        if (reloading || !pageReady) return;
        reloading = true;
        location.reload();
      });
    }

    // PWA display mode detection
    (function() {
      function detectDisplayMode() {
        var mode = 'browser';
        if (window.matchMedia('(display-mode: window-controls-overlay)').matches) {
          mode = 'window-controls-overlay';
        } else if (window.matchMedia('(display-mode: standalone)').matches) {
          mode = 'standalone';
        } else if (window.matchMedia('(display-mode: fullscreen)').matches) {
          mode = 'fullscreen';
        } else if (navigator.standalone === true) {
          mode = 'standalone'; // iOS Safari
        }
        document.documentElement.setAttribute('data-display-mode', mode);
        document.documentElement.classList.toggle('is-pwa', mode !== 'browser');
        return mode;
      }
      detectDisplayMode();
      // Re-detect when display mode changes (e.g., user toggles WCO)
      ['standalone', 'window-controls-overlay', 'fullscreen'].forEach(function(m) {
        window.matchMedia('(display-mode: ' + m + ')').addEventListener('change', detectDisplayMode);
      });
    })();

    (function() {
      var configPath = "${escapeHtml(configPath)}";

      var state = {
        selectedId: (function() {
          try { return localStorage.getItem("wand-selected-session") || null; } catch (e) { return null; }
        })(),
        pollTimer: null,
        config: null,
        sessions: [],
        suggestionTimer: null,
        terminal: null,
        fitAddon: null,
        serializeAddon: null,
        terminalDomView: null,
        terminalDomUpdateTimer: null,
        _lastDomHtml: "",
        terminalSessionId: null,
        terminalOutput: "",
        terminalViewportSize: { width: 0, height: 0 },
        terminalAutoFollow: true,
        terminalScrollIdleTimer: null,
        terminalScrollIdleMs: 1800,
        terminalScrollThreshold: 12,
        showTerminalJumpToBottom: false,
        terminalViewportEl: null,
        terminalViewportScrollHandler: null,
        terminalViewportTouchHandler: null,
        resizeObserver: null,
        resizeHandler: null,
        resizeTimer: null,
        inputQueue: Promise.resolve(),
        pendingMessages: [], // WebSocket 断线期间的消息队列
        messageQueue: [], // 用户消息排队等待发送
        drafts: {},
        isSyncingInputBox: false,
        loginPending: false,
        loginChecked: false,
        sessionsDrawerOpen: false,
        modalOpen: false,
        presetValue: "",
        cwdValue: "",
        modeValue: "managed",
        chatMode: "managed",
        sessionTool: "claude",
        preferredCommand: "claude",
        lastResize: { cols: 0, rows: 0 },
        isOnline: navigator.onLine,
        deferredPrompt: null,
        showInstallPrompt: false,
        ws: null,
        wsConnected: false,
        currentView: "terminal",
        terminalScale: (function() {
          try {
            var saved = localStorage.getItem("wand-terminal-scale");
            return saved ? parseFloat(saved) : 1;
          } catch (e) {
            return 1;
          }
        })(),
        terminalBaseFontSize: 13,
        keyboardPopupOpen: false,
        filePanelOpen: (function() {
          try {
            return localStorage.getItem("wand-file-panel-open") === "true";
          } catch (e) {
            return false;
          }
        })(),
        currentMessages: [],
        lastRenderedHash: 0,
        lastRenderedMsgCount: 0,
        lastRenderedEmpty: null,
        renderPending: false,
        currentTask: null, // Current task title from Claude
        terminalInteractive: false,
        miniKeyboardVisible: false,
        shortcutsExpanded: false,
        modifiers: { ctrl: false, alt: false, shift: false },
        fileSearchQuery: "",
        allFiles: [],
        claudeHistory: [],
        claudeHistoryLoaded: false,
        claudeHistoryExpanded: true,
        claudeHistoryExpandedDirs: {},
        sessionsManageMode: false,
        selectedSessionIds: {},
        selectedClaudeHistoryIds: {},
        // Load last used working directory from localStorage
        workingDir: (function() {
          try {
            var saved = localStorage.getItem("wand-working-dir");
            return saved || "";
          } catch (e) {
            return "";
          }
        })()
      };

      // Helper function to persist selected session ID to localStorage
      function persistSelectedId() {
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

      function getConfigCwd() {
        return (state.config && state.config.defaultCwd) || "/tmp";
      }

      function getEffectiveCwd() {
        return state.workingDir || getConfigCwd();
      }

      // PWA install prompt handling
      window.addEventListener('beforeinstallprompt', function(e) {
        e.preventDefault();
        state.deferredPrompt = e;
        state.showInstallPrompt = true;
        updateInstallPrompt();
      });

      window.addEventListener('online', function() {
        state.isOnline = true;
        updateOfflineBanner();
      });

      window.addEventListener('offline', function() {
        state.isOnline = false;
        updateOfflineBanner();
      });

      function updateOfflineBanner() {
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

      function updateInstallPrompt() {
        // 显示或隐藏菜单栏中的安装按钮
        var installBtn = document.getElementById('pwa-install-button');
        if (installBtn) {
          if (state.showInstallPrompt && state.deferredPrompt) {
            installBtn.classList.remove('hidden');
          } else {
            installBtn.classList.add('hidden');
          }
        }
      }

      renderBootLoading();
      restoreLoginSession();

      function renderBootLoading() {
        var app = document.getElementById("app");
        if (!app) return;
        app.innerHTML =
          '<div class="boot-loading">' +
            '<div class="boot-loading-card">' +
              '<div class="boot-loading-spinner"></div>' +
              '<div class="boot-loading-text">正在恢复会话…</div>' +
            '</div>' +
          '</div>';
      }

      function restoreLoginSession() {
        fetch("/api/config", { credentials: "same-origin" })
          .then(function(res) {
            if (!res.ok) {
              state.loginChecked = true;
              render();
              return null;
            }
            return res.json();
          })
          .then(function(config) {
            if (!config) return;
            state.config = config;
            state.loginChecked = true;
            requestAnimationFrame(function() {
              // Render the app shell first, THEN load session data into it.
              // Skip updateShellChrome() here — sessions aren't loaded yet.
              // refreshAll() will call updateShellChrome() after sessions arrive.
              try {
                render({ skipShellChrome: true });
              } catch (_e) {
                // render() may fail if external scripts (xterm.js) failed to load;
                // continue with polling and session loading so the app remains functional
              }
              startPolling();
              refreshAll();
              // Request browser notification permission after login
              requestNotificationPermission();
              // Show update bubble if server reports an available update
              if (config.updateAvailable && config.latestVersion) {
                showNotificationBubble({
                  title: "\u53d1\u73b0\u65b0\u7248\u672c",
                  body: "\u5f53\u524d " + (config.currentVersion || "-") + " \u2192 \u6700\u65b0 " + config.latestVersion,
                  type: "info",
                  icon: "\u2191",
                  duration: 0,
                  actionLabel: "\u53bb\u66f4\u65b0",
                  action: function() {
                    var settingsBtn = document.getElementById("open-settings-btn") || document.querySelector("[data-action='settings']");
                    if (settingsBtn) settingsBtn.click();
                  }
                });
                sendBrowserNotification("Wand \u53d1\u73b0\u65b0\u7248\u672c", "\u5f53\u524d " + (config.currentVersion || "-") + " \u2192 \u6700\u65b0 " + config.latestVersion, { tag: "wand-update" });
              }
              // Auto-load claude history since section defaults to expanded
              if (state.claudeHistoryExpanded && !state.claudeHistoryLoaded) {
                loadClaudeHistory();
              }
            });
          })
          .catch(function() {
            state.loginChecked = true;
            // If offline (no network), show a friendly offline message instead of login
            if (!navigator.onLine) {
              var app = document.getElementById("app");
              if (app) {
                app.innerHTML =
                  '<div class="boot-loading">' +
                    '<div class="boot-loading-card">' +
                      '<div class="boot-loading-text" style="font-size:1.3em;margin-bottom:12px">📡 无法连接到服务器</div>' +
                      '<div class="boot-loading-text" style="opacity:0.7;font-size:0.95em">请检查网络连接或确认 Wand 服务正在运行。</div>' +
                      '<button onclick="location.reload()" style="margin-top:18px;padding:8px 24px;border-radius:8px;border:1px solid rgba(150,118,85,0.3);background:rgba(255,255,255,0.8);cursor:pointer;font-size:0.95em">重试</button>' +
                    '</div>' +
                  '</div>';
              }
              // Retry when network comes back
              window.addEventListener('online', function() { location.reload(); }, { once: true });
              return;
            }
            render();
          });
      }

      function render(options) {
        var skipShellChrome = options && options.skipShellChrome;
        var app = document.getElementById("app");
        var isLoggedIn = state.config !== null;
        var wasModalOpen = state.modalOpen;
        var shouldResetShell = !isLoggedIn || !document.getElementById("output");

        if (shouldResetShell) {
          teardownTerminal();
        }

        // Suppress CSS transitions during initial DOM build
        document.documentElement.classList.add("no-transition");

        app.innerHTML = isLoggedIn ? renderAppShell() : renderLogin();
        // Reset chat render tracking since DOM was fully replaced
        state.lastRenderedHash = 0;
        state.lastRenderedMsgCount = 0;
        state.lastRenderedEmpty = null;
        attachEventListeners();
        updateDrawerState();
        syncComposerModeSelect();
        applyCurrentView();
        if (!skipShellChrome) {
          updateShellChrome();
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
            var cwdEl = document.getElementById("cwd");
            if (cwdEl) cwdEl.value = state.cwdValue;
            syncSessionModalUI();
          }
        }
      }

      function renderShortcutKeys() {
        return '<button class="shortcut-key' + (state.modifiers.ctrl ? ' active' : '') + '" data-key="ctrl" type="button">Ctrl</button>' +
          '<button class="shortcut-key' + (state.modifiers.alt ? ' active' : '') + '" data-key="alt" type="button">Alt</button>' +
          '<span class="shortcut-sep">·</span>' +
          '<button class="shortcut-key shortcut-dir" data-key="up" type="button">↑</button>' +
          '<button class="shortcut-key shortcut-dir" data-key="down" type="button">↓</button>' +
          '<button class="shortcut-key shortcut-dir" data-key="left" type="button">←</button>' +
          '<button class="shortcut-key shortcut-dir" data-key="right" type="button">→</button>' +
          '<span class="shortcut-sep">·</span>' +
          '<button class="shortcut-key" data-key="enter" type="button">↵</button>' +
          '<button class="shortcut-key" data-key="ctrl_enter" type="button">C-↵</button>' +
          '<button class="shortcut-key" data-key="escape" type="button">Esc</button>';
      }

      function renderInlineKeyboard() {
        if (!state.selectedId) return "";
        var isTerminal = state.currentView === "terminal";
        if (!isTerminal) return "";
        var keys = renderShortcutKeys();
        var arrow = state.shortcutsExpanded ? '›' : '‹';
        return '<div class="inline-shortcuts-wrap' + (state.shortcutsExpanded ? ' expanded' : '') + '">' +
            '<button class="shortcuts-toggle' + (state.shortcutsExpanded ? ' active' : '') + '" type="button" title="快捷键">' + arrow + '</button>' +
            '<div class="inline-shortcuts-strip">' + keys + '</div>' +
            '<div class="inline-shortcuts-inline">' + keys + '</div>' +
          '</div>';
      }

      function renderExpandedShortcutsRow() {
        if (!state.selectedId) return "";
        var isTerminal = state.currentView === "terminal";
        if (!isTerminal) return "";
        return '<div class="inline-shortcuts-expanded-row' + (state.shortcutsExpanded ? ' visible' : '') + '">' + renderShortcutKeys() + '</div>';
      }

      function renderLogin() {
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
            '<div class="login-body">' +
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
              '<button id="login-button" class="btn btn-primary btn-block">进入控制台</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }

      function renderAppShell() {
        var scriptClose = String.fromCharCode(60) + String.fromCharCode(47) + "script>";
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "未选择会话";
        var terminalInfo = selectedSession ? (selectedSession.mode + " | " + selectedSession.status) : "点击上方「新对话」开始";
        var currentDraft = state.selectedId ? (state.drafts[state.selectedId] || "") : "";
        var drawerClass = state.sessionsDrawerOpen ? " open" : "";
        var preferredTool = getComposerTool();
        var composerMode = getSafeModeForTool(preferredTool, state.chatMode);

        return '<div class="app-container">' +
          '<button id="sessions-toggle-button" class="floating-sidebar-toggle' + (state.sessionsDrawerOpen ? ' active' : '') + '" aria-label="Toggle sidebar">' +
            '<span class="hamburger-icon">' +
              '<span></span><span></span><span></span>' +
            '</span>' +
          '</button>' +
          '<div id="sessions-drawer-backdrop" class="drawer-backdrop' + drawerClass + '"></div>' +
          '<div class="main-layout' + (state.sessionsDrawerOpen ? ' sidebar-open' : '') + '">' +
            '<aside id="sessions-drawer" class="sidebar' + drawerClass + '">' +
              '<div class="sidebar-header">' +
                '<div class="sidebar-header-main">' +
                  '<div class="topbar-logo-icon">W</div>' +
                  '<span class="sidebar-title">会话</span>' +
                  '<span class="session-count" id="session-count">' + String(state.sessions.length) + '</span>' +
                '</div>' +
                '<div class="sidebar-header-actions">' +
                  '<button id="close-drawer-button" class="btn btn-ghost btn-sm sidebar-close" type="button" aria-label="关闭菜单">×</button>' +
                '</div>' +
              '</div>' +
              '<div class="sidebar-body">' +
                '<div id="sessions-panel">' +
                  '<div class="sessions-list" id="sessions-list">' + renderSessions() + '</div>' +
                '</div>' +
              '</div>' +
              '<div class="sidebar-footer">' +
                '<button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> 新会话</button>' +
                '<div class="sidebar-footer-actions">' +
                  '<button id="file-panel-toggle-btn" class="btn btn-ghost btn-sm' + (state.filePanelOpen ? " active" : "") + '" type="button" title="查看文件">📁 文件</button>' +
                  '<button id="settings-button" class="btn btn-ghost btn-sm" type="button" title="设置">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> 设置' +
                  '</button>' +
                  '<button id="pwa-install-button" class="btn btn-ghost btn-sm hidden" title="安装应用">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 安装' +
                  '</button>' +
                  '<button id="logout-button" class="btn btn-ghost btn-sm sidebar-logout" type="button" title="退出登录">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> 退出' +
                  '</button>' +
                '</div>' +
              '</div>' +
            '</aside>' +
            '<main class="main-content">' +
              '<span class="current-task hidden" id="current-task"></span>' +
              '' +
              // File panel backdrop (mobile)
              '<div id="file-panel-backdrop" class="file-panel-backdrop' + (state.filePanelOpen ? " open" : "") + '"></div>' +
              // File side panel
              '<div id="file-side-panel" class="file-side-panel' + (state.filePanelOpen ? " open" : "") + '">' +
                '<div class="file-side-panel-header">' +
                  '<span class="file-side-panel-title">文件</span>' +
                  '<button id="file-side-panel-close" class="btn btn-ghost btn-sm" type="button" aria-label="关闭">×</button>' +
                '</div>' +
                '<div class="file-side-panel-body">' +
                  '<div class="file-explorer-header">' +
                    '<span class="file-explorer-path" id="file-explorer-cwd">' + escapeHtml(selectedSession && selectedSession.cwd ? selectedSession.cwd : getConfigCwd()) + '</span>' +
                    '<button class="file-explorer-refresh" id="file-explorer-refresh" title="刷新" aria-label="刷新文件列表">↻</button>' +
                  '</div>' +
                  '<div class="file-search-box">' +
                    '<input type="text" id="file-search-input" class="file-search-input" placeholder="搜索文件..." autocomplete="off" />' +
                    '<button class="file-search-clear" id="file-search-clear" type="button" aria-label="清除搜索">×</button>' +
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
                '<button id="terminal-jump-bottom" class="terminal-jump-bottom' + (state.showTerminalJumpToBottom ? ' visible' : '') + '" type="button" title="回到底部">↓ 最新</button>' +
              '</div>' +
              '<div id="chat-output" class="chat-container hidden"></div>' +
              '<div id="blank-chat" class="blank-chat' + (state.selectedId ? " hidden" : "") + '">' +
                '<div class="blank-chat-inner">' +
                  '<div class="blank-chat-logo">W</div>' +
                  '<h2 class="blank-chat-title">Wand</h2>' +
                  '<p class="blank-chat-subtitle">当前仅保留原生终端模式，优先修复 PTY 交互与显示。</p>' +
                  '<div class="blank-chat-tools">' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-claude" type="button">' +
                      '<span class="tool-icon">🤖</span>新建终端会话' +
                    '</button>' +
                  '</div>' +
                  '<div class="blank-chat-cwd-wrap">' +
                    '<div class="blank-chat-cwd" id="blank-chat-cwd" role="button" tabindex="0" title="点击切换工作目录">' +
                      '<span class="blank-chat-cwd-icon">📁</span>' +
                      '<span class="blank-chat-cwd-path" id="blank-chat-cwd-path">' + escapeHtml(getEffectiveCwd()) + '</span>' +
                      '<span class="blank-chat-cwd-arrow" id="blank-chat-cwd-arrow">▼</span>' +
                    '</div>' +
                    '<div class="blank-chat-cwd-dropdown hidden" id="blank-chat-cwd-dropdown"></div>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              '<div class="input-panel' + (state.selectedId ? "" : " hidden") + '">' +
                '<div id="todo-progress" class="todo-progress hidden">' +
                  '<div class="todo-progress-header" id="todo-progress-toggle">' +
                    '<div class="todo-progress-left">' +
                      '<span class="todo-progress-spinner"></span>' +
                      '<span class="todo-progress-counter" id="todo-progress-counter">0/0</span>' +
                      '<span class="todo-progress-task" id="todo-progress-task"></span>' +
                    '</div>' +
                    '<svg class="todo-progress-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
                  '</div>' +
                  '<div class="todo-progress-body hidden" id="todo-progress-body">' +
                    '<ul class="todo-progress-list" id="todo-progress-list"></ul>' +
                    '<div id="recent-actions" class="recent-actions"></div>' +
                  '</div>' +
                '</div>' +
                '<div class="input-composer">' +
                  '<textarea id="input-box" class="input-textarea" placeholder="' + (state.terminalInteractive ? "终端交互模式开启中，请直接在终端中输入" : "输入消息...") + '" rows="1">' + escapeHtml(currentDraft) + '</textarea>' +
                  '<div class="input-composer-bar">' +
                    '<div class="input-composer-left">' +
                      '<select id="chat-mode-select" class="chat-mode-select" title="仅对新建会话生效">' +
                        renderModeOptions(preferredTool, composerMode) +
                      '</select>' +
                      '<button id="terminal-interactive-toggle-top" class="composer-interactive-toggle' + (state.terminalInteractive ? " active" : "") + '" type="button" title="切换终端交互模式">⌨</button>' +
                      '<span class="permission-actions hidden" id="permission-actions">' +
                        '<span class="permission-actions-divider"></span>' +
                        '<span class="permission-actions-label" id="permission-actions-label">等待授权</span>' +
                        '<button id="approve-permission-btn" class="btn btn-permission btn-permission-approve" type="button">批准</button>' +
                        '<button id="deny-permission-btn" class="btn btn-permission btn-permission-deny" type="button">拒绝</button>' +
                      '</span>' +
                    '</div>' +
                    '<div class="input-composer-right">' +
                      '<span id="queue-counter" class="queue-counter hidden">队列: 0</span>' +
                      '<span class="input-hint' + (state.terminalInteractive ? ' terminal-interactive-hint' : state.currentView === "terminal" ? " hidden" : "") + '">' + (state.terminalInteractive ? '终端交互中 · Ctrl+C 中断 · Ctrl+L 清屏' : 'Enter 发送 · Shift+Enter 换行') + '</span>' +
                      renderInlineKeyboard() +
                      '<button id="stop-button" class="btn-circle btn-circle-stop' + (state.selectedId ? "" : " hidden") + '" title="停止">' +
                        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>' +
                      '</button>' +
                      '<button id="send-input-button" class="btn-circle btn-circle-send" title="发送">' +
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
                      '</button>' +
                    '</div>' +
                  '</div>' +
                  renderExpandedShortcutsRow() +
                  // Session info bar at bottom
                  '<div class="input-session-info-bar">' +
                    '<span id="session-cwd-display" class="session-cwd-display">' + (selectedSession && selectedSession.cwd ? escapeHtml(selectedSession.cwd) : '未设置目录') + '</span>' +
                    '<span class="session-info-separator">|</span>' +
                    '<span id="session-mode-display" class="session-mode-display">' + (selectedSession ? getModeLabel(selectedSession.mode) : '默认') + '</span>' +
                    '<span class="session-info-separator">|</span>' +
                    '<span id="session-status-display" class="session-status-display">' + (selectedSession ? getSessionStatusLabel(selectedSession) : '-') + '</span>' +
                    (selectedSession && selectedSession.claudeSessionId ? '<span class="session-info-separator">|</span><span id="claude-session-id-badge" class="claude-session-id-badge" data-claude-id="' + escapeHtml(selectedSession.claudeSessionId) + '" title="点击复制 Claude 会话 ID">☁ ' + escapeHtml(selectedSession.claudeSessionId.slice(0, 8)) + '</span>' : '') +
                    '<span class="session-info-separator">|</span>' +
                    '<span id="session-exit-display" class="session-exit-display">exit=' + (selectedSession && selectedSession.exitCode !== undefined ? selectedSession.exitCode : 'n/a') + '</span>' +
                  '</div>' +
                '</div>' +
                '<p id="action-error" class="error-message hidden"></p>' +
              '</div>' +
              // Folder picker modal (hidden by default)
              '<section id="folder-picker-modal" class="modal-backdrop hidden">' +
                '<div class="modal folder-picker-modal">' +
                  '<div class="modal-header">' +
                    '<h2 class="modal-title">选择工作目录</h2>' +
                    '<button id="close-folder-picker" class="btn btn-ghost btn-icon">×</button>' +
                  '</div>' +
                  '<div class="modal-body">' +
                    '<div class="folder-picker-quick-row">' +
                      '<button class="folder-picker-quick-btn" data-path="/tmp">🗑️ 临时目录</button>' +
                      '<button class="folder-picker-quick-btn" data-path="/">📁 根目录</button>' +
                    '</div>' +
                    '<div id="folder-breadcrumb" class="folder-breadcrumb"></div>' +
                    '<div class="folder-picker">' +
                      '<span class="folder-picker-icon">📁</span>' +
                      '<input type="text" id="folder-picker-input" class="folder-picker-input" value="" placeholder="输入或选择工作目录..." autocomplete="off" />' +
                    '</div>' +
                    '<div id="folder-picker-dropdown" class="folder-picker-dropdown hidden"></div>' +
                    '<div id="folder-picker-validation" class="folder-picker-validation"></div>' +
                  '</div>' +
                '</div>' +
              '</section>' +
            '</main>' +
          '</div>' +
        '</div>' + renderSessionModal() + renderSettingsModal();
      }

      function renderSettingsModal() {
        return '<section id="settings-modal" class="modal-backdrop hidden">' +
          '<div class="modal settings-modal">' +
            '<div class="modal-header">' +
              '<h2 class="modal-title">设置</h2>' +
              '<button id="close-settings-button" class="btn btn-ghost btn-icon">×</button>' +
            '</div>' +
            '<div class="modal-body">' +
              // Tabs
              '<div class="settings-tabs">' +
                '<button class="settings-tab active" data-tab="about">关于</button>' +
                '<button class="settings-tab" data-tab="general">基本配置</button>' +
                '<button class="settings-tab" data-tab="security">安全</button>' +
                '<button class="settings-tab" data-tab="presets">命令预设</button>' +
              '</div>' +

              // About tab
              '<div class="settings-panel active" id="settings-tab-about">' +
                '<div class="settings-about-info">' +
                  '<div class="settings-about-row"><span class="settings-label">包名</span><span class="settings-value" id="settings-pkg-name">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">当前版本</span><span class="settings-value" id="settings-version">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">Node.js 要求</span><span class="settings-value" id="settings-node-req">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">仓库地址</span><span class="settings-value" id="settings-repo-url"><a href="#" target="_blank" rel="noopener">-</a></span></div>' +
                '</div>' +
                '<div class="settings-update-section">' +
                  '<div class="settings-about-row">' +
                    '<span class="settings-label">最新版本</span>' +
                    '<span class="settings-value" id="settings-latest-version">-</span>' +
                  '</div>' +
                  '<div class="settings-update-actions">' +
                    '<button id="check-update-button" class="btn btn-ghost btn-sm">检查更新</button>' +
                    '<button id="do-update-button" class="btn btn-primary btn-sm hidden">更新到最新版</button>' +
                  '</div>' +
                  '<p id="update-message" class="hint hidden"></p>' +
                '</div>' +
                '<div class="settings-notification-section">' +
                  '<div class="settings-section-title">\u901a\u77e5\u72b6\u6001</div>' +
                  '<div class="settings-about-row">' +
                    '<span class="settings-label">\u6d4f\u89c8\u5668\u901a\u77e5</span>' +
                    '<span class="settings-value" id="notification-permission-status">-</span>' +
                  '</div>' +
                  '<div class="settings-update-actions">' +
                    '<button id="notification-request-btn" class="btn btn-ghost btn-sm hidden">\u6388\u6743\u901a\u77e5</button>' +
                    '<button id="notification-test-btn" class="btn btn-ghost btn-sm">\u53d1\u9001\u6d4b\u8bd5\u901a\u77e5</button>' +
                  '</div>' +
                  '<p id="notification-test-message" class="hint hidden"></p>' +
                '</div>' +
              '</div>' +

              // General config tab
              '<div class="settings-panel" id="settings-tab-general">' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-host">监听地址 (host)</label>' +
                  '<input id="cfg-host" type="text" class="field-input" placeholder="127.0.0.1" />' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-port">端口 (port)</label>' +
                  '<input id="cfg-port" type="number" class="field-input" placeholder="8443" min="1" max="65535" />' +
                '</div>' +
                '<div class="field field-inline">' +
                  '<label class="field-label" for="cfg-https">启用 HTTPS</label>' +
                  '<input id="cfg-https" type="checkbox" class="field-checkbox" />' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-mode">默认执行模式</label>' +
                  '<select id="cfg-mode" class="field-input">' +
                    '<option value="default">default</option>' +
                    '<option value="assist">assist</option>' +
                    '<option value="agent">agent</option>' +
                    '<option value="agent-max">agent-max</option>' +
                    '<option value="auto-edit">auto-edit</option>' +
                    '<option value="full-access">full-access</option>' +
                    '<option value="native">native</option>' +
                    '<option value="managed">managed</option>' +
                  '</select>' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-cwd">默认工作目录</label>' +
                  '<input id="cfg-cwd" type="text" class="field-input" placeholder="/home/user" />' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-shell">Shell</label>' +
                  '<input id="cfg-shell" type="text" class="field-input" placeholder="/bin/bash" />' +
                '</div>' +
                '<div class="field field-inline">' +
                  '<label class="field-label" for="cfg-dom-terminal">终端 DOM 渲染 <span style="font-size:0.7em;color:var(--warning);font-weight:600;">实验性</span></label>' +
                  '<input id="cfg-dom-terminal" type="checkbox" class="field-checkbox" />' +
                '</div>' +
                '<p class="hint" style="margin-top:-8px;margin-bottom:8px;">移动端使用 DOM 渲染终端，支持原生文本选择与复制。保存后刷新页面生效。</p>' +
                '<button id="save-config-button" class="btn btn-primary btn-block">保存配置</button>' +
                '<p id="config-message" class="hint hidden"></p>' +
              '</div>' +

              // Security tab
              '<div class="settings-panel" id="settings-tab-security">' +
                '<h3 class="settings-section-title">修改密码</h3>' +
                '<div class="field">' +
                  '<label class="field-label" for="new-password">新密码</label>' +
                  '<input id="new-password" type="password" class="field-input" placeholder="输入新密码（至少 6 个字符）" autocomplete="new-password" />' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="confirm-password">确认密码</label>' +
                  '<input id="confirm-password" type="password" class="field-input" placeholder="再次输入新密码" autocomplete="new-password" />' +
                '</div>' +
                '<button id="save-password-button" class="btn btn-primary btn-block">保存密码</button>' +
                '<p id="settings-error" class="error-message hidden"></p>' +
                '<p id="settings-success" class="hint hidden" style="color: var(--success);"></p>' +
                '<hr class="settings-divider" />' +
                '<h3 class="settings-section-title">SSL 证书</h3>' +
                '<p class="settings-hint" id="cert-status">加载中...</p>' +
                '<div class="field">' +
                  '<label class="field-label" for="cert-key-file">私钥文件 (.key)</label>' +
                  '<input id="cert-key-file" type="file" class="field-input field-file" accept=".key,.pem" />' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cert-cert-file">证书文件 (.crt/.pem)</label>' +
                  '<input id="cert-cert-file" type="file" class="field-input field-file" accept=".crt,.pem,.cert" />' +
                '</div>' +
                '<button id="upload-cert-button" class="btn btn-primary btn-block">上传证书</button>' +
                '<p id="cert-message" class="hint hidden"></p>' +
              '</div>' +

              // Command presets tab
              '<div class="settings-panel" id="settings-tab-presets">' +
                '<div id="presets-list" class="presets-list"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderSessions() {
        var activeSessions = state.sessions.filter(function(session) { return !session.archived && !session.resumedToSessionId; });
        var archivedSessions = state.sessions.filter(function(session) { return session.archived; });
        var groups = [];
        groups.push(renderSessionManageBar());

        // Split claude history into recent (24h) and older
        var recentHistorySessions = [];
        if (state.claudeHistoryLoaded) {
          var cutoff = Date.now() - 24 * 60 * 60 * 1000;
          recentHistorySessions = getVisibleClaudeHistorySessions().filter(function(s) {
            return s.timestamp && new Date(s.timestamp).getTime() > cutoff;
          });
        }

        if (activeSessions.length > 0 || recentHistorySessions.length > 0) {
          groups.push(renderRecentGroup(activeSessions, recentHistorySessions));
        }
        if (archivedSessions.length > 0) {
          groups.push(renderSessionGroup("已归档", archivedSessions, "sessions"));
        }
        groups.push(renderClaudeHistorySection());
        if (activeSessions.length === 0 && archivedSessions.length === 0 && recentHistorySessions.length === 0) {
          return renderSessionManageBar() + '<div class="empty-state"><strong>还没有会话记录</strong><br>点击上方「新对话」开始你的第一次对话。</div>' + renderClaudeHistorySection();
        }
        return groups.join("");
      }

      function renderSessionManageBar() {
        if (!state.sessionsManageMode) {
          return '<div class="session-manage-bar">' +
            '<span class="sidebar-intro">最近的会话记录</span>' +
            '<button class="session-manage-toggle" data-action="toggle-manage-mode" type="button">管理</button>' +
          '</div>';
        }

        var sessionCount = getSelectedSessionIds().length;
        var historyCount = getSelectedClaudeHistoryIds().length;
        var totalCount = sessionCount + historyCount;
        var hasAny = totalCount > 0;

        return '<div class="session-manage-bar active">' +
          '<div class="session-manage-summary">已选择 ' + totalCount + ' 项</div>' +
          '<div class="session-manage-actions">' +
            '<button class="session-manage-btn" data-action="select-all-visible" type="button">全选</button>' +
            '<button class="session-manage-btn" data-action="clear-selection" type="button">清空</button>' +
            '<button class="session-manage-btn danger" data-action="delete-selected" type="button"' + (hasAny ? '' : ' disabled') + '>删除所选</button>' +
            '<button class="session-manage-btn" data-action="toggle-manage-mode" type="button">完成</button>' +
          '</div>' +
        '</div>';
      }

      function renderSessionGroup(title, sessions, kind) {
        return '<section class="session-group">' +
          '<div class="session-group-title">' + escapeHtml(title) + '</div>' +
          sessions.map(function(session) { return renderSessionItem(session, kind); }).join("") +
        '</section>';
      }

      function renderRecentGroup(activeSessions, recentHistorySessions) {
        var html = '<section class="session-group">' +
          '<div class="session-group-title">最近</div>';
        html += activeSessions.map(function(session) { return renderSessionItem(session, "sessions"); }).join("");
        html += recentHistorySessions.map(function(session) { return renderClaudeHistoryItem(session, "history"); }).join("");
        html += '</section>';
        return html;
      }

      function renderClaudeHistorySection() {
        // Exclude recent 24h items from history section
        var cutoff = Date.now() - 24 * 60 * 60 * 1000;
        var visibleHistory = getVisibleClaudeHistorySessions().filter(function(s) {
          return !s.timestamp || new Date(s.timestamp).getTime() <= cutoff;
        });
        var chevron = state.claudeHistoryExpanded ? "&#9662;" : "&#9656;";
        var countBadge = state.claudeHistoryLoaded && visibleHistory.length > 0
          ? ' <span class="history-count">' + visibleHistory.length + '</span>'
          : '';
        var clearAllButton = state.claudeHistoryExpanded && state.claudeHistoryLoaded && visibleHistory.length > 0
          ? '<button class="session-manage-btn danger compact" data-action="clear-all-history" type="button">清空历史</button>'
          : '';
        var header = '<div class="session-group-title claude-history-toggle" id="claude-history-toggle">' +
          '<span class="chevron">' + chevron + '</span> Claude 历史' + countBadge +
          '</div>' + clearAllButton;

        if (!state.claudeHistoryExpanded) {
          return '<section class="session-group">' + header + '</section>';
        }

        if (!state.claudeHistoryLoaded) {
          return '<section class="session-group">' + header +
            '<div class="claude-history-loading">扫描历史会话中…</div></section>';
        }

        if (visibleHistory.length === 0) {
          return '<section class="session-group">' + header +
            '<div class="claude-history-loading">没有更早的 Claude 历史会话</div></section>';
        }

        var groups = {};
        var groupOrder = [];
        visibleHistory.forEach(function(s) {
          if (!groups[s.cwd]) {
            groups[s.cwd] = [];
            groupOrder.push(s.cwd);
          }
          groups[s.cwd].push(s);
        });

        var html = '';
        groupOrder.forEach(function(cwd) {
          var cwdShort = cwd.split("/").filter(Boolean).slice(-3).join("/");
          var isDirExpanded = !!state.claudeHistoryExpandedDirs[cwd];
          html += renderClaudeHistoryDirectoryHeader(cwd, cwdShort, groups[cwd].length, isDirExpanded);
          if (isDirExpanded) {
            html += groups[cwd].map(function(session) { return renderClaudeHistoryItem(session, "history"); }).join("");
          }
        });

        return '<section class="session-group">' + header + html + '</section>';
      }

      function getVisibleClaudeHistorySessions() {
        return state.claudeHistory.filter(function(s) {
          return s.hasConversation && !s.managedByWand;
        });
      }

      function getSelectedSessionIds() {
        return Object.keys(state.selectedSessionIds).filter(function(id) { return !!state.selectedSessionIds[id]; });
      }

      function getSelectedClaudeHistoryIds() {
        return Object.keys(state.selectedClaudeHistoryIds).filter(function(id) { return !!state.selectedClaudeHistoryIds[id]; });
      }

      function clearManageSelections() {
        state.selectedSessionIds = {};
        state.selectedClaudeHistoryIds = {};
      }

      function toggleManageMode(force) {
        state.sessionsManageMode = typeof force === "boolean" ? force : !state.sessionsManageMode;
        if (!state.sessionsManageMode) {
          clearManageSelections();
          closeSwipedItem();
        }
        updateSessionsList();
      }

      function selectAllVisibleItems() {
        var nextSessionIds = {};
        state.sessions.forEach(function(session) {
          nextSessionIds[session.id] = true;
        });
        var cutoff = Date.now() - 24 * 60 * 60 * 1000;
        var nextHistoryIds = {};
        getVisibleClaudeHistorySessions().filter(function(session) {
          return !session.timestamp || new Date(session.timestamp).getTime() <= cutoff;
        }).forEach(function(session) {
          nextHistoryIds[session.claudeSessionId] = true;
        });
        state.selectedSessionIds = nextSessionIds;
        state.selectedClaudeHistoryIds = nextHistoryIds;
        updateSessionsList();
      }

      function clearSelections() {
        clearManageSelections();
        updateSessionsList();
      }

      function toggleManagedItemSelection(kind, id) {
        if (!state.sessionsManageMode || !id) return;
        var target = kind === "history" ? state.selectedClaudeHistoryIds : state.selectedSessionIds;
        if (target[id]) {
          delete target[id];
        } else {
          target[id] = true;
        }
        updateSessionsList();
      }

      function renderManageCheckbox(kind, id, label) {
        if (!state.sessionsManageMode) return '';
        var selected = kind === "history" ? !!state.selectedClaudeHistoryIds[id] : !!state.selectedSessionIds[id];
        return '<label class="session-manage-check">' +
          '<input type="checkbox" data-action="toggle-selection" data-kind="' + escapeHtml(kind) + '" data-id="' + escapeHtml(id) + '"' + (selected ? ' checked' : '') + ' aria-label="' + escapeHtml(label) + '">' +
          '<span></span>' +
        '</label>';
      }

      function confirmDelete(message) {
        return window.confirm(message);
      }

      function batchDeleteSelected() {
        var sessionIds = getSelectedSessionIds();
        var historyIds = getSelectedClaudeHistoryIds();
        var total = sessionIds.length + historyIds.length;
        if (!total) return;
        if (!confirmDelete('确认删除所选 ' + total + ' 项吗？')) {
          return;
        }

        var requests = [];
        if (sessionIds.length > 0) {
          requests.push(fetch('/api/sessions/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionIds: sessionIds })
          }).then(function(res) { return res.json(); }));
        }
        if (historyIds.length > 0) {
          requests.push(fetch('/api/claude-history/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ claudeSessionIds: historyIds })
          }).then(function(res) { return res.json(); }));
        }

        Promise.all(requests)
          .then(function() {
            if (sessionIds.indexOf(state.selectedId) !== -1) {
              state.selectedId = null;
              persistSelectedId();
            }
            state.claudeHistory = state.claudeHistory.filter(function(session) {
              return historyIds.indexOf(session.claudeSessionId) === -1;
            });
            clearManageSelections();
            return refreshAll();
          })
          .catch(function() {
            var errorEl = document.getElementById('action-error');
            showError(errorEl, '无法批量删除所选项目。');
          });
      }

      function clearAllClaudeHistory() {
        var cutoff = Date.now() - 24 * 60 * 60 * 1000;
        var visibleHistory = getVisibleClaudeHistorySessions().filter(function(s) {
          return !s.timestamp || new Date(s.timestamp).getTime() <= cutoff;
        });
        if (!visibleHistory.length) return;
        if (!confirmDelete('确认清空当前显示的 ' + visibleHistory.length + ' 条 Claude 历史吗？')) {
          return;
        }
        var deleteIds = visibleHistory.map(function(session) { return session.claudeSessionId; });
        return fetch('/api/claude-history/batch-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ claudeSessionIds: deleteIds })
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            state.claudeHistory = state.claudeHistory.filter(function(s) {
              return deleteIds.indexOf(s.claudeSessionId) === -1;
            });
            clearManageSelections();
            updateSessionsList();
          })
          .catch(function() {
            var errorEl = document.getElementById('action-error');
            showError(errorEl, '无法清空历史会话。');
          });
      }

      function renderClaudeHistoryDirectoryHeader(cwd, cwdShort, count, isExpanded) {
        var chevron = isExpanded ? "&#9662;" : "&#9656;";
        return '<div class="claude-history-directory-header" data-action="toggle-history-directory" data-cwd="' + escapeHtml(cwd) + '" role="button" tabindex="0">' +
          '<div class="session-group-title claude-history-directory-title">' +
            '<span class="chevron">' + chevron + '</span>' +
            '<span class="claude-history-directory-label">' + escapeHtml(cwdShort) + ' (' + count + ')</span>' +
            '<button class="session-manage-btn danger compact claude-history-directory-clear-btn" data-action="delete-history-directory" data-cwd="' +
            escapeHtml(cwd) + '" type="button" aria-label="清空此目录的历史会话" title="清空此目录的历史会话">清空此目录</button>' +
          '</div>' +
        '</div>';
      }

      function renderClaudeHistoryItem(session, kind) {
        var shortId = session.claudeSessionId.slice(0, 8);
        var preview = session.firstUserMessage || "(空会话)";
        var timeStr = formatHistoryTime(session.timestamp);
        var checkbox = renderManageCheckbox(kind, session.claudeSessionId, "选择历史会话 " + preview);
        var deleteButton = state.sessionsManageMode ? '' :
          '<button class="session-action-btn delete-btn" data-action="delete-history" data-claude-session-id="' +
          session.claudeSessionId + '" type="button" aria-label="删除会话" title="隐藏此历史会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
        var resumeButton = state.sessionsManageMode ? '' :
          '<button class="session-action-btn" data-action="resume-history" data-claude-session-id="' +
          session.claudeSessionId + '" data-cwd="' + escapeHtml(session.cwd) +
          '" type="button" aria-label="恢复会话" title="恢复此 Claude 历史会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';

        return '<div class="session-item claude-history-item' + (state.sessionsManageMode && state.selectedClaudeHistoryIds[session.claudeSessionId] ? ' selected' : '') + '" data-claude-history-id="' + session.claudeSessionId + '" data-cwd="' + escapeHtml(session.cwd) + '" role="button" tabindex="0">' +
          '<div class="session-item-content">' +
            '<div class="session-item-row">' +
              checkbox +
              '<div class="session-main">' +
                '<div class="session-command claude-history-preview">' + escapeHtml(preview) + '</div>' +
                '<div class="session-meta">' +
                  '<span class="session-id" title="' + escapeHtml(session.claudeSessionId) + '">' + escapeHtml(shortId) + '</span>' +
                  '<span>' + escapeHtml(timeStr) + '</span>' +
                '</div>' +
              '</div>' +
              '<span class="session-actions">' + resumeButton + deleteButton + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }
      function formatHistoryTime(isoStr) {
        if (!isoStr) return "";
        try {
          var d = new Date(isoStr);
          var now = new Date();
          var diffMs = now - d;
          var diffMin = Math.floor(diffMs / 60000);
          if (diffMin < 1) return "刚刚";
          if (diffMin < 60) return diffMin + " 分钟前";
          var diffHr = Math.floor(diffMin / 60);
          if (diffHr < 24) return diffHr + " 小时前";
          var diffDay = Math.floor(diffHr / 24);
          if (diffDay < 30) return diffDay + " 天前";
          return d.toLocaleDateString();
        } catch (e) {
          return "";
        }
      }

      function loadClaudeHistory() {
        return fetch("/api/claude-history", { credentials: "same-origin" })
          .then(function(res) {
            if (!res.ok) return [];
            return res.json();
          })
          .then(function(sessions) {
            state.claudeHistory = sessions || [];
            state.claudeHistoryLoaded = true;
            updateSessionsList();
          })
          .catch(function() {
            state.claudeHistoryLoaded = true;
            state.claudeHistory = [];
            updateSessionsList();
          });
      }

      function isMobileLayout() {
        return window.innerWidth <= 768;
      }

      function setFilePanelOpen(nextOpen) {
        state.filePanelOpen = nextOpen;
        try {
          localStorage.setItem("wand-file-panel-open", String(state.filePanelOpen));
        } catch (e) {}
        if (state.filePanelOpen && isMobileLayout()) {
          state.sessionsDrawerOpen = false;
        }
        updateLayoutState();
        if (state.filePanelOpen) {
          refreshFileExplorer();
        }
      }

      function toggleFilePanel() {
        setFilePanelOpen(!state.filePanelOpen);
      }

      function updateFilePanelState() {
        var panel = document.getElementById("file-side-panel");
        var mainContent = document.querySelector(".main-content");
        var toggleBtn = document.getElementById("file-panel-toggle-btn");
        var backdrop = document.getElementById("file-panel-backdrop");
        if (panel) {
          panel.classList.toggle("open", state.filePanelOpen);
        }
        if (mainContent) {
          mainContent.classList.toggle("file-panel-open", state.filePanelOpen);
        }
        if (backdrop) {
          backdrop.classList.toggle("open", state.filePanelOpen);
        }
        if (toggleBtn) {
          toggleBtn.classList.toggle("active", state.filePanelOpen);
        }
      }

      function updateLayoutState() {
        updateDrawerState();
        updateFilePanelState();
      }

      function updateFilePanelCwd(session) {
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!cwdEl) return;
        var cwd = session && session.cwd ? session.cwd : getConfigCwd();
        cwdEl.textContent = cwd;
      }

      function closeFilePanel() {
        if (!state.filePanelOpen) return;
        setFilePanelOpen(false);
      }

      function adjustTerminalScale(delta) {
        var newScale = state.terminalScale + delta;
        // Clamp scale between 0.5 and 2
        newScale = Math.max(0.5, Math.min(2, newScale));
        // Round to nearest 0.25
        newScale = Math.round(newScale * 4) / 4;
        if (newScale === state.terminalScale) return;
        state.terminalScale = newScale;
        try {
          localStorage.setItem("wand-terminal-scale", String(newScale));
        } catch (e) {}
        applyTerminalScale();
        updateScaleLabel();
        scheduleTerminalResize();
      }

      function applyTerminalScale() {
        if (!state.terminal) return;
        state.terminal.options.fontSize = state.terminalBaseFontSize * state.terminalScale;
        state.terminal.refresh(0, state.terminal.rows - 1);
        // Apply to DOM terminal view as well
        if (state.terminalDomView) {
          state.terminalDomView.style.fontSize = (state.terminalBaseFontSize * state.terminalScale) + "px";
        }
      }

      function updateScaleLabel() {
        var label = document.getElementById("terminal-scale-label-top");
        if (label) {
          label.textContent = Math.round(state.terminalScale * 100) + "%";
        }
      }

      function renderFileExplorer(cwd) {
        var root = cwd || getConfigCwd();
        if (!root) {
          return '<div class="file-explorer empty">No working directory configured.</div>';
        }
        return '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(root) + '">' +
          '<div class="tree-loading">Loading...</div>' +
        '</div>';
      }

      function refreshFileExplorer() {
        var explorer = document.getElementById("file-explorer");
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!explorer) return;
        // Get cwd from current session or config
        var cwd = "";
        if (state.selectedId) {
          var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (session) cwd = session.cwd || "";
        }
        if (!cwd) {
          cwd = getConfigCwd();
        }
        if (!cwd) {
          explorer.innerHTML = '<div class="file-explorer empty">No working directory.</div>';
          return;
        }
        explorer.innerHTML = '<div class="file-explorer"><div class="tree-loading" style="padding:12px;color:var(--text-muted);font-size:0.8125rem;">Loading...</div></div>';
        // Update the cwd display
        if (cwdEl) cwdEl.textContent = cwd;
        // Fetch with git status
        fetch("/api/directory?q=" + encodeURIComponent(cwd) + "&gitStatus=true", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(items) {
            if (!items || items.length === 0) {
              explorer.innerHTML = '<div class="file-explorer empty">Empty directory or inaccessible.</div>';
              return;
            }
            state.allFiles = items;
            filterFileTree();
          })
          .catch(function() {
            explorer.innerHTML = '<div class="file-explorer empty">Failed to load files.</div>';
          });
      }

      function filterFileTree() {
        var explorer = document.getElementById("file-explorer");
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!explorer) return;
        var cwd = cwdEl ? cwdEl.textContent : "";
        if (!cwd) return;

        var query = state.fileSearchQuery;
        var items = state.allFiles || [];

        // 如果没有搜索词，显示所有文件
        if (!query) {
          explorer.innerHTML = '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(cwd) + '">' +
            items.map(function(item) {
              return renderFileTreeItem(item);
            }).join("") +
          '</div>';
          attachFileTreeListeners();
          return;
        }

        // 模糊匹配文件名（大小写不敏感）
        var lowerQuery = query.toLowerCase();
        var filtered = items.filter(function(item) {
          return item.name.toLowerCase().indexOf(lowerQuery) !== -1;
        });

        if (filtered.length === 0) {
          explorer.innerHTML = '<div class="file-explorer empty">没有找到匹配的文件</div>';
          return;
        }

        explorer.innerHTML = '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(cwd) + '">' +
          filtered.map(function(item) {
            return renderFileTreeItem(item);
          }).join("") +
        '</div>';
        attachFileTreeListeners();
      }

      function renderFileTreeItem(item) {
        var name = escapeHtml(item.name);
        var isDir = item.type === "dir";
        // Use clear emoji icons: 📁 for folders, 📄 for files
        var displayIcon = isDir ? "📁" : "📄";
        var toggleIcon = isDir ? "▸" : "";
        var toggleClass = isDir ? "" : " empty";
        var gitStatus = item.gitStatus;
        var statusBadge = renderGitStatusBadge(gitStatus);
        return '<div class="tree-item" data-path="' + escapeHtml(item.path) + '" data-type="' + escapeHtml(item.type) + '">' +
          '<span class="tree-toggle' + toggleClass + '">' + toggleIcon + '</span>' +
          '<span class="tree-icon">' + displayIcon + '</span>' +
          '<span class="tree-name">' + name + '</span>' +
          (statusBadge ? '<span class="git-status-badge ' + statusBadge.class + '" title="' + statusBadge.title + '">' + statusBadge.text + '</span>' : '') +
        '</div>';
      }

      function renderGitStatusBadge(gitStatus) {
        if (!gitStatus) return null;
        // Priority: staged > unstaged > untracked
        if (gitStatus.staged === "added") return { text: "A", class: "git-added", title: "已暂存（新增）" };
        if (gitStatus.staged === "modified") return { text: "M", class: "git-modified", title: "已暂存（修改）" };
        if (gitStatus.staged === "deleted") return { text: "D", class: "git-deleted", title: "已暂存（删除）" };
        if (gitStatus.staged === "renamed") return { text: "R", class: "git-renamed", title: "已暂存（重命名）" };
        if (gitStatus.unstaged === "modified") return { text: "M", class: "git-unstaged", title: "未暂存（修改）" };
        if (gitStatus.unstaged === "deleted") return { text: "D", class: "git-unstaged-deleted", title: "未暂存（删除）" };
        if (gitStatus.untracked) return { text: "?", class: "git-untracked", title: "未跟踪" };
        return null;
      }

      function attachFileTreeListeners() {
        var tree = document.getElementById("file-tree");
        if (!tree) return;
        tree.querySelectorAll(".tree-item[data-type='dir']").forEach(function(item) {
          item.addEventListener("click", function() {
            toggleTreeNode(item);
          });
        });
        tree.querySelectorAll(".tree-item[data-type='file']").forEach(function(item) {
          item.addEventListener("dblclick", function() {
            openFilePreview(item.dataset.path);
          });
        });
      }

      function toggleTreeNode(item) {
        var path = item.dataset.path;
        var toggle = item.querySelector(".tree-toggle");
        var children = item.nextElementSibling;

        if (children && children.classList.contains("tree-children")) {
          var isOpen = children.classList.contains("open");
          children.classList.toggle("open");
          if (toggle) toggle.classList.toggle("open", !isOpen);
          return;
        }

        // Load children with git status
        if (toggle) toggle.classList.add("open");
        fetch("/api/directory?q=" + encodeURIComponent(path) + "&gitStatus=true", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(items) {
            var childrenDiv = document.createElement("div");
            childrenDiv.className = "tree-children open";
            if (!items || items.length === 0) {
              childrenDiv.innerHTML = '<div class="tree-item" style="color:var(--text-muted);cursor:default;"><span class="tree-toggle empty">▸</span><span class="tree-name">（空目录）</span></div>';
            } else {
              childrenDiv.innerHTML = items.map(function(child) {
                return renderFileTreeItem(child);
              }).join("");
            }
            item.parentNode.insertBefore(childrenDiv, item.nextSibling);
            attachFileTreeListeners();
          })
          .catch(function() {});
      }

      function openFilePreview(filePath) {
        var overlay = document.createElement("div");
        overlay.className = "file-preview-overlay";
        overlay.innerHTML =
          '<div class="file-preview-modal">' +
            '<div class="file-preview-header">' +
              '<div class="file-preview-title">' +
                '<span>📄</span>' +
                '<span class="file-preview-filename">Loading...</span>' +
              '</div>' +
              '<div class="file-preview-path" title="' + escapeHtml(filePath) + '">' + escapeHtml(filePath) + '</div>' +
              '<button class="file-preview-close" title="Close">✕</button>' +
            '</div>' +
            '<div class="file-preview-body">' +
              '<div class="file-preview-loading">Loading preview...</div>' +
            '</div>' +
          '</div>';
        document.body.appendChild(overlay);

        var closeBtn = overlay.querySelector(".file-preview-close");
        var closeModal = function() {
          overlay.remove();
          document.removeEventListener("keydown", escHandler);
        };
        closeBtn.addEventListener("click", closeModal);
        overlay.addEventListener("click", function(e) {
          if (e.target === overlay) closeModal();
        });
        var escHandler = function(e) {
          if (e.key === "Escape") closeModal();
        };
        document.addEventListener("keydown", escHandler);

        fetch("/api/file-preview?path=" + encodeURIComponent(filePath), { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.error) {
              var body = overlay.querySelector(".file-preview-body");
              body.innerHTML = '<div class="file-preview-error"><span class="preview-error-icon">⚠</span><span>' + escapeHtml(data.error) + '</span></div>';
              return;
            }
            renderPreviewContent(overlay, data);
          })
          .catch(function(err) {
            var body = overlay.querySelector(".file-preview-body");
            body.innerHTML = '<div class="file-preview-error"><span class="preview-error-icon">⚠</span><span>Failed to load preview</span></div>';
          });
      }

      function renderPreviewContent(overlay, data) {
        var filename = overlay.querySelector(".file-preview-filename");
        filename.textContent = data.name;

        var langBadge = document.createElement("span");
        langBadge.className = "file-preview-lang";
        langBadge.textContent = data.lang || data.ext.replace(".", "");
        overlay.querySelector(".file-preview-title").appendChild(langBadge);

        var body = overlay.querySelector(".file-preview-body");

        if (data.lang === "markdown") {
          body.innerHTML = '<div class="markdown-preview">' + renderMarkdownPreview(data.content) + '</div>';
        } else {
          var highlighted = highlightCodePreview(data.content, data.lang);
          var lines = highlighted.split("\n");
          var lineNums = lines.map(function(_, i) { return i + 1; });

          body.innerHTML =
            '<div class="code-preview-wrapper">' +
              '<div class="code-preview-lines">' + lineNums.join("\n") + '</div>' +
              '<div class="code-preview-content"><pre>' + lines.join("\n") + '</pre></div>' +
            '</div>';
        }
      }

      function highlightCodePreview(code, lang) {
        // Escape HTML first
        var escaped = code
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        // Simple token-based syntax highlighting
        var tokens = getSyntaxTokens();
        if (!tokens) return escaped;

        // Order matters: longer patterns first, then by priority
        var patterns = [];
        for (var category in tokens) {
          var t = tokens[category];
          if (t && t.pattern) {
            patterns.push({ pattern: t.pattern, cls: t.cls, priority: t.priority || 5 });
          }
        }
        patterns.sort(function(a, b) { return b.priority - a.priority; });

        // Build regex for all patterns
        var allPatterns = patterns.map(function(p) { return "(" + p.pattern.source + ")"; });
        var regex = new RegExp(allPatterns.join("|"), "gm");

        return escaped.replace(regex, function(match) {
          for (var i = 0; i < patterns.length; i++) {
            var p = patterns[i];
            var re = new RegExp("^" + p.pattern.source + "$", "gm");
            if (re.test(match)) {
              return '<span class="' + p.cls + '">' + match + '</span>';
            }
          }
          return match;
        });
      }

      function getSyntaxTokens() {
        return {
          comment: { pattern: /\/\/.*|#[^\n]*/y, cls: "syntax-comment", priority: 1 },
          string: { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y, cls: "syntax-string", priority: 2 },
          keyword: { pattern: /\b(?:async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|module|namespace|new|null|of|override|private|protected|public|readonly|return|set|static|super|switch|this|throw|try|type|typeof|undefined|var|void|while|yield|abstract|as|base|bool|byte|char|decimal|double|event|explicit|extern|false|fixed|float|foreach|goto|implicit|in|int|internal|is|lock|long|object|operator|out|params|partial|readonly|ref|sbyte|sealed|short|sizeof|stackalloc|string|struct|switch|throw|true|try|uint|ulong|unchecked|unsafe|ushort|using|virtual|volatile|where|while|with|yield|def|elif|else|except|exec|finally|for|from|global|if|import|lambda|nonlocal|not|or|pass|print|raise|return|try|while|with|yield|True|False|None|and|in|is|lambda|not|or|fn|pub|use|mod|impl|trait|struct|enum|match|loop|while|for|if|else|return|self|super|crate|where|async|await|move|ref|mut|static|const|unsafe|extern|use|as|impl|struct|enum|type|fn|let|loop|if|else|match|return|self|Self|mod|pub|crate|macro|derive|where|async|await|dyn|self|package|func|go|return|defer|go|if|else|switch|case|default|for|range|select|break|continue|fallthrough|const|struct|enum|type|interface|map|chan|var|nil|true|false|iota|len|cap|append|make|new|panic|recover|select|else|if|elif|end|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while|end|and|begin|do|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while)\b/y, cls: "syntax-keyword", priority: 3 },
          number: { pattern: /\b(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:e[+-]?\d+)?)\b/y, cls: "syntax-number", priority: 2 },
          function: { pattern: /\b[A-Z][a-zA-Z0-9]*[a-z]\w*(?=\s*\()/y, cls: "syntax-function", priority: 4 },
          type: { pattern: /\b(?:string|number|boolean|void|any|unknown|never|object|symbol|bigint|Array|Object|String|Number|Boolean|Map|Set|WeakMap|WeakSet|Promise|Error|Type|Interface|Enum|Class|Struct|Impl|Trait|fn|fnc|func|function|def|proc|fun|pub|static|const|let|var|int|float|double|bool|char|byte|string|u8|u16|u32|u64|i8|i16|i32|i64|f32|f64|usize|isize|str|Vec|HashMap|Option|Result|Box|Rc|Arc|Cell|RefCell)\b/y, cls: "syntax-type", priority: 4 },
          operator: { pattern: /[+\-*/%=<>!&|^~?:]+|\.\.\.?/y, cls: "syntax-operator", priority: 5 },
          punctuation: { pattern: /[{}[\]();,\.]/y, cls: "syntax-punctuation", priority: 6 }
        };
      }

      function renderMarkdownPreview(text) {
        if (!text) return "";
        var escaped = escapeHtml(text);

        // Code blocks with syntax highlighting
        escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
          var highlighted = highlightCodePreview(code.trim(), lang);
          return '<pre><code class="language-' + lang + '">' + highlighted + '</code></pre>';
        });

        // Inline code
        escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Headers
        escaped = escaped.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
        escaped = escaped.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
        escaped = escaped.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
        escaped = escaped.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
        escaped = escaped.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
        escaped = escaped.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

        // Bold and italic
        escaped = escaped.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
        escaped = escaped.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
        escaped = escaped.replace(/__(.+?)__/g, '<strong>$1</strong>');
        escaped = escaped.replace(/_(.+?)_/g, '<em>$1</em>');

        // Strikethrough
        escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>');

        // Links
        escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Images
        escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

        // Blockquote
        escaped = escaped.replace(/^&gt;\s+(.*)$/gm, '<blockquote>$1</blockquote>');

        // Horizontal rule
        escaped = escaped.replace(/^---+$/gm, '<hr>');
        escaped = escaped.replace(/^\*\*\*+$/gm, '<hr>');

        // Unordered lists
        escaped = escaped.replace(/^[\-\*]\s+(.*)$/gm, '<li>$1</li>');
        escaped = escaped.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

        // Ordered lists
        escaped = escaped.replace(/^\d+\.\s+(.*)$/gm, '<li>$1</li>');

        // Tables
        escaped = escaped.replace(/\|(.+)\|/g, function(match) {
          var cells = match.split("|").slice(1, -1);
          if (cells.every(function(c) { return /^[\-:]+$/.test(c.trim()); })) {
            return "";
          }
          return '<tr>' + cells.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join("") + '</tr>';
        });
        escaped = escaped.replace(/(<tr>.*<\/tr>\n?)+/g, '<table>$&</table>');

        // Paragraphs
        var paragraphs = escaped.split(/\n{2,}/);
        escaped = paragraphs.map(function(p) {
          p = p.trim();
          if (!p) return "";
          if (/^<(h[1-6]|ul|ol|li|blockquote|pre|table|hr|div)/.test(p)) return p;
          return '<p>' + p.replace(/\n/g, "<br>") + '</p>';
        }).join("\n");

        return escaped;
      }

      function renderFolderPicker(state) {
        var currentDir = getEffectiveCwd();

        // 如果有选中的会话，不显示单独的工作目录标签（已嵌入输入框内部）
        if (state.selectedId) {
          return '';
        }

        // 新建会话时显示简化的目录选择器（单行紧凑设计）
        return '<div class="folder-picker-compact" id="folder-picker-container">' +
          '<div class="folder-picker-compact-row">' +
            '<span class="folder-picker-compact-icon">📁</span>' +
            '<input type="text" id="folder-picker-input" class="folder-picker-compact-input" value="' + escapeHtml(currentDir) + '" placeholder="工作目录" autocomplete="off" />' +
            '<button type="button" id="folder-picker-toggle" class="folder-picker-toggle" title="选择目录">▼</button>' +
          '</div>' +
          '<div id="folder-picker-dropdown" class="folder-picker-dropdown hidden">' +
            '<div class="folder-picker-quick-row">' +
              '<button class="folder-picker-quick-btn" data-path="/tmp">临时</button>' +
              '<button class="folder-picker-quick-btn" data-path="/">根目录</button>' +
            '</div>' +
          '</div>' +
          '<div id="folder-picker-validation" class="folder-picker-validation"></div>' +
        '</div>';
      }

      // 渲染内嵌到输入框的工作目录指示器
      function renderWorkingDirIndicator(state) {
        var currentDir = getEffectiveCwd();
        var displayDir = currentDir;

        // 如果有选中的会话，使用会话的工作目录
        if (state.selectedId) {
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          displayDir = selectedSession && selectedSession.cwd ? selectedSession.cwd : currentDir;
        }

        // 截断显示的路径
        var displayPath = displayDir;
        if (displayPath.length > 28) {
          displayPath = "..." + displayPath.slice(-25);
        }

        return '<div class="working-dir-indicator" id="working-dir-indicator" title="' + escapeHtml(displayDir) + '" data-path="' + escapeHtml(displayDir) + '">' +
          '<span class="working-dir-indicator-icon">📁</span>' +
          '<span class="working-dir-indicator-path">' + escapeHtml(displayPath) + '</span>' +
        '</div>';
      }

      function getSessionStatusLabel(session) {
        if (!session) return "";
        if (session.archived) return "已归档";
        if (session.permissionBlocked) return "等待授权";
        return session.status;
      }

      function getSessionStatusClass(session) {
        if (!session) return "";
        if (session.archived) return "archived";
        if (session.permissionBlocked) return "permission-blocked";
        return session.status || "";
      }

      function renderSessionItem(session) {
        var activeClass = session.id === state.selectedId ? " active" : "";
        var selectedClass = state.sessionsManageMode && state.selectedSessionIds[session.id] ? " selected" : "";
        var metaStatus = getSessionStatusLabel(session);
        var metaStatusClass = getSessionStatusClass(session);
        var modeName = session.mode === "full-access" ? "全权限" : session.mode === "default" ? "默认" : session.mode === "native" ? "原生" : session.mode === "auto-edit" ? "自动编辑" : session.mode;
        var resumeButton = "";
        var sessionIdDisplay = "";
        var recoveryHint = "";
        var checkbox = renderManageCheckbox("sessions", session.id, "选择会话 " + session.command);

        if (session.claudeSessionId) {
          var shortId = session.claudeSessionId.slice(0, 8);
          sessionIdDisplay = '<span class="session-id" title="' + escapeHtml(session.claudeSessionId) + '">' + escapeHtml(shortId) + '</span>';
          if (session.status !== "running" && !state.sessionsManageMode) {
            resumeButton = '<button class="session-action-btn" data-action="resume" data-session-id="' + session.id + '" type="button" aria-label="恢复会话" title="恢复 Claude 会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';
          }
        }

        if (session.autoRecovered) {
          recoveryHint = '<span class="session-id" title="自动恢复的会话">自动恢复</span>';
        }

        var deleteButton = state.sessionsManageMode ? '' : '<button class="session-action-btn delete-btn" data-action="delete-session" data-session-id="' + session.id + '" type="button" aria-label="删除会话" title="删除此会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
        var actionsHtml = '<span class="session-actions">' + resumeButton + deleteButton + '</span>';

        return '<div class="session-item' + activeClass + selectedClass + '" data-session-id="' + session.id + '" role="button" tabindex="0">' +
          '<div class="session-item-content">' +
            '<div class="session-item-row">' +
              checkbox +
              '<div class="session-main">' +
                '<div class="session-command">' + escapeHtml(session.resumedFromSessionId ? session.command.replace(/\s+--resume\s+\S+/, '') : session.command) + '</div>' +
                '<div class="session-meta">' +
                  '<span>' + escapeHtml(modeName) + '</span>' +
                  '<span class="session-status ' + metaStatusClass + '">' + escapeHtml(metaStatus) + '</span>' +
                  sessionIdDisplay +
                  recoveryHint +
                '</div>' +
              '</div>' +
              actionsHtml +
            '</div>' +
          '</div>' +
        '</div>';
      }
      function renderModeCards(selectedMode) {
        var modes = [
          { id: "managed",     label: "托管",     desc: "全自动完成任务" },
          { id: "full-access", label: "全权限",   desc: "自动确认权限" },
          { id: "auto-edit",   label: "自动编辑", desc: "自动确认修改" },
          { id: "default",     label: "标准",     desc: "逐步确认操作" },
          { id: "native",      label: "原生",     desc: "结构化单轮输出" }
        ];
        return modes.map(function(m) {
          var active = m.id === selectedMode ? " active" : "";
          return '<button type="button" class="mode-card' + active + '" data-mode="' + m.id + '">' +
            '<span class="mode-card-label">' + m.label + '</span>' +
            '<span class="mode-card-desc">' + m.desc + '</span>' +
          '</button>';
        }).join("");
      }

      function renderSessionModal() {
        var modalTool = getPreferredTool();
        var modalMode = getSafeModeForTool(modalTool, state.modeValue || state.chatMode || "default");
        return '<section id="session-modal" class="modal-backdrop hidden">' +
          '<div class="modal session-modal">' +
            '<div class="modal-header">' +
              '<div>' +
                '<h2 class="modal-title">新对话</h2>' +
                '<p class="modal-subtitle">启动 Claude 会话，选择模式和工作目录。</p>' +
              '</div>' +
              '<button id="close-modal-button" class="btn btn-ghost btn-icon">&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label">模式</label>' +
                '<div id="mode-cards" class="mode-cards">' +
                  renderModeCards(modalMode) +
                '</div>' +
                '<p id="mode-description" class="field-hint">' + escapeHtml(getToolModeHint(modalTool, modalMode)) + '</p>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="cwd">工作目录</label>' +
                '<div class="suggestions-wrap">' +
                  '<input id="cwd" type="text" class="field-input" autocomplete="off" placeholder="' + escapeHtml(getEffectiveCwd()) + '" />' +
                  '<div id="cwd-suggestions" class="suggestions hidden"></div>' +
                '</div>' +
                '<p class="field-hint">留空则使用上方目录，支持路径自动补全。</p>' +
                '<div id="recent-paths-bubbles" class="recent-paths-bubbles"></div>' +
              '</div>' +
              '<button id="run-button" class="btn btn-primary btn-block">启动会话</button>' +
              '<p id="modal-error" class="error-message hidden"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      // Global toggle function for tool card headers — called via onclick attribute
      window.__tcToggle = function(e, headerEl) {
        var card = headerEl.closest(".tool-use-card");
        if (card) card.classList.toggle("collapsed");
        if (e) { e.preventDefault(); e.stopPropagation(); }
      };
      // Toggle function for inline thinking blocks — called via onclick attribute
      window.__thinkingToggle = function(el) {
        var isCollapsed = el.classList.contains("collapsed");
        if (isCollapsed) {
          el.classList.remove("collapsed");
          el.classList.add("expanded");
          el.querySelector(".thinking-inline-preview").textContent = el.dataset.thinking || "";
          var action = el.querySelector(".thinking-inline-action");
          if (action) action.textContent = "收起";
        } else {
          el.classList.remove("expanded");
          el.classList.add("collapsed");
          var preview = (el.dataset.thinking || "").slice(0, 57) + ((el.dataset.thinking || "").length > 60 ? "…" : "");
          el.querySelector(".thinking-inline-preview").textContent = preview;
          var action = el.querySelector(".thinking-inline-action");
          if (action) action.textContent = "展开";
        }
      };
      // Toggle function for inline tool rows (Read, Glob, Grep, etc.)
      window.__inlineToolToggle = function(el) {
        var expanded = el.classList.toggle("inline-tool-open");
        var body = el.querySelector(".inline-tool-expanded");
        if (body) {
          body.style.display = expanded ? "block" : "none";
        }
        // Update status indicator
        var statusSpan = el.querySelector(".inline-tool-status");
        if (statusSpan) {
          if (el.dataset.status === "error") {
            statusSpan.textContent = "⚠️";
          } else if (el.dataset.status === "done") {
            statusSpan.textContent = expanded ? "✅" : "✅";
          }
        }
      };
      // Toggle function for terminal tool blocks
      window.__terminalExpand = function(el) {
        var body = el.querySelector(".term-body");
        if (body) {
          var isHidden = body.style.display === "none";
          body.style.display = isHidden ? "block" : "none";
          el.dataset.expanded = isHidden ? "true" : "false";
          var toggleIcon = el.querySelector(".term-toggle-icon");
          if (toggleIcon) toggleIcon.textContent = isHidden ? "▼" : "▲";
        }
      };
      // Update streaming thinking content (called from WebSocket handler)
      function updateStreamingThinking(text) {
        var el = document.querySelector(".thinking-streaming");
        if (el) {
          var textEl = el.querySelector(".thinking-streaming-text");
          if (textEl) {
            // Show last 3 lines in scrollable area
            var lines = text.split("\n");
            var displayLines = lines.slice(-3);
            textEl.textContent = displayLines.join("\n");
            // Auto-scroll to bottom
            textEl.scrollTop = textEl.scrollHeight;
          }
        }
      }
      // Global handler for ask-user option buttons — called via onclick
      window.__askOption = function(btnEl) {
        var optionLabel = btnEl.dataset.optionLabel;
        if (optionLabel && state.selectedId) {
          btnEl.classList.add("selected");
          var allOptions = document.querySelectorAll(".ask-user-option");
          allOptions.forEach(function(opt) {
            opt.classList.add("selected");
            opt.style.pointerEvents = "none";
          });
          var cardBody = btnEl.closest(".tool-use-card.ask-user");
          if (cardBody) {
            var sentDiv = document.createElement("div");
            sentDiv.className = "ask-user-answer-sent";
            sentDiv.innerHTML = "\\u2713 \\u5df2\\u53d1\\u9001: " + escapeHtml(optionLabel);
            cardBody.appendChild(sentDiv);
          }
          fetch("/api/sessions/" + state.selectedId + "/input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ input: optionLabel + "\\n", view: state.currentView })
          }).catch(function(err) {
            console.error("[wand] Error sending answer:", err);
          });
        }
      };
      function attachEventListeners() {

        var loginButton = document.getElementById("login-button");
        if (loginButton) {
          loginButton.addEventListener("click", login);
          var passwordEl = document.getElementById("password");
          var togglePasswordButton = document.getElementById("toggle-password-button");
          if (togglePasswordButton && passwordEl) {
            togglePasswordButton.addEventListener("click", function() {
              var visible = passwordEl.type === "text";
              passwordEl.type = visible ? "password" : "text";
              togglePasswordButton.textContent = visible ? "显示" : "隐藏";
              togglePasswordButton.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
              togglePasswordButton.setAttribute("aria-pressed", visible ? "false" : "true");
              passwordEl.focus();
            });
          }
          if (passwordEl) {
            passwordEl.addEventListener("keydown", function(e) {
              if (e.key === "Enter") login();
            });
            passwordEl.addEventListener("input", function() {
              passwordEl.dataset.error = "false";
              passwordEl.setAttribute("aria-invalid", "false");
              var errorEl = document.getElementById("login-error");
              if (errorEl) hideError(errorEl);
            });
            passwordEl.focus();
          }
          return;
        }

        // Welcome screen event listeners
        var welcomeInput = document.getElementById("welcome-input");
        if (welcomeInput) {
          welcomeInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              welcomeInputSend();
            }
          });
          welcomeInput.focus();
        }
        var welcomeSendBtn = document.getElementById("welcome-send-btn");
        if (welcomeSendBtn) {
          welcomeSendBtn.addEventListener("click", function() {
            welcomeInputSend();
          });
        }
        var welcomeClaudeBtn = document.getElementById("welcome-tool-claude");
        if (welcomeClaudeBtn) {
          welcomeClaudeBtn.addEventListener("click", function() {
            quickStartSession();
          });
        }
        initBlankChatCwd();

        var sessionsList = document.getElementById("sessions-list");
        if (sessionsList) {
          sessionsList.addEventListener("click", handleSessionItemClick);
          sessionsList.addEventListener("keydown", handleSessionItemKeydown);
          initSwipeToDelete(sessionsList);
        }

        // Claude session ID badge click-to-copy (event delegation on document)
        document.addEventListener("click", handleClaudeIdCopy);

        var modeCardsEl = document.getElementById("mode-cards");
        if (modeCardsEl) modeCardsEl.addEventListener("click", function(e) {
          var card = e.target.closest(".mode-card");
          if (!card) return;
          var mode = card.getAttribute("data-mode");
          if (mode) {
            state.modeValue = mode;
            syncSessionModalUI();
          }
        });
        var cwdEl = document.getElementById("cwd");
        if (cwdEl) {
          cwdEl.addEventListener("input", function() { state.cwdValue = this.value; });
          cwdEl.addEventListener("change", function() { state.cwdValue = this.value; });
          cwdEl.addEventListener("input", schedulePathSuggestions);
          cwdEl.addEventListener("focus", schedulePathSuggestions);
          cwdEl.addEventListener("blur", function() { setTimeout(hidePathSuggestions, 120); });
        }
        var sessionsToggle = document.getElementById("sessions-toggle-button");
        if (sessionsToggle) sessionsToggle.addEventListener("click", toggleSessionsDrawer);
        var drawerBackdrop = document.getElementById("sessions-drawer-backdrop");
        if (drawerBackdrop) drawerBackdrop.addEventListener("click", closeSessionsDrawer);
        var closeDrawerBtn = document.getElementById("close-drawer-button");
        if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeSessionsDrawer);
        var logoutBtn = document.getElementById("logout-button");
        if (logoutBtn) logoutBtn.addEventListener("click", logout);
        var settingsBtn = document.getElementById("settings-button");
        if (settingsBtn) settingsBtn.addEventListener("click", openSettingsModal);
        var closeSettingsBtn = document.getElementById("close-settings-button");
        if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", closeSettingsModal);
        var settingsModal = document.getElementById("settings-modal");
        if (settingsModal) settingsModal.addEventListener("click", function(e) {
          if (e.target.id === "settings-modal") closeSettingsModal();
        });
        var savePassBtn = document.getElementById("save-password-button");
        if (savePassBtn) savePassBtn.addEventListener("click", savePassword);
        // Settings tab clicks
        var settingsTabs = document.querySelectorAll(".settings-tab");
        for (var ti = 0; ti < settingsTabs.length; ti++) {
          settingsTabs[ti].addEventListener("click", function(e) {
            switchSettingsTab(e.target.getAttribute("data-tab"));
          });
        }
        var saveConfigBtn = document.getElementById("save-config-button");
        if (saveConfigBtn) saveConfigBtn.addEventListener("click", saveConfigSettings);
        var uploadCertBtn = document.getElementById("upload-cert-button");
        if (uploadCertBtn) uploadCertBtn.addEventListener("click", uploadCertificates);
        var checkUpdateBtn = document.getElementById("check-update-button");
        if (checkUpdateBtn) checkUpdateBtn.addEventListener("click", checkForUpdate);
        var doUpdateBtn = document.getElementById("do-update-button");
        if (doUpdateBtn) doUpdateBtn.addEventListener("click", performUpdate);
        // Notification test section
        var notifRequestBtn = document.getElementById("notification-request-btn");
        if (notifRequestBtn) notifRequestBtn.addEventListener("click", function() {
          if (typeof Notification !== "undefined") {
            Notification.requestPermission().then(function() { updateNotificationStatus(); });
          }
        });
        var notifTestBtn = document.getElementById("notification-test-btn");
        if (notifTestBtn) notifTestBtn.addEventListener("click", testNotification);
        updateNotificationStatus();
        var newSessBtn = document.getElementById("topbar-new-session-button");
        if (newSessBtn) newSessBtn.addEventListener("click", openSessionModal);
        var drawerNewSessBtn = document.getElementById("drawer-new-session-button");
        if (drawerNewSessBtn) drawerNewSessBtn.addEventListener("click", openSessionModal);
        var closeModalBtn = document.getElementById("close-modal-button");
        if (closeModalBtn) closeModalBtn.addEventListener("click", closeSessionModal);
        var runBtn = document.getElementById("run-button");
        if (runBtn) runBtn.addEventListener("click", runCommand);
        var approvePermissionBtn = document.getElementById("approve-permission-btn");
        if (approvePermissionBtn) approvePermissionBtn.addEventListener("click", approvePermission);
        var denyPermissionBtn = document.getElementById("deny-permission-btn");
        if (denyPermissionBtn) denyPermissionBtn.addEventListener("click", denyPermission);
        var sendBtn = document.getElementById("send-input-button");
        if (sendBtn) sendBtn.addEventListener("click", function() {
          closeSessionsDrawer();
          sendOrStart();
        });
        var stopBtn = document.getElementById("stop-button");
        if (stopBtn) stopBtn.addEventListener("click", stopSession);
        var modeSelect = document.getElementById("chat-mode-select");
        if (modeSelect) modeSelect.addEventListener("change", function() {
          state.chatMode = this.value;
          showToast("新会话模式已切换为：" + getModeLabel(this.value), "info");
        });

        var sessionModal = document.getElementById("session-modal");
        if (sessionModal) sessionModal.addEventListener("click", function(e) {
          if (e.target.id === "session-modal") closeSessionModal();
        });

        var inputBox = document.getElementById("input-box");
        if (inputBox) {
          bindInputTouchScroll(inputBox);
          inputBox.addEventListener("keydown", handleInputBoxKeydown);
          inputBox.addEventListener("paste", handleInputPaste);
          inputBox.addEventListener("input", function() {
            refreshInputBoxState(inputBox);
            setDraftValue(inputBox.value, true);
          });
          inputBox.addEventListener("focus", function() {
            // Close drawer when user focuses input to avoid backdrop blocking clicks
            closeSessionsDrawer();
            handleInputBoxFocus({ target: inputBox });
          });
          inputBox.addEventListener("blur", handleInputBoxBlur);
        }

        // View toggle handlers
        var viewTermBtn = document.getElementById("view-terminal-btn");
        if (viewTermBtn) viewTermBtn.addEventListener("click", function() { setView("terminal"); });
        // Terminal interactive toggle (both topbar and terminal-header)
        var terminalInteractiveToggles = ["terminal-interactive-toggle-top"];
        terminalInteractiveToggles.forEach(function(id) {
          var toggle = document.getElementById(id);
          if (toggle) toggle.addEventListener("click", toggleTerminalInteractive);
        });
        // Inline shortcuts click handler
        var inlineShortcutsWrap = document.querySelector(".inline-shortcuts-wrap");
        if (inlineShortcutsWrap) inlineShortcutsWrap.addEventListener("click", handleInlineKeyboardClick);
        var expandedShortcutsRow = document.querySelector(".inline-shortcuts-expanded-row");
        if (expandedShortcutsRow) expandedShortcutsRow.addEventListener("click", handleInlineKeyboardClick);
        // Shortcuts toggle (mobile fold/unfold)
        var shortcutsToggleBtn = document.querySelector(".shortcuts-toggle");
        if (shortcutsToggleBtn) shortcutsToggleBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          state.shortcutsExpanded = !state.shortcutsExpanded;
          var wrap = document.querySelector(".inline-shortcuts-wrap");
          var toggle = document.querySelector(".shortcuts-toggle");
          var row = document.querySelector(".inline-shortcuts-expanded-row");
          if (wrap) wrap.classList.toggle("expanded", state.shortcutsExpanded);
          if (row) row.classList.toggle("visible", state.shortcutsExpanded);
          if (toggle) {
            toggle.classList.toggle("active", state.shortcutsExpanded);
            toggle.textContent = state.shortcutsExpanded ? "\u203a" : "\u2039";
          }
        });
        // Close shortcuts strip on outside click
        document.addEventListener("click", function(e) {
          if (!state.shortcutsExpanded) return;
          var wrap = document.querySelector(".inline-shortcuts-wrap");
          var expandedRow = document.querySelector(".inline-shortcuts-expanded-row");
          var clickedInsideRow = expandedRow && expandedRow.contains(e.target);
          if (wrap && !wrap.contains(e.target) && !clickedInsideRow) {
            state.shortcutsExpanded = false;
            wrap.classList.remove("expanded");
            if (expandedRow) expandedRow.classList.remove("visible");
            var toggle = document.querySelector(".shortcuts-toggle");
            if (toggle) {
              toggle.classList.remove("active");
              toggle.textContent = "\u2039";
            }
          }
        });

        // PWA install button
        var pwaInstallBtn = document.getElementById("pwa-install-button");
        if (pwaInstallBtn) {
          pwaInstallBtn.addEventListener("click", function() {
            if (!state.deferredPrompt) return;
            state.deferredPrompt.prompt();
            state.deferredPrompt.userChoice.then(function() {
              state.deferredPrompt = null;
              state.showInstallPrompt = false;
              updateInstallPrompt();
            });
          });
        }

        // File panel toggle
        var filePanelToggle = document.getElementById("file-panel-toggle-btn");
        if (filePanelToggle) filePanelToggle.addEventListener("click", toggleFilePanel);
        var filePanelClose = document.getElementById("file-side-panel-close");
        if (filePanelClose) filePanelClose.addEventListener("click", closeFilePanel);

        // File panel backdrop click to close (mobile)
        var filePanelBackdrop = document.getElementById("file-panel-backdrop");
        if (filePanelBackdrop) filePanelBackdrop.addEventListener("click", closeFilePanel);

        // Terminal scale controls (topbar)
        var scaleDownBtn = document.getElementById("terminal-scale-down-top");
        var scaleUpBtn = document.getElementById("terminal-scale-up-top");
        if (scaleDownBtn) scaleDownBtn.addEventListener("click", function() { adjustTerminalScale(-0.25); });
        if (scaleUpBtn) scaleUpBtn.addEventListener("click", function() { adjustTerminalScale(0.25); });
        var pageRefreshBtn = document.getElementById("page-refresh-btn");
        if (pageRefreshBtn) pageRefreshBtn.addEventListener("click", function() { location.reload(); });
        var jumpBottomBtn = document.getElementById("terminal-jump-bottom");
        if (jumpBottomBtn) jumpBottomBtn.addEventListener("click", function() {
          maybeScrollTerminalToBottom("force");
        });

        // File explorer
        var fileRefresh = document.getElementById("file-explorer-refresh");
        if (fileRefresh) fileRefresh.addEventListener("click", refreshFileExplorer);

        // File search
        var fileSearchInput = document.getElementById("file-search-input");
        var fileSearchClear = document.getElementById("file-search-clear");
        if (fileSearchInput) {
          fileSearchInput.addEventListener("input", function(e) {
            state.fileSearchQuery = e.target.value.trim();
            if (fileSearchClear) {
              fileSearchClear.classList.toggle("visible", state.fileSearchQuery.length > 0);
            }
            filterFileTree();
          });
        }
        if (fileSearchClear) {
          fileSearchClear.addEventListener("click", function() {
            state.fileSearchQuery = "";
            if (fileSearchInput) {
              fileSearchInput.value = "";
            }
            fileSearchClear.classList.remove("visible");
          });
        }

        // Folder picker functionality with keyboard navigation
        var folderPickerInput = document.getElementById("folder-picker-input");
        var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
        var folderPickerDebounceTimer = null;
        var selectedIndex = -1;
        var folderItems = [];

        function saveWorkingDir(path) {
          state.workingDir = path;
          try {
            localStorage.setItem("wand-working-dir", path);
          } catch (e) {
            // Ignore localStorage errors
          }
          // Also add to recent paths (defined later, will be called after function is available)
          if (typeof addRecentPath === "function") {
            addRecentPath(path);
          }
        }

        // Helper functions for path validation feedback
        function showValidationError(message) {
          if (folderPickerInput) {
            folderPickerInput.classList.add("invalid");
          }
          var validationEl = document.getElementById("folder-picker-validation");
          if (validationEl) {
            validationEl.textContent = message;
            validationEl.classList.add("visible");
          }
        }

        function clearValidationError() {
          if (folderPickerInput) {
            folderPickerInput.classList.remove("invalid");
          }
          var validationEl = document.getElementById("folder-picker-validation");
          if (validationEl) {
            validationEl.textContent = "";
            validationEl.classList.remove("visible");
          }
        }

        // Helper functions for recent paths
        function getRecentPaths() {
          try {
            var saved = localStorage.getItem("wand-recent-paths");
            return saved ? JSON.parse(saved) : [];
          } catch (e) {
            return [];
          }
        }

        function addRecentPath(path) {
          var recent = getRecentPaths();
          // Remove if already exists
          recent = recent.filter(function(p) { return p !== path; });
          // Add to front
          recent.unshift(path);
          // Keep only last 5
          recent = recent.slice(0, 5);
          try {
            localStorage.setItem("wand-recent-paths", JSON.stringify(recent));
          } catch (e) {
            // Ignore localStorage errors
          }
        }

        function renderRecentPaths() {
          var recent = getRecentPaths();
          if (recent.length === 0) return "";

          var html = '<div class="folder-recent-section">' +
            '<div class="folder-recent-title">最近使用</div>';

          recent.forEach(function(path) {
            html += '<div class="folder-recent-item" data-path="' + escapeHtml(path) + '">' +
              '<span class="folder-recent-item-icon">📁</span>' +
              '<span class="folder-recent-item-path">' + escapeHtml(path) + '</span>' +
            '</div>';
          });

          html += '</div>';
          return html;
        }

        function showRecentPathsDropdown() {
          if (!folderPickerDropdown) return;
          var recentHtml = renderRecentPaths();
          if (recentHtml) {
            folderPickerDropdown.innerHTML = recentHtml;
            folderPickerDropdown.classList.remove("hidden");
            // Add click handlers for recent paths
            folderPickerDropdown.querySelectorAll(".folder-recent-item").forEach(function(item) {
              item.addEventListener("click", function() {
                var path = this.dataset.path;
                if (folderPickerInput) {
                  folderPickerInput.value = path;
                  saveWorkingDir(path);
                  loadFolderSuggestions(path);
                }
              });
            });
          } else {
            hideFolderDropdown();
          }
        }

        // Working directory indicator click handler for active sessions
        var workingDirIndicator = document.getElementById("working-dir-indicator");
        if (workingDirIndicator) {
          workingDirIndicator.addEventListener("click", function() {
            // 点击指示器时，取消当前会话选择，显示完整的目录选择器
            state.selectedId = null;
            persistSelectedId();
            state.drafts = {};
            renderApp();
            // 聚焦到目录输入框
            setTimeout(function() {
              var folderInput = document.getElementById("folder-picker-input");
              if (folderInput) folderInput.focus();
            }, 50);
          });
        }

        // Compact folder picker toggle
        var folderPickerToggle = document.getElementById("folder-picker-toggle");
        var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
        if (folderPickerToggle && folderPickerDropdown) {
          folderPickerToggle.addEventListener("click", function() {
            folderPickerDropdown.classList.toggle("hidden");
            folderPickerToggle.classList.toggle("open");
          });
        }


        // Drag and drop support
        var folderPickerContainer = document.querySelector(".folder-picker-compact");
        if (folderPickerContainer) {
          folderPickerContainer.addEventListener("dragover", function(e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.add("drag-over");
          });

          folderPickerContainer.addEventListener("dragleave", function(e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("drag-over");
          });

          folderPickerContainer.addEventListener("drop", function(e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("drag-over");

            var items = e.dataTransfer && e.dataTransfer.items;
            if (items) {
              for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item.kind === "file" && item.webkitGetAsEntry) {
                  var entry = item.webkitGetAsEntry();
                  if (entry && entry.isDirectory && folderPickerInput) {
                    var path = entry.fullPath;
                    folderPickerInput.value = path;
                    saveWorkingDir(path);
                    addRecentPath(path);
                    loadFolderSuggestions(path);
                    break;
                  }
                }
              }
            }
          });
        }

        // Quick path buttons (now inside dropdown)
        if (folderPickerDropdown) {
          folderPickerDropdown.addEventListener("click", function(e) {
            var btn = e.target.closest(".folder-picker-quick-btn");
            if (btn && folderPickerInput) {
              var path = btn.dataset.path;
              folderPickerInput.value = path;
              saveWorkingDir(path);
              loadFolderSuggestions(path);
              folderPickerDropdown.classList.add("hidden");
              var toggle = document.getElementById("folder-picker-toggle");
              if (toggle) toggle.classList.remove("open");
            }
          });
        }

        if (folderPickerInput) {
          // Load initial folders from saved or default path
          var initialPath = getEffectiveCwd();
          loadFolderSuggestions(initialPath);

          folderPickerInput.addEventListener("focus", function() {
            var path = this.value.trim();
            if (path) {
              loadFolderSuggestions(path);
            } else {
              // Show recent paths when input is empty
              showRecentPathsDropdown();
            }
          });

          folderPickerInput.addEventListener("input", function(e) {
            var query = e.target.value.trim();
            selectedIndex = -1;
            if (folderPickerDebounceTimer) clearTimeout(folderPickerDebounceTimer);
            folderPickerDebounceTimer = setTimeout(function() {
              if (query) {
                loadFolderSuggestions(query);
              } else {
                hideFolderDropdown();
              }
            }, 150);
          });

          // Keyboard navigation
          folderPickerInput.addEventListener("keydown", function(e) {
            if (e.key === "Escape") {
              hideFolderDropdown();
              this.blur();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (folderItems.length > 0) {
                selectedIndex = Math.min(selectedIndex + 1, folderItems.length - 1);
                updateSelectedIndex();
              }
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (selectedIndex > 0) {
                selectedIndex--;
                updateSelectedIndex();
              }
            } else if (e.key === "Enter" && selectedIndex >= 0) {
              e.preventDefault();
              var selectedItem = folderItems[selectedIndex];
              if (selectedItem) {
                var selectedPath = selectedItem.dataset.path;
                if (selectedPath === "..") {
                  // Navigate to parent
                  var currentPath = folderPickerInput.value.trim();
                  var parentPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
                  if (parentPath) {
                    folderPickerInput.value = parentPath || "/";
                    saveWorkingDir(folderPickerInput.value);
                    loadFolderSuggestions(parentPath || "/");
                  }
                } else {
                  folderPickerInput.value = selectedPath;
                  saveWorkingDir(selectedPath);
                  hideFolderDropdown();
                }
              }
            }
          });

          // Close dropdown when clicking outside
          document.addEventListener("click", function(e) {
            if (!e.target.closest(".folder-picker-container")) {
              hideFolderDropdown();
            }
          });
        }

        function updateSelectedIndex() {
          folderItems.forEach(function(item, index) {
            item.classList.toggle("active", index === selectedIndex);
          });
        }

        function loadFolderSuggestions(query) {
          if (!folderPickerDropdown) return;

          // Show loading state
          folderPickerDropdown.innerHTML = '<div class="folder-picker-loading">加载中...</div>';
          folderPickerDropdown.classList.remove("hidden");
          selectedIndex = -1;
          folderItems = [];

          fetch("/api/folders?q=" + encodeURIComponent(query), { credentials: "same-origin" })
            .then(function(res) {
              return res.json().then(function(data) {
                return { ok: res.ok, status: res.status, data: data };
              });
            })
            .then(function(result) {
              var data = result.data;

              // Handle error responses
              if (!result.ok || data.error) {
                showValidationError(data.error || "路径无效");
                folderPickerDropdown.innerHTML = '<div class="folder-picker-error">' + escapeHtml(data.error || "路径无效") + '</div>';
                return;
              }

              // Clear validation error on success
              clearValidationError();

              // Update breadcrumb navigation
              renderBreadcrumb(data.currentPath || query);

              var items = data.items || [];
              var currentPath = data.currentPath || query;

              if (items.length === 0) {
                folderPickerDropdown.innerHTML = '<div class="folder-picker-loading">空目录</div>';
                return;
              }

              folderPickerDropdown.innerHTML = items.map(function(item) {
                var icon = item.type === "parent" ? "↩️" : "📁";
                var name = item.type === "parent" ? ".. (返回上级)" : item.name;
                return '<div class="folder-picker-item" data-path="' + escapeHtml(item.path) + '" data-type="' + item.type + '">' +
                  '<span class="folder-picker-item-icon">' + icon + '</span>' +
                  '<span>' + escapeHtml(name) + '</span>' +
                '</div>';
              }).join("");

              folderItems = Array.from(folderPickerDropdown.querySelectorAll(".folder-picker-item"));

              // Add click handlers
              folderItems.forEach(function(item) {
                item.addEventListener("click", function() {
                  var selectedPath = this.dataset.path;
                  var type = this.dataset.type;
                  if (folderPickerInput) {
                    if (type === "parent") {
                      // Navigate to parent directory
                      var currentPath = folderPickerInput.value.trim();
                      var parentPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
                      folderPickerInput.value = parentPath || "/";
                      saveWorkingDir(folderPickerInput.value);
                      loadFolderSuggestions(parentPath || "/");
                    } else {
                      folderPickerInput.value = selectedPath;
                      saveWorkingDir(selectedPath);
                      clearValidationError();
                      hideFolderDropdown();
                    }
                  }
                });
              });
            })
            .catch(function(err) {
              showValidationError("加载失败");
              folderPickerDropdown.innerHTML = '<div class="folder-picker-error">加载失败</div>';
            });
        }

        function hideFolderDropdown() {
          if (folderPickerDropdown) {
            folderPickerDropdown.classList.add("hidden");
          }
          selectedIndex = -1;
          folderItems = [];
        }

        // Folder picker modal functionality
        var folderPickerModal = document.getElementById("folder-picker-modal");
        var closeFolderPicker = document.getElementById("close-folder-picker");

        function openFolderPickerWithInitialPath() {
          if (!folderPickerModal) return;
          folderPickerModal.classList.remove("hidden");
          // Set initial path in input
          if (folderPickerInput) {
            folderPickerInput.value = getEffectiveCwd();
          }
          // Load initial folders
          var initialPath = getEffectiveCwd();
          loadFolderSuggestions(initialPath);
          renderBreadcrumb(initialPath);
        }

        if (closeFolderPicker && folderPickerModal) {
          closeFolderPicker.addEventListener("click", function() {
            folderPickerModal.classList.add("hidden");
          });
        }

        if (folderPickerModal) {
          folderPickerModal.addEventListener("click", function(e) {
            if (e.target === folderPickerModal) {
              folderPickerModal.classList.add("hidden");
            }
          });
        }

        initTerminal();
        setupMobileKeyboardHandlers();
        setupVisualViewportHandlers();
      }

      function activateSessionItem(sessionId) {
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
        if (session && session.status !== "running") {
          resumeSessionFromList(sessionId);
        } else {
          selectSession(sessionId);
        }
        closeSessionsDrawer();
      }

      function handleSessionItemClick(event) {
        var target = event.target;
        if (!target || !(target instanceof Element)) return;

        var historyToggle = target.closest("#claude-history-toggle");
        if (historyToggle) {
          event.preventDefault();
          event.stopPropagation();
          state.claudeHistoryExpanded = !state.claudeHistoryExpanded;
          if (state.claudeHistoryExpanded && !state.claudeHistoryLoaded) {
            loadClaudeHistory();
          }
          updateSessionsList();
          return;
        }

        var actionButton = target.closest("[data-action]");
        if (actionButton && actionButton instanceof HTMLElement) {
          event.preventDefault();
          event.stopPropagation();
          if (actionButton.dataset.action === "toggle-manage-mode") {
            toggleManageMode();
          } else if (actionButton.dataset.action === "select-all-visible") {
            selectAllVisibleItems();
          } else if (actionButton.dataset.action === "clear-selection") {
            clearSelections();
          } else if (actionButton.dataset.action === "delete-selected") {
            batchDeleteSelected();
          } else if (actionButton.dataset.action === "toggle-selection") {
            toggleManagedItemSelection(actionButton.dataset.kind, actionButton.dataset.id);
          } else if (actionButton.dataset.action === "delete-session" && actionButton.dataset.sessionId) {
            if (confirmDelete("确认删除这个会话吗？")) {
              deleteSession(actionButton.dataset.sessionId);
            }
          } else if (actionButton.dataset.action === "delete-history" && actionButton.dataset.claudeSessionId) {
            if (confirmDelete("确认隐藏这条 Claude 历史吗？")) {
              executeDeleteHistory(actionButton.dataset.claudeSessionId, actionButton.closest(".session-item"));
            }
          } else if (actionButton.dataset.action === "toggle-history-directory" && actionButton.dataset.cwd) {
            var dirCwd = actionButton.dataset.cwd;
            state.claudeHistoryExpandedDirs[dirCwd] = !state.claudeHistoryExpandedDirs[dirCwd];
            updateSessionsList();
          } else if (actionButton.dataset.action === "delete-history-directory" && actionButton.dataset.cwd) {
            var deleteCwd = actionButton.dataset.cwd;
            var items = getHistoryItemsByCwd(deleteCwd);
            var dirCount = getVisibleClaudeHistorySessions().filter(function(s) { return s.cwd === deleteCwd; }).length;
            if (confirmDelete("确认清空此目录下的 " + dirCount + " 条 Claude 历史吗？")) {
              setDeletingState(items, true);
              deleteClaudeHistoryDirectory(deleteCwd, actionButton, items);
            }
          } else if (actionButton.dataset.action === "clear-all-history") {
            clearAllClaudeHistory();
          } else if (actionButton.dataset.action === "resume" && actionButton.dataset.sessionId) {
            handleResumeAction(actionButton);
          } else if (actionButton.dataset.action === "resume-history" && actionButton.dataset.claudeSessionId) {
            handleResumeHistoryAction(actionButton);
          }
          return;
        }

        var item = target.closest(".session-item");
        if (item) {
          if (state.sessionsManageMode) {
            if (item.dataset.sessionId) {
              toggleManagedItemSelection("sessions", item.dataset.sessionId);
            } else if (item.dataset.claudeHistoryId) {
              toggleManagedItemSelection("history", item.dataset.claudeHistoryId);
            }
            return;
          }
          if (item.classList.contains("swiped")) {
            closeSwipedItem();
            return;
          }
          if (_swipeState) return;
          if (item.dataset.sessionId) {
            activateSessionItem(item.dataset.sessionId);
          } else if (item.dataset.claudeHistoryId) {
            var claudeSessionId = item.dataset.claudeHistoryId;
            var cwd = item.dataset.cwd;
            resumeClaudeHistorySession(claudeSessionId, cwd)
              .then(function(data) {
                if (data && data.id) {
                  state.selectedId = data.id;
                  persistSelectedId();
                  state.drafts[data.id] = "";
                  loadSessions().then(function() {
                    selectSession(data.id);
                    closeSessionsDrawer();
                  });
                }
              });
          }
        }
      }

      function handleSessionItemKeydown(event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        var item = event.target.closest(".session-item");
        if (!item) return;
        event.preventDefault();
        if (state.sessionsManageMode) {
          if (item.dataset.sessionId) {
            toggleManagedItemSelection("sessions", item.dataset.sessionId);
          } else if (item.dataset.claudeHistoryId) {
            toggleManagedItemSelection("history", item.dataset.claudeHistoryId);
          }
          return;
        }
        if (item.dataset.sessionId) {
          activateSessionItem(item.dataset.sessionId);
        } else if (item.dataset.claudeHistoryId) {
          var claudeSessionId = item.dataset.claudeHistoryId;
          var cwd = item.dataset.cwd;
          resumeClaudeHistorySession(claudeSessionId, cwd)
            .then(function(data) {
              if (data && data.id) {
                state.selectedId = data.id;
                persistSelectedId();
                state.drafts[data.id] = "";
                loadSessions().then(function() {
                  selectSession(data.id);
                  closeSessionsDrawer();
                });
              }
            });
        }
      }

      /** Copy Claude session ID from badge to clipboard */
      function handleClaudeIdCopy(event) {
        var badge = event.target.closest("#claude-session-id-badge");
        if (!badge) return;
        var fullId = badge.dataset.claudeId;
        if (!fullId) return;
        navigator.clipboard.writeText(fullId).then(function() {
          var original = badge.textContent;
          badge.textContent = "\u2713 已复制";
          badge.classList.add("copied");
          setTimeout(function() {
            badge.textContent = original;
            badge.classList.remove("copied");
          }, 1200);
        }).catch(function() {
          showToast("复制失败", "error");
        });
      }

      function getTerminalViewport() {
        if (!state.terminal || !state.terminal.element) return null;
        if (state.terminalViewportEl && state.terminal.element.contains(state.terminalViewportEl)) {
          return state.terminalViewportEl;
        }
        state.terminalViewportEl = state.terminal.element.querySelector(".xterm-viewport");
        return state.terminalViewportEl;
      }

      function clearTerminalScrollIdleTimer() {
        if (state.terminalScrollIdleTimer) {
          clearTimeout(state.terminalScrollIdleTimer);
          state.terminalScrollIdleTimer = null;
        }
      }

      function updateTerminalJumpToBottomButton() {
        var button = document.getElementById("terminal-jump-bottom");
        var shouldShow = !!state.selectedId
          && state.currentView === "terminal"
          && !state.terminalAutoFollow
          && !isTerminalNearBottom();
        state.showTerminalJumpToBottom = shouldShow;
        if (button) {
          button.classList.toggle("visible", shouldShow);
        }
      }

      function isTerminalNearBottom() {
        // On mobile, check DOM view scroll position
        if (state.terminalDomView) {
          var d = state.terminalDomView.scrollHeight - state.terminalDomView.clientHeight - state.terminalDomView.scrollTop;
          return d <= state.terminalScrollThreshold;
        }
        var viewport = getTerminalViewport();
        if (!viewport) return true;
        var distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        return distance <= state.terminalScrollThreshold;
      }

      function scrollTerminalToBottom(smooth) {
        if (!state.terminal) return;
        // Also scroll mobile DOM view
        if (state.terminalDomView) {
          if (smooth) {
            state.terminalDomView.scrollTo({ top: state.terminalDomView.scrollHeight, behavior: "smooth" });
          } else {
            state.terminalDomView.scrollTop = state.terminalDomView.scrollHeight;
          }
        }
        if (smooth) {
          var viewport = getTerminalViewport();
          if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
            setTimeout(function() {
              if (state.terminal) state.terminal.scrollToBottom();
            }, 160);
            return;
          }
        }
        state.terminal.scrollToBottom();
      }

      function scheduleTerminalResumeFollow() {
        clearTerminalScrollIdleTimer();
        updateTerminalJumpToBottomButton();
        state.terminalScrollIdleTimer = setTimeout(function() {
          state.terminalScrollIdleTimer = null;
          state.terminalAutoFollow = true;
          if (!isTerminalNearBottom()) {
            scrollTerminalToBottom(true);
          }
          updateTerminalJumpToBottomButton();
        }, state.terminalScrollIdleMs);
      }

      function setTerminalManualScrollActive() {
        state.terminalAutoFollow = false;
        updateTerminalJumpToBottomButton();
        scheduleTerminalResumeFollow();
      }

      function maybeScrollTerminalToBottom(reason) {
        if (!state.terminal) return;
        var force = reason === "force";
        if (force) {
          state.terminalAutoFollow = true;
          clearTerminalScrollIdleTimer();
          scrollTerminalToBottom(false);
          updateTerminalJumpToBottomButton();
          return;
        }
        if (!state.terminalAutoFollow && !isTerminalNearBottom()) {
          updateTerminalJumpToBottomButton();
          return;
        }
        state.terminalAutoFollow = true;
        scrollTerminalToBottom(false);
        updateTerminalJumpToBottomButton();
      }

      // ===== Custom terminal scrollbar =====
      function initTerminalScrollbar(container) {
        var scrollbar = document.createElement("div");
        scrollbar.className = "terminal-scrollbar";
        var track = document.createElement("div");
        track.className = "terminal-scrollbar-track";
        var thumb = document.createElement("div");
        thumb.className = "terminal-scrollbar-thumb";
        track.appendChild(thumb);
        scrollbar.appendChild(track);
        container.appendChild(scrollbar);

        state.terminalScrollbarEl = scrollbar;
        state.terminalScrollbarThumbEl = thumb;
        state.terminalScrollbarHideTimer = null;
        state.terminalScrollbarDragging = false;
        state.terminalScrollbarRafPending = false;

        // Show/hide logic
        function showScrollbar() {
          if (state.terminalScrollbarHideTimer) {
            clearTimeout(state.terminalScrollbarHideTimer);
            state.terminalScrollbarHideTimer = null;
          }
          scrollbar.classList.add("visible");
        }

        function scheduleHideScrollbar() {
          if (state.terminalScrollbarDragging) return;
          if (state.terminalScrollbarHideTimer) clearTimeout(state.terminalScrollbarHideTimer);
          state.terminalScrollbarHideTimer = setTimeout(function() {
            state.terminalScrollbarHideTimer = null;
            if (!state.terminalScrollbarDragging) {
              scrollbar.classList.remove("visible");
            }
          }, 1500);
        }

        // Sync thumb position/size from viewport
        function syncScrollbarThumb() {
          state.terminalScrollbarRafPending = false;
          var viewport = getTerminalViewport();
          if (!viewport) return;
          var sh = viewport.scrollHeight;
          var ch = viewport.clientHeight;
          if (sh <= ch) {
            scrollbar.classList.remove("visible");
            return;
          }
          var trackH = track.clientHeight;
          var thumbH = Math.max(28, (ch / sh) * trackH);
          var maxScroll = sh - ch;
          var scrollRatio = viewport.scrollTop / maxScroll;
          var thumbTop = scrollRatio * (trackH - thumbH);
          thumb.style.height = thumbH + "px";
          thumb.style.top = thumbTop + "px";
        }

        function requestSyncScrollbar() {
          if (state.terminalScrollbarRafPending) return;
          state.terminalScrollbarRafPending = true;
          requestAnimationFrame(syncScrollbarThumb);
        }

        // Listen to viewport scroll
        var viewport = getTerminalViewport();
        if (viewport) {
          viewport.addEventListener("scroll", function() {
            showScrollbar();
            requestSyncScrollbar();
            scheduleHideScrollbar();
          }, { passive: true });
        }

        // Track click → jump to position
        track.addEventListener("mousedown", function(e) {
          if (e.target === thumb) return;
          e.preventDefault();
          var viewport = getTerminalViewport();
          if (!viewport) return;
          var rect = track.getBoundingClientRect();
          var clickRatio = (e.clientY - rect.top) / rect.height;
          var maxScroll = viewport.scrollHeight - viewport.clientHeight;
          viewport.scrollTop = clickRatio * maxScroll;
        });

        // Thumb drag — mouse
        var dragStartY = 0;
        var dragStartScrollTop = 0;

        thumb.addEventListener("mousedown", function(e) {
          e.preventDefault();
          e.stopPropagation();
          state.terminalScrollbarDragging = true;
          thumb.classList.add("dragging");
          dragStartY = e.clientY;
          var viewport = getTerminalViewport();
          dragStartScrollTop = viewport ? viewport.scrollTop : 0;
          document.addEventListener("mousemove", onDragMove);
          document.addEventListener("mouseup", onDragEnd);
        });

        function onDragMove(e) {
          e.preventDefault();
          var viewport = getTerminalViewport();
          if (!viewport) return;
          var trackH = track.clientHeight;
          var sh = viewport.scrollHeight;
          var ch = viewport.clientHeight;
          var maxScroll = sh - ch;
          if (maxScroll <= 0) return;
          var thumbH = Math.max(28, (ch / sh) * trackH);
          var scrollableTrack = trackH - thumbH;
          if (scrollableTrack <= 0) return;
          var deltaY = e.clientY - dragStartY;
          var scrollDelta = (deltaY / scrollableTrack) * maxScroll;
          viewport.scrollTop = dragStartScrollTop + scrollDelta;
        }

        function onDragEnd() {
          state.terminalScrollbarDragging = false;
          thumb.classList.remove("dragging");
          document.removeEventListener("mousemove", onDragMove);
          document.removeEventListener("mouseup", onDragEnd);
          scheduleHideScrollbar();
        }

        // Thumb drag — touch
        thumb.addEventListener("touchstart", function(e) {
          if (e.touches.length !== 1) return;
          e.stopPropagation();
          state.terminalScrollbarDragging = true;
          thumb.classList.add("dragging");
          dragStartY = e.touches[0].clientY;
          var viewport = getTerminalViewport();
          dragStartScrollTop = viewport ? viewport.scrollTop : 0;
          document.addEventListener("touchmove", onTouchDragMove, { passive: false });
          document.addEventListener("touchend", onTouchDragEnd);
          document.addEventListener("touchcancel", onTouchDragEnd);
        }, { passive: false });

        function onTouchDragMove(e) {
          if (e.touches.length !== 1) return;
          e.preventDefault();
          var viewport = getTerminalViewport();
          if (!viewport) return;
          var trackH = track.clientHeight;
          var sh = viewport.scrollHeight;
          var ch = viewport.clientHeight;
          var maxScroll = sh - ch;
          if (maxScroll <= 0) return;
          var thumbH = Math.max(28, (ch / sh) * trackH);
          var scrollableTrack = trackH - thumbH;
          if (scrollableTrack <= 0) return;
          var deltaY = e.touches[0].clientY - dragStartY;
          var scrollDelta = (deltaY / scrollableTrack) * maxScroll;
          viewport.scrollTop = dragStartScrollTop + scrollDelta;
        }

        function onTouchDragEnd() {
          state.terminalScrollbarDragging = false;
          thumb.classList.remove("dragging");
          document.removeEventListener("touchmove", onTouchDragMove);
          document.removeEventListener("touchend", onTouchDragEnd);
          document.removeEventListener("touchcancel", onTouchDragEnd);
          scheduleHideScrollbar();
        }

        // Hover on scrollbar area shows it
        scrollbar.addEventListener("mouseenter", function() {
          showScrollbar();
        });
        scrollbar.addEventListener("mouseleave", function() {
          if (!state.terminalScrollbarDragging) scheduleHideScrollbar();
        });

        // Initial sync
        requestSyncScrollbar();
      }

      function syncTerminalBuffer(sessionId, output, options) {
        if (!state.terminal) return false;
        var normalizedOutput = normalizeTerminalOutput(output || "");
        var nextSessionId = sessionId || null;
        var opts = options || {};
        var mode = opts.mode || "append";
        var shouldScroll = opts.scroll !== false;
        var sessionChanged = state.terminalSessionId !== nextSessionId;
        var currentOutput = state.terminalOutput || "";
        var wrote = false;

        if (normalizedOutput === currentOutput && !sessionChanged) {
          if (shouldScroll) maybeScrollTerminalToBottom("output");
          updateTerminalJumpToBottomButton();
          return false;
        }

        if (sessionChanged) {
          state.terminal.reset();
          currentOutput = "";
          state.terminalOutput = "";
          state.terminalAutoFollow = true;
          clearTerminalScrollIdleTimer();
          updateTerminalJumpToBottomButton();
        }

        if (mode === "replace") {
          if (normalizedOutput !== currentOutput) {
            state.terminal.reset();
            if (normalizedOutput) {
              state.terminal.write(normalizedOutput);
            }
            wrote = true;
          }
        } else if (normalizedOutput.length < currentOutput.length && !sessionChanged) {
          // Ignore regressive snapshots for the active session; wait for an explicit replace.
          return false;
        } else if (normalizedOutput.startsWith(currentOutput)) {
          var delta = normalizedOutput.slice(currentOutput.length);
          if (delta) {
            state.terminal.write(delta);
            wrote = true;
          }
        } else if (currentOutput && currentOutput.startsWith(normalizedOutput)) {
          // Ignore shorter/stale snapshots from polling or reconnect races.
          return false;
        } else {
          state.terminal.reset();
          if (normalizedOutput) {
            state.terminal.write(normalizedOutput);
          }
          wrote = true;
        }

        state.terminalSessionId = nextSessionId;
        state.terminalOutput = normalizedOutput;
        scheduleMobileDomUpdate();
        if (shouldScroll && (wrote || sessionChanged || mode === "replace")) {
          maybeScrollTerminalToBottom(sessionChanged || mode === "replace" ? "force" : "output");
        } else {
          updateTerminalJumpToBottomButton();
        }
        return wrote || sessionChanged;
      }

      function shouldResizeTerminalViewport() {
        var output = document.getElementById("output");
        if (!output) return false;
        var rect = output.getBoundingClientRect();
        var width = Math.round(rect.width);
        var height = Math.round(rect.height);
        if (!width || !height) return false;
        if (state.terminalViewportSize.width === width && state.terminalViewportSize.height === height) {
          return false;
        }
        state.terminalViewportSize = { width: width, height: height };
        return true;
      }

      function initTerminal() {
        var container = document.getElementById("output");
        if (!container || state.terminal) return;
        if (typeof Terminal === "undefined") {
          // xterm.js not yet loaded — retry after a short delay
          if (!state.terminalInitRetries) state.terminalInitRetries = 0;
          if (state.terminalInitRetries < 10) {
            state.terminalInitRetries++;
            setTimeout(initTerminal, 200);
          }
          return;
        }
        state.terminalInitRetries = 0;

        state.terminal = new Terminal({
          cols: 120,
          rows: 36,
          convertEol: true,
          disableStdin: false,
          cursorBlink: false,
          fontFamily: '"Geist Mono", "SF Mono", monospace',
          fontSize: 13,
          lineHeight: 1.5,
          allowProposedApi: true,
          scrollback: 10000,
          wheelScrollMargin: 0,
          theme: {
            background: "#1f1b17",
            foreground: "#f5eadc",
            cursor: "#d67b52",
            selectionBackground: "rgba(214, 123, 82, 0.28)",
            black: "#1f1b17",
            red: "#d27766",
            green: "#7fa36f",
            yellow: "#d5a35b",
            blue: "#87a9d9",
            magenta: "#c595c7",
            cyan: "#7fb3b1",
            white: "#f5eadc",
            brightBlack: "#625347",
            brightRed: "#e39a89",
            brightGreen: "#9cc08a",
            brightYellow: "#ebbb6e",
            brightBlue: "#a8c1ea",
            brightMagenta: "#dbb1dc",
            brightCyan: "#9acbca",
            brightWhite: "#fff7ef"
          }
        });

        var fitAddonConstructor =
          typeof FitAddon !== "undefined" && FitAddon && typeof FitAddon.FitAddon === "function"
            ? FitAddon.FitAddon
            : null;
        state.fitAddon = fitAddonConstructor ? new fitAddonConstructor() : null;
        if (state.fitAddon) {
          state.terminal.loadAddon(state.fitAddon);
        } else {
          console.error("[wand] xterm fit addon failed to load; continuing without fit support.");
        }

        // Load serialize addon for mobile DOM rendering
        if (typeof SerializeAddon !== "undefined" && SerializeAddon && typeof SerializeAddon.SerializeAddon === "function") {
          state.serializeAddon = new SerializeAddon.SerializeAddon();
          state.terminal.loadAddon(state.serializeAddon);
        }

        state.terminal.open(container);
        applyTerminalScale();
        state.terminalViewportSize = { width: 0, height: 0 };
        state.terminalAutoFollow = true;
        clearTerminalScrollIdleTimer();
        // Retry-based fit: wait for browser to complete layout before measuring and fitting
        if (state.fitAddon) {
          ensureTerminalFit();
        }

        var viewport = getTerminalViewport();
        if (viewport) {
          state.terminalViewportScrollHandler = function() {
            if (isTerminalNearBottom()) {
              state.terminalAutoFollow = true;
              clearTerminalScrollIdleTimer();
              updateTerminalJumpToBottomButton();
              return;
            }
            setTerminalManualScrollActive();
          };
          state.terminalViewportTouchHandler = function() {
            setTerminalManualScrollActive();
          };
          viewport.addEventListener("scroll", state.terminalViewportScrollHandler, { passive: true });
          viewport.addEventListener("touchmove", state.terminalViewportTouchHandler, { passive: true });
        }

        container.addEventListener('wheel', function(e) {
          if (!isTerminalNearBottom() || e.deltaY < 0) {
            setTerminalManualScrollActive();
          }
          e.stopPropagation();
        }, { passive: true });

        // Create custom scrollbar overlay
        initTerminalScrollbar(container);

        // Terminal copy button for mobile
        initMobileDomTerminal(container);

        if (state.selectedId) {
          var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (session) {
            syncTerminalBuffer(session.id, session.output || "", { mode: "replace", scroll: false });
          }
        } else {
          state.terminal.writeln("点击上方「新对话」开始你的第一次对话。");
        }

        state.terminal.onData(function(data) {
          if (state.terminalInteractive) return;
          queueDirectInput(data);
        });

        container.addEventListener("click", focusInputBox);
        updateTerminalJumpToBottomButton();

        // 初始化拖动调整大小
        initTerminalResizeHandle();

        observeTerminalResize();
      }

      function login() {
        if (state.loginPending) return;

        var passwordEl = document.getElementById("password");
        var loginButton = document.getElementById("login-button");
        var errorEl = document.getElementById("login-error");
        if (!passwordEl || !loginButton || !errorEl) return;

        hideError(errorEl);
        passwordEl.dataset.error = "false";
        passwordEl.setAttribute("aria-invalid", "false");
        state.loginPending = true;
        loginButton.disabled = true;
        loginButton.textContent = "登录中...";

        fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: passwordEl.value }),
          credentials: "same-origin"
        })
        .then(function(res) {
          if (!res.ok) {
            passwordEl.dataset.error = "true";
            passwordEl.setAttribute("aria-invalid", "true");
            showError(errorEl, "密码错误，请重试。");
            return Promise.reject("Invalid password");
          }
          return fetch("/api/config", { credentials: "same-origin" });
        })
        .then(function(res) { return res.json(); })
        .then(function(config) {
          state.config = config;
          var statusDot = document.getElementById("status-dot");
          var statusText = document.getElementById("status-text");
          if (statusDot) statusDot.classList.add("active");
          if (statusText) statusText.textContent = "已登录";
          return refreshAll();
        })
        .then(function() {
          startPolling();
          render();
        })
        .catch(function(error) {
          console.error("[wand] Login error:", error);
          if (error !== "Invalid password") {
            passwordEl.dataset.error = "true";
            passwordEl.setAttribute("aria-invalid", "true");
            showError(errorEl, "登录失败，请重试。");
          }
        })
        .finally(function() {
          state.loginPending = false;
          loginButton.disabled = false;
          loginButton.textContent = "进入控制台";
        });
      }

      function logout() {
        fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(function() {});
        stopPolling();
        setTerminalInteractive(false);
        hideMiniKeyboard();
        teardownTerminal();
        state.config = null;
        state.selectedId = null;
        persistSelectedId();
        state.sessions = [];
        state.claudeHistory = [];
        state.claudeHistoryLoaded = false;
        state.claudeHistoryExpanded = true;
        state.claudeHistoryExpandedDirs = {};
        state.sessionsDrawerOpen = false;
        render();
      }

      function refreshAll() {
        return loadSessions();
      }

      function getModeLabel(mode) {
        return mode === "full-access"
          ? "全权限"
          : mode === "default"
            ? "默认"
            : mode === "native"
              ? "原生"
              : mode === "auto-edit"
                ? "自动编辑"
                : mode === "managed"
                  ? "托管"
                  : mode;
      }

      function getPreferredTool() {
        return "claude";
      }

      function getComposerTool() {
        return "claude";
      }

      function getToolModeHint(tool, mode) {
        if (mode === "full-access") {
          return "自动确认权限请求与高权限操作，适合你确认环境安全后的连续修改。";
        }
        if (mode === "auto-edit") {
          return "保留交互式会话，同时更偏向直接编辑代码。";
        }
        if (mode === "native") {
          return "按单轮消息调用 Claude 原生输出，适合快速问答或一次性生成。";
        }
        if (mode === "managed") {
          return "AI 自动完成所有工作，无需中途确认，适合有明确目标的任务。";
        }
        return "保留标准交互流程，适合手动确认每一步。";
      }

      function getSupportedModes(tool) {
        return ["default", "full-access", "auto-edit", "native", "managed"];
      }

      function getSafeModeForTool(tool, mode) {
        var supported = getSupportedModes(tool);
        if (supported.indexOf(mode) !== -1) return mode;
        var fallback = state.config && state.config.defaultMode ? state.config.defaultMode : "default";
        if (supported.indexOf(fallback) !== -1) return fallback;
        return supported[0];
      }

      function renderModeOptions(tool, selectedMode) {
        return getSupportedModes(tool).map(function(mode) {
          var hint = getModeHint(mode);
          return '<option value="' + escapeHtml(mode) + '"' + (mode === selectedMode ? " selected" : "") + ' title="' + hint + '">' +
            escapeHtml(getModeLabel(mode)) +
          '</option>';
        }).join("");
      }

      function getModeHint(mode) {
        var hints = {
          'default': '标准模式 - 需要确认文件修改',
          'full-access': '完全访问 - 自动确认权限与操作',
          'auto-edit': '自动编辑 - 自动确认文件修改',
          'native': '原生模式 - 返回结构化输出',
          'managed': '托管模式 - AI 自动完成所有工作'
        };
        return hints[mode] || '';
      }

      function syncComposerModeSelect() {
        var select = document.getElementById("chat-mode-select");
        if (!select) return;
        state.chatMode = getSafeModeForTool("claude", state.chatMode);
        select.innerHTML = renderModeOptions("claude", state.chatMode);
        select.value = state.chatMode;
        var modeHint = document.getElementById("mode-hint");
        if (modeHint) modeHint.textContent = getModeHint(state.chatMode);
      }

      function applyCurrentView() {
        var hasSession = !!state.selectedId;
        var terminalBtn = document.getElementById("view-terminal-btn");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");

        if (terminalBtn) terminalBtn.classList.add("active");
        if (terminalContainer) terminalContainer.classList.toggle("active", hasSession);
        if (chatContainer) {
          chatContainer.classList.remove("active");
          chatContainer.classList.add("hidden");
        }
        updateInteractiveControls();
      }

      function syncSessionModalUI() {
        var modeHint = document.getElementById("mode-description");
        var tool = "claude";

        state.sessionTool = tool;
        state.modeValue = getSafeModeForTool(tool, state.modeValue || state.chatMode || "default");

        // Update mode cards active state
        var modeCards = document.querySelectorAll("#mode-cards .mode-card");
        if (modeCards.length) {
          modeCards.forEach(function(card) {
            card.classList.toggle("active", card.getAttribute("data-mode") === state.modeValue);
          });
        }

        if (modeHint) modeHint.textContent = getToolModeHint(tool, state.modeValue);
      }

      function updateSessionSnapshot(snapshot) {
        if (!snapshot || !snapshot.id) return;
        var updated = false;
        var prevSession = null;
        state.sessions = state.sessions.map(function(session) {
          if (session.id !== snapshot.id) return session;
          prevSession = session;
          updated = true;
          return Object.assign({}, session, snapshot);
        });
        if (!updated) {
          state.sessions.unshift(snapshot);
        }
        if (snapshot.id === state.selectedId) {
          reconcileInteractiveState();
          updateTaskDisplay();
        }
      }

      function subscribeToSession(sessionId) {
        if (!sessionId || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        state.ws.send(JSON.stringify({ type: "subscribe", sessionId: sessionId }));
      }

      function mergeServerSession(localSession, serverSession) {
        if (!localSession) return serverSession;

        var merged = Object.assign({}, localSession, serverSession);
        var localOutput = localSession.output || "";
        var serverOutput = serverSession.output || "";
        var keepLocalOutput = localOutput.length > serverOutput.length;

        if (keepLocalOutput) {
          merged.output = localOutput;
        }

        if (localSession.id === state.selectedId) {
          if (localSession.permissionBlocked && serverSession.permissionBlocked === false) {
            // server explicitly resolved it; keep resolved state
          } else if (localSession.permissionBlocked && !serverSession.permissionBlocked) {
            merged.permissionBlocked = true;
          }

          if (localSession.pendingEscalation && !serverSession.pendingEscalation && serverSession.permissionBlocked !== false) {
            merged.pendingEscalation = localSession.pendingEscalation;
          }

          if (localSession.messages && localSession.messages.length > 0 && (!serverSession.messages || serverSession.messages.length === 0)) {
            merged.messages = localSession.messages;
          }
        }

        return merged;
      }

      function getPreferredMessages(session, fallbackOutput, allowFallback) {
        if (session && session.messages && session.messages.length > 0) {
          return session.messages;
        }
        if (!allowFallback) {
          return [];
        }
        var output = typeof fallbackOutput === "string"
          ? fallbackOutput
          : (session && session.output) || "";
        if (!output) {
          return [];
        }
        return parseMessages(output, session && session.command);
      }

      function getPreferredSessionId(sessions) {
        if (!sessions || !sessions.length) return null;
        // Keep currently selected session as long as it still exists
        if (state.selectedId) {
          var stillExists = sessions.find(function(session) { return session.id === state.selectedId; });
          if (stillExists) return stillExists.id;
        }
        // No selection — pick a running session, or fall back to most recent
        var runningSession = sessions.find(function(session) { return session.status === "running"; });
        if (runningSession) return runningSession.id;
        // Fall back to most recent non-archived session (sessions are sorted newest first)
        var recent = sessions.find(function(session) { return !session.archived; });
        return recent ? recent.id : sessions[0].id;
      }

      function loadSessions() {
        return fetch("/api/sessions", { credentials: "same-origin" })
          .then(function(res) {
            if (res.status === 401) {
              logout();
              return;
            }
            return res.json();
          })
          .then(function(sessions) {
            var serverSessions = sessions || [];
            var sessionIds = new Set(serverSessions.map(function(s) { return s.id; }));

            Object.keys(state.drafts).forEach(function(id) {
              if (!sessionIds.has(id)) delete state.drafts[id];
            });

            state.sessions = serverSessions.map(function(serverSession) {
              var localSession = state.sessions.find(function(s) { return s.id === serverSession.id; });
              return mergeServerSession(localSession, serverSession);
            });

            state.selectedId = getPreferredSessionId(state.sessions);
            persistSelectedId();
            if (state.modalOpen) {
              updateSessionsList();
            } else {
              var listEl = document.getElementById("sessions-list");
              var rendered = renderSessions();
              if (listEl && listEl.innerHTML === rendered) {
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              } else {
                if (listEl) listEl.innerHTML = rendered;
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              }
            }
            updateShellChrome();
          })
          .catch(function(e) {
            console.error("[wand] loadSessions failed:", e);
          });
      }


      function updateSessionsList() {
        var listEl = document.getElementById("sessions-list");
        var countEl = document.getElementById("session-count");
        if (listEl) listEl.innerHTML = renderSessions();
        if (countEl) countEl.textContent = String(state.sessions.length);
        updateShellChrome();
      }

      function updateShellChrome() {
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSession) {
          setTerminalInteractive(false);
          hideMiniKeyboard();
          closeKeyboardPopup();
        }
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "Wand";
        var terminalInfo = selectedSession ? getSessionStatusLabel(selectedSession) : "开始对话";
        var summaryEl = document.querySelector(".session-summary-value");
        var titleEl = document.getElementById("terminal-title");
        var infoEl = document.getElementById("terminal-info");
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");

        if (summaryEl && summaryEl.textContent !== terminalTitle) summaryEl.textContent = terminalTitle;
        if (titleEl && titleEl.textContent !== terminalTitle) titleEl.textContent = terminalTitle;
        if (infoEl && infoEl.textContent !== terminalInfo) {
          infoEl.textContent = terminalInfo;
        }

        // Update session info bar at bottom
        var cwdEl = document.getElementById("session-cwd-display");
        var modeEl = document.getElementById("session-mode-display");
        var statusEl = document.getElementById("session-status-display");
        var exitEl = document.getElementById("session-exit-display");
        var cwdText = selectedSession && selectedSession.cwd ? selectedSession.cwd : "未设置目录";
        var modeText = selectedSession ? getModeLabel(selectedSession.mode) : "默认";
        var exitText = "exit=" + (selectedSession && selectedSession.exitCode !== undefined ? selectedSession.exitCode : "n/a");
        if (cwdEl && cwdEl.textContent !== cwdText) cwdEl.textContent = cwdText;
        if (modeEl && modeEl.textContent !== modeText) modeEl.textContent = modeText;
        if (statusEl && statusEl.textContent !== terminalInfo) statusEl.textContent = terminalInfo;
        if (exitEl && exitEl.textContent !== exitText) exitEl.textContent = exitText;

        if (!state.terminal && terminalContainer && selectedSession) {
          initTerminal();
        }
        if (state.terminal && terminalContainer && !terminalContainer.contains(state.terminal.element)) {
          state.terminal.open(terminalContainer);
          applyTerminalScale();
          state.terminalViewportSize = { width: 0, height: 0 };
          scheduleTerminalResize();
        }

        if (selectedSession && state.terminal) {
          syncTerminalBuffer(selectedSession.id, selectedSession.output || "", { mode: "replace" });
        } else if (!selectedSession) {
          state.terminalSessionId = null;
          state.terminalOutput = "";
        }

        if (state.terminal && selectedSession && state.currentView === "terminal") {
          maybeScrollTerminalToBottom("view");
        }

        var inputPanel = document.querySelector(".input-panel");
        if (selectedSession) {
          if (blankChat) blankChat.classList.add("hidden");
          if (terminalContainer) terminalContainer.classList.remove("hidden");
          if (chatContainer) chatContainer.classList.remove("hidden");
          if (stopBtn) stopBtn.classList.remove("hidden");
          if (inputPanel) inputPanel.classList.remove("hidden");
        } else {
          if (blankChat) blankChat.classList.remove("hidden");
          if (terminalContainer) terminalContainer.classList.add("hidden");
          if (chatContainer) chatContainer.classList.add("hidden");
          if (stopBtn) stopBtn.classList.add("hidden");
          if (inputPanel) inputPanel.classList.add("hidden");
        }
        syncComposerModeSelect();
        applyCurrentView();
        reconcileInteractiveState();
      }

      function loadOutput(id) {
        // Cancel any pending debounced chat render to avoid flicker
        if (chatRenderTimer) {
          clearTimeout(chatRenderTimer);
          chatRenderTimer = null;
        }
        return fetch("/api/sessions/" + id, { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            updateSessionSnapshot(data);
            updateShellChrome();

            var selectedSession = state.sessions.find(function(s) { return s.id === id; });
            state.currentMessages = getPreferredMessages(selectedSession, data.output, false);

            if (state.terminal) {
              syncTerminalBuffer(id, data.output || "", { mode: "replace" });
            }

            renderChat(false);
          });
      }

      function selectSession(id) {
        state.selectedId = id;
        persistSelectedId();
        state.lastRenderedHash = 0;
        state.lastRenderedMsgCount = 0;
        state.lastRenderedEmpty = null;
        state.currentMessages = [];
        if (chatRenderTimer) { clearTimeout(chatRenderTimer); chatRenderTimer = null; }
        // Reset todo progress bar
        var todoEl = document.getElementById("todo-progress");
        if (todoEl) todoEl.classList.add("hidden");
        var session = state.sessions.find(function(item) { return item.id === id; });
        state.preferredCommand = getPreferredTool();
        state.chatMode = getSafeModeForTool("claude", session && session.mode ? session.mode : state.chatMode);
        if (state.terminalInteractive && session && session.status !== "running") {
          setTerminalInteractive(false);
        }
        updateSessionsList();
        switchToSessionView(id);
        // Update file panel cwd and refresh if open
        if (state.filePanelOpen) {
          updateFilePanelCwd(session);
          refreshFileExplorer();
        }
        loadOutput(id).then(function() { focusInputBox(true); });
        subscribeToSession(id);
      }

      function updateDrawerState() {
        var drawer = document.getElementById("sessions-drawer");
        var backdrop = document.getElementById("sessions-drawer-backdrop");
        var mainLayout = document.querySelector(".main-layout");
        if (drawer) {
          drawer.classList.toggle("open", state.sessionsDrawerOpen);
        }
        if (backdrop) {
          backdrop.classList.toggle("open", state.sessionsDrawerOpen);
        }
        if (mainLayout) {
          mainLayout.classList.toggle("sidebar-open", state.sessionsDrawerOpen);
        }
        var toggleBtn = document.getElementById("sessions-toggle-button");
        if (toggleBtn) {
          toggleBtn.classList.toggle("active", state.sessionsDrawerOpen);
        }
      }

      function toggleSessionsDrawer() {
        state.sessionsDrawerOpen = !state.sessionsDrawerOpen;
        if (state.sessionsDrawerOpen && isMobileLayout()) {
          state.filePanelOpen = false;
          try {
            localStorage.setItem("wand-file-panel-open", "false");
          } catch (e) {}
        }
        updateLayoutState();
      }

      function closeSessionsDrawer() {
        if (!state.sessionsDrawerOpen) return;
        closeSwipedItem();
        state.sessionsDrawerOpen = false;
        updateLayoutState();
      }

      // Store last focused element for focus trap
      var lastFocusedElement = null;
      var focusTrapHandler = null;

      function openSessionModal() {
        state.modalOpen = true;
        state.sessionsDrawerOpen = false;
        updateDrawerState();
        var modal = document.getElementById("session-modal");
        if (modal) {
          modal.classList.remove("hidden");
          lastFocusedElement = document.activeElement;
          state.sessionTool = getPreferredTool();
          state.modeValue = getSafeModeForTool(state.sessionTool, state.modeValue || state.chatMode);
          syncSessionModalUI();
          loadRecentPathBubbles();
          setTimeout(function() {
            var modeCardsEl = document.getElementById("mode-cards");
            if (modeCardsEl) modeCardsEl.focus();
          }, 20);
          setupFocusTrap(modal);
        }
      }

      function closeSessionModal() {
        state.modalOpen = false;
        var modal = document.getElementById("session-modal");
        if (modal) {
          modal.classList.add("hidden");
          // Remove focus trap
          if (focusTrapHandler) {
            document.removeEventListener("keydown", focusTrapHandler);
            focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
            lastFocusedElement.focus();
          }
        }
        hidePathSuggestions();
      }

      function setupFocusTrap(modal) {
        if (focusTrapHandler) {
          document.removeEventListener("keydown", focusTrapHandler);
        }

        // Focusable elements selector
        var focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

        focusTrapHandler = function(e) {
          if (e.key !== "Tab") return;

          var focusableElements = modal.querySelectorAll(focusableSelector);
          var firstEl = focusableElements[0];
          var lastEl = focusableElements[focusableElements.length - 1];

          if (!firstEl || !lastEl) return;

          // Shift + Tab
          if (e.shiftKey) {
            if (document.activeElement === firstEl) {
              e.preventDefault();
              lastEl.focus();
            }
          } else {
            // Tab
            if (document.activeElement === lastEl) {
              e.preventDefault();
              firstEl.focus();
            }
          }
        };

        document.addEventListener("keydown", focusTrapHandler);
      }

      function openSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) {
          modal.classList.remove("hidden");
          lastFocusedElement = document.activeElement;
          var passEl = document.getElementById("new-password");
          var confirmEl = document.getElementById("confirm-password");
          if (passEl) passEl.value = "";
          if (confirmEl) confirmEl.value = "";
          hideSettingsMessages();
          setupFocusTrap(modal);
          // Activate first tab
          switchSettingsTab("about");
          // Load settings data
          loadSettingsData();
        }
      }

      function closeSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) {
          modal.classList.add("hidden");
          // Remove focus trap
          if (focusTrapHandler) {
            document.removeEventListener("keydown", focusTrapHandler);
            focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
            lastFocusedElement.focus();
          }
        }
      }

      function hideSettingsMessages() {
        var errorEl = document.getElementById("settings-error");
        var successEl = document.getElementById("settings-success");
        if (errorEl) errorEl.classList.add("hidden");
        if (successEl) successEl.classList.add("hidden");
      }

      function savePassword() {
        var newPass = document.getElementById("new-password").value;
        var confirmPass = document.getElementById("confirm-password").value;
        var errorEl = document.getElementById("settings-error");
        var successEl = document.getElementById("settings-success");

        hideSettingsMessages();

        if (!newPass || newPass.length < 6) {
          errorEl.textContent = "密码长度至少为 6 个字符。";
          errorEl.classList.remove("hidden");
          return;
        }

        if (newPass !== confirmPass) {
          errorEl.textContent = "两次输入的密码不一致。";
          errorEl.classList.remove("hidden");
          return;
        }

        fetch("/api/set-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: newPass }),
          credentials: "same-origin"
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            errorEl.textContent = data.error;
            errorEl.classList.remove("hidden");
            return;
          }
          successEl.textContent = "密码修改成功！";
          successEl.classList.remove("hidden");
          document.getElementById("new-password").value = "";
          document.getElementById("confirm-password").value = "";
        })
        .catch(function() {
          errorEl.textContent = "Failed to save password.";
          errorEl.classList.remove("hidden");
        });
      }

      // ── Settings tab/panel logic ──

      function switchSettingsTab(tabName) {
        var tabs = document.querySelectorAll(".settings-tab");
        var panels = document.querySelectorAll(".settings-panel");
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i].getAttribute("data-tab") === tabName) {
            tabs[i].classList.add("active");
          } else {
            tabs[i].classList.remove("active");
          }
        }
        for (var j = 0; j < panels.length; j++) {
          if (panels[j].id === "settings-tab-" + tabName) {
            panels[j].classList.add("active");
          } else {
            panels[j].classList.remove("active");
          }
        }
      }

      function loadSettingsData() {
        fetch("/api/settings", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            // About
            var nameEl = document.getElementById("settings-pkg-name");
            var verEl = document.getElementById("settings-version");
            var nodeEl = document.getElementById("settings-node-req");
            var repoEl = document.getElementById("settings-repo-url");
            if (nameEl) nameEl.textContent = data.packageName || "-";
            if (verEl) verEl.textContent = data.version || "-";
            if (nodeEl) nodeEl.textContent = data.nodeVersion || "-";
            if (repoEl && data.repoUrl) {
              repoEl.innerHTML = '<a href="' + escapeHtml(data.repoUrl) + '" target="_blank" rel="noopener">' + escapeHtml(data.repoUrl) + '</a>';
            }

            // Config fields
            var cfg = data.config || {};
            var hostEl = document.getElementById("cfg-host");
            var portEl = document.getElementById("cfg-port");
            var httpsEl = document.getElementById("cfg-https");
            var modeEl = document.getElementById("cfg-mode");
            var cwdEl = document.getElementById("cfg-cwd");
            var shellEl = document.getElementById("cfg-shell");
            if (hostEl) hostEl.value = cfg.host || "";
            if (portEl) portEl.value = cfg.port || "";
            if (httpsEl) httpsEl.checked = cfg.https === true;
            if (modeEl) modeEl.value = cfg.defaultMode || "default";
            if (cwdEl) cwdEl.value = cfg.defaultCwd || "";
            if (shellEl) shellEl.value = cfg.shell || "";
            var domTermEl = document.getElementById("cfg-dom-terminal");
            if (domTermEl) domTermEl.checked = cfg.experimentalDomTerminal === true;

            // Cert status
            var certStatus = document.getElementById("cert-status");
            if (certStatus) {
              certStatus.textContent = data.hasCert ? "已安装 SSL 证书" : "未安装证书（使用自签名或 HTTP）";
              certStatus.style.color = data.hasCert ? "var(--success)" : "var(--text-secondary)";
            }

            // Presets
            var presetsList = document.getElementById("presets-list");
            if (presetsList && cfg.commandPresets) {
              var html = "";
              for (var i = 0; i < cfg.commandPresets.length; i++) {
                var p = cfg.commandPresets[i];
                html += '<div class="preset-item">' +
                  '<span class="preset-label">' + escapeHtml(p.label) + '</span>' +
                  '<span class="preset-detail">' + escapeHtml(p.command) + (p.mode ? ' (' + escapeHtml(p.mode) + ')' : '') + '</span>' +
                '</div>';
              }
              if (!html) html = '<p class="settings-hint">没有命令预设。</p>';
              presetsList.innerHTML = html;
            }
          })
          .catch(function() {});
      }

      function saveConfigSettings() {
        var msgEl = document.getElementById("config-message");
        if (msgEl) { msgEl.classList.add("hidden"); msgEl.textContent = ""; }

        var body = {
          host: (document.getElementById("cfg-host") || {}).value,
          port: Number((document.getElementById("cfg-port") || {}).value),
          https: (document.getElementById("cfg-https") || {}).checked,
          defaultMode: (document.getElementById("cfg-mode") || {}).value,
          defaultCwd: (document.getElementById("cfg-cwd") || {}).value,
          shell: (document.getElementById("cfg-shell") || {}).value,
          experimentalDomTerminal: (document.getElementById("cfg-dom-terminal") || {}).checked,
        };

        fetch("/api/settings/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body)
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (msgEl) {
            if (data.error) {
              msgEl.textContent = data.error;
              msgEl.style.color = "var(--error)";
            } else {
              msgEl.textContent = "配置已保存，部分更改需要重启后生效。";
              msgEl.style.color = "var(--success)";
            }
            msgEl.classList.remove("hidden");
          }
        })
        .catch(function() {
          if (msgEl) {
            msgEl.textContent = "保存失败。";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
        });
      }

      function uploadCertificates() {
        var keyFile = document.getElementById("cert-key-file");
        var certFile = document.getElementById("cert-cert-file");
        var msgEl = document.getElementById("cert-message");
        if (msgEl) { msgEl.classList.add("hidden"); msgEl.textContent = ""; }

        if (!keyFile || !keyFile.files[0] || !certFile || !certFile.files[0]) {
          if (msgEl) {
            msgEl.textContent = "请选择私钥和证书文件。";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
          return;
        }

        var keyReader = new FileReader();
        keyReader.onload = function() {
          var keyContent = keyReader.result;
          var certReader = new FileReader();
          certReader.onload = function() {
            var certContent = certReader.result;
            fetch("/api/settings/upload-cert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ key: keyContent, cert: certContent })
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (msgEl) {
                if (data.error) {
                  msgEl.textContent = data.error;
                  msgEl.style.color = "var(--error)";
                } else {
                  msgEl.textContent = "证书已上传，重启后生效。";
                  msgEl.style.color = "var(--success)";
                  // Update cert status
                  var certStatus = document.getElementById("cert-status");
                  if (certStatus) {
                    certStatus.textContent = "已安装 SSL 证书";
                    certStatus.style.color = "var(--success)";
                  }
                }
                msgEl.classList.remove("hidden");
              }
            })
            .catch(function() {
              if (msgEl) {
                msgEl.textContent = "上传失败。";
                msgEl.style.color = "var(--error)";
                msgEl.classList.remove("hidden");
              }
            });
          };
          certReader.readAsText(certFile.files[0]);
        };
        keyReader.readAsText(keyFile.files[0]);
      }

      function checkForUpdate() {
        var latestEl = document.getElementById("settings-latest-version");
        var updateBtn = document.getElementById("do-update-button");
        var msgEl = document.getElementById("update-message");
        if (latestEl) latestEl.textContent = "检查中...";
        if (msgEl) msgEl.classList.add("hidden");
        if (updateBtn) updateBtn.classList.add("hidden");

        fetch("/api/check-update", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.error) {
              if (latestEl) latestEl.textContent = "检查失败";
              return;
            }
            if (latestEl) latestEl.textContent = data.latest;
            if (data.updateAvailable && updateBtn) {
              updateBtn.classList.remove("hidden");
            }
            if (!data.updateAvailable && msgEl) {
              msgEl.textContent = "已是最新版本。";
              msgEl.style.color = "var(--success)";
              msgEl.classList.remove("hidden");
            }
          })
          .catch(function() {
            if (latestEl) latestEl.textContent = "检查失败";
          });
      }

      function performUpdate() {
        var msgEl = document.getElementById("update-message");
        var updateBtn = document.getElementById("do-update-button");
        if (!updateBtn) return;
        updateBtn.disabled = true;
        if (msgEl) {
          msgEl.textContent = "正在更新，请稍候...";
          msgEl.style.color = "var(--text-secondary)";
          msgEl.classList.remove("hidden");
        }

        fetch("/api/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin"
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (msgEl) {
            msgEl.textContent = data.message || data.error || "更新完成。";
            msgEl.style.color = data.error ? "var(--error)" : "var(--success)";
            msgEl.classList.remove("hidden");
          }
          if (data.error) {
            updateBtn.disabled = false;
          } else {
            updateBtn.classList.add("hidden");
          }
        })
        .catch(function() {
          if (msgEl) {
            msgEl.textContent = "更新失败。";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
          updateBtn.disabled = false;
        });
      }

      // ── Notification Settings Helpers ──

      function updateNotificationStatus() {
        var statusEl = document.getElementById("notification-permission-status");
        var requestBtn = document.getElementById("notification-request-btn");
        var testMsgEl = document.getElementById("notification-test-message");
        if (!statusEl) return;

        if (typeof Notification === "undefined") {
          statusEl.textContent = "\u4e0d\u652f\u6301";
          statusEl.style.color = "var(--fg-muted)";
          if (requestBtn) requestBtn.classList.add("hidden");
          return;
        }

        var perm = Notification.permission;
        if (perm === "granted") {
          statusEl.textContent = "\u5df2\u6388\u6743 \u2713";
          statusEl.style.color = "var(--success)";
          if (requestBtn) requestBtn.classList.add("hidden");
        } else if (perm === "denied") {
          statusEl.textContent = "\u5df2\u62d2\u7edd";
          statusEl.style.color = "var(--danger)";
          if (requestBtn) requestBtn.classList.add("hidden");
          if (testMsgEl) {
            testMsgEl.textContent = "\u6d4f\u89c8\u5668\u5df2\u62d2\u7edd\u901a\u77e5\u6743\u9650\uff0c\u8bf7\u5728\u6d4f\u89c8\u5668\u8bbe\u7f6e\u4e2d\u624b\u52a8\u5f00\u542f";
            testMsgEl.style.color = "var(--fg-muted)";
            testMsgEl.classList.remove("hidden");
          }
        } else {
          statusEl.textContent = "\u672a\u6388\u6743";
          statusEl.style.color = "var(--warning)";
          if (requestBtn) requestBtn.classList.remove("hidden");
        }
      }

      function testNotification() {
        var testMsgEl = document.getElementById("notification-test-message");

        // Always show in-app bubble
        showNotificationBubble({
          title: "\u6d4b\u8bd5\u901a\u77e5",
          body: "\u8fd9\u662f\u4e00\u6761\u6d4b\u8bd5\u901a\u77e5\uff0c\u5e94\u7528\u5185\u6c14\u6ce1\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002",
          type: "info",
          icon: "\u266a",
          duration: 5000,
        });

        // Test browser notification
        if (typeof Notification === "undefined") {
          if (testMsgEl) {
            testMsgEl.textContent = "\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u901a\u77e5 API\uff0c\u4ec5\u53ef\u4f7f\u7528\u5e94\u7528\u5185\u6c14\u6ce1\u901a\u77e5\u3002";
            testMsgEl.style.color = "var(--fg-muted)";
            testMsgEl.classList.remove("hidden");
          }
          return;
        }

        if (Notification.permission === "granted") {
          try {
            var n = new Notification("Wand \u6d4b\u8bd5\u901a\u77e5", {
              body: "\u6d4f\u89c8\u5668\u901a\u77e5\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002",
              icon: "/favicon.ico",
              tag: "wand-test",
            });
            setTimeout(function() { n.close(); }, 5000);
            if (testMsgEl) {
              testMsgEl.textContent = "\u2713 \u6d4f\u89c8\u5668\u901a\u77e5 + \u5e94\u7528\u5185\u6c14\u6ce1\u5747\u5df2\u53d1\u9001";
              testMsgEl.style.color = "var(--success)";
              testMsgEl.classList.remove("hidden");
            }
          } catch (_e) {
            if (testMsgEl) {
              testMsgEl.textContent = "\u6d4f\u89c8\u5668\u901a\u77e5\u53d1\u9001\u5931\u8d25\uff0c\u53ef\u80fd\u9700\u8981 HTTPS";
              testMsgEl.style.color = "var(--warning)";
              testMsgEl.classList.remove("hidden");
            }
          }
        } else {
          // permission is "default" or "denied" — always try requesting
          Notification.requestPermission().then(function(result) {
            updateNotificationStatus();
            if (result === "granted") {
              testNotification();
            } else if (result === "denied") {
              if (testMsgEl) {
                testMsgEl.textContent = "\u6d4f\u89c8\u5668\u5df2\u62d2\u7edd\u901a\u77e5\u6743\u9650\uff0c\u8bf7\u70b9\u51fb\u5730\u5740\u680f\u5de6\u4fa7\u9501\u56fe\u6807\u6216\u5728\u6d4f\u89c8\u5668\u8bbe\u7f6e\u4e2d\u624b\u52a8\u5f00\u542f";
                testMsgEl.style.color = "var(--fg-muted)";
                testMsgEl.classList.remove("hidden");
              }
            }
          });
        }
      }

      function quickStartSession() {
        var command = getPreferredTool();
        var defaultCwd = getEffectiveCwd();
        var defaultMode = (state.config && state.config.defaultMode) ? state.config.defaultMode : "default";
        state.preferredCommand = command;
        state.chatMode = getSafeModeForTool(command, state.chatMode);
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ command: command, cwd: defaultCwd, mode: defaultMode })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          return refreshAll();
        })
        .then(function() { focusInputBox(true); })
        .catch(function() {
          showToast("无法启动会话。", "error");
        });
      }

      function runCommand() {
        var cwdEl = document.getElementById("cwd");
        var errorEl = document.getElementById("modal-error");
        var command = getPreferredTool();

        hideError(errorEl);

        var defaultCwd = getEffectiveCwd();
        var selectedMode = getSafeModeForTool(command, state.modeValue);
        state.modeValue = selectedMode;
        state.chatMode = selectedMode;
        state.sessionTool = command;
        state.preferredCommand = command;
        syncComposerModeSelect();

        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            command: command,
            cwd: cwdEl.value.trim() || defaultCwd,
            mode: selectedMode
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showError(errorEl, data.error);
            return;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          closeSessionModal();
          closeSessionsDrawer();
          return refreshAll();
        })
        .then(function() { focusInputBox(true); })
        .catch(function() {
          showError(errorEl, "无法启动会话，请确认 Claude 已正确安装。");
        });
      }

      // Blank-chat CWD inline display + dropdown
      function initBlankChatCwd() {
        var cwdEl = document.getElementById("blank-chat-cwd");
        if (!cwdEl) return;
        cwdEl.addEventListener("click", toggleBlankChatCwdDropdown);
        cwdEl.addEventListener("keydown", function(e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleBlankChatCwdDropdown();
          }
        });
        document.addEventListener("click", function(e) {
          var dropdown = document.getElementById("blank-chat-cwd-dropdown");
          if (!dropdown || dropdown.classList.contains("hidden")) return;
          if (!e.target.closest(".blank-chat-cwd-wrap")) {
            dropdown.classList.add("hidden");
            var arrow = document.getElementById("blank-chat-cwd-arrow");
            if (arrow) arrow.textContent = "▼";
          }
        });
      }

      function toggleBlankChatCwdDropdown() {
        var dropdown = document.getElementById("blank-chat-cwd-dropdown");
        var arrow = document.getElementById("blank-chat-cwd-arrow");
        if (!dropdown) return;
        var isHidden = dropdown.classList.contains("hidden");
        if (isHidden) {
          loadBlankChatCwdDropdown(dropdown);
          dropdown.classList.remove("hidden");
          if (arrow) arrow.textContent = "▲";
        } else {
          dropdown.classList.add("hidden");
          if (arrow) arrow.textContent = "▼";
        }
      }

      function loadBlankChatCwdDropdown(dropdown) {
        var defaultCwd = getConfigCwd();
        dropdown.innerHTML = '<div class="blank-chat-cwd-loading">加载中...</div>';
        fetch("/api/recent-paths", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(items) {
            var html = "";
            // Default directory always first
            var currentDir = state.workingDir || defaultCwd;
            html += '<div class="blank-chat-cwd-item' + (currentDir === defaultCwd ? " active" : "") + '" data-path="' + escapeHtml(defaultCwd) + '">' +
              '<span class="blank-chat-cwd-item-label">默认</span>' +
              '<span class="blank-chat-cwd-item-path">' + escapeHtml(defaultCwd) + '</span>' +
            '</div>';
            // Recent paths (exclude default to avoid duplicate)
            if (items && items.length) {
              var seen = {};
              seen[defaultCwd] = true;
              items.forEach(function(item) {
                if (seen[item.path]) return;
                seen[item.path] = true;
                html += '<div class="blank-chat-cwd-item' + (currentDir === item.path ? " active" : "") + '" data-path="' + escapeHtml(item.path) + '">' +
                  '<span class="blank-chat-cwd-item-path">' + escapeHtml(item.path) + '</span>' +
                '</div>';
              });
            }
            dropdown.innerHTML = html;
            dropdown.querySelectorAll(".blank-chat-cwd-item").forEach(function(el) {
              el.addEventListener("click", function(e) {
                e.stopPropagation();
                var path = el.dataset.path;
                state.workingDir = path;
                try { localStorage.setItem("wand-working-dir", path); } catch(e) {}
                var pathEl = document.getElementById("blank-chat-cwd-path");
                if (pathEl) pathEl.textContent = path;
                dropdown.classList.add("hidden");
                var arrow = document.getElementById("blank-chat-cwd-arrow");
                if (arrow) arrow.textContent = "▼";
                // Update folder picker input if exists
                var fpInput = document.getElementById("folder-picker-input");
                if (fpInput) fpInput.value = path;
              });
            });
          })
          .catch(function() {
            dropdown.innerHTML = '<div class="blank-chat-cwd-item" data-path="' + escapeHtml(defaultCwd) + '">' +
              '<span class="blank-chat-cwd-item-path">' + escapeHtml(defaultCwd) + '</span>' +
            '</div>';
          });
      }

      function loadRecentPathBubbles() {
        var container = document.getElementById("recent-paths-bubbles");
        if (!container) return;
        fetch("/api/recent-paths", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(items) {
            if (!items || !items.length) {
              container.innerHTML = "";
              return;
            }
            container.innerHTML = items.map(function(item) {
              return '<button class="recent-path-bubble" data-path="' + escapeHtml(item.path) + '" title="' + escapeHtml(item.path) + '">' +
                escapeHtml(item.name) +
              '</button>';
            }).join("");
            container.querySelectorAll(".recent-path-bubble").forEach(function(el) {
              el.addEventListener("click", function() {
                var cwdEl = document.getElementById("cwd");
                if (cwdEl) {
                  cwdEl.value = el.dataset.path;
                  state.cwdValue = el.dataset.path || "";
                }
              });
            });
          })
          .catch(function() {
            if (container) container.innerHTML = "";
          });
      }

      function schedulePathSuggestions() {
        if (state.suggestionTimer) clearTimeout(state.suggestionTimer);
        state.suggestionTimer = setTimeout(loadPathSuggestions, 120);
      }

      function loadPathSuggestions() {
        var modal = document.getElementById("session-modal");
        if (modal && modal.classList.contains("hidden")) {
          hidePathSuggestions();
          return;
        }

        var cwdEl = document.getElementById("cwd");
        if (!cwdEl) return;

        fetch("/api/path-suggestions?q=" + encodeURIComponent(cwdEl.value.trim()), { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(renderPathSuggestions)
          .catch(hidePathSuggestions);
      }

      function renderPathSuggestions(items) {
        var container = document.getElementById("cwd-suggestions");
        if (!container || !items.length) {
          hidePathSuggestions();
          return;
        }

        container.innerHTML = items.map(function(item) {
          return '<button class="suggestion-item" data-path="' + escapeHtml(item.path) + '">' +
            '<strong>' + escapeHtml(item.name) + '</strong>' +
            '<small>' + escapeHtml(item.path) + '</small>' +
          '</button>';
        }).join("");

        container.querySelectorAll(".suggestion-item").forEach(function(el) {
          el.addEventListener("click", function() {
            document.getElementById("cwd").value = el.dataset.path;
            state.cwdValue = el.dataset.path || "";
            hidePathSuggestions();
          });
        });

        container.classList.remove("hidden");
      }

      function hidePathSuggestions() {
        var container = document.getElementById("cwd-suggestions");
        if (container) {
          container.classList.add("hidden");
          container.innerHTML = "";
        }
      }

      function handleInputBoxKeydown(event) {
        if (event.isComposing) return;

        if (shouldCaptureTerminalEvent(event)) {
          captureTerminalInput(event);
          return;
        }

        if (event.key === "Enter") {
          if (event.shiftKey) {
            event.preventDefault();
            var inputBox = document.getElementById("input-box");
            if (inputBox) {
              var start = inputBox.selectionStart || 0;
              var current = inputBox.value;
              var newValue = current.slice(0, start) + String.fromCharCode(10) + current.slice(start);
              inputBox.value = newValue;
              // Move cursor to after the inserted newline
              inputBox.selectionStart = start + 1;
              inputBox.selectionEnd = start + 1;
              setDraftValue(newValue, true);
              autoResizeInput(inputBox);
            }
            return;
          }
          event.preventDefault();
          sendInputFromBox();
          return;
        }

        if (event.key === "Backspace") {
          // Let default behavior handle the deletion, then sync state
          setTimeout(function() {
            var inputBox = document.getElementById("input-box");
            if (inputBox) {
              setDraftValue(inputBox.value, true);
            }
          }, 0);
          return;
        }

        if (event.key === "Tab") {
          event.preventDefault();
          var inputBox = document.getElementById("input-box");
          if (inputBox) {
            var start = inputBox.selectionStart || 0;
            var current = inputBox.value;
            var newValue = current.slice(0, start) + String.fromCharCode(9) + current.slice(start);
            inputBox.value = newValue;
            setDraftValue(newValue, true);
          }
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          queueDirectInput(getControlInput("escape"), "escape");
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
          // Allow copy when text is selected; otherwise send SIGINT to terminal
          var inputBox = document.getElementById("input-box");
          var hasSelection = inputBox && (inputBox.selectionStart !== inputBox.selectionEnd);
          if (hasSelection) {
            return; // Let browser handle copy
          }
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_c"), "ctrl_c");
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
          // Allow copy when text is selected; otherwise send EOF to terminal
          var inputBox2 = document.getElementById("input-box");
          var hasSelection2 = inputBox2 && (inputBox2.selectionStart !== inputBox2.selectionEnd);
          if (hasSelection2) {
            return; // Let browser handle copy
          }
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_d"), "ctrl_d");
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_l"), "ctrl_l");
          return;
        }

        // Cmd+A / Ctrl+A: Select all (let browser handle)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          // Let browser handle select-all
          return;
        }

        // Cmd+V / Ctrl+V: Paste (let browser handle)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
          // Let browser handle paste
          return;
        }

        // Cmd+X / Ctrl+X: Cut (let browser handle when text selected)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "x") {
          var inputBox = document.getElementById("input-box");
          var hasSelection = inputBox && (inputBox.selectionStart !== inputBox.selectionEnd);
          if (hasSelection) {
            // Let browser handle cut
            return;
          }
          // No selection: send Ctrl+X to terminal (rare case)
          event.preventDefault();
          queueDirectInput(String.fromCharCode(24), "ctrl_x"); // Ctrl+X = 0x18
          return;
        }

        // Let browser handle all other keys naturally (including arrows, home, end, etc.)
        // Sync state after default behavior for character keys
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          setTimeout(function() {
            var inputBox = document.getElementById("input-box");
            if (inputBox) {
              setDraftValue(inputBox.value);
            }
          }, 0);
        }
      }

      function handleInputPaste(event) {
        var pasted = event.clipboardData && event.clipboardData.getData("text");
        if (!pasted) return;
        event.preventDefault();
        var inputBox = document.getElementById("input-box");
        if (inputBox) {
          var start = inputBox.selectionStart || 0;
          var end = inputBox.selectionEnd || 0;
          var current = inputBox.value;
          var newValue = current.slice(0, start) + pasted + current.slice(end);
          inputBox.value = newValue;
          setDraftValue(newValue);
        }
      }

      function queueDraftInput(text) {
        queueDirectInput(text);
        setDraftValue(getDraftValue() + text);
      }

      function getDraftValue() {
        if (state.selectedId) {
          if (state.drafts[state.selectedId] !== undefined) {
            return state.drafts[state.selectedId];
          }
          // Try to load from localStorage
          try {
            var saved = localStorage.getItem("wand-draft-" + state.selectedId);
            if (saved) return saved;
          } catch (e) { /* ignore */ }
        }
        return "";
      }

      function setDraftValue(value, skipDom) {
        if (!state.selectedId) return;
        state.drafts[state.selectedId] = value;
        // Persist to localStorage
        try {
          localStorage.setItem("wand-draft-" + state.selectedId, value);
        } catch (e) { /* ignore */ }
        if (!skipDom) {
          var inputBox = document.getElementById("input-box");
          if (inputBox) inputBox.value = value;
        }
      }

      function autoResizeInput(el) {
        if (!el) return;
        var minHeight = 36;
        var maxHeight = 120;
        var touchDevice = isTouchDevice();
        // For empty content, reset to minimum height immediately
        if (!el.value || el.value.trim() === "") {
          el.style.height = minHeight + "px";
          el.style.minHeight = minHeight + "px";
          el.style.overflowY = touchDevice ? "auto" : "hidden";
          el.scrollTop = 0;
          return;
        }
        // Measure content height by temporarily setting height to minHeight
        // and reading scrollHeight. Avoid collapsing to 0 which causes layout jumps.
        var prevOverflow = el.style.overflowY;
        el.style.overflowY = "hidden";
        el.style.height = minHeight + "px";
        var contentHeight = el.scrollHeight;
        var newHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
        var shouldScrollInside = contentHeight > maxHeight;
        el.style.height = newHeight + "px";
        el.style.minHeight = minHeight + "px";
        el.style.overflowY = shouldScrollInside || touchDevice ? "auto" : "hidden";
        if (shouldScrollInside) {
          syncInputBoxScroll(el);
        } else {
          el.scrollTop = 0;
        }
      }

      function isSelectedSessionRunning() {
        if (!state.selectedId) return false;
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        return !!selectedSession && selectedSession.status === "running";
      }

      // Send message from the welcome screen input
      function welcomeInputSend() {
        var welcomeInput = document.getElementById("welcome-input");
        var value = welcomeInput ? welcomeInput.value.trim() : "";
        if (!value) return;
        // Clear todo progress bar at the start of a new session
        var todoEl = document.getElementById("todo-progress");
        if (todoEl) todoEl.classList.add("hidden");
        welcomeInput.value = "";
        welcomeInput.placeholder = "正在启动会话...";
        welcomeInput.disabled = true;
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
            welcomeInput.disabled = false;
            return;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          switchToSessionView(data.id);
          updateSessionSnapshot(data);
          updateSessionsList();
          subscribeToSession(data.id);
          loadOutput(data.id).then(function() {
            focusInputBox(true);
          });
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
          welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
          welcomeInput.disabled = false;
        });
      }

      function sendOrStart() {
        // Support welcome input as well as the main input box
        var welcomeInput = document.getElementById("welcome-input");
        var inputBox = document.getElementById("input-box");
        var value = (welcomeInput && welcomeInput.value.trim())
          ? welcomeInput.value.trim()
          : (inputBox ? inputBox.value.trim() : "");

        // If we have a selected ID, try to send input to it
        if (state.selectedId) {
          if (value) {
            sendInputFromBox();
          }
          return;
        }

        // No selected session, create a new one
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value || undefined
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          switchToSessionView(data.id);
          updateSessionSnapshot(data);
          updateSessionsList();
          // Subscribe to new session via WebSocket
          subscribeToSession(data.id);
          return loadOutput(data.id);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
        });
      }

      function switchToSessionView(sessionId) {
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");
        var terminalTitle = document.getElementById("terminal-title");
        var terminalInfo = document.getElementById("terminal-info");
        var sessionSummary = document.querySelector(".session-summary-value");

        if (blankChat) blankChat.classList.add("hidden");
        if (terminalContainer) terminalContainer.classList.remove("hidden");
        if (chatContainer) {
          chatContainer.classList.remove("hidden");
        }
        if (stopBtn) stopBtn.classList.remove("hidden");

        var title = session ? shortCommand(session.command) : "Wand";
        var info = session ? getSessionStatusLabel(session) : "开始对话";
        if (terminalTitle) terminalTitle.textContent = title;
        if (terminalInfo) terminalInfo.textContent = info;
        if (sessionSummary) sessionSummary.textContent = title;

        // Init terminal if not already done
        if (!state.terminal) initTerminal();
        applyCurrentView();
        if (state.terminal && state.fitAddon) {
          ensureTerminalFit();
        }
        // Don't call renderChat() here — loadOutput() always calls renderChat() after it resolves.
        // Calling renderChat() prematurely would render with stale/empty messages.
        focusInputBox();
      }


      function sendInputFromBox() {
        if (state.terminalInteractive) {
          showToast("终端交互模式开启时，请直接在终端中输入。", "info");
          return Promise.resolve();
        }

        var inputBox = document.getElementById("input-box");
        var value = inputBox ? inputBox.value : "";
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; }) || null;
        if (value) {
          console.log("[wand] sendInputFromBox", {
            sessionId: state.selectedId,
            sessionStatus: selectedSession ? selectedSession.status : null,
            view: state.currentView,
            wsConnected: state.wsConnected,
            terminalInteractive: state.terminalInteractive,
            inputLength: value.length
          });
          // Clear todo progress bar at the start of a new user turn
          var todoEl = document.getElementById("todo-progress");
          if (todoEl) todoEl.classList.add("hidden");
          // Send text + Enter as a single call to avoid race conditions
          var combinedInput = value + getControlInput("enter");
          var isOffline = !state.wsConnected;

          if (isOffline) {
            // Offline: queue for flush on reconnect, clear input immediately
            if (state.pendingMessages.length >= 100) {
              state.pendingMessages.shift();
            }
            state.pendingMessages.push(combinedInput);
            if (inputBox) {
              inputBox.value = "";
              autoResizeInput(inputBox);
            }
            setDraftValue("");
            return Promise.resolve();
          }

          // Online: send via queue, only clear on success
          return ensureSessionReadyForInput(selectedSession).then(function(readySession) {
            if (!readySession) {
              showToast("会话未就绪，将稍后重试。", "info");
              return null;
            }
            return queueDirectInput(combinedInput, "enter_text").then(function() {
              // Clear input only after the send succeeds
              if (inputBox && inputBox.value === value) {
                inputBox.value = "";
                autoResizeInput(inputBox);
              }
              setDraftValue("");
            });
          }).catch(function(err) {
            showToast(getInputErrorMessage(err), "error");
            throw err;
          });
        }
        return Promise.resolve();
      }

      function getInputErrorMessage(error) {
        if (error && (error.errorCode === "SESSION_NOT_RUNNING" || error.errorCode === "SESSION_NO_PTY")) {
          return "会话已结束；若存在 Claude 历史会话，将在你下次发送消息时自动恢复。";
        }
        if (error && error.errorCode === "SESSION_NOT_FOUND") {
          return "会话不存在，请重新选择或新建会话。";
        }
        return (error && error.message) || "会话暂不可用；若存在 Claude 历史会话，将自动尝试恢复。";
      }

      function buildInputError(payload) {
        var err = new Error((payload && payload.error) || "会话已结束。");
        if (payload && typeof payload === "object") {
          err.errorCode = payload.errorCode || null;
          err.sessionId = payload.sessionId || state.selectedId || null;
          err.sessionStatus = Object.prototype.hasOwnProperty.call(payload, "sessionStatus") ? payload.sessionStatus : null;
        }
        return err;
      }

      function isSessionUnavailableError(error) {
        return error && (error.errorCode === "SESSION_NOT_RUNNING" || error.errorCode === "SESSION_NO_PTY" || error.errorCode === "SESSION_NOT_FOUND");
      }

      function markSessionStopped(sessionId, status) {
        if (!sessionId) return;
        updateSessionSnapshot({ id: sessionId, status: status || "exited" });
      }

      function hasRealConversationHistory(session) {
        if (!session || !Array.isArray(session.messages) || session.messages.length < 2) {
          return false;
        }
        var hasUser = session.messages.some(function(turn) {
          return turn && turn.role === "user" && Array.isArray(turn.content) && turn.content.some(function(block) {
            return block && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
          });
        });
        var hasAssistant = session.messages.some(function(turn) {
          return turn && turn.role === "assistant" && Array.isArray(turn.content) && turn.content.some(function(block) {
            return block && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
          });
        });
        return hasUser && hasAssistant;
      }

      function canAutoResumeSession(session) {
        return !!(session && session.status === "exited" && session.claudeSessionId && hasRealConversationHistory(session));
      }

      function ensureSessionReadyForInput(session, errorEl) {
        if (!session) {
          showToast("会话不存在，请重新选择或新建会话。", "error");
          return Promise.resolve(null);
        }
        if (session.status === "running") {
          return Promise.resolve(session);
        }
        if (!canAutoResumeSession(session)) {
          showToast("该会话没有可恢复的 Claude 历史上下文，请新建会话。", "error");
          return Promise.resolve(null);
        }

        showToast("正在恢复历史会话…", "info");
        return resumeClaudeSessionById(session.claudeSessionId, errorEl).then(function(data) {
          if (!data) return null;
          updateSessionSnapshot(data);
          updateSessionsList();
          switchToSessionView(data.id);
          subscribeToSession(data.id);
          return loadOutput(data.id).then(function() {
            focusInputBox(true);
            return data;
          });
        });
      }

      function queueDirectInput(input, shortcutKey) {
        if (!input || !state.selectedId) return Promise.resolve();
        state.messageQueue.push(input);
        updateQueueCounter();
        state.inputQueue = state.inputQueue.then(function() {
          return postInput(input, shortcutKey).finally(function() {
            var idx = state.messageQueue.indexOf(input);
            if (idx > -1) state.messageQueue.splice(idx, 1);
            updateQueueCounter();
            scheduleMobileDomUpdate();
          });
        });
        return state.inputQueue;
      }

      function postInput(input, shortcutKey) {
        if (!state.selectedId) return Promise.resolve();

        // Pre-check: don't send if session is not running
        if (!isSelectedSessionRunning()) {
          // If WebSocket is disconnected, queue for flush on reconnect
          if (!state.wsConnected) {
            if (state.pendingMessages.length >= 100) {
              state.pendingMessages.shift();
            }
            state.pendingMessages.push(input);
            console.log("[wand] postInput: session not running, queued for reconnect", {
              sessionId: state.selectedId,
              inputLength: input.length
            });
            return Promise.resolve();
          }
          console.warn("[wand] postInput: session not running, skipping send", {
            sessionId: state.selectedId
          });
          showToast("会话未运行，正在等待自动恢复后重试。", "info");
          return Promise.resolve();
        }

        // If WebSocket is disconnected, queue the message (no HTTP fetch while offline)
        if (!state.wsConnected) {
          if (state.pendingMessages.length >= 100) {
            state.pendingMessages.shift();
          }
          state.pendingMessages.push(input);
          console.log("[wand] postInput: WebSocket disconnected, queued message", {
            sessionId: state.selectedId,
            inputLength: input.length
          });
          return Promise.resolve();
        }

        console.log("[wand] postInput: sending", {
          sessionId: state.selectedId,
          inputLength: input.length,
          view: state.currentView,
          wsConnected: state.wsConnected
        });

        return fetch("/api/sessions/" + state.selectedId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, view: state.currentView, shortcutKey: shortcutKey || undefined })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return { error: "请求失败" }; }).then(function(payload) {
              var error = buildInputError(payload);
              error.httpStatus = res.status;
              console.error("[wand] postInput: request failed", {
                status: res.status,
                errorCode: error.errorCode,
                message: error.message,
                sessionId: state.selectedId
              });
              // Mark session as stopped for unavailable errors
              if (isSessionUnavailableError(error)) {
                markSessionStopped(state.selectedId, error.sessionStatus || "exited");
              }
              throw error;
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.id) {
            updateSessionSnapshot(snapshot);
            if (snapshot.messages && snapshot.messages.length > 0) {
              state.currentMessages = snapshot.messages;
            }
            renderChat(true);
          }
          return snapshot;
        });
      }

      function sendDirectInput(input) {
        return queueDirectInput(input);
      }

      function isTerminalInteractionAvailable() {
        return !!state.selectedId && state.currentView === "terminal";
      }

      function shouldCaptureTerminalEvent(event) {
        if (!state.terminalInteractive || !isTerminalInteractionAvailable()) return false;
        if (event.defaultPrevented || event.isComposing) return false;
        var target = event.target;
        if (!target) return true;
        if (target.closest && target.closest("#mini-keyboard")) return false;
        if (shouldIgnoreInteractiveTarget(target)) return false;
        return true;
      }

      var keyboardEventKeyMap = {
        Esc: "escape",
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        Enter: "enter",
        Tab: "tab",
        Backspace: "backspace",
        Home: "home",
        End: "end",
        PageUp: "pageup",
        PageDown: "pagedown",
        Delete: "delete",
        Insert: "insert",
        " ": "space"
      };

      var ptySpecialKeyMap = {
        space: " ",
        tab: String.fromCharCode(9),
        backspace: String.fromCharCode(127),
        home: String.fromCharCode(27) + "[H",
        end: String.fromCharCode(27) + "[F",
        pageup: String.fromCharCode(27) + "[5~",
        pagedown: String.fromCharCode(27) + "[6~",
        delete: String.fromCharCode(27) + "[3~",
        insert: String.fromCharCode(27) + "[2~"
      };

      var ctrlSymbolMap = {
        " ": 0,
        "[": 27,
        "\\": 28,
        "]": 29,
        "^": 30,
        "_": 31
      };

      var ignoredInteractiveTargetIds = new Set([
        "mini-keyboard-fab",
        "mini-keyboard-toggle",
        "terminal-interactive-toggle"
      ]);

      function shouldIgnoreInteractiveTarget(target) {
        return !!(target && ignoredInteractiveTargetIds.has(target.id));
      }

      var modifierKeySet = new Set(["ctrl", "alt", "shift"]);

      function isModifierKey(key) {
        return modifierKeySet.has(key);
      }

      function getPtySpecialSequence(key) {
        return ptySpecialKeyMap[key] || "";
      }

      function getCtrlSequence(text) {
        var lower = text.toLowerCase();
        if (lower >= "a" && lower <= "z") {
          return String.fromCharCode(lower.charCodeAt(0) - 96);
        }
        if (Object.prototype.hasOwnProperty.call(ctrlSymbolMap, lower)) {
          return String.fromCharCode(ctrlSymbolMap[lower]);
        }
        return "";
      }

      function keyFromKeyboardEvent(event) {
        return keyboardEventKeyMap[event.key] || event.key;
      }

      function getModifierStateFromEvent(event, key) {
        return {
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey && key.length === 1,
          meta: event.metaKey
        };
      }

      function sendTerminalSequence(sequence, shortcutKey) {
        if (!sequence) return;
        queueDirectInput(sequence, shortcutKey).catch(function() {});
      }

      function focusTerminalInteractionTarget() {
        focusTerminalContainer();
      }

      function setMiniKeyboardVisible(visible, clearModifiersOnHide) {
        // Inline keyboard visibility is now based on view, not state
        state.miniKeyboardVisible = !!visible;
        if (!state.miniKeyboardVisible && clearModifiersOnHide !== false) {
          clearModifiers();
        }
        updateKeyboardPopupUI();
      }

      function hideMiniKeyboard(clearModifiersOnHide) {
        // Just clear modifiers, inline keyboard visibility follows view
        state.keyboardPopupOpen = false;
        if (clearModifiersOnHide !== false) {
          clearModifiers();
        }
        updateKeyboardPopupUI();
      }

      function showMiniKeyboard() {
        // Inline keyboard shows automatically in terminal view
        updateKeyboardPopupUI();
      }

      function toggleMiniKeyboard() {
        // No longer needed, keyboard is inline
      }

      function toggleTerminalInteractive() {
        if (!isTerminalInteractionAvailable()) return;
        setTerminalInteractive(!state.terminalInteractive);
      }

      function setTerminalInteractive(enabled) {
        var next = !!enabled && isTerminalInteractionAvailable();
        if (state.terminalInteractive === next) return;
        state.terminalInteractive = next;
        if (next) {
          enableTerminalCapture();
          hideMiniKeyboard(false);
          focusTerminalInteractionTarget();
          showToast("终端交互模式已开启", "info");
        } else {
          disableTerminalCapture();
          clearModifiers();
        }
        updateInteractiveControls();
      }

      function reconcileInteractiveState() {
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var shouldDisableInteractive = !selectedSession || selectedSession.status !== "running" || state.currentView !== "terminal";
        if (shouldDisableInteractive && state.terminalInteractive) {
          setTerminalInteractive(false);
          return;
        }
        if ((!selectedSession || state.currentView !== "terminal") && state.keyboardPopupOpen) {
          state.keyboardPopupOpen = false;
        }
        updateInteractiveControls();
      }

      function updateInteractiveControls() {
        // Update both toggle buttons (topbar and terminal-header)
        var toggles = ["terminal-interactive-toggle-top"];
        toggles.forEach(function(id) {
          var toggle = document.getElementById(id);
          if (toggle) {
            toggle.classList.toggle("active", state.terminalInteractive);
          }
        });
        // Inline keyboard visibility follows current view
        var inlineKeyboard = document.getElementById("inline-keyboard");
        if (inlineKeyboard) inlineKeyboard.classList.toggle("hidden", state.currentView !== "terminal");
        var inputHint = document.querySelector(".input-hint");
        if (inputHint) inputHint.classList.toggle("hidden", state.currentView === "terminal");
        var container = document.getElementById("output");
        if (container) container.classList.toggle("interactive", state.terminalInteractive);
      }

      function captureTerminalInput(event) {
        if (!shouldCaptureTerminalEvent(event)) return;
        var key = keyFromKeyboardEvent(event);
        if (!key) return;
        event.preventDefault();
        var mods = getModifierStateFromEvent(event, key);
        if (isModifierKey(key)) return;
        var sequence = buildPtySequence(key, mods);
        if (sequence) sendTerminalSequence(sequence, key);
      }

      function handleMiniKeyboardClick(event) {
        var btn = event.target.closest(".mk-key");
        if (!btn) return;
        var key = btn.getAttribute("data-key");
        if (!key) return;
        event.preventDefault();
        if (key === "ctrl" || key === "alt" || key === "shift") {
          state.modifiers[key] = !state.modifiers[key];
          updateModifierUI();
          return;
        }
        var sequence = buildPtySequence(key, { ctrl: state.modifiers.ctrl, alt: state.modifiers.alt, shift: state.modifiers.shift });
        if (sequence) sendTerminalSequence(sequence, key);
        clearModifiers();
      }

      function handleInlineKeyboardClick(event) {
        var btn = event.target.closest(".shortcut-key");
        if (!btn) return;
        var key = btn.getAttribute("data-key");
        if (!key) return;
        event.preventDefault();
        if (key === "ctrl" || key === "alt") {
          state.modifiers[key] = !state.modifiers[key];
          updateKeyboardPopupUI();
          return;
        }
        if (key === "ctrl_enter") {
          var sequence = buildPtySequence("enter", { ctrl: true, alt: false, shift: false });
          if (sequence) sendTerminalSequence(sequence, "ctrl_enter");
          return;
        }
        var sequence = buildPtySequence(key, { ctrl: state.modifiers.ctrl, alt: state.modifiers.alt, shift: false });
        if (sequence) sendTerminalSequence(sequence, key);
        clearModifiers();
        updateKeyboardPopupUI();
      }

      function updateKeyboardPopupUI() {
        var container = document.querySelector(".inline-shortcuts-wrap");
        if (!container) return;
        ["ctrl", "alt"].forEach(function(name) {
          var btn = container.querySelector('[data-key="' + name + '"]');
          if (btn) btn.classList.toggle("active", !!state.modifiers[name]);
        });
      }

      function handleKeyboardToggle(event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.currentView !== "terminal" || !state.selectedId) return;
        state.keyboardPopupOpen = !state.keyboardPopupOpen;
        updateInteractiveControls();
      }

      function closeKeyboardPopup() {
        state.keyboardPopupOpen = false;
        updateInteractiveControls();
      }

      function enableTerminalCapture() {
        document.addEventListener("keydown", captureTerminalInput, true);
      }

      function disableTerminalCapture() {
        document.removeEventListener("keydown", captureTerminalInput, true);
      }

      function buildPtySequence(key, modifiers) {
        var mods = modifiers || { ctrl: false, alt: false, shift: false };
        if (isModifierKey(key)) return "";
        var specialSequence = getPtySpecialSequence(key);
        if (specialSequence) return specialSequence;
        if (key.indexOf("ctrl_") === 0) {
          return String.fromCharCode(key.charCodeAt(key.length - 1) - 96);
        }
        var mapped = getControlInput(key);
        if (mapped) return mapped;
        if (!key) return "";
        var text = key.length === 1 ? key : "";
        if (!text) return "";
        if (mods.shift) text = text.toUpperCase();
        if (mods.ctrl) {
          return getCtrlSequence(text);
        }
        if (mods.alt) return String.fromCharCode(27) + text;
        return text;
      }


      function clearModifiers() {
        state.modifiers.ctrl = false;
        state.modifiers.alt = false;
        state.modifiers.shift = false;
        updateModifierUI();
      }

      function updateModifierUI() {
        var keyboard = document.getElementById("mini-keyboard");
        if (!keyboard) return;
        ["ctrl", "alt", "shift"].forEach(function(name) {
          var btn = keyboard.querySelector('[data-key="' + name + '"]');
          if (btn) btn.classList.toggle("active", !!state.modifiers[name]);
        });
      }

      function getControlInput(key) {
        switch (key) {
          case "yes":
            return "y" + String.fromCharCode(13);
          case "no":
            return "n" + String.fromCharCode(13);
          case "up":
            return String.fromCharCode(27) + "[A";
          case "down":
            return String.fromCharCode(27) + "[B";
          case "left":
            return String.fromCharCode(27) + "[D";
          case "right":
            return String.fromCharCode(27) + "[C";
          case "enter":
            return String.fromCharCode(13);
          case "ctrl_c":
            return String.fromCharCode(3);
          case "ctrl_d":
            return String.fromCharCode(4);
          case "ctrl_l":
            return String.fromCharCode(12);
          case "ctrl_u":
            return String.fromCharCode(21);
          case "ctrl_k":
            return String.fromCharCode(11);
          case "ctrl_w":
            return String.fromCharCode(23);
          case "ctrl_z":
            return String.fromCharCode(26);
          case "escape":
            return String.fromCharCode(27);
          default:
            return "";
        }
      }

      function flushPendingMessages() {
        if (state.pendingMessages.length === 0) return;

        // Send queued messages in order, bypassing the session-running check
        // since our local state may be stale right after reconnect
        var queue = state.pendingMessages.slice();
        state.pendingMessages = [];

        var sendPromise = Promise.resolve();
        queue.forEach(function(input) {
          sendPromise = sendPromise.then(function() {
            return sendInputDirect(input).catch(function() {
              // Ignore errors during flush
            });
          });
        });
      }

      function sendInputDirect(input) {
        if (!input || !state.selectedId) return Promise.resolve();
        return fetch("/api/sessions/" + state.selectedId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, view: state.currentView })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return { error: "请求失败" }; }).then(function(payload) {
              var error = buildInputError(payload);
              error.httpStatus = res.status;
              // Don't re-queue on session-unavailable — the session will auto-resume
              // on the user's next message, and stale queue items would cause duplicates
              if (isSessionUnavailableError(error)) {
                console.log("[wand] sendInputDirect: session unavailable, dropping", {
                  sessionId: state.selectedId,
                  errorCode: error.errorCode
                });
                return null;
              }
              throw error;
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.id) {
            updateSessionSnapshot(snapshot);
            if (snapshot.messages && snapshot.messages.length > 0) {
              state.currentMessages = snapshot.messages;
            }
            renderChat(true);
          }
          return snapshot;
        });
      }

      function stopSession() {
        if (!state.selectedId) return;
        fetch("/api/sessions/" + state.selectedId + "/stop", { method: "POST", credentials: "same-origin" })
          .then(refreshAll);
      }

      function deleteSession(id) {
        var item = document.querySelector('.session-item[data-session-id="' + id + '"]');
        if (item) {
          item.classList.add("deleting");
        }
        setTimeout(function() {
          fetch("/api/sessions/" + id, { method: "DELETE", credentials: "same-origin" })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (data && data.error) {
                throw new Error(data.error);
              }
              if (state.selectedId === id) {
                state.selectedId = null;
                persistSelectedId();
              }
              return refreshAll();
            })
            .catch(function() {
              // Remove deleting state on error so item reappears
              if (item) item.classList.remove("deleting");
              var errorEl = document.getElementById("action-error");
              showError(errorEl, "无法删除会话。");
            });
        }, 250);
      }

      function executeDeleteHistory(claudeSessionId, item) {
        if (item) {
          item.classList.add("deleting");
        }
        setTimeout(function() {
          fetch("/api/claude-history/" + encodeURIComponent(claudeSessionId), { method: "DELETE", credentials: "same-origin" })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (data && data.error) {
                throw new Error(data.error);
              }
              state.claudeHistory = state.claudeHistory.filter(function(s) {
                return s.claudeSessionId !== claudeSessionId;
              });
              delete state.selectedClaudeHistoryIds[claudeSessionId];
              updateSessionsList();
            })
            .catch(function() {
              if (item) item.classList.remove("deleting");
              var errorEl = document.getElementById("action-error");
              showError(errorEl, "无法删除历史会话。");
            });
        }, 250);
      }

      function deleteClaudeHistorySession(claudeSessionId, item) {
        executeDeleteHistory(claudeSessionId, item);
      }

      function deleteClaudeHistoryDirectory(cwd, btn, items) {
        if (!cwd) {
          return;
        }
        fetch("/api/claude-history?cwd=" + encodeURIComponent(cwd), { method: "DELETE", credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            state.claudeHistory = state.claudeHistory.filter(function(s) {
              return s.cwd !== cwd;
            });
            updateSessionsList();
          })
          .catch(function() {
            setDeletingState(items, false);
            var errorEl = document.getElementById("action-error");
            showError(errorEl, "无法清理该目录的历史会话。");
          });
      }

      function setDeletingState(items, deleting) {
        items.forEach(function(item) {
          item.classList.toggle("deleting", deleting);
        });
      }

      function getHistoryItemsByCwd(cwd) {
        return Array.prototype.slice.call(document.querySelectorAll('.claude-history-item[data-cwd="' + window.CSS.escape(String(cwd)) + '"]'));
      }

      // ── Swipe-to-delete gesture ──

      var _swipeState = null;
      var _swipedItem = null;

      function closeSwipedItem() {
        if (_swipedItem) {
          _swipedItem.classList.remove("swiped");
          var content = _swipedItem.querySelector(".session-item-content");
          if (content) content.style.transform = "";
          _swipedItem = null;
        }
      }

      function initSwipeToDelete() {
        _swipeState = null;
        _swipedItem = null;
      }

      function startCommand(command, cwd, errorEl) {
        if (command === "claude") {
          state.preferredCommand = command;
          state.chatMode = getSafeModeForTool(command, state.chatMode);
        }
        return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            command: command,
            cwd: cwd || "",
            mode: state.chatMode || state.config.defaultMode || "default"
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            return null;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          return data;
        });
      }

      function resumeSession(sessionId, errorEl) {
        if (!sessionId) return Promise.resolve(null);
        return fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            mode: state.chatMode || state.config.defaultMode || "default"
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            else showToast(data.error, "error");
            return null;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          return data;
        })
        .catch(function(error) {
          var message = (error && error.message) || "无法恢复会话。";
          if (errorEl) showError(errorEl, message);
          else showToast(message, "error");
          return null;
        });
      }

      function resumeClaudeSessionById(claudeSessionId, errorEl) {
        if (!claudeSessionId) return Promise.resolve(null);
        return fetch("/api/claude-sessions/" + encodeURIComponent(claudeSessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            mode: state.chatMode || state.config.defaultMode || "default"
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            else showToast(data.error, "error");
            return null;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          return data;
        })
        .catch(function(error) {
          var message = (error && error.message) || "无法按 Claude 会话 ID 恢复会话。";
          if (errorEl) showError(errorEl, message);
          else showToast(message, "error");
          return null;
        });
      }

      function activateSession(data) {
        if (!data || !data.id) return Promise.resolve();
        state.lastRenderedHash = 0;
        state.lastRenderedMsgCount = 0;
        state.lastRenderedEmpty = null;
        switchToSessionView(data.id);
        updateSessionSnapshot(data);
        updateSessionsList();
        subscribeToSession(data.id);
        return loadOutput(data.id).then(function() {
          focusInputBox(true);
        });
      }

      function resumeSessionFromList(sessionId) {
        return resumeSession(sessionId).then(function(data) {
          if (!data) return null;
          return activateSession(data).then(function() {
            return data;
          });
        });
      }

      function startAndActivateCommand(command, cwd, errorEl) {
        return startCommand(command, cwd, errorEl).then(function(data) {
          if (!data) return null;
          return activateSession(data).then(function() {
            return data;
          });
        });
      }

      function createSessionFromWelcomeInput(value) {
        var welcomeInput = document.getElementById("welcome-input");
        if (!welcomeInput) return;
        welcomeInput.placeholder = "Claude 正在思考，请稍候...";
        welcomeInput.disabled = true;
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
            welcomeInput.disabled = false;
            return null;
          }
          return activateSession(data);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
          welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
          welcomeInput.disabled = false;
        })
        .finally(function() {
          welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
          welcomeInput.disabled = false;
        });
      }

      function createSessionFromInput(value, inputBox, welcomeInput) {
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value || undefined
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          return activateSession(data);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
        });
      }

      function handleResumeAction(actionButton) {
        actionButton.disabled = true;
        resumeSessionFromList(actionButton.dataset.sessionId)
          .finally(function() {
            actionButton.disabled = false;
          });
      }

      function handleResumeHistoryAction(actionButton) {
        var claudeSessionId = actionButton.dataset.claudeSessionId;
        var cwd = actionButton.dataset.cwd;
        if (!claudeSessionId) return;
        actionButton.disabled = true;
        resumeClaudeHistorySession(claudeSessionId, cwd)
          .then(function(data) {
            if (data && data.id) {
              state.selectedId = data.id;
              persistSelectedId();
              state.drafts[data.id] = "";
              loadSessions().then(function() {
                selectSession(data.id);
                closeSessionsDrawer();
              });
            }
          })
          .finally(function() {
            actionButton.disabled = false;
          });
      }

      function resumeClaudeHistorySession(claudeSessionId, cwd) {
        return fetch("/api/claude-sessions/" + encodeURIComponent(claudeSessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            mode: state.chatMode || (state.config && state.config.defaultMode) || "default",
            cwd: cwd
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          return data;
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法恢复历史会话。", "error");
          return null;
        });
      }

      function isTouchDevice() {
        return "ontouchstart" in window || navigator.maxTouchPoints > 0;
      }

      function focusInputBox(skipMobile) {
        if (state.terminalInteractive) return;
        var inputBox = document.getElementById("input-box");
        if (!inputBox || !state.selectedId) return;
        if (document.activeElement === inputBox) return;
        // Skip focus on mobile/touch devices for auto-triggered calls to avoid opening keyboard
        if (skipMobile && isTouchDevice()) return;
        focusInputWithSelection(inputBox);
      }

      function scrollLatestMessageIntoView() {
        var chatMessages = document.querySelector('.chat-messages');
        if (!chatMessages) return;
        // column-reverse: scrollTop=0 is the visual bottom.
        // Use direct scrollTop instead of scrollIntoView() to avoid
        // shifting ancestor containers and causing the input box to jump.
        chatMessages.scrollTop = 0;
      }

      function updateInputPanelViewportSpacing() {
        var inputPanel = document.querySelector('.input-panel');
        if (!inputPanel) return;
        if (!('visualViewport' in window) || !isTouchDevice()) {
          inputPanel.style.removeProperty('--keyboard-offset');
          return;
        }
        var vv = window.visualViewport;
        var offsetBottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        inputPanel.style.setProperty('--keyboard-offset', offsetBottom + 'px');
      }

      function resetInputPanelViewportSpacing() {
        var inputPanel = document.querySelector('.input-panel');
        if (!inputPanel) return;
        inputPanel.style.removeProperty('--keyboard-offset');
      }

      function restoreInputBoxViewport(inputBox) {
        if (!inputBox) return;
        var start = inputBox.selectionStart;
        var end = inputBox.selectionEnd;
        syncInputBoxScroll(inputBox);
        if (typeof start === 'number' && typeof end === 'number') {
          inputBox.setSelectionRange(start, end);
        }
      }

      function bindInputTouchScroll(inputBox) {
        if (!inputBox || inputBox.dataset.touchScrollBound === 'true') return;
        inputBox.dataset.touchScrollBound = 'true';
        inputBox.addEventListener('touchstart', function() {
          if (inputBox.scrollHeight <= inputBox.clientHeight + 1) return;
          if (inputBox.scrollTop <= 0) {
            inputBox.scrollTop = 1;
          } else if (inputBox.scrollTop + inputBox.clientHeight >= inputBox.scrollHeight) {
            inputBox.scrollTop = Math.max(1, inputBox.scrollHeight - inputBox.clientHeight - 1);
          }
        }, { passive: true });
      }

      function syncInputBoxLayout(inputBox) {
        if (!inputBox) return;
        autoResizeInput(inputBox);
        restoreInputBoxViewport(inputBox);
      }

      function handleInputBoxFocus(event) {
        var inputBox = event && event.target ? event.target : document.getElementById('input-box');
        if (!inputBox) return;
        updateInputPanelViewportSpacing();
        syncInputBoxLayout(inputBox);
      }

      function handleInputBoxBlur() {
        resetInputPanelViewportSpacing();
        // Restore app container height when keyboard closes
        var appContainer = document.querySelector('.app-container');
        if (appContainer) {
          appContainer.style.height = '';
        }
      }

      function adjustInputBoxSelection(inputBox) {
        if (!inputBox) return;
        inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length);
        restoreInputBoxViewport(inputBox);
      }

      function focusInputWithSelection(inputBox) {
        if (!inputBox) return;
        inputBox.focus({ preventScroll: true });
        adjustInputBoxSelection(inputBox);
      }

      function syncInputBoxForCurrentState(inputBox) {
        bindInputTouchScroll(inputBox);
        syncInputBoxLayout(inputBox);
      }

      function focusInputCaret(inputBox) {
        focusInputWithSelection(inputBox);
      }

      function updateInputViewportState(inputBox) {
        updateInputPanelViewportSpacing();
        restoreInputBoxViewport(inputBox);
      }

      function resetInputViewport() {
        resetInputPanelViewportSpacing();
      }

      function settleInputViewport(inputBox) {
        restoreInputBoxViewport(inputBox);
      }

      function focusInputBoxFromTap(inputBox) {
        focusInputCaret(inputBox);
      }

      function refreshInputBoxState(inputBox) {
        syncInputBoxForCurrentState(inputBox);
      }

      function clearInputViewportState() {
        resetInputViewport();
      }

      function finalizeInputViewportUpdate(inputBox) {
        settleInputViewport(inputBox);
      }

      function refreshInputViewportState(inputBox) {
        updateInputViewportState(inputBox);
      }

      function clearInputBoxViewportState() {
        clearInputViewportState();
      }

      function syncInputBoxViewportState(inputBox) {
        refreshInputViewportState(inputBox);
      }

      function resetInputBoxViewportState() {
        clearInputBoxViewportState();
      }

      function maintainInputBoxSelection(inputBox) {
        settleInputViewport(inputBox);
      }

      function focusInputFromViewportTap(inputBox) {
        focusInputBoxFromTap(inputBox);
      }

      function stabilizeInputViewport(inputBox) {
        finalizeInputViewportUpdate(inputBox);
      }

      function syncInputBoxAfterFocus(inputBox) {
        handleInputBoxFocus({ target: inputBox });
      }

      function syncInputBoxAfterBlur() {
        handleInputBoxBlur();
      }

      function syncInputBoxAfterViewportChange(inputBox) {
        refreshInputViewportState(inputBox);
      }

      function syncInputBoxAfterValueChange(inputBox) {
        refreshInputBoxState(inputBox);
      }

      function keepInputBoxCursorVisible(inputBox) {
        maintainInputBoxSelection(inputBox);
      }

      function updateInputViewportAfterKeyboard(inputBox) {
        updateInputViewportState(inputBox);
      }

      function clearInputViewportAfterKeyboard() {
        clearInputViewportState();
      }

      function applyInputViewportState(inputBox) {
        updateInputViewportState(inputBox);
      }

      function syncInputComposerAfterViewportChange(inputBox) {
        syncInputBoxAfterViewportChange(inputBox);
      }

      function resetInputComposerAfterViewportChange() {
        clearInputViewportAfterKeyboard();
      }

      function ensureInputBoxViewportState(inputBox) {
        refreshInputBoxState(inputBox);
      }

      function syncInputBoxState(inputBox) {
        ensureInputBoxViewportState(inputBox);
      }

      function syncInputBoxOnTouch(inputBox) {
        bindInputTouchScroll(inputBox);
      }

      function clearInputViewport() {
        resetInputViewport();
      }

      function refreshInputViewport(inputBox) {
        updateInputViewportState(inputBox);
      }

      function stabilizeInputBoxViewport(inputBox) {
        settleInputViewport(inputBox);
      }

      function focusInputByTap(inputBox) {
        focusInputBoxFromTap(inputBox);
      }

      function finalizeInputBoxViewport(inputBox) {
        stabilizeInputBoxViewport(inputBox);
      }

      function updateInputViewport(inputBox) {
        refreshInputViewport(inputBox);
      }

      function resetInputViewportSpacing() {
        clearInputViewport();
      }

      function keepInputViewportStable(inputBox) {
        finalizeInputBoxViewport(inputBox);
      }

      function focusInputAtCaret(inputBox) {
        focusInputByTap(inputBox);
      }

      function syncInputBoxViewport(inputBox) {
        updateInputViewport(inputBox);
      }

      function clearInputBoxViewport() {
        resetInputViewportSpacing();
      }

      function maintainInputViewport(inputBox) {
        keepInputViewportStable(inputBox);
      }

      function focusInputFromTapTarget(inputBox) {
        focusInputAtCaret(inputBox);
      }

      function settleInputBoxViewport(inputBox) {
        maintainInputViewport(inputBox);
      }

      function refreshInputViewportLayout(inputBox) {
        syncInputBoxViewport(inputBox);
      }

      function resetInputViewportLayout() {
        clearInputBoxViewport();
      }

      function keepCaretVisible(inputBox) {
        settleInputBoxViewport(inputBox);
      }

      function focusInputTarget(inputBox) {
        focusInputFromTapTarget(inputBox);
      }

      function finalizeInputLayout(inputBox) {
        refreshInputBoxState(inputBox);
        keepCaretVisible(inputBox);
      }

      function resetInputLayout() {
        resetInputViewportLayout();
      }

      function syncInputLayout(inputBox) {
        refreshInputViewportLayout(inputBox);
      }

      function focusInputSelection(inputBox) {
        focusInputTarget(inputBox);
      }

      function stabilizeInputLayout(inputBox) {
        finalizeInputLayout(inputBox);
      }

      function clearInputLayout() {
        resetInputLayout();
      }

      function applyInputLayout(inputBox) {
        syncInputLayout(inputBox);
      }

      function focusInputTapSelection(inputBox) {
        focusInputSelection(inputBox);
      }

      function settleInputLayout(inputBox) {
        stabilizeInputLayout(inputBox);
      }

      function resetInputTapLayout() {
        clearInputLayout();
      }

      function refreshInputTapLayout(inputBox) {
        applyInputLayout(inputBox);
      }

      function focusInputTap(inputBox) {
        focusInputTapSelection(inputBox);
      }

      function keepInputTapStable(inputBox) {
        settleInputLayout(inputBox);
      }

      function clearInputTapState() {
        resetInputTapLayout();
      }

      function updateInputTapState(inputBox) {
        refreshInputTapLayout(inputBox);
      }

      function maintainInputTapState(inputBox) {
        keepInputTapStable(inputBox);
      }

      function focusInputTapTarget(inputBox) {
        focusInputTap(inputBox);
      }

      function syncInputTapState(inputBox) {
        updateInputTapState(inputBox);
      }

      function resetInputTapState() {
        clearInputTapState();
      }

      function stabilizeInputTapState(inputBox) {
        maintainInputTapState(inputBox);
      }

      function activateInputTapTarget(inputBox) {
        focusInputTapTarget(inputBox);
      }

      function refreshInputTapViewport(inputBox) {
        syncInputTapState(inputBox);
      }

      function clearInputTapViewport() {
        resetInputTapState();
      }

      function keepInputTapViewportStable(inputBox) {
        stabilizeInputTapState(inputBox);
      }

      function focusInputTapViewport(inputBox) {
        activateInputTapTarget(inputBox);
      }

      function settleInputTapViewport(inputBox) {
        keepInputTapViewportStable(inputBox);
      }

      function updateInputTapViewport(inputBox) {
        refreshInputTapViewport(inputBox);
      }

      function resetInputTapViewport() {
        clearInputTapViewport();
      }

      function maintainInputTapViewport(inputBox) {
        settleInputTapViewport(inputBox);
      }

      function focusInputTapViewportTarget(inputBox) {
        focusInputTapViewport(inputBox);
      }

      function refreshInputPanelState(inputBox) {
        updateInputTapViewport(inputBox);
      }

      function clearInputPanelState() {
        resetInputTapViewport();
      }

      function stabilizeInputPanelState(inputBox) {
        maintainInputTapViewport(inputBox);
      }

      function focusInputPanelTarget(inputBox) {
        focusInputTapViewportTarget(inputBox);
      }

      function finalizeInputPanelState(inputBox) {
        stabilizeInputPanelState(inputBox);
      }

      function refreshInputPanelViewport(inputBox) {
        refreshInputPanelState(inputBox);
      }

      function clearInputPanelViewport() {
        clearInputPanelState();
      }

      function settleInputPanelViewport(inputBox) {
        finalizeInputPanelState(inputBox);
      }

      function focusInputPanelViewport(inputBox) {
        focusInputPanelTarget(inputBox);
      }

      function syncInputPanelViewport(inputBox) {
        refreshInputPanelViewport(inputBox);
      }

      function resetInputPanelViewport() {
        clearInputPanelViewport();
      }

      function stabilizeInputPanelViewport(inputBox) {
        settleInputPanelViewport(inputBox);
      }

      function focusInputPanelTap(inputBox) {
        focusInputPanelViewport(inputBox);
      }

      function updateInputPanelLayout(inputBox) {
        syncInputPanelViewport(inputBox);
      }

      function clearInputPanelLayout() {
        resetInputPanelViewport();
      }

      function keepInputPanelLayoutStable(inputBox) {
        stabilizeInputPanelViewport(inputBox);
      }

      function focusInputPanelSelection(inputBox) {
        focusInputPanelTap(inputBox);
      }

      function finalizeInputPanelLayout(inputBox) {
        keepInputPanelLayoutStable(inputBox);
      }

      function refreshInputComposerState(inputBox) {
        updateInputPanelLayout(inputBox);
      }

      function clearInputComposerState() {
        clearInputPanelLayout();
      }

      function settleInputComposerState(inputBox) {
        finalizeInputPanelLayout(inputBox);
      }

      function focusInputComposerSelection(inputBox) {
        focusInputPanelSelection(inputBox);
      }

      function syncInputComposerState(inputBox) {
        refreshInputComposerState(inputBox);
      }

      function resetInputComposerState() {
        clearInputComposerState();
      }

      function stabilizeInputComposerState(inputBox) {
        settleInputComposerState(inputBox);
      }

      function focusInputComposerTap(inputBox) {
        focusInputComposerSelection(inputBox);
      }

      function updateInputComposerLayout(inputBox) {
        syncInputComposerState(inputBox);
      }

      function clearComposerLayout() {
        resetInputComposerState();
      }

      function keepComposerLayoutStable(inputBox) {
        stabilizeInputComposerState(inputBox);
      }

      function focusComposerTap(inputBox) {
        focusInputComposerTap(inputBox);
      }

      function finalizeComposerLayout(inputBox) {
        keepComposerLayoutStable(inputBox);
      }

      function refreshComposerLayout(inputBox) {
        updateInputComposerLayout(inputBox);
      }

      function resetComposerLayout() {
        clearComposerLayout();
      }

      function stabilizeComposerLayout(inputBox) {
        finalizeComposerLayout(inputBox);
      }

      function focusComposerSelection(inputBox) {
        focusComposerTap(inputBox);
      }

      function updateComposerViewport(inputBox) {
        refreshComposerLayout(inputBox);
      }

      function clearComposerViewport() {
        resetComposerLayout();
      }

      function keepComposerViewportStable(inputBox) {
        stabilizeComposerLayout(inputBox);
      }

      function focusComposerViewport(inputBox) {
        focusComposerSelection(inputBox);
      }

      function finalizeComposerViewport(inputBox) {
        keepComposerViewportStable(inputBox);
      }

      function refreshComposerViewport(inputBox) {
        updateComposerViewport(inputBox);
      }

      function resetComposerViewport() {
        clearComposerViewport();
      }

      function stabilizeComposerViewport(inputBox) {
        finalizeComposerViewport(inputBox);
      }

      function focusComposerViewportTap(inputBox) {
        focusComposerViewport(inputBox);
      }

      function syncComposerViewport(inputBox) {
        refreshComposerViewport(inputBox);
      }

      function clearComposerViewportState() {
        resetComposerViewport();
      }

      function keepComposerViewportStateStable(inputBox) {
        stabilizeComposerViewport(inputBox);
      }

      function focusComposerViewportTarget(inputBox) {
        focusComposerViewportTap(inputBox);
      }

      function finalizeComposerViewportState(inputBox) {
        keepComposerViewportStateStable(inputBox);
      }

      function refreshComposerViewportState(inputBox) {
        syncComposerViewport(inputBox);
      }

      function resetComposerViewportState() {
        clearComposerViewportState();
      }

      function stabilizeComposerViewportState(inputBox) {
        finalizeComposerViewportState(inputBox);
      }

      function focusComposerViewportState(inputBox) {
        focusComposerViewportTarget(inputBox);
      }

      function syncComposerLayoutState(inputBox) {
        refreshComposerViewportState(inputBox);
      }

      function clearComposerLayoutState() {
        resetComposerViewportState();
      }

      function keepComposerLayoutStateStable(inputBox) {
        stabilizeComposerViewportState(inputBox);
      }

      function focusComposerLayoutState(inputBox) {
        focusComposerViewportState(inputBox);
      }

      function finalizeComposerLayoutState(inputBox) {
        keepComposerLayoutStateStable(inputBox);
      }

      function refreshInputFocusState(inputBox) {
        syncComposerLayoutState(inputBox);
      }

      function clearInputFocusState() {
        clearComposerLayoutState();
      }

      function stabilizeInputFocusState(inputBox) {
        finalizeComposerLayoutState(inputBox);
      }

      function focusInputFocusState(inputBox) {
        focusComposerLayoutState(inputBox);
      }

      function keepInputFocusStable(inputBox) {
        stabilizeInputFocusState(inputBox);
      }

      function updateInputFocusState(inputBox) {
        refreshInputFocusState(inputBox);
      }

      function resetInputFocusState() {
        clearInputFocusState();
      }

      function focusInputTargetState(inputBox) {
        focusInputFocusState(inputBox);
      }

      function settleInputFocusState(inputBox) {
        keepInputFocusStable(inputBox);
      }

      function syncInputFocusState(inputBox) {
        updateInputFocusState(inputBox);
      }

      function clearFocusState() {
        resetInputFocusState();
      }

      function maintainFocusState(inputBox) {
        settleInputFocusState(inputBox);
      }

      function activateInputTargetState(inputBox) {
        focusInputTargetState(inputBox);
      }

      function updateInputFocusViewport(inputBox) {
        syncInputFocusState(inputBox);
      }

      function clearInputFocusViewport() {
        clearFocusState();
      }

      function stabilizeInputFocusViewport(inputBox) {
        maintainFocusState(inputBox);
      }

      function focusInputViewportTarget(inputBox) {
        activateInputTargetState(inputBox);
      }

      function finalizeInputFocusViewport(inputBox) {
        stabilizeInputFocusViewport(inputBox);
      }

      function shouldAdjustForKeyboard(vv, inputBox) {
        if (!vv || !inputBox || document.activeElement !== inputBox) return false;
        var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
        if (offsetBottom <= 50) return false;
        var rect = inputBox.getBoundingClientRect();
        return rect.bottom > vv.height - 12;
      }

      function syncInputBoxScroll(inputBox) {
        if (!inputBox) return;
        var isScrollable = inputBox.scrollHeight > inputBox.clientHeight + 1;
        if (!isScrollable) {
          inputBox.scrollTop = 0;
          return;
        }
        inputBox.scrollTop = inputBox.scrollHeight;
      }

      function focusInputFromTap() {
        var inputBox = document.getElementById('input-box');
        if (!inputBox || !state.selectedId || document.activeElement === inputBox) return;
        focusInputWithSelection(inputBox);
      }

      function focusTerminalContainer() {
        var output = document.getElementById("output");
        if (!output) return;
        output.setAttribute("tabindex", "0");
        output.focus();
      }

      // Mobile keyboard handling
      function setupMobileKeyboardHandlers() {
        var inputPanel = document.querySelector('.input-panel');
        var chatMessages = document.querySelector('.chat-messages');
        var terminalContainer = document.querySelector('.terminal-container');

        // Virtual Keyboard API (Chrome/Edge)
        if ('virtualKeyboard' in navigator) {
          var vk = navigator.virtualKeyboard;

          vk.addEventListener('geometrychange', function() {
            if (!inputPanel) return;
            var rect = vk.boundingRect;
            var kbHeight = rect ? rect.height : 0;
            inputPanel.style.paddingBottom = kbHeight > 0 ? kbHeight + 'px' : '';
          });
        }

        // Show virtual keyboard on terminal/chat tap
        var output = document.getElementById('output');
        if (output) {
          output.addEventListener('click', function() {
            focusInputFromTap();
          });
        }

        // Also focus on chat messages tap
        if (chatMessages) {
          chatMessages.addEventListener('click', function(e) {
            // Only focus if not clicking on a link, button, or tool card header
            if (e.target.tagName !== 'A' && e.target.tagName !== 'BUTTON' && !e.target.closest('button') && !e.target.closest('[data-tool-toggle]')) {
              focusInputFromTap();
            }
          });
        }
      }

      // Visual viewport handling for better mobile keyboard support
      function setupVisualViewportHandlers() {
        if (!('visualViewport' in window)) return;

        var vv = window.visualViewport;
        var lastHeight = vv.height;
        var keyboardOpen = false;

        function updateViewport() {
          if (!vv) return;
          var inputBox = document.getElementById('input-box');
          var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
          var isKeyboardOpen = offsetBottom > 50;
          var heightChanged = Math.abs(vv.height - lastHeight) > 8;

          // In PWA standalone mode, dynamically resize the app container
          // because 100dvh does NOT shrink when keyboard appears in standalone PWA
          var appContainer = document.querySelector('.app-container');
          if (appContainer) {
            if (isKeyboardOpen) {
              appContainer.style.height = vv.height + 'px';
            } else {
              appContainer.style.height = '';
            }
          }

          if (isKeyboardOpen && (!keyboardOpen || heightChanged) && shouldAdjustForKeyboard(vv, inputBox)) {
            syncInputBoxScroll(inputBox);
          }

          keyboardOpen = isKeyboardOpen;
          lastHeight = vv.height;
        }

        var viewportFrame = null;
        function debouncedUpdate() {
          if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
          viewportFrame = requestAnimationFrame(function() {
            viewportFrame = null;
            updateViewport();
          });
        }

        vv.addEventListener('resize', debouncedUpdate);

        updateViewport();
      }

      function initTerminalResizeHandle() {
        // 终端容器拖动调整大小功能
        var container = document.getElementById("terminal-container");
        if (!container) return;

        // 创建拖动手柄
        var resizeHandle = document.createElement("div");
        resizeHandle.className = "terminal-resize-handle";
        resizeHandle.innerHTML = "&#8942;"; // 垂直省略号，表示可拖动
        container.appendChild(resizeHandle);

        var isResizing = false;
        var startY = 0;
        var startHeight = 0;

        resizeHandle.addEventListener("mousedown", function(e) {
          isResizing = true;
          startY = e.clientY;
          startHeight = container.getBoundingClientRect().height;
          document.body.style.cursor = "ns-resize";
          document.body.style.userSelect = "none";
          e.preventDefault();
        });

        // Store document-level listeners so they can be removed in teardownTerminal
        state.resizeMouseMove = function(e) {
          if (!isResizing) return;
          var deltaY = e.clientY - startY;
          var newHeight = Math.max(200, Math.min(startHeight + deltaY, window.innerHeight - 200));
          container.style.height = newHeight + "px";
          container.style.flex = "none";
          scheduleTerminalResize();
        };
        document.addEventListener("mousemove", state.resizeMouseMove);

        state.resizeMouseUp = function() {
          if (isResizing) {
            isResizing = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            scheduleTerminalResize();
          }
        };
        document.addEventListener("mouseup", state.resizeMouseUp);

        // 触摸设备支持
        resizeHandle.addEventListener("touchstart", function(e) {
          isResizing = true;
          startY = e.touches[0].clientY;
          startHeight = container.getBoundingClientRect().height;
          e.preventDefault();
        }, { passive: false });

        state.resizeTouchMove = function(e) {
          if (!isResizing) return;
          var deltaY = e.touches[0].clientY - startY;
          var newHeight = Math.max(200, Math.min(startHeight + deltaY, window.innerHeight - 200));
          container.style.height = newHeight + "px";
          container.style.flex = "none";
          scheduleTerminalResize();
          e.preventDefault();
        };
        document.addEventListener("touchmove", state.resizeTouchMove, { passive: false });

        state.resizeTouchEnd = function() {
          if (isResizing) {
            isResizing = false;
            scheduleTerminalResize();
          }
        };
        document.addEventListener("touchend", state.resizeTouchEnd);
      }

      function observeTerminalResize() {
        var output = document.getElementById("output");
        if (!output) return;

        if (typeof ResizeObserver === "function") {
          state.resizeObserver = new ResizeObserver(function() { scheduleTerminalResize(true); });
          state.resizeObserver.observe(output);
        }
        state.resizeHandler = function() { scheduleTerminalResize(true); };
        window.addEventListener("resize", state.resizeHandler);
        requestAnimationFrame(function() { scheduleTerminalResize(true); });
      }

      function teardownTerminal() {
        if (state.resizeTimer) {
          clearTimeout(state.resizeTimer);
          state.resizeTimer = null;
        }
        if (state.resizeObserver) {
          state.resizeObserver.disconnect();
          state.resizeObserver = null;
        }
        if (state.resizeHandler) {
          window.removeEventListener("resize", state.resizeHandler);
          state.resizeHandler = null;
        }
        [["mousemove", "resizeMouseMove"], ["mouseup", "resizeMouseUp"],
         ["touchmove", "resizeTouchMove"], ["touchend", "resizeTouchEnd"]
        ].forEach(function(pair) {
          if (state[pair[1]]) {
            document.removeEventListener(pair[0], state[pair[1]]);
            state[pair[1]] = null;
          }
        });
        clearTerminalScrollIdleTimer();
        if (state.terminalViewportEl) {
          if (state.terminalViewportScrollHandler) {
            state.terminalViewportEl.removeEventListener("scroll", state.terminalViewportScrollHandler);
          }
          if (state.terminalViewportTouchHandler) {
            state.terminalViewportEl.removeEventListener("touchmove", state.terminalViewportTouchHandler);
          }
        }
        state.terminalViewportEl = null;
        state.terminalViewportScrollHandler = null;
        state.terminalViewportTouchHandler = null;
        if (state.terminal) {
          state.terminal.dispose();
          state.terminal = null;
        }
        state.fitAddon = null;
        state.serializeAddon = null;
        state.terminalDomView = null;
        state._lastDomHtml = "";
        if (state.terminalDomUpdateTimer) {
          clearTimeout(state.terminalDomUpdateTimer);
          state.terminalDomUpdateTimer = null;
        }
        state.terminalSessionId = null;
        state.terminalOutput = "";
        state.terminalViewportSize = { width: 0, height: 0 };
        state.terminalAutoFollow = true;
        state.showTerminalJumpToBottom = false;
        updateTerminalJumpToBottomButton();
      }

      function ensureTerminalFit() {
        var maxAttempts = 10;
        var attempt = 0;
        function tryFit() {
          attempt++;
          state.terminalViewportSize = { width: 0, height: 0 };
          if (shouldResizeTerminalViewport() && state.fitAddon) {
            state.fitAddon.fit();
            maybeScrollTerminalToBottom("resize");
            if (state.selectedId && state.terminal) {
              var nextSize = { cols: state.terminal.cols, rows: state.terminal.rows };
              if (state.lastResize.cols !== nextSize.cols || state.lastResize.rows !== nextSize.rows) {
                state.lastResize = nextSize;
                fetch("/api/sessions/" + state.selectedId + "/resize", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "same-origin",
                  body: JSON.stringify(nextSize)
                }).catch(function() {});
              }
            }
          } else if (attempt < maxAttempts) {
            requestAnimationFrame(tryFit);
          }
        }
        requestAnimationFrame(tryFit);
      }

      function scheduleTerminalResize(immediate) {
        if (state.resizeTimer) {
          clearTimeout(state.resizeTimer);
          state.resizeTimer = null;
        }
        var delay = immediate ? 0 : 100;
        state.resizeTimer = setTimeout(function() {
          state.resizeTimer = null;
          requestAnimationFrame(syncTerminalSize);
        }, delay);
      }

      function syncTerminalSize() {
        var output = document.getElementById("output");
        if (!state.terminal || !state.fitAddon || !output) return;
        if (!shouldResizeTerminalViewport()) return;

        var shouldFollow = state.terminalAutoFollow || isTerminalNearBottom();
        state.fitAddon.fit();
        if (shouldFollow) {
          maybeScrollTerminalToBottom("resize");
        }

        var nextSize = {
          cols: state.terminal.cols,
          rows: state.terminal.rows
        };

        if (!state.selectedId) return;

        // Only send resize API call if dimensions actually changed
        if (state.lastResize.cols !== nextSize.cols || state.lastResize.rows !== nextSize.rows) {
          state.lastResize = nextSize;
          fetch("/api/sessions/" + state.selectedId + "/resize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(nextSize)
          }).catch(function() {});
        }
      }

      function startPolling() {
        stopPolling();
        // Use WebSocket if available, fallback to polling
        if (initWebSocket()) {
          // WebSocket will deliver updates; no need for initial refreshAll()
          // since the caller (restoreLoginSession) already called refreshAll()
          return;
        }
        // Fallback to HTTP polling
        state.pollTimer = setInterval(refreshAll, 1600);
      }

      function initWebSocket() {
        if (!window.WebSocket) return false;

        // Prevent duplicate connections
        if (state.ws) {
          try { state.ws.close(); } catch (e) { /* ignore */ }
          state.ws = null;
        }

        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var wsUrl = protocol + '//' + window.location.host + '/ws';

        try {
          var ws = new WebSocket(wsUrl);

          ws.onopen = function() {
            state.ws = ws;
            state.wsConnected = true;
            // Subscribe to current session if any
            subscribeToSession(state.selectedId);
            // Flush pending messages after reconnection
            flushPendingMessages();
          };

          ws.onmessage = function(event) {
            try {
              var msg = JSON.parse(event.data);
              handleWebSocketMessage(msg);
            } catch (e) {
              // Ignore parse errors
            }
          };

          ws.onclose = function() {
            state.ws = null;
            state.wsConnected = false;
            // Reconnect after 2 seconds
            setTimeout(function() {
              if (state.config && !state.ws) {
                initWebSocket();
              }
            }, 2000);
          };

          ws.onerror = function() {
            ws.close();
          };

          return true;
        } catch (e) {
          return false;
        }
      }

      function handleWebSocketMessage(msg) {
        switch (msg.type) {
          case 'output':
            // Update session output (for terminal display and local message parsing)
            if (msg.data && msg.data.output && msg.sessionId) {
              var snapshot = { id: msg.sessionId, output: msg.data.output };
              if (Object.prototype.hasOwnProperty.call(msg.data, 'permissionBlocked')) {
                snapshot.permissionBlocked = !!msg.data.permissionBlocked;
              }
              // Pass structured messages if available from JSON chat mode
              if (msg.data.messages) {
                snapshot.messages = msg.data.messages;
              }
              updateSessionSnapshot(snapshot);
              if (msg.sessionId === state.selectedId) {
                state.currentMessages = getPreferredMessages(snapshot, msg.data.output, false);
                updateTaskDisplay();
                scheduleChatRender();
              }

            }
            // Real-time terminal output
            if (msg.sessionId === state.selectedId && state.terminal && msg.data) {
              if (msg.data.chunk && (!state.terminalSessionId || state.terminalSessionId === msg.sessionId)) {
                // Fast path: write chunk directly to avoid full-output comparison
                // which can trigger terminal.reset() and cause screen flicker.
                state.terminal.write(msg.data.chunk);
                state.terminalSessionId = msg.sessionId;
                if (msg.data.output) {
                  state.terminalOutput = normalizeTerminalOutput(msg.data.output);
                }
                maybeScrollTerminalToBottom("output");
                updateTerminalJumpToBottomButton();
                scheduleMobileDomUpdate();
              } else if (Object.prototype.hasOwnProperty.call(msg.data, "output")) {
                // Fallback: no chunk available, use full-output comparison
                syncTerminalBuffer(msg.sessionId, msg.data.output || "", { mode: "append" });
              }
            }
            break;
          case 'started':
            // New session started
            loadSessions();
            break;
          case 'ended': {
            // Build snapshot from server data; use updateSessionSnapshot so the
            // local update is not lost when loadSessions() later replaces
            // state.sessions entirely.
            var endedStatus = (msg.data && msg.data.status) ? msg.data.status : "exited";
            var endedPermBlocked = (msg.data && Object.prototype.hasOwnProperty.call(msg.data, "permissionBlocked")) ? !!msg.data.permissionBlocked : false;
            var endedSnapshot = { id: msg.sessionId, status: endedStatus, permissionBlocked: endedPermBlocked };
            if (msg.data && msg.data.messages) {
              endedSnapshot.messages = msg.data.messages;
            }
            updateSessionSnapshot(endedSnapshot);

            // Notify user when a session completes (browser + in-app if backgrounded or not viewing)
            var endedSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
            var endedName = endedSession ? (endedSession.label || endedSession.command || msg.sessionId) : msg.sessionId;
            var endedExitCode = msg.data && msg.data.exitCode;
            var endedIsError = endedExitCode !== null && endedExitCode !== undefined && endedExitCode !== 0;
            sendBrowserNotification(
              endedIsError ? "\u4f1a\u8bdd\u5f02\u5e38\u7ed3\u675f" : "\u4f1a\u8bdd\u5df2\u5b8c\u6210",
              endedName,
              {
                tag: "wand-ended-" + msg.sessionId,
                onClick: function() {
                  if (msg.sessionId !== state.selectedId) selectSession(msg.sessionId);
                }
              }
            );
            if (msg.sessionId !== state.selectedId || document.hidden) {
              showNotificationBubble({
                title: endedIsError ? "\u4f1a\u8bdd\u5f02\u5e38\u7ed3\u675f" : "\u4f1a\u8bdd\u5df2\u5b8c\u6210",
                body: endedName,
                type: endedIsError ? "warning" : "success",
                icon: endedIsError ? "!" : "\u2713",
                duration: 6000,
                actionLabel: "\u67e5\u770b",
                action: function() { selectSession(msg.sessionId); }
              });
            }

            // Clear stale queued inputs so they cannot race with the ended session.
            // Each queued item's postInput will hit the server and get an error, but
            // clearing the queues here prevents them from growing unbounded.
            state.messageQueue = [];
            state.pendingMessages = [];

            // Disable terminal interactive mode immediately so the terminal stops
            // capturing keystrokes before loadSessions() completes.
            if (msg.sessionId === state.selectedId) {
              setTerminalInteractive(false);
              state.currentTask = null;
              updateTaskDisplay();
            }

            // Update UI chrome immediately; loadSessions() will refresh the sessions
            // list asynchronously (which may already be in-flight from a poll tick).
            if (msg.sessionId === state.selectedId) {
              updateShellChrome();
            }

            loadSessions();
            if (msg.sessionId === state.selectedId) {
              loadOutput(msg.sessionId);
            }
            break;
          }
          case 'init':
            // Initial state for subscribed session (after reconnect or subscription)
            if (msg.sessionId === state.selectedId && msg.data) {
              if (chatRenderTimer) { clearTimeout(chatRenderTimer); chatRenderTimer = null; }
              updateTerminalOutput(msg.data.output || "", msg.sessionId, "replace");
              // Ensure terminal is properly fitted after receiving initial data
              scheduleTerminalResize(true);
            }
            break;
          case 'usage':
            // Token usage events are processed server-side; per-message usage is read from msg.usage
            break;
          case 'task':
            // Current task update from Claude's tool execution
            if (msg.sessionId === state.selectedId) {
              state.currentTask = msg.data || null;
              updateTaskDisplay();
            }
            break;
          case 'status':
            if (msg.sessionId && msg.data) {
              var statusUpdate = { id: msg.sessionId };
              if (Object.prototype.hasOwnProperty.call(msg.data, 'permissionBlocked')) {
                statusUpdate.permissionBlocked = !!msg.data.permissionBlocked;
              }
              if (msg.data.permissionRequest) {
                statusUpdate.pendingEscalation = {
                  scope: msg.data.permissionRequest.scope,
                  target: msg.data.permissionRequest.target,
                  reason: msg.data.permissionRequest.prompt
                };
                // Browser notification for permission waiting (background tab)
                var permSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
                var permSessionName = permSession ? (permSession.label || permSession.command || msg.sessionId) : msg.sessionId;
                sendBrowserNotification(
                  "\u4f1a\u8bdd\u7b49\u5f85\u6388\u6743",
                  permSessionName + " \u2014 " + (msg.data.permissionRequest.prompt || "\u9700\u8981\u6743\u9650\u5ba1\u6279"),
                  {
                    tag: "wand-perm-" + msg.sessionId,
                    onClick: function() {
                      if (msg.sessionId !== state.selectedId) {
                        selectSession(msg.sessionId);
                      }
                    }
                  }
                );
                // In-app bubble if not currently viewing this session
                if (msg.sessionId !== state.selectedId) {
                  showNotificationBubble({
                    title: "\u4f1a\u8bdd\u7b49\u5f85\u6388\u6743",
                    body: permSessionName + " \u2014 " + (msg.data.permissionRequest.prompt || "\u9700\u8981\u6743\u9650\u5ba1\u6279"),
                    type: "warning",
                    icon: "!",
                    duration: 0,
                    actionLabel: "\u67e5\u770b",
                    action: function() {
                      selectSession(msg.sessionId);
                    }
                  });
                }
              }
              if (msg.data.permissionBlocked === false) {
                statusUpdate.pendingEscalation = null;
              }
              updateSessionSnapshot(statusUpdate);
              if (msg.sessionId === state.selectedId) {
                updateTaskDisplay();
              }
            }
            break;
          case 'notification':
            if (msg.data) {
              if (msg.data.kind === "update") {
                showNotificationBubble({
                  title: "\u53d1\u73b0\u65b0\u7248\u672c",
                  body: "\u5f53\u524d " + (msg.data.current || "-") + " \u2192 \u6700\u65b0 " + (msg.data.latest || "-"),
                  type: "info",
                  icon: "\u2191",
                  duration: 0,
                  actionLabel: "\u53bb\u66f4\u65b0",
                  action: function() {
                    var settingsBtn = document.getElementById("open-settings-btn") || document.querySelector("[data-action='settings']");
                    if (settingsBtn) settingsBtn.click();
                  }
                });
                sendBrowserNotification(
                  "Wand \u53d1\u73b0\u65b0\u7248\u672c",
                  "\u5f53\u524d " + (msg.data.current || "-") + " \u2192 \u6700\u65b0 " + (msg.data.latest || "-"),
                  { tag: "wand-update" }
                );
              }
            }
            break;
        }
      }

      function updateTaskDisplay() {
        var taskEl = document.getElementById("current-task");
        var permissionActionsEl = document.getElementById("permission-actions");
        var permissionLabel = document.getElementById("permission-actions-label");
        if (!taskEl) return;
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var pendingEscalation = selectedSession && selectedSession.pendingEscalation ? selectedSession.pendingEscalation : null;
        var isBlocked = pendingEscalation || (selectedSession && selectedSession.permissionBlocked);

        if (isBlocked) {
          // Show permission label in input composer area
          if (permissionLabel) {
            if (pendingEscalation) {
              var reason = pendingEscalation.reason || "等待授权";
              var target = pendingEscalation.target ? " · " + pendingEscalation.target : "";
              permissionLabel.textContent = reason + target;
            } else {
              permissionLabel.textContent = "等待授权";
            }
          }
          if (permissionActionsEl) permissionActionsEl.classList.remove("hidden");
          // Hide top task bar — permission info is already shown in the composer
          taskEl.textContent = "";
          taskEl.classList.add("hidden");
          taskEl.classList.remove("permission-blocked");
          return;
        }

        taskEl.classList.remove("permission-blocked");
        if (permissionActionsEl) permissionActionsEl.classList.add("hidden");
        var task = state.currentTask;
        if (task && task.title) {
          taskEl.textContent = task.title;
          taskEl.classList.remove("hidden");
        } else {
          taskEl.textContent = "";
          taskEl.classList.add("hidden");
        }
      }

      function approvePermission() {
        if (!state.selectedId) return;
        var approveBtn = document.getElementById("approve-permission-btn");
        var denyBtn = document.getElementById("deny-permission-btn");
        if (approveBtn) approveBtn.disabled = true;
        if (denyBtn) denyBtn.disabled = true;
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/approve-permission", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              showToast(data.error, "error");
              return;
            }
            updateSessionSnapshot(data);
            updateTaskDisplay();
          })
          .catch(function(error) {
            showToast((error && error.message) || "无法批准授权。", "error");
          })
          .finally(function() {
            if (approveBtn) approveBtn.disabled = false;
            if (denyBtn) denyBtn.disabled = false;
          });
      }

      function denyPermission() {
        if (!state.selectedId) return;
        var approveBtn = document.getElementById("approve-permission-btn");
        var denyBtn = document.getElementById("deny-permission-btn");
        if (approveBtn) approveBtn.disabled = true;
        if (denyBtn) denyBtn.disabled = true;
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/deny-permission", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              showToast(data.error, "error");
              return;
            }
            updateSessionSnapshot(data);
            updateTaskDisplay();
          })
          .catch(function(error) {
            showToast((error && error.message) || "无法拒绝授权。", "error");
          })
          .finally(function() {
            if (approveBtn) approveBtn.disabled = false;
            if (denyBtn) denyBtn.disabled = false;
          });
      }

      function updateTerminalOutput(output, sessionId, mode) {
        if (!state.terminal) return false;
        return syncTerminalBuffer(sessionId || state.selectedId, output, { mode: mode || "append" });
      }

      function stopPolling() {
        if (state.pollTimer) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      }

      function setView(view) {
        state.currentView = view || "terminal";
        if (state.currentView !== "terminal") {
          setTerminalInteractive(false);
          closeKeyboardPopup();
        }
        applyCurrentView();
        reconcileInteractiveState();
        updateTerminalJumpToBottomButton();
        if (state.currentView === "terminal") {
          state.terminalViewportSize = { width: 0, height: 0 };
          scheduleTerminalResize(true);
        }
      }

      function renderChat(forceFullRender) {
        if (state.renderPending && !forceFullRender) return;
        state.renderPending = true;

        if (forceFullRender) {
          // Immediate render for page refresh / session switch
          doRenderChat(true);
          state.renderPending = false;
        } else {
          requestAnimationFrame(function() {
            doRenderChat(false);
            state.renderPending = false;
          });
        }
      }

      var chatRenderTimer = null;
      function scheduleChatRender(immediate) {
        if (chatRenderTimer && !immediate) return;
        if (chatRenderTimer) clearTimeout(chatRenderTimer);
        if (immediate) {
          chatRenderTimer = null;
          // Messages already updated in handleWebSocketMessage, just render
          renderChat();
          return;
        }
        chatRenderTimer = setTimeout(function() {
          chatRenderTimer = null;
          // Re-parse messages from the latest session output (fallback for edge cases)
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (selectedSession) {
            state.currentMessages = getPreferredMessages(selectedSession, selectedSession.output, true);
          }
          renderChat();
        }, 30);
      }

      // Extract system info from PTY output that's not in structured messages
      function extractPtySystemInfo(output, messages) {
        if (!output || !messages || messages.length === 0) return [];
        
        // Strip ANSI escape sequences
        function stripAnsi(text) {
          return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
        }
        
        var clean = stripAnsi(output);
        var systemInfo = [];
        
        // Find user input positions in output
        var userInputs = [];
        for (var i = 0; i < messages.length; i++) {
          if (messages[i].role === 'user') {
            var userText = '';
            var content = messages[i].content;
            if (typeof content === 'string') {
              userText = content;
            } else if (Array.isArray(content)) {
              for (var j = 0; j < content.length; j++) {
                if (content[j].type === 'text') {
                  userText = content[j].text;
                  break;
                }
              }
            }
            if (userText) {
              userInputs.push({ text: userText, index: i });
            }
          }
        }
        
        // Extract content before each user input
        var lastPos = 0;
        for (var i = 0; i < userInputs.length; i++) {
          var userInput = userInputs[i];
          var pos = clean.indexOf('❯ ' + userInput.text, lastPos);
          if (pos === -1) {
            // Try with newline
            pos = clean.indexOf('\n❯ ' + userInput.text, lastPos);
            if (pos !== -1) pos += 1;
          }
          
          if (pos > lastPos) {
            var segment = clean.substring(lastPos, pos);
            // Extract meaningful system info
            var lines = segment.split('\n');
            var infoLines = [];
            for (var j = 0; j < lines.length; j++) {
              var line = lines[j].trim();
              // Skip empty lines, separators, prompts, UI noise
              if (!line || line.startsWith('────') || line === '❯' || line === '?' || line === '') continue;
              
              // Skip Claude Code UI elements
              if (line.includes('Claude Code v') || 
                  (line.includes('Opus') && line.includes('with')) || 
                  (line.includes('Sonnet') && line.includes('with')) ||
                  line.includes('API Usage') || line.includes('Billing') ||
                  line.includes('for shortcuts') || line.includes('/effort') ||
                  line.match(/^[▸▐▝▘▗▖█▌▍▎▏▔▁▂▃▄▅▆▇██]/) ||
                  line.match(/^[▸▐▝▘▗▖█▌▍▎▏▔▁▂▃▄▅▆▇██]{3,}/)) {
                continue;
              }
              
              // Keep meaningful system messages
              if (line.length > 3) {
                infoLines.push(line);
              }
            }
            if (infoLines.length > 0) {
              systemInfo.push({ 
                beforeMessage: userInput.index, 
                content: infoLines.join('\n') 
              });
            }
          }
          lastPos = pos + userInput.text.length + 2; // +2 for '❯ '
        }
        
        return systemInfo;
      }

      function doRenderChat(forceFullRender) {
        var chatOutput = document.getElementById("chat-output");
        if (!chatOutput) return;

        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSession) {
          if (state.lastRenderedEmpty !== "none") {
            chatOutput.innerHTML = '<div class="empty-state"><strong>未选择会话</strong><br>点击上方「新对话」开始你的第一次对话。</div>';
            state.lastRenderedEmpty = "none";
            state.lastRenderedMsgCount = 0;
          }
          return;
        }

        var messages = state.currentMessages;

        if (messages.length === 0) {
          if (state.lastRenderedEmpty !== "empty") {
            chatOutput.innerHTML = '<div class="empty-state"><strong>对话已开始</strong><br>在下方输入框发送消息，Claude 会自动回复。</div>';
            state.lastRenderedEmpty = "empty";
            state.lastRenderedMsgCount = 0;
          }
          return;
        }

        // Check if messages actually changed
        var msgCount = messages.length;
        var outputHash = selectedSession.output ? selectedSession.output.length : 0;
        // For structured messages, hash block count + content lengths for change detection
        if (selectedSession.messages && selectedSession.messages.length > 0) {
          var totalBlocks = 0;
          var contentLen = 0;
          for (var bi = 0; bi < selectedSession.messages.length; bi++) {
            var msgContent = selectedSession.messages[bi].content;
            if (msgContent) {
              if (Array.isArray(msgContent)) {
                totalBlocks += msgContent.length;
                // Include all block content lengths for change detection
                for (var bj = 0; bj < msgContent.length; bj++) {
                  var block = msgContent[bj];
                  if (block.text) contentLen += block.text.length;
                  if (block.thinking) contentLen += block.thinking.length;
                  if (block.content) contentLen += block.content.length; // tool_result content
                  if (block.id) contentLen += block.id.length; // tool_use id
                  if (block.tool_use_id) contentLen += block.tool_use_id.length; // tool_result id
                  if (block.description) contentLen += block.description.length; // tool_use description
                  if (block.input) contentLen += JSON.stringify(block.input).length; // tool_use input
                }
              } else {
                totalBlocks += 1;
                contentLen = String(msgContent).length;
              }
            }
          }
          outputHash = msgCount * 100000 + totalBlocks * 1000 + contentLen;
        }

        // Force full render if message count changed or explicitly requested
        var forceRender = forceFullRender || msgCount !== state.lastRenderedMsgCount;
        if (!forceRender && msgCount === state.lastRenderedMsgCount && outputHash === state.lastRenderedHash) {
          return;
        }
        var prevHash = state.lastRenderedHash;
        var prevMsgCount = state.lastRenderedMsgCount;
        state.lastRenderedMsgCount = msgCount;
        state.lastRenderedHash = outputHash;

        var chatMessages = chatOutput.querySelector(".chat-messages");
        if (!chatMessages) {
          // First render - create container
          chatOutput.innerHTML = '<div class="chat-messages"></div>';
          chatMessages = chatOutput.querySelector(".chat-messages");
        }

        var existingCount = chatMessages.querySelectorAll(".chat-message").length;
        // Full render when: forced, no existing messages, or message count decreased/changed
        var needsFullRender = forceRender || existingCount === 0 || msgCount !== existingCount;

        function fullRenderChat() {
          // Extract system info from PTY output
          var systemInfo = extractPtySystemInfo(selectedSession.output, messages);
          
          // Build HTML with system info cards interleaved
          var html = '';
          var reversedMessages = messages.slice().reverse();
          var msgCount = messages.length;
          
          for (var i = 0; i < reversedMessages.length; i++) {
            var msg = reversedMessages[i];
            var originalIndex = msgCount - 1 - i; // Original index in messages array
            
            // Find system info for this message position
            var sysInfo = null;
            for (var j = 0; j < systemInfo.length; j++) {
              if (systemInfo[j].beforeMessage === originalIndex) {
                sysInfo = systemInfo[j];
                break;
              }
            }
            
            // Render system info card if exists
            if (sysInfo) {
              html += '<div class="chat-message system-info">' +
                '<div class="system-info-card">' +
                  '<div class="system-info-header">ℹ️ 系统信息</div>' +
                  '<div class="system-info-content">' + escapeHtml(sysInfo.content) + '</div>' +
                '</div>' +
              '</div>';
            }
            
            // Render message
            html += renderChatMessage(msg);
          }
          
          chatMessages.innerHTML = html;
          attachAllCopyHandlers(chatMessages);
          // Only expand the single newest tool card (first chat-message = newest due to column-reverse)
          var firstMsg = chatMessages.querySelector(".chat-message:not(.system-info)");
          if (firstMsg) {
            var cards = firstMsg.querySelectorAll(".tool-use-card");
            if (cards.length > 0) {
              cards[0].classList.remove("collapsed");
              for (var ci = 1; ci < cards.length; ci++) {
                cards[ci].classList.add("collapsed");
              }
            }
          }
          // Scroll to bottom (newest message) - column-reverse: scrollTop=0 is visual bottom
          requestAnimationFrame(function() {
            smartScrollToBottom(chatMessages);
          });
        }

        // Collapse all tool-use cards except those in the new message elements (marked with animate-in)
        // newEls: NodeList/Array of newly added message elements, or null to keep only the first card expanded
        function collapseOldToolCards(container, newEls) {
          var allCards = container.querySelectorAll(".tool-use-card");
          allCards.forEach(function(c) {
            // Keep expanded if this card is inside a newly added message
            if (newEls) {
              for (var i = 0; i < newEls.length; i++) {
                if (newEls[i].contains(c)) return;
              }
            }
            c.classList.add("collapsed");
          });
        }

        if (needsFullRender) {
          fullRenderChat();
        } else if (msgCount > existingCount) {
          // New messages added — prepend them (column-reverse means prepend = visual append)
          var newMessages = messages.slice(existingCount);
          // Reverse so the newest ends up at the bottom
          newMessages.reverse();
          var fragment = document.createDocumentFragment();
          var insertedEls = [];
          for (var i = 0; i < newMessages.length; i++) {
            var div = document.createElement("div");
            div.innerHTML = renderChatMessage(newMessages[i]);
            var el = div.firstElementChild;
            if (el) {
              el.classList.add("animate-in");
              insertedEls.push(el);
              fragment.appendChild(el);
            }
          }
          chatMessages.insertBefore(fragment, chatMessages.firstChild);
          attachAllCopyHandlers(chatMessages);
          // Collapse all existing cards; new cards (with animate-in) stay expanded
          collapseOldToolCards(chatMessages, insertedEls);
          // Scroll to bottom (newest message) - column-reverse: scrollTop=0 is visual bottom
          requestAnimationFrame(function() {
            smartScrollToBottom(chatMessages);
          });
        } else if (msgCount === existingCount && outputHash !== prevHash) {
          // Same message count but content changed (streaming update). Re-render in place
          // by index so assistant growth, tool cards, and retroactive message fixes all show up.
          var existingEls = Array.from(chatMessages.querySelectorAll(".chat-message"));
          var reversedMessages = messages.slice().reverse();
          var replacedAny = false;
          for (var mi = 0; mi < reversedMessages.length && mi < existingEls.length; mi++) {
            var currentEl = existingEls[mi];
            var tmpWrap = document.createElement("div");
            tmpWrap.innerHTML = renderChatMessage(reversedMessages[mi]);
            var replacementEl = tmpWrap.firstElementChild;
            if (!replacementEl) continue;
            if (currentEl.innerHTML !== replacementEl.innerHTML || currentEl.className !== replacementEl.className) {
              chatMessages.replaceChild(replacementEl, currentEl);
              attachCopyHandler(replacementEl);
              replacedAny = true;
            }
          }
          if (replacedAny) {
            requestAnimationFrame(function() {
              smartScrollToBottom(chatMessages);
            });
            var newestMsgEl = chatMessages.querySelector(".chat-message");
            var allCards = chatMessages.querySelectorAll(".tool-use-card");
            var newestCard = null;
            allCards.forEach(function(c) {
              if (newestMsgEl && newestMsgEl.contains(c)) {
                if (!newestCard) newestCard = c;
                else c.classList.add("collapsed");
              } else {
                c.classList.add("collapsed");
              }
            });
          }
        } else if (msgCount < existingCount) {
          fullRenderChat();
        }

        // Update todo progress bar from latest messages
        updateTodoProgress(messages);
      }

      // Smart scroll: only auto-scroll if user is near bottom
      // column-reverse: scrollTop near 0 = visual bottom (newest messages)
      function smartScrollToBottom(container) {
        var chatMsgs = container.querySelector ? container.querySelector(".chat-messages") : container;
        if (!chatMsgs) chatMsgs = container;
        var threshold = 200;
        // column-reverse: scrollTop=0 is the visual bottom; positive = scrolled up
        var isNearBottom = chatMsgs.scrollTop < threshold;
        if (isNearBottom) {
          chatMsgs.scrollTop = 0;
        }
      }

      // --- Todo progress bar ---
      var todoExpanded = false;
      // Use event delegation for todo toggle (more robust than binding to specific element)
      document.addEventListener("click", function(e) {
        var target = e.target;
        if (!target || !(target instanceof Element)) return;
        var toggle = target.closest("#todo-progress-toggle");
        if (!toggle) return;
        e.preventDefault();
        e.stopPropagation();
        todoExpanded = !todoExpanded;
        var prog = document.getElementById("todo-progress");
        var body = document.getElementById("todo-progress-body");
        if (prog && body) {
          if (todoExpanded) {
            prog.classList.add("expanded");
            body.classList.remove("hidden");
          } else {
            prog.classList.remove("expanded");
            body.classList.add("hidden");
          }
        }
      });

      function updateTodoProgress(messages) {
        var todos = null;
        // Scan all messages for latest TodoWrite tool_use
        for (var i = messages.length - 1; i >= 0; i--) {
          var msg = messages[i];
          if (!msg.content || !Array.isArray(msg.content)) continue;
          for (var j = msg.content.length - 1; j >= 0; j--) {
            var block = msg.content[j];
            if (block.type === "tool_use" && block.name === "TodoWrite" && block.input && block.input.todos) {
              todos = block.input.todos;
              break;
            }
          }
          if (todos) break;
        }

        var container = document.getElementById("todo-progress");
        if (!container) return;

        if (!todos || todos.length === 0) {
          container.classList.add("hidden");
          return;
        }

        container.classList.remove("hidden");

        var completed = 0;
        var inProgress = 0;
        var activeTask = "";
        for (var k = 0; k < todos.length; k++) {
          if (todos[k].status === "completed") completed++;
          if (todos[k].status === "in_progress") {
            inProgress++;
            if (!activeTask) {
              activeTask = todos[k].activeForm || todos[k].content || "";
            }
          }
        }

        // 显示当前执行步骤 = 已完成 + 正在进行（如果有）
        var currentStep = completed + inProgress;
        var allDone = completed === todos.length;
        if (allDone) {
          // Hide todo when all tasks are completed
          container.classList.add("hidden");
          return;
        } else {
          container.classList.remove("all-done");
        }

        var counter = document.getElementById("todo-progress-counter");
        if (counter) counter.textContent = currentStep + "/" + todos.length;

        var task = document.getElementById("todo-progress-task");
        if (task) task.textContent = activeTask;

        // Render expanded list
        var list = document.getElementById("todo-progress-list");
        if (list) {
          var html = "";
          for (var m = 0; m < todos.length; m++) {
            var t = todos[m];
            var st = t.status || "pending";
            var itemClass = st === "in_progress" ? "active" : st === "completed" ? "done" : "";
            var iconClass = st === "in_progress" ? "active" : st === "completed" ? "done" : "pending";
            var icon = st === "completed" ? "✓" : st === "in_progress" ? "›" : "○";
            html += '<li class="todo-progress-item ' + itemClass + '">' +
              '<span class="todo-item-icon ' + iconClass + '">' + icon + '</span>' +
              '<span>' + escapeHtml(t.content || "") + '</span>' +
            '</li>';
          }
          list.innerHTML = html;
        }

        // Extract recent important actions for key points summary
        var recentActions = [];
        var actionTools = ["Write", "Edit", "Bash", "WebFetch", "WebSearch"];
        var msgCount = messages.length;
        for (var ai = 0; ai < msgCount && recentActions.length < 5; ai++) {
          var m = messages[ai];
          if (!m.content || !Array.isArray(m.content)) continue;
          for (var bi = 0; bi < m.content.length && recentActions.length < 5; bi++) {
            var blk = m.content[bi];
            if (blk.type !== "tool_use") continue;
            var toolName = blk.name || "";
            if (actionTools.indexOf(toolName) === -1) continue;
            var desc = blk.description || generateInputSummary(toolName, blk.input) || toolName;
            if (desc && desc.length > 50) desc = desc.slice(0, 47) + "...";
            var icon = getToolIcon(toolName);
            recentActions.push({ icon: icon, text: desc });
          }
        }

        var actionsEl = document.getElementById("recent-actions");
        if (actionsEl) {
          if (recentActions.length > 0) {
            var actionsHtml = '<div class="recent-actions-label">最近操作</div>';
            actionsHtml += '<div class="recent-actions-list">';
            for (var ri = 0; ri < recentActions.length; ri++) {
              var a = recentActions[ri];
              actionsHtml += '<span class="recent-action-pill">' + a.icon + ' ' + escapeHtml(a.text) + '</span>';
            }
            actionsHtml += '</div>';
            actionsEl.innerHTML = actionsHtml;
          } else {
            actionsEl.innerHTML = '';
          }
        }
      }

      function updateQueueCounter() {
        var counter = document.getElementById("queue-counter");
        if (!counter) return;
        var count = state.messageQueue.length;
        if (count > 0) {
          counter.textContent = "队列: " + count;
          counter.classList.remove("hidden");
        } else {
          counter.classList.add("hidden");
        }
      }

      function attachCopyHandler(el) {
        el.querySelectorAll(".code-copy").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var codeBlock = btn.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              navigator.clipboard.writeText(code.textContent || "").then(function() {
                btn.textContent = "Copied!";
                btn.classList.add("copied");
                setTimeout(function() {
                  btn.textContent = "Copy";
                  btn.classList.remove("copied");
                }, 2000);
              });
            }
          });
        });
      }

      function attachAllCopyHandlers(container) {
        container.querySelectorAll(".code-copy").forEach(function(btn) {
          // Remove existing listeners by cloning
          var clone = btn.cloneNode(true);
          btn.parentNode.replaceChild(clone, btn);
          clone.addEventListener("click", function() {
            var codeBlock = clone.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              navigator.clipboard.writeText(code.textContent || "").then(function() {
                clone.textContent = "Copied!";
                clone.classList.add("copied");
                setTimeout(function() {
                  clone.textContent = "Copy";
                  clone.classList.remove("copied");
                }, 2000);
              });
            }
          });
        });
        // Attach message-level copy buttons for touch devices
        attachMessageCopyButtons(container);
      }

      // ===== Mobile message copy (long-press or tap copy button) =====
      var _msgCopyState = { timer: null, activeBtn: null };

      function attachMessageCopyButtons(container) {
        var isTouch = window.matchMedia("(pointer: coarse)").matches;
        if (!isTouch) return;
        container.querySelectorAll(".chat-message").forEach(function(msgEl) {
          if (msgEl.querySelector(".msg-copy-btn")) return; // already attached
          var bubble = msgEl.querySelector(".chat-message-bubble");
          if (!bubble) return;
          var btn = document.createElement("button");
          btn.className = "msg-copy-btn";
          btn.textContent = "复制";
          btn.addEventListener("click", function(e) {
            e.stopPropagation();
            var text = bubble.innerText || bubble.textContent || "";
            navigator.clipboard.writeText(text.trim()).then(function() {
              btn.textContent = "已复制";
              btn.classList.add("copied");
              setTimeout(function() {
                btn.textContent = "复制";
                btn.classList.remove("copied");
                btn.classList.remove("visible");
              }, 1500);
            });
          });
          msgEl.appendChild(btn);
        });
      }

      // Long-press to show copy button on chat messages
      (function initMobileCopyLongPress() {
        var isTouch = window.matchMedia("(pointer: coarse)").matches;
        if (!isTouch) return;

        var longPressTimer = null;
        var touchStartY = 0;

        document.addEventListener("touchstart", function(e) {
          var msgEl = e.target.closest(".chat-message");
          if (!msgEl) return;
          var bubble = msgEl.querySelector(".chat-message-bubble");
          if (!bubble) return;
          touchStartY = e.touches[0].clientY;
          longPressTimer = setTimeout(function() {
            var btn = msgEl.querySelector(".msg-copy-btn");
            if (btn) {
              // Hide any other visible copy buttons
              document.querySelectorAll(".msg-copy-btn.visible").forEach(function(b) {
                b.classList.remove("visible");
              });
              btn.classList.add("visible");
            }
          }, 500);
        }, { passive: true });

        document.addEventListener("touchmove", function(e) {
          if (longPressTimer && Math.abs(e.touches[0].clientY - touchStartY) > 10) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        }, { passive: true });

        document.addEventListener("touchend", function() {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        }, { passive: true });

        // Dismiss copy buttons when tapping elsewhere
        document.addEventListener("click", function(e) {
          if (!e.target.closest(".msg-copy-btn")) {
            document.querySelectorAll(".msg-copy-btn.visible").forEach(function(b) {
              b.classList.remove("visible");
            });
          }
        });
      })();

      // ===== Terminal copy button for mobile =====
      // ===== Mobile DOM terminal view =====
      function initMobileDomTerminal(container) {
        var isTouch = window.matchMedia("(pointer: coarse)").matches;
        if (!isTouch) return;
        // Gated by experimental config flag
        if (!state.config || !state.config.experimentalDomTerminal) return;

        // Create DOM view container
        var domView = document.createElement("div");
        domView.className = "terminal-dom-view active";
        container.appendChild(domView);

        // Apply current scale
        if (state.terminalScale !== 1) {
          domView.style.fontSize = (state.terminalBaseFontSize * state.terminalScale) + "px";
        }

        // Hide xterm rendering layer but preserve layout for FitAddon
        // Use visibility:hidden instead of display:none so fit() can compute cols/rows
        setTimeout(function() {
          var xtermEl = container.querySelector(".xterm");
          if (xtermEl) {
            xtermEl.style.visibility = "hidden";
            xtermEl.style.position = "absolute";
            xtermEl.style.pointerEvents = "none";
          }
        }, 100);

        // Save reference
        state.terminalDomView = domView;
        state.terminalDomUpdateTimer = null;

        // Scroll events for auto-follow
        domView.addEventListener("scroll", function() {
          var distance = domView.scrollHeight - domView.clientHeight - domView.scrollTop;
          if (distance <= state.terminalScrollThreshold) {
            state.terminalAutoFollow = true;
            clearTerminalScrollIdleTimer();
            updateTerminalJumpToBottomButton();
          } else {
            setTerminalManualScrollActive();
          }
        }, { passive: true });

        domView.addEventListener("touchmove", function() {
          setTerminalManualScrollActive();
        }, { passive: true });

        // Trigger initial render
        scheduleMobileDomUpdate();
      }

      function updateMobileDomView() {
        if (!state.terminalDomView || !state.serializeAddon) return;

        try {
          var html = state.serializeAddon.serializeAsHTML({
            includeGlobalBackground: true
          });

          // Extract the <pre>...</pre> portion
          var match = html.match(/<pre[\s\S]*<\/pre>/);
          var preHtml = match ? match[0] : "";

          // Fix colors for dark background
          preHtml = fixDarkTerminalColors(preHtml);

          // Skip update if content unchanged
          if (preHtml === state._lastDomHtml) return;
          state._lastDomHtml = preHtml;

          // Preserve scroll position for non-auto-follow mode
          var wasAtBottom = state.terminalAutoFollow;
          var scrollTop = state.terminalDomView.scrollTop;

          state.terminalDomView.innerHTML = preHtml;

          if (wasAtBottom) {
            state.terminalDomView.scrollTop = state.terminalDomView.scrollHeight;
          } else {
            state.terminalDomView.scrollTop = scrollTop;
          }
        } catch (e) {
          // Fallback: plain text if serialize fails
          if (state.terminal && state.terminal.buffer) {
            var buf = state.terminal.buffer.active;
            var lines = [];
            for (var i = 0; i < buf.length; i++) {
              var line = buf.getLine(i);
              if (line) lines.push(line.translateToString(true));
            }
            var text = lines.join("\n").replace(/\n+$/, "");
            state.terminalDomView.innerHTML = '<pre>' + escapeHtml(text) + '</pre>';
            if (state.terminalAutoFollow) {
              state.terminalDomView.scrollTop = state.terminalDomView.scrollHeight;
            }
          }
        }
      }

      // Fix serialize addon's color issues on dark terminal background
      function fixDarkTerminalColors(html) {
        // Theme reference: bg=#1f1b17, fg=#f5eadc, black=#1f1b17, brightBlack=#625347
        // 1. Hardcoded inverse: black text on gray → theme fg on theme brightBlack bg
        html = html.replace(
          /color:\s*#000000;\s*background-color:\s*#BFBFBF/g,
          "color: #f5eadc; background-color: #625347"
        );
        // 2. Fix colors inside style attributes that are too dark to read on #1f1b17 background
        html = html.replace(/style='([^']*)'/g, function(match, styles) {
          // Extract the color value (not background-color)
          return "style='" + styles.replace(
            /\bcolor:\s*(#[0-9a-fA-F]{6})\b/g,
            function(colorMatch, hex) {
              // Check if this is actually a background-color (skip it)
              var beforeColor = styles.substring(0, styles.indexOf(colorMatch));
              if (beforeColor.lastIndexOf("background-") > beforeColor.lastIndexOf(";")) {
                return colorMatch; // This is background-color, leave it
              }
              if (isColorTooDark(hex)) {
                return "color: #625347"; // Use brightBlack
              }
              return colorMatch;
            }
          ) + "'";
        });
        return html;
      }

      function isColorTooDark(hex) {
        // Parse hex color and check relative luminance
        var r = parseInt(hex.substring(1, 3), 16);
        var g = parseInt(hex.substring(3, 5), 16);
        var b = parseInt(hex.substring(5, 7), 16);
        // Simple perceived brightness: if below threshold, it's too dark for #1f1b17 bg
        var brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness < 45; // #1f1b17 has brightness ~22, threshold catches colors close to it
      }

      function scheduleMobileDomUpdate() {
        if (!state.terminalDomView) return;
        // Trailing-edge debounce: reset timer on each call to batch rapid updates
        if (state.terminalDomUpdateTimer) {
          clearTimeout(state.terminalDomUpdateTimer);
        }
        state.terminalDomUpdateTimer = setTimeout(function() {
          state.terminalDomUpdateTimer = null;
          updateMobileDomView();
        }, 150);
      }

      function parseMessages(output, command) {
        var messages = [];
        if (!output) return messages;

        var text = String(output || "");
        var newline = String.fromCharCode(10);
        var carriageReturn = String.fromCharCode(13);
        var esc = String.fromCharCode(27);

        // Optimized ANSI escape sequence stripping
        // Handles: CSI sequences, OSC sequences, single-character escapes, control chars
        var nul = String.fromCharCode(0);
        var bs = String.fromCharCode(8);
        var vt = String.fromCharCode(11);
        var ff = String.fromCharCode(12);
        var so = String.fromCharCode(14);
        var us = String.fromCharCode(31);
        var nbsp = String.fromCharCode(160);
        var bel = String.fromCharCode(7);
        var ansiRegex = new RegExp(
          esc + '\\[[0-9;?]*[a-zA-Z]|' +  // CSI sequences
          esc + '\\][^' + bel + ']*(' + bel + '|' + esc + '\\\\\\\\)|' +  // OSC sequences - matches ESC ] ... (BEL or ESC \)
          esc + '[><=eP_X^]|' +  // Single-character escapes
          '[' + nul + '-' + bs + vt + ff + so + '-' + us + ']|' +  // Control chars: 0-8, 11, 12, 14-31
          nbsp + '|' + carriageReturn,
          'g'
        );
        var ansiStripped = text.replace(
          ansiRegex,
          function(m) { return m === nbsp ? ' ' : m === carriageReturn ? newline : ''; }
        ).split(carriageReturn).join(newline);

        var lines = ansiStripped.split(newline).map(function(line) { return line.trim(); }).filter(Boolean);

        // Extract thinking/deep thought content
        var thinkingPatterns = [
          /thinking with high effort/i,
          /thinking with medium effort/i,
          /thinking with low effort/i,
          new RegExp("thought for [0-9]+s", "i"),
          new RegExp("Sauteed for [0-9]+m", "i"),
          /Germinating/i,
          /Doodling/i,
          /Brewing/i
        ];

        // Find the most recent thinking line (usually appears after user input)
        var lastThinkingLine = null;
        var userCmdIndex = -1;

        // Separate different types of content
        var promptLines = [];  // Try "..." suggestions
        var contentLines = []; // Actual conversation content
        var thinkingLines = [];

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          // Check for prompt suggestions (Try "..." pattern, including after ❯)
          var lineForPromptCheck = line.replace(/^❯\s*/, "");
          if (lineForPromptCheck.indexOf('Try"') === 0 || lineForPromptCheck.indexOf('Try "') === 0) {
            promptLines.push(lineForPromptCheck);
            continue;
          }

          // Check for thinking content
          var isThinking = false;
          for (var p = 0; p < thinkingPatterns.length; p++) {
            if (thinkingPatterns[p].test(line)) {
              isThinking = true;
              thinkingLines.push(line);
              break;
            }
          }
          if (isThinking) continue;

          // Filter noise
          if (!line) continue;
          if (line.indexOf("────────────────") === 0) continue;
          if (line === "❯") continue;
          if (line.indexOf("esc to interrupt") !== -1) continue;
          if (line.indexOf("Claude Code v") !== -1) continue;
          if (line.indexOf("Sonnet") !== -1) continue;
          if (line.indexOf("~/") === 0) continue;
          if (line.indexOf("● high") !== -1) continue;
          if (line.indexOf("Failed to install Anthropic marketplace") !== -1) continue;
          if (line.indexOf("Claude Code has switched from npm to native installer") !== -1) continue;
          if (line.indexOf("Fluttering") !== -1) continue;
          if (line.indexOf("? for shortcuts") !== -1) continue;
          if (line.indexOf("0;") === 0) continue;
          if (line.indexOf("9;") === 0) continue;
          if (line.indexOf("Claude is waiting") !== -1) continue;
          if (line.indexOf("✢") !== -1 || line.indexOf("✳") !== -1 || line.indexOf("✶") !== -1 || line.indexOf("✻") !== -1 || line.indexOf("✽") !== -1) continue;
          if (line.indexOf("▐") === 0 || line.indexOf("▝") === 0 || line.indexOf("▘") === 0) continue;
          if ((line === "lu" || line === "ue" || line === "tr" || line === "ti" || line === "g" || line === "n" || line === "i…" || line === "…" || line === "uts" || line === "lt" || line === "rg" || line === "·") && line.length < 4) continue;
          if (line.indexOf("✽F") === 0 || line.indexOf("✻F") === 0) continue;
          // Additional noise filters
          if (line.indexOf("npm WARN") !== -1) continue;
          if (line.indexOf("npm notice") !== -1) continue;
          if (line.indexOf("added ") !== -1 && line.indexOf(" packages") !== -1) continue;
          if (line.indexOf("audited ") !== -1) continue;
          if (line.indexOf("found ") !== -1 && line.indexOf(" vulnerabilities") !== -1) continue;
          if (line.indexOf("Using ") !== -1 && line.indexOf(" for ") !== -1 && line.indexOf("session") !== -1) continue;
          if (line.indexOf("You can use") !== -1) continue;
          if (line.indexOf("Press ") !== -1 && line.indexOf(" for") !== -1) continue;
          if (line.indexOf("type ") === 0 && line.indexOf(" to ") !== -1) continue;
          if (line.indexOf("[wand]") === 0) continue;
          if (line.indexOf("Captured Claude session ID") !== -1) continue;
          // Filter Claude TUI noise patterns
          if (line.indexOf("⏵") !== -1) continue;
          if (line.indexOf("acceptedit") !== -1) continue;
          if (line.indexOf("shift+tab") !== -1) continue;
          if (line.indexOf("tabtocycle") !== -1) continue;
          if (line.indexOf("ctrl+g") !== -1) continue;
          if (line.indexOf("/effort") !== -1) continue;
          if (line.indexOf("Opus") !== -1 && line.indexOf("model") !== -1) continue;
          if (line.indexOf("Haiku") !== -1) continue;
          if (line.indexOf("to cycle") !== -1) continue;
          if (line.indexOf("high ·") !== -1 || line.indexOf("high·") !== -1) continue;
          if (line.indexOf("medium ·") !== -1 || line.indexOf("medium·") !== -1) continue;
          if (line.indexOf("low ·") !== -1 || line.indexOf("low·") !== -1) continue;
          // Strip bullet prefix from Claude TUI output lines (keep the content)
          if (line.indexOf("●") === 0) {
            line = line.slice(1).trim();
            if (!line) continue;
            contentLines.push(line);
            continue;
          }
          // Filter partial/fragmented lines (likely from streaming)
          if (line.length < 3 && !/^[a-zA-Z]{3}$/.test(line)) continue;

          contentLines.push(line);
        }

        // Add thinking message (most recent one, deduplicated)
        if (thinkingLines.length > 0) {
          var lastThinking = thinkingLines[thinkingLines.length - 1];
          var durationMatch = lastThinking.match(new RegExp("for ([0-9]+[ms]+| [0-9]+m [0-9]+s)", "i"));
          var thinkingText = durationMatch ? "深度思考 " + durationMatch[0].replace(/for /i, "") : "深度思考中...";
          messages.push({ role: "thinking", content: thinkingText, type: "deep-thought" });
        }

        // Add prompt suggestion as a special message (pulsing display)
        if (promptLines.length > 0) {
          var promptText = promptLines[promptLines.length - 1].replace(/^Try\s*/, "").trim();
          messages.push({ role: "prompt", content: promptText, type: "suggestion" });
        }

        if (!contentLines.length) return messages;

        // ── Multi-turn conversation parsing ──
        // Find ALL ❯ markers to build multiple user/assistant turn pairs
        var turns = [];
        var currentUserText = null;
        var currentAssistantLines = [];

        for (var i = 0; i < contentLines.length; i++) {
          var line = contentLines[i];

          if (line.indexOf("❯") === 0) {
            var afterPrompt = line.replace(/^❯\s*/, "").trim();

            // Skip prompt suggestions
            if (afterPrompt.indexOf('Try"') === 0 || afterPrompt.indexOf('Try "') === 0) continue;

            // Finalize previous turn if we had a user message
            if (currentUserText !== null && currentAssistantLines.length > 0) {
              turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
              currentAssistantLines = [];
            }

            if (afterPrompt) {
              currentUserText = afterPrompt;
            } else {
              // Standalone ❯ — just a prompt, no user text
              if (currentUserText !== null && currentAssistantLines.length > 0) {
                turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
                currentAssistantLines = [];
              }
              currentUserText = null;
            }
          } else if (currentUserText !== null) {
            // Filter assistant content lines
            if (line.indexOf("⏺") !== -1 && (line.indexOf("Hi!") !== -1 || line.indexOf("Hello") !== -1 || line.indexOf("What") !== -1 || line.indexOf("working") !== -1)) {
              currentAssistantLines.push(line);
            } else if (line.indexOf("⏺") === 0) {
              currentAssistantLines.push(line.slice(1).trim() || line);
            } else if (line.length >= 8) {
              if (line.indexOf("✢") === -1 && line.indexOf("✳") === -1 && line.indexOf("✶") === -1 && line.indexOf("✻") === -1 && line.indexOf("✽") === -1 &&
                  line.indexOf("▐") !== 0 && line.indexOf("▝") !== 0 && line.indexOf("▘") !== 0 &&
                  line.indexOf("esctointerrupt") === -1 && line.indexOf("?for") !== 0 && line.indexOf("? for") !== 0) {
                currentAssistantLines.push(line);
              }
            }
          }
        }

        // Finalize the last turn
        if (currentUserText !== null && currentAssistantLines.length > 0) {
          turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
        }

        // If no ❯-based turns found, try fallback heuristic (first message without ❯)
        if (turns.length === 0) {
          var fallbackUserText = "";
          var fallbackUserIdx = -1;
          for (var i = 0; i < contentLines.length; i++) {
            var line = contentLines[i];
            if (line.indexOf('Try"') === 0 || line.indexOf('Try "') === 0) continue;
            if (line.indexOf('Failed to install') !== -1) continue;
            if (line.indexOf('ctrl+g') !== -1) continue;
            if (line.indexOf('● ') === 0) continue;
            if (line.length < 2 || line.length > 100) continue;
            if (/^[a-zA-Z]/.test(line)) {
              fallbackUserText = line.trim();
              fallbackUserIdx = i;
              break;
            }
          }
          if (fallbackUserText && fallbackUserIdx >= 0) {
            var fallbackAssistant = contentLines.slice(fallbackUserIdx + 1).filter(function(l) {
              return l.length >= 8;
            });
            if (fallbackAssistant.length > 0) {
              turns.push({ user: fallbackUserText, assistantLines: fallbackAssistant });
            }
          }
        }

        // Convert turns to messages
        for (var t = 0; t < turns.length; t++) {
          messages.push({ role: "user", content: turns[t].user });
          if (turns[t].assistantLines.length > 0) {
            var formattedContent = formatAssistantResponse(turns[t].assistantLines.join(newline));
            messages.push({ role: "assistant", content: formattedContent });
          }
        }

        return messages;
      }

      function renderChatMessage(msg) {
        // Thinking card (deep thought) — from PTY parsing
        if (msg.role === "thinking") {
          return '<div class="chat-message thinking">' +
            '<div class="thinking-inline thinking-pty collapsed" data-thinking="" onclick="__thinkingToggle(this)">' +
              '<span class="thinking-inline-icon">🧠</span>' +
              '<span class="thinking-inline-preview">' + escapeHtml(msg.content) + '</span>' +
              '<span class="thinking-inline-action">展开</span>' +
            '</div>' +
          '</div>';
        }

        // Prompt suggestion card (pulsing display) — from PTY parsing
        if (msg.role === "prompt") {
          return '<div class="chat-message prompt">' +
            '<div class="prompt-card">' +
              '<div class="prompt-icon">💡</div>' +
              '<div class="prompt-content">试试：<span class="prompt-text">' + escapeHtml(msg.content) + '</span></div>' +
            '</div>' +
          '</div>';
        }

        // Structured content blocks (from JSON chat mode)
        if (Array.isArray(msg.content)) {
          return renderStructuredMessage(msg);
        }

        // Legacy string content (from PTY parsing)
        var avatar = msg.role === "assistant" ? '<div class="chat-message-avatar">AI</div>' : "";
        var bubbleContent = msg.role === "assistant" ? renderMarkdown(msg.content) : escapeHtml(msg.content);
        return '<div class="chat-message ' + msg.role + '">' +
          avatar +
          '<div class="chat-message-bubble">' + bubbleContent + '</div>' +
        '</div>';
      }

      function renderStructuredMessage(msg) {
        var role = msg.role;
        var avatar = role === "assistant" ? '<div class="chat-message-avatar">AI</div>' : "";

        // Empty content array — streaming placeholder, show typing indicator
        if (!msg.content || msg.content.length === 0) {
          if (role === "assistant") {
            return '<div class="chat-message ' + role + '">' +
              avatar +
              '<div class="chat-message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>' +
            '</div>';
          }
          return "";
        }

        // 先建立 tool_use_id -> tool_result 的映射
        var toolResults = {};
        for (var i = 0; i < msg.content.length; i++) {
          var block = msg.content[i];
          if (block && block.type === "tool_result") {
            var toolUseId = block.tool_use_id;
            if (toolUseId) {
              toolResults[toolUseId] = block;
            }
          }
        }

        var blocksHtml = "";

        try {
          for (var i = 0; i < msg.content.length; i++) {
            var block = msg.content[i];
            try {
              blocksHtml += renderContentBlock(block, role, toolResults, i);
            } catch (e) {
              // Render error for individual block
              blocksHtml += '<div class="render-error">消息块渲染失败</div>';
            }
          }
        } catch (e) {
          // Render error for entire message
          return '<div class="chat-message ' + role + '">' +
            avatar +
            '<div class="chat-message-bubble"><div class="render-error">消息渲染失败</div></div>' +
          '</div>';
        }

        // Build usage indicator for assistant messages
        var usageHtml = "";
        if (role === "assistant" && msg.usage) {
          var u = msg.usage;
          var parts = [];
          if (u.inputTokens !== undefined) parts.push("输入 " + u.inputTokens);
          if (u.outputTokens !== undefined) parts.push("输出 " + u.outputTokens);
          if (u.cacheReadInputTokens !== undefined && u.cacheReadInputTokens > 0) parts.push("缓存 " + u.cacheReadInputTokens);
          if (u.totalCostUsd !== undefined) parts.push("$" + u.totalCostUsd.toFixed(4));
          if (parts.length > 0) {
            usageHtml = '<div class="message-usage">' + parts.join(" · ") + '</div>';
          }
        }

        return '<div class="chat-message ' + role + '">' +
          avatar +
          '<div class="chat-message-bubble">' + blocksHtml + '</div>' +
          usageHtml +
        '</div>';
      }

      function renderContentBlock(block, role, toolResults, index) {
        if (!block || !block.type) return "";

        switch (block.type) {
          case "text":
            return role === "assistant" ? renderMarkdown(block.text || "") : escapeHtml(block.text || "");

          case "thinking":
            var thinkingText = block.thinking || "";
            // Compact display: brain icon + brief text, click to expand
            var preview = thinkingText.length > 60 ? thinkingText.slice(0, 57) + "…" : thinkingText;
            var isStreaming = block.thinking === undefined && block.type === "thinking";
            if (isStreaming) {
              // During streaming: show 3-line scrollable area
              return '<div class="thinking-inline thinking-streaming" data-thinking="">' +
                '<div class="thinking-streaming-inner">' +
                  '<span class="thinking-streaming-icon spinning">🧠</span>' +
                  '<div class="thinking-streaming-text"></div>' +
                '</div>' +
              '</div>';
            }
            return '<div class="thinking-inline collapsed" data-thinking="' + escapeHtml(thinkingText) + '" onclick="__thinkingToggle(this)">' +
              '<span class="thinking-inline-icon">🧠</span>' +
              '<span class="thinking-inline-preview">' + escapeHtml(preview) + '</span>' +
              '<span class="thinking-inline-action">展开</span>' +
            '</div>';

          case "tool_use":
            var toolResult = toolResults[block.id];
            return renderToolUseCard(block, toolResult, index);

          case "tool_result":
            // tool_result 已经在 tool_use 渲染时处理了，不再单独渲染
            return "";

          default:
            return '<div class="unknown-block">' + escapeHtml(JSON.stringify(block)) + '</div>';
        }
      }

      // Lightweight inline display — used for Read, Glob, Grep, WebFetch, WebSearch, TodoRead
      function renderInlineTool(block, toolResult, toolName, fileInfo, extraInfo) {
        var toolId = block.id || "tool-" + toolName;
        var inputData = block.input || {};
        var resultContent = (toolResult && toolResult.content) ? toolResult.content.trim() : "";
        var isError = toolResult && toolResult.is_error;
        var hasResult = resultContent.length > 0;
        var statusIcon = isError ? "⚠️" : (hasResult ? "✅" : "⏳");

        // Build the inline preview line
        var icon = "";
        var title = "";
        var meta = "";
        var preview = "";

        if (toolName === "Read") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C8.405 3.77 9.146 4 10 4h3.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"/><path d="M2 5.5h12M2 8h8M2 10.5h5"/></svg>';
          var path = inputData.file_path || inputData.path || fileInfo || "";
          var lineCount = "";
          if (inputData.limit) {
            lineCount = " " + inputData.offset + "-" + (inputData.offset + inputData.limit);
          }
          title = path;
          meta = lineCount;
        } else if (toolName === "Glob") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M10.5 10.5L14 14"/></svg>';
          var pattern = inputData.pattern || "";
          var gPath = inputData.path || fileInfo || "";
          title = pattern;
          meta = gPath;
        } else if (toolName === "Grep") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M11.5 11.5L15 15"/></svg>';
          var pattern = inputData.pattern || "";
          var gPath = inputData.path || fileInfo || "";
          title = pattern;
          meta = gPath;
          if (inputData.context) meta += " -C" + inputData.context;
        } else if (toolName === "WebFetch") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5v13M1.5 8h13"/></svg>';
          var url = inputData.url || "";
          title = url;
          meta = extraInfo || "";
        } else if (toolName === "WebSearch") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M10.5 10.5L14 14"/><path d="M5 7h4M7 5v4"/></svg>';
          var query = inputData.query || "";
          title = query;
          meta = extraInfo || "";
        } else if (toolName === "TodoRead") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 8l2 2 4-4"/></svg>';
          title = "读取待办列表";
          meta = extraInfo || "";
        } else {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 5v3.5M8 11h.01"/></svg>';
          title = getToolDisplayName(toolName);
          meta = extraInfo || "";
        }

        // Format result preview
        if (hasResult) {
          var lines = resultContent.split("\n");
          if (lines.length > 10) {
            preview = lines.slice(0, 10).join("\n") + "\n…";
          } else {
            preview = resultContent;
          }
        }

        var resultDataAttr = escapeHtml(resultContent);
        var previewDataAttr = escapeHtml(preview);
        var fullResult = resultContent;

        var expandedHtml = "";
        var shouldExpand = hasResult;
        if (hasResult) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? 'block' : 'none') + ';">' +
            '<div class="inline-tool-result">' + formatInlineResult(resultContent, toolName) + '</div>' +
          '</div>';
        } else if (isError) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: none;"><div class="inline-tool-result inline-tool-error">' +
            escapeHtml(resultContent || "操作失败") + '</div></div>';
        } else if (!toolResult) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: none;"><div class="inline-tool-loading">等待响应…</div></div>';
        }

        var extraInfoHtml = meta ? '<span class="inline-tool-meta">' + escapeHtml(meta) + '</span>' : '';
        var extraClass = isError ? 'inline-tool-error-inline' : '';
        if (hasResult) extraClass += ' inline-tool-open';

        return '<div class="inline-tool ' + extraClass + '" ' +
          'data-result="' + escapeHtml(fullResult) + '" ' +
          'data-preview="' + previewDataAttr + '" ' +
          'data-status="' + (isError ? 'error' : (hasResult ? 'done' : 'pending')) + '" ' +
          'onclick="__inlineToolToggle(this)">' +
          '<div class="inline-tool-row">' +
            '<span class="inline-tool-status">' + statusIcon + '</span>' +
            icon +
            '<span class="inline-tool-title">' + escapeHtml(title) + '</span>' +
            extraInfoHtml +
          '</div>' +
          expandedHtml +
        '</div>';
      }

      // Terminal-style display for Bash commands
      function renderTerminalTool(block, toolResult, toolName) {
        var inputData = block.input || {};
        var command = inputData.command || inputData.cmd || "";
        var resultContent = (toolResult && toolResult.content) ? toolResult.content.trim() : "";
        var isError = toolResult && toolResult.is_error;
        var exitCode = inputData.exitCode;
        var hasResult = resultContent.length > 0;

        var statusDot = "";
        if (toolResult) {
          if (isError) {
            statusDot = '<span class="term-status-dot term-error"></span>';
          } else if (exitCode === 0 || exitCode === undefined) {
            statusDot = '<span class="term-status-dot term-success"></span>';
          } else {
            statusDot = '<span class="term-status-dot term-warn"></span>';
          }
        } else {
          statusDot = '<span class="term-status-dot term-running"></span>';
        }

        var prompt = '<span class="term-prompt">$</span>';
        var cmdDisplay = escapeHtml(command);

        var outputLines = resultContent.split("\n");
        var outputHtml = "";
        for (var oi = 0; oi < outputLines.length; oi++) {
          var line = outputLines[oi];
          if (!line && oi === outputLines.length - 1) continue;
          outputHtml += '<div class="term-line">' + escapeHtml(line) + '</div>';
        }

        var exitCodeHtml = "";
        if (toolResult && exitCode !== undefined) {
          var codeClass = exitCode === 0 ? "term-exit-success" : "term-exit-error";
          exitCodeHtml = '<div class="term-exit ' + codeClass + '">exit ' + exitCode + '</div>';
        }

        return '<div class="inline-terminal" data-expanded="true">' +
          '<div class="term-header" onclick="__terminalExpand(this)">' +
            statusDot +
            '<span class="term-title">执行命令</span>' +
            '<span class="term-toggle-icon">▼</span>' +
          '</div>' +
          '<div class="term-body">' +
            '<div class="term-command"><span class="term-prompt">$</span> ' + cmdDisplay + '</div>' +
            (outputHtml ? '<div class="term-output">' + outputHtml + '</div>' : '') +
            exitCodeHtml +
          '</div>' +
        '</div>';
      }

      // GitHub-style diff display for Edit/Write/MultiEdit
      function extractToolResultText(content) {
        if (!content) return "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content.map(function(item) {
            if (!item || typeof item !== "object") return "";
            if (item.type === "text" && typeof item.text === "string") return item.text;
            try {
              return JSON.stringify(item);
            } catch (e) {
              return "";
            }
          }).filter(Boolean).join("\n");
        }
        return "";
      }

      function renderDiffTool(block, toolResult, toolName) {
        var inputData = block.input || {};
        var path = inputData.file_path || inputData.path || "";
        var fileName = path.split("/").pop() || path;

        var oldStr = inputData.old_string || "";
        var newStr = inputData.new_string || inputData.content || "";
        var oldContent = inputData.old_content || "";
        var newContent = inputData.new_content || "";

        var isWrite = toolName === "Write" || toolName === "MultiEdit";
        var isError = toolResult && toolResult.is_error;
        var toolResultText = extractToolResultText(toolResult && toolResult.content);
        var hasResult = !!(toolResultText && toolResultText.trim().length > 0);

        // Build side-by-side diff HTML (old | new columns)
        var leftCol = "";
        var rightCol = "";
        if (isWrite) {
          // Write: only show new content on right
          rightCol = '<div class="diff-line diff-add">+ ' + escapeHtml(newContent) + '</div>';
        } else {
          // Edit: old on left, new on right
          if (oldStr) {
            leftCol = '<div class="diff-line diff-remove">- ' + escapeHtml(oldStr) + '</div>';
          }
          if (newStr) {
            rightCol = '<div class="diff-line diff-add">+ ' + escapeHtml(newStr) + '</div>';
          }
        }

        var statusClass = "";
        var statusText = "";
        if (toolResult) {
          if (isError) {
            statusClass = "diff-error";
            statusText = toolResultText.indexOf("haven't granted") !== -1 || toolResultText.indexOf("permission") !== -1
              ? "⏸ 等待授权"
              : "❌ 修改失败";
          } else {
            statusClass = "diff-success";
            statusText = "✅ 已修改";
          }
        } else {
          statusClass = "diff-pending";
          statusText = "⏳ 执行中…";
        }

        // If only one column has content, show full width
        var bothCols = leftCol && rightCol;
        var colClass = bothCols ? "diff-col-half" : "diff-col-full";

        return '<div class="inline-diff" data-tool-name="' + escapeHtml(toolName) + '">' +
          '<div class="diff-header">' +
            '<span class="diff-file-icon">📄</span>' +
            '<span class="diff-file-name">' + escapeHtml(fileName) + '</span>' +
            '<span class="diff-path">' + escapeHtml(path) + '</span>' +
            '<span class="diff-status ' + statusClass + '">' + statusText + '</span>' +
          '</div>' +
          '<div class="diff-body">' +
            '<div class="diff-columns">' +
              (bothCols ? '<div class="diff-col ' + colClass + '"><div class="diff-col-label">旧</div>' + leftCol + '</div>' : '') +
              '<div class="diff-col ' + colClass + '"><div class="diff-col-label">' + (bothCols ? '新' : '') + '</div>' + (rightCol || leftCol) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }

      function formatInlineResult(content, toolName) {
        if (!content) return '<span class="inline-tool-empty">无输出</span>';
        return '<pre class="inline-tool-result-text" style="max-height: 300px; overflow-y: auto;">' + escapeHtml(content) + '</pre>';
      }

      function renderToolUseCard(block, toolResult, index) {
        var toolName = block.name || "unknown";
        var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);
        var fileInfo = extractFileInfo(toolName, block.input);

        // ── Lightweight inline tools: Read, Glob, Grep, WebFetch, WebSearch, TodoRead
        if (toolName === "Read" || toolName === "Glob" || toolName === "Grep" ||
            toolName === "WebFetch" || toolName === "WebSearch" || toolName === "TodoRead") {
          return renderInlineTool(block, toolResult, toolName, fileInfo, "");
        }

        // ── Terminal-style: Bash
        if (toolName === "Bash") {
          return renderTerminalTool(block, toolResult, toolName);
        }

        // ── Diff-style: Edit, Write, MultiEdit
        if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
          return renderDiffTool(block, toolResult, toolName);
        }

        // ── AskUserQuestion tool — special card
        if (toolName === "AskUserQuestion" && block.input && block.input.questions) {
          var questions = block.input.questions;
          if (questions && questions.length > 0) {
            var question = questions[0];
            var questionText = question.question ? '<div class="ask-user-title">' + escapeHtml(question.question) + '</div>' : "";
            var optionsHtml = "";
            if (question.options && question.options.length > 0) {
              optionsHtml = '<div class="ask-user-options">';
              question.options.forEach(function(opt, idx) {
                var label = opt.label ? escapeHtml(opt.label) : "选项 " + (idx + 1);
                optionsHtml += '<button class="ask-user-option" data-option-index="' + idx + '" data-option-label="' + escapeHtml(label) + '" onclick="__askOption(this)">' +
                  '<div class="ask-user-option-label">' + label + '</div>' +
                '</button>';
              });
              optionsHtml += '</div>';
            }
            return '<div class="tool-use-card ask-user" data-tool-use-id="' + escapeHtml(toolId) + '">' +
              '<div class="tool-use-header" data-tool-toggle onclick="__tcToggle(event,this)">' +
                '<span class="tool-use-icon">❓</span>' +
                '<span class="tool-use-name">提问</span>' +
              '</div>' +
              '<div class="tool-use-body ask-user-body">' +
                questionText +
                optionsHtml +
              '</div>' +
            '</div>';
          }
        }

        // ── Default card rendering for: Agent, Task, TodoWrite, NotebookEdit, Exit, and unknown tools
        var description = block.description || (block.input && block.input.description) || "";
        var summary = generateInputSummary(block.name, block.input);
        var titleText = "";
        var subtitleHtml = "";
        if (description) {
          titleText = description.length > 80 ? description.slice(0, 77) + "..." : description;
          if (fileInfo) {
            subtitleHtml = '<span class="tool-use-file">' + escapeHtml(fileInfo) + '</span>';
          }
        } else {
          titleText = getToolDisplayName(toolName);
          if (fileInfo) {
            subtitleHtml = '<span class="tool-use-file">' + escapeHtml(fileInfo) + '</span>';
          }
          if (summary) {
            subtitleHtml += '<span class="tool-use-summary">' + escapeHtml(summary) + '</span>';
          }
        }
        var fullJson = block.input ? JSON.stringify(block.input, null, 2) : "{}";
        var statusClass = "loading";
        var headerIcon = '<span class="tool-use-spinner"></span>';
        var resultHtml = "";

        if (toolResult) {
          var isError = toolResult.is_error;
          var content = toolResult.content || "";
          statusClass = isError ? "error" : "success";
          headerIcon = getToolIcon(toolName);
          var hasContent = content && content.trim().length > 0;
          if (hasContent) {
            resultHtml = '<pre class="tool-use-result-content">' + escapeHtml(content) + '</pre>';
          } else {
            resultHtml = '<span class="tool-use-result-empty">无输出</span>';
          }
        } else {
          headerIcon = getToolIcon(toolName);
        }

        var collapsedClass = statusClass !== "loading" ? " collapsed" : "";
        var toggleHtml = '<span class="tool-use-toggle">▼</span>';
        return '<div class="tool-use-card ' + statusClass + collapsedClass + '" data-tool-use-id="' + escapeHtml(toolId) + '">' +
          '<div class="tool-use-header" data-tool-toggle onclick="__tcToggle(event,this)">' +
            '<span class="tool-use-icon">' + headerIcon + '</span>' +
            '<span class="tool-use-name">' + escapeHtml(titleText) + '</span>' +
            subtitleHtml +
            toggleHtml +
          '</div>' +
          '<div class="tool-use-body">' +
            (description ? '<div class="tool-use-meta"><span class="tool-use-meta-label">工具：</span>' + escapeHtml(toolName) + '</div>' : '') +
            '<pre class="tool-use-content">' + escapeHtml(fullJson) + '</pre>' +
            (resultHtml ? '<div class="tool-use-result">' + resultHtml + '</div>' : '') +
          '</div>' +
        '</div>';
      }

      function getToolDisplayName(toolName) {
        var names = {
          "Read": "读取文件",
          "Write": "写入文件",
          "Edit": "编辑文件",
          "MultiEdit": "多处编辑",
          "Bash": "执行命令",
          "Grep": "搜索内容",
          "Glob": "查找文件",
          "WebFetch": "获取网页",
          "WebSearch": "搜索网页",
          "Task": "任务",
          "TodoWrite": "更新待办",
          "TodoRead": "读取待办",
          "NotebookEdit": "编辑笔记本",
          "Agent": "子代理",
          "AskUserQuestion": "提问",
          "Exit": "退出"
        };
        return names[toolName] || toolName;
      }

      function getToolIcon(toolName) {
        var icons = {
          "Read": "📄",
          "Write": "✏️",
          "Edit": "📝",
          "MultiEdit": "📝",
          "Bash": "💻",
          "Grep": "🔍",
          "Glob": "📂",
          "WebFetch": "🌐",
          "WebSearch": "🔎",
          "Task": "📋",
          "TodoWrite": "📝",
          "TodoRead": "📋",
          "NotebookEdit": "📓",
          "Agent": "🤖",
          "Exit": "🚪"
        };
        return icons[toolName] || "🔧";
      }

      function generateInputSummary(toolName, input) {
        // 生成工具输入的简洁摘要，避免显示完整 JSON
        if (!input || typeof input !== "object") return "";

        var keys = Object.keys(input);
        if (keys.length === 0) return "{}";

        // 文件操作：只显示操作类型和修改数量，路径已在 header 中显示
        if (toolName === "Read") {
          return "读取文件";
        }
        if (toolName === "Write") {
          return "写入文件";
        }
        if (toolName === "Edit") {
          var edits = input.edits ? input.edits.length : 0;
          return "编辑 (" + edits + " 处修改)";
        }

        // Bash：显示命令
        if (toolName === "Bash") {
          var cmd = input.command || "";
          if (cmd) {
            var cmdPreview = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
            return "命令：" + cmdPreview;
          }
        }

        // Grep：显示模式和路径
        if (toolName === "Grep") {
          var pattern = input.pattern || "";
          var path = input.path || "";
          if (pattern) {
            return "搜索：" + pattern + (path ? " (在 " + path + ")" : "");
          }
        }

        // Glob：显示模式
        if (toolName === "Glob") {
          var pattern = input.pattern || "";
          if (pattern) return "查找：" + pattern;
        }

        // Agent：显示任务
        if (toolName === "Agent") {
          var task = input.prompt || input.task || "";
          if (task) {
            var taskPreview = task.length > 40 ? task.slice(0, 40) + "..." : task;
            return "任务：" + taskPreview;
          }
        }

        // Task：显示任务描述
        if (toolName === "Task") {
          var task = input.task || input.description || "";
          if (task) {
            var taskPreview = task.length > 40 ? task.slice(0, 40) + "..." : task;
            return "任务：" + taskPreview;
          }
        }

        // TodoWrite：显示操作类型
        if (toolName === "TodoWrite") {
          var todos = input.todos || [];
          return "更新待办 (" + todos.length + " 项)";
        }

        // WebSearch：显示查询
        if (toolName === "WebSearch") {
          var query = input.query || "";
          if (query) return "搜索：" + query;
        }

        // 默认：显示第一个 key 和简短值
        var firstKey = keys[0];
        var firstVal = input[firstKey];
        if (typeof firstVal === "string") {
          var valPreview = firstVal.length > 50 ? firstVal.slice(0, 50) + "..." : firstVal;
          return firstKey + ": " + valPreview;
        }
        return keys.length + " 个参数";
      }

      function extractFileInfo(toolName, input) {
        if (!input) return null;
        var path = input.file_path || input.path || input.cwd;
        if (path) {
          // 截断长路径
          if (path.length > 50) {
            return "..." + path.slice(-47);
          }
          return path;
        }
        return null;
      }

      // Format assistant response with Markdown rendering and cleanup
      function formatAssistantResponse(text) {
        if (!text) return "";

        // Clean up the text
        var newline = String.fromCharCode(10);
        var lines = text.split(newline);
        var cleanLines = [];

        // Remove leading/trailing empty lines and common noise
        var started = false;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var trimmed = line.trim();

          // Skip leading empty lines
          if (!started && !trimmed) continue;
          started = true;

          // Filter out noise patterns
          if (trimmed.indexOf("⏺") === 0 && trimmed.length > 2) {
            cleanLines.push(trimmed.slice(1).trim());
            continue;
          }
          // Strip leading ● bullet from Claude TUI output
          if (trimmed.indexOf("●") === 0) {
            trimmed = trimmed.slice(1).trim();
            if (!trimmed) continue;
            line = trimmed;
          }

          cleanLines.push(line);
        }

        // Remove trailing empty lines
        while (cleanLines.length > 0 && !cleanLines[cleanLines.length - 1].trim()) {
          cleanLines.pop();
        }

        // Deduplicate lines (PTY can echo same content multiple times with/without spaces)
        var deduped = [];
        var seenNorm = {};
        for (var j = 0; j < cleanLines.length; j++) {
          var normalized = cleanLines[j].replace(/\s+/g, "");
          if (normalized.length > 5 && seenNorm[normalized]) continue;
          if (normalized.length > 5) seenNorm[normalized] = true;
          deduped.push(cleanLines[j]);
        }

        // Return plain text — renderChatMessage will handle markdown rendering
        return deduped.join(newline);
      }

      function renderMarkdown(text) {
        if (!text) return "";

        var result = escapeHtml(text);
        var bt = String.fromCharCode(96);
        var newline = String.fromCharCode(10);

        function replacePair(source, marker, openTag, closeTag) {
          var cursor = 0;
          while (true) {
            var start = source.indexOf(marker, cursor);
            if (start === -1) break;
            var end = source.indexOf(marker, start + marker.length);
            if (end === -1) break;
            var inner = source.slice(start + marker.length, end);
            if (!inner) {
              cursor = end + marker.length;
              continue;
            }
            var replacement = openTag + inner + closeTag;
            source = source.slice(0, start) + replacement + source.slice(end + marker.length);
            cursor = start + replacement.length;
          }
          return source;
        }

        function replaceLinePrefix(source, marker, openTag, closeTag) {
          return source.split(newline).map(function(line) {
            if (line.indexOf(marker) !== 0) return line;
            return openTag + line.slice(marker.length) + closeTag;
          }).join(newline);
        }

        function replaceOrderedList(source) {
          return source.split(newline).map(function(line) {
            var dotIndex = line.indexOf('. ');
            if (dotIndex <= 0) return line;
            for (var i = 0; i < dotIndex; i += 1) {
              var code = line.charCodeAt(i);
              if (code < 48 || code > 57) return line;
            }
            return '<li>' + line.slice(dotIndex + 2) + '</li>';
          }).join(newline);
        }

        function wrapParagraphs(source) {
          return source.split(newline + newline).map(function(part) {
            var block = part.trim();
            if (!block) return "";
            if (block.indexOf("<div") === 0 || block.indexOf("<h1") === 0 || block.indexOf("<h2") === 0 || block.indexOf("<h3") === 0 || block.indexOf("<h4") === 0 || block.indexOf("<h5") === 0 || block.indexOf("<h6") === 0 || block.indexOf("<ul") === 0 || block.indexOf("<ol") === 0 || block.indexOf("<li") === 0 || block.indexOf("<blockquote") === 0 || block.indexOf("<pre") === 0) {
              return block;
            }
            return '<p>' + block.split(newline).join('<br>') + '</p>';
          }).join("");
        }

        var pos = 0;
        while (true) {
          var start = result.indexOf(bt + bt + bt, pos);
          if (start === -1) break;
          var endTag = result.indexOf(bt + bt + bt, start + 3);
          if (endTag === -1) break;

          var codeBlock = result.slice(start + 3, endTag);
          var langLineEnd = codeBlock.indexOf(newline);
          var lang = "";
          var code = codeBlock;
          if (langLineEnd !== -1 && langLineEnd < 30) {
            var potentialLang = codeBlock.slice(0, langLineEnd).trim();
            var isSimpleLang = potentialLang.length > 0;
            for (var j = 0; j < potentialLang.length; j += 1) {
              var langCode = potentialLang.charCodeAt(j);
              var isDigit = langCode >= 48 && langCode <= 57;
              var isUpper = langCode >= 65 && langCode <= 90;
              var isLower = langCode >= 97 && langCode <= 122;
              if (!isDigit && !isUpper && !isLower) {
                isSimpleLang = false;
                break;
              }
            }
            if (isSimpleLang) {
              lang = potentialLang;
              code = codeBlock.slice(langLineEnd + 1);
            }
          }

          var highlighted = highlightCode(code.trim(), lang);
          var replacement = '<div class="code-block">' +
            '<div class="code-block-header">' +
              '<span class="code-lang">' + (lang || "code") + '</span>' +
              '<button class="code-copy">Copy</button>' +
            '</div>' +
            '<pre><code>' + highlighted + '</code></pre>' +
          '</div>';
          result = result.slice(0, start) + replacement + result.slice(endTag + 3);
          pos = start + replacement.length;
        }

        pos = 0;
        while (true) {
          var inlineStart = result.indexOf(bt, pos);
          if (inlineStart === -1) break;
          var inlineEnd = result.indexOf(bt, inlineStart + 1);
          if (inlineEnd === -1) break;
          if (inlineEnd === inlineStart + 1) {
            pos = inlineEnd + 1;
            continue;
          }
          var inlineCode = result.slice(inlineStart + 1, inlineEnd);
          var inlineReplacement = '<code class="code-inline">' + inlineCode + '</code>';
          result = result.slice(0, inlineStart) + inlineReplacement + result.slice(inlineEnd + 1);
          pos = inlineStart + inlineReplacement.length;
        }

        result = replacePair(result, "**", '<strong>', '</strong>');
        result = replacePair(result, "*", '<em>', '</em>');
        result = replacePair(result, "_", '<em>', '</em>');
        result = replaceLinePrefix(result, "### ", '<h3>', '</h3>');
        result = replaceLinePrefix(result, "## ", '<h2>', '</h2>');
        result = replaceLinePrefix(result, "# ", '<h1>', '</h1>');
        result = replaceLinePrefix(result, "&gt; ", '<blockquote>', '</blockquote>');
        result = replaceLinePrefix(result, "- ", '<li>', '</li>');
        result = replaceLinePrefix(result, "* ", '<li>', '</li>');
        result = replaceOrderedList(result);

        var lines = result.split(newline);
        var grouped = [];
        var listBuffer = [];

        function flushListBuffer() {
          if (!listBuffer.length) return;
          grouped.push('<ul>' + listBuffer.join("") + '</ul>');
          listBuffer = [];
        }

        lines.forEach(function(line) {
          if (line.indexOf('<li>') === 0 && line.lastIndexOf('</li>') === line.length - 5) {
            listBuffer.push(line);
            return;
          }
          flushListBuffer();
          grouped.push(line);
        });
        flushListBuffer();

        result = wrapParagraphs(grouped.join(newline));
        return '<div class="markdown-content">' + result + '</div>';
      }

      function highlightCode(code, lang) {
        // Syntax highlighting - escape HTML for display
        code = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return code;
      }

      function shortCommand(cmd) {
        var s = String(cmd || "").trim();
        return s.length <= 24 ? s || "未选择会话" : s.slice(0, 21) + "...";
      }

      function normalizeTerminalOutput(value) {
        return String(value || "")
          .replace(/\r\r\n/g, "\r\n")
          .replace(/\u0000/g, "");
      }

      function showError(el, msg) {
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

      function hideError(el) {
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

      function showToast(message, type) {
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

      // ── Notification Bubble System ──

      var notificationStack = [];
      var notificationIdCounter = 0;
      var NOTIFICATION_GAP = 8;
      var NOTIFICATION_TOP = 24;

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
      function showNotificationBubble(opts) {
        var id = ++notificationIdCounter;
        var type = opts.type || "info";
        var icon = opts.icon || (type === "warning" ? "!" : type === "success" ? "\u2713" : "i");
        var duration = opts.duration !== undefined ? opts.duration : 8000;

        var bubble = document.createElement("div");
        bubble.className = "notification-bubble";
        bubble.setAttribute("data-nid", id);

        var headerHtml =
          '<div class="notification-bubble-header">' +
            '<span class="notification-bubble-icon ' + type + '">' + icon + '</span>' +
            '<span class="notification-bubble-title">' + escapeHtml(opts.title) + '</span>' +
            '<button class="notification-bubble-close" title="\u5173\u95ed">\u00d7</button>' +
          '</div>';

        var bodyHtml = opts.body
          ? '<div class="notification-bubble-body">' + escapeHtml(opts.body) + '</div>'
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
        var closeBtn = bubble.querySelector(".notification-bubble-close");
        if (closeBtn) closeBtn.onclick = function() { dismissNotification(id); };

        // Wire action button
        if (opts.actionLabel && opts.action) {
          var actionBtn = bubble.querySelector(".notification-bubble-actions button");
          if (actionBtn) actionBtn.onclick = function() {
            opts.action();
            dismissNotification(id);
          };
        }

        // Auto-dismiss
        var timer = null;
        if (duration > 0) {
          timer = setTimeout(function() { dismissNotification(id); }, duration);
        }

        return {
          dismiss: function() { dismissNotification(id); }
        };
      }

      function dismissNotification(id) {
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

      function repositionNotifications() {
        var top = NOTIFICATION_TOP;
        for (var i = 0; i < notificationStack.length; i++) {
          notificationStack[i].el.style.top = top + "px";
          top += notificationStack[i].el.offsetHeight + NOTIFICATION_GAP;
        }
      }

      // ── Browser Notification API ──

      function requestNotificationPermission() {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission();
        }
      }

      function sendBrowserNotification(title, body, opts) {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        if (!document.hidden) return; // Only notify when tab is in background
        try {
          var n = new Notification(title, {
            body: body || "",
            icon: (opts && opts.icon) || "/favicon.ico",
            tag: (opts && opts.tag) || undefined,
          });
          n.onclick = function() {
            window.focus();
            n.close();
            if (opts && opts.onClick) opts.onClick();
          };
          // Auto-close after 10s
          setTimeout(function() { n.close(); }, 10000);
        } catch (_e) {
          // Notification constructor may fail in some contexts (e.g. insecure origin)
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }
    })();
