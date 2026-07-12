import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml, refreshTailMarqueePaths, renderTailMarqueePath } from "./utils";
import { formatInlineResult, scheduleChatRender } from "./chat-render";
import { applyExpandedState, applyPersistedExpandState, persistCrossSessionQueue, persistElementExpandState, persistSelectedId, saveStructuredQueue, scrollChatToBottom } from "./chat-scroll";
import { adjustTerminalScale, closeFilePanel, dismissFileContextMenu, filterFileTree, isMobileLayout, navigateExplorerUp, openFilePreview, refreshFileExplorer, setFilePanelOpen, toggleFilePanel, updateFilePanelState, updateScaleLabel } from "./file-browser";
import { attachQuickCommitModalListeners, closeQuickCommitModal, loadGitStatus, openQuickCommitModal } from "./git-commit";
import { attachQueueBarDelegates, bindInputTouchScroll, createSessionFromInput, createSessionFromWelcomeInput, deleteClaudeHistoryDirectory, deleteClaudeHistorySession, deleteSession, focusInputBox, getHistoryItemsByCwd, getSelectedSession, handleDeleteCodexHistoryAction, handleInputBoxBlur, handleInputBoxFocus, handleResumeAction, handleResumeCodexHistoryAction, handleResumeHistoryAction, handleVoiceMove, initSwipeToDelete, postInput, queueDirectInput, refreshInputBoxState, resumeSessionFromList, sendOrStart, setupMobileKeyboardHandlers, startAndActivateCommand, startVoiceRecording, stopSession, stopVoiceRecording, toggleTerminalInteractive, toggleVoiceMode, updateQueueBar, welcomeInputSend } from "./input";
import { _doPlaySound, _hasNativeBridge, _vibrate, hideError, showError, showToast, wandAlert, wandConfirm } from "./notifications";
import { getEffectiveCwd, render, resetChatRenderCache } from "./render";
import { _updateAppIconSelection, addPendingAttachment, backToNativeApp, bindSettingsModelComboboxes, checkForUpdate, closePlusPopover, closeSessionModal, closeSessionsDrawer, closeSettingsModal, closeWorktreeMergeModal, confirmWorktreeMerge, copyToClipboard, createStructuredSession, dismissDrawerIfOverlay, getSafeModeForTool, handleCollapsedTileHover, handleCollapsedTileLeave, handleInputBoxKeydown, handleInputPaste, handleInteractiveTextInput, hideCollapsedTileBubble, hidePathSuggestions, initBlankChatCwd, isStructuredSession, loadProviderCliUpdates, loadSessions, login, logout, onChatModeChange, onChatModelChange, onChatThinkingChange, openEnvPreviewModal, openSessionModal, openSettingsModal, openWorktreeMergeModal, optimizePromptText, performProviderCliUpdates, performSettingsRestart, performUpdate, persistNewSessionDefaults, positionSidebarOverflowMenu, quickStartSession, refreshAll, refreshAllChatModeTrios, refreshAvailableModels, resetNotificationPermission, retryWorktreeCleanup, runCommand, saveConfigSettings, saveDisplaySettings, savePassword, schedulePathSuggestions, scheduleTestNotification, selectSession, setDraftValue, setUpdateChannel, switchServer, switchSettingsTab, syncCommitModelProvider, syncComposerHasText, syncSessionModalUI, testNotification, toggleAutoUpdate, togglePlusPopover, toggleSessionsDrawer, toggleSidebarCollapsed, toggleSidebarPin, updateNotificationStatus, uploadCertificates } from "./session-engine";
import { batchDeleteSelected, clearSelections, confirmDelete, renderSessions, selectAllVisibleItems, toggleManageMode, toggleManagedItemSelection } from "./sidebar";
import { activateSessionItem, addRecentPath, copySelectedSessionField, fetchRecentPaths, handleSessionItemClick, handleSessionItemKeydown, initTerminal, maybeScrollTerminalToBottom, saveWorkingDir, softResyncTerminal } from "./terminal";
import { ensureTerminalFit, setupVisualViewportHandlers, teardownTerminal } from "./viewport";
import { approvePermission, denyPermission, toggleAutoApprove } from "./websocket";

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
          var preview = (el.dataset.thinking || "").slice(0, 57) + ((el.dataset.thinking || "").length > 60 ? "…" : "");
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
      // 旧版 subagent panel 是可折叠面板；新版是固定高度角色窗口。
      // 保留这个入口兼容旧 DOM / 旧内联事件，但只会把窗口恢复到常驻展开态。
      (window as any).__subagentPanelToggle = function(e: any, target: any) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        var panel = target && target.closest ? target.closest(".subagent-panel") : null;
        if (!panel) return;
        panel.setAttribute("data-expanded", "true");
      };

      // 固定高度角色窗口默认从头展示，便于看见任务入口。未来如果需要 live-tail
      // 跟随，可给 panel 标 data-follow-tail="true"，这个入口会只处理那类窗口。
      export function snapCollapsedSubagentPanelsToBottom(container: any) {
        if (!container) return;
        var panels = container.querySelectorAll('.subagent-panel[data-follow-tail="true"]');
        for (var i = 0; i < panels.length; i++) {
          var body = panels[i].querySelector(".subagent-panel-body");
          if (!body) continue;
          // 直接赋 scrollHeight 即可，浏览器会自动钳到合法上界。
          body.scrollTop = body.scrollHeight;
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
      // Update streaming thinking content (called from WebSocket handler)
      export function updateStreamingThinking(text: string) {
        var el = document.querySelector(".thinking-streaming");
        if (el) {
          var textEl = el.querySelector(".thinking-streaming-text");
          if (textEl) {
            // Show last 3 lines in scrollable area
            var lines = text.split("\n");
            var displayLines = lines.slice(-3);
            (textEl as HTMLElement).textContent = displayLines.join("\n");
            // Auto-scroll to bottom
            (textEl as HTMLElement).scrollTop = (textEl as HTMLElement).scrollHeight;
          }
        }
      }
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
      export function bindGlobalListenersOnce() {
        if (state.__globalListenersBound) return;
        state.__globalListenersBound = true;

        // sidebar overflow 菜单：外点 / 视口变化时关闭
        document.addEventListener("click", function() {
          var el = document.getElementById("sidebar-overflow-menu");
          if (el) el.classList.remove("open");
        });

        // 设置页可能随 shell 重绘而替换节点。更新操作使用全局委托，避免按钮节点更新后
        // 丢失 click listener，也确保后续局部初始化异常不会让更新入口失效。
        document.addEventListener("click", function(e) {
          var target = e.target as HTMLElement | null;
          if (!target || typeof target.closest !== "function") return;
          var button = target.closest("#check-update-button, #do-update-button, #do-restart-button, #check-provider-cli-updates, #update-provider-clis") as HTMLButtonElement | null;
          if (!button || button.disabled) return;
          e.preventDefault();
          if (button.id === "check-update-button") {
            checkForUpdate();
          } else if (button.id === "do-update-button") {
            performUpdate();
          } else if (button.id === "check-provider-cli-updates") {
            loadProviderCliUpdates(true);
          } else if (button.id === "update-provider-clis") {
            performProviderCliUpdates();
          } else {
            performSettingsRestart();
          }
        });
        window.addEventListener("resize", function() {
          var el = document.getElementById("sidebar-overflow-menu");
          if (el) el.classList.remove("open");
        });

        // topbar more 菜单：外点 / ESC 关闭
        var closeTopbarMore = function() {
          state.topbarMoreOpen = false;
          var menu = document.getElementById("topbar-more-menu");
          var btn = document.getElementById("topbar-more-button");
          if (menu) menu.classList.add("hidden");
          if (btn) {
            btn.classList.remove("active");
            btn.setAttribute("aria-expanded", "false");
          }
        };
        document.addEventListener("click", function(e) {
          if (!state.topbarMoreOpen) return;
          var menu = document.getElementById("topbar-more-menu");
          var wrap = menu && menu.parentElement;
          if (wrap && !wrap.contains(e.target as Node)) closeTopbarMore();
        });
        document.addEventListener("keydown", function(e) {
          if (e.key === "Escape" && state.topbarMoreOpen) closeTopbarMore();
        });

        // 加号 popover：外点 / ESC 关闭。attach-btn 自身的点击在按钮 handler 里 stopPropagation 了，
        // 不会触发外点关闭；popover 内部的 click 冒泡到这里时，contains(target) 命中 → 不关闭。
        document.addEventListener("click", function(e) {
          if (!state.plusPopoverOpen) return;
          var pop = document.getElementById("composer-plus-popover");
          var btn = document.getElementById("attach-btn");
          if (pop && pop.contains(e.target as Node)) return;
          if (btn && btn.contains(e.target as Node)) return;
          closePlusPopover();
        });
        document.addEventListener("keydown", function(e) {
          if (e.key === "Escape" && state.plusPopoverOpen) closePlusPopover();
        });

        // 自动批准 chip 会随输入栏/会话状态局部刷新，使用委托避免刷新后丢失点击绑定。
        document.addEventListener("click", function(e) {
          var target = e.target as HTMLElement;
          if (!target || typeof target.closest !== "function") return;
          var toggle = target.closest("#auto-approve-toggle");
          if (!toggle) return;
          e.preventDefault();
          toggleAutoApprove();
        });

        // folder picker：外点关闭下拉
        document.addEventListener("click", function(e) {
          if (!(e.target as HTMLElement).closest(".folder-picker-container")) {
            var dd = document.getElementById("folder-picker-dropdown");
            if (dd) dd.classList.add("hidden");
          }
        });

        // 思考滑杆拖动时只更新本地预览，松手后的 change 才提交，避免连续请求。
        document.addEventListener("input", function(e) {
          var target = e.target as HTMLInputElement | null;
          if (!target || !target.matches('input[type="range"][data-mode-control="thinking"]')) return;
          var labels: string[] = [];
          try { labels = JSON.parse(target.dataset.thinkingLabels || "[]"); } catch (_error) {}
          var index = Math.max(0, Math.min(labels.length - 1, Math.round(Number(target.value) || 0)));
          var label = labels[index] || "auto";
          var shell = target.closest('[data-mode-control-pill="thinking"]');
          var valueLabel = shell && shell.querySelector(".thinking-slider-value");
          if (valueLabel) valueLabel.textContent = label;
          target.setAttribute("aria-valuetext", label);
          var rail = target.closest(".thinking-slider-rail") as HTMLElement | null;
          var max = Number(target.max) || 0;
          if (rail) rail.style.setProperty("--thinking-progress", (max ? index / max * 100 : 0) + "%");
        });

        // 三件套（模式 / 模型 / 思考）走全局委托，多个实例共用同一状态源。
        document.addEventListener("change", function(e) {
          var target = e.target as HTMLElement;
          if (!target || target.nodeType !== 1) return;
          if (typeof target.matches !== "function" || !target.matches("[data-mode-control]")) return;
          var ctrl = target.getAttribute("data-mode-control");
          var value = (target as HTMLSelectElement).value;
          var isThinkingRange = ctrl === "thinking" && target.matches('input[type="range"]');
          if (isThinkingRange) {
            try {
              var values = JSON.parse((target as HTMLInputElement).dataset.thinkingValues || "[]");
              value = values[Math.round(Number((target as HTMLInputElement).value) || 0)] || "off";
            } catch (_error) { value = "off"; }
          }
          if (ctrl === "mode") {
            onChatModeChange(value);
          } else if (ctrl === "model") {
            onChatModelChange(value);
          } else if (ctrl === "thinking") {
            onChatThinkingChange(value);
          }
          // 在加号 popover 内改完三件套之后顺手关掉，反馈立即由 toast + 用户消息头像左侧徽章接管。
          if (!isThinkingRange && target.closest && target.closest("#composer-plus-popover")) closePlusPopover();
        });
      }

      export function attachEventListeners() {
        bindGlobalListenersOnce();

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

        // Welcome screen event listeners
        var welcomeInput = document.getElementById("welcome-input") as HTMLTextAreaElement | null;
        if (welcomeInput) {
          welcomeInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              welcomeInputSend();
            }
          });
          welcomeInput.focus();
        }
        var welcomeSendBtn = document.getElementById("welcome-send-btn");
        if (welcomeSendBtn) {
          welcomeSendBtn.addEventListener("click", function() {
            welcomeInputSend();
          });
        }
        var welcomeClaudeBtn = document.getElementById("welcome-tool-claude");
        if (welcomeClaudeBtn) {
          welcomeClaudeBtn.addEventListener("click", function() {
            quickStartSession();
          });
        }
        var welcomeCodexBtn = document.getElementById("welcome-tool-codex");
        if (welcomeCodexBtn) {
          welcomeCodexBtn.addEventListener("click", function() {
            state.sessionTool = "codex";
            state.preferredCommand = "codex";
            state.modeValue = "full-access";
            quickStartSession();
          });
        }
        var welcomeOpenCodeBtn = document.getElementById("welcome-tool-opencode");
        if (welcomeOpenCodeBtn) {
          welcomeOpenCodeBtn.addEventListener("click", function() {
            state.sessionTool = "opencode";
            state.preferredCommand = "opencode";
            state.modeValue = "managed";
            quickStartSession();
          });
        }
        var welcomeStructuredBtn = document.getElementById("welcome-tool-structured");
        if (welcomeStructuredBtn) {
          welcomeStructuredBtn.addEventListener("click", function() {
            createStructuredSession().then(function() {
              focusInputBox(true);
            }).catch(function(error) {
              showToast((error && error.message) || "无法启动结构化会话。", "error");
            });
          });
        }
        initBlankChatCwd();

        var sessionsList = document.getElementById("sessions-list");
        if (sessionsList) {
          sessionsList.addEventListener("click", handleSessionItemClick);
          sessionsList.addEventListener("keydown", handleSessionItemKeydown);
          sessionsList.addEventListener("mouseover", handleCollapsedTileHover);
          sessionsList.addEventListener("mouseout", handleCollapsedTileLeave);
          initSwipeToDelete(sessionsList);
        }
        // History now renders inline as the final group inside #sessions-list,
        // so the delegated handlers above already cover its toggle / directory
        // expand-collapse / item clicks / clear-all — no separate region wiring.
        window.addEventListener("scroll", hideCollapsedTileBubble, true);
        window.addEventListener("resize", hideCollapsedTileBubble);

        var providerCardsEl = document.getElementById("provider-cards");
        if (providerCardsEl) providerCardsEl.addEventListener("click", function(e) {
          var card = (e.target as HTMLElement).closest(".provider-card");
          if (!card || card.classList.contains("disabled")) return;
          var provider = card.getAttribute("data-provider");
          if (provider) {
            state.sessionTool = provider;
            state.preferredCommand = provider;
            // Codex 现在同时支持 PTY 与结构化 runner，不再强制把 kind 切成 pty。
            // mode 由 syncSessionModalUI() 调用 getSafeModeForTool() 自动 clamp，
            // 不在这里硬写。
            syncSessionModalUI();
            persistNewSessionDefaults({
              defaultProvider: provider,
              defaultMode: state.modeValue
            });
          }
        });

        var kindCardsEl = document.getElementById("session-kind-cards");
        if (kindCardsEl) kindCardsEl.addEventListener("click", function(e) {
          var card = (e.target as HTMLElement).closest(".session-kind-card");
          if (!card || card.classList.contains("disabled")) return;
          var kind = card.getAttribute("data-session-kind");
          if (kind) {
            state.sessionCreateKind = kind;
            syncSessionModalUI();
            persistNewSessionDefaults({ defaultSessionKind: kind });
          }
        });

        var modeCardsEl = document.getElementById("mode-cards");
        if (modeCardsEl) modeCardsEl.addEventListener("click", function(e) {
          var card = (e.target as HTMLElement).closest(".mode-card");
          if (!card) return;
          var mode = card.getAttribute("data-mode");
          if (mode) {
            state.modeValue = mode;
            syncSessionModalUI();
            persistNewSessionDefaults({ defaultMode: state.modeValue });
          }
        });
        var worktreeToggleEl = document.getElementById("session-worktree-toggle") as HTMLInputElement | null;
        if (worktreeToggleEl) worktreeToggleEl.addEventListener("change", function() {
          state.sessionCreateWorktree = worktreeToggleEl!.checked;
        });
        var cwdEl = document.getElementById("cwd") as HTMLInputElement | null;
        if (cwdEl) {
          cwdEl.addEventListener("input", function() { state.cwdValue = cwdEl!.value; });
          cwdEl.addEventListener("change", function() { state.cwdValue = cwdEl!.value; });
          cwdEl.addEventListener("input", schedulePathSuggestions);
          cwdEl.addEventListener("focus", schedulePathSuggestions);
          cwdEl.addEventListener("blur", function() { setTimeout(hidePathSuggestions, 120); });
        }
        var sessionsToggle = document.getElementById("sessions-toggle-button");
        if (sessionsToggle) sessionsToggle.addEventListener("click", toggleSessionsDrawer);
        var drawerBackdrop = document.getElementById("sessions-drawer-backdrop");
        if (drawerBackdrop) drawerBackdrop.addEventListener("click", closeSessionsDrawer);
        var closeDrawerBtn = document.getElementById("close-drawer-button");
        if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeSessionsDrawer);
        var collapseBtn = document.getElementById("sidebar-collapse-btn");
        if (collapseBtn) collapseBtn.addEventListener("click", toggleSidebarCollapsed);
        var pinBtn = document.getElementById("sidebar-pin-btn");
        if (pinBtn) pinBtn.addEventListener("click", toggleSidebarPin);
        var sidebarMoreBtn = document.getElementById("sidebar-more-btn");
        var sidebarOverflow = document.getElementById("sidebar-overflow-menu");
        if (sidebarMoreBtn && sidebarOverflow) {
          sidebarMoreBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            var willOpen = !sidebarOverflow!.classList.contains("open");
            sidebarOverflow!.classList.toggle("open", willOpen);
            if (willOpen) positionSidebarOverflowMenu(sidebarOverflow!);
          });
        }
        var homeBtn = document.getElementById("sidebar-home-btn");
        if (homeBtn) homeBtn.addEventListener("click", function() {
          state.selectedId = null;
          persistSelectedId();
          resetChatRenderCache();
          // 回到首页是导航语义，不是「收侧栏」。桌面常驻栏保留；手机只把 overlay 收掉。
          dismissDrawerIfOverlay();
          render();
        });
        var refreshBtn = document.getElementById("sidebar-refresh-btn");
        if (refreshBtn) refreshBtn.addEventListener("click", function() {
          window.location.reload();
        });
        var logoutBtn = document.getElementById("logout-button");
        if (logoutBtn) logoutBtn.addEventListener("click", logout);
        var switchServerBtn = document.getElementById("switch-server-button");
        if (switchServerBtn) switchServerBtn.addEventListener("click", switchServer);
        var backToNativeBtn = document.getElementById("back-to-native-button");
        if (backToNativeBtn) backToNativeBtn.addEventListener("click", backToNativeApp);
        var settingsBtn = document.getElementById("settings-button");
        if (settingsBtn) settingsBtn.addEventListener("click", openSettingsModal);
        var closeSettingsBtn = document.getElementById("close-settings-button");
        if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", closeSettingsModal);
        var settingsModal = document.getElementById("settings-modal");
        if (settingsModal) settingsModal.addEventListener("click", function(e) {
          if ((e.target as HTMLElement).id === "settings-modal") closeSettingsModal();
        });
        var savePassBtn = document.getElementById("save-password-button");
        if (savePassBtn) savePassBtn.addEventListener("click", savePassword);
        // Settings tab clicks
        var settingsTabs = document.querySelectorAll(".settings-tab");
        for (var ti = 0; ti < settingsTabs.length; ti++) {
          settingsTabs[ti].addEventListener("click", function(e) {
            var btn = (e as any).currentTarget || this;
            var tabName = btn && btn.getAttribute ? btn.getAttribute("data-tab") : null;
            if (tabName) switchSettingsTab(tabName);
          });
        }
        var saveConfigBtn = document.getElementById("save-config-button");
        if (saveConfigBtn) saveConfigBtn.addEventListener("click", saveConfigSettings);
        bindSettingsModelComboboxes();
        var defaultModelRefreshBtn = document.getElementById("cfg-default-model-refresh");
        if (defaultModelRefreshBtn) defaultModelRefreshBtn.addEventListener("click", refreshAvailableModels);
        var commitModelRefreshBtn = document.getElementById("cfg-commit-model-refresh");
        if (commitModelRefreshBtn) commitModelRefreshBtn.addEventListener("click", refreshAvailableModels);
        var commitCliSelect = document.getElementById("cfg-commit-cli");
        if (commitCliSelect) commitCliSelect.addEventListener("change", function() { syncCommitModelProvider(true); });
        var viewEnvBtn = document.getElementById("cfg-view-env-btn");
        if (viewEnvBtn) viewEnvBtn.addEventListener("click", openEnvPreviewModal);
        var saveDisplayBtn = document.getElementById("save-display-button");
        if (saveDisplayBtn) saveDisplayBtn.addEventListener("click", saveDisplaySettings);
        // App icon picker (APK only)
        var appIconPicker = document.getElementById("app-icon-picker");
        if (appIconPicker) {
          var appIconOpts = appIconPicker.querySelectorAll(".settings-app-icon-option");
          for (var ai = 0; ai < appIconOpts.length; ai++) {
            appIconOpts[ai].addEventListener("click", function() {
              var iconName = (this as HTMLElement).getAttribute("data-icon");
              if (!iconName || typeof WandNative === "undefined" || typeof WandNative.setAppIcon !== "function") return;
              try {
                WandNative.setAppIcon(iconName);
                _updateAppIconSelection(iconName);
                var msgEl = document.getElementById("app-icon-message");
                if (msgEl) {
                  msgEl.textContent = "图标已切换，返回桌面后生效";
                  msgEl.style.color = "var(--success)";
                  msgEl.classList.remove("hidden");
                  setTimeout(function() { msgEl!.classList.add("hidden"); }, 3000);
                }
              } catch (_e) {}
            });
          }
        }
        var uploadCertBtn = document.getElementById("upload-cert-button");
        if (uploadCertBtn) uploadCertBtn.addEventListener("click", uploadCertificates);
        var filePickerInputs = document.querySelectorAll(".file-picker-input");
        for (var fpi = 0; fpi < filePickerInputs.length; fpi++) {
          (function(input: HTMLInputElement) {
            input.addEventListener("change", function() {
              var picker = input.closest(".file-picker");
              if (!picker) return;
              var nameEl = picker.querySelector(".file-picker-name") as HTMLElement | null;
              if (!nameEl) return;
              if (input.files && input.files[0]) {
                nameEl.textContent = input.files[0].name;
                picker.classList.add("file-picker-has-file");
              } else {
                nameEl.textContent = nameEl.getAttribute("data-default") || "未选择文件";
                picker.classList.remove("file-picker-has-file");
              }
            });
          })(filePickerInputs[fpi] as HTMLInputElement);
        }
        var autoUpdateWebToggle = document.getElementById("auto-update-web-toggle") as HTMLInputElement | null;
        if (autoUpdateWebToggle) autoUpdateWebToggle.addEventListener("change", function() {
          toggleAutoUpdate("web", autoUpdateWebToggle!.checked);
        });
        var autoUpdateApkToggle = document.getElementById("auto-update-apk-toggle") as HTMLInputElement | null;
        if (autoUpdateApkToggle) autoUpdateApkToggle.addEventListener("change", function() {
          toggleAutoUpdate("apk", autoUpdateApkToggle!.checked);
        });
        var autoUpdateDmgToggle = document.getElementById("auto-update-dmg-toggle") as HTMLInputElement | null;
        if (autoUpdateDmgToggle) autoUpdateDmgToggle.addEventListener("change", function() {
          toggleAutoUpdate("dmg", autoUpdateDmgToggle!.checked);
        });
        var autoUpdateCliToggle = document.getElementById("auto-update-cli-toggle") as HTMLInputElement | null;
        if (autoUpdateCliToggle) autoUpdateCliToggle.addEventListener("change", function() {
          toggleAutoUpdate("cli", autoUpdateCliToggle!.checked);
        });
        var betaChannelToggle = document.getElementById("beta-channel-toggle") as HTMLInputElement | null;
        if (betaChannelToggle) betaChannelToggle.addEventListener("change", function() {
          setUpdateChannel(betaChannelToggle!.checked ? "beta" : "stable");
        });
        var copyConnectCodeBtn = document.getElementById("copy-connect-code-button");
        if (copyConnectCodeBtn) copyConnectCodeBtn.addEventListener("click", function() {
          var text = document.getElementById("android-connect-code");
          if (text) copyToClipboard(text.textContent!, copyConnectCodeBtn);
        });
        // Notification preferences
        var notifSoundEl = document.getElementById("cfg-notif-sound") as HTMLInputElement | null;
        if (notifSoundEl) {
          notifSoundEl.checked = state.notifSound;
          notifSoundEl.addEventListener("change", function() {
            state.notifSound = notifSoundEl!.checked;
            try { localStorage.setItem("wand-notif-sound", String(state.notifSound)); } catch (e) {}
            // Preview sound when toggling on
            if (state.notifSound) _doPlaySound();
            // Toggle volume slider visibility
            var volField = document.getElementById("notif-volume-field");
            if (volField) volField.style.display = state.notifSound ? "" : "none";
          });
        }
        // Volume slider
        var notifVolumeEl = document.getElementById("cfg-notif-volume") as HTMLInputElement | null;
        var notifVolumeVal = document.getElementById("cfg-notif-volume-val");
        // Helper to keep the iOS-style range fill in sync with the input value
        var _syncRangeFill = function(el: HTMLInputElement) {
          if (!el) return;
          var minVal = Number(el.min || 0);
          var maxVal = Number(el.max || 100);
          var curVal = Number(el.value || 0);
          var pct = maxVal > minVal
            ? Math.max(0, Math.min(100, ((curVal - minVal) / (maxVal - minVal)) * 100))
            : 0;
          el.style.setProperty("--range-fill", pct + "%");
        };
        if (notifVolumeEl) {
          notifVolumeEl.value = String(state.notifVolume);
          if (notifVolumeVal) notifVolumeVal.textContent = state.notifVolume + "%";
          _syncRangeFill(notifVolumeEl);
          // Hide if sound is off
          var volField = document.getElementById("notif-volume-field");
          if (volField) volField.style.display = state.notifSound ? "" : "none";
          var _volDebounce: any = null;
          notifVolumeEl.addEventListener("input", function() {
            state.notifVolume = parseInt(notifVolumeEl!.value, 10);
            if (notifVolumeVal) notifVolumeVal.textContent = state.notifVolume + "%";
            _syncRangeFill(notifVolumeEl!);
            try { localStorage.setItem("wand-notif-volume", String(state.notifVolume)); } catch (e) {}
            // Also sync to native bridge if available
            if (_hasNativeBridge && typeof WandNative.setNotificationVolume === "function") {
              try { WandNative.setNotificationVolume(state.notifVolume); } catch (_e) {}
            }
          });
          // Preview on release
          notifVolumeEl.addEventListener("change", function() {
            _doPlaySound();
          });
        }
        var notifBubbleEl = document.getElementById("cfg-notif-bubble") as HTMLInputElement | null;
        if (notifBubbleEl) {
          notifBubbleEl.checked = state.notifBubble;
          notifBubbleEl.addEventListener("change", function() {
            state.notifBubble = notifBubbleEl!.checked;
            try { localStorage.setItem("wand-notif-bubble", String(state.notifBubble)); } catch (e) {}
          });
        }
        // Browser notification section
        var notifRequestBtn = document.getElementById("notification-request-btn");
        if (notifRequestBtn) notifRequestBtn.addEventListener("click", function() {
          if (_hasNativeBridge) {
            (window as any)._onNativePermissionResult = function() {
              updateNotificationStatus();
              delete (window as any)._onNativePermissionResult;
            };
            try { WandNative.requestPermission(); } catch (_e) {}
          } else if (typeof Notification !== "undefined") {
            Notification.requestPermission().then(function() { updateNotificationStatus(); });
          }
        });
        var notifResetBtn = document.getElementById("notification-reset-btn");
        if (notifResetBtn) notifResetBtn.addEventListener("click", resetNotificationPermission);
        var notifTestBtn = document.getElementById("notification-test-btn");
        if (notifTestBtn) notifTestBtn.addEventListener("click", testNotification);
        var notifTestDelayBtn = document.getElementById("notification-test-delay-btn");
        if (notifTestDelayBtn) notifTestDelayBtn.addEventListener("click", scheduleTestNotification);
        updateNotificationStatus();
        // Native notification sound selector (APK only)
        if (_hasNativeBridge && typeof WandNative.getAvailableSounds === "function") {
          var nativeSoundSection = document.getElementById("native-sound-section");
          var nativeSoundSelect = document.getElementById("native-sound-select") as HTMLSelectElement | null;
          var nativeSoundPreview = document.getElementById("native-sound-preview");
          if (nativeSoundSection && nativeSoundSelect) {
            nativeSoundSection.classList.remove("hidden");
            try {
              var sounds = JSON.parse(WandNative.getAvailableSounds());
              var current = WandNative.getNotificationSound();
              nativeSoundSelect.innerHTML = "";
              for (var si = 0; si < sounds.length; si++) {
                var opt = document.createElement("option");
                opt.value = sounds[si].id;
                opt.textContent = sounds[si].name;
                if (sounds[si].id === current) opt.selected = true;
                nativeSoundSelect.appendChild(opt);
              }
              nativeSoundSelect.addEventListener("change", function() {
                try { WandNative.setNotificationSound(nativeSoundSelect!.value); } catch (_e) {}
              });
              if (nativeSoundPreview) {
                nativeSoundPreview.addEventListener("click", function() {
                  try { WandNative.previewSound(nativeSoundSelect!.value); } catch (_e) {}
                });
              }
            } catch (_e) {}
          }
        }
        // Native haptic toggle (APK only)
        if (_hasNativeBridge && typeof WandNative.isHapticEnabled === "function") {
          var hapticSection = document.getElementById("native-haptic-section");
          var hapticToggle = document.getElementById("cfg-haptic-enabled") as HTMLInputElement | null;
          if (hapticSection && hapticToggle) {
            hapticSection.classList.remove("hidden");
            try { hapticToggle.checked = WandNative.isHapticEnabled(); } catch (_e) {}
            hapticToggle.addEventListener("change", function() {
              try { WandNative.setHapticEnabled(hapticToggle!.checked); } catch (_e) {}
              if (hapticToggle!.checked) _vibrate("medium");
            });
          }
        }
        var newSessBtn = document.getElementById("topbar-new-session-button");
        if (newSessBtn) newSessBtn.addEventListener("click", openSessionModal);
        var drawerNewSessBtn = document.getElementById("drawer-new-session-button");
        if (drawerNewSessBtn) drawerNewSessBtn.addEventListener("click", openSessionModal);
        var closeModalBtn = document.getElementById("close-modal-button");
        if (closeModalBtn) closeModalBtn.addEventListener("click", closeSessionModal);
        var closeWorktreeMergeBtn = document.getElementById("close-worktree-merge-button");
        if (closeWorktreeMergeBtn) closeWorktreeMergeBtn.addEventListener("click", closeWorktreeMergeModal);
        var worktreeMergeCancelBtn = document.getElementById("worktree-merge-cancel-button");
        if (worktreeMergeCancelBtn) worktreeMergeCancelBtn.addEventListener("click", closeWorktreeMergeModal);
        var worktreeMergeConfirmBtn = document.getElementById("worktree-merge-confirm-button");
        if (worktreeMergeConfirmBtn) worktreeMergeConfirmBtn.addEventListener("click", confirmWorktreeMerge);
        var runBtn = document.getElementById("run-button");
        if (runBtn) runBtn.addEventListener("click", runCommand);
        var approvePermissionBtn = document.getElementById("approve-permission-btn");
        if (approvePermissionBtn) approvePermissionBtn.addEventListener("click", approvePermission);
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
        var sessionModal = document.getElementById("session-modal");
        if (sessionModal) sessionModal.addEventListener("click", function(e) {
          if ((e.target as HTMLElement).id === "session-modal") closeSessionModal();
          if ((e.target as HTMLElement).id === "worktree-merge-modal") closeWorktreeMergeModal();
        });

        var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
        if (inputBox) {
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
          // INPUT-3: 交互模式 IME 组字承接。compositionstart 起置位标志让 input
          // handler 静默；compositionend 取最终组字结果发 PTY 并清空。非交互模式不
          // 介入，正常的中文聊天输入不受影响。
          inputBox.addEventListener("compositionstart", function() {
            if (state.terminalInteractive) state.terminalComposing = true;
          });
          inputBox.addEventListener("compositionend", function() {
            if (!state.terminalComposing) return;
            state.terminalComposing = false;
            if (state.terminalInteractive) handleInteractiveTextInput(inputBox!);
          });
          inputBox.addEventListener("focus", function() {
            // 只在手机 drawer 真的盖在输入区上面时才收起，避免 backdrop 挡点击。
            // 桌面 pinned/窄条形态下 drawer 是常驻并列布局，不会挡输入，调
            // closeSessionsDrawer 会把 sidebarPinned 一起清掉、侧栏整个不见。
            dismissDrawerIfOverlay();
            handleInputBoxFocus({ target: inputBox! });
          });
          inputBox.addEventListener("blur", handleInputBoxBlur);
        }

        // 加号 popover & 附件上传
        // attach-btn 现在是 popover 触发器；真正的"上传附件"动作在 popover 内的 #plus-attach-item 上。
        var attachBtn = document.getElementById("attach-btn");
        var fileInput = document.getElementById("file-upload-input") as HTMLInputElement | null;
        var plusPopover = document.getElementById("composer-plus-popover");
        var plusAttachItem = document.getElementById("plus-attach-item");
        if (attachBtn && plusPopover) {
          attachBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            togglePlusPopover();
          });
        }
        if (plusAttachItem && fileInput) {
          plusAttachItem.addEventListener("click", function() {
            closePlusPopover();
            fileInput!.click();
          });
        }
        if (fileInput) {
          fileInput.addEventListener("change", function() {
            var files = fileInput!.files;
            if (files) {
              for (var i = 0; i < files.length; i++) addPendingAttachment(files[i]);
            }
            fileInput!.value = "";
          });
        }

        // v2: 语音输入按钮 —— 点击切换语音模式。整组语音 UI（按住说话 + 退出按钮）
        // 都在 .voice-input-mode 容器里，CSS 由 .input-composer.voice-mode 控制显隐。
        var voiceBtn = document.getElementById("voice-btn");
        if (voiceBtn) {
          voiceBtn.addEventListener("click", function() { toggleVoiceMode(); });
        }
        var voiceCancelBtn = document.getElementById("voice-cancel-btn");
        if (voiceCancelBtn) {
          voiceCancelBtn.addEventListener("click", function() { toggleVoiceMode(false); });
        }
        // 按住说话 —— Pointer Events 统一鼠标/触摸：按住录音、上滑取消、松手填回。
        // 核心逻辑见模块级 startVoiceRecording / handleVoiceMove / stopVoiceRecording。
        var voiceRecordBtn = document.getElementById("voice-record-btn");
        if (voiceRecordBtn) {
          voiceRecordBtn.addEventListener("pointerdown", startVoiceRecording);
          voiceRecordBtn.addEventListener("pointermove", handleVoiceMove);
          voiceRecordBtn.addEventListener("pointerup", stopVoiceRecording);
          voiceRecordBtn.addEventListener("pointercancel", stopVoiceRecording);
        }

        var promptOptimizeBtn = document.getElementById("prompt-optimize-btn");
        if (promptOptimizeBtn) {
          promptOptimizeBtn.addEventListener("click", function() { optimizePromptText(); });
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
              for (var i = 0; i < files.length; i++) addPendingAttachment(files[i]);
            }
          });
        }

        // Terminal interactive toggle (both topbar and terminal-header)
        var terminalInteractiveToggles = ["terminal-interactive-toggle-top"];
        terminalInteractiveToggles.forEach(function(id) {
          var toggle = document.getElementById(id);
          if (toggle) toggle.addEventListener("click", toggleTerminalInteractive);
        });
        // File panel toggle
        var filePanelToggle = document.getElementById("file-panel-toggle-btn");
        if (filePanelToggle) filePanelToggle.addEventListener("click", toggleFilePanel);
        var filePanelClose = document.getElementById("file-side-panel-close");
        if (filePanelClose) filePanelClose.addEventListener("click", closeFilePanel);

        // File panel backdrop click to close (mobile)
        var filePanelBackdrop = document.getElementById("file-panel-backdrop");
        if (filePanelBackdrop) filePanelBackdrop.addEventListener("click", closeFilePanel);

        // Topbar: file button (mirrors toggleFilePanel)
        var topbarFileBtn = document.getElementById("topbar-file-button");
        if (topbarFileBtn) topbarFileBtn.addEventListener("click", toggleFilePanel);

        // Topbar: cwd click → open file panel
        var topbarCwdEl = document.getElementById("topbar-cwd");
        if (topbarCwdEl) {
          topbarCwdEl.addEventListener("click", function() {
            if (!state.filePanelOpen) toggleFilePanel();
          });
          topbarCwdEl.addEventListener("keydown", function(e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (!state.filePanelOpen) toggleFilePanel();
            }
          });
        }

        // Topbar: more menu
        var topbarMoreBtn = document.getElementById("topbar-more-button");
        var topbarMoreMenu = document.getElementById("topbar-more-menu");
        if (topbarMoreBtn && topbarMoreMenu) {
          topbarMoreBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            state.topbarMoreOpen = !state.topbarMoreOpen;
            topbarMoreMenu!.classList.toggle("hidden", !state.topbarMoreOpen);
            topbarMoreBtn!.classList.toggle("active", state.topbarMoreOpen);
            topbarMoreBtn!.setAttribute("aria-expanded", state.topbarMoreOpen ? "true" : "false");
          });
          topbarMoreMenu.addEventListener("click", function(e) {
            var btn = (e.target as HTMLElement) && (e.target as HTMLElement).closest ? (e.target as HTMLElement).closest(".topbar-more-item") : null;
            if (!btn) return;
            var action = btn.getAttribute("data-action");
            // Close menu first regardless of action
            state.topbarMoreOpen = false;
            topbarMoreMenu!.classList.add("hidden");
            topbarMoreBtn!.classList.remove("active");
            topbarMoreBtn!.setAttribute("aria-expanded", "false");
            switch (action) {
              case "copy-claude-session-id":
                var copyProvider = getSelectedSession() && getSelectedSession().provider;
                copySelectedSessionField("claudeSessionId", copyProvider === "codex" ? "Codex thread ID 已复制" : copyProvider === "opencode" ? "OpenCode session ID 已复制" : "Claude 会话 ID 已复制");
                break;
              case "copy-cwd":
                copySelectedSessionField("cwd", "工作目录已复制");
                break;
              case "copy-session-id":
                copySelectedSessionField("id", "会话 ID 已复制");
                break;
              case "worktree-merge":
                if (state.selectedId) openWorktreeMergeModal(state.selectedId);
                break;
              case "worktree-cleanup":
                if (state.selectedId) retryWorktreeCleanup(state.selectedId);
                break;
              case "delete-session":
                if (state.selectedId) {
                  (function(pendingId) {
                    confirmDelete("确定要删除当前会话吗？此操作无法撤销。", { title: "删除当前会话" })
                      .then(function(ok: any) { if (ok) deleteSession(pendingId); });
                  })(state.selectedId);
                }
                break;
            }
          });
        }

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
        var fileRefresh = document.getElementById("file-explorer-refresh");
        if (fileRefresh) fileRefresh.addEventListener("click", function() { refreshFileExplorer(); });
        var fileUp = document.getElementById("file-explorer-up");
        if (fileUp) fileUp.addEventListener("click", navigateExplorerUp);

        // 路径输入框：支持点击修改路径，回车跳转，Esc 撤销。
        var fileCwdInput = document.getElementById("file-explorer-cwd") as HTMLInputElement | null;
        if (fileCwdInput && fileCwdInput.tagName === "INPUT") {
          var lastCommittedCwd = fileCwdInput.value;
          var normalizeCwdInput = function(raw: string) {
            var s = (raw || "").trim();
            if (!s) return "";
            // 折叠重复斜杠，去掉尾随斜杠（根目录除外）。
            s = s.replace(/\/{2,}/g, "/");
            if (s.length > 1) s = s.replace(/\/+$/, "");
            return s;
          };
          fileCwdInput.addEventListener("focus", function() {
            lastCommittedCwd = fileCwdInput!.value;
            // Select all on focus so the user can immediately overwrite.
            setTimeout(function() {
              try { fileCwdInput!.select(); } catch (e) {}
            }, 0);
          });
          fileCwdInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter") {
              e.preventDefault();
              var next = normalizeCwdInput(fileCwdInput!.value);
              if (!next) return;
              lastCommittedCwd = next;
              fileCwdInput!.value = next;
              refreshFileExplorer({ cwd: next });
              fileCwdInput!.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              fileCwdInput!.value = lastCommittedCwd;
              fileCwdInput!.blur();
            }
          });
          fileCwdInput.addEventListener("blur", function() {
            var next = normalizeCwdInput(fileCwdInput!.value);
            if (!next) {
              fileCwdInput!.value = lastCommittedCwd;
              return;
            }
            if (next === lastCommittedCwd) {
              fileCwdInput!.value = next;
              return;
            }
            lastCommittedCwd = next;
            fileCwdInput!.value = next;
            refreshFileExplorer({ cwd: next });
          });
        }

        // File search
        var fileSearchInput = document.getElementById("file-search-input") as HTMLInputElement | null;
        var fileSearchClear = document.getElementById("file-search-clear");
        if (fileSearchInput) {
          fileSearchInput.addEventListener("input", function(e) {
            state.fileSearchQuery = (e.target as HTMLInputElement).value.trim();
            if (fileSearchClear) {
              fileSearchClear.classList.toggle("visible", state.fileSearchQuery.length > 0);
            }
            filterFileTree();
          });
        }
        if (fileSearchClear) {
          fileSearchClear.addEventListener("click", function() {
            state.fileSearchQuery = "";
            if (fileSearchInput) {
              fileSearchInput.value = "";
            }
            fileSearchClear!.classList.remove("visible");
          });
        }

        // Folder picker functionality with keyboard navigation
        var folderPickerInput = document.getElementById("folder-picker-input") as HTMLInputElement | null;
        var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
        var folderPickerDebounceTimer: any = null;
        var selectedIndex = -1;
        var folderItems: any[] = [];

        // Helper functions for path validation feedback
        function showValidationError(message: string) {
          if (folderPickerInput) {
            folderPickerInput.classList.add("invalid");
          }
          var validationEl = document.getElementById("folder-picker-validation");
          if (validationEl) {
            validationEl.textContent = message;
            validationEl.classList.add("visible");
          }
        }

        function clearValidationError() {
          if (folderPickerInput) {
            folderPickerInput.classList.remove("invalid");
          }
          var validationEl = document.getElementById("folder-picker-validation");
          if (validationEl) {
            validationEl.textContent = "";
            validationEl.classList.remove("visible");
          }
        }

        // Helper functions for recent paths (single source: backend API)
        // NOTE: fetchRecentPaths and addRecentPath are defined at outer scope

        function renderRecentPathsHtml(items: any[]) {
          if (!items.length) return "";
          var html = '<div class="folder-recent-section">' +
            '<div class="folder-recent-title">最近使用</div>';
          items.forEach(function(item) {
            var p = item.path || item;
            html += '<div class="folder-recent-item" data-path="' + escapeHtml(p) + '">' +
              renderTailMarqueePath(p, "folder-recent-item-path") +
            '</div>';
          });
          html += '</div>';
          return html;
        }

        function showRecentPathsDropdown() {
          if (!folderPickerDropdown) return;
          fetchRecentPaths(function(items: any[]) {
            var recentHtml = renderRecentPathsHtml(items);
            if (recentHtml) {
              folderPickerDropdown!.innerHTML = recentHtml;
              folderPickerDropdown!.classList.remove("hidden");
              refreshTailMarqueePaths(folderPickerDropdown);
              folderPickerDropdown!.querySelectorAll(".folder-recent-item").forEach(function(item: any) {
                item.addEventListener("click", function() {
                  var path = (this as HTMLElement).dataset.path;
                  if (folderPickerInput) {
                    folderPickerInput.value = path!;
                    saveWorkingDir(path!);
                    loadFolderSuggestions(path!);
                  }
                });
              });
            } else {
              hideFolderDropdown();
            }
          });
        }

        // Working directory indicator click handler for active sessions
        var workingDirIndicator = document.getElementById("working-dir-indicator");
        if (workingDirIndicator) {
          workingDirIndicator.addEventListener("click", function() {
            // 点击指示器时，取消当前会话选择，显示完整的目录选择器
            state.selectedId = null;
            persistSelectedId();
            state.drafts = {};
            render();
            // 聚焦到目录输入框
            setTimeout(function() {
              var folderInput = document.getElementById("folder-picker-input");
              if (folderInput) folderInput.focus();
            }, 50);
          });
        }

        // Compact folder picker toggle
        var folderPickerToggle = document.getElementById("folder-picker-toggle");
        var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
        if (folderPickerToggle && folderPickerDropdown) {
          folderPickerToggle.addEventListener("click", function() {
            folderPickerDropdown!.classList.toggle("hidden");
            folderPickerToggle!.classList.toggle("open");
          });
        }

        // Drag and drop support
        var folderPickerContainer = document.querySelector(".folder-picker-compact");
        if (folderPickerContainer) {
          folderPickerContainer.addEventListener("dragover", function(e) {
            e.preventDefault();
            e.stopPropagation();
            (this as HTMLElement).classList.add("drag-over");
          });

          folderPickerContainer.addEventListener("dragleave", function(e) {
            e.preventDefault();
            e.stopPropagation();
            (this as HTMLElement).classList.remove("drag-over");
          });

          folderPickerContainer.addEventListener("drop", function(e) {
            e.preventDefault();
            e.stopPropagation();
            (this as HTMLElement).classList.remove("drag-over");

            var items = (e as DragEvent).dataTransfer && (e as DragEvent).dataTransfer!.items;
            if (items) {
              for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item.kind === "file" && (item as any).webkitGetAsEntry) {
                  var entry = (item as any).webkitGetAsEntry();
                  if (entry && entry.isDirectory && folderPickerInput) {
                    var path = entry.fullPath;
                    folderPickerInput.value = path;
                    saveWorkingDir(path);
                    loadFolderSuggestions(path);
                    break;
                  }
                }
              }
            }
          });
        }

        // Quick path buttons (now inside dropdown)
        if (folderPickerDropdown) {
          folderPickerDropdown.addEventListener("click", function(e) {
            var btn = (e.target as HTMLElement).closest(".folder-picker-quick-btn");
            if (btn && folderPickerInput) {
              var path = (btn as HTMLElement).dataset.path;
              folderPickerInput.value = path!;
              saveWorkingDir(path!);
              loadFolderSuggestions(path!);
              folderPickerDropdown!.classList.add("hidden");
              var toggle = document.getElementById("folder-picker-toggle");
              if (toggle) toggle.classList.remove("open");
            }
          });
        }

        if (folderPickerInput) {
          // Load initial folders from saved or default path
          var initialPath = getEffectiveCwd();
          loadFolderSuggestions(initialPath);

          folderPickerInput.addEventListener("focus", function() {
            var path = (this as HTMLInputElement).value.trim();
            if (path) {
              loadFolderSuggestions(path);
            } else {
              // Show recent paths when input is empty
              showRecentPathsDropdown();
            }
          });

          folderPickerInput.addEventListener("input", function(e) {
            var query = (e.target as HTMLInputElement).value.trim();
            selectedIndex = -1;
            if (folderPickerDebounceTimer) clearTimeout(folderPickerDebounceTimer);
            folderPickerDebounceTimer = setTimeout(function() {
              if (query) {
                loadFolderSuggestions(query);
              } else {
                hideFolderDropdown();
              }
            }, 150);
          });

          // Keyboard navigation
          folderPickerInput.addEventListener("keydown", function(e) {
            if (e.key === "Escape") {
              hideFolderDropdown();
              (this as HTMLInputElement).blur();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (folderItems.length > 0) {
                selectedIndex = Math.min(selectedIndex + 1, folderItems.length - 1);
                updateSelectedIndex();
              }
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (selectedIndex > 0) {
                selectedIndex--;
                updateSelectedIndex();
              }
            } else if (e.key === "Enter" && selectedIndex >= 0) {
              e.preventDefault();
              var selectedItem = folderItems[selectedIndex];
              if (selectedItem) {
                var selectedPath = selectedItem.dataset.path;
                if (selectedPath === "..") {
                  // Navigate to parent
                  var currentPath = folderPickerInput!.value.trim();
                  var parentPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
                  if (parentPath) {
                    folderPickerInput!.value = parentPath || "/";
                    saveWorkingDir(folderPickerInput!.value);
                    loadFolderSuggestions(parentPath || "/");
                  }
                } else {
                  folderPickerInput!.value = selectedPath;
                  saveWorkingDir(selectedPath);
                  hideFolderDropdown();
                }
              }
            }
          });
        }

        function updateSelectedIndex() {
          folderItems.forEach(function(item: any, index: number) {
            item.classList.toggle("active", index === selectedIndex);
          });
        }

        function renderBreadcrumb(_path: string) {}

        function loadFolderSuggestions(query: string) {
          if (!folderPickerDropdown) return;

          // Show loading state
          folderPickerDropdown.innerHTML = '<div class="folder-picker-loading">加载中...</div>';
          folderPickerDropdown.classList.remove("hidden");
          selectedIndex = -1;
          folderItems = [];

          fetch("/api/folders?q=" + encodeURIComponent(query), { credentials: "same-origin" })
            .then(function(res) {
              return res.json().then(function(data: any) {
                return { ok: res.ok, status: res.status, data: data };
              });
            })
            .then(function(result) {
              var data = result.data;

              // Handle error responses
              if (!result.ok || data.error) {
                showValidationError(data.error || "路径无效");
                folderPickerDropdown!.innerHTML = '<div class="folder-picker-error">' + escapeHtml(data.error || "路径无效") + '</div>';
                return;
              }

              // Clear validation error on success
              clearValidationError();

              // Update breadcrumb navigation
              renderBreadcrumb(data.currentPath || query);

              var items = data.items || [];
              var currentPath = data.currentPath || query;

              if (items.length === 0) {
                folderPickerDropdown!.innerHTML = '<div class="folder-picker-loading">空目录</div>';
                return;
              }

              folderPickerDropdown!.innerHTML = items.map(function(item: any) {
                var icon = item.type === "parent" ? "↩️" : "📁";
                var name = item.type === "parent" ? ".. (返回上级)" : item.name;
                return '<div class="folder-picker-item" data-path="' + escapeHtml(item.path) + '" data-type="' + item.type + '">' +
                  '<span class="folder-picker-item-icon">' + icon + '</span>' +
                  '<span>' + escapeHtml(name) + '</span>' +
                '</div>';
              }).join("");

              folderItems = Array.from(folderPickerDropdown!.querySelectorAll(".folder-picker-item"));

              // Add click handlers
              folderItems.forEach(function(item: any) {
                item.addEventListener("click", function() {
                  var selectedPath = (this as HTMLElement).dataset.path;
                  var type = (this as HTMLElement).dataset.type;
                  if (folderPickerInput) {
                    if (type === "parent") {
                      // Navigate to parent directory
                      var currentPath = folderPickerInput.value.trim();
                      var parentPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
                      folderPickerInput.value = parentPath || "/";
                      saveWorkingDir(folderPickerInput.value);
                      loadFolderSuggestions(parentPath || "/");
                    } else {
                      folderPickerInput.value = selectedPath!;
                      saveWorkingDir(selectedPath!);
                      clearValidationError();
                      hideFolderDropdown();
                    }
                  }
                });
              });
            })
            .catch(function(err) {
              showValidationError("加载失败");
              folderPickerDropdown!.innerHTML = '<div class="folder-picker-error">加载失败</div>';
            });
        }

        function hideFolderDropdown() {
          if (folderPickerDropdown) {
            folderPickerDropdown.classList.add("hidden");
          }
          selectedIndex = -1;
          folderItems = [];
        }

        // Folder picker modal functionality
        var folderPickerModal = document.getElementById("folder-picker-modal");
        var closeFolderPicker = document.getElementById("close-folder-picker");

        function openFolderPickerWithInitialPath() {
          if (!folderPickerModal) return;
          folderPickerModal.classList.remove("hidden");
          // Set initial path in input
          if (folderPickerInput) {
            folderPickerInput.value = getEffectiveCwd();
          }
          // Load initial folders
          var initialPath = getEffectiveCwd();
          loadFolderSuggestions(initialPath);
          renderBreadcrumb(initialPath);
        }

        if (closeFolderPicker && folderPickerModal) {
          closeFolderPicker.addEventListener("click", function() {
            folderPickerModal!.classList.add("hidden");
          });
        }

        if (folderPickerModal) {
          folderPickerModal.addEventListener("click", function(e) {
            if (e.target === folderPickerModal) {
              folderPickerModal!.classList.add("hidden");
            }
          });
        }

        var topbarGitBadge = document.getElementById("topbar-git-badge");
        if (topbarGitBadge) {
          topbarGitBadge.addEventListener("click", function(e) {
            e.preventDefault();
            openQuickCommitModal();
          });
        }
        var quickCommitModal = document.getElementById("quick-commit-modal");
        if (quickCommitModal) {
          quickCommitModal.addEventListener("click", function(e) {
            if ((e.target as HTMLElement).id === "quick-commit-modal" && !state.quickCommitSubmitting) {
              closeQuickCommitModal();
            }
          });
        }
        attachQuickCommitModalListeners();

        initTerminal();
        setupMobileKeyboardHandlers();
        setupVisualViewportHandlers();

        // 排队条：每次 shell 重渲后，重新挂事件代理 + 刷新内容。
        attachQueueBarDelegates();
        updateQueueBar();
      }
