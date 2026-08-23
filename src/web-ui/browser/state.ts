import type { AppState } from "./types";

export var configPath = "${escapeHtml(configPath)}";
export var CHAT_EXPAND_STATE_STORAGE_KEY = "wand-chat-expand-state-v1";

// ===== 一次性 localStorage 迁移 =====
// 用 schema 版本号确保每个 migration 只跑一次。每加一项就 ++LS_SCHEMA_VERSION
// 并在 LS_MIGRATIONS append 一个函数。已升级用户的 wand-ls-schema 大于等于
// 当前长度时整段跳过；新用户首次加载会一口气把所有 migration 都跑完再写
// schema 号 —— 因此每个 migration 函数对「key 不存在」的输入也必须是无害的。
var LS_MIGRATIONS = [
  // v1 保留为 no-op：曾经这里会删除 wand-sidebar-pinned，导致升级或刷新时
  // 覆盖用户明确选择的侧栏状态。迁移函数必须只修正格式，不能抹掉偏好。
  function migrateSidebarPinDefault() {
  },
  // v2: desktop sidebar now has two states only: full (default) and compact.
  // Clear the removed temporary/closed state once, while later user toggles
  // continue to persist the compact preference normally.
  function migrateSidebarToFullDefault() {
    localStorage.setItem("wand-sidebar-pinned", "true");
    localStorage.setItem("wand-sidebar-collapsed", "false");
  },
];
(function runLocalStorageMigrations() {
  try {
    var raw = localStorage.getItem("wand-ls-schema");
    var applied = raw == null ? 0 : parseInt(raw, 10);
    if (!(applied >= 0)) applied = 0;
    for (var i = applied; i < LS_MIGRATIONS.length; i++) {
      try { LS_MIGRATIONS[i](); } catch (e) {}
    }
    if (applied < LS_MIGRATIONS.length) {
      localStorage.setItem("wand-ls-schema", String(LS_MIGRATIONS.length));
    }
  } catch (e) { /* localStorage 不可用就跳过，按默认行为运行 */ }
})();

export function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  try {
    var value = localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
    return defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

export function writeStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(!!value));
  } catch (e) {}
}

export var state: AppState = {
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
    } catch (e) {}
    try { return localStorage.getItem("wand-selected-session") || null; } catch (e) { return null; }
  })(),
  activeWorkspaceId: (function() {
    try { return localStorage.getItem("wand-active-workspace") || null; } catch (e) { return null; }
  })(),
  activeWorkspaceTaskId: null,
  pollTimer: null,
  config: null,
  sessions: [],
  terminal: null,
  terminalFitAddon: null,
  terminalWriteQueue: Promise.resolve(),
  terminalRestoreGeneration: 0,
  // WS init can arrive before xterm finishes loading fonts/opening its DOM.
  // Keep the authoritative emulator snapshot outside the replaceable session
  // list so a concurrent /api/sessions refresh cannot lose it.
  terminalStatesBySession: {},
  terminalFitInProgress: false,
  terminalSessionId: null,
  terminalOutput: "",
  terminalLiveStreamSessions: {},
  lastChunkAt: 0,
  terminalHealthTimer: null,
  terminalAutoFollow: true,
  // Ignore scroll events caused by our own scroll-to-bottom operation.
  terminalProgrammaticScrollUntil: 0,
  terminalScrollThreshold: 12,
  showTerminalJumpToBottom: false,
  terminalViewportEl: null,
  terminalViewportScrollHandler: null,
  terminalViewportTouchHandler: null,
  terminalViewportTouchStartHandler: null,
  terminalTouchStartY: 0,
  terminalComposing: false,
  // Safari / WKWebView may report the Enter key used to confirm an IME
  // candidate after compositionend with isComposing=false. Keep a composer-
  // level guard alive through the rest of that event loop so the confirmation
  // keystroke can never fall through to message submission.
  composerComposing: false,
  composerCompositionGeneration: 0,
  composerCompositionTarget: null,
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
  // Attachments are composer state, so they must follow the same per-session
  // isolation as drafts. File objects cannot be persisted across reloads, but
  // they do survive in-memory session switches.
  attachmentsBySession: {},
  // Active composer submissions are keyed by session and fingerprint. A
  // second gesture for the same captured payload reuses the first submission,
  // while a newly typed payload can still enter the structured-session queue.
  composerSubmissionsBySession: {},
  // Prompt optimization is global because the backing system-AI request is
  // shared. The session id keeps only the owning composer read-only while a
  // response may safely finish in the background after a session switch.
  promptOptimizeRequest: null,
  isSyncingInputBox: false,
  loginPending: false,
  loginChecked: false,
  bootstrapping: true,
  sessionsDrawerOpen: readStoredBoolean("wand-sidebar-open", false),
  // 桌面仅保留完整 / 窄栏两态，完整侧栏为默认状态。
  sidebarPinned: readStoredBoolean("wand-sidebar-pinned", true),
  sidebarCollapsed: readStoredBoolean("wand-sidebar-collapsed", false),
  modeValue: "managed",
  chatMode: "managed",
  chatModels: (function() {
    try {
      var legacy = localStorage.getItem("wand-chat-model") || "";
      return {
        claude: localStorage.getItem("wand-chat-model-claude") || legacy,
        codex: localStorage.getItem("wand-chat-model-codex") || "",
        opencode: localStorage.getItem("wand-chat-model-opencode") || "",
        grok: localStorage.getItem("wand-chat-model-grok") || "",
        qoder: localStorage.getItem("wand-chat-model-qoder") || "",
      };
    } catch (e) {
      return { claude: "", codex: "", opencode: "", grok: "", qoder: "" };
    }
  })(),
  chatModel: (function() {
    try { return localStorage.getItem("wand-chat-model") || ""; } catch (e) { return ""; }
  })(),
  chatThinking: (function() {
    try {
      var v = localStorage.getItem("wand-thinking-effort") || "off";
      return (v === "off" || v === "standard" || v === "deep" || v === "max" || /^codex:[a-z0-9][a-z0-9_-]{0,31}$/.test(v)) ? v : "off";
    } catch (e) { return "off"; }
  })(),
  availableModels: [],
  availableCodexModels: [],
  availableOpenCodeModels: [],
  availableGrokModels: [],
  availableQoderModels: [],
  availablePiModels: [],
  modelsRefreshing: false,
  sessionTool: "claude",
  preferredCommand: "claude",
  structuredRunner: "claude-cli-print",
  claudeSkillsByCwd: {},
  selectedClaudeSkillsBySession: {},
  claudeSkillsLoadingByCwd: {},
  claudeSkillsPickerOpen: false,
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
  currentTask: null, // Current task title from Claude
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
  joystickPinnedOpen: false,      // 钉住面板是否展开（不持久化，切会话复位）
  joystickRootEl: null,           // 以下均为运行期句柄，teardown 复位
  joystickPanelEl: null,
  joystickBackdropEl: null,
  joystickBallEl: null,
  joystickPointerId: null,
  joystickGesture: null,          // null|'pending'|'cancelled'|'move'
  joystickPressStart: null,       // {x, y, t}
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
  askUserSelections: {},  // { toolUseId: { 0: [optIdx...], submitted: false } }
  queueEpoch: 0,  // Monotonic counter for queue state freshness
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

// Hydrate the initially selected session before the first render. Subsequent
// sessions are loaded lazily by getDraftValueForSession().
if (state.selectedId) {
  try {
    var initialDraft = localStorage.getItem("wand-draft-" + state.selectedId);
    if (initialDraft !== null) state.drafts[state.selectedId] = initialDraft;
  } catch (e) { /* localStorage unavailable */ }
}
