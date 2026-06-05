import { state } from "./state";
import { iconSvg, t } from "./i18n";
import { isStructuredSession } from "./session-engine";

// isStructuredSession 定义在尚未迁移的代码区域，这里声明供本模块使用。
// 后续迁移该函数时，改为从对应模块 import。

// ── Structured session status bar (in-flight timer) ──
state._statusBarTimerId = null;
state._statusBarStartTime = 0;
export var _runningIndicatorsTimerId: any = null;
export var _runningIndicatorsStartTime = 0;

// 计算会话整体的"在跑"信号，统一驱动顶部进度条/徽章计时/气泡呼吸条。
export function computeRunningSignal(session: any) {
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

export function formatElapsedShort(ms: number) {
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
export function updateRunningIndicators(session: any) {
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
        _runningIndicatorsStartTime = state._statusBarStartTime > 0 ? state._statusBarStartTime : Date.now();
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
        var sel = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
        updateRunningIndicators(sel);
      }, 1000);
    }
  } else if (_runningIndicatorsTimerId) {
    clearInterval(_runningIndicatorsTimerId);
    _runningIndicatorsTimerId = null;
  }
}

export function renderStructuredStatusBar(chatMessages: any, session: any) {
  // 先驱动跨视图的运行指示器（顶部进度条/徽章计时/气泡呼吸条）
  updateRunningIndicators(session);

  // Status bar now lives in .composer-top-row alongside the todo-progress collapse bar
  var topRow = document.querySelector(".composer-top-row");
  var existing = document.querySelector(".structured-status-bar");
  var composer = document.querySelector(".input-composer");
  if (!session || !isStructuredSession(session)) {
    if (existing) existing.remove();
    if (composer) composer.classList.remove("in-flight");
    clearInterval(state._statusBarTimerId);
    state._statusBarTimerId = null;
    return;
  }

  var isInFlight = session.structuredState && session.structuredState.inFlight;

  if (isInFlight) {
    // Start timer if not already running
    if (!state._statusBarTimerId) {
      state._statusBarStartTime = Date.now();
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
      (existing as HTMLElement).style.animation = "none";
      existing.querySelector(".status-bar-label")!.textContent = "回复中";
      var dot = existing.querySelector(".status-bar-dot") as HTMLElement;
      if (dot) dot.style.display = "";
      state._statusBarStartTime = Date.now();
    }

    // Start interval to update timer
    if (!state._statusBarTimerId) {
      state._statusBarTimerId = setInterval(function() {
        var bar = document.querySelector(".structured-status-bar:not(.completed)");
        if (!bar) { clearInterval(state._statusBarTimerId); state._statusBarTimerId = null; return; }
        var elapsed = ((Date.now() - state._statusBarStartTime) / 1000).toFixed(1);
        var timerEl = bar.querySelector(".status-bar-timer");
        if (timerEl) timerEl.textContent = elapsed + "s";
      }, 100);
    }
  } else {
    // Not in-flight: show completion or remove
    clearInterval(state._statusBarTimerId);
    state._statusBarTimerId = null;

    // Remove glow from input composer
    if (composer) composer.classList.remove("in-flight");

    if (existing && !existing.classList.contains("completed")) {
      // Just finished — transition to completed state
      var elapsed = state._statusBarStartTime ? ((Date.now() - state._statusBarStartTime) / 1000).toFixed(1) : "0.0";
      existing.classList.add("completed");
      existing.querySelector(".status-bar-label")!.textContent = "完成";
      existing.querySelector(".status-bar-timer")!.textContent = elapsed + "s";
      var dot = existing.querySelector(".status-bar-dot") as HTMLElement;
      if (dot) dot.style.display = "none";
      state._statusBarStartTime = 0;
      // Remove after animation ends
      setTimeout(function() {
        if (existing!.parentNode) existing!.remove();
      }, 3000);
    }
  }
}

export function escapeHtml(value: any) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
