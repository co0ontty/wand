import { state } from "./state";
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
import { getCardDefault, snapExpandedActivityFoldsToBottom } from "./events";
import { CHAT_RENDER_IDLE_MS, CHAT_RENDER_LIVE_MS } from "./terminal";
import { shouldExtractPtySystemInfo } from "./pty-system-info";
import { codexActivityRe, codexFooterRe, isPtyCodexNoiseLine, isPtySystemInfoNoiseLine, isPtyTranscriptNoiseLine } from "./pty-noise";
import { getToolDisplayName, getToolIcon } from "./tool-identity";
import { localFilePreviewHref, localHttpPreviewHref } from "../react/local-preview/controller";
import {
  agentRunBlockKey,
  agentRunTouchesMessage,
  buildAgentRunRenderSignature,
  collectAgentRuns,
  deriveSubagentMeta,
  getAgentRunStatusSummary,
  getLatestAgentRunId,
  shouldAgentRunStartExpanded,
} from "./agent-runs";
import "./local-preview-adapter";



      export function renderChat(forceFullRender?) {
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
        state.chatRenderTimer = setTimeout(function() {
          state.chatRenderTimer = null;
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (selectedSession) {
              state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, selectedSession.output, true));
          }
          renderChat();
        }, delay);
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

      export function doRenderChat(forceFullRender) {
        var chatOutput = document.getElementById("chat-output");
        if (!chatOutput) return;

        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSession) {
          if (state.lastRenderedEmpty !== "none") {
            renderChatEmptyState(chatOutput, '<div class="empty-state"><strong>未选择会话</strong><br>点击上方「新对话」开始你的第一次对话。</div>');
            state.lastRenderedEmpty = "none";
            state.lastRenderedMsgCount = 0;
          }
          return;
        }

        var allMessages = state.currentMessages;
        // Agent Run 是聊天渲染的稳定索引：dispatch、子 Agent 轨迹、最终 result
        // 可能分散在多条消息里，不能在单条消息内各自计算一份。
        var agentRunIndex = collectAgentRuns(allMessages);
        var agentRunSignature = buildAgentRunRenderSignature(agentRunIndex);
        // inFlight 的状态切换本身也应该刷新 Run：例如中断会话恢复执行时，
        // 新状态要把未完成的 Run 从“已中断”切回“运行中”，即使正文还没有新内容。
        agentRunSignature += "|live:" + (selectedSession.status === "running" &&
          selectedSession.structuredState && selectedSession.structuredState.inFlight ? "1" : "0");
        var conversationToolResults = buildConversationToolResultMap(allMessages);
        _currentLatestAgentRunId = getLatestAgentRunId(agentRunIndex);

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

        // Check if messages actually changed
        var msgCount = messages.length;
        var outputHash = selectedSession.output ? selectedSession.output.length : 0;
        // For structured messages, hash block count + content lengths for change detection
        if (selectedSession.messages && selectedSession.messages.length > 0) {
          var totalBlocks = 0;
          var contentLen = 0;
          for (var bi = 0; bi < selectedSession.messages.length; bi++) {
            var msgContent = selectedSession.messages[bi].content;
            if (msgContent) {
              if (Array.isArray(msgContent)) {
                totalBlocks += msgContent.length;
                // Include all block content lengths for change detection
                for (var bj = 0; bj < msgContent.length; bj++) {
                  var block = msgContent[bj];
                  if (block.text) contentLen += block.text.length;
                  if (block.thinking) contentLen += block.thinking.length;
                  if (block.content) contentLen += block.content.length; // tool_result content
                  if (block.id) contentLen += block.id.length; // tool_use id
                  if (block.tool_use_id) contentLen += block.tool_use_id.length; // tool_result id
                  if (block.description) contentLen += block.description.length; // tool_use description
                  if (block.input) contentLen += JSON.stringify(block.input).length; // tool_use input
                }
                if (selectedSession.messages[bi].usage) {
                  var hashUsage = selectedSession.messages[bi].usage;
                  // Hash values (not JSON length): 12→13 tokens must re-render even
                  // though the serialized object keeps exactly the same length.
                  contentLen += (hashUsage.inputTokens || 0)
                    + (hashUsage.outputTokens || 0)
                    + (hashUsage.cacheReadInputTokens || 0)
                    + (hashUsage.cacheCreationInputTokens || 0)
                    + (hashUsage.reasoningOutputTokens || 0)
                    + Math.round((hashUsage.totalCostUsd || 0) * 1000000)
                    + (hashUsage.estimated === true ? 1 : 0);
                }
              } else {
                totalBlocks += 1;
                contentLen = String(msgContent).length;
              }
            }
          }
          outputHash = msgCount * 100000 + totalBlocks * 1000 + contentLen;
        }

        // Force full render if message count changed, an Agent Run changed shape/status,
        // or explicitly requested. Run details live on the dispatch message, so a result
        // arriving in a later message must rebuild that older anchor instead of appending
        // an isolated result bubble.
        var forceRender = forceFullRender || msgCount !== state.lastRenderedMsgCount ||
          agentRunSignature !== state.lastRenderedAgentRunSignature;
        if (!forceRender && msgCount === state.lastRenderedMsgCount && outputHash === state.lastRenderedHash) {
          // Even if message content hasn't changed, update the status bar
          // (inFlight state may have changed without new message content)
          var chatMessages = chatOutput.querySelector(".chat-messages");
          if (chatMessages) renderStructuredStatusBar(chatMessages, selectedSession);
          // 同步刷一次进度条：inFlight 从 true→false 时（turn 结束）没有新消息，
          // updateTodoProgress 不被调到就会让"5/6"卡在底部一直不消失。
          updateTodoProgress(allMessages);
          return;
        }
        var prevHash = state.lastRenderedHash;
        var prevMsgCount = state.lastRenderedMsgCount;
        state.lastRenderedMsgCount = msgCount;
        state.lastRenderedHash = outputHash;
        state.lastRenderedAgentRunSignature = agentRunSignature;

        chatMessages = ensureChatMessagesContainer(chatOutput);
        if (!chatMessages) return;

        // 在动 DOM 之前先看用户是不是贴在底部——这决定后面我们要不要让视图
        // "继续粘在底部"。column-reverse 下 scrollTop 接近 0 = 视觉底部。
        // 注意：state.chatStickToBottom 的维护**完全交给 scroll handler**
        // （bindChatScrollListener + wheel/touch 提前下台），这里不再做
        // "近底即锁回 true"的自愈，避免 resize / 键盘动画 / 锚点回填瞬间
        // 把已经上滚阅读的用户误判回贴底状态。
        var renderWasAtBottom = isChatNearBottom(chatMessages);
        var renderIsInitial = !state.chatInitialRenderDone;

        // 把 .system-info 卡片从计数里剔除——它由 extractPtySystemInfo 在
        // fullRenderChat 里穿插注入，不存在于 messages 数组中，混进 existingCount
        // 会让 msgCount !== existingCount 永远为真，每帧都走 fullRenderChat，从而
        // 不断 wipe innerHTML，触发"莫名其妙跳到最上面"的视觉错位。
        var existingCount = chatMessages.querySelectorAll(".chat-message:not(.system-info)").length;
        // Full render when: forced, no existing messages, or message count decreased/changed
        var needsFullRender = forceRender || existingCount === 0 || msgCount !== existingCount;

        function fullRenderChat() {
          // Extract system info from PTY output
          var systemInfo = shouldExtractPtySystemInfo(selectedSession)
            ? extractPtySystemInfo(selectedSession.output, messages)
            : [];

          // Build HTML with system info cards interleaved
          var html = '';
          var reversedMessages = messages.slice().reverse();
          var visibleCount = messages.length;

          for (var i = 0; i < reversedMessages.length; i++) {
            var msg = reversedMessages[i];
            var localIndex = visibleCount - 1 - i; // Index within visible slice
            var originalIndex = localIndex + visibleOffset; // Index in full messages array

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
            html += renderChatMessage(
              msg,
              roundUsageByIndex[originalIndex] || null,
              originalIndex,
              agentRunIndex,
              conversationToolResults
            );
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
          var anchorMsgIndex = -1;
          var anchorOffset = 0;
          if (existingCount > 0 && !renderWasAtBottom) {
            var containerTop = chatMessages.getBoundingClientRect().top;
            var preEls = chatMessages.querySelectorAll(".chat-message:not(.system-info)");
            for (var pi = 0; pi < preEls.length; pi++) {
              var rect = preEls[pi].getBoundingClientRect();
              // 第一条 top >= containerTop 的就是视口内最靠上的可见消息
              if (rect.bottom >= containerTop) {
                var idxAttr = preEls[pi].getAttribute("data-msg-index");
                if (idxAttr != null) {
                  anchorMsgIndex = parseInt(idxAttr, 10);
                  anchorOffset = rect.top - containerTop;
                }
                break;
              }
            }
          }

          chatMessages.innerHTML = html;
          // 给每条消息打 data-msg-index（用 state.currentMessages 的全局索引），
          // 后面 refreshChatUnreadDivider 用它找未读分割线的位置。
          (function() {
            var msgEls = chatMessages.querySelectorAll(".chat-message:not(.system-info)");
            // column-reverse: DOM[0] = 最新（最高 originalIndex）
            var totalVisible = msgEls.length;
            for (var idx = 0; idx < totalVisible; idx++) {
              msgEls[idx].setAttribute("data-msg-index", String(visibleOffset + totalVisible - 1 - idx));
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
          } else if (anchorMsgIndex >= 0) {
            // 用户当前不在底部——根据保存的锚点恢复视图位置，避免被"踢到最上面"。
            var newAnchor = chatMessages.querySelector(
              '.chat-message[data-msg-index="' + anchorMsgIndex + '"]'
            );
            if (newAnchor) {
              var newContainerTop = chatMessages.getBoundingClientRect().top;
              var newRect = newAnchor.getBoundingClientRect();
              var delta = (newRect.top - newContainerTop) - anchorOffset;
              if (Math.abs(delta) > 0.5) {
                state.chatIsProgrammaticScroll = true;
                chatMessages.scrollTop += delta;
                requestAnimationFrame(function() { state.chatIsProgrammaticScroll = false; });
              }
            }
          }
          attachAllCopyHandlers(chatMessages);
          bindChatScrollListener();
          applyPersistedExpandState(chatMessages);
          // 不主动 smartScrollToBottom——同一会话的全量重渲染要么是
          // streaming fallback（页面位置应保持），要么是 msgCount 减少（极少见，
          // 走 prevMsgCount===0 那条分支已经处理）。让浏览器自带的 scroll
          // anchoring 接手，避免在用户阅读时把视图拽走。
          requestAnimationFrame(function() {
            refreshChatUnreadDivider(chatMessages);
            updateChatUnreadBubble();
            observeLoadMoreSentinel();
          });
        }

        // Pre-compute per-round cumulative usage using original (full array) indices.
        // A "round" starts at a user message and includes all subsequent assistant turns
        // until the next user message. Only the last assistant in each round shows the total.
        var roundUsageByIndex = {};
        (function() {
          var acc = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalCostUsd: 0, estimated: false };
          var hasUsage = false;
          var lastAssistantIdx = -1;
          for (var mi = 0; mi < allMessages.length; mi++) {
            var m = allMessages[mi];
            if (m.role === "user") {
              if (lastAssistantIdx >= 0 && hasUsage) {
                roundUsageByIndex[lastAssistantIdx] = acc;
              }
              acc = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalCostUsd: 0, estimated: false };
              hasUsage = false;
              lastAssistantIdx = -1;
            } else if (m.role === "assistant" && m.usage) {
              var u = m.usage;
              hasUsage = true;
              acc.inputTokens += (u.inputTokens || 0);
              acc.outputTokens += (u.outputTokens || 0);
              acc.cacheReadInputTokens += (u.cacheReadInputTokens || 0);
              acc.cacheCreationInputTokens += (u.cacheCreationInputTokens || 0);
              acc.reasoningOutputTokens += (u.reasoningOutputTokens || 0);
              acc.totalCostUsd += (u.totalCostUsd || 0);
              acc.estimated = acc.estimated || u.estimated === true;
              lastAssistantIdx = mi;
            } else if (m.role === "assistant") {
              lastAssistantIdx = mi;
            }
          }
          if (lastAssistantIdx >= 0 && hasUsage) {
            roundUsageByIndex[lastAssistantIdx] = acc;
          }
        })();

        if (needsFullRender) {
          fullRenderChat();
        } else if (msgCount > existingCount) {
          // New messages added — prepend them (column-reverse means prepend = visual append)
          var newMessages = messages.slice(existingCount);
          // Reverse so the newest ends up at the bottom
          newMessages.reverse();
          var fragment = document.createDocumentFragment();
          var insertedEls = [];
          // 记录每条新消息的 originalIndex，方便后面打标签 / 计算未读起点。
          var insertedOrigIdx = [];
          // 第一条新消息（数组里 index 最小的，时间上最早的那条）对应的全局索引——
          // 用作未读起点。
          var firstNewOrigIdx = visibleOffset + existingCount;
          for (var i = 0; i < newMessages.length; i++) {
            var div = document.createElement("div");
            var nmOrigIdx = visibleOffset + existingCount + (newMessages.length - 1 - i);
            div.innerHTML = renderChatMessage(
              newMessages[i],
              roundUsageByIndex[nmOrigIdx] || null,
              nmOrigIdx,
              agentRunIndex,
              conversationToolResults
            );
            var el = div.firstElementChild;
            if (el) {
              el.classList.add("animate-in");
              el.setAttribute("data-msg-index", String(nmOrigIdx));
              insertedEls.push(el);
              insertedOrigIdx.push(nmOrigIdx);
              fragment.appendChild(el);
            }
          }
          chatMessages.insertBefore(fragment, chatMessages.firstChild);
          bindChatScrollListener();
          attachAllCopyHandlers(chatMessages);
          applyPersistedExpandState(chatMessages);
          // Telegram 行为：
          // - 用户原本就贴在底部 → 维持贴底（column-reverse 通常会自动留在底部，
          //   但浏览器的 scroll anchoring 在某些边界场景会把 scrollTop 调成非 0；
          //   这里显式拉回 0 做兜底，不用动画，不会让用户感觉"被甩"）。
          // - 用户已经滚上去 → 一根毛都不动他的视图，只把未读累到气泡里。
          if (renderWasAtBottom) {
            requestAnimationFrame(function() {
              if (chatMessages.isConnected && Math.abs(chatMessages.scrollTop) > 1) {
                state.chatIsProgrammaticScroll = true;
                chatMessages.scrollTop = 0;
                requestAnimationFrame(function() { state.chatIsProgrammaticScroll = false; });
              }
              // 视为已读 —— 用户当前就在底部看着，这些新消息直接进入"已读"。
              clearChatUnread({ removeDivider: true });
              updateChatUnreadBubble();
            });
          } else {
            // 累计未读。如果之前没有未读，就用这一批的最早一条做分割线起点。
            if (state.chatUnreadStartIndex < 0) {
              state.chatUnreadStartIndex = firstNewOrigIdx;
            }
            state.chatUnreadCount += insertedEls.length;
            refreshChatUnreadDivider(chatMessages);
            updateChatUnreadBubble();
          }
        } else if (msgCount === existingCount && outputHash !== prevHash) {
          // Same message count but content changed (streaming update).
          // Optimization: only re-render the newest N messages (column-reverse: first children)
          // that actually differ, starting from the top (newest). Most streaming updates only
          // touch the latest assistant turn, so we can skip scanning all older messages.
          // 同样剔除 system-info 卡片，否则 existingEls 长度对不上 reversedMessages，
          // top-N 对照会拿 system-info 卡片去比真消息的 HTML，永远 replacedAny=false，
          // 触发 fullRenderChat 兜底分支——这是滚动跳顶的另一条触发路径。
          var existingEls = Array.from(chatMessages.querySelectorAll(".chat-message:not(.system-info)"));
          var reversedMessages = messages.slice().reverse();
          var replacedAny = false;
          // Scan from newest (index 0 in reversed) up to MAX_STREAMING_SCAN messages
          var MAX_STREAMING_SCAN = Math.min(4, reversedMessages.length, existingEls.length);
          for (var mi = 0; mi < MAX_STREAMING_SCAN; mi++) {
            var currentEl = existingEls[mi];
            var tmpWrap = document.createElement("div");
            var srOrigIdx = visibleOffset + reversedMessages.length - 1 - mi;
            tmpWrap.innerHTML = renderChatMessage(
              reversedMessages[mi],
              roundUsageByIndex[srOrigIdx] || null,
              srOrigIdx,
              agentRunIndex,
              conversationToolResults
            );
            var replacementEl = tmpWrap.firstElementChild;
            if (!replacementEl) continue;
            if (currentEl.innerHTML !== replacementEl.innerHTML || currentEl.className !== replacementEl.className) {
              chatMessages.replaceChild(replacementEl, currentEl);
              attachCopyHandler(replacementEl);
              replacedAny = true;
            } else if (mi > 0) {
              // Once we hit an unchanged older message, stop scanning
              break;
            }
          }
          // Fallback: if hash changed but no visible diff found in the top N messages,
          // the change is deeper — trigger a full render to avoid stale display.
          if (!replacedAny && reversedMessages.length > MAX_STREAMING_SCAN) {
            fullRenderChat();
          }
          if (replacedAny) {
            bindChatScrollListener();
            applyPersistedExpandState(chatMessages);
            // Streaming 更新只是改最新一条的内容，不改条数。column-reverse 下
            // 浏览器的 scroll anchoring 会自动保持视觉位置；用户贴底时新内容
            // 自然出现在底部，用户上滚时视图也不受打扰——不需要再 smartScroll。
            requestAnimationFrame(function() {
              // 兜底：用户贴底时如果浏览器把 scrollTop 调成非零，拉回来。
              if (renderWasAtBottom && chatMessages.isConnected && Math.abs(chatMessages.scrollTop) > 1) {
                state.chatIsProgrammaticScroll = true;
                chatMessages.scrollTop = 0;
                requestAnimationFrame(function() { state.chatIsProgrammaticScroll = false; });
              }
              refreshChatUnreadDivider(chatMessages);
              updateChatUnreadBubble();
            });
          }
        } else if (msgCount < existingCount) {
          fullRenderChat();
        }

        // 活动折叠仍是固定高度窗口；子 Agent 执行卡已经改用主对话滚动，
        // 这里只负责把展开中的活动窗口锚到最新内容。
        snapExpandedActivityFoldsToBottom(chatMessages);

        // 发新消息后把"最后一条用户消息"之前的历史折叠成摘要卡（后处理，不动上面的 DOM diff）。
        applyHistoryCollapse(chatMessages, selectedSession);

        // 旧版会在顶部固定最新一轮预览；现在每次渲染都清掉该横条。
        applyAutoFoldBar(chatOutput, chatMessages, allMessages, renderIsInitial);

        // Update structured session status bar (in-flight / completed indicator)
        renderStructuredStatusBar(chatMessages, selectedSession);

        // Update todo progress bar from latest messages
        updateTodoProgress(allMessages);
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
          btn.addEventListener("click", function() {
            var codeBlock = btn.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              copyToClipboard(code.textContent || "", null, function() {
                btn.textContent = "Copied!";
                btn.classList.add("copied");
                setTimeout(function() { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
              });
            }
          });
        });
      }

      function attachAllCopyHandlers(container) {
        container.querySelectorAll(".code-copy").forEach(function(btn) {
          var clone = btn.cloneNode(true);
          btn.parentNode.replaceChild(clone, btn);
          clone.addEventListener("click", function() {
            var codeBlock = clone.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              copyToClipboard(code.textContent || "", null, function() {
                clone.textContent = "Copied!";
                clone.classList.add("copied");
                setTimeout(function() { clone.textContent = "Copy"; clone.classList.remove("copied"); }, 2000);
              });
            }
          });
        });
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
      function agentRunAccent(agent) {
        var seed = (agent && (agent.meta.agentType || agent.taskId)) || "agent-run";
        return AGENT_RUN_ACCENTS[hashStringToIndex(seed, AGENT_RUN_ACCENTS.length)];
      }
      function agentRunStatusLabel(status) {
        if (status === "failed") return t("agentRun.status.failed");
        if (status === "running") return t("agentRun.status.running");
        if (status === "interrupted") return t("agentRun.status.interrupted");
        return t("agentRun.status.completed");
      }
      function agentRunStatusIcon(status) {
        if (status === "failed") return iconSvg("close", { size: 12, strokeWidth: 2.2 });
        if (status === "running") return iconSvg("refresh", { size: 12, strokeWidth: 1.8 });
        if (status === "interrupted") return iconSvg("warning", { size: 12, strokeWidth: 1.8 });
        return iconSvg("check", { size: 12, strokeWidth: 2.2 });
      }
      function agentRunAgentName(agent) {
        return (agent && agent.meta.agentType && String(agent.meta.agentType).trim()) || t("agentRun.agent");
      }
      function agentRunTaskDescription(agent) {
        var task = agent && agent.meta.taskDescription && String(agent.meta.taskDescription).trim();
        return task || t("agentRun.noTask");
      }
      function agentRunResultText(agent) {
        if (!agent || !agent.result) return "";
        var value = extractToolResultText(agent.result.block.content);
        return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
      }
      function agentRunLatestText(agent, status) {
        var resultText = agentRunResultText(agent);
        if (resultText) return resultText;
        var blocks = agent && Array.isArray(agent.blocks) ? agent.blocks : [];
        for (var i = blocks.length - 1; i >= 0; i--) {
          var ref = blocks[i];
          var block = ref && ref.block;
          if (!block) continue;
          if (block.type === "text" && String(block.text || "").trim()) {
            return String(block.text).replace(/\s+/g, " ").trim();
          }
          if (block.type === "thinking" && String(block.thinking || "").trim()) {
            return String(block.thinking).replace(/\s+/g, " ").trim();
          }
          if (block.type === "tool_use") {
            var label = activityItemLabel(block);
            if (label) return label;
          }
        }
        if (status === "running") return t("agentRun.waiting");
        return t("agentRun.noOutput");
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
      function agentRunLatestSummary(run, isLive) {
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
        return latestAgent ? truncateInline(agentRunLatestText(latestAgent, getAgentRunStatusSummary({ agents: [latestAgent] } as any, isLive).status), 220) : "";
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
      function renderAgentRunResultHtml(agent) {
        if (!agent || !agent.result) return "";
        var resultBlock = agent.result.block || {};
        var isError = resultBlock.is_error === true;
        var rawText = agentRunResultText(agent);
        var displayText = rawText || t("agentRun.noOutput");
        var bodyHtml = rawText ? renderMarkdown(displayText) : escapeHtml(displayText);
        return '<div class="agent-run-result' + (isError ? ' is-error' : '') + '">' +
          '<div class="agent-run-result-label">' +
            '<span class="agent-run-result-icon" aria-hidden="true">' + agentRunStatusIcon(isError ? "failed" : "completed") + '</span>' +
            '<span>' + escapeHtml(isError ? t("agentRun.result.failed") : t("agentRun.result.done")) + '</span>' +
          '</div>' +
          '<div class="agent-run-result-content">' + bodyHtml + '</div>' +
        '</div>';
      }
      function renderAgentRunTimelineHtml(agent, status, role, toolResults, messageKey) {
        var html = "";
        var blocks = agent && Array.isArray(agent.blocks) ? agent.blocks : [];
        for (var i = 0; i < blocks.length; i++) {
          html += renderAgentRunStepHtml(blocks[i], role || "assistant", toolResults, messageKey);
        }
        // 只有最终 result、没有中间过程时，结果为唯一信息，不要再先放一行重复状态。
        if (!html.trim() && !(agent && agent.result)) {
          html = '<div class="agent-run-waiting">' + escapeHtml(agentRunStatusLabel(status)) + '</div>';
        }
        return html + renderAgentRunResultHtml(agent);
      }
      function agentRunPanelId(runId, taskId) {
        return "agent-run-panel-" + String(runId + "-" + taskId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
      }
      function renderAgentRunDetailHtml(run, agent, selected, role, toolResults, messageKey, isLive, isMulti) {
        var taskId = agent.taskId;
        var agentStatus = getAgentRunStatusSummary({ agents: [agent] } as any, isLive).status;
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
            '<div>' +
              '<div class="agent-run-detail-name">' + escapeHtml(agentRunAgentName(agent)) + '</div>' +
              '<div class="agent-run-detail-task">' + escapeHtml(agentRunTaskDescription(agent)) + '</div>' +
            '</div>' +
            '<span class="agent-run-detail-state">' + escapeHtml(agentRunStatusLabel(agentStatus)) + '</span>' +
          '</div>' +
          '<div class="agent-run-timeline">' + renderAgentRunTimelineHtml(agent, agentStatus, role, toolResults, messageKey) + '</div>' +
        '</div>';
      }
      function renderAgentRunHtml(run, isLive, role, toolResults, messageKey) {
        if (!run || !run.agents.length) return "";
        var summary = getAgentRunStatusSummary(run, isLive);
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
            var candidateStatus = getAgentRunStatusSummary({ agents: [run.agents[j]] } as any, isLive).status;
            if (!selectedAgent || candidateStatus === "failed" || (candidateStatus === "running" && selectedAgent !== run.agents[j])) {
              selectedAgent = run.agents[j];
            }
            if (candidateStatus === "failed") break;
          }
        }
        selectedAgent = selectedAgent || run.agents[0];
        var bodyId = "agent-run-body-" + String(run.id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
        var latest = agentRunLatestSummary(run, isLive);
        var countText = t("agentRun.count", { count: String(summary.total) });
        var summaryAria = t("agentRun.summary_aria", {
          count: String(summary.total),
          status: agentRunStatusLabel(summary.status),
          latest: latest || t("agentRun.noOutput"),
        });
        var railHtml = "";
        var detailHtml = "";
        var isMulti = run.agents.length > 1;
        for (var k = 0; k < run.agents.length; k++) {
          var agent = run.agents[k];
          var agentSummary = getAgentRunStatusSummary({ agents: [agent] } as any, isLive);
          var isSelected = agent === selectedAgent;
          var panelId = agentRunPanelId(run.id, agent.taskId);
          var tabId = panelId + "-tab";
          if (isMulti) railHtml += '<button type="button" class="agent-run-agent' + (isSelected ? ' is-selected' : '') + '" ' +
              'id="' + escapeHtml(tabId) + '" role="tab" aria-controls="' + escapeHtml(panelId) + '" ' +
              'aria-selected="' + (isSelected ? "true" : "false") + '" ' +
              'tabindex="' + (isSelected ? "0" : "-1") + '" data-agent-task-id="' + escapeHtml(agent.taskId) + '" ' +
              'data-agent-run-id="' + escapeHtml(run.id) + '" onclick="__agentRunSelect(event, this)" ' +
              'onkeydown="__agentRunSelect(event, this)" ' +
              'style="--agent-color:' + escapeHtml(agentRunAccent(agent)) + '">' +
            '<span class="agent-run-agent-marker" aria-hidden="true"></span>' +
            '<span class="agent-run-agent-copy">' +
              '<strong>' + escapeHtml(agentRunAgentName(agent)) + '</strong>' +
              '<span>' + escapeHtml(truncateInline(agentRunTaskDescription(agent), 86)) + '</span>' +
            '</span>' +
            '<span class="agent-run-agent-status is-' + agentSummary.status + '">' + escapeHtml(agentRunStatusLabel(agentSummary.status)) + '</span>' +
          '</button>';
          detailHtml += renderAgentRunDetailHtml(run, agent, isSelected, role, toolResults, messageKey, isLive, isMulti);
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
                '<strong class="agent-run-title">' + escapeHtml(t("agentRun.title")) + '</strong>' +
                '<span class="agent-run-count">' + escapeHtml(countText) + '</span>' +
                '<span class="agent-run-status-label is-' + summary.status + '">' + escapeHtml(agentRunStatusLabel(summary.status)) + '</span>' +
              '</span>' +
              '<span class="agent-run-latest">' +
                '<span class="agent-run-latest-label">' + escapeHtml(t("agentRun.latest")) + '</span>' +
                '<span class="agent-run-latest-text">' + escapeHtml(latest || t("agentRun.waiting")) + '</span>' +
              '</span>' +
            '</span>' +
            '<span class="agent-run-chevron" aria-hidden="true">' + iconSvg("chevronDown", { size: 14, strokeWidth: 2 }) + '</span>' +
          '</button>' +
          '<div class="agent-run-body" id="' + escapeHtml(bodyId) + '" aria-hidden="' + (expanded ? "false" : "true") + '">' +
            (isMulti
              ? '<div class="agent-run-rail" role="tablist" aria-label="' + escapeHtml(t("agentRun.agent_list")) + '">' + railHtml + '</div>'
              : '') +
            '<div class="agent-run-detail">' + detailHtml + '</div>' +
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

      function chatAvatar(role) {
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

      function renderChatMessage(msg, roundUsage, messageIndex, agentRunIndex, conversationToolResults) {
        // Thinking card (deep thought) — from PTY parsing
        if (msg.role === "thinking") {
          // 空 / 全空白的 thinking 没有任何信息量，渲染出来只是一条带"展开"的紫色窄条，
          // 展开了也看不到内容——直接跳过。
          var ptyThinkingText = typeof msg.content === "string" ? msg.content : "";
          if (!ptyThinkingText.trim()) return "";
          var thinkingKey = buildExpandKey("thinking", [getMessageKey(msg, messageIndex), "pty"]);
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
          return renderStructuredMessage(msg, roundUsage, messageIndex, agentRunIndex, conversationToolResults);
        }

        // Legacy string content (from PTY parsing)
        var avatar = chatAvatar(msg.role);
        var bubbleContent = msg.role === "assistant"
          ? renderMarkdown(msg.content)
          : (msg.role === "user" ? renderUserText(msg.content) : escapeHtml(msg.content));
        return '<div class="chat-message ' + msg.role + '">' +
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

      // ── 连续同类工具调用分组 ──
      // 注意：禁止把 Task/Agent 加入 GROUPABLE_TOOLS——它们由 renderContentBlock 入口屏蔽返空，
      // 加入分组会导致空 group 包裹一堆空字符串，留下视觉空盒子。
      var GROUPABLE_TOOLS = { Read: 1, Glob: 1, Grep: 1, WebFetch: 1, WebSearch: 1, TodoRead: 1 };

      // 图片相关的操作不并入 tool-group：并到默认折叠的 group 里，body 整体
      // display:none 会把内联缩略图一起藏掉。单独成卡时缩略图常驻可见，符合
      // “对话里的图片操作默认直接显示、不折叠”。
      function isGroupableToolBlock(block) {
        if (!block || block.type !== "tool_use" || !GROUPABLE_TOOLS[block.name]) return false;
        if (block.name === "Read") {
          var input = block.input || {};
          if (isImagePath(input.file_path || input.path || "")) return false;
        }
        return true;
      }

      function groupConsecutiveTools(content) {
        var groups = [];
        var i = 0;
        while (i < content.length) {
          var block = content[i];
          if (block.type === "tool_result") { i++; continue; }
          if (isGroupableToolBlock(block)) {
            var run = [{ block: block, index: i }];
            var j = i + 1;
            while (j < content.length) {
              if (content[j].type === "tool_result") { j++; continue; }
              if (isGroupableToolBlock(content[j])) {
                run.push({ block: content[j], index: j });
                j++;
              } else { break; }
            }
            if (run.length >= 2) {
              groups.push({ type: "group", items: run, endIndex: j });
            } else {
              groups.push({ type: "single", block: block, index: i });
            }
            i = j;
          } else {
            groups.push({ type: "single", block: block, index: i });
            i++;
          }
        }
        return groups;
      }

      var TOOL_GROUP_LABELS = { Read: "读取", Glob: "搜索", Grep: "搜索", WebFetch: "抓取", WebSearch: "搜索", TodoRead: "待办" };

      function renderToolGroup(items, role, toolResults, messageKey, options?: any) {
        var opts = options || {};
        // Count by tool name
        var counts = {};
        for (var k = 0; k < items.length; k++) {
          var n = items[k].block.name;
          counts[n] = (counts[n] || 0) + 1;
        }
        // Check if all done or still pending
        var allDone = true;
        var anyError = false;
        for (var k = 0; k < items.length; k++) {
          var b = items[k].block;
          var tr = pickToolResultForDisplay(toolResults, b.id);
          if (!tr) { allDone = false; }
          else if (tr.is_error) { anyError = true; }
        }
        var statusIcon = !allDone
          ? "…"
          : (anyError
            ? iconSvg("close", { size: 11, strokeWidth: 2.2 })
            : iconSvg("check", { size: 11, strokeWidth: 2.2 }));
        var statusClass = !allDone ? "pending" : (anyError ? "error" : "done");
        // Summary text
        var parts = [];
        for (var name in counts) {
          parts.push(counts[name] + " " + (TOOL_GROUP_LABELS[name] || name));
        }
        var summaryText = parts.join(" · ");
        var groupKey = buildExpandKey("tool-group", [messageKey, items[0] && items[0].index, items.length]);
        var persistedExpanded = getPersistedExpandState(groupKey);
        var shouldExpand = opts.forceExpandedToolBodies ? true : (persistedExpanded === null ? getCardDefault("toolGroup") : persistedExpanded);

        // Render each item's inline-tool card
        var innerHtml = "";
        for (var k = 0; k < items.length; k++) {
          try {
            innerHtml += renderContentBlock(items[k].block, role, toolResults, items[k].index, messageKey, opts);
          } catch (e) {
            innerHtml += '<div class="render-error">工具渲染失败</div>';
          }
        }

        return '<div class="tool-group" data-expand-kind="tool-group" data-expand-key="' + escapeHtml(groupKey) + '" data-expanded="' + (shouldExpand ? 'true' : 'false') + '" data-status="' + statusClass + '">' +
          '<div class="tool-group-summary" onclick="__toolGroupToggle(this.parentNode)">' +
            '<span class="tool-group-status">' + statusIcon + '</span>' +
            '<span class="tool-group-text">' + escapeHtml(summaryText) + '</span>' +
            '<span class="tool-group-count">' + items.length + ' 个调用</span>' +
            '<svg class="tool-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:' + (shouldExpand ? 'rotate(180deg)' : '') + '"><polyline points="6 9 12 15 18 9"/></svg>' +
          '</div>' +
          '<div class="tool-group-body" style="display:' + (shouldExpand ? 'block' : 'none') + ';">' + innerHtml + '</div>' +
        '</div>';
      }

      // global toggle
      window.__toolGroupToggle = function(el) {
        if (!el) return;
        var expanded = el.getAttribute("data-expanded") === "true";
        el.setAttribute("data-expanded", expanded ? "false" : "true");
        var body = el.querySelector(".tool-group-body");
        if (body) (body as HTMLElement).style.display = expanded ? "none" : "block";
        var chevron = el.querySelector(".tool-group-chevron");
        if (chevron) (chevron as HTMLElement).style.transform = expanded ? "" : "rotate(180deg)";
        persistElementExpandState(el, "tool-group");
      };

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
          var historical = idx < lastUserIdx;
          var key = buildExpandKey(historical ? "assistant-reply-history" : "assistant-reply-current", [getMessageKey(allMessages[idx], idx)]);
          var persisted = getPersistedExpandState(key);
          // 最新轮次的 assistant 回复始终展开，不沿用历史持久化折叠状态；
          // 只有历史轮次才尊重用户之前的展开/折叠偏好。
          var expanded = persisted === null ? true : persisted;
          var disclosure = el.querySelector(":scope > .assistant-reply-disclosure");
          if (!disclosure) {
            disclosure = document.createElement("button");
            disclosure.className = "assistant-reply-disclosure";
            disclosure.setAttribute("type", "button");
            el.insertBefore(disclosure, el.firstChild);
          }
          disclosure.setAttribute("data-expand-key", key);
          disclosure.setAttribute("aria-expanded", expanded ? "true" : "false");
          var previewText = getMessagePreviewText(allMessages[idx]) || "助手回复";
          disclosure.innerHTML =
            '<span class="assistant-reply-label">回复</span>' +
            '<span class="assistant-reply-preview" title="' + escapeHtml(previewText) + '">' + escapeHtml(previewText) + '</span>' +
            '<span class="assistant-reply-action">' + (expanded ? "收起" : "展开") + '</span>' +
            '<span class="assistant-reply-chevron">' + iconSvg("chevronDown", { size: 15 }) + '</span>';
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

      // ===== 普通活动折叠 =================================================
      // 连续 thinking / 工具调用收成一条状态条；正文出现就切断当前活动。
      // Agent Run 有自己的摘要 + 轨迹容器，不进入这条普通折叠路径。
      var ACTIVITY_FOLD_ENABLED = true;
      // 当前正在渲染的消息在 state.currentMessages 里的全局下标。渲染是同步单线程的，
      // 在 renderStructuredMessage 入口设置一次即可让下游活动折叠判断运行态。
      var _currentMessageGlobalIndex = -1;
      // 当前渲染批次里“最新的 Agent Run”id。只有它可能是 live（running）状态——
      // 更早的 Run 结论已定，不能再被当作进行中。
      var _currentLatestAgentRunId = "";

      // Agent dispatch 和 tool_result 都由 Run 或对应 tool card 消费，普通活动折叠
      // 不应再把它们当成独立可见步骤。
      function isHiddenActivityBlock(block) {
        if (!block) return true;
        if (block.type === "thinking") return !String(block.thinking || "").trim();
        if (block.type === "tool_use" && deriveSubagentMeta(block)) return true;
        if (block.type === "tool_result") return true;
        return false;
      }

      // 这个 tool_use 最终会渲染出图片吗？路径命中图片扩展名，或它的 tool_result
      // 里带 image content block，都算。这类块必须常驻可见（不能被折叠藏起来）。
      function toolBlockShowsImage(block, toolResults) {
        if (!block || block.type !== "tool_use") return false;
        var input = block.input || {};
        var candidate = input.file_path || input.path || input.url || "";
        if (typeof candidate === "string" && isImagePath(candidate)) return true;
        var result = block.id && toolResults ? pickToolResultForDisplay(toolResults, block.id) : null;
        if (result && extractToolResultImages(result.content).length > 0) return true;
        return false;
      }

      function isFoldableActivityBlock(block, toolResults) {
        if (!block) return false;
        if (block.type === "thinking") return true;
        if (block.type === "tool_use") {
          // 图片相关的调用直接常驻渲染缩略图，不折进默认折叠的窗口里藏起来。
          if (toolBlockShowsImage(block, toolResults)) return false;
          return true;
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

      function activityKindOf(name) {
        var lower = String(name || "").toLowerCase();
        if (/read|inspect|view|open|list|load/.test(lower)) return "read";
        if (/bash|exec|command|shell|stdin|terminal/.test(lower)) return "command";
        if (/grep|glob|search|find|query|lookup/.test(lower)) return "search";
        if (/edit|write|patch|replace|notebook/.test(lower)) return "edit";
        if (/web|fetch|http|url|browser/.test(lower)) return "web";
        return "other";
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
        read: "浏览", command: "命令", search: "搜索",
        edit: "编辑", web: "网页", other: "调用", thinking: "思考"
      };

      // 本轮 assistant turn 是否还在流式生成。只有「最后一条消息 + inFlight」
      // 才算活跃，避免历史 turn 的状态条常亮。
      function isTurnActivityLive(messageIndex) {
        var total = Array.isArray(state.currentMessages) ? state.currentMessages.length : 0;
        if (typeof messageIndex !== "number" || messageIndex !== total - 1) return false;
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return false;
        return !!(session.structuredState && session.structuredState.inFlight) && session.status === "running";
      }

      function summarizeActivityRun(items, toolResults) {
        var counts = { read: 0, command: 0, search: 0, edit: 0, web: 0, other: 0, thinking: 0 };
        var latest = "";
        for (var i = 0; i < items.length; i++) {
          var block = items[i].block;
          if (isHiddenActivityBlock(block)) continue;
          if (block.type === "thinking") {
            counts.thinking++;
            var thinkLabel = activityItemLabel(block);
            if (thinkLabel) latest = thinkLabel;
            continue;
          }
          if (block.type !== "tool_use") continue;
          counts[activityKindOf(block.name)]++;
          var label = activityItemLabel(block);
          if (label) latest = label;
        }
        var parts = [];
        for (var kind in ACTIVITY_KIND_META) {
          if (counts[kind] > 0) parts.push(ACTIVITY_KIND_META[kind] + " " + counts[kind]);
        }
        return {
          latest: latest || "处理中",
          meta: parts.join(" · ")
        };
      }

      function renderActivityFold(items, role, toolResults, messageKey, segmentFirstIndex, options?: any) {
        var opts = options || {};
        var visible = [];
        for (var i = 0; i < items.length; i++) {
          if (!isHiddenActivityBlock(items[i].block)) visible.push(items[i]);
        }
        // 全是空块（空 thinking / 已被消费的 tool_result）：保持旧行为不渲染，
        // 避免留下一个只有外框的空气盒子。
        if (!visible.length) return "";

        var summary = summarizeActivityRun(items, toolResults);
        // 运行态：只有「当前正在流式生成的最后一条 assistant 消息」里、位于消息
        // 尾部、且还没被正文截断的那一段才算运行中。中间被正文切开的条一律已完成。
        // 只要这条还在当前轮尾部、会话仍在跑，就保持「进行中」：工具刚结束、
        // 下一轮思考还没到时也算运行，避免被误当成卡住/结束。
        var running = !!opts.isTrailing && isTurnActivityLive(_currentMessageGlobalIndex);
        // expand key 只绑 run 的起点，流式期间不断追加 item 也不会让已展开的
        // 用户视图被重置回折叠态。
        var runStart = items.length ? items[0].index : 0;
        var expandKey = buildExpandKey("activity", [messageKey, segmentFirstIndex, runStart]);
        var persisted = getPersistedExpandState(expandKey);
        var expanded = persisted === null ? false : persisted;

        var blocksOnly = [];
        for (var b = 0; b < items.length; b++) blocksOnly.push(items[b].block);
        var bodyHtml = buildSegmentBlocksHtml(
          blocksOnly,
          segmentFirstIndex + runStart,
          role,
          toolResults,
          messageKey,
          Object.assign({}, opts, { noActivityFold: true })
        );

        return '<div class="chat-activity' + (running ? ' is-running' : '') + '" ' +
            'data-expand-kind="activity" ' +
            'data-expand-key="' + escapeHtml(expandKey) + '" ' +
            'data-follow-tail="true" ' +
            'data-expanded="' + (expanded ? "true" : "false") + '">' +
          '<button type="button" class="chat-activity-summary" aria-expanded="' + (expanded ? "true" : "false") + '" onclick="__activityToggle(this)">' +
            '<span class="chat-activity-top">' +
              (summary.meta ? '<span class="chat-activity-meta">' + escapeHtml(summary.meta) + '</span>' : "") +
              '<span class="chat-activity-count">' + visible.length + '</span>' +
              '<span class="chat-activity-chevron">' + iconSvg("chevronDown", { size: 14, strokeWidth: 2 }) + '</span>' +
            '</span>' +
            '<span class="chat-activity-latest">' +
              '<span class="chat-activity-latest-text">' + escapeHtml(summary.latest) + '</span>' +
            '</span>' +
          '</button>' +
          '<div class="chat-activity-body" aria-hidden="' + (expanded ? "false" : "true") + '"' +
            (expanded ? '' : ' style="display:none"') + '>' + bodyHtml + '</div>' +
        '</div>';
      }

      // 展开 / 收起活动窗口。展开时内部滚动到尾部（显示最新活动），
      // 折叠时只留状态条。状态按 expand key 持久化到 localStorage。
      (window as any).__activityToggle = function(btn) {
        var wrap = btn && btn.closest ? btn.closest(".chat-activity") : null;
        if (!wrap) return;
        var nowExpanded = wrap.getAttribute("data-expanded") !== "true";
        wrap.setAttribute("data-expanded", nowExpanded ? "true" : "false");
        if (btn.setAttribute) btn.setAttribute("aria-expanded", nowExpanded ? "true" : "false");
        var body = wrap.querySelector(".chat-activity-body");
        if (body) {
          body.style.display = nowExpanded ? "block" : "none";
          body.setAttribute("aria-hidden", nowExpanded ? "false" : "true");
          if (nowExpanded) {
            // 展开的瞬间先跳到底部，之后每次流式刷新由 tail 跟随逻辑接管。
            body.scrollTop = body.scrollHeight;
          }
        }
        var key = wrap.getAttribute("data-expand-key");
        if (key) setPersistedExpandState(key, nowExpanded);
      };

      // 渲染一组普通（非 Agent Run）内容 blocks。group consecutive tools，
      // 偏移到原数组全局位置，保持 expand key 唯一。
      function buildSegmentBlocksHtml(segmentBlocks, segmentFirstIndex, role, toolResults, messageKey, options?: any) {
        var html = "";
        var opts = options || {};
        // 活动折叠：连续 thinking / 工具调用收成一条状态条；正文、图片保持原位。
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
              if (isFoldableActivityBlock(fBlock, toolResults)) {
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
          var groups = groupConsecutiveTools(segmentBlocks);
          for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            try {
              if (grp.type === "group") {
                var shifted = [];
                for (var k = 0; k < grp.items.length; k++) {
                  shifted.push({ block: grp.items[k].block, index: grp.items[k].index + segmentFirstIndex });
                }
                html += renderToolGroup(shifted, role, toolResults, messageKey, opts);
              } else {
                html += renderContentBlock(grp.block, role, toolResults, grp.index + segmentFirstIndex, messageKey, opts);
              }
            } catch (e) {
              html += '<div class="render-error">消息块渲染失败</div>';
            }
          }
        } catch (e) {
          html += '<div class="render-error">消息渲染失败</div>';
        }
        return html;
      }

      function renderStructuredMessage(msg, roundUsage, messageIndex, agentRunIndex, conversationToolResults) {
        _currentMessageGlobalIndex = typeof messageIndex === "number" ? messageIndex : -1;
        var role = msg.role;
        var messageKey = getMessageKey(msg, messageIndex);
        var timeHtml = renderChatMessageTime(msg);
        var usageHtml = role === "assistant" ? renderUsageSummaryHtml(roundUsage) : "";
        var content = Array.isArray(msg.content) ? msg.content : [];
        var isQueued = role === "user" && content.some(function(b) { return b && b.__queued; });

        if (content.length === 0) {
          if (role === "assistant") {
            return '<div class="chat-message ' + role + '">' +
              timeHtml +
              chatAvatar(role) +
              '<div class="chat-message-content"><div class="typing-indicator"><span></span><span></span><span></span></div>' + usageHtml + '</div>' +
            '</div>';
          }
          return '<div class="chat-message ' + role + ' empty-message" data-message-key="' + escapeHtml(messageKey) + '">' +
            timeHtml +
            chatAvatar(role) +
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
              isAgentRunLive(run, messageIndex),
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

        var queuedClass = isQueued ? " queued" : "";
        var queuedBadge = isQueued ? '<span class="queued-badge">排队中</span>' : "";
        return '<div class="chat-message ' + role + queuedClass + '" data-message-key="' + escapeHtml(messageKey) + '">' +
          timeHtml +
          chatAvatar(role) +
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

      function isAgentRunLive(run, messageIndex) {
        if (!run || !run.id || run.id !== _currentLatestAgentRunId) return false;
        if (!agentRunTouchesMessage(run, messageIndex)) return false;
        var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!session) return false;
        return !!(session.structuredState && session.structuredState.inFlight) && session.status === "running";
      }

      function renderContentBlock(block, role, toolResults, index, messageKey, options?: any) {
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
            var thinkingExpanded = thinkingPersisted === null ? getCardDefault("thinking") : thinkingPersisted;
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
        var expandKey = buildExpandKey("inline-tool", [messageKey, toolId || index, index]);
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
        var shouldExpand = opts.forceExpandedToolBodies ? true : (persistedExpanded === null ? getCardDefault("inlineTools") : persistedExpanded);
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
        var expandKey = buildExpandKey("terminal", [messageKey, toolId || index, index]);
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
        var shouldExpand = opts.forceExpandedToolBodies ? true : (persistedExpanded === null ? getCardDefault("terminal") : persistedExpanded);

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
        var expandKey = buildExpandKey("diff", [messageKey, toolId || index, index]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var cardDefaultExpand = getCardDefault("editCards");
        var shouldExpand = opts.forceExpandedToolBodies ? true : (persistedExpanded === null ? cardDefaultExpand : persistedExpanded);
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
        var shouldExpand = opts.forceExpandedToolBodies ? true : (persistedExpanded === null ? cardDefaultExpand : persistedExpanded);
        // 带图片的工具卡默认展开：折叠会把整块 body（含缩略图）藏掉，
        // 与「图片直接展示」的诉求冲突。
        if (!opts.forceExpandedToolBodies && toolResult && extractToolResultImages(toolResult.content).length > 0) {
          shouldExpand = true;
        }
        var tcTruncated = toolResult && toolResult._truncated === true;
        var collapsedClass = shouldExpand ? "" : " collapsed";
        var toggleHtml = '<span class="tool-use-toggle">▼</span>';
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
          // 没有语言标注时留空占位（header 靠 flex 两端对齐把 Copy 推到右侧），
          // 不要写 "code" 这个假语言名。
          var replacement = '<div class="code-block">' +
            '<div class="code-block-header">' +
              '<span class="code-lang">' + (lang ? escapeHtml(lang) : "") + '</span>' +
              '<button class="code-copy">Copy</button>' +
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
        result = replaceLinePrefix(result, "### ", '<h3>', '</h3>');
        result = replaceLinePrefix(result, "## ", '<h2>', '</h2>');
        result = replaceLinePrefix(result, "# ", '<h1>', '</h1>');
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
