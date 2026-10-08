import { state, writeStoredBoolean } from "./state";
import "./utils";
import { resetRootViewportScroll, shouldAdjustForKeyboard, syncInputBoxScroll } from "./input";
import "./notifications";
import "./render";
import { isStructuredSession, updateDrawerState } from "./session-engine";
import { maybeScrollTerminalToBottom, updateTerminalJumpToBottomButton } from "./terminal";
import { isSidebarDrawerLayout } from "./file-browser";
import { fitTerminalToContainer } from "./terminal-fit";

function compactSessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined),
      "X-Wand-Tool-Projection": "compact" } });
}

      var appViewportBaselineWidth = 0;
      var appViewportBaselineHeight = 0;
      var closedViewportBaselineUntil = 0;
      // iOS 原生壳键盘收起冷却：收起动画期间 visualViewport 尺寸抖动会让
      // detectKeyboardOpen 误判为 "键盘仍打开"，导致 --app-viewport-top
      // 残留正值、输入框偏下。冷却期内抑制弱信号的 "仍打开" 判定。
      var keyboardDismissCooldownUntil = 0;
      // settle 批次：focus/blur 抖动会叠加多批回调，重排前清旧批、teardown 全清。
      var viewportSettleTimers = [];
      var focusedInputSettleTimers = [];

      function isIosNativeViewportMode() {
        return window.__wandIosNative === true;
      }

      function markClosedViewportBaselineWindow(durationMs) {
        closedViewportBaselineUntil = Math.max(
          closedViewportBaselineUntil,
          Date.now() + (durationMs || 1800)
        );
      }

      export function scheduleClosedViewportBaselineWindow(durationMs, blurredEl) {
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

      // iOS 原生壳键盘收起后 visualViewport 可能残留偏移或高度不足，
      // 用已知基线兜住避免底部留白。
      function shouldUseFullViewport(isKeyboardOpen, offsetTop, height, baselineHeight) {
        if (isKeyboardOpen || !isIosNativeViewportMode()) return false;
        return offsetTop > 0 || baselineHeight > height + 1;
      }

      export function syncAppViewportHeight(isKeyboardOpen) {
        var vv = window.visualViewport;
        if (!vv) return;
        var root = document.documentElement;
        root.classList.toggle('is-keyboard-open', !!isKeyboardOpen);
        // APK 原生 IME：MainActivity 已逐帧 setPadding，直接用 vv.height 即可。
        if (window.__wandImeNative) {
          root.style.setProperty('--app-viewport-top', '0px');
          root.style.setProperty('--app-viewport-height', Math.round(vv.height) + 'px');
          return;
        }
        var baselineHeight = refreshAppViewportBaseline(vv);
        var offsetTop = Math.max(0, Math.round(vv.offsetTop || 0));
        var height = Math.max(1, Math.round(vv.height));
        // iOS 原生壳在键盘关闭状态下无条件钉到基线：
        // 收起动画期间 vv.height/offsetTop 会抖动，若跟随这些中间值会导致
        // --app-viewport-top 残留正值、底部输入框偏到屏幕外。
        if (!isKeyboardOpen && isIosNativeViewportMode()) {
          offsetTop = 0;
          height = Math.max(height, baselineHeight);
        } else if (shouldUseFullViewport(isKeyboardOpen, offsetTop, height, baselineHeight)) {
          offsetTop = 0;
          height = Math.max(height, baselineHeight);
        }
        root.style.setProperty('--app-viewport-top', offsetTop + 'px');
        root.style.setProperty('--app-viewport-height', height + 'px');
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

      // Visual viewport handling for better mobile keyboard support
      export function setupVisualViewportHandlers() {
        if (!('visualViewport' in window)) return;
        if (window.__wandViewportHandlersBound) return;
        window.__wandViewportHandlersBound = true;

        var vv = window.visualViewport;
        var lastHeight = vv.height;
        var keyboardOpen = false;
        var lastViewportWidth = Math.max(window.innerWidth || 0, vv.width || 0);
        var largestViewportHeight = Math.max(window.innerHeight || 0, vv.height || 0);

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
          // 冷却期内（键盘刚收起 1.2s 内）iOS 动画会让 vv 尺寸抖动，
          // 如果仍跟随弱信号判定 "键盘打开" 会导致 --app-viewport-top 残留。
          // 冷却期只接受强信号：编辑焦点 + 大幅收缩（用户重新点了输入框）。
          var inDismissCooldown = Date.now() < keyboardDismissCooldownUntil;
          if (inDismissCooldown) {
            // 强信号：用户重新聚焦了可编辑元素且视口明显收缩
            if (hasEditableFocus && (shrinkFromLargest > 120 || innerShrinkFromLargest > 120)) return true;
            return false;
          }
          if (offsetBottom > 80) return true;
          // iOS/Chrome iOS 有时同步缩 innerHeight 导致 offsetBottom ≈ 0，用基线收缩判定。
          if (hasEditableFocus && (shrinkFromLargest > 120 || innerShrinkFromLargest > 120)) return true;
          // 收起动画中焦点可能先消失，保持 open 直到高度基本恢复。
          if (keyboardOpen && (shrinkFromLargest > 80 || offsetBottom > 32)) return true;
          return false;
        }

        function scheduleViewportSettle() {
          viewportSettleTimers.forEach(function(timer) { clearTimeout(timer); });
          // 多档延迟覆盖键盘动画尾巴 + iOS vv.resize 不触发的边界条件。
          viewportSettleTimers = [60, 180, 360, 620, 900].map(function(delay) {
            return setTimeout(function() {
              syncAppViewportHeight(keyboardOpen);
            }, delay);
          });
        }

        function scheduleFocusedInputSettle() {
          focusedInputSettleTimers.forEach(function(timer) { clearTimeout(timer); });
          focusedInputSettleTimers = [0, 50, 120, 220, 360, 560].map(function(delay) {
            return setTimeout(function() {
              updateViewport();
              var inputBox = document.getElementById('input-box');
              if (inputBox && document.activeElement === inputBox) {
                syncInputBoxScroll(inputBox);
              }
            }, delay);
          });
        }

        function updateViewport() {
          if (!vv) return;
          var inputBox = document.getElementById('input-box');
          var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
          refreshViewportBaseline();
          var isKeyboardOpen = detectKeyboardOpen(inputBox, offsetBottom);
          var heightChanged = Math.abs(vv.height - lastHeight) > 8;

          syncAppViewportHeight(isKeyboardOpen);

          if (isKeyboardOpen && (!keyboardOpen || heightChanged) && shouldAdjustForKeyboard(vv, inputBox)) {
            syncInputBoxScroll(inputBox);
          }

          if (!keyboardOpen && isKeyboardOpen) {
            // SCROLL-3: 只看 terminalAutoFollow。用户上滚进入手动浏览模式后，
            // 键盘弹起引发的 fit / 重排不得把他拽回底部——回底只能靠点按钮。
            var wasStickToBottom = state.terminalAutoFollow;
            ensureTerminalFit("keyboard-open", { forceReplay: true });
            if (!window.__wandImeNative) {
              setTimeout(function() { syncAppViewportHeight(true); }, 220);
            }
            scheduleViewportSettle();
            if (wasStickToBottom) {
              setTimeout(function() {
                if (!state.terminal) return;
                // 延迟窗口内用户可能已 wheel 上滚：再查一次 live 标志。
                if (!state.terminalAutoFollow) return;
                maybeScrollTerminalToBottom("force");
              }, 220);
            }
          }

          if (keyboardOpen && !isKeyboardOpen) {
            var imeIsNative = !!window.__wandImeNative;
            if (!imeIsNative) {
              markClosedViewportBaselineWindow(2200);
              // 启动冷却：1.2s 内抑制动画抖动导致的误判回弹。
              keyboardDismissCooldownUntil = Date.now() + 1200;
              syncAppViewportHeight(false);
              // 清掉 iOS 残留的 layout scroll，避免容器整体偏移。
              resetRootViewportScroll();
            }
            scheduleViewportSettle();
            setTimeout(function() {
              if (!imeIsNative) {
                syncAppViewportHeight(false);
                resetRootViewportScroll();
              }
              ensureTerminalFit("keyboard-close", { forceReplay: true });
              maybeScrollTerminalToBottom("keyboard");
            }, 200);
          }

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
        vv.addEventListener('scroll', debouncedUpdate);

        // 切后台/bfcache/focusout 等边界场景 vv 不触发 resize，主动补测。
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'visible') {
            debouncedUpdate();
            setTimeout(debouncedUpdate, 240);
            setTimeout(debouncedUpdate, 720);
          }
        });
        window.addEventListener('pageshow', function(e) {
          if (e && e.persisted) {
            debouncedUpdate();
            setTimeout(debouncedUpdate, 240);
          }
        });
        document.addEventListener('focusout', function(e) {
          if (!e || !e.target) return;
          if (!isEditableFocusTarget(e.target)) return;
          scheduleClosedViewportBaselineWindow(1600, e.target);
          // 即刻启动冷却，避免失焦后 iOS 收起动画抖动误判。
          if (isIosNativeViewportMode()) {
            keyboardDismissCooldownUntil = Math.max(
              keyboardDismissCooldownUntil,
              Date.now() + 1200
            );
          }
          setTimeout(debouncedUpdate, 80);
          setTimeout(debouncedUpdate, 420);
        });
        document.addEventListener('focusin', function(e) {
          if (!e || !e.target || !isEditableFocusTarget(e.target)) return;
          scheduleFocusedInputSettle();
        });
        window.addEventListener('wand-ios-ime-state', function(e: any) {
          var state = e && e.detail && e.detail.state;
          if (state === 'hidden') {
            keyboardDismissCooldownUntil = Date.now() + 900;
          }
          scheduleFocusedInputSettle();
          scheduleViewportSettle();
        });

        updateViewport();
      }

      export function initTerminalResizeHandle() {
        var container = document.getElementById("output");
        if (!container) return;

        var resizeHandle = document.createElement("div");
        resizeHandle.className = "terminal-resize-handle";
        resizeHandle.setAttribute("role", "separator");
        resizeHandle.setAttribute("aria-orientation", "horizontal");
        resizeHandle.setAttribute("aria-label", "调整终端高度");
        resizeHandle.innerHTML = '<span aria-hidden="true">&#8942;</span>';
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

      export function observeTerminalResize() {
        var output = document.getElementById("output");
        if (!output) return;
        // 「停靠 ⟷ 抽屉」形态切换时才需要修正抽屉开关状态：
        // 进入抽屉形态要把常驻侧栏收成抽屉，回到停靠形态要把抽屉恢复成常驻。
        var lastKnownDesktop = !isSidebarDrawerLayout();
        state.resizeHandler = function() {
          scheduleTerminalResize(true);
          var isDesktop = !isSidebarDrawerLayout();
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
          state.visualViewportHandler = function() { scheduleTerminalResize(true); };
          window.visualViewport.addEventListener("resize", state.visualViewportHandler);
        }
        state.visibilityHandler = function() {
          if (!document.hidden) ensureTerminalFit("visibility", { forceReplay: true });
        };
        document.addEventListener("visibilitychange", state.visibilityHandler);
        state.orientationHandler = function() { ensureTerminalFit("orientation", { forceReplay: true }); };
        window.addEventListener("orientationchange", state.orientationHandler);
        requestAnimationFrame(function() { scheduleTerminalResize(true); });
      }

      export function startTerminalHealthCheck() {
        if (state.terminalHealthTimer) return;
        state.terminalHealthTimer = setInterval(function() {
          if (!state.terminal || state.currentView !== "terminal" || document.hidden) return;
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (!selectedSession || selectedSession.sessionKind === "structured") return;
          ensureTerminalFit("health");
        }, 5000);
      }

      function stopTerminalHealthCheck() {
        if (state.terminalHealthTimer) {
          clearInterval(state.terminalHealthTimer);
          state.terminalHealthTimer = null;
        }
      }

      export function teardownTerminal() {
        stopTerminalHealthCheck();
        // settle 回调不挂在 DOM 监听器上，teardown 必须显式清空两批。
        viewportSettleTimers.forEach(function(timer) { clearTimeout(timer); });
        viewportSettleTimers = [];
        focusedInputSettleTimers.forEach(function(timer) { clearTimeout(timer); });
        focusedInputSettleTimers = [];
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
            output.removeEventListener("wheel", state.terminalWheelHandler, true);
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
        state.terminalScrollbarDragging = false;
        state.terminalScrollbarRafPending = false;
        if (state.terminal) {
          if (typeof state.terminal.dispose === "function") state.terminal.dispose();
          else if (typeof state.terminal.destroy === "function") state.terminal.destroy();
          state.terminal = null;
        }
        // Dispose does not remove the wrapper node itself.
        if (output) {
          var staleWraps = output.querySelectorAll(".terminal-scroll-wrap");
          for (var i = 0; i < staleWraps.length; i++) {
            var wrap = staleWraps[i];
            if (wrap.parentNode === output) output.removeChild(wrap);
          }
        }
        state.terminalSessionId = null;
        state.terminalFitAddon = null;
        state.terminalWriteQueue = Promise.resolve();
        state.terminalRestoreGeneration = (state.terminalRestoreGeneration || 0) + 1;
        state.terminalOutput = "";
        state.terminalAutoFollow = true;
        state.showTerminalJumpToBottom = false;
        updateTerminalJumpToBottomButton();
        if (state.softResyncTimer) {
          clearTimeout(state.softResyncTimer);
          state.softResyncTimer = null;
        }
        state.lastResize = { cols: 0, rows: 0 };
      }

      export function sendTerminalResize(cols, rows) {
        if (!state.selectedId) return;
        var selectedSess = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSess || selectedSess.status !== "running") return;
        if (isStructuredSession(selectedSess)) return;
        cols = Math.max(20, Math.min(Math.floor(cols), 1000));
        rows = Math.max(5, Math.min(Math.floor(rows), 500));
        var nextSize = { cols: cols, rows: rows };
        if (state.lastResize.cols !== nextSize.cols || state.lastResize.rows !== nextSize.rows) {
          state.lastResize = nextSize;
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
              type: "pty_resize",
              sessionId: state.selectedId,
              cols: nextSize.cols,
              rows: nextSize.rows
            }));
          } else {
            compactSessionFetch("/api/sessions/" + state.selectedId + "/resize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify(nextSize)
            }).catch(function() {});
          }
        }
      }

      export function ensureTerminalFit(reason?, options?) {
        if (!state.terminal) return false;
        var el = document.getElementById("output");
        if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
          ensureTerminalFitWithRetry(reason || "fit-retry");
          return false;
        }
        // 提前快照 stick-to-bottom 意图，避免 rAF 期间 scroll 事件污染判定。
        // SCROLL-3: 只认 terminalAutoFollow——手动浏览模式（autoFollow=false）下
        // fit / resize 一律不拽底，即使当前位置仍在底部阈值内；是否回底由
        // 用户点「回到底部」按钮决定。快照之外再叠加 rAF 内的 live 复查：
        // 若用户恰好在两帧之间 wheel 上滚，这里不能覆盖他的意图。
        var shouldStickToBottom = state.terminalAutoFollow;
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            if (!state.terminal) return;
            if (state.terminalFitAddon && typeof state.terminalFitAddon.fit === "function") {
              fitTerminalToContainer(state.terminal, state.terminalFitAddon);
            }
            sendTerminalResize(state.terminal.cols, state.terminal.rows);
            if (shouldStickToBottom && state.terminalAutoFollow) {
              maybeScrollTerminalToBottom("force");
            } else {
              updateTerminalJumpToBottomButton();
            }
          });
        });
        return true;
      }

      export function ensureTerminalFitWithRetry(reason?, options?) {
        if (!state.terminal) return;
        var attempts = 0;
        var maxAttempts = 8;
        function tryFit() {
          if (!state.terminal) return;
          var el = document.getElementById("output");
          if (el) void el.offsetHeight;
          if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
            ensureTerminalFit(reason);
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

      export function scheduleTerminalResize(immediate?) {
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
        // SCROLL-3: 手动浏览模式下 resize 不拽底（原实现的宽松近底判断
        // 会在距底 12px 内把上滚用户强行拉回去并重新开启跟随）。
        if (state.terminalAutoFollow) {
          maybeScrollTerminalToBottom("force");
        }
        sendTerminalResize(state.terminal.cols, state.terminal.rows);
      }
