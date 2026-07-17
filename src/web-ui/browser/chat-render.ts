import { state, readStoredBoolean, writeStoredBoolean, CHAT_EXPAND_STATE_STORAGE_KEY } from "./state";
import { t, getActiveLang, iconSvg, I18N_DEFAULT_LANG } from "./i18n";
import { escapeHtml, formatElapsedShort, isImagePath, refreshTailMarqueePaths, renderTailMarqueePath } from "./utils";
import { applyExpandedState, applyPersistedExpandState, bindChatScrollListener, buildExpandKey, clearChatUnread, getElementExpandKey, getMessageKey, getPersistedExpandState, isChatNearBottom, observeLoadMoreSentinel, persistElementExpandState, refreshChatUnreadDivider, scrollChatToBottom, setPersistedExpandState, updateChatUnreadBubble } from "./chat-scroll";
import { copyTextSafely, showToastIfPossible, openFilePreview, appendToComposer, isMobileLayout } from "./file-browser";
import { buildMessagesForRender, focusInputBox, getSelectedSession } from "./input";
import { showToast, syncSessionProgressToNative, wandConfirm } from "./notifications";
import { render } from "./render";
import { copyToClipboard, getPreferredMessages, isRecoverableToolError, isStructuredSession, renderChatModeTrioHtml, selectSession, shouldRequestChatFormat } from "./session-engine";
import { renderStructuredStatusBar, updateRunningIndicators } from "./utils";
import { getCardDefault, snapCollapsedSubagentPanelsToBottom } from "./events";
import { CHAT_RENDER_IDLE_MS, CHAT_RENDER_LIVE_MS } from "./terminal";

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
      export function extractPtySystemInfo(output, messages) {
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
              // Skip empty lines, separators, prompts, UI noise
              if (!line || line.startsWith('────') || line === '❯' || line === '?' || line === '') continue;
              
              // Skip Claude Code UI elements
              if (line.includes('Claude Code v') || 
                  (line.includes('Opus') && line.includes('with')) || 
                  (line.includes('Sonnet') && line.includes('with')) ||
                  line.includes('API Usage') || line.includes('Billing') ||
                  line.includes('for shortcuts') || line.includes('/effort') ||
                  line.match(/^[▸▐▝▘▗▖█▌▍▎▏▔▁▂▃▄▅▆▇██]/) ||
                  line.match(/^[▸▐▝▘▗▖█▌▍▎▏▔▁▂▃▄▅▆▇██]{3,}/)) {
                continue;
              }
              
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
        // 预扫一遍全量 messages，构建 task id → subagent meta 的 map，
        // 供老消息 tool_result（没有 __subagent 盖章）按 tool_use_id 反查兜底。
        var legacyTaskMap = collectLegacyTaskIdMap(allMessages);
        // 同时刷一遍"同显示名要加后缀"的 suffix map，让 getSubagentDisplayName 拼上
        // " #1 / #2"。模块级变量在 doRenderChat 同步执行期间一致；下一轮 render 重置。
        _subagentSuffixMap = collectSubagentSuffixMap(allMessages);

        if (allMessages.length === 0) {
          if (state.lastRenderedEmpty !== "empty") {
            // 结构化空会话在提示下方提供一次三件套入口。开聊后统一从 composer /
            // 加号 popover 修改，不把“当前设置”重复伪装成每条历史消息的发送快照。
            var emptyTrioHtml = "";
            if (isStructuredSession(selectedSession)) {
              emptyTrioHtml = '<div class="empty-state-trio-wrap">' +
                '<div class="empty-state-trio-hint">默认会按以下设置发送，可点击调整：</div>' +
                renderChatModeTrioHtml(selectedSession, { kind: "dropdown" }) +
              '</div>';
            }
            renderChatEmptyState(chatOutput,
              '<div class="empty-state"><strong>对话已开始</strong><br>在下方输入框发送消息，Claude 会自动回复。</div>' +
              emptyTrioHtml
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
        var messages = visibleOffset > 0 ? allMessages.slice(visibleOffset) : allMessages;
        // 窗口化：本地还有没展开的（visibleOffset>0），或服务端还有更早的（messageOffset>0），
        // 都要保留「加载更早」哨兵。后者触底时会从服务端拉下一页。
        var hasServerOlder = (typeof selectedSession.messageOffset === "number") && selectedSession.messageOffset > 0;
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

        // Force full render if message count changed or explicitly requested
        var forceRender = forceFullRender || msgCount !== state.lastRenderedMsgCount;
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
          var systemInfo = extractPtySystemInfo(selectedSession.output, messages);

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
                  '<div class="system-info-header">ℹ️ 系统信息</div>' +
                  '<div class="system-info-content">' + escapeHtml(sysInfo.content) + '</div>' +
                '</div>' +
              '</div>';
            }

            // Render message
            html += renderChatMessage(msg, roundUsageByIndex[originalIndex] || null, originalIndex, legacyTaskMap);
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
            div.innerHTML = renderChatMessage(newMessages[i], roundUsageByIndex[nmOrigIdx] || null, nmOrigIdx, legacyTaskMap);
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
            tmpWrap.innerHTML = renderChatMessage(reversedMessages[mi], roundUsageByIndex[srOrigIdx] || null, srOrigIdx, legacyTaskMap);
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
            var newestMsgEl = chatMessages.querySelector(".chat-message");
            var allCards = chatMessages.querySelectorAll(".tool-use-card, .inline-diff[data-expand-key]");
            var newestCard = null;
            allCards.forEach(function(c) {
              var cardKey = getElementExpandKey(c);
              if (getPersistedExpandState(cardKey) !== null) return;
              // Never collapse unanswered AskUserQuestion cards
              if (c.classList.contains("ask-user") && !c.classList.contains("ask-user-answered")) return;
              if (newestMsgEl && newestMsgEl.contains(c)) {
                if (!newestCard) newestCard = c;
                else c.classList.add("collapsed");
              } else {
                c.classList.add("collapsed");
              }
            });
          }
        } else if (msgCount < existingCount) {
          fullRenderChat();
        }

        // 子 Agent 现在是固定高度角色窗口。保留这个后处理入口给未来的 live-tail
        // 跟随策略；默认不强制改 scrollTop，历史窗口打开时从任务开头读起。
        snapCollapsedSubagentPanelsToBottom(chatMessages);

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
      export var todoExpanded = false;
      // Use event delegation for todo toggle (more robust than binding to specific element)
      document.addEventListener("click", function(e) {
        var target = e.target;
        if (!target || !(target instanceof Element)) return;
        var toggle = target.closest("#todo-progress-toggle");
        if (!toggle) return;
        e.preventDefault();
        e.stopPropagation();
        todoExpanded = !todoExpanded;
        toggle.setAttribute("aria-expanded", todoExpanded ? "true" : "false");
        toggle.setAttribute("aria-label", todoExpanded ? "收起待办列表" : "展开待办列表");
        var prog = document.getElementById("todo-progress");
        var body = document.getElementById("todo-progress-body");
        if (prog && body) {
          if (todoExpanded) {
            prog.classList.add("expanded");
            body.classList.add("expanded");
          } else {
            prog.classList.remove("expanded");
            body.classList.remove("expanded");
          }
        }
        // body 展开/收起后视觉高度变了，触发一次 padding 同步
        syncChatMessagesPaddingForTodoBody();
      });

      // 同步 .chat-messages 的 padding-bottom 与 .todo-progress-body 的实际高度。
      // 背景：body 是 position: absolute 浮在 composer 上方，max-height 320px，会盖住
      // .chat-messages 底部一大块；column-reverse 下新消息永远 prepend 到 DOM 第一个
      // （也就是视觉底部），结果就是被 body 完全遮住、只在上沿露个头。给 chat-messages
      // 动态加一段等于 body 高度的 padding-bottom，最新一条消息就会浮在 body 正上方，
      // 不再渲染在 body 覆盖区。body 收起/隐藏时还原回 CSS 默认的 12px。
      function syncChatMessagesPaddingForTodoBody() {
        var chatMessages = document.querySelector("#chat-output .chat-messages");
        var todoBody = document.getElementById("todo-progress-body");
        if (!chatMessages || !todoBody) return;
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
      export function reconstructTodosFromTaskTools(messages, startIdx) {
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

      export function updateTodoProgress(messages) {
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
          // body 隐藏（无 todo）→ 还原 chat 底部 padding
          syncChatMessagesPaddingForTodoBody();
          return;
        }

        var completed = 0;
        var inProgress = 0;
        var activeTask = "";
        for (var k = 0; k < todos.length; k++) {
          if (todos[k].status === "completed") completed++;
          if (todos[k].status === "in_progress") {
            inProgress++;
            if (!activeTask) {
              activeTask = todos[k].activeForm || todos[k].content || "";
            }
          }
        }

        var allDone = completed === todos.length;

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
          // turn 结束 / 全部 done，body 不再展示 → 还原 chat 底部 padding
          syncChatMessagesPaddingForTodoBody();
          return;
        }

        container.classList.remove("hidden");
        container.classList.remove("all-done");
        if (bodyEl) bodyEl.classList.remove("hidden");

        // 计数器直接展示"已完成 / 总数"，与展开列表的 ✓ 勾选一致。
        // 旧方案用 completed+1 试图表达"正在干第 N 个"，但列表只有 completed 个
        // 勾，造成计数器和列表不匹配（如计数器 3/4、列表只 2 个 ✓）。
        var counter = document.getElementById("todo-progress-counter");
        if (counter) counter.textContent = completed + " / " + todos.length;

        // 右侧任务描述：优先取首个 in_progress 的 activeForm / content，
        // 没有任何进行中项时（首条 TodoWrite 还没来、模型漏发 activeForm），
        // 回退到下一条 pending 任务的 content——总比一片空白强。
        var task = document.getElementById("todo-progress-task");
        if (task) {
          if (!activeTask) {
            for (var p = 0; p < todos.length; p++) {
              if (todos[p].status === "pending" && (todos[p].activeForm || todos[p].content)) {
                activeTask = todos[p].activeForm || todos[p].content;
                break;
              }
            }
          }
          task.textContent = activeTask || "准备中…";
        }

        var ratio = todos.length > 0 ? completed / todos.length : 0;
        var ring = document.getElementById("todo-progress-ring");
        if (ring) {
          ring.style.setProperty("--progress", ratio.toFixed(3));
        }
        // 同步把整条横条的进度填充（从左到右生长）也设上同一比例，
        // 避免额外算一遍 completed/todos.length。
        var fill = document.getElementById("todo-progress-fill");
        if (fill) {
          fill.style.setProperty("--progress", ratio.toFixed(3));
        }

        // Render expanded list
        var list = document.getElementById("todo-progress-list");
        if (list) {
          var html = "";
          for (var m = 0; m < todos.length; m++) {
            var t = todos[m];
            var st = t.status || "pending";
            var itemClass = st === "in_progress" ? "active" : st === "completed" ? "done" : "";
            var iconClass = st === "in_progress" ? "active" : st === "completed" ? "done" : "pending";
            var icon = st === "completed" ? "✓" : st === "in_progress" ? "›" : "○";
            html += '<li class="todo-progress-item ' + itemClass + '">' +
              '<span class="todo-item-icon ' + iconClass + '">' + icon + '</span>' +
              '<span>' + escapeHtml(t.content || "") + '</span>' +
            '</li>';
          }
          list.innerHTML = html;
        }

        // Sync todo progress to native notification
        if (state.selectedId) {
          syncSessionProgressToNative(state.selectedId);
        }
        // 列表条数/状态变了（item 高度变化），同步一次 chat 底部 padding
        syncChatMessagesPaddingForTodoBody();
      }

      export function attachCopyHandler(el) {
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

      export function attachAllCopyHandlers(container) {
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

      // ===== Mobile message copy (long-press or tap copy button) =====
      export var _msgCopyState = { timer: null, activeBtn: null };

      export function attachMessageCopyButtons(container) {
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
              }, 1500);
            });
          });
          msgEl.appendChild(btn);
        });
      }

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
            if (btn) {
              // Hide any other visible copy buttons
              document.querySelectorAll(".msg-copy-btn.visible").forEach(function(b) {
                b.classList.remove("visible");
              });
              btn.classList.add("visible");
            }
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
          if (!(e.target as HTMLElement).closest(".msg-copy-btn")) {
            document.querySelectorAll(".msg-copy-btn.visible").forEach(function(b) {
              b.classList.remove("visible");
            });
          }
        });
      })();

      // ===== Terminal copy button for mobile =====

      export function isNoiseLine(line) {
        if (!line) return false;
        var trimmed = String(line).trim();
        if (!trimmed) return false;
        if (trimmed.indexOf("────") === 0) return true;
        if (trimmed === "❯" || trimmed === "›") return true;
        if (/^[╭╰│┌└┐┘├┤┬┴┼─═]{2,}$/.test(trimmed)) return true;
        if (/^[▁▂▃▄▅▆▇█▔▕▏▐]+$/.test(trimmed)) return true;
        if (trimmed.indexOf("esc to interrupt") !== -1) return true;
        if (trimmed.indexOf("Claude Code v") !== -1) return true;
        if (/^Sonnet\b/.test(trimmed)) return true;
        if (trimmed.indexOf("Failed to install Anthropic") !== -1) return true;
        if (trimmed.indexOf("Claude Code has switched") !== -1) return true;
        if (trimmed.indexOf("? for shortcuts") !== -1) return true;
        if (trimmed.indexOf("Claude is waiting") !== -1) return true;
        if (trimmed.indexOf("[wand]") !== -1) return true;
        if (trimmed.indexOf("0;") === 0 || trimmed.indexOf("9;") === 0) return true;
        if (trimmed.indexOf("ctrl+g") !== -1) return true;
        if (trimmed.indexOf("/effort") !== -1) return true;
        if (/^Using .* for .* session/.test(trimmed)) return true;
        if (trimmed.indexOf("Press ") === 0 && trimmed.indexOf(" for") !== -1) return true;
        if (trimmed.indexOf("type ") === 0 && trimmed.indexOf(" to ") !== -1) return true;
        if (trimmed.indexOf("auto mode is unavailable") !== -1) return true;
        if (/MCP server.*failed/i.test(trimmed)) return true;
        if (trimmed.indexOf("Germinating") !== -1 || trimmed.indexOf("Doodling") !== -1 || trimmed.indexOf("Brewing") !== -1) return true;
        if (trimmed.indexOf("Permissions") !== -1 && trimmed.indexOf("mode") !== -1) return true;
        if (trimmed.indexOf("●") === 0 && trimmed.indexOf("·") !== -1) return true;
        if (trimmed.indexOf("[>") === 0 || trimmed.indexOf("[<") === 0) return true;
        if (trimmed.indexOf("Captured Claude session ID") !== -1) return true;
        if (/^>_\s*OpenAI Codex\b/.test(trimmed)) return true;
        if (/^OpenAI Codex\b/i.test(trimmed)) return true;
        if (/^(model|directory):\s+/i.test(trimmed)) return true;
        if (/^(tip|context):\s+/i.test(trimmed)) return true;
        if (/^work(tree|space):\s+/i.test(trimmed)) return true;
        if (/^(approvals?|sandbox|provider|session id):\s+/i.test(trimmed)) return true;
        if (/^(thinking|working)(\.\.\.|…)?$/i.test(trimmed)) return true;
        if (/^[•◦·]\s+Working\b/i.test(trimmed)) return true;
        if (/^[•◦·]\s+(Running|Planning|Applying|Reading|Searching)\b/i.test(trimmed)) return true;
        if (/^[•◦·]\s+(Inspecting|Reviewing|Summarizing|Editing|Updating|Writing)\b/i.test(trimmed)) return true;
        if (/^[•◦·]\s+Completed\b/i.test(trimmed)) return true;
        if (/^(ctrl|enter|tab|shift|esc|alt)\+/i.test(trimmed)) return true;
        if (/\b(open|close|toggle) (chat|terminal)\b/i.test(trimmed)) return true;
        if (/\b(approve|deny)\b.*\b(permission|approval)\b/i.test(trimmed)) return true;
        if (/^(use|press) .* (to|for) .*/i.test(trimmed)) return true;
        if (/^(?:token|context window|remaining context|conversation):\s+/i.test(trimmed)) return true;
        if (/^(?:cwd|path):\s+\//i.test(trimmed)) return true;
        if (/^[<>│┆╎].*[<>│┆╎]$/.test(trimmed) && trimmed.length < 8) return true;
        return false;
      }

      export function stripAnsi(text) {
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
          var codexFooterRe = /\bgpt-\d+(?:\.\d+)?(?:\s+[a-z0-9.-]+)?\s+·\s+\d+%\s+left\s+·\s+(?:\/|~\/).+/i;
          var codexActivityRe = /^(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i;

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

          function shouldIgnoreCodexLine(line) {
            var trimmed = String(line || "").trim();
            if (!trimmed) return true;
            if (isNoiseLine(trimmed)) return true;
            if (codexFooterRe.test(trimmed)) return true;
            if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return true;
            if (/^\[>[0-9;?]*u$/i.test(trimmed)) return true;
            if (/^M+$/i.test(trimmed)) return true;
            if (/^(?:OpenAI Codex|Codex)\b/i.test(trimmed)) return true;
            if (/^(?:tokens?|context window|remaining context|approvals?|sandbox|provider|session id):\s*/i.test(trimmed)) return true;
            if (/^(?:thinking|working)\s*(?:\.\.\.|…)?$/i.test(trimmed)) return true;
            if (/^[•◦·]\s+(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i.test(trimmed)) return true;
            if (/^(?:model|directory|tip|context|cwd|path):\s+/i.test(trimmed)) return true;
            return false;
          }

          function extractCodexPromptCandidate(line) {
            var trimmed = String(line || "").trim();
            if (!/^›(?:\s|$)/.test(trimmed)) return null;
            if (codexFooterRe.test(trimmed)) return null;
            var prompt = normalizeCodexText(normalizeCodexPromptLine(trimmed));
            if (!prompt || shouldIgnoreCodexLine(prompt)) return null;
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

            if (!assistant || assistant.length < 2 || codexActivityRe.test(assistant) || shouldIgnoreCodexLine(assistant)) {
              return null;
            }
            return assistant;
          }

          function extractCodexEchoCandidate(line) {
            var trimmed = normalizeCodexText(line);
            if (!trimmed || shouldIgnoreCodexLine(trimmed)) return null;
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
              if (!normalized || normalized.length < 2 || shouldIgnoreCodexLine(normalized)) continue;

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
                  if (!nextLine || codexFooterRe.test(nextLine) || shouldIgnoreCodexLine(nextLine)) continue;
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
                if (line === "›" || /^›(?:\s|$)/.test(line) || codexFooterRe.test(line) || shouldIgnoreCodexLine(line)) {
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
        var lastThinkingLine = null;
        var userCmdIndex = -1;

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

          // Filter noise
          if (!line) continue;
          if (line.indexOf("────────────────") === 0) continue;
          if (line === "❯") continue;
          if (line.indexOf("esc to interrupt") !== -1) continue;
          if (line.indexOf("Claude Code v") !== -1) continue;
          if (line.indexOf("Sonnet") !== -1) continue;
          if (line.indexOf("~/") === 0) continue;
          if (line.indexOf("● high") !== -1) continue;
          if (line.indexOf("Failed to install Anthropic marketplace") !== -1) continue;
          if (line.indexOf("Claude Code has switched from npm to native installer") !== -1) continue;
          if (line.indexOf("Fluttering") !== -1) continue;
          if (line.indexOf("? for shortcuts") !== -1) continue;
          if (line.indexOf("0;") === 0) continue;
          if (line.indexOf("9;") === 0) continue;
          if (line.indexOf("Claude is waiting") !== -1) continue;
          if (line.indexOf("✢") !== -1 || line.indexOf("✳") !== -1 || line.indexOf("✶") !== -1 || line.indexOf("✻") !== -1 || line.indexOf("✽") !== -1) continue;
          if (line.indexOf("▐") === 0 || line.indexOf("▝") === 0 || line.indexOf("▘") === 0) continue;
          if ((line === "lu" || line === "ue" || line === "tr" || line === "ti" || line === "g" || line === "n" || line === "i…" || line === "…" || line === "uts" || line === "lt" || line === "rg" || line === "·") && line.length < 4) continue;
          if (line.indexOf("✽F") === 0 || line.indexOf("✻F") === 0) continue;
          // Additional noise filters
          if (line.indexOf("npm WARN") !== -1) continue;
          if (line.indexOf("npm notice") !== -1) continue;
          if (line.indexOf("added ") !== -1 && line.indexOf(" packages") !== -1) continue;
          if (line.indexOf("audited ") !== -1) continue;
          if (line.indexOf("found ") !== -1 && line.indexOf(" vulnerabilities") !== -1) continue;
          if (line.indexOf("Using ") !== -1 && line.indexOf(" for ") !== -1 && line.indexOf("session") !== -1) continue;
          if (line.indexOf("You can use") !== -1) continue;
          if (line.indexOf("Press ") !== -1 && line.indexOf(" for") !== -1) continue;
          if (line.indexOf("type ") === 0 && line.indexOf(" to ") !== -1) continue;
          if (line.indexOf("[wand]") === 0) continue;
          if (line.indexOf("Captured Claude session ID") !== -1) continue;
          // Filter Claude TUI noise patterns
          if (line.indexOf("⏵") !== -1) continue;
          if (line.indexOf("acceptedit") !== -1) continue;
          if (line.indexOf("shift+tab") !== -1) continue;
          if (line.indexOf("tabtocycle") !== -1) continue;
          if (line.indexOf("ctrl+g") !== -1) continue;
          if (line.indexOf("/effort") !== -1) continue;
          if (line.indexOf("Opus") !== -1 && line.indexOf("model") !== -1) continue;
          if (line.indexOf("Haiku") !== -1) continue;
          if (line.indexOf("to cycle") !== -1) continue;
          if (line.indexOf("high ·") !== -1 || line.indexOf("high·") !== -1) continue;
          if (line.indexOf("medium ·") !== -1 || line.indexOf("medium·") !== -1) continue;
          if (line.indexOf("low ·") !== -1 || line.indexOf("low·") !== -1) continue;
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
      export var _AVATAR_T = "transparent";
      export function buildPixelSvg(grid, size?) {
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
      export function buildCatGrid(palette) {
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
      export var GARFIELD_PALETTE = {
        base: "#F0923A", dark: "#C46A1A", light: "#F0923A",
        accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#F28B9A", nose: "#E87D5A",
      };
      export var SHORTHAIR_PALETTE = {
        base: "#9EAAB8", dark: "#6B7B8D", light: "#C5CED8",
        accent: "#FFFFFF", eye: "#7EC88B", mouth: "#F28B9A",
      };
      // 子 agent palette 池。色相与父/用户都拉开距离，避免群聊里多只猫颜色相近难辨认。
      // primary 用来暴露成 CSS 变量 --agent-color，给气泡左边框 / handoff 文字着色。
      export var SUBAGENT_PALETTES = [
        { base: "#5A8FE0", dark: "#2E5BB3", light: "#9CC0F2", accent: "#FFFFFF", eye: "#FFD66E", mouth: "#F28B9A", primary: "#5A8FE0" }, // 蓝猫
        { base: "#A06FE0", dark: "#6B45A8", light: "#C8A4F2", accent: "#FFFFFF", eye: "#FFE36E", mouth: "#F28B9A", primary: "#A06FE0" }, // 紫猫
        { base: "#7BB76B", dark: "#4F8A40", light: "#A9D49C", accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#F28B9A", primary: "#7BB76B" }, // 抹茶猫
        { base: "#D86A88", dark: "#9C3A57", light: "#E8A4B5", accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#FFFFFF", primary: "#D86A88" }, // 樱花猫
        { base: "#5BB7B0", dark: "#2E7873", light: "#9CD6D2", accent: "#FFFFFF", eye: "#FFD66E", mouth: "#F28B9A", primary: "#5BB7B0" }, // 青苔猫
        { base: "#4A4A60", dark: "#1F1F2E", light: "#6E6E84", accent: "#F5F5F5", eye: "#FFD66E", mouth: "#F28B9A", primary: "#4A4A60" }, // 黑猫
        { base: "#D8A85A", dark: "#9C7028", light: "#EBC78A", accent: "#FFFFFF", eye: "#2D2D2D", mouth: "#F28B9A", primary: "#D8A85A" }, // 焦糖猫
      ];
      export function hashStringToIndex(str, mod) {
        var s = String(str || "");
        var h = 0;
        for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return Math.abs(h) % mod;
      }
      // agentType → 中文名映射。命中映射就用映射名，否则用 agentType 原文；
      // 都没有则退化为 "协作猫·<taskId 后 4 位>"。
      export var SUBAGENT_NAME_MAP = {
        "general-purpose": "万能猫",
        "Explore": "侦探猫",
        "code-explorer": "侦探猫",
        "code-reviewer": "审查猫",
        "code-architect": "架构猫",
        "code-simplifier": "简化猫",
        "code-guide": "向导猫",
        "Plan": "策划猫",
        "feature-dev": "开发猫",
        "pr-test-analyzer": "测试猫",
        "silent-failure-hunter": "护卫猫",
        "type-design-analyzer": "类型猫",
        "comment-analyzer": "注释猫",
      };
      // 同一轮对话里如果起了多个同类型 subagent（比如两只"万能猫"），光看名字会
      // 撞车。doRenderChat 在每次 render 前预扫一遍 messages，把"同显示名 ≥ 2"
      // 的 taskId 各自分配一个 "#1 / #2 / ..." 后缀，按首次出现顺序稳定。
      // 单实例不加后缀，避免视觉噪音。
      export var _subagentSuffixMap = null;
      export function getSubagentBaseName(sub) {
        if (!sub) return "";
        var agentType = sub.agentType || "";
        if (agentType && SUBAGENT_NAME_MAP[agentType]) return SUBAGENT_NAME_MAP[agentType];
        if (agentType) return agentType;
        return getActiveLang() === "English" ? "Subtask" : "子任务";
      }
      export function catPrefixedSubagentName(name) {
        var text = String(name || "").trim();
        if (!text) return "猫猫子 Agent";
        return text.indexOf("猫猫") === 0 ? text : "猫猫 " + text;
      }
      export function getSubagentDisplayName(sub) {
        var base = getSubagentBaseName(sub);
        if (!base) return base;
        var suffix = (_subagentSuffixMap && sub && sub.taskId) ? _subagentSuffixMap.get(sub.taskId) : null;
        return catPrefixedSubagentName(suffix ? base + suffix : base);
      }
      export function getSubagentPalette(sub) {
        // 哈希优先用 agentType，让同类型 agent 跨 turn 颜色稳定；没有 agentType 时
        // 退化用 taskId，至少同 turn 内同一只猫颜色稳定。
        var seed = (sub && (sub.agentType || sub.taskId)) || "subagent";
        return SUBAGENT_PALETTES[hashStringToIndex(seed, SUBAGENT_PALETTES.length)];
      }
      export function subagentAvatarHtml(sub) {
        var palette = getSubagentPalette(sub);
        var name = getSubagentDisplayName(sub);
        var svg = buildPixelSvg(buildCatGrid(palette));
        return '<div class="chat-message-avatar assistant subagent" style="--agent-color:' + palette.primary + '">' +
          '<div class="pixel-avatar">' + svg + '</div>' +
          '<span class="avatar-name">' + escapeHtml(name) + '</span>' +
        '</div>';
      }

      // subagent 最终回复（父 Task 的 tool_result）——现在外层 .subagent-panel 已经
      // 负责整段折叠 / 滚动，这里只需把"任务完成 / 失败"做个轻量标记块，markdown
      // 内容平铺，让 panel 的 body 滚动条统一接管。
      export function renderSubagentReplyBubble(block, role) {
        if (!block || block.type !== "tool_result") return "";
        var text = extractToolResultText(block.content);
        var isError = block.is_error === true;
        var rawText = typeof text === "string" ? text : (text == null ? "" : String(text));

        // pending：subagent 还在跑，没收到结果。在 panel body 里画一个 typing 指示器
        // 占位，告诉用户"还在跑"。
        if (!isError && !rawText.trim()) {
          return '<div class="subagent-reply pending">' +
            '<span class="subagent-reply-marker pending">' + escapeHtml(t("subagent.running")) + '</span>' +
            '<span class="typing-indicator"><span></span><span></span><span></span></span>' +
          '</div>';
        }

        var displayText = rawText.trim() ? rawText : t("subagent.no_output");
        var bodyHtml = rawText.trim() ? renderMarkdown(displayText) : escapeHtml(displayText);
        var markerLabel = isError ? t("subagent.task.failed") : t("subagent.task.done");
        var markerSymbol = isError ? "✗" : "✓";

        return '<div class="subagent-reply final' + (isError ? ' error' : '') + '">' +
          '<div class="subagent-reply-marker ' + (isError ? 'error' : 'done') + '">' +
            '<span class="subagent-reply-marker-icon" aria-hidden="true">' + markerSymbol + '</span>' +
            '<span class="subagent-reply-marker-label">' + escapeHtml(markerLabel) + '</span>' +
          '</div>' +
          '<div class="subagent-reply-content">' + bodyHtml + '</div>' +
        '</div>';
      }
      export var PIXEL_AVATAR = {
        assistant: buildPixelSvg(buildCatGrid(GARFIELD_PALETTE)),
        user: buildPixelSvg(buildCatGrid(SHORTHAIR_PALETTE)),
      };

      export var DEFAULT_CHAT_PERSONA = {
        user: {
          name: "赛博虎妞",
          avatarSvg: PIXEL_AVATAR.user
        },
        assistant: {
          name: "勤劳初二",
          avatarSvg: PIXEL_AVATAR.assistant
        }
      };

      export function getStructuredChatPersona(role) {
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

      export function renderAvatarFallback(svg) {
        return '<div class="pixel-avatar">' + svg + '</div>';
      }

      export function handleChatAvatarImageError(img, role) {
        if (!img || !img.parentNode) return;
        var persona = getStructuredChatPersona(role === "user" ? "user" : "assistant");
        img.outerHTML = renderAvatarFallback(persona.avatarSvg);
      }

      export function chatAvatar(role) {
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

      export function renderChatMessage(msg, roundUsage, messageIndex, legacyTaskMap) {
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
              '<span class="thinking-inline-icon">⦿</span>' +
              '<span class="thinking-inline-preview">' + escapeHtml(ptyThinkingText) + '</span>' +
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
          return renderStructuredMessage(msg, roundUsage, messageIndex, legacyTaskMap);
        }

        // Legacy string content (from PTY parsing)
        var avatar = chatAvatar(msg.role);
        var bubbleContent = msg.role === "assistant"
          ? renderMarkdown(msg.content)
          : (msg.role === "user" ? renderUserText(msg.content) : escapeHtml(msg.content));
        return '<div class="chat-message ' + msg.role + '">' +
          avatar +
          '<div class="chat-message-bubble">' + bubbleContent + '</div>' +
        '</div>';
      }

      export function buildToolResultMap(contentBlocks) {
        var toolResults = {};
        if (!Array.isArray(contentBlocks)) return toolResults;
        for (var i = 0; i < contentBlocks.length; i++) {
          var block = contentBlocks[i];
          if (block && block.type === "tool_result") {
            var toolUseId = block.tool_use_id;
            if (!toolUseId) continue;
            if (!toolResults[toolUseId]) {
              toolResults[toolUseId] = [];
            }
            toolResults[toolUseId].push(block);
          }
        }
        return toolResults;
      }

      export function pickToolResultForDisplay(toolResults, toolUseId) {
        var entries = toolResults && toolUseId ? toolResults[toolUseId] : null;
        if (!entries || !entries.length) return null;
        for (var i = 0; i < entries.length - 1; i++) {
          if (isRecoverableToolError(entries[i], entries[i + 1])) {
            return entries[i + 1];
          }
        }
        return entries[entries.length - 1];
      }

      export function hasRecoveredToolNoise(toolResults, toolUseId) {
        var entries = toolResults && toolUseId ? toolResults[toolUseId] : null;
        if (!entries || entries.length < 2) return false;
        for (var i = 0; i < entries.length - 1; i++) {
          if (isRecoverableToolError(entries[i], entries[i + 1])) {
            return true;
          }
        }
        return false;
      }

      export function renderRecoveredToolHint(toolName) {
        return '<div class="structured-tool-hint">已自动恢复一次 ' + escapeHtml(getToolDisplayName(toolName)) + ' 参数问题</div>';
      }

      // ── 连续同类工具调用分组 ──
      // 注意：禁止把 Task/Agent 加入 GROUPABLE_TOOLS——它们由 renderContentBlock 入口屏蔽返空，
      // 加入分组会导致空 group 包裹一堆空字符串，留下视觉空盒子。
      export var GROUPABLE_TOOLS = { Read: 1, Glob: 1, Grep: 1, WebFetch: 1, WebSearch: 1, TodoRead: 1 };

      // 图片相关的操作不并入 tool-group：并到默认折叠的 group 里，body 整体
      // display:none 会把内联缩略图一起藏掉。单独成卡时缩略图常驻可见，符合
      // “对话里的图片操作默认直接显示、不折叠”。
      export function isGroupableToolBlock(block) {
        if (!block || block.type !== "tool_use" || !GROUPABLE_TOOLS[block.name]) return false;
        if (block.name === "Read") {
          var input = block.input || {};
          if (isImagePath(input.file_path || input.path || "")) return false;
        }
        return true;
      }

      export function groupConsecutiveTools(content) {
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

      export var TOOL_GROUP_LABELS = { Read: "读取", Glob: "搜索", Grep: "搜索", WebFetch: "抓取", WebSearch: "搜索", TodoRead: "待办" };

      export function renderToolGroup(items, role, toolResults, messageKey, options?: any) {
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
        var statusIcon = !allDone ? "…" : (anyError ? "✗" : "✓");
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

      // ── 历史折叠 ──
      // 发新消息后，把"最后一条用户消息"之前的历史折叠成一张摘要卡，展示被折叠区间
      // 里的轮次 / 工具调用 / 子代理 / 失败数量，点一下展开。做成 render 之后的「后处理」
      // 而非改 fullRenderChat 的拼串逻辑——后者那套 column-reverse + 增量/流式 DOM diff
      // 很脆弱。摘要卡不是 .chat-message，现有 querySelectorAll(".chat-message:not(.system-info)")
      // 天然忽略它，计数 / 锚点 / 流式替换都不受影响。
      export function computeHistoryStats(allMessages, historyIndices) {
        var rounds = 0, tools = 0, errors = 0;
        var agentIds = {};
        for (var i = 0; i < historyIndices.length; i++) {
          var msg = allMessages[historyIndices[i]];
          if (!msg) continue;
          if (msg.role === "user") rounds++;
          var content = msg.content;
          if (!Array.isArray(content)) continue;
          for (var j = 0; j < content.length; j++) {
            var block = content[j];
            if (!block) continue;
            if (block.__subagent && block.__subagent.taskId) agentIds[block.__subagent.taskId] = 1;
            if (block.type === "tool_use") {
              tools++;
              var legacy = deriveLegacySubagent(block);
              if (legacy && legacy.taskId) agentIds[legacy.taskId] = 1;
            } else if (block.type === "tool_result" && block.is_error) {
              errors++;
            }
          }
        }
        var agents = 0;
        for (var k in agentIds) { if (Object.prototype.hasOwnProperty.call(agentIds, k)) agents++; }
        return { rounds: rounds, tools: tools, agents: agents, errors: errors };
      }

      export function buildHistorySummaryMetaText(stats) {
        var parts = [];
        parts.push(t("history.rounds", { n: String(stats.rounds) }));
        if (stats.tools > 0) parts.push(t("history.tools", { n: String(stats.tools) }));
        if (stats.agents > 0) parts.push(t("history.agents", { n: String(stats.agents) }));
        if (stats.errors > 0) parts.push(t("history.errors", { n: String(stats.errors) }));
        return parts.join(" · ");
      }

      // 折叠态：隐藏摘要卡之后的所有兄弟（DOM 顺序 newest→oldest，摘要卡之后 = 历史区），
      // 但保留「加载更早」哨兵可见。
      export function applyHistoryHiddenState(summaryEl, expanded) {
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
      export function applyAutoFoldBar(chatOutput, chatMessages, allMessages, renderIsInitial) {
        void allMessages;
        void renderIsInitial;
        if (!chatOutput || !chatMessages) return;
        setAutoFoldMode(chatOutput, chatMessages, false);
        clearAutoFoldHistoryHidden(chatMessages);
        clearAutoFoldBar(chatOutput);
      }

      function ensureFoldBar(chatOutput) {
        var bar = chatOutput.querySelector("#chat-fold-bar");
        if (bar) return bar;
        bar = document.createElement("div");
        bar.id = "chat-fold-bar";
        bar.className = "chat-fold-bar hidden";
        // 插到 chatOutput 的最前面（在 chat-unread-bubble 之前）
        chatOutput.insertBefore(bar, chatOutput.firstChild);
        return bar;
      }

      function setAutoFoldMode(chatOutput, chatMessages, enabled) {
        if (!chatOutput) return;
        chatOutput.classList.toggle("auto-fold", !!enabled);
      }

      function getHistoryIndicesBefore(msgs, boundaryIdx) {
        var indices = [];
        for (var i = 0; i < boundaryIdx; i++) {
          if (msgs[i]) indices.push(i);
        }
        return indices;
      }

      function clearAutoFoldHistoryHidden(chatMessages) {
        if (!chatMessages) return;
        var hidden = chatMessages.querySelectorAll(".chat-auto-fold-hidden");
        for (var i = 0; i < hidden.length; i++) hidden[i].classList.remove("chat-auto-fold-hidden");
      }

      function setAutoFoldHistoryHidden(chatMessages, boundaryIdx, enabled) {
        clearAutoFoldHistoryHidden(chatMessages);
        if (!enabled || boundaryIdx < 1) return;
        var nodes = chatMessages.querySelectorAll(".chat-message:not(.system-info)");
        for (var i = 0; i < nodes.length; i++) {
          var idxAttr = nodes[i].getAttribute("data-msg-index");
          if (idxAttr == null) continue;
          var idx = parseInt(idxAttr, 10);
          if (!isNaN(idx) && idx < boundaryIdx) nodes[i].classList.add("chat-auto-fold-hidden");
        }
        collapseHistorySummaryForAutoFold(chatMessages);
      }

      function collapseHistorySummaryForAutoFold(chatMessages) {
        var summary = chatMessages ? chatMessages.querySelector(".chat-history-summary") : null;
        if (!summary) return;
        summary.setAttribute("data-expanded", "false");
        var btn = summary.querySelector(".chat-history-summary-btn");
        if (btn) btn.setAttribute("aria-expanded", "false");
        var title = summary.querySelector(".chat-history-summary-title");
        if (title) title.textContent = t("history.expand");
        applyHistoryHiddenState(summary, false);
        summary.classList.add("chat-auto-fold-hidden");
        var sig = chatMessages.getAttribute("data-history-sig");
        if (sig) {
          var segs = sig.split(":");
          if (segs.length >= 3) {
            segs[2] = "0";
            chatMessages.setAttribute("data-history-sig", segs.join(":"));
          }
        }
      }

      function followAutoFoldLatest(chatMessages) {
        if (!chatMessages || !chatMessages.isConnected) return;
        clearChatUnread({ removeDivider: true });
        scrollChatToBottom(true);
      }

      function clearAutoFoldBar(chatOutput) {
        if (!chatOutput) return;
        var bar = chatOutput.querySelector("#chat-fold-bar");
        if (!bar) return;
        bar.innerHTML = "";
        bar.classList.add("hidden");
        state.chatAutoFoldSnapshot = null;
      }

      function buildAutoFoldBarHtml(userMsg, assistantMsg, historyStats) {
        var userPreview = getMessagePreviewText(userMsg) || "新消息";
        var assistantPreview = assistantMsg ? getMessagePreviewText(assistantMsg) : "等待回复...";
        var historyHtml = "";
        if (historyStats) {
          historyHtml = '<button type="button" class="chat-fold-row history" onclick="window.__chatFoldToggleHistory && window.__chatFoldToggleHistory()" title="展开或收起更早对话">' +
              '<span class="chat-fold-role">历史</span>' +
              '<span class="chat-fold-text">已收起 ' + escapeHtml(buildHistorySummaryMetaText(historyStats)) + '</span>' +
            '</button>';
        }
        return historyHtml +
          '<button type="button" class="chat-fold-row user" onclick="window.__chatFoldJumpToLatest && window.__chatFoldJumpToLatest()" title="定位到最新消息">' +
            '<span class="chat-fold-role">我</span>' +
            '<span class="chat-fold-text">' + escapeHtml(userPreview) + '</span>' +
          '</button>' +
          '<button type="button" class="chat-fold-row assistant" onclick="window.__chatFoldJumpToLatest && window.__chatFoldJumpToLatest()" title="定位到最新回复">' +
            '<span class="chat-fold-role">Claude</span>' +
            '<span class="chat-fold-text">' + escapeHtml(assistantPreview) + '</span>' +
          '</button>';
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

      (window as any).__chatFoldJumpToLatest = function() {
        var chatMessages = document.querySelector("#chat-output .chat-messages");
        if (chatMessages) followAutoFoldLatest(chatMessages);
      };

      (window as any).__chatFoldToggleHistory = function() {
        var summary = document.querySelector("#chat-output .chat-history-summary");
        var btn = summary ? summary.querySelector(".chat-history-summary-btn") : null;
        if (summary) summary.classList.remove("chat-auto-fold-hidden");
        if (btn && (window as any).__historySummaryToggle) {
          (window as any).__historySummaryToggle(btn);
        }
      };

      function collectHistoryCollapseState(chatMessages, msgEls, lastUserIdx, measureLatestTurn) {
        var stateForCollapse = {
          shouldCollapseForViewport: false,
          historyIndices: [],
          firstHistoryEl: null,
        };
        if (!chatMessages || lastUserIdx < 0) return stateForCollapse;
        var viewportHeight = measureLatestTurn
          ? (chatMessages.clientHeight || chatMessages.getBoundingClientRect().height || 0)
          : 0;
        var firstLatestTurnEl = null;
        var lastLatestTurnEl = null;
        for (var i = 0; i < msgEls.length; i++) {
          var idxAttr = msgEls[i].getAttribute("data-msg-index");
          if (idxAttr == null) continue;
          var idx = parseInt(idxAttr, 10);
          if (isNaN(idx)) continue;
          if (idx < lastUserIdx) {
            stateForCollapse.historyIndices.push(idx);
            // DOM 顺序 newest→oldest：第一个命中的就是 DOM 里最靠前的历史元素。
            if (!stateForCollapse.firstHistoryEl) stateForCollapse.firstHistoryEl = msgEls[i];
          } else if (measureLatestTurn) {
            if (!firstLatestTurnEl) firstLatestTurnEl = msgEls[i];
            lastLatestTurnEl = msgEls[i];
          }
        }
        if (measureLatestTurn && viewportHeight > 0 && firstLatestTurnEl && lastLatestTurnEl) {
          var firstRect = firstLatestTurnEl.getBoundingClientRect();
          var lastRect = lastLatestTurnEl.getBoundingClientRect();
          var latestTurnHeight = Math.max(firstRect.bottom, lastRect.bottom) - Math.min(firstRect.top, lastRect.top);
          // Codex / 结构化流默认先展示完整上下文；只有最新一轮自己接近占满
          // 聊天视口时，才把更早历史收到摘要里，让正在生成的长回复向上锁住。
          var collapseThreshold = Math.max(220, viewportHeight - 24);
          stateForCollapse.shouldCollapseForViewport = latestTurnHeight >= collapseThreshold;
        }
        return stateForCollapse;
      }

      export function applyHistoryCollapse(chatMessages, selectedSession) {
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
          var expanded = persisted === null ? !historical : persisted;
          var disclosure = el.querySelector(":scope > .assistant-reply-disclosure");
          if (!disclosure) {
            disclosure = document.createElement("button");
            disclosure.className = "assistant-reply-disclosure";
            disclosure.setAttribute("type", "button");
            el.insertBefore(disclosure, el.firstChild);
          }
          disclosure.setAttribute("data-expand-key", key);
          disclosure.setAttribute("aria-expanded", expanded ? "true" : "false");
          disclosure.innerHTML =
            '<span class="assistant-reply-label">回复</span>' +
            '<span class="assistant-reply-preview">' + escapeHtml(getMessagePreviewText(allMessages[idx]) || "助手回复") + '</span>' +
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

      // 老消息（SQLite 历史 turn）后端还没盖章。前端给 name === "Task"/"Agent"
      // 或 input.subagent_type 非空的 tool_use 虚拟盖章，让现有 multi-agent 渲染路径吃到。
      export function deriveLegacySubagent(block) {
        if (!block || block.type !== "tool_use") return null;
        var input = block.input || {};
        var agentType = typeof input.subagent_type === "string" ? input.subagent_type : null;
        if (!agentType && block.name !== "Task" && block.name !== "Agent") return null;
        return {
          taskId: block.id,
          agentType: agentType || undefined,
          taskDescription: typeof input.description === "string" ? input.description : undefined,
        };
      }

      // tool_result 老消息靠 tool_use_id 关联 task。由外层预扫一遍 messages，构建 task id → meta 的 map。
      export function collectLegacyTaskIdMap(allMessages) {
        var map = new Map();
        if (!Array.isArray(allMessages)) return map;
        for (var i = 0; i < allMessages.length; i++) {
          var m = allMessages[i];
          if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
          for (var j = 0; j < m.content.length; j++) {
            var b = m.content[j];
            if (!b || b.type !== "tool_use") continue;
            var derived = b.__subagent || deriveLegacySubagent(b);
            if (derived) map.set(b.id, derived);
          }
        }
        return map;
      }

      // 预扫一遍 messages，把"同显示名 ≥ 2 个 taskId"的 subagent 各自分配一个
      // " #1 / #2 / ..." 后缀（按首次出现顺序）。返回 taskId → suffix 字符串的 map。
      // bucket key 走 getSubagentBaseName(sub)：不同 agentType 但相同中文名（比如
      // "Explore" 和 "code-explorer" 都映射 "侦探猫"）也算冲突，得分别加后缀。
      // 单实例不进 map，调用方就不会拼后缀。
      export function collectSubagentSuffixMap(allMessages) {
        var suffix = new Map();
        if (!Array.isArray(allMessages)) return suffix;
        var bucketsByName = new Map(); // displayName -> ordered list of unique taskIds
        var seenTaskIds = new Set();
        function record(sub) {
          if (!sub || !sub.taskId) return;
          if (seenTaskIds.has(sub.taskId)) return;
          seenTaskIds.add(sub.taskId);
          var name = getSubagentBaseName(sub);
          if (!name) return;
          if (!bucketsByName.has(name)) bucketsByName.set(name, []);
          bucketsByName.get(name).push(sub.taskId);
        }
        for (var i = 0; i < allMessages.length; i++) {
          var m = allMessages[i];
          if (!m || !Array.isArray(m.content)) continue;
          for (var j = 0; j < m.content.length; j++) {
            var b = m.content[j];
            if (!b) continue;
            var sub = b.__subagent || (b.type === "tool_use" ? deriveLegacySubagent(b) : null);
            if (sub) record(sub);
          }
        }
        bucketsByName.forEach(function(taskIds) {
          if (taskIds.length < 2) return;
          for (var k = 0; k < taskIds.length; k++) {
            suffix.set(taskIds[k], " #" + (k + 1));
          }
        });
        return suffix;
      }

      // 把一条 assistant turn 按相邻 block 的 __subagent.taskId 切成段。
      // 输出每段附带原数组中的 firstIndex，方便渲染时 expand key 用全局 index
      // 避免不同段冲突。
      // legacyTaskMap：老消息没有 __subagent 盖章时，按 tool_use_id 反查兜底。
      export function splitTurnBySubagent(blocks, legacyTaskMap) {
        var segs = [];
        if (!Array.isArray(blocks) || !blocks.length) return segs;
        var current = null;
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          // __processing 占位 block（流式中的 typing indicator）没有 __subagent 盖章，
          // 强制延续上一段（若已有），避免"父-Task-占位-子内容"反复切段导致 DOM 抖动。
          // 边界：若占位是第一个 block（current 仍为 null），走正常路径开 parent 段。
          var isPlaceholder = b && b.type === "text" && b.__processing === true;
          if (isPlaceholder && current) {
            current.blocks.push(b);
            continue;
          }
          var sub = b && b.__subagent ? b.__subagent : null;
          if (!sub) sub = deriveLegacySubagent(b);
          // 老消息 tool_result 兜底：用 tool_use_id 反查 map
          if (!sub && b && b.type === "tool_result" && legacyTaskMap && legacyTaskMap.has(b.tool_use_id)) {
            sub = legacyTaskMap.get(b.tool_use_id);
          }
          var key = sub ? sub.taskId : null;
          if (!current || current.key !== key) {
            current = { key: key, subagent: sub, blocks: [], firstIndex: i };
            segs.push(current);
          }
          current.blocks.push(b);
        }
        return segs;
      }

      // 渲染一段内的 blocks。独立 group consecutive tools，避免父/子 agent 的工具
      // 调用跨边界被合并；grp.index 偏移到原数组全局位置，保持 expand key 唯一。
      export function buildSegmentBlocksHtml(segmentBlocks, segmentFirstIndex, role, toolResults, messageKey, options?: any) {
        var html = "";
        var opts = options || {};
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

      // 抽出 multi-agent 渲染共用块。assistant turn 与 user turn 都可能含 subagent 段
      // （user turn 的 Task tool_result 由后端反查盖章），但 user turn 不再输出 handoff
      // 行，避免与 assistant turn 的 handoff 重复。
      // TODO：嵌套 subagent（子 subagent 在外层 subagent 段内再切）时，
      // parentPersonaName 应是外层 subagent.name 而不是固定父 persona；目前先不处理。
      export function buildMultiAgentHtml(segments, role, parentPersonaName, toolResults, messageKey, options) {
        var opts = options || {};
        var showHandoff = opts.showHandoff !== false; // 默认 true；user turn 传 false
        var html = "";
        var lastSubId = null;
        for (var si = 0; si < segments.length; si++) {
          var seg = segments[si];
          var segmentOptions = seg.subagent
            ? { inSubagentPanel: true }
            : {};
          var segHtml = buildSegmentBlocksHtml(seg.blocks, seg.firstIndex, role, toolResults, messageKey, segmentOptions);
          // 段内所有 block 都被短路返空（典型场景：父段只剩一个空 thinking）时，
          // 跳过整段。否则会渲染出"只有头像没内容"的空气泡。
          if (!segHtml || !segHtml.trim()) continue;
          if (seg.subagent) {
            // 整段 subagent 输出包成一个统一的可折叠面板：
            // 头部 = handoff title + 展开按钮；body = segHtml（所有工具卡、文本、最终回复
            // 都在 body 里）；footer = 同款按钮。同一 taskId 的连续段（极少出现的
            // parent→sub→parent→sub 交错）只在第一次露 handoff title。
            var includeHandoff = showHandoff && lastSubId !== seg.subagent.taskId;
            html += buildSubagentPanelHtml(seg, parentPersonaName, segHtml, messageKey, includeHandoff);
            lastSubId = seg.subagent.taskId;
          } else {
            html += '<div class="chat-message-segment parent">' +
              chatAvatar(role) +
              '<div class="chat-message-content">' + segHtml + '</div>' +
            '</div>';
            lastSubId = null;
          }
        }
        return html;
      }

      // 渲染整段 subagent 输出为一个固定高度角色窗口：
      //   ┌─ subagent-panel ──────────────────────────────────┐
      //   │ [🐱] 猫猫审查猫 · Review changes        25 条内容 │  ← header
      //   ├───────────────────────────────────────────────────┤
      //   │ <tool 卡 1>                                       │
      //   │ <text>                                            │  ← body
      //   │ <tool 卡 2>                                       │     固定高度 + 内部滚动
      //   │ <... 最终回复 ...>                                │     + 内部 overflow-y:auto
      //   └───────────────────────────────────────────────────┘
      export function buildSubagentPanelHtml(seg, parentPersonaName, segHtml, messageKey, includeHandoff) {
        var sub = seg.subagent;
        var subPalette = getSubagentPalette(sub);
        var subName = getSubagentDisplayName(sub);
        var taskId = sub.taskId || "";
        var avatarSvg = buildPixelSvg(buildCatGrid(subPalette));
        var itemCount = countRenderableSegmentBlocks(seg.blocks);

        var titleHtml;
        if (includeHandoff) {
          var hasDesc = !!(sub.taskDescription && String(sub.taskDescription).trim());
          var descSpan = hasDesc
            ? '<span class="subagent-panel-task-desc">' + escapeHtml(sub.taskDescription) + '</span>'
            : '<span class="subagent-panel-task-desc">' + escapeHtml(t("subagent.continued")) + '</span>';
          titleHtml = '<span class="subagent-panel-attribution">' +
            '<strong class="subagent-panel-name">' + escapeHtml(subName) + '</strong>' +
            '<span class="subagent-panel-tag" title="' + escapeHtml(t("subagent.tag_title")) + '">' + escapeHtml(t("subagent.tag")) + '</span>' +
            descSpan +
          '</span>';
        } else {
          titleHtml = '<span class="subagent-panel-attribution">' +
            '<strong class="subagent-panel-name">' + escapeHtml(subName) + '</strong>' +
            '<span class="subagent-panel-task-desc"> ' + escapeHtml(t("subagent.continued")) + '</span>' +
          '</span>';
        }

        var expandKey = buildExpandKey("subagent-panel", [messageKey, taskId]);

        return '<div class="subagent-panel" ' +
                    'data-expand-kind="subagent-panel" ' +
                    'data-expand-key="' + escapeHtml(expandKey) + '" ' +
                    'data-agent-id="' + escapeHtml(taskId) + '" ' +
                    'data-expanded="true" ' +
                    'style="--agent-color:' + subPalette.primary + '">' +
          '<div class="subagent-panel-header" aria-label="' + escapeHtml(t("subagent.title_aria")) + '">' +
            '<span class="subagent-panel-avatar" aria-hidden="true">' + avatarSvg + '</span>' +
            titleHtml +
            '<span class="subagent-panel-count">' + escapeHtml(itemCount + " 条内容") + '</span>' +
          '</div>' +
          '<div class="subagent-panel-body">' + segHtml + '</div>' +
        '</div>';
      }

      export function countRenderableSegmentBlocks(blocks) {
        if (!Array.isArray(blocks)) return 0;
        var count = 0;
        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i];
          if (!block || !block.type) continue;
          if (block.type === "tool_result") continue;
          if (block.type === "text" && !String(block.text || "").trim() && !block.__processing) continue;
          if (block.type === "thinking" && !String(block.thinking || "").trim()) continue;
          count++;
        }
        return Math.max(1, count);
      }

      export function renderStructuredMessage(msg, roundUsage, messageIndex, legacyTaskMap) {
        var role = msg.role;
        var messageKey = getMessageKey(msg, messageIndex);
        var usageHtml = role === "assistant" ? renderUsageSummaryHtml(roundUsage) : "";

        // 排队中的用户消息标记（subagent 不会出现在 user role 的 user input 中）
        var isQueued = role === "user" && msg.content && msg.content.some(function(b) { return b.__queued; });

        if (!msg.content || msg.content.length === 0) {
          if (role === "assistant") {
            return '<div class="chat-message ' + role + '">' +
              chatAvatar(role) +
              '<div class="chat-message-content"><div class="typing-indicator"><span></span><span></span><span></span></div>' + usageHtml + '</div>' +
            '</div>';
          }
          // 空 user 消息（极少出现，但快速发送的边界场景会让消息"消失"）。
          // 给个明确占位避免视觉断层。
          return '<div class="chat-message ' + role + ' empty-message" data-message-key="' + escapeHtml(messageKey) + '">' +
            chatAvatar(role) +
            '<div class="chat-message-content"><span class="empty-message-hint">（空消息）</span></div>' +
          '</div>';
        }

        var toolResults = buildToolResultMap(msg.content);
        var parentPersona = getStructuredChatPersona("assistant");

        // user role：可能含 Task tool_result（subagent 反查盖章过的）。检测一下，
        // 有 subagent 段就走 multi-agent 渲染（不输出 handoff，避免重复）。
        if (role !== "assistant") {
          var userSegments = splitTurnBySubagent(msg.content, legacyTaskMap);
          var userHasSub = userSegments.some(function(s) { return s.subagent; });
          var queuedClass = isQueued ? " queued" : "";
          var queuedBadge = isQueued ? '<span class="queued-badge">排队中</span>' : "";
          if (userHasSub) {
            var userMultiHtml = buildMultiAgentHtml(userSegments, role, parentPersona.name, toolResults, messageKey, { showHandoff: false });
            return '<div class="chat-message ' + role + queuedClass + ' multi-agent" data-message-key="' + escapeHtml(messageKey) + '">' +
              userMultiHtml + queuedBadge +
            '</div>';
          }
          var userHtml = buildSegmentBlocksHtml(msg.content, 0, role, toolResults, messageKey);
          return '<div class="chat-message ' + role + queuedClass + '" data-message-key="' + escapeHtml(messageKey) + '">' +
            chatAvatar(role) +
            '<div class="chat-message-content">' + userHtml + queuedBadge + '</div>' +
          '</div>';
        }

        // assistant：检测是否有 subagent 段，没有就走单段渲染（兼容老消息 / 无 subagent 的 turn）
        var segments = splitTurnBySubagent(msg.content, legacyTaskMap);
        var hasSubagent = segments.some(function(s) { return s.subagent; });

        if (!hasSubagent) {
          var html = buildSegmentBlocksHtml(msg.content, 0, role, toolResults, messageKey);
          return '<div class="chat-message ' + role + '" data-message-key="' + escapeHtml(messageKey) + '">' +
            chatAvatar(role) +
            '<div class="chat-message-content">' + html + usageHtml + '</div>' +
          '</div>';
        }

        // 多段：父 assistant 段 + 各 subagent 段。同一根 .chat-message 容器，
        // 内部多个 .chat-message-segment 子段，每段自带头像；切到新 subagent 时
        // 插入一行 handoff 提示（"勤劳初二 ↳ 让 侦探猫 帮忙"）。
        var multiHtml = '<div class="chat-message ' + role + ' multi-agent" data-message-key="' + escapeHtml(messageKey) + '">';
        multiHtml += buildMultiAgentHtml(segments, role, parentPersona.name, toolResults, messageKey, { showHandoff: true });
        multiHtml += usageHtml;
        multiHtml += '</div>';
        return multiHtml;
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

      export function renderUserAttachmentBlock(rawPath) {
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
      export function renderUserText(text) {
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

      export function renderContentBlock(block, role, toolResults, index, messageKey, options?: any) {
        var opts = options || {};
        if (!block || !block.type) return "";

        // 普通父段里仍用角色窗口表达 Task/Agent；进入子 Agent 窗口后，
        // 工具卡本身要显示出来，用户才能看见这个子任务在做什么。
        if (!opts.inSubagentPanel && block.type === "tool_use" && block.__subagent && block.__subagent.taskId === block.id) {
          return "";
        }
        // 只有父 Task 的 tool_result（taskId === tool_use_id）走 reply bubble；
        // 子 agent 内部工具的 tool_result（taskId === parent_tool_use_id ≠ tool_use_id）
        // 走普通工具卡片，不能误判为 reply bubble。
        if (block.type === "tool_result" && block.__subagent && block.__subagent.taskId === block.tool_use_id) {
          return renderSubagentReplyBubble(block, role);
        }

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
                  '<span class="thinking-streaming-icon spinning">⦿</span>' +
                  '<div class="thinking-streaming-text"></div>' +
                '</div>' +
              '</div>';
            }
            // 非流式分支：thinking 字段是空字符串时，UI 上只会出现一条带"展开"
            // 的紫色窄条，展开了也是空——直接不渲染，避免视觉噪音。
            if (!thinkingText.trim()) return "";
            var preview = thinkingText.length > 60 ? thinkingText.slice(0, 57) + "…" : thinkingText;
            var thinkingKey = buildExpandKey("thinking", [messageKey, index]);
            var thinkingPersisted = getPersistedExpandState(thinkingKey);
          var thinkingExpanded = thinkingPersisted === null ? getCardDefault("thinking") : thinkingPersisted;
            return '<div class="thinking-inline ' + (thinkingExpanded ? 'expanded' : 'collapsed') + '" data-expand-kind="thinking" data-expand-key="' + escapeHtml(thinkingKey) + '" data-thinking="' + escapeHtml(thinkingText) + '" onclick="__thinkingToggle(this)">' +
              '<span class="thinking-inline-icon">⦿</span>' +
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
                '<span class="unknown-block-icon">?</span>' +
                '<span class="unknown-block-label">未识别的内容块：' + escapeHtml(unknownType) + '</span>' +
                '<span class="unknown-block-toggle">▼</span>' +
              '</div>' +
              '<pre class="unknown-block-body">' + escapeHtml(unknownJson) + '</pre>' +
            '</div>';
        }
      }

      export function renderInlineTool(block, toolResult, toolName, fileInfo, extraInfo, messageKey, index, options?: any) {
        var opts = options || {};
        var toolId = block.id || "tool-" + toolName;
        var expandKey = buildExpandKey("inline-tool", [messageKey, toolId || index, index]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var inputData = block.input || {};
        var resultContent = extractToolResultText(toolResult && toolResult.content);

        var isError = toolResult && toolResult.is_error;
        var hasResult = resultContent.length > 0;
        var statusIcon = isError ? "✗" : (hasResult ? "✓" : "…");

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

        var resultDataAttr = escapeHtml(resultContent);
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

        // Read 读到图片时，直接在卡片里内联缩略图预览（点击放大用文件预览弹层）。
        // 走的是文件浏览器同款 /api/file-raw 端点；加载失败（被删/超限 413）则隐藏整块。
        var imageHtml = "";
        if (toolName === "Read") {
          var imgPath = inputData.file_path || inputData.path || fileInfo || "";
          if (imgPath && isImagePath(imgPath)) {
            var imgSrc = "/api/file-raw?path=" + encodeURIComponent(imgPath);
            imageHtml = '<div class="inline-tool-image" onclick="event.stopPropagation();">' +
              '<img class="inline-tool-image-thumb" loading="lazy" ' +
                'src="' + imgSrc + '" ' +
                'alt="' + escapeHtml(path) + '" ' +
                'data-path="' + escapeHtml(imgPath) + '" ' +
                'onclick="event.stopPropagation(); if(window.__openFilePreview)window.__openFilePreview(this.getAttribute(\'data-path\'));" ' +
                'onerror="var w=this.closest(\'.inline-tool-image\'); if(w)w.style.display=\'none\';" />' +
            '</div>';
          }
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
      export function renderTerminalTool(block, toolResult, toolName, messageKey, index, options?: any) {
        var opts = options || {};
        var inputData = block.input || {};
        var command = inputData.command || inputData.cmd || "";
        var resultContent = extractToolResultText(toolResult && toolResult.content);
        var toolId = block.id || "tool-" + toolName;
        var expandKey = buildExpandKey("terminal", [messageKey, toolId || index, index]);
        var persistedExpanded = getPersistedExpandState(expandKey);

        var isError = toolResult && toolResult.is_error;
        var exitCode = inputData.exitCode;
        var hasResult = resultContent.length > 0;

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

        var prompt = '<span class="term-prompt">$</span>';
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
      export function extractToolResultText(content) {
        if (!content) return "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content.map(function(item) {
            if (!item || typeof item !== "object") return "";
            if (item.type === "text" && typeof item.text === "string") return item.text;
            try {
              return JSON.stringify(item);
            } catch (e) {
              return "";
            }
          }).filter(Boolean).join("\n");
        }
        return "";
      }

      export function renderDiffTool(block, toolResult, toolName, messageKey, index, options?: any) {
        var opts = options || {};
        var inputData = block.input || {};
        var path = inputData.file_path || inputData.path || "";
        var fileName = path.split("/").pop() || path;
        var toolId = block.id || "tool-" + toolName + "-" + (typeof index === "number" ? index : 0);

        var oldStr = inputData.old_string || "";
        var newStr = inputData.new_string || inputData.content || "";
        var oldContent = inputData.old_content || "";
        var newContent = inputData.new_content || "";
        var unifiedDiff = inputData.unified_diff || inputData.diff || "";
        var changeKind = inputData.kind || "";

        var isWrite = toolName === "Write" || toolName === "MultiEdit";
        var isError = toolResult && toolResult.is_error;
        var toolResultText = extractToolResultText(toolResult && toolResult.content);
        var hasResult = !!(toolResultText && toolResultText.trim().length > 0);

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

      export function renderUnifiedDiffLines(diff) {
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

      export function renderEmptyDiff(path) {
        var suffix = path ? "，可打开文件查看当前内容" : "";
        return '<div class="diff-empty">Codex 未提供内联 diff' + suffix + '。</div>';
      }

      export function formatInlineResult(content, toolName) {
        if (!content) return '<span class="inline-tool-empty">无输出</span>';
        return '<pre class="inline-tool-result-text" style="max-height: 300px; overflow-y: auto;">' + escapeHtml(content) + '</pre>';
      }

      export function renderToolUseCard(block, toolResult, index, messageKey, options?: any) {
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
                '<span class="tool-use-icon">' + (isAnswered ? '✓' : '?') + '</span>' +
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
        } else {
          headerIcon = getToolIcon(toolName);
        }

        var expandKey = buildExpandKey("tool-card", [messageKey, toolId]);
        var persistedExpanded = getPersistedExpandState(expandKey);
        var cardDefaultExpand = getCardDefault("editCards");
        var shouldExpand = opts.forceExpandedToolBodies ? true : (persistedExpanded === null ? cardDefaultExpand : persistedExpanded);
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

      export function getToolDisplayName(toolName) {
        var names = {
          "Read": "读取文件",
          "Write": "写入文件",
          "Edit": "编辑文件",
          "MultiEdit": "多处编辑",
          "Bash": "执行命令",
          "Grep": "搜索内容",
          "Glob": "查找文件",
          "WebFetch": "获取网页",
          "WebSearch": "搜索网页",
          "Task": "任务",
          "TodoWrite": "更新待办",
          "TodoRead": "读取待办",
          "NotebookEdit": "编辑笔记本",
          "Agent": "子代理",
          "AskUserQuestion": "提问",
          "Exit": "退出"
        };
        return names[toolName] || toolName;
      }

      export function getToolIcon(toolName) {
        var icons = {
          "Read": "R",
          "Write": "W",
          "Edit": "E",
          "MultiEdit": "E",
          "Bash": "$",
          "Grep": "G",
          "Glob": "F",
          "WebFetch": "⇣",
          "WebSearch": "⇢",
          "Task": "T",
          "TodoWrite": "☐",
          "TodoRead": "☑",
          "NotebookEdit": "N",
          "Agent": "A",
          "Exit": "×"
        };
        return icons[toolName] || "·";
      }

      export function generateInputSummary(toolName, input) {
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

      export function extractFileInfo(toolName, input) {
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
      export function formatAssistantResponse(text) {
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

      export function parseMarkdownTables(source) {
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

      export function renderMarkdown(text) {
        if (!text) return "";

        var markdownLinks = [];
        var result = escapeHtml(stashMarkdownLinks(String(text)));
        var bt = String.fromCharCode(96);
        var newline = String.fromCharCode(10);

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

        function safeExternalLink(target, label) {
          var value = String(target || "").trim();
          if (value.charAt(0) === "<" && value.charAt(value.length - 1) === ">") {
            value = value.slice(1, -1).trim();
          }
          if (!/^(?:https?:\/\/|mailto:|#)/i.test(value)) return label;
          var escapedTarget = escapeHtml(value);
          var opensNewWindow = /^https?:\/\//i.test(value);
          return '<a href="' + escapedTarget + '"' +
            (opensNewWindow ? ' target="_blank"' : "") +
            ' rel="noopener">' + label + '</a>';
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
                if (serverPath) {
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
          var protectedHighlighted = highlighted.replace(/_/g, '&#95;').replace(/\*/g, '&#42;');
          var replacement = '<div class="code-block">' +
            '<div class="code-block-header">' +
              '<span class="code-lang">' + (lang || "code") + '</span>' +
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
        result = restoreMarkdownLinks(result);
        return '<div class="markdown-content">' + result + '</div>';
      }

      export function highlightCode(code, lang) {
        // Syntax highlighting - escape HTML for display
        code = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return code;
      }

      export function shortCommand(cmd) {
        var s = String(cmd || "").trim();
        return s.length <= 24 ? s || "未选择会话" : s.slice(0, 21) + "...";
      }

      export function normalizeTerminalOutput(value) {
        return String(value || "")
          .replace(/\r\r\n/g, "\r\n")
          .replace(/\u0000/g, "");
      }
