import { state } from "./state";
import { escapeHtml } from "./utils";
import { doRenderChat, normalizeTerminalOutput, scheduleChatRender } from "./chat-render";
import { bindChatScrollListener, persistSelectedId } from "./chat-scroll";
import { applyTerminalScale, isMobileLayout } from "./file-browser";
import { _swipeState, captureTerminalInput, closeSwipedItem, deleteClaudeHistoryDirectory, deleteSession, executeDeleteHistory, focusInputBox, getHistoryItemsByCwd, getSelectedSession, handleDeleteCodexHistoryAction, handleResumeAction, handleResumeCodexHistoryAction, handleResumeHistoryAction, hasActiveTerminalSelection, queueDirectInput, reconcileInteractiveState, resumeClaudeHistorySession, resumeSessionFromList, setDeletingState, switchToSessionView, updateInteractiveControls } from "./input";
import { showToast } from "./notifications";
import { render } from "./render";
import { applyCurrentView, closeSessionsDrawer, copyToClipboard, dismissDrawerIfOverlay, isStructuredSession, loadSessions, openSessionModal, openWorktreeMergeModal, retryWorktreeCleanup, selectSession, updateSessionsList } from "./session-engine";
import { ensureTerminalFit, initTerminalJoystick, initTerminalResizeHandle, observeTerminalResize, sendTerminalResize, startTerminalHealthCheck, stopTerminalHealthCheck, teardownJoystick, teardownTerminal, updateJoystickVisibility } from "./viewport";
import { t } from "./i18n";
import { batchDeleteSelected, clearAllClaudeHistory, clearSelections, confirmDelete, ensureClaudeHistoryLoaded, getVisibleClaudeHistorySessions, selectAllVisibleItems, toggleManageMode, toggleManagedItemSelection } from "./sidebar";

      export function saveWorkingDir(path: string) {
        state.workingDir = path;
        try {
          localStorage.setItem("wand-working-dir", path);
        } catch (e) {
          // Ignore localStorage errors
        }
        addRecentPath(path);
      }

      export function fetchRecentPaths(callback: any) {
        fetch("/api/recent-paths", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(items: any) { callback(items || []); })
          .catch(function() { callback([]); });
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
            resumeClaudeHistorySession(historyCid, historyCwd)
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
          } else if (actionButton.dataset.action === "delete-session" && actionButton.dataset.sessionId) {
            (function(sid: string) {
              confirmDelete("确认删除这个会话吗？此操作无法撤销。", { title: "删除会话" }).then(function(ok: any) {
                if (ok) deleteSession(sid);
              });
            })(actionButton.dataset.sessionId);
          } else if (actionButton.dataset.action === "delete-history" && actionButton.dataset.claudeSessionId) {
            (function(cid: string, item: any) {
              confirmDelete("确认隐藏这条 Claude 历史吗？", { title: "隐藏历史会话", okLabel: "隐藏" }).then(function(ok: any) {
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

        var item = target.closest(".session-item");
        if (item) {
          if (state.sessionsManageMode) {
            if (item.dataset.sessionId) {
              toggleManagedItemSelection("sessions", item.dataset.sessionId);
            } else if (item.dataset.claudeHistoryId) {
              toggleManagedItemSelection("history", item.dataset.claudeHistoryId);
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
            resumeClaudeHistorySession(claudeSessionId, cwd)
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
            toggleManagedItemSelection("history", item.dataset.claudeHistoryId);
          }
          return;
        }
        if (item.dataset.sessionId) {
          activateSessionItem(item.dataset.sessionId);
        } else if (item.dataset.claudeHistoryId) {
          var claudeSessionId = item.dataset.claudeHistoryId;
          var cwd = item.dataset.cwd;
          resumeClaudeHistorySession(claudeSessionId, cwd)
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
        state.terminalViewportEl = state.terminal.element;
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
          viewport.scrollTop = viewport.scrollHeight;
        }
      }

      export function setTerminalManualScrollActive() {
        state.terminalAutoFollow = false;
        clearTerminalScrollIdleTimer();
        // SCROLL-1: 用户一旦表达"看历史"意图，立刻作废任何在途的程序性拽底。
        // 否则一个已排队、尚未 fire 的 wterm rAF _doRender 仍读着旧的
        // _shouldScrollToBottom=true 把视口拽回底，而那次拽底触发的 scroll 事件正好
        // 落在 120ms 程序窗口内被 scroll handler early-return 吞掉——上滚意图被悄悄
        // 撤回。这里同步按掉 wterm 的跟随意图、并清零程序窗口，让紧随的真实 scroll
        // 事件能被 handler 正常复判。
        state.terminalProgrammaticScrollUntil = 0;
        if (state.terminal && "_shouldScrollToBottom" in state.terminal) {
          state.terminal._shouldScrollToBottom = false;
        }
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

      // ──────── East-Asian-Wide padding for wterm WASM ────────
      //
      // wterm's WASM grid (as of @wterm/core 0.1.8/0.1.9) treats every
      // codepoint as occupying exactly 1 cell, while node-pty's backend
      // and Claude Code's TUI emit cursor-positioning sequences that
      // assume CJK / fullwidth / emoji codepoints occupy 2 columns
      // (Unicode TR11 East-Asian-Width = W or F). The mismatch makes
      // every CSI cursor move after CJK output drift by N/2 columns,
      // causing in-place rewrites (thinking spinner, todo list,
      // permission menus) to leave torn residue like "替替换换".
      //
      // Fix: insert U+2060 (Word Joiner — zero-width, unbreakable) after
      // each wide codepoint before handing the byte stream to the WASM
      // grid. The WJ takes one cell, so wide chars now occupy 2 cells —
      // matching the backend's column accounting exactly. The browser
      // renders WJ at zero width, so the visual layout stays correct.
      //
      // The scanner is ANSI-aware: it tracks ESC / CSI / OSC / DCS
      // / PM / APC state across chunk boundaries so wide codepoints
      // inside escape sequences (e.g. OSC window-title payloads) are
      // not padded — that would break sequence parsing.
      export function isEastAsianWide(cp: number) {
        if (cp < 0x1100) return false;
        return (
          (cp >= 0x1100 && cp <= 0x115f) ||
          (cp >= 0x2329 && cp <= 0x232a) ||
          (cp >= 0x2e80 && cp <= 0x303e) ||
          (cp >= 0x3041 && cp <= 0x33ff) ||
          (cp >= 0x3400 && cp <= 0x4dbf) ||
          (cp >= 0x4e00 && cp <= 0x9fff) ||
          (cp >= 0xa000 && cp <= 0xa4cf) ||
          (cp >= 0xac00 && cp <= 0xd7a3) ||
          (cp >= 0xf900 && cp <= 0xfaff) ||
          (cp >= 0xfe30 && cp <= 0xfe4f) ||
          (cp >= 0xff00 && cp <= 0xff60) ||
          (cp >= 0xffe0 && cp <= 0xffe6) ||
          (cp >= 0x1f000 && cp <= 0x1f9ff) ||
          (cp >= 0x20000 && cp <= 0x2fffd) ||
          (cp >= 0x30000 && cp <= 0x3fffd)
        );
      }

      export var WAND_WIDE_FILLER = "⁠";

      export function createWideParserState() { return { mode: "normal" }; }

      // PERF-1: 整块纯 ASCII 且无 ESC ⇒ 无宽字符、无 ANSI 序列，可跳过逐字符扫描。
      export function isAsciiNonEscape(s: string) {
        return !/[^\x00-\x7f]/.test(s) && s.indexOf("\x1b") === -1;
      }

      export function widePadAnsi(data: any, st: any) {
        if (!data) return "";
        var s = String(data);
        // PERF-1: 不在 ANSI 解析中间态、且整块纯 ASCII 无转义时原样返回，省下逐字符
        // 拼接与 U+2060 注入。Claude 流式输出与全量重放大量命中此快路径。
        if (st.mode === "normal" && isAsciiNonEscape(s)) return s;
        var out = "";
        for (var i = 0; i < s.length; i++) {
          var code = s.charCodeAt(i);
          var cp = code;
          var consumed = 1;
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
            var lo = s.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              cp = (code - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
              consumed = 2;
            }
          }
          var ch = consumed === 2 ? s.substr(i, 2) : s.charAt(i);
          switch (st.mode) {
            case "normal":
              if (cp === 0x1b) { st.mode = "esc"; out += ch; }
              else if (cp === 0x9b) { st.mode = "csi"; out += ch; }
              else if (cp === 0x9d || cp === 0x90 || cp === 0x9e || cp === 0x9f) {
                st.mode = "string"; out += ch;
              } else {
                out += ch;
                if (isEastAsianWide(cp)) out += WAND_WIDE_FILLER;
              }
              break;
            case "esc":
              out += ch;
              if (cp === 0x5b) st.mode = "csi";
              else if (cp === 0x5d || cp === 0x50 || cp === 0x58 ||
                       cp === 0x5e || cp === 0x5f) st.mode = "string";
              else st.mode = "normal";
              break;
            case "csi":
              out += ch;
              if (cp >= 0x40 && cp <= 0x7e) st.mode = "normal";
              break;
            case "string":
              out += ch;
              if (cp === 0x07 || cp === 0x9c) st.mode = "normal";
              else if (cp === 0x1b) st.mode = "string-esc";
              break;
            case "string-esc":
              out += ch;
              if (cp === 0x5c) st.mode = "normal";
              else st.mode = "string";
              break;
          }
          i += consumed - 1;
        }
        return out;
      }

      // CSI ?2026 同步输出（DEC mode 2026）的 wand 软实现。Claude Code 用
      //   \x1b[?2026h ... 重画 ... \x1b[?2026l
      // 包裹每一帧 askuserquestion / model / 任意菜单的原地重绘，期望终端
      // 在 end 之前不渲染中间态。@wterm/core 0.1.8 未实现 sync output，于是
      // 我们在 JS 层先 buffer，遇到 end 时一次性下发。这条修复直接解决
      // 菜单逐帧叠加（image 2 的主因）。
      //
      // 安全护栏：
      //   - 单帧字节 > SYNC_OUTPUT_MAX_BYTES → 强制 flush（防 buffer 爆）
      //   - 单帧滞留 > SYNC_OUTPUT_MAX_BUFFER_MS → 强制 flush（防 begin 没 end）
      //   - 没有 ?2026 字节流时透传，零开销
      export var SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
      export var SYNC_OUTPUT_END = "\x1b[?2026l";
      export var SYNC_OUTPUT_MAX_BUFFER_MS = 200;
      export var SYNC_OUTPUT_MAX_BYTES = 256 * 1024;

      export function processSyncOutputFraming(data: string) {
        if (!data) return data;
        // 快路径：当前不在 sync 内、本批数据也不含 begin → 直接透传
        if (state.syncOutputBuffer === null && data.indexOf(SYNC_OUTPUT_BEGIN) === -1) {
          return data;
        }
        var out = "";
        var i = 0;
        while (i < data.length) {
          if (state.syncOutputBuffer !== null) {
            // 在 sync 内：扫到 end 才 flush
            var endIdx = data.indexOf(SYNC_OUTPUT_END, i);
            if (endIdx === -1) {
              state.syncOutputBuffer += data.slice(i);
              if (state.syncOutputBuffer.length > SYNC_OUTPUT_MAX_BYTES
                  || Date.now() > state.syncOutputDeadline) {
                // 护栏：超长/超时强制 flush，避免永久卡死
                out += state.syncOutputBuffer;
                state.syncOutputBuffer = null;
                // FLICKER: 这是 NEW-A 唯一"失手"路径——半个 ?2026 帧被透传给 wterm，
                // 可能渲染错位。打标记让 R6 chunk 兜底 resync 一次（且仅此时触发）。
                state.syncFramingResidue = true;
              }
              return out;
            }
            state.syncOutputBuffer += data.slice(i, endIdx + SYNC_OUTPUT_END.length);
            out += state.syncOutputBuffer;
            state.syncOutputBuffer = null;
            i = endIdx + SYNC_OUTPUT_END.length;
          } else {
            // 不在 sync 内：扫 begin
            var beginIdx = data.indexOf(SYNC_OUTPUT_BEGIN, i);
            if (beginIdx === -1) {
              out += data.slice(i);
              return out;
            }
            // begin 之前的字节立即透传给 wterm
            out += data.slice(i, beginIdx);
            state.syncOutputBuffer = SYNC_OUTPUT_BEGIN;
            state.syncOutputDeadline = Date.now() + SYNC_OUTPUT_MAX_BUFFER_MS;
            i = beginIdx + SYNC_OUTPUT_BEGIN.length;
          }
        }
        return out;
      }

      export function flushSyncOutputBuffer() {
        if (state.syncOutputBuffer !== null) {
          var buffered = state.syncOutputBuffer;
          state.syncOutputBuffer = null;
          return buffered;
        }
        return "";
      }

      // NEW-B (DA1/XTVERSION 应答) 已暂缓：实测在 PTY ECHO 阶段（claude
      // 启动早期 / claude 不在 raw mode 的窗口）回灌的字节会被 PTY 自动
      // echo 到 stdout 并显示成 ^[[?6c^[P>|wterm-wand^[\ 字面字符，污染
      // 终端。需要先在服务端 ProcessManager 写到 PTY master 时识别 ECHO
      // 状态再决定是否回包，挪到 Phase 2 重新设计。

      export function wandTerminalWrite(terminal: any, data: any) {
        if (!terminal || data == null) return;
        if (!state.wideParserState) state.wideParserState = createWideParserState();
        var padded = widePadAnsi(data, state.wideParserState);
        var framed = processSyncOutputFraming(padded);
        // wterm.write 内部用 5px 阈值判定"在底部"，下一帧 _doRender 据此强制
        // scrollTop = scrollHeight。这与 wand 的 autoFollow（"真正到底"才为
        // true，2px 阈值）独立，会把用户主动向上滚的几像素吞掉。覆写为 wand
        // 的 autoFollow 状态，让 autoFollow 成为唯一真相。
        //
        // 时序关键：必须在 terminal.write() 之前先覆写一次，否则 wterm 在 write
        // 内部解析 chunk 时可能同步触发 _doRender → 提前完成 scrollTop=scrollHeight，
        // write 之后再覆写就晚了一帧，用户上滚位置已被吞。write 之后再覆写一次
        // 兜底：wterm 在解析 newline / cursor move / scroll region 时可能把
        // _shouldScrollToBottom 改回 true。
        var follow = state.terminalAutoFollow !== false;
        if ("_shouldScrollToBottom" in terminal) {
          terminal._shouldScrollToBottom = follow;
        }
        if (framed) terminal.write(framed);
        if ("_shouldScrollToBottom" in terminal) {
          terminal._shouldScrollToBottom = follow;
        }
        // wterm 按 follow=true 真的 scrollTop=scrollHeight 时会触发一次程序性的
        // scroll 事件 — 打窗口，让 scroll handler 不要误判为"用户滚回底部"。
        // **只在 follow=true 时打**：follow=false 时 wterm 不会拽底，没有程序事件
        // 要过滤；如果这里也打标，Claude 流式输出 chunk <120ms 一个会让窗口永
        // 不过期，scroll handler 永远 early return，用户哪怕滚回严格底部 autoFollow
        // 也回不到 true，再也走不出"上滚阅读"模式。
        if (follow) {
          state.terminalProgrammaticScrollUntil = Math.max(
            state.terminalProgrammaticScrollUntil,
            Date.now() + 120
          );
        }
        // R6: 在 chunk 热路径上识别原地重绘序列（CSI nA/B/C/D/f/H/J/K），
        // 节流安排一次 softResync 兜底。Claude 用相对光标位移重画菜单时，
        // 如果 NEW-A 的 sync output buffer 因某种原因没拦截到完整帧（比如
        // ?2026 begin 之后跨 200ms 超时强制 flush），CSI 序列残留会让 wterm
        // 错位。此 fallback 仅在真出现错位序列时触发，正常输出零开销。
        // 与 R2 策略 A 配合：移除被动 5 处触发后，这是唯一的主动救场路径。
        maybeScheduleResyncForChunk(data);
      }

      export function resetWideParserState() {
        state.wideParserState = createWideParserState();
      }

      // Strip the wide-pad filler from copied text so users pasting
      // selected terminal output don't get hidden U+2060 sprinkled
      // through every CJK string.
      export function stripWideFillerForCopy() {
        if (typeof document === "undefined") return;
        document.addEventListener("copy", function(e) {
          var sel = window.getSelection && window.getSelection();
          if (!sel || sel.isCollapsed) return;
          var anchor = sel.anchorNode;
          var node = anchor && anchor.nodeType === 3 ? anchor.parentNode : anchor;
          var output = document.getElementById("output");
          if (!output || !node || !output.contains(node)) return;
          // COPY-1: 终端每行被 wterm 补齐到整列宽（空 cell 输出真实空格 + white-space:pre），
          // 选中复制会带一长串行尾空格；同时宽字符后插了零宽填充符 U+2060。两者一起清：
          // 逐行剥 filler + trimEnd。只要选区落在 #output 内就处理（不再要求"含 filler
          // 才改写"，否则纯 ASCII 行的尾随空格漏网）。
          var text = sel.toString();
          var cleaned = text.split("\n").map(function(line) {
            return line.split(WAND_WIDE_FILLER).join("").replace(/[ \t]+$/, "");
          }).join("\n");
          if (cleaned === text) return; // 无可清理内容，交回浏览器默认复制
          if (e.clipboardData) {
            e.clipboardData.setData("text/plain", cleaned);
            e.preventDefault();
          }
        });
      }
      stripWideFillerForCopy();

      // PTY 链路节流不变式：
      //   服务端 OUTPUT_DEBOUNCE_MS  <  CHAT_RENDER_IDLE_MS  ≤  CHAT_RENDER_LIVE_MS
      //   RESYNC_TAIL_MS            ≤  RESYNC_THROTTLE_MS
      // 违反这两条会出现"上游推得比下游消化得快但下游 timer 还没到期"的堵塞。
      export var CHAT_RENDER_LIVE_MS = 150;
      export var CHAT_RENDER_IDLE_MS = 30;

      // state.terminalOutput 仅作 softResyncTerminal 的重放源（wterm 有自己的
      // scrollback），所以必须限长，否则长跑会话每次 resync 都喂几 MB 给 wterm。
      // 裁切优先在行边界（ANSI 状态机此时一定 idle，重放等价），找不到再按字节切
      // 并避开 UTF-16 半截 / ANSI 半截。
      //
      // R10: 客户端 buffer 必须 < 服务端 PTY_OUTPUT_MAX_SIZE=200KB，否则长跑会话
      // 服务端先于客户端裁头，发 init 时携带的 output 是字节 ~56KB 起的尾段，
      // 与客户端本地 0..256KB 的完整 buffer 做 prefix 检查必然失败 → fall back
      // 到 replace 全量重写 → 每次 ws-reconnect / 切 tab 都踩一次 softResync 灾难。
      // 让 client < server 保证客户端永远是服务端的子集，prefix 永远成立。
      export var CLIENT_OUTPUT_MAX = 160 * 1024;
      export var CLIENT_OUTPUT_TRIM_AT = 192 * 1024;
      export function clampClientTerminalOutput(buf: string) {
        if (!buf || buf.length <= CLIENT_OUTPUT_TRIM_AT) return buf;
        var preTrimLen = buf.length;
        // 内部 helper：根据裁掉的字节数同步缩减 marker，保证 marker 始终指向
        // "/clear 之后的字节"。如果 marker 落到了被裁掉的区间里，clamp 到 0
        // （/clear 之前的历史本来就要丢，marker=0 等于 fall back 重放全部）。
        var _adjustMarker = function(trimmedLen: number) {
          if (typeof state === "undefined" || !state) return;
          var mk = state.terminalOutputMarker | 0;
          if (mk <= 0) return;
          var dropped = preTrimLen - trimmedLen;
          state.terminalOutputMarker = mk > dropped ? mk - dropped : 0;
        };
        var start = buf.length - CLIENT_OUTPUT_MAX;
        // UTF-16 low surrogate
        if (start > 0 && start < buf.length) {
          var c0 = buf.charCodeAt(start);
          if (c0 >= 0xdc00 && c0 <= 0xdfff) start++;
        }
        // 优先在 lookahead 内找下一个换行符切割
        var LOOKAHEAD = 4096;
        var upper = Math.min(start + LOOKAHEAD, buf.length);
        for (var i = start; i < upper; i++) {
          if (buf.charCodeAt(i) === 0x0a) {
            var trimmed1 = buf.slice(i + 1);
            _adjustMarker(trimmed1.length);
            return trimmed1;
          }
        }
        // 没换行 → 检查 start 是否落在未结束的 ESC 序列里
        var lookback = Math.max(0, start - 256);
        var escAt = -1;
        for (var j = start - 1; j >= lookback; j--) {
          var c = buf.charCodeAt(j);
          if (c === 0x1b) { escAt = j; break; }
          if (c === 0x07) break;
          if (c >= 0x40 && c <= 0x7e) break;
        }
        if (escAt !== -1) {
          var terminated = false;
          for (var k = escAt + 1; k < start; k++) {
            var ck = buf.charCodeAt(k);
            if (ck === 0x07) { terminated = true; break; }
            if (ck >= 0x40 && ck <= 0x7e) { terminated = true; break; }
          }
          if (!terminated) {
            var ahead = Math.min(start + 256, buf.length);
            for (var m = start; m < ahead; m++) {
              var cm = buf.charCodeAt(m);
              if (cm === 0x07 || (cm >= 0x40 && cm <= 0x7e)) {
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

      export function resetTerminal() {
        if (!state.terminal) return;
        // 优先走 wterm-entry.js 自定义 WTerm 子类暴露的 reset()：它会调用
        // bridge.init(cols, rows) 让 WASM 重新初始化整个状态机——包含
        // grid、光标、属性 *和* scrollback。这是跨会话切换时清空旧
        // scrollback 的唯一可靠方式，避免新会话向上滚还能看到旧会话内容。
        // 单纯写 ANSI RIS (\x1bc) 在 WASM 实现里只清当前 grid，不动 scrollback。
        if (typeof state.terminal.reset === "function") {
          state.terminal.reset();
          resetWideParserState();
          state.syncOutputBuffer = null;
          state.syncOutputDeadline = 0;
          return;
        }
        if (typeof state.terminal.write === "function") {
          state.terminal.write("\x1bc");
        }
        resetWideParserState();
        state.syncOutputBuffer = null;
        state.syncOutputDeadline = 0;
      }

      // Reset wterm WASM grid and replay the full output buffer to clear stale
      // DOM rows left by CSI cursor-jump sequences (Claude permission menus etc.).
      // Replays the *whole* buffer because alt-screen / scroll-region / charset
      // mode switches must be consumed from the start; cutting the middle drops
      // those state-machine instructions and corrupts the grid.
      // Pass { skipFit: true } when the caller already sized the grid (e.g.
      // wterm.onResize fired this resync) — otherwise ensureTerminalFit recurses.
      state._resyncStatsWindowStart = 0;
      state._resyncStatsCount = 0;
      state._resyncLastWarnAt = 0;
      export var RESYNC_BUDGET_WINDOW_MS = 5000;
      export var RESYNC_BUDGET_MAX = 12;
      export var RESYNC_WARN_COOLDOWN_MS = 30000;
      // RENDER-1: softResync 自身的重放（wandTerminalWrite 末尾会调 maybeScheduleResyncForChunk）
      // 不应再触发新一轮 resync，否则从 health-check/onResize/刷新/重连等路径进来时，
      // 整段含 CSI 的 replaySource 会让单次 resync 被放大成 2~3 次全量重放。重放期间置位
      // 此标志，maybeScheduleResyncForChunk 开头据此短路。
      state._resyncInProgress = false;
      export function softResyncTerminal(options?: any) {
        if (!state.terminal || !state.terminalOutput) return false;
        var opts = options || {};
        // R8: 只重放 marker 之后的字节。marker = 0 时等同于"重放整段"（与旧
        // 行为一致）；用户输入过 /clear 后 marker 标到当时 buffer 长度，重放
        // 跳过 /clear 之前的历史，杜绝"/clear 后短暂闪回旧内容"。
        var marker = state.terminalOutputMarker | 0;
        if (marker < 0) marker = 0;
        if (marker > state.terminalOutput.length) marker = state.terminalOutput.length;
        var replaySource = marker > 0 ? state.terminalOutput.slice(marker) : state.terminalOutput;
        var bufLen = replaySource.length;
        var startedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        state._resyncInProgress = true;
        try {
          resetTerminal();
          wandTerminalWrite(state.terminal, replaySource);
        } finally {
          state._resyncInProgress = false;
        }
        state.lastTerminalResyncAt = Date.now();
        maybeScrollTerminalToBottom("output");
        if (!opts.skipFit) ensureTerminalFit("refresh");
        // 统计 5s 窗口内的 resync 次数，过密时打 warn 帮助诊断
        // ——比如 wterm 状态机被反复弄脏、上游持续推原地重绘的菜单。
        // 单次 warn 后冷却 30s，避免刷屏。
        var now = Date.now();
        if (now - state._resyncStatsWindowStart > RESYNC_BUDGET_WINDOW_MS) {
          state._resyncStatsWindowStart = now;
          state._resyncStatsCount = 1;
        } else {
          state._resyncStatsCount++;
          if (state._resyncStatsCount > RESYNC_BUDGET_MAX && now - state._resyncLastWarnAt > RESYNC_WARN_COOLDOWN_MS) {
            state._resyncLastWarnAt = now;
            var endedAt = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
            console.warn("[wand] softResyncTerminal high frequency",
              "count=" + state._resyncStatsCount + "/" + Math.round((now - state._resyncStatsWindowStart) / 100) / 10 + "s",
              "bufLen=" + bufLen,
              "lastReplayMs=" + Math.round(endedAt - startedAt));
          }
        }
        return true;
      }

      export function scheduleSoftResyncTerminal(delayMs?: number) {
        if (state.softResyncTimer) clearTimeout(state.softResyncTimer);
        state.softResyncTimer = setTimeout(function() {
          state.softResyncTimer = null;
          softResyncTerminal();
        }, typeof delayMs === "number" ? delayMs : 150);
      }

      // Claude CLI 的 permission 菜单 / 选择列表在方向键下会发原地重绘序列
      // (CSI A-D / J / K / H / f)。wterm 在这种高频原地重绘下 DOM 行容易残留
      // 或错位，必须用 softResyncTerminal 兜底。
      //
      // 触发用 leading + tail 节流而非 debounce：用户持续按键时每次 chunk 都会
      // reset debounce timer，永远等不到静默期。leading 立即 resync、窗口内
      // 用尾巴 timer 收尾，不依赖按键停顿。
      // R6 chunk 热路径救场 throttle：原值 400/350 让 Claude thinking 期间
      // 大量 CSI A/B/K 重绘（spinner、状态行）每秒触发 ~2.5 次 softResync，
      // 13 次/5s 直接撞警戒线。NEW-A 已经把 askuserquestion 这种 ?2026 包帧
      // 重绘原子化，R6 退化为"NEW-A 失手时的弱兜底"，频率拉到 1.5s/0.8s
      // 即可。代价：错位状态最长滞留 1.5s 才修，可接受。
      export var IN_PLACE_REDRAW_RE = /\x1b\[\d*(?:;\d*)?[ABCDfHJK]/;
      export var RESYNC_THROTTLE_MS = 1500;
      export var RESYNC_TAIL_MS = 800;
      state._resyncChunkLastAt = 0;
      state._resyncChunkTailTimer = null;
      export function maybeScheduleResyncForChunk(chunk: any) {
        if (state._resyncInProgress) return; // RENDER-1: 屏蔽 softResync 自身重放触发的递归
        // FLICKER: R6 chunk 热路径 resync 仅在 NEW-A 失手时兜底——即 ?2026 残帧被
        // processSyncOutputFraming 超时/超长强制 flush 透传给 wterm 之后。正常完整包帧
        // 的重绘（菜单/todo/thinking spinner）已被 NEW-A 原子化、wterm 渲染正确，无需
        // resync。旧实现对每个含 CSI 的 chunk 都触发，使 thinking 期间每 ~1.5s 一次
        // resetTerminal→空白帧→重画，终端区持续闪烁。残帧标记在此消费一次（仅此触发）。
        if (!state.syncFramingResidue) return;
        state.syncFramingResidue = false;
        if (!chunk || typeof chunk !== "string") return;
        if (chunk.indexOf("\x1b[") === -1) return;
        if (!IN_PLACE_REDRAW_RE.test(chunk)) return;
        var now = Date.now();
        var sinceLast = now - state._resyncChunkLastAt;
        if (sinceLast >= RESYNC_THROTTLE_MS) {
          if (state._resyncChunkTailTimer) {
            clearTimeout(state._resyncChunkTailTimer);
            state._resyncChunkTailTimer = null;
          }
          state._resyncChunkLastAt = now;
          softResyncTerminal();
          return;
        }
        if (state._resyncChunkTailTimer) return;
        var wait = Math.max(RESYNC_TAIL_MS, RESYNC_THROTTLE_MS - sinceLast);
        state._resyncChunkTailTimer = setTimeout(function() {
          state._resyncChunkTailTimer = null;
          state._resyncChunkLastAt = Date.now();
          softResyncTerminal();
        }, wait);
      }

      export function syncTerminalBuffer(sessionId: string, output: string, options?: any) {
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
          resetTerminal();
          currentOutput = "";
          state.terminalOutput = "";
          state.terminalOutputMarker = 0; // R8: 切会话重置 /clear marker
          state.terminalAutoFollow = true;
          clearTerminalScrollIdleTimer();
          updateTerminalJumpToBottomButton();
        }

        if (mode === "replace") {
          if (normalizedOutput !== currentOutput) {
            resetTerminal();
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
            // 不在流式 chunk 路径触发 softResyncTerminal —— resync 会
            // resetTerminal() + 完整重放整段 buffer，重放期间所有 cursor-home
            // + 重画序列把"被覆盖的中间帧"反复塞进 main-screen scrollback，
            // 表现为 PTY 视图里同一段回答被画 N 遍（PC 端列宽大、Claude TUI
            // 重画序列密集时最严重）。响应结束的 thinking→idle 边界已经做了
            // 一次 softResync 兜底，足以清掉流式残留的错位光标 DOM；流式
            // 过程中持续重放只是纯粹的重复制造器。
            wrote = true;
          }
        } else if (currentOutput && currentOutput.startsWith(normalizedOutput)) {
          return false;
        } else {
          resetTerminal();
          if (normalizedOutput) {
            wandTerminalWrite(state.terminal, normalizedOutput);
          }
          wrote = true;
        }

        state.terminalSessionId = nextSessionId;
        state.terminalOutput = normalizedOutput;
        // R8: syncTerminalBuffer 是整段 replace / sessionChanged 路径，旧
        // marker 已不属于新 buffer，重置为 0。append-delta 子路径（startsWith
        // 命中那条）虽然在 buffer 末尾延伸，但 normalizedOutput 也是延续值，
        // 把 marker 截到不超过新长度即可；为简单起见统一 reset 0。
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

      export function initTerminal() {
        var container = document.getElementById("output");
        if (!container || state.terminal || state.terminalInitializing) return;
        if (typeof WTermLib === "undefined" || !WTermLib.WTerm) {
          if (!state.terminalInitRetries) state.terminalInitRetries = 0;
          if (state.terminalInitRetries < 10) {
            state.terminalInitRetries++;
            setTimeout(initTerminal, 200);
          }
          return;
        }
        state.terminalInitRetries = 0;
        state.terminalInitializing = true;

        // wterm 构造与 init() 内部都通过 getBoundingClientRect 测字符宽高，
        // 要求容器及祖先链都不是 display:none。.terminal-container 默认
        // display:none，必须 .active 才变 flex。switchToSessionView 里
        // initTerminal() 在 applyCurrentView() 之前同步执行——那时容器还是
        // display:none，_measureCharSize 返回 null → ResizeObserver 不挂
        // 载、首屏 cols 永远停在硬编码的 120，必须用户刷新/弹键盘/调窗口
        // 才能恢复。这里在创建 wterm 之前先把 active 类挂上，让容器进入
        // flex 布局，确保 _measureCharSize 拿到真实字符尺寸。
        if (state.selectedId) {
          container.classList.remove("hidden");
          container.classList.add("active");
        }

        // 防御式清理：teardownTerminal 已经会移除残留 termWrap，但若有
        // 调用路径绕过 teardown（比如 outputContainer 被外部 render 重建），
        // 这里再扫一次确保新会话不会和旧 termWrap 叠在同一位置。
        var staleWraps = container.querySelectorAll(".terminal-scroll-wrap");
        for (var i = 0; i < staleWraps.length; i++) {
          var stale = staleWraps[i];
          if (stale.parentNode === container) container.removeChild(stale);
        }

        var termWrap = document.createElement("div");
        termWrap.className = "terminal-scroll-wrap";
        container.appendChild(termWrap);

        // cols/rows 给一个保守默认即可：wterm-entry.js 重写的 init()
        // 会在 super.init() 之前按 termWrap 真实尺寸做一次预校准，
        // 保证 super.init() 里 bridge.init / renderer.setup 一上来
        // 就按真实 cols 初始化，从源头消除"先按 120 写一遍 → 异步
        // remeasure 纠正"的时序窗口。
        var term = new WTermLib.WTerm(termWrap, {
          cols: 120,
          rows: 36,
          autoResize: true,
          cursorBlink: false,
          onData: function() {
            // 物理键盘进 PTY 只允许在「终端交互(键盘透传)」开启时发生，而开启态那条
            // 路径由 captureTerminalInput(document keydown capture)独占处理——所以
            // wterm 自身的 onData 一律不再直接发：
            //   · 关闭态(默认)：用户点一下终端会触发 wterm 内部 _onClickFocus，让它的
            //     隐藏输入元素拿到焦点；之后敲的每个键都从 onData 冒出来。旧代码在这里
            //     直接 queueDirectInput，于是"没开透传也漏键进 PTY"(反复误触的根因)。
            //   · 开启态：captureTerminalInput 已接管全部按键，onData 再发就是双份重复。
            // 两种状态都让路。要发命令请先开透传开关，或直接用输入框。
            return;
          },
          onResize: function(cols: number, rows: number) {
            sendTerminalResize(cols, rows);
            // wterm.resize() just ran renderer.setup() (DOM rows wiped) and
            // bridge.resize() (WASM grid reflowed). terminalOutput is the
            // canonical raw byte stream — replay it now so historical lines
            // and any in-flight CSI sequences re-render at the new width.
            // skipFit: wterm already did the sizing work; calling
            // ensureTerminalFit again here would just cycle back through
            // remeasure → resize → onResize → softResyncTerminal.
            if (state.terminal && state.terminalOutput) {
              softResyncTerminal({ skipFit: true });
            }
          }
        });

        // Wait for the monospace webfont (if any) before init so the very first
        // _measureCharSize() inside wterm uses the final glyph metrics. Otherwise
        // the fallback font's narrower glyphs make wterm calculate too many cols,
        // and subsequent chunks render with broken wrapping until the user
        // triggers a resize. Cap the wait so a missing font never blocks startup.
        var fontsReady = (document.fonts && typeof document.fonts.ready === "object")
          ? Promise.race([document.fonts.ready, new Promise(function(r) { setTimeout(r, 800); })])
          : Promise.resolve();

        fontsReady.then(function() { return term.init(); }).then(function() {
          state.terminal = term;
          state.terminalInitializing = false;
          applyTerminalScale();

          // wterm 构造时 cols/rows 是硬编码的 120/36，super.init() 内部
          // 的 ResizeObserver 要等下一个 layout 阶段异步 fire 才纠正。
          // 如果不在写入历史前就把 bridge reflow 到容器真实尺寸，
          // syncTerminalBuffer 会按 120 cols 把整段历史写进 WASM grid，
          // 用户首屏看到的就是错列宽折行——必须等 ResizeObserver 触发
          // softResync 才恢复，中间会有几帧明显错位（"刚开终端布局错乱
          // 一下、resize 一下才正常"）。这里先强制一次 layout flush，
          // 再同步 remeasure 把 bridge 校准到真实 cols/rows，把"写入"
          // 卡在正确尺寸之后，避免错位帧。
          if (termWrap.isConnected) {
            void termWrap.offsetHeight;
            if (typeof term.remeasure === "function") {
              try { term.remeasure(); } catch (e) { /* ignore: 非致命 */ }
            }
          }

          state.terminalAutoFollow = true;
          clearTerminalScrollIdleTimer();

          var viewport = getTerminalViewport();
          if (viewport) {
            state.terminalViewportScrollHandler = function() {
              // 程序触发的 scroll（wand 主动 scrollTo / wterm 内部
              // _doRender 因 _shouldScrollToBottom=true 拽 scrollTop=scrollHeight）
              // 也会进这里。如果不过滤，handler 会看到 isTerminalAtBottom()=true
              // 把 autoFollow 反转回 true，把用户刚上滚的意图吞掉，下一帧 chunk
              // 到达又被拽底，形成"上滚→拽底"反馈环。窗口长度由调用方按
              // 各自动画长度决定（瞬时 120ms / smooth 500ms）。
              if (Date.now() < state.terminalProgrammaticScrollUntil) {
                updateTerminalJumpToBottomButton();
                return;
              }
              // 严格"真正到底"才恢复 autoFollow：避免 wheel 设 false 后被
              // 紧接着的 scroll 事件因"接近底部 12px"而反转回 true。
              if (isTerminalAtBottom()) {
                state.terminalAutoFollow = true;
                clearTerminalScrollIdleTimer();
                updateTerminalJumpToBottomButton();
                return;
              }
              setTerminalManualScrollActive();
            };
            // SCROLL-3: 触摸只在"看历史"方向（手指下拉、clientY 增大）才下台跟随；
            // 手指上滑（朝新内容/底部）不关跟随，交给 scroll handler 在到底时恢复。
            // 终端非 column-reverse：手指下拉=内容下移=看上方历史=上滚意图，与 wheel
            // 的 deltaY<0 对称。原实现任何 touchmove 都关跟随，移动端在底部轻微回弹
            // 就丢跟随。
            state.terminalViewportTouchStartHandler = function(e: TouchEvent) {
              if (e.touches && e.touches.length === 1) {
                state.terminalTouchStartY = e.touches[0].clientY;
              }
            };
            state.terminalViewportTouchHandler = function(e: TouchEvent) {
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

          // SCROLL-5: 只在上滚（朝历史，deltaY<0）时下台跟随；向下滚（想回去）交给
          // scroll handler 在真正到底时恢复，避免"远离底部时向下滚也被一直按住不跟随"。
          state.terminalWheelHandler = function(e: WheelEvent) {
            if (e.deltaY < 0) {
              setTerminalManualScrollActive();
            }
            e.stopPropagation();
          };
          container.addEventListener("wheel", state.terminalWheelHandler, { passive: true });

          initTerminalScrollbar(container);

          if (state.selectedId) {
            var session = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
            if (session) {
              syncTerminalBuffer(session.id, session.output || "", { mode: "append", scroll: false });
            }
          } else {
            wandTerminalWrite(term, "点击上方「新对话」开始你的第一次对话。\r\n");
          }

          // COPY-4: 有终端选区时不抢焦点到输入框，否则打断双击选词/三击选行后的复制
          // （焦点与后续 Ctrl+C 目标被夺走）。wterm 自带 _onClickFocus 有同款护栏。
          // 透传 event 给 focusInputBox(skipMobile)，保留"移动端点终端不自动弹键盘"。
          state.terminalClickHandler = function(e: MouseEvent) {
            if (hasActiveTerminalSelection()) return;
            focusInputBox(e);
          };
          container.addEventListener("click", state.terminalClickHandler);
          updateTerminalJumpToBottomButton();
          initTerminalResizeHandle();
          initTerminalJoystick();
          observeTerminalResize();
          startTerminalHealthCheck();
          // Container may have been hidden / zero-width at construction
          // time (hard-coded 120x36). Remeasure against the real container
          // so wterm reflows the just-written history to the correct cols.
          ensureTerminalFit("mount", { forceReplay: true });
        }).catch(function(err) {
          state.terminalInitializing = false;
          console.error("[wand] wterm init failed:", err);
        });
      }
