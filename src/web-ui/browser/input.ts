import { mountComposerSender } from "./composer-sender-adapter.js";
import { mountBrowserButtons } from "./library-buttons.js";
import type { SendError } from "./types";
import { composer as composerStore, composerQueue, state } from "./state";
import { t } from "./i18n";
import { parseJsonResponse } from "../react/http-adapter";
import { getErrorMessage } from "../../error-utils.js";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../react/ui/motion-tokens";
import { collapseTodoProgress, computeRunningSignal, escapeHtml } from "./utils";
import { clearActivityDetailState, renderChat, shortCommand } from "./chat-render";
import { getStructuredQueuedInputs, persistCrossSessionQueue, persistSelectedId, prepareChatBottomFollow, stripRenderOnlyStructuredMessages, syncStructuredQueueFromSession } from "./chat-scroll";
import "./file-browser";
import "./git-commit";
import { showToast, wandConfirm, wandPrompt as uiPrompt } from "./notifications";
import { getEffectiveCwd } from "./render";
import { applyCurrentView, buildAttachmentPrefix, canSendComposer, clearDraftValueForSession, closePlusPopover, COMPOSER_IDLE_HINT, dismissDrawerIfOverlay, getComposerPlaceholder, getDraftValueForSession, getPendingAttachments, getPreferredMessages, getPreferredTool, isStructuredSession, selectSession, loadOutput, refreshAll, renderAttachmentPreview, restoreComposerStateForSession, setDraftValue, setDraftValueForSession, shouldBracketPtyPaste, subscribeToSession, syncComposerHasText, updateSessionSnapshot, updateSessionsList, uploadAttachments, withTerminalDimensions } from "./session-engine";
import { confirmDelete } from "./sidebar";
import { clearRunningStatusBar, paintRunningStatusBar } from "./running-status-adapter.js";
import { initTerminal, maybeScrollTerminalToBottom, scheduleSoftResyncTerminal, waitForProviderPaint, waitForTerminalSettled } from "./terminal";
import { ensureTerminalFit, scheduleClosedViewportBaselineWindow, syncAppViewportHeight } from "./viewport";
import { paintTerminalPanel } from "./terminal-panel-adapter";
import "./websocket";
import { buildPtyAttachmentChunks, isImageAttachmentSource } from "./pty-paste";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { PROVIDER_IDS, PROVIDER_LABELS, inferProviderIdFromCommand } from "../provider-identity";
import { syncBrowserComposerRail } from "./composer-rail-adapter";
import { syncBrowserComposerPopover } from "./composer-popover-adapter";
import { showActionError } from "./composer-action-error";
import { syncBrowserComposerVoice } from "./composer-voice-adapter";
import { shouldPersistQueueItemRestore } from "./composer-draft";
import { handlePiSettingsSubmit, syncPiSettingsComposer } from "./pi-settings-adapter";
import { resolveInsertBeforeAnchor } from "./queue-dom";
import { clearQueueView, paintCrossSessionQueue, paintQueueBar } from "./queue-view-adapter";

function compactSessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined),
      "X-Wand-Tool-Projection": "compact" } });
}

      // 改为在识别回调里调用 updateVoiceTranscript(累积文本) 即可，交互层不用动。
      // ─────────────────────────────────────────────────────────────────
      // 气泡的可见性与文案由 React 渲染（见 composer-voice 组件）；legacy 只维护
      // 录音状态与录制按钮 DOM。`bubbleVisible` 取代了原来自行切的 .hidden class。
      var voiceState = { recording: false, canceling: false, transcript: "", startY: 0, bubbleVisible: false, status: "" };
      var VOICE_CANCEL_THRESHOLD = 60; // 按住后上滑超过该像素进入"松开取消"态

      // 把录音状态发布给 React 气泡。
      function syncVoiceBubble() {
        syncBrowserComposerVoice({
          visible: voiceState.bubbleVisible,
          canceling: voiceState.canceling,
          transcript: voiceState.transcript,
          status: voiceState.status,
        });
      }

      // STT 唯一注入点：写入累积文字并刷新气泡内容。
      // 网页端目前没有可用的语音识别后端（移动端走原生客户端的端侧 STT）；
      // 真正接入网页 STT 时，在识别回调里调用本函数累积文本即可，交互层不用动。
      export function updateVoiceTranscript(text) {
        voiceState.transcript = text || "";
        syncVoiceBubble();
      }

      export function startVoiceRecording(e) {
        if (state.terminalInteractive
          || voiceState.recording
          || (state.promptOptimizeRequest
            && state.promptOptimizeRequest.sessionId === state.selectedId)) return;
        if (e) {
          e.preventDefault();
          voiceState.startY = (typeof e.clientY === "number") ? e.clientY : 0;
          // 指针捕获：手指/鼠标移出按钮范围也能继续收到 move / up
          try {
            if (e.pointerId !== undefined && e.currentTarget && e.currentTarget.setPointerCapture) {
              e.currentTarget.setPointerCapture(e.pointerId);
            }
          } catch (_) {}
        }
        voiceState.recording = true;
        voiceState.canceling = false;
        voiceState.transcript = "";
        var btn = document.getElementById("voice-record-btn");
        if (btn) {
          btn.classList.add("is-recording");
          btn.setAttribute("aria-pressed", "true");
          btn.setAttribute("title", "松开结束 · 上滑取消");
        }
        voiceState.bubbleVisible = true;
        voiceState.status = "网页端暂不支持语音输入，请使用 App";
        // 网页端暂无语音识别后端：给出明确提示，不再用假样本骗用户。
        // 语音输入请使用 App（原生客户端走端侧 STT）。
        updateVoiceTranscript("");
      }

      export function handleVoiceMove(e) {
        if (!voiceState.recording || !e) return;
        var dy = voiceState.startY - (typeof e.clientY === "number" ? e.clientY : voiceState.startY);
        var shouldCancel = dy > VOICE_CANCEL_THRESHOLD;
        if (shouldCancel === voiceState.canceling) return;
        voiceState.canceling = shouldCancel;
        voiceState.status = shouldCancel ? "松开手指 取消" : "正在聆听…上滑取消";
        syncVoiceBubble();
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
        }
      }

      export function cancelVoiceRecording(e) {
        if (!voiceState.recording) return;
        voiceState.canceling = true;
        stopVoiceRecording(e);
      }

      // 复位录音相关 UI（按钮 + 气泡），不改变是否处于语音模式。
      function resetVoiceRecordingUI() {
        voiceState.canceling = false;
        var btn = document.getElementById("voice-record-btn");
        if (btn) {
          btn.classList.remove("is-recording");
          btn.setAttribute("aria-pressed", "false");
          btn.setAttribute("title", "按住语音输入");
        }
        voiceState.bubbleVisible = false;
        syncVoiceBubble();
      }

      // 把识别文字填回输入框（追加在已有草稿后、不覆盖），光标停末尾。
      // 复用 setDraftValue + autoResizeInput，与提示词优化填回 textarea 同一套范式。
      function commitVoiceTranscript(text) {
        if (state.promptOptimizeRequest
          && state.promptOptimizeRequest.sessionId === state.selectedId) return;
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

      export function autoResizeInput(el) {
        if (!el) return;
        // Clear the previous responsive minimum before measuring. Otherwise a
        // desktop inline value survives a later phone resize (and vice versa)
        // and wins over the current media-query value.
        el.style.minHeight = "";
        var inputStyles = window.getComputedStyle(el);
        var computedMinHeight = parseFloat(inputStyles.minHeight || "");
        var minHeight = Number.isFinite(computedMinHeight) ? computedMinHeight : 40;
        // Respect the responsive CSS cap instead of forcing every viewport
        // back to a JavaScript-only desktop limit.
        var computedMaxHeight = parseFloat(inputStyles.maxHeight || "");
        var maxHeight = Number.isFinite(computedMaxHeight)
          ? Math.max(minHeight, computedMaxHeight)
          : 120;
        var touchDevice = isTouchDevice();
        // PTY passthrough is a compact control surface, not a drafting area.
        // Keep it at the CSS minimum even if a previous composer draft still
        // exists for this session; the draft is restored when passthrough ends.
        var terminalPassthrough = el.classList.contains("is-terminal-passthrough");
        // For empty content, reset to minimum height immediately.
        if (terminalPassthrough || !el.value || el.value.trim() === "") {
          el.style.height = minHeight + "px";
          el.style.minHeight = minHeight + "px";
          el.style.overflowY = touchDevice ? "auto" : "hidden";
          el.scrollTop = 0;
          el.classList.remove("has-multiline-draft", "has-clipped-draft");
          el.closest(".input-composer")?.classList.remove("is-expanded");
          syncComposerHasText(el);
          return;
        }
        // Typing is a high-frequency interaction. Measure directly at the
        // minimum height and snap to the new content height; tweening every
        // keystroke makes the caret feel elastic and forces an extra layout.
        var previousScrollTop = el.scrollTop;
        var caretAtEnd = el.selectionStart === el.value.length
          && el.selectionEnd === el.value.length;
        el.style.overflowY = "hidden";
        el.style.height = minHeight + "px";
        var contentHeight = el.scrollHeight;
        var newHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
        var shouldScrollInside = contentHeight > maxHeight;
        var needsExpandedHeight = contentHeight > minHeight + 1;
        el.style.height = newHeight + "px";
        el.style.minHeight = minHeight + "px";
        el.style.overflowY = shouldScrollInside || touchDevice ? "auto" : "hidden";
        el.classList.toggle("has-multiline-draft", needsExpandedHeight);
        el.classList.toggle("has-clipped-draft", shouldScrollInside);
        // Keep the two-row composer open after blur whenever the draft wraps.
        // This mirrors the native clients and prevents controls from squeezing
        // a multi-line draft back into the compact row.
        el.closest(".input-composer")?.classList.toggle("is-expanded", needsExpandedHeight);
        if (shouldScrollInside) {
          if (caretAtEnd) {
            syncInputBoxScroll(el);
          } else {
            var maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
            el.scrollTop = Math.min(previousScrollTop, maxScrollTop);
          }
        } else {
          el.scrollTop = 0;
        }
        syncComposerHasText(el);
      }

      // ── 跨会话排队 ──

      var _queueLaunching = false; // 防止并发 launch

      function sessionIsBusyForQueue(s) {
        if (!s || s.archived) return false;
        if (isStructuredSession(s)) {
          return !!(s.structuredState && s.structuredState.inFlight);
        }
        return s.status === "running";
      }

      function hasAnyBusySession() {
        return state.sessions.some(sessionIsBusyForQueue);
      }

      // 选出用户「想继续的那个会话」：当前选中且仍在忙的优先，否则取最近启动、
      // 仍在忙的那个。enqueueCrossSessionMessage 只在 hasAnyBusySession() 为真时
      // 被调用，所以这里几乎总能拿到一个目标。
      function getContinuationTargetSession() {
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
      function getLastStructuredSubmittedInput(session) {
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

      function rollbackQueueAppend(sessionId, text, index, requestVersion) {
        var latest = state.sessions.find(function(item) { return item.id === sessionId; });
        var queue = latest && Array.isArray(latest.queuedMessages) ? latest.queuedMessages : [];
        return composerQueue.rollback(sessionId, queue, [], requestVersion, { text, index });
      }

      function continueStructuredSession(session, text) {
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
        var queueVersion = composerQueue.advance(session.id, "local");
        // 乐观更新目标会话的排队，让侧栏 / 已打开的该会话视图立即有反馈。
        updateSessionSnapshot({ id: session.id, queuedMessages: nextQueue });
        if (session.id === state.selectedId) updateQueueBar();
        var label = session.title || shortCommand(session.command) || "当前会话";
        showToast("已加入「" + label + "」的排队，回复结束后自动发送（含上下文）。", "info");
        return compactSessionFetch("/api/structured-sessions/" + session.id + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            input: text,
            idempotencyKey: idempotencyKey,
          })
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
              snapshot = composerQueue.filter(snapshot, session.id, queueVersion);
              updateSessionSnapshot(snapshot);
              if (snapshot.id === state.selectedId) updateQueueBar();
            }
          })
          .catch(function(err) {
            // Only remove this optimistic item from the latest queue. Replacing
            // the whole queue with prevQueue would erase newer concurrent
            // submissions.
            var rollbackQueue = rollbackQueueAppend(session.id, text, prevQueue.length, queueVersion);
            if (rollbackQueue) updateSessionSnapshot({ id: session.id, queuedMessages: rollbackQueue });
            if (session.id === state.selectedId) updateQueueBar();
            showToast((err && err.message) || "排队失败，请重试。", "error");
          });
      }

      function enqueueCrossSessionMessage(text) {
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
        // 结果原位可见：跨会话排队条（登录页 / 无会话时的欢迎页也渲染）立刻多出这一条，
        // 不再叠一条会自己飘走的气泡。
      }

      function launchQueueItem(item) {
        if (_queueLaunching) {
          // 已经有另一条在启动中：把这条放回队首，绝不静默丢弃。
          // （历史 bug：这里直接 return，配合 flush 先出队再渲染的顺序，
          //  一次 DOM 异常 / 重入就能让已出队落盘的消息永久蒸发。）
          state.crossSessionQueue.unshift(item);
          if (shouldPersistQueueItemRestore(!!state.pageUnloading)) persistCrossSessionQueue();
          renderCrossSessionQueue();
          return;
        }
        _queueLaunching = true;
        compactSessionFetch("/api/commands", {
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
        .then(function(res) { return parseJsonResponse<any>(res); })
        .then(function(data) {
          _queueLaunching = false;
          return activateSession(data);
        })
        .catch(function(error) {
          _queueLaunching = false;
          showToast((error && error.message) || "无法启动排队会话。", "error");
          // 回填到内存，用户仍能看到 / 立即重试。
          state.crossSessionQueue.unshift(item);
          // 页面卸载中的 abort = 送达未知：服务端可能已经建好会话并发出这条
          // initialInput，落盘会让它在刷新后被自动 flush 二次发送。
          if (shouldPersistQueueItemRestore(!!state.pageUnloading)) persistCrossSessionQueue();
          renderCrossSessionQueue();
        });
      }

      function sendQueueItemNow(queueId) {
        var idx = state.crossSessionQueue.findIndex(function(q) { return q.id === queueId; });
        if (idx < 0) return;
        var item = state.crossSessionQueue.splice(idx, 1)[0];
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        // 立即发送不受 _queueLaunching 限制
        compactSessionFetch("/api/commands", {
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
        .then(function(res) { return parseJsonResponse<any>(res); })
        .then(function(data) {
          return activateSession(data);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动排队会话。", "error");
          state.crossSessionQueue.splice(idx, 0, item);
          // 同上：卸载中的 abort 送达未知，只回填内存，不复活到 localStorage。
          if (shouldPersistQueueItemRestore(!!state.pageUnloading)) persistCrossSessionQueue();
          renderCrossSessionQueue();
        });
      }

      function cancelQueueItem(queueId) {
        var idx = state.crossSessionQueue.findIndex(function(q) { return q.id === queueId; });
        if (idx < 0) return;
        state.crossSessionQueue.splice(idx, 1);
        persistCrossSessionQueue();
        renderCrossSessionQueue();
        // 删完最后一条时排队条整块收起，这本身就是原位结果，不再提示「排队已清空」。
      }

      export function flushCrossSessionQueue() {
        // 未登录 / 已登出：绝不自动起会话。队列是从 localStorage 恢复的，
        // 没有这道门禁时它会在登录页（或登出后）拿着 401 去 POST /api/commands。
        if (!state.config) return;
        if (state.crossSessionQueue.length === 0) return;
        if (hasAnyBusySession()) return;
        if (_queueLaunching) return;
        var item = state.crossSessionQueue.shift();
        // 出队立刻落盘：多条目时 renderCrossSessionQueue() 只在队列排空时才会
        // persist，否则 localStorage 会留着已经交给 /api/commands 的旧队首，
        // 刷新后它被重新 flush 一次 = 同一条消息发两遍。
        persistCrossSessionQueue();
        // 先把这条交给 launchQueueItem（它同步置位 _queueLaunching），再做展示层
        // 渲染。顺序反过来的话，渲染期间的任何重入都会撞上守卫把这条无声丢掉，
        // 而它此刻已经从内存和 localStorage 双重出队 —— 消息永久蒸发。
        launchQueueItem(item);
        renderCrossSessionQueue();
      }

      function formatQueueAge(queuedAt) {
        var sec = Math.floor((Date.now() - queuedAt) / 1000);
        if (sec < 60) return sec + "s";
        var min = Math.floor(sec / 60);
        if (min < 60) return min + "m";
        return Math.floor(min / 60) + "h";
      }

      export function renderCrossSessionQueue() {
        // 排队条是纯展示层：渲染失败可以少一次刷新，绝不能把异常抛回
        // flushCrossSessionQueue / loadSessions 调用链（那会连带吞掉后面
        // renderCrossSessionQueue()、_syncWakeLock() 等收尾逻辑）。
        try {
          renderCrossSessionQueueUnsafe();
        } catch (error) {
          console.error("[wand] cross-session queue render failed:", error);
        } finally {
          // 每次变更后对齐节拍器：有队列就跑，排空就停。
          syncCrossSessionQueueTicker();
        }
      }

      function renderCrossSessionQueueUnsafe() {
        var container = document.querySelector(".cross-session-queue");
        var inputPanel = document.querySelector(".input-panel");
        var statusBar = document.querySelector(".structured-status-bar");
        var composer = document.querySelector(".input-composer");
        var blankQueueHost = document.getElementById("cross-session-queue-host");

        if (state.crossSessionQueue.length === 0) {
          if (container) { clearQueueView(container as HTMLElement); container.remove(); }
          persistCrossSessionQueue();
          return;
        }

        // The welcome queue uses a dedicated LegacyHost so this renderer never
        // appends children into React-owned #blank-chat.
        var isInputPanelVisible = inputPanel && !inputPanel.classList.contains("hidden");
        var parent = isInputPanelVisible ? inputPanel : blankQueueHost;
        if (!parent) return;

        // 状态栏 / 输入框都埋在 .input-panel 更深一层，必须上溯成直接子节点才能当
        // insertBefore 的参照；否则 insertBefore 会抛 NotFoundError（见 queue-dom.ts）。
        var insertBefore = isInputPanelVisible
          ? resolveInsertBeforeAnchor(parent, [statusBar, composer])
          : null;

        // If container exists but is in the wrong parent, move it
        if (container && container.parentNode !== parent) {
          clearQueueView(container as HTMLElement);
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

        paintCrossSessionQueue(container as HTMLElement, state.crossSessionQueue.map(item => ({
          id: item.id, text: item.text, age: formatQueueAge(item.queuedAt),
        })));
      }

      // 跨会话排队条的节拍器：只在队列非空时运行。以前它是模块级 interval，
      // 登出后仍会每 5s 尝试 flush，把已登出的用户当成能开会话的人；
      // 现在由 renderCrossSessionQueue() 在每次变更后负责装/卸。
      var CROSS_SESSION_QUEUE_TICK_MS = 5000;
      var crossSessionQueueTicker: ReturnType<typeof setInterval> | null = null;

      function tickCrossSessionQueue() {
        if (state.crossSessionQueue.length === 0) {
          stopCrossSessionQueueTicker();
          return;
        }
        // 只更新 age 文本，不重建整个 DOM
        var ages = document.querySelectorAll(".queue-item-age");
        state.crossSessionQueue.forEach(function(item, i) {
          if (ages[i]) ages[i].textContent = formatQueueAge(item.queuedAt);
        });
        // 尝试 flush 作为保底（防止 ended 事件 flush 失败）
        flushCrossSessionQueue();
      }

      export function stopCrossSessionQueueTicker() {
        if (crossSessionQueueTicker === null) return;
        clearInterval(crossSessionQueueTicker);
        crossSessionQueueTicker = null;
      }

      function syncCrossSessionQueueTicker() {
        if (state.crossSessionQueue.length === 0) {
          stopCrossSessionQueueTicker();
          return;
        }
        if (crossSessionQueueTicker !== null) return;
        crossSessionQueueTicker = setInterval(tickCrossSessionQueue, CROSS_SESSION_QUEUE_TICK_MS);
      }

      // Delegate click events for cross-session queue items
      document.addEventListener("click", function(e) {
        var target = e.target as HTMLElement;
        if (target.closest("#queue-clear-all")) {
          e.preventDefault();
          state.crossSessionQueue = [];
          persistCrossSessionQueue();
          renderCrossSessionQueue();
          // 结果原位可见：排队条自己在同一帧里收起（上面 renderCrossSessionQueue 做完），
          // 不再叠一条会自己飘走的气泡。
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

      export function sendOrStart(opts?) {
        opts = opts || {};
        var inputBox = document.getElementById("input-box") as HTMLInputElement | null;
        var inputValue = inputBox ? inputBox.value : "";
        var value = inputValue.trim();

        // If we have a selected ID, try to send input to it
        if (state.selectedId) {
          if (canSendComposer(inputValue, state.selectedId)) sendInputFromBox(opts);
          return;
        }

        // No selected session, create a new one (or continue the busy one if any).
        // enqueueCrossSessionMessage owns the user feedback toast for both paths.
        if (value && hasAnyBusySession()) {
          if (inputBox) inputBox.value = "";
          syncComposerHasText(inputBox);
          enqueueCrossSessionMessage(value);
          return;
        }
        var mode = state.chatMode || "managed";
        var defaultCwd = getEffectiveCwd();
        var preferredTool = getPreferredTool();
        compactSessionFetch("/api/commands", {
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
        .then(function(res) { return parseJsonResponse<any>(res); })
        .then(function(data) {
          clearDraftValueForSession(data.id);
          if (!state.selectedId && inputBox) inputBox.value = "";
          return activateSession(data);
        })
        .catch(function(error) {
          // 创会话失败：草稿与输入框内容保持原样，只提示可读原因（含 HTTP 状态码）。
          // 分类 ③（保留气泡）：这条链路只在 `!state.selectedId` 时跑到 —— 发起点是欢迎页，
          // legacy composer 与 #composer-status-line 整条不渲染，原位根本没有承载，
          // 所以这里就是「发送相关反馈」在本页的唯一出口（tests/web-ui-legacy-fetch-errors.test.ts 钉住必播报一次）。
          showToast(getErrorMessage(error, preferredTool === "codex"
            ? "无法启动 Codex 会话。"
            : "无法启动 Claude 会话。"), "error");
        });
      }

      export function switchToSessionView(sessionId) {
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
        var structured = isStructuredSession(session);

        // #blank-chat / #output / #chat-output 的可见性、以及 #terminal-title /
        // #terminal-info / .session-summary-value 的文案都由 React 外壳持有
        // （见 docs/web-ui-react-migration-adr.md），legacy 只负责切自己的 view。
        // v2: 不再无条件展示停止按钮 —— 由 updateInteractiveControls() 按
        // computeRunningSignal 判断「真在跑」时才露出，下面 updateInteractiveControls
        // 链路会处理（switchToSessionView 后续会触发它）。

        if (structured) {
          state.currentView = "chat";
        } else {
          state.currentView = "terminal";
        }

        if (!structured) {
          if (!state.terminal) initTerminal();
        }
        applyCurrentView();
        reconcileInteractiveState();
        restoreComposerStateForSession(sessionId);
        if (state.terminalInteractive) {
          // Desktop terminal pages should be ready for the next keystroke.
          // Touch devices wait for an explicit tap so merely opening a session
          // never summons the software keyboard.
          if (!isTouchDevice()) focusTerminalInteractionTarget();
        } else {
          focusInputBox(true);
        }
        if (!structured && session && canAutoResumeSession(session)) {
          resumeTerminalPageSession(session);
        }
        // Container just flipped from hidden -> visible (or geometry changed
        // because chat/terminal panels swapped). Refit now so the terminal
        // picks up the real cols/rows instead of keeping the stale ones.
        if (!structured) ensureTerminalFit("view-switch", { forceReplay: true });
        notifyLegacyUiChange("session:view");
      }

      var terminalPageResumeSessionId = null;

      function resumeTerminalPageSession(session) {
        if (!session || terminalPageResumeSessionId === session.id || !canAutoResumeSession(session)) return;
        terminalPageResumeSessionId = session.id;
        resumeSession(session.id)
          .then(function(data) {
            if (!data || state.selectedId !== session.id) return;
            updateSessionSnapshot(data);
            updateSessionsList();
            subscribeToSession(data.id);
            return loadOutput(data.id).then(function() {
              reconcileInteractiveState();
              if (state.terminalInteractive && !isTouchDevice()) focusTerminalInteractionTarget();
            });
          })
          .finally(function() {
            if (terminalPageResumeSessionId === session.id) terminalPageResumeSessionId = null;
          });
      }

      function restoreFailedComposerSubmission(sessionId, value, attachments, persist?) {
        composerStore.edit(sessionId, { restore: { text: value, attachments }, persist });
        restoreComposerStateForSession(sessionId);
        updateInteractiveControls();
      }

      function refocusComposerAfterTouchSubmit(inputBox, sessionId) {
        if (!inputBox || !isTouchDevice()) return;
        var refocus = function() {
          if (state.selectedId !== sessionId || !inputBox.isConnected || inputBox.disabled) return;
          try {
            inputBox.focus({ preventScroll: true });
          } catch (e) {
            inputBox.focus();
          }
        };
        refocus();
        requestAnimationFrame(refocus);
      }

      // 直通提交失败：既要把原因说给用户，也要把没送出去的字放回来。
      // 通道选 flashComposerFailed 而不是新造一条：它在原位结果行不可见时
      // （直通的 .composer-status-row 被 CSS display:none 收掉，见 styles.css
      // 「is-terminal-interactive .composer-status-row」）自己退回错误气泡，
      // 原生 App 壳里结果行可见时就仍走原位。
      // persist=false：请求可能已经到达服务端（响应失败不等于没送达），只回填到
      // 当前页面，不落 localStorage，否则刷新后同一段字会当成新消息重发。
      function reportPassthroughInputFailure(sessionId, text, error) {
        var reason = getInputErrorMessage(error);
        if (sessionId && text) {
          restoreFailedComposerSubmission(sessionId, text, [], false);
          flashComposerFailed("这段输入没有送到终端（" + reason + "），已放回输入框；重试前先看终端里是否留下半行。");
          return;
        }
        flashComposerFailed("回车没有送到终端（" + reason + "）。");
      }

      export function sendInputFromBox(opts) {
        opts = opts || {};
        var interruptFlag = !!opts.interrupt;
        var embedTerminal = document.documentElement.classList.contains("is-wand-embed-terminal");
        if (state.terminalInteractive && !embedTerminal) {
          // 网页端直通模式：composer 本身就是 PTY 输入面。
          // 打字已经由 handleInteractiveTextInput 逐字透传，Enter 只负责提交，
          // 按服务端契约拆成「先文本、后单独 \r」两包发出去。
          var passthroughBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
          var passthroughText = passthroughBox ? passthroughBox.value : "";
          var passthroughSessionId = state.selectedId;
          var passthroughView = state.currentView;
          if (passthroughBox && passthroughText) {
            passthroughBox.value = "";
            setDraftValue("", true);
            autoResizeInput(passthroughBox);
            return queueDirectInput(passthroughText, "interactive_text", passthroughView, passthroughSessionId)
              .then(function() { return queueDirectInput("\r", "enter_text", passthroughView, passthroughSessionId); })
              .catch(function(err) {
                // 直通模式自己就是提交链路，不走下面那条带原位状态行的链路，
                // 所以失败必须在这里说清楚：文本刚从框里清空，不响就是整条丢失。
                // 通道选 flashComposerFailed —— 它在原位结果行不可见时（直通的
                // .composer-status-row 被 CSS display:none 收掉）自己退回错误气泡，
                // 见 flashComposerPhase 的 failed 分支；不新增第二条播报通道。
                reportPassthroughInputFailure(passthroughSessionId, passthroughText, err);
              });
          }
          return queueDirectInput("\r", "enter_text", passthroughView, passthroughSessionId).catch(function(err) {
            // 空回车没送到终端同样要响一声：用户会以为是自己按键丢了。
            // 这条没有草稿可回填，只播报。
            reportPassthroughInputFailure(passthroughSessionId, "", err);
          });
        }

        var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
        var selectedSession = getSelectedSession();
        var sessionId = selectedSession && selectedSession.id || state.selectedId;
        var selectedView = state.currentView;
        var value = inputBox ? inputBox.value : getDraftValueForSession(sessionId);
        var pendingAttachments = getPendingAttachments(sessionId);
        if (state.promptOptimizeRequest
          && state.promptOptimizeRequest.sessionId === sessionId) {
          return Promise.resolve();
        }
        if (handlePiSettingsSubmit(value, selectedSession)) return Promise.resolve();
        if (!sessionId || !canSendComposer(value, sessionId)) return Promise.resolve();

        var existingSubmission = composerStore.pendingSubmission(sessionId, { text: value, attachments: pendingAttachments });
        if (existingSubmission) return existingSubmission;

        // The composer Module captures/clears before the first await; DOM only
        // mirrors that empty state while delivery runs against the snapshot.
        if (inputBox && state.selectedId === sessionId) {
          inputBox.value = "";
          autoResizeInput(inputBox);
        }
        updateInteractiveControls();
        refocusComposerAfterTouchSubmit(inputBox, sessionId);

        // 提交瞬间按钮进「加载」相位、状态行给句子；结果到了再原地换 完成/失败。
        // 全程不弹气泡，也不挪动任何控件（docs/motion-design.md §3）。
        flashComposerSending("正在发送…");

        var submissionPromise = composerStore.submit(sessionId, value, function(payload) {
          var capturedAttachments = payload.attachments;
          return Promise.resolve()
          .then(function() {
            if (!capturedAttachments.length) return [];
            // 上传失败也是「这条没发出去」的一部分：换成可读原因后抛回提交链路，
            // 由状态行原位播报 + 回填草稿，不再单独飘一条气泡（同一件事只说一次）。
            return uploadAttachments(sessionId, capturedAttachments).catch(function(err) {
              throw new Error("附件上传失败：" + ((err && err.message) || err));
            });
          })
          .then(function(uploadedFiles) {
            var hasText = !!value.trim();
            var finalValue = buildAttachmentPrefix(uploadedFiles)
              + (hasText ? value : (uploadedFiles.length ? "请查看附件。" : ""));

            // PTY CLIs receive their image attachments through the terminal's
            // paste protocol, not through a textual "[附件已上传]" prefix. The
            // latter is only meaningful to structured runners, and Codex treats
            // it as ordinary prompt text. Keep non-image attachments on the old
            // textual path while sending each uploaded image as its own pasted
            // path, so Codex can convert it into an [Image #N] attachment.
            // 附件路径 → PTY 写入序列和直通模式共用 buildPtyAttachmentChunks：
            // 每张图片一个 paste 事件（Codex 只认 paste 边界内的图片路径），
            // 后面按 provider 补分隔空格；路径 chunk 标 "paste"，让服务端把它
            // 排除在「草稿 → 会话标题」推断之外，只有用户真正敲的文本算提示词。
            var ptyAttachmentChunks = null;
            if (!isStructuredSession(selectedSession) && uploadedFiles.length) {
              var imageFiles = uploadedFiles.filter(function(file) {
                return isImageAttachmentSource({
                  savedPath: file && file.savedPath,
                  mimeType: file && (file.mimeType || file.type),
                  originalName: file && file.originalName,
                });
              });
              if (imageFiles.length) {
                var otherFiles = uploadedFiles.filter(function(file) {
                  return imageFiles.indexOf(file) < 0;
                });
                var ptyText = buildAttachmentPrefix(otherFiles)
                  + (hasText ? value : (otherFiles.length ? "请查看附件。" : ""));
                ptyAttachmentChunks = buildPtyAttachmentChunks(imageFiles, {
                  bracketedPaste: shouldBracketPtyPaste(
                    selectedSession.id,
                    selectedSession.provider,
                  ),
                  provider: selectedSession.provider
                    || inferProviderIdFromCommand(selectedSession.command || ""),
                });
                if (ptyText) {
                  ptyAttachmentChunks.push({ data: ptyText, shortcutKey: "enter_text" });
                }
                ptyAttachmentChunks.push({ data: String.fromCharCode(13), shortcutKey: "enter_text" });
              }
            }

            // Clear todo progress bar at the start of a new user turn
            if (sessionId === state.selectedId) collapseTodoProgress();

            if (isStructuredSession(selectedSession)) {
              return postStructuredInput(finalValue, inputBox, selectedSession, {
                interrupt: interruptFlag,
                composerCaptured: true,
              });
            }

            var submitChunks = ptyAttachmentChunks || getTerminalSubmitChunks(selectedSession, finalValue);
            if (state.selectedId !== sessionId) {
              throw new Error("发送前会话已切换，原草稿已恢复。");
            }
            if (!state.wsConnected) {
              throw new Error("网络已断开，消息未发送，原草稿已恢复。");
            }

            return ensureSessionReadyForInput(selectedSession).then(function(readySession) {
              if (!readySession) {
                // 具体原因已由 ensureSessionReadyForInput 原位播报，这里只负责中断发送，
                // 不能再把它覆盖成泛化文案。
                var unavailable: any = new Error("会话尚未准备好，消息未发送。");
                unavailable.__wandComposerReported = true;
                throw unavailable;
              }
              if (state.selectedId !== sessionId) {
                throw new Error("发送前会话已切换，原草稿已恢复。");
              }
              prepareChatBottomFollow();
              // 附件 chunk（图片路径粘贴 + 紧跟的文本）之间要等 CLI 把上一帧画完：
              // claude / pi 会把图片路径异步换成 [Image #N] 并重绘草稿行，
              // 按常规 30ms 文本间隔连发会让后面的 chunk 被那次重绘吞掉。
              return sendTerminalChunks(
                submitChunks,
                "enter_text",
                ptyAttachmentChunks ? 0 : 30,
                selectedView,
                readySession.id || sessionId,
                !!ptyAttachmentChunks,
              );
            });
          })
          .then(function(result) {
            // 发送链路自己给出更具体结论时（已加入排队 / 已中断）不覆盖，
            // 否则统一落到「已发送」，在同一位置原地显示后自动收回。
            if (getComposerResultPhase() === "sending") flashComposerDone("已发送");
            return result;
          })
        }).catch(function(err) {
            restoreComposerStateForSession(sessionId);
            // 失败原因在原位读（状态行 aria-live + 驻留比成功更长），草稿同帧回填，
            // 不再靠会自己飘走的气泡承担结果。已经原位播报过的（送达不确定）不重写。
            if (!(err && err.__wandComposerReported)) flashComposerFailed(getInputErrorMessage(err));
          })
          .finally(function() {
            updateInteractiveControls();
          });

        renderAttachmentPreview();
        return submissionPromise;
      }

      // 防止同一会话「快速双击 / 重复触发」。原来这是个布尔 flag，绑在 fetch 的
      // promise 上 —— 但 structured-sessions/:id/messages 的 POST 对首条消息会 await
      // 整段流式 streaming，flag 会被卡到回复完才释放。结果：用户点发送 → 服务端
      // 流式 30s 不响应 → 这 30s 里再点发送全被这里静默 drop，看起来"排队 / 立即发送
      // 都没效果"。改成时间戳 + 短窗口（350ms）只挡真正的连击。idempotencyKey 已经
      // 在后端兜底防 webview 网络层重发，这里的 hot-path 守门只需要应付 UI 双触发。
      var _structuredLastSubmitAt = {};
      var DUPLICATE_SUBMIT_WINDOW_MS = 350;

      function postStructuredInput(input, inputBox, session, opts) {
        opts = opts || {};
        // interrupt:true 现在只来自 Cmd/Ctrl+Enter 快捷键，或点队列气泡触发的
        // queueBarPromoteIndex()。普通 Enter / 点发送在上一条还在流式时默认走
        // queue —— 后端 sendMessage(...) 会把它追加到 queuedMessages，等当前 turn
        // 结束自动 flush；想插队就点输入框上方那条气泡。
        var requestedInterrupt = !!opts.interrupt;
        if (!input) return Promise.resolve();
        if (!session) {
          // 原因由提交链路的 catch 原位播报（状态行 + 草稿回填），不再弹气泡。
          return Promise.reject(new Error("会话不存在，请重新选择或新建会话。"));
        }
        var sessionInFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
        if (sessionInFlight && !requestedInterrupt && getLastStructuredSubmittedInput(session) === input.trim()) {
          if (!opts.composerCaptured) {
            if (inputBox && session.id === state.selectedId) {
              inputBox.value = "";
              autoResizeInput(inputBox);
            }
            setDraftValueForSession(session.id, "", true);
          }
          // 「没发出去」这件事在原位说清楚：排队条没有新增气泡，状态行给出原因。
          flashComposerFailed("与上一条消息相同，未加入排队。");
          return Promise.resolve();
        }
        // 短窗口内的连击当作重复点击丢掉；正常间隔的两次提交（哪怕第一次还在流式）
        // 都放行，让 queue / interrupt 真正生效。
        var nowTs = Date.now();
        var rapidDuplicateGuardEnabled = !opts.composerCaptured;
        var lastSubmit = _structuredLastSubmitAt[session.id];
        var lastTs = typeof lastSubmit === "number" ? lastSubmit : lastSubmit && lastSubmit.at || 0;
        var lastInput = typeof lastSubmit === "number" ? input : lastSubmit && lastSubmit.input;
        if (rapidDuplicateGuardEnabled && lastInput === input && nowTs - lastTs < DUPLICATE_SUBMIT_WINDOW_MS) {
          return Promise.resolve();
        }
        var submitStamp = rapidDuplicateGuardEnabled ? { at: nowTs, input: input } : null;
        if (submitStamp) _structuredLastSubmitAt[session.id] = submitStamp;

        var isInterrupting = sessionInFlight && requestedInterrupt;
        var isQueueing = sessionInFlight && !requestedInterrupt;
        var requestQueueVersion = composerQueue.read(session.id);
        var optimisticQueueIndex = -1;

        var userMsgs = stripRenderOnlyStructuredMessages(Array.isArray(session.messages) ? session.messages.slice() : []);
        var optimisticPatch;

        if (isQueueing) {
          // Queue 模式：不要乐观 push user turn —— buildMessagesForRender 会把
          // queuedMessages 渲成 __queued 占位（带"排队中"徽章），再 push 一份
          // 真 user turn 会被去重逻辑遮蔽掉，徽章就丢了。inFlight / status 维持。
          var nextQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
          optimisticQueueIndex = nextQueue.length;
          nextQueue.push(input);
          requestQueueVersion = composerQueue.advance(session.id, "local");
          optimisticPatch = {
            id: session.id,
            queuedMessages: nextQueue,
          };
          updateSessionSnapshot(optimisticPatch);
          if (session.id === state.selectedId) {
            var queueRefreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
            state.currentMessages = buildMessagesForRender(queueRefreshed, getPreferredMessages(queueRefreshed, queueRefreshed.output, false));
            renderChat(true);
            updateStructuredQueueCounter();
          }
          // 排队结果原位可见：输入框上方那条 .queue-bar 立刻多出第 N 个气泡（乐观更新），
          // 状态行同时给出这一条的排队句子，不再叠加一条会自己飘走的气泡。
          if (session.id === state.selectedId) {
            flashComposerDone(nextQueue.length > 1
              ? ("已加入排队（共 " + nextQueue.length + " 条等待）")
              : "已加入排队，等当前回复完成会自动发送。");
          } else {
            // 排进的是另一个会话：当前页没有它的排队条，原位宿主不存在，只能保留气泡。
            showToast(nextQueue.length > 1 ? ("已加入「" + (session.title || "该会话") + "」排队（共 " + nextQueue.length + " 条等待）") : "已加入「" + (session.title || "该会话") + "」排队，等它当前回复完成会自动发送。", "info");
          }
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
          if (session.id === state.selectedId) {
            state.currentMessages = buildMessagesForRender(Object.assign({}, session, {
              status: "running",
              messages: userMsgs,
              structuredState: optimisticStructuredState,
            }), userMsgs);
            prepareChatBottomFollow();
            renderChat(true);
            // 中断的成功语义落在原位：chat 流立刻出现这条 user turn，状态行说明
            // 「上一条已被打断」。普通发送不写句子（chat 流自己就是可见结果），
            // 由提交链路的 then 统一收口成「已发送」。
            if (isInterrupting) {
              flashComposerDone("已中断上一条回复，正在处理新消息…");
            }
          }
        }

        if (!opts.composerCaptured) {
          if (inputBox && session.id === state.selectedId) {
            inputBox.value = "";
            autoResizeInput(inputBox);
          }
          setDraftValueForSession(session.id, "", true);
        }

        // 给每次发送生成唯一 idempotency key。Android WebView 进程被冻结再恢复
        // 的边界场景下，底层网络栈偶尔会把上次未收到响应的 POST 重发一次（前端
        // JS 拦不住），导致同一条消息被 backend 处理两遍。带上 key 让 backend
        // 在窗口内识别重发并丢弃。
        var idempotencyKey = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));

        // 用 session.id（参数绑定，in-flight 期间不变）而不是 state.selectedId
        // 拼 URL，避免用户切到别的会话后 fetch 落到错误 sessionId。
        var requestAccepted = false;
        return compactSessionFetch("/api/structured-sessions/" + session.id + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            input: input,
            interrupt: isInterrupting || undefined,
            idempotencyKey: idempotencyKey,
          })
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
          requestAccepted = true;
          return res.json();
        })
        .then(function(snapshot) {
          if (snapshot && snapshot.error) {
            throw new Error(snapshot.error);
          }
          if (snapshot && snapshot.id) {
            snapshot = composerQueue.filter(snapshot, session.id, requestQueueVersion);
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
          if (requestAccepted) error = ambiguousInputDelivery(error);
          // duplicate_idempotency_key：服务端识别出 WebView 底层重发的副本，
          // 直接拦截不处理。这里**不**回滚乐观更新——第一次的请求实际上已经
          // 被服务端接收并处理（或正在处理），ws 推送会带回真实状态；如果在
          // 这里把 user turn rollback 掉，第一次的 user 消息会从 UI 上消失。
          if (error && error.errorCode === "duplicate_idempotency_key") {
            // 服务端识别出重发并拦截：这一条没被处理两次。原位说明即可，
            // 乐观更新按注释保持不回滚（第一次已送达）。
            if (session.id === state.selectedId) {
              flashComposerFailed(error.message || "检测到重复发送，已拦截。");
            } else {
              showToast(error.message || "检测到重复发送，已拦截。", "warning");
            }
            return;
          }

          if (submitStamp && _structuredLastSubmitAt[session.id] === submitStamp) {
            delete _structuredLastSubmitAt[session.id];
          }

          if (isQueueing) {
            // Remove only this optimistic item from the latest queue. A full
            // prevQueue rollback can erase messages added by newer requests.
            var rollbackQueue = rollbackQueueAppend(session.id, input, optimisticQueueIndex, requestQueueVersion);
            if (rollbackQueue) updateSessionSnapshot({ id: session.id, queuedMessages: rollbackQueue });
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
          if (isTransientAbort) {
            // 传输层失败 / 请求被 abort：这条消息可能已经被服务端接收。打标记让
            // sendInputFromBox 知道回填只能留在内存里（见 composer-draft.ts）。
            // 送达不确定也要原位说明，否则用户只会看到草稿莫名其妙回来。
            error.__wandAmbiguousDelivery = true;
            if (session.id === state.selectedId) {
              flashComposerFailed("网络中断，这条消息可能已送达；草稿已回填，重试前请先看会话内容。");
              error.__wandComposerReported = true;
            }
          }
          throw error;
        });
      }

      // ── 发送按钮相位机（docs/motion-design.md §3 提交状态反馈、§4 图标变形）──────
      // 一个宿主 #send-input-button 承载发送 / 停止 / 加载 / 完成四种可见状态：
      // 结果相位（sending / sent / failed）是短暂覆盖，驻留后回落到结构相位
      // （running = 可停止 / idle = 可发送）。优先级与 Android 的
      // SendActionVisual 一致：结果 > 运行中且无草稿 → 停止 > 有草稿 → 发送。
      // 「有草稿」这一档不能省：结构化会话在跑时点发送是排队，不是停止。
      //
      // 同一相位文案写在 .composer-status-line 上（原位），不再靠 Toast 气泡承担。
      type ComposerSendPhase = "idle" | "sending" | "sent" | "failed" | "running";
      var composerResultPhase: ComposerSendPhase | null = null;
      var composerResultText = "";
      var composerResultTimer = 0;

      function composerResultDwellMs(phase: ComposerSendPhase) {
        // 失败要读完原因，驻留必须 ≥ 成功；数值只从 motion-tokens 取，页面不写字面毫秒。
        return phase === "failed" ? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS;
      }

      // 结构相位：没有结果覆盖时按钮该长什么样。
      function composerBaseSendPhase(selectedSession, hasDraft): ComposerSendPhase {
        if (!hasDraft && computeRunningSignal(selectedSession).active) return "running";
        return "idle";
      }

      export function getComposerSendPhase(): string {
        var host = document.getElementById("send-input-button");
        return (host && host.getAttribute("data-phase")) || "idle";
      }

      // 当前是否还压着一个结果相位（发送链路用它判断「有没有人写过更具体的结论」）。
      export function getComposerResultPhase(): string {
        return composerResultPhase || "";
      }

      function composerIdleHint(isCodex) {
        // Codex 会话顺带解释 chat / terminal 两种视图的差别（原 .input-hint 的文案分叉）。
        return isCodex
          ? "Enter 发送 · chat 为解析视图，terminal 为原始输出"
          : COMPOSER_IDLE_HINT;
      }

      // 相位 → DOM：glyph 交叉淡入靠宿主 data-phase，可读名称靠 title / aria-label，
      // 结果句子靠 .composer-status-line（aria-live，成功态不抢焦点）。
      // 可读名称跟着相位走：空闲/排队沿用发送链路自己算出来的那串（含 Codex、
      // 优化中等等分支），结果相位与停止相位由这里覆盖。
      function composerPhaseLabels(phase: ComposerSendPhase, title: string, label: string, resultText: string) {
        if (phase === "running") return { title: "停止生成", label: "停止生成" };
        if (phase === "sending") return { title: "正在发送…", label: "正在发送…" };
        if (phase === "sent") return { title: resultText || "已发送", label: "已发送" };
        if (phase === "failed") return { title: resultText || "发送失败", label: "发送失败" };
        return { title: title, label: label };
      }

      function renderComposerPhaseHost(phase: ComposerSendPhase, text: string, isCodex: boolean) {
        var line = document.getElementById("composer-status-line");
        if (line) {
          var isResult = phase === "sending" || phase === "sent" || phase === "failed";
          line.textContent = isResult && text ? text : composerIdleHint(isCodex);
          var tone = isResult ? phase : "";
          line.removeAttribute("data-tone");
          if (tone) {
            // 同名 animation 改属性不会重播；强制一次重排让驻留倒计时重新开始走。
            void line.offsetWidth;
            line.setAttribute("data-tone", tone);
          }
        }
      }

      // 原位宿主此刻到底可不可见。getClientRects() 对 display:none 子树与未挂载节点
      // 都返回空列表（不像 offsetParent 会被 position:fixed 祖先骗过去）。
      function composerResultHostVisible(): boolean {
        var line = document.getElementById("composer-status-line") as HTMLElement | null;
        return !!line && line.getClientRects().length > 0;
      }

      function flashComposerPhase(phase: ComposerSendPhase, text: string, dwell: number) {
        if (composerResultTimer) {
          clearTimeout(composerResultTimer);
          composerResultTimer = 0;
        }
        composerResultPhase = phase;
        composerResultText = text || "";
        updateInteractiveControls();
        // 失败原因不许静默：这一处「原位根本没有宿主」时才退回旧气泡，不是原位已有结果再叠一层。
        // 直通模式整条 .composer-status-row 被 CSS 收掉（输入即透传，没有草稿位），原生嵌入壳
        // 同样隐藏 drafting row —— 这两种情况下原位行读不到 rect。成功态不退回气泡：直通下
        // 结果本来就写在终端/聊天流里，加气泡只会变成每次发送都响一下的噪音。
        if (phase === "failed" && !composerResultHostVisible()) {
          showToast(text || "操作未完成。", "error");
        }
        if (dwell <= 0) return;
        composerResultTimer = window.setTimeout(function() {
          composerResultTimer = 0;
          composerResultPhase = null;
          composerResultText = "";
          updateInteractiveControls();
        }, dwell);
      }

      // 「正在发送」是进行态不是结果：不设驻留计时，由提交链路的 then/catch 推进，
      // 否则慢上传（附件、首条流式响应）会被 720ms 后的自动回落打断。
      export function flashComposerSending(text: string) {
        flashComposerPhase("sending", text, 0);
      }

      export function flashComposerDone(text: string) {
        flashComposerPhase("sent", text, composerResultDwellMs("sent"));
      }

      export function flashComposerFailed(reason: string) {
        flashComposerPhase("failed", reason, composerResultDwellMs("failed"));
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

      var QUEUE_BAR_MAX = 10;            // 后端硬上限
      // 旧的「展开/收起」整体态已下线（气泡条改为常驻垂直列表）。保留 setter 供
      // ESC 兜底调用，确保任何遗留 expanded class 都会被清掉。
      function isQueueBarExpanded() {
        return !!state.queueBarExpanded;
      }

      function setQueueBarExpanded(expanded) {
        if (!!state.queueBarExpanded === !!expanded) return;
        state.queueBarExpanded = !!expanded;
        var bar = document.querySelector(".queue-bar");
        if (bar) bar.classList.toggle("expanded", !!expanded);
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
          clearQueueView(host);
          // 队列空时同步把"展开"标志收回，避免下次出现新排队时还是展开态。
          state.queueBarExpanded = false;
          return;
        }

        // 拖拽进行中绝不重建 DOM，否则 pointer capture 丢失、气泡闪屏。
        if (state.queueBarDrag) return;

        host.hidden = false;
        var inFlight = !!(session.structuredState && session.structuredState.inFlight && session.status === "running");
        var atCapacity = queue.length >= QUEUE_BAR_MAX;

        paintQueueBar(host, queue, inFlight, atCapacity);
      }

      // ── 单条删除 / 全部清空 / 队首插队 ──
      function rollbackQueueOptimistic(session, prevQueue, requestVersion) {
        var latest = state.sessions.find(function(s) { return s.id === session.id; }) || session;
        var restored = composerQueue.rollback(session.id, latest.queuedMessages || [], prevQueue, requestVersion);
        if (restored) updateSessionSnapshot({ id: session.id, queuedMessages: restored });
        if (session.id === state.selectedId) {
          var refreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
          state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
          renderChat(true);
          updateQueueBar();
        }
      }

      var queueBarEditing = new Set<string>();
      async function queueBarEditItem(index) {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var original = session && session.queuedMessages && session.queuedMessages[index];
        if (typeof original !== "string" || queueBarEditing.has(session.id)) return;
        var sessionId = session.id;
        var originalQueue = session.queuedMessages.slice();
        var version = composerQueue.read(sessionId);
        var draft = original;
        var message = "修改这条排队消息";
        var isCurrent = function() {
          var current = state.sessions.find(function(s) { return s.id === sessionId; });
          var now = composerQueue.read(sessionId);
          var queue = current && current.queuedMessages;
          return !!current && state.selectedId === sessionId
            && now.revision === version.revision && now.epoch === version.epoch
            && Array.isArray(queue) && queue.length === originalQueue.length
            && queue.every(function(text, position) { return text === originalQueue[position]; });
        };
        queueBarEditing.add(sessionId);
        try {
          while (true) {
            var edited = await uiPrompt(message, draft, { title: "编辑排队消息", okLabel: "保存" });
            if (edited === null || edited.trim() === original) return;
            if (!isCurrent()) {
              showToast("会话或排队内容已更新，此次编辑已取消。", "warning");
              return;
            }
            draft = edited;
            if (!edited.trim()) { message = "排队消息不能为空。"; continue; }
            version = composerQueue.advance(sessionId, "local");
            try {
              var res = await compactSessionFetch("/api/structured-sessions/" + encodeURIComponent(sessionId) + "/queued/" + index, {
                method: "PATCH", credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedText: original, text: edited }),
              });
              if (!res.ok) throw new Error((await res.json()).error || "编辑失败");
              var payload = await res.json();
              if (!Array.isArray(payload.queuedMessages)) throw new Error("编辑结果暂不可用，请检查排队内容。");
              if (!state.sessions.some(function(s) { return s.id === sessionId; })) return;
              var snapshot = composerQueue.filter({ id: sessionId, queuedMessages: payload.queuedMessages }, sessionId, version);
              if (snapshot.queuedMessages) updateSessionSnapshot(snapshot);
              if (state.selectedId === sessionId) updateQueueBar();
              return;
            } catch (err) {
              // Keep the entered text in the same owner's dialog. A late error
              // must neither reopen it over another session nor replace new queue state.
              if (!isCurrent()) return;
              message = getErrorMessage(err, "编辑排队消息失败。") + " 请重试或取消。";
            }
          }
        } catch (err) {
          if (isCurrent()) showToast(getErrorMessage(err, "无法打开编辑对话框，排队内容已保留。"), "error");
        } finally { queueBarEditing.delete(sessionId); }
      }

      function queueBarDeleteItem(index) {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return;
        var queue = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        if (index < 0 || index >= queue.length) return;
        var prev = queue.slice();
        var next = queue.slice(0, index).concat(queue.slice(index + 1));
        var mutationVersion = composerQueue.advance(session.id, "local");
        updateSessionSnapshot({ id: session.id, queuedMessages: next });
        var refreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
        state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
        renderChat(true);
        updateQueueBar();
        compactSessionFetch("/api/structured-sessions/" + session.id + "/queued/" + index, {
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
          rollbackQueueOptimistic(session, prev, mutationVersion);
          flashComposerFailed((err && err.message) || "删除排队消息失败。");
        });
      }

      function queueBarClearAll() {
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return;
        var prev = Array.isArray(session.queuedMessages) ? session.queuedMessages.slice() : [];
        if (prev.length === 0) return;
        // 全部清空后收起列表，UX 上更干净（用户不需要盯着一条不剩的展开面板）。
        state.queueBarExpanded = false;
        var mutationVersion = composerQueue.advance(session.id, "local");
        updateSessionSnapshot({ id: session.id, queuedMessages: [] });
        var refreshed = state.sessions.find(function(s) { return s.id === session.id; }) || session;
        state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, refreshed.output, false));
        renderChat(true);
        updateQueueBar();
        compactSessionFetch("/api/structured-sessions/" + session.id + "/queued", {
          method: "DELETE",
          credentials: "same-origin",
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().catch(function() { return {}; }).then(function(p) {
              throw new Error((p && p.error) || "清空失败");
            });
          }
          // 「清空」的结果原位可见：整条 .queue-bar 已经收起（上面 updateQueueBar 乐观做完），
          // 不再补一条「已清空 N 条」的气泡，同一件事只说一次。
        })
        .catch(function(err) {
          rollbackQueueOptimistic(session, prev, mutationVersion);
          flashComposerFailed((err && err.message) || "清空排队消息失败。");
        });
      }

      // 把队列里第 index 条剥下来，作为新的输入立刻发送出去。
      // - inFlight：interrupt + preserveQueue（中断当前回复，保留其它排队）
      // - 非 inFlight：当作普通新消息发出去
      // 用户路径：点输入框上方的气泡（chip）→ 这里。
      function queueBarPromoteIndex(index) {
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
        var mutationVersion = composerQueue.advance(session.id, "local");
        updateSessionSnapshot({ id: session.id, queuedMessages: rest });

        var idempotencyKey = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));

        // 插队的即时反馈在原位：这一条气泡已经从小条里剥掉（乐观），状态行同步说明
        // 接下来发生什么；不再是右上角飘走的气泡。
        flashComposerSending(inFlight ? "正在插队发送，准备打断当前回复…" : "正在发送这条…");

        compactSessionFetch("/api/structured-sessions/" + session.id + "/queued/" + index + "/promote", {
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
            snapshot = composerQueue.filter(snapshot, session.id, mutationVersion);
            updateSessionSnapshot(snapshot);
            if (snapshot.id === state.selectedId) {
              var refreshed = state.sessions.find(function(s) { return s.id === snapshot.id; }) || snapshot;
              state.currentMessages = buildMessagesForRender(refreshed, getPreferredMessages(refreshed, snapshot.output, false));
              renderChat(true);
              updateQueueBar();
            }
          }
          flashComposerDone(inFlight ? "已中断上一条回复，这条立即发送。" : "已立即发送这条消息。");
          state.queueBarPromoting = false;
        })
        .catch(function(err) {
          state.queueBarPromoting = false;
          rollbackQueueOptimistic(session, prev, mutationVersion);
          flashComposerFailed((err && err.message) || "立即发送失败。");
        });
      }

      // ── 拖拽排序（Pointer Events + 真实高度的 sort/animate）──
      // 单条气泡的 pointerdown 也会进这里，但 queue.length <= 1 时直接返回，让
      // 系统 click 事件穿透到 #queue-bar-host 的 click delegate（那里再判断"点击
      // 气泡 → 立即发送"）。
      function queueBarDragStart(ev, chipEl) {
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
          sessionId: session.id,
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
      function queueBarComputeNewTops(origIndex, target, rects, gap) {
        var n = rects.length;
        var order = [];
        for (var i = 0; i < n; i++) order.push(i);
        order.splice(origIndex, 1);
        order.splice(target, 0, origIndex);
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

      function queueBarDragMove(ev) {
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

      function queueBarDragEnd(ev) {
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
        if (!session || session.id !== d.sessionId) { updateQueueBar(); return; }
        var currentQueue = Array.isArray(session.queuedMessages) ? session.queuedMessages : [];
        if (currentQueue.length !== queueSnapshot.length
          || currentQueue.some(function(text, index) { return text !== queueSnapshot[index]; })) {
          updateQueueBar();
          flashComposerFailed("排队内容已更新，请重新拖动排序。");
          return;
        }
        var mutationVersion = composerQueue.advance(session.id, "local");
        updateSessionSnapshot({ id: session.id, queuedMessages: nextQueue });
        updateQueueBar();

        compactSessionFetch("/api/structured-sessions/" + session.id + "/queued", {
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
          rollbackQueueOptimistic(session, queueSnapshot, mutationVersion);
          flashComposerFailed((err && err.message) || "调整排队顺序失败。");
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
            if (action === "edit") {
              var editItem = actionEl.closest(".queue-bar-item");
              if (editItem) queueBarEditItem(Number(editItem.getAttribute("data-index")));
            } else if (action === "promote-item") {
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
                '[data-action="delete"], [data-action="edit"], [data-action="promote-item"], ' +
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
          // Provider tool-result envelopes may use role=user, but are not a new
          // human turn. Do not insert a second processing row below an open tool.
          var last = null;
          for (var lastIndex = base.length - 1; lastIndex >= 0; lastIndex--) {
            var message = base[lastIndex];
            if (message.role !== "user" || !Array.isArray(message.content) ||
              message.content.some(function(block) { return block?.type !== "tool_result"; })) {
              last = message;
              break;
            }
          }
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

      function getInputErrorMessage(error) {
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

      function buildInputError(payload) {
        var err = new Error((payload && payload.error) || "会话已结束。") as SendError;
        if (payload && typeof payload === "object") {
          err.errorCode = payload.errorCode || null;
          err.sessionId = payload.sessionId || state.selectedId || null;
          err.sessionStatus = Object.prototype.hasOwnProperty.call(payload, "sessionStatus") ? payload.sessionStatus : null;
        }
        return err;
      }

      function isSessionUnavailableError(error) {
        return error && (error.errorCode === "SESSION_NOT_RUNNING" || error.errorCode === "SESSION_NO_PTY" || error.errorCode === "SESSION_NOT_FOUND");
      }

      function markSessionStopped(sessionId, status) {
        if (!sessionId) return;
        updateSessionSnapshot({ id: sessionId, status: status || "exited" });
      }

      export function canAutoResumeSession(session) {
        // 只要是受支持的 provider PTY + 非运行中 + 有可恢复历史 id，
        // 就允许在用户发送时静默触发恢复。不再要求 messages 里同时
        // 有 user + assistant 文本（slim 列表/截断历史会让该判断失真）。
        return !!(session && !isStructuredSession(session)
          && PROVIDER_IDS.indexOf(session.provider) !== -1
          && session.status !== "running" && session.claudeSessionId);
      }

      function ensureSessionReadyForInput(session) {
        // 只在发送链路被调用（唯一调用点见 sendInputFromBox），所以失败原因原位播报。
        if (!session) {
          flashComposerFailed("会话不存在，请重新选择或新建会话。");
          return Promise.resolve(null);
        }
        if (session.status === "running") {
          return Promise.resolve(session);
        }
        if (!canAutoResumeSession(session)) {
          var providerLabel = (session && PROVIDER_LABELS[session.provider]) || "Provider";
          flashComposerFailed("该会话没有可恢复的 " + providerLabel + " 历史上下文，请新建会话。");
          return Promise.resolve(null);
        }

        // 静默恢复：不再弹 "正在恢复历史会话…" 提示，让用户发送动作看起来无缝。
        return resumeSession(session.id).then(function(data) {
          if (!data) return null;
          updateSessionSnapshot(data);
          updateSessionsList();
          subscribeToSession(data.id);
          return loadOutput(data.id).then(function() {
            focusInputBox(true);
            // PTY 冷启动：先等 CLI 画出自己的 TUI 再让调用方写入，否则粘贴序列会被
            // 当成字面量（见 waitForProviderPaint）。结构化会话没有这一步。
            if (isStructuredSession(data)) return data;
            return waitForProviderPaint().then(function() { return data; });
          });
        });
      }

      function getTerminalSubmitChunks(session, text) {
        // 文本与回车分两个 chunk 发，避免 CLI 的 bracketed paste 检测把末尾
        // \r 并入粘贴内容导致只换行不提交。
        return [text, String.fromCharCode(13)];
      }

      // chunk 可以是字符串，也可以是 { data, shortcutKey }：附件序列需要逐 chunk
      // 打不同的标（路径 paste / 文本 enter_text），不能用统一的 shortcutKey。
      function normalizeTerminalChunk(entry) {
        if (typeof entry === "string") return entry ? { data: entry } : null;
        if (entry && typeof entry.data === "string" && entry.data) {
          return { data: entry.data, shortcutKey: entry.shortcutKey, image: !!entry.image };
        }
        return null;
      }

      // 图片芯片完成（CLI 读文件 + 重绘草稿）比普通重绘慢，实测 codex 需要 2~3s；
      // 等太短会让紧随其后的回车把未完成的芯片当成普通路径文本提交。
      var PTY_IMAGE_CHIP_SETTLE_MAX_MS = 3000;

      function ambiguousInputDelivery(error) {
        return Object.assign(new Error(getErrorMessage(error, "输入提交结果未知。")), error, {
          __wandAmbiguousDelivery: true,
        });
      }

      function sendTerminalChunks(chunks, shortcutKey, delayMs, viewOverride, sessionId?, settleChunks?: boolean) {
        var sequence = (Array.isArray(chunks) ? chunks : []).map(normalizeTerminalChunk).filter(Boolean);
        if (sequence.length === 0) {
          return Promise.resolve();
        }
        var delay = typeof delayMs === "number" ? delayMs : 0;
        var acceptedChunks = 0;
        return sequence.reduce(function(promise, chunk, index) {
          // 文本段和单独的 "\r" 都带 enter_text：服务端用它判断这是整段提交，
          // 从而给 PTY 会话生成标题；中间若有其它 chunk 则不打标。
          // 附件 chunk 自带 shortcutKey（路径 = paste），优先用它。
          var key = chunk.shortcutKey !== undefined
            ? chunk.shortcutKey
            : (shortcutKey && (index === 0 || index === sequence.length - 1) ? shortcutKey : undefined);
          return promise.then(function() {
            if (index > 0) {
              // settleChunks：附件序列不能按固定间隔发，要等 CLI 画完上一帧。
              // 图片芯片慢一拍，所以跟在图片粘贴后的那一包用更高上限。
              var previousChunk = sequence[index - 1];
              var wait = settleChunks
                ? waitForTerminalSettled(
                  undefined,
                  previousChunk && previousChunk.image ? PTY_IMAGE_CHIP_SETTLE_MAX_MS : undefined,
                )
                : (delay > 0
                  ? new Promise(function(resolve) { setTimeout(resolve, delay); })
                  : Promise.resolve());
              return wait.then(function() {
                return queueDirectInput(chunk.data, key, viewOverride, sessionId);
              });
            }
            return queueDirectInput(chunk.data, key, viewOverride, sessionId);
          }).then(function(result) {
            acceptedChunks += 1;
            return result;
          });
        }, Promise.resolve()).catch(function(error) {
          // Text/image chunks may already be in the PTY even when the final
          // Enter is rejected. Persisting the whole payload would replay them.
          throw acceptedChunks > 0 ? ambiguousInputDelivery(error) : error;
        });
      }

      // pendingMessages 缓存 ws 离线时的输入，重连后回放。每条带时间戳，
      // flush 时丢弃过期项——离线 >TTL 后回放老按键序列只会让 PTY 错位。
      var PENDING_INPUT_TTL_MS = 5000;
      var PENDING_INPUT_MAX = 100;
      function enqueuePendingInput(input) {
        if (!input) return;
        if (state.pendingMessages.length >= PENDING_INPUT_MAX) {
          state.pendingMessages.shift();
        }
        state.pendingMessages.push({ input: input, at: Date.now() });
      }

      export function queueDirectInput(input, shortcutKey?, viewOverride?, sessionId?) {
        var targetSessionId = sessionId || state.selectedId;
        if (!input || !targetSessionId) return Promise.resolve();
        var effectiveView = viewOverride || state.currentView;
        if (effectiveView === "terminal"
            && targetSessionId === state.selectedId
            && state.ws
            && state.ws.readyState === WebSocket.OPEN) {
          // readyState 读到 OPEN 不代表 send() 一定不抛：浏览器在连接正在关闭的
          // 竞争窗口里会同步抛 InvalidStateError（还有超背压时的 QuotaExceededError）。
          // 这一抛发生在 Promise 之外，会绕过调用方的 .catch（批I 的播报挂在
          // reportPassthroughInputFailure 上）变成未处理拒绝、用户那条输入静默丢失。
          // 所以在这里接住、转成同一条链路的 rejection：同步抛与异步 reject 从此
          // 走同一个出口，只播报一次，也不会再顺手补发一次 HTTP（可能已经送达）。
          try {
            state.ws.send(JSON.stringify({
              type: "pty_input",
              sessionId: targetSessionId,
              data: input,
              shortcutKey: shortcutKey,
              userInput: true
            }));
          } catch (error) {
            return Promise.reject(error);
          }
          return Promise.resolve();
        }
        state.messageQueue.push(input);
        var queued = state.inputQueue.then(function() {
          return postInput(input, shortcutKey, viewOverride, targetSessionId, !!sessionId).finally(function() {
            var idx = state.messageQueue.indexOf(input);
            if (idx > -1) state.messageQueue.splice(idx, 1);
          });
        });
        // 队列自己永远保持 fulfilled：一次失败（网络抖动、会话已停止）若留在
        // state.inputQueue 上，之后每次 queueDirectInput 的 .then 都会被跳过，
        // 直通输入从此静默死掉，直到刷新页面。失败只交给上面那条 promise 带给
        // 调用方去播报。
        state.inputQueue = queued.catch(function() {});
        return queued;
      }

      export function postInput(input, shortcutKey, viewOverride, sessionId?, strictTarget?) {
        var requestSessionId = sessionId || state.selectedId;
        if (!requestSessionId) return Promise.resolve();
        // 锁定本次请求归属的 sessionId。fetch 发起后用户可能切到别的会话，
        // 后续 then 回调里直接用 state.selectedId 会误把 A 的响应应用到 B：
        //   - URL 上拼错会话（虽然 fetch 已经求值过 URL，但 markSessionStopped
        //     等 in-flight 引用会读最新值 → 把 B 标为 stopped 但实际是 A 失败）
        //   - response.snapshot 属于 A，被 setCurrentMessages 误覆盖到 B 视图
        // 用 requestSessionId 锁住请求方，渲染相关动作再单独判断 snapshot.id
        // === 当前 state.selectedId 才执行。
        var effectiveView = viewOverride || state.currentView;
        var requestSession = state.sessions.find(function(session) { return session.id === requestSessionId; });
        var requestSessionRunning = !!requestSession
          && !isStructuredSession(requestSession)
          && requestSession.status === "running";

        // Pre-check: don't send if session is not running
        if (!requestSessionRunning) {
          if (strictTarget) {
            var unavailableTarget: any = new Error("目标会话已停止，消息未发送。");
            unavailableTarget.errorCode = requestSession ? "SESSION_NOT_RUNNING" : "SESSION_NOT_FOUND";
            throw unavailableTarget;
          }
          // If WebSocket is disconnected, queue for flush on reconnect
          if (!state.wsConnected) {
            enqueuePendingInput(input);
            return Promise.resolve();
          }
          console.warn("[wand] postInput: session not running, skipping send", {
            sessionId: requestSessionId
          });
          showToast("会话未运行，正在等待自动恢复后重试。", "info");
          return Promise.resolve();
        }

        // If WebSocket is disconnected, queue the message (no HTTP fetch while offline)
        if (!state.wsConnected) {
          if (strictTarget) {
            throw new Error("网络已断开，消息未发送。");
          }
          enqueuePendingInput(input);
          return Promise.resolve();
        }

        var requestAccepted = false;
        return compactSessionFetch("/api/sessions/" + requestSessionId + "/input", {
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
          requestAccepted = true;
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
        }).catch(function(error) {
          // A successful acknowledgement followed by response parsing/render
          // failure still means the input may already have reached the PTY.
          throw requestAccepted ? ambiguousInputDelivery(error) : error;
        });
      }

      export function getSelectedSession() {
        return state.sessions.find(function(session) { return session.id === state.selectedId; }) || null;
      }

      export function isTerminalInteractionAvailable() {
        return !!state.selectedId && state.currentView === "terminal";
      }

      // 判断一条带 sessionId 的 WS 消息是否应该被当前 xterm 实例消费。
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

      // Safari / WKWebView can expose the Enter that confirms an IME candidate
      // with isComposing=false. This predicate is shared by the document-level
      // terminal capture phase and the textarea handler so neither path can
      // forward that key before the other one sees it.
      export function isImeKeyboardEvent(event) {
        return !!event && (
          !!event.isComposing
          || event.keyCode === 229
          || !!state.composerComposing
        );
      }

      export function shouldCaptureTerminalEvent(event) {
        if (!state.terminalInteractive || !isTerminalInteractionAvailable()) return false;
        if (event.defaultPrevented || isImeKeyboardEvent(event)) return false;
        var target = event.target;
        if (!target) return true;
        // Composer 拥有自己的键盘：直通模式下 #input-box 的文本是通过
        // `handleInteractiveTextInput` 在 input 事件里逐字发出去的。如果这里
        // 再把同一个 keydown 透传一次，每个字符都会重复到达 PTY。
        if (target.closest && target.closest("#input-box")) return false;
        if (shouldIgnoreInteractiveTarget(target)) return false;
        return true;
      }

      var keyboardEventKeyMap = {
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

      var ptySpecialKeyMap = {
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

      var ctrlSymbolMap = {
        " ": 0,
        "[": 27,
        "\\": 28,
        "]": 29,
        "^": 30,
        "_": 31
      };

      function shouldIgnoreInteractiveTarget(target) {
        if (!target) return false;
        // React/Radix overlays own their keyboard contract. In terminal-interactive
        // mode the document capture listener otherwise consumes Escape before the
        // dialog can dismiss itself (and can forward radio arrow keys to the PTY).
        return !!(target.closest && target.closest(
          '[role="dialog"], [role="alertdialog"], .wand-ui-select-trigger, .wand-ui-select-content, [role="listbox"], [role="option"], .terminal-shortcuts'
        ));
      }

      var modifierKeySet = new Set(["ctrl", "alt", "shift"]);

      function isModifierKey(key) {
        return modifierKeySet.has(key);
      }

      function getPtySpecialSequence(key) {
        return ptySpecialKeyMap[key] || "";
      }

      function getCtrlSequence(text) {
        var lower = text.toLowerCase();
        if (lower >= "a" && lower <= "z") {
          return String.fromCharCode(lower.charCodeAt(0) - 96);
        }
        if (Object.prototype.hasOwnProperty.call(ctrlSymbolMap, lower)) {
          return String.fromCharCode(ctrlSymbolMap[lower]);
        }
        return "";
      }

      function keyFromKeyboardEvent(event) {
        return keyboardEventKeyMap[event.key] || event.key;
      }

      function getModifierStateFromEvent(event, key) {
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

      function focusTerminalInteractionTarget() {
        focusTerminalContainer();
      }

      export function toggleTerminalInteractive() {
        if (!isTerminalInteractionAvailable()) return;
        setTerminalInteractive(!state.terminalInteractive);
      }

      /**
       * 加号 popover「上传附件」条目的动作（条目本身由 React portal 渲染）。
       * `keyboard` 来自 `event.detail === 0`：键盘触发时把焦点还给触发按钮。
       */
      export function openComposerFilePicker(keyboard = false) {
        closePlusPopover(keyboard);
        var fileInput = document.getElementById("file-upload-input") as HTMLInputElement | null;
        if (fileInput) fileInput.click();
      }

      function shouldUseTerminalPassthrough(session) {
        return !!session
          && !isStructuredSession(session)
          && session.status === "running"
          && state.currentView === "terminal";
      }

      function isNativeInputEmbed() {
        return document.documentElement.classList.contains("is-wand-native-input");
      }

      // iOS 原生输入栏（nativeInput=1 且没有 passthrough）必须独占 IME。
      // xterm 隐藏 textarea 一旦抢到焦点，中文组字会打进看不见的终端，
      // 再由原生框发送一次，PI TUI 就会出现「输不进去 / 重复输入」。
      export function shouldLockNativeInputTerminalIme() {
        return isNativeInputEmbed()
          && !document.documentElement.classList.contains("is-wand-terminal-passthrough");
      }

      export function lockNativeInputTerminalIme() {
        if (!shouldLockNativeInputTerminalIme()) return false;
        if (state.terminal && state.terminal.element) {
          var helperTextarea = state.terminal.element.querySelector(".xterm-helper-textarea");
          if (helperTextarea) {
            helperTextarea.readOnly = true;
            helperTextarea.setAttribute("aria-readonly", "true");
            if (document.activeElement === helperTextarea) {
              try { helperTextarea.blur(); } catch (err) {}
            }
          }
        }
        return true;
      }

      var nativeInputImeGuardInstalled = false;
      export function installNativeInputImeGuard() {
        if (nativeInputImeGuardInstalled || !shouldLockNativeInputTerminalIme()) return;
        nativeInputImeGuardInstalled = true;
        document.addEventListener("focusin", function(event) {
          var target = event.target as HTMLElement | null;
          if (!target || !target.classList || !target.classList.contains("xterm-helper-textarea")) return;
          lockNativeInputTerminalIme();
        }, true);
      }

      export function setTerminalInteractive(enabled, options?) {
        var opts = options || {};
        var next = !!enabled && isTerminalInteractionAvailable();
        if (state.terminalInteractive === next) return;
        state.terminalInteractive = next;
        if (state.terminal && state.terminal.element) {
          var helperTextarea = state.terminal.element.querySelector(".xterm-helper-textarea");
          if (helperTextarea) helperTextarea.readOnly = shouldLockNativeInputTerminalIme() ? true : !next;
        }
        if (next) {
          enableTerminalCapture();
          if (opts.focus !== false && !shouldLockNativeInputTerminalIme()) focusTerminalInteractionTarget();
          if (opts.announce !== false) showToast("终端交互模式已开启", "info");
        } else {
          disableTerminalCapture();
        }
        updateInteractiveControls();
        // Re-measure after the terminal modifier lands so an inline height
        // left by the normal composer cannot override the compact CSS state.
        var composer = document.getElementById("input-box");
        if (composer) autoResizeInput(composer);
      }

      export function reconcileInteractiveState() {
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var shouldUsePassthrough = shouldUseTerminalPassthrough(selectedSession);
        var shouldDisableInteractive = !shouldUsePassthrough;
        if (shouldDisableInteractive && state.terminalInteractive) {
          setTerminalInteractive(false);
          return;
        }
        if (shouldUsePassthrough && !state.terminalInteractive) {
          setTerminalInteractive(true, { announce: false, focus: false });
          return;
        }
        updateInteractiveControls();
      }

      export function updateInteractiveControls() {
        mountComposerSender(autoResizeInput);
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var structured = isStructuredSession(selectedSession);
        var isCodex = selectedSession && selectedSession.provider === "codex";
        var isRunning = structured
          ? !!(selectedSession && selectedSession.structuredState && selectedSession.structuredState.inFlight)
          : !!selectedSession && selectedSession.status === "running";
        var composer = document.getElementById("input-box") as HTMLInputElement | null;
        var composerShell = document.querySelector(".input-composer");
        var promptOptimizeRequest = state.promptOptimizeRequest;
        var promptOptimizeBusyForCurrent = !!(promptOptimizeRequest
          && promptOptimizeRequest.sessionId === state.selectedId);
        var promptOptimizeBusyAnywhere = !!promptOptimizeRequest;
        var terminalPassthrough = shouldUseTerminalPassthrough(selectedSession);
        // 终端交互 toggle 挂在加号 popover 内，条目由 React portal 渲染；
        // 这里只发布可见性与开关状态，不再直接改写 class / aria / 文案。
        syncBrowserComposerPopover({
          resolve: function() {
            return {
              interactiveVisible: !(structured || state.currentView !== "terminal" || !selectedSession || terminalPassthrough),
              interactiveOn: state.terminalInteractive,
            };
          },
          onAttach: function(keyboard) { openComposerFilePicker(keyboard); },
          onToggleInteractive: toggleTerminalInteractive,
        });
        // 历史会话只要可自动恢复（Claude/Codex PTY + 有历史 id），输入框/发送按钮
        // 就保持可用——发送时由 ensureSessionReadyForInput 透明完成恢复。
        var canResumeOnSend = !structured && !isRunning && canAutoResumeSession(selectedSession);
        if (composer) {
          composer.placeholder = getComposerPlaceholder(selectedSession, state.terminalInteractive);
          composer.disabled = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
          composer.setAttribute("aria-disabled", composer.disabled ? "true" : "false");
          // Terminal passthrough must stay editable for IME composition. Prompt
          // optimization is the sole short-lived read-only state so the request
          // cannot race a new edit or send half-replaced content.
          composer.readOnly = promptOptimizeBusyForCurrent;
          composer.setAttribute("aria-readonly", composer.readOnly ? "true" : "false");
          composer.setAttribute("aria-busy", promptOptimizeBusyForCurrent ? "true" : "false");
          composer.classList.toggle(
            "is-terminal-passthrough",
            !!state.terminalInteractive && !document.documentElement.classList.contains("is-wand-embed-terminal"),
          );
        }
        if (composerShell) {
          composerShell.classList.toggle("is-optimizing", promptOptimizeBusyForCurrent);
          composerShell.classList.toggle("is-terminal-interactive", !!state.terminalInteractive);
        }
        // 直通 composer 的尾部操作区由 Appica 渲染：legacy 的发送 / 语音 / 优化按钮
        // 在直通下全部收起，这里把「发送回车」这个真实动作补回右侧栏。
        // 原生嵌入壳的底栏由原生渲染，网页侧不挂载。
        syncBrowserComposerRail({
          active: function() {
            return !!state.terminalInteractive
              && !document.documentElement.classList.contains("is-wand-embed-terminal");
          },
          submit: function() { void sendInputFromBox(undefined); },
          focusInput: function() {
            focusInputWithSelection(document.getElementById("input-box"));
          },
        });
        syncPiSettingsComposer();
        var promptOptimizeBtn = document.getElementById("prompt-optimize-btn") as HTMLButtonElement | null;
        if (promptOptimizeBtn) {
          promptOptimizeBtn.disabled = promptOptimizeBusyAnywhere;
          promptOptimizeBtn.classList.toggle("is-loading", promptOptimizeBusyForCurrent);
          promptOptimizeBtn.setAttribute("aria-busy", promptOptimizeBusyForCurrent ? "true" : "false");
          promptOptimizeBtn.setAttribute(
            "aria-label",
            promptOptimizeBusyForCurrent
              ? "正在优化提示词"
              : (promptOptimizeBusyAnywhere ? "其他会话正在优化提示词" : "优化提示词"),
          );
          promptOptimizeBtn.setAttribute(
            "title",
            promptOptimizeBusyForCurrent
              ? "正在优化…"
              : (promptOptimizeBusyAnywhere ? "其他会话正在优化…" : "优化提示词"),
          );
          var promptOptimizeLabel = promptOptimizeBtn.querySelector(".prompt-optimize-label");
          if (promptOptimizeLabel) {
            promptOptimizeLabel.textContent = promptOptimizeBusyForCurrent ? "优化中" : "优化";
          }
        }
        // 终端直通时禁用独立语音按钮；若切换过程中正在录音则立即取消。
        var voiceBtn = document.getElementById("voice-record-btn") as HTMLButtonElement | null;
        if (voiceBtn) {
          voiceBtn.disabled = state.terminalInteractive || promptOptimizeBusyForCurrent;
          voiceBtn.setAttribute("aria-disabled", voiceBtn.disabled ? "true" : "false");
        }
        if ((state.terminalInteractive || promptOptimizeBusyForCurrent) && voiceState.recording) {
          voiceState.recording = false;
          resetVoiceRecordingUI();
        }
        var sendBtn = document.getElementById("send-input-button") as HTMLButtonElement | null;
        var structuredInFlight = structured && isRunning;
        if (sendBtn) {
          var sessionUnavailable = !structured && !!selectedSession && !isRunning && !canResumeOnSend;
          var composerValue = composer ? composer.value : "";
          var currentAttachments = getPendingAttachments(state.selectedId);
          var composerCanSend = canSendComposer(composerValue, state.selectedId);
          var duplicateInFlight = !!(composerCanSend && composerStore.pendingSubmission(
            state.selectedId, { text: composerValue, attachments: currentAttachments },
          ));
          var sendDisabled = promptOptimizeBusyForCurrent
            || !composerCanSend
            || duplicateInFlight
            || sessionUnavailable;
          // 相位 = 结果覆盖 > 运行中且无草稿（停止）> 空闲（发送）。
          var sendPhase: ComposerSendPhase = composerResultPhase
            || composerBaseSendPhase(selectedSession, composerCanSend);
          // 「停止」是这一相位下唯一的动作，原来那颗独立停止按钮从来没有禁用逻辑；
          // 空草稿不算「不能点」，否则在跑会话的唯一出口又被发条件锁死。
          if (sendPhase === "running") sendDisabled = false;
          sendBtn.disabled = sendDisabled;
          sendBtn.setAttribute("aria-disabled", sendBtn.disabled ? "true" : "false");
          sendBtn.setAttribute("data-phase", sendPhase);
          var sendTitle = promptOptimizeBusyForCurrent
            ? "正在优化提示词"
            : (structured
              ? (structuredInFlight ? "排队发送（当前回复结束后处理）" : "发送")
              : (isCodex ? (isRunning ? "发送给 Codex" : "Codex 会话已结束") : (!selectedSession || isRunning || canResumeOnSend ? "发送" : "会话已结束")));
          var sendLabel = promptOptimizeBusyForCurrent
            ? "正在优化提示词"
            : (structuredInFlight ? "加入发送队列" : "发送消息");
          var phaseLabels = composerPhaseLabels(sendPhase, sendTitle, sendLabel, composerResultText);
          sendBtn.setAttribute("title", phaseLabels.title);
          sendBtn.setAttribute("aria-label", phaseLabels.label);
          // queue-mode 只描述「点下去是排队」这一语义；露出停止 glyph 时不参与。
          sendBtn.classList.toggle("queue-mode", structuredInFlight && sendPhase !== "running");
          renderComposerPhaseHost(sendPhase, composerResultText, isCodex);
        }
        // 「是否有 reply 在跑」由 computeRunningSignal 统一给出（结构化 inFlight /
        // PTY running / 权限审批阻塞），它只决定上面那颗按钮的相位，
        // 不再单独控制一个停止节点的显隐。
        var container = document.getElementById("output");
        if (container) container.classList.toggle("interactive", !structured && state.terminalInteractive);
        updateTerminalShortcuts();
        paintSelectedRunningStatus();
      }

      // 会话区持续可见的「正在执行」状态条。只在聊天视图投影，终端视图不抢位置。
      function paintSelectedRunningStatus() {
        var host = document.getElementById("chat-running-host");
        if (!host) return;
        var selected = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var chatVisible = !!selected && document.getElementById("chat-output") != null
          && !(document.getElementById("chat-output") as HTMLElement).classList.contains("hidden");
        if (!chatVisible) {
          clearRunningStatusBar(host);
          return;
        }
        paintRunningStatusBar(host, selected
          ? { ...selected, ptyRunning: computeRunningSignal(selected).ptyRunning }
          : null);
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

      // 快捷键响应完成后只要求 xterm 刷新可见行，不重放 PTY 字节。
      export function scheduleShortcutResync() {
        if (!state.terminal) return;
        scheduleSoftResyncTerminal(500);
      }

      function sendTerminalShortcut(key: string) {
        var session = getSelectedSession();
        if (!session || isStructuredSession(session) || isNativeInputEmbed()) return;
        if (session.status !== "running") return;
        if (key === "enter") {
          if (state.composerComposing || state.terminalComposing) return;
          // The composer owns pending text/attachments and the separate CR packet.
          var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
          if (state.terminalInteractive || canSendComposer(inputBox ? inputBox.value : "", session.id)) {
            void sendInputFromBox(undefined);
          } else {
            sendTerminalSequence("\r", "enter_text");
          }
          return;
        }
        sendTerminalSequence(buildPtySequence(key, undefined), key);
        scheduleShortcutResync();
      }

      export function updateTerminalShortcuts() {
        var host = document.getElementById("terminal-shortcuts");
        if (!host) return;
        var session = getSelectedSession();
        // Native input shells already own a shortcut row; never duplicate it.
        host.hidden = !session || isStructuredSession(session) || isNativeInputEmbed();
        if (host.hidden) return;
        paintTerminalPanel(host, session.status !== "running", sendTerminalShortcut);
      }

      function enableTerminalCapture() {
        if (state.terminal && state.terminal.element) {
          var helperTextarea = state.terminal.element.querySelector(".xterm-helper-textarea");
          if (helperTextarea) helperTextarea.readOnly = shouldLockNativeInputTerminalIme() ? true : false;
        }
      }

      function disableTerminalCapture() {
        document.removeEventListener("keydown", captureTerminalInput, true);
        if (state.terminal && state.terminal.element) {
          var helperTextarea = state.terminal.element.querySelector(".xterm-helper-textarea");
          if (helperTextarea) helperTextarea.readOnly = true;
        }
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

        var sendPromise = Promise.resolve();
        queue.forEach(function(input) {
          sendPromise = sendPromise.then(function() {
            return sendInputDirect(input).catch(function() {
              // Ignore errors during flush
            });
          });
        });
      }

      function sendInputDirect(input) {
        if (!input || !state.selectedId) return Promise.resolve();
        // 同 postInput：flushPendingMessages 重连后批量回放离线消息时，
        // 用户可能已在切到别的会话，必须用本次请求的 sessionId 快照。
        var requestSessionId = state.selectedId;
        return compactSessionFetch("/api/sessions/" + requestSessionId + "/input", {
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
          compactSessionFetch("/api/sessions/" + id + "/stop", { method: "POST", credentials: "same-origin" })
            .then(function(res) {
              if (!res.ok) throw new Error("无法停止当前回复（HTTP " + res.status + "）。");
              // 停止的结果在原位读：按钮已从「停止」变回「发送」，状态行说明结论。
              flashComposerDone("已停止当前回复。");
              return refreshAll();
            })
            .catch(function(error) {
              flashComposerFailed(getErrorMessage(error, "无法停止当前回复。"));
            });
        });
      }

      export function deleteSession(id) {
        var session = state.sessions.find(function(candidate: any) { return candidate.id === id; });
        var providerSessionId = session && session.claudeSessionId;
        setTimeout(function() {
          compactSessionFetch("/api/sessions/" + id, { method: "DELETE", credentials: "same-origin" })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (data && data.error) {
                throw new Error(data.error);
              }
              composerStore.retain(new Set(state.sessions
                .filter(function(candidate) { return candidate.id !== id; })
                .map(function(candidate) { return candidate.id; })));
              if (state.selectedId === id) {
                clearActivityDetailState();
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
              showActionError("无法删除会话。");
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
              showActionError("无法删除会话。");
            });
        }, 250);
      }

      export function deleteClaudeHistorySession(claudeSessionId, item) {
        executeDeleteHistory(claudeSessionId, item);
      }


      var _resumeInProgress = false;

      function resumeSession(sessionId) {
        if (!sessionId || _resumeInProgress) return Promise.resolve(null);
        _resumeInProgress = true;
        return compactSessionFetch("/api/sessions/" + encodeURIComponent(sessionId) + "/resume", {
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
            showToast(data.error, "error");
            return null;
          }
          return data;
        })
        .catch(function(error) {
          var message = (error && error.message) || "无法恢复会话。";
          showToast(message, "error");
          return null;
        })
        .finally(function() { _resumeInProgress = false; });
      }

      export function activateSession(data) {
        if (!data || !data.id) return Promise.resolve();
        updateSessionSnapshot(data);
        return Promise.resolve(selectSession(data.id));
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

      /** Codex/Claude share one resume endpoint shape; other providers use resumeHistoryFromList. */
      function resumeProviderHistorySession(provider, providerSessionId, cwd) {
        return fetch("/api/" + provider + "-sessions/" + encodeURIComponent(providerSessionId) + "/resume", {
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

      export function resumeCodexHistorySession(threadId, cwd) {
        return resumeProviderHistorySession("codex", threadId, cwd);
      }

      export function resumeClaudeHistorySession(claudeSessionId, cwd) {
        return resumeProviderHistorySession("claude", claudeSessionId, cwd);
      }

      /** DOM-free history resume port used by React shell actions. */
      export function resumeHistoryFromList(provider, providerSessionId, cwd) {
        var request = provider === "codex"
          ? resumeCodexHistorySession(providerSessionId, cwd)
          : provider === "claude"
            ? resumeClaudeHistorySession(providerSessionId, cwd)
            : fetch("/api/" + encodeURIComponent(provider) + "-sessions/" + encodeURIComponent(providerSessionId) + "/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                  mode: state.chatMode || (state.config && state.config.defaultMode) || "default",
                  cwd: cwd
                })
              })
              .then(function(res) { return res.json(); })
              .then(function(data) {
                if (data && data.error) throw new Error(data.error);
                return data;
              });
        return request.then(function(data) {
          if (!data || !data.id) return null;
          if (provider === "codex") {
            state.codexHistory = state.codexHistory.filter(function(s) {
              return s.claudeSessionId !== providerSessionId;
            });
          } else if (provider === "claude") {
            state.claudeHistory = state.claudeHistory.filter(function(s) {
              return s.claudeSessionId !== providerSessionId;
            });
          }
          return activateSession(data).then(function() {
            // Desktop pinned/narrow layouts remain; only overlay drawers close.
            dismissDrawerIfOverlay();
            return data;
          });
        });
      }

      /** Directory view exposes every provider supported by the unified history API. */
      export function deleteExternalHistorySession(provider, providerSessionId) {
        return fetch("/api/" + encodeURIComponent(provider) + "-history/" + encodeURIComponent(providerSessionId), {
          method: "DELETE",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (!data || data.ok !== true) throw new Error((data && data.error) || "无法删除会话。");
            updateSessionsList();
            return data;
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

      function isTouchDevice() {
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

      function updateInputPanelViewportSpacing() {
        // 键盘空间通过 syncAppViewportHeight 让 body 跟随 visualViewport 收缩处理；
        // 这里清掉历史遗留的 --keyboard-offset 避免双重补偿。
        var inputPanel = document.querySelector('.input-panel') as HTMLElement | null;
        if (!inputPanel) return;
        inputPanel.style.removeProperty('--keyboard-offset');
      }


      function restoreInputBoxViewport(inputBox) {
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

      function syncInputBoxLayout(inputBox) {
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
        updateInputPanelViewportSpacing();
        // A non-empty draft must not collapse to the compact one-line state when
        // its wrapped content needs more room. Re-measure immediately and again
        // while Android/iOS keyboard dismissal changes the available width.
        if (blurredEl) autoResizeInput(blurredEl);
        scheduleClosedViewportBaselineWindow(2200, blurredEl);
        // blur 触发瞬间 vv.height 通常还停在键盘弹起时的旧值——iOS 上动画
        // 要再跑 ~250ms 才回弹完整。这里铺一串 settle tick 让 syncAppViewportHeight
        // 在 vv 真正稳定后能把 top/height 收敛到正确值。
        var dismissTicks = [80, 200, 380, 620, 900];
        dismissTicks.forEach(function(delay, idx) {
          setTimeout(function() {
            syncAppViewportHeight(false);
            if (blurredEl && blurredEl.value) autoResizeInput(blurredEl);
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

      function adjustInputBoxSelection(inputBox) {
        if (!inputBox) return;
        inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length);
        restoreInputBoxViewport(inputBox);
      }

      function focusInputWithSelection(inputBox) {
        if (!inputBox) return;
        inputBox.focus({ preventScroll: true });
        adjustInputBoxSelection(inputBox);
      }

      function syncInputBoxForCurrentState(inputBox) {
        bindInputTouchScroll(inputBox);
        syncInputBoxLayout(inputBox);
      }

      export function refreshInputBoxState(inputBox) {
        syncInputBoxForCurrentState(inputBox);
      }

      export function shouldAdjustForKeyboard(vv, inputBox) {
        if (!vv || !inputBox || document.activeElement !== inputBox) return false;
        var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
        if (offsetBottom <= 50) return false;
        var rect = inputBox.getBoundingClientRect();
        return rect.bottom > vv.offsetTop + vv.height - 12;
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

      function focusInputFromTap() {
        if (state.terminalInteractive) {
          focusTerminalContainer();
          return;
        }
        // 触摸设备点击任何区域都不主动聚焦输入框：自动聚焦会唤起系统虚拟键盘，属于
        // 预期外行为——点输出区、点聊天区都不该弹出输入法。
        // 手机端要打字直接点输入框本身。桌面鼠标点击不
        // 唤起键盘，保留原本的「点输出/聊天区聚焦输入框」便利。
        if (isTouchDevice()) return;
        var inputBox = document.getElementById('input-box');
        if (!inputBox || !state.selectedId || document.activeElement === inputBox) return;
        focusInputWithSelection(inputBox);
      }

      function focusTerminalContainer() {
        if (shouldLockNativeInputTerminalIme()) {
          lockNativeInputTerminalIme();
          return;
        }
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
        // 只处理聊天输入框 #input-box：xterm 的 textarea 有
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
          // 输入面板自身（输入框/发送/快捷键行）的点击不收起键盘。
          if (target.closest(".input-panel")) {
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
