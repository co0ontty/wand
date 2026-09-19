import { state } from "./state";
import "./i18n";
import { escapeHtml } from "./utils";
import { formatInlineResult, scheduleChatRender } from "./chat-render";
import { applyExpandedState, persistElementExpandState, persistSelectedId, scrollChatToBottom } from "./chat-scroll";
import { adjustTerminalScale, openFilePreview } from "./file-browser";
import { attachQueueBarDelegates, bindInputTouchScroll, cancelVoiceRecording, handleInputBoxBlur, handleInputBoxFocus, handleVoiceMove, refreshInputBoxState, sendOrStart, setupMobileKeyboardHandlers, startVoiceRecording, stopSession, stopVoiceRecording, updateQueueBar } from "./input";
import { hideError } from "./notifications";
import { render, resetChatRenderCache } from "./render";
import { addPendingAttachments, closeClaudeSkillsPicker, closePlusPopover, closeSessionsDrawer, dismissDrawerIfOverlay, handleInputBoxKeydown, handleInputPaste, handleInteractiveTextInput, handlePtyImagePaste, login, onChatModeChange, onChatModelChange, onChatThinkingChange, optimizePromptText, setDraftValue, switchServer, syncComposerHasText, togglePlusPopover } from "./session-engine";
import { initTerminal, maybeScrollTerminalToBottom, softResyncTerminal } from "./terminal";
import { setupVisualViewportHandlers } from "./viewport";
import { approvePermission, approveTurnPermission, denyPermission } from "./websocket";

      // Global toggle function for tool card headers — called via onclick attribute
      // Lazy-load tool content for truncated results
      export function __fetchToolContent(toolUseId: any, callback: any) {
        if (!state.selectedId || !toolUseId) return;
        var cacheKey = state.selectedId + ":" + toolUseId;
        if (state.toolContentCache[cacheKey]) {
          callback(null, state.toolContentCache[cacheKey]);
          return;
        }
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/tool-content/" + encodeURIComponent(toolUseId), { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data: any) {
            if (data.error) {
              callback(data.error, null);
            } else {
              state.toolContentCache[cacheKey] = data;
              callback(null, data);
            }
          })
          .catch(function() {
            callback("加载失败", null);
          });
      }

      export function getCardDefault(key: string) {
        return !!(state.config && state.config.cardDefaults && state.config.cardDefaults[key]);
      }

      export function lazyLoadTruncatedToolContent(container: any, targetEl: any, renderContent: any, renderError?: any) {
        if (!container || container.dataset.truncated !== "true" || container.dataset.loaded === "true") return;
        var toolUseId = container.dataset.toolUseId;
        if (!toolUseId) return;
        if (targetEl) targetEl.innerHTML = '<div class="tool-content-loading">加载中…</div>';
        container.dataset.loaded = "loading";
        __fetchToolContent(toolUseId, function(err: any, data: any) {
          if (err) {
            if (targetEl) targetEl.innerHTML = renderError || '<div class="tool-content-error">加载失败，点击重试</div>';
            container.dataset.loaded = "";
            return;
          }
          container.dataset.truncated = "false";
          container.dataset.loaded = "true";
          var content = typeof data.content === "string" ? data.content : JSON.stringify(data.content);
          renderContent(content, data);
        });
      }

      (window as any).__tcToggle = function(e: any, headerEl: any) {
        var card = headerEl.closest(".tool-use-card") || headerEl.closest(".inline-diff");
        if (card) {
          var wasCollapsed = card.classList.contains("collapsed");
          card.classList.toggle("collapsed");
          var isExpanded = wasCollapsed;
          headerEl.setAttribute("aria-expanded", isExpanded ? "true" : "false");
          var cardBody = card.querySelector(".tool-use-body, .diff-body");
          if (cardBody) cardBody.setAttribute("aria-hidden", isExpanded ? "false" : "true");
          var expandKind = card.dataset.expandKind || "tool-card";
          persistElementExpandState(card, expandKind);
          if (wasCollapsed) {
            var resultDiv = card.querySelector(".tool-use-result");
            lazyLoadTruncatedToolContent(
              card,
              resultDiv,
              function(content: any) {
                if (resultDiv) resultDiv.innerHTML = '<pre class="tool-use-result-content">' + escapeHtml(content) + '</pre>';
              },
              '<div class="tool-content-error" onclick="__tcToggle(null, this.closest(\'.tool-use-card,.inline-diff\').querySelector(\'.tool-use-header,.diff-header\'))">加载失败，点击重试</div>'
            );
          }
        }
        if (e) { e.preventDefault(); e.stopPropagation(); }
      };
      // Toggle function for inline thinking blocks — called via onclick attribute
      (window as any).__thinkingToggle = function(el: any) {
        var isCollapsed = el.classList.contains("collapsed");
        if (isCollapsed) {
          el.classList.remove("collapsed");
          el.classList.add("expanded");
          el.querySelector(".thinking-inline-preview").textContent = el.dataset.thinking || "";
          var action = el.querySelector(".thinking-inline-action");
          if (action) action.textContent = "收起";
        } else {
          el.classList.remove("expanded");
          el.classList.add("collapsed");
          var preview = "深度思考";
          el.querySelector(".thinking-inline-preview").textContent = preview;
          var action = el.querySelector(".thinking-inline-action");
          if (action) action.textContent = "展开";
        }
        persistElementExpandState(el, "thinking");
      };
      // Toggle function for subagent reply bubbles — simple two-state preview/expanded.
      // 参考 opencode 的折叠面板：默认固定高度预览（含底部渐隐 mask），点击切到全文展开。
      // 状态写在 data-expanded 上，配套 CSS 控制 max-height + mask；用 data-expand-key
      // 走通用持久化通道（applyPersistedExpandState 会自动恢复用户上次的选择）。
      (window as any).__subagentReplyToggle = function(e: any, target: any) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        var bubble = target && target.closest ? target.closest(".subagent-reply") : null;
        if (!bubble) return;
        var expanded = bubble.getAttribute("data-expanded") === "true";
        applyExpandedState(bubble, "subagent-reply", !expanded);
        persistElementExpandState(bubble, "subagent-reply");
      };
      // subagent 执行卡由原生 button 驱动，浏览器自带 Enter / Space 键盘行为。
      // 展开内容参与主对话滚动，不再操作任何内嵌滚动容器。
      (window as any).__subagentPanelToggle = function(e: any, target: any) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        var panel = target && target.closest ? target.closest(".subagent-panel") : null;
        if (!panel) return;
        var expanded = panel.getAttribute("data-expanded") !== "true";
        applyExpandedState(panel, "subagent-panel", expanded);
        persistElementExpandState(panel, "subagent-panel");
      };

      // 活动折叠仍然是固定高度滚动区：流式刷新后锚定尾部，让用户持续看到
      // 最新到达的思考和工具活动。折叠态下 body 为 display:none，直接跳过。
      export function snapExpandedActivityFoldsToBottom(container: any) {
        if (!container) return;
        var activities = container.querySelectorAll('.chat-activity[data-follow-tail="true"][data-expanded="true"]');
        for (var a = 0; a < activities.length; a++) {
          var actBody = activities[a].querySelector(".chat-activity-body");
          if (!actBody || actBody.style.display === "none") continue;
          actBody.scrollTop = actBody.scrollHeight;
        }
      }
      // 聊天里内联图片缩略图点击 → 打开文件预览弹层（复用文件浏览器同款模态）。
      (window as any).__openFilePreview = function(p: any) {
        if (p) openFilePreview(p);
      };
      // Toggle function for inline tool rows (Read, Glob, Grep, etc.)
      (window as any).__inlineToolToggle = function(el: any) {
        var expanded = el.classList.toggle("inline-tool-open");
        var body = el.querySelector(".inline-tool-expanded");
        if (body) {
          body.style.display = expanded ? "block" : "none";
        }
        // Update status indicator
        var statusSpan = el.querySelector(".inline-tool-status");
        if (statusSpan) {
          if (el.dataset.status === "error") {
            statusSpan.textContent = "✗";
          } else if (el.dataset.status === "done") {
            statusSpan.textContent = "✓";
          }
        }
        if (expanded) {
          lazyLoadTruncatedToolContent(el, body, function(content: any) {
            el.dataset.result = content;
            if (body) body.innerHTML = '<div class="inline-tool-result">' + formatInlineResult(content, "") + '</div>';
          });
        }
        persistElementExpandState(el, "inline-tool");
      };
      // Toggle function for terminal tool blocks
      (window as any).__terminalExpand = function(el: any) {
        var container = el.closest(".inline-terminal");
        if (!container) return;
        var body = container.querySelector(".term-body");
        if (body) {
          var isHidden = body.style.display === "none";
          body.style.display = isHidden ? "block" : "none";
          container.dataset.expanded = isHidden ? "true" : "false";
          el.setAttribute("aria-expanded", isHidden ? "true" : "false");
          body.setAttribute("aria-hidden", isHidden ? "false" : "true");
          var toggleIcon = el.querySelector(".term-toggle-icon");
          if (toggleIcon) toggleIcon.textContent = isHidden ? "▼" : "▶";
          persistElementExpandState(container, "terminal");
          if (isHidden) {
            var termOutput = body.querySelector(".term-output");
            lazyLoadTruncatedToolContent(container, termOutput, function(content: any) {
              if (termOutput) {
                var lines = content.split("\n");
                var html = "";
                for (var i = 0; i < lines.length; i++) {
                  if (!lines[i] && i === lines.length - 1) continue;
                  html += '<div class="term-line">' + escapeHtml(lines[i]) + '</div>';
                }
                termOutput.innerHTML = html;
              }
            });
          }
        }
      };
      // ── AskUserQuestion handlers: select → render → submit ──
      (window as any).__askSelect = function(toolUseId: any, qIdx: any, optIdx: any, isMulti: any) {
        var sel = state.askUserSelections[toolUseId];
        if (!sel) {
          sel = { submitted: false };
          state.askUserSelections[toolUseId] = sel;
        }
        if (sel.submitted) return;
        var current = sel[qIdx] || [];
        if (isMulti) {
          var pos = current.indexOf(optIdx);
          if (pos === -1) { current.push(optIdx); } else { current.splice(pos, 1); }
        } else {
          current = current[0] === optIdx ? [] : [optIdx];
        }
        sel[qIdx] = current;
        (window as any).__askRender(toolUseId);
      };

      (window as any).__askRender = function(toolUseId: any) {
        var card = document.querySelector('[data-tool-use-id="' + toolUseId + '"]');
        if (!card) return;
        var sel = state.askUserSelections[toolUseId] || {};
        // Update option selected states
        card.querySelectorAll(".ask-user-option").forEach(function(btn: any) {
          var qIdx = parseInt(btn.dataset.questionIndex, 10);
          var oIdx = parseInt(btn.dataset.optionIndex, 10);
          var chosen = (sel[qIdx] || []).indexOf(oIdx) !== -1;
          btn.classList.toggle("selected", chosen);
        });
        // Update submit button: enabled only when every question has at least one selection
        var submitBtn = card.querySelector(".ask-user-submit") as HTMLButtonElement | null;
        if (submitBtn) {
          var groups = card.querySelectorAll(".ask-user-question-group");
          var allAnswered = true;
          groups.forEach(function(g: any, i: number) {
            if (!sel[i] || sel[i].length === 0) allAnswered = false;
          });
          submitBtn.disabled = !allAnswered || !!sel.submitted;
          if (sel.submitted) {
            submitBtn.textContent = "已提交...";
            submitBtn.classList.add("ask-user-submitted");
          }
        }
      };

      (window as any).__askSubmit = function(toolUseId: any) {
        var sel = state.askUserSelections[toolUseId];
        if (!sel || sel.submitted || !state.selectedId) return;
        var card = document.querySelector('[data-tool-use-id="' + toolUseId + '"]');
        if (!card) return;
        var groups = card.querySelectorAll(".ask-user-question-group");
        var lines: string[] = [];
        var allAnswered = true;
        groups.forEach(function(group: any, qIdx: number) {
          var selected = sel[qIdx] || [];
          if (selected.length === 0) { allAnswered = false; return; }
          var labels: string[] = [];
          selected.forEach(function(optIdx: any) {
            var btn = group.querySelector('[data-option-index="' + optIdx + '"]');
            if (btn) labels.push(btn.dataset.optionLabel);
          });
          lines.push(labels.join(", "));
        });
        if (!allAnswered) return;
        sel.submitted = true;
        (window as any).__askRender(toolUseId);
        var answerText = lines.join("\n");
        fetch("/api/sessions/" + state.selectedId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ input: answerText + "\n", view: state.currentView })
        }).catch(function(err) {
          console.error("[wand] Error sending answer:", err);
          sel.submitted = false;
          (window as any).__askRender(toolUseId);
        });
      };
      // 只绑一次的全局监听（document/window）。原本散落在 attachEventListeners 里、每次 render
      // 用匿名函数重绑会叠加泄漏。集中绑一次，handler 一律现查 DOM / 读全局 state，避免捕获
      // 每次 render 重建的局部节点导致 stale。
      var composerInputResizeObserver: ResizeObserver | null = null;

      export function bindGlobalListenersOnce() {
        if (state.__globalListenersBound) return;
        state.__globalListenersBound = true;

        // Browser clipboard images have no textual PTY representation. Capture
        // them while either the composer proxy or xterm itself owns focus,
        // upload them into the session cwd, then paste the resulting local path
        // into the CLI as a real bracketed-paste event.
        document.addEventListener("paste", function(event) {
          if (handlePtyImagePaste(event)) {
            event.stopPropagation();
          }
        }, true);

        // 加号 popover：外点 / ESC 关闭。attach-btn 自身的点击在按钮 handler 里 stopPropagation 了，
        // 不会触发外点关闭；popover 内部的 click 冒泡到这里时，contains(target) 命中 → 不关闭。
        document.addEventListener("click", function(e) {
          if (!state.plusPopoverOpen) return;
          var pop = document.getElementById("composer-plus-popover");
          var btn = document.getElementById("attach-btn");
          var target = e.target as HTMLElement | null;
          if (target && typeof target.closest === "function" && target.closest(".wand-composer-select-content")) return;
          if (pop && pop.contains(e.target as Node)) return;
          if (btn && btn.contains(e.target as Node)) return;
          closePlusPopover();
        });
        document.addEventListener("keydown", function(e) {
          if (e.key === "Escape" && state.plusPopoverOpen) {
            var target = e.target as HTMLElement | null;
            if (target && typeof target.closest === "function" && target.closest(".wand-composer-select-content")) return;
            e.preventDefault();
            closePlusPopover(true);
          }
          if (e.key === "Escape") closeClaudeSkillsPicker();
        });

        document.addEventListener("click", function(e) {
          var target = e.target as HTMLElement;
          if (!target || typeof target.closest !== "function") return;
          var picker = document.getElementById("composer-skills-popover");
          // trigger 自己的点击由 React 的 onClick 处理（toggle），这里必须排除它，
          // 否则同一个 click 会被“点外部关闭”再关掉一次，表现为点了没反应。
          if (picker && !picker.contains(target) && !target.closest("[data-claude-skills-trigger]")) closeClaudeSkillsPicker();
        });

        // 三件套（模式 / 模型 / 思考）走全局委托，多个实例共用同一状态源。
        document.addEventListener("change", function(e) {
          var target = e.target as HTMLElement;
          if (!target || target.nodeType !== 1) return;
          if (typeof target.matches !== "function" || !target.matches("[data-mode-control]")) return;
          var ctrl = target.getAttribute("data-mode-control");
          var value = (target as HTMLSelectElement).value;
          if (ctrl === "mode") {
            onChatModeChange(value);
          } else if (ctrl === "model") {
            onChatModelChange(value);
          } else if (ctrl === "thinking") {
            onChatThinkingChange(value);
          }
          // 在加号 popover 内改完三件套之后顺手关掉，反馈立即由 toast + 用户消息头像左侧徽章接管。
          if (target.closest && target.closest("#composer-plus-popover")) closePlusPopover(true);
        });
      }

      export function attachEventListeners() {
        bindGlobalListenersOnce();
        if (composerInputResizeObserver) {
          composerInputResizeObserver.disconnect();
          composerInputResizeObserver = null;
        }

        var loginButton = document.getElementById("login-button");
        if (loginButton) {
          loginButton.addEventListener("click", login);
          var loginForm = document.getElementById("login-form");
          if (loginForm) loginForm.addEventListener("submit", function(e) {
            e.preventDefault();
            login();
          });
          var loginSwitchServerBtn = document.getElementById("login-switch-server-button");
          if (loginSwitchServerBtn) loginSwitchServerBtn.addEventListener("click", switchServer);
          var passwordEl = document.getElementById("password") as HTMLInputElement | null;
          var togglePasswordButton = document.getElementById("toggle-password-button");
          if (togglePasswordButton && passwordEl) {
            togglePasswordButton.addEventListener("click", function() {
              var visible = passwordEl!.type === "text";
              passwordEl!.type = visible ? "password" : "text";
              togglePasswordButton!.textContent = visible ? "显示" : "隐藏";
              togglePasswordButton!.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
              togglePasswordButton!.setAttribute("aria-pressed", visible ? "false" : "true");
              passwordEl!.focus();
            });
          }
          if (passwordEl) {
            passwordEl.addEventListener("keydown", function(e) {
              if (e.key === "Enter") login();
            });
            passwordEl.addEventListener("input", function() {
              passwordEl!.dataset.error = "false";
              passwordEl!.setAttribute("aria-invalid", "false");
              var errorEl = document.getElementById("login-error");
              if (errorEl) hideError(errorEl);
            });
            passwordEl.focus();
          }
          return;
        }

                var approvePermissionBtn = document.getElementById("approve-permission-btn");
        if (approvePermissionBtn) approvePermissionBtn.addEventListener("click", approvePermission);
        var approveTurnPermissionBtn = document.getElementById("approve-turn-permission-btn");
        if (approveTurnPermissionBtn) approveTurnPermissionBtn.addEventListener("click", approveTurnPermission);
        var denyPermissionBtn = document.getElementById("deny-permission-btn");
        if (denyPermissionBtn) denyPermissionBtn.addEventListener("click", denyPermission);
        var sendBtn = document.getElementById("send-input-button");
        if (sendBtn) sendBtn.addEventListener("click", function() {
          // 与 input focus 同理：手机 drawer 盖在上面才收起，桌面常驻栏保持原状。
          dismissDrawerIfOverlay();
          sendOrStart();
        });
        var stopBtn = document.getElementById("stop-button");
        if (stopBtn) stopBtn.addEventListener("click", stopSession);
        var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
        if (inputBox) {
          // A render/login transition may replace a composing textarea without
          // dispatching compositionend. A newly bound node starts a fresh IME
          // generation so stale state cannot swallow its first Return/input.
          if (state.composerCompositionTarget !== inputBox) {
            state.composerCompositionGeneration += 1;
            state.composerCompositionTarget = inputBox;
            state.composerComposing = false;
            state.terminalComposing = false;
          }
          bindInputTouchScroll(inputBox);
          inputBox.addEventListener("keydown", handleInputBoxKeydown);
          inputBox.addEventListener("paste", handleInputPaste);
          inputBox.addEventListener("input", function() {
            // INPUT-3: IME 组字期间不把半成品发给 PTY，等 compositionend 再统一发。
            if (state.terminalComposing) return;
            if (handleInteractiveTextInput(inputBox!)) {
              return;
            }
            refreshInputBoxState(inputBox!);
            setDraftValue(inputBox!.value, true);
            // v2: 触发 ghost meta / 优化按钮的显隐切换
            syncComposerHasText(inputBox!);
          });
          // INPUT-3: 所有 composer 都跟踪 IME 组字，避免 Safari / WKWebView 在
          // compositionend 同一轮事件里把“确认候选”的 Enter 当成发送。PTY 交互模式
          // 另保留 terminalComposing，用于在组字结束后把最终文本一次性写进终端。
          inputBox.addEventListener("compositionstart", function() {
            state.composerCompositionGeneration += 1;
            state.composerCompositionTarget = inputBox;
            state.composerComposing = true;
            state.terminalComposing = !!state.terminalInteractive;
          });
          inputBox.addEventListener("compositionend", function() {
            // WebKit 可能先发 compositionend，再发 isComposing=false 的 Enter keydown。
            // 同时它也可能到下一轮才把最终文本写回 textarea。因此 PTY 的最终 flush
            // 和 guard 清理一起延迟；generation 防止旧 timer 清掉紧接着开始的新组字。
            var generation = state.composerCompositionGeneration;
            var wasTerminalComposition = state.terminalComposing;
            setTimeout(function() {
              if (generation !== state.composerCompositionGeneration) return;
              if (!inputBox!.isConnected) {
                if (state.composerCompositionTarget === inputBox) {
                  state.composerCompositionTarget = null;
                }
                state.terminalComposing = false;
                state.composerComposing = false;
                return;
              }
              if (wasTerminalComposition) {
                state.terminalComposing = false;
                if (state.terminalInteractive) {
                  handleInteractiveTextInput(inputBox!);
                } else {
                  // Interactive mode can be switched off while compositionend
                  // is settling. Preserve the committed text as a normal draft.
                  refreshInputBoxState(inputBox!);
                  setDraftValue(inputBox!.value, true);
                  syncComposerHasText(inputBox!);
                }
              }
              state.composerComposing = false;
            }, 0);
          });
          inputBox.addEventListener("focus", function() {
            // 只在手机 drawer 真的盖在输入区上面时才收起，避免 backdrop 挡点击。
            // 桌面 pinned/窄条形态下 drawer 是常驻并列布局，不会挡输入，调
            // closeSessionsDrawer 会把 sidebarPinned 一起清掉、侧栏整个不见。
            dismissDrawerIfOverlay();
            handleInputBoxFocus({ target: inputBox! });
          });
          inputBox.addEventListener("blur", handleInputBoxBlur);
          // Initial authenticated render can hydrate a persisted multi-line
          // draft directly into the textarea markup. Size it once here so the
          // first frame is not clipped before the user types another key.
          refreshInputBoxState(inputBox);
          // In the React shell the legacy composer host can be mounted before
          // its final column width is available. Re-measure when that width
          // arrives (and on later responsive width changes) so wrapped drafts
          // never stay at the one-line height.
          var composerInputWrap = inputBox.closest(".composer-input-wrap");
          if (composerInputWrap && typeof ResizeObserver !== "undefined") {
            var lastComposerInputWidth = -1;
            composerInputResizeObserver = new ResizeObserver(function(entries) {
              if (!inputBox!.isConnected) {
                composerInputResizeObserver?.disconnect();
                composerInputResizeObserver = null;
                return;
              }
              var width = entries[0] ? entries[0].contentRect.width : composerInputWrap!.getBoundingClientRect().width;
              if (width <= 0 || Math.abs(width - lastComposerInputWidth) < 0.5) return;
              lastComposerInputWidth = width;
              refreshInputBoxState(inputBox!);
            });
            composerInputResizeObserver.observe(composerInputWrap);
          }
        }

        // 加号 popover & 附件上传
        // attach-btn 是 popover 触发器；popover 内的「上传附件」/「终端交互」两个
        // 条目由 React portal 渲染并自带点击处理，这里只保留容器级行为。
        var attachBtn = document.getElementById("attach-btn");
        var fileInput = document.getElementById("file-upload-input") as HTMLInputElement | null;
        var plusPopover = document.getElementById("composer-plus-popover");
        if (attachBtn && plusPopover) {
          attachBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            togglePlusPopover(e.detail === 0);
          });
          plusPopover.addEventListener("keydown", function(e) {
            var target = e.target as HTMLElement;
            if (
              e.target instanceof HTMLSelectElement ||
              e.target instanceof HTMLInputElement ||
              target.matches('[role="combobox"], .wand-ui-select-trigger, .wand-ui-select-search-input') ||
              (typeof target.closest === "function" && target.closest(".wand-composer-select-content"))
            ) return;
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
            var controls = Array.from(plusPopover!.querySelectorAll<HTMLElement>(
              'button:not([disabled]):not(.hidden), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )).filter(function(control) {
              return control.getClientRects().length > 0;
            });
            if (!controls.length) return;
            e.preventDefault();
            var currentIndex = controls.indexOf(document.activeElement as HTMLElement);
            var nextIndex = e.key === "Home"
              ? 0
              : e.key === "End"
                ? controls.length - 1
                : e.key === "ArrowUp"
                  ? (currentIndex <= 0 ? controls.length - 1 : currentIndex - 1)
                  : (currentIndex + 1) % controls.length;
            controls[nextIndex]?.focus();
          });
        }
        if (fileInput) {
          fileInput.addEventListener("change", function() {
            var files = fileInput!.files;
            if (files) {
              addPendingAttachments(files);
            }
            fileInput!.value = "";
          });
        }

        // 语音手势只绑定独立按钮；textarea 保留系统原生的长按、选区与粘贴行为。
        var voiceRecordBtn = document.getElementById("voice-record-btn");
        if (voiceRecordBtn) {
          voiceRecordBtn.addEventListener("pointerdown", startVoiceRecording);
          voiceRecordBtn.addEventListener("pointermove", handleVoiceMove);
          voiceRecordBtn.addEventListener("pointerup", stopVoiceRecording);
          voiceRecordBtn.addEventListener("pointercancel", cancelVoiceRecording);
          voiceRecordBtn.addEventListener("contextmenu", function(e) { e.preventDefault(); });
        }

        var promptOptimizeBtn = document.getElementById("prompt-optimize-btn");
        if (promptOptimizeBtn) {
          // Keep the textarea (and mobile keyboard) focused for pointer/touch
          // activation. Keyboard users can still tab to and activate the
          // button normally because this only intercepts pointer focus.
          promptOptimizeBtn.addEventListener("pointerdown", function(e) {
            e.preventDefault();
          });
          promptOptimizeBtn.addEventListener("click", function() {
            optimizePromptText();
          });
        }
        var composer = document.querySelector(".input-composer");
        if (composer) {
          composer.addEventListener("dragover", function(e) {
            e.preventDefault();
            e.stopPropagation();
            (composer as HTMLElement).classList.add("drag-over");
          });
          composer.addEventListener("dragleave", function(e) {
            e.preventDefault();
            e.stopPropagation();
            (composer as HTMLElement).classList.remove("drag-over");
          });
          composer.addEventListener("drop", function(e) {
            e.preventDefault();
            e.stopPropagation();
            (composer as HTMLElement).classList.remove("drag-over");
            var files = (e as DragEvent).dataTransfer && (e as DragEvent).dataTransfer!.files;
            if (files) {
              addPendingAttachments(files);
            }
          });
        }

        // Terminal interactive toggle: 点击处理随条目一起搬进了 React。

        // Terminal scale controls (topbar)
        var scaleDownBtn = document.getElementById("terminal-scale-down-top");
        var scaleUpBtn = document.getElementById("terminal-scale-up-top");
        if (scaleDownBtn) scaleDownBtn.addEventListener("click", function() { adjustTerminalScale(-0.25); });
        if (scaleUpBtn) scaleUpBtn.addEventListener("click", function() { adjustTerminalScale(0.25); });
        var pageRefreshBtn = document.getElementById("page-refresh-btn");
        if (pageRefreshBtn) pageRefreshBtn.addEventListener("click", function(ev) {
          // Soft refresh: replay terminal buffer + rebuild chat view.
          // Fixes residual DOM from CSI cursor-jump sequences without losing page state.
          // Hold Shift to force a full page reload as an escape hatch.
          if (ev && ev.shiftKey) {
            location.reload();
            return;
          }
          softResyncTerminal();
          // 用户停留在当前会话，只是想刷一下 DOM——保留其阅读位置和 sticky 状态。
          resetChatRenderCache({ preserveStickState: true });
          scheduleChatRender(true);
        });
        var jumpBottomBtn = document.getElementById("terminal-jump-bottom");
        if (jumpBottomBtn) jumpBottomBtn.addEventListener("click", function() {
          maybeScrollTerminalToBottom("force");
        });
        // 未读气泡：点一下就贴回最新消息，顺手清掉未读分割线和计数。
        var chatUnreadBubble = document.getElementById("chat-unread-bubble");
        if (chatUnreadBubble) chatUnreadBubble.addEventListener("click", function() {
          scrollChatToBottom(true);
        });
                initTerminal();
        setupMobileKeyboardHandlers();
        setupVisualViewportHandlers();

        // 排队条：每次 shell 重渲后，重新挂事件代理 + 刷新内容。
        attachQueueBarDelegates();
        updateQueueBar();
      }
