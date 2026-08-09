import { state } from "./state";
import { escapeHtml } from "./utils";
import { doRenderChat, scheduleChatRender } from "./chat-render";
import { bindChatScrollListener, persistSelectedId } from "./chat-scroll";
import { isMobileLayout } from "./file-browser";
import { _swipeState, closeSwipedItem, deleteClaudeHistoryDirectory, deleteSession, executeDeleteHistory, focusInputBox, getHistoryItemsByCwd, getSelectedSession, handleDeleteCodexHistoryAction, handleResumeAction, handleResumeCodexHistoryAction, handleResumeHistoryAction, hasActiveTerminalSelection, resumeClaudeHistorySession, resumeCodexHistorySession, resumeSessionFromList, setDeletingState, switchToSessionView } from "./input";
import { showToast } from "./notifications";
import { render } from "./render";
import { applyCurrentView, closeSessionsDrawer, copyToClipboard, dismissDrawerIfOverlay, isStructuredSession, loadSessions, openSessionModal, openWorktreeMergeModal, retryWorktreeCleanup, selectSession, updateSessionsList } from "./session-engine";
import { ensureTerminalFit, initTerminalJoystick, initTerminalResizeHandle, observeTerminalResize, sendTerminalResize, startTerminalHealthCheck } from "./viewport";
import { t } from "./i18n";
import { batchDeleteSelected, clearAllClaudeHistory, clearSelections, confirmDelete, ensureClaudeHistoryLoaded, getVisibleClaudeHistorySessions, selectAllVisibleItems, toggleManageMode, toggleManagedItemSelection } from "./sidebar";
import { consumeTerminalWheelPage, terminalWheelPageSequence, type TerminalWheelPagingState } from "./terminal-wheel";

      export function saveWorkingDir(path: string) {
        state.workingDir = path;
        try {
          localStorage.setItem("wand-working-dir", path);
        } catch (e) {
          // Ignore localStorage errors
        }
        addRecentPath(path);
      }

      export function addRecentPath(path: string) {
        return fetch("/api/recent-paths", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ path: path })
        }).catch(function() {});
      }

      export function activateSessionItem(sessionId: string) {
        var session = state.sessions.find(function(s: any) { return s.id === sessionId; });
        if (session && session.status !== "running" && !isStructuredSession(session)) {
          resumeSessionFromList(sessionId);
        } else {
          selectSession(sessionId);
        }
        // 桌面常驻栏与窄条形态都保留；只在手机端真的有 overlay drawer 时才收。
        // （旧条件 !sidebarPinned || isMobileLayout() 在桌面 not-pinned 状态下也会
        // 调 closeSessionsDrawer，靠内部 early-return 才不至于出错——含义不清晰，
        // 统一走 dismissDrawerIfOverlay 反过来表达"只收 overlay 不撤常驻"。）
        dismissDrawerIfOverlay();
      }

      export function handleSessionItemClick(event: any) {
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
            resumeCollapsed(historyCid, historyCwd)
              .then(function(data: any) {
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
            toggleManagedItemSelection(actionButton.dataset.kind!, actionButton.dataset.id!);
          } else if (actionButton.dataset.action === "swipe-delete-session" && actionButton.dataset.sessionId) {
            deleteSession(actionButton.dataset.sessionId);
          } else if (actionButton.dataset.action === "delete-session" && actionButton.dataset.sessionId) {
            (function(sid: string) {
              confirmDelete("确认删除这个会话吗？此操作无法撤销。", { title: "删除会话" }).then(function(ok: any) {
                if (ok) deleteSession(sid);
              });
            })(actionButton.dataset.sessionId);
          } else if (actionButton.dataset.action === "delete-history" && actionButton.dataset.claudeSessionId) {
            (function(cid: string, item: any) {
              confirmDelete("确认删除这条 Claude 会话吗？", { title: "删除会话" }).then(function(ok: any) {
                if (ok) executeDeleteHistory(cid, item);
              });
            })(actionButton.dataset.claudeSessionId, actionButton.closest(".session-item"));
          } else if (actionButton.dataset.action === "toggle-history-directory" && actionButton.dataset.cwd) {
            var dirCwd = actionButton.dataset.cwd;
            state.claudeHistoryExpandedDirs[dirCwd] = !state.claudeHistoryExpandedDirs[dirCwd];
            updateSessionsList();
          } else if (actionButton.dataset.action === "delete-history-directory" && actionButton.dataset.cwd) {
            (function(deleteCwd: string, btn: any) {
              var items = getHistoryItemsByCwd(deleteCwd);
              var dirCount = getVisibleClaudeHistorySessions().filter(function(s: any) { return s.cwd === deleteCwd; }).length;
              confirmDelete("确认清空此目录下的 " + dirCount + " 条 Claude 历史吗？", {
                title: "清空目录历史",
                okLabel: "清空",
              }).then(function(ok: any) {
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

        var item = target.closest(".session-item") as HTMLElement | null;
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
            resumeItem(claudeSessionId, cwd)
              .then(function(data: any) {
                if (data && data.id) {
                  state.selectedId = data.id;
                  persistSelectedId();
                  state.drafts[data.id] = "";
                  loadSessions().then(function() {
                    selectSession(data.id);
                    // 桌面常驻/窄条形态不要撤掉，只把手机端 overlay 收掉。
                    dismissDrawerIfOverlay();
                  });
                }
              });
          }
        }
      }

      export function handleSessionItemKeydown(event: any) {
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
          resumeItem(claudeSessionId, cwd)
            .then(function(data: any) {
              if (data && data.id) {
                state.selectedId = data.id;
                persistSelectedId();
                state.drafts[data.id] = "";
                loadSessions().then(function() {
                  selectSession(data.id);
                  // 桌面常驻/窄条形态不要撤掉，只把手机端 overlay 收掉。
                  dismissDrawerIfOverlay();
                });
              }
            });
        }
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

      export function getTerminalViewport() {
        if (!state.terminal || !state.terminal.element) return null;
        state.terminalViewportEl = state.terminal.element.querySelector(".xterm-viewport");
        return state.terminalViewportEl;
      }

      export function clearTerminalScrollIdleTimer() {
        if (state.terminalScrollIdleTimer) {
          clearTimeout(state.terminalScrollIdleTimer);
          state.terminalScrollIdleTimer = null;
        }
      }

      export function updateTerminalJumpToBottomButton() {
        var button = document.getElementById("terminal-jump-bottom");
        var shouldShow = !!state.selectedId
          && state.currentView === "terminal"
          && !state.terminalAutoFollow
          // SCROLL-2: 隐藏判据用严格 2px(isTerminalAtBottom) 而非 12px。否则距底
          // 3–12px 区间 autoFollow 恒 false(scroll handler 只在 ≤2px 才恢复)却又
          // 因 isTerminalNearBottom()=true 隐藏按钮 → 既不跟随又无回底入口的死区。
          && !isTerminalAtBottom();
        state.showTerminalJumpToBottom = shouldShow;
        if (button) {
          button.classList.toggle("visible", shouldShow);
        }
        var termContainer = document.getElementById("output");
        if (termContainer) termContainer.classList.toggle("has-jump-btn", shouldShow);
      }

      export function isTerminalNearBottom() {
        var viewport = getTerminalViewport();
        if (!viewport) return true;
        var distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        return distance <= state.terminalScrollThreshold;
      }

      // 严格"真正到底"判定（仅亚像素 jitter 容忍）：用于把 autoFollow 从 false
      // 翻回 true。不能用 isTerminalNearBottom 的 12px 阈值，否则用户在底部小幅
      // 向上滚时，wheel handler 把 autoFollow 设 false 后紧接着触发的 scroll
      // 事件会因为"还没滚出阈值"而把 autoFollow 反转回 true，丢失用户意图。
      export function isTerminalAtBottom() {
        var viewport = getTerminalViewport();
        if (!viewport) return true;
        var distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        return distance <= 2;
      }

      export function scrollTerminalToBottom(smooth?: boolean) {
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

      export function setTerminalManualScrollActive() {
        state.terminalAutoFollow = false;
        clearTerminalScrollIdleTimer();
        state.terminalProgrammaticScrollUntil = 0;
        updateTerminalJumpToBottomButton();
      }

      export function maybeScrollTerminalToBottom(reason?: string) {
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

      // ===== Touch scroll (mobile) =====
      // xterm.js v6 ships no touch handler (its bindMouse() only wires
      // mousedown + wheel), so on a touch device the scrollback is unreachable
      // and full-screen TUIs (vim/less/htop) can't be paged. Drive both from a
      // single-finger vertical drag on the terminal surface, mirroring the
      // wheel path: normal buffer scrolls the xterm scrollback (content follows
      // the finger), alternate buffer reuses the wheel→Page Up/Down paging.
      // Bound on termWrap, which is recreated on every terminal re-init, so the
      // listeners die with the node — no manual teardown is needed.
      export function initTerminalTouchScroll(surface: HTMLElement, term: any) {
        var touchId: number | null = null;
        var lastY = 0;
        var rowHeight = 16;
        var pagingState: TerminalWheelPagingState = {
          direction: 0,
          accumulatedPixels: 0,
          lastEventAt: 0,
          lastPageAt: 0,
        };

        surface.addEventListener("touchstart", function(e: TouchEvent) {
          if (e.touches.length !== 1) {
            touchId = null;
            return;
          }
          var t = e.touches[0];
          touchId = t.identifier;
          lastY = t.clientY;
          // Re-read the row height per gesture: native shells (Android/iOS)
          // inject --term-row-height via a <style> added after page load, so a
          // one-shot read at init can still hold the pre-override default.
          var raw = getComputedStyle(surface).getPropertyValue("--term-row-height").trim();
          var parsed = parseFloat(raw);
          if (parsed > 0) rowHeight = parsed;
          // Fresh gesture: reset the paging accumulator so a slow start does
          // not bleed into the next page decision.
          pagingState.direction = 0;
          pagingState.accumulatedPixels = 0;
          pagingState.lastEventAt = 0;
          pagingState.lastPageAt = 0;
        }, { passive: true });

        surface.addEventListener("touchmove", function(e: TouchEvent) {
          if (touchId === null) return;
          var touch: Touch | null = null;
          for (var i = 0; i < e.touches.length; i++) {
            if (e.touches[i].identifier === touchId) { touch = e.touches[i]; break; }
          }
          if (!touch) return;
          var dy = touch.clientY - lastY;
          lastY = touch.clientY;
          if (dy === 0) return;

          // Take over the gesture so the WebView neither bounces the page nor
          // starts a text selection; this drag is a scroll.
          e.preventDefault();

          var isAlternate = term.buffer.active.type === "alternate";
          if (isAlternate) {
            // The wheel helper maps deltaY<0 → PageUp, deltaY>0 → PageDown.
            // Touch uses natural scrolling (content follows the finger), so feed
            // the inverted delta: finger up (dy<0) → PageDown (reveal newer).
            var direction = consumeTerminalWheelPage(
              { deltaY: -dy, deltaMode: 0 },
              pagingState,
              term.rows * rowHeight,
              Date.now(),
            );
            var seq = terminalWheelPageSequence(direction);
            if (seq) sendPtyInput(seq);
          } else {
            // Normal buffer: scroll the scrollback. scrollLines(+) moves toward
            // older lines, matching finger-down (dy>0) revealing older output.
            var lines = Math.round(dy / rowHeight);
            if (lines !== 0) {
              term.scrollLines(lines);
              setTerminalManualScrollActive();
            }
          }
        }, { passive: false });

        function endTouch() {
          touchId = null;
        }
        surface.addEventListener("touchend", endTouch, { passive: true });
        surface.addEventListener("touchcancel", endTouch, { passive: true });
      }

      // ===== Custom terminal scrollbar =====
      export function initTerminalScrollbar(container: HTMLElement) {
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
      export var CLIENT_OUTPUT_MAX = 160 * 1024;
      export var CLIENT_OUTPUT_TRIM_AT = 192 * 1024;

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
      export function maybeScheduleResyncForChunk(_chunk?: any) {}

      export function clampClientTerminalOutput(buffer: string) {
        if (!buffer || buffer.length <= CLIENT_OUTPUT_TRIM_AT) return buffer;
        return buffer.slice(-CLIENT_OUTPUT_MAX);
      }

      function sendPtySocketMessage(message: any) {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
        state.ws.send(JSON.stringify(message));
        return true;
      }

      export function sendPtyInput(data: string) {
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

      export function wandTerminalWrite(terminal: any, data: any, ackBytes?: number, sessionId?: string) {
        if (!terminal || data == null || data === "") {
          if (ackBytes && sessionId) acknowledgePtyOutput(sessionId, ackBytes);
          return Promise.resolve();
        }
        var text = String(data);
        var follow = state.terminalAutoFollow !== false;
        var queue = state.terminalWriteQueue || Promise.resolve();
        state.terminalWriteQueue = queue.catch(function() {}).then(function() {
          return new Promise(function(resolve) {
            if (!state.terminal || terminal !== state.terminal) {
              if (ackBytes && sessionId) acknowledgePtyOutput(sessionId, ackBytes);
              resolve(null);
              return;
            }
            terminal.write(text, function() {
              if (follow && terminal === state.terminal) terminal.scrollToBottom();
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
          state.terminalAutoFollow = true;
          if (state.terminalFitAddon && typeof state.terminalFitAddon.fit === "function") {
            state.terminalFitAddon.fit();
            sendTerminalResize(terminal.cols, terminal.rows);
          }
          terminal.scrollToBottom();
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
            background: "#1f1b17",
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
          term.attachCustomKeyEventHandler(function() {
            return state.terminalInteractive === true;
          });
          var wheelPagingState: TerminalWheelPagingState = {
            direction: 0,
            accumulatedPixels: 0,
            lastEventAt: 0,
            lastPageAt: 0,
          };
          term.attachCustomWheelEventHandler(function(event: WheelEvent) {
            // The normal buffer owns real xterm scrollback, so preserve xterm's
            // native pixel/line scrolling there. Full-screen PTY applications
            // use the alternate buffer, which has no local history; translate
            // vertical wheel gestures into the page keys those TUIs understand.
            if (
              term.buffer.active.type !== "alternate"
              || event.ctrlKey
              || event.metaKey
              || Math.abs(event.deltaY) <= Math.abs(event.deltaX)
            ) {
              return true;
            }

            event.preventDefault();
            event.stopPropagation();
            var viewport = getTerminalViewport();
            var direction = consumeTerminalWheelPage(
              event,
              wheelPagingState,
              viewport ? viewport.clientHeight : term.rows * fontSize * 1.25,
            );
            var sequence = terminalWheelPageSequence(direction);
            if (sequence) sendPtyInput(sequence);
            return false;
          });
          var helperTextarea = termWrap.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
          if (helperTextarea) helperTextarea.readOnly = !state.terminalInteractive;
          state.terminal = term;
          // Expose for native shells (macOS / iOS) that need cols/rows/scale
          // without reaching into module-scoped state.
          try { (window as any).__wandTerminal = term; } catch (e) {}
          state.terminalFitAddon = fitAddon;
          state.terminalWriteQueue = Promise.resolve();
          state.terminalInitializing = false;
          fitAddon.fit();

          term.onData(function(data: string) { sendPtyInput(data); });
          term.onBinary(function(data: string) {
            if (state.terminalInteractive) sendPtyInput(data);
          });
          term.onResize(function(size: { cols: number; rows: number }) {
            sendTerminalResize(size.cols, size.rows);
          });

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
