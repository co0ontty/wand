import { state } from "./state";
import { ChatRenderCache } from "./chat-render-cache.js";
import { beginChatInteraction, chatViewLease, isChatLeaseCurrent, patchChatContents, patchChatRow, prepareChatOwners, reconcileChatRows, retireChatTurnOwners, scopeChatMarkup } from "./chat-render-focus.js";
import type { ChatOwnerPlan, ChatViewLease } from "./chat-render-focus.js";
import { t, getActiveLang, iconSvg } from "./i18n";
import { escapeHtml, isImagePath, refreshTailMarqueePaths, renderTailMarqueePath } from "./utils";
import { applyPersistedExpandState, bindChatScrollListener, buildExpandKey, clearChatUnread, getMessageKey, getPersistedAgentSelection, getPersistedExpandState, isChatNearBottom, observeLoadMoreSentinel, persistElementExpandState, refreshChatUnreadDivider, setPersistedExpandState, updateChatUnreadBubble } from "./chat-scroll";
import "./file-browser";
import { buildMessagesForRender } from "./input";
import { syncSessionProgressToNative } from "./notifications";
import "./render";
import { copyToClipboard, getPreferredMessages, isRecoverableToolError } from "./session-engine";
import { buildTodoItemsHtml, buildTodoSegmentsHtml, summarizeTodoProgress } from "./todo-progress";
import { renderStructuredStatusBar } from "./utils";
import { getCardDefault } from "./events";
import { CHAT_RENDER_IDLE_MS, CHAT_RENDER_LIVE_MS } from "./terminal";
import { shouldExtractPtySystemInfo } from "./pty-system-info";
import { codexActivityRe, codexFooterRe, isPtyCodexNoiseLine, isPtySystemInfoNoiseLine, isPtyTranscriptNoiseLine } from "./pty-noise";
import { getToolDisplayName, getToolIcon } from "./tool-identity";
import { localFilePreviewHref, localHttpPreviewHref } from "../react/local-preview/controller";
import { catCoatGrid, memberCoatIndex } from "../react/ai-teams/cat-coats";
import { parseJsonResponse } from "../react/http-adapter";
import { commandOccurredAt, currentToolActivity, formatActivityElapsed, groupToolActivities, isToolActivityOnly, latestCommandOccurredAt, toolActivityTimeline, TOOL_ACTIVITY_KINDS } from "./tool-activity";
import { cachedSiliconEmployee, subscribeSiliconEmployeeCache } from "../react/agents/employee-repository.js";
import {
  agentRunAccentSeed,
  agentRunAgentTitle,
  agentRunBlockKey,
  agentRunInLatestWindow,
  agentRunResultRawText,
  agentRunStatusLabelKey,
  collectAgentRuns,
  deriveSubagentMeta,
  flattenAgentRunInline,
  getAgentRunStatusSummary,
  shouldAgentRunStartExpanded,
  truncateInlineText,
} from "./agent-runs";
import "./local-preview-adapter";

// Activity details survive streaming DOM refreshes, but are fetched only after
// the user opens a specific entry. Completed responses share the existing cache.
const activityDetailOpen = new Set<string>();
const activityDetailRequests = new Map<string, Promise<any>>();
const activityRequestLeases = new Map<string, ChatViewLease | null>();
const activityRequestScopes = new Map<string, object | undefined>();
const activityPendingDetails = new Map<string, any>();
const activityResultRefreshRequested = new Set<string>();
let activityDetailEpoch = 0;
let chatOwnerPlan: ChatOwnerPlan | null = null;
const activityGroupAnchors = new Map<string, Array<{ anchor: string; key: string }>>();
let groupsUsedInPaint = new Set<string>();
const activityEntryStates = new Map<string, { lease: ChatViewLease; open: object; request: object | null; error: string | null }>();
const questionSchemas = new Map<string, string>();
const copyBound = new WeakSet<Element>();
let unprovenRowSequence = 0;

function renderMessageKey(message: any, index: number): string {
  return chatOwnerPlan?.messages[index]?.displayKey || getMessageKey(message, index);
}
function renderBlockScope(messageKey: string, index: number, block: any): string {
  const cursor = chatOwnerPlan?.messages[_currentMessageGlobalIndex]?.blockOffset || 0;
  const scope = block?.id ? ["tool", block.id, block.name] : ["source-block", index + cursor, block?.type];
  const questions = block?.semantic?.kind === "question_request" ? block.semantic.questions : block?.input?.questions;
  if (questions) {
    const schema = JSON.stringify(questions);
    const key = JSON.stringify([messageKey, block.id]);
    if (questionSchemas.has(key) && questionSchemas.get(key) !== schema) delete state.askUserSelections[block.id];
    questionSchemas.set(key, schema);
    scope.push(schema);
  }
  return JSON.stringify([messageKey, scope]);
}
function chatRowMarkup(html: string, index: number): string {
  if (!html) return html;
  const owner = chatOwnerPlan?.messages[index]?.key || (typeof HTMLElement !== "undefined"
    ? "view:" + chatViewLease()?.id + ":unproven:" + (++unprovenRowSequence) : null);
  return html.replace(/^<div /, '<div data-msg-index="' + index + '"' +
    (owner ? ' data-chat-owner="' + escapeHtml(owner) + '"' : '') + ' ');
}
function activityGroupKey(items: any[], messageKey: string, segmentFirstIndex: number): string {
  const scopes = items.map(item => renderBlockScope(messageKey, item.index + segmentFirstIndex, item.block));
  const previous = activityGroupAnchors.get(messageKey) || [];
  const continued = previous.find(group => scopes.includes(group.anchor) && !groupsUsedInPaint.has(group.key));
  const group = continued || { anchor: scopes[0], key: JSON.stringify(["activity-group", messageKey, scopes[0]]) };
  groupsUsedInPaint.add(group.key);
  if (!previous.some(candidate => candidate.key === group.key)) activityGroupAnchors.set(messageKey, previous.concat(group));
  return group.key;
}
let activityElapsedTimer: ReturnType<typeof setTimeout> | null = null;

function refreshActivityElapsedLabels(): void {
  const labels = document.querySelectorAll<HTMLElement>(
    ".chat-activity.is-command-running .chat-activity-command-elapsed[data-started-at]",
  );
  for (const label of labels) {
    const startedAt = Date.parse(label.dataset.startedAt || "");
    if (Number.isFinite(startedAt)) {
      label.textContent = "已等待 " + formatActivityElapsed(Date.now() - startedAt);
    }
  }
  if (activityElapsedTimer !== null) clearTimeout(activityElapsedTimer);
  activityElapsedTimer = labels.length > 0
    ? setTimeout(() => {
      activityElapsedTimer = null;
      refreshActivityElapsedLabels();
    }, 1000)
    : null;
}

export function clearActivityDetailState(): void {
  activityDetailEpoch++;
  activityDetailOpen.clear();
  activityDetailRequests.clear();
  activityRequestLeases.clear();
  activityRequestScopes.clear();
  activityPendingDetails.clear();
  activityResultRefreshRequested.clear();
  activityEntryStates.clear();
  activityGroupAnchors.clear();
  questionSchemas.clear();
  if (activityElapsedTimer !== null) clearTimeout(activityElapsedTimer);
  activityElapsedTimer = null;
}



      export function renderChat(forceFullRender?) {
        var sessionId = state.selectedId;
        var epoch = state.chatRenderEpoch || 0;
        var pending = state.chatRenderPendingToken;
        if (state.renderPending && !forceFullRender && pending &&
          pending.sessionId === sessionId && pending.epoch === epoch) return;
        var token = { sessionId: sessionId, epoch: epoch };
        state.chatRenderPendingToken = token;
        state.renderPending = true;
        var release = function() {
          if (state.chatRenderPendingToken === token) {
            state.chatRenderPendingToken = null;
            state.renderPending = false;
          }
        };
        var draw = function() {
          try {
            if (state.chatRenderPendingToken !== token || state.selectedId !== sessionId ||
              (state.chatRenderEpoch || 0) !== epoch) return;
            doRenderChat(!!forceFullRender);
          } catch (error) {
            console.error("[wand] chat render failed:", error);
          } finally {
            // An obsolete callback must not unlock a newer session's frame.
            release();
          }
        };
        if (forceFullRender) draw();
        else {
          try { requestAnimationFrame(draw); }
          catch (error) { release(); console.error("[wand] chat frame scheduling failed:", error); }
        }
      }

      subscribeSiliconEmployeeCache(function() {
        var selected = state.sessions.find(function(session) { return session.id === state.selectedId; });
        if (selected && selected.employeeId) renderChat(true);
      });

      state.chatRenderTimer = null;
      export function scheduleChatRender(immediate?) {
        if (state.chatRenderTimer && !immediate) return;
        if (state.chatRenderTimer) clearTimeout(state.chatRenderTimer);
        if (immediate) {
          state.chatRenderTimer = null;
          renderChat();
          return;
        }
        // 暴露给 chat-scroll 在用户滚动时主动触发一次 render
        // （用来让 applyAutoFoldBar 重新决定是否折叠）。
        try { (window as any).__scheduleChatRender = function() { scheduleChatRender(true); }; } catch (e) {}
        var selectedForDelay = state.sessions.find(function(s) { return s.id === state.selectedId; });
        // PTY chat is a text scrape; structured chat has tool/thinking blocks.
        // Do not synthesize fake tool_use cards on the PTY path.
        var isActiveStream = selectedForDelay && selectedForDelay.status === "running"
          && selectedForDelay.sessionKind !== "structured";
        // 活跃流时拉到 LIVE 减少高频重渲；空闲时用 IDLE 快速响应。
        var delay = isActiveStream ? CHAT_RENDER_LIVE_MS : CHAT_RENDER_IDLE_MS;
        var scheduledSessionId = state.selectedId;
        var scheduledEpoch = state.chatRenderEpoch || 0;
        var timer = setTimeout(function() {
          if (state.chatRenderTimer !== timer) return;
          state.chatRenderTimer = null;
          if (state.selectedId !== scheduledSessionId || (state.chatRenderEpoch || 0) !== scheduledEpoch) return;
          var selectedSession = state.sessions.find(function(s) { return s.id === scheduledSessionId; });
          if (selectedSession) {
              state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
          }
          renderChat();
        }, delay);
        state.chatRenderTimer = timer;
      }
      // Extract system info from PTY output that's not in structured messages
      function extractPtySystemInfo(output, messages) {
        if (!output || !messages || messages.length === 0) return [];
        
        // Strip ANSI escape sequences
        function stripAnsi(text) {
          return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
        }
        
        var clean = stripAnsi(output);
        var systemInfo = [];
        
        // Find user input positions in output
        var userInputs = [];
        for (var i = 0; i < messages.length; i++) {
          if (messages[i].role === 'user') {
            var userText = '';
            var content = messages[i].content;
            if (typeof content === 'string') {
              userText = content;
            } else if (Array.isArray(content)) {
              for (var j = 0; j < content.length; j++) {
                if (content[j].type === 'text') {
                  userText = content[j].text;
                  break;
                }
              }
            }
            if (userText) {
              userInputs.push({ text: userText, index: i });
            }
          }
        }
        
        // Extract content before each user input
        var lastPos = 0;
        for (var i = 0; i < userInputs.length; i++) {
          var userInput = userInputs[i];
          var pos = clean.indexOf('❯ ' + userInput.text, lastPos);
          if (pos === -1) {
            // Try with newline
            pos = clean.indexOf('\n❯ ' + userInput.text, lastPos);
            if (pos !== -1) pos += 1;
          }
          
          if (pos > lastPos) {
            var segment = clean.substring(lastPos, pos);
            // Extract meaningful system info
            var lines = segment.split('\n');
            var infoLines = [];
            for (var j = 0; j < lines.length; j++) {
              var line = lines[j].trim();
              // 分隔线 / 提示符 / banner / 用量行等界面噪声统一走 pty-noise：
              // CLI 文案只在那里维护（本函数只保留“留下有信息量的行”这条规则）。
              if (isPtySystemInfoNoiseLine(line)) continue;

              // Keep meaningful system messages
              if (line.length > 3) {
                infoLines.push(line);
              }
            }
            if (infoLines.length > 0) {
              systemInfo.push({ 
                beforeMessage: userInput.index, 
                content: infoLines.join('\n') 
              });
            }
          }
          lastPos = pos + userInput.text.length + 2; // +2 for '❯ '
        }
        
        return systemInfo;
      }

      export function ensureChatMessagesContainer(chatOutput) {
        if (!chatOutput) return null;
        var chatMessages = chatOutput.querySelector(".chat-messages");
        if (chatMessages) return chatMessages;
        chatMessages = document.createElement("div");
        chatMessages.className = "chat-messages";
        chatOutput.appendChild(chatMessages);
        return chatMessages;
      }

      export function renderChatEmptyState(chatOutput, html) {
        var chatMessages = ensureChatMessagesContainer(chatOutput);
        if (!chatMessages) return null;
        chatMessages.innerHTML = html;
        refreshTailMarqueePaths(chatMessages);
        bindChatScrollListener();
        updateChatUnreadBubble();
        return chatMessages;
      }

function isGroupedChatMessage(messages: any[], index: number): boolean {
  var msg = messages[index];
  var prev = index > 0 ? messages[index - 1] : null;
  if (!prev || prev.role !== msg.role) return false;
  if ((msg.author || prev.author) && !(msg.author && prev.author && msg.author.id === prev.author.id)) return false;
  var currentTime = Date.parse(msg.completedAt || msg.createdAt || "");
  var previousTime = Date.parse(prev.completedAt || prev.createdAt || "");
  return !isNaN(currentTime) && !isNaN(previousTime) && currentTime >= previousTime
    && currentTime - previousTime < 60 * 60_000;
}

function buildRoundUsage(messages: any[]): Record<number, any> {
  var result: Record<number, any> = {};
  var empty = function() { return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalCostUsd: 0, estimated: false }; };
  var acc = empty();
  var hasUsage = false;
  var lastAssistant = -1;
  messages.forEach(function(message, index) {
    if (message.role === "user") {
      if (lastAssistant >= 0 && hasUsage) result[lastAssistant] = acc;
      acc = empty(); hasUsage = false; lastAssistant = -1;
    } else if (message.role === "assistant") {
      lastAssistant = index;
      if (message.usage) {
        hasUsage = true;
        Object.keys(acc).forEach(function(key) {
          if (key === "estimated") acc.estimated = acc.estimated || message.usage.estimated === true;
          else acc[key] += message.usage[key] || 0;
        });
      }
    }
  });
  if (lastAssistant >= 0 && hasUsage) result[lastAssistant] = acc;
  return result;
}

function buildChatRowDependencies(messages: any[], revisions: number[], runs: any,
  roundUsage: Record<number, any>, visibleOffset: number, session: any): any[] {
  // Cross-turn consumers depend on exact source revisions, not the length-based
  // Agent Run signature. A nested result/usage change can repaint an older anchor.
  var results = new Map<string, any[]>();
  messages.forEach(function(message, index) {
    if (!Array.isArray(message.content)) return;
    message.content.forEach(function(block) {
      if (block?.type !== "tool_result" || !block.tool_use_id) return;
      var linked = results.get(block.tool_use_id) || [];
      linked.push([index, revisions[index]]);
      results.set(block.tool_use_id, linked);
    });
  });
  var refSignature = function(ref) {
    return ref ? [ref.messageIndex, ref.blockIndex, revisions[ref.messageIndex],
      ref.block?.id ? results.get(ref.block.id) || [] : []] : null;
  };
  var runRows = new Map<number, any[]>();
  runs.runs.forEach(function(run) {
    var linked = runRows.get(run.messageIndex) || [];
    linked.push({ id: run.id, start: run.startBlockIndex, end: run.endBlockIndex,
      running: _currentSessionRunning, latestUser: _currentLastUserTextMessageIndex,
      agents: run.agents.map(function(agent) {
        return { taskId: agent.taskId, meta: agent.meta, receipt: agent.receipt, runId: agent.runId,
          refs: [agent.dispatch, agent.firstSeen, agent.result].concat(agent.blocks).map(refSignature) };
      }) });
    runRows.set(run.messageIndex, linked);
  });
  var ownedRows = new Map<number, any[]>();
  runs.ownerByBlockKey.forEach(function(owner, key) {
    var index = Number(key.split(":")[0]);
    var owned = ownedRows.get(index) || [];
    owned.push([key, owner]); ownedRows.set(index, owned);
  });
  var visible = messages.slice(visibleOffset);
  return messages.map(function(message, index) {
    var toolResults = Array.isArray(message.content) ? message.content
      .filter(function(block) { return block?.type === "tool_use" && block.id; })
      .map(function(block) { return [block.id, results.get(block.id) || []]; }) : [];
    var commandRunning = _currentActivitySessionBusy && Array.isArray(message.content) &&
      message.content.some(function(block) {
        return block?.type === "tool_use" && block.activity?.kind === "run_command" &&
          block.id === _currentLatestPendingCommandId;
      });
    return { toolResults: toolResults, runs: runRows.get(index) || [], owned: ownedRows.get(index) || [],
      usage: roundUsage[index] || null,
      grouped: index >= visibleOffset && isGroupedChatMessage(visible, index - visibleOffset),
      live: isTurnActivityLive(index), commandRunning: commandRunning,
      lang: getActiveLang(), persona: state.config?.structuredChatPersona,
      defaults: state.config?.cardDefaults,
      employee: [session.employeeId, session.employeeName, session.employeeAvatar],
      interactionOwner: chatOwnerPlan?.messages[index]?.key || null };
  });
}

