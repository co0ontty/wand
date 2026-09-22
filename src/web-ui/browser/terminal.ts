import { state } from "./state";
import "./utils";
import "./chat-render";
import "./file-browser";
import { parseJsonResponse } from "../react/http-adapter";
import { getErrorMessage } from "../../error-utils.js";
import { focusInputBox, hasActiveTerminalSelection, installNativeInputImeGuard, lockNativeInputTerminalIme, shouldLockNativeInputTerminalIme } from "./input";
import { showToast } from "./notifications";
import "./render";
import { copyToClipboard, isStructuredSession } from "./session-engine";
import { ensureTerminalFit, initTerminalJoystick, initTerminalResizeHandle, observeTerminalResize, sendTerminalResize, startTerminalHealthCheck } from "./viewport";
import { fitTerminalToContainer } from "./terminal-fit";
import "./i18n";
import { consumeTerminalTouchPage, consumeTerminalWheelLines, consumeTerminalWheelPage, terminalWheelPageSequence, type TerminalTouchPagingState, type TerminalWheelPagingState, type TerminalWheelScrollState } from "./terminal-wheel";
import { openLocalPreviewFromLegacy } from "./local-preview-adapter";

      export function saveWorkingDir(path: string) {
        state.workingDir = path;
        try {
          localStorage.setItem("wand-working-dir", path);
        } catch (e) {
          // Ignore localStorage errors
        }
        addRecentPath(path);
      }

      function addRecentPath(path: string) {
        // 最近路径只是便利记录：失败（含 4xx/5xx）不能影响工作目录切换，
        // 也不能把拒绝写成的响应当成成功，更不能抛未处理异常打断调用方。
        return fetch("/api/recent-paths", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ path: path })
        })
          .then(function(res) { return parseJsonResponse<any>(res); })
          .catch(function(error: unknown) {
            console.warn("[wand] 记录最近路径失败：" + getErrorMessage(error, "未知错误"));
          });
      }

      /** Copy a string field of the currently selected session to clipboard. */
      export function copySelectedSessionField(field: string, successMsg: string) {
        var session = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
        if (!session) return;
        var value = session[field];
        if (!value) {
          showToast("当前会话没有可复制的内容。", "error");
          return;
        }
        copyToClipboard(String(value), null, function() {
          showToast(successMsg || "已复制", "info");
        });
      }

      function getTerminalViewport() {
        if (!state.terminal || !state.terminal.element) return null;
        state.terminalViewportEl = state.terminal.element.querySelector(".xterm-viewport");
        return state.terminalViewportEl;
      }

      export function updateTerminalJumpToBottomButton() {
        var button = document.getElementById("terminal-jump-bottom");
        var shouldShow = !!state.selectedId
          && state.currentView === "terminal"
          && !state.terminalAutoFollow
          // SCROLL-2: 隐藏判据用严格 2px(isTerminalAtBottom) 而非 12px。否则距底
          // 3–12px 区间 autoFollow 恒 false(scroll handler 只在 ≤2px 才恢复)，但
          // 旧的 12px near-bottom 判定为 true，隐藏按钮后会形成既不跟随又无回底入口的死区。
          && !isTerminalAtBottom();
        state.showTerminalJumpToBottom = shouldShow;
        if (button) {
          button.classList.toggle("visible", shouldShow);
        }
        var termContainer = document.getElementById("output");
        if (termContainer) termContainer.classList.toggle("has-jump-btn", shouldShow);
      }

      // 严格"真正到底"判定（仅亚像素 jitter 容忍）：用于把 autoFollow 从 false
      // 翻回 true。不能用旧的 12px near-bottom 阈值，否则用户在底部小幅
      // 向上滚时，wheel handler 把 autoFollow 设 false 后紧接着触发的 scroll
      // 事件会因为"还没滚出阈值"而把 autoFollow 反转回 true，丢失用户意图。
      function isTerminalAtBottom() {
        var viewport = getTerminalViewport();
        if (!viewport) return true;
        var distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        return distance <= 2;
      }

      function scrollTerminalToBottom(smooth?: boolean) {
        if (!state.terminal) return;
        var viewport = getTerminalViewport();
        if (!viewport) return;
        // 打"程序触发滚动"窗口：紧跟着的 scroll 事件是 wand 自己拽出来的，
        // scroll handler 在窗口内跳过 autoFollow 修改，避免"程序拽底 →
        // scroll 事件 → handler 看到在底 → autoFollow=true"的反馈环把
        // 用户刚 wheel 上滚的意图覆盖掉。smooth 模式 Chromium 滚动动画约
        // 300-500ms，瞬时滚动只需覆盖一次 rAF + 事件分发延迟。
        var windowMs = smooth ? 500 : 120;
        state.terminalProgrammaticScrollUntil = Math.max(
          state.terminalProgrammaticScrollUntil,
          Date.now() + windowMs
        );
        if (smooth) {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
        } else {
          state.terminal.scrollToBottom();
        }
      }

      // 用户上滚进入浏览模式后不再自动回底：保持 autoFollow=false，把控制权
      // 交给左下角的「回到底部」按钮——只有用户点按钮才恢复贴底跟随。
      function setTerminalManualScrollActive() {
        state.terminalAutoFollow = false;
        state.terminalProgrammaticScrollUntil = 0;
        updateTerminalJumpToBottomButton();
      }

      export function maybeScrollTerminalToBottom(reason?: string) {
        if (!state.terminal) return;
        var force = reason === "force";
        if (force) {
          state.terminalAutoFollow = true;
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

      /**
       * PTY 分片热路径专用入口：把一帧内的多次“贴底 + 回到底部按钮”合并成一次。
       * 逐分片调用会变成每分片两次 getElementById + 一次读 scrollTop/scrollHeight。
       */
      export function scheduleTerminalChromeUpdate() {
        if (terminalChromeRaf) return;
        var raf = (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function")
          ? window.requestAnimationFrame.bind(window)
          : function(callback: () => void) { return window.setTimeout(callback, 16); };
        terminalChromeRaf = raf(function() {
          terminalChromeRaf = 0;
          maybeScrollTerminalToBottom();
        });
      }

      // ===== Touch scroll (mobile) =====
      // xterm.js ships no touch handler (its bindMouse() only wires
      // mousedown + wheel), so on a touch device the scrollback is unreachable
      // and full-screen TUIs (vim/less/htop) can't be paged. Drive both from a
      // single-finger vertical drag on the terminal surface, mirroring the
      // wheel path: normal buffer scrolls the xterm scrollback pixel-for-pixel
      // (content follows the finger), alternate buffer pages with the
      // touch-specific accumulator or, when the app enabled mouse reporting,
      // a synthesized SGR wheel press at the touched cell. Bound on termWrap,
      // which is recreated on every terminal re-init, so the listeners die
      // with the node — no manual teardown is needed.
      function initTerminalTouchScroll(surface: HTMLElement, term: any) {
        var touchId: number | null = null;
        var lastY = 0;
        var rowHeight = 16;
        var carryPixels = 0;
        var travelPixels = 0;
        var pagingState: TerminalTouchPagingState = {
          accumulatedPixels: 0,
          lastPageAt: 0,
        };

        // The --term-row-height CSS var is a design token, not the renderer's
        // truth: xterm sizes .xterm-screen to cols×cell / rows×cell inline.
        // Read the real cell height so scrollLines keeps up with the finger.
        function readCellHeight(): number {
          try {
            var screen = surface.querySelector(".xterm-screen");
            if (screen && term.rows > 0) {
              var height = (screen as HTMLElement).clientHeight / term.rows;
              if (height > 4) return height;
            }
          } catch (e) {}
          var raw = getComputedStyle(surface).getPropertyValue("--term-row-height").trim();
          var parsed = parseFloat(raw);
          return parsed > 0 ? parsed : 16;
        }

        function mouseReportingActive(): boolean {
          try {
            return !!term.element && term.element.classList.contains("enable-mouse-events");
          } catch (e) {
            return false;
          }
        }

        // vim(mouse=a)/tmux route wheel events per pane/window; a raw
        // PageDown key moves the cursor or hits the outer app instead, which
        // reads as "wrong direction". Speak SGR wheel at the touched cell.
        function touchWheelSequence(direction: -1 | 1, touch: Touch): string {
          var cols = term.cols || 80;
          var rows = term.rows || 24;
          var col = 1;
          var row = 1;
          try {
            var screen = surface.querySelector(".xterm-screen") as HTMLElement | null;
            if (screen) {
              var rect = screen.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                col = Math.min(cols, Math.max(1, Math.floor((touch.clientX - rect.left) / (rect.width / cols)) + 1));
                row = Math.min(rows, Math.max(1, Math.floor((touch.clientY - rect.top) / (rect.height / rows)) + 1));
              }
            }
          } catch (e) {}
          var button = direction > 0 ? 65 : 64;
          return "\u001b[<" + button + ";" + col + ";" + row + "M";
        }

        surface.addEventListener("touchstart", function(e: TouchEvent) {
          if (e.touches.length !== 1) {
            touchId = null;
            return;
          }
          var t = e.touches[0];
          touchId = t.identifier;
          lastY = t.clientY;
          // Re-read per gesture: native shells inject font-size overrides and
          // refits change the cell metrics after page load.
          rowHeight = readCellHeight();
          carryPixels = 0;
          travelPixels = 0;
          pagingState.accumulatedPixels = 0;
          pagingState.lastPageAt = 0;
        }, { passive: true });

        surface.addEventListener("touchmove", function(e: TouchEvent) {
          if (touchId === null) return;
          var touch: Touch | null = null;
          for (var i = 0; i < e.touches.length; i++) {
            if (e.touches[i].identifier === touchId) { touch = e.touches[i]; break; }
          }
          if (!touch) return;
          // Claim the gesture before any early return: once the WebView
          // latches a native pan on .xterm-viewport, later preventDefault
          // calls are ignored and native + manual scrolling fight each other.
          if (e.cancelable) e.preventDefault();
          var dy = touch.clientY - lastY;
          lastY = touch.clientY;
          if (dy === 0) return;
          travelPixels += Math.abs(dy);

          var isAlternate = term.buffer.active.type === "alternate";
          if (isAlternate) {
            // Natural scrolling: finger up (dy<0) reveals newer content, fed
            // in as positive pixels → PageDown (or SGR wheel down).
            var direction = consumeTerminalTouchPage(-dy, pagingState, Date.now());
            if (direction !== 0) {
              var sequence = mouseReportingActive()
                ? touchWheelSequence(direction, touch)
                : terminalWheelPageSequence(direction);
              if (sequence) sendPtyInput(sequence);
            }
            return;
          }

          // Normal buffer: pixel-accurate scrollback. Whole rows scroll now
          // and the sub-row remainder carries into the next event, so slow
          // drags keep up with the finger instead of dropping every
          // sub-rowHeight move.
          // Natural scrolling: content follows the finger. xterm's
          // scrollLines(+n) moves the viewport toward NEWER rows (scrollTop
          // grows), so a downward drag (dy>0) that should reveal older rows
          // above must feed in -dy — the same inversion the alternate-buffer
          // path applies before paging.
          carryPixels -= dy;
          var lines = Math.trunc(carryPixels / rowHeight);
          if (lines !== 0) {
            carryPixels -= lines * rowHeight;
            term.scrollLines(lines);
          }
          // Detach auto-follow on the first deliberate movement (before a
          // whole row accrues) so streaming writes stop snapping the viewport
          // back to the bottom mid-drag.
          if (travelPixels > 8) setTerminalManualScrollActive();
        }, { passive: false });

        function endTouch() {
          touchId = null;
        }
        surface.addEventListener("touchend", endTouch, { passive: true });
        surface.addEventListener("touchcancel", endTouch, { passive: true });
      }

      // ===== Custom terminal scrollbar =====
      function initTerminalScrollbar(container: HTMLElement) {
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

        function onDragMove(e: MouseEvent) {
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

        function onTouchDragMove(e: TouchEvent) {
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

      // xterm.js is the terminal emulator. These small compatibility exports
      // keep older UI call sites harmless without rewriting or replaying PTY bytes.
      export var CHAT_RENDER_LIVE_MS = 150;
      export var CHAT_RENDER_IDLE_MS = 30;
      var CLIENT_OUTPUT_MAX = 160 * 1024;
      var CLIENT_OUTPUT_TRIM_AT = 192 * 1024;
      /** 未完成的“贴底 + 回到底部按钮”rAF 句柄（PTY 分片热路径的合并槽）。 */
      var terminalChromeRaf = 0;

      // 附件写入之后的「等 CLI 画完」时序（ms）：
      // MIN / QUIET —— 至少等这么久，且看到这一帧输出后再多等 QUIET；
      // PAINT —— 一直没看到输出时的兜底；MAX —— 总上限（CLI 正在刷屏时不再无限等）。
      var PTY_ATTACHMENT_SETTLE_MIN_MS = 120;
      var PTY_ATTACHMENT_SETTLE_QUIET_MS = 120;
      var PTY_ATTACHMENT_SETTLE_PAINT_MS = 800;
      var PTY_ATTACHMENT_SETTLE_MAX_MS = 1500;

      /** 会话恢复后等 provider CLI 画出自己 TUI 的上限（冷启动通常 1~3s）。 */
      var PTY_RESUME_PAINT_TIMEOUT_MS = 5000;
      /** 冷启动下限：刚 resume 的 CLI 先要自己初始化（服务端 initialInput 同样是 3s 兜底）。 */
      var PTY_RESUME_SETTLE_MIN_MS = 3000;
      export function softResyncTerminal(_options?: any) {
        if (!state.terminal) return false;
        state.terminal.refresh(0, Math.max(0, state.terminal.rows - 1));
        return true;
      }
      export function scheduleSoftResyncTerminal(delayMs?: number) {
        if (state.softResyncTimer) clearTimeout(state.softResyncTimer);
        state.softResyncTimer = setTimeout(function() {
          state.softResyncTimer = null;
          softResyncTerminal();
        }, typeof delayMs === "number" ? delayMs : 0);
      }
      export function clampClientTerminalOutput(buffer: string) {
        if (!buffer || buffer.length <= CLIENT_OUTPUT_TRIM_AT) return buffer;
        return buffer.slice(-CLIENT_OUTPUT_MAX);
      }

      function sendPtySocketMessage(message: any) {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
        state.ws.send(JSON.stringify(message));
        return true;
      }

      function sendPtyInput(data: string) {
        if (!state.selectedId || !data) return false;
        return sendPtySocketMessage({
          type: "pty_input",
          sessionId: state.selectedId,
          data: data,
          userInput: state.terminalInteractive === true
        });
      }

      function acknowledgePtyOutput(sessionId: string, bytes: number) {
        if (!sessionId || !(bytes > 0)) return;
        sendPtySocketMessage({ type: "pty_ack", sessionId: sessionId, bytes: bytes });
      }

      // 最近一次终端输出的时刻，用于判断 CLI 是否已经画完上一次写入（见
      // waitForTerminalSettled）。放在这里而不是 state 里，因为只有终端写入
      // 能代表「CLI 又画了一帧」。
      var lastTerminalOutputAt = 0;

      /**
       * 等 CLI 把上一次写入画完。
       *
       * 附件粘贴后 claude / pi 会异步把图片路径换成 [Image #N] 芯片并重绘整行草稿，
       * 紧接着发的下一个 chunk 会被那次重绘吃掉（草稿只剩芯片）。固定 sleep 不是太慢
       * 就是机器忙时不够用，所以改成：看到这一帧输出后再等它静下来；一直没输出就按
       * 上限兜底放行。
       */
      export function waitForTerminalSettled(wroteAtMs?: number, maxMs?: number) {
        var startedAt = typeof wroteAtMs === "number" ? wroteAtMs : Date.now();
        var deadline = startedAt + (typeof maxMs === "number" ? maxMs : PTY_ATTACHMENT_SETTLE_MAX_MS);
        return new Promise(function(resolve) {
          (function poll() {
            var now = Date.now();
            var outputAt = lastTerminalOutputAt;
            var readyAt = outputAt > startedAt
              ? Math.max(outputAt + PTY_ATTACHMENT_SETTLE_QUIET_MS, startedAt + PTY_ATTACHMENT_SETTLE_MIN_MS)
              : startedAt + PTY_ATTACHMENT_SETTLE_PAINT_MS;
            if (now >= readyAt || now >= deadline) {
              resolve(null);
              return;
            }
            setTimeout(poll, Math.max(10, Math.min(60, readyAt - now)));
          })();
        });
      }

      /**
       * 等恢复中的 provider CLI 画出自己的 TUI。
       *
       * 刚 resume 的 CLI 还在冷启动，没进入 bracketed paste 模式；这时写进去的粘贴
       * 标记会被当成字面量显示在草稿行（codex 会显示 "^[[200~"），图片路径也就不会
       * 被换成 chip。所以等到第一帧新输出、再等它静下来；一直没输出就按上限兜底放行。
       * 光看「有新输出」不够：恢复瞬间服务端还会重放旧输出，而 CLI 此时仍在初始化，
       * 所以另加一个冷启动下限（与服务端 initialInput 的 3s 兜底同一量级）。
       */
      export function waitForProviderPaint(timeoutMs?: number) {
        var startedAt = Date.now();
        var paintAllowedAt = startedAt + PTY_RESUME_SETTLE_MIN_MS;
        var deadline = startedAt + (typeof timeoutMs === "number" ? timeoutMs : PTY_RESUME_PAINT_TIMEOUT_MS);
        return new Promise(function(resolve) {
          (function poll() {
            var now = Date.now();
            if (now >= deadline) {
              resolve(null);
              return;
            }
            if (now >= paintAllowedAt && lastTerminalOutputAt > startedAt) {
              waitForTerminalSettled(now).then(function() { resolve(null); });
              return;
            }
            setTimeout(poll, 50);
          })();
        });
      }

      export function wandTerminalWrite(terminal: any, data: any, ackBytes?: number, sessionId?: string) {
        if (!terminal || data == null || data === "") {
          if (ackBytes && sessionId) acknowledgePtyOutput(sessionId, ackBytes);
          return Promise.resolve();
        }
        var text = String(data);
        lastTerminalOutputAt = Date.now();
        var queue = state.terminalWriteQueue || Promise.resolve();
        state.terminalWriteQueue = queue.catch(function() {}).then(function() {
          return new Promise(function(resolve) {
            if (!state.terminal || terminal !== state.terminal) {
              if (ackBytes && sessionId) acknowledgePtyOutput(sessionId, ackBytes);
              resolve(null);
              return;
            }
            terminal.write(text, function() {
              // Check the live flag instead of a snapshot taken at enqueue
              // time: a chunk queued before the user scrolled up must not
              // yank the viewport back to the bottom mid-drag. Going through
              // scrollTerminalToBottom also opens the programmatic-scroll
              // window so the viewport scroll handler doesn't read our own
              // bottom-snap as "the user returned to the bottom".
              if (terminal === state.terminal && state.terminalAutoFollow !== false) {
                scrollTerminalToBottom(false);
              }
              if (ackBytes && sessionId) acknowledgePtyOutput(sessionId, ackBytes);
              resolve(null);
            });
          });
        });
        return state.terminalWriteQueue;
      }

      export function resetTerminal() {
        if (!state.terminal) return;
        state.terminal.reset();
        state.terminal.clear();
      }

      function writeTerminalNow(terminal: any, data: string) {
        return new Promise(function(resolve) {
          if (!data) {
            resolve(null);
            return;
          }
          terminal.write(data, function() { resolve(null); });
        });
      }

      export function restoreTerminalState(sessionId: string, snapshot: any, fallbackOutput?: string) {
        if (!snapshot || snapshot.version !== 1) return false;
        if (sessionId) state.terminalStatesBySession[sessionId] = snapshot;
        // A WS init commonly wins the race against xterm's async font/open
        // setup. Treat the snapshot as accepted here; initTerminal will apply
        // the cached value as soon as the emulator is ready.
        if (!state.terminal) return true;
        var terminal = state.terminal;
        var generation = (state.terminalRestoreGeneration || 0) + 1;
        state.terminalRestoreGeneration = generation;
        var queue = state.terminalWriteQueue || Promise.resolve();
        state.terminalWriteQueue = queue.catch(function() {}).then(async function() {
          if (terminal !== state.terminal || generation !== state.terminalRestoreGeneration) return;
          // WS 重连 / 前台恢复会全量 reset+replay。若用户正停在 scrollback
          // 里阅读，这里不能把他拽回底部：先记下距底部距离，重放完按原距离
          // 复位视口，保持手动浏览模式（是否回底由用户点「回到底部」按钮决定）。
          var wasManualBrowsing = state.terminalAutoFollow === false;
          var prevViewport = getTerminalViewport();
          var manualDistanceFromBottom = prevViewport
            ? Math.max(0, prevViewport.scrollHeight - prevViewport.clientHeight - prevViewport.scrollTop)
            : 0;
          terminal.reset();
          terminal.clear();
          if (snapshot.cols > 0 && snapshot.rows > 0) terminal.resize(snapshot.cols, snapshot.rows);
          await writeTerminalNow(terminal, String(snapshot.data || ""));
          var pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
          for (var i = 0; i < pending.length; i++) {
            var operation = pending[i] || {};
            if (operation.type === "resize" && operation.cols > 0 && operation.rows > 0) {
              terminal.resize(operation.cols, operation.rows);
            } else if (operation.type === "data") {
              await writeTerminalNow(terminal, String(operation.data || ""));
            }
          }
          state.terminalSessionId = sessionId || null;
          state.terminalOutput = String(fallbackOutput || "");
          if (wasManualBrowsing && manualDistanceFromBottom > 2) {
            // 用户正在往上翻页：保持他的阅读位置和手动模式，不强行贴底。
            state.terminalAutoFollow = false;
            if (state.terminalFitAddon && typeof state.terminalFitAddon.fit === "function") {
              fitTerminalToContainer(terminal, state.terminalFitAddon);
              sendTerminalResize(terminal.cols, terminal.rows);
            }
            var restoredViewport = getTerminalViewport();
            if (restoredViewport) {
              restoredViewport.scrollTop = Math.max(
                0,
                restoredViewport.scrollHeight - restoredViewport.clientHeight - manualDistanceFromBottom
              );
            }
          } else {
            state.terminalAutoFollow = true;
            if (state.terminalFitAddon && typeof state.terminalFitAddon.fit === "function") {
              fitTerminalToContainer(terminal, state.terminalFitAddon);
              sendTerminalResize(terminal.cols, terminal.rows);
            }
            terminal.scrollToBottom();
          }
          updateTerminalJumpToBottomButton();
        });
        return true;
      }

      export function syncTerminalBuffer(sessionId: string, output: string, options?: any) {
        if (!state.terminal) return false;
        var rawOutput = String(output || "");
        var nextSessionId = sessionId || null;
        var opts = options || {};
        var replace = opts.mode === "replace";
        var sessionChanged = state.terminalSessionId !== nextSessionId;
        var previousOutput = String(state.terminalOutput || "");
        var wrote = false;

        if (sessionChanged || replace) {
          resetTerminal();
          if (rawOutput) wandTerminalWrite(state.terminal, rawOutput);
          wrote = !!rawOutput || sessionChanged;
        } else if (rawOutput.startsWith(previousOutput)) {
          var delta = rawOutput.slice(previousOutput.length);
          if (delta) {
            wandTerminalWrite(state.terminal, delta);
            wrote = true;
          }
        } else {
          // A truncated byte tail is not an emulator snapshot. Wait for the next
          // authoritative terminalState instead of replaying it into live state.
          return false;
        }

        state.terminalSessionId = nextSessionId;
        state.terminalOutput = rawOutput;
        if (opts.scroll !== false && wrote) maybeScrollTerminalToBottom("output");
        if (sessionChanged) sendTerminalResize(state.terminal.cols, state.terminal.rows);
        return wrote;
      }

      export function initTerminal() {
        var container = document.getElementById("output");
        if (!container || state.terminal || state.terminalInitializing) return;
        if (typeof XTermLib === "undefined" || !XTermLib.Terminal) {
          state.terminalInitRetries = (state.terminalInitRetries || 0) + 1;
          if (state.terminalInitRetries < 10) setTimeout(initTerminal, 200);
          return;
        }
        state.terminalInitRetries = 0;
        state.terminalInitializing = true;

        var selectedSession = state.sessions.find(function(session) {
          return session.id === state.selectedId;
        });
        var shouldExposeTerminal = !!selectedSession
          && !isStructuredSession(selectedSession)
          && state.currentView === "terminal";
        if (shouldExposeTerminal) {
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
        var wrapStyle = getComputedStyle(termWrap);
        var terminalFont = wrapStyle.getPropertyValue("--term-font-family").trim()
          || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
        var baseFontSize = document.documentElement.classList.contains("is-wand-embed-terminal")
          ? 10
          : state.terminalBaseFontSize;
        var fontSize = Math.max(8, Math.round(baseFontSize * Number(state.terminalScale || 1)));

        var term: any = new XTermLib.Terminal({
          cols: 120,
          rows: 36,
          allowProposedApi: true,
          convertEol: false,
          cursorBlink: false,
          // Keep stdin enabled so xterm can answer DA/DSR/window queries. User
          // keystrokes are gated separately by the interaction-mode handler.
          disableStdin: false,
          fontFamily: terminalFont,
          fontSize: fontSize,
          lineHeight: 1.25,
          scrollback: 5000,
          theme: {
            background: "#17120f",
            foreground: "#f4eee6",
            cursor: "#d88d60",
            selectionBackground: "rgba(216, 141, 96, 0.3)"
          }
        });
        var fitAddon = new XTermLib.FitAddon();
        var unicodeAddon = new XTermLib.Unicode11Addon();
        term.loadAddon(fitAddon);
        term.loadAddon(unicodeAddon);
        term.unicode.activeVersion = "11";

        var fontsReady = (document.fonts && typeof document.fonts.ready === "object")
          ? Promise.race([document.fonts.ready, new Promise(function(resolve) { setTimeout(resolve, 800); })])
          : Promise.resolve();

        fontsReady.then(function() {
          term.open(termWrap);
          term.registerLinkProvider({
            provideLinks: function(lineNumber: number, callback: (links: any[] | undefined) => void) {
              var line = term.buffer.active.getLine(lineNumber);
              var text = line ? line.translateToString(true) : "";
              var links: any[] = [];
              var httpRegex = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]+)?/gi;
              var match: RegExpExecArray | null;
              while ((match = httpRegex.exec(text)) !== null) {
                var start = match.index + 1;
                var end = match.index + match[0].length;
                links.push({
                  text: match[0],
                  range: { start: { x: start, y: lineNumber }, end: { x: end, y: lineNumber } },
                  activate: function(_event: any, value: string) {
                    openLocalPreviewFromLegacy(value);
                  },
                });
              }
              var fileRegex = /(^|[\s(\['"])(\/[^\s]+?\.(?:html?|\/))(?=$|[\s)\]'"])/gi;
              while ((match = fileRegex.exec(text)) !== null) {
                var value = match[2];
                var fileStart = match.index + match[1].length + 1;
                var fileEnd = match.index + match[1].length + value.length;
                links.push({
                  text: value,
                  range: { start: { x: fileStart, y: lineNumber }, end: { x: fileEnd, y: lineNumber } },
                  activate: function(_event: any, target: string) {
                    openLocalPreviewFromLegacy(target);
                  },
                });
              }
              callback(links.length ? links : undefined);
            },
          });
          term.attachCustomKeyEventHandler(function() {
            return state.terminalInteractive === true;
          });
          var wheelPagingState: TerminalWheelPagingState = {
            direction: 0,
            accumulatedPixels: 0,
            lastEventAt: 0,
            lastPageAt: 0,
          };
          var wheelScrollState: TerminalWheelScrollState = {
            accumulatedPixels: 0,
            lastEventAt: 0,
          };

          function terminalCellHeight(): number {
            try {
              var screen = termWrap.querySelector(".xterm-screen") as HTMLElement | null;
              if (screen && term.rows > 0) {
                var measured = screen.clientHeight / term.rows;
                if (measured > 4) return measured;
              }
            } catch (e) {}
            return Math.max(1, fontSize * 1.25);
          }

          // Do not rely on xterm's browser-native viewport scrolling here. The
          // viewport is intentionally hidden by Wand's layout, and in some
          // browsers the wheel is consumed by the xterm helper textarea before
          // the scroll container gets a chance to move. Handling the gesture at
          // the wrapper capture phase makes mouse wheels and trackpads behave
          // consistently while preserving the alternate-buffer TUI path.
          termWrap.addEventListener("wheel", function(event: WheelEvent) {
            if (
              event.ctrlKey
              || event.metaKey
              || Math.abs(event.deltaY) <= Math.abs(event.deltaX)
            ) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (term.buffer.active.type === "alternate") {
              var viewport = getTerminalViewport();
              var direction = consumeTerminalWheelPage(
                event,
                wheelPagingState,
                viewport ? viewport.clientHeight : term.rows * terminalCellHeight(),
              );
              var sequence = terminalWheelPageSequence(direction);
              if (sequence) sendPtyInput(sequence);
              return;
            }

            // xterm's scrollLines uses negative values for older rows and
            // positive values for newer rows, matching DOM wheel deltaY.
            if (event.deltaY < 0) setTerminalManualScrollActive();
            var lines = consumeTerminalWheelLines(
              event,
              wheelScrollState,
              terminalCellHeight(),
              term.rows * terminalCellHeight(),
            );
            if (lines !== 0) term.scrollLines(lines);
          }, { capture: true, passive: false });
          var helperTextarea = termWrap.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
          if (helperTextarea) {
            helperTextarea.readOnly = shouldLockNativeInputTerminalIme() ? true : !state.terminalInteractive;
          }
          installNativeInputImeGuard();
          lockNativeInputTerminalIme();
          state.terminal = term;
          // Expose for native shells (macOS / iOS) that need cols/rows/scale
          // without reaching into module-scoped state.
          try { (window as any).__wandTerminal = term; } catch (e) {}
          state.terminalFitAddon = fitAddon;
          state.terminalWriteQueue = Promise.resolve();
          state.terminalInitializing = false;
          fitTerminalToContainer(term, fitAddon);

          term.onData(function(data: string) { sendPtyInput(data); });
          term.onBinary(function(data: string) {
            if (state.terminalInteractive) sendPtyInput(data);
          });
          term.onResize(function(size: { cols: number; rows: number }) {
            sendTerminalResize(size.cols, size.rows);
          });

          state.terminalAutoFollow = true;
          var viewport = getTerminalViewport();
          if (viewport) {
            state.terminalViewportScrollHandler = function() {
              if (Date.now() < state.terminalProgrammaticScrollUntil) {
                updateTerminalJumpToBottomButton();
                return;
              }
              if (isTerminalAtBottom()) {
                state.terminalAutoFollow = true;
              } else {
                setTerminalManualScrollActive();
              }
              updateTerminalJumpToBottomButton();
            };
            viewport.addEventListener("scroll", state.terminalViewportScrollHandler, { passive: true });
          }

          state.terminalWheelHandler = function(event: WheelEvent) {
            if (event.deltaY < 0) setTerminalManualScrollActive();
            event.stopPropagation();
          };
          container.addEventListener("wheel", state.terminalWheelHandler, { passive: true });
          initTerminalScrollbar(container);
          // Mobile touch scroll: wired on the terminal surface so Android WebView,
          // iOS WKWebView and mobile browsers can scroll scrollback / page TUIs.
          initTerminalTouchScroll(termWrap, term);

          if (state.selectedId) {
            var session = state.sessions.find(function(item: any) { return item.id === state.selectedId; });
            var cachedState = session && state.terminalStatesBySession[session.id];
            var terminalState = session && (session.terminalState || cachedState);
            if (session && !restoreTerminalState(session.id, terminalState, session.output || "")) {
              syncTerminalBuffer(session.id, session.output || "", { mode: "replace", scroll: false });
            }
          } else {
            wandTerminalWrite(term, "点击上方「新对话」开始你的第一次对话。\r\n");
          }

          state.terminalClickHandler = function(event: MouseEvent) {
            if (hasActiveTerminalSelection()) return;
            if (shouldLockNativeInputTerminalIme()) {
              lockNativeInputTerminalIme();
              return;
            }
            if (state.terminalInteractive) term.focus();
            else focusInputBox(event);
          };
          container.addEventListener("click", state.terminalClickHandler);
          updateTerminalJumpToBottomButton();
          initTerminalResizeHandle();
          initTerminalJoystick();
          observeTerminalResize();
          startTerminalHealthCheck();
          ensureTerminalFit("mount");

          if (document.documentElement.classList.contains("is-wand-embed-terminal")) {
            [120, 350, 700].forEach(function(delay: number) {
              setTimeout(function() {
                if (state.terminal) ensureTerminalFit("embed-settle");
              }, delay);
            });
          }
        }).catch(function(error) {
          state.terminalInitializing = false;
          try { term.dispose(); } catch (disposeError) {}
          console.error("[wand] xterm init failed:", error);
        });
      }
