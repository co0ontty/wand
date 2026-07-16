import type { SendError } from "./types";
import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { computeRunningSignal, escapeHtml } from "./utils";
import { renderChat, scheduleChatRender, shortCommand } from "./chat-render";
import { bindChatScrollListener, clearStructuredQueuePersistence, getConfigCwd, getStructuredQueuedInputs, persistCrossSessionQueue, persistSelectedId, prepareChatBottomFollow, restoreStructuredQueue, saveStructuredQueue, stripRenderOnlyStructuredMessages, syncStructuredQueueFromSession } from "./chat-scroll";
import { isMobileLayout, updateFilePanelCwd } from "./file-browser";
import { loadGitStatus } from "./git-commit";
import { showToast, wandConfirm, wandAlert, wandPrompt, openWandDialog, showError, hideError, sendBrowserNotification, _syncWakeLock } from "./notifications";
import { render, resetChatRenderCache, getEffectiveCwd } from "./render";
import { applyCurrentView, buildAttachmentPrefix, clearAttachments, dismissDrawerIfOverlay, getChatModelForProvider, getComposerPlaceholder, getComposerTool, getPreferredMessages, getPreferredTool, getSafeModeForTool, isStructuredSession, loadOutput, loadSessions, refreshAll, selectSession, setDraftValue, shouldRequestChatFormat, subscribeToSession, syncComposerHasText, updateSessionSnapshot, updateSessionsList, uploadAttachments, withTerminalDimensions } from "./session-engine";
import { renderSessions, loadClaudeHistory, loadCodexHistory, ensureClaudeHistoryLoaded, ensureCodexHistoryLoaded, confirmDelete } from "./sidebar";
import { initTerminal, maybeScheduleResyncForChunk, maybeScrollTerminalToBottom, scheduleSoftResyncTerminal, softResyncTerminal, syncTerminalBuffer } from "./terminal";
import { ensureTerminalFit, scheduleClosedViewportBaselineWindow, sendTerminalResize, syncAppViewportHeight, teardownTerminal, updateJoystickPanelUI, updateJoystickVisibility } from "./viewport";
import { setView, initWebSocket, forceReconnectWebSocket } from "./websocket";
import { getSessionStatusLabel } from "./session-ui";
import { isBrowserReactShellMounted } from "./shell-runtime";
import { notifyLegacyUiChange } from "./ui-store-bridge";

      // 改为在识别回调里调用 updateVoiceTranscript(累积文本) 即可，交互层不用动。
      // ─────────────────────────────────────────────────────────────────
      export var voiceState = { recording: false, canceling: false, transcript: "", startY: 0 };
      export var VOICE_CANCEL_THRESHOLD = 60; // 按住后上滑超过该像素进入"松开取消"态
      export var VOICE_HOLD_DELAY = 180;
      var composerVoiceHoldTimer = null;
      var composerVoiceHoldStartY = 0;
      var composerVoiceHoldPointerId = null;

      // STT 唯一注入点：写入累积文字并刷新气泡内容。
      // 网页端目前没有可用的语音识别后端（移动端走原生客户端的端侧 STT）；
      // 真正接入网页 STT 时，在识别回调里调用本函数累积文本即可，交互层不用动。
      export function updateVoiceTranscript(text) {
        voiceState.transcript = text || "";
        var textEl = document.getElementById("voice-transcript-text");
        if (textEl) textEl.textContent = voiceState.transcript;
        var bubble = document.getElementById("voice-transcript-bubble");
        if (bubble) bubble.classList.toggle("has-text", !!voiceState.transcript);
      }

      export function startVoiceRecording(e) {
        if (e) {
          e.preventDefault();
          voiceState.startY = (typeof e.clientY === "number") ? e.clientY : 0;
          // 指针捕获：手指/鼠标移出按钮范围也能继续收到 move / up
          try {
            if (e.pointerId !== undefined && e.target && e.target.setPointerCapture) {
              e.target.setPointerCapture(e.pointerId);
            }
          } catch (_) {}
        }
        voiceState.recording = true;
        voiceState.canceling = false;
        voiceState.transcript = "";
        var btn = document.getElementById("voice-record-btn");
        if (btn) {
          btn.classList.add("is-recording");
          var label = btn.querySelector(".voice-record-label");
          if (label) label.textContent = "松开 发送";
        }
        var bubble = document.getElementById("voice-transcript-bubble");
        if (bubble) bubble.classList.remove("hidden", "is-canceling", "has-text");
        updateVoiceTranscript("");
        var status = document.getElementById("voice-transcript-status");
        // 网页端暂无语音识别后端：给出明确提示，不再用假样本骗用户。
        // 语音输入请使用 App（原生客户端走端侧 STT）。
        if (status) status.textContent = "网页端暂不支持语音输入，请使用 App";
      }

      export function handleVoiceMove(e) {
        if (!voiceState.recording || !e) return;
        var dy = voiceState.startY - (typeof e.clientY === "number" ? e.clientY : voiceState.startY);
        var shouldCancel = dy > VOICE_CANCEL_THRESHOLD;
        if (shouldCancel === voiceState.canceling) return;
        voiceState.canceling = shouldCancel;
        var bubble = document.getElementById("voice-transcript-bubble");
        if (bubble) bubble.classList.toggle("is-canceling", shouldCancel);
        var btn = document.getElementById("voice-record-btn");
        var label = btn && btn.querySelector(".voice-record-label");
        if (label) label.textContent = shouldCancel ? "松开 取消" : "松开 发送";
        var status = document.getElementById("voice-transcript-status");
        if (status) status.textContent = shouldCancel ? "松开手指 取消" : "正在聆听…上滑取消";
      }

      export function stopVoiceRecording(e) {
        if (!voiceState.recording) return;
        if (e) e.preventDefault();
        voiceState.recording = false;
        var commit = !voiceState.canceling && !!voiceState.transcript.trim();
        var text = voiceState.transcript;
        resetVoiceRecordingUI();
        if (commit) {
          commitVoiceTranscript(text);
          toggleVoiceMode(false); // 松手提交后退出语音模式，回到打字态便于修改
        }
      }

      function clearComposerVoiceHoldTimer() {
        if (composerVoiceHoldTimer !== null) {
          clearTimeout(composerVoiceHoldTimer);
          composerVoiceHoldTimer = null;
        }
      }

      export function beginComposerVoiceHold(e) {
        var box = e && e.currentTarget;
        if (!box || state.terminalInteractive || (box.value || "").trim()) return;
        clearComposerVoiceHoldTimer();
        composerVoiceHoldStartY = typeof e.clientY === "number" ? e.clientY : 0;
        composerVoiceHoldPointerId = e.pointerId;
        composerVoiceHoldTimer = setTimeout(function() {
          composerVoiceHoldTimer = null;
          if ((box.value || "").trim()) return;
          startVoiceRecording(e);
          var composer = box.closest && box.closest(".input-composer");
          if (composer) composer.classList.add("voice-holding");
          box.placeholder = "松开结束 · 上滑取消";
        }, VOICE_HOLD_DELAY);
      }

      export function handleComposerVoiceMove(e) {
        if (composerVoiceHoldTimer !== null) {
          var dy = Math.abs(composerVoiceHoldStartY - (typeof e.clientY === "number" ? e.clientY : composerVoiceHoldStartY));
          if (dy > 10) clearComposerVoiceHoldTimer();
          return;
        }
        if (voiceState.recording && (composerVoiceHoldPointerId === null || e.pointerId === composerVoiceHoldPointerId)) {
          handleVoiceMove(e);
          var box = e.currentTarget;
          if (box) box.placeholder = voiceState.canceling ? "松开取消" : "松开结束 · 上滑取消";
        }
      }

      function finishComposerVoiceHold(e, canceled) {
        var wasPending = composerVoiceHoldTimer !== null;
        clearComposerVoiceHoldTimer();
        if (!wasPending && voiceState.recording) {
          if (canceled) voiceState.canceling = true;
          stopVoiceRecording(e);
        }
        composerVoiceHoldPointerId = null;
        var box = e && e.currentTarget;
        var composer = box && box.closest && box.closest(".input-composer");
        if (composer) composer.classList.remove("voice-holding");
        if (box) box.placeholder = getComposerPlaceholder(getSelectedSession(), state.terminalInteractive);
      }

      export function endComposerVoiceHold(e) {
        finishComposerVoiceHold(e, false);
      }

      export function cancelComposerVoiceHold(e) {
        finishComposerVoiceHold(e, true);
      }

      // 复位录音相关 UI（按钮 + 气泡），不改变是否处于语音模式。
      export function resetVoiceRecordingUI() {
        voiceState.canceling = false;
        var btn = document.getElementById("voice-record-btn");
        if (btn) {
          btn.classList.remove("is-recording");
          var label = btn.querySelector(".voice-record-label");
          if (label) label.textContent = "按住 说话";
        }
        var bubble = document.getElementById("voice-transcript-bubble");
        if (bubble) bubble.classList.add("hidden");
      }

      // 把识别文字填回输入框（追加在已有草稿后、不覆盖），光标停末尾。
      // 复用 setDraftValue + autoResizeInput，与提示词优化填回 textarea 同一套范式。
      export function commitVoiceTranscript(text) {
        var clean = (text || "").trim();
        if (!clean) return;
        var box = document.getElementById("input-box") as HTMLInputElement | null;
        if (!box) return;
        var existing = box.value || "";
        var joined = existing ? existing.replace(/\s+$/, "") + " " + clean : clean;
        box.value = joined;
        setDraftValue(joined, true);
        autoResizeInput(box); // 内部会 syncComposerHasText
        try { box.setSelectionRange(joined.length, joined.length); } catch (_) {}
      }

      // v2: 切换语音输入模式（类似微信"按住说话"）
      export function toggleVoiceMode(force?) {
        var composer = document.querySelector(".input-composer");
        if (!composer) return;
        var willEnable = typeof force === "boolean" ? force : !composer.classList.contains("voice-mode");
        composer.classList.toggle("voice-mode", willEnable);
        if (!willEnable) {
          // 退出语音模式：停掉可能在跑的录音 + 隐藏气泡，并把焦点交还 textarea
          voiceState.recording = false;
          resetVoiceRecordingUI();
          var inputBox = document.getElementById("input-box");
          if (inputBox && !state.terminalInteractive) {
            try { inputBox.focus({ preventScroll: true }); } catch (_) {}
          }
        }
      }

      export function autoResizeInput(el) {
        if (!el) return;
        var minHeight = 36;
        var maxHeight = 120;
        var touchDevice = isTouchDevice();
        // For empty content, reset to minimum height immediately
        if (!el.value || el.value.trim() === "") {
          el.style.height = minHeight + "px";
          el.style.minHeight = minHeight + "px";
          el.style.overflowY = touchDevice ? "auto" : "hidden";
          el.scrollTop = 0;
          syncComposerHasText(el);
          return;
        }
        // Measure content height by temporarily setting height to minHeight
        // and reading scrollHeight. Avoid collapsing to 0 which causes layout jumps.
        var prevOverflow = el.style.overflowY;
        el.style.overflowY = "hidden";
        el.style.height = minHeight + "px";
        var contentHeight = el.scrollHeight;
        var newHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
        var shouldScrollInside = contentHeight > maxHeight;
        el.style.height = newHeight + "px";
        el.style.minHeight = minHeight + "px";
        el.style.overflowY = shouldScrollInside || touchDevice ? "auto" : "hidden";
        if (shouldScrollInside) {
          syncInputBoxScroll(el);
        } else {
          el.scrollTop = 0;
        }
        syncComposerHasText(el);
      }

      export function isSelectedSessionRunning() {
        if (!state.selectedId) return false;
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        if (isStructuredSession(selectedSession)) {
          return !!(selectedSession.structuredState && selectedSession.structuredState.inFlight);
        }
        return !!selectedSession && selectedSession.status === "running";
      }

      // ── 跨会话排队 ──

      export var _queueLaunching = false; // 防止并发 launch

      export function sessionIsBusyForQueue(s) {
        if (!s || s.archived) return false;
        if (isStructuredSession(s)) {
          return !!(s.structuredState && s.structuredState.inFlight);
        }
        return s.status === "running";
      }

      export function hasAnyBusySession() {
        return state.sessions.some(sessionIsBusyForQueue);
      }

      // 选出用户「想继续的那个会话」：当前选中且仍在忙的优先，否则取最近启动、
      // 仍在忙的那个。enqueueCrossSessionMessage 只在 hasAnyBusySession() 为真时
      // 被调用，所以这里几乎总能拿到一个目标。
      export function getContinuationTargetSession() {
        var candidates = state.sessions.filter(sessionIsBusyForQueue);
        if (candidates.length === 0) return null;
        if (state.selectedId) {
          var sel = candidates.find(function(s) { return s.id === state.selectedId; });
          if (sel) return sel;
        }
        candidates.sort(function(a, b) {
          return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0);
        });
        return candidates[0];
      }

      // 把一条消息送进某个结构化会话的服务端排队。沿用 inFlight→排队、当前回复
      // 结束后自动 --resume 续接的既有路径（与输入框上方「排队发送」按钮同一条
      // 链路），因此排队的这条消息天然带着该会话之前所有轮次的上下文。
      export function getLastStructuredSubmittedInput(session) {
        if (!session) return "";
        var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages : [];
        for (var qi = queue.length - 1; qi >= 0; qi--) {
          var queued = typeof queue[qi] === "string" ? queue[qi].trim() : "";
          if (queued) return queued;
        }
        var messages = Array.isArray(session.messages) ? session.messages : [];
        for (var mi = messages.length - 1; mi >= 0; mi--) {
          var turn = messages[mi];
          if (!turn || turn.role !== "user" || !Array.isArray(turn.content)) continue;
          var textParts = turn.content
            .filter(function(block) { return block && block.type === "text" && typeof block.text === "string"; })
            .map(function(block) { return block.text; });
          if (textParts.length) return textParts.join("\n").trim();
          for (var bi = 0; bi < turn.content.length; bi++) {
            var block = turn.content[bi];
            if (block && block.type === "tool_result" && typeof block.content === "string") {
              return block.content.trim();
            }
          }
          return "";
        }
        return "";
      }

      export function continueStructuredSession(session, text) {
        var normalizedText = typeof text === "string" ? text.trim() : "";
        if (normalizedText && getLastStructuredSubmittedInput(session) === normalizedText) {
          showToast("与上一条消息相同，已忽略，不会加入排队。", "warning");
          return Promise.resolve();
        }
        var idempotencyKey = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
        var prevQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        var nextQueue = prevQueue.slice();
        nextQueue.push(text);
        // 乐观更新目标会话的排队，让侧栏 / 已打开的该会话视图立即有反馈。
        updateSessionSnapshot({ id: session.id, queuedMessages: nextQueue });
        if (session.id === state.selectedId) updateQueueBar();
        var label = session.title || shortCommand(session.command) || "当前会话";
        showToast("已加入「" + label + "」的排队，回复结束后自动发送（含上下文）。", "info");
        return fetch("/api/structured-sessions/" + session.id + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: text, idempotencyKey: idempotencyKey })
        })
          .then(function(res) {
            if (!res.ok) {
              return res.json().catch(function() { return { error: "请求失败" }; }).then(function(p) {
                throw new Error((p && p.error) || "无法排队消息。");
              });
            }
            return res.json();
          })
          .then(function(snapshot) {
            if (snapshot && snapshot.id) {
              updateSessionSnapshot(snapshot);
              if (snapshot.id === state.selectedId) updateQueueBar();
            }
          })
          .catch(function(err) {
            // 失败回滚乐观排队，避免 UI 上残留一条永远不会发出的排队。
            updateSessionSnapshot({ id: session.id, queuedMessages: prevQueue });
            if (session.id === state.selectedId) updateQueueBar();
            showToast((err && err.message) || "排队失败，请重试。", "error");
          });
      }

      export function enqueueCrossSessionMessage(text) {
        // 关键修复：以前这里无脑把消息塞进 crossSessionQueue，等空闲后用
        // /api/commands 起一个「全新会话」发送 —— 新会话不带任何历史，于是
        // 「第 2 条消息没有第 1 条的上下文」。正确做法是把它送回「正在忙的那个
        // 会话」继续对话。结构化会话直接进它的服务端排队（结束后 --resume 续接，
        // 上下文完整）。
        var target = getContinuationTargetSession();
        if (target && isStructuredSession(target)) {
          continueStructuredSession(target, text);
          return;
        }

        // 兜底：目标是 PTY 会话或没有可续接的目标时，仍走「忙完后开新会话」的旧
        // 逻辑。新会话本就没有上下文可继承，所以这条路径不存在上下文丢失问题。
        if (state.crossSessionQueue.length >= 10) {
          showToast("排队消息已满（最多 10 条），请等待当前会话完成。", "warning");
          return;
        }
        var id = "csq-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        state.crossSessionQueue.push({
          id: id,
          text: text,
          cwd: getEffectiveCwd(),
          mode: state.chatMode || "managed",
          tool: getPreferredTool(),
          queuedAt: Date.now()
        });
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        showToast("已排队，将在空闲后自动开始新会话。", "info");
      }

      export function launchQueueItem(item) {
        if (_queueLaunching) return;
        _queueLaunching = true;
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: item.tool,
            cwd: item.cwd,
            mode: item.mode,
            initialInput: item.text
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          _queueLaunching = false;
          if (data.error) {
            showToast(data.error, "error");
            // 失败回填队首，不丢消息
            state.crossSessionQueue.unshift(item);
            persistCrossSessionQueue();
            renderCrossSessionQueue();
            return null;
          }
          return activateSession(data);
        })
        .catch(function(error) {
          _queueLaunching = false;
          showToast((error && error.message) || "无法启动排队会话。", "error");
          state.crossSessionQueue.unshift(item);
          persistCrossSessionQueue();
          renderCrossSessionQueue();
        });
      }

      export function sendQueueItemNow(queueId) {
        var idx = state.crossSessionQueue.findIndex(function(q) { return q.id === queueId; });
        if (idx < 0) return;
        var item = state.crossSessionQueue.splice(idx, 1)[0];
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        // 立即发送不受 _queueLaunching 限制
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: item.tool,
            cwd: item.cwd,
            mode: item.mode,
            initialInput: item.text
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            state.crossSessionQueue.splice(idx, 0, item);
            persistCrossSessionQueue();
            renderCrossSessionQueue();
            return null;
          }
          return activateSession(data);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动排队会话。", "error");
          state.crossSessionQueue.splice(idx, 0, item);
          persistCrossSessionQueue();
          renderCrossSessionQueue();
        });
      }

      export function cancelQueueItem(queueId) {
        var idx = state.crossSessionQueue.findIndex(function(q) { return q.id === queueId; });
        if (idx < 0) return;
        state.crossSessionQueue.splice(idx, 1);
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        if (state.crossSessionQueue.length === 0) {
          showToast("排队已清空。", "info");
        }
      }

      export function flushCrossSessionQueue() {
        if (state.crossSessionQueue.length === 0) return;
        if (hasAnyBusySession()) return;
        if (_queueLaunching) return;
        var item = state.crossSessionQueue.shift();
        renderCrossSessionQueue();
        launchQueueItem(item);
      }

      export function formatQueueAge(queuedAt) {
        var sec = Math.floor((Date.now() - queuedAt) / 1000);
        if (sec < 60) return sec + "s";
        var min = Math.floor(sec / 60);
        if (min < 60) return min + "m";
        return Math.floor(min / 60) + "h";
      }

      export function renderCrossSessionQueue() {
        var container = document.querySelector(".cross-session-queue");
        var inputPanel = document.querySelector(".input-panel");
        var statusBar = document.querySelector(".structured-status-bar");
        var composer = document.querySelector(".input-composer");
        var blankQueueHost = document.getElementById("cross-session-queue-host");

        if (state.crossSessionQueue.length === 0) {
          if (container) container.remove();
          persistCrossSessionQueue();
          return;
        }

        // The welcome queue uses a dedicated LegacyHost so this renderer never
        // appends children into React-owned #blank-chat.
        var isInputPanelVisible = inputPanel && !inputPanel.classList.contains("hidden");
        var parent = isInputPanelVisible ? inputPanel : blankQueueHost;
        // Insert above status bar if present, otherwise above composer
        var insertBefore = isInputPanelVisible ? (statusBar || composer) : null;

        if (!parent) return;

        // If container exists but is in the wrong parent, move it
        if (container && container.parentNode !== parent) {
          container.remove();
          container = null;
        }

        if (!container) {
          container = document.createElement("div");
          container.className = "cross-session-queue";
          if (insertBefore) {
            parent.insertBefore(container, insertBefore);
          } else {
            parent.appendChild(container);
          }
        } else if (isInputPanelVisible && insertBefore && container.nextSibling !== insertBefore) {
          // Ensure queue stays above status bar
          parent.insertBefore(container, insertBefore);
        }

        var total = state.crossSessionQueue.length;
        var items = state.crossSessionQueue.map(function(item, i) {
          var preview = item.text.length > 60 ? item.text.slice(0, 60) + "…" : item.text;
          var age = formatQueueAge(item.queuedAt);
          return '<div class="queue-item" data-queue-id="' + escapeHtml(item.id) + '">' +
            '<span class="queue-item-dot"></span>' +
            '<span class="queue-item-text" title="' + escapeHtml(item.text) + '">' + escapeHtml(preview) + '</span>' +
            '<span class="queue-item-age">' + age + '</span>' +
            '<button class="queue-item-send-now" data-queue-id="' + escapeHtml(item.id) + '" title="立即发送" type="button">发送</button>' +
            '<button class="queue-item-cancel" data-queue-id="' + escapeHtml(item.id) + '" title="取消" type="button">×</button>' +
          '</div>';
        }).join("");

        var header = total > 1
          ? '<div class="queue-header">' +
              '<span class="queue-header-label">排队 ' + total + ' 条</span>' +
              '<button class="queue-header-clear" id="queue-clear-all" type="button" title="清空排队">清空</button>' +
            '</div>'
          : '';

        container.innerHTML = header + items;
      }

      // 定时刷新排队项的等待时间 + 尝试 flush
      setInterval(function() {
        if (state.crossSessionQueue.length > 0) {
          // 只更新 age 文本，不重建整个 DOM
          var ages = document.querySelectorAll(".queue-item-age");
          state.crossSessionQueue.forEach(function(item, i) {
            if (ages[i]) ages[i].textContent = formatQueueAge(item.queuedAt);
          });
          // 尝试 flush 作为保底（防止 ended 事件 flush 失败）
          flushCrossSessionQueue();
        }
      }, 5000);

      // Delegate click events for cross-session queue items
      document.addEventListener("click", function(e) {
        var target = e.target as HTMLElement;
        if (target.closest("#queue-clear-all")) {
          e.preventDefault();
          state.crossSessionQueue = [];
          persistCrossSessionQueue();
          renderCrossSessionQueue();
          showToast("排队已清空。", "info");
          return;
        }
        var sendNow = target.closest(".queue-item-send-now") as HTMLElement | null;
        if (sendNow) {
          e.preventDefault();
          sendQueueItemNow(sendNow.dataset.queueId);
          return;
        }
        var cancel = target.closest(".queue-item-cancel") as HTMLElement | null;
        if (cancel) {
          e.preventDefault();
          cancelQueueItem(cancel.dataset.queueId);
          return;
        }
      });

      // Send message from the welcome screen input
      export function welcomeInputSend() {
        var welcomeInput = document.getElementById("welcome-input") as HTMLInputElement | null;
        var value = welcomeInput ? welcomeInput.value.trim() : "";
        if (!value) return;

        // Cross-session queue: if any session is busy, send the message back into
        // that busy conversation (context-preserving) instead of starting fresh.
        // enqueueCrossSessionMessage owns the user feedback toast for both paths.
        if (hasAnyBusySession()) {
          welcomeInput.value = "";
          enqueueCrossSessionMessage(value);
          return;
        }

        // Clear todo progress bar at the start of a new session
        var todoEl = document.getElementById("todo-progress");
        if (todoEl) todoEl.classList.add("hidden");
        welcomeInput.value = "";
        welcomeInput.placeholder = "正在启动…";
        welcomeInput.disabled = true;
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            provider: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            welcomeInput.placeholder = "输入消息";
            welcomeInput.disabled = false;
            return;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          resetChatRenderCache();
          updateSessionSnapshot(data);
          updateSessionsList();
          switchToSessionView(data.id);
          subscribeToSession(data.id);
          loadOutput(data.id).then(function() {
            welcomeInput.placeholder = "输入消息";
            welcomeInput.disabled = false;
            focusInputBox(true);
          });
        })
        .catch(function(error) {
          showToast((error && error.message) || (preferredTool === "codex"
            ? "无法启动 Codex 会话。"
            : "无法启动 Claude 会话。"), "error");
          welcomeInput.placeholder = "输入消息";
          welcomeInput.disabled = false;
        });
      }

      export function sendOrStart(opts?) {
        opts = opts || {};
        // Support welcome input as well as the main input box
        var welcomeInput = document.getElementById("welcome-input") as HTMLInputElement | null;
        var inputBox = document.getElementById("input-box") as HTMLInputElement | null;
        var value = (welcomeInput && welcomeInput.value.trim())
          ? welcomeInput.value.trim()
          : (inputBox ? inputBox.value.trim() : "");

        // If we have a selected ID, try to send input to it
        if (state.selectedId) {
          if (value) {
            sendInputFromBox(opts);
          }
          return;
        }

        // No selected session, create a new one (or continue the busy one if any).
        // enqueueCrossSessionMessage owns the user feedback toast for both paths.
        if (value && hasAnyBusySession()) {
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          syncComposerHasText(inputBox);
          enqueueCrossSessionMessage(value);
          return;
        }
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            provider: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value || undefined
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          resetChatRenderCache();
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          updateSessionSnapshot(data);
          updateSessionsList();
          switchToSessionView(data.id);
          // Subscribe to new session via WebSocket
          subscribeToSession(data.id);
          return loadOutput(data.id);
        })
        .catch(function(error) {
          showToast((error && error.message) || (preferredTool === "codex"
            ? "无法启动 Codex 会话。"
            : "无法启动 Claude 会话。"), "error");
        });
      }

      export function switchToSessionView(sessionId) {
        var reactShellActive = isBrowserReactShellMounted();
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");
        var terminalTitle = document.getElementById("terminal-title");
        var terminalInfo = document.getElementById("terminal-info");
        var sessionSummary = document.querySelector(".session-summary-value");
        var structured = isStructuredSession(session);

        if (!reactShellActive && blankChat) blankChat.classList.add("hidden");
        if (!reactShellActive && terminalContainer) {
          terminalContainer.classList.toggle("hidden", structured);
        }
        if (!reactShellActive && chatContainer) {
          chatContainer.classList.remove("hidden");
        }
        // v2: 不再无条件展示停止按钮 —— 由 updateInteractiveControls() 按
        // computeRunningSignal 判断「真在跑」时才露出，下面 updateInteractiveControls
        // 链路会处理（switchToSessionView 后续会触发它）。

        if (structured) {
          state.currentView = "chat";
        } else {
          state.currentView = "terminal";
        }

        var title = session ? shortCommand(session.command) : "Wand";
        var info = session ? getSessionStatusLabel(session) : "开始对话";
        if (terminalTitle) terminalTitle.textContent = title;
        if (terminalInfo) terminalInfo.textContent = info;
        if (sessionSummary) sessionSummary.textContent = title;

        if (!structured) {
          if (!state.terminal) initTerminal();
        }
        applyCurrentView();
        focusInputBox(true);
        // Container just flipped from hidden -> visible (or geometry changed
        // because chat/terminal panels swapped). Refit now so the terminal
        // picks up the real cols/rows instead of keeping the stale ones.
        if (!structured) ensureTerminalFit("view-switch", { forceReplay: true });
        notifyLegacyUiChange("session:view");
      }

      export function sendInputFromBox(opts) {
        opts = opts || {};
        var interruptFlag = !!opts.interrupt;
        var embedTerminal = document.documentElement.classList.contains("is-wand-embed-terminal");
        if (state.terminalInteractive && !embedTerminal) {
          showToast("终端交互模式开启时，请直接在终端中输入。", "info");
          return Promise.resolve();
        }

        var inputBox = document.getElementById("input-box") as HTMLInputElement | null;
        var value = inputBox ? inputBox.value : "";
        var selectedSession = getSelectedSession();
        var hasAttachments = state.pendingAttachments.length > 0;

        if (value || hasAttachments) {

          // 「附件上传失败」的提示只能挂在 uploadAttachments 这一步上。
          // 旧实现把整条发送链（含纯文字发送）都套进同一个外层 catch，结果
          // 发送阶段的任何错误都被误报成「附件上传失败: …」，没附件也中招，
          // 而 PTY 路径还会先 toast 一次真实错误 —— 叠出两条 toast。
          var attachUpload = hasAttachments && state.selectedId
            ? uploadAttachments(state.selectedId).catch(function(err) {
                showToast("附件上传失败: " + ((err && err.message) || err), "error");
                var marked: any = err instanceof Error ? err : new Error(String(err));
                marked.__wandToasted = true;
                throw marked;
              })
            : Promise.resolve([]);

          return attachUpload.then(function(uploadedFiles) {
            var prefix = buildAttachmentPrefix(uploadedFiles);
            var finalValue = prefix + (value || (uploadedFiles.length ? "请查看附件。" : ""));
            if (uploadedFiles.length) clearAttachments();

            // Clear todo progress bar at the start of a new user turn
            var todoEl = document.getElementById("todo-progress");
            if (todoEl) todoEl.classList.add("hidden");

            if (isStructuredSession(selectedSession)) {
              return postStructuredInput(finalValue, inputBox, selectedSession, { interrupt: interruptFlag });
            }

            var submitChunks = getTerminalSubmitChunks(selectedSession, finalValue);
            var isOffline = !state.wsConnected;

            if (isOffline) {
              queueOfflineTerminalChunks(submitChunks);
              if (inputBox) {
                inputBox.value = "";
                autoResizeInput(inputBox);
              }
              setDraftValue("");
              return Promise.resolve();
            }

            return ensureSessionReadyForInput(selectedSession).then(function(readySession) {
              if (!readySession) {
                // ensureSessionReadyForInput / resumeSession 已经在失败路径里
                // 自行 toast，这里不再重复提示，避免叠两条消息。
                return null;
              }
              var submitView = state.currentView;
              if (readySession && readySession.provider === "codex" && state.selectedId !== readySession.id) {
                throw new Error("Codex session changed before input send.");
              }
              prepareChatBottomFollow();
              return sendTerminalChunks(submitChunks, "enter_text", 30, submitView).then(function() {
                if (inputBox && inputBox.value === value) {
                  inputBox.value = "";
                  autoResizeInput(inputBox);
                }
                setDraftValue("");
              });
            }).catch(function(err) {
              showToast(getInputErrorMessage(err), "error");
              if (err) err.__wandToasted = true;
              throw err;
            });
          }).catch(function(err) {
            // 兜底：只提示「还没人 toast 过」的错误（如 then 链里的同步异常），
            // 用真实错误文案，绝不再贴「附件上传失败」标签。
            if (!(err && err.__wandToasted)) {
              showToast(getInputErrorMessage(err), "error");
            }
            throw err;
          });
        }
        return Promise.resolve();
      }

      // 防止同一会话「快速双击 / 重复触发」。原来这是个布尔 flag，绑在 fetch 的
      // promise 上 —— 但 structured-sessions/:id/messages 的 POST 对首条消息会 await
      // 整段流式 streaming，flag 会被卡到回复完才释放。结果：用户点发送 → 服务端
      // 流式 30s 不响应 → 这 30s 里再点发送全被这里静默 drop，看起来"排队 / 立即发送
      // 都没效果"。改成时间戳 + 短窗口（350ms）只挡真正的连击。idempotencyKey 已经
      // 在后端兜底防 webview 网络层重发，这里的 hot-path 守门只需要应付 UI 双触发。
      export var _structuredLastSubmitAt = {};
      export var DUPLICATE_SUBMIT_WINDOW_MS = 350;

      export function postStructuredInput(input, inputBox, session, opts) {
        opts = opts || {};
        // interrupt:true 现在只来自 Cmd/Ctrl+Enter 快捷键，或点队列气泡触发的
        // queueBarPromoteIndex()。普通 Enter / 点发送在上一条还在流式时默认走
        // queue —— 后端 sendMessage(...) 会把它追加到 queuedMessages，等当前 turn
        // 结束自动 flush；想插队就点输入框上方那条气泡。
        var requestedInterrupt = !!opts.interrupt;
        if (!state.selectedId || !input) return Promise.resolve();
        if (!session) {
          showToast("会话不存在，请重新选择或新建会话。", "error");
          return Promise.resolve();
        }
        var sessionInFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
        if (sessionInFlight && !requestedInterrupt && getLastStructuredSubmittedInput(session) === input.trim()) {
          if (inputBox) {
            inputBox.value = "";
            autoResizeInput(inputBox);
          }
          setDraftValue("");
          showToast("与上一条消息相同，已忽略，不会加入排队。", "warning");
          updateInputHint("Enter 发送 · Shift+Enter 换行");
          return Promise.resolve();
        }
        // 短窗口内的连击当作重复点击丢掉；正常间隔的两次提交（哪怕第一次还在流式）
        // 都放行，让 queue / interrupt 真正生效。
        var nowTs = Date.now();
        var lastTs = _structuredLastSubmitAt[session.id] || 0;
        if (nowTs - lastTs < DUPLICATE_SUBMIT_WINDOW_MS) {
          console.log("[wand] postStructuredInput: duplicate submit (within " + DUPLICATE_SUBMIT_WINDOW_MS + "ms) ignored for session", session.id);
          return Promise.resolve();
        }
        _structuredLastSubmitAt[session.id] = nowTs;

        var isInterrupting = sessionInFlight && requestedInterrupt;
        var isQueueing = sessionInFlight && !requestedInterrupt;

        var userMsgs = stripRenderOnlyStructuredMessages(Array.isArray(session.messages) ? session.messages.slice() : []);
        var optimisticPatch;

        if (isQueueing) {
          // Queue 模式：不要乐观 push user turn —— buildMessagesForRender 会把
          // queuedMessages 渲成 __queued 占位（带"排队中"徽章），再 push 一份
          // 真 user turn 会被去重逻辑遮蔽掉，徽章就丢了。inFlight / status 维持。
          var nextQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
          nextQueue.push(input);
          optimisticPatch = {
            id: session.id,
            queuedMessages: nextQueue,
          };
          updateSessionSnapshot(optimisticPatch);
          var queueRefreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
          state.currentMessages = buildMessagesForRender(queueRefreshed, getPreferredMessages(queueRefreshed, queueRefreshed.output, false));
          updateInputHint("已加入排队…");
          renderChat(true);
          updateStructuredQueueCounter();
          // 乐观 toast：原本只在 POST 完成后才提示，Claude 流式拖太久时用户根本
          // 看不到反馈，会误判"点了没反应"。点击瞬间就给一条短提示。
          showToast(nextQueue.length > 1 ? ("已加入排队（共 " + nextQueue.length + " 条等待）") : "已加入排队，等当前回复完成会自动发送。", "info");
        } else {
          // 普通发送 / interrupt 发送：照旧乐观推 user turn + inFlight=true
          var userTurn = { role: "user", content: [{ type: "text", text: input }] };
          userMsgs.push(userTurn);
          var optimisticStructuredState = Object.assign({}, session.structuredState || {}, { inFlight: true });
          updateSessionSnapshot({
            id: session.id,
            status: "running",
            messages: userMsgs,
            structuredState: optimisticStructuredState,
          });
          state.currentMessages = buildMessagesForRender(Object.assign({}, session, {
            status: "running",
            messages: userMsgs,
            structuredState: optimisticStructuredState,
          }), userMsgs);
          updateInputHint(isInterrupting ? "已中断，正在处理新消息…" : "思考中…");
          prepareChatBottomFollow();
          renderChat(true);
          // 中断模式：乐观给一条提示，让用户立刻知道"中断成功了"，否则跟 queue 一样会
          // 觉得"点了没反应"。原 toast 在 then() 里，等 SIGTERM/HTTP roundtrip 完才出。
          if (isInterrupting) {
            showToast("已中断上一条回复，正在处理新消息…", "info");
          }
        }

        if (inputBox) {
          inputBox.value = "";
          autoResizeInput(inputBox);
        }
        setDraftValue("");

        // Capture queue epoch before the POST so we can detect whether
        // a newer WS update has already refreshed the queue by the time
        // the HTTP response arrives.
        var epochBeforePost = state.queueEpoch;

        // 给每次发送生成唯一 idempotency key。Android WebView 进程被冻结再恢复
        // 的边界场景下，底层网络栈偶尔会把上次未收到响应的 POST 重发一次（前端
        // JS 拦不住），导致同一条消息被 backend 处理两遍。带上 key 让 backend
        // 在窗口内识别重发并丢弃。
        var idempotencyKey = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));

        // 用 session.id（参数绑定，in-flight 期间不变）而不是 state.selectedId
        // 拼 URL，避免用户切到别的会话后 fetch 落到错误 sessionId。
        return fetch("/api/structured-sessions/" + session.id + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, interrupt: isInterrupting || undefined, idempotencyKey: idempotencyKey })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return { error: "请求失败" }; }).then(function(payload) {
              var err = new Error((payload && payload.error) || "无法发送结构化消息。") as SendError;
              err.errorCode = payload && payload.errorCode;
              err.httpStatus = res.status;
              throw err;
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.error) {
            throw new Error(snapshot.error);
          }
          if (snapshot && snapshot.id) {
            if (state.queueEpoch > epochBeforePost && snapshot.queuedMessages) {
              delete snapshot.queuedMessages;
            }
            updateSessionSnapshot(snapshot);
            // 仅当 snapshot 仍属当前选中会话时才覆盖视图状态，否则只更新底层数据。
            if (snapshot.id === state.selectedId) {
              var refreshedSession = state.sessions.find(function(s) { return s.id === snapshot.id; }) || snapshot;
              state.currentMessages = buildMessagesForRender(refreshedSession, getPreferredMessages(refreshedSession, snapshot.output, false));
              renderChat(true);
              updateStructuredQueueCounter();
              // toast 已在 click 时乐观 fire（见 isQueueing / isInterrupting 分支），
              // 这里不再重复推送，避免同一动作出两条一样的 toast。
            }
          }
        })
        .catch(function(error) {
          // duplicate_idempotency_key：服务端识别出 WebView 底层重发的副本，
          // 直接拦截不处理。这里**不**回滚乐观更新——第一次的请求实际上已经
          // 被服务端接收并处理（或正在处理），ws 推送会带回真实状态；如果在
          // 这里把 user turn rollback 掉，第一次的 user 消息会从 UI 上消失。
          if (error && error.errorCode === "duplicate_idempotency_key") {
            showToast(error.message || "检测到重复发送，已拦截。", "warning");
            updateInputHint("Enter 发送 · Shift+Enter 换行");
            return;
          }

          if (isQueueing) {
            // Queue 模式回滚：把刚 push 的那条 queuedMessages 撤掉。inFlight / messages
            // 都没动过，不必复位，否则会把后端真实的 inFlight=true 误改成 false。
            var prevQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
            updateSessionSnapshot({
              id: session.id,
              queuedMessages: prevQueue,
            });
            if (session.id === state.selectedId) {
              var rolledQueueSession = state.sessions.find(function(s) { return s.id === session.id; }) || session;
              state.currentMessages = buildMessagesForRender(rolledQueueSession, getPreferredMessages(rolledQueueSession, rolledQueueSession.output, false));
              renderChat(true);
              updateStructuredQueueCounter();
            }
          } else {
            // 回滚乐观更新：恢复发送前的 messages（去掉刚加的 userTurn）和 inFlight 状态
            var rollbackMsgs = userMsgs.slice(0, -1);
            updateSessionSnapshot({
              id: session.id,
              status: session.status,
              messages: rollbackMsgs,
              structuredState: Object.assign({}, session.structuredState || {}, { inFlight: false }),
            });
            if (session.id === state.selectedId) {
              state.currentMessages = buildMessagesForRender(
                Object.assign({}, session, { messages: rollbackMsgs, structuredState: Object.assign({}, session.structuredState || {}, { inFlight: false }) }),
                rollbackMsgs
              );
              renderChat(true);
            }
          }
          var message = (error && error.message) || "";
          var isTransientAbort =
            message === "Failed to fetch" ||
            message === "NetworkError when attempting to fetch resource." ||
            message === "Load failed" ||
            /aborted|aborterror|networkerror|failed to fetch/i.test(message);
          if (!isTransientAbort) {
            showToast((error && error.message) || "无法发送结构化消息。", "error");
          }
          updateInputHint("Enter 发送 · Shift+Enter 换行");
        });
      }

      export function updateInputHint(text) {
        var hint = document.querySelector(".input-hint");
        if (hint) hint.textContent = text;
      }

      export function updateStructuredQueueCounter() {
        // 旧 #queue-counter 已下线，所有"排队"提示由 .queue-bar（输入框上方独立浮条）承担。
        // 函数名先保留 —— 老的调用点（postStructuredInput / WS 事件等）都还在指向它。
        updateQueueBar();
      }

      // ──────────────────────────────────────────────────────────────────────────
      // 排队气泡条（.queue-bar）—— 放在 .composer-top-row 右端，与 todo 进度同
      // 一行；视觉是 iOS 26 液态玻璃胶囊。
      // 交互：
      //   · 收起态：水平排 N 个小气泡（编号 + 截断文本）。>3 条时显示「+N」徽章。
      //   · 点击胶囊空白处 / 任何气泡本体 → 展开为垂直列表
      //   · 展开态：每条气泡显示完整文本 + ⚡ 立即 + × 删除；容器底部有「全部清空」
      //   · 收起 / 展开都可拖拽气泡换序（pointer events）
      //   · 点击 ⚡ / × / +N / 全部清空：执行对应操作，**不**触发展开切换
      // 数据源：session.queuedMessages（后端 WS + postStructuredInput 乐观更新）。
      // ──────────────────────────────────────────────────────────────────────────

      export var QUEUE_BAR_MAX = 10;            // 后端硬上限
      export var QUEUE_CHIP_MAX_TEXT = 26;      // 单行气泡字数上限（一行一个，右侧贴边）

      export function queueChipTruncate(text) {
        if (typeof text !== "string") return "";
        var s = text.replace(/\s+/g, " ").trim();
        if (s.length <= QUEUE_CHIP_MAX_TEXT) return s;
        return s.slice(0, QUEUE_CHIP_MAX_TEXT) + "…";
      }

      // 旧的「展开/收起」整体态已下线（气泡条改为常驻垂直列表）。保留 setter 供
      // ESC 兜底调用，确保任何遗留 expanded class 都会被清掉。
      function isQueueBarExpanded() {
        return !!state.queueBarExpanded;
      }

      export function setQueueBarExpanded(expanded) {
        if (!!state.queueBarExpanded === !!expanded) return;
        state.queueBarExpanded = !!expanded;
        var bar = document.querySelector(".queue-bar");
        if (bar) bar.classList.toggle("expanded", !!expanded);
      }

      export function renderQueueBarHtml(items, inFlight, atCapacity) {
        var n = items.length;
        var barClass = "queue-bar";
        if (atCapacity) barClass += " queue-bar-capacity";
        if (inFlight) barClass += " queue-bar-inflight";

        var promoteTitle = inFlight ? "中断当前回复，立即发送这条" : "立即发送这条";
        // 始终垂直列表：一行一个气泡，右侧贴边，浮在输入框顶边线上方。
        // 每条气泡：编号 + 单行截断文本 + ⚡ 立即 + × 删除。气泡本体可按住拖动调序。
        var chipNodes = "";
        for (var i = 0; i < n; i++) {
          var raw = items[i] == null ? "" : String(items[i]);
          var displayText = queueChipTruncate(raw);
          var titleAttr = raw + "（按住可拖动调序）";
          chipNodes +=
            '<li class="queue-bar-item" data-index="' + i + '" data-action="drag"' +
                ' title="' + escapeHtml(titleAttr) + '">' +
              '<span class="queue-bar-item-index" aria-hidden="true">' + (i + 1) + '</span>' +
              '<span class="queue-bar-item-text">' + escapeHtml(displayText) + '</span>' +
              '<button type="button" class="queue-bar-item-promote" data-action="promote-item"' +
                    ' title="' + escapeHtml(promoteTitle) + '" aria-label="立即发送第 ' + (i + 1) + ' 条">' +
                '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
                  '<path d="M13 2 L4 14 L11 14 L10 22 L20 9 L13 9 Z"/>' +
                '</svg>' +
              '</button>' +
              '<button type="button" class="queue-bar-item-delete" data-action="delete"' +
                    ' aria-label="删除第 ' + (i + 1) + ' 条排队消息" title="删除">' +
                '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                    ' stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>' +
              '</button>' +
            '</li>';
        }

        // 顶部小工具条：仅在 ≥2 条时出现，展示条数 + 「清空」。右侧贴边。
        var headerBar = "";
        if (n >= 2) {
          headerBar =
            '<div class="queue-bar-head">' +
              '<span class="queue-bar-head-count">' + n + ' 条排队</span>' +
              '<button type="button" class="queue-bar-clear-all" data-action="clear-all"' +
                    ' title="清空全部排队" aria-label="清空全部 ' + n + ' 条排队消息">清空</button>' +
            '</div>';
        }

        return (
          '<div class="' + barClass + '" data-queue-bar="1" title="排队 ' + n + ' 条（按住气泡可调序）">' +
            headerBar +
            '<ol class="queue-bar-list" data-queue-list="1">' + chipNodes + '</ol>' +
          '</div>'
        );
      }

      export function updateQueueBar() {
        var host = document.getElementById("queue-bar-host");
        if (!host) return;
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var isStructured = session && session.sessionKind === "structured";
        var queue = isStructured ? getStructuredQueuedInputs(session) : [];
        queue = Array.isArray(queue) ? queue : [];

        if (!isStructured || queue.length === 0) {
          host.hidden = true;
          host.innerHTML = "";
          // 队列空时同步把"展开"标志收回，避免下次出现新排队时还是展开态。
          state.queueBarExpanded = false;
          return;
        }

        // 拖拽进行中绝不重建 DOM，否则 pointer capture 丢失、气泡闪屏。
        if (state.queueBarDrag) return;

        host.hidden = false;
        var inFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
        var atCapacity = queue.length >= QUEUE_BAR_MAX;

        host.innerHTML = renderQueueBarHtml(queue, inFlight, atCapacity);
      }

      // ── 单条删除 / 全部清空 / 队首插队 ──
      export function rollbackQueueOptimistic(session, prevQueue) {
        updateSessionSnapshot({ id: session.id, queuedMessages: prevQueue });
        var refreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
        state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
        renderChat(true);
        updateQueueBar();
      }

      export function queueBarDeleteItem(index) {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return;
        var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        if (index < 0 || index >= queue.length) return;
        var prev = queue.slice();
        var next = queue.slice(0, index).concat(queue.slice(index + 1));
        updateSessionSnapshot({ id: session.id, queuedMessages: next });
        var refreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
        state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
        renderChat(true);
        updateQueueBar();
        fetch("/api/structured-sessions/" + session.id + "/queued/" + index, {
          method: "DELETE",
          credentials: "same-origin",
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return {}; }).then(function(p) {
              throw new Error((p && p.error) || "删除失败");
            });
          }
        })
        .catch(function(err) {
          rollbackQueueOptimistic(session, prev);
          showToast((err && err.message) || "删除排队消息失败。", "error");
        });
      }

      export function queueBarClearAll() {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return;
        var prev = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        if (prev.length === 0) return;
        // 全部清空后收起列表，UX 上更干净（用户不需要盯着一条不剩的展开面板）。
        state.queueBarExpanded = false;
        updateSessionSnapshot({ id: session.id, queuedMessages: [] });
        var refreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
        state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
        renderChat(true);
        updateQueueBar();
        fetch("/api/structured-sessions/" + session.id + "/queued", {
          method: "DELETE",
          credentials: "same-origin",
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return {}; }).then(function(p) {
              throw new Error((p && p.error) || "清空失败");
            });
          }
          showToast("已清空 " + prev.length + " 条排队消息。", "info");
        })
        .catch(function(err) {
          rollbackQueueOptimistic(session, prev);
          showToast((err && err.message) || "清空排队消息失败。", "error");
        });
      }

      // 把队列里第 index 条剥下来，作为新的输入立刻发送出去。
      // - inFlight：interrupt + preserveQueue（中断当前回复，保留其它排队）
      // - 非 inFlight：当作普通新消息发出去
      // 用户路径：点输入框上方的气泡（chip）→ 这里。
      export function queueBarPromoteIndex(index) {
        if (state.queueBarPromoting) return;
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return;
        var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        if (index < 0 || index >= queue.length) return;
        var picked = queue[index];
        var rest = queue.slice(0, index).concat(queue.slice(index + 1));
        var prev = queue.slice();
        var inFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
        state.queueBarPromoting = true;

        // 乐观：剥掉这一条
        // 如果剩下的队列为空（用户把唯一一条 promote 出去），自动收起气泡条。
        if (rest.length === 0) {
          state.queueBarExpanded = false;
        }
        updateSessionSnapshot({ id: session.id, queuedMessages: rest });

        var idempotencyKey = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));

        // 给一个乐观 toast，让用户瞬间知道点击生效了
        showToast(inFlight ? "已请求中断当前回复，立即发送这条。" : "已立即发送这条消息。", "info");

        fetch("/api/structured-sessions/" + session.id + "/queued/" + index + "/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ expectedText: picked, idempotencyKey: idempotencyKey }),
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return {}; }).then(function(p) {
              throw new Error((p && p.error) || "立即发送失败");
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.id) {
            updateSessionSnapshot(snapshot);
            if (snapshot.id === state.selectedId) {
              var refreshed = state.sessions.find(function(s) { return s.id === snapshot.id; }) || snapshot;
              state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, snapshot.output, false));
              renderChat(true);
              updateQueueBar();
            }
          }
          state.queueBarPromoting = false;
        })
        .catch(function(err) {
          state.queueBarPromoting = false;
          rollbackQueueOptimistic(session, prev);
          showToast((err && err.message) || "立即发送失败。", "error");
        });
      }

      // ── 拖拽排序（Pointer Events + 真实高度的 sort/animate）──
      // 单条气泡的 pointerdown 也会进这里，但 queue.length <= 1 时直接返回，让
      // 系统 click 事件穿透到 #queue-bar-host 的 click delegate（那里再判断"点击
      // 气泡 → 立即发送"）。
      export function queueBarDragStart(ev, chipEl) {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return;
        var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        if (queue.length <= 1) return;
        if (!chipEl) return;
        var listEl = chipEl.parentElement;
        if (!listEl) return;
        var origIndex = Number(chipEl.getAttribute("data-index"));
        var siblings = Array.prototype.slice.call(listEl.children);
        var rects = siblings.map(function(el) { return el.getBoundingClientRect(); });
        // 真实间距：相邻两个 chip 的 top 差减去前一个高度（容错 hover 状态变化后的高度切换）
        var gap = 3;
        if (rects.length >= 2) gap = Math.max(0, rects[1].top - rects[0].top - rects[0].height);

        ev.preventDefault();
        try { chipEl.setPointerCapture(ev.pointerId); } catch (_e) {}
        if (navigator && navigator.vibrate) { try { navigator.vibrate(8); } catch (_e2) {} }

        state.queueBarDrag = {
          pointerId: ev.pointerId,
          handleEl: chipEl,
          itemEl: chipEl,
          listEl: listEl,
          siblings: siblings,
          rects: rects,
          origIndex: origIndex,
          targetIndex: origIndex,
          startY: ev.clientY,
          gap: gap,
          queueSnapshot: queue,
        };

        chipEl.classList.add("dragging");
        // 把所有兄弟先标记为"参与平滑动画"
        siblings.forEach(function(el) { if (el !== chipEl) el.classList.add("queue-bar-item-sliding"); });

        var move = function(e) { queueBarDragMove(e); };
        var up = function(e) { queueBarDragEnd(e); };
        state.queueBarDrag.moveHandler = move;
        state.queueBarDrag.upHandler = up;
        chipEl.addEventListener("pointermove", move);
        chipEl.addEventListener("pointerup", up);
        chipEl.addEventListener("pointercancel", up);
      }

      // 给定 origIndex / target / 真实 rects，算出新排列下每个 sibling 的目标 top。
      // 用真实高度而不是固定 shift，因为 expanded chip 比 collapsed 高很多。
      export function queueBarComputeNewTops(origIndex, target, rects, gap) {
        var n = rects.length;
        var order = [];
        for (var i = 0; i < n; i++) order.push(i);
        order.splice(origIndex, 1);
        order.splice(target, 0, origIndex);
        var top = rects[0].top;
        // list 是右对齐 column flex，所有元素相对 list 左边对齐 — 我们只关心 top
        // 用第一个 rect 的 top 作为锚点累加。
        // 但 list 起始位置不一定是 rects[0].top（rects[0] 现在变到 order[0] 的位置）
        // 这里需要找原本的 list top —— 取 rects 里最小 top 即可。
        var listTop = rects[0].top;
        for (var k = 1; k < n; k++) if (rects[k].top < listTop) listTop = rects[k].top;
        var newTops = {};
        var cursor = listTop;
        for (var newPos = 0; newPos < n; newPos++) {
          var oldIdx = order[newPos];
          newTops[oldIdx] = cursor;
          cursor += rects[oldIdx].height + gap;
        }
        return newTops;
      }

      export function queueBarDragMove(ev) {
        var d = state.queueBarDrag;
        if (!d || ev.pointerId !== d.pointerId) return;
        ev.preventDefault();
        var deltaY = ev.clientY - d.startY;
        d.itemEl.style.transform = "translateY(" + deltaY + "px)";

        // 拖动中心 Y 决定目标插入位置
        var centerY = d.rects[d.origIndex].top + d.rects[d.origIndex].height / 2 + deltaY;
        var target = d.origIndex;
        for (var i = 0; i < d.rects.length; i++) {
          if (i === d.origIndex) continue;
          var midY = d.rects[i].top + d.rects[i].height / 2;
          if (i < d.origIndex && centerY < midY) { target = Math.min(target, i); }
          else if (i > d.origIndex && centerY > midY) { target = Math.max(target, i); }
        }
        if (target !== d.targetIndex) {
          d.targetIndex = target;
          // 按真实高度精确算每个 sibling 的新 top
          var newTops = queueBarComputeNewTops(d.origIndex, target, d.rects, d.gap);
          d.siblings.forEach(function(el, idx) {
            if (idx === d.origIndex) return;
            var move = newTops[idx] - d.rects[idx].top;
            el.style.transform = move ? "translateY(" + move + "px)" : "";
          });
        }
      }

      export function queueBarDragEnd(ev) {
        var d = state.queueBarDrag;
        if (!d || (ev && ev.pointerId !== d.pointerId)) return;
        try { d.handleEl.releasePointerCapture(d.pointerId); } catch (_e) {}
        d.handleEl.removeEventListener("pointermove", d.moveHandler);
        d.handleEl.removeEventListener("pointerup", d.upHandler);
        d.handleEl.removeEventListener("pointercancel", d.upHandler);

        var origIndex = d.origIndex;
        var targetIndex = d.targetIndex;
        var queueSnapshot = d.queueSnapshot;

        // 清掉 inline transform 让 CSS 自然回位
        d.siblings.forEach(function(el) {
          el.style.transform = "";
          el.classList.remove("queue-bar-item-sliding");
        });
        d.itemEl.classList.remove("dragging");

        state.queueBarDrag = null;

        if (origIndex === targetIndex) {
          // 没动 → 单纯刷新一下。立即发送由 chip 内部的 ⚡ 按钮触发，
          // 不在 chip 本体上做隐式 tap-to-promote（容易误触）。
          updateQueueBar();
          return;
        }

        // 计算 order: 原下标的新排列
        var order = [];
        for (var i = 0; i < queueSnapshot.length; i++) order.push(i);
        order.splice(origIndex, 1);
        order.splice(targetIndex, 0, origIndex);
        var nextQueue = order.map(function(i) { return queueSnapshot[i]; });

        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) { updateQueueBar(); return; }
        updateSessionSnapshot({ id: session.id, queuedMessages: nextQueue });
        updateQueueBar();

        fetch("/api/structured-sessions/" + session.id + "/queued", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ order: order }),
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return {}; }).then(function(p) {
              throw new Error((p && p.error) || "排序失败");
            });
          }
        })
        .catch(function(err) {
          rollbackQueueOptimistic(session, queueSnapshot);
          showToast((err && err.message) || "调整排队顺序失败。", "error");
        });
      }

      // ── 事件代理：所有交互入口都从 #queue-bar-host 起手 ──
      export function attachQueueBarDelegates() {
        var host = document.getElementById("queue-bar-host");
        if (!host || (host as any).__queueDelegated) return;
        (host as any).__queueDelegated = true;
        host.addEventListener("click", function(ev) {
          var evTarget = ev.target as HTMLElement;
          var actionEl = evTarget && evTarget.closest ? evTarget.closest("[data-action]") : null;
          if (actionEl && host.contains(actionEl)) {
            var action = actionEl.getAttribute("data-action");
            // chip 本体（data-action="drag"）由 pointerdown 走 drag-or-tap 流程；
            // click 阶段不处理，否则会和拖拽收尾冲突。
            if (action === "drag") return;
            ev.preventDefault();
            ev.stopPropagation();
            if (action === "promote-item") {
              var pItem = actionEl.closest(".queue-bar-item");
              if (pItem) queueBarPromoteIndex(Number(pItem.getAttribute("data-index")));
            } else if (action === "delete") {
              var itemEl = actionEl.closest(".queue-bar-item");
              if (itemEl) queueBarDeleteItem(Number(itemEl.getAttribute("data-index")));
            } else if (action === "clear-all") {
              queueBarClearAll();
            }
            return;
          }
          // 点气泡本体（无拖动发生）= 无操作。立即发送 / 删除走各自按钮。
          // 真正发生过拖动时 pointer 链会吞掉 click，这里只会接到 tap。
        });
        // 整个气泡都是拖拽起手区。⚡ / × / +N / 全部清空 通过 closest 跳过，
        // 让 click 阶段去处理它们。
        host.addEventListener("pointerdown", function(ev) {
          if (ev.button !== undefined && ev.button !== 0) return;
          var evTarget = ev.target as HTMLElement;
          if (evTarget && evTarget.closest && evTarget.closest(
                '[data-action="delete"], [data-action="promote-item"], ' +
                '[data-action="clear-all"], [data-action="expand"]')) return;
          var chip = evTarget && evTarget.closest ? evTarget.closest(".queue-bar-item") : null;
          if (!chip) return;
          queueBarDragStart(ev, chip);
        });
        // ESC 收起 —— 只在已展开时拦截，避免吞掉 input 里的 ESC
        host.addEventListener("keydown", function(ev) {
          if (ev.key === "Escape" && isQueueBarExpanded()) {
            ev.stopPropagation();
            setQueueBarExpanded(false);
          }
        });
      }

      // 结构化会话的"对话视图"现在只渲染真实的 user/assistant turn。排队消息（还没
      // flush 出去那批）由 .queue-bar 在对话区右下角统一展示，不再在 chat 流里贴一份
      // 半透明 "排队中" 用户气泡——避免同一条消息在 UI 上出现两次。
      export function buildMessagesForRender(session, messages) {
        var sanitized = Array.isArray(messages) ? stripRenderOnlyStructuredMessages(messages) : [];
        var base = Array.isArray(sanitized) ? sanitized.slice() : [];
        if (!session || session.sessionKind !== "structured") {
          return base;
        }
        if (session.structuredState && session.structuredState.inFlight) {
          var last = base[base.length - 1];
          if (!last || last.role !== "assistant") {
            base.push({ role: "assistant", content: [{ type: "text", text: "", __processing: true }] });
          }
        }
        return base;
      }

      export function flushStructuredInputQueue() {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        syncStructuredQueueFromSession(session);
        updateStructuredQueueCounter();
      }

      export function getInputErrorMessage(error) {
        var selectedSession = getSelectedSession();
        var isCodex = selectedSession && selectedSession.provider === "codex";
        if (error && (error.errorCode === "SESSION_NOT_RUNNING" || error.errorCode === "SESSION_NO_PTY")) {
          return isCodex
            ? "Codex 会话已结束；若存在 Codex 历史会话，将在你下次发送消息时自动恢复。"
            : "会话已结束；若存在 Claude 历史会话，将在你下次发送消息时自动恢复。";
        }
        if (error && error.errorCode === "SESSION_NOT_FOUND") {
          return "会话不存在，请重新选择或新建会话。";
        }
        return (error && error.message) || (isCodex
          ? "Codex 会话暂不可用；若存在 Codex 历史会话，将自动尝试恢复。"
          : "会话暂不可用；若存在 Claude 历史会话，将自动尝试恢复。");
      }

      export function buildInputError(payload) {
        var err = new Error((payload && payload.error) || "会话已结束。") as SendError;
        if (payload && typeof payload === "object") {
          err.errorCode = payload.errorCode || null;
          err.sessionId = payload.sessionId || state.selectedId || null;
          err.sessionStatus = Object.prototype.hasOwnProperty.call(payload, "sessionStatus") ? payload.sessionStatus : null;
        }
        return err;
      }

      export function isSessionUnavailableError(error) {
        return error && (error.errorCode === "SESSION_NOT_RUNNING" || error.errorCode === "SESSION_NO_PTY" || error.errorCode === "SESSION_NOT_FOUND");
      }

      export function markSessionStopped(sessionId, status) {
        if (!sessionId) return;
        updateSessionSnapshot({ id: sessionId, status: status || "exited" });
      }

      export function hasRealConversationHistory(session) {
        if (!session || !Array.isArray(session.messages) || session.messages.length < 2) {
          return false;
        }
        var hasUser = session.messages.some(function(turn) {
          return turn && turn.role === "user" && Array.isArray(turn.content) && turn.content.some(function(block) {
            return block && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
          });
        });
        var hasAssistant = session.messages.some(function(turn) {
          return turn && turn.role === "assistant" && Array.isArray(turn.content) && turn.content.some(function(block) {
            return block && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
          });
        });
        return hasUser && hasAssistant;
      }

      export function canAutoResumeSession(session) {
        // 只要是 Claude/Codex PTY provider + 非运行中 + 有可恢复历史 id，
        // 就允许在用户发送时静默触发恢复。不再要求 messages 里同时
        // 有 user + assistant 文本（slim 列表/截断历史会让该判断失真）。
        return !!(session && !isStructuredSession(session) && (session.provider === "claude" || session.provider === "codex") && session.status !== "running" && session.claudeSessionId);
      }

      export function ensureSessionReadyForInput(session, errorEl?) {
        if (!session) {
          showToast("会话不存在，请重新选择或新建会话。", "error");
          return Promise.resolve(null);
        }
        if (session.status === "running") {
          return Promise.resolve(session);
        }
        if (!canAutoResumeSession(session)) {
          var providerLabel = session && session.provider === "codex" ? "Codex" : "Claude";
          showToast("该会话没有可恢复的 " + providerLabel + " 历史上下文，请新建会话。", "error");
          return Promise.resolve(null);
        }

        // 静默恢复：不再弹 "正在恢复历史会话…" 提示，让用户发送动作看起来无缝。
        return resumeSession(session.id, errorEl).then(function(data) {
          if (!data) return null;
          updateSessionSnapshot(data);
          updateSessionsList();
          subscribeToSession(data.id);
          return loadOutput(data.id).then(function() {
            focusInputBox(true);
            return data;
          });
        });
      }

      export function getTerminalSubmitChunks(session, text) {
        // 文本与回车分两个 chunk 发，避免 CLI 的 bracketed paste 检测把末尾
        // \r 并入粘贴内容导致只换行不提交。
        return [text, String.fromCharCode(13)];
      }

      export function sendTerminalChunks(chunks, shortcutKey, delayMs, viewOverride) {
        var sequence = Array.isArray(chunks) ? chunks.filter(function(chunk) { return !!chunk; }) : [];
        if (sequence.length === 0) {
          return Promise.resolve();
        }
        var delay = typeof delayMs === "number" ? delayMs : 0;
        return sequence.reduce(function(promise, chunk, index) {
          return promise.then(function() {
            if (index > 0 && delay > 0) {
              return new Promise(function(resolve) {
                setTimeout(resolve, delay);
              }).then(function() {
                return queueDirectInput(chunk, index === sequence.length - 1 ? shortcutKey : undefined, viewOverride);
              });
            }
            return queueDirectInput(chunk, index === sequence.length - 1 ? shortcutKey : undefined, viewOverride);
          });
        }, Promise.resolve());
      }

      // pendingMessages 缓存 ws 离线时的输入，重连后回放。每条带时间戳，
      // flush 时丢弃过期项——离线 >TTL 后回放老按键序列只会让 PTY 错位。
      export var PENDING_INPUT_TTL_MS = 5000;
      export var PENDING_INPUT_MAX = 100;
      export function enqueuePendingInput(input) {
        if (!input) return;
        if (state.pendingMessages.length >= PENDING_INPUT_MAX) {
          state.pendingMessages.shift();
        }
        state.pendingMessages.push({ input: input, at: Date.now() });
      }

      export function queueOfflineTerminalChunks(chunks) {
        var sequence = Array.isArray(chunks) ? chunks.filter(function(chunk) { return !!chunk; }) : [];
        sequence.forEach(function(chunk) {
          enqueuePendingInput(chunk);
        });
      }

      // R8: 检测用户输入是否包含 /clear 命令，命中时把 marker 标到当前 buffer
      // 长度，下次 softResync 时就不会重放 /clear 之前的历史。
      // 检测点放在 queueDirectInput 是因为：所有用户 input（chat 框发送、终端
      // interactive 直写、shortcut 按键、bracketed paste 等）最终都汇到这条
      // 路径。先 strip bracketed-paste 包络（\x1b[200~ ... \x1b[201~）再做行首
      // 匹配，覆盖多种粘贴形式。
      export function _detectAndMarkClear(input) {
        if (typeof input !== "string" || !input) return;
        var stripped = input.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
        // 必须 /clear 在某一行起始位置，且后接 \r 或 \n 或行尾
        if (/(?:^|\n)\s*\/clear\s*(?:\r|\n|$)/.test(stripped)) {
          if (typeof state !== "undefined" && state) {
            state.terminalOutputMarker = (state.terminalOutput && state.terminalOutput.length) | 0;
          }
        }
      }

      export function queueDirectInput(input, shortcutKey?, viewOverride?) {
        if (!input || !state.selectedId) return Promise.resolve();
        _detectAndMarkClear(input);
        state.messageQueue.push(input);
        state.inputQueue = state.inputQueue.then(function() {
          return postInput(input, shortcutKey, viewOverride).finally(function() {
            var idx = state.messageQueue.indexOf(input);
            if (idx > -1) state.messageQueue.splice(idx, 1);
          });
        });
        return state.inputQueue;
      }

      export function postInput(input, shortcutKey, viewOverride) {
        if (!state.selectedId) return Promise.resolve();
        // 锁定本次请求归属的 sessionId。fetch 发起后用户可能切到别的会话，
        // 后续 then 回调里直接用 state.selectedId 会误把 A 的响应应用到 B：
        //   - URL 上拼错会话（虽然 fetch 已经求值过 URL，但 markSessionStopped
        //     等 in-flight 引用会读最新值 → 把 B 标为 stopped 但实际是 A 失败）
        //   - response.snapshot 属于 A，被 setCurrentMessages 误覆盖到 B 视图
        // 用 requestSessionId 锁住请求方，渲染相关动作再单独判断 snapshot.id
        // === 当前 state.selectedId 才执行。
        var requestSessionId = state.selectedId;
        var effectiveView = viewOverride || state.currentView;

        // Pre-check: don't send if session is not running
        if (!isSelectedSessionRunning()) {
          // If WebSocket is disconnected, queue for flush on reconnect
          if (!state.wsConnected) {
            enqueuePendingInput(input);
            console.log("[wand] postInput: session not running, queued for reconnect", {
              sessionId: state.selectedId,
              inputLength: input.length
            });
            return Promise.resolve();
          }
          console.warn("[wand] postInput: session not running, skipping send", {
            sessionId: state.selectedId
          });
          showToast("会话未运行，正在等待自动恢复后重试。", "info");
          return Promise.resolve();
        }

        // If WebSocket is disconnected, queue the message (no HTTP fetch while offline)
        if (!state.wsConnected) {
          enqueuePendingInput(input);
          console.log("[wand] postInput: WebSocket disconnected, queued message", {
            sessionId: state.selectedId,
            inputLength: input.length
          });
          return Promise.resolve();
        }

        return fetch("/api/sessions/" + requestSessionId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, view: effectiveView, shortcutKey: shortcutKey || undefined })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return { error: "请求失败" }; }).then(function(payload) {
              var error = buildInputError(payload) as SendError;
              error.httpStatus = res.status;
              console.error("[wand] postInput: request failed", {
                status: res.status,
                errorCode: error.errorCode,
                message: error.message,
                sessionId: requestSessionId
              });
              // Mark session as stopped for unavailable errors
              if (isSessionUnavailableError(error)) {
                markSessionStopped(requestSessionId, error.sessionStatus || "exited");
              }
              throw error;
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.id) {
            // 底层 sessions 数据按 id 索引，无论是否仍是当前选中都可以
            // 安全更新（不会污染其他会话）。
            updateSessionSnapshot(snapshot);
            // 但 currentMessages / renderChat 是当前视图状态，必须仅当
            // snapshot 仍属当前选中会话时才执行；否则会把 A 的消息列表
            // 渲染到 B 的 chat 视图。
            if (snapshot.id === state.selectedId) {
              if (snapshot.messages && snapshot.messages.length > 0) {
                state.currentMessages = snapshot.messages;
              }
              renderChat(true);
            }
          }
          return snapshot;
        });
      }

      export function sendDirectInput(input) {
        return queueDirectInput(input);
      }

      export function getSelectedSession() {
        return state.sessions.find(function(session) { return session.id === state.selectedId; }) || null;
      }

      export function getTerminalSubmitSequence(session) {
        return session && session.provider === "codex" ? "\n" : String.fromCharCode(13);
      }

      export function isTerminalInteractionAvailable() {
        return !!state.selectedId && state.currentView === "terminal";
      }

      // 判断一条带 sessionId 的 ws 消息是否应该被当前 wterm 实例消费。
      // 收敛多处散落的"selectedId 一致 + terminalSessionId 兼容"判断，避免
      // 后续重构时漏改某一处导致旧会话的输出污染当前终端。
      // terminalSessionId 为空（尚未首次 init/切换刚发生）视为可接受任何
      // sessionId —— 这是首条 chunk 触发自我初始化的场景。
      export function isCurrentTerminalSession(sessionId) {
        if (!state.terminal || !sessionId) return false;
        if (sessionId !== state.selectedId) return false;
        if (state.terminalSessionId && state.terminalSessionId !== sessionId) return false;
        return true;
      }

      export function shouldCaptureTerminalEvent(event) {
        if (!state.terminalInteractive || !isTerminalInteractionAvailable()) return false;
        if (event.defaultPrevented || event.isComposing) return false;
        var target = event.target;
        if (!target) return true;
        if (
          document.documentElement.classList.contains("is-wand-embed-terminal") &&
          target.closest &&
          target.closest("#input-box")
        ) {
          return false;
        }
        if (target.closest && target.closest("#mini-keyboard")) return false;
        if (shouldIgnoreInteractiveTarget(target)) return false;
        return true;
      }

      export var keyboardEventKeyMap = {
        Esc: "escape",
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        Enter: "enter",
        Tab: "tab",
        Backspace: "backspace",
        Home: "home",
        End: "end",
        PageUp: "pageup",
        PageDown: "pagedown",
        Delete: "delete",
        Insert: "insert",
        " ": "space"
      };

      export var ptySpecialKeyMap = {
        space: " ",
        tab: String.fromCharCode(9),
        shift_tab: String.fromCharCode(27) + "[Z",
        backspace: String.fromCharCode(127),
        home: String.fromCharCode(27) + "[H",
        end: String.fromCharCode(27) + "[F",
        pageup: String.fromCharCode(27) + "[5~",
        pagedown: String.fromCharCode(27) + "[6~",
        delete: String.fromCharCode(27) + "[3~",
        insert: String.fromCharCode(27) + "[2~"
      };

      export var ctrlSymbolMap = {
        " ": 0,
        "[": 27,
        "\\": 28,
        "]": 29,
        "^": 30,
        "_": 31
      };

      // ── 终端悬浮摇杆遥控器常量与布局表 ──
      export var JOYSTICK_LONG_PRESS_MS = 400;     // 按住不动多久进入移动模式
      export var JOYSTICK_MOVE_THRESHOLD = 10;     // px：区分"拖动选键"与"静止长按"
      export var JOYSTICK_TAP_THRESHOLD = 8;       // px：快速点击的最大位移
      export var JOYSTICK_BALL_SIZE = 54;          // 球球直径（与 CSS 一致）
      export var JOYSTICK_EDGE_MARGIN = 8;         // 球球钳进视口的留白
      export var JOYSTICK_ACTION_KEYS = [
        { key: "enter", label: "Enter" },
        { key: "ctrl_c", label: "Ctrl+C" },
        { key: "escape", label: "Esc" },
        { key: "shift_tab", label: "Shift+Tab" }
      ];

      export var ignoredInteractiveTargetIds = new Set([
        "mini-keyboard-fab",
        "mini-keyboard-toggle",
        "terminal-interactive-toggle"
      ]);

      export function shouldIgnoreInteractiveTarget(target) {
        if (!target) return false;
        if (ignoredInteractiveTargetIds.has(target.id)) return true;
        // React/Radix overlays own their keyboard contract. In terminal-interactive
        // mode the document capture listener otherwise consumes Escape before the
        // dialog can dismiss itself (and can forward radio arrow keys to the PTY).
        return !!(target.closest && target.closest('[role="dialog"], [role="alertdialog"]'));
      }

      export var modifierKeySet = new Set(["ctrl", "alt", "shift"]);

      export function isModifierKey(key) {
        return modifierKeySet.has(key);
      }

      export function getPtySpecialSequence(key) {
        return ptySpecialKeyMap[key] || "";
      }

      export function getCtrlSequence(text) {
        var lower = text.toLowerCase();
        if (lower >= "a" && lower <= "z") {
          return String.fromCharCode(lower.charCodeAt(0) - 96);
        }
        if (Object.prototype.hasOwnProperty.call(ctrlSymbolMap, lower)) {
          return String.fromCharCode(ctrlSymbolMap[lower]);
        }
        return "";
      }

      export function keyFromKeyboardEvent(event) {
        return keyboardEventKeyMap[event.key] || event.key;
      }

      export function getModifierStateFromEvent(event, key) {
        return {
          ctrl: event.ctrlKey,
          alt: event.altKey,
          // 仅对单字符键保留 shift（控制 toUpperCase 路径），
          // 但 Tab 特例：物理 Shift+Tab 要走 buildPtySequence 的 back-tab 分支。
          shift: event.shiftKey && (key.length === 1 || key === "tab"),
          meta: event.metaKey
        };
      }

      export function sendTerminalSequence(sequence, shortcutKey) {
        if (!sequence) return;
        queueDirectInput(sequence, shortcutKey).catch(function() {});
      }

      export function focusTerminalInteractionTarget() {
        focusTerminalContainer();
      }

      export function hideMiniKeyboard(clearModifiersOnHide?) {
        // Just clear modifiers, inline keyboard visibility follows view
        state.keyboardPopupOpen = false;
        if (clearModifiersOnHide !== false) {
          clearModifiers();
        }
        updateKeyboardPopupUI();
      }

      export function toggleTerminalInteractive() {
        if (!isTerminalInteractionAvailable()) return;
        setTerminalInteractive(!state.terminalInteractive);
      }

      export function setTerminalInteractive(enabled) {
        var next = !!enabled && isTerminalInteractionAvailable();
        if (state.terminalInteractive === next) return;
        state.terminalInteractive = next;
        if (next) {
          enableTerminalCapture();
          hideMiniKeyboard(false);
          focusTerminalInteractionTarget();
          showToast("终端交互模式已开启", "info");
        } else {
          disableTerminalCapture();
          clearModifiers();
        }
        updateInteractiveControls();
      }

      export function reconcileInteractiveState() {
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var shouldDisableInteractive = !selectedSession || selectedSession.status !== "running" || state.currentView !== "terminal";
        if (shouldDisableInteractive && state.terminalInteractive) {
          setTerminalInteractive(false);
          return;
        }
        if ((!selectedSession || state.currentView !== "terminal") && state.keyboardPopupOpen) {
          state.keyboardPopupOpen = false;
        }
        updateInteractiveControls();
      }

      export function updateInteractiveControls() {
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var structured = isStructuredSession(selectedSession);
        var isCodex = selectedSession && selectedSession.provider === "codex";
        var isRunning = structured
          ? !!(selectedSession && selectedSession.structuredState && selectedSession.structuredState.inFlight)
          : !!selectedSession && selectedSession.status === "running";
        var composer = document.getElementById("input-box") as HTMLInputElement | null;
        // 终端交互 toggle 现在挂在加号 popover 内。.active 保留兼容；
        // .is-on 给 popover-item 提供独立的"已开启"视觉；同时刷新 aria-pressed 与 "开/关" 文本。
        var toggles = ["terminal-interactive-toggle-top"];
        toggles.forEach(function(id) {
          var toggle = document.getElementById(id);
          if (toggle) {
            toggle.classList.toggle("active", state.terminalInteractive);
            toggle.classList.toggle("is-on", state.terminalInteractive);
            toggle.classList.toggle("hidden", structured || state.currentView !== "terminal" || !selectedSession);
            toggle.setAttribute("aria-pressed", state.terminalInteractive ? "true" : "false");
            var stateLabel = toggle.querySelector(".plus-popover-toggle-state");
            if (stateLabel) stateLabel.textContent = state.terminalInteractive ? "开" : "关";
          }
        });
        var inputHint = document.querySelector(".input-hint");
        if (inputHint) {
          inputHint.classList.toggle("hidden", structured ? true : state.currentView === "terminal");
          if (!structured && selectedSession) {
            inputHint.textContent = isCodex
              ? "Enter 发送 · chat 为解析视图，terminal 为原始输出"
              : "Enter 发送 · Shift+Enter 换行";
          }
        }
        // 历史会话只要可自动恢复（Claude/Codex PTY + 有历史 id），输入框/发送按钮
        // 就保持可用——发送时由 ensureSessionReadyForInput 透明完成恢复。
        var canResumeOnSend = !structured && !isRunning && canAutoResumeSession(selectedSession);
        if (composer) {
          composer.placeholder = getComposerPlaceholder(selectedSession, state.terminalInteractive);
          composer.disabled = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
          composer.setAttribute("aria-disabled", composer.disabled ? "true" : "false");
          // INPUT-3: 交互模式不再设 readOnly。readOnly 的 textarea 上 IME 根本不会
          // 激活（compositionstart 不触发），导致中文/日文等组字输入彻底打不出。普通
          // 字符 keydown 已由 capture 阶段的 captureTerminalInput preventDefault 拦截、
          // 不会落进 textarea；唯独 IME 组字期间 capture 放行(isComposing)，字符临时
          // 落入 textarea，由 compositionend 取最终文本发 PTY 后清空。
          composer.readOnly = false;
          composer.classList.toggle(
            "is-terminal-passthrough",
            !!state.terminalInteractive && !document.documentElement.classList.contains("is-wand-embed-terminal"),
          );
        }
        // v2: 终端交互模式时强制退出语音模式（语义冲突）。三件套已不在输入框里，
        // 不再需要 is-terminal-mode / has-placeholder 控制 ghost meta 显隐。
        var composerEl = document.querySelector(".input-composer");
        if (composerEl && state.terminalInteractive && composerEl.classList.contains("voice-mode")) {
          composerEl.classList.remove("voice-mode");
          // 同步停掉可能在跑的录音 + 隐藏气泡
          voiceState.recording = false;
          resetVoiceRecordingUI();
        }
        var sendBtn = document.getElementById("send-input-button") as HTMLButtonElement | null;
        var structuredInFlight = structured && isRunning;
        if (sendBtn) {
          sendBtn.disabled = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
          sendBtn.setAttribute("title", structured
            ? (structuredInFlight ? "排队发送（当前回复结束后处理）" : "发送")
            : (isCodex ? (isRunning ? "发送给 Codex" : "Codex 会话已结束") : (!selectedSession || isRunning || canResumeOnSend ? "发送" : "会话已结束")));
          sendBtn.classList.toggle("queue-mode", structuredInFlight);
        }
        // 停止按钮：仅当当前会话真"在跑"才露出（结构化 inFlight / PTY running / 等待权限阻塞）。
        // 平时让位给主操作（send 按钮一侧整齐，输入区视觉更安静）。
        var stopBtn = document.getElementById("stop-button");
        if (stopBtn) {
          var sig = computeRunningSignal(selectedSession);
          stopBtn.classList.toggle("hidden", !sig.active);
        }
        // v2: 停止按钮仅在「真有 reply 在跑」时显示。computeRunningSignal 给出统一信号
        //  · structured.inFlight  → 结构化会话流式输出中
        //  · pty status==running  → PTY 会话进程在跑
        //  · permissionBlocked    → 卡在权限审批（也允许停止解封）
        var stopBtnEl = document.getElementById("stop-button");
        if (stopBtnEl) {
          var runSig = computeRunningSignal(selectedSession);
          stopBtnEl.classList.toggle("hidden", !runSig.active);
        }
        var container = document.getElementById("output");
        if (container) container.classList.toggle("interactive", !structured && state.terminalInteractive);
        updateJoystickVisibility();
      }

      // COPY-2/COPY-4: 是否存在落在终端输出区(#output)内的活动文本选区。用于：
      // 有选区时 Ctrl+C 放行浏览器原生复制而非发 SIGINT；click 不抢焦点以免打断
      // 双击选词/三击选行后的复制。
      export function hasActiveTerminalSelection() {
        var sel = window.getSelection && window.getSelection();
        if (!sel || sel.isCollapsed) return false;
        var output = document.getElementById("output");
        if (!output) return false;
        var node = sel.anchorNode;
        if (node && node.nodeType === 3) node = node.parentNode;
        return !!(node && output.contains(node));
      }

      export function captureTerminalInput(event) {
        if (!shouldCaptureTerminalEvent(event)) return;
        // INPUT-1: 放行 Cmd/Meta 组合键给浏览器（复制/粘贴/刷新/切标签）。PTY 用
        // Ctrl 不用 Cmd，拦下来既破坏 macOS 原生快捷键，又会把裸字母(Cmd+X→'x')
        // 误塞进 PTY。
        if (event.metaKey) return;
        var key = keyFromKeyboardEvent(event);
        if (!key) return;
        var mods = getModifierStateFromEvent(event, key);
        if (isModifierKey(key)) return;
        // COPY-2: 有选区时 Ctrl+C 放行浏览器原生复制，而不是发 SIGINT(0x03) 把进程
        // 杀了还复制不到。无选区的 Ctrl+C 仍透传给 PTY。
        if (mods.ctrl && key.length === 1 && key.toLowerCase() === "c" && hasActiveTerminalSelection()) {
          return;
        }
        var sequence = buildPtySequence(key, mods);
        // INPUT-4: 只有真正要发给 PTY 的键才 preventDefault；空序列(F5/F12/死键等)
        // 放行给浏览器，避免"既没发 PTY 又吞掉浏览器默认行为"。
        if (!sequence) return;
        event.preventDefault();
        sendTerminalSequence(sequence, key);
      }

      // 快捷键点击后做一次延迟 resync 兜底：maybeScheduleResyncForChunk 偶尔会漏
      // 抓 Codex 菜单切换之类的原地重绘，导致 DOM 行残留。500ms 是为了等服务端把
      // 本次按键的回执完整推过来，避免 resync 只回放到 chunk 一半。
      export function scheduleShortcutResync() {
        if (!state.terminal) return;
        scheduleSoftResyncTerminal(500);
      }

      export function updateKeyboardPopupUI() {
        updateJoystickPanelUI();
      }

      export function handleKeyboardToggle(event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.currentView !== "terminal" || !state.selectedId) return;
        state.keyboardPopupOpen = !state.keyboardPopupOpen;
        updateInteractiveControls();
      }

      export function closeKeyboardPopup() {
        state.keyboardPopupOpen = false;
        updateInteractiveControls();
      }

      export function enableTerminalCapture() {
        document.addEventListener("keydown", captureTerminalInput, true);
      }

      export function disableTerminalCapture() {
        document.removeEventListener("keydown", captureTerminalInput, true);
      }

      export function buildPtySequence(key, modifiers) {
        var mods = modifiers || { ctrl: false, alt: false, shift: false };
        if (isModifierKey(key)) return "";
        // Shift+Tab → CSI Z (back-tab)。Claude Code 用它在 plan / 自动接受 模式间切换。
        if (key === "tab" && mods.shift) return String.fromCharCode(27) + "[Z";
        var specialSequence = getPtySpecialSequence(key);
        if (specialSequence) return specialSequence;
        if (key.indexOf("ctrl_") === 0) {
          return String.fromCharCode(key.charCodeAt(key.length - 1) - 96);
        }
        var mapped = getControlInput(key);
        if (mapped) return mapped;
        if (!key) return "";
        var text = key.length === 1 ? key : "";
        if (!text) return "";
        if (mods.shift) text = text.toUpperCase();
        if (mods.ctrl) {
          return getCtrlSequence(text);
        }
        if (mods.alt) return String.fromCharCode(27) + text;
        return text;
      }

      export function clearModifiers() {
        state.modifiers.ctrl = false;
        state.modifiers.alt = false;
        state.modifiers.shift = false;
        updateModifierUI();
      }

      export function updateModifierUI() {
        var keyboard = document.getElementById("mini-keyboard");
        if (!keyboard) return;
        ["ctrl", "alt", "shift"].forEach(function(name) {
          var btn = keyboard.querySelector('[data-key="' + name + '"]');
          if (btn) btn.classList.toggle("active", !!state.modifiers[name]);
        });
      }

      export function getControlInput(key) {
        switch (key) {
          case "yes":
            return "y" + String.fromCharCode(13);
          case "no":
            return "n" + String.fromCharCode(13);
          case "up":
            return String.fromCharCode(27) + "[A";
          case "down":
            return String.fromCharCode(27) + "[B";
          case "left":
            return String.fromCharCode(27) + "[D";
          case "right":
            return String.fromCharCode(27) + "[C";
          case "enter":
            return String.fromCharCode(13);
          case "ctrl_c":
            return String.fromCharCode(3);
          case "ctrl_d":
            return String.fromCharCode(4);
          case "ctrl_l":
            return String.fromCharCode(12);
          case "ctrl_u":
            return String.fromCharCode(21);
          case "ctrl_k":
            return String.fromCharCode(11);
          case "ctrl_w":
            return String.fromCharCode(23);
          case "ctrl_z":
            return String.fromCharCode(26);
          case "escape":
            return String.fromCharCode(27);
          default:
            return "";
        }
      }

      export function flushPendingMessages() {
        if (state.pendingMessages.length === 0) return;

        var selectedSession = getSelectedSession();
        if (isStructuredSession(selectedSession)) {
          state.pendingMessages = [];
          return;
        }

        // Send queued messages in order, bypassing the session-running check
        // since our local state may be stale right after reconnect
        var now = Date.now();
        var queue = [];
        var dropped = 0;
        state.pendingMessages.forEach(function(item) {
          // Backward-compatible: 老逻辑里 entries 可能是裸字符串。
          if (typeof item === "string") { queue.push(item); return; }
          if (!item || typeof item.input !== "string") return;
          if (now - (item.at || 0) > PENDING_INPUT_TTL_MS) { dropped++; return; }
          queue.push(item.input);
        });
        state.pendingMessages = [];
        if (dropped > 0) {
          console.log("[wand] flushPendingMessages: dropped " + dropped + " stale input(s)");
        }

        var sendPromise = Promise.resolve();
        queue.forEach(function(input) {
          sendPromise = sendPromise.then(function() {
            return sendInputDirect(input).catch(function() {
              // Ignore errors during flush
            });
          });
        });
      }

      export function sendInputDirect(input) {
        if (!input || !state.selectedId) return Promise.resolve();
        // 同 postInput：flushPendingMessages 重连后批量回放离线消息时，
        // 用户可能已在切到别的会话，必须用本次请求的 sessionId 快照。
        var requestSessionId = state.selectedId;
        return fetch("/api/sessions/" + requestSessionId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: input, view: state.currentView })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return { error: "请求失败" }; }).then(function(payload) {
              var error = buildInputError(payload) as SendError;
              error.httpStatus = res.status;
              // Don't re-queue on session-unavailable — the session will auto-resume
              // on the user's next message, and stale queue items would cause duplicates
              if (isSessionUnavailableError(error)) {
                console.log("[wand] sendInputDirect: session unavailable, dropping", {
                  sessionId: requestSessionId,
                  errorCode: error.errorCode
                });
                return null;
              }
              throw error;
            });
          }
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.id) {
            updateSessionSnapshot(snapshot);
            // 仅当 snapshot 仍属当前选中会话时才覆盖视图，否则只更新底层数据。
            if (snapshot.id === state.selectedId) {
              if (snapshot.messages && snapshot.messages.length > 0) {
                state.currentMessages = snapshot.messages;
              }
              renderChat(true);
            }
          }
          return snapshot;
        });
      }

      export function stopSession() {
        if (!state.selectedId) return;
        // 二次确认：停止正在运行的任务是不可逆的中断，按钮 / Esc / Ctrl+C 三个入口
        // 都会走到这里，统一弹一次确认，避免误触取消正在跑的任务。
        var id = state.selectedId;
        wandConfirm(t("stop.confirm.message"), {
          title: t("stop.confirm.title"),
          danger: true,
          okLabel: t("stop.confirm.ok"),
          cancelLabel: t("stop.confirm.cancel"),
        }).then(function(ok: boolean) {
          if (!ok) return;
          // 确认期间用户可能切走会话，沿用确认时捕获的 id，避免停错会话。
          if (state.selectedId !== id) return;
          fetch("/api/sessions/" + id + "/stop", { method: "POST", credentials: "same-origin" })
            .then(refreshAll);
        });
      }

      export function deleteSession(id) {
        var item = isBrowserReactShellMounted()
          ? null
          : document.querySelector('.session-item[data-session-id="' + id + '"]');
        var session = state.sessions.find(function(candidate: any) { return candidate.id === id; });
        var providerSessionId = session && session.claudeSessionId;
        if (item) {
          item.classList.add("deleting");
        }
        setTimeout(function() {
          fetch("/api/sessions/" + id, { method: "DELETE", credentials: "same-origin" })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (data && data.error) {
                throw new Error(data.error);
              }
              if (state.selectedId === id) {
                state.selectedId = null;
                persistSelectedId();
              }
              if (providerSessionId) {
                state.claudeHistory = state.claudeHistory.filter(function(history: any) {
                  return history.claudeSessionId !== providerSessionId;
                });
                state.codexHistory = state.codexHistory.filter(function(history: any) {
                  return history.claudeSessionId !== providerSessionId;
                });
              }
              return refreshAll();
            })
            .catch(function() {
              // Remove deleting state on error so item reappears
              if (item) item.classList.remove("deleting");
              var errorEl = document.getElementById("action-error");
              showError(errorEl, "无法删除会话。");
            });
        }, 250);
      }

      export function executeDeleteHistory(claudeSessionId, item) {
        if (item) {
          item.classList.add("deleting");
        }
        setTimeout(function() {
          fetch("/api/claude-history/" + encodeURIComponent(claudeSessionId), { method: "DELETE", credentials: "same-origin" })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (data && data.error) {
                throw new Error(data.error);
              }
              state.claudeHistory = state.claudeHistory.filter(function(s) {
                return s.claudeSessionId !== claudeSessionId;
              });
              delete state.selectedClaudeHistoryIds[claudeSessionId];
              updateSessionsList();
            })
            .catch(function() {
              if (item) item.classList.remove("deleting");
              var errorEl = document.getElementById("action-error");
              showError(errorEl, "无法删除会话。");
            });
        }, 250);
      }

      export function deleteClaudeHistorySession(claudeSessionId, item) {
        executeDeleteHistory(claudeSessionId, item);
      }

      export function deleteClaudeHistoryDirectory(cwd, btn, items) {
        if (!cwd) {
          return;
        }
        fetch("/api/claude-history?cwd=" + encodeURIComponent(cwd), { method: "DELETE", credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            state.claudeHistory = state.claudeHistory.filter(function(s) {
              return s.cwd !== cwd;
            });
            updateSessionsList();
          })
          .catch(function() {
            setDeletingState(items, false);
            var errorEl = document.getElementById("action-error");
            showError(errorEl, "无法清理该目录的历史会话。");
          });
      }

      export function setDeletingState(items, deleting) {
        items.forEach(function(item) {
          item.classList.toggle("deleting", deleting);
        });
      }

      export function getHistoryItemsByCwd(cwd) {
        return Array.prototype.slice.call(document.querySelectorAll('.claude-history-item[data-cwd="' + window.CSS.escape(String(cwd)) + '"]'));
      }

      // ── Swipe-to-delete gesture ──

      export var _swipeState = null;
      export var _swipedItem = null;

      export function closeSwipedItem() {
        if (_swipedItem) {
          _swipedItem.classList.remove("swiped");
          var content = _swipedItem.querySelector(".session-item-content");
          if (content) content.style.transform = "";
          _swipedItem = null;
        }
      }

      export function initSwipeToDelete(_container?) {
        _swipeState = null;
        _swipedItem = null;
      }

      export function startCommand(command, cwd, errorEl) {
        if (command === "claude" || command === "codex" || command === "opencode") {
          state.preferredCommand = command;
          state.chatMode = getSafeModeForTool(command, state.chatMode);
        }
        var modelPref = (command === "claude" || command === "codex" || command === "opencode") ? getChatModelForProvider(command) : "";
        return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: command,
            provider: command === "claude" || command === "codex" || command === "opencode" ? command : undefined,
            cwd: cwd || "",
            mode: state.chatMode || state.config.defaultMode || "default",
            model: modelPref || undefined,
            thinkingEffort: state.chatThinking || undefined
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            return null;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          return data;
        });
      }

      export var _resumeInProgress = false;

      export function resumeSession(sessionId, errorEl?) {
        if (!sessionId || _resumeInProgress) return Promise.resolve(null);
        _resumeInProgress = true;
        return fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            mode: state.chatMode || state.config.defaultMode || "default"
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            else showToast(data.error, "error");
            return null;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          return data;
        })
        .catch(function(error) {
          var message = (error && error.message) || "无法恢复会话。";
          if (errorEl) showError(errorEl, message);
          else showToast(message, "error");
          return null;
        })
        .finally(function() { _resumeInProgress = false; });
      }

      export function resumeClaudeSessionById(claudeSessionId, errorEl) {
        if (!claudeSessionId) return Promise.resolve(null);
        return fetch("/api/claude-sessions/" + encodeURIComponent(claudeSessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            mode: state.chatMode || state.config.defaultMode || "default"
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            else showToast(data.error, "error");
            return null;
          }
          state.claudeHistory = state.claudeHistory.filter(function(s) {
            return s.claudeSessionId !== claudeSessionId;
          });
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          return data;
        })
        .catch(function(error) {
          var message = (error && error.message) || "无法按 Claude 会话 ID 恢复会话。";
          if (errorEl) showError(errorEl, message);
          else showToast(message, "error");
          return null;
        });
      }

      export function activateSession(data) {
        if (!data || !data.id) return Promise.resolve();
        state.selectedId = data.id;
        persistSelectedId();
        state.currentMessages = [];
        teardownTerminal();
        resetChatRenderCache();
        switchToSessionView(data.id);
        updateSessionSnapshot(data);
        updateSessionsList();
        subscribeToSession(data.id);
        return loadOutput(data.id).then(function() {
          focusInputBox(true);
        });
      }

      export function resumeSessionFromList(sessionId) {
        return resumeSession(sessionId).then(function(data) {
          if (!data) return null;
          if (data.claudeSessionId) {
            if (data.provider === "codex") {
              state.codexHistory = state.codexHistory.filter(function(s) {
                return s.claudeSessionId !== data.claudeSessionId;
              });
            } else {
              state.claudeHistory = state.claudeHistory.filter(function(s) {
                return s.claudeSessionId !== data.claudeSessionId;
              });
            }
          }
          return activateSession(data).then(function() {
            return data;
          });
        });
      }

      export function startAndActivateCommand(command, cwd, errorEl) {
        return startCommand(command, cwd, errorEl).then(function(data) {
          if (!data) return null;
          return activateSession(data).then(function() {
            return data;
          });
        });
      }

      export function createSessionFromWelcomeInput(value) {
        var welcomeInput = document.getElementById("welcome-input") as HTMLInputElement | null;
        if (!welcomeInput) return;
        welcomeInput.placeholder = "正在思考…";
        welcomeInput.disabled = true;
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        var modelPref = getChatModelForProvider(preferredTool);
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value,
            model: modelPref || undefined,
            thinkingEffort: state.chatThinking || undefined
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            welcomeInput.placeholder = "输入消息";
            welcomeInput.disabled = false;
            return null;
          }
          return activateSession(data);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
          welcomeInput.placeholder = "输入消息";
          welcomeInput.disabled = false;
        })
        .finally(function() {
          welcomeInput.placeholder = "输入消息";
          welcomeInput.disabled = false;
        });
      }

      export function createSessionFromInput(value, inputBox, welcomeInput) {
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        var modelPref = getChatModelForProvider(preferredTool);
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value || undefined,
            model: modelPref || undefined,
            thinkingEffort: state.chatThinking || undefined
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          return activateSession(data);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
        });
      }

      export function handleResumeAction(actionButton) {
        actionButton.disabled = true;
        resumeSessionFromList(actionButton.dataset.sessionId)
          .finally(function() {
            actionButton.disabled = false;
          });
      }

      export function handleResumeCodexHistoryAction(actionButton) {
        var threadId = actionButton.dataset.claudeSessionId;
        var cwd = actionButton.dataset.cwd;
        if (!threadId) return;
        actionButton.disabled = true;
        resumeHistoryFromList("codex", threadId, cwd)
          .finally(function() {
            actionButton.disabled = false;
          });
      }

      export function resumeCodexHistorySession(threadId, cwd) {
        return fetch("/api/codex-sessions/" + encodeURIComponent(threadId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            mode: state.chatMode || (state.config && state.config.defaultMode) || "default",
            cwd: cwd
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          return data;
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法恢复会话。", "error");
          return null;
        });
      }

      export function handleDeleteCodexHistoryAction(actionButton) {
        var threadId = actionButton.dataset.claudeSessionId;
        if (!threadId) return;
        confirmDelete("确认删除这条 Codex 会话吗？", {
          title: "删除会话"
        }).then(function(ok) {
          if (!ok) return;
          var item = actionButton.closest(".session-item");
          if (item) item.style.opacity = "0.5";
          deleteCodexHistorySession(threadId)
            .catch(function() {
              if (item) item.style.opacity = "1";
            });
        });
      }

      export function handleResumeHistoryAction(actionButton) {
        var claudeSessionId = actionButton.dataset.claudeSessionId;
        var cwd = actionButton.dataset.cwd;
        if (!claudeSessionId) return;
        actionButton.disabled = true;
        resumeHistoryFromList("claude", claudeSessionId, cwd)
          .finally(function() {
            actionButton.disabled = false;
          });
      }

      export function resumeClaudeHistorySession(claudeSessionId, cwd) {
        return fetch("/api/claude-sessions/" + encodeURIComponent(claudeSessionId) + "/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            mode: state.chatMode || (state.config && state.config.defaultMode) || "default",
            cwd: cwd
          }))
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          return data;
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法恢复会话。", "error");
          return null;
        });
      }

      /** DOM-free history resume port used by React shell actions. */
      export function resumeHistoryFromList(provider, providerSessionId, cwd) {
        var request = provider === "codex"
          ? resumeCodexHistorySession(providerSessionId, cwd)
          : resumeClaudeHistorySession(providerSessionId, cwd);
        return request.then(function(data) {
          if (!data || !data.id) return null;
          if (provider === "codex") {
            state.codexHistory = state.codexHistory.filter(function(s) {
              return s.claudeSessionId !== providerSessionId;
            });
          } else {
            state.claudeHistory = state.claudeHistory.filter(function(s) {
              return s.claudeSessionId !== providerSessionId;
            });
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          return activateSession(data).then(function() {
            // Desktop pinned/narrow layouts remain; only overlay drawers close.
            dismissDrawerIfOverlay();
            return data;
          });
        });
      }

      /** DOM-free Codex history deletion port; confirmation stays with callers. */
      export function deleteCodexHistorySession(threadId) {
        return fetch("/api/codex-history/" + encodeURIComponent(threadId), {
          method: "DELETE",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (!data || data.ok !== true) throw new Error((data && data.error) || "无法删除会话。");
            state.codexHistory = state.codexHistory.filter(function(s) {
              return s.claudeSessionId !== threadId;
            });
            updateSessionsList();
            return data;
          });
      }

      export function isTouchDevice() {
        return "ontouchstart" in window || navigator.maxTouchPoints > 0;
      }

      export function focusInputBox(skipMobile) {
        if (state.terminalInteractive) return;
        var inputBox = document.getElementById("input-box");
        if (!inputBox || !state.selectedId) return;
        if (document.activeElement === inputBox) return;
        // Skip focus on mobile/touch devices for auto-triggered calls to avoid opening keyboard
        if (skipMobile && isTouchDevice()) return;
        focusInputWithSelection(inputBox);
      }

      export function scrollLatestMessageIntoView() {
        var chatMessages = document.querySelector('.chat-messages');
        if (!chatMessages) return;
        // column-reverse: scrollTop=0 is the visual bottom.
        // Use direct scrollTop instead of scrollIntoView() to avoid
        // shifting ancestor containers and causing the input box to jump.
        chatMessages.scrollTop = 0;
      }

      export function updateInputPanelViewportSpacing() {
        // 键盘空间通过 syncAppViewportHeight 让 body 跟随 visualViewport 收缩处理；
        // 这里清掉历史遗留的 --keyboard-offset 避免双重补偿。
        var inputPanel = document.querySelector('.input-panel') as HTMLElement | null;
        if (!inputPanel) return;
        inputPanel.style.removeProperty('--keyboard-offset');
      }

      export function resetInputPanelViewportSpacing() {
        var inputPanel = document.querySelector('.input-panel') as HTMLElement | null;
        if (!inputPanel) return;
        inputPanel.style.removeProperty('--keyboard-offset');
      }

      export function restoreInputBoxViewport(inputBox) {
        if (!inputBox) return;
        var start = inputBox.selectionStart;
        var end = inputBox.selectionEnd;
        syncInputBoxScroll(inputBox);
        if (typeof start === 'number' && typeof end === 'number') {
          inputBox.setSelectionRange(start, end);
        }
      }

      export function bindInputTouchScroll(inputBox) {
        if (!inputBox || inputBox.dataset.touchScrollBound === 'true') return;
        inputBox.dataset.touchScrollBound = 'true';
        inputBox.addEventListener('touchstart', function() {
          if (inputBox.scrollHeight <= inputBox.clientHeight + 1) return;
          if (inputBox.scrollTop <= 0) {
            inputBox.scrollTop = 1;
          } else if (inputBox.scrollTop + inputBox.clientHeight >= inputBox.scrollHeight) {
            inputBox.scrollTop = Math.max(1, inputBox.scrollHeight - inputBox.clientHeight - 1);
          }
        }, { passive: true });
      }

      export function syncInputBoxLayout(inputBox) {
        if (!inputBox) return;
        autoResizeInput(inputBox);
        restoreInputBoxViewport(inputBox);
      }

      export function handleInputBoxFocus(event) {
        var inputBox = event && event.target ? event.target : document.getElementById('input-box');
        if (!inputBox) return;
        updateInputPanelViewportSpacing();
        syncInputBoxLayout(inputBox);
      }

      export function handleInputBoxBlur(event) {
        var blurredEl = event && event.target ? event.target : document.getElementById('input-box');
        resetInputPanelViewportSpacing();
        scheduleClosedViewportBaselineWindow(2200, blurredEl);
        // blur 触发瞬间 vv.height 通常还停在键盘弹起时的旧值——iOS 上动画
        // 要再跑 ~250ms 才回弹完整。这里铺一串 settle tick 让 syncAppViewportHeight
        // 在 vv 真正稳定后能把 top/height 收敛到正确值。
        var dismissTicks = [80, 200, 380, 620, 900];
        dismissTicks.forEach(function(delay, idx) {
          setTimeout(function() {
            syncAppViewportHeight(false);
            // 第二档（200ms）顺便刷一次终端布局，再晚的 tick 仅校准视口变量。
            if (idx === 1 && isTouchDevice()) {
              ensureTerminalFit("keyboard-blur", { forceReplay: true });
              // "keyboard" 而非 "force"：尊重 terminalAutoFollow，
              // 上滚翻历史的用户不被键盘收起瞬间拽回底部。
              maybeScrollTerminalToBottom("keyboard");
            }
          }, delay);
        });
      }

      export function adjustInputBoxSelection(inputBox) {
        if (!inputBox) return;
        inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length);
        restoreInputBoxViewport(inputBox);
      }

      export function focusInputWithSelection(inputBox) {
        if (!inputBox) return;
        inputBox.focus({ preventScroll: true });
        adjustInputBoxSelection(inputBox);
      }

      export function syncInputBoxForCurrentState(inputBox) {
        bindInputTouchScroll(inputBox);
        syncInputBoxLayout(inputBox);
      }

      export function focusInputCaret(inputBox) {
        focusInputWithSelection(inputBox);
      }

      export function updateInputViewportState(inputBox) {
        updateInputPanelViewportSpacing();
        restoreInputBoxViewport(inputBox);
      }

      export function resetInputViewport() {
        resetInputPanelViewportSpacing();
      }

      export function settleInputViewport(inputBox) {
        restoreInputBoxViewport(inputBox);
      }

      export function focusInputBoxFromTap(inputBox) {
        focusInputCaret(inputBox);
      }

      export function refreshInputBoxState(inputBox) {
        syncInputBoxForCurrentState(inputBox);
      }

      export function clearInputViewportState() {
        resetInputViewport();
      }

      export function finalizeInputViewportUpdate(inputBox) {
        settleInputViewport(inputBox);
      }

      export function shouldAdjustForKeyboard(vv, inputBox) {
        if (!vv || !inputBox || document.activeElement !== inputBox) return false;
        var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
        if (offsetBottom <= 50) return false;
        var rect = inputBox.getBoundingClientRect();
        return rect.bottom > vv.height - 12;
      }

      export function syncInputBoxScroll(inputBox) {
        if (!inputBox) return;
        var isScrollable = inputBox.scrollHeight > inputBox.clientHeight + 1;
        if (!isScrollable) {
          inputBox.scrollTop = 0;
          return;
        }
        inputBox.scrollTop = inputBox.scrollHeight;
      }

      export function focusInputFromTap() {
        if (state.terminalInteractive) {
          focusTerminalContainer();
          return;
        }
        // 触摸设备点击任何区域都不主动聚焦输入框：自动聚焦会唤起系统虚拟键盘，属于
        // 预期外行为——点输出区、点聊天区、以及点终端遥控悬浮球派发到底层 #output 的
        // 合成 click，都不该弹出输入法。手机端要打字直接点输入框本身。桌面鼠标点击不
        // 唤起键盘，保留原本的「点输出/聊天区聚焦输入框」便利。
        if (isTouchDevice()) return;
        var inputBox = document.getElementById('input-box');
        if (!inputBox || !state.selectedId || document.activeElement === inputBox) return;
        focusInputWithSelection(inputBox);
      }

      export function focusTerminalContainer() {
        var output = document.getElementById("output");
        if (!output) return;
        output.setAttribute("tabindex", "0");
        output.focus();
        if (state.terminal && state.terminal.focus) {
          state.terminal.focus();
        }
      }

      // Mobile keyboard handling
      export function setupMobileKeyboardHandlers() {
        var inputPanel = document.querySelector('.input-panel') as HTMLElement | null;
        var chatMessages = document.querySelector('.chat-messages');

        // Virtual Keyboard API (Chrome/Edge)
        // 不再给 input-panel 直接 setPaddingBottom——新方案通过
        // syncAppViewportHeight 让 body 跟随可见视口收缩，input-panel
        // 自然上移。这里只把事件留作未来钩子，避免和新方案双重补偿。
        if ('virtualKeyboard' in navigator) {
          var vk = (navigator as any).virtualKeyboard;
          vk.addEventListener('geometrychange', function() {
            if (!inputPanel) return;
            inputPanel.style.removeProperty('padding-bottom');
          });
        }

        // Show virtual keyboard on terminal/chat tap
        var output = document.getElementById('output');
        if (output) {
          output.addEventListener('click', function() {
            focusInputFromTap();
          });
        }

        // Also focus on chat messages tap
        if (chatMessages) {
          chatMessages.addEventListener('click', function(e) {
            // Only focus if not clicking on a link, button, or tool card header
            var target = e.target as HTMLElement;
            if (target.tagName !== 'A' && target.tagName !== 'BUTTON' && !target.closest('button') && !target.closest('[data-tool-toggle]')) {
              focusInputFromTap();
            }
          });
        }

        // 键盘已弹出时，点击输入区以外的区域自动收起（仅触摸设备）。
        // 只处理聊天输入框 #input-box：终端透传 / wterm 自己的隐藏输入框有
        // 独立的焦点管理，不能在这里误伤。用 click 而非 pointerdown——滚动
        // 手势不产生 click，上滑翻历史不会误收键盘；且收起引发的布局位移
        // 发生在本次点击完成之后，不会造成误点。capture 阶段监听，避免被
        // 中间层 stopPropagation 吞掉。
        document.addEventListener("click", function(e) {
          if (!isTouchDevice()) return;
          var inputBox = document.getElementById("input-box");
          if (!inputBox || document.activeElement !== inputBox) return;
          var target = e.target as HTMLElement | null;
          if (!target || typeof target.closest !== "function") return;
          // 输入面板自身（输入框/发送/快捷按钮）、迷你键盘及其开关、
          // 终端悬浮遥控上的点击不收起键盘。
          if (
            target.closest(".input-panel") ||
            target.closest("#mini-keyboard") ||
            target.closest("#mini-keyboard-fab") ||
            target.closest("#mini-keyboard-toggle") ||
            target.closest("#terminal-interactive-toggle") ||
            target.closest(".wand-joystick-root")
          ) {
            return;
          }
          inputBox.blur();
        }, true);
      }

      // ─────────────────────────────────────────────────────────────────────
      // 视口锚定：把 .app-container 用 fixed + top/height 钉到 visual viewport，
      // 让键盘弹起 / 地址栏切换 / iOS 焦点 pan 都自然反映到布局。
      // ─────────────────────────────────────────────────────────────────────
      //
      // 设计：CSS 里 .app-container 是
      //   position: fixed;
      //   top:    var(--app-viewport-top, 0px);
      //   height: var(--app-viewport-height, 100dvh);
      //
      // 这里把两个变量都写成 vv.offsetTop / vv.height 的实测值：
      //   · iOS Safari 浏览器内：聚焦输入框时 iOS 滚 layout viewport 把焦点入视，
      //     vv.offsetTop ≈ 0，vv.height = 可见高度。top:0 height:vv.height 自然正确。
      //   · iOS 原生壳：iOS 可能改成 pan「visual viewport」自己（vv.offsetTop > 0），
      //     layout viewport 完全不滚。position:fixed 在 iOS 是相对 layout viewport 的，
      //     必须把 top 写成 vv.offsetTop，容器才会跟着可见区往下走；否则容器仍钉在
      //     layout 顶部 = 被 pan 到可视区外 → 底部 input-panel 落在屏幕下方 = 被键盘挡。
      //   · Android Chrome / WebView：vv.offsetTop 通常恒 0，等价于 top:0 height:vv.height。
      //   · 桌面：vv.height ≈ innerHeight，vv.offsetTop = 0，无副作用。
      //
      // 之前的方案是 height = vv.height + vv.pageTop，配合 scrollTo(0,0) 把 layout
      // 滚回顶；它依赖 iOS 真的滚过 layout viewport，在原生壳中不一定成立 →
      // height 被膨胀但 top 不动 → 容器底落到可视区之外，就是用户报告的两个症状
      // （键盘弹起遮挡 + 键盘收起后输入框停在半空）。
      export function resetRootViewportScroll() {
        // 仅在 iOS Safari 浏览器内有意义（layout 真被滚过的场景）。在 iOS 原生壳
        // 里 layout 没滚时调用是 no-op；但我们已经不依赖它来对齐布局，
        // 它只是清掉极少数 iOS Safari 把焦点 pan 后忘记复位 layout 的残留滚动。
        try { window.scrollTo(0, 0); } catch (e) {}
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
        if (document.documentElement) document.documentElement.scrollTop = 0;
        if (document.body) document.body.scrollTop = 0;
      }
