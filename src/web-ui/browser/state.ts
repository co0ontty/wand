import type { AppState } from "./types";
import { t } from "./i18n";
import { resetChatRenderCache } from "./render";
import { escapeHtml } from "./utils";
import { evaluateWsHeartbeatStale } from "./websocket";

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
  }
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
        opencode: localStorage.getItem("wand-chat-model-opencode") || "",
      };
    } catch (e) {
      return { claude: "", codex: "", opencode: "" };
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
