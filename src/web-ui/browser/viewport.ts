import { state, writeStoredBoolean } from "./state";
import { iconSvg, t } from "./i18n";
import { escapeHtml } from "./utils";
import { JOYSTICK_ACTION_KEYS, JOYSTICK_BALL_SIZE, JOYSTICK_EDGE_MARGIN, JOYSTICK_LONG_PRESS_MS, JOYSTICK_MOVE_THRESHOLD, JOYSTICK_TAP_THRESHOLD, buildMessagesForRender, buildPtySequence, clearModifiers, focusInputBox, getSelectedSession, handleInputBoxBlur, isTerminalInteractionAvailable, postInput, queueDirectInput, resetRootViewportScroll, scheduleShortcutResync, sendTerminalSequence, shouldAdjustForKeyboard, syncInputBoxScroll, updateQueueBar } from "./input";
import { showToast } from "./notifications";
import { render } from "./render";
import { getPreferredMessages, isStructuredSession, updateDrawerState, updateSessionSnapshot } from "./session-engine";
import { clampClientTerminalOutput, clearTerminalScrollIdleTimer, initTerminal, initTerminalScrollbar, isTerminalNearBottom, maybeScrollTerminalToBottom, resetTerminal, resetWideParserState, softResyncTerminal, syncTerminalBuffer, updateTerminalJumpToBottomButton, wandTerminalWrite, widePadAnsi } from "./terminal";
import { isMobileLayout } from "./file-browser";
import { renderChat } from "./websocket";

      export var appViewportBaselineWidth = 0;
      export var appViewportBaselineHeight = 0;
      export var closedViewportBaselineUntil = 0;
      // iOS PWA 键盘收起冷却：收起动画期间 visualViewport 尺寸抖动会让
      // detectKeyboardOpen 误判为 "键盘仍打开"，导致 --app-viewport-top
      // 残留正值、输入框偏下。冷却期内抑制弱信号的 "仍打开" 判定。
      export var keyboardDismissCooldownUntil = 0;

      export function isStandaloneViewportMode() {
        var root = document.documentElement;
        if (root && root.classList && root.classList.contains('is-pwa')) return true;
        try { return navigator.standalone === true; } catch (e) {}
        return false;
      }

      export function markClosedViewportBaselineWindow(durationMs) {
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

      export function getFullViewportHeight(vv) {
        return Math.max(
          window.innerHeight || 0,
          vv && vv.height || 0,
          document.documentElement ? document.documentElement.clientHeight || 0 : 0,
          document.body ? document.body.clientHeight || 0 : 0
        );
      }

      export function refreshAppViewportBaseline(vv) {
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

      // iOS PWA 键盘收起后 visualViewport 可能残留偏移或高度不足，
      // 用已知基线兜住避免底部留白。
      export function shouldUseFullViewport(isKeyboardOpen, offsetTop, height, baselineHeight) {
        if (isKeyboardOpen || !isStandaloneViewportMode()) return false;
        return offsetTop > 0 || baselineHeight > height + 1;
      }

      export function syncAppViewportHeight(isKeyboardOpen) {
        var vv = window.visualViewport;
        if (!vv) return;
        var root = document.documentElement;
        // APK 原生 IME：MainActivity 已逐帧 setPadding，直接用 vv.height 即可。
        if (window.__wandImeNative) {
          root.style.setProperty('--app-viewport-top', '0px');
          root.style.setProperty('--app-viewport-height', Math.round(vv.height) + 'px');
          return;
        }
        var baselineHeight = refreshAppViewportBaseline(vv);
        var offsetTop = Math.max(0, Math.round(vv.offsetTop || 0));
        var height = Math.max(1, Math.round(vv.height));
        // iOS PWA standalone 在键盘关闭状态下无条件钉到基线：
        // 收起动画期间 vv.height/offsetTop 会抖动，若跟随这些中间值会导致
        // --app-viewport-top 残留正值、底部输入框偏到屏幕外。
        if (!isKeyboardOpen && isStandaloneViewportMode()) {
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

      export function isEditableFocusTarget(el) {
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
            var wasStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
            ensureTerminalFit("keyboard-open", { forceReplay: true });
            if (!window.__wandImeNative) {
              setTimeout(function() { syncAppViewportHeight(true); }, 220);
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
          if (isStandaloneViewportMode()) {
            keyboardDismissCooldownUntil = Math.max(
              keyboardDismissCooldownUntil,
              Date.now() + 1200
            );
          }
          setTimeout(debouncedUpdate, 80);
          setTimeout(debouncedUpdate, 420);
        });

        updateViewport();
      }

      export function initTerminalResizeHandle() {
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

      export function isJoystickAvailable() {
        return !!getSelectedSession();
      }

      export function clampJoystickPos(pos) {
        var maxRight = Math.max(JOYSTICK_EDGE_MARGIN, window.innerWidth - JOYSTICK_BALL_SIZE - JOYSTICK_EDGE_MARGIN);
        var maxBottom = Math.max(JOYSTICK_EDGE_MARGIN, window.innerHeight - JOYSTICK_BALL_SIZE - JOYSTICK_EDGE_MARGIN);
        return {
          right: Math.min(Math.max(JOYSTICK_EDGE_MARGIN, pos.right), maxRight),
          bottom: Math.min(Math.max(JOYSTICK_EDGE_MARGIN, pos.bottom), maxBottom)
        };
      }

      export function applyJoystickPosition() {
        if (!state.joystickBallEl) return;
        var pos = clampJoystickPos(state.joystickPos || { right: 18, bottom: 96 });
        state.joystickBallEl.style.right = pos.right + "px";
        state.joystickBallEl.style.bottom = pos.bottom + "px";
      }

      export function saveJoystickPosition(right, bottom) {
        var pos = clampJoystickPos({ right: right, bottom: bottom });
        state.joystickPos = pos;
        try {
          localStorage.setItem("wand-ball-pos", JSON.stringify(pos));
        } catch (e) {
          // Ignore localStorage errors
        }
      }

      export function renderJoystickPanel() {
        function keyBtn(key, label, cls) {
          return '<button type="button" class="wjp-key' + (cls ? " " + cls : "") +
            '" data-key="' + key + '">' + label + "</button>";
        }
        var dpad =
          '<div class="wjp-dpad">' +
            '<div class="wjp-dpad-row">' + keyBtn("up", "↑", "wjp-dir") + "</div>" +
            '<div class="wjp-dpad-row">' +
              keyBtn("left", "←", "wjp-dir") + keyBtn("down", "↓", "wjp-dir") + keyBtn("right", "→", "wjp-dir") +
            "</div>" +
          "</div>";
        var fnRow = "";
        var i;
        for (i = 0; i < JOYSTICK_ACTION_KEYS.length; i++) {
          fnRow += keyBtn(JOYSTICK_ACTION_KEYS[i].key, JOYSTICK_ACTION_KEYS[i].label, "");
        }
        var html =
          '<div class="wjp-header">' +
            '<span class="wjp-title">' + iconSvg("paw", { size: 13, strokeWidth: 1.6, cls: "wjp-title-icon" }) + '<span>遥控面板</span></span>' +
            '<button type="button" class="wjp-close" aria-label="关闭遥控面板">' + iconSvg("x", { size: 13, strokeWidth: 2 }) + '</button>' +
          '</div>' +
          dpad +
          '<div class="wjp-grid wjp-fnkeys">' + fnRow + "</div>";
        return html;
      }

      export function initTerminalJoystick() {
        if (state.joystickRootEl) return;

        var root = document.createElement("div");
        root.className = "wand-joystick-root";

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
        ball.setAttribute("aria-label", "Wand 遥控面板");
        ball.setAttribute("title", "点击打开遥控面板，拖动可移动位置");
        ball.innerHTML = iconSvg("paw", { size: 25, strokeWidth: 1.6, cls: "wand-joystick-logo" });
        root.appendChild(ball);

        document.body.appendChild(root);
        state.joystickRootEl = root;
        state.joystickBackdropEl = backdrop;
        state.joystickPanelEl = panel;
        state.joystickBallEl = ball;
        applyJoystickPosition();

        ball.addEventListener("pointerdown", onJoystickPointerDown);
        ball.addEventListener("click", function(e) { e.preventDefault(); e.stopPropagation(); });
        backdrop.addEventListener("pointerdown", function(e) {
          if (state.joystickPinnedOpen && state.joystickGesture == null) {
            e.preventDefault();
            closeJoystickPanel();
          }
        });
        backdrop.addEventListener("click", function(e) { e.preventDefault(); e.stopPropagation(); });

        state.joystickResizeHandler = function() { applyJoystickPosition(); };
        window.addEventListener("resize", state.joystickResizeHandler);
        window.addEventListener("orientationchange", state.joystickResizeHandler);
        updateJoystickVisibility();
      }

      export function onJoystickPointerDown(e) {
        if (!isJoystickAvailable()) return;
        if ((e.pointerType === "mouse" || e.pointerType === "pen") && e.button !== 0) return;
        if (state.joystickPointerId !== null) return;
        e.preventDefault();
        e.stopPropagation();
        var canDirectDrag = e.pointerType === "mouse" || e.pointerType === "pen";
        state.joystickPointerId = e.pointerId;
        state.joystickPressStart = { x: e.clientX, y: e.clientY, t: Date.now() };
        state.joystickGesture = "pending";
        try { state.joystickBallEl.setPointerCapture(e.pointerId); } catch (err) {}
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

      export function enterJoystickMoveMode() {
        state.joystickGesture = "move";
        if (state.joystickPinnedOpen) closeJoystickPanel();
        if (state.joystickBallEl) state.joystickBallEl.classList.add("dragging");
        if (state.joystickBackdropEl) state.joystickBackdropEl.classList.add("active");
      }

      export function moveJoystickBallTo(clientX, clientY) {
        if (!state.joystickBallEl) return;
        var pos = clampJoystickPos({
          right: window.innerWidth - clientX - JOYSTICK_BALL_SIZE / 2,
          bottom: window.innerHeight - clientY - JOYSTICK_BALL_SIZE / 2
        });
        state.joystickBallEl.style.right = pos.right + "px";
        state.joystickBallEl.style.bottom = pos.bottom + "px";
      }

      export function onJoystickPointerMove(e) {
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

      export function onJoystickPointerUp(e) {
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

      export function endJoystickGesture() {
        if (state.joystickLongPressTimer) {
          clearTimeout(state.joystickLongPressTimer);
          state.joystickLongPressTimer = null;
        }
        if (state.joystickBallEl && state.joystickPointerId !== null) {
          try { state.joystickBallEl.releasePointerCapture(state.joystickPointerId); } catch (err) {}
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

      export function sendJoystickKey(key) {
        if (key === "ctrl" || key === "alt" || key === "shift") {
          state.modifiers[key] = !state.modifiers[key];
          updateJoystickPanelUI();
          return;
        }
        var session = getSelectedSession();
        // 结构化会话只接受中断意图键 (Ctrl+C / Esc)。
        if (session && isStructuredSession(session)) {
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
        clearModifiers();              // 发后自动清修饰键（应用到下一个发送的键）
        updateJoystickPanelUI();
        scheduleShortcutResync();
      }

      export function interruptStructuredSessionFromJoystick(session, key) {
        if (!session || !session.id) return;
        fetch("/api/structured-sessions/" + session.id + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: "", interrupt: true, preserveQueue: true }),
        })
        .then(function(res) {
          if (!res.ok) return res.json().catch(function() { return {}; }).then(function(p) {
            throw new Error((p && p.error) || ("中断失败 (key=" + key + ")"));
          });
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.id) {
            updateSessionSnapshot(snapshot);
            if (snapshot.id === state.selectedId) {
              var refreshed = state.sessions.find(function(s) { return s.id === snapshot.id; }) || snapshot;
              state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, snapshot.output, false));
              renderChat(true);
              if (typeof updateQueueBar === "function") updateQueueBar();
            }
          }
        })
        .catch(function(err) {
          if (err && err.message) console.debug("[wand] joystick interrupt no-op:", err.message);
        });
      }

      export function toggleJoystickPanel() {
        if (state.joystickPinnedOpen) closeJoystickPanel();
        else openJoystickPanel();
      }

      export function openJoystickPanel() {
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

      export function closeJoystickPanel() {
        state.joystickPinnedOpen = false;
        if (state.joystickPanelEl) state.joystickPanelEl.classList.remove("active");
        if (state.joystickBallEl) state.joystickBallEl.classList.remove("panel-open");
        if (state.joystickBackdropEl && state.joystickGesture == null) {
          state.joystickBackdropEl.classList.remove("active");
        }
      }

      export function updateJoystickPanelUI() {
        if (!state.joystickPanelEl) return;
        ["ctrl", "alt"].forEach(function(name) {
          var btn = state.joystickPanelEl.querySelector('.wjp-mod[data-key="' + name + '"]');
          if (btn) btn.classList.toggle("active", !!state.modifiers[name]);
        });
      }

      export function onJoystickPanelClick(e) {
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

      export function updateJoystickVisibility() {
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

      export function teardownJoystick() {
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

      export function observeTerminalResize() {
        var output = document.getElementById("output");
        if (!output) return;
        var lastKnownDesktop = !isMobileLayout();
        state.resizeHandler = function() {
          scheduleTerminalResize(true);
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
          var now = Date.now();
          var chunkPause = state.lastChunkAt > 0 && (now - state.lastChunkAt > 300);
          var resyncDue = (now - state.lastTerminalResyncAt) > 30000;
          var dirtySinceResync = state.lastChunkAt > state.lastTerminalResyncAt;
          if (resyncDue && dirtySinceResync && (chunkPause || selectedSession.status !== "running") && state.terminalOutput) {
            softResyncTerminal();
          }
        }, 5000);
      }

      export function stopTerminalHealthCheck() {
        if (state.terminalHealthTimer) {
          clearInterval(state.terminalHealthTimer);
          state.terminalHealthTimer = null;
        }
      }

      export function teardownTerminal() {
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
        // wterm.destroy() 不移除 .terminal-scroll-wrap 节点，手动清掉防叠层。
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

      export function sendTerminalResize(cols, rows) {
        if (!state.selectedId) return;
        var selectedSess = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSess || selectedSess.status !== "running") return;
        if (isStructuredSession(selectedSess)) return;
        // clamp 到 wterm maxCols (256) 和后端 maxRows (160)。
        if (cols > 256) cols = 256;
        if (rows > 160) rows = 160;
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

      export function ensureTerminalFit(reason?, options?) {
        if (!state.terminal) return false;
        var opts = options || {};
        var forceReplay = opts.forceReplay === true;
        var el = document.getElementById("output");
        if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
          ensureTerminalFitWithRetry(reason || "fit-retry", { forceReplay: forceReplay });
          return false;
        }
        // 提前快照 stick-to-bottom 意图，避免 rAF 期间 scroll 事件污染判定。
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
            var didResize = state.terminal.cols !== prevCols
                         || state.terminal.rows !== prevRows;
            if (!didResize && forceReplay && state.terminalOutput) {
              softResyncTerminal({ skipFit: true });
            }
            if (shouldStickToBottom) {
              maybeScrollTerminalToBottom("force");
            }
          });
        });
        return true;
      }

      export function ensureTerminalFitWithRetry(reason?, options?) {
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
            ensureTerminalFit(reason, { forceReplay: forceReplay });
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

      export function syncTerminalSize() {
        if (!state.terminal) return;
        var shouldStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
        if (shouldStickToBottom) {
          maybeScrollTerminalToBottom("force");
        }
        sendTerminalResize(state.terminal.cols, state.terminal.rows);
      }
