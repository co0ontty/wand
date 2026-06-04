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
        var root = document.documentElement;
        var body = document.body;
        var bodyRectHeight = 0;
        try {
          bodyRectHeight = body ? body.getBoundingClientRect().height || 0 : 0;
        } catch (e) {}
        return Math.max(
          window.innerHeight || 0,
          vv && vv.height || 0,
          root ? root.clientHeight || 0 : 0,
          body ? body.clientHeight || 0 : 0,
          bodyRectHeight
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

      export function shouldUseClosedViewportBaseline(isKeyboardOpen, offsetTop, height, baselineHeight) {
        if (isKeyboardOpen || !isStandaloneViewportMode()) return false;
        if (Date.now() > closedViewportBaselineUntil) return false;
        return offsetTop > 0 || baselineHeight > height + 1;
      }

      export function shouldUseStandaloneFullViewport(isKeyboardOpen, offsetTop, height, baselineHeight) {
        if (isKeyboardOpen || !isStandaloneViewportMode()) return false;
        // iOS PWA can report a visualViewport that is shorter than the actual
        // app window even when the keyboard is closed. If we mirror that value,
        // the fixed app container stops early and leaves a large blank strip
        // under the composer. Closed standalone mode should fill the app window.
        return offsetTop > 0 || baselineHeight > height + 1;
      }

      export function syncAppViewportHeight(isKeyboardOpen) {
        var vv = window.visualViewport;
        if (!vv) return;
        var root = document.documentElement;
        // Wand APK 原生 IME 路径：MainActivity 已逐帧 setPadding，WebView 内容已被
        // 原生层 resize。这里把 top 钉 0、height 设 vv.height 即可，不要再额外
        // pan/scroll 兜底，避免跟原生 padding 打架抖一帧。
        if (window.__wandImeNative) {
          root.style.setProperty('--app-viewport-top', '0px');
          root.style.setProperty('--app-viewport-height', Math.round(vv.height) + 'px');
          return;
        }
        // 直接锚定到 visual viewport。Math.max(0, ...) 防御 vv 边界场景里 offsetTop
        // 出负数（旋转 / 折叠屏切折 / iOS 26 早期版本曾有报告）。
        var baselineHeight = refreshAppViewportBaseline(vv);
        var offsetTop = Math.max(0, Math.round(vv.offsetTop || 0));
        var height = Math.max(1, Math.round(vv.height));
        // iOS PWA 在键盘收起后偶发只回弹 visualViewport 的一部分：
        // vv.height/offsetTop 还残留几十像素，但之后不再触发 resize/scroll。
        // 关闭键盘的 settle 窗口内用已知的非键盘基线兜住，避免输入框底部
        // 留出一截空白。
        if (
          shouldUseStandaloneFullViewport(isKeyboardOpen, offsetTop, height, baselineHeight)
          || shouldUseClosedViewportBaseline(isKeyboardOpen, offsetTop, height, baselineHeight)
        ) {
          offsetTop = 0;
          height = Math.max(height, baselineHeight);
        }
        root.style.setProperty('--app-viewport-top', offsetTop + 'px');
        root.style.setProperty('--app-viewport-height', height + 'px');
        // 防御性清掉 iOS Safari 在聚焦输入框时遗留的 layout scroll —— 不再用于
        // 对齐布局，纯粹是避免「页面整体上推一截 + 用户手动滚回时撞 overflow:hidden
        // 没反应」的怪状态。在 PWA standalone 里这是 no-op，无副作用。
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
          if (offsetBottom > 80) return true;
          // iOS/Chrome iOS sometimes resize window.innerHeight together with
          // visualViewport.height, so offsetBottom stays near zero. The
          // focused-editable + baseline shrink path catches that case.
          if (hasEditableFocus && (shrinkFromLargest > 120 || innerShrinkFromLargest > 120)) return true;
          // During close animation focus can disappear before viewport height
          // is fully restored. Keep the "open" state until the shrink is small.
          if (keyboardOpen && (shrinkFromLargest > 80 || offsetBottom > 32)) return true;
          return false;
        }

        function scheduleViewportSettle() {
          viewportSettleTimers.forEach(function(timer) { clearTimeout(timer); });
          // 多档延迟覆盖键盘动画 + iOS 26 PWA 在动画末尾「再 pan 一次」的尾巴，
          // 也覆盖部分场景下 vv.resize 只在动画起点 / 终点各触发一次的边界条件。
          // 每档都会重新读取 vv.offsetTop / vv.height（已经从 hack 切换到直接锚定），
          // 因此即便 visualViewport 中段不触发事件，最后这些 settle tick 也能把
          // top/height 校准到真实值。
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

          // 键盘开/关与视口尺寸变化时同步 --app-viewport-height，
          // 让 body 高度跟随可见区域，input-panel 自然贴键盘上沿。
          syncAppViewportHeight(isKeyboardOpen);

          if (isKeyboardOpen && (!keyboardOpen || heightChanged) && shouldAdjustForKeyboard(vv, inputBox)) {
            syncInputBoxScroll(inputBox);
          }

          // Keyboard just opened — terminal viewport now shares space with
          // the keyboard; visible rows shrink even if cols stayed the same.
          // Without an immediate refit, any chunk arriving while the keyboard
          // animates in renders against the old grid and tears the screen.
          if (!keyboardOpen && isKeyboardOpen) {
            // Snapshot bottom-pinned intent BEFORE the layout starts shifting.
            // visualViewport.resize fires while the keyboard is still mid-
            // animation on iOS; if we wait until ensureTerminalFit's rAF
            // body executes, clientHeight has already shrunk and the user
            // who was visibly at the bottom registers as "scrolled up".
            // We pass the snapshot through to a delayed catch-up so the
            // final scroll lands AFTER the animation settles.
            var wasStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
            ensureTerminalFit("keyboard-open", { forceReplay: true });
            // 等键盘动画跑完再 sync 一次。直接锚定模式下，这一帧的 vv.offsetTop /
            // vv.height 已经是稳定终值，不再需要 scrollTo 兜底；只是有些场景中段
            // visualViewport 不会再触发事件，这里手动补一次。
            // Wand APK (__wandImeNative=true) 走原生 IME callback，跳过避免抖。
            if (!window.__wandImeNative) {
              setTimeout(function() {
                syncAppViewportHeight(true);
              }, 220);
            }
            scheduleViewportSettle();
            // Mirror the keyboard-close 200ms delay: by then the iOS / Android
            // keyboard slide-in animation is done, vv.height is final, and
            // scrollHeight reflects the post-replay grid. One more force
            // scroll closes the gap between "we scrolled during animation
            // when scrollHeight was still in flux" and "user expects to see
            // the bottom now that the keyboard has fully settled".
            if (wasStickToBottom) {
              setTimeout(function() {
                if (!state.terminal) return;
                maybeScrollTerminalToBottom("force");
              }, 220);
            }
          }

          // Keyboard just closed — force terminal refit and scroll to bottom
          // after a delay so the keyboard dismiss animation and layout settle.
          if (keyboardOpen && !isKeyboardOpen) {
            // 键盘收起：iOS 经常不触发 textarea.blur（系统 Done / 下滑收起 /
            // 应用切回来都属于这种情况），所以单靠 handleInputBoxBlur 不够，
            // 必须在 visualViewport 维度也独立兜一次。
            //
            // 直接锚定模式下，这里只需要再读一次 vv.offsetTop / vv.height 把
            // top/height 校准到键盘收起后的最终值即可。settle timers (60/180/
            // 360/620/900ms) 再多读几次 vv，应对 iOS 26 PWA 偶发的「vv.height
            // 已经回弹但 offsetTop 还残留 50~100px、几百毫秒后才清零」尾巴。
            //
            // Android APK (window.__wandImeNative=true) 跳过：MainActivity 已经
            // 在 IME 动画 callback 里逐帧 setPadding，原生层已经把内容 resize 到位。
            var imeIsNative = !!window.__wandImeNative;
            if (!imeIsNative) {
              markClosedViewportBaselineWindow(2200);
              syncAppViewportHeight(false);
            }
            scheduleViewportSettle();
            setTimeout(function() {
              if (!imeIsNative) {
                syncAppViewportHeight(false);
              }
              ensureTerminalFit("keyboard-close", { forceReplay: true });
              // 同 handleInputBoxBlur：尊重 terminalAutoFollow，避免把上滚
              // 阅读历史的用户在键盘关闭瞬间拽回底部。
              maybeScrollTerminalToBottom("keyboard");
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

        // iOS PWA standalone 还有几个边界场景 visualViewport 不会触发 resize：
        //  · 用户切到别的 app 再切回来：vv 状态可能停在切走时的旧值，需要主动复位。
        //  · iOS 26 偶发：键盘已经收起、vv.height 已经回弹，但 vv.offsetTop 还残留
        //    几十像素，过几百毫秒后才静默清零，期间不再 emit resize。
        //  · 历史 bfcache 复活 (pageshow.persisted === true)：所有计算都需要重做。
        // 这几个监听都跑同一个 debouncedUpdate，路径上已经覆盖 settle timers。
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'visible') {
            debouncedUpdate();
            // 复活后短暂窗口期内 iOS 可能继续微调 vv，再补几次 settle。
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
        // document 级 focusout 兜底：用户在 iOS 上从输入框失焦但 textarea blur 没
        // 触发的情况（极少数 webview 边界），focusout 仍会冒泡到 document。
        document.addEventListener('focusout', function(e) {
          if (!e || !e.target) return;
          if (!isEditableFocusTarget(e.target)) return;
          scheduleClosedViewportBaselineWindow(1600, e.target);
          // 让 vv 先有机会反应一下键盘动画再复位。
          setTimeout(debouncedUpdate, 80);
          setTimeout(debouncedUpdate, 420);
        });

        updateViewport();
      }

      export function initTerminalResizeHandle() {
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

      // ====== 终端悬浮摇杆遥控器（手机端 PTY 遥控） ======
      // 纯前端覆盖层：fixed 挂到 body，绕开 #output 的 overflow:hidden 裁切。
      // 用 Pointer Events 统一鼠标/触摸；球球 touch-action:none 让 preventDefault 稳定。
      // 不改动终端背景的 touch/scroll/wheel —— 单指空白处仍是原生滚动看历史。

      export function isJoystickAvailable() {
        // 触屏与桌面网页端都显示（球球用 Pointer Events，鼠标拖拽同样可用）。
        // 不再用 currentView/isStructuredSession 关掉:
        // - chat 视图 (含 PTY Claude 的对话视图): 用户偶尔要给底层 PTY 发
        //   方向键 / Esc / Shift+Tab 选权限菜单, 但只能切到 terminal 视图才点
        //   摇杆 —— 现在 chat 视图直接可用。sendJoystickKey 已经走 /input
        //   接口, 服务端不挑视图。
        // - 结构化会话: 大多数键 (方向 / Tab) 在 SDK runner 里没真实 effect,
        //   但 Ctrl+C / Esc 都映射到 query.interrupt() 中断当前回复, 用户
        //   场景是"等不及当前回答, 想停掉重发"。sendJoystickKey 里按 session
        //   类型分支处理: PTY 走原本 sequence, 结构化只接受中断意图键。
        var session = getSelectedSession();
        if (!session) return false;
        return true;
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
        if (state.joystickRootEl) return;   // 已存在不重复建（触屏/桌面均构建）

        var root = document.createElement("div");
        root.className = "wand-joystick-root";

        var backdrop = document.createElement("div");
        backdrop.className = "wand-joystick-backdrop";
        root.appendChild(backdrop);

        // 钉住面板
        var panel = document.createElement("div");
        panel.className = "wand-joystick-panel";
        panel.innerHTML = renderJoystickPanel();
        panel.addEventListener("click", onJoystickPanelClick);
        root.appendChild(panel);

        // 球球本体
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
        ball.addEventListener("click", function(e) {
          e.preventDefault();
          e.stopPropagation();
        });
        backdrop.addEventListener("pointerdown", function(e) {
          // 钉住面板开着且无进行中手势时，点遮罩收起面板
          if (state.joystickPinnedOpen && state.joystickGesture == null) {
            e.preventDefault();
            closeJoystickPanel();
          }
        });
        backdrop.addEventListener("click", function(e) {
          e.preventDefault();
          e.stopPropagation();
        });

        // 旋转/窗口尺寸变化时重新钳制球球位置
        state.joystickResizeHandler = function() { applyJoystickPosition(); };
        window.addEventListener("resize", state.joystickResizeHandler);
        window.addEventListener("orientationchange", state.joystickResizeHandler);

        updateJoystickVisibility();
      }

      export function onJoystickPointerDown(e) {
        if (!isJoystickAvailable()) return;
        if ((e.pointerType === "mouse" || e.pointerType === "pen") && e.button !== 0) return;
        if (state.joystickPointerId !== null) return;  // 已有手势在进行
        e.preventDefault();
        e.stopPropagation();
        var canDirectDrag = e.pointerType === "mouse" || e.pointerType === "pen";
        state.joystickPointerId = e.pointerId;
        state.joystickPressStart = { x: e.clientX, y: e.clientY, t: Date.now() };
        state.joystickGesture = "pending";
        try { state.joystickBallEl.setPointerCapture(e.pointerId); } catch (err) {}
        if (canDirectDrag) {
          state.joystickMoveHandler = onJoystickPointerMove;
          state.joystickUpHandler = onJoystickPointerUp;
          document.addEventListener("pointermove", state.joystickMoveHandler);
          document.addEventListener("pointerup", state.joystickUpHandler);
          document.addEventListener("pointercancel", state.joystickUpHandler);
          return;
        }
        // 起长按定时器：不动到 400ms → 移动模式
        state.joystickLongPressTimer = setTimeout(function() {
          if (state.joystickGesture === "pending") enterJoystickMoveMode();
        }, JOYSTICK_LONG_PRESS_MS);
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
        if (e.pointerId !== state.joystickPointerId) return;
        if (!state.joystickBallEl) return;
        e.preventDefault();
        var dxStart = e.clientX - state.joystickPressStart.x;
        var dyStart = e.clientY - state.joystickPressStart.y;
        if (state.joystickGesture === "pending") {
          if (Math.sqrt(dxStart * dxStart + dyStart * dyStart) > JOYSTICK_MOVE_THRESHOLD) {
            if (e.pointerType === "mouse" || e.pointerType === "pen") {
              enterJoystickMoveMode();
              moveJoystickBallTo(e.clientX, e.clientY);
              return;
            }
            if (state.joystickLongPressTimer) {
              clearTimeout(state.joystickLongPressTimer);
              state.joystickLongPressTimer = null;
            }
            // Quick swipe used to open the radial shortcut menu. That shortcut
            // is intentionally disabled; keep tap-to-open and long-press drag.
            state.joystickGesture = "cancelled";
            return;
          } else {
            return;
          }
        }
        if (state.joystickGesture === "move") {
          moveJoystickBallTo(e.clientX, e.clientY);
          return;
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
        // 钉住面板若仍开着则保留遮罩，否则移除
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
        // ── 结构化会话分支 ──
        // SDK / claude -p 通道没有 PTY 可写, 把原始 escape 序列丢给
        // /api/sessions/:id/input 会被结构化 sendMessage 当成对话文本 (例如
        // 把 "\x1b[A" 作为 prompt 发出去), 既无效又污染上下文。
        // 这里按"中断意图"白名单转发: Ctrl+C / Esc → query.interrupt()。
        // 其他键 (方向 / Enter / Shift+Tab) 在结构化里没有合理 mapping, 静默
        // no-op, 同时震一下做反馈。
        if (session && isStructuredSession(session)) {
          if (key === "ctrl_c" || key === "escape") {
            interruptStructuredSessionFromJoystick(session, key);
          }
          // 不论是否真发出去, 都消化掉修饰键 + 更新 UI, 避免下次发送残留状态
          clearModifiers();
          updateJoystickPanelUI();
          return;
        }
        // ── PTY 会话原路径 ──
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

      // 摇杆触发的结构化会话中断: 复用 /api/structured-sessions/:id/messages
      // 的 interrupt=true 路径 (sendMessage 内部走 query.interrupt 优雅停止,
      // 失败 fallback 到 abortController.abort)。空 input + interrupt=true =
      // "停掉当前回复但不发新消息", 跟用户从摇杆按 Ctrl+C/Esc 的预期一致。
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
          // 已经在 SDK 内部完成 / 没有 pending query 时, 服务端会返回 400,
          // 这里静默吃掉, 避免给用户冒出"中断失败"toast (按了也是想停, 没东西可停就当成功)。
          if (window && window.console && err && err.message) {
            console.debug("[wand] joystick interrupt no-op:", err.message);
          }
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
        // 面板锚定在球球上方（球球在右下→面板往左上展开），贴右/底边对齐
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
          // 不可用：强制收手势 + 收面板 + 停连发 + 清修饰键，杜绝残留
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
          // Handle sidebar pin state across mobile/desktop breakpoint
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

      export function startTerminalHealthCheck() {
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
          // RENDER-2: 仅在"自上次 resync 以来确有新输出"时才重放。静止/已结束会话
          // buffer 不再变化，30s 周期 resync 是纯无用功，还会把 cursor-home 中间帧
          // 重堆进 scrollback、扰动滚动位置。lastChunkAt>lastTerminalResyncAt 即脏。
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
        // LIFE-1: 清理 initTerminalScrollbar 注册的 hide-timer 与拖拽状态。否则
        // hide-timer 闭包引用游离节点（置 El=null 拦不住它），且若拖拽中途 teardown，
        // 残留 dragging=true 会让新会话 scrollbar 的 scheduleHideScrollbar 被永久抑制
        // （开头 if(dragging)return）→ 滚动条出现后再也不自动消失。
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
        // sync output 缓冲跨会话也要清，否则旧会话最后没收完的 ?2026h 帧
        // 会让新会话的首批 PTY 字节全部被吞进 buffer 等永远不会来的 end。
        state.syncOutputBuffer = null;
        state.syncOutputDeadline = 0;
        state.syncFramingResidue = false;
        state.terminalSessionId = null;
        state.terminalOutput = "";
        state.terminalOutputMarker = 0; // R8: teardown 时重置 /clear marker
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
        if (state._resyncChunkTailTimer) {
          clearTimeout(state._resyncChunkTailTimer);
          state._resyncChunkTailTimer = null;
        }
        state._resyncChunkLastAt = 0;
        state._resyncStatsWindowStart = 0;
        state._resyncStatsCount = 0;
        state._resyncLastWarnAt = 0;
        state._resyncInProgress = false;
        // SIZE-2: lastResize 是全局去重缓存，记"上次 POST 的尺寸"。切到另一个在不同
        // 尺寸下创建的会话时，若新算出的 cols/rows 恰好等于上次值会被去重跳过，导致
        // 后端该会话列宽停在旧值、整段折行。teardown 重置后新会话首次 resize 必发出。
        state.lastResize = { cols: 0, rows: 0 };
        teardownJoystick();
      }

      export function sendTerminalResize(cols, rows) {
        if (!state.selectedId) return;
        var selectedSess = state.sessions.find(function(s) { return s.id === state.selectedId; });
        // 会话已被清除（如服务重启后 localStorage 还残留旧 id），后端 resize 会
        // 直接 400/404，console 留一条红色错误；这里提前剪掉，避免噪音。
        if (!selectedSess || selectedSess.status !== "running") return;
        if (isStructuredSession(selectedSess)) return;
        // wterm WASM grid 的 maxCols 硬编码 256。POST 给服务端的 cols 也同步
        // clamp，避免服务端 pty.resize 给 Claude 一个 wterm 实际渲不下的列宽。
        if (cols > 256) cols = 256;
        // SIZE-1: rows 也 clamp 到后端上限 160（process-manager clampDimension 10..160）。
        // 否则高分屏+小字号客户端算出 rows>160 时，后端压到 160，客户端网格底部多出的
        // 行对应的 PTY 内容永不写入 → 底部大片空白 / 光标错位 / 全屏菜单画到不存在的行。
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
      export function ensureTerminalFit(reason, options) {
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
        // Snapshot stick-to-bottom intent NOW, before any layout work.
        // Two concrete bugs this guards against:
        //   1. Mobile keyboard opens → visualViewport shrinks → terminal
        //      clientHeight drops while scrollTop stays put → by the time
        //      the rAF body runs, isTerminalNearBottom() reads false even
        //      though the user was visibly pinned to the bottom a frame ago.
        //   2. Any softResyncTerminal triggered below does resetTerminal()
        //      (scrollTop snaps to 0) then re-writes; the wterm element
        //      can fire intermediate scroll events that flip
        //      terminalAutoFollow to false before we get a chance to
        //      scroll back.
        // Both failure modes left users mid-buffer after a resize. We
        // capture the intent up front and use "force" below to bypass
        // the (now-poisoned) flag check inside maybeScrollTerminalToBottom.
        var shouldStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
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
            if (shouldStickToBottom) {
              maybeScrollTerminalToBottom("force");
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
      export function ensureTerminalFitWithRetry(reason, options) {
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

      export function scheduleTerminalResize(immediate) {
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
        // Force-scroll (vs the weaker maybeScrollTerminalToBottom("resize"))
        // for the same reason ensureTerminalFit does: between this entry
        // and the actual scroll, the wterm DOM may fire scroll events that
        // poison terminalAutoFollow. Capturing intent now + force-scrolling
        // keeps a user who was visibly at the bottom pinned there across
        // window/orientation/viewport resizes.
        var shouldStickToBottom = state.terminalAutoFollow || isTerminalNearBottom();
        if (shouldStickToBottom) {
          maybeScrollTerminalToBottom("force");
        }
        sendTerminalResize(state.terminal.cols, state.terminal.rows);
      }
