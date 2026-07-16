import { state } from "./state";
import { t, iconSvg } from "./i18n";
import { normalizeTerminalOutput, doRenderChat } from "./chat-render";
import { clearStructuredQueuePersistence } from "./chat-scroll";
import { mergeAssistantTurn } from "./message-reconciliation";
import { flushPendingMessages, buildMessagesForRender, isCurrentTerminalSession, updateInputHint, flushStructuredInputQueue, updateStructuredQueueCounter, setTerminalInteractive, flushCrossSessionQueue, reconcileInteractiveState, getSelectedSession, closeKeyboardPopup } from "./input";
import { _vibrate, notifyTaskEnded, clearSessionProgressNative, _syncWakeLock, showNotificationBubble, notifyTaskProgress, syncSessionProgressToNative, notifyPermissionRequest, notifyUpdateAvailable, showAutoUpdateOverlay, showRestartOverlay, showToast } from "./notifications";
import { refreshAll, scheduleSessionListUpdate, subscribeToSession, updateSessionSnapshot, getPreferredMessages, loadSessions, selectSession, updateShellChrome, loadOutput, isAutoApproveImpliedByMode, applyCurrentView } from "./session-engine";
import { getLastAssistantSummary } from "./session-ui";
import { CHAT_RENDER_IDLE_MS, CHAT_RENDER_LIVE_MS, clampClientTerminalOutput, maybeScrollTerminalToBottom, resetTerminal, softResyncTerminal, syncTerminalBuffer, updateTerminalJumpToBottomButton, wandTerminalWrite } from "./terminal";
import { ensureTerminalFitWithRetry, scheduleTerminalResize } from "./viewport";
import { render, restoreLoginSession } from "./render";
import { isBrowserReactShellMounted } from "./shell-runtime";
import { notifyLegacyUiChange } from "./ui-store-bridge";