function captureChatRenderAnchor(container: any, changedIndices: number[]): { index: number; top: number } | null {
  var bounds = container.getBoundingClientRect();
  var changed = new Set(changedIndices);
  var selected: { index: number; top: number; changed: boolean; distance: number } | null = null;
  var elements = container.querySelectorAll(".chat-message:not(.system-info):not(.is-inflight-placeholder)");
  for (var i = 0; i < elements.length; i++) {
    var attribute = elements[i].getAttribute("data-msg-index");
    if (attribute === null) continue;
    var rect = elements[i].getBoundingClientRect();
    // In column-reverse, the first DOM row may be far below the viewport.
    // Prefer an unchanged visible reading row, not a resizing/offscreen tail.
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
    var index = Number(attribute);
    var candidate = { index: index, top: rect.top - bounds.top, changed: changed.has(index),
      distance: Math.max(0, rect.top - bounds.top) };
    if (!selected || Number(candidate.changed) < Number(selected.changed)
      || candidate.changed === selected.changed && candidate.distance < selected.distance) selected = candidate;
  }
  return selected ? { index: selected.index, top: selected.top } : null;
}

      export function doRenderChat(forceFullRender): void {
        var sessionId = state.selectedId;
        var epoch = state.chatRenderEpoch || 0;
        var pendingToken = state.chatRenderPendingToken;
        var root = document.querySelector("#chat-output > .chat-messages") as HTMLElement | null;
        var interaction = root && typeof HTMLElement !== "undefined" ? beginChatInteraction(root) : null;
        try {
          paintChat(forceFullRender);
        } catch (error) {
          // A failed paint may already have mutated part of the DOM. Neither the
          // previous row snapshot nor an old empty-state marker is then reliable.
          // Invalidate only this paint's ownership, and repair on the next update.
          if (state.selectedId === sessionId && (state.chatRenderEpoch || 0) === epoch
            && state.chatRenderPendingToken === pendingToken) {
            state.chatRenderCache?.reset();
            state.lastRenderedEmpty = null;
          }
          throw error;
        } finally {
          interaction?.finish();
        }
      }

      function paintChat(forceFullRender): void {
        var chatOutput = document.getElementById("chat-output");
        if (!chatOutput) return;

        var renderSessionId = state.selectedId;
        var renderEpoch = state.chatRenderEpoch || 0;
        var isCurrentChatPaint = function() {
          return state.selectedId === renderSessionId && (state.chatRenderEpoch || 0) === renderEpoch;
        };
        var selectedSession = state.sessions.find(function(s) { return s.id === renderSessionId; });
        if (!selectedSession) {
          if (state.lastRenderedEmpty !== "none") {
            renderChatEmptyState(chatOutput, '<div class="empty-state"><strong>未选择会话</strong><br>点击上方「新对话」开始你的第一次对话。</div>');
            state.lastRenderedEmpty = "none";
            state.lastRenderedMsgCount = 0;
          }
          state.chatRenderCache?.reset();
          return;
        }

        var allMessages = state.currentMessages;
        var ownerRoot = ensureChatMessagesContainer(chatOutput);
        chatOwnerPlan = typeof HTMLElement !== "undefined" ? prepareChatOwners(selectedSession, allMessages, ownerRoot) : null;
        groupsUsedInPaint = new Set();
        // Agent Run 是聊天渲染的稳定索引：dispatch、子 Agent 轨迹、最终 result
        // 可能分散在多条消息里，不能在单条消息内各自计算一份。
        var agentRunIndex = collectAgentRuns(allMessages);
        var conversationToolResults = buildConversationToolResultMap(allMessages);
        // 状态口径需要这两个事实：会话是否在跑、最后一条真人文本轮在哪。
        _currentLastUserTextMessageIndex = agentRunIndex.lastUserTextMessageIndex;
        _currentSessionRunning = !!(selectedSession.structuredState &&
          selectedSession.structuredState.inFlight && selectedSession.status === "running");
        _currentActivitySessionBusy = selectedSession.status === "running" &&
          (!!selectedSession.structuredState?.inFlight || selectedSession.ptyBusy === true ||
            selectedSession.isResponding === true);
        var currentActivity = currentToolActivity(allMessages,
          _currentLastUserTextMessageIndex, conversationToolResults);
        _currentLatestAssistantMessageIndex = currentActivity.latestAssistantIndex;
        _currentLatestPendingCommandId = currentActivity.pendingCommandId || "";

        if (allMessages.length === 0) {
          if (state.lastRenderedEmpty !== "empty") {
            // 结构化空会话只显示提示。模式/模型/思考在底部 composer 一直可见，
            // 不再在空态里重复渲染同一组下拉，避免同页两处控件让用户不知道点哪个。
            renderChatEmptyState(chatOutput,
              '<div class="empty-state"><strong>对话已开始</strong><br>在下方输入框发送消息，Claude 会自动回复。</div>'
            );
            state.lastRenderedEmpty = "empty";
            state.lastRenderedMsgCount = 0;
          }
          // 空会话进入空状态前，把上一会话残留的状态条 / todo 进度条清掉。
          // 这里是 selectSession 之外的兜底：WS init 等异步路径也会落到这条空分支。
          renderStructuredStatusBar(null, selectedSession);
          updateTodoProgress([]);
          state.chatRenderCache?.reset();
          if (typeof HTMLElement !== "undefined") retireChatTurnOwners();
          return;
        }

        // Lazy loading: only render the most recent chatRenderedCount messages.
        // 新消息进来时永远展开渲染窗口，避免用户正在看的旧消息被挤进"加载更早"里——
        // Telegram 风格下我们不主动挪用户的视线，最稳妥的办法就是别让他看的那条消失。
        var totalMsgCount = allMessages.length;
        if (totalMsgCount > state.chatRenderedCount) {
          state.chatRenderedCount = totalMsgCount;
        }
        var visibleOffset = Math.max(0, totalMsgCount - state.chatRenderedCount);
        // Run 的 dispatch 可能比当前 lazy window 更早，而它的子轨迹 / result
        // 刚好落在窗口内。把锚点一并纳入窗口，避免窗口边界把 Run 从页面里切掉。
        for (var runIndex = 0; runIndex < agentRunIndex.runs.length; runIndex++) {
          var indexedRun = agentRunIndex.runs[runIndex];
          var touchesVisibleWindow = false;
          for (var indexedAgentIndex = 0; indexedAgentIndex < indexedRun.agents.length; indexedAgentIndex++) {
            var indexedAgent = indexedRun.agents[indexedAgentIndex];
            var indexedRefs = [indexedAgent.dispatch, indexedAgent.firstSeen, indexedAgent.result].concat(indexedAgent.blocks);
            for (var indexedRefIndex = 0; indexedRefIndex < indexedRefs.length; indexedRefIndex++) {
              var indexedRef = indexedRefs[indexedRefIndex];
              if (indexedRef && indexedRef.messageIndex >= visibleOffset && indexedRef.messageIndex < totalMsgCount) {
                touchesVisibleWindow = true;
                break;
              }
            }
            if (touchesVisibleWindow) break;
          }
          if (touchesVisibleWindow && indexedRun.messageIndex < visibleOffset) {
            visibleOffset = indexedRun.messageIndex;
          }
        }
        var messages = visibleOffset > 0 ? allMessages.slice(visibleOffset) : allMessages;
        // 窗口化：本地还有没展开的（visibleOffset>0），或服务端还有更早的（messageOffset>0），
        // 都要保留「加载更早」哨兵。后者触底时会从服务端拉下一页。
        var hasServerOlder = (typeof selectedSession.messageOffset === "number" && selectedSession.messageOffset > 0)
          || (typeof selectedSession.leadingBlockOffset === "number" && selectedSession.leadingBlockOffset > 0);
        var hasOlderMessages = visibleOffset > 0 || hasServerOlder;

        var msgCount = messages.length;
        var roundUsageByIndex = buildRoundUsage(allMessages);
        var systemInfo = shouldExtractPtySystemInfo(selectedSession)
          ? extractPtySystemInfo(selectedSession.output, messages) : [];
        var cache = state.chatRenderCache || (state.chatRenderCache = new ChatRenderCache());
        var plan = cache.prepare(selectedSession.id, allMessages, function(revisions) {
          return buildChatRowDependencies(allMessages, revisions, agentRunIndex, roundUsageByIndex,
            visibleOffset, selectedSession);
        }, { visibleOffset: visibleOffset, count: msgCount, hasOlder: hasOlderMessages,
          systemInfo: systemInfo, placeholder: !!selectedSession.inFlight });
        var changedVisibleIndices = plan.changedIndices.filter(function(index) { return index >= visibleOffset; });
        var forceRender = forceFullRender || plan.structureChanged;
        if (!forceRender && changedVisibleIndices.length === 0) {
          var unchangedMessages = chatOutput.querySelector(".chat-messages");
          if (unchangedMessages) renderStructuredStatusBar(unchangedMessages, selectedSession);
          updateTodoProgress(allMessages);
          cache.commit(plan);
          chatOwnerPlan?.commit();
          refreshActivityElapsedLabels();
          return;
        }
        var prevMsgCount = state.lastRenderedMsgCount;
        var chatMessages = ensureChatMessagesContainer(chatOutput);
        if (!chatMessages) return;

        // 在动 DOM 之前先看用户是不是贴在底部——这决定后面我们要不要让视图
        // "继续粘在底部"。column-reverse 下 scrollTop 接近 0 = 视觉底部。
        // 注意：state.chatStickToBottom 的维护**完全交给 scroll handler**
        // （bindChatScrollListener + wheel/touch 提前下台），这里不再做
        // "近底即锁回 true"的自愈，避免 resize / 键盘动画 / 锚点回填瞬间
        // 把已经上滚阅读的用户误判回贴底状态。
        var readingInteraction = typeof HTMLElement !== "undefined" ? beginChatInteraction(chatMessages) : null;
        var renderWasAtBottom = isChatNearBottom(chatMessages) && !readingInteraction?.anchor;
        var renderIsInitial = !state.chatInitialRenderDone;

        // 把 .system-info 卡片从计数里剔除——它由 extractPtySystemInfo 在
        // fullRenderChat 里穿插注入，不存在于 messages 数组中，混进 existingCount
        // 会让 msgCount !== existingCount 永远为真，每帧都走 fullRenderChat，从而
        // 不断 wipe innerHTML，触发"莫名其妙跳到最上面"的视觉错位。
        var existingCount = chatMessages.querySelectorAll(".chat-message:not(.system-info)").length;
        // The semantic structure tracks array/window changes. Agent Run-owned
        // turns may deliberately have no row, so DOM count is not message count.
        var needsFullRender = forceRender || existingCount === 0;
        var renderAnchor = !readingInteraction?.anchor && !renderIsInitial && !renderWasAtBottom && existingCount > 0
          && !(prevMsgCount === 0 && state.chatStickToBottom)
          ? captureChatRenderAnchor(chatMessages, changedVisibleIndices) : null;

        function fullRenderChat() {
          // Build HTML with system info cards interleaved
          var html = '';
          var reversedMessages = messages.slice().reverse();
          var visibleCount = messages.length;

          for (var i = 0; i < reversedMessages.length; i++) {
            var msg = reversedMessages[i];
            var localIndex = visibleCount - 1 - i; // Index within visible slice
            var originalIndex = localIndex + visibleOffset; // Index in full messages array

            var isGrouped = isGroupedChatMessage(messages, localIndex);

            // Find system info for this message position
            var sysInfo = null;
            for (var j = 0; j < systemInfo.length; j++) {
              if (systemInfo[j].beforeMessage === localIndex) {
                sysInfo = systemInfo[j];
                break;
              }
            }

            // Render system info card if exists
            if (sysInfo) {
              html += '<div class="chat-message system-info">' +
                '<div class="system-info-card">' +
                  '<div class="system-info-header">' + iconSvg("info", { size: 13, strokeWidth: 1.8 }) + '<span>系统信息</span></div>' +
                  '<div class="system-info-content">' + escapeHtml(sysInfo.content) + '</div>' +
                '</div>' +
              '</div>';
            }

            // Render message
            var messageHtml = renderChatMessage(
              msg,
              roundUsageByIndex[originalIndex] || null,
              originalIndex,
              agentRunIndex,
              conversationToolResults,
              isGrouped
            );
            if (messageHtml) html += chatRowMarkup(messageHtml, originalIndex);
          }

        // 思考中原位占位行（inFlight 且尾部无内容时原位呼吸）
        if (selectedSession && selectedSession.inFlight && messages.length > 0) {
          var lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && (!lastMsg.content || (Array.isArray(lastMsg.content) && lastMsg.content.length === 0))) {
            // 已有空助手消息，自带 typing-indicator
          } else if (lastMsg && lastMsg.role === "user") {
            // 在消息流尾部原位追加思考占位行
            html = '<div class="chat-message assistant is-inflight-placeholder animate-in" data-role="assistant">' +
              '<div class="chat-message-avatar assistant"><span class="chat-thinking-dot-pulse"></span></div>' +
              '<div class="chat-message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>' +
            '</div>' + html;
          }
        }

        // Add sentinel for loading older messages (DOM end = visual top in column-reverse)
          if (hasOlderMessages) {
            var loadMoreLabel = visibleOffset > 0
              ? ('加载更早的 ' + Math.min(state.chatPageSize, visibleOffset) + ' 条消息')
              : '加载更早的消息';
            html += '<div class="chat-load-more" id="chat-load-more-sentinel">' +
              '<button class="chat-load-more-btn" type="button">' + loadMoreLabel + '</button>' +
            '</div>';
          }

          // 在 innerHTML 整段重写前，先记下当前视口里"最靠近顶部边缘"的那条消息
          // 的 data-msg-index 和它到容器顶部的偏移。重写完成后找到同一 data-msg-index
          // 的新节点，把它放回原来的偏移——这是 column-reverse 下保住用户视线的
          // 标准锚点法。没有锚点时（首次渲染、空 → 非空）才走 scrollTop=0 兜底。
          // 改用 existingCount 而非 prevMsgCount：page-refresh 等 preserveStickState
          // 路径下 prevMsgCount 被重置为 0，但 DOM 里仍有节点可作锚点，必须保住
          // 用户的阅读位置。
          // renderAnchor is restored after all existing collapse/expand helpers.
          if (typeof HTMLElement !== "undefined") reconcileChatRows(chatMessages, html);
          else chatMessages.innerHTML = html; // Synthetic control-flow harness has no DOM tree.
          // 给每条消息打 data-msg-index（用 state.currentMessages 的全局索引），
          // 后面 refreshChatUnreadDivider 用它找未读分割线的位置。
          (function() {
            var msgEls = chatMessages.querySelectorAll(".chat-message:not(.system-info)");
            // column-reverse: DOM[0] = 最新（最高 originalIndex）
            var totalVisible = msgEls.length;
            for (var idx = 0; idx < totalVisible; idx++) {
              if (msgEls[idx].getAttribute("data-msg-index") === null) {
                msgEls[idx].setAttribute("data-msg-index", String(visibleOffset + totalVisible - 1 - idx));
              }
            }
          })();
          refreshTailMarqueePaths(chatMessages);
          // 会话切换 / 首次渲染后，浏览器会把旧的 scrollTop 钳制到新内容
          // 的最大值——column-reverse 下这意味着视觉上跳到最上面（最旧消息），
          // 也就是用户反馈的"退出再回来时被重定向到最上面"。
          // 关键：只在该会话视图的**首次**渲染（chatInitialRenderDone=false）
          // 才执行这个强制贴底；之后即便 prevMsgCount===0（page-refresh /
          // ws 重连等保留 sticky 的 reset 路径），也尊重 chatStickToBottom，
          // 不再把上滚的用户拽回去。
          if (prevMsgCount === 0 && !state.chatInitialRenderDone) {
            chatMessages.scrollTop = 0;
            state.chatStickToBottom = true;
            clearChatUnread({ removeDivider: true });
            state.chatInitialRenderDone = true;
          } else if (prevMsgCount === 0 && state.chatStickToBottom) {
            // 非首次但缓存重置后的 re-render——仅在用户原本贴底时回贴。
            chatMessages.scrollTop = 0;
          } else if (renderWasAtBottom) {
            // 同一会话内的全量重渲染：用户原本贴底就保持贴底，浏览器在 innerHTML
            // 重置后可能把 scrollTop 钳到一个奇怪的值，这里显式拉回 0。
            chatMessages.scrollTop = 0;
          }
          attachAllCopyHandlers(chatMessages);
          bindChatScrollListener();
          applyPersistedExpandState(chatMessages);
          // 不主动 smartScrollToBottom——同一会话的全量重渲染要么是
          // streaming fallback（页面位置应保持），要么是 msgCount 减少（极少见，
          // 走 prevMsgCount===0 那条分支已经处理）。让浏览器自带的 scroll
          // anchoring 接手，避免在用户阅读时把视图拽走。
          requestAnimationFrame(function() {
            if (!isCurrentChatPaint()) return;
            refreshChatUnreadDivider(chatMessages);
            updateChatUnreadBubble();
            observeLoadMoreSentinel();
          });
        }

        if (needsFullRender) {
          fullRenderChat();
        } else {
          // Stage only semantically changed rows (including cross-turn consumers).
          // Count/shape changes already take the full path; the former prepend and
          // count-decrease branches here were unreachable under needsFullRender.
          var replacements = [];
          var needsShapeRepair = false;
          changedVisibleIndices.forEach(function(index) {
            var currentEl = chatMessages.querySelector('.chat-message[data-msg-index="' + index + '"]');
            var wrapper = document.createElement("div");
            wrapper.innerHTML = chatRowMarkup(renderChatMessage(allMessages[index], roundUsageByIndex[index] || null,
              index, agentRunIndex, conversationToolResults,
              isGroupedChatMessage(messages, index - visibleOffset)), index);
            var replacementEl = wrapper.firstElementChild;
            if (!replacementEl) {
              if (currentEl) replacements.push({ current: currentEl, next: null });
              return;
            }
            if (!currentEl) { needsShapeRepair = true; return; }
            replacementEl.setAttribute("data-msg-index", String(index));
            replacements.push({ current: currentEl, next: replacementEl });
          });
          if (needsShapeRepair) {
            fullRenderChat();
          } else if (replacements.length) {
            replacements.forEach(function(replacement) {
              if (replacement.next) {
                var painted = replacement.next;
                if (typeof HTMLElement !== "undefined" && replacement.current.getAttribute("data-chat-owner") &&
                  replacement.current.getAttribute("data-chat-owner") === replacement.next.getAttribute("data-chat-owner")) {
                  painted = patchChatRow(replacement.current, replacement.next);
                } else chatMessages.replaceChild(replacement.next, replacement.current);
                attachCopyHandler(painted);
              } else replacement.current.remove();
            });
            bindChatScrollListener();
            applyPersistedExpandState(chatMessages);
            requestAnimationFrame(function() {
              if (!isCurrentChatPaint()) return;
              if (renderWasAtBottom && chatMessages.isConnected && Math.abs(chatMessages.scrollTop) > 1) {
                state.chatIsProgrammaticScroll = true;
                chatMessages.scrollTop = 0;
                requestAnimationFrame(function() {
                  if (isCurrentChatPaint()) state.chatIsProgrammaticScroll = false;
                });
              }
              refreshChatUnreadDivider(chatMessages);
              updateChatUnreadBubble();
            });
          }
        }

        // 发新消息后把"最后一条用户消息"之前的历史折叠成摘要卡（后处理，不动上面的 DOM diff）。
        applyHistoryCollapse(chatMessages, selectedSession);

        // 旧版会在顶部固定最新一轮预览；现在每次渲染都清掉该横条。
        applyAutoFoldBar(chatOutput, chatMessages, allMessages, renderIsInitial);

        // Update structured session status bar (in-flight / completed indicator)
        renderStructuredStatusBar(chatMessages, selectedSession);

        // Commit only after every rendering/post-processing stage succeeds.
        updateTodoProgress(allMessages);
        if (renderAnchor) {
          var anchor = chatMessages.querySelector('.chat-message[data-msg-index="' + renderAnchor.index + '"]');
          if (anchor) {
            var delta = anchor.getBoundingClientRect().top - chatMessages.getBoundingClientRect().top - renderAnchor.top;
            if (Math.abs(delta) > 0.5) {
              state.chatIsProgrammaticScroll = true;
              chatMessages.scrollTop += delta;
              requestAnimationFrame(function() {
                if (isCurrentChatPaint()) state.chatIsProgrammaticScroll = false;
              });
            }
          }
        }
        if (readingInteraction?.anchor && readingInteraction.current() && readingInteraction.anchor.node.isConnected) {
          var focusDelta = readingInteraction.anchor.node.getBoundingClientRect().top -
            chatMessages.getBoundingClientRect().top - readingInteraction.anchor.top;
          if (Math.abs(focusDelta) > 0.5) chatMessages.scrollTop += focusDelta;
        }
        cache.commit(plan);
        chatOwnerPlan?.commit();
        state.lastRenderedMsgCount = msgCount;
        state.lastRenderedEmpty = null;
        refreshActivityElapsedLabels();
      }

      // 注：旧版的 smartScrollToBottom / chatAutoFollow / chat-follow-toggle 都已经
      // 拆掉，改成 Telegram 风格：贴底状态完全由用户的滚动行为驱动，未读靠
      // chat-unread-bubble 气泡提示，不再主动滚动用户的视图。
      // 相关入口：scrollChatToBottom（用户点气泡时强制贴底）、
      // refreshChatUnreadDivider（分割线渲染）、updateChatUnreadBubble（气泡 UI）。

      // --- Todo progress bar ---
      // 展开态的真值只在 DOM 上（#todo-progress-body 的 .expanded），不再另存一份
      // 闭包变量：input.ts / session-engine.ts 在切会话、发新消息时会直接清这个 class，
      // 两份状态一飘就会出现「点一下没反应，要点两下才展开」。
      function isTodoExpanded() {
        var body = document.getElementById("todo-progress-body");
        return !!body && body.classList.contains("expanded");
      }

      // 展开/收起待办面板的唯一入口：aria、class、chat 底部 padding 一次改完。
      function setTodoExpanded(expanded, focusToggle?) {
        var next = !!expanded;
        var prog = document.getElementById("todo-progress");
        var body = document.getElementById("todo-progress-body");
        var toggle = document.getElementById("todo-progress-toggle");
        if (prog) prog.classList.toggle("expanded", next);
        if (body) body.classList.toggle("expanded", next);
        if (toggle) {
          toggle.setAttribute("aria-expanded", next ? "true" : "false");
          toggle.setAttribute("aria-label", next ? "收起待办列表" : "展开待办列表");
        }
        // body 展开/收起后视觉高度变了，触发一次 padding 同步
        syncChatMessagesPaddingForTodoBody();
        if (focusToggle && toggle) toggle.focus();
      }

      // Use event delegation for todo toggle (more robust than binding to specific element)
      document.addEventListener("click", function(e) {
        var target = e.target;
        if (!target || !(target instanceof Element)) return;
        var toggle = target.closest("#todo-progress-toggle");
        if (!toggle) return;
        e.preventDefault();
        e.stopPropagation();
        setTodoExpanded(!isTodoExpanded());
      });

      // 收起的兜底路径。之前只能再点一次那条，面板展开后会一直挂在聊天上方；
      // 点外部收起对移动端尤其重要（手机上没有 Esc）。
      document.addEventListener("pointerdown", function(e) {
        if (!isTodoExpanded()) return;
        var target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest("#todo-progress-body") || target.closest("#todo-progress-toggle")) return;
        setTodoExpanded(false);
      });
      document.addEventListener("keydown", function(e) {
        if (!isTodoExpanded() || e.key !== "Escape") return;
        e.stopPropagation();
        setTodoExpanded(false, true);
      });

      // 同步 .chat-messages 的 padding-bottom 与 .todo-progress-body 的实际高度。
      // 背景：body 是 position: absolute 浮在 composer 上方，max-height 320px，会盖住
      // .chat-messages 底部一大块；column-reverse 下新消息永远 prepend 到 DOM 第一个
      // （也就是视觉底部），结果就是被 body 完全遮住、只在上沿露个头。给 chat-messages
      // 动态加一段等于 body 高度的 padding-bottom，最新一条消息就会浮在 body 正上方，
      // 不再渲染在 body 覆盖区。body 收起/隐藏时还原回 CSS 默认的 12px。
      //
      // 每次都用 ResizeObserver 跟住当前的 body 节点：列表条数变化、长文本换行、
      // 面板被整块重渲染（节点被替换）都会改高度，靠调用点手动补刀总会漏掉一路。
      var todoBodyObserver = null;
      var todoBodyObserved = null;
      function ensureTodoBodyObserver(todoBody) {
        if (typeof ResizeObserver !== "function") return;
        if (todoBodyObserved === todoBody && todoBodyObserver) return;
        if (todoBodyObserver) todoBodyObserver.disconnect();
        todoBodyObserved = todoBody;
        todoBodyObserver = new ResizeObserver(function() {
          syncChatMessagesPaddingForTodoBody();
        });
        todoBodyObserver.observe(todoBody);
      }

      function syncChatMessagesPaddingForTodoBody() {
        var chatMessages = document.querySelector("#chat-output .chat-messages");
        var todoBody = document.getElementById("todo-progress-body");
        if (!chatMessages || !todoBody) return;
        ensureTodoBodyObserver(todoBody);
        // querySelector 返回 Element，但 .style 是 HTMLElement 上的；这里强转。
        var chatMessagesEl = chatMessages as HTMLElement;
        var isVisible = !todoBody.classList.contains("hidden");
        var isExpanded = todoBody.classList.contains("expanded");
        var bodyHeight = todoBody.offsetHeight;
        if (isVisible && isExpanded && bodyHeight > 0) {
          // 8px 是与 body 上方那 6px 间距对应的视觉缓冲，避免最新一条贴脸 body。
          chatMessagesEl.style.paddingBottom = (bodyHeight + 8) + "px";
        } else {
          // 清掉内联样式，回到 .chat-messages CSS 默认的 padding: 20px 4px 12px
          chatMessagesEl.style.paddingBottom = "";
        }
      }

      // 把一个 tool_result 的 content 拍平成纯字符串（可能是 string，也可能是
      // [{type:"text",text}] 数组）。TaskCreate 的结果文本形如
      // "Task #1 created successfully: 检查工作目录"，需要从中抠出任务 id。
      function flattenToolResultContent(content) {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          var parts = [];
          for (var i = 0; i < content.length; i++) {
            var piece = content[i];
            if (typeof piece === "string") parts.push(piece);
            else if (piece && typeof piece.text === "string") parts.push(piece.text);
          }
          return parts.join("");
        }
        return "";
      }

      // 从本 turn 的 TaskCreate / TaskUpdate 增量调用还原出 TodoWrite 形态的列表。
      // 返回 null 表示这个 turn 根本没用 Task* 工具（让上层维持旧行为/隐藏进度条）。
      function reconstructTodosFromTaskTools(messages, startIdx) {
        // 先按 tool_use_id 收集所有 tool_result 文本——TaskCreate 分配的任务 id
        // 只在结果文本里（"Task #N created successfully: …"），input 里没有。
        var resultById = {};
        for (var i = startIdx; i < messages.length; i++) {
          var msg = messages[i];
          if (!msg || !Array.isArray(msg.content)) continue;
          for (var j = 0; j < msg.content.length; j++) {
            var b = msg.content[j];
            if (b && b.type === "tool_result" && b.tool_use_id) {
              resultById[b.tool_use_id] = flattenToolResultContent(b.content);
            }
          }
        }

        // 再按调用顺序重放 TaskCreate（新建）/ TaskUpdate（改状态/标题），
        // 用 order 记录首次出现顺序以保持列表稳定排序。
        var taskMap = {};
        var order = 0;
        var createFallback = 0;
        var sawTaskTool = false;
        for (var m = startIdx; m < messages.length; m++) {
          var msg2 = messages[m];
          if (!msg2 || !Array.isArray(msg2.content)) continue;
          for (var k = 0; k < msg2.content.length; k++) {
            var blk = msg2.content[k];
            if (!blk || blk.type !== "tool_use") continue;
            var input = blk.input || {};
            if (blk.name === "TaskCreate") {
              sawTaskTool = true;
              createFallback++;
              var res = resultById[blk.id] || "";
              var match = res.match(/#(\d+)/);
              var cid = match ? match[1] : String(createFallback);
              taskMap[cid] = {
                id: cid,
                content: input.subject || "",
                activeForm: input.activeForm || "",
                status: "pending",
                order: order++,
              };
            } else if (blk.name === "TaskUpdate") {
              sawTaskTool = true;
              var uid = String(input.taskId);
              var task = taskMap[uid];
              if (!task) {
                task = { id: uid, content: "", activeForm: "", status: "pending", order: order++ };
                taskMap[uid] = task;
              }
              if (input.status) task.status = input.status;
              if (input.subject) task.content = input.subject;
              if (input.activeForm) task.activeForm = input.activeForm;
            }
          }
        }

        if (!sawTaskTool) return null;

        var list = [];
        for (var key in taskMap) {
          if (!Object.prototype.hasOwnProperty.call(taskMap, key)) continue;
          if (taskMap[key].status === "deleted") continue;
          list.push(taskMap[key]);
        }
        list.sort(function(a, b) { return a.order - b.order; });
        return list.length ? list : null;
      }

      function updateTodoProgress(messages) {
        // 只看"当前 turn"里的 TodoWrite——即最后一条 user 消息之后的那段。
        // 不限制范围的话，上一轮留下的进度条会在新一轮（哪怕新一轮根本没用
        // TodoWrite）里阴魂不散地重现。
        var startIdx = 0;
        for (var ui = messages.length - 1; ui >= 0; ui--) {
          if (messages[ui] && messages[ui].role === "user") {
            startIdx = ui + 1;
            break;
          }
        }

        var todos = null;
        for (var i = messages.length - 1; i >= startIdx; i--) {
          var msg = messages[i];
          if (!msg.content || !Array.isArray(msg.content)) continue;
          for (var j = msg.content.length - 1; j >= 0; j--) {
            var block = msg.content[j];
            if (block.type === "tool_use" && block.semantic && block.semantic.kind === "task_list") {
              todos = block.semantic.items;
              break;
            }
            if (block.type === "tool_use" && block.name === "TodoWrite" && block.input && block.input.todos) {
              todos = block.input.todos;
              break;
            }
          }
          if (todos) break;
        }

        // 新版 Claude Code 把 TodoWrite 换成了 TaskCreate / TaskUpdate / TaskList
        // 这套增量式任务工具（TodoWrite 一次给全量快照，Task* 是一条条增量）。
        // 没扫到 TodoWrite 时，从本 turn 的 TaskCreate/TaskUpdate 还原出等价的
        // todos 列表（{content, activeForm, status}），让进度条对两种工具都生效。
        if (!todos) {
          todos = reconstructTodosFromTaskTools(messages, startIdx);
        }

        var container = document.getElementById("todo-progress");
        var bodyEl = document.getElementById("todo-progress-body");
        if (!container) return;

        if (!todos || todos.length === 0) {
          container.classList.add("hidden");
          if (bodyEl) bodyEl.classList.add("hidden");
          // 收起态是闭包状态，隐藏时必须一起复位；否则下一次这个条重新出现
          // 会带着上一轮的 expanded class，面板无人操作就自己弹开。
          if (isTodoExpanded()) setTodoExpanded(false);
          // body 隐藏（无 todo）→ 还原 chat 底部 padding
          syncChatMessagesPaddingForTodoBody();
          return;
        }

        // 统计（完成数 / 当前任务文案）与 class、图标映射都收在 todo-progress.ts
        // 里——那边是纯函数，有单测兜着；这里只负责把结果写进 DOM。
        var summary = summarizeTodoProgress(todos);
        var completed = summary.completed;
        var allDone = summary.allDone;

        // 当会话不再活跃时（status !== "running"，即 turn 已结束、会话 idle/exited/
        // archived），隐藏进度条。解决两个问题：
        //   1. 模型经常忘了发最后一条全 completed 的 TodoWrite，让用户对着 2/4
        //      干瞪眼——会话结束后直接收起，不展示过期数据。
        //   2. 旧方案用 inFlight=false 判定 turn 结束，结构化模式下 inFlight 在
        //      流式间隙短暂置假导致进度条闪烁。改用 session.status（仅在 turn 真正
        //      结束时从 "running" 变 "idle"）判断，避免闪烁。
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var sessionActive = !!selectedSession && selectedSession.status === "running";
        if (!sessionActive || allDone) {
          container.classList.add("hidden");
          if (bodyEl) bodyEl.classList.add("hidden");
          if (isTodoExpanded()) setTodoExpanded(false);
          // turn 结束 / 全部 done，body 不再展示 → 还原 chat 底部 padding
          syncChatMessagesPaddingForTodoBody();
          return;
        }

        container.classList.remove("hidden");
        if (bodyEl) bodyEl.classList.remove("hidden");

        // 计数器直接展示"已完成 / 总数"，与展开列表的 ✓ 勾选一致。
        // 旧方案用 completed+1 试图表达"正在干第 N 个"，但列表只有 completed 个
        // 勾，造成计数器和列表不匹配（如计数器 3/4、列表只 2 个 ✓）。
        // 面板头部那个计数与收起态保持同一口径。
        var countText = completed + " / " + summary.total;
        var counter = document.getElementById("todo-progress-counter");
        if (counter) counter.textContent = countText;
        var panelCount = document.getElementById("todo-progress-panel-count");
        if (panelCount) panelCount.textContent = countText;

        // 右侧任务描述：优先取首个 in_progress 的 activeForm / content；
        // 没有任何进行中项时回退到下一条 pending（逻辑在 summarizeTodoProgress）。
        var task = document.getElementById("todo-progress-task");
        if (task) task.textContent = summary.activeTask || "准备中…";

        // 进度环与底部通栏进度轨共用同一比例。
        var progress = summary.ratio.toFixed(3);
        var ring = document.getElementById("todo-progress-ring");
        if (ring) ring.style.setProperty("--progress", progress);
        var fill = document.getElementById("todo-progress-fill");
        if (fill) fill.style.setProperty("--progress", progress);

        var segments = document.getElementById("todo-progress-segments");
        if (segments) segments.innerHTML = buildTodoSegmentsHtml(todos);

        var list = document.getElementById("todo-progress-list");
        if (list) list.innerHTML = buildTodoItemsHtml(todos);

        // Sync todo progress to native notification
        if (state.selectedId) {
          syncSessionProgressToNative(state.selectedId);
        }
        // 列表条数/状态变了（item 高度变化），同步一次 chat 底部 padding
        syncChatMessagesPaddingForTodoBody();
      }

      function attachCopyHandler(el) {
        el.querySelectorAll(".code-copy").forEach(function(btn) {
          if (copyBound.has(btn)) return;
          copyBound.add(btn);
          btn.addEventListener("click", function() {
            var codeBlock = btn.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              copyToClipboard(code.textContent || "", null, function() {
                btn.textContent = "已复制";
                btn.classList.add("copied");
                setTimeout(function() { btn.textContent = "复制"; btn.classList.remove("copied"); }, 2000);
              });
            }
          });
        });
      }

      function attachAllCopyHandlers(container) {
        attachCopyHandler(container);
        attachMessageCopyButtons(container);
      }

      function attachMessageCopyButtons(container) {
        var isTouch = window.matchMedia("(pointer: coarse)").matches;
        if (!isTouch) return;
        container.querySelectorAll(".chat-message").forEach(function(msgEl) {
          if (msgEl.querySelector(".msg-copy-btn")) return; // already attached
          var bubble = msgEl.querySelector(".chat-message-bubble");
          if (!bubble) return;
          var btn = document.createElement("button");
          btn.className = "msg-copy-btn";
          btn.textContent = "复制";
          btn.addEventListener("click", function(e) {
            e.stopPropagation();
            var text = bubble.innerText || bubble.textContent || "";
            copyToClipboard(text.trim(), null, function() {
              btn.textContent = "已复制";
              btn.classList.add("copied");
              setTimeout(function() {
                btn.textContent = "复制";
                btn.classList.remove("copied");
                btn.classList.remove("visible");
                // 自动隐藏后引用也必须失效：否则下一次点击还是会走进
                // closest() 分支（虽然已不再扫 DOM，但会指向一个已隐藏的按钮）。
                if (visibleCopyButton === btn) visibleCopyButton = null;
              }, 1500);
            });
          });
          msgEl.appendChild(btn);
        });
      }

      // 当前可见的复制按钮（同一时刻最多一个）：按引用隐藏，点击外部时不再扫 DOM。
      // 声明在模块作用域，是因为复制成功后的 1500ms 自动隐藏也要清掉引用（见上）。
      var visibleCopyButton: Element | null = null;

      // Long-press to show copy button on chat messages
      (function initMobileCopyLongPress() {
        var isTouch = window.matchMedia("(pointer: coarse)").matches;
        if (!isTouch) return;

        var longPressTimer = null;
        var touchStartY = 0;

        document.addEventListener("touchstart", function(e) {
          var msgEl = (e.target as HTMLElement).closest(".chat-message");
          if (!msgEl) return;
          var bubble = msgEl.querySelector(".chat-message-bubble");
          if (!bubble) return;
          touchStartY = e.touches[0].clientY;
          longPressTimer = setTimeout(function() {
            var btn = msgEl.querySelector(".msg-copy-btn");
            if (!btn) return;
            if (visibleCopyButton && visibleCopyButton !== btn) visibleCopyButton.classList.remove("visible");
            visibleCopyButton = btn;
            btn.classList.add("visible");
          }, 500);
        }, { passive: true });

        document.addEventListener("touchmove", function(e) {
          if (longPressTimer && Math.abs(e.touches[0].clientY - touchStartY) > 10) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        }, { passive: true });

        document.addEventListener("touchend", function() {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        }, { passive: true });

        // Dismiss copy buttons when tapping elsewhere
        document.addEventListener("click", function(e) {
          if (!visibleCopyButton) return;
          if ((e.target as HTMLElement).closest(".msg-copy-btn")) return;
          visibleCopyButton.classList.remove("visible");
          visibleCopyButton = null;
        });
      })();

      // ===== Terminal copy button for mobile =====

      function stripAnsi(text) {
        return String(text || "")
          .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
          .replace(/\x1b\[(\d+)C/g, function(_match, count) { return " ".repeat(Number(count) || 1); })
          .replace(/\x1b\[[0-9;?]*[AB]/g, "\n")
          .replace(/\x1b\[[0-9;?]*[su]/g, "")
          .replace(/\x1b\[[0-9;?]*[HfJKr]/g, "\n")
          .replace(/\x1bM/g, "\n")
          .replace(/\x1b\[[0-9;?]*[ST]/g, "\n")
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
          .replace(/\x1b[><=ePX^_]/g, "")
          .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n");
      }

      export function parseMessages(output, command) {
        var messages = [];
        if (!output) return messages;

        var text = String(output || "");
        var newline = String.fromCharCode(10);
        var carriageReturn = String.fromCharCode(13);
        var esc = String.fromCharCode(27);

        if (/^codex\b/.test(String(command || "").trim())) {
          function stripCodexSegment(raw) {
            return String(raw || "")
              .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
              .replace(/\x1b\[(\d+)C/g, function(_match, count) { return " ".repeat(Number(count) || 1); })
              .replace(/\x1b\[[0-9;?]*[AB]/g, newline)
              .replace(/\x1b\[[0-9;?]*[su]/g, "")
              .replace(/\x1b\[[0-9;?]*[HfJKr]/g, newline)
              .replace(/\x1bM/g, newline)
              .replace(/\x1b\[[0-9;?]*[ST]/g, newline)
              .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
              .replace(/\x1b[><=ePX^_]/g, "")
              .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
              .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
              .replace(/[ \t]+\n/g, newline);
          }

          function normalizeCodexText(value) {
            return String(value || "")
              .replace(/\s+/g, " ")
              .replace(/[M]+$/g, "")
              .trim();
          }

          function normalizeCodexPromptLine(line) {
            return String(line || "")
              .replace(/^›\s*/, "")
              .replace(/^>\s*/, "")
              .trim();
          }

          function extractCodexPromptCandidate(line) {
            var trimmed = String(line || "").trim();
            if (!/^›(?:\s|$)/.test(trimmed)) return null;
            if (codexFooterRe.test(trimmed)) return null;
            var prompt = normalizeCodexText(normalizeCodexPromptLine(trimmed));
            if (!prompt || isPtyCodexNoiseLine(prompt)) return null;
            return prompt;
          }

          function extractCodexAssistantCandidate(line) {
            var trimmed = String(line || "").trim();
            if (!/^[•◦·⏺]/.test(trimmed)) return null;

            var assistant = trimmed
              .replace(/^[•◦·]\s*/, "")
              .replace(/^⏺\s+/, "")
              .replace(/^│\s*/, "")
              .trim();
            if (!assistant || /^[•◦·⏺]$/.test(assistant)) return null;

            assistant = assistant
              .replace(/\s*\(\d+[smh]?\s*•\s*esc to interrupt\)[\s\S]*$/i, "")
              .replace(/(?:[a-z]{1,6})?›[\s\S]*$/, "")
              .replace(/\s{2,}gpt-\d[\s\S]*$/i, "")
              .replace(/\b(?:OpenAI Codex|model:|directory:|Tip:)\b[\s\S]*$/i, "");
            assistant = normalizeCodexText(assistant);

            if (!assistant || assistant.length < 2 || codexActivityRe.test(assistant) || isPtyCodexNoiseLine(assistant)) {
              return null;
            }
            return assistant;
          }

          function extractCodexEchoCandidate(line) {
            var trimmed = normalizeCodexText(line);
            if (!trimmed || isPtyCodexNoiseLine(trimmed)) return null;
            if (/^[•◦·⏺›]/.test(trimmed)) return null;
            if (/^[\[\]<>0-9;?]+u?$/i.test(trimmed)) return null;
            if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return null;
            if (trimmed.length > 500) return null;
            return trimmed;
          }

          function isLikelyAssistantTailArtifact(longer, shorter) {
            if (longer.indexOf(shorter) !== 0) return false;
            var suffix = longer.slice(shorter.length);
            return /^[a-z]{1,4}$/i.test(suffix);
          }

          function coalesceAssistantLines(lines) {
            var collected = [];
            for (var i = 0; i < lines.length; i++) {
              var normalized = normalizeCodexText(lines[i]);
              if (!normalized || normalized.length < 2 || isPtyCodexNoiseLine(normalized)) continue;

              var previous = collected[collected.length - 1];
              if (!previous) {
                collected.push(normalized);
                continue;
              }
              if (normalized === previous) continue;
              if (normalized.indexOf(previous) === 0) {
                collected[collected.length - 1] = normalized;
                continue;
              }
              if (previous.indexOf(normalized) === 0) {
                if (isLikelyAssistantTailArtifact(previous, normalized)) {
                  collected[collected.length - 1] = normalized;
                }
                continue;
              }
              collected.push(normalized);
            }
            return collected.join(newline).trim();
          }

          function extractVisiblePrompt(lines) {
            for (var i = 0; i < lines.length; i++) {
              var line = String(lines[i] || "").trim();
              if (!line) continue;

              var inlinePrompt = extractCodexPromptCandidate(line);
              if (inlinePrompt) return inlinePrompt;

              if (line === "›") {
                for (var j = i + 1; j < lines.length; j++) {
                  var nextLine = normalizeCodexText(lines[j]);
                  if (!nextLine || codexFooterRe.test(nextLine) || isPtyCodexNoiseLine(nextLine)) continue;
                  return nextLine;
                }
              }
            }
            return null;
          }

          function extractVisibleAssistantLines(lines) {
            var assistantLines = [];
            var collecting = false;

            for (var i = 0; i < lines.length; i++) {
              var line = String(lines[i] || "").trim();
              if (!line) {
                if (collecting) break;
                continue;
              }

              var assistant = extractCodexAssistantCandidate(line);
              if (assistant) {
                assistantLines.push(assistant);
                collecting = true;
                continue;
              }

              if (collecting) {
                if (line === "›" || /^›(?:\s|$)/.test(line) || codexFooterRe.test(line) || isPtyCodexNoiseLine(line)) {
                  break;
                }
                assistantLines.push(normalizeCodexText(line));
              }
            }

            return assistantLines;
          }

          var rawCandidates = [];
          var candidateOrder = 0;
          var rawSegments = text.replace(/\r\n?/g, newline).split(newline);
          for (var rs = 0; rs < rawSegments.length; rs++) {
            var cleanedSegment = stripCodexSegment(rawSegments[rs]);
            var pieces = cleanedSegment.split(newline);
            for (var pi = 0; pi < pieces.length; pi++) {
              var piece = String(pieces[pi] || "").trim();
              if (!piece) continue;

              var promptCandidate = extractCodexPromptCandidate(piece);
              if (promptCandidate) {
                rawCandidates.push({ kind: "user", order: candidateOrder++, text: promptCandidate });
                continue;
              }

              var assistantCandidate = extractCodexAssistantCandidate(piece);
              if (assistantCandidate) {
                rawCandidates.push({ kind: "assistant", order: candidateOrder++, text: assistantCandidate });
                continue;
              }

              var echoCandidate = extractCodexEchoCandidate(piece);
              if (echoCandidate) {
                rawCandidates.push({ kind: "echo", order: candidateOrder++, text: echoCandidate });
              }
            }
          }

          var candidates = rawCandidates.filter(function(candidate, index, list) {
            var previous = list[index - 1];
            return !previous || previous.kind !== candidate.kind || previous.text !== candidate.text;
          });

          var explicitUsers = candidates.filter(function(candidate) { return candidate.kind === "user"; });
          var assistantCandidates = candidates.filter(function(candidate) { return candidate.kind === "assistant"; });
          var echoCandidates = candidates.filter(function(candidate) { return candidate.kind === "echo"; });
          var strippedOutput = stripAnsi(text);
          var strippedLines = strippedOutput.split(newline).map(function(line) { return String(line || "").trimEnd(); });
          var visiblePrompt = extractVisiblePrompt(strippedLines);
          var latestExplicitUser = explicitUsers.length ? explicitUsers[explicitUsers.length - 1] : null;
          var echoedUserCandidates = echoCandidates
            .map(function(candidate) { return candidate.text; })
            .filter(function(value) { return value.length >= 3; });
          var latestEchoUser = null;
          for (var eu = echoedUserCandidates.length - 1; eu >= 0; eu--) {
            if (echoedUserCandidates[eu] !== visiblePrompt) {
              latestEchoUser = echoedUserCandidates[eu];
              break;
            }
          }
          if (!latestEchoUser && echoedUserCandidates.length) {
            latestEchoUser = echoedUserCandidates[echoedUserCandidates.length - 1];
          }

          var currentUser = latestExplicitUser ? latestExplicitUser.text : latestEchoUser;
          var rawAssistantLines = assistantCandidates
            .filter(function(candidate) { return !latestExplicitUser || candidate.order > latestExplicitUser.order; })
            .map(function(candidate) { return candidate.text; });
          var visibleAssistantFallback = [];
          var bulletMatches = strippedOutput.match(/^[ \t]*[•◦·⏺][ \t]*(.+)$/gm) || [];
          for (var bm = 0; bm < bulletMatches.length; bm++) {
            var bulletContent = normalizeCodexText(bulletMatches[bm].replace(/^[ \t]*[•◦·⏺][ \t]*/, ""));
            if (!bulletContent) continue;
            if (codexActivityRe.test(bulletContent)) continue;
            if (codexFooterRe.test(bulletContent)) continue;
            if (/\b(?:OpenAI Codex|model:|directory:|Tip:|esc to interrupt)\b/i.test(bulletContent)) continue;
            visibleAssistantFallback.push(bulletContent);
          }

          var assistantText = coalesceAssistantLines(rawAssistantLines)
            || coalesceAssistantLines(extractVisibleAssistantLines(strippedLines))
            || (visibleAssistantFallback.length ? visibleAssistantFallback[visibleAssistantFallback.length - 1] : null);

          if (currentUser) {
            messages.push({ role: "user", content: currentUser });
          }
          if (assistantText) {
            messages.push({ role: "assistant", content: assistantText });
          }
          if (!messages.length && latestExplicitUser) {
            messages.push({ role: "user", content: latestExplicitUser.text });
          } else if (!messages.length && latestEchoUser) {
            messages.push({ role: "user", content: latestEchoUser });
          }

          return messages;
        }

        // Optimized ANSI escape sequence stripping
        // Handles: CSI sequences, OSC sequences, single-character escapes, control chars
        var nul = String.fromCharCode(0);
        var bs = String.fromCharCode(8);
        var vt = String.fromCharCode(11);
        var ff = String.fromCharCode(12);
        var so = String.fromCharCode(14);
        var us = String.fromCharCode(31);
        var nbsp = String.fromCharCode(160);
        var bel = String.fromCharCode(7);
        var ansiRegex = new RegExp(
          esc + '\\[[0-9;?]*[a-zA-Z]|' +  // CSI sequences
          esc + '\\][^' + bel + ']*(' + bel + '|' + esc + '\\\\\\\\)|' +  // OSC sequences - matches ESC ] ... (BEL or ESC \)
          esc + '[><=eP_X^]|' +  // Single-character escapes
          '[' + nul + '-' + bs + vt + ff + so + '-' + us + ']|' +  // Control chars: 0-8, 11, 12, 14-31
          nbsp + '|' + carriageReturn,
          'g'
        );
        var ansiStripped = text.replace(
          ansiRegex,
          function(m) { return m === nbsp ? ' ' : m === carriageReturn ? newline : ''; }
        ).split(carriageReturn).join(newline);

        var lines = ansiStripped.split(newline).map(function(line) { return line.trim(); }).filter(Boolean);

        // Extract thinking/deep thought content
        var thinkingPatterns = [
          /thinking with high effort/i,
          /thinking with medium effort/i,
          /thinking with low effort/i,
          new RegExp("thought for [0-9]+s", "i"),
          new RegExp("Sauteed for [0-9]+m", "i"),
          /Germinating/i,
          /Doodling/i,
          /Brewing/i
        ];

        // Find the most recent thinking line (usually appears after user input)

        // Separate different types of content
        var promptLines = [];  // Try "..." suggestions
        var contentLines = []; // Actual conversation content
        var thinkingLines = [];

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          // Check for prompt suggestions (Try "..." pattern, including after ❯)
          var lineForPromptCheck = line.replace(/^❯\s*/, "");
          if (lineForPromptCheck.indexOf('Try"') === 0 || lineForPromptCheck.indexOf('Try "') === 0) {
            promptLines.push(lineForPromptCheck);
            continue;
          }

          // Check for thinking content
          var isThinking = false;
          for (var p = 0; p < thinkingPatterns.length; p++) {
            if (thinkingPatterns[p].test(line)) {
              isThinking = true;
              thinkingLines.push(line);
              break;
            }
          }
          if (isThinking) continue;

          // 界面文案与 CLI 噪声集中在 pty-noise.ts：本函数只管切分，不再维护文案。
          if (isPtyTranscriptNoiseLine(line)) continue;
          // Strip bullet prefix from Claude TUI output lines (keep the content)
          if (line.indexOf("●") === 0) {
            line = line.slice(1).trim();
            if (!line) continue;
            contentLines.push(line);
            continue;
          }
          // Filter partial/fragmented lines (likely from streaming)
          if (line.length < 3 && !/^[a-zA-Z]{3}$/.test(line)) continue;

          contentLines.push(line);
        }

        // Add thinking message (most recent one, deduplicated)
        if (thinkingLines.length > 0) {
          var lastThinking = thinkingLines[thinkingLines.length - 1];
          var durationMatch = lastThinking.match(new RegExp("for ([0-9]+[ms]+| [0-9]+m [0-9]+s)", "i"));
          var thinkingText = durationMatch ? "深度思考 " + durationMatch[0].replace(/for /i, "") : "深度思考中...";
          messages.push({ role: "thinking", content: thinkingText, type: "deep-thought" });
        }

        // Add prompt suggestion as a special message (pulsing display)
        if (promptLines.length > 0) {
          var promptText = promptLines[promptLines.length - 1].replace(/^Try\s*/, "").trim();
          messages.push({ role: "prompt", content: promptText, type: "suggestion" });
        }

        if (!contentLines.length) return messages;

        // ── Multi-turn conversation parsing ──
        // Find ALL ❯ markers to build multiple user/assistant turn pairs
        var turns = [];
        var currentUserText = null;
        var currentAssistantLines = [];

        for (var i = 0; i < contentLines.length; i++) {
          line = contentLines[i];

          if (line.indexOf("❯") === 0) {
            var afterPrompt = line.replace(/^❯\s*/, "").trim();

            // Skip prompt suggestions
            if (afterPrompt.indexOf('Try"') === 0 || afterPrompt.indexOf('Try "') === 0) continue;

            // Finalize previous turn if we had a user message
            if (currentUserText !== null && currentAssistantLines.length > 0) {
              turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
              currentAssistantLines = [];
            }

            if (afterPrompt) {
              currentUserText = afterPrompt;
            } else {
              // Standalone ❯ — just a prompt, no user text
              if (currentUserText !== null && currentAssistantLines.length > 0) {
                turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
                currentAssistantLines = [];
              }
              currentUserText = null;
            }
          } else if (currentUserText !== null) {
            // Filter assistant content lines
            if (line.indexOf("⏺") !== -1 && (line.indexOf("Hi!") !== -1 || line.indexOf("Hello") !== -1 || line.indexOf("What") !== -1 || line.indexOf("working") !== -1)) {
              currentAssistantLines.push(line);
            } else if (line.indexOf("⏺") === 0) {
              currentAssistantLines.push(line.slice(1).trim() || line);
            } else if (line.length >= 8) {
              if (line.indexOf("✢") === -1 && line.indexOf("✳") === -1 && line.indexOf("✶") === -1 && line.indexOf("✻") === -1 && line.indexOf("✽") === -1 &&
                  line.indexOf("▐") !== 0 && line.indexOf("▝") !== 0 && line.indexOf("▘") !== 0 &&
                  line.indexOf("esctointerrupt") === -1 && line.indexOf("?for") !== 0 && line.indexOf("? for") !== 0) {
                currentAssistantLines.push(line);
              }
            }
          }
        }

        // Finalize the last turn
        if (currentUserText !== null && currentAssistantLines.length > 0) {
          turns.push({ user: currentUserText, assistantLines: currentAssistantLines });
        }

        // If no ❯-based turns found, try fallback heuristic (first message without ❯)
        if (turns.length === 0) {
          var fallbackUserText = "";
          var fallbackUserIdx = -1;
          for (var i = 0; i < contentLines.length; i++) {
            line = contentLines[i];
            if (line.indexOf('Try"') === 0 || line.indexOf('Try "') === 0) continue;
            if (line.indexOf('Failed to install') !== -1) continue;
            if (line.indexOf('ctrl+g') !== -1) continue;
            if (line.indexOf('● ') === 0) continue;
            if (line.length < 2 || line.length > 100) continue;
            if (/^[a-zA-Z]/.test(line)) {
              fallbackUserText = line.trim();
              fallbackUserIdx = i;
              break;
            }
          }
          if (fallbackUserText && fallbackUserIdx >= 0) {
            var fallbackAssistant = contentLines.slice(fallbackUserIdx + 1).filter(function(l) {
              return l.length >= 8;
            });
            if (fallbackAssistant.length > 0) {
              turns.push({ user: fallbackUserText, assistantLines: fallbackAssistant });
            }
          }
        }

        // Convert turns to messages
        for (var t = 0; t < turns.length; t++) {
          messages.push({ role: "user", content: turns[t].user });
          if (turns[t].assistantLines.length > 0) {
            var formattedContent = formatAssistantResponse(turns[t].assistantLines.join(newline));
            messages.push({ role: "assistant", content: formattedContent });
          }
        }

        return messages;
      }

      // ── 像素风猫咪头像 ──
      // 统一的 10×10 猫咪 grid 模板：父 assistant = 加菲（橙），user = 美短（灰），
      // subagent = 一组按 taskId/agentType 哈希选色的备选 palette。同一模板让多个
      // 角色看起来是"同种生物的不同毛色"，群聊感更自然。
      var _AVATAR_T = "transparent";
      function buildPixelSvg(grid, size?) {
        var s = size || 3;
        var w = grid[0].length * s;
        var h = grid.length * s;
        var rects = "";
        for (var y = 0; y < grid.length; y++) {
          for (var x = 0; x < grid[y].length; x++) {
            if (grid[y][x] !== _AVATAR_T) {
              rects += '<rect x="' + (x * s) + '" y="' + (y * s) + '" width="' + s + '" height="' + s + '" fill="' + grid[y][x] + '"/>';
            }
          }
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" class="pixel-avatar-svg">' + rects + '</svg>';
      }
      function buildCatGrid(palette) {
        // palette: { base, dark, light, accent, eye, mouth, nose }
        var T = _AVATAR_T;
        var b = palette.base;
        var d = palette.dark;
        var l = palette.light || palette.base;
        var w = palette.accent || "#FFFFFF";
        var k = palette.eye || "#2D2D2D";
        var p = palette.mouth || "#F28B9A";
        var n = palette.nose || palette.dark;
        return [
          [T,d,T,T,T,T,T,T,d,T],
          [d,b,d,T,T,T,T,d,b,d],
          [d,b,b,b,b,b,b,b,b,d],
          [b,b,w,k,b,b,w,k,b,b],
          [b,b,w,w,b,b,w,w,b,b],
          [b,b,b,b,p,p,b,b,b,b],
          [b,n,b,l,b,b,l,b,n,b],
          [T,b,b,b,b,b,b,b,b,T],
          [T,T,b,d,b,b,d,b,T,T],
          [T,T,T,b,T,T,b,T,T,T],
        ];
      }
      var GARFIELD_PALETTE = {
        base: "#F0923A", dark: "#C46A1A", light: "#F0923A",
        accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#F28B9A", nose: "#E87D5A",
      };
      var SHORTHAIR_PALETTE = {
        base: "#9EAAB8", dark: "#6B7B8D", light: "#C5CED8",
        accent: "#FFFFFF", eye: "#7EC88B", mouth: "#F28B9A",
      };
      // Agent Run 使用稳定的身份色，但不再引入额外头像或“角色扮演”命名。
      // 颜色只是让同一个 taskId 在并行轨迹里可辨认，状态色仍由 CSS 统一控制。
      var AGENT_RUN_ACCENTS = ["#4F7FD8", "#8A61C9", "#4F8A68", "#C45F78", "#3F9992", "#A66B35"];
      function hashStringToIndex(str, mod) {
        var s = String(str || "");
        var h = 0;
        for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return Math.abs(h) % mod;
      }
      /**
       * 身份色：种子用 taskId（同一批次并行子 Agent 的 agentType 往往完全相同，
       * 按类型取色会让四个 Agent 撞成同一个颜色），但一卡之内撞色时向后取下一个
       * 空位——同一张卡里四个点同色就等于没有身份色。
       */
      function agentRunAccent(run, agent) {
        var n = AGENT_RUN_ACCENTS.length;
        var taken = [];
        var slot = hashStringToIndex(agentRunAccentSeed(agent), n);
        var agents = (run && Array.isArray(run.agents)) ? run.agents : [];
        for (var i = 0; i < agents.length; i++) {
          if (agents[i] === agent) break;
          var other = hashStringToIndex(agentRunAccentSeed(agents[i]), n);
          for (var step = 0; step < n && taken.indexOf(other) >= 0; step++) other = (other + 1) % n;
          taken.push(other);
        }
        for (var shift = 0; shift < n && taken.indexOf(slot) >= 0; shift++) slot = (slot + 1) % n;
        return AGENT_RUN_ACCENTS[slot];
      }
      // 这些类型名不携带信息（“通用 Agent”），不配占一个 chip 位。
      var AGENT_RUN_DEFAULT_TYPES = ["general", "general-purpose", "generalist", "default"];
      function agentRunTypeValue(agent) {
        return String((agent && agent.meta && agent.meta.agentType) || "").trim();
      }
      function isDefaultAgentRunType(type) {
        if (!type) return true;
        return AGENT_RUN_DEFAULT_TYPES.indexOf(type.toLowerCase()) >= 0;
      }
      /**
       * 卡级类型 chip 只在「整卡就一个类型、且这个类型有信息量」时出现。
       * 多个类型混在一行等于没写；同类型的 general-purpose 是纯噪音。
       */
      function agentRunTypeChip(run) {
        if (!agentRunTypesCarryInfo(run)) return "";
        var types = [];
        for (var i = 0; i < run.agents.length; i++) {
          var type = agentRunTypeValue(run.agents[i]);
          if (type && types.indexOf(type) < 0) types.push(type);
        }
        if (types.length !== 1) return "";
        return types[0];
      }
      /**
       * rail 每行都写 "general-purpose" 等于没写：只有类型能区分谁是谁（或非默认类型）
       * 时才显示类型小字。
       */
      function agentRunTypesCarryInfo(run) {
        var types = [];
        for (var i = 0; i < run.agents.length; i++) {
          var type = agentRunTypeValue(run.agents[i]);
          if (type && types.indexOf(type) < 0) types.push(type);
        }
        if (types.length > 1) return true;
        return types.length === 1 && !isDefaultAgentRunType(types[0]);
      }
      // 状态文字只在需要解释时出现：完成态由图标 + aria-label / title 表达。
      function agentRunStatusNeedsText(status) {
        return status !== "completed";
      }
      function agentRunStatusLabel(status, activity) {
        return t(agentRunStatusLabelKey(status, activity));
      }
      function agentRunStatusIcon(status) {
        if (status === "failed") return iconSvg("close", { size: 12, strokeWidth: 2.2 });
        if (status === "running") return iconSvg("refresh", { size: 12, strokeWidth: 1.8 });
        if (status === "background") return iconSvg("cpu", { size: 12, strokeWidth: 1.8 });
        if (status === "interrupted") return iconSvg("warning", { size: 12, strokeWidth: 1.8 });
        if (status === "pending") return iconSvg("circle", { size: 12, strokeWidth: 1.8 });
        return iconSvg("check", { size: 12, strokeWidth: 2.2 });
      }
      // 标题（设计 A）：任务描述优先，其次类型，最后兜底「子 Agent」。
      // 反过来（类型当标题）会让并行批次的每一行都写着 general-purpose。
      function agentRunAgentName(agent) {
        return agentRunAgentTitle(agent, t("agentRun.subagent"));
      }
      function agentRunTaskDescription(agent) {
        var task = agent && agent.meta.taskDescription && String(agent.meta.taskDescription).trim();
        return task || t("agentRun.noTask");
      }
      function agentRunTitle(run, summary) {
        if (run.agents.length > 1) return t("agentRun.count", { count: String(summary.total) });
        return agentRunAgentName(run.agents[0]);
      }
      // 多 Agent 卡的主 Agent：正在跑的那个优先，否则第一条（保持稳定，不随刷新跳字）。
      function agentRunPrimaryAgent(run, activity) {
        for (var i = 0; i < run.agents.length; i++) {
          var status = getAgentRunStatusSummary({ agents: [run.agents[i]] } as any, activity).status;
          if (status === "running" || status === "background") return run.agents[i];
        }
        return run.agents[0];
      }
      function agentRunTopicText(run, activity) {
        if (run.agents.length < 2) return "";
        var primary = agentRunPrimaryAgent(run, activity);
        var desc = String((primary && primary.meta && primary.meta.taskDescription) || "").trim();
        if (!desc) desc = agentRunTypeValue(primary) || t("agentRun.subagent");
        return truncateInlineText(desc, 96);
      }
      // 结果体保留原始换行：压平后再走 renderMarkdown，标题/列表/代码块会全塌成一段。
      function agentRunResultText(agent) {
        if (!agent || !agent.result) return "";
        return agentRunResultRawText(agent.result.block);
      }
      /**
       * 副行只放「最后一步动作」：工具步用动作标签，正文/思考压平成一行纯文本。
       * 原实现把整份最终报告塞进「最新」行，一行里混着裸 markdown 标题。
       */
      function agentRunLastActionText(agent, status) {
        var blocks = agent && Array.isArray(agent.blocks) ? agent.blocks : [];
        for (var i = blocks.length - 1; i >= 0; i--) {
          var block = blocks[i] && blocks[i].block;
          if (!block || block.type === "tool_result") continue;
          if (block.type === "tool_use") {
            var label = activityItemLabel(block);
            if (label) return truncateInlineText(flattenAgentRunInline(String(label)), 150);
            continue;
          }
          var text = block.type === "text" ? String(block.text || "") :
            (block.type === "thinking" ? String(block.thinking || "") : "");
          if (text.trim()) return truncateInlineText(flattenAgentRunInline(text), 150);
        }
        if (agent && agent.receipt) return t("agentRun.receipt.action");
        var resultText = agentRunResultText(agent);
        if (resultText.trim()) return truncateInlineText(flattenAgentRunInline(resultText), 150);
        if (status === "running") return t("agentRun.waiting");
        return "";
      }
      function agentRunLatestRef(agent) {
        var latest = agent && (agent.result || agent.dispatch || agent.firstSeen);
        var blocks = agent && Array.isArray(agent.blocks) ? agent.blocks : [];
        for (var i = 0; i < blocks.length; i++) {
          var ref = blocks[i];
          if (!latest || ref.messageIndex > latest.messageIndex ||
              (ref.messageIndex === latest.messageIndex && ref.blockIndex > latest.blockIndex)) latest = ref;
        }
        return latest;
      }
      function agentRunLatestSummary(run, activity) {
        var latestAgent = null;
        var latestRef = null;
        for (var i = 0; i < run.agents.length; i++) {
          var ref = agentRunLatestRef(run.agents[i]);
          if (!latestRef || (ref && (ref.messageIndex > latestRef.messageIndex ||
              (ref.messageIndex === latestRef.messageIndex && ref.blockIndex > latestRef.blockIndex)))) {
            latestRef = ref;
            latestAgent = run.agents[i];
          }
        }
        if (!latestAgent) return "";
        var status = getAgentRunStatusSummary({ agents: [latestAgent] } as any, activity).status;
        return agentRunLastActionText(latestAgent, status);
      }
      function renderAgentRunStepHtml(ref, role, toolResults, messageKey) {
        var block = ref && ref.block;
        if (!block || block.type === "tool_result") return "";
        var blockHtml = renderContentBlock(
          block,
          role,
          toolResults,
          ref.messageIndex * 100000 + ref.blockIndex,
          messageKey + ":" + ref.messageIndex + ":" + ref.blockIndex,
          { noActivityFold: true, inAgentRun: true }
        );
        if (!blockHtml || !String(blockHtml).trim()) return "";
        var kind = block.type === "thinking" ? "thinking" : (block.type === "tool_use" ? "tool" : "text");
        var marker = '<span class="agent-run-step-dot" aria-hidden="true"></span>';
        if (kind === "thinking") {
          marker = '<span class="agent-run-step-icon" aria-hidden="true">' + iconSvg("spark", { size: 11, strokeWidth: 1.8 }) + '</span>';
        } else if (kind === "tool") {
          marker = '<span class="agent-run-step-icon" aria-hidden="true">' + getToolIcon(block.name) + '</span>';
        }
        return '<div class="agent-run-step is-' + kind + '">' +
          '<span class="agent-run-step-marker">' + marker + '</span>' +
          '<div class="agent-run-step-content">' + blockHtml + '</div>' +
        '</div>';
      }
      /**
       * 异步派发的「回执」不是结论：它只说任务已交给后台。真实形状里 pi 只有
       * run id（没有输出文件），兜底判据连 id 都没有——那种情况回落到渲染正文，
       * 宁可让用户读到 provider 的原话，也不能给一张什么都不显示的卡。
       */
      function renderAgentRunReceiptHtml(agent, status) {
        var receipt = agent.receipt || { runId: "", outputPath: "" };
        var rows = "";
        if (receipt.runId) {
          rows += '<div class="agent-run-receipt-row"><span>' + escapeHtml(t("agentRun.receipt.run")) +
            "</span><code>" + escapeHtml(receipt.runId) + "</code></div>";
        }
        if (receipt.outputPath) {
          rows += '<div class="agent-run-receipt-row"><span>' + escapeHtml(t("agentRun.receipt.output")) +
            "</span><code>" + escapeHtml(receipt.outputPath) + "</code></div>";
        }
        var bodyHtml = rows ? '<div class="agent-run-receipt-rows">' + rows + "</div>"
          : '<div class="agent-run-receipt-body">' +
              renderMarkdown(String(agentRunResultText(agent)).trim()) + "</div>";
        // 状态词只属于摘要行：展开一条回执时「后台运行中」在摘要行和这里各出现一次，
        // 等于同一屏说两遍（怪点 8 的同族）。头部留图标 + 说明文字就够表达「这不是结论」。
        return '<div class="agent-run-receipt">' +
          '<div class="agent-run-result-label">' +
            '<span class="agent-run-result-icon" aria-hidden="true">' + agentRunStatusIcon(status) + "</span>" +
            '<span class="agent-run-receipt-note">' + escapeHtml(t("agentRun.receipt.note")) + "</span>" +
          "</div>" +
          bodyHtml +
        "</div>";
      }
      function renderAgentRunResultHtml(agent, status, activity) {
        if (!agent || !agent.result) return "";
        if (agent.receipt) return renderAgentRunReceiptHtml(agent, status);
        var isError = agent.result.block && agent.result.block.is_error === true;
        var rawText = agentRunResultText(agent).trim();
        // 结论体保留换行再渲染 markdown；压平只用于摘要行。
        var bodyHtml = rawText ? renderMarkdown(rawText) :
          '<p class="agent-run-result-empty">' + escapeHtml(t("agentRun.noOutput")) + "</p>";
        return '<div class="agent-run-result' + (isError ? " is-error" : "") + '">' +
          '<div class="agent-run-result-label">' +
            '<span class="agent-run-result-icon" aria-hidden="true">' + agentRunStatusIcon(status) + "</span>" +
            "<span>" + escapeHtml(isError ? t("agentRun.result.failed") : t("agentRun.result.done")) + "</span>" +
          "</div>" +
          '<div class="agent-run-result-content">' + bodyHtml + "</div>" +
        "</div>";
      }
      /**
       * 过程块默认收起：展开卡片先看结论，想看怎么做的再点「过程 · N 步」。
       * 运行中例外——那时过程就是正文，收起会让用户以为卡住。
       */
      function renderAgentRunProcessHtml(agent, role, toolResults, messageKey, open) {
        var steps = [];
        var blocks = agent && Array.isArray(agent.blocks) ? agent.blocks : [];
        for (var i = 0; i < blocks.length; i++) {
          var stepHtml = renderAgentRunStepHtml(blocks[i], role || "assistant", toolResults, messageKey);
          if (stepHtml && String(stepHtml).trim()) steps.push(stepHtml);
        }
        if (!steps.length) return "";
        return '<details class="agent-run-process"' + (open ? " open" : "") + ">" +
          '<summary class="agent-run-process-summary">' +
            '<span class="agent-run-process-chevron" aria-hidden="true">' +
              iconSvg("chevronRight", { size: 12, strokeWidth: 2 }) +
            "</span>" +
            '<span class="agent-run-process-label">' + escapeHtml(t("agentRun.process")) + "</span>" +
            '<span class="agent-run-process-count">' +
              escapeHtml(t("agentRun.process_count", { count: String(steps.length) })) +
            "</span>" +
          "</summary>" +
          '<div class="agent-run-timeline">' + steps.join("") + "</div>" +
        "</details>";
      }
      // 展开体顺序：结论在前、过程在后（原来是过程铺完才给结论，结论被挤到几十屏之下）。
      function renderAgentRunAgentBody(agent, status, activity, role, toolResults, messageKey) {
        var resultHtml = renderAgentRunResultHtml(agent, status, activity);
        var processHtml = renderAgentRunProcessHtml(agent, role, toolResults, messageKey, status === "running");
        if (!resultHtml && !processHtml) {
          return '<div class="agent-run-waiting">' + escapeHtml(t("agentRun.waiting")) + "</div>";
        }
        return resultHtml + processHtml;
      }
      function agentRunPanelId(runId, taskId) {
        return "agent-run-panel-" + String(runId + "-" + taskId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
      }
      function renderAgentRunDetailHtml(run, agent, selected, role, toolResults, messageKey, activity, isMulti, showType) {
        var taskId = agent.taskId;
        var agentStatus = getAgentRunStatusSummary({ agents: [agent] } as any, activity).status;
        var agentType = agentRunTypeValue(agent);
        var taskDesc = agentRunTaskDescription(agent);
        var headStatusLabel = agentRunStatusLabel(agentStatus, activity);
        var domId = agentRunPanelId(run.id, taskId);
        var buttonId = domId + "-tab";
        // 单个 Agent 没有“切换”语义：不套 tab/tabpanel，rail 也整块不渲染，
        // 避免常见情况下出现一个只剩一项、纯占位的选择器。
        var panelRole = isMulti
          ? 'role="tabpanel" tabindex="0" aria-labelledby="' + escapeHtml(buttonId) + '" '
          : '';
        return '<div class="agent-run-detail-panel' + (selected ? ' is-selected' : '') + '" ' +
            'id="' + escapeHtml(domId) + '" ' + panelRole +
            'data-agent-run-id="' + escapeHtml(run.id) + '" data-agent-task-id="' + escapeHtml(taskId) + '" ' +
            (selected ? '' : 'hidden') + '>' +
          '<div class="agent-run-detail-head">' +
            '<div class="agent-run-detail-titles">' +
              '<div class="agent-run-detail-task">' + escapeHtml(taskDesc) + '</div>' +
              (showType && agentType && agentType !== taskDesc
                ? '<span class="agent-run-type-chip">' + escapeHtml(agentType) + '</span>'
                : '') +
            '</div>' +
            // 状态词只出现在摘要行 / rail 行；详情头用同色的点，避免同一个词一屏出现多次。
            '<span class="agent-run-detail-state is-' + agentStatus + '" role="img" ' +
              'aria-label="' + escapeHtml(headStatusLabel) + '" ' +
              'title="' + escapeHtml(headStatusLabel) + '"></span>' +
          '</div>' +
          '<div class="agent-run-agent-body">' +
            renderAgentRunAgentBody(agent, agentStatus, activity, role, toolResults, messageKey) +
          '</div>' +
        '</div>';
      }
      function renderAgentRunHtml(run, activity, role, toolResults, messageKey) {
        if (!run || !run.agents.length) return "";
        var summary = getAgentRunStatusSummary(run, activity);
        var expandKey = buildExpandKey("agent-run", [run.id]);
        var persisted = getPersistedExpandState(expandKey);
        var expanded = shouldAgentRunStartExpanded(summary.status, persisted);
        var selectedTaskId = typeof getPersistedAgentSelection === "function" ? getPersistedAgentSelection(run.id) : "";
        var selectedAgent = null;
        for (var i = 0; i < run.agents.length; i++) {
          var candidate = run.agents[i];
          if (selectedTaskId && candidate.taskId === selectedTaskId) selectedAgent = candidate;
        }
        if (!selectedAgent) {
          for (var j = 0; j < run.agents.length; j++) {
            var candidateStatus = getAgentRunStatusSummary({ agents: [run.agents[j]] } as any, activity).status;
            if (!selectedAgent || candidateStatus === "failed" || (candidateStatus === "running" && selectedAgent !== run.agents[j])) {
              selectedAgent = run.agents[j];
            }
            if (candidateStatus === "failed") break;
          }
        }
        selectedAgent = selectedAgent || run.agents[0];
        var bodyId = "agent-run-body-" + String(run.id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
        var latest = agentRunLatestSummary(run, activity);
        var statusWord = agentRunStatusLabel(summary.status, activity);
        // 标题（设计 A）：单 Agent 用任务描述，多 Agent 用「N 个子 Agent」+ 主 Agent 的描述。
        // 「Agent 运行」这种卡名不再出现——它不告诉用户这一轮到底做了什么。
        var titleText = agentRunTitle(run, summary);
        var topicText = agentRunTopicText(run, activity);
        var typeChip = agentRunTypeChip(run);
        var summaryAria = t("agentRun.summary_aria", {
          count: String(summary.total),
          status: statusWord,
          latest: latest || t("agentRun.noOutput"),
        });
        var railHtml = "";
        var detailHtml = "";
        var isMulti = run.agents.length > 1;
        // 类型只在能区分时出现一次：摘要行已经代表整卡类型时，rail 行与详情头不再重复。
        var showType = agentRunTypesCarryInfo(run);
        for (var k = 0; k < run.agents.length; k++) {
          var agent = run.agents[k];
          var agentStatus = getAgentRunStatusSummary({ agents: [agent] } as any, activity).status;
          var agentStatusWord = agentRunStatusLabel(agentStatus, activity);
          var agentLabel = agentRunTaskDescription(agent);
          var agentType = agentRunTypeValue(agent);
          var isSelected = agent === selectedAgent;
          var panelId = agentRunPanelId(run.id, agent.taskId);
          var tabId = panelId + "-tab";
          var rowType = showType && agentType && agentType !== typeChip ? agentType : "";
          if (isMulti) railHtml += '<button type="button" class="agent-run-agent' + (isSelected ? ' is-selected' : '') + '" ' +
              'id="' + escapeHtml(tabId) + '" role="tab" aria-controls="' + escapeHtml(panelId) + '" ' +
              'aria-selected="' + (isSelected ? "true" : "false") + '" ' +
              'tabindex="' + (isSelected ? "0" : "-1") + '" data-agent-task-id="' + escapeHtml(agent.taskId) + '" ' +
              'data-agent-run-id="' + escapeHtml(run.id) + '" onclick="__agentRunSelect(event, this)" ' +
              'onkeydown="__agentRunSelect(event, this)" ' +
              'style="--agent-color:' + escapeHtml(agentRunAccent(run, agent)) + '">' +
            '<span class="agent-run-agent-marker" aria-hidden="true"></span>' +
            // rail 行标题 = 任务描述（能区分谁在干什么），agentType 降为次要小字。
            '<span class="agent-run-agent-copy">' +
              '<strong>' + escapeHtml(truncateInlineText(agentLabel, 86)) + '</strong>' +
              (rowType ? '<span class="agent-run-agent-type">' + escapeHtml(rowType) + '</span>' : '') +
            '</span>' +
            (agentRunStatusNeedsText(agentStatus)
              ? '<span class="agent-run-agent-status is-' + agentStatus + '">' + escapeHtml(agentStatusWord) + '</span>'
              : '<span class="agent-run-agent-status is-' + agentStatus + '" role="img" aria-label="' +
                  escapeHtml(agentStatusWord) + '">' + agentRunStatusIcon(agentStatus) + '</span>') +
          '</button>';
          detailHtml += renderAgentRunDetailHtml(run, agent, isSelected, role, toolResults, messageKey, activity, isMulti, !!rowType);
        }
        return '<section class="agent-run is-' + summary.status + (isMulti ? '' : ' is-single') + '" ' +
            'data-expand-kind="agent-run" data-expand-key="' + escapeHtml(expandKey) + '" ' +
            'data-agent-run-id="' + escapeHtml(run.id) + '" data-status="' + summary.status + '" ' +
            'data-expanded="' + (expanded ? "true" : "false") + '" ' +
            'aria-label="' + escapeHtml(summaryAria) + '">' +
          '<button type="button" class="agent-run-summary" aria-expanded="' + (expanded ? "true" : "false") + '" ' +
              'aria-controls="' + escapeHtml(bodyId) + '" aria-label="' + escapeHtml(summaryAria) + '" ' +
              'onclick="__agentRunToggle(event, this)">' +
            '<span class="agent-run-summary-icon" aria-hidden="true">' + agentRunStatusIcon(summary.status) + '</span>' +
            '<span class="agent-run-summary-main">' +
              '<span class="agent-run-summary-top">' +
                '<strong class="agent-run-title">' + escapeHtml(titleText) + '</strong>' +
                (topicText ? '<span class="agent-run-topic">' + escapeHtml(topicText) + '</span>' : '') +
                (typeChip ? '<span class="agent-run-type-chip">' + escapeHtml(typeChip) + '</span>' : '') +
                (agentRunStatusNeedsText(summary.status)
                  ? '<span class="agent-run-status-label is-' + summary.status + '">' + escapeHtml(statusWord) + '</span>'
                  : '') +
              '</span>' +
              // 副行 = 最后一步动作，纯文本一行，不渲染 markdown。
              (latest
                ? '<span class="agent-run-latest"><span class="agent-run-latest-text">' + escapeHtml(latest) + '</span></span>'
                : '') +
            '</span>' +
            '<span class="agent-run-chevron" aria-hidden="true">' + iconSvg("chevronDown", { size: 14, strokeWidth: 2 }) + '</span>' +
          '</button>' +
          '<div class="agent-run-body" id="' + escapeHtml(bodyId) + '" aria-hidden="' + (expanded ? "false" : "true") + '">' +
            '<div class="agent-run-body-inner">' +
              (isMulti
                ? '<div class="agent-run-rail" role="tablist" aria-label="' + escapeHtml(t("agentRun.agent_list")) + '">' + railHtml + '</div>'
                : '') +
              '<div class="agent-run-detail">' + detailHtml + '</div>' +
            '</div>' +
          '</div>' +
        '</section>';
      }
      export var PIXEL_AVATAR = {
        assistant: buildPixelSvg(buildCatGrid(GARFIELD_PALETTE)),
        user: buildPixelSvg(buildCatGrid(SHORTHAIR_PALETTE)),
      };

      var DEFAULT_CHAT_PERSONA = {
        user: {
          name: "赛博虎妞",
          avatarSvg: PIXEL_AVATAR.user
        },
        assistant: {
          name: "勤劳初二",
          avatarSvg: PIXEL_AVATAR.assistant
        }
      };

      function getStructuredChatPersona(role) {
        var configPersona = state.config && state.config.structuredChatPersona;
        var roleConfig = configPersona && configPersona[role] ? configPersona[role] : null;
        var defaults = DEFAULT_CHAT_PERSONA[role] || DEFAULT_CHAT_PERSONA.assistant;
        return {
          name: roleConfig && typeof roleConfig.name === "string" && roleConfig.name.trim()
            ? roleConfig.name.trim()
            : defaults.name,
          avatar: roleConfig && typeof roleConfig.avatar === "string" && roleConfig.avatar.trim()
            ? roleConfig.avatar.trim()
            : null,
          avatarSvg: defaults.avatarSvg
        };
      }

      function renderAvatarFallback(svg) {
        return '<div class="pixel-avatar">' + svg + '</div>';
      }

      function handleChatAvatarImageError(img, role) {
        if (!img || !img.parentNode) return;
        var persona = getStructuredChatPersona(role === "user" ? "user" : "assistant");
        img.outerHTML = renderAvatarFallback(persona.avatarSvg);
      }

      function formatChatClock(iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        var pad = function(n) { return n < 10 ? "0" + n : String(n); };
        var clock = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
        var now = new Date();
        var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        if (sameDay) return clock;
        return (d.getMonth() + 1) + "/" + d.getDate() + " " + clock;
      }

      function renderChatMessageTime(msg) {
        var iso = (msg && (msg.completedAt || msg.createdAt)) || "";
        var label = formatChatClock(iso);
        if (!label) return "";
        var title = "";
        try { title = new Date(iso).toLocaleString(); } catch (e) {}
        return '<div class="chat-message-time" title="' + escapeHtml(title) + '">' + escapeHtml(label) + '</div>';
      }

      // 群聊（AI 团队）里的发言人：像素猫头像 + 成员名，负责人带「负责人」标；
      // 有成员会话时名字可点，打开这位成员的完整过程。
      function teamAuthorAvatar(author) {
        var grid = catCoatGrid(memberCoatIndex({ id: author.id || "", name: author.name || "", avatar: author.avatar }));
        var svg = buildPixelSvg(grid.map(function(row) {
          return row.map(function(fill) { return fill || _AVATAR_T; });
        }));
        var name = escapeHtml(author.name || "成员");
        var nameHtml = author.sessionId
          ? '<button type="button" class="avatar-name chat-author-link" title="查看 ' + name + ' 的会话" onclick="__openAuthorSession(' + escapeHtml(JSON.stringify(author.sessionId)) + ')">' + name + '</button>'
          : '<span class="avatar-name">' + name + '</span>';
        return '<div class="chat-message-avatar assistant chat-message-author">' +
          renderAvatarFallback(svg) +
          nameHtml +
          (author.leader ? '<span class="chat-author-badge">负责人</span>' : '') +
        '</div>';
      }

      // 群聊进度提示：居中一行，不占气泡。
      function renderChatNotice(msg, messageIndex) {
        var text = turnPlainText(msg);
        if (!text) return "";
        var who = msg.author && msg.author.name ? '<span class="chat-notice-author">' + escapeHtml(msg.author.name) + '</span>' : "";
        var clock = formatChatClock((msg.completedAt || msg.createdAt) || "");
        return '<div class="chat-message chat-notice" data-message-key="' + escapeHtml(getMessageKey(msg, messageIndex)) + '">' +
          '<div class="chat-notice-line">' + who + '<span class="chat-notice-text">' + escapeHtml(text) + '</span>' +
            (clock ? '<span class="chat-notice-time">' + escapeHtml(clock) + '</span>' : '') +
          '</div>' +
        '</div>';
      }

      function turnPlainText(msg) {
        if (typeof msg.content === "string") return msg.content.trim();
        if (!Array.isArray(msg.content)) return "";
        return msg.content
          .filter(function(block) { return block && block.type === "text" && typeof block.text === "string"; })
          .map(function(block) { return block.text.trim(); })
          .filter(Boolean)
          .join("\n");
      }

      function chatAvatar(role, author?) {
        if (author && role === "assistant") return teamAuthorAvatar(author);
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        if (role === "assistant" && selectedSession && selectedSession.employeeId) {
          var currentEmployee = cachedSiliconEmployee(selectedSession.employeeId);
          var employee = {
            id: selectedSession.employeeId,
            name: currentEmployee?.name || selectedSession.employeeName || "硅基员工",
            avatar: currentEmployee ? currentEmployee.avatar : selectedSession.employeeAvatar || "",
          };
          var employeeAvatar = employee.avatar.startsWith("data:image/")
            ? '<img class="pixel-avatar-image" src="' + escapeHtml(employee.avatar) + '" alt="" />'
            : renderAvatarFallback(buildPixelSvg(catCoatGrid(memberCoatIndex(employee)).map(function(row) {
                return row.map(function(fill) { return fill || _AVATAR_T; });
              })));
          return '<div class="chat-message-avatar assistant">' + employeeAvatar +
            '<span class="avatar-name">' + escapeHtml(employee.name) + '</span></div>';
        }
        var personaRole = role === "user" ? "user" : "assistant";
        var persona = getStructuredChatPersona(personaRole);
        var avatarInner = persona.avatar
          ? '<img class="pixel-avatar-image" src="' + escapeHtml(persona.avatar) + '" alt="' + escapeHtml(persona.name) + '" onerror="handleChatAvatarImageError(this, ' + JSON.stringify(personaRole) + ')" />'
          : renderAvatarFallback(persona.avatarSvg);
        return '<div class="chat-message-avatar ' + role + '">' +
          avatarInner +
          '<span class="avatar-name">' + escapeHtml(persona.name) + '</span>' +
        '</div>';
      }

      function renderChatMessage(msg, roundUsage, messageIndex, agentRunIndex, conversationToolResults, isGrouped?) {
        if (msg.notice) return renderChatNotice(msg, messageIndex);
        // Thinking card (deep thought) — from PTY parsing
        if (msg.role === "thinking") {
          // 空 / 全空白的 thinking 没有任何信息量，渲染出来只是一条带"展开"的紫色窄条，
          // 展开了也看不到内容——直接跳过。
          var ptyThinkingText = typeof msg.content === "string" ? msg.content : "";
          if (!ptyThinkingText.trim()) return "";
          var thinkingKey = buildExpandKey("thinking", [renderMessageKey(msg, messageIndex), "pty"]);
          var thinkingPersisted = getPersistedExpandState(thinkingKey);
          var thinkingExpanded = thinkingPersisted === null ? getCardDefault("thinking") : thinkingPersisted;
          return '<div class="chat-message thinking">' +
            '<div class="thinking-inline thinking-pty ' + (thinkingExpanded ? 'expanded' : 'collapsed') + '" data-expand-kind="thinking" data-expand-key="' + escapeHtml(thinkingKey) + '" data-thinking="' + escapeHtml(ptyThinkingText) + '" onclick="__thinkingToggle(this)">' +
              '<span class="thinking-inline-icon">' + iconSvg("spark", { size: 12, strokeWidth: 1.8 }) + '</span>' +
              '<span class="thinking-inline-preview">' + escapeHtml(thinkingExpanded ? ptyThinkingText : '深度思考') + '</span>' +
              '<span class="thinking-inline-action">' + (thinkingExpanded ? '收起' : '展开') + '</span>' +
            '</div>' +
          '</div>';
        }

        // Prompt suggestion card (pulsing display) — from PTY parsing
        if (msg.role === "prompt") {
          return '<div class="chat-message prompt">' +
            '<div class="prompt-card">' +
              '<div class="prompt-icon">→</div>' +
              '<div class="prompt-content">试试：<span class="prompt-text">' + escapeHtml(msg.content) + '</span></div>' +
            '</div>' +
          '</div>';
        }

        // Structured content blocks (from JSON chat mode)
        if (Array.isArray(msg.content)) {
          return renderStructuredMessage(msg, roundUsage, messageIndex, agentRunIndex, conversationToolResults, isGrouped);
        }

        // Legacy string content (from PTY parsing)
        var avatar = isGrouped || msg.role === "user" ? "" : chatAvatar(msg.role);
        var bubbleContent = msg.role === "assistant"
          ? renderMarkdown(msg.content)
          : (msg.role === "user" ? renderUserText(msg.content) : escapeHtml(msg.content));
        var groupedAttr = isGrouped ? ' data-grouped="true"' : "";
        return '<div class="chat-message ' + msg.role + '"' + groupedAttr + ' data-role="' + escapeHtml(msg.role) + '">' +
          renderChatMessageTime(msg) +
          avatar +
          '<div class="chat-message-bubble">' + bubbleContent + '</div>' +
        '</div>';
      }

      function pickToolResultForDisplay(toolResults, toolUseId) {
        var entries = toolResults && toolUseId ? toolResults[toolUseId] : null;
        if (!entries || !entries.length) return null;
        for (var i = 0; i < entries.length - 1; i++) {
          if (isRecoverableToolError(entries[i], entries[i + 1])) {
            return entries[i + 1];
          }
        }
        return entries[entries.length - 1];
      }

      function hasRecoveredToolNoise(toolResults, toolUseId) {
        var entries = toolResults && toolUseId ? toolResults[toolUseId] : null;
        if (!entries || entries.length < 2) return false;
        for (var i = 0; i < entries.length - 1; i++) {
          if (isRecoverableToolError(entries[i], entries[i + 1])) {
            return true;
          }
        }
        return false;
      }

      function renderRecoveredToolHint(toolName) {
        return '<div class="structured-tool-hint">已自动恢复一次 ' + escapeHtml(getToolDisplayName(toolName)) + ' 参数问题</div>';
      }

      // 独立交互卡与图片卡不进活动摘要，照原内容顺序渲染。
      function passthroughToolBlocks(content) {
        var groups = [];
        for (var i = 0; i < content.length; i++) {
          var block = content[i];
          if (block && block.type === "tool_result") continue;
          groups.push({ type: "single", block: block, index: i });
        }
        return groups;
      }

      // 折叠态：隐藏摘要卡之后的所有兄弟（DOM 顺序 newest→oldest，摘要卡之后 = 历史区），
      // 但保留「加载更早」哨兵可见。
      function applyHistoryHiddenState(summaryEl, expanded) {
        var node = summaryEl.nextElementSibling;
        while (node) {
          if (!node.classList.contains("chat-load-more")) {
            if (expanded) node.classList.remove("chat-history-hidden");
            else node.classList.add("chat-history-hidden");
          }
          node = node.nextElementSibling;
        }
      }

      // ===== 自动折叠横条（已禁用）=====
      // 保留清理入口，用来移除旧版本可能已经插入 DOM 的顶部固定横条和隐藏态。
      function applyAutoFoldBar(chatOutput, chatMessages, allMessages, renderIsInitial) {
        void allMessages;
        void renderIsInitial;
        if (!chatOutput || !chatMessages) return;
        setAutoFoldMode(chatOutput, chatMessages, false);
        clearAutoFoldHistoryHidden(chatMessages);
        clearAutoFoldBar(chatOutput);
      }

      function setAutoFoldMode(chatOutput, chatMessages, enabled) {
        if (!chatOutput) return;
        chatOutput.classList.toggle("auto-fold", !!enabled);
      }

      function clearAutoFoldHistoryHidden(chatMessages) {
        if (!chatMessages) return;
        var hidden = chatMessages.querySelectorAll(".chat-auto-fold-hidden");
        for (var i = 0; i < hidden.length; i++) hidden[i].classList.remove("chat-auto-fold-hidden");
      }

      function clearAutoFoldBar(chatOutput) {
        if (!chatOutput) return;
        var bar = chatOutput.querySelector("#chat-fold-bar");
        if (!bar) return;
        bar.innerHTML = "";
        bar.classList.add("hidden");
      }

      function getMessagePreviewText(msg) {
        if (!msg) return "";
        var parts = [];
        function pushText(value) {
          if (typeof value !== "string") return;
          var cleaned = value.replace(/\s+/g, " ").trim();
          if (cleaned) parts.push(cleaned);
        }
        if (typeof msg.content === "string") {
          pushText(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (var i = 0; i < msg.content.length && parts.join(" ").length < 180; i++) {
            var block = msg.content[i];
            if (!block) continue;
            if (block.type === "text") pushText(block.text);
            else if (block.type === "thinking") pushText(block.thinking);
            else if (block.type === "tool_use") pushText(block.name ? ("调用 " + block.name) : "工具调用");
            else if (block.type === "tool_result") pushText(block.is_error ? "工具返回错误" : "工具返回结果");
            else if (block.text) pushText(block.text);
          }
        }
        var text = parts.join(" · ");
        return text.length > 180 ? text.slice(0, 177) + "..." : text;
      }

      function applyHistoryCollapse(chatMessages, selectedSession) {
        if (!chatMessages) return;
        var allMessages = state.currentMessages || [];
        var lastUserIdx = -1;
        for (var i = allMessages.length - 1; i >= 0; i--) {
          if (allMessages[i] && allMessages[i].role === "user") { lastUserIdx = i; break; }
        }

        function clearAll() {
          var prev = chatMessages.querySelector(".chat-history-summary");
          if (prev) prev.remove();
          var hidden = chatMessages.querySelectorAll(".chat-history-hidden");
          for (var h = 0; h < hidden.length; h++) hidden[h].classList.remove("chat-history-hidden");
          chatMessages.removeAttribute("data-history-sig");
        }
        clearAll();

        var msgEls = chatMessages.querySelectorAll(".chat-message.assistant[data-msg-index]");
        for (var m = 0; m < msgEls.length; m++) {
          var el = msgEls[m];
          var idx = parseInt(el.getAttribute("data-msg-index") || "", 10);
          if (isNaN(idx) || !allMessages[idx] || allMessages[idx].role !== "assistant") continue;
          if (isToolActivityOnly(allMessages[idx].content || [])) {
            el.querySelector(":scope > .assistant-reply-disclosure")?.remove();
            el.classList.remove("assistant-reply-collapsed", "assistant-reply-expanded");
            continue;
          }
          var historical = idx < lastUserIdx;
          var key = buildExpandKey(historical ? "assistant-reply-history" : "assistant-reply-current", [renderMessageKey(allMessages[idx], idx)]);
          var persisted = getPersistedExpandState(key);
          var disclosure = el.querySelector(":scope > .assistant-reply-disclosure");
          // Same-owner soft/full paint keeps the current user's choice, including
          // the current→history boundary. Initial defaults remain unchanged.
          var expanded = disclosure ? disclosure.getAttribute("aria-expanded") === "true"
            : persisted === null ? true : persisted;
          if (!disclosure) {
            disclosure = document.createElement("button");
            disclosure.className = "assistant-reply-disclosure";
            disclosure.setAttribute("type", "button");
            el.insertBefore(disclosure, el.firstChild);
          }
          disclosure.setAttribute("data-expand-key", key);
          disclosure.setAttribute("aria-expanded", expanded ? "true" : "false");
          var previewText = getMessagePreviewText(allMessages[idx]) || "助手回复";
          var disclosureHtml =
            '<span class="assistant-reply-label">回复</span>' +
            '<span class="assistant-reply-preview" title="' + escapeHtml(previewText) + '">' + escapeHtml(previewText) + '</span>' +
            '<span class="assistant-reply-action">' + (expanded ? "收起" : "展开") + '</span>' +
            '<span class="assistant-reply-chevron">' + iconSvg("chevronDown", { size: 15 }) + '</span>';
          if (typeof HTMLElement !== "undefined") patchChatContents(disclosure, disclosureHtml);
          else disclosure.innerHTML = disclosureHtml;
          el.classList.toggle("assistant-reply-collapsed", !expanded);
          el.classList.toggle("assistant-reply-expanded", expanded);
          disclosure.onclick = function() {
            var parent = this.parentElement;
            var nextExpanded = parent.classList.contains("assistant-reply-collapsed");
            parent.classList.toggle("assistant-reply-collapsed", !nextExpanded);
            parent.classList.toggle("assistant-reply-expanded", nextExpanded);
            this.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
            var action = this.querySelector(".assistant-reply-action");
            if (action) action.textContent = nextExpanded ? "收起" : "展开";
            setPersistedExpandState(this.getAttribute("data-expand-key"), nextExpanded);
          };
        }
      }

      window.__historySummaryToggle = function(btn) {
        var wrap = btn && btn.closest ? btn.closest(".chat-history-summary") : null;
        if (!wrap) return;
        var key = wrap.getAttribute("data-expand-key");
        var nowExpanded = wrap.getAttribute("data-expanded") !== "true";
        wrap.setAttribute("data-expanded", nowExpanded ? "true" : "false");
        btn.setAttribute("aria-expanded", nowExpanded ? "true" : "false");
        var title = wrap.querySelector(".chat-history-summary-title");
        if (title) title.textContent = nowExpanded ? t("history.collapse") : t("history.expand");
        if (key) setPersistedExpandState(key, nowExpanded);
        applyHistoryHiddenState(wrap, nowExpanded);
        var container = wrap.parentElement;
        if (nowExpanded) {
          clearAutoFoldHistoryHidden(container);
        }
        // 同步父容器签名里的 expanded 段，避免下一次 render 因签名不符整卡重建（会闪一下）。
        if (container) {
          var sig = container.getAttribute("data-history-sig");
          if (sig) {
            var segs = sig.split(":");
            if (segs.length >= 3) {
              segs[2] = nowExpanded ? "1" : "0";
              container.setAttribute("data-history-sig", segs.join(":"));
            }
          }
        }
      };

      // ===== 普通活动轨迹 =================================================
      // 相邻 thinking / 普通工具调用共用一行摘要；正文出现就切断当前轨迹。
      // Agent Run 有自己的摘要 + 轨迹容器，不进入这里。
      var ACTIVITY_FOLD_ENABLED = true;
      // 当前正在渲染的消息在 state.currentMessages 里的全局下标。渲染是同步单线程的，
      // 在 renderStructuredMessage 入口设置一次即可让下游活动折叠判断运行态。
      var _currentMessageGlobalIndex = -1;
      // 最后一条真人文本轮（语义同 Android collectSubagentActivities 的 lastHumanTurn）
      // 与本会话是否在跑：Agent Run 的状态判定只看这两个事实，不再看「是不是最新那个 run」，
      // 否则历史 run 会被误标「已中断」，和 Android 同一份历史显示不一致。
      var _currentLastUserTextMessageIndex = -1;
      var _currentSessionRunning = false;
      var _currentActivitySessionBusy = false;
      var _currentLatestAssistantMessageIndex = -1;
      var _currentLatestPendingCommandId = "";

      // Agent dispatch 和 tool_result 都由 Run 或对应 tool card 消费，普通活动轨迹
      // 不应再把它们当成独立可见步骤。
      function isHiddenActivityBlock(block) {
        if (!block) return true;
        if (block.type === "thinking") {
          return !String(block.thinking || "").trim() &&
            !isTurnActivityLive(_currentMessageGlobalIndex);
        }
        if (block.type === "tool_use" && deriveSubagentMeta(block)) return true;
        if (block.type === "tool_result") return true;
        return false;
      }

      function isFoldableActivityBlock(block) {
        if (!block) return false;
        if (block.type === "thinking") return true;
        if (block.type === "tool_use") {
          // 服务端只给可延后载入的普通工具附 activity；独立交互和图片卡保持原位。
          return !!block.activity;
        }
        return false;
      }

      function truncateInline(value, max) {
        var text = String(value || "").replace(/\s+/g, " ").trim();
        if (!text) return "";
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
      }

      function tailInline(value, max) {
        var text = String(value || "").replace(/\s+/g, " ").trim();
        if (!text) return "";
        return text.length > max ? "…" + text.slice(-(max - 1)) : text;
      }

      // 单条活动的「人类可读」描述，用作折叠条的最新内容文本。
      function activityItemLabel(block) {
        if (!block) return "";
        if (block.type === "thinking") {
          var think = tailInline(block.thinking, 240);
          return think || "深度思考";
        }
        if (block.type !== "tool_use") return "";
        var name = block.name || "工具";
        var input = block.input || {};
        if (name === "Bash") {
          var cmd = input.command || input.cmd || "";
          return cmd ? "运行 " + truncateInline(cmd, 240) : "运行命令";
        }
        if (name === "Read") {
          var readPath = input.file_path || input.path || "";
          return readPath ? "读取 " + truncateInline(readPath, 240) : "读取文件";
        }
        if (name === "Grep" || name === "Glob" || name === "WebSearch") {
          var q = input.pattern || input.query || "";
          return q ? "搜索 " + truncateInline(q, 240) : "搜索";
        }
        if (name === "WebFetch") {
          var url = input.url || "";
          return url ? "抓取 " + truncateInline(url, 240) : "抓取网页";
        }
        if (name === "Edit" || name === "Write" || name === "MultiEdit") {
          var editPath = input.file_path || input.path || "";
          var verb = name === "Write" ? "写入 " : "修改 ";
          return verb + (editPath ? truncateInline(editPath, 240) : "文件");
        }
        return getToolDisplayName(name);
      }

      var ACTIVITY_KIND_META = {
        edit_file: { summary: "修改了", unit: "个文件", item: "修改文件" },
        read_file: { summary: "查看了", unit: "个文件", item: "查看文件" },
        run_command: { summary: "运行了", unit: "条命令", item: "运行命令" },
        other: { summary: "使用了", unit: "次工具", item: "使用工具" },
      };

      // Thinking 自身只在当前轮最新 assistant 消息的尾段活跃；命令运行态
      // 另由最新未返回的 tool id 决定，允许命令后继续出现 thinking。
      function isTurnActivityLive(messageIndex) {
        return _currentActivitySessionBusy && messageIndex === _currentLatestAssistantMessageIndex;
      }

      function summarizeActivityRun(items) {
        var groups = groupToolActivities(items);
        var thinking = items.filter(function(item) { return item.block.type === "thinking"; });
        var parts = [];
        for (var j = 0; j < TOOL_ACTIVITY_KINDS.length; j++) {
          var summaryKind = TOOL_ACTIVITY_KINDS[j];
          var count = groups[summaryKind].length;
          if (count > 0) {
            var kindMeta = ACTIVITY_KIND_META[summaryKind];
            parts.push({ kind: summaryKind, text: kindMeta.summary + count + kindMeta.unit });
          }
        }
        return { groups: groups, parts: parts, thinking: thinking,
          latestCommandAt: latestCommandOccurredAt(groups.run_command) };
      }

      function formatActivityEventTime(occurredAt) {
        var date = new Date(occurredAt);
        if (!Number.isFinite(date.getTime())) return "";
        return date.toLocaleTimeString(undefined, {
          hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        });
      }

      /** Existing tool renderers still use their own defaults outside the activity menu. */
      function resolveCardExpanded(persisted, opts, index, fallback) {
        void opts;
        void index;
        return persisted !== null && persisted !== undefined ? persisted : fallback;
      }

      function activityDetailCacheKey(sessionId, toolId) {
        return String(sessionId || "") + ":" + String(toolId || "");
      }

      function fetchActivityToolDetail(sessionId, toolId, openScope?: object) {
        if (!sessionId || !toolId) return Promise.reject(new Error("工具详情不可用"));
        var cacheKey = activityDetailCacheKey(sessionId, toolId);
        var cached = state.toolContentCache[cacheKey];
        if (cached && Object.prototype.hasOwnProperty.call(cached, "input")) {
          return Promise.resolve(cached);
        }
        var inFlight = activityDetailRequests.get(cacheKey);
        if (inFlight && activityRequestScopes.get(cacheKey) === openScope &&
          (typeof HTMLElement === "undefined" || isChatLeaseCurrent(activityRequestLeases.get(cacheKey)))) return inFlight;
        var requestedEpoch = activityDetailEpoch;
        var requestedView = typeof HTMLElement !== "undefined" ? chatViewLease() : null;
        var request = fetch("/api/sessions/" + encodeURIComponent(sessionId) +
          "/tool-content/" + encodeURIComponent(toolId), { credentials: "same-origin" })
          .then(function(response) { return parseJsonResponse<any>(response); })
          .then(function(data) {
            if (requestedEpoch !== activityDetailEpoch || state.selectedId !== sessionId ||
              activityDetailRequests.get(cacheKey) !== request ||
              typeof HTMLElement !== "undefined" && !isChatLeaseCurrent(requestedView)) return data;
            if (data && data.pending) activityPendingDetails.set(cacheKey, data);
            else {
              state.toolContentCache[cacheKey] = data;
              activityPendingDetails.delete(cacheKey);
            }
            return data;
          })
          .finally(function() {
            if (activityDetailRequests.get(cacheKey) === request) {
              activityDetailRequests.delete(cacheKey);
              activityRequestLeases.delete(cacheKey);
              activityRequestScopes.delete(cacheKey);
            }
          });
        activityDetailRequests.set(cacheKey, request);
        activityRequestLeases.set(cacheKey, requestedView);
        activityRequestScopes.set(cacheKey, openScope);
        return request;
      }

      function renderActivityEntryDetails(entry, messageKey, segmentFirstIndex, toolResults, running, entryKey) {
        var entryState = activityEntryStates.get(entryKey);
        if (entryState?.error) return '<button type="button" class="chat-activity-retry" onclick="__activityEntryRetry(this)">' +
          escapeHtml(entryState.error) + '，点击重试</button>';
        if (!entry.calls.some(function(call) { return !!call.block?.id; })) return "这条调用没有可读取的详情。";
        var content = "";
        for (var c = 0; c < entry.calls.length; c++) {
          var call = entry.calls[c];
          var block = call.block;
          var cacheKey = activityDetailCacheKey(state.selectedId, block.id);
          var detail = state.toolContentCache[cacheKey] || activityPendingDetails.get(cacheKey);
          if (!detail || !Object.prototype.hasOwnProperty.call(detail, "input")) {
            content += '<div class="chat-activity-loading">加载详情…</div>';
            continue;
          }
          if (detail.pending && pickToolResultForDisplay(toolResults, block.id) &&
            !entryState?.request && !activityResultRefreshRequested.has(cacheKey)) {
            // A result arrived after an already-open running detail. Refresh it once,
            // using the same on-demand endpoint; unopened entries never request data.
            activityResultRefreshRequested.add(cacheKey);
            var sessionId = state.selectedId;
            if (entryState) {
              var resultRequest = {};
              entryState.request = resultRequest;
              fetchActivityToolDetail(sessionId, block.id, resultRequest).then(function() {
                if (!currentActivityEntry(entryKey, entryState) || entryState.request !== resultRequest) return;
                entryState.request = null;
                renderChat(true);
              }).catch(function(error) {
                if (!currentActivityEntry(entryKey, entryState) || entryState.request !== resultRequest) return;
                entryState.request = null;
                entryState.error = String(error && error.message || "加载失败");
                renderChat(true);
              });
            }
          }
          if (detail.pending) {
            content += '<div class="chat-activity-pending-detail">' +
              '<div class="chat-activity-pending-label">' + (running ? "执行中" : "结果未返回") + '</div>' +
              '<pre class="tool-use-content">' + escapeHtml(JSON.stringify(detail.input || {}, null, 2)) + '</pre>' +
            '</div>';
            continue;
          }
          var hydrated = Object.assign({}, block, { input: detail.input || {} });
          var results = {} as any;
          if (detail.resultAvailable !== false && !detail.pending) {
            results[block.id] = [{
              type: "tool_result",
              tool_use_id: block.id,
              content: detail.content,
              is_error: !!detail.is_error,
            }];
          }
          content += renderContentBlock(hydrated, "assistant", results,
            call.index + segmentFirstIndex, messageKey,
            { noActivityFold: true, forceExpandedToolBodies: true });
        }
        return content;
      }

      function renderActivityFold(items, role, toolResults, messageKey, segmentFirstIndex, options?: any) {
        var opts = options || {};
        var summary = summarizeActivityRun(items);
        if (!summary.parts.length && !summary.thinking.length) return "";
        var commandRunning = _currentActivitySessionBusy && !!_currentLatestPendingCommandId &&
          summary.groups.run_command.some(function(entry) {
            return entry.calls.some(function(call) {
              return call.block.id === _currentLatestPendingCommandId;
            });
          });
        var runningCommandAt = commandRunning
          ? commandOccurredAt(summary.groups.run_command, _currentLatestPendingCommandId)
          : null;
        var latestBlock = items.length ? items[items.length - 1].block : null;
        var thinkingRunning = !commandRunning && !!opts.isTrailing &&
          latestBlock?.type === "thinking" && isTurnActivityLive(_currentMessageGlobalIndex);
        var groupKey = activityGroupKey(items, messageKey, segmentFirstIndex);
        var expandKey = buildExpandKey("activity-menu", [groupKey]);
        var persisted = getPersistedExpandState(expandKey);
        var expanded = persisted === true;
        var menuHtml = "";
        var timeline = toolActivityTimeline(items);
        for (var k = 0; k < timeline.length; k++) {
          var call = timeline[k];
          var block = call.block;
          var isThinking = block.type === "thinking";
          var kind = block.activity?.kind || "other";
          var callScope = renderBlockScope(messageKey, call.index + segmentFirstIndex, block);
          var entryKey = buildExpandKey(isThinking ? "activity-thinking" : "activity-detail",
            [state.selectedId, groupKey, callScope]);
          var entryOpen = activityDetailOpen.has(entryKey);
          var entryRunning = isThinking ? thinkingRunning && block === latestBlock
            : commandRunning && block.id === _currentLatestPendingCommandId;
          var result = isThinking ? null : pickToolResultForDisplay(toolResults, block.id);
          var status = entryRunning ? "运行中" : result?.is_error ? "失败" : result ? "完成" : "未返回";
          var itemLabel = isThinking ? "深度思考" : block.activity?.label ||
            (ACTIVITY_KIND_META[kind]?.item || "调用") + " · " + (block.name || "工具");
          var occurredAt = block.activity?.occurredAt;
          var itemClock = occurredAt ? formatActivityEventTime(occurredAt) : "";
          var detailHtml = "";
          if (entryOpen && expanded) {
            detailHtml = isThinking
              ? '<div class="chat-activity-thinking-content">' +
                escapeHtml(block.thinking || "思考内容尚未到达。") + '</div>'
              : renderActivityEntryDetails({ calls: [call] }, messageKey, segmentFirstIndex,
                toolResults, entryRunning, entryKey);
          }
          menuHtml += '<div class="chat-activity-entry" role="listitem" data-entry-key="' + escapeHtml(entryKey) +
            (isThinking ? '" data-thinking-entry="true' : '" data-tool-ids="' +
              escapeHtml(JSON.stringify(block.id ? [String(block.id)] : []))) +
            '" data-expanded="' + (entryOpen ? "true" : "false") + '">' +
              '<button type="button" class="chat-activity-entry-button" aria-expanded="' +
                (entryOpen ? "true" : "false") + '" onclick="__activityEntryToggle(this)">' +
                '<span class="chat-activity-entry-dot' + (entryRunning ? ' is-active' : '') + '" aria-hidden="true"></span>' +
                (itemClock ? '<time class="chat-activity-entry-time" datetime="' + escapeHtml(occurredAt) + '">' +
                  escapeHtml(itemClock) + '</time>' : '') +
                '<span class="chat-activity-entry-label">' + escapeHtml(itemLabel) + '</span>' +
                (isThinking && !entryRunning ? '' : '<span class="chat-activity-entry-status' +
                  (result?.is_error ? ' is-error' : '') + '">' + escapeHtml(status) + '</span>') +
                '<span class="chat-activity-entry-arrow">' + iconSvg("chevronDown", { size: 13 }) + '</span>' +
              '</button>' +
              '<div class="chat-activity-entry-detail"' + (entryOpen ? '' : ' inert aria-hidden="true"') + '>' +
                '<div class="chat-activity-detail-content">' + detailHtml + '</div></div>' +
            '</div>';
        }

        var summaryItems = [];
        // 收起态的时间列：最新的真实命令时间排在这一行最前，和展开行的时间同一个位置。
        var leadClockAt = summary.latestCommandAt;
        var leadClock = leadClockAt ? formatActivityEventTime(leadClockAt) : "";
        var leadClockHtml = leadClock ? '<time class="chat-activity-command-time" datetime="' +
          escapeHtml(leadClockAt) + '" title="最近命令 ' +
          escapeHtml(new Date(leadClockAt).toLocaleString()) + '">' + escapeHtml(leadClock) + '</time>' : "";
        if (summary.thinking.length) {
          summaryItems.push('<span class="chat-activity-meta-item is-thinking' +
            (thinkingRunning ? ' is-active' : '') + '">' +
            (thinkingRunning ? "正在思考" : "深度思考") + '</span>');
        }
        for (var p = 0; p < summary.parts.length; p++) {
          var part = summary.parts[p];
          var itemHtml = '<span class="chat-activity-meta-item' +
            (part.kind === "run_command" ? ' is-command' : '') + '">' + escapeHtml(part.text);
          if (part.kind === "run_command" && commandRunning) {
            itemHtml += '<span class="chat-activity-command-indicator" aria-hidden="true"></span>' +
              '<span class="chat-activity-command-running">运行中</span>';
            if (runningCommandAt) {
              itemHtml += '<span class="chat-activity-command-elapsed" data-started-at="' +
                escapeHtml(runningCommandAt) + '">已等待 ' +
                formatActivityElapsed(Date.now() - Date.parse(runningCommandAt)) + '</span>';
            }
          }
          summaryItems.push(itemHtml + '</span>');
        }

        return '<div class="chat-activity' + (commandRunning ? ' is-command-running' : '') +
            (thinkingRunning ? ' is-thinking-running' : '') + '" ' +
            'data-expand-kind="activity" ' +
            'data-expand-key="' + escapeHtml(expandKey) + '" ' +
            'data-expanded="' + (expanded ? "true" : "false") + '">' +
          '<button type="button" class="chat-activity-summary" aria-expanded="' + (expanded ? "true" : "false") + '" onclick="__activityToggle(this)">' +
            '<span class="chat-activity-meta">' + leadClockHtml + summaryItems.join(
              '<span class="chat-activity-separator" aria-hidden="true">·</span>') + '</span>' +
            '<span class="chat-activity-chevron">' + iconSvg("chevronDown", { size: 13, strokeWidth: 2 }) + '</span>' +
          '</button>' +
          '<div class="chat-activity-menu"' + (expanded ? '' : ' inert aria-hidden="true"') + '>' +
            '<div class="chat-activity-menu-inner"><div class="chat-activity-timeline" role="list" aria-label="工具调用时间线">' +
              menuHtml + '</div></div></div>' +
        '</div>';
      }

      function closeActivityMenu(wrap, restoreFocus) {
        if (!wrap || wrap.getAttribute("data-expanded") !== "true") return;
        wrap.setAttribute("data-expanded", "false");
        var menu = wrap.querySelector(".chat-activity-menu");
        var summary = wrap.querySelector(".chat-activity-summary");
        if (menu) { menu.inert = true; menu.setAttribute("aria-hidden", "true"); }
        var openEntries = wrap.querySelectorAll('.chat-activity-entry[data-expanded="true"]');
        for (var i = 0; i < openEntries.length; i++) {
          var entry = openEntries[i];
          var entryKey = entry.getAttribute("data-entry-key") || "";
          activityDetailOpen.delete(entryKey);
          activityEntryStates.delete(entryKey);
          entry.setAttribute("data-expanded", "false");
          var entryButton = entry.querySelector(".chat-activity-entry-button");
          var entryDetail = entry.querySelector(".chat-activity-entry-detail");
          if (entryButton) entryButton.setAttribute("aria-expanded", "false");
          if (entryDetail) { entryDetail.inert = true; entryDetail.setAttribute("aria-hidden", "true"); }
        }
        if (summary) {
          summary.setAttribute("aria-expanded", "false");
          if (restoreFocus) summary.focus({ preventScroll: true });
        }
        var key = wrap.getAttribute("data-expand-key");
        if (key) setPersistedExpandState(key, false);
      }

      (window as any).__activityToggle = function(btn) {
        var wrap = btn && btn.closest ? btn.closest(".chat-activity") : null;
        if (!wrap) return;
        var nowExpanded = wrap.getAttribute("data-expanded") !== "true";
        if (!nowExpanded) {
          closeActivityMenu(wrap, false);
          return;
        }
        var openMenus = document.querySelectorAll('.chat-activity[data-expanded="true"]');
        for (var i = 0; i < openMenus.length; i++) closeActivityMenu(openMenus[i], false);
        wrap.setAttribute("data-expanded", "true");
        btn.setAttribute("aria-expanded", "true");
        var menu = wrap.querySelector(".chat-activity-menu");
        if (menu) { menu.inert = false; menu.removeAttribute("aria-hidden"); }
        var key = wrap.getAttribute("data-expand-key");
        if (key) setPersistedExpandState(key, true);
      };

      (window as any).__activityEntryToggle = function(btn) {
        var row = btn && btn.closest ? btn.closest(".chat-activity-entry") : null;
        if (!row) return;
        var key = row.getAttribute("data-entry-key") || "";
        var detail = row.querySelector(".chat-activity-entry-detail");
        var nowExpanded = row.getAttribute("data-expanded") !== "true";
        row.setAttribute("data-expanded", nowExpanded ? "true" : "false");
        btn.setAttribute("aria-expanded", nowExpanded ? "true" : "false");
        if (detail) {
          detail.inert = !nowExpanded;
          if (nowExpanded) detail.removeAttribute("aria-hidden");
          else detail.setAttribute("aria-hidden", "true");
        }
        if (!nowExpanded) {
          activityDetailOpen.delete(key);
          activityEntryStates.delete(key);
          return;
        }
        activityDetailOpen.add(key);
        if (row.getAttribute("data-thinking-entry") === "true") { renderChat(true); return; }
        var view = chatViewLease();
        if (!view) return;
        activityEntryStates.set(key, { lease: view, open: {}, request: null, error: null });
        requestActivityEntry(key, row);
      };

      function currentActivityEntry(key, entryState) {
        if (activityEntryStates.get(key) !== entryState || !activityDetailOpen.has(key) ||
          !isChatLeaseCurrent(entryState.lease)) return null;
        var entries = entryState.lease.root.querySelectorAll(".chat-activity-entry");
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].getAttribute("data-entry-key") === key && entries[i].getAttribute("data-expanded") === "true" &&
            entries[i].closest('.chat-activity[data-expanded="true"]')) return entries[i];
        }
        return null;
      }
      function requestActivityEntry(key, row) {
        var entryState = activityEntryStates.get(key);
        if (!entryState || !currentActivityEntry(key, entryState)) return;
        var sessionId = state.selectedId;
        var ids: string[] = [];
        try { ids = JSON.parse(row.getAttribute("data-tool-ids") || "[]"); } catch (_e) {}
        var requestToken = {};
        entryState.request = requestToken;
        entryState.error = null;
        // Same paint transaction retires a focused retry with the exact entry fallback.
        renderChat(true);
        if (!ids.length) return;
        Promise.all(ids.map(function(id) { return fetchActivityToolDetail(sessionId, id, requestToken); }))
          .then(function() {
            if (!currentActivityEntry(key, entryState) || entryState.request !== requestToken) return;
            entryState.request = null;
            renderChat(true);
          })
          .catch(function(error) {
            if (!currentActivityEntry(key, entryState) || entryState.request !== requestToken) return;
            entryState.request = null;
            entryState.error = String(error && error.message || "加载失败");
            renderChat(true);
          });
      }
      (window as any).__activityEntryRetry = function(btn) {
        var row = btn && btn.closest ? btn.closest(".chat-activity-entry") : null;
        if (!row) return;
        requestActivityEntry(row.getAttribute("data-entry-key") || "", row);
      };

      if (!(window as any).__activityDismissBound) {
        (window as any).__activityDismissBound = true;
        document.addEventListener("pointerdown", function(event) {
          var target = event.target as HTMLElement;
          if (target && target.closest && target.closest(".chat-activity")) return;
          var openMenus = document.querySelectorAll('.chat-activity[data-expanded="true"]');
          for (var i = 0; i < openMenus.length; i++) closeActivityMenu(openMenus[i], false);
        });
        document.addEventListener("keydown", function(event) {
          if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
          var target = event.target as HTMLElement;
          var active = document.activeElement as HTMLElement;
          if (!target?.closest || target !== active && !target.contains(active)) return;
          var openMenu = target.closest('.chat-activity[data-expanded="true"]');
          if (!openMenu || target.closest('[role="dialog"], dialog, [aria-modal="true"]')) return;
          closeActivityMenu(openMenu, true);
          event.preventDefault();
        });
      }

      // 渲染一组普通（非 Agent Run）内容 blocks。只有带轻量 activity 元数据的
      // 调用进入摘要；交互式/图片工具和普通正文保持原位。
      function buildSegmentBlocksHtml(segmentBlocks, segmentFirstIndex, role, toolResults, messageKey, options?: any) {
        var html = "";
        var opts = options || {};
        // 连续普通工具调用收成一行摘要；其余内容保持原位。
        if (ACTIVITY_FOLD_ENABLED && !opts.noActivityFold && role === "assistant") {
          try {
            var pendingActivity = [];
            var flushPendingActivity = function(isTrailing) {
              if (!pendingActivity.length) return;
              html += renderActivityFold(
                pendingActivity,
                role,
                toolResults,
                messageKey,
                segmentFirstIndex,
                Object.assign({}, opts, { isTrailing: !!isTrailing })
              );
              pendingActivity = [];
            };
            for (var fi = 0; fi < segmentBlocks.length; fi++) {
              var fBlock = segmentBlocks[fi];
              if (isHiddenActivityBlock(fBlock)) continue;
              if (isFoldableActivityBlock(fBlock)) {
                pendingActivity.push({ block: fBlock, index: fi });
              } else {
                flushPendingActivity(false);
                html += renderContentBlock(fBlock, role, toolResults, fi + segmentFirstIndex, messageKey, opts);
              }
            }
            flushPendingActivity(true);
            return html;
          } catch (e) {
            html = "";
          }
        }
        try {
          var groups = passthroughToolBlocks(segmentBlocks);
          for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            try {
              html += renderContentBlock(grp.block, role, toolResults,
                grp.index + segmentFirstIndex, messageKey, opts);
            } catch (e) {
              html += '<div class="render-error">消息块渲染失败</div>';
            }
          }
        } catch (e) {
          html += '<div class="render-error">消息渲染失败</div>';
        }
        return html;
      }

      function renderStructuredMessage(msg, roundUsage, messageIndex, agentRunIndex, conversationToolResults, isGrouped?) {
        _currentMessageGlobalIndex = typeof messageIndex === "number" ? messageIndex : -1;
        var role = msg.role;
        var messageKey = renderMessageKey(msg, messageIndex);
        var timeHtml = renderChatMessageTime(msg);
        var usageHtml = role === "assistant" ? renderUsageSummaryHtml(roundUsage) : "";
        var content = Array.isArray(msg.content) ? msg.content : [];
        var isQueued = role === "user" && content.some(function(b) { return b && b.__queued; });
        var activityOnly = role === "assistant" && isToolActivityOnly(content);
        var avatarHtml = (isGrouped || role === "user" || activityOnly) ? "" : chatAvatar(role, msg.author);
        var groupedAttr = isGrouped ? ' data-grouped="true"' : "";

        if (content.length === 0) {
          if (role === "assistant") {
            return '<div class="chat-message ' + role + '"' + groupedAttr + ' data-role="' + escapeHtml(role) + '">' +
              timeHtml +
              avatarHtml +
              '<div class="chat-message-content"><div class="typing-indicator"><span></span><span></span><span></span></div>' + usageHtml + '</div>' +
            '</div>';
          }
          return '<div class="chat-message ' + role + ' empty-message"' + groupedAttr + ' data-role="' + escapeHtml(role) + '" data-message-key="' + escapeHtml(messageKey) + '">' +
            timeHtml +
            avatarHtml +
            '<div class="chat-message-content"><span class="empty-message-hint">（空消息）</span></div>' +
          '</div>';
        }

        var bodyHtml = "";
        var pendingBlocks = [];
        var pendingFirstIndex = 0;
        var messageRuns = agentRunIndex && agentRunIndex.runsByMessageIndex
          ? agentRunIndex.runsByMessageIndex.get(messageIndex)
          : null;
        var ownerByBlockKey = agentRunIndex ? agentRunIndex.ownerByBlockKey : null;

        function flushPendingBlocks() {
          if (!pendingBlocks.length) return;
          bodyHtml += buildSegmentBlocksHtml(
            pendingBlocks,
            pendingFirstIndex,
            role,
            conversationToolResults,
            messageKey
          );
          pendingBlocks = [];
        }

        for (var bi = 0; bi < content.length; bi++) {
          var run = messageRuns ? messageRuns.get(bi) : null;
          if (run) {
            flushPendingBlocks();
            bodyHtml += renderAgentRunHtml(
              run,
              agentRunActivity(run),
              role,
              conversationToolResults,
              messageKey
            );
            continue;
          }
          if (ownerByBlockKey && ownerByBlockKey.has(agentRunBlockKey(messageIndex, bi))) {
            flushPendingBlocks();
            continue;
          }
          if (!pendingBlocks.length) pendingFirstIndex = bi;
          pendingBlocks.push(content[bi]);
        }
        flushPendingBlocks();

        // 跨 turn 到达的 Agent result 只负责回填原 Run，不再在结果消息里生成一张孤立卡片。
        if (!bodyHtml || !bodyHtml.trim()) {
          return '<div class="chat-message agent-run-owned" data-message-key="' + escapeHtml(messageKey) + '" hidden></div>';
        }

        var queuedClass = (isQueued ? " queued" : "") + (activityOnly ? " activity-only" : "");
        var queuedBadge = isQueued ? '<span class="queued-badge">排队中</span>' : "";
        return '<div class="chat-message ' + role + queuedClass + '"' + groupedAttr + ' data-role="' + escapeHtml(role) + '" data-message-key="' + escapeHtml(messageKey) + '">' +
          timeHtml +
          avatarHtml +
          '<div class="chat-message-content">' + bodyHtml + queuedBadge + usageHtml + '</div>' +
        '</div>';
      }

      function compactUsageNumber(value) {
        if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
        if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, "") + "k";
        return String(Math.max(0, Math.round(value || 0)));
      }

      function renderUsageSummaryHtml(usage) {
        if (!usage) return "";
        var estimated = usage.estimated === true;
        var parts = [];
        if ((usage.inputTokens || 0) > 0) parts.push("输入 " + compactUsageNumber(usage.inputTokens));
        if ((usage.cacheReadInputTokens || 0) > 0) parts.push("缓存命中 " + compactUsageNumber(usage.cacheReadInputTokens));
        if ((usage.cacheCreationInputTokens || 0) > 0) parts.push("缓存写入 " + compactUsageNumber(usage.cacheCreationInputTokens));
        if ((usage.outputTokens || 0) > 0) parts.push("输出 " + (estimated ? "≈" : "") + compactUsageNumber(usage.outputTokens));
        if ((usage.reasoningOutputTokens || 0) > 0) parts.push("推理 " + (estimated ? "≈" : "") + compactUsageNumber(usage.reasoningOutputTokens));
        if ((usage.totalCostUsd || 0) > 0) parts.push("$" + Number(usage.totalCostUsd).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
        if (parts.length === 0 && estimated) parts.push("正在统计用量…");
        if (parts.length === 0) return "";
        return '<div class="turn-usage-summary' + (estimated ? ' is-estimated' : '') + '" role="status" aria-live="polite" aria-label="本轮用量 ' + escapeHtml(parts.join("，")) + '">' +
          '<svg class="turn-usage-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5h11M4 11V7.5M8 11V3M12 11V5.5"/></svg>' +
          '<span>' + escapeHtml(parts.join(" · ")) + '</span>' +
        '</div>';
      }
      // 用户上传附件时，客户端用 buildAttachmentPrefix 在 prompt 前注入一段
      //   [附件已上传，请查看以下文件:\n<path1>\n<path2>]\n\n<正文>
      // 文字前缀。聊天里把这段路径文字念出来既冗长又没用——解析它，图片附件
      // 渲染成内联缩略图（同 Read 读图同款 /api/file-raw，点击放大走文件预览），
      // 其余路径给个可点的小文件块，正文保持原样转义。
      var ATTACHMENT_PREFIX_RE = /^\s*\[附件已上传，请查看以下文件:\n([\s\S]*?)\]\n+/;

      function renderUserAttachmentBlock(rawPath) {
        var p = (rawPath || "").trim();
        if (!p) return "";
        var name = p.split("/").pop() || p;
        if (isImagePath(p)) {
          var src = "/api/file-raw?path=" + encodeURIComponent(p);
          return '<div class="user-attachment-image">' +
            '<img class="user-attachment-thumb" loading="lazy" ' +
              'src="' + src + '" ' +
              'alt="' + escapeHtml(name) + '" ' +
              'data-path="' + escapeHtml(p) + '" ' +
              'onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute(\'data-path\'));" ' +
              'onerror="var w=this.closest(\'.user-attachment-image\'); if(w)w.style.display=\'none\';" />' +
          '</div>';
        }
        return '<div class="user-attachment-file" data-path="' + escapeHtml(p) + '" ' +
          'onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute(\'data-path\'));">' +
          '<span class="user-attachment-file-icon">' +
            '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5z"/><path d="M9 1.5V5.5h4"/></svg>' +
          '</span>' +
          '<span class="user-attachment-file-name">' + escapeHtml(name) + '</span>' +
        '</div>';
      }

      // 渲染用户文本：剥离附件前缀，附件渲染成缩略图 / 文件块（在上），正文转义（在下）。
      function renderUserText(text) {
        var raw = text || "";
        var m = raw.match(ATTACHMENT_PREFIX_RE);
        if (!m) return escapeHtml(raw);
        var attachHtml = "";
        var lines = m[1].split("\n");
        for (var i = 0; i < lines.length; i++) {
          attachHtml += renderUserAttachmentBlock(lines[i]);
        }
        var rest = raw.slice(m[0].length);
        var wrap = attachHtml ? '<div class="user-attachments">' + attachHtml + '</div>' : "";
        var body = rest.trim() ? '<div class="user-attachment-text">' + escapeHtml(rest) + '</div>' : "";
        return wrap + body;
      }

      function buildConversationToolResultMap(allMessages) {
        var toolResults = {};
        if (!Array.isArray(allMessages)) return toolResults;
        for (var mi = 0; mi < allMessages.length; mi++) {
          var content = allMessages[mi] && Array.isArray(allMessages[mi].content)
            ? allMessages[mi].content
            : [];
          for (var bi = 0; bi < content.length; bi++) {
            var block = content[bi];
            if (!block || block.type !== "tool_result") continue;
            var toolUseId = block.tool_use_id;
            if (!toolUseId) continue;
            if (!toolResults[toolUseId]) toolResults[toolUseId] = [];
            toolResults[toolUseId].push(block);
          }
        }
        return toolResults;
      }

      function agentRunActivity(run) {
        return {
          sessionRunning: _currentSessionRunning,
          inLatestWindow: agentRunInLatestWindow(run, _currentLastUserTextMessageIndex),
        };
      }

      function renderContentBlock(block, role, toolResults, index, messageKey, options?: any) {
        var scope = renderBlockScope(messageKey, index, block);
        var html = renderContentBlockBody(block, role, toolResults, index, messageKey, options);
        return typeof HTMLElement !== "undefined" ? scopeChatMarkup(html, scope) : html;
      }

      function renderContentBlockBody(block, role, toolResults, index, messageKey, options?: any) {
        var opts = options || {};
        if (!block || !block.type) return "";

        switch (block.type) {
          case "text":
            if (role === "assistant" && block.__processing) {
              return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
            }
            return role === "assistant" ? renderMarkdown(block.text || "") : renderUserText(block.text || "");

          case "thinking":
            var thinkingText = block.thinking || "";
            var isStreaming = block.thinking === undefined && block.type === "thinking";
            if (isStreaming) {
              return '<div class="thinking-inline thinking-streaming" data-thinking="">' +
                '<div class="thinking-streaming-inner">' +
                  '<span class="thinking-streaming-icon spinning">' + iconSvg("spark", { size: 12, strokeWidth: 1.8 }) + '</span>' +
                  '<div class="thinking-streaming-text"></div>' +
                '</div>' +
              '</div>';
            }
            // 非流式分支：thinking 字段是空字符串时，UI 上只会出现一条带"展开"
            // 的紫色窄条，展开了也是空——直接不渲染，避免视觉噪音。
            if (!thinkingText.trim()) return "";
            var thinkingKey = buildExpandKey("thinking", [messageKey, index]);
            var thinkingPersisted = getPersistedExpandState(thinkingKey);
            var thinkingExpanded = resolveCardExpanded(thinkingPersisted, opts, index, getCardDefault("thinking"));
            var preview = thinkingExpanded ? thinkingText : "深度思考";
            return '<div class="thinking-inline ' + (thinkingExpanded ? 'expanded' : 'collapsed') + '" data-expand-kind="thinking" data-expand-key="' + escapeHtml(thinkingKey) + '" data-thinking="' + escapeHtml(thinkingText) + '" onclick="__thinkingToggle(this)">' +
              '<span class="thinking-inline-icon">' + iconSvg("spark", { size: 12, strokeWidth: 1.8 }) + '</span>' +
              '<span class="thinking-inline-preview">' + escapeHtml(thinkingExpanded ? thinkingText : preview) + '</span>' +
              '<span class="thinking-inline-action">' + (thinkingExpanded ? '收起' : '展开') + '</span>' +
            '</div>';

          case "tool_use":
            var toolResult = pickToolResultForDisplay(toolResults, block.id);
            var rendered = renderToolUseCard(block, toolResult, index, messageKey, opts);
            if (hasRecoveredToolNoise(toolResults, block.id)) {
              rendered = renderRecoveredToolHint(block.name || "工具") + rendered;
            }
            return rendered;

          case "tool_result":
            // tool_result 通常被对应的 tool_use 卡片以"结果"区域消化掉，不在主流渲染。
            // 但如果父 tool_use 在另一条 turn 或被裁剪掉了，结果会变成孤儿——返回空字符串
            // 会让这条消息看起来"消失"。下面 renderStructuredMessage 在切段前会再做一次
            // orphan 兜底，这里保持空返回以维持旧行为不变。
            return "";

          default:
            // 兜底：未来后端新增 block 类型时（image / chart / 文件等）不让 JSON 裸露在
            // 用户面前。给一个折叠卡片，默认收起，展开后是原始 JSON。
            var unknownType = block && block.type ? String(block.type) : "未知";
            var unknownJson = "";
            try { unknownJson = JSON.stringify(block, null, 2); } catch (_e) { unknownJson = "{}"; }
            return '<div class="unknown-block collapsed" onclick="this.classList.toggle(\'collapsed\')">' +
              '<div class="unknown-block-header">' +
                '<span class="unknown-block-icon">' + iconSvg("question", { size: 13, strokeWidth: 1.8 }) + '</span>' +
                '<span class="unknown-block-label">未识别的内容块：' + escapeHtml(unknownType) + '</span>' +
                '<span class="unknown-block-toggle">▼</span>' +
              '</div>' +
              '<pre class="unknown-block-body">' + escapeHtml(unknownJson) + '</pre>' +
            '</div>';
        }
      }

      function renderInlineTool(block, toolResult, toolName, fileInfo, extraInfo, messageKey, index, options?: any) {
        var opts = options || {};
        var toolId = block.id || "tool-" + toolName;
        var expandKey = buildExpandKey("inline-tool", [messageKey, toolId || index]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var inputData = block.input || {};
        var resultContent = extractToolResultText(toolResult && toolResult.content);

        var isError = toolResult && toolResult.is_error;
        var hasResult = resultContent.length > 0;
        var statusIcon = isError
          ? iconSvg("close", { size: 11, strokeWidth: 2.2 })
          : (hasResult ? iconSvg("check", { size: 11, strokeWidth: 2.2 }) : "…");

        // Build the inline preview line
        var icon = "";
        var title = "";
        var meta = "";
        var preview = "";

        if (toolName === "Read") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C8.405 3.77 9.146 4 10 4h3.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"/><path d="M2 5.5h12M2 8h8M2 10.5h5"/></svg>';
          var path = inputData.file_path || inputData.path || fileInfo || "";
          var lineCount = "";
          if (inputData.limit) {
            lineCount = " " + inputData.offset + "-" + (inputData.offset + inputData.limit);
          }
          title = path;
          meta = lineCount;
        } else if (toolName === "Glob") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M10.5 10.5L14 14"/></svg>';
          var pattern = inputData.pattern || "";
          var gPath = inputData.path || fileInfo || "";
          title = pattern;
          meta = gPath;
        } else if (toolName === "Grep") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M11.5 11.5L15 15"/></svg>';
          var pattern = inputData.pattern || "";
          var gPath = inputData.path || fileInfo || "";
          title = pattern;
          meta = gPath;
          if (inputData.context) meta += " -C" + inputData.context;
        } else if (toolName === "WebFetch") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5v13M1.5 8h13"/></svg>';
          var url = inputData.url || "";
          title = url;
          meta = extraInfo || "";
        } else if (toolName === "WebSearch") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M10.5 10.5L14 14"/><path d="M5 7h4M7 5v4"/></svg>';
          var query = inputData.query || "";
          title = query;
          meta = extraInfo || "";
        } else if (toolName === "TodoRead") {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 8l2 2 4-4"/></svg>';
          title = "读取待办列表";
          meta = extraInfo || "";
        } else {
          icon = '<svg class="inline-tool-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 5v3.5M8 11h.01"/></svg>';
          title = getToolDisplayName(toolName);
          meta = extraInfo || "";
        }

        // Format result preview
        if (hasResult) {
          var lines = resultContent.split("\n");
          if (lines.length > 10) {
            preview = lines.slice(0, 10).join("\n") + "\n…";
          } else {
            preview = resultContent;
          }
        }

        var previewDataAttr = escapeHtml(preview);
        var fullResult = resultContent;

        var expandedHtml = "";
        var shouldExpand = opts.forceExpandedToolBodies ? true : resolveCardExpanded(persistedExpanded, opts, index, getCardDefault("inlineTools"));
        if (hasResult) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? 'block' : 'none') + ';">' +
            '<div class="inline-tool-result">' + formatInlineResult(resultContent, toolName) + '</div>' +
          '</div>';
        } else if (isError) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? 'block' : 'none') + ';"><div class="inline-tool-result inline-tool-error">' +
            escapeHtml(resultContent || "操作失败") + '</div></div>';
        } else if (!toolResult) {
          expandedHtml = '<div class="inline-tool-expanded" style="display: ' + (shouldExpand ? 'block' : 'none') + ';"><div class="inline-tool-loading">等待响应…</div></div>';
        }

        var isTruncated = toolResult && toolResult._truncated === true;

        // 图片直接内联展示，不让用户去点开 JSON 或猜路径。
        //   · path 命中图片扩展名 → 走文件浏览器同款 /api/file-raw
        //   · tool_result 内联 image content block（base64 / url）→ data URI / 取图 URL
        // Read 读图必然带路径，两者同时渲染会变成同一张图两个缩略图：内联图优先。
        var imageHtml = "";
        var imgPath = inputData.file_path || inputData.path || fileInfo || "";
        if (imgPath && isImagePath(imgPath)) {
          var imgSrc = "/api/file-raw?path=" + encodeURIComponent(imgPath);
          imageHtml += '<div class="inline-tool-image" onclick="event.stopPropagation();">' +
            '<img class="inline-tool-image-thumb" loading="lazy" ' +
              'src="' + imgSrc + '" ' +
              'alt="' + escapeHtml(imgPath) + '" ' +
              'data-path="' + escapeHtml(imgPath) + '" ' +
              'onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute(\'data-path\'));" ' +
              'onerror="var w=this.closest(\'.inline-tool-image\'); if(w)w.style.display=\'none\';" />' +
          '</div>';
        }
        var inlineResultImages = toolResult ? extractToolResultImages(toolResult.content) : [];
        if (inlineResultImages.length > 0) imageHtml = "";
        for (var ri = 0; ri < inlineResultImages.length; ri++) {
          imageHtml += '<div class="inline-tool-image" onclick="event.stopPropagation();">' +
            '<img class="inline-tool-image-thumb" loading="lazy" src="' + escapeHtml(inlineResultImages[ri].src) + '" alt="工具返回图片" ' +
              'onclick="event.stopPropagation(); if(window.__openImageViewer)window.__openImageViewer(this.src, this.alt);" />' +
          '</div>';
        }

        var extraInfoHtml = meta ? '<span class="inline-tool-meta">' + escapeHtml(meta) + '</span>' : '';
        var extraClass = isError ? 'inline-tool-error-inline' : '';
        if (shouldExpand) extraClass += ' inline-tool-open';

        var truncatedAttrs = isTruncated
          ? 'data-truncated="true" data-tool-use-id="' + escapeHtml(block.id || "") + '" '
          : '';

        return '<div class="inline-tool ' + extraClass + '" ' +
          'data-expand-kind="inline-tool" ' +
          'data-expand-key="' + escapeHtml(expandKey) + '" ' +
          'data-result="' + escapeHtml(fullResult) + '" ' +
          'data-preview="' + previewDataAttr + '" ' +
          'data-status="' + (isError ? 'error' : (hasResult ? 'done' : 'pending')) + '" ' +
          truncatedAttrs +
          'onclick="__inlineToolToggle(this)">' +
          '<div class="inline-tool-row">' +
            '<span class="inline-tool-status">' + statusIcon + '</span>' +
            icon +
            '<span class="inline-tool-title">' + escapeHtml(title) + '</span>' +
            extraInfoHtml +
          '</div>' +
          imageHtml +
          expandedHtml +
        '</div>';
      }

      // Terminal-style display for Bash commands
      function renderTerminalTool(block, toolResult, toolName, messageKey, index, options?: any) {
        var opts = options || {};
        var inputData = block.input || {};
        var command = inputData.command || inputData.cmd || "";
        var resultContent = extractToolResultText(toolResult && toolResult.content);
        var toolId = block.id || "tool-" + toolName;
        var expandKey = buildExpandKey("terminal", [messageKey, toolId || index]);
        var persistedExpanded = getPersistedExpandState(expandKey);

        var isError = toolResult && toolResult.is_error;
        var exitCode = inputData.exitCode;

        var statusDot = "";
        if (toolResult) {
          if (isError) {
            statusDot = '<span class="term-status-dot term-error"></span>';
          } else if (exitCode === 0 || exitCode === undefined) {
            statusDot = '<span class="term-status-dot term-success"></span>';
          } else {
            statusDot = '<span class="term-status-dot term-warn"></span>';
          }
        } else {
          statusDot = '<span class="term-status-dot term-running"></span>';
        }

        var cmdDisplay = escapeHtml(command);

        var outputLines = resultContent.split("\n");
        var outputHtml = "";
        for (var oi = 0; oi < outputLines.length; oi++) {
          var line = outputLines[oi];
          if (!line && oi === outputLines.length - 1) continue;
          outputHtml += '<div class="term-line">' + escapeHtml(line) + '</div>';
        }

        var exitCodeHtml = "";
        if (toolResult && exitCode !== undefined) {
          var codeClass = exitCode === 0 ? "term-exit-success" : "term-exit-error";
          exitCodeHtml = '<div class="term-exit ' + codeClass + '">exit ' + exitCode + '</div>';
        }

        // Show command preview in header (truncate long commands)
        var cmdPreview = command.length > 80 ? command.slice(0, 77) + "…" : command;
        var shouldExpand = opts.forceExpandedToolBodies ? true : resolveCardExpanded(persistedExpanded, opts, index, getCardDefault("terminal"));

        var termTruncated = toolResult && toolResult._truncated === true;
        var termTruncAttrs = termTruncated
          ? ' data-truncated="true" data-tool-use-id="' + escapeHtml(block.id || "") + '"'
          : '';

        return '<div class="inline-terminal" data-expand-kind="terminal" data-expand-key="' + escapeHtml(expandKey) + '" data-expanded="' + (shouldExpand ? 'true' : 'false') + '"' + termTruncAttrs + '>' +
          '<div class="term-header" role="button" tabindex="0" aria-expanded="' + (shouldExpand ? 'true' : 'false') + '" onclick="__terminalExpand(this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();__terminalExpand(this);}">' +
            statusDot +
            '<span class="term-cmd-preview"><span class="term-prompt">$</span> ' + escapeHtml(cmdPreview) + '</span>' +
            '<span class="term-toggle-icon">' + (shouldExpand ? '▼' : '▶') + '</span>' +
          '</div>' +
          '<div class="term-body" aria-hidden="' + (shouldExpand ? 'false' : 'true') + '" style="display:' + (shouldExpand ? 'block' : 'none') + ';">' +
            '<div class="term-command"><span class="term-prompt">$</span> ' + cmdDisplay + '</div>' +
            (outputHtml ? '<div class="term-output">' + outputHtml + '</div>' : '') +
            exitCodeHtml +
          '</div>' +
        '</div>';
      }
      // tool_result 里可能内联 image content block（Anthropic 原生支持
      // `[{type:"image", source:{type:"base64", media_type, data}}]`，Read 读图片 /
      // 截图 / view_image 等都会走到这里）。老逻辑把整个数组 JSON.stringify 出来，
      // 用户看到的是一大坨 base64。这里把图片块抽成可直接 <img> 的 data URI。
      export function extractToolResultImages(content) {
        if (!Array.isArray(content)) return [];
        var images = [];
        for (var i = 0; i < content.length; i++) {
          var item = content[i];
          if (!item || typeof item !== "object") continue;
          var src = "";
          if (item.type === "image") {
            var source = item.source || {};
            if (source.type === "base64" && source.data) {
              src = "data:" + (source.media_type || "image/png") + ";base64," + source.data;
            } else if (typeof source.url === "string") {
              src = source.url;
            } else if (typeof item.url === "string") {
              src = item.url;
            }
          } else if (item.type === "image_url") {
            var imageUrl = item.image_url;
            src = typeof imageUrl === "string" ? imageUrl : (imageUrl && imageUrl.url) || "";
          }
          if (src) images.push({ src: src });
        }
        return images;
      }

      export function extractToolResultText(content) {
        if (!content) return "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content.map(function(item) {
            if (!item || typeof item !== "object") return "";
            if (item.type === "text" && typeof item.text === "string") return item.text;
            // 图片块已经由 extractToolResultImages 单独渲染，不要把 base64 塞进正文。
            if (item.type === "image" || item.type === "image_url") return "";
            try {
              return JSON.stringify(item);
            } catch (e) {
              return "";
            }
          }).filter(Boolean).join("\n");
        }
        return "";
      }

      function renderDiffTool(block, toolResult, toolName, messageKey, index, options?: any) {
        var opts = options || {};
        var inputData = block.input || {};
        var path = inputData.file_path || inputData.path || "";
        var fileName = path.split("/").pop() || path;
        var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);

        var oldStr = inputData.old_string || "";
        var newStr = inputData.new_string || inputData.content || "";
        var newContent = inputData.new_content || "";
        var unifiedDiff = inputData.unified_diff || inputData.diff || "";
        var changeKind = inputData.kind || "";

        var isWrite = toolName === "Write" || toolName === "MultiEdit";
        var isError = toolResult && toolResult.is_error;
        var toolResultText = extractToolResultText(toolResult && toolResult.content);

        // Build side-by-side diff HTML (old | new columns)
        var leftCol = "";
        var rightCol = "";
        var unifiedCol = "";
        if (unifiedDiff) {
          unifiedCol = '<div class="diff-col diff-col-full"><div class="diff-col-label">Diff</div>' + renderUnifiedDiffLines(unifiedDiff) + '</div>';
        } else if (isWrite) {
          // Write: only show new content on right
          rightCol = '<div class="diff-line diff-add">+ ' + escapeHtml(newContent) + '</div>';
        } else {
          // Edit: old on left, new on right
          if (oldStr) {
            leftCol = '<div class="diff-line diff-remove">- ' + escapeHtml(oldStr) + '</div>';
          }
          if (newStr) {
            rightCol = '<div class="diff-line diff-add">+ ' + escapeHtml(newStr) + '</div>';
          }
        }

        var statusClass = "";
        var statusText = "";
        if (toolResult) {
          if (isError) {
            statusClass = "diff-error";
            statusText = toolResultText.indexOf("haven't granted") !== -1 || toolResultText.indexOf("permission") !== -1
              ? "等待授权"
              : "失败";
          } else {
            statusClass = "diff-success";
            statusText = changeKind === "add" ? "已新增"
              : changeKind === "delete" ? "已删除"
                : changeKind === "move" ? "已移动"
                  : "已修改";
          }
        } else {
          statusClass = "diff-pending";
          statusText = "执行中";
        }

        // Expand state: respect cardDefaults.editCards and persisted state
        var expandKey = buildExpandKey("diff", [messageKey, toolId || index]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var cardDefaultExpand = getCardDefault("editCards");
        var shouldExpand = opts.forceExpandedToolBodies ? true : resolveCardExpanded(persistedExpanded, opts, index, cardDefaultExpand);
        var collapsedClass = shouldExpand ? "" : " collapsed";

        // If only one column has content, show full width
        var bothCols = !unifiedCol && leftCol && rightCol;
        var colClass = bothCols ? "diff-col-half" : "diff-col-full";
        var columnsHtml = unifiedCol || (
          (bothCols ? '<div class="diff-col ' + colClass + '"><div class="diff-col-label">旧</div>' + leftCol + '</div>' : '') +
          '<div class="diff-col ' + colClass + '"><div class="diff-col-label">' + (bothCols ? '新' : '') + '</div>' + (rightCol || leftCol || renderEmptyDiff(path)) + '</div>'
        );
        var openButton = path
          ? '<button class="diff-open-file" type="button" data-path="' + escapeHtml(path) + '" title="打开文件" onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute(\'data-path\'));">打开</button>'
          : '';

        return '<div class="inline-diff' + collapsedClass + '" data-tool-name="' + escapeHtml(toolName) + '"' +
          ' data-expand-kind="diff" data-expand-key="' + escapeHtml(expandKey) + '"' +
          ' data-tool-use-id="' + escapeHtml(toolId) + '" data-path="' + escapeHtml(path) + '">' +
          '<div class="diff-header" role="button" tabindex="0" aria-expanded="' + (shouldExpand ? 'true' : 'false') + '" onclick="__tcToggle(event,this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();__tcToggle(event,this);}">' +
            '<span class="diff-file-icon"></span>' +
            '<span class="diff-file-name">' + escapeHtml(fileName) + '</span>' +
            renderTailMarqueePath(path, "diff-path") +
            '<span class="diff-status ' + statusClass + '">' + statusText + '</span>' +
            openButton +
            '<span class="diff-toggle">▼</span>' +
          '</div>' +
          '<div class="diff-body" aria-hidden="' + (shouldExpand ? 'false' : 'true') + '">' +
            '<div class="diff-columns">' +
              columnsHtml +
            '</div>' +
          '</div>' +
        '</div>';
      }

      function renderUnifiedDiffLines(diff) {
        var lines = String(diff || "").split("\n");
        var limit = 600;
        var html = "";
        for (var i = 0; i < lines.length && i < limit; i++) {
          var line = lines[i];
          var cls = "diff-context";
          if (/^@@/.test(line)) cls = "diff-hunk";
          else if (/^\+/.test(line) && !/^\+\+\+/.test(line)) cls = "diff-add";
          else if (/^-/.test(line) && !/^---/.test(line)) cls = "diff-remove";
          html += '<div class="diff-line ' + cls + '">' + escapeHtml(line || " ") + '</div>';
        }
        if (lines.length > limit) {
          html += '<div class="diff-line diff-context">…（已截断 ' + (lines.length - limit) + ' 行）</div>';
        }
        return html || renderEmptyDiff("");
      }

      function renderEmptyDiff(path) {
        var suffix = path ? "，可打开文件查看当前内容" : "";
        return '<div class="diff-empty">Codex 未提供内联 diff' + suffix + '。</div>';
      }

      export function formatInlineResult(content, toolName) {
        if (!content) return '<span class="inline-tool-empty">无输出</span>';
        return '<pre class="inline-tool-result-text" style="max-height: 300px; overflow-y: auto;">' + escapeHtml(content) + '</pre>';
      }

      function renderToolUseCard(block, toolResult, index, messageKey, options?: any) {
        var opts = options || {};
        var toolName = block.name || "unknown";
        var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);
        var fileInfo = extractFileInfo(toolName, block.input);

        // ── Lightweight inline tools: Read, Glob, Grep, WebFetch, WebSearch, TodoRead
        if (toolName === "Read" || toolName === "Glob" || toolName === "Grep" ||
            toolName === "WebFetch" || toolName === "WebSearch" || toolName === "TodoRead") {
          return renderInlineTool(block, toolResult, toolName, fileInfo, "", messageKey, index, opts);
        }

        // ── Terminal-style: Bash
        if (toolName === "Bash") {
          return renderTerminalTool(block, toolResult, toolName, messageKey, index, opts);
        }

        // ── Diff-style: Edit, Write, MultiEdit
        if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
          return renderDiffTool(block, toolResult, toolName, messageKey, index, opts);
        }

        // ── AskUserQuestion tool — special card with batch submit
        var semanticQuestions = block.semantic && block.semantic.kind === "question_request"
          ? block.semantic.questions
          : null;
        if (semanticQuestions || (toolName === "AskUserQuestion" && block.input && block.input.questions)) {
          var questions = semanticQuestions || block.input.questions;
          if (questions && questions.length > 0) {
            var isAnswered = !!toolResult;
            var sel = state.askUserSelections[toolId] || {};
            var isSubmitted = !!sel.submitted;
            var answerText = isAnswered ? extractToolResultText(toolResult.content) : "";
            var answerLines = answerText ? answerText.trim().split("\n") : [];

            // Build header summary
            var headerLabel = "";
            for (var hi = 0; hi < questions.length; hi++) {
              if (questions[hi].header) { headerLabel = questions[hi].header; break; }
            }
            var headerSummary = headerLabel ? '<span class="tool-use-summary">' + escapeHtml(headerLabel) + '</span>' : "";

            var questionsHtml = "";
            questions.forEach(function(question, qIdx) {
              var isMulti = !!question.multiSelect;
              var questionText = question.question ? '<div class="ask-user-title">' + escapeHtml(question.question) + '</div>' : "";
              var optionsHtml = "";
              if (question.options && question.options.length > 0) {
                optionsHtml = '<div class="ask-user-options" data-multi-select="' + isMulti + '">';
                question.options.forEach(function(opt, idx) {
                  var label = opt.label ? escapeHtml(opt.label) : "选项 " + (idx + 1);
                  var descHtml = opt.description ? '<div class="ask-user-option-desc">' + escapeHtml(opt.description) + '</div>' : "";

                  if (isAnswered) {
                    // Read-only: check if this option was the chosen answer
                    var answerLine = answerLines[qIdx] || answerLines[0] || "";
                    var chosenLabels = answerLine.split(",").map(function(s) { return s.trim(); });
                    var isChosen = chosenLabels.indexOf(opt.label || "") !== -1;
                    optionsHtml += '<div class="ask-user-option ask-user-option-readonly' + (isChosen ? ' ask-user-option-chosen' : '') + '">' +
                      '<span class="ask-user-indicator"></span>' +
                      '<div class="ask-user-option-content">' +
                        '<div class="ask-user-option-label">' + label + '</div>' +
                        descHtml +
                      '</div>' +
                    '</div>';
                  } else {
                    // Interactive: selection state from askUserSelections
                    var isSelected = (sel[qIdx] || []).indexOf(idx) !== -1;
                    var disabledAttr = isSubmitted ? ' disabled' : '';
                    optionsHtml += '<button class="ask-user-option' + (isSelected ? ' selected' : '') + '"' +
                      ' data-option-index="' + idx + '"' +
                      ' data-question-index="' + qIdx + '"' +
                      ' data-option-label="' + escapeHtml(opt.label || "选项 " + (idx + 1)) + '"' +
                      ' onclick="__askSelect(\'' + escapeHtml(toolId) + '\',' + qIdx + ',' + idx + ',' + isMulti + ')"' +
                      disabledAttr + '>' +
                      '<span class="ask-user-indicator"></span>' +
                      '<div class="ask-user-option-content">' +
                        '<div class="ask-user-option-label">' + label + '</div>' +
                        descHtml +
                      '</div>' +
                    '</button>';
                  }
                });
                optionsHtml += '</div>';
              }
              questionsHtml += '<div class="ask-user-question-group" data-question-index="' + qIdx + '">' + questionText + optionsHtml + '</div>';
            });

            // Submit button (only for interactive state)
            var actionsHtml = "";
            if (!isAnswered) {
              var allAnsweredCheck = true;
              for (var qi = 0; qi < questions.length; qi++) {
                if (!sel[qi] || sel[qi].length === 0) { allAnsweredCheck = false; break; }
              }
              var submitDisabled = (!allAnsweredCheck || isSubmitted) ? " disabled" : "";
              var submitClass = isSubmitted ? " ask-user-submitted" : "";
              var submitText = isSubmitted ? "已提交..." : "确认提交";
              actionsHtml = '<div class="ask-user-actions">' +
                '<button class="ask-user-submit' + submitClass + '" data-tool-use-id="' + escapeHtml(toolId) + '"' +
                  ' onclick="__askSubmit(\'' + escapeHtml(toolId) + '\')"' + submitDisabled + '>' +
                  submitText +
                '</button>' +
              '</div>';
            }

            // Answered summary for header
            var answeredSummary = "";
            if (isAnswered && answerText) {
              var shortAnswer = answerText.trim().replace(/\n/g, ", ");
              if (shortAnswer.length > 40) shortAnswer = shortAnswer.slice(0, 37) + "...";
              answeredSummary = '<span class="tool-use-file">' + escapeHtml(shortAnswer) + '</span>';
            }

            // Expand state: default expanded when unanswered, collapsed when answered
            var askExpandKey = buildExpandKey("tool-card", [messageKey, toolId]);
            var askPersisted = getPersistedExpandState(askExpandKey);
            var askShouldExpand = opts.forceExpandedToolBodies ? true : (askPersisted === null ? !isAnswered : askPersisted);
            var askCollapsed = askShouldExpand ? "" : " collapsed";
            var answeredClass = isAnswered ? " ask-user-answered" : "";

            return '<div class="tool-use-card ask-user' + answeredClass + askCollapsed + '"' +
              ' data-tool-use-id="' + escapeHtml(toolId) + '"' +
              ' data-expand-kind="tool-card"' +
              ' data-expand-key="' + escapeHtml(askExpandKey) + '">' +
              '<div class="tool-use-header" data-tool-toggle onclick="__tcToggle(event,this)">' +
                '<span class="tool-use-icon">' + (isAnswered
                  ? iconSvg("check", { size: 13, strokeWidth: 2 })
                  : iconSvg("question", { size: 13, strokeWidth: 1.8 })) + '</span>' +
                '<span class="tool-use-name">提问</span>' +
                headerSummary +
                answeredSummary +
                '<span class="tool-use-toggle">▼</span>' +
              '</div>' +
              '<div class="tool-use-body ask-user-body">' +
                questionsHtml +
                actionsHtml +
              '</div>' +
            '</div>';
          }
        }

        // ── Default card rendering for: Agent, Task, TodoWrite, NotebookEdit, Exit, and unknown tools
        var description = block.description || (block.input && block.input.description) || "";
        var summary = generateInputSummary(block.name, block.input);
        var titleText = "";
        var subtitleHtml = "";
        if (description) {
          titleText = description.length > 80 ? description.slice(0, 77) + "..." : description;
          if (fileInfo) {
            subtitleHtml = '<span class="tool-use-file">' + escapeHtml(fileInfo) + '</span>';
          }
        } else {
          titleText = getToolDisplayName(toolName);
          if (fileInfo) {
            subtitleHtml = '<span class="tool-use-file">' + escapeHtml(fileInfo) + '</span>';
          }
          if (summary) {
            subtitleHtml += '<span class="tool-use-summary">' + escapeHtml(summary) + '</span>';
          }
        }
        var fullJson = block.input ? JSON.stringify(block.input, null, 2) : "{}";
        var statusClass = "loading";
        var headerIcon = '<span class="tool-use-spinner"></span>';
        var resultHtml = "";

        if (toolResult) {
          var isError = toolResult.is_error;
          var content = extractToolResultText(toolResult.content);
          statusClass = isError ? "error" : "success";
          headerIcon = getToolIcon(toolName);
          var hasContent = content && content.trim().length > 0;
          if (hasContent) {
            resultHtml = '<pre class="tool-use-result-content">' + escapeHtml(content) + '</pre>';
          } else {
            resultHtml = '<span class="tool-use-result-empty">无输出</span>';
          }
          // 结果里内联的图片（截图 / 读图 / 工具生成的图）直接展示，不塞 JSON。
          var cardImages = extractToolResultImages(toolResult.content);
          if (cardImages.length > 0) {
            resultHtml = cardImages.map(function(img) {
              return '<div class="inline-tool-image" onclick="event.stopPropagation();">' +
                '<img class="inline-tool-image-thumb" loading="lazy" src="' + escapeHtml(img.src) + '" alt="工具返回图片" ' +
                  'onclick="event.stopPropagation(); if(window.__openImageViewer)window.__openImageViewer(this.src, this.alt);" />' +
              '</div>';
            }).join("") + resultHtml;
          }
        } else {
          headerIcon = getToolIcon(toolName);
        }

        var expandKey = buildExpandKey("tool-card", [messageKey, toolId]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var cardDefaultExpand = getCardDefault("editCards");
        var shouldExpand = opts.forceExpandedToolBodies ? true : resolveCardExpanded(persistedExpanded, opts, index, cardDefaultExpand);
        // 带图片的工具卡默认展开：折叠会把整块 body（含缩略图）藏掉，
        // 与「图片直接展示」的诉求冲突。
        if (!opts.forceExpandedToolBodies && toolResult && extractToolResultImages(toolResult.content).length > 0) {
          shouldExpand = true;
        }
        var tcTruncated = toolResult && toolResult._truncated === true;
        var collapsedClass = shouldExpand ? "" : " collapsed";
        var toggleHtml = '<span class="tool-use-toggle">▼</span>';
        var fallbackChipHtml = "";
        if (block && block.dispatchInfo && block.dispatchInfo.usedCandidate > 0) {
          var skippedReason = block.dispatchInfo.skipped && block.dispatchInfo.skipped[0] ? block.dispatchInfo.skipped[0].reason : "首选不可用";
          fallbackChipHtml = '<div class="tool-use-downgrade-chip" role="status">' +
            iconSvg("info", { size: 11, strokeWidth: 1.8 }) +
            '<span>首选不可用，已自动降级：' + escapeHtml(skippedReason) + '</span>' +
          '</div>';
        }

        return '<div class="tool-use-card ' + statusClass + collapsedClass + '" data-expand-kind="tool-card" data-expand-key="' + escapeHtml(expandKey) + '" data-tool-use-id="' + escapeHtml(toolId) + '"' + (tcTruncated ? ' data-truncated="true"' : '') + '>' +
          '<div class="tool-use-header" role="button" tabindex="0" aria-expanded="' + (shouldExpand ? 'true' : 'false') + '" data-tool-toggle onclick="__tcToggle(event,this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();__tcToggle(event,this);}">' +
            '<span class="tool-use-icon">' + headerIcon + '</span>' +
            '<span class="tool-use-name">' + escapeHtml(titleText) + '</span>' +
            subtitleHtml +
            toggleHtml +
          '</div>' +
          '<div class="tool-use-body" aria-hidden="' + (shouldExpand ? 'false' : 'true') + '">' +
            (description ? '<div class="tool-use-meta"><span class="tool-use-meta-label">工具：</span>' + escapeHtml(toolName) + '</div>' : '') +
            '<pre class="tool-use-content">' + escapeHtml(fullJson) + '</pre>' +
            (resultHtml ? '<div class="tool-use-result">' + resultHtml + '</div>' : '') +
          '</div>' +
          fallbackChipHtml +
        '</div>';
      }

      function generateInputSummary(toolName, input) {
        // 生成工具输入的简洁摘要，避免显示完整 JSON
        if (!input || typeof input !== "object") return "";

        var keys = Object.keys(input);
        if (keys.length === 0) return "{}";

        // 文件操作：只显示操作类型和修改数量，路径已在 header 中显示
        if (toolName === "Read") {
          return "读取文件";
        }
        if (toolName === "Write") {
          return "写入文件";
        }
        if (toolName === "Edit") {
          var edits = input.edits ? input.edits.length : 0;
          return "编辑 (" + edits + " 处修改)";
        }

        // Bash：显示命令
        if (toolName === "Bash") {
          var cmd = input.command || "";
          if (cmd) {
            var cmdPreview = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
            return "命令：" + cmdPreview;
          }
        }

        // Grep：显示模式和路径
        if (toolName === "Grep") {
          var pattern = input.pattern || "";
          var path = input.path || "";
          if (pattern) {
            return "搜索：" + pattern + (path ? " (在 " + path + ")" : "");
          }
        }

        // Glob：显示模式
        if (toolName === "Glob") {
          var pattern = input.pattern || "";
          if (pattern) return "查找：" + pattern;
        }

        // Agent：显示任务
        if (toolName === "Agent") {
          var task = input.prompt || input.task || "";
          if (task) {
            var taskPreview = task.length > 40 ? task.slice(0, 40) + "..." : task;
            return "任务：" + taskPreview;
          }
        }

        // Task：显示任务描述
        if (toolName === "Task") {
          var task = input.task || input.description || "";
          if (task) {
            var taskPreview = task.length > 40 ? task.slice(0, 40) + "..." : task;
            return "任务：" + taskPreview;
          }
        }

        // TodoWrite：显示操作类型
        if (toolName === "TodoWrite") {
          var todos = input.todos || [];
          return "更新待办 (" + todos.length + " 项)";
        }

        // WebSearch：显示查询
        if (toolName === "WebSearch") {
          var query = input.query || "";
          if (query) return "搜索：" + query;
        }

        // 默认：显示第一个 key 和简短值
        var firstKey = keys[0];
        var firstVal = input[firstKey];
        if (typeof firstVal === "string") {
          var valPreview = firstVal.length > 50 ? firstVal.slice(0, 50) + "..." : firstVal;
          return firstKey + ": " + valPreview;
        }
        return keys.length + " 个参数";
      }

      function extractFileInfo(toolName, input) {
        if (!input) return null;
        var path = input.file_path || input.path || input.cwd;
        if (path) {
          // 截断长路径
          if (path.length > 50) {
            return "..." + path.slice(-47);
          }
          return path;
        }
        return null;
      }

      // Format assistant response with Markdown rendering and cleanup
      function formatAssistantResponse(text) {
        if (!text) return "";

        // Clean up the text
        var newline = String.fromCharCode(10);
        var lines = text.split(newline);
        var cleanLines = [];

        // Remove leading/trailing empty lines and common noise
        var started = false;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var trimmed = line.trim();

          // Skip leading empty lines
          if (!started && !trimmed) continue;
          started = true;

          // Filter out noise patterns
          if (trimmed.indexOf("⏺") === 0 && trimmed.length > 2) {
            cleanLines.push(trimmed.slice(1).trim());
            continue;
          }
          // Strip leading ● bullet from Claude TUI output
          if (trimmed.indexOf("●") === 0) {
            trimmed = trimmed.slice(1).trim();
            if (!trimmed) continue;
            line = trimmed;
          }

          cleanLines.push(line);
        }

        // Remove trailing empty lines
        while (cleanLines.length > 0 && !cleanLines[cleanLines.length - 1].trim()) {
          cleanLines.pop();
        }

        // Deduplicate lines (PTY can echo same content multiple times with/without spaces)
        var deduped = [];
        var seenNorm = {};
        for (var j = 0; j < cleanLines.length; j++) {
          var normalized = cleanLines[j].replace(/\s+/g, "");
          if (normalized.length > 5 && seenNorm[normalized]) continue;
          if (normalized.length > 5) seenNorm[normalized] = true;
          deduped.push(cleanLines[j]);
        }

        // Return plain text — renderChatMessage will handle markdown rendering
        return deduped.join(newline);
      }

      function parseMarkdownTables(source) {
        var NL = "\n";
        var lines = source.split(NL);
        var out = [];
        var i = 0;

        function splitRow(line) {
          var s = line.trim();
          if (s.charAt(0) === "|") s = s.slice(1);
          if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
          return s.split("|");
        }
        function styleAttr(a) { return a ? ' style="text-align:' + a + '"' : ""; }
        function buildTable(headers, aligns, rows) {
          var thead = "<thead><tr>" + headers.map(function(c, idx) {
            return "<th" + styleAttr(aligns[idx]) + ">" + c.trim() + "</th>";
          }).join("") + "</tr></thead>";
          var tbody = rows.length ? ("<tbody>" + rows.map(function(r) {
            return "<tr>" + r.map(function(c, idx) {
              return "<td" + styleAttr(aligns[idx]) + ">" + c.trim() + "</td>";
            }).join("") + "</tr>";
          }).join("") + "</tbody>") : "";
          return '<div class="md-table-wrap"><table class="md-table">' + thead + tbody + "</table></div>";
        }

        while (i < lines.length) {
          var header = lines[i];
          if (header.indexOf("|") !== -1 && i + 1 < lines.length) {
            var sep = lines[i + 1].trim();
            if (/^\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?$/.test(sep)) {
              var headers = splitRow(header);
              var aligns = splitRow(sep).map(function(c) {
                var t = c.trim();
                var L = t.charAt(0) === ":";
                var R = t.charAt(t.length - 1) === ":";
                if (L && R) return "center";
                if (R) return "right";
                if (L) return "left";
                return "";
              });
              var rows = [];
              var j = i + 2;
              while (j < lines.length) {
                var trimmed = lines[j].trim();
                if (!trimmed || trimmed.indexOf("|") === -1) break;
                rows.push(splitRow(lines[j]));
                j += 1;
              }
              out.push("", buildTable(headers, aligns, rows), "");
              i = j;
              continue;
            }
          }
          out.push(header);
          i += 1;
        }
        return out.join(NL);
      }

      function renderMarkdown(text) {
        if (!text) return "";

        var markdownLinks = [];
        var result = escapeHtml(stashMarkdownLinks(String(text)));
        var bt = String.fromCharCode(96);
        var newline = String.fromCharCode(10);
        // 代码块内部的换行用 \x01 占位：下面的行首规则（- / * / # / > / 1.）和
        // 表格解析都按行处理，如果代码行参与其中，`# 注释`、`- 旧行` 这类
        // 常见代码行会被改写成标题、列表、引用。渲染完成前再换回真换行。
        var codeNewline = String.fromCharCode(1);

        function serverFilePathFromLink(target) {
          var value = String(target || "").trim();
          if (!value) return null;
          if (value.charAt(0) === "<" && value.charAt(value.length - 1) === ">") {
            value = value.slice(1, -1).trim();
          }
          if (/^file:\/\//i.test(value)) {
            try {
              var fileUrl = new URL(value);
              if (fileUrl.protocol !== "file:") return null;
              value = decodeURIComponent(fileUrl.pathname || "");
            } catch (_) {
              value = value.replace(/^file:\/\/(?:localhost)?/i, "");
              try { value = decodeURIComponent(value); } catch (_) {}
            }
          } else if (value.charAt(0) !== "/" || value.indexOf("//") === 0) {
            return null;
          }
          if (/^\/(?:api|android|macos)(?:\/|$)/.test(value)) return null;
          value = value.replace(/#L\d+(?:C\d+)?$/i, "");
          value = value.replace(/:\d+(?::\d+)?$/, "");
          return value.charAt(0) === "/" ? value : null;
        }

        function localFilePreviewAnchor(value, label) {
          var href = localFilePreviewHref(value);
          if (!href) return label;
          return '<a class="local-preview-link" href="' + escapeHtml(href) + '"' +
            ' data-local-preview-url="' + escapeHtml(value) + '"' +
            ' onclick="if(window.__openLocalPreview){event.preventDefault();window.__openLocalPreview(this.getAttribute(\'data-local-preview-url\'));}">' +
            label + '</a>';
        }

        function localPreviewAnchor(value, label) {
          var href = localHttpPreviewHref(value);
          if (!href) return label;
          return '<a class="local-preview-link" href="' + escapeHtml(href) + '"' +
            ' data-local-preview-url="' + escapeHtml(value) + '"' +
            ' onclick="if(window.__openLocalPreview){event.preventDefault();window.__openLocalPreview(this.getAttribute(\'data-local-preview-url\'));}">' +
            label + '</a>';
        }

        function safeExternalLink(target, label) {
          var value = String(target || "").trim();
          if (value.charAt(0) === "<" && value.charAt(value.length - 1) === ">") {
            value = value.slice(1, -1).trim();
          }
          if (!/^(?:https?:\/\/|mailto:|#)/i.test(value)) return label;
          if (localHttpPreviewHref(value)) return localPreviewAnchor(value, label);
          var escapedTarget = escapeHtml(value);
          var opensNewWindow = /^https?:\/\//i.test(value);
          return '<a href="' + escapedTarget + '"' +
            (opensNewWindow ? ' target="_blank"' : "") +
            ' rel="noopener">' + label + '</a>';
        }

        function autoLinkLocalHttp(source) {
          // Wand message text is already escaped here. The prefix excludes URL
          // attributes and existing data attributes, so this only turns bare
          // loopback URLs into clickable preview links.
          return source.replace(
            /(^|[^"'>])(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s<>"'`\\]*)?)/gi,
            function(_all, prefix, value) {
              return prefix + localPreviewAnchor(value, value);
            }
          );
        }

        function stashMarkdownLinks(source) {
          function findTargetEnd(start) {
            if (source.charAt(start) === "<") {
              var closeAngle = source.indexOf(">", start + 1);
              return closeAngle >= 0 && source.charAt(closeAngle + 1) === ")" ? closeAngle + 1 : -1;
            }
            var depth = 0;
            for (var i = start; i < source.length; i += 1) {
              if (source.charAt(i) === "\\") {
                i += 1;
                continue;
              }
              if (source.charAt(i) === "(") depth += 1;
              else if (source.charAt(i) === ")") {
                if (depth === 0) return i;
                depth -= 1;
              }
            }
            return -1;
          }

          var output = "";
          var cursor = 0;
          var inFence = false;
          var inInlineCode = false;
          while (cursor < source.length) {
            if (source.slice(cursor, cursor + 3) === "```") {
              inFence = !inFence;
              output += "```";
              cursor += 3;
              continue;
            }
            if (!inFence && source.charAt(cursor) === "`") {
              inInlineCode = !inInlineCode;
              output += "`";
              cursor += 1;
              continue;
            }
            if (!inFence && !inInlineCode && source.charAt(cursor) === "[" && source.charAt(cursor - 1) !== "!") {
              var closeText = source.indexOf("](", cursor + 1);
              var closeTarget = closeText >= 0 ? findTargetEnd(closeText + 2) : -1;
              if (closeText > cursor + 1 && closeTarget > closeText + 2) {
                var label = escapeHtml(source.slice(cursor + 1, closeText));
                var target = source.slice(closeText + 2, closeTarget).trim();
                var serverPath = serverFilePathFromLink(target);
                var linkHtml;
                if (serverPath && /\.(?:html?|)$/i.test(serverPath)) {
                  linkHtml = localFilePreviewAnchor(serverPath, label);
                } else if (serverPath) {
                  var rawUrl = "/api/file-raw?download=1&amp;path=" + encodeURIComponent(serverPath);
                  linkHtml = '<a class="server-file-link" href="' + rawUrl + '" data-server-file-path="' +
                    escapeHtml(serverPath) + '" title="打开或下载服务端文件" onclick="if(window.__openFilePreview){event.preventDefault();window.__openFilePreview(this.getAttribute(\'data-server-file-path\'));}">' +
                    label + '</a>';
                } else {
                  linkHtml = safeExternalLink(target, label);
                }
                var token = "WANDMARKDOWNLINKTOKEN" + markdownLinks.length + "END";
                markdownLinks.push(linkHtml);
                output += token;
                cursor = closeTarget + 1;
                continue;
              }
            }
            output += source.charAt(cursor);
            cursor += 1;
          }
          return output;
        }

        function restoreMarkdownLinks(source) {
          for (var i = 0; i < markdownLinks.length; i += 1) {
            source = source.split("WANDMARKDOWNLINKTOKEN" + i + "END").join(markdownLinks[i]);
          }
          return source;
        }

        function replacePair(source, marker, openTag, closeTag) {
          var cursor = 0;
          while (true) {
            var start = source.indexOf(marker, cursor);
            if (start === -1) break;
            var end = source.indexOf(marker, start + marker.length);
            if (end === -1) break;
            var inner = source.slice(start + marker.length, end);
            if (!inner) {
              cursor = end + marker.length;
              continue;
            }
            var replacement = openTag + inner + closeTag;
            source = source.slice(0, start) + replacement + source.slice(end + marker.length);
            cursor = start + replacement.length;
          }
          return source;
        }

        function isWordChar(code) {
          return (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            code === 95;
        }

        function replaceUnderscoreEmphasis(source, openTag, closeTag) {
          var cursor = 0;
          while (cursor < source.length) {
            var start = source.indexOf("_", cursor);
            if (start === -1) break;
            var leftCode = start > 0 ? source.charCodeAt(start - 1) : 0;
            if (isWordChar(leftCode)) {
              cursor = start + 1;
              continue;
            }
            var searchFrom = start + 1;
            var end = -1;
            while (searchFrom < source.length) {
              var candidate = source.indexOf("_", searchFrom);
              if (candidate === -1) break;
              var rightIdx = candidate + 1;
              var rightCode = rightIdx < source.length ? source.charCodeAt(rightIdx) : 0;
              if (!isWordChar(rightCode)) {
                end = candidate;
                break;
              }
              searchFrom = candidate + 1;
            }
            if (end === -1) break;
            var inner = source.slice(start + 1, end);
            if (!inner) {
              cursor = end + 1;
              continue;
            }
            var replacement = openTag + inner + closeTag;
            source = source.slice(0, start) + replacement + source.slice(end + 1);
            cursor = start + replacement.length;
          }
          return source;
        }

        function replaceLinePrefix(source, marker, openTag, closeTag) {
          return source.split(newline).map(function(line) {
            if (line.indexOf(marker) !== 0) return line;
            return openTag + line.slice(marker.length) + closeTag;
          }).join(newline);
        }

        function replaceOrderedList(source) {
          return source.split(newline).map(function(line) {
            var dotIndex = line.indexOf('. ');
            if (dotIndex <= 0) return line;
            for (var i = 0; i < dotIndex; i += 1) {
              var code = line.charCodeAt(i);
              if (code < 48 || code > 57) return line;
            }
            return '<li>' + line.slice(dotIndex + 2) + '</li>';
          }).join(newline);
        }

        function wrapParagraphs(source) {
          return source.split(newline + newline).map(function(part) {
            var block = part.trim();
            if (!block) return "";
            if (block.indexOf("<div") === 0 || block.indexOf("<h1") === 0 || block.indexOf("<h2") === 0 || block.indexOf("<h3") === 0 || block.indexOf("<h4") === 0 || block.indexOf("<h5") === 0 || block.indexOf("<h6") === 0 || block.indexOf("<ul") === 0 || block.indexOf("<ol") === 0 || block.indexOf("<li") === 0 || block.indexOf("<blockquote") === 0 || block.indexOf("<pre") === 0) {
              return block;
            }
            return '<p>' + block.split(newline).join('<br>') + '</p>';
          }).join("");
        }

        var pos = 0;
        while (true) {
          var start = result.indexOf(bt + bt + bt, pos);
          if (start === -1) break;
          var endTag = result.indexOf(bt + bt + bt, start + 3);
          if (endTag === -1) break;

          var codeBlock = result.slice(start + 3, endTag);
          var langLineEnd = codeBlock.indexOf(newline);
          var lang = "";
          var code = codeBlock;
          if (langLineEnd !== -1 && langLineEnd < 30) {
            var potentialLang = codeBlock.slice(0, langLineEnd).trim();
            var isSimpleLang = potentialLang.length > 0;
            for (var j = 0; j < potentialLang.length; j += 1) {
              var langCode = potentialLang.charCodeAt(j);
              var isDigit = langCode >= 48 && langCode <= 57;
              var isUpper = langCode >= 65 && langCode <= 90;
              var isLower = langCode >= 97 && langCode <= 122;
              if (!isDigit && !isUpper && !isLower) {
                isSimpleLang = false;
                break;
              }
            }
            if (isSimpleLang) {
              lang = potentialLang;
              code = codeBlock.slice(langLineEnd + 1);
            }
          }

          var highlighted = highlightCode(code.trim(), lang);
          var protectedHighlighted = highlighted.replace(/\n/g, codeNewline).replace(/_/g, '&#95;').replace(/\*/g, '&#42;');
          // 没有语言标注时留空占位（header 靠 flex 两端对齐把「复制」推到右侧），
          // 不要写 "code" 这个假语言名。
          var replacement = '<div class="code-block">' +
            '<div class="code-block-header">' +
              '<span class="code-lang">' + (lang ? escapeHtml(lang) : "") + '</span>' +
              '<button class="code-copy">复制</button>' +
            '</div>' +
            '<pre><code>' + protectedHighlighted + '</code></pre>' +
          '</div>';
          result = result.slice(0, start) + replacement + result.slice(endTag + 3);
          pos = start + replacement.length;
        }

        pos = 0;
        while (true) {
          var inlineStart = result.indexOf(bt, pos);
          if (inlineStart === -1) break;
          var inlineEnd = result.indexOf(bt, inlineStart + 1);
          if (inlineEnd === -1) break;
          if (inlineEnd === inlineStart + 1) {
            pos = inlineEnd + 1;
            continue;
          }
          var inlineCode = result.slice(inlineStart + 1, inlineEnd);
          var protectedInlineCode = inlineCode.replace(/_/g, '&#95;').replace(/\*/g, '&#42;');
          var inlineReplacement = '<code class="code-inline">' + protectedInlineCode + '</code>';
          result = result.slice(0, inlineStart) + inlineReplacement + result.slice(inlineEnd + 1);
          pos = inlineStart + inlineReplacement.length;
        }

        result = replacePair(result, "**", '<strong>', '</strong>');
        result = replacePair(result, "*", '<em>', '</em>');
        result = replaceUnderscoreEmphasis(result, '<em>', '</em>');
        // 内容区标题整体下移一级：一屏的最高级标题（h1）属于页面本身
        // （面包屑末段 / 对话框标题），气泡里的 `# ` 不能再占 h1。
        // 三档各自有独立字号：styles.css 给 .markdown-content 定义了
        // h1 17.5 / h2 15.4 / h3 14 / h4 13.3，所以 `### ` 用真 h4，不需要 aria-level。
        result = replaceLinePrefix(result, "### ", '<h4>', '</h4>');
        result = replaceLinePrefix(result, "## ", '<h3>', '</h3>');
        result = replaceLinePrefix(result, "# ", '<h2>', '</h2>');
        result = replaceLinePrefix(result, "&gt; ", '<blockquote>', '</blockquote>');
        result = replaceLinePrefix(result, "- ", '<li>', '</li>');
        result = replaceLinePrefix(result, "* ", '<li>', '</li>');
        result = replaceOrderedList(result);
        result = parseMarkdownTables(result);

        var lines = result.split(newline);
        var grouped = [];
        var listBuffer = [];

        function flushListBuffer() {
          if (!listBuffer.length) return;
          grouped.push('<ul>' + listBuffer.join("") + '</ul>');
          listBuffer = [];
        }

        lines.forEach(function(line) {
          if (line.indexOf('<li>') === 0 && line.lastIndexOf('</li>') === line.length - 5) {
            listBuffer.push(line);
            return;
          }
          flushListBuffer();
          grouped.push(line);
        });
        flushListBuffer();

        result = wrapParagraphs(grouped.join(newline));
        result = autoLinkLocalHttp(result);
        result = restoreMarkdownLinks(result);
        return '<div class="markdown-content">' + result.split(codeNewline).join(newline) + '</div>';
      }

      function highlightCode(code, lang) {
        // 入参已由 renderMarkdown 顶部的 escapeHtml 处理过。这里再转义一次会让
        // 代码里的 & 和尖括号变成第二层 HTML 实体，屏幕上和「复制」出来的都不对。
        // 真正接语法高亮时，标注必须建立在「已转义文本」之上，不能重新转义。
        return code;
      }

      export function shortCommand(cmd) {
        var s = String(cmd || "").trim();
        return s.length <= 24 ? s || "未选择会话" : s.slice(0, 21) + "...";
      }
