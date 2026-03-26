    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function(e) {
        console.log('SW registration failed:', e);
      });
    }

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
        terminalSessionId: null,
        terminalOutput: "",
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
        sessionsDrawerOpen: true,
        modalOpen: false,
        presetValue: "",
        commandValue: "",
        cwdValue: "",
        modeValue: "full-access",
        chatMode: "full-access",
        sessionTool: "claude",
        preferredCommand: "claude",
        lastResize: { cols: 0, rows: 0 },
        isOnline: navigator.onLine,
        deferredPrompt: null,
        showInstallPrompt: false,
        ws: null,
        wsConnected: false,
        currentView: "chat",
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
        fileSearchQuery: "",
        allFiles: [],
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
        var prompt = document.getElementById('pwa-install-prompt');
        if (state.showInstallPrompt && state.deferredPrompt && !prompt) {
          var el = document.createElement('div');
          el.id = 'pwa-install-prompt';
          el.className = 'pwa-install-prompt';
          el.innerHTML =
            '<div class="prompt-icon">W</div>' +
            '<div class="prompt-content">' +
              '<div class="prompt-title">Install Wand</div>' +
              '<div class="prompt-desc">Add to home screen for quick access</div>' +
            '</div>' +
            '<div class="prompt-actions">' +
              '<button id="pwa-install-dismiss" class="btn btn-ghost btn-sm">Later</button>' +
              '<button id="pwa-install-accept" class="btn btn-primary btn-sm">Install</button>' +
            '</div>';
          document.body.appendChild(el);
          document.getElementById('pwa-install-dismiss').addEventListener('click', function() {
            el.remove();
            state.showInstallPrompt = false;
          });
          document.getElementById('pwa-install-accept').addEventListener('click', function() {
            state.deferredPrompt.prompt();
            state.deferredPrompt.userChoice.then(function(result) {
              state.deferredPrompt = null;
              state.showInstallPrompt = false;
              el.remove();
            });
          });
        }
      }

      restoreLoginSession();

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
            // Render the app shell first, THEN load session data into it.
            // This avoids refreshAll() rendering chat content that render() immediately destroys.
            try {
              render();
            } catch (_e) {
              // render() may fail if external scripts (xterm.js) failed to load;
              // continue with polling and session loading so the app remains functional
            }
            startPolling();
            return refreshAll();
          })
          .catch(function() {
            state.loginChecked = true;
            render();
          });
      }

      render();

      function render() {
        var app = document.getElementById("app");
        var isLoggedIn = state.config !== null;
        var wasModalOpen = state.modalOpen;

        teardownTerminal();

        app.innerHTML = isLoggedIn ? renderAppShell() : renderLogin();
        // Reset chat render tracking since DOM was fully replaced
        state.lastRenderedHash = 0;
        state.lastRenderedMsgCount = 0;
        state.lastRenderedEmpty = null;
        attachEventListeners();
        updateDrawerState();
        syncComposerModeSelect();
        applyCurrentView();
        updateShellChrome();

        // Restore modal state if it was open
        if (wasModalOpen && state.modalOpen) {
          var modal = document.getElementById("session-modal");
          if (modal) {
            modal.classList.remove("hidden");
            var commandEl = document.getElementById("command");
            var cwdEl = document.getElementById("cwd");
            var modeEl = document.getElementById("mode");
            if (commandEl) commandEl.value = state.commandValue;
            if (cwdEl) cwdEl.value = state.cwdValue;
            if (modeEl) modeEl.value = state.modeValue;
            syncSessionModalUI();
          }
        }
      }

      function renderLogin() {
        if (!state.loginChecked) {
          return '<div class="login-container">' +
            '<div class="login-card">' +
              '<div class="login-header">' +
                '<div class="login-logo">' +
                  '<div class="login-logo-icon">W</div>' +
                  '<span class="login-logo-text">Wand</span>' +
                '</div>' +
                '<div class="login-subtitle">正在恢复登录状态</div>' +
              '</div>' +
              '<div class="login-body">' +
                '<p class="login-hint">正在检查本地登录会话，请稍候。</p>' +
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
              '<p class="login-hint">请输入访问密码</p>' +
              '<p class="login-tip">访问地址请使用 <strong>http://</strong>，不要用 https://。</p>' +
              '<div class="field">' +
                '<label class="field-label" for="password">密码</label>' +
                '<input id="password" type="password" class="field-input" placeholder="输入密码" autocomplete="current-password" data-error="false" />' +
                '<p class="hint">密码至少需要 6 个字符</p>' +
              '</div>' +
              '<button id="login-button" class="btn btn-primary btn-block">进入控制台</button>' +
              '<p id="login-error" class="error-message hidden"></p>' +
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
          '<header class="topbar">' +
            '<div class="topbar-left">' +
              '<button id="sessions-toggle-button" class="btn btn-secondary btn-sm sidebar-toggle-btn' + (state.sessionsDrawerOpen ? ' active' : '') + '" aria-label="Toggle sidebar">' +
                '<span class="hamburger-icon">' +
                  '<span></span><span></span><span></span>' +
                '</span>' +
              '</button>' +
            '</div>' +
            '<div class="logo-wrap">' +
              '<div class="logo">' +
                '<div class="logo-icon">W</div>' +
                '<span class="logo-text">Wand</span>' +
              '</div>' +
            '</div>' +
            '<div class="topbar-center">' +
              '<div class="session-summary">' +
                '<span class="session-summary-value">' + escapeHtml(terminalTitle) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="topbar-right">' +
              '<button id="topbar-new-session-button" class="topbar-new-btn" title="新对话">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                '新对话' +
              '</button>' +
              '<button id="logout-button" class="topbar-logout-btn" title="退出登录">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
                '退出' +
              '</button>' +
            '</div>' +
          '</header>' +
          '<div id="sessions-drawer-backdrop" class="drawer-backdrop' + drawerClass + '"></div>' +
          '<div class="main-layout' + (state.sessionsDrawerOpen ? ' sidebar-open' : '') + '">' +
            '<aside id="sessions-drawer" class="sidebar' + drawerClass + '">' +
              '<div class="sidebar-header">' +
                '<div class="sidebar-header-main">' +
                  '<span class="sidebar-title">会话</span>' +
                  '<span class="session-count" id="session-count">' + String(state.sessions.length) + '</span>' +
                '</div>' +
                '<button id="close-drawer-button" class="btn btn-ghost btn-sm sidebar-close" type="button" aria-label="关闭菜单">×</button>' +
              '</div>' +
              '<div class="sidebar-body">' +
                '<div id="sessions-panel">' +
                  '<p class="sidebar-intro">最近的会话记录会显示在这里</p>' +
                  '<div class="sessions-list" id="sessions-list">' + renderSessions() + '</div>' +
                '</div>' +
              '</div>' +
              '<div class="sidebar-footer">' +
                '<button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> 新会话</button>' +
              '</div>' +
            '</aside>' +
            '<main class="main-content">' +
              '<div class="terminal-header">' +
                '<div class="terminal-title">' +
                  '<span class="terminal-title-text" id="terminal-title">' + (selectedSession ? shortCommand(selectedSession.command) : "Wand") + '</span>' +
                  '<span class="terminal-info" id="terminal-info">' + (selectedSession ? (getModeLabel(selectedSession.mode) + " | " + selectedSession.status) : "开始对话") + '</span>' +
                '</div>' +
                '<div class="terminal-header-actions">' +
                  '<div class="view-toggle" aria-label="视图切换">' +
                    '<button id="view-terminal-btn" class="view-toggle-btn' + (state.currentView === "terminal" ? " active" : "") + '" type="button">终端</button>' +
                    '<button id="view-chat-btn" class="view-toggle-btn' + (state.currentView === "chat" ? " active" : "") + '" type="button">对话</button>' +
                  '</div>' +
                  '<div class="file-panel-toggle" aria-label="文件浏览器">' +
                    '<button id="file-panel-toggle-btn" class="view-toggle-btn' + (state.filePanelOpen ? " active" : "") + '" type="button" title="文件浏览器">📁</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              // File side panel
              '<div id="file-side-panel" class="file-side-panel' + (state.filePanelOpen ? " open" : "") + '">' +
                '<div class="file-side-panel-header">' +
                  '<span class="file-side-panel-title">文件</span>' +
                  '<button id="file-side-panel-close" class="btn btn-ghost btn-sm" type="button" aria-label="关闭">×</button>' +
                '</div>' +
                '<div class="file-side-panel-body">' +
                  '<div class="file-explorer-header">' +
                    '<span class="file-explorer-path" id="file-explorer-cwd">' + escapeHtml(selectedSession && selectedSession.cwd ? selectedSession.cwd : (state.config && state.config.defaultCwd ? state.config.defaultCwd : "")) + '</span>' +
                    '<button class="file-explorer-refresh" id="file-explorer-refresh" title="刷新" aria-label="刷新文件列表">↻</button>' +
                  '</div>' +
                  '<div class="file-search-box">' +
                    '<input type="text" id="file-search-input" class="file-search-input" placeholder="搜索文件..." autocomplete="off" />' +
                    '<button class="file-search-clear" id="file-search-clear" type="button" aria-label="清除搜索">×</button>' +
                  '</div>' +
                  '<div class="file-explorer" id="file-explorer">' + renderFileExplorer(selectedSession && selectedSession.cwd ? selectedSession.cwd : (state.config && state.config.defaultCwd ? state.config.defaultCwd : "")) + '</div>' +
                '</div>' +
              '</div>' +
              // Blank chat state (when no session)
              '<div id="blank-chat" class="blank-chat' + (state.selectedId ? " hidden" : "") + '">' +
                '<div class="blank-chat-inner">' +
                  '<div class="blank-chat-logo">W</div>' +
                  '<h2 class="blank-chat-title">Wand</h2>' +
                  '<p class="blank-chat-subtitle">你的本地 AI 编程助手</p>' +
                  '<div class="blank-chat-input-wrap">' +
                    '<input type="text" id="welcome-input" class="blank-chat-input" ' +
                      'placeholder="输入你的问题，按 Enter 发送..." autocomplete="off" spellcheck="false" />' +
                    '<button id="welcome-send-btn" class="blank-chat-send-btn" type="button">发送</button>' +
                  '</div>' +
                  '<div class="blank-chat-tools">' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-claude" type="button">' +
                      '<span class="tool-icon">🤖</span>Claude' +
                    '</button>' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-folder" type="button" title="选择工作目录">' +
                      '<span class="tool-icon">📎</span>目录' +
                    '</button>' +
                  '</div>' +
                  '<p class="blank-chat-hint">按 Enter 发送消息，或点击上方按钮快速开始</p>' +
                '</div>' +
              '</div>' +
              '<div id="output" class="terminal-container' + (state.selectedId ? "" : " hidden") + (state.selectedId && state.currentView === "terminal" ? " active" : "") + '"></div>' +
              '<div id="chat-output" class="chat-container' + (state.selectedId ? "" : " hidden") + (state.selectedId && state.currentView === "chat" ? " active" : "") + '"></div>' +
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
                  '<textarea id="input-box" class="input-textarea" placeholder="输入消息..." rows="1">' + escapeHtml(currentDraft) + '</textarea>' +
                  '<div class="input-composer-bar">' +
                    '<div class="input-composer-left">' +
                      '<select id="chat-mode-select" class="chat-mode-select" title="仅对新建会话生效">' +
                        renderModeOptions(preferredTool, composerMode) +
                      '</select>' +
                    '</div>' +
                    '<div class="input-composer-right">' +
                      '<span id="queue-counter" class="queue-counter hidden">队列: 0</span>' +
                      '<span class="input-hint">Enter 发送 · Shift+Enter 换行</span>' +
                      '<button id="stop-button" class="btn-circle btn-circle-stop' + (state.selectedId ? "" : " hidden") + '" title="停止">' +
                        '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>' +
                      '</button>' +
                      '<button id="send-input-button" class="btn-circle btn-circle-send" title="发送">' +
                        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
                      '</button>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
                '<div id="token-usage-display" class="token-usage-display hidden">' +
                  '<span id="token-usage-text"></span>' +
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
          '<div class="modal">' +
            '<div class="modal-header">' +
              '<h2 class="modal-title">设置</h2>' +
              '<button id="close-settings-button" class="btn btn-ghost btn-icon">×</button>' +
            '</div>' +
            '<div class="modal-body">' +
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
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderSessions() {
        if (state.sessions.length === 0) {
          return '<div class="empty-state"><strong>还没有会话记录</strong><br>点击上方「新对话」开始你的第一次对话。</div>';
        }
        var activeSessions = state.sessions.filter(function(session) { return !session.archived; });
        var archivedSessions = state.sessions.filter(function(session) { return session.archived; });
        var groups = [];
        if (activeSessions.length > 0) {
          groups.push(renderSessionGroup("最近", activeSessions));
        }
        if (archivedSessions.length > 0) {
          groups.push(renderSessionGroup("已归档", archivedSessions));
        }
        return groups.join("");
      }

      function renderSessionGroup(title, sessions) {
        return '<section class="session-group">' +
          '<div class="session-group-title">' + escapeHtml(title) + '</div>' +
          sessions.map(renderSessionItem).join("") +
        '</section>';
      }

      function toggleFilePanel() {
        state.filePanelOpen = !state.filePanelOpen;
        try {
          localStorage.setItem("wand-file-panel-open", String(state.filePanelOpen));
        } catch (e) {}
        updateFilePanelState();
        if (state.filePanelOpen) {
          refreshFileExplorer();
        }
      }

      function updateFilePanelState() {
        var panel = document.getElementById("file-side-panel");
        var mainContent = document.querySelector(".main-content");
        var toggleBtn = document.getElementById("file-panel-toggle-btn");
        if (panel) {
          panel.classList.toggle("open", state.filePanelOpen);
        }
        if (mainContent) {
          mainContent.classList.toggle("file-panel-open", state.filePanelOpen);
        }
        if (toggleBtn) {
          toggleBtn.classList.toggle("active", state.filePanelOpen);
        }
      }

      function updateFilePanelCwd(session) {
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!cwdEl) return;
        var cwd = session && session.cwd ? session.cwd : (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
        cwdEl.textContent = cwd;
      }

      function closeFilePanel() {
        if (!state.filePanelOpen) return;
        state.filePanelOpen = false;
        try {
          localStorage.setItem("wand-file-panel-open", "false");
        } catch (e) {}
        updateFilePanelState();
      }

      function renderFileExplorer(cwd) {
        var root = cwd || (state.config && state.config.defaultCwd) || "";
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
        if (!cwd && state.config && state.config.defaultCwd) {
          cwd = state.config.defaultCwd;
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

      function renderFolderPicker(state) {
        var currentDir = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");

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
        var currentDir = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
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

      function renderSessionItem(session) {
        var activeClass = session.id === state.selectedId ? " active" : "";
        var metaStatus = session.archived ? "已归档" : session.status;
        var modeName = session.mode === "full-access" ? "全权限" : session.mode === "default" ? "默认" : session.mode === "native" ? "原生" : session.mode === "auto-edit" ? "自动编辑" : session.mode;
        var deleteButton = '<button class="btn btn-ghost btn-sm session-action-btn" data-action="delete" data-session-id="' + session.id + '" type="button" aria-label="删除会话">×</button>';
        var resumeButton = "";
        var sessionIdDisplay = "";

        // 如果有 Claude 会话 ID，显示恢复按钮
        if (session.claudeSessionId) {
          var shortId = session.claudeSessionId.slice(0, 8);
          sessionIdDisplay = '<span class="session-id" title="' + escapeHtml(session.claudeSessionId) + '">' + escapeHtml(shortId) + '</span>';
          if (session.status !== "running") {
            resumeButton = '<button class="btn btn-secondary btn-sm session-action-btn" data-action="resume" data-claude-session-id="' + escapeHtml(session.claudeSessionId) + '" data-cwd="' + escapeHtml(session.cwd) + '" type="button" aria-label="恢复会话" title="恢复 Claude 会话">↻</button>';
          }
        }

        return '<div class="session-item' + activeClass + '" data-session-id="' + session.id + '" role="button" tabindex="0">' +
          '<div class="session-item-row">' +
            '<div class="session-main">' +
              '<div class="session-command">' + escapeHtml(session.command) + '</div>' +
              '<div class="session-meta">' +
                '<span>' + escapeHtml(modeName) + '</span>' +
                '<span class="session-status ' + metaStatus + '">' + escapeHtml(metaStatus) + '</span>' +
                sessionIdDisplay +
              '</div>' +
            '</div>' +
            '<span class="session-actions">' + resumeButton + deleteButton + '</span>' +
          '</div>' +
        '</div>';
      }

      function renderSessionModal() {
        var modalTool = "claude";
        var modalMode = getSafeModeForTool(modalTool, state.modeValue || state.chatMode || "default");
        var commandValue = state.commandValue || modalTool;
        return '<section id="session-modal" class="modal-backdrop hidden">' +
          '<div class="modal">' +
            '<div class="modal-header">' +
              '<h2 class="modal-title">新建 Session</h2>' +
              '<button id="close-modal-button" class="btn btn-ghost btn-icon">×</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label">工具</label>' +
                '<div class="tool-picker" id="tool-picker">' +
                  '<button class="tool-card active" type="button" data-tool="claude">' +
                    '<div class="tool-card-title"><span>Claude</span><span class="tool-chip">推荐</span></div>' +
                    '<div class="tool-card-desc">适合长会话、恢复上下文，以及 Claude 原生单轮回复。</div>' +
                  '</button>' +
                '</div>' +
                '<p id="tool-description" class="field-hint">' + escapeHtml(getSessionToolDescription(modalTool)) + '</p>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="mode">模式</label>' +
                '<select id="mode" class="field-input">' +
                  renderModeOptions(modalTool, modalMode) +
                '</select>' +
                '<p id="mode-description" class="field-hint">' + escapeHtml(getToolModeHint(modalTool, modalMode)) + '</p>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="command">命令</label>' +
                '<textarea id="command" class="field-input" placeholder="claude&#10;任意 CLI 命令" rows="2">' + escapeHtml(commandValue) + '</textarea>' +
                '<span id="session-command-preview" class="command-preview">' + escapeHtml(commandValue) + '</span>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="cwd">工作目录</label>' +
                '<div class="suggestions-wrap">' +
                  '<input id="cwd" type="text" class="field-input" autocomplete="off" placeholder="留空则使用默认目录" />' +
                  '<div id="cwd-suggestions" class="suggestions hidden"></div>' +
                '</div>' +
              '</div>' +
              '<button id="run-button" class="btn btn-primary btn-block">启动会话</button>' +
              '<p id="modal-error" class="error-message hidden"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderWelcomeView() {
        var defaultCmd = (state.config && state.config.commandPresets && state.config.commandPresets.length > 0)
          ? state.config.commandPresets[0].command
          : "claude";
        var presets = state.config && state.config.commandPresets ? state.config.commandPresets : [];
        var cards = presets.slice(0, 2).map(function(p) {
          var icon = p.command.indexOf("claude") !== -1 ? "🤖" : "⌨";
          var desc = p.command.indexOf("claude") !== -1 ? "Anthropic 编程助手" : "CLI 工具";
          return '<div class="quick-card" data-command="' + escapeHtml(p.command) + '">' +
            '<div class="quick-card-icon">' + icon + '</div>' +
            '<div class="quick-card-body">' +
              '<div class="quick-card-title">' + escapeHtml(p.label || p.command) + '</div>' +
              '<div class="quick-card-desc">' + desc + '</div>' +
            '</div>' +
          '</div>';
        }).join("");

        return '<div class="welcome-view">' +
          '<div class="welcome-header">' +
            '<div class="welcome-logo">W</div>' +
            '<h1 class="welcome-title">Wand</h1>' +
            '<p class="welcome-subtitle">你的本地 AI 编程助手</p>' +
          '</div>' +
          '<div class="quick-start-grid" id="quick-start-grid">' +
            cards +
          '</div>' +
          '<div class="welcome-custom-row">' +
            '<input id="welcome-custom-command" class="welcome-custom-input" placeholder="或输入任意命令..." />' +
            '<button id="welcome-custom-start" class="btn btn-primary">启动</button>' +
          '</div>' +
          '<p class="welcome-hint">从右侧菜单可查看历史会话</p>' +
        '</div>';
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
          if (passwordEl) {
            passwordEl.addEventListener("keydown", function(e) {
              if (e.key === "Enter") login();
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
            quickStartSession("claude");
          });
        }
        var welcomeFolderBtn = document.getElementById("welcome-tool-folder");
        if (welcomeFolderBtn) {
          welcomeFolderBtn.addEventListener("click", openFolderPickerWithInitialPath);
        }

        var sessionsList = document.getElementById("sessions-list");
        if (sessionsList) {
          sessionsList.addEventListener("click", handleSessionItemClick);
          sessionsList.addEventListener("keydown", handleSessionItemKeydown);
        }

        var commandEl = document.getElementById("command");
        if (commandEl) commandEl.addEventListener("input", function() {
          state.commandValue = this.value;
          var inferredTool = inferToolFromCommand(this.value);
          if (inferredTool === "claude") {
            state.sessionTool = inferredTool;
            state.modeValue = getSafeModeForTool(inferredTool, state.modeValue);
          }
          syncSessionModalUI();
        });
        var modalModeEl = document.getElementById("mode");
        if (modalModeEl) modalModeEl.addEventListener("change", function() {
          state.modeValue = this.value;
          syncSessionModalUI();
        });
        var toolPicker = document.getElementById("tool-picker");
        if (toolPicker) toolPicker.addEventListener("click", function(e) {
          var target = e.target;
          var card = target && target.closest ? target.closest(".tool-card") : null;
          if (!card || !card.dataset.tool) return;
          var nextTool = card.dataset.tool;
          state.sessionTool = nextTool;
          state.modeValue = getSafeModeForTool(nextTool, state.modeValue || state.chatMode);
          state.commandValue = replaceCommandBase(state.commandValue || nextTool, nextTool);
          var commandField = document.getElementById("command");
          if (commandField) commandField.value = state.commandValue;
          syncSessionModalUI();
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
        var newSessBtn = document.getElementById("topbar-new-session-button");
        if (newSessBtn) newSessBtn.addEventListener("click", openSessionModal);
        var drawerNewSessBtn = document.getElementById("drawer-new-session-button");
        if (drawerNewSessBtn) drawerNewSessBtn.addEventListener("click", openSessionModal);
        var closeModalBtn = document.getElementById("close-modal-button");
        if (closeModalBtn) closeModalBtn.addEventListener("click", closeSessionModal);
        var runBtn = document.getElementById("run-button");
        if (runBtn) runBtn.addEventListener("click", runCommand);
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

        // Welcome view quick-start cards
        var quickGrid = document.getElementById("quick-start-grid");
        if (quickGrid) {
          quickGrid.addEventListener("click", function(e) {
            var target = e.target;
            var card = target.closest(".quick-card");
            if (!card) return;
            var cmd = card.dataset && card.dataset.command || "claude";
            quickStartSession(cmd);
          });
        }

        // Welcome view custom command button
        var customStartBtn = document.getElementById("welcome-custom-start");
        if (customStartBtn) {
          customStartBtn.addEventListener("click", function() {
            var inputEl = document.getElementById("welcome-custom-command");
            if (inputEl && inputEl.value.trim()) {
              quickStartSession(inputEl.value.trim());
            }
          });
        }
        var customInput = document.getElementById("welcome-custom-command");
        if (customInput) {
          customInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter") {
              var inputEl = e.target;
              if (inputEl.value.trim()) quickStartSession(inputEl.value.trim());
            }
          });
        }

        var inputBox = document.getElementById("input-box");
        if (inputBox) {
          inputBox.addEventListener("keydown", handleInputBoxKeydown);
          inputBox.addEventListener("paste", handleInputPaste);
          inputBox.addEventListener("input", function() {
            autoResizeInput(inputBox);
          });
          inputBox.addEventListener("focus", function() {
            // Close drawer when user focuses input to avoid backdrop blocking clicks
            closeSessionsDrawer();
          });
        }

        // View toggle handlers
        var viewTermBtn = document.getElementById("view-terminal-btn");
        if (viewTermBtn) viewTermBtn.addEventListener("click", function() { setView("terminal"); });
        var viewChatBtn = document.getElementById("view-chat-btn");
        if (viewChatBtn) viewChatBtn.addEventListener("click", function() { setView("chat"); });

        // File panel toggle
        var filePanelToggle = document.getElementById("file-panel-toggle-btn");
        if (filePanelToggle) filePanelToggle.addEventListener("click", toggleFilePanel);
        var filePanelClose = document.getElementById("file-side-panel-close");
        if (filePanelClose) filePanelClose.addEventListener("click", closeFilePanel);

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
          var initialPath = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
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
            folderPickerInput.value = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
          }
          // Load initial folders
          var initialPath = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
          loadFolderSuggestions(initialPath);
          renderBreadcrumb(initialPath);
        }

        // Welcome screen folder button
        var welcomeFolderBtn = document.getElementById("welcome-tool-folder");
        if (welcomeFolderBtn) {
          welcomeFolderBtn.addEventListener("click", openFolderPickerWithInitialPath);
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

      function handleSessionItemClick(event) {
        var target = event.target;
        if (!target || !(target instanceof Element)) return;
        var actionButton = target.closest("[data-action]");
        if (actionButton && actionButton instanceof HTMLElement) {
          event.preventDefault();
          event.stopPropagation();
          if (actionButton.dataset.action === "delete" && actionButton.dataset.sessionId) {
            deleteSession(actionButton.dataset.sessionId);
          } else if (actionButton.dataset.action === "resume" && actionButton.dataset.claudeSessionId) {
            startCommand("claude --resume " + actionButton.dataset.claudeSessionId, actionButton.dataset.cwd || "");
          }
          return;
        }
        var item = target.closest(".session-item");
        if (item && item.dataset.sessionId) {
          selectSession(item.dataset.sessionId);
          closeSessionsDrawer();
        }
      }

      function handleSessionItemKeydown(event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        var item = event.target.closest(".session-item");
        if (item && item.dataset.sessionId) {
          event.preventDefault();
          selectSession(item.dataset.sessionId);
          closeSessionsDrawer();
        }
      }

      function initTerminal() {
        var container = document.getElementById("output");
        if (!container || state.terminal) return;
        if (typeof Terminal === "undefined") {
          // xterm.js failed to load - terminal features unavailable
          return;
        }

        state.terminal = new Terminal({
          cols: 120,
          rows: 36,
          convertEol: false,
          disableStdin: true,
          cursorBlink: false,
          fontFamily: '"Geist Mono", "SF Mono", monospace',
          fontSize: 13,
          lineHeight: 1.5,
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

        state.fitAddon = new FitAddon.FitAddon();
        state.terminal.loadAddon(state.fitAddon);

        state.terminal.open(container);
        state.fitAddon.fit();

        if (state.selectedId) {
          var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (session && session.output) {
            var normalizedOutput = normalizeTerminalOutput(session.output);
            state.terminal.write(normalizedOutput);
            state.terminalOutput = normalizedOutput;
          }
        } else {
          state.terminal.writeln("点击上方「新对话」开始你的第一次对话。");
        }

        state.terminal.onData(function(data) { queueDirectInput(data); });
        container.addEventListener("click", focusInputBox);
        observeTerminalResize();
      }

      function login() {
        if (state.loginPending) return;

        var passwordEl = document.getElementById("password");
        var loginButton = document.getElementById("login-button");
        var errorEl = document.getElementById("login-error");

        hideError(errorEl);
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
        teardownTerminal();
        state.config = null;
        state.selectedId = null;
        persistSelectedId();
        state.sessions = [];
        state.sessionsDrawerOpen = false;
        render();
      }

      function refreshAll() {
        return loadSessions().then(function() {
          if (state.selectedId) return loadOutput(state.selectedId);
        });
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

      function inferToolFromCommand(command) {
        var base = String(command || "").trim().split(/\s+/)[0] || "";
        if (base === "claude") return "claude";
        return "custom";
      }

      function getPreferredTool() {
        return "claude";
      }

      function getComposerTool() {
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var selectedTool = inferToolFromCommand(selectedSession && selectedSession.command ? selectedSession.command : "");
        if (selectedTool === "claude") {
          return selectedTool;
        }
        return getPreferredTool();
      }

      function getSessionToolDescription(tool) {
        return "适合持续对话、恢复上下文，也支持原生单轮回复模式。";
      }

      function getToolModeHint(tool, mode) {
        if (mode === "full-access") {
          return "自动确认高权限操作，适合你确认环境安全后的连续修改。";
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
          'full-access': '完全访问 - 自动确认所有操作',
          'auto-edit': '自动编辑 - 自动确认文件修改',
          'native': '原生模式 - 返回结构化输出',
          'managed': '托管模式 - AI 自动完成所有工作'
        };
        return hints[mode] || '';
      }

      function replaceCommandBase(command, nextBase) {
        var trimmed = String(command || "").trim();
        if (!trimmed) return nextBase;
        var parts = trimmed.split(/\s+/);
        parts[0] = nextBase;
        return parts.join(" ");
      }

      function syncComposerModeSelect() {
        var select = document.getElementById("chat-mode-select");
        if (!select) return;
        var tool = getComposerTool();
        state.chatMode = getSafeModeForTool(tool, state.chatMode);
        select.innerHTML = renderModeOptions(tool, state.chatMode);
        select.value = state.chatMode;
        // 更新模式提示
        var modeHint = document.getElementById("mode-hint");
        if (modeHint) modeHint.textContent = getModeHint(state.chatMode);
      }

      function applyCurrentView() {
        var hasSession = !!state.selectedId;
        var terminalBtn = document.getElementById("view-terminal-btn");
        var chatBtn = document.getElementById("view-chat-btn");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");

        if (terminalBtn) terminalBtn.classList.toggle("active", state.currentView === "terminal");
        if (chatBtn) chatBtn.classList.toggle("active", state.currentView === "chat");
        if (terminalContainer) terminalContainer.classList.toggle("active", hasSession && state.currentView === "terminal");
        if (chatContainer) chatContainer.classList.toggle("active", hasSession && state.currentView === "chat");
      }

      function syncSessionModalUI() {
        var commandEl = document.getElementById("command");
        var modeEl = document.getElementById("mode");
        var toolHint = document.getElementById("tool-description");
        var modeHint = document.getElementById("mode-description");
        var previewEl = document.getElementById("session-command-preview");
        var tool = "claude";

        state.sessionTool = tool;
        state.modeValue = getSafeModeForTool(tool, state.modeValue || state.chatMode || "default");

        document.querySelectorAll(".tool-card").forEach(function(card) {
          card.classList.toggle("active", card.dataset.tool === tool);
        });

        if (commandEl) {
          if (!commandEl.value.trim() && document.activeElement !== commandEl) {
            commandEl.value = tool;
            state.commandValue = tool;
          }
          commandEl.placeholder = "claude --model sonnet";
        }

        if (modeEl) {
          modeEl.innerHTML = renderModeOptions(tool, state.modeValue);
          modeEl.value = state.modeValue;
        }

        if (toolHint) toolHint.textContent = getSessionToolDescription(tool);
        if (modeHint) modeHint.textContent = getToolModeHint(tool, state.modeValue);
        if (previewEl) previewEl.textContent = (commandEl && commandEl.value.trim()) || tool;
      }

      function updateSessionSnapshot(snapshot) {
        if (!snapshot || !snapshot.id) return;
        var updated = false;
        state.sessions = state.sessions.map(function(session) {
          if (session.id !== snapshot.id) return session;
          updated = true;
          // Merge snapshot fields into existing session to preserve all fields
          return Object.assign({}, session, snapshot);
        });
        if (!updated) {
          state.sessions.unshift(snapshot);
        }
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
              if (localSession && localSession.output && localSession.output.length > (serverSession.output || '').length) {
                return localSession;
              }
              return serverSession;
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
            if (state.selectedId) {
              loadOutput(state.selectedId);
            }
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
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "Wand";
        var summaryEl = document.querySelector(".session-summary-value");
        var titleEl = document.getElementById("terminal-title");
        var infoEl = document.getElementById("terminal-info");
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");

        if (summaryEl) summaryEl.textContent = terminalTitle;
        if (titleEl) titleEl.textContent = terminalTitle;
        if (infoEl) {
          infoEl.textContent = selectedSession ? (getModeLabel(selectedSession.mode) + " | " + selectedSession.status) : "开始对话";
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
            var terminalInfo = document.getElementById("terminal-info");
            if (terminalInfo) {
              terminalInfo.textContent = data.cwd + " | " + getModeLabel(data.mode) + " | " + data.status + " | exit=" + (data.exitCode ?? "n/a");
            }

            // Use structured messages if available (JSON chat mode), otherwise parse from PTY output
            var selectedSession = state.sessions.find(function(s) { return s.id === id; });
            if (selectedSession && selectedSession.messages && selectedSession.messages.length > 0) {
              state.currentMessages = selectedSession.messages;
            } else {
              state.currentMessages = parseMessages(selectedSession ? selectedSession.output : "", selectedSession ? selectedSession.command : "");
            }

            if (state.terminal) {
              if (state.terminalSessionId !== id) {
                state.terminal.reset();
                state.terminalOutput = "";
              }
              var newOutput = normalizeTerminalOutput(data.output || "");
              if (newOutput.startsWith(state.terminalOutput)) {
                state.terminal.write(newOutput.slice(state.terminalOutput.length));
              } else {
                state.terminal.reset();
                state.terminal.write(newOutput);
              }
              state.terminalSessionId = id;
              state.terminalOutput = newOutput;
              state.terminal.scrollToBottom();
            }

            renderChat(true);
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
        var inferredTool = inferToolFromCommand(session && session.command ? session.command : "");
        if (inferredTool === "claude") {
          state.preferredCommand = inferredTool;
          state.chatMode = getSafeModeForTool(inferredTool, session && session.mode ? session.mode : state.chatMode);
        }
        updateSessionsList();
        switchToSessionView(id);
        // Update file panel cwd and refresh if open
        if (state.filePanelOpen) {
          updateFilePanelCwd(session);
          refreshFileExplorer();
        }
        loadOutput(id).then(function() { focusInputBox(true); });
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
        updateDrawerState();
      }

      function closeSessionsDrawer() {
        if (!state.sessionsDrawerOpen) return;
        state.sessionsDrawerOpen = false;
        updateDrawerState();
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
          // Store last focused element to restore on close
          lastFocusedElement = document.activeElement;
          var commandEl = document.getElementById("command");
          var defaultTool = getPreferredTool();
          var fallbackCommand = state.commandValue || state.preferredCommand || defaultTool;
          state.sessionTool = defaultTool;
          state.commandValue = fallbackCommand || state.sessionTool;
          state.modeValue = getSafeModeForTool(state.sessionTool, state.modeValue || state.chatMode);
          if (commandEl) commandEl.value = state.commandValue;
          syncSessionModalUI();
          setTimeout(function() { document.getElementById("command").focus(); }, 20);
          // Setup focus trap
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
          document.getElementById("new-password").value = "";
          document.getElementById("confirm-password").value = "";
          hideSettingsMessages();
          setupFocusTrap(modal);
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

      function populatePresets() {
        var select = document.getElementById("preset-select");
        if (!select || !state.config) return;

        select.innerHTML = '<option value="">Custom command</option>';
        (state.config.commandPresets || []).forEach(function(preset, i) {
          var opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = preset.label + " — " + preset.command;
          select.appendChild(opt);
        });
      }

      function applyPreset() {
        var select = document.getElementById("preset-select");
        var commandEl = document.getElementById("command");
        var modeEl = document.getElementById("mode");

        if (!select || !commandEl || !state.config || select.value === "") return;

        var preset = state.config.commandPresets[Number(select.value)];
        if (!preset) return;

        commandEl.value = preset.command;
        modeEl.value = preset.mode || state.config.defaultMode || "default";
        state.commandValue = commandEl.value;
        state.modeValue = modeEl.value;
      }

      function quickStartSession(command) {
        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
        var defaultMode = (state.config && state.config.defaultMode) ? state.config.defaultMode : "default";
        var inferredTool = inferToolFromCommand(command);
        if (inferredTool === "claude") {
          state.preferredCommand = inferredTool;
          state.chatMode = getSafeModeForTool(inferredTool, state.chatMode);
        }
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
          showToast("无法启动命令。", "error");
        });
      }

      function runCommand() {
        var commandEl = document.getElementById("command");
        var cwdEl = document.getElementById("cwd");
        var modeEl = document.getElementById("mode");
        var errorEl = document.getElementById("modal-error");

        hideError(errorEl);

        var command = commandEl.value.trim();
        if (!command) {
          showError(errorEl, "请输入要执行的命令。");
          return;
        }

        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
        var selectedTool = inferToolFromCommand(command);
        var selectedMode = getSafeModeForTool(selectedTool, modeEl && modeEl.value ? modeEl.value : state.modeValue);
        state.modeValue = selectedMode;
        state.chatMode = selectedMode;
        state.sessionTool = selectedTool;
        state.preferredCommand = selectedTool;
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
          state.commandValue = command;
          return refreshAll();
        })
        .then(function() { focusInputBox(true); })
        .catch(function() {
          showError(errorEl, "无法启动命令。请检查命令是否正确安装。");
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
              setDraftValue(newValue);
              autoResizeInput(inputBox);
            }
            return;
          }
          event.preventDefault();
          sendInputFromBox(false);
          return;
        }

        if (event.key === "Backspace") {
          // Let default behavior handle the deletion, then sync state
          setTimeout(function() {
            var inputBox = document.getElementById("input-box");
            if (inputBox) {
              setDraftValue(inputBox.value);
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
            setDraftValue(newValue);
          }
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          queueDirectInput(getControlInput("escape"));
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
          queueDirectInput(getControlInput("ctrl_c"));
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
          queueDirectInput(getControlInput("ctrl_d"));
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_l"));
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
          queueDirectInput(String.fromCharCode(24)); // Ctrl+X = 0x18
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

      function setDraftValue(value) {
        if (!state.selectedId) return;
        state.drafts[state.selectedId] = value;
        // Persist to localStorage
        try {
          localStorage.setItem("wand-draft-" + state.selectedId, value);
        } catch (e) { /* ignore */ }
        var inputBox = document.getElementById("input-box");
        if (inputBox) inputBox.value = value;
      }

      function autoResizeInput(el) {
        if (!el) return;
        // Force synchronous reflow so scrollHeight reflects current content
        void el.offsetHeight;
        // Temporarily remove min-height and collapse to measure true content height
        el.style.minHeight = "0";
        el.style.height = "0";
        // Force reflow again after style changes
        void el.offsetHeight;
        var maxHeight = 160;
        var minHeight = 44;
        var contentHeight = el.scrollHeight;
        var newHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
        el.style.height = newHeight + "px";
        // Keep inline minHeight to override CSS min-height
        el.style.minHeight = minHeight + "px";
        el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
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
        var mode = state.chatMode || "full-access";
        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
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
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: "subscribe", sessionId: data.id }));
          }
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
            sendInputFromBox(false);
          }
          return;
        }

        // No selected session, create a new one
        var mode = state.chatMode || "full-access";
        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
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
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'subscribe', sessionId: data.id }));
          }
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
        var modeName = session ? getModeLabel(session.mode) : "";
        var info = session ? (modeName + " | " + session.status) : "";
        if (terminalTitle) terminalTitle.textContent = title;
        if (terminalInfo) terminalInfo.textContent = info;
        if (sessionSummary) sessionSummary.textContent = title;

        // Init terminal if not already done
        if (!state.terminal) initTerminal();
        applyCurrentView();
        if (state.currentView === "terminal") {
          setTimeout(scheduleTerminalResize, 40);
        }
        // Don't call renderChat() here — loadOutput() always calls renderChat() after it resolves.
        // Calling renderChat() prematurely would render with stale/empty messages.
        focusInputBox();
      }


      function sendInputFromBox(appendEnter) {
        var inputBox = document.getElementById("input-box");
        var value = inputBox ? inputBox.value : "";
        if (value) {
          // Clear todo progress bar at the start of a new user turn
          var todoEl = document.getElementById("todo-progress");
          if (todoEl) todoEl.classList.add("hidden");
          // Send text + Enter as a single call to avoid race conditions
          var combinedInput = value + getControlInput("enter");
          // Clear the input box immediately to prevent double-sending
          if (inputBox) {
            inputBox.value = "";
            // Force reset to minimum height, overriding CSS min-height
            inputBox.style.height = "44px";
            inputBox.style.minHeight = "44px";
            inputBox.style.overflowY = "hidden";
          }
          setDraftValue("");
          return queueDirectInput(combinedInput).catch(function(err) {
            showToast(err.message || "会话已结束，请重启会话。", "error");
            throw err;
          });
        }
        // Don't send empty Enter — avoids accidental terminal behavior
        if (appendEnter && value) {
          return queueDirectInput(getControlInput("enter")).catch(function() {
            return Promise.resolve();
          });
        }
        return Promise.resolve();
      }

      function sendDirectInput(input) {
        return queueDirectInput(input);
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
          case "escape":
            return String.fromCharCode(27);
          default:
            return "";
        }
      }

      function queueDirectInput(input) {
        if (!input || !state.selectedId) return Promise.resolve();
        // Add to message queue for visual feedback
        state.messageQueue.push(input);
        updateQueueCounter();
        state.inputQueue = state.inputQueue.then(function() {
          return postInput(input).finally(function() {
            // Remove from queue after sent
            var idx = state.messageQueue.indexOf(input);
            if (idx > -1) state.messageQueue.splice(idx, 1);
            updateQueueCounter();
          });
        });
        return state.inputQueue;
      }

      function postInput(input) {
        if (!state.selectedId) return Promise.resolve();

        // If WebSocket is disconnected, queue the message
        if (!state.wsConnected) {
          // Limit queue size to 100 messages
          if (state.pendingMessages.length >= 100) {
            state.pendingMessages.shift(); // Remove oldest
          }
          state.pendingMessages.push(input);
          // Still try HTTP fallback
        }

        return fetch("/api/sessions/" + state.selectedId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, view: state.currentView })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().then(function(data) {
              throw new Error(data.error || "会话已结束。");
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          // Use the response snapshot to immediately update session state
          // This ensures user messages appear in chat without waiting for WebSocket echo
          if (snapshot && snapshot.id) {
            updateSessionSnapshot(snapshot);
            if (snapshot.messages && snapshot.messages.length > 0) {
              state.currentMessages = snapshot.messages;
            }
            // Immediate render to show user message quickly
            renderChat(true);
          }
          return snapshot;
        });
      }

      function flushPendingMessages() {
        if (state.pendingMessages.length === 0) return;

        // Send queued messages in order
        var queue = state.pendingMessages.slice();
        state.pendingMessages = [];

        queue.forEach(function(input) {
          postInput(input).catch(function() {
            // Ignore errors during flush
          });
        });
      }

      function stopSession() {
        if (!state.selectedId) return;
        fetch("/api/sessions/" + state.selectedId + "/stop", { method: "POST", credentials: "same-origin" })
          .then(refreshAll);
      }

      function deleteSession(id) {
        // 二次确认
        if (!confirm("确定要删除这个会话吗？此操作无法撤销。")) {
          return;
        }
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
            var errorEl = document.getElementById("action-error");
            showError(errorEl, "无法删除会话。");
          });
      }

      function startCommand(command, cwd, errorEl) {
        var inferredTool = inferToolFromCommand(command);
        if (inferredTool === "claude") {
          state.preferredCommand = inferredTool;
          state.chatMode = getSafeModeForTool(inferredTool, state.chatMode);
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

      function focusInputBox(skipMobile) {
        var inputBox = document.getElementById("input-box");
        if (!inputBox || !state.selectedId) return;
        if (document.activeElement === inputBox) return;
        // Skip focus on mobile/touch devices for auto-triggered calls to avoid opening keyboard
        if (skipMobile && ("ontouchstart" in window || navigator.maxTouchPoints > 0)) return;
        inputBox.focus();
        inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length);
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
            if (inputPanel) {
              var rect = vk.boundingRect;
              var kbHeight = rect ? rect.height : 0;
              inputPanel.style.paddingBottom = kbHeight > 0 ? kbHeight + 'px' : '';
              // Scroll chat into view when keyboard opens
              if (kbHeight > 0 && chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
              }
            }
          });
        }

        // Show virtual keyboard on terminal/chat tap
        var output = document.getElementById('output');
        if (output) {
          output.addEventListener('click', function() {
            if (state.selectedId) {
              var inputBox = document.getElementById('input-box');
              if (inputBox) inputBox.focus();
            }
          });
        }

        // Also focus on chat messages tap
        if (chatMessages) {
          chatMessages.addEventListener('click', function(e) {
            // Only focus if not clicking on a link, button, or tool card header
            if (e.target.tagName !== 'A' && e.target.tagName !== 'BUTTON' && !e.target.closest('button') && !e.target.closest('[data-tool-toggle]')) {
              var inputBox = document.getElementById('input-box');
              if (inputBox && state.selectedId) inputBox.focus();
            }
          });
        }
      }

      // Visual viewport handling for better mobile keyboard support
      function setupVisualViewportHandlers() {
        if (!('visualViewport' in window)) return;

        var vv = window.visualViewport;
        var inputPanel = document.querySelector('.input-panel');
        var chatMessages = document.querySelector('.chat-messages');
        var lastHeight = vv.height;

        function updateViewport() {
          if (!inputPanel || !vv) return;

          var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
          var isKeyboardOpen = offsetBottom > 50;

          if (isKeyboardOpen) {
            // Keyboard is open - scroll chat to bottom
            if (chatMessages) {
              setTimeout(function() {
                chatMessages.scrollTop = chatMessages.scrollHeight;
              }, 100);
            }
          }

          lastHeight = vv.height;
        }

        // Debounce viewport updates for smoother experience
        var viewportTimer = null;
        function debouncedUpdate() {
          if (viewportTimer) clearTimeout(viewportTimer);
          viewportTimer = setTimeout(updateViewport, 50);
        }

        vv.addEventListener('resize', debouncedUpdate);
        vv.addEventListener('scroll', debouncedUpdate);

        // Initial update
        updateViewport();
      }

      function observeTerminalResize() {
        var output = document.getElementById("output");
        if (!output) return;

        if (typeof ResizeObserver === "function") {
          state.resizeObserver = new ResizeObserver(function() { scheduleTerminalResize(); });
          state.resizeObserver.observe(output);
        }
        state.resizeHandler = scheduleTerminalResize;
        window.addEventListener("resize", state.resizeHandler);
        requestAnimationFrame(scheduleTerminalResize);
      }

      function teardownTerminal() {
        if (state.resizeObserver) {
          state.resizeObserver.disconnect();
          state.resizeObserver = null;
        }
        if (state.resizeHandler) {
          window.removeEventListener("resize", state.resizeHandler);
          state.resizeHandler = null;
        }
        if (state.terminal) {
          state.terminal.dispose();
          state.terminal = null;
        }
        state.fitAddon = null;
        state.terminalSessionId = null;
      }

      function scheduleTerminalResize() {
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(syncTerminalSize, 60);
      }

      function syncTerminalSize() {
        var output = document.getElementById("output");
        if (!state.terminal || !state.fitAddon || !output) return;

        state.fitAddon.fit();

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

        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var wsUrl = protocol + '//' + window.location.host + '/ws';

        try {
          var ws = new WebSocket(wsUrl);

          ws.onopen = function() {
            state.ws = ws;
            state.wsConnected = true;
            // Subscribe to current session if any
            if (state.selectedId) {
              ws.send(JSON.stringify({ type: 'subscribe', sessionId: state.selectedId }));
            }
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
              // Pass structured messages if available from JSON chat mode
              if (msg.data.messages) {
                snapshot.messages = msg.data.messages;
              }
              updateSessionSnapshot(snapshot);

              // Only process if this is the selected session
              if (msg.sessionId === state.selectedId) {
                // Update current messages immediately from the snapshot
                var updatedSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
                if (updatedSession) {
                  if (updatedSession.messages && updatedSession.messages.length > 0) {
                    state.currentMessages = updatedSession.messages;
                  } else if (updatedSession.output) {
                    state.currentMessages = parseMessages(updatedSession.output, updatedSession.command);
                  }
                }

                // Check if this is a new message (not just streaming update)
                var prevMsgCount = state.lastRenderedMsgCount;
                var currMsgCount = state.currentMessages.length;

                // Streaming thinking update: update the thinking element in-place
                if (msg.data.thinkingContent !== undefined) {
                  updateStreamingThinking(msg.data.thinkingContent);
                }

                // Immediate render for new messages, debounced for streaming updates
                scheduleChatRender(currMsgCount > prevMsgCount);
              }
            }
            // Real-time terminal output
            if (msg.sessionId === state.selectedId && state.terminal && msg.data && msg.data.output) {
              var newOutput = normalizeTerminalOutput(msg.data.output || "");
              if (newOutput.startsWith(state.terminalOutput)) {
                state.terminal.write(newOutput.slice(state.terminalOutput.length));
              } else {
                state.terminal.reset();
                state.terminal.write(newOutput);
              }
              state.terminalOutput = newOutput;
              state.terminal.scrollToBottom();
            }
            break;
          case 'started':
            // New session started
            loadSessions();
            break;
          case 'ended':
            // Session ended - update status immediately before async loadSessions
            var endedSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
            if (endedSession) endedSession.status = msg.data && msg.data.status ? msg.data.status : "exited";
            loadSessions();
            if (msg.sessionId === state.selectedId) {
              loadOutput(msg.sessionId);
            }
            // Update chat view with full render to show ended status
            if (msg.sessionId === state.selectedId) {
              renderChat(true);
            }
            break;
          case 'init':
            // Initial state for subscribed session (after reconnect or subscription)
            if (msg.sessionId === state.selectedId && msg.data) {
              if (chatRenderTimer) { clearTimeout(chatRenderTimer); chatRenderTimer = null; }
              updateTerminalOutput(msg.data.output || "");
              if (state.currentView === "chat") {
                // Force full render to show all messages
                renderChat(true);
              }
            }
            break;
        }
      }

      function updateTerminalOutput(output) {
        if (!state.terminal) return;
        var normalized = normalizeTerminalOutput(output);
        if (normalized.startsWith(state.terminalOutput)) {
          state.terminal.write(normalized.slice(state.terminalOutput.length));
        } else {
          state.terminal.reset();
          state.terminal.write(normalized);
        }
        state.terminalOutput = normalized;
        state.terminal.scrollToBottom();
      }

      function stopPolling() {
        if (state.pollTimer) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      }

      function setView(view) {
        if (state.currentView === view) return;
        state.currentView = view;
        applyCurrentView();
        if (view === "terminal") {
          setTimeout(scheduleTerminalResize, 40);
        }

        // Render chat if switching to chat view - force full render
        if (view === "chat") {
          renderChat(true);
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
            // Prefer structured messages from JSON chat mode
            if (selectedSession.messages && selectedSession.messages.length > 0) {
              state.currentMessages = selectedSession.messages;
            } else if (selectedSession.output) {
              state.currentMessages = parseMessages(selectedSession.output, selectedSession.command);
            }
          }
          renderChat();
        }, 30);
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
          chatMessages.innerHTML = messages.slice().reverse().map(renderChatMessage).join("");
          attachAllCopyHandlers(chatMessages);
          // Only expand the single newest tool card (first chat-message = newest due to column-reverse)
          var firstMsg = chatMessages.querySelector(".chat-message");
          if (firstMsg) {
            var cards = firstMsg.querySelectorAll(".tool-use-card");
            if (cards.length > 0) {
              cards[0].classList.remove("collapsed");
              for (var ci = 1; ci < cards.length; ci++) {
                cards[ci].classList.add("collapsed");
              }
            }
          }
          // Scroll to bottom (newest message) - with column-reverse, scrollTop=0 is visual bottom
          requestAnimationFrame(function() {
            chatMessages.scrollTop = 0;
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
          for (var i = 0; i < newMessages.length; i++) {
            var div = document.createElement("div");
            div.innerHTML = renderChatMessage(newMessages[i]);
            var el = div.firstElementChild;
            if (el) {
              el.classList.add("animate-in");
              fragment.appendChild(el);
            }
          }
          chatMessages.insertBefore(fragment, chatMessages.firstChild);
          attachAllCopyHandlers(chatMessages);
          // Collapse all existing cards; new cards (with animate-in) stay expanded
          collapseOldToolCards(chatMessages, fragment.children);
          // Scroll to bottom (newest message) - with column-reverse, scrollTop=0 is visual bottom
          requestAnimationFrame(function() {
            chatMessages.scrollTop = 0;
          });
        } else if (msgCount === existingCount && outputHash !== prevHash) {
          // Same message count but content changed (streaming update) — update last message (newest visually)
          // With column-reverse, first DOM child = newest message
          var firstEl = chatMessages.querySelector(".chat-message");
          if (firstEl && messages.length > 0) {
            // The newest message is the last in the array (first in DOM due to reverse)
            var newestMsg = messages[messages.length - 1];
            var currentContent = firstEl.querySelector(".chat-message-bubble");
            if (currentContent && newestMsg) {
              // Re-render the full message element to handle both structured and string content
              var tmpDiv = document.createElement("div");
              tmpDiv.innerHTML = renderChatMessage(newestMsg);
              var newEl = tmpDiv.firstElementChild;
              if (newEl && newEl.querySelector(".chat-message-bubble")) {
                var newBubble = newEl.querySelector(".chat-message-bubble");
                // Only update if bubble content actually changed
                if (newBubble && currentContent.innerHTML !== newBubble.innerHTML) {
                  chatMessages.replaceChild(newEl, firstEl);
                  attachCopyHandler(newEl);
                  // Keep only the single newest tool card expanded, collapse all others
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
              }
            }
          }
        } else if (msgCount < existingCount) {
          fullRenderChat();
        }

        // Update todo progress bar from latest messages
        updateTodoProgress(messages);

        // Update real-time token usage display
        updateTokenUsageDisplay(messages);
      }

      // Smart scroll: only auto-scroll if user is near bottom
      // column-reverse: scrollTop near 0 = visual bottom (newest messages)
      function smartScrollToBottom(container) {
        var chatMsgs = container.querySelector ? container.querySelector(".chat-messages") : container;
        if (!chatMsgs) chatMsgs = container;
        var threshold = 100;
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

      function updateTokenUsageDisplay(messages) {
        var display = document.getElementById("token-usage-display");
        var textEl = document.getElementById("token-usage-text");
        if (!display || !textEl) return;

        // Calculate total token usage from current messages
        var totalInput = 0;
        var totalOutput = 0;
        var totalCache = 0;
        var totalCost = 0;

        for (var i = 0; i < messages.length; i++) {
          var msg = messages[i];
          if (msg.usage) {
            if (msg.usage.inputTokens) totalInput += msg.usage.inputTokens;
            if (msg.usage.outputTokens) totalOutput += msg.usage.outputTokens;
            if (msg.usage.cacheReadInputTokens) totalCache += msg.usage.cacheReadInputTokens;
            if (msg.usage.totalCostUsd) totalCost += msg.usage.totalCostUsd;
          }
        }

        // Build token usage string
        var parts = [];
        if (totalInput > 0) parts.push("输入 " + totalInput);
        if (totalOutput > 0) parts.push("输出 " + totalOutput);
        if (totalCache > 0) parts.push("缓存 " + totalCache);
        if (totalCost > 0) parts.push("$" + totalCost.toFixed(4));

        if (parts.length > 0) {
          textEl.textContent = parts.join("  ·  ");
          display.classList.remove("hidden");
        } else {
          display.classList.add("hidden");
        }
      }

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
          if (line.indexOf("Permissions") !== -1 && line.indexOf("mode") !== -1) continue;
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
          if (lines.length > 3) {
            preview = lines.slice(0, 3).join("\n") + "\n…";
          } else {
            preview = resultContent;
          }
        }

        var resultDataAttr = escapeHtml(resultContent);
        var previewDataAttr = escapeHtml(preview);
        var fullResult = resultContent;

        var expandedHtml = "";
        if (hasResult) {
          expandedHtml = '<div class="inline-tool-expanded">' +
            '<div class="inline-tool-result">' + formatInlineResult(resultContent, toolName) + '</div>' +
          '</div>';
        } else if (isError) {
          expandedHtml = '<div class="inline-tool-expanded"><div class="inline-tool-result inline-tool-error">' +
            escapeHtml(resultContent || "操作失败") + '</div></div>';
        } else if (!toolResult) {
          expandedHtml = '<div class="inline-tool-expanded"><div class="inline-tool-loading">等待响应…</div></div>';
        }

        var extraInfoHtml = meta ? '<span class="inline-tool-meta">' + escapeHtml(meta) + '</span>' : '';

        return '<div class="inline-tool ' + (isError ? 'inline-tool-error-inline' : '') + '" ' +
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
        var hasResult = toolResult && toolResult.content && toolResult.content.trim().length > 0;

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
            statusText = "❌ 修改失败";
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
        var lines = content.split("\n");
        var displayLines = lines.length > 8 ? lines.slice(0, 8).join("\n") + "\n…" : content;
        return '<pre class="inline-tool-result-text">' + escapeHtml(displayLines) + '</pre>';
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
        var text = String(value || "");
        var normalized = "";
        for (var i = 0; i < text.length; i += 1) {
          var char = text.charAt(i);
          if (char === String.fromCharCode(10)) {
            if (i === 0 || text.charAt(i - 1) !== String.fromCharCode(13)) {
              normalized += String.fromCharCode(13);
            }
            normalized += char;
            continue;
          }
          normalized += char;
        }
        return normalized;
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

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }
    })();
