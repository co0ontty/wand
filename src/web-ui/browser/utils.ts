import { state } from "./state";
import "./i18n";
import { isStructuredSession } from "./session-engine";
import { escapeHtml } from "./text-escape";
import { turnStartedAtMs } from "../running-activity.js";
import { setTodoProgressExpanded } from "./todo-view-adapter.js";

export { escapeHtml };
export { computeRunningSignal } from "../session-activity";

// isStructuredSession 定义在尚未迁移的代码区域，这里声明供本模块使用。
// 后续迁移该函数时，改为从对应模块 import。

// ── Structured session status bar (in-flight timer) ──
state._statusBarTimerId = null;
state._statusBarStartTime = 0;
// Session changes retire the open projection before the next snapshot paints.
export function collapseTodoProgress(): void {
  setTodoProgressExpanded(false);
  document.getElementById("todo-progress")?.classList.add("hidden");
}

export function renderStructuredStatusBar(chatMessages: any, session: any) {

  // Keep the existing status/timer owner in the companion statistics row.
  var topRow = document.querySelector("[data-composer-running-host]");
  var existing = document.querySelector(".structured-status-bar");
  var composer = document.querySelector(".input-composer");
  if (existing && topRow && existing.parentElement !== topRow) topRow.appendChild(existing);
  if (!session || !isStructuredSession(session)) {
    if (existing) existing.remove();
    if (composer) composer.classList.remove("in-flight");
    clearInterval(state._statusBarTimerId);
    state._statusBarTimerId = null;
    return;
  }

  var isInFlight = session.structuredState && session.structuredState.inFlight;
  var inFlightLabel = session.structuredState && session.structuredState.phase === "background"
    ? "后台任务中"
    : "回复中";

  if (isInFlight) {
    // Refresh/reconnect must retain the server's turn clock. Missing anchors
    // show the phase alone rather than inventing a duration from page mount.
    var startedAt = turnStartedAtMs(session);
    state._statusBarStartTime = startedAt ?? 0;

    // Add glow to input composer
    if (composer) composer.classList.add("in-flight");

    if (!existing && topRow) {
      var bar = document.createElement("div");
      bar.className = "structured-status-bar";
      bar.innerHTML =
        '<span class="status-bar-dot"></span>' +
        '<span class="status-bar-label">' + inFlightLabel + '</span>' +
        '<span class="status-bar-timer">0.0s</span>';
      // Native status children stay in their dedicated React host.
      topRow.appendChild(bar);
      existing = bar;
    } else if (existing && existing.classList.contains("completed")) {
      // Was completed, now in-flight again — reset
      existing.classList.remove("completed");
      (existing as HTMLElement).style.animation = "none";
      existing.querySelector(".status-bar-label")!.textContent = inFlightLabel;
      var dot = existing.querySelector(".status-bar-dot") as HTMLElement;
      if (dot) dot.style.display = "";
    }
    var activeLabel = existing && existing.querySelector(".status-bar-label");
    if (activeLabel) activeLabel.textContent = inFlightLabel;
    var activeTimer = existing && existing.querySelector<HTMLElement>(".status-bar-timer");
    if (activeTimer) {
      activeTimer.hidden = startedAt === null;
      if (startedAt !== null) activeTimer.textContent = (Math.max(0, Date.now() - startedAt) / 1000).toFixed(1) + "s";
    }
    if (startedAt === null) {
      clearInterval(state._statusBarTimerId);
      state._statusBarTimerId = null;
    }

    // Start interval to update timer
    if (!state._statusBarTimerId && startedAt !== null) {
      state._statusBarTimerId = setInterval(function() {
        var bar = document.querySelector(".structured-status-bar:not(.completed)");
        if (!bar) { clearInterval(state._statusBarTimerId); state._statusBarTimerId = null; return; }
        var elapsed = (Math.max(0, Date.now() - state._statusBarStartTime) / 1000).toFixed(1);
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
      var finishedAt = new Date();
      var pad = function(n: number) { return n < 10 ? "0" + n : String(n); };
      var clock = pad(finishedAt.getHours()) + ":" + pad(finishedAt.getMinutes()) + ":" + pad(finishedAt.getSeconds());
      var timerEl = existing.querySelector(".status-bar-timer") as HTMLElement | null;
      if (timerEl) {
        timerEl.hidden = false;
        timerEl.textContent = clock;
        timerEl.title = "耗时 " + elapsed + "s";
      }
      var dot = existing.querySelector(".status-bar-dot") as HTMLElement;
      if (dot) dot.style.display = "none";
      state._statusBarStartTime = 0;
      // Remove after animation ends
      setTimeout(function() {
        if (existing!.classList.contains("completed") && existing!.parentNode) existing!.remove();
      }, 3000);
    }
  }
}

export function renderTailMarqueePath(value: any, className: string, attrs?: string) {
  var text = String(value || "");
  var separator = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  var prefix = separator >= 0 ? text.slice(0, separator + 1) : "";
  var leaf = separator >= 0 ? text.slice(separator + 1) : text;
  return '<span class="' + className + ' tail-marquee-path" title="' + escapeHtml(text) + '"' + (attrs || "") + '>' +
    '<span class="tail-marquee-path-inner"><span class="tail-marquee-prefix">' + escapeHtml(prefix) + '</span>' +
      '<span class="tail-marquee-leaf">' + escapeHtml(leaf) + '</span></span>' +
  '</span>';
}

// 是否是浏览器可内联渲染的图片路径。和服务端 IMAGE_EXTS（src/server.ts）
// 保持一致：Read 工具读到这些后缀时，聊天里直出缩略图预览。
var IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|heic|heif)$/i;

export function isImagePath(value: any) {
  if (typeof value !== "string") return false;
  // 去掉可能的 ?query / #hash 再判后缀
  var clean = value.trim().split(/[?#]/)[0];
  return IMAGE_PATH_RE.test(clean);
}

// ── Path display scroll helpers ──
//
// 长路径展示若直接用 CSS `text-overflow: ellipsis`，会截掉末尾目录名。
//
// 这里把统一行为抽成一个小工具：
//   scrollPathElementToEnd —— 横向 overflow 容器，scrollLeft 推到末尾；
//   对 tail-marquee-path 则测量溢出量并交给 CSS transform 跑马灯。
//
// 调用方更新 path 后调一次即可。

export function scrollPathElementToEnd(el: any) {
  if (!el) return;
  // 容器可能刚被 setHTML 进来，等浏览器把布局跑完再算 scrollWidth
  var apply = function() {
    try {
      var inner = el.firstElementChild && el.firstElementChild.classList && el.firstElementChild.classList.contains("tail-marquee-path-inner")
        ? el.firstElementChild
        : null;
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
    } catch (e) { /* read-only scroll container 等 */ }
  };
  apply();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(apply);
  }
}

export function refreshTailMarqueePaths(root?: any) {
  var scope = root || document;
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll(".tail-marquee-path").forEach(function(el: any) {
    scrollPathElementToEnd(el);
  });
}
