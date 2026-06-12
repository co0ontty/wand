import { state, readStoredBoolean, writeStoredBoolean, configPath } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml, formatElapsedShort } from "./utils";
import { ensureChatMessagesContainer, extractToolResultText, parseMessages, renderChat, scheduleChatRender, shortCommand } from "./chat-render";
import { bindChatScrollListener, clearStructuredQueuePersistence, getConfigCwd, normalizeStructuredSnapshot, persistSelectedId, restoreStructuredQueue, saveStructuredQueue, scrollChatToBottom, stripRenderOnlyStructuredMessages, syncStructuredQueueFromSession, updateChatUnreadBubble } from "./chat-scroll";
import { attachEventListeners } from "./events";
import { applyTerminalScale, isMobileLayout, refreshFileExplorer, setFilePanelOpen, shouldShowSessionsBackdrop, updateFilePanelCwd, updateLayoutState } from "./file-browser";
import { loadGitStatus, updateTopbarGitBadge, closeQuickCommitModal } from "./git-commit";
import { activateSession, autoResizeInput, buildMessagesForRender, canAutoResumeSession, captureTerminalInput, closeKeyboardPopup, closeSwipedItem, flushCrossSessionQueue, focusInputBox, getControlInput, hasActiveTerminalSelection, hideMiniKeyboard, queueDirectInput, reconcileInteractiveState, renderCrossSessionQueue, sendInputFromBox, setTerminalInteractive, shouldCaptureTerminalEvent, stopSession, switchToSessionView, updateInteractiveControls, updateStructuredQueueCounter, updateVoiceTranscript } from "./input";
import { _apkVersion, _getNativePermission, _hasNativeBridge, _macAppVersion, _syncWakeLock, _vibrate, clearSessionProgressNative, hideError, notifyTaskEnded, openWandDialog, performRestart, sendBrowserNotification, showError, showNotificationBubble, showRestartOverlay, showToast, tryPlayNotificationSound, wandAlert, wandConfirm, wandPrompt } from "./notifications";
import { bindForegroundSyncListeners, getEffectiveCwd, render, renderAppShell, resetChatRenderCache, updateOfflineBanner } from "./render";
import { ensureClaudeHistoryLoaded, ensureCodexHistoryLoaded, loadClaudeHistory, loadCodexHistory, renderSessions, renderSessionsListContent } from "./sidebar";
import { fetchRecentPaths, initTerminal, maybeScheduleResyncForChunk, maybeScrollTerminalToBottom, saveWorkingDir, scheduleSoftResyncTerminal, syncTerminalBuffer, wandTerminalWrite } from "./terminal";
import { computeRunningSignal, renderStructuredStatusBar, updateRunningIndicators } from "./utils";
import { ensureTerminalFit, ensureTerminalFitWithRetry, scheduleTerminalResize, teardownTerminal } from "./viewport";
import { forceReconnectWebSocket, initWebSocket, setView, startPolling, stopPolling, updateAutoApproveIndicator, updateTaskDisplay } from "./websocket";
import { getSessionKindHint, getSessionLatestUserText, getSessionStatusLabel } from "./session-ui";

      export function login() {
        if (state.loginPending) return;

        var passwordEl = document.getElementById("password") as HTMLInputElement | null;
        var loginButton = document.getElementById("login-button") as HTMLButtonElement | null;
        var errorEl = document.getElementById("login-error");
        if (!passwordEl || !loginButton || !errorEl) return;

        hideError(errorEl);
        passwordEl.dataset.error = "false";
        passwordEl.setAttribute("aria-invalid", "false");
        state.loginPending = true;
        loginButton.disabled = true;
        loginButton.textContent = "登录中...";

        fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: passwordEl.value }),
          credentials: "same-origin"
        })
        .then(function(res) {
          if (!res.ok) {
            passwordEl.dataset.error = "true";
            passwordEl.setAttribute("aria-invalid", "true");
            showError(errorEl, "密码错误，请重试。");
            return Promise.reject("Invalid password");
          }
          return fetch("/api/config", { credentials: "same-origin" });
        })
        .then(function(res) { return res.json(); })
        .then(function(config) {
          state.config = config;
          var statusDot = document.getElementById("status-dot");
          var statusText = document.getElementById("status-text");
          if (statusDot) statusDot.classList.add("active");
          if (statusText) statusText.textContent = "已登录";
          return refreshAll();
        })
        .then(function() {
          startPolling();
          render();
        })
        .catch(function(error) {
          console.error("[wand] Login error:", error);
          if (error !== "Invalid password") {
            passwordEl.dataset.error = "true";
            passwordEl.setAttribute("aria-invalid", "true");
            showError(errorEl, "登录失败，请重试。");
          }
        })
        .finally(function() {
          state.loginPending = false;
          loginButton.disabled = false;
          loginButton.textContent = "进入控制台";
        });
      }

      export function hasNativeSwitchServer() {
        return typeof WandNative !== "undefined" && typeof WandNative.switchServer === "function";
      }

      export function switchServer() {
        if (!hasNativeSwitchServer()) return;
        try { WandNative.switchServer(); } catch (e) {}
      }

      // 「返回 App 原生界面」只对带原生界面的壳开放：
      // - Android 新壳：WandNative.backToNative()（addJavascriptInterface 注入）
      // - iOS 新壳：user script 注入的 window.__wandBackToNative()
      // macOS 壳（纯 WebView、无原生界面）与普通浏览器都不命中。
      export function hasNativeBackToApp() {
        if (typeof WandNative !== "undefined" && typeof WandNative.backToNative === "function") return true;
        return typeof (window as any).__wandBackToNative === "function";
      }

      export function backToNativeApp() {
        try {
          if (typeof WandNative !== "undefined" && typeof WandNative.backToNative === "function") {
            WandNative.backToNative();
            return;
          }
          if (typeof (window as any).__wandBackToNative === "function") (window as any).__wandBackToNative();
        } catch (e) {}
      }

      export function logout() {
        fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(function() {});
        stopPolling();
        setTerminalInteractive(false);
        hideMiniKeyboard();
        teardownTerminal();
        state.config = null;
        state.selectedId = null;
        persistSelectedId();
        state.sessions = [];
        state.claudeHistory = [];
        state.claudeHistoryLoaded = false;
        state.claudeHistoryExpanded = false;
        state.claudeHistoryExpandedDirs = {};
        state.sessionsDrawerOpen = false;
        writeStoredBoolean("wand-sidebar-open", false);
        render();
      }

      export function refreshAll() {
        return loadSessions();
      }

      export function getModeLabel(mode) {
        return mode === "full-access"
          ? "全权限"
          : mode === "default"
            ? "默认"
            : mode === "native"
              ? "原生"
              : mode === "auto-edit"
                ? "自动编辑"
                : mode === "managed"
                  ? "托管"
                  : mode;
      }

      export function getPreferredTool() {
        return state.sessionTool || state.preferredCommand || "claude";
      }

      export function getComposerTool() {
        var selected = state.sessions.find(function(s) { return s.id === state.selectedId; });
        return (selected && selected.provider) || state.preferredCommand || "claude";
      }

      export function getComposerPlaceholder(session, terminalInteractive) {
        // Keep placeholders short so they don't wrap on portrait mobile screens.
        // Only show informative state hints; drop the redundant "send to X" labels.
        if (terminalInteractive) return "键盘输入将发送到终端";
        // 只有真正进入终止态（exited / failed / stopped）才提示"会话已结束"。
        // 结构化会话刚创建或一次回复结束后会回到 "idle"——那是等待下一条输入的
        // 正常状态，不应该被当成结束。
        if (session && (session.status === "exited" || session.status === "failed" || session.status === "stopped")) {
          if (canAutoResumeSession(session)) return "输入消息以继续会话";
          return "会话已结束";
        }
        // 结构化会话在出 token 时，输入框仍然可用——告诉用户默认行为是排队，
        // 想插队请按气泡上的 ⚡ 按钮。短语尽量短，避免在窄屏手机上换行。
        if (isStructuredSession(session) && session.structuredState && session.structuredState.inFlight) {
          return "回复中，可继续输入";
        }
        return "输入消息";
      }

      export function getToolModeHint(tool, mode) {
        if (tool === "codex") {
          return "Codex 支持 PTY 终端与结构化（JSONL）两种会话，结构化模式按 full-access 启动。";
        }
        if (mode === "full-access") {
          return "自动确认权限请求与高权限操作，适合你确认环境安全后的连续修改。";
        }
        if (mode === "auto-edit") {
          return "保留交互式会话，同时更偏向直接编辑代码。";
        }
        if (mode === "native") {
          return "调用 Claude 原生 API 输出，适合快速问答或一次性生成。";
        }
        if (mode === "managed") {
          return "AI 自动完成所有工作，无需中途确认，适合有明确目标的任务。";
        }
        return "保留标准交互流程，适合手动确认每一步。";
      }

      export function getSupportedModes(tool) {
        if (tool === "codex") {
          return ["full-access"];
        }
        return ["default", "full-access", "auto-edit", "native", "managed"];
      }

      export function getSafeModeForTool(tool, mode) {
        var supported = getSupportedModes(tool);
        if (supported.indexOf(mode) !== -1) return mode;
        var fallback = state.config && state.config.defaultMode ? state.config.defaultMode : "default";
        if (supported.indexOf(fallback) !== -1) return fallback;
        return supported[0];
      }

      export function renderModeOptions(tool, selectedMode) {
        return getSupportedModes(tool).map(function(mode) {
          var hint = getModeHint(mode);
          return '<option value="' + escapeHtml(mode) + '"' + (mode === selectedMode ? " selected" : "") + ' title="' + hint + '">' +
            escapeHtml(getModeLabel(mode)) +
          '</option>';
        }).join("");
      }

      export function getModeHint(mode) {
        var hints = {
          'default': '标准模式 - 需要确认文件修改',
          'full-access': '完全访问 - 自动确认权限与操作',
          'auto-edit': '自动编辑 - 自动确认文件修改',
          'native': '原生模式 - 返回结构化输出',
          'managed': '托管模式 - AI 自动完成所有工作'
        };
        return hints[mode] || '';
      }

      export function getSessionKindLabel(session) {
        var provider = session && session.provider ? session.provider : "claude";
        return (isStructuredSession(session) ? "结构化" : "终端") + " · " + provider;
      }

      export function getSessionKindDescription(session) {
        return isStructuredSession(session)
          ? "结构化 · 块级记录"
          : (session && session.provider === "codex"
            ? "终端 · Codex PTY（chat 为解析视图）"
            : "终端 · PTY 会话");
      }

      export function shouldRequestChatFormat(session) {
        if (!session) return false;
        return isStructuredSession(session) || session.provider === "codex";
      }

      export function isRecoverableToolError(toolResult, nextResult) {
        if (!toolResult || !toolResult.is_error || !nextResult || nextResult.is_error) {
          return false;
        }
        var currentText = extractToolResultText(toolResult.content).toLowerCase();
        var nextText = extractToolResultText(nextResult.content).toLowerCase();
        if (!currentText) return false;
        if (currentText.indexOf("invalid pages parameter") !== -1 && nextText.length > 0) {
          return true;
        }
        return false;
      }

      export function isStructuredSession(session) {
        return !!session && (session.sessionKind === "structured" || session.runner === "claude-cli-print");
      }

      export function syncComposerModeSelect() {
        // 旧 ID 形态（chat-mode-select / chat-mode-label）已下线 —— trio 现在多实例存在。
        // 这里只保留 state 归一化与 mode-hint 文本刷新；DOM 同步交给 refreshAllChatModeTrios。
        state.chatMode = getSafeModeForTool("claude", state.chatMode);
        var modeHint = document.getElementById("mode-hint");
        if (modeHint) modeHint.textContent = getModeHint(state.chatMode);
        refreshAllChatModeTrios();
      }

      // 三件套 raw 选项渲染：option 文本直接是 id（不带括号注释 / 不本地化）。
      // ── 三件套（模式 / 模型 / 思考深度）的统一渲染器 ──
      // 两个使用点：
      //   · 结构化会话空状态：作为下拉菜单出现在"对话已开始"提示下方，让用户在开聊前调整
      //   · 结构化会话用户消息：作为紧凑徽章挂在头像/名称的左侧，点击任一徽章可改"当前状态"
      // PTY 模式整体不展示（与按键透传无关）。两种 kind 共用一组 select，靠 data-mode-control
      // 属性绑定全局委托 change 事件，让所有 trio 实例的状态自动保持同步。
      export function renderChatModeTrioHtml(session, opts) {
        opts = opts || {};
        // 三种 kind：dropdown（空状态横向）/ compact（用户消息徽章）/ popover（加号气泡纵向）
        var kind = (opts.kind === "compact" || opts.kind === "popover") ? opts.kind : "dropdown";
        var preferredTool = getPreferredTool();
        var composerMode = state.chatMode || "default";
        var modelText = getEffectiveModel(session) || "default";
        var thinkingText = getEffectiveThinking(session);
        function pill(ctrl, label, value, optionsHtml) {
          // compact 不显示分组小标签；dropdown / popover 都显示（"模式" / "模型" / "思考"）。
          var tagHtml = kind === "compact" ? "" : ('<span class="chat-mode-trio-tag">' + escapeHtml(label) + '</span>');
          return '<span class="composer-text-pill chat-mode-trio-pill" data-mode-control-pill="' + ctrl + '" title="' + escapeHtml(label) + '">' +
            tagHtml +
            '<span class="composer-text-label">' + escapeHtml(value) + '</span>' +
            '<select class="composer-text-hidden-select" data-mode-control="' + ctrl + '" tabindex="-1" aria-label="' + escapeHtml(label) + '">' +
              optionsHtml +
            '</select>' +
          '</span>';
        }
        return '<div class="chat-mode-trio chat-mode-trio-' + kind + '" role="group" aria-label="会话设置">' +
          pill("mode", "模式", composerMode, renderChatModeOptionsRaw(preferredTool, composerMode)) +
          '<span class="composer-text-sep" aria-hidden="true">·</span>' +
          pill("model", "模型", modelText, renderChatModelOptionsRaw(modelText, session)) +
          '<span class="composer-text-sep" aria-hidden="true">·</span>' +
          pill("thinking", "思考", thinkingText, renderChatThinkingOptionsRaw(thinkingText)) +
        '</div>';
      }

      // 改完任何一处 trio 的 select 后，把所有 trio 实例的 label / select.value 同步刷新。
      // 同时重建 model select 的 options，保证异步 fetchAvailableModels 到达后选项列表完整。
      export function refreshAllChatModeTrios() {
        var session = getSelectedSession();
        var preferredTool = getPreferredTool();
        var mode = state.chatMode || "default";
        var model = getEffectiveModel(session) || "default";
        var thinking = getEffectiveThinking(session);
        var trios = document.querySelectorAll(".chat-mode-trio");
        trios.forEach(function(trio) {
          function setPair(ctrl, value, optionsHtml) {
            var pillNode = trio.querySelector('[data-mode-control-pill="' + ctrl + '"]');
            if (!pillNode) return;
            var label = pillNode.querySelector(".composer-text-label");
            if (label) label.textContent = value;
            var sel = pillNode.querySelector('[data-mode-control="' + ctrl + '"]') as HTMLSelectElement | null;
            if (!sel) return;
            if (optionsHtml) sel.innerHTML = optionsHtml;
            if (sel.value !== value) sel.value = value;
          }
          setPair("mode", mode, renderChatModeOptionsRaw(preferredTool, mode));
          setPair("model", model, renderChatModelOptionsRaw(model, session));
          setPair("thinking", thinking, renderChatThinkingOptionsRaw(thinking));
        });
      }

      export function renderChatModeOptionsRaw(tool, selectedMode) {
        return getSupportedModes(tool).map(function(mode) {
          return '<option value="' + escapeHtml(mode) + '"' + (mode === selectedMode ? " selected" : "") + '>' +
            escapeHtml(mode) +
          '</option>';
        }).join("");
      }

      export function getEffectiveModel(session) {
        if (session && session.selectedModel) return session.selectedModel;
        if (state.chatModel) return state.chatModel;
        if (state.config && state.config.defaultModel) return state.config.defaultModel;
        return "";
      }

      export function getModelsForCurrentProvider(session) {
        var provider = (session && session.provider) || state.sessionTool || "claude";
        if (provider === "codex") return state.availableCodexModels || [];
        return state.availableModels || [];
      }

      export function renderChatModelOptions(selected, session) {
        var models = getModelsForCurrentProvider(session);
        var html = '<option value="">默认（跟随设置）</option>';
        for (var i = 0; i < models.length; i++) {
          var m = models[i];
          var label = m.label || m.id;
          html += '<option value="' + escapeHtml(m.id) + '"' + (m.id === selected ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
        }
        if (selected && !models.some(function(m) { return m.id === selected; })) {
          html += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + '（自定义）</option>';
        }
        return html;
      }

      // model 选项 raw 版：空值显示 "default"，其它直接用 raw id（不带"（自定义）"等后缀）。
      export function renderChatModelOptionsRaw(selected, session) {
        var models = getModelsForCurrentProvider(session);
        var html = '<option value="">default</option>';
        for (var i = 0; i < models.length; i++) {
          var m = models[i];
          html += '<option value="' + escapeHtml(m.id) + '"' + (m.id === selected ? " selected" : "") + '>' + escapeHtml(m.id) + '</option>';
        }
        if (selected && !models.some(function(m) { return m.id === selected; })) {
          html += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + '</option>';
        }
        return html;
      }

      export function syncComposerModelSelect(session) {
        // 旧 ID 形态已下线；trio 多实例由 refreshAllChatModeTrios 同步刷新。
        // thinking / model 同属会话级设置，refresh 一次就把所有三件套统一对齐。
        refreshAllChatModeTrios();
      }

      // ── 思考深度 (thinkingEffort) —— 与 model 选择三件套对称 ──

      // 标签直接用 Claude CLI 原生 magic word：think / think hard / ultrathink。
      // 这样用户一眼能对上官方文档里的思考强度档位，PTY 模式下也是这几个词被注入到 prompt 前缀。
      export var THINKING_LEVELS = [
        { id: "off",      label: "off",        hint: "不启用思考（CLI 无前缀；SDK 关闭 thinking；Codex minimal）" },
        { id: "standard", label: "think",      hint: "Claude CLI: think · SDK budget 4096 · Codex low" },
        { id: "deep",     label: "think hard", hint: "Claude CLI: think hard · SDK budget 16000 · Codex medium" },
        { id: "max",      label: "ultrathink", hint: "Claude CLI: ultrathink · SDK budget 31999 · Codex high" }
      ];

      export function getThinkingLabel(id) {
        for (var i = 0; i < THINKING_LEVELS.length; i++) {
          if (THINKING_LEVELS[i].id === id) return THINKING_LEVELS[i].label;
        }
        return THINKING_LEVELS[0].label;
      }

      export function getEffectiveThinking(session) {
        if (session && session.thinkingEffort) return session.thinkingEffort;
        if (state.chatThinking) return state.chatThinking;
        return "off";
      }

      export function renderChatThinkingOptions(selected) {
        var v = selected || "off";
        var html = "";
        for (var i = 0; i < THINKING_LEVELS.length; i++) {
          var lvl = THINKING_LEVELS[i];
          html += '<option value="' + escapeHtml(lvl.id) + '"' + (lvl.id === v ? ' selected' : '') + ' title="' + escapeHtml(lvl.hint) + '">' + escapeHtml(lvl.label) + '</option>';
        }
        return html;
      }

      // thinking 选项 raw 版：option 文本直接是 id（off / standard / deep / max）。
      export function renderChatThinkingOptionsRaw(selected) {
        var v = selected || "off";
        var html = "";
        for (var i = 0; i < THINKING_LEVELS.length; i++) {
          var lvl = THINKING_LEVELS[i];
          html += '<option value="' + escapeHtml(lvl.id) + '"' + (lvl.id === v ? ' selected' : '') + '>' + escapeHtml(lvl.id) + '</option>';
        }
        return html;
      }

      export function syncComposerThinkingSelect(session) {
        // 旧 ID 形态已下线；trio 多实例由 refreshAllChatModeTrios 同步刷新。
        refreshAllChatModeTrios();
      }

      export function onChatThinkingChange(value) {
        var normalized = (value || "off").trim();
        if (normalized !== "off" && normalized !== "standard" && normalized !== "deep" && normalized !== "max") {
          normalized = "off";
        }
        state.chatThinking = normalized;
        try { localStorage.setItem("wand-thinking-effort", normalized); } catch (e) {}
        refreshAllChatModeTrios();
        var session = getSelectedSession();
        if (!session) return;
        fetch("/api/sessions/" + encodeURIComponent(session.id) + "/thinking-effort", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ thinkingEffort: normalized })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data && data.error) {
            showToast(data.error, "error");
            return;
          }
          if (data && data.id) {
            updateSessionSnapshot(data);
            if (typeof showToast === "function") {
              showToast("已切换思考深度 → " + getThinkingLabel(normalized), "success");
            }
          }
        })
        .catch(function() { showToast("切换思考深度失败", "error"); });
      }

      // 自动批准 chip：与原 .auto-approve-indicator 等价，但用统一的 .composer-pill 风格放主行。
      // Codex 会话固定全权限不可切；结构化 Claude 会话后端 toggle-auto-approve 路由会拒绝。
      // 当会话已经处于 managed / full-access 模式时，"自动批准"语义已经由模式表达，
      // 重复显示一个独立 chip 只会占用空间又制造歧义 —— 此时直接折叠掉。
      export function isAutoApproveImpliedByMode(session) {
        if (!session) return false;
        var m = session.mode;
        return m === "managed" || m === "full-access";
      }
      export function renderAutoApproveChip(session) {
        if (!session) return "";
        if (isAutoApproveImpliedByMode(session)) return "";
        var enabled = !!session.autoApprovePermissions;
        return enabled
          ? '<span id="auto-approve-toggle" class="composer-pill composer-pill-chip auto-approve-indicator active" title="自动批准已启用 — 点击关闭">' + iconSvg("shieldCheck", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">自动</span></span>'
          : '<span id="auto-approve-toggle" class="composer-pill composer-pill-chip auto-approve-indicator" title="自动批准已关闭 — 点击开启">' + iconSvg("shield", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">手动</span></span>';
      }

      export function fetchAvailableModels() {
        return fetch("/api/models", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && Array.isArray(data.models)) {
              state.availableModels = data.models;
              state.availableCodexModels = Array.isArray(data.codexModels) ? data.codexModels : [];
              syncComposerModelSelect(getSelectedSession());
              updateSettingsDefaultModelSelect(data);
            }
            return data;
          })
          .catch(function() { return null; });
      }

      export function refreshAvailableModels() {
        if (state.modelsRefreshing) return Promise.resolve(null);
        state.modelsRefreshing = true;
        var btn = document.getElementById("cfg-default-model-refresh") as HTMLButtonElement | null;
        if (btn) { btn.disabled = true; btn.textContent = "刷新中..."; }
        return fetch("/api/models/refresh", { method: "POST", credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && Array.isArray(data.models)) {
              state.availableModels = data.models;
              state.availableCodexModels = Array.isArray(data.codexModels) ? data.codexModels : [];
              syncComposerModelSelect(getSelectedSession());
              updateSettingsDefaultModelSelect(data);
              if (typeof showToast === "function") {
                showToast("模型列表已刷新" + (data.claudeVersion ? "（claude " + data.claudeVersion + "）" : ""), "success");
              }
            }
            return data;
          })
          .catch(function() {
            if (typeof showToast === "function") showToast("刷新模型列表失败", "error");
            return null;
          })
          .finally(function() {
            state.modelsRefreshing = false;
            if (btn) { btn.disabled = false; btn.textContent = "刷新"; }
          });
      }

      // ── Environment-variable preview modal ──

      // Lazily creates a modal showing the exact env vars wand will inject
      // into PTY / structured child processes (mirrors buildChildEnv()).
      export function openEnvPreviewModal() {
        var modal = document.getElementById("env-preview-modal");
        if (!modal) {
          modal = document.createElement("section");
          modal.id = "env-preview-modal";
          modal.className = "modal-backdrop hidden";
          modal.innerHTML =
            '<div class="modal env-preview-modal" role="dialog" aria-labelledby="env-preview-title" aria-modal="true">' +
              '<div class="modal-header">' +
                '<div>' +
                  '<h2 class="modal-title" id="env-preview-title">将注入子进程的环境变量</h2>' +
                  '<p class="modal-subtitle" id="env-preview-subtitle">这些变量会被传给 claude / codex（PTY 与结构化运行器一致）。</p>' +
                '</div>' +
                '<button id="env-preview-close" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭">' +
                  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
                    '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>' +
                  '</svg>' +
                '</button>' +
              '</div>' +
              '<div class="modal-body env-preview-body">' +
                '<div class="env-preview-toolbar">' +
                  '<div class="env-preview-meta" id="env-preview-meta">加载中…</div>' +
                  '<div class="env-preview-controls">' +
                    '<input id="env-preview-search" class="env-preview-search" type="search" placeholder="搜索变量名…" />' +
                    '<label class="env-preview-reveal">' +
                      '<input id="env-preview-reveal-toggle" type="checkbox" />' +
                      '<span>显示敏感值</span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div class="env-preview-list" id="env-preview-list" tabindex="0">' +
                  '<div class="env-preview-loading">加载中…</div>' +
                '</div>' +
              '</div>' +
              '<div class="modal-footer env-preview-footer">' +
                '<span class="env-preview-hint">敏感字段（含 KEY/TOKEN/SECRET 等）默认掩码，可勾选「显示敏感值」临时还原。</span>' +
                '<button id="env-preview-close-2" class="btn btn-secondary btn-sm" type="button">关闭</button>' +
              '</div>' +
            '</div>';
          document.body.appendChild(modal);

          // Click outside to close
          modal.addEventListener("click", function(e) {
            if (e.target === modal) closeEnvPreviewModal();
          });
          var closeBtn = modal.querySelector("#env-preview-close");
          if (closeBtn) closeBtn.addEventListener("click", closeEnvPreviewModal);
          var closeBtn2 = modal.querySelector("#env-preview-close-2");
          if (closeBtn2) closeBtn2.addEventListener("click", closeEnvPreviewModal);
          var searchEl = modal.querySelector("#env-preview-search") as HTMLInputElement | null;
          if (searchEl) searchEl.addEventListener("input", function() { renderEnvPreviewList(); });
          var revealEl = modal.querySelector("#env-preview-reveal-toggle") as HTMLInputElement | null;
          if (revealEl) revealEl.addEventListener("change", function() { loadEnvPreview(revealEl.checked); });
        }

        modal.classList.remove("closing");
        modal.classList.remove("hidden");
        var revealEl = modal.querySelector("#env-preview-reveal-toggle") as HTMLInputElement | null;
        if (revealEl) revealEl.checked = false;
        var searchEl = modal.querySelector("#env-preview-search") as HTMLInputElement | null;
        if (searchEl) searchEl.value = "";
        loadEnvPreview(false);
      }

      export function closeEnvPreviewModal() {
        var modal = document.getElementById("env-preview-modal");
        if (!modal) return;
        animateModalClose(modal);
      }

      export function loadEnvPreview(reveal) {
        var listEl = document.getElementById("env-preview-list");
        var metaEl = document.getElementById("env-preview-meta");
        if (listEl) listEl.innerHTML = '<div class="env-preview-loading">加载中…</div>';
        if (metaEl) metaEl.textContent = "加载中…";
        var url = "/api/settings/env-preview" + (reveal ? "?reveal=1" : "");
        fetch(url, { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (!data || !Array.isArray(data.entries)) {
              if (listEl) listEl.innerHTML = '<div class="env-preview-empty">读取失败。</div>';
              if (metaEl) metaEl.textContent = "读取失败";
              return;
            }
            state._envPreview = data;
            if (metaEl) {
              var inheritLabel = data.inheritEnv ? "继承父进程" : "最小白名单";
              metaEl.innerHTML =
                '<span class="env-preview-pill ' + (data.inheritEnv ? "is-inherit" : "is-minimal") + '">' + inheritLabel + '</span>' +
                '<span class="env-preview-count">共 ' + data.total + ' 项</span>';
            }
            renderEnvPreviewList();
          })
          .catch(function() {
            if (listEl) listEl.innerHTML = '<div class="env-preview-empty">读取失败，请稍后重试。</div>';
            if (metaEl) metaEl.textContent = "读取失败";
          });
      }

      export function renderEnvPreviewList() {
        var listEl = document.getElementById("env-preview-list");
        if (!listEl) return;
        var data = state._envPreview;
        if (!data || !Array.isArray(data.entries)) {
          listEl.innerHTML = '<div class="env-preview-empty">尚未加载。</div>';
          return;
        }
        var searchEl = document.getElementById("env-preview-search") as HTMLInputElement | null;
        var query = (searchEl && searchEl.value || "").trim().toLowerCase();
        var html = "";
        var shown = 0;
        for (var i = 0; i < data.entries.length; i++) {
          var entry = data.entries[i];
          if (query && entry.name.toLowerCase().indexOf(query) === -1) continue;
          shown++;
          var isPlaceholder = typeof entry.value === "string" && entry.value.charAt(0) === "<" && entry.value.charAt(entry.value.length - 1) === ">";
          html += '<div class="env-preview-row' + (entry.sensitive ? " is-sensitive" : "") + '">' +
            '<div class="env-preview-name">' +
              escapeHtml(entry.name) +
              (entry.sensitive ? '<span class="env-preview-badge" title="被识别为敏感字段">敏感</span>' : '') +
              (isPlaceholder ? '<span class="env-preview-badge env-preview-badge-runtime" title="按会话动态注入">运行时</span>' : '') +
            '</div>' +
            '<div class="env-preview-value' + (isPlaceholder ? " is-runtime" : "") + '" title="' + escapeHtml(String(entry.value)) + '">' +
              escapeHtml(String(entry.value)) +
            '</div>' +
            '<div class="env-preview-len">' + entry.length + ' 字符</div>' +
          '</div>';
        }
        if (shown === 0) {
          html = '<div class="env-preview-empty">没有匹配的变量。</div>';
        }
        listEl.innerHTML = html;
      }

      export function updateSettingsDefaultModelSelect(data?) {
        var select = document.getElementById("cfg-default-model") as HTMLSelectElement | null;
        if (!select) return;
        var previous = select.value;
        var current = previous || state.configDefaultModel || (state.config && state.config.defaultModel) || "";
        select.innerHTML = renderChatModelOptions(current, { provider: "claude" });
        select.value = current;
        var versionEl = document.getElementById("cfg-default-model-version");
        if (versionEl && data) {
          versionEl.textContent = data.claudeVersion ? "已检测到 claude " + data.claudeVersion : "新建会话时默认使用该模型。";
        }
      }

      export function getSelectedSession() {
        if (!state.selectedId) return null;
        for (var i = 0; i < state.sessions.length; i++) {
          if (state.sessions[i].id === state.selectedId) return state.sessions[i];
        }
        return null;
      }

      export function onChatModelChange(value) {
        var normalized = (value || "").trim();
        state.chatModel = normalized;
        try { localStorage.setItem("wand-chat-model", normalized); } catch (e) {}
        refreshAllChatModeTrios();
        var session = getSelectedSession();
        if (!session) return;
        fetch("/api/sessions/" + encodeURIComponent(session.id) + "/model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ model: normalized || null })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data && data.error) {
            showToast(data.error, "error");
            return;
          }
          if (data && data.id) {
            updateSessionSnapshot(data);
            if (typeof showToast === "function") {
              var display = normalized || "默认";
              var hint = session.provider === "codex" ? "（下次对话生效）" : "";
              showToast("已切换模型 → " + display + hint, "success");
            }
          }
        })
        .catch(function() { showToast("切换模型失败", "error"); });
      }

      export function createStructuredSession(prompt?, cwdOverride?, modeOverride?, worktreeEnabled?) {
        var provider = state.sessionTool === "codex" ? "codex" : "claude";
        var modelPref = state.chatModel || (state.config && state.config.defaultModel) || "";
        var thinkingPref = state.chatThinking || "off";
        var payload = {
          cwd: cwdOverride || getEffectiveCwd(),
          mode: modeOverride || state.chatMode || (state.config && state.config.defaultMode) || "default",
          provider: provider,
          runner: provider === "codex" ? "codex-cli-exec" : ((state.config && state.config.structuredRunner === "sdk") ? "claude-sdk" : (state.structuredRunner || "claude-cli-print")),
          prompt: prompt || undefined,
          worktreeEnabled: worktreeEnabled === true,
          model: modelPref || undefined,
          thinkingEffort: thinkingPref
        };
        return fetch("/api/structured-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload)
        })
        .then(function(res) {
          return res.json();
        })
        .then(function(data) {
          if (data.error) {
            throw new Error(data.error);
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          resetChatRenderCache();
          updateSessionSnapshot(data);
          updateSessionsList();
          switchToSessionView(data.id);
          subscribeToSession(data.id);
          return loadOutput(data.id).then(function() { return data; });
        });
      }

      export function applyCurrentView() {
        var hasSession = !!state.selectedId;
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var blankChat = document.getElementById("blank-chat");
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var structured = isStructuredSession(selectedSession);
        var showTerminal = hasSession && !structured && state.currentView === "terminal";
        var showChat = hasSession && (structured || state.currentView !== "terminal");
        if (structured) {
          state.currentView = "chat";
        } else if (!hasSession) {
          state.currentView = "terminal";
        }

        if (terminalContainer) {
          terminalContainer.classList.toggle("active", showTerminal);
          terminalContainer.classList.toggle("hidden", !showTerminal);
        }
        if (chatContainer) {
          chatContainer.classList.toggle("active", showChat);
          chatContainer.classList.toggle("hidden", !showChat);
        }
        // blank-chat 的可见性由 applyCurrentView 收口：updateShellChrome 在
        // selectedSession 缺失（启动期 selectedId 已恢复但 /api/sessions 未回 /
        // activateSession 在 updateSessionSnapshot 之前调 switchToSessionView 等
        // 瞬态）时会走 else 分支把 blank-chat 显示出来，但紧接着调到这里，应
        // 以 hasSession 为准重新隐藏，避免与 terminal/chat 同屏并存。
        if (blankChat) {
          blankChat.classList.toggle("hidden", hasSession);
        }
        if (chatContainer && showChat) {
          ensureChatMessagesContainer(chatContainer);
        }
        bindChatScrollListener();
        updateChatUnreadBubble();
        updateInteractiveControls();
      }

      export function syncSessionModalUI() {
        var modeHint = document.getElementById("mode-description");
        var kindHint = document.getElementById("session-kind-description");
        var tool = state.sessionTool || "claude";
        var sessionKind = state.sessionCreateKind || "structured";

        state.sessionTool = tool;
        state.modeValue = getSafeModeForTool(tool, state.modeValue || state.chatMode || "default");

        var providerCards = document.querySelectorAll("#provider-cards .provider-card");
        if (providerCards.length) {
          providerCards.forEach(function(card) {
            var provider = card.getAttribute("data-provider");
            card.classList.toggle("active", provider === tool);
            card.classList.remove("disabled");
          });
        }

        var kindCards = document.querySelectorAll("#session-kind-cards .session-kind-card");
        if (kindCards.length) {
          kindCards.forEach(function(card) {
            var kind = card.getAttribute("data-session-kind");
            var disabled = false;
            card.classList.toggle("active", kind === sessionKind);
            card.classList.toggle("disabled", disabled);
          });
        }

        var modeCards = document.querySelectorAll("#mode-cards .mode-card");
        if (modeCards.length) {
          modeCards.forEach(function(card) {
            card.classList.toggle("active", card.getAttribute("data-mode") === state.modeValue);
          });
        }

        if (kindHint) kindHint.textContent = getSessionKindHint(sessionKind);
        if (modeHint) modeHint.textContent = getToolModeHint(tool, state.modeValue);
      }

      export function updateSessionSnapshot(snapshot) {
        if (!snapshot || !snapshot.id) return;
        var currentSession = state.sessions.find(function(session) { return session.id === snapshot.id; }) || null;
        var normalizedSnapshot = normalizeStructuredSnapshot(snapshot, currentSession);
        var updated = false;
        var prevSession = null;
        state.sessions = state.sessions.map(function(session) {
          if (session.id !== normalizedSnapshot.id) return session;
          prevSession = session;
          updated = true;
          return Object.assign({}, session, normalizedSnapshot);
        });
        if (!updated) {
          state.sessions.unshift(normalizedSnapshot);
        }
        var updatedSession = state.sessions.find(function(session) { return session.id === normalizedSnapshot.id; }) || normalizedSnapshot;
        if (updatedSession && Array.isArray(updatedSession.queuedMessages) && normalizedSnapshot.id === state.selectedId) {
          syncStructuredQueueFromSession(updatedSession);
          saveStructuredQueue();
          updateStructuredQueueCounter();
        }
        if (normalizedSnapshot.id === state.selectedId) {
          reconcileInteractiveState();
          updateTaskDisplay();
          // Escalation/permission toggles are the common trigger for CSI cursor-jump
          // redraw sequences from Claude CLI. When they appear or dismiss, schedule a
          // debounced terminal resync so residual DOM rows get cleaned up automatically
          // — same fix the user used to have to reach for via the refresh button.
          // R2 策略 A：移除 permissionBlocked / pendingEscalation 翻转触发的
          // softResync。原本是为了"权限菜单消失后清掉残留 DOM 行"，但 softResync
          // 全量重放在 fresh buffer 上会把 Claude 用相对位移画的菜单帧顺序堆叠
          // （截图 2 的根因之一）。NEW-A（CSI ?2026 同步输出缓冲）已经把菜单帧
          // 渲染原子化，R6（wandTerminalWrite 内的 maybeScheduleResyncForChunk）
          // 在出现原地重绘序列时兜底。这条翻转触发现在是多余且有害的，已移除。
        }
        // When a session transitions to a non-running state, try flushing cross-session queue
        if (normalizedSnapshot.status && normalizedSnapshot.status !== "running" && state.crossSessionQueue.length > 0) {
          // Use setTimeout(0) to let the current event processing complete first
          setTimeout(flushCrossSessionQueue, 0);
        }
      }

      export function subscribeToSession(sessionId) {
        if (!sessionId || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        state.ws.send(JSON.stringify({ type: "subscribe", sessionId: sessionId }));
      }

      export function mergeServerSession(localSession, serverSession) {
        if (!localSession) return serverSession;

        var merged = Object.assign({}, localSession, serverSession);
        var localOutput = localSession.output || "";
        var serverOutput = serverSession.output || "";
        var keepLocalOutput = localOutput.length > serverOutput.length;
        var localStructuredState = localSession.structuredState || null;
        var serverStructuredState = serverSession.structuredState || null;
        var structuredSession = (localSession.sessionKind === "structured") || (serverSession.sessionKind === "structured");
        var localHasPendingAssistant = !!(localSession.messages && localSession.messages.length && (function() {
          var last = localSession.messages[localSession.messages.length - 1];
          return last && last.role === "assistant" && Array.isArray(last.content) && last.content.some(function(block) {
            return block && block.__processing;
          });
        })());
        var localMessages = Array.isArray(localSession.messages)
          ? (structuredSession ? stripRenderOnlyStructuredMessages(localSession.messages) : localSession.messages)
          : [];
        var serverMessages = Array.isArray(serverSession.messages)
          ? (structuredSession ? stripRenderOnlyStructuredMessages(serverSession.messages) : serverSession.messages)
          : [];
        // 服务端已经返回了完整的 assistant 回复（非 __processing 占位）时，
        // 不应再保留本地的 inFlight=true 状态，否则用户会看到"思考中"转圈永远不停。
        var serverHasCompletedAssistant = serverMessages.length > 0 && (function() {
          var last = serverMessages[serverMessages.length - 1];
          return last && last.role === "assistant" && Array.isArray(last.content)
            && !last.content.some(function(b) { return b && b.__processing; });
        })();
        var preserveLocalStructuredProgress = (localSession.sessionKind === "structured")
          && !!localStructuredState
          && localStructuredState.inFlight === true
          && (!serverStructuredState || serverStructuredState.inFlight !== true)
          && localHasPendingAssistant
          && !!localStructuredState.activeRequestId
          && !!serverStructuredState && !!serverStructuredState.activeRequestId
          && serverStructuredState.activeRequestId === localStructuredState.activeRequestId
          && !serverHasCompletedAssistant;
        var preserveLocalMessages = localMessages.length > serverMessages.length
          || (localMessages.length > 0 && serverMessages.length > 0
            && JSON.stringify(localMessages[localMessages.length - 1]) !== JSON.stringify(serverMessages[serverMessages.length - 1])
            && JSON.stringify(localMessages).length > JSON.stringify(serverMessages).length);

        if (keepLocalOutput) {
          merged.output = localOutput;
        }

        if (preserveLocalStructuredProgress) {
          merged.status = localSession.status || merged.status;
          merged.structuredState = Object.assign({}, serverStructuredState || {}, localStructuredState, { inFlight: true });
          merged.messages = localSession.messages;
        }

        if (preserveLocalMessages) {
          merged.messages = localMessages;
        }

        if (localSession.id === state.selectedId) {
          if (localSession.permissionBlocked && serverSession.permissionBlocked === false) {
          } else if (localSession.permissionBlocked && !serverSession.permissionBlocked) {
            merged.permissionBlocked = true;
          }

          if (localSession.pendingEscalation && !serverSession.pendingEscalation && serverSession.permissionBlocked !== false) {
            merged.pendingEscalation = localSession.pendingEscalation;
          }

          if (localSession.messages && localSession.messages.length > 0 && (!serverSession.messages || serverSession.messages.length === 0)) {
            merged.messages = localSession.messages;
          }
        }

        return merged;
      }

      export function getPreferredMessages(session, fallbackOutput, allowFallback) {
        if (session && session.messages && session.messages.length > 0) {
          return session.messages;
        }
        if (session && session.sessionKind === "structured") {
          return [];
        }
        if (!allowFallback) {
          return [];
        }
        var output = typeof fallbackOutput === "string"
          ? fallbackOutput
          : (session && session.output) || "";
        if (!output) {
          return [];
        }
        return parseMessages(output, session && session.command);
      }

      export function getPreferredSessionId(sessions) {
        if (!sessions || !sessions.length) return null;
        if (state.selectedId) {
          var stillExists = sessions.find(function(session) { return session.id === state.selectedId; });
          if (stillExists) return stillExists.id;
          return null;
        }
        var runningSession = sessions.find(function(session) { return session.status === "running"; });
        if (runningSession) return runningSession.id;
        var recent = sessions.find(function(session) { return !session.archived; });
        return recent ? recent.id : sessions[0].id;
      }

      export function loadSessions(options?) {
        var opts = options || {};
        return fetch("/api/sessions", { credentials: "same-origin" })
          .then(function(res) {
            if (res.status === 401) {
              logout();
              return;
            }
            return res.json();
          })
          .then(function(sessions) {
            var serverSessions = sessions || [];
            var sessionIds = new Set(serverSessions.map(function(s) { return s.id; }));

            Object.keys(state.drafts).forEach(function(id) {
              if (!sessionIds.has(id)) delete state.drafts[id];
            });

            state.sessions = serverSessions.map(function(serverSession) {
              var localSession = state.sessions.find(function(s) { return s.id === serverSession.id; });
              return mergeServerSession(localSession, serverSession);
            });

            var preferredSessionId = getPreferredSessionId(state.sessions);
            if (preferredSessionId !== undefined) {
              state.selectedId = preferredSessionId;
            }
            restoreStructuredQueue();
            updateStructuredQueueCounter();
            state.bootstrapping = false;
            persistSelectedId();
            if (state.modalOpen) {
              updateSessionsList();
            } else {
              var listEl = document.getElementById("sessions-list");
              var rendered = renderSessionsListContent();
              if (listEl && listEl.innerHTML === rendered) {
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              } else {
                if (listEl) listEl.innerHTML = rendered;
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              }
            }
            updateShellChrome();
            if (state.selectedId && state.gitStatusSessionId !== state.selectedId) {
              loadGitStatus(state.selectedId);
            }

            var reloadPromise = Promise.resolve();
            if (!opts.skipSelectedOutputReload && state.selectedId) {
              reloadPromise = loadOutput(state.selectedId);
            } else if (state.selectedId) {
              var sel = state.sessions.find(function(s) { return s.id === state.selectedId; });
              if (isStructuredSession(sel)) {
                // ws 重连后的同会话刷新——保留用户阅读位置。
                resetChatRenderCache({ preserveStickState: true });
                scheduleChatRender(true);
              }
            }

            return reloadPromise.then(function() {
              if (state.crossSessionQueue.length > 0) {
                flushCrossSessionQueue();
              }
              renderCrossSessionQueue();
              _syncWakeLock();
            });
          })
          .catch(function(e) {
            var message = (e && e.message) || "";
            var isTransientAbort =
              message === "Failed to fetch" ||
              message === "NetworkError when attempting to fetch resource." ||
              message === "Load failed" ||
              /aborted|aborterror|networkerror|failed to fetch/i.test(message);
            if (!isTransientAbort) {
              console.error("[wand] loadSessions failed:", e);
            }
          });
      }

      export var _sessionListUpdateTimer = null;
      export function scheduleSessionListUpdate() {
        if (_sessionListUpdateTimer) return;
        _sessionListUpdateTimer = setTimeout(function() {
          _sessionListUpdateTimer = null;
          updateSessionsList();
        }, 200);
      }

      export function updateSessionsList() {
        var listEl = document.getElementById("sessions-list");
        var countEl = document.getElementById("session-count");
        if (listEl) listEl.innerHTML = renderSessionsListContent();
        if (countEl) countEl.textContent = String(state.sessions.length);
        // History renders inline inside #sessions-list now, so the line above
        // already refreshed it — no separate docked region to update.
        if (typeof hideCollapsedTileBubble === "function") hideCollapsedTileBubble();
        updateShellChrome();
        // Re-render cross-session queue (container may have been destroyed by DOM rebuild)
        if (state.crossSessionQueue.length > 0) renderCrossSessionQueue();
      }

      export function updateShellChrome() {
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSession) {
          setTerminalInteractive(false);
          hideMiniKeyboard();
          closeKeyboardPopup();
        }
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "Wand";
        var terminalInfo = selectedSession ? getSessionStatusLabel(selectedSession) : "开始对话";
        var summaryEl = document.querySelector(".session-summary-value");
        var titleEl = document.getElementById("terminal-title");
        var infoEl = document.getElementById("terminal-info");
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");

        if (summaryEl && summaryEl.textContent !== terminalTitle) summaryEl.textContent = terminalTitle;
        if (titleEl && titleEl.textContent !== terminalTitle) titleEl.textContent = terminalTitle;
        if (infoEl) infoEl.textContent = selectedSession ? (terminalInfo + " · " + getSessionKindDescription(selectedSession)) : terminalInfo;

        var kindEl = document.getElementById("session-kind-display");
        var kindText = selectedSession ? getSessionKindLabel(selectedSession) : "终端";
        if (kindEl && kindEl.textContent !== kindText) kindEl.textContent = kindText;
        updateAutoApproveIndicator();

        if (!state.terminal && terminalContainer && selectedSession) {
          initTerminal();
        }
        if (state.terminal && terminalContainer && !terminalContainer.contains(state.terminal.element)) {
          teardownTerminal();
          initTerminal();
        }

        if (!selectedSession) {
          state.terminalSessionId = null;
          state.terminalOutput = "";
          state.terminalOutputMarker = 0; // R8: 取消选中会话时重置 /clear marker
        }
        // 之前这里会用 selectedSession.output 再 syncTerminalBuffer 一次。
        // 但 updateShellChrome 在 updateSessionsList、status 推送、init
        // 等多个高频路径都会被调，每次都拿"可能不带 output 的 slim 快照"
        // 兜回来 sync 一遍：要么早返回浪费判断，要么 prefix 不匹配触发
        // reset+全量重写、把 alt-screen 中正在绘制的 Claude TUI 切走。
        // terminal 写入应当只走 chunk hot-path 与 ws init 这两条权威路径，
        // 这里不再插手，避免引入二次覆盖。

        if (state.terminal && selectedSession && state.currentView === "terminal") {
          maybeScrollTerminalToBottom("view");
        }

        var inputPanel = document.querySelector(".input-panel");
        if (selectedSession) {
          if (blankChat) blankChat.classList.add("hidden");
          if (terminalContainer) terminalContainer.classList.remove("hidden");
          if (chatContainer) chatContainer.classList.remove("hidden");
          // v2: 停止按钮不在这里统一展示 —— 由 updateInteractiveControls()
          // 按 computeRunningSignal 判断「真在跑」时才露出（applyCurrentView 末尾会调用）。
          if (inputPanel) inputPanel.classList.remove("hidden");
        } else {
          if (blankChat) blankChat.classList.remove("hidden");
          if (terminalContainer) terminalContainer.classList.add("hidden");
          if (chatContainer) chatContainer.classList.add("hidden");
          if (stopBtn) stopBtn.classList.add("hidden");
          if (inputPanel) inputPanel.classList.add("hidden");
        }
        syncComposerModeSelect();
        syncComposerModelSelect(getSelectedSession());
        applyCurrentView();
        reconcileInteractiveState();
      }

      export function loadOutput(id) {
        // Cancel any pending debounced chat render to avoid flicker
        if (state.chatRenderTimer) {
          clearTimeout(state.chatRenderTimer);
          state.chatRenderTimer = null;
        }
        var sess = state.sessions.find(function(s) { return s.id === id; });
        var url = "/api/sessions/" + id;
        if (shouldRequestChatFormat(sess)) {
          url += "?format=chat";
        }
        return fetch(url, { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.error) {
              // Session no longer exists — deselect and refresh list
              if (state.selectedId === id) {
                state.selectedId = null;
                persistSelectedId();
              }
              loadSessions();
              return;
            }
            updateSessionSnapshot(data);
            updateShellChrome();

            if (state.terminal && id === state.selectedId && data.output !== undefined) {
              // ws 在线时不要在这里写终端：HTTP 这边返回的是 PTY transcript
              // 完整磁盘文件（可达数十 MB），ws 订阅 init 拿到的是内存 ring
              // buffer 末尾窗口（约 200KB），二者长度+起点都不同。两路都
              // syncTerminalBuffer 时，append 模式的前缀检查必然失败，
              // 落到 else 分支的 reset+全量重写，与 ws init 的 reset+
              // 写入交叠，造成首屏「两份内容错位重叠」。
              // 设计原则：terminal 写入只走 ws init 与 chunk hot-path 两条
              // 权威路径——参见 case "init" 的 replace 写入与 onmessage
              // chunk 处理。这里只在 ws 离线兜底时才 append 写入。
              //
              // wsLikelyTakingOver: 即使 wsConnected=false（onopen 还没 fire），
              // 只要 ws.readyState 是 CONNECTING 或 OPEN，就视为 ws 即将
              // 接管。否则 selectSession → loadOutput resolve 比 ws onopen
              // 早时（常见于刷新页面后的首次连接）会误走 fallback，写入
              // terminal 后 ws init 又写一次，造成双路重叠。
              var wsLikelyTakingOver = !!state.ws && (
                state.ws.readyState === WebSocket.OPEN ||
                state.ws.readyState === WebSocket.CONNECTING
              );
              if (!wsLikelyTakingOver) {
                syncTerminalBuffer(id, data.output, { mode: "append" });
                // 离线兜底路径自己负责 fit + replay，否则尺寸不对。
                ensureTerminalFit("session-switch", { forceReplay: true });
              } else {
                // ws 在线/连接中：仅校准列宽，不重 replay（init 的
                // ensureTerminalFitWithRetry("init") 会负责按真实
                // 宽度的全量基线写入）。
                ensureTerminalFit("session-switch");
              }
            }

            var selectedSession = state.sessions.find(function(s) { return s.id === id; });
              state.currentMessages = buildMessagesForRender(selectedSession, getPreferredMessages(selectedSession, data.output, false));

            renderChat(false);
          });
      }

      export function selectSession(id) {
        var foundSession = state.sessions.find(function(item) { return item.id === id; });
        if (!foundSession) {
          return;
        }
        if (state.selectedId !== id) {
          teardownTerminal();
        }
        state.selectedId = id;
        persistSelectedId();
        state.toolContentCache = {};
        // Clear queued inputs from the previous session to prevent cross-session leaks
        state.messageQueue = [];
        state.pendingMessages = [];
        syncStructuredQueueFromSession(foundSession);
        restoreStructuredQueue();
        updateStructuredQueueCounter();
        resetChatRenderCache();
        state.currentMessages = [];
        if (state.chatRenderTimer) { clearTimeout(state.chatRenderTimer); state.chatRenderTimer = null; }
        // Reset todo progress bar
        var todoEl = document.getElementById("todo-progress");
        if (todoEl) todoEl.classList.add("hidden");
        // 同时清掉上一会话残留的 "回复中 N.Ns" 状态条以及它的计时器/glow。
        // 不清就会出现：切到新建的空会话，底部仍显示前一会话的 todolist + 回复中。
        var staleStatusBar = document.querySelector(".structured-status-bar");
        if (staleStatusBar) staleStatusBar.remove();
        if (state._statusBarTimerId) { clearInterval(state._statusBarTimerId); state._statusBarTimerId = null; }
        state._statusBarStartTime = 0;
        var staleComposer = document.querySelector(".input-composer");
        if (staleComposer) staleComposer.classList.remove("in-flight");
        var session = foundSession;
        state.preferredCommand = getPreferredTool();
        state.chatMode = getSafeModeForTool("claude", session && session.mode ? session.mode : state.chatMode);
        if (state.terminalInteractive && session && session.status !== "running") {
          setTerminalInteractive(false);
        }
        updateSessionsList();
        switchToSessionView(id);
        // Update file panel cwd and refresh if open
        if (state.filePanelOpen) {
          updateFilePanelCwd(session);
          refreshFileExplorer();
        }
        loadOutput(id).then(function() { focusInputBox(true); });
        subscribeToSession(id);
        // 切换会话时清掉旧 git 状态，再异步刷新
        state.gitStatus = null;
        state.gitStatusSessionId = null;
        updateTopbarGitBadge();
        loadGitStatus(id, { force: true });
      }

      export function updatePinState() {
        var drawer = document.getElementById("sessions-drawer");
        var mainLayout = document.querySelector(".main-layout");
        // 与 renderAppShell 保持一致：手机端只允许窄条形态 anchored。
        var isMobile = isMobileLayout();
        var isCollapsed = !!state.sidebarPinned && !!state.sidebarCollapsed;
        var isAnchored = isCollapsed || (!isMobile && (!!state.sidebarPinned || !!state.sessionsDrawerOpen));
        if (drawer) {
          drawer.classList.toggle("pinned", isAnchored);
          drawer.classList.toggle("collapsed", isCollapsed);
        }
        if (mainLayout) {
          mainLayout.classList.toggle("sidebar-pinned", isAnchored);
          mainLayout.classList.toggle("sidebar-collapsed", isCollapsed);
        }
        var pinBtn = document.getElementById("sidebar-pin-btn");
        if (pinBtn) {
          pinBtn.classList.toggle("pinned", !!state.sidebarPinned);
          pinBtn.title = state.sidebarPinned ? "已固定常驻（点击解除锁定）" : "固定侧栏常驻";
          pinBtn.setAttribute("aria-label", state.sidebarPinned ? "解除固定常驻" : "固定侧栏常驻");
          pinBtn.setAttribute("aria-pressed", state.sidebarPinned ? "true" : "false");
        }
      }

      export function updateDrawerState() {
        var drawer = document.getElementById("sessions-drawer");
        var backdrop = document.getElementById("sessions-drawer-backdrop");
        var mainLayout = document.querySelector(".main-layout");
        if (drawer) {
          drawer.classList.toggle("open", state.sessionsDrawerOpen);
        }
        if (backdrop) {
          backdrop.classList.toggle("open", shouldShowSessionsBackdrop());
        }
        if (mainLayout) {
          mainLayout.classList.toggle("sidebar-open", state.sessionsDrawerOpen);
        }
        var toggleBtn = document.getElementById("sessions-toggle-button");
        if (toggleBtn) {
          toggleBtn.classList.toggle("active", state.sessionsDrawerOpen);
        }
        updatePinState();
      }

      export function toggleSessionsDrawer() {
        var isMobile = isMobileLayout();
        if (!isMobile) {
          // 桌面：hamburger 只负责临时打开/关闭；锁定常驻由图钉按钮控制。
          var willOpen = state.sidebarPinned ? false : !state.sessionsDrawerOpen;
          state.sessionsDrawerOpen = willOpen;
          if (willOpen) {
            // 桌面重新呼出默认回到全尺寸；窄条形态需用户主动点 collapse 按钮切换。
            state.sidebarCollapsed = false;
            writeStoredBoolean("wand-sidebar-collapsed", false);
          }
          writeStoredBoolean("wand-sidebar-open", state.sessionsDrawerOpen);
          updateLayoutState();
          scheduleTerminalRefitAfterPaddingTransition();
          return;
        }
        // 手机端：保持原 drawer 行为。
        state.sessionsDrawerOpen = !state.sessionsDrawerOpen;
        writeStoredBoolean("wand-sidebar-open", state.sessionsDrawerOpen);
        if (state.sessionsDrawerOpen) {
          state.filePanelOpen = false;
          try {
            localStorage.setItem("wand-file-panel-open", "false");
          } catch (e) {}
        }
        updateLayoutState();
      }

      export function closeSessionsDrawer() {
        var isMobile = isMobileLayout();
        if (!isMobile) {
          // 桌面：X 按钮 / backdrop 点击 = 完全收起，撤掉常驻状态，floating-toggle 重新出现。
          // 窄条状态下没有 X 按钮（CSS 隐藏），不会走到这里，因此无需特判 collapsed。
          if (!state.sidebarPinned && !state.sessionsDrawerOpen) return;
          closeSwipedItem();
          state.sidebarPinned = false;
          state.sessionsDrawerOpen = false;
          writeStoredBoolean("wand-sidebar-pinned", false);
          writeStoredBoolean("wand-sidebar-open", false);
          updateLayoutState();
          scheduleTerminalRefitAfterPaddingTransition();
          return;
        }
        // 手机端：保持原 drawer 关闭行为。
        if (!state.sessionsDrawerOpen) return;
        closeSwipedItem();
        state.sessionsDrawerOpen = false;
        writeStoredBoolean("wand-sidebar-open", false);
        updateLayoutState();
      }

      export function closeTransientSessionsDrawer() {
        if (isMobileLayout()) {
          closeSessionsDrawer();
          return;
        }
        if (state.sidebarPinned || state.sidebarCollapsed || !state.sessionsDrawerOpen) return;
        closeSwipedItem();
        state.sessionsDrawerOpen = false;
        writeStoredBoolean("wand-sidebar-open", false);
        updateLayoutState();
        scheduleTerminalRefitAfterPaddingTransition();
      }

      // 把"浮在内容上的 drawer/backdrop"关掉，但保留桌面常驻栏与窄条形态。
      // 用法：从 input focus / send 按钮 / 选中会话 / 新建会话回调里调，这些场
      // 景只想避免遮罩挡住内容，并不想撤掉用户主动开启的常驻侧栏。
      //
      // 加号 popover：附件入口 + 终端交互开关 + 三件套，向上展开浮在 + 按钮上方。
      // 状态走 state，类切换走 DOM；外点 / Esc / 选完三件套之后自动关闭。
      export function setPlusPopoverOpen(open) {
        var popover = document.getElementById("composer-plus-popover");
        var btn = document.getElementById("attach-btn");
        state.plusPopoverOpen = !!open;
        if (popover) popover.classList.toggle("hidden", !open);
        if (btn) {
          btn.classList.toggle("active", !!open);
          btn.setAttribute("aria-expanded", open ? "true" : "false");
        }
      }
      export function togglePlusPopover() { setPlusPopoverOpen(!state.plusPopoverOpen); }
      export function closePlusPopover() { if (state.plusPopoverOpen) setPlusPopoverOpen(false); }

      // 直接调 closeSessionsDrawer() 会在桌面把 state.sidebarPinned 置 false，
      // 进而让 .pinned/.collapsed 这两个类一起脱落，窄条整体消失 —— 这是
      // sidebar-collapsed-tile 点击后侧栏整个不见的根因。
      export function dismissDrawerIfOverlay() {
        if (isMobileLayout() && state.sessionsDrawerOpen) {
          closeSessionsDrawer();
        }
      }

      // 桌面 padding-left transition 结束后重新拟合终端尺寸。
      // 抽出来给 toggleSessionsDrawer / closeSessionsDrawer / toggleSidebarCollapsed 复用。
      export function scheduleTerminalRefitAfterPaddingTransition() {
        var mainLayout = document.querySelector(".main-layout");
        if (mainLayout) {
          var onEnd = function(e) {
            if (e.propertyName === "padding-left") {
              mainLayout.removeEventListener("transitionend", onEnd);
              scheduleTerminalResize(true);
            }
          };
          mainLayout.addEventListener("transitionend", onEnd);
        }
        setTimeout(function() { scheduleTerminalResize(true); }, 350);
      }

      export var collapsedTileBubbleEl = null;
      export function ensureCollapsedTileBubble() {
        if (collapsedTileBubbleEl && document.body.contains(collapsedTileBubbleEl)) {
          return collapsedTileBubbleEl;
        }
        collapsedTileBubbleEl = document.createElement("div");
        collapsedTileBubbleEl.className = "sidebar-tile-bubble";
        collapsedTileBubbleEl.setAttribute("role", "tooltip");
        document.body.appendChild(collapsedTileBubbleEl);
        return collapsedTileBubbleEl;
      }
      export function hideCollapsedTileBubble() {
        if (collapsedTileBubbleEl) collapsedTileBubbleEl.classList.remove("visible");
      }
      export function showCollapsedTileBubble(tile, text) {
        if (!text) { hideCollapsedTileBubble(); return; }
        var bubble = ensureCollapsedTileBubble();
        bubble.textContent = text.length > 400 ? text.slice(0, 400) + "…" : text;
        var rect = tile.getBoundingClientRect();
        bubble.classList.add("visible");
        // Measure after content set; clamp vertically to viewport.
        var bubbleRect = bubble.getBoundingClientRect();
        var centerY = rect.top + rect.height / 2;
        var top = centerY - bubbleRect.height / 2;
        var minTop = 8;
        var maxTop = window.innerHeight - bubbleRect.height - 8;
        if (top < minTop) top = minTop;
        if (top > maxTop) top = Math.max(minTop, maxTop);
        bubble.style.left = (rect.right + 12) + "px";
        bubble.style.top = top + "px";
        bubble.style.setProperty("--bubble-tail-y", (centerY - top) + "px");
      }
      export function getCollapsedTileBubbleText(tile) {
        if (tile.dataset.collapsedSessionId) {
          var session = state.sessions.find(function(s) { return s.id === tile.dataset.collapsedSessionId; });
          if (!session) return "";
          var latest = getSessionLatestUserText(session);
          if (latest) return latest;
          return session.summary || session.command || "";
        }
        if (tile.dataset.collapsedHistoryId) {
          var hist = state.claudeHistory.find(function(s) { return s.claudeSessionId === tile.dataset.collapsedHistoryId; });
          if (hist && hist.firstUserMessage) return hist.firstUserMessage;
        }
        return "";
      }
      export function handleCollapsedTileHover(event) {
        var target = event.target;
        if (!target || !(target instanceof Element)) return;
        var tile = target.closest(".sidebar-collapsed-tile");
        if (!tile) { hideCollapsedTileBubble(); return; }
        var text = getCollapsedTileBubbleText(tile);
        if (!text) { hideCollapsedTileBubble(); return; }
        showCollapsedTileBubble(tile, text);
      }
      export function handleCollapsedTileLeave(event) {
        var related = event.relatedTarget;
        if (related && related instanceof Element && related.closest(".sidebar-collapsed-tile")) {
          return;
        }
        hideCollapsedTileBubble();
      }

      export function toggleSidebarCollapsed() {
        var isMobile = isMobileLayout();
        // 任何形态下点窄条按钮都意味着「我要常驻」，确保 pinned 写上。
        if (!state.sidebarPinned) {
          state.sidebarPinned = true;
          writeStoredBoolean("wand-sidebar-pinned", true);
        }
        state.sidebarCollapsed = !state.sidebarCollapsed;
        writeStoredBoolean("wand-sidebar-collapsed", state.sidebarCollapsed);
        if (state.sidebarCollapsed) {
          // 进入窄条形态：sessionsDrawerOpen 设 false，避免手机上 .drawer-backdrop
          // 仍带 .open 类导致背景遮罩误显示（窄条已经常驻显示，不需要遮罩）。
          state.sessionsDrawerOpen = false;
        } else if (isMobile) {
          // 手机端展开窄条：不允许「pin 但不窄条」的 300px 全栏（太占地），
          // 改为回到 drawer 模式并自动打开抽屉，让用户看到完整会话列表。
          state.sidebarPinned = false;
          state.sessionsDrawerOpen = true;
          writeStoredBoolean("wand-sidebar-pinned", false);
        } else {
          // 桌面端展开窄条 → 300px 全栏常驻。
          state.sessionsDrawerOpen = true;
        }
        writeStoredBoolean("wand-sidebar-open", state.sessionsDrawerOpen);
        // 轻量更新而非全量 render()：render() 会 teardown 并重建整个终端 DOM，
        // 导致收窄/展开时终端闪烁、丢失滚动与渲染状态。这里只切布局 class
        // （宽度 56↔300 走 CSS width transition）、重渲侧栏列表内容、刷新
        // 收窄按钮自身的图标/文案，终端区保持不动。
        updateLayoutState();
        updateSessionsList();
        updateSidebarCollapseButton();
        hideCollapsedTileBubble();
        scheduleTerminalRefitAfterPaddingTransition();
      }

      // 常驻（图钉）开关：把侧栏「留在原地」并排停靠 ⟷ 悬浮抽屉。
      //   - 常驻 ON：停靠并推开内容；配合「收起为窄条」可在全尺寸/窄条间切换。
      //   - 常驻 OFF：变为悬浮抽屉，交互时自动收起（非常驻）。
      // 手机端不支持常驻（屏幕太窄），保持抽屉行为。
      // 「图钉」只切换「是否锁定常驻」，绝不收起 / 隐藏侧栏——这是用户两次反馈的核心：
      // 点图钉不该让侧栏消失，也不该把主区压到侧栏下面。
      //   - 锁定（pinned）：常驻停靠，不会被「关闭(X)」一键收走的语义区分开。
      //   - 解除锁定（unpinned）：仍然停靠可见（因为 isAnchored 把 open 也算停靠），
      //     只是变成「可被 X 关闭」的临时态。
      // 全尺寸 / 窄条由「收起为窄条」按钮控制，与图钉正交。
      export function toggleSidebarPin() {
        if (isMobileLayout()) return;
        state.sidebarPinned = !state.sidebarPinned;
        // 关键：保持侧栏可见停靠，无论锁定与否，点图钉都不让它消失。
        state.sessionsDrawerOpen = true;
        writeStoredBoolean("wand-sidebar-pinned", state.sidebarPinned);
        writeStoredBoolean("wand-sidebar-open", true);
        updateLayoutState();
        scheduleTerminalRefitAfterPaddingTransition();
      }

      // 收窄按钮的图标/title/状态随 collapsed 切换。抽出来给轻量更新路径用，
      // 避免为了换一个箭头方向就走全量 render()。
      export function updateSidebarCollapseButton() {
        var btn = document.getElementById("sidebar-collapse-btn");
        if (!btn) return;
        var isCollapsed = !!state.sidebarPinned && !!state.sidebarCollapsed;
        btn.classList.toggle("collapsed", isCollapsed);
        btn.title = isCollapsed ? "展开侧栏" : "收起为窄条";
        btn.setAttribute("aria-label", isCollapsed ? "展开侧栏" : "收起为窄条");
        btn.innerHTML = isCollapsed
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 6 16 12 10 18"/><line x1="20" y1="5" x2="20" y2="19"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="14 6 8 12 14 18"/><line x1="4" y1="5" x2="4" y2="19"/></svg>';
      }

      // 「更多操作」下拉默认 right:0 贴 more 按钮右沿向左展开。手机窄屏下这条会把
      // 菜单左缘顶出屏幕外。打开时按视口边界 clamp：先保持 CSS 默认右对齐，仅当
      // 真的越界才改写 left/right 把菜单拉回视口内（留 8px 边距）。
      export function positionSidebarOverflowMenu(menu) {
        if (!menu) return;
        menu.style.left = "";
        menu.style.right = "";
        var parent = menu.offsetParent || menu.parentElement;
        if (!parent) return;
        var margin = 8;
        var parentRect = parent.getBoundingClientRect();
        var rect = menu.getBoundingClientRect();
        var vw = window.innerWidth;
        if (rect.left < margin) {
          // 左缘越界：改用 left 定位，把左缘顶到视口左 margin。
          menu.style.right = "auto";
          menu.style.left = (margin - parentRect.left) + "px";
        } else if (rect.right > vw - margin) {
          // 右缘越界：拉回视口右 margin（桌面右对齐时几乎不会触发）。
          menu.style.left = "auto";
          menu.style.right = (parentRect.right - (vw - margin)) + "px";
        }
      }

      // Store last focused element for focus trap
      // moved to state.state.lastFocusedElement
      // moved to state.state.focusTrapHandler

      export function openSessionModal() {
        // Close settings modal first if open (mutual exclusion)
        closeSettingsModal();
        state.modalOpen = true;
        state.sessionsDrawerOpen = false;
        writeStoredBoolean("wand-sidebar-open", false);
        updateDrawerState();
        var modal = document.getElementById("session-modal");
        if (modal) {
          if ((modal as any)._wandCloseTimer) { clearTimeout((modal as any)._wandCloseTimer); (modal as any)._wandCloseTimer = null; }
          modal.classList.remove("closing");
          modal.classList.remove("hidden");
          state.lastFocusedElement = document.activeElement;
          state.sessionTool = getPreferredTool();
          state.preferredCommand = state.sessionTool;
          state.sessionCreateKind = "structured";
          state.sessionCreateWorktree = false;
          state.modeValue = getSafeModeForTool(state.sessionTool, state.modeValue || state.chatMode);
          syncSessionModalUI();
          loadRecentPathBubbles();
          setTimeout(function() {
            var modeCardsEl = document.getElementById("mode-cards");
            if (modeCardsEl) modeCardsEl.focus();
          }, 20);
          setupFocusTrap(modal);
        }
      }

      export function closeSessionModal() {
        state.modalOpen = false;
        var modal = document.getElementById("session-modal");
        if (modal) {
          // Remove focus trap before kicking off the exit animation
          if (state.focusTrapHandler) {
            document.removeEventListener("keydown", state.focusTrapHandler);
            state.focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
            state.lastFocusedElement.focus();
          }
          animateModalClose(modal);
        }
        hidePathSuggestions();
      }

      // Run the liquid-glass exit animation on a modal-backdrop, then mark it hidden.
      // Falls back to instant hide when reduced-motion is requested or a tab is in the background.
      export function animateModalClose(modal) {
        if (!modal) return;
        if (modal.classList.contains("hidden")) return;
        var prefersReducedMotion = false;
        try {
          prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (_e) {}
        if (prefersReducedMotion || document.hidden) {
          modal.classList.remove("closing");
          modal.classList.add("hidden");
          return;
        }
        // Cancel any outstanding pending hide on the same node
        if ((modal as any)._wandCloseTimer) {
          clearTimeout((modal as any)._wandCloseTimer);
          (modal as any)._wandCloseTimer = null;
        }
        modal.classList.add("closing");
        (modal as any)._wandCloseTimer = setTimeout(function() {
          modal.classList.remove("closing");
          modal.classList.add("hidden");
          (modal as any)._wandCloseTimer = null;
        }, 170);
      }

      export function setupFocusTrap(modal) {
        if (state.focusTrapHandler) {
          document.removeEventListener("keydown", state.focusTrapHandler);
        }

        // Focusable elements selector
        var focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

        state.focusTrapHandler = function(e) {
          if (e.key !== "Tab") return;

          var focusableElements = modal.querySelectorAll(focusableSelector);
          var firstEl = focusableElements[0];
          var lastEl = focusableElements[focusableElements.length - 1];

          if (!firstEl || !lastEl) return;

          // Shift + Tab
          if (e.shiftKey) {
            if (document.activeElement === firstEl) {
              e.preventDefault();
              lastEl.focus();
            }
          } else {
            // Tab
            if (document.activeElement === lastEl) {
              e.preventDefault();
              firstEl.focus();
            }
          }
        };

        document.addEventListener("keydown", state.focusTrapHandler);
      }

      export function getActiveWorktreeMergeSession() {
        if (!state.activeWorktreeMergeSessionId) return null;
        return state.sessions.find(function(session) { return session.id === state.activeWorktreeMergeSessionId; }) || null;
      }

      export function renderWorktreeMergeContent() {
        var container = document.getElementById("worktree-merge-content");
        var confirmBtn = document.getElementById("worktree-merge-confirm-button") as HTMLButtonElement | null;
        var errorEl = document.getElementById("worktree-merge-error");
        var session = getActiveWorktreeMergeSession();
        var result = state.worktreeMergeCheckResult;
        if (!container || !confirmBtn) return;
        if (!session || !session.worktree) {
          container.innerHTML = '<p class="field-hint">未找到可合并的 worktree 会话。</p>';
          confirmBtn.disabled = true;
          return;
        }
        if (errorEl) {
          if (state.worktreeMergeError) {
            showError(errorEl, state.worktreeMergeError);
          } else {
            hideError(errorEl);
          }
        }
        var rows = [
          '<div class="worktree-merge-row"><span>来源分支</span><strong>' + escapeHtml(session.worktree.branch || "-") + '</strong></div>',
          '<div class="worktree-merge-row"><span>工作目录</span><strong>' + escapeHtml(session.worktree.path || "-") + '</strong></div>'
        ];
        if (result) {
          rows.push('<div class="worktree-merge-row"><span>目标分支</span><strong>' + escapeHtml(result.targetBranch || "-") + '</strong></div>');
          rows.push('<div class="worktree-merge-row"><span>待合并提交</span><strong>' + escapeHtml(String(result.aheadCount || 0)) + '</strong></div>');
          rows.push('<div class="worktree-merge-row"><span>未提交改动</span><strong>' + escapeHtml(result.hasUncommittedChanges ? "有" : "无") + '</strong></div>');
          rows.push('<div class="worktree-merge-row"><span>冲突风险</span><strong>' + escapeHtml(result.hasConflicts ? "有" : "无") + '</strong></div>');
          if (result.reason) {
            rows.push('<p class="field-hint">' + escapeHtml(result.reason) + '</p>');
          }
        } else if (state.worktreeMergeLoading) {
          rows.push('<p class="field-hint">正在检查 worktree 合并状态…</p>');
        }
        container.innerHTML = rows.join("");
        confirmBtn.disabled = state.worktreeMergeLoading || state.worktreeMergeSubmitting || !result || result.ok !== true;
        confirmBtn.textContent = state.worktreeMergeSubmitting ? "合并中..." : "确认合并并清理";
      }

      export function openWorktreeMergeModal(sessionId) {
        state.activeWorktreeMergeSessionId = sessionId;
        state.worktreeMergeCheckResult = null;
        state.worktreeMergeLoading = true;
        state.worktreeMergeSubmitting = false;
        state.worktreeMergeError = "";
        closeSessionModal();
        closeSettingsModal();
        var modal = document.getElementById("worktree-merge-modal");
        if (modal) {
          modal.classList.remove("hidden");
          state.lastFocusedElement = document.activeElement;
          setupFocusTrap(modal);
        }
        renderWorktreeMergeContent();
        fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/worktree/merge/check", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            if (data && data.session) {
              updateSessionSnapshot(data.session);
            }
            state.worktreeMergeCheckResult = data.result || null;
            state.worktreeMergeError = "";
          })
          .catch(function(error) {
            state.worktreeMergeError = (error && error.message) || "无法检查 worktree 合并状态。";
          })
          .finally(function() {
            state.worktreeMergeLoading = false;
            renderWorktreeMergeContent();
          });
      }

      export function closeWorktreeMergeModal() {
        var modal = document.getElementById("worktree-merge-modal");
        state.activeWorktreeMergeSessionId = null;
        state.worktreeMergeCheckResult = null;
        state.worktreeMergeLoading = false;
        state.worktreeMergeSubmitting = false;
        state.worktreeMergeError = "";
        if (modal) {
          modal.classList.add("hidden");
        }
        if (state.focusTrapHandler) {
          document.removeEventListener("keydown", state.focusTrapHandler);
          state.focusTrapHandler = null;
        }
        if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
          state.lastFocusedElement.focus();
        }
      }

      export function confirmWorktreeMerge() {
        if (!state.activeWorktreeMergeSessionId || state.worktreeMergeSubmitting) return;
        state.worktreeMergeSubmitting = true;
        state.worktreeMergeError = "";
        renderWorktreeMergeContent();
        fetch("/api/sessions/" + encodeURIComponent(state.activeWorktreeMergeSessionId) + "/worktree/merge", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            if (data && data.session) {
              updateSessionSnapshot(data.session);
            }
            showToast("已合并到 " + escapeHtml((data.result && data.result.targetBranch) || "主分支") + ((data.result && data.result.cleanupDone === false) ? "，但工作树待清理。" : "。"), "info");
            closeWorktreeMergeModal();
            return refreshAll();
          })
          .catch(function(error) {
            state.worktreeMergeError = (error && error.message) || "无法合并 worktree。";
            renderWorktreeMergeContent();
          })
          .finally(function() {
            state.worktreeMergeSubmitting = false;
            renderWorktreeMergeContent();
          });
      }

      export function retryWorktreeCleanup(sessionId) {
        fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/worktree/cleanup", {
          method: "POST",
          credentials: "same-origin"
        })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            if (data && data.session) {
              updateSessionSnapshot(data.session);
            }
            showToast("已完成 worktree 清理。", "info");
            return refreshAll();
          })
          .catch(function(error) {
            showToast((error && error.message) || "无法清理 worktree。", "error");
          });
      }

      export function openSettingsModal() {
        // Close session modal first if open (mutual exclusion)
        closeSessionModal();
        var modal = document.getElementById("settings-modal");
        if (modal) {
          if ((modal as any)._wandCloseTimer) { clearTimeout((modal as any)._wandCloseTimer); (modal as any)._wandCloseTimer = null; }
          modal.classList.remove("closing");
          modal.classList.remove("hidden");
          state.lastFocusedElement = document.activeElement;
          var passEl = document.getElementById("new-password") as HTMLInputElement | null;
          var confirmEl = document.getElementById("confirm-password") as HTMLInputElement | null;
          if (passEl) passEl.value = "";
          if (confirmEl) confirmEl.value = "";
          hideSettingsMessages();
          setupFocusTrap(modal);
          bindSettingsTabKeyboardNavigation();
          // Activate first tab
          switchSettingsTab("about");
          // Load settings data
          loadSettingsData();
          // Sync notification preferences
          var soundEl = document.getElementById("cfg-notif-sound") as HTMLInputElement | null;
          var bubbleEl = document.getElementById("cfg-notif-bubble") as HTMLInputElement | null;
          if (soundEl) soundEl.checked = state.notifSound;
          if (bubbleEl) bubbleEl.checked = state.notifBubble;
          var volEl = document.getElementById("cfg-notif-volume") as HTMLInputElement | null;
          var volValEl = document.getElementById("cfg-notif-volume-val");
          if (volEl) {
            volEl.value = state.notifVolume;
            if (volValEl) volValEl.textContent = state.notifVolume + "%";
            // Sync the iOS-style fill via the input listener (calls _syncRangeFill)
            try { volEl.dispatchEvent(new Event("input", { bubbles: true })); } catch (_e) {}
          }
          var volField = document.getElementById("notif-volume-field");
          if (volField) volField.style.display = state.notifSound ? "" : "none";
          updateNotificationStatus();
          // Load current app icon selection (APK only)
          if (typeof WandNative !== "undefined" && typeof WandNative.getAppIcon === "function") {
            try { _updateAppIconSelection(WandNative.getAppIcon() || "shorthair"); } catch (_e) {}
          }
          // Sync native notification sound selector and volume (APK only)
          if (_hasNativeBridge && typeof WandNative.getNotificationSound === "function") {
            try {
              var nsSel = document.getElementById("native-sound-select") as HTMLSelectElement | null;
              if (nsSel) nsSel.value = WandNative.getNotificationSound();
            } catch (_e) {}
          }
          if (_hasNativeBridge && typeof WandNative.getNotificationVolume === "function") {
            try {
              var nativeVol = WandNative.getNotificationVolume();
              state.notifVolume = nativeVol;
              if (volEl) volEl.value = String(nativeVol);
              if (volValEl) volValEl.textContent = nativeVol + "%";
              // Sync the iOS-style fill so the orange track matches
              if (volEl) { try { volEl.dispatchEvent(new Event("input", { bubbles: true })); } catch (_e) {} }
              try { localStorage.setItem("wand-notif-volume", String(nativeVol)); } catch (_e) {}
            } catch (_e) {}
          }
          if (_hasNativeBridge && typeof WandNative.isHapticEnabled === "function") {
            try {
              var hapticEl = document.getElementById("cfg-haptic-enabled") as HTMLInputElement | null;
              if (hapticEl) hapticEl.checked = WandNative.isHapticEnabled();
            } catch (_e) {}
          }
        }
      }

      export function closeSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) {
          // Remove focus trap before kicking off the exit animation
          if (state.focusTrapHandler) {
            document.removeEventListener("keydown", state.focusTrapHandler);
            state.focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
            state.lastFocusedElement.focus();
          }
          animateModalClose(modal);
        }
      }

      export function hideSettingsMessages() {
        var errorEl = document.getElementById("settings-error");
        var successEl = document.getElementById("settings-success");
        if (errorEl) errorEl.classList.add("hidden");
        if (successEl) successEl.classList.add("hidden");
      }

      export function savePassword() {
        var newPass = (document.getElementById("new-password") as HTMLInputElement).value;
        var confirmPass = (document.getElementById("confirm-password") as HTMLInputElement).value;
        var errorEl = document.getElementById("settings-error");
        var successEl = document.getElementById("settings-success");

        hideSettingsMessages();

        if (!newPass || newPass.length < 6) {
          errorEl.textContent = "密码长度至少为 6 个字符。";
          errorEl.classList.remove("hidden");
          return;
        }

        if (newPass !== confirmPass) {
          errorEl.textContent = "两次输入的密码不一致。";
          errorEl.classList.remove("hidden");
          return;
        }

        fetch("/api/set-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: newPass }),
          credentials: "same-origin"
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            errorEl.textContent = data.error;
            errorEl.classList.remove("hidden");
            return;
          }
          successEl.textContent = "密码修改成功！";
          successEl.classList.remove("hidden");
          (document.getElementById("new-password") as HTMLInputElement).value = "";
          (document.getElementById("confirm-password") as HTMLInputElement).value = "";
        })
        .catch(function() {
          errorEl.textContent = "Failed to save password.";
          errorEl.classList.remove("hidden");
        });
      }

      // ── Settings tab/panel logic ──

      export function switchSettingsTab(tabName) {
        var tabs = document.querySelectorAll(".settings-tab");
        var panels = document.querySelectorAll(".settings-panel");
        for (var i = 0; i < tabs.length; i++) {
          var isActive = tabs[i].getAttribute("data-tab") === tabName;
          if (isActive) {
            tabs[i].classList.add("active");
          } else {
            tabs[i].classList.remove("active");
          }
          tabs[i].setAttribute("aria-selected", isActive ? "true" : "false");
          tabs[i].setAttribute("tabindex", isActive ? "0" : "-1");
        }
        for (var j = 0; j < panels.length; j++) {
          var isPanelActive = panels[j].id === "settings-tab-" + tabName;
          if (isPanelActive) {
            panels[j].classList.add("active");
            panels[j].removeAttribute("hidden");
          } else {
            panels[j].classList.remove("active");
            panels[j].setAttribute("hidden", "hidden");
          }
        }
      }

      export function handleSettingsTabKeydown(event) {
        if (!event) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") {
          return;
        }
        var tabs = Array.prototype.slice.call(document.querySelectorAll(".settings-tab"));
        if (!tabs.length) return;
        var currentIndex = tabs.indexOf(event.currentTarget);
        if (currentIndex === -1) return;
        event.preventDefault();
        var nextIndex = currentIndex;
        if (event.key === "ArrowUp") nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
        if (event.key === "ArrowDown") nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        var nextTab = tabs[nextIndex];
        if (!nextTab) return;
        var nextName = nextTab.getAttribute("data-tab");
        if (nextName) switchSettingsTab(nextName);
        if (typeof nextTab.focus === "function") nextTab.focus();
      }

      export function bindSettingsTabKeyboardNavigation() {
        var tabs = document.querySelectorAll(".settings-tab");
        for (var i = 0; i < tabs.length; i++) {
          tabs[i].removeEventListener("keydown", handleSettingsTabKeydown);
          tabs[i].addEventListener("keydown", handleSettingsTabKeydown);
        }
      }

      export function updateSettingsSidebarStatus(data) {
        if (!data) return;
        var cfg = data.config || {};
        var metaMap = {
          about: data.version ? ("当前 v" + data.version) : "版本与更新信息",
          general: [cfg.defaultMode || "default", cfg.language || "自动语言"].filter(Boolean).join(" · "),
          notifications: state.notifSound ? ("提示音 " + state.notifVolume + "%") : "提示音已关闭",
          security: data.hasCert ? "已安装 SSL 证书" : "密码与证书管理",
          presets: cfg.commandPresets && cfg.commandPresets.length ? (cfg.commandPresets.length + " 条预设") : "暂无预设",
          display: "控制卡片默认展开"
        };
        for (var key in metaMap) {
          if (!Object.prototype.hasOwnProperty.call(metaMap, key)) continue;
          var tab = document.querySelector('.settings-tab[data-tab="' + key + '"] .settings-tab-meta');
          if (tab) tab.textContent = metaMap[key] || "";
        }
      }

      export function renderConnectQrCode(code) {
        var canvas = document.getElementById("android-connect-qr");
        var empty = document.getElementById("android-connect-qr-empty");
        var lib = window.QRCodeLib;
        if (!canvas) return;
        if (!lib || typeof lib.toCanvas !== "function") {
          if (empty) empty.textContent = "二维码库未加载";
          return;
        }
        try {
          lib.toCanvas(canvas, code, {
            width: 220,
            margin: 1,
            errorCorrectionLevel: "M",
            color: { dark: "#1f1b17", light: "#ffffff00" }
          }, function(err) {
            if (err) {
              if (empty) {
                empty.textContent = "二维码生成失败";
                empty.style.display = "";
              }
              canvas.style.visibility = "hidden";
              return;
            }
            if (empty) empty.style.display = "none";
            canvas.style.visibility = "visible";
          });
        } catch (e) {
          if (empty) {
            empty.textContent = "二维码生成失败";
            empty.style.display = "";
          }
          canvas.style.visibility = "hidden";
        }
      }

      export function showConnectQrModal(code) {
        var lib = window.QRCodeLib;
        if (!lib || typeof lib.toCanvas !== "function") return;
        // Reuse existing overlay if open
        var existing = document.getElementById("connect-qr-modal");
        if (existing) existing.remove();
        var overlay = document.createElement("div");
        overlay.id = "connect-qr-modal";
        overlay.className = "connect-qr-modal-overlay";
        overlay.innerHTML =
          '<div class="connect-qr-modal-card">' +
            '<canvas id="connect-qr-modal-canvas"></canvas>' +
            '<p class="connect-qr-modal-hint">用 Wand App 扫一扫，连接当前服务器</p>' +
            '<button type="button" class="btn btn-secondary btn-sm connect-qr-modal-close">关闭</button>' +
          '</div>';
        document.body.appendChild(overlay);
        var modalCanvas = overlay.querySelector("#connect-qr-modal-canvas");
        var size = Math.min(window.innerWidth, window.innerHeight) * 0.7;
        if (size < 240) size = 240;
        if (size > 480) size = 480;
        try {
          lib.toCanvas(modalCanvas, code, {
            width: size,
            margin: 2,
            errorCorrectionLevel: "M",
            color: { dark: "#1f1b17", light: "#ffffff" }
          });
        } catch (e) {}
        function close() { overlay.remove(); }
        overlay.addEventListener("click", function(e) {
          if (e.target === overlay) close();
        });
        var closeBtn = overlay.querySelector(".connect-qr-modal-close");
        if (closeBtn) closeBtn.addEventListener("click", close);
      }

      export function copyToClipboard(text, triggerBtn?, successCallback?) {
        if (!text) return;
        function onSuccess() {
          _vibrate("light");
          if (successCallback) { successCallback(); return; }
          if (triggerBtn) {
            var orig = triggerBtn.textContent;
            triggerBtn.textContent = "已复制";
            setTimeout(function() { triggerBtn.textContent = orig; }, 1500);
          }
        }
        if (_hasNativeBridge && typeof WandNative.copyToClipboard === "function") {
          try {
            if (WandNative.copyToClipboard(text) === "ok") { onSuccess(); return; }
          } catch (_e) {}
        }
        navigator.clipboard.writeText(text).then(onSuccess).catch(function() {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          onSuccess();
        });
      }

      export function formatBytes(value) {
        if (typeof value !== "number" || !isFinite(value) || value < 0) return "-";
        if (value < 1024) return value + " B";
        var units = ["KB", "MB", "GB", "TB"];
        var size = value / 1024;
        var unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size = size / 1024;
          unitIndex += 1;
        }
        var display = size >= 10 ? size.toFixed(0) : size.toFixed(1);
        return display + " " + units[unitIndex];
      }

      export function loadSettingsData() {
        fetch("/api/settings", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            updateSettingsSidebarStatus(data);
            // About
            var nameEl = document.getElementById("settings-pkg-name");
            var verEl = document.getElementById("settings-version");
            var nodeEl = document.getElementById("settings-node-req");
            var repoEl = document.getElementById("settings-repo-url");
            if (nameEl) nameEl.textContent = data.packageName || "-";
            if (verEl) verEl.textContent = data.version || "-";
            if (nodeEl) nodeEl.textContent = data.nodeVersion || "-";
            if (repoEl && data.repoUrl) {
              repoEl.innerHTML = '<a href="' + escapeHtml(data.repoUrl) + '" target="_blank" rel="noopener">' + escapeHtml(data.repoUrl) + '</a>';
            }

            // Prefill update info if available
            var latestEl = document.getElementById("settings-latest-version");
            var updateBtn = document.getElementById("do-update-button");
            if (data.latestVersion && latestEl) {
              latestEl.textContent = data.latestVersion;
              if (data.updateAvailable && updateBtn) {
                updateBtn.classList.remove("hidden");
              }
            }

            // Beta channel toggle
            var betaChannelToggle = document.getElementById("beta-channel-toggle") as HTMLInputElement | null;
            if (betaChannelToggle) betaChannelToggle.checked = data.updateChannel === "beta";

            // Auto-update toggles
            var autoUpdate = data.autoUpdate || {};
            var autoUpdateWebToggle = document.getElementById("auto-update-web-toggle") as HTMLInputElement | null;
            if (autoUpdateWebToggle) autoUpdateWebToggle.checked = !!autoUpdate.web;
            var autoUpdateApkToggle = document.getElementById("auto-update-apk-toggle") as HTMLInputElement | null;
            // 自动更新开关只对 APK 壳生效, 浏览器里不绑定状态(该行也保持隐藏), 避免静默写一个看不见的控件。
            if (autoUpdateApkToggle) autoUpdateApkToggle.checked = !!_apkVersion && !!autoUpdate.apk;
            var autoUpdateDmgToggle = document.getElementById("auto-update-dmg-toggle") as HTMLInputElement | null;
            if (autoUpdateDmgToggle) autoUpdateDmgToggle.checked = !!_macAppVersion && !!autoUpdate.dmg;

            // ── 原生包下载 helper（APK / DMG 共用）──
            function safeNotify(msg, type) {
              if (typeof window.wandAlert === "function") {
                window.wandAlert(msg, { type: type === "error" ? "danger" : "info" });
              } else if (typeof showToast === "function") {
                showToast(msg, type === "error" ? "error" : "info");
              } else if (type === "error") {
                alert(msg);
              }
            }
            // 同源本地下载：先 HEAD 探测状态码, 避免 window.open("_self") 把整页导航成裸 JSON;
            // 命中则用隐藏 <a download> 触发下载, 并给出明确反馈。
            function triggerLocalDownload(url, fileName, btn) {
              var original = btn ? btn.textContent : "";
              if (btn) { btn.disabled = true; btn.textContent = "下载中…"; }
              function restore() { if (btn) { btn.disabled = false; btn.textContent = original; } }
              fetch(url, { method: "HEAD", credentials: "same-origin" })
                .then(function(resp) {
                  if (!resp.ok) {
                    safeNotify(resp.status === 404 ? "下载未启用或文件已移除" : ("下载失败 (HTTP " + resp.status + ")"), "error");
                    restore();
                    return;
                  }
                  var a = document.createElement("a");
                  a.href = url;
                  a.download = fileName || "";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  safeNotify("已开始下载，请在通知栏/下载管理中查看", "info");
                  restore();
                })
                .catch(function(err) {
                  safeNotify("下载失败: " + (err && err.message ? err.message : err), "error");
                  restore();
                });
            }

            // 设置页版本比较 — 安装序语义，镜像 Android versionCode（build.gradle computeVersionCode）：
            // 三段数值比较优先；同三段时带 -debug 的包更【新】（debug 是 tag 之后的 master 构建，
            // versionCode = base+1 > release 的 base+0）；两个 debug 按时间戳后缀分段比。
            // 不能用标准 semver 的「prerelease < release」——那会诱导从 debug「升级」到同号
            // release，下载后被系统按降级拒装。
            function compareVer(a, b) {
              function parse(v) {
                var s = String(v || "").replace(/^v/, "");
                var dash = s.indexOf("-");
                var main = dash >= 0 ? s.slice(0, dash) : s;
                var pre = dash >= 0 ? s.slice(dash + 1) : "";
                return {
                  parts: main.split(".").map(function(n) { return parseInt(n, 10) || 0; }),
                  pre: pre,
                  isDebug: pre.indexOf("debug") === 0
                };
              }
              var pa = parse(a), pb = parse(b);
              for (var i = 0; i < 3; i++) {
                var d = (pa.parts[i] || 0) - (pb.parts[i] || 0);
                if (d !== 0) return d > 0 ? 1 : -1;
              }
              if (pa.isDebug !== pb.isDebug) return pa.isDebug ? 1 : -1;
              if (pa.isDebug && pb.isDebug) {
                var sa = pa.pre.split("."), sb = pb.pre.split(".");
                for (var j = 0; j < Math.max(sa.length, sb.length); j++) {
                  if (sa[j] === undefined) return -1;
                  if (sb[j] === undefined) return 1;
                  var na = parseInt(sa[j], 10), nb = parseInt(sb[j], 10);
                  if (!isNaN(na) && !isNaN(nb)) {
                    if (na !== nb) return na > nb ? 1 : -1;
                  } else if (sa[j] !== sb[j]) {
                    return sa[j] > sb[j] ? 1 : -1;
                  }
                }
              }
              return 0;
            }
            // 壳内按钮: 据版本比较结果决定文案/可点性。
            // allowDowngrade: APK 传 false —— Android 系统安装器会按「降级」拒装更旧的
            // versionCode，按钮直接禁用，不诱导用户下载一个装不上的包；
            // DMG 传 true —— macOS 拖装不校验版本，保留「重新安装」。
            function applyApkButton(btn, cmp, url, fileName, source, allowDowngrade) {
              btn.classList.remove("hidden");
              btn.disabled = false;
              if (cmp > 0) {
                btn.textContent = "升级";
              } else if (cmp === 0) {
                btn.textContent = "已是最新";
                btn.disabled = true;
              } else if (allowDowngrade) {
                btn.textContent = "重新安装";
              } else {
                btn.textContent = "版本较旧";
                btn.disabled = true;
              }
              btn.onclick = btn.disabled ? null : function() {
                try {
                  WandNative.downloadUpdate(url, fileName, source);
                } catch (e) {
                  safeNotify("调用下载失败: " + (e && e.message ? e.message : e), "error");
                }
              };
            }

            // ── Android APK version display ──
            var apkSection = document.getElementById("android-apk-section");
            var apkCurrentRow = document.getElementById("android-apk-current-row");
            var apkCurrentEl = document.getElementById("settings-android-apk-current");
            var apkGithubRow = document.getElementById("android-apk-github-row");
            var apkGithubEl = document.getElementById("settings-android-apk-github");
            var apkGithubBtn = document.getElementById("download-github-apk-btn");
            var apkLocalRow = document.getElementById("android-apk-local-row");
            var apkLocalEl = document.getElementById("settings-android-apk-local");
            var apkLocalBtn = document.getElementById("download-local-apk-btn");
            var apkMessageEl = document.getElementById("android-apk-message");
            var androidApk = data.androidApk || {};
            var isInApk = !!_apkVersion;
            // 浏览器模式下若管理员未启用 Android 分发(enabled===false), 整段隐藏; 壳内保留以便自升级。
            var apkEnabled = androidApk.enabled !== false;
            var hasApkInfo = isInApk || (apkEnabled && (!!androidApk.github || !!androidApk.local));
            if (apkSection) {
              if (hasApkInfo) apkSection.classList.remove("hidden");
              else apkSection.classList.add("hidden");
            }

            if (isInApk) {
              // ── APK 内模式：显示当前版本 + 线上版本 + 本地版本 ──
              if (apkCurrentRow && apkCurrentEl) {
                apkCurrentEl.textContent = "v" + _apkVersion;
                apkCurrentRow.classList.remove("hidden");
              }
              // 线上版本
              if (androidApk.github && apkGithubRow && apkGithubEl) {
                var ghLabel = androidApk.github.version ? ("v" + androidApk.github.version) : androidApk.github.fileName;
                if (typeof androidApk.github.size === "number") ghLabel += " · " + formatBytes(androidApk.github.size);
                apkGithubEl.textContent = ghLabel;
                apkGithubRow.classList.remove("hidden");
                if (apkGithubBtn) {
                  var ghCmp = androidApk.github.version ? compareVer(androidApk.github.version, _apkVersion) : 1;
                  applyApkButton(apkGithubBtn, ghCmp, androidApk.github.downloadUrl, androidApk.github.fileName || "wand-update.apk", "github", false);
                }
              }
              // 本地版本
              if (androidApk.local && apkLocalRow && apkLocalEl) {
                var lcLabel = androidApk.local.version ? ("v" + androidApk.local.version) : androidApk.local.fileName;
                if (typeof androidApk.local.size === "number") lcLabel += " · " + formatBytes(androidApk.local.size);
                apkLocalEl.textContent = lcLabel;
                apkLocalRow.classList.remove("hidden");
                if (apkLocalBtn) {
                  var lcCmp = androidApk.local.version ? compareVer(androidApk.local.version, _apkVersion) : 1;
                  applyApkButton(apkLocalBtn, lcCmp, androidApk.local.downloadUrl, androidApk.local.fileName || "wand-update.apk", "local", false);
                }
              }
              // 都没有时
              if (!androidApk.github && !androidApk.local && apkMessageEl) {
                apkMessageEl.textContent = "暂无可用更新";
                apkMessageEl.classList.remove("hidden");
              }
              // Show APK auto-update toggle in APK mode
              var apkAutoRow = document.getElementById("android-auto-update-row");
              var apkAutoHint = document.getElementById("android-auto-update-hint");
              if (apkAutoRow) apkAutoRow.classList.remove("hidden");
              if (apkAutoHint) apkAutoHint.classList.remove("hidden");
            } else {
              // ── 浏览器模式：显示线上版本 + 本地版本 + 下载按钮 ──
              if (androidApk.github && apkGithubRow && apkGithubEl) {
                var ghLabel2 = androidApk.github.version ? ("v" + androidApk.github.version) : androidApk.github.fileName;
                if (typeof androidApk.github.size === "number") ghLabel2 += " · " + formatBytes(androidApk.github.size);
                apkGithubEl.textContent = ghLabel2;
                apkGithubRow.classList.remove("hidden");
                if (apkGithubBtn) {
                  apkGithubBtn.textContent = "下载";
                  apkGithubBtn.classList.remove("hidden");
                  apkGithubBtn.onclick = function() {
                    window.open(androidApk.github.downloadUrl, "_blank");
                    safeNotify("正在打开下载页…", "info");
                  };
                }
              }
              // 本地版本
              if (androidApk.local && apkLocalRow && apkLocalEl) {
                var lcLabel2 = androidApk.local.version ? ("v" + androidApk.local.version) : androidApk.local.fileName;
                if (typeof androidApk.local.size === "number") lcLabel2 += " · " + formatBytes(androidApk.local.size);
                apkLocalEl.textContent = lcLabel2;
                apkLocalRow.classList.remove("hidden");
                if (apkLocalBtn) {
                  apkLocalBtn.textContent = "下载";
                  apkLocalBtn.classList.remove("hidden");
                  apkLocalBtn.onclick = function() {
                    triggerLocalDownload(androidApk.local.downloadUrl, androidApk.local.fileName || "wand-update.apk", apkLocalBtn);
                  };
                }
              }
              if (!androidApk.github && !androidApk.local && apkMessageEl) {
                apkMessageEl.textContent = apkEnabled ? "在线版本暂时获取失败，可稍后重试" : "Android 下载未在服务端启用";
                apkMessageEl.classList.remove("hidden");
              }
            }

            // ── macOS DMG version display ──
            var dmgSection = document.getElementById("macos-dmg-section");
            var dmgCurrentRow = document.getElementById("macos-dmg-current-row");
            var dmgCurrentEl = document.getElementById("settings-macos-dmg-current");
            var dmgGithubRow = document.getElementById("macos-dmg-github-row");
            var dmgGithubEl = document.getElementById("settings-macos-dmg-github");
            var dmgGithubBtn = document.getElementById("download-github-dmg-btn");
            var dmgLocalRow = document.getElementById("macos-dmg-local-row");
            var dmgLocalEl = document.getElementById("settings-macos-dmg-local");
            var dmgLocalBtn = document.getElementById("download-local-dmg-btn");
            var dmgMessageEl = document.getElementById("macos-dmg-message");
            var macosDmg = data.macosDmg || {};
            var isInMacApp = !!_macAppVersion;
            var dmgEnabled = macosDmg.enabled !== false;
            var hasDmgInfo = isInMacApp || (dmgEnabled && (!!macosDmg.github || !!macosDmg.local));
            if (dmgSection) {
              if (hasDmgInfo) dmgSection.classList.remove("hidden");
              else dmgSection.classList.add("hidden");
            }

            if (isInMacApp) {
              // ── macOS 壳内：显示当前版本 + 线上 + 本地 + 下载安装按钮 ──
              if (dmgCurrentRow && dmgCurrentEl) {
                dmgCurrentEl.textContent = "v" + _macAppVersion;
                dmgCurrentRow.classList.remove("hidden");
              }
              if (macosDmg.github && dmgGithubRow && dmgGithubEl) {
                var dghLabel = macosDmg.github.version ? ("v" + macosDmg.github.version) : macosDmg.github.fileName;
                if (typeof macosDmg.github.size === "number") dghLabel += " · " + formatBytes(macosDmg.github.size);
                dmgGithubEl.textContent = dghLabel;
                dmgGithubRow.classList.remove("hidden");
                if (dmgGithubBtn) {
                  var dghCmp = macosDmg.github.version ? compareVer(macosDmg.github.version, _macAppVersion) : 1;
                  applyApkButton(dmgGithubBtn, dghCmp, macosDmg.github.downloadUrl, macosDmg.github.fileName || "wand-update.dmg", "github", true);
                }
              }
              if (macosDmg.local && dmgLocalRow && dmgLocalEl) {
                var dlcLabel = macosDmg.local.version ? ("v" + macosDmg.local.version) : macosDmg.local.fileName;
                if (typeof macosDmg.local.size === "number") dlcLabel += " · " + formatBytes(macosDmg.local.size);
                dmgLocalEl.textContent = dlcLabel;
                dmgLocalRow.classList.remove("hidden");
                if (dmgLocalBtn) {
                  var dlcCmp = macosDmg.local.version ? compareVer(macosDmg.local.version, _macAppVersion) : 1;
                  applyApkButton(dmgLocalBtn, dlcCmp, macosDmg.local.downloadUrl, macosDmg.local.fileName || "wand-update.dmg", "local", true);
                }
              }
              if (!macosDmg.github && !macosDmg.local && dmgMessageEl) {
                dmgMessageEl.textContent = "暂无可用更新";
                dmgMessageEl.classList.remove("hidden");
              }
              var dmgAutoRow = document.getElementById("macos-auto-update-row");
              var dmgAutoHint = document.getElementById("macos-auto-update-hint");
              if (dmgAutoRow) dmgAutoRow.classList.remove("hidden");
              if (dmgAutoHint) dmgAutoHint.classList.remove("hidden");
            } else {
              // ── 浏览器模式：仅展示下载入口 ──
              if (macosDmg.github && dmgGithubRow && dmgGithubEl) {
                var dghLabel2 = macosDmg.github.version ? ("v" + macosDmg.github.version) : macosDmg.github.fileName;
                if (typeof macosDmg.github.size === "number") dghLabel2 += " · " + formatBytes(macosDmg.github.size);
                dmgGithubEl.textContent = dghLabel2;
                dmgGithubRow.classList.remove("hidden");
                if (dmgGithubBtn) {
                  dmgGithubBtn.textContent = "下载";
                  dmgGithubBtn.classList.remove("hidden");
                  dmgGithubBtn.onclick = function() {
                    window.open(macosDmg.github.downloadUrl, "_blank");
                    safeNotify("正在打开下载页…", "info");
                  };
                }
              }
              if (macosDmg.local && dmgLocalRow && dmgLocalEl) {
                var dlcLabel2 = macosDmg.local.version ? ("v" + macosDmg.local.version) : macosDmg.local.fileName;
                if (typeof macosDmg.local.size === "number") dlcLabel2 += " · " + formatBytes(macosDmg.local.size);
                dmgLocalEl.textContent = dlcLabel2;
                dmgLocalRow.classList.remove("hidden");
                if (dmgLocalBtn) {
                  dmgLocalBtn.textContent = "下载";
                  dmgLocalBtn.classList.remove("hidden");
                  dmgLocalBtn.onclick = function() {
                    triggerLocalDownload(macosDmg.local.downloadUrl, macosDmg.local.fileName || "wand-update.dmg", dmgLocalBtn);
                  };
                }
              }
              if (!macosDmg.github && !macosDmg.local && dmgMessageEl) {
                dmgMessageEl.textContent = dmgEnabled ? "在线版本暂时获取失败，可稍后重试" : "macOS 下载未在服务端启用";
                dmgMessageEl.classList.remove("hidden");
              }
            }

            // App connect code (encrypted)
            var connectCodeEl = document.getElementById("android-connect-code");
            var connectQrCanvas = document.getElementById("android-connect-qr");
            var connectQrEmpty = document.getElementById("android-connect-qr-empty");
            var connectQrWrap = document.getElementById("android-connect-qr-wrap");
            if (connectCodeEl) {
              connectCodeEl.textContent = "加载中...";
              if (connectQrEmpty) connectQrEmpty.textContent = "生成中…";
              if (connectQrCanvas) connectQrCanvas.style.visibility = "hidden";
              var connectCodeUrl = "/api/app-connect-code";
              if (window.location && window.location.origin) {
                connectCodeUrl += "?origin=" + encodeURIComponent(window.location.origin);
              }
              fetch(connectCodeUrl, { credentials: "same-origin" }).then(function(r) { return r.json(); }).then(function(d) {
                if (d.code) {
                  connectCodeEl.textContent = d.code;
                  state.androidConnectCode = d.code;
                  renderConnectQrCode(d.code);
                } else {
                  connectCodeEl.textContent = "生成失败";
                  if (connectQrEmpty) connectQrEmpty.textContent = "生成失败";
                }
              }).catch(function() {
                connectCodeEl.textContent = "获取失败";
                if (connectQrEmpty) connectQrEmpty.textContent = "获取失败";
              });
            }
            if (connectQrWrap && !connectQrWrap.dataset.bound) {
              connectQrWrap.dataset.bound = "1";
              connectQrWrap.addEventListener("click", function() {
                if (state.androidConnectCode) showConnectQrModal(state.androidConnectCode);
              });
            }

            // Config fields
            var cfg = data.config || {};
            var hostEl = document.getElementById("cfg-host") as HTMLInputElement | null;
            var portEl = document.getElementById("cfg-port") as HTMLInputElement | null;
            var httpsEl = document.getElementById("cfg-https") as HTMLInputElement | null;
            var modeEl = document.getElementById("cfg-mode") as HTMLSelectElement | null;
            var cwdEl = document.getElementById("cfg-cwd") as HTMLInputElement | null;
            var shellEl = document.getElementById("cfg-shell") as HTMLInputElement | null;
            if (hostEl) hostEl.value = cfg.host || "";
            if (portEl) portEl.value = cfg.port || "";
            if (httpsEl) httpsEl.checked = cfg.https === true;
            if (modeEl) modeEl.value = cfg.defaultMode || "default";
            if (cwdEl) cwdEl.value = cfg.defaultCwd || "";
            if (shellEl) shellEl.value = cfg.shell || "";
            var langEl = document.getElementById("cfg-language") as HTMLSelectElement | null;
            if (langEl) langEl.value = cfg.language || "";

            var srEl = document.getElementById("cfg-structured-runner") as HTMLSelectElement | null;
            if (srEl) srEl.value = cfg.structuredRunner || "cli";

            var inheritEnvEl = document.getElementById("cfg-inherit-env") as HTMLInputElement | null;
            if (inheritEnvEl) inheritEnvEl.checked = cfg.inheritEnv !== false;

            // Default model
            state.configDefaultModel = cfg.defaultModel || "";
            updateSettingsDefaultModelSelect();
            fetchAvailableModels().then(function() {
              updateSettingsDefaultModelSelect();
            }).catch(function() {});

            // Cert status
            var certStatus = document.getElementById("cert-status");
            if (certStatus) {
              certStatus.textContent = data.hasCert ? "已安装 SSL 证书" : "未安装证书（使用自签名或 HTTP）";
              certStatus.style.color = data.hasCert ? "var(--success)" : "var(--text-secondary)";
            }

            // Presets
            var presetsList = document.getElementById("presets-list");
            if (presetsList && cfg.commandPresets) {
              var html = "";
              for (var i = 0; i < cfg.commandPresets.length; i++) {
                var p = cfg.commandPresets[i];
                html += '<div class="preset-item">' +
                  '<span class="preset-label">' + escapeHtml(p.label) + '</span>' +
                  '<span class="preset-detail">' + escapeHtml(p.command) + (p.mode ? ' (' + escapeHtml(p.mode) + ')' : '') + '</span>' +
                '</div>';
              }
              if (!html) html = '<div class="empty-state-compact"><span class="empty-icon">\u2699</span><span>\u6ca1\u6709\u547d\u4ee4\u9884\u8bbe</span><span class="hint">\u5728 config.json \u7684 commandPresets \u4e2d\u914d\u7f6e</span></div>';
              presetsList.innerHTML = html;
            }

            // Card expand defaults
            var cd = cfg.cardDefaults || {};
            var cdEditEl = document.getElementById("cfg-card-edit") as HTMLInputElement | null;
            var cdInlineEl = document.getElementById("cfg-card-inline") as HTMLInputElement | null;
            var cdTerminalEl = document.getElementById("cfg-card-terminal") as HTMLInputElement | null;
            var cdThinkingEl = document.getElementById("cfg-card-thinking") as HTMLInputElement | null;
            var cdToolgroupEl = document.getElementById("cfg-card-toolgroup") as HTMLInputElement | null;
            if (cdEditEl) cdEditEl.checked = cd.editCards === true;
            if (cdInlineEl) cdInlineEl.checked = cd.inlineTools === true;
            if (cdTerminalEl) cdTerminalEl.checked = cd.terminal === true;
            if (cdThinkingEl) cdThinkingEl.checked = cd.thinking === true;
            if (cdToolgroupEl) cdToolgroupEl.checked = cd.toolGroup === true;
          })
          .catch(function() {});
      }

      export function saveConfigSettings() {
        var msgEl = document.getElementById("config-message");
        if (msgEl) { msgEl.classList.add("hidden"); msgEl.textContent = ""; }

        var body = {
          host: (document.getElementById("cfg-host") as HTMLInputElement | null || {} as any).value,
          port: Number((document.getElementById("cfg-port") as HTMLInputElement | null || {} as any).value),
          https: (document.getElementById("cfg-https") as HTMLInputElement | null || {} as any).checked,
          defaultMode: (document.getElementById("cfg-mode") as HTMLSelectElement | null || {} as any).value,
          defaultCwd: (document.getElementById("cfg-cwd") as HTMLInputElement | null || {} as any).value,
          shell: (document.getElementById("cfg-shell") as HTMLInputElement | null || {} as any).value,
          language: (document.getElementById("cfg-language") as HTMLSelectElement | null || {} as any).value || "",
          defaultModel: (document.getElementById("cfg-default-model") as HTMLSelectElement | null || {} as any).value || "",
          structuredRunner: (document.getElementById("cfg-structured-runner") as HTMLSelectElement | null || {} as any).value || "cli",
          inheritEnv: (document.getElementById("cfg-inherit-env") as HTMLInputElement | null || {} as any).checked !== false,
        };

        var previousDefaultModel = (state.config && state.config.defaultModel) || "";
        var nextDefaultModel = body.defaultModel || "";

        fetch("/api/settings/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body)
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (msgEl) {
            if (data.error) {
              msgEl.textContent = data.error;
              msgEl.style.color = "var(--error)";
            } else {
              msgEl.textContent = data.restartRequired
                ? "配置已保存，部分部署字段（host/port/https/shell）需要重启服务才生效。"
                : "配置已保存。";
              msgEl.style.color = "var(--success)";
            }
            msgEl.classList.remove("hidden");
          }
          if (!data || !data.error) {
            if (state.config) state.config.defaultModel = nextDefaultModel;
            state.configDefaultModel = nextDefaultModel;
            if (nextDefaultModel !== previousDefaultModel) {
              state.chatModel = "";
              try { localStorage.removeItem("wand-chat-model"); } catch (e) {}
              syncComposerModelSelect(getSelectedSession());
            }
          }
        })
        .catch(function() {
          if (msgEl) {
            msgEl.textContent = "保存失败。";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
        });
      }

      export function saveDisplaySettings() {
        var msgEl = document.getElementById("display-message");
        if (msgEl) { msgEl.classList.add("hidden"); msgEl.textContent = ""; }

        var body = {
          cardDefaults: {
            editCards: !!(document.getElementById("cfg-card-edit") as HTMLInputElement | null || {} as any).checked,
            inlineTools: !!(document.getElementById("cfg-card-inline") as HTMLInputElement | null || {} as any).checked,
            terminal: !!(document.getElementById("cfg-card-terminal") as HTMLInputElement | null || {} as any).checked,
            thinking: !!(document.getElementById("cfg-card-thinking") as HTMLInputElement | null || {} as any).checked,
            toolGroup: !!(document.getElementById("cfg-card-toolgroup") as HTMLInputElement | null || {} as any).checked,
          }
        };

        fetch("/api/settings/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body)
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (msgEl) {
            if (data.error) {
              msgEl.textContent = data.error;
              msgEl.style.color = "var(--error)";
            } else {
              msgEl.textContent = "显示设置已保存";
              msgEl.style.color = "var(--success)";
            }
            msgEl.classList.remove("hidden");
          }
          // Update local config so card defaults take effect immediately
          if (!data.error && state.config) {
            state.config.cardDefaults = body.cardDefaults;
          }
        })
        .catch(function() {
          if (msgEl) {
            msgEl.textContent = "保存失败。";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
        });
      }

      export function uploadCertificates() {
        var keyFile = document.getElementById("cert-key-file") as HTMLInputElement | null;
        var certFile = document.getElementById("cert-cert-file") as HTMLInputElement | null;
        var msgEl = document.getElementById("cert-message");
        if (msgEl) { msgEl.classList.add("hidden"); msgEl.textContent = ""; }

        if (!keyFile || !keyFile.files || !keyFile.files[0] || !certFile || !certFile.files || !certFile.files[0]) {
          if (msgEl) {
            msgEl.textContent = "请选择私钥和证书文件。";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
          return;
        }

        var keyReader = new FileReader();
        keyReader.onload = function() {
          var keyContent = keyReader.result;
          var certReader = new FileReader();
          certReader.onload = function() {
            var certContent = certReader.result;
            fetch("/api/settings/upload-cert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ key: keyContent, cert: certContent })
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (msgEl) {
                if (data.error) {
                  msgEl.textContent = data.error;
                  msgEl.style.color = "var(--error)";
                } else {
                  msgEl.textContent = "证书已上传，重启后生效。";
                  msgEl.style.color = "var(--success)";
                  // Update cert status
                  var certStatus = document.getElementById("cert-status");
                  if (certStatus) {
                    certStatus.textContent = "已安装 SSL 证书";
                    certStatus.style.color = "var(--success)";
                  }
                }
                msgEl.classList.remove("hidden");
              }
            })
            .catch(function() {
              if (msgEl) {
                msgEl.textContent = "上传失败。";
                msgEl.style.color = "var(--error)";
                msgEl.classList.remove("hidden");
              }
            });
          };
          certReader.readAsText(certFile.files[0]);
        };
        keyReader.readAsText(keyFile.files[0]);
      }

      export function checkForUpdate() {
        var latestEl = document.getElementById("settings-latest-version");
        var updateBtn = document.getElementById("do-update-button");
        var msgEl = document.getElementById("update-message");
        if (latestEl) latestEl.textContent = "检查中...";
        if (msgEl) msgEl.classList.add("hidden");
        if (updateBtn) updateBtn.classList.add("hidden");

        fetch("/api/check-update", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.error) {
              if (latestEl) latestEl.textContent = "检查失败";
              return;
            }
            var isBeta = data.channel === "beta";
            if (latestEl) latestEl.textContent = data.latest || (isBeta ? "beta 未发布" : "-");
            if (!data.latest) {
              if (msgEl) {
                msgEl.textContent = isBeta ? "无法读取 npm beta 版本。" : "无法连接到 npm registry。";
                msgEl.style.color = "var(--error)";
                msgEl.classList.remove("hidden");
              }
              return;
            }
            if (data.updateAvailable && updateBtn) {
              updateBtn.textContent = isBeta ? "更新到 Beta" : "更新到最新版";
              updateBtn.classList.remove("hidden");
            }
            if (!data.updateAvailable && msgEl) {
              msgEl.textContent = isBeta ? "已是最新 Beta 版本。" : "已是最新版本。";
              msgEl.style.color = "var(--success)";
              msgEl.classList.remove("hidden");
            }
          })
          .catch(function() {
            if (latestEl) latestEl.textContent = "检查失败";
          });
      }

      export function performUpdate() {
        var msgEl = document.getElementById("update-message");
        var updateBtn = document.getElementById("do-update-button") as HTMLButtonElement | null;
        if (!updateBtn) return;
        updateBtn.disabled = true;
        if (msgEl) {
          msgEl.textContent = "正在更新，请稍候...";
          msgEl.style.color = "var(--text-secondary)";
          msgEl.classList.remove("hidden");
        }

        fetch("/api/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin"
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (msgEl) {
              msgEl.textContent = data.error;
              msgEl.style.color = "var(--error)";
              msgEl.classList.remove("hidden");
            }
            updateBtn.disabled = false;
            return;
          }
          // \u5b89\u88c5\u6210\u529f\uff1a\u81ea\u52a8\u8c03\u7528 /api/restart\uff0c\u8ba9\u670d\u52a1\u91cd\u542f\u751f\u6548\uff0c
          // \u9875\u9762\u4f1a\u88ab restart overlay \u63a5\u624b\uff0c\u7b49\u540e\u7aef\u56de\u6765\u540e\u81ea\u52a8\u5237\u65b0\u3002
          if (msgEl) {
            msgEl.textContent = (data.message || "\u66f4\u65b0\u5b8c\u6210") + "\uff0c\u6b63\u5728\u91cd\u542f\u670d\u52a1\u2026";
            msgEl.style.color = "var(--success)";
            msgEl.classList.remove("hidden");
          }
          updateBtn.classList.add("hidden");
          if (data.detachedUpdate) {
            showRestartOverlay();
          } else if (data.restartRequired !== false) {
            performRestart(null, msgEl);
          } else {
            // \u670d\u52a1\u7aef\u660e\u786e\u8868\u793a\u4e0d\u9700\u8981\u91cd\u542f\uff0c\u4fdd\u7559\u624b\u52a8\u91cd\u542f\u6309\u94ae
            var restartBtn = document.getElementById("do-restart-button");
            if (restartBtn) restartBtn.classList.remove("hidden");
          }
        })
        .catch(function() {
          if (msgEl) {
            msgEl.textContent = "\u66f4\u65b0\u5931\u8d25\u3002";
            msgEl.style.color = "var(--error)";
            msgEl.classList.remove("hidden");
          }
          updateBtn.disabled = false;
        });
      }

      export function performSettingsRestart() {
        var restartBtn = document.getElementById("do-restart-button") as HTMLButtonElement | null;
        var msgEl = document.getElementById("update-message");
        performRestart(restartBtn, msgEl);
      }

      export function checkApkAutoUpdate() {
        fetch("/api/auto-update", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(autoData) {
            if (!autoData.apk) return;
            // Auto-update is enabled, check for APK update
            return fetch("/api/android-apk-update?currentVersion=" + encodeURIComponent(_apkVersion), { credentials: "same-origin" })
              .then(function(res) { return res.json(); })
              .then(function(data) {
                if (!data.updateAvailable || !data.downloadUrl) return;
                try {
                  WandNative.downloadUpdate(data.downloadUrl, data.fileName || "wand-update.apk", data.source || "local");
                } catch (_e) {}
              });
          })
          .catch(function() {});
      }

      export function checkDmgAutoUpdate() {
        if (!_macAppVersion) return;
        fetch("/api/auto-update", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(autoData) {
            if (!autoData.dmg) return;
            return fetch("/api/macos-dmg-update?currentVersion=" + encodeURIComponent(_macAppVersion), { credentials: "same-origin" })
              .then(function(res) { return res.json(); })
              .then(function(data) {
                if (!data.updateAvailable || !data.downloadUrl) return;
                try {
                  WandNative.downloadUpdate(data.downloadUrl, data.fileName || "wand-update.dmg", data.source || "local");
                } catch (_e) {}
              });
          })
          .catch(function() {});
      }

      export function toggleAutoUpdate(type, enabled) {
        var body = {};
        body[type] = enabled;
        fetch("/api/auto-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          // Sync toggle state with server response
          var webToggle = document.getElementById("auto-update-web-toggle") as HTMLInputElement | null;
          var apkToggle = document.getElementById("auto-update-apk-toggle") as HTMLInputElement | null;
          var dmgToggle = document.getElementById("auto-update-dmg-toggle") as HTMLInputElement | null;
          if (webToggle) webToggle.checked = !!data.web;
          if (apkToggle) apkToggle.checked = !!data.apk;
          if (dmgToggle) dmgToggle.checked = !!data.dmg;
        })
        .catch(function() {
          // Revert toggle on failure
          var toggle = document.getElementById("auto-update-" + type + "-toggle") as HTMLInputElement | null;
          if (toggle) toggle.checked = !enabled;
        });
      }

      export function setUpdateChannel(channel) {
        fetch("/api/update-channel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ channel: channel }),
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          var toggle = document.getElementById("beta-channel-toggle") as HTMLInputElement | null;
          if (toggle) toggle.checked = data.channel === "beta";
          // 切换通道后重新检查更新，刷新"最新版本"显示与更新按钮。
          checkForUpdate();
        })
        .catch(function() {
          var toggle = document.getElementById("beta-channel-toggle") as HTMLInputElement | null;
          if (toggle) toggle.checked = channel !== "beta";
        });
      }

      // ── Notification Settings Helpers ──

      export function _updateAppIconSelection(activeIcon) {
        var opts = document.querySelectorAll(".settings-app-icon-option");
        for (var i = 0; i < opts.length; i++) {
          var isActive = opts[i].getAttribute("data-icon") === activeIcon;
          opts[i].classList.toggle("selected", isActive);
          opts[i].setAttribute("aria-pressed", isActive ? "true" : "false");
        }
      }

      export function updateNotificationStatus() {
        var statusEl = document.getElementById("notification-permission-status");
        var requestBtn = document.getElementById("notification-request-btn");
        var resetBtn = document.getElementById("notification-reset-btn");
        var testMsgEl = document.getElementById("notification-test-message");
        if (!statusEl) return;

        // Determine permission state: native bridge or browser API
        var perm = _getNativePermission();
        if (perm === null) {
          // No native bridge — fall back to browser Notification API
          if (typeof Notification === "undefined") {
            statusEl.textContent = "\u4e0d\u652f\u6301";
            statusEl.style.color = "var(--fg-muted)";
            if (requestBtn) requestBtn.classList.add("hidden");
            if (resetBtn) resetBtn.classList.add("hidden");
            return;
          }
          perm = Notification.permission;
        }

        if (perm === "granted") {
          statusEl.textContent = "\u5df2\u6388\u6743 \u2713";
          statusEl.style.color = "var(--success)";
          if (requestBtn) requestBtn.classList.add("hidden");
          if (resetBtn) resetBtn.classList.add("hidden");
        } else if (perm === "denied") {
          statusEl.textContent = "\u5df2\u62d2\u7edd";
          statusEl.style.color = "var(--danger)";
          if (requestBtn) requestBtn.classList.add("hidden");
          if (resetBtn) resetBtn.classList.remove("hidden");
        } else {
          statusEl.textContent = "\u672a\u6388\u6743";
          statusEl.style.color = "var(--warning)";
          if (requestBtn) requestBtn.classList.remove("hidden");
          if (resetBtn) resetBtn.classList.remove("hidden");
        }
      }

      export function resetNotificationPermission() {
        var testMsgEl = document.getElementById("notification-test-message");

        // Native bridge path — trigger Android system permission dialog
        if (_hasNativeBridge) {
          // Listen for permission result callback from native
          window._onNativePermissionResult = function(result) {
            updateNotificationStatus();
            if (testMsgEl) {
              if (result === "granted") {
                testMsgEl.textContent = "\u2713 \u5df2\u6388\u6743";
                testMsgEl.style.color = "var(--success)";
              } else {
                testMsgEl.textContent = "\u2717 \u672a\u6388\u6743\uff0c\u8bf7\u5728\u7cfb\u7edf\u8bbe\u7f6e\u4e2d\u5f00\u542f Wand \u7684\u901a\u77e5\u6743\u9650";
                testMsgEl.style.color = "var(--danger)";
              }
              testMsgEl.classList.remove("hidden");
            }
            delete window._onNativePermissionResult;
          };
          try { WandNative.requestPermission(); } catch (_e) {}
          return;
        }

        if (typeof Notification === "undefined") return;

        // Always call requestPermission — this triggers the browser's native
        // permission dialog when allowed. In "default" state it always works.
        // In "denied" state, some browsers (newer Chrome) re-prompt, others don't.
        Notification.requestPermission().then(function(result) {
          updateNotificationStatus();
          if (result === "granted") {
            if (testMsgEl) {
              testMsgEl.textContent = "\u2713 \u5df2\u6388\u6743";
              testMsgEl.style.color = "var(--success)";
              testMsgEl.classList.remove("hidden");
            }
          } else if (result === "denied") {
            // Browser blocked re-prompting — show inline guide with site-settings shortcut
            if (testMsgEl) {
              var origin = location.origin;
              testMsgEl.innerHTML =
                "\u6d4f\u89c8\u5668\u5df2\u62e6\u622a\u6388\u6743\u5f39\u7a97\uff0c\u8bf7\u624b\u52a8\u91cd\u7f6e\uff1a<br>" +
                '<span style="display:inline-flex;align-items:center;gap:4px;margin:4px 0">' +
                  "\u2460 \u70b9\u51fb\u5730\u5740\u680f\u5de6\u4fa7\u7684 " +
                  '<span style="display:inline-flex;align-items:center;justify-content:center;' +
                    "width:16px;height:16px;border-radius:50%;border:1px solid var(--border);" +
                    'font-size:11px;vertical-align:middle">i</span>' +
                  " \u6216\u9501\u56fe\u6807" +
                "</span><br>" +
                "\u2461 \u627e\u5230\u300c\u901a\u77e5\u300d\u2192 \u6539\u4e3a\u300c\u5141\u8bb8\u300d<br>" +
                "\u2462 \u5237\u65b0\u9875\u9762\u5373\u53ef";
              testMsgEl.style.color = "var(--fg-muted)";
              testMsgEl.classList.remove("hidden");
            }
          }
        });
      }

      export function resetDelayedNotificationButton() {
        var delayBtn = document.getElementById("notification-test-delay-btn") as HTMLButtonElement | null;
        if (!delayBtn) return;
        delayBtn.disabled = false;
        delayBtn.textContent = "10 秒后发送";
      }

      export function scheduleTestNotification() {
        var testMsgEl = document.getElementById("notification-test-message");
        if (state.delayedNotificationTimer) {
          clearTimeout(state.delayedNotificationTimer);
          state.delayedNotificationTimer = null;
        }
        var delayBtn = document.getElementById("notification-test-delay-btn") as HTMLButtonElement | null;
        if (delayBtn) {
          delayBtn.disabled = true;
          delayBtn.textContent = "已安排（10s）";
        }
        if (testMsgEl) {
          testMsgEl.innerHTML = "已安排 10 秒后发送测试通知，请切到后台等待。";
          testMsgEl.style.color = "var(--text-secondary)";
          testMsgEl.classList.remove("hidden");
        }
        state.delayedNotificationTimer = setTimeout(function() {
          state.delayedNotificationTimer = null;
          resetDelayedNotificationButton();
          testNotification();
        }, 10000);
      }

      export function testNotification() {
        var testMsgEl = document.getElementById("notification-test-message");
        var results = [];
        if (state.delayedNotificationTimer) {
          clearTimeout(state.delayedNotificationTimer);
          state.delayedNotificationTimer = null;
          resetDelayedNotificationButton();
        }

        // 1. Test sound playback
        var soundOk = tryPlayNotificationSound();
        results.push(soundOk ? "\u2713 \u63d0\u793a\u97f3" : "\u2717 \u63d0\u793a\u97f3\uff08\u65e0\u6cd5\u64ad\u653e\uff09");

        // 2. Test in-app bubble
        var bubbleEnabled = state.notifBubble;
        showNotificationBubble({
          title: "\u6d4b\u8bd5\u901a\u77e5",
          body: "\u8fd9\u662f\u4e00\u6761\u6d4b\u8bd5\u901a\u77e5\u3002",
          type: "info",
          icon: "\u266a",
          duration: 5000,
          playSound: false, // sound already played above
        });
        results.push(bubbleEnabled ? "\u2713 \u5e94\u7528\u5185\u6c14\u6ce1" : "\u2013 \u5e94\u7528\u5185\u6c14\u6ce1\uff08\u5df2\u5173\u95ed\uff09");

        // 3. Test system notification (native bridge or browser API)
        if (_hasNativeBridge) {
          var nativePerm = _getNativePermission();
          if (nativePerm === "granted") {
            try {
              WandNative.sendNotification("Wand \u6d4b\u8bd5\u901a\u77e5", "\u7cfb\u7edf\u901a\u77e5\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002", "wand-test");
              results.push("\u2713 \u7cfb\u7edf\u901a\u77e5");
            } catch (_e) {
              results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u53d1\u9001\u5931\u8d25\uff09");
            }
          } else if (nativePerm === "denied") {
            results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u62d2\u7edd\uff0c\u8bf7\u5728\u7cfb\u7edf\u8bbe\u7f6e\u4e2d\u5f00\u542f\uff09");
          } else {
            // "default" — request permission, then report
            window._onNativePermissionResult = function(result) {
              updateNotificationStatus();
              if (result === "granted") {
                try {
                  WandNative.sendNotification("Wand \u6d4b\u8bd5\u901a\u77e5", "\u7cfb\u7edf\u901a\u77e5\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002", "wand-test");
                  results.push("\u2713 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u6388\u6743\uff09");
                } catch (_e2) {
                  results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u53d1\u9001\u5931\u8d25\uff09");
                }
              } else {
                results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u672a\u6388\u6743\uff09");
              }
              showTestResults(testMsgEl, results);
              delete window._onNativePermissionResult;
            };
            try { WandNative.requestPermission(); } catch (_e) {}
            return; // async — results shown in callback
          }
          showTestResults(testMsgEl, results);
          return;
        }

        if (typeof Notification === "undefined") {
          results.push("\u2013 \u7cfb\u7edf\u901a\u77e5\uff08\u4e0d\u652f\u6301\uff09");
          showTestResults(testMsgEl, results);
          return;
        }

        var perm = Notification.permission;
        if (perm === "granted") {
          try {
            var n = new Notification("Wand \u6d4b\u8bd5\u901a\u77e5", {
              body: "\u7cfb\u7edf\u901a\u77e5\u5df2\u6b63\u5e38\u5de5\u4f5c\u3002",
              icon: "/favicon.ico",
              tag: "wand-test",
            });
            setTimeout(function() { n.close(); }, 5000);
            results.push("\u2713 \u7cfb\u7edf\u901a\u77e5");
          } catch (_e) {
            results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u53d1\u9001\u5931\u8d25\uff0c\u53ef\u80fd\u9700\u8981 HTTPS\uff09");
          }
          showTestResults(testMsgEl, results);
        } else if (perm === "denied") {
          results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u62d2\u7edd\uff09");
          showTestResults(testMsgEl, results);
        } else {
          // "default" — try requesting
          Notification.requestPermission().then(function(result) {
            updateNotificationStatus();
            if (result === "granted") {
              results.push("\u2713 \u7cfb\u7edf\u901a\u77e5\uff08\u5df2\u6388\u6743\uff09");
            } else {
              results.push("\u2717 \u7cfb\u7edf\u901a\u77e5\uff08\u672a\u6388\u6743\uff09");
            }
            showTestResults(testMsgEl, results);
          });
        }
      }

      export function showTestResults(el, results) {
        if (!el) return;
        el.innerHTML = results.map(function(r) { return escapeHtml(r); }).join("<br>");
        // color based on whether all passed
        var allOk = results.every(function(r) { return r.indexOf("\u2713") === 0 || r.indexOf("\u2013") === 0; });
        el.style.color = allOk ? "var(--success)" : "var(--warning)";
        el.classList.remove("hidden");
      }

      // 创建 PTY 会话时把当前终端的真实 cols/rows 注入 body，让后端 pty.spawn
      // 直接落在正确尺寸下。否则 PTY 先按 cols=120 启动，Claude/Codex 会基于
      // 120 列输出 \x1b[120G 这类绝对列定位序列；等前端 remeasure 触发 resize
      // 时这些早期内容已经被以 80 等真实列数渲染，整条历史就错位。
      export function withTerminalDimensions(body) {
        if (!body || typeof body !== "object") return body;
        if (!state.terminal) return body;
        try {
          if (typeof state.terminal.remeasure === "function") {
            state.terminal.remeasure();
          }
        } catch (e) {}
        var cols = state.terminal.cols;
        var rows = state.terminal.rows;
        if (typeof cols === "number" && typeof rows === "number"
            && Number.isFinite(cols) && Number.isFinite(rows)
            && cols > 0 && rows > 0) {
          body.cols = cols;
          body.rows = rows;
        }
        return body;
      }

      // 会话创建路径：保证 wterm 已经按真实容器尺寸校准，再向服务端 POST
      // 新会话——否则 withTerminalDimensions 拿不到 cols/rows，body 不带尺寸
      // → 服务端兜底 120/36 → Claude 按 120 列画 banner/box → wterm 实际渲
      // 染宽 ≠ 120 → 横线断行（图 1 现象）。带 2s 兜底超时，避免
      // initTerminal 失败时 UI 永久卡在"创建会话"按钮。
      export function ensureTerminalReady() {
        if (state.terminal && state.terminal.cols) return Promise.resolve();
        return new Promise<void>(function(resolve) {
          var done = false;
          var settle = function() { if (!done) { done = true; resolve(); } };
          var hardTimeout = setTimeout(settle, 2000);
          try { initTerminal(); } catch (e) {}
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              if (state.terminal && state.terminal.cols) {
                clearTimeout(hardTimeout);
                settle();
              }
            });
          });
        });
      }

      export function quickStartSession() {
        var command = getPreferredTool();
        var defaultCwd = getEffectiveCwd();
        var defaultMode = getSafeModeForTool(command, (state.config && state.config.defaultMode) ? state.config.defaultMode : "default");
        state.preferredCommand = command;
        state.chatMode = getSafeModeForTool(command, state.chatMode);
        ensureTerminalReady().then(function() {
          return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({ command: command, provider: command, cwd: defaultCwd, mode: defaultMode }))
        });
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return;
          }
          state.selectedId = data.id;
          persistSelectedId();
          state.drafts[data.id] = "";
          resetChatRenderCache();
          return refreshAll();
        })
        .then(function() { focusInputBox(true); })
        .catch(function() {
          showToast("无法启动会话。", "error");
        });
      }

      export var _sessionCreating = false;

      export function runCommand() {
        if (_sessionCreating) return;
        var cwdEl = document.getElementById("cwd") as HTMLInputElement | null;
        var errorEl = document.getElementById("modal-error");
        var command = getPreferredTool();
        var sessionKind = state.sessionCreateKind || "structured";
        var worktreeEnabled = state.sessionCreateWorktree === true;

        hideError(errorEl);

        var defaultCwd = getEffectiveCwd();
        var cwd = (cwdEl ? cwdEl.value.trim() : "") || defaultCwd;
        var selectedMode = getSafeModeForTool(command, state.modeValue);

        if (sessionKind === "structured") {
          startStructuredSessionFromModal(cwd, selectedMode, worktreeEnabled, errorEl);
          return;
        }

        runPtyCommandFromModal(command, cwd, selectedMode, worktreeEnabled, errorEl);
      }

      export function startStructuredSessionFromModal(cwd, mode, worktreeEnabled, errorEl) {
        var provider = state.sessionTool === "codex" ? "codex" : "claude";
        _sessionCreating = true;
        state.modeValue = mode;
        state.chatMode = mode;
        state.sessionTool = provider;
        state.preferredCommand = provider;
        syncComposerModeSelect();
        syncComposerModelSelect(getSelectedSession());
        return createStructuredSession(undefined, cwd, mode, worktreeEnabled)
          .then(function(data) {
            saveWorkingDir(cwd);
            closeSessionModal();
            // 桌面常驻栏要保留：用户刚建完会话，希望左侧栏继续看到列表里的新条目，
            // 不能因为模态关闭顺手把 sidebarPinned 抹掉让侧栏整体消失。
            dismissDrawerIfOverlay();
            return data;
          })
          .then(function() { focusInputBox(true); })
          .catch(function(error) {
            showError(errorEl, (error && error.message) || "无法启动结构化会话，请确认 Claude 已正确安装。");
          })
          .finally(function() { _sessionCreating = false; });
      }

      export function runPtyCommandFromModal(command, cwd, mode, worktreeEnabled, errorEl) {
        _sessionCreating = true;
        state.modeValue = mode;
        state.chatMode = mode;
        state.sessionTool = command;
        state.preferredCommand = command;
        syncComposerModeSelect();

        ensureTerminalReady().then(function() {
          return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({
            command: command,
            provider: command,
            cwd: cwd,
            mode: mode,
            worktreeEnabled: worktreeEnabled
          }))
        });
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showError(errorEl, data.error);
            return;
          }
          state.selectedId = data.id;
          persistSelectedId();
          saveWorkingDir(cwd);
          state.drafts[data.id] = "";
          resetChatRenderCache();
          closeSessionModal();
          // 同 structured 路径：模态关闭后只收手机端的 overlay，保留桌面常驻侧栏。
          dismissDrawerIfOverlay();
          return refreshAll();
        })
        .then(function() {
          if (state.selectedId) {
            selectSession(state.selectedId);
          } else {
            focusInputBox(true);
          }
        })
        .catch(function() {
          showError(errorEl, command === "codex"
            ? "无法启动 Codex 会话，请确认 codex 已正确安装并可在终端中执行。"
            : "无法启动 Claude 会话，请确认 Claude 已正确安装。");
        })
        .finally(function() { _sessionCreating = false; });
      }

      export function initBlankChatCwd() {
        var cwdEl = document.getElementById("blank-chat-cwd");
        if (!cwdEl) return;
        cwdEl.addEventListener("click", toggleBlankChatCwdDropdown);
        cwdEl.addEventListener("keydown", function(e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleBlankChatCwdDropdown();
          }
        });
        document.addEventListener("click", function(e) {
          var dropdown = document.getElementById("blank-chat-cwd-dropdown");
          if (!dropdown || dropdown.classList.contains("hidden")) return;
          if (!(e.target as HTMLElement).closest(".blank-chat-cwd-wrap")) {
            dropdown.classList.add("hidden");
            var arrow = document.getElementById("blank-chat-cwd-arrow");
            if (arrow) arrow.textContent = "▼";
          }
        });
      }

      export function toggleBlankChatCwdDropdown() {
        var dropdown = document.getElementById("blank-chat-cwd-dropdown");
        var arrow = document.getElementById("blank-chat-cwd-arrow");
        if (!dropdown) return;
        var isHidden = dropdown.classList.contains("hidden");
        if (isHidden) {
          loadBlankChatCwdDropdown(dropdown);
          dropdown.classList.remove("hidden");
          if (arrow) arrow.textContent = "▲";
        } else {
          dropdown.classList.add("hidden");
          if (arrow) arrow.textContent = "▼";
        }
      }

      export function loadBlankChatCwdDropdown(dropdown) {
        var defaultCwd = getConfigCwd();
        dropdown.innerHTML = '<div class="blank-chat-cwd-loading">加载中...</div>';
        fetchRecentPaths(function(items) {
            var html = "";
            var currentDir = state.workingDir || defaultCwd;
            html += '<div class="blank-chat-cwd-item' + (currentDir === defaultCwd ? " active" : "") + '" data-path="' + escapeHtml(defaultCwd) + '">' +
              '<span class="blank-chat-cwd-item-label">默认</span>' +
              '<span class="blank-chat-cwd-item-path">' + escapeHtml(defaultCwd) + '</span>' +
            '</div>';
            if (items.length) {
              var seen = {};
              seen[defaultCwd] = true;
              items.forEach(function(item) {
                if (seen[item.path]) return;
                seen[item.path] = true;
                html += '<div class="blank-chat-cwd-item' + (currentDir === item.path ? " active" : "") + '" data-path="' + escapeHtml(item.path) + '">' +
                  '<span class="blank-chat-cwd-item-path">' + escapeHtml(item.path) + '</span>' +
                '</div>';
              });
            }
            dropdown.innerHTML = html;
            dropdown.querySelectorAll(".blank-chat-cwd-item").forEach(function(el) {
              el.addEventListener("click", function(e) {
                e.stopPropagation();
                var path = (el as HTMLElement).dataset.path;
                state.workingDir = path;
                try { localStorage.setItem("wand-working-dir", path); } catch(e) {}
                var pathEl = document.getElementById("blank-chat-cwd-path");
                if (pathEl) pathEl.textContent = path;
                dropdown.classList.add("hidden");
                var arrow = document.getElementById("blank-chat-cwd-arrow");
                if (arrow) arrow.textContent = "▼";
                var fpInput = document.getElementById("folder-picker-input") as HTMLInputElement | null;
                if (fpInput) fpInput.value = path;
              });
            });
        });
      }

      export function loadRecentPathBubbles() {
        var container = document.getElementById("recent-paths-bubbles");
        if (!container) return;
        fetchRecentPaths(function(items) {
            if (!items.length) {
              container.innerHTML = "";
              return;
            }
            container.innerHTML = items.map(function(item) {
              return '<button class="recent-path-bubble" data-path="' + escapeHtml(item.path) + '" title="' + escapeHtml(item.path) + '">' +
                escapeHtml(item.name) +
              '</button>';
            }).join("");
            container.querySelectorAll(".recent-path-bubble").forEach(function(el) {
              el.addEventListener("click", function() {
                var cwdEl = document.getElementById("cwd") as HTMLInputElement | null;
                if (cwdEl) {
                  cwdEl.value = (el as HTMLElement).dataset.path || "";
                  state.cwdValue = (el as HTMLElement).dataset.path || "";
                }
              });
            });
        });
      }

      export function schedulePathSuggestions() {
        if (state.suggestionTimer) clearTimeout(state.suggestionTimer);
        state.suggestionTimer = setTimeout(loadPathSuggestions, 120);
      }

      export function loadPathSuggestions() {
        var modal = document.getElementById("session-modal");
        if (modal && modal.classList.contains("hidden")) {
          hidePathSuggestions();
          return;
        }

        var cwdEl = document.getElementById("cwd") as HTMLInputElement | null;
        if (!cwdEl) return;

        fetch("/api/path-suggestions?q=" + encodeURIComponent(cwdEl.value.trim()), { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(renderPathSuggestions)
          .catch(hidePathSuggestions);
      }

      export function renderPathSuggestions(items) {
        var container = document.getElementById("cwd-suggestions");
        if (!container || !items.length) {
          hidePathSuggestions();
          return;
        }

        container.innerHTML = items.map(function(item) {
          return '<button class="suggestion-item" data-path="' + escapeHtml(item.path) + '">' +
            '<strong>' + escapeHtml(item.name) + '</strong>' +
            '<small>' + escapeHtml(item.path) + '</small>' +
          '</button>';
        }).join("");

        container.querySelectorAll(".suggestion-item").forEach(function(el) {
          el.addEventListener("click", function() {
            (document.getElementById("cwd") as HTMLInputElement).value = (el as HTMLElement).dataset.path || "";
            state.cwdValue = (el as HTMLElement).dataset.path || "";
            hidePathSuggestions();
          });
        });

        container.classList.remove("hidden");
      }

      export function hidePathSuggestions() {
        var container = document.getElementById("cwd-suggestions");
        if (container) {
          container.classList.add("hidden");
          container.innerHTML = "";
        }
      }

      export function handleInputBoxKeydown(event) {
        if (event.isComposing) return;

        if (shouldCaptureTerminalEvent(event)) {
          captureTerminalInput(event);
          return;
        }

        if (event.key === "Enter") {
          if (event.shiftKey) {
            event.preventDefault();
            var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
            if (inputBox) {
              var start = inputBox.selectionStart || 0;
              var current = inputBox.value;
              var newValue = current.slice(0, start) + String.fromCharCode(10) + current.slice(start);
              inputBox.value = newValue;
              // Move cursor to after the inserted newline
              inputBox.selectionStart = start + 1;
              inputBox.selectionEnd = start + 1;
              setDraftValue(newValue, true);
              autoResizeInput(inputBox);
            }
            return;
          }
          event.preventDefault();
          // Cmd/Ctrl+Enter → 立即发送（中断当前回复）。仅对正在 inFlight 的
          // 结构化会话生效；其它情况下退化为普通发送，避免无谓的中断信号。
          var interruptShortcut = !!(event.metaKey || event.ctrlKey);
          sendInputFromBox(interruptShortcut ? { interrupt: true } : undefined);
          return;
        }

        if (event.key === "Backspace") {
          // Let default behavior handle the deletion, then sync state
          setTimeout(function() {
            var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
            if (inputBox) {
              setDraftValue(inputBox.value, true);
            }
          }, 0);
          return;
        }

        if (event.key === "Tab") {
          event.preventDefault();
          var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
          if (inputBox) {
            var start = inputBox.selectionStart || 0;
            var current = inputBox.value;
            var newValue = current.slice(0, start) + String.fromCharCode(9) + current.slice(start);
            inputBox.value = newValue;
            setDraftValue(newValue, true);
          }
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          var escSess = getSelectedSession();
          if (isStructuredSession(escSess)) {
            // INPUT-2: 结构化会话没有 PTY，Esc 不能把 \x1b 当消息发给 Claude。
            // 用户语义 Esc=中断：正在生成时等同点"停止"按钮，否则无操作。
            if (escSess && escSess.structuredState && escSess.structuredState.inFlight) {
              stopSession();
            }
          } else {
            queueDirectInput(getControlInput("escape"), "escape");
          }
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
          // COPY-2: 有选区（输入框内或终端输出区）时放行浏览器原生复制，而不是发
          // SIGINT。原实现只看输入框选区，漏了文档级终端选区。
          var inputBoxC = document.getElementById("input-box") as HTMLTextAreaElement | null;
          var hasSelectionC = (inputBoxC && inputBoxC.selectionStart !== inputBoxC.selectionEnd)
            || hasActiveTerminalSelection();
          if (hasSelectionC) {
            return; // Let browser handle copy
          }
          var ccSess = getSelectedSession();
          if (isStructuredSession(ccSess)) {
            // INPUT-2: 结构化会话不把 SIGINT(\x03) 当消息发给 Claude。Ctrl+C 视为
            // 中断当前生成（等同停止按钮），非生成态则无操作。
            event.preventDefault();
            if (ccSess && ccSess.structuredState && ccSess.structuredState.inFlight) {
              stopSession();
            }
            return;
          }
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_c"), "ctrl_c");
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
          // COPY-2: 有选区（输入框内或终端输出区）时放行浏览器复制。
          var inputBox2 = document.getElementById("input-box") as HTMLTextAreaElement | null;
          var hasSelection2 = (inputBox2 && (inputBox2.selectionStart !== inputBox2.selectionEnd))
            || hasActiveTerminalSelection();
          if (hasSelection2) {
            return; // Let browser handle copy
          }
          var cdSess = getSelectedSession();
          if (isStructuredSession(cdSess)) {
            // INPUT-2: 结构化会话吞掉 Ctrl+D（EOF 对 Claude 对话无意义，别当消息发）
            event.preventDefault();
            return;
          }
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_d"), "ctrl_d");
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          var clSess = getSelectedSession();
          if (isStructuredSession(clSess)) {
            // INPUT-2: 结构化会话吞掉 Ctrl+L（清屏对 Claude 对话无意义）
            return;
          }
          queueDirectInput(getControlInput("ctrl_l"), "ctrl_l");
          return;
        }

        // Cmd+A / Ctrl+A: Select all (let browser handle)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          // Let browser handle select-all
          return;
        }

        // Cmd+V / Ctrl+V: Paste (let browser handle)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
          // Let browser handle paste
          return;
        }

        // Cmd+X / Ctrl+X: Cut (let browser handle when text selected)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "x") {
          var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
          var hasSelection = inputBox && (inputBox.selectionStart !== inputBox.selectionEnd);
          if (hasSelection) {
            // Let browser handle cut
            return;
          }
          // No selection: send Ctrl+X to terminal (rare case)
          event.preventDefault();
          queueDirectInput(String.fromCharCode(24), "ctrl_x"); // Ctrl+X = 0x18
          return;
        }

        // Let browser handle all other keys naturally (including arrows, home, end, etc.)
        // Sync state after default behavior for character keys
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          setTimeout(function() {
            var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
            if (inputBox) {
              setDraftValue(inputBox.value);
            }
          }, 0);
        }
      }

      // ── Attachment helpers ──

      export var ATTACH_MAX_SIZE = 10 * 1024 * 1024;

      export function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
      }

      export function isImageType(type) {
        return /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)/.test(type);
      }

      export function addPendingAttachment(file) {
        if (!file) return;
        if (file.size > ATTACH_MAX_SIZE) {
          showToast("文件过大（上限 10 MB）: " + file.name, "error");
          return;
        }
        var entry = { file: file, name: file.name, size: file.size, previewUrl: null };
        if (isImageType(file.type)) {
          entry.previewUrl = URL.createObjectURL(file);
        }
        state.pendingAttachments.push(entry);
        renderAttachmentPreview();
      }

      export function removePendingAttachment(index) {
        var removed = state.pendingAttachments.splice(index, 1);
        if (removed.length && removed[0].previewUrl) {
          URL.revokeObjectURL(removed[0].previewUrl);
        }
        renderAttachmentPreview();
      }

      export function clearAttachments() {
        state.pendingAttachments.forEach(function(a) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        });
        state.pendingAttachments = [];
        renderAttachmentPreview();
      }

      export function renderAttachmentPreview() {
        var bar = document.getElementById("attachment-preview");
        if (!bar) return;
        var items = state.pendingAttachments;
        if (items.length === 0) {
          bar.classList.add("hidden");
          bar.innerHTML = "";
          return;
        }
        bar.classList.remove("hidden");
        var html = "";
        for (var i = 0; i < items.length; i++) {
          var a = items[i];
          var thumb = a.previewUrl
            ? '<img src="' + escapeHtml(a.previewUrl) + '" alt="">'
            : '<span class="att-icon">' + iconSvg("file", { size: 13, strokeWidth: 1.7 }) + '</span>';
          html += '<span class="attachment-pill" data-index="' + i + '">' +
            thumb +
            '<span class="att-name" title="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</span>' +
            '<span class="att-size">' + formatFileSize(a.size) + '</span>' +
            '<button class="att-remove" data-index="' + i + '" title="移除">×</button>' +
            '</span>';
        }
        bar.innerHTML = html;
        bar.querySelectorAll(".att-remove").forEach(function(btn) {
          btn.addEventListener("click", function(e) {
            e.preventDefault();
            e.stopPropagation();
            removePendingAttachment(parseInt(btn.getAttribute("data-index"), 10));
          });
        });
      }

      export function uploadAttachments(sessionId) {
        if (!state.pendingAttachments.length) return Promise.resolve([]);
        var formData = new FormData();
        state.pendingAttachments.forEach(function(a) {
          formData.append("files", a.file, a.name);
        });
        return fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/upload", {
          method: "POST",
          body: formData,
          credentials: "same-origin"
        }).then(function(resp) {
          if (!resp.ok) return resp.json().then(function(e) { throw new Error(e.error || "上传失败"); });
          return resp.json();
        }).then(function(data) {
          return data.files || [];
        });
      }

      export function buildAttachmentPrefix(uploadedFiles) {
        if (!uploadedFiles || !uploadedFiles.length) return "";
        var paths = uploadedFiles.map(function(f) { return f.savedPath; });
        return "[附件已上传，请查看以下文件:\n" + paths.join("\n") + "]\n\n";
      }

      export function handleInteractiveTextInput(inputBox) {
        if (!state.terminalInteractive || !inputBox) return false;
        var value = inputBox.value || "";
        if (!value) return false;
        queueDirectInput(value, "interactive_text").catch(function() {});
        inputBox.value = "";
        autoResizeInput(inputBox);
        setDraftValue("", true);
        return true;
      }

      export function handleInputPaste(event) {
        var items = event.clipboardData && event.clipboardData.items;
        if (items && !state.terminalInteractive) {
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image/") === 0) {
              event.preventDefault();
              var file = items[i].getAsFile();
              if (file) addPendingAttachment(file);
              return;
            }
          }
        }
        var pasted = event.clipboardData && event.clipboardData.getData("text");
        if (!pasted) return;
        event.preventDefault();
        if (state.terminalInteractive) {
          queueDirectInput(pasted, "paste").catch(function() {});
          return;
        }
        var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
        if (inputBox) {
          var start = inputBox.selectionStart || 0;
          var end = inputBox.selectionEnd || 0;
          var current = inputBox.value;
          var newValue = current.slice(0, start) + pasted + current.slice(end);
          inputBox.value = newValue;
          setDraftValue(newValue);
        }
      }

      export function queueDraftInput(text) {
        queueDirectInput(text);
        setDraftValue(getDraftValue() + text);
      }

      export function getDraftValue() {
        if (state.selectedId) {
          if (state.drafts[state.selectedId] !== undefined) {
            return state.drafts[state.selectedId];
          }
          // Try to load from localStorage
          try {
            var saved = localStorage.getItem("wand-draft-" + state.selectedId);
            if (saved) return saved;
          } catch (e) { /* ignore */ }
        }
        return "";
      }

      export function setDraftValue(value, skipDom?) {
        if (!state.selectedId) return;
        state.drafts[state.selectedId] = value;
        // Persist to localStorage
        try {
          localStorage.setItem("wand-draft-" + state.selectedId, value);
        } catch (e) { /* ignore */ }
        if (!skipDom) {
          var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
          if (inputBox) inputBox.value = value;
        }
      }

      export var promptOptimizeInFlight = false;
      export function optimizePromptText() {
        if (promptOptimizeInFlight) return;
        var inputBox = document.getElementById("input-box") as HTMLTextAreaElement | null;
        var btn = document.getElementById("prompt-optimize-btn") as HTMLButtonElement | null;
        var composer = document.querySelector(".input-composer");
        if (!inputBox) return;
        var raw = (inputBox.value || "").trim();
        if (!raw) {
          if (typeof showToast === "function") showToast("请先输入要优化的内容。", "info");
          inputBox.focus();
          return;
        }
        promptOptimizeInFlight = true;
        if (btn) {
          btn.classList.add("is-loading");
          btn.disabled = true;
          btn.setAttribute("title", "正在优化…");
        }
        if (composer) composer.classList.add("is-optimizing");
        inputBox.setAttribute("aria-busy", "true");
        var prevReadOnly = inputBox.readOnly;
        inputBox.readOnly = true;

        var payload: any = { text: raw };
        if (state && state.selectedId) payload.sessionId = state.selectedId;

        fetch("/api/optimize-prompt", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function(res) {
            return res.json().then(function(data) { return { ok: res.ok, data: data }; });
          })
          .then(function(result) {
            if (!result.ok) throw new Error((result.data && result.data.error) || "提示词优化失败。");
            var optimized = (result.data && result.data.optimized) || "";
            if (!optimized) throw new Error("Claude 返回为空。");
            animateOptimizedReplace(inputBox, optimized);
          })
          .catch(function(error) {
            if (typeof showToast === "function") showToast((error && error.message) || "提示词优化失败。", "error");
            if (btn) {
              btn.classList.remove("is-loading");
              btn.classList.add("is-shake");
              setTimeout(function() { if (btn) btn.classList.remove("is-shake"); }, 400);
            }
          })
          .finally(function() {
            promptOptimizeInFlight = false;
            if (btn) {
              btn.classList.remove("is-loading");
              btn.disabled = false;
              btn.setAttribute("title", "提示词优化（AI）");
            }
            if (composer) composer.classList.remove("is-optimizing");
            inputBox.removeAttribute("aria-busy");
            inputBox.readOnly = prevReadOnly;
          });
      }

      export function animateOptimizedReplace(inputBox, finalText) {
        if (!inputBox) return;
        // Typewriter-style fill so user sees the replacement happen
        var chars = Array.from(finalText);
        var total = chars.length;
        if (total === 0) {
          inputBox.value = "";
          setDraftValue("", true);
          autoResizeInput(inputBox);
          return;
        }
        var totalDuration = Math.min(700, Math.max(220, total * 8));
        var stepCount = Math.min(total, 60);
        var charsPerStep = Math.ceil(total / stepCount);
        var stepDelay = totalDuration / stepCount;
        var i = 0;
        inputBox.value = "";
        autoResizeInput(inputBox);
        function tick() {
          i = Math.min(total, i + charsPerStep);
          inputBox.value = chars.slice(0, i).join("");
          autoResizeInput(inputBox);
          if (i < total) {
            setTimeout(tick, stepDelay);
          } else {
            setDraftValue(finalText, true);
            try { inputBox.setSelectionRange(finalText.length, finalText.length); } catch (e) { /* ignore */ }
          }
        }
        tick();
      }

      // v2: 同步 .input-composer 上的 .has-text 类 —— 决定 ghost meta 是否显示、
      // 提示词优化按钮是否浮出。该函数应在每次 textarea 值变化后调用：
      //   · input 事件（用户键入）
      //   · 程序化设值（草稿恢复 / 优化后替换 / 发送后清空）
      export function syncComposerHasText(el) {
        var composer = document.querySelector(".input-composer");
        if (!composer) return;
        var inputBox = (el || document.getElementById("input-box")) as HTMLTextAreaElement | null;
        var hasText = !!(inputBox && inputBox.value && inputBox.value.length > 0);
        composer.classList.toggle("has-text", hasText);
      }

      // ─────────────────────────────────────────────────────────────────
      // v2 语音输入：按住说话 → 实时气泡 → 松手填回输入框（微信式交互）
      //
      // 数据源与交互解耦：所有识别文字都经 updateVoiceTranscript(text) 进来。
      // 现在是临时 MOCK（逐字蹦示例文字）；接入真实 STT 后，删掉下方 MOCK 段，
