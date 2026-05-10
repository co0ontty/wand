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
      var CHAT_EXPAND_STATE_STORAGE_KEY = "wand-chat-expand-state-v1";
      var CHAT_AUTO_FOLLOW_STORAGE_KEY = "wand-chat-auto-follow";

      var state = {
        selectedId: (function() {
          try { return localStorage.getItem("wand-selected-session") || null; } catch (e) { return null; }
        })(),
        pollTimer: null,
        config: null,
        sessions: [],
        suggestionTimer: null,
        terminal: null,
        terminalFitInProgress: false,
        terminalSessionId: null,
        terminalOutput: "",
        terminalLiveStreamSessions: {},
        lastChunkAt: 0,
        terminalHealthTimer: null,
        lastTerminalResyncAt: 0,
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
        crossSessionQueue: (function() {
          try {
            var saved = localStorage.getItem("wand-cross-session-queue");
            var parsed = saved ? JSON.parse(saved) : [];
            return Array.isArray(parsed) ? parsed : [];
          } catch (e) {
            return [];
          }
        })(), // 跨会话排队消息 [{ id, text, cwd, mode, tool }]
        structuredInputQueue: [], // 结构化会话同会话排队消息
        drafts: {},
        isSyncingInputBox: false,
        loginPending: false,
        loginChecked: false,
        bootstrapping: true,
        sessionsDrawerOpen: false,
        sidebarPinned: (function() {
          try { return localStorage.getItem("wand-sidebar-pinned") === "true"; } catch (e) { return false; }
        })(),
        modalOpen: false,
        presetValue: "",
        cwdValue: "",
        modeValue: "managed",
        chatMode: "managed",
        chatModel: (function() {
          try { return localStorage.getItem("wand-chat-model") || ""; } catch (e) { return ""; }
        })(),
        availableModels: [],
        availableCodexModels: [],
        modelsRefreshing: false,
        sessionCreateKind: "structured",
        sessionCreateWorktree: false,
        sessionTool: "claude",
        activeWorktreeMergeSessionId: null,
        worktreeMergeCheckResult: null,
        worktreeMergeLoading: false,
        worktreeMergeSubmitting: false,
        worktreeMergeError: "",
        preferredCommand: "claude",
        structuredRunner: "claude-cli-print",
        lastResize: { cols: 0, rows: 0 },
        isOnline: navigator.onLine,
        deferredPrompt: null,
        showInstallPrompt: false,
        ws: null,
        wsConnected: false,
        _updateBubbleShown: false,
        notificationHistory: {},
        delayedNotificationTimer: null,
        notifSound: (function() {
          try { var v = localStorage.getItem("wand-notif-sound"); return v === null ? true : v === "true"; } catch (e) { return true; }
        })(),
        notifVolume: (function() {
          try { var v = localStorage.getItem("wand-notif-volume"); return v === null ? 80 : Math.max(0, Math.min(100, parseInt(v, 10) || 80)); } catch (e) { return 80; }
        })(),
        notifBubble: (function() {
          try { var v = localStorage.getItem("wand-notif-bubble"); return v === null ? true : v === "true"; } catch (e) { return true; }
        })(),
        toolContentCache: {},
        // Per-session WS output sequence tracker. Reset on connect/reconnect.
        // Used to detect gaps caused by server-side backpressure drops and
        // request a fresh snapshot.
        lastSeqBySession: {},
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
        topbarMoreOpen: false,
        gitStatus: null,
        gitStatusSessionId: null,
        gitStatusLoading: false,
        gitStatusInflight: null,
        gitStatusLastFetchAt: 0,
        quickCommitOpen: false,
        quickCommitSubmitting: false,
        quickCommitGenerating: false,
        quickCommitError: "",
        quickCommitForm: { autoMessage: false, customMessage: "", makeTag: false, tag: "", push: false },
        chatAutoFollow: (function() {
          try {
            var saved = localStorage.getItem(CHAT_AUTO_FOLLOW_STORAGE_KEY);
            return saved === null ? true : saved === "true";
          } catch (e) {
            return true;
          }
        })(),
        showChatJumpToBottom: false,
        chatScrollThreshold: 200,
        chatIsProgrammaticScroll: false,
        chatScrollElement: null,
        chatScrollHandler: null,
        lastForegroundSyncAt: 0,
        foregroundSyncTimer: null,
        wsReconnectAttempts: 0,
        wsReconnectTimer: null,
        currentMessages: [],
        lastRenderedHash: 0,
        lastRenderedMsgCount: 0,
        lastRenderedEmpty: null,
        renderPending: false,
        chatPageSize: 20,
        chatRenderedCount: 20,
        currentTask: null, // Current task title from Claude
        terminalInteractive: false,
        miniKeyboardVisible: false,
        shortcutsExpanded: false,
        modifiers: { ctrl: false, alt: false, shift: false },
        fileSearchQuery: "",
        fileExplorerLoading: false,
        allFiles: [],
        claudeHistory: [],
        claudeHistoryLoaded: false,
        claudeHistoryExpanded: true,
        claudeHistoryExpandedDirs: {},
        archivedExpanded: false,
        sessionsManageMode: false,
        selectedSessionIds: {},
        selectedClaudeHistoryIds: {},
        askUserSelections: {},  // { toolUseId: { 0: [optIdx...], submitted: false } }
        queueEpoch: 0,  // Monotonic counter for queue state freshness
        pendingAttachments: [],  // [{ file, previewUrl, name, size }]
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

      // ── Structured session status bar (in-flight timer) ──
      var _statusBarTimerId = null;
      var _statusBarStartTime = 0;
      var _runningIndicatorsTimerId = null;
      var _runningIndicatorsStartTime = 0;

      // 计算会话整体的"在跑"信号，统一驱动顶部进度条/徽章计时/气泡呼吸条。
      function computeRunningSignal(session) {
        if (!session) return { active: false };
        if (session.archived) return { active: false };
        var permBlocked = !!session.permissionBlocked;
        var inFlight = !!(isStructuredSession(session)
          && session.structuredState && session.structuredState.inFlight);
        var ptyRunning = !isStructuredSession(session) && session.status === "running";
        return {
          active: inFlight || ptyRunning || permBlocked,
          inFlight: inFlight,
          ptyRunning: ptyRunning,
          permissionBlocked: permBlocked,
        };
      }

      function formatElapsedShort(ms) {
        var s = Math.max(0, Math.floor(ms / 1000));
        if (s < 60) return s + "s";
        var m = Math.floor(s / 60);
        var rs = s % 60;
        if (m < 60) return m + "m" + (rs ? " " + rs + "s" : "");
        var h = Math.floor(m / 60);
        var rm = m % 60;
        return h + "h" + (rm ? " " + rm + "m" : "");
      }

      // 集中刷新：顶部进度条 + 顶部徽章计时 + 助手气泡左侧呼吸条。
      function updateRunningIndicators(session) {
        var sig = computeRunningSignal(session);
        var headerRow = document.querySelector(".main-header-row");
        var pill = headerRow ? headerRow.querySelector(".session-status-pill") : null;
        var chatMessages = document.querySelector(".chat-messages");

        // A. 顶部进度条
        if (headerRow) {
          headerRow.classList.toggle("is-running", sig.active);
          headerRow.classList.toggle("is-permission-blocked", sig.permissionBlocked);
        }

        // B. 顶部徽章计时（仅 inFlight 显示，PTY running 不强制显示）
        if (pill) {
          var elapsedEl = pill.querySelector(".session-status-elapsed");
          if (sig.inFlight) {
            if (!_runningIndicatorsStartTime) {
              // 优先复用 renderStructuredStatusBar 已记录的真实起点
              _runningIndicatorsStartTime = _statusBarStartTime > 0 ? _statusBarStartTime : Date.now();
            }
            var label = formatElapsedShort(Date.now() - _runningIndicatorsStartTime);
            if (!elapsedEl) {
              elapsedEl = document.createElement("span");
              elapsedEl.className = "session-status-elapsed";
              pill.appendChild(elapsedEl);
            }
            elapsedEl.textContent = label;
          } else {
            _runningIndicatorsStartTime = 0;
            if (elapsedEl) elapsedEl.remove();
          }
        }

        // 维持每秒一次的刷新心跳，让 elapsed 数字持续滚动
        if (sig.active) {
          if (!_runningIndicatorsTimerId) {
            _runningIndicatorsTimerId = setInterval(function() {
              var sel = state.sessions.find(function(s) { return s.id === state.selectedId; });
              updateRunningIndicators(sel);
            }, 1000);
          }
        } else if (_runningIndicatorsTimerId) {
          clearInterval(_runningIndicatorsTimerId);
          _runningIndicatorsTimerId = null;
        }
      }

      function renderStructuredStatusBar(chatMessages, session) {
        // 先驱动跨视图的运行指示器（顶部进度条/徽章计时/气泡呼吸条）
        updateRunningIndicators(session);

        // Status bar now lives in .composer-top-row alongside the todo-progress collapse bar
        var topRow = document.querySelector(".composer-top-row");
        var existing = document.querySelector(".structured-status-bar");
        var composer = document.querySelector(".input-composer");
        if (!session || !isStructuredSession(session)) {
          if (existing) existing.remove();
          if (composer) composer.classList.remove("in-flight");
          clearInterval(_statusBarTimerId);
          _statusBarTimerId = null;
          return;
        }

        var isInFlight = session.structuredState && session.structuredState.inFlight;

        if (isInFlight) {
          // Start timer if not already running
          if (!_statusBarTimerId) {
            _statusBarStartTime = Date.now();
          }

          // Add glow to input composer
          if (composer) composer.classList.add("in-flight");

          if (!existing && topRow) {
            var bar = document.createElement("div");
            bar.className = "structured-status-bar";
            bar.innerHTML =
              '<span class="status-bar-dot"></span>' +
              '<span class="status-bar-label">回复中</span>' +
              '<span class="status-bar-timer">0.0s</span>';
            // Append as last child of the top row so it sits to the right of the todo bar
            topRow.appendChild(bar);
            existing = bar;
          } else if (existing && existing.classList.contains("completed")) {
            // Was completed, now in-flight again — reset
            existing.classList.remove("completed");
            existing.style.animation = "none";
            existing.querySelector(".status-bar-label").textContent = "回复中";
            var dot = existing.querySelector(".status-bar-dot");
            if (dot) dot.style.display = "";
            _statusBarStartTime = Date.now();
          }

          // Start interval to update timer
          if (!_statusBarTimerId) {
            _statusBarTimerId = setInterval(function() {
              var bar = document.querySelector(".structured-status-bar:not(.completed)");
              if (!bar) { clearInterval(_statusBarTimerId); _statusBarTimerId = null; return; }
              var elapsed = ((Date.now() - _statusBarStartTime) / 1000).toFixed(1);
              var timerEl = bar.querySelector(".status-bar-timer");
              if (timerEl) timerEl.textContent = elapsed + "s";
            }, 100);
          }
        } else {
          // Not in-flight: show completion or remove
          clearInterval(_statusBarTimerId);
          _statusBarTimerId = null;

          // Remove glow from input composer
          if (composer) composer.classList.remove("in-flight");

          if (existing && !existing.classList.contains("completed")) {
            // Just finished — transition to completed state
            var elapsed = _statusBarStartTime ? ((Date.now() - _statusBarStartTime) / 1000).toFixed(1) : "0.0";
            existing.classList.add("completed");
            existing.querySelector(".status-bar-label").textContent = "完成";
            existing.querySelector(".status-bar-timer").textContent = elapsed + "s";
            var dot = existing.querySelector(".status-bar-dot");
            if (dot) dot.style.display = "none";
            _statusBarStartTime = 0;
            // Remove after animation ends
            setTimeout(function() {
              if (existing.parentNode) existing.remove();
            }, 3000);
          }
        }
      }

      function persistChatAutoFollow() {
        try {
          localStorage.setItem(CHAT_AUTO_FOLLOW_STORAGE_KEY, state.chatAutoFollow ? "true" : "false");
        } catch (e) {
          // Ignore localStorage errors
        }
      }

      function getChatScrollElement() {
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

      function isChatNearBottom(chatMsgs) {
        var el = chatMsgs || getChatScrollElement();
        if (!el) return true;
        return el.scrollTop < state.chatScrollThreshold;
      }

      function updateChatFollowToggleButton() {
        var button = document.getElementById("chat-follow-toggle");
        if (!button) return;
        var enabled = !!state.chatAutoFollow;
        button.classList.toggle("active", enabled);
        button.setAttribute("aria-pressed", enabled ? "true" : "false");
        button.setAttribute("title", enabled ? "追踪底部：开启（点击暂停）" : "追踪底部：已暂停（点击开启）");
        button.setAttribute("aria-label", enabled ? "追踪底部：开启" : "追踪底部：已暂停");
        button.innerHTML = enabled
          ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2.5l4.5 4.5 4.5-4.5"/><path d="M3.5 8.5l4.5 4.5 4.5-4.5"/></svg>'
          : '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3v10"/><path d="M10.5 3v10"/></svg>';
      }

      function updateChatJumpToBottomButton() {
        var button = document.getElementById("chat-jump-bottom");
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var shouldShow = !!selectedSession
          && state.currentView === "chat"
          && !state.chatAutoFollow
          && !isChatNearBottom();
        state.showChatJumpToBottom = shouldShow;
        if (button) {
          button.classList.toggle("visible", shouldShow);
        }
        var chatContainer = document.getElementById("chat-output");
        if (chatContainer) chatContainer.classList.toggle("has-jump-btn", shouldShow);
      }

      function scrollChatToBottom(smooth) {
        var chatMsgs = getChatScrollElement();
        if (!chatMsgs || !chatMsgs.isConnected) return;
        state.chatIsProgrammaticScroll = true;
        if (smooth && typeof chatMsgs.scrollTo === "function") {
          chatMsgs.scrollTo({ top: 0, behavior: "smooth" });
          setTimeout(function() {
            state.chatIsProgrammaticScroll = false;
            updateChatJumpToBottomButton();
          }, 220);
          return;
        }
        chatMsgs.scrollTop = 0;
        requestAnimationFrame(function() {
          state.chatIsProgrammaticScroll = false;
          updateChatJumpToBottomButton();
        });
      }

      function setChatAutoFollow(enabled, options) {
        options = options || {};
        state.chatAutoFollow = !!enabled;
        persistChatAutoFollow();
        updateChatFollowToggleButton();
        if (state.chatAutoFollow && options.scrollNow !== false) {
          scrollChatToBottom(!!options.smooth);
        } else {
          updateChatJumpToBottomButton();
        }
      }

      function bindChatScrollListener() {
        var chatMsgs = getChatScrollElement();
        if (!chatMsgs || !chatMsgs.isConnected) return;
        if (state.chatScrollElement === chatMsgs && state.chatScrollHandler) {
          updateChatJumpToBottomButton();
          return;
        }
        if (state.chatScrollElement && state.chatScrollHandler) {
          state.chatScrollElement.removeEventListener("scroll", state.chatScrollHandler);
        }
        state.chatScrollElement = chatMsgs;
        state.chatScrollHandler = function() {
          if (!chatMsgs.isConnected) return;
          if (state.chatIsProgrammaticScroll) {
            updateChatJumpToBottomButton();
            return;
          }
          if (!isChatNearBottom(chatMsgs)) {
            if (state.chatAutoFollow) {
              setChatAutoFollow(false, { scrollNow: false });
            } else {
              updateChatJumpToBottomButton();
            }
            return;
          }
          updateChatJumpToBottomButton();
        };
        chatMsgs.addEventListener("scroll", state.chatScrollHandler, { passive: true });
        updateChatJumpToBottomButton();
      }

      /** Load older messages by expanding the visible window */
      function loadMoreChatMessages() {
        if (state.chatRenderedCount >= state.currentMessages.length) return;
        state.chatRenderedCount += state.chatPageSize;
        renderChat(true);
      }

      // Observe the "load more" sentinel for auto-loading when scrolled into view
      var _loadMoreObserver = null;
      function observeLoadMoreSentinel() {
        if (_loadMoreObserver) { _loadMoreObserver.disconnect(); _loadMoreObserver = null; }
        var sentinel = document.getElementById("chat-load-more-sentinel");
        if (!sentinel) return;
        // Click handler for the button
        var btn = sentinel.querySelector(".chat-load-more-btn");
        if (btn) btn.onclick = function() { loadMoreChatMessages(); };
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

      function getStructuredQueuedInputs(session) {
        if (session && Array.isArray(session.queuedMessages)) {
          return session.queuedMessages;
        }
        return state.structuredInputQueue;
      }

      function getSelectedStructuredQueuedInputs() {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        return getStructuredQueuedInputs(session);
      }

      function syncStructuredQueueFromSession(session) {
        var queued = getStructuredQueuedInputs(session);
        state.structuredInputQueue = Array.isArray(queued) ? queued.slice() : [];
      }

      function hasRenderOnlyStructuredBlock(message, marker) {
        return !!(message && Array.isArray(message.content) && message.content.some(function(block) {
          return block && typeof block === "object" && block[marker];
        }));
      }

      function isQueuedStructuredMessage(message) {
        return !!(message && message.role === "user" && hasRenderOnlyStructuredBlock(message, "__queued"));
      }

      function isProcessingStructuredMessage(message) {
        return !!(message && message.role === "assistant" && hasRenderOnlyStructuredBlock(message, "__processing"));
      }

      function stripRenderOnlyStructuredMessages(messages) {
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

      function normalizeStructuredSnapshot(snapshot, existingSession) {
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

      function saveStructuredQueue() {
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

      function clearStructuredQueuePersistence(sessionId) {
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

      function restoreStructuredQueue() {
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
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

      function persistCrossSessionQueue() {
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

      function getConfigCwd() {
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

      function saveChatExpandStateMap(map) {
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

      function getPersistedExpandState(itemKey) {
        if (!itemKey || !state.selectedId) return null;
        var sessionState = getCurrentChatExpandState();
        return typeof sessionState[itemKey] === "boolean" ? sessionState[itemKey] : null;
      }

      function setPersistedExpandState(itemKey, expanded) {
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

      function getMessageKey(msg, fallbackIndex) {
        if (!msg) {
          return "msg:unknown-" + (typeof fallbackIndex === "number" ? fallbackIndex : 0);
        }
        if (msg.uuid) return "msg:" + msg.uuid;
        if (msg.id) return "msg:" + msg.id;
        if (msg.messageId) return "msg:" + msg.messageId;
        if (msg.turnId) return "msg:" + msg.turnId;
        return "msg:" + (typeof fallbackIndex === "number" ? fallbackIndex : 0);
      }

      function buildExpandKey(kind, parts) {
        var filtered = [];
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (part === undefined || part === null || part === "") continue;
          filtered.push(String(part));
        }
        return kind + ":" + filtered.join(":");
      }

      function getElementExpandKey(el) {
        if (!el || !el.dataset) return "";
        return el.dataset.expandKey || "";
      }

      function isElementExpanded(el, kind) {
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
          default:
            return false;
        }
      }

      function applyExpandedState(el, kind, expanded) {
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
        }
      }

      function persistElementExpandState(el, kind) {
        var itemKey = getElementExpandKey(el);
        if (!itemKey) return;
        setPersistedExpandState(itemKey, isElementExpanded(el, kind));
      }

      function applyPersistedExpandState(container) {
        if (!container || !state.selectedId) return;
        container.querySelectorAll("[data-expand-key]").forEach(function(el) {
          var itemKey = getElementExpandKey(el);
          var kind = el.dataset.expandKind || "";
          var persisted = getPersistedExpandState(itemKey);
          if (persisted === null || !kind) return;
          applyExpandedState(el, kind, persisted);
        });
      }

      function resetChatRenderCache() {
        state.lastRenderedHash = 0;
        state.lastRenderedMsgCount = 0;
        state.lastRenderedEmpty = null;
        state.renderPending = false;
        state.chatRenderedCount = state.chatPageSize;
        state.askUserSelections = {};
        if (state.chatScrollElement && state.chatScrollHandler) {
          state.chatScrollElement.removeEventListener("scroll", state.chatScrollHandler);
        }
        state.chatScrollElement = null;
        state.chatScrollHandler = null;
        state.showChatJumpToBottom = false;
        state.chatIsProgrammaticScroll = false;
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
        var visible = !!(state.showInstallPrompt && state.deferredPrompt);
        var installBtn = document.getElementById('pwa-install-button');
        if (installBtn) installBtn.classList.toggle('hidden', !visible);
        var topbarInstallItem = document.getElementById('topbar-install-item');
        if (topbarInstallItem) topbarInstallItem.classList.toggle('hidden', !visible);
      }

      function renderBootLoading() {
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

      function scheduleForegroundSync(reason, opts) {
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

      function syncOnForeground(reason, force) {
        if (!state.config) return Promise.resolve();
        if (document.hidden) return Promise.resolve();
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
        return loadSessions({ skipSelectedOutputReload: true }).catch(function(e) {
          console.error("[wand] foreground sync failed:", reason, e);
        });
      }

      function bindForegroundSyncListeners() {
        if (window.__wandForegroundSyncBound) return;
        window.__wandForegroundSyncBound = true;

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
              if (state.claudeHistoryExpanded && !state.claudeHistoryLoaded) {
                loadClaudeHistory();
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
                      '<div class="boot-loading-text" style="font-size:1.3em;margin-bottom:12px">📡 无法连接到服务器</div>' +
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

      renderBootLoading();
      restoreLoginSession();

      function render(options) {
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

        // Apply persisted pin state before rendering
        if (state.sidebarPinned && !isMobileLayout()) {
          state.sessionsDrawerOpen = true;
        }
        app.innerHTML = isLoggedIn ? renderAppShell() : renderLogin();
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
            var cwdEl = document.getElementById("cwd");
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
          var __sel = state.sessions.find(function(s) { return s.id === state.selectedId; });
          updateRunningIndicators(__sel);
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

      function renderApprovalStatsBadge() {
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
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
            (stats.command > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">⚡</span><span class="approval-stats-row-label">命令执行</span><span class="approval-stats-row-count">' + stats.command + '</span></span>' : '') +
            (stats.file > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">📝</span><span class="approval-stats-row-label">文件写入</span><span class="approval-stats-row-count">' + stats.file + '</span></span>' : '') +
            (stats.tool > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">🔧</span><span class="approval-stats-row-label">其他工具</span><span class="approval-stats-row-count">' + stats.tool + '</span></span>' : '') +
            '<span class="approval-stats-row approval-stats-row-total"><span class="approval-stats-row-icon">∑</span><span class="approval-stats-row-label">合计</span><span class="approval-stats-row-count">' + stats.total + '</span></span>' +
          '</span>' +
        '</span>';
      }

      function renderInlineKeyboard() {
        if (!state.selectedId) return "";
        var isTerminal = state.currentView === "terminal";
        if (!isTerminal) return "";
        var sel = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (sel && isStructuredSession(sel)) return "";
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
        var sel = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (sel && isStructuredSession(sel)) return "";
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
              (hasNativeSwitchServer() ?
                '<button id="login-switch-server-button" class="btn btn-ghost btn-block login-switch-server" type="button">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg>' +
                  '<span>切换服务器</span>' +
                '</button>'
                : ''
              ) +
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
          '<div id="sessions-drawer-backdrop" class="drawer-backdrop' + drawerClass + '"></div>' +
          '<div class="main-layout' + (state.sessionsDrawerOpen ? ' sidebar-open' : '') + (state.sidebarPinned && !isMobileLayout() ? ' sidebar-pinned' : '') + '">' +
            '<aside id="sessions-drawer" class="sidebar' + drawerClass + (state.sidebarPinned && !isMobileLayout() ? ' pinned' : '') + '">' +
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
                  '<button id="sidebar-pin-btn" class="btn btn-ghost btn-sm sidebar-pin-toggle' + (state.sidebarPinned ? ' pinned' : '') + '" type="button" title="' + (state.sidebarPinned ? '取消固定侧栏' : '固定侧栏') + '">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>' +
                  '</button>' +
                  '<button id="close-drawer-button" class="btn btn-ghost btn-icon sidebar-close drawer-close-btn" type="button" aria-label="关闭菜单"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
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
                  '<button id="file-panel-toggle-btn" class="btn btn-ghost btn-sm' + (state.filePanelOpen ? " active" : "") + '" type="button" title="查看文件">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
                    '<span>文件</span>' +
                  '</button>' +
                  '<button id="settings-button" class="btn btn-ghost btn-sm" type="button" title="设置">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
                    '<span>设置</span>' +
                  '</button>' +
                  '<button id="pwa-install-button" class="btn btn-ghost btn-sm hidden" title="安装应用">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
                    '<span>安装</span>' +
                  '</button>' +
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
                        '<span class="topbar-session-title" title="' + escapeHtml(selectedSession.command || "") + '">' + escapeHtml(shortCommand(selectedSession.command)) + '</span>' +
                        '<span class="session-status-pill ' + getSessionStatusClass(selectedSession) + '" title="' + escapeHtml(getSessionStatusLabel(selectedSession)) + '"><span class="session-status-dot"></span><span class="session-status-text">' + escapeHtml(getSessionStatusLabel(selectedSession)) + '</span></span>' +
                        '<span class="current-task hidden" id="current-task"></span>' +
                        (selectedSession.cwd ? '<span class="topbar-cwd" id="topbar-cwd" title="' + escapeHtml(selectedSession.cwd) + '" role="button" tabindex="0">' + escapeHtml(selectedSession.cwd) + '</span>' : '')
                      )
                    : '<span class="topbar-tagline">Wand 控制台</span>' +
                      '<span class="current-task hidden" id="current-task"></span>'
                  ) +
                '</div>' +
                '<div class="topbar-right">' +
                  (selectedSession && selectedSession.cwd ? '<button id="topbar-file-button" class="topbar-btn square' + (state.filePanelOpen ? ' active' : '') + '" type="button" aria-label="文件" title="文件"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>' : '') +
                  '<span id="topbar-git-slot" class="topbar-git-slot">' + renderTopbarGitBadgeHtml() + '</span>' +
                  '<div class="topbar-more-wrap">' +
                    '<button id="topbar-more-button" class="topbar-btn square' + (state.topbarMoreOpen ? ' active' : '') + '" type="button" aria-label="更多" aria-haspopup="menu" aria-expanded="' + (state.topbarMoreOpen ? 'true' : 'false') + '" title="更多"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>' +
                    '<div id="topbar-more-menu" class="topbar-more-menu' + (state.topbarMoreOpen ? '' : ' hidden') + '" role="menu">' +
                      '<button class="topbar-more-item" data-action="settings" type="button" role="menuitem"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>设置</span></button>' +
                      '<button class="topbar-more-item" data-action="refresh" type="button" role="menuitem"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>刷新</span></button>' +
                      '<button class="topbar-more-item' + (state.showInstallPrompt && state.deferredPrompt ? '' : ' hidden') + '" id="topbar-install-item" data-action="install" type="button" role="menuitem"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>安装应用</span></button>' +
                      (hasNativeSwitchServer() ? '<button class="topbar-more-item" data-action="switch-server" type="button" role="menuitem"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg><span>切换服务器</span></button>' : '') +
                      '<button class="topbar-more-item topbar-more-item-danger" data-action="logout" type="button" role="menuitem"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>退出</span></button>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
              '</div>' +
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
                '<button id="terminal-jump-bottom" class="terminal-jump-bottom' + (state.showTerminalJumpToBottom ? ' visible' : '') + '" type="button" title="回到底部" aria-label="回到底部"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></button>' +
              '</div>' +
              '<div id="chat-output" class="chat-container hidden">' +
                '<div class="chat-overlay-controls">' +
                  '<button id="chat-follow-toggle" class="chat-follow-toggle topbar-btn' + (state.chatAutoFollow ? ' active' : '') + '" type="button" aria-pressed="' + (state.chatAutoFollow ? 'true' : 'false') + '" aria-label="' + (state.chatAutoFollow ? '追踪底部：开启' : '追踪底部：已暂停') + '" title="' + (state.chatAutoFollow ? '追踪底部：开启（点击暂停）' : '追踪底部：已暂停（点击开启）') + '">' + (state.chatAutoFollow ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2.5l4.5 4.5 4.5-4.5"/><path d="M3.5 8.5l4.5 4.5 4.5-4.5"/></svg>' : '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3v10"/><path d="M10.5 3v10"/></svg>') + '</button>' +
                '</div>' +
                '<button id="chat-jump-bottom" class="chat-jump-bottom' + (state.showChatJumpToBottom ? ' visible' : '') + '" type="button" title="回到底部并继续追底" aria-label="回到底部"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></button>' +
              '</div>' +
              '<div id="blank-chat" class="blank-chat' + (state.selectedId ? " hidden" : "") + '">' +
                '<div class="blank-chat-inner">' +
                  '<div class="blank-chat-logo">W</div>' +
                  '<h2 class="blank-chat-title">Wand</h2>' +
                  '<p class="blank-chat-subtitle">支持终端 PTY 会话与结构化 chat 会话，两种模式可并存。</p>' +
                  '<div class="blank-chat-tools">' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-claude" type="button">' +
                      '<span class="tool-icon">🤖</span>新建终端会话' +
                    '</button>' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-codex" type="button">' +
                      '<span class="tool-icon">⌘</span>新建 Codex 会话' +
                    '</button>' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-structured" type="button">' +
                      '<span class="tool-icon">💬</span>新建结构化会话' +
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
                '<div class="composer-top-row">' +
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
                    '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="input-composer">' +
                  '<button id="prompt-optimize-btn" class="prompt-optimize-btn" type="button" title="提示词优化（AI）" aria-label="提示词优化">' +
                    '<svg class="prompt-optimize-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                      '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" fill="currentColor" opacity="0.25"/>' +
                      '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>' +
                      '<path d="M19 14l.7 1.9L21.6 17l-1.9.7L19 19.6l-.7-1.9L16.4 17l1.9-.7z" fill="currentColor" opacity="0.35"/>' +
                      '<path d="M5 4l.5 1.4L7 6l-1.5.6L5 8l-.5-1.4L3 6l1.5-.6z" fill="currentColor" opacity="0.35"/>' +
                    '</svg>' +
                    '<span class="prompt-optimize-spinner" aria-hidden="true"></span>' +
                  '</button>' +
                  '<textarea id="input-box" class="input-textarea" placeholder="' + getComposerPlaceholder(selectedSession, state.terminalInteractive) + '" rows="1">' + escapeHtml(currentDraft) + '</textarea>' +
                  '<div id="attachment-preview" class="attachment-preview hidden"></div>' +
                  '<div class="input-composer-bar">' +
                    '<div class="input-composer-left">' +
                      '<button id="attach-btn" class="btn-circle btn-circle-attach" type="button" title="附加文件">' +
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
                      '</button>' +
                      '<input type="file" id="file-upload-input" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0);pointer-events:none">' +
                      '<select id="chat-mode-select" class="chat-mode-select" title="仅对新建会话生效">' +
                        renderModeOptions(preferredTool, composerMode) +
                      '</select>' +
                      '<select id="chat-model-select" class="chat-mode-select chat-model-select" title="切换模型（对运行中会话发送 /model，对新会话作为 --model 启动）">' +
                        renderChatModelOptions(getEffectiveModel(selectedSession), selectedSession) +
                      '</select>' +
                      '<button id="terminal-interactive-toggle-top" class="composer-interactive-toggle' + (state.terminalInteractive ? " active" : "") + '" type="button" title="切换终端交互模式">⌨</button>' +
                      '<span class="permission-actions hidden" id="permission-actions">' +
                        '<span class="permission-actions-divider"></span>' +
                        '<span class="permission-actions-label" id="permission-actions-label">等待授权</span>' +
                        '<button id="approve-permission-btn" class="btn btn-permission btn-permission-approve" type="button">批准</button>' +
                        '<button id="deny-permission-btn" class="btn btn-permission btn-permission-deny" type="button">拒绝</button>' +
                      '</span>' +
                      renderApprovalStatsBadge() +
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
                  // Session info bar at bottom — only keeps unique controls/info
                  // (cwd / mode / status / kind are already shown in topbar or composer dropdown)
                  (selectedSession
                    ? '<div class="input-session-info-bar">' +
                        (selectedSession.autoApprovePermissions ? '<span id="auto-approve-toggle" class="auto-approve-indicator active" title="自动批准已启用 — 点击关闭">🛡 自动批准</span>' : '<span id="auto-approve-toggle" class="auto-approve-indicator" title="自动批准已关闭 — 点击开启">🛡 手动</span>') +
                        (selectedSession.provider === "claude" && selectedSession.claudeSessionId ? '<span class="session-info-separator">|</span><span id="claude-session-id-badge" class="claude-session-id-badge" data-claude-id="' + escapeHtml(selectedSession.claudeSessionId) + '" title="点击复制 Claude 会话 ID">☁ ' + escapeHtml(selectedSession.claudeSessionId.slice(0, 8)) + '</span>' : '') +
                        (!isStructuredSession(selectedSession) && selectedSession.exitCode !== undefined && selectedSession.exitCode !== null ? '<span class="session-info-separator">|</span><span id="session-exit-display" class="session-exit-display">退出码=' + selectedSession.exitCode + '</span>' : '') +
                      '</div>'
                    : '') +
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
        '</div>' + renderSessionModal() + renderWorktreeMergeModal() + renderSettingsModal() + renderQuickCommitModal();
      }

      function renderTopbarGitBadgeHtml() {
        if (!state.selectedId || !state.gitStatus || !state.gitStatus.isGit) return "";
        if (state.gitStatusSessionId !== state.selectedId) return "";
        var branch = state.gitStatus.branch || "?";
        var count = state.gitStatus.modifiedCount || 0;
        var titleText = branch + (count ? "  ·  " + count + " 个文件待提交" : "  ·  工作区干净");
        return '<button id="topbar-git-badge" class="topbar-git-badge" type="button" title="' + escapeHtml(titleText) + '" aria-label="快捷提交">'
          + '<svg class="topbar-git-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8"/><path d="M18 11v1a3 3 0 0 1-3 3H9"/></svg>'
          + '<span class="topbar-git-branch">' + escapeHtml(branch) + '</span>'
          + (count > 0
              ? '<span class="topbar-git-count">·' + count + '</span>'
              : '<span class="topbar-git-clean" aria-hidden="true">✓</span>')
          + '</button>';
      }

      function updateTopbarGitBadge() {
        var slot = document.getElementById("topbar-git-slot");
        if (!slot) return;
        slot.innerHTML = renderTopbarGitBadgeHtml();
        var btn = document.getElementById("topbar-git-badge");
        if (btn) {
          btn.addEventListener("click", function(e) {
            e.preventDefault();
            openQuickCommitModal();
          });
        }
      }

      function loadGitStatus(sessionId, options) {
        if (!sessionId) return Promise.resolve(null);
        var force = options && options.force;
        // Same session, fetched within 1s, and no force → skip.
        var now = Date.now();
        if (!force && state.gitStatusSessionId === sessionId && state.gitStatus && (now - state.gitStatusLastFetchAt) < 1000) {
          return Promise.resolve(state.gitStatus);
        }
        if (state.gitStatusInflight && state.gitStatusInflight.sessionId === sessionId) {
          return state.gitStatusInflight.promise;
        }
        state.gitStatusLoading = true;
        var promise = fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/git-status", {
          credentials: "same-origin"
        })
          .then(function(res) { return res.ok ? res.json() : { isGit: false }; })
          .then(function(data) {
            state.gitStatus = data || { isGit: false };
            state.gitStatusSessionId = sessionId;
            state.gitStatusLastFetchAt = Date.now();
            updateTopbarGitBadge();
            return data;
          })
          .catch(function() {
            state.gitStatus = { isGit: false };
            state.gitStatusSessionId = sessionId;
            state.gitStatusLastFetchAt = Date.now();
            updateTopbarGitBadge();
            return null;
          })
          .finally(function() {
            state.gitStatusLoading = false;
            if (state.gitStatusInflight && state.gitStatusInflight.sessionId === sessionId) {
              state.gitStatusInflight = null;
            }
          });
        state.gitStatusInflight = { sessionId: sessionId, promise: promise };
        return promise;
      }

      var quickCommitEscHandler = null;

      function openQuickCommitModal() {
        if (!state.selectedId) return;
        state.quickCommitOpen = true;
        state.quickCommitSubmitting = false;
        state.quickCommitError = "";
        state.quickCommitForm = { autoMessage: false, customMessage: "", makeTag: false, tag: "", push: false };
        closeWorktreeMergeModal();
        closeSessionModal();
        closeSettingsModal();
        rerenderQuickCommitModal();
        var modal = document.getElementById("quick-commit-modal");
        if (modal) {
          modal.classList.remove("hidden");
          lastFocusedElement = document.activeElement;
          setupFocusTrap(modal);
        }
        if (quickCommitEscHandler) document.removeEventListener("keydown", quickCommitEscHandler);
        quickCommitEscHandler = function(e) {
          if (e.key === "Escape" && state.quickCommitOpen && !state.quickCommitSubmitting) {
            closeQuickCommitModal();
          }
        };
        document.addEventListener("keydown", quickCommitEscHandler);
        loadGitStatus(state.selectedId, { force: true }).then(function() {
          if (!state.quickCommitOpen) return;
          rerenderQuickCommitModal();
        });
      }

      function closeQuickCommitModal() {
        state.quickCommitOpen = false;
        state.quickCommitSubmitting = false;
        state.quickCommitError = "";
        var modal = document.getElementById("quick-commit-modal");
        if (modal) modal.classList.add("hidden");
        if (focusTrapHandler) {
          document.removeEventListener("keydown", focusTrapHandler);
          focusTrapHandler = null;
        }
        if (quickCommitEscHandler) {
          document.removeEventListener("keydown", quickCommitEscHandler);
          quickCommitEscHandler = null;
        }
        if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
          lastFocusedElement.focus();
        }
      }

      function rerenderQuickCommitModal() {
        var modal = document.getElementById("quick-commit-modal");
        if (!modal) return;
        var html = renderQuickCommitModal();
        var temp = document.createElement("div");
        temp.innerHTML = html;
        var fresh = temp.querySelector("#quick-commit-modal");
        if (!fresh) return;
        modal.innerHTML = fresh.innerHTML;
        attachQuickCommitModalListeners();
      }

      function attachQuickCommitModalListeners() {
        var closeBtn = document.getElementById("quick-commit-close-btn");
        if (closeBtn) closeBtn.addEventListener("click", closeQuickCommitModal);
        var cancelBtn = document.getElementById("quick-commit-cancel-btn");
        if (cancelBtn) cancelBtn.addEventListener("click", closeQuickCommitModal);
        var submitBtn = document.getElementById("quick-commit-submit-btn");
        if (submitBtn) submitBtn.addEventListener("click", submitQuickCommit);
        var aiBtn = document.getElementById("quick-commit-ai-btn");
        if (aiBtn) aiBtn.addEventListener("click", generateCommitMessageAI);
        var msgEl = document.getElementById("quick-commit-message");
        if (msgEl) msgEl.addEventListener("input", function() {
          state.quickCommitForm.customMessage = msgEl.value;
        });
        var tagCb = document.getElementById("quick-commit-make-tag");
        if (tagCb) tagCb.addEventListener("change", function() {
          state.quickCommitForm.makeTag = tagCb.checked;
          var row = document.getElementById("quick-commit-tag-row");
          if (row) row.classList.toggle("hidden", !tagCb.checked);
        });
        var tagInput = document.getElementById("quick-commit-tag");
        if (tagInput) tagInput.addEventListener("input", function() {
          state.quickCommitForm.tag = tagInput.value;
        });
        var pushCb = document.getElementById("quick-commit-push");
        if (pushCb) pushCb.addEventListener("change", function() {
          state.quickCommitForm.push = pushCb.checked;
        });
      }

      function generateCommitMessageAI() {
        if (!state.selectedId || state.quickCommitGenerating) return;
        var msgEl = document.getElementById("quick-commit-message");
        if (msgEl) state.quickCommitForm.customMessage = msgEl.value;
        state.quickCommitGenerating = true;
        state.quickCommitError = "";
        rerenderQuickCommitModal();
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/generate-commit-message", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then(function(res) {
            return res.json().then(function(data) { return { ok: res.ok, data: data }; });
          })
          .then(function(result) {
            if (!result.ok) throw new Error((result.data && result.data.error) || "AI 生成失败。");
            state.quickCommitForm.customMessage = (result.data && result.data.message) || "";
            var currentMsgEl = document.getElementById("quick-commit-message");
            if (currentMsgEl) currentMsgEl.value = state.quickCommitForm.customMessage;
          })
          .catch(function(error) {
            state.quickCommitError = (error && error.message) || "AI 生成失败。";
          })
          .finally(function() {
            state.quickCommitGenerating = false;
            if (state.quickCommitOpen) rerenderQuickCommitModal();
          });
      }

      function submitQuickCommit() {
        if (!state.selectedId || state.quickCommitSubmitting) return;
        var msgEl = document.getElementById("quick-commit-message");
        if (msgEl) state.quickCommitForm.customMessage = msgEl.value;
        var form = state.quickCommitForm || {};
        var userTag = form.makeTag ? (form.tag || "").trim() : "";
        var message = (form.customMessage || "").trim();
        var payload = {
          autoMessage: false,
          customMessage: message,
          tag: userTag,
          autoTag: form.makeTag && !userTag,
          push: !!form.push
        };
        if (!message) {
          state.quickCommitError = "请填写 commit message，或点击 AI 生成。";
          rerenderQuickCommitModal();
          return;
        }
        state.quickCommitSubmitting = true;
        state.quickCommitError = "";
        rerenderQuickCommitModal();
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/quick-commit", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function(res) {
            return res.json().then(function(data) { return { ok: res.ok, data: data }; });
          })
          .then(function(result) {
            if (!result.ok) throw new Error((result.data && result.data.error) || "快捷提交失败。");
            var data = result.data || {};
            var hash = data.commit && data.commit.hash ? data.commit.hash.substring(0, 7) : "";
            var tagName = data.tag && data.tag.name ? data.tag.name : "";
            var base = "已提交" + (hash ? " " + hash : "") + (tagName ? "，已打 tag " + tagName : "");
            var pushRequested = !!payload.push;
            if (pushRequested && data.pushError) {
              var msg = base + "；push 失败：" + data.pushError;
              if (typeof showToast === "function") showToast(msg, "error");
            } else {
              var okMsg = base + (data.pushed ? "，已 push" : "");
              if (typeof showToast === "function") showToast(okMsg, "success");
            }
            closeQuickCommitModal();
            if (state.selectedId) loadGitStatus(state.selectedId, { force: true });
          })
          .catch(function(error) {
            state.quickCommitError = (error && error.message) || "快捷提交失败。";
          })
          .finally(function() {
            state.quickCommitSubmitting = false;
            if (state.quickCommitOpen) rerenderQuickCommitModal();
          });
      }

      function renderQuickCommitModal() {
        var s = state.gitStatus || {};
        var f = state.quickCommitForm || { autoMessage: false, customMessage: "", makeTag: false, tag: "", push: false };
        var langValue = (state.config && (state.config.language || "")) || "";
        var langLabel = langValue ? langValue : "中文";
        var files = Array.isArray(s.files) ? s.files : [];
        var fileRows = files.map(function(item) {
          var status = (item.status || "  ").substring(0, 2);
          var flag = status.trim() || "?";
          var cls = "qc-flag";
          if (flag === "A" || status[0] === "A") cls += " qc-flag-add";
          else if (flag === "D" || status[0] === "D") cls += " qc-flag-del";
          else if (flag === "M" || status[0] === "M") cls += " qc-flag-mod";
          else if (flag === "??" || status === "??") cls += " qc-flag-untracked";
          else if (flag === "R") cls += " qc-flag-ren";
          var subBadge = "";
          if (item.isSubmodule) {
            var st = item.submoduleState || {};
            var parts = [];
            if (st.commitChanged) parts.push("新指针");
            if (st.hasTrackedChanges) parts.push("dirty");
            if (st.hasUntracked) parts.push("未跟踪");
            var label = parts.length ? "submodule · " + parts.join(" / ") : "submodule";
            subBadge = '<span class="qc-submodule-badge">' + escapeHtml(label) + '</span>';
          }
          return '<div class="qc-file-row"><span class="' + cls + '">' + escapeHtml(status) + '</span><span class="qc-file-path">' + escapeHtml(item.path || "") + '</span>' + subBadge + '</div>';
        }).join("");
        if (!fileRows) fileRows = '<div class="qc-empty">工作区干净，没有可提交的改动。</div>';
        var hasChanges = (s.modifiedCount || 0) > 0;

        return '<section id="quick-commit-modal" class="modal-backdrop' + (state.quickCommitOpen ? '' : ' hidden') + '">' +
          '<div class="modal quick-commit-modal" role="dialog" aria-labelledby="quick-commit-title">' +
            '<div class="modal-header">' +
              '<div>' +
                '<h2 id="quick-commit-title" class="modal-title">快捷提交</h2>' +
                '<p class="modal-subtitle">' + escapeHtml((s.branch || "(no branch)") + ' · ' + (s.modifiedCount || 0) + ' 个改动') + '</p>' +
              '</div>' +
              '<button id="quick-commit-close-btn" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="qc-files-wrap">' + fileRows + '</div>' +
              '<div class="qc-message-row" id="quick-commit-message-row">' +
                '<div class="qc-message-header"><label class="field-label" for="quick-commit-message">commit message</label>' +
                  '<button type="button" id="quick-commit-ai-btn" class="btn btn-ghost btn-sm"' + (state.quickCommitGenerating ? ' disabled' : '') + '>' + (state.quickCommitGenerating ? '生成中…' : 'AI 生成') + '</button>' +
                '</div>' +
                '<textarea id="quick-commit-message" class="field-input" rows="2" placeholder="输入 commit message 或点击 AI 生成">' + escapeHtml(f.customMessage || "") + '</textarea>' +
              '</div>' +
              '<div class="qc-checkbox-row">' +
                '<label class="qc-checkbox-label" for="quick-commit-make-tag">提交后打 tag' + (s.latestTag ? '（当前：' + escapeHtml(s.latestTag) + '）' : '') + '</label>' +
                '<label class="qc-switch">' +
                  '<input type="checkbox" id="quick-commit-make-tag" class="switch-toggle"' + (f.makeTag ? ' checked' : '') + '>' +
                  '<span class="switch-slider"></span>' +
                '</label>' +
              '</div>' +
              '<div class="qc-tag-row' + (f.makeTag ? '' : ' hidden') + '" id="quick-commit-tag-row">' +
                '<input type="text" id="quick-commit-tag" class="field-input" placeholder="留空自动 bump patch' + (s.suggestedNextTag ? '（如 ' + escapeHtml(s.suggestedNextTag) + '）' : '') + '" value="' + escapeHtml(f.tag || "") + '">' +
              '</div>' +
              '<div class="qc-checkbox-row">' +
                '<label class="qc-checkbox-label" for="quick-commit-push">提交后 push 到远端</label>' +
                '<label class="qc-switch">' +
                  '<input type="checkbox" id="quick-commit-push" class="switch-toggle"' + (f.push ? ' checked' : '') + '>' +
                  '<span class="switch-slider"></span>' +
                '</label>' +
              '</div>' +
              '<p id="quick-commit-error" class="error-message' + (state.quickCommitError ? '' : ' hidden') + '">' + escapeHtml(state.quickCommitError || "") + '</p>' +
              '<div class="worktree-merge-actions">' +
                '<button id="quick-commit-cancel-btn" class="btn btn-secondary" type="button">取消</button>' +
                '<button id="quick-commit-submit-btn" class="btn btn-primary" type="button"' + (hasChanges && !state.quickCommitSubmitting ? '' : ' disabled') + '>' + (state.quickCommitSubmitting ? '提交中…' : '执行') + '</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderWorktreeMergeModal() {
        return '<section id="worktree-merge-modal" class="modal-backdrop hidden">' +
          '<div class="modal worktree-merge-modal">' +
            '<div class="modal-header">' +
              '<div>' +
                '<h2 class="modal-title">合并 Worktree</h2>' +
                '<p class="modal-subtitle">检查当前任务分支并快捷合并到主分支。</p>' +
              '</div>' +
              '<button id="close-worktree-merge-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div id="worktree-merge-content" class="worktree-merge-content"></div>' +
              '<p id="worktree-merge-error" class="error-message hidden"></p>' +
              '<div class="worktree-merge-actions">' +
                '<button id="worktree-merge-cancel-button" class="btn btn-secondary">取消</button>' +
                '<button id="worktree-merge-confirm-button" class="btn btn-primary">确认合并并清理</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderSettingsModal() {
        return '<section id="settings-modal" class="modal-backdrop hidden">' +
          '<div class="modal settings-modal">' +
            '<div class="modal-header settings-modal-header">' +
              '<div class="settings-modal-title-group">' +
                '<h2 class="modal-title">设置</h2>' +
                '<p class="settings-modal-subtitle">调整应用配置、通知、安全和显示偏好</p>' +
              '</div>' +
              '<button id="close-settings-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body settings-modal-body">' +
              '<div class="settings-layout">' +
                '<aside class="settings-sidebar">' +
                  '<div class="settings-sidebar-header">' +
                    '<div class="settings-sidebar-title">偏好设置</div>' +
                    '<div class="settings-sidebar-hint">左侧切换分区，右侧查看详细说明与选项。</div>' +
                  '</div>' +
                  '<div class="settings-tabs" role="tablist" aria-label="设置分组" aria-orientation="vertical">' +
                    '<button class="settings-tab active" data-tab="about" role="tab" aria-selected="true" aria-controls="settings-tab-about">' +
                      '<span class="settings-tab-main">关于</span>' +
                      '<span class="settings-tab-meta">版本、更新与连接方式</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="general" role="tab" aria-selected="false" aria-controls="settings-tab-general">' +
                      '<span class="settings-tab-main">基本配置</span>' +
                      '<span class="settings-tab-meta">主机、模式、语言、目录</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="notifications" role="tab" aria-selected="false" aria-controls="settings-tab-notifications">' +
                      '<span class="settings-tab-main">通知</span>' +
                      '<span class="settings-tab-meta">提示音与浏览器通知</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="security" role="tab" aria-selected="false" aria-controls="settings-tab-security">' +
                      '<span class="settings-tab-main">安全</span>' +
                      '<span class="settings-tab-meta">密码与证书</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="presets" role="tab" aria-selected="false" aria-controls="settings-tab-presets">' +
                      '<span class="settings-tab-main">命令预设</span>' +
                      '<span class="settings-tab-meta">查看已有预设</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="display" role="tab" aria-selected="false" aria-controls="settings-tab-display">' +
                      '<span class="settings-tab-main">显示</span>' +
                      '<span class="settings-tab-meta">卡片默认展开行为</span>' +
                    '</button>' +
                  '</div>' +
                '</aside>' +
                '<div class="settings-content">' +

              // About tab
              '<div class="settings-panel active" id="settings-tab-about" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">关于 Wand</h3>' +
                  '<p class="settings-panel-desc">查看版本信息、更新状态和 Android App 连接方式。</p>' +
                '</div>' +
                '<div class="settings-about-info">' +
                  '<div class="settings-about-row"><span class="settings-label">包名</span><span class="settings-value" id="settings-pkg-name">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">当前版本</span><span class="settings-value" id="settings-version">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">Node.js 要求</span><span class="settings-value" id="settings-node-req">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">仓库地址</span><span class="settings-value" id="settings-repo-url"><a href="#" target="_blank" rel="noopener">-</a></span></div>' +
                '</div>' +
                '<div class="settings-update-section" id="web-update-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">🌐</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">Web 端</h4>' +
                      '<p class="settings-section-sub">浏览器访问的服务版本</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-about-row">' +
                    '<span class="settings-label">最新版本</span>' +
                    '<span class="settings-value" id="settings-latest-version">-</span>' +
                  '</div>' +
                  '<div class="settings-update-actions">' +
                    '<button id="check-update-button" class="btn btn-secondary btn-sm">\u68c0\u67e5\u66f4\u65b0</button>' +
                    '<button id="do-update-button" class="btn btn-primary btn-sm hidden">\u66f4\u65b0\u5230\u6700\u65b0\u7248</button>' +
                    '<button id="do-restart-button" class="btn btn-success btn-sm hidden">\u91cd\u542f\u751f\u6548</button>' +
                  '</div>' +
                  '<p id="update-message" class="hint hidden"></p>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<span class="settings-toggle-title">自动更新</span>' +
                      '<span class="settings-toggle-desc">检测到新版本将自动下载安装并重启服务。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input type="checkbox" id="auto-update-web-toggle" class="switch-toggle">' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div class="settings-update-section hidden" id="android-apk-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">📱</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">Android App</h4>' +
                      '<p class="settings-section-sub">原生客户端版本与 APK 下载</p>' +
                    '</div>' +
                  '</div>' +
                  '<div id="android-apk-current-row" class="settings-about-row hidden">' +
                    '<span class="settings-label">当前版本</span>' +
                    '<span class="settings-value" id="settings-android-apk-current">-</span>' +
                  '</div>' +
                  '<div id="android-apk-github-row" class="settings-about-row settings-about-row-action hidden">' +
                    '<span class="settings-label">线上版本</span>' +
                    '<span class="settings-value settings-value-flex" id="settings-android-apk-github">-</span>' +
                    '<button id="download-github-apk-btn" class="btn btn-secondary btn-sm hidden" type="button">下载</button>' +
                  '</div>' +
                  '<div id="android-apk-local-row" class="settings-about-row settings-about-row-action hidden">' +
                    '<span class="settings-label">本地版本</span>' +
                    '<span class="settings-value settings-value-flex" id="settings-android-apk-local">-</span>' +
                    '<button id="download-local-apk-btn" class="btn btn-secondary btn-sm hidden" type="button">下载</button>' +
                  '</div>' +
                  '<div id="android-auto-update-row" class="settings-toggle-row hidden">' +
                    '<div class="settings-toggle-text">' +
                      '<span class="settings-toggle-title">自动更新</span>' +
                      '<span class="settings-toggle-desc" id="android-auto-update-hint">检测到新版 APK 将自动下载安装。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input type="checkbox" id="auto-update-apk-toggle" class="switch-toggle">' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                  '<p id="android-apk-message" class="hint hidden"></p>' +
                '</div>' +
                '<div class="settings-update-section" id="android-connect-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">🔗</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">App 连接码</h4>' +
                      '<p class="settings-section-sub">粘贴到 Android App 即可自动连接，无需密码；改密码后失效。</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-connect-url-box">' +
                    '<code id="android-connect-code" class="settings-connect-url-text">-</code>' +
                    '<button id="copy-connect-code-button" class="btn btn-secondary btn-sm" type="button" title="复制连接码">复制</button>' +
                  '</div>' +
                  '<div class="settings-connect-qr-box">' +
                    '<div class="settings-connect-qr-wrap" id="android-connect-qr-wrap" title="点击放大">' +
                      '<canvas id="android-connect-qr" width="180" height="180"></canvas>' +
                      '<div class="settings-connect-qr-empty" id="android-connect-qr-empty">生成中…</div>' +
                    '</div>' +
                    '<p class="settings-connect-qr-hint">用 Wand App 扫一扫，即可一键填入服务器地址与连接码。</p>' +
                  '</div>' +
                '</div>' +
              '</div>' +

              // Notifications tab
              '<div class="settings-panel" id="settings-tab-notifications" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">通知</h3>' +
                  '<p class="settings-panel-desc">设置提示音、系统通知和浏览器通知的行为。</p>' +
                '</div>' +
                '<div class="settings-notification-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">🔔</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">通知偏好</h4>' +
                      '<p class="settings-section-sub">提示音与应用内通知气泡</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<label class="settings-toggle-title" for="cfg-notif-sound">播放提示音</label>' +
                      '<span class="settings-toggle-desc">重要通知（版本更新、权限等待等）时播放柔和提示音。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input id="cfg-notif-sound" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                  '<div class="settings-range-row" id="notif-volume-field">' +
                    '<label class="settings-range-label" for="cfg-notif-volume">音量</label>' +
                    '<input id="cfg-notif-volume" type="range" min="0" max="100" step="5" class="settings-range" />' +
                    '<span id="cfg-notif-volume-val" class="settings-range-value">80%</span>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<label class="settings-toggle-title" for="cfg-notif-bubble">应用内通知气泡</label>' +
                      '<span class="settings-toggle-desc">在页面顶部弹出浮动通知气泡。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input id="cfg-notif-bubble" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div id="native-sound-section" class="settings-notification-section hidden">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">🎵</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">系统通知铃声</h4>' +
                      '<p class="settings-section-sub">选择 Android 系统通知使用的铃声</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-row-with-action">' +
                    '<select id="native-sound-select" class="field-input field-select"></select>' +
                    '<button id="native-sound-preview" class="btn btn-secondary btn-sm" type="button">▶ 试听</button>' +
                  '</div>' +
                '</div>' +
                '<div id="native-haptic-section" class="settings-notification-section hidden">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">📳</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">触感反馈</h4>' +
                      '<p class="settings-section-sub">按钮操作和任务完成时提供振动反馈</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<label class="settings-toggle-title" for="cfg-haptic-enabled">启用触感反馈</label>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input id="cfg-haptic-enabled" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div class="settings-notification-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">🌐</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">浏览器通知</h4>' +
                      '<p class="settings-section-sub">来自系统通知中心的弹窗</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-about-row">' +
                    '<span class="settings-label">授权状态</span>' +
                    '<span class="settings-value" id="notification-permission-status">-</span>' +
                  '</div>' +
                  '<div class="settings-update-actions">' +
                    '<button id="notification-request-btn" class="btn btn-primary btn-sm hidden" type="button">授权通知</button>' +
                    '<button id="notification-reset-btn" class="btn btn-ghost btn-sm hidden" type="button">重新授权</button>' +
                    '<button id="notification-test-btn" class="btn btn-secondary btn-sm" type="button">发送测试通知</button>' +
                    '<button id="notification-test-delay-btn" class="btn btn-ghost btn-sm" type="button">10 秒后发送</button>' +
                  '</div>' +
                  '<p id="notification-test-message" class="hint hidden"></p>' +
                '</div>' +
              '</div>' +

              // General config tab
              '<div class="settings-panel" id="settings-tab-general" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">基本配置</h3>' +
                  '<p class="settings-panel-desc">配置服务监听地址、默认模式、语言和工作目录。</p>' +
                '</div>' +
                '<div class="field-row">' +
                  '<div class="field">' +
                    '<label class="field-label" for="cfg-host">监听地址 (host)</label>' +
                    '<input id="cfg-host" type="text" class="field-input" placeholder="127.0.0.1" />' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="cfg-port">端口 (port)</label>' +
                    '<input id="cfg-port" type="number" class="field-input" placeholder="8443" min="1" max="65535" />' +
                  '</div>' +
                '</div>' +
                '<div class="settings-toggle-row">' +
                  '<div class="settings-toggle-text">' +
                    '<label class="settings-toggle-title" for="cfg-https">启用 HTTPS</label>' +
                    '<span class="settings-toggle-desc">使用自签名证书加密浏览器到服务的连接，host 为非 127.0.0.1 时建议开启。</span>' +
                  '</div>' +
                  '<label class="settings-switch">' +
                    '<input id="cfg-https" type="checkbox" class="switch-toggle" />' +
                    '<span class="switch-slider"></span>' +
                  '</label>' +
                '</div>' +
                '<div class="field-row">' +
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
                    '<label class="field-label" for="cfg-language">回复语言</label>' +
                    '<select id="cfg-language" class="field-input">' +
                      '<option value="">自动（不指定）</option>' +
                      '<option value="中文">中文</option>' +
                      '<option value="English">English</option>' +
                      '<option value="日本語">日本語</option>' +
                      '<option value="한국어">한국어</option>' +
                      '<option value="Español">Español</option>' +
                      '<option value="Français">Français</option>' +
                      '<option value="Deutsch">Deutsch</option>' +
                      '<option value="Русский">Русский</option>' +
                    '</select>' +
                  '</div>' +
                '</div>' +
                '<p class="field-hint" style="margin-top:-4px;">设置回复语言后，Claude 将尽量使用指定语言回复。</p>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-structured-runner">结构化会话 Runner</label>' +
                  '<select id="cfg-structured-runner" class="field-input">' +
                    '<option value="sdk">SDK（@anthropic-ai/claude-agent-sdk，默认）</option>' +
                    '<option value="cli">CLI（spawn claude -p）</option>' +
                  '</select>' +
                  '<p class="field-hint" style="margin-top:4px;">SDK 模式使用官方 Agent SDK 替代 CLI subprocess，接口更整洁，功能等价。保存后对新建会话立即生效。</p>' +
                '</div>' +
                '<div class="settings-toggle-row">' +
                  '<div class="settings-toggle-text">' +
                    '<label class="settings-toggle-title" for="cfg-inherit-env">继承环境变量</label>' +
                    '<span class="settings-toggle-desc">启动 PTY / 结构化子进程时，把当前服务进程的环境变量传给 claude / codex。关闭后子进程仅获得最小可用环境（PATH/HOME/SHELL/LANG/TERM 等），可用于隔离 API key 等敏感凭据。</span>' +
                  '</div>' +
                  '<label class="settings-switch">' +
                    '<input id="cfg-inherit-env" type="checkbox" class="switch-toggle" />' +
                    '<span class="switch-slider"></span>' +
                  '</label>' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-default-model">默认模型</label>' +
                  '<div class="settings-row-with-action">' +
                    '<select id="cfg-default-model" class="field-input field-select">' +
                      '<option value="">跟随 Claude Code 默认</option>' +
                    '</select>' +
                    '<button type="button" id="cfg-default-model-refresh" class="btn btn-secondary btn-sm" title="刷新模型列表">刷新</button>' +
                  '</div>' +
                  '<p class="field-hint" id="cfg-default-model-version">新建会话时默认使用该模型；运行中的会话可在输入框切换。</p>' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-cwd">默认工作目录</label>' +
                  '<input id="cfg-cwd" type="text" class="field-input" placeholder="/home/user" />' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-shell">Shell</label>' +
                  '<input id="cfg-shell" type="text" class="field-input" placeholder="/bin/bash" />' +
                '</div>' +
                (typeof WandNative !== "undefined" && typeof WandNative.getAppIcon === "function" ?
                '<div class="settings-app-icon-block">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">🎨</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">应用图标</h4>' +
                      '<p class="settings-section-sub">选择 App 启动器图标，返回桌面后生效</p>' +
                    '</div>' +
                  '</div>' +
                  '<div id="app-icon-picker" class="settings-app-icon-picker">' +
                    '<button type="button" class="settings-app-icon-option" data-icon="shorthair">' +
                      '<span class="settings-app-icon-preview">' +
                        PIXEL_AVATAR.user +
                      '</span>' +
                      '<span class="settings-app-icon-label">赛博虎妞</span>' +
                    '</button>' +
                    '<button type="button" class="settings-app-icon-option" data-icon="garfield">' +
                      '<span class="settings-app-icon-preview">' +
                        PIXEL_AVATAR.assistant +
                      '</span>' +
                      '<span class="settings-app-icon-label">勤劳初二</span>' +
                    '</button>' +
                  '</div>' +
                  '<p id="app-icon-message" class="hint hidden"></p>' +
                '</div>'
                : '') +
                '<div class="settings-actions settings-actions-sticky">' +
                  '<button id="save-config-button" class="btn btn-primary btn-block">保存配置</button>' +
                '</div>' +
                '<p id="config-message" class="hint hidden settings-status-message"></p>' +
              '</div>' +

              // Security tab
              '<div class="settings-panel" id="settings-tab-security" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">安全</h3>' +
                  '<p class="settings-panel-desc">管理登录密码与 SSL 证书，敏感变更请确认后再保存。</p>' +
                '</div>' +
                '<div class="settings-card">' +
                  '<div class="settings-card-head">' +
                    '<span class="settings-card-icon">\ud83d\udd12</span>' +
                    '<div class="settings-card-head-text">' +
                      '<h3 class="settings-card-title">修改密码</h3>' +
                      '<p class="settings-card-desc">至少 6 个字符；保存后下次登录生效。</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="new-password">新密码</label>' +
                    '<input id="new-password" type="password" class="field-input" placeholder="输入新密码（至少 6 个字符）" autocomplete="new-password" />' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="confirm-password">确认密码</label>' +
                    '<input id="confirm-password" type="password" class="field-input" placeholder="再次输入新密码" autocomplete="new-password" />' +
                  '</div>' +
                  '<div class="settings-card-actions">' +
                    '<button id="save-password-button" class="btn btn-primary">保存密码</button>' +
                  '</div>' +
                  '<p id="settings-error" class="error-message hidden"></p>' +
                  '<p id="settings-success" class="hint settings-success-message hidden"></p>' +
                '</div>' +
                '<div class="settings-card">' +
                  '<div class="settings-card-head">' +
                    '<span class="settings-card-icon">\ud83d\udd10</span>' +
                    '<div class="settings-card-head-text">' +
                      '<h3 class="settings-card-title">SSL 证书</h3>' +
                      '<p class="settings-card-desc" id="cert-status">加载中...</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="cert-key-file">私钥文件 (.key)</label>' +
                    '<div class="file-picker">' +
                      '<input id="cert-key-file" type="file" class="file-picker-input" accept=".key,.pem" />' +
                      '<label for="cert-key-file" class="file-picker-trigger">' +
                        '<svg class="file-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>' +
                        '<span class="file-picker-label">选择私钥</span>' +
                      '</label>' +
                      '<span class="file-picker-name" data-default="未选择文件">未选择文件</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="cert-cert-file">证书文件 (.crt/.pem)</label>' +
                    '<div class="file-picker">' +
                      '<input id="cert-cert-file" type="file" class="file-picker-input" accept=".crt,.pem,.cert" />' +
                      '<label for="cert-cert-file" class="file-picker-trigger">' +
                        '<svg class="file-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' +
                        '<span class="file-picker-label">选择证书</span>' +
                      '</label>' +
                      '<span class="file-picker-name" data-default="未选择文件">未选择文件</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-card-actions">' +
                    '<button id="upload-cert-button" class="btn btn-primary">上传证书</button>' +
                  '</div>' +
                  '<p id="cert-message" class="hint hidden"></p>' +
                '</div>' +
              '</div>' +

              // Command presets tab
              '<div class="settings-panel" id="settings-tab-presets" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">命令预设</h3>' +
                  '<p class="settings-panel-desc">当前命令预设从 config.json 读取，可在这里快速查看已有配置。</p>' +
                '</div>' +
                '<div id="presets-list" class="presets-list"></div>' +
              '</div>' +

              // Display settings tab
              '<div class="settings-panel" id="settings-tab-display" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">显示</h3>' +
                  '<p class="settings-panel-desc">控制聊天视图里不同卡片类型的默认展开状态。</p>' +
                '</div>' +
                '<div class="settings-section-title">卡片默认展开状态</div>' +
                '<p class="hint settings-inline-hint">设置结构化聊天视图中各类卡片的默认展开/折叠状态。手动操作的展开状态优先于此默认设置。</p>' +
                '<div class="switch-card-list">' +
                  '<label class="switch-card" for="cfg-card-edit">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">编辑卡片 (Edit/Write)</span>' +
                      '<input id="cfg-card-edit" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">文件编辑和写入操作的 diff 视图</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-inline">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">内联工具 (Read/Glob/Grep)</span>' +
                      '<input id="cfg-card-inline" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">文件读取、搜索等工具的结果</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-terminal">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">终端输出 (Bash)</span>' +
                      '<input id="cfg-card-terminal" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">命令行执行结果</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-thinking">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">思考过程 (Thinking)</span>' +
                      '<input id="cfg-card-thinking" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">Claude 的思考过程块</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-toolgroup">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">工具组</span>' +
                      '<input id="cfg-card-toolgroup" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">连续同类工具调用的折叠组</div>' +
                  '</label>' +
                '</div>' +
                '<div class="settings-actions settings-actions-sticky">' +
                  '<button id="save-display-button" class="btn btn-primary btn-block">保存显示设置</button>' +
                '</div>' +
                '<p id="display-message" class="hint hidden settings-status-message"></p>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderSessions() {
        var activeSessions = state.sessions.filter(function(session) { return !session.archived; });
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
          groups.push(renderArchivedGroup(archivedSessions));
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
            '<button class="btn btn-ghost btn-xs session-manage-toggle" data-action="toggle-manage-mode" type="button">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' +
              '<span>管理</span>' +
            '</button>' +
          '</div>';
        }

        var sessionCount = getSelectedSessionIds().length;
        var historyCount = getSelectedClaudeHistoryIds().length;
        var totalCount = sessionCount + historyCount;
        var hasAny = totalCount > 0;
        var selectable = countSelectableItems();
        var allSelected = selectable > 0 && totalCount >= selectable;
        var selectAllLabel = allSelected ? "取消全选" : "全选";
        var selectAllAction = allSelected ? "clear-selection" : "select-all-visible";
        var selectAllDisabled = selectable === 0 ? ' disabled' : '';

        // Linear-style toolbar:
        //   [N selected]  ─────────  [全选] [清空]  [delete (danger)] [完成 (primary)]
        return '<div class="session-manage-bar active">' +
          '<div class="session-manage-summary">' +
            '<span class="session-manage-count">' + totalCount + '</span>' +
            '<span class="session-manage-summary-label">已选择</span>' +
          '</div>' +
          '<div class="session-manage-actions">' +
            '<button class="btn btn-ghost btn-xs" data-action="' + selectAllAction + '" type="button"' + selectAllDisabled + '>' + selectAllLabel + '</button>' +
            '<button class="btn btn-ghost btn-xs" data-action="clear-selection" type="button"' + (hasAny ? '' : ' disabled') + '>清空</button>' +
            '<span class="session-manage-divider"></span>' +
            '<button class="btn btn-danger btn-xs" data-action="delete-selected" type="button"' + (hasAny ? '' : ' disabled') + '>删除</button>' +
            '<button class="btn btn-primary btn-xs" data-action="toggle-manage-mode" type="button">完成</button>' +
          '</div>' +
        '</div>';
      }

      function renderSessionGroup(title, sessions, kind) {
        return '<section class="session-group">' +
          '<div class="session-group-title">' + escapeHtml(title) + '</div>' +
          sessions.map(function(session) { return renderSessionItem(session, kind); }).join("") +
        '</section>';
      }

      function renderArchivedGroup(archivedSessions) {
        var expanded = !!state.archivedExpanded;
        var chevron = expanded ? "&#9662;" : "&#9656;";
        var header = '<div class="session-group-title claude-history-toggle" data-action="toggle-archived-group">' +
          '<span class="chevron">' + chevron + '</span> 已归档 ' +
          '<span class="history-count">' + archivedSessions.length + '</span>' +
          '</div>';
        if (!expanded) {
          return '<section class="session-group">' + header + '</section>';
        }
        var items = archivedSessions.map(function(session) { return renderSessionItem(session, "sessions"); }).join("");
        return '<section class="session-group">' + header + items + '</section>';
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
          ? '<button class="btn btn-danger btn-xs session-history-clear" data-action="clear-all-history" type="button">清空</button>'
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
        var managedIds = new Set();
        state.sessions.forEach(function(s) {
          if (s.claudeSessionId) managedIds.add(s.claudeSessionId);
        });
        return state.claudeHistory.filter(function(s) {
          return s.hasConversation && !s.managedByWand && !managedIds.has(s.claudeSessionId);
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

      function getSelectableSessions() {
        return state.sessions.slice();
      }

      function countSelectableItems() {
        return getSelectableSessions().length + getVisibleClaudeHistorySessions().length;
      }

      function selectAllVisibleItems() {
        var nextSessionIds = {};
        getSelectableSessions().forEach(function(session) {
          nextSessionIds[session.id] = true;
        });
        var nextHistoryIds = {};
        getVisibleClaudeHistorySessions().forEach(function(session) {
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
            '<button class="btn btn-danger btn-xs claude-history-directory-clear-btn" data-action="delete-history-directory" data-cwd="' +
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
      }

      function applyTerminalScale() {
        if (!state.terminal || !state.terminal.element) return;
        // 字号和行高都向上取整到整数像素：PC 端 1× DPR 下浏览器对亚像素
        // 字号/行高的舍入策略不一致（fontSize 16.25 → 16 或 17，行高
        // 19.5 → 19 或 20），相邻行/列的吸附方向不同就会让 wterm 网格
        // 错位。强制整数 px 让 cell 高度、字符高度都稳定一致，等价于
        // 之前桌面端必须按右上角缩放才能恢复的"整像素重排"路径。
        var rawFontSize = state.terminalBaseFontSize * state.terminalScale;
        var fontPx = Math.max(1, Math.round(rawFontSize));
        var rowPx = Math.max(1, Math.round(rawFontSize * 1.5));
        state.terminal.element.style.setProperty("--term-font-size", fontPx + "px");
        state.terminal.element.style.setProperty("--term-row-height", rowPx + "px");
        if (typeof state.terminal.remeasure === "function") {
          requestAnimationFrame(function() {
            if (state.terminal) state.terminal.remeasure();
          });
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
        state.fileExplorerLoading = true;
        state.allFiles = [];
        explorer.innerHTML = '<div class="file-explorer"><div class="tree-loading" style="padding:12px;color:var(--text-muted);font-size:0.8125rem;">Loading...</div></div>';
        // Update the cwd display
        if (cwdEl) cwdEl.textContent = cwd;
        // Fetch with git status
        fetch("/api/directory?q=" + encodeURIComponent(cwd) + "&gitStatus=true", { credentials: "same-origin" })
          .then(function(res) {
            if (!res.ok) {
              throw new Error("Failed to load directory.");
            }
            return res.json();
          })
          .then(function(items) {
            state.fileExplorerLoading = false;
            if (!items || items.length === 0) {
              explorer.innerHTML = '<div class="file-explorer empty">Empty directory or inaccessible.</div>';
              return;
            }
            state.allFiles = items;
            filterFileTree();
          })
          .catch(function() {
            state.fileExplorerLoading = false;
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
          var protectedHighlighted = highlighted.replace(/_/g, '&#95;').replace(/\*/g, '&#42;');
          return '<pre><code class="language-' + lang + '">' + protectedHighlighted + '</code></pre>';
        });

        // Inline code
        escaped = escaped.replace(/`([^`]+)`/g, function(_, code) {
          return '<code>' + code.replace(/_/g, '&#95;').replace(/\*/g, '&#42;') + '</code>';
        });

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
        escaped = escaped.replace(/(^|[^\w])___(\S(?:[^\n]*?\S)?)___(?!\w)/g, '$1<strong><em>$2</em></strong>');
        escaped = escaped.replace(/(^|[^\w])__(\S(?:[^\n]*?\S)?)__(?!\w)/g, '$1<strong>$2</strong>');
        escaped = escaped.replace(/(^|[^\w])_(\S(?:[^\n_]*?\S)?)_(?!\w)/g, '$1<em>$2</em>');

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

        // Tables (GFM)
        escaped = parseMarkdownTables(escaped);

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

      function timeAgo(isoString) {
        if (!isoString) return "";
        var now = Date.now();
        var then = new Date(isoString).getTime();
        var diff = Math.max(0, now - then);
        var seconds = Math.floor(diff / 1000);
        if (seconds < 60) return "刚刚";
        var minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + "分钟前";
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + "小时前";
        var days = Math.floor(hours / 24);
        if (days < 30) return days + "天前";
        return Math.floor(days / 30) + "个月前";
      }

      function elapsedTime(isoString) {
        if (!isoString) return "";
        var now = Date.now();
        var then = new Date(isoString).getTime();
        var diff = Math.max(0, now - then);
        var seconds = Math.floor(diff / 1000);
        var minutes = Math.floor(seconds / 60);
        var hours = Math.floor(minutes / 60);
        if (hours > 0) return hours + "h" + (minutes % 60 > 0 ? (minutes % 60) + "m" : "");
        if (minutes > 0) return minutes + "m";
        return seconds + "s";
      }

      function getSessionStatusLabel(session) {
        if (!session) return "";
        if (session.archived) return "已归档";
        if (session.permissionBlocked) return "等待授权";
        if (isStructuredSession(session) && session.structuredState && session.structuredState.inFlight) return "思考中";
        var statusMap = {
          "idle": "空闲",
          "stopped": "已停止",
          "running": "运行中",
          "exited": "已退出",
          "failed": "已失败"
        };
        return statusMap[session.status] || session.status;
      }

      function getSessionStatusClass(session) {
        if (!session) return "";
        if (session.archived) return "archived";
        if (session.permissionBlocked) return "permission-blocked";
        if (isStructuredSession(session) && session.structuredState && session.structuredState.inFlight) return "running";
        return session.status || "";
      }

      /** Get a human-readable activity description for a running session */
      function getSessionActivityDesc(session) {
        if (!session) return "";
        if (session.permissionBlocked) return "等待你的授权";
        if (session.status !== "running") return "";
        // Check WebSocket-delivered currentTask first
        if (session.id === state.selectedId && state.currentTask && state.currentTask.title) {
          return state.currentTask.title;
        }
        // Fall back to snapshot-delivered currentTaskTitle
        if (session.currentTaskTitle) return session.currentTaskTitle;
        return "";
      }

      /** Get the last meaningful assistant text from messages for notification/display */
      function getLastAssistantSummary(session) {
        var msgs = session && session.messages;
        if (!msgs || msgs.length === 0) return "";
        for (var i = msgs.length - 1; i >= 0; i--) {
          var msg = msgs[i];
          if (msg.role !== "assistant") continue;
          var blocks = msg.content || [];
          for (var j = 0; j < blocks.length; j++) {
            if (blocks[j].type === "text" && blocks[j].text && blocks[j].text.trim()) {
              var text = blocks[j].text.trim();
              // Strip markdown formatting for compact display
              text = text.replace(/^#+\s+/gm, "").replace(/\*\*/g, "").replace(/`/g, "");
              var firstLine = text.split("\n")[0].trim();
              return firstLine.slice(0, 100);
            }
          }
        }
        return "";
      }

      function renderSessionItem(session) {
        var activeClass = session.id === state.selectedId ? " active" : "";
        var selectedClass = state.sessionsManageMode && state.selectedSessionIds[session.id] ? " selected" : "";
        var metaStatus = getSessionStatusLabel(session);
        var metaStatusClass = getSessionStatusClass(session);
        var resumeButton = "";
        var checkbox = renderManageCheckbox("sessions", session.id, "选择会话 " + session.command);

        if (session.provider === "claude" && session.claudeSessionId) {
          if (session.status !== "running" && !state.sessionsManageMode && !isStructuredSession(session)) {
            resumeButton = '<button class="session-action-btn" data-action="resume" data-session-id="' + session.id + '" type="button" aria-label="恢复会话" title="恢复 Claude 会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';
          }
        }

        var canOpenMerge = !state.sessionsManageMode && session.worktreeEnabled && session.worktree && session.worktree.branch && session.worktree.path;
        var needsCleanup = session.worktreeMergeStatus === "merged" && session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false;
        var mergeDisabled = session.status === "running" || session.worktreeMergeStatus === "merging";
        var mergeTitle = needsCleanup ? "重试清理 worktree" : "合并到主分支";
        var mergeButton = canOpenMerge && session.worktreeMergeStatus !== "merged"
          ? '<button class="session-action-btn merge-btn" data-action="worktree-merge" data-session-id="' + session.id + '" type="button" aria-label="' + escapeHtml(mergeTitle) + '" title="' + escapeHtml(mergeTitle) + '"' + (mergeDisabled ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10"/><path d="M7 12h10"/><path d="M7 17h10"/><path d="M5 7l-2 2 2 2"/><path d="M19 15l2 2-2 2"/></svg></button>'
          : needsCleanup
            ? '<button class="session-action-btn merge-btn" data-action="worktree-cleanup" data-session-id="' + session.id + '" type="button" aria-label="重试清理 worktree" title="重试清理 worktree"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>'
            : "";
        var deleteButton = state.sessionsManageMode ? '' : '<button class="session-action-btn delete-btn" data-action="delete-session" data-session-id="' + session.id + '" type="button" aria-label="删除会话" title="删除此会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
        var actionsHtml = '<span class="session-actions">' + resumeButton + mergeButton + deleteButton + '</span>';

        // Title: summary or command
        var titleHtml = session.summary
          ? '<div class="session-title">' + escapeHtml(session.summary) + '</div>'
          : '<div class="session-command">' + escapeHtml(session.resumedFromSessionId ? session.command.replace(/\s+--resume\s+\S+/, '') : session.command) + '</div>';

        // Activity description for running sessions
        var activityDesc = getSessionActivityDesc(session);
        var activityHtml = "";
        if (session.status === "running" && activityDesc) {
          activityHtml = '<div class="session-activity">' + escapeHtml(activityDesc) + '</div>';
        }

        // Time display
        var timeDisplay = "";
        if (session.status === "running") {
          timeDisplay = '<span class="session-time" title="已运行 ' + escapeHtml(elapsedTime(session.startedAt)) + '">' + escapeHtml(elapsedTime(session.startedAt)) + '</span>';
        } else if (session.endedAt) {
          timeDisplay = '<span class="session-time" title="' + escapeHtml(new Date(session.endedAt).toLocaleString()) + '">' + escapeHtml(timeAgo(session.endedAt)) + '</span>';
        } else if (session.startedAt) {
          timeDisplay = '<span class="session-time" title="' + escapeHtml(new Date(session.startedAt).toLocaleString()) + '">' + escapeHtml(timeAgo(session.startedAt)) + '</span>';
        }

        // Badges: worktree only (removed PTY/Structured and mode badges for cleaner look)
        var badgesHtml = renderWorktreeBadge(session);

        // Recovery hint
        var recoveryHtml = session.autoRecovered ? '<span class="session-recovery-hint">自动恢复</span>' : '';

        return '<div class="session-item' + activeClass + selectedClass + '" data-session-id="' + session.id + '" role="button" tabindex="0">' +
          '<div class="session-item-content">' +
            '<div class="session-item-row">' +
              checkbox +
              '<div class="session-main">' +
                '<div class="session-title-row">' +
                  titleHtml +
                  timeDisplay +
                '</div>' +
                activityHtml +
                '<div class="session-meta">' +
                  '<span class="session-status ' + metaStatusClass + '">' + escapeHtml(metaStatus) + '</span>' +
                  badgesHtml +
                  recoveryHtml +
                '</div>' +
              '</div>' +
              actionsHtml +
            '</div>' +
          '</div>' +
        '</div>';
      }

      function getWorktreeMergeStatusLabel(session) {
        if (!session || !session.worktreeMergeStatus) return "";
        var labels = {
          ready: "可合并",
          checking: "检查中",
          merging: "合并中",
          merged: session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false ? "已合并待清理" : "已合并",
          failed: "合并失败"
        };
        return labels[session.worktreeMergeStatus] || "";
      }

      function renderWorktreeMergeBadge(session) {
        var label = getWorktreeMergeStatusLabel(session);
        if (!label) return "";
        return '<span class="session-kind-badge worktree-merge ' + escapeHtml(session.worktreeMergeStatus || "") + '">' + escapeHtml(label) + '</span>';
      }

      function renderWorktreeBadge(session) {
        if (!session || !session.worktreeEnabled) return "";
        var titleParts = [];
        if (session.worktree && session.worktree.branch) {
          titleParts.push('Worktree: ' + session.worktree.branch);
        }
        if (session.worktree && session.worktree.path) {
          titleParts.push('Path: ' + session.worktree.path);
        }
        var title = titleParts.length > 0 ? ' title="' + escapeHtml(titleParts.join('\n')) + '"' : '';
        return '<span class="session-kind-badge worktree"' + title + '>Worktree</span>' + renderWorktreeMergeBadge(session);
      }

      function renderSessionKindBadge(session) {
        if (!session) return "";
        var primary = isStructuredSession(session)
          ? '<span class="session-kind-badge structured">Structured</span>'
          : '<span class="session-kind-badge pty">PTY</span>';
        return primary + renderWorktreeBadge(session);
      }

      function renderModeCards(selectedMode) {
        var modes = [
          { id: "managed",     label: "托管",     desc: "全自动完成任务" },
          { id: "full-access", label: "全权限",   desc: "自动确认权限" },
          { id: "auto-edit",   label: "自动编辑", desc: "自动确认修改" },
          { id: "default",     label: "标准",     desc: "逐步确认操作" },
          { id: "native",      label: "原生",     desc: "原生结构化输出" }
        ];
        return modes.map(function(m) {
          var active = m.id === selectedMode ? " active" : "";
          return '<button type="button" class="mode-card' + active + '" data-mode="' + m.id + '">' +
            '<span class="mode-card-label">' + m.label + '</span>' +
            '<span class="mode-card-desc">' + m.desc + '</span>' +
          '</button>';
        }).join("");
      }

      function renderProviderOptions(selectedTool) {
        var tools = [
          { id: "claude", label: "Claude", desc: "完整 Claude 会话能力" },
          { id: "codex", label: "Codex", desc: "结构化 JSONL 或 PTY 会话" }
        ];
        return tools.map(function(tool) {
          var active = tool.id === selectedTool ? " active" : "";
          return '<button type="button" class="mode-card provider-card' + active + '" data-provider="' + tool.id + '">' +
            '<span class="mode-card-label">' + tool.label + '</span>' +
            '<span class="mode-card-desc">' + tool.desc + '</span>' +
          '</button>';
        }).join("");
      }

      function renderSessionKindOptions(selectedKind) {
        var kinds = [
          { id: "structured", label: "结构化", desc: "智能对话模式" },
          { id: "pty", label: "PTY", desc: "交互式终端会话" }
        ];
        return kinds.map(function(kind) {
          var active = kind.id === selectedKind ? " active" : "";
          var disabled = "";
          return '<button type="button" class="mode-card session-kind-card' + active + disabled + '" data-session-kind="' + kind.id + '">' +
            '<span class="mode-card-label">' + kind.label + '</span>' +
            '<span class="mode-card-desc">' + kind.desc + '</span>' +
          '</button>';
        }).join("");
      }

      function renderWorktreeToggle(enabled) {
        return '<label class="session-inline-toggle" for="session-worktree-toggle" title="为该会话创建独立的 git worktree 分支">' +
          '<svg class="session-inline-toggle-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<circle cx="6" cy="6" r="2.2"/>' +
            '<circle cx="18" cy="6" r="2.2"/>' +
            '<circle cx="12" cy="18" r="2.2"/>' +
            '<path d="M6 8.2v3.4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8.2"/>' +
            '<path d="M12 13.6v2.2"/>' +
          '</svg>' +
          '<span class="session-inline-toggle-label">Worktree 模式</span>' +
          '<input id="session-worktree-toggle" type="checkbox" class="switch-toggle"' + (enabled ? ' checked' : '') + ' />' +
          '<span class="switch-slider" aria-hidden="true"></span>' +
        '</label>';
      }

      function getSessionKindHint(kind) {
        var tool = state.sessionTool || "claude";
        if (kind === "structured") {
          return tool === "codex"
            ? "Codex JSONL 结构化聊天界面，支持多轮对话和工具调用展示。"
            : "结构化聊天界面，支持多轮对话、流式输出和工具调用展示。";
        }
        if (tool === "codex") {
          return "Codex PTY 终端会话；terminal 是原始输出，chat 是解析后的阅读视图。";
        }
        return "原始 PTY 终端会话，支持持续交互、终端视图和权限流。";
      }

      function renderSessionModal() {
        var modalTool = getPreferredTool();
        var modalMode = getSafeModeForTool(modalTool, state.modeValue || state.chatMode || "default");
        var sessionKind = state.sessionCreateKind || "structured";
        var worktreeEnabled = state.sessionCreateWorktree === true;
        return '<section id="session-modal" class="modal-backdrop hidden">' +
          '<div class="modal session-modal">' +
            '<div class="modal-header">' +
              '<div>' +
                '<h2 class="modal-title">新对话</h2>' +
                '<p class="modal-subtitle">启动 Claude 或 Codex 会话，选择 provider、会话类型、模式和工作目录。</p>' +
              '</div>' +
              '<button id="close-modal-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label">Provider</label>' +
                '<div id="provider-cards" class="mode-cards">' +
                  renderProviderOptions(modalTool) +
                '</div>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label">会话类型</label>' +
                '<div id="session-kind-cards" class="mode-cards">' +
                  renderSessionKindOptions(sessionKind) +
                '</div>' +
                '<div class="field-hint session-kind-hint-row">' +
                  '<span id="session-kind-description">' + escapeHtml(getSessionKindHint(sessionKind)) + '</span>' +
                  renderWorktreeToggle(worktreeEnabled) +
                '</div>' +
              '</div>' +
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
            '</div>' +
            '<div class="modal-footer">' +
              '<button id="run-button" class="btn btn-primary btn-block">启动会话</button>' +
              '<p id="modal-error" class="error-message hidden"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      // Global toggle function for tool card headers — called via onclick attribute
      // Lazy-load tool content for truncated results
      function __fetchToolContent(toolUseId, callback) {
        if (!state.selectedId || !toolUseId) return;
        var cacheKey = state.selectedId + ":" + toolUseId;
        if (state.toolContentCache[cacheKey]) {
          callback(null, state.toolContentCache[cacheKey]);
          return;
        }
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/tool-content/" + encodeURIComponent(toolUseId), { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.error) {
              callback(data.error, null);
            } else {
              state.toolContentCache[cacheKey] = data;
              callback(null, data);
            }
          })
          .catch(function() {
            callback("加载失败", null);
          });
      }

      function getCardDefault(key) {
        return !!(state.config && state.config.cardDefaults && state.config.cardDefaults[key]);
      }

      function lazyLoadTruncatedToolContent(container, targetEl, renderContent, renderError) {
        if (!container || container.dataset.truncated !== "true" || container.dataset.loaded === "true") return;
        var toolUseId = container.dataset.toolUseId;
        if (!toolUseId) return;
        if (targetEl) targetEl.innerHTML = '<div class="tool-content-loading">加载中…</div>';
        container.dataset.loaded = "loading";
        __fetchToolContent(toolUseId, function(err, data) {
          if (err) {
            if (targetEl) targetEl.innerHTML = renderError || '<div class="tool-content-error">加载失败，点击重试</div>';
            container.dataset.loaded = "";
            return;
          }
          container.dataset.truncated = "false";
          container.dataset.loaded = "true";
          var content = typeof data.content === "string" ? data.content : JSON.stringify(data.content);
          renderContent(content, data);
        });
      }

      window.__tcToggle = function(e, headerEl) {
        var card = headerEl.closest(".tool-use-card") || headerEl.closest(".inline-diff");
        if (card) {
          var wasCollapsed = card.classList.contains("collapsed");
          card.classList.toggle("collapsed");
          var expandKind = card.dataset.expandKind || "tool-card";
          persistElementExpandState(card, expandKind);
          if (wasCollapsed) {
            var resultDiv = card.querySelector(".tool-use-result");
            lazyLoadTruncatedToolContent(
              card,
              resultDiv,
              function(content) {
                if (resultDiv) resultDiv.innerHTML = '<pre class="tool-use-result-content">' + escapeHtml(content) + '</pre>';
              },
              '<div class="tool-content-error" onclick="__tcToggle(null, this.closest(\'.tool-use-card,.inline-diff\').querySelector(\'.tool-use-header,.diff-header\'))">加载失败，点击重试</div>'
            );
          }
        }
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
        persistElementExpandState(el, "thinking");
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
            statusSpan.textContent = "✗";
          } else if (el.dataset.status === "done") {
            statusSpan.textContent = "✓";
          }
        }
        if (expanded) {
          lazyLoadTruncatedToolContent(el, body, function(content) {
            el.dataset.result = content;
            if (body) body.innerHTML = '<div class="inline-tool-result">' + formatInlineResult(content, "") + '</div>';
          });
        }
        persistElementExpandState(el, "inline-tool");
      };
      // Toggle function for terminal tool blocks
      window.__terminalExpand = function(el) {
        var container = el.closest(".inline-terminal");
        if (!container) return;
        var body = container.querySelector(".term-body");
        if (body) {
          var isHidden = body.style.display === "none";
          body.style.display = isHidden ? "block" : "none";
          container.dataset.expanded = isHidden ? "true" : "false";
          var toggleIcon = el.querySelector(".term-toggle-icon");
          if (toggleIcon) toggleIcon.textContent = isHidden ? "▼" : "▶";
          persistElementExpandState(container, "terminal");
          if (isHidden) {
            var termOutput = body.querySelector(".term-output");
            lazyLoadTruncatedToolContent(container, termOutput, function(content) {
              if (termOutput) {
                var lines = content.split("\n");
                var html = "";
                for (var i = 0; i < lines.length; i++) {
                  if (!lines[i] && i === lines.length - 1) continue;
                  html += '<div class="term-line">' + escapeHtml(lines[i]) + '</div>';
                }
                termOutput.innerHTML = html;
              }
            });
          }
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
      // ── AskUserQuestion handlers: select → render → submit ──
      window.__askSelect = function(toolUseId, qIdx, optIdx, isMulti) {
        var sel = state.askUserSelections[toolUseId];
        if (!sel) {
          sel = { submitted: false };
          state.askUserSelections[toolUseId] = sel;
        }
        if (sel.submitted) return;
        var current = sel[qIdx] || [];
        if (isMulti) {
          var pos = current.indexOf(optIdx);
          if (pos === -1) { current.push(optIdx); } else { current.splice(pos, 1); }
        } else {
          current = current[0] === optIdx ? [] : [optIdx];
        }
        sel[qIdx] = current;
        window.__askRender(toolUseId);
      };

      window.__askRender = function(toolUseId) {
        var card = document.querySelector('[data-tool-use-id="' + toolUseId + '"]');
        if (!card) return;
        var sel = state.askUserSelections[toolUseId] || {};
        // Update option selected states
        card.querySelectorAll(".ask-user-option").forEach(function(btn) {
          var qIdx = parseInt(btn.dataset.questionIndex, 10);
          var oIdx = parseInt(btn.dataset.optionIndex, 10);
          var chosen = (sel[qIdx] || []).indexOf(oIdx) !== -1;
          btn.classList.toggle("selected", chosen);
        });
        // Update submit button: enabled only when every question has at least one selection
        var submitBtn = card.querySelector(".ask-user-submit");
        if (submitBtn) {
          var groups = card.querySelectorAll(".ask-user-question-group");
          var allAnswered = true;
          groups.forEach(function(g, i) {
            if (!sel[i] || sel[i].length === 0) allAnswered = false;
          });
          submitBtn.disabled = !allAnswered || !!sel.submitted;
          if (sel.submitted) {
            submitBtn.textContent = "已提交...";
            submitBtn.classList.add("ask-user-submitted");
          }
        }
      };

      window.__askSubmit = function(toolUseId) {
        var sel = state.askUserSelections[toolUseId];
        if (!sel || sel.submitted || !state.selectedId) return;
        var card = document.querySelector('[data-tool-use-id="' + toolUseId + '"]');
        if (!card) return;
        var groups = card.querySelectorAll(".ask-user-question-group");
        var lines = [];
        var allAnswered = true;
        groups.forEach(function(group, qIdx) {
          var selected = sel[qIdx] || [];
          if (selected.length === 0) { allAnswered = false; return; }
          var labels = [];
          selected.forEach(function(optIdx) {
            var btn = group.querySelector('[data-option-index="' + optIdx + '"]');
            if (btn) labels.push(btn.dataset.optionLabel);
          });
          lines.push(labels.join(", "));
        });
        if (!allAnswered) return;
        sel.submitted = true;
        window.__askRender(toolUseId);
        var answerText = lines.join("\n");
        fetch("/api/sessions/" + state.selectedId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: answerText + "\n", view: state.currentView })
        }).catch(function(err) {
          console.error("[wand] Error sending answer:", err);
          sel.submitted = false;
          window.__askRender(toolUseId);
        });
      };
      function attachEventListeners() {

        var loginButton = document.getElementById("login-button");
        if (loginButton) {
          loginButton.addEventListener("click", login);
          var loginSwitchServerBtn = document.getElementById("login-switch-server-button");
          if (loginSwitchServerBtn) loginSwitchServerBtn.addEventListener("click", switchServer);
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
        var welcomeCodexBtn = document.getElementById("welcome-tool-codex");
        if (welcomeCodexBtn) {
          welcomeCodexBtn.addEventListener("click", function() {
            state.sessionTool = "codex";
            state.preferredCommand = "codex";
            state.modeValue = "full-access";
            quickStartSession();
          });
        }
        var welcomeStructuredBtn = document.getElementById("welcome-tool-structured");
        if (welcomeStructuredBtn) {
          welcomeStructuredBtn.addEventListener("click", function() {
            createStructuredSession().then(function() {
              focusInputBox(true);
            }).catch(function(error) {
              showToast((error && error.message) || "无法启动结构化会话。", "error");
            });
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

        var providerCardsEl = document.getElementById("provider-cards");
        if (providerCardsEl) providerCardsEl.addEventListener("click", function(e) {
          var card = e.target.closest(".provider-card");
          if (!card || card.classList.contains("disabled")) return;
          var provider = card.getAttribute("data-provider");
          if (provider) {
            state.sessionTool = provider;
            state.preferredCommand = provider;
            // Codex 现在同时支持 PTY 与结构化 runner，不再强制把 kind 切成 pty。
            // mode 由 syncSessionModalUI() 调用 getSafeModeForTool() 自动 clamp，
            // 不在这里硬写。
            syncSessionModalUI();
          }
        });

        var kindCardsEl = document.getElementById("session-kind-cards");
        if (kindCardsEl) kindCardsEl.addEventListener("click", function(e) {
          var card = e.target.closest(".session-kind-card");
          if (!card || card.classList.contains("disabled")) return;
          var kind = card.getAttribute("data-session-kind");
          if (kind) {
            state.sessionCreateKind = kind;
            syncSessionModalUI();
          }
        });

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
        var worktreeToggleEl = document.getElementById("session-worktree-toggle");
        if (worktreeToggleEl) worktreeToggleEl.addEventListener("change", function() {
          state.sessionCreateWorktree = this.checked;
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
        var pinBtn = document.getElementById("sidebar-pin-btn");
        if (pinBtn) pinBtn.addEventListener("click", toggleSidebarPin);
        var sidebarMoreBtn = document.getElementById("sidebar-more-btn");
        var sidebarOverflow = document.getElementById("sidebar-overflow-menu");
        if (sidebarMoreBtn && sidebarOverflow) {
          sidebarMoreBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            sidebarOverflow.classList.toggle("open");
          });
          document.addEventListener("click", function() {
            sidebarOverflow.classList.remove("open");
          });
        }
        var homeBtn = document.getElementById("sidebar-home-btn");
        if (homeBtn) homeBtn.addEventListener("click", function() {
          state.selectedId = null;
          persistSelectedId();
          resetChatRenderCache();
          closeSessionsDrawer();
          render();
        });
        var refreshBtn = document.getElementById("sidebar-refresh-btn");
        if (refreshBtn) refreshBtn.addEventListener("click", function() {
          window.location.reload();
        });
        var logoutBtn = document.getElementById("logout-button");
        if (logoutBtn) logoutBtn.addEventListener("click", logout);
        var switchServerBtn = document.getElementById("switch-server-button");
        if (switchServerBtn) switchServerBtn.addEventListener("click", switchServer);
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
            var btn = e.currentTarget || this;
            var tabName = btn && btn.getAttribute ? btn.getAttribute("data-tab") : null;
            if (tabName) switchSettingsTab(tabName);
          });
        }
        var saveConfigBtn = document.getElementById("save-config-button");
        if (saveConfigBtn) saveConfigBtn.addEventListener("click", saveConfigSettings);
        var defaultModelRefreshBtn = document.getElementById("cfg-default-model-refresh");
        if (defaultModelRefreshBtn) defaultModelRefreshBtn.addEventListener("click", refreshAvailableModels);
        var saveDisplayBtn = document.getElementById("save-display-button");
        if (saveDisplayBtn) saveDisplayBtn.addEventListener("click", saveDisplaySettings);
        // App icon picker (APK only)
        var appIconPicker = document.getElementById("app-icon-picker");
        if (appIconPicker) {
          var appIconOpts = appIconPicker.querySelectorAll(".settings-app-icon-option");
          for (var ai = 0; ai < appIconOpts.length; ai++) {
            appIconOpts[ai].addEventListener("click", function() {
              var iconName = this.getAttribute("data-icon");
              if (!iconName || typeof WandNative === "undefined" || typeof WandNative.setAppIcon !== "function") return;
              try {
                WandNative.setAppIcon(iconName);
                _updateAppIconSelection(iconName);
                var msgEl = document.getElementById("app-icon-message");
                if (msgEl) {
                  msgEl.textContent = "图标已切换，返回桌面后生效";
                  msgEl.style.color = "var(--success)";
                  msgEl.classList.remove("hidden");
                  setTimeout(function() { msgEl.classList.add("hidden"); }, 3000);
                }
              } catch (_e) {}
            });
          }
        }
        var uploadCertBtn = document.getElementById("upload-cert-button");
        if (uploadCertBtn) uploadCertBtn.addEventListener("click", uploadCertificates);
        var filePickerInputs = document.querySelectorAll(".file-picker-input");
        for (var fpi = 0; fpi < filePickerInputs.length; fpi++) {
          (function(input) {
            input.addEventListener("change", function() {
              var picker = input.closest(".file-picker");
              if (!picker) return;
              var nameEl = picker.querySelector(".file-picker-name");
              if (!nameEl) return;
              if (input.files && input.files[0]) {
                nameEl.textContent = input.files[0].name;
                picker.classList.add("file-picker-has-file");
              } else {
                nameEl.textContent = nameEl.getAttribute("data-default") || "未选择文件";
                picker.classList.remove("file-picker-has-file");
              }
            });
          })(filePickerInputs[fpi]);
        }
        var checkUpdateBtn = document.getElementById("check-update-button");
        if (checkUpdateBtn) checkUpdateBtn.addEventListener("click", checkForUpdate);
        var doUpdateBtn = document.getElementById("do-update-button");
        if (doUpdateBtn) doUpdateBtn.addEventListener("click", performUpdate);
        var doRestartBtn = document.getElementById("do-restart-button");
        if (doRestartBtn) doRestartBtn.addEventListener("click", performSettingsRestart);
        var autoUpdateWebToggle = document.getElementById("auto-update-web-toggle");
        if (autoUpdateWebToggle) autoUpdateWebToggle.addEventListener("change", function() {
          toggleAutoUpdate("web", autoUpdateWebToggle.checked);
        });
        var autoUpdateApkToggle = document.getElementById("auto-update-apk-toggle");
        if (autoUpdateApkToggle) autoUpdateApkToggle.addEventListener("change", function() {
          toggleAutoUpdate("apk", autoUpdateApkToggle.checked);
        });
        var copyConnectCodeBtn = document.getElementById("copy-connect-code-button");
        if (copyConnectCodeBtn) copyConnectCodeBtn.addEventListener("click", function() {
          var text = document.getElementById("android-connect-code");
          if (text) copyToClipboard(text.textContent, copyConnectCodeBtn);
        });
        // Notification preferences
        var notifSoundEl = document.getElementById("cfg-notif-sound");
        if (notifSoundEl) {
          notifSoundEl.checked = state.notifSound;
          notifSoundEl.addEventListener("change", function() {
            state.notifSound = notifSoundEl.checked;
            try { localStorage.setItem("wand-notif-sound", String(state.notifSound)); } catch (e) {}
            // Preview sound when toggling on
            if (state.notifSound) _doPlaySound();
            // Toggle volume slider visibility
            var volField = document.getElementById("notif-volume-field");
            if (volField) volField.style.display = state.notifSound ? "" : "none";
          });
        }
        // Volume slider
        var notifVolumeEl = document.getElementById("cfg-notif-volume");
        var notifVolumeVal = document.getElementById("cfg-notif-volume-val");
        // Helper to keep the iOS-style range fill in sync with the input value
        var _syncRangeFill = function(el) {
          if (!el) return;
          var minVal = Number(el.min || 0);
          var maxVal = Number(el.max || 100);
          var curVal = Number(el.value || 0);
          var pct = maxVal > minVal
            ? Math.max(0, Math.min(100, ((curVal - minVal) / (maxVal - minVal)) * 100))
            : 0;
          el.style.setProperty("--range-fill", pct + "%");
        };
        if (notifVolumeEl) {
          notifVolumeEl.value = state.notifVolume;
          if (notifVolumeVal) notifVolumeVal.textContent = state.notifVolume + "%";
          _syncRangeFill(notifVolumeEl);
          // Hide if sound is off
          var volField = document.getElementById("notif-volume-field");
          if (volField) volField.style.display = state.notifSound ? "" : "none";
          var _volDebounce = null;
          notifVolumeEl.addEventListener("input", function() {
            state.notifVolume = parseInt(notifVolumeEl.value, 10);
            if (notifVolumeVal) notifVolumeVal.textContent = state.notifVolume + "%";
            _syncRangeFill(notifVolumeEl);
            try { localStorage.setItem("wand-notif-volume", String(state.notifVolume)); } catch (e) {}
            // Also sync to native bridge if available
            if (_hasNativeBridge && typeof WandNative.setNotificationVolume === "function") {
              try { WandNative.setNotificationVolume(state.notifVolume); } catch (_e) {}
            }
          });
          // Preview on release
          notifVolumeEl.addEventListener("change", function() {
            _doPlaySound();
          });
        }
        var notifBubbleEl = document.getElementById("cfg-notif-bubble");
        if (notifBubbleEl) {
          notifBubbleEl.checked = state.notifBubble;
          notifBubbleEl.addEventListener("change", function() {
            state.notifBubble = notifBubbleEl.checked;
            try { localStorage.setItem("wand-notif-bubble", String(state.notifBubble)); } catch (e) {}
          });
        }
        // Browser notification section
        var notifRequestBtn = document.getElementById("notification-request-btn");
        if (notifRequestBtn) notifRequestBtn.addEventListener("click", function() {
          if (_hasNativeBridge) {
            window._onNativePermissionResult = function() {
              updateNotificationStatus();
              delete window._onNativePermissionResult;
            };
            try { WandNative.requestPermission(); } catch (_e) {}
          } else if (typeof Notification !== "undefined") {
            Notification.requestPermission().then(function() { updateNotificationStatus(); });
          }
        });
        var notifResetBtn = document.getElementById("notification-reset-btn");
        if (notifResetBtn) notifResetBtn.addEventListener("click", resetNotificationPermission);
        var notifTestBtn = document.getElementById("notification-test-btn");
        if (notifTestBtn) notifTestBtn.addEventListener("click", testNotification);
        var notifTestDelayBtn = document.getElementById("notification-test-delay-btn");
        if (notifTestDelayBtn) notifTestDelayBtn.addEventListener("click", scheduleTestNotification);
        updateNotificationStatus();
        // Native notification sound selector (APK only)
        if (_hasNativeBridge && typeof WandNative.getAvailableSounds === "function") {
          var nativeSoundSection = document.getElementById("native-sound-section");
          var nativeSoundSelect = document.getElementById("native-sound-select");
          var nativeSoundPreview = document.getElementById("native-sound-preview");
          if (nativeSoundSection && nativeSoundSelect) {
            nativeSoundSection.classList.remove("hidden");
            try {
              var sounds = JSON.parse(WandNative.getAvailableSounds());
              var current = WandNative.getNotificationSound();
              nativeSoundSelect.innerHTML = "";
              for (var si = 0; si < sounds.length; si++) {
                var opt = document.createElement("option");
                opt.value = sounds[si].id;
                opt.textContent = sounds[si].name;
                if (sounds[si].id === current) opt.selected = true;
                nativeSoundSelect.appendChild(opt);
              }
              nativeSoundSelect.addEventListener("change", function() {
                try { WandNative.setNotificationSound(nativeSoundSelect.value); } catch (_e) {}
              });
              if (nativeSoundPreview) {
                nativeSoundPreview.addEventListener("click", function() {
                  try { WandNative.previewSound(nativeSoundSelect.value); } catch (_e) {}
                });
              }
            } catch (_e) {}
          }
        }
        // Native haptic toggle (APK only)
        if (_hasNativeBridge && typeof WandNative.isHapticEnabled === "function") {
          var hapticSection = document.getElementById("native-haptic-section");
          var hapticToggle = document.getElementById("cfg-haptic-enabled");
          if (hapticSection && hapticToggle) {
            hapticSection.classList.remove("hidden");
            try { hapticToggle.checked = WandNative.isHapticEnabled(); } catch (_e) {}
            hapticToggle.addEventListener("change", function() {
              try { WandNative.setHapticEnabled(hapticToggle.checked); } catch (_e) {}
              if (hapticToggle.checked) _vibrate("medium");
            });
          }
        }
        var newSessBtn = document.getElementById("topbar-new-session-button");
        if (newSessBtn) newSessBtn.addEventListener("click", openSessionModal);
        var drawerNewSessBtn = document.getElementById("drawer-new-session-button");
        if (drawerNewSessBtn) drawerNewSessBtn.addEventListener("click", openSessionModal);
        var closeModalBtn = document.getElementById("close-modal-button");
        if (closeModalBtn) closeModalBtn.addEventListener("click", closeSessionModal);
        var closeWorktreeMergeBtn = document.getElementById("close-worktree-merge-button");
        if (closeWorktreeMergeBtn) closeWorktreeMergeBtn.addEventListener("click", closeWorktreeMergeModal);
        var worktreeMergeCancelBtn = document.getElementById("worktree-merge-cancel-button");
        if (worktreeMergeCancelBtn) worktreeMergeCancelBtn.addEventListener("click", closeWorktreeMergeModal);
        var worktreeMergeConfirmBtn = document.getElementById("worktree-merge-confirm-button");
        if (worktreeMergeConfirmBtn) worktreeMergeConfirmBtn.addEventListener("click", confirmWorktreeMerge);
        var runBtn = document.getElementById("run-button");
        if (runBtn) runBtn.addEventListener("click", runCommand);
        var approvePermissionBtn = document.getElementById("approve-permission-btn");
        if (approvePermissionBtn) approvePermissionBtn.addEventListener("click", approvePermission);
        var denyPermissionBtn = document.getElementById("deny-permission-btn");
        if (denyPermissionBtn) denyPermissionBtn.addEventListener("click", denyPermission);
        var autoApproveToggle = document.getElementById("auto-approve-toggle");
        if (autoApproveToggle) autoApproveToggle.addEventListener("click", toggleAutoApprove);
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
        var modelSelect = document.getElementById("chat-model-select");
        if (modelSelect) modelSelect.addEventListener("change", function() {
          onChatModelChange(this.value);
        });

        var sessionModal = document.getElementById("session-modal");
        if (sessionModal) sessionModal.addEventListener("click", function(e) {
          if (e.target.id === "session-modal") closeSessionModal();
          if (e.target.id === "worktree-merge-modal") closeWorktreeMergeModal();
        });

        var inputBox = document.getElementById("input-box");
        if (inputBox) {
          bindInputTouchScroll(inputBox);
          inputBox.addEventListener("keydown", handleInputBoxKeydown);
          inputBox.addEventListener("paste", handleInputPaste);
          inputBox.addEventListener("input", function() {
            if (handleInteractiveTextInput(inputBox)) {
              return;
            }
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

        // Attach button & drag-drop
        var attachBtn = document.getElementById("attach-btn");
        var fileInput = document.getElementById("file-upload-input");
        if (attachBtn && fileInput) {
          attachBtn.addEventListener("click", function() { fileInput.click(); });
          fileInput.addEventListener("change", function() {
            var files = fileInput.files;
            if (files) {
              for (var i = 0; i < files.length; i++) addPendingAttachment(files[i]);
            }
            fileInput.value = "";
          });
        }

        var promptOptimizeBtn = document.getElementById("prompt-optimize-btn");
        if (promptOptimizeBtn) {
          promptOptimizeBtn.addEventListener("click", function() { optimizePromptText(); });
        }
        var composer = document.querySelector(".input-composer");
        if (composer) {
          composer.addEventListener("dragover", function(e) {
            e.preventDefault();
            e.stopPropagation();
            composer.classList.add("drag-over");
          });
          composer.addEventListener("dragleave", function(e) {
            e.preventDefault();
            e.stopPropagation();
            composer.classList.remove("drag-over");
          });
          composer.addEventListener("drop", function(e) {
            e.preventDefault();
            e.stopPropagation();
            composer.classList.remove("drag-over");
            var files = e.dataTransfer && e.dataTransfer.files;
            if (files) {
              for (var i = 0; i < files.length; i++) addPendingAttachment(files[i]);
            }
          });
        }

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

        // Topbar: file button (mirrors toggleFilePanel)
        var topbarFileBtn = document.getElementById("topbar-file-button");
        if (topbarFileBtn) topbarFileBtn.addEventListener("click", toggleFilePanel);

        // Topbar: cwd click → open file panel
        var topbarCwdEl = document.getElementById("topbar-cwd");
        if (topbarCwdEl) {
          topbarCwdEl.addEventListener("click", function() {
            if (!state.filePanelOpen) toggleFilePanel();
          });
          topbarCwdEl.addEventListener("keydown", function(e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (!state.filePanelOpen) toggleFilePanel();
            }
          });
        }

        // Topbar: more menu
        var topbarMoreBtn = document.getElementById("topbar-more-button");
        var topbarMoreMenu = document.getElementById("topbar-more-menu");
        if (topbarMoreBtn && topbarMoreMenu) {
          topbarMoreBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            state.topbarMoreOpen = !state.topbarMoreOpen;
            topbarMoreMenu.classList.toggle("hidden", !state.topbarMoreOpen);
            topbarMoreBtn.classList.toggle("active", state.topbarMoreOpen);
            topbarMoreBtn.setAttribute("aria-expanded", state.topbarMoreOpen ? "true" : "false");
          });
          topbarMoreMenu.addEventListener("click", function(e) {
            var btn = e.target && e.target.closest ? e.target.closest(".topbar-more-item") : null;
            if (!btn) return;
            var action = btn.getAttribute("data-action");
            // Close menu first regardless of action
            state.topbarMoreOpen = false;
            topbarMoreMenu.classList.add("hidden");
            topbarMoreBtn.classList.remove("active");
            topbarMoreBtn.setAttribute("aria-expanded", "false");
            switch (action) {
              case "settings":
                openSettingsModal();
                break;
              case "refresh":
                window.location.reload();
                break;
              case "install":
                if (state.deferredPrompt) {
                  state.deferredPrompt.prompt();
                  state.deferredPrompt.userChoice.then(function() {
                    state.deferredPrompt = null;
                    state.showInstallPrompt = false;
                    updateInstallPrompt();
                  });
                }
                break;
              case "logout":
                logout();
                break;
              case "switch-server":
                switchServer();
                break;
            }
          });
          // Close on outside click
          document.addEventListener("click", function(e) {
            if (!state.topbarMoreOpen) return;
            var wrap = topbarMoreMenu.parentElement;
            if (wrap && !wrap.contains(e.target)) {
              state.topbarMoreOpen = false;
              topbarMoreMenu.classList.add("hidden");
              topbarMoreBtn.classList.remove("active");
              topbarMoreBtn.setAttribute("aria-expanded", "false");
            }
          });
          // Close on ESC
          document.addEventListener("keydown", function(e) {
            if (e.key === "Escape" && state.topbarMoreOpen) {
              state.topbarMoreOpen = false;
              topbarMoreMenu.classList.add("hidden");
              topbarMoreBtn.classList.remove("active");
              topbarMoreBtn.setAttribute("aria-expanded", "false");
            }
          });
        }

        // Terminal scale controls (topbar)
        var scaleDownBtn = document.getElementById("terminal-scale-down-top");
        var scaleUpBtn = document.getElementById("terminal-scale-up-top");
        if (scaleDownBtn) scaleDownBtn.addEventListener("click", function() { adjustTerminalScale(-0.25); });
        if (scaleUpBtn) scaleUpBtn.addEventListener("click", function() { adjustTerminalScale(0.25); });
        var pageRefreshBtn = document.getElementById("page-refresh-btn");
        if (pageRefreshBtn) pageRefreshBtn.addEventListener("click", function(ev) {
          // Soft refresh: replay terminal buffer + rebuild chat view.
          // Fixes residual DOM from CSI cursor-jump sequences without losing page state.
          // Hold Shift to force a full page reload as an escape hatch.
          if (ev && ev.shiftKey) {
            location.reload();
            return;
          }
          softResyncTerminal();
          resetChatRenderCache();
          scheduleChatRender(true);
        });
        var jumpBottomBtn = document.getElementById("terminal-jump-bottom");
        if (jumpBottomBtn) jumpBottomBtn.addEventListener("click", function() {
          maybeScrollTerminalToBottom("force");
        });
        var chatFollowToggle = document.getElementById("chat-follow-toggle");
        if (chatFollowToggle) chatFollowToggle.addEventListener("click", function() {
          if (state.chatAutoFollow) {
            setChatAutoFollow(false, { scrollNow: false });
          } else {
            setChatAutoFollow(true, { scrollNow: true, smooth: false });
          }
        });
        var chatJumpBottomBtn = document.getElementById("chat-jump-bottom");
        if (chatJumpBottomBtn) chatJumpBottomBtn.addEventListener("click", function() {
          setChatAutoFollow(true, { scrollNow: true, smooth: true });
        });
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

        // Helper functions for recent paths (single source: backend API)
        // NOTE: fetchRecentPaths and addRecentPath are defined at outer scope

        function renderRecentPathsHtml(items) {
          if (!items.length) return "";
          var html = '<div class="folder-recent-section">' +
            '<div class="folder-recent-title">最近使用</div>';
          items.forEach(function(item) {
            var p = item.path || item;
            html += '<div class="folder-recent-item" data-path="' + escapeHtml(p) + '">' +
              '<span class="folder-recent-item-path">' + escapeHtml(p) + '</span>' +
            '</div>';
          });
          html += '</div>';
          return html;
        }

        function showRecentPathsDropdown() {
          if (!folderPickerDropdown) return;
          fetchRecentPaths(function(items) {
            var recentHtml = renderRecentPathsHtml(items);
            if (recentHtml) {
              folderPickerDropdown.innerHTML = recentHtml;
              folderPickerDropdown.classList.remove("hidden");
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
          });
        }

        // Working directory indicator click handler for active sessions
        var workingDirIndicator = document.getElementById("working-dir-indicator");
        if (workingDirIndicator) {
          workingDirIndicator.addEventListener("click", function() {
            // 点击指示器时，取消当前会话选择，显示完整的目录选择器
            state.selectedId = null;
            persistSelectedId();
            state.drafts = {};
            render();
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

        var topbarGitBadge = document.getElementById("topbar-git-badge");
        if (topbarGitBadge) {
          topbarGitBadge.addEventListener("click", function(e) {
            e.preventDefault();
            openQuickCommitModal();
          });
        }
        var quickCommitModal = document.getElementById("quick-commit-modal");
        if (quickCommitModal) {
          quickCommitModal.addEventListener("click", function(e) {
            if (e.target.id === "quick-commit-modal" && !state.quickCommitSubmitting) {
              closeQuickCommitModal();
            }
          });
        }
        attachQuickCommitModalListeners();

        initTerminal();
        setupMobileKeyboardHandlers();
        setupVisualViewportHandlers();
      }

      function saveWorkingDir(path) {
        state.workingDir = path;
        try {
          localStorage.setItem("wand-working-dir", path);
        } catch (e) {
          // Ignore localStorage errors
        }
        addRecentPath(path);
      }

      function fetchRecentPaths(callback) {
        fetch("/api/recent-paths", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(items) { callback(items || []); })
          .catch(function() { callback([]); });
      }

      function addRecentPath(path) {
        return fetch("/api/recent-paths", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ path: path })
        }).catch(function() {});
      }

      function activateSessionItem(sessionId) {
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
        if (session && session.status !== "running" && !isStructuredSession(session)) {
          resumeSessionFromList(sessionId);
        } else {
          selectSession(sessionId);
        }
        if (!state.sidebarPinned || isMobileLayout()) {
          closeSessionsDrawer();
        }
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
          } else if (actionButton.dataset.action === "toggle-archived-group") {
            state.archivedExpanded = !state.archivedExpanded;
            updateSessionsList();
          } else if (actionButton.dataset.action === "resume" && actionButton.dataset.sessionId) {
            handleResumeAction(actionButton);
          } else if (actionButton.dataset.action === "resume-history" && actionButton.dataset.claudeSessionId) {
            handleResumeHistoryAction(actionButton);
          } else if (actionButton.dataset.action === "worktree-merge" && actionButton.dataset.sessionId) {
            openWorktreeMergeModal(actionButton.dataset.sessionId);
          } else if (actionButton.dataset.action === "worktree-cleanup" && actionButton.dataset.sessionId) {
            retryWorktreeCleanup(actionButton.dataset.sessionId);
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
        var original = badge.textContent;
        copyToClipboard(fullId, null, function() {
          badge.textContent = "\u2713 已复制";
          badge.classList.add("copied");
          setTimeout(function() {
            badge.textContent = original;
            badge.classList.remove("copied");
          }, 1200);
        });
      }

      function getTerminalViewport() {
        if (!state.terminal || !state.terminal.element) return null;
        state.terminalViewportEl = state.terminal.element;
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
        var termContainer = document.getElementById("output");
        if (termContainer) termContainer.classList.toggle("has-jump-btn", shouldShow);
      }

      function isTerminalNearBottom() {
        var viewport = getTerminalViewport();
        if (!viewport) return true;
        var distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        return distance <= state.terminalScrollThreshold;
      }

      // 严格"真正到底"判定（仅亚像素 jitter 容忍）：用于把 autoFollow 从 false
      // 翻回 true。不能用 isTerminalNearBottom 的 12px 阈值，否则用户在底部小幅
      // 向上滚时，wheel handler 把 autoFollow 设 false 后紧接着触发的 scroll
      // 事件会因为"还没滚出阈值"而把 autoFollow 反转回 true，丢失用户意图。
      function isTerminalAtBottom() {
        var viewport = getTerminalViewport();
        if (!viewport) return true;
        var distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        return distance <= 2;
      }

      function scrollTerminalToBottom(smooth) {
        if (!state.terminal) return;
        var viewport = getTerminalViewport();
        if (!viewport) return;
        if (smooth) {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
        } else {
          viewport.scrollTop = viewport.scrollHeight;
        }
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
        clearTerminalScrollIdleTimer();
        updateTerminalJumpToBottomButton();
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
        // 只看 autoFollow 标志：用户主动 wheel/touch 后该标志被设为 false，
        // 即使当前位置仍在底部 12px 阈值内也不再强行滚回，避免把用户刚滚上去
        // 的几像素吞掉。autoFollow 由 scroll handler 在"真正到底"时恢复。
        if (!state.terminalAutoFollow) {
          updateTerminalJumpToBottomButton();
          return;
        }
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

      // ──────── East-Asian-Wide padding for wterm WASM ────────
      //
      // wterm's WASM grid (as of @wterm/core 0.1.8/0.1.9) treats every
      // codepoint as occupying exactly 1 cell, while node-pty's backend
      // and Claude Code's TUI emit cursor-positioning sequences that
      // assume CJK / fullwidth / emoji codepoints occupy 2 columns
      // (Unicode TR11 East-Asian-Width = W or F). The mismatch makes
      // every CSI cursor move after CJK output drift by N/2 columns,
      // causing in-place rewrites (thinking spinner, todo list,
      // permission menus) to leave torn residue like "替替换换".
      //
      // Fix: insert U+2060 (Word Joiner — zero-width, unbreakable) after
      // each wide codepoint before handing the byte stream to the WASM
      // grid. The WJ takes one cell, so wide chars now occupy 2 cells —
      // matching the backend's column accounting exactly. The browser
      // renders WJ at zero width, so the visual layout stays correct.
      //
      // The scanner is ANSI-aware: it tracks ESC / CSI / OSC / DCS
      // / PM / APC state across chunk boundaries so wide codepoints
      // inside escape sequences (e.g. OSC window-title payloads) are
      // not padded — that would break sequence parsing.
      function isEastAsianWide(cp) {
        if (cp < 0x1100) return false;
        return (
          (cp >= 0x1100 && cp <= 0x115f) ||
          (cp >= 0x2329 && cp <= 0x232a) ||
          (cp >= 0x2e80 && cp <= 0x303e) ||
          (cp >= 0x3041 && cp <= 0x33ff) ||
          (cp >= 0x3400 && cp <= 0x4dbf) ||
          (cp >= 0x4e00 && cp <= 0x9fff) ||
          (cp >= 0xa000 && cp <= 0xa4cf) ||
          (cp >= 0xac00 && cp <= 0xd7a3) ||
          (cp >= 0xf900 && cp <= 0xfaff) ||
          (cp >= 0xfe30 && cp <= 0xfe4f) ||
          (cp >= 0xff00 && cp <= 0xff60) ||
          (cp >= 0xffe0 && cp <= 0xffe6) ||
          (cp >= 0x1f000 && cp <= 0x1f9ff) ||
          (cp >= 0x20000 && cp <= 0x2fffd) ||
          (cp >= 0x30000 && cp <= 0x3fffd)
        );
      }

      var WAND_WIDE_FILLER = "\u2060";

      function createWideParserState() { return { mode: "normal" }; }

      function widePadAnsi(data, st) {
        if (!data) return "";
        var s = String(data);
        var out = "";
        for (var i = 0; i < s.length; i++) {
          var code = s.charCodeAt(i);
          var cp = code;
          var consumed = 1;
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
            var lo = s.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              cp = (code - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
              consumed = 2;
            }
          }
          var ch = consumed === 2 ? s.substr(i, 2) : s.charAt(i);
          switch (st.mode) {
            case "normal":
              if (cp === 0x1b) { st.mode = "esc"; out += ch; }
              else if (cp === 0x9b) { st.mode = "csi"; out += ch; }
              else if (cp === 0x9d || cp === 0x90 || cp === 0x9e || cp === 0x9f) {
                st.mode = "string"; out += ch;
              } else {
                out += ch;
                if (isEastAsianWide(cp)) out += WAND_WIDE_FILLER;
              }
              break;
            case "esc":
              out += ch;
              if (cp === 0x5b) st.mode = "csi";
              else if (cp === 0x5d || cp === 0x50 || cp === 0x58 ||
                       cp === 0x5e || cp === 0x5f) st.mode = "string";
              else st.mode = "normal";
              break;
            case "csi":
              out += ch;
              if (cp >= 0x40 && cp <= 0x7e) st.mode = "normal";
              break;
            case "string":
              out += ch;
              if (cp === 0x07 || cp === 0x9c) st.mode = "normal";
              else if (cp === 0x1b) st.mode = "string-esc";
              break;
            case "string-esc":
              out += ch;
              if (cp === 0x5c) st.mode = "normal";
              else st.mode = "string";
              break;
          }
          i += consumed - 1;
        }
        return out;
      }

      function wandTerminalWrite(terminal, data) {
        if (!terminal || data == null) return;
        if (!state.wideParserState) state.wideParserState = createWideParserState();
        terminal.write(widePadAnsi(data, state.wideParserState));
        // wterm.write 内部用 5px 阈值判定"在底部"，下一帧 _doRender 据此强制
        // scrollTop = scrollHeight。这与 wand 的 autoFollow（"真正到底"才为
        // true，2px 阈值）独立，会把用户主动向上滚的几像素吞掉。覆写为 wand
        // 的 autoFollow 状态，让 autoFollow 成为唯一真相。
        if ("_shouldScrollToBottom" in terminal) {
          terminal._shouldScrollToBottom = state.terminalAutoFollow !== false;
        }
      }

      function resetWideParserState() {
        state.wideParserState = createWideParserState();
      }

      // Strip the wide-pad filler from copied text so users pasting
      // selected terminal output don't get hidden U+2060 sprinkled
      // through every CJK string.
      function stripWideFillerForCopy() {
        if (typeof document === "undefined") return;
        document.addEventListener("copy", function(e) {
          var sel = window.getSelection && window.getSelection();
          if (!sel || sel.isCollapsed) return;
          var anchor = sel.anchorNode;
          var node = anchor && anchor.nodeType === 3 ? anchor.parentNode : anchor;
          var output = document.getElementById("output");
          if (!output || !node || !output.contains(node)) return;
          var text = sel.toString();
          if (text.indexOf(WAND_WIDE_FILLER) === -1) return;
          if (e.clipboardData) {
            e.clipboardData.setData("text/plain", text.split(WAND_WIDE_FILLER).join(""));
            e.preventDefault();
          }
        });
      }
      stripWideFillerForCopy();

      // PTY 链路节流不变式：
      //   服务端 OUTPUT_DEBOUNCE_MS  <  CHAT_RENDER_IDLE_MS  ≤  CHAT_RENDER_LIVE_MS
      //   RESYNC_TAIL_MS            ≤  RESYNC_THROTTLE_MS
      // 违反这两条会出现"上游推得比下游消化得快但下游 timer 还没到期"的堵塞。
      var CHAT_RENDER_LIVE_MS = 150;
      var CHAT_RENDER_IDLE_MS = 30;

      // state.terminalOutput 仅作 softResyncTerminal 的重放源（wterm 有自己的
      // scrollback），所以必须限长，否则长跑会话每次 resync 都喂几 MB 给 wterm。
      // 裁切优先在行边界（ANSI 状态机此时一定 idle，重放等价），找不到再按字节切
      // 并避开 UTF-16 半截 / ANSI 半截。
      var CLIENT_OUTPUT_MAX = 256 * 1024;
      var CLIENT_OUTPUT_TRIM_AT = 320 * 1024;
      function clampClientTerminalOutput(buf) {
        if (!buf || buf.length <= CLIENT_OUTPUT_TRIM_AT) return buf;
        var start = buf.length - CLIENT_OUTPUT_MAX;
        // UTF-16 low surrogate
        if (start > 0 && start < buf.length) {
          var c0 = buf.charCodeAt(start);
          if (c0 >= 0xdc00 && c0 <= 0xdfff) start++;
        }
        // 优先在 lookahead 内找下一个换行符切割
        var LOOKAHEAD = 4096;
        var upper = Math.min(start + LOOKAHEAD, buf.length);
        for (var i = start; i < upper; i++) {
          if (buf.charCodeAt(i) === 0x0a) return buf.slice(i + 1);
        }
        // 没换行 → 检查 start 是否落在未结束的 ESC 序列里
        var lookback = Math.max(0, start - 256);
        var escAt = -1;
        for (var j = start - 1; j >= lookback; j--) {
          var c = buf.charCodeAt(j);
          if (c === 0x1b) { escAt = j; break; }
          if (c === 0x07) break;
          if (c >= 0x40 && c <= 0x7e) break;
        }
        if (escAt !== -1) {
          var terminated = false;
          for (var k = escAt + 1; k < start; k++) {
            var ck = buf.charCodeAt(k);
            if (ck === 0x07) { terminated = true; break; }
            if (ck >= 0x40 && ck <= 0x7e) { terminated = true; break; }
          }
          if (!terminated) {
            var ahead = Math.min(start + 256, buf.length);
            for (var m = start; m < ahead; m++) {
              var cm = buf.charCodeAt(m);
              if (cm === 0x07 || (cm >= 0x40 && cm <= 0x7e)) {
                return buf.slice(m + 1);
              }
            }
          }
        }
        return buf.slice(start);
      }

      function resetTerminal() {
        if (!state.terminal) return;
        // 优先走 wterm-entry.js 自定义 WTerm 子类暴露的 reset()：它会调用
        // bridge.init(cols, rows) 让 WASM 重新初始化整个状态机——包含
        // grid、光标、属性 *和* scrollback。这是跨会话切换时清空旧
        // scrollback 的唯一可靠方式，避免新会话向上滚还能看到旧会话内容。
        // 单纯写 ANSI RIS (\x1bc) 在 WASM 实现里只清当前 grid，不动 scrollback。
        if (typeof state.terminal.reset === "function") {
          state.terminal.reset();
          resetWideParserState();
          return;
        }
        if (typeof state.terminal.write === "function") {
          state.terminal.write("\x1bc");
        }
        resetWideParserState();
      }

      // Reset wterm WASM grid and replay the full output buffer to clear stale
      // DOM rows left by CSI cursor-jump sequences (Claude permission menus etc.).
      // Replays the *whole* buffer because alt-screen / scroll-region / charset
      // mode switches must be consumed from the start; cutting the middle drops
      // those state-machine instructions and corrupts the grid.
      // Pass { skipFit: true } when the caller already sized the grid (e.g.
      // wterm.onResize fired this resync) — otherwise ensureTerminalFit recurses.
      var _resyncStatsWindowStart = 0;
      var _resyncStatsCount = 0;
      var _resyncLastWarnAt = 0;
      var RESYNC_BUDGET_WINDOW_MS = 5000;
      var RESYNC_BUDGET_MAX = 12;
      var RESYNC_WARN_COOLDOWN_MS = 30000;
      function softResyncTerminal(options) {
        if (!state.terminal || !state.terminalOutput) return false;
        var opts = options || {};
        var bufLen = state.terminalOutput.length;
        var startedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        resetTerminal();
        wandTerminalWrite(state.terminal, state.terminalOutput);
        state.lastTerminalResyncAt = Date.now();
        maybeScrollTerminalToBottom("output");
        if (!opts.skipFit) ensureTerminalFit("refresh");
        // 统计 5s 窗口内的 resync 次数，过密时打 warn 帮助诊断
        // ——比如 wterm 状态机被反复弄脏、上游持续推原地重绘的菜单。
        // 单次 warn 后冷却 30s，避免刷屏。
        var now = Date.now();
        if (now - _resyncStatsWindowStart > RESYNC_BUDGET_WINDOW_MS) {
          _resyncStatsWindowStart = now;
          _resyncStatsCount = 1;
        } else {
          _resyncStatsCount++;
          if (_resyncStatsCount > RESYNC_BUDGET_MAX && now - _resyncLastWarnAt > RESYNC_WARN_COOLDOWN_MS) {
            _resyncLastWarnAt = now;
            var endedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
            console.warn("[wand] softResyncTerminal high frequency",
              "count=" + _resyncStatsCount + "/" + Math.round((now - _resyncStatsWindowStart) / 100) / 10 + "s",
              "bufLen=" + bufLen,
              "lastReplayMs=" + Math.round(endedAt - startedAt));
          }
        }
        return true;
      }

      function scheduleSoftResyncTerminal(delayMs) {
        if (state.softResyncTimer) clearTimeout(state.softResyncTimer);
        state.softResyncTimer = setTimeout(function() {
          state.softResyncTimer = null;
          softResyncTerminal();
        }, typeof delayMs === "number" ? delayMs : 150);
      }

      // Claude CLI 的 permission 菜单 / 选择列表在方向键下会发原地重绘序列
      // (CSI A-D / J / K / H / f)。wterm 在这种高频原地重绘下 DOM 行容易残留
      // 或错位，必须用 softResyncTerminal 兜底。
      //
      // 触发用 leading + tail 节流而非 debounce：用户持续按键时每次 chunk 都会
      // reset debounce timer，永远等不到静默期。leading 立即 resync、窗口内
      // 用尾巴 timer 收尾，不依赖按键停顿。
      var IN_PLACE_REDRAW_RE = /\x1b\[\d*(?:;\d*)?[ABCDfHJK]/;
      var RESYNC_THROTTLE_MS = 400;
      var RESYNC_TAIL_MS = 350;
      var _resyncChunkLastAt = 0;
      var _resyncChunkTailTimer = null;
      function maybeScheduleResyncForChunk(chunk) {
        if (!chunk || typeof chunk !== "string") return;
        if (chunk.indexOf("\x1b[") === -1) return;
        if (!IN_PLACE_REDRAW_RE.test(chunk)) return;
        var now = Date.now();
        var sinceLast = now - _resyncChunkLastAt;
        if (sinceLast >= RESYNC_THROTTLE_MS) {
          if (_resyncChunkTailTimer) {
            clearTimeout(_resyncChunkTailTimer);
            _resyncChunkTailTimer = null;
          }
          _resyncChunkLastAt = now;
          softResyncTerminal();
          return;
        }
        if (_resyncChunkTailTimer) return;
        var wait = Math.max(RESYNC_TAIL_MS, RESYNC_THROTTLE_MS - sinceLast);
        _resyncChunkTailTimer = setTimeout(function() {
          _resyncChunkTailTimer = null;
          _resyncChunkLastAt = Date.now();
          softResyncTerminal();
        }, wait);
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
        var liveChunkStream = !!(nextSessionId && state.terminalLiveStreamSessions[nextSessionId]);
        var wrote = false;

        if (normalizedOutput === currentOutput && !sessionChanged) {
          if (shouldScroll) maybeScrollTerminalToBottom("output");
          updateTerminalJumpToBottomButton();
          return false;
        }

        if (sessionChanged) {
          resetTerminal();
          currentOutput = "";
          state.terminalOutput = "";
          state.terminalAutoFollow = true;
          clearTerminalScrollIdleTimer();
          updateTerminalJumpToBottomButton();
        }

        if (mode === "replace") {
          if (normalizedOutput !== currentOutput) {
            resetTerminal();
            if (normalizedOutput) {
              wandTerminalWrite(state.terminal, normalizedOutput);
            }
            wrote = true;
          }
        } else if (normalizedOutput.length < currentOutput.length && !sessionChanged) {
          return false;
        } else if (liveChunkStream && !sessionChanged && mode !== "replace" && currentOutput && !normalizedOutput.startsWith(currentOutput)) {
          return false;
        } else if (normalizedOutput.startsWith(currentOutput)) {
          var delta = normalizedOutput.slice(currentOutput.length);
          if (delta) {
            wandTerminalWrite(state.terminal, delta);
            maybeScheduleResyncForChunk(delta);
            wrote = true;
          }
        } else if (currentOutput && currentOutput.startsWith(normalizedOutput)) {
          return false;
        } else {
          resetTerminal();
          if (normalizedOutput) {
            wandTerminalWrite(state.terminal, normalizedOutput);
          }
          wrote = true;
        }

        state.terminalSessionId = nextSessionId;
        state.terminalOutput = normalizedOutput;
        if (shouldScroll && (wrote || sessionChanged || mode === "replace")) {
          maybeScrollTerminalToBottom(sessionChanged || mode === "replace" ? "force" : "output");
        } else {
          updateTerminalJumpToBottomButton();
        }
        if (sessionChanged) {
          sendTerminalResize(state.terminal.cols, state.terminal.rows);
        }
        return wrote || sessionChanged;
      }

      function initTerminal() {
        var container = document.getElementById("output");
        if (!container || state.terminal || state.terminalInitializing) return;
        if (typeof WTermLib === "undefined" || !WTermLib.WTerm) {
          if (!state.terminalInitRetries) state.terminalInitRetries = 0;
          if (state.terminalInitRetries < 10) {
            state.terminalInitRetries++;
            setTimeout(initTerminal, 200);
          }
          return;
        }
        state.terminalInitRetries = 0;
        state.terminalInitializing = true;

        // wterm 构造与 init() 内部都通过 getBoundingClientRect 测字符宽高，
        // 要求容器及祖先链都不是 display:none。.terminal-container 默认
        // display:none，必须 .active 才变 flex。switchToSessionView 里
        // initTerminal() 在 applyCurrentView() 之前同步执行——那时容器还是
        // display:none，_measureCharSize 返回 null → ResizeObserver 不挂
        // 载、首屏 cols 永远停在硬编码的 120，必须用户刷新/弹键盘/调窗口
        // 才能恢复。这里在创建 wterm 之前先把 active 类挂上，让容器进入
        // flex 布局，确保 _measureCharSize 拿到真实字符尺寸。
        if (state.selectedId) {
          container.classList.remove("hidden");
          container.classList.add("active");
        }

        // 防御式清理：teardownTerminal 已经会移除残留 termWrap，但若有
        // 调用路径绕过 teardown（比如 outputContainer 被外部 render 重建），
        // 这里再扫一次确保新会话不会和旧 termWrap 叠在同一位置。
        var staleWraps = container.querySelectorAll(".terminal-scroll-wrap");
        for (var i = 0; i < staleWraps.length; i++) {
          var stale = staleWraps[i];
          if (stale.parentNode === container) container.removeChild(stale);
        }

        var termWrap = document.createElement("div");
        termWrap.className = "terminal-scroll-wrap";
        container.appendChild(termWrap);

        // cols/rows 给一个保守默认即可：wterm-entry.js 重写的 init()
        // 会在 super.init() 之前按 termWrap 真实尺寸做一次预校准，
        // 保证 super.init() 里 bridge.init / renderer.setup 一上来
        // 就按真实 cols 初始化，从源头消除"先按 120 写一遍 → 异步
        // remeasure 纠正"的时序窗口。
        var term = new WTermLib.WTerm(termWrap, {
          cols: 120,
          rows: 36,
          autoResize: true,
          cursorBlink: false,
          onData: function(data) {
            if (state.terminalInteractive) return;
            queueDirectInput(data);
          },
          onResize: function(cols, rows) {
            sendTerminalResize(cols, rows);
            // wterm.resize() just ran renderer.setup() (DOM rows wiped) and
            // bridge.resize() (WASM grid reflowed). terminalOutput is the
            // canonical raw byte stream — replay it now so historical lines
            // and any in-flight CSI sequences re-render at the new width.
            // skipFit: wterm already did the sizing work; calling
            // ensureTerminalFit again here would just cycle back through
            // remeasure → resize → onResize → softResyncTerminal.
            if (state.terminal && state.terminalOutput) {
              softResyncTerminal({ skipFit: true });
            }
          }
        });

        // Wait for the monospace webfont (if any) before init so the very first
        // _measureCharSize() inside wterm uses the final glyph metrics. Otherwise
        // the fallback font's narrower glyphs make wterm calculate too many cols,
        // and subsequent chunks render with broken wrapping until the user
        // triggers a resize. Cap the wait so a missing font never blocks startup.
        var fontsReady = (document.fonts && typeof document.fonts.ready === "object")
          ? Promise.race([document.fonts.ready, new Promise(function(r) { setTimeout(r, 800); })])
          : Promise.resolve();

        fontsReady.then(function() { return term.init(); }).then(function() {
          state.terminal = term;
          state.terminalInitializing = false;
          applyTerminalScale();

          // wterm 构造时 cols/rows 是硬编码的 120/36，super.init() 内部
          // 的 ResizeObserver 要等下一个 layout 阶段异步 fire 才纠正。
          // 如果不在写入历史前就把 bridge reflow 到容器真实尺寸，
          // syncTerminalBuffer 会按 120 cols 把整段历史写进 WASM grid，
          // 用户首屏看到的就是错列宽折行——必须等 ResizeObserver 触发
          // softResync 才恢复，中间会有几帧明显错位（"刚开终端布局错乱
          // 一下、resize 一下才正常"）。这里先强制一次 layout flush，
          // 再同步 remeasure 把 bridge 校准到真实 cols/rows，把"写入"
          // 卡在正确尺寸之后，避免错位帧。
          if (termWrap.isConnected) {
            void termWrap.offsetHeight;
            if (typeof term.remeasure === "function") {
              try { term.remeasure(); } catch (e) { /* ignore: 非致命 */ }
            }
          }

          state.terminalAutoFollow = true;
          clearTerminalScrollIdleTimer();

          var viewport = getTerminalViewport();
          if (viewport) {
            state.terminalViewportScrollHandler = function() {
              // 严格"真正到底"才恢复 autoFollow：避免 wheel 设 false 后被
              // 紧接着的 scroll 事件因"接近底部 12px"而反转回 true。
              if (isTerminalAtBottom()) {
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

          state.terminalWheelHandler = function(e) {
            if (!isTerminalNearBottom() || e.deltaY < 0) {
              setTerminalManualScrollActive();
            }
            e.stopPropagation();
          };
          container.addEventListener("wheel", state.terminalWheelHandler, { passive: true });

          initTerminalScrollbar(container);

          if (state.selectedId) {
            var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
            if (session) {
              syncTerminalBuffer(session.id, session.output || "", { mode: "append", scroll: false });
            }
          } else {
            wandTerminalWrite(term, "点击上方「新对话」开始你的第一次对话。\r\n");
          }

          state.terminalClickHandler = focusInputBox;
          container.addEventListener("click", state.terminalClickHandler);
          updateTerminalJumpToBottomButton();
          initTerminalResizeHandle();
          observeTerminalResize();
          startTerminalHealthCheck();
          // Container may have been hidden / zero-width at construction
          // time (hard-coded 120x36). Remeasure against the real container
          // so wterm reflows the just-written history to the correct cols.
          ensureTerminalFit("mount", { forceReplay: true });
        }).catch(function(err) {
          state.terminalInitializing = false;
          console.error("[wand] wterm init failed:", err);
        });
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

      function hasNativeSwitchServer() {
        return typeof WandNative !== "undefined" && typeof WandNative.switchServer === "function";
      }

      function switchServer() {
        if (!hasNativeSwitchServer()) return;
        try { WandNative.switchServer(); } catch (e) {}
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
        return state.sessionTool || state.preferredCommand || "claude";
      }

      function getComposerTool() {
        var selected = state.sessions.find(function(s) { return s.id === state.selectedId; });
        return (selected && selected.provider) || state.preferredCommand || "claude";
      }

      function getComposerPlaceholder(session, terminalInteractive) {
        if (terminalInteractive) {
          return "终端交互模式开启中，请直接在终端中输入";
        }
        if (session && isStructuredSession(session)) {
          return session.provider === "codex"
            ? "向 Codex 发送消息；chat 为结构化对话视图"
            : "向 Claude 发送消息；chat 为结构化对话视图";
        }
        if (session && session.provider === "codex") {
          if (session.status !== "running") {
            return "Codex 会话已结束，无法继续发送";
          }
          return state.currentView === "terminal"
            ? "向 Codex 发送输入；terminal 为原始 TUI 输出"
            : "向 Codex 发送输入；chat 为解析后的阅读视图";
        }
        if (session && !isStructuredSession(session) && session.status !== "running") {
          if (canAutoResumeSession(session)) {
            return "输入消息...";
          }
          return "会话已结束，无法继续发送";
        }
        return session && isStructuredSession(session) && session.structuredState && session.structuredState.inFlight
          ? "思考中 · 发送新消息将中断当前回复"
          : "输入消息...";
      }

      function getToolModeHint(tool, mode) {
        if (tool === "codex") {
          return "Codex 支持 PTY 终端与结构化（JSONL）两种会话，结构化模式按 full-access 启动。";
        }
        if (mode === "full-access") {
          return "自动确认权限请求与高权限操作，适合你确认环境安全后的连续修改。";
        }
        if (mode === "auto-edit") {
          return "保留交互式会话，同时更偏向直接编辑代码。";
        }
        if (mode === "native") {
          return "调用 Claude 原生 API 输出，适合快速问答或一次性生成。";
        }
        if (mode === "managed") {
          return "AI 自动完成所有工作，无需中途确认，适合有明确目标的任务。";
        }
        return "保留标准交互流程，适合手动确认每一步。";
      }

      function getSupportedModes(tool) {
        if (tool === "codex") {
          return ["full-access"];
        }
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

      function getSessionKindLabel(session) {
        var provider = session && session.provider ? session.provider : "claude";
        return (isStructuredSession(session) ? "结构化" : "终端") + " · " + provider;
      }

      function getSessionKindDescription(session) {
        return isStructuredSession(session)
          ? "结构化 · 块级记录"
          : (session && session.provider === "codex"
            ? "终端 · Codex PTY（chat 为解析视图）"
            : "终端 · PTY 会话");
      }

      function shouldRequestChatFormat(session) {
        if (!session) return false;
        return isStructuredSession(session) || session.provider === "codex";
      }

      function isRecoverableToolError(toolResult, nextResult) {
        if (!toolResult || !toolResult.is_error || !nextResult || nextResult.is_error) {
          return false;
        }
        var currentText = extractToolResultText(toolResult.content).toLowerCase();
        var nextText = extractToolResultText(nextResult.content).toLowerCase();
        if (!currentText) return false;
        if (currentText.indexOf("invalid pages parameter") !== -1 && nextText.length > 0) {
          return true;
        }
        return false;
      }

      function isStructuredSession(session) {
        return !!session && (session.sessionKind === "structured" || session.runner === "claude-cli-print");
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

      function getEffectiveModel(session) {
        if (session && session.selectedModel) return session.selectedModel;
        if (state.chatModel) return state.chatModel;
        if (state.config && state.config.defaultModel) return state.config.defaultModel;
        return "";
      }

      function getModelsForCurrentProvider(session) {
        var provider = (session && session.provider) || state.sessionTool || "claude";
        if (provider === "codex") return state.availableCodexModels || [];
        return state.availableModels || [];
      }

      function renderChatModelOptions(selected, session) {
        var models = getModelsForCurrentProvider(session);
        var html = '<option value="">默认（跟随设置）</option>';
        for (var i = 0; i < models.length; i++) {
          var m = models[i];
          var label = m.label || m.id;
          html += '<option value="' + escapeHtml(m.id) + '"' + (m.id === selected ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
        }
        if (selected && !models.some(function(m) { return m.id === selected; })) {
          html += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + '（自定义）</option>';
        }
        return html;
      }

      function syncComposerModelSelect(session) {
        var select = document.getElementById("chat-model-select");
        if (!select) return;
        var effective = getEffectiveModel(session);
        select.innerHTML = renderChatModelOptions(effective, session);
        select.value = effective;
      }

      function fetchAvailableModels() {
        return fetch("/api/models", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && Array.isArray(data.models)) {
              state.availableModels = data.models;
              state.availableCodexModels = Array.isArray(data.codexModels) ? data.codexModels : [];
              syncComposerModelSelect(getSelectedSession());
              updateSettingsDefaultModelSelect(data);
            }
            return data;
          })
          .catch(function() { return null; });
      }

      function refreshAvailableModels() {
        if (state.modelsRefreshing) return Promise.resolve(null);
        state.modelsRefreshing = true;
        var btn = document.getElementById("cfg-default-model-refresh");
        if (btn) { btn.disabled = true; btn.textContent = "刷新中..."; }
        return fetch("/api/models/refresh", { method: "POST", credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && Array.isArray(data.models)) {
              state.availableModels = data.models;
              state.availableCodexModels = Array.isArray(data.codexModels) ? data.codexModels : [];
              syncComposerModelSelect(getSelectedSession());
              updateSettingsDefaultModelSelect(data);
              if (typeof showToast === "function") {
                showToast("模型列表已刷新" + (data.claudeVersion ? "（claude " + data.claudeVersion + "）" : ""), "success");
              }
            }
            return data;
          })
          .catch(function() {
            if (typeof showToast === "function") showToast("刷新模型列表失败", "error");
            return null;
          })
          .finally(function() {
            state.modelsRefreshing = false;
            if (btn) { btn.disabled = false; btn.textContent = "刷新"; }
          });
      }

      function updateSettingsDefaultModelSelect(data) {
        var select = document.getElementById("cfg-default-model");
        if (!select) return;
        var previous = select.value;
        var current = previous || state.configDefaultModel || (state.config && state.config.defaultModel) || "";
        select.innerHTML = renderChatModelOptions(current, { provider: "claude" });
        select.value = current;
        var versionEl = document.getElementById("cfg-default-model-version");
        if (versionEl && data) {
          versionEl.textContent = data.claudeVersion ? "已检测到 claude " + data.claudeVersion : "新建会话时默认使用该模型。";
        }
      }

      function getSelectedSession() {
        if (!state.selectedId) return null;
        for (var i = 0; i < state.sessions.length; i++) {
          if (state.sessions[i].id === state.selectedId) return state.sessions[i];
        }
        return null;
      }

      function onChatModelChange(value) {
        var normalized = (value || "").trim();
        state.chatModel = normalized;
        try { localStorage.setItem("wand-chat-model", normalized); } catch (e) {}
        var session = getSelectedSession();
        if (!session) return;
        fetch("/api/sessions/" + encodeURIComponent(session.id) + "/model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ model: normalized || null })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data && data.error) {
            showToast(data.error, "error");
            return;
          }
          if (data && data.id) {
            updateSessionSnapshot(data);
            if (typeof showToast === "function") {
              var display = normalized || "默认";
              var hint = session.provider === "codex" ? "（下次对话生效）" : "";
              showToast("已切换模型 → " + display + hint, "success");
            }
          }
        })
        .catch(function() { showToast("切换模型失败", "error"); });
      }

      function createStructuredSession(prompt, cwdOverride, modeOverride, worktreeEnabled) {
        var provider = state.sessionTool === "codex" ? "codex" : "claude";
        var modelPref = state.chatModel || (state.config && state.config.defaultModel) || "";
        var payload = {
          cwd: cwdOverride || getEffectiveCwd(),
          mode: modeOverride || state.chatMode || (state.config && state.config.defaultMode) || "default",
          provider: provider,
          runner: provider === "codex" ? "codex-cli-exec" : ((state.config && state.config.structuredRunner === "sdk") ? "claude-sdk" : (state.structuredRunner || "claude-cli-print")),
          prompt: prompt || undefined,
          worktreeEnabled: worktreeEnabled === true,
          model: modelPref || undefined
        };
        console.log("[WAND] createStructuredSession payload:", JSON.stringify(payload));
        return fetch("/api/structured-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload)
        })
        .then(function(res) {
          console.log("[WAND] createStructuredSession response status:", res.status);
          return res.json();
        })
        .then(function(data) {
          console.log("[WAND] createStructuredSession data:", JSON.stringify({ id: data.id, error: data.error, sessionKind: data.sessionKind, runner: data.runner, status: data.status }));
          if (data.error) {
            throw new Error(data.error);
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          resetChatRenderCache();
          updateSessionSnapshot(data);
          updateSessionsList();
          switchToSessionView(data.id);
          subscribeToSession(data.id);
          return loadOutput(data.id).then(function() { return data; });
        });
      }

      function applyCurrentView() {
        var hasSession = !!state.selectedId;
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var structured = isStructuredSession(selectedSession);
        var showTerminal = hasSession && !structured && state.currentView === "terminal";
        var showChat = hasSession && (structured || state.currentView !== "terminal");
        if (structured) {
          state.currentView = "chat";
        } else if (!hasSession) {
          state.currentView = "terminal";
        }

        if (terminalContainer) {
          terminalContainer.classList.toggle("active", showTerminal);
          terminalContainer.classList.toggle("hidden", !showTerminal);
        }
        if (chatContainer) {
          chatContainer.classList.toggle("active", showChat);
          chatContainer.classList.toggle("hidden", !showChat);
        }
        if (chatContainer && showChat) {
          ensureChatMessagesContainer(chatContainer);
        }
        bindChatScrollListener();
        updateChatFollowToggleButton();
        updateChatJumpToBottomButton();
        updateInteractiveControls();
      }

      function syncSessionModalUI() {
        var modeHint = document.getElementById("mode-description");
        var kindHint = document.getElementById("session-kind-description");
        var tool = state.sessionTool || "claude";
        var sessionKind = state.sessionCreateKind || "structured";

        state.sessionTool = tool;
        state.modeValue = getSafeModeForTool(tool, state.modeValue || state.chatMode || "default");

        var providerCards = document.querySelectorAll("#provider-cards .provider-card");
        if (providerCards.length) {
          providerCards.forEach(function(card) {
            var provider = card.getAttribute("data-provider");
            card.classList.toggle("active", provider === tool);
            card.classList.remove("disabled");
          });
        }

        var kindCards = document.querySelectorAll("#session-kind-cards .session-kind-card");
        if (kindCards.length) {
          kindCards.forEach(function(card) {
            var kind = card.getAttribute("data-session-kind");
            var disabled = false;
            card.classList.toggle("active", kind === sessionKind);
            card.classList.toggle("disabled", disabled);
          });
        }

        var modeCards = document.querySelectorAll("#mode-cards .mode-card");
        if (modeCards.length) {
          modeCards.forEach(function(card) {
            card.classList.toggle("active", card.getAttribute("data-mode") === state.modeValue);
          });
        }

        if (kindHint) kindHint.textContent = getSessionKindHint(sessionKind);
        if (modeHint) modeHint.textContent = getToolModeHint(tool, state.modeValue);
      }

      function updateSessionSnapshot(snapshot) {
        if (!snapshot || !snapshot.id) return;
        var currentSession = state.sessions.find(function(session) { return session.id === snapshot.id; }) || null;
        var normalizedSnapshot = normalizeStructuredSnapshot(snapshot, currentSession);
        var updated = false;
        var prevSession = null;
        state.sessions = state.sessions.map(function(session) {
          if (session.id !== normalizedSnapshot.id) return session;
          prevSession = session;
          updated = true;
          return Object.assign({}, session, normalizedSnapshot);
        });
        if (!updated) {
          state.sessions.unshift(normalizedSnapshot);
        }
        var updatedSession = state.sessions.find(function(session) { return session.id === normalizedSnapshot.id; }) || normalizedSnapshot;
        if (updatedSession && Array.isArray(updatedSession.queuedMessages) && normalizedSnapshot.id === state.selectedId) {
          syncStructuredQueueFromSession(updatedSession);
          saveStructuredQueue();
          updateStructuredQueueCounter();
        }
        if (normalizedSnapshot.id === state.selectedId) {
          reconcileInteractiveState();
          updateTaskDisplay();
          // Escalation/permission toggles are the common trigger for CSI cursor-jump
          // redraw sequences from Claude CLI. When they appear or dismiss, schedule a
          // debounced terminal resync so residual DOM rows get cleaned up automatically
          // — same fix the user used to have to reach for via the refresh button.
          var prevEsc = prevSession && prevSession.pendingEscalation ? 1 : 0;
          var nextEsc = updatedSession && updatedSession.pendingEscalation ? 1 : 0;
          var prevBlocked = prevSession && prevSession.permissionBlocked ? 1 : 0;
          var nextBlocked = updatedSession && updatedSession.permissionBlocked ? 1 : 0;
          if (prevEsc !== nextEsc || prevBlocked !== nextBlocked) {
            scheduleSoftResyncTerminal(200);
          }
        }
        // When a session transitions to a non-running state, try flushing cross-session queue
        if (normalizedSnapshot.status && normalizedSnapshot.status !== "running" && state.crossSessionQueue.length > 0) {
          // Use setTimeout(0) to let the current event processing complete first
          setTimeout(flushCrossSessionQueue, 0);
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
        var localStructuredState = localSession.structuredState || null;
        var serverStructuredState = serverSession.structuredState || null;
        var structuredSession = (localSession.sessionKind === "structured") || (serverSession.sessionKind === "structured");
        var localHasPendingAssistant = !!(localSession.messages && localSession.messages.length && (function() {
          var last = localSession.messages[localSession.messages.length - 1];
          return last && last.role === "assistant" && Array.isArray(last.content) && last.content.some(function(block) {
            return block && block.__processing;
          });
        })());
        var localMessages = Array.isArray(localSession.messages)
          ? (structuredSession ? stripRenderOnlyStructuredMessages(localSession.messages) : localSession.messages)
          : [];
        var serverMessages = Array.isArray(serverSession.messages)
          ? (structuredSession ? stripRenderOnlyStructuredMessages(serverSession.messages) : serverSession.messages)
          : [];
        // 服务端已经返回了完整的 assistant 回复（非 __processing 占位）时，
        // 不应再保留本地的 inFlight=true 状态，否则用户会看到"思考中"转圈永远不停。
        var serverHasCompletedAssistant = serverMessages.length > 0 && (function() {
          var last = serverMessages[serverMessages.length - 1];
          return last && last.role === "assistant" && Array.isArray(last.content)
            && !last.content.some(function(b) { return b && b.__processing; });
        })();
        var preserveLocalStructuredProgress = (localSession.sessionKind === "structured")
          && !!localStructuredState
          && localStructuredState.inFlight === true
          && (!serverStructuredState || serverStructuredState.inFlight !== true)
          && localHasPendingAssistant
          && !!localStructuredState.activeRequestId
          && !!serverStructuredState && !!serverStructuredState.activeRequestId
          && serverStructuredState.activeRequestId === localStructuredState.activeRequestId
          && !serverHasCompletedAssistant;
        var preserveLocalMessages = localMessages.length > serverMessages.length
          || (localMessages.length > 0 && serverMessages.length > 0
            && JSON.stringify(localMessages[localMessages.length - 1]) !== JSON.stringify(serverMessages[serverMessages.length - 1])
            && JSON.stringify(localMessages).length > JSON.stringify(serverMessages).length);

        if (keepLocalOutput) {
          merged.output = localOutput;
        }

        if (preserveLocalStructuredProgress) {
          merged.status = localSession.status || merged.status;
          merged.structuredState = Object.assign({}, serverStructuredState || {}, localStructuredState, { inFlight: true });
          merged.messages = localSession.messages;
        }

        if (preserveLocalMessages) {
          merged.messages = localMessages;
        }

        if (localSession.id === state.selectedId) {
          if (localSession.permissionBlocked && serverSession.permissionBlocked === false) {
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
        if (session && session.sessionKind === "structured") {
          return [];
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
        if (state.selectedId) {
          var stillExists = sessions.find(function(session) { return session.id === state.selectedId; });
          if (stillExists) return stillExists.id;
          return null;
        }
        var runningSession = sessions.find(function(session) { return session.status === "running"; });
        if (runningSession) return runningSession.id;
        var recent = sessions.find(function(session) { return !session.archived; });
        return recent ? recent.id : sessions[0].id;
      }

      function loadSessions(options) {
        var opts = options || {};
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

            var preferredSessionId = getPreferredSessionId(state.sessions);
            if (preferredSessionId !== undefined) {
              state.selectedId = preferredSessionId;
            }
            restoreStructuredQueue();
            updateStructuredQueueCounter();
            state.bootstrapping = false;
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
            if (state.selectedId && state.gitStatusSessionId !== state.selectedId) {
              loadGitStatus(state.selectedId);
            }

            var reloadPromise = Promise.resolve();
            if (!opts.skipSelectedOutputReload && state.selectedId) {
              reloadPromise = loadOutput(state.selectedId);
            } else if (state.selectedId) {
              var sel = state.sessions.find(function(s) { return s.id === state.selectedId; });
              if (isStructuredSession(sel)) {
                resetChatRenderCache();
                scheduleChatRender(true);
              }
            }

            return reloadPromise.then(function() {
              if (state.crossSessionQueue.length > 0) {
                flushCrossSessionQueue();
              }
              renderCrossSessionQueue();
              _syncWakeLock();
            });
          })
          .catch(function(e) {
            var message = (e && e.message) || "";
            var isTransientAbort =
              message === "Failed to fetch" ||
              message === "NetworkError when attempting to fetch resource." ||
              message === "Load failed" ||
              /aborted|aborterror|networkerror|failed to fetch/i.test(message);
            if (!isTransientAbort) {
              console.error("[wand] loadSessions failed:", e);
            }
          });
      }

      var _sessionListUpdateTimer = null;
      function scheduleSessionListUpdate() {
        if (_sessionListUpdateTimer) return;
        _sessionListUpdateTimer = setTimeout(function() {
          _sessionListUpdateTimer = null;
          updateSessionsList();
        }, 200);
      }

      function updateSessionsList() {
        var listEl = document.getElementById("sessions-list");
        var countEl = document.getElementById("session-count");
        if (listEl) listEl.innerHTML = renderSessions();
        if (countEl) countEl.textContent = String(state.sessions.length);
        updateShellChrome();
        // Re-render cross-session queue (container may have been destroyed by DOM rebuild)
        if (state.crossSessionQueue.length > 0) renderCrossSessionQueue();
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
        if (infoEl) infoEl.textContent = selectedSession ? (terminalInfo + " · " + getSessionKindDescription(selectedSession)) : terminalInfo;

        var cwdEl = document.getElementById("session-cwd-display");
        var modeEl = document.getElementById("session-mode-display");
        var kindEl = document.getElementById("session-kind-display");
        var statusEl = document.getElementById("session-status-display");
        var exitEl = document.getElementById("session-exit-display");
        var cwdText = selectedSession && selectedSession.cwd ? selectedSession.cwd : "未设置目录";
        var modeText = selectedSession ? getModeLabel(selectedSession.mode) : "默认";
        var kindText = selectedSession ? getSessionKindLabel(selectedSession) : "终端";
        var isStructured = selectedSession && isStructuredSession(selectedSession);
        var exitText = isStructured ? "" : "退出码=" + (selectedSession && selectedSession.exitCode !== undefined ? selectedSession.exitCode : "n/a");
        if (cwdEl && cwdEl.textContent !== cwdText) cwdEl.textContent = cwdText;
        if (modeEl && modeEl.textContent !== modeText) modeEl.textContent = modeText;
        if (kindEl && kindEl.textContent !== kindText) kindEl.textContent = kindText;
        if (statusEl && statusEl.textContent !== terminalInfo) statusEl.textContent = terminalInfo;
        if (exitEl && exitEl.textContent !== exitText) exitEl.textContent = exitText;
        updateAutoApproveIndicator();

        if (!state.terminal && terminalContainer && selectedSession) {
          initTerminal();
        }
        if (state.terminal && terminalContainer && !terminalContainer.contains(state.terminal.element)) {
          teardownTerminal();
          initTerminal();
        }

        if (!selectedSession) {
          state.terminalSessionId = null;
          state.terminalOutput = "";
        }
        // 之前这里会用 selectedSession.output 再 syncTerminalBuffer 一次。
        // 但 updateShellChrome 在 updateSessionsList、status 推送、init
        // 等多个高频路径都会被调，每次都拿"可能不带 output 的 slim 快照"
        // 兜回来 sync 一遍：要么早返回浪费判断，要么 prefix 不匹配触发
        // reset+全量重写、把 alt-screen 中正在绘制的 Claude TUI 切走。
        // terminal 写入应当只走 chunk hot-path 与 ws init 这两条权威路径，
        // 这里不再插手，避免引入二次覆盖。

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
        syncComposerModelSelect(getSelectedSession());
        applyCurrentView();
        reconcileInteractiveState();
      }

      function loadOutput(id) {
        // Cancel any pending debounced chat render to avoid flicker
        if (chatRenderTimer) {
          clearTimeout(chatRenderTimer);
          chatRenderTimer = null;
        }
        var sess = state.sessions.find(function(s) { return s.id === id; });
        var url = "/api/sessions/" + id;
        if (shouldRequestChatFormat(sess)) {
          url += "?format=chat";
        }
        return fetch(url, { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.error) {
              // Session no longer exists — deselect and refresh list
              if (state.selectedId === id) {
                state.selectedId = null;
                persistSelectedId();
              }
              loadSessions();
              return;
            }
            updateSessionSnapshot(data);
            updateShellChrome();

            if (state.terminal && id === state.selectedId && data.output !== undefined) {
              // ws 在线时不要在这里写终端：HTTP 这边返回的是 PTY transcript
              // 完整磁盘文件（可达数十 MB），ws 订阅 init 拿到的是内存 ring
              // buffer 末尾窗口（约 200KB），二者长度+起点都不同。两路都
              // syncTerminalBuffer 时，append 模式的前缀检查必然失败，
              // 落到 else 分支的 reset+全量重写，与 ws init 的 reset+
              // 写入交叠，造成首屏「两份内容错位重叠」。
              // 设计原则：terminal 写入只走 ws init 与 chunk hot-path 两条
              // 权威路径——参见 case "init" 的 replace 写入与 onmessage
              // chunk 处理。这里只在 ws 离线兜底时才 append 写入。
              //
              // wsLikelyTakingOver: 即使 wsConnected=false（onopen 还没 fire），
              // 只要 ws.readyState 是 CONNECTING 或 OPEN，就视为 ws 即将
              // 接管。否则 selectSession → loadOutput resolve 比 ws onopen
              // 早时（常见于刷新页面后的首次连接）会误走 fallback，写入
              // terminal 后 ws init 又写一次，造成双路重叠。
              var wsLikelyTakingOver = !!state.ws && (
                state.ws.readyState === WebSocket.OPEN ||
                state.ws.readyState === WebSocket.CONNECTING
              );
              if (!wsLikelyTakingOver) {
                syncTerminalBuffer(id, data.output, { mode: "append" });
                // 离线兜底路径自己负责 fit + replay，否则尺寸不对。
                ensureTerminalFit("session-switch", { forceReplay: true });
              } else {
                // ws 在线/连接中：仅校准列宽，不重 replay（init 的
                // ensureTerminalFitWithRetry("init") 会负责按真实
                // 宽度的全量基线写入）。
                ensureTerminalFit("session-switch");
              }
            }

            var selectedSession = state.sessions.find(function(s) { return s.id === id; });
              state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, data.output, false));

            renderChat(false);
          });
      }

      function selectSession(id) {
        var foundSession = state.sessions.find(function(item) { return item.id === id; });
        if (!foundSession) {
          return;
        }
        if (state.selectedId !== id) {
          teardownTerminal();
        }
        state.selectedId = id;
        persistSelectedId();
        state.toolContentCache = {};
        // Clear queued inputs from the previous session to prevent cross-session leaks
        state.messageQueue = [];
        state.pendingMessages = [];
        syncStructuredQueueFromSession(foundSession);
        restoreStructuredQueue();
        updateStructuredQueueCounter();
        resetChatRenderCache();
        state.currentMessages = [];
        if (chatRenderTimer) { clearTimeout(chatRenderTimer); chatRenderTimer = null; }
        // Reset todo progress bar
        var todoEl = document.getElementById("todo-progress");
        if (todoEl) todoEl.classList.add("hidden");
        var session = foundSession;
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
        // 切换会话时清掉旧 git 状态，再异步刷新
        state.gitStatus = null;
        state.gitStatusSessionId = null;
        updateTopbarGitBadge();
        loadGitStatus(id, { force: true });
      }

      function updatePinState() {
        var drawer = document.getElementById("sessions-drawer");
        var mainLayout = document.querySelector(".main-layout");
        var pinBtn = document.getElementById("sidebar-pin-btn");
        if (drawer) {
          drawer.classList.toggle("pinned", state.sidebarPinned && !isMobileLayout());
        }
        if (mainLayout) {
          mainLayout.classList.toggle("sidebar-pinned", state.sidebarPinned && !isMobileLayout());
        }
        if (pinBtn) {
          pinBtn.classList.toggle("pinned", state.sidebarPinned);
          pinBtn.title = state.sidebarPinned ? "取消固定侧栏" : "固定侧栏";
        }
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
        updatePinState();
      }

      function toggleSessionsDrawer() {
        if (state.sidebarPinned && !isMobileLayout()) return;
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
        if (state.sidebarPinned && !isMobileLayout()) return;
        if (!state.sessionsDrawerOpen) return;
        closeSwipedItem();
        state.sessionsDrawerOpen = false;
        updateLayoutState();
      }

      function toggleSidebarPin() {
        if (isMobileLayout()) return;
        state.sidebarPinned = !state.sidebarPinned;
        try {
          localStorage.setItem("wand-sidebar-pinned", String(state.sidebarPinned));
        } catch (e) {}
        if (state.sidebarPinned) {
          state.sessionsDrawerOpen = true;
        }
        updateLayoutState();
        // Refit terminal after padding-left transition completes
        var mainLayout = document.querySelector(".main-layout");
        if (mainLayout) {
          var onEnd = function(e) {
            if (e.propertyName === "padding-left") {
              mainLayout.removeEventListener("transitionend", onEnd);
              scheduleTerminalResize(true);
            }
          };
          mainLayout.addEventListener("transitionend", onEnd);
        }
        // Fallback refit in case transition doesn't fire
        setTimeout(function() { scheduleTerminalResize(true); }, 350);
      }

      // Store last focused element for focus trap
      var lastFocusedElement = null;
      var focusTrapHandler = null;

      function openSessionModal() {
        // Close settings modal first if open (mutual exclusion)
        closeSettingsModal();
        state.modalOpen = true;
        state.sessionsDrawerOpen = false;
        updateDrawerState();
        var modal = document.getElementById("session-modal");
        if (modal) {
          if (modal._wandCloseTimer) { clearTimeout(modal._wandCloseTimer); modal._wandCloseTimer = null; }
          modal.classList.remove("closing");
          modal.classList.remove("hidden");
          lastFocusedElement = document.activeElement;
          state.sessionTool = getPreferredTool();
          state.preferredCommand = state.sessionTool;
          state.sessionCreateKind = "structured";
          state.sessionCreateWorktree = false;
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
          // Remove focus trap before kicking off the exit animation
          if (focusTrapHandler) {
            document.removeEventListener("keydown", focusTrapHandler);
            focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
            lastFocusedElement.focus();
          }
          animateModalClose(modal);
        }
        hidePathSuggestions();
      }

      // Run the liquid-glass exit animation on a modal-backdrop, then mark it hidden.
      // Falls back to instant hide when reduced-motion is requested or a tab is in the background.
      function animateModalClose(modal) {
        if (!modal) return;
        if (modal.classList.contains("hidden")) return;
        var prefersReducedMotion = false;
        try {
          prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (_e) {}
        if (prefersReducedMotion || document.hidden) {
          modal.classList.remove("closing");
          modal.classList.add("hidden");
          return;
        }
        // Cancel any outstanding pending hide on the same node
        if (modal._wandCloseTimer) {
          clearTimeout(modal._wandCloseTimer);
          modal._wandCloseTimer = null;
        }
        modal.classList.add("closing");
        modal._wandCloseTimer = setTimeout(function() {
          modal.classList.remove("closing");
          modal.classList.add("hidden");
          modal._wandCloseTimer = null;
        }, 170);
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

      function getActiveWorktreeMergeSession() {
        if (!state.activeWorktreeMergeSessionId) return null;
        return state.sessions.find(function(session) { return session.id === state.activeWorktreeMergeSessionId; }) || null;
      }

      function renderWorktreeMergeContent() {
        var container = document.getElementById("worktree-merge-content");
        var confirmBtn = document.getElementById("worktree-merge-confirm-button");
        var errorEl = document.getElementById("worktree-merge-error");
        var session = getActiveWorktreeMergeSession();
        var result = state.worktreeMergeCheckResult;
        if (!container || !confirmBtn) return;
        if (!session || !session.worktree) {
          container.innerHTML = '<p class="field-hint">未找到可合并的 worktree 会话。</p>';
          confirmBtn.disabled = true;
          return;
        }
        if (errorEl) {
          if (state.worktreeMergeError) {
            showError(errorEl, state.worktreeMergeError);
          } else {
            hideError(errorEl);
          }
        }
        var rows = [
          '<div class="worktree-merge-row"><span>来源分支</span><strong>' + escapeHtml(session.worktree.branch || "-") + '</strong></div>',
          '<div class="worktree-merge-row"><span>工作目录</span><strong>' + escapeHtml(session.worktree.path || "-") + '</strong></div>'
        ];
        if (result) {
          rows.push('<div class="worktree-merge-row"><span>目标分支</span><strong>' + escapeHtml(result.targetBranch || "-") + '</strong></div>');
          rows.push('<div class="worktree-merge-row"><span>待合并提交</span><strong>' + escapeHtml(String(result.aheadCount || 0)) + '</strong></div>');
          rows.push('<div class="worktree-merge-row"><span>未提交改动</span><strong>' + escapeHtml(result.hasUncommittedChanges ? "有" : "无") + '</strong></div>');
          rows.push('<div class="worktree-merge-row"><span>冲突风险</span><strong>' + escapeHtml(result.hasConflicts ? "有" : "无") + '</strong></div>');
          if (result.reason) {
            rows.push('<p class="field-hint">' + escapeHtml(result.reason) + '</p>');
          }
        } else if (state.worktreeMergeLoading) {
          rows.push('<p class="field-hint">正在检查 worktree 合并状态…</p>');
        }
        container.innerHTML = rows.join("");
        confirmBtn.disabled = state.worktreeMergeLoading || state.worktreeMergeSubmitting || !result || result.ok !== true;
        confirmBtn.textContent = state.worktreeMergeSubmitting ? "合并中..." : "确认合并并清理";
      }

      function openWorktreeMergeModal(sessionId) {
        state.activeWorktreeMergeSessionId = sessionId;
        state.worktreeMergeCheckResult = null;
        state.worktreeMergeLoading = true;
        state.worktreeMergeSubmitting = false;
        state.worktreeMergeError = "";
        closeSessionModal();
        closeSettingsModal();
        var modal = document.getElementById("worktree-merge-modal");
        if (modal) {
          modal.classList.remove("hidden");
          lastFocusedElement = document.activeElement;
          setupFocusTrap(modal);
        }
        renderWorktreeMergeContent();
        fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/worktree/merge/check", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            if (data && data.session) {
              updateSessionSnapshot(data.session);
            }
            state.worktreeMergeCheckResult = data.result || null;
            state.worktreeMergeError = "";
          })
          .catch(function(error) {
            state.worktreeMergeError = (error && error.message) || "无法检查 worktree 合并状态。";
          })
          .finally(function() {
            state.worktreeMergeLoading = false;
            renderWorktreeMergeContent();
          });
      }

      function closeWorktreeMergeModal() {
        var modal = document.getElementById("worktree-merge-modal");
        state.activeWorktreeMergeSessionId = null;
        state.worktreeMergeCheckResult = null;
        state.worktreeMergeLoading = false;
        state.worktreeMergeSubmitting = false;
        state.worktreeMergeError = "";
        if (modal) {
          modal.classList.add("hidden");
        }
        if (focusTrapHandler) {
          document.removeEventListener("keydown", focusTrapHandler);
          focusTrapHandler = null;
        }
        if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
          lastFocusedElement.focus();
        }
      }

      function confirmWorktreeMerge() {
        if (!state.activeWorktreeMergeSessionId || state.worktreeMergeSubmitting) return;
        state.worktreeMergeSubmitting = true;
        state.worktreeMergeError = "";
        renderWorktreeMergeContent();
        fetch("/api/sessions/" + encodeURIComponent(state.activeWorktreeMergeSessionId) + "/worktree/merge", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            if (data && data.session) {
              updateSessionSnapshot(data.session);
            }
            showToast("已合并到 " + escapeHtml((data.result && data.result.targetBranch) || "主分支") + ((data.result && data.result.cleanupDone === false) ? "，但工作树待清理。" : "。"), "info");
            closeWorktreeMergeModal();
            return refreshAll();
          })
          .catch(function(error) {
            state.worktreeMergeError = (error && error.message) || "无法合并 worktree。";
            renderWorktreeMergeContent();
          })
          .finally(function() {
            state.worktreeMergeSubmitting = false;
            renderWorktreeMergeContent();
          });
      }

      function retryWorktreeCleanup(sessionId) {
        fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/worktree/cleanup", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            if (data && data.session) {
              updateSessionSnapshot(data.session);
            }
            showToast("已完成 worktree 清理。", "info");
            return refreshAll();
          })
          .catch(function(error) {
            showToast((error && error.message) || "无法清理 worktree。", "error");
          });
      }

      function openSettingsModal() {
        // Close session modal first if open (mutual exclusion)
        closeSessionModal();
        var modal = document.getElementById("settings-modal");
        if (modal) {
          if (modal._wandCloseTimer) { clearTimeout(modal._wandCloseTimer); modal._wandCloseTimer = null; }
          modal.classList.remove("closing");
          modal.classList.remove("hidden");
          lastFocusedElement = document.activeElement;
          var passEl = document.getElementById("new-password");
          var confirmEl = document.getElementById("confirm-password");
          if (passEl) passEl.value = "";
          if (confirmEl) confirmEl.value = "";
          hideSettingsMessages();
          setupFocusTrap(modal);
          bindSettingsTabKeyboardNavigation();
          // Activate first tab
          switchSettingsTab("about");
          // Load settings data
          loadSettingsData();
          // Sync notification preferences
          var soundEl = document.getElementById("cfg-notif-sound");
          var bubbleEl = document.getElementById("cfg-notif-bubble");
          if (soundEl) soundEl.checked = state.notifSound;
          if (bubbleEl) bubbleEl.checked = state.notifBubble;
          var volEl = document.getElementById("cfg-notif-volume");
          var volValEl = document.getElementById("cfg-notif-volume-val");
          if (volEl) {
            volEl.value = state.notifVolume;
            if (volValEl) volValEl.textContent = state.notifVolume + "%";
            // Sync the iOS-style fill via the input listener (calls _syncRangeFill)
            try { volEl.dispatchEvent(new Event("input", { bubbles: true })); } catch (_e) {}
          }
          var volField = document.getElementById("notif-volume-field");
          if (volField) volField.style.display = state.notifSound ? "" : "none";
          updateNotificationStatus();
          // Load current app icon selection (APK only)
          if (typeof WandNative !== "undefined" && typeof WandNative.getAppIcon === "function") {
            try { _updateAppIconSelection(WandNative.getAppIcon() || "shorthair"); } catch (_e) {}
          }
          // Sync native notification sound selector and volume (APK only)
          if (_hasNativeBridge && typeof WandNative.getNotificationSound === "function") {
            try {
              var nsSel = document.getElementById("native-sound-select");
              if (nsSel) nsSel.value = WandNative.getNotificationSound();
            } catch (_e) {}
          }
          if (_hasNativeBridge && typeof WandNative.getNotificationVolume === "function") {
            try {
              var nativeVol = WandNative.getNotificationVolume();
              state.notifVolume = nativeVol;
              if (volEl) volEl.value = nativeVol;
              if (volValEl) volValEl.textContent = nativeVol + "%";
              // Sync the iOS-style fill so the orange track matches
              if (volEl) { try { volEl.dispatchEvent(new Event("input", { bubbles: true })); } catch (_e) {} }
              try { localStorage.setItem("wand-notif-volume", String(nativeVol)); } catch (_e) {}
            } catch (_e) {}
          }
          if (_hasNativeBridge && typeof WandNative.isHapticEnabled === "function") {
            try {
              var hapticEl = document.getElementById("cfg-haptic-enabled");
              if (hapticEl) hapticEl.checked = WandNative.isHapticEnabled();
            } catch (_e) {}
          }
        }
      }

      function closeSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) {
          // Remove focus trap before kicking off the exit animation
          if (focusTrapHandler) {
            document.removeEventListener("keydown", focusTrapHandler);
            focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
            lastFocusedElement.focus();
          }
          animateModalClose(modal);
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
          var isActive = tabs[i].getAttribute("data-tab") === tabName;
          if (isActive) {
            tabs[i].classList.add("active");
          } else {
            tabs[i].classList.remove("active");
          }
          tabs[i].setAttribute("aria-selected", isActive ? "true" : "false");
          tabs[i].setAttribute("tabindex", isActive ? "0" : "-1");
        }
        for (var j = 0; j < panels.length; j++) {
          var isPanelActive = panels[j].id === "settings-tab-" + tabName;
          if (isPanelActive) {
            panels[j].classList.add("active");
            panels[j].removeAttribute("hidden");
          } else {
            panels[j].classList.remove("active");
            panels[j].setAttribute("hidden", "hidden");
          }
        }
      }

      function handleSettingsTabKeydown(event) {
        if (!event) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") {
          return;
        }
        var tabs = Array.prototype.slice.call(document.querySelectorAll(".settings-tab"));
        if (!tabs.length) return;
        var currentIndex = tabs.indexOf(event.currentTarget);
        if (currentIndex === -1) return;
        event.preventDefault();
        var nextIndex = currentIndex;
        if (event.key === "ArrowUp") nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
        if (event.key === "ArrowDown") nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        var nextTab = tabs[nextIndex];
        if (!nextTab) return;
        var nextName = nextTab.getAttribute("data-tab");
        if (nextName) switchSettingsTab(nextName);
        if (typeof nextTab.focus === "function") nextTab.focus();
      }

      function bindSettingsTabKeyboardNavigation() {
        var tabs = document.querySelectorAll(".settings-tab");
        for (var i = 0; i < tabs.length; i++) {
          tabs[i].removeEventListener("keydown", handleSettingsTabKeydown);
          tabs[i].addEventListener("keydown", handleSettingsTabKeydown);
        }
      }

      function updateSettingsSidebarStatus(data) {
        if (!data) return;
        var cfg = data.config || {};
        var metaMap = {
          about: data.version ? ("当前 v" + data.version) : "版本与更新信息",
          general: [cfg.defaultMode || "default", cfg.language || "自动语言"].filter(Boolean).join(" · "),
          notifications: state.notifSound ? ("提示音 " + state.notifVolume + "%") : "提示音已关闭",
          security: data.hasCert ? "已安装 SSL 证书" : "密码与证书管理",
          presets: cfg.commandPresets && cfg.commandPresets.length ? (cfg.commandPresets.length + " 条预设") : "暂无预设",
          display: "控制卡片默认展开"
        };
        for (var key in metaMap) {
          if (!Object.prototype.hasOwnProperty.call(metaMap, key)) continue;
          var tab = document.querySelector('.settings-tab[data-tab="' + key + '"] .settings-tab-meta');
          if (tab) tab.textContent = metaMap[key] || "";
        }
      }


      function renderConnectQrCode(code) {
        var canvas = document.getElementById("android-connect-qr");
        var empty = document.getElementById("android-connect-qr-empty");
        var lib = window.QRCodeLib;
        if (!canvas) return;
        if (!lib || typeof lib.toCanvas !== "function") {
          if (empty) empty.textContent = "二维码库未加载";
          return;
        }
        try {
          lib.toCanvas(canvas, code, {
            width: 220,
            margin: 1,
            errorCorrectionLevel: "M",
            color: { dark: "#1f1b17", light: "#ffffff00" }
          }, function(err) {
            if (err) {
              if (empty) {
                empty.textContent = "二维码生成失败";
                empty.style.display = "";
              }
              canvas.style.visibility = "hidden";
              return;
            }
            if (empty) empty.style.display = "none";
            canvas.style.visibility = "visible";
          });
        } catch (e) {
          if (empty) {
            empty.textContent = "二维码生成失败";
            empty.style.display = "";
          }
          canvas.style.visibility = "hidden";
        }
      }

      function showConnectQrModal(code) {
        var lib = window.QRCodeLib;
        if (!lib || typeof lib.toCanvas !== "function") return;
        // Reuse existing overlay if open
        var existing = document.getElementById("connect-qr-modal");
        if (existing) existing.remove();
        var overlay = document.createElement("div");
        overlay.id = "connect-qr-modal";
        overlay.className = "connect-qr-modal-overlay";
        overlay.innerHTML =
          '<div class="connect-qr-modal-card">' +
            '<canvas id="connect-qr-modal-canvas"></canvas>' +
            '<p class="connect-qr-modal-hint">用 Wand App 扫一扫，连接当前服务器</p>' +
            '<button type="button" class="btn btn-secondary btn-sm connect-qr-modal-close">关闭</button>' +
          '</div>';
        document.body.appendChild(overlay);
        var modalCanvas = overlay.querySelector("#connect-qr-modal-canvas");
        var size = Math.min(window.innerWidth, window.innerHeight) * 0.7;
        if (size < 240) size = 240;
        if (size > 480) size = 480;
        try {
          lib.toCanvas(modalCanvas, code, {
            width: size,
            margin: 2,
            errorCorrectionLevel: "M",
            color: { dark: "#1f1b17", light: "#ffffff" }
          });
        } catch (e) {}
        function close() { overlay.remove(); }
        overlay.addEventListener("click", function(e) {
          if (e.target === overlay) close();
        });
        var closeBtn = overlay.querySelector(".connect-qr-modal-close");
        if (closeBtn) closeBtn.addEventListener("click", close);
      }

      function copyToClipboard(text, triggerBtn, successCallback) {
        if (!text) return;
        function onSuccess() {
          _vibrate("light");
          if (successCallback) { successCallback(); return; }
          if (triggerBtn) {
            var orig = triggerBtn.textContent;
            triggerBtn.textContent = "已复制";
            setTimeout(function() { triggerBtn.textContent = orig; }, 1500);
          }
        }
        if (_hasNativeBridge && typeof WandNative.copyToClipboard === "function") {
          try {
            if (WandNative.copyToClipboard(text) === "ok") { onSuccess(); return; }
          } catch (_e) {}
        }
        navigator.clipboard.writeText(text).then(onSuccess).catch(function() {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          onSuccess();
        });
      }

      function formatBytes(value) {
        if (typeof value !== "number" || !isFinite(value) || value < 0) return "-";
        if (value < 1024) return value + " B";
        var units = ["KB", "MB", "GB", "TB"];
        var size = value / 1024;
        var unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size = size / 1024;
          unitIndex += 1;
        }
        var display = size >= 10 ? size.toFixed(0) : size.toFixed(1);
        return display + " " + units[unitIndex];
      }

      function loadSettingsData() {
        fetch("/api/settings", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            updateSettingsSidebarStatus(data);
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

            // Prefill update info if available
            var latestEl = document.getElementById("settings-latest-version");
            var updateBtn = document.getElementById("do-update-button");
            if (data.latestVersion && latestEl) {
              latestEl.textContent = data.latestVersion;
              if (data.updateAvailable && updateBtn) {
                updateBtn.classList.remove("hidden");
              }
            }

            // Auto-update toggles
            var autoUpdate = data.autoUpdate || {};
            var autoUpdateWebToggle = document.getElementById("auto-update-web-toggle");
            if (autoUpdateWebToggle) autoUpdateWebToggle.checked = !!autoUpdate.web;
            var autoUpdateApkToggle = document.getElementById("auto-update-apk-toggle");
            if (autoUpdateApkToggle) autoUpdateApkToggle.checked = !!autoUpdate.apk;

            // ── Android APK version display ──
            var apkSection = document.getElementById("android-apk-section");
            var apkCurrentRow = document.getElementById("android-apk-current-row");
            var apkCurrentEl = document.getElementById("settings-android-apk-current");
            var apkGithubRow = document.getElementById("android-apk-github-row");
            var apkGithubEl = document.getElementById("settings-android-apk-github");
            var apkGithubBtn = document.getElementById("download-github-apk-btn");
            var apkLocalRow = document.getElementById("android-apk-local-row");
            var apkLocalEl = document.getElementById("settings-android-apk-local");
            var apkLocalBtn = document.getElementById("download-local-apk-btn");
            var apkMessageEl = document.getElementById("android-apk-message");
            var androidApk = data.androidApk || {};
            var isInApk = !!_apkVersion;
            var hasApkInfo = isInApk || !!androidApk.github || !!androidApk.local;
            if (apkSection) {
              if (hasApkInfo) apkSection.classList.remove("hidden");
              else apkSection.classList.add("hidden");
            }

            if (isInApk) {
              // ── APK 内模式：显示当前版本 + 线上版本 + 本地版本 ──
              if (apkCurrentRow && apkCurrentEl) {
                apkCurrentEl.textContent = "v" + _apkVersion;
                apkCurrentRow.classList.remove("hidden");
              }
              // 线上版本
              if (androidApk.github && apkGithubRow && apkGithubEl) {
                var ghLabel = androidApk.github.version ? ("v" + androidApk.github.version) : androidApk.github.fileName;
                if (typeof androidApk.github.size === "number") ghLabel += " · " + formatBytes(androidApk.github.size);
                apkGithubEl.textContent = ghLabel;
                apkGithubRow.classList.remove("hidden");
                if (apkGithubBtn) {
                  apkGithubBtn.textContent = "下载安装";
                  apkGithubBtn.classList.remove("hidden");
                  apkGithubBtn.onclick = function() {
                    try {
                      WandNative.downloadUpdate(androidApk.github.downloadUrl, androidApk.github.fileName || "wand-update.apk", "github");
                    } catch (e) {
                      alert("调用下载失败: " + e.message);
                    }
                  };
                }
              }
              // 本地版本
              if (androidApk.local && apkLocalRow && apkLocalEl) {
                var lcLabel = androidApk.local.version ? ("v" + androidApk.local.version) : androidApk.local.fileName;
                if (typeof androidApk.local.size === "number") lcLabel += " · " + formatBytes(androidApk.local.size);
                apkLocalEl.textContent = lcLabel;
                apkLocalRow.classList.remove("hidden");
                if (apkLocalBtn) {
                  apkLocalBtn.textContent = "下载安装";
                  apkLocalBtn.classList.remove("hidden");
                  apkLocalBtn.onclick = function() {
                    try {
                      WandNative.downloadUpdate(androidApk.local.downloadUrl, androidApk.local.fileName || "wand-update.apk", "local");
                    } catch (e) {
                      alert("调用下载失败: " + e.message);
                    }
                  };
                }
              }
              // 都没有时
              if (!androidApk.github && !androidApk.local && apkMessageEl) {
                apkMessageEl.textContent = "暂无可用更新";
                apkMessageEl.classList.remove("hidden");
              }
              // Show APK auto-update toggle in APK mode
              var apkAutoRow = document.getElementById("android-auto-update-row");
              var apkAutoHint = document.getElementById("android-auto-update-hint");
              if (apkAutoRow) apkAutoRow.classList.remove("hidden");
              if (apkAutoHint) apkAutoHint.classList.remove("hidden");
            } else {
              // ── 浏览器模式：显示线上版本 + 本地版本 + 下载按钮 ──
              if (androidApk.github && apkGithubRow && apkGithubEl) {
                var ghLabel2 = androidApk.github.version ? ("v" + androidApk.github.version) : androidApk.github.fileName;
                if (typeof androidApk.github.size === "number") ghLabel2 += " · " + formatBytes(androidApk.github.size);
                apkGithubEl.textContent = ghLabel2;
                apkGithubRow.classList.remove("hidden");
                if (apkGithubBtn) {
                  apkGithubBtn.textContent = "下载";
                  apkGithubBtn.classList.remove("hidden");
                  apkGithubBtn.onclick = function() {
                    window.open(androidApk.github.downloadUrl, "_blank");
                  };
                }
              }
              // 本地版本
              if (androidApk.local && apkLocalRow && apkLocalEl) {
                var lcLabel2 = androidApk.local.version ? ("v" + androidApk.local.version) : androidApk.local.fileName;
                if (typeof androidApk.local.size === "number") lcLabel2 += " · " + formatBytes(androidApk.local.size);
                apkLocalEl.textContent = lcLabel2;
                apkLocalRow.classList.remove("hidden");
                if (apkLocalBtn) {
                  apkLocalBtn.textContent = "下载";
                  apkLocalBtn.classList.remove("hidden");
                  apkLocalBtn.onclick = function() {
                    window.open(androidApk.local.downloadUrl, "_self");
                  };
                }
              }
              if (!androidApk.github && !androidApk.local && apkMessageEl) {
                apkMessageEl.textContent = "暂未提供";
                apkMessageEl.classList.remove("hidden");
              }
            }

            // App connect code (encrypted)
            var connectCodeEl = document.getElementById("android-connect-code");
            var connectQrCanvas = document.getElementById("android-connect-qr");
            var connectQrEmpty = document.getElementById("android-connect-qr-empty");
            var connectQrWrap = document.getElementById("android-connect-qr-wrap");
            if (connectCodeEl) {
              connectCodeEl.textContent = "加载中...";
              if (connectQrEmpty) connectQrEmpty.textContent = "生成中…";
              if (connectQrCanvas) connectQrCanvas.style.visibility = "hidden";
              fetch("/api/app-connect-code").then(function(r) { return r.json(); }).then(function(d) {
                if (d.code) {
                  connectCodeEl.textContent = d.code;
                  state.androidConnectCode = d.code;
                  renderConnectQrCode(d.code);
                } else {
                  connectCodeEl.textContent = "生成失败";
                  if (connectQrEmpty) connectQrEmpty.textContent = "生成失败";
                }
              }).catch(function() {
                connectCodeEl.textContent = "获取失败";
                if (connectQrEmpty) connectQrEmpty.textContent = "获取失败";
              });
            }
            if (connectQrWrap && !connectQrWrap.dataset.bound) {
              connectQrWrap.dataset.bound = "1";
              connectQrWrap.addEventListener("click", function() {
                if (state.androidConnectCode) showConnectQrModal(state.androidConnectCode);
              });
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
            var langEl = document.getElementById("cfg-language");
            if (langEl) langEl.value = cfg.language || "";

            var srEl = document.getElementById("cfg-structured-runner");
            if (srEl) srEl.value = cfg.structuredRunner || "cli";

            var inheritEnvEl = document.getElementById("cfg-inherit-env");
            if (inheritEnvEl) inheritEnvEl.checked = cfg.inheritEnv !== false;

            // Default model
            state.configDefaultModel = cfg.defaultModel || "";
            updateSettingsDefaultModelSelect();
            fetchAvailableModels().then(function() {
              updateSettingsDefaultModelSelect();
            }).catch(function() {});

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
              if (!html) html = '<div class="empty-state-compact"><span class="empty-icon">\u2699</span><span>\u6ca1\u6709\u547d\u4ee4\u9884\u8bbe</span><span class="hint">\u5728 config.json \u7684 commandPresets \u4e2d\u914d\u7f6e</span></div>';
              presetsList.innerHTML = html;
            }

            // Card expand defaults
            var cd = cfg.cardDefaults || {};
            var cdEditEl = document.getElementById("cfg-card-edit");
            var cdInlineEl = document.getElementById("cfg-card-inline");
            var cdTerminalEl = document.getElementById("cfg-card-terminal");
            var cdThinkingEl = document.getElementById("cfg-card-thinking");
            var cdToolgroupEl = document.getElementById("cfg-card-toolgroup");
            if (cdEditEl) cdEditEl.checked = cd.editCards === true;
            if (cdInlineEl) cdInlineEl.checked = cd.inlineTools === true;
            if (cdTerminalEl) cdTerminalEl.checked = cd.terminal === true;
            if (cdThinkingEl) cdThinkingEl.checked = cd.thinking === true;
            if (cdToolgroupEl) cdToolgroupEl.checked = cd.toolGroup === true;
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
          language: (document.getElementById("cfg-language") || {}).value || "",
          defaultModel: (document.getElementById("cfg-default-model") || {}).value || "",
          structuredRunner: (document.getElementById("cfg-structured-runner") || {}).value || "cli",
          inheritEnv: (document.getElementById("cfg-inherit-env") || {}).checked !== false,
        };

        var previousDefaultModel = (state.config && state.config.defaultModel) || "";
        var nextDefaultModel = body.defaultModel || "";

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
              msgEl.textContent = data.restartRequired
                ? "配置已保存，部分部署字段（host/port/https/shell）需要重启服务才生效。"
                : "配置已保存。";
              msgEl.style.color = "var(--success)";
            }
            msgEl.classList.remove("hidden");
          }
          if (!data || !data.error) {
            if (state.config) state.config.defaultModel = nextDefaultModel;
            state.configDefaultModel = nextDefaultModel;
            if (nextDefaultModel !== previousDefaultModel) {
              state.chatModel = "";
              try { localStorage.removeItem("wand-chat-model"); } catch (e) {}
              syncComposerModelSelect(getSelectedSession());
            }
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

      function saveDisplaySettings() {
        var msgEl = document.getElementById("display-message");
        if (msgEl) { msgEl.classList.add("hidden"); msgEl.textContent = ""; }

        var body = {
          cardDefaults: {
            editCards: !!(document.getElementById("cfg-card-edit") || {}).checked,
            inlineTools: !!(document.getElementById("cfg-card-inline") || {}).checked,
            terminal: !!(document.getElementById("cfg-card-terminal") || {}).checked,
            thinking: !!(document.getElementById("cfg-card-thinking") || {}).checked,
            toolGroup: !!(document.getElementById("cfg-card-toolgroup") || {}).checked,
          }
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
              msgEl.textContent = "显示设置已保存";
              msgEl.style.color = "var(--success)";
            }
            msgEl.classList.remove("hidden");
          }
          // Update local config so card defaults take effect immediately
          if (!data.error && state.config) {
            state.config.cardDefaults = body.cardDefaults;
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
            msgEl.textContent = data.message || data.error || "\u66f4\u65b0\u5b8c\u6210\u3002";
            msgEl.style.color = data.error ? "var(--error)" : "var(--success)";
            msgEl.classList.remove("hidden");
          }
          if (data.error) {
            updateBtn.disabled = false;
          } else {
            updateBtn.classList.add("hidden");
            // Show restart button
            var restartBtn = document.getElementById("do-restart-button");
            if (restartBtn) restartBtn.classList.remove("hidden");
          }
        })
        .catch(function() {
          if (msgEl) {
            msgEl.textContent = "\u66f4\u65b0\u5931\u8d25\u3002";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
          updateBtn.disabled = false;
        });
      }

      function performSettingsRestart() {
        var restartBtn = document.getElementById("do-restart-button");
        var msgEl = document.getElementById("update-message");
        performRestart(restartBtn, msgEl);
      }

      function checkApkAutoUpdate() {
        fetch("/api/auto-update", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(autoData) {
            if (!autoData.apk) return;
            // Auto-update is enabled, check for APK update
            return fetch("/api/android-apk-update?currentVersion=" + encodeURIComponent(_apkVersion), { credentials: "same-origin" })
              .then(function(res) { return res.json(); })
              .then(function(data) {
                if (!data.updateAvailable || !data.downloadUrl) return;
                try {
                  WandNative.downloadUpdate(data.downloadUrl, data.fileName || "wand-update.apk", data.source || "local");
                } catch (_e) {}
              });
          })
          .catch(function() {});
      }

      function toggleAutoUpdate(type, enabled) {
        var body = {};
        body[type] = enabled;
        fetch("/api/auto-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          // Sync toggle state with server response
          var webToggle = document.getElementById("auto-update-web-toggle");
          var apkToggle = document.getElementById("auto-update-apk-toggle");
          if (webToggle) webToggle.checked = !!data.web;
          if (apkToggle) apkToggle.checked = !!data.apk;
        })
        .catch(function() {
          // Revert toggle on failure
          var toggle = document.getElementById("auto-update-" + type + "-toggle");
          if (toggle) toggle.checked = !enabled;
        });
      }

      // ── Notification Settings Helpers ──

      function _updateAppIconSelection(activeIcon) {
        var opts = document.querySelectorAll(".settings-app-icon-option");
        for (var i = 0; i < opts.length; i++) {
          var isActive = opts[i].getAttribute("data-icon") === activeIcon;
          opts[i].classList.toggle("selected", isActive);
          opts[i].setAttribute("aria-pressed", isActive ? "true" : "false");
        }
      }

      function updateNotificationStatus() {
        var statusEl = document.getElementById("notification-permission-status");
        var requestBtn = document.getElementById("notification-request-btn");
        var resetBtn = document.getElementById("notification-reset-btn");
        var testMsgEl = document.getElementById("notification-test-message");
        if (!statusEl) return;

        // Determine permission state: native bridge or browser API
        var perm = _getNativePermission();
        if (perm === null) {
          // No native bridge — fall back to browser Notification API
          if (typeof Notification === "undefined") {
            statusEl.textContent = "\u4e0d\u652f\u6301";
            statusEl.style.color = "var(--fg-muted)";
            if (requestBtn) requestBtn.classList.add("hidden");
            if (resetBtn) resetBtn.classList.add("hidden");
            return;
          }
          perm = Notification.permission;
        }

        if (perm === "granted") {
          statusEl.textContent = "\u5df2\u6388\u6743 \u2713";
          statusEl.style.color = "var(--success)";
          if (requestBtn) requestBtn.classList.add("hidden");
          if (resetBtn) resetBtn.classList.add("hidden");
        } else if (perm === "denied") {
          statusEl.textContent = "\u5df2\u62d2\u7edd";
          statusEl.style.color = "var(--danger)";
          if (requestBtn) requestBtn.classList.add("hidden");
          if (resetBtn) resetBtn.classList.remove("hidden");
        } else {
          statusEl.textContent = "\u672a\u6388\u6743";
          statusEl.style.color = "var(--warning)";
          if (requestBtn) requestBtn.classList.remove("hidden");
          if (resetBtn) resetBtn.classList.remove("hidden");
        }
      }

      function resetNotificationPermission() {
        var testMsgEl = document.getElementById("notification-test-message");

        // Native bridge path — trigger Android system permission dialog
        if (_hasNativeBridge) {
          // Listen for permission result callback from native
          window._onNativePermissionResult = function(result) {
            updateNotificationStatus();
            if (testMsgEl) {
              if (result === "granted") {
                testMsgEl.textContent = "\u2713 \u5df2\u6388\u6743";
                testMsgEl.style.color = "var(--success)";
              } else {
                testMsgEl.textContent = "\u2717 \u672a\u6388\u6743\uff0c\u8bf7\u5728\u7cfb\u7edf\u8bbe\u7f6e\u4e2d\u5f00\u542f Wand \u7684\u901a\u77e5\u6743\u9650";
                testMsgEl.style.color = "var(--danger)";
              }
              testMsgEl.classList.remove("hidden");
            }
            delete window._onNativePermissionResult;
          };
          try { WandNative.requestPermission(); } catch (_e) {}
          return;
        }

        if (typeof Notification === "undefined") return;

        // Always call requestPermission — this triggers the browser's native
        // permission dialog when allowed. In "default" state it always works.
        // In "denied" state, some browsers (newer Chrome) re-prompt, others don't.
        Notification.requestPermission().then(function(result) {
          updateNotificationStatus();
          if (result === "granted") {
            if (testMsgEl) {
              testMsgEl.textContent = "\u2713 \u5df2\u6388\u6743";
              testMsgEl.style.color = "var(--success)";
              testMsgEl.classList.remove("hidden");
            }
          } else if (result === "denied") {
            // Browser blocked re-prompting — show inline guide with site-settings shortcut
            if (testMsgEl) {
              var origin = location.origin;
              testMsgEl.innerHTML =
                "\u6d4f\u89c8\u5668\u5df2\u62e6\u622a\u6388\u6743\u5f39\u7a97\uff0c\u8bf7\u624b\u52a8\u91cd\u7f6e\uff1a<br>" +
                '<span style="display:inline-flex;align-items:center;gap:4px;margin:4px 0">' +
                  "\u2460 \u70b9\u51fb\u5730\u5740\u680f\u5de6\u4fa7\u7684 " +
                  '<span style="display:inline-flex;align-items:center;justify-content:center;' +
                    "width:16px;height:16px;border-radius:50%;border:1px solid var(--border);" +
                    'font-size:11px;vertical-align:middle">i</span>' +
                  " \u6216\u9501\u56fe\u6807" +
                "</span><br>" +
                "\u2461 \u627e\u5230\u300c\u901a\u77e5\u300d\u2192 \u6539\u4e3a\u300c\u5141\u8bb8\u300d<br>" +
                "\u2462 \u5237\u65b0\u9875\u9762\u5373\u53ef";
              testMsgEl.style.color = "var(--fg-muted)";
              testMsgEl.classList.remove("hidden");
            }
          }
        });
      }

      function resetDelayedNotificationButton() {
        var delayBtn = document.getElementById("notification-test-delay-btn");
        if (!delayBtn) return;
        delayBtn.disabled = false;
        delayBtn.textContent = "10 秒后发送";
      }

      function scheduleTestNotification() {
        var testMsgEl = document.getElementById("notification-test-message");
        if (state.delayedNotificationTimer) {
          clearTimeout(state.delayedNotificationTimer);
          state.delayedNotificationTimer = null;
        }
        var delayBtn = document.getElementById("notification-test-delay-btn");
        if (delayBtn) {
          delayBtn.disabled = true;
          delayBtn.textContent = "已安排（10s）";
        }
        if (testMsgEl) {
          testMsgEl.innerHTML = "已安排 10 秒后发送测试通知，请切到后台等待。";
          testMsgEl.style.color = "var(--text-secondary)";
          testMsgEl.classList.remove("hidden");
        }
        state.delayedNotificationTimer = setTimeout(function() {
          state.delayedNotificationTimer = null;
          resetDelayedNotificationButton();
          testNotification();
        }, 10000);
      }

      function testNotification() {
        var testMsgEl = document.getElementById("notification-test-message");
        var results = [];
        if (state.delayedNotificationTimer) {
          clearTimeout(state.delayedNotificationTimer);
          state.delayedNotificationTimer = null;
          resetDelayedNotificationButton();
        }

        // 1. Test sound playback
        var soundOk = tryPlayNotificationSound();
        results.push(soundOk ? "\u2713 \u63d0\u793a\u97f3" : "\u2717 \u63d0\u793a\u97f3\uff08\u65e0\u6cd5\u64ad\u653e\uff09");

        // 2. Test in-app bubble
        var bubbleEnabled = state.notifBubble;
        showNotificationBubble({
          title: "\u6d4b\u8bd5\u901a\u77e5",
          body: "\u8fd9\u662f\u4e00\u6761\u6d4b\u8bd5\u901a\u77e5\u3002",
          type: "info",
          icon: "\u266a",
          duration: 5000,
          playSound: false, // sound already played above
        });
        results.push(bubbleEnabled ? "\u2713 \u5e94\u7528\u5185\u6c14\u6ce1" : "\u2013 \u5e94\u7528\u5185\u6c14\u6ce1\uff08\u5df2\u5173\u95ed\uff09");

        // 3. Test system notification (native bridge or browser API)
        if (_hasNativeBridge) {
          var nativePerm = _getNativePermission();
          if (nativePerm === "granted") {
            try {
              WandNative.sendNotification("Wand \u6d4b\u8bd5\u901a\u77e5", "\u7cfb\u7edf\u901a\u77e5\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002", "wand-test");
              results.push("\u2713 \u7cfb\u7edf\u901a\u77e5");
            } catch (_e) {
              results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u53d1\u9001\u5931\u8d25\uff09");
            }
          } else if (nativePerm === "denied") {
            results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u62d2\u7edd\uff0c\u8bf7\u5728\u7cfb\u7edf\u8bbe\u7f6e\u4e2d\u5f00\u542f\uff09");
          } else {
            // "default" — request permission, then report
            window._onNativePermissionResult = function(result) {
              updateNotificationStatus();
              if (result === "granted") {
                try {
                  WandNative.sendNotification("Wand \u6d4b\u8bd5\u901a\u77e5", "\u7cfb\u7edf\u901a\u77e5\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002", "wand-test");
                  results.push("\u2713 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u6388\u6743\uff09");
                } catch (_e2) {
                  results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u53d1\u9001\u5931\u8d25\uff09");
                }
              } else {
                results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u672a\u6388\u6743\uff09");
              }
              showTestResults(testMsgEl, results);
              delete window._onNativePermissionResult;
            };
            try { WandNative.requestPermission(); } catch (_e) {}
            return; // async — results shown in callback
          }
          showTestResults(testMsgEl, results);
          return;
        }

        if (typeof Notification === "undefined") {
          results.push("\u2013 \u7cfb\u7edf\u901a\u77e5\uff08\u4e0d\u652f\u6301\uff09");
          showTestResults(testMsgEl, results);
          return;
        }

        var perm = Notification.permission;
        if (perm === "granted") {
          try {
            var n = new Notification("Wand \u6d4b\u8bd5\u901a\u77e5", {
              body: "\u7cfb\u7edf\u901a\u77e5\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002",
              icon: "/favicon.ico",
              tag: "wand-test",
            });
            setTimeout(function() { n.close(); }, 5000);
            results.push("\u2713 \u7cfb\u7edf\u901a\u77e5");
          } catch (_e) {
            results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u53d1\u9001\u5931\u8d25\uff0c\u53ef\u80fd\u9700\u8981 HTTPS\uff09");
          }
          showTestResults(testMsgEl, results);
        } else if (perm === "denied") {
          results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u62d2\u7edd\uff09");
          showTestResults(testMsgEl, results);
        } else {
          // "default" — try requesting
          Notification.requestPermission().then(function(result) {
            updateNotificationStatus();
            if (result === "granted") {
              results.push("\u2713 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u6388\u6743\uff09");
            } else {
              results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u672a\u6388\u6743\uff09");
            }
            showTestResults(testMsgEl, results);
          });
        }
      }

      function showTestResults(el, results) {
        if (!el) return;
        el.innerHTML = results.map(function(r) { return escapeHtml(r); }).join("<br>");
        // color based on whether all passed
        var allOk = results.every(function(r) { return r.indexOf("\u2713") === 0 || r.indexOf("\u2013") === 0; });
        el.style.color = allOk ? "var(--success)" : "var(--warning)";
        el.classList.remove("hidden");
      }

      // 创建 PTY 会话时把当前终端的真实 cols/rows 注入 body，让后端 pty.spawn
      // 直接落在正确尺寸下。否则 PTY 先按 cols=120 启动，Claude/Codex 会基于
      // 120 列输出 \x1b[120G 这类绝对列定位序列；等前端 remeasure 触发 resize
      // 时这些早期内容已经被以 80 等真实列数渲染，整条历史就错位。
      function withTerminalDimensions(body) {
        if (!body || typeof body !== "object") return body;
        if (!state.terminal) return body;
        try {
          if (typeof state.terminal.remeasure === "function") {
            state.terminal.remeasure();
          }
        } catch (e) {}
        var cols = state.terminal.cols;
        var rows = state.terminal.rows;
        if (typeof cols === "number" && typeof rows === "number"
            && Number.isFinite(cols) && Number.isFinite(rows)
            && cols > 0 && rows > 0) {
          body.cols = cols;
          body.rows = rows;
        }
        return body;
      }

      function quickStartSession() {
        var command = getPreferredTool();
        var defaultCwd = getEffectiveCwd();
        var defaultMode = getSafeModeForTool(command, (state.config && state.config.defaultMode) ? state.config.defaultMode : "default");
        state.preferredCommand = command;
        state.chatMode = getSafeModeForTool(command, state.chatMode);
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({ command: command, provider: command, cwd: defaultCwd, mode: defaultMode }))
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
          resetChatRenderCache();
          return refreshAll();
        })
        .then(function() { focusInputBox(true); })
        .catch(function() {
          showToast("无法启动会话。", "error");
        });
      }

      var _sessionCreating = false;

      function runCommand() {
        if (_sessionCreating) return;
        var cwdEl = document.getElementById("cwd");
        var errorEl = document.getElementById("modal-error");
        var command = getPreferredTool();
        var sessionKind = state.sessionCreateKind || "structured";
        var worktreeEnabled = state.sessionCreateWorktree === true;

        hideError(errorEl);

        var defaultCwd = getEffectiveCwd();
        var cwd = cwdEl.value.trim() || defaultCwd;
        var selectedMode = getSafeModeForTool(command, state.modeValue);

        if (sessionKind === "structured") {
          startStructuredSessionFromModal(cwd, selectedMode, worktreeEnabled, errorEl);
          return;
        }

        runPtyCommandFromModal(command, cwd, selectedMode, worktreeEnabled, errorEl);
      }

      function startStructuredSessionFromModal(cwd, mode, worktreeEnabled, errorEl) {
        var provider = state.sessionTool === "codex" ? "codex" : "claude";
        console.log("[WAND] startStructuredSessionFromModal provider:", provider, "cwd:", cwd, "mode:", mode, "worktreeEnabled:", worktreeEnabled);
        _sessionCreating = true;
        state.modeValue = mode;
        state.chatMode = mode;
        state.sessionTool = provider;
        state.preferredCommand = provider;
        syncComposerModeSelect();
        syncComposerModelSelect(getSelectedSession());
        return createStructuredSession(undefined, cwd, mode, worktreeEnabled)
          .then(function(data) {
            saveWorkingDir(cwd);
            closeSessionModal();
            closeSessionsDrawer();
            return data;
          })
          .then(function() { focusInputBox(true); })
          .catch(function(error) {
            showError(errorEl, (error && error.message) || "无法启动结构化会话，请确认 Claude 已正确安装。");
          })
          .finally(function() { _sessionCreating = false; });
      }

      function runPtyCommandFromModal(command, cwd, mode, worktreeEnabled, errorEl) {
        console.log("[WAND] runPtyCommandFromModal command:", command, "cwd:", cwd, "mode:", mode, "worktreeEnabled:", worktreeEnabled);
        _sessionCreating = true;
        state.modeValue = mode;
        state.chatMode = mode;
        state.sessionTool = command;
        state.preferredCommand = command;
        syncComposerModeSelect();

        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: command,
            provider: command,
            cwd: cwd,
            mode: mode,
            worktreeEnabled: worktreeEnabled
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showError(errorEl, data.error);
            return;
          }
          state.selectedId = data.id;
          console.log("[WAND] runPtyCommandFromModal created session:", data.id, "sessionKind:", data.sessionKind, "runner:", data.runner);
          persistSelectedId();
          saveWorkingDir(cwd);
          state.drafts[data.id] = "";
          resetChatRenderCache();
          closeSessionModal();
          closeSessionsDrawer();
          return refreshAll();
        })
        .then(function() {
          if (state.selectedId) {
            console.log("[WAND] runPtyCommandFromModal calling selectSession:", state.selectedId);
            selectSession(state.selectedId);
          } else {
            focusInputBox(true);
          }
        })
        .catch(function() {
          showError(errorEl, command === "codex"
            ? "无法启动 Codex 会话，请确认 codex 已正确安装并可在终端中执行。"
            : "无法启动 Claude 会话，请确认 Claude 已正确安装。");
        })
        .finally(function() { _sessionCreating = false; });
      }

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
        fetchRecentPaths(function(items) {
            var html = "";
            var currentDir = state.workingDir || defaultCwd;
            html += '<div class="blank-chat-cwd-item' + (currentDir === defaultCwd ? " active" : "") + '" data-path="' + escapeHtml(defaultCwd) + '">' +
              '<span class="blank-chat-cwd-item-label">默认</span>' +
              '<span class="blank-chat-cwd-item-path">' + escapeHtml(defaultCwd) + '</span>' +
            '</div>';
            if (items.length) {
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
                var fpInput = document.getElementById("folder-picker-input");
                if (fpInput) fpInput.value = path;
              });
            });
        });
      }

      function loadRecentPathBubbles() {
        var container = document.getElementById("recent-paths-bubbles");
        if (!container) return;
        fetchRecentPaths(function(items) {
            if (!items.length) {
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

      // ── Attachment helpers ──

      var ATTACH_MAX_SIZE = 10 * 1024 * 1024;

      function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
      }

      function isImageType(type) {
        return /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)/.test(type);
      }

      function addPendingAttachment(file) {
        if (!file) return;
        if (file.size > ATTACH_MAX_SIZE) {
          showToast("文件过大（上限 10 MB）: " + file.name, "error");
          return;
        }
        var entry = { file: file, name: file.name, size: file.size, previewUrl: null };
        if (isImageType(file.type)) {
          entry.previewUrl = URL.createObjectURL(file);
        }
        state.pendingAttachments.push(entry);
        renderAttachmentPreview();
      }

      function removePendingAttachment(index) {
        var removed = state.pendingAttachments.splice(index, 1);
        if (removed.length && removed[0].previewUrl) {
          URL.revokeObjectURL(removed[0].previewUrl);
        }
        renderAttachmentPreview();
      }

      function clearAttachments() {
        state.pendingAttachments.forEach(function(a) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        });
        state.pendingAttachments = [];
        renderAttachmentPreview();
      }

      function renderAttachmentPreview() {
        var bar = document.getElementById("attachment-preview");
        if (!bar) return;
        var items = state.pendingAttachments;
        if (items.length === 0) {
          bar.classList.add("hidden");
          bar.innerHTML = "";
          return;
        }
        bar.classList.remove("hidden");
        var html = "";
        for (var i = 0; i < items.length; i++) {
          var a = items[i];
          var thumb = a.previewUrl
            ? '<img src="' + escapeHtml(a.previewUrl) + '" alt="">'
            : '<span class="att-icon">📄</span>';
          html += '<span class="attachment-pill" data-index="' + i + '">' +
            thumb +
            '<span class="att-name" title="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</span>' +
            '<span class="att-size">' + formatFileSize(a.size) + '</span>' +
            '<button class="att-remove" data-index="' + i + '" title="移除">×</button>' +
            '</span>';
        }
        bar.innerHTML = html;
        bar.querySelectorAll(".att-remove").forEach(function(btn) {
          btn.addEventListener("click", function(e) {
            e.preventDefault();
            e.stopPropagation();
            removePendingAttachment(parseInt(btn.getAttribute("data-index"), 10));
          });
        });
      }

      function uploadAttachments(sessionId) {
        if (!state.pendingAttachments.length) return Promise.resolve([]);
        var formData = new FormData();
        state.pendingAttachments.forEach(function(a) {
          formData.append("files", a.file, a.name);
        });
        return fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/upload", {
          method: "POST",
          body: formData,
          credentials: "same-origin"
        }).then(function(resp) {
          if (!resp.ok) return resp.json().then(function(e) { throw new Error(e.error || "上传失败"); });
          return resp.json();
        }).then(function(data) {
          return data.files || [];
        });
      }

      function buildAttachmentPrefix(uploadedFiles) {
        if (!uploadedFiles || !uploadedFiles.length) return "";
        var paths = uploadedFiles.map(function(f) { return f.savedPath; });
        return "[附件已上传，请查看以下文件:\n" + paths.join("\n") + "]\n\n";
      }

      function handleInteractiveTextInput(inputBox) {
        if (!state.terminalInteractive || !inputBox) return false;
        var value = inputBox.value || "";
        if (!value) return false;
        queueDirectInput(value, "interactive_text").catch(function() {});
        inputBox.value = "";
        autoResizeInput(inputBox);
        setDraftValue("", true);
        return true;
      }

      function handleInputPaste(event) {
        var items = event.clipboardData && event.clipboardData.items;
        if (items && !state.terminalInteractive) {
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image/") === 0) {
              event.preventDefault();
              var file = items[i].getAsFile();
              if (file) addPendingAttachment(file);
              return;
            }
          }
        }
        var pasted = event.clipboardData && event.clipboardData.getData("text");
        if (!pasted) return;
        event.preventDefault();
        if (state.terminalInteractive) {
          queueDirectInput(pasted, "paste").catch(function() {});
          return;
        }
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

      var promptOptimizeInFlight = false;
      function optimizePromptText() {
        if (promptOptimizeInFlight) return;
        var inputBox = document.getElementById("input-box");
        var btn = document.getElementById("prompt-optimize-btn");
        var composer = document.querySelector(".input-composer");
        if (!inputBox) return;
        var raw = (inputBox.value || "").trim();
        if (!raw) {
          if (typeof showToast === "function") showToast("请先输入要优化的内容。", "info");
          inputBox.focus();
          return;
        }
        promptOptimizeInFlight = true;
        if (btn) {
          btn.classList.add("is-loading");
          btn.disabled = true;
          btn.setAttribute("title", "正在优化…");
        }
        if (composer) composer.classList.add("is-optimizing");
        inputBox.setAttribute("aria-busy", "true");
        var prevReadOnly = inputBox.readOnly;
        inputBox.readOnly = true;

        var payload = { text: raw };
        if (state && state.selectedId) payload.sessionId = state.selectedId;

        fetch("/api/optimize-prompt", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function(res) {
            return res.json().then(function(data) { return { ok: res.ok, data: data }; });
          })
          .then(function(result) {
            if (!result.ok) throw new Error((result.data && result.data.error) || "提示词优化失败。");
            var optimized = (result.data && result.data.optimized) || "";
            if (!optimized) throw new Error("Claude 返回为空。");
            animateOptimizedReplace(inputBox, optimized);
          })
          .catch(function(error) {
            if (typeof showToast === "function") showToast((error && error.message) || "提示词优化失败。", "error");
            if (btn) {
              btn.classList.remove("is-loading");
              btn.classList.add("is-shake");
              setTimeout(function() { if (btn) btn.classList.remove("is-shake"); }, 400);
            }
          })
          .finally(function() {
            promptOptimizeInFlight = false;
            if (btn) {
              btn.classList.remove("is-loading");
              btn.disabled = false;
              btn.setAttribute("title", "提示词优化（AI）");
            }
            if (composer) composer.classList.remove("is-optimizing");
            inputBox.removeAttribute("aria-busy");
            inputBox.readOnly = prevReadOnly;
          });
      }

      function animateOptimizedReplace(inputBox, finalText) {
        if (!inputBox) return;
        // Typewriter-style fill so user sees the replacement happen
        var chars = Array.from(finalText);
        var total = chars.length;
        if (total === 0) {
          inputBox.value = "";
          setDraftValue("", true);
          autoResizeInput(inputBox);
          return;
        }
        var totalDuration = Math.min(700, Math.max(220, total * 8));
        var stepCount = Math.min(total, 60);
        var charsPerStep = Math.ceil(total / stepCount);
        var stepDelay = totalDuration / stepCount;
        var i = 0;
        inputBox.value = "";
        autoResizeInput(inputBox);
        function tick() {
          i = Math.min(total, i + charsPerStep);
          inputBox.value = chars.slice(0, i).join("");
          autoResizeInput(inputBox);
          if (i < total) {
            setTimeout(tick, stepDelay);
          } else {
            setDraftValue(finalText, true);
            try { inputBox.setSelectionRange(finalText.length, finalText.length); } catch (e) { /* ignore */ }
          }
        }
        tick();
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
        if (isStructuredSession(selectedSession)) {
          return !!(selectedSession.structuredState && selectedSession.structuredState.inFlight);
        }
        return !!selectedSession && selectedSession.status === "running";
      }

      // ── 跨会话排队 ──

      var _queueLaunching = false; // 防止并发 launch

      function hasAnyBusySession() {
        return state.sessions.some(function(s) {
          if (isStructuredSession(s)) {
            return !!(s.structuredState && s.structuredState.inFlight) && !s.archived;
          }
          return s.status === "running" && !s.archived;
        });
      }

      function enqueueCrossSessionMessage(text) {
        if (state.crossSessionQueue.length >= 10) {
          showToast("排队消息已满（最多 10 条），请等待当前会话完成。", "warning");
          return;
        }
        var id = "csq-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        state.crossSessionQueue.push({
          id: id,
          text: text,
          cwd: getEffectiveCwd(),
          mode: state.chatMode || "managed",
          tool: getPreferredTool(),
          queuedAt: Date.now()
        });
        persistCrossSessionQueue();
        renderCrossSessionQueue();
      }

      function launchQueueItem(item) {
        if (_queueLaunching) return;
        _queueLaunching = true;
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: item.tool,
            cwd: item.cwd,
            mode: item.mode,
            initialInput: item.text
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          _queueLaunching = false;
          if (data.error) {
            showToast(data.error, "error");
            // 失败回填队首，不丢消息
            state.crossSessionQueue.unshift(item);
            persistCrossSessionQueue();
            renderCrossSessionQueue();
            return null;
          }
          return activateSession(data);
        })
        .catch(function(error) {
          _queueLaunching = false;
          showToast((error && error.message) || "无法启动排队会话。", "error");
          state.crossSessionQueue.unshift(item);
          persistCrossSessionQueue();
          renderCrossSessionQueue();
        });
      }

      function sendQueueItemNow(queueId) {
        var idx = state.crossSessionQueue.findIndex(function(q) { return q.id === queueId; });
        if (idx < 0) return;
        var item = state.crossSessionQueue.splice(idx, 1)[0];
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        // 立即发送不受 _queueLaunching 限制
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: item.tool,
            cwd: item.cwd,
            mode: item.mode,
            initialInput: item.text
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            state.crossSessionQueue.splice(idx, 0, item);
            persistCrossSessionQueue();
            renderCrossSessionQueue();
            return null;
          }
          return activateSession(data);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动排队会话。", "error");
          state.crossSessionQueue.splice(idx, 0, item);
          persistCrossSessionQueue();
          renderCrossSessionQueue();
        });
      }

      function cancelQueueItem(queueId) {
        var idx = state.crossSessionQueue.findIndex(function(q) { return q.id === queueId; });
        if (idx < 0) return;
        state.crossSessionQueue.splice(idx, 1);
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        if (state.crossSessionQueue.length === 0) {
          showToast("排队已清空。", "info");
        }
      }

      function flushCrossSessionQueue() {
        if (state.crossSessionQueue.length === 0) return;
        if (hasAnyBusySession()) return;
        if (_queueLaunching) return;
        var item = state.crossSessionQueue.shift();
        renderCrossSessionQueue();
        launchQueueItem(item);
      }

      function formatQueueAge(queuedAt) {
        var sec = Math.floor((Date.now() - queuedAt) / 1000);
        if (sec < 60) return sec + "s";
        var min = Math.floor(sec / 60);
        if (min < 60) return min + "m";
        return Math.floor(min / 60) + "h";
      }

      function renderCrossSessionQueue() {
        var container = document.querySelector(".cross-session-queue");
        var inputPanel = document.querySelector(".input-panel");
        var statusBar = document.querySelector(".structured-status-bar");
        var composer = document.querySelector(".input-composer");
        var blankChat = document.getElementById("blank-chat");

        if (state.crossSessionQueue.length === 0) {
          if (container) container.remove();
          persistCrossSessionQueue();
          return;
        }

        // Determine parent: input-panel (session view) or blank-chat (welcome view)
        var isInputPanelVisible = inputPanel && !inputPanel.classList.contains("hidden");
        var parent = isInputPanelVisible ? inputPanel : blankChat;
        // Insert above status bar if present, otherwise above composer
        var insertBefore = isInputPanelVisible ? (statusBar || composer) : null;

        if (!parent) return;

        // If container exists but is in the wrong parent, move it
        if (container && container.parentNode !== parent) {
          container.remove();
          container = null;
        }

        if (!container) {
          container = document.createElement("div");
          container.className = "cross-session-queue";
          if (insertBefore) {
            parent.insertBefore(container, insertBefore);
          } else {
            parent.appendChild(container);
          }
        } else if (isInputPanelVisible && insertBefore && container.nextSibling !== insertBefore) {
          // Ensure queue stays above status bar
          parent.insertBefore(container, insertBefore);
        }

        var total = state.crossSessionQueue.length;
        var items = state.crossSessionQueue.map(function(item, i) {
          var preview = item.text.length > 60 ? item.text.slice(0, 60) + "…" : item.text;
          var age = formatQueueAge(item.queuedAt);
          return '<div class="queue-item" data-queue-id="' + escapeHtml(item.id) + '">' +
            '<span class="queue-item-dot"></span>' +
            '<span class="queue-item-text" title="' + escapeHtml(item.text) + '">' + escapeHtml(preview) + '</span>' +
            '<span class="queue-item-age">' + age + '</span>' +
            '<button class="queue-item-send-now" data-queue-id="' + escapeHtml(item.id) + '" title="立即发送" type="button">发送</button>' +
            '<button class="queue-item-cancel" data-queue-id="' + escapeHtml(item.id) + '" title="取消" type="button">×</button>' +
          '</div>';
        }).join("");

        var header = total > 1
          ? '<div class="queue-header">' +
              '<span class="queue-header-label">排队 ' + total + ' 条</span>' +
              '<button class="queue-header-clear" id="queue-clear-all" type="button" title="清空排队">清空</button>' +
            '</div>'
          : '';

        container.innerHTML = header + items;
      }

      // 定时刷新排队项的等待时间 + 尝试 flush
      setInterval(function() {
        if (state.crossSessionQueue.length > 0) {
          // 只更新 age 文本，不重建整个 DOM
          var ages = document.querySelectorAll(".queue-item-age");
          state.crossSessionQueue.forEach(function(item, i) {
            if (ages[i]) ages[i].textContent = formatQueueAge(item.queuedAt);
          });
          // 尝试 flush 作为保底（防止 ended 事件 flush 失败）
          flushCrossSessionQueue();
        }
      }, 5000);

      // Delegate click events for cross-session queue items
      document.addEventListener("click", function(e) {
        if (e.target.closest("#queue-clear-all")) {
          e.preventDefault();
          state.crossSessionQueue = [];
          persistCrossSessionQueue();
          renderCrossSessionQueue();
          showToast("排队已清空。", "info");
          return;
        }
        var sendNow = e.target.closest(".queue-item-send-now");
        if (sendNow) {
          e.preventDefault();
          sendQueueItemNow(sendNow.dataset.queueId);
          return;
        }
        var cancel = e.target.closest(".queue-item-cancel");
        if (cancel) {
          e.preventDefault();
          cancelQueueItem(cancel.dataset.queueId);
          return;
        }
      });

      // Send message from the welcome screen input
      function welcomeInputSend() {
        var welcomeInput = document.getElementById("welcome-input");
        var value = welcomeInput ? welcomeInput.value.trim() : "";
        if (!value) return;

        // Cross-session queue: if any session is busy, queue instead of creating
        if (hasAnyBusySession()) {
          welcomeInput.value = "";
          enqueueCrossSessionMessage(value);
          showToast("已排队，将在当前会话完成后自动发送。", "info");
          return;
        }

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
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            provider: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value
          }))
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
          resetChatRenderCache();
          updateSessionSnapshot(data);
          updateSessionsList();
          switchToSessionView(data.id);
          subscribeToSession(data.id);
          loadOutput(data.id).then(function() {
            welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
            welcomeInput.disabled = false;
            focusInputBox(true);
          });
        })
        .catch(function(error) {
          showToast((error && error.message) || (preferredTool === "codex"
            ? "无法启动 Codex 会话。"
            : "无法启动 Claude 会话。"), "error");
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

        // No selected session, create a new one (or queue if busy)
        if (value && hasAnyBusySession()) {
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          enqueueCrossSessionMessage(value);
          showToast("已排队，将在当前会话完成后自动发送。", "info");
          return;
        }
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            provider: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value || undefined
          }))
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
          resetChatRenderCache();
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          updateSessionSnapshot(data);
          updateSessionsList();
          switchToSessionView(data.id);
          // Subscribe to new session via WebSocket
          subscribeToSession(data.id);
          return loadOutput(data.id);
        })
        .catch(function(error) {
          showToast((error && error.message) || (preferredTool === "codex"
            ? "无法启动 Codex 会话。"
            : "无法启动 Claude 会话。"), "error");
        });
      }

      function switchToSessionView(sessionId) {
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
        console.log("[WAND] switchToSessionView id:", sessionId, "found:", !!session, "sessionKind:", session && session.sessionKind, "runner:", session && session.runner, "isStructured:", isStructuredSession(session), "currentView:", state.currentView);
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");
        var terminalTitle = document.getElementById("terminal-title");
        var terminalInfo = document.getElementById("terminal-info");
        var sessionSummary = document.querySelector(".session-summary-value");
        var structured = isStructuredSession(session);

        if (blankChat) blankChat.classList.add("hidden");
        if (terminalContainer) {
          terminalContainer.classList.toggle("hidden", structured);
        }
        if (chatContainer) {
          chatContainer.classList.remove("hidden");
        }
        if (stopBtn) stopBtn.classList.remove("hidden");

        if (structured) {
          state.currentView = "chat";
        } else {
          state.currentView = "terminal";
        }

        var title = session ? shortCommand(session.command) : "Wand";
        var info = session ? getSessionStatusLabel(session) : "开始对话";
        if (terminalTitle) terminalTitle.textContent = title;
        if (terminalInfo) terminalInfo.textContent = info;
        if (sessionSummary) sessionSummary.textContent = title;

        if (!structured) {
          if (!state.terminal) initTerminal();
        }
        applyCurrentView();
        focusInputBox(true);
        // Container just flipped from hidden -> visible (or geometry changed
        // because chat/terminal panels swapped). Refit now so the terminal
        // picks up the real cols/rows instead of keeping the stale ones.
        if (!structured) ensureTerminalFit("view-switch", { forceReplay: true });
      }


      function sendInputFromBox() {
        if (state.terminalInteractive) {
          showToast("终端交互模式开启时，请直接在终端中输入。", "info");
          return Promise.resolve();
        }

        var inputBox = document.getElementById("input-box");
        var value = inputBox ? inputBox.value : "";
        var selectedSession = getSelectedSession();
        var hasAttachments = state.pendingAttachments.length > 0;

        if (value || hasAttachments) {
          console.log("[WAND] sendInputFromBox", {
            sessionId: state.selectedId,
            sessionStatus: selectedSession ? selectedSession.status : null,
            sessionKind: selectedSession ? selectedSession.sessionKind : null,
            runner: selectedSession ? selectedSession.runner : null,
            isStructured: isStructuredSession(selectedSession),
            view: state.currentView,
            wsConnected: state.wsConnected,
            terminalInteractive: state.terminalInteractive,
            inputLength: value.length,
            attachments: state.pendingAttachments.length
          });

          var attachUpload = hasAttachments && state.selectedId
            ? uploadAttachments(state.selectedId)
            : Promise.resolve([]);

          return attachUpload.then(function(uploadedFiles) {
            var prefix = buildAttachmentPrefix(uploadedFiles);
            var finalValue = prefix + (value || (uploadedFiles.length ? "请查看附件。" : ""));
            if (uploadedFiles.length) clearAttachments();

            // Clear todo progress bar at the start of a new user turn
            var todoEl = document.getElementById("todo-progress");
            if (todoEl) todoEl.classList.add("hidden");

            if (isStructuredSession(selectedSession)) {
              return postStructuredInput(finalValue, inputBox, selectedSession);
            }

            var submitChunks = getTerminalSubmitChunks(selectedSession, finalValue);
            var isOffline = !state.wsConnected;

            if (isOffline) {
              queueOfflineTerminalChunks(submitChunks);
              if (inputBox) {
                inputBox.value = "";
                autoResizeInput(inputBox);
              }
              setDraftValue("");
              return Promise.resolve();
            }

            return ensureSessionReadyForInput(selectedSession).then(function(readySession) {
              if (!readySession) {
                // ensureSessionReadyForInput / resumeClaudeSessionById 已经在失败路径里
                // 自行 toast，这里不再重复提示，避免叠两条消息。
                return null;
              }
              var submitView = state.currentView;
              if (readySession && readySession.provider === "codex" && state.selectedId !== readySession.id) {
                throw new Error("Codex session changed before input send.");
              }
              return sendTerminalChunks(submitChunks, "enter_text", 30, submitView).then(function() {
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
          }).catch(function(err) {
            showToast("附件上传失败: " + (err.message || err), "error");
            throw err;
          });
        }
        return Promise.resolve();
      }

      // 防止同一会话并发提交（快速双击 / 重复触发）
      var _structuredSubmittingSessions = {};

      function postStructuredInput(input, inputBox, session) {
        console.log("[WAND] postStructuredInput selectedId:", state.selectedId, "input:", input && input.substring(0, 50), "session:", session && { id: session.id, sessionKind: session.sessionKind, runner: session.runner, status: session.status, inFlight: session.structuredState && session.structuredState.inFlight });
        if (!state.selectedId || !input) return Promise.resolve();
        if (!session) {
          showToast("会话不存在，请重新选择或新建会话。", "error");
          return Promise.resolve();
        }
        // 同一会话的上一次提交尚未落地，直接忽略防止重复发送
        if (_structuredSubmittingSessions[session.id]) {
          console.log("[wand] postStructuredInput: duplicate submit ignored for session", session.id);
          return Promise.resolve();
        }

        var isInterrupting = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
        // Immediately render user message with thinking indicator
        var userTurn = { role: "user", content: [{ type: "text", text: input }] };
        var userMsgs = stripRenderOnlyStructuredMessages(Array.isArray(session.messages) ? session.messages.slice() : []);
        userMsgs.push(userTurn);
        var optimisticStructuredState = Object.assign({}, session.structuredState || {}, { inFlight: true });
        updateSessionSnapshot({
          id: session.id,
          status: "running",
          messages: userMsgs,
          structuredState: optimisticStructuredState,
        });
        state.currentMessages = buildMessagesForRender(Object.assign({}, session, {
          status: "running",
          messages: userMsgs,
          structuredState: optimisticStructuredState,
        }), userMsgs);
        updateInputHint("思考中…");
        renderChat(true);

        if (inputBox) {
          inputBox.value = "";
          autoResizeInput(inputBox);
        }
        setDraftValue("");

        // Capture queue epoch before the POST so we can detect whether
        // a newer WS update has already refreshed the queue by the time
        // the HTTP response arrives.
        var epochBeforePost = state.queueEpoch;

        // 给每次发送生成唯一 idempotency key。Android WebView 进程被冻结再恢复
        // 的边界场景下，底层网络栈偶尔会把上次未收到响应的 POST 重发一次（前端
        // JS 拦不住），导致同一条消息被 backend 处理两遍。带上 key 让 backend
        // 在窗口内识别重发并丢弃。
        var idempotencyKey = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));

        // 用 session.id（参数绑定，in-flight 期间不变）而不是 state.selectedId
        // 拼 URL，避免用户切到别的会话后 fetch 落到错误 sessionId。
        _structuredSubmittingSessions[session.id] = true;
        return fetch("/api/structured-sessions/" + session.id + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, interrupt: isInterrupting || undefined, idempotencyKey: idempotencyKey })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return { error: "请求失败" }; }).then(function(payload) {
              var err = new Error((payload && payload.error) || "无法发送结构化消息。");
              err.errorCode = payload && payload.errorCode;
              err.httpStatus = res.status;
              throw err;
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          _structuredSubmittingSessions[session.id] = false;
          if (snapshot && snapshot.error) {
            throw new Error(snapshot.error);
          }
          if (snapshot && snapshot.id) {
            if (state.queueEpoch > epochBeforePost && snapshot.queuedMessages) {
              delete snapshot.queuedMessages;
            }
            updateSessionSnapshot(snapshot);
            // 仅当 snapshot 仍属当前选中会话时才覆盖视图状态，否则只更新底层数据。
            if (snapshot.id === state.selectedId) {
              var refreshedSession = state.sessions.find(function(s) { return s.id === snapshot.id; }) || snapshot;
              state.currentMessages = buildMessagesForRender(refreshedSession, getPreferredMessages(refreshedSession, snapshot.output, false));
              renderChat(true);
              if (isInterrupting) {
                showToast("已中断上一条回复，正在处理新消息…", "info");
              }
            }
          }
        })
        .catch(function(error) {
          _structuredSubmittingSessions[session.id] = false;

          // duplicate_idempotency_key：服务端识别出 WebView 底层重发的副本，
          // 直接拦截不处理。这里**不**回滚乐观更新——第一次的请求实际上已经
          // 被服务端接收并处理（或正在处理），ws 推送会带回真实状态；如果在
          // 这里把 user turn rollback 掉，第一次的 user 消息会从 UI 上消失。
          if (error && error.errorCode === "duplicate_idempotency_key") {
            showToast(error.message || "检测到重复发送，已拦截。", "warning");
            updateInputHint("Enter 发送 · Shift+Enter 换行");
            return;
          }

          // 回滚乐观更新：恢复发送前的 messages（去掉刚加的 userTurn）和 inFlight 状态
          var rollbackMsgs = userMsgs.slice(0, -1);
          updateSessionSnapshot({
            id: session.id,
            status: session.status,
            messages: rollbackMsgs,
            structuredState: Object.assign({}, session.structuredState || {}, { inFlight: false }),
          });
          if (session.id === state.selectedId) {
            state.currentMessages = buildMessagesForRender(
              Object.assign({}, session, { messages: rollbackMsgs, structuredState: Object.assign({}, session.structuredState || {}, { inFlight: false }) }),
              rollbackMsgs
            );
            renderChat(true);
          }
          var message = (error && error.message) || "";
          var isTransientAbort =
            message === "Failed to fetch" ||
            message === "NetworkError when attempting to fetch resource." ||
            message === "Load failed" ||
            /aborted|aborterror|networkerror|failed to fetch/i.test(message);
          if (!isTransientAbort) {
            showToast((error && error.message) || "无法发送结构化消息。", "error");
          }
          updateInputHint("Enter 发送 · Shift+Enter 换行");
        });
      }

      function updateInputHint(text) {
        var hint = document.querySelector(".input-hint");
        if (hint) hint.textContent = text;
      }

      function updateStructuredQueueCounter() {
        var counter = document.getElementById("queue-counter");
        var count = getSelectedStructuredQueuedInputs().length;
        if (counter) {
          counter.textContent = "队列: " + count;
          if (count > 0) {
            counter.classList.remove("hidden");
          } else {
            counter.classList.add("hidden");
          }
        }
      }

      // Append queued user message placeholders to currentMessages so they
      // remain visible across WS updates and re-renders.
      function buildMessagesForRender(session, messages) {
        var sanitized = Array.isArray(messages) ? stripRenderOnlyStructuredMessages(messages) : [];
        var base = Array.isArray(sanitized) ? sanitized.slice() : [];
        if (!session || session.sessionKind !== "structured") {
          return base;
        }
        var queued = getStructuredQueuedInputs(session);
        if (queued && queued.length > 0) {
          // Collect recent user message texts to deduplicate against queued items.
          // A queued message that already appears as a real user turn should not
          // be rendered a second time with the "排队中" badge.
          var existingUserTexts = {};
          for (var ei = base.length - 1; ei >= 0 && Object.keys(existingUserTexts).length < queued.length + 5; ei--) {
            var em = base[ei];
            if (em && em.role === "user" && Array.isArray(em.content)) {
              for (var ej = 0; ej < em.content.length; ej++) {
                if (em.content[ej] && em.content[ej].type === "text" && em.content[ej].text) {
                  existingUserTexts[em.content[ej].text] = (existingUserTexts[em.content[ej].text] || 0) + 1;
                }
              }
            }
          }
          for (var qi = 0; qi < queued.length; qi++) {
            if (existingUserTexts[queued[qi]]) {
              existingUserTexts[queued[qi]]--;
              continue; // Skip — this queued text is already shown as a real message
            }
            base.push({ role: "user", content: [{ type: "text", text: queued[qi], __queued: true }] });
          }
        }
        if (session.structuredState && session.structuredState.inFlight) {
          var last = base[base.length - 1];
          if (!last || last.role !== "assistant") {
            base.push({ role: "assistant", content: [{ type: "text", text: "", __processing: true }] });
          }
        }
        return base;
      }


      function flushStructuredInputQueue() {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        syncStructuredQueueFromSession(session);
        updateStructuredQueueCounter();
      }

      function getInputErrorMessage(error) {
        var selectedSession = getSelectedSession();
        var isCodex = selectedSession && selectedSession.provider === "codex";
        if (error && (error.errorCode === "SESSION_NOT_RUNNING" || error.errorCode === "SESSION_NO_PTY")) {
          return isCodex
            ? "Codex 会话已结束，请新建会话后继续。"
            : "会话已结束；若存在 Claude 历史会话，将在你下次发送消息时自动恢复。";
        }
        if (error && error.errorCode === "SESSION_NOT_FOUND") {
          return "会话不存在，请重新选择或新建会话。";
        }
        return (error && error.message) || (isCodex
          ? "Codex 会话暂不可用，请检查终端视图或新建会话。"
          : "会话暂不可用；若存在 Claude 历史会话，将自动尝试恢复。");
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
        // 只要是 Claude provider + 非运行中 + 有 claudeSessionId，
        // 就允许在用户发送时静默触发恢复。不再要求 messages 里同时
        // 有 user + assistant 文本（slim 列表/截断历史会让该判断失真）。
        return !!(session && session.provider === "claude" && session.status !== "running" && session.claudeSessionId);
      }

      function ensureSessionReadyForInput(session, errorEl) {
        console.log("[WAND] ensureSessionReadyForInput session:", session && { id: session.id, status: session.status, claudeSessionId: session.claudeSessionId, sessionKind: session.sessionKind, runner: session.runner });
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

        // 静默恢复：不再弹 "正在恢复历史会话…" 提示，让用户发送动作看起来无缝。
        return resumeClaudeSessionById(session.claudeSessionId, errorEl).then(function(data) {
          if (!data) return null;
          updateSessionSnapshot(data);
          updateSessionsList();
          subscribeToSession(data.id);
          return loadOutput(data.id).then(function() {
            focusInputBox(true);
            return data;
          });
        });
      }

      function getTerminalSubmitChunks(session, text) {
        // 文本与回车分两个 chunk 发，避免 CLI 的 bracketed paste 检测把末尾
        // \r 并入粘贴内容导致只换行不提交。
        return [text, String.fromCharCode(13)];
      }

      function sendTerminalChunks(chunks, shortcutKey, delayMs, viewOverride) {
        var sequence = Array.isArray(chunks) ? chunks.filter(function(chunk) { return !!chunk; }) : [];
        if (sequence.length === 0) {
          return Promise.resolve();
        }
        var delay = typeof delayMs === "number" ? delayMs : 0;
        return sequence.reduce(function(promise, chunk, index) {
          return promise.then(function() {
            if (index > 0 && delay > 0) {
              return new Promise(function(resolve) {
                setTimeout(resolve, delay);
              }).then(function() {
                return queueDirectInput(chunk, index === sequence.length - 1 ? shortcutKey : undefined, viewOverride);
              });
            }
            return queueDirectInput(chunk, index === sequence.length - 1 ? shortcutKey : undefined, viewOverride);
          });
        }, Promise.resolve());
      }

      // pendingMessages 缓存 ws 离线时的输入，重连后回放。每条带时间戳，
      // flush 时丢弃过期项——离线 >TTL 后回放老按键序列只会让 PTY 错位。
      var PENDING_INPUT_TTL_MS = 5000;
      var PENDING_INPUT_MAX = 100;
      function enqueuePendingInput(input) {
        if (!input) return;
        if (state.pendingMessages.length >= PENDING_INPUT_MAX) {
          state.pendingMessages.shift();
        }
        state.pendingMessages.push({ input: input, at: Date.now() });
      }

      function queueOfflineTerminalChunks(chunks) {
        var sequence = Array.isArray(chunks) ? chunks.filter(function(chunk) { return !!chunk; }) : [];
        sequence.forEach(function(chunk) {
          enqueuePendingInput(chunk);
        });
      }

      function queueDirectInput(input, shortcutKey, viewOverride) {
        if (!input || !state.selectedId) return Promise.resolve();
        state.messageQueue.push(input);
        state.inputQueue = state.inputQueue.then(function() {
          return postInput(input, shortcutKey, viewOverride).finally(function() {
            var idx = state.messageQueue.indexOf(input);
            if (idx > -1) state.messageQueue.splice(idx, 1);
          });
        });
        return state.inputQueue;
      }

      function postInput(input, shortcutKey, viewOverride) {
        if (!state.selectedId) return Promise.resolve();
        // 锁定本次请求归属的 sessionId。fetch 发起后用户可能切到别的会话，
        // 后续 then 回调里直接用 state.selectedId 会误把 A 的响应应用到 B：
        //   - URL 上拼错会话（虽然 fetch 已经求值过 URL，但 markSessionStopped
        //     等 in-flight 引用会读最新值 → 把 B 标为 stopped 但实际是 A 失败）
        //   - response.snapshot 属于 A，被 setCurrentMessages 误覆盖到 B 视图
        // 用 requestSessionId 锁住请求方，渲染相关动作再单独判断 snapshot.id
        // === 当前 state.selectedId 才执行。
        var requestSessionId = state.selectedId;
        var effectiveView = viewOverride || state.currentView;

        // Pre-check: don't send if session is not running
        if (!isSelectedSessionRunning()) {
          // If WebSocket is disconnected, queue for flush on reconnect
          if (!state.wsConnected) {
            enqueuePendingInput(input);
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
          enqueuePendingInput(input);
          console.log("[wand] postInput: WebSocket disconnected, queued message", {
            sessionId: state.selectedId,
            inputLength: input.length
          });
          return Promise.resolve();
        }

        return fetch("/api/sessions/" + requestSessionId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, view: effectiveView, shortcutKey: shortcutKey || undefined })
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
                sessionId: requestSessionId
              });
              // Mark session as stopped for unavailable errors
              if (isSessionUnavailableError(error)) {
                markSessionStopped(requestSessionId, error.sessionStatus || "exited");
              }
              throw error;
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.id) {
            // 底层 sessions 数据按 id 索引，无论是否仍是当前选中都可以
            // 安全更新（不会污染其他会话）。
            updateSessionSnapshot(snapshot);
            // 但 currentMessages / renderChat 是当前视图状态，必须仅当
            // snapshot 仍属当前选中会话时才执行；否则会把 A 的消息列表
            // 渲染到 B 的 chat 视图。
            if (snapshot.id === state.selectedId) {
              if (snapshot.messages && snapshot.messages.length > 0) {
                state.currentMessages = snapshot.messages;
              }
              renderChat(true);
            }
          }
          return snapshot;
        });
      }

      function sendDirectInput(input) {
        return queueDirectInput(input);
      }

      function getSelectedSession() {
        return state.sessions.find(function(session) { return session.id === state.selectedId; }) || null;
      }

      function getTerminalSubmitSequence(session) {
        return session && session.provider === "codex" ? "\n" : String.fromCharCode(13);
      }

      function isTerminalInteractionAvailable() {
        return !!state.selectedId && state.currentView === "terminal";
      }

      // 判断一条带 sessionId 的 ws 消息是否应该被当前 wterm 实例消费。
      // 收敛多处散落的"selectedId 一致 + terminalSessionId 兼容"判断，避免
      // 后续重构时漏改某一处导致旧会话的输出污染当前终端。
      // terminalSessionId 为空（尚未首次 init/切换刚发生）视为可接受任何
      // sessionId —— 这是首条 chunk 触发自我初始化的场景。
      function isCurrentTerminalSession(sessionId) {
        if (!state.terminal || !sessionId) return false;
        if (sessionId !== state.selectedId) return false;
        if (state.terminalSessionId && state.terminalSessionId !== sessionId) return false;
        return true;
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
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var structured = isStructuredSession(selectedSession);
        var isCodex = selectedSession && selectedSession.provider === "codex";
        var isRunning = structured
          ? !!(selectedSession && selectedSession.structuredState && selectedSession.structuredState.inFlight)
          : !!selectedSession && selectedSession.status === "running";
        var composer = document.getElementById("input-box");
        // Update both toggle buttons (topbar and terminal-header)
        var toggles = ["terminal-interactive-toggle-top"];
        toggles.forEach(function(id) {
          var toggle = document.getElementById(id);
          if (toggle) {
            toggle.classList.toggle("active", state.terminalInteractive);
            toggle.classList.toggle("hidden", structured || state.currentView !== "terminal" || !selectedSession);
          }
        });
        // Inline keyboard visibility follows current view
        var inlineKeyboard = document.querySelector(".inline-shortcuts-wrap");
        if (inlineKeyboard) inlineKeyboard.classList.toggle("hidden", structured || state.currentView !== "terminal");
        var expandedRow = document.querySelector(".inline-shortcuts-expanded-row");
        if (expandedRow) expandedRow.classList.toggle("hidden", structured || state.currentView !== "terminal");
        var inputHint = document.querySelector(".input-hint");
        if (inputHint) {
          inputHint.classList.toggle("hidden", structured ? true : state.currentView === "terminal");
          if (!structured && selectedSession) {
            inputHint.textContent = isCodex
              ? "Enter 发送 · chat 为解析视图，terminal 为原始输出"
              : "Enter 发送 · Shift+Enter 换行";
          }
        }
        // 历史会话只要可自动恢复（Claude provider + 有 claudeSessionId），输入框/发送按钮
        // 就保持可用——发送时由 ensureSessionReadyForInput 透明完成恢复。
        var canResumeOnSend = !structured && !isRunning && canAutoResumeSession(selectedSession);
        if (composer) {
          composer.placeholder = getComposerPlaceholder(selectedSession, state.terminalInteractive);
          composer.disabled = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
          composer.setAttribute("aria-disabled", composer.disabled ? "true" : "false");
          // 终端交互模式下按键由 document capture phase 透传到 PTY；用
          // readOnly 而非 disabled 防止 IME 组合输入等边界场景下字符同时
          // 落到 textarea，又保留 focus 能力。
          composer.readOnly = !!state.terminalInteractive;
          composer.classList.toggle("is-terminal-passthrough", !!state.terminalInteractive);
        }
        var sendBtn = document.getElementById("send-input-button");
        if (sendBtn) {
          sendBtn.disabled = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
          sendBtn.setAttribute("title", structured
            ? "发送"
            : (isCodex ? (isRunning ? "发送给 Codex" : "Codex 会话已结束") : (!selectedSession || isRunning || canResumeOnSend ? "发送" : "会话已结束")));
        }
        var container = document.getElementById("output");
        if (container) container.classList.toggle("interactive", !structured && state.terminalInteractive);
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
        scheduleShortcutResync();
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
          scheduleShortcutResync();
          return;
        }
        var sequence = buildPtySequence(key, { ctrl: state.modifiers.ctrl, alt: state.modifiers.alt, shift: false });
        if (sequence) sendTerminalSequence(sequence, key);
        clearModifiers();
        updateKeyboardPopupUI();
        scheduleShortcutResync();
      }

      // 快捷键点击后做一次延迟 resync 兜底：maybeScheduleResyncForChunk 偶尔会漏
      // 抓 Codex 菜单切换之类的原地重绘，导致 DOM 行残留。500ms 是为了等服务端把
      // 本次按键的回执完整推过来，避免 resync 只回放到 chunk 一半。
      function scheduleShortcutResync() {
        if (!state.terminal) return;
        scheduleSoftResyncTerminal(500);
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

        var selectedSession = getSelectedSession();
        if (isStructuredSession(selectedSession)) {
          state.pendingMessages = [];
          return;
        }

        // Send queued messages in order, bypassing the session-running check
        // since our local state may be stale right after reconnect
        var now = Date.now();
        var queue = [];
        var dropped = 0;
        state.pendingMessages.forEach(function(item) {
          // Backward-compatible: 老逻辑里 entries 可能是裸字符串。
          if (typeof item === "string") { queue.push(item); return; }
          if (!item || typeof item.input !== "string") return;
          if (now - (item.at || 0) > PENDING_INPUT_TTL_MS) { dropped++; return; }
          queue.push(item.input);
        });
        state.pendingMessages = [];
        if (dropped > 0) {
          console.log("[wand] flushPendingMessages: dropped " + dropped + " stale input(s)");
        }

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
        // 同 postInput：flushPendingMessages 重连后批量回放离线消息时，
        // 用户可能已在切到别的会话，必须用本次请求的 sessionId 快照。
        var requestSessionId = state.selectedId;
        return fetch("/api/sessions/" + requestSessionId + "/input", {
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
                  sessionId: requestSessionId,
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
            // 仅当 snapshot 仍属当前选中会话时才覆盖视图，否则只更新底层数据。
            if (snapshot.id === state.selectedId) {
              if (snapshot.messages && snapshot.messages.length > 0) {
                state.currentMessages = snapshot.messages;
              }
              renderChat(true);
            }
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
        var modelPref = state.chatModel || (state.config && state.config.defaultModel) || "";
        return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: command,
            cwd: cwd || "",
            mode: state.chatMode || state.config.defaultMode || "default",
            model: modelPref || undefined
          }))
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

      var _resumeInProgress = false;

      function resumeSession(sessionId, errorEl) {
        console.log("[WAND] resumeSession sessionId:", sessionId);
        if (!sessionId || _resumeInProgress) return Promise.resolve(null);
        _resumeInProgress = true;
        return fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            mode: state.chatMode || state.config.defaultMode || "default"
          }))
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
        })
        .finally(function() { _resumeInProgress = false; });
      }

      function resumeClaudeSessionById(claudeSessionId, errorEl) {
        if (!claudeSessionId) return Promise.resolve(null);
        return fetch("/api/claude-sessions/" + encodeURIComponent(claudeSessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            mode: state.chatMode || state.config.defaultMode || "default"
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            else showToast(data.error, "error");
            return null;
          }
          state.claudeHistory = state.claudeHistory.filter(function(s) {
            return s.claudeSessionId !== claudeSessionId;
          });
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
        state.selectedId = data.id;
        persistSelectedId();
        state.currentMessages = [];
        teardownTerminal();
        resetChatRenderCache();
        switchToSessionView(data.id);
        updateSessionSnapshot(data);
        updateSessionsList();
        subscribeToSession(data.id);
        return loadOutput(data.id).then(function() {
          focusInputBox(true);
        });
      }

      function resumeSessionFromList(sessionId) {
        console.log("[WAND] resumeSessionFromList sessionId:", sessionId);
        return resumeSession(sessionId).then(function(data) {
          if (!data) return null;
          if (data.claudeSessionId) {
            state.claudeHistory = state.claudeHistory.filter(function(s) {
              return s.claudeSessionId !== data.claudeSessionId;
            });
          }
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
        var modelPref = state.chatModel || (state.config && state.config.defaultModel) || "";
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value,
            model: modelPref || undefined
          }))
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
        var modelPref = state.chatModel || (state.config && state.config.defaultModel) || "";
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value || undefined,
            model: modelPref || undefined
          }))
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
        console.log("[WAND] handleResumeAction sessionId:", actionButton.dataset.sessionId);
        actionButton.disabled = true;
        resumeSessionFromList(actionButton.dataset.sessionId)
          .finally(function() {
            actionButton.disabled = false;
          });
      }

      function handleResumeHistoryAction(actionButton) {
        var claudeSessionId = actionButton.dataset.claudeSessionId;
        var cwd = actionButton.dataset.cwd;
        console.log("[WAND] handleResumeHistoryAction claudeSessionId:", claudeSessionId, "cwd:", cwd);
        if (!claudeSessionId) return;
        actionButton.disabled = true;
        resumeClaudeHistorySession(claudeSessionId, cwd)
          .then(function(data) {
            if (data && data.id) {
              state.claudeHistory = state.claudeHistory.filter(function(s) {
                return s.claudeSessionId !== claudeSessionId;
              });
              state.selectedId = data.id;
              persistSelectedId();
              state.drafts[data.id] = "";
              activateSession(data).then(function() {
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
          body: JSON.stringify(withTerminalDimensions({
            mode: state.chatMode || (state.config && state.config.defaultMode) || "default",
            cwd: cwd
          }))
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
        // 键盘空间通过 syncAppViewportHeight 让 body 跟随 visualViewport 收缩处理；
        // 这里清掉历史遗留的 --keyboard-offset 避免双重补偿。
        var inputPanel = document.querySelector('.input-panel');
        if (!inputPanel) return;
        inputPanel.style.removeProperty('--keyboard-offset');
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
        setTimeout(function() {
          window.scrollTo(0, 0);
          // On mobile, force terminal refit + scroll after keyboard dismissal.
          // The container height restores but terminal needs time to
          // fill the expanded space, and the scroll position needs resetting.
          if (isTouchDevice()) {
            ensureTerminalFit("keyboard-blur", { forceReplay: true });
            maybeScrollTerminalToBottom("force");
          }
        }, 100);
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
        if (state.terminalInteractive) {
          focusTerminalContainer();
          return;
        }
        var inputBox = document.getElementById('input-box');
        if (!inputBox || !state.selectedId || document.activeElement === inputBox) return;
        focusInputWithSelection(inputBox);
      }

      function focusTerminalContainer() {
        var output = document.getElementById("output");
        if (!output) return;
        output.setAttribute("tabindex", "0");
        output.focus();
        if (state.terminal && state.terminal.focus) {
          state.terminal.focus();
        }
      }

      // Mobile keyboard handling
      function setupMobileKeyboardHandlers() {
        var inputPanel = document.querySelector('.input-panel');
        var chatMessages = document.querySelector('.chat-messages');
        var terminalContainer = document.querySelector('.terminal-container');

        // Virtual Keyboard API (Chrome/Edge)
        // 不再给 input-panel 直接 setPaddingBottom——新方案通过
        // syncAppViewportHeight 让 body 跟随可见视口收缩，input-panel
        // 自然上移。这里只把事件留作未来钩子，避免和新方案双重补偿。
        if ('virtualKeyboard' in navigator) {
          var vk = navigator.virtualKeyboard;
          vk.addEventListener('geometrychange', function() {
            if (!inputPanel) return;
            inputPanel.style.removeProperty('padding-bottom');
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

      // 把 body / .app-container 的高度从 100dvh 切换为可见视口高度，
      // 这样键盘弹起时整个 flex column 自动收缩，input-panel 跟着上移到
      // 键盘上沿。Android targetSdk 36 在 edge-to-edge 默认开启时，
      // adjustResize 不再自动 resize WebView 内容；同时仅给 input-panel
      // 加 padding-bottom 只是把 panel 内部底部撑空，并不会让 panel 自身
      // 上移。这里通过 CSS 变量驱动整层高度，是跨 WebView/Chrome/PWA 的
      // 统一兜底。仅在视口比窗口明显变小时（典型 = 软键盘弹起）覆盖，
      // 桌面与无键盘场景维持 100dvh 不抖。
      function syncAppViewportHeight() {
        var vv = window.visualViewport;
        if (!vv) return;
        var diff = window.innerHeight - vv.height - vv.offsetTop;
        var root = document.documentElement;
        if (diff > 50) {
          root.style.setProperty('--app-viewport-height', vv.height + 'px');
        } else {
          root.style.removeProperty('--app-viewport-height');
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

          // 键盘开/关与视口尺寸变化时同步 --app-viewport-height，
          // 让 body 高度跟随可见区域，input-panel 自然贴键盘上沿。
          syncAppViewportHeight();

          if (isKeyboardOpen && (!keyboardOpen || heightChanged) && shouldAdjustForKeyboard(vv, inputBox)) {
            syncInputBoxScroll(inputBox);
          }

          // Keyboard just opened — terminal viewport now shares space with
          // the keyboard; visible rows shrink even if cols stayed the same.
          // Without an immediate refit, any chunk arriving while the keyboard
          // animates in renders against the old grid and tears the screen.
          if (!keyboardOpen && isKeyboardOpen) {
            ensureTerminalFit("keyboard-open", { forceReplay: true });
          }

          // Keyboard just closed — force terminal refit and scroll to bottom
          // after a delay so the keyboard dismiss animation and layout settle.
          if (keyboardOpen && !isKeyboardOpen) {
            setTimeout(function() {
              ensureTerminalFit("keyboard-close", { forceReplay: true });
              maybeScrollTerminalToBottom("force");
            }, 200);
          }

          // visualViewport height changed without a keyboard transition —
          // covers iOS address-bar collapse/expand and split-screen drag.
          // Cheap to call: ensureTerminalFit early-exits if cols/rows stable.
          if (heightChanged && keyboardOpen === isKeyboardOpen) {
            ensureTerminalFit("viewport");
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
        // Also listen to scroll — on iOS, keyboard dismiss sometimes only
        // fires a scroll event (viewport scrolls back) without a resize event.
        vv.addEventListener('scroll', debouncedUpdate);

        updateViewport();
      }

      function initTerminalResizeHandle() {
        // 终端容器拖动调整大小功能
        var container = document.getElementById("output");
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
        var lastKnownDesktop = !isMobileLayout();
        state.resizeHandler = function() {
          scheduleTerminalResize(true);
          // Handle sidebar pin state across mobile/desktop breakpoint
          var isDesktop = !isMobileLayout();
          if (lastKnownDesktop !== isDesktop) {
            lastKnownDesktop = isDesktop;
            if (!isDesktop && state.sidebarPinned && state.sessionsDrawerOpen) {
              state.sessionsDrawerOpen = false;
              updateDrawerState();
            } else if (isDesktop && state.sidebarPinned && !state.sessionsDrawerOpen) {
              state.sessionsDrawerOpen = true;
              updateDrawerState();
            }
          }
        };
        window.addEventListener("resize", state.resizeHandler);
        // Also listen to visualViewport resize for pinch-zoom / browser zoom
        if (window.visualViewport) {
          state.visualViewportHandler = function() { scheduleTerminalResize(true); };
          window.visualViewport.addEventListener("resize", state.visualViewportHandler);
        }
        // Page returning from background: container dimensions may have
        // drifted (PWA standalone, tab switch, iOS address-bar toggle).
        state.visibilityHandler = function() {
          if (!document.hidden) ensureTerminalFit("visibility", { forceReplay: true });
        };
        document.addEventListener("visibilitychange", state.visibilityHandler);
        // Mobile device rotation — large geometry change.
        state.orientationHandler = function() { ensureTerminalFit("orientation", { forceReplay: true }); };
        window.addEventListener("orientationchange", state.orientationHandler);
        requestAnimationFrame(function() { scheduleTerminalResize(true); });
      }

      function startTerminalHealthCheck() {
        if (state.terminalHealthTimer) return;
        state.terminalHealthTimer = setInterval(function() {
          if (!state.terminal || state.currentView !== "terminal" || document.hidden) return;
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (!selectedSession || selectedSession.sessionKind === "structured") return;
          // Lightweight fit every 5s: gated + double-rAF + remeasure.
          ensureTerminalFit("health");
          // Full re-sync every 30s during output pauses — also refits.
          var now = Date.now();
          var chunkPause = state.lastChunkAt > 0 && (now - state.lastChunkAt > 300);
          var resyncDue = (now - state.lastTerminalResyncAt) > 30000;
          if (resyncDue && (chunkPause || selectedSession.status !== "running") && state.terminalOutput) {
            softResyncTerminal();
          }
        }, 5000);
      }

      function stopTerminalHealthCheck() {
        if (state.terminalHealthTimer) {
          clearInterval(state.terminalHealthTimer);
          state.terminalHealthTimer = null;
        }
      }

      function teardownTerminal() {
        stopTerminalHealthCheck();
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
        if (state.visualViewportHandler && window.visualViewport) {
          window.visualViewport.removeEventListener("resize", state.visualViewportHandler);
          state.visualViewportHandler = null;
        }
        if (state.visibilityHandler) {
          document.removeEventListener("visibilitychange", state.visibilityHandler);
          state.visibilityHandler = null;
        }
        if (state.orientationHandler) {
          window.removeEventListener("orientationchange", state.orientationHandler);
          state.orientationHandler = null;
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
        var output = document.getElementById("output");
        if (state.terminalViewportEl) {
          if (state.terminalViewportScrollHandler) {
            state.terminalViewportEl.removeEventListener("scroll", state.terminalViewportScrollHandler);
          }
          if (state.terminalViewportTouchHandler) {
            state.terminalViewportEl.removeEventListener("touchmove", state.terminalViewportTouchHandler);
          }
        }
        if (output) {
          if (state.terminalWheelHandler) {
            output.removeEventListener("wheel", state.terminalWheelHandler);
          }
          if (state.terminalClickHandler) {
            output.removeEventListener("click", state.terminalClickHandler);
          }
        }
        state.terminalViewportEl = null;
        state.terminalViewportScrollHandler = null;
        state.terminalViewportTouchHandler = null;
        state.terminalWheelHandler = null;
        state.terminalClickHandler = null;
        if (state.terminalScrollbarEl && state.terminalScrollbarEl.parentNode) {
          state.terminalScrollbarEl.parentNode.removeChild(state.terminalScrollbarEl);
        }
        state.terminalScrollbarEl = null;
        state.terminalScrollbarThumbEl = null;
        if (state.terminal) {
          state.terminal.destroy();
          state.terminal = null;
        }
        // wterm.destroy() 只把 termWrap.innerHTML 置空，节点本身还挂在
        // #output 上。多次会话切换会让 N 个 .terminal-scroll-wrap 叠在
        // 同一 inset:0 位置；新 init 又 appendChild 一个新 termWrap，
        // 旧节点的 DOM 行虽被清空，但 scroll/层叠状态可能造成跨会话视觉
        // 污染。这里把残留节点彻底移除。
        if (output) {
          var staleWraps = output.querySelectorAll(".terminal-scroll-wrap");
          for (var i = 0; i < staleWraps.length; i++) {
            var wrap = staleWraps[i];
            if (wrap.parentNode === output) output.removeChild(wrap);
          }
        }
        // widePadAnsi 是模块级状态机，跨终端实例时若卡在 esc/csi/string 等
        // 中间态，下一个 wterm 实例的首批字节会被错误归类（首字符被吃成
        // ANSI 序列尾巴）。重建终端前显式复位，避免状态泄漏到新实例。
        resetWideParserState();
        state.terminalSessionId = null;
        state.terminalOutput = "";
        state.terminalAutoFollow = true;
        state.showTerminalJumpToBottom = false;
        updateTerminalJumpToBottomButton();
        // 清理本轮新增的、依赖当前 wterm 实例的模块级 timer 和频次统计。
        // 不清掉的话，旧会话上挂起的 tail timer 在新 wterm 实例上触发会
        // 用 state.terminalOutput 做一次无意义的 resync；resyncStats 计数
        // 跨会话累加也会让告警阈值在新会话立即触发误报。
        if (state.softResyncTimer) {
          clearTimeout(state.softResyncTimer);
          state.softResyncTimer = null;
        }
        if (_resyncChunkTailTimer) {
          clearTimeout(_resyncChunkTailTimer);
          _resyncChunkTailTimer = null;
        }
        _resyncChunkLastAt = 0;
        _resyncStatsWindowStart = 0;
        _resyncStatsCount = 0;
        _resyncLastWarnAt = 0;
      }

      function sendTerminalResize(cols, rows) {
        if (!state.selectedId) return;
        var selectedSess = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (isStructuredSession(selectedSess)) return;
        var nextSize = { cols: cols, rows: rows };
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

      // Unified entry point for re-fitting the wterm grid to its container.
      //
      // wterm's internal ResizeObserver only fires when newCols/newRows
      // actually differ from the current values. So a "soft refresh" path
      // (refresh button, ws-reconnect, view-switch — container size unchanged)
      // never reaches wterm.resize() on its own; we have to drive replay
      // explicitly via { forceReplay: true }.
      //
      // When cols *do* change in the rAF body, our remeasure() calls
      // wterm.resize() which synchronously fires the onResize callback —
      // and that callback already runs softResyncTerminal({ skipFit: true }).
      // So the rAF body must NOT replay again in that case (would flicker /
      // double-scroll). The two outcomes are mutually exclusive: either
      // remeasure resized and onResize replayed, or cols stayed put and we
      // honor forceReplay.
      function ensureTerminalFit(reason, options) {
        if (!state.terminal) return false;
        var opts = options || {};
        var forceReplay = opts.forceReplay === true;
        var el = document.getElementById("output");
        if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
          // Container has no visible size yet (hidden, mid-transition,
          // pre-keyboard layout frame, Android WebView resume). Defer to
          // the retry loop; without it, a missed fit means PTY chunks keep
          // wrapping at the wrong width until the next external trigger
          // (rotation, keyboard toggle), and content piles at the top.
          ensureTerminalFitWithRetry(reason || "fit-retry", { forceReplay: forceReplay });
          return false;
        }
        var prevCols = state.terminal.cols;
        var prevRows = state.terminal.rows;
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            if (!state.terminal) return;
            if (typeof state.terminal.remeasure === "function") {
              // remeasure → wterm.resize (if cols changed) → onResize →
              // softResyncTerminal({ skipFit: true }). Replay happens there.
              state.terminal.remeasure();
            }
            sendTerminalResize(state.terminal.cols, state.terminal.rows);
            var didResize = state.terminal.cols !== prevCols
                         || state.terminal.rows !== prevRows;
            // Mutex: didResize already replayed via onResize; otherwise the
            // caller may still demand a replay (e.g. ws-reconnect, refresh
            // button — DOM may be stale even at the same cols).
            if (!didResize && forceReplay && state.terminalOutput) {
              softResyncTerminal({ skipFit: true });
            }
            if (state.terminalAutoFollow || isTerminalNearBottom()) {
              maybeScrollTerminalToBottom("resize");
            }
          });
        });
        return true;
      }

      // Same as ensureTerminalFit but spins through requestAnimationFrame /
      // setTimeout up to ~8 frames waiting for a non-zero container size
      // (Android WebView.onResume, keyboard transitions, hidden→visible
      // panel flips). Forwards forceReplay so the caller's intent is
      // preserved when the container finally settles.
      function ensureTerminalFitWithRetry(reason, options) {
        if (!state.terminal) return;
        var opts = options || {};
        var forceReplay = opts.forceReplay !== false; // default true: retry path implies "may be stale"
        var attempts = 0;
        var maxAttempts = 8;
        function tryFit() {
          if (!state.terminal) return;
          var el = document.getElementById("output");
          if (el) {
            // Force a layout flush so offsetWidth reflects the post-resume
            // container size, not a stale 0 from the suspended frame.
            void el.offsetHeight;
          }
          if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
            ensureTerminalFit(reason, { forceReplay: forceReplay });
            return;
          }
          if (++attempts >= maxAttempts) return;
          // Mix rAF and timeout: some Android WebView versions skip rAF
          // during the first frame after resume, so falling back to a
          // 16ms timer guarantees forward progress.
          if (attempts <= 4) {
            requestAnimationFrame(tryFit);
          } else {
            setTimeout(tryFit, 32);
          }
        }
        tryFit();
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
        if (!state.terminal) return;
        var shouldFollow = state.terminalAutoFollow || isTerminalNearBottom();
        if (shouldFollow) {
          maybeScrollTerminalToBottom("resize");
        }
        sendTerminalResize(state.terminal.cols, state.terminal.rows);
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

      // Periodically refresh session time displays (30s)
      setInterval(function() {
        var timeEls = document.querySelectorAll(".session-time");
        if (timeEls.length > 0) scheduleSessionListUpdate();
      }, 30000);

      function cancelWsReconnect() {
        if (state.wsReconnectTimer) {
          clearTimeout(state.wsReconnectTimer);
          state.wsReconnectTimer = null;
        }
      }

      // Drop any in-flight socket and start a new one *now* — used by the
      // Android resume bridge to recover from zombie connections (socket
      // still says OPEN, but the TCP path was torn down by Doze). Skips
      // the backoff timer; the caller has already decided this is urgent.
      function forceReconnectWebSocket(reason) {
        cancelWsReconnect();
        if (state.ws) {
          var stale = state.ws;
          // Detach handlers so the imminent close doesn't trigger another
          // reconnect path while we're already starting a fresh one.
          try { stale.onclose = null; } catch (e) { /* ignore */ }
          try { stale.onerror = null; } catch (e) { /* ignore */ }
          try { stale.close(); } catch (e) { /* ignore */ }
          state.ws = null;
        }
        state.wsConnected = false;
        state.wsReconnectAttempts = 0;
        initWebSocket(reason);
      }

      function scheduleWsReconnect() {
        if (state.wsReconnectTimer) return;
        // Don't burn battery reconnecting while hidden — the resume
        // listener will kick a fresh connect when we're foreground.
        if (document.hidden) return;
        var attempt = state.wsReconnectAttempts || 0;
        // 0.5s, 1s, 2s, 4s, then capped at 8s. Faster than the old
        // fixed 2s on the first retry (matters for transient blips)
        // and bounded so a flapping server doesn't get hammered.
        var delays = [500, 1000, 2000, 4000, 8000];
        var delay = delays[attempt < delays.length ? attempt : delays.length - 1];
        state.wsReconnectAttempts = attempt + 1;
        state.wsReconnectTimer = setTimeout(function() {
          state.wsReconnectTimer = null;
          if (state.config && !state.ws && !document.hidden) {
            initWebSocket("backoff");
          }
        }, delay);
      }

      function initWebSocket(reason) {
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
            // Reset backoff on a successful connect so the next disconnect
            // starts the ladder from 500ms again.
            state.wsReconnectAttempts = 0;
            cancelWsReconnect();
            // Server's per-client output sequence counter restarts on every
            // new socket; clear ours so the first init isn't treated as a gap.
            state.lastSeqBySession = {};
            // Subscribe to current session if any
            subscribeToSession(state.selectedId);
            // Flush pending messages after reconnection
            flushPendingMessages();
            // Re-fit terminal on reconnect — the viewport may have changed
            // while disconnected, so remeasure against real container size
            // rather than sending stale cols/rows from before the disconnect.
            // Use the retry variant: when the reconnect is triggered by
            // Android resume, the WebView container may still be 0×0 for
            // the first 1–2 frames while layout settles.
            ensureTerminalFitWithRetry("ws-reconnect");
          };

          ws.onmessage = function(event) {
            try {
              var msg = JSON.parse(event.data);
              if (msg && msg.type === "resync_required" && msg.sessionId) {
                // Server dropped some output events under backpressure and
                // is asking us for a fresh snapshot. Send a resync so the
                // server replies with a new init carrying the full output.
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                  try {
                    state.ws.send(JSON.stringify({ type: "resync", sessionId: msg.sessionId }));
                  } catch (sendErr) { /* ignore */ }
                }
                if (!state.lastSeqBySession) state.lastSeqBySession = {};
                state.lastSeqBySession[msg.sessionId] = 0;
                return;
              }
              if (msg && (msg.type === "init" || msg.type === "output") && msg.sessionId && typeof msg.seq === "number") {
                if (!state.lastSeqBySession) state.lastSeqBySession = {};
                var prevSeq = state.lastSeqBySession[msg.sessionId] || 0;
                if (msg.type === "init") {
                  state.lastSeqBySession[msg.sessionId] = msg.seq;
                } else if (msg.seq === prevSeq + 1) {
                  state.lastSeqBySession[msg.sessionId] = msg.seq;
                } else if (msg.seq > prevSeq + 1 && prevSeq > 0) {
                  // We missed at least one event — request a resync and
                  // skip this stale event so we don't apply a partial gap.
                  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    try {
                      state.ws.send(JSON.stringify({ type: "resync", sessionId: msg.sessionId }));
                    } catch (sendErr) { /* ignore */ }
                  }
                  state.lastSeqBySession[msg.sessionId] = 0;
                  return;
                } else {
                  // seq <= prevSeq: duplicate or out-of-order from a stale
                  // queue; drop quietly.
                  if (msg.seq < prevSeq) return;
                  state.lastSeqBySession[msg.sessionId] = msg.seq;
                }
              }
              handleWebSocketMessage(msg);
            } catch (e) {
              // Ignore parse errors
            }
          };

          ws.onclose = function() {
            state.ws = null;
            state.wsConnected = false;
            scheduleWsReconnect();
          };

          ws.onerror = function() {
            ws.close();
          };

          return true;
        } catch (e) {
          // Constructor threw (rare — bad URL, blocked scheme). Try again
          // through the backoff path so we don't get stuck.
          scheduleWsReconnect();
          return false;
        }
      }

      function handleWebSocketMessage(msg) {
        switch (msg.type) {
          case 'output':
            // For structured sessions, output may be "" during streaming — check messages too.
            // thinking → idle 边界自愈：bridge 把 isResponding 透传过来，true→false 时
            // 主动 softResyncTerminal，洗掉流式渲染残留的错位光标定位序列。
            // 120ms 微延迟 + 单 timer 防抖，避免连续 false→true→false 多次重放。
            if (msg.data && msg.sessionId
                && Object.prototype.hasOwnProperty.call(msg.data, 'isResponding')) {
              if (!state._lastIsResponding) state._lastIsResponding = {};
              var _prevResp = !!state._lastIsResponding[msg.sessionId];
              var _nextResp = !!msg.data.isResponding;
              state._lastIsResponding[msg.sessionId] = _nextResp;
              if (_prevResp && !_nextResp
                  && msg.sessionId === state.selectedId
                  && state.terminal
                  && state.terminalOutput) {
                if (state._idleResyncTimer) clearTimeout(state._idleResyncTimer);
                var _idleResyncSid = msg.sessionId;
                state._idleResyncTimer = setTimeout(function() {
                  state._idleResyncTimer = null;
                  if (state.selectedId !== _idleResyncSid) return;
                  try { softResyncTerminal({ skipFit: true }); } catch (e) {}
                }, 120);
              }
            }
            if (msg.data && msg.sessionId) {
              var isIncremental = !!msg.data.incremental;
              var snapshot = { id: msg.sessionId };

              // Carry over small metadata fields present in both modes
              if (!isIncremental && msg.data.output !== undefined) {
                snapshot.output = msg.data.output;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'permissionBlocked')) {
                snapshot.permissionBlocked = !!msg.data.permissionBlocked;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'queuedMessages')) {
                snapshot.queuedMessages = msg.data.queuedMessages || [];
                state.queueEpoch++;
              }
              if (msg.data.structuredState) {
                snapshot.structuredState = msg.data.structuredState;
              }
              if (msg.data.sessionKind) {
                snapshot.sessionKind = msg.data.sessionKind;
              }

              if (isIncremental && msg.data.lastMessage) {
                // Incremental mode: merge lastMessage into existing session messages
                var existingSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
                if (existingSession) {
                  var msgs = Array.isArray(existingSession.messages) ? existingSession.messages.slice() : [];
                  var expectedCount = msg.data.messageCount || 0;
                  // Replace last turn if same role, or append if new turn
                  if (msgs.length > 0 && msg.data.lastMessage.role && msgs[msgs.length - 1].role === msg.data.lastMessage.role) {
                    msgs[msgs.length - 1] = msg.data.lastMessage;
                  } else if (msgs.length < expectedCount) {
                    msgs.push(msg.data.lastMessage);
                  }
                  snapshot.messages = msgs;
                }
              } else if (!isIncremental && msg.data.messages) {
                // Full mode (backward compatible)
                snapshot.messages = msg.data.messages;
              }

              // Fast path: chunk-only incremental events skip expensive chat update
              var isChunkOnly = isIncremental && msg.data.chunk
                && !msg.data.lastMessage && !snapshot.messages
                && snapshot.output === undefined
                && !msg.data.structuredState && !msg.data.sessionKind;

              if (isChunkOnly) {
                // Only update permissionBlocked if it actually changed
                if (msg.data.permissionBlocked !== undefined) {
                  var existingPB = state.sessions.find(function(s) { return s.id === msg.sessionId; });
                  if (existingPB && !!existingPB.permissionBlocked !== !!msg.data.permissionBlocked) {
                    updateSessionSnapshot(snapshot);
                    if (msg.sessionId === state.selectedId) updateTaskDisplay();
                  }
                }
              } else if (snapshot.output !== undefined || snapshot.messages || isIncremental || msg.data.permissionBlocked !== undefined) {
                updateSessionSnapshot(snapshot);
                if (msg.sessionId === state.selectedId) {
                  var updatedSession = state.sessions.find(function(s) { return s.id === msg.sessionId; }) || snapshot;
                  state.currentMessages = buildMessagesForRender(updatedSession, getPreferredMessages(updatedSession, updatedSession.output, false));
                  updateTaskDisplay();
                  // Structured sessions: render immediately for responsiveness
                  if (updatedSession.sessionKind === 'structured' || msg.data.sessionKind === 'structured') {
                    renderChat();
                  } else {
                    scheduleChatRender();
                  }
                }
              }
            }
            // Real-time terminal output
            if (msg.sessionId === state.selectedId && state.terminal && msg.data) {
              if (msg.data.chunk && isCurrentTerminalSession(msg.sessionId)) {
                // Fast path: write chunk directly to avoid full-output comparison.
                state.lastChunkAt = Date.now();
                state.terminalLiveStreamSessions[msg.sessionId] = true;
                // 不再在 hot-path 调 maybeRefitTerminal/remeasure。它会偷偷把
                // wterm 的 this.cols 改成新值，让 wterm 自己的 ResizeObserver
                // 误判 newCols === this.cols 而跳过 wterm.resize() —— 那条路径
                // 才会真正调 Renderer.setup() 重建 DOM 行。绕过它就让容器尺寸
                // 变化的视觉错位无法被自愈，直到用户手动改窗口才修。现在让
                // wterm 内部 ResizeObserver 独占 cols 跟踪职责。
                wandTerminalWrite(state.terminal, msg.data.chunk);
                maybeScheduleResyncForChunk(msg.data.chunk);
                state.terminalSessionId = msg.sessionId;
                if (msg.data.output) {
                  state.terminalOutput = clampClientTerminalOutput(normalizeTerminalOutput(msg.data.output));
                } else {
                  state.terminalOutput = clampClientTerminalOutput((state.terminalOutput || "") + normalizeTerminalOutput(msg.data.chunk));
                }
                maybeScrollTerminalToBottom("output");
                updateTerminalJumpToBottomButton();
              } else if (!msg.data.incremental && Object.prototype.hasOwnProperty.call(msg.data, "output")) {
                // Fallback: no chunk available, use full-output comparison.
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
            if (msg.data && msg.data.structuredState) {
              endedSnapshot.structuredState = msg.data.structuredState;
            }
            if (msg.data && msg.data.queuedMessages) {
              endedSnapshot.queuedMessages = msg.data.queuedMessages;
            }
            updateSessionSnapshot(endedSnapshot);

            if (msg.sessionId === state.selectedId) {
              updateInputHint("Enter 发送 · Shift+Enter 换行");
              // Trigger status bar completion animation
              scheduleChatRender(true);
            }
            // Notify user when a session completes — show what was accomplished
            var endedSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
            var endedExitCode = msg.data && msg.data.exitCode;
            var endedIsError = endedExitCode !== null && endedExitCode !== undefined && endedExitCode !== 0;
            // Build meaningful notification body
            var endedTaskSummary = endedSession ? (endedSession.summary || "") : "";
            var endedLastReply = endedSession ? getLastAssistantSummary(endedSession) : "";
            var endedNotifTitle = endedIsError ? "任务异常结束" : "任务已完成";
            var endedNotifBody = "";
            if (endedTaskSummary) {
              endedNotifBody = endedTaskSummary;
              if (endedLastReply && !endedIsError) {
                endedNotifBody += "\n" + endedLastReply;
              }
            } else {
              endedNotifBody = endedSession ? (endedSession.command || msg.sessionId) : msg.sessionId;
            }
            _vibrate(endedIsError ? "error" : "success");
            notifyTaskEnded(msg.sessionId, endedNotifTitle, endedNotifBody);
            clearSessionProgressNative(msg.sessionId);
            _syncWakeLock();
            if (msg.sessionId !== state.selectedId || document.hidden) {
              showNotificationBubble({
                title: endedNotifTitle,
                body: endedNotifBody,
                type: endedIsError ? "warning" : "success",
                icon: endedIsError ? "!" : "\u2713",
                duration: 6000,
                actionLabel: "\u67e5\u770b",
                action: function() { selectSession(msg.sessionId); }
              });
            }

            // Clear stale queued inputs for PTY sessions.
            // For structured sessions, the queue is now managed by the server snapshot.
            state.messageQueue = [];
            state.pendingMessages = [];

            var endedSessionObj = state.sessions.find(function(s) { return s.id === msg.sessionId; });
            var selectedSessionObj = msg.sessionId === state.selectedId
              ? state.sessions.find(function(s) { return s.id === state.selectedId; })
              : null;
            var isStructuredEnded = !!(
              (endedSessionObj && endedSessionObj.sessionKind === "structured") ||
              (selectedSessionObj && selectedSessionObj.sessionKind === "structured")
            );

            if (isStructuredEnded && msg.sessionId === state.selectedId) {
              flushStructuredInputQueue();
              // 结构化会话结束时也清 localStorage，防止下次加载恢复僵尸队列
              clearStructuredQueuePersistence(msg.sessionId);
            } else if (!isStructuredEnded) {
              state.structuredInputQueue = [];
              clearStructuredQueuePersistence(state.selectedId);
              updateStructuredQueueCounter();
            }

            // Disable terminal interactive mode immediately so the terminal stops
            // capturing keystrokes before loadSessions() completes.
            if (msg.sessionId === state.selectedId) {
              if (!isStructuredEnded) {
                setTerminalInteractive(false);
              }
              state.currentTask = null;
              updateTaskDisplay();
            }

            // Update UI chrome immediately; loadSessions() will refresh the sessions
            // list asynchronously (which may already be in-flight from a poll tick).
            if (msg.sessionId === state.selectedId) {
              updateShellChrome();
            }

            loadSessions().then(function() {
              // After sessions list is refreshed, try to flush cross-session queue
              flushCrossSessionQueue();
            });
            if (msg.sessionId === state.selectedId) {
              if (!isStructuredEnded) {
                loadOutput(msg.sessionId);
              }
            }
            break;
          }
          case 'init':
            // Initial state for subscribed session (after reconnect or subscription)
            if (msg.sessionId === state.selectedId && msg.data) {
              if (chatRenderTimer) { clearTimeout(chatRenderTimer); chatRenderTimer = null; }
              updateSessionSnapshot(msg.data);
              var initSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
              state.currentMessages = buildMessagesForRender(initSession || msg.data, getPreferredMessages(initSession || msg.data, msg.data.output, false));
              renderChat(true);
              updateTaskDisplay();
              updateApprovalStats();
              // 订阅返回的是服务端 ring buffer 最新窗口，与客户端 terminalOutput
              // 可能不连续。强制 replace（reset + 按当前 cols 重写）是订阅时唯一
              // 可信的全量基线，避免 append 的 prefix 检查走错分支。
              updateTerminalOutput(msg.data.output || "", msg.sessionId, "replace");
              // wterm 启动 cols=120，replace 写入可能落在错的列宽上；ResizeObserver
              // 回调异步，用 fit-with-retry 兜一次确保按真实宽度重排。
              ensureTerminalFitWithRetry("init");
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
            notifyTaskProgress(msg.sessionId, msg.data || null);
            syncSessionProgressToNative(msg.sessionId);
            // Update session list to reflect current activity (debounced)
            scheduleSessionListUpdate();
            break;
          case 'status':
            if (msg.sessionId && msg.data) {
              var statusUpdate = { id: msg.sessionId };
              if (Object.prototype.hasOwnProperty.call(msg.data, 'status')) {
                statusUpdate.status = msg.data.status;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'exitCode')) {
                statusUpdate.exitCode = msg.data.exitCode;
              }
              if (msg.data.structuredState) {
                statusUpdate.structuredState = msg.data.structuredState;
              } else if (Object.prototype.hasOwnProperty.call(msg.data, 'status')) {
                var existingSession = state.sessions.find(function(s) { return s.id === msg.sessionId; });
                if (existingSession && existingSession.sessionKind === 'structured') {
                  statusUpdate.structuredState = Object.assign({}, existingSession.structuredState || {}, {
                    inFlight: msg.data.status === 'running'
                  });
                }
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'queuedMessages')) {
                statusUpdate.queuedMessages = msg.data.queuedMessages || [];
                state.queueEpoch++;
              }
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
                var permTaskName = permSession ? (permSession.summary || permSession.command || msg.sessionId) : msg.sessionId;
                var permDetail = msg.data.permissionRequest.prompt || "需要权限审批";
                var permTarget = msg.data.permissionRequest.target;
                var permBody = permTaskName;
                if (permTarget) {
                  permBody += "\n" + permDetail + " · " + permTarget;
                } else {
                  permBody += "\n" + permDetail;
                }
                _vibrate("medium");
                notifyPermissionRequest(msg.sessionId, permBody);
                // In-app bubble if not currently viewing this session
                if (msg.sessionId !== state.selectedId) {
                  showNotificationBubble({
                    title: "需要你的授权",
                    body: permBody,
                    type: "warning",
                    icon: "!",
                    duration: 0,
                    actionLabel: "去处理",
                    action: function() {
                      selectSession(msg.sessionId);
                    }
                  });
                }
              }
              if (msg.data.permissionBlocked === false) {
                statusUpdate.pendingEscalation = null;
              }
              if (msg.data.approvalStats) {
                statusUpdate.approvalStats = msg.data.approvalStats;
              }
              updateSessionSnapshot(statusUpdate);
              syncSessionProgressToNative(msg.sessionId);
              _syncWakeLock();
              if (msg.sessionId === state.selectedId) {
                updateTaskDisplay();
                if (msg.data.approvalStats) {
                  updateApprovalStats();
                }
                // Re-render chat when structured session inFlight state changes
                if (statusUpdate.structuredState) {
                  // Flush queued structured messages synchronously before render
                  // so the chat view uses up-to-date queue state.
                  if (!statusUpdate.structuredState.inFlight) {
                    updateInputHint("Enter 发送 · Shift+Enter 换行");
                    flushStructuredInputQueue();
                  }
                  scheduleChatRender();
                }
              }
            }
            break;
          case 'notification':
            if (msg.data) {
              if (msg.data.kind === "update") {
                notifyUpdateAvailable(msg.data.current || "-", msg.data.latest || "-");
              } else if (msg.data.kind === "auto-update-start") {
                showAutoUpdateOverlay(msg.data.current || "-", msg.data.latest || "-");
              } else if (msg.data.kind === "auto-update-restart") {
                showRestartOverlay();
              } else if (msg.data.kind === "restart") {
                showRestartOverlay();
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
        if (selectedSession && selectedSession.provider === "codex") {
          if (permissionActionsEl) permissionActionsEl.classList.add("hidden");
          taskEl.classList.remove("permission-blocked");
        }
        var pendingEscalation = selectedSession && selectedSession.pendingEscalation ? selectedSession.pendingEscalation : null;
        var isBlocked = selectedSession && selectedSession.provider !== "codex"
          ? (pendingEscalation || selectedSession.permissionBlocked)
          : false;

        if (isBlocked) {
          var isAutoApprove = selectedSession && selectedSession.autoApprovePermissions;
          // Show permission label in input composer area
          if (permissionLabel) {
            if (isAutoApprove) {
              permissionLabel.textContent = "自动批准中...";
            } else if (pendingEscalation) {
              var reason = pendingEscalation.reason || "等待授权";
              var target = pendingEscalation.target ? " · " + pendingEscalation.target : "";
              permissionLabel.textContent = reason + target;
            } else {
              permissionLabel.textContent = "等待授权";
            }
          }
          if (permissionActionsEl) {
            permissionActionsEl.classList.remove("hidden");
            // Hide approve/deny buttons when auto-approve is active
            var approveBtn = document.getElementById("approve-permission-btn");
            var denyBtn = document.getElementById("deny-permission-btn");
            if (approveBtn) approveBtn.classList.toggle("hidden", !!isAutoApprove);
            if (denyBtn) denyBtn.classList.toggle("hidden", !!isAutoApprove);
          }
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

      function updateApprovalStats() {
        var container = document.getElementById("approval-stats");
        if (!container) return;
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var stats = selectedSession && selectedSession.approvalStats;
        if (!stats || stats.total === 0) {
          container.className = "approval-stats hidden";
          container.innerHTML = "";
          return;
        }
        container.className = "approval-stats";
        container.innerHTML =
          '<span class="approval-stats-divider"></span>' +
          '<span class="approval-stats-badge" id="approval-stats-badge" title="本次会话自动批准统计">' +
            '<svg class="approval-stats-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
            '<span class="approval-stats-total">' + stats.total + '</span>' +
          '</span>' +
          '<span class="approval-stats-popup" id="approval-stats-popup">' +
            '<span class="approval-stats-popup-title">自动批准统计</span>' +
            (stats.command > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">⚡</span><span class="approval-stats-row-label">命令执行</span><span class="approval-stats-row-count">' + stats.command + '</span></span>' : '') +
            (stats.file > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">📝</span><span class="approval-stats-row-label">文件写入</span><span class="approval-stats-row-count">' + stats.file + '</span></span>' : '') +
            (stats.tool > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">🔧</span><span class="approval-stats-row-label">其他工具</span><span class="approval-stats-row-count">' + stats.tool + '</span></span>' : '') +
            '<span class="approval-stats-row approval-stats-row-total"><span class="approval-stats-row-icon">∑</span><span class="approval-stats-row-label">合计</span><span class="approval-stats-row-count">' + stats.total + '</span></span>' +
          '</span>';
        // Pulse animation on the badge
        var badge = container.querySelector(".approval-stats-badge");
        if (badge) {
          badge.classList.remove("approval-stats-pulse");
          void badge.offsetWidth;
          badge.classList.add("approval-stats-pulse");
        }
      }

      function approvePermission() {
        _vibrate("light");
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
        _vibrate("light");
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

      function toggleAutoApprove() {
        if (!state.selectedId) return;
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (selectedSession && selectedSession.provider === "codex") {
          showToast("Codex 会话固定以 full-access PTY 启动，不支持切换自动批准。", "info");
          return;
        }
        var toggle = document.getElementById("auto-approve-toggle");
        if (toggle) toggle.style.opacity = "0.5";
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/toggle-auto-approve", {
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
            updateAutoApproveIndicator();
            var enabled = data.autoApprovePermissions;
            showToast(enabled ? "自动批准已开启" : "自动批准已关闭", "info");
          })
          .catch(function(error) {
            showToast((error && error.message) || "无法切换自动批准。", "error");
          })
          .finally(function() {
            if (toggle) toggle.style.opacity = "";
          });
      }

      function updateAutoApproveIndicator() {
        var toggle = document.getElementById("auto-approve-toggle");
        if (!toggle) return;
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (selectedSession && selectedSession.provider === "codex") {
          toggle.className = "auto-approve-indicator active";
          toggle.title = "Codex 固定以 full-access PTY 启动，不支持切换自动批准";
          toggle.textContent = "🛡 Codex 固定全权限";
          return;
        }
        var enabled = selectedSession && selectedSession.autoApprovePermissions;
        if (enabled) {
          toggle.className = "auto-approve-indicator active";
          toggle.title = "自动批准已启用 — 点击关闭";
          toggle.textContent = "🛡 自动批准";
        } else {
          toggle.className = "auto-approve-indicator";
          toggle.title = "自动批准已关闭 — 点击开启";
          toggle.textContent = "🛡 手动";
        }
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
        var selectedSession = getSelectedSession();
        if (selectedSession) {
          state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
        }
        updateTerminalJumpToBottomButton();
        if (state.currentView === "terminal") {
          scheduleTerminalResize(true);
          if (state.terminal && state.terminal.remeasure) {
            requestAnimationFrame(function() {
              if (state.terminal) state.terminal.remeasure();
            });
          }
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
          renderChat();
          return;
        }
        var selectedForDelay = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var isActiveStream = selectedForDelay && selectedForDelay.status === "running"
          && selectedForDelay.sessionKind !== "structured";
        // 活跃流时拉到 LIVE 减少高频重渲；空闲时用 IDLE 快速响应。
        var delay = isActiveStream ? CHAT_RENDER_LIVE_MS : CHAT_RENDER_IDLE_MS;
        chatRenderTimer = setTimeout(function() {
          chatRenderTimer = null;
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (selectedSession) {
              state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
          }
          renderChat();
        }, delay);
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

      function ensureChatMessagesContainer(chatOutput) {
        if (!chatOutput) return null;
        var chatMessages = chatOutput.querySelector(".chat-messages");
        if (chatMessages) return chatMessages;
        chatMessages = document.createElement("div");
        chatMessages.className = "chat-messages";
        chatOutput.appendChild(chatMessages);
        return chatMessages;
      }

      function renderChatEmptyState(chatOutput, html) {
        var chatMessages = ensureChatMessagesContainer(chatOutput);
        if (!chatMessages) return null;
        chatMessages.innerHTML = html;
        bindChatScrollListener();
        updateChatFollowToggleButton();
        updateChatJumpToBottomButton();
        return chatMessages;
      }

      function doRenderChat(forceFullRender) {
        var chatOutput = document.getElementById("chat-output");
        if (!chatOutput) return;

        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSession) {
          if (state.lastRenderedEmpty !== "none") {
            renderChatEmptyState(chatOutput, '<div class="empty-state"><strong>未选择会话</strong><br>点击上方「新对话」开始你的第一次对话。</div>');
            state.lastRenderedEmpty = "none";
            state.lastRenderedMsgCount = 0;
          }
          return;
        }

        var allMessages = state.currentMessages;

        if (allMessages.length === 0) {
          if (state.lastRenderedEmpty !== "empty") {
            renderChatEmptyState(chatOutput, '<div class="empty-state"><strong>对话已开始</strong><br>在下方输入框发送消息，Claude 会自动回复。</div>');
            state.lastRenderedEmpty = "empty";
            state.lastRenderedMsgCount = 0;
          }
          return;
        }

        // Lazy loading: only render the most recent chatRenderedCount messages.
        // Auto-expand when new messages arrive during active streaming to avoid hiding them.
        var totalMsgCount = allMessages.length;
        if (totalMsgCount > state.chatRenderedCount && state.chatAutoFollow) {
          state.chatRenderedCount = totalMsgCount;
        }
        var visibleOffset = Math.max(0, totalMsgCount - state.chatRenderedCount);
        var messages = visibleOffset > 0 ? allMessages.slice(visibleOffset) : allMessages;
        var hasOlderMessages = visibleOffset > 0;

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
          // Even if message content hasn't changed, update the status bar
          // (inFlight state may have changed without new message content)
          var chatMessages = chatOutput.querySelector(".chat-messages");
          if (chatMessages) renderStructuredStatusBar(chatMessages, selectedSession);
          return;
        }
        var prevHash = state.lastRenderedHash;
        var prevMsgCount = state.lastRenderedMsgCount;
        state.lastRenderedMsgCount = msgCount;
        state.lastRenderedHash = outputHash;

        var chatMessages = ensureChatMessagesContainer(chatOutput);
        if (!chatMessages) return;

        var existingCount = chatMessages.querySelectorAll(".chat-message").length;
        // Full render when: forced, no existing messages, or message count decreased/changed
        var needsFullRender = forceRender || existingCount === 0 || msgCount !== existingCount;

        function fullRenderChat() {
          // Extract system info from PTY output
          var systemInfo = extractPtySystemInfo(selectedSession.output, messages);

          // Build HTML with system info cards interleaved
          var html = '';
          var reversedMessages = messages.slice().reverse();
          var visibleCount = messages.length;

          for (var i = 0; i < reversedMessages.length; i++) {
            var msg = reversedMessages[i];
            var localIndex = visibleCount - 1 - i; // Index within visible slice
            var originalIndex = localIndex + visibleOffset; // Index in full messages array

            // Find system info for this message position
            var sysInfo = null;
            for (var j = 0; j < systemInfo.length; j++) {
              if (systemInfo[j].beforeMessage === localIndex) {
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
            html += renderChatMessage(msg, roundUsageByIndex[originalIndex] || null, originalIndex);
          }

          // Add sentinel for loading older messages (DOM end = visual top in column-reverse)
          if (hasOlderMessages) {
            html += '<div class="chat-load-more" id="chat-load-more-sentinel">' +
              '<button class="chat-load-more-btn" type="button">加载更早的 ' + Math.min(state.chatPageSize, visibleOffset) + ' 条消息</button>' +
            '</div>';
          }

          chatMessages.innerHTML = html;
          attachAllCopyHandlers(chatMessages);
          bindChatScrollListener();
          applyPersistedExpandState(chatMessages);
          // Only expand the single newest tool card (first chat-message = newest due to column-reverse)
          var firstMsg = chatMessages.querySelector(".chat-message:not(.system-info)");
          if (firstMsg) {
            var cards = firstMsg.querySelectorAll(".tool-use-card, .inline-diff[data-expand-key]");
            if (cards.length > 0) {
              var firstCard = cards[0];
              var firstCardKey = getElementExpandKey(firstCard);
              if (getPersistedExpandState(firstCardKey) === null) {
                firstCard.classList.remove("collapsed");
              }
              for (var ci = 1; ci < cards.length; ci++) {
                var cardKey = getElementExpandKey(cards[ci]);
                if (getPersistedExpandState(cardKey) === null) {
                  // Never collapse unanswered AskUserQuestion cards
                  if (cards[ci].classList.contains("ask-user") && !cards[ci].classList.contains("ask-user-answered")) continue;
                  cards[ci].classList.add("collapsed");
                }
              }
            }
          }
          // Scroll to bottom (newest message) - column-reverse: scrollTop=0 is visual bottom
          requestAnimationFrame(function() {
            smartScrollToBottom(chatMessages);
            observeLoadMoreSentinel();
          });
        }

        // Collapse all tool-use cards except those in the new message elements (marked with animate-in)
        // newEls: NodeList/Array of newly added message elements, or null to keep only the first card expanded
        function collapseOldToolCards(container, newEls) {
          var allCards = container.querySelectorAll(".tool-use-card, .inline-diff[data-expand-key]");
          allCards.forEach(function(c) {
            var cardKey = getElementExpandKey(c);
            if (getPersistedExpandState(cardKey) !== null) return;
            // Never collapse unanswered AskUserQuestion cards — the user
            // needs to interact with the options.
            if (c.classList.contains("ask-user") && !c.classList.contains("ask-user-answered")) return;
            // Keep expanded if this card is inside a newly added message
            if (newEls) {
              for (var i = 0; i < newEls.length; i++) {
                if (newEls[i].contains(c)) return;
              }
            }
            c.classList.add("collapsed");
          });
        }

        // Pre-compute per-round cumulative usage using original (full array) indices.
        // A "round" starts at a user message and includes all subsequent assistant turns
        // until the next user message. Only the last assistant in each round shows the total.
        var roundUsageByIndex = {};
        (function() {
          var acc = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };
          var lastAssistantIdx = -1;
          for (var mi = 0; mi < allMessages.length; mi++) {
            var m = allMessages[mi];
            if (m.role === "user") {
              if (lastAssistantIdx >= 0 && (acc.inputTokens > 0 || acc.outputTokens > 0 || acc.totalCostUsd > 0)) {
                roundUsageByIndex[lastAssistantIdx] = {
                  inputTokens: acc.inputTokens,
                  outputTokens: acc.outputTokens,
                  cacheReadInputTokens: acc.cacheReadInputTokens,
                  totalCostUsd: acc.totalCostUsd
                };
              }
              acc = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };
              lastAssistantIdx = -1;
            } else if (m.role === "assistant" && m.usage) {
              var u = m.usage;
              acc.inputTokens += (u.inputTokens || 0);
              acc.outputTokens += (u.outputTokens || 0);
              acc.cacheReadInputTokens += (u.cacheReadInputTokens || 0);
              acc.totalCostUsd += (u.totalCostUsd || 0);
              lastAssistantIdx = mi;
            } else if (m.role === "assistant") {
              lastAssistantIdx = mi;
            }
          }
          if (lastAssistantIdx >= 0 && (acc.inputTokens > 0 || acc.outputTokens > 0 || acc.totalCostUsd > 0)) {
            roundUsageByIndex[lastAssistantIdx] = {
              inputTokens: acc.inputTokens,
              outputTokens: acc.outputTokens,
              cacheReadInputTokens: acc.cacheReadInputTokens,
              totalCostUsd: acc.totalCostUsd
            };
          }
        })();

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
            var nmOrigIdx = visibleOffset + existingCount + (newMessages.length - 1 - i);
            div.innerHTML = renderChatMessage(newMessages[i], roundUsageByIndex[nmOrigIdx] || null, nmOrigIdx);
            var el = div.firstElementChild;
            if (el) {
              el.classList.add("animate-in");
              insertedEls.push(el);
              fragment.appendChild(el);
            }
          }
          chatMessages.insertBefore(fragment, chatMessages.firstChild);
          bindChatScrollListener();
          attachAllCopyHandlers(chatMessages);
          applyPersistedExpandState(chatMessages);
          // Collapse all existing cards; new cards (with animate-in) stay expanded
          collapseOldToolCards(chatMessages, insertedEls);
          // Scroll to bottom (newest message) - column-reverse: scrollTop=0 is visual bottom
          requestAnimationFrame(function() {
            smartScrollToBottom(chatMessages);
          });
        } else if (msgCount === existingCount && outputHash !== prevHash) {
          // Same message count but content changed (streaming update).
          // Optimization: only re-render the newest N messages (column-reverse: first children)
          // that actually differ, starting from the top (newest). Most streaming updates only
          // touch the latest assistant turn, so we can skip scanning all older messages.
          var existingEls = Array.from(chatMessages.querySelectorAll(".chat-message"));
          var reversedMessages = messages.slice().reverse();
          var replacedAny = false;
          // Scan from newest (index 0 in reversed) up to MAX_STREAMING_SCAN messages
          var MAX_STREAMING_SCAN = Math.min(4, reversedMessages.length, existingEls.length);
          for (var mi = 0; mi < MAX_STREAMING_SCAN; mi++) {
            var currentEl = existingEls[mi];
            var tmpWrap = document.createElement("div");
            var srOrigIdx = visibleOffset + reversedMessages.length - 1 - mi;
            tmpWrap.innerHTML = renderChatMessage(reversedMessages[mi], roundUsageByIndex[srOrigIdx] || null, srOrigIdx);
            var replacementEl = tmpWrap.firstElementChild;
            if (!replacementEl) continue;
            if (currentEl.innerHTML !== replacementEl.innerHTML || currentEl.className !== replacementEl.className) {
              chatMessages.replaceChild(replacementEl, currentEl);
              attachCopyHandler(replacementEl);
              replacedAny = true;
            } else if (mi > 0) {
              // Once we hit an unchanged older message, stop scanning
              break;
            }
          }
          // Fallback: if hash changed but no visible diff found in the top N messages,
          // the change is deeper — trigger a full render to avoid stale display.
          if (!replacedAny && reversedMessages.length > MAX_STREAMING_SCAN) {
            fullRenderChat();
          }
          if (replacedAny) {
            bindChatScrollListener();
            applyPersistedExpandState(chatMessages);
            requestAnimationFrame(function() {
              smartScrollToBottom(chatMessages);
            });
            var newestMsgEl = chatMessages.querySelector(".chat-message");
            var allCards = chatMessages.querySelectorAll(".tool-use-card, .inline-diff[data-expand-key]");
            var newestCard = null;
            allCards.forEach(function(c) {
              var cardKey = getElementExpandKey(c);
              if (getPersistedExpandState(cardKey) !== null) return;
              // Never collapse unanswered AskUserQuestion cards
              if (c.classList.contains("ask-user") && !c.classList.contains("ask-user-answered")) return;
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

        // Update structured session status bar (in-flight / completed indicator)
        renderStructuredStatusBar(chatMessages, selectedSession);

        // Update todo progress bar from latest messages
        updateTodoProgress(allMessages);
      }

      // Smart scroll: only auto-scroll if user is near bottom
      // column-reverse: scrollTop near 0 = visual bottom (newest messages)
      function smartScrollToBottom(container) {
        if (!state.chatAutoFollow) {
          updateChatJumpToBottomButton();
          return;
        }
        var chatMsgs = (container && container.classList && container.classList.contains("chat-messages"))
          ? container
          : getChatScrollElement();
        if (!chatMsgs || !chatMsgs.isConnected) return;
        scrollChatToBottom(false);
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

        // Sync todo progress to native notification
        if (state.selectedId) {
          syncSessionProgressToNative(state.selectedId);
        }
      }


      function attachCopyHandler(el) {
        el.querySelectorAll(".code-copy").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var codeBlock = btn.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              copyToClipboard(code.textContent || "", null, function() {
                btn.textContent = "Copied!";
                btn.classList.add("copied");
                setTimeout(function() { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
              });
            }
          });
        });
      }

      function attachAllCopyHandlers(container) {
        container.querySelectorAll(".code-copy").forEach(function(btn) {
          var clone = btn.cloneNode(true);
          btn.parentNode.replaceChild(clone, btn);
          clone.addEventListener("click", function() {
            var codeBlock = clone.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              copyToClipboard(code.textContent || "", null, function() {
                clone.textContent = "Copied!";
                clone.classList.add("copied");
                setTimeout(function() { clone.textContent = "Copy"; clone.classList.remove("copied"); }, 2000);
              });
            }
          });
        });
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
            copyToClipboard(text.trim(), null, function() {
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

      function isNoiseLine(line) {
        if (!line) return false;
        var trimmed = String(line).trim();
        if (!trimmed) return false;
        if (trimmed.indexOf("────") === 0) return true;
        if (trimmed === "❯" || trimmed === "›") return true;
        if (/^[╭╰│┌└┐┘├┤┬┴┼─═]{2,}$/.test(trimmed)) return true;
        if (/^[▁▂▃▄▅▆▇█▔▕▏▐]+$/.test(trimmed)) return true;
        if (trimmed.indexOf("esc to interrupt") !== -1) return true;
        if (trimmed.indexOf("Claude Code v") !== -1) return true;
        if (/^Sonnet\b/.test(trimmed)) return true;
        if (trimmed.indexOf("Failed to install Anthropic") !== -1) return true;
        if (trimmed.indexOf("Claude Code has switched") !== -1) return true;
        if (trimmed.indexOf("? for shortcuts") !== -1) return true;
        if (trimmed.indexOf("Claude is waiting") !== -1) return true;
        if (trimmed.indexOf("[wand]") !== -1) return true;
        if (trimmed.indexOf("0;") === 0 || trimmed.indexOf("9;") === 0) return true;
        if (trimmed.indexOf("ctrl+g") !== -1) return true;
        if (trimmed.indexOf("/effort") !== -1) return true;
        if (/^Using .* for .* session/.test(trimmed)) return true;
        if (trimmed.indexOf("Press ") === 0 && trimmed.indexOf(" for") !== -1) return true;
        if (trimmed.indexOf("type ") === 0 && trimmed.indexOf(" to ") !== -1) return true;
        if (trimmed.indexOf("auto mode is unavailable") !== -1) return true;
        if (/MCP server.*failed/i.test(trimmed)) return true;
        if (trimmed.indexOf("Germinating") !== -1 || trimmed.indexOf("Doodling") !== -1 || trimmed.indexOf("Brewing") !== -1) return true;
        if (trimmed.indexOf("Permissions") !== -1 && trimmed.indexOf("mode") !== -1) return true;
        if (trimmed.indexOf("●") === 0 && trimmed.indexOf("·") !== -1) return true;
        if (trimmed.indexOf("[>") === 0 || trimmed.indexOf("[<") === 0) return true;
        if (trimmed.indexOf("Captured Claude session ID") !== -1) return true;
        if (/^>_\s*OpenAI Codex\b/.test(trimmed)) return true;
        if (/^OpenAI Codex\b/i.test(trimmed)) return true;
        if (/^(model|directory):\s+/i.test(trimmed)) return true;
        if (/^(tip|context):\s+/i.test(trimmed)) return true;
        if (/^work(tree|space):\s+/i.test(trimmed)) return true;
        if (/^(approvals?|sandbox|provider|session id):\s+/i.test(trimmed)) return true;
        if (/^(thinking|working)(\.\.\.|…)?$/i.test(trimmed)) return true;
        if (/^[•◦·]\s+Working\b/i.test(trimmed)) return true;
        if (/^[•◦·]\s+(Running|Planning|Applying|Reading|Searching)\b/i.test(trimmed)) return true;
        if (/^[•◦·]\s+(Inspecting|Reviewing|Summarizing|Editing|Updating|Writing)\b/i.test(trimmed)) return true;
        if (/^[•◦·]\s+Completed\b/i.test(trimmed)) return true;
        if (/^(ctrl|enter|tab|shift|esc|alt)\+/i.test(trimmed)) return true;
        if (/\b(open|close|toggle) (chat|terminal)\b/i.test(trimmed)) return true;
        if (/\b(approve|deny)\b.*\b(permission|approval)\b/i.test(trimmed)) return true;
        if (/^(use|press) .* (to|for) .*/i.test(trimmed)) return true;
        if (/^(?:token|context window|remaining context|conversation):\s+/i.test(trimmed)) return true;
        if (/^(?:cwd|path):\s+\//i.test(trimmed)) return true;
        if (/^[<>│┆╎].*[<>│┆╎]$/.test(trimmed) && trimmed.length < 8) return true;
        return false;
      }

      function stripAnsi(text) {
        return String(text || "")
          .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
          .replace(/\x1b\[(\d+)C/g, function(_match, count) { return " ".repeat(Number(count) || 1); })
          .replace(/\x1b\[[0-9;?]*[AB]/g, "\n")
          .replace(/\x1b\[[0-9;?]*[su]/g, "")
          .replace(/\x1b\[[0-9;?]*[HfJKr]/g, "\n")
          .replace(/\x1bM/g, "\n")
          .replace(/\x1b\[[0-9;?]*[ST]/g, "\n")
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
          .replace(/\x1b[><=ePX^_]/g, "")
          .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n");
      }

      function parseMessages(output, command) {
        var messages = [];
        if (!output) return messages;

        var text = String(output || "");
        var newline = String.fromCharCode(10);
        var carriageReturn = String.fromCharCode(13);
        var esc = String.fromCharCode(27);

        if (/^codex\b/.test(String(command || "").trim())) {
          var codexFooterRe = /\bgpt-\d+(?:\.\d+)?(?:\s+[a-z0-9.-]+)?\s+·\s+\d+%\s+left\s+·\s+(?:\/|~\/).+/i;
          var codexActivityRe = /^(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i;

          function stripCodexSegment(raw) {
            return String(raw || "")
              .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
              .replace(/\x1b\[(\d+)C/g, function(_match, count) { return " ".repeat(Number(count) || 1); })
              .replace(/\x1b\[[0-9;?]*[AB]/g, newline)
              .replace(/\x1b\[[0-9;?]*[su]/g, "")
              .replace(/\x1b\[[0-9;?]*[HfJKr]/g, newline)
              .replace(/\x1bM/g, newline)
              .replace(/\x1b\[[0-9;?]*[ST]/g, newline)
              .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
              .replace(/\x1b[><=ePX^_]/g, "")
              .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
              .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
              .replace(/[ \t]+\n/g, newline);
          }

          function normalizeCodexText(value) {
            return String(value || "")
              .replace(/\s+/g, " ")
              .replace(/[M]+$/g, "")
              .trim();
          }

          function normalizeCodexPromptLine(line) {
            return String(line || "")
              .replace(/^›\s*/, "")
              .replace(/^>\s*/, "")
              .trim();
          }

          function shouldIgnoreCodexLine(line) {
            var trimmed = String(line || "").trim();
            if (!trimmed) return true;
            if (isNoiseLine(trimmed)) return true;
            if (codexFooterRe.test(trimmed)) return true;
            if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return true;
            if (/^\[>[0-9;?]*u$/i.test(trimmed)) return true;
            if (/^M+$/i.test(trimmed)) return true;
            if (/^(?:OpenAI Codex|Codex)\b/i.test(trimmed)) return true;
            if (/^(?:tokens?|context window|remaining context|approvals?|sandbox|provider|session id):\s*/i.test(trimmed)) return true;
            if (/^(?:thinking|working)\s*(?:\.\.\.|…)?$/i.test(trimmed)) return true;
            if (/^[•◦·]\s+(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i.test(trimmed)) return true;
            if (/^(?:model|directory|tip|context|cwd|path):\s+/i.test(trimmed)) return true;
            return false;
          }

          function extractCodexPromptCandidate(line) {
            var trimmed = String(line || "").trim();
            if (!/^›(?:\s|$)/.test(trimmed)) return null;
            if (codexFooterRe.test(trimmed)) return null;
            var prompt = normalizeCodexText(normalizeCodexPromptLine(trimmed));
            if (!prompt || shouldIgnoreCodexLine(prompt)) return null;
            return prompt;
          }

          function extractCodexAssistantCandidate(line) {
            var trimmed = String(line || "").trim();
            if (!/^[•◦·⏺]/.test(trimmed)) return null;

            var assistant = trimmed
              .replace(/^[•◦·]\s*/, "")
              .replace(/^⏺\s+/, "")
              .replace(/^│\s*/, "")
              .trim();
            if (!assistant || /^[•◦·⏺]$/.test(assistant)) return null;

            assistant = assistant
              .replace(/\s*\(\d+[smh]?\s*•\s*esc to interrupt\)[\s\S]*$/i, "")
              .replace(/(?:[a-z]{1,6})?›[\s\S]*$/, "")
              .replace(/\s{2,}gpt-\d[\s\S]*$/i, "")
              .replace(/\b(?:OpenAI Codex|model:|directory:|Tip:)\b[\s\S]*$/i, "");
            assistant = normalizeCodexText(assistant);

            if (!assistant || assistant.length < 2 || codexActivityRe.test(assistant) || shouldIgnoreCodexLine(assistant)) {
              return null;
            }
            return assistant;
          }

          function extractCodexEchoCandidate(line) {
            var trimmed = normalizeCodexText(line);
            if (!trimmed || shouldIgnoreCodexLine(trimmed)) return null;
            if (/^[•◦·⏺›]/.test(trimmed)) return null;
            if (/^[\[\]<>0-9;?]+u?$/i.test(trimmed)) return null;
            if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return null;
            if (trimmed.length > 500) return null;
            return trimmed;
          }

          function isLikelyAssistantTailArtifact(longer, shorter) {
            if (longer.indexOf(shorter) !== 0) return false;
            var suffix = longer.slice(shorter.length);
            return /^[a-z]{1,4}$/i.test(suffix);
          }

          function coalesceAssistantLines(lines) {
            var collected = [];
            for (var i = 0; i < lines.length; i++) {
              var normalized = normalizeCodexText(lines[i]);
              if (!normalized || normalized.length < 2 || shouldIgnoreCodexLine(normalized)) continue;

              var previous = collected[collected.length - 1];
              if (!previous) {
                collected.push(normalized);
                continue;
              }
              if (normalized === previous) continue;
              if (normalized.indexOf(previous) === 0) {
                collected[collected.length - 1] = normalized;
                continue;
              }
              if (previous.indexOf(normalized) === 0) {
                if (isLikelyAssistantTailArtifact(previous, normalized)) {
                  collected[collected.length - 1] = normalized;
                }
                continue;
              }
              collected.push(normalized);
            }
            return collected.join(newline).trim();
          }

          function extractVisiblePrompt(lines) {
            for (var i = 0; i < lines.length; i++) {
              var line = String(lines[i] || "").trim();
              if (!line) continue;

              var inlinePrompt = extractCodexPromptCandidate(line);
              if (inlinePrompt) return inlinePrompt;

              if (line === "›") {
                for (var j = i + 1; j < lines.length; j++) {
                  var nextLine = normalizeCodexText(lines[j]);
                  if (!nextLine || codexFooterRe.test(nextLine) || shouldIgnoreCodexLine(nextLine)) continue;
                  return nextLine;
                }
              }
            }
            return null;
          }

          function extractVisibleAssistantLines(lines) {
            var assistantLines = [];
            var collecting = false;

            for (var i = 0; i < lines.length; i++) {
              var line = String(lines[i] || "").trim();
              if (!line) {
                if (collecting) break;
                continue;
              }

              var assistant = extractCodexAssistantCandidate(line);
              if (assistant) {
                assistantLines.push(assistant);
                collecting = true;
                continue;
              }

              if (collecting) {
                if (line === "›" || /^›(?:\s|$)/.test(line) || codexFooterRe.test(line) || shouldIgnoreCodexLine(line)) {
                  break;
                }
                assistantLines.push(normalizeCodexText(line));
              }
            }

            return assistantLines;
          }

          var rawCandidates = [];
          var candidateOrder = 0;
          var rawSegments = text.replace(/\r\n?/g, newline).split(newline);
          for (var rs = 0; rs < rawSegments.length; rs++) {
            var cleanedSegment = stripCodexSegment(rawSegments[rs]);
            var pieces = cleanedSegment.split(newline);
            for (var pi = 0; pi < pieces.length; pi++) {
              var piece = String(pieces[pi] || "").trim();
              if (!piece) continue;

              var promptCandidate = extractCodexPromptCandidate(piece);
              if (promptCandidate) {
                rawCandidates.push({ kind: "user", order: candidateOrder++, text: promptCandidate });
                continue;
              }

              var assistantCandidate = extractCodexAssistantCandidate(piece);
              if (assistantCandidate) {
                rawCandidates.push({ kind: "assistant", order: candidateOrder++, text: assistantCandidate });
                continue;
              }

              var echoCandidate = extractCodexEchoCandidate(piece);
              if (echoCandidate) {
                rawCandidates.push({ kind: "echo", order: candidateOrder++, text: echoCandidate });
              }
            }
          }

          var candidates = rawCandidates.filter(function(candidate, index, list) {
            var previous = list[index - 1];
            return !previous || previous.kind !== candidate.kind || previous.text !== candidate.text;
          });

          var explicitUsers = candidates.filter(function(candidate) { return candidate.kind === "user"; });
          var assistantCandidates = candidates.filter(function(candidate) { return candidate.kind === "assistant"; });
          var echoCandidates = candidates.filter(function(candidate) { return candidate.kind === "echo"; });
          var strippedOutput = stripAnsi(text);
          var strippedLines = strippedOutput.split(newline).map(function(line) { return String(line || "").trimEnd(); });
          var visiblePrompt = extractVisiblePrompt(strippedLines);
          var latestExplicitUser = explicitUsers.length ? explicitUsers[explicitUsers.length - 1] : null;
          var echoedUserCandidates = echoCandidates
            .map(function(candidate) { return candidate.text; })
            .filter(function(value) { return value.length >= 3; });
          var latestEchoUser = null;
          for (var eu = echoedUserCandidates.length - 1; eu >= 0; eu--) {
            if (echoedUserCandidates[eu] !== visiblePrompt) {
              latestEchoUser = echoedUserCandidates[eu];
              break;
            }
          }
          if (!latestEchoUser && echoedUserCandidates.length) {
            latestEchoUser = echoedUserCandidates[echoedUserCandidates.length - 1];
          }

          var currentUser = latestExplicitUser ? latestExplicitUser.text : latestEchoUser;
          var rawAssistantLines = assistantCandidates
            .filter(function(candidate) { return !latestExplicitUser || candidate.order > latestExplicitUser.order; })
            .map(function(candidate) { return candidate.text; });
          var visibleAssistantFallback = [];
          var bulletMatches = strippedOutput.match(/^[ \t]*[•◦·⏺][ \t]*(.+)$/gm) || [];
          for (var bm = 0; bm < bulletMatches.length; bm++) {
            var bulletContent = normalizeCodexText(bulletMatches[bm].replace(/^[ \t]*[•◦·⏺][ \t]*/, ""));
            if (!bulletContent) continue;
            if (codexActivityRe.test(bulletContent)) continue;
            if (codexFooterRe.test(bulletContent)) continue;
            if (/\b(?:OpenAI Codex|model:|directory:|Tip:|esc to interrupt)\b/i.test(bulletContent)) continue;
            visibleAssistantFallback.push(bulletContent);
          }

          var assistantText = coalesceAssistantLines(rawAssistantLines)
            || coalesceAssistantLines(extractVisibleAssistantLines(strippedLines))
            || (visibleAssistantFallback.length ? visibleAssistantFallback[visibleAssistantFallback.length - 1] : null);

          if (currentUser) {
            messages.push({ role: "user", content: currentUser });
          }
          if (assistantText) {
            messages.push({ role: "assistant", content: assistantText });
          }
          if (!messages.length && latestExplicitUser) {
            messages.push({ role: "user", content: latestExplicitUser.text });
          } else if (!messages.length && latestEchoUser) {
            messages.push({ role: "user", content: latestEchoUser });
          }

          return messages;
        }

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

      // ── 像素风猫咪头像 ──
      var PIXEL_AVATAR = (function() {
        var _ = "transparent";
        function buildSvg(grid, size) {
          var s = size || 3;
          var w = grid[0].length * s;
          var h = grid.length * s;
          var rects = "";
          for (var y = 0; y < grid.length; y++) {
            for (var x = 0; x < grid[y].length; x++) {
              if (grid[y][x] !== _) {
                rects += '<rect x="' + (x * s) + '" y="' + (y * s) + '" width="' + s + '" height="' + s + '" fill="' + grid[y][x] + '"/>';
              }
            }
          }
          return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" class="pixel-avatar-svg">' + rects + '</svg>';
        }
        // 加菲猫 (勤劳初二 / AI) — 橙色系
        var o = "#F0923A", d = "#C46A1A", w = "#FFFFFF", k = "#2D2D2D", p = "#F28B9A", n = "#E87D5A";
        var garfield = [
          [_,d,_,_,_,_,_,_,d,_],
          [d,o,d,_,_,_,_,d,o,d],
          [d,o,o,o,o,o,o,o,o,d],
          [o,o,w,k,o,o,w,k,o,o],
          [o,o,w,w,o,o,w,w,o,o],
          [o,o,o,o,p,p,o,o,o,o],
          [o,d,o,n,o,o,n,o,d,o],
          [_,o,o,o,o,o,o,o,o,_],
          [_,_,o,d,o,o,d,o,_,_],
          [_,_,_,o,_,_,o,_,_,_],
        ];
        // 美短 (赛博虎妞 / 用户) — 灰色系
        var g = "#9EAAB8", dg = "#6B7B8D", lg = "#C5CED8", gn = "#7EC88B";
        var shorthair = [
          [_,dg,_,_,_,_,_,_,dg,_],
          [dg,g,dg,_,_,_,_,dg,g,dg],
          [dg,g,g,g,g,g,g,g,g,dg],
          [g,g,w,gn,g,g,w,gn,g,g],
          [g,g,w,w,g,g,w,w,g,g],
          [g,g,g,g,p,p,g,g,g,g],
          [g,dg,g,lg,g,g,lg,g,dg,g],
          [_,g,g,g,g,g,g,g,g,_],
          [_,_,g,dg,g,g,dg,g,_,_],
          [_,_,_,g,_,_,g,_,_,_],
        ];
        return {
          assistant: buildSvg(garfield),
          user: buildSvg(shorthair)
        };
      })();

      var DEFAULT_CHAT_PERSONA = {
        user: {
          name: "赛博虎妞",
          avatarSvg: PIXEL_AVATAR.user
        },
        assistant: {
          name: "勤劳初二",
          avatarSvg: PIXEL_AVATAR.assistant
        }
      };

      function getStructuredChatPersona(role) {
        var configPersona = state.config && state.config.structuredChatPersona;
        var roleConfig = configPersona && configPersona[role] ? configPersona[role] : null;
        var defaults = DEFAULT_CHAT_PERSONA[role] || DEFAULT_CHAT_PERSONA.assistant;
        return {
          name: roleConfig && typeof roleConfig.name === "string" && roleConfig.name.trim()
            ? roleConfig.name.trim()
            : defaults.name,
          avatar: roleConfig && typeof roleConfig.avatar === "string" && roleConfig.avatar.trim()
            ? roleConfig.avatar.trim()
            : null,
          avatarSvg: defaults.avatarSvg
        };
      }

      function renderAvatarFallback(svg) {
        return '<div class="pixel-avatar">' + svg + '</div>';
      }

      function handleChatAvatarImageError(img, role) {
        if (!img || !img.parentNode) return;
        var persona = getStructuredChatPersona(role === "user" ? "user" : "assistant");
        img.outerHTML = renderAvatarFallback(persona.avatarSvg);
      }

      function chatAvatar(role) {
        var personaRole = role === "user" ? "user" : "assistant";
        var persona = getStructuredChatPersona(personaRole);
        var avatarInner = persona.avatar
          ? '<img class="pixel-avatar-image" src="' + escapeHtml(persona.avatar) + '" alt="' + escapeHtml(persona.name) + '" onerror="handleChatAvatarImageError(this, ' + JSON.stringify(personaRole) + ')" />'
          : renderAvatarFallback(persona.avatarSvg);
        return '<div class="chat-message-avatar ' + role + '">' +
          avatarInner +
          '<span class="avatar-name">' + escapeHtml(persona.name) + '</span>' +
        '</div>';
      }

      function renderChatMessage(msg, roundUsage, messageIndex) {
        // Thinking card (deep thought) — from PTY parsing
        if (msg.role === "thinking") {
          var thinkingKey = buildExpandKey("thinking", [getMessageKey(msg, messageIndex), "pty"]);
          var thinkingPersisted = getPersistedExpandState(thinkingKey);
          var thinkingExpanded = thinkingPersisted === null ? getCardDefault("thinking") : thinkingPersisted;
          return '<div class="chat-message thinking">' +
            '<div class="thinking-inline thinking-pty ' + (thinkingExpanded ? 'expanded' : 'collapsed') + '" data-expand-kind="thinking" data-expand-key="' + escapeHtml(thinkingKey) + '" data-thinking="" onclick="__thinkingToggle(this)">' +
              '<span class="thinking-inline-icon">⦿</span>' +
              '<span class="thinking-inline-preview">' + escapeHtml(msg.content) + '</span>' +
              '<span class="thinking-inline-action">' + (thinkingExpanded ? '收起' : '展开') + '</span>' +
            '</div>' +
          '</div>';
        }

        // Prompt suggestion card (pulsing display) — from PTY parsing
        if (msg.role === "prompt") {
          return '<div class="chat-message prompt">' +
            '<div class="prompt-card">' +
              '<div class="prompt-icon">→</div>' +
              '<div class="prompt-content">试试：<span class="prompt-text">' + escapeHtml(msg.content) + '</span></div>' +
            '</div>' +
          '</div>';
        }

        // Structured content blocks (from JSON chat mode)
        if (Array.isArray(msg.content)) {
          return renderStructuredMessage(msg, roundUsage, messageIndex);
        }

        // Legacy string content (from PTY parsing)
        var avatar = chatAvatar(msg.role);
        var bubbleContent = msg.role === "assistant" ? renderMarkdown(msg.content) : escapeHtml(msg.content);
        return '<div class="chat-message ' + msg.role + '">' +
          avatar +
          '<div class="chat-message-bubble">' + bubbleContent + '</div>' +
        '</div>';
      }

      function buildToolResultMap(contentBlocks) {
        var toolResults = {};
        if (!Array.isArray(contentBlocks)) return toolResults;
        for (var i = 0; i < contentBlocks.length; i++) {
          var block = contentBlocks[i];
          if (block && block.type === "tool_result") {
            var toolUseId = block.tool_use_id;
            if (!toolUseId) continue;
            if (!toolResults[toolUseId]) {
              toolResults[toolUseId] = [];
            }
            toolResults[toolUseId].push(block);
          }
        }
        return toolResults;
      }

      function pickToolResultForDisplay(toolResults, toolUseId) {
        var entries = toolResults && toolUseId ? toolResults[toolUseId] : null;
        if (!entries || !entries.length) return null;
        for (var i = 0; i < entries.length - 1; i++) {
          if (isRecoverableToolError(entries[i], entries[i + 1])) {
            return entries[i + 1];
          }
        }
        return entries[entries.length - 1];
      }

      function hasRecoveredToolNoise(toolResults, toolUseId) {
        var entries = toolResults && toolUseId ? toolResults[toolUseId] : null;
        if (!entries || entries.length < 2) return false;
        for (var i = 0; i < entries.length - 1; i++) {
          if (isRecoverableToolError(entries[i], entries[i + 1])) {
            return true;
          }
        }
        return false;
      }

      function renderRecoveredToolHint(toolName) {
        return '<div class="structured-tool-hint">已自动恢复一次 ' + escapeHtml(getToolDisplayName(toolName)) + ' 参数问题</div>';
      }

      // ── 连续同类工具调用分组 ──
      var GROUPABLE_TOOLS = { Read: 1, Glob: 1, Grep: 1, WebFetch: 1, WebSearch: 1, TodoRead: 1 };

      function groupConsecutiveTools(content) {
        var groups = [];
        var i = 0;
        while (i < content.length) {
          var block = content[i];
          if (block.type === "tool_result") { i++; continue; }
          if (block.type === "tool_use" && GROUPABLE_TOOLS[block.name]) {
            var run = [{ block: block, index: i }];
            var j = i + 1;
            while (j < content.length) {
              if (content[j].type === "tool_result") { j++; continue; }
              if (content[j].type === "tool_use" && GROUPABLE_TOOLS[content[j].name]) {
                run.push({ block: content[j], index: j });
                j++;
              } else { break; }
            }
            if (run.length >= 2) {
              groups.push({ type: "group", items: run, endIndex: j });
            } else {
              groups.push({ type: "single", block: block, index: i });
            }
            i = j;
          } else {
            groups.push({ type: "single", block: block, index: i });
            i++;
          }
        }
        return groups;
      }

      var TOOL_GROUP_LABELS = { Read: "读取", Glob: "搜索", Grep: "搜索", WebFetch: "抓取", WebSearch: "搜索", TodoRead: "待办" };

      function renderToolGroup(items, role, toolResults, messageKey) {
        // Count by tool name
        var counts = {};
        for (var k = 0; k < items.length; k++) {
          var n = items[k].block.name;
          counts[n] = (counts[n] || 0) + 1;
        }
        // Check if all done or still pending
        var allDone = true;
        var anyError = false;
        for (var k = 0; k < items.length; k++) {
          var b = items[k].block;
          var tr = pickToolResultForDisplay(toolResults, b.id);
          if (!tr) { allDone = false; }
          else if (tr.is_error) { anyError = true; }
        }
        var statusIcon = !allDone ? "…" : (anyError ? "✗" : "✓");
        var statusClass = !allDone ? "pending" : (anyError ? "error" : "done");
        // Summary text
        var parts = [];
        for (var name in counts) {
          parts.push(counts[name] + " " + (TOOL_GROUP_LABELS[name] || name));
        }
        var summaryText = parts.join(" · ");
        var groupKey = buildExpandKey("tool-group", [messageKey, items[0] && items[0].index, items.length]);
        var persistedExpanded = getPersistedExpandState(groupKey);
        var shouldExpand = persistedExpanded === null ? getCardDefault("toolGroup") : persistedExpanded;

        // Render each item's inline-tool card
        var innerHtml = "";
        for (var k = 0; k < items.length; k++) {
          try {
            innerHtml += renderContentBlock(items[k].block, role, toolResults, items[k].index, messageKey);
          } catch (e) {
            innerHtml += '<div class="render-error">工具渲染失败</div>';
          }
        }

        return '<div class="tool-group" data-expand-kind="tool-group" data-expand-key="' + escapeHtml(groupKey) + '" data-expanded="' + (shouldExpand ? 'true' : 'false') + '" data-status="' + statusClass + '">' +
          '<div class="tool-group-summary" onclick="__toolGroupToggle(this.parentNode)">' +
            '<span class="tool-group-status">' + statusIcon + '</span>' +
            '<span class="tool-group-text">' + escapeHtml(summaryText) + '</span>' +
            '<span class="tool-group-count">' + items.length + ' 个调用</span>' +
            '<svg class="tool-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:' + (shouldExpand ? 'rotate(180deg)' : '') + '"><polyline points="6 9 12 15 18 9"/></svg>' +
          '</div>' +
          '<div class="tool-group-body" style="display:' + (shouldExpand ? 'block' : 'none') + ';">' + innerHtml + '</div>' +
        '</div>';
      }


      // global toggle
      window.__toolGroupToggle = function(el) {
        if (!el) return;
        var expanded = el.getAttribute("data-expanded") === "true";
        el.setAttribute("data-expanded", expanded ? "false" : "true");
        var body = el.querySelector(".tool-group-body");
        if (body) body.style.display = expanded ? "none" : "block";
        var chevron = el.querySelector(".tool-group-chevron");
        if (chevron) chevron.style.transform = expanded ? "" : "rotate(180deg)";
        persistElementExpandState(el, "tool-group");
      };

      function renderStructuredMessage(msg, roundUsage, messageIndex) {
        var role = msg.role;
        var avatar = chatAvatar(role);
        var messageKey = getMessageKey(msg, messageIndex);

        // Check if this is a queued user message
        var isQueued = role === "user" && msg.content && msg.content.some(function(b) { return b.__queued; });

        if (!msg.content || msg.content.length === 0) {
          if (role === "assistant") {
            return '<div class="chat-message ' + role + '">' +
              avatar +
              '<div class="chat-message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>' +
            '</div>';
          }
          return "";
        }

        var toolResults = buildToolResultMap(msg.content);
        var blocksHtml = "";

        try {
          var groups = groupConsecutiveTools(msg.content);
          for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            try {
              if (grp.type === "group") {
                blocksHtml += renderToolGroup(grp.items, role, toolResults, messageKey);
              } else {
                blocksHtml += renderContentBlock(grp.block, role, toolResults, grp.index, messageKey);
              }
            } catch (e) {
              blocksHtml += '<div class="render-error">消息块渲染失败</div>';
            }
          }
        } catch (e) {
          return '<div class="chat-message ' + role + '">' +
            avatar +
            '<div class="chat-message-content"><div class="render-error">消息渲染失败</div></div>' +
          '</div>';
        }

        var usageHtml = "";
        var queuedClass = isQueued ? " queued" : "";
        var queuedBadge = isQueued ? '<span class="queued-badge">排队中</span>' : "";

        return '<div class="chat-message ' + role + queuedClass + '" data-message-key="' + escapeHtml(messageKey) + '">' +
          avatar +
          '<div class="chat-message-content">' + blocksHtml + queuedBadge + '</div>' +
          usageHtml +
        '</div>';
      }
      function renderContentBlock(block, role, toolResults, index, messageKey) {
        if (!block || !block.type) return "";

        switch (block.type) {
          case "text":
            if (role === "assistant" && block.__processing) {
              return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
            }
            return role === "assistant" ? renderMarkdown(block.text || "") : escapeHtml(block.text || "");

          case "thinking":
            var thinkingText = block.thinking || "";
            var preview = thinkingText.length > 60 ? thinkingText.slice(0, 57) + "…" : thinkingText;
            var isStreaming = block.thinking === undefined && block.type === "thinking";
            if (isStreaming) {
              return '<div class="thinking-inline thinking-streaming" data-thinking="">' +
                '<div class="thinking-streaming-inner">' +
                  '<span class="thinking-streaming-icon spinning">⦿</span>' +
                  '<div class="thinking-streaming-text"></div>' +
                '</div>' +
              '</div>';
            }
            var thinkingKey = buildExpandKey("thinking", [messageKey, index]);
            var thinkingPersisted = getPersistedExpandState(thinkingKey);
          var thinkingExpanded = thinkingPersisted === null ? getCardDefault("thinking") : thinkingPersisted;
            return '<div class="thinking-inline ' + (thinkingExpanded ? 'expanded' : 'collapsed') + '" data-expand-kind="thinking" data-expand-key="' + escapeHtml(thinkingKey) + '" data-thinking="' + escapeHtml(thinkingText) + '" onclick="__thinkingToggle(this)">' +
              '<span class="thinking-inline-icon">⦿</span>' +
              '<span class="thinking-inline-preview">' + escapeHtml(thinkingExpanded ? thinkingText : preview) + '</span>' +
              '<span class="thinking-inline-action">' + (thinkingExpanded ? '收起' : '展开') + '</span>' +
            '</div>';

          case "tool_use":
            var toolResult = pickToolResultForDisplay(toolResults, block.id);
            var rendered = renderToolUseCard(block, toolResult, index, messageKey);
            if (hasRecoveredToolNoise(toolResults, block.id)) {
              rendered = renderRecoveredToolHint(block.name || "工具") + rendered;
            }
            return rendered;

          case "tool_result":
            return "";

          default:
            return '<div class="unknown-block">' + escapeHtml(JSON.stringify(block)) + '</div>';
        }
      }

      function renderInlineTool(block, toolResult, toolName, fileInfo, extraInfo, messageKey, index) {
        var toolId = block.id || "tool-" + toolName;
        var expandKey = buildExpandKey("inline-tool", [messageKey, toolId || index, index]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var inputData = block.input || {};
        var resultContent = extractToolResultText(toolResult && toolResult.content);

        var isError = toolResult && toolResult.is_error;
        var hasResult = resultContent.length > 0;
        var statusIcon = isError ? "✗" : (hasResult ? "✓" : "…");

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
        var shouldExpand = persistedExpanded === null ? getCardDefault("inlineTools") : persistedExpanded;
        if (hasResult) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? 'block' : 'none') + ';">' +
            '<div class="inline-tool-result">' + formatInlineResult(resultContent, toolName) + '</div>' +
          '</div>';
        } else if (isError) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? 'block' : 'none') + ';"><div class="inline-tool-result inline-tool-error">' +
            escapeHtml(resultContent || "操作失败") + '</div></div>';
        } else if (!toolResult) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? 'block' : 'none') + ';"><div class="inline-tool-loading">等待响应…</div></div>';
        }

        var isTruncated = toolResult && toolResult._truncated === true;

        var extraInfoHtml = meta ? '<span class="inline-tool-meta">' + escapeHtml(meta) + '</span>' : '';
        var extraClass = isError ? 'inline-tool-error-inline' : '';
        if (shouldExpand) extraClass += ' inline-tool-open';

        var truncatedAttrs = isTruncated
          ? 'data-truncated="true" data-tool-use-id="' + escapeHtml(block.id || "") + '" '
          : '';

        return '<div class="inline-tool ' + extraClass + '" ' +
          'data-expand-kind="inline-tool" ' +
          'data-expand-key="' + escapeHtml(expandKey) + '" ' +
          'data-result="' + escapeHtml(fullResult) + '" ' +
          'data-preview="' + previewDataAttr + '" ' +
          'data-status="' + (isError ? 'error' : (hasResult ? 'done' : 'pending')) + '" ' +
          truncatedAttrs +
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
      function renderTerminalTool(block, toolResult, toolName, messageKey, index) {
        var inputData = block.input || {};
        var command = inputData.command || inputData.cmd || "";
        var resultContent = extractToolResultText(toolResult && toolResult.content);
        var toolId = block.id || "tool-" + toolName;
        var expandKey = buildExpandKey("terminal", [messageKey, toolId || index, index]);
        var persistedExpanded = getPersistedExpandState(expandKey);

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

        // Show command preview in header (truncate long commands)
        var cmdPreview = command.length > 80 ? command.slice(0, 77) + "…" : command;
        var shouldExpand = persistedExpanded === null ? getCardDefault("terminal") : persistedExpanded;

        var termTruncated = toolResult && toolResult._truncated === true;
        var termTruncAttrs = termTruncated
          ? ' data-truncated="true" data-tool-use-id="' + escapeHtml(block.id || "") + '"'
          : '';

        return '<div class="inline-terminal" data-expand-kind="terminal" data-expand-key="' + escapeHtml(expandKey) + '" data-expanded="' + (shouldExpand ? 'true' : 'false') + '"' + termTruncAttrs + '>' +
          '<div class="term-header" onclick="__terminalExpand(this)">' +
            statusDot +
            '<span class="term-cmd-preview"><span class="term-prompt">$</span> ' + escapeHtml(cmdPreview) + '</span>' +
            '<span class="term-toggle-icon">' + (shouldExpand ? '▼' : '▶') + '</span>' +
          '</div>' +
          '<div class="term-body" style="display:' + (shouldExpand ? 'block' : 'none') + ';">' +
            '<div class="term-command"><span class="term-prompt">$</span> ' + cmdDisplay + '</div>' +
            (outputHtml ? '<div class="term-output">' + outputHtml + '</div>' : '') +
            exitCodeHtml +
          '</div>' +
        '</div>';
      }
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

      function renderDiffTool(block, toolResult, toolName, messageKey, index) {
        var inputData = block.input || {};
        var path = inputData.file_path || inputData.path || "";
        var fileName = path.split("/").pop() || path;
        var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);

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
              ? "等待授权"
              : "失败";
          } else {
            statusClass = "diff-success";
            statusText = "已修改";
          }
        } else {
          statusClass = "diff-pending";
          statusText = "执行中";
        }

        // Expand state: respect cardDefaults.editCards and persisted state
        var expandKey = buildExpandKey("diff", [messageKey, toolId || index, index]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var cardDefaultExpand = getCardDefault("editCards");
        var shouldExpand = persistedExpanded === null ? (statusClass === "diff-pending" || cardDefaultExpand) : persistedExpanded;
        var collapsedClass = shouldExpand ? "" : " collapsed";

        // If only one column has content, show full width
        var bothCols = leftCol && rightCol;
        var colClass = bothCols ? "diff-col-half" : "diff-col-full";

        return '<div class="inline-diff' + collapsedClass + '" data-tool-name="' + escapeHtml(toolName) + '"' +
          ' data-expand-kind="diff" data-expand-key="' + escapeHtml(expandKey) + '"' +
          ' data-tool-use-id="' + escapeHtml(toolId) + '">' +
          '<div class="diff-header" onclick="__tcToggle(event,this)">' +
            '<span class="diff-file-icon"></span>' +
            '<span class="diff-file-name">' + escapeHtml(fileName) + '</span>' +
            '<span class="diff-path">' + escapeHtml(path) + '</span>' +
            '<span class="diff-status ' + statusClass + '">' + statusText + '</span>' +
            '<span class="diff-toggle">▼</span>' +
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

      function renderToolUseCard(block, toolResult, index, messageKey) {
        var toolName = block.name || "unknown";
        var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);
        var fileInfo = extractFileInfo(toolName, block.input);

        // ── Lightweight inline tools: Read, Glob, Grep, WebFetch, WebSearch, TodoRead
        if (toolName === "Read" || toolName === "Glob" || toolName === "Grep" ||
            toolName === "WebFetch" || toolName === "WebSearch" || toolName === "TodoRead") {
          return renderInlineTool(block, toolResult, toolName, fileInfo, "", messageKey, index);
        }

        // ── Terminal-style: Bash
        if (toolName === "Bash") {
          return renderTerminalTool(block, toolResult, toolName, messageKey, index);
        }

        // ── Diff-style: Edit, Write, MultiEdit
        if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
          return renderDiffTool(block, toolResult, toolName, messageKey, index);
        }

        // ── AskUserQuestion tool — special card with batch submit
        if (toolName === "AskUserQuestion" && block.input && block.input.questions) {
          var questions = block.input.questions;
          if (questions && questions.length > 0) {
            var isAnswered = !!toolResult;
            var sel = state.askUserSelections[toolId] || {};
            var isSubmitted = !!sel.submitted;
            var answerText = isAnswered ? extractToolResultText(toolResult.content) : "";
            var answerLines = answerText ? answerText.trim().split("\n") : [];

            // Build header summary
            var headerLabel = "";
            for (var hi = 0; hi < questions.length; hi++) {
              if (questions[hi].header) { headerLabel = questions[hi].header; break; }
            }
            var headerSummary = headerLabel ? '<span class="tool-use-summary">' + escapeHtml(headerLabel) + '</span>' : "";

            var questionsHtml = "";
            questions.forEach(function(question, qIdx) {
              var isMulti = !!question.multiSelect;
              var questionText = question.question ? '<div class="ask-user-title">' + escapeHtml(question.question) + '</div>' : "";
              var optionsHtml = "";
              if (question.options && question.options.length > 0) {
                optionsHtml = '<div class="ask-user-options" data-multi-select="' + isMulti + '">';
                question.options.forEach(function(opt, idx) {
                  var label = opt.label ? escapeHtml(opt.label) : "选项 " + (idx + 1);
                  var descHtml = opt.description ? '<div class="ask-user-option-desc">' + escapeHtml(opt.description) + '</div>' : "";

                  if (isAnswered) {
                    // Read-only: check if this option was the chosen answer
                    var answerLine = answerLines[qIdx] || answerLines[0] || "";
                    var chosenLabels = answerLine.split(",").map(function(s) { return s.trim(); });
                    var isChosen = chosenLabels.indexOf(opt.label || "") !== -1;
                    optionsHtml += '<div class="ask-user-option ask-user-option-readonly' + (isChosen ? ' ask-user-option-chosen' : '') + '">' +
                      '<span class="ask-user-indicator"></span>' +
                      '<div class="ask-user-option-content">' +
                        '<div class="ask-user-option-label">' + label + '</div>' +
                        descHtml +
                      '</div>' +
                    '</div>';
                  } else {
                    // Interactive: selection state from askUserSelections
                    var isSelected = (sel[qIdx] || []).indexOf(idx) !== -1;
                    var disabledAttr = isSubmitted ? ' disabled' : '';
                    optionsHtml += '<button class="ask-user-option' + (isSelected ? ' selected' : '') + '"' +
                      ' data-option-index="' + idx + '"' +
                      ' data-question-index="' + qIdx + '"' +
                      ' data-option-label="' + escapeHtml(opt.label || "选项 " + (idx + 1)) + '"' +
                      ' onclick="__askSelect(\'' + escapeHtml(toolId) + '\',' + qIdx + ',' + idx + ',' + isMulti + ')"' +
                      disabledAttr + '>' +
                      '<span class="ask-user-indicator"></span>' +
                      '<div class="ask-user-option-content">' +
                        '<div class="ask-user-option-label">' + label + '</div>' +
                        descHtml +
                      '</div>' +
                    '</button>';
                  }
                });
                optionsHtml += '</div>';
              }
              questionsHtml += '<div class="ask-user-question-group" data-question-index="' + qIdx + '">' + questionText + optionsHtml + '</div>';
            });

            // Submit button (only for interactive state)
            var actionsHtml = "";
            if (!isAnswered) {
              var allAnsweredCheck = true;
              for (var qi = 0; qi < questions.length; qi++) {
                if (!sel[qi] || sel[qi].length === 0) { allAnsweredCheck = false; break; }
              }
              var submitDisabled = (!allAnsweredCheck || isSubmitted) ? " disabled" : "";
              var submitClass = isSubmitted ? " ask-user-submitted" : "";
              var submitText = isSubmitted ? "已提交..." : "确认提交";
              actionsHtml = '<div class="ask-user-actions">' +
                '<button class="ask-user-submit' + submitClass + '" data-tool-use-id="' + escapeHtml(toolId) + '"' +
                  ' onclick="__askSubmit(\'' + escapeHtml(toolId) + '\')"' + submitDisabled + '>' +
                  submitText +
                '</button>' +
              '</div>';
            }

            // Answered summary for header
            var answeredSummary = "";
            if (isAnswered && answerText) {
              var shortAnswer = answerText.trim().replace(/\n/g, ", ");
              if (shortAnswer.length > 40) shortAnswer = shortAnswer.slice(0, 37) + "...";
              answeredSummary = '<span class="tool-use-file">' + escapeHtml(shortAnswer) + '</span>';
            }

            // Expand state: default expanded when unanswered, collapsed when answered
            var askExpandKey = buildExpandKey("tool-card", [messageKey, toolId]);
            var askPersisted = getPersistedExpandState(askExpandKey);
            var askShouldExpand = askPersisted === null ? !isAnswered : askPersisted;
            var askCollapsed = askShouldExpand ? "" : " collapsed";
            var answeredClass = isAnswered ? " ask-user-answered" : "";

            return '<div class="tool-use-card ask-user' + answeredClass + askCollapsed + '"' +
              ' data-tool-use-id="' + escapeHtml(toolId) + '"' +
              ' data-expand-kind="tool-card"' +
              ' data-expand-key="' + escapeHtml(askExpandKey) + '">' +
              '<div class="tool-use-header" data-tool-toggle onclick="__tcToggle(event,this)">' +
                '<span class="tool-use-icon">' + (isAnswered ? '✓' : '?') + '</span>' +
                '<span class="tool-use-name">提问</span>' +
                headerSummary +
                answeredSummary +
                '<span class="tool-use-toggle">▼</span>' +
              '</div>' +
              '<div class="tool-use-body ask-user-body">' +
                questionsHtml +
                actionsHtml +
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
          var content = extractToolResultText(toolResult.content);
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

        var expandKey = buildExpandKey("tool-card", [messageKey, toolId]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var cardDefaultExpand = getCardDefault("editCards");
        var shouldExpand = persistedExpanded === null ? (statusClass === "loading" || cardDefaultExpand) : persistedExpanded;
        var tcTruncated = toolResult && toolResult._truncated === true;
        var collapsedClass = shouldExpand ? "" : " collapsed";
        var toggleHtml = '<span class="tool-use-toggle">▼</span>';
        return '<div class="tool-use-card ' + statusClass + collapsedClass + '" data-expand-kind="tool-card" data-expand-key="' + escapeHtml(expandKey) + '" data-tool-use-id="' + escapeHtml(toolId) + '"' + (tcTruncated ? ' data-truncated="true"' : '') + '>' +
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
          "Read": "R",
          "Write": "W",
          "Edit": "E",
          "MultiEdit": "E",
          "Bash": "$",
          "Grep": "G",
          "Glob": "F",
          "WebFetch": "⇣",
          "WebSearch": "⇢",
          "Task": "T",
          "TodoWrite": "☐",
          "TodoRead": "☑",
          "NotebookEdit": "N",
          "Agent": "A",
          "Exit": "×"
        };
        return icons[toolName] || "·";
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

      function parseMarkdownTables(source) {
        var NL = "\n";
        var lines = source.split(NL);
        var out = [];
        var i = 0;

        function splitRow(line) {
          var s = line.trim();
          if (s.charAt(0) === "|") s = s.slice(1);
          if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
          return s.split("|");
        }
        function styleAttr(a) { return a ? ' style="text-align:' + a + '"' : ""; }
        function buildTable(headers, aligns, rows) {
          var thead = "<thead><tr>" + headers.map(function(c, idx) {
            return "<th" + styleAttr(aligns[idx]) + ">" + c.trim() + "</th>";
          }).join("") + "</tr></thead>";
          var tbody = rows.length ? ("<tbody>" + rows.map(function(r) {
            return "<tr>" + r.map(function(c, idx) {
              return "<td" + styleAttr(aligns[idx]) + ">" + c.trim() + "</td>";
            }).join("") + "</tr>";
          }).join("") + "</tbody>") : "";
          return '<div class="md-table-wrap"><table class="md-table">' + thead + tbody + "</table></div>";
        }

        while (i < lines.length) {
          var header = lines[i];
          if (header.indexOf("|") !== -1 && i + 1 < lines.length) {
            var sep = lines[i + 1].trim();
            if (/^\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?$/.test(sep)) {
              var headers = splitRow(header);
              var aligns = splitRow(sep).map(function(c) {
                var t = c.trim();
                var L = t.charAt(0) === ":";
                var R = t.charAt(t.length - 1) === ":";
                if (L && R) return "center";
                if (R) return "right";
                if (L) return "left";
                return "";
              });
              var rows = [];
              var j = i + 2;
              while (j < lines.length) {
                var trimmed = lines[j].trim();
                if (!trimmed || trimmed.indexOf("|") === -1) break;
                rows.push(splitRow(lines[j]));
                j += 1;
              }
              out.push("", buildTable(headers, aligns, rows), "");
              i = j;
              continue;
            }
          }
          out.push(header);
          i += 1;
        }
        return out.join(NL);
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

        function isWordChar(code) {
          return (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            code === 95;
        }

        function replaceUnderscoreEmphasis(source, openTag, closeTag) {
          var cursor = 0;
          while (cursor < source.length) {
            var start = source.indexOf("_", cursor);
            if (start === -1) break;
            var leftCode = start > 0 ? source.charCodeAt(start - 1) : 0;
            if (isWordChar(leftCode)) {
              cursor = start + 1;
              continue;
            }
            var searchFrom = start + 1;
            var end = -1;
            while (searchFrom < source.length) {
              var candidate = source.indexOf("_", searchFrom);
              if (candidate === -1) break;
              var rightIdx = candidate + 1;
              var rightCode = rightIdx < source.length ? source.charCodeAt(rightIdx) : 0;
              if (!isWordChar(rightCode)) {
                end = candidate;
                break;
              }
              searchFrom = candidate + 1;
            }
            if (end === -1) break;
            var inner = source.slice(start + 1, end);
            if (!inner) {
              cursor = end + 1;
              continue;
            }
            var replacement = openTag + inner + closeTag;
            source = source.slice(0, start) + replacement + source.slice(end + 1);
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
          var protectedHighlighted = highlighted.replace(/_/g, '&#95;').replace(/\*/g, '&#42;');
          var replacement = '<div class="code-block">' +
            '<div class="code-block-header">' +
              '<span class="code-lang">' + (lang || "code") + '</span>' +
              '<button class="code-copy">Copy</button>' +
            '</div>' +
            '<pre><code>' + protectedHighlighted + '</code></pre>' +
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
          var protectedInlineCode = inlineCode.replace(/_/g, '&#95;').replace(/\*/g, '&#42;');
          var inlineReplacement = '<code class="code-inline">' + protectedInlineCode + '</code>';
          result = result.slice(0, inlineStart) + inlineReplacement + result.slice(inlineEnd + 1);
          pos = inlineStart + inlineReplacement.length;
        }

        result = replacePair(result, "**", '<strong>', '</strong>');
        result = replacePair(result, "*", '<em>', '</em>');
        result = replaceUnderscoreEmphasis(result, '<em>', '</em>');
        result = replaceLinePrefix(result, "### ", '<h3>', '</h3>');
        result = replaceLinePrefix(result, "## ", '<h2>', '</h2>');
        result = replaceLinePrefix(result, "# ", '<h1>', '</h1>');
        result = replaceLinePrefix(result, "&gt; ", '<blockquote>', '</blockquote>');
        result = replaceLinePrefix(result, "- ", '<li>', '</li>');
        result = replaceLinePrefix(result, "* ", '<li>', '</li>');
        result = replaceOrderedList(result);
        result = parseMarkdownTables(result);

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
      var NOTIFICATION_GAP = 6;
      var NOTIFICATION_TOP = 16;

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
        // Play sound for important notifications — independent of bubble setting
        if (opts.actionLabel || opts.playSound) playNotificationSound();

        // Respect user preference (skip if bubbles disabled)
        if (!state.notifBubble) return { dismiss: function() {} };

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

      // Detect Android APK native bridge
      var _hasNativeBridge = typeof WandNative !== "undefined" && typeof WandNative.sendNotification === "function";
      // Detect if running inside APK and extract installed version from User-Agent
      var _apkVersionMatch = navigator.userAgent.match(/WandApp\/([^\s]+)/);
      var _apkVersion = _apkVersionMatch ? _apkVersionMatch[1] : null;

      function _vibrate(pattern) {
        if (!_hasNativeBridge || typeof WandNative.vibrate !== "function") return;
        try { WandNative.vibrate(pattern || "light"); } catch (_e) {}
      }

      function _syncWakeLock() {
        if (!_hasNativeBridge) return;
        var anyActive = state.sessions.some(function(s) {
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

      function _getNativePermission() {
        if (_hasNativeBridge && typeof WandNative.getPermission === "function") {
          try { return WandNative.getPermission(); } catch (_e) {}
        }
        return null;
      }

      function requestNotificationPermission() {
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

      function _shouldSendSystemNotification(opts) {
        var options = opts || {};
        if (options.onlyWhenHidden && !document.hidden) return false;
        if (options.skipWhenSelectedSessionId && options.skipWhenSelectedSessionId === state.selectedId && !document.hidden) {
          return false;
        }
        return true;
      }

      function _isNotificationThrottled(tag, minIntervalMs) {
        if (!tag || !minIntervalMs || minIntervalMs <= 0) return false;
        var lastAt = state.notificationHistory[tag] || 0;
        var now = Date.now();
        if (now - lastAt < minIntervalMs) return true;
        state.notificationHistory[tag] = now;
        return false;
      }

      function sendBrowserNotification(title, body, opts) {
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

      function notifyTaskProgress(sessionId, task) {
        if (!task || !task.title) return;
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
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

      function notifyUpdateAvailable(currentVersion, latestVersion) {
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

      function notifyPermissionRequest(sessionId, body) {
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

      function notifyTaskEnded(sessionId, title, body) {
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

      var _progressSyncTimers = {};
      var _PROGRESS_SYNC_DEBOUNCE_MS = 100;

      // Strip markdown formatting and clamp to a single short line so the
      // native Live Activity / lock-screen card stays readable. 100 chars
      // matches getLastAssistantSummary; OPPO truncates harder anyway.
      function _compactNotificationText(text) {
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

      function syncSessionProgressToNative(sessionId) {
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

      function _doSyncSessionProgress(sessionId) {
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
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
        var todos = null;
        var latestUserText = "";
        var latestAssistantText = "";
        var recentUserTexts = [];
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
            var isPlaceholder = msg.content.some(function(b) { return b && b.__queued; });
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

      function clearSessionProgressNative(sessionId) {
        if (!_hasNativeBridge || typeof WandNative.clearSessionProgress !== "function") return;
        if (_progressSyncTimers[sessionId]) {
          clearTimeout(_progressSyncTimers[sessionId]);
          delete _progressSyncTimers[sessionId];
        }
        try { WandNative.clearSessionProgress(sessionId); } catch (_e) {}
      }

      // ── Android back button handler ──
      window.handleNativeBack = function() {
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
          render();
          return true;
        }
        return false;
      };

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
      function tryPlayNotificationSound() {
        return _doPlaySound();
      }

      function _doPlaySound() {
        try {
          var AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return false;
          var ctx = new AudioCtx();

          // Some browsers suspend AudioContext until user gesture — resume it
          if (ctx.state === "suspended") ctx.resume();

          var vol = (state.notifVolume || 0) / 100;

          function tone(freq, start, dur) {
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

      /**
       * Show an interactive update bubble that allows updating and restarting
       * directly from the notification, without navigating to settings.
       */
      function showUpdateBubble(currentVer, latestVer) {
        // Prevent duplicate bubbles
        if (state._updateBubbleShown) return;
        state._updateBubbleShown = true;

        playNotificationSound();

        var id = ++notificationIdCounter;
        var bubble = document.createElement("div");
        bubble.className = "notification-bubble";
        bubble.setAttribute("data-nid", id);

        bubble.innerHTML =
          '<div class="notification-bubble-header">' +
            '<span class="notification-bubble-icon info">\u2191</span>' +
            '<span class="notification-bubble-title">\u53d1\u73b0\u65b0\u7248\u672c</span>' +
            '<button class="notification-bubble-close" title="\u5173\u95ed">\u00d7</button>' +
          '</div>' +
          '<div class="notification-bubble-body">' +
            escapeHtml(currentVer) + ' \u2192 ' + escapeHtml(latestVer) +
          '</div>' +
          '<div class="notification-bubble-actions">' +
            '<button class="primary" id="update-bubble-action">\u7acb\u5373\u66f4\u65b0</button>' +
          '</div>';

        document.body.appendChild(bubble);

        var entry = { id: id, el: bubble };
        notificationStack.push(entry);
        repositionNotifications();

        var closeBtn = bubble.querySelector(".notification-bubble-close");
        if (closeBtn) closeBtn.onclick = function() {
          dismissNotification(id);
          state._updateBubbleShown = false;
        };

        var actionBtn = bubble.querySelector("#update-bubble-action");
        var bodyEl = bubble.querySelector(".notification-bubble-body");

        if (actionBtn) actionBtn.onclick = function() {
          // Phase 1: Performing update
          actionBtn.disabled = true;
          actionBtn.textContent = "\u66f4\u65b0\u4e2d\u2026";
          if (bodyEl) bodyEl.textContent = "\u6b63\u5728\u4e0b\u8f7d\u5e76\u5b89\u88c5\u65b0\u7248\u672c\u2026";

          fetch("/api/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin"
          })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.error) {
              // Update failed
              if (bodyEl) {
                bodyEl.textContent = data.error;
                bodyEl.style.color = "var(--error)";
              }
              actionBtn.disabled = false;
              actionBtn.textContent = "\u91cd\u8bd5";
              return;
            }
            // Phase 2: Update succeeded, show restart button
            if (bodyEl) {
              bodyEl.textContent = data.message || "\u66f4\u65b0\u5b8c\u6210";
              bodyEl.style.color = "var(--success)";
            }
            actionBtn.textContent = "\u91cd\u542f\u751f\u6548";
            actionBtn.disabled = false;
            actionBtn.className = "primary success";
            actionBtn.onclick = function() {
              performRestart(actionBtn, bodyEl);
            };
          })
          .catch(function() {
            if (bodyEl) {
              bodyEl.textContent = "\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u8fde\u63a5\u3002";
              bodyEl.style.color = "var(--error)";
            }
            actionBtn.disabled = false;
            actionBtn.textContent = "\u91cd\u8bd5";
          });
        };
      }

      /**
       * Call POST /api/restart and show the restart overlay.
       */
      function performRestart(btn, msgEl) {
        if (btn) {
          btn.disabled = true;
          btn.textContent = "\u6b63\u5728\u91cd\u542f\u2026";
        }
        if (msgEl) {
          msgEl.textContent = "\u670d\u52a1\u6b63\u5728\u91cd\u542f\u2026";
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
      function showRestartOverlay() {
        // Avoid duplicates
        if (document.getElementById("restart-overlay")) return;

        var overlay = document.createElement("div");
        overlay.id = "restart-overlay";
        overlay.className = "restart-overlay";
        overlay.innerHTML =
          '<div class="restart-overlay-content">' +
            '<div class="restart-spinner"></div>' +
            '<div class="restart-title">\u670d\u52a1\u6b63\u5728\u91cd\u542f</div>' +
            '<div class="restart-subtitle">\u7a0d\u540e\u5c06\u81ea\u52a8\u5237\u65b0\u9875\u9762\u2026</div>' +
          '</div>';
        document.body.appendChild(overlay);

        var attempts = 0;
        var maxAttempts = 20; // 20 * 2s = 40s
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
              subtitle.innerHTML = '\u91cd\u542f\u8d85\u65f6\uff0c\u8bf7 <a href="javascript:location.reload()" style="color:var(--accent);text-decoration:underline">\u624b\u52a8\u5237\u65b0</a> \u9875\u9762\u3002';
            }
          }
        }, 2000);
      }

      function showAutoUpdateOverlay(currentVer, latestVer) {
        if (document.getElementById("restart-overlay")) return;
        var overlay = document.createElement("div");
        overlay.id = "restart-overlay";
        overlay.className = "restart-overlay";
        overlay.innerHTML =
          '<div class="restart-overlay-content">' +
            '<div class="restart-spinner"></div>' +
            '<div class="restart-title">\u81ea\u52a8\u66f4\u65b0\u4e2d</div>' +
            '<div class="restart-subtitle">' +
              escapeHtml(currentVer) + ' \u2192 ' + escapeHtml(latestVer) +
              '<br>\u6b63\u5728\u4e0b\u8f7d\u5e76\u5b89\u88c5\u65b0\u7248\u672c\uff0c\u7a0d\u540e\u5c06\u81ea\u52a8\u91cd\u542f\u2026' +
            '</div>' +
          '</div>';
        document.body.appendChild(overlay);
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
