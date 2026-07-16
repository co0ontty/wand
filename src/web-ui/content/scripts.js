"use strict";
(() => {
  // src/web-ui/browser/legacy-pwa-cleanup.ts
  var LEGACY_PWA_CLEANUP_KEY = "wand-legacy-pwa-cleanup-v1";
  var LEGACY_CACHE_PREFIXES = ["wand-static-", "wand-runtime-"];
  function isLegacyWandServiceWorker(worker) {
    if (!worker) return false;
    try {
      const scriptUrl = new URL(worker.scriptURL, location.href);
      return scriptUrl.origin === location.origin && scriptUrl.pathname === "/sw.js";
    } catch {
      return false;
    }
  }
  function isLegacyWandRegistration(registration) {
    return isLegacyWandServiceWorker(registration.installing) || isLegacyWandServiceWorker(registration.waiting) || isLegacyWandServiceWorker(registration.active);
  }
  function hasCompletedCleanup() {
    try {
      return localStorage.getItem(LEGACY_PWA_CLEANUP_KEY) === "done";
    } catch {
      return false;
    }
  }
  function markCleanupCompleted() {
    try {
      localStorage.setItem(LEGACY_PWA_CLEANUP_KEY, "done");
    } catch {
    }
  }
  async function unregisterLegacyServiceWorkers() {
    if (!("serviceWorker" in navigator)) return true;
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const legacyRegistrations = registrations.filter(isLegacyWandRegistration);
      await Promise.all(legacyRegistrations.map((registration) => registration.unregister()));
      return true;
    } catch {
      return false;
    }
  }
  async function deleteLegacyCaches() {
    if (!("caches" in window)) return true;
    try {
      const cacheNames = await caches.keys();
      const legacyCacheNames = cacheNames.filter(
        (name) => LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
      );
      await Promise.all(legacyCacheNames.map((name) => caches.delete(name)));
      return true;
    } catch {
      return false;
    }
  }
  async function cleanupLegacyPwaState() {
    if (hasCompletedCleanup()) return;
    const controlledByLegacyWorker = "serviceWorker" in navigator && isLegacyWandServiceWorker(navigator.serviceWorker.controller);
    const [workersCleaned, cachesCleaned] = await Promise.all([
      unregisterLegacyServiceWorkers(),
      deleteLegacyCaches()
    ]);
    if (!workersCleaned || !cachesCleaned) return;
    markCleanupCompleted();
    if (controlledByLegacyWorker) location.reload();
  }
  void cleanupLegacyPwaState();

  // src/web-ui/browser/state.ts
  var configPath = "${escapeHtml(configPath)}";
  var CHAT_EXPAND_STATE_STORAGE_KEY = "wand-chat-expand-state-v1";
  var LS_MIGRATIONS = [
    // v1 保留为 no-op：曾经这里会删除 wand-sidebar-pinned，导致升级或刷新时
    // 覆盖用户明确选择的侧栏状态。迁移函数必须只修正格式，不能抹掉偏好。
    function migrateSidebarPinDefault() {
    }
  ];
  (function runLocalStorageMigrations() {
    try {
      var raw = localStorage.getItem("wand-ls-schema");
      var applied = raw == null ? 0 : parseInt(raw, 10);
      if (!(applied >= 0)) applied = 0;
      for (var i = applied; i < LS_MIGRATIONS.length; i++) {
        try {
          LS_MIGRATIONS[i]();
        } catch (e) {
        }
      }
      if (applied < LS_MIGRATIONS.length) {
        localStorage.setItem("wand-ls-schema", String(LS_MIGRATIONS.length));
      }
    } catch (e) {
    }
  })();
  function readStoredBoolean(key, defaultValue) {
    try {
      var value = localStorage.getItem(key);
      if (value === "true") return true;
      if (value === "false") return false;
      return defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }
  function writeStoredBoolean(key, value) {
    try {
      localStorage.setItem(key, String(!!value));
    } catch (e) {
    }
  }
  var state = {
    selectedId: (function() {
      try {
        var url = new URL(window.location.href);
        var requested = url.searchParams.get("session");
        if (requested) {
          localStorage.setItem("wand-selected-session", requested);
          url.searchParams.delete("session");
          history.replaceState(history.state, "", url.toString());
          return requested;
        }
      } catch (e) {
      }
      try {
        return localStorage.getItem("wand-selected-session") || null;
      } catch (e) {
        return null;
      }
    })(),
    pollTimer: null,
    config: null,
    sessions: [],
    suggestionTimer: null,
    terminal: null,
    terminalFitInProgress: false,
    terminalSessionId: null,
    terminalOutput: "",
    // R8: /clear marker。Claude 的 /clear 不发任何 ANSI 清屏序列，它只
    // 就地把对话框重画成空、把旧对话推进 scrollback。但 wand 的
    // state.terminalOutput 是 append-only buffer，softResync 一触发就
    // 把 /clear 之前的历史全部重放回 wterm（用户看到"/clear 后短暂闪
    // 回旧内容"）。marker 表示 buffer 里"用户上次 /clear 时刻的位置"，
    // softResync 只重放 slice(marker)，从根上避免历史被重放。
    terminalOutputMarker: 0,
    terminalLiveStreamSessions: {},
    // CSI ?2026h..l 同步输出缓冲：begin 时拿到 "\x1b[?2026h" 后开始缓冲，
    // end 时拿到 "\x1b[?2026l" 一次性 flush 给 wterm。null 表示当前不在
    // sync 包帧内。@wterm/core 0.1.8 不实现 sync output，begin/end 之间
    // 每个 write 立即落到 grid + mark dirty —— 跨 server-debounce 窗口
    // 时浏览器看到中间帧 + 触发 softResync 时状态机被打断，正是
    // askuserquestion 菜单多份叠加的最强候选根因。
    syncOutputBuffer: null,
    syncOutputDeadline: 0,
    syncFramingResidue: false,
    lastChunkAt: 0,
    terminalHealthTimer: null,
    lastTerminalResyncAt: 0,
    terminalAutoFollow: true,
    // 程序触发的滚动（wand 主动 scrollTo / wterm 内部因 _shouldScrollToBottom=true
    // 拽 scrollTop=scrollHeight）落到 scroll handler 时会被误判为"用户滚回严格
    // 底部"，把 autoFollow 反转回 true，把用户刚 wheel 上滚的意图吞掉。
    // 存"窗口截止时间戳"而非"开始时间戳"：不同调用方按各自动画长度延长窗口
    // （瞬时 120ms 覆盖一次 rAF + 事件分发；smooth 500ms 覆盖 Chromium smooth
    // scroll 动画），多次调用用 Math.max 合并、不会被短窗口缩短。
    terminalProgrammaticScrollUntil: 0,
    terminalScrollIdleTimer: null,
    terminalScrollThreshold: 12,
    showTerminalJumpToBottom: false,
    terminalViewportEl: null,
    terminalViewportScrollHandler: null,
    terminalViewportTouchHandler: null,
    terminalViewportTouchStartHandler: null,
    terminalTouchStartY: 0,
    terminalComposing: false,
    resizeObserver: null,
    resizeHandler: null,
    resizeTimer: null,
    inputQueue: Promise.resolve(),
    pendingMessages: [],
    // WebSocket 断线期间的消息队列
    messageQueue: [],
    // 用户消息排队等待发送
    crossSessionQueue: (function() {
      try {
        var saved = localStorage.getItem("wand-cross-session-queue");
        var parsed = saved ? JSON.parse(saved) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    })(),
    // 跨会话排队消息 [{ id, text, cwd, mode, tool }]
    structuredInputQueue: [],
    // 结构化会话同会话排队消息
    // 排队条 UI 局部状态 ——
    //   queueBarExpanded: 整条气泡条是否处于展开态（true = 展开成垂直详情列表；
    //     false = 收起成水平小气泡胶囊）。点击胶囊空白 / 气泡本体 / +N 徽章切换。
    //     ESC / 清空 / 全部 promote 出去时也会被自动收回。
    //   queueBarDrag: 拖拽排序进行中时的临时状态（pointer 捕获、起始坐标、参考 rect）。
    //   收起态以前还有"hover 展开某一条"的旧实现，已在 iOS 26 玻璃条改造里一起下线；
    //   queueBarHoverIndex 不再被任何代码读写，保留 null 占位以免破坏其他模块的
    //   类型推断。
    queueBarExpanded: false,
    queueBarHoverIndex: null,
    queueBarDrag: null,
    queueBarPromoting: false,
    drafts: {},
    isSyncingInputBox: false,
    loginPending: false,
    loginChecked: false,
    bootstrapping: true,
    sessionsDrawerOpen: readStoredBoolean("wand-sidebar-open", false),
    // 新交互：桌面默认呼出即常驻；只有用户主动关闭过才记 "false"。
    sidebarPinned: readStoredBoolean("wand-sidebar-pinned", true),
    sidebarCollapsed: readStoredBoolean("wand-sidebar-collapsed", false),
    modalOpen: false,
    presetValue: "",
    cwdValue: "",
    modeValue: "managed",
    chatMode: "managed",
    chatModels: (function() {
      try {
        var legacy = localStorage.getItem("wand-chat-model") || "";
        return {
          claude: localStorage.getItem("wand-chat-model-claude") || legacy,
          codex: localStorage.getItem("wand-chat-model-codex") || "",
          opencode: localStorage.getItem("wand-chat-model-opencode") || ""
        };
      } catch (e) {
        return { claude: "", codex: "", opencode: "" };
      }
    })(),
    chatModel: (function() {
      try {
        return localStorage.getItem("wand-chat-model") || "";
      } catch (e) {
        return "";
      }
    })(),
    chatThinking: (function() {
      try {
        var v = localStorage.getItem("wand-thinking-effort") || "off";
        return v === "off" || v === "standard" || v === "deep" || v === "max" || /^codex:[a-z0-9][a-z0-9_-]{0,31}$/.test(v) ? v : "off";
      } catch (e) {
        return "off";
      }
    })(),
    availableModels: [],
    availableCodexModels: [],
    availableOpenCodeModels: [],
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
    ws: null,
    wsConnected: false,
    // 上一次从服务器收到任意 WS 消息（包括 ping）的时间戳。心跳 stale 检测
    // 用它来判断半开连接：长时间没消息 → forceReconnect。0 表示尚未连接过。
    lastWsMessageAt: 0,
    // 心跳检查 timer 句柄。每 10s 跑一次 evaluateWsHeartbeatStale()。
    wsHeartbeatCheckTimer: null,
    _updateBubbleShown: false,
    notificationHistory: {},
    delayedNotificationTimer: null,
    notifSound: (function() {
      try {
        var v = localStorage.getItem("wand-notif-sound");
        return v === null ? true : v === "true";
      } catch (e) {
        return true;
      }
    })(),
    notifVolume: (function() {
      try {
        var v = localStorage.getItem("wand-notif-volume");
        return v === null ? 80 : Math.max(0, Math.min(100, parseInt(v, 10) || 80));
      } catch (e) {
        return 80;
      }
    })(),
    notifBubble: (function() {
      try {
        var v = localStorage.getItem("wand-notif-bubble");
        return v === null ? true : v === "true";
      } catch (e) {
        return true;
      }
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
    quickCommitForm: { customMessage: "", tag: "", tagEdited: false },
    quickCommitPushing: false,
    quickCommitPushError: "",
    quickCommitResult: null,
    quickCommitDragAction: "commit",
    // 本次提交是否纳入 submodule，仅用于「执行中…」忙碌文案。
    quickCommitSubmoduleIntent: false,
    // Telegram 风格的"贴底"状态：true = 用户当前贴在底部，新消息会自然出现；
    // false = 用户向上滚了，未读会累积到气泡里，不会自动滚他们的视图。
    chatStickToBottom: true,
    // 旧版自动折叠横条已禁用：不再把最新一轮摘要固定到聊天顶部。
    chatAutoFoldEnabled: false,
    // 当前会话视图里"激活的折叠快照"，记录顶部预览对应的最新 user / assistant 索引。
    chatAutoFoldSnapshot: null,
    chatUnreadCount: 0,
    // state.currentMessages 中第一条未读消息的 index，-1 表示没有未读。
    chatUnreadStartIndex: -1,
    // 业界共识 150-180px：120px 在触控板/移动端惯性下边界来回弹。
    chatScrollThreshold: 160,
    chatIsProgrammaticScroll: false,
    // 程序触发滚动的"宽限期"时间戳：scrollTop 赋值后浏览器的 scroll 事件
    // 往往晚于单个 rAF 才派发，单靠 chatIsProgrammaticScroll 在 rAF 里复位会
    // 太早，导致 pin 自己的重定位被 scroll handler 误判成用户滚动而释放。
    // 在此时间戳之前到达的 scroll 事件一律当作程序滚动忽略。
    chatProgrammaticScrollUntil: 0,
    chatScrollElement: null,
    chatScrollHandler: null,
    chatScrollWheelHandler: null,
    chatScrollTouchStartHandler: null,
    chatScrollTouchMoveHandler: null,
    chatTouchStartY: 0,
    // 仅在"首次渲染当前会话视图"时才允许 fullRenderChat 强制贴底。
    // resetChatRenderCache 会把它设回 false；fullRenderChat 第一次跑完就置 true。
    // page-refresh / ws 重连不重置此标记，避免把用户拽到底部。
    chatInitialRenderDone: false,
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
    currentTask: null,
    // Current task title from Claude
    terminalInteractive: false,
    miniKeyboardVisible: false,
    modifiers: { ctrl: false, alt: false, shift: false },
    // ── 终端悬浮摇杆遥控器（手机端 PTY 遥控）状态 ──
    // joystickPos 持久化球球位置 {right, bottom}（localStorage wand-ball-pos）
    joystickPos: (function() {
      try {
        var saved = localStorage.getItem("wand-ball-pos");
        if (!saved) return null;
        var parsed = JSON.parse(saved);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (e) {
        return null;
      }
    })(),
    joystickPinnedOpen: false,
    // 钉住面板是否展开（不持久化，切会话复位）
    joystickRootEl: null,
    // 以下均为运行期句柄，teardown 复位
    joystickPanelEl: null,
    joystickBackdropEl: null,
    joystickBallEl: null,
    joystickPointerId: null,
    joystickGesture: null,
    // null|'pending'|'cancelled'|'move'
    joystickPressStart: null,
    // {x, y, t}
    joystickLongPressTimer: null,
    joystickMoveHandler: null,
    joystickUpHandler: null,
    joystickResizeHandler: null,
    fileSearchQuery: "",
    fileExplorerLoading: false,
    allFiles: [],
    fileExplorerCwd: "",
    fileExplorerTruncated: false,
    fileExplorerTotal: 0,
    claudeHistory: [],
    claudeHistoryLoaded: false,
    claudeHistoryExpanded: false,
    claudeHistoryExpandedDirs: {},
    archivedExpanded: false,
    sessionsManageMode: false,
    selectedSessionIds: {},
    selectedClaudeHistoryIds: {},
    codexHistory: [],
    codexHistoryLoaded: false,
    codexHistoryExpandedDirs: {},
    selectedCodexHistoryIds: {},
    askUserSelections: {},
    // { toolUseId: { 0: [optIdx...], submitted: false } }
    queueEpoch: 0,
    // Monotonic counter for queue state freshness
    pendingAttachments: [],
    // [{ file, previewUrl, name, size }]
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

  // src/web-ui/browser/i18n.ts
  var I18N_DEFAULT_LANG = "\u4E2D\u6587";
  var I18N = {
    "\u4E2D\u6587": {
      "subagent.tag": "\u5B50\u4EE3\u7406",
      "subagent.handoff": "{parent} \u8BA9 {sub} \u5E2E\u5FD9",
      "subagent.handoff.with_desc": "{parent} \u8BA9 {sub} \u5E2E\u5FD9\uFF1A",
      "subagent.continued": "\u7EE7\u7EED\u8F93\u51FA",
      "subagent.task.done": "\u4EFB\u52A1\u5B8C\u6210",
      "subagent.task.failed": "\u4EFB\u52A1\u5931\u8D25",
      "subagent.running": "\u8FD0\u884C\u4E2D",
      "subagent.no_output": "\uFF08\u65E0\u8F93\u51FA\uFF09",
      "subagent.helper_fallback_prefix": "\u534F\u4F5C\u732B\xB7",
      "subagent.title_aria": "\u70B9\u51FB\u5C55\u5F00 / \u6536\u8D77\u5B50\u4EE3\u7406\u8F93\u51FA",
      "subagent.tag_title": "\u5B50\u4EE3\u7406 / subagent",
      "ui.expand": "\u5C55\u5F00",
      "ui.collapse": "\u6536\u8D77",
      "ui.expand_panel_aria": "\u5C55\u5F00\u5B50\u4EE3\u7406\u8F93\u51FA",
      "ui.collapse_panel_aria": "\u6536\u8D77\u5B50\u4EE3\u7406\u8F93\u51FA",
      "history.expand": "\u5C55\u5F00\u5386\u53F2\u5BF9\u8BDD",
      "history.collapse": "\u6536\u8D77\u5386\u53F2\u5BF9\u8BDD",
      "history.rounds": "{n} \u8F6E\u5BF9\u8BDD",
      "history.tools": "{n} \u6B21\u5DE5\u5177\u8C03\u7528",
      "history.agents": "{n} \u4E2A\u5B50\u4EE3\u7406",
      "history.errors": "{n} \u4E2A\u5931\u8D25",
      "stop.confirm.title": "\u505C\u6B62\u4EFB\u52A1",
      "stop.confirm.message": "\u786E\u5B9A\u8981\u505C\u6B62\u5F53\u524D\u6B63\u5728\u8FD0\u884C\u7684\u4EFB\u52A1\u5417\uFF1F",
      "stop.confirm.ok": "\u505C\u6B62",
      "stop.confirm.cancel": "\u53D6\u6D88"
    },
    "English": {
      "subagent.tag": "Subagent",
      "subagent.handoff": "{parent} asked {sub} for help",
      "subagent.handoff.with_desc": "{parent} asked {sub} for help with: ",
      "subagent.continued": "continued",
      "subagent.task.done": "Task complete",
      "subagent.task.failed": "Task failed",
      "subagent.running": "Running",
      "subagent.no_output": "(no output)",
      "subagent.helper_fallback_prefix": "Helper\xB7",
      "subagent.title_aria": "Click to expand / collapse subagent output",
      "subagent.tag_title": "Subagent",
      "ui.expand": "Expand",
      "ui.collapse": "Collapse",
      "ui.expand_panel_aria": "Expand subagent output",
      "ui.collapse_panel_aria": "Collapse subagent output",
      "history.expand": "Show earlier conversation",
      "history.collapse": "Hide earlier conversation",
      "history.rounds": "{n} rounds",
      "history.tools": "{n} tool calls",
      "history.agents": "{n} subagents",
      "history.errors": "{n} failed",
      "stop.confirm.title": "Stop task",
      "stop.confirm.message": "Stop the task that's currently running?",
      "stop.confirm.ok": "Stop",
      "stop.confirm.cancel": "Cancel"
    }
  };
  function getActiveLang() {
    var raw = state.config && typeof state.config.language === "string" ? state.config.language.trim() : "";
    if (!raw) return I18N_DEFAULT_LANG;
    if (I18N[raw]) return raw;
    var lower = raw.toLowerCase();
    if (lower === "english" || lower === "en" || lower.indexOf("english") === 0 || lower.indexOf("\u82F1") === 0) return "English";
    if (lower === "\u4E2D\u6587" || lower === "zh" || lower.indexOf("zh") === 0 || lower.indexOf("\u4E2D") === 0 || lower.indexOf("chinese") === 0) return "\u4E2D\u6587";
    return "English";
  }
  function t2(key, params) {
    var lang = getActiveLang();
    var table = I18N[lang] || I18N[I18N_DEFAULT_LANG];
    var template = table && key in table ? table[key] : null;
    if (template == null) {
      var def = I18N[I18N_DEFAULT_LANG];
      template = def && key in def ? def[key] : key;
    }
    if (params && typeof template === "string") {
      for (var k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        template = template.split("{" + k + "}").join(params[k]);
      }
    }
    return template;
  }
  var ICON_PATHS = {
    // shape sets — 24x24 viewbox, currentColor stroke
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/>',
    certificate: '<path d="M6 3h12v14H6z"/><path d="M9 7h6"/><path d="M9 11h4"/><path d="m10 17-1 4 3-1 3 1-1-4"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 15h3"/><path d="M1 9h3"/><path d="M1 15h3"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
    brain: '<path d="M9.5 4.5a3 3 0 0 0-4.7 3.1 3.3 3.3 0 0 0 .3 6.1A3 3 0 0 0 8 19h1.5V4.5z"/><path d="M14.5 4.5a3 3 0 0 1 4.7 3.1 3.3 3.3 0 0 1-.3 6.1A3 3 0 0 1 16 19h-1.5V4.5z"/><path d="M9.5 8H7.8"/><path d="M14.5 8h1.7"/><path d="M9.5 13H7.6"/><path d="M14.5 13h1.9"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="6" y1="14" x2="6" y2="14"/><line x1="18" y1="14" x2="18" y2="14"/><line x1="9" y1="14" x2="15" y2="14"/>',
    terminal: '<polyline points="4 7 9 12 4 17"/><line x1="12" y1="17" x2="20" y2="17"/>',
    chat: '<path d="M21 12a8 8 0 0 1-12.9 6.3L3 20l1.7-5.1A8 8 0 1 1 21 12z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    bell: '<path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    vibrate: '<rect x="9" y="4" width="6" height="16" rx="1"/><path d="M5 8v8"/><path d="M3 10v4"/><path d="M19 8v8"/><path d="M21 10v4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
    smartphone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/>',
    desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.36 0l3-3a4.5 4.5 0 1 0-6.36-6.36l-1.42 1.41"/><path d="M14 10a4.5 4.5 0 0 0-6.36 0l-3 3a4.5 4.5 0 1 0 6.36 6.36l1.42-1.41"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 3a9 9 0 1 0 0 18 1.5 1.5 0 0 0 1.1-2.5 1.5 1.5 0 0 1 1.1-2.5h2.3A4.5 4.5 0 0 0 21 11.5C21 6.8 16.97 3 12 3z"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 1 1 4 4l-9 9-3.5 1 1-3.5 7.5-7.5z"/>',
    paw: '<circle cx="7.5" cy="9" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="6.8" r="2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="9" r="2" fill="currentColor" stroke="none"/><circle cx="18" cy="13.3" r="1.8" fill="currentColor" stroke="none"/><path d="M7.2 16.3c.5-2.9 2.3-4.8 4.8-4.8s4.3 1.9 4.8 4.8c.3 1.8-.9 3.2-2.6 2.6-.8-.3-1.4-.6-2.2-.6s-1.4.3-2.2.6c-1.7.6-2.9-.8-2.6-2.6z" fill="currentColor" stroke="none"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    signal: '<path d="M2 12a15 15 0 0 1 20 0"/><path d="M5 16a10 10 0 0 1 14 0"/><path d="M9 20a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r="0.5" fill="currentColor"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/>',
    sigma: '<polyline points="18 4 6 4 13 12 6 20 18 20"/>',
    x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
    // 「+」：附件入口（替代旧曲别针图标），更直观、与微信/iMessage 习惯一致。
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    // 麦克风：语音输入入口。stroke 线性风格与项目其他图标统一。
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/>',
    // 曲别针：加号 popover 内"上传附件"项的图标（+ 入口已被外层占用，这里就用回曲别针）。
    paperclip: '<path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.84-8.84a4 4 0 1 1 5.66 5.66L9.41 17.41a2 2 0 1 1-2.83-2.83l8.84-8.83"/>'
  };
  function iconSvg(name, opts) {
    var path = ICON_PATHS[name];
    if (!path) return "";
    opts = opts || {};
    var size = opts.size || 14;
    var stroke = opts.strokeWidth || 1.8;
    var cls = opts.cls ? ' class="' + opts.cls + '"' : "";
    var fill = opts.fill || "none";
    return "<svg" + cls + ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + fill + '" stroke="currentColor" stroke-width="' + stroke + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
  }

  // src/web-ui/browser/message-reconciliation.ts
  function turnContentVolume(turn) {
    if (!turn || !Array.isArray(turn.content)) return 0;
    var total = 0;
    for (var i = 0; i < turn.content.length; i++) {
      var block = turn.content[i];
      if (!block) continue;
      if (typeof block.text === "string") total += block.text.length;
      if (typeof block.thinking === "string") total += block.thinking.length;
      if (typeof block.content === "string") total += block.content.length;
      else if (Array.isArray(block.content)) {
        for (var k = 0; k < block.content.length; k++) {
          var nestedBlock = block.content[k];
          if (nestedBlock && typeof nestedBlock.text === "string") total += nestedBlock.text.length;
        }
      }
      if (block.input) {
        try {
          total += JSON.stringify(block.input).length;
        } catch (_error) {
        }
      }
    }
    return total;
  }
  function mergeAssistantTurn(localTurn, incomingTurn) {
    if (!localTurn) return incomingTurn;
    if (!incomingTurn) return localTurn;
    if (turnContentVolume(incomingTurn) >= turnContentVolume(localTurn)) return incomingTurn;
    return Object.assign({}, localTurn, {
      usage: incomingTurn.usage || localTurn.usage
    });
  }
  function mergeOverlappingTurns(localTurn, incomingTurn) {
    if (localTurn?.role === "assistant" && incomingTurn?.role === "assistant") {
      return mergeAssistantTurn(localTurn, incomingTurn);
    }
    return incomingTurn || localTurn;
  }
  function mergeWindowedMessages(prev, incoming, offset, total) {
    var snapOffset = offset || 0;
    var snapTotal = typeof total === "number" ? total : Math.max(snapOffset + incoming.length, incoming.length);
    var prevMsgs = prev && Array.isArray(prev.messages) ? prev.messages : [];
    var prevOffset = prev && typeof prev.messageOffset === "number" ? prev.messageOffset : 0;
    var prevTotal = prev && typeof prev.messageTotal === "number" ? prev.messageTotal : prevOffset + prevMsgs.length;
    if (incoming.length === 0 && prevMsgs.length > 0 && snapTotal === 0) {
      return { messages: prevMsgs, messageOffset: prevOffset, messageTotal: prevTotal };
    }
    if (prevMsgs.length > 0 && snapTotal < prevTotal) {
      return { messages: prevMsgs, messageOffset: prevOffset, messageTotal: prevTotal };
    }
    if (prevMsgs.length === 0) {
      return { messages: incoming, messageOffset: snapOffset, messageTotal: snapTotal };
    }
    var prevEnd = prevOffset + prevMsgs.length;
    var snapEnd = snapOffset + incoming.length;
    if (snapOffset > prevEnd || prevOffset > snapEnd) {
      return { messages: incoming, messageOffset: snapOffset, messageTotal: snapTotal };
    }
    var mergedOffset = Math.min(prevOffset, snapOffset);
    var mergedEnd = Math.max(prevEnd, snapEnd);
    var merged = [];
    for (var absoluteIndex = mergedOffset; absoluteIndex < mergedEnd; absoluteIndex++) {
      var localTurn = absoluteIndex >= prevOffset && absoluteIndex < prevEnd ? prevMsgs[absoluteIndex - prevOffset] : void 0;
      var incomingTurn = absoluteIndex >= snapOffset && absoluteIndex < snapEnd ? incoming[absoluteIndex - snapOffset] : void 0;
      merged.push(mergeOverlappingTurns(localTurn, incomingTurn));
    }
    return {
      messages: merged,
      messageOffset: mergedOffset,
      messageTotal: Math.max(prevTotal, snapTotal, mergedOffset + merged.length)
    };
  }

  // src/web-ui/browser/chat-scroll.ts
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
    return Math.abs(el.scrollTop) < state.chatScrollThreshold;
  }
  function setChatStickToBottom(enabled) {
    state.chatStickToBottom = !!enabled;
    if (state.chatStickToBottom) clearChatUnread({ removeDivider: true });
    updateChatUnreadBubble();
  }
  function clearChatUnread(options) {
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
  function refreshChatUnreadDivider(chatMessages) {
    if (!chatMessages) chatMessages = getChatScrollElement();
    if (!chatMessages) return;
    var existing = chatMessages.querySelector(".chat-unread-divider");
    if (state.chatUnreadStartIndex < 0 || state.chatUnreadCount <= 0) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    var startIdx = state.chatUnreadStartIndex;
    var nodes = chatMessages.querySelectorAll(".chat-message");
    var boundary = null;
    for (var i = 0; i < nodes.length; i++) {
      var idxAttr = nodes[i].getAttribute("data-msg-index");
      if (idxAttr === null) continue;
      var idx = parseInt(idxAttr, 10);
      if (!isNaN(idx) && idx < startIdx) {
        boundary = nodes[i];
        break;
      }
    }
    var label = state.chatUnreadCount + " \u6761\u65B0\u6D88\u606F";
    if (!existing) {
      existing = document.createElement("div");
      existing.className = "chat-unread-divider";
      existing.setAttribute("role", "separator");
      existing.innerHTML = '<span class="chat-unread-divider-line"></span><span class="chat-unread-divider-label"></span><span class="chat-unread-divider-line"></span>';
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
  function updateChatUnreadBubble() {
    var bubble = document.getElementById("chat-unread-bubble");
    if (!bubble) return;
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var notAtBottom = !isChatNearBottom();
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
    var label = state.chatUnreadCount > 0 ? state.chatUnreadCount + " \u6761\u65B0\u6D88\u606F\uFF0C\u70B9\u51FB\u67E5\u770B" : "\u56DE\u5230\u6700\u65B0\u6D88\u606F";
    bubble.setAttribute("aria-label", label);
    bubble.setAttribute("title", label);
    var chatContainer = document.getElementById("chat-output");
    if (chatContainer) chatContainer.classList.toggle("has-jump-btn", shouldShow);
  }
  function releaseChatTurnPin() {
    removeChatPinSpacer();
  }
  function removeChatPinSpacer(chatMsgs) {
    var el = chatMsgs || getChatScrollElement();
    if (!el) return;
    var spacer = el.querySelector(".chat-pin-spacer");
    if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
  }
  function scrollChatToBottom(smooth) {
    var chatMsgs = getChatScrollElement();
    if (!chatMsgs || !chatMsgs.isConnected) return;
    releaseChatTurnPin();
    removeChatPinSpacer(chatMsgs);
    state.chatIsProgrammaticScroll = true;
    var done = function() {
      state.chatIsProgrammaticScroll = false;
      state.chatStickToBottom = true;
      clearChatUnread({ removeDivider: true });
      updateChatUnreadBubble();
    };
    if (smooth && typeof chatMsgs.scrollTo === "function") {
      chatMsgs.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(done, 260);
      return;
    }
    chatMsgs.scrollTop = 0;
    requestAnimationFrame(done);
  }
  function prepareChatBottomFollow() {
    var chatMsgs = getChatScrollElement();
    releaseChatTurnPin();
    if (chatMsgs) removeChatPinSpacer(chatMsgs);
    state.chatStickToBottom = true;
    clearChatUnread({ removeDivider: true });
    if (chatMsgs && chatMsgs.isConnected) {
      state.chatIsProgrammaticScroll = true;
      state.chatProgrammaticScrollUntil = Date.now() + 180;
      chatMsgs.scrollTop = 0;
      requestAnimationFrame(function() {
        state.chatIsProgrammaticScroll = false;
      });
    }
    updateChatUnreadBubble();
  }
  function bindChatScrollListener() {
    var chatMsgs = getChatScrollElement();
    if (!chatMsgs || !chatMsgs.isConnected) return;
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
      releaseChatTurnPin();
      state.chatStickToBottom = false;
      if (chatMsgs.querySelector(".chat-history-summary")) {
        renderChat(true);
      }
      updateChatUnreadBubble();
    }
    state.chatScrollHandler = function() {
      if (!chatMsgs.isConnected) return;
      if (state.chatIsProgrammaticScroll || Date.now() < state.chatProgrammaticScrollUntil) {
        updateChatUnreadBubble();
        return;
      }
      var atBottom = isChatNearBottom(chatMsgs);
      if (atBottom) {
        releaseChatTurnPin();
        state.chatStickToBottom = true;
        clearChatUnread({ removeDivider: true });
      } else {
        handleManualHistoryScroll();
        return;
      }
      updateChatUnreadBubble();
    };
    state.chatScrollWheelHandler = function(e) {
      if (state.chatIsProgrammaticScroll) return;
      if (e.deltaY < 0) {
        handleManualHistoryScroll();
      }
    };
    state.chatScrollTouchStartHandler = function(e) {
      if (!e.touches || e.touches.length === 0) return;
      state.chatTouchStartY = e.touches[0].clientY;
    };
    state.chatScrollTouchMoveHandler = function(e) {
      if (state.chatIsProgrammaticScroll) return;
      if (!e.touches || e.touches.length === 0) return;
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
  function loadMoreChatMessages() {
    if (state.chatRenderedCount < state.currentMessages.length) {
      state.chatRenderedCount += state.chatPageSize;
      renderChat(true);
      return;
    }
    var sess = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (sess && typeof sess.messageOffset === "number" && sess.messageOffset > 0) {
      fetchEarlierMessages();
    }
  }
  var _loadMoreObserver = null;
  function observeLoadMoreSentinel() {
    if (_loadMoreObserver) {
      _loadMoreObserver.disconnect();
      _loadMoreObserver = null;
    }
    var sentinel = document.getElementById("chat-load-more-sentinel");
    if (!sentinel) return;
    var btn = sentinel.querySelector(".chat-load-more-btn");
    if (btn) btn.onclick = function() {
      loadMoreChatMessages();
    };
    var coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    var mobileViewport = window.innerWidth <= 768;
    if (coarsePointer || mobileViewport || window.__wandImeNative || window.__wandIosNative) return;
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
  function persistSelectedId() {
    try {
      if (state.selectedId) {
        localStorage.setItem("wand-selected-session", state.selectedId);
      } else {
        localStorage.removeItem("wand-selected-session");
      }
    } catch (e) {
    }
  }
  function getStructuredQueuedInputs(session) {
    if (session && Array.isArray(session.queuedMessages)) {
      return session.queuedMessages;
    }
    return state.structuredInputQueue;
  }
  function getSelectedStructuredQueuedInputs() {
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
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
    var sessionKind = snapshot.sessionKind || existingSession && existingSession.sessionKind;
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
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
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
    }
  }
  function getConfigCwd() {
    return state.config && state.config.defaultCwd || "/tmp";
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
      if (part === void 0 || part === null || part === "") continue;
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
      case "subagent-reply":
        return el.getAttribute("data-expanded") === "true";
      case "subagent-panel":
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
          var preview = fullText.slice(0, 57) + (fullText.length > 60 ? "\u2026" : "");
          previewEl.textContent = expanded ? fullText : preview;
        }
        var actionEl = el.querySelector(".thinking-inline-action");
        if (actionEl) actionEl.textContent = expanded ? "\u6536\u8D77" : "\u5C55\u5F00";
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
        if (toggleIcon) toggleIcon.textContent = expanded ? "\u25BC" : "\u25B6";
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
        if (subLabel) subLabel.textContent = expanded ? "\u6536\u8D77" : "\u5C55\u5F00";
        var subToggleBtn = el.querySelector(".subagent-reply-toggle");
        if (subToggleBtn) {
          subToggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
          subToggleBtn.setAttribute("aria-label", expanded ? "\u6536\u8D77\u5B50\u4EE3\u7406\u56DE\u590D" : "\u5C55\u5F00\u5B50\u4EE3\u7406\u56DE\u590D\u5168\u6587");
        }
        break;
      }
      case "subagent-panel": {
        el.setAttribute("data-expanded", expanded ? "true" : "false");
        var panelBtns = el.querySelectorAll(".subagent-panel-toggle");
        for (var pbi = 0; pbi < panelBtns.length; pbi++) {
          var pb = panelBtns[pbi];
          pb.setAttribute("aria-expanded", expanded ? "true" : "false");
          pb.setAttribute("aria-label", expanded ? "\u6536\u8D77\u5B50\u4EE3\u7406\u8F93\u51FA" : "\u5C55\u5F00\u5B50\u4EE3\u7406\u8F93\u51FA");
          var pblbl = pb.querySelector(".subagent-panel-toggle-label");
          if (pblbl) pblbl.textContent = expanded ? "\u6536\u8D77" : "\u5C55\u5F00";
        }
        var pbody = el.querySelector(".subagent-panel-body");
        if (pbody) {
          if (expanded) {
            pbody.scrollTop = 0;
          } else {
            pbody.scrollTop = pbody.scrollHeight;
          }
        }
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

  // src/web-ui/browser/file-browser.ts
  function isMobileLayout() {
    return window.innerWidth <= 768;
  }
  function shouldShowSessionsBackdrop() {
    return !!state.sessionsDrawerOpen && (isMobileLayout() || !state.sidebarPinned);
  }
  function setFilePanelOpen(nextOpen) {
    state.filePanelOpen = nextOpen;
    try {
      localStorage.setItem("wand-file-panel-open", String(state.filePanelOpen));
    } catch (e) {
    }
    if (state.filePanelOpen && isMobileLayout()) {
      state.sessionsDrawerOpen = false;
      writeStoredBoolean("wand-sidebar-open", false);
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
    if (cwdEl.tagName === "INPUT") {
      if (document.activeElement !== cwdEl) {
        cwdEl.value = cwd;
        scrollInputToEnd(cwdEl);
      }
    } else {
      cwdEl.textContent = cwd;
    }
    cwdEl.title = cwd;
    var headerEl = cwdEl.closest(".file-explorer-header");
    if (headerEl) {
      scrollPathElementToEnd(headerEl);
    }
  }
  function closeFilePanel() {
    if (!state.filePanelOpen) return;
    setFilePanelOpen(false);
  }
  function adjustTerminalScale(delta) {
    var newScale = state.terminalScale + delta;
    newScale = Math.max(0.5, Math.min(2, newScale));
    newScale = Math.round(newScale * 4) / 4;
    if (newScale === state.terminalScale) return;
    state.terminalScale = newScale;
    try {
      localStorage.setItem("wand-terminal-scale", String(newScale));
    } catch (e) {
    }
    applyTerminalScale();
    updateScaleLabel();
  }
  function applyTerminalScale() {
    if (!state.terminal || !state.terminal.element) return;
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
  var WAND_FILE_ICONS = {
    "chevron-left": '<path d="M15 18l-6-6 6-6"/>',
    "arrow-up": '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
    "refresh": '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    "eye": '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off": '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a19.86 19.86 0 0 1 4.22-5.18"/><path d="M1 1l22 22"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a19.83 19.83 0 0 1-3.36 4.27"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
    "x": '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    "search": '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    "copy": '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    "clipboard": '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
    "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    "edit": '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    "save": '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
    "rotate-ccw": '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    "wrap-text": '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="M16 16l-2 2 2 2"/><path d="M3 18h6"/>',
    "type": '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    "minus": '<path d="M5 12h14"/>',
    "plus": '<path d="M12 5v14"/><path d="M5 12h14"/>',
    "send-to-input": '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    "terminal": '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    "folder-open": '<path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
    "info": '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
  };
  function wandFileIcon(name, opts) {
    opts = opts || {};
    var body = WAND_FILE_ICONS[name] || "";
    var size = opts.size || 16;
    var extraClass = opts.className ? " " + opts.className : "";
    return '<svg class="wand-icon wand-icon-' + name + extraClass + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }
  function renderFileExplorer(cwd) {
    var root = cwd || getConfigCwd();
    if (!root) {
      return '<div class="file-explorer empty">\u672A\u914D\u7F6E\u5DE5\u4F5C\u76EE\u5F55\u3002</div>';
    }
    return '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml2(root) + '"><div class="tree-loading">\u52A0\u8F7D\u4E2D\u2026</div></div>';
  }
  var FILE_ICON_MAP = {
    // images
    png: "\u{1F5BC}\uFE0F",
    jpg: "\u{1F5BC}\uFE0F",
    jpeg: "\u{1F5BC}\uFE0F",
    gif: "\u{1F5BC}\uFE0F",
    webp: "\u{1F5BC}\uFE0F",
    svg: "\u{1F5BC}\uFE0F",
    avif: "\u{1F5BC}\uFE0F",
    bmp: "\u{1F5BC}\uFE0F",
    ico: "\u{1F5BC}\uFE0F",
    heic: "\u{1F5BC}\uFE0F",
    heif: "\u{1F5BC}\uFE0F",
    // pdf / doc
    pdf: "\u{1F4D5}",
    doc: "\u{1F4D8}",
    docx: "\u{1F4D8}",
    odt: "\u{1F4D8}",
    xls: "\u{1F4CA}",
    xlsx: "\u{1F4CA}",
    csv: "\u{1F4CA}",
    tsv: "\u{1F4CA}",
    ppt: "\u{1F4D9}",
    pptx: "\u{1F4D9}",
    // video / audio
    mp4: "\u{1F3AC}",
    webm: "\u{1F3AC}",
    mov: "\u{1F3AC}",
    mkv: "\u{1F3AC}",
    m4v: "\u{1F3AC}",
    ogv: "\u{1F3AC}",
    mp3: "\u{1F3B5}",
    wav: "\u{1F3B5}",
    ogg: "\u{1F3B5}",
    m4a: "\u{1F3B5}",
    flac: "\u{1F3B5}",
    aac: "\u{1F3B5}",
    opus: "\u{1F3B5}",
    // archives
    zip: "\u{1F4E6}",
    tar: "\u{1F4E6}",
    gz: "\u{1F4E6}",
    tgz: "\u{1F4E6}",
    bz2: "\u{1F4E6}",
    "7z": "\u{1F4E6}",
    rar: "\u{1F4E6}",
    xz: "\u{1F4E6}",
    // markup / docs
    md: "\u{1F4DD}",
    markdown: "\u{1F4DD}",
    mdx: "\u{1F4DD}",
    rst: "\u{1F4DD}",
    txt: "\u{1F4DD}",
    log: "\u{1F4DD}",
    // web / styles
    html: "\u{1F310}",
    htm: "\u{1F310}",
    xml: "\u{1F310}",
    css: "\u{1F3A8}",
    scss: "\u{1F3A8}",
    less: "\u{1F3A8}",
    // configs
    json: "\u2699\uFE0F",
    jsonc: "\u2699\uFE0F",
    yaml: "\u2699\uFE0F",
    yml: "\u2699\uFE0F",
    toml: "\u2699\uFE0F",
    ini: "\u2699\uFE0F",
    cfg: "\u2699\uFE0F",
    conf: "\u2699\uFE0F",
    env: "\u2699\uFE0F",
    editorconfig: "\u2699\uFE0F",
    // code (default 📜)
    ts: "\u{1F4DC}",
    tsx: "\u{1F4DC}",
    js: "\u{1F4DC}",
    jsx: "\u{1F4DC}",
    mjs: "\u{1F4DC}",
    cjs: "\u{1F4DC}",
    py: "\u{1F4DC}",
    rb: "\u{1F4DC}",
    go: "\u{1F4DC}",
    rs: "\u{1F4DC}",
    java: "\u{1F4DC}",
    c: "\u{1F4DC}",
    cpp: "\u{1F4DC}",
    h: "\u{1F4DC}",
    hpp: "\u{1F4DC}",
    cs: "\u{1F4DC}",
    swift: "\u{1F4DC}",
    kt: "\u{1F4DC}",
    scala: "\u{1F4DC}",
    php: "\u{1F4DC}",
    sh: "\u{1F4DC}",
    bash: "\u{1F4DC}",
    zsh: "\u{1F4DC}",
    fish: "\u{1F4DC}",
    lua: "\u{1F4DC}",
    sql: "\u{1F4DC}",
    graphql: "\u{1F4DC}",
    proto: "\u{1F4DC}",
    vue: "\u{1F4DC}",
    svelte: "\u{1F4DC}",
    diff: "\u{1F4DC}",
    patch: "\u{1F4DC}",
    // fonts / binary
    ttf: "\u{1F524}",
    otf: "\u{1F524}",
    woff: "\u{1F524}",
    woff2: "\u{1F524}",
    eot: "\u{1F524}"
  };
  function getFileIcon(item) {
    if (!item) return "\u{1F4C4}";
    if (item.type === "dir") return "\u{1F4C1}";
    var name = (item.name || "").toLowerCase();
    if (name === "dockerfile") return "\u{1F433}";
    if (name === "makefile") return "\u{1F6E0}\uFE0F";
    if (name === "license") return "\u{1F4DC}";
    if (name === "readme") return "\u{1F4DD}";
    var dot = name.lastIndexOf(".");
    if (dot < 0 || dot === name.length - 1) return "\u{1F4C4}";
    var ext = name.slice(dot + 1);
    return FILE_ICON_MAP[ext] || "\u{1F4C4}";
  }
  function formatFileSize(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return bytes + " B";
    var kb = bytes / 1024;
    if (kb < 1024) return (kb >= 10 ? Math.round(kb) : kb.toFixed(1)) + " KB";
    var mb = kb / 1024;
    if (mb < 1024) return (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + " MB";
    var gb = mb / 1024;
    return (gb >= 10 ? Math.round(gb) : gb.toFixed(1)) + " GB";
  }
  function formatRelativeTime(iso) {
    if (!iso) return "";
    var t15 = Date.parse(iso);
    if (isNaN(t15)) return "";
    return new Date(t15).toLocaleString();
  }
  function getEffectiveExplorerCwd() {
    if (state.fileExplorerCwd) return state.fileExplorerCwd;
    if (state.selectedId) {
      var session = state.sessions.find(function(s) {
        return s.id === state.selectedId;
      });
      if (session && session.cwd) return session.cwd;
    }
    return getConfigCwd();
  }
  function refreshFileExplorer(opts) {
    opts = opts || {};
    var explorer = document.getElementById("file-explorer");
    var cwdEl = document.getElementById("file-explorer-cwd");
    if (!explorer) return;
    var cwd = opts.cwd || getEffectiveExplorerCwd();
    if (!cwd) {
      explorer.innerHTML = '<div class="file-explorer empty">\u6CA1\u6709\u53EF\u663E\u793A\u7684\u5DE5\u4F5C\u76EE\u5F55\u3002</div>';
      return;
    }
    state.fileExplorerCwd = cwd;
    state.fileExplorerLoading = true;
    state.allFiles = [];
    state.fileExplorerTruncated = false;
    state.fileExplorerTotal = 0;
    explorer.innerHTML = '<div class="file-explorer"><div class="tree-loading" style="padding:12px;color:var(--text-muted);font-size:0.8125rem;">\u52A0\u8F7D\u4E2D\u2026</div></div>';
    if (cwdEl) {
      if (cwdEl.tagName === "INPUT") {
        if (document.activeElement !== cwdEl) {
          cwdEl.value = cwd;
        }
      } else {
        cwdEl.textContent = cwd;
      }
      cwdEl.title = cwd;
    }
    var url = "/api/directory?q=" + encodeURIComponent(cwd) + "&gitStatus=true";
    fetch(url, { credentials: "same-origin" }).then(function(res) {
      if (!res.ok) throw new Error("Failed to load directory.");
      return res.json();
    }).then(function(payload) {
      state.fileExplorerLoading = false;
      var items, truncated, total;
      if (Array.isArray(payload)) {
        items = payload;
        truncated = false;
        total = payload.length;
      } else {
        items = payload && payload.items || [];
        truncated = !!(payload && payload.truncated);
        total = payload && payload.total || items.length;
      }
      if (!items || items.length === 0) {
        explorer.innerHTML = '<div class="file-explorer empty">\u7A7A\u76EE\u5F55\u6216\u65E0\u6CD5\u8BBF\u95EE\u3002</div>';
        return;
      }
      state.allFiles = items;
      state.fileExplorerTruncated = truncated;
      state.fileExplorerTotal = total;
      filterFileTree();
    }).catch(function() {
      state.fileExplorerLoading = false;
      explorer.innerHTML = '<div class="file-explorer empty">\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8DEF\u5F84\u6216\u6743\u9650\u3002</div>';
    });
  }
  function filterFileTree() {
    var explorer = document.getElementById("file-explorer");
    if (!explorer) return;
    var cwd = state.fileExplorerCwd || "";
    if (!cwd) return;
    var query = state.fileSearchQuery;
    var items = state.allFiles || [];
    var filtered = items;
    if (query) {
      var lowerQuery = query.toLowerCase();
      filtered = items.filter(function(item) {
        return item.name.toLowerCase().indexOf(lowerQuery) !== -1;
      });
    }
    if (filtered.length === 0) {
      explorer.innerHTML = '<div class="file-explorer empty">' + (query ? "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u6587\u4EF6" : "\u7A7A\u76EE\u5F55") + "</div>";
      return;
    }
    var truncatedNotice = "";
    if (!query && state.fileExplorerTruncated) {
      var shown = items.length;
      truncatedNotice = '<div class="tree-truncated" title="\u540E\u7AEF\u6309\u5B57\u6BCD\u5E8F\u6700\u591A\u8FD4\u56DE ' + shown + ' \u9879">\u663E\u793A\u524D ' + shown + " \u9879 / \u5171 " + state.fileExplorerTotal + " \u9879</div>";
    }
    explorer.innerHTML = '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml2(cwd) + '">' + filtered.map(function(item) {
      return renderFileTreeItem(item);
    }).join("") + "</div>" + truncatedNotice;
    attachFileTreeListeners();
  }
  function renderFileTreeItem(item, depth) {
    depth = depth || 0;
    var name = escapeHtml2(item.name);
    var isDir = item.type === "dir";
    var displayIcon = getFileIcon(item);
    var toggleIcon = isDir ? "\u25B8" : "";
    var toggleClass = isDir ? "" : " empty";
    var gitStatus = item.gitStatus;
    var statusBadge = renderGitStatusBadge(gitStatus);
    var meta = "";
    if (!isDir && typeof item.size === "number") {
      meta = '<span class="tree-meta" title="\u5927\u5C0F\uFF1A' + escapeHtml2(formatFileSize(item.size)) + (item.mtime ? "\n\u4FEE\u6539\u65F6\u95F4\uFF1A" + escapeHtml2(formatRelativeTime(item.mtime)) : "") + '">' + escapeHtml2(formatFileSize(item.size)) + "</span>";
    }
    return '<div class="tree-item" data-path="' + escapeHtml2(item.path) + '" data-type="' + escapeHtml2(item.type) + '" data-name="' + escapeHtml2(item.name) + '" tabindex="0"><span class="tree-toggle' + toggleClass + '">' + toggleIcon + '</span><span class="tree-icon">' + displayIcon + '</span><span class="tree-name">' + name + "</span>" + meta + (statusBadge ? '<span class="git-status-badge ' + statusBadge.class + '" title="' + statusBadge.title + '">' + statusBadge.text + "</span>" : "") + "</div>";
  }
  function renderGitStatusBadge(gitStatus) {
    if (!gitStatus) return null;
    if (gitStatus.staged === "added") return { text: "A", class: "git-added", title: "\u5DF2\u6682\u5B58\uFF08\u65B0\u589E\uFF09" };
    if (gitStatus.staged === "modified") return { text: "M", class: "git-modified", title: "\u5DF2\u6682\u5B58\uFF08\u4FEE\u6539\uFF09" };
    if (gitStatus.staged === "deleted") return { text: "D", class: "git-deleted", title: "\u5DF2\u6682\u5B58\uFF08\u5220\u9664\uFF09" };
    if (gitStatus.staged === "renamed") return { text: "R", class: "git-renamed", title: "\u5DF2\u6682\u5B58\uFF08\u91CD\u547D\u540D\uFF09" };
    if (gitStatus.unstaged === "modified") return { text: "M", class: "git-unstaged", title: "\u672A\u6682\u5B58\uFF08\u4FEE\u6539\uFF09" };
    if (gitStatus.unstaged === "deleted") return { text: "D", class: "git-unstaged-deleted", title: "\u672A\u6682\u5B58\uFF08\u5220\u9664\uFF09" };
    if (gitStatus.untracked) return { text: "?", class: "git-untracked", title: "\u672A\u8DDF\u8E2A" };
    return null;
  }
  function attachFileTreeListeners() {
    var tree = document.getElementById("file-tree");
    if (!tree) return;
    tree.querySelectorAll(".tree-item[data-type='dir']").forEach(function(item) {
      item.addEventListener("click", function(e) {
        toggleTreeNode(item);
      });
    });
    tree.querySelectorAll(".tree-item[data-type='file']").forEach(function(item) {
      var openHandler = function() {
        openFilePreview(item.dataset.path);
      };
      item.addEventListener("click", openHandler);
      item.addEventListener("dblclick", openHandler);
    });
    var pressTimer = null;
    var pressFired = false;
    tree.querySelectorAll(".tree-item").forEach(function(item) {
      item.addEventListener("contextmenu", function(e) {
        e.preventDefault();
        showFileContextMenu(e.clientX, e.clientY, item);
      });
      item.addEventListener("touchstart", function(e) {
        pressFired = false;
        pressTimer = setTimeout(function() {
          pressFired = true;
          var t15 = e.touches && e.touches[0];
          showFileContextMenu(t15 ? t15.clientX : 0, t15 ? t15.clientY : 0, item);
        }, 500);
      }, { passive: true });
      item.addEventListener("touchend", function() {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      });
      item.addEventListener("touchmove", function() {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      });
    });
  }
  function toggleTreeNode(item) {
    var p = item.dataset.path;
    var toggle = item.querySelector(".tree-toggle");
    var children = item.nextElementSibling;
    if (children && children.classList.contains("tree-children")) {
      var isOpen = children.classList.contains("open");
      children.classList.toggle("open");
      if (toggle) toggle.classList.toggle("open", !isOpen);
      var iconEl = item.querySelector(".tree-icon");
      if (iconEl) iconEl.textContent = isOpen ? "\u{1F4C1}" : "\u{1F4C2}";
      return;
    }
    if (toggle) toggle.classList.add("open");
    var iconEl2 = item.querySelector(".tree-icon");
    if (iconEl2) iconEl2.textContent = "\u{1F4C2}";
    var url = "/api/directory?q=" + encodeURIComponent(p) + "&gitStatus=true";
    fetch(url, { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(payload) {
      var items;
      if (Array.isArray(payload)) items = payload;
      else items = payload && payload.items || [];
      var childrenDiv = document.createElement("div");
      childrenDiv.className = "tree-children open";
      if (!items || items.length === 0) {
        childrenDiv.innerHTML = '<div class="tree-item" style="color:var(--text-muted);cursor:default;"><span class="tree-toggle empty">\u25B8</span><span class="tree-name">\uFF08\u7A7A\u76EE\u5F55\uFF09</span></div>';
      } else {
        childrenDiv.innerHTML = items.map(function(child) {
          return renderFileTreeItem(child);
        }).join("");
      }
      item.parentNode.insertBefore(childrenDiv, item.nextSibling);
      attachFileTreeListeners();
    }).catch(function() {
    });
  }
  function navigateExplorerUp() {
    var cwd = getEffectiveExplorerCwd();
    if (!cwd) return;
    var parent = cwd.replace(/\/+$/, "").replace(/\/[^\/]+$/, "");
    if (!parent) parent = "/";
    if (parent === cwd) return;
    refreshFileExplorer({ cwd: parent });
  }
  function appendToComposer(text) {
    var inputBox = document.getElementById("input-box");
    if (!inputBox) return false;
    var current = inputBox.value || "";
    var sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
    inputBox.value = current + sep + text;
    inputBox.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      inputBox.focus();
      inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length);
    } catch (e) {
    }
    return true;
  }
  function copyTextSafely(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function() {
        return true;
      }).catch(function() {
        return fallback();
      });
    }
    return Promise.resolve(fallback());
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    }
  }
  function showToastIfPossible(msg) {
    if (typeof window.showToast === "function") {
      window.showToast(msg);
      return;
    }
    var t15 = document.createElement("div");
    t15.className = "wand-mini-toast";
    t15.textContent = msg;
    document.body.appendChild(t15);
    setTimeout(function() {
      t15.classList.add("show");
    }, 10);
    setTimeout(function() {
      t15.classList.remove("show");
      setTimeout(function() {
        t15.remove();
      }, 220);
    }, 1600);
  }
  function dismissFileContextMenu() {
    var menu = document.getElementById("file-context-menu");
    if (menu) menu.remove();
    document.removeEventListener("click", dismissFileContextMenu, true);
    document.removeEventListener("scroll", dismissFileContextMenu, true);
  }
  function showFileContextMenu(x, y, item) {
    dismissFileContextMenu();
    var fullPath = item.dataset.path || "";
    var type = item.dataset.type || "file";
    var cwd = state.fileExplorerCwd || "";
    var relativePath = fullPath;
    if (cwd && fullPath.indexOf(cwd) === 0) {
      relativePath = fullPath.slice(cwd.length).replace(/^\/+/, "") || ".";
    }
    var menu = document.createElement("div");
    menu.id = "file-context-menu";
    menu.className = "file-context-menu";
    var actions = [];
    if (type === "file") {
      actions.push({ label: "\u6253\u5F00\u9884\u89C8", icon: "\u{1F441}", run: function() {
        openFilePreview(fullPath);
      } });
    } else {
      actions.push({ label: "\u8FDB\u5165\u6B64\u76EE\u5F55", icon: "\u{1F4C2}", run: function() {
        refreshFileExplorer({ cwd: fullPath });
      } });
    }
    actions.push({ label: "\u590D\u5236\u5B8C\u6574\u8DEF\u5F84", icon: "\u{1F4CB}", run: function() {
      copyTextSafely(fullPath).then(function() {
        showToastIfPossible("\u5DF2\u590D\u5236\u8DEF\u5F84");
      });
    } });
    if (relativePath && relativePath !== fullPath) {
      actions.push({ label: "\u590D\u5236\u76F8\u5BF9\u8DEF\u5F84", icon: "\u{1F4CB}", run: function() {
        copyTextSafely(relativePath).then(function() {
          showToastIfPossible("\u5DF2\u590D\u5236\u76F8\u5BF9\u8DEF\u5F84");
        });
      } });
    }
    actions.push({ label: "\u7C98\u8D34\u8DEF\u5F84\u5230\u8F93\u5165\u6846", icon: "\u270F\uFE0F", run: function() {
      if (appendToComposer(fullPath)) showToastIfPossible("\u5DF2\u7C98\u8D34\u5230\u8F93\u5165\u6846");
    } });
    if (type === "file") {
      actions.push({ label: "\u4E0B\u8F7D\u6587\u4EF6", icon: "\u2B07", run: function() {
        var a = document.createElement("a");
        a.href = "/api/file-raw?download=1&path=" + encodeURIComponent(fullPath);
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } });
    }
    menu.innerHTML = actions.map(function(act, i) {
      return '<button type="button" class="file-context-menu-item" data-idx="' + i + '"><span class="ctx-icon">' + act.icon + '</span><span class="ctx-label">' + escapeHtml2(act.label) + "</span></button>";
    }).join("");
    document.body.appendChild(menu);
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var rect = menu.getBoundingClientRect();
    var left = Math.min(x, vw - rect.width - 8);
    var top = Math.min(y, vh - rect.height - 8);
    menu.style.left = Math.max(8, left) + "px";
    menu.style.top = Math.max(8, top) + "px";
    menu.querySelectorAll(".file-context-menu-item").forEach(function(btn) {
      btn.addEventListener("click", function(ev) {
        ev.stopPropagation();
        var idx = parseInt(btn.dataset.idx, 10);
        dismissFileContextMenu();
        if (actions[idx]) actions[idx].run();
      });
    });
    setTimeout(function() {
      document.addEventListener("click", dismissFileContextMenu, true);
      document.addEventListener("scroll", dismissFileContextMenu, true);
    }, 0);
  }
  var _activeFilePreview = null;
  function openFilePreview(filePath) {
    var overlay = _activeFilePreview && _activeFilePreview.overlay;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "file-preview-overlay";
      overlay.innerHTML = '<div class="file-preview-modal" tabindex="-1"><div class="file-preview-header"><div class="file-preview-title"><span class="file-preview-icon">\u{1F4C4}</span><div class="file-preview-name-block"><div class="file-preview-name-row"><span class="file-preview-filename">\u52A0\u8F7D\u4E2D\u2026</span></div>' + renderTailMarqueePath("", "file-preview-path") + '</div></div><div class="file-preview-toolbar"></div><button class="file-preview-close" title="\u5173\u95ED (Esc)" aria-label="\u5173\u95ED">' + wandFileIcon("x", { size: 18 }) + '</button></div><div class="file-preview-body"><div class="file-preview-loading">\u52A0\u8F7D\u9884\u89C8\u2026</div></div></div>';
      document.body.appendChild(overlay);
      var closeBtn = overlay.querySelector(".file-preview-close");
      var closeModal = function() {
        if (_activeFilePreview && _activeFilePreview.dirty) {
          if (typeof openWandDialog === "function") {
            openWandDialog({
              type: "warning",
              title: "\u653E\u5F03\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF1F",
              message: "\u5F53\u524D\u6587\u4EF6\u6709\u672A\u4FDD\u5B58\u7684\u6539\u52A8\uFF0C\u5173\u95ED\u540E\u4F1A\u4E22\u5931\u3002",
              buttons: [
                { label: "\u7EE7\u7EED\u7F16\u8F91", value: false, kind: "ghost" },
                { label: "\u653E\u5F03\u4FEE\u6539", value: true, kind: "danger", autofocus: true }
              ],
              cancelValue: false
            }).then(function(go) {
              if (go) doClose();
            });
            return;
          }
        }
        doClose();
      };
      var doClose = function() {
        overlay.remove();
        document.removeEventListener("keydown", keyHandler);
        _activeFilePreview = null;
      };
      closeBtn.addEventListener("click", closeModal);
      overlay.addEventListener("click", function(e) {
        if (e.target === overlay) closeModal();
      });
      var keyHandler = function(e) {
        if ((e.key === "s" || e.key === "S") && (e.ctrlKey || e.metaKey)) {
          if (_activeFilePreview && _activeFilePreview.editing) {
            e.preventDefault();
            saveFileEdit();
            return;
          }
        }
        if (e.key === "Escape") {
          if (_activeFilePreview && _activeFilePreview.editing) {
            e.preventDefault();
            exitFileEdit();
            return;
          }
          closeModal();
          return;
        }
        if (!_activeFilePreview) return;
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
        if (_activeFilePreview.editing) return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          navigatePreviewSibling(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          navigatePreviewSibling(1);
        }
      };
      document.addEventListener("keydown", keyHandler);
      _activeFilePreview = { overlay, close: closeModal, path: filePath, data: null, editing: false, dirty: false };
    } else {
      _activeFilePreview.path = filePath;
      _activeFilePreview.editing = false;
      _activeFilePreview.dirty = false;
      var titleEl = overlay.querySelector(".file-preview-title");
      if (titleEl) {
        titleEl.innerHTML = '<span class="file-preview-icon">\u{1F4C4}</span><div class="file-preview-name-block"><div class="file-preview-name-row"><span class="file-preview-filename">\u52A0\u8F7D\u4E2D\u2026</span></div>' + renderTailMarqueePath("", "file-preview-path") + "</div>";
      }
      var toolbarEl = overlay.querySelector(".file-preview-toolbar");
      if (toolbarEl) toolbarEl.innerHTML = "";
      var pathEl = overlay.querySelector(".file-preview-path");
      setTailMarqueePathText(pathEl, "");
      var bodyReset = overlay.querySelector(".file-preview-body");
      if (bodyReset) bodyReset.innerHTML = '<div class="file-preview-loading">\u52A0\u8F7D\u9884\u89C8\u2026</div>';
    }
    var pathDisplayEl = overlay.querySelector(".file-preview-path");
    setTailMarqueePathText(pathDisplayEl, filePath);
    fetch("/api/file-preview?path=" + encodeURIComponent(filePath), { credentials: "same-origin" }).then(function(res) {
      return res.json().then(function(data) {
        return { ok: res.ok, status: res.status, data };
      });
    }).then(function(result) {
      var body = overlay.querySelector(".file-preview-body");
      if (!result.ok || result.data && result.data.error) {
        var msg = result.data && result.data.error || "\u52A0\u8F7D\u5931\u8D25";
        if (result.status === 413 && result.data && result.data.size) {
          msg += "\uFF08\u6587\u4EF6\u5927\u5C0F\uFF1A" + formatFileSize(result.data.size) + "\uFF09";
        }
        body.innerHTML = '<div class="file-preview-error"><span class="preview-error-icon">\u26A0</span><span>' + escapeHtml2(msg) + "</span></div>";
        if (result.status === 413) {
          renderPreviewToolbar(overlay, {
            kind: "binary",
            path: filePath,
            name: filePath.split("/").pop() || filePath,
            ext: "",
            size: result.data && result.data.size || 0
          });
        }
        return;
      }
      _activeFilePreview.data = result.data;
      renderPreviewContent(overlay, result.data);
    }).catch(function() {
      var body = overlay.querySelector(".file-preview-body");
      body.innerHTML = '<div class="file-preview-error"><span class="preview-error-icon">\u26A0</span><span>\u52A0\u8F7D\u9884\u89C8\u5931\u8D25</span></div>';
    });
  }
  function navigatePreviewSibling(direction) {
    if (!_activeFilePreview) return;
    var siblings = (state.allFiles || []).filter(function(item) {
      return item.type === "file";
    });
    if (!siblings.length) return;
    var currentPath = _activeFilePreview.path;
    var idx = -1;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].path === currentPath) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    var nextIdx = (idx + direction + siblings.length) % siblings.length;
    var nextPath = siblings[nextIdx].path;
    if (nextPath && nextPath !== currentPath) openFilePreview(nextPath);
  }
  function renderPreviewContent(overlay, data) {
    var filenameEl = overlay.querySelector(".file-preview-filename");
    if (filenameEl) filenameEl.textContent = data.name;
    var iconEl = overlay.querySelector(".file-preview-icon");
    if (iconEl) iconEl.textContent = getFileIcon({ name: data.name, type: "file" });
    var titleEl = overlay.querySelector(".file-preview-title");
    var existingBadge = overlay.querySelector(".file-preview-lang");
    if (existingBadge) existingBadge.remove();
    var langBadge = document.createElement("span");
    langBadge.className = "file-preview-lang";
    var labelMap = { image: "\u56FE\u7247", pdf: "PDF", video: "\u89C6\u9891", audio: "\u97F3\u9891", binary: "\u4E8C\u8FDB\u5236" };
    if (data.kind === "text") {
      langBadge.textContent = data.lang || (data.ext || "").replace(".", "") || "text";
    } else {
      langBadge.textContent = labelMap[data.kind] || (data.ext || "").replace(".", "") || data.kind;
    }
    if (titleEl) titleEl.appendChild(langBadge);
    renderPreviewToolbar(overlay, data);
    var body = overlay.querySelector(".file-preview-body");
    body.innerHTML = "";
    body.classList.remove("kind-text", "kind-image", "kind-pdf", "kind-video", "kind-audio", "kind-binary");
    body.classList.add("kind-" + (data.kind || "text"));
    if (data.kind === "image") {
      renderImagePreview(body, data);
    } else if (data.kind === "pdf") {
      renderPdfPreview(body, data);
    } else if (data.kind === "video") {
      renderVideoPreview(body, data);
    } else if (data.kind === "audio") {
      renderAudioPreview(body, data);
    } else if (data.kind === "binary") {
      renderBinaryPreview(body, data);
    } else if (data.lang === "markdown" || /\.(md|markdown|mdx)$/i.test(data.name || "")) {
      body.innerHTML = '<div class="markdown-preview">' + renderMarkdownPreview(data.content || "") + "</div>";
    } else {
      renderTextPreview(body, data);
    }
  }
  function renderTextPreview(body, data) {
    var highlighted = highlightCodePreview(data.content || "", data.lang);
    var lines = highlighted.split("\n");
    var lineNums = lines.map(function(_, i) {
      return i + 1;
    });
    body.innerHTML = '<div class="code-preview-wrapper"><div class="code-preview-lines">' + lineNums.join("\n") + '</div><div class="code-preview-content"><pre>' + lines.join("\n") + "</pre></div></div>";
  }
  function renderImagePreview(body, data) {
    var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
    body.innerHTML = '<div class="image-preview-wrapper"><img class="image-preview-img" src="' + src + '" alt="' + escapeHtml2(data.name) + '" /></div>';
    var img = body.querySelector(".image-preview-img");
    if (!img) return;
    var zoomed = false;
    img.addEventListener("click", function() {
      zoomed = !zoomed;
      img.classList.toggle("zoomed", zoomed);
    });
  }
  function renderPdfPreview(body, data) {
    var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
    body.innerHTML = '<iframe class="pdf-preview-frame" src="' + src + '" title="' + escapeHtml2(data.name) + '"></iframe>';
  }
  function renderVideoPreview(body, data) {
    var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
    body.innerHTML = '<div class="media-preview-wrapper"><video class="media-preview-video" controls preload="metadata" src="' + src + '">\u60A8\u7684\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 video \u6807\u7B7E\u3002</video><div class="media-preview-meta">' + escapeHtml2(formatFileSize(data.size)) + "</div></div>";
  }
  function renderAudioPreview(body, data) {
    var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
    body.innerHTML = '<div class="media-preview-wrapper audio"><div class="media-preview-icon">\u{1F3B5}</div><div class="media-preview-name">' + escapeHtml2(data.name) + '</div><audio class="media-preview-audio" controls preload="metadata" src="' + src + '">\u60A8\u7684\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 audio \u6807\u7B7E\u3002</audio><div class="media-preview-meta">' + escapeHtml2(formatFileSize(data.size)) + "</div></div>";
  }
  function renderBinaryPreview(body, data) {
    var rawUrl = "/api/file-raw?download=1&path=" + encodeURIComponent(data.path);
    body.innerHTML = '<div class="binary-preview-card"><div class="binary-preview-icon">\u{1F4E6}</div><div class="binary-preview-name">' + escapeHtml2(data.name) + '</div><div class="binary-preview-meta"><span>' + escapeHtml2((data.ext || "").replace(/^\./, "") || "\u672A\u77E5\u683C\u5F0F") + "</span><span>\xB7</span><span>" + escapeHtml2(formatFileSize(data.size)) + "</span></div>" + renderTailMarqueePath(data.path, "binary-preview-path") + '<div class="binary-preview-actions"><a class="binary-preview-btn" href="' + rawUrl + '" download="' + escapeHtml2(data.name) + '">\u4E0B\u8F7D\u6587\u4EF6</a><button class="binary-preview-btn" type="button" data-action="view-cat">\u5728\u7EC8\u7AEF\u4E2D\u67E5\u770B</button></div></div>';
    refreshTailMarqueePaths(body);
    var catBtn = body.querySelector('[data-action="view-cat"]');
    if (catBtn) catBtn.addEventListener("click", function() {
      if (appendToComposer('cat -- "' + data.path + '"')) {
        showToastIfPossible("\u547D\u4EE4\u5DF2\u7C98\u8D34\u5230\u8F93\u5165\u6846");
      }
    });
  }
  function renderPreviewToolbar(overlay, data) {
    var bar = overlay.querySelector(".file-preview-toolbar");
    if (!bar) return;
    bar.innerHTML = "";
    bar.classList.remove("editing");
    if (_activeFilePreview && _activeFilePreview.editing) {
      bar.classList.add("editing");
      renderEditToolbar(overlay, data);
      return;
    }
    var buttons = [];
    if (data.kind === "text") {
      buttons.push({ label: "\u7F16\u8F91\u6587\u4EF6 (E)", icon: wandFileIcon("edit"), primary: true, action: function() {
        enterFileEdit();
      } });
    }
    buttons.push({ label: "\u590D\u5236\u8DEF\u5F84", icon: wandFileIcon("clipboard"), action: function() {
      copyTextSafely(data.path).then(function() {
        showToastIfPossible("\u5DF2\u590D\u5236\u8DEF\u5F84");
      });
    } });
    buttons.push({ label: "\u7C98\u8D34\u5230\u8F93\u5165\u6846", icon: wandFileIcon("send-to-input"), action: function() {
      if (appendToComposer(data.path)) showToastIfPossible("\u5DF2\u7C98\u8D34\u5230\u8F93\u5165\u6846");
    } });
    buttons.push({ label: "\u4E0B\u8F7D", icon: wandFileIcon("download"), action: function() {
      var a = document.createElement("a");
      a.href = "/api/file-raw?download=1&path=" + encodeURIComponent(data.path);
      a.download = data.name || "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } });
    if (data.kind === "text") {
      buttons.push({ label: "\u590D\u5236\u5168\u90E8\u5185\u5BB9", icon: wandFileIcon("copy"), action: function() {
        copyTextSafely(data.content || "").then(function() {
          showToastIfPossible("\u5DF2\u590D\u5236\u5185\u5BB9");
        });
      } });
      buttons.push({
        label: "\u5207\u6362\u81EA\u52A8\u6362\u884C",
        icon: wandFileIcon("wrap-text"),
        toggleClass: "toolbar-active",
        getInitial: function() {
          var pre = overlay.querySelector(".code-preview-content pre");
          return pre && pre.classList.contains("wrap");
        },
        action: function(btn) {
          var pre = overlay.querySelector(".code-preview-content pre");
          if (!pre) return;
          pre.classList.toggle("wrap");
          btn.classList.toggle("toolbar-active", pre.classList.contains("wrap"));
        }
      });
      buttons.push({
        kind: "group",
        className: "toolbar-group-fontsize",
        children: [
          { label: "\u7F29\u5C0F\u5B57\u53F7", icon: wandFileIcon("minus"), action: function() {
            adjustPreviewFontSize(overlay, -1);
          } },
          { kind: "label", icon: wandFileIcon("type"), label: "\u5B57\u53F7" },
          { label: "\u653E\u5927\u5B57\u53F7", icon: wandFileIcon("plus"), action: function() {
            adjustPreviewFontSize(overlay, 1);
          } }
        ]
      });
    }
    renderToolbarButtons(bar, buttons, overlay);
  }
  function renderToolbarButtons(bar, buttons, overlay) {
    buttons.forEach(function(b) {
      if (b.kind === "group") {
        var group = document.createElement("div");
        group.className = "file-preview-toolbar-group" + (b.className ? " " + b.className : "");
        b.children.forEach(function(child) {
          if (child.kind === "label") {
            var lab = document.createElement("span");
            lab.className = "file-preview-toolbar-grouplabel";
            lab.title = child.label || "";
            lab.innerHTML = child.icon || "";
            group.appendChild(lab);
            return;
          }
          group.appendChild(buildToolbarButton(child));
        });
        bar.appendChild(group);
        return;
      }
      bar.appendChild(buildToolbarButton(b));
    });
  }
  function buildToolbarButton(b) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-preview-toolbar-btn";
    if (b.primary) btn.classList.add("primary");
    if (b.danger) btn.classList.add("danger");
    btn.title = b.label;
    btn.setAttribute("aria-label", b.label);
    btn.innerHTML = '<span class="toolbar-icon">' + (b.icon || "") + "</span>" + (b.text ? '<span class="toolbar-text">' + escapeHtml2(b.text) + "</span>" : "");
    if (b.getInitial && b.getInitial()) btn.classList.add("toolbar-active");
    btn.addEventListener("click", function(ev) {
      ev.stopPropagation();
      if (typeof b.action === "function") b.action(btn);
    });
    return btn;
  }
  function renderEditToolbar(overlay, data) {
    var bar = overlay.querySelector(".file-preview-toolbar");
    if (!bar) return;
    bar.innerHTML = "";
    var saving = _activeFilePreview && _activeFilePreview.saving;
    var buttons = [
      {
        label: "\u4FDD\u5B58 (Ctrl+S)",
        icon: wandFileIcon("save"),
        text: "\u4FDD\u5B58",
        primary: true,
        action: function() {
          saveFileEdit();
        }
      },
      {
        label: "\u64A4\u9500\u6539\u52A8",
        icon: wandFileIcon("rotate-ccw"),
        action: function() {
          revertFileEdit();
        }
      },
      {
        label: "\u9000\u51FA\u7F16\u8F91 (Esc)",
        icon: wandFileIcon("x"),
        action: function() {
          exitFileEdit();
        }
      }
    ];
    renderToolbarButtons(bar, buttons, overlay);
    if (saving) {
      bar.querySelectorAll(".file-preview-toolbar-btn").forEach(function(b) {
        b.disabled = true;
      });
    }
  }
  function enterFileEdit() {
    if (!_activeFilePreview || !_activeFilePreview.data) return;
    var data = _activeFilePreview.data;
    if (data.kind !== "text") return;
    _activeFilePreview.editing = true;
    _activeFilePreview.dirty = false;
    _activeFilePreview.originalContent = data.content || "";
    var overlay = _activeFilePreview.overlay;
    var body = overlay.querySelector(".file-preview-body");
    if (!body) return;
    body.classList.add("editing");
    body.innerHTML = '<div class="code-editor-wrapper"><textarea class="code-editor-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" wrap="off"></textarea></div>';
    var ta = body.querySelector(".code-editor-textarea");
    if (ta) {
      ta.value = data.content || "";
      ta.addEventListener("input", function() {
        var dirty = ta.value !== (_activeFilePreview.originalContent || "");
        if (dirty !== _activeFilePreview.dirty) {
          _activeFilePreview.dirty = dirty;
          updateDirtyBadge();
        }
      });
      ta.addEventListener("keydown", function(e) {
        if (e.key === "Tab") {
          e.preventDefault();
          var start = ta.selectionStart, end = ta.selectionEnd;
          var indent = "  ";
          ta.value = ta.value.slice(0, start) + indent + ta.value.slice(end);
          ta.selectionStart = ta.selectionEnd = start + indent.length;
          ta.dispatchEvent(new Event("input"));
        }
      });
      setTimeout(function() {
        ta.focus();
        ta.setSelectionRange(0, 0);
        ta.scrollTop = 0;
      }, 30);
    }
    renderPreviewToolbar(overlay, data);
    updateDirtyBadge();
  }
  function exitFileEdit() {
    if (!_activeFilePreview || !_activeFilePreview.editing) return;
    var doExit = function() {
      _activeFilePreview.editing = false;
      _activeFilePreview.dirty = false;
      var overlay = _activeFilePreview.overlay;
      var body = overlay.querySelector(".file-preview-body");
      if (body) body.classList.remove("editing");
      renderPreviewContent(overlay, _activeFilePreview.data);
      updateDirtyBadge();
    };
    if (_activeFilePreview.dirty && typeof openWandDialog === "function") {
      openWandDialog({
        type: "warning",
        title: "\u653E\u5F03\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF1F",
        message: "\u5F53\u524D\u6587\u4EF6\u6709\u672A\u4FDD\u5B58\u7684\u6539\u52A8\uFF0C\u9000\u51FA\u7F16\u8F91\u540E\u4F1A\u4E22\u5931\u3002",
        buttons: [
          { label: "\u7EE7\u7EED\u7F16\u8F91", value: false, kind: "ghost" },
          { label: "\u653E\u5F03\u4FEE\u6539", value: true, kind: "danger", autofocus: true }
        ],
        cancelValue: false
      }).then(function(go) {
        if (go) doExit();
      });
      return;
    }
    doExit();
  }
  function revertFileEdit() {
    if (!_activeFilePreview || !_activeFilePreview.editing) return;
    var overlay = _activeFilePreview.overlay;
    var ta = overlay.querySelector(".code-editor-textarea");
    if (!ta) return;
    ta.value = _activeFilePreview.originalContent || "";
    _activeFilePreview.dirty = false;
    updateDirtyBadge();
    ta.focus();
  }
  function saveFileEdit() {
    if (!_activeFilePreview || !_activeFilePreview.editing) return;
    if (_activeFilePreview.saving) return;
    var overlay = _activeFilePreview.overlay;
    var ta = overlay.querySelector(".code-editor-textarea");
    if (!ta) return;
    var newContent = ta.value;
    if (newContent === (_activeFilePreview.originalContent || "")) {
      showToastIfPossible("\u6CA1\u6709\u6539\u52A8");
      return;
    }
    _activeFilePreview.saving = true;
    renderEditToolbar(overlay, _activeFilePreview.data);
    fetch("/api/file-write", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: _activeFilePreview.path, content: newContent })
    }).then(function(res) {
      return res.json().then(function(json) {
        return { ok: res.ok, status: res.status, data: json };
      });
    }).then(function(result) {
      _activeFilePreview.saving = false;
      if (!result.ok || result.data && result.data.error) {
        var msg = result.data && result.data.error || "\u4FDD\u5B58\u5931\u8D25 (" + result.status + ")";
        showToastIfPossible(msg);
        renderEditToolbar(overlay, _activeFilePreview.data);
        return;
      }
      _activeFilePreview.data.content = newContent;
      _activeFilePreview.data.size = result.data && result.data.size || newContent.length;
      _activeFilePreview.originalContent = newContent;
      _activeFilePreview.dirty = false;
      showToastIfPossible("\u5DF2\u4FDD\u5B58");
      updateDirtyBadge();
      renderEditToolbar(overlay, _activeFilePreview.data);
      if (typeof refreshFileExplorer === "function") {
        try {
          refreshFileExplorer();
        } catch (e) {
        }
      }
    }).catch(function(err) {
      _activeFilePreview.saving = false;
      showToastIfPossible("\u4FDD\u5B58\u5931\u8D25\uFF1A" + (err && err.message ? err.message : "\u7F51\u7EDC\u9519\u8BEF"));
      renderEditToolbar(overlay, _activeFilePreview.data);
    });
  }
  function updateDirtyBadge() {
    if (!_activeFilePreview) return;
    var overlay = _activeFilePreview.overlay;
    if (!overlay) return;
    var row = overlay.querySelector(".file-preview-name-row");
    if (!row) return;
    var existing = row.querySelector(".file-preview-dirty");
    if (_activeFilePreview.dirty) {
      if (!existing) {
        var dot = document.createElement("span");
        dot.className = "file-preview-dirty";
        dot.title = "\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539";
        dot.textContent = "\u25CF \u672A\u4FDD\u5B58";
        row.appendChild(dot);
      }
    } else if (existing) {
      existing.remove();
    }
  }
  function adjustPreviewFontSize(overlay, delta) {
    var pre = overlay.querySelector(".code-preview-content pre");
    var nums = overlay.querySelector(".code-preview-lines");
    if (!pre) return;
    var current = parseFloat(getComputedStyle(pre).fontSize) || 13;
    var next = Math.max(10, Math.min(22, current + delta));
    pre.style.fontSize = next + "px";
    if (nums) nums.style.fontSize = next + "px";
  }
  function highlightCodePreview(code, lang) {
    var escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    var tokens = getSyntaxTokens();
    if (!tokens) return escaped;
    var patterns = [];
    for (var category in tokens) {
      var t15 = tokens[category];
      if (t15 && t15.pattern) {
        patterns.push({ pattern: t15.pattern, cls: t15.cls, priority: t15.priority || 5 });
      }
    }
    patterns.sort(function(a, b) {
      return b.priority - a.priority;
    });
    var allPatterns = patterns.map(function(p) {
      return "(" + p.pattern.source + ")";
    });
    var regex = new RegExp(allPatterns.join("|"), "gm");
    return escaped.replace(regex, function(match) {
      for (var i = 0; i < patterns.length; i++) {
        var p = patterns[i];
        var re = new RegExp("^" + p.pattern.source + "$", "gm");
        if (re.test(match)) {
          return '<span class="' + p.cls + '">' + match + "</span>";
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
    var escaped = escapeHtml2(text);
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
      var highlighted = highlightCodePreview(code.trim(), lang);
      var protectedHighlighted = highlighted.replace(/_/g, "&#95;").replace(/\*/g, "&#42;");
      return '<pre><code class="language-' + lang + '">' + protectedHighlighted + "</code></pre>";
    });
    escaped = escaped.replace(/`([^`]+)`/g, function(_, code) {
      return "<code>" + code.replace(/_/g, "&#95;").replace(/\*/g, "&#42;") + "</code>";
    });
    escaped = escaped.replace(/^######\s+(.*)$/gm, "<h6>$1</h6>");
    escaped = escaped.replace(/^#####\s+(.*)$/gm, "<h5>$1</h5>");
    escaped = escaped.replace(/^####\s+(.*)$/gm, "<h4>$1</h4>");
    escaped = escaped.replace(/^###\s+(.*)$/gm, "<h3>$1</h3>");
    escaped = escaped.replace(/^##\s+(.*)$/gm, "<h2>$1</h2>");
    escaped = escaped.replace(/^#\s+(.*)$/gm, "<h1>$1</h1>");
    escaped = escaped.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/\*(.+?)\*/g, "<em>$1</em>");
    escaped = escaped.replace(/(^|[^\w])___(\S(?:[^\n]*?\S)?)___(?!\w)/g, "$1<strong><em>$2</em></strong>");
    escaped = escaped.replace(/(^|[^\w])__(\S(?:[^\n]*?\S)?)__(?!\w)/g, "$1<strong>$2</strong>");
    escaped = escaped.replace(/(^|[^\w])_(\S(?:[^\n_]*?\S)?)_(?!\w)/g, "$1<em>$2</em>");
    escaped = escaped.replace(/~~(.+?)~~/g, "<del>$1</del>");
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
    escaped = escaped.replace(/^&gt;\s+(.*)$/gm, "<blockquote>$1</blockquote>");
    escaped = escaped.replace(/^---+$/gm, "<hr>");
    escaped = escaped.replace(/^\*\*\*+$/gm, "<hr>");
    escaped = escaped.replace(/^[\-\*]\s+(.*)$/gm, "<li>$1</li>");
    escaped = escaped.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
    escaped = escaped.replace(/^\d+\.\s+(.*)$/gm, "<li>$1</li>");
    escaped = parseMarkdownTables(escaped);
    var paragraphs = escaped.split(/\n{2,}/);
    escaped = paragraphs.map(function(p) {
      p = p.trim();
      if (!p) return "";
      if (/^<(h[1-6]|ul|ol|li|blockquote|pre|table|hr|div)/.test(p)) return p;
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("\n");
    return escaped;
  }

  // src/web-ui/browser/git-commit.ts
  function renderTopbarGitBadgeHtml() {
    if (!state.selectedId || !state.gitStatus || !state.gitStatus.isGit) return "";
    if (state.gitStatusSessionId !== state.selectedId) return "";
    var branch = state.gitStatus.branch || "?";
    var count = state.gitStatus.modifiedCount || 0;
    var titleText = branch + (count ? "  \xB7  " + count + " \u4E2A\u6587\u4EF6\u5F85\u63D0\u4EA4" : "  \xB7  \u5DE5\u4F5C\u533A\u5E72\u51C0");
    return '<button id="topbar-git-badge" class="topbar-git-badge" type="button" title="' + escapeHtml2(titleText) + '" aria-label="\u5FEB\u6377\u63D0\u4EA4"><svg class="topbar-git-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8"/><path d="M18 11v1a3 3 0 0 1-3 3H9"/></svg><span class="topbar-git-branch">' + escapeHtml2(branch) + "</span>" + (count > 0 ? '<span class="topbar-git-count">\xB7' + count + "</span>" : '<span class="topbar-git-clean" aria-hidden="true">\u2713</span>') + "</button>";
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
  function renderTopbarMoreMenuHtml(session) {
    if (!session) return "";
    var open = state.topbarMoreOpen;
    var hasClaudeId = !!session.claudeSessionId;
    var hasCwd = !!session.cwd;
    var canOpenMerge = session.worktreeEnabled && session.worktree && session.worktree.branch && session.worktree.path;
    var needsCleanup = session.worktreeMergeStatus === "merged" && session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false;
    var mergeDisabled = session.status === "running" || session.worktreeMergeStatus === "merging";
    var showMerge = canOpenMerge && session.worktreeMergeStatus !== "merged";
    var showCleanup = needsCleanup;
    var hasInfoGroup = hasClaudeId || hasCwd || true;
    var hasActionGroup = showMerge || showCleanup || true;
    var copyIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    var cloudIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.5-8.74A6 6 0 1 0 6 14h11.5z"/></svg>';
    var folderIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    var hashIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>';
    var mergeIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10"/><path d="M7 12h10"/><path d="M7 17h10"/><path d="M5 7l-2 2 2 2"/><path d="M19 15l2 2-2 2"/></svg>';
    var trashIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>';
    var infoItems = "";
    if (hasClaudeId) {
      var historyIdLabel = session.provider === "codex" ? "\u590D\u5236 Codex thread ID" : session.provider === "opencode" ? "\u590D\u5236 OpenCode session ID" : "\u590D\u5236 Claude \u4F1A\u8BDD ID";
      infoItems += '<button class="topbar-more-item" data-action="copy-claude-session-id" type="button" role="menuitem">' + cloudIconSvg + "<span>" + historyIdLabel + "</span></button>";
    }
    if (hasCwd) {
      infoItems += '<button class="topbar-more-item" data-action="copy-cwd" type="button" role="menuitem">' + folderIconSvg + "<span>\u590D\u5236\u5DE5\u4F5C\u76EE\u5F55</span></button>";
    }
    infoItems += '<button class="topbar-more-item" data-action="copy-session-id" type="button" role="menuitem">' + hashIconSvg + "<span>\u590D\u5236\u4F1A\u8BDD ID</span></button>";
    var actionItems = "";
    if (showMerge) {
      actionItems += '<button class="topbar-more-item" data-action="worktree-merge" type="button" role="menuitem"' + (mergeDisabled ? " disabled" : "") + ">" + mergeIconSvg + "<span>\u5408\u5E76\u5230\u4E3B\u5206\u652F\u2026</span></button>";
    } else if (showCleanup) {
      actionItems += '<button class="topbar-more-item" data-action="worktree-cleanup" type="button" role="menuitem">' + mergeIconSvg + "<span>\u91CD\u8BD5 worktree \u6E05\u7406</span></button>";
    }
    actionItems += '<button class="topbar-more-item topbar-more-item-danger" data-action="delete-session" type="button" role="menuitem">' + trashIconSvg + "<span>\u5220\u9664\u5F53\u524D\u4F1A\u8BDD</span></button>";
    var divider = hasInfoGroup && hasActionGroup ? '<div class="topbar-more-divider" role="separator"></div>' : "";
    return '<div class="topbar-more-wrap"><button id="topbar-more-button" class="topbar-btn square' + (open ? " active" : "") + '" type="button" aria-label="\u5F53\u524D\u4F1A\u8BDD\u64CD\u4F5C" aria-haspopup="menu" aria-expanded="' + (open ? "true" : "false") + '" title="\u5F53\u524D\u4F1A\u8BDD\u64CD\u4F5C"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg></button><div id="topbar-more-menu" class="topbar-more-menu' + (open ? "" : " hidden") + '" role="menu" aria-label="\u5F53\u524D\u4F1A\u8BDD">' + infoItems + divider + actionItems + "</div></div>";
  }
  function loadGitStatus(sessionId, options) {
    if (!sessionId) return Promise.resolve(null);
    var force = options && options.force;
    var now = Date.now();
    if (!force && state.gitStatusSessionId === sessionId && state.gitStatus && now - state.gitStatusLastFetchAt < 1e3) {
      return Promise.resolve(state.gitStatus);
    }
    if (state.gitStatusInflight && state.gitStatusInflight.sessionId === sessionId) {
      return state.gitStatusInflight.promise;
    }
    state.gitStatusLoading = true;
    var promise = fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/git-status", {
      credentials: "same-origin"
    }).then(function(res) {
      return res.ok ? res.json() : { isGit: false };
    }).then(function(data) {
      state.gitStatus = data || { isGit: false };
      state.gitStatusSessionId = sessionId;
      state.gitStatusLastFetchAt = Date.now();
      updateTopbarGitBadge();
      return data;
    }).catch(function() {
      state.gitStatus = { isGit: false };
      state.gitStatusSessionId = sessionId;
      state.gitStatusLastFetchAt = Date.now();
      updateTopbarGitBadge();
      return null;
    }).finally(function() {
      state.gitStatusLoading = false;
      if (state.gitStatusInflight && state.gitStatusInflight.sessionId === sessionId) {
        state.gitStatusInflight = null;
      }
    });
    state.gitStatusInflight = { sessionId, promise };
    return promise;
  }
  var quickCommitEscHandler = null;
  var quickCommitDragCleanup = null;
  var quickCommitDragState = null;
  function normalizeQuickCommitAction(value) {
    if (value === "commit-tag" || value === "commit-tag-push" || value === "commit-push") return value;
    return "commit";
  }
  function getQuickCommitActionMeta(action) {
    action = normalizeQuickCommitAction(action);
    if (action === "commit-tag-push") {
      return {
        action,
        label: "Commit + Tag + Push",
        verb: "\u63D0\u4EA4\u3001\u6253 Tag \u5E76\u63A8\u9001",
        withTag: true,
        push: true,
        tone: "all"
      };
    }
    if (action === "commit-tag") {
      return {
        action,
        label: "Commit + Tag",
        verb: "\u63D0\u4EA4\u5E76\u6253 Tag",
        withTag: true,
        push: false,
        tone: "tag"
      };
    }
    if (action === "commit-push") {
      return {
        action,
        label: "Commit + Push",
        verb: "\u63D0\u4EA4\u5E76\u63A8\u9001",
        withTag: false,
        push: true,
        tone: "push"
      };
    }
    return {
      action: "commit",
      label: "Commit",
      verb: "\u4EC5\u63D0\u4EA4",
      withTag: false,
      push: false,
      tone: "commit"
    };
  }
  function openQuickCommitModal() {
    if (!state.selectedId) return;
    state.quickCommitOpen = true;
    state.quickCommitSubmitting = false;
    state.quickCommitAutoGenerating = false;
    state.quickCommitError = "";
    state.quickCommitForm = {
      customMessage: "",
      tag: "",
      // Whether the user has manually edited the tag (so we stop auto-overwriting it).
      tagEdited: false
    };
    state.quickCommitPushing = false;
    state.quickCommitPushError = "";
    state.quickCommitResult = null;
    state.quickCommitDragAction = "commit";
    closeWorktreeMergeModal();
    closeSessionModal();
    closeSettingsModal();
    rerenderQuickCommitModal();
    var modal = document.getElementById("quick-commit-modal");
    if (modal) {
      modal.classList.remove("hidden");
      state.lastFocusedElement = document.activeElement;
      setupFocusTrap(modal);
    }
    if (quickCommitEscHandler) document.removeEventListener("keydown", quickCommitEscHandler);
    quickCommitEscHandler = function(e) {
      if (e.key === "Escape" && state.quickCommitOpen && !state.quickCommitSubmitting && !state.quickCommitPushing) {
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
    state.quickCommitResult = null;
    state.quickCommitDragAction = "commit";
    var modal = document.getElementById("quick-commit-modal");
    if (modal) modal.classList.add("hidden");
    if (state.focusTrapHandler) {
      document.removeEventListener("keydown", state.focusTrapHandler);
      state.focusTrapHandler = null;
    }
    if (quickCommitEscHandler) {
      document.removeEventListener("keydown", quickCommitEscHandler);
      quickCommitEscHandler = null;
    }
    if (quickCommitDragCleanup) {
      quickCommitDragCleanup();
      quickCommitDragCleanup = null;
    }
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
      state.lastFocusedElement.focus();
    }
  }
  function rerenderQuickCommitModal() {
    var modal = document.getElementById("quick-commit-modal");
    if (!modal) return;
    if (quickCommitDragCleanup) {
      quickCommitDragCleanup();
      quickCommitDragCleanup = null;
    }
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
    var aiBtn = document.getElementById("quick-commit-ai-btn");
    if (aiBtn) aiBtn.addEventListener("click", generateCommitMessageAI);
    var msgEl = document.getElementById("quick-commit-message");
    if (msgEl) {
      msgEl.addEventListener("input", function() {
        state.quickCommitForm.customMessage = msgEl.value;
      });
      msgEl.addEventListener("keydown", function(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          submitQuickCommit("commit");
        }
      });
    }
    var tagInput = document.getElementById("quick-commit-tag");
    if (tagInput) {
      tagInput.addEventListener("input", function() {
        state.quickCommitForm.tag = tagInput.value;
        state.quickCommitForm.tagEdited = true;
      });
      tagInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          submitQuickCommit("commit-tag");
        }
      });
    }
    var pushAfterBtn = document.getElementById("quick-commit-push-after-btn");
    if (pushAfterBtn) pushAfterBtn.addEventListener("click", function() {
      var result = state.quickCommitResult || {};
      submitPushOnly({ pushCommits: true, pushTags: !!result.tagName, closeOnSuccess: true });
    });
    attachQuickCommitDrag();
  }
  function composeOrbAction(attached) {
    var hasTag = !!(attached && attached.tag);
    var hasPush = !!(attached && attached.push);
    if (hasTag && hasPush) return "commit-tag-push";
    if (hasTag) return "commit-tag";
    if (hasPush) return "commit-push";
    return "commit";
  }
  var QC_DOCK_PICKUP_R = 58;
  var QC_DOCK_SUB_HIT_PAD = 10;
  function qcChipTapIntent(id) {
    if (id === "tag") return { action: "commit-tag", sub: false };
    if (id === "push") return { action: "commit-push", sub: false };
    if (id === "sub") return { action: "commit", sub: true };
    return { action: "commit", sub: false };
  }
  function attachQuickCommitDrag() {
    var field = document.getElementById("qc-dock-field");
    var stage = document.getElementById("qc-dock-stage");
    var launch = document.getElementById("qc-dock-launch");
    var cluster = document.getElementById("qc-dock-cluster");
    if (!field || !stage || !launch || !cluster) return;
    var ACTION_ORDER = ["commit", "tag", "push"];
    var chips = {};
    ACTION_ORDER.forEach(function(id) {
      chips[id] = field.querySelector('[data-chip="' + id + '"]');
    });
    if (!chips.commit || !chips.tag || !chips.push) return;
    chips.sub = field.querySelector('[data-chip="sub"]');
    var hasSub = !!chips.sub;
    var ALL = hasSub ? ACTION_ORDER.concat(["sub"]) : ACTION_ORDER;
    function cw(id) {
      return chips[id] ? chips[id].offsetWidth : 90;
    }
    function chH() {
      return chips.commit ? chips.commit.offsetHeight : 38;
    }
    function isCompactDock() {
      return window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
    }
    function homePositions() {
      var fw = field.clientWidth, fh = field.clientHeight, H = chH();
      var commitW = cw("commit"), tagW = cw("tag"), pushW = cw("push");
      if (isCompactDock() && hasSub) {
        var topY2 = Math.max(8, fh * 0.2 - H / 2);
        var botY2 = Math.min(fh - H - 8, fh * 0.7 - H / 2);
        var colL = function(w) {
          return Math.max(8, fw * 0.27 - w / 2);
        };
        var colR = function(w) {
          return Math.min(fw - w - 8, fw * 0.73 - w / 2);
        };
        return {
          commit: { x: colL(commitW), y: topY2 },
          tag: { x: colR(tagW), y: topY2 },
          push: { x: colL(pushW), y: botY2 },
          sub: { x: colR(cw("sub")), y: botY2 }
        };
      }
      var compact = isCompactDock();
      var topY = compact ? Math.max(8, fh * 0.18 - H / 2) : Math.max(8, fh * 0.12);
      var bottomY = compact ? Math.min(fh - H - 8, fh * 0.72 - H / 2) : Math.min(fh - H - 8, fh * 0.88 - H);
      var leftRatio = compact ? 0.24 : 0.28;
      var rightRatio = compact ? 0.76 : 0.72;
      var pos = {
        commit: { x: Math.max(8, (fw - commitW) / 2), y: topY },
        tag: { x: Math.max(8, fw * leftRatio - tagW / 2), y: bottomY },
        push: { x: Math.min(fw - pushW - 8, fw * rightRatio - pushW / 2), y: bottomY }
      };
      if (hasSub) {
        var subW = cw("sub");
        pos.sub = {
          x: Math.min(fw - subW - 8, fw * 0.94 - subW / 2),
          y: Math.max(8, Math.min(fh - H - 8, (fh - H) / 2))
        };
      }
      return pos;
    }
    var home = {};
    function placeChip(id, x, y) {
      if (chips[id]) chips[id].style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)";
    }
    function layoutHome(animated) {
      home = homePositions();
      ALL.forEach(function(id) {
        chips[id].classList.toggle("qc-chip--anim", !!animated);
        placeChip(id, home[id].x, home[id].y);
      });
    }
    layoutHome(false);
    var drag = null;
    function layoutCluster(members, cx, cy) {
      var H = chH(), stackStep = 24;
      var ids = ALL.filter(function(id) {
        return members.indexOf(id) >= 0;
      });
      var widest = ids.reduce(function(w, id) {
        return Math.max(w, cw(id));
      }, 0);
      var total = widest + Math.max(0, ids.length - 1) * stackStep;
      var fh = field.clientHeight;
      var x = cx - total / 2;
      var y = Math.max(2, Math.min(fh - H - 2, cy - H / 2));
      ids.forEach(function(id) {
        placeChip(id, x, y);
        x += stackStep;
      });
      return { x: cx - total / 2 - 7, y: y - 7, w: total + 14, h: H + 14 };
    }
    function showCluster(box) {
      cluster.classList.add("is-active");
      cluster.style.transform = "translate(" + box.x.toFixed(1) + "px," + box.y.toFixed(1) + "px)";
      cluster.style.width = box.w.toFixed(1) + "px";
      cluster.style.height = box.h.toFixed(1) + "px";
    }
    function hideCluster() {
      cluster.classList.remove("is-active");
    }
    function clusterAction(members) {
      return composeOrbAction({
        commit: true,
        tag: members.indexOf("tag") >= 0,
        push: members.indexOf("push") >= 0
      });
    }
    function clusterIncludesSub(members) {
      return members.indexOf("sub") >= 0;
    }
    function setLaunchLabel(t15) {
      var l = document.getElementById("qc-dock-launch-label");
      if (l) l.textContent = t15;
    }
    function pointInLaunch(x, y) {
      var r = launch.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    function onDown(id) {
      return function(e) {
        if (chips[id].disabled || isQuickCommitOpInFlight()) return;
        drag = { anchor: id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, members: [id] };
        ALL.forEach(function(m) {
          chips[m].classList.remove("qc-chip--anim");
        });
        chips[id].classList.add("is-grabbing");
        try {
          chips[id].setPointerCapture(e.pointerId);
        } catch (err) {
        }
        stage.classList.add("is-dragging");
        e.preventDefault();
      };
    }
    function onMove(e) {
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
      var fr = field.getBoundingClientRect();
      var fx = e.clientX - fr.left, fy = e.clientY - fr.top;
      ACTION_ORDER.forEach(function(id) {
        if (drag.members.indexOf(id) >= 0) return;
        var hx = home[id].x + cw(id) / 2, hy = home[id].y + chH() / 2;
        var dx = fx - hx, dy = fy - hy;
        if (Math.sqrt(dx * dx + dy * dy) < QC_DOCK_PICKUP_R) {
          drag.members.push(id);
          chips[id].classList.remove("qc-chip--anim");
          chips[id].classList.add("is-attached");
        }
      });
      if (hasSub && drag.members.indexOf("sub") < 0) {
        var sx0 = home.sub.x - QC_DOCK_SUB_HIT_PAD, sy0 = home.sub.y - QC_DOCK_SUB_HIT_PAD;
        var sx1 = home.sub.x + cw("sub") + QC_DOCK_SUB_HIT_PAD, sy1 = home.sub.y + chH() + QC_DOCK_SUB_HIT_PAD;
        if (fx >= sx0 && fx <= sx1 && fy >= sy0 && fy <= sy1) {
          drag.members.push("sub");
          chips.sub.classList.remove("qc-chip--anim");
          chips.sub.classList.add("is-attached");
        }
      }
      var box = layoutCluster(drag.members, fx, fy);
      var hot = pointInLaunch(e.clientX, e.clientY);
      stage.setAttribute("data-hot", hot ? "1" : "0");
      stage.setAttribute("data-action", clusterAction(drag.members));
      if (drag.members.length > 1) showCluster(box);
      else hideCluster();
      setLaunchLabel(hot ? "\u677E\u624B\u6267\u884C" : "\u63D0\u4EA4");
    }
    function endDrag(e, cancelled) {
      if (!drag || drag.pointerId !== e.pointerId) return;
      var cur = drag;
      drag = null;
      stage.classList.remove("is-dragging");
      stage.setAttribute("data-hot", "0");
      setLaunchLabel("\u63D0\u4EA4");
      hideCluster();
      ALL.forEach(function(m) {
        chips[m].classList.remove("is-grabbing", "is-attached");
      });
      try {
        chips[cur.anchor].releasePointerCapture(cur.pointerId);
      } catch (err) {
      }
      if (!cancelled && !cur.moved) {
        var tap = qcChipTapIntent(cur.anchor);
        submitQuickCommit(tap.action, tap.sub);
        return;
      }
      if (!cancelled && pointInLaunch(e.clientX, e.clientY)) {
        submitQuickCommit(clusterAction(cur.members), clusterIncludesSub(cur.members));
        return;
      }
      stage.setAttribute("data-action", "commit");
      layoutHome(true);
    }
    var onResize = function() {
      if (state.quickCommitOpen && !drag) layoutHome(false);
    };
    window.addEventListener("resize", onResize);
    ALL.forEach(function(id) {
      var c = chips[id];
      c.addEventListener("pointerdown", onDown(id));
      c.addEventListener("pointermove", onMove);
      c.addEventListener("pointerup", function(e) {
        endDrag(e, false);
      });
      c.addEventListener("pointercancel", function(e) {
        endDrag(e, true);
      });
      c.addEventListener("keydown", function(e) {
        if (c.disabled || isQuickCommitOpInFlight()) return;
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          var tap = qcChipTapIntent(id);
          submitQuickCommit(tap.action, tap.sub);
        }
      });
    });
    launch.addEventListener("click", function() {
      if (launch.disabled || isQuickCommitOpInFlight() || drag) return;
      submitQuickCommit("commit");
    });
    quickCommitDragCleanup = function() {
      window.removeEventListener("resize", onResize);
      drag = null;
    };
  }
  function generateCommitMessageAI() {
    if (!state.selectedId || state.quickCommitGenerating) return;
    var msgEl = document.getElementById("quick-commit-message");
    if (msgEl) state.quickCommitForm.customMessage = msgEl.value;
    var tagEl = document.getElementById("quick-commit-tag");
    if (tagEl) state.quickCommitForm.tag = tagEl.value;
    state.quickCommitGenerating = true;
    state.quickCommitError = "";
    rerenderQuickCommitModal();
    fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/generate-commit-message", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }).then(function(res) {
      return res.json().then(function(data) {
        return { ok: res.ok, data };
      });
    }).then(function(result) {
      if (!result.ok) throw new Error(result.data && result.data.error || "AI \u751F\u6210\u5931\u8D25\u3002");
      var data = result.data || {};
      var aiMessage = typeof data.message === "string" ? data.message : "";
      var aiTag = typeof data.suggestedTag === "string" ? data.suggestedTag.trim() : "";
      var currentMessage = (state.quickCommitForm.customMessage || "").trim();
      if (!currentMessage && aiMessage) {
        state.quickCommitForm.customMessage = aiMessage;
      }
      if (aiTag) {
        if (!state.quickCommitForm.tagEdited) state.quickCommitForm.tag = aiTag;
        state.quickCommitDragAction = "commit-tag";
      }
    }).catch(function(error) {
      state.quickCommitError = error && error.message || "AI \u751F\u6210\u5931\u8D25\u3002";
    }).finally(function() {
      state.quickCommitGenerating = false;
      if (state.quickCommitOpen) rerenderQuickCommitModal();
    });
  }
  function submitQuickCommit(action, includeSubmodule) {
    if (!state.selectedId || state.quickCommitSubmitting) return;
    var msgEl = document.getElementById("quick-commit-message");
    if (msgEl) state.quickCommitForm.customMessage = msgEl.value;
    var tagEl = document.getElementById("quick-commit-tag");
    if (tagEl) state.quickCommitForm.tag = tagEl.value;
    var form = state.quickCommitForm || {};
    var meta = getQuickCommitActionMeta(action || state.quickCommitDragAction || "commit");
    var withTag = meta.withTag;
    var userTag = withTag ? (form.tag || "").trim() : "";
    var message = (form.customMessage || "").trim();
    var autoMessage = !message;
    var before = {
      branch: (state.gitStatus || {}).branch || "",
      commitHash: (state.gitStatus || {}).lastCommit && (state.gitStatus || {}).lastCommit.shortHash ? (state.gitStatus || {}).lastCommit.shortHash : (state.gitStatus || {}).head ? (state.gitStatus || {}).head.substring(0, 7) : "",
      commitSubject: (state.gitStatus || {}).lastCommit && (state.gitStatus || {}).lastCommit.subject ? (state.gitStatus || {}).lastCommit.subject : "",
      tag: (state.gitStatus || {}).latestTag || ""
    };
    var payload = {
      autoMessage,
      customMessage: autoMessage ? "" : message,
      tag: userTag,
      autoTag: !!(withTag && !userTag),
      push: !!meta.push,
      // 正交 scope flag：是否把 commit/tag/push 递归进入各 submodule 内部。
      submodule: !!includeSubmodule
    };
    state.quickCommitSubmitting = true;
    state.quickCommitSubmoduleIntent = !!includeSubmodule;
    state.quickCommitAutoGenerating = autoMessage || payload.autoTag;
    state.quickCommitError = "";
    state.quickCommitPushError = "";
    state.quickCommitResult = null;
    state.quickCommitDragAction = meta.action;
    rerenderQuickCommitModal();
    fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/quick-commit", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function(res) {
      return res.json().then(function(data) {
        return { ok: res.ok, data };
      });
    }).then(function(result) {
      if (!result.ok) throw new Error(result.data && result.data.error || "\u5FEB\u6377\u63D0\u4EA4\u5931\u8D25\u3002");
      var data = result.data || {};
      var hash = data.commit && data.commit.hash ? data.commit.hash.substring(0, 7) : "";
      var tagName = data.tag && data.tag.name ? data.tag.name : "";
      var subCommits = Array.isArray(data.submoduleCommits) ? data.submoduleCommits : [];
      var subPrefix = subCommits.length > 0 ? "\u5DF2\u5148\u63D0\u4EA4 " + subCommits.length + " \u4E2A submodule\uFF08" + subCommits.map(function(c) {
        return c.path;
      }).join("\u3001") + "\uFF09\uFF0C" : "";
      var base = subPrefix + "\u5DF2\u63D0\u4EA4" + (hash ? " " + hash : "") + (tagName ? "\uFF0C\u5DF2\u6253 Tag " + tagName : "");
      state.quickCommitResult = {
        action: meta.action,
        includeSubmodule: !!includeSubmodule,
        pushed: !!data.pushed,
        pushError: data.pushError || "",
        commitHash: hash,
        commitMessage: data.commit && data.commit.message ? data.commit.message : message,
        tagName,
        oldTag: before.tag,
        oldCommitHash: before.commitHash,
        oldCommitSubject: before.commitSubject,
        submoduleCount: subCommits.length
      };
      if (meta.push && !data.pushError) {
        if (typeof showToast2 === "function") showToast2(base + "\uFF0C\u5DF2\u63A8\u9001\u3002", "success");
        closeQuickCommitModal();
      } else {
        if (typeof showToast2 === "function") {
          showToast2(base + (data.pushError ? "\uFF1Bpush \u5931\u8D25\uFF1A" + data.pushError : "\u3002"), data.pushError ? "error" : "success");
        }
        if (state.selectedId) loadGitStatus(state.selectedId, { force: true }).then(function() {
          if (state.quickCommitOpen) rerenderQuickCommitModal();
        });
      }
    }).catch(function(error) {
      state.quickCommitError = error && error.message || "\u5FEB\u6377\u63D0\u4EA4\u5931\u8D25\u3002";
    }).finally(function() {
      state.quickCommitSubmitting = false;
      state.quickCommitAutoGenerating = false;
      if (state.quickCommitOpen) rerenderQuickCommitModal();
    });
  }
  function submitPushOnly(opts) {
    if (!state.selectedId || state.quickCommitPushing) return;
    var pushCommits = !!(opts && opts.pushCommits);
    var pushTags = !!(opts && opts.pushTags);
    var closeOnSuccess = !!(opts && opts.closeOnSuccess);
    if (!pushCommits && !pushTags) return;
    var priorResult = state.quickCommitResult || {};
    var includeSubmodule = !!priorResult.includeSubmodule;
    state.quickCommitPushing = true;
    state.quickCommitPushError = "";
    rerenderQuickCommitModal();
    fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/git/push", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushCommits, pushTags, submodule: includeSubmodule, tag: priorResult.tagName || "" })
    }).then(function(res) {
      return res.json().then(function(data) {
        return { ok: res.ok, data };
      });
    }).then(function(result) {
      var data = result.data || {};
      if (!result.ok) throw new Error(data && data.error || "\u63A8\u9001\u5931\u8D25\u3002");
      if (data.error) {
        state.quickCommitPushError = data.error;
        if (typeof showToast2 === "function") showToast2("\u63A8\u9001\u5931\u8D25\uFF1A" + data.error, "error");
        return;
      }
      var parts = [];
      if (data.pushedCommits) parts.push("commits");
      if (data.pushedTags) parts.push("tags");
      var label = parts.length ? parts.join(" \u548C ") : "\uFF08\u65E0\u5185\u5BB9\uFF09";
      if (typeof showToast2 === "function") showToast2("\u5DF2\u63A8\u9001 " + label, "success");
      if (state.quickCommitResult) state.quickCommitResult.pushed = true;
      if (closeOnSuccess) {
        closeQuickCommitModal();
        if (state.selectedId) loadGitStatus(state.selectedId, { force: true });
      } else if (state.selectedId) {
        loadGitStatus(state.selectedId, { force: true }).then(function() {
          if (state.quickCommitOpen) rerenderQuickCommitModal();
        });
      }
    }).catch(function(error) {
      state.quickCommitPushError = error && error.message || "\u63A8\u9001\u5931\u8D25\u3002";
      if (typeof showToast2 === "function") showToast2(state.quickCommitPushError, "error");
    }).finally(function() {
      state.quickCommitPushing = false;
      if (state.quickCommitOpen) rerenderQuickCommitModal();
    });
  }
  function qcStatusBadge(status) {
    var raw = (status || "").trim();
    if (raw === "??") return { letter: "U", cls: "untracked", title: "\u672A\u8DDF\u8E2A" };
    if (raw === "!!") return { letter: "I", cls: "ignored", title: "\u5DF2\u5FFD\u7565" };
    var c = "";
    for (var i = 0; i < status.length; i++) {
      if (status[i] && status[i] !== "." && status[i] !== " ") {
        c = status[i];
        break;
      }
    }
    c = (c || raw[0] || "?").toUpperCase();
    var map = {
      A: { cls: "add", title: "\u65B0\u589E" },
      M: { cls: "mod", title: "\u4FEE\u6539" },
      D: { cls: "del", title: "\u5220\u9664" },
      R: { cls: "ren", title: "\u91CD\u547D\u540D" },
      C: { cls: "ren", title: "\u590D\u5236" },
      T: { cls: "mod", title: "\u7C7B\u578B\u53D8\u66F4" },
      U: { cls: "del", title: "\u51B2\u7A81" }
    };
    var hit = map[c] || { cls: "other", title: "\u5DF2\u66F4\u6539" };
    return { letter: c, cls: hit.cls, title: hit.title };
  }
  function renderQuickCommitFileRows(files) {
    var rows = files.map(function(item) {
      var badge = qcStatusBadge(item.status || "");
      var fullPath = item.path || "";
      var slash = fullPath.lastIndexOf("/");
      var dir = slash >= 0 ? fullPath.slice(0, slash + 1) : "";
      var base = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
      var subBadge = "";
      if (item.isSubmodule) {
        var st = item.submoduleState || {};
        var parts = [];
        if (st.commitChanged) parts.push("\u65B0\u6307\u9488");
        if (st.hasTrackedChanges) parts.push("dirty");
        if (st.hasUntracked) parts.push("\u672A\u8DDF\u8E2A");
        var label = parts.length ? "submodule \xB7 " + parts.join(" / ") : "submodule";
        subBadge = '<span class="qc-submodule-badge">' + escapeHtml2(label) + "</span>";
      }
      return '<div class="qc-file-row" title="' + escapeHtml2(fullPath) + '"><span class="qc-file-badge qc-badge-' + badge.cls + '" title="' + escapeHtml2(badge.title) + '">' + escapeHtml2(badge.letter) + '</span><span class="qc-file-path">' + (dir ? '<span class="qc-file-dir">' + escapeHtml2(dir) + "</span>" : "") + '<span class="qc-file-name">' + escapeHtml2(base) + "</span></span>" + subBadge + "</div>";
    }).join("");
    return rows || '<div class="qc-empty">\u6CA1\u6709\u53EF\u63D0\u4EA4\u7684\u6539\u52A8\u3002</div>';
  }
  function isQuickCommitOpInFlight() {
    return state.quickCommitSubmitting || state.quickCommitPushing;
  }
  function renderQuickCommitPair(label, fromHtml, toHtml, extraClass) {
    return '<div class="qc-pair' + (extraClass ? " " + extraClass : "") + '"><div class="qc-pair-label">' + escapeHtml2(label) + '</div><div class="qc-pair-flow"><div class="qc-pair-value qc-pair-value--from">' + fromHtml + '</div><div class="qc-pair-arrow" aria-hidden="true">\u2192</div><div class="qc-pair-value qc-pair-value--to">' + toHtml + "</div></div></div>";
  }
  function quickCommitHasSubmodule() {
    var s = state.gitStatus || {};
    if (s.hasSubmodule === true) return true;
    var files = s.files || [];
    for (var i = 0; i < files.length; i++) {
      if (files[i] && files[i].isSubmodule === true) return true;
    }
    return false;
  }
  function renderQuickCommitDragControl(hasChanges) {
    var disabled = !hasChanges || isQuickCommitOpInFlight();
    var hasSubmodule = quickCommitHasSubmodule();
    if (state.quickCommitSubmitting) {
      var subBusy = state.quickCommitSubmoduleIntent ? "\uFF08\u542B submodule\uFF09" : "";
      var busyLabel = (state.quickCommitAutoGenerating ? "AI \u751F\u6210 + \u63D0\u4EA4\u4E2D\u2026" : "\u6267\u884C\u4E2D\u2026") + subBusy;
      return '<div class="qc-dock-wrap"><div class="qc-dock-busy" role="status"><span class="qc-dock-busy-dot"></span>' + escapeHtml2(busyLabel) + "</div></div>";
    }
    function chip(id, label, title) {
      return '<button type="button" class="qc-chip qc-chip--' + id + '" data-chip="' + id + '"' + (title ? ' title="' + escapeHtml2(title) + '"' : "") + (disabled ? " disabled" : "") + '><span class="qc-chip-dot" aria-hidden="true"></span><span class="qc-chip-label">' + label + "</span></button>";
    }
    var hint = disabled ? !hasChanges ? "\u5DE5\u4F5C\u533A\u5E72\u51C0\uFF0C\u65E0\u53EF\u63D0\u4EA4" : "" : "\u62D6\u52A8\u78C1\u5438\u7EC4\u5408 \xB7 \u4E22\u8FDB\u63D0\u4EA4\u533A\u6267\u884C \xB7 \u5355\u51FB\u76F4\u63A5\u6267\u884C\u8BE5\u9879" + (hasSubmodule ? " \xB7 Sub \u7403\u53EF\u9009\uFF0C\u7EB3\u5165\u540E\u9012\u5F52\u5904\u7406 submodule" : "");
    return '<div class="qc-dock-wrap qc-dock-wrap--magnetic"' + (disabled ? ' data-disabled="1"' : "") + '><div id="qc-dock-stage" class="qc-dock-stage" data-action="commit" data-hot="0"><div id="qc-dock-field" class="qc-dock-field"><div id="qc-dock-cluster" class="qc-dock-cluster" aria-hidden="true"></div>' + chip("commit", "Commit") + chip("tag", "Tag") + chip("push", "Push") + (hasSubmodule ? chip("sub", "Sub", "\u63D0\u4EA4\u7236\u4ED3\u5E93\u5E76\u9012\u5F52\u8FDB\u5165 submodule\uFF08commit / tag / \u5206\u522B\u63A8\u9001\uFF09") : "") + '</div><button type="button" id="qc-dock-launch" class="qc-dock-launch"' + (disabled ? " disabled" : "") + ' aria-label="\u6267\u884C\u63D0\u4EA4"><span class="qc-dock-launch-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h12M13 6l6 6-6 6"/></svg></span><span id="qc-dock-launch-label" class="qc-dock-launch-label">\u63D0\u4EA4</span></button></div><div class="qc-dock-hint">' + escapeHtml2(hint) + "</div></div>";
  }
  function renderQuickCommitResultPanel() {
    var r = state.quickCommitResult;
    if (!r) return "";
    var oldCommit = r.oldCommitHash ? "<code>" + escapeHtml2(r.oldCommitHash) + "</code>" + (r.oldCommitSubject ? "<span>" + escapeHtml2(r.oldCommitSubject) + "</span>" : "") : '<span class="qc-muted">\u65E0</span>';
    var newCommit = r.commitHash ? "<code>" + escapeHtml2(r.commitHash) + "</code><span>" + escapeHtml2(r.commitMessage || "") + "</span>" : '<span class="qc-muted">\u65E0</span>';
    var oldTag = r.oldTag ? "<code>" + escapeHtml2(r.oldTag) + "</code>" : '<span class="qc-muted">\u65E0 tag</span>';
    var newTag = r.tagName ? "<code>" + escapeHtml2(r.tagName) + "</code>" : '<span class="qc-muted">\u672A\u6253 tag</span>';
    var pushButton = r.pushed ? '<span class="qc-result-pushed">\u5DF2\u63A8\u9001</span>' : '<button id="quick-commit-push-after-btn" class="btn btn-primary btn-sm" type="button"' + (state.quickCommitPushing ? " disabled" : "") + ">" + (state.quickCommitPushing ? "\u63A8\u9001\u4E2D..." : "Push & Close") + "</button>";
    return '<section class="qc-result-panel">' + renderQuickCommitPair("Commit", oldCommit, newCommit, "") + renderQuickCommitPair("Tag", oldTag, newTag, "qc-pair--tag") + (r.pushError || state.quickCommitPushError ? '<p class="error-message">' + escapeHtml2(r.pushError || state.quickCommitPushError) + "</p>" : "") + '<div class="qc-result-actions"><button id="quick-commit-cancel-btn" class="btn btn-ghost btn-sm" type="button">\u5173\u95ED</button>' + pushButton + "</div></section>";
  }
  function renderQuickCommitModal() {
    var s = state.gitStatus || {};
    var f = state.quickCommitForm || { customMessage: "", tag: "", tagEdited: false };
    var hasChanges = (s.modifiedCount || 0) > 0;
    var genBusy = state.quickCommitGenerating;
    var lc = s.lastCommit || {};
    var oldCommitHtml = lc.shortHash ? "<code>" + escapeHtml2(lc.shortHash) + "</code><span>" + escapeHtml2(lc.subject || "") + "</span>" : s.head ? "<code>" + escapeHtml2(s.head.substring(0, 7)) + "</code>" : '<span class="qc-muted">\u65E0 commit</span>';
    var oldTagHtml = s.latestTag ? "<code>" + escapeHtml2(s.latestTag) + "</code>" : '<span class="qc-muted">\u65E0 tag</span>';
    var newTagHtml = '<input type="text" id="quick-commit-tag" class="field-input qc-tag-field-input" placeholder="\u7559\u7A7A\u5219 AI \u751F\u6210" value="' + escapeHtml2(f.tag || "") + '"' + (state.quickCommitSubmitting ? " disabled" : "") + ">";
    var nextCommitHtml = '<textarea id="quick-commit-message" class="field-input qc-message-input" rows="3" placeholder="New commit message" ' + (state.quickCommitSubmitting ? "disabled" : "") + ">" + escapeHtml2(f.customMessage || "") + "</textarea>";
    var subtitleParts = [];
    subtitleParts.push(s.branch || "(no branch)");
    subtitleParts.push(hasChanges ? (s.modifiedCount || 0) + " \u4E2A\u6539\u52A8" : "\u5DE5\u4F5C\u533A\u5E72\u51C0");
    if (typeof s.ahead === "number" && s.ahead > 0) subtitleParts.push("\u2191" + s.ahead);
    if (typeof s.behind === "number" && s.behind > 0) subtitleParts.push("\u2193" + s.behind);
    var formPanel = state.quickCommitResult ? "" : '<section class="qc-release-panel"><div class="qc-message-header"><span class="qc-section-title">New</span><button type="button" id="quick-commit-ai-btn" class="btn btn-ghost btn-sm qc-ai-btn"' + (genBusy ? " disabled" : "") + ' title="AI \u751F\u6210 commit message \u4E0E tag"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5l1.4 3.6L13 6.5 9.4 7.9 8 11.5 6.6 7.9 3 6.5l3.6-1.4L8 1.5zM12.5 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" fill="currentColor"/></svg><span>' + (genBusy ? "\u751F\u6210\u4E2D..." : "AI") + "</span></button></div>" + renderQuickCommitPair("Commit", oldCommitHtml, nextCommitHtml, "qc-pair--commit") + renderQuickCommitPair("Tag", oldTagHtml, newTagHtml, "qc-pair--tag") + (state.quickCommitError ? '<p class="error-message">' + escapeHtml2(state.quickCommitError) + "</p>" : "") + renderQuickCommitDragControl(hasChanges) + '<div class="qc-modal-actions"><button id="quick-commit-cancel-btn" class="btn btn-ghost btn-sm" type="button">\u53D6\u6D88</button></div></section>';
    var resultPanel = renderQuickCommitResultPanel();
    return '<section id="quick-commit-modal" class="modal-backdrop' + (state.quickCommitOpen ? "" : " hidden") + '"><div class="modal quick-commit-modal" role="dialog" aria-labelledby="quick-commit-title"><div class="modal-header"><div><h2 id="quick-commit-title" class="modal-title">\u5FEB\u6377\u63D0\u4EA4</h2><p class="modal-subtitle">' + escapeHtml2(subtitleParts.join(" \xB7 ")) + '</p></div><button id="quick-commit-close-btn" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="\u5173\u95ED"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div><div class="modal-body">' + formPanel + resultPanel + "</div></div></section>";
  }
  function renderWorktreeMergeModal() {
    return '<section id="worktree-merge-modal" class="modal-backdrop hidden"><div class="modal worktree-merge-modal"><div class="modal-header"><div><h2 class="modal-title">\u5408\u5E76 Worktree</h2><p class="modal-subtitle">\u68C0\u67E5\u5F53\u524D\u4EFB\u52A1\u5206\u652F\u5E76\u5FEB\u6377\u5408\u5E76\u5230\u4E3B\u5206\u652F\u3002</p></div><button id="close-worktree-merge-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="\u5173\u95ED"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div><div class="modal-body"><div id="worktree-merge-content" class="worktree-merge-content"></div><p id="worktree-merge-error" class="error-message hidden"></p><div class="worktree-merge-actions"><button id="worktree-merge-cancel-button" class="btn btn-secondary">\u53D6\u6D88</button><button id="worktree-merge-confirm-button" class="btn btn-primary">\u786E\u8BA4\u5408\u5E76\u5E76\u6E05\u7406</button></div></div></div></section>';
  }
  function renderSettingsModal() {
    return '<section id="settings-modal" class="modal-backdrop hidden"><div class="modal settings-modal"><div class="modal-header settings-modal-header"><div class="settings-modal-title-group"><h2 class="modal-title">\u8BBE\u7F6E</h2><p class="settings-modal-subtitle">\u8C03\u6574\u5E94\u7528\u914D\u7F6E\u3001\u901A\u77E5\u3001\u5B89\u5168\u548C\u663E\u793A\u504F\u597D</p></div><button id="close-settings-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="\u5173\u95ED"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div><div class="modal-body settings-modal-body"><div class="settings-layout"><aside class="settings-sidebar"><div class="settings-sidebar-header"><div class="settings-sidebar-title">\u504F\u597D\u8BBE\u7F6E</div><div class="settings-sidebar-hint">\u5DE6\u4FA7\u5207\u6362\u5206\u533A\uFF0C\u53F3\u4FA7\u67E5\u770B\u8BE6\u7EC6\u8BF4\u660E\u4E0E\u9009\u9879\u3002</div></div><div class="settings-tabs" role="tablist" aria-label="\u8BBE\u7F6E\u5206\u7EC4" aria-orientation="vertical"><button class="settings-tab active" data-tab="about" role="tab" aria-selected="true" aria-controls="settings-tab-about"><span class="settings-tab-main">\u5173\u4E8E</span><span class="settings-tab-meta">\u7248\u672C\u3001\u66F4\u65B0\u4E0E\u8FDE\u63A5\u65B9\u5F0F</span></button><button class="settings-tab" data-tab="general" role="tab" aria-selected="false" aria-controls="settings-tab-general"><span class="settings-tab-main">\u57FA\u672C\u914D\u7F6E</span><span class="settings-tab-meta">\u6A21\u578B\u3001\u6A21\u5F0F\u4E0E\u8FD0\u884C\u73AF\u5883</span></button><button class="settings-tab" data-tab="notifications" role="tab" aria-selected="false" aria-controls="settings-tab-notifications"><span class="settings-tab-main">\u901A\u77E5</span><span class="settings-tab-meta">\u63D0\u793A\u97F3\u4E0E\u6D4F\u89C8\u5668\u901A\u77E5</span></button><button class="settings-tab" data-tab="security" role="tab" aria-selected="false" aria-controls="settings-tab-security"><span class="settings-tab-main">\u5B89\u5168</span><span class="settings-tab-meta">\u5BC6\u7801\u4E0E\u8BC1\u4E66</span></button><button class="settings-tab" data-tab="presets" role="tab" aria-selected="false" aria-controls="settings-tab-presets"><span class="settings-tab-main">\u547D\u4EE4\u9884\u8BBE</span><span class="settings-tab-meta">\u67E5\u770B\u5DF2\u6709\u9884\u8BBE</span></button><button class="settings-tab" data-tab="display" role="tab" aria-selected="false" aria-controls="settings-tab-display"><span class="settings-tab-main">\u663E\u793A</span><span class="settings-tab-meta">\u5361\u7247\u9ED8\u8BA4\u5C55\u5F00\u884C\u4E3A</span></button></div></aside><div class="settings-content"><div class="settings-panel active" id="settings-tab-about" role="tabpanel"><div class="settings-panel-header"><h3 class="settings-panel-title">\u5173\u4E8E Wand</h3><p class="settings-panel-desc">\u67E5\u770B\u7248\u672C\u4FE1\u606F\u3001\u66F4\u65B0\u72B6\u6001\u548C Android App \u8FDE\u63A5\u65B9\u5F0F\u3002</p></div><p id="settings-about-access-note" class="hint hidden">\u5F53\u524D\u662F App \u8FDE\u63A5\u4F1A\u8BDD\uFF0C\u4EC5\u5C55\u793A\u7248\u672C\u4E0E\u5BA2\u6237\u7AEF\u4E0B\u8F7D\u4FE1\u606F\u3002\u66F4\u65B0\u7BA1\u7406\u548C\u8FDE\u63A5\u7801\u4EC5\u5BF9\u7BA1\u7406\u5458\u5F00\u653E\u3002</p><div class="settings-about-info"><div class="settings-about-row"><span class="settings-label">\u5305\u540D</span><span class="settings-value" id="settings-pkg-name">-</span></div><div class="settings-about-row"><span class="settings-label">\u5F53\u524D\u7248\u672C</span><span class="settings-value" id="settings-version">-</span></div><div class="settings-about-row"><span class="settings-label">Node.js \u8981\u6C42</span><span class="settings-value" id="settings-node-req">-</span></div><div class="settings-about-row"><span class="settings-label">\u4ED3\u5E93\u5730\u5740</span><span class="settings-value" id="settings-repo-url"><a href="#" target="_blank" rel="noopener">-</a></span></div></div><div class="settings-update-section" id="web-update-section"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("globe", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">Web \u7AEF</h4><p class="settings-section-sub">\u6D4F\u89C8\u5668\u8BBF\u95EE\u7684\u670D\u52A1\u7248\u672C</p></div></div><div class="settings-about-row"><span class="settings-label">\u6700\u65B0\u7248\u672C</span><span class="settings-value" id="settings-latest-version">-</span></div><div class="settings-update-actions"><button type="button" id="check-update-button" class="btn btn-secondary btn-sm">\u68C0\u67E5\u66F4\u65B0</button><button type="button" id="do-update-button" class="btn btn-primary btn-sm hidden">\u66F4\u65B0\u5230\u6700\u65B0\u7248</button><button type="button" id="do-restart-button" class="btn btn-success btn-sm hidden">\u91CD\u542F\u751F\u6548</button></div><p id="update-message" class="hint hidden"></p><div class="settings-toggle-row"><div class="settings-toggle-text"><span class="settings-toggle-title">Beta \u901A\u9053</span><span class="settings-toggle-desc">\u66F4\u65B0\u5230 npm beta \u7248\u672C\uFF08tag + commit \u5C3E\u6807\uFF09\uFF0C\u5C1D\u9C9C\u65B0\u529F\u80FD\uFF0C\u53EF\u80FD\u4E0D\u7A33\u5B9A\u3002</span></div><label class="settings-switch"><input type="checkbox" id="beta-channel-toggle" class="switch-toggle"><span class="switch-slider"></span></label></div><div class="settings-toggle-row"><div class="settings-toggle-text"><span class="settings-toggle-title">\u81EA\u52A8\u66F4\u65B0</span><span class="settings-toggle-desc">\u68C0\u6D4B\u5230\u65B0\u7248\u672C\u5C06\u81EA\u52A8\u4E0B\u8F7D\u5B89\u88C5\u5E76\u91CD\u542F\u670D\u52A1\u3002</span></div><label class="settings-switch"><input type="checkbox" id="auto-update-web-toggle" class="switch-toggle"><span class="switch-slider"></span></label></div></div><div class="settings-update-section" id="provider-cli-update-section"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("terminal", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">\u5F00\u53D1 CLI</h4><p class="settings-section-sub">Claude Code\u3001Codex \u4E0E OpenCode \u7684\u670D\u52A1\u7AEF\u7248\u672C</p></div></div><div class="settings-about-row"><span class="settings-label">Claude Code</span><span class="settings-value" id="provider-cli-status-claude">\u68C0\u6D4B\u4E2D\u2026</span></div><div class="settings-about-row"><span class="settings-label">Codex</span><span class="settings-value" id="provider-cli-status-codex">\u68C0\u6D4B\u4E2D\u2026</span></div><div class="settings-about-row"><span class="settings-label">OpenCode</span><span class="settings-value" id="provider-cli-status-opencode">\u68C0\u6D4B\u4E2D\u2026</span></div><div class="settings-update-actions"><button type="button" id="check-provider-cli-updates" class="btn btn-secondary btn-sm">\u68C0\u67E5\u66F4\u65B0</button><button type="button" id="update-provider-clis" class="btn btn-primary btn-sm hidden">\u5FEB\u901F\u66F4\u65B0</button></div><p id="provider-cli-update-message" class="hint hidden"></p><div class="settings-toggle-row"><div class="settings-toggle-text"><span class="settings-toggle-title">\u81EA\u52A8\u66F4\u65B0 CLI</span><span class="settings-toggle-desc">\u670D\u52A1\u7AEF\u6BCF 30 \u5206\u949F\u68C0\u67E5\u4E00\u6B21\uFF0C\u5E76\u8C03\u7528\u5404 CLI \u5B98\u65B9 updater \u66F4\u65B0\u5230\u6700\u65B0\u7248\u3002</span></div><label class="settings-switch"><input type="checkbox" id="auto-update-cli-toggle" class="switch-toggle"><span class="switch-slider"></span></label></div></div><div class="settings-update-section hidden" id="android-apk-section"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("smartphone", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">Android App</h4><p class="settings-section-sub">\u539F\u751F\u5BA2\u6237\u7AEF\u7248\u672C\u4E0E APK \u4E0B\u8F7D</p></div></div><div id="android-apk-current-row" class="settings-about-row hidden"><span class="settings-label">\u5F53\u524D\u7248\u672C</span><span class="settings-value" id="settings-android-apk-current">-</span></div><div id="android-apk-github-row" class="settings-about-row settings-about-row-action hidden"><span class="settings-label">\u7EBF\u4E0A\u7248\u672C</span><span class="settings-value settings-value-flex" id="settings-android-apk-github">-</span><button id="download-github-apk-btn" class="btn btn-secondary btn-sm hidden" type="button">\u4E0B\u8F7D</button></div><div id="android-apk-local-row" class="settings-about-row settings-about-row-action hidden"><span class="settings-label">\u672C\u5730\u7248\u672C</span><span class="settings-value settings-value-flex" id="settings-android-apk-local">-</span><button id="download-local-apk-btn" class="btn btn-secondary btn-sm hidden" type="button">\u4E0B\u8F7D</button></div><div id="android-auto-update-row" class="settings-toggle-row hidden"><div class="settings-toggle-text"><span class="settings-toggle-title">\u81EA\u52A8\u66F4\u65B0</span><span class="settings-toggle-desc" id="android-auto-update-hint">\u68C0\u6D4B\u5230\u65B0\u7248 APK \u65F6\u81EA\u52A8\u62C9\u8D77\u4E0B\u8F7D\uFF0C\u5B89\u88C5\u4ECD\u9700\u5728\u7CFB\u7EDF\u4E2D\u786E\u8BA4\u3002</span></div><label class="settings-switch"><input type="checkbox" id="auto-update-apk-toggle" class="switch-toggle"><span class="switch-slider"></span></label></div><p id="android-apk-message" class="hint hidden"></p></div><div class="settings-update-section hidden" id="macos-dmg-section"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("desktop", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">macOS App</h4><p class="settings-section-sub">\u539F\u751F\u5BA2\u6237\u7AEF\u7248\u672C\u4E0E DMG \u4E0B\u8F7D</p></div></div><div id="macos-dmg-current-row" class="settings-about-row hidden"><span class="settings-label">\u5F53\u524D\u7248\u672C</span><span class="settings-value" id="settings-macos-dmg-current">-</span></div><div id="macos-dmg-github-row" class="settings-about-row settings-about-row-action hidden"><span class="settings-label">\u7EBF\u4E0A\u7248\u672C</span><span class="settings-value settings-value-flex" id="settings-macos-dmg-github">-</span><button id="download-github-dmg-btn" class="btn btn-secondary btn-sm hidden" type="button">\u4E0B\u8F7D</button></div><div id="macos-dmg-local-row" class="settings-about-row settings-about-row-action hidden"><span class="settings-label">\u672C\u5730\u7248\u672C</span><span class="settings-value settings-value-flex" id="settings-macos-dmg-local">-</span><button id="download-local-dmg-btn" class="btn btn-secondary btn-sm hidden" type="button">\u4E0B\u8F7D</button></div><div id="macos-auto-update-row" class="settings-toggle-row hidden"><div class="settings-toggle-text"><span class="settings-toggle-title">\u81EA\u52A8\u66F4\u65B0</span><span class="settings-toggle-desc" id="macos-auto-update-hint">\u68C0\u6D4B\u5230\u65B0\u7248 DMG \u5C06\u81EA\u52A8\u4E0B\u8F7D\u5E76\u6302\u8F7D\u3002</span></div><label class="settings-switch"><input type="checkbox" id="auto-update-dmg-toggle" class="switch-toggle"><span class="switch-slider"></span></label></div><p id="macos-dmg-message" class="hint hidden"></p></div><div class="settings-update-section" id="android-connect-section"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("link", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">App \u8FDE\u63A5\u7801</h4><p class="settings-section-sub">\u7C98\u8D34\u5230 Android App \u5373\u53EF\u81EA\u52A8\u8FDE\u63A5\uFF0C\u65E0\u9700\u5BC6\u7801\uFF1B\u6539\u5BC6\u7801\u540E\u5931\u6548\u3002</p></div></div><div class="settings-connect-url-box"><code id="android-connect-code" class="settings-connect-url-text">-</code><button id="copy-connect-code-button" class="btn btn-secondary btn-sm" type="button" title="\u590D\u5236\u8FDE\u63A5\u7801">\u590D\u5236</button></div><div class="settings-connect-qr-box"><div class="settings-connect-qr-wrap" id="android-connect-qr-wrap" title="\u70B9\u51FB\u653E\u5927"><canvas id="android-connect-qr" width="180" height="180"></canvas><div class="settings-connect-qr-empty" id="android-connect-qr-empty">\u751F\u6210\u4E2D\u2026</div></div><p class="settings-connect-qr-hint">\u7528 Wand App \u626B\u4E00\u626B\uFF0C\u5373\u53EF\u4E00\u952E\u586B\u5165\u670D\u52A1\u5668\u5730\u5740\u4E0E\u8FDE\u63A5\u7801\u3002</p></div></div></div><div class="settings-panel" id="settings-tab-notifications" role="tabpanel"><div class="settings-panel-header"><h3 class="settings-panel-title">\u901A\u77E5</h3><p class="settings-panel-desc">\u8BBE\u7F6E\u63D0\u793A\u97F3\u3001\u7CFB\u7EDF\u901A\u77E5\u548C\u6D4F\u89C8\u5668\u901A\u77E5\u7684\u884C\u4E3A\u3002</p></div><div class="settings-notification-section"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("bell", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">\u901A\u77E5\u504F\u597D</h4><p class="settings-section-sub">\u63D0\u793A\u97F3\u4E0E\u5E94\u7528\u5185\u901A\u77E5\u6C14\u6CE1</p></div></div><div class="settings-toggle-row"><div class="settings-toggle-text"><label class="settings-toggle-title" for="cfg-notif-sound">\u64AD\u653E\u63D0\u793A\u97F3</label><span class="settings-toggle-desc">\u91CD\u8981\u901A\u77E5\uFF08\u7248\u672C\u66F4\u65B0\u3001\u6743\u9650\u7B49\u5F85\u7B49\uFF09\u65F6\u64AD\u653E\u67D4\u548C\u63D0\u793A\u97F3\u3002</span></div><label class="settings-switch"><input id="cfg-notif-sound" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></label></div><div class="settings-range-row" id="notif-volume-field"><label class="settings-range-label" for="cfg-notif-volume">\u97F3\u91CF</label><input id="cfg-notif-volume" type="range" min="0" max="100" step="5" class="settings-range" /><span id="cfg-notif-volume-val" class="settings-range-value">80%</span></div><div class="settings-toggle-row"><div class="settings-toggle-text"><label class="settings-toggle-title" for="cfg-notif-bubble">\u5E94\u7528\u5185\u901A\u77E5\u6C14\u6CE1</label><span class="settings-toggle-desc">\u5728\u9875\u9762\u9876\u90E8\u5F39\u51FA\u6D6E\u52A8\u901A\u77E5\u6C14\u6CE1\u3002</span></div><label class="settings-switch"><input id="cfg-notif-bubble" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></label></div></div><div id="native-sound-section" class="settings-notification-section hidden"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("music", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">\u7CFB\u7EDF\u901A\u77E5\u94C3\u58F0</h4><p class="settings-section-sub">\u9009\u62E9 Android \u7CFB\u7EDF\u901A\u77E5\u4F7F\u7528\u7684\u94C3\u58F0</p></div></div><div class="settings-row-with-action"><select id="native-sound-select" class="field-input field-select"></select><button id="native-sound-preview" class="btn btn-secondary btn-sm btn-with-icon" type="button">' + iconSvg("play", { size: 11, strokeWidth: 1.8, fill: "currentColor" }) + '<span>\u8BD5\u542C</span></button></div></div><div id="native-haptic-section" class="settings-notification-section hidden"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("vibrate", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">\u89E6\u611F\u53CD\u9988</h4><p class="settings-section-sub">\u6309\u94AE\u64CD\u4F5C\u548C\u4EFB\u52A1\u5B8C\u6210\u65F6\u63D0\u4F9B\u632F\u52A8\u53CD\u9988</p></div></div><div class="settings-toggle-row"><div class="settings-toggle-text"><label class="settings-toggle-title" for="cfg-haptic-enabled">\u542F\u7528\u89E6\u611F\u53CD\u9988</label></div><label class="settings-switch"><input id="cfg-haptic-enabled" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></label></div></div><div class="settings-notification-section"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("globe", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">\u6D4F\u89C8\u5668\u901A\u77E5</h4><p class="settings-section-sub">\u6765\u81EA\u7CFB\u7EDF\u901A\u77E5\u4E2D\u5FC3\u7684\u5F39\u7A97</p></div></div><div class="settings-about-row"><span class="settings-label">\u6388\u6743\u72B6\u6001</span><span class="settings-value" id="notification-permission-status">-</span></div><div class="settings-update-actions"><button id="notification-request-btn" class="btn btn-primary btn-sm hidden" type="button">\u6388\u6743\u901A\u77E5</button><button id="notification-reset-btn" class="btn btn-ghost btn-sm hidden" type="button">\u91CD\u65B0\u6388\u6743</button><button id="notification-test-btn" class="btn btn-secondary btn-sm" type="button">\u53D1\u9001\u6D4B\u8BD5\u901A\u77E5</button><button id="notification-test-delay-btn" class="btn btn-ghost btn-sm" type="button">10 \u79D2\u540E\u53D1\u9001</button></div><p id="notification-test-message" class="hint hidden"></p></div></div><div class="settings-panel" id="settings-tab-general" role="tabpanel"><div class="settings-panel-header"><h3 class="settings-panel-title">\u57FA\u672C\u914D\u7F6E</h3><p class="settings-panel-desc">\u914D\u7F6E\u670D\u52A1\u8FDE\u63A5\u3001\u9ED8\u8BA4\u6A21\u578B\u3001\u6267\u884C\u65B9\u5F0F\u548C\u5DE5\u4F5C\u76EE\u5F55\u3002</p></div><div class="field-row"><div class="field"><label class="field-label" for="cfg-host">\u76D1\u542C\u5730\u5740 (host)</label><input id="cfg-host" type="text" class="field-input" placeholder="127.0.0.1" /></div><div class="field"><label class="field-label" for="cfg-port">\u7AEF\u53E3 (port)</label><input id="cfg-port" type="number" class="field-input" placeholder="8443" min="1" max="65535" /></div></div><div class="settings-toggle-row"><div class="settings-toggle-text"><label class="settings-toggle-title" for="cfg-https">\u542F\u7528 HTTPS</label><span class="settings-toggle-desc">\u4F7F\u7528\u81EA\u7B7E\u540D\u8BC1\u4E66\u52A0\u5BC6\u6D4F\u89C8\u5668\u5230\u670D\u52A1\u7684\u8FDE\u63A5\uFF0Chost \u4E3A\u975E 127.0.0.1 \u65F6\u5EFA\u8BAE\u5F00\u542F\u3002</span></div><label class="settings-switch"><input id="cfg-https" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></label></div><div class="field-row"><div class="field"><label class="field-label" for="cfg-mode">\u9ED8\u8BA4\u6267\u884C\u6A21\u5F0F</label><select id="cfg-mode" class="field-input"><option value="default">default</option><option value="assist">assist</option><option value="agent">agent</option><option value="agent-max">agent-max</option><option value="auto-edit">auto-edit</option><option value="full-access">full-access</option><option value="native">native</option><option value="managed">managed</option></select></div><div class="field"><label class="field-label" for="cfg-language">\u56DE\u590D\u8BED\u8A00</label><select id="cfg-language" class="field-input"><option value="">\u81EA\u52A8\uFF08\u4E0D\u6307\u5B9A\uFF09</option><option value="\u4E2D\u6587">\u4E2D\u6587</option><option value="English">English</option><option value="\u65E5\u672C\u8A9E">\u65E5\u672C\u8A9E</option><option value="\uD55C\uAD6D\uC5B4">\uD55C\uAD6D\uC5B4</option><option value="Espa\xF1ol">Espa\xF1ol</option><option value="Fran\xE7ais">Fran\xE7ais</option><option value="Deutsch">Deutsch</option><option value="\u0420\u0443\u0441\u0441\u043A\u0438\u0439">\u0420\u0443\u0441\u0441\u043A\u0438\u0439</option></select></div></div><p class="field-hint" style="margin-top:-4px;">\u8BBE\u7F6E\u56DE\u590D\u8BED\u8A00\u540E\uFF0CClaude \u5C06\u5C3D\u91CF\u4F7F\u7528\u6307\u5B9A\u8BED\u8A00\u56DE\u590D\u3002</p><div class="field"><label class="field-label" for="cfg-structured-runner">\u7ED3\u6784\u5316\u4F1A\u8BDD Runner</label><select id="cfg-structured-runner" class="field-input"><option value="sdk">SDK\uFF08@anthropic-ai/claude-agent-sdk\uFF0C\u9ED8\u8BA4\uFF09</option><option value="cli">CLI\uFF08spawn claude -p\uFF09</option></select><p class="field-hint" style="margin-top:4px;">SDK \u6A21\u5F0F\u4F7F\u7528\u5B98\u65B9 Agent SDK \u66FF\u4EE3 CLI subprocess\uFF0C\u63A5\u53E3\u66F4\u6574\u6D01\uFF0C\u529F\u80FD\u7B49\u4EF7\u3002\u4FDD\u5B58\u540E\u5BF9\u65B0\u5EFA\u4F1A\u8BDD\u7ACB\u5373\u751F\u6548\u3002</p></div><div class="settings-toggle-row"><div class="settings-toggle-text"><label class="settings-toggle-title" for="cfg-inherit-env">\u7EE7\u627F\u73AF\u5883\u53D8\u91CF</label><span class="settings-toggle-desc">\u542F\u52A8 PTY / \u7ED3\u6784\u5316\u5B50\u8FDB\u7A0B\u65F6\uFF0C\u628A\u5F53\u524D\u670D\u52A1\u8FDB\u7A0B\u7684\u73AF\u5883\u53D8\u91CF\u4F20\u7ED9 claude / codex / opencode\u3002\u5173\u95ED\u540E\u5B50\u8FDB\u7A0B\u4EC5\u83B7\u5F97\u6700\u5C0F\u53EF\u7528\u73AF\u5883\uFF08PATH/HOME/SHELL/LANG/TERM \u7B49\uFF09\uFF0C\u53EF\u7528\u4E8E\u9694\u79BB API key \u7B49\u654F\u611F\u51ED\u636E\u3002</span></div><div class="settings-toggle-aside"><button type="button" id="cfg-view-env-btn" class="btn btn-secondary btn-sm" title="\u67E5\u770B\u5B9E\u9645\u4F1A\u6CE8\u5165\u5230\u5B50\u8FDB\u7A0B\u7684\u73AF\u5883\u53D8\u91CF">\u67E5\u770B</button><label class="settings-switch"><input id="cfg-inherit-env" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></label></div></div><section class="settings-model-card" aria-labelledby="settings-model-card-title"><div class="settings-model-card-header"><div class="settings-model-card-heading"><span class="settings-model-card-icon" aria-hidden="true">' + iconSvg("cpu", { size: 18, strokeWidth: 1.8 }) + '</span><div><h4 class="settings-model-card-title" id="settings-model-card-title">\u9ED8\u8BA4\u6A21\u578B</h4><p class="settings-model-card-desc">\u4ECE\u5DF2\u68C0\u6D4B\u5217\u8868\u4E2D\u9009\u62E9\uFF0C\u6216\u76F4\u63A5\u8F93\u5165\u81EA\u5B9A\u4E49\u6A21\u578B\u540D\u79F0 / ID\u3002</p></div></div><button type="button" id="cfg-default-model-refresh" class="btn btn-secondary btn-sm settings-model-refresh" title="\u91CD\u65B0\u68C0\u6D4B Claude\u3001Codex \u4E0E OpenCode \u6A21\u578B"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg><span>\u5237\u65B0\u5217\u8868</span></button></div><div class="settings-model-grid"><div class="field settings-model-field"><div class="settings-model-label-row"><label class="field-label" for="cfg-default-model">Claude</label><span class="settings-model-provider">Claude Code</span></div><div class="model-combobox" data-provider="claude"><div class="model-combobox-control"><input id="cfg-default-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-default-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="\u8DDF\u968F Claude Code \u9ED8\u8BA4" /><button type="button" class="model-combobox-toggle" aria-label="\u5C55\u5F00 Claude \u6A21\u578B\u5217\u8868"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button></div><div id="cfg-default-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="Claude \u6A21\u578B"></div></div><div class="settings-model-meta"><span class="settings-model-status" data-model-status="claude">\u8DDF\u968F CLI \u9ED8\u8BA4</span><span class="settings-model-help">\u4F1A\u539F\u6837\u4F20\u7ED9 <code>--model</code></span></div></div><div class="field settings-model-field"><div class="settings-model-label-row"><label class="field-label" for="cfg-default-codex-model">Codex</label><span class="settings-model-provider">Codex CLI</span></div><div class="model-combobox" data-provider="codex"><div class="model-combobox-control"><input id="cfg-default-codex-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-default-codex-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="\u8DDF\u968F Codex \u9ED8\u8BA4" /><button type="button" class="model-combobox-toggle" aria-label="\u5C55\u5F00 Codex \u6A21\u578B\u5217\u8868"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button></div><div id="cfg-default-codex-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="Codex \u6A21\u578B"></div></div><div class="settings-model-meta"><span class="settings-model-status" data-model-status="codex">\u8DDF\u968F CLI \u9ED8\u8BA4</span><span class="settings-model-help">\u7559\u7A7A\u5219\u4E0D\u4F20\u6A21\u578B\u53C2\u6570</span></div></div><div class="field settings-model-field"><div class="settings-model-label-row"><label class="field-label" for="cfg-default-opencode-model">OpenCode</label><span class="settings-model-provider">OpenCode CLI</span></div><div class="model-combobox" data-provider="opencode"><div class="model-combobox-control"><input id="cfg-default-opencode-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-default-opencode-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="\u8DDF\u968F OpenCode \u9ED8\u8BA4" /><button type="button" class="model-combobox-toggle" aria-label="\u5C55\u5F00 OpenCode \u6A21\u578B\u5217\u8868"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button></div><div id="cfg-default-opencode-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="OpenCode \u6A21\u578B"></div></div><div class="settings-model-meta"><span class="settings-model-status" data-model-status="opencode">\u8DDF\u968F CLI \u9ED8\u8BA4</span><span class="settings-model-help">\u683C\u5F0F\u4E3A provider/model</span></div></div></div><p class="field-hint settings-model-version" id="cfg-default-model-version">\u6A21\u578B\u540D\u79F0\u4EC5\u5728\u65B0\u5EFA\u4F1A\u8BDD\u65F6\u4F5C\u4E3A\u9ED8\u8BA4\u503C\uFF1B\u8FD0\u884C\u4E2D\u7684\u7ED3\u6784\u5316\u4F1A\u8BDD\u4ECD\u53EF\u5355\u72EC\u5207\u6362\u3002</p></section><section class="settings-model-card" aria-labelledby="settings-commit-model-card-title"><div class="settings-model-card-header"><div class="settings-model-card-heading"><span class="settings-model-card-icon" aria-hidden="true">' + iconSvg("edit", { size: 18, strokeWidth: 1.8 }) + '</span><div><h4 class="settings-model-card-title" id="settings-commit-model-card-title">Commit \u751F\u6210</h4><p class="settings-model-card-desc">\u6307\u5B9A\u5FEB\u6377\u63D0\u4EA4\u751F\u6210 message \u4E0E tag \u65F6\u4F7F\u7528\u7684 CLI \u548C\u6A21\u578B\u3002</p></div></div><button type="button" id="cfg-commit-model-refresh" class="btn btn-secondary btn-sm settings-model-refresh" title="\u91CD\u65B0\u68C0\u6D4B\u6240\u9009 CLI \u7684\u6A21\u578B"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg><span>\u5237\u65B0\u5217\u8868</span></button></div><div class="settings-model-grid"><div class="field settings-model-field"><div class="settings-model-label-row"><label class="field-label" for="cfg-commit-cli">CLI</label><span class="settings-model-provider">\u5FEB\u6377\u63D0\u4EA4</span></div><select id="cfg-commit-cli" class="field-input"><option value="claude">Claude</option><option value="codex">Codex</option><option value="opencode">OpenCode</option></select><div class="settings-model-meta"><span class="settings-model-status">\u751F\u6210 commit message \u4E0E tag</span></div></div><div class="field settings-model-field"><div class="settings-model-label-row"><label class="field-label" for="cfg-commit-model">\u6A21\u578B</label><span class="settings-model-provider" id="cfg-commit-model-provider">Claude Code</span></div><div id="cfg-commit-model-combobox" class="model-combobox" data-provider="claude"><div class="model-combobox-control"><input id="cfg-commit-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-commit-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="\u8DDF\u968F Claude Code \u9ED8\u8BA4" /><button type="button" class="model-combobox-toggle" aria-label="\u5C55\u5F00 commit \u6A21\u578B\u5217\u8868"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button></div><div id="cfg-commit-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="Commit \u6A21\u578B"></div></div><div class="settings-model-meta"><span class="settings-model-status" data-model-status>\u8DDF\u968F CLI \u9ED8\u8BA4</span><span class="settings-model-help">\u5217\u8868\u6765\u81EA\u81EA\u52A8\u68C0\u6D4B</span></div></div></div></section><div class="field"><label class="field-label" for="cfg-cwd">\u9ED8\u8BA4\u5DE5\u4F5C\u76EE\u5F55</label><input id="cfg-cwd" type="text" class="field-input" placeholder="/home/user" /></div><div class="field"><label class="field-label" for="cfg-shell">Shell</label><input id="cfg-shell" type="text" class="field-input" placeholder="/bin/bash" /></div>' + (typeof WandNative !== "undefined" && typeof WandNative.getAppIcon === "function" ? '<div class="settings-app-icon-block"><div class="settings-section-head"><span class="settings-section-icon">' + iconSvg("palette", { size: 18, strokeWidth: 1.7 }) + '</span><div class="settings-section-head-text"><h4 class="settings-section-heading">\u5E94\u7528\u56FE\u6807</h4><p class="settings-section-sub">\u9009\u62E9 App \u542F\u52A8\u5668\u56FE\u6807\uFF0C\u8FD4\u56DE\u684C\u9762\u540E\u751F\u6548</p></div></div><div id="app-icon-picker" class="settings-app-icon-picker"><button type="button" class="settings-app-icon-option" data-icon="shorthair"><span class="settings-app-icon-preview">' + PIXEL_AVATAR.user + '</span><span class="settings-app-icon-label">\u8D5B\u535A\u864E\u599E</span></button><button type="button" class="settings-app-icon-option" data-icon="garfield"><span class="settings-app-icon-preview">' + PIXEL_AVATAR.assistant + '</span><span class="settings-app-icon-label">\u52E4\u52B3\u521D\u4E8C</span></button></div><p id="app-icon-message" class="hint hidden"></p></div>' : "") + '<div class="settings-actions settings-actions-sticky"><button id="save-config-button" class="btn btn-primary btn-block">\u4FDD\u5B58\u914D\u7F6E</button></div><p id="config-message" class="hint hidden settings-status-message"></p></div><div class="settings-panel" id="settings-tab-security" role="tabpanel"><div class="settings-panel-header"><h3 class="settings-panel-title">\u5B89\u5168</h3><p class="settings-panel-desc">\u7BA1\u7406\u767B\u5F55\u5BC6\u7801\u4E0E SSL \u8BC1\u4E66\uFF0C\u654F\u611F\u53D8\u66F4\u8BF7\u786E\u8BA4\u540E\u518D\u4FDD\u5B58\u3002</p></div><div class="settings-card"><div class="settings-card-head"><span class="settings-card-icon" aria-hidden="true">' + iconSvg("lock", { size: 18, strokeWidth: 1.8 }) + '</span><div class="settings-card-head-text"><h3 class="settings-card-title">\u4FEE\u6539\u5BC6\u7801</h3><p class="settings-card-desc">\u81F3\u5C11 6 \u4E2A\u5B57\u7B26\uFF1B\u4FDD\u5B58\u540E\u4E0B\u6B21\u767B\u5F55\u751F\u6548\u3002</p></div></div><form id="change-password-form" autocomplete="on" onsubmit="return false;"><input type="text" name="username" autocomplete="username" value="wand" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none" readonly /><div class="field"><label class="field-label" for="new-password">\u65B0\u5BC6\u7801</label><input id="new-password" type="password" class="field-input" placeholder="\u8F93\u5165\u65B0\u5BC6\u7801\uFF08\u81F3\u5C11 6 \u4E2A\u5B57\u7B26\uFF09" autocomplete="new-password" /></div><div class="field"><label class="field-label" for="confirm-password">\u786E\u8BA4\u5BC6\u7801</label><input id="confirm-password" type="password" class="field-input" placeholder="\u518D\u6B21\u8F93\u5165\u65B0\u5BC6\u7801" autocomplete="new-password" /></div><div class="settings-card-actions"><button id="save-password-button" class="btn btn-primary" type="submit">\u4FDD\u5B58\u5BC6\u7801</button></div><p id="settings-error" class="error-message hidden"></p><p id="settings-success" class="hint settings-success-message hidden"></p></form></div><div class="settings-card"><div class="settings-card-head"><span class="settings-card-icon" aria-hidden="true">' + iconSvg("certificate", { size: 18, strokeWidth: 1.8 }) + '</span><div class="settings-card-head-text"><h3 class="settings-card-title">SSL \u8BC1\u4E66</h3><p class="settings-card-desc" id="cert-status">\u52A0\u8F7D\u4E2D...</p></div></div><div class="field"><label class="field-label" for="cert-key-file">\u79C1\u94A5\u6587\u4EF6 (.key)</label><div class="file-picker"><input id="cert-key-file" type="file" class="file-picker-input" accept=".key,.pem" /><label for="cert-key-file" class="file-picker-trigger"><svg class="file-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg><span class="file-picker-label">\u9009\u62E9\u79C1\u94A5</span></label><span class="file-picker-name" data-default="\u672A\u9009\u62E9\u6587\u4EF6">\u672A\u9009\u62E9\u6587\u4EF6</span></div></div><div class="field"><label class="field-label" for="cert-cert-file">\u8BC1\u4E66\u6587\u4EF6 (.crt/.pem)</label><div class="file-picker"><input id="cert-cert-file" type="file" class="file-picker-input" accept=".crt,.pem,.cert" /><label for="cert-cert-file" class="file-picker-trigger"><svg class="file-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><span class="file-picker-label">\u9009\u62E9\u8BC1\u4E66</span></label><span class="file-picker-name" data-default="\u672A\u9009\u62E9\u6587\u4EF6">\u672A\u9009\u62E9\u6587\u4EF6</span></div></div><div class="settings-card-actions"><button id="upload-cert-button" class="btn btn-primary">\u4E0A\u4F20\u8BC1\u4E66</button></div><p id="cert-message" class="hint hidden"></p></div></div><div class="settings-panel" id="settings-tab-presets" role="tabpanel"><div class="settings-panel-header"><h3 class="settings-panel-title">\u547D\u4EE4\u9884\u8BBE</h3><p class="settings-panel-desc">\u5F53\u524D\u547D\u4EE4\u9884\u8BBE\u4ECE config.json \u8BFB\u53D6\uFF0C\u53EF\u5728\u8FD9\u91CC\u5FEB\u901F\u67E5\u770B\u5DF2\u6709\u914D\u7F6E\u3002</p></div><div id="presets-list" class="presets-list"></div></div><div class="settings-panel" id="settings-tab-display" role="tabpanel"><div class="settings-panel-header"><h3 class="settings-panel-title">\u663E\u793A</h3><p class="settings-panel-desc">\u63A7\u5236\u804A\u5929\u89C6\u56FE\u91CC\u4E0D\u540C\u5361\u7247\u7C7B\u578B\u7684\u9ED8\u8BA4\u5C55\u5F00\u72B6\u6001\u3002</p></div><div class="settings-section-title">\u5361\u7247\u9ED8\u8BA4\u5C55\u5F00\u72B6\u6001</div><p class="hint settings-inline-hint">\u8BBE\u7F6E\u7ED3\u6784\u5316\u804A\u5929\u89C6\u56FE\u4E2D\u5404\u7C7B\u5361\u7247\u7684\u9ED8\u8BA4\u5C55\u5F00/\u6298\u53E0\u72B6\u6001\u3002\u624B\u52A8\u64CD\u4F5C\u7684\u5C55\u5F00\u72B6\u6001\u4F18\u5148\u4E8E\u6B64\u9ED8\u8BA4\u8BBE\u7F6E\u3002</p><div class="switch-card-list"><label class="switch-card" for="cfg-card-edit"><div class="switch-card-header"><span class="switch-card-title">\u7F16\u8F91\u5361\u7247 (Edit/Write)</span><input id="cfg-card-edit" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></div><div class="switch-card-desc">\u6587\u4EF6\u7F16\u8F91\u548C\u5199\u5165\u64CD\u4F5C\u7684 diff \u89C6\u56FE</div></label><label class="switch-card" for="cfg-card-inline"><div class="switch-card-header"><span class="switch-card-title">\u5185\u8054\u5DE5\u5177 (Read/Glob/Grep)</span><input id="cfg-card-inline" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></div><div class="switch-card-desc">\u6587\u4EF6\u8BFB\u53D6\u3001\u641C\u7D22\u7B49\u5DE5\u5177\u7684\u7ED3\u679C</div></label><label class="switch-card" for="cfg-card-terminal"><div class="switch-card-header"><span class="switch-card-title">\u7EC8\u7AEF\u8F93\u51FA (Bash)</span><input id="cfg-card-terminal" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></div><div class="switch-card-desc">\u547D\u4EE4\u884C\u6267\u884C\u7ED3\u679C</div></label><label class="switch-card" for="cfg-card-thinking"><div class="switch-card-header"><span class="switch-card-title">\u601D\u8003\u8FC7\u7A0B (Thinking)</span><input id="cfg-card-thinking" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></div><div class="switch-card-desc">Claude \u7684\u601D\u8003\u8FC7\u7A0B\u5757</div></label><label class="switch-card" for="cfg-card-toolgroup"><div class="switch-card-header"><span class="switch-card-title">\u5DE5\u5177\u7EC4</span><input id="cfg-card-toolgroup" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></div><div class="switch-card-desc">\u8FDE\u7EED\u540C\u7C7B\u5DE5\u5177\u8C03\u7528\u7684\u6298\u53E0\u7EC4</div></label></div><div class="settings-actions settings-actions-sticky"><button id="save-display-button" class="btn btn-primary btn-block">\u4FDD\u5B58\u663E\u793A\u8BBE\u7F6E</button></div><p id="display-message" class="hint hidden settings-status-message"></p></div></div></div></section>';
  }

  // src/web-ui/browser/session-ui.ts
  function renderFolderPicker(state3) {
    var currentDir = getEffectiveCwd3();
    if (state3.selectedId) {
      return "";
    }
    return '<div class="folder-picker-compact" id="folder-picker-container"><div class="folder-picker-compact-row"><span class="folder-picker-compact-icon">' + iconSvg("folder", { size: 13, strokeWidth: 1.7 }) + '</span><input type="text" id="folder-picker-input" class="folder-picker-compact-input" value="' + escapeHtml2(currentDir) + '" placeholder="\u5DE5\u4F5C\u76EE\u5F55" autocomplete="off" /><button type="button" id="folder-picker-toggle" class="folder-picker-toggle" title="\u9009\u62E9\u76EE\u5F55" aria-label="\u9009\u62E9\u76EE\u5F55">' + iconSvg("chevronDown", { size: 11, strokeWidth: 2 }) + '</button></div><div id="folder-picker-dropdown" class="folder-picker-dropdown hidden"><div class="folder-picker-quick-row"><button class="folder-picker-quick-btn" data-path="/tmp">\u4E34\u65F6</button><button class="folder-picker-quick-btn" data-path="/">\u6839\u76EE\u5F55</button></div></div><div id="folder-picker-validation" class="folder-picker-validation"></div></div>';
  }
  function renderWorkingDirIndicator(state3) {
    var currentDir = getEffectiveCwd3();
    var displayDir = currentDir;
    if (state3.selectedId) {
      var selectedSession = state3.sessions.find(function(s) {
        return s.id === state3.selectedId;
      });
      displayDir = selectedSession && selectedSession.cwd ? selectedSession.cwd : currentDir;
    }
    return '<div class="working-dir-indicator" id="working-dir-indicator" title="' + escapeHtml2(displayDir) + '" data-path="' + escapeHtml2(displayDir) + '"><span class="working-dir-indicator-icon">' + iconSvg("folder", { size: 12, strokeWidth: 1.7 }) + "</span>" + renderTailMarqueePath(displayDir, "working-dir-indicator-path", ' id="working-dir-indicator-path"') + "</div>";
  }
  function timeAgo(isoString) {
    if (!isoString) return "";
    var now = Date.now();
    var then = new Date(isoString).getTime();
    var diff = Math.max(0, now - then);
    var seconds = Math.floor(diff / 1e3);
    if (seconds < 60) return "\u521A\u521A";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "\u5206\u949F\u524D";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "\u5C0F\u65F6\u524D";
    var days = Math.floor(hours / 24);
    if (days < 30) return days + "\u5929\u524D";
    return Math.floor(days / 30) + "\u4E2A\u6708\u524D";
  }
  function elapsedTime(isoString) {
    if (!isoString) return "";
    var now = Date.now();
    var then = new Date(isoString).getTime();
    var diff = Math.max(0, now - then);
    var seconds = Math.floor(diff / 1e3);
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);
    if (hours > 0) return hours + "h" + (minutes % 60 > 0 ? minutes % 60 + "m" : "");
    if (minutes > 0) return minutes + "m";
    return seconds + "s";
  }
  function getSessionStatusLabel(session) {
    if (!session) return "";
    if (session.permissionBlocked) return "\u7B49\u5F85\u6388\u6743";
    if (isStructuredSession2(session) && session.structuredState && session.structuredState.inFlight) return "\u601D\u8003\u4E2D";
    var statusMap = {
      "idle": "\u7A7A\u95F2",
      "stopped": "\u5DF2\u505C\u6B62",
      "running": "\u8FD0\u884C\u4E2D",
      "exited": "\u5DF2\u9000\u51FA",
      "failed": "\u5DF2\u5931\u8D25"
    };
    return statusMap[session.status] || session.status;
  }
  function getSessionStatusClass(session) {
    if (!session) return "";
    if (session.permissionBlocked) return "permission-blocked";
    if (isStructuredSession2(session) && session.structuredState && session.structuredState.inFlight) return "running";
    return session.status || "";
  }
  function getSessionActivityDesc(session) {
    if (!session) return "";
    if (session.permissionBlocked) return "\u7B49\u5F85\u4F60\u7684\u6388\u6743";
    if (session.status !== "running") return "";
    if (session.id === state.selectedId && state.currentTask && state.currentTask.title) {
      return state.currentTask.title;
    }
    if (session.currentTaskTitle) return session.currentTaskTitle;
    return "";
  }
  function getSessionLatestUserText(session) {
    var msgs = session && session.messages;
    if (!msgs || msgs.length === 0) return "";
    for (var i = msgs.length - 1; i >= 0; i--) {
      var msg = msgs[i];
      if (!msg || msg.role !== "user") continue;
      var content = msg.content;
      if (typeof content === "string") {
        var t15 = content.trim();
        if (t15) return t15;
        continue;
      }
      if (Array.isArray(content)) {
        for (var j = 0; j < content.length; j++) {
          var block = content[j];
          if (!block || block.type !== "text" || !block.text) continue;
          if (block.__queued) continue;
          var bt = String(block.text).trim();
          if (bt) return bt;
        }
      }
    }
    return "";
  }
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
          text = text.replace(/^#+\s+/gm, "").replace(/\*\*/g, "").replace(/`/g, "");
          var firstLine = text.split("\n")[0].trim();
          return firstLine.slice(0, 100);
        }
      }
    }
    return "";
  }
  function renderSessionItem(session, kind) {
    var activeClass = session.id === state.selectedId ? " active" : "";
    var selectedClass = state.sessionsManageMode && state.selectedSessionIds[session.id] ? " selected" : "";
    var metaStatus = getSessionStatusLabel(session);
    var metaStatusClass = getSessionStatusClass(session);
    var resumeButton = "";
    var checkbox = renderManageCheckbox("sessions", session.id, "\u9009\u62E9\u4F1A\u8BDD " + session.command);
    if ((session.provider === "claude" || session.provider === "codex") && session.claudeSessionId) {
      if (session.status !== "running" && !state.sessionsManageMode && !isStructuredSession2(session)) {
        var resumeTitle = session.provider === "codex" ? "\u6062\u590D Codex \u4F1A\u8BDD" : "\u6062\u590D Claude \u4F1A\u8BDD";
        resumeButton = '<button class="session-action-btn" data-action="resume" data-session-id="' + session.id + '" type="button" aria-label="' + resumeTitle + '" title="' + resumeTitle + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';
      }
    }
    var canOpenMerge = !state.sessionsManageMode && session.worktreeEnabled && session.worktree && session.worktree.branch && session.worktree.path;
    var needsCleanup = session.worktreeMergeStatus === "merged" && session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false;
    var mergeDisabled = session.status === "running" || session.worktreeMergeStatus === "merging";
    var mergeTitle = needsCleanup ? "\u91CD\u8BD5\u6E05\u7406 worktree" : "\u5408\u5E76\u5230\u4E3B\u5206\u652F";
    var mergeButton = canOpenMerge && session.worktreeMergeStatus !== "merged" ? '<button class="session-action-btn merge-btn" data-action="worktree-merge" data-session-id="' + session.id + '" type="button" aria-label="' + escapeHtml2(mergeTitle) + '" title="' + escapeHtml2(mergeTitle) + '"' + (mergeDisabled ? " disabled" : "") + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10"/><path d="M7 12h10"/><path d="M7 17h10"/><path d="M5 7l-2 2 2 2"/><path d="M19 15l2 2-2 2"/></svg></button>' : needsCleanup ? '<button class="session-action-btn merge-btn" data-action="worktree-cleanup" data-session-id="' + session.id + '" type="button" aria-label="\u91CD\u8BD5\u6E05\u7406 worktree" title="\u91CD\u8BD5\u6E05\u7406 worktree"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>' : "";
    var deleteButton = state.sessionsManageMode ? "" : '<button class="session-action-btn delete-btn" data-action="delete-session" data-session-id="' + session.id + '" type="button" aria-label="\u5220\u9664\u4F1A\u8BDD" title="\u5220\u9664\u6B64\u4F1A\u8BDD"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
    var actionsHtml = '<span class="session-actions">' + resumeButton + mergeButton + deleteButton + "</span>";
    var titleHtml = session.title || session.summary ? '<div class="session-title">' + escapeHtml2(session.title || session.summary) + "</div>" : '<div class="session-command">' + escapeHtml2(session.resumedFromSessionId ? session.command.replace(/\s+--resume\s+\S+/, "").replace(/\s+resume\s+[0-9a-f-]+/, "") : session.command) + "</div>";
    var activityDesc = getSessionActivityDesc(session);
    var activityHtml = "";
    if (session.status === "running" && activityDesc) {
      activityHtml = '<div class="session-activity">' + escapeHtml2(activityDesc) + "</div>";
    }
    var descriptionHtml = session.description ? '<div class="session-description">' + escapeHtml2(session.description) + "</div>" : "";
    var timeDisplay = "";
    if (session.status === "running") {
      timeDisplay = '<span class="session-time" title="\u5DF2\u8FD0\u884C ' + escapeHtml2(elapsedTime(session.startedAt)) + '">' + escapeHtml2(elapsedTime(session.startedAt)) + "</span>";
    } else if (session.endedAt) {
      timeDisplay = '<span class="session-time" title="' + escapeHtml2(new Date(session.endedAt).toLocaleString()) + '">' + escapeHtml2(timeAgo(session.endedAt)) + "</span>";
    } else if (session.startedAt) {
      timeDisplay = '<span class="session-time" title="' + escapeHtml2(new Date(session.startedAt).toLocaleString()) + '">' + escapeHtml2(timeAgo(session.startedAt)) + "</span>";
    }
    var badgesHtml = renderWorktreeBadge(session);
    var recoveryHtml = session.autoRecovered ? '<span class="session-recovery-hint">\u81EA\u52A8\u6062\u590D</span>' : "";
    var swipeBgHtml = state.sessionsManageMode ? "" : '<div class="session-swipe-bg" aria-hidden="true"><button class="session-swipe-delete" data-action="swipe-delete-session" data-session-id="' + session.id + '" type="button" tabindex="-1" aria-label="\u5220\u9664\u4F1A\u8BDD"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg><span>\u5220\u9664</span></button></div>';
    return '<div class="session-item' + activeClass + selectedClass + '" data-session-id="' + session.id + '" role="button" tabindex="0">' + swipeBgHtml + '<div class="session-item-content"><div class="session-item-row">' + checkbox + '<div class="session-main"><div class="session-title-row">' + titleHtml + timeDisplay + "</div>" + descriptionHtml + activityHtml + '<div class="session-meta"><span class="session-status ' + metaStatusClass + '">' + escapeHtml2(metaStatus) + "</span>" + badgesHtml + recoveryHtml + "</div></div>" + actionsHtml + "</div></div></div>";
  }
  function getWorktreeMergeStatusLabel(session) {
    if (!session || !session.worktreeMergeStatus) return "";
    var labels = {
      ready: "\u53EF\u5408\u5E76",
      checking: "\u68C0\u67E5\u4E2D",
      merging: "\u5408\u5E76\u4E2D",
      merged: session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false ? "\u5DF2\u5408\u5E76\u5F85\u6E05\u7406" : "\u5DF2\u5408\u5E76",
      failed: "\u5408\u5E76\u5931\u8D25"
    };
    return labels[session.worktreeMergeStatus] || "";
  }
  function renderWorktreeMergeBadge(session) {
    var label = getWorktreeMergeStatusLabel(session);
    if (!label) return "";
    return '<span class="session-kind-badge worktree-merge ' + escapeHtml2(session.worktreeMergeStatus || "") + '">' + escapeHtml2(label) + "</span>";
  }
  function renderWorktreeBadge(session) {
    if (!session || !session.worktreeEnabled) return "";
    var titleParts = [];
    if (session.worktree && session.worktree.branch) {
      titleParts.push("Worktree: " + session.worktree.branch);
    }
    if (session.worktree && session.worktree.path) {
      titleParts.push("Path: " + session.worktree.path);
    }
    var title = titleParts.length > 0 ? ' title="' + escapeHtml2(titleParts.join("\n")) + '"' : "";
    return '<span class="session-kind-badge worktree"' + title + ">Worktree</span>" + renderWorktreeMergeBadge(session);
  }
  function renderSessionKindBadge(session) {
    if (!session) return "";
    var primary = isStructuredSession2(session) ? '<span class="session-kind-badge structured">Structured</span>' : '<span class="session-kind-badge pty">PTY</span>';
    return primary + renderWorktreeBadge(session);
  }
  function renderModeCards(selectedMode) {
    var modes = [
      { id: "managed", label: "\u6258\u7BA1", desc: "\u5168\u81EA\u52A8\u5B8C\u6210\u4EFB\u52A1" },
      { id: "full-access", label: "\u5168\u6743\u9650", desc: "\u81EA\u52A8\u786E\u8BA4\u6743\u9650" },
      { id: "auto-edit", label: "\u81EA\u52A8\u7F16\u8F91", desc: "\u81EA\u52A8\u786E\u8BA4\u4FEE\u6539" },
      { id: "default", label: "\u6807\u51C6", desc: "\u9010\u6B65\u786E\u8BA4\u64CD\u4F5C" },
      { id: "native", label: "\u539F\u751F", desc: "\u539F\u751F\u7ED3\u6784\u5316\u8F93\u51FA" }
    ];
    return modes.map(function(m) {
      var active = m.id === selectedMode ? " active" : "";
      return '<button type="button" class="mode-card' + active + '" data-mode="' + m.id + '"><span class="mode-card-label">' + m.label + '</span><span class="mode-card-desc">' + m.desc + "</span></button>";
    }).join("");
  }
  function renderProviderOptions(selectedTool) {
    var tools = [
      { id: "claude", label: "Claude", desc: "\u5B8C\u6574 Claude \u4F1A\u8BDD\u80FD\u529B" },
      { id: "codex", label: "Codex", desc: "\u7ED3\u6784\u5316 JSONL \u6216 PTY \u4F1A\u8BDD" },
      { id: "opencode", label: "OpenCode", desc: "\u591A\u6A21\u578B\u7ED3\u6784\u5316\u6216 PTY \u4F1A\u8BDD" }
    ];
    return tools.map(function(tool) {
      var active = tool.id === selectedTool ? " active" : "";
      return '<button type="button" class="mode-card provider-card' + active + '" data-provider="' + tool.id + '"><span class="mode-card-label">' + tool.label + '</span><span class="mode-card-desc">' + tool.desc + "</span></button>";
    }).join("");
  }
  function renderSessionKindOptions(selectedKind) {
    var kinds = [
      { id: "structured", label: "\u7ED3\u6784\u5316", desc: "\u667A\u80FD\u5BF9\u8BDD\u6A21\u5F0F" },
      { id: "pty", label: "PTY", desc: "\u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u4F1A\u8BDD" }
    ];
    return kinds.map(function(kind) {
      var active = kind.id === selectedKind ? " active" : "";
      var disabled = "";
      return '<button type="button" class="mode-card session-kind-card' + active + disabled + '" data-session-kind="' + kind.id + '"><span class="mode-card-label">' + kind.label + '</span><span class="mode-card-desc">' + kind.desc + "</span></button>";
    }).join("");
  }
  function renderWorktreeToggle(enabled) {
    return '<label class="session-inline-toggle" for="session-worktree-toggle" title="\u4E3A\u8BE5\u4F1A\u8BDD\u521B\u5EFA\u72EC\u7ACB\u7684 git worktree \u5206\u652F"><svg class="session-inline-toggle-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M6 8.2v3.4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8.2"/><path d="M12 13.6v2.2"/></svg><span class="session-inline-toggle-label">Worktree \u6A21\u5F0F</span><input id="session-worktree-toggle" type="checkbox" class="switch-toggle"' + (enabled ? " checked" : "") + ' /><span class="switch-slider" aria-hidden="true"></span></label>';
  }
  function getSessionKindHint(kind) {
    var tool = state.sessionTool || "claude";
    if (kind === "structured") {
      return tool === "codex" ? "Codex JSONL \u7ED3\u6784\u5316\u804A\u5929\u754C\u9762\uFF0C\u652F\u6301\u591A\u8F6E\u5BF9\u8BDD\u548C\u5DE5\u5177\u8C03\u7528\u5C55\u793A\u3002" : tool === "opencode" ? "OpenCode JSON \u7ED3\u6784\u5316\u804A\u5929\u754C\u9762\uFF0C\u652F\u6301\u7EED\u804A\u3001\u601D\u8003\u8FC7\u7A0B\u548C\u5DE5\u5177\u8C03\u7528\u5C55\u793A\u3002" : "\u7ED3\u6784\u5316\u804A\u5929\u754C\u9762\uFF0C\u652F\u6301\u591A\u8F6E\u5BF9\u8BDD\u3001\u6D41\u5F0F\u8F93\u51FA\u548C\u5DE5\u5177\u8C03\u7528\u5C55\u793A\u3002";
    }
    if (tool === "codex") {
      return "Codex PTY \u7EC8\u7AEF\u4F1A\u8BDD\uFF1Bterminal \u662F\u539F\u59CB\u8F93\u51FA\uFF0Cchat \u662F\u89E3\u6790\u540E\u7684\u9605\u8BFB\u89C6\u56FE\u3002";
    }
    if (tool === "opencode") return "OpenCode TUI \u7684\u539F\u59CB PTY \u7EC8\u7AEF\u4F1A\u8BDD\u3002";
    return "\u539F\u59CB PTY \u7EC8\u7AEF\u4F1A\u8BDD\uFF0C\u652F\u6301\u6301\u7EED\u4EA4\u4E92\u3001\u7EC8\u7AEF\u89C6\u56FE\u548C\u6743\u9650\u6D41\u3002";
  }
  function renderSessionModal() {
    var modalTool = getPreferredTool();
    var modalMode = getSafeModeForTool(modalTool, state.modeValue || state.chatMode || "default");
    var sessionKind = state.sessionCreateKind || "structured";
    var worktreeEnabled = state.sessionCreateWorktree === true;
    return '<section id="session-modal" class="modal-backdrop hidden"><div class="modal session-modal"><div class="modal-header"><div><h2 class="modal-title">\u65B0\u5BF9\u8BDD</h2><p class="modal-subtitle">\u542F\u52A8 Claude\u3001Codex \u6216 OpenCode \u4F1A\u8BDD\uFF0C\u9009\u62E9 provider\u3001\u4F1A\u8BDD\u7C7B\u578B\u3001\u6A21\u5F0F\u548C\u5DE5\u4F5C\u76EE\u5F55\u3002</p></div><button id="close-modal-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="\u5173\u95ED"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div><div class="modal-body"><div class="field"><label class="field-label">Provider</label><div id="provider-cards" class="mode-cards">' + renderProviderOptions(modalTool) + '</div></div><div class="field"><label class="field-label">\u4F1A\u8BDD\u7C7B\u578B</label><div id="session-kind-cards" class="mode-cards">' + renderSessionKindOptions(sessionKind) + '</div><div class="field-hint session-kind-hint-row"><span id="session-kind-description">' + escapeHtml2(getSessionKindHint(sessionKind)) + '</span></div></div><div class="field"><label class="field-label" for="cwd">\u5DE5\u4F5C\u76EE\u5F55</label><div class="suggestions-wrap"><input id="cwd" type="text" class="field-input" autocomplete="off" placeholder="' + escapeHtml2(getEffectiveCwd3()) + '" /><div id="cwd-suggestions" class="suggestions hidden"></div></div><p class="field-hint">\u521B\u5EFA\u524D\u5148\u786E\u8BA4\u76EE\u5F55\uFF1B\u7559\u7A7A\u5219\u4F7F\u7528\u4E0A\u65B9\u76EE\u5F55\uFF0C\u652F\u6301\u8DEF\u5F84\u81EA\u52A8\u8865\u5168\u3002</p><div id="recent-paths-bubbles" class="recent-paths-bubbles"></div></div><div class="field"><label class="field-label">\u6A21\u5F0F</label><div id="mode-cards" class="mode-cards">' + renderModeCards(modalMode) + '</div><p id="mode-description" class="field-hint">' + escapeHtml2(getToolModeHint2(modalTool, modalMode)) + '</p></div></div><div class="modal-footer"><button id="run-button" class="btn btn-primary btn-block">\u542F\u52A8\u4F1A\u8BDD</button><p id="modal-error" class="error-message hidden"></p></div></div></section>';
  }

  // src/web-ui/browser/sidebar.ts
  var NON_WAND_SESSIONS_EXPANDED_KEY = "wand-non-wand-sessions-expanded";
  var AUTOMATION_SESSIONS_EXPANDED_KEY = "wand-automation-sessions-expanded";
  function getSecondaryGroupStorageKey(group) {
    if (group.classList.contains("automation-session-group")) return AUTOMATION_SESSIONS_EXPANDED_KEY;
    if (group.classList.contains("non-wand-session-group")) return NON_WAND_SESSIONS_EXPANDED_KEY;
    return "";
  }
  document.addEventListener("toggle", function(event) {
    var group = event.target;
    if (!group || !group.classList) return;
    var storageKey = getSecondaryGroupStorageKey(group);
    if (!storageKey) return;
    if (state.sessionsManageMode) {
      if (!group.open) group.open = true;
      return;
    }
    writeStoredBoolean(storageKey, group.open);
  }, true);
  document.addEventListener("click", function(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    if (target.closest(".non-wand-session-group.manage-mode > summary, .automation-session-group.manage-mode > summary")) {
      event.preventDefault();
      return;
    }
    var compactTrigger = target.closest("[data-expand-session-group]");
    if (!compactTrigger) return;
    var targetGroup = compactTrigger.dataset.expandSessionGroup;
    var storageKey = targetGroup === "automation" ? AUTOMATION_SESSIONS_EXPANDED_KEY : targetGroup === "non-wand" ? NON_WAND_SESSIONS_EXPANDED_KEY : "";
    if (!storageKey) return;
    writeStoredBoolean(storageKey, true);
    var collapseButton = document.getElementById("sidebar-collapse-btn");
    if (collapseButton) collapseButton.click();
  });
  function isAutomationSession(session) {
    var source = String(session && session.sessionSource || "").toLowerCase();
    return source === "automation" || source === "startup";
  }
  function sortSessionEntries(entries) {
    return entries.sort(function(a, b) {
      return b.t - a.t;
    });
  }
  function getSessionEntryGroups() {
    var wandEntries = [];
    var automationEntries = [];
    var nonWandEntries = [];
    state.sessions.forEach(function(s) {
      var t15 = s.startedAt ? new Date(s.startedAt).getTime() : 0;
      var entry = { kind: "session", ref: s, t: isFinite(t15) ? t15 : 0 };
      (isAutomationSession(s) ? automationEntries : wandEntries).push(entry);
    });
    if (state.claudeHistoryLoaded) {
      getVisibleClaudeHistorySessions().forEach(function(h) {
        var t15 = h.timestamp ? new Date(h.timestamp).getTime() : Number(h.mtimeMs) || 0;
        if (!isFinite(t15)) t15 = Number(h.mtimeMs) || 0;
        nonWandEntries.push({ kind: "history", ref: h, t: t15 });
      });
    }
    if (state.codexHistoryLoaded) {
      getVisibleCodexHistorySessions().forEach(function(h) {
        var t15 = h.timestamp ? new Date(h.timestamp).getTime() : Number(h.mtimeMs) || 0;
        nonWandEntries.push({ kind: "codex", ref: h, t: isFinite(t15) ? t15 : 0 });
      });
    }
    return {
      wand: sortSessionEntries(wandEntries),
      automation: sortSessionEntries(automationEntries),
      nonWand: sortSessionEntries(nonWandEntries)
    };
  }
  function getSessionEntries() {
    var groups = getSessionEntryGroups();
    return groups.wand.concat(groups.automation, groups.nonWand);
  }
  function renderSessions2() {
    var groups = [];
    groups.push(renderSessionManageBar());
    var entries = getSessionEntryGroups();
    if (entries.wand.length + entries.automation.length + entries.nonWand.length === 0) {
      return renderSessionManageBar() + '<div class="empty-state"><strong>\u8FD8\u6CA1\u6709\u4F1A\u8BDD\u8BB0\u5F55</strong><br>\u70B9\u51FB\u4E0A\u65B9\u300C\u65B0\u5BF9\u8BDD\u300D\u5F00\u59CB\u4F60\u7684\u7B2C\u4E00\u6B21\u5BF9\u8BDD\u3002</div>';
    }
    if (entries.wand.length > 0) groups.push(renderSessionEntries(entries.wand));
    if (entries.automation.length > 0) groups.push(renderAutomationSessionGroup(entries.automation));
    if (entries.nonWand.length > 0) groups.push(renderNonWandSessionGroup(entries.nonWand));
    return groups.join("");
  }
  function isSidebarNarrow() {
    return !!state.sidebarPinned && !!state.sidebarCollapsed;
  }
  function renderCollapsedSessionTiles() {
    var entries = getSessionEntryGroups();
    var tiles = entries.wand.map(function(e, i) {
      var idx = i + 1;
      var s = e.ref;
      var activeCls = s.id === state.selectedId ? " active" : "";
      var title = s.title || s.description || s.summary || s.command || "\u4F1A\u8BDD " + idx;
      return '<button class="sidebar-collapsed-tile' + activeCls + '" type="button" data-collapsed-session-id="' + escapeHtml2(s.id) + '" title="' + escapeHtml2(title) + '">' + idx + "</button>";
    }).join("");
    var automationCount = entries.automation.length;
    var automationActive = entries.automation.some(function(entry) {
      return entry.ref.id === state.selectedId;
    });
    var automationTile = automationCount > 0 ? '<button class="sidebar-collapsed-tile automation-count-tile' + (automationActive ? " active-group" : "") + '" type="button" data-expand-session-group="automation" title="\u5C55\u5F00\u67E5\u770B ' + automationCount + ' \u4E2A\u81EA\u52A8\u5316\u4F1A\u8BDD" aria-label="\u5C55\u5F00\u67E5\u770B ' + automationCount + ' \u4E2A\u81EA\u52A8\u5316\u4F1A\u8BDD"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg><span class="non-wand-count-badge">' + (automationCount > 99 ? "99+" : automationCount) + "</span></button>" : "";
    var nonWandCount = entries.nonWand.length;
    var nonWandTile = nonWandCount > 0 ? '<button class="sidebar-collapsed-tile non-wand-count-tile" type="button" data-expand-session-group="non-wand" title="\u5C55\u5F00\u67E5\u770B ' + nonWandCount + ' \u4E2A\u975E Wand \u4F1A\u8BDD" aria-label="\u5C55\u5F00\u67E5\u770B ' + nonWandCount + ' \u4E2A\u975E Wand \u4F1A\u8BDD"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg><span class="non-wand-count-badge">' + (nonWandCount > 99 ? "99+" : nonWandCount) + "</span></button>" : "";
    var addTile = '<button class="sidebar-collapsed-tile add" type="button" data-collapsed-new-session="1" title="\u65B0\u5EFA\u4F1A\u8BDD" aria-label="\u65B0\u5EFA\u4F1A\u8BDD"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>';
    return '<div class="sidebar-collapsed-tiles">' + tiles + automationTile + nonWandTile + addTile + "</div>";
  }
  function renderSessionsListContent() {
    return isSidebarNarrow() ? renderCollapsedSessionTiles() : renderSessions2();
  }
  function renderSessionManageBar() {
    if (!state.sessionsManageMode) {
      return '<div class="session-manage-bar"><span class="sidebar-intro">Wand \u4F1A\u8BDD</span><button class="btn btn-ghost btn-xs session-manage-toggle" data-action="toggle-manage-mode" type="button"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span>\u7BA1\u7406</span></button></div>';
    }
    var sessionCount = getSelectedSessionIds().length;
    var historyCount = getSelectedClaudeHistoryIds().length;
    var codexCount = getSelectedCodexHistoryIds().length;
    var totalCount = sessionCount + historyCount + codexCount;
    var hasAny = totalCount > 0;
    var selectable = countSelectableItems();
    var allSelected = selectable > 0 && totalCount >= selectable;
    var selectAllLabel = allSelected ? "\u53D6\u6D88\u5168\u9009" : "\u5168\u9009";
    var selectAllAction = allSelected ? "clear-selection" : "select-all-visible";
    var selectAllDisabled = selectable === 0 ? " disabled" : "";
    var exitBtn = '<button class="session-manage-exit" data-action="toggle-manage-mode" type="button" aria-label="\u9000\u51FA\u7BA1\u7406\u6A21\u5F0F" title="\u9000\u51FA\u7BA1\u7406\u6A21\u5F0F"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>';
    var summary = hasAny ? '<span class="session-manage-count">' + totalCount + '</span><span class="session-manage-summary-label">\u5DF2\u9009\u62E9</span>' : '<span class="session-manage-summary-label muted">\u9009\u62E9\u8981\u7BA1\u7406\u7684\u9879\u76EE</span>';
    return '<div class="session-manage-bar active">' + exitBtn + '<div class="session-manage-summary">' + summary + '</div><div class="session-manage-actions"><button class="btn btn-ghost btn-xs" data-action="' + selectAllAction + '" type="button"' + selectAllDisabled + ">" + selectAllLabel + '</button><button class="btn btn-danger btn-xs" data-action="delete-selected" type="button"' + (hasAny ? "" : " disabled") + ">\u5220\u9664" + (hasAny ? " " + totalCount : "") + "</button></div></div>";
  }
  function renderSessionEntries(entries, extraClass) {
    var html = '<section class="session-group' + (extraClass ? " " + extraClass : "") + '">';
    html += entries.map(function(e) {
      return e.kind === "session" ? renderSessionItem(e.ref, "sessions") : renderClaudeHistoryItem(e.ref, e.kind);
    }).join("");
    html += "</section>";
    return html;
  }
  function renderNonWandSessionGroup(entries) {
    var expanded = state.sessionsManageMode || readStoredBoolean(NON_WAND_SESSIONS_EXPANDED_KEY, false);
    return '<details class="non-wand-session-group' + (state.sessionsManageMode ? " manage-mode" : "") + '"' + (expanded ? " open" : "") + '><summary class="non-wand-session-summary" title="Claude \u4E0E Codex \u7684\u672C\u673A\u539F\u751F\u4F1A\u8BDD\uFF0C\u4E0D\u53C2\u4E0E Wand \u4F1A\u8BDD\u6392\u5E8F"><span class="non-wand-session-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg></span><span class="non-wand-session-title">\u975E Wand \u4F1A\u8BDD</span><span class="non-wand-session-count" aria-label="' + entries.length + ' \u4E2A\u4F1A\u8BDD">' + entries.length + '</span><svg class="non-wand-session-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></summary>' + renderSessionEntries(entries, "non-wand-session-list") + "</details>";
  }
  function renderAutomationSessionGroup(entries) {
    var expanded = state.sessionsManageMode || readStoredBoolean(AUTOMATION_SESSIONS_EXPANDED_KEY, false);
    return '<details class="automation-session-group' + (state.sessionsManageMode ? " manage-mode" : "") + '"' + (expanded ? " open" : "") + '><summary class="automation-session-summary" title="\u7531\u81EA\u52A8\u5316\u6216\u542F\u52A8\u4EFB\u52A1\u521B\u5EFA\uFF0C\u4E0D\u53C2\u4E0E\u666E\u901A Wand \u4F1A\u8BDD\u6392\u5E8F"><span class="automation-session-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg></span><span class="automation-session-title">\u81EA\u52A8\u5316</span><span class="automation-session-count" aria-label="' + entries.length + ' \u4E2A\u4F1A\u8BDD">' + entries.length + '</span><svg class="automation-session-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></summary>' + renderSessionEntries(entries, "automation-session-list") + "</details>";
  }
  function getVisibleClaudeHistorySessions() {
    var managedIds = /* @__PURE__ */ new Set();
    state.sessions.forEach(function(s) {
      if (s.claudeSessionId) managedIds.add(s.claudeSessionId);
    });
    return state.claudeHistory.filter(function(s) {
      return s.hasConversation && !s.managedByWand && !managedIds.has(s.claudeSessionId);
    });
  }
  function getSelectedSessionIds() {
    return Object.keys(state.selectedSessionIds).filter(function(id) {
      return !!state.selectedSessionIds[id];
    });
  }
  function getSelectedClaudeHistoryIds() {
    return Object.keys(state.selectedClaudeHistoryIds).filter(function(id) {
      return !!state.selectedClaudeHistoryIds[id];
    });
  }
  function getSelectedCodexHistoryIds() {
    return Object.keys(state.selectedCodexHistoryIds).filter(function(id) {
      return !!state.selectedCodexHistoryIds[id];
    });
  }
  function clearManageSelections() {
    state.selectedSessionIds = {};
    state.selectedClaudeHistoryIds = {};
    state.selectedCodexHistoryIds = {};
  }
  function toggleManageMode(force) {
    state.sessionsManageMode = typeof force === "boolean" ? force : !state.sessionsManageMode;
    if (state.sessionsManageMode && (!state.claudeHistoryLoaded || !state.codexHistoryLoaded)) {
      ensureClaudeHistoryLoaded().then(updateSessionsList);
    }
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
    return getSelectableSessions().length + getVisibleClaudeHistorySessions().length + getVisibleCodexHistorySessions().length;
  }
  function selectAllVisibleItems() {
    if (!state.claudeHistoryLoaded || !state.codexHistoryLoaded) {
      ensureClaudeHistoryLoaded().then(selectAllVisibleItems);
      return;
    }
    var nextSessionIds = {};
    getSelectableSessions().forEach(function(session) {
      nextSessionIds[session.id] = true;
    });
    var nextHistoryIds = {};
    getVisibleClaudeHistorySessions().forEach(function(session) {
      nextHistoryIds[session.claudeSessionId] = true;
    });
    var nextCodexIds = {};
    getVisibleCodexHistorySessions().forEach(function(session) {
      nextCodexIds[session.claudeSessionId] = true;
    });
    state.selectedSessionIds = nextSessionIds;
    state.selectedClaudeHistoryIds = nextHistoryIds;
    state.selectedCodexHistoryIds = nextCodexIds;
    updateSessionsList();
  }
  function clearSelections() {
    clearManageSelections();
    updateSessionsList();
  }
  function toggleManagedItemSelection(kind, id) {
    if (!state.sessionsManageMode || !id) return;
    var target = kind === "history" ? state.selectedClaudeHistoryIds : kind === "codex" ? state.selectedCodexHistoryIds : state.selectedSessionIds;
    if (target[id]) {
      delete target[id];
    } else {
      target[id] = true;
    }
    updateSessionsList();
  }
  function renderManageCheckbox(kind, id, label) {
    if (!state.sessionsManageMode) return "";
    var selected = kind === "history" ? !!state.selectedClaudeHistoryIds[id] : kind === "codex" ? !!state.selectedCodexHistoryIds[id] : !!state.selectedSessionIds[id];
    return '<label class="session-manage-check"><input type="checkbox" data-action="toggle-selection" data-kind="' + escapeHtml2(kind) + '" data-id="' + escapeHtml2(id) + '"' + (selected ? " checked" : "") + ' aria-label="' + escapeHtml2(label) + '"><span></span></label>';
  }
  function confirmDelete(message, options) {
    return wandConfirm2(message, Object.assign({ type: "danger", danger: true, okLabel: "\u5220\u9664" }, options || {}));
  }
  function batchDeleteSelected() {
    var sessionIds = getSelectedSessionIds();
    var historyIds = getSelectedClaudeHistoryIds();
    var codexIds = getSelectedCodexHistoryIds();
    var managedProviderIds = state.sessions.filter(function(session) {
      return sessionIds.indexOf(session.id) !== -1;
    }).map(function(session) {
      return session.claudeSessionId;
    }).filter(Boolean);
    var total = sessionIds.length + historyIds.length + codexIds.length;
    if (!total) return;
    confirmDelete("\u786E\u8BA4\u5220\u9664\u6240\u9009 " + total + " \u9879\u5417\uFF1F\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002", {
      title: "\u5220\u9664\u6240\u9009 " + total + " \u9879"
    }).then(function(ok) {
      if (!ok) return;
      var requests = [];
      if (sessionIds.length > 0) {
        requests.push(fetch("/api/sessions/batch-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ sessionIds })
        }).then(function(res) {
          return res.json();
        }));
      }
      if (historyIds.length > 0) {
        requests.push(fetch("/api/claude-history/batch-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ claudeSessionIds: historyIds })
        }).then(function(res) {
          return res.json();
        }));
      }
      if (codexIds.length > 0) {
        requests.push(fetch("/api/codex-history/batch-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ claudeSessionIds: codexIds })
        }).then(function(res) {
          return res.json();
        }));
      }
      Promise.all(requests).then(function() {
        if (sessionIds.indexOf(state.selectedId) !== -1) {
          state.selectedId = null;
          persistSelectedId();
        }
        state.claudeHistory = state.claudeHistory.filter(function(session) {
          return historyIds.indexOf(session.claudeSessionId) === -1 && managedProviderIds.indexOf(session.claudeSessionId) === -1;
        });
        state.codexHistory = state.codexHistory.filter(function(session) {
          return codexIds.indexOf(session.claudeSessionId) === -1 && managedProviderIds.indexOf(session.claudeSessionId) === -1;
        });
        clearManageSelections();
        return refreshAll();
      }).catch(function() {
        var errorEl = document.getElementById("action-error");
        showError2(errorEl, "\u65E0\u6CD5\u6279\u91CF\u5220\u9664\u6240\u9009\u9879\u76EE\u3002");
      });
    });
  }
  function clearAllClaudeHistory() {
    var cutoff = Date.now() - 24 * 60 * 60 * 1e3;
    var visibleHistory = getVisibleClaudeHistorySessions().filter(function(s) {
      return !s.timestamp || new Date(s.timestamp).getTime() <= cutoff;
    });
    if (!visibleHistory.length) return;
    return confirmDelete("\u786E\u8BA4\u6E05\u7A7A\u5F53\u524D\u663E\u793A\u7684 " + visibleHistory.length + " \u6761 Claude \u5386\u53F2\u5417\uFF1F", {
      title: "\u6E05\u7A7A Claude \u5386\u53F2",
      okLabel: "\u6E05\u7A7A"
    }).then(function(ok) {
      if (!ok) return;
      var deleteIds = visibleHistory.map(function(session) {
        return session.claudeSessionId;
      });
      return fetch("/api/claude-history/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ claudeSessionIds: deleteIds })
      }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (data && data.error) {
          throw new Error(data.error);
        }
        state.claudeHistory = state.claudeHistory.filter(function(s) {
          return deleteIds.indexOf(s.claudeSessionId) === -1;
        });
        clearManageSelections();
        updateSessionsList();
      }).catch(function() {
        var errorEl = document.getElementById("action-error");
        showError2(errorEl, "\u65E0\u6CD5\u6E05\u7A7A\u5386\u53F2\u4F1A\u8BDD\u3002");
      });
    });
  }
  function renderClaudeHistoryItem(session, kind) {
    var isCodex = kind === "codex";
    var rAct = isCodex ? "resume-codex-history" : "resume-history";
    var dAct = isCodex ? "delete-codex-history" : "delete-history";
    var selMap = isCodex ? state.selectedCodexHistoryIds : state.selectedClaudeHistoryIds;
    var shortId = session.claudeSessionId.slice(0, 8);
    var preview = session.firstUserMessage || "(\u7A7A\u4F1A\u8BDD)";
    var timeStr = formatHistoryTime(session.timestamp);
    var checkbox = renderManageCheckbox(kind, session.claudeSessionId, "\u9009\u62E9\u4F1A\u8BDD " + preview);
    var deleteButton = state.sessionsManageMode ? "" : '<button class="session-action-btn delete-btn" data-action="' + dAct + '" data-claude-session-id="' + session.claudeSessionId + '" type="button" aria-label="\u5220\u9664\u4F1A\u8BDD" title="\u5220\u9664\u4F1A\u8BDD"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
    var resumeButton = state.sessionsManageMode ? "" : '<button class="session-action-btn" data-action="' + rAct + '" data-claude-session-id="' + session.claudeSessionId + '" data-cwd="' + escapeHtml2(session.cwd) + '" type="button" aria-label="\u6062\u590D\u4F1A\u8BDD" title="' + (isCodex ? "\u6062\u590D\u6B64 Codex \u4F1A\u8BDD" : "\u6062\u590D\u6B64 Claude \u4F1A\u8BDD") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';
    return '<div class="session-item non-wand-session' + (state.sessionsManageMode && selMap[session.claudeSessionId] ? " selected" : "") + '" data-claude-history-id="' + session.claudeSessionId + '" data-provider="' + (isCodex ? "codex" : "claude") + '" data-cwd="' + escapeHtml2(session.cwd) + '" role="button" tabindex="0"><div class="session-item-content"><div class="session-item-row">' + checkbox + '<div class="session-main"><div class="session-command claude-history-preview">' + escapeHtml2(preview) + '</div><div class="session-meta"><span class="session-id" title="' + escapeHtml2(session.claudeSessionId) + '">' + escapeHtml2(shortId) + "</span><span>" + escapeHtml2(timeStr) + '</span></div></div><span class="session-actions">' + resumeButton + deleteButton + "</span></div></div></div>";
  }
  function formatHistoryTime(isoStr) {
    if (!isoStr) return "";
    try {
      var d = new Date(isoStr);
      var now = /* @__PURE__ */ new Date();
      var diffMs = now - d;
      var diffMin = Math.floor(diffMs / 6e4);
      if (diffMin < 1) return "\u521A\u521A";
      if (diffMin < 60) return diffMin + " \u5206\u949F\u524D";
      var diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return diffHr + " \u5C0F\u65F6\u524D";
      var diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) return diffDay + " \u5929\u524D";
      return d.toLocaleDateString();
    } catch (e) {
      return "";
    }
  }
  function loadClaudeHistory() {
    return fetch("/api/claude-history", { credentials: "same-origin" }).then(function(res) {
      if (!res.ok) return [];
      return res.json();
    }).then(function(sessions) {
      state.claudeHistory = sessions || [];
      state.claudeHistoryLoaded = true;
      updateSessionsList();
    }).catch(function() {
      state.claudeHistoryLoaded = true;
      state.claudeHistory = [];
      updateSessionsList();
    });
  }
  var _claudeHistoryLoadingPromise = null;
  function ensureClaudeHistoryLoaded() {
    var codexPromise = ensureCodexHistoryLoaded();
    if (!state.claudeHistoryLoaded && !_claudeHistoryLoadingPromise) {
      _claudeHistoryLoadingPromise = loadClaudeHistory().then(function() {
        _claudeHistoryLoadingPromise = null;
      }, function() {
        _claudeHistoryLoadingPromise = null;
      });
    }
    var claudePromise = _claudeHistoryLoadingPromise || Promise.resolve();
    return Promise.all([claudePromise, codexPromise]).then(function() {
    });
  }
  function loadCodexHistory() {
    return fetch("/api/codex-history", { credentials: "same-origin" }).then(function(res) {
      if (!res.ok) return [];
      return res.json();
    }).then(function(sessions) {
      state.codexHistory = sessions || [];
      state.codexHistoryLoaded = true;
      updateSessionsList();
    }).catch(function() {
      state.codexHistoryLoaded = true;
      state.codexHistory = [];
      updateSessionsList();
    });
  }
  var _codexHistoryLoadingPromise = null;
  function ensureCodexHistoryLoaded() {
    if (state.codexHistoryLoaded) return Promise.resolve();
    if (_codexHistoryLoadingPromise) return _codexHistoryLoadingPromise;
    _codexHistoryLoadingPromise = loadCodexHistory().then(function() {
      _codexHistoryLoadingPromise = null;
    }, function() {
      _codexHistoryLoadingPromise = null;
    });
    return _codexHistoryLoadingPromise;
  }
  function getVisibleCodexHistorySessions() {
    var managedIds = /* @__PURE__ */ new Set();
    state.sessions.forEach(function(s) {
      if (s.claudeSessionId) managedIds.add(s.claudeSessionId);
    });
    return state.codexHistory.filter(function(s) {
      return s.hasConversation && !s.managedByWand && !managedIds.has(s.claudeSessionId);
    });
  }

  // src/web-ui/browser/websocket.ts
  function startPolling() {
    stopPolling();
    if (initWebSocket()) {
      return;
    }
    state.pollTimer = setInterval(refreshAll, 1600);
  }
  setInterval(function() {
    var timeEls = document.querySelectorAll(".session-time");
    if (timeEls.length > 0) scheduleSessionListUpdate();
  }, 3e4);
  function cancelWsReconnect() {
    if (state.wsReconnectTimer) {
      clearTimeout(state.wsReconnectTimer);
      state.wsReconnectTimer = null;
    }
  }
  var WS_HEARTBEAT_CHECK_MS = 1e4;
  var WS_HEARTBEAT_STALE_MS = 4e4;
  function startWsHeartbeatCheck() {
    stopWsHeartbeatCheck();
    state.wsHeartbeatCheckTimer = setInterval(evaluateWsHeartbeatStale2, WS_HEARTBEAT_CHECK_MS);
  }
  function stopWsHeartbeatCheck() {
    if (state.wsHeartbeatCheckTimer) {
      clearInterval(state.wsHeartbeatCheckTimer);
      state.wsHeartbeatCheckTimer = null;
    }
  }
  function evaluateWsHeartbeatStale2() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (!state.lastWsMessageAt) return;
    var idle = Date.now() - state.lastWsMessageAt;
    if (idle > WS_HEARTBEAT_STALE_MS) {
      forceReconnectWebSocket("heartbeat-stale-" + Math.round(idle / 1e3) + "s");
    }
  }
  function forceReconnectWebSocket(reason) {
    cancelWsReconnect();
    if (state.ws) {
      var stale = state.ws;
      try {
        stale.onclose = null;
      } catch (e) {
      }
      try {
        stale.onerror = null;
      } catch (e) {
      }
      try {
        stale.onmessage = null;
      } catch (e) {
      }
      try {
        stale.close();
      } catch (e) {
      }
      state.ws = null;
    }
    state.wsConnected = false;
    state.wsReconnectAttempts = 0;
    initWebSocket(reason);
  }
  function scheduleWsReconnect() {
    if (state.wsReconnectTimer) return;
    if (document.hidden) return;
    var attempt = state.wsReconnectAttempts || 0;
    var delays = [500, 1e3, 2e3, 4e3, 8e3];
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
    if (state.ws) {
      try {
        state.ws.close();
      } catch (e) {
      }
      state.ws = null;
    }
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var wsUrl = protocol + "//" + window.location.host + "/ws";
    try {
      var ws = new WebSocket(wsUrl);
      ws.onopen = function() {
        state.ws = ws;
        state.wsConnected = true;
        state.lastWsMessageAt = Date.now();
        state.wsReconnectAttempts = 0;
        cancelWsReconnect();
        state.lastSeqBySession = {};
        startWsHeartbeatCheck();
        subscribeToSession(state.selectedId);
        flushPendingMessages();
        ensureTerminalFitWithRetry("ws-reconnect");
      };
      ws.onmessage = function(event) {
        state.lastWsMessageAt = Date.now();
        try {
          var msg = JSON.parse(event.data);
          if (msg && msg.type === "ping") {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              try {
                state.ws.send(JSON.stringify({ type: "pong", t: msg.t }));
              } catch (sendErr) {
              }
            }
            return;
          }
          if (msg && msg.type === "resync_required" && msg.sessionId) {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              try {
                state.ws.send(JSON.stringify({ type: "resync", sessionId: msg.sessionId }));
              } catch (sendErr) {
              }
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
              if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                try {
                  state.ws.send(JSON.stringify({ type: "resync", sessionId: msg.sessionId }));
                } catch (sendErr) {
                }
              }
              state.lastSeqBySession[msg.sessionId] = 0;
              return;
            } else {
              if (msg.seq < prevSeq) return;
              state.lastSeqBySession[msg.sessionId] = msg.seq;
            }
          }
          handleWebSocketMessage(msg);
        } catch (e) {
        }
      };
      ws.onclose = function() {
        state.ws = null;
        state.wsConnected = false;
        stopWsHeartbeatCheck();
        scheduleWsReconnect();
      };
      ws.onerror = function() {
        ws.close();
      };
      return true;
    } catch (e) {
      scheduleWsReconnect();
      return false;
    }
  }
  function handleWebSocketMessage(msg) {
    switch (msg.type) {
      case "output":
        if (msg.data && msg.sessionId && Object.prototype.hasOwnProperty.call(msg.data, "isResponding")) {
          if (!state._lastIsResponding) state._lastIsResponding = {};
          state._lastIsResponding[msg.sessionId] = !!msg.data.isResponding;
        }
        if (msg.data && msg.sessionId) {
          var isIncremental = !!msg.data.incremental;
          var snapshot = { id: msg.sessionId };
          var topicMetadataChanged = false;
          if (!isIncremental && msg.data.output !== void 0) {
            snapshot.output = msg.data.output;
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "permissionBlocked")) {
            snapshot.permissionBlocked = !!msg.data.permissionBlocked;
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "queuedMessages")) {
            snapshot.queuedMessages = msg.data.queuedMessages || [];
            state.queueEpoch++;
          }
          if (msg.data.structuredState) {
            snapshot.structuredState = msg.data.structuredState;
          }
          if (msg.data.sessionKind) {
            snapshot.sessionKind = msg.data.sessionKind;
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "title")) {
            snapshot.title = msg.data.title;
            topicMetadataChanged = true;
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "description")) {
            snapshot.description = msg.data.description;
            topicMetadataChanged = true;
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "summary")) {
            snapshot.summary = msg.data.summary;
          }
          if (msg.data.messages) {
            snapshot.messages = msg.data.messages;
            if (typeof msg.data.messageOffset === "number") snapshot.messageOffset = msg.data.messageOffset;
            if (typeof msg.data.messageTotal === "number") snapshot.messageTotal = msg.data.messageTotal;
          } else if (isIncremental && msg.data.lastMessage) {
            var existingSession = state.sessions.find(function(s) {
              return s.id === msg.sessionId;
            });
            if (existingSession) {
              var msgs = Array.isArray(existingSession.messages) ? existingSession.messages.slice() : [];
              var expectedCount = msg.data.messageCount || 0;
              var baseOffset = typeof existingSession.messageOffset === "number" ? existingSession.messageOffset : 0;
              var localLast = msgs.length > 0 ? msgs[msgs.length - 1] : null;
              var incoming = msg.data.lastMessage;
              if (localLast && incoming.role && localLast.role === incoming.role) {
                msgs[msgs.length - 1] = mergeAssistantTurn(localLast, incoming);
              } else if (baseOffset + msgs.length < expectedCount) {
                msgs.push(incoming);
              }
              snapshot.messages = msgs;
              if (expectedCount > 0) snapshot.messageTotal = expectedCount;
            }
          }
          var isChunkOnly = isIncremental && msg.data.chunk && !msg.data.lastMessage && !snapshot.messages && snapshot.output === void 0 && !msg.data.structuredState && !msg.data.sessionKind;
          if (isChunkOnly) {
            if (msg.data.permissionBlocked !== void 0) {
              var existingPB = state.sessions.find(function(s) {
                return s.id === msg.sessionId;
              });
              if (existingPB && !!existingPB.permissionBlocked !== !!msg.data.permissionBlocked) {
                updateSessionSnapshot(snapshot);
                if (msg.sessionId === state.selectedId) updateTaskDisplay();
              }
            }
          } else if (snapshot.output !== void 0 || snapshot.messages || isIncremental || msg.data.permissionBlocked !== void 0 || snapshot.title || snapshot.description) {
            updateSessionSnapshot(snapshot);
            if (topicMetadataChanged) scheduleSessionListUpdate();
            if (msg.sessionId === state.selectedId) {
              var updatedSession = state.sessions.find(function(s) {
                return s.id === msg.sessionId;
              }) || snapshot;
              state.currentMessages = buildMessagesForRender(updatedSession, getPreferredMessages(updatedSession, updatedSession.output, false));
              updateTaskDisplay();
              if (updatedSession.sessionKind === "structured" || msg.data.sessionKind === "structured") {
                renderChat2();
              } else {
                scheduleChatRender();
              }
            }
          }
        }
        if (msg.sessionId === state.selectedId && state.terminal && msg.data) {
          if (msg.data.chunk && isCurrentTerminalSession(msg.sessionId)) {
            state.lastChunkAt = Date.now();
            state.terminalLiveStreamSessions[msg.sessionId] = true;
            wandTerminalWrite(state.terminal, msg.data.chunk);
            state.terminalSessionId = msg.sessionId;
            if (msg.data.output) {
              state.terminalOutput = clampClientTerminalOutput(normalizeTerminalOutput(msg.data.output));
              state.terminalOutputMarker = 0;
            } else {
              state.terminalOutput = clampClientTerminalOutput((state.terminalOutput || "") + normalizeTerminalOutput(msg.data.chunk));
            }
            maybeScrollTerminalToBottom("output");
            updateTerminalJumpToBottomButton();
          } else if (!msg.data.incremental && Object.prototype.hasOwnProperty.call(msg.data, "output")) {
            syncTerminalBuffer(msg.sessionId, msg.data.output || "", { mode: "append" });
          }
        }
        break;
      case "started":
        loadSessions();
        break;
      case "ended": {
        var endedStatus = msg.data && msg.data.status ? msg.data.status : "exited";
        var endedPermBlocked = msg.data && Object.prototype.hasOwnProperty.call(msg.data, "permissionBlocked") ? !!msg.data.permissionBlocked : false;
        var endedSnapshot = { id: msg.sessionId, status: endedStatus, permissionBlocked: endedPermBlocked };
        if (msg.data && msg.data.messages) {
          endedSnapshot.messages = msg.data.messages;
          if (typeof msg.data.messageOffset === "number") endedSnapshot.messageOffset = msg.data.messageOffset;
          if (typeof msg.data.messageTotal === "number") endedSnapshot.messageTotal = msg.data.messageTotal;
        }
        if (msg.data && msg.data.structuredState) {
          endedSnapshot.structuredState = msg.data.structuredState;
        }
        if (msg.data && msg.data.queuedMessages) {
          endedSnapshot.queuedMessages = msg.data.queuedMessages;
        }
        updateSessionSnapshot(endedSnapshot);
        if (msg.sessionId === state.selectedId) {
          updateInputHint("Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C");
          scheduleChatRender(true);
        }
        var endedSession = state.sessions.find(function(s) {
          return s.id === msg.sessionId;
        });
        var endedExitCode = msg.data && msg.data.exitCode;
        var endedIsError = endedExitCode !== null && endedExitCode !== void 0 && endedExitCode !== 0;
        var endedTaskSummary = endedSession ? endedSession.summary || "" : "";
        var endedLastReply = endedSession ? getLastAssistantSummary(endedSession) : "";
        var endedNotifTitle = endedIsError ? "\u4EFB\u52A1\u5F02\u5E38\u7ED3\u675F" : "\u4EFB\u52A1\u5DF2\u5B8C\u6210";
        var endedNotifBody = "";
        if (endedTaskSummary) {
          endedNotifBody = endedTaskSummary;
          if (endedLastReply && !endedIsError) {
            endedNotifBody += "\n" + endedLastReply;
          }
        } else {
          endedNotifBody = endedSession ? endedSession.command || msg.sessionId : msg.sessionId;
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
            duration: 6e3,
            actionLabel: "\u67E5\u770B",
            action: function() {
              selectSession(msg.sessionId);
            }
          });
        }
        state.messageQueue = [];
        state.pendingMessages = [];
        var endedSessionObj = state.sessions.find(function(s) {
          return s.id === msg.sessionId;
        });
        var selectedSessionObj = msg.sessionId === state.selectedId ? state.sessions.find(function(s) {
          return s.id === state.selectedId;
        }) : null;
        var isStructuredEnded = !!(endedSessionObj && endedSessionObj.sessionKind === "structured" || selectedSessionObj && selectedSessionObj.sessionKind === "structured");
        if (isStructuredEnded && msg.sessionId === state.selectedId) {
          flushStructuredInputQueue();
          clearStructuredQueuePersistence(msg.sessionId);
        } else if (!isStructuredEnded) {
          state.structuredInputQueue = [];
          clearStructuredQueuePersistence(state.selectedId);
          updateStructuredQueueCounter();
        }
        if (msg.sessionId === state.selectedId) {
          if (!isStructuredEnded) {
            setTerminalInteractive(false);
          }
          state.currentTask = null;
          updateTaskDisplay();
        }
        if (msg.sessionId === state.selectedId) {
          updateShellChrome();
        }
        loadSessions().then(function() {
          flushCrossSessionQueue();
        });
        if (msg.sessionId === state.selectedId) {
          if (!isStructuredEnded) {
            loadOutput(msg.sessionId);
          }
        }
        break;
      }
      case "init":
        if (msg.sessionId === state.selectedId && msg.data) {
          if (state.chatRenderTimer) {
            clearTimeout(state.chatRenderTimer);
            state.chatRenderTimer = null;
          }
          updateSessionSnapshot(msg.data);
          var initSession = state.sessions.find(function(s) {
            return s.id === msg.sessionId;
          });
          state.currentMessages = buildMessagesForRender(initSession || msg.data, getPreferredMessages(initSession || msg.data, msg.data.output, false));
          renderChat2(true);
          updateTaskDisplay();
          updateApprovalStats();
          var initOutput = msg.data.output || "";
          var sameTerminalSession = state.terminalSessionId === msg.sessionId;
          var currTerminalOutput = state.terminalOutput || "";
          var canAppendDelta = sameTerminalSession && currTerminalOutput.length > 0 && initOutput.length >= currTerminalOutput.length && initOutput.startsWith(currTerminalOutput);
          updateTerminalOutput(initOutput, msg.sessionId, canAppendDelta ? "append" : "replace");
          ensureTerminalFitWithRetry("init");
        }
        break;
      case "usage":
        break;
      case "task":
        if (msg.sessionId === state.selectedId) {
          state.currentTask = msg.data || null;
          updateTaskDisplay();
        }
        notifyTaskProgress(msg.sessionId, msg.data || null);
        syncSessionProgressToNative(msg.sessionId);
        scheduleSessionListUpdate();
        break;
      case "status":
        if (msg.sessionId && msg.data) {
          var statusUpdate = { id: msg.sessionId };
          if (Object.prototype.hasOwnProperty.call(msg.data, "status")) {
            statusUpdate.status = msg.data.status;
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "exitCode")) {
            statusUpdate.exitCode = msg.data.exitCode;
          }
          if (msg.data.structuredState) {
            statusUpdate.structuredState = msg.data.structuredState;
          } else if (Object.prototype.hasOwnProperty.call(msg.data, "status")) {
            var existingSession = state.sessions.find(function(s) {
              return s.id === msg.sessionId;
            });
            if (existingSession && existingSession.sessionKind === "structured") {
              statusUpdate.structuredState = Object.assign({}, existingSession.structuredState || {}, {
                inFlight: msg.data.status === "running"
              });
            }
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "queuedMessages")) {
            statusUpdate.queuedMessages = msg.data.queuedMessages || [];
            state.queueEpoch++;
          }
          if (Object.prototype.hasOwnProperty.call(msg.data, "permissionBlocked")) {
            statusUpdate.permissionBlocked = !!msg.data.permissionBlocked;
          }
          if (msg.data.permissionRequest) {
            statusUpdate.pendingEscalation = {
              scope: msg.data.permissionRequest.scope,
              target: msg.data.permissionRequest.target,
              reason: msg.data.permissionRequest.prompt
            };
            var permSession = state.sessions.find(function(s) {
              return s.id === msg.sessionId;
            });
            var permTaskName = permSession ? permSession.summary || permSession.command || msg.sessionId : msg.sessionId;
            var permDetail = msg.data.permissionRequest.prompt || "\u9700\u8981\u6743\u9650\u5BA1\u6279";
            var permTarget = msg.data.permissionRequest.target;
            var permBody = permTaskName;
            if (permTarget) {
              permBody += "\n" + permDetail + " \xB7 " + permTarget;
            } else {
              permBody += "\n" + permDetail;
            }
            _vibrate("medium");
            notifyPermissionRequest(msg.sessionId, permBody);
            if (msg.sessionId !== state.selectedId) {
              showNotificationBubble({
                title: "\u9700\u8981\u4F60\u7684\u6388\u6743",
                body: permBody,
                type: "warning",
                icon: "!",
                duration: 0,
                actionLabel: "\u53BB\u5904\u7406",
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
            if (statusUpdate.structuredState) {
              if (!statusUpdate.structuredState.inFlight) {
                updateInputHint("Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C");
                flushStructuredInputQueue();
              }
              scheduleChatRender();
            }
          }
        }
        break;
      case "notification":
        if (msg.data) {
          if (msg.data.kind === "update") {
            notifyUpdateAvailable(msg.data.current || "-", msg.data.latest || "-");
          } else if (msg.data.kind === "auto-update-start") {
            showAutoUpdateOverlay(
              msg.data.current || "-",
              msg.data.latest || "-",
              msg.data.previousInstanceId || null
            );
          } else if (msg.data.kind === "auto-update-restart") {
            showRestartOverlay(msg.data.previousInstanceId || null, msg.data.latest || null);
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
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (selectedSession && selectedSession.provider === "codex") {
      if (permissionActionsEl) permissionActionsEl.classList.add("hidden");
      taskEl.classList.remove("permission-blocked");
    }
    var pendingEscalation = selectedSession && selectedSession.pendingEscalation ? selectedSession.pendingEscalation : null;
    var isBlocked = selectedSession && selectedSession.provider !== "codex" ? pendingEscalation || selectedSession.permissionBlocked : false;
    if (isBlocked) {
      var isAutoApprove = selectedSession && selectedSession.autoApprovePermissions;
      if (permissionLabel) {
        if (isAutoApprove) {
          permissionLabel.textContent = "\u81EA\u52A8\u6279\u51C6\u4E2D...";
        } else if (pendingEscalation) {
          var reason = pendingEscalation.reason || "\u7B49\u5F85\u6388\u6743";
          var target = pendingEscalation.target ? " \xB7 " + pendingEscalation.target : "";
          permissionLabel.textContent = reason + target;
        } else {
          permissionLabel.textContent = "\u7B49\u5F85\u6388\u6743";
        }
      }
      if (permissionActionsEl) {
        permissionActionsEl.classList.remove("hidden");
        var approveBtn = document.getElementById("approve-permission-btn");
        var denyBtn = document.getElementById("deny-permission-btn");
        if (approveBtn) approveBtn.classList.toggle("hidden", !!isAutoApprove);
        if (denyBtn) denyBtn.classList.toggle("hidden", !!isAutoApprove);
      }
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
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var stats = selectedSession && selectedSession.approvalStats;
    if (!stats || stats.total === 0) {
      container.className = "approval-stats hidden";
      container.innerHTML = "";
      return;
    }
    container.className = "approval-stats";
    container.innerHTML = '<span class="approval-stats-divider"></span><span class="approval-stats-badge" id="approval-stats-badge" title="\u672C\u6B21\u4F1A\u8BDD\u81EA\u52A8\u6279\u51C6\u7EDF\u8BA1"><svg class="approval-stats-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span class="approval-stats-total">' + stats.total + '</span></span><span class="approval-stats-popup" id="approval-stats-popup"><span class="approval-stats-popup-title">\u81EA\u52A8\u6279\u51C6\u7EDF\u8BA1</span>' + (stats.command > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("terminal", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u547D\u4EE4\u6267\u884C</span><span class="approval-stats-row-count">' + stats.command + "</span></span>" : "") + (stats.file > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("edit", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u6587\u4EF6\u5199\u5165</span><span class="approval-stats-row-count">' + stats.file + "</span></span>" : "") + (stats.tool > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("wrench", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u5176\u4ED6\u5DE5\u5177</span><span class="approval-stats-row-count">' + stats.tool + "</span></span>" : "") + '<span class="approval-stats-row approval-stats-row-total"><span class="approval-stats-row-icon">' + iconSvg("sigma", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u5408\u8BA1</span><span class="approval-stats-row-count">' + stats.total + "</span></span></span>";
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
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && data.error) {
        showToast2(data.error, "error");
        return;
      }
      updateSessionSnapshot(data);
      updateTaskDisplay();
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u6279\u51C6\u6388\u6743\u3002", "error");
    }).finally(function() {
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
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && data.error) {
        showToast2(data.error, "error");
        return;
      }
      updateSessionSnapshot(data);
      updateTaskDisplay();
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u62D2\u7EDD\u6388\u6743\u3002", "error");
    }).finally(function() {
      if (approveBtn) approveBtn.disabled = false;
      if (denyBtn) denyBtn.disabled = false;
    });
  }
  function toggleAutoApprove() {
    if (!state.selectedId) return;
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (selectedSession && selectedSession.provider === "codex") {
      showToast2("Codex \u4F1A\u8BDD\u56FA\u5B9A\u4EE5 full-access PTY \u542F\u52A8\uFF0C\u4E0D\u652F\u6301\u5207\u6362\u81EA\u52A8\u6279\u51C6\u3002", "info");
      return;
    }
    var toggle = document.getElementById("auto-approve-toggle");
    if (toggle) toggle.style.opacity = "0.5";
    fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/toggle-auto-approve", {
      method: "POST",
      credentials: "same-origin"
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && data.error) {
        showToast2(data.error, "error");
        return;
      }
      updateSessionSnapshot(data);
      updateAutoApproveIndicator();
      var enabled = data.autoApprovePermissions;
      showToast2(enabled ? "\u81EA\u52A8\u6279\u51C6\u5DF2\u5F00\u542F" : "\u81EA\u52A8\u6279\u51C6\u5DF2\u5173\u95ED", "info");
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u5207\u6362\u81EA\u52A8\u6279\u51C6\u3002", "error");
    }).finally(function() {
      if (toggle) toggle.style.opacity = "";
    });
  }
  function updateAutoApproveIndicator() {
    var toggle = document.getElementById("auto-approve-toggle");
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (isAutoApproveImpliedByMode(selectedSession)) {
      if (toggle && toggle.parentNode) toggle.parentNode.removeChild(toggle);
      return;
    }
    if (!toggle) return;
    var base = "composer-pill composer-pill-chip auto-approve-indicator";
    var enabled = selectedSession && selectedSession.autoApprovePermissions;
    if (enabled) {
      toggle.className = base + " active";
      toggle.title = "\u81EA\u52A8\u6279\u51C6\u5DF2\u542F\u7528 \u2014 \u70B9\u51FB\u5173\u95ED";
      toggle.setAttribute("aria-pressed", "true");
      toggle.setAttribute("aria-label", "\u81EA\u52A8\u6279\u51C6\u5DF2\u542F\u7528\uFF0C\u70B9\u51FB\u5173\u95ED");
      toggle.innerHTML = iconSvg("shieldCheck", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">\u81EA\u52A8</span>';
    } else {
      toggle.className = base;
      toggle.title = "\u81EA\u52A8\u6279\u51C6\u5DF2\u5173\u95ED \u2014 \u70B9\u51FB\u5F00\u542F";
      toggle.setAttribute("aria-pressed", "false");
      toggle.setAttribute("aria-label", "\u81EA\u52A8\u6279\u51C6\u5DF2\u5173\u95ED\uFF0C\u70B9\u51FB\u5F00\u542F");
      toggle.innerHTML = iconSvg("shield", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">\u624B\u52A8</span>';
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
    var selectedSession = getSelectedSession3();
    if (selectedSession) {
      state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
    }
    updateTerminalJumpToBottomButton();
    if (state.currentView === "terminal") {
      scheduleTerminalResize2(true);
      if (state.terminal && state.terminal.remeasure) {
        requestAnimationFrame(function() {
          if (state.terminal) state.terminal.remeasure();
        });
      }
    }
  }
  function renderChat2(forceFullRender) {
    if (state.renderPending && !forceFullRender) return;
    state.renderPending = true;
    if (forceFullRender) {
      doRenderChat(true);
      state.renderPending = false;
    } else {
      requestAnimationFrame(function() {
        doRenderChat(false);
        state.renderPending = false;
      });
    }
  }
  state.chatRenderTimer = null;
  function scheduleChatRender(immediate) {
    if (state.chatRenderTimer && !immediate) return;
    if (state.chatRenderTimer) clearTimeout(state.chatRenderTimer);
    if (immediate) {
      state.chatRenderTimer = null;
      renderChat2();
      return;
    }
    var selectedForDelay = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var isActiveStream = selectedForDelay && selectedForDelay.status === "running" && selectedForDelay.sessionKind !== "structured";
    var delay = isActiveStream ? CHAT_RENDER_LIVE_MS : CHAT_RENDER_IDLE_MS;
    state.chatRenderTimer = setTimeout(function() {
      state.chatRenderTimer = null;
      var selectedSession = state.sessions.find(function(s) {
        return s.id === state.selectedId;
      });
      if (selectedSession) {
        state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
      }
      renderChat2();
    }, delay);
  }

  // src/web-ui/browser/viewport.ts
  var appViewportBaselineWidth = 0;
  var appViewportBaselineHeight = 0;
  var closedViewportBaselineUntil = 0;
  var keyboardDismissCooldownUntil = 0;
  function isIosNativeViewportMode() {
    return window.__wandIosNative === true;
  }
  function markClosedViewportBaselineWindow(durationMs) {
    closedViewportBaselineUntil = Math.max(
      closedViewportBaselineUntil,
      Date.now() + (durationMs || 1800)
    );
  }
  function scheduleClosedViewportBaselineWindow(durationMs, blurredEl) {
    setTimeout(function() {
      var activeEl = document.activeElement;
      if (isEditableFocusTarget(activeEl) && activeEl !== blurredEl) return;
      markClosedViewportBaselineWindow(durationMs);
    }, 30);
  }
  function getFullViewportHeight(vv) {
    return Math.max(
      window.innerHeight || 0,
      vv && vv.height || 0,
      document.documentElement ? document.documentElement.clientHeight || 0 : 0,
      document.body ? document.body.clientHeight || 0 : 0
    );
  }
  function refreshAppViewportBaseline(vv) {
    var root = document.documentElement;
    var width = Math.max(
      window.innerWidth || 0,
      vv && vv.width || 0,
      root ? root.clientWidth || 0 : 0
    );
    var height = getFullViewportHeight(vv);
    if (!appViewportBaselineWidth || Math.abs(width - appViewportBaselineWidth) > 8) {
      appViewportBaselineWidth = width;
      appViewportBaselineHeight = height;
    } else if (height > appViewportBaselineHeight) {
      appViewportBaselineHeight = height;
    }
    return Math.max(1, Math.round(appViewportBaselineHeight || height || 1));
  }
  function shouldUseFullViewport(isKeyboardOpen, offsetTop, height, baselineHeight) {
    if (isKeyboardOpen || !isIosNativeViewportMode()) return false;
    return offsetTop > 0 || baselineHeight > height + 1;
  }
  function syncAppViewportHeight(isKeyboardOpen) {
    var vv = window.visualViewport;
    if (!vv) return;
    var root = document.documentElement;
    root.classList.toggle("is-keyboard-open", !!isKeyboardOpen);
    if (window.__wandImeNative) {
      root.style.setProperty("--app-viewport-top", "0px");
      root.style.setProperty("--app-viewport-height", Math.round(vv.height) + "px");
      return;
    }
    var baselineHeight = refreshAppViewportBaseline(vv);
    var offsetTop = Math.max(0, Math.round(vv.offsetTop || 0));
    var height = Math.max(1, Math.round(vv.height));
    if (!isKeyboardOpen && isIosNativeViewportMode()) {
      offsetTop = 0;
      height = Math.max(height, baselineHeight);
    } else if (shouldUseFullViewport(isKeyboardOpen, offsetTop, height, baselineHeight)) {
      offsetTop = 0;
      height = Math.max(height, baselineHeight);
    }
    root.style.setProperty("--app-viewport-top", offsetTop + "px");
    root.style.setProperty("--app-viewport-height", height + "px");
    if (isKeyboardOpen || (window.scrollY || 0) > 0) {
      resetRootViewportScroll();
    }
  }
  function isEditableFocusTarget(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "SELECT") return true;
    if (tag === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(type);
    }
    return !!el.isContentEditable;
  }
  function setupVisualViewportHandlers() {
    if (!("visualViewport" in window)) return;
    if (window.__wandViewportHandlersBound) return;
    window.__wandViewportHandlersBound = true;
    var vv = window.visualViewport;
    var lastHeight = vv.height;
    var keyboardOpen = false;
    var lastViewportWidth = Math.max(window.innerWidth || 0, vv.width || 0);
    var largestViewportHeight = Math.max(window.innerHeight || 0, vv.height || 0);
    var viewportSettleTimers = [];
    function getCurrentViewportHeightBaseline() {
      return Math.max(window.innerHeight || 0, vv.height || 0);
    }
    function refreshViewportBaseline() {
      var width = Math.max(window.innerWidth || 0, vv.width || 0);
      var height = getCurrentViewportHeightBaseline();
      if (Math.abs(width - lastViewportWidth) > 8) {
        lastViewportWidth = width;
        largestViewportHeight = height;
        return;
      }
      if (height > largestViewportHeight) {
        largestViewportHeight = height;
      }
    }
    function detectKeyboardOpen(inputBox, offsetBottom) {
      var activeEl = document.activeElement;
      var hasEditableFocus = activeEl === inputBox || isEditableFocusTarget(activeEl);
      var shrinkFromLargest = largestViewportHeight - vv.height;
      var innerShrinkFromLargest = largestViewportHeight - (window.innerHeight || vv.height || 0);
      var inDismissCooldown = Date.now() < keyboardDismissCooldownUntil;
      if (inDismissCooldown) {
        if (hasEditableFocus && (shrinkFromLargest > 120 || innerShrinkFromLargest > 120)) return true;
        return false;
      }
      if (offsetBottom > 80) return true;
      if (hasEditableFocus && (shrinkFromLargest > 120 || innerShrinkFromLargest > 120)) return true;
      if (keyboardOpen && (shrinkFromLargest > 80 || offsetBottom > 32)) return true;
      return false;
    }
    function scheduleViewportSettle() {
      viewportSettleTimers.forEach(function(timer) {
        clearTimeout(timer);
      });
      viewportSettleTimers = [60, 180, 360, 620, 900].map(function(delay) {
        return setTimeout(function() {
          syncAppViewportHeight(keyboardOpen);
        }, delay);
      });
    }
    function scheduleFocusedInputSettle() {
      [0, 50, 120, 220, 360, 560].forEach(function(delay) {
        setTimeout(function() {
          updateViewport();
          var inputBox = document.getElementById("input-box");
          if (inputBox && document.activeElement === inputBox) {
            syncInputBoxScroll(inputBox);
          }
        }, delay);
      });
    }
    function updateViewport() {
      if (!vv) return;
      var inputBox = document.getElementById("input-box");
      var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
      refreshViewportBaseline();
      var isKeyboardOpen = detectKeyboardOpen(inputBox, offsetBottom);
      var heightChanged = Math.abs(vv.height - lastHeight) > 8;
      syncAppViewportHeight(isKeyboardOpen);
      if (isKeyboardOpen && (!keyboardOpen || heightChanged) && shouldAdjustForKeyboard(vv, inputBox)) {
        syncInputBoxScroll(inputBox);
      }
      if (!keyboardOpen && isKeyboardOpen) {
        var wasStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
        ensureTerminalFit2("keyboard-open", { forceReplay: true });
        if (!window.__wandImeNative) {
          setTimeout(function() {
            syncAppViewportHeight(true);
          }, 220);
        }
        scheduleViewportSettle();
        if (wasStickToBottom) {
          setTimeout(function() {
            if (!state.terminal) return;
            maybeScrollTerminalToBottom("force");
          }, 220);
        }
      }
      if (keyboardOpen && !isKeyboardOpen) {
        var imeIsNative = !!window.__wandImeNative;
        if (!imeIsNative) {
          markClosedViewportBaselineWindow(2200);
          keyboardDismissCooldownUntil = Date.now() + 1200;
          syncAppViewportHeight(false);
          resetRootViewportScroll();
        }
        scheduleViewportSettle();
        setTimeout(function() {
          if (!imeIsNative) {
            syncAppViewportHeight(false);
            resetRootViewportScroll();
          }
          ensureTerminalFit2("keyboard-close", { forceReplay: true });
          maybeScrollTerminalToBottom("keyboard");
        }, 200);
      }
      if (heightChanged && keyboardOpen === isKeyboardOpen) {
        ensureTerminalFit2("viewport");
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
    vv.addEventListener("resize", debouncedUpdate);
    vv.addEventListener("scroll", debouncedUpdate);
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "visible") {
        debouncedUpdate();
        setTimeout(debouncedUpdate, 240);
        setTimeout(debouncedUpdate, 720);
      }
    });
    window.addEventListener("pageshow", function(e) {
      if (e && e.persisted) {
        debouncedUpdate();
        setTimeout(debouncedUpdate, 240);
      }
    });
    document.addEventListener("focusout", function(e) {
      if (!e || !e.target) return;
      if (!isEditableFocusTarget(e.target)) return;
      scheduleClosedViewportBaselineWindow(1600, e.target);
      if (isIosNativeViewportMode()) {
        keyboardDismissCooldownUntil = Math.max(
          keyboardDismissCooldownUntil,
          Date.now() + 1200
        );
      }
      setTimeout(debouncedUpdate, 80);
      setTimeout(debouncedUpdate, 420);
    });
    document.addEventListener("focusin", function(e) {
      if (!e || !e.target || !isEditableFocusTarget(e.target)) return;
      scheduleFocusedInputSettle();
    });
    window.addEventListener("wand-ios-ime-state", function(e) {
      var state3 = e && e.detail && e.detail.state;
      if (state3 === "hidden") {
        keyboardDismissCooldownUntil = Date.now() + 900;
      }
      scheduleFocusedInputSettle();
      scheduleViewportSettle();
    });
    updateViewport();
  }
  function initTerminalResizeHandle() {
    var container = document.getElementById("output");
    if (!container) return;
    var resizeHandle = document.createElement("div");
    resizeHandle.className = "terminal-resize-handle";
    resizeHandle.innerHTML = "&#8942;";
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
    state.resizeMouseMove = function(e) {
      if (!isResizing) return;
      var deltaY = e.clientY - startY;
      var newHeight = Math.max(200, Math.min(startHeight + deltaY, window.innerHeight - 200));
      container.style.height = newHeight + "px";
      container.style.flex = "none";
      scheduleTerminalResize2();
    };
    document.addEventListener("mousemove", state.resizeMouseMove);
    state.resizeMouseUp = function() {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        scheduleTerminalResize2();
      }
    };
    document.addEventListener("mouseup", state.resizeMouseUp);
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
      scheduleTerminalResize2();
      e.preventDefault();
    };
    document.addEventListener("touchmove", state.resizeTouchMove, { passive: false });
    state.resizeTouchEnd = function() {
      if (isResizing) {
        isResizing = false;
        scheduleTerminalResize2();
      }
    };
    document.addEventListener("touchend", state.resizeTouchEnd);
  }
  function isJoystickAvailable() {
    return !!getSelectedSession3();
  }
  function clampJoystickPos(pos) {
    var maxRight = Math.max(JOYSTICK_EDGE_MARGIN, window.innerWidth - JOYSTICK_BALL_SIZE - JOYSTICK_EDGE_MARGIN);
    var maxBottom = Math.max(JOYSTICK_EDGE_MARGIN, window.innerHeight - JOYSTICK_BALL_SIZE - JOYSTICK_EDGE_MARGIN);
    return {
      right: Math.min(Math.max(JOYSTICK_EDGE_MARGIN, pos.right), maxRight),
      bottom: Math.min(Math.max(JOYSTICK_EDGE_MARGIN, pos.bottom), maxBottom)
    };
  }
  function applyJoystickPosition() {
    if (!state.joystickBallEl) return;
    var pos = clampJoystickPos(state.joystickPos || { right: 18, bottom: 96 });
    state.joystickBallEl.style.right = pos.right + "px";
    state.joystickBallEl.style.bottom = pos.bottom + "px";
  }
  function saveJoystickPosition(right, bottom) {
    var pos = clampJoystickPos({ right, bottom });
    state.joystickPos = pos;
    try {
      localStorage.setItem("wand-ball-pos", JSON.stringify(pos));
    } catch (e) {
    }
  }
  function renderJoystickPanel() {
    function keyBtn(key, label, cls) {
      return '<button type="button" class="wjp-key' + (cls ? " " + cls : "") + '" data-key="' + key + '">' + label + "</button>";
    }
    var dpad = '<div class="wjp-dpad"><div class="wjp-dpad-row">' + keyBtn("up", "\u2191", "wjp-dir") + '</div><div class="wjp-dpad-row">' + keyBtn("left", "\u2190", "wjp-dir") + keyBtn("down", "\u2193", "wjp-dir") + keyBtn("right", "\u2192", "wjp-dir") + "</div></div>";
    var fnRow = "";
    var i;
    for (i = 0; i < JOYSTICK_ACTION_KEYS.length; i++) {
      fnRow += keyBtn(JOYSTICK_ACTION_KEYS[i].key, JOYSTICK_ACTION_KEYS[i].label, "");
    }
    var html = '<div class="wjp-header"><span class="wjp-title">' + iconSvg("paw", { size: 13, strokeWidth: 1.6, cls: "wjp-title-icon" }) + '<span>\u9065\u63A7\u9762\u677F</span></span><button type="button" class="wjp-close" aria-label="\u5173\u95ED\u9065\u63A7\u9762\u677F">' + iconSvg("x", { size: 13, strokeWidth: 2 }) + "</button></div>" + dpad + '<div class="wjp-grid wjp-fnkeys">' + fnRow + "</div>";
    return html;
  }
  function initTerminalJoystick() {
    if (state.joystickRootEl) return;
    var root = document.createElement("div");
    root.className = "wand-joystick-root";
    ["pointerdown", "pointerup", "touchstart", "touchend", "click"].forEach(function(type) {
      root.addEventListener(type, suppressJoystickKeyboardFocus, true);
    });
    var backdrop = document.createElement("div");
    backdrop.className = "wand-joystick-backdrop";
    root.appendChild(backdrop);
    var panel = document.createElement("div");
    panel.className = "wand-joystick-panel";
    panel.innerHTML = renderJoystickPanel();
    panel.addEventListener("click", onJoystickPanelClick);
    root.appendChild(panel);
    var ball = document.createElement("div");
    ball.className = "wand-joystick-ball";
    ball.setAttribute("role", "button");
    ball.setAttribute("aria-label", "Wand \u9065\u63A7\u9762\u677F");
    ball.setAttribute("title", "\u70B9\u51FB\u6253\u5F00\u9065\u63A7\u9762\u677F\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8\u4F4D\u7F6E");
    ball.innerHTML = iconSvg("paw", { size: 25, strokeWidth: 1.6, cls: "wand-joystick-logo" });
    root.appendChild(ball);
    document.body.appendChild(root);
    state.joystickRootEl = root;
    state.joystickBackdropEl = backdrop;
    state.joystickPanelEl = panel;
    state.joystickBallEl = ball;
    applyJoystickPosition();
    ball.addEventListener("pointerdown", onJoystickPointerDown);
    ball.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
    });
    backdrop.addEventListener("pointerdown", function(e) {
      if (state.joystickPinnedOpen && state.joystickGesture == null) {
        e.preventDefault();
        closeJoystickPanel();
      }
    });
    backdrop.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
    });
    state.joystickResizeHandler = function() {
      applyJoystickPosition();
    };
    window.addEventListener("resize", state.joystickResizeHandler);
    window.addEventListener("orientationchange", state.joystickResizeHandler);
    updateJoystickVisibility();
  }
  function suppressJoystickKeyboardFocus() {
    if (!document.documentElement.classList.contains("is-wand-native-input")) return;
    var active = document.activeElement;
    if (active && typeof active.blur === "function") {
      try {
        active.blur();
      } catch (err) {
      }
    }
    setTimeout(function() {
      var next = document.activeElement;
      if (next && typeof next.blur === "function") {
        try {
          next.blur();
        } catch (err) {
        }
      }
    }, 0);
  }
  function onJoystickPointerDown(e) {
    if (!isJoystickAvailable()) return;
    if ((e.pointerType === "mouse" || e.pointerType === "pen") && e.button !== 0) return;
    if (state.joystickPointerId !== null) return;
    suppressJoystickKeyboardFocus();
    e.preventDefault();
    e.stopPropagation();
    var canDirectDrag = e.pointerType === "mouse" || e.pointerType === "pen";
    state.joystickPointerId = e.pointerId;
    state.joystickPressStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    state.joystickGesture = "pending";
    try {
      state.joystickBallEl.setPointerCapture(e.pointerId);
    } catch (err) {
    }
    if (!canDirectDrag) {
      state.joystickLongPressTimer = setTimeout(function() {
        if (state.joystickGesture === "pending") enterJoystickMoveMode();
      }, JOYSTICK_LONG_PRESS_MS);
    }
    state.joystickMoveHandler = onJoystickPointerMove;
    state.joystickUpHandler = onJoystickPointerUp;
    document.addEventListener("pointermove", state.joystickMoveHandler);
    document.addEventListener("pointerup", state.joystickUpHandler);
    document.addEventListener("pointercancel", state.joystickUpHandler);
  }
  function enterJoystickMoveMode() {
    state.joystickGesture = "move";
    if (state.joystickPinnedOpen) closeJoystickPanel();
    if (state.joystickBallEl) state.joystickBallEl.classList.add("dragging");
    if (state.joystickBackdropEl) state.joystickBackdropEl.classList.add("active");
  }
  function moveJoystickBallTo(clientX, clientY) {
    if (!state.joystickBallEl) return;
    var pos = clampJoystickPos({
      right: window.innerWidth - clientX - JOYSTICK_BALL_SIZE / 2,
      bottom: window.innerHeight - clientY - JOYSTICK_BALL_SIZE / 2
    });
    state.joystickBallEl.style.right = pos.right + "px";
    state.joystickBallEl.style.bottom = pos.bottom + "px";
  }
  function onJoystickPointerMove(e) {
    if (e.pointerId !== state.joystickPointerId || !state.joystickBallEl) return;
    e.preventDefault();
    if (state.joystickGesture === "move") {
      moveJoystickBallTo(e.clientX, e.clientY);
      return;
    }
    if (state.joystickGesture !== "pending") return;
    var dx = e.clientX - state.joystickPressStart.x;
    var dy = e.clientY - state.joystickPressStart.y;
    if (Math.sqrt(dx * dx + dy * dy) <= JOYSTICK_MOVE_THRESHOLD) return;
    if (e.pointerType === "mouse" || e.pointerType === "pen") {
      enterJoystickMoveMode();
      moveJoystickBallTo(e.clientX, e.clientY);
    } else {
      if (state.joystickLongPressTimer) {
        clearTimeout(state.joystickLongPressTimer);
        state.joystickLongPressTimer = null;
      }
      state.joystickGesture = "cancelled";
    }
  }
  function onJoystickPointerUp(e) {
    if (e.pointerId !== state.joystickPointerId) return;
    if (state.joystickLongPressTimer) {
      clearTimeout(state.joystickLongPressTimer);
      state.joystickLongPressTimer = null;
    }
    var gesture = state.joystickGesture;
    if (gesture === "pending") {
      var dx = e.clientX - state.joystickPressStart.x;
      var dy = e.clientY - state.joystickPressStart.y;
      if (Math.sqrt(dx * dx + dy * dy) <= JOYSTICK_TAP_THRESHOLD) toggleJoystickPanel();
    } else if (gesture === "move") {
      var r = state.joystickBallEl ? state.joystickBallEl.getBoundingClientRect() : null;
      if (r) saveJoystickPosition(window.innerWidth - r.right, window.innerHeight - r.bottom);
    }
    endJoystickGesture();
  }
  function endJoystickGesture() {
    if (state.joystickLongPressTimer) {
      clearTimeout(state.joystickLongPressTimer);
      state.joystickLongPressTimer = null;
    }
    if (state.joystickBallEl && state.joystickPointerId !== null) {
      try {
        state.joystickBallEl.releasePointerCapture(state.joystickPointerId);
      } catch (err) {
      }
    }
    if (state.joystickMoveHandler) {
      document.removeEventListener("pointermove", state.joystickMoveHandler);
      state.joystickMoveHandler = null;
    }
    if (state.joystickUpHandler) {
      document.removeEventListener("pointerup", state.joystickUpHandler);
      document.removeEventListener("pointercancel", state.joystickUpHandler);
      state.joystickUpHandler = null;
    }
    if (state.joystickBallEl) state.joystickBallEl.classList.remove("dragging");
    if (state.joystickBackdropEl && !state.joystickPinnedOpen) {
      state.joystickBackdropEl.classList.remove("active");
    }
    state.joystickPointerId = null;
    state.joystickGesture = null;
    state.joystickPressStart = null;
  }
  function sendJoystickKey(key) {
    if (key === "ctrl" || key === "alt" || key === "shift") {
      state.modifiers[key] = !state.modifiers[key];
      updateJoystickPanelUI();
      return;
    }
    var session = getSelectedSession3();
    if (session && isStructuredSession2(session)) {
      if (key === "ctrl_c" || key === "escape") {
        interruptStructuredSessionFromJoystick(session, key);
      }
      clearModifiers();
      updateJoystickPanelUI();
      return;
    }
    var seq = buildPtySequence(key, {
      ctrl: state.modifiers.ctrl,
      alt: state.modifiers.alt,
      shift: state.modifiers.shift
    });
    if (seq) sendTerminalSequence(seq, key);
    clearModifiers();
    updateJoystickPanelUI();
    scheduleShortcutResync();
  }
  function interruptStructuredSessionFromJoystick(session, key) {
    if (!session || !session.id) return;
    fetch("/api/structured-sessions/" + session.id + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ input: "", interrupt: true, preserveQueue: true })
    }).then(function(res) {
      if (!res.ok) return res.json().catch(function() {
        return {};
      }).then(function(p) {
        throw new Error(p && p.error || "\u4E2D\u65AD\u5931\u8D25 (key=" + key + ")");
      });
      return res.json();
    }).then(function(snapshot) {
      if (snapshot && snapshot.id) {
        updateSessionSnapshot(snapshot);
        if (snapshot.id === state.selectedId) {
          var refreshed = state.sessions.find(function(s) {
            return s.id === snapshot.id;
          }) || snapshot;
          state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, snapshot.output, false));
          renderChat2(true);
          if (typeof updateQueueBar === "function") updateQueueBar();
        }
      }
    }).catch(function(err) {
      if (err && err.message) console.debug("[wand] joystick interrupt no-op:", err.message);
    });
  }
  function toggleJoystickPanel() {
    if (state.joystickPinnedOpen) closeJoystickPanel();
    else openJoystickPanel();
  }
  function openJoystickPanel() {
    if (!state.joystickPanelEl || !state.joystickBallEl) return;
    state.joystickPinnedOpen = true;
    var r = state.joystickBallEl.getBoundingClientRect();
    state.joystickPanelEl.style.right = Math.max(JOYSTICK_EDGE_MARGIN, window.innerWidth - r.right) + "px";
    state.joystickPanelEl.style.bottom = Math.max(JOYSTICK_EDGE_MARGIN, window.innerHeight - r.top + 10) + "px";
    state.joystickPanelEl.classList.add("active");
    state.joystickBallEl.classList.add("panel-open");
    if (state.joystickBackdropEl) state.joystickBackdropEl.classList.add("active");
    updateJoystickPanelUI();
  }
  function closeJoystickPanel() {
    state.joystickPinnedOpen = false;
    if (state.joystickPanelEl) state.joystickPanelEl.classList.remove("active");
    if (state.joystickBallEl) state.joystickBallEl.classList.remove("panel-open");
    if (state.joystickBackdropEl && state.joystickGesture == null) {
      state.joystickBackdropEl.classList.remove("active");
    }
  }
  function updateJoystickPanelUI() {
    if (!state.joystickPanelEl) return;
    ["ctrl", "alt"].forEach(function(name) {
      var btn = state.joystickPanelEl.querySelector('.wjp-mod[data-key="' + name + '"]');
      if (btn) btn.classList.toggle("active", !!state.modifiers[name]);
    });
  }
  function onJoystickPanelClick(e) {
    var closeBtn = e.target && e.target.closest ? e.target.closest(".wjp-close") : null;
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      closeJoystickPanel();
      return;
    }
    var btn = e.target && e.target.closest ? e.target.closest(".wjp-key") : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var key = btn.getAttribute("data-key");
    if (key) sendJoystickKey(key);
  }
  function updateJoystickVisibility() {
    var root = state.joystickRootEl;
    if (!root) return;
    var available = isJoystickAvailable();
    root.classList.toggle("visible", available);
    if (!available) {
      if (state.joystickPointerId !== null || state.joystickGesture) endJoystickGesture();
      if (state.joystickPinnedOpen) closeJoystickPanel();
      if (state.joystickBackdropEl) state.joystickBackdropEl.classList.remove("active");
    }
  }
  function teardownJoystick() {
    if (state.joystickLongPressTimer) {
      clearTimeout(state.joystickLongPressTimer);
      state.joystickLongPressTimer = null;
    }
    if (state.joystickMoveHandler) {
      document.removeEventListener("pointermove", state.joystickMoveHandler);
      state.joystickMoveHandler = null;
    }
    if (state.joystickUpHandler) {
      document.removeEventListener("pointerup", state.joystickUpHandler);
      document.removeEventListener("pointercancel", state.joystickUpHandler);
      state.joystickUpHandler = null;
    }
    if (state.joystickResizeHandler) {
      window.removeEventListener("resize", state.joystickResizeHandler);
      window.removeEventListener("orientationchange", state.joystickResizeHandler);
      state.joystickResizeHandler = null;
    }
    if (state.joystickRootEl && state.joystickRootEl.parentNode) {
      state.joystickRootEl.parentNode.removeChild(state.joystickRootEl);
    }
    state.joystickRootEl = null;
    state.joystickPanelEl = null;
    state.joystickBackdropEl = null;
    state.joystickBallEl = null;
    state.joystickPointerId = null;
    state.joystickGesture = null;
    state.joystickPressStart = null;
    state.joystickPinnedOpen = false;
  }
  function observeTerminalResize() {
    var output = document.getElementById("output");
    if (!output) return;
    var lastKnownDesktop = !isMobileLayout();
    state.resizeHandler = function() {
      scheduleTerminalResize2(true);
      var isDesktop = !isMobileLayout();
      if (lastKnownDesktop !== isDesktop) {
        lastKnownDesktop = isDesktop;
        if (!isDesktop && state.sidebarPinned && state.sessionsDrawerOpen) {
          state.sessionsDrawerOpen = false;
          writeStoredBoolean("wand-sidebar-open", false);
          updateDrawerState();
        } else if (isDesktop && state.sidebarPinned && !state.sessionsDrawerOpen) {
          state.sessionsDrawerOpen = true;
          writeStoredBoolean("wand-sidebar-open", true);
          updateDrawerState();
        }
      }
    };
    window.addEventListener("resize", state.resizeHandler);
    if (window.visualViewport) {
      state.visualViewportHandler = function() {
        scheduleTerminalResize2(true);
      };
      window.visualViewport.addEventListener("resize", state.visualViewportHandler);
    }
    state.visibilityHandler = function() {
      if (!document.hidden) ensureTerminalFit2("visibility", { forceReplay: true });
    };
    document.addEventListener("visibilitychange", state.visibilityHandler);
    state.orientationHandler = function() {
      ensureTerminalFit2("orientation", { forceReplay: true });
    };
    window.addEventListener("orientationchange", state.orientationHandler);
    requestAnimationFrame(function() {
      scheduleTerminalResize2(true);
    });
  }
  function startTerminalHealthCheck() {
    if (state.terminalHealthTimer) return;
    state.terminalHealthTimer = setInterval(function() {
      if (!state.terminal || state.currentView !== "terminal" || document.hidden) return;
      var selectedSession = state.sessions.find(function(s) {
        return s.id === state.selectedId;
      });
      if (!selectedSession || selectedSession.sessionKind === "structured") return;
      ensureTerminalFit2("health");
      var now = Date.now();
      var chunkPause = state.lastChunkAt > 0 && now - state.lastChunkAt > 300;
      var resyncDue = now - state.lastTerminalResyncAt > 3e4;
      var dirtySinceResync = state.lastChunkAt > state.lastTerminalResyncAt;
      if (resyncDue && dirtySinceResync && (chunkPause || selectedSession.status !== "running") && state.terminalOutput) {
        softResyncTerminal2();
      }
    }, 5e3);
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
    [
      ["mousemove", "resizeMouseMove"],
      ["mouseup", "resizeMouseUp"],
      ["touchmove", "resizeTouchMove"],
      ["touchend", "resizeTouchEnd"]
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
      if (state.terminalViewportTouchStartHandler) {
        state.terminalViewportEl.removeEventListener("touchstart", state.terminalViewportTouchStartHandler);
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
    state.terminalViewportTouchStartHandler = null;
    state.terminalWheelHandler = null;
    state.terminalClickHandler = null;
    if (state.terminalScrollbarHideTimer) {
      clearTimeout(state.terminalScrollbarHideTimer);
      state.terminalScrollbarHideTimer = null;
    }
    if (state.terminalScrollbarEl && state.terminalScrollbarEl.parentNode) {
      state.terminalScrollbarEl.parentNode.removeChild(state.terminalScrollbarEl);
    }
    state.terminalScrollbarEl = null;
    state.terminalScrollbarThumbEl = null;
    state.terminalScrollbarDragging = false;
    state.terminalScrollbarRafPending = false;
    if (state.terminal) {
      state.terminal.destroy();
      state.terminal = null;
    }
    if (output) {
      var staleWraps = output.querySelectorAll(".terminal-scroll-wrap");
      for (var i = 0; i < staleWraps.length; i++) {
        var wrap = staleWraps[i];
        if (wrap.parentNode === output) output.removeChild(wrap);
      }
    }
    resetWideParserState();
    state.syncOutputBuffer = null;
    state.syncOutputDeadline = 0;
    state.syncFramingResidue = false;
    state.terminalSessionId = null;
    state.terminalOutput = "";
    state.terminalOutputMarker = 0;
    state.terminalAutoFollow = true;
    state.showTerminalJumpToBottom = false;
    updateTerminalJumpToBottomButton();
    if (state.softResyncTimer) {
      clearTimeout(state.softResyncTimer);
      state.softResyncTimer = null;
    }
    if (state._resyncChunkTailTimer) {
      clearTimeout(state._resyncChunkTailTimer);
      state._resyncChunkTailTimer = null;
    }
    state._resyncChunkLastAt = 0;
    state._resyncStatsWindowStart = 0;
    state._resyncStatsCount = 0;
    state._resyncLastWarnAt = 0;
    state._resyncInProgress = false;
    state.lastResize = { cols: 0, rows: 0 };
    teardownJoystick();
  }
  function sendTerminalResize(cols, rows) {
    if (!state.selectedId) return;
    var selectedSess = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!selectedSess || selectedSess.status !== "running") return;
    if (isStructuredSession2(selectedSess)) return;
    if (cols > 256) cols = 256;
    if (rows > 160) rows = 160;
    var nextSize = { cols, rows };
    if (state.lastResize.cols !== nextSize.cols || state.lastResize.rows !== nextSize.rows) {
      state.lastResize = nextSize;
      fetch("/api/sessions/" + state.selectedId + "/resize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(nextSize)
      }).catch(function() {
      });
    }
  }
  function ensureTerminalFit2(reason, options) {
    if (!state.terminal) return false;
    var opts = options || {};
    var forceReplay = opts.forceReplay === true;
    var el = document.getElementById("output");
    if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
      ensureTerminalFitWithRetry(reason || "fit-retry", { forceReplay });
      return false;
    }
    var shouldStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
    var prevCols = state.terminal.cols;
    var prevRows = state.terminal.rows;
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        if (!state.terminal) return;
        if (typeof state.terminal.remeasure === "function") {
          state.terminal.remeasure();
        }
        sendTerminalResize(state.terminal.cols, state.terminal.rows);
        var didResize = state.terminal.cols !== prevCols || state.terminal.rows !== prevRows;
        if (!didResize && forceReplay && state.terminalOutput) {
          softResyncTerminal2({ skipFit: true });
        }
        if (shouldStickToBottom) {
          maybeScrollTerminalToBottom("force");
        }
      });
    });
    return true;
  }
  function ensureTerminalFitWithRetry(reason, options) {
    if (!state.terminal) return;
    var opts = options || {};
    var forceReplay = opts.forceReplay !== false;
    var attempts = 0;
    var maxAttempts = 8;
    function tryFit() {
      if (!state.terminal) return;
      var el = document.getElementById("output");
      if (el) void el.offsetHeight;
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
        ensureTerminalFit2(reason, { forceReplay });
        return;
      }
      if (++attempts >= maxAttempts) return;
      if (attempts <= 4) {
        requestAnimationFrame(tryFit);
      } else {
        setTimeout(tryFit, 32);
      }
    }
    tryFit();
  }
  function scheduleTerminalResize2(immediate) {
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
    var shouldStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
    if (shouldStickToBottom) {
      maybeScrollTerminalToBottom("force");
    }
    sendTerminalResize(state.terminal.cols, state.terminal.rows);
  }

  // src/web-ui/browser/terminal.ts
  function saveWorkingDir(path) {
    state.workingDir = path;
    try {
      localStorage.setItem("wand-working-dir", path);
    } catch (e) {
    }
    addRecentPath(path);
  }
  function fetchRecentPaths(callback) {
    fetch("/api/recent-paths", { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(items) {
      callback(items || []);
    }).catch(function() {
      callback([]);
    });
  }
  function addRecentPath(path) {
    return fetch("/api/recent-paths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ path })
    }).catch(function() {
    });
  }
  function activateSessionItem(sessionId) {
    var session = state.sessions.find(function(s) {
      return s.id === sessionId;
    });
    if (session && session.status !== "running" && !isStructuredSession2(session)) {
      resumeSessionFromList(sessionId);
    } else {
      selectSession(sessionId);
    }
    dismissDrawerIfOverlay();
  }
  function handleSessionItemClick(event) {
    var target = event.target;
    if (!target || !(target instanceof Element)) return;
    var collapsedTile = target.closest(".sidebar-collapsed-tile");
    if (collapsedTile && collapsedTile instanceof HTMLElement) {
      if (collapsedTile.dataset.collapsedNewSession) {
        event.preventDefault();
        event.stopPropagation();
        openSessionModal();
        return;
      }
      if (collapsedTile.dataset.collapsedSessionId) {
        event.preventDefault();
        event.stopPropagation();
        activateSessionItem(collapsedTile.dataset.collapsedSessionId);
        return;
      }
      if (collapsedTile.dataset.collapsedHistoryId) {
        event.preventDefault();
        event.stopPropagation();
        var historyCid = collapsedTile.dataset.collapsedHistoryId;
        var historyCwd = collapsedTile.dataset.cwd || "";
        var resumeCollapsed = collapsedTile.dataset.provider === "codex" ? resumeCodexHistorySession : resumeClaudeHistorySession;
        resumeCollapsed(historyCid, historyCwd).then(function(data) {
          if (data && data.id) {
            state.selectedId = data.id;
            persistSelectedId();
            state.drafts[data.id] = "";
            loadSessions().then(function() {
              selectSession(data.id);
            });
          }
        });
        return;
      }
    }
    var historyToggle = target.closest("#claude-history-toggle");
    if (historyToggle) {
      event.preventDefault();
      event.stopPropagation();
      state.claudeHistoryExpanded = !state.claudeHistoryExpanded;
      if (state.claudeHistoryExpanded && !state.claudeHistoryLoaded) {
        ensureClaudeHistoryLoaded();
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
      } else if (actionButton.dataset.action === "swipe-delete-session" && actionButton.dataset.sessionId) {
        deleteSession(actionButton.dataset.sessionId);
      } else if (actionButton.dataset.action === "delete-session" && actionButton.dataset.sessionId) {
        (function(sid) {
          confirmDelete("\u786E\u8BA4\u5220\u9664\u8FD9\u4E2A\u4F1A\u8BDD\u5417\uFF1F\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002", { title: "\u5220\u9664\u4F1A\u8BDD" }).then(function(ok) {
            if (ok) deleteSession(sid);
          });
        })(actionButton.dataset.sessionId);
      } else if (actionButton.dataset.action === "delete-history" && actionButton.dataset.claudeSessionId) {
        (function(cid, item2) {
          confirmDelete("\u786E\u8BA4\u5220\u9664\u8FD9\u6761 Claude \u4F1A\u8BDD\u5417\uFF1F", { title: "\u5220\u9664\u4F1A\u8BDD" }).then(function(ok) {
            if (ok) executeDeleteHistory(cid, item2);
          });
        })(actionButton.dataset.claudeSessionId, actionButton.closest(".session-item"));
      } else if (actionButton.dataset.action === "toggle-history-directory" && actionButton.dataset.cwd) {
        var dirCwd = actionButton.dataset.cwd;
        state.claudeHistoryExpandedDirs[dirCwd] = !state.claudeHistoryExpandedDirs[dirCwd];
        updateSessionsList();
      } else if (actionButton.dataset.action === "delete-history-directory" && actionButton.dataset.cwd) {
        (function(deleteCwd, btn) {
          var items = getHistoryItemsByCwd(deleteCwd);
          var dirCount = getVisibleClaudeHistorySessions().filter(function(s) {
            return s.cwd === deleteCwd;
          }).length;
          confirmDelete("\u786E\u8BA4\u6E05\u7A7A\u6B64\u76EE\u5F55\u4E0B\u7684 " + dirCount + " \u6761 Claude \u5386\u53F2\u5417\uFF1F", {
            title: "\u6E05\u7A7A\u76EE\u5F55\u5386\u53F2",
            okLabel: "\u6E05\u7A7A"
          }).then(function(ok) {
            if (!ok) return;
            setDeletingState(items, true);
            deleteClaudeHistoryDirectory(deleteCwd, btn, items);
          });
        })(actionButton.dataset.cwd, actionButton);
      } else if (actionButton.dataset.action === "clear-all-history") {
        clearAllClaudeHistory();
      } else if (actionButton.dataset.action === "toggle-archived-group") {
        state.archivedExpanded = !state.archivedExpanded;
        updateSessionsList();
      } else if (actionButton.dataset.action === "resume" && actionButton.dataset.sessionId) {
        handleResumeAction(actionButton);
      } else if (actionButton.dataset.action === "resume-history" && actionButton.dataset.claudeSessionId) {
        handleResumeHistoryAction(actionButton);
      } else if (actionButton.dataset.action === "resume-codex-history" && actionButton.dataset.claudeSessionId) {
        handleResumeCodexHistoryAction(actionButton);
      } else if (actionButton.dataset.action === "delete-codex-history" && actionButton.dataset.claudeSessionId) {
        handleDeleteCodexHistoryAction(actionButton);
      } else if (actionButton.dataset.action === "toggle-codex-history-directory" && actionButton.dataset.cwd) {
        var codexDirCwd = actionButton.dataset.cwd;
        state.codexHistoryExpandedDirs[codexDirCwd] = !state.codexHistoryExpandedDirs[codexDirCwd];
        updateSessionsList();
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
          toggleManagedItemSelection(item.dataset.provider === "codex" ? "codex" : "history", item.dataset.claudeHistoryId);
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
        var resumeItem = item.dataset.provider === "codex" ? resumeCodexHistorySession : resumeClaudeHistorySession;
        resumeItem(claudeSessionId, cwd).then(function(data) {
          if (data && data.id) {
            state.selectedId = data.id;
            persistSelectedId();
            state.drafts[data.id] = "";
            loadSessions().then(function() {
              selectSession(data.id);
              dismissDrawerIfOverlay();
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
        toggleManagedItemSelection(item.dataset.provider === "codex" ? "codex" : "history", item.dataset.claudeHistoryId);
      }
      return;
    }
    if (item.dataset.sessionId) {
      activateSessionItem(item.dataset.sessionId);
    } else if (item.dataset.claudeHistoryId) {
      var claudeSessionId = item.dataset.claudeHistoryId;
      var cwd = item.dataset.cwd;
      var resumeItem = item.dataset.provider === "codex" ? resumeCodexHistorySession : resumeClaudeHistorySession;
      resumeItem(claudeSessionId, cwd).then(function(data) {
        if (data && data.id) {
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          loadSessions().then(function() {
            selectSession(data.id);
            dismissDrawerIfOverlay();
          });
        }
      });
    }
  }
  function copySelectedSessionField(field, successMsg) {
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!session) return;
    var value = session[field];
    if (!value) {
      showToast2("\u5F53\u524D\u4F1A\u8BDD\u6CA1\u6709\u53EF\u590D\u5236\u7684\u5185\u5BB9\u3002", "error");
      return;
    }
    copyToClipboard(String(value), null, function() {
      showToast2(successMsg || "\u5DF2\u590D\u5236", "info");
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
    var shouldShow = !!state.selectedId && state.currentView === "terminal" && !state.terminalAutoFollow && !isTerminalAtBottom();
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
    var windowMs = smooth ? 500 : 120;
    state.terminalProgrammaticScrollUntil = Math.max(
      state.terminalProgrammaticScrollUntil,
      Date.now() + windowMs
    );
    if (smooth) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }
  function setTerminalManualScrollActive() {
    state.terminalAutoFollow = false;
    clearTerminalScrollIdleTimer();
    state.terminalProgrammaticScrollUntil = 0;
    if (state.terminal && "_shouldScrollToBottom" in state.terminal) {
      state.terminal._shouldScrollToBottom = false;
    }
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
    if (!state.terminalAutoFollow) {
      updateTerminalJumpToBottomButton();
      return;
    }
    scrollTerminalToBottom(false);
    updateTerminalJumpToBottomButton();
  }
  function initTerminalScrollbar2(container) {
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
    function syncScrollbarThumb() {
      state.terminalScrollbarRafPending = false;
      var viewport2 = getTerminalViewport();
      if (!viewport2) return;
      var sh = viewport2.scrollHeight;
      var ch = viewport2.clientHeight;
      if (sh <= ch) {
        scrollbar.classList.remove("visible");
        return;
      }
      var trackH = track.clientHeight;
      var thumbH = Math.max(28, ch / sh * trackH);
      var maxScroll = sh - ch;
      var scrollRatio = viewport2.scrollTop / maxScroll;
      var thumbTop = scrollRatio * (trackH - thumbH);
      thumb.style.height = thumbH + "px";
      thumb.style.top = thumbTop + "px";
    }
    function requestSyncScrollbar() {
      if (state.terminalScrollbarRafPending) return;
      state.terminalScrollbarRafPending = true;
      requestAnimationFrame(syncScrollbarThumb);
    }
    var viewport = getTerminalViewport();
    if (viewport) {
      viewport.addEventListener("scroll", function() {
        showScrollbar();
        requestSyncScrollbar();
        scheduleHideScrollbar();
      }, { passive: true });
    }
    track.addEventListener("mousedown", function(e) {
      if (e.target === thumb) return;
      e.preventDefault();
      var viewport2 = getTerminalViewport();
      if (!viewport2) return;
      var rect = track.getBoundingClientRect();
      var clickRatio = (e.clientY - rect.top) / rect.height;
      var maxScroll = viewport2.scrollHeight - viewport2.clientHeight;
      viewport2.scrollTop = clickRatio * maxScroll;
    });
    var dragStartY = 0;
    var dragStartScrollTop = 0;
    thumb.addEventListener("mousedown", function(e) {
      e.preventDefault();
      e.stopPropagation();
      state.terminalScrollbarDragging = true;
      thumb.classList.add("dragging");
      dragStartY = e.clientY;
      var viewport2 = getTerminalViewport();
      dragStartScrollTop = viewport2 ? viewport2.scrollTop : 0;
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd);
    });
    function onDragMove(e) {
      e.preventDefault();
      var viewport2 = getTerminalViewport();
      if (!viewport2) return;
      var trackH = track.clientHeight;
      var sh = viewport2.scrollHeight;
      var ch = viewport2.clientHeight;
      var maxScroll = sh - ch;
      if (maxScroll <= 0) return;
      var thumbH = Math.max(28, ch / sh * trackH);
      var scrollableTrack = trackH - thumbH;
      if (scrollableTrack <= 0) return;
      var deltaY = e.clientY - dragStartY;
      var scrollDelta = deltaY / scrollableTrack * maxScroll;
      viewport2.scrollTop = dragStartScrollTop + scrollDelta;
    }
    function onDragEnd() {
      state.terminalScrollbarDragging = false;
      thumb.classList.remove("dragging");
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
      scheduleHideScrollbar();
    }
    thumb.addEventListener("touchstart", function(e) {
      if (e.touches.length !== 1) return;
      e.stopPropagation();
      state.terminalScrollbarDragging = true;
      thumb.classList.add("dragging");
      dragStartY = e.touches[0].clientY;
      var viewport2 = getTerminalViewport();
      dragStartScrollTop = viewport2 ? viewport2.scrollTop : 0;
      document.addEventListener("touchmove", onTouchDragMove, { passive: false });
      document.addEventListener("touchend", onTouchDragEnd);
      document.addEventListener("touchcancel", onTouchDragEnd);
    }, { passive: false });
    function onTouchDragMove(e) {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      var viewport2 = getTerminalViewport();
      if (!viewport2) return;
      var trackH = track.clientHeight;
      var sh = viewport2.scrollHeight;
      var ch = viewport2.clientHeight;
      var maxScroll = sh - ch;
      if (maxScroll <= 0) return;
      var thumbH = Math.max(28, ch / sh * trackH);
      var scrollableTrack = trackH - thumbH;
      if (scrollableTrack <= 0) return;
      var deltaY = e.touches[0].clientY - dragStartY;
      var scrollDelta = deltaY / scrollableTrack * maxScroll;
      viewport2.scrollTop = dragStartScrollTop + scrollDelta;
    }
    function onTouchDragEnd() {
      state.terminalScrollbarDragging = false;
      thumb.classList.remove("dragging");
      document.removeEventListener("touchmove", onTouchDragMove);
      document.removeEventListener("touchend", onTouchDragEnd);
      document.removeEventListener("touchcancel", onTouchDragEnd);
      scheduleHideScrollbar();
    }
    scrollbar.addEventListener("mouseenter", function() {
      showScrollbar();
    });
    scrollbar.addEventListener("mouseleave", function() {
      if (!state.terminalScrollbarDragging) scheduleHideScrollbar();
    });
    requestSyncScrollbar();
  }
  function isEastAsianWide(cp) {
    if (cp < 4352) return false;
    return cp >= 4352 && cp <= 4447 || cp >= 9001 && cp <= 9002 || cp >= 11904 && cp <= 12350 || cp >= 12353 && cp <= 13311 || cp >= 13312 && cp <= 19903 || cp >= 19968 && cp <= 40959 || cp >= 40960 && cp <= 42191 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65072 && cp <= 65103 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 126976 && cp <= 129535 || cp >= 131072 && cp <= 196605 || cp >= 196608 && cp <= 262141;
  }
  var WAND_WIDE_FILLER = "\u2060";
  function createWideParserState() {
    return { mode: "normal" };
  }
  function isAsciiNonEscape(s) {
    return !/[^\x00-\x7f]/.test(s) && s.indexOf("\x1B") === -1;
  }
  function widePadAnsi2(data, st) {
    if (!data) return "";
    var s = String(data);
    if (st.mode === "normal" && isAsciiNonEscape(s)) return s;
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      var cp = code;
      var consumed = 1;
      if (code >= 55296 && code <= 56319 && i + 1 < s.length) {
        var lo = s.charCodeAt(i + 1);
        if (lo >= 56320 && lo <= 57343) {
          cp = (code - 55296) * 1024 + (lo - 56320) + 65536;
          consumed = 2;
        }
      }
      var ch = consumed === 2 ? s.substr(i, 2) : s.charAt(i);
      switch (st.mode) {
        case "normal":
          if (cp === 27) {
            st.mode = "esc";
            out += ch;
          } else if (cp === 155) {
            st.mode = "csi";
            out += ch;
          } else if (cp === 157 || cp === 144 || cp === 158 || cp === 159) {
            st.mode = "string";
            out += ch;
          } else {
            out += ch;
            if (isEastAsianWide(cp)) out += WAND_WIDE_FILLER;
          }
          break;
        case "esc":
          out += ch;
          if (cp === 91) st.mode = "csi";
          else if (cp === 93 || cp === 80 || cp === 88 || cp === 94 || cp === 95) st.mode = "string";
          else st.mode = "normal";
          break;
        case "csi":
          out += ch;
          if (cp >= 64 && cp <= 126) st.mode = "normal";
          break;
        case "string":
          out += ch;
          if (cp === 7 || cp === 156) st.mode = "normal";
          else if (cp === 27) st.mode = "string-esc";
          break;
        case "string-esc":
          out += ch;
          if (cp === 92) st.mode = "normal";
          else st.mode = "string";
          break;
      }
      i += consumed - 1;
    }
    return out;
  }
  var SYNC_OUTPUT_BEGIN = "\x1B[?2026h";
  var SYNC_OUTPUT_END = "\x1B[?2026l";
  var SYNC_OUTPUT_MAX_BUFFER_MS = 200;
  var SYNC_OUTPUT_MAX_BYTES = 256 * 1024;
  function processSyncOutputFraming(data) {
    if (!data) return data;
    if (state.syncOutputBuffer === null && data.indexOf(SYNC_OUTPUT_BEGIN) === -1) {
      return data;
    }
    var out = "";
    var i = 0;
    while (i < data.length) {
      if (state.syncOutputBuffer !== null) {
        var endIdx = data.indexOf(SYNC_OUTPUT_END, i);
        if (endIdx === -1) {
          state.syncOutputBuffer += data.slice(i);
          if (state.syncOutputBuffer.length > SYNC_OUTPUT_MAX_BYTES || Date.now() > state.syncOutputDeadline) {
            out += state.syncOutputBuffer;
            state.syncOutputBuffer = null;
            state.syncFramingResidue = true;
          }
          return out;
        }
        state.syncOutputBuffer += data.slice(i, endIdx + SYNC_OUTPUT_END.length);
        out += state.syncOutputBuffer;
        state.syncOutputBuffer = null;
        i = endIdx + SYNC_OUTPUT_END.length;
      } else {
        var beginIdx = data.indexOf(SYNC_OUTPUT_BEGIN, i);
        if (beginIdx === -1) {
          out += data.slice(i);
          return out;
        }
        out += data.slice(i, beginIdx);
        state.syncOutputBuffer = SYNC_OUTPUT_BEGIN;
        state.syncOutputDeadline = Date.now() + SYNC_OUTPUT_MAX_BUFFER_MS;
        i = beginIdx + SYNC_OUTPUT_BEGIN.length;
      }
    }
    return out;
  }
  function flushSyncOutputBuffer() {
    if (state.syncOutputBuffer !== null) {
      var buffered = state.syncOutputBuffer;
      state.syncOutputBuffer = null;
      return buffered;
    }
    return "";
  }
  function wandTerminalWrite(terminal, data) {
    if (!terminal || data == null) return;
    if (!state.wideParserState) state.wideParserState = createWideParserState();
    var padded = widePadAnsi2(data, state.wideParserState);
    var framed = processSyncOutputFraming(padded);
    var follow = state.terminalAutoFollow !== false;
    if ("_shouldScrollToBottom" in terminal) {
      terminal._shouldScrollToBottom = follow;
    }
    if (framed) terminal.write(framed);
    if ("_shouldScrollToBottom" in terminal) {
      terminal._shouldScrollToBottom = follow;
    }
    if (follow) {
      state.terminalProgrammaticScrollUntil = Math.max(
        state.terminalProgrammaticScrollUntil,
        Date.now() + 120
      );
    }
    maybeScheduleResyncForChunk(data);
  }
  function resetWideParserState() {
    state.wideParserState = createWideParserState();
  }
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
      var cleaned = text.split("\n").map(function(line) {
        return line.split(WAND_WIDE_FILLER).join("").replace(/[ \t]+$/, "");
      }).join("\n");
      if (cleaned === text) return;
      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", cleaned);
        e.preventDefault();
      }
    });
  }
  stripWideFillerForCopy();
  var CHAT_RENDER_LIVE_MS = 150;
  var CHAT_RENDER_IDLE_MS = 30;
  var CLIENT_OUTPUT_MAX = 160 * 1024;
  var CLIENT_OUTPUT_TRIM_AT = 192 * 1024;
  function clampClientTerminalOutput(buf) {
    if (!buf || buf.length <= CLIENT_OUTPUT_TRIM_AT) return buf;
    var preTrimLen = buf.length;
    var _adjustMarker = function(trimmedLen) {
      if (typeof state === "undefined" || !state) return;
      var mk = state.terminalOutputMarker | 0;
      if (mk <= 0) return;
      var dropped = preTrimLen - trimmedLen;
      state.terminalOutputMarker = mk > dropped ? mk - dropped : 0;
    };
    var start = buf.length - CLIENT_OUTPUT_MAX;
    if (start > 0 && start < buf.length) {
      var c0 = buf.charCodeAt(start);
      if (c0 >= 56320 && c0 <= 57343) start++;
    }
    var LOOKAHEAD = 4096;
    var upper = Math.min(start + LOOKAHEAD, buf.length);
    for (var i = start; i < upper; i++) {
      if (buf.charCodeAt(i) === 10) {
        var trimmed1 = buf.slice(i + 1);
        _adjustMarker(trimmed1.length);
        return trimmed1;
      }
    }
    var lookback = Math.max(0, start - 256);
    var escAt = -1;
    for (var j = start - 1; j >= lookback; j--) {
      var c = buf.charCodeAt(j);
      if (c === 27) {
        escAt = j;
        break;
      }
      if (c === 7) break;
      if (c >= 64 && c <= 126) break;
    }
    if (escAt !== -1) {
      var terminated = false;
      for (var k = escAt + 1; k < start; k++) {
        var ck = buf.charCodeAt(k);
        if (ck === 7) {
          terminated = true;
          break;
        }
        if (ck >= 64 && ck <= 126) {
          terminated = true;
          break;
        }
      }
      if (!terminated) {
        var ahead = Math.min(start + 256, buf.length);
        for (var m = start; m < ahead; m++) {
          var cm = buf.charCodeAt(m);
          if (cm === 7 || cm >= 64 && cm <= 126) {
            var trimmed2 = buf.slice(m + 1);
            _adjustMarker(trimmed2.length);
            return trimmed2;
          }
        }
      }
    }
    var trimmed3 = buf.slice(start);
    _adjustMarker(trimmed3.length);
    return trimmed3;
  }
  function resetTerminal3() {
    if (!state.terminal) return;
    if (typeof state.terminal.reset === "function") {
      state.terminal.reset();
      resetWideParserState();
      state.syncOutputBuffer = null;
      state.syncOutputDeadline = 0;
      return;
    }
    if (typeof state.terminal.write === "function") {
      state.terminal.write("\x1Bc");
    }
    resetWideParserState();
    state.syncOutputBuffer = null;
    state.syncOutputDeadline = 0;
  }
  state._resyncStatsWindowStart = 0;
  state._resyncStatsCount = 0;
  state._resyncLastWarnAt = 0;
  var RESYNC_BUDGET_WINDOW_MS = 5e3;
  var RESYNC_BUDGET_MAX = 12;
  var RESYNC_WARN_COOLDOWN_MS = 3e4;
  state._resyncInProgress = false;
  function softResyncTerminal2(options) {
    if (!state.terminal || !state.terminalOutput) return false;
    var opts = options || {};
    var marker = state.terminalOutputMarker | 0;
    if (marker < 0) marker = 0;
    if (marker > state.terminalOutput.length) marker = state.terminalOutput.length;
    var replaySource = marker > 0 ? state.terminalOutput.slice(marker) : state.terminalOutput;
    var bufLen = replaySource.length;
    var startedAt = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    state._resyncInProgress = true;
    try {
      resetTerminal3();
      wandTerminalWrite(state.terminal, replaySource);
    } finally {
      state._resyncInProgress = false;
    }
    state.lastTerminalResyncAt = Date.now();
    maybeScrollTerminalToBottom("output");
    if (!opts.skipFit) ensureTerminalFit2("refresh");
    var now = Date.now();
    if (now - state._resyncStatsWindowStart > RESYNC_BUDGET_WINDOW_MS) {
      state._resyncStatsWindowStart = now;
      state._resyncStatsCount = 1;
    } else {
      state._resyncStatsCount++;
      if (state._resyncStatsCount > RESYNC_BUDGET_MAX && now - state._resyncLastWarnAt > RESYNC_WARN_COOLDOWN_MS) {
        state._resyncLastWarnAt = now;
        var endedAt = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        console.warn(
          "[wand] softResyncTerminal high frequency",
          "count=" + state._resyncStatsCount + "/" + Math.round((now - state._resyncStatsWindowStart) / 100) / 10 + "s",
          "bufLen=" + bufLen,
          "lastReplayMs=" + Math.round(endedAt - startedAt)
        );
      }
    }
    return true;
  }
  function scheduleSoftResyncTerminal(delayMs) {
    if (state.softResyncTimer) clearTimeout(state.softResyncTimer);
    state.softResyncTimer = setTimeout(function() {
      state.softResyncTimer = null;
      softResyncTerminal2();
    }, typeof delayMs === "number" ? delayMs : 150);
  }
  var IN_PLACE_REDRAW_RE = /\x1b\[\d*(?:;\d*)?[ABCDfHJK]/;
  var RESYNC_THROTTLE_MS = 1500;
  var RESYNC_TAIL_MS = 800;
  state._resyncChunkLastAt = 0;
  state._resyncChunkTailTimer = null;
  function maybeScheduleResyncForChunk(chunk) {
    if (state._resyncInProgress) return;
    if (!state.syncFramingResidue) return;
    state.syncFramingResidue = false;
    if (!chunk || typeof chunk !== "string") return;
    if (chunk.indexOf("\x1B[") === -1) return;
    if (!IN_PLACE_REDRAW_RE.test(chunk)) return;
    var now = Date.now();
    var sinceLast = now - state._resyncChunkLastAt;
    if (sinceLast >= RESYNC_THROTTLE_MS) {
      if (state._resyncChunkTailTimer) {
        clearTimeout(state._resyncChunkTailTimer);
        state._resyncChunkTailTimer = null;
      }
      state._resyncChunkLastAt = now;
      softResyncTerminal2();
      return;
    }
    if (state._resyncChunkTailTimer) return;
    var wait = Math.max(RESYNC_TAIL_MS, RESYNC_THROTTLE_MS - sinceLast);
    state._resyncChunkTailTimer = setTimeout(function() {
      state._resyncChunkTailTimer = null;
      state._resyncChunkLastAt = Date.now();
      softResyncTerminal2();
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
      resetTerminal3();
      currentOutput = "";
      state.terminalOutput = "";
      state.terminalOutputMarker = 0;
      state.terminalAutoFollow = true;
      clearTerminalScrollIdleTimer();
      updateTerminalJumpToBottomButton();
    }
    if (mode === "replace") {
      if (normalizedOutput !== currentOutput) {
        resetTerminal3();
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
        wrote = true;
      }
    } else if (currentOutput && currentOutput.startsWith(normalizedOutput)) {
      return false;
    } else {
      resetTerminal3();
      if (normalizedOutput) {
        wandTerminalWrite(state.terminal, normalizedOutput);
      }
      wrote = true;
    }
    state.terminalSessionId = nextSessionId;
    state.terminalOutput = normalizedOutput;
    state.terminalOutputMarker = 0;
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
  function initTerminal2() {
    var container = document.getElementById("output");
    if (!container || state.terminal || state.terminalInitializing) return;
    if (typeof WTermLib === "undefined" || !WTermLib.WTerm) {
      if (!state.terminalInitRetries) state.terminalInitRetries = 0;
      if (state.terminalInitRetries < 10) {
        state.terminalInitRetries++;
        setTimeout(initTerminal2, 200);
      }
      return;
    }
    state.terminalInitRetries = 0;
    state.terminalInitializing = true;
    if (state.selectedId) {
      container.classList.remove("hidden");
      container.classList.add("active");
    }
    var staleWraps = container.querySelectorAll(".terminal-scroll-wrap");
    for (var i = 0; i < staleWraps.length; i++) {
      var stale = staleWraps[i];
      if (stale.parentNode === container) container.removeChild(stale);
    }
    var termWrap = document.createElement("div");
    termWrap.className = "terminal-scroll-wrap";
    container.appendChild(termWrap);
    var term = new WTermLib.WTerm(termWrap, {
      cols: 120,
      rows: 36,
      autoResize: true,
      cursorBlink: false,
      onData: function() {
        return;
      },
      onResize: function(cols, rows) {
        sendTerminalResize(cols, rows);
        if (state.terminal && state.terminalOutput) {
          softResyncTerminal2({ skipFit: true });
        }
      }
    });
    var fontsReady = document.fonts && typeof document.fonts.ready === "object" ? Promise.race([document.fonts.ready, new Promise(function(r) {
      setTimeout(r, 800);
    })]) : Promise.resolve();
    fontsReady.then(function() {
      return term.init();
    }).then(function() {
      state.terminal = term;
      state.terminalInitializing = false;
      applyTerminalScale();
      if (termWrap.isConnected) {
        void termWrap.offsetHeight;
        if (typeof term.remeasure === "function") {
          try {
            term.remeasure();
          } catch (e) {
          }
        }
      }
      state.terminalAutoFollow = true;
      clearTerminalScrollIdleTimer();
      var viewport = getTerminalViewport();
      if (viewport) {
        state.terminalViewportScrollHandler = function() {
          if (Date.now() < state.terminalProgrammaticScrollUntil) {
            updateTerminalJumpToBottomButton();
            return;
          }
          if (isTerminalAtBottom()) {
            state.terminalAutoFollow = true;
            clearTerminalScrollIdleTimer();
            updateTerminalJumpToBottomButton();
            return;
          }
          setTerminalManualScrollActive();
        };
        state.terminalViewportTouchStartHandler = function(e) {
          if (e.touches && e.touches.length === 1) {
            state.terminalTouchStartY = e.touches[0].clientY;
          }
        };
        state.terminalViewportTouchHandler = function(e) {
          if (!e.touches || e.touches.length !== 1) return;
          if (typeof state.terminalTouchStartY !== "number") return;
          if (e.touches[0].clientY - state.terminalTouchStartY > 4) {
            setTerminalManualScrollActive();
          }
        };
        viewport.addEventListener("scroll", state.terminalViewportScrollHandler, { passive: true });
        viewport.addEventListener("touchstart", state.terminalViewportTouchStartHandler, { passive: true });
        viewport.addEventListener("touchmove", state.terminalViewportTouchHandler, { passive: true });
      }
      state.terminalWheelHandler = function(e) {
        if (e.deltaY < 0) {
          setTerminalManualScrollActive();
        }
        e.stopPropagation();
      };
      container.addEventListener("wheel", state.terminalWheelHandler, { passive: true });
      initTerminalScrollbar2(container);
      if (state.selectedId) {
        var session = state.sessions.find(function(s) {
          return s.id === state.selectedId;
        });
        if (session) {
          syncTerminalBuffer(session.id, session.output || "", { mode: "append", scroll: false });
        }
      } else {
        wandTerminalWrite(term, "\u70B9\u51FB\u4E0A\u65B9\u300C\u65B0\u5BF9\u8BDD\u300D\u5F00\u59CB\u4F60\u7684\u7B2C\u4E00\u6B21\u5BF9\u8BDD\u3002\r\n");
      }
      state.terminalClickHandler = function(e) {
        if (hasActiveTerminalSelection()) return;
        focusInputBox3(e);
      };
      container.addEventListener("click", state.terminalClickHandler);
      updateTerminalJumpToBottomButton();
      initTerminalResizeHandle();
      initTerminalJoystick();
      observeTerminalResize();
      startTerminalHealthCheck();
      ensureTerminalFit2("mount", { forceReplay: true });
      if (document.documentElement.classList.contains("is-wand-embed-terminal")) {
        [120, 350, 700].forEach(function(delay) {
          setTimeout(function() {
            if (state.terminal) ensureTerminalFit2("embed-settle");
          }, delay);
        });
      }
    }).catch(function(err) {
      state.terminalInitializing = false;
      console.error("[wand] wterm init failed:", err);
    });
  }

  // src/web-ui/browser/events.ts
  function __fetchToolContent(toolUseId, callback) {
    if (!state.selectedId || !toolUseId) return;
    var cacheKey = state.selectedId + ":" + toolUseId;
    if (state.toolContentCache[cacheKey]) {
      callback(null, state.toolContentCache[cacheKey]);
      return;
    }
    fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/tool-content/" + encodeURIComponent(toolUseId), { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        callback(data.error, null);
      } else {
        state.toolContentCache[cacheKey] = data;
        callback(null, data);
      }
    }).catch(function() {
      callback("\u52A0\u8F7D\u5931\u8D25", null);
    });
  }
  function getCardDefault(key) {
    return !!(state.config && state.config.cardDefaults && state.config.cardDefaults[key]);
  }
  function lazyLoadTruncatedToolContent(container, targetEl, renderContent, renderError) {
    if (!container || container.dataset.truncated !== "true" || container.dataset.loaded === "true") return;
    var toolUseId = container.dataset.toolUseId;
    if (!toolUseId) return;
    if (targetEl) targetEl.innerHTML = '<div class="tool-content-loading">\u52A0\u8F7D\u4E2D\u2026</div>';
    container.dataset.loaded = "loading";
    __fetchToolContent(toolUseId, function(err, data) {
      if (err) {
        if (targetEl) targetEl.innerHTML = renderError || '<div class="tool-content-error">\u52A0\u8F7D\u5931\u8D25\uFF0C\u70B9\u51FB\u91CD\u8BD5</div>';
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
      var isExpanded = wasCollapsed;
      headerEl.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      var cardBody = card.querySelector(".tool-use-body, .diff-body");
      if (cardBody) cardBody.setAttribute("aria-hidden", isExpanded ? "false" : "true");
      var expandKind = card.dataset.expandKind || "tool-card";
      persistElementExpandState(card, expandKind);
      if (wasCollapsed) {
        var resultDiv = card.querySelector(".tool-use-result");
        lazyLoadTruncatedToolContent(
          card,
          resultDiv,
          function(content) {
            if (resultDiv) resultDiv.innerHTML = '<pre class="tool-use-result-content">' + escapeHtml2(content) + "</pre>";
          },
          `<div class="tool-content-error" onclick="__tcToggle(null, this.closest('.tool-use-card,.inline-diff').querySelector('.tool-use-header,.diff-header'))">\u52A0\u8F7D\u5931\u8D25\uFF0C\u70B9\u51FB\u91CD\u8BD5</div>`
        );
      }
    }
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.__thinkingToggle = function(el) {
    var isCollapsed = el.classList.contains("collapsed");
    if (isCollapsed) {
      el.classList.remove("collapsed");
      el.classList.add("expanded");
      el.querySelector(".thinking-inline-preview").textContent = el.dataset.thinking || "";
      var action = el.querySelector(".thinking-inline-action");
      if (action) action.textContent = "\u6536\u8D77";
    } else {
      el.classList.remove("expanded");
      el.classList.add("collapsed");
      var preview = (el.dataset.thinking || "").slice(0, 57) + ((el.dataset.thinking || "").length > 60 ? "\u2026" : "");
      el.querySelector(".thinking-inline-preview").textContent = preview;
      var action = el.querySelector(".thinking-inline-action");
      if (action) action.textContent = "\u5C55\u5F00";
    }
    persistElementExpandState(el, "thinking");
  };
  window.__subagentReplyToggle = function(e, target) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    var bubble = target && target.closest ? target.closest(".subagent-reply") : null;
    if (!bubble) return;
    var expanded = bubble.getAttribute("data-expanded") === "true";
    applyExpandedState(bubble, "subagent-reply", !expanded);
    persistElementExpandState(bubble, "subagent-reply");
  };
  window.__subagentPanelToggle = function(e, target) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    var panel = target && target.closest ? target.closest(".subagent-panel") : null;
    if (!panel) return;
    panel.setAttribute("data-expanded", "true");
  };
  function snapCollapsedSubagentPanelsToBottom2(container) {
    if (!container) return;
    var panels = container.querySelectorAll('.subagent-panel[data-follow-tail="true"]');
    for (var i = 0; i < panels.length; i++) {
      var body = panels[i].querySelector(".subagent-panel-body");
      if (!body) continue;
      body.scrollTop = body.scrollHeight;
    }
  }
  window.__openFilePreview = function(p) {
    if (p) openFilePreview(p);
  };
  window.__inlineToolToggle = function(el) {
    var expanded = el.classList.toggle("inline-tool-open");
    var body = el.querySelector(".inline-tool-expanded");
    if (body) {
      body.style.display = expanded ? "block" : "none";
    }
    var statusSpan = el.querySelector(".inline-tool-status");
    if (statusSpan) {
      if (el.dataset.status === "error") {
        statusSpan.textContent = "\u2717";
      } else if (el.dataset.status === "done") {
        statusSpan.textContent = "\u2713";
      }
    }
    if (expanded) {
      lazyLoadTruncatedToolContent(el, body, function(content) {
        el.dataset.result = content;
        if (body) body.innerHTML = '<div class="inline-tool-result">' + formatInlineResult(content, "") + "</div>";
      });
    }
    persistElementExpandState(el, "inline-tool");
  };
  window.__terminalExpand = function(el) {
    var container = el.closest(".inline-terminal");
    if (!container) return;
    var body = container.querySelector(".term-body");
    if (body) {
      var isHidden = body.style.display === "none";
      body.style.display = isHidden ? "block" : "none";
      container.dataset.expanded = isHidden ? "true" : "false";
      el.setAttribute("aria-expanded", isHidden ? "true" : "false");
      body.setAttribute("aria-hidden", isHidden ? "false" : "true");
      var toggleIcon = el.querySelector(".term-toggle-icon");
      if (toggleIcon) toggleIcon.textContent = isHidden ? "\u25BC" : "\u25B6";
      persistElementExpandState(container, "terminal");
      if (isHidden) {
        var termOutput = body.querySelector(".term-output");
        lazyLoadTruncatedToolContent(container, termOutput, function(content) {
          if (termOutput) {
            var lines = content.split("\n");
            var html = "";
            for (var i = 0; i < lines.length; i++) {
              if (!lines[i] && i === lines.length - 1) continue;
              html += '<div class="term-line">' + escapeHtml2(lines[i]) + "</div>";
            }
            termOutput.innerHTML = html;
          }
        });
      }
    }
  };
  function updateStreamingThinking(text) {
    var el = document.querySelector(".thinking-streaming");
    if (el) {
      var textEl = el.querySelector(".thinking-streaming-text");
      if (textEl) {
        var lines = text.split("\n");
        var displayLines = lines.slice(-3);
        textEl.textContent = displayLines.join("\n");
        textEl.scrollTop = textEl.scrollHeight;
      }
    }
  }
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
      if (pos === -1) {
        current.push(optIdx);
      } else {
        current.splice(pos, 1);
      }
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
    card.querySelectorAll(".ask-user-option").forEach(function(btn) {
      var qIdx = parseInt(btn.dataset.questionIndex, 10);
      var oIdx = parseInt(btn.dataset.optionIndex, 10);
      var chosen = (sel[qIdx] || []).indexOf(oIdx) !== -1;
      btn.classList.toggle("selected", chosen);
    });
    var submitBtn = card.querySelector(".ask-user-submit");
    if (submitBtn) {
      var groups = card.querySelectorAll(".ask-user-question-group");
      var allAnswered = true;
      groups.forEach(function(g, i) {
        if (!sel[i] || sel[i].length === 0) allAnswered = false;
      });
      submitBtn.disabled = !allAnswered || !!sel.submitted;
      if (sel.submitted) {
        submitBtn.textContent = "\u5DF2\u63D0\u4EA4...";
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
      if (selected.length === 0) {
        allAnswered = false;
        return;
      }
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
  function bindGlobalListenersOnce() {
    if (state.__globalListenersBound) return;
    state.__globalListenersBound = true;
    document.addEventListener("click", function() {
      var el = document.getElementById("sidebar-overflow-menu");
      if (el) el.classList.remove("open");
    });
    document.addEventListener("click", function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("#check-update-button, #do-update-button, #do-restart-button, #check-provider-cli-updates, #update-provider-clis");
      if (!button || button.disabled) return;
      e.preventDefault();
      if (button.id === "check-update-button") {
        checkForUpdate();
      } else if (button.id === "do-update-button") {
        performUpdate();
      } else if (button.id === "check-provider-cli-updates") {
        loadProviderCliUpdates(true);
      } else if (button.id === "update-provider-clis") {
        performProviderCliUpdates();
      } else {
        performSettingsRestart();
      }
    });
    window.addEventListener("resize", function() {
      var el = document.getElementById("sidebar-overflow-menu");
      if (el) el.classList.remove("open");
    });
    var closeTopbarMore = function() {
      state.topbarMoreOpen = false;
      var menu = document.getElementById("topbar-more-menu");
      var btn = document.getElementById("topbar-more-button");
      if (menu) menu.classList.add("hidden");
      if (btn) {
        btn.classList.remove("active");
        btn.setAttribute("aria-expanded", "false");
      }
    };
    document.addEventListener("click", function(e) {
      if (!state.topbarMoreOpen) return;
      var menu = document.getElementById("topbar-more-menu");
      var wrap = menu && menu.parentElement;
      if (wrap && !wrap.contains(e.target)) closeTopbarMore();
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape" && state.topbarMoreOpen) closeTopbarMore();
    });
    document.addEventListener("click", function(e) {
      if (!state.plusPopoverOpen) return;
      var pop = document.getElementById("composer-plus-popover");
      var btn = document.getElementById("attach-btn");
      if (pop && pop.contains(e.target)) return;
      if (btn && btn.contains(e.target)) return;
      closePlusPopover();
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape" && state.plusPopoverOpen) closePlusPopover();
    });
    document.addEventListener("click", function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== "function") return;
      var toggle = target.closest("#auto-approve-toggle");
      if (!toggle) return;
      e.preventDefault();
      toggleAutoApprove();
    });
    document.addEventListener("click", function(e) {
      if (!e.target.closest(".folder-picker-container")) {
        var dd = document.getElementById("folder-picker-dropdown");
        if (dd) dd.classList.add("hidden");
      }
    });
    document.addEventListener("change", function(e) {
      var target = e.target;
      if (!target || target.nodeType !== 1) return;
      if (typeof target.matches !== "function" || !target.matches("[data-mode-control]")) return;
      var ctrl = target.getAttribute("data-mode-control");
      var value = target.value;
      if (ctrl === "mode") {
        onChatModeChange(value);
      } else if (ctrl === "model") {
        onChatModelChange(value);
      } else if (ctrl === "thinking") {
        onChatThinkingChange(value);
      }
      if (target.closest && target.closest("#composer-plus-popover")) closePlusPopover();
    });
  }
  function attachEventListeners() {
    bindGlobalListenersOnce();
    var loginButton = document.getElementById("login-button");
    if (loginButton) {
      loginButton.addEventListener("click", login);
      var loginForm = document.getElementById("login-form");
      if (loginForm) loginForm.addEventListener("submit", function(e) {
        e.preventDefault();
        login();
      });
      var loginSwitchServerBtn = document.getElementById("login-switch-server-button");
      if (loginSwitchServerBtn) loginSwitchServerBtn.addEventListener("click", switchServer);
      var passwordEl = document.getElementById("password");
      var togglePasswordButton = document.getElementById("toggle-password-button");
      if (togglePasswordButton && passwordEl) {
        togglePasswordButton.addEventListener("click", function() {
          var visible = passwordEl.type === "text";
          passwordEl.type = visible ? "password" : "text";
          togglePasswordButton.textContent = visible ? "\u663E\u793A" : "\u9690\u85CF";
          togglePasswordButton.setAttribute("aria-label", visible ? "\u663E\u793A\u5BC6\u7801" : "\u9690\u85CF\u5BC6\u7801");
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
          if (errorEl) hideError2(errorEl);
        });
        passwordEl.focus();
      }
      return;
    }
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
    var welcomeOpenCodeBtn = document.getElementById("welcome-tool-opencode");
    if (welcomeOpenCodeBtn) {
      welcomeOpenCodeBtn.addEventListener("click", function() {
        state.sessionTool = "opencode";
        state.preferredCommand = "opencode";
        state.modeValue = "managed";
        quickStartSession();
      });
    }
    var welcomeStructuredBtn = document.getElementById("welcome-tool-structured");
    if (welcomeStructuredBtn) {
      welcomeStructuredBtn.addEventListener("click", function() {
        createStructuredSession().then(function() {
          focusInputBox3(true);
        }).catch(function(error) {
          showToast2(error && error.message || "\u65E0\u6CD5\u542F\u52A8\u7ED3\u6784\u5316\u4F1A\u8BDD\u3002", "error");
        });
      });
    }
    initBlankChatCwd();
    var sessionsList = document.getElementById("sessions-list");
    if (sessionsList) {
      sessionsList.addEventListener("click", handleSessionItemClick);
      sessionsList.addEventListener("keydown", handleSessionItemKeydown);
      sessionsList.addEventListener("mouseover", handleCollapsedTileHover);
      sessionsList.addEventListener("mouseout", handleCollapsedTileLeave);
      initSwipeToDelete(sessionsList);
    }
    window.addEventListener("scroll", hideCollapsedTileBubble, true);
    window.addEventListener("resize", hideCollapsedTileBubble);
    var providerCardsEl = document.getElementById("provider-cards");
    if (providerCardsEl) providerCardsEl.addEventListener("click", function(e) {
      var card = e.target.closest(".provider-card");
      if (!card || card.classList.contains("disabled")) return;
      var provider = card.getAttribute("data-provider");
      if (provider) {
        state.sessionTool = provider;
        state.preferredCommand = provider;
        syncSessionModalUI();
        persistNewSessionDefaults({
          defaultProvider: provider,
          defaultMode: state.modeValue
        });
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
        persistNewSessionDefaults({ defaultSessionKind: kind });
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
        persistNewSessionDefaults({ defaultMode: state.modeValue });
      }
    });
    var worktreeToggleEl = document.getElementById("session-worktree-toggle");
    if (worktreeToggleEl) worktreeToggleEl.addEventListener("change", function() {
      state.sessionCreateWorktree = worktreeToggleEl.checked;
    });
    var cwdEl = document.getElementById("cwd");
    if (cwdEl) {
      cwdEl.addEventListener("input", function() {
        state.cwdValue = cwdEl.value;
      });
      cwdEl.addEventListener("change", function() {
        state.cwdValue = cwdEl.value;
      });
      cwdEl.addEventListener("input", schedulePathSuggestions);
      cwdEl.addEventListener("focus", schedulePathSuggestions);
      cwdEl.addEventListener("blur", function() {
        setTimeout(hidePathSuggestions, 120);
      });
    }
    var sessionsToggle = document.getElementById("sessions-toggle-button");
    if (sessionsToggle) sessionsToggle.addEventListener("click", toggleSessionsDrawer);
    var drawerBackdrop = document.getElementById("sessions-drawer-backdrop");
    if (drawerBackdrop) drawerBackdrop.addEventListener("click", closeSessionsDrawer2);
    var closeDrawerBtn = document.getElementById("close-drawer-button");
    if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeSessionsDrawer2);
    var collapseBtn = document.getElementById("sidebar-collapse-btn");
    if (collapseBtn) collapseBtn.addEventListener("click", toggleSidebarCollapsed);
    var pinBtn = document.getElementById("sidebar-pin-btn");
    if (pinBtn) pinBtn.addEventListener("click", toggleSidebarPin);
    var sidebarMoreBtn = document.getElementById("sidebar-more-btn");
    var sidebarOverflow = document.getElementById("sidebar-overflow-menu");
    if (sidebarMoreBtn && sidebarOverflow) {
      sidebarMoreBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        var willOpen = !sidebarOverflow.classList.contains("open");
        sidebarOverflow.classList.toggle("open", willOpen);
        if (willOpen) positionSidebarOverflowMenu(sidebarOverflow);
      });
    }
    var homeBtn = document.getElementById("sidebar-home-btn");
    if (homeBtn) homeBtn.addEventListener("click", function() {
      state.selectedId = null;
      persistSelectedId();
      resetChatRenderCache2();
      dismissDrawerIfOverlay();
      render8();
    });
    var refreshBtn = document.getElementById("sidebar-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", function() {
      window.location.reload();
    });
    var logoutBtn = document.getElementById("logout-button");
    if (logoutBtn) logoutBtn.addEventListener("click", logout2);
    var switchServerBtn = document.getElementById("switch-server-button");
    if (switchServerBtn) switchServerBtn.addEventListener("click", switchServer);
    var backToNativeBtn = document.getElementById("back-to-native-button");
    if (backToNativeBtn) backToNativeBtn.addEventListener("click", backToNativeApp);
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
    bindSettingsModelComboboxes();
    var defaultModelRefreshBtn = document.getElementById("cfg-default-model-refresh");
    if (defaultModelRefreshBtn) defaultModelRefreshBtn.addEventListener("click", refreshAvailableModels);
    var commitModelRefreshBtn = document.getElementById("cfg-commit-model-refresh");
    if (commitModelRefreshBtn) commitModelRefreshBtn.addEventListener("click", refreshAvailableModels);
    var commitCliSelect = document.getElementById("cfg-commit-cli");
    if (commitCliSelect) commitCliSelect.addEventListener("change", function() {
      syncCommitModelProvider(true);
    });
    var viewEnvBtn = document.getElementById("cfg-view-env-btn");
    if (viewEnvBtn) viewEnvBtn.addEventListener("click", openEnvPreviewModal);
    var saveDisplayBtn = document.getElementById("save-display-button");
    if (saveDisplayBtn) saveDisplayBtn.addEventListener("click", saveDisplaySettings);
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
              msgEl.textContent = "\u56FE\u6807\u5DF2\u5207\u6362\uFF0C\u8FD4\u56DE\u684C\u9762\u540E\u751F\u6548";
              msgEl.style.color = "var(--success)";
              msgEl.classList.remove("hidden");
              setTimeout(function() {
                msgEl.classList.add("hidden");
              }, 3e3);
            }
          } catch (_e) {
          }
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
            nameEl.textContent = nameEl.getAttribute("data-default") || "\u672A\u9009\u62E9\u6587\u4EF6";
            picker.classList.remove("file-picker-has-file");
          }
        });
      })(filePickerInputs[fpi]);
    }
    var autoUpdateWebToggle = document.getElementById("auto-update-web-toggle");
    if (autoUpdateWebToggle) autoUpdateWebToggle.addEventListener("change", function() {
      toggleAutoUpdate("web", autoUpdateWebToggle.checked);
    });
    var autoUpdateApkToggle = document.getElementById("auto-update-apk-toggle");
    if (autoUpdateApkToggle) autoUpdateApkToggle.addEventListener("change", function() {
      toggleAutoUpdate("apk", autoUpdateApkToggle.checked);
    });
    var autoUpdateDmgToggle = document.getElementById("auto-update-dmg-toggle");
    if (autoUpdateDmgToggle) autoUpdateDmgToggle.addEventListener("change", function() {
      toggleAutoUpdate("dmg", autoUpdateDmgToggle.checked);
    });
    var autoUpdateCliToggle = document.getElementById("auto-update-cli-toggle");
    if (autoUpdateCliToggle) autoUpdateCliToggle.addEventListener("change", function() {
      toggleAutoUpdate("cli", autoUpdateCliToggle.checked);
    });
    var betaChannelToggle = document.getElementById("beta-channel-toggle");
    if (betaChannelToggle) betaChannelToggle.addEventListener("change", function() {
      setUpdateChannel(betaChannelToggle.checked ? "beta" : "stable");
    });
    var copyConnectCodeBtn = document.getElementById("copy-connect-code-button");
    if (copyConnectCodeBtn) copyConnectCodeBtn.addEventListener("click", function() {
      var text = document.getElementById("android-connect-code");
      if (text) copyToClipboard(text.textContent, copyConnectCodeBtn);
    });
    var notifSoundEl = document.getElementById("cfg-notif-sound");
    if (notifSoundEl) {
      notifSoundEl.checked = state.notifSound;
      notifSoundEl.addEventListener("change", function() {
        state.notifSound = notifSoundEl.checked;
        try {
          localStorage.setItem("wand-notif-sound", String(state.notifSound));
        } catch (e) {
        }
        if (state.notifSound) _doPlaySound();
        var volField2 = document.getElementById("notif-volume-field");
        if (volField2) volField2.style.display = state.notifSound ? "" : "none";
      });
    }
    var notifVolumeEl = document.getElementById("cfg-notif-volume");
    var notifVolumeVal = document.getElementById("cfg-notif-volume-val");
    var _syncRangeFill = function(el) {
      if (!el) return;
      var minVal = Number(el.min || 0);
      var maxVal = Number(el.max || 100);
      var curVal = Number(el.value || 0);
      var pct = maxVal > minVal ? Math.max(0, Math.min(100, (curVal - minVal) / (maxVal - minVal) * 100)) : 0;
      el.style.setProperty("--range-fill", pct + "%");
    };
    if (notifVolumeEl) {
      notifVolumeEl.value = String(state.notifVolume);
      if (notifVolumeVal) notifVolumeVal.textContent = state.notifVolume + "%";
      _syncRangeFill(notifVolumeEl);
      var volField = document.getElementById("notif-volume-field");
      if (volField) volField.style.display = state.notifSound ? "" : "none";
      var _volDebounce = null;
      notifVolumeEl.addEventListener("input", function() {
        state.notifVolume = parseInt(notifVolumeEl.value, 10);
        if (notifVolumeVal) notifVolumeVal.textContent = state.notifVolume + "%";
        _syncRangeFill(notifVolumeEl);
        try {
          localStorage.setItem("wand-notif-volume", String(state.notifVolume));
        } catch (e) {
        }
        if (_hasNativeBridge && typeof WandNative.setNotificationVolume === "function") {
          try {
            WandNative.setNotificationVolume(state.notifVolume);
          } catch (_e) {
          }
        }
      });
      notifVolumeEl.addEventListener("change", function() {
        _doPlaySound();
      });
    }
    var notifBubbleEl = document.getElementById("cfg-notif-bubble");
    if (notifBubbleEl) {
      notifBubbleEl.checked = state.notifBubble;
      notifBubbleEl.addEventListener("change", function() {
        state.notifBubble = notifBubbleEl.checked;
        try {
          localStorage.setItem("wand-notif-bubble", String(state.notifBubble));
        } catch (e) {
        }
      });
    }
    var notifRequestBtn = document.getElementById("notification-request-btn");
    if (notifRequestBtn) notifRequestBtn.addEventListener("click", function() {
      if (_hasNativeBridge) {
        window._onNativePermissionResult = function() {
          updateNotificationStatus();
          delete window._onNativePermissionResult;
        };
        try {
          WandNative.requestPermission();
        } catch (_e) {
        }
      } else if (typeof Notification !== "undefined") {
        Notification.requestPermission().then(function() {
          updateNotificationStatus();
        });
      }
    });
    var notifResetBtn = document.getElementById("notification-reset-btn");
    if (notifResetBtn) notifResetBtn.addEventListener("click", resetNotificationPermission);
    var notifTestBtn = document.getElementById("notification-test-btn");
    if (notifTestBtn) notifTestBtn.addEventListener("click", testNotification);
    var notifTestDelayBtn = document.getElementById("notification-test-delay-btn");
    if (notifTestDelayBtn) notifTestDelayBtn.addEventListener("click", scheduleTestNotification);
    updateNotificationStatus();
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
            try {
              WandNative.setNotificationSound(nativeSoundSelect.value);
            } catch (_e) {
            }
          });
          if (nativeSoundPreview) {
            nativeSoundPreview.addEventListener("click", function() {
              try {
                WandNative.previewSound(nativeSoundSelect.value);
              } catch (_e) {
              }
            });
          }
        } catch (_e) {
        }
      }
    }
    if (_hasNativeBridge && typeof WandNative.isHapticEnabled === "function") {
      var hapticSection = document.getElementById("native-haptic-section");
      var hapticToggle = document.getElementById("cfg-haptic-enabled");
      if (hapticSection && hapticToggle) {
        hapticSection.classList.remove("hidden");
        try {
          hapticToggle.checked = WandNative.isHapticEnabled();
        } catch (_e) {
        }
        hapticToggle.addEventListener("change", function() {
          try {
            WandNative.setHapticEnabled(hapticToggle.checked);
          } catch (_e) {
          }
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
    var sendBtn = document.getElementById("send-input-button");
    if (sendBtn) sendBtn.addEventListener("click", function() {
      dismissDrawerIfOverlay();
      sendOrStart();
    });
    var stopBtn = document.getElementById("stop-button");
    if (stopBtn) stopBtn.addEventListener("click", stopSession);
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
        if (state.terminalComposing) return;
        if (handleInteractiveTextInput(inputBox)) {
          return;
        }
        refreshInputBoxState(inputBox);
        setDraftValue(inputBox.value, true);
        syncComposerHasText(inputBox);
      });
      inputBox.addEventListener("compositionstart", function() {
        if (state.terminalInteractive) state.terminalComposing = true;
      });
      inputBox.addEventListener("compositionend", function() {
        if (!state.terminalComposing) return;
        state.terminalComposing = false;
        if (state.terminalInteractive) handleInteractiveTextInput(inputBox);
      });
      inputBox.addEventListener("focus", function() {
        dismissDrawerIfOverlay();
        handleInputBoxFocus({ target: inputBox });
      });
      inputBox.addEventListener("blur", handleInputBoxBlur2);
    }
    var attachBtn = document.getElementById("attach-btn");
    var fileInput = document.getElementById("file-upload-input");
    var plusPopover = document.getElementById("composer-plus-popover");
    var plusAttachItem = document.getElementById("plus-attach-item");
    if (attachBtn && plusPopover) {
      attachBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        togglePlusPopover();
      });
    }
    if (plusAttachItem && fileInput) {
      plusAttachItem.addEventListener("click", function() {
        closePlusPopover();
        fileInput.click();
      });
    }
    if (fileInput) {
      fileInput.addEventListener("change", function() {
        var files = fileInput.files;
        if (files) {
          for (var i = 0; i < files.length; i++) addPendingAttachment(files[i]);
        }
        fileInput.value = "";
      });
    }
    var voiceHoldInput = document.getElementById("input-box");
    if (voiceHoldInput) {
      voiceHoldInput.addEventListener("pointerdown", beginComposerVoiceHold);
      voiceHoldInput.addEventListener("pointermove", handleComposerVoiceMove);
      voiceHoldInput.addEventListener("pointerup", endComposerVoiceHold);
      voiceHoldInput.addEventListener("pointercancel", cancelComposerVoiceHold);
    }
    var promptOptimizeBtn = document.getElementById("prompt-optimize-btn");
    if (promptOptimizeBtn) {
      promptOptimizeBtn.addEventListener("click", function() {
        optimizePromptText();
      });
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
    var terminalInteractiveToggles = ["terminal-interactive-toggle-top"];
    terminalInteractiveToggles.forEach(function(id) {
      var toggle = document.getElementById(id);
      if (toggle) toggle.addEventListener("click", toggleTerminalInteractive);
    });
    var filePanelToggle = document.getElementById("file-panel-toggle-btn");
    if (filePanelToggle) filePanelToggle.addEventListener("click", toggleFilePanel);
    var filePanelClose = document.getElementById("file-side-panel-close");
    if (filePanelClose) filePanelClose.addEventListener("click", closeFilePanel);
    var filePanelBackdrop = document.getElementById("file-panel-backdrop");
    if (filePanelBackdrop) filePanelBackdrop.addEventListener("click", closeFilePanel);
    var topbarFileBtn = document.getElementById("topbar-file-button");
    if (topbarFileBtn) topbarFileBtn.addEventListener("click", toggleFilePanel);
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
        state.topbarMoreOpen = false;
        topbarMoreMenu.classList.add("hidden");
        topbarMoreBtn.classList.remove("active");
        topbarMoreBtn.setAttribute("aria-expanded", "false");
        switch (action) {
          case "copy-claude-session-id":
            var copyProvider = getSelectedSession3() && getSelectedSession3().provider;
            copySelectedSessionField("claudeSessionId", copyProvider === "codex" ? "Codex thread ID \u5DF2\u590D\u5236" : copyProvider === "opencode" ? "OpenCode session ID \u5DF2\u590D\u5236" : "Claude \u4F1A\u8BDD ID \u5DF2\u590D\u5236");
            break;
          case "copy-cwd":
            copySelectedSessionField("cwd", "\u5DE5\u4F5C\u76EE\u5F55\u5DF2\u590D\u5236");
            break;
          case "copy-session-id":
            copySelectedSessionField("id", "\u4F1A\u8BDD ID \u5DF2\u590D\u5236");
            break;
          case "worktree-merge":
            if (state.selectedId) openWorktreeMergeModal(state.selectedId);
            break;
          case "worktree-cleanup":
            if (state.selectedId) retryWorktreeCleanup(state.selectedId);
            break;
          case "delete-session":
            if (state.selectedId) {
              (function(pendingId) {
                confirmDelete("\u786E\u5B9A\u8981\u5220\u9664\u5F53\u524D\u4F1A\u8BDD\u5417\uFF1F\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002", { title: "\u5220\u9664\u5F53\u524D\u4F1A\u8BDD" }).then(function(ok) {
                  if (ok) deleteSession(pendingId);
                });
              })(state.selectedId);
            }
            break;
        }
      });
    }
    var scaleDownBtn = document.getElementById("terminal-scale-down-top");
    var scaleUpBtn = document.getElementById("terminal-scale-up-top");
    if (scaleDownBtn) scaleDownBtn.addEventListener("click", function() {
      adjustTerminalScale(-0.25);
    });
    if (scaleUpBtn) scaleUpBtn.addEventListener("click", function() {
      adjustTerminalScale(0.25);
    });
    var pageRefreshBtn = document.getElementById("page-refresh-btn");
    if (pageRefreshBtn) pageRefreshBtn.addEventListener("click", function(ev) {
      if (ev && ev.shiftKey) {
        location.reload();
        return;
      }
      softResyncTerminal2();
      resetChatRenderCache2({ preserveStickState: true });
      scheduleChatRender3(true);
    });
    var jumpBottomBtn = document.getElementById("terminal-jump-bottom");
    if (jumpBottomBtn) jumpBottomBtn.addEventListener("click", function() {
      maybeScrollTerminalToBottom("force");
    });
    var chatUnreadBubble = document.getElementById("chat-unread-bubble");
    if (chatUnreadBubble) chatUnreadBubble.addEventListener("click", function() {
      scrollChatToBottom(true);
    });
    var fileRefresh = document.getElementById("file-explorer-refresh");
    if (fileRefresh) fileRefresh.addEventListener("click", function() {
      refreshFileExplorer();
    });
    var fileUp = document.getElementById("file-explorer-up");
    if (fileUp) fileUp.addEventListener("click", navigateExplorerUp);
    var fileCwdInput = document.getElementById("file-explorer-cwd");
    if (fileCwdInput && fileCwdInput.tagName === "INPUT") {
      var lastCommittedCwd = fileCwdInput.value;
      var normalizeCwdInput = function(raw) {
        var s = (raw || "").trim();
        if (!s) return "";
        s = s.replace(/\/{2,}/g, "/");
        if (s.length > 1) s = s.replace(/\/+$/, "");
        return s;
      };
      fileCwdInput.addEventListener("focus", function() {
        lastCommittedCwd = fileCwdInput.value;
        setTimeout(function() {
          try {
            fileCwdInput.select();
          } catch (e) {
          }
        }, 0);
      });
      fileCwdInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var next = normalizeCwdInput(fileCwdInput.value);
          if (!next) return;
          lastCommittedCwd = next;
          fileCwdInput.value = next;
          refreshFileExplorer({ cwd: next });
          fileCwdInput.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          fileCwdInput.value = lastCommittedCwd;
          fileCwdInput.blur();
        }
      });
      fileCwdInput.addEventListener("blur", function() {
        var next = normalizeCwdInput(fileCwdInput.value);
        if (!next) {
          fileCwdInput.value = lastCommittedCwd;
          return;
        }
        if (next === lastCommittedCwd) {
          fileCwdInput.value = next;
          return;
        }
        lastCommittedCwd = next;
        fileCwdInput.value = next;
        refreshFileExplorer({ cwd: next });
      });
    }
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
    var folderPickerInput = document.getElementById("folder-picker-input");
    var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
    var folderPickerDebounceTimer = null;
    var selectedIndex = -1;
    var folderItems = [];
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
    function renderRecentPathsHtml(items) {
      if (!items.length) return "";
      var html = '<div class="folder-recent-section"><div class="folder-recent-title">\u6700\u8FD1\u4F7F\u7528</div>';
      items.forEach(function(item) {
        var p = item.path || item;
        html += '<div class="folder-recent-item" data-path="' + escapeHtml2(p) + '">' + renderTailMarqueePath(p, "folder-recent-item-path") + "</div>";
      });
      html += "</div>";
      return html;
    }
    function showRecentPathsDropdown() {
      if (!folderPickerDropdown) return;
      fetchRecentPaths(function(items) {
        var recentHtml = renderRecentPathsHtml(items);
        if (recentHtml) {
          folderPickerDropdown.innerHTML = recentHtml;
          folderPickerDropdown.classList.remove("hidden");
          refreshTailMarqueePaths(folderPickerDropdown);
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
    var workingDirIndicator = document.getElementById("working-dir-indicator");
    if (workingDirIndicator) {
      workingDirIndicator.addEventListener("click", function() {
        state.selectedId = null;
        persistSelectedId();
        state.drafts = {};
        render8();
        setTimeout(function() {
          var folderInput = document.getElementById("folder-picker-input");
          if (folderInput) folderInput.focus();
        }, 50);
      });
    }
    var folderPickerToggle = document.getElementById("folder-picker-toggle");
    var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
    if (folderPickerToggle && folderPickerDropdown) {
      folderPickerToggle.addEventListener("click", function() {
        folderPickerDropdown.classList.toggle("hidden");
        folderPickerToggle.classList.toggle("open");
      });
    }
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
      var initialPath = getEffectiveCwd3();
      loadFolderSuggestions(initialPath);
      folderPickerInput.addEventListener("focus", function() {
        var path = this.value.trim();
        if (path) {
          loadFolderSuggestions(path);
        } else {
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
    }
    function updateSelectedIndex() {
      folderItems.forEach(function(item, index) {
        item.classList.toggle("active", index === selectedIndex);
      });
    }
    function renderBreadcrumb(_path) {
    }
    function loadFolderSuggestions(query) {
      if (!folderPickerDropdown) return;
      folderPickerDropdown.innerHTML = '<div class="folder-picker-loading">\u52A0\u8F7D\u4E2D...</div>';
      folderPickerDropdown.classList.remove("hidden");
      selectedIndex = -1;
      folderItems = [];
      fetch("/api/folders?q=" + encodeURIComponent(query), { credentials: "same-origin" }).then(function(res) {
        return res.json().then(function(data) {
          return { ok: res.ok, status: res.status, data };
        });
      }).then(function(result) {
        var data = result.data;
        if (!result.ok || data.error) {
          showValidationError(data.error || "\u8DEF\u5F84\u65E0\u6548");
          folderPickerDropdown.innerHTML = '<div class="folder-picker-error">' + escapeHtml2(data.error || "\u8DEF\u5F84\u65E0\u6548") + "</div>";
          return;
        }
        clearValidationError();
        renderBreadcrumb(data.currentPath || query);
        var items = data.items || [];
        var currentPath = data.currentPath || query;
        if (items.length === 0) {
          folderPickerDropdown.innerHTML = '<div class="folder-picker-loading">\u7A7A\u76EE\u5F55</div>';
          return;
        }
        folderPickerDropdown.innerHTML = items.map(function(item) {
          var icon = item.type === "parent" ? "\u21A9\uFE0F" : "\u{1F4C1}";
          var name = item.type === "parent" ? ".. (\u8FD4\u56DE\u4E0A\u7EA7)" : item.name;
          return '<div class="folder-picker-item" data-path="' + escapeHtml2(item.path) + '" data-type="' + item.type + '"><span class="folder-picker-item-icon">' + icon + "</span><span>" + escapeHtml2(name) + "</span></div>";
        }).join("");
        folderItems = Array.from(folderPickerDropdown.querySelectorAll(".folder-picker-item"));
        folderItems.forEach(function(item) {
          item.addEventListener("click", function() {
            var selectedPath = this.dataset.path;
            var type = this.dataset.type;
            if (folderPickerInput) {
              if (type === "parent") {
                var currentPath2 = folderPickerInput.value.trim();
                var parentPath = currentPath2.substring(0, currentPath2.lastIndexOf("/"));
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
      }).catch(function(err) {
        showValidationError("\u52A0\u8F7D\u5931\u8D25");
        folderPickerDropdown.innerHTML = '<div class="folder-picker-error">\u52A0\u8F7D\u5931\u8D25</div>';
      });
    }
    function hideFolderDropdown() {
      if (folderPickerDropdown) {
        folderPickerDropdown.classList.add("hidden");
      }
      selectedIndex = -1;
      folderItems = [];
    }
    var folderPickerModal = document.getElementById("folder-picker-modal");
    var closeFolderPicker = document.getElementById("close-folder-picker");
    function openFolderPickerWithInitialPath() {
      if (!folderPickerModal) return;
      folderPickerModal.classList.remove("hidden");
      if (folderPickerInput) {
        folderPickerInput.value = getEffectiveCwd3();
      }
      var initialPath2 = getEffectiveCwd3();
      loadFolderSuggestions(initialPath2);
      renderBreadcrumb(initialPath2);
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
    initTerminal2();
    setupMobileKeyboardHandlers();
    setupVisualViewportHandlers();
    attachQueueBarDelegates();
    updateQueueBar();
  }

  // src/web-ui/browser/render.ts
  function resetChatRenderCache2(options) {
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
      state.chatStickToBottom = true;
      state.chatUnreadCount = 0;
      state.chatUnreadStartIndex = -1;
      state.chatInitialRenderDone = false;
    }
  }
  function getEffectiveCwd3() {
    return state.workingDir || getConfigCwd();
  }
  window.addEventListener("online", function() {
    state.isOnline = true;
    updateOfflineBanner();
  });
  window.addEventListener("offline", function() {
    state.isOnline = false;
    updateOfflineBanner();
  });
  function updateOfflineBanner() {
    var banner = document.getElementById("offline-banner");
    if (!state.isOnline && !banner) {
      var el = document.createElement("div");
      el.id = "offline-banner";
      el.className = "offline-banner";
      el.textContent = "You are offline - some features may be limited";
      document.body.appendChild(el);
    } else if (state.isOnline && banner) {
      banner.remove();
    }
  }
  function renderBootLoading() {
    var app = document.getElementById("app");
    if (!app) return;
    app.innerHTML = '<div class="boot-loading"><div class="boot-loading-card"><div class="boot-loading-spinner"></div><div class="boot-loading-text">\u6B63\u5728\u8FDE\u63A5 Wand\u2026</div></div></div>';
  }
  function scheduleForegroundSync(reason, opts) {
    if (!state.config) return;
    if (document.hidden) return;
    var immediate = opts && opts.immediate === true;
    var now = Date.now();
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
    evaluateWsHeartbeatStale2();
    if (force) {
      forceReconnectWebSocket("resume-force");
    } else if (!state.ws || state.ws.readyState !== WebSocket.OPEN && state.ws.readyState !== WebSocket.CONNECTING) {
      initWebSocket();
    }
    if (state.claudeHistoryLoaded) {
      loadClaudeHistory();
    }
    if (state.codexHistoryLoaded) {
      loadCodexHistory();
    }
    return loadSessions({ skipSelectedOutputReload: true }).catch(function(e) {
      console.error("[wand] foreground sync failed:", reason, e);
    });
  }
  function bindForegroundSyncListeners() {
    if (window.__wandForegroundSyncBound) return;
    window.__wandForegroundSyncBound = true;
    document.addEventListener("visibilitychange", function() {
      if (document.hidden) {
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
    window.addEventListener("wand-android-resume", function() {
      scheduleForegroundSync("android-resume", { immediate: true });
      ensureTerminalFitWithRetry("android-resume");
    });
    window.addEventListener("wand-ime-state", function(e) {
      var which = e && e.detail && e.detail.state;
      if (which === "shown" || which === "hidden") {
        try {
          ensureTerminalFit2("native-ime-" + which, { forceReplay: true });
          maybeScrollTerminalToBottom("native-ime");
        } catch (_e) {
        }
      }
    });
    window.addEventListener("wand-android-network", function(e) {
      var which = e && e.detail && e.detail.state;
      if (which === "lost") {
        state.isOnline = false;
        try {
          updateOfflineBanner();
        } catch (_e) {
        }
        return;
      }
      if (which === "available" || which === "changed" || which === "validated") {
        state.isOnline = true;
        try {
          updateOfflineBanner();
        } catch (_e) {
        }
        forceReconnectWebSocket("android-network-" + which);
      }
    });
  }
  function restoreLoginSession2() {
    fetch("/api/session-check", { credentials: "same-origin" }).then(function(res) {
      return res.ok ? res.json() : { authed: false };
    }).then(function(info) {
      if (!info || !info.authed) {
        state.loginChecked = true;
        render8();
        return null;
      }
      return fetch("/api/config", { credentials: "same-origin" }).then(function(res) {
        if (!res.ok) {
          state.loginChecked = true;
          render8();
          return null;
        }
        return res.json();
      });
    }).then(function(config) {
      if (!config) return;
      state.config = config;
      state.loginChecked = true;
      requestAnimationFrame(function() {
        try {
          render8({ skipShellChrome: true });
        } catch (_e) {
        }
        bindForegroundSyncListeners();
        startPolling();
        refreshAll();
        fetchAvailableModels();
        requestNotificationPermission();
        if (config.updateAvailable && config.latestVersion) {
          notifyUpdateAvailable(config.currentVersion || "-", config.latestVersion);
        }
        if (_apkVersion) {
          checkApkAutoUpdate();
        }
        if (_macAppVersion) {
          checkDmgAutoUpdate();
        }
        if (!state.claudeHistoryLoaded) {
          setTimeout(function() {
            if (!state.claudeHistoryLoaded) ensureClaudeHistoryLoaded();
          }, 600);
        }
      });
    }).catch(function() {
      state.loginChecked = true;
      if (!navigator.onLine) {
        var app = document.getElementById("app");
        if (app) {
          app.innerHTML = '<div class="boot-loading"><div class="boot-loading-card"><div class="boot-loading-text" style="font-size:1.3em;margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:8px">' + iconSvg("signal", { size: 20, strokeWidth: 1.8 }) + '<span>\u65E0\u6CD5\u8FDE\u63A5\u5230\u670D\u52A1\u5668</span></div><div class="boot-loading-text" style="opacity:0.7;font-size:0.95em">\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u6216\u786E\u8BA4 Wand \u670D\u52A1\u6B63\u5728\u8FD0\u884C\u3002</div><button onclick="location.reload()" style="margin-top:18px;padding:8px 24px;border-radius:8px;border:1px solid rgba(150,118,85,0.3);background:rgba(255,255,255,0.8);cursor:pointer;font-size:0.95em">\u91CD\u8BD5</button></div></div>';
        }
        window.addEventListener("online", function() {
          location.reload();
        }, { once: true });
        return;
      }
      render8();
    });
  }
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
      ".modal-backdrop, .modal-overlay, .modal-container, [role='dialog'], [role='menu'], .topbar-more-menu, .sidebar-header-overflow, .folder-picker-dropdown, .path-suggestions, .permission-prompt-overlay, .restart-overlay"
    )) return;
    closeTransientSessionsDrawer();
  }, true);
  renderBootLoading();
  restoreLoginSession2();
  function render8(options) {
    var skipShellChrome = options && options.skipShellChrome;
    var app = document.getElementById("app");
    var isLoggedIn = state.config !== null;
    var wasModalOpen = state.modalOpen;
    var shouldResetShell = !isLoggedIn || !!document.getElementById("output");
    if (shouldResetShell) {
      teardownTerminal();
    }
    document.documentElement.classList.add("no-transition");
    if (state.sidebarPinned && !state.sidebarCollapsed && !isMobileLayout()) {
      state.sessionsDrawerOpen = true;
      writeStoredBoolean("wand-sidebar-open", true);
    }
    app.innerHTML = isLoggedIn ? renderAppShell() : renderLogin();
    resetChatRenderCache2();
    attachEventListeners();
    updateDrawerState();
    syncComposerModeSelect();
    syncComposerModelSelect(getSelectedSession3());
    applyCurrentView();
    if (!skipShellChrome) {
      updateShellChrome();
    }
    if (isLoggedIn && state.filePanelOpen) {
      refreshFileExplorer();
    }
    void document.body.offsetHeight;
    requestAnimationFrame(function() {
      document.documentElement.classList.remove("no-transition");
    });
    if (wasModalOpen && state.modalOpen) {
      var modal = document.getElementById("session-modal");
      if (modal) {
        modal.classList.remove("hidden");
        var cwdEl = document.getElementById("cwd");
        if (cwdEl) cwdEl.value = state.cwdValue;
        syncSessionModalUI();
      }
    }
    if (isLoggedIn && state.selectedId && state.gitStatusSessionId !== state.selectedId) {
      loadGitStatus(state.selectedId);
    }
    if (isLoggedIn) {
      var __sel = state.sessions.find(function(s) {
        return s.id === state.selectedId;
      });
      updateRunningIndicators(__sel);
    }
    scrollPathElementToEnd(document.getElementById("topbar-cwd"));
    scrollPathElementToEnd(document.getElementById("blank-chat-cwd-path"));
    scrollPathElementToEnd(document.getElementById("working-dir-indicator-path"));
    refreshTailMarqueePaths();
  }
  function renderApprovalStatsBadge() {
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var stats = selectedSession && selectedSession.approvalStats;
    if (!stats || stats.total === 0) return '<span class="approval-stats hidden" id="approval-stats"></span>';
    return '<span class="approval-stats" id="approval-stats"><span class="approval-stats-divider"></span><span class="approval-stats-badge" id="approval-stats-badge" title="\u672C\u6B21\u4F1A\u8BDD\u81EA\u52A8\u6279\u51C6\u7EDF\u8BA1"><svg class="approval-stats-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span class="approval-stats-total">' + stats.total + '</span></span><span class="approval-stats-popup" id="approval-stats-popup"><span class="approval-stats-popup-title">\u81EA\u52A8\u6279\u51C6\u7EDF\u8BA1</span>' + (stats.command > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("terminal", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u547D\u4EE4\u6267\u884C</span><span class="approval-stats-row-count">' + stats.command + "</span></span>" : "") + (stats.file > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("edit", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u6587\u4EF6\u5199\u5165</span><span class="approval-stats-row-count">' + stats.file + "</span></span>" : "") + (stats.tool > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("wrench", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u5176\u4ED6\u5DE5\u5177</span><span class="approval-stats-row-count">' + stats.tool + "</span></span>" : "") + '<span class="approval-stats-row approval-stats-row-total"><span class="approval-stats-row-icon">' + iconSvg("sigma", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">\u5408\u8BA1</span><span class="approval-stats-row-count">' + stats.total + "</span></span></span></span>";
  }
  function renderLogin() {
    if (!state.loginChecked) {
      return '<div class="login-container"><div class="login-card login-card-loading"><div class="login-header"><div class="login-logo"><div class="login-logo-icon">W</div><span class="login-logo-text">Wand</span></div><div class="login-subtitle">\u6B63\u5728\u6062\u590D\u767B\u5F55\u72B6\u6001</div></div><div class="login-body"><div class="login-status"><span class="login-spinner" aria-hidden="true"></span><div><p class="login-hint">\u6B63\u5728\u68C0\u67E5\u672C\u5730\u767B\u5F55\u4F1A\u8BDD\uFF0C\u8BF7\u7A0D\u5019\u3002</p><p class="login-muted">\u5982\u679C\u4F60\u521A\u5237\u65B0\u9875\u9762\uFF0C\u8FD9\u662F\u6B63\u5E38\u73B0\u8C61\u3002</p></div></div></div></div></div>';
    }
    return '<div class="login-container"><div class="login-card"><div class="login-header"><div class="login-logo"><div class="login-logo-icon">W</div><span class="login-logo-text">Wand</span></div><div class="login-subtitle">\u5728\u6D4F\u89C8\u5668\u4E2D\u8FD0\u884C\u672C\u673A\u7EC8\u7AEF</div></div><form id="login-form" class="login-body" autocomplete="on"><input type="text" name="username" autocomplete="username" value="wand" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none" readonly /><p class="login-hint">\u8F93\u5165 Wand \u8BBF\u95EE\u5BC6\u7801\u4EE5\u8FDB\u5165\u63A7\u5236\u53F0\u3002</p><div class="field"><label class="field-label" for="password">\u5BC6\u7801</label><div class="password-field"><input id="password" type="password" class="field-input password-input" placeholder="\u8F93\u5165\u8BBF\u95EE\u5BC6\u7801" autocomplete="current-password" data-error="false" aria-describedby="password-hint login-error" aria-invalid="false" /><button id="toggle-password-button" type="button" class="password-toggle" aria-label="\u663E\u793A\u5BC6\u7801" aria-pressed="false">\u663E\u793A</button></div><p id="password-hint" class="hint">\u4F7F\u7528\u4F60\u5728 Wand \u4E2D\u8BBE\u7F6E\u7684\u8BBF\u95EE\u5BC6\u7801\u3002</p><p id="login-error" class="error-message hidden" role="alert"></p></div><div id="login-cert-hint" class="login-cert-hint hidden" role="alert"><div class="login-cert-hint-title">\u8BC1\u4E66\u4E0D\u53D7\u4FE1\u4EFB\uFF0C\u767B\u5F55\u6001\u65E0\u6CD5\u4FDD\u5B58</div><p class="login-cert-hint-body">\u5BC6\u7801\u662F\u5BF9\u7684\uFF0C\u4F46\u5F53\u524D HTTPS \u8BC1\u4E66\u4E0D\u53D7\u6D4F\u89C8\u5668\u4FE1\u4EFB\uFF0C\u6D4F\u89C8\u5668\u56E0\u6B64\u62D2\u7EDD\u4FDD\u5B58\u767B\u5F55 Cookie\uFF0C\u6240\u4EE5\u8FDB\u4E0D\u4E86\u63A7\u5236\u53F0\u3002<br/>\u89E3\u51B3\u529E\u6CD5\uFF08\u4EFB\u9009\u5176\u4E00\uFF09\uFF1A\u6539\u7528 HTTP \u8BBF\u95EE\u672C\u670D\u52A1\uFF1B\u6216\u628A\u672C\u670D\u52A1\u8BC1\u4E66\u8BBE\u4E3A\u300C\u53D7\u4FE1\u4EFB\u300D\uFF08\u63A8\u8350 mkcert\uFF09\uFF1B\u6216\u5728\u672C\u673A\u5C06\u8BE5\u81EA\u7B7E\u8BC1\u4E66\u8BBE\u4E3A\u5B8C\u5168\u4FE1\u4EFB\u540E\u91CD\u8BD5\u3002</p><a id="login-cert-http-link" class="btn btn-ghost btn-block" href="#" rel="noopener">\u6539\u7528 HTTP \u8BBF\u95EE</a></div><button id="login-button" type="submit" class="btn btn-primary btn-block">\u8FDB\u5165\u63A7\u5236\u53F0</button>' + (hasNativeSwitchServer() ? '<button id="login-switch-server-button" class="btn btn-ghost btn-block login-switch-server" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg><span>\u5207\u6362\u670D\u52A1\u5668</span></button>' : "") + "</form></div></div>";
  }
  function renderAppShell() {
    var scriptClose = String.fromCharCode(60) + String.fromCharCode(47) + "script>";
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "\u672A\u9009\u62E9\u4F1A\u8BDD";
    var terminalInfo = selectedSession ? selectedSession.mode + " | " + selectedSession.status : "\u70B9\u51FB\u4E0A\u65B9\u300C\u65B0\u5BF9\u8BDD\u300D\u5F00\u59CB";
    var currentDraft = state.selectedId ? state.drafts[state.selectedId] || "" : "";
    var drawerClass = state.sessionsDrawerOpen ? " open" : "";
    var backdropClass = shouldShowSessionsBackdrop() ? " open" : "";
    var preferredTool = getComposerTool();
    var composerMode = getSafeModeForTool(preferredTool, state.chatMode);
    var isMobile = isMobileLayout();
    var isCollapsed = !!state.sidebarPinned && !!state.sidebarCollapsed;
    var isAnchored = isCollapsed || !isMobile && (!!state.sidebarPinned || !!state.sessionsDrawerOpen);
    var collapsedCls = isCollapsed ? " sidebar-collapsed" : "";
    var sidebarCollapsedCls = isCollapsed ? " collapsed" : "";
    return '<div class="app-container"><div id="sessions-drawer-backdrop" class="drawer-backdrop' + backdropClass + '"></div><div class="main-layout' + (state.sessionsDrawerOpen ? " sidebar-open" : "") + (isAnchored ? " sidebar-pinned" : "") + collapsedCls + '"><aside id="sessions-drawer" class="sidebar' + drawerClass + (isAnchored ? " pinned" : "") + sidebarCollapsedCls + '"><div class="sidebar-header"><div class="sidebar-header-main"><div class="topbar-logo-icon">W</div><span class="sidebar-title">\u4F1A\u8BDD</span><span class="session-count" id="session-count">' + String(state.sessions.filter(function(session) {
      var source = String(session && session.sessionSource || "").toLowerCase();
      return source !== "automation" && source !== "startup";
    }).length) + '</span></div><div class="sidebar-header-actions"><div class="sidebar-header-more"><button id="sidebar-more-btn" class="btn btn-ghost btn-sm" type="button" title="\u66F4\u591A\u64CD\u4F5C"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button><div class="sidebar-header-overflow" id="sidebar-overflow-menu"><button class="overflow-item" id="sidebar-home-btn" type="button"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg><span>\u56DE\u5230\u9996\u9875</span></button><button class="overflow-item" id="sidebar-refresh-btn" type="button"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>\u5237\u65B0\u9875\u9762</span></button></div></div><button id="sidebar-pin-btn" class="btn btn-ghost btn-sm sidebar-pin-toggle' + (state.sidebarPinned ? " pinned" : "") + '" type="button" title="' + (state.sidebarPinned ? "\u5DF2\u56FA\u5B9A\u5E38\u9A7B\uFF08\u70B9\u51FB\u89E3\u9664\u9501\u5B9A\uFF09" : "\u56FA\u5B9A\u4FA7\u680F\u5E38\u9A7B") + '" aria-label="' + (state.sidebarPinned ? "\u89E3\u9664\u56FA\u5B9A\u5E38\u9A7B" : "\u56FA\u5B9A\u4FA7\u680F\u5E38\u9A7B") + '" aria-pressed="' + (state.sidebarPinned ? "true" : "false") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg></button><button id="sidebar-collapse-btn" class="btn btn-ghost btn-sm sidebar-collapse-toggle' + (isCollapsed ? " collapsed" : "") + '" type="button" title="' + (isCollapsed ? "\u5C55\u5F00\u4E3A\u5168\u5C3A\u5BF8" : "\u6536\u8D77\u4E3A\u7A84\u6761") + '" aria-label="' + (isCollapsed ? "\u5C55\u5F00\u4E3A\u5168\u5C3A\u5BF8" : "\u6536\u8D77\u4E3A\u7A84\u6761") + '">' + (isCollapsed ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 6 16 12 10 18"/><line x1="20" y1="5" x2="20" y2="19"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="14 6 8 12 14 18"/><line x1="4" y1="5" x2="4" y2="19"/></svg>') + '</button><button id="close-drawer-button" class="btn btn-ghost btn-icon sidebar-close drawer-close-btn" type="button" aria-label="\u5173\u95ED\u83DC\u5355"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div></div><div class="sidebar-body"><div id="sessions-panel"><div class="sessions-list" id="sessions-list">' + renderSessionsListContent() + '</div></div></div><div class="sidebar-footer"><button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> \u65B0\u4F1A\u8BDD</button><div class="sidebar-footer-actions"><button id="file-panel-toggle-btn" class="btn btn-ghost btn-sm' + (state.filePanelOpen ? " active" : "") + '" type="button" title="\u67E5\u770B\u6587\u4EF6"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>\u6587\u4EF6</span></button><button id="settings-button" class="btn btn-ghost btn-sm" type="button" title="\u8BBE\u7F6E"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>\u8BBE\u7F6E</span></button>' + (hasNativeBackToApp() ? '<button id="back-to-native-button" class="btn btn-ghost btn-sm sidebar-back-to-native" type="button" title="\u8FD4\u56DE App \u539F\u751F\u754C\u9762"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="3" width="11" height="18" rx="2"/><line x1="14" y1="17" x2="17" y2="17"/><polyline points="7 8 3 12 7 16"/></svg><span>\u8FD4\u56DEApp</span></button>' : "") + (hasNativeSwitchServer() ? '<button id="switch-server-button" class="btn btn-ghost btn-sm sidebar-switch-server" type="button" title="\u5207\u6362\u670D\u52A1\u5668"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg><span>\u5207\u6362</span></button>' : "") + '<button id="logout-button" class="btn btn-ghost btn-sm sidebar-logout" type="button" title="\u9000\u51FA\u767B\u5F55"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>\u9000\u51FA</span></button></div></div></aside><main class="main-content"><div class="main-header-row"><div class="topbar-left"><button id="sessions-toggle-button" class="floating-sidebar-toggle' + (state.sessionsDrawerOpen ? " active" : "") + '" aria-label="\u5207\u6362\u4F1A\u8BDD\u4FA7\u680F" type="button"><span class="hamburger-icon"><span></span><span></span><span></span></span></button><span class="topbar-brand" aria-hidden="true">W</span></div><div class="topbar-center">' + (selectedSession ? '<span class="topbar-session-title" title="' + escapeHtml2(selectedSession.description || selectedSession.command || "") + '">' + escapeHtml2(selectedSession.title || shortCommand(selectedSession.command)) + '</span><span class="session-status-pill ' + getSessionStatusClass(selectedSession) + '" title="' + escapeHtml2(getSessionStatusLabel(selectedSession)) + '"><span class="session-status-dot"></span><span class="session-status-text">' + escapeHtml2(getSessionStatusLabel(selectedSession)) + '</span></span><span class="current-task hidden" id="current-task"></span>' + (selectedSession.cwd ? renderTailMarqueePath(selectedSession.cwd, "topbar-cwd", ' id="topbar-cwd" role="button" tabindex="0"') : "") : '<span class="topbar-tagline">Wand \u63A7\u5236\u53F0</span><span class="current-task hidden" id="current-task"></span>') + '</div><div class="topbar-right"><button id="topbar-file-button" class="topbar-btn square' + (state.filePanelOpen ? " active" : "") + '" type="button" aria-label="\u6587\u4EF6" title="\u67E5\u770B\u6587\u4EF6\uFF08\u53EF\u4FEE\u6539\u8DEF\u5F84\uFF09"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button><span id="topbar-git-slot" class="topbar-git-slot">' + renderTopbarGitBadgeHtml() + "</span>" + (selectedSession ? renderTopbarMoreMenuHtml(selectedSession) : "") + '</div></div><div id="file-panel-backdrop" class="file-panel-backdrop' + (state.filePanelOpen ? " open" : "") + '"></div><div id="file-side-panel" class="file-side-panel' + (state.filePanelOpen ? " open" : "") + '"><div class="file-side-panel-header"><div class="file-side-panel-title-group"><span class="file-side-panel-icon">' + wandFileIcon("folder-open", { size: 16 }) + '</span><span class="file-side-panel-title">\u6587\u4EF6</span></div><div class="file-side-panel-header-actions"><button class="file-side-panel-iconbtn" id="file-explorer-refresh" type="button" title="\u5237\u65B0" aria-label="\u5237\u65B0\u6587\u4EF6\u5217\u8868">' + wandFileIcon("refresh", { size: 15 }) + '</button><button id="file-side-panel-close" class="file-side-panel-iconbtn close" type="button" aria-label="\u5173\u95ED\u6587\u4EF6\u9762\u677F" title="\u5173\u95ED">' + wandFileIcon("x", { size: 16 }) + '</button></div></div><div class="file-side-panel-body"><div class="file-explorer-header"><button class="file-explorer-up" id="file-explorer-up" type="button" title="\u8FD4\u56DE\u4E0A\u7EA7\u76EE\u5F55" aria-label="\u8FD4\u56DE\u4E0A\u7EA7\u76EE\u5F55">' + wandFileIcon("arrow-up", { size: 15 }) + '</button><input type="text" class="file-explorer-path" id="file-explorer-cwd" value="' + escapeHtml2(selectedSession && selectedSession.cwd ? selectedSession.cwd : getConfigCwd()) + '" title="' + escapeHtml2(selectedSession && selectedSession.cwd ? selectedSession.cwd : getConfigCwd()) + '" placeholder="\u8F93\u5165\u8DEF\u5F84\u5E76\u56DE\u8F66..." spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="\u5F53\u524D\u8DEF\u5F84\uFF0C\u53EF\u76F4\u63A5\u4FEE\u6539\u540E\u56DE\u8F66" /></div><div class="file-search-box"><span class="file-search-icon">' + wandFileIcon("search", { size: 14 }) + '</span><input type="text" id="file-search-input" class="file-search-input" placeholder="\u641C\u7D22\u5F53\u524D\u76EE\u5F55\u2026" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" /><button class="file-search-clear" id="file-search-clear" type="button" aria-label="\u6E05\u9664\u641C\u7D22" title="\u6E05\u9664">' + wandFileIcon("x", { size: 13 }) + '</button></div><div class="file-explorer" id="file-explorer">' + renderFileExplorer(selectedSession && selectedSession.cwd ? selectedSession.cwd : getConfigCwd()) + '</div></div></div><div id="output" class="terminal-container' + (state.selectedId ? "" : " hidden") + ' active"><div class="terminal-scale-overlay" aria-label="\u7EC8\u7AEF\u7F29\u653E\u63A7\u4EF6"><button id="terminal-scale-down-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="\u7F29\u5C0F">\u2212</button><span class="terminal-scale-overlay-label terminal-scale-label" id="terminal-scale-label-top">' + Math.round(state.terminalScale * 100) + '%</span><button id="terminal-scale-up-top" class="terminal-scale-overlay-btn terminal-scale-btn" type="button" title="\u653E\u5927">+</button><span class="terminal-scale-overlay-divider"></span><button id="page-refresh-btn" class="terminal-scale-overlay-btn" type="button" title="\u5237\u65B0\u9875\u9762">\u21BB</button></div><button id="terminal-jump-bottom" class="terminal-jump-bottom' + (state.showTerminalJumpToBottom ? " visible" : "") + '" type="button" title="\u56DE\u5230\u5E95\u90E8" aria-label="\u56DE\u5230\u5E95\u90E8"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></button></div><div id="chat-output" class="chat-container hidden"><div id="chat-fold-bar" class="chat-fold-bar hidden" aria-live="polite"></div><button id="chat-unread-bubble" class="chat-unread-bubble" type="button" title="\u56DE\u5230\u6700\u65B0\u6D88\u606F" aria-label="\u56DE\u5230\u6700\u65B0\u6D88\u606F"><span class="chat-unread-bubble-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8l4.5 4.5L12.5 8"/></svg></span><span class="chat-unread-bubble-count" aria-hidden="true"></span></button></div><div id="blank-chat" class="blank-chat' + (state.selectedId ? " hidden" : "") + '"><div class="blank-chat-inner"><div class="blank-chat-logo">W</div><h2 class="blank-chat-title">Wand</h2><p class="blank-chat-subtitle">\u652F\u6301\u7EC8\u7AEF PTY \u4F1A\u8BDD\u4E0E\u7ED3\u6784\u5316 chat \u4F1A\u8BDD\uFF0C\u4E24\u79CD\u6A21\u5F0F\u53EF\u5E76\u5B58\u3002</p><div class="blank-chat-tools"><button class="blank-chat-tool-btn" id="welcome-tool-claude" type="button"><span class="tool-icon">' + iconSvg("terminal", { size: 16, strokeWidth: 1.8 }) + '</span>\u65B0\u5EFA\u7EC8\u7AEF\u4F1A\u8BDD</button><button class="blank-chat-tool-btn" id="welcome-tool-codex" type="button"><span class="tool-icon tool-icon-text">\u2318</span>\u65B0\u5EFA Codex \u4F1A\u8BDD</button><button class="blank-chat-tool-btn" id="welcome-tool-opencode" type="button"><span class="tool-icon tool-icon-text">OC</span>\u65B0\u5EFA OpenCode \u4F1A\u8BDD</button><button class="blank-chat-tool-btn" id="welcome-tool-structured" type="button"><span class="tool-icon">' + iconSvg("chat", { size: 16, strokeWidth: 1.8 }) + '</span>\u65B0\u5EFA\u7ED3\u6784\u5316\u4F1A\u8BDD</button></div><div class="blank-chat-cwd-wrap"><div class="blank-chat-cwd" id="blank-chat-cwd" role="button" tabindex="0" title="\u70B9\u51FB\u5207\u6362\u5DE5\u4F5C\u76EE\u5F55"><span class="blank-chat-cwd-icon">' + iconSvg("folder", { size: 13, strokeWidth: 1.8 }) + "</span>" + renderTailMarqueePath(getEffectiveCwd3(), "blank-chat-cwd-path", ' id="blank-chat-cwd-path"') + '<span class="blank-chat-cwd-arrow" id="blank-chat-cwd-arrow">' + iconSvg("chevronDown", { size: 11, strokeWidth: 2 }) + '</span></div><div class="blank-chat-cwd-dropdown hidden" id="blank-chat-cwd-dropdown"></div></div></div></div><div class="input-panel' + (state.selectedId ? "" : " hidden") + '"><div class="composer-top-row"><div id="todo-progress" class="todo-progress hidden"><div class="todo-progress-header" id="todo-progress-toggle"><div class="todo-progress-fill" id="todo-progress-fill" aria-hidden="true" style="--progress:0"></div><div class="todo-progress-left"><span class="todo-progress-ring" id="todo-progress-ring" aria-hidden="true" style="--progress:0"><svg width="16" height="16" viewBox="0 0 36 36"><circle class="todo-ring-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="4"/><circle class="todo-ring-fill" cx="18" cy="18" r="15.5" fill="none" stroke-width="4" stroke-linecap="round"/></svg></span><span class="todo-progress-counter" id="todo-progress-counter"></span></div><div class="todo-progress-task-wrap"><span class="todo-progress-task" id="todo-progress-task"></span></div><svg class="todo-progress-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg></div></div><div class="todo-progress-body hidden" id="todo-progress-body"><ul class="todo-progress-list" id="todo-progress-list"></ul></div></div><div id="queue-bar-host" class="queue-bar-host" hidden></div><div class="input-composer' + (currentDraft ? " has-text" : "") + '"><div class="composer-status-row" id="composer-status-row">' + renderAutoApproveChip(selectedSession) + '<span class="permission-actions hidden" id="permission-actions"><span class="permission-actions-label" id="permission-actions-label">\u7B49\u5F85\u6388\u6743</span><button id="approve-permission-btn" class="btn btn-permission btn-permission-approve" type="button">\u6279\u51C6</button><button id="deny-permission-btn" class="btn btn-permission btn-permission-deny" type="button">\u62D2\u7EDD</button></span>' + renderApprovalStatsBadge() + '</div><div class="composer-main-row"><div class="composer-actions-left"><button id="attach-btn" class="btn-circle btn-circle-action" type="button" title="\u66F4\u591A" aria-label="\u66F4\u591A" aria-haspopup="dialog" aria-expanded="false">' + iconSvg("plus", { size: 18, strokeWidth: 2.2 }) + '</button><input type="file" id="file-upload-input" multiple tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0);pointer-events:none"></div><div class="composer-inline-config">' + renderComposerConfigControlsHtml(selectedSession) + '</div><div class="composer-input-wrap"><textarea id="input-box" class="input-textarea" placeholder="' + getComposerPlaceholder(selectedSession, state.terminalInteractive) + '" rows="1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">' + escapeHtml2(currentDraft) + '</textarea><button id="prompt-optimize-btn" class="prompt-optimize-btn" type="button" title="\u63D0\u793A\u8BCD\u4F18\u5316\uFF08AI\uFF09" aria-label="\u63D0\u793A\u8BCD\u4F18\u5316"><svg class="prompt-optimize-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" fill="currentColor" opacity="0.25"/><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M19 14l.7 1.9L21.6 17l-1.9.7L19 19.6l-.7-1.9L16.4 17l1.9-.7z" fill="currentColor" opacity="0.35"/><path d="M5 4l.5 1.4L7 6l-1.5.6L5 8l-.5-1.4L3 6l1.5-.6z" fill="currentColor" opacity="0.35"/></svg><span class="prompt-optimize-spinner" aria-hidden="true"></span></button></div><div class="composer-actions-right"><button id="stop-button" class="btn-circle btn-circle-stop hidden" title="\u505C\u6B62"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg></button><button id="send-input-button" class="btn-circle btn-circle-send" title="\u53D1\u9001"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div></div><div id="attachment-preview" class="attachment-preview hidden"></div></div><div class="composer-plus-popover hidden" id="composer-plus-popover" role="dialog" aria-modal="false" aria-label="\u66F4\u591A\u64CD\u4F5C"><button class="plus-popover-item" id="plus-attach-item" type="button">' + iconSvg("paperclip", { size: 14, strokeWidth: 1.8, cls: "plus-popover-icon" }) + '<span class="plus-popover-label">\u4E0A\u4F20\u9644\u4EF6</span></button><button class="plus-popover-item' + (state.terminalInteractive ? " is-on" : "") + '" id="terminal-interactive-toggle-top" type="button" aria-pressed="' + (state.terminalInteractive ? "true" : "false") + '">' + iconSvg("keyboard", { size: 14, strokeWidth: 1.8, cls: "plus-popover-icon" }) + '<span class="plus-popover-label">\u7EC8\u7AEF\u4EA4\u4E92</span><span class="plus-popover-toggle-state">' + (state.terminalInteractive ? "\u5F00" : "\u5173") + '</span></button><div class="plus-popover-sep" aria-hidden="true"></div><div class="plus-popover-trio-wrap">' + renderComposerConfigControlsHtml(selectedSession) + '</div></div><div class="voice-transcript-bubble hidden" id="voice-transcript-bubble" aria-live="polite"><div class="voice-transcript-text" id="voice-transcript-text"></div><div class="voice-transcript-hint" id="voice-transcript-hint"><span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="voice-transcript-status" id="voice-transcript-status">\u6B63\u5728\u8046\u542C\u2026\u4E0A\u6ED1\u53D6\u6D88</span></div><span class="voice-bubble-arrow" aria-hidden="true"></span></div><p id="action-error" class="error-message hidden"></p></div><section id="folder-picker-modal" class="modal-backdrop hidden"><div class="modal folder-picker-modal"><div class="modal-header"><h2 class="modal-title">\u9009\u62E9\u5DE5\u4F5C\u76EE\u5F55</h2><button id="close-folder-picker" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="\u5173\u95ED"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div><div class="modal-body"><div class="folder-picker-quick-row"><button class="folder-picker-quick-btn btn-with-icon" data-path="/tmp">' + iconSvg("trash", { size: 13, strokeWidth: 1.7 }) + '<span>\u4E34\u65F6\u76EE\u5F55</span></button><button class="folder-picker-quick-btn btn-with-icon" data-path="/">' + iconSvg("folder", { size: 13, strokeWidth: 1.7 }) + '<span>\u6839\u76EE\u5F55</span></button></div><div id="folder-breadcrumb" class="folder-breadcrumb"></div><div class="folder-picker"><span class="folder-picker-icon">' + iconSvg("folder", { size: 15, strokeWidth: 1.7 }) + '</span><input type="text" id="folder-picker-input" class="folder-picker-input" value="" placeholder="\u8F93\u5165\u6216\u9009\u62E9\u5DE5\u4F5C\u76EE\u5F55..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" /></div><div id="folder-picker-dropdown" class="folder-picker-dropdown hidden"></div><div id="folder-picker-validation" class="folder-picker-validation"></div></div></div></section></main></div></div>' + renderSessionModal() + renderWorktreeMergeModal() + renderSettingsModal() + renderQuickCommitModal();
  }

  // src/web-ui/browser/notifications.ts
  function showError2(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    var inputEl = el.previousElementSibling;
    while (inputEl) {
      if (inputEl.tagName === "INPUT") {
        inputEl.setAttribute("data-error", "true");
        break;
      }
      inputEl = inputEl.previousElementSibling;
    }
  }
  function hideError2(el) {
    if (!el) return;
    el.textContent = "";
    el.classList.add("hidden");
    var inputEl = el.previousElementSibling;
    while (inputEl) {
      if (inputEl.tagName === "INPUT") {
        inputEl.setAttribute("data-error", "false");
        break;
      }
      inputEl = inputEl.previousElementSibling;
    }
  }
  function showToast2(message, type) {
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
    }, type === "error" ? 4e3 : 2200);
  }
  var _wandDialogStack = [];
  var _wandDialogIdCounter = 0;
  function _wandDialogIcon(type) {
    switch (type) {
      case "warning":
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
      case "danger":
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
      case "success":
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      case "question":
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 4.5 1.5c-.9.8-2.2 1.2-2.2 2.5"/><path d="M12 17h.01"/></svg>';
      default:
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
    }
  }
  function openWandDialog(opts) {
    opts = opts || {};
    var dismissable = opts.dismissable !== false;
    var type = opts.type || "info";
    var iconSvg7 = _wandDialogIcon(type);
    var hasInput = !!opts.input;
    return new Promise(function(resolve) {
      var dialogId = "wand-dialog-" + ++_wandDialogIdCounter;
      var previouslyFocused = document.activeElement;
      var backdrop = document.createElement("div");
      backdrop.className = "wand-dialog-backdrop";
      backdrop.setAttribute("role", "presentation");
      var dialog = document.createElement("div");
      dialog.className = "wand-dialog";
      dialog.setAttribute("role", hasInput ? "dialog" : "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      var header = document.createElement("div");
      header.className = "wand-dialog-header";
      var iconEl = document.createElement("div");
      iconEl.className = "wand-dialog-icon " + type;
      iconEl.setAttribute("aria-hidden", "true");
      if (opts.icon) {
        iconEl.textContent = String(opts.icon);
      } else {
        iconEl.innerHTML = iconSvg7;
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
      if (!opts.title) dialog.setAttribute("aria-label", type === "danger" ? "\u786E\u8BA4\u64CD\u4F5C" : "\u63D0\u793A");
      header.appendChild(textWrap);
      dialog.appendChild(header);
      var inputEl = null;
      if (hasInput) {
        var bodyEl = document.createElement("div");
        bodyEl.className = "wand-dialog-body";
        inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "wand-dialog-input";
        inputEl.setAttribute("aria-label", opts.inputLabel || opts.title || "\u8F93\u5165\u5185\u5BB9");
        inputEl.autocomplete = "off";
        inputEl.spellcheck = false;
        if (opts.inputPlaceholder) inputEl.placeholder = opts.inputPlaceholder;
        if (opts.inputValue != null) inputEl.value = String(opts.inputValue);
        bodyEl.appendChild(inputEl);
        dialog.appendChild(bodyEl);
      }
      var buttons = opts.buttons && opts.buttons.length ? opts.buttons : [
        { label: "\u597D", value: true, kind: "primary", autofocus: true }
      ];
      var footer = document.createElement("div");
      footer.className = "wand-dialog-footer";
      var firstFocusable = null;
      var autofocusTarget = null;
      function close(value) {
        if (backdrop.classList.contains("closing")) return;
        backdrop.classList.add("closing");
        document.removeEventListener("keydown", keyHandler, true);
        var idx = _wandDialogStack.indexOf(close);
        if (idx >= 0) _wandDialogStack.splice(idx, 1);
        var reduceMotion = false;
        try {
          reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        } catch (_e) {
        }
        setTimeout(function() {
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === "function") {
            try {
              previouslyFocused.focus();
            } catch (_e) {
            }
          }
          resolve(value);
        }, reduceMotion || document.hidden ? 0 : 140);
      }
      buttons.forEach(function(btnSpec) {
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
      backdrop.addEventListener("click", function(e) {
        if (e.target === backdrop && dismissable) {
          close(opts.cancelValue !== void 0 ? opts.cancelValue : hasInput ? null : false);
        }
      });
      function keyHandler(e) {
        if (_wandDialogStack[_wandDialogStack.length - 1] !== close) return;
        if (e.key === "Escape" && dismissable) {
          e.preventDefault();
          e.stopPropagation();
          close(opts.cancelValue !== void 0 ? opts.cancelValue : hasInput ? null : false);
          return;
        }
        if (e.key === "Enter") {
          var primary = null;
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
          var first = focusables[0];
          var last = focusables[focusables.length - 1];
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
      requestAnimationFrame(function() {
        if (hasInput && inputEl) {
          inputEl.focus();
          try {
            inputEl.select();
          } catch (e2) {
          }
        } else if (autofocusTarget) {
          autofocusTarget.focus();
        } else if (firstFocusable) {
          firstFocusable.focus();
        }
      });
    });
  }
  function wandAlert2(message, options) {
    options = options || {};
    return openWandDialog({
      title: options.title || "\u63D0\u793A",
      message: typeof message === "string" ? message : String(message == null ? "" : message),
      type: options.type || "info",
      buttons: [
        { label: options.okLabel || "\u597D", value: void 0, kind: "primary", autofocus: true }
      ]
    });
  }
  function wandConfirm2(message, options) {
    options = options || {};
    var danger = !!options.danger || options.type === "danger";
    return openWandDialog({
      title: options.title || (danger ? "\u786E\u8BA4\u64CD\u4F5C" : "\u8BF7\u786E\u8BA4"),
      message: typeof message === "string" ? message : String(message == null ? "" : message),
      type: options.type || (danger ? "danger" : "question"),
      cancelValue: false,
      buttons: [
        { label: options.cancelLabel || "\u53D6\u6D88", value: false, kind: "secondary" },
        {
          label: options.okLabel || (danger ? "\u5220\u9664" : "\u786E\u5B9A"),
          value: true,
          kind: danger ? "danger" : "primary",
          autofocus: !danger
        }
      ]
    }).then(function(v) {
      return v === true;
    });
  }
  function wandPrompt(message, defaultValue, options) {
    options = options || {};
    return openWandDialog({
      title: options.title || "\u8BF7\u8F93\u5165",
      message: typeof message === "string" ? message : String(message == null ? "" : message),
      type: options.type || "question",
      input: true,
      inputValue: defaultValue == null ? "" : String(defaultValue),
      inputPlaceholder: options.placeholder || "",
      cancelValue: null,
      buttons: [
        { label: options.cancelLabel || "\u53D6\u6D88", value: null, kind: "secondary" },
        { label: options.okLabel || "\u786E\u5B9A", value: void 0, kind: "primary" }
      ]
    });
  }
  window.wandAlert = wandAlert2;
  window.wandConfirm = wandConfirm2;
  window.wandPrompt = wandPrompt;
  window.openWandDialog = openWandDialog;
  var notificationStack = [];
  var notificationIdCounter = 0;
  var NOTIFICATION_GAP = 6;
  var NOTIFICATION_TOP = 16;
  function showNotificationBubble(opts) {
    if (opts.actionLabel || opts.playSound) playNotificationSound();
    if (!state.notifBubble) return { dismiss: function() {
    } };
    var id = ++notificationIdCounter;
    var type = opts.type || "info";
    var icon = opts.icon || (type === "warning" ? "!" : type === "success" ? "\u2713" : "i");
    var duration = opts.duration !== void 0 ? opts.duration : 8e3;
    var bubble = document.createElement("div");
    bubble.className = "notification-bubble";
    bubble.setAttribute("data-nid", String(id));
    var headerHtml = '<div class="notification-bubble-header"><span class="notification-bubble-icon ' + type + '">' + icon + '</span><span class="notification-bubble-title">' + escapeHtml2(opts.title) + '</span><button class="notification-bubble-close" title="\u5173\u95ED">\xD7</button></div>';
    var bodyHtml = opts.body ? '<div class="notification-bubble-body">' + escapeHtml2(opts.body).replace(/\n/g, "<br>") + "</div>" : "";
    var actionsHtml = opts.actionLabel ? '<div class="notification-bubble-actions"><button class="primary">' + escapeHtml2(opts.actionLabel) + "</button></div>" : "";
    bubble.innerHTML = headerHtml + bodyHtml + actionsHtml;
    document.body.appendChild(bubble);
    var entry = { id, el: bubble };
    notificationStack.push(entry);
    repositionNotifications();
    var closeBtn = bubble.querySelector(".notification-bubble-close");
    if (closeBtn) closeBtn.onclick = function() {
      dismissNotification(id);
    };
    if (opts.actionLabel && opts.action) {
      var actionBtn = bubble.querySelector(".notification-bubble-actions button");
      if (actionBtn) actionBtn.onclick = function() {
        opts.action();
        dismissNotification(id);
      };
    }
    var timer = null;
    if (duration > 0) {
      timer = setTimeout(function() {
        dismissNotification(id);
      }, duration);
    }
    return {
      dismiss: function() {
        dismissNotification(id);
      }
    };
  }
  function dismissNotification(id) {
    var idx = -1;
    for (var i = 0; i < notificationStack.length; i++) {
      if (notificationStack[i].id === id) {
        idx = i;
        break;
      }
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
  try {
    _macUaMatch = navigator.userAgent.match(/WandPlatform\/macOS/);
    _macHandler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wandNative || null;
    if (_macUaMatch && _macHandler && typeof window.WandNative === "undefined") {
      window.WandNative = {
        // Only downloadUpdate is wired for now; other Android-specific
        // methods (notifications, haptics, screen wake) intentionally
        // omitted so feature detection falls back to web APIs on macOS.
        downloadUpdate: function(url, fileName, source) {
          try {
            _macHandler.postMessage({
              type: "downloadUpdate",
              url: String(url || ""),
              fileName: String(fileName || "wand-update.dmg"),
              source: String(source || "local")
            });
          } catch (_e) {
          }
        }
      };
    }
  } catch (_e) {
  }
  var _hasNativeBridge = typeof WandNative !== "undefined" && typeof WandNative.sendNotification === "function";
  var _wandAppMatch = navigator.userAgent.match(/WandApp\/([^\s]+)/);
  var _isMacApp = /WandPlatform\/macOS/.test(navigator.userAgent);
  var _isAndroidApp = !!_wandAppMatch && !_isMacApp;
  var _apkVersion = _wandAppMatch && _isAndroidApp ? _wandAppMatch[1] : null;
  var _macAppVersion = _wandAppMatch && _isMacApp ? _wandAppMatch[1] : null;
  function _vibrate(pattern) {
    if (!_hasNativeBridge || typeof WandNative.vibrate !== "function") return;
    try {
      WandNative.vibrate(pattern || "light");
    } catch (_e) {
    }
  }
  function _syncWakeLock() {
    if (!_hasNativeBridge) return;
    var anyActive = state.sessions.some(function(s) {
      return !s.archived && (s.status === "running" || s.status === "thinking" || s.status === "initializing");
    });
    if (typeof WandNative.setKeepScreenOn === "function") {
      try {
        WandNative.setKeepScreenOn(anyActive);
      } catch (_e) {
      }
    }
    if (anyActive) {
      if (typeof WandNative.startKeepAlive === "function") {
        try {
          WandNative.startKeepAlive();
        } catch (_e) {
        }
      }
    } else {
      if (typeof WandNative.stopKeepAlive === "function") {
        try {
          WandNative.stopKeepAlive();
        } catch (_e) {
        }
      }
    }
  }
  function _getNativePermission() {
    if (_hasNativeBridge && typeof WandNative.getPermission === "function") {
      try {
        return WandNative.getPermission();
      } catch (_e) {
      }
    }
    return null;
  }
  function requestNotificationPermission() {
    if (_hasNativeBridge) {
      var perm = _getNativePermission();
      if (perm === "default" || perm === "denied") {
        try {
          WandNative.requestPermission();
        } catch (_e) {
        }
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
    if (_hasNativeBridge) {
      var perm = _getNativePermission();
      if (perm !== "granted") return;
      try {
        var nativeTag = tag;
        if (options.kind) {
          nativeTag = options.kind + (tag ? ":" + tag : "");
        }
        WandNative.sendNotification(title || "Wand", body || "", nativeTag || "");
      } catch (_e) {
      }
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (!document.hidden) return;
    try {
      var n = new Notification(title, {
        body: body || "",
        icon: options.icon || "/favicon.ico",
        tag: tag || void 0
      });
      n.onclick = function() {
        window.focus();
        n.close();
        if (options.onClick) options.onClick();
      };
      setTimeout(function() {
        n.close();
      }, 1e4);
    } catch (_e) {
    }
  }
  function notifyTaskProgress(sessionId, task) {
    if (!task || !task.title) return;
    var session = state.sessions.find(function(s) {
      return s.id === sessionId;
    });
    if (!session) return;
    var sessionLabel = session.summary || session.command || sessionId;
    sendBrowserNotification(
      "\u4EFB\u52A1\u8FDB\u884C\u4E2D",
      sessionLabel + "\n" + task.title,
      {
        kind: "task",
        tag: "wand-task-" + sessionId + "-" + task.title,
        minIntervalMs: 9e4,
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
      "Wand \u53D1\u73B0\u65B0\u7248\u672C",
      "\u5F53\u524D " + (currentVersion || "-") + " \u2192 \u6700\u65B0 " + (latestVersion || "-"),
      {
        kind: "update",
        tag: "wand-update",
        minIntervalMs: 3e5
      }
    );
  }
  function notifyPermissionRequest(sessionId, body) {
    sendBrowserNotification(
      "\u9700\u8981\u4F60\u7684\u6388\u6743",
      body,
      {
        kind: "permission",
        tag: "wand-perm-" + sessionId,
        minIntervalMs: 6e4,
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
        minIntervalMs: 1e4,
        onClick: function() {
          if (sessionId !== state.selectedId) selectSession(sessionId);
        }
      }
    );
  }
  var _progressSyncTimers = {};
  var _PROGRESS_SYNC_DEBOUNCE_MS = 30;
  function _compactNotificationText(text) {
    if (!text) return "";
    var t15 = String(text).replace(/^#+\s+/gm, "").replace(/\*\*/g, "").replace(/`/g, "").trim();
    var firstLine = t15.split("\n")[0].trim();
    if (firstLine.length > 100) firstLine = firstLine.slice(0, 100) + "\u2026";
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
    var session = state.sessions.find(function(s) {
      return s.id === sessionId;
    });
    if (!session) return;
    var sessionLabel = session.summary || session.command || sessionId;
    var sessionStatus = session.status || "running";
    if (sessionStatus === "idle" || sessionStatus === "archived" || sessionStatus === "exited") {
      clearSessionProgressNative(sessionId);
      return;
    }
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
        var isPlaceholder = msg.content.some(function(b) {
          return b && b.__queued;
        });
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
          if (block && block.type === "tool_use" && block.name === "TodoWrite" && block.input && block.input.todos) {
            todos = block.input.todos;
            break;
          }
        }
      }
      if (todos && recentUserTexts.length >= 4 && latestAssistantText) break;
    }
    recentUserTexts.reverse();
    var currentTask = "";
    if (sessionId === state.selectedId && state.currentTask && state.currentTask.title) {
      currentTask = state.currentTask.title;
    }
    var data = {
      sessionLabel,
      status: sessionStatus,
      currentTask,
      latestUserText,
      latestAssistantText,
      todos: todos || [],
      recentUserTexts
    };
    try {
      WandNative.updateSessionProgress(sessionId, JSON.stringify(data));
    } catch (_e) {
    }
  }
  function clearSessionProgressNative(sessionId) {
    if (!_hasNativeBridge || typeof WandNative.clearSessionProgress !== "function") return;
    if (_progressSyncTimers[sessionId]) {
      clearTimeout(_progressSyncTimers[sessionId]);
      delete _progressSyncTimers[sessionId];
    }
    try {
      WandNative.clearSessionProgress(sessionId);
    } catch (_e) {
    }
  }
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
      closeSessionsDrawer2();
      return true;
    }
    if (isMobileLayout() && state.selectedId) {
      state.selectedId = null;
      persistSelectedId();
      state.sessionsDrawerOpen = true;
      writeStoredBoolean("wand-sidebar-open", true);
      render8();
      return true;
    }
    return false;
  };
  function playNotificationSound() {
    if (!state.notifSound) return;
    _doPlaySound();
  }
  function tryPlayNotificationSound() {
    return _doPlaySound();
  }
  function _doPlaySound() {
    try {
      let tone2 = function(freq, start, dur) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.5 * vol, ctx.currentTime + start + 0.04);
        gain.gain.exponentialRampToValueAtTime(1e-3, ctx.currentTime + start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur);
      };
      var tone = tone2;
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      var ctx = new AudioCtx();
      if (ctx.state === "suspended") ctx.resume();
      var vol = (state.notifVolume || 0) / 100;
      tone2(523, 0, 0.25);
      tone2(659, 0.12, 0.3);
      setTimeout(function() {
        ctx.close();
      }, 600);
      return true;
    } catch (_e) {
      return false;
    }
  }
  function showUpdateBubble(currentVer, latestVer) {
    if (state._updateBubbleShown) return;
    state._updateBubbleShown = true;
    playNotificationSound();
    var id = ++notificationIdCounter;
    var card = document.createElement("div");
    card.className = "notification-bubble update-card";
    card.setAttribute("data-nid", String(id));
    card.innerHTML = '<div class="update-card-shine" aria-hidden="true"></div><div class="update-card-header"><div class="update-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></div><div class="update-card-heading"><div class="update-card-title">\u53D1\u73B0\u65B0\u7248\u672C</div><div class="update-card-subtitle" id="update-card-subtitle">\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u4E00\u952E\u66F4\u65B0</div></div><button class="update-card-close" title="\u7A0D\u540E\u63D0\u9192" aria-label="\u5173\u95ED"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button></div><div class="update-card-version"><span class="update-card-version-chip update-card-version-current">v' + escapeHtml2(String(currentVer).replace(/^v/, "")) + '</span><svg class="update-card-version-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg><span class="update-card-version-chip update-card-version-latest">v' + escapeHtml2(String(latestVer).replace(/^v/, "")) + '</span></div><div class="update-card-progress" id="update-card-progress" aria-hidden="true"><div class="update-card-progress-track"><div class="update-card-progress-fill"></div></div></div><div class="update-card-status hidden" id="update-card-status"></div><div class="update-card-actions"><button class="update-card-action update-card-action-primary" id="update-bubble-action" type="button"><span class="update-card-action-label">\u7ACB\u5373\u66F4\u65B0</span></button></div>';
    document.body.appendChild(card);
    var entry = { id, el: card };
    notificationStack.push(entry);
    repositionNotifications();
    var closeBtn = card.querySelector(".update-card-close");
    if (closeBtn) closeBtn.onclick = function() {
      dismissNotification(id);
      state._updateBubbleShown = false;
    };
    var actionBtn = card.querySelector("#update-bubble-action");
    var actionLabel = card.querySelector(".update-card-action-label");
    var subtitleEl = card.querySelector("#update-card-subtitle");
    var statusEl = card.querySelector("#update-card-status");
    var progressEl = card.querySelector("#update-card-progress");
    function setStatus(text, kind) {
      if (!statusEl) return;
      statusEl.textContent = text || "";
      statusEl.classList.remove("hidden", "error", "success");
      if (!text) {
        statusEl.classList.add("hidden");
        return;
      }
      if (kind) statusEl.classList.add(kind);
    }
    function setSubtitle(text) {
      if (subtitleEl) subtitleEl.textContent = text || "";
    }
    function setProgress(active) {
      if (!progressEl) return;
      progressEl.classList.toggle("active", !!active);
    }
    if (actionBtn) actionBtn.onclick = function() {
      actionBtn.disabled = true;
      card.classList.add("is-busy");
      if (actionLabel) actionLabel.textContent = "\u66F4\u65B0\u4E2D\u2026";
      setSubtitle("\u6B63\u5728\u4E0B\u8F7D\u5E76\u5B89\u88C5\u65B0\u7248\u672C\u2026");
      setProgress(true);
      setStatus("");
      fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin"
      }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (data.error) {
          setProgress(false);
          card.classList.remove("is-busy");
          setSubtitle("\u66F4\u65B0\u672A\u5B8C\u6210");
          setStatus(data.error, "error");
          actionBtn.disabled = false;
          if (actionLabel) actionLabel.textContent = "\u91CD\u8BD5";
          return;
        }
        card.classList.add("is-success");
        setSubtitle((data.message || "\u66F4\u65B0\u5B8C\u6210") + "\uFF0C\u6B63\u5728\u91CD\u542F\u670D\u52A1\u2026");
        setStatus("");
        if (actionLabel) actionLabel.textContent = "\u6B63\u5728\u91CD\u542F\u2026";
        if (data.detachedUpdate) {
          showRestartOverlay();
          return;
        }
        if (data.restartRequired === false) {
          setProgress(false);
          card.classList.remove("is-busy");
          actionBtn.disabled = false;
          if (actionLabel) actionLabel.textContent = "\u5DF2\u5B8C\u6210";
          return;
        }
        performRestartCard(actionBtn, actionLabel, subtitleEl, statusEl, progressEl);
      }).catch(function() {
        setProgress(false);
        card.classList.remove("is-busy");
        setSubtitle("\u66F4\u65B0\u672A\u5B8C\u6210");
        setStatus("\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u540E\u91CD\u8BD5", "error");
        actionBtn.disabled = false;
        if (actionLabel) actionLabel.textContent = "\u91CD\u8BD5";
      });
    };
  }
  function performRestartCard(btn, labelEl, subtitleEl, statusEl, progressEl) {
    fetch("/api/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin"
    }).then(function(res) {
      return res.json();
    }).then(function() {
      showRestartOverlay();
    }).catch(function() {
      showRestartOverlay();
    });
  }
  function performRestart(btn, msgEl) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "\u6B63\u5728\u91CD\u542F\u2026";
    }
    if (msgEl) {
      msgEl.textContent = "\u670D\u52A1\u6B63\u5728\u91CD\u542F\u2026";
      msgEl.style.color = "var(--text-secondary)";
    }
    fetch("/api/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin"
    }).then(function(res) {
      return res.json();
    }).then(function() {
      showRestartOverlay();
    }).catch(function() {
      showRestartOverlay();
    });
  }
  function normalizeUpdateVersion(value) {
    return typeof value === "string" ? value.trim().replace(/^v/, "").split("+")[0] : "";
  }
  function setRestartTarget(overlay, previousInstanceId, expectedVersion) {
    if (previousInstanceId) overlay.dataset.previousInstanceId = previousInstanceId;
    if (expectedVersion) overlay.dataset.expectedVersion = expectedVersion;
  }
  function startRestartPolling(overlay) {
    if (overlay.dataset.restartPolling === "true") return;
    overlay.dataset.restartPolling = "true";
    var attempts = 0;
    var maxAttempts = 180;
    var timer = setInterval(function() {
      attempts++;
      fetch("/api/config", { credentials: "same-origin" }).then(function(res) {
        if (!res.ok) throw new Error("server not ready");
        return res.json();
      }).then(function(config) {
        var previousInstanceId = overlay.dataset.previousInstanceId || "";
        var expectedVersion = normalizeUpdateVersion(overlay.dataset.expectedVersion || "");
        var currentInstanceId = typeof config.serverInstanceId === "string" ? config.serverInstanceId : "";
        var currentVersion = normalizeUpdateVersion(config.packageVersion || config.currentVersion);
        var instanceReady = !previousInstanceId || currentInstanceId.length > 0 && currentInstanceId !== previousInstanceId;
        var versionReady = !expectedVersion || currentVersion === expectedVersion;
        if (!instanceReady || !versionReady) return;
        clearInterval(timer);
        location.reload();
      }).catch(function() {
      });
      if (attempts >= maxAttempts) {
        clearInterval(timer);
        var subtitle = overlay.querySelector(".restart-subtitle");
        if (subtitle) {
          subtitle.innerHTML = '\u91CD\u542F\u8D85\u65F6\uFF0C\u8BF7 <a href="javascript:location.reload()" style="color:var(--accent);text-decoration:underline">\u624B\u52A8\u5237\u65B0</a> \u9875\u9762\u3002';
        }
      }
    }, 2e3);
  }
  function showRestartOverlay(previousInstanceId, expectedVersion) {
    var overlay = document.getElementById("restart-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "restart-overlay";
      overlay.className = "restart-overlay";
      overlay.innerHTML = '<div class="restart-overlay-content"><div class="restart-spinner"></div><div class="restart-title"></div><div class="restart-subtitle"></div></div>';
      document.body.appendChild(overlay);
    }
    setRestartTarget(overlay, previousInstanceId, expectedVersion);
    var title = overlay.querySelector(".restart-title");
    var subtitle = overlay.querySelector(".restart-subtitle");
    if (title) title.textContent = expectedVersion ? "\u6B63\u5728\u5B8C\u6210\u66F4\u65B0" : "\u670D\u52A1\u6B63\u5728\u91CD\u542F";
    if (subtitle) {
      subtitle.textContent = expectedVersion ? "\u5B89\u88C5\u5B8C\u6210\u5E76\u542F\u52A8\u65B0\u7248\u672C\u540E\u5C06\u81EA\u52A8\u5237\u65B0\u9875\u9762\u2026" : "\u7A0D\u540E\u5C06\u81EA\u52A8\u5237\u65B0\u9875\u9762\u2026";
    }
    startRestartPolling(overlay);
  }
  function showAutoUpdateOverlay(currentVer, latestVer, previousInstanceId) {
    var overlay = document.getElementById("restart-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "restart-overlay";
      overlay.className = "restart-overlay";
      overlay.innerHTML = '<div class="restart-overlay-content"><div class="restart-spinner"></div><div class="restart-title">\u81EA\u52A8\u66F4\u65B0\u4E2D</div><div class="restart-subtitle">' + escapeHtml2(currentVer) + " \u2192 " + escapeHtml2(latestVer) + "<br>\u6B63\u5728\u4E0B\u8F7D\u5E76\u5B89\u88C5\u65B0\u7248\u672C\uFF0C\u7A0D\u540E\u5C06\u81EA\u52A8\u91CD\u542F\u2026</div></div>";
      document.body.appendChild(overlay);
    }
    setRestartTarget(overlay, previousInstanceId, latestVer);
    startRestartPolling(overlay);
  }
  var _macUaMatch;
  var _macHandler;

  // src/web-ui/browser/input.ts
  var voiceState = { recording: false, canceling: false, transcript: "", startY: 0 };
  var VOICE_CANCEL_THRESHOLD = 60;
  var VOICE_HOLD_DELAY = 180;
  var composerVoiceHoldTimer = null;
  var composerVoiceHoldStartY = 0;
  var composerVoiceHoldPointerId = null;
  function updateVoiceTranscript(text) {
    voiceState.transcript = text || "";
    var textEl = document.getElementById("voice-transcript-text");
    if (textEl) textEl.textContent = voiceState.transcript;
    var bubble = document.getElementById("voice-transcript-bubble");
    if (bubble) bubble.classList.toggle("has-text", !!voiceState.transcript);
  }
  function startVoiceRecording(e) {
    if (e) {
      e.preventDefault();
      voiceState.startY = typeof e.clientY === "number" ? e.clientY : 0;
      try {
        if (e.pointerId !== void 0 && e.target && e.target.setPointerCapture) {
          e.target.setPointerCapture(e.pointerId);
        }
      } catch (_) {
      }
    }
    voiceState.recording = true;
    voiceState.canceling = false;
    voiceState.transcript = "";
    var btn = document.getElementById("voice-record-btn");
    if (btn) {
      btn.classList.add("is-recording");
      var label = btn.querySelector(".voice-record-label");
      if (label) label.textContent = "\u677E\u5F00 \u53D1\u9001";
    }
    var bubble = document.getElementById("voice-transcript-bubble");
    if (bubble) bubble.classList.remove("hidden", "is-canceling", "has-text");
    updateVoiceTranscript("");
    var status = document.getElementById("voice-transcript-status");
    if (status) status.textContent = "\u7F51\u9875\u7AEF\u6682\u4E0D\u652F\u6301\u8BED\u97F3\u8F93\u5165\uFF0C\u8BF7\u4F7F\u7528 App";
  }
  function handleVoiceMove(e) {
    if (!voiceState.recording || !e) return;
    var dy = voiceState.startY - (typeof e.clientY === "number" ? e.clientY : voiceState.startY);
    var shouldCancel = dy > VOICE_CANCEL_THRESHOLD;
    if (shouldCancel === voiceState.canceling) return;
    voiceState.canceling = shouldCancel;
    var bubble = document.getElementById("voice-transcript-bubble");
    if (bubble) bubble.classList.toggle("is-canceling", shouldCancel);
    var btn = document.getElementById("voice-record-btn");
    var label = btn && btn.querySelector(".voice-record-label");
    if (label) label.textContent = shouldCancel ? "\u677E\u5F00 \u53D6\u6D88" : "\u677E\u5F00 \u53D1\u9001";
    var status = document.getElementById("voice-transcript-status");
    if (status) status.textContent = shouldCancel ? "\u677E\u5F00\u624B\u6307 \u53D6\u6D88" : "\u6B63\u5728\u8046\u542C\u2026\u4E0A\u6ED1\u53D6\u6D88";
  }
  function stopVoiceRecording(e) {
    if (!voiceState.recording) return;
    if (e) e.preventDefault();
    voiceState.recording = false;
    var commit = !voiceState.canceling && !!voiceState.transcript.trim();
    var text = voiceState.transcript;
    resetVoiceRecordingUI();
    if (commit) {
      commitVoiceTranscript(text);
      toggleVoiceMode(false);
    }
  }
  function clearComposerVoiceHoldTimer() {
    if (composerVoiceHoldTimer !== null) {
      clearTimeout(composerVoiceHoldTimer);
      composerVoiceHoldTimer = null;
    }
  }
  function beginComposerVoiceHold(e) {
    var box = e && e.currentTarget;
    if (!box || state.terminalInteractive || (box.value || "").trim()) return;
    clearComposerVoiceHoldTimer();
    composerVoiceHoldStartY = typeof e.clientY === "number" ? e.clientY : 0;
    composerVoiceHoldPointerId = e.pointerId;
    composerVoiceHoldTimer = setTimeout(function() {
      composerVoiceHoldTimer = null;
      if ((box.value || "").trim()) return;
      startVoiceRecording(e);
      var composer = box.closest && box.closest(".input-composer");
      if (composer) composer.classList.add("voice-holding");
      box.placeholder = "\u677E\u5F00\u7ED3\u675F \xB7 \u4E0A\u6ED1\u53D6\u6D88";
    }, VOICE_HOLD_DELAY);
  }
  function handleComposerVoiceMove(e) {
    if (composerVoiceHoldTimer !== null) {
      var dy = Math.abs(composerVoiceHoldStartY - (typeof e.clientY === "number" ? e.clientY : composerVoiceHoldStartY));
      if (dy > 10) clearComposerVoiceHoldTimer();
      return;
    }
    if (voiceState.recording && (composerVoiceHoldPointerId === null || e.pointerId === composerVoiceHoldPointerId)) {
      handleVoiceMove(e);
      var box = e.currentTarget;
      if (box) box.placeholder = voiceState.canceling ? "\u677E\u5F00\u53D6\u6D88" : "\u677E\u5F00\u7ED3\u675F \xB7 \u4E0A\u6ED1\u53D6\u6D88";
    }
  }
  function finishComposerVoiceHold(e, canceled) {
    var wasPending = composerVoiceHoldTimer !== null;
    clearComposerVoiceHoldTimer();
    if (!wasPending && voiceState.recording) {
      if (canceled) voiceState.canceling = true;
      stopVoiceRecording(e);
    }
    composerVoiceHoldPointerId = null;
    var box = e && e.currentTarget;
    var composer = box && box.closest && box.closest(".input-composer");
    if (composer) composer.classList.remove("voice-holding");
    if (box) box.placeholder = getComposerPlaceholder(getSelectedSession3(), state.terminalInteractive);
  }
  function endComposerVoiceHold(e) {
    finishComposerVoiceHold(e, false);
  }
  function cancelComposerVoiceHold(e) {
    finishComposerVoiceHold(e, true);
  }
  function resetVoiceRecordingUI() {
    voiceState.canceling = false;
    var btn = document.getElementById("voice-record-btn");
    if (btn) {
      btn.classList.remove("is-recording");
      var label = btn.querySelector(".voice-record-label");
      if (label) label.textContent = "\u6309\u4F4F \u8BF4\u8BDD";
    }
    var bubble = document.getElementById("voice-transcript-bubble");
    if (bubble) bubble.classList.add("hidden");
  }
  function commitVoiceTranscript(text) {
    var clean = (text || "").trim();
    if (!clean) return;
    var box = document.getElementById("input-box");
    if (!box) return;
    var existing = box.value || "";
    var joined = existing ? existing.replace(/\s+$/, "") + " " + clean : clean;
    box.value = joined;
    setDraftValue(joined, true);
    autoResizeInput(box);
    try {
      box.setSelectionRange(joined.length, joined.length);
    } catch (_) {
    }
  }
  function toggleVoiceMode(force) {
    var composer = document.querySelector(".input-composer");
    if (!composer) return;
    var willEnable = typeof force === "boolean" ? force : !composer.classList.contains("voice-mode");
    composer.classList.toggle("voice-mode", willEnable);
    if (!willEnable) {
      voiceState.recording = false;
      resetVoiceRecordingUI();
      var inputBox = document.getElementById("input-box");
      if (inputBox && !state.terminalInteractive) {
        try {
          inputBox.focus({ preventScroll: true });
        } catch (_) {
        }
      }
    }
  }
  function autoResizeInput(el) {
    if (!el) return;
    var minHeight = 36;
    var maxHeight = 120;
    var touchDevice = isTouchDevice();
    if (!el.value || el.value.trim() === "") {
      el.style.height = minHeight + "px";
      el.style.minHeight = minHeight + "px";
      el.style.overflowY = touchDevice ? "auto" : "hidden";
      el.scrollTop = 0;
      syncComposerHasText(el);
      return;
    }
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
    syncComposerHasText(el);
  }
  function isSelectedSessionRunning() {
    if (!state.selectedId) return false;
    var selectedSession = state.sessions.find(function(session) {
      return session.id === state.selectedId;
    });
    if (isStructuredSession2(selectedSession)) {
      return !!(selectedSession.structuredState && selectedSession.structuredState.inFlight);
    }
    return !!selectedSession && selectedSession.status === "running";
  }
  var _queueLaunching = false;
  function sessionIsBusyForQueue(s) {
    if (!s || s.archived) return false;
    if (isStructuredSession2(s)) {
      return !!(s.structuredState && s.structuredState.inFlight);
    }
    return s.status === "running";
  }
  function hasAnyBusySession() {
    return state.sessions.some(sessionIsBusyForQueue);
  }
  function getContinuationTargetSession() {
    var candidates = state.sessions.filter(sessionIsBusyForQueue);
    if (candidates.length === 0) return null;
    if (state.selectedId) {
      var sel = candidates.find(function(s) {
        return s.id === state.selectedId;
      });
      if (sel) return sel;
    }
    candidates.sort(function(a, b) {
      return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0);
    });
    return candidates[0];
  }
  function getLastStructuredSubmittedInput(session) {
    if (!session) return "";
    var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages : [];
    for (var qi = queue.length - 1; qi >= 0; qi--) {
      var queued = typeof queue[qi] === "string" ? queue[qi].trim() : "";
      if (queued) return queued;
    }
    var messages = Array.isArray(session.messages) ? session.messages : [];
    for (var mi = messages.length - 1; mi >= 0; mi--) {
      var turn = messages[mi];
      if (!turn || turn.role !== "user" || !Array.isArray(turn.content)) continue;
      var textParts = turn.content.filter(function(block2) {
        return block2 && block2.type === "text" && typeof block2.text === "string";
      }).map(function(block2) {
        return block2.text;
      });
      if (textParts.length) return textParts.join("\n").trim();
      for (var bi = 0; bi < turn.content.length; bi++) {
        var block = turn.content[bi];
        if (block && block.type === "tool_result" && typeof block.content === "string") {
          return block.content.trim();
        }
      }
      return "";
    }
    return "";
  }
  function continueStructuredSession(session, text) {
    var normalizedText = typeof text === "string" ? text.trim() : "";
    if (normalizedText && getLastStructuredSubmittedInput(session) === normalizedText) {
      showToast2("\u4E0E\u4E0A\u4E00\u6761\u6D88\u606F\u76F8\u540C\uFF0C\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u4F1A\u52A0\u5165\u6392\u961F\u3002", "warning");
      return Promise.resolve();
    }
    var idempotencyKey = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    var prevQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
    var nextQueue = prevQueue.slice();
    nextQueue.push(text);
    updateSessionSnapshot({ id: session.id, queuedMessages: nextQueue });
    if (session.id === state.selectedId) updateQueueBar();
    var label = session.title || shortCommand(session.command) || "\u5F53\u524D\u4F1A\u8BDD";
    showToast2("\u5DF2\u52A0\u5165\u300C" + label + "\u300D\u7684\u6392\u961F\uFF0C\u56DE\u590D\u7ED3\u675F\u540E\u81EA\u52A8\u53D1\u9001\uFF08\u542B\u4E0A\u4E0B\u6587\uFF09\u3002", "info");
    return fetch("/api/structured-sessions/" + session.id + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ input: text, idempotencyKey })
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return { error: "\u8BF7\u6C42\u5931\u8D25" };
        }).then(function(p) {
          throw new Error(p && p.error || "\u65E0\u6CD5\u6392\u961F\u6D88\u606F\u3002");
        });
      }
      return res.json();
    }).then(function(snapshot) {
      if (snapshot && snapshot.id) {
        updateSessionSnapshot(snapshot);
        if (snapshot.id === state.selectedId) updateQueueBar();
      }
    }).catch(function(err) {
      updateSessionSnapshot({ id: session.id, queuedMessages: prevQueue });
      if (session.id === state.selectedId) updateQueueBar();
      showToast2(err && err.message || "\u6392\u961F\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002", "error");
    });
  }
  function enqueueCrossSessionMessage(text) {
    var target = getContinuationTargetSession();
    if (target && isStructuredSession2(target)) {
      continueStructuredSession(target, text);
      return;
    }
    if (state.crossSessionQueue.length >= 10) {
      showToast2("\u6392\u961F\u6D88\u606F\u5DF2\u6EE1\uFF08\u6700\u591A 10 \u6761\uFF09\uFF0C\u8BF7\u7B49\u5F85\u5F53\u524D\u4F1A\u8BDD\u5B8C\u6210\u3002", "warning");
      return;
    }
    var id = "csq-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    state.crossSessionQueue.push({
      id,
      text,
      cwd: getEffectiveCwd3(),
      mode: state.chatMode || "managed",
      tool: getPreferredTool(),
      queuedAt: Date.now()
    });
    persistCrossSessionQueue();
    renderCrossSessionQueue();
    showToast2("\u5DF2\u6392\u961F\uFF0C\u5C06\u5728\u7A7A\u95F2\u540E\u81EA\u52A8\u5F00\u59CB\u65B0\u4F1A\u8BDD\u3002", "info");
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
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      _queueLaunching = false;
      if (data.error) {
        showToast2(data.error, "error");
        state.crossSessionQueue.unshift(item);
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        return null;
      }
      return activateSession(data);
    }).catch(function(error) {
      _queueLaunching = false;
      showToast2(error && error.message || "\u65E0\u6CD5\u542F\u52A8\u6392\u961F\u4F1A\u8BDD\u3002", "error");
      state.crossSessionQueue.unshift(item);
      persistCrossSessionQueue();
      renderCrossSessionQueue();
    });
  }
  function sendQueueItemNow(queueId) {
    var idx = state.crossSessionQueue.findIndex(function(q) {
      return q.id === queueId;
    });
    if (idx < 0) return;
    var item = state.crossSessionQueue.splice(idx, 1)[0];
    persistCrossSessionQueue();
    renderCrossSessionQueue();
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
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        state.crossSessionQueue.splice(idx, 0, item);
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        return null;
      }
      return activateSession(data);
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u542F\u52A8\u6392\u961F\u4F1A\u8BDD\u3002", "error");
      state.crossSessionQueue.splice(idx, 0, item);
      persistCrossSessionQueue();
      renderCrossSessionQueue();
    });
  }
  function cancelQueueItem(queueId) {
    var idx = state.crossSessionQueue.findIndex(function(q) {
      return q.id === queueId;
    });
    if (idx < 0) return;
    state.crossSessionQueue.splice(idx, 1);
    persistCrossSessionQueue();
    renderCrossSessionQueue();
    if (state.crossSessionQueue.length === 0) {
      showToast2("\u6392\u961F\u5DF2\u6E05\u7A7A\u3002", "info");
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
    var sec = Math.floor((Date.now() - queuedAt) / 1e3);
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
    var isInputPanelVisible = inputPanel && !inputPanel.classList.contains("hidden");
    var parent = isInputPanelVisible ? inputPanel : blankChat;
    var insertBefore = isInputPanelVisible ? statusBar || composer : null;
    if (!parent) return;
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
      parent.insertBefore(container, insertBefore);
    }
    var total = state.crossSessionQueue.length;
    var items = state.crossSessionQueue.map(function(item, i) {
      var preview = item.text.length > 60 ? item.text.slice(0, 60) + "\u2026" : item.text;
      var age = formatQueueAge(item.queuedAt);
      return '<div class="queue-item" data-queue-id="' + escapeHtml2(item.id) + '"><span class="queue-item-dot"></span><span class="queue-item-text" title="' + escapeHtml2(item.text) + '">' + escapeHtml2(preview) + '</span><span class="queue-item-age">' + age + '</span><button class="queue-item-send-now" data-queue-id="' + escapeHtml2(item.id) + '" title="\u7ACB\u5373\u53D1\u9001" type="button">\u53D1\u9001</button><button class="queue-item-cancel" data-queue-id="' + escapeHtml2(item.id) + '" title="\u53D6\u6D88" type="button">\xD7</button></div>';
    }).join("");
    var header = total > 1 ? '<div class="queue-header"><span class="queue-header-label">\u6392\u961F ' + total + ' \u6761</span><button class="queue-header-clear" id="queue-clear-all" type="button" title="\u6E05\u7A7A\u6392\u961F">\u6E05\u7A7A</button></div>' : "";
    container.innerHTML = header + items;
  }
  setInterval(function() {
    if (state.crossSessionQueue.length > 0) {
      var ages = document.querySelectorAll(".queue-item-age");
      state.crossSessionQueue.forEach(function(item, i) {
        if (ages[i]) ages[i].textContent = formatQueueAge(item.queuedAt);
      });
      flushCrossSessionQueue();
    }
  }, 5e3);
  document.addEventListener("click", function(e) {
    var target = e.target;
    if (target.closest("#queue-clear-all")) {
      e.preventDefault();
      state.crossSessionQueue = [];
      persistCrossSessionQueue();
      renderCrossSessionQueue();
      showToast2("\u6392\u961F\u5DF2\u6E05\u7A7A\u3002", "info");
      return;
    }
    var sendNow = target.closest(".queue-item-send-now");
    if (sendNow) {
      e.preventDefault();
      sendQueueItemNow(sendNow.dataset.queueId);
      return;
    }
    var cancel = target.closest(".queue-item-cancel");
    if (cancel) {
      e.preventDefault();
      cancelQueueItem(cancel.dataset.queueId);
      return;
    }
  });
  function welcomeInputSend() {
    var welcomeInput = document.getElementById("welcome-input");
    var value = welcomeInput ? welcomeInput.value.trim() : "";
    if (!value) return;
    if (hasAnyBusySession()) {
      welcomeInput.value = "";
      enqueueCrossSessionMessage(value);
      return;
    }
    var todoEl = document.getElementById("todo-progress");
    if (todoEl) todoEl.classList.add("hidden");
    welcomeInput.value = "";
    welcomeInput.placeholder = "\u6B63\u5728\u542F\u52A8\u2026";
    welcomeInput.disabled = true;
    var mode = state.chatMode || "managed";
    var defaultCwd = getEffectiveCwd3();
    var preferredTool = getPreferredTool();
    fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        command: preferredTool,
        provider: preferredTool,
        cwd: defaultCwd,
        mode,
        initialInput: value
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        welcomeInput.placeholder = "\u8F93\u5165\u6D88\u606F";
        welcomeInput.disabled = false;
        return;
      }
      state.selectedId = data.id;
      persistSelectedId();
      state.drafts[data.id] = "";
      resetChatRenderCache2();
      updateSessionSnapshot(data);
      updateSessionsList();
      switchToSessionView2(data.id);
      subscribeToSession(data.id);
      loadOutput(data.id).then(function() {
        welcomeInput.placeholder = "\u8F93\u5165\u6D88\u606F";
        welcomeInput.disabled = false;
        focusInputBox3(true);
      });
    }).catch(function(error) {
      showToast2(error && error.message || (preferredTool === "codex" ? "\u65E0\u6CD5\u542F\u52A8 Codex \u4F1A\u8BDD\u3002" : "\u65E0\u6CD5\u542F\u52A8 Claude \u4F1A\u8BDD\u3002"), "error");
      welcomeInput.placeholder = "\u8F93\u5165\u6D88\u606F";
      welcomeInput.disabled = false;
    });
  }
  function sendOrStart(opts) {
    opts = opts || {};
    var welcomeInput = document.getElementById("welcome-input");
    var inputBox = document.getElementById("input-box");
    var value = welcomeInput && welcomeInput.value.trim() ? welcomeInput.value.trim() : inputBox ? inputBox.value.trim() : "";
    if (state.selectedId) {
      if (value) {
        sendInputFromBox(opts);
      }
      return;
    }
    if (value && hasAnyBusySession()) {
      if (inputBox) inputBox.value = "";
      if (welcomeInput) welcomeInput.value = "";
      syncComposerHasText(inputBox);
      enqueueCrossSessionMessage(value);
      return;
    }
    var mode = state.chatMode || "managed";
    var defaultCwd = getEffectiveCwd3();
    var preferredTool = getPreferredTool();
    fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        command: preferredTool,
        provider: preferredTool,
        cwd: defaultCwd,
        mode,
        initialInput: value || void 0
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        return null;
      }
      state.selectedId = data.id;
      persistSelectedId();
      state.drafts[data.id] = "";
      resetChatRenderCache2();
      if (inputBox) inputBox.value = "";
      if (welcomeInput) welcomeInput.value = "";
      updateSessionSnapshot(data);
      updateSessionsList();
      switchToSessionView2(data.id);
      subscribeToSession(data.id);
      return loadOutput(data.id);
    }).catch(function(error) {
      showToast2(error && error.message || (preferredTool === "codex" ? "\u65E0\u6CD5\u542F\u52A8 Codex \u4F1A\u8BDD\u3002" : "\u65E0\u6CD5\u542F\u52A8 Claude \u4F1A\u8BDD\u3002"), "error");
    });
  }
  function switchToSessionView2(sessionId) {
    var session = state.sessions.find(function(s) {
      return s.id === sessionId;
    });
    var blankChat = document.getElementById("blank-chat");
    var terminalContainer = document.getElementById("output");
    var chatContainer = document.getElementById("chat-output");
    var stopBtn = document.getElementById("stop-button");
    var terminalTitle = document.getElementById("terminal-title");
    var terminalInfo = document.getElementById("terminal-info");
    var sessionSummary = document.querySelector(".session-summary-value");
    var structured = isStructuredSession2(session);
    if (blankChat) blankChat.classList.add("hidden");
    if (terminalContainer) {
      terminalContainer.classList.toggle("hidden", structured);
    }
    if (chatContainer) {
      chatContainer.classList.remove("hidden");
    }
    if (structured) {
      state.currentView = "chat";
    } else {
      state.currentView = "terminal";
    }
    var title = session ? shortCommand(session.command) : "Wand";
    var info = session ? getSessionStatusLabel(session) : "\u5F00\u59CB\u5BF9\u8BDD";
    if (terminalTitle) terminalTitle.textContent = title;
    if (terminalInfo) terminalInfo.textContent = info;
    if (sessionSummary) sessionSummary.textContent = title;
    if (!structured) {
      if (!state.terminal) initTerminal2();
    }
    applyCurrentView();
    focusInputBox3(true);
    if (!structured) ensureTerminalFit2("view-switch", { forceReplay: true });
  }
  function sendInputFromBox(opts) {
    opts = opts || {};
    var interruptFlag = !!opts.interrupt;
    var embedTerminal = document.documentElement.classList.contains("is-wand-embed-terminal");
    if (state.terminalInteractive && !embedTerminal) {
      showToast2("\u7EC8\u7AEF\u4EA4\u4E92\u6A21\u5F0F\u5F00\u542F\u65F6\uFF0C\u8BF7\u76F4\u63A5\u5728\u7EC8\u7AEF\u4E2D\u8F93\u5165\u3002", "info");
      return Promise.resolve();
    }
    var inputBox = document.getElementById("input-box");
    var value = inputBox ? inputBox.value : "";
    var selectedSession = getSelectedSession3();
    var hasAttachments = state.pendingAttachments.length > 0;
    if (value || hasAttachments) {
      var attachUpload = hasAttachments && state.selectedId ? uploadAttachments(state.selectedId).catch(function(err) {
        showToast2("\u9644\u4EF6\u4E0A\u4F20\u5931\u8D25: " + (err && err.message || err), "error");
        var marked = err instanceof Error ? err : new Error(String(err));
        marked.__wandToasted = true;
        throw marked;
      }) : Promise.resolve([]);
      return attachUpload.then(function(uploadedFiles) {
        var prefix = buildAttachmentPrefix(uploadedFiles);
        var finalValue = prefix + (value || (uploadedFiles.length ? "\u8BF7\u67E5\u770B\u9644\u4EF6\u3002" : ""));
        if (uploadedFiles.length) clearAttachments();
        var todoEl = document.getElementById("todo-progress");
        if (todoEl) todoEl.classList.add("hidden");
        if (isStructuredSession2(selectedSession)) {
          return postStructuredInput(finalValue, inputBox, selectedSession, { interrupt: interruptFlag });
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
            return null;
          }
          var submitView = state.currentView;
          if (readySession && readySession.provider === "codex" && state.selectedId !== readySession.id) {
            throw new Error("Codex session changed before input send.");
          }
          prepareChatBottomFollow();
          return sendTerminalChunks(submitChunks, "enter_text", 30, submitView).then(function() {
            if (inputBox && inputBox.value === value) {
              inputBox.value = "";
              autoResizeInput(inputBox);
            }
            setDraftValue("");
          });
        }).catch(function(err) {
          showToast2(getInputErrorMessage(err), "error");
          if (err) err.__wandToasted = true;
          throw err;
        });
      }).catch(function(err) {
        if (!(err && err.__wandToasted)) {
          showToast2(getInputErrorMessage(err), "error");
        }
        throw err;
      });
    }
    return Promise.resolve();
  }
  var _structuredLastSubmitAt = {};
  var DUPLICATE_SUBMIT_WINDOW_MS = 350;
  function postStructuredInput(input, inputBox, session, opts) {
    opts = opts || {};
    var requestedInterrupt = !!opts.interrupt;
    if (!state.selectedId || !input) return Promise.resolve();
    if (!session) {
      showToast2("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6216\u65B0\u5EFA\u4F1A\u8BDD\u3002", "error");
      return Promise.resolve();
    }
    var sessionInFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
    if (sessionInFlight && !requestedInterrupt && getLastStructuredSubmittedInput(session) === input.trim()) {
      if (inputBox) {
        inputBox.value = "";
        autoResizeInput(inputBox);
      }
      setDraftValue("");
      showToast2("\u4E0E\u4E0A\u4E00\u6761\u6D88\u606F\u76F8\u540C\uFF0C\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u4F1A\u52A0\u5165\u6392\u961F\u3002", "warning");
      updateInputHint("Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C");
      return Promise.resolve();
    }
    var nowTs = Date.now();
    var lastTs = _structuredLastSubmitAt[session.id] || 0;
    if (nowTs - lastTs < DUPLICATE_SUBMIT_WINDOW_MS) {
      console.log("[wand] postStructuredInput: duplicate submit (within " + DUPLICATE_SUBMIT_WINDOW_MS + "ms) ignored for session", session.id);
      return Promise.resolve();
    }
    _structuredLastSubmitAt[session.id] = nowTs;
    var isInterrupting = sessionInFlight && requestedInterrupt;
    var isQueueing = sessionInFlight && !requestedInterrupt;
    var userMsgs = stripRenderOnlyStructuredMessages(Array.isArray(session.messages) ? session.messages.slice() : []);
    var optimisticPatch;
    if (isQueueing) {
      var nextQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
      nextQueue.push(input);
      optimisticPatch = {
        id: session.id,
        queuedMessages: nextQueue
      };
      updateSessionSnapshot(optimisticPatch);
      var queueRefreshed = state.sessions.find(function(s) {
        return s.id === session.id;
      }) || session;
      state.currentMessages = buildMessagesForRender(queueRefreshed, getPreferredMessages(queueRefreshed, queueRefreshed.output, false));
      updateInputHint("\u5DF2\u52A0\u5165\u6392\u961F\u2026");
      renderChat(true);
      updateStructuredQueueCounter();
      showToast2(nextQueue.length > 1 ? "\u5DF2\u52A0\u5165\u6392\u961F\uFF08\u5171 " + nextQueue.length + " \u6761\u7B49\u5F85\uFF09" : "\u5DF2\u52A0\u5165\u6392\u961F\uFF0C\u7B49\u5F53\u524D\u56DE\u590D\u5B8C\u6210\u4F1A\u81EA\u52A8\u53D1\u9001\u3002", "info");
    } else {
      var userTurn = { role: "user", content: [{ type: "text", text: input }] };
      userMsgs.push(userTurn);
      var optimisticStructuredState = Object.assign({}, session.structuredState || {}, { inFlight: true });
      updateSessionSnapshot({
        id: session.id,
        status: "running",
        messages: userMsgs,
        structuredState: optimisticStructuredState
      });
      state.currentMessages = buildMessagesForRender(Object.assign({}, session, {
        status: "running",
        messages: userMsgs,
        structuredState: optimisticStructuredState
      }), userMsgs);
      updateInputHint(isInterrupting ? "\u5DF2\u4E2D\u65AD\uFF0C\u6B63\u5728\u5904\u7406\u65B0\u6D88\u606F\u2026" : "\u601D\u8003\u4E2D\u2026");
      prepareChatBottomFollow();
      renderChat(true);
      if (isInterrupting) {
        showToast2("\u5DF2\u4E2D\u65AD\u4E0A\u4E00\u6761\u56DE\u590D\uFF0C\u6B63\u5728\u5904\u7406\u65B0\u6D88\u606F\u2026", "info");
      }
    }
    if (inputBox) {
      inputBox.value = "";
      autoResizeInput(inputBox);
    }
    setDraftValue("");
    var epochBeforePost = state.queueEpoch;
    var idempotencyKey = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    return fetch("/api/structured-sessions/" + session.id + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ input, interrupt: isInterrupting || void 0, idempotencyKey })
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return { error: "\u8BF7\u6C42\u5931\u8D25" };
        }).then(function(payload) {
          var err = new Error(payload && payload.error || "\u65E0\u6CD5\u53D1\u9001\u7ED3\u6784\u5316\u6D88\u606F\u3002");
          err.errorCode = payload && payload.errorCode;
          err.httpStatus = res.status;
          throw err;
        });
      }
      return res.json();
    }).then(function(snapshot) {
      if (snapshot && snapshot.error) {
        throw new Error(snapshot.error);
      }
      if (snapshot && snapshot.id) {
        if (state.queueEpoch > epochBeforePost && snapshot.queuedMessages) {
          delete snapshot.queuedMessages;
        }
        updateSessionSnapshot(snapshot);
        if (snapshot.id === state.selectedId) {
          var refreshedSession = state.sessions.find(function(s) {
            return s.id === snapshot.id;
          }) || snapshot;
          state.currentMessages = buildMessagesForRender(refreshedSession, getPreferredMessages(refreshedSession, snapshot.output, false));
          renderChat(true);
          updateStructuredQueueCounter();
        }
      }
    }).catch(function(error) {
      if (error && error.errorCode === "duplicate_idempotency_key") {
        showToast2(error.message || "\u68C0\u6D4B\u5230\u91CD\u590D\u53D1\u9001\uFF0C\u5DF2\u62E6\u622A\u3002", "warning");
        updateInputHint("Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C");
        return;
      }
      if (isQueueing) {
        var prevQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        updateSessionSnapshot({
          id: session.id,
          queuedMessages: prevQueue
        });
        if (session.id === state.selectedId) {
          var rolledQueueSession = state.sessions.find(function(s) {
            return s.id === session.id;
          }) || session;
          state.currentMessages = buildMessagesForRender(rolledQueueSession, getPreferredMessages(rolledQueueSession, rolledQueueSession.output, false));
          renderChat(true);
          updateStructuredQueueCounter();
        }
      } else {
        var rollbackMsgs = userMsgs.slice(0, -1);
        updateSessionSnapshot({
          id: session.id,
          status: session.status,
          messages: rollbackMsgs,
          structuredState: Object.assign({}, session.structuredState || {}, { inFlight: false })
        });
        if (session.id === state.selectedId) {
          state.currentMessages = buildMessagesForRender(
            Object.assign({}, session, { messages: rollbackMsgs, structuredState: Object.assign({}, session.structuredState || {}, { inFlight: false }) }),
            rollbackMsgs
          );
          renderChat(true);
        }
      }
      var message = error && error.message || "";
      var isTransientAbort = message === "Failed to fetch" || message === "NetworkError when attempting to fetch resource." || message === "Load failed" || /aborted|aborterror|networkerror|failed to fetch/i.test(message);
      if (!isTransientAbort) {
        showToast2(error && error.message || "\u65E0\u6CD5\u53D1\u9001\u7ED3\u6784\u5316\u6D88\u606F\u3002", "error");
      }
      updateInputHint("Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C");
    });
  }
  function updateInputHint(text) {
    var hint = document.querySelector(".input-hint");
    if (hint) hint.textContent = text;
  }
  function updateStructuredQueueCounter() {
    updateQueueBar();
  }
  var QUEUE_BAR_MAX = 10;
  var QUEUE_CHIP_MAX_TEXT = 26;
  function queueChipTruncate(text) {
    if (typeof text !== "string") return "";
    var s = text.replace(/\s+/g, " ").trim();
    if (s.length <= QUEUE_CHIP_MAX_TEXT) return s;
    return s.slice(0, QUEUE_CHIP_MAX_TEXT) + "\u2026";
  }
  function isQueueBarExpanded() {
    return !!state.queueBarExpanded;
  }
  function setQueueBarExpanded(expanded) {
    if (!!state.queueBarExpanded === !!expanded) return;
    state.queueBarExpanded = !!expanded;
    var bar = document.querySelector(".queue-bar");
    if (bar) bar.classList.toggle("expanded", !!expanded);
  }
  function renderQueueBarHtml(items, inFlight, atCapacity) {
    var n = items.length;
    var barClass = "queue-bar";
    if (atCapacity) barClass += " queue-bar-capacity";
    if (inFlight) barClass += " queue-bar-inflight";
    var promoteTitle = inFlight ? "\u4E2D\u65AD\u5F53\u524D\u56DE\u590D\uFF0C\u7ACB\u5373\u53D1\u9001\u8FD9\u6761" : "\u7ACB\u5373\u53D1\u9001\u8FD9\u6761";
    var chipNodes = "";
    for (var i = 0; i < n; i++) {
      var raw = items[i] == null ? "" : String(items[i]);
      var displayText = queueChipTruncate(raw);
      var titleAttr = raw + "\uFF08\u6309\u4F4F\u53EF\u62D6\u52A8\u8C03\u5E8F\uFF09";
      chipNodes += '<li class="queue-bar-item" data-index="' + i + '" data-action="drag" title="' + escapeHtml2(titleAttr) + '"><span class="queue-bar-item-index" aria-hidden="true">' + (i + 1) + '</span><span class="queue-bar-item-text">' + escapeHtml2(displayText) + '</span><button type="button" class="queue-bar-item-promote" data-action="promote-item" title="' + escapeHtml2(promoteTitle) + '" aria-label="\u7ACB\u5373\u53D1\u9001\u7B2C ' + (i + 1) + ' \u6761"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 L4 14 L11 14 L10 22 L20 9 L13 9 Z"/></svg></button><button type="button" class="queue-bar-item-delete" data-action="delete" aria-label="\u5220\u9664\u7B2C ' + (i + 1) + ' \u6761\u6392\u961F\u6D88\u606F" title="\u5220\u9664"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg></button></li>';
    }
    var headerBar = "";
    if (n >= 2) {
      headerBar = '<div class="queue-bar-head"><span class="queue-bar-head-count">' + n + ' \u6761\u6392\u961F</span><button type="button" class="queue-bar-clear-all" data-action="clear-all" title="\u6E05\u7A7A\u5168\u90E8\u6392\u961F" aria-label="\u6E05\u7A7A\u5168\u90E8 ' + n + ' \u6761\u6392\u961F\u6D88\u606F">\u6E05\u7A7A</button></div>';
    }
    return '<div class="' + barClass + '" data-queue-bar="1" title="\u6392\u961F ' + n + ' \u6761\uFF08\u6309\u4F4F\u6C14\u6CE1\u53EF\u8C03\u5E8F\uFF09">' + headerBar + '<ol class="queue-bar-list" data-queue-list="1">' + chipNodes + "</ol></div>";
  }
  function updateQueueBar() {
    var host = document.getElementById("queue-bar-host");
    if (!host) return;
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var isStructured = session && session.sessionKind === "structured";
    var queue = isStructured ? getStructuredQueuedInputs(session) : [];
    queue = Array.isArray(queue) ? queue : [];
    if (!isStructured || queue.length === 0) {
      host.hidden = true;
      host.innerHTML = "";
      state.queueBarExpanded = false;
      return;
    }
    if (state.queueBarDrag) return;
    host.hidden = false;
    var inFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
    var atCapacity = queue.length >= QUEUE_BAR_MAX;
    host.innerHTML = renderQueueBarHtml(queue, inFlight, atCapacity);
  }
  function rollbackQueueOptimistic(session, prevQueue) {
    updateSessionSnapshot({ id: session.id, queuedMessages: prevQueue });
    var refreshed = state.sessions.find(function(s) {
      return s.id === session.id;
    }) || session;
    state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
    renderChat(true);
    updateQueueBar();
  }
  function queueBarDeleteItem(index) {
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!session) return;
    var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
    if (index < 0 || index >= queue.length) return;
    var prev = queue.slice();
    var next = queue.slice(0, index).concat(queue.slice(index + 1));
    updateSessionSnapshot({ id: session.id, queuedMessages: next });
    var refreshed = state.sessions.find(function(s) {
      return s.id === session.id;
    }) || session;
    state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
    renderChat(true);
    updateQueueBar();
    fetch("/api/structured-sessions/" + session.id + "/queued/" + index, {
      method: "DELETE",
      credentials: "same-origin"
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return {};
        }).then(function(p) {
          throw new Error(p && p.error || "\u5220\u9664\u5931\u8D25");
        });
      }
    }).catch(function(err) {
      rollbackQueueOptimistic(session, prev);
      showToast2(err && err.message || "\u5220\u9664\u6392\u961F\u6D88\u606F\u5931\u8D25\u3002", "error");
    });
  }
  function queueBarClearAll() {
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!session) return;
    var prev = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
    if (prev.length === 0) return;
    state.queueBarExpanded = false;
    updateSessionSnapshot({ id: session.id, queuedMessages: [] });
    var refreshed = state.sessions.find(function(s) {
      return s.id === session.id;
    }) || session;
    state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
    renderChat(true);
    updateQueueBar();
    fetch("/api/structured-sessions/" + session.id + "/queued", {
      method: "DELETE",
      credentials: "same-origin"
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return {};
        }).then(function(p) {
          throw new Error(p && p.error || "\u6E05\u7A7A\u5931\u8D25");
        });
      }
      showToast2("\u5DF2\u6E05\u7A7A " + prev.length + " \u6761\u6392\u961F\u6D88\u606F\u3002", "info");
    }).catch(function(err) {
      rollbackQueueOptimistic(session, prev);
      showToast2(err && err.message || "\u6E05\u7A7A\u6392\u961F\u6D88\u606F\u5931\u8D25\u3002", "error");
    });
  }
  function queueBarPromoteIndex(index) {
    if (state.queueBarPromoting) return;
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!session) return;
    var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
    if (index < 0 || index >= queue.length) return;
    var picked = queue[index];
    var rest = queue.slice(0, index).concat(queue.slice(index + 1));
    var prev = queue.slice();
    var inFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
    state.queueBarPromoting = true;
    if (rest.length === 0) {
      state.queueBarExpanded = false;
    }
    updateSessionSnapshot({ id: session.id, queuedMessages: rest });
    var idempotencyKey = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    showToast2(inFlight ? "\u5DF2\u8BF7\u6C42\u4E2D\u65AD\u5F53\u524D\u56DE\u590D\uFF0C\u7ACB\u5373\u53D1\u9001\u8FD9\u6761\u3002" : "\u5DF2\u7ACB\u5373\u53D1\u9001\u8FD9\u6761\u6D88\u606F\u3002", "info");
    fetch("/api/structured-sessions/" + session.id + "/queued/" + index + "/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ expectedText: picked, idempotencyKey })
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return {};
        }).then(function(p) {
          throw new Error(p && p.error || "\u7ACB\u5373\u53D1\u9001\u5931\u8D25");
        });
      }
      return res.json();
    }).then(function(snapshot) {
      if (snapshot && snapshot.id) {
        updateSessionSnapshot(snapshot);
        if (snapshot.id === state.selectedId) {
          var refreshed = state.sessions.find(function(s) {
            return s.id === snapshot.id;
          }) || snapshot;
          state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, snapshot.output, false));
          renderChat(true);
          updateQueueBar();
        }
      }
      state.queueBarPromoting = false;
    }).catch(function(err) {
      state.queueBarPromoting = false;
      rollbackQueueOptimistic(session, prev);
      showToast2(err && err.message || "\u7ACB\u5373\u53D1\u9001\u5931\u8D25\u3002", "error");
    });
  }
  function queueBarDragStart(ev, chipEl) {
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!session) return;
    var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
    if (queue.length <= 1) return;
    if (!chipEl) return;
    var listEl = chipEl.parentElement;
    if (!listEl) return;
    var origIndex = Number(chipEl.getAttribute("data-index"));
    var siblings = Array.prototype.slice.call(listEl.children);
    var rects = siblings.map(function(el) {
      return el.getBoundingClientRect();
    });
    var gap = 3;
    if (rects.length >= 2) gap = Math.max(0, rects[1].top - rects[0].top - rects[0].height);
    ev.preventDefault();
    try {
      chipEl.setPointerCapture(ev.pointerId);
    } catch (_e) {
    }
    if (navigator && navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch (_e2) {
      }
    }
    state.queueBarDrag = {
      pointerId: ev.pointerId,
      handleEl: chipEl,
      itemEl: chipEl,
      listEl,
      siblings,
      rects,
      origIndex,
      targetIndex: origIndex,
      startY: ev.clientY,
      gap,
      queueSnapshot: queue
    };
    chipEl.classList.add("dragging");
    siblings.forEach(function(el) {
      if (el !== chipEl) el.classList.add("queue-bar-item-sliding");
    });
    var move = function(e) {
      queueBarDragMove(e);
    };
    var up = function(e) {
      queueBarDragEnd(e);
    };
    state.queueBarDrag.moveHandler = move;
    state.queueBarDrag.upHandler = up;
    chipEl.addEventListener("pointermove", move);
    chipEl.addEventListener("pointerup", up);
    chipEl.addEventListener("pointercancel", up);
  }
  function queueBarComputeNewTops(origIndex, target, rects, gap) {
    var n = rects.length;
    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    order.splice(origIndex, 1);
    order.splice(target, 0, origIndex);
    var top = rects[0].top;
    var listTop = rects[0].top;
    for (var k = 1; k < n; k++) if (rects[k].top < listTop) listTop = rects[k].top;
    var newTops = {};
    var cursor = listTop;
    for (var newPos = 0; newPos < n; newPos++) {
      var oldIdx = order[newPos];
      newTops[oldIdx] = cursor;
      cursor += rects[oldIdx].height + gap;
    }
    return newTops;
  }
  function queueBarDragMove(ev) {
    var d = state.queueBarDrag;
    if (!d || ev.pointerId !== d.pointerId) return;
    ev.preventDefault();
    var deltaY = ev.clientY - d.startY;
    d.itemEl.style.transform = "translateY(" + deltaY + "px)";
    var centerY = d.rects[d.origIndex].top + d.rects[d.origIndex].height / 2 + deltaY;
    var target = d.origIndex;
    for (var i = 0; i < d.rects.length; i++) {
      if (i === d.origIndex) continue;
      var midY = d.rects[i].top + d.rects[i].height / 2;
      if (i < d.origIndex && centerY < midY) {
        target = Math.min(target, i);
      } else if (i > d.origIndex && centerY > midY) {
        target = Math.max(target, i);
      }
    }
    if (target !== d.targetIndex) {
      d.targetIndex = target;
      var newTops = queueBarComputeNewTops(d.origIndex, target, d.rects, d.gap);
      d.siblings.forEach(function(el, idx) {
        if (idx === d.origIndex) return;
        var move = newTops[idx] - d.rects[idx].top;
        el.style.transform = move ? "translateY(" + move + "px)" : "";
      });
    }
  }
  function queueBarDragEnd(ev) {
    var d = state.queueBarDrag;
    if (!d || ev && ev.pointerId !== d.pointerId) return;
    try {
      d.handleEl.releasePointerCapture(d.pointerId);
    } catch (_e) {
    }
    d.handleEl.removeEventListener("pointermove", d.moveHandler);
    d.handleEl.removeEventListener("pointerup", d.upHandler);
    d.handleEl.removeEventListener("pointercancel", d.upHandler);
    var origIndex = d.origIndex;
    var targetIndex = d.targetIndex;
    var queueSnapshot = d.queueSnapshot;
    d.siblings.forEach(function(el) {
      el.style.transform = "";
      el.classList.remove("queue-bar-item-sliding");
    });
    d.itemEl.classList.remove("dragging");
    state.queueBarDrag = null;
    if (origIndex === targetIndex) {
      updateQueueBar();
      return;
    }
    var order = [];
    for (var i = 0; i < queueSnapshot.length; i++) order.push(i);
    order.splice(origIndex, 1);
    order.splice(targetIndex, 0, origIndex);
    var nextQueue = order.map(function(i2) {
      return queueSnapshot[i2];
    });
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!session) {
      updateQueueBar();
      return;
    }
    updateSessionSnapshot({ id: session.id, queuedMessages: nextQueue });
    updateQueueBar();
    fetch("/api/structured-sessions/" + session.id + "/queued", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ order })
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return {};
        }).then(function(p) {
          throw new Error(p && p.error || "\u6392\u5E8F\u5931\u8D25");
        });
      }
    }).catch(function(err) {
      rollbackQueueOptimistic(session, queueSnapshot);
      showToast2(err && err.message || "\u8C03\u6574\u6392\u961F\u987A\u5E8F\u5931\u8D25\u3002", "error");
    });
  }
  function attachQueueBarDelegates() {
    var host = document.getElementById("queue-bar-host");
    if (!host || host.__queueDelegated) return;
    host.__queueDelegated = true;
    host.addEventListener("click", function(ev) {
      var evTarget = ev.target;
      var actionEl = evTarget && evTarget.closest ? evTarget.closest("[data-action]") : null;
      if (actionEl && host.contains(actionEl)) {
        var action = actionEl.getAttribute("data-action");
        if (action === "drag") return;
        ev.preventDefault();
        ev.stopPropagation();
        if (action === "promote-item") {
          var pItem = actionEl.closest(".queue-bar-item");
          if (pItem) queueBarPromoteIndex(Number(pItem.getAttribute("data-index")));
        } else if (action === "delete") {
          var itemEl = actionEl.closest(".queue-bar-item");
          if (itemEl) queueBarDeleteItem(Number(itemEl.getAttribute("data-index")));
        } else if (action === "clear-all") {
          queueBarClearAll();
        }
        return;
      }
    });
    host.addEventListener("pointerdown", function(ev) {
      if (ev.button !== void 0 && ev.button !== 0) return;
      var evTarget = ev.target;
      if (evTarget && evTarget.closest && evTarget.closest(
        '[data-action="delete"], [data-action="promote-item"], [data-action="clear-all"], [data-action="expand"]'
      )) return;
      var chip = evTarget && evTarget.closest ? evTarget.closest(".queue-bar-item") : null;
      if (!chip) return;
      queueBarDragStart(ev, chip);
    });
    host.addEventListener("keydown", function(ev) {
      if (ev.key === "Escape" && isQueueBarExpanded()) {
        ev.stopPropagation();
        setQueueBarExpanded(false);
      }
    });
  }
  function buildMessagesForRender(session, messages) {
    var sanitized = Array.isArray(messages) ? stripRenderOnlyStructuredMessages(messages) : [];
    var base = Array.isArray(sanitized) ? sanitized.slice() : [];
    if (!session || session.sessionKind !== "structured") {
      return base;
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
    var session = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    syncStructuredQueueFromSession(session);
    updateStructuredQueueCounter();
  }
  function getInputErrorMessage(error) {
    var selectedSession = getSelectedSession3();
    var isCodex = selectedSession && selectedSession.provider === "codex";
    if (error && (error.errorCode === "SESSION_NOT_RUNNING" || error.errorCode === "SESSION_NO_PTY")) {
      return isCodex ? "Codex \u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF1B\u82E5\u5B58\u5728 Codex \u5386\u53F2\u4F1A\u8BDD\uFF0C\u5C06\u5728\u4F60\u4E0B\u6B21\u53D1\u9001\u6D88\u606F\u65F6\u81EA\u52A8\u6062\u590D\u3002" : "\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF1B\u82E5\u5B58\u5728 Claude \u5386\u53F2\u4F1A\u8BDD\uFF0C\u5C06\u5728\u4F60\u4E0B\u6B21\u53D1\u9001\u6D88\u606F\u65F6\u81EA\u52A8\u6062\u590D\u3002";
    }
    if (error && error.errorCode === "SESSION_NOT_FOUND") {
      return "\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6216\u65B0\u5EFA\u4F1A\u8BDD\u3002";
    }
    return error && error.message || (isCodex ? "Codex \u4F1A\u8BDD\u6682\u4E0D\u53EF\u7528\uFF1B\u82E5\u5B58\u5728 Codex \u5386\u53F2\u4F1A\u8BDD\uFF0C\u5C06\u81EA\u52A8\u5C1D\u8BD5\u6062\u590D\u3002" : "\u4F1A\u8BDD\u6682\u4E0D\u53EF\u7528\uFF1B\u82E5\u5B58\u5728 Claude \u5386\u53F2\u4F1A\u8BDD\uFF0C\u5C06\u81EA\u52A8\u5C1D\u8BD5\u6062\u590D\u3002");
  }
  function buildInputError(payload) {
    var err = new Error(payload && payload.error || "\u4F1A\u8BDD\u5DF2\u7ED3\u675F\u3002");
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
    return !!(session && !isStructuredSession2(session) && (session.provider === "claude" || session.provider === "codex") && session.status !== "running" && session.claudeSessionId);
  }
  function ensureSessionReadyForInput(session, errorEl) {
    if (!session) {
      showToast2("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6216\u65B0\u5EFA\u4F1A\u8BDD\u3002", "error");
      return Promise.resolve(null);
    }
    if (session.status === "running") {
      return Promise.resolve(session);
    }
    if (!canAutoResumeSession(session)) {
      var providerLabel = session && session.provider === "codex" ? "Codex" : "Claude";
      showToast2("\u8BE5\u4F1A\u8BDD\u6CA1\u6709\u53EF\u6062\u590D\u7684 " + providerLabel + " \u5386\u53F2\u4E0A\u4E0B\u6587\uFF0C\u8BF7\u65B0\u5EFA\u4F1A\u8BDD\u3002", "error");
      return Promise.resolve(null);
    }
    return resumeSession(session.id, errorEl).then(function(data) {
      if (!data) return null;
      updateSessionSnapshot(data);
      updateSessionsList();
      subscribeToSession(data.id);
      return loadOutput(data.id).then(function() {
        focusInputBox3(true);
        return data;
      });
    });
  }
  function getTerminalSubmitChunks(session, text) {
    return [text, String.fromCharCode(13)];
  }
  function sendTerminalChunks(chunks, shortcutKey, delayMs, viewOverride) {
    var sequence = Array.isArray(chunks) ? chunks.filter(function(chunk) {
      return !!chunk;
    }) : [];
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
            return queueDirectInput4(chunk, index === sequence.length - 1 ? shortcutKey : void 0, viewOverride);
          });
        }
        return queueDirectInput4(chunk, index === sequence.length - 1 ? shortcutKey : void 0, viewOverride);
      });
    }, Promise.resolve());
  }
  var PENDING_INPUT_TTL_MS = 5e3;
  var PENDING_INPUT_MAX = 100;
  function enqueuePendingInput(input) {
    if (!input) return;
    if (state.pendingMessages.length >= PENDING_INPUT_MAX) {
      state.pendingMessages.shift();
    }
    state.pendingMessages.push({ input, at: Date.now() });
  }
  function queueOfflineTerminalChunks(chunks) {
    var sequence = Array.isArray(chunks) ? chunks.filter(function(chunk) {
      return !!chunk;
    }) : [];
    sequence.forEach(function(chunk) {
      enqueuePendingInput(chunk);
    });
  }
  function _detectAndMarkClear(input) {
    if (typeof input !== "string" || !input) return;
    var stripped = input.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
    if (/(?:^|\n)\s*\/clear\s*(?:\r|\n|$)/.test(stripped)) {
      if (typeof state !== "undefined" && state) {
        state.terminalOutputMarker = (state.terminalOutput && state.terminalOutput.length) | 0;
      }
    }
  }
  function queueDirectInput4(input, shortcutKey, viewOverride) {
    if (!input || !state.selectedId) return Promise.resolve();
    _detectAndMarkClear(input);
    state.messageQueue.push(input);
    state.inputQueue = state.inputQueue.then(function() {
      return postInput3(input, shortcutKey, viewOverride).finally(function() {
        var idx = state.messageQueue.indexOf(input);
        if (idx > -1) state.messageQueue.splice(idx, 1);
      });
    });
    return state.inputQueue;
  }
  function postInput3(input, shortcutKey, viewOverride) {
    if (!state.selectedId) return Promise.resolve();
    var requestSessionId = state.selectedId;
    var effectiveView = viewOverride || state.currentView;
    if (!isSelectedSessionRunning()) {
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
      showToast2("\u4F1A\u8BDD\u672A\u8FD0\u884C\uFF0C\u6B63\u5728\u7B49\u5F85\u81EA\u52A8\u6062\u590D\u540E\u91CD\u8BD5\u3002", "info");
      return Promise.resolve();
    }
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
      body: JSON.stringify({ input, view: effectiveView, shortcutKey: shortcutKey || void 0 })
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return { error: "\u8BF7\u6C42\u5931\u8D25" };
        }).then(function(payload) {
          var error = buildInputError(payload);
          error.httpStatus = res.status;
          console.error("[wand] postInput: request failed", {
            status: res.status,
            errorCode: error.errorCode,
            message: error.message,
            sessionId: requestSessionId
          });
          if (isSessionUnavailableError(error)) {
            markSessionStopped(requestSessionId, error.sessionStatus || "exited");
          }
          throw error;
        });
      }
      return res.json();
    }).then(function(snapshot) {
      if (snapshot && snapshot.id) {
        updateSessionSnapshot(snapshot);
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
    return queueDirectInput4(input);
  }
  function getSelectedSession3() {
    return state.sessions.find(function(session) {
      return session.id === state.selectedId;
    }) || null;
  }
  function getTerminalSubmitSequence(session) {
    return session && session.provider === "codex" ? "\n" : String.fromCharCode(13);
  }
  function isTerminalInteractionAvailable2() {
    return !!state.selectedId && state.currentView === "terminal";
  }
  function isCurrentTerminalSession(sessionId) {
    if (!state.terminal || !sessionId) return false;
    if (sessionId !== state.selectedId) return false;
    if (state.terminalSessionId && state.terminalSessionId !== sessionId) return false;
    return true;
  }
  function shouldCaptureTerminalEvent(event) {
    if (!state.terminalInteractive || !isTerminalInteractionAvailable2()) return false;
    if (event.defaultPrevented || event.isComposing) return false;
    var target = event.target;
    if (!target) return true;
    if (document.documentElement.classList.contains("is-wand-embed-terminal") && target.closest && target.closest("#input-box")) {
      return false;
    }
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
    shift_tab: String.fromCharCode(27) + "[Z",
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
  var JOYSTICK_LONG_PRESS_MS = 400;
  var JOYSTICK_MOVE_THRESHOLD = 10;
  var JOYSTICK_TAP_THRESHOLD = 8;
  var JOYSTICK_BALL_SIZE = 54;
  var JOYSTICK_EDGE_MARGIN = 8;
  var JOYSTICK_ACTION_KEYS = [
    { key: "enter", label: "Enter" },
    { key: "ctrl_c", label: "Ctrl+C" },
    { key: "escape", label: "Esc" },
    { key: "shift_tab", label: "Shift+Tab" }
  ];
  var ignoredInteractiveTargetIds = /* @__PURE__ */ new Set([
    "mini-keyboard-fab",
    "mini-keyboard-toggle",
    "terminal-interactive-toggle"
  ]);
  function shouldIgnoreInteractiveTarget(target) {
    return !!(target && ignoredInteractiveTargetIds.has(target.id));
  }
  var modifierKeySet = /* @__PURE__ */ new Set(["ctrl", "alt", "shift"]);
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
      // 仅对单字符键保留 shift（控制 toUpperCase 路径），
      // 但 Tab 特例：物理 Shift+Tab 要走 buildPtySequence 的 back-tab 分支。
      shift: event.shiftKey && (key.length === 1 || key === "tab"),
      meta: event.metaKey
    };
  }
  function sendTerminalSequence(sequence, shortcutKey) {
    if (!sequence) return;
    queueDirectInput4(sequence, shortcutKey).catch(function() {
    });
  }
  function focusTerminalInteractionTarget() {
    focusTerminalContainer();
  }
  function hideMiniKeyboard(clearModifiersOnHide) {
    state.keyboardPopupOpen = false;
    if (clearModifiersOnHide !== false) {
      clearModifiers();
    }
    updateKeyboardPopupUI();
  }
  function toggleTerminalInteractive() {
    if (!isTerminalInteractionAvailable2()) return;
    setTerminalInteractive(!state.terminalInteractive);
  }
  function setTerminalInteractive(enabled) {
    var next = !!enabled && isTerminalInteractionAvailable2();
    if (state.terminalInteractive === next) return;
    state.terminalInteractive = next;
    if (next) {
      enableTerminalCapture();
      hideMiniKeyboard(false);
      focusTerminalInteractionTarget();
      showToast2("\u7EC8\u7AEF\u4EA4\u4E92\u6A21\u5F0F\u5DF2\u5F00\u542F", "info");
    } else {
      disableTerminalCapture();
      clearModifiers();
    }
    updateInteractiveControls3();
  }
  function reconcileInteractiveState() {
    var selectedSession = state.sessions.find(function(session) {
      return session.id === state.selectedId;
    });
    var shouldDisableInteractive = !selectedSession || selectedSession.status !== "running" || state.currentView !== "terminal";
    if (shouldDisableInteractive && state.terminalInteractive) {
      setTerminalInteractive(false);
      return;
    }
    if ((!selectedSession || state.currentView !== "terminal") && state.keyboardPopupOpen) {
      state.keyboardPopupOpen = false;
    }
    updateInteractiveControls3();
  }
  function updateInteractiveControls3() {
    var selectedSession = state.sessions.find(function(session) {
      return session.id === state.selectedId;
    });
    var structured = isStructuredSession2(selectedSession);
    var isCodex = selectedSession && selectedSession.provider === "codex";
    var isRunning = structured ? !!(selectedSession && selectedSession.structuredState && selectedSession.structuredState.inFlight) : !!selectedSession && selectedSession.status === "running";
    var composer = document.getElementById("input-box");
    var toggles = ["terminal-interactive-toggle-top"];
    toggles.forEach(function(id) {
      var toggle = document.getElementById(id);
      if (toggle) {
        toggle.classList.toggle("active", state.terminalInteractive);
        toggle.classList.toggle("is-on", state.terminalInteractive);
        toggle.classList.toggle("hidden", structured || state.currentView !== "terminal" || !selectedSession);
        toggle.setAttribute("aria-pressed", state.terminalInteractive ? "true" : "false");
        var stateLabel = toggle.querySelector(".plus-popover-toggle-state");
        if (stateLabel) stateLabel.textContent = state.terminalInteractive ? "\u5F00" : "\u5173";
      }
    });
    var inputHint = document.querySelector(".input-hint");
    if (inputHint) {
      inputHint.classList.toggle("hidden", structured ? true : state.currentView === "terminal");
      if (!structured && selectedSession) {
        inputHint.textContent = isCodex ? "Enter \u53D1\u9001 \xB7 chat \u4E3A\u89E3\u6790\u89C6\u56FE\uFF0Cterminal \u4E3A\u539F\u59CB\u8F93\u51FA" : "Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C";
      }
    }
    var canResumeOnSend = !structured && !isRunning && canAutoResumeSession(selectedSession);
    if (composer) {
      composer.placeholder = getComposerPlaceholder(selectedSession, state.terminalInteractive);
      composer.disabled = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
      composer.setAttribute("aria-disabled", composer.disabled ? "true" : "false");
      composer.readOnly = false;
      composer.classList.toggle(
        "is-terminal-passthrough",
        !!state.terminalInteractive && !document.documentElement.classList.contains("is-wand-embed-terminal")
      );
    }
    var composerEl = document.querySelector(".input-composer");
    if (composerEl && state.terminalInteractive && composerEl.classList.contains("voice-mode")) {
      composerEl.classList.remove("voice-mode");
      voiceState.recording = false;
      resetVoiceRecordingUI();
    }
    var sendBtn = document.getElementById("send-input-button");
    var structuredInFlight = structured && isRunning;
    if (sendBtn) {
      sendBtn.disabled = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
      sendBtn.setAttribute("title", structured ? structuredInFlight ? "\u6392\u961F\u53D1\u9001\uFF08\u5F53\u524D\u56DE\u590D\u7ED3\u675F\u540E\u5904\u7406\uFF09" : "\u53D1\u9001" : isCodex ? isRunning ? "\u53D1\u9001\u7ED9 Codex" : "Codex \u4F1A\u8BDD\u5DF2\u7ED3\u675F" : !selectedSession || isRunning || canResumeOnSend ? "\u53D1\u9001" : "\u4F1A\u8BDD\u5DF2\u7ED3\u675F");
      sendBtn.classList.toggle("queue-mode", structuredInFlight);
    }
    var stopBtn = document.getElementById("stop-button");
    if (stopBtn) {
      var sig = computeRunningSignal2(selectedSession);
      stopBtn.classList.toggle("hidden", !sig.active);
    }
    var stopBtnEl = document.getElementById("stop-button");
    if (stopBtnEl) {
      var runSig = computeRunningSignal2(selectedSession);
      stopBtnEl.classList.toggle("hidden", !runSig.active);
    }
    var container = document.getElementById("output");
    if (container) container.classList.toggle("interactive", !structured && state.terminalInteractive);
    updateJoystickVisibility();
  }
  function hasActiveTerminalSelection() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return false;
    var output = document.getElementById("output");
    if (!output) return false;
    var node = sel.anchorNode;
    if (node && node.nodeType === 3) node = node.parentNode;
    return !!(node && output.contains(node));
  }
  function captureTerminalInput2(event) {
    if (!shouldCaptureTerminalEvent(event)) return;
    if (event.metaKey) return;
    var key = keyFromKeyboardEvent(event);
    if (!key) return;
    var mods = getModifierStateFromEvent(event, key);
    if (isModifierKey(key)) return;
    if (mods.ctrl && key.length === 1 && key.toLowerCase() === "c" && hasActiveTerminalSelection()) {
      return;
    }
    var sequence = buildPtySequence(key, mods);
    if (!sequence) return;
    event.preventDefault();
    sendTerminalSequence(sequence, key);
  }
  function scheduleShortcutResync() {
    if (!state.terminal) return;
    scheduleSoftResyncTerminal(500);
  }
  function updateKeyboardPopupUI() {
    updateJoystickPanelUI();
  }
  function handleKeyboardToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    if (state.currentView !== "terminal" || !state.selectedId) return;
    state.keyboardPopupOpen = !state.keyboardPopupOpen;
    updateInteractiveControls3();
  }
  function closeKeyboardPopup() {
    state.keyboardPopupOpen = false;
    updateInteractiveControls3();
  }
  function enableTerminalCapture() {
    document.addEventListener("keydown", captureTerminalInput2, true);
  }
  function disableTerminalCapture() {
    document.removeEventListener("keydown", captureTerminalInput2, true);
  }
  function buildPtySequence(key, modifiers) {
    var mods = modifiers || { ctrl: false, alt: false, shift: false };
    if (isModifierKey(key)) return "";
    if (key === "tab" && mods.shift) return String.fromCharCode(27) + "[Z";
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
    var selectedSession = getSelectedSession3();
    if (isStructuredSession2(selectedSession)) {
      state.pendingMessages = [];
      return;
    }
    var now = Date.now();
    var queue = [];
    var dropped = 0;
    state.pendingMessages.forEach(function(item) {
      if (typeof item === "string") {
        queue.push(item);
        return;
      }
      if (!item || typeof item.input !== "string") return;
      if (now - (item.at || 0) > PENDING_INPUT_TTL_MS) {
        dropped++;
        return;
      }
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
        });
      });
    });
  }
  function sendInputDirect(input) {
    if (!input || !state.selectedId) return Promise.resolve();
    var requestSessionId = state.selectedId;
    return fetch("/api/sessions/" + requestSessionId + "/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ input, view: state.currentView })
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() {
          return { error: "\u8BF7\u6C42\u5931\u8D25" };
        }).then(function(payload) {
          var error = buildInputError(payload);
          error.httpStatus = res.status;
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
    }).then(function(snapshot) {
      if (snapshot && snapshot.id) {
        updateSessionSnapshot(snapshot);
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
    var id = state.selectedId;
    wandConfirm2(t2("stop.confirm.message"), {
      title: t2("stop.confirm.title"),
      danger: true,
      okLabel: t2("stop.confirm.ok"),
      cancelLabel: t2("stop.confirm.cancel")
    }).then(function(ok) {
      if (!ok) return;
      if (state.selectedId !== id) return;
      fetch("/api/sessions/" + id + "/stop", { method: "POST", credentials: "same-origin" }).then(refreshAll);
    });
  }
  function deleteSession(id) {
    var item = document.querySelector('.session-item[data-session-id="' + id + '"]');
    var session = state.sessions.find(function(candidate) {
      return candidate.id === id;
    });
    var providerSessionId = session && session.claudeSessionId;
    if (item) {
      item.classList.add("deleting");
    }
    setTimeout(function() {
      fetch("/api/sessions/" + id, { method: "DELETE", credentials: "same-origin" }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (data && data.error) {
          throw new Error(data.error);
        }
        if (state.selectedId === id) {
          state.selectedId = null;
          persistSelectedId();
        }
        if (providerSessionId) {
          state.claudeHistory = state.claudeHistory.filter(function(history2) {
            return history2.claudeSessionId !== providerSessionId;
          });
          state.codexHistory = state.codexHistory.filter(function(history2) {
            return history2.claudeSessionId !== providerSessionId;
          });
        }
        return refreshAll();
      }).catch(function() {
        if (item) item.classList.remove("deleting");
        var errorEl = document.getElementById("action-error");
        showError2(errorEl, "\u65E0\u6CD5\u5220\u9664\u4F1A\u8BDD\u3002");
      });
    }, 250);
  }
  function executeDeleteHistory(claudeSessionId, item) {
    if (item) {
      item.classList.add("deleting");
    }
    setTimeout(function() {
      fetch("/api/claude-history/" + encodeURIComponent(claudeSessionId), { method: "DELETE", credentials: "same-origin" }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (data && data.error) {
          throw new Error(data.error);
        }
        state.claudeHistory = state.claudeHistory.filter(function(s) {
          return s.claudeSessionId !== claudeSessionId;
        });
        delete state.selectedClaudeHistoryIds[claudeSessionId];
        updateSessionsList();
      }).catch(function() {
        if (item) item.classList.remove("deleting");
        var errorEl = document.getElementById("action-error");
        showError2(errorEl, "\u65E0\u6CD5\u5220\u9664\u4F1A\u8BDD\u3002");
      });
    }, 250);
  }
  function deleteClaudeHistorySession2(claudeSessionId, item) {
    executeDeleteHistory(claudeSessionId, item);
  }
  function deleteClaudeHistoryDirectory(cwd, btn, items) {
    if (!cwd) {
      return;
    }
    fetch("/api/claude-history?cwd=" + encodeURIComponent(cwd), { method: "DELETE", credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && data.error) {
        throw new Error(data.error);
      }
      state.claudeHistory = state.claudeHistory.filter(function(s) {
        return s.cwd !== cwd;
      });
      updateSessionsList();
    }).catch(function() {
      setDeletingState(items, false);
      var errorEl = document.getElementById("action-error");
      showError2(errorEl, "\u65E0\u6CD5\u6E05\u7406\u8BE5\u76EE\u5F55\u7684\u5386\u53F2\u4F1A\u8BDD\u3002");
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
  function initSwipeToDelete(_container) {
    _swipeState = null;
    _swipedItem = null;
  }
  function startCommand(command, cwd, errorEl) {
    if (command === "claude" || command === "codex" || command === "opencode") {
      state.preferredCommand = command;
      state.chatMode = getSafeModeForTool(command, state.chatMode);
    }
    var modelPref = command === "claude" || command === "codex" || command === "opencode" ? getChatModelForProvider(command) : "";
    return fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        command,
        provider: command === "claude" || command === "codex" || command === "opencode" ? command : void 0,
        cwd: cwd || "",
        mode: state.chatMode || state.config.defaultMode || "default",
        model: modelPref || void 0,
        thinkingEffort: state.chatThinking || void 0
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        if (errorEl) showError2(errorEl, data.error);
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
    if (!sessionId || _resumeInProgress) return Promise.resolve(null);
    _resumeInProgress = true;
    return fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        mode: state.chatMode || state.config.defaultMode || "default"
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        if (errorEl) showError2(errorEl, data.error);
        else showToast2(data.error, "error");
        return null;
      }
      state.selectedId = data.id;
      persistSelectedId();
      state.drafts[data.id] = "";
      return data;
    }).catch(function(error) {
      var message = error && error.message || "\u65E0\u6CD5\u6062\u590D\u4F1A\u8BDD\u3002";
      if (errorEl) showError2(errorEl, message);
      else showToast2(message, "error");
      return null;
    }).finally(function() {
      _resumeInProgress = false;
    });
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
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        if (errorEl) showError2(errorEl, data.error);
        else showToast2(data.error, "error");
        return null;
      }
      state.claudeHistory = state.claudeHistory.filter(function(s) {
        return s.claudeSessionId !== claudeSessionId;
      });
      state.selectedId = data.id;
      persistSelectedId();
      state.drafts[data.id] = "";
      return data;
    }).catch(function(error) {
      var message = error && error.message || "\u65E0\u6CD5\u6309 Claude \u4F1A\u8BDD ID \u6062\u590D\u4F1A\u8BDD\u3002";
      if (errorEl) showError2(errorEl, message);
      else showToast2(message, "error");
      return null;
    });
  }
  function activateSession(data) {
    if (!data || !data.id) return Promise.resolve();
    state.selectedId = data.id;
    persistSelectedId();
    state.currentMessages = [];
    teardownTerminal();
    resetChatRenderCache2();
    switchToSessionView2(data.id);
    updateSessionSnapshot(data);
    updateSessionsList();
    subscribeToSession(data.id);
    return loadOutput(data.id).then(function() {
      focusInputBox3(true);
    });
  }
  function resumeSessionFromList(sessionId) {
    return resumeSession(sessionId).then(function(data) {
      if (!data) return null;
      if (data.claudeSessionId) {
        if (data.provider === "codex") {
          state.codexHistory = state.codexHistory.filter(function(s) {
            return s.claudeSessionId !== data.claudeSessionId;
          });
        } else {
          state.claudeHistory = state.claudeHistory.filter(function(s) {
            return s.claudeSessionId !== data.claudeSessionId;
          });
        }
      }
      return activateSession(data).then(function() {
        return data;
      });
    });
  }
  function startAndActivateCommand2(command, cwd, errorEl) {
    return startCommand(command, cwd, errorEl).then(function(data) {
      if (!data) return null;
      return activateSession(data).then(function() {
        return data;
      });
    });
  }
  function createSessionFromWelcomeInput2(value) {
    var welcomeInput = document.getElementById("welcome-input");
    if (!welcomeInput) return;
    welcomeInput.placeholder = "\u6B63\u5728\u601D\u8003\u2026";
    welcomeInput.disabled = true;
    var mode = state.chatMode || "managed";
    var defaultCwd = getEffectiveCwd3();
    var preferredTool = getPreferredTool();
    var modelPref = getChatModelForProvider(preferredTool);
    fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        command: preferredTool,
        cwd: defaultCwd,
        mode,
        initialInput: value,
        model: modelPref || void 0,
        thinkingEffort: state.chatThinking || void 0
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        welcomeInput.placeholder = "\u8F93\u5165\u6D88\u606F";
        welcomeInput.disabled = false;
        return null;
      }
      return activateSession(data);
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u542F\u52A8\u4F1A\u8BDD\u3002", "error");
      welcomeInput.placeholder = "\u8F93\u5165\u6D88\u606F";
      welcomeInput.disabled = false;
    }).finally(function() {
      welcomeInput.placeholder = "\u8F93\u5165\u6D88\u606F";
      welcomeInput.disabled = false;
    });
  }
  function createSessionFromInput2(value, inputBox, welcomeInput) {
    var mode = state.chatMode || "managed";
    var defaultCwd = getEffectiveCwd3();
    var preferredTool = getPreferredTool();
    var modelPref = getChatModelForProvider(preferredTool);
    fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        command: preferredTool,
        cwd: defaultCwd,
        mode,
        initialInput: value || void 0,
        model: modelPref || void 0,
        thinkingEffort: state.chatThinking || void 0
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        return null;
      }
      if (inputBox) inputBox.value = "";
      if (welcomeInput) welcomeInput.value = "";
      return activateSession(data);
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u542F\u52A8\u4F1A\u8BDD\u3002", "error");
    });
  }
  function handleResumeAction(actionButton) {
    actionButton.disabled = true;
    resumeSessionFromList(actionButton.dataset.sessionId).finally(function() {
      actionButton.disabled = false;
    });
  }
  function handleResumeCodexHistoryAction(actionButton) {
    var threadId = actionButton.dataset.claudeSessionId;
    var cwd = actionButton.dataset.cwd;
    if (!threadId) return;
    actionButton.disabled = true;
    resumeCodexHistorySession(threadId, cwd).then(function(data) {
      if (data && data.id) {
        state.codexHistory = state.codexHistory.filter(function(s) {
          return s.claudeSessionId !== threadId;
        });
        state.selectedId = data.id;
        persistSelectedId();
        state.drafts[data.id] = "";
        activateSession(data).then(function() {
          dismissDrawerIfOverlay();
        });
      }
    }).finally(function() {
      actionButton.disabled = false;
    });
  }
  function resumeCodexHistorySession(threadId, cwd) {
    return fetch("/api/codex-sessions/" + encodeURIComponent(threadId) + "/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        mode: state.chatMode || state.config && state.config.defaultMode || "default",
        cwd
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        return null;
      }
      return data;
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u6062\u590D\u4F1A\u8BDD\u3002", "error");
      return null;
    });
  }
  function handleDeleteCodexHistoryAction(actionButton) {
    var threadId = actionButton.dataset.claudeSessionId;
    if (!threadId) return;
    confirmDelete("\u786E\u8BA4\u5220\u9664\u8FD9\u6761 Codex \u4F1A\u8BDD\u5417\uFF1F", {
      title: "\u5220\u9664\u4F1A\u8BDD"
    }).then(function(ok) {
      if (!ok) return;
      var item = actionButton.closest(".session-item");
      if (item) item.style.opacity = "0.5";
      fetch("/api/codex-history/" + encodeURIComponent(threadId), {
        method: "DELETE",
        credentials: "same-origin"
      }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (data && data.ok) {
          state.codexHistory = state.codexHistory.filter(function(s) {
            return s.claudeSessionId !== threadId;
          });
          updateSessionsList();
        } else if (item) {
          item.style.opacity = "1";
        }
      }).catch(function() {
        if (item) item.style.opacity = "1";
      });
    });
  }
  function handleResumeHistoryAction(actionButton) {
    var claudeSessionId = actionButton.dataset.claudeSessionId;
    var cwd = actionButton.dataset.cwd;
    if (!claudeSessionId) return;
    actionButton.disabled = true;
    resumeClaudeHistorySession(claudeSessionId, cwd).then(function(data) {
      if (data && data.id) {
        state.claudeHistory = state.claudeHistory.filter(function(s) {
          return s.claudeSessionId !== claudeSessionId;
        });
        state.selectedId = data.id;
        persistSelectedId();
        state.drafts[data.id] = "";
        activateSession(data).then(function() {
          dismissDrawerIfOverlay();
        });
      }
    }).finally(function() {
      actionButton.disabled = false;
    });
  }
  function resumeClaudeHistorySession(claudeSessionId, cwd) {
    return fetch("/api/claude-sessions/" + encodeURIComponent(claudeSessionId) + "/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(withTerminalDimensions({
        mode: state.chatMode || state.config && state.config.defaultMode || "default",
        cwd
      }))
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        return null;
      }
      return data;
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u6062\u590D\u4F1A\u8BDD\u3002", "error");
      return null;
    });
  }
  function isTouchDevice() {
    return "ontouchstart" in window || navigator.maxTouchPoints > 0;
  }
  function focusInputBox3(skipMobile) {
    if (state.terminalInteractive) return;
    var inputBox = document.getElementById("input-box");
    if (!inputBox || !state.selectedId) return;
    if (document.activeElement === inputBox) return;
    if (skipMobile && isTouchDevice()) return;
    focusInputWithSelection(inputBox);
  }
  function scrollLatestMessageIntoView() {
    var chatMessages = document.querySelector(".chat-messages");
    if (!chatMessages) return;
    chatMessages.scrollTop = 0;
  }
  function updateInputPanelViewportSpacing() {
    var inputPanel = document.querySelector(".input-panel");
    if (!inputPanel) return;
    inputPanel.style.removeProperty("--keyboard-offset");
  }
  function resetInputPanelViewportSpacing() {
    var inputPanel = document.querySelector(".input-panel");
    if (!inputPanel) return;
    inputPanel.style.removeProperty("--keyboard-offset");
  }
  function restoreInputBoxViewport(inputBox) {
    if (!inputBox) return;
    var start = inputBox.selectionStart;
    var end = inputBox.selectionEnd;
    syncInputBoxScroll(inputBox);
    if (typeof start === "number" && typeof end === "number") {
      inputBox.setSelectionRange(start, end);
    }
  }
  function bindInputTouchScroll(inputBox) {
    if (!inputBox || inputBox.dataset.touchScrollBound === "true") return;
    inputBox.dataset.touchScrollBound = "true";
    inputBox.addEventListener("touchstart", function() {
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
    var inputBox = event && event.target ? event.target : document.getElementById("input-box");
    if (!inputBox) return;
    updateInputPanelViewportSpacing();
    syncInputBoxLayout(inputBox);
  }
  function handleInputBoxBlur2(event) {
    var blurredEl = event && event.target ? event.target : document.getElementById("input-box");
    resetInputPanelViewportSpacing();
    scheduleClosedViewportBaselineWindow(2200, blurredEl);
    var dismissTicks = [80, 200, 380, 620, 900];
    dismissTicks.forEach(function(delay, idx) {
      setTimeout(function() {
        syncAppViewportHeight(false);
        if (idx === 1 && isTouchDevice()) {
          ensureTerminalFit2("keyboard-blur", { forceReplay: true });
          maybeScrollTerminalToBottom("keyboard");
        }
      }, delay);
    });
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
    if (isTouchDevice()) return;
    var inputBox = document.getElementById("input-box");
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
  function setupMobileKeyboardHandlers() {
    var inputPanel = document.querySelector(".input-panel");
    var chatMessages = document.querySelector(".chat-messages");
    if ("virtualKeyboard" in navigator) {
      var vk = navigator.virtualKeyboard;
      vk.addEventListener("geometrychange", function() {
        if (!inputPanel) return;
        inputPanel.style.removeProperty("padding-bottom");
      });
    }
    var output = document.getElementById("output");
    if (output) {
      output.addEventListener("click", function() {
        focusInputFromTap();
      });
    }
    if (chatMessages) {
      chatMessages.addEventListener("click", function(e) {
        var target = e.target;
        if (target.tagName !== "A" && target.tagName !== "BUTTON" && !target.closest("button") && !target.closest("[data-tool-toggle]")) {
          focusInputFromTap();
        }
      });
    }
    document.addEventListener("click", function(e) {
      if (!isTouchDevice()) return;
      var inputBox = document.getElementById("input-box");
      if (!inputBox || document.activeElement !== inputBox) return;
      var target = e.target;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest(".input-panel") || target.closest("#mini-keyboard") || target.closest("#mini-keyboard-fab") || target.closest("#mini-keyboard-toggle") || target.closest("#terminal-interactive-toggle") || target.closest(".wand-joystick-root")) {
        return;
      }
      inputBox.blur();
    }, true);
  }
  function resetRootViewportScroll() {
    try {
      window.scrollTo(0, 0);
    } catch (e) {
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }

  // src/web-ui/browser/chat-render.ts
  function renderChat(forceFullRender) {
    if (state.renderPending && !forceFullRender) return;
    state.renderPending = true;
    if (forceFullRender) {
      doRenderChat(true);
      state.renderPending = false;
    } else {
      requestAnimationFrame(function() {
        doRenderChat(false);
        state.renderPending = false;
      });
    }
  }
  state.chatRenderTimer = null;
  function scheduleChatRender3(immediate) {
    if (state.chatRenderTimer && !immediate) return;
    if (state.chatRenderTimer) clearTimeout(state.chatRenderTimer);
    if (immediate) {
      state.chatRenderTimer = null;
      renderChat();
      return;
    }
    try {
      window.__scheduleChatRender = function() {
        scheduleChatRender3(true);
      };
    } catch (e) {
    }
    var selectedForDelay = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var isActiveStream = selectedForDelay && selectedForDelay.status === "running" && selectedForDelay.sessionKind !== "structured";
    var delay = isActiveStream ? CHAT_RENDER_LIVE_MS : CHAT_RENDER_IDLE_MS;
    state.chatRenderTimer = setTimeout(function() {
      state.chatRenderTimer = null;
      var selectedSession = state.sessions.find(function(s) {
        return s.id === state.selectedId;
      });
      if (selectedSession) {
        state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
      }
      renderChat();
    }, delay);
  }
  function extractPtySystemInfo(output, messages) {
    if (!output || !messages || messages.length === 0) return [];
    function stripAnsi2(text) {
      return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
    }
    var clean = stripAnsi2(output);
    var systemInfo = [];
    var userInputs = [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") {
        var userText = "";
        var content = messages[i].content;
        if (typeof content === "string") {
          userText = content;
        } else if (Array.isArray(content)) {
          for (var j = 0; j < content.length; j++) {
            if (content[j].type === "text") {
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
    var lastPos = 0;
    for (var i = 0; i < userInputs.length; i++) {
      var userInput = userInputs[i];
      var pos = clean.indexOf("\u276F " + userInput.text, lastPos);
      if (pos === -1) {
        pos = clean.indexOf("\n\u276F " + userInput.text, lastPos);
        if (pos !== -1) pos += 1;
      }
      if (pos > lastPos) {
        var segment = clean.substring(lastPos, pos);
        var lines = segment.split("\n");
        var infoLines = [];
        for (var j = 0; j < lines.length; j++) {
          var line = lines[j].trim();
          if (!line || line.startsWith("\u2500\u2500\u2500\u2500") || line === "\u276F" || line === "?" || line === "") continue;
          if (line.includes("Claude Code v") || line.includes("Opus") && line.includes("with") || line.includes("Sonnet") && line.includes("with") || line.includes("API Usage") || line.includes("Billing") || line.includes("for shortcuts") || line.includes("/effort") || line.match(/^[▸▐▝▘▗▖█▌▍▎▏▔▁▂▃▄▅▆▇██]/) || line.match(/^[▸▐▝▘▗▖█▌▍▎▏▔▁▂▃▄▅▆▇██]{3,}/)) {
            continue;
          }
          if (line.length > 3) {
            infoLines.push(line);
          }
        }
        if (infoLines.length > 0) {
          systemInfo.push({
            beforeMessage: userInput.index,
            content: infoLines.join("\n")
          });
        }
      }
      lastPos = pos + userInput.text.length + 2;
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
  function renderChatEmptyState2(chatOutput, html) {
    var chatMessages = ensureChatMessagesContainer(chatOutput);
    if (!chatMessages) return null;
    chatMessages.innerHTML = html;
    refreshTailMarqueePaths(chatMessages);
    bindChatScrollListener();
    updateChatUnreadBubble();
    return chatMessages;
  }
  function doRenderChat(forceFullRender) {
    var chatOutput = document.getElementById("chat-output");
    if (!chatOutput) return;
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!selectedSession) {
      if (state.lastRenderedEmpty !== "none") {
        renderChatEmptyState2(chatOutput, '<div class="empty-state"><strong>\u672A\u9009\u62E9\u4F1A\u8BDD</strong><br>\u70B9\u51FB\u4E0A\u65B9\u300C\u65B0\u5BF9\u8BDD\u300D\u5F00\u59CB\u4F60\u7684\u7B2C\u4E00\u6B21\u5BF9\u8BDD\u3002</div>');
        state.lastRenderedEmpty = "none";
        state.lastRenderedMsgCount = 0;
      }
      return;
    }
    var allMessages = state.currentMessages;
    var legacyTaskMap = collectLegacyTaskIdMap(allMessages);
    _subagentSuffixMap = collectSubagentSuffixMap(allMessages);
    if (allMessages.length === 0) {
      if (state.lastRenderedEmpty !== "empty") {
        var emptyTrioHtml = "";
        if (isStructuredSession2(selectedSession)) {
          emptyTrioHtml = '<div class="empty-state-trio-wrap"><div class="empty-state-trio-hint">\u9ED8\u8BA4\u4F1A\u6309\u4EE5\u4E0B\u8BBE\u7F6E\u53D1\u9001\uFF0C\u53EF\u70B9\u51FB\u8C03\u6574\uFF1A</div>' + renderChatModeTrioHtml(selectedSession, { kind: "dropdown" }) + "</div>";
        }
        renderChatEmptyState2(
          chatOutput,
          '<div class="empty-state"><strong>\u5BF9\u8BDD\u5DF2\u5F00\u59CB</strong><br>\u5728\u4E0B\u65B9\u8F93\u5165\u6846\u53D1\u9001\u6D88\u606F\uFF0CClaude \u4F1A\u81EA\u52A8\u56DE\u590D\u3002</div>' + emptyTrioHtml
        );
        state.lastRenderedEmpty = "empty";
        state.lastRenderedMsgCount = 0;
      }
      renderStructuredStatusBar(null, selectedSession);
      updateTodoProgress([]);
      return;
    }
    var totalMsgCount = allMessages.length;
    if (totalMsgCount > state.chatRenderedCount) {
      state.chatRenderedCount = totalMsgCount;
    }
    var visibleOffset = Math.max(0, totalMsgCount - state.chatRenderedCount);
    var messages = visibleOffset > 0 ? allMessages.slice(visibleOffset) : allMessages;
    var hasServerOlder = typeof selectedSession.messageOffset === "number" && selectedSession.messageOffset > 0;
    var hasOlderMessages = visibleOffset > 0 || hasServerOlder;
    var msgCount = messages.length;
    var outputHash = selectedSession.output ? selectedSession.output.length : 0;
    if (selectedSession.messages && selectedSession.messages.length > 0) {
      var totalBlocks = 0;
      var contentLen = 0;
      for (var bi = 0; bi < selectedSession.messages.length; bi++) {
        var msgContent = selectedSession.messages[bi].content;
        if (msgContent) {
          if (Array.isArray(msgContent)) {
            totalBlocks += msgContent.length;
            for (var bj = 0; bj < msgContent.length; bj++) {
              var block = msgContent[bj];
              if (block.text) contentLen += block.text.length;
              if (block.thinking) contentLen += block.thinking.length;
              if (block.content) contentLen += block.content.length;
              if (block.id) contentLen += block.id.length;
              if (block.tool_use_id) contentLen += block.tool_use_id.length;
              if (block.description) contentLen += block.description.length;
              if (block.input) contentLen += JSON.stringify(block.input).length;
            }
            if (selectedSession.messages[bi].usage) {
              var hashUsage = selectedSession.messages[bi].usage;
              contentLen += (hashUsage.inputTokens || 0) + (hashUsage.outputTokens || 0) + (hashUsage.cacheReadInputTokens || 0) + (hashUsage.cacheCreationInputTokens || 0) + (hashUsage.reasoningOutputTokens || 0) + Math.round((hashUsage.totalCostUsd || 0) * 1e6) + (hashUsage.estimated === true ? 1 : 0);
            }
          } else {
            totalBlocks += 1;
            contentLen = String(msgContent).length;
          }
        }
      }
      outputHash = msgCount * 1e5 + totalBlocks * 1e3 + contentLen;
    }
    var forceRender = forceFullRender || msgCount !== state.lastRenderedMsgCount;
    if (!forceRender && msgCount === state.lastRenderedMsgCount && outputHash === state.lastRenderedHash) {
      var chatMessages = chatOutput.querySelector(".chat-messages");
      if (chatMessages) renderStructuredStatusBar(chatMessages, selectedSession);
      updateTodoProgress(allMessages);
      return;
    }
    var prevHash = state.lastRenderedHash;
    var prevMsgCount = state.lastRenderedMsgCount;
    state.lastRenderedMsgCount = msgCount;
    state.lastRenderedHash = outputHash;
    chatMessages = ensureChatMessagesContainer(chatOutput);
    if (!chatMessages) return;
    var renderWasAtBottom = isChatNearBottom(chatMessages);
    var renderIsInitial = !state.chatInitialRenderDone;
    var existingCount = chatMessages.querySelectorAll(".chat-message:not(.system-info)").length;
    var needsFullRender = forceRender || existingCount === 0 || msgCount !== existingCount;
    function fullRenderChat() {
      var systemInfo = extractPtySystemInfo(selectedSession.output, messages);
      var html = "";
      var reversedMessages2 = messages.slice().reverse();
      var visibleCount = messages.length;
      for (var i2 = 0; i2 < reversedMessages2.length; i2++) {
        var msg = reversedMessages2[i2];
        var localIndex = visibleCount - 1 - i2;
        var originalIndex = localIndex + visibleOffset;
        var sysInfo = null;
        for (var j = 0; j < systemInfo.length; j++) {
          if (systemInfo[j].beforeMessage === localIndex) {
            sysInfo = systemInfo[j];
            break;
          }
        }
        if (sysInfo) {
          html += '<div class="chat-message system-info"><div class="system-info-card"><div class="system-info-header">\u2139\uFE0F \u7CFB\u7EDF\u4FE1\u606F</div><div class="system-info-content">' + escapeHtml2(sysInfo.content) + "</div></div></div>";
        }
        html += renderChatMessage(msg, roundUsageByIndex[originalIndex] || null, originalIndex, legacyTaskMap);
      }
      if (hasOlderMessages) {
        var loadMoreLabel = visibleOffset > 0 ? "\u52A0\u8F7D\u66F4\u65E9\u7684 " + Math.min(state.chatPageSize, visibleOffset) + " \u6761\u6D88\u606F" : "\u52A0\u8F7D\u66F4\u65E9\u7684\u6D88\u606F";
        html += '<div class="chat-load-more" id="chat-load-more-sentinel"><button class="chat-load-more-btn" type="button">' + loadMoreLabel + "</button></div>";
      }
      var anchorMsgIndex = -1;
      var anchorOffset = 0;
      if (existingCount > 0 && !renderWasAtBottom) {
        var containerTop = chatMessages.getBoundingClientRect().top;
        var preEls = chatMessages.querySelectorAll(".chat-message:not(.system-info)");
        for (var pi = 0; pi < preEls.length; pi++) {
          var rect = preEls[pi].getBoundingClientRect();
          if (rect.bottom >= containerTop) {
            var idxAttr = preEls[pi].getAttribute("data-msg-index");
            if (idxAttr != null) {
              anchorMsgIndex = parseInt(idxAttr, 10);
              anchorOffset = rect.top - containerTop;
            }
            break;
          }
        }
      }
      chatMessages.innerHTML = html;
      (function() {
        var msgEls = chatMessages.querySelectorAll(".chat-message:not(.system-info)");
        var totalVisible = msgEls.length;
        for (var idx = 0; idx < totalVisible; idx++) {
          msgEls[idx].setAttribute("data-msg-index", String(visibleOffset + totalVisible - 1 - idx));
        }
      })();
      refreshTailMarqueePaths(chatMessages);
      if (prevMsgCount === 0 && !state.chatInitialRenderDone) {
        chatMessages.scrollTop = 0;
        state.chatStickToBottom = true;
        clearChatUnread({ removeDivider: true });
        state.chatInitialRenderDone = true;
      } else if (prevMsgCount === 0 && state.chatStickToBottom) {
        chatMessages.scrollTop = 0;
      } else if (renderWasAtBottom) {
        chatMessages.scrollTop = 0;
      } else if (anchorMsgIndex >= 0) {
        var newAnchor = chatMessages.querySelector(
          '.chat-message[data-msg-index="' + anchorMsgIndex + '"]'
        );
        if (newAnchor) {
          var newContainerTop = chatMessages.getBoundingClientRect().top;
          var newRect = newAnchor.getBoundingClientRect();
          var delta = newRect.top - newContainerTop - anchorOffset;
          if (Math.abs(delta) > 0.5) {
            state.chatIsProgrammaticScroll = true;
            chatMessages.scrollTop += delta;
            requestAnimationFrame(function() {
              state.chatIsProgrammaticScroll = false;
            });
          }
        }
      }
      attachAllCopyHandlers(chatMessages);
      bindChatScrollListener();
      applyPersistedExpandState(chatMessages);
      requestAnimationFrame(function() {
        refreshChatUnreadDivider(chatMessages);
        updateChatUnreadBubble();
        observeLoadMoreSentinel();
      });
    }
    var roundUsageByIndex = {};
    (function() {
      var acc = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalCostUsd: 0, estimated: false };
      var hasUsage = false;
      var lastAssistantIdx = -1;
      for (var mi2 = 0; mi2 < allMessages.length; mi2++) {
        var m = allMessages[mi2];
        if (m.role === "user") {
          if (lastAssistantIdx >= 0 && hasUsage) {
            roundUsageByIndex[lastAssistantIdx] = acc;
          }
          acc = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalCostUsd: 0, estimated: false };
          hasUsage = false;
          lastAssistantIdx = -1;
        } else if (m.role === "assistant" && m.usage) {
          var u = m.usage;
          hasUsage = true;
          acc.inputTokens += u.inputTokens || 0;
          acc.outputTokens += u.outputTokens || 0;
          acc.cacheReadInputTokens += u.cacheReadInputTokens || 0;
          acc.cacheCreationInputTokens += u.cacheCreationInputTokens || 0;
          acc.reasoningOutputTokens += u.reasoningOutputTokens || 0;
          acc.totalCostUsd += u.totalCostUsd || 0;
          acc.estimated = acc.estimated || u.estimated === true;
          lastAssistantIdx = mi2;
        } else if (m.role === "assistant") {
          lastAssistantIdx = mi2;
        }
      }
      if (lastAssistantIdx >= 0 && hasUsage) {
        roundUsageByIndex[lastAssistantIdx] = acc;
      }
    })();
    if (needsFullRender) {
      fullRenderChat();
    } else if (msgCount > existingCount) {
      var newMessages = messages.slice(existingCount);
      newMessages.reverse();
      var fragment = document.createDocumentFragment();
      var insertedEls = [];
      var insertedOrigIdx = [];
      var firstNewOrigIdx = visibleOffset + existingCount;
      for (var i = 0; i < newMessages.length; i++) {
        var div = document.createElement("div");
        var nmOrigIdx = visibleOffset + existingCount + (newMessages.length - 1 - i);
        div.innerHTML = renderChatMessage(newMessages[i], roundUsageByIndex[nmOrigIdx] || null, nmOrigIdx, legacyTaskMap);
        var el = div.firstElementChild;
        if (el) {
          el.classList.add("animate-in");
          el.setAttribute("data-msg-index", String(nmOrigIdx));
          insertedEls.push(el);
          insertedOrigIdx.push(nmOrigIdx);
          fragment.appendChild(el);
        }
      }
      chatMessages.insertBefore(fragment, chatMessages.firstChild);
      bindChatScrollListener();
      attachAllCopyHandlers(chatMessages);
      applyPersistedExpandState(chatMessages);
      if (renderWasAtBottom) {
        requestAnimationFrame(function() {
          if (chatMessages.isConnected && Math.abs(chatMessages.scrollTop) > 1) {
            state.chatIsProgrammaticScroll = true;
            chatMessages.scrollTop = 0;
            requestAnimationFrame(function() {
              state.chatIsProgrammaticScroll = false;
            });
          }
          clearChatUnread({ removeDivider: true });
          updateChatUnreadBubble();
        });
      } else {
        if (state.chatUnreadStartIndex < 0) {
          state.chatUnreadStartIndex = firstNewOrigIdx;
        }
        state.chatUnreadCount += insertedEls.length;
        refreshChatUnreadDivider(chatMessages);
        updateChatUnreadBubble();
      }
    } else if (msgCount === existingCount && outputHash !== prevHash) {
      var existingEls = Array.from(chatMessages.querySelectorAll(".chat-message:not(.system-info)"));
      var reversedMessages = messages.slice().reverse();
      var replacedAny = false;
      var MAX_STREAMING_SCAN = Math.min(4, reversedMessages.length, existingEls.length);
      for (var mi = 0; mi < MAX_STREAMING_SCAN; mi++) {
        var currentEl = existingEls[mi];
        var tmpWrap = document.createElement("div");
        var srOrigIdx = visibleOffset + reversedMessages.length - 1 - mi;
        tmpWrap.innerHTML = renderChatMessage(reversedMessages[mi], roundUsageByIndex[srOrigIdx] || null, srOrigIdx, legacyTaskMap);
        var replacementEl = tmpWrap.firstElementChild;
        if (!replacementEl) continue;
        if (currentEl.innerHTML !== replacementEl.innerHTML || currentEl.className !== replacementEl.className) {
          chatMessages.replaceChild(replacementEl, currentEl);
          attachCopyHandler(replacementEl);
          replacedAny = true;
        } else if (mi > 0) {
          break;
        }
      }
      if (!replacedAny && reversedMessages.length > MAX_STREAMING_SCAN) {
        fullRenderChat();
      }
      if (replacedAny) {
        bindChatScrollListener();
        applyPersistedExpandState(chatMessages);
        requestAnimationFrame(function() {
          if (renderWasAtBottom && chatMessages.isConnected && Math.abs(chatMessages.scrollTop) > 1) {
            state.chatIsProgrammaticScroll = true;
            chatMessages.scrollTop = 0;
            requestAnimationFrame(function() {
              state.chatIsProgrammaticScroll = false;
            });
          }
          refreshChatUnreadDivider(chatMessages);
          updateChatUnreadBubble();
        });
        var newestMsgEl = chatMessages.querySelector(".chat-message");
        var allCards = chatMessages.querySelectorAll(".tool-use-card, .inline-diff[data-expand-key]");
        var newestCard = null;
        allCards.forEach(function(c) {
          var cardKey = getElementExpandKey(c);
          if (getPersistedExpandState(cardKey) !== null) return;
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
    snapCollapsedSubagentPanelsToBottom2(chatMessages);
    applyHistoryCollapse(chatMessages, selectedSession);
    applyAutoFoldBar(chatOutput, chatMessages, allMessages, renderIsInitial);
    renderStructuredStatusBar(chatMessages, selectedSession);
    updateTodoProgress(allMessages);
  }
  var todoExpanded = false;
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
        body.classList.add("expanded");
      } else {
        prog.classList.remove("expanded");
        body.classList.remove("expanded");
      }
    }
    syncChatMessagesPaddingForTodoBody();
  });
  function syncChatMessagesPaddingForTodoBody() {
    var chatMessages = document.querySelector("#chat-output .chat-messages");
    var todoBody = document.getElementById("todo-progress-body");
    if (!chatMessages || !todoBody) return;
    var chatMessagesEl = chatMessages;
    var isVisible = !todoBody.classList.contains("hidden");
    var isExpanded = todoBody.classList.contains("expanded");
    var bodyHeight = todoBody.offsetHeight;
    if (isVisible && isExpanded && bodyHeight > 0) {
      chatMessagesEl.style.paddingBottom = bodyHeight + 8 + "px";
    } else {
      chatMessagesEl.style.paddingBottom = "";
    }
  }
  function flattenToolResultContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i++) {
        var piece = content[i];
        if (typeof piece === "string") parts.push(piece);
        else if (piece && typeof piece.text === "string") parts.push(piece.text);
      }
      return parts.join("");
    }
    return "";
  }
  function reconstructTodosFromTaskTools(messages, startIdx) {
    var resultById = {};
    for (var i = startIdx; i < messages.length; i++) {
      var msg = messages[i];
      if (!msg || !Array.isArray(msg.content)) continue;
      for (var j = 0; j < msg.content.length; j++) {
        var b = msg.content[j];
        if (b && b.type === "tool_result" && b.tool_use_id) {
          resultById[b.tool_use_id] = flattenToolResultContent(b.content);
        }
      }
    }
    var taskMap = {};
    var order = 0;
    var createFallback = 0;
    var sawTaskTool = false;
    for (var m = startIdx; m < messages.length; m++) {
      var msg2 = messages[m];
      if (!msg2 || !Array.isArray(msg2.content)) continue;
      for (var k = 0; k < msg2.content.length; k++) {
        var blk = msg2.content[k];
        if (!blk || blk.type !== "tool_use") continue;
        var input = blk.input || {};
        if (blk.name === "TaskCreate") {
          sawTaskTool = true;
          createFallback++;
          var res = resultById[blk.id] || "";
          var match = res.match(/#(\d+)/);
          var cid = match ? match[1] : String(createFallback);
          taskMap[cid] = {
            id: cid,
            content: input.subject || "",
            activeForm: input.activeForm || "",
            status: "pending",
            order: order++
          };
        } else if (blk.name === "TaskUpdate") {
          sawTaskTool = true;
          var uid = String(input.taskId);
          var task = taskMap[uid];
          if (!task) {
            task = { id: uid, content: "", activeForm: "", status: "pending", order: order++ };
            taskMap[uid] = task;
          }
          if (input.status) task.status = input.status;
          if (input.subject) task.content = input.subject;
          if (input.activeForm) task.activeForm = input.activeForm;
        }
      }
    }
    if (!sawTaskTool) return null;
    var list = [];
    for (var key in taskMap) {
      if (!Object.prototype.hasOwnProperty.call(taskMap, key)) continue;
      if (taskMap[key].status === "deleted") continue;
      list.push(taskMap[key]);
    }
    list.sort(function(a, b2) {
      return a.order - b2.order;
    });
    return list.length ? list : null;
  }
  function updateTodoProgress(messages) {
    var startIdx = 0;
    for (var ui = messages.length - 1; ui >= 0; ui--) {
      if (messages[ui] && messages[ui].role === "user") {
        startIdx = ui + 1;
        break;
      }
    }
    var todos = null;
    for (var i = messages.length - 1; i >= startIdx; i--) {
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
    if (!todos) {
      todos = reconstructTodosFromTaskTools(messages, startIdx);
    }
    var container = document.getElementById("todo-progress");
    var bodyEl = document.getElementById("todo-progress-body");
    if (!container) return;
    if (!todos || todos.length === 0) {
      container.classList.add("hidden");
      if (bodyEl) bodyEl.classList.add("hidden");
      syncChatMessagesPaddingForTodoBody();
      return;
    }
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
    var allDone = completed === todos.length;
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var sessionActive = !!selectedSession && selectedSession.status === "running";
    if (!sessionActive || allDone) {
      container.classList.add("hidden");
      if (bodyEl) bodyEl.classList.add("hidden");
      syncChatMessagesPaddingForTodoBody();
      return;
    }
    container.classList.remove("hidden");
    container.classList.remove("all-done");
    if (bodyEl) bodyEl.classList.remove("hidden");
    var counter = document.getElementById("todo-progress-counter");
    if (counter) counter.textContent = completed + "/" + todos.length;
    var task = document.getElementById("todo-progress-task");
    if (task) {
      if (!activeTask) {
        for (var p = 0; p < todos.length; p++) {
          if (todos[p].status === "pending" && (todos[p].activeForm || todos[p].content)) {
            activeTask = todos[p].activeForm || todos[p].content;
            break;
          }
        }
      }
      task.textContent = activeTask || "\u51C6\u5907\u4E2D\u2026";
    }
    var ratio = todos.length > 0 ? completed / todos.length : 0;
    var ring = document.getElementById("todo-progress-ring");
    if (ring) {
      ring.style.setProperty("--progress", ratio.toFixed(3));
    }
    var fill = document.getElementById("todo-progress-fill");
    if (fill) {
      fill.style.setProperty("--progress", ratio.toFixed(3));
    }
    var list = document.getElementById("todo-progress-list");
    if (list) {
      var html = "";
      for (var m = 0; m < todos.length; m++) {
        var t15 = todos[m];
        var st = t15.status || "pending";
        var itemClass = st === "in_progress" ? "active" : st === "completed" ? "done" : "";
        var iconClass = st === "in_progress" ? "active" : st === "completed" ? "done" : "pending";
        var icon = st === "completed" ? "\u2713" : st === "in_progress" ? "\u203A" : "\u25CB";
        html += '<li class="todo-progress-item ' + itemClass + '"><span class="todo-item-icon ' + iconClass + '">' + icon + "</span><span>" + escapeHtml2(t15.content || "") + "</span></li>";
      }
      list.innerHTML = html;
    }
    if (state.selectedId) {
      syncSessionProgressToNative(state.selectedId);
    }
    syncChatMessagesPaddingForTodoBody();
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
            setTimeout(function() {
              btn.textContent = "Copy";
              btn.classList.remove("copied");
            }, 2e3);
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
            setTimeout(function() {
              clone.textContent = "Copy";
              clone.classList.remove("copied");
            }, 2e3);
          });
        }
      });
    });
    attachMessageCopyButtons(container);
  }
  var _msgCopyState = { timer: null, activeBtn: null };
  function attachMessageCopyButtons(container) {
    var isTouch = window.matchMedia("(pointer: coarse)").matches;
    if (!isTouch) return;
    container.querySelectorAll(".chat-message").forEach(function(msgEl) {
      if (msgEl.querySelector(".msg-copy-btn")) return;
      var bubble = msgEl.querySelector(".chat-message-bubble");
      if (!bubble) return;
      var btn = document.createElement("button");
      btn.className = "msg-copy-btn";
      btn.textContent = "\u590D\u5236";
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var text = bubble.innerText || bubble.textContent || "";
        copyToClipboard(text.trim(), null, function() {
          btn.textContent = "\u5DF2\u590D\u5236";
          btn.classList.add("copied");
          setTimeout(function() {
            btn.textContent = "\u590D\u5236";
            btn.classList.remove("copied");
            btn.classList.remove("visible");
          }, 1500);
        });
      });
      msgEl.appendChild(btn);
    });
  }
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
    document.addEventListener("click", function(e) {
      if (!e.target.closest(".msg-copy-btn")) {
        document.querySelectorAll(".msg-copy-btn.visible").forEach(function(b) {
          b.classList.remove("visible");
        });
      }
    });
  })();
  function isNoiseLine(line) {
    if (!line) return false;
    var trimmed = String(line).trim();
    if (!trimmed) return false;
    if (trimmed.indexOf("\u2500\u2500\u2500\u2500") === 0) return true;
    if (trimmed === "\u276F" || trimmed === "\u203A") return true;
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
    if (trimmed.indexOf("\u25CF") === 0 && trimmed.indexOf("\xB7") !== -1) return true;
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
    return String(text || "").replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[(\d+)C/g, function(_match, count) {
      return " ".repeat(Number(count) || 1);
    }).replace(/\x1b\[[0-9;?]*[AB]/g, "\n").replace(/\x1b\[[0-9;?]*[su]/g, "").replace(/\x1b\[[0-9;?]*[HfJKr]/g, "\n").replace(/\x1bM/g, "\n").replace(/\x1b\[[0-9;?]*[ST]/g, "\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[><=ePX^_]/g, "").replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  }
  function parseMessages(output, command) {
    var messages = [];
    if (!output) return messages;
    var text = String(output || "");
    var newline = String.fromCharCode(10);
    var carriageReturn = String.fromCharCode(13);
    var esc = String.fromCharCode(27);
    if (/^codex\b/.test(String(command || "").trim())) {
      let stripCodexSegment2 = function(raw) {
        return String(raw || "").replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[(\d+)C/g, function(_match, count) {
          return " ".repeat(Number(count) || 1);
        }).replace(/\x1b\[[0-9;?]*[AB]/g, newline).replace(/\x1b\[[0-9;?]*[su]/g, "").replace(/\x1b\[[0-9;?]*[HfJKr]/g, newline).replace(/\x1bM/g, newline).replace(/\x1b\[[0-9;?]*[ST]/g, newline).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[><=ePX^_]/g, "").replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[ \t]+\n/g, newline);
      }, normalizeCodexText2 = function(value) {
        return String(value || "").replace(/\s+/g, " ").replace(/[M]+$/g, "").trim();
      }, normalizeCodexPromptLine2 = function(line2) {
        return String(line2 || "").replace(/^›\s*/, "").replace(/^>\s*/, "").trim();
      }, shouldIgnoreCodexLine2 = function(line2) {
        var trimmed = String(line2 || "").trim();
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
      }, extractCodexPromptCandidate2 = function(line2) {
        var trimmed = String(line2 || "").trim();
        if (!/^›(?:\s|$)/.test(trimmed)) return null;
        if (codexFooterRe.test(trimmed)) return null;
        var prompt = normalizeCodexText2(normalizeCodexPromptLine2(trimmed));
        if (!prompt || shouldIgnoreCodexLine2(prompt)) return null;
        return prompt;
      }, extractCodexAssistantCandidate2 = function(line2) {
        var trimmed = String(line2 || "").trim();
        if (!/^[•◦·⏺]/.test(trimmed)) return null;
        var assistant = trimmed.replace(/^[•◦·]\s*/, "").replace(/^⏺\s+/, "").replace(/^│\s*/, "").trim();
        if (!assistant || /^[•◦·⏺]$/.test(assistant)) return null;
        assistant = assistant.replace(/\s*\(\d+[smh]?\s*•\s*esc to interrupt\)[\s\S]*$/i, "").replace(/(?:[a-z]{1,6})?›[\s\S]*$/, "").replace(/\s{2,}gpt-\d[\s\S]*$/i, "").replace(/\b(?:OpenAI Codex|model:|directory:|Tip:)\b[\s\S]*$/i, "");
        assistant = normalizeCodexText2(assistant);
        if (!assistant || assistant.length < 2 || codexActivityRe.test(assistant) || shouldIgnoreCodexLine2(assistant)) {
          return null;
        }
        return assistant;
      }, extractCodexEchoCandidate2 = function(line2) {
        var trimmed = normalizeCodexText2(line2);
        if (!trimmed || shouldIgnoreCodexLine2(trimmed)) return null;
        if (/^[•◦·⏺›]/.test(trimmed)) return null;
        if (/^[\[\]<>0-9;?]+u?$/i.test(trimmed)) return null;
        if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return null;
        if (trimmed.length > 500) return null;
        return trimmed;
      }, isLikelyAssistantTailArtifact2 = function(longer, shorter) {
        if (longer.indexOf(shorter) !== 0) return false;
        var suffix = longer.slice(shorter.length);
        return /^[a-z]{1,4}$/i.test(suffix);
      }, coalesceAssistantLines2 = function(lines2) {
        var collected = [];
        for (var i2 = 0; i2 < lines2.length; i2++) {
          var normalized = normalizeCodexText2(lines2[i2]);
          if (!normalized || normalized.length < 2 || shouldIgnoreCodexLine2(normalized)) continue;
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
            if (isLikelyAssistantTailArtifact2(previous, normalized)) {
              collected[collected.length - 1] = normalized;
            }
            continue;
          }
          collected.push(normalized);
        }
        return collected.join(newline).trim();
      }, extractVisiblePrompt2 = function(lines2) {
        for (var i2 = 0; i2 < lines2.length; i2++) {
          var line2 = String(lines2[i2] || "").trim();
          if (!line2) continue;
          var inlinePrompt = extractCodexPromptCandidate2(line2);
          if (inlinePrompt) return inlinePrompt;
          if (line2 === "\u203A") {
            for (var j = i2 + 1; j < lines2.length; j++) {
              var nextLine = normalizeCodexText2(lines2[j]);
              if (!nextLine || codexFooterRe.test(nextLine) || shouldIgnoreCodexLine2(nextLine)) continue;
              return nextLine;
            }
          }
        }
        return null;
      }, extractVisibleAssistantLines2 = function(lines2) {
        var assistantLines = [];
        var collecting = false;
        for (var i2 = 0; i2 < lines2.length; i2++) {
          var line2 = String(lines2[i2] || "").trim();
          if (!line2) {
            if (collecting) break;
            continue;
          }
          var assistant = extractCodexAssistantCandidate2(line2);
          if (assistant) {
            assistantLines.push(assistant);
            collecting = true;
            continue;
          }
          if (collecting) {
            if (line2 === "\u203A" || /^›(?:\s|$)/.test(line2) || codexFooterRe.test(line2) || shouldIgnoreCodexLine2(line2)) {
              break;
            }
            assistantLines.push(normalizeCodexText2(line2));
          }
        }
        return assistantLines;
      };
      var stripCodexSegment = stripCodexSegment2, normalizeCodexText = normalizeCodexText2, normalizeCodexPromptLine = normalizeCodexPromptLine2, shouldIgnoreCodexLine = shouldIgnoreCodexLine2, extractCodexPromptCandidate = extractCodexPromptCandidate2, extractCodexAssistantCandidate = extractCodexAssistantCandidate2, extractCodexEchoCandidate = extractCodexEchoCandidate2, isLikelyAssistantTailArtifact = isLikelyAssistantTailArtifact2, coalesceAssistantLines = coalesceAssistantLines2, extractVisiblePrompt = extractVisiblePrompt2, extractVisibleAssistantLines = extractVisibleAssistantLines2;
      var codexFooterRe = /\bgpt-\d+(?:\.\d+)?(?:\s+[a-z0-9.-]+)?\s+·\s+\d+%\s+left\s+·\s+(?:\/|~\/).+/i;
      var codexActivityRe = /^(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i;
      var rawCandidates = [];
      var candidateOrder = 0;
      var rawSegments = text.replace(/\r\n?/g, newline).split(newline);
      for (var rs = 0; rs < rawSegments.length; rs++) {
        var cleanedSegment = stripCodexSegment2(rawSegments[rs]);
        var pieces = cleanedSegment.split(newline);
        for (var pi = 0; pi < pieces.length; pi++) {
          var piece = String(pieces[pi] || "").trim();
          if (!piece) continue;
          var promptCandidate = extractCodexPromptCandidate2(piece);
          if (promptCandidate) {
            rawCandidates.push({ kind: "user", order: candidateOrder++, text: promptCandidate });
            continue;
          }
          var assistantCandidate = extractCodexAssistantCandidate2(piece);
          if (assistantCandidate) {
            rawCandidates.push({ kind: "assistant", order: candidateOrder++, text: assistantCandidate });
            continue;
          }
          var echoCandidate = extractCodexEchoCandidate2(piece);
          if (echoCandidate) {
            rawCandidates.push({ kind: "echo", order: candidateOrder++, text: echoCandidate });
          }
        }
      }
      var candidates = rawCandidates.filter(function(candidate, index, list) {
        var previous = list[index - 1];
        return !previous || previous.kind !== candidate.kind || previous.text !== candidate.text;
      });
      var explicitUsers = candidates.filter(function(candidate) {
        return candidate.kind === "user";
      });
      var assistantCandidates = candidates.filter(function(candidate) {
        return candidate.kind === "assistant";
      });
      var echoCandidates = candidates.filter(function(candidate) {
        return candidate.kind === "echo";
      });
      var strippedOutput = stripAnsi(text);
      var strippedLines = strippedOutput.split(newline).map(function(line2) {
        return String(line2 || "").trimEnd();
      });
      var visiblePrompt = extractVisiblePrompt2(strippedLines);
      var latestExplicitUser = explicitUsers.length ? explicitUsers[explicitUsers.length - 1] : null;
      var echoedUserCandidates = echoCandidates.map(function(candidate) {
        return candidate.text;
      }).filter(function(value) {
        return value.length >= 3;
      });
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
      var rawAssistantLines = assistantCandidates.filter(function(candidate) {
        return !latestExplicitUser || candidate.order > latestExplicitUser.order;
      }).map(function(candidate) {
        return candidate.text;
      });
      var visibleAssistantFallback = [];
      var bulletMatches = strippedOutput.match(/^[ \t]*[•◦·⏺][ \t]*(.+)$/gm) || [];
      for (var bm = 0; bm < bulletMatches.length; bm++) {
        var bulletContent = normalizeCodexText2(bulletMatches[bm].replace(/^[ \t]*[•◦·⏺][ \t]*/, ""));
        if (!bulletContent) continue;
        if (codexActivityRe.test(bulletContent)) continue;
        if (codexFooterRe.test(bulletContent)) continue;
        if (/\b(?:OpenAI Codex|model:|directory:|Tip:|esc to interrupt)\b/i.test(bulletContent)) continue;
        visibleAssistantFallback.push(bulletContent);
      }
      var assistantText = coalesceAssistantLines2(rawAssistantLines) || coalesceAssistantLines2(extractVisibleAssistantLines2(strippedLines)) || (visibleAssistantFallback.length ? visibleAssistantFallback[visibleAssistantFallback.length - 1] : null);
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
    var nul = String.fromCharCode(0);
    var bs = String.fromCharCode(8);
    var vt = String.fromCharCode(11);
    var ff = String.fromCharCode(12);
    var so = String.fromCharCode(14);
    var us = String.fromCharCode(31);
    var nbsp = String.fromCharCode(160);
    var bel = String.fromCharCode(7);
    var ansiRegex = new RegExp(
      esc + "\\[[0-9;?]*[a-zA-Z]|" + // CSI sequences
      esc + "\\][^" + bel + "]*(" + bel + "|" + esc + "\\\\\\\\)|" + // OSC sequences - matches ESC ] ... (BEL or ESC \)
      esc + "[><=eP_X^]|[" + nul + "-" + bs + vt + ff + so + "-" + us + "]|" + // Control chars: 0-8, 11, 12, 14-31
      nbsp + "|" + carriageReturn,
      "g"
    );
    var ansiStripped = text.replace(
      ansiRegex,
      function(m) {
        return m === nbsp ? " " : m === carriageReturn ? newline : "";
      }
    ).split(carriageReturn).join(newline);
    var lines = ansiStripped.split(newline).map(function(line2) {
      return line2.trim();
    }).filter(Boolean);
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
    var lastThinkingLine = null;
    var userCmdIndex = -1;
    var promptLines = [];
    var contentLines = [];
    var thinkingLines = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineForPromptCheck = line.replace(/^❯\s*/, "");
      if (lineForPromptCheck.indexOf('Try"') === 0 || lineForPromptCheck.indexOf('Try "') === 0) {
        promptLines.push(lineForPromptCheck);
        continue;
      }
      var isThinking = false;
      for (var p = 0; p < thinkingPatterns.length; p++) {
        if (thinkingPatterns[p].test(line)) {
          isThinking = true;
          thinkingLines.push(line);
          break;
        }
      }
      if (isThinking) continue;
      if (!line) continue;
      if (line.indexOf("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500") === 0) continue;
      if (line === "\u276F") continue;
      if (line.indexOf("esc to interrupt") !== -1) continue;
      if (line.indexOf("Claude Code v") !== -1) continue;
      if (line.indexOf("Sonnet") !== -1) continue;
      if (line.indexOf("~/") === 0) continue;
      if (line.indexOf("\u25CF high") !== -1) continue;
      if (line.indexOf("Failed to install Anthropic marketplace") !== -1) continue;
      if (line.indexOf("Claude Code has switched from npm to native installer") !== -1) continue;
      if (line.indexOf("Fluttering") !== -1) continue;
      if (line.indexOf("? for shortcuts") !== -1) continue;
      if (line.indexOf("0;") === 0) continue;
      if (line.indexOf("9;") === 0) continue;
      if (line.indexOf("Claude is waiting") !== -1) continue;
      if (line.indexOf("\u2722") !== -1 || line.indexOf("\u2733") !== -1 || line.indexOf("\u2736") !== -1 || line.indexOf("\u273B") !== -1 || line.indexOf("\u273D") !== -1) continue;
      if (line.indexOf("\u2590") === 0 || line.indexOf("\u259D") === 0 || line.indexOf("\u2598") === 0) continue;
      if ((line === "lu" || line === "ue" || line === "tr" || line === "ti" || line === "g" || line === "n" || line === "i\u2026" || line === "\u2026" || line === "uts" || line === "lt" || line === "rg" || line === "\xB7") && line.length < 4) continue;
      if (line.indexOf("\u273DF") === 0 || line.indexOf("\u273BF") === 0) continue;
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
      if (line.indexOf("\u23F5") !== -1) continue;
      if (line.indexOf("acceptedit") !== -1) continue;
      if (line.indexOf("shift+tab") !== -1) continue;
      if (line.indexOf("tabtocycle") !== -1) continue;
      if (line.indexOf("ctrl+g") !== -1) continue;
      if (line.indexOf("/effort") !== -1) continue;
      if (line.indexOf("Opus") !== -1 && line.indexOf("model") !== -1) continue;
      if (line.indexOf("Haiku") !== -1) continue;
      if (line.indexOf("to cycle") !== -1) continue;
      if (line.indexOf("high \xB7") !== -1 || line.indexOf("high\xB7") !== -1) continue;
      if (line.indexOf("medium \xB7") !== -1 || line.indexOf("medium\xB7") !== -1) continue;
      if (line.indexOf("low \xB7") !== -1 || line.indexOf("low\xB7") !== -1) continue;
      if (line.indexOf("\u25CF") === 0) {
        line = line.slice(1).trim();
        if (!line) continue;
        contentLines.push(line);
        continue;
      }
      if (line.length < 3 && !/^[a-zA-Z]{3}$/.test(line)) continue;
      contentLines.push(line);
    }
    if (thinkingLines.length > 0) {
      var lastThinking = thinkingLines[thinkingLines.length - 1];
      var durationMatch = lastThinking.match(new RegExp("for ([0-9]+[ms]+| [0-9]+m [0-9]+s)", "i"));
      var thinkingText = durationMatch ? "\u6DF1\u5EA6\u601D\u8003 " + durationMatch[0].replace(/for /i, "") : "\u6DF1\u5EA6\u601D\u8003\u4E2D...";
      messages.push({ role: "thinking", content: thinkingText, type: "deep-thought" });
    }
    if (promptLines.length > 0) {
      var promptText = promptLines[promptLines.length - 1].replace(/^Try\s*/, "").trim();
      messages.push({ role: "prompt", content: promptText, type: "suggestion" });
    }
    if (!contentLines.length) return messages;
    var turns = [];
    var currentUserText = null;
    var currentAssistantLines = [];
    for (var i = 0; i < contentLines.length; i++) {
      line = contentLines[i];
      if (line.indexOf("\u276F") === 0) {
        var afterPrompt = line.replace(/^❯\s*/, "").trim();
        if (afterPrompt.indexOf('Try"') === 0 || afterPrompt.indexOf('Try "') === 0) continue;
        if (currentUserText !== null && currentAssistantLines.length > 0) {
          turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
          currentAssistantLines = [];
        }
        if (afterPrompt) {
          currentUserText = afterPrompt;
        } else {
          if (currentUserText !== null && currentAssistantLines.length > 0) {
            turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
            currentAssistantLines = [];
          }
          currentUserText = null;
        }
      } else if (currentUserText !== null) {
        if (line.indexOf("\u23FA") !== -1 && (line.indexOf("Hi!") !== -1 || line.indexOf("Hello") !== -1 || line.indexOf("What") !== -1 || line.indexOf("working") !== -1)) {
          currentAssistantLines.push(line);
        } else if (line.indexOf("\u23FA") === 0) {
          currentAssistantLines.push(line.slice(1).trim() || line);
        } else if (line.length >= 8) {
          if (line.indexOf("\u2722") === -1 && line.indexOf("\u2733") === -1 && line.indexOf("\u2736") === -1 && line.indexOf("\u273B") === -1 && line.indexOf("\u273D") === -1 && line.indexOf("\u2590") !== 0 && line.indexOf("\u259D") !== 0 && line.indexOf("\u2598") !== 0 && line.indexOf("esctointerrupt") === -1 && line.indexOf("?for") !== 0 && line.indexOf("? for") !== 0) {
            currentAssistantLines.push(line);
          }
        }
      }
    }
    if (currentUserText !== null && currentAssistantLines.length > 0) {
      turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
    }
    if (turns.length === 0) {
      var fallbackUserText = "";
      var fallbackUserIdx = -1;
      for (var i = 0; i < contentLines.length; i++) {
        line = contentLines[i];
        if (line.indexOf('Try"') === 0 || line.indexOf('Try "') === 0) continue;
        if (line.indexOf("Failed to install") !== -1) continue;
        if (line.indexOf("ctrl+g") !== -1) continue;
        if (line.indexOf("\u25CF ") === 0) continue;
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
    for (var t15 = 0; t15 < turns.length; t15++) {
      messages.push({ role: "user", content: turns[t15].user });
      if (turns[t15].assistantLines.length > 0) {
        var formattedContent = formatAssistantResponse(turns[t15].assistantLines.join(newline));
        messages.push({ role: "assistant", content: formattedContent });
      }
    }
    return messages;
  }
  var _AVATAR_T = "transparent";
  function buildPixelSvg(grid, size) {
    var s = size || 3;
    var w = grid[0].length * s;
    var h = grid.length * s;
    var rects = "";
    for (var y = 0; y < grid.length; y++) {
      for (var x = 0; x < grid[y].length; x++) {
        if (grid[y][x] !== _AVATAR_T) {
          rects += '<rect x="' + x * s + '" y="' + y * s + '" width="' + s + '" height="' + s + '" fill="' + grid[y][x] + '"/>';
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" class="pixel-avatar-svg">' + rects + "</svg>";
  }
  function buildCatGrid(palette) {
    var T = _AVATAR_T;
    var b = palette.base;
    var d = palette.dark;
    var l = palette.light || palette.base;
    var w = palette.accent || "#FFFFFF";
    var k = palette.eye || "#2D2D2D";
    var p = palette.mouth || "#F28B9A";
    var n = palette.nose || palette.dark;
    return [
      [T, d, T, T, T, T, T, T, d, T],
      [d, b, d, T, T, T, T, d, b, d],
      [d, b, b, b, b, b, b, b, b, d],
      [b, b, w, k, b, b, w, k, b, b],
      [b, b, w, w, b, b, w, w, b, b],
      [b, b, b, b, p, p, b, b, b, b],
      [b, n, b, l, b, b, l, b, n, b],
      [T, b, b, b, b, b, b, b, b, T],
      [T, T, b, d, b, b, d, b, T, T],
      [T, T, T, b, T, T, b, T, T, T]
    ];
  }
  var GARFIELD_PALETTE = {
    base: "#F0923A",
    dark: "#C46A1A",
    light: "#F0923A",
    accent: "#FFFFFF",
    eye: "#2D2D2D",
    mouth: "#F28B9A",
    nose: "#E87D5A"
  };
  var SHORTHAIR_PALETTE = {
    base: "#9EAAB8",
    dark: "#6B7B8D",
    light: "#C5CED8",
    accent: "#FFFFFF",
    eye: "#7EC88B",
    mouth: "#F28B9A"
  };
  var SUBAGENT_PALETTES = [
    { base: "#5A8FE0", dark: "#2E5BB3", light: "#9CC0F2", accent: "#FFFFFF", eye: "#FFD66E", mouth: "#F28B9A", primary: "#5A8FE0" },
    // 蓝猫
    { base: "#A06FE0", dark: "#6B45A8", light: "#C8A4F2", accent: "#FFFFFF", eye: "#FFE36E", mouth: "#F28B9A", primary: "#A06FE0" },
    // 紫猫
    { base: "#7BB76B", dark: "#4F8A40", light: "#A9D49C", accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#F28B9A", primary: "#7BB76B" },
    // 抹茶猫
    { base: "#D86A88", dark: "#9C3A57", light: "#E8A4B5", accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#FFFFFF", primary: "#D86A88" },
    // 樱花猫
    { base: "#5BB7B0", dark: "#2E7873", light: "#9CD6D2", accent: "#FFFFFF", eye: "#FFD66E", mouth: "#F28B9A", primary: "#5BB7B0" },
    // 青苔猫
    { base: "#4A4A60", dark: "#1F1F2E", light: "#6E6E84", accent: "#F5F5F5", eye: "#FFD66E", mouth: "#F28B9A", primary: "#4A4A60" },
    // 黑猫
    { base: "#D8A85A", dark: "#9C7028", light: "#EBC78A", accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#F28B9A", primary: "#D8A85A" }
    // 焦糖猫
  ];
  function hashStringToIndex(str, mod) {
    var s = String(str || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
    return Math.abs(h) % mod;
  }
  var SUBAGENT_NAME_MAP = {
    "general-purpose": "\u4E07\u80FD\u732B",
    "Explore": "\u4FA6\u63A2\u732B",
    "code-explorer": "\u4FA6\u63A2\u732B",
    "code-reviewer": "\u5BA1\u67E5\u732B",
    "code-architect": "\u67B6\u6784\u732B",
    "code-simplifier": "\u7B80\u5316\u732B",
    "code-guide": "\u5411\u5BFC\u732B",
    "Plan": "\u7B56\u5212\u732B",
    "feature-dev": "\u5F00\u53D1\u732B",
    "pr-test-analyzer": "\u6D4B\u8BD5\u732B",
    "silent-failure-hunter": "\u62A4\u536B\u732B",
    "type-design-analyzer": "\u7C7B\u578B\u732B",
    "comment-analyzer": "\u6CE8\u91CA\u732B"
  };
  var _subagentSuffixMap = null;
  function getSubagentBaseName(sub) {
    if (!sub) return "";
    var agentType = sub.agentType || "";
    if (agentType && SUBAGENT_NAME_MAP[agentType]) return SUBAGENT_NAME_MAP[agentType];
    if (agentType) return agentType;
    return getActiveLang() === "English" ? "Subtask" : "\u5B50\u4EFB\u52A1";
  }
  function catPrefixedSubagentName(name) {
    var text = String(name || "").trim();
    if (!text) return "\u732B\u732B\u5B50 Agent";
    return text.indexOf("\u732B\u732B") === 0 ? text : "\u732B\u732B " + text;
  }
  function getSubagentDisplayName(sub) {
    var base = getSubagentBaseName(sub);
    if (!base) return base;
    var suffix = _subagentSuffixMap && sub && sub.taskId ? _subagentSuffixMap.get(sub.taskId) : null;
    return catPrefixedSubagentName(suffix ? base + suffix : base);
  }
  function getSubagentPalette(sub) {
    var seed = sub && (sub.agentType || sub.taskId) || "subagent";
    return SUBAGENT_PALETTES[hashStringToIndex(seed, SUBAGENT_PALETTES.length)];
  }
  function subagentAvatarHtml(sub) {
    var palette = getSubagentPalette(sub);
    var name = getSubagentDisplayName(sub);
    var svg = buildPixelSvg(buildCatGrid(palette));
    return '<div class="chat-message-avatar assistant subagent" style="--agent-color:' + palette.primary + '"><div class="pixel-avatar">' + svg + '</div><span class="avatar-name">' + escapeHtml2(name) + "</span></div>";
  }
  function renderSubagentReplyBubble(block, role) {
    if (!block || block.type !== "tool_result") return "";
    var text = extractToolResultText(block.content);
    var isError = block.is_error === true;
    var rawText = typeof text === "string" ? text : text == null ? "" : String(text);
    if (!isError && !rawText.trim()) {
      return '<div class="subagent-reply pending"><span class="subagent-reply-marker pending">' + escapeHtml2(t2("subagent.running")) + '</span><span class="typing-indicator"><span></span><span></span><span></span></span></div>';
    }
    var displayText = rawText.trim() ? rawText : t2("subagent.no_output");
    var bodyHtml = rawText.trim() ? renderMarkdown(displayText) : escapeHtml2(displayText);
    var markerLabel = isError ? t2("subagent.task.failed") : t2("subagent.task.done");
    var markerSymbol = isError ? "\u2717" : "\u2713";
    return '<div class="subagent-reply final' + (isError ? " error" : "") + '"><div class="subagent-reply-marker ' + (isError ? "error" : "done") + '"><span class="subagent-reply-marker-icon" aria-hidden="true">' + markerSymbol + '</span><span class="subagent-reply-marker-label">' + escapeHtml2(markerLabel) + '</span></div><div class="subagent-reply-content">' + bodyHtml + "</div></div>";
  }
  var PIXEL_AVATAR = {
    assistant: buildPixelSvg(buildCatGrid(GARFIELD_PALETTE)),
    user: buildPixelSvg(buildCatGrid(SHORTHAIR_PALETTE))
  };
  var DEFAULT_CHAT_PERSONA = {
    user: {
      name: "\u8D5B\u535A\u864E\u599E",
      avatarSvg: PIXEL_AVATAR.user
    },
    assistant: {
      name: "\u52E4\u52B3\u521D\u4E8C",
      avatarSvg: PIXEL_AVATAR.assistant
    }
  };
  function getStructuredChatPersona(role) {
    var configPersona = state.config && state.config.structuredChatPersona;
    var roleConfig = configPersona && configPersona[role] ? configPersona[role] : null;
    var defaults = DEFAULT_CHAT_PERSONA[role] || DEFAULT_CHAT_PERSONA.assistant;
    return {
      name: roleConfig && typeof roleConfig.name === "string" && roleConfig.name.trim() ? roleConfig.name.trim() : defaults.name,
      avatar: roleConfig && typeof roleConfig.avatar === "string" && roleConfig.avatar.trim() ? roleConfig.avatar.trim() : null,
      avatarSvg: defaults.avatarSvg
    };
  }
  function renderAvatarFallback(svg) {
    return '<div class="pixel-avatar">' + svg + "</div>";
  }
  function handleChatAvatarImageError(img, role) {
    if (!img || !img.parentNode) return;
    var persona = getStructuredChatPersona(role === "user" ? "user" : "assistant");
    img.outerHTML = renderAvatarFallback(persona.avatarSvg);
  }
  function chatAvatar(role) {
    var personaRole = role === "user" ? "user" : "assistant";
    var persona = getStructuredChatPersona(personaRole);
    var avatarInner = persona.avatar ? '<img class="pixel-avatar-image" src="' + escapeHtml2(persona.avatar) + '" alt="' + escapeHtml2(persona.name) + '" onerror="handleChatAvatarImageError(this, ' + JSON.stringify(personaRole) + ')" />' : renderAvatarFallback(persona.avatarSvg);
    return '<div class="chat-message-avatar ' + role + '">' + avatarInner + '<span class="avatar-name">' + escapeHtml2(persona.name) + "</span></div>";
  }
  function renderChatMessage(msg, roundUsage, messageIndex, legacyTaskMap) {
    if (msg.role === "thinking") {
      var ptyThinkingText = typeof msg.content === "string" ? msg.content : "";
      if (!ptyThinkingText.trim()) return "";
      var thinkingKey = buildExpandKey("thinking", [getMessageKey(msg, messageIndex), "pty"]);
      var thinkingPersisted = getPersistedExpandState(thinkingKey);
      var thinkingExpanded = thinkingPersisted === null ? getCardDefault("thinking") : thinkingPersisted;
      return '<div class="chat-message thinking"><div class="thinking-inline thinking-pty ' + (thinkingExpanded ? "expanded" : "collapsed") + '" data-expand-kind="thinking" data-expand-key="' + escapeHtml2(thinkingKey) + '" data-thinking="' + escapeHtml2(ptyThinkingText) + '" onclick="__thinkingToggle(this)"><span class="thinking-inline-icon">\u29BF</span><span class="thinking-inline-preview">' + escapeHtml2(ptyThinkingText) + '</span><span class="thinking-inline-action">' + (thinkingExpanded ? "\u6536\u8D77" : "\u5C55\u5F00") + "</span></div></div>";
    }
    if (msg.role === "prompt") {
      return '<div class="chat-message prompt"><div class="prompt-card"><div class="prompt-icon">\u2192</div><div class="prompt-content">\u8BD5\u8BD5\uFF1A<span class="prompt-text">' + escapeHtml2(msg.content) + "</span></div></div></div>";
    }
    if (Array.isArray(msg.content)) {
      return renderStructuredMessage(msg, roundUsage, messageIndex, legacyTaskMap);
    }
    var avatar = chatAvatar(msg.role);
    var bubbleContent = msg.role === "assistant" ? renderMarkdown(msg.content) : msg.role === "user" ? renderUserText(msg.content) : escapeHtml2(msg.content);
    return '<div class="chat-message ' + msg.role + '">' + avatar + '<div class="chat-message-bubble">' + bubbleContent + "</div></div>";
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
    return '<div class="structured-tool-hint">\u5DF2\u81EA\u52A8\u6062\u590D\u4E00\u6B21 ' + escapeHtml2(getToolDisplayName(toolName)) + " \u53C2\u6570\u95EE\u9898</div>";
  }
  var GROUPABLE_TOOLS = { Read: 1, Glob: 1, Grep: 1, WebFetch: 1, WebSearch: 1, TodoRead: 1 };
  function isGroupableToolBlock(block) {
    if (!block || block.type !== "tool_use" || !GROUPABLE_TOOLS[block.name]) return false;
    if (block.name === "Read") {
      var input = block.input || {};
      if (isImagePath(input.file_path || input.path || "")) return false;
    }
    return true;
  }
  function groupConsecutiveTools(content) {
    var groups = [];
    var i = 0;
    while (i < content.length) {
      var block = content[i];
      if (block.type === "tool_result") {
        i++;
        continue;
      }
      if (isGroupableToolBlock(block)) {
        var run = [{ block, index: i }];
        var j = i + 1;
        while (j < content.length) {
          if (content[j].type === "tool_result") {
            j++;
            continue;
          }
          if (isGroupableToolBlock(content[j])) {
            run.push({ block: content[j], index: j });
            j++;
          } else {
            break;
          }
        }
        if (run.length >= 2) {
          groups.push({ type: "group", items: run, endIndex: j });
        } else {
          groups.push({ type: "single", block, index: i });
        }
        i = j;
      } else {
        groups.push({ type: "single", block, index: i });
        i++;
      }
    }
    return groups;
  }
  var TOOL_GROUP_LABELS = { Read: "\u8BFB\u53D6", Glob: "\u641C\u7D22", Grep: "\u641C\u7D22", WebFetch: "\u6293\u53D6", WebSearch: "\u641C\u7D22", TodoRead: "\u5F85\u529E" };
  function renderToolGroup(items, role, toolResults, messageKey, options) {
    var opts = options || {};
    var counts = {};
    for (var k = 0; k < items.length; k++) {
      var n = items[k].block.name;
      counts[n] = (counts[n] || 0) + 1;
    }
    var allDone = true;
    var anyError = false;
    for (var k = 0; k < items.length; k++) {
      var b = items[k].block;
      var tr = pickToolResultForDisplay(toolResults, b.id);
      if (!tr) {
        allDone = false;
      } else if (tr.is_error) {
        anyError = true;
      }
    }
    var statusIcon = !allDone ? "\u2026" : anyError ? "\u2717" : "\u2713";
    var statusClass = !allDone ? "pending" : anyError ? "error" : "done";
    var parts = [];
    for (var name in counts) {
      parts.push(counts[name] + " " + (TOOL_GROUP_LABELS[name] || name));
    }
    var summaryText = parts.join(" \xB7 ");
    var groupKey = buildExpandKey("tool-group", [messageKey, items[0] && items[0].index, items.length]);
    var persistedExpanded = getPersistedExpandState(groupKey);
    var shouldExpand = opts.forceExpandedToolBodies ? true : persistedExpanded === null ? getCardDefault("toolGroup") : persistedExpanded;
    var innerHtml = "";
    for (var k = 0; k < items.length; k++) {
      try {
        innerHtml += renderContentBlock(items[k].block, role, toolResults, items[k].index, messageKey, opts);
      } catch (e) {
        innerHtml += '<div class="render-error">\u5DE5\u5177\u6E32\u67D3\u5931\u8D25</div>';
      }
    }
    return '<div class="tool-group" data-expand-kind="tool-group" data-expand-key="' + escapeHtml2(groupKey) + '" data-expanded="' + (shouldExpand ? "true" : "false") + '" data-status="' + statusClass + '"><div class="tool-group-summary" onclick="__toolGroupToggle(this.parentNode)"><span class="tool-group-status">' + statusIcon + '</span><span class="tool-group-text">' + escapeHtml2(summaryText) + '</span><span class="tool-group-count">' + items.length + ' \u4E2A\u8C03\u7528</span><svg class="tool-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:' + (shouldExpand ? "rotate(180deg)" : "") + '"><polyline points="6 9 12 15 18 9"/></svg></div><div class="tool-group-body" style="display:' + (shouldExpand ? "block" : "none") + ';">' + innerHtml + "</div></div>";
  }
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
  function computeHistoryStats(allMessages, historyIndices) {
    var rounds = 0, tools = 0, errors = 0;
    var agentIds = {};
    for (var i = 0; i < historyIndices.length; i++) {
      var msg = allMessages[historyIndices[i]];
      if (!msg) continue;
      if (msg.role === "user") rounds++;
      var content = msg.content;
      if (!Array.isArray(content)) continue;
      for (var j = 0; j < content.length; j++) {
        var block = content[j];
        if (!block) continue;
        if (block.__subagent && block.__subagent.taskId) agentIds[block.__subagent.taskId] = 1;
        if (block.type === "tool_use") {
          tools++;
          var legacy = deriveLegacySubagent(block);
          if (legacy && legacy.taskId) agentIds[legacy.taskId] = 1;
        } else if (block.type === "tool_result" && block.is_error) {
          errors++;
        }
      }
    }
    var agents = 0;
    for (var k in agentIds) {
      if (Object.prototype.hasOwnProperty.call(agentIds, k)) agents++;
    }
    return { rounds, tools, agents, errors };
  }
  function buildHistorySummaryMetaText(stats) {
    var parts = [];
    parts.push(t2("history.rounds", { n: String(stats.rounds) }));
    if (stats.tools > 0) parts.push(t2("history.tools", { n: String(stats.tools) }));
    if (stats.agents > 0) parts.push(t2("history.agents", { n: String(stats.agents) }));
    if (stats.errors > 0) parts.push(t2("history.errors", { n: String(stats.errors) }));
    return parts.join(" \xB7 ");
  }
  function applyHistoryHiddenState(summaryEl, expanded) {
    var node = summaryEl.nextElementSibling;
    while (node) {
      if (!node.classList.contains("chat-load-more")) {
        if (expanded) node.classList.remove("chat-history-hidden");
        else node.classList.add("chat-history-hidden");
      }
      node = node.nextElementSibling;
    }
  }
  function applyAutoFoldBar(chatOutput, chatMessages, allMessages, renderIsInitial) {
    void allMessages;
    void renderIsInitial;
    if (!chatOutput || !chatMessages) return;
    setAutoFoldMode(chatOutput, chatMessages, false);
    clearAutoFoldHistoryHidden(chatMessages);
    clearAutoFoldBar(chatOutput);
  }
  function ensureFoldBar(chatOutput) {
    var bar = chatOutput.querySelector("#chat-fold-bar");
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = "chat-fold-bar";
    bar.className = "chat-fold-bar hidden";
    chatOutput.insertBefore(bar, chatOutput.firstChild);
    return bar;
  }
  function setAutoFoldMode(chatOutput, chatMessages, enabled) {
    if (!chatOutput) return;
    chatOutput.classList.toggle("auto-fold", !!enabled);
  }
  function getHistoryIndicesBefore(msgs, boundaryIdx) {
    var indices = [];
    for (var i = 0; i < boundaryIdx; i++) {
      if (msgs[i]) indices.push(i);
    }
    return indices;
  }
  function clearAutoFoldHistoryHidden(chatMessages) {
    if (!chatMessages) return;
    var hidden = chatMessages.querySelectorAll(".chat-auto-fold-hidden");
    for (var i = 0; i < hidden.length; i++) hidden[i].classList.remove("chat-auto-fold-hidden");
  }
  function setAutoFoldHistoryHidden(chatMessages, boundaryIdx, enabled) {
    clearAutoFoldHistoryHidden(chatMessages);
    if (!enabled || boundaryIdx < 1) return;
    var nodes = chatMessages.querySelectorAll(".chat-message:not(.system-info)");
    for (var i = 0; i < nodes.length; i++) {
      var idxAttr = nodes[i].getAttribute("data-msg-index");
      if (idxAttr == null) continue;
      var idx = parseInt(idxAttr, 10);
      if (!isNaN(idx) && idx < boundaryIdx) nodes[i].classList.add("chat-auto-fold-hidden");
    }
    collapseHistorySummaryForAutoFold(chatMessages);
  }
  function collapseHistorySummaryForAutoFold(chatMessages) {
    var summary = chatMessages ? chatMessages.querySelector(".chat-history-summary") : null;
    if (!summary) return;
    summary.setAttribute("data-expanded", "false");
    var btn = summary.querySelector(".chat-history-summary-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    var title = summary.querySelector(".chat-history-summary-title");
    if (title) title.textContent = t2("history.expand");
    applyHistoryHiddenState(summary, false);
    summary.classList.add("chat-auto-fold-hidden");
    var sig = chatMessages.getAttribute("data-history-sig");
    if (sig) {
      var segs = sig.split(":");
      if (segs.length >= 3) {
        segs[2] = "0";
        chatMessages.setAttribute("data-history-sig", segs.join(":"));
      }
    }
  }
  function followAutoFoldLatest(chatMessages) {
    if (!chatMessages || !chatMessages.isConnected) return;
    clearChatUnread({ removeDivider: true });
    scrollChatToBottom(true);
  }
  function clearAutoFoldBar(chatOutput) {
    if (!chatOutput) return;
    var bar = chatOutput.querySelector("#chat-fold-bar");
    if (!bar) return;
    bar.innerHTML = "";
    bar.classList.add("hidden");
    state.chatAutoFoldSnapshot = null;
  }
  function buildAutoFoldBarHtml(userMsg, assistantMsg, historyStats) {
    var userPreview = getMessagePreviewText(userMsg) || "\u65B0\u6D88\u606F";
    var assistantPreview = assistantMsg ? getMessagePreviewText(assistantMsg) : "\u7B49\u5F85\u56DE\u590D...";
    var historyHtml = "";
    if (historyStats) {
      historyHtml = '<button type="button" class="chat-fold-row history" onclick="window.__chatFoldToggleHistory && window.__chatFoldToggleHistory()" title="\u5C55\u5F00\u6216\u6536\u8D77\u66F4\u65E9\u5BF9\u8BDD"><span class="chat-fold-role">\u5386\u53F2</span><span class="chat-fold-text">\u5DF2\u6536\u8D77 ' + escapeHtml2(buildHistorySummaryMetaText(historyStats)) + "</span></button>";
    }
    return historyHtml + '<button type="button" class="chat-fold-row user" onclick="window.__chatFoldJumpToLatest && window.__chatFoldJumpToLatest()" title="\u5B9A\u4F4D\u5230\u6700\u65B0\u6D88\u606F"><span class="chat-fold-role">\u6211</span><span class="chat-fold-text">' + escapeHtml2(userPreview) + '</span></button><button type="button" class="chat-fold-row assistant" onclick="window.__chatFoldJumpToLatest && window.__chatFoldJumpToLatest()" title="\u5B9A\u4F4D\u5230\u6700\u65B0\u56DE\u590D"><span class="chat-fold-role">Claude</span><span class="chat-fold-text">' + escapeHtml2(assistantPreview) + "</span></button>";
  }
  function getMessagePreviewText(msg) {
    if (!msg) return "";
    var parts = [];
    function pushText(value) {
      if (typeof value !== "string") return;
      var cleaned = value.replace(/\s+/g, " ").trim();
      if (cleaned) parts.push(cleaned);
    }
    if (typeof msg.content === "string") {
      pushText(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (var i = 0; i < msg.content.length && parts.join(" ").length < 180; i++) {
        var block = msg.content[i];
        if (!block) continue;
        if (block.type === "text") pushText(block.text);
        else if (block.type === "thinking") pushText(block.thinking);
        else if (block.type === "tool_use") pushText(block.name ? "\u8C03\u7528 " + block.name : "\u5DE5\u5177\u8C03\u7528");
        else if (block.type === "tool_result") pushText(block.is_error ? "\u5DE5\u5177\u8FD4\u56DE\u9519\u8BEF" : "\u5DE5\u5177\u8FD4\u56DE\u7ED3\u679C");
        else if (block.text) pushText(block.text);
      }
    }
    var text = parts.join(" \xB7 ");
    return text.length > 180 ? text.slice(0, 177) + "..." : text;
  }
  window.__chatFoldJumpToLatest = function() {
    var chatMessages = document.querySelector("#chat-output .chat-messages");
    if (chatMessages) followAutoFoldLatest(chatMessages);
  };
  window.__chatFoldToggleHistory = function() {
    var summary = document.querySelector("#chat-output .chat-history-summary");
    var btn = summary ? summary.querySelector(".chat-history-summary-btn") : null;
    if (summary) summary.classList.remove("chat-auto-fold-hidden");
    if (btn && window.__historySummaryToggle) {
      window.__historySummaryToggle(btn);
    }
  };
  function collectHistoryCollapseState(chatMessages, msgEls, lastUserIdx, measureLatestTurn) {
    var stateForCollapse = {
      shouldCollapseForViewport: false,
      historyIndices: [],
      firstHistoryEl: null
    };
    if (!chatMessages || lastUserIdx < 0) return stateForCollapse;
    var viewportHeight = measureLatestTurn ? chatMessages.clientHeight || chatMessages.getBoundingClientRect().height || 0 : 0;
    var firstLatestTurnEl = null;
    var lastLatestTurnEl = null;
    for (var i = 0; i < msgEls.length; i++) {
      var idxAttr = msgEls[i].getAttribute("data-msg-index");
      if (idxAttr == null) continue;
      var idx = parseInt(idxAttr, 10);
      if (isNaN(idx)) continue;
      if (idx < lastUserIdx) {
        stateForCollapse.historyIndices.push(idx);
        if (!stateForCollapse.firstHistoryEl) stateForCollapse.firstHistoryEl = msgEls[i];
      } else if (measureLatestTurn) {
        if (!firstLatestTurnEl) firstLatestTurnEl = msgEls[i];
        lastLatestTurnEl = msgEls[i];
      }
    }
    if (measureLatestTurn && viewportHeight > 0 && firstLatestTurnEl && lastLatestTurnEl) {
      var firstRect = firstLatestTurnEl.getBoundingClientRect();
      var lastRect = lastLatestTurnEl.getBoundingClientRect();
      var latestTurnHeight = Math.max(firstRect.bottom, lastRect.bottom) - Math.min(firstRect.top, lastRect.top);
      var collapseThreshold = Math.max(220, viewportHeight - 24);
      stateForCollapse.shouldCollapseForViewport = latestTurnHeight >= collapseThreshold;
    }
    return stateForCollapse;
  }
  function applyHistoryCollapse(chatMessages, selectedSession) {
    if (!chatMessages) return;
    var allMessages = state.currentMessages || [];
    var lastUserIdx = -1;
    for (var i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i] && allMessages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    function clearAll() {
      var prev = chatMessages.querySelector(".chat-history-summary");
      if (prev) prev.remove();
      var hidden = chatMessages.querySelectorAll(".chat-history-hidden");
      for (var h = 0; h < hidden.length; h++) hidden[h].classList.remove("chat-history-hidden");
      chatMessages.removeAttribute("data-history-sig");
    }
    clearAll();
    var msgEls = chatMessages.querySelectorAll(".chat-message.assistant[data-msg-index]");
    for (var m = 0; m < msgEls.length; m++) {
      var el = msgEls[m];
      var idx = parseInt(el.getAttribute("data-msg-index") || "", 10);
      if (isNaN(idx) || !allMessages[idx] || allMessages[idx].role !== "assistant") continue;
      var historical = idx < lastUserIdx;
      var key = buildExpandKey(historical ? "assistant-reply-history" : "assistant-reply-current", [getMessageKey(allMessages[idx], idx)]);
      var persisted = getPersistedExpandState(key);
      var expanded = persisted === null ? !historical : persisted;
      var disclosure = el.querySelector(":scope > .assistant-reply-disclosure");
      if (!disclosure) {
        disclosure = document.createElement("button");
        disclosure.className = "assistant-reply-disclosure";
        disclosure.setAttribute("type", "button");
        el.insertBefore(disclosure, el.firstChild);
      }
      disclosure.setAttribute("data-expand-key", key);
      disclosure.setAttribute("aria-expanded", expanded ? "true" : "false");
      disclosure.innerHTML = '<span class="assistant-reply-label">\u56DE\u590D</span><span class="assistant-reply-preview">' + escapeHtml2(getMessagePreviewText(allMessages[idx]) || "\u52A9\u624B\u56DE\u590D") + '</span><span class="assistant-reply-action">' + (expanded ? "\u6536\u8D77" : "\u5C55\u5F00") + '</span><span class="assistant-reply-chevron">' + iconSvg("chevronDown", { size: 15 }) + "</span>";
      el.classList.toggle("assistant-reply-collapsed", !expanded);
      el.classList.toggle("assistant-reply-expanded", expanded);
      disclosure.onclick = function() {
        var parent = this.parentElement;
        var nextExpanded = parent.classList.contains("assistant-reply-collapsed");
        parent.classList.toggle("assistant-reply-collapsed", !nextExpanded);
        parent.classList.toggle("assistant-reply-expanded", nextExpanded);
        this.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
        var action = this.querySelector(".assistant-reply-action");
        if (action) action.textContent = nextExpanded ? "\u6536\u8D77" : "\u5C55\u5F00";
        setPersistedExpandState(this.getAttribute("data-expand-key"), nextExpanded);
      };
    }
  }
  window.__historySummaryToggle = function(btn) {
    var wrap = btn && btn.closest ? btn.closest(".chat-history-summary") : null;
    if (!wrap) return;
    var key = wrap.getAttribute("data-expand-key");
    var nowExpanded = wrap.getAttribute("data-expanded") !== "true";
    wrap.setAttribute("data-expanded", nowExpanded ? "true" : "false");
    btn.setAttribute("aria-expanded", nowExpanded ? "true" : "false");
    var title = wrap.querySelector(".chat-history-summary-title");
    if (title) title.textContent = nowExpanded ? t2("history.collapse") : t2("history.expand");
    if (key) setPersistedExpandState(key, nowExpanded);
    applyHistoryHiddenState(wrap, nowExpanded);
    var container = wrap.parentElement;
    if (nowExpanded) {
      clearAutoFoldHistoryHidden(container);
    }
    if (container) {
      var sig = container.getAttribute("data-history-sig");
      if (sig) {
        var segs = sig.split(":");
        if (segs.length >= 3) {
          segs[2] = nowExpanded ? "1" : "0";
          container.setAttribute("data-history-sig", segs.join(":"));
        }
      }
    }
  };
  function deriveLegacySubagent(block) {
    if (!block || block.type !== "tool_use") return null;
    var input = block.input || {};
    var agentType = typeof input.subagent_type === "string" ? input.subagent_type : null;
    if (!agentType && block.name !== "Task" && block.name !== "Agent") return null;
    return {
      taskId: block.id,
      agentType: agentType || void 0,
      taskDescription: typeof input.description === "string" ? input.description : void 0
    };
  }
  function collectLegacyTaskIdMap(allMessages) {
    var map = /* @__PURE__ */ new Map();
    if (!Array.isArray(allMessages)) return map;
    for (var i = 0; i < allMessages.length; i++) {
      var m = allMessages[i];
      if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (var j = 0; j < m.content.length; j++) {
        var b = m.content[j];
        if (!b || b.type !== "tool_use") continue;
        var derived = b.__subagent || deriveLegacySubagent(b);
        if (derived) map.set(b.id, derived);
      }
    }
    return map;
  }
  function collectSubagentSuffixMap(allMessages) {
    var suffix = /* @__PURE__ */ new Map();
    if (!Array.isArray(allMessages)) return suffix;
    var bucketsByName = /* @__PURE__ */ new Map();
    var seenTaskIds = /* @__PURE__ */ new Set();
    function record(sub2) {
      if (!sub2 || !sub2.taskId) return;
      if (seenTaskIds.has(sub2.taskId)) return;
      seenTaskIds.add(sub2.taskId);
      var name = getSubagentBaseName(sub2);
      if (!name) return;
      if (!bucketsByName.has(name)) bucketsByName.set(name, []);
      bucketsByName.get(name).push(sub2.taskId);
    }
    for (var i = 0; i < allMessages.length; i++) {
      var m = allMessages[i];
      if (!m || !Array.isArray(m.content)) continue;
      for (var j = 0; j < m.content.length; j++) {
        var b = m.content[j];
        if (!b) continue;
        var sub = b.__subagent || (b.type === "tool_use" ? deriveLegacySubagent(b) : null);
        if (sub) record(sub);
      }
    }
    bucketsByName.forEach(function(taskIds) {
      if (taskIds.length < 2) return;
      for (var k = 0; k < taskIds.length; k++) {
        suffix.set(taskIds[k], " #" + (k + 1));
      }
    });
    return suffix;
  }
  function splitTurnBySubagent(blocks, legacyTaskMap) {
    var segs = [];
    if (!Array.isArray(blocks) || !blocks.length) return segs;
    var current = null;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var isPlaceholder = b && b.type === "text" && b.__processing === true;
      if (isPlaceholder && current) {
        current.blocks.push(b);
        continue;
      }
      var sub = b && b.__subagent ? b.__subagent : null;
      if (!sub) sub = deriveLegacySubagent(b);
      if (!sub && b && b.type === "tool_result" && legacyTaskMap && legacyTaskMap.has(b.tool_use_id)) {
        sub = legacyTaskMap.get(b.tool_use_id);
      }
      var key = sub ? sub.taskId : null;
      if (!current || current.key !== key) {
        current = { key, subagent: sub, blocks: [], firstIndex: i };
        segs.push(current);
      }
      current.blocks.push(b);
    }
    return segs;
  }
  function buildSegmentBlocksHtml(segmentBlocks, segmentFirstIndex, role, toolResults, messageKey, options) {
    var html = "";
    var opts = options || {};
    try {
      var groups = groupConsecutiveTools(segmentBlocks);
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        try {
          if (grp.type === "group") {
            var shifted = [];
            for (var k = 0; k < grp.items.length; k++) {
              shifted.push({ block: grp.items[k].block, index: grp.items[k].index + segmentFirstIndex });
            }
            html += renderToolGroup(shifted, role, toolResults, messageKey, opts);
          } else {
            html += renderContentBlock(grp.block, role, toolResults, grp.index + segmentFirstIndex, messageKey, opts);
          }
        } catch (e) {
          html += '<div class="render-error">\u6D88\u606F\u5757\u6E32\u67D3\u5931\u8D25</div>';
        }
      }
    } catch (e) {
      html += '<div class="render-error">\u6D88\u606F\u6E32\u67D3\u5931\u8D25</div>';
    }
    return html;
  }
  function buildMultiAgentHtml(segments, role, parentPersonaName, toolResults, messageKey, options) {
    var opts = options || {};
    var showHandoff = opts.showHandoff !== false;
    var html = "";
    var lastSubId = null;
    for (var si = 0; si < segments.length; si++) {
      var seg = segments[si];
      var segmentOptions = seg.subagent ? { inSubagentPanel: true } : {};
      var segHtml = buildSegmentBlocksHtml(seg.blocks, seg.firstIndex, role, toolResults, messageKey, segmentOptions);
      if (!segHtml || !segHtml.trim()) continue;
      if (seg.subagent) {
        var includeHandoff = showHandoff && lastSubId !== seg.subagent.taskId;
        html += buildSubagentPanelHtml(seg, parentPersonaName, segHtml, messageKey, includeHandoff);
        lastSubId = seg.subagent.taskId;
      } else {
        html += '<div class="chat-message-segment parent">' + chatAvatar(role) + '<div class="chat-message-content">' + segHtml + "</div></div>";
        lastSubId = null;
      }
    }
    return html;
  }
  function buildSubagentPanelHtml(seg, parentPersonaName, segHtml, messageKey, includeHandoff) {
    var sub = seg.subagent;
    var subPalette = getSubagentPalette(sub);
    var subName = getSubagentDisplayName(sub);
    var taskId = sub.taskId || "";
    var avatarSvg = buildPixelSvg(buildCatGrid(subPalette));
    var itemCount = countRenderableSegmentBlocks(seg.blocks);
    var titleHtml;
    if (includeHandoff) {
      var hasDesc = !!(sub.taskDescription && String(sub.taskDescription).trim());
      var descSpan = hasDesc ? '<span class="subagent-panel-task-desc">' + escapeHtml2(sub.taskDescription) + "</span>" : '<span class="subagent-panel-task-desc">' + escapeHtml2(t2("subagent.continued")) + "</span>";
      titleHtml = '<span class="subagent-panel-attribution"><strong class="subagent-panel-name">' + escapeHtml2(subName) + '</strong><span class="subagent-panel-tag" title="' + escapeHtml2(t2("subagent.tag_title")) + '">' + escapeHtml2(t2("subagent.tag")) + "</span>" + descSpan + "</span>";
    } else {
      titleHtml = '<span class="subagent-panel-attribution"><strong class="subagent-panel-name">' + escapeHtml2(subName) + '</strong><span class="subagent-panel-task-desc"> ' + escapeHtml2(t2("subagent.continued")) + "</span></span>";
    }
    var expandKey = buildExpandKey("subagent-panel", [messageKey, taskId]);
    return '<div class="subagent-panel" data-expand-kind="subagent-panel" data-expand-key="' + escapeHtml2(expandKey) + '" data-agent-id="' + escapeHtml2(taskId) + '" data-expanded="true" style="--agent-color:' + subPalette.primary + '"><div class="subagent-panel-header" aria-label="' + escapeHtml2(t2("subagent.title_aria")) + '"><span class="subagent-panel-avatar" aria-hidden="true">' + avatarSvg + "</span>" + titleHtml + '<span class="subagent-panel-count">' + escapeHtml2(itemCount + " \u6761\u5185\u5BB9") + '</span></div><div class="subagent-panel-body">' + segHtml + "</div></div>";
  }
  function countRenderableSegmentBlocks(blocks) {
    if (!Array.isArray(blocks)) return 0;
    var count = 0;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (!block || !block.type) continue;
      if (block.type === "tool_result") continue;
      if (block.type === "text" && !String(block.text || "").trim() && !block.__processing) continue;
      if (block.type === "thinking" && !String(block.thinking || "").trim()) continue;
      count++;
    }
    return Math.max(1, count);
  }
  function renderStructuredMessage(msg, roundUsage, messageIndex, legacyTaskMap) {
    var role = msg.role;
    var messageKey = getMessageKey(msg, messageIndex);
    var usageHtml = role === "assistant" ? renderUsageSummaryHtml(roundUsage) : "";
    var isQueued = role === "user" && msg.content && msg.content.some(function(b) {
      return b.__queued;
    });
    if (!msg.content || msg.content.length === 0) {
      if (role === "assistant") {
        return '<div class="chat-message ' + role + '">' + chatAvatar(role) + '<div class="chat-message-content"><div class="typing-indicator"><span></span><span></span><span></span></div>' + usageHtml + "</div></div>";
      }
      return '<div class="chat-message ' + role + ' empty-message" data-message-key="' + escapeHtml2(messageKey) + '">' + chatAvatar(role) + '<div class="chat-message-content"><span class="empty-message-hint">\uFF08\u7A7A\u6D88\u606F\uFF09</span></div></div>';
    }
    var toolResults = buildToolResultMap(msg.content);
    var parentPersona = getStructuredChatPersona("assistant");
    if (role !== "assistant") {
      var userSegments = splitTurnBySubagent(msg.content, legacyTaskMap);
      var userHasSub = userSegments.some(function(s) {
        return s.subagent;
      });
      var queuedClass = isQueued ? " queued" : "";
      var queuedBadge = isQueued ? '<span class="queued-badge">\u6392\u961F\u4E2D</span>' : "";
      if (userHasSub) {
        var userMultiHtml = buildMultiAgentHtml(userSegments, role, parentPersona.name, toolResults, messageKey, { showHandoff: false });
        return '<div class="chat-message ' + role + queuedClass + ' multi-agent" data-message-key="' + escapeHtml2(messageKey) + '">' + userMultiHtml + queuedBadge + "</div>";
      }
      var userHtml = buildSegmentBlocksHtml(msg.content, 0, role, toolResults, messageKey);
      return '<div class="chat-message ' + role + queuedClass + '" data-message-key="' + escapeHtml2(messageKey) + '">' + chatAvatar(role) + '<div class="chat-message-content">' + userHtml + queuedBadge + "</div></div>";
    }
    var segments = splitTurnBySubagent(msg.content, legacyTaskMap);
    var hasSubagent = segments.some(function(s) {
      return s.subagent;
    });
    if (!hasSubagent) {
      var html = buildSegmentBlocksHtml(msg.content, 0, role, toolResults, messageKey);
      return '<div class="chat-message ' + role + '" data-message-key="' + escapeHtml2(messageKey) + '">' + chatAvatar(role) + '<div class="chat-message-content">' + html + usageHtml + "</div></div>";
    }
    var multiHtml = '<div class="chat-message ' + role + ' multi-agent" data-message-key="' + escapeHtml2(messageKey) + '">';
    multiHtml += buildMultiAgentHtml(segments, role, parentPersona.name, toolResults, messageKey, { showHandoff: true });
    multiHtml += usageHtml;
    multiHtml += "</div>";
    return multiHtml;
  }
  function compactUsageNumber(value) {
    if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.max(0, Math.round(value || 0)));
  }
  function renderUsageSummaryHtml(usage) {
    if (!usage) return "";
    var estimated = usage.estimated === true;
    var parts = [];
    if ((usage.inputTokens || 0) > 0) parts.push("\u8F93\u5165 " + compactUsageNumber(usage.inputTokens));
    if ((usage.cacheReadInputTokens || 0) > 0) parts.push("\u7F13\u5B58\u547D\u4E2D " + compactUsageNumber(usage.cacheReadInputTokens));
    if ((usage.cacheCreationInputTokens || 0) > 0) parts.push("\u7F13\u5B58\u5199\u5165 " + compactUsageNumber(usage.cacheCreationInputTokens));
    if ((usage.outputTokens || 0) > 0) parts.push("\u8F93\u51FA " + (estimated ? "\u2248" : "") + compactUsageNumber(usage.outputTokens));
    if ((usage.reasoningOutputTokens || 0) > 0) parts.push("\u63A8\u7406 " + (estimated ? "\u2248" : "") + compactUsageNumber(usage.reasoningOutputTokens));
    if ((usage.totalCostUsd || 0) > 0) parts.push("$" + Number(usage.totalCostUsd).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
    if (parts.length === 0 && estimated) parts.push("\u6B63\u5728\u7EDF\u8BA1\u7528\u91CF\u2026");
    if (parts.length === 0) return "";
    return '<div class="turn-usage-summary' + (estimated ? " is-estimated" : "") + '" role="status" aria-live="polite" aria-label="\u672C\u8F6E\u7528\u91CF ' + escapeHtml2(parts.join("\uFF0C")) + '"><svg class="turn-usage-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5h11M4 11V7.5M8 11V3M12 11V5.5"/></svg><span>' + escapeHtml2(parts.join(" \xB7 ")) + "</span></div>";
  }
  var ATTACHMENT_PREFIX_RE = /^\s*\[附件已上传，请查看以下文件:\n([\s\S]*?)\]\n+/;
  function renderUserAttachmentBlock(rawPath) {
    var p = (rawPath || "").trim();
    if (!p) return "";
    var name = p.split("/").pop() || p;
    if (isImagePath(p)) {
      var src = "/api/file-raw?path=" + encodeURIComponent(p);
      return '<div class="user-attachment-image"><img class="user-attachment-thumb" loading="lazy" src="' + src + '" alt="' + escapeHtml2(name) + '" data-path="' + escapeHtml2(p) + `" onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute('data-path'));" onerror="var w=this.closest('.user-attachment-image'); if(w)w.style.display='none';" /></div>`;
    }
    return '<div class="user-attachment-file" data-path="' + escapeHtml2(p) + `" onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute('data-path'));"><span class="user-attachment-file-icon"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5z"/><path d="M9 1.5V5.5h4"/></svg></span><span class="user-attachment-file-name">` + escapeHtml2(name) + "</span></div>";
  }
  function renderUserText(text) {
    var raw = text || "";
    var m = raw.match(ATTACHMENT_PREFIX_RE);
    if (!m) return escapeHtml2(raw);
    var attachHtml = "";
    var lines = m[1].split("\n");
    for (var i = 0; i < lines.length; i++) {
      attachHtml += renderUserAttachmentBlock(lines[i]);
    }
    var rest = raw.slice(m[0].length);
    var wrap = attachHtml ? '<div class="user-attachments">' + attachHtml + "</div>" : "";
    var body = rest.trim() ? '<div class="user-attachment-text">' + escapeHtml2(rest) + "</div>" : "";
    return wrap + body;
  }
  function renderContentBlock(block, role, toolResults, index, messageKey, options) {
    var opts = options || {};
    if (!block || !block.type) return "";
    if (!opts.inSubagentPanel && block.type === "tool_use" && block.__subagent && block.__subagent.taskId === block.id) {
      return "";
    }
    if (block.type === "tool_result" && block.__subagent && block.__subagent.taskId === block.tool_use_id) {
      return renderSubagentReplyBubble(block, role);
    }
    switch (block.type) {
      case "text":
        if (role === "assistant" && block.__processing) {
          return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
        }
        return role === "assistant" ? renderMarkdown(block.text || "") : renderUserText(block.text || "");
      case "thinking":
        var thinkingText = block.thinking || "";
        var isStreaming = block.thinking === void 0 && block.type === "thinking";
        if (isStreaming) {
          return '<div class="thinking-inline thinking-streaming" data-thinking=""><div class="thinking-streaming-inner"><span class="thinking-streaming-icon spinning">\u29BF</span><div class="thinking-streaming-text"></div></div></div>';
        }
        if (!thinkingText.trim()) return "";
        var preview = thinkingText.length > 60 ? thinkingText.slice(0, 57) + "\u2026" : thinkingText;
        var thinkingKey = buildExpandKey("thinking", [messageKey, index]);
        var thinkingPersisted = getPersistedExpandState(thinkingKey);
        var thinkingExpanded = thinkingPersisted === null ? getCardDefault("thinking") : thinkingPersisted;
        return '<div class="thinking-inline ' + (thinkingExpanded ? "expanded" : "collapsed") + '" data-expand-kind="thinking" data-expand-key="' + escapeHtml2(thinkingKey) + '" data-thinking="' + escapeHtml2(thinkingText) + '" onclick="__thinkingToggle(this)"><span class="thinking-inline-icon">\u29BF</span><span class="thinking-inline-preview">' + escapeHtml2(thinkingExpanded ? thinkingText : preview) + '</span><span class="thinking-inline-action">' + (thinkingExpanded ? "\u6536\u8D77" : "\u5C55\u5F00") + "</span></div>";
      case "tool_use":
        var toolResult = pickToolResultForDisplay(toolResults, block.id);
        var rendered = renderToolUseCard(block, toolResult, index, messageKey, opts);
        if (hasRecoveredToolNoise(toolResults, block.id)) {
          rendered = renderRecoveredToolHint(block.name || "\u5DE5\u5177") + rendered;
        }
        return rendered;
      case "tool_result":
        return "";
      default:
        var unknownType = block && block.type ? String(block.type) : "\u672A\u77E5";
        var unknownJson = "";
        try {
          unknownJson = JSON.stringify(block, null, 2);
        } catch (_e) {
          unknownJson = "{}";
        }
        return `<div class="unknown-block collapsed" onclick="this.classList.toggle('collapsed')"><div class="unknown-block-header"><span class="unknown-block-icon">?</span><span class="unknown-block-label">\u672A\u8BC6\u522B\u7684\u5185\u5BB9\u5757\uFF1A` + escapeHtml2(unknownType) + '</span><span class="unknown-block-toggle">\u25BC</span></div><pre class="unknown-block-body">' + escapeHtml2(unknownJson) + "</pre></div>";
    }
  }
  function renderInlineTool(block, toolResult, toolName, fileInfo, extraInfo, messageKey, index, options) {
    var opts = options || {};
    var toolId = block.id || "tool-" + toolName;
    var expandKey = buildExpandKey("inline-tool", [messageKey, toolId || index, index]);
    var persistedExpanded = getPersistedExpandState(expandKey);
    var inputData = block.input || {};
    var resultContent = extractToolResultText(toolResult && toolResult.content);
    var isError = toolResult && toolResult.is_error;
    var hasResult = resultContent.length > 0;
    var statusIcon = isError ? "\u2717" : hasResult ? "\u2713" : "\u2026";
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
      title = "\u8BFB\u53D6\u5F85\u529E\u5217\u8868";
      meta = extraInfo || "";
    } else {
      icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 5v3.5M8 11h.01"/></svg>';
      title = getToolDisplayName(toolName);
      meta = extraInfo || "";
    }
    if (hasResult) {
      var lines = resultContent.split("\n");
      if (lines.length > 10) {
        preview = lines.slice(0, 10).join("\n") + "\n\u2026";
      } else {
        preview = resultContent;
      }
    }
    var resultDataAttr = escapeHtml2(resultContent);
    var previewDataAttr = escapeHtml2(preview);
    var fullResult = resultContent;
    var expandedHtml = "";
    var shouldExpand = opts.forceExpandedToolBodies ? true : persistedExpanded === null ? getCardDefault("inlineTools") : persistedExpanded;
    if (hasResult) {
      expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? "block" : "none") + ';"><div class="inline-tool-result">' + formatInlineResult(resultContent, toolName) + "</div></div>";
    } else if (isError) {
      expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? "block" : "none") + ';"><div class="inline-tool-result inline-tool-error">' + escapeHtml2(resultContent || "\u64CD\u4F5C\u5931\u8D25") + "</div></div>";
    } else if (!toolResult) {
      expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? "block" : "none") + ';"><div class="inline-tool-loading">\u7B49\u5F85\u54CD\u5E94\u2026</div></div>';
    }
    var isTruncated = toolResult && toolResult._truncated === true;
    var imageHtml = "";
    if (toolName === "Read") {
      var imgPath = inputData.file_path || inputData.path || fileInfo || "";
      if (imgPath && isImagePath(imgPath)) {
        var imgSrc = "/api/file-raw?path=" + encodeURIComponent(imgPath);
        imageHtml = '<div class="inline-tool-image" onclick="event.stopPropagation();"><img class="inline-tool-image-thumb" loading="lazy" src="' + imgSrc + '" alt="' + escapeHtml2(path) + '" data-path="' + escapeHtml2(imgPath) + `" onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute('data-path'));" onerror="var w=this.closest('.inline-tool-image'); if(w)w.style.display='none';" /></div>`;
      }
    }
    var extraInfoHtml = meta ? '<span class="inline-tool-meta">' + escapeHtml2(meta) + "</span>" : "";
    var extraClass = isError ? "inline-tool-error-inline" : "";
    if (shouldExpand) extraClass += " inline-tool-open";
    var truncatedAttrs = isTruncated ? 'data-truncated="true" data-tool-use-id="' + escapeHtml2(block.id || "") + '" ' : "";
    return '<div class="inline-tool ' + extraClass + '" data-expand-kind="inline-tool" data-expand-key="' + escapeHtml2(expandKey) + '" data-result="' + escapeHtml2(fullResult) + '" data-preview="' + previewDataAttr + '" data-status="' + (isError ? "error" : hasResult ? "done" : "pending") + '" ' + truncatedAttrs + 'onclick="__inlineToolToggle(this)"><div class="inline-tool-row"><span class="inline-tool-status">' + statusIcon + "</span>" + icon + '<span class="inline-tool-title">' + escapeHtml2(title) + "</span>" + extraInfoHtml + "</div>" + imageHtml + expandedHtml + "</div>";
  }
  function renderTerminalTool(block, toolResult, toolName, messageKey, index, options) {
    var opts = options || {};
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
      } else if (exitCode === 0 || exitCode === void 0) {
        statusDot = '<span class="term-status-dot term-success"></span>';
      } else {
        statusDot = '<span class="term-status-dot term-warn"></span>';
      }
    } else {
      statusDot = '<span class="term-status-dot term-running"></span>';
    }
    var prompt = '<span class="term-prompt">$</span>';
    var cmdDisplay = escapeHtml2(command);
    var outputLines = resultContent.split("\n");
    var outputHtml = "";
    for (var oi = 0; oi < outputLines.length; oi++) {
      var line = outputLines[oi];
      if (!line && oi === outputLines.length - 1) continue;
      outputHtml += '<div class="term-line">' + escapeHtml2(line) + "</div>";
    }
    var exitCodeHtml = "";
    if (toolResult && exitCode !== void 0) {
      var codeClass = exitCode === 0 ? "term-exit-success" : "term-exit-error";
      exitCodeHtml = '<div class="term-exit ' + codeClass + '">exit ' + exitCode + "</div>";
    }
    var cmdPreview = command.length > 80 ? command.slice(0, 77) + "\u2026" : command;
    var shouldExpand = opts.forceExpandedToolBodies ? true : persistedExpanded === null ? getCardDefault("terminal") : persistedExpanded;
    var termTruncated = toolResult && toolResult._truncated === true;
    var termTruncAttrs = termTruncated ? ' data-truncated="true" data-tool-use-id="' + escapeHtml2(block.id || "") + '"' : "";
    return '<div class="inline-terminal" data-expand-kind="terminal" data-expand-key="' + escapeHtml2(expandKey) + '" data-expanded="' + (shouldExpand ? "true" : "false") + '"' + termTruncAttrs + '><div class="term-header" role="button" tabindex="0" aria-expanded="' + (shouldExpand ? "true" : "false") + `" onclick="__terminalExpand(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();__terminalExpand(this);}">` + statusDot + '<span class="term-cmd-preview"><span class="term-prompt">$</span> ' + escapeHtml2(cmdPreview) + '</span><span class="term-toggle-icon">' + (shouldExpand ? "\u25BC" : "\u25B6") + '</span></div><div class="term-body" aria-hidden="' + (shouldExpand ? "false" : "true") + '" style="display:' + (shouldExpand ? "block" : "none") + ';"><div class="term-command"><span class="term-prompt">$</span> ' + cmdDisplay + "</div>" + (outputHtml ? '<div class="term-output">' + outputHtml + "</div>" : "") + exitCodeHtml + "</div></div>";
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
  function renderDiffTool(block, toolResult, toolName, messageKey, index, options) {
    var opts = options || {};
    var inputData = block.input || {};
    var path = inputData.file_path || inputData.path || "";
    var fileName = path.split("/").pop() || path;
    var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);
    var oldStr = inputData.old_string || "";
    var newStr = inputData.new_string || inputData.content || "";
    var oldContent = inputData.old_content || "";
    var newContent = inputData.new_content || "";
    var unifiedDiff = inputData.unified_diff || inputData.diff || "";
    var changeKind = inputData.kind || "";
    var isWrite = toolName === "Write" || toolName === "MultiEdit";
    var isError = toolResult && toolResult.is_error;
    var toolResultText = extractToolResultText(toolResult && toolResult.content);
    var hasResult = !!(toolResultText && toolResultText.trim().length > 0);
    var leftCol = "";
    var rightCol = "";
    var unifiedCol = "";
    if (unifiedDiff) {
      unifiedCol = '<div class="diff-col diff-col-full"><div class="diff-col-label">Diff</div>' + renderUnifiedDiffLines(unifiedDiff) + "</div>";
    } else if (isWrite) {
      rightCol = '<div class="diff-line diff-add">+ ' + escapeHtml2(newContent) + "</div>";
    } else {
      if (oldStr) {
        leftCol = '<div class="diff-line diff-remove">- ' + escapeHtml2(oldStr) + "</div>";
      }
      if (newStr) {
        rightCol = '<div class="diff-line diff-add">+ ' + escapeHtml2(newStr) + "</div>";
      }
    }
    var statusClass = "";
    var statusText = "";
    if (toolResult) {
      if (isError) {
        statusClass = "diff-error";
        statusText = toolResultText.indexOf("haven't granted") !== -1 || toolResultText.indexOf("permission") !== -1 ? "\u7B49\u5F85\u6388\u6743" : "\u5931\u8D25";
      } else {
        statusClass = "diff-success";
        statusText = changeKind === "add" ? "\u5DF2\u65B0\u589E" : changeKind === "delete" ? "\u5DF2\u5220\u9664" : changeKind === "move" ? "\u5DF2\u79FB\u52A8" : "\u5DF2\u4FEE\u6539";
      }
    } else {
      statusClass = "diff-pending";
      statusText = "\u6267\u884C\u4E2D";
    }
    var expandKey = buildExpandKey("diff", [messageKey, toolId || index, index]);
    var persistedExpanded = getPersistedExpandState(expandKey);
    var cardDefaultExpand = getCardDefault("editCards");
    var shouldExpand = opts.forceExpandedToolBodies ? true : persistedExpanded === null ? cardDefaultExpand : persistedExpanded;
    var collapsedClass = shouldExpand ? "" : " collapsed";
    var bothCols = !unifiedCol && leftCol && rightCol;
    var colClass = bothCols ? "diff-col-half" : "diff-col-full";
    var columnsHtml = unifiedCol || (bothCols ? '<div class="diff-col ' + colClass + '"><div class="diff-col-label">\u65E7</div>' + leftCol + "</div>" : "") + '<div class="diff-col ' + colClass + '"><div class="diff-col-label">' + (bothCols ? "\u65B0" : "") + "</div>" + (rightCol || leftCol || renderEmptyDiff(path)) + "</div>";
    var openButton = path ? '<button class="diff-open-file" type="button" data-path="' + escapeHtml2(path) + `" title="\u6253\u5F00\u6587\u4EF6" onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute('data-path'));">\u6253\u5F00</button>` : "";
    return '<div class="inline-diff' + collapsedClass + '" data-tool-name="' + escapeHtml2(toolName) + '" data-expand-kind="diff" data-expand-key="' + escapeHtml2(expandKey) + '" data-tool-use-id="' + escapeHtml2(toolId) + '" data-path="' + escapeHtml2(path) + '"><div class="diff-header" role="button" tabindex="0" aria-expanded="' + (shouldExpand ? "true" : "false") + `" onclick="__tcToggle(event,this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();__tcToggle(event,this);}"><span class="diff-file-icon"></span><span class="diff-file-name">` + escapeHtml2(fileName) + "</span>" + renderTailMarqueePath(path, "diff-path") + '<span class="diff-status ' + statusClass + '">' + statusText + "</span>" + openButton + '<span class="diff-toggle">\u25BC</span></div><div class="diff-body" aria-hidden="' + (shouldExpand ? "false" : "true") + '"><div class="diff-columns">' + columnsHtml + "</div></div></div>";
  }
  function renderUnifiedDiffLines(diff) {
    var lines = String(diff || "").split("\n");
    var limit = 600;
    var html = "";
    for (var i = 0; i < lines.length && i < limit; i++) {
      var line = lines[i];
      var cls = "diff-context";
      if (/^@@/.test(line)) cls = "diff-hunk";
      else if (/^\+/.test(line) && !/^\+\+\+/.test(line)) cls = "diff-add";
      else if (/^-/.test(line) && !/^---/.test(line)) cls = "diff-remove";
      html += '<div class="diff-line ' + cls + '">' + escapeHtml2(line || " ") + "</div>";
    }
    if (lines.length > limit) {
      html += '<div class="diff-line diff-context">\u2026\uFF08\u5DF2\u622A\u65AD ' + (lines.length - limit) + " \u884C\uFF09</div>";
    }
    return html || renderEmptyDiff("");
  }
  function renderEmptyDiff(path) {
    var suffix = path ? "\uFF0C\u53EF\u6253\u5F00\u6587\u4EF6\u67E5\u770B\u5F53\u524D\u5185\u5BB9" : "";
    return '<div class="diff-empty">Codex \u672A\u63D0\u4F9B\u5185\u8054 diff' + suffix + "\u3002</div>";
  }
  function formatInlineResult(content, toolName) {
    if (!content) return '<span class="inline-tool-empty">\u65E0\u8F93\u51FA</span>';
    return '<pre class="inline-tool-result-text" style="max-height: 300px; overflow-y: auto;">' + escapeHtml2(content) + "</pre>";
  }
  function renderToolUseCard(block, toolResult, index, messageKey, options) {
    var opts = options || {};
    var toolName = block.name || "unknown";
    var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);
    var fileInfo = extractFileInfo(toolName, block.input);
    if (toolName === "Read" || toolName === "Glob" || toolName === "Grep" || toolName === "WebFetch" || toolName === "WebSearch" || toolName === "TodoRead") {
      return renderInlineTool(block, toolResult, toolName, fileInfo, "", messageKey, index, opts);
    }
    if (toolName === "Bash") {
      return renderTerminalTool(block, toolResult, toolName, messageKey, index, opts);
    }
    if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
      return renderDiffTool(block, toolResult, toolName, messageKey, index, opts);
    }
    if (toolName === "AskUserQuestion" && block.input && block.input.questions) {
      var questions = block.input.questions;
      if (questions && questions.length > 0) {
        var isAnswered = !!toolResult;
        var sel = state.askUserSelections[toolId] || {};
        var isSubmitted = !!sel.submitted;
        var answerText = isAnswered ? extractToolResultText(toolResult.content) : "";
        var answerLines = answerText ? answerText.trim().split("\n") : [];
        var headerLabel = "";
        for (var hi = 0; hi < questions.length; hi++) {
          if (questions[hi].header) {
            headerLabel = questions[hi].header;
            break;
          }
        }
        var headerSummary = headerLabel ? '<span class="tool-use-summary">' + escapeHtml2(headerLabel) + "</span>" : "";
        var questionsHtml = "";
        questions.forEach(function(question, qIdx) {
          var isMulti = !!question.multiSelect;
          var questionText = question.question ? '<div class="ask-user-title">' + escapeHtml2(question.question) + "</div>" : "";
          var optionsHtml = "";
          if (question.options && question.options.length > 0) {
            optionsHtml = '<div class="ask-user-options" data-multi-select="' + isMulti + '">';
            question.options.forEach(function(opt, idx) {
              var label = opt.label ? escapeHtml2(opt.label) : "\u9009\u9879 " + (idx + 1);
              var descHtml = opt.description ? '<div class="ask-user-option-desc">' + escapeHtml2(opt.description) + "</div>" : "";
              if (isAnswered) {
                var answerLine = answerLines[qIdx] || answerLines[0] || "";
                var chosenLabels = answerLine.split(",").map(function(s) {
                  return s.trim();
                });
                var isChosen = chosenLabels.indexOf(opt.label || "") !== -1;
                optionsHtml += '<div class="ask-user-option ask-user-option-readonly' + (isChosen ? " ask-user-option-chosen" : "") + '"><span class="ask-user-indicator"></span><div class="ask-user-option-content"><div class="ask-user-option-label">' + label + "</div>" + descHtml + "</div></div>";
              } else {
                var isSelected = (sel[qIdx] || []).indexOf(idx) !== -1;
                var disabledAttr = isSubmitted ? " disabled" : "";
                optionsHtml += '<button class="ask-user-option' + (isSelected ? " selected" : "") + '" data-option-index="' + idx + '" data-question-index="' + qIdx + '" data-option-label="' + escapeHtml2(opt.label || "\u9009\u9879 " + (idx + 1)) + `" onclick="__askSelect('` + escapeHtml2(toolId) + "'," + qIdx + "," + idx + "," + isMulti + ')"' + disabledAttr + '><span class="ask-user-indicator"></span><div class="ask-user-option-content"><div class="ask-user-option-label">' + label + "</div>" + descHtml + "</div></button>";
              }
            });
            optionsHtml += "</div>";
          }
          questionsHtml += '<div class="ask-user-question-group" data-question-index="' + qIdx + '">' + questionText + optionsHtml + "</div>";
        });
        var actionsHtml = "";
        if (!isAnswered) {
          var allAnsweredCheck = true;
          for (var qi = 0; qi < questions.length; qi++) {
            if (!sel[qi] || sel[qi].length === 0) {
              allAnsweredCheck = false;
              break;
            }
          }
          var submitDisabled = !allAnsweredCheck || isSubmitted ? " disabled" : "";
          var submitClass = isSubmitted ? " ask-user-submitted" : "";
          var submitText = isSubmitted ? "\u5DF2\u63D0\u4EA4..." : "\u786E\u8BA4\u63D0\u4EA4";
          actionsHtml = '<div class="ask-user-actions"><button class="ask-user-submit' + submitClass + '" data-tool-use-id="' + escapeHtml2(toolId) + `" onclick="__askSubmit('` + escapeHtml2(toolId) + `')"` + submitDisabled + ">" + submitText + "</button></div>";
        }
        var answeredSummary = "";
        if (isAnswered && answerText) {
          var shortAnswer = answerText.trim().replace(/\n/g, ", ");
          if (shortAnswer.length > 40) shortAnswer = shortAnswer.slice(0, 37) + "...";
          answeredSummary = '<span class="tool-use-file">' + escapeHtml2(shortAnswer) + "</span>";
        }
        var askExpandKey = buildExpandKey("tool-card", [messageKey, toolId]);
        var askPersisted = getPersistedExpandState(askExpandKey);
        var askShouldExpand = opts.forceExpandedToolBodies ? true : askPersisted === null ? !isAnswered : askPersisted;
        var askCollapsed = askShouldExpand ? "" : " collapsed";
        var answeredClass = isAnswered ? " ask-user-answered" : "";
        return '<div class="tool-use-card ask-user' + answeredClass + askCollapsed + '" data-tool-use-id="' + escapeHtml2(toolId) + '" data-expand-kind="tool-card" data-expand-key="' + escapeHtml2(askExpandKey) + '"><div class="tool-use-header" data-tool-toggle onclick="__tcToggle(event,this)"><span class="tool-use-icon">' + (isAnswered ? "\u2713" : "?") + '</span><span class="tool-use-name">\u63D0\u95EE</span>' + headerSummary + answeredSummary + '<span class="tool-use-toggle">\u25BC</span></div><div class="tool-use-body ask-user-body">' + questionsHtml + actionsHtml + "</div></div>";
      }
    }
    var description = block.description || block.input && block.input.description || "";
    var summary = generateInputSummary(block.name, block.input);
    var titleText = "";
    var subtitleHtml = "";
    if (description) {
      titleText = description.length > 80 ? description.slice(0, 77) + "..." : description;
      if (fileInfo) {
        subtitleHtml = '<span class="tool-use-file">' + escapeHtml2(fileInfo) + "</span>";
      }
    } else {
      titleText = getToolDisplayName(toolName);
      if (fileInfo) {
        subtitleHtml = '<span class="tool-use-file">' + escapeHtml2(fileInfo) + "</span>";
      }
      if (summary) {
        subtitleHtml += '<span class="tool-use-summary">' + escapeHtml2(summary) + "</span>";
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
        resultHtml = '<pre class="tool-use-result-content">' + escapeHtml2(content) + "</pre>";
      } else {
        resultHtml = '<span class="tool-use-result-empty">\u65E0\u8F93\u51FA</span>';
      }
    } else {
      headerIcon = getToolIcon(toolName);
    }
    var expandKey = buildExpandKey("tool-card", [messageKey, toolId]);
    var persistedExpanded = getPersistedExpandState(expandKey);
    var cardDefaultExpand = getCardDefault("editCards");
    var shouldExpand = opts.forceExpandedToolBodies ? true : persistedExpanded === null ? cardDefaultExpand : persistedExpanded;
    var tcTruncated = toolResult && toolResult._truncated === true;
    var collapsedClass = shouldExpand ? "" : " collapsed";
    var toggleHtml = '<span class="tool-use-toggle">\u25BC</span>';
    return '<div class="tool-use-card ' + statusClass + collapsedClass + '" data-expand-kind="tool-card" data-expand-key="' + escapeHtml2(expandKey) + '" data-tool-use-id="' + escapeHtml2(toolId) + '"' + (tcTruncated ? ' data-truncated="true"' : "") + '><div class="tool-use-header" role="button" tabindex="0" aria-expanded="' + (shouldExpand ? "true" : "false") + `" data-tool-toggle onclick="__tcToggle(event,this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();__tcToggle(event,this);}"><span class="tool-use-icon">` + headerIcon + '</span><span class="tool-use-name">' + escapeHtml2(titleText) + "</span>" + subtitleHtml + toggleHtml + '</div><div class="tool-use-body" aria-hidden="' + (shouldExpand ? "false" : "true") + '">' + (description ? '<div class="tool-use-meta"><span class="tool-use-meta-label">\u5DE5\u5177\uFF1A</span>' + escapeHtml2(toolName) + "</div>" : "") + '<pre class="tool-use-content">' + escapeHtml2(fullJson) + "</pre>" + (resultHtml ? '<div class="tool-use-result">' + resultHtml + "</div>" : "") + "</div></div>";
  }
  function getToolDisplayName(toolName) {
    var names = {
      "Read": "\u8BFB\u53D6\u6587\u4EF6",
      "Write": "\u5199\u5165\u6587\u4EF6",
      "Edit": "\u7F16\u8F91\u6587\u4EF6",
      "MultiEdit": "\u591A\u5904\u7F16\u8F91",
      "Bash": "\u6267\u884C\u547D\u4EE4",
      "Grep": "\u641C\u7D22\u5185\u5BB9",
      "Glob": "\u67E5\u627E\u6587\u4EF6",
      "WebFetch": "\u83B7\u53D6\u7F51\u9875",
      "WebSearch": "\u641C\u7D22\u7F51\u9875",
      "Task": "\u4EFB\u52A1",
      "TodoWrite": "\u66F4\u65B0\u5F85\u529E",
      "TodoRead": "\u8BFB\u53D6\u5F85\u529E",
      "NotebookEdit": "\u7F16\u8F91\u7B14\u8BB0\u672C",
      "Agent": "\u5B50\u4EE3\u7406",
      "AskUserQuestion": "\u63D0\u95EE",
      "Exit": "\u9000\u51FA"
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
      "WebFetch": "\u21E3",
      "WebSearch": "\u21E2",
      "Task": "T",
      "TodoWrite": "\u2610",
      "TodoRead": "\u2611",
      "NotebookEdit": "N",
      "Agent": "A",
      "Exit": "\xD7"
    };
    return icons[toolName] || "\xB7";
  }
  function generateInputSummary(toolName, input) {
    if (!input || typeof input !== "object") return "";
    var keys = Object.keys(input);
    if (keys.length === 0) return "{}";
    if (toolName === "Read") {
      return "\u8BFB\u53D6\u6587\u4EF6";
    }
    if (toolName === "Write") {
      return "\u5199\u5165\u6587\u4EF6";
    }
    if (toolName === "Edit") {
      var edits = input.edits ? input.edits.length : 0;
      return "\u7F16\u8F91 (" + edits + " \u5904\u4FEE\u6539)";
    }
    if (toolName === "Bash") {
      var cmd = input.command || "";
      if (cmd) {
        var cmdPreview = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
        return "\u547D\u4EE4\uFF1A" + cmdPreview;
      }
    }
    if (toolName === "Grep") {
      var pattern = input.pattern || "";
      var path = input.path || "";
      if (pattern) {
        return "\u641C\u7D22\uFF1A" + pattern + (path ? " (\u5728 " + path + ")" : "");
      }
    }
    if (toolName === "Glob") {
      var pattern = input.pattern || "";
      if (pattern) return "\u67E5\u627E\uFF1A" + pattern;
    }
    if (toolName === "Agent") {
      var task = input.prompt || input.task || "";
      if (task) {
        var taskPreview = task.length > 40 ? task.slice(0, 40) + "..." : task;
        return "\u4EFB\u52A1\uFF1A" + taskPreview;
      }
    }
    if (toolName === "Task") {
      var task = input.task || input.description || "";
      if (task) {
        var taskPreview = task.length > 40 ? task.slice(0, 40) + "..." : task;
        return "\u4EFB\u52A1\uFF1A" + taskPreview;
      }
    }
    if (toolName === "TodoWrite") {
      var todos = input.todos || [];
      return "\u66F4\u65B0\u5F85\u529E (" + todos.length + " \u9879)";
    }
    if (toolName === "WebSearch") {
      var query = input.query || "";
      if (query) return "\u641C\u7D22\uFF1A" + query;
    }
    var firstKey = keys[0];
    var firstVal = input[firstKey];
    if (typeof firstVal === "string") {
      var valPreview = firstVal.length > 50 ? firstVal.slice(0, 50) + "..." : firstVal;
      return firstKey + ": " + valPreview;
    }
    return keys.length + " \u4E2A\u53C2\u6570";
  }
  function extractFileInfo(toolName, input) {
    if (!input) return null;
    var path = input.file_path || input.path || input.cwd;
    if (path) {
      if (path.length > 50) {
        return "..." + path.slice(-47);
      }
      return path;
    }
    return null;
  }
  function formatAssistantResponse(text) {
    if (!text) return "";
    var newline = String.fromCharCode(10);
    var lines = text.split(newline);
    var cleanLines = [];
    var started = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (!started && !trimmed) continue;
      started = true;
      if (trimmed.indexOf("\u23FA") === 0 && trimmed.length > 2) {
        cleanLines.push(trimmed.slice(1).trim());
        continue;
      }
      if (trimmed.indexOf("\u25CF") === 0) {
        trimmed = trimmed.slice(1).trim();
        if (!trimmed) continue;
        line = trimmed;
      }
      cleanLines.push(line);
    }
    while (cleanLines.length > 0 && !cleanLines[cleanLines.length - 1].trim()) {
      cleanLines.pop();
    }
    var deduped = [];
    var seenNorm = {};
    for (var j = 0; j < cleanLines.length; j++) {
      var normalized = cleanLines[j].replace(/\s+/g, "");
      if (normalized.length > 5 && seenNorm[normalized]) continue;
      if (normalized.length > 5) seenNorm[normalized] = true;
      deduped.push(cleanLines[j]);
    }
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
    function styleAttr(a) {
      return a ? ' style="text-align:' + a + '"' : "";
    }
    function buildTable(headers2, aligns2, rows2) {
      var thead = "<thead><tr>" + headers2.map(function(c, idx) {
        return "<th" + styleAttr(aligns2[idx]) + ">" + c.trim() + "</th>";
      }).join("") + "</tr></thead>";
      var tbody = rows2.length ? "<tbody>" + rows2.map(function(r) {
        return "<tr>" + r.map(function(c, idx) {
          return "<td" + styleAttr(aligns2[idx]) + ">" + c.trim() + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody>" : "";
      return '<div class="md-table-wrap"><table class="md-table">' + thead + tbody + "</table></div>";
    }
    while (i < lines.length) {
      var header = lines[i];
      if (header.indexOf("|") !== -1 && i + 1 < lines.length) {
        var sep = lines[i + 1].trim();
        if (/^\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?$/.test(sep)) {
          var headers = splitRow(header);
          var aligns = splitRow(sep).map(function(c) {
            var t15 = c.trim();
            var L = t15.charAt(0) === ":";
            var R = t15.charAt(t15.length - 1) === ":";
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
    var markdownLinks = [];
    var result = escapeHtml2(stashMarkdownLinks(String(text)));
    var bt = String.fromCharCode(96);
    var newline = String.fromCharCode(10);
    function serverFilePathFromLink(target) {
      var value = String(target || "").trim();
      if (!value) return null;
      if (value.charAt(0) === "<" && value.charAt(value.length - 1) === ">") {
        value = value.slice(1, -1).trim();
      }
      if (/^file:\/\//i.test(value)) {
        try {
          var fileUrl = new URL(value);
          if (fileUrl.protocol !== "file:") return null;
          value = decodeURIComponent(fileUrl.pathname || "");
        } catch (_) {
          value = value.replace(/^file:\/\/(?:localhost)?/i, "");
          try {
            value = decodeURIComponent(value);
          } catch (_2) {
          }
        }
      } else if (value.charAt(0) !== "/" || value.indexOf("//") === 0) {
        return null;
      }
      if (/^\/(?:api|android|macos)(?:\/|$)/.test(value)) return null;
      value = value.replace(/#L\d+(?:C\d+)?$/i, "");
      value = value.replace(/:\d+(?::\d+)?$/, "");
      return value.charAt(0) === "/" ? value : null;
    }
    function safeExternalLink(target, label) {
      var value = String(target || "").trim();
      if (value.charAt(0) === "<" && value.charAt(value.length - 1) === ">") {
        value = value.slice(1, -1).trim();
      }
      if (!/^(?:https?:\/\/|mailto:|#)/i.test(value)) return label;
      var escapedTarget = escapeHtml2(value);
      var opensNewWindow = /^https?:\/\//i.test(value);
      return '<a href="' + escapedTarget + '"' + (opensNewWindow ? ' target="_blank"' : "") + ' rel="noopener">' + label + "</a>";
    }
    function stashMarkdownLinks(source) {
      function findTargetEnd(start2) {
        if (source.charAt(start2) === "<") {
          var closeAngle = source.indexOf(">", start2 + 1);
          return closeAngle >= 0 && source.charAt(closeAngle + 1) === ")" ? closeAngle + 1 : -1;
        }
        var depth = 0;
        for (var i = start2; i < source.length; i += 1) {
          if (source.charAt(i) === "\\") {
            i += 1;
            continue;
          }
          if (source.charAt(i) === "(") depth += 1;
          else if (source.charAt(i) === ")") {
            if (depth === 0) return i;
            depth -= 1;
          }
        }
        return -1;
      }
      var output = "";
      var cursor = 0;
      var inFence = false;
      var inInlineCode = false;
      while (cursor < source.length) {
        if (source.slice(cursor, cursor + 3) === "```") {
          inFence = !inFence;
          output += "```";
          cursor += 3;
          continue;
        }
        if (!inFence && source.charAt(cursor) === "`") {
          inInlineCode = !inInlineCode;
          output += "`";
          cursor += 1;
          continue;
        }
        if (!inFence && !inInlineCode && source.charAt(cursor) === "[" && source.charAt(cursor - 1) !== "!") {
          var closeText = source.indexOf("](", cursor + 1);
          var closeTarget = closeText >= 0 ? findTargetEnd(closeText + 2) : -1;
          if (closeText > cursor + 1 && closeTarget > closeText + 2) {
            var label = escapeHtml2(source.slice(cursor + 1, closeText));
            var target = source.slice(closeText + 2, closeTarget).trim();
            var serverPath = serverFilePathFromLink(target);
            var linkHtml;
            if (serverPath) {
              var rawUrl = "/api/file-raw?download=1&amp;path=" + encodeURIComponent(serverPath);
              linkHtml = '<a class="server-file-link" href="' + rawUrl + '" data-server-file-path="' + escapeHtml2(serverPath) + `" title="\u6253\u5F00\u6216\u4E0B\u8F7D\u670D\u52A1\u7AEF\u6587\u4EF6" onclick="if(window.__openFilePreview){event.preventDefault();window.__openFilePreview(this.getAttribute('data-server-file-path'));}">` + label + "</a>";
            } else {
              linkHtml = safeExternalLink(target, label);
            }
            var token = "WANDMARKDOWNLINKTOKEN" + markdownLinks.length + "END";
            markdownLinks.push(linkHtml);
            output += token;
            cursor = closeTarget + 1;
            continue;
          }
        }
        output += source.charAt(cursor);
        cursor += 1;
      }
      return output;
    }
    function restoreMarkdownLinks(source) {
      for (var i = 0; i < markdownLinks.length; i += 1) {
        source = source.split("WANDMARKDOWNLINKTOKEN" + i + "END").join(markdownLinks[i]);
      }
      return source;
    }
    function replacePair(source, marker, openTag, closeTag) {
      var cursor = 0;
      while (true) {
        var start2 = source.indexOf(marker, cursor);
        if (start2 === -1) break;
        var end = source.indexOf(marker, start2 + marker.length);
        if (end === -1) break;
        var inner = source.slice(start2 + marker.length, end);
        if (!inner) {
          cursor = end + marker.length;
          continue;
        }
        var replacement2 = openTag + inner + closeTag;
        source = source.slice(0, start2) + replacement2 + source.slice(end + marker.length);
        cursor = start2 + replacement2.length;
      }
      return source;
    }
    function isWordChar(code2) {
      return code2 >= 48 && code2 <= 57 || code2 >= 65 && code2 <= 90 || code2 >= 97 && code2 <= 122 || code2 === 95;
    }
    function replaceUnderscoreEmphasis(source, openTag, closeTag) {
      var cursor = 0;
      while (cursor < source.length) {
        var start2 = source.indexOf("_", cursor);
        if (start2 === -1) break;
        var leftCode = start2 > 0 ? source.charCodeAt(start2 - 1) : 0;
        if (isWordChar(leftCode)) {
          cursor = start2 + 1;
          continue;
        }
        var searchFrom = start2 + 1;
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
        var inner = source.slice(start2 + 1, end);
        if (!inner) {
          cursor = end + 1;
          continue;
        }
        var replacement2 = openTag + inner + closeTag;
        source = source.slice(0, start2) + replacement2 + source.slice(end + 1);
        cursor = start2 + replacement2.length;
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
        var dotIndex = line.indexOf(". ");
        if (dotIndex <= 0) return line;
        for (var i = 0; i < dotIndex; i += 1) {
          var code2 = line.charCodeAt(i);
          if (code2 < 48 || code2 > 57) return line;
        }
        return "<li>" + line.slice(dotIndex + 2) + "</li>";
      }).join(newline);
    }
    function wrapParagraphs(source) {
      return source.split(newline + newline).map(function(part) {
        var block = part.trim();
        if (!block) return "";
        if (block.indexOf("<div") === 0 || block.indexOf("<h1") === 0 || block.indexOf("<h2") === 0 || block.indexOf("<h3") === 0 || block.indexOf("<h4") === 0 || block.indexOf("<h5") === 0 || block.indexOf("<h6") === 0 || block.indexOf("<ul") === 0 || block.indexOf("<ol") === 0 || block.indexOf("<li") === 0 || block.indexOf("<blockquote") === 0 || block.indexOf("<pre") === 0) {
          return block;
        }
        return "<p>" + block.split(newline).join("<br>") + "</p>";
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
      var protectedHighlighted = highlighted.replace(/_/g, "&#95;").replace(/\*/g, "&#42;");
      var replacement = '<div class="code-block"><div class="code-block-header"><span class="code-lang">' + (lang || "code") + '</span><button class="code-copy">Copy</button></div><pre><code>' + protectedHighlighted + "</code></pre></div>";
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
      var protectedInlineCode = inlineCode.replace(/_/g, "&#95;").replace(/\*/g, "&#42;");
      var inlineReplacement = '<code class="code-inline">' + protectedInlineCode + "</code>";
      result = result.slice(0, inlineStart) + inlineReplacement + result.slice(inlineEnd + 1);
      pos = inlineStart + inlineReplacement.length;
    }
    result = replacePair(result, "**", "<strong>", "</strong>");
    result = replacePair(result, "*", "<em>", "</em>");
    result = replaceUnderscoreEmphasis(result, "<em>", "</em>");
    result = replaceLinePrefix(result, "### ", "<h3>", "</h3>");
    result = replaceLinePrefix(result, "## ", "<h2>", "</h2>");
    result = replaceLinePrefix(result, "# ", "<h1>", "</h1>");
    result = replaceLinePrefix(result, "&gt; ", "<blockquote>", "</blockquote>");
    result = replaceLinePrefix(result, "- ", "<li>", "</li>");
    result = replaceLinePrefix(result, "* ", "<li>", "</li>");
    result = replaceOrderedList(result);
    result = parseMarkdownTables(result);
    var lines = result.split(newline);
    var grouped = [];
    var listBuffer = [];
    function flushListBuffer() {
      if (!listBuffer.length) return;
      grouped.push("<ul>" + listBuffer.join("") + "</ul>");
      listBuffer = [];
    }
    lines.forEach(function(line) {
      if (line.indexOf("<li>") === 0 && line.lastIndexOf("</li>") === line.length - 5) {
        listBuffer.push(line);
        return;
      }
      flushListBuffer();
      grouped.push(line);
    });
    flushListBuffer();
    result = wrapParagraphs(grouped.join(newline));
    result = restoreMarkdownLinks(result);
    return '<div class="markdown-content">' + result + "</div>";
  }
  function highlightCode(code, lang) {
    code = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return code;
  }
  function shortCommand(cmd) {
    var s = String(cmd || "").trim();
    return s.length <= 24 ? s || "\u672A\u9009\u62E9\u4F1A\u8BDD" : s.slice(0, 21) + "...";
  }
  function normalizeTerminalOutput(value) {
    return String(value || "").replace(/\r\r\n/g, "\r\n").replace(/\u0000/g, "");
  }

  // src/web-ui/browser/session-engine.ts
  function showLoginCertHint() {
    var hint = document.getElementById("login-cert-hint");
    if (hint) hint.classList.remove("hidden");
    var httpLink = document.getElementById("login-cert-http-link");
    if (httpLink) {
      httpLink.href = "http://" + location.host + location.pathname;
      httpLink.style.display = location.protocol === "https:" ? "" : "none";
    }
  }
  function hideLoginCertHint() {
    var hint = document.getElementById("login-cert-hint");
    if (hint) hint.classList.add("hidden");
  }
  function login() {
    if (state.loginPending) return;
    var passwordEl = document.getElementById("password");
    var loginButton = document.getElementById("login-button");
    var errorEl = document.getElementById("login-error");
    if (!passwordEl || !loginButton || !errorEl) return;
    hideError2(errorEl);
    hideLoginCertHint();
    passwordEl.dataset.error = "false";
    passwordEl.setAttribute("aria-invalid", "false");
    state.loginPending = true;
    loginButton.disabled = true;
    loginButton.textContent = "\u767B\u5F55\u4E2D...";
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordEl.value }),
      credentials: "same-origin"
    }).then(function(res) {
      if (res.status === 429) {
        showError2(errorEl, "\u767B\u5F55\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
        return Promise.reject("handled");
      }
      if (!res.ok) {
        passwordEl.dataset.error = "true";
        passwordEl.setAttribute("aria-invalid", "true");
        showError2(errorEl, "\u5BC6\u7801\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5\u3002");
        return Promise.reject("handled");
      }
      return fetch("/api/config", { credentials: "same-origin" });
    }).then(function(res) {
      if (!res.ok) {
        if (location.protocol === "https:") {
          showLoginCertHint();
        } else {
          showError2(errorEl, "\u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002");
        }
        return Promise.reject("handled");
      }
      return res.json();
    }).then(function(config) {
      state.config = config;
      var statusDot = document.getElementById("status-dot");
      var statusText = document.getElementById("status-text");
      if (statusDot) statusDot.classList.add("active");
      if (statusText) statusText.textContent = "\u5DF2\u767B\u5F55";
      return refreshAll();
    }).then(function() {
      startPolling();
      render8();
    }).catch(function(error) {
      if (error === "handled") return;
      console.error("[wand] Login error:", error);
      showError2(errorEl, "\u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002");
    }).finally(function() {
      state.loginPending = false;
      loginButton.disabled = false;
      loginButton.textContent = "\u8FDB\u5165\u63A7\u5236\u53F0";
    });
  }
  function hasNativeSwitchServer() {
    return typeof WandNative !== "undefined" && typeof WandNative.switchServer === "function";
  }
  function switchServer() {
    if (!hasNativeSwitchServer()) return;
    try {
      WandNative.switchServer();
    } catch (e) {
    }
  }
  function hasNativeBackToApp() {
    if (typeof WandNative !== "undefined" && typeof WandNative.backToNative === "function") return true;
    return typeof window.__wandBackToNative === "function";
  }
  function backToNativeApp() {
    try {
      if (typeof WandNative !== "undefined" && typeof WandNative.backToNative === "function") {
        WandNative.backToNative();
        return;
      }
      if (typeof window.__wandBackToNative === "function") window.__wandBackToNative();
    } catch (e) {
    }
  }
  function logout2() {
    fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(function() {
    });
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
    state.claudeHistoryExpanded = false;
    state.claudeHistoryExpandedDirs = {};
    state.sessionsDrawerOpen = false;
    writeStoredBoolean("wand-sidebar-open", false);
    render8();
  }
  function refreshAll() {
    return loadSessions();
  }
  function getModeLabel(mode) {
    return mode === "full-access" ? "\u5168\u6743\u9650" : mode === "default" ? "\u9ED8\u8BA4" : mode === "native" ? "\u539F\u751F" : mode === "auto-edit" ? "\u81EA\u52A8\u7F16\u8F91" : mode === "managed" ? "\u6258\u7BA1" : mode;
  }
  function getPreferredTool() {
    return state.sessionTool || state.preferredCommand || "claude";
  }
  function getComposerTool() {
    var selected = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    return selected && selected.provider || state.preferredCommand || "claude";
  }
  function getComposerPlaceholder(session, terminalInteractive) {
    if (terminalInteractive) return "\u952E\u76D8\u8F93\u5165\u5C06\u53D1\u9001\u5230\u7EC8\u7AEF";
    if (session && (session.status === "exited" || session.status === "failed" || session.status === "stopped")) {
      if (canAutoResumeSession(session)) return "\u8F93\u5165\u6D88\u606F\u4EE5\u7EE7\u7EED\u4F1A\u8BDD";
      return "\u4F1A\u8BDD\u5DF2\u7ED3\u675F";
    }
    if (isStructuredSession2(session) && session.structuredState && session.structuredState.inFlight) {
      return "\u56DE\u590D\u4E2D\uFF0C\u53EF\u7EE7\u7EED\u8F93\u5165";
    }
    return "\u6253\u5B57\u6216\u6309\u4F4F\u8BF4\u8BDD";
  }
  function getToolModeHint2(tool, mode) {
    if (tool === "codex") {
      return "Codex \u652F\u6301 PTY \u7EC8\u7AEF\u4E0E\u7ED3\u6784\u5316\uFF08JSONL\uFF09\u4E24\u79CD\u4F1A\u8BDD\uFF0C\u7ED3\u6784\u5316\u6A21\u5F0F\u6309 full-access \u542F\u52A8\u3002";
    }
    if (tool === "opencode") {
      return mode === "full-access" || mode === "managed" || mode === "auto-edit" ? "OpenCode \u5C06\u81EA\u52A8\u6279\u51C6\u672A\u663E\u5F0F\u62D2\u7EDD\u7684\u6743\u9650\uFF1B\u652F\u6301 TUI \u4E0E JSON \u7ED3\u6784\u5316\u4F1A\u8BDD\u3002" : "OpenCode \u4F7F\u7528\u81EA\u8EAB\u6743\u9650\u914D\u7F6E\uFF1B\u7ED3\u6784\u5316\u6A21\u5F0F\u4F1A\u81EA\u52A8\u62D2\u7EDD\u672A\u6279\u51C6\u7684\u6743\u9650\u8BF7\u6C42\u3002";
    }
    if (mode === "full-access") {
      return "\u81EA\u52A8\u786E\u8BA4\u6743\u9650\u8BF7\u6C42\u4E0E\u9AD8\u6743\u9650\u64CD\u4F5C\uFF0C\u9002\u5408\u4F60\u786E\u8BA4\u73AF\u5883\u5B89\u5168\u540E\u7684\u8FDE\u7EED\u4FEE\u6539\u3002";
    }
    if (mode === "auto-edit") {
      return "\u4FDD\u7559\u4EA4\u4E92\u5F0F\u4F1A\u8BDD\uFF0C\u540C\u65F6\u66F4\u504F\u5411\u76F4\u63A5\u7F16\u8F91\u4EE3\u7801\u3002";
    }
    if (mode === "native") {
      return "\u8C03\u7528 Claude \u539F\u751F API \u8F93\u51FA\uFF0C\u9002\u5408\u5FEB\u901F\u95EE\u7B54\u6216\u4E00\u6B21\u6027\u751F\u6210\u3002";
    }
    if (mode === "managed") {
      return "AI \u81EA\u52A8\u5B8C\u6210\u6240\u6709\u5DE5\u4F5C\uFF0C\u65E0\u9700\u4E2D\u9014\u786E\u8BA4\uFF0C\u9002\u5408\u6709\u660E\u786E\u76EE\u6807\u7684\u4EFB\u52A1\u3002";
    }
    return "\u4FDD\u7559\u6807\u51C6\u4EA4\u4E92\u6D41\u7A0B\uFF0C\u9002\u5408\u624B\u52A8\u786E\u8BA4\u6BCF\u4E00\u6B65\u3002";
  }
  function getSupportedModes(tool) {
    if (tool === "codex") {
      return ["full-access"];
    }
    if (tool === "opencode") return ["default", "full-access", "managed"];
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
      return '<option value="' + escapeHtml2(mode) + '"' + (mode === selectedMode ? " selected" : "") + ' title="' + hint + '">' + escapeHtml2(getModeLabel(mode)) + "</option>";
    }).join("");
  }
  function getModeHint(mode) {
    var hints = {
      "default": "\u6807\u51C6\u6A21\u5F0F - \u9700\u8981\u786E\u8BA4\u6587\u4EF6\u4FEE\u6539",
      "full-access": "\u5B8C\u5168\u8BBF\u95EE - \u81EA\u52A8\u786E\u8BA4\u6743\u9650\u4E0E\u64CD\u4F5C",
      "auto-edit": "\u81EA\u52A8\u7F16\u8F91 - \u81EA\u52A8\u786E\u8BA4\u6587\u4EF6\u4FEE\u6539",
      "native": "\u539F\u751F\u6A21\u5F0F - \u8FD4\u56DE\u7ED3\u6784\u5316\u8F93\u51FA",
      "managed": "\u6258\u7BA1\u6A21\u5F0F - AI \u81EA\u52A8\u5B8C\u6210\u6240\u6709\u5DE5\u4F5C"
    };
    return hints[mode] || "";
  }
  function getSessionKindLabel(session) {
    var provider = session && session.provider ? session.provider : "claude";
    return (isStructuredSession2(session) ? "\u7ED3\u6784\u5316" : "\u7EC8\u7AEF") + " \xB7 " + provider;
  }
  function getSessionKindDescription(session) {
    return isStructuredSession2(session) ? "\u7ED3\u6784\u5316 \xB7 \u5757\u7EA7\u8BB0\u5F55" : session && session.provider === "codex" ? "\u7EC8\u7AEF \xB7 Codex PTY\uFF08chat \u4E3A\u89E3\u6790\u89C6\u56FE\uFF09" : "\u7EC8\u7AEF \xB7 PTY \u4F1A\u8BDD";
  }
  function shouldRequestChatFormat3(session) {
    if (!session) return false;
    return isStructuredSession2(session) || session.provider === "codex";
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
  function isStructuredSession2(session) {
    return !!session && (session.sessionKind === "structured" || session.runner === "claude-cli-print");
  }
  function syncComposerModeSelect() {
    state.chatMode = getSafeModeForTool("claude", state.chatMode);
    var modeHint = document.getElementById("mode-hint");
    if (modeHint) modeHint.textContent = getModeHint(state.chatMode);
    refreshAllChatModeTrios2();
  }
  var sessionConfigMutationTails = /* @__PURE__ */ Object.create(null);
  var sessionConfigMutationRevisions = /* @__PURE__ */ Object.create(null);
  var pendingSessionConfig = /* @__PURE__ */ Object.create(null);
  function getPendingSessionConfig(sessionId) {
    return sessionId ? pendingSessionConfig[sessionId] || null : null;
  }
  function setPendingSessionConfig(sessionId, key, value) {
    if (!sessionId) return;
    var pending = pendingSessionConfig[sessionId] || (pendingSessionConfig[sessionId] = {});
    pending[key] = value;
  }
  function clearPendingSessionConfig(sessionId) {
    if (sessionId) delete pendingSessionConfig[sessionId];
  }
  function enqueueSessionConfigMutation(sessionId, task) {
    var revision = (sessionConfigMutationRevisions[sessionId] || 0) + 1;
    sessionConfigMutationRevisions[sessionId] = revision;
    var previous = sessionConfigMutationTails[sessionId] || Promise.resolve();
    var request = previous.catch(function() {
    }).then(task);
    sessionConfigMutationTails[sessionId] = request.catch(function() {
    });
    return request.then(function(data) {
      return { data, latest: sessionConfigMutationRevisions[sessionId] === revision };
    }, function(error) {
      return Promise.reject({ error, latest: sessionConfigMutationRevisions[sessionId] === revision });
    });
  }
  function recoverLatestSessionConfigMutation(sessionId, message) {
    clearPendingSessionConfig(sessionId);
    Promise.resolve(loadSessions()).catch(function() {
    }).finally(function() {
      refreshAllChatModeTrios2();
    });
    showToast2(message, "error");
  }
  function applyLatestSessionConfigSnapshot(sessionId, outcome) {
    if (!outcome.latest) return false;
    var data = outcome.data;
    if (data && data.error) {
      recoverLatestSessionConfigMutation(sessionId, data.error);
      return false;
    }
    if (!data || !data.id) {
      recoverLatestSessionConfigMutation(sessionId, "\u4F1A\u8BDD\u8BBE\u7F6E\u66F4\u65B0\u5931\u8D25");
      return false;
    }
    updateSessionSnapshot(data);
    clearPendingSessionConfig(sessionId);
    refreshAllChatModeTrios2();
    return true;
  }
  function renderChatModeTrioHtml(session, opts) {
    opts = opts || {};
    var kind = opts.kind === "compact" || opts.kind === "popover" ? opts.kind : "dropdown";
    var preferredTool = getPreferredTool();
    var composerMode = state.chatMode || "default";
    var modelText = getEffectiveModel(session) || "";
    var modelLabel = getShortModelLabel(modelText, session);
    var thinkingText = getEffectiveThinking(session);
    function pill(ctrl, label, value, optionsHtml) {
      var tagHtml = kind === "compact" ? "" : '<span class="chat-mode-trio-tag">' + escapeHtml2(label) + "</span>";
      return '<span class="composer-text-pill chat-mode-trio-pill" data-mode-control-pill="' + ctrl + '" title="' + escapeHtml2(label) + '">' + tagHtml + '<span class="composer-text-label">' + escapeHtml2(value) + '</span><select class="composer-text-hidden-select" data-mode-control="' + ctrl + '" aria-label="' + escapeHtml2(label) + '">' + optionsHtml + "</select></span>";
    }
    return '<div class="chat-mode-trio chat-mode-trio-' + kind + '" role="group" aria-label="\u4F1A\u8BDD\u8BBE\u7F6E">' + pill("mode", "\u6A21\u5F0F", composerMode, renderChatModeOptionsRaw(preferredTool, composerMode)) + '<span class="composer-text-sep" aria-hidden="true">\xB7</span>' + pill("model", "\u6A21\u578B", modelLabel, renderChatModelOptionsRaw(modelText, session)) + '<span class="composer-text-sep" aria-hidden="true">\xB7</span>' + pill("thinking", "\u601D\u8003", getThinkingCompactLabel(thinkingText, session), renderThinkingOptions(thinkingText, session)) + "</div>";
  }
  function getThinkingCompactLabel(id, session) {
    var effort = getThinkingLabel(id, session);
    if (effort === "low") return "\u4F4E";
    if (effort === "medium") return "\u4E2D";
    if (effort === "high") return "\u9AD8";
    if (effort === "xhigh") return "\u8D85\u9AD8";
    if (effort === "max") return "\u6781\u9AD8";
    if (effort === "ultra") return "\u6781\u9650";
    return "\u81EA\u52A8";
  }
  function getModelDisplayLabel(model, session) {
    var selected = model || "";
    var models = getModelsForCurrentProvider(session);
    if (!selected || selected === "default") {
      for (var j = 0; j < models.length; j++) {
        if (models[j].id === "default") return models[j].label || models[j].id;
      }
      return "\u9ED8\u8BA4";
    }
    for (var i = 0; i < models.length; i++) {
      if (models[i].id === selected) return models[i].label || models[i].id;
    }
    return selected;
  }
  function getShortModelLabel(model, session) {
    var label = getModelDisplayLabel(model, session);
    if (!label || label === "\u8DDF\u968F\u670D\u52A1\u7AEF\u9ED8\u8BA4") return "\u9ED8\u8BA4";
    var cutAt = label.search(/[（(]/);
    if (cutAt > 0) label = label.slice(0, cutAt).trim();
    var slash = label.lastIndexOf("/");
    if (slash >= 0 && slash < label.length - 1) label = label.slice(slash + 1).trim();
    var lower = label.toLowerCase();
    if (lower.indexOf("opus") !== -1) return "Opus";
    if (lower.indexOf("sonnet") !== -1) return "Sonnet";
    if (lower.indexOf("haiku") !== -1) return "Haiku";
    if (lower.indexOf("gpt-5.5") !== -1) return "GPT-5.5";
    if (lower.indexOf("gpt-5") !== -1) return "GPT-5";
    if (lower.indexOf("gpt-4") !== -1) return "GPT-4";
    if (label.length > 12) return label.slice(0, 10) + "\u2026";
    return label;
  }
  function renderThinkingOptions(selected, session) {
    var levels = getThinkingLevels(session);
    var normalized = levels.some(function(level) {
      return level.id === selected;
    }) ? selected : "off";
    return levels.map(function(level) {
      var label = level.id === "off" ? "\u81EA\u52A8\uFF08\u6A21\u578B\u9ED8\u8BA4\uFF09" : getThinkingCompactLabel(level.id, session);
      return '<option value="' + escapeHtml2(level.id) + '"' + (level.id === normalized ? " selected" : "") + ">" + escapeHtml2(label) + "</option>";
    }).join("");
  }
  function syncThinkingSelect(container, selected, session) {
    var select = container.querySelector('[data-mode-control="thinking"]');
    if (!select) return;
    select.innerHTML = renderThinkingOptions(selected, session);
    select.value = getThinkingLevels(session).some(function(level) {
      return level.id === selected;
    }) ? selected : "off";
  }
  function renderComposerConfigControlsHtml(session) {
    var preferredTool = getPreferredTool();
    var mode = state.chatMode || "default";
    var model = getEffectiveModel(session) || "";
    var thinking = getEffectiveThinking(session);
    var modeLabel = getModeLabel(mode);
    var modelLabel = getShortModelLabel(model, session);
    var thinkingLabel = getThinkingCompactLabel(thinking, session);
    var title = "\u6A21\u5F0F " + modeLabel + " \xB7 \u6A21\u578B " + modelLabel + " \xB7 \u601D\u8003 " + thinkingLabel;
    return '<div class="composer-config-controls" role="group" aria-label="\u4F1A\u8BDD\u8BBE\u7F6E" title="' + escapeHtml2(title) + '"><span class="composer-config-chip composer-config-chip-mode" data-mode-control-pill="mode" title="\u6A21\u5F0F\uFF1A' + escapeHtml2(modeLabel) + '">' + iconSvg("shield", { size: 13, strokeWidth: 1.8, cls: "composer-config-icon" }) + '<span class="composer-config-label">' + escapeHtml2(modeLabel) + '</span><select class="composer-text-hidden-select" data-mode-control="mode" aria-label="\u6A21\u5F0F">' + renderChatModeOptionsRaw(preferredTool, mode) + '</select></span><span class="composer-config-chip composer-config-model" data-mode-control-pill="model" title="\u6A21\u578B\uFF1A' + escapeHtml2(modelLabel) + '">' + iconSvg("cpu", { size: 13, strokeWidth: 1.8, cls: "composer-config-icon" }) + '<span class="composer-config-label">' + escapeHtml2(modelLabel) + '</span><select class="composer-text-hidden-select" data-mode-control="model" aria-label="\u6A21\u578B">' + renderChatModelOptions(model, session) + '</select></span><span class="composer-config-chip composer-config-thinking" data-mode-control-pill="thinking" data-thinking="' + escapeHtml2(thinking) + '" title="\u601D\u8003\u6DF1\u5EA6\uFF1A' + escapeHtml2(thinkingLabel) + '">' + iconSvg("brain", { size: 13, strokeWidth: 1.8, cls: "composer-config-icon" }) + '<span class="composer-config-label">' + escapeHtml2(thinkingLabel) + '</span><select class="composer-text-hidden-select" data-mode-control="thinking" aria-label="\u601D\u8003\u6DF1\u5EA6">' + renderThinkingOptions(thinking, session) + "</select></span></div>";
  }
  function refreshAllChatModeTrios2() {
    var session = getSelectedSession6();
    var preferredTool = getPreferredTool();
    var mode = state.chatMode || "default";
    var model = getEffectiveModel(session) || "";
    var modelLabel = getShortModelLabel(model, session);
    var thinking = getEffectiveThinking(session);
    var trios = document.querySelectorAll(".chat-mode-trio");
    trios.forEach(function(trio) {
      function setPair(ctrl, value, optionsHtml, labelText) {
        var pillNode = trio.querySelector('[data-mode-control-pill="' + ctrl + '"]');
        if (!pillNode) return;
        var label = pillNode.querySelector(".composer-text-label");
        if (label) label.textContent = labelText || value;
        if (ctrl === "thinking") {
          syncThinkingSelect(pillNode, value, session);
          return;
        }
        var sel = pillNode.querySelector('[data-mode-control="' + ctrl + '"]');
        if (!sel) return;
        if (optionsHtml) sel.innerHTML = optionsHtml;
        if (sel.value !== value) sel.value = value;
      }
      setPair("mode", mode, renderChatModeOptionsRaw(preferredTool, mode));
      setPair("model", model, renderChatModelOptionsRaw(model, session), modelLabel);
      setPair("thinking", thinking, "", getThinkingCompactLabel(thinking, session));
    });
    refreshComposerConfigControls(session, mode, getEffectiveModel(session) || "", thinking);
  }
  function refreshComposerConfigControls(session, mode, model, thinking) {
    var preferredTool = getPreferredTool();
    var modeLabel = getModeLabel(mode);
    var modelLabel = getShortModelLabel(model, session);
    var thinkingLabel = getThinkingCompactLabel(thinking, session);
    var controls = document.querySelectorAll(".composer-config-controls");
    controls.forEach(function(control) {
      var title = "\u6A21\u5F0F " + modeLabel + " \xB7 \u6A21\u578B " + modelLabel + " \xB7 \u601D\u8003 " + thinkingLabel;
      control.setAttribute("title", title);
      function updateSelect(part, value, optionsHtml) {
        var sel = part.querySelector("[data-mode-control]");
        if (!sel) return;
        sel.innerHTML = optionsHtml;
        sel.value = value;
      }
      var modePart = control.querySelector('[data-mode-control-pill="mode"]');
      if (modePart) {
        var modeText = modePart.querySelector(".composer-config-label");
        if (modeText) modeText.textContent = modeLabel;
        modePart.setAttribute("title", "\u6A21\u5F0F\uFF1A" + modeLabel);
        updateSelect(modePart, mode, renderChatModeOptionsRaw(preferredTool, mode));
      }
      var modelPart = control.querySelector('[data-mode-control-pill="model"]');
      if (modelPart) {
        var modelText = modelPart.querySelector(".composer-config-label");
        if (modelText) modelText.textContent = modelLabel;
        modelPart.setAttribute("title", "\u6A21\u578B\uFF1A" + modelLabel);
        updateSelect(modelPart, model, renderChatModelOptions(model, session));
      }
      var thinkingPart = control.querySelector('[data-mode-control-pill="thinking"]');
      if (thinkingPart) {
        var thinkingText = thinkingPart.querySelector(".composer-config-label");
        if (thinkingText) thinkingText.textContent = thinkingLabel;
        thinkingPart.setAttribute("data-thinking", thinking);
        thinkingPart.setAttribute("title", "\u601D\u8003\u6DF1\u5EA6\uFF1A" + thinkingLabel);
        syncThinkingSelect(thinkingPart, thinking, session);
      }
    });
  }
  function renderChatModeOptionsRaw(tool, selectedMode) {
    return getSupportedModes(tool).map(function(mode) {
      return '<option value="' + escapeHtml2(mode) + '"' + (mode === selectedMode ? " selected" : "") + ">" + escapeHtml2(mode) + "</option>";
    }).join("");
  }
  function getProviderKey(provider) {
    return provider === "codex" || provider === "opencode" ? provider : "claude";
  }
  function getProviderForSession(session) {
    return getProviderKey(session && session.provider || state.sessionTool || "claude");
  }
  function getConfigDefaultModels() {
    var configured = state.config && state.config.defaultModels && typeof state.config.defaultModels === "object" ? state.config.defaultModels : {};
    return {
      claude: typeof configured.claude === "string" ? configured.claude : state.config && state.config.defaultModel || "",
      codex: typeof configured.codex === "string" ? configured.codex : state.config && state.config.defaultCodexModel || "",
      opencode: typeof configured.opencode === "string" ? configured.opencode : state.config && state.config.defaultOpenCodeModel || ""
    };
  }
  function getConfigDefaultModelForProvider(provider) {
    var defaults = getConfigDefaultModels();
    var key = getProviderKey(provider);
    return key === "codex" ? defaults.codex || "" : key === "opencode" ? defaults.opencode || "" : defaults.claude || "";
  }
  function getChatModelForProvider(provider) {
    var key = getProviderKey(provider);
    var selected = state.chatModels && typeof state.chatModels[key] === "string" ? state.chatModels[key] : "";
    if (!selected && key === "claude") selected = state.chatModel || "";
    return selected || "";
  }
  function setChatModelForProvider(provider, model) {
    var key = getProviderKey(provider);
    var normalized = (model || "").trim();
    if (!state.chatModels) state.chatModels = { claude: "", codex: "", opencode: "" };
    state.chatModels[key] = normalized;
    state.chatModel = normalized;
    try {
      localStorage.setItem("wand-chat-model-" + key, normalized);
      localStorage.removeItem("wand-chat-model");
    } catch (e) {
    }
  }
  function getEffectiveModel(session) {
    var pending = session && session.id ? getPendingSessionConfig(session.id) : null;
    if (pending && Object.prototype.hasOwnProperty.call(pending, "model")) return pending.model || "";
    if (session && session.selectedModel) return session.selectedModel;
    var provider = getProviderForSession(session);
    var selected = getChatModelForProvider(provider);
    return selected || getConfigDefaultModelForProvider(provider) || "";
  }
  function getModelsForCurrentProvider(session) {
    var provider = session && session.provider || state.sessionTool || "claude";
    if (provider === "codex") return state.availableCodexModels || [];
    if (provider === "opencode") return state.availableOpenCodeModels || [];
    return state.availableModels || [];
  }
  function renderChatModelOptions(selected, session) {
    var models = getModelsForCurrentProvider(session);
    var normalized = selected === "default" ? "" : selected || "";
    var html = '<option value=""' + (!normalized ? " selected" : "") + ">\u9ED8\u8BA4 \xB7 " + escapeHtml2(getModelDisplayLabel("", session)) + "</option>";
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (m.id === "default") continue;
      var label = m.label || m.id;
      var suffix = getProviderForSession(session) === "claude" ? m.availability === "verified" ? " \xB7 \u5DF2\u9A8C\u8BC1" : m.availability === "stale" ? " \xB7 \u5F85\u5237\u65B0" : m.source === "models-api" ? " \xB7 API \u5019\u9009" : " \xB7 \u5019\u9009" : "";
      html += '<option value="' + escapeHtml2(m.id) + '"' + (m.id === normalized ? " selected" : "") + ">" + escapeHtml2(label + suffix) + "</option>";
    }
    if (normalized && !models.some(function(m2) {
      return m2.id === normalized;
    })) {
      html += '<option value="' + escapeHtml2(normalized) + '" selected>' + escapeHtml2(normalized) + "\uFF08\u81EA\u5B9A\u4E49\uFF09</option>";
    }
    return html;
  }
  function renderChatModelOptionsRaw(selected, session) {
    var models = getModelsForCurrentProvider(session);
    var normalized = selected === "default" ? "" : selected || "";
    var html = '<option value=""' + (!normalized ? " selected" : "") + ">" + escapeHtml2(getModelDisplayLabel("", session)) + "</option>";
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (m.id === "default") continue;
      var rawSuffix = getProviderForSession(session) === "claude" ? m.availability === "verified" ? " \xB7 verified" : m.availability === "stale" ? " \xB7 stale" : m.source === "models-api" ? " \xB7 API candidate" : " \xB7 candidate" : "";
      html += '<option value="' + escapeHtml2(m.id) + '"' + (m.id === normalized ? " selected" : "") + ">" + escapeHtml2(m.id + rawSuffix) + "</option>";
    }
    if (normalized && !models.some(function(m2) {
      return m2.id === normalized;
    })) {
      html += '<option value="' + escapeHtml2(normalized) + '" selected>' + escapeHtml2(normalized) + "</option>";
    }
    return html;
  }
  function syncComposerModelSelect(session) {
    refreshAllChatModeTrios2();
  }
  var THINKING_LEVELS = [
    { id: "off", label: "auto", hint: "\u4F7F\u7528 provider / \u6A21\u578B\u9ED8\u8BA4\u601D\u8003\u6863\u4F4D" },
    { id: "standard", label: "low", hint: "Claude/Codex: low \xB7 OpenCode variant: low" },
    { id: "deep", label: "medium", hint: "Claude/Codex: medium \xB7 OpenCode variant: high" },
    { id: "max", label: "max", hint: "Claude: max \xB7 Codex: xhigh \xB7 OpenCode variant: max" }
  ];
  function codexThinkingId(effort) {
    if (effort === "low") return "standard";
    if (effort === "medium") return "deep";
    if (effort === "xhigh") return "max";
    return "codex:" + effort;
  }
  function getThinkingLevels(session) {
    if (getProviderForSession(session) !== "codex") return THINKING_LEVELS;
    var model = getEffectiveModel(session) || "default";
    var models = state.availableCodexModels || [];
    var info = models.find(function(item) {
      return item.id === model;
    }) || models.find(function(item) {
      return item.id === "default";
    });
    var efforts = info && Array.isArray(info.reasoningEfforts) ? info.reasoningEfforts : [];
    if (!efforts.length) return THINKING_LEVELS;
    var defaultEffort = info.defaultReasoningEffort || "";
    return [{
      id: "off",
      label: "auto",
      hint: defaultEffort ? "\u4F7F\u7528\u6A21\u578B\u9ED8\u8BA4\u6863\u4F4D\uFF08" + defaultEffort + "\uFF09" : "\u4F7F\u7528\u6A21\u578B\u9ED8\u8BA4\u6863\u4F4D"
    }].concat(efforts.map(function(level) {
      var effort = String(level.effort || "").toLowerCase();
      return {
        id: codexThinkingId(effort),
        label: effort,
        hint: level.description || effort
      };
    }).filter(function(level) {
      return level.label;
    }));
  }
  function getThinkingLabel(id, session) {
    var levels = getThinkingLevels(session);
    for (var i = 0; i < levels.length; i++) {
      if (levels[i].id === id) return levels[i].label;
    }
    if (typeof id === "string" && id.indexOf("codex:") === 0) return id.slice(6);
    for (var j = 0; j < THINKING_LEVELS.length; j++) {
      if (THINKING_LEVELS[j].id === id) return THINKING_LEVELS[j].label;
    }
    return "auto";
  }
  function getEffectiveThinking(session) {
    var pending = session && session.id ? getPendingSessionConfig(session.id) : null;
    if (pending && Object.prototype.hasOwnProperty.call(pending, "thinking")) return pending.thinking || "off";
    if (session && session.thinkingEffort) return session.thinkingEffort;
    if (state.chatThinking) return state.chatThinking;
    return "off";
  }
  function syncComposerThinkingSelect(session) {
    refreshAllChatModeTrios2();
  }
  function persistThinkingPreference(value) {
    state.chatThinking = value;
    try {
      localStorage.setItem("wand-thinking-effort", value);
    } catch (e) {
    }
  }
  function submitThinkingMutation(session, normalized, successMessage, prerequisite) {
    return enqueueSessionConfigMutation(session.id, function() {
      if (prerequisite && !prerequisite.ok) {
        return { error: prerequisite.error || "\u5207\u6362\u6A21\u578B\u5931\u8D25" };
      }
      return fetch("/api/sessions/" + encodeURIComponent(session.id) + "/thinking-effort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ thinkingEffort: normalized })
      }).then(function(res) {
        return res.json();
      });
    }).then(function(outcome) {
      if (applyLatestSessionConfigSnapshot(session.id, outcome) && typeof showToast2 === "function") {
        showToast2(successMessage || "\u5DF2\u5207\u6362\u601D\u8003\u6DF1\u5EA6 \u2192 " + getThinkingCompactLabel(normalized, getSelectedSession6()), "success");
      }
    }).catch(function(failure) {
      if (failure && failure.latest) recoverLatestSessionConfigMutation(session.id, "\u5207\u6362\u601D\u8003\u6DF1\u5EA6\u5931\u8D25");
    });
  }
  function onChatThinkingChange(value) {
    var normalized = (value || "off").trim();
    var session = getSelectedSession6();
    var supported = getThinkingLevels(session).some(function(level) {
      return level.id === normalized;
    });
    if (!supported) {
      normalized = "off";
    }
    persistThinkingPreference(normalized);
    if (session) setPendingSessionConfig(session.id, "thinking", normalized);
    refreshAllChatModeTrios2();
    if (!session) return;
    submitThinkingMutation(session, normalized, "\u5DF2\u5207\u6362\u601D\u8003\u6DF1\u5EA6 \u2192 " + getThinkingCompactLabel(normalized, session));
  }
  function isAutoApproveImpliedByMode(session) {
    if (!session) return false;
    var m = session.mode;
    return m === "managed" || m === "full-access";
  }
  function renderAutoApproveChip(session) {
    if (!session) return "";
    if (isAutoApproveImpliedByMode(session)) return "";
    var enabled = !!session.autoApprovePermissions;
    return enabled ? '<button id="auto-approve-toggle" class="composer-pill composer-pill-chip auto-approve-indicator active" type="button" aria-pressed="true" aria-label="\u81EA\u52A8\u6279\u51C6\u5DF2\u542F\u7528\uFF0C\u70B9\u51FB\u5173\u95ED" title="\u81EA\u52A8\u6279\u51C6\u5DF2\u542F\u7528 \u2014 \u70B9\u51FB\u5173\u95ED">' + iconSvg("shieldCheck", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">\u81EA\u52A8</span></button>' : '<button id="auto-approve-toggle" class="composer-pill composer-pill-chip auto-approve-indicator" type="button" aria-pressed="false" aria-label="\u81EA\u52A8\u6279\u51C6\u5DF2\u5173\u95ED\uFF0C\u70B9\u51FB\u5F00\u542F" title="\u81EA\u52A8\u6279\u51C6\u5DF2\u5173\u95ED \u2014 \u70B9\u51FB\u5F00\u542F">' + iconSvg("shield", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">\u624B\u52A8</span></button>';
  }
  function fetchAvailableModels() {
    return fetch("/api/models", { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && Array.isArray(data.models)) {
        state.availableModels = data.models;
        state.availableCodexModels = Array.isArray(data.codexModels) ? data.codexModels : [];
        state.availableOpenCodeModels = Array.isArray(data.opencodeModels) ? data.opencodeModels : [];
        syncComposerModelSelect(getSelectedSession6());
        updateSettingsDefaultModelSelect(data);
        syncCommitModelProvider(false);
      }
      return data;
    }).catch(function() {
      return null;
    });
  }
  function refreshAvailableModels() {
    if (state.modelsRefreshing) return Promise.resolve(null);
    state.modelsRefreshing = true;
    var buttons = document.querySelectorAll("#cfg-default-model-refresh, #cfg-commit-model-refresh");
    buttons.forEach(function(element) {
      var btn = element;
      var btnLabel = btn.querySelector("span");
      btn.disabled = true;
      btn.classList.add("is-loading");
      btn.setAttribute("aria-busy", "true");
      if (btnLabel) btnLabel.textContent = "\u68C0\u6D4B\u4E2D";
    });
    return fetch("/api/models/refresh", { method: "POST", credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && Array.isArray(data.models)) {
        state.availableModels = data.models;
        state.availableCodexModels = Array.isArray(data.codexModels) ? data.codexModels : [];
        state.availableOpenCodeModels = Array.isArray(data.opencodeModels) ? data.opencodeModels : [];
        syncComposerModelSelect(getSelectedSession6());
        updateSettingsDefaultModelSelect(data);
        syncCommitModelProvider(false);
        if (typeof showToast2 === "function") {
          var verifiedCount = data.models.filter(function(model) {
            return model.availability === "verified";
          }).length;
          var message = "\u6A21\u578B\u5217\u8868\u5DF2\u5237\u65B0" + (data.claudeVersion ? "\uFF08claude " + data.claudeVersion + "\uFF09" : "");
          if (verifiedCount) message += "\uFF1B\u5DF2\u9A8C\u8BC1 " + verifiedCount + " \u4E2A";
          showToast2(message, "success");
        }
      }
      return data;
    }).catch(function() {
      if (typeof showToast2 === "function") showToast2("\u5237\u65B0\u6A21\u578B\u5217\u8868\u5931\u8D25", "error");
      return null;
    }).finally(function() {
      state.modelsRefreshing = false;
      buttons.forEach(function(element) {
        var btn = element;
        var btnLabel = btn.querySelector("span");
        btn.disabled = false;
        btn.classList.remove("is-loading");
        btn.removeAttribute("aria-busy");
        if (btnLabel) btnLabel.textContent = "\u5237\u65B0\u5217\u8868";
      });
    });
  }
  function openEnvPreviewModal() {
    var modal = document.getElementById("env-preview-modal");
    if (!modal) {
      modal = document.createElement("section");
      modal.id = "env-preview-modal";
      modal.className = "modal-backdrop hidden";
      modal.innerHTML = '<div class="modal env-preview-modal" role="dialog" aria-labelledby="env-preview-title" aria-modal="true"><div class="modal-header"><div><h2 class="modal-title" id="env-preview-title">\u5C06\u6CE8\u5165\u5B50\u8FDB\u7A0B\u7684\u73AF\u5883\u53D8\u91CF</h2><p class="modal-subtitle" id="env-preview-subtitle">\u8FD9\u4E9B\u53D8\u91CF\u4F1A\u88AB\u4F20\u7ED9 claude / codex / opencode\uFF08PTY \u4E0E\u7ED3\u6784\u5316\u8FD0\u884C\u5668\u4E00\u81F4\uFF09\u3002</p></div><button id="env-preview-close" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="\u5173\u95ED"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div><div class="modal-body env-preview-body"><div class="env-preview-toolbar"><div class="env-preview-meta" id="env-preview-meta">\u52A0\u8F7D\u4E2D\u2026</div><div class="env-preview-controls"><input id="env-preview-search" class="env-preview-search" type="search" placeholder="\u641C\u7D22\u53D8\u91CF\u540D\u2026" /><label class="env-preview-reveal"><input id="env-preview-reveal-toggle" type="checkbox" /><span>\u663E\u793A\u654F\u611F\u503C</span></label></div></div><div class="env-preview-list" id="env-preview-list" tabindex="0"><div class="env-preview-loading">\u52A0\u8F7D\u4E2D\u2026</div></div></div><div class="modal-footer env-preview-footer"><span class="env-preview-hint">\u654F\u611F\u5B57\u6BB5\uFF08\u542B KEY/TOKEN/SECRET \u7B49\uFF09\u9ED8\u8BA4\u63A9\u7801\uFF0C\u53EF\u52FE\u9009\u300C\u663E\u793A\u654F\u611F\u503C\u300D\u4E34\u65F6\u8FD8\u539F\u3002</span><button id="env-preview-close-2" class="btn btn-secondary btn-sm" type="button">\u5173\u95ED</button></div></div>';
      document.body.appendChild(modal);
      modal.addEventListener("click", function(e) {
        if (e.target === modal) closeEnvPreviewModal();
      });
      var closeBtn = modal.querySelector("#env-preview-close");
      if (closeBtn) closeBtn.addEventListener("click", closeEnvPreviewModal);
      var closeBtn2 = modal.querySelector("#env-preview-close-2");
      if (closeBtn2) closeBtn2.addEventListener("click", closeEnvPreviewModal);
      var searchEl = modal.querySelector("#env-preview-search");
      if (searchEl) searchEl.addEventListener("input", function() {
        renderEnvPreviewList();
      });
      var revealEl = modal.querySelector("#env-preview-reveal-toggle");
      if (revealEl) revealEl.addEventListener("change", function() {
        loadEnvPreview(revealEl.checked);
      });
    }
    modal.classList.remove("closing");
    modal.classList.remove("hidden");
    var revealEl = modal.querySelector("#env-preview-reveal-toggle");
    if (revealEl) revealEl.checked = false;
    var searchEl = modal.querySelector("#env-preview-search");
    if (searchEl) searchEl.value = "";
    loadEnvPreview(false);
  }
  function closeEnvPreviewModal() {
    var modal = document.getElementById("env-preview-modal");
    if (!modal) return;
    animateModalClose(modal);
  }
  function loadEnvPreview(reveal) {
    var listEl = document.getElementById("env-preview-list");
    var metaEl = document.getElementById("env-preview-meta");
    if (listEl) listEl.innerHTML = '<div class="env-preview-loading">\u52A0\u8F7D\u4E2D\u2026</div>';
    if (metaEl) metaEl.textContent = "\u52A0\u8F7D\u4E2D\u2026";
    var url = "/api/settings/env-preview" + (reveal ? "?reveal=1" : "");
    fetch(url, { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (!data || !Array.isArray(data.entries)) {
        if (listEl) listEl.innerHTML = '<div class="env-preview-empty">\u8BFB\u53D6\u5931\u8D25\u3002</div>';
        if (metaEl) metaEl.textContent = "\u8BFB\u53D6\u5931\u8D25";
        return;
      }
      state._envPreview = data;
      if (metaEl) {
        var inheritLabel = data.inheritEnv ? "\u7EE7\u627F\u7236\u8FDB\u7A0B" : "\u6700\u5C0F\u767D\u540D\u5355";
        metaEl.innerHTML = '<span class="env-preview-pill ' + (data.inheritEnv ? "is-inherit" : "is-minimal") + '">' + inheritLabel + '</span><span class="env-preview-count">\u5171 ' + data.total + " \u9879</span>";
      }
      renderEnvPreviewList();
    }).catch(function() {
      if (listEl) listEl.innerHTML = '<div class="env-preview-empty">\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002</div>';
      if (metaEl) metaEl.textContent = "\u8BFB\u53D6\u5931\u8D25";
    });
  }
  function renderEnvPreviewList() {
    var listEl = document.getElementById("env-preview-list");
    if (!listEl) return;
    var data = state._envPreview;
    if (!data || !Array.isArray(data.entries)) {
      listEl.innerHTML = '<div class="env-preview-empty">\u5C1A\u672A\u52A0\u8F7D\u3002</div>';
      return;
    }
    var searchEl = document.getElementById("env-preview-search");
    var query = (searchEl && searchEl.value || "").trim().toLowerCase();
    var html = "";
    var shown = 0;
    for (var i = 0; i < data.entries.length; i++) {
      var entry = data.entries[i];
      if (query && entry.name.toLowerCase().indexOf(query) === -1) continue;
      shown++;
      var isPlaceholder = typeof entry.value === "string" && entry.value.charAt(0) === "<" && entry.value.charAt(entry.value.length - 1) === ">";
      html += '<div class="env-preview-row' + (entry.sensitive ? " is-sensitive" : "") + '"><div class="env-preview-name">' + escapeHtml2(entry.name) + (entry.sensitive ? '<span class="env-preview-badge" title="\u88AB\u8BC6\u522B\u4E3A\u654F\u611F\u5B57\u6BB5">\u654F\u611F</span>' : "") + (isPlaceholder ? '<span class="env-preview-badge env-preview-badge-runtime" title="\u6309\u4F1A\u8BDD\u52A8\u6001\u6CE8\u5165">\u8FD0\u884C\u65F6</span>' : "") + '</div><div class="env-preview-value' + (isPlaceholder ? " is-runtime" : "") + '" title="' + escapeHtml2(String(entry.value)) + '">' + escapeHtml2(String(entry.value)) + '</div><div class="env-preview-len">' + entry.length + " \u5B57\u7B26</div></div>";
    }
    if (shown === 0) {
      html = '<div class="env-preview-empty">\u6CA1\u6709\u5339\u914D\u7684\u53D8\u91CF\u3002</div>';
    }
    listEl.innerHTML = html;
  }
  function getSettingsModelsForProvider(provider) {
    return provider === "codex" ? state.availableCodexModels || [] : provider === "opencode" ? state.availableOpenCodeModels || [] : state.availableModels || [];
  }
  function updateSettingsModelStatus(root) {
    if (!root) return;
    var provider = getProviderKey(root.getAttribute("data-provider"));
    var input = root.querySelector(".model-combobox-input");
    var field = root.closest(".settings-model-field");
    var status = field ? field.querySelector("[data-model-status]") : null;
    if (!input || !status) return;
    var value = (input.value || "").trim();
    var models = getSettingsModelsForProvider(provider);
    var known = null;
    for (var i = 0; i < models.length; i++) {
      if (models[i].id === value) {
        known = models[i];
        break;
      }
    }
    status.classList.remove("is-custom", "is-known");
    if (!value) {
      status.textContent = "\u8DDF\u968F CLI \u9ED8\u8BA4";
      return;
    }
    if (known) {
      if (known.availability === "verified") {
        status.textContent = "\u5DF2\u7531 Claude Code \u9A8C\u8BC1";
      } else if (known.availability === "stale") {
        status.textContent = "\u9A8C\u8BC1\u8BB0\u5F55\u5F85\u5237\u65B0";
      } else if (known.source === "models-api") {
        status.textContent = "API \u5019\u9009\uFF0C\u5C1A\u672A\u9A8C\u8BC1";
      } else {
        status.textContent = "\u5DF2\u68C0\u6D4B\u5230\uFF0C\u5C1A\u672A\u9A8C\u8BC1";
      }
      status.classList.add("is-known");
      return;
    }
    status.textContent = "\u81EA\u5B9A\u4E49\u540D\u79F0";
    status.classList.add("is-custom");
  }
  function renderSettingsModelCombobox(root) {
    if (!root) return;
    var provider = getProviderKey(root.getAttribute("data-provider"));
    var input = root.querySelector(".model-combobox-input");
    var menu = root.querySelector(".model-combobox-menu");
    if (!input || !menu) return;
    var rawValue = input.value || "";
    var value = rawValue.trim();
    var query = root.classList.contains("is-filtering") ? value.toLowerCase() : "";
    var models = getSettingsModelsForProvider(provider);
    var defaultModel = null;
    var exactMatch = false;
    var rows = [];
    for (var i = 0; i < models.length; i++) {
      var model = models[i];
      if (model.id === "default") {
        defaultModel = model;
        continue;
      }
      if (model.id === value) exactMatch = true;
      var label = model.label || model.id;
      if (query && model.id.toLowerCase().indexOf(query) === -1 && label.toLowerCase().indexOf(query) === -1) continue;
      var meta = provider !== "claude" ? label === model.id ? "\u5DF2\u68C0\u6D4B\u6A21\u578B" : model.id : model.availability === "verified" ? "\u5DF2\u7531 Claude Code \u9A8C\u8BC1" : model.availability === "stale" ? "\u9A8C\u8BC1\u8BB0\u5F55\u5F85\u5237\u65B0" : model.source === "models-api" ? "API \u5019\u9009\uFF0C\u5C1A\u672A\u9A8C\u8BC1" : model.note || "\u5C1A\u672A\u9A8C\u8BC1";
      rows.push({ value: model.id, label, meta, custom: false });
    }
    var defaultLabel = provider === "codex" ? "\u8DDF\u968F Codex \u9ED8\u8BA4" : provider === "opencode" ? "\u8DDF\u968F OpenCode \u9ED8\u8BA4" : "\u8DDF\u968F Claude Code \u9ED8\u8BA4";
    var defaultMeta = defaultModel && defaultModel.label ? defaultModel.label : "\u4E0D\u4F20 --model \u53C2\u6570";
    var html = "";
    if (!query || defaultLabel.toLowerCase().indexOf(query) !== -1 || defaultMeta.toLowerCase().indexOf(query) !== -1) {
      html += '<button type="button" class="model-combobox-option' + (!value ? " is-selected" : "") + '" role="option" aria-selected="' + (!value ? "true" : "false") + '" data-model-value=""><span class="model-combobox-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span><span class="model-combobox-option-copy"><span class="model-combobox-option-label">' + escapeHtml2(defaultLabel) + '</span><span class="model-combobox-option-meta">' + escapeHtml2(defaultMeta) + "</span></span></button>";
    }
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var isSelected = row.value === value;
      html += '<button type="button" class="model-combobox-option' + (isSelected ? " is-selected" : "") + '" role="option" aria-selected="' + (isSelected ? "true" : "false") + '" data-model-value="' + escapeHtml2(row.value) + '"><span class="model-combobox-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span><span class="model-combobox-option-copy"><span class="model-combobox-option-label">' + escapeHtml2(row.label) + '</span><span class="model-combobox-option-meta">' + escapeHtml2(row.meta) + "</span></span></button>";
    }
    if (value && !exactMatch) {
      html += '<button type="button" class="model-combobox-option model-combobox-option-custom is-selected" role="option" aria-selected="true" data-model-value="' + escapeHtml2(value) + '"><span class="model-combobox-option-custom-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></span><span class="model-combobox-option-copy"><span class="model-combobox-option-label">\u4F7F\u7528\u81EA\u5B9A\u4E49\u540D\u79F0</span><span class="model-combobox-option-meta">' + escapeHtml2(value) + "</span></span></button>";
    }
    if (!html) {
      html = '<div class="model-combobox-empty">\u6CA1\u6709\u5339\u914D\u7684\u6A21\u578B\uFF0C\u53EF\u4EE5\u7EE7\u7EED\u8F93\u5165\u81EA\u5B9A\u4E49\u540D\u79F0\u3002</div>';
    }
    menu.innerHTML = html;
    var options = menu.querySelectorAll(".model-combobox-option");
    var activeIndex = -1;
    for (var o = 0; o < options.length; o++) {
      if (options[o].getAttribute("aria-selected") === "true") {
        activeIndex = o;
        break;
      }
    }
    root._wandModelActiveIndex = activeIndex >= 0 ? activeIndex : options.length ? 0 : -1;
    updateSettingsModelActiveOption(root);
    updateSettingsModelStatus(root);
  }
  function updateSettingsModelActiveOption(root) {
    if (!root) return;
    var menu = root.querySelector(".model-combobox-menu");
    var input = root.querySelector(".model-combobox-input");
    if (!menu || !input) return;
    var options = menu.querySelectorAll(".model-combobox-option");
    var activeIndex = typeof root._wandModelActiveIndex === "number" ? root._wandModelActiveIndex : -1;
    for (var i = 0; i < options.length; i++) {
      options[i].classList.toggle("is-active", i === activeIndex);
      if (i === activeIndex) {
        if (!options[i].id) options[i].id = (menu.id || "model-listbox") + "-option-" + i;
        input.setAttribute("aria-activedescendant", options[i].id);
      }
    }
    if (activeIndex < 0) input.removeAttribute("aria-activedescendant");
  }
  function openSettingsModelCombobox(root) {
    if (!root) return;
    var input = root.querySelector(".model-combobox-input");
    var menu = root.querySelector(".model-combobox-menu");
    if (!input || !menu) return;
    document.querySelectorAll(".model-combobox.is-open").forEach(function(other) {
      if (other !== root) closeSettingsModelCombobox(other);
    });
    renderSettingsModelCombobox(root);
    root.classList.add("is-open");
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  }
  function closeSettingsModelCombobox(root) {
    if (!root) return;
    var input = root.querySelector(".model-combobox-input");
    var menu = root.querySelector(".model-combobox-menu");
    root.classList.remove("is-open");
    root.classList.remove("is-filtering");
    if (menu) menu.classList.add("hidden");
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
  }
  function selectSettingsModelOption(root, value) {
    if (!root) return;
    var input = root.querySelector(".model-combobox-input");
    if (!input) return;
    var shouldRestoreInputFocus = document.activeElement === input;
    input.value = value || "";
    input.dataset.modelInitialized = "true";
    input.dataset.modelDirty = "true";
    root.classList.remove("is-filtering");
    updateSettingsModelStatus(root);
    closeSettingsModelCombobox(root);
    if (shouldRestoreInputFocus) input.focus();
  }
  function bindSettingsModelComboboxes() {
    if (!window.__wandSettingsModelOutsideBound) {
      window.__wandSettingsModelOutsideBound = true;
      document.addEventListener("click", function(event) {
        var target = event.target;
        document.querySelectorAll(".model-combobox.is-open").forEach(function(root) {
          if (!target || !root.contains(target)) closeSettingsModelCombobox(root);
        });
      });
    }
    var roots = document.querySelectorAll(".model-combobox");
    roots.forEach(function(root) {
      if (root.dataset.bound === "true") return;
      root.dataset.bound = "true";
      var input = root.querySelector(".model-combobox-input");
      var toggle = root.querySelector(".model-combobox-toggle");
      var menu = root.querySelector(".model-combobox-menu");
      if (!input || !toggle || !menu) return;
      input.addEventListener("focus", function() {
        openSettingsModelCombobox(root);
      });
      input.addEventListener("input", function() {
        input.dataset.modelInitialized = "true";
        input.dataset.modelDirty = "true";
        root.classList.add("is-filtering");
        openSettingsModelCombobox(root);
      });
      input.addEventListener("keydown", function(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeSettingsModelCombobox(root);
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
        if (!root.classList.contains("is-open")) {
          if (event.key === "Enter") return;
          openSettingsModelCombobox(root);
        }
        var options = menu.querySelectorAll(".model-combobox-option");
        if (!options.length) return;
        event.preventDefault();
        var index = typeof root._wandModelActiveIndex === "number" ? root._wandModelActiveIndex : -1;
        if (event.key === "ArrowDown") index = index < options.length - 1 ? index + 1 : 0;
        if (event.key === "ArrowUp") index = index > 0 ? index - 1 : options.length - 1;
        root._wandModelActiveIndex = index;
        updateSettingsModelActiveOption(root);
        if (event.key === "Enter") {
          var active = options[index];
          if (active) selectSettingsModelOption(root, active.getAttribute("data-model-value") || "");
        } else {
          var activeOption = options[index];
          if (activeOption && typeof activeOption.scrollIntoView === "function") activeOption.scrollIntoView({ block: "nearest" });
        }
      });
      toggle.addEventListener("mousedown", function(event) {
        event.preventDefault();
      });
      toggle.addEventListener("click", function() {
        if (root.classList.contains("is-open")) {
          closeSettingsModelCombobox(root);
        } else {
          openSettingsModelCombobox(root);
        }
      });
      menu.addEventListener("mousedown", function(event) {
        event.preventDefault();
      });
      menu.addEventListener("click", function(event) {
        var option = event.target.closest(".model-combobox-option");
        if (!option) return;
        selectSettingsModelOption(root, option.getAttribute("data-model-value") || "");
      });
      root.addEventListener("focusout", function() {
        setTimeout(function() {
          if (!root.contains(document.activeElement)) closeSettingsModelCombobox(root);
        }, 0);
      });
      renderSettingsModelCombobox(root);
    });
  }
  function syncCommitModelProvider(resetModel) {
    var cli = document.getElementById("cfg-commit-cli");
    var root = document.getElementById("cfg-commit-model-combobox");
    var input = document.getElementById("cfg-commit-model");
    var label = document.getElementById("cfg-commit-model-provider");
    if (!cli || !root || !input) return;
    var provider = getProviderKey(cli.value);
    root.setAttribute("data-provider", provider);
    input.placeholder = provider === "codex" ? "\u8DDF\u968F Codex \u9ED8\u8BA4" : provider === "opencode" ? "\u8DDF\u968F OpenCode \u9ED8\u8BA4" : "\u8DDF\u968F Claude Code \u9ED8\u8BA4";
    if (label) label.textContent = provider === "codex" ? "Codex CLI" : provider === "opencode" ? "OpenCode CLI" : "Claude Code";
    if (resetModel) {
      input.value = "";
      input.dataset.modelDirty = "true";
    }
    renderSettingsModelCombobox(root);
  }
  function updateSettingsDefaultModelSelect(data) {
    var defaults = getConfigDefaultModels();
    var claudeInput = document.getElementById("cfg-default-model");
    if (claudeInput) {
      if (claudeInput.dataset.modelInitialized !== "true") {
        claudeInput.value = state.configDefaultModels && state.configDefaultModels.claude || defaults.claude || "";
        claudeInput.dataset.modelInitialized = "true";
      }
      var claudeRoot = claudeInput.closest(".model-combobox");
      if (claudeRoot) renderSettingsModelCombobox(claudeRoot);
    }
    var codexInput = document.getElementById("cfg-default-codex-model");
    if (codexInput) {
      if (codexInput.dataset.modelInitialized !== "true") {
        codexInput.value = state.configDefaultModels && state.configDefaultModels.codex || defaults.codex || "";
        codexInput.dataset.modelInitialized = "true";
      }
      var codexRoot = codexInput.closest(".model-combobox");
      if (codexRoot) renderSettingsModelCombobox(codexRoot);
    }
    var openCodeInput = document.getElementById("cfg-default-opencode-model");
    if (openCodeInput) {
      if (openCodeInput.dataset.modelInitialized !== "true") {
        openCodeInput.value = state.configDefaultModels && state.configDefaultModels.opencode || defaults.opencode || "";
        openCodeInput.dataset.modelInitialized = "true";
      }
      var openCodeRoot = openCodeInput.closest(".model-combobox");
      if (openCodeRoot) renderSettingsModelCombobox(openCodeRoot);
    }
    var versionEl = document.getElementById("cfg-default-model-version");
    if (versionEl && data) {
      versionEl.textContent = data.claudeVersion ? "\u5DF2\u68C0\u6D4B\u5230 Claude CLI " + data.claudeVersion + "\uFF1B\u5217\u8868\u5DF2\u540C\u6B65 Codex \u4E0E OpenCode \u53EF\u7528\u6A21\u578B\u3002" : "\u672A\u8BFB\u53D6\u5230 Claude CLI \u7248\u672C\uFF1B\u4ECD\u53EF\u76F4\u63A5\u8F93\u5165\u81EA\u5B9A\u4E49\u6A21\u578B\u540D\u79F0\u3002";
    }
  }
  function getSelectedSession6() {
    if (!state.selectedId) return null;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === state.selectedId) return state.sessions[i];
    }
    return null;
  }
  function onChatModelChange(value) {
    var normalized = (value || "").trim();
    var session = getSelectedSession6();
    var provider = getProviderForSession(session);
    setChatModelForProvider(provider, normalized);
    if (session) setPendingSessionConfig(session.id, "model", normalized);
    var thinkingFallback = false;
    if (!getThinkingLevels(session).some(function(level) {
      return level.id === getEffectiveThinking(session);
    })) {
      thinkingFallback = true;
      persistThinkingPreference("off");
      if (session) setPendingSessionConfig(session.id, "thinking", "off");
    }
    refreshAllChatModeTrios2();
    if (!session) return;
    var prerequisite = { ok: false, error: "" };
    enqueueSessionConfigMutation(session.id, function() {
      return fetch("/api/sessions/" + encodeURIComponent(session.id) + "/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ model: normalized || null })
      }).then(function(res) {
        return res.json();
      }).then(function(data) {
        prerequisite.ok = !!(data && data.id && !data.error);
        prerequisite.error = data && data.error ? data.error : "";
        return data;
      });
    }).then(function(outcome) {
      if (thinkingFallback) return;
      if (applyLatestSessionConfigSnapshot(session.id, outcome) && typeof showToast2 === "function") {
        var display2 = getModelDisplayLabel(normalized, getSelectedSession6() || session);
        var hint = session.provider === "codex" ? "\uFF08\u4E0B\u6B21\u5BF9\u8BDD\u751F\u6548\uFF09" : "";
        showToast2("\u5DF2\u5207\u6362\u6A21\u578B \u2192 " + display2 + hint, "success");
      }
    }).catch(function(failure) {
      prerequisite.ok = false;
      if (!thinkingFallback && failure && failure.latest) {
        recoverLatestSessionConfigMutation(session.id, "\u5207\u6362\u6A21\u578B\u5931\u8D25");
      }
    });
    if (thinkingFallback) {
      var display = getModelDisplayLabel(normalized, session);
      submitThinkingMutation(session, "off", "\u5DF2\u5207\u6362\u6A21\u578B \u2192 " + display + "\uFF1B\u601D\u8003\u6DF1\u5EA6\u5DF2\u56DE\u843D\u4E3A\u81EA\u52A8", prerequisite);
    }
  }
  function onChatModeChange(value) {
    var normalized = getSafeModeForTool(getPreferredTool(), (value || "default").trim());
    state.chatMode = normalized;
    refreshAllChatModeTrios2();
    var session = getSelectedSession6();
    if (!session || !session.id) {
      showToast2 && showToast2("\u65B0\u4F1A\u8BDD\u6A21\u5F0F\uFF1A" + normalized, "info");
      return;
    }
    setPendingSessionConfig(session.id, "mode", normalized);
    enqueueSessionConfigMutation(session.id, function() {
      return fetch("/api/sessions/" + encodeURIComponent(session.id) + "/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ mode: normalized })
      }).then(function(res) {
        return res.json();
      });
    }).then(function(outcome) {
      if (applyLatestSessionConfigSnapshot(session.id, outcome) && typeof showToast2 === "function") {
        var updated = state.sessions.find(function(item) {
          return item.id === session.id;
        }) || session;
        var effectiveMode = updated.mode || normalized;
        state.chatMode = getSafeModeForTool(updated.provider || getPreferredTool(), effectiveMode);
        refreshAllChatModeTrios2();
        var hint = session.provider === "codex" ? "\uFF08Codex \u56FA\u5B9A\u5168\u6743\u9650\uFF09" : "";
        showToast2("\u5DF2\u5207\u6362\u6A21\u5F0F \u2192 " + effectiveMode + hint, "success");
      }
    }).catch(function(failure) {
      if (failure && failure.latest) recoverLatestSessionConfigMutation(session.id, "\u5207\u6362\u6A21\u5F0F\u5931\u8D25");
    });
  }
  function createStructuredSession(prompt, cwdOverride, modeOverride, worktreeEnabled) {
    var provider = getProviderKey(state.sessionTool);
    var modelPref = getChatModelForProvider(provider);
    var thinkingPref = state.chatThinking || "off";
    var payload = {
      cwd: cwdOverride || getEffectiveCwd3(),
      mode: modeOverride || state.chatMode || state.config && state.config.defaultMode || "default",
      provider,
      runner: provider === "codex" ? "codex-cli-exec" : provider === "opencode" ? "opencode-cli-run" : state.config && state.config.structuredRunner === "sdk" ? "claude-sdk" : state.structuredRunner || "claude-cli-print",
      prompt: prompt || void 0,
      worktreeEnabled: worktreeEnabled === true,
      model: modelPref || void 0,
      thinkingEffort: thinkingPref,
      sessionSource: "interactive"
    };
    return fetch("/api/structured-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        throw new Error(data.error);
      }
      state.selectedId = data.id;
      persistSelectedId();
      state.drafts[data.id] = "";
      resetChatRenderCache2();
      updateSessionSnapshot(data);
      updateSessionsList();
      switchToSessionView2(data.id);
      subscribeToSession(data.id);
      return loadOutput(data.id).then(function() {
        return data;
      });
    });
  }
  function applyCurrentView() {
    var hasSession = !!state.selectedId;
    var terminalContainer = document.getElementById("output");
    var chatContainer = document.getElementById("chat-output");
    var blankChat = document.getElementById("blank-chat");
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    var structured = isStructuredSession2(selectedSession);
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
    if (blankChat) {
      blankChat.classList.toggle("hidden", hasSession);
    }
    if (chatContainer && showChat) {
      ensureChatMessagesContainer(chatContainer);
    }
    bindChatScrollListener();
    updateChatUnreadBubble();
    updateInteractiveControls3();
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
    if (modeHint) modeHint.textContent = getToolModeHint2(tool, state.modeValue);
  }
  function updateSessionSnapshot(snapshot) {
    if (!snapshot || !snapshot.id) return;
    var currentSession = state.sessions.find(function(session) {
      return session.id === snapshot.id;
    }) || null;
    var normalizedSnapshot = normalizeStructuredSnapshot(snapshot, currentSession);
    if (Array.isArray(normalizedSnapshot.messages) && typeof normalizedSnapshot.messageOffset === "number") {
      var mw = mergeWindowedMessages(currentSession, normalizedSnapshot.messages, normalizedSnapshot.messageOffset, normalizedSnapshot.messageTotal);
      normalizedSnapshot.messages = mw.messages;
      normalizedSnapshot.messageOffset = mw.messageOffset;
      normalizedSnapshot.messageTotal = mw.messageTotal;
    }
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
    var updatedSession = state.sessions.find(function(session) {
      return session.id === normalizedSnapshot.id;
    }) || normalizedSnapshot;
    if (updatedSession && Array.isArray(updatedSession.queuedMessages) && normalizedSnapshot.id === state.selectedId) {
      syncStructuredQueueFromSession(updatedSession);
      saveStructuredQueue();
      updateStructuredQueueCounter();
    }
    if (normalizedSnapshot.id === state.selectedId) {
      reconcileInteractiveState();
      updateTaskDisplay();
    }
    if (normalizedSnapshot.status && normalizedSnapshot.status !== "running" && state.crossSessionQueue.length > 0) {
      setTimeout(flushCrossSessionQueue, 0);
    }
  }
  function subscribeToSession(sessionId) {
    if (!sessionId || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
  }
  function mergeServerSession(localSession, serverSession) {
    if (!localSession) return serverSession;
    var merged = Object.assign({}, localSession, serverSession);
    var localOutput = localSession.output || "";
    var serverOutput = serverSession.output || "";
    var keepLocalOutput = localOutput.length > serverOutput.length;
    var localStructuredState = localSession.structuredState || null;
    var serverStructuredState = serverSession.structuredState || null;
    var structuredSession = localSession.sessionKind === "structured" || serverSession.sessionKind === "structured";
    var localHasPendingAssistant = !!(localSession.messages && localSession.messages.length && (function() {
      var last = localSession.messages[localSession.messages.length - 1];
      return last && last.role === "assistant" && Array.isArray(last.content) && last.content.some(function(block) {
        return block && block.__processing;
      });
    })());
    var localMessages = Array.isArray(localSession.messages) ? structuredSession ? stripRenderOnlyStructuredMessages(localSession.messages) : localSession.messages : [];
    var serverMessages = Array.isArray(serverSession.messages) ? structuredSession ? stripRenderOnlyStructuredMessages(serverSession.messages) : serverSession.messages : [];
    var serverHasCompletedAssistant = serverMessages.length > 0 && (function() {
      var last = serverMessages[serverMessages.length - 1];
      return last && last.role === "assistant" && Array.isArray(last.content) && !last.content.some(function(b) {
        return b && b.__processing;
      });
    })();
    var preserveLocalStructuredProgress = localSession.sessionKind === "structured" && !!localStructuredState && localStructuredState.inFlight === true && (!serverStructuredState || serverStructuredState.inFlight !== true) && localHasPendingAssistant && !!localStructuredState.activeRequestId && !!serverStructuredState && !!serverStructuredState.activeRequestId && serverStructuredState.activeRequestId === localStructuredState.activeRequestId && !serverHasCompletedAssistant;
    var preserveLocalMessages = localMessages.length > serverMessages.length || localMessages.length > 0 && serverMessages.length > 0 && JSON.stringify(localMessages[localMessages.length - 1]) !== JSON.stringify(serverMessages[serverMessages.length - 1]) && JSON.stringify(localMessages).length > JSON.stringify(serverMessages).length;
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
    var output = typeof fallbackOutput === "string" ? fallbackOutput : session && session.output || "";
    if (!output) {
      return [];
    }
    return parseMessages(output, session && session.command);
  }
  function getPreferredSessionId(sessions) {
    if (!sessions || !sessions.length) return null;
    if (state.selectedId) {
      var stillExists = sessions.find(function(session) {
        return session.id === state.selectedId;
      });
      if (stillExists) return stillExists.id;
      return null;
    }
    var runningSession = sessions.find(function(session) {
      return session.status === "running";
    });
    if (runningSession) return runningSession.id;
    var recent = sessions.find(function(session) {
      return !session.archived;
    });
    return recent ? recent.id : sessions[0].id;
  }
  function loadSessions(options) {
    var opts = options || {};
    return fetch("/api/sessions", { credentials: "same-origin" }).then(function(res) {
      if (res.status === 401) {
        logout2();
        return;
      }
      return res.json();
    }).then(function(sessions) {
      var serverSessions = sessions || [];
      var sessionIds = new Set(serverSessions.map(function(s) {
        return s.id;
      }));
      Object.keys(state.drafts).forEach(function(id) {
        if (!sessionIds.has(id)) delete state.drafts[id];
      });
      state.sessions = serverSessions.map(function(serverSession) {
        var localSession = state.sessions.find(function(s) {
          return s.id === serverSession.id;
        });
        return mergeServerSession(localSession, serverSession);
      });
      var preferredSessionId = getPreferredSessionId(state.sessions);
      if (preferredSessionId !== void 0) {
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
        var rendered = renderSessionsListContent();
        if (listEl && listEl.innerHTML === rendered) {
          var countEl = document.getElementById("session-count");
          if (countEl) countEl.textContent = String(state.sessions.length);
        } else {
          if (listEl) {
            listEl.innerHTML = rendered;
            refreshTailMarqueePaths(listEl);
          }
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
        var sel = state.sessions.find(function(s) {
          return s.id === state.selectedId;
        });
        if (isStructuredSession2(sel)) {
          resetChatRenderCache2({ preserveStickState: true });
          scheduleChatRender3(true);
        }
      }
      return reloadPromise.then(function() {
        if (state.crossSessionQueue.length > 0) {
          flushCrossSessionQueue();
        }
        renderCrossSessionQueue();
        _syncWakeLock();
      });
    }).catch(function(e) {
      var message = e && e.message || "";
      var isTransientAbort = message === "Failed to fetch" || message === "NetworkError when attempting to fetch resource." || message === "Load failed" || /aborted|aborterror|networkerror|failed to fetch/i.test(message);
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
    if (listEl) {
      listEl.innerHTML = renderSessionsListContent();
      refreshTailMarqueePaths(listEl);
    }
    if (countEl) countEl.textContent = String(state.sessions.length);
    if (typeof hideCollapsedTileBubble === "function") hideCollapsedTileBubble();
    updateShellChrome();
    if (state.crossSessionQueue.length > 0) renderCrossSessionQueue();
  }
  function updateShellChrome() {
    var selectedSession = state.sessions.find(function(s) {
      return s.id === state.selectedId;
    });
    if (!selectedSession) {
      setTerminalInteractive(false);
      hideMiniKeyboard();
      closeKeyboardPopup();
    }
    var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "Wand";
    var terminalInfo = selectedSession ? getSessionStatusLabel(selectedSession) : "\u5F00\u59CB\u5BF9\u8BDD";
    var summaryEl = document.querySelector(".session-summary-value");
    var titleEl = document.getElementById("terminal-title");
    var infoEl = document.getElementById("terminal-info");
    var topbarTitleEl = document.querySelector(".topbar-session-title, .topbar-tagline");
    if (topbarTitleEl && selectedSession) {
      topbarTitleEl.classList.remove("topbar-tagline");
      topbarTitleEl.classList.add("topbar-session-title");
      topbarTitleEl.textContent = selectedSession.title || shortCommand(selectedSession.command);
      topbarTitleEl.setAttribute("title", selectedSession.description || selectedSession.command || "");
    }
    var blankChat = document.getElementById("blank-chat");
    var terminalContainer = document.getElementById("output");
    var chatContainer = document.getElementById("chat-output");
    var stopBtn = document.getElementById("stop-button");
    if (summaryEl && summaryEl.textContent !== terminalTitle) summaryEl.textContent = terminalTitle;
    if (titleEl && titleEl.textContent !== terminalTitle) titleEl.textContent = terminalTitle;
    if (infoEl) infoEl.textContent = selectedSession ? terminalInfo + " \xB7 " + getSessionKindDescription(selectedSession) : terminalInfo;
    var kindEl = document.getElementById("session-kind-display");
    var kindText = selectedSession ? getSessionKindLabel(selectedSession) : "\u7EC8\u7AEF";
    if (kindEl && kindEl.textContent !== kindText) kindEl.textContent = kindText;
    updateAutoApproveIndicator();
    if (!state.terminal && terminalContainer && selectedSession) {
      initTerminal2();
    }
    if (state.terminal && terminalContainer && !terminalContainer.contains(state.terminal.element)) {
      teardownTerminal();
      initTerminal2();
    }
    if (!selectedSession) {
      state.terminalSessionId = null;
      state.terminalOutput = "";
      state.terminalOutputMarker = 0;
    }
    if (state.terminal && selectedSession && state.currentView === "terminal") {
      maybeScrollTerminalToBottom("view");
    }
    var inputPanel = document.querySelector(".input-panel");
    if (selectedSession) {
      if (blankChat) blankChat.classList.add("hidden");
      if (terminalContainer) terminalContainer.classList.remove("hidden");
      if (chatContainer) chatContainer.classList.remove("hidden");
      if (inputPanel) inputPanel.classList.remove("hidden");
    } else {
      if (blankChat) blankChat.classList.remove("hidden");
      if (terminalContainer) terminalContainer.classList.add("hidden");
      if (chatContainer) chatContainer.classList.add("hidden");
      if (stopBtn) stopBtn.classList.add("hidden");
      if (inputPanel) inputPanel.classList.add("hidden");
    }
    syncComposerModeSelect();
    syncComposerModelSelect(getSelectedSession6());
    applyCurrentView();
    reconcileInteractiveState();
  }
  function loadOutput(id) {
    if (state.chatRenderTimer) {
      clearTimeout(state.chatRenderTimer);
      state.chatRenderTimer = null;
    }
    var sess = state.sessions.find(function(s) {
      return s.id === id;
    });
    var url = "/api/sessions/" + id;
    if (shouldRequestChatFormat3(sess)) {
      url += "?format=chat";
    }
    return fetch(url, { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        if (state.selectedId === id) {
          state.selectedId = null;
          persistSelectedId();
        }
        loadSessions();
        return;
      }
      updateSessionSnapshot(data);
      updateShellChrome();
      if (state.terminal && id === state.selectedId && data.output !== void 0) {
        var wsLikelyTakingOver = !!state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING);
        if (!wsLikelyTakingOver) {
          syncTerminalBuffer(id, data.output, { mode: "append" });
          ensureTerminalFit2("session-switch", { forceReplay: true });
        } else {
          ensureTerminalFit2("session-switch");
        }
      }
      var selectedSession = state.sessions.find(function(s) {
        return s.id === id;
      });
      state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, data.output, false));
      renderChat(false);
    });
  }
  var _fetchingEarlierMessages = false;
  function fetchEarlierMessages() {
    if (_fetchingEarlierMessages) return false;
    var id = state.selectedId;
    if (!id) return false;
    var sess = state.sessions.find(function(s) {
      return s.id === id;
    });
    if (!sess) return false;
    var offset = typeof sess.messageOffset === "number" ? sess.messageOffset : 0;
    if (offset <= 0) return false;
    var pageSize = 40;
    var newOffset = Math.max(0, offset - pageSize);
    var limit = offset - newOffset;
    _fetchingEarlierMessages = true;
    fetch(
      "/api/sessions/" + encodeURIComponent(id) + "/messages?offset=" + newOffset + "&limit=" + limit,
      { credentials: "same-origin" }
    ).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && Array.isArray(data.messages) && sess.messageOffset === offset) {
        var existing = Array.isArray(sess.messages) ? sess.messages : [];
        sess.messages = data.messages.concat(existing);
        sess.messageOffset = newOffset;
        if (typeof data.total === "number") sess.messageTotal = data.total;
        if (id === state.selectedId) {
          state.currentMessages = buildMessagesForRender(sess, getPreferredMessages(sess, sess.output, false));
          state.chatRenderedCount = state.currentMessages.length;
          renderChat(true);
        }
      }
    }).catch(function() {
    }).finally(function() {
      _fetchingEarlierMessages = false;
    });
    return true;
  }
  function selectSession(id) {
    var foundSession = state.sessions.find(function(item) {
      return item.id === id;
    });
    if (!foundSession) {
      return;
    }
    if (state.selectedId !== id) {
      teardownTerminal();
    }
    state.selectedId = id;
    persistSelectedId();
    state.toolContentCache = {};
    state.messageQueue = [];
    state.pendingMessages = [];
    syncStructuredQueueFromSession(foundSession);
    restoreStructuredQueue();
    updateStructuredQueueCounter();
    resetChatRenderCache2();
    state.currentMessages = [];
    if (state.chatRenderTimer) {
      clearTimeout(state.chatRenderTimer);
      state.chatRenderTimer = null;
    }
    var todoEl = document.getElementById("todo-progress");
    if (todoEl) todoEl.classList.add("hidden");
    var staleStatusBar = document.querySelector(".structured-status-bar");
    if (staleStatusBar) staleStatusBar.remove();
    if (state._statusBarTimerId) {
      clearInterval(state._statusBarTimerId);
      state._statusBarTimerId = null;
    }
    state._statusBarStartTime = 0;
    var staleComposer = document.querySelector(".input-composer");
    if (staleComposer) staleComposer.classList.remove("in-flight");
    var session = foundSession;
    state.preferredCommand = getPreferredTool();
    state.chatMode = getSafeModeForTool("claude", session && session.mode ? session.mode : state.chatMode);
    if (state.terminalInteractive && session && session.status !== "running") {
      setTerminalInteractive(false);
    }
    updateSessionsList();
    switchToSessionView2(id);
    if (state.filePanelOpen) {
      updateFilePanelCwd(session);
      refreshFileExplorer();
    }
    loadOutput(id).then(function() {
      focusInputBox3(true);
    });
    subscribeToSession(id);
    state.gitStatus = null;
    state.gitStatusSessionId = null;
    updateTopbarGitBadge();
    loadGitStatus(id, { force: true });
  }
  function updatePinState() {
    var drawer = document.getElementById("sessions-drawer");
    var mainLayout = document.querySelector(".main-layout");
    var isMobile = isMobileLayout();
    var isCollapsed = !!state.sidebarPinned && !!state.sidebarCollapsed;
    var isAnchored = isCollapsed || !isMobile && (!!state.sidebarPinned || !!state.sessionsDrawerOpen);
    if (drawer) {
      drawer.classList.toggle("pinned", isAnchored);
      drawer.classList.toggle("collapsed", isCollapsed);
    }
    if (mainLayout) {
      mainLayout.classList.toggle("sidebar-pinned", isAnchored);
      mainLayout.classList.toggle("sidebar-collapsed", isCollapsed);
    }
    var pinBtn = document.getElementById("sidebar-pin-btn");
    if (pinBtn) {
      pinBtn.classList.toggle("pinned", !!state.sidebarPinned);
      pinBtn.title = state.sidebarPinned ? "\u5DF2\u56FA\u5B9A\u5E38\u9A7B\uFF08\u70B9\u51FB\u89E3\u9664\u9501\u5B9A\uFF09" : "\u56FA\u5B9A\u4FA7\u680F\u5E38\u9A7B";
      pinBtn.setAttribute("aria-label", state.sidebarPinned ? "\u89E3\u9664\u56FA\u5B9A\u5E38\u9A7B" : "\u56FA\u5B9A\u4FA7\u680F\u5E38\u9A7B");
      pinBtn.setAttribute("aria-pressed", state.sidebarPinned ? "true" : "false");
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
      backdrop.classList.toggle("open", shouldShowSessionsBackdrop());
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
    var isMobile = isMobileLayout();
    if (!isMobile) {
      var willOpen = state.sidebarPinned ? false : !state.sessionsDrawerOpen;
      state.sessionsDrawerOpen = willOpen;
      if (willOpen) {
        state.sidebarCollapsed = false;
        writeStoredBoolean("wand-sidebar-collapsed", false);
      }
      writeStoredBoolean("wand-sidebar-open", state.sessionsDrawerOpen);
      updateLayoutState();
      scheduleTerminalRefitAfterPaddingTransition();
      return;
    }
    state.sessionsDrawerOpen = !state.sessionsDrawerOpen;
    writeStoredBoolean("wand-sidebar-open", state.sessionsDrawerOpen);
    if (state.sessionsDrawerOpen) {
      state.filePanelOpen = false;
      try {
        localStorage.setItem("wand-file-panel-open", "false");
      } catch (e) {
      }
    }
    updateLayoutState();
  }
  function closeSessionsDrawer2() {
    var isMobile = isMobileLayout();
    if (!isMobile) {
      if (!state.sidebarPinned && !state.sessionsDrawerOpen) return;
      closeSwipedItem();
      state.sidebarPinned = false;
      state.sessionsDrawerOpen = false;
      writeStoredBoolean("wand-sidebar-pinned", false);
      writeStoredBoolean("wand-sidebar-open", false);
      updateLayoutState();
      scheduleTerminalRefitAfterPaddingTransition();
      return;
    }
    if (!state.sessionsDrawerOpen) return;
    closeSwipedItem();
    state.sessionsDrawerOpen = false;
    writeStoredBoolean("wand-sidebar-open", false);
    updateLayoutState();
  }
  function closeTransientSessionsDrawer() {
    if (isMobileLayout()) {
      closeSessionsDrawer2();
      return;
    }
    if (state.sidebarPinned || state.sidebarCollapsed || !state.sessionsDrawerOpen) return;
    closeSwipedItem();
    state.sessionsDrawerOpen = false;
    writeStoredBoolean("wand-sidebar-open", false);
    updateLayoutState();
    scheduleTerminalRefitAfterPaddingTransition();
  }
  function setPlusPopoverOpen(open) {
    var popover = document.getElementById("composer-plus-popover");
    var btn = document.getElementById("attach-btn");
    state.plusPopoverOpen = !!open;
    if (popover) popover.classList.toggle("hidden", !open);
    if (btn) {
      btn.classList.toggle("active", !!open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }
  function togglePlusPopover() {
    setPlusPopoverOpen(!state.plusPopoverOpen);
  }
  function closePlusPopover() {
    if (state.plusPopoverOpen) setPlusPopoverOpen(false);
  }
  function dismissDrawerIfOverlay() {
    if (isMobileLayout() && state.sessionsDrawerOpen) {
      closeSessionsDrawer2();
    }
  }
  function scheduleTerminalRefitAfterPaddingTransition() {
    var mainLayout = document.querySelector(".main-layout");
    if (mainLayout) {
      var onEnd = function(e) {
        if (e.propertyName === "padding-left") {
          mainLayout.removeEventListener("transitionend", onEnd);
          scheduleTerminalResize2(true);
        }
      };
      mainLayout.addEventListener("transitionend", onEnd);
    }
    setTimeout(function() {
      scheduleTerminalResize2(true);
    }, 350);
  }
  var collapsedTileBubbleEl = null;
  function ensureCollapsedTileBubble() {
    if (collapsedTileBubbleEl && document.body.contains(collapsedTileBubbleEl)) {
      return collapsedTileBubbleEl;
    }
    collapsedTileBubbleEl = document.createElement("div");
    collapsedTileBubbleEl.className = "sidebar-tile-bubble";
    collapsedTileBubbleEl.setAttribute("role", "tooltip");
    document.body.appendChild(collapsedTileBubbleEl);
    return collapsedTileBubbleEl;
  }
  function hideCollapsedTileBubble() {
    if (collapsedTileBubbleEl) collapsedTileBubbleEl.classList.remove("visible");
  }
  function showCollapsedTileBubble(tile, text) {
    if (!text) {
      hideCollapsedTileBubble();
      return;
    }
    var bubble = ensureCollapsedTileBubble();
    bubble.textContent = text.length > 400 ? text.slice(0, 400) + "\u2026" : text;
    var rect = tile.getBoundingClientRect();
    bubble.classList.add("visible");
    var bubbleRect = bubble.getBoundingClientRect();
    var centerY = rect.top + rect.height / 2;
    var top = centerY - bubbleRect.height / 2;
    var minTop = 8;
    var maxTop = window.innerHeight - bubbleRect.height - 8;
    if (top < minTop) top = minTop;
    if (top > maxTop) top = Math.max(minTop, maxTop);
    bubble.style.left = rect.right + 12 + "px";
    bubble.style.top = top + "px";
    bubble.style.setProperty("--bubble-tail-y", centerY - top + "px");
  }
  function getCollapsedTileBubbleText(tile) {
    if (tile.dataset.collapsedSessionId) {
      var session = state.sessions.find(function(s) {
        return s.id === tile.dataset.collapsedSessionId;
      });
      if (!session) return "";
      var latest = getSessionLatestUserText(session);
      if (latest) return latest;
      return session.summary || session.command || "";
    }
    if (tile.dataset.collapsedHistoryId) {
      var hist = state.claudeHistory.find(function(s) {
        return s.claudeSessionId === tile.dataset.collapsedHistoryId;
      });
      if (hist && hist.firstUserMessage) return hist.firstUserMessage;
    }
    return "";
  }
  function handleCollapsedTileHover(event) {
    var target = event.target;
    if (!target || !(target instanceof Element)) return;
    var tile = target.closest(".sidebar-collapsed-tile");
    if (!tile) {
      hideCollapsedTileBubble();
      return;
    }
    var text = getCollapsedTileBubbleText(tile);
    if (!text) {
      hideCollapsedTileBubble();
      return;
    }
    showCollapsedTileBubble(tile, text);
  }
  function handleCollapsedTileLeave(event) {
    var related = event.relatedTarget;
    if (related && related instanceof Element && related.closest(".sidebar-collapsed-tile")) {
      return;
    }
    hideCollapsedTileBubble();
  }
  function toggleSidebarCollapsed() {
    var isMobile = isMobileLayout();
    if (!state.sidebarPinned) {
      state.sidebarPinned = true;
      writeStoredBoolean("wand-sidebar-pinned", true);
    }
    state.sidebarCollapsed = !state.sidebarCollapsed;
    writeStoredBoolean("wand-sidebar-collapsed", state.sidebarCollapsed);
    if (state.sidebarCollapsed) {
      state.sessionsDrawerOpen = false;
    } else if (isMobile) {
      state.sidebarPinned = false;
      state.sessionsDrawerOpen = true;
      writeStoredBoolean("wand-sidebar-pinned", false);
    } else {
      state.sessionsDrawerOpen = true;
    }
    writeStoredBoolean("wand-sidebar-open", state.sessionsDrawerOpen);
    updateLayoutState();
    updateSessionsList();
    updateSidebarCollapseButton();
    hideCollapsedTileBubble();
    scheduleTerminalRefitAfterPaddingTransition();
  }
  function toggleSidebarPin() {
    if (isMobileLayout()) return;
    state.sidebarPinned = !state.sidebarPinned;
    state.sessionsDrawerOpen = true;
    writeStoredBoolean("wand-sidebar-pinned", state.sidebarPinned);
    writeStoredBoolean("wand-sidebar-open", true);
    updateLayoutState();
    scheduleTerminalRefitAfterPaddingTransition();
  }
  function updateSidebarCollapseButton() {
    var btn = document.getElementById("sidebar-collapse-btn");
    if (!btn) return;
    var isCollapsed = !!state.sidebarPinned && !!state.sidebarCollapsed;
    btn.classList.toggle("collapsed", isCollapsed);
    btn.title = isCollapsed ? "\u5C55\u5F00\u4FA7\u680F" : "\u6536\u8D77\u4E3A\u7A84\u6761";
    btn.setAttribute("aria-label", isCollapsed ? "\u5C55\u5F00\u4FA7\u680F" : "\u6536\u8D77\u4E3A\u7A84\u6761");
    btn.innerHTML = isCollapsed ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 6 16 12 10 18"/><line x1="20" y1="5" x2="20" y2="19"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="14 6 8 12 14 18"/><line x1="4" y1="5" x2="4" y2="19"/></svg>';
  }
  function positionSidebarOverflowMenu(menu) {
    if (!menu) return;
    menu.style.left = "";
    menu.style.right = "";
    var parent = menu.offsetParent || menu.parentElement;
    if (!parent) return;
    var margin = 8;
    var parentRect = parent.getBoundingClientRect();
    var rect = menu.getBoundingClientRect();
    var vw = window.innerWidth;
    if (rect.left < margin) {
      menu.style.right = "auto";
      menu.style.left = margin - parentRect.left + "px";
    } else if (rect.right > vw - margin) {
      menu.style.left = "auto";
      menu.style.right = parentRect.right - (vw - margin) + "px";
    }
  }
  function applyNewSessionDefaults(config) {
    if (!config || typeof config !== "object") return;
    state.config = config;
    var tool = getProviderKey(config.defaultProvider);
    state.sessionTool = tool;
    state.preferredCommand = tool;
    state.sessionCreateKind = config.defaultSessionKind === "pty" ? "pty" : "structured";
    state.modeValue = getSafeModeForTool(tool, config.defaultMode || "default");
  }
  var _newSessionPreferenceWrite = Promise.resolve();
  function persistNewSessionDefaults(fields) {
    if (!fields || typeof fields !== "object") return Promise.resolve();
    _newSessionPreferenceWrite = _newSessionPreferenceWrite.catch(function() {
    }).then(function() {
      return fetch("/api/settings/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(fields)
      });
    }).then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || "\u4FDD\u5B58\u65B0\u5EFA\u4F1A\u8BDD\u504F\u597D\u5931\u8D25");
        if (data.config) state.config = data.config;
        return data;
      });
    }).catch(function(error) {
      console.warn("[wand] Failed to persist new-session defaults", error);
    });
    return _newSessionPreferenceWrite;
  }
  function openSessionModal() {
    closeSettingsModal();
    state.modalOpen = true;
    state.sessionsDrawerOpen = false;
    writeStoredBoolean("wand-sidebar-open", false);
    updateDrawerState();
    var modal = document.getElementById("session-modal");
    if (modal) {
      if (modal._wandCloseTimer) {
        clearTimeout(modal._wandCloseTimer);
        modal._wandCloseTimer = null;
      }
      modal.classList.remove("closing");
      modal.classList.remove("hidden");
      state.lastFocusedElement = document.activeElement;
      state.sessionTool = getProviderKey(state.config && state.config.defaultProvider);
      state.preferredCommand = state.sessionTool;
      state.sessionCreateKind = state.config && state.config.defaultSessionKind === "pty" ? "pty" : "structured";
      state.sessionCreateWorktree = false;
      state.modeValue = getSafeModeForTool(
        state.sessionTool,
        state.config && state.config.defaultMode ? state.config.defaultMode : "default"
      );
      syncSessionModalUI();
      _newSessionPreferenceWrite.then(function() {
        return fetch("/api/config", { credentials: "same-origin" });
      }).then(function(res) {
        return res.ok ? res.json() : null;
      }).then(function(config) {
        if (!config || !state.modalOpen) return;
        applyNewSessionDefaults(config);
        syncSessionModalUI();
      }).catch(function() {
      });
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
      if (state.focusTrapHandler) {
        document.removeEventListener("keydown", state.focusTrapHandler);
        state.focusTrapHandler = null;
      }
      if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
        state.lastFocusedElement.focus();
      }
      animateModalClose(modal);
    }
    hidePathSuggestions();
  }
  function animateModalClose(modal) {
    if (!modal) return;
    if (modal.classList.contains("hidden")) return;
    var prefersReducedMotion = false;
    try {
      prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_e) {
    }
    if (prefersReducedMotion || document.hidden) {
      modal.classList.remove("closing");
      modal.classList.add("hidden");
      return;
    }
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
    if (state.focusTrapHandler) {
      document.removeEventListener("keydown", state.focusTrapHandler);
    }
    var focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    state.focusTrapHandler = function(e) {
      if (e.key !== "Tab") return;
      var focusableElements = modal.querySelectorAll(focusableSelector);
      var firstEl = focusableElements[0];
      var lastEl = focusableElements[focusableElements.length - 1];
      if (!firstEl || !lastEl) return;
      if (e.shiftKey) {
        if (document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", state.focusTrapHandler);
  }
  function getActiveWorktreeMergeSession() {
    if (!state.activeWorktreeMergeSessionId) return null;
    return state.sessions.find(function(session) {
      return session.id === state.activeWorktreeMergeSessionId;
    }) || null;
  }
  function renderWorktreeMergeContent() {
    var container = document.getElementById("worktree-merge-content");
    var confirmBtn = document.getElementById("worktree-merge-confirm-button");
    var errorEl = document.getElementById("worktree-merge-error");
    var session = getActiveWorktreeMergeSession();
    var result = state.worktreeMergeCheckResult;
    if (!container || !confirmBtn) return;
    if (!session || !session.worktree) {
      container.innerHTML = '<p class="field-hint">\u672A\u627E\u5230\u53EF\u5408\u5E76\u7684 worktree \u4F1A\u8BDD\u3002</p>';
      confirmBtn.disabled = true;
      return;
    }
    if (errorEl) {
      if (state.worktreeMergeError) {
        showError2(errorEl, state.worktreeMergeError);
      } else {
        hideError2(errorEl);
      }
    }
    var rows = [
      '<div class="worktree-merge-row"><span>\u6765\u6E90\u5206\u652F</span><strong>' + escapeHtml2(session.worktree.branch || "-") + "</strong></div>",
      '<div class="worktree-merge-row"><span>\u5DE5\u4F5C\u76EE\u5F55</span><strong>' + escapeHtml2(session.worktree.path || "-") + "</strong></div>"
    ];
    if (result) {
      rows.push('<div class="worktree-merge-row"><span>\u76EE\u6807\u5206\u652F</span><strong>' + escapeHtml2(result.targetBranch || "-") + "</strong></div>");
      rows.push('<div class="worktree-merge-row"><span>\u5F85\u5408\u5E76\u63D0\u4EA4</span><strong>' + escapeHtml2(String(result.aheadCount || 0)) + "</strong></div>");
      rows.push('<div class="worktree-merge-row"><span>\u672A\u63D0\u4EA4\u6539\u52A8</span><strong>' + escapeHtml2(result.hasUncommittedChanges ? "\u6709" : "\u65E0") + "</strong></div>");
      rows.push('<div class="worktree-merge-row"><span>\u51B2\u7A81\u98CE\u9669</span><strong>' + escapeHtml2(result.hasConflicts ? "\u6709" : "\u65E0") + "</strong></div>");
      if (result.reason) {
        rows.push('<p class="field-hint">' + escapeHtml2(result.reason) + "</p>");
      }
    } else if (state.worktreeMergeLoading) {
      rows.push('<p class="field-hint">\u6B63\u5728\u68C0\u67E5 worktree \u5408\u5E76\u72B6\u6001\u2026</p>');
    }
    container.innerHTML = rows.join("");
    confirmBtn.disabled = state.worktreeMergeLoading || state.worktreeMergeSubmitting || !result || result.ok !== true;
    confirmBtn.textContent = state.worktreeMergeSubmitting ? "\u5408\u5E76\u4E2D..." : "\u786E\u8BA4\u5408\u5E76\u5E76\u6E05\u7406";
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
      state.lastFocusedElement = document.activeElement;
      setupFocusTrap(modal);
    }
    renderWorktreeMergeContent();
    fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/worktree/merge/check", {
      method: "POST",
      credentials: "same-origin"
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && data.error) {
        throw new Error(data.error);
      }
      if (data && data.session) {
        updateSessionSnapshot(data.session);
      }
      state.worktreeMergeCheckResult = data.result || null;
      state.worktreeMergeError = "";
    }).catch(function(error) {
      state.worktreeMergeError = error && error.message || "\u65E0\u6CD5\u68C0\u67E5 worktree \u5408\u5E76\u72B6\u6001\u3002";
    }).finally(function() {
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
    if (state.focusTrapHandler) {
      document.removeEventListener("keydown", state.focusTrapHandler);
      state.focusTrapHandler = null;
    }
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
      state.lastFocusedElement.focus();
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
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && data.error) {
        throw new Error(data.error);
      }
      if (data && data.session) {
        updateSessionSnapshot(data.session);
      }
      showToast2("\u5DF2\u5408\u5E76\u5230 " + escapeHtml2(data.result && data.result.targetBranch || "\u4E3B\u5206\u652F") + (data.result && data.result.cleanupDone === false ? "\uFF0C\u4F46\u5DE5\u4F5C\u6811\u5F85\u6E05\u7406\u3002" : "\u3002"), "info");
      closeWorktreeMergeModal();
      return refreshAll();
    }).catch(function(error) {
      state.worktreeMergeError = error && error.message || "\u65E0\u6CD5\u5408\u5E76 worktree\u3002";
      renderWorktreeMergeContent();
    }).finally(function() {
      state.worktreeMergeSubmitting = false;
      renderWorktreeMergeContent();
    });
  }
  function retryWorktreeCleanup(sessionId) {
    fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/worktree/cleanup", {
      method: "POST",
      credentials: "same-origin"
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data && data.error) {
        throw new Error(data.error);
      }
      if (data && data.session) {
        updateSessionSnapshot(data.session);
      }
      showToast2("\u5DF2\u5B8C\u6210 worktree \u6E05\u7406\u3002", "info");
      return refreshAll();
    }).catch(function(error) {
      showToast2(error && error.message || "\u65E0\u6CD5\u6E05\u7406 worktree\u3002", "error");
    });
  }
  function openSettingsModal() {
    closeSessionModal();
    var modal = document.getElementById("settings-modal");
    if (modal) {
      if (modal._wandCloseTimer) {
        clearTimeout(modal._wandCloseTimer);
        modal._wandCloseTimer = null;
      }
      modal.classList.remove("closing");
      modal.classList.remove("hidden");
      state.lastFocusedElement = document.activeElement;
      var passEl = document.getElementById("new-password");
      var confirmEl = document.getElementById("confirm-password");
      if (passEl) passEl.value = "";
      if (confirmEl) confirmEl.value = "";
      hideSettingsMessages();
      setupFocusTrap(modal);
      bindSettingsTabKeyboardNavigation();
      modal.querySelectorAll(".model-combobox-input").forEach(function(node) {
        node.dataset.modelDirty = "false";
        node.dataset.modelInitialized = "false";
      });
      switchSettingsTab("about");
      loadSettingsData();
      var soundEl = document.getElementById("cfg-notif-sound");
      var bubbleEl = document.getElementById("cfg-notif-bubble");
      if (soundEl) soundEl.checked = state.notifSound;
      if (bubbleEl) bubbleEl.checked = state.notifBubble;
      var volEl = document.getElementById("cfg-notif-volume");
      var volValEl = document.getElementById("cfg-notif-volume-val");
      if (volEl) {
        volEl.value = state.notifVolume;
        if (volValEl) volValEl.textContent = state.notifVolume + "%";
        try {
          volEl.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (_e) {
        }
      }
      var volField = document.getElementById("notif-volume-field");
      if (volField) volField.style.display = state.notifSound ? "" : "none";
      updateNotificationStatus();
      if (typeof WandNative !== "undefined" && typeof WandNative.getAppIcon === "function") {
        try {
          _updateAppIconSelection(WandNative.getAppIcon() || "shorthair");
        } catch (_e) {
        }
      }
      if (_hasNativeBridge && typeof WandNative.getNotificationSound === "function") {
        try {
          var nsSel = document.getElementById("native-sound-select");
          if (nsSel) nsSel.value = WandNative.getNotificationSound();
        } catch (_e) {
        }
      }
      if (_hasNativeBridge && typeof WandNative.getNotificationVolume === "function") {
        try {
          var nativeVol = WandNative.getNotificationVolume();
          state.notifVolume = nativeVol;
          if (volEl) volEl.value = String(nativeVol);
          if (volValEl) volValEl.textContent = nativeVol + "%";
          if (volEl) {
            try {
              volEl.dispatchEvent(new Event("input", { bubbles: true }));
            } catch (_e) {
            }
          }
          try {
            localStorage.setItem("wand-notif-volume", String(nativeVol));
          } catch (_e) {
          }
        } catch (_e) {
        }
      }
      if (_hasNativeBridge && typeof WandNative.isHapticEnabled === "function") {
        try {
          var hapticEl = document.getElementById("cfg-haptic-enabled");
          if (hapticEl) hapticEl.checked = WandNative.isHapticEnabled();
        } catch (_e) {
        }
      }
    }
  }
  function closeSettingsModal() {
    var modal = document.getElementById("settings-modal");
    if (modal) {
      modal.querySelectorAll(".model-combobox.is-open").forEach(function(root) {
        closeSettingsModelCombobox(root);
      });
      if (state.focusTrapHandler) {
        document.removeEventListener("keydown", state.focusTrapHandler);
        state.focusTrapHandler = null;
      }
      if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
        state.lastFocusedElement.focus();
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
      errorEl.textContent = "\u5BC6\u7801\u957F\u5EA6\u81F3\u5C11\u4E3A 6 \u4E2A\u5B57\u7B26\u3002";
      errorEl.classList.remove("hidden");
      return;
    }
    if (newPass !== confirmPass) {
      errorEl.textContent = "\u4E24\u6B21\u8F93\u5165\u7684\u5BC6\u7801\u4E0D\u4E00\u81F4\u3002";
      errorEl.classList.remove("hidden");
      return;
    }
    fetch("/api/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPass }),
      credentials: "same-origin"
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        errorEl.textContent = data.error;
        errorEl.classList.remove("hidden");
        return;
      }
      successEl.textContent = "\u5BC6\u7801\u4FEE\u6539\u6210\u529F\uFF01";
      successEl.classList.remove("hidden");
      document.getElementById("new-password").value = "";
      document.getElementById("confirm-password").value = "";
    }).catch(function() {
      errorEl.textContent = "Failed to save password.";
      errorEl.classList.remove("hidden");
    });
  }
  function switchSettingsTab(tabName) {
    document.querySelectorAll(".model-combobox.is-open").forEach(function(root) {
      closeSettingsModelCombobox(root);
    });
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
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".settings-tab"));
    if (!tabs.length) return;
    var tabList = event.currentTarget && event.currentTarget.closest ? event.currentTarget.closest(".settings-tabs") : null;
    var horizontal = tabList && tabList.getAttribute("aria-orientation") === "horizontal";
    if (horizontal && (event.key === "ArrowUp" || event.key === "ArrowDown")) return;
    if (!horizontal && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
    var currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex === -1) return;
    event.preventDefault();
    var nextIndex = currentIndex;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    var nextTab = tabs[nextIndex];
    if (!nextTab) return;
    var nextName = nextTab.getAttribute("data-tab");
    if (nextName) switchSettingsTab(nextName);
    if (typeof nextTab.focus === "function") nextTab.focus();
  }
  function bindSettingsTabKeyboardNavigation() {
    var tabList = document.querySelector(".settings-tabs");
    if (tabList) {
      var horizontal = false;
      try {
        horizontal = !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
      } catch (_e) {
      }
      tabList.setAttribute("aria-orientation", horizontal ? "horizontal" : "vertical");
    }
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
      about: data.version ? "\u5F53\u524D v" + data.version : "\u7248\u672C\u4E0E\u66F4\u65B0\u4FE1\u606F",
      general: [cfg.defaultMode || "default", cfg.language || "\u81EA\u52A8\u8BED\u8A00"].filter(Boolean).join(" \xB7 "),
      notifications: state.notifSound ? "\u63D0\u793A\u97F3 " + state.notifVolume + "%" : "\u63D0\u793A\u97F3\u5DF2\u5173\u95ED",
      security: data.hasCert ? "\u5DF2\u5B89\u88C5 SSL \u8BC1\u4E66" : "\u5BC6\u7801\u4E0E\u8BC1\u4E66\u7BA1\u7406",
      presets: cfg.commandPresets && cfg.commandPresets.length ? cfg.commandPresets.length + " \u6761\u9884\u8BBE" : "\u6682\u65E0\u9884\u8BBE",
      display: "\u63A7\u5236\u5361\u7247\u9ED8\u8BA4\u5C55\u5F00"
    };
    for (var key in metaMap) {
      if (!Object.prototype.hasOwnProperty.call(metaMap, key)) continue;
      var tab = document.querySelector('.settings-tab[data-tab="' + key + '"] .settings-tab-meta');
      if (tab) {
        var metaText = metaMap[key] || "";
        tab.textContent = metaText;
        tab.setAttribute("title", metaText);
      }
    }
  }
  function renderConnectQrCode(code) {
    var canvas = document.getElementById("android-connect-qr");
    var empty = document.getElementById("android-connect-qr-empty");
    var lib = window.QRCodeLib;
    if (!canvas) return;
    if (!lib || typeof lib.toCanvas !== "function") {
      if (empty) empty.textContent = "\u4E8C\u7EF4\u7801\u5E93\u672A\u52A0\u8F7D";
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
            empty.textContent = "\u4E8C\u7EF4\u7801\u751F\u6210\u5931\u8D25";
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
        empty.textContent = "\u4E8C\u7EF4\u7801\u751F\u6210\u5931\u8D25";
        empty.style.display = "";
      }
      canvas.style.visibility = "hidden";
    }
  }
  function showConnectQrModal(code) {
    var lib = window.QRCodeLib;
    if (!lib || typeof lib.toCanvas !== "function") return;
    var existing = document.getElementById("connect-qr-modal");
    if (existing) existing.remove();
    var overlay = document.createElement("div");
    overlay.id = "connect-qr-modal";
    overlay.className = "connect-qr-modal-overlay";
    overlay.innerHTML = '<div class="connect-qr-modal-card"><canvas id="connect-qr-modal-canvas"></canvas><p class="connect-qr-modal-hint">\u7528 Wand App \u626B\u4E00\u626B\uFF0C\u8FDE\u63A5\u5F53\u524D\u670D\u52A1\u5668</p><button type="button" class="btn btn-secondary btn-sm connect-qr-modal-close">\u5173\u95ED</button></div>';
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
    } catch (e) {
    }
    function close() {
      overlay.remove();
    }
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
      if (successCallback) {
        successCallback();
        return;
      }
      if (triggerBtn) {
        var orig = triggerBtn.textContent;
        triggerBtn.textContent = "\u5DF2\u590D\u5236";
        setTimeout(function() {
          triggerBtn.textContent = orig;
        }, 1500);
      }
    }
    if (_hasNativeBridge && typeof WandNative.copyToClipboard === "function") {
      try {
        if (WandNative.copyToClipboard(text) === "ok") {
          onSuccess();
          return;
        }
      } catch (_e) {
      }
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
    var canManageSettings = !state.config || state.config.canManageSettings !== false;
    var settingsUrl = canManageSettings ? "/api/settings" : "/api/settings/about";
    fetch(settingsUrl, { credentials: "same-origin" }).then(function(res) {
      if (res.ok) return res.json();
      if (res.status === 403 && settingsUrl === "/api/settings") {
        return fetch("/api/settings/about", { credentials: "same-origin" }).then(function(aboutRes) {
          if (!aboutRes.ok) throw new Error("\u65E0\u6CD5\u52A0\u8F7D\u5173\u4E8E\u4FE1\u606F (HTTP " + aboutRes.status + ")");
          return aboutRes.json();
        });
      }
      throw new Error("\u65E0\u6CD5\u52A0\u8F7D\u8BBE\u7F6E (HTTP " + res.status + ")");
    }).then(function(data) {
      var hasAdminSettings = data.settingsAccess !== "read-only";
      var accessNote = document.getElementById("settings-about-access-note");
      if (accessNote) accessNote.classList.toggle("hidden", hasAdminSettings);
      var providerCliSection = document.getElementById("provider-cli-update-section");
      if (providerCliSection) providerCliSection.classList.toggle("hidden", !hasAdminSettings);
      var connectSection = document.getElementById("android-connect-section");
      if (connectSection) connectSection.classList.toggle("hidden", !hasAdminSettings);
      ["check-update-button", "do-update-button", "do-restart-button"].forEach(function(id) {
        var control = document.getElementById(id);
        var actions = control && control.closest(".settings-update-actions");
        if (actions) actions.classList.toggle("hidden", !hasAdminSettings);
      });
      ["beta-channel-toggle", "auto-update-web-toggle"].forEach(function(id) {
        var control = document.getElementById(id);
        var row = control && control.closest(".settings-toggle-row");
        if (row) row.classList.toggle("hidden", !hasAdminSettings);
      });
      updateSettingsSidebarStatus(data);
      var nameEl = document.getElementById("settings-pkg-name");
      var verEl = document.getElementById("settings-version");
      var nodeEl = document.getElementById("settings-node-req");
      var repoEl = document.getElementById("settings-repo-url");
      if (nameEl) nameEl.textContent = data.packageName || "-";
      if (verEl) verEl.textContent = data.version || "-";
      if (nodeEl) nodeEl.textContent = data.nodeVersion || "-";
      if (repoEl && data.repoUrl) {
        repoEl.innerHTML = '<a href="' + escapeHtml2(data.repoUrl) + '" target="_blank" rel="noopener">' + escapeHtml2(data.repoUrl) + "</a>";
      }
      var latestEl = document.getElementById("settings-latest-version");
      var updateBtn = document.getElementById("do-update-button");
      if (data.latestVersion && latestEl) {
        latestEl.textContent = data.latestVersion;
        if (data.updateAvailable && updateBtn) {
          updateBtn.classList.remove("hidden");
        }
      }
      var betaChannelToggle = document.getElementById("beta-channel-toggle");
      if (betaChannelToggle) betaChannelToggle.checked = data.updateChannel === "beta";
      var autoUpdate = data.autoUpdate || {};
      var autoUpdateWebToggle = document.getElementById("auto-update-web-toggle");
      if (autoUpdateWebToggle) autoUpdateWebToggle.checked = !!autoUpdate.web;
      var autoUpdateApkToggle = document.getElementById("auto-update-apk-toggle");
      if (autoUpdateApkToggle) autoUpdateApkToggle.checked = !!_apkVersion && !!autoUpdate.apk;
      var autoUpdateDmgToggle = document.getElementById("auto-update-dmg-toggle");
      if (autoUpdateDmgToggle) autoUpdateDmgToggle.checked = !!_macAppVersion && !!autoUpdate.dmg;
      var autoUpdateCliToggle = document.getElementById("auto-update-cli-toggle");
      if (autoUpdateCliToggle) autoUpdateCliToggle.checked = !!autoUpdate.cli;
      if (hasAdminSettings) loadProviderCliUpdates(false);
      function safeNotify(msg, type) {
        wandAlert2(msg, { type: type === "error" ? "danger" : "info" });
      }
      function triggerLocalDownload(url, fileName, btn) {
        var original = btn ? btn.textContent : "";
        if (btn) {
          btn.disabled = true;
          btn.textContent = "\u4E0B\u8F7D\u4E2D\u2026";
        }
        function restore() {
          if (btn) {
            btn.disabled = false;
            btn.textContent = original;
          }
        }
        fetch(url, { method: "HEAD", credentials: "same-origin" }).then(function(resp) {
          if (!resp.ok) {
            safeNotify(resp.status === 404 ? "\u4E0B\u8F7D\u672A\u542F\u7528\u6216\u6587\u4EF6\u5DF2\u79FB\u9664" : "\u4E0B\u8F7D\u5931\u8D25 (HTTP " + resp.status + ")", "error");
            restore();
            return;
          }
          var a = document.createElement("a");
          a.href = url;
          a.download = fileName || "";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          safeNotify("\u5DF2\u5F00\u59CB\u4E0B\u8F7D\uFF0C\u8BF7\u5728\u901A\u77E5\u680F/\u4E0B\u8F7D\u7BA1\u7406\u4E2D\u67E5\u770B", "info");
          restore();
        }).catch(function(err) {
          safeNotify("\u4E0B\u8F7D\u5931\u8D25: " + (err && err.message ? err.message : err), "error");
          restore();
        });
      }
      function compareVer(a, b) {
        function parse(v) {
          var s = String(v || "").replace(/^v/, "");
          var dash = s.indexOf("-");
          var main = dash >= 0 ? s.slice(0, dash) : s;
          var pre = dash >= 0 ? s.slice(dash + 1) : "";
          return {
            parts: main.split(".").map(function(n) {
              return parseInt(n, 10) || 0;
            }),
            pre,
            isDebug: pre.indexOf("debug") === 0
          };
        }
        var pa = parse(a), pb = parse(b);
        for (var i2 = 0; i2 < 3; i2++) {
          var d = (pa.parts[i2] || 0) - (pb.parts[i2] || 0);
          if (d !== 0) return d > 0 ? 1 : -1;
        }
        if (pa.isDebug !== pb.isDebug) return pa.isDebug ? 1 : -1;
        if (pa.isDebug && pb.isDebug) {
          var sa = pa.pre.split("."), sb = pb.pre.split(".");
          for (var j = 0; j < Math.max(sa.length, sb.length); j++) {
            if (sa[j] === void 0) return -1;
            if (sb[j] === void 0) return 1;
            var na = parseInt(sa[j], 10), nb = parseInt(sb[j], 10);
            if (!isNaN(na) && !isNaN(nb)) {
              if (na !== nb) return na > nb ? 1 : -1;
            } else if (sa[j] !== sb[j]) {
              return sa[j] > sb[j] ? 1 : -1;
            }
          }
        }
        return 0;
      }
      function applyApkButton(btn, cmp, url, fileName, source, allowDowngrade) {
        btn.classList.remove("hidden");
        btn.disabled = false;
        if (cmp > 0) {
          btn.textContent = "\u5347\u7EA7";
        } else if (cmp === 0) {
          btn.textContent = "\u5DF2\u662F\u6700\u65B0";
          btn.disabled = true;
        } else if (allowDowngrade) {
          btn.textContent = "\u91CD\u65B0\u5B89\u88C5";
        } else {
          btn.textContent = "\u7248\u672C\u8F83\u65E7";
          btn.disabled = true;
        }
        btn.onclick = btn.disabled ? null : function() {
          try {
            WandNative.downloadUpdate(url, fileName, source);
          } catch (e) {
            safeNotify("\u8C03\u7528\u4E0B\u8F7D\u5931\u8D25: " + (e && e.message ? e.message : e), "error");
          }
        };
      }
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
      var apkEnabled = androidApk.enabled !== false;
      var hasApkInfo = isInApk || apkEnabled && (!!androidApk.github || !!androidApk.local);
      if (apkSection) {
        if (hasApkInfo) apkSection.classList.remove("hidden");
        else apkSection.classList.add("hidden");
      }
      if (isInApk) {
        if (apkCurrentRow && apkCurrentEl) {
          apkCurrentEl.textContent = "v" + _apkVersion;
          apkCurrentRow.classList.remove("hidden");
        }
        if (androidApk.github && apkGithubRow && apkGithubEl) {
          var ghLabel = androidApk.github.version ? "v" + androidApk.github.version : androidApk.github.fileName;
          if (typeof androidApk.github.size === "number") ghLabel += " \xB7 " + formatBytes(androidApk.github.size);
          apkGithubEl.textContent = ghLabel;
          apkGithubRow.classList.remove("hidden");
          if (apkGithubBtn) {
            var ghCmp = androidApk.github.version ? compareVer(androidApk.github.version, _apkVersion) : 1;
            applyApkButton(apkGithubBtn, ghCmp, androidApk.github.downloadUrl, androidApk.github.fileName || "wand-update.apk", "github", false);
          }
        }
        if (androidApk.local && apkLocalRow && apkLocalEl) {
          var lcLabel = androidApk.local.version ? "v" + androidApk.local.version : androidApk.local.fileName;
          if (typeof androidApk.local.size === "number") lcLabel += " \xB7 " + formatBytes(androidApk.local.size);
          apkLocalEl.textContent = lcLabel;
          apkLocalRow.classList.remove("hidden");
          if (apkLocalBtn) {
            var lcCmp = androidApk.local.version ? compareVer(androidApk.local.version, _apkVersion) : 1;
            applyApkButton(apkLocalBtn, lcCmp, androidApk.local.downloadUrl, androidApk.local.fileName || "wand-update.apk", "local", false);
          }
        }
        if (!androidApk.github && !androidApk.local && apkMessageEl) {
          apkMessageEl.textContent = "\u6682\u65E0\u53EF\u7528\u66F4\u65B0";
          apkMessageEl.classList.remove("hidden");
        }
        var apkAutoRow = document.getElementById("android-auto-update-row");
        var apkAutoHint = document.getElementById("android-auto-update-hint");
        if (apkAutoRow) apkAutoRow.classList.toggle("hidden", !hasAdminSettings);
        if (apkAutoHint) apkAutoHint.classList.toggle("hidden", !hasAdminSettings);
      } else {
        if (androidApk.github && apkGithubRow && apkGithubEl) {
          var ghLabel2 = androidApk.github.version ? "v" + androidApk.github.version : androidApk.github.fileName;
          if (typeof androidApk.github.size === "number") ghLabel2 += " \xB7 " + formatBytes(androidApk.github.size);
          apkGithubEl.textContent = ghLabel2;
          apkGithubRow.classList.remove("hidden");
          if (apkGithubBtn) {
            apkGithubBtn.textContent = "\u4E0B\u8F7D";
            apkGithubBtn.classList.remove("hidden");
            apkGithubBtn.onclick = function() {
              window.open(androidApk.github.downloadUrl, "_blank");
              safeNotify("\u6B63\u5728\u6253\u5F00\u4E0B\u8F7D\u9875\u2026", "info");
            };
          }
        }
        if (androidApk.local && apkLocalRow && apkLocalEl) {
          var lcLabel2 = androidApk.local.version ? "v" + androidApk.local.version : androidApk.local.fileName;
          if (typeof androidApk.local.size === "number") lcLabel2 += " \xB7 " + formatBytes(androidApk.local.size);
          apkLocalEl.textContent = lcLabel2;
          apkLocalRow.classList.remove("hidden");
          if (apkLocalBtn) {
            apkLocalBtn.textContent = "\u4E0B\u8F7D";
            apkLocalBtn.classList.remove("hidden");
            apkLocalBtn.onclick = function() {
              triggerLocalDownload(androidApk.local.downloadUrl, androidApk.local.fileName || "wand-update.apk", apkLocalBtn);
            };
          }
        }
        if (!androidApk.github && !androidApk.local && apkMessageEl) {
          apkMessageEl.textContent = apkEnabled ? "\u5728\u7EBF\u7248\u672C\u6682\u65F6\u83B7\u53D6\u5931\u8D25\uFF0C\u53EF\u7A0D\u540E\u91CD\u8BD5" : "Android \u4E0B\u8F7D\u672A\u5728\u670D\u52A1\u7AEF\u542F\u7528";
          apkMessageEl.classList.remove("hidden");
        }
      }
      var dmgSection = document.getElementById("macos-dmg-section");
      var dmgCurrentRow = document.getElementById("macos-dmg-current-row");
      var dmgCurrentEl = document.getElementById("settings-macos-dmg-current");
      var dmgGithubRow = document.getElementById("macos-dmg-github-row");
      var dmgGithubEl = document.getElementById("settings-macos-dmg-github");
      var dmgGithubBtn = document.getElementById("download-github-dmg-btn");
      var dmgLocalRow = document.getElementById("macos-dmg-local-row");
      var dmgLocalEl = document.getElementById("settings-macos-dmg-local");
      var dmgLocalBtn = document.getElementById("download-local-dmg-btn");
      var dmgMessageEl = document.getElementById("macos-dmg-message");
      var macosDmg = data.macosDmg || {};
      var isInMacApp = !!_macAppVersion;
      var dmgEnabled = macosDmg.enabled !== false;
      var hasDmgInfo = isInMacApp || dmgEnabled && (!!macosDmg.github || !!macosDmg.local);
      if (dmgSection) {
        if (hasDmgInfo) dmgSection.classList.remove("hidden");
        else dmgSection.classList.add("hidden");
      }
      if (isInMacApp) {
        if (dmgCurrentRow && dmgCurrentEl) {
          dmgCurrentEl.textContent = "v" + _macAppVersion;
          dmgCurrentRow.classList.remove("hidden");
        }
        if (macosDmg.github && dmgGithubRow && dmgGithubEl) {
          var dghLabel = macosDmg.github.version ? "v" + macosDmg.github.version : macosDmg.github.fileName;
          if (typeof macosDmg.github.size === "number") dghLabel += " \xB7 " + formatBytes(macosDmg.github.size);
          dmgGithubEl.textContent = dghLabel;
          dmgGithubRow.classList.remove("hidden");
          if (dmgGithubBtn) {
            var dghCmp = macosDmg.github.version ? compareVer(macosDmg.github.version, _macAppVersion) : 1;
            applyApkButton(dmgGithubBtn, dghCmp, macosDmg.github.downloadUrl, macosDmg.github.fileName || "wand-update.dmg", "github", true);
          }
        }
        if (macosDmg.local && dmgLocalRow && dmgLocalEl) {
          var dlcLabel = macosDmg.local.version ? "v" + macosDmg.local.version : macosDmg.local.fileName;
          if (typeof macosDmg.local.size === "number") dlcLabel += " \xB7 " + formatBytes(macosDmg.local.size);
          dmgLocalEl.textContent = dlcLabel;
          dmgLocalRow.classList.remove("hidden");
          if (dmgLocalBtn) {
            var dlcCmp = macosDmg.local.version ? compareVer(macosDmg.local.version, _macAppVersion) : 1;
            applyApkButton(dmgLocalBtn, dlcCmp, macosDmg.local.downloadUrl, macosDmg.local.fileName || "wand-update.dmg", "local", true);
          }
        }
        if (!macosDmg.github && !macosDmg.local && dmgMessageEl) {
          dmgMessageEl.textContent = "\u6682\u65E0\u53EF\u7528\u66F4\u65B0";
          dmgMessageEl.classList.remove("hidden");
        }
        var dmgAutoRow = document.getElementById("macos-auto-update-row");
        var dmgAutoHint = document.getElementById("macos-auto-update-hint");
        if (dmgAutoRow) dmgAutoRow.classList.toggle("hidden", !hasAdminSettings);
        if (dmgAutoHint) dmgAutoHint.classList.toggle("hidden", !hasAdminSettings);
      } else {
        if (macosDmg.github && dmgGithubRow && dmgGithubEl) {
          var dghLabel2 = macosDmg.github.version ? "v" + macosDmg.github.version : macosDmg.github.fileName;
          if (typeof macosDmg.github.size === "number") dghLabel2 += " \xB7 " + formatBytes(macosDmg.github.size);
          dmgGithubEl.textContent = dghLabel2;
          dmgGithubRow.classList.remove("hidden");
          if (dmgGithubBtn) {
            dmgGithubBtn.textContent = "\u4E0B\u8F7D";
            dmgGithubBtn.classList.remove("hidden");
            dmgGithubBtn.onclick = function() {
              window.open(macosDmg.github.downloadUrl, "_blank");
              safeNotify("\u6B63\u5728\u6253\u5F00\u4E0B\u8F7D\u9875\u2026", "info");
            };
          }
        }
        if (macosDmg.local && dmgLocalRow && dmgLocalEl) {
          var dlcLabel2 = macosDmg.local.version ? "v" + macosDmg.local.version : macosDmg.local.fileName;
          if (typeof macosDmg.local.size === "number") dlcLabel2 += " \xB7 " + formatBytes(macosDmg.local.size);
          dmgLocalEl.textContent = dlcLabel2;
          dmgLocalRow.classList.remove("hidden");
          if (dmgLocalBtn) {
            dmgLocalBtn.textContent = "\u4E0B\u8F7D";
            dmgLocalBtn.classList.remove("hidden");
            dmgLocalBtn.onclick = function() {
              triggerLocalDownload(macosDmg.local.downloadUrl, macosDmg.local.fileName || "wand-update.dmg", dmgLocalBtn);
            };
          }
        }
        if (!macosDmg.github && !macosDmg.local && dmgMessageEl) {
          dmgMessageEl.textContent = dmgEnabled ? "\u5728\u7EBF\u7248\u672C\u6682\u65F6\u83B7\u53D6\u5931\u8D25\uFF0C\u53EF\u7A0D\u540E\u91CD\u8BD5" : "macOS \u4E0B\u8F7D\u672A\u5728\u670D\u52A1\u7AEF\u542F\u7528";
          dmgMessageEl.classList.remove("hidden");
        }
      }
      var connectCodeEl = document.getElementById("android-connect-code");
      var connectQrCanvas = document.getElementById("android-connect-qr");
      var connectQrEmpty = document.getElementById("android-connect-qr-empty");
      var connectQrWrap = document.getElementById("android-connect-qr-wrap");
      if (connectCodeEl && hasAdminSettings) {
        connectCodeEl.textContent = "\u52A0\u8F7D\u4E2D...";
        if (connectQrEmpty) connectQrEmpty.textContent = "\u751F\u6210\u4E2D\u2026";
        if (connectQrCanvas) connectQrCanvas.style.visibility = "hidden";
        var connectCodeUrl = "/api/app-connect-code";
        if (window.location && window.location.origin) {
          connectCodeUrl += "?origin=" + encodeURIComponent(window.location.origin);
        }
        fetch(connectCodeUrl, { credentials: "same-origin" }).then(function(r) {
          return r.json();
        }).then(function(d) {
          if (d.code) {
            connectCodeEl.textContent = d.code;
            state.androidConnectCode = d.code;
            renderConnectQrCode(d.code);
          } else {
            connectCodeEl.textContent = "\u751F\u6210\u5931\u8D25";
            if (connectQrEmpty) connectQrEmpty.textContent = "\u751F\u6210\u5931\u8D25";
          }
        }).catch(function() {
          connectCodeEl.textContent = "\u83B7\u53D6\u5931\u8D25";
          if (connectQrEmpty) connectQrEmpty.textContent = "\u83B7\u53D6\u5931\u8D25";
        });
      }
      if (connectQrWrap && !connectQrWrap.dataset.bound) {
        connectQrWrap.dataset.bound = "1";
        connectQrWrap.addEventListener("click", function() {
          if (state.androidConnectCode) showConnectQrModal(state.androidConnectCode);
        });
      }
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
      var commitCliEl = document.getElementById("cfg-commit-cli");
      var commitModelEl = document.getElementById("cfg-commit-model");
      if (commitCliEl) commitCliEl.value = getProviderKey(cfg.commitCli);
      if (commitModelEl) {
        commitModelEl.value = cfg.commitModel || "";
        commitModelEl.dataset.modelInitialized = "true";
        commitModelEl.dataset.modelDirty = "false";
      }
      syncCommitModelProvider(false);
      var defaultModels = cfg.defaultModels && typeof cfg.defaultModels === "object" ? cfg.defaultModels : { claude: cfg.defaultModel || "", codex: cfg.defaultCodexModel || "", opencode: cfg.defaultOpenCodeModel || "" };
      state.configDefaultModels = {
        claude: defaultModels.claude || "",
        codex: defaultModels.codex || "",
        opencode: defaultModels.opencode || ""
      };
      state.configDefaultModel = state.configDefaultModels.claude;
      var defaultClaudeInput = document.getElementById("cfg-default-model");
      var defaultCodexInput = document.getElementById("cfg-default-codex-model");
      var defaultOpenCodeInput = document.getElementById("cfg-default-opencode-model");
      if (defaultClaudeInput && defaultClaudeInput.dataset.modelDirty !== "true") defaultClaudeInput.dataset.modelInitialized = "false";
      if (defaultCodexInput && defaultCodexInput.dataset.modelDirty !== "true") defaultCodexInput.dataset.modelInitialized = "false";
      if (defaultOpenCodeInput && defaultOpenCodeInput.dataset.modelDirty !== "true") defaultOpenCodeInput.dataset.modelInitialized = "false";
      updateSettingsDefaultModelSelect();
      fetchAvailableModels().then(function() {
        updateSettingsDefaultModelSelect();
      }).catch(function() {
      });
      var certStatus = document.getElementById("cert-status");
      if (certStatus) {
        certStatus.textContent = data.hasCert ? "\u5DF2\u5B89\u88C5 SSL \u8BC1\u4E66" : "\u672A\u5B89\u88C5\u8BC1\u4E66\uFF08\u4F7F\u7528\u81EA\u7B7E\u540D\u6216 HTTP\uFF09";
        certStatus.style.color = data.hasCert ? "var(--success)" : "var(--text-secondary)";
      }
      var presetsList = document.getElementById("presets-list");
      if (presetsList && cfg.commandPresets) {
        var html = "";
        for (var i = 0; i < cfg.commandPresets.length; i++) {
          var p = cfg.commandPresets[i];
          html += '<div class="preset-item"><span class="preset-label">' + escapeHtml2(p.label) + '</span><span class="preset-detail">' + escapeHtml2(p.command) + (p.mode ? " (" + escapeHtml2(p.mode) + ")" : "") + "</span></div>";
        }
        if (!html) html = '<div class="empty-state-compact"><span class="empty-icon">\u2699</span><span>\u6CA1\u6709\u547D\u4EE4\u9884\u8BBE</span><span class="hint">\u5728 config.json \u7684 commandPresets \u4E2D\u914D\u7F6E</span></div>';
        presetsList.innerHTML = html;
      }
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
    }).catch(function(error) {
      var accessNote = document.getElementById("settings-about-access-note");
      if (accessNote) {
        accessNote.textContent = error && error.message || "\u5173\u4E8E\u4FE1\u606F\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
        accessNote.style.color = "var(--error)";
        accessNote.classList.remove("hidden");
      }
    });
  }
  function saveConfigSettings() {
    var msgEl = document.getElementById("config-message");
    if (msgEl) {
      msgEl.classList.add("hidden");
      msgEl.textContent = "";
    }
    var defaultModelValue = ((document.getElementById("cfg-default-model") || {}).value || "").trim();
    var defaultCodexModelValue = ((document.getElementById("cfg-default-codex-model") || {}).value || "").trim();
    var defaultOpenCodeModelValue = ((document.getElementById("cfg-default-opencode-model") || {}).value || "").trim();
    var commitModelValue = ((document.getElementById("cfg-commit-model") || {}).value || "").trim();
    var body = {
      host: (document.getElementById("cfg-host") || {}).value,
      port: Number((document.getElementById("cfg-port") || {}).value),
      https: (document.getElementById("cfg-https") || {}).checked,
      defaultMode: (document.getElementById("cfg-mode") || {}).value,
      defaultCwd: (document.getElementById("cfg-cwd") || {}).value,
      shell: (document.getElementById("cfg-shell") || {}).value,
      language: (document.getElementById("cfg-language") || {}).value || "",
      defaultModel: defaultModelValue,
      defaultCodexModel: defaultCodexModelValue,
      defaultOpenCodeModel: defaultOpenCodeModelValue,
      defaultModels: {
        claude: defaultModelValue,
        codex: defaultCodexModelValue,
        opencode: defaultOpenCodeModelValue
      },
      commitCli: getProviderKey((document.getElementById("cfg-commit-cli") || {}).value),
      commitModel: commitModelValue,
      structuredRunner: (document.getElementById("cfg-structured-runner") || {}).value || "cli",
      inheritEnv: (document.getElementById("cfg-inherit-env") || {}).checked !== false
    };
    var previousDefaults = getConfigDefaultModels();
    var nextDefaultModel = body.defaultModel || "";
    var nextDefaultCodexModel = body.defaultCodexModel || "";
    var nextDefaultOpenCodeModel = body.defaultOpenCodeModel || "";
    fetch("/api/settings/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (msgEl) {
        if (data.error) {
          msgEl.textContent = data.error;
          msgEl.style.color = "var(--error)";
        } else {
          msgEl.textContent = data.restartRequired ? "\u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u90E8\u5206\u90E8\u7F72\u5B57\u6BB5\uFF08host/port/https/shell\uFF09\u9700\u8981\u91CD\u542F\u670D\u52A1\u624D\u751F\u6548\u3002" : "\u914D\u7F6E\u5DF2\u4FDD\u5B58\u3002";
          msgEl.style.color = "var(--success)";
        }
        msgEl.classList.remove("hidden");
      }
      if (!data || !data.error) {
        if (state.config) {
          state.config.defaultModel = nextDefaultModel;
          state.config.defaultCodexModel = nextDefaultCodexModel;
          state.config.defaultOpenCodeModel = nextDefaultOpenCodeModel;
          state.config.defaultModels = { claude: nextDefaultModel, codex: nextDefaultCodexModel, opencode: nextDefaultOpenCodeModel };
          state.config.commitCli = body.commitCli;
          state.config.commitModel = body.commitModel;
        }
        state.configDefaultModels = { claude: nextDefaultModel, codex: nextDefaultCodexModel, opencode: nextDefaultOpenCodeModel };
        state.configDefaultModel = nextDefaultModel;
        var savedClaudeInput = document.getElementById("cfg-default-model");
        var savedCodexInput = document.getElementById("cfg-default-codex-model");
        var savedOpenCodeInput = document.getElementById("cfg-default-opencode-model");
        if (savedClaudeInput) savedClaudeInput.dataset.modelDirty = "false";
        if (savedCodexInput) savedCodexInput.dataset.modelDirty = "false";
        if (savedOpenCodeInput) savedOpenCodeInput.dataset.modelDirty = "false";
        var savedCommitInput = document.getElementById("cfg-commit-model");
        if (savedCommitInput) savedCommitInput.dataset.modelDirty = "false";
        if (nextDefaultModel !== previousDefaults.claude) {
          setChatModelForProvider("claude", "");
        }
        if (nextDefaultCodexModel !== previousDefaults.codex) {
          setChatModelForProvider("codex", "");
        }
        if (nextDefaultOpenCodeModel !== previousDefaults.opencode) {
          setChatModelForProvider("opencode", "");
        }
        if (nextDefaultModel !== previousDefaults.claude || nextDefaultCodexModel !== previousDefaults.codex || nextDefaultOpenCodeModel !== previousDefaults.opencode) {
          syncComposerModelSelect(getSelectedSession6());
        }
      }
    }).catch(function() {
      if (msgEl) {
        msgEl.textContent = "\u4FDD\u5B58\u5931\u8D25\u3002";
        msgEl.style.color = "var(--error)";
        msgEl.classList.remove("hidden");
      }
    });
  }
  function saveDisplaySettings() {
    var msgEl = document.getElementById("display-message");
    if (msgEl) {
      msgEl.classList.add("hidden");
      msgEl.textContent = "";
    }
    var body = {
      cardDefaults: {
        editCards: !!(document.getElementById("cfg-card-edit") || {}).checked,
        inlineTools: !!(document.getElementById("cfg-card-inline") || {}).checked,
        terminal: !!(document.getElementById("cfg-card-terminal") || {}).checked,
        thinking: !!(document.getElementById("cfg-card-thinking") || {}).checked,
        toolGroup: !!(document.getElementById("cfg-card-toolgroup") || {}).checked
      }
    };
    fetch("/api/settings/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (msgEl) {
        if (data.error) {
          msgEl.textContent = data.error;
          msgEl.style.color = "var(--error)";
        } else {
          msgEl.textContent = "\u663E\u793A\u8BBE\u7F6E\u5DF2\u4FDD\u5B58";
          msgEl.style.color = "var(--success)";
        }
        msgEl.classList.remove("hidden");
      }
      if (!data.error && state.config) {
        state.config.cardDefaults = body.cardDefaults;
      }
    }).catch(function() {
      if (msgEl) {
        msgEl.textContent = "\u4FDD\u5B58\u5931\u8D25\u3002";
        msgEl.style.color = "var(--error)";
        msgEl.classList.remove("hidden");
      }
    });
  }
  function uploadCertificates() {
    var keyFile = document.getElementById("cert-key-file");
    var certFile = document.getElementById("cert-cert-file");
    var msgEl = document.getElementById("cert-message");
    if (msgEl) {
      msgEl.classList.add("hidden");
      msgEl.textContent = "";
    }
    if (!keyFile || !keyFile.files || !keyFile.files[0] || !certFile || !certFile.files || !certFile.files[0]) {
      if (msgEl) {
        msgEl.textContent = "\u8BF7\u9009\u62E9\u79C1\u94A5\u548C\u8BC1\u4E66\u6587\u4EF6\u3002";
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
        }).then(function(res) {
          return res.json();
        }).then(function(data) {
          if (msgEl) {
            if (data.error) {
              msgEl.textContent = data.error;
              msgEl.style.color = "var(--error)";
            } else {
              msgEl.textContent = "\u8BC1\u4E66\u5DF2\u4E0A\u4F20\uFF0C\u91CD\u542F\u540E\u751F\u6548\u3002";
              msgEl.style.color = "var(--success)";
              var certStatus = document.getElementById("cert-status");
              if (certStatus) {
                certStatus.textContent = "\u5DF2\u5B89\u88C5 SSL \u8BC1\u4E66";
                certStatus.style.color = "var(--success)";
              }
            }
            msgEl.classList.remove("hidden");
          }
        }).catch(function() {
          if (msgEl) {
            msgEl.textContent = "\u4E0A\u4F20\u5931\u8D25\u3002";
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
    if (latestEl) latestEl.textContent = "\u68C0\u67E5\u4E2D...";
    if (msgEl) msgEl.classList.add("hidden");
    if (updateBtn) updateBtn.classList.add("hidden");
    fetch("/api/check-update", { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        if (latestEl) latestEl.textContent = "\u68C0\u67E5\u5931\u8D25";
        return;
      }
      var isBeta = data.channel === "beta";
      if (latestEl) latestEl.textContent = data.latest || (isBeta ? "beta \u672A\u53D1\u5E03" : "-");
      if (!data.latest) {
        if (msgEl) {
          msgEl.textContent = isBeta ? "\u65E0\u6CD5\u8BFB\u53D6 npm beta \u7248\u672C\u3002" : "\u65E0\u6CD5\u8FDE\u63A5\u5230 npm registry\u3002";
          msgEl.style.color = "var(--error)";
          msgEl.classList.remove("hidden");
        }
        return;
      }
      if (updateBtn) {
        updateBtn.textContent = data.updateAvailable ? isBeta ? "\u66F4\u65B0\u5230 Beta" : "\u66F4\u65B0\u5230\u6700\u65B0\u7248" : isBeta ? "\u91CD\u65B0\u5B89\u88C5 Beta" : "\u91CD\u65B0\u5B89\u88C5\u6700\u65B0\u7248";
        updateBtn.classList.remove("hidden");
      }
      if (!data.updateAvailable && msgEl) {
        msgEl.textContent = isBeta ? "\u5DF2\u662F\u6700\u65B0 Beta \u7248\u672C\u3002" : "\u5DF2\u662F\u6700\u65B0\u7248\u672C\u3002";
        msgEl.style.color = "var(--success)";
        msgEl.classList.remove("hidden");
      }
    }).catch(function() {
      if (latestEl) latestEl.textContent = "\u68C0\u67E5\u5931\u8D25";
    });
  }
  function renderProviderCliUpdates(data) {
    var items = data && Array.isArray(data.items) ? data.items : [];
    var available = 0;
    ["claude", "codex", "opencode"].forEach(function(id) {
      var el = document.getElementById("provider-cli-status-" + id);
      if (!el) return;
      var item = items.find(function(candidate) {
        return candidate.id === id;
      });
      if (!item) {
        el.textContent = "\u68C0\u6D4B\u5931\u8D25";
        return;
      }
      el.setAttribute("title", item.error || item.executable || "");
      if (!item.installed) {
        el.textContent = "\u672A\u5B89\u88C5";
        return;
      }
      var current = item.currentVersion || "\u672A\u77E5\u7248\u672C";
      if (item.updateAvailable && item.updateSupported) {
        available++;
        el.textContent = current + " \u2192 " + (item.latestVersion || "\u6700\u65B0\u7248");
        return;
      }
      if (item.updateAvailable && !item.updateSupported) {
        el.textContent = current + " \xB7 \u9700\u8FC1\u79FB";
        return;
      }
      el.textContent = item.latestVersion ? current + " \xB7 \u6700\u65B0" : current + " \xB7 \u672A\u8BFB\u53D6\u5230\u6700\u65B0\u7248";
    });
    var updateButton = document.getElementById("update-provider-clis");
    if (updateButton) {
      updateButton.classList.toggle("hidden", available === 0);
      updateButton.textContent = available > 0 ? "\u5FEB\u901F\u66F4\u65B0 (" + available + ")" : "\u5FEB\u901F\u66F4\u65B0";
    }
    var autoToggle = document.getElementById("auto-update-cli-toggle");
    if (autoToggle && typeof data.autoUpdate === "boolean") autoToggle.checked = data.autoUpdate;
  }
  function loadProviderCliUpdates(force) {
    var checkButton = document.getElementById("check-provider-cli-updates");
    var message = document.getElementById("provider-cli-update-message");
    if (checkButton) {
      checkButton.disabled = true;
      checkButton.textContent = "\u68C0\u6D4B\u4E2D\u2026";
    }
    return fetch("/api/provider-cli-updates" + (force ? "?refresh=1" : ""), { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) throw new Error(data.error);
      renderProviderCliUpdates(data);
      if (message && force) {
        message.textContent = "CLI \u7248\u672C\u68C0\u67E5\u5B8C\u6210\u3002";
        message.style.color = "var(--success)";
        message.classList.remove("hidden");
      }
      return data;
    }).catch(function(error) {
      if (message) {
        message.textContent = error && error.message || "CLI \u7248\u672C\u68C0\u67E5\u5931\u8D25\u3002";
        message.style.color = "var(--error)";
        message.classList.remove("hidden");
      }
      return null;
    }).finally(function() {
      if (checkButton) {
        checkButton.disabled = false;
        checkButton.textContent = "\u68C0\u67E5\u66F4\u65B0";
      }
    });
  }
  function performProviderCliUpdates() {
    var updateButton = document.getElementById("update-provider-clis");
    var checkButton = document.getElementById("check-provider-cli-updates");
    var message = document.getElementById("provider-cli-update-message");
    if (updateButton) {
      updateButton.disabled = true;
      updateButton.textContent = "\u66F4\u65B0\u4E2D\u2026";
    }
    if (checkButton) checkButton.disabled = true;
    if (message) {
      message.textContent = "\u6B63\u5728\u4F9D\u6B21\u66F4\u65B0 CLI\uFF0C\u8BF7\u52FF\u5173\u95ED\u670D\u52A1\u2026";
      message.style.color = "var(--text-secondary)";
      message.classList.remove("hidden");
    }
    fetch("/api/provider-cli-updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({})
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) throw new Error(data.error);
      renderProviderCliUpdates(data);
      var results = Array.isArray(data.results) ? data.results : [];
      var failures = results.filter(function(item) {
        return !item.ok;
      });
      if (message) {
        message.textContent = results.map(function(item) {
          return item.message;
        }).join(" ") || "\u6CA1\u6709\u9700\u8981\u66F4\u65B0\u7684 CLI\u3002";
        message.style.color = failures.length ? "var(--warning)" : "var(--success)";
      }
    }).catch(function(error) {
      if (message) {
        message.textContent = error && error.message || "CLI \u66F4\u65B0\u5931\u8D25\u3002";
        message.style.color = "var(--error)";
      }
    }).finally(function() {
      if (updateButton) updateButton.disabled = false;
      if (checkButton) checkButton.disabled = false;
    });
  }
  function performUpdate() {
    var msgEl = document.getElementById("update-message");
    var updateBtn = document.getElementById("do-update-button");
    if (!updateBtn) return;
    var originalButtonText = updateBtn.textContent || "\u66F4\u65B0\u5230\u6700\u65B0\u7248";
    var resetUpdateButton = function() {
      updateBtn.disabled = false;
      updateBtn.textContent = originalButtonText;
      updateBtn.removeAttribute("aria-busy");
    };
    updateBtn.disabled = true;
    updateBtn.textContent = "\u66F4\u65B0\u4E2D...";
    updateBtn.setAttribute("aria-busy", "true");
    if (msgEl) {
      msgEl.textContent = "\u6B63\u5728\u66F4\u65B0\uFF0C\u8BF7\u7A0D\u5019...";
      msgEl.style.color = "var(--text-secondary)";
      msgEl.classList.remove("hidden");
    }
    fetch("/api/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin"
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        if (msgEl) {
          msgEl.textContent = data.error;
          msgEl.style.color = "var(--error)";
          msgEl.classList.remove("hidden");
        }
        resetUpdateButton();
        return;
      }
      if (msgEl) {
        msgEl.textContent = (data.message || "\u66F4\u65B0\u5B8C\u6210") + "\uFF0C\u6B63\u5728\u91CD\u542F\u670D\u52A1\u2026";
        msgEl.style.color = "var(--success)";
        msgEl.classList.remove("hidden");
      }
      updateBtn.removeAttribute("aria-busy");
      updateBtn.classList.add("hidden");
      if (data.detachedUpdate) {
        showRestartOverlay(data.previousInstanceId || null, data.version || null);
      } else if (data.restartRequired !== false) {
        performRestart(null, msgEl);
      } else {
        var restartBtn = document.getElementById("do-restart-button");
        if (restartBtn) restartBtn.classList.remove("hidden");
      }
    }).catch(function() {
      if (msgEl) {
        msgEl.textContent = "\u66F4\u65B0\u5931\u8D25\u3002";
        msgEl.style.color = "var(--error)";
        msgEl.classList.remove("hidden");
      }
      resetUpdateButton();
    });
  }
  function performSettingsRestart() {
    var restartBtn = document.getElementById("do-restart-button");
    var msgEl = document.getElementById("update-message");
    performRestart(restartBtn, msgEl);
  }
  function checkApkAutoUpdate() {
    fetch("/api/auto-update", { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(autoData) {
      if (!autoData.apk) return;
      return fetch("/api/android-apk-update?currentVersion=" + encodeURIComponent(_apkVersion), { credentials: "same-origin" }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (!data.updateAvailable || !data.downloadUrl) return;
        try {
          WandNative.downloadUpdate(data.downloadUrl, data.fileName || "wand-update.apk", data.source || "local");
        } catch (_e) {
        }
      });
    }).catch(function() {
    });
  }
  function checkDmgAutoUpdate() {
    if (!_macAppVersion) return;
    fetch("/api/auto-update", { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(function(autoData) {
      if (!autoData.dmg) return;
      return fetch("/api/macos-dmg-update?currentVersion=" + encodeURIComponent(_macAppVersion), { credentials: "same-origin" }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (!data.updateAvailable || !data.downloadUrl) return;
        try {
          WandNative.downloadUpdate(data.downloadUrl, data.fileName || "wand-update.dmg", data.source || "local");
        } catch (_e) {
        }
      });
    }).catch(function() {
    });
  }
  function toggleAutoUpdate(type, enabled) {
    var body = {};
    body[type] = enabled;
    fetch("/api/auto-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      var webToggle = document.getElementById("auto-update-web-toggle");
      var apkToggle = document.getElementById("auto-update-apk-toggle");
      var dmgToggle = document.getElementById("auto-update-dmg-toggle");
      var cliToggle = document.getElementById("auto-update-cli-toggle");
      if (webToggle) webToggle.checked = !!data.web;
      if (apkToggle) apkToggle.checked = !!data.apk;
      if (dmgToggle) dmgToggle.checked = !!data.dmg;
      if (cliToggle) cliToggle.checked = !!data.cli;
    }).catch(function() {
      var toggle = document.getElementById("auto-update-" + type + "-toggle");
      if (toggle) toggle.checked = !enabled;
    });
  }
  function setUpdateChannel(channel) {
    fetch("/api/update-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ channel })
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      var toggle = document.getElementById("beta-channel-toggle");
      if (toggle) toggle.checked = data.channel === "beta";
      checkForUpdate();
    }).catch(function() {
      var toggle = document.getElementById("beta-channel-toggle");
      if (toggle) toggle.checked = channel !== "beta";
    });
  }
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
    var perm = _getNativePermission();
    if (perm === null) {
      if (typeof Notification === "undefined") {
        statusEl.textContent = "\u4E0D\u652F\u6301";
        statusEl.style.color = "var(--fg-muted)";
        if (requestBtn) requestBtn.classList.add("hidden");
        if (resetBtn) resetBtn.classList.add("hidden");
        return;
      }
      perm = Notification.permission;
    }
    if (perm === "granted") {
      statusEl.textContent = "\u5DF2\u6388\u6743 \u2713";
      statusEl.style.color = "var(--success)";
      if (requestBtn) requestBtn.classList.add("hidden");
      if (resetBtn) resetBtn.classList.add("hidden");
    } else if (perm === "denied") {
      statusEl.textContent = "\u5DF2\u62D2\u7EDD";
      statusEl.style.color = "var(--danger)";
      if (requestBtn) requestBtn.classList.add("hidden");
      if (resetBtn) resetBtn.classList.remove("hidden");
    } else {
      statusEl.textContent = "\u672A\u6388\u6743";
      statusEl.style.color = "var(--warning)";
      if (requestBtn) requestBtn.classList.remove("hidden");
      if (resetBtn) resetBtn.classList.remove("hidden");
    }
  }
  function resetNotificationPermission() {
    var testMsgEl = document.getElementById("notification-test-message");
    if (_hasNativeBridge) {
      window._onNativePermissionResult = function(result) {
        updateNotificationStatus();
        if (testMsgEl) {
          if (result === "granted") {
            testMsgEl.textContent = "\u2713 \u5DF2\u6388\u6743";
            testMsgEl.style.color = "var(--success)";
          } else {
            testMsgEl.textContent = "\u2717 \u672A\u6388\u6743\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u5F00\u542F Wand \u7684\u901A\u77E5\u6743\u9650";
            testMsgEl.style.color = "var(--danger)";
          }
          testMsgEl.classList.remove("hidden");
        }
        delete window._onNativePermissionResult;
      };
      try {
        WandNative.requestPermission();
      } catch (_e) {
      }
      return;
    }
    if (typeof Notification === "undefined") return;
    Notification.requestPermission().then(function(result) {
      updateNotificationStatus();
      if (result === "granted") {
        if (testMsgEl) {
          testMsgEl.textContent = "\u2713 \u5DF2\u6388\u6743";
          testMsgEl.style.color = "var(--success)";
          testMsgEl.classList.remove("hidden");
        }
      } else if (result === "denied") {
        if (testMsgEl) {
          var origin = location.origin;
          testMsgEl.innerHTML = '\u6D4F\u89C8\u5668\u5DF2\u62E6\u622A\u6388\u6743\u5F39\u7A97\uFF0C\u8BF7\u624B\u52A8\u91CD\u7F6E\uFF1A<br><span style="display:inline-flex;align-items:center;gap:4px;margin:4px 0">\u2460 \u70B9\u51FB\u5730\u5740\u680F\u5DE6\u4FA7\u7684 <span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--border);font-size:11px;vertical-align:middle">i</span> \u6216\u9501\u56FE\u6807</span><br>\u2461 \u627E\u5230\u300C\u901A\u77E5\u300D\u2192 \u6539\u4E3A\u300C\u5141\u8BB8\u300D<br>\u2462 \u5237\u65B0\u9875\u9762\u5373\u53EF';
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
    delayBtn.textContent = "10 \u79D2\u540E\u53D1\u9001";
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
      delayBtn.textContent = "\u5DF2\u5B89\u6392\uFF0810s\uFF09";
    }
    if (testMsgEl) {
      testMsgEl.innerHTML = "\u5DF2\u5B89\u6392 10 \u79D2\u540E\u53D1\u9001\u6D4B\u8BD5\u901A\u77E5\uFF0C\u8BF7\u5207\u5230\u540E\u53F0\u7B49\u5F85\u3002";
      testMsgEl.style.color = "var(--text-secondary)";
      testMsgEl.classList.remove("hidden");
    }
    state.delayedNotificationTimer = setTimeout(function() {
      state.delayedNotificationTimer = null;
      resetDelayedNotificationButton();
      testNotification();
    }, 1e4);
  }
  function testNotification() {
    var testMsgEl = document.getElementById("notification-test-message");
    var results = [];
    if (state.delayedNotificationTimer) {
      clearTimeout(state.delayedNotificationTimer);
      state.delayedNotificationTimer = null;
      resetDelayedNotificationButton();
    }
    var soundOk = tryPlayNotificationSound();
    results.push(soundOk ? "\u2713 \u63D0\u793A\u97F3" : "\u2717 \u63D0\u793A\u97F3\uFF08\u65E0\u6CD5\u64AD\u653E\uFF09");
    var bubbleEnabled = state.notifBubble;
    showNotificationBubble({
      title: "\u6D4B\u8BD5\u901A\u77E5",
      body: "\u8FD9\u662F\u4E00\u6761\u6D4B\u8BD5\u901A\u77E5\u3002",
      type: "info",
      icon: "\u266A",
      duration: 5e3,
      playSound: false
      // sound already played above
    });
    results.push(bubbleEnabled ? "\u2713 \u5E94\u7528\u5185\u6C14\u6CE1" : "\u2013 \u5E94\u7528\u5185\u6C14\u6CE1\uFF08\u5DF2\u5173\u95ED\uFF09");
    if (_hasNativeBridge) {
      var nativePerm = _getNativePermission();
      if (nativePerm === "granted") {
        try {
          WandNative.sendNotification("Wand \u6D4B\u8BD5\u901A\u77E5", "\u7CFB\u7EDF\u901A\u77E5\u5DF2\u6B63\u5E38\u5DE5\u4F5C\u3002", "wand-test");
          results.push("\u2713 \u7CFB\u7EDF\u901A\u77E5");
        } catch (_e) {
          results.push("\u2717 \u7CFB\u7EDF\u901A\u77E5\uFF08\u53D1\u9001\u5931\u8D25\uFF09");
        }
      } else if (nativePerm === "denied") {
        results.push("\u2717 \u7CFB\u7EDF\u901A\u77E5\uFF08\u5DF2\u62D2\u7EDD\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09");
      } else {
        window._onNativePermissionResult = function(result) {
          updateNotificationStatus();
          if (result === "granted") {
            try {
              WandNative.sendNotification("Wand \u6D4B\u8BD5\u901A\u77E5", "\u7CFB\u7EDF\u901A\u77E5\u5DF2\u6B63\u5E38\u5DE5\u4F5C\u3002", "wand-test");
              results.push("\u2713 \u7CFB\u7EDF\u901A\u77E5\uFF08\u5DF2\u6388\u6743\uFF09");
            } catch (_e2) {
              results.push("\u2717 \u7CFB\u7EDF\u901A\u77E5\uFF08\u53D1\u9001\u5931\u8D25\uFF09");
            }
          } else {
            results.push("\u2717 \u7CFB\u7EDF\u901A\u77E5\uFF08\u672A\u6388\u6743\uFF09");
          }
          showTestResults(testMsgEl, results);
          delete window._onNativePermissionResult;
        };
        try {
          WandNative.requestPermission();
        } catch (_e) {
        }
        return;
      }
      showTestResults(testMsgEl, results);
      return;
    }
    if (typeof Notification === "undefined") {
      results.push("\u2013 \u7CFB\u7EDF\u901A\u77E5\uFF08\u4E0D\u652F\u6301\uFF09");
      showTestResults(testMsgEl, results);
      return;
    }
    var perm = Notification.permission;
    if (perm === "granted") {
      try {
        var n = new Notification("Wand \u6D4B\u8BD5\u901A\u77E5", {
          body: "\u7CFB\u7EDF\u901A\u77E5\u5DF2\u6B63\u5E38\u5DE5\u4F5C\u3002",
          icon: "/favicon.ico",
          tag: "wand-test"
        });
        setTimeout(function() {
          n.close();
        }, 5e3);
        results.push("\u2713 \u7CFB\u7EDF\u901A\u77E5");
      } catch (_e) {
        results.push("\u2717 \u7CFB\u7EDF\u901A\u77E5\uFF08\u53D1\u9001\u5931\u8D25\uFF0C\u53EF\u80FD\u9700\u8981 HTTPS\uFF09");
      }
      showTestResults(testMsgEl, results);
    } else if (perm === "denied") {
      results.push("\u2717 \u7CFB\u7EDF\u901A\u77E5\uFF08\u5DF2\u62D2\u7EDD\uFF09");
      showTestResults(testMsgEl, results);
    } else {
      Notification.requestPermission().then(function(result) {
        updateNotificationStatus();
        if (result === "granted") {
          results.push("\u2713 \u7CFB\u7EDF\u901A\u77E5\uFF08\u5DF2\u6388\u6743\uFF09");
        } else {
          results.push("\u2717 \u7CFB\u7EDF\u901A\u77E5\uFF08\u672A\u6388\u6743\uFF09");
        }
        showTestResults(testMsgEl, results);
      });
    }
  }
  function showTestResults(el, results) {
    if (!el) return;
    el.innerHTML = results.map(function(r) {
      return escapeHtml2(r);
    }).join("<br>");
    var allOk = results.every(function(r) {
      return r.indexOf("\u2713") === 0 || r.indexOf("\u2013") === 0;
    });
    el.style.color = allOk ? "var(--success)" : "var(--warning)";
    el.classList.remove("hidden");
  }
  function withTerminalDimensions(body) {
    if (!body || typeof body !== "object") return body;
    if (!state.terminal) return body;
    try {
      if (typeof state.terminal.remeasure === "function") {
        state.terminal.remeasure();
      }
    } catch (e) {
    }
    var cols = state.terminal.cols;
    var rows = state.terminal.rows;
    if (typeof cols === "number" && typeof rows === "number" && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
      body.cols = cols;
      body.rows = rows;
    }
    return body;
  }
  function ensureTerminalReady() {
    if (state.terminal && state.terminal.cols) return Promise.resolve();
    return new Promise(function(resolve) {
      var done = false;
      var settle = function() {
        if (!done) {
          done = true;
          resolve();
        }
      };
      var hardTimeout = setTimeout(settle, 2e3);
      try {
        initTerminal2();
      } catch (e) {
      }
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          if (state.terminal && state.terminal.cols) {
            clearTimeout(hardTimeout);
            settle();
          }
        });
      });
    });
  }
  function quickStartSession() {
    var command = getPreferredTool();
    var defaultCwd = getEffectiveCwd3();
    var defaultMode = getSafeModeForTool(command, state.config && state.config.defaultMode ? state.config.defaultMode : "default");
    state.preferredCommand = command;
    state.chatMode = getSafeModeForTool(command, state.chatMode);
    ensureTerminalReady().then(function() {
      return fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(withTerminalDimensions({ command, provider: command, cwd: defaultCwd, mode: defaultMode, sessionSource: "interactive" }))
      });
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showToast2(data.error, "error");
        return;
      }
      state.selectedId = data.id;
      persistSelectedId();
      state.drafts[data.id] = "";
      resetChatRenderCache2();
      return refreshAll();
    }).then(function() {
      focusInputBox3(true);
    }).catch(function() {
      showToast2("\u65E0\u6CD5\u542F\u52A8\u4F1A\u8BDD\u3002", "error");
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
    hideError2(errorEl);
    var defaultCwd = getEffectiveCwd3();
    var cwd = (cwdEl ? cwdEl.value.trim() : "") || defaultCwd;
    var selectedMode = getSafeModeForTool(command, state.modeValue);
    persistNewSessionDefaults({
      defaultProvider: command,
      defaultSessionKind: sessionKind,
      defaultMode: selectedMode
    });
    if (sessionKind === "structured") {
      startStructuredSessionFromModal(cwd, selectedMode, worktreeEnabled, errorEl);
      return;
    }
    runPtyCommandFromModal(command, cwd, selectedMode, worktreeEnabled, errorEl);
  }
  function startStructuredSessionFromModal(cwd, mode, worktreeEnabled, errorEl) {
    var provider = getProviderKey(state.sessionTool);
    _sessionCreating = true;
    state.modeValue = mode;
    state.chatMode = mode;
    state.sessionTool = provider;
    state.preferredCommand = provider;
    syncComposerModeSelect();
    syncComposerModelSelect(getSelectedSession6());
    return createStructuredSession(void 0, cwd, mode, worktreeEnabled).then(function(data) {
      saveWorkingDir(cwd);
      closeSessionModal();
      dismissDrawerIfOverlay();
      return data;
    }).then(function() {
      focusInputBox3(true);
    }).catch(function(error) {
      showError2(errorEl, error && error.message || "\u65E0\u6CD5\u542F\u52A8\u7ED3\u6784\u5316\u4F1A\u8BDD\uFF0C\u8BF7\u786E\u8BA4 Claude \u5DF2\u6B63\u786E\u5B89\u88C5\u3002");
    }).finally(function() {
      _sessionCreating = false;
    });
  }
  function runPtyCommandFromModal(command, cwd, mode, worktreeEnabled, errorEl) {
    _sessionCreating = true;
    state.modeValue = mode;
    state.chatMode = mode;
    state.sessionTool = command;
    state.preferredCommand = command;
    syncComposerModeSelect();
    ensureTerminalReady().then(function() {
      return fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(withTerminalDimensions({
          command,
          provider: command,
          cwd,
          mode,
          worktreeEnabled,
          sessionSource: "interactive"
        }))
      });
    }).then(function(res) {
      return res.json();
    }).then(function(data) {
      if (data.error) {
        showError2(errorEl, data.error);
        return;
      }
      state.selectedId = data.id;
      persistSelectedId();
      saveWorkingDir(cwd);
      state.drafts[data.id] = "";
      resetChatRenderCache2();
      closeSessionModal();
      dismissDrawerIfOverlay();
      return refreshAll();
    }).then(function() {
      if (state.selectedId) {
        selectSession(state.selectedId);
      } else {
        focusInputBox3(true);
      }
    }).catch(function() {
      showError2(errorEl, command === "codex" ? "\u65E0\u6CD5\u542F\u52A8 Codex \u4F1A\u8BDD\uFF0C\u8BF7\u786E\u8BA4 codex \u5DF2\u6B63\u786E\u5B89\u88C5\u5E76\u53EF\u5728\u7EC8\u7AEF\u4E2D\u6267\u884C\u3002" : command === "opencode" ? "\u65E0\u6CD5\u542F\u52A8 OpenCode \u4F1A\u8BDD\uFF0C\u8BF7\u786E\u8BA4 opencode-ai \u5DF2\u6B63\u786E\u5B89\u88C5\u3002" : "\u65E0\u6CD5\u542F\u52A8 Claude \u4F1A\u8BDD\uFF0C\u8BF7\u786E\u8BA4 Claude \u5DF2\u6B63\u786E\u5B89\u88C5\u3002");
    }).finally(function() {
      _sessionCreating = false;
    });
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
        if (arrow) arrow.textContent = "\u25BC";
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
      if (arrow) arrow.textContent = "\u25B2";
    } else {
      dropdown.classList.add("hidden");
      if (arrow) arrow.textContent = "\u25BC";
    }
  }
  function loadBlankChatCwdDropdown(dropdown) {
    var defaultCwd = getConfigCwd();
    dropdown.innerHTML = '<div class="blank-chat-cwd-loading">\u52A0\u8F7D\u4E2D...</div>';
    fetchRecentPaths(function(items) {
      var html = "";
      var currentDir = state.workingDir || defaultCwd;
      html += '<div class="blank-chat-cwd-item' + (currentDir === defaultCwd ? " active" : "") + '" data-path="' + escapeHtml2(defaultCwd) + '"><span class="blank-chat-cwd-item-label">\u9ED8\u8BA4</span>' + renderTailMarqueePath(defaultCwd, "blank-chat-cwd-item-path") + "</div>";
      if (items.length) {
        var seen = {};
        seen[defaultCwd] = true;
        items.forEach(function(item) {
          if (seen[item.path]) return;
          seen[item.path] = true;
          html += '<div class="blank-chat-cwd-item' + (currentDir === item.path ? " active" : "") + '" data-path="' + escapeHtml2(item.path) + '">' + renderTailMarqueePath(item.path, "blank-chat-cwd-item-path") + "</div>";
        });
      }
      dropdown.innerHTML = html;
      refreshTailMarqueePaths(dropdown);
      dropdown.querySelectorAll(".blank-chat-cwd-item").forEach(function(el) {
        el.addEventListener("click", function(e) {
          e.stopPropagation();
          var path = el.dataset.path;
          state.workingDir = path;
          try {
            localStorage.setItem("wand-working-dir", path);
          } catch (e2) {
          }
          var pathEl = document.getElementById("blank-chat-cwd-path");
          setTailMarqueePathText(pathEl, path);
          dropdown.classList.add("hidden");
          var arrow = document.getElementById("blank-chat-cwd-arrow");
          if (arrow) arrow.textContent = "\u25BC";
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
        return '<button class="recent-path-bubble" data-path="' + escapeHtml2(item.path) + '" title="' + escapeHtml2(item.path) + '">' + renderTailMarqueePath(item.path, "recent-path-bubble-path") + "</button>";
      }).join("");
      refreshTailMarqueePaths(container);
      container.querySelectorAll(".recent-path-bubble").forEach(function(el) {
        el.addEventListener("click", function() {
          var cwdEl = document.getElementById("cwd");
          if (cwdEl) {
            cwdEl.value = el.dataset.path || "";
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
    fetch("/api/path-suggestions?q=" + encodeURIComponent(cwdEl.value.trim()), { credentials: "same-origin" }).then(function(res) {
      return res.json();
    }).then(renderPathSuggestions).catch(hidePathSuggestions);
  }
  function renderPathSuggestions(items) {
    var container = document.getElementById("cwd-suggestions");
    if (!container || !items.length) {
      hidePathSuggestions();
      return;
    }
    container.innerHTML = items.map(function(item) {
      return '<button class="suggestion-item" data-path="' + escapeHtml2(item.path) + '"><strong>' + escapeHtml2(item.name) + "</strong><small>" + renderTailMarqueePath(item.path, "suggestion-item-path") + "</small></button>";
    }).join("");
    refreshTailMarqueePaths(container);
    container.querySelectorAll(".suggestion-item").forEach(function(el) {
      el.addEventListener("click", function() {
        document.getElementById("cwd").value = el.dataset.path || "";
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
      captureTerminalInput2(event);
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
          inputBox.selectionStart = start + 1;
          inputBox.selectionEnd = start + 1;
          setDraftValue(newValue, true);
          autoResizeInput(inputBox);
        }
        return;
      }
      event.preventDefault();
      var interruptShortcut = !!(event.metaKey || event.ctrlKey);
      sendInputFromBox(interruptShortcut ? { interrupt: true } : void 0);
      return;
    }
    if (event.key === "Backspace") {
      setTimeout(function() {
        var inputBox3 = document.getElementById("input-box");
        if (inputBox3) {
          setDraftValue(inputBox3.value, true);
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
      var escSess = getSelectedSession6();
      if (isStructuredSession2(escSess)) {
        if (escSess && escSess.structuredState && escSess.structuredState.inFlight) {
          stopSession();
        }
      } else {
        queueDirectInput4(getControlInput("escape"), "escape");
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      var inputBoxC = document.getElementById("input-box");
      var hasSelectionC = inputBoxC && inputBoxC.selectionStart !== inputBoxC.selectionEnd || hasActiveTerminalSelection();
      if (hasSelectionC) {
        return;
      }
      var ccSess = getSelectedSession6();
      if (isStructuredSession2(ccSess)) {
        event.preventDefault();
        if (ccSess && ccSess.structuredState && ccSess.structuredState.inFlight) {
          stopSession();
        }
        return;
      }
      event.preventDefault();
      queueDirectInput4(getControlInput("ctrl_c"), "ctrl_c");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      var inputBox2 = document.getElementById("input-box");
      var hasSelection2 = inputBox2 && inputBox2.selectionStart !== inputBox2.selectionEnd || hasActiveTerminalSelection();
      if (hasSelection2) {
        return;
      }
      var cdSess = getSelectedSession6();
      if (isStructuredSession2(cdSess)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      queueDirectInput4(getControlInput("ctrl_d"), "ctrl_d");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      var clSess = getSelectedSession6();
      if (isStructuredSession2(clSess)) {
        return;
      }
      queueDirectInput4(getControlInput("ctrl_l"), "ctrl_l");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "x") {
      var inputBox = document.getElementById("input-box");
      var hasSelection = inputBox && inputBox.selectionStart !== inputBox.selectionEnd;
      if (hasSelection) {
        return;
      }
      event.preventDefault();
      queueDirectInput4(String.fromCharCode(24), "ctrl_x");
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      setTimeout(function() {
        var inputBox3 = document.getElementById("input-box");
        if (inputBox3) {
          setDraftValue(inputBox3.value);
        }
      }, 0);
    }
  }
  var ATTACH_MAX_SIZE = 10 * 1024 * 1024;
  function formatFileSize2(bytes) {
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
      showToast2("\u6587\u4EF6\u8FC7\u5927\uFF08\u4E0A\u9650 10 MB\uFF09: " + file.name, "error");
      return;
    }
    var entry = { file, name: file.name, size: file.size, previewUrl: null };
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
      var thumb = a.previewUrl ? '<img src="' + escapeHtml2(a.previewUrl) + '" alt="">' : '<span class="att-icon">' + iconSvg("file", { size: 13, strokeWidth: 1.7 }) + "</span>";
      html += '<span class="attachment-pill" data-index="' + i + '">' + thumb + '<span class="att-name" title="' + escapeHtml2(a.name) + '">' + escapeHtml2(a.name) + '</span><span class="att-size">' + formatFileSize2(a.size) + '</span><button class="att-remove" data-index="' + i + '" title="\u79FB\u9664">\xD7</button></span>';
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
      if (!resp.ok) return resp.json().then(function(e) {
        throw new Error(e.error || "\u4E0A\u4F20\u5931\u8D25");
      });
      return resp.json();
    }).then(function(data) {
      return data.files || [];
    });
  }
  function buildAttachmentPrefix(uploadedFiles) {
    if (!uploadedFiles || !uploadedFiles.length) return "";
    var paths = uploadedFiles.map(function(f) {
      return f.savedPath;
    });
    return "[\u9644\u4EF6\u5DF2\u4E0A\u4F20\uFF0C\u8BF7\u67E5\u770B\u4EE5\u4E0B\u6587\u4EF6:\n" + paths.join("\n") + "]\n\n";
  }
  function handleInteractiveTextInput(inputBox) {
    if (!state.terminalInteractive || !inputBox) return false;
    if (document.documentElement.classList.contains("is-wand-embed-terminal")) return false;
    var value = inputBox.value || "";
    if (!value) return false;
    queueDirectInput4(value, "interactive_text").catch(function() {
    });
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
      queueDirectInput4(pasted, "paste").catch(function() {
      });
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
    queueDirectInput4(text);
    setDraftValue(getDraftValue() + text);
  }
  function getDraftValue() {
    if (state.selectedId) {
      if (state.drafts[state.selectedId] !== void 0) {
        return state.drafts[state.selectedId];
      }
      try {
        var saved = localStorage.getItem("wand-draft-" + state.selectedId);
        if (saved) return saved;
      } catch (e) {
      }
    }
    return "";
  }
  function setDraftValue(value, skipDom) {
    if (!state.selectedId) return;
    state.drafts[state.selectedId] = value;
    try {
      localStorage.setItem("wand-draft-" + state.selectedId, value);
    } catch (e) {
    }
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
      if (typeof showToast2 === "function") showToast2("\u8BF7\u5148\u8F93\u5165\u8981\u4F18\u5316\u7684\u5185\u5BB9\u3002", "info");
      inputBox.focus();
      return;
    }
    promptOptimizeInFlight = true;
    if (btn) {
      btn.classList.add("is-loading");
      btn.disabled = true;
      btn.setAttribute("title", "\u6B63\u5728\u4F18\u5316\u2026");
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
    }).then(function(res) {
      return res.json().then(function(data) {
        return { ok: res.ok, data };
      });
    }).then(function(result) {
      if (!result.ok) throw new Error(result.data && result.data.error || "\u63D0\u793A\u8BCD\u4F18\u5316\u5931\u8D25\u3002");
      var optimized = result.data && result.data.optimized || "";
      if (!optimized) throw new Error("Claude \u8FD4\u56DE\u4E3A\u7A7A\u3002");
      animateOptimizedReplace(inputBox, optimized);
    }).catch(function(error) {
      if (typeof showToast2 === "function") showToast2(error && error.message || "\u63D0\u793A\u8BCD\u4F18\u5316\u5931\u8D25\u3002", "error");
      if (btn) {
        btn.classList.remove("is-loading");
        btn.classList.add("is-shake");
        setTimeout(function() {
          if (btn) btn.classList.remove("is-shake");
        }, 400);
      }
    }).finally(function() {
      promptOptimizeInFlight = false;
      if (btn) {
        btn.classList.remove("is-loading");
        btn.disabled = false;
        btn.setAttribute("title", "\u63D0\u793A\u8BCD\u4F18\u5316\uFF08AI\uFF09");
      }
      if (composer) composer.classList.remove("is-optimizing");
      inputBox.removeAttribute("aria-busy");
      inputBox.readOnly = prevReadOnly;
    });
  }
  function animateOptimizedReplace(inputBox, finalText) {
    if (!inputBox) return;
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
        try {
          inputBox.setSelectionRange(finalText.length, finalText.length);
        } catch (e) {
        }
      }
    }
    tick();
  }
  function syncComposerHasText(el) {
    var composer = document.querySelector(".input-composer");
    if (!composer) return;
    var inputBox = el || document.getElementById("input-box");
    var hasText = !!(inputBox && inputBox.value && inputBox.value.length > 0);
    composer.classList.toggle("has-text", hasText);
  }

  // src/web-ui/browser/utils.ts
  state._statusBarTimerId = null;
  state._statusBarStartTime = 0;
  var _runningIndicatorsTimerId = null;
  var _runningIndicatorsStartTime = 0;
  function computeRunningSignal2(session) {
    if (!session) return { active: false };
    if (session.archived) return { active: false };
    var permBlocked = !!session.permissionBlocked;
    var inFlight = !!(isStructuredSession2(session) && session.structuredState && session.structuredState.inFlight);
    var ptyRunning = !isStructuredSession2(session) && session.status === "running";
    return {
      active: inFlight || ptyRunning || permBlocked,
      inFlight,
      ptyRunning,
      permissionBlocked: permBlocked
    };
  }
  function formatElapsedShort3(ms) {
    var s = Math.max(0, Math.floor(ms / 1e3));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    var rs = s % 60;
    if (m < 60) return m + "m" + (rs ? " " + rs + "s" : "");
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return h + "h" + (rm ? " " + rm + "m" : "");
  }
  function updateRunningIndicators(session) {
    var sig = computeRunningSignal2(session);
    var headerRow = document.querySelector(".main-header-row");
    var pill = headerRow ? headerRow.querySelector(".session-status-pill") : null;
    var chatMessages = document.querySelector(".chat-messages");
    if (headerRow) {
      headerRow.classList.toggle("is-running", sig.active);
      headerRow.classList.toggle("is-permission-blocked", sig.permissionBlocked);
    }
    if (pill) {
      var elapsedEl = pill.querySelector(".session-status-elapsed");
      if (sig.inFlight) {
        if (!_runningIndicatorsStartTime) {
          _runningIndicatorsStartTime = state._statusBarStartTime > 0 ? state._statusBarStartTime : Date.now();
        }
        var label = formatElapsedShort3(Date.now() - _runningIndicatorsStartTime);
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
    if (sig.active) {
      if (!_runningIndicatorsTimerId) {
        _runningIndicatorsTimerId = setInterval(function() {
          var sel = state.sessions.find(function(s) {
            return s.id === state.selectedId;
          });
          updateRunningIndicators(sel);
        }, 1e3);
      }
    } else if (_runningIndicatorsTimerId) {
      clearInterval(_runningIndicatorsTimerId);
      _runningIndicatorsTimerId = null;
    }
  }
  function renderStructuredStatusBar(chatMessages, session) {
    updateRunningIndicators(session);
    var topRow = document.querySelector(".composer-top-row");
    var existing = document.querySelector(".structured-status-bar");
    var composer = document.querySelector(".input-composer");
    if (!session || !isStructuredSession2(session)) {
      if (existing) existing.remove();
      if (composer) composer.classList.remove("in-flight");
      clearInterval(state._statusBarTimerId);
      state._statusBarTimerId = null;
      return;
    }
    var isInFlight = session.structuredState && session.structuredState.inFlight;
    if (isInFlight) {
      if (!state._statusBarTimerId) {
        state._statusBarStartTime = Date.now();
      }
      if (composer) composer.classList.add("in-flight");
      if (!existing && topRow) {
        var bar = document.createElement("div");
        bar.className = "structured-status-bar";
        bar.innerHTML = '<span class="status-bar-dot"></span><span class="status-bar-label">\u56DE\u590D\u4E2D</span><span class="status-bar-timer">0.0s</span>';
        topRow.appendChild(bar);
        existing = bar;
      } else if (existing && existing.classList.contains("completed")) {
        existing.classList.remove("completed");
        existing.style.animation = "none";
        existing.querySelector(".status-bar-label").textContent = "\u56DE\u590D\u4E2D";
        var dot = existing.querySelector(".status-bar-dot");
        if (dot) dot.style.display = "";
        state._statusBarStartTime = Date.now();
      }
      if (!state._statusBarTimerId) {
        state._statusBarTimerId = setInterval(function() {
          var bar2 = document.querySelector(".structured-status-bar:not(.completed)");
          if (!bar2) {
            clearInterval(state._statusBarTimerId);
            state._statusBarTimerId = null;
            return;
          }
          var elapsed2 = ((Date.now() - state._statusBarStartTime) / 1e3).toFixed(1);
          var timerEl = bar2.querySelector(".status-bar-timer");
          if (timerEl) timerEl.textContent = elapsed2 + "s";
        }, 100);
      }
    } else {
      clearInterval(state._statusBarTimerId);
      state._statusBarTimerId = null;
      if (composer) composer.classList.remove("in-flight");
      if (existing && !existing.classList.contains("completed")) {
        var elapsed = state._statusBarStartTime ? ((Date.now() - state._statusBarStartTime) / 1e3).toFixed(1) : "0.0";
        existing.classList.add("completed");
        existing.querySelector(".status-bar-label").textContent = "\u5B8C\u6210";
        existing.querySelector(".status-bar-timer").textContent = elapsed + "s";
        var dot = existing.querySelector(".status-bar-dot");
        if (dot) dot.style.display = "none";
        state._statusBarStartTime = 0;
        setTimeout(function() {
          if (existing.parentNode) existing.remove();
        }, 3e3);
      }
    }
  }
  function escapeHtml2(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function renderTailMarqueePath(value, className, attrs) {
    var text = String(value || "");
    return '<span class="' + className + ' tail-marquee-path" title="' + escapeHtml2(text) + '"' + (attrs || "") + '><span class="tail-marquee-path-inner">' + escapeHtml2(text) + "</span></span>";
  }
  var IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|heic|heif)$/i;
  function isImagePath(value) {
    if (typeof value !== "string") return false;
    var clean = value.trim().split(/[?#]/)[0];
    return IMAGE_PATH_RE.test(clean);
  }
  function scrollPathElementToEnd(el) {
    if (!el) return;
    var apply = function() {
      try {
        var inner = el.firstElementChild && el.firstElementChild.classList && el.firstElementChild.classList.contains("tail-marquee-path-inner") ? el.firstElementChild : null;
        if (inner) {
          var overflow = Math.max(0, inner.scrollWidth - el.clientWidth);
          el.classList.toggle("is-overflowing", overflow > 1);
          el.style.setProperty("--tail-marquee-shift", overflow + "px");
          var travelSeconds = Math.max(4.8, overflow / 18);
          el.style.setProperty("--tail-marquee-duration", Math.max(6.8, travelSeconds / 0.68) + "s");
          return;
        }
        if (el.scrollWidth > el.clientWidth) {
          el.scrollLeft = el.scrollWidth;
        }
      } catch (e) {
      }
    };
    apply();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(apply);
    }
  }
  function refreshTailMarqueePaths(root) {
    var scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    scope.querySelectorAll(".tail-marquee-path").forEach(function(el) {
      scrollPathElementToEnd(el);
    });
  }
  function setTailMarqueePathText(el, value) {
    if (!el) return;
    var text = String(value || "");
    var inner = el.querySelector && el.querySelector(".tail-marquee-path-inner");
    if (inner) inner.textContent = text;
    else el.textContent = text;
    if (el.setAttribute) el.setAttribute("title", text);
    scrollPathElementToEnd(el);
  }
  function scrollInputToEnd(input) {
    if (!input) return;
    var apply = function() {
      try {
        if (typeof input.setSelectionRange === "function" && input.value != null) {
          var len = input.value.length;
          try {
            input.setSelectionRange(len, len);
          } catch (e) {
          }
        }
        if (input.scrollWidth > input.clientWidth) {
          input.scrollLeft = input.scrollWidth;
        }
      } catch (e) {
      }
    };
    apply();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(apply);
    }
  }

  // src/web-ui/browser/main.ts
  (function() {
    try {
      var ua = navigator && navigator.userAgent || "";
      if (/WandApp\//.test(ua)) {
        document.documentElement.classList.add("is-wand-app");
      }
      if (/WandPlatform\/iOS/.test(ua)) {
        document.documentElement.classList.add("is-wand-ios");
      }
      if (/WandPlatform\/Android/.test(ua)) {
        document.documentElement.classList.add("is-wand-android");
      }
    } catch (e) {
    }
    try {
      const params = new URL(window.location.href).searchParams;
      if (params.get("embed") === "terminal") {
        document.documentElement.classList.add("is-wand-embed-terminal");
        if (params.get("nativeInput") === "1") {
          document.documentElement.classList.add("is-wand-native-input");
        }
      }
    } catch (e) {
    }
    try {
      window.__wandNativeBackHooked = true;
    } catch (e) {
    }
  })();
})();