// ── External functions not defined in this module ──

      export function startPolling() {
        stopPolling();
        // Use WebSocket if available, fallback to polling
        if (initWebSocket()) {
          // WebSocket will deliver updates; no need for initial refreshAll()
          // since the caller (restoreLoginSession) already called refreshAll()
          return;
        }
        // Fallback to HTTP polling
        state.pollTimer = setInterval(refreshAll, 1600);
      }

      // Periodically refresh session time displays (30s)
      setInterval(function() {
        var timeEls = document.querySelectorAll(".session-time");
        if (timeEls.length > 0) scheduleSessionListUpdate();
      }, 30000);

      export function cancelWsReconnect() {
        if (state.wsReconnectTimer) {
          clearTimeout(state.wsReconnectTimer);
          state.wsReconnectTimer = null;
        }
      }

      // Drop any in-flight socket and start a new one *now* — used by the
      // Android resume bridge to recover from zombie connections (socket
      // 客户端 WS 心跳检测：每 10s 跑一次，看 lastWsMessageAt 距今多久。
      // 服务端每 20s 主动下推 {type:"ping"}，所以 40s 没消息就明确是半开。
      // 浏览器在 background 时 setInterval 会被节流到 ~1Hz 或更慢，但
      // 我们也在 visibilitychange→visible 里做了一次主动评估，所以
      // 切回前台时不会拖很久才发现 stale。
      export var WS_HEARTBEAT_CHECK_MS = 10_000;
      export var WS_HEARTBEAT_STALE_MS = 40_000;
      export function startWsHeartbeatCheck() {
        stopWsHeartbeatCheck();
        state.wsHeartbeatCheckTimer = setInterval(evaluateWsHeartbeatStale, WS_HEARTBEAT_CHECK_MS);
      }
      export function stopWsHeartbeatCheck() {
        if (state.wsHeartbeatCheckTimer) {
          clearInterval(state.wsHeartbeatCheckTimer);
          state.wsHeartbeatCheckTimer = null;
        }
      }
      export function evaluateWsHeartbeatStale() {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        // 第一帧（包括 onopen）会刷新 lastWsMessageAt；如果还是 0 说明刚连上
        // 但服务端没下发任何东西（连 init 都没发出来）——交给下一轮检查。
        if (!state.lastWsMessageAt) return;
        var idle = Date.now() - state.lastWsMessageAt;
        if (idle > WS_HEARTBEAT_STALE_MS) {
          forceReconnectWebSocket("heartbeat-stale-" + Math.round(idle / 1000) + "s");
        }
      }

      // Force a fresh WebSocket connection even if the existing one
      // still says OPEN, but the TCP path was torn down by Doze). Skips
      // the backoff timer; the caller has already decided this is urgent.
      export function forceReconnectWebSocket(reason: any) {
        cancelWsReconnect();
        if (state.ws) {
          var stale = state.ws;
          // Detach handlers so the imminent close doesn't trigger another
          // reconnect path while we're already starting a fresh one.
          try { stale.onclose = null; } catch (e) { /* ignore */ }
          try { stale.onerror = null; } catch (e) { /* ignore */ }
          // 也清掉 onmessage：close() 是异步的，TCP RST/Close 帧到达之前，浏览器
          // socket 缓冲区里可能还有几条 in-flight 帧没派发。一旦它们在新 ws 已
          // open + init 之后再触发，老 ws 的 output 会被 handleWebSocketMessage
          // 当成"新增量"写进 wterm，造成"刚才那段又被画了一遍"。stale 心跳触发
          // 的 force reconnect 比 onclose 触发更早，老 ws 仍处于 OPEN，这个窗口
          // 更宽，必须显式 detach。
          try { stale.onmessage = null; } catch (e) { /* ignore */ }
          try { stale.close(); } catch (e) { /* ignore */ }
          state.ws = null;
        }
        state.wsConnected = false;
        state.wsReconnectAttempts = 0;
        initWebSocket(reason);
      }

      export function scheduleWsReconnect() {
        if (state.wsReconnectTimer) return;
        // Don't burn battery reconnecting while hidden — the resume
        // listener will kick a fresh connect when we're foreground.
        if (document.hidden) return;
        var attempt = state.wsReconnectAttempts || 0;
        // 0.5s, 1s, 2s, 4s, then capped at 8s. Faster than the old
        // fixed 2s on the first retry (matters for transient blips)
        // and bounded so a flapping server doesn't get hammered.
        var delays = [500, 1000, 2000, 4000, 8000];
        var delay = delays[attempt < delays.length ? attempt : delays.length - 1];
        state.wsReconnectAttempts = attempt + 1;
        state.wsReconnectTimer = setTimeout(function() {
          state.wsReconnectTimer = null;
          if (state.config && !state.ws && !document.hidden) {
            initWebSocket("backoff");
          }
        }, delay);
      }

      export function initWebSocket(reason?: any) {
        if (!window.WebSocket) return false;

        // Prevent duplicate connections
        if (state.ws) {
          try { state.ws.close(); } catch (e) { /* ignore */ }
          state.ws = null;
        }

        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var wsUrl = protocol + '//' + window.location.host + '/ws';

        try {
          var ws = new WebSocket(wsUrl);

          ws.onopen = function() {
            state.ws = ws;
            state.wsConnected = true;
            state.lastWsMessageAt = Date.now();
            // Reset backoff on a successful connect so the next disconnect
            // starts the ladder from 500ms again.
            state.wsReconnectAttempts = 0;
            cancelWsReconnect();
            // Server's per-client output sequence counter restarts on every
            // new socket; clear ours so the first init isn't treated as a gap.
            state.lastSeqBySession = {};
            // 启动客户端心跳检测：每 10s 检查一次 lastWsMessageAt，超过 40s
            // 没收到任何消息（包括服务端 20s 一次的 ping）就视为半开连接。
            startWsHeartbeatCheck();
            // Subscribe to current session if any
            subscribeToSession(state.selectedId);
            // Flush pending messages after reconnection
            flushPendingMessages();
            // Re-fit terminal on reconnect — the viewport may have changed
            // while disconnected, so remeasure against real container size
            // rather than sending stale cols/rows from before the disconnect.
            // Use the retry variant: when the reconnect is triggered by
            // Android resume, the WebView container may still be 0×0 for
            // the first 1–2 frames while layout settles.
            ensureTerminalFitWithRetry("ws-reconnect");
          };

          ws.onmessage = function(event) {
            // 任意服务端消息都说明连接活着，先刷新心跳计时。
            state.lastWsMessageAt = Date.now();
            try {
              var msg = JSON.parse(event.data);
              // 应用层 ping：立刻回 pong。同时也让服务端能算 RTT。
              // 这条消息处理完就 return，不进入下面的 sessionId 分发流程。
              if (msg && msg.type === "ping") {
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                  try {
                    state.ws.send(JSON.stringify({ type: "pong", t: msg.t }));
                  } catch (sendErr) { /* ignore */ }
                }
                return;
              }
              if (msg && msg.type === "resync_required" && msg.sessionId) {
                // Server dropped some output events under backpressure and
                // is asking us for a fresh snapshot. Send a resync so the
                // server replies with a new init carrying the full output.
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                  try {
                    state.ws.send(JSON.stringify({ type: "resync", sessionId: msg.sessionId }));
                  } catch (sendErr) { /* ignore */ }
                }
                if (!state.lastSeqBySession) state.lastSeqBySession = {};
                state.lastSeqBySession[msg.sessionId] = 0;
                return;
              }
              if (msg && (msg.type === "init" || msg.type === "output") && msg.sessionId && typeof msg.seq === "number") {
                if (!state.lastSeqBySession) state.lastSeqBySession = {};
                var prevSeq = state.lastSeqBySession[msg.sessionId] || 0;
                if (msg.type === "init") {
                  state.lastSeqBySession[msg.sessionId] = msg.seq;
                } else if (msg.seq === prevSeq + 1) {
                  state.lastSeqBySession[msg.sessionId] = msg.seq;
                } else if (msg.seq > prevSeq + 1 && prevSeq > 0) {
                  // We missed at least one event — request a resync and
                  // skip this stale event so we don't apply a partial gap.
                  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    try {
                      state.ws.send(JSON.stringify({ type: "resync", sessionId: msg.sessionId }));
                    } catch (sendErr) { /* ignore */ }
                  }
                  state.lastSeqBySession[msg.sessionId] = 0;
                  return;
                } else {
                  // seq <= prevSeq: duplicate or out-of-order from a stale
                  // queue; drop quietly.
                  if (msg.seq < prevSeq) return;
                  state.lastSeqBySession[msg.sessionId] = msg.seq;
                }
              }
              handleWebSocketMessage(msg);
            } catch (e) {
              // Ignore parse errors
            }
          };

          ws.onclose = function() {
            state.ws = null;
            state.wsConnected = false;
            stopWsHeartbeatCheck();
            scheduleWsReconnect();
          };

          ws.onerror = function() {
            ws.close();
          };

          return true;
        } catch (e) {
          // Constructor threw (rare — bad URL, blocked scheme). Try again
          // through the backoff path so we don't get stuck.
          scheduleWsReconnect();
          return false;
        }
      }

      export function handleWebSocketMessage(msg: any) {
        switch (msg.type) {
          case 'output':
            // For structured sessions, output may be "" during streaming — check messages too.
            // thinking → idle 边界自愈：bridge 把 isResponding 透传过来，true→false 时
            // 主动 softResyncTerminal，洗掉流式渲染残留的错位光标定位序列。
            // 120ms 微延迟 + 单 timer 防抖，避免连续 false→true→false 多次重放。
            if (msg.data && msg.sessionId
                && Object.prototype.hasOwnProperty.call(msg.data, 'isResponding')) {
              if (!state._lastIsResponding) state._lastIsResponding = {};
              state._lastIsResponding[msg.sessionId] = !!msg.data.isResponding;
              // R2 策略 A：移除 isResponding true→false 翻转触发的 softResync。
              // 原本是想在"流式回答结束"瞬间洗掉错位的 cursor 定位残留，但
              // softResync 全量重放在 fresh buffer 上会把 askuserquestion 的多
              // 帧字节顺序堆叠（截图 2 的根因之一）。NEW-A + R6 兜底后不再需要。
            }
            if (msg.data && msg.sessionId) {
              var isIncremental = !!msg.data.incremental;
              var snapshot: any = { id: msg.sessionId };
              var topicMetadataChanged = false;

              // Carry over small metadata fields present in both modes
              if (!isIncremental && msg.data.output !== undefined) {
                snapshot.output = msg.data.output;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'permissionBlocked')) {
                snapshot.permissionBlocked = !!msg.data.permissionBlocked;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'queuedMessages')) {
                snapshot.queuedMessages = msg.data.queuedMessages || [];
                state.queueEpoch++;
              }
              if (msg.data.structuredState) {
                snapshot.structuredState = msg.data.structuredState;
              }
              if (msg.data.sessionKind) {
                snapshot.sessionKind = msg.data.sessionKind;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'title')) {
                snapshot.title = msg.data.title;
                topicMetadataChanged = true;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'description')) {
                snapshot.description = msg.data.description;
                topicMetadataChanged = true;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'summary')) {
                snapshot.summary = msg.data.summary;
              }

              // 优先级修正：若同一事件里同时带 messages（全量）和 lastMessage（增量），
              // 让全量赢。WS 端的 debounce 已经会在跨形状时 flush，但保留这层
              // 客户端兜底，避免任何上游再合并出双载体事件时再次丢消息。
              if (msg.data.messages) {
                // Full mode (authoritative)。窗口化：带上 offset/total，由 updateSessionSnapshot
                // 做窗口合并（保留已加载的更早前缀、空不覆盖非空）。
                snapshot.messages = msg.data.messages;
                if (typeof msg.data.messageOffset === "number") snapshot.messageOffset = msg.data.messageOffset;
                if (typeof msg.data.messageTotal === "number") snapshot.messageTotal = msg.data.messageTotal;
              } else if (isIncremental && msg.data.lastMessage) {
                // Incremental mode: merge lastMessage into existing session messages
                var existingSession = state.sessions.find(function(s: any) { return s.id === msg.sessionId; });
                if (existingSession) {
                  var msgs = Array.isArray(existingSession.messages) ? existingSession.messages.slice() : [];
                  var expectedCount = msg.data.messageCount || 0;
                  // 窗口化：本地是后缀，绝对条数 = messageOffset + msgs.length。
                  var baseOffset = (typeof existingSession.messageOffset === "number") ? existingSession.messageOffset : 0;
                  // 防御性合并：lastMessage 应当至少和本地最后一条一样长。如果服务端
                  // 因为上游 bug（如 upsertBlocks 整段覆盖）回退发来一条更短的同 role
                  // 消息，保留本地版本——文字会被刷新或下一次 emit 修正。
                  var localLast = msgs.length > 0 ? msgs[msgs.length - 1] : null;
                  var incoming = msg.data.lastMessage;
                  if (localLast && incoming.role && localLast.role === incoming.role) {
                    msgs[msgs.length - 1] = mergeAssistantTurn(localLast, incoming);
                  } else if (baseOffset + msgs.length < expectedCount) {
                    msgs.push(incoming);
                  }
                  snapshot.messages = msgs;
                  if (expectedCount > 0) snapshot.messageTotal = expectedCount;
                }
              }

              // Fast path: chunk-only incremental events skip expensive chat update
              var isChunkOnly = isIncremental && msg.data.chunk
                && !msg.data.lastMessage && !snapshot.messages
                && snapshot.output === undefined
                && !msg.data.structuredState && !msg.data.sessionKind;

              if (isChunkOnly) {
                // Only update permissionBlocked if it actually changed
                if (msg.data.permissionBlocked !== undefined) {
                  var existingPB = state.sessions.find(function(s: any) { return s.id === msg.sessionId; });
                  if (existingPB && !!existingPB.permissionBlocked !== !!msg.data.permissionBlocked) {
                    updateSessionSnapshot(snapshot);
                    if (msg.sessionId === state.selectedId) updateTaskDisplay();
                  }
                }
              } else if (snapshot.output !== undefined || snapshot.messages || isIncremental || msg.data.permissionBlocked !== undefined || snapshot.title || snapshot.description) {
                updateSessionSnapshot(snapshot);
                if (topicMetadataChanged) scheduleSessionListUpdate();
                if (msg.sessionId === state.selectedId) {
                  var updatedSession = state.sessions.find(function(s: any) { return s.id === msg.sessionId; }) || snapshot;
                  state.currentMessages = buildMessagesForRender(updatedSession, getPreferredMessages(updatedSession, updatedSession.output, false));
                  updateTaskDisplay();
                  // Structured sessions: render immediately for responsiveness
                  if (updatedSession.sessionKind === 'structured' || msg.data.sessionKind === 'structured') {
                    renderChat();
                  } else {
                    scheduleChatRender();
                  }
                }
              }
            }
            // Real-time terminal output
            if (msg.sessionId === state.selectedId && state.terminal && msg.data) {
              if (msg.data.chunk && isCurrentTerminalSession(msg.sessionId)) {
                // Fast path: write chunk directly to avoid full-output comparison.
                state.lastChunkAt = Date.now();
                state.terminalLiveStreamSessions[msg.sessionId] = true;
                // 不再在 hot-path 调 maybeRefitTerminal/remeasure。它会偷偷把
                // wterm 的 this.cols 改成新值，让 wterm 自己的 ResizeObserver
                // 误判 newCols === this.cols 而跳过 wterm.resize() —— 那条路径
                // 才会真正调 Renderer.setup() 重建 DOM 行。绕过它就让容器尺寸
                // 变化的视觉错位无法被自愈，直到用户手动改窗口才修。现在让
                // wterm 内部 ResizeObserver 独占 cols 跟踪职责。
                wandTerminalWrite(state.terminal, msg.data.chunk);
                // 同 syncTerminalBuffer 的 delta 分支：流式 chunk 不再触发
                // softResyncTerminal，避免完整重放把 cursor-home + 重画的
                // "被覆盖中间帧"反复塞进 scrollback。thinking→idle 兜底就够了。
                state.terminalSessionId = msg.sessionId;
                if (msg.data.output) {
                  // R8: full output replace → marker 失效，重置为 0
                  state.terminalOutput = clampClientTerminalOutput(normalizeTerminalOutput(msg.data.output));
                  state.terminalOutputMarker = 0;
                } else {
                  // append-delta：buffer 延续，marker 保持（clampClientTerminalOutput
                  // 内部已经按裁掉字节数同步缩减 marker）
                  state.terminalOutput = clampClientTerminalOutput((state.terminalOutput || "") + normalizeTerminalOutput(msg.data.chunk));
                }
                maybeScrollTerminalToBottom("output");
                updateTerminalJumpToBottomButton();
              } else if (!msg.data.incremental && Object.prototype.hasOwnProperty.call(msg.data, "output")) {
                // Fallback: no chunk available, use full-output comparison.
                syncTerminalBuffer(msg.sessionId, msg.data.output || "", { mode: "append" });
              }
            }
            break;
          case 'started':
            // New session started
            loadSessions();
            break;
          case 'ended': {
            // Build snapshot from server data; use updateSessionSnapshot so the
            // local update is not lost when loadSessions() later replaces
            // state.sessions entirely.
            var endedStatus = (msg.data && msg.data.status) ? msg.data.status : "exited";
            var endedPermBlocked = (msg.data && Object.prototype.hasOwnProperty.call(msg.data, "permissionBlocked")) ? !!msg.data.permissionBlocked : false;
            var endedSnapshot: any = { id: msg.sessionId, status: endedStatus, permissionBlocked: endedPermBlocked };
            if (msg.data && msg.data.messages) {
              endedSnapshot.messages = msg.data.messages;
              if (typeof msg.data.messageOffset === "number") endedSnapshot.messageOffset = msg.data.messageOffset;
              if (typeof msg.data.messageTotal === "number") endedSnapshot.messageTotal = msg.data.messageTotal;
            }
            if (msg.data && msg.data.structuredState) {
              endedSnapshot.structuredState = msg.data.structuredState;
            }
            if (msg.data && msg.data.queuedMessages) {
              endedSnapshot.queuedMessages = msg.data.queuedMessages;
            }
            updateSessionSnapshot(endedSnapshot);

            if (msg.sessionId === state.selectedId) {
              updateInputHint("Enter 发送 · Shift+Enter 换行");
              // Trigger status bar completion animation
              scheduleChatRender(true);
            }
            // Notify user when a session completes — show what was accomplished
            var endedSession = state.sessions.find(function(s: any) { return s.id === msg.sessionId; });
            var endedExitCode = msg.data && msg.data.exitCode;
            var endedIsError = endedExitCode !== null && endedExitCode !== undefined && endedExitCode !== 0;
            // Build meaningful notification body
            var endedTaskSummary = endedSession ? (endedSession.summary || "") : "";
            var endedLastReply = endedSession ? getLastAssistantSummary(endedSession) : "";
            var endedNotifTitle = endedIsError ? "任务异常结束" : "任务已完成";
            var endedNotifBody = "";
            if (endedTaskSummary) {
              endedNotifBody = endedTaskSummary;
              if (endedLastReply && !endedIsError) {
                endedNotifBody += "\n" + endedLastReply;
              }
            } else {
              endedNotifBody = endedSession ? (endedSession.command || msg.sessionId) : msg.sessionId;
            }
            _vibrate(endedIsError ? "error" : "success");
            notifyTaskEnded(msg.sessionId, endedNotifTitle, endedNotifBody);
            clearSessionProgressNative(msg.sessionId);
            _syncWakeLock();
            if (msg.sessionId !== state.selectedId || document.hidden) {
              showNotificationBubble({
                title: endedNotifTitle,
                body: endedNotifBody,
                type: endedIsError ? "warning" : "success",
                icon: endedIsError ? "!" : "✓",
                duration: 6000,
                actionLabel: "查看",
                action: function() { selectSession(msg.sessionId); }
              });
            }

            // Clear stale queued inputs for PTY sessions.
            // For structured sessions, the queue is now managed by the server snapshot.
            state.messageQueue = [];
            state.pendingMessages = [];

            var endedSessionObj = state.sessions.find(function(s: any) { return s.id === msg.sessionId; });
            var selectedSessionObj = msg.sessionId === state.selectedId
              ? state.sessions.find(function(s: any) { return s.id === state.selectedId; })
              : null;
            var isStructuredEnded = !!(
              (endedSessionObj && endedSessionObj.sessionKind === "structured") ||
              (selectedSessionObj && selectedSessionObj.sessionKind === "structured")
            );

            if (isStructuredEnded && msg.sessionId === state.selectedId) {
              flushStructuredInputQueue();
              // 结构化会话结束时也清 localStorage，防止下次加载恢复僵尸队列
              clearStructuredQueuePersistence(msg.sessionId);
            } else if (!isStructuredEnded) {
              state.structuredInputQueue = [];
              clearStructuredQueuePersistence(state.selectedId);
              updateStructuredQueueCounter();
            }

            // Disable terminal interactive mode immediately so the terminal stops
            // capturing keystrokes before loadSessions() completes.
            if (msg.sessionId === state.selectedId) {
              if (!isStructuredEnded) {
                setTerminalInteractive(false);
              }
              state.currentTask = null;
              updateTaskDisplay();
            }

            // Update UI chrome immediately; loadSessions() will refresh the sessions
            // list asynchronously (which may already be in-flight from a poll tick).
            if (msg.sessionId === state.selectedId) {
              updateShellChrome();
            }

            loadSessions().then(function() {
              // After sessions list is refreshed, try to flush cross-session queue
              flushCrossSessionQueue();
            });
            if (msg.sessionId === state.selectedId) {
              if (!isStructuredEnded) {
                loadOutput(msg.sessionId);
              }
            }
            break;
          }
          case 'init':
            // Initial state for subscribed session (after reconnect or subscription)
            if (msg.sessionId === state.selectedId && msg.data) {
              if (state.chatRenderTimer) { clearTimeout(state.chatRenderTimer); state.chatRenderTimer = null; }
              updateSessionSnapshot(msg.data);
              var initSession = state.sessions.find(function(s: any) { return s.id === msg.sessionId; });
              state.currentMessages = buildMessagesForRender(initSession || msg.data, getPreferredMessages(initSession || msg.data, msg.data.output, false));
              renderChat(true);
              updateTaskDisplay();
              updateApprovalStats();
              // 服务端 ring buffer 在多数场景下是当前已渲染输出的严格 superset
              // （同一 PTY，buffer 只增不减）。这种情况下走 append delta 就够了，
              // 不应该强制 replace。replace 会触发 resetTerminal + 全量重放整段
              // output，wterm 把 ANSI cursor-home 重画的"中间帧"全部塞进
              // scrollback，造成"同一段回答在 PTY 视图里被画 N 遍"——尤其是
              // 锁屏 / 切回前台 / 心跳 stale 触发 reconnect 时，每次 init 都重放
              // 一次，累积重复非常显著。
              //
              // 只有真的不连续（会话切换、ring buffer 截断了头部、output 不是
              // currentOutput 的严格前缀延伸）才回退到 replace 的全量基线。
              var initOutput = msg.data.output || "";
              var sameTerminalSession = state.terminalSessionId === msg.sessionId;
              var currTerminalOutput = state.terminalOutput || "";
              var canAppendDelta = sameTerminalSession
                && currTerminalOutput.length > 0
                && initOutput.length >= currTerminalOutput.length
                && initOutput.startsWith(currTerminalOutput);
              updateTerminalOutput(initOutput, msg.sessionId, canAppendDelta ? "append" : "replace");
              // wterm 启动 cols=120，replace 写入可能落在错的列宽上；ResizeObserver
              // 回调异步，用 fit-with-retry 兜一次确保按真实宽度重排。
              ensureTerminalFitWithRetry("init");
            }
            break;
          case 'usage':
            // Token usage events are processed server-side; per-message usage is read from msg.usage
            break;
          case 'task':
            // Current task update from Claude's tool execution
            if (msg.sessionId === state.selectedId) {
              state.currentTask = msg.data || null;
              updateTaskDisplay();
            }
            notifyTaskProgress(msg.sessionId, msg.data || null);
            syncSessionProgressToNative(msg.sessionId);
            // Update session list to reflect current activity (debounced)
            scheduleSessionListUpdate();
            break;
          case 'status':
            if (msg.sessionId && msg.data) {
              var statusUpdate: any = { id: msg.sessionId };
              if (Object.prototype.hasOwnProperty.call(msg.data, 'status')) {
                statusUpdate.status = msg.data.status;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'exitCode')) {
                statusUpdate.exitCode = msg.data.exitCode;
              }
              if (msg.data.structuredState) {
                statusUpdate.structuredState = msg.data.structuredState;
              } else if (Object.prototype.hasOwnProperty.call(msg.data, 'status')) {
                var existingSession = state.sessions.find(function(s: any) { return s.id === msg.sessionId; });
                if (existingSession && existingSession.sessionKind === 'structured') {
                  statusUpdate.structuredState = Object.assign({}, existingSession.structuredState || {}, {
                    inFlight: msg.data.status === 'running'
                  });
                }
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'queuedMessages')) {
                statusUpdate.queuedMessages = msg.data.queuedMessages || [];
                state.queueEpoch++;
              }
              if (Object.prototype.hasOwnProperty.call(msg.data, 'permissionBlocked')) {
                statusUpdate.permissionBlocked = !!msg.data.permissionBlocked;
              }
              if (msg.data.permissionRequest) {
                statusUpdate.pendingEscalation = {
                  scope: msg.data.permissionRequest.scope,
                  target: msg.data.permissionRequest.target,
                  reason: msg.data.permissionRequest.prompt
                };
                // Browser notification for permission waiting (background tab)
                var permSession = state.sessions.find(function(s: any) { return s.id === msg.sessionId; });
                var permTaskName = permSession ? (permSession.summary || permSession.command || msg.sessionId) : msg.sessionId;
                var permDetail = msg.data.permissionRequest.prompt || "需要权限审批";
                var permTarget = msg.data.permissionRequest.target;
                var permBody = permTaskName;
                if (permTarget) {
                  permBody += "\n" + permDetail + " · " + permTarget;
                } else {
                  permBody += "\n" + permDetail;
                }
                _vibrate("medium");
                notifyPermissionRequest(msg.sessionId, permBody);
                // In-app bubble if not currently viewing this session
                if (msg.sessionId !== state.selectedId) {
                  showNotificationBubble({
                    title: "需要你的授权",
                    body: permBody,
                    type: "warning",
                    icon: "!",
                    duration: 0,
                    actionLabel: "去处理",
                    action: function() {
                      selectSession(msg.sessionId);
                    }
                  });
                }
              }
              if (msg.data.permissionBlocked === false) {
                statusUpdate.pendingEscalation = null;
              }
              if (msg.data.approvalStats) {
                statusUpdate.approvalStats = msg.data.approvalStats;
              }
              updateSessionSnapshot(statusUpdate);
              syncSessionProgressToNative(msg.sessionId);
              _syncWakeLock();
              if (msg.sessionId === state.selectedId) {
                updateTaskDisplay();
                if (msg.data.approvalStats) {
                  updateApprovalStats();
                }
                // Re-render chat when structured session inFlight state changes
                if (statusUpdate.structuredState) {
                  // Flush queued structured messages synchronously before render
                  // so the chat view uses up-to-date queue state.
                  if (!statusUpdate.structuredState.inFlight) {
                    updateInputHint("Enter 发送 · Shift+Enter 换行");
                    flushStructuredInputQueue();
                  }
                  scheduleChatRender();
                }
              }
            }
            break;
          case 'notification':
            if (msg.data) {
              if (msg.data.kind === "update") {
                notifyUpdateAvailable(msg.data.current || "-", msg.data.latest || "-");
              } else if (msg.data.kind === "auto-update-start") {
                showAutoUpdateOverlay(
                  msg.data.current || "-",
                  msg.data.latest || "-",
                  msg.data.previousInstanceId || null,
                );
              } else if (msg.data.kind === "auto-update-restart") {
                showRestartOverlay(msg.data.previousInstanceId || null, msg.data.latest || null);
              } else if (msg.data.kind === "restart") {
                showRestartOverlay();
              }
            }
            break;
        }
      }

      export function updateTaskDisplay() {
        var reactShellActive = isBrowserReactShellMounted();
        var taskEl = document.getElementById("current-task");
        var permissionActionsEl = document.getElementById("permission-actions");
        var permissionLabel = document.getElementById("permission-actions-label");
        if (!taskEl && !reactShellActive) return;
        notifyLegacyUiChange("task:update");
        var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
        if (selectedSession && selectedSession.provider === "codex") {
          if (permissionActionsEl) permissionActionsEl.classList.add("hidden");
          if (!reactShellActive && taskEl) taskEl.classList.remove("permission-blocked");
        }
        var pendingEscalation = selectedSession && selectedSession.pendingEscalation ? selectedSession.pendingEscalation : null;
        var isBlocked = selectedSession && selectedSession.provider !== "codex"
          ? (pendingEscalation || selectedSession.permissionBlocked)
          : false;

        if (isBlocked) {
          var isAutoApprove = selectedSession && selectedSession.autoApprovePermissions;
          // Show permission label in input composer area
          if (permissionLabel) {
            if (isAutoApprove) {
              permissionLabel.textContent = "自动批准中...";
            } else if (pendingEscalation) {
              var reason = pendingEscalation.reason || "等待授权";
              var target = pendingEscalation.target ? " · " + pendingEscalation.target : "";
              permissionLabel.textContent = reason + target;
            } else {
              permissionLabel.textContent = "等待授权";
            }
          }
          if (permissionActionsEl) {
            permissionActionsEl.classList.remove("hidden");
            // Hide approve/deny buttons when auto-approve is active
            var approveBtn = document.getElementById("approve-permission-btn");
            var denyBtn = document.getElementById("deny-permission-btn");
            if (approveBtn) approveBtn.classList.toggle("hidden", !!isAutoApprove);
            if (denyBtn) denyBtn.classList.toggle("hidden", !!isAutoApprove);
          }
          // Hide top task bar — permission info is already shown in the composer
          if (!reactShellActive && taskEl) {
            taskEl.textContent = "";
            taskEl.classList.add("hidden");
            taskEl.classList.remove("permission-blocked");
          }
          return;
        }

        if (!reactShellActive && taskEl) taskEl.classList.remove("permission-blocked");
        if (permissionActionsEl) permissionActionsEl.classList.add("hidden");
        var task = state.currentTask;
        if (!reactShellActive && taskEl && task && task.title) {
          taskEl.textContent = task.title;
          taskEl.classList.remove("hidden");
        } else if (!reactShellActive && taskEl) {
          taskEl.textContent = "";
          taskEl.classList.add("hidden");
        }
      }

      export function updateApprovalStats() {
        var container = document.getElementById("approval-stats");
        if (!container) return;
        var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
        var stats = selectedSession && selectedSession.approvalStats;
        if (!stats || stats.total === 0) {
          container.className = "approval-stats hidden";
          container.innerHTML = "";
          return;
        }
        container.className = "approval-stats";
        container.innerHTML =
          '<span class="approval-stats-divider"></span>' +
          '<span class="approval-stats-badge" id="approval-stats-badge" title="本次会话自动批准统计">' +
            '<svg class="approval-stats-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
            '<span class="approval-stats-total">' + stats.total + '</span>' +
          '</span>' +
          '<span class="approval-stats-popup" id="approval-stats-popup">' +
            '<span class="approval-stats-popup-title">自动批准统计</span>' +
            (stats.command > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("terminal", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">命令执行</span><span class="approval-stats-row-count">' + stats.command + '</span></span>' : '') +
            (stats.file > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("edit", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">文件写入</span><span class="approval-stats-row-count">' + stats.file + '</span></span>' : '') +
            (stats.tool > 0 ? '<span class="approval-stats-row"><span class="approval-stats-row-icon">' + iconSvg("wrench", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">其他工具</span><span class="approval-stats-row-count">' + stats.tool + '</span></span>' : '') +
            '<span class="approval-stats-row approval-stats-row-total"><span class="approval-stats-row-icon">' + iconSvg("sigma", { size: 12, strokeWidth: 1.8 }) + '</span><span class="approval-stats-row-label">合计</span><span class="approval-stats-row-count">' + stats.total + '</span></span>' +
          '</span>';
        // Pulse animation on the badge
        var badge = container.querySelector(".approval-stats-badge");
        if (badge) {
          badge.classList.remove("approval-stats-pulse");
          void (badge as HTMLElement).offsetWidth;
          badge.classList.add("approval-stats-pulse");
        }
      }

      export function approvePermission() {
        _vibrate("light");
        if (!state.selectedId) return;
        var approveBtn = document.getElementById("approve-permission-btn") as HTMLButtonElement | null;
        var denyBtn = document.getElementById("deny-permission-btn") as HTMLButtonElement | null;
        if (approveBtn) approveBtn.disabled = true;
        if (denyBtn) denyBtn.disabled = true;
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/approve-permission", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data: any) {
            if (data && data.error) {
              showToast(data.error, "error");
              return;
            }
            updateSessionSnapshot(data);
            updateTaskDisplay();
          })
          .catch(function(error: any) {
            showToast((error && error.message) || "无法批准授权。", "error");
          })
          .finally(function() {
            if (approveBtn) approveBtn.disabled = false;
            if (denyBtn) denyBtn.disabled = false;
          });
      }

      export function denyPermission() {
        _vibrate("light");
        if (!state.selectedId) return;
        var approveBtn = document.getElementById("approve-permission-btn") as HTMLButtonElement | null;
        var denyBtn = document.getElementById("deny-permission-btn") as HTMLButtonElement | null;
        if (approveBtn) approveBtn.disabled = true;
        if (denyBtn) denyBtn.disabled = true;
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/deny-permission", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data: any) {
            if (data && data.error) {
              showToast(data.error, "error");
              return;
            }
            updateSessionSnapshot(data);
            updateTaskDisplay();
          })
          .catch(function(error: any) {
            showToast((error && error.message) || "无法拒绝授权。", "error");
          })
          .finally(function() {
            if (approveBtn) approveBtn.disabled = false;
            if (denyBtn) denyBtn.disabled = false;
          });
      }

      export function toggleAutoApprove() {
        if (!state.selectedId) return;
        var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
        if (selectedSession && selectedSession.provider === "codex") {
          showToast("Codex 会话固定以 full-access PTY 启动，不支持切换自动批准。", "info");
          return;
        }
        var toggle = document.getElementById("auto-approve-toggle") as HTMLElement | null;
        if (toggle) toggle.style.opacity = "0.5";
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/toggle-auto-approve", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data: any) {
            if (data && data.error) {
              showToast(data.error, "error");
              return;
            }
            updateSessionSnapshot(data);
            updateAutoApproveIndicator();
            var enabled = data.autoApprovePermissions;
            showToast(enabled ? "自动批准已开启" : "自动批准已关闭", "info");
          })
          .catch(function(error: any) {
            showToast((error && error.message) || "无法切换自动批准。", "error");
          })
          .finally(function() {
            if (toggle) toggle.style.opacity = "";
          });
      }

      export function updateAutoApproveIndicator() {
        var toggle = document.getElementById("auto-approve-toggle");
        var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
        // 当模式（managed / full-access）已隐含自动批准，chip 应该不存在；如果上一次渲染留下来了，
        // 在这里清理掉，避免视觉上还有冗余 chip。
        if (isAutoApproveImpliedByMode(selectedSession)) {
          if (toggle && toggle.parentNode) toggle.parentNode.removeChild(toggle);
          return;
        }
        if (!toggle) return;
        var base = "composer-pill composer-pill-chip auto-approve-indicator";
        var enabled = selectedSession && selectedSession.autoApprovePermissions;
        if (enabled) {
          toggle.className = base + " active";
          toggle.title = "自动批准已启用 — 点击关闭";
          toggle.setAttribute("aria-pressed", "true");
          toggle.setAttribute("aria-label", "自动批准已启用，点击关闭");
          toggle.innerHTML = iconSvg("shieldCheck", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">自动</span>';
        } else {
          toggle.className = base;
          toggle.title = "自动批准已关闭 — 点击开启";
          toggle.setAttribute("aria-pressed", "false");
          toggle.setAttribute("aria-label", "自动批准已关闭，点击开启");
          toggle.innerHTML = iconSvg("shield", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">手动</span>';
        }
      }

      export function updateTerminalOutput(output: any, sessionId: any, mode?: any) {
        if (!state.terminal) return false;
        return syncTerminalBuffer(sessionId || state.selectedId, output, { mode: mode || "append" });
      }

      export function stopPolling() {
        if (state.pollTimer) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      }

      export function setView(view: any) {
        state.currentView = view || "terminal";
        if (state.currentView !== "terminal") {
          setTerminalInteractive(false);
          closeKeyboardPopup();
        }
        applyCurrentView();
        reconcileInteractiveState();
        var selectedSession = getSelectedSession();
        if (selectedSession) {
          state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
        }
        updateTerminalJumpToBottomButton();
        if (state.currentView === "terminal") {
          scheduleTerminalResize(true);
          if (state.terminal && state.terminal.remeasure) {
            requestAnimationFrame(function() {
              if (state.terminal) state.terminal.remeasure();
            });
          }
        }
      }

      export function renderChat(forceFullRender?: boolean) {
        if (state.renderPending && !forceFullRender) return;
        state.renderPending = true;

        if (forceFullRender) {
          // Immediate render for page refresh / session switch
          doRenderChat(true);
          state.renderPending = false;
        } else {
          requestAnimationFrame(function() {
            doRenderChat(false);
            state.renderPending = false;
          });
        }
      }

      state.chatRenderTimer = null;
      export function scheduleChatRender(immediate?: boolean) {
        if (state.chatRenderTimer && !immediate) return;
        if (state.chatRenderTimer) clearTimeout(state.chatRenderTimer);
        if (immediate) {
          state.chatRenderTimer = null;
          renderChat();
          return;
        }
        var selectedForDelay = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
        var isActiveStream = selectedForDelay && selectedForDelay.status === "running"
          && selectedForDelay.sessionKind !== "structured";
        // 活跃流时拉到 LIVE 减少高频重渲；空闲时用 IDLE 快速响应。
        var delay = isActiveStream ? CHAT_RENDER_LIVE_MS : CHAT_RENDER_IDLE_MS;
        state.chatRenderTimer = setTimeout(function() {
          state.chatRenderTimer = null;
          var selectedSession = state.sessions.find(function(s: any) { return s.id === state.selectedId; });
          if (selectedSession) {
              state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
          }
          renderChat();
        }, delay);
      }
