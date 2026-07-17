import { state, readStoredBoolean, writeStoredBoolean, configPath } from "./state";
import { mergeWindowedMessages } from "./message-reconciliation";
import { t, iconSvg } from "./i18n";
import { escapeHtml, formatElapsedShort, refreshTailMarqueePaths } from "./utils";
import { ensureChatMessagesContainer, extractToolResultText, parseMessages, renderChat, scheduleChatRender, shortCommand } from "./chat-render";
import { bindChatScrollListener, clearStructuredQueuePersistence, normalizeStructuredSnapshot, persistSelectedId, restoreStructuredQueue, saveStructuredQueue, scrollChatToBottom, stripRenderOnlyStructuredMessages, syncStructuredQueueFromSession, updateChatUnreadBubble } from "./chat-scroll";
import { attachEventListeners } from "./events";
import { applyTerminalScale, isMobileLayout, refreshFileExplorer, setFilePanelOpen, shouldShowSessionsBackdrop, updateFilePanelCwd, updateLayoutState } from "./file-browser";
import { loadGitStatus, updateTopbarGitBadge } from "./git-commit";
import { activateSession, autoResizeInput, buildMessagesForRender, canAutoResumeSession, captureTerminalInput, closeKeyboardPopup, closeSwipedItem, flushCrossSessionQueue, focusInputBox, getControlInput, hasActiveTerminalSelection, hideMiniKeyboard, queueDirectInput, reconcileInteractiveState, renderCrossSessionQueue, sendInputFromBox, setTerminalInteractive, shouldCaptureTerminalEvent, stopSession, switchToSessionView, updateInteractiveControls, updateStructuredQueueCounter, updateVoiceTranscript } from "./input";
import { _apkVersion, _getNativePermission, _hasNativeBridge, _macAppVersion, _syncWakeLock, _vibrate, clearSessionProgressNative, hideError, notifyTaskEnded, openWandDialog, performRestart, sendBrowserNotification, showError, showNotificationBubble, showRestartOverlay, showToast, tryPlayNotificationSound, wandAlert, wandConfirm, wandPrompt } from "./notifications";
import { bindForegroundSyncListeners, getEffectiveCwd, render, renderAppShell, resetChatRenderCache, updateOfflineBanner } from "./render";
import { ensureClaudeHistoryLoaded, ensureCodexHistoryLoaded, loadClaudeHistory, loadCodexHistory, renderSessions, renderSessionsListContent } from "./sidebar";
import { initTerminal, maybeScheduleResyncForChunk, maybeScrollTerminalToBottom, scheduleSoftResyncTerminal, syncTerminalBuffer, wandTerminalWrite } from "./terminal";
import { computeRunningSignal, renderStructuredStatusBar, updateRunningIndicators } from "./utils";
import { ensureTerminalFit, ensureTerminalFitWithRetry, scheduleTerminalResize, teardownTerminal } from "./viewport";
import { forceReconnectWebSocket, initWebSocket, setView, startPolling, stopPolling, updateAutoApproveIndicator, updateTaskDisplay } from "./websocket";
import { getSessionLatestUserText, getSessionStatusLabel } from "./session-ui";
import { isBrowserReactShellMounted } from "./shell-runtime";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import {
  closeWorktreeMergeFromLegacy,
  openWorktreeMergeForSession,
} from "./worktree-merge-adapter";
import { folderPickerController } from "../react/folder-picker/controller";
import { quickCommitController } from "../react/quick-commit/controller";
import { worktreeMergeController } from "../react/worktree-merge/controller";
import { prepareFilePreviewForCompetingOverlay } from "./file-preview-adapter";

      // 证书不受信任时浏览器会丢弃 Secure Cookie —— 密码正确也存不住登录态。
      // 这里揭示专用提示，并把「改用 HTTP」按钮指向同 host 的 http:// 地址。
      function showLoginCertHint() {
        var hint = document.getElementById("login-cert-hint");
        if (hint) hint.classList.remove("hidden");
        var httpLink = document.getElementById("login-cert-http-link") as HTMLAnchorElement | null;
        if (httpLink) {
          httpLink.href = "http://" + location.host + location.pathname;
          // 已经是 HTTP 还能走到这里只能是别的故障，藏掉无意义的跳转入口。
          httpLink.style.display = location.protocol === "https:" ? "" : "none";
        }
      }
      function hideLoginCertHint() {
        var hint = document.getElementById("login-cert-hint");
        if (hint) hint.classList.add("hidden");
      }

      export function login() {
        if (state.loginPending) return;

        var passwordEl = document.getElementById("password") as HTMLInputElement | null;
        var loginButton = document.getElementById("login-button") as HTMLButtonElement | null;
        var errorEl = document.getElementById("login-error");
        if (!passwordEl || !loginButton || !errorEl) return;

        hideError(errorEl);
        hideLoginCertHint();
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
          if (res.status === 429) {
            showError(errorEl, "登录尝试次数过多，请稍后再试。");
            return Promise.reject("handled");
          }
          if (!res.ok) {
            passwordEl.dataset.error = "true";
            passwordEl.setAttribute("aria-invalid", "true");
            showError(errorEl, "密码错误，请重试。");
            return Promise.reject("handled");
          }
          // 登录 POST 成功（密码正确）。立刻打一个需要鉴权的请求验证登录态是否
          // 真的保存住 —— 不受信任证书下浏览器会拒存 Secure Cookie，这里就会 401。
          return fetch("/api/config", { credentials: "same-origin" });
        })
        .then(function(res) {
          if (!res.ok) {
            // 密码对、却没带回 Cookie = 登录态没存住，几乎必然是证书信任问题。
            if (location.protocol === "https:") {
              showLoginCertHint();
            } else {
              showError(errorEl, "登录失败，请重试。");
            }
            return Promise.reject("handled");
          }
          return res.json();
        })
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
          // Match the restored-session startup path: a fresh password login
          // should also populate local Claude/Codex history after first paint.
          // Without this warm-up, non-Wand sessions stay empty until reload or
          // until the user enters manage mode.
          if (!state.claudeHistoryLoaded) {
            setTimeout(function() {
              if (!state.claudeHistoryLoaded) ensureClaudeHistoryLoaded();
            }, 600);
          }
        })
        .catch(function(error) {
          if (error === "handled") return;
          console.error("[wand] Login error:", error);
          showError(errorEl, "登录失败，请重试。");
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
        return "打字或按住说话";
      }

      export function getToolModeHint(tool, mode) {
        if (tool === "codex") {
          return "Codex 支持 PTY 终端与结构化（JSONL）两种会话，结构化模式按 full-access 启动。";
        }
        if (tool === "opencode") {
          return mode === "full-access" || mode === "managed" || mode === "auto-edit"
            ? "OpenCode 将自动批准未显式拒绝的权限；支持 TUI 与 JSON 结构化会话。"
            : "OpenCode 使用自身权限配置；结构化模式会自动拒绝未批准的权限请求。";
        }
        if (tool === "grok") {
          return mode === "full-access" || mode === "managed" || mode === "auto-edit"
            ? "Grok 将自动批准工具执行（--always-approve）；支持 TUI 与 streaming-json 结构化会话。"
            : "Grok 使用自身权限配置；结构化模式支持多轮续聊与思考过程展示。";
        }
        if (tool === "qoder") {
          return mode === "full-access" || mode === "managed"
            ? "Qoder 将以 bypass_permissions 运行；支持 TUI 与 stream-json 结构化会话。"
            : mode === "auto-edit"
              ? "Qoder 将自动批准工作区内的安全编辑。"
              : "Qoder 使用自身权限配置；结构化模式支持多轮续聊与工具调用展示。";
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
        if (tool === "opencode" || tool === "grok") return ["default", "full-access", "managed"];
        if (tool === "qoder") return ["default", "full-access", "auto-edit", "managed"];
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

      // 会话级的 mode / model / thinking 共享一条串行队列。快速连选时，服务端
      // 会按用户操作顺序落盘；只有最新 revision 的回包可以合并全量快照。
      var sessionConfigMutationTails = Object.create(null);
      var sessionConfigMutationRevisions = Object.create(null);
      var pendingSessionConfig = Object.create(null);

      function getPendingSessionConfig(sessionId) {
        return sessionId ? pendingSessionConfig[sessionId] || null : null;
      }

      function setPendingSessionConfig(sessionId, key, value) {
        if (!sessionId) return;
        var pending = pendingSessionConfig[sessionId] || (pendingSessionConfig[sessionId] = {});
        pending[key] = value;
      }

      function clearPendingSessionConfig(sessionId) {
        if (sessionId) delete pendingSessionConfig[sessionId];
      }

      function enqueueSessionConfigMutation(sessionId, task) {
        var revision = (sessionConfigMutationRevisions[sessionId] || 0) + 1;
        sessionConfigMutationRevisions[sessionId] = revision;
        var previous = sessionConfigMutationTails[sessionId] || Promise.resolve();
        var request = previous.catch(function() {}).then(task);
        sessionConfigMutationTails[sessionId] = request.catch(function() {});
        return request.then(function(data) {
          return { data: data, latest: sessionConfigMutationRevisions[sessionId] === revision };
        }, function(error) {
          return Promise.reject({ error: error, latest: sessionConfigMutationRevisions[sessionId] === revision });
        });
      }

      function recoverLatestSessionConfigMutation(sessionId, message) {
        clearPendingSessionConfig(sessionId);
        // 旧 revision 成功、最新 revision 失败时，本地故意没合并旧快照。重拉一次
        // 才能同时恢复服务端已落盘的前序修改和本次失败的回滚状态。
        Promise.resolve(loadSessions())
          .catch(function() {})
          .finally(function() { refreshAllChatModeTrios(); });
        showToast(message, "error");
      }

      function applyLatestSessionConfigSnapshot(sessionId, outcome) {
        if (!outcome.latest) return false;
        var data = outcome.data;
        if (data && data.error) {
          recoverLatestSessionConfigMutation(sessionId, data.error);
          return false;
        }
        if (!data || !data.id) {
          recoverLatestSessionConfigMutation(sessionId, "会话设置更新失败");
          return false;
        }
        updateSessionSnapshot(data);
        clearPendingSessionConfig(sessionId);
        refreshAllChatModeTrios();
        return true;
      }

      // 三件套 raw 选项渲染：option 文本直接是 id（不带括号注释 / 不本地化）。
      // 空会话入口使用这套统一渲染器；composer 与 + 弹层复用下方的 chip 渲染器。
      // 三者都使用原生 select，思考深度的选项仍根据当前模型能力动态生成。
      export function renderChatModeTrioHtml(session, opts) {
        opts = opts || {};
        // 三种 kind：dropdown（空状态横向）/ compact（用户消息徽章）/ popover（加号气泡纵向）
        var kind = (opts.kind === "compact" || opts.kind === "popover") ? opts.kind : "dropdown";
        var preferredTool = getPreferredTool();
        var composerMode = state.chatMode || "default";
        var modelText = getEffectiveModel(session) || "";
        var modelLabel = getShortModelLabel(modelText, session);
        var thinkingText = getEffectiveThinking(session);
        function pill(ctrl, label, value, optionsHtml) {
          // compact 不显示分组小标签；dropdown / popover 都显示（"模式" / "模型" / "思考"）。
          var tagHtml = kind === "compact" ? "" : ('<span class="chat-mode-trio-tag">' + escapeHtml(label) + '</span>');
          return '<span class="composer-text-pill chat-mode-trio-pill" data-mode-control-pill="' + ctrl + '" title="' + escapeHtml(label) + '">' +
            tagHtml +
            '<span class="composer-text-label">' + escapeHtml(value) + '</span>' +
            '<select class="composer-text-hidden-select" data-mode-control="' + ctrl + '" aria-label="' + escapeHtml(label) + '">' +
              optionsHtml +
            '</select>' +
          '</span>';
        }
        return '<div class="chat-mode-trio chat-mode-trio-' + kind + '" role="group" aria-label="会话设置">' +
          pill("mode", "模式", composerMode, renderChatModeOptionsRaw(preferredTool, composerMode)) +
          '<span class="composer-text-sep" aria-hidden="true">·</span>' +
          pill("model", "模型", modelLabel, renderChatModelOptionsRaw(modelText, session)) +
          '<span class="composer-text-sep" aria-hidden="true">·</span>' +
          pill("thinking", "思考", getThinkingCompactLabel(thinkingText, session), renderThinkingOptions(thinkingText, session)) +
        '</div>';
      }

      export function getThinkingCompactLabel(id, session?) {
        var effort = getThinkingLabel(id, session);
        if (effort === "low") return "低";
        if (effort === "medium") return "中";
        if (effort === "high") return "高";
        if (effort === "xhigh") return "超高";
        if (effort === "max") return "极高";
        if (effort === "ultra") return "极限";
        return "自动";
      }

      export function getModelDisplayLabel(model, session) {
        var selected = model || "";
        var models = getModelsForCurrentProvider(session);
        if (!selected || selected === "default") {
          for (var j = 0; j < models.length; j++) {
            if (models[j].id === "default") return models[j].label || models[j].id;
          }
          return "默认";
        }
        for (var i = 0; i < models.length; i++) {
          if (models[i].id === selected) return models[i].label || models[i].id;
        }
        return selected;
      }

      export function getShortModelLabel(model, session) {
        var label = getModelDisplayLabel(model, session);
        if (!label || label === "跟随服务端默认") return "默认";
        var cutAt = label.search(/[（(]/);
        if (cutAt > 0) label = label.slice(0, cutAt).trim();
        var slash = label.lastIndexOf("/");
        if (slash >= 0 && slash < label.length - 1) label = label.slice(slash + 1).trim();
        var lower = label.toLowerCase();
        if (lower.indexOf("opus") !== -1) return "Opus";
        if (lower.indexOf("sonnet") !== -1) return "Sonnet";
        if (lower.indexOf("haiku") !== -1) return "Haiku";
        if (lower.indexOf("gpt-5.5") !== -1) return "GPT-5.5";
        if (lower.indexOf("gpt-5") !== -1) return "GPT-5";
        if (lower.indexOf("gpt-4") !== -1) return "GPT-4";
        if (lower.indexOf("grok-4.5") !== -1) return "Grok 4.5";
        if (lower.indexOf("grok-4") !== -1) return "Grok 4";
        if (lower.indexOf("grok-3") !== -1) return "Grok 3";
        if (lower.indexOf("grok") !== -1) {
          if (label.length > 12) return label.slice(0, 10) + "…";
          return label;
        }
        if (label.length > 12) return label.slice(0, 10) + "…";
        return label;
      }

      export function renderThinkingOptions(selected, session?) {
        var levels = getThinkingLevels(session);
        var normalized = levels.some(function(level) { return level.id === selected; }) ? selected : "off";
        return levels.map(function(level) {
          var label = level.id === "off" ? "自动（模型默认）" : getThinkingCompactLabel(level.id, session);
          return '<option value="' + escapeHtml(level.id) + '"' + (level.id === normalized ? " selected" : "") + '>' +
            escapeHtml(label) +
          '</option>';
        }).join("");
      }

      function syncThinkingSelect(container, selected, session?) {
        var select = container.querySelector('[data-mode-control="thinking"]') as HTMLSelectElement | null;
        if (!select) return;
        select.innerHTML = renderThinkingOptions(selected, session);
        select.value = getThinkingLevels(session).some(function(level) { return level.id === selected; }) ? selected : "off";
      }

      export function renderComposerConfigControlsHtml(session) {
        var preferredTool = getPreferredTool();
        var mode = state.chatMode || "default";
        var model = getEffectiveModel(session) || "";
        var thinking = getEffectiveThinking(session);
        var modeLabel = getModeLabel(mode);
        var modelLabel = getShortModelLabel(model, session);
        var thinkingLabel = getThinkingCompactLabel(thinking, session);
        var title = "模式 " + modeLabel + " · 模型 " + modelLabel + " · 思考 " + thinkingLabel;
        return '<div class="composer-config-controls" role="group" aria-label="会话设置" title="' + escapeHtml(title) + '">' +
          '<span class="composer-config-chip composer-config-chip-mode" data-mode-control-pill="mode" title="模式：' + escapeHtml(modeLabel) + '">' +
            iconSvg("shield", { size: 13, strokeWidth: 1.8, cls: "composer-config-icon" }) +
            '<span class="composer-config-label">' + escapeHtml(modeLabel) + '</span>' +
            '<select class="composer-text-hidden-select" data-mode-control="mode" aria-label="模式">' +
              renderChatModeOptionsRaw(preferredTool, mode) +
            '</select>' +
          '</span>' +
          '<span class="composer-config-chip composer-config-model" data-mode-control-pill="model" title="模型：' + escapeHtml(modelLabel) + '">' +
            iconSvg("cpu", { size: 13, strokeWidth: 1.8, cls: "composer-config-icon" }) +
            '<span class="composer-config-label">' + escapeHtml(modelLabel) + '</span>' +
            '<select class="composer-text-hidden-select" data-mode-control="model" aria-label="模型">' +
              renderChatModelOptions(model, session) +
            '</select>' +
          '</span>' +
          '<span class="composer-config-chip composer-config-thinking" data-mode-control-pill="thinking" data-thinking="' + escapeHtml(thinking) + '" title="思考深度：' + escapeHtml(thinkingLabel) + '">' +
            iconSvg("brain", { size: 13, strokeWidth: 1.8, cls: "composer-config-icon" }) +
            '<span class="composer-config-label">' + escapeHtml(thinkingLabel) + '</span>' +
            '<select class="composer-text-hidden-select" data-mode-control="thinking" aria-label="思考深度">' +
              renderThinkingOptions(thinking, session) +
            '</select>' +
          '</span>' +
        '</div>';
      }

      // 改完任何一处 trio 的 select 后，把所有 trio 实例的 label / select.value 同步刷新。
      // 同时重建 model select 的 options，保证异步 fetchAvailableModels 到达后选项列表完整。
      export function refreshAllChatModeTrios() {
        var session = getSelectedSession();
        var preferredTool = getPreferredTool();
        var mode = state.chatMode || "default";
        var model = getEffectiveModel(session) || "";
        var modelLabel = getShortModelLabel(model, session);
        var thinking = getEffectiveThinking(session);
        var trios = document.querySelectorAll(".chat-mode-trio");
        trios.forEach(function(trio) {
          function setPair(ctrl, value, optionsHtml, labelText?) {
            var pillNode = trio.querySelector('[data-mode-control-pill="' + ctrl + '"]');
            if (!pillNode) return;
            var label = pillNode.querySelector(".composer-text-label");
            if (label) label.textContent = labelText || value;
            if (ctrl === "thinking") {
              syncThinkingSelect(pillNode, value, session);
              return;
            }
            var sel = pillNode.querySelector('[data-mode-control="' + ctrl + '"]') as HTMLSelectElement | null;
            if (!sel) return;
            if (optionsHtml) sel.innerHTML = optionsHtml;
            if (sel.value !== value) sel.value = value;
          }
          setPair("mode", mode, renderChatModeOptionsRaw(preferredTool, mode));
          setPair("model", model, renderChatModelOptionsRaw(model, session), modelLabel);
          setPair("thinking", thinking, "", getThinkingCompactLabel(thinking, session));
        });
        refreshComposerConfigControls(session, mode, getEffectiveModel(session) || "", thinking);
      }

      export function refreshComposerConfigControls(session, mode, model, thinking) {
        var preferredTool = getPreferredTool();
        var modeLabel = getModeLabel(mode);
        var modelLabel = getShortModelLabel(model, session);
        var thinkingLabel = getThinkingCompactLabel(thinking, session);
        var controls = document.querySelectorAll(".composer-config-controls");
        controls.forEach(function(control) {
          var title = "模式 " + modeLabel + " · 模型 " + modelLabel + " · 思考 " + thinkingLabel;
          control.setAttribute("title", title);
          function updateSelect(part, value, optionsHtml) {
            var sel = part.querySelector("[data-mode-control]") as HTMLSelectElement | null;
            if (!sel) return;
            sel.innerHTML = optionsHtml;
            sel.value = value;
          }
          var modePart = control.querySelector('[data-mode-control-pill="mode"]');
          if (modePart) {
            var modeText = modePart.querySelector(".composer-config-label");
            if (modeText) modeText.textContent = modeLabel;
            modePart.setAttribute("title", "模式：" + modeLabel);
            updateSelect(modePart, mode, renderChatModeOptionsRaw(preferredTool, mode));
          }
          var modelPart = control.querySelector('[data-mode-control-pill="model"]');
          if (modelPart) {
            var modelText = modelPart.querySelector(".composer-config-label");
            if (modelText) modelText.textContent = modelLabel;
            modelPart.setAttribute("title", "模型：" + modelLabel);
            updateSelect(modelPart, model, renderChatModelOptions(model, session));
          }
          var thinkingPart = control.querySelector('[data-mode-control-pill="thinking"]');
          if (thinkingPart) {
            var thinkingText = thinkingPart.querySelector(".composer-config-label");
            if (thinkingText) thinkingText.textContent = thinkingLabel;
            thinkingPart.setAttribute("data-thinking", thinking);
            thinkingPart.setAttribute("title", "思考深度：" + thinkingLabel);
            syncThinkingSelect(thinkingPart, thinking, session);
          }
        });
      }

      export function renderChatModeOptionsRaw(tool, selectedMode) {
        return getSupportedModes(tool).map(function(mode) {
          return '<option value="' + escapeHtml(mode) + '"' + (mode === selectedMode ? " selected" : "") + '>' +
            escapeHtml(mode) +
          '</option>';
        }).join("");
      }

      export function getProviderKey(provider) {
        return provider === "codex" || provider === "opencode" || provider === "grok" || provider === "qoder" ? provider : "claude";
      }

      export function getProviderForSession(session) {
        return getProviderKey((session && session.provider) || state.sessionTool || "claude");
      }

      export function getConfigDefaultModels() {
        var configured = state.config && state.config.defaultModels && typeof state.config.defaultModels === "object"
          ? state.config.defaultModels
          : {};
        return {
          claude: typeof configured.claude === "string" ? configured.claude : ((state.config && state.config.defaultModel) || ""),
          codex: typeof configured.codex === "string" ? configured.codex : ((state.config && state.config.defaultCodexModel) || ""),
          opencode: typeof configured.opencode === "string" ? configured.opencode : ((state.config && state.config.defaultOpenCodeModel) || ""),
          grok: typeof configured.grok === "string" ? configured.grok : ((state.config && state.config.defaultGrokModel) || ""),
          qoder: typeof configured.qoder === "string" ? configured.qoder : ((state.config && state.config.defaultQoderModel) || "")
        };
      }

      export function getConfigDefaultModelForProvider(provider) {
        var defaults = getConfigDefaultModels();
        var key = getProviderKey(provider);
        if (key === "codex") return defaults.codex || "";
        if (key === "opencode") return defaults.opencode || "";
        if (key === "grok") return defaults.grok || "";
        if (key === "qoder") return defaults.qoder || "";
        return defaults.claude || "";
      }

      export function getChatModelForProvider(provider) {
        var key = getProviderKey(provider);
        var selected = state.chatModels && typeof state.chatModels[key] === "string" ? state.chatModels[key] : "";
        if (!selected && key === "claude") selected = state.chatModel || "";
        return selected || "";
      }

      export function setChatModelForProvider(provider, model) {
        var key = getProviderKey(provider);
        var normalized = (model || "").trim();
        if (!state.chatModels) state.chatModels = { claude: "", codex: "", opencode: "", grok: "", qoder: "" };
        state.chatModels[key] = normalized;
        state.chatModel = normalized;
        try {
          localStorage.setItem("wand-chat-model-" + key, normalized);
          localStorage.removeItem("wand-chat-model");
        } catch (e) {}
      }

      export function getEffectiveModel(session) {
        var pending = session && session.id ? getPendingSessionConfig(session.id) : null;
        if (pending && Object.prototype.hasOwnProperty.call(pending, "model")) return pending.model || "";
        if (session && session.selectedModel) return session.selectedModel;
        var provider = getProviderForSession(session);
        var selected = getChatModelForProvider(provider);
        return selected || getConfigDefaultModelForProvider(provider) || "";
      }

      export function getModelsForCurrentProvider(session) {
        var provider = getProviderKey((session && session.provider) || state.sessionTool || "claude");
        if (provider === "codex") return state.availableCodexModels || [];
        if (provider === "opencode") return state.availableOpenCodeModels || [];
        if (provider === "grok") return state.availableGrokModels || [];
        if (provider === "qoder") return state.availableQoderModels || [];
        return state.availableModels || [];
      }

      export function renderChatModelOptions(selected, session) {
        var models = getModelsForCurrentProvider(session);
        var normalized = selected === "default" ? "" : (selected || "");
        var html = '<option value=""' + (!normalized ? " selected" : "") + '>默认 · ' + escapeHtml(getModelDisplayLabel("", session)) + '</option>';
        for (var i = 0; i < models.length; i++) {
          var m = models[i];
          if (m.id === "default") continue;
          var label = m.label || m.id;
          var suffix = getProviderForSession(session) === "claude"
            ? m.availability === "verified"
              ? " · 已验证"
              : m.availability === "stale"
                ? " · 待刷新"
                : m.source === "models-api"
                  ? " · API 候选"
                  : " · 候选"
            : "";
          html += '<option value="' + escapeHtml(m.id) + '"' + (m.id === normalized ? " selected" : "") + '>' + escapeHtml(label + suffix) + '</option>';
        }
        if (normalized && !models.some(function(m) { return m.id === normalized; })) {
          html += '<option value="' + escapeHtml(normalized) + '" selected>' + escapeHtml(normalized) + '（自定义）</option>';
        }
        return html;
      }

      // Raw 选项优先显示模型 ID，并以简短状态标识候选的验证状态。
      export function renderChatModelOptionsRaw(selected, session) {
        var models = getModelsForCurrentProvider(session);
        var normalized = selected === "default" ? "" : (selected || "");
        var html = '<option value=""' + (!normalized ? " selected" : "") + '>' + escapeHtml(getModelDisplayLabel("", session)) + '</option>';
        for (var i = 0; i < models.length; i++) {
          var m = models[i];
          if (m.id === "default") continue;
          var rawSuffix = getProviderForSession(session) === "claude"
            ? m.availability === "verified"
              ? " · verified"
              : m.availability === "stale"
                ? " · stale"
                : m.source === "models-api"
                  ? " · API candidate"
                  : " · candidate"
            : "";
          html += '<option value="' + escapeHtml(m.id) + '"' + (m.id === normalized ? " selected" : "") + '>' + escapeHtml(m.id + rawSuffix) + '</option>';
        }
        if (normalized && !models.some(function(m) { return m.id === normalized; })) {
          html += '<option value="' + escapeHtml(normalized) + '" selected>' + escapeHtml(normalized) + '</option>';
        }
        return html;
      }

      export function syncComposerModelSelect(session) {
        // 旧 ID 形态已下线；trio 多实例由 refreshAllChatModeTrios 同步刷新。
        // thinking / model 同属会话级设置，refresh 一次就把所有三件套统一对齐。
        refreshAllChatModeTrios();
      }

      // ── 思考深度 (thinkingEffort) —— 与 model 选择三件套对称 ──

      // 标签直接用实际传给各 runner 的 effort 语义，避免把 Claude 的一次性深度提示词
      // 误解成会话级配置。
      export var THINKING_LEVELS = [
        { id: "off",      label: "auto",   hint: "使用 provider / 模型默认思考档位" },
        { id: "standard", label: "low",    hint: "Claude/Codex: low · OpenCode variant: low" },
        { id: "deep",     label: "medium", hint: "Claude/Codex: medium · OpenCode variant: high" },
        { id: "max",      label: "max",    hint: "Claude: max · Codex: xhigh · OpenCode variant: max" }
      ];

      function codexThinkingId(effort) {
        if (effort === "low") return "standard";
        if (effort === "medium") return "deep";
        if (effort === "xhigh") return "max";
        return "codex:" + effort;
      }

      export function getThinkingLevels(session?) {
        if (getProviderForSession(session) !== "codex") return THINKING_LEVELS;
        var model = getEffectiveModel(session) || "default";
        var models = state.availableCodexModels || [];
        var info = models.find(function(item) { return item.id === model; })
          || models.find(function(item) { return item.id === "default"; });
        var efforts = info && Array.isArray(info.reasoningEfforts) ? info.reasoningEfforts : [];
        if (!efforts.length) return THINKING_LEVELS;
        var defaultEffort = info.defaultReasoningEffort || "";
        return [{
          id: "off",
          label: "auto",
          hint: defaultEffort ? "使用模型默认档位（" + defaultEffort + "）" : "使用模型默认档位"
        }].concat(efforts.map(function(level) {
          var effort = String(level.effort || "").toLowerCase();
          return {
            id: codexThinkingId(effort),
            label: effort,
            hint: level.description || effort
          };
        }).filter(function(level) { return level.label; }));
      }

      export function getThinkingLabel(id, session?) {
        var levels = getThinkingLevels(session);
        for (var i = 0; i < levels.length; i++) {
          if (levels[i].id === id) return levels[i].label;
        }
        if (typeof id === "string" && id.indexOf("codex:") === 0) return id.slice(6);
        for (var j = 0; j < THINKING_LEVELS.length; j++) {
          if (THINKING_LEVELS[j].id === id) return THINKING_LEVELS[j].label;
        }
        return "auto";
      }

      export function getEffectiveThinking(session) {
        var pending = session && session.id ? getPendingSessionConfig(session.id) : null;
        if (pending && Object.prototype.hasOwnProperty.call(pending, "thinking")) return pending.thinking || "off";
        if (session && session.thinkingEffort) return session.thinkingEffort;
        if (state.chatThinking) return state.chatThinking;
        return "off";
      }

      export function syncComposerThinkingSelect(session) {
        // 旧 ID 形态已下线；trio 多实例由 refreshAllChatModeTrios 同步刷新。
        refreshAllChatModeTrios();
      }

      function persistThinkingPreference(value) {
        state.chatThinking = value;
        try { localStorage.setItem("wand-thinking-effort", value); } catch (e) {}
      }

      function submitThinkingMutation(session, normalized, successMessage, prerequisite?) {
        return enqueueSessionConfigMutation(session.id, function() {
          if (prerequisite && !prerequisite.ok) {
            return { error: prerequisite.error || "切换模型失败" };
          }
          return fetch("/api/sessions/" + encodeURIComponent(session.id) + "/thinking-effort", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ thinkingEffort: normalized })
          }).then(function(res) { return res.json(); });
        })
        .then(function(outcome) {
          if (applyLatestSessionConfigSnapshot(session.id, outcome) && typeof showToast === "function") {
            showToast(successMessage || ("已切换思考深度 → " + getThinkingCompactLabel(normalized, getSelectedSession())), "success");
          }
        })
        .catch(function(failure) {
          if (failure && failure.latest) recoverLatestSessionConfigMutation(session.id, "切换思考深度失败");
        });
      }

      export function onChatThinkingChange(value) {
        var normalized = (value || "off").trim();
        var session = getSelectedSession();
        var supported = getThinkingLevels(session).some(function(level) { return level.id === normalized; });
        if (!supported) {
          normalized = "off";
        }
        persistThinkingPreference(normalized);
        if (session) setPendingSessionConfig(session.id, "thinking", normalized);
        refreshAllChatModeTrios();
        if (!session) return;
        submitThinkingMutation(session, normalized, "已切换思考深度 → " + getThinkingCompactLabel(normalized, session));
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
          ? '<button id="auto-approve-toggle" class="composer-pill composer-pill-chip auto-approve-indicator active" type="button" aria-pressed="true" aria-label="自动批准已启用，点击关闭" title="自动批准已启用 — 点击关闭">' + iconSvg("shieldCheck", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">自动</span></button>'
          : '<button id="auto-approve-toggle" class="composer-pill composer-pill-chip auto-approve-indicator" type="button" aria-pressed="false" aria-label="自动批准已关闭，点击开启" title="自动批准已关闭 — 点击开启">' + iconSvg("shield", { size: 12, strokeWidth: 1.7, cls: "composer-pill-icon" }) + '<span class="composer-pill-label">手动</span></button>';
      }

      export function fetchAvailableModels() {
        return fetch("/api/models", { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && Array.isArray(data.models)) {
              state.availableModels = data.models;
              state.availableCodexModels = Array.isArray(data.codexModels) ? data.codexModels : [];
              state.availableOpenCodeModels = Array.isArray(data.opencodeModels) ? data.opencodeModels : [];
              state.availableGrokModels = Array.isArray(data.grokModels) ? data.grokModels : [];
              state.availableQoderModels = Array.isArray(data.qoderModels) ? data.qoderModels : [];
              syncComposerModelSelect(getSelectedSession());
            }
            return data;
          })
          .catch(function() { return null; });
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
        var session = getSelectedSession();
        var provider = getProviderForSession(session);
        setChatModelForProvider(provider, normalized);
        if (session) setPendingSessionConfig(session.id, "model", normalized);

        // 先用新模型的 reasoningEfforts 验证当前思考档位。不支持时不只让
        // select 看起来回到“自动”，还要把真实默认和会话状态一起串行提交。
        var thinkingFallback = false;
        if (!getThinkingLevels(session).some(function(level) { return level.id === getEffectiveThinking(session); })) {
          thinkingFallback = true;
          persistThinkingPreference("off");
          if (session) setPendingSessionConfig(session.id, "thinking", "off");
        }
        refreshAllChatModeTrios();
        if (!session) return;
        var prerequisite = { ok: false, error: "" };
        enqueueSessionConfigMutation(session.id, function() {
          return fetch("/api/sessions/" + encodeURIComponent(session.id) + "/model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ model: normalized || null })
          }).then(function(res) { return res.json(); }).then(function(data) {
            prerequisite.ok = !!(data && data.id && !data.error);
            prerequisite.error = data && data.error ? data.error : "";
            return data;
          });
        })
        .then(function(outcome) {
          if (thinkingFallback) return;
          if (applyLatestSessionConfigSnapshot(session.id, outcome) && typeof showToast === "function") {
            var display = getModelDisplayLabel(normalized, getSelectedSession() || session);
            var hint = session.provider === "codex" ? "（下次对话生效）" : "";
            showToast("已切换模型 → " + display + hint, "success");
          }
        })
        .catch(function(failure) {
          prerequisite.ok = false;
          if (!thinkingFallback && failure && failure.latest) {
            recoverLatestSessionConfigMutation(session.id, "切换模型失败");
          }
        });

        if (thinkingFallback) {
          var display = getModelDisplayLabel(normalized, session);
          submitThinkingMutation(session, "off", "已切换模型 → " + display + "；思考深度已回落为自动", prerequisite);
        }
      }

      // 模式切换：无会话时修改新会话默认；有会话时结构化 / PTY 都提交。
      // PTY 的已启动 CLI flag 不变，但 Wand 权限放行策略会更新；Codex 仍由服务端锁定 full-access。
      export function onChatModeChange(value) {
        var normalized = getSafeModeForTool(getPreferredTool(), (value || "default").trim());
        state.chatMode = normalized;
        refreshAllChatModeTrios();
        var session = getSelectedSession();
        if (!session || !session.id) {
          showToast && showToast("新会话模式：" + normalized, "info");
          return;
        }
        setPendingSessionConfig(session.id, "mode", normalized);
        enqueueSessionConfigMutation(session.id, function() {
          return fetch("/api/sessions/" + encodeURIComponent(session.id) + "/mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ mode: normalized })
          }).then(function(res) { return res.json(); });
        })
        .then(function(outcome) {
          if (applyLatestSessionConfigSnapshot(session.id, outcome) && typeof showToast === "function") {
            var updated = state.sessions.find(function(item) { return item.id === session.id; }) || session;
            var effectiveMode = updated.mode || normalized;
            state.chatMode = getSafeModeForTool(updated.provider || getPreferredTool(), effectiveMode);
            refreshAllChatModeTrios();
            var hint = session.provider === "codex" ? "（Codex 固定全权限）" : "";
            showToast("已切换模式 → " + effectiveMode + hint, "success");
          }
        })
        .catch(function(failure) {
          if (failure && failure.latest) recoverLatestSessionConfigMutation(session.id, "切换模式失败");
        });
      }

      export function createStructuredSession(prompt?, cwdOverride?, modeOverride?, worktreeEnabled?) {
        var provider = getProviderKey(state.sessionTool);
        var modelPref = getChatModelForProvider(provider) || getConfigDefaultModelForProvider(provider);
        var thinkingPref = state.chatThinking || "off";
        var structuredRunner = provider === "codex"
          ? "codex-cli-exec"
          : provider === "opencode"
            ? "opencode-cli-run"
            : provider === "grok"
              ? "grok-cli-headless"
            : provider === "qoder"
              ? "qoder-cli-print"
              : ((state.config && state.config.structuredRunner === "sdk") ? "claude-sdk" : (state.structuredRunner || "claude-cli-print"));
        var payload = {
          cwd: cwdOverride || getEffectiveCwd(),
          mode: modeOverride || state.chatMode || (state.config && state.config.defaultMode) || "default",
          provider: provider,
          runner: structuredRunner,
          prompt: prompt || undefined,
          worktreeEnabled: worktreeEnabled === true,
          model: modelPref || undefined,
          thinkingEffort: thinkingPref,
          sessionSource: "interactive"
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
        var reactShellActive = isBrowserReactShellMounted();
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

        if (!reactShellActive && terminalContainer) {
          terminalContainer.classList.toggle("active", showTerminal);
          terminalContainer.classList.toggle("hidden", !showTerminal);
        }
        if (!reactShellActive && chatContainer) {
          chatContainer.classList.toggle("active", showChat);
          chatContainer.classList.toggle("hidden", !showChat);
        }
        // blank-chat 的可见性由 applyCurrentView 收口：updateShellChrome 在
        // selectedSession 缺失（启动期 selectedId 已恢复但 /api/sessions 未回 /
        // activateSession 在 updateSessionSnapshot 之前调 switchToSessionView 等
        // 瞬态）时会走 else 分支把 blank-chat 显示出来，但紧接着调到这里，应
        // 以 hasSession 为准重新隐藏，避免与 terminal/chat 同屏并存。
        if (!reactShellActive && blankChat) {
          blankChat.classList.toggle("hidden", hasSession);
        }
        if (chatContainer && showChat) {
          ensureChatMessagesContainer(chatContainer);
        }
        bindChatScrollListener();
        updateChatUnreadBubble();
        updateInteractiveControls();
        notifyLegacyUiChange("shell:view");
      }

      export function updateSessionSnapshot(snapshot) {
        if (!snapshot || !snapshot.id) return;
        var currentSession = state.sessions.find(function(session) { return session.id === snapshot.id; }) || null;
        var normalizedSnapshot = normalizeStructuredSnapshot(snapshot, currentSession);
        // 全量 messages（带 messageOffset）走窗口合并，避免尾部窗口清掉已加载的更早消息。
        if (Array.isArray(normalizedSnapshot.messages) && typeof normalizedSnapshot.messageOffset === "number") {
          var mw = mergeWindowedMessages(currentSession, normalizedSnapshot.messages, normalizedSnapshot.messageOffset, normalizedSnapshot.messageTotal);
          normalizedSnapshot.messages = mw.messages;
          normalizedSnapshot.messageOffset = mw.messageOffset;
          normalizedSnapshot.messageTotal = mw.messageTotal;
        }
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
            if (!isBrowserReactShellMounted()) {
              var listEl = document.getElementById("sessions-list");
              var rendered = renderSessionsListContent();
              if (listEl && listEl.innerHTML === rendered) {
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              } else {
                if (listEl) {
                  listEl.innerHTML = rendered;
                  refreshTailMarqueePaths(listEl);
                }
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
        if (!isBrowserReactShellMounted()) {
          var listEl = document.getElementById("sessions-list");
          var countEl = document.getElementById("session-count");
          if (listEl) {
            listEl.innerHTML = renderSessionsListContent();
            refreshTailMarqueePaths(listEl);
          }
          if (countEl) countEl.textContent = String(state.sessions.length);
        }
        notifyLegacyUiChange("sessions:update");
        // History renders inline inside #sessions-list now, so the line above
        // already refreshed it — no separate docked region to update.
        if (typeof hideCollapsedTileBubble === "function") hideCollapsedTileBubble();
        updateShellChrome();
        // Re-render cross-session queue (container may have been destroyed by DOM rebuild)
        if (state.crossSessionQueue.length > 0) renderCrossSessionQueue();
      }

      export function updateShellChrome() {
        var reactShellActive = isBrowserReactShellMounted();
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
        var topbarTitleEl = document.querySelector(".topbar-session-title, .topbar-tagline");
        if (!reactShellActive && topbarTitleEl && selectedSession) {
          topbarTitleEl.classList.remove("topbar-tagline");
          topbarTitleEl.classList.add("topbar-session-title");
          topbarTitleEl.textContent = selectedSession.title || shortCommand(selectedSession.command);
          topbarTitleEl.setAttribute("title", selectedSession.description || selectedSession.command || "");
        }
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
          if (!reactShellActive && blankChat) blankChat.classList.add("hidden");
          if (!reactShellActive && terminalContainer) terminalContainer.classList.remove("hidden");
          if (!reactShellActive && chatContainer) chatContainer.classList.remove("hidden");
          // v2: 停止按钮不在这里统一展示 —— 由 updateInteractiveControls()
          // 按 computeRunningSignal 判断「真在跑」时才露出（applyCurrentView 末尾会调用）。
          if (!reactShellActive && inputPanel) inputPanel.classList.remove("hidden");
        } else {
          if (!reactShellActive && blankChat) blankChat.classList.remove("hidden");
          if (!reactShellActive && terminalContainer) terminalContainer.classList.add("hidden");
          if (!reactShellActive && chatContainer) chatContainer.classList.add("hidden");
          if (stopBtn) stopBtn.classList.add("hidden");
          if (!reactShellActive && inputPanel) inputPanel.classList.add("hidden");
        }
        syncComposerModeSelect();
        syncComposerModelSelect(getSelectedSession());
        applyCurrentView();
        reconcileInteractiveState();
        notifyLegacyUiChange("shell:chrome");
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

      // 窗口化：从服务端拉「更早的一页」消息并 prepend 到当前会话。
      // 返回 true 表示发起了请求（本地全展开后由「加载更早」触底调用）。
      var _fetchingEarlierMessages = false;
      export function fetchEarlierMessages() {
        if (_fetchingEarlierMessages) return false;
        var id = state.selectedId;
        if (!id) return false;
        var sess = state.sessions.find(function(s) { return s.id === id; });
        if (!sess) return false;
        var offset = (typeof sess.messageOffset === "number") ? sess.messageOffset : 0;
        if (offset <= 0) return false; // 已经到最早一条
        var pageSize = 40;
        var newOffset = Math.max(0, offset - pageSize);
        var limit = offset - newOffset;
        _fetchingEarlierMessages = true;
        fetch("/api/sessions/" + encodeURIComponent(id) + "/messages?offset=" + newOffset + "&limit=" + limit,
          { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            // 仅当起点未被其它更新改动时才 prepend，避免错位重复。
            if (data && Array.isArray(data.messages) && sess.messageOffset === offset) {
              var existing = Array.isArray(sess.messages) ? sess.messages : [];
              sess.messages = data.messages.concat(existing);
              sess.messageOffset = newOffset;
              if (typeof data.total === "number") sess.messageTotal = data.total;
              if (id === state.selectedId) {
                state.currentMessages = buildMessagesForRender(sess, getPreferredMessages(sess, sess.output, false));
                // 已加载的全部展开（新拉的更早消息也要可见）。
                state.chatRenderedCount = state.currentMessages.length;
                renderChat(true);
              }
            }
          })
          .catch(function() { /* 静默：下次触底重试 */ })
          .finally(function() { _fetchingEarlierMessages = false; });
        return true;
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

      /** DOM-free home navigation used by the React shell command port. */
      export function goHome() {
        if (!state.selectedId) return;
        state.selectedId = null;
        state.currentTask = null;
        state.currentMessages = [];
        state.gitStatus = null;
        state.gitStatusSessionId = null;
        persistSelectedId();
        resetChatRenderCache();
        dismissDrawerIfOverlay();
        updateSessionsList();
      }

      export function updatePinState() {
        if (isBrowserReactShellMounted()) {
          notifyLegacyUiChange("layout:pin");
          return;
        }
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
        if (isBrowserReactShellMounted()) {
          notifyLegacyUiChange("layout:drawer");
          return;
        }
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
        if (isBrowserReactShellMounted()) {
          notifyLegacyUiChange("layout:collapse-button");
          return;
        }
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

      function closeControllerForCompetingOverlay(controller: {
        isOpen(): boolean;
        closeIfOpen(): boolean;
      } | undefined): boolean {
        return !controller?.isOpen() || controller.closeIfOpen();
      }

      function openSessionModalNow() {
        if (
          !closeControllerForCompetingOverlay(folderPickerController)
          || !closeControllerForCompetingOverlay(quickCommitController)
          || !closeControllerForCompetingOverlay(worktreeMergeController)
          || !closeControllerForCompetingOverlay(window.__wandReactSettings)
        ) return;
        var reactNewSession = window.__wandReactNewSession;
        if (reactNewSession && typeof reactNewSession.open === "function") {
          try {
            if (reactNewSession.open()) return;
          } catch (error) {
            console.warn("[wand] React new-session host unavailable", error);
          }
        }
        try {
          var queryDisabled = new URL(window.location.href).searchParams.get("reactUi") === "0";
          if (queryDisabled) {
            showToast("新建会话界面已被 ?reactUi=0 禁用；移除该参数并刷新后即可使用。", "error");
            return;
          }
          if (window.localStorage.getItem("wand.reactUi.enabled") === "false") {
            window.localStorage.setItem("wand.reactUi.enabled", "true");
            showToast("正在启用新建会话界面…", "info");
            window.setTimeout(function() { window.location.reload(); }, 120);
            return;
          }
        } catch (_error) {}
        showToast("新建会话界面未能启动，请刷新页面后重试。", "error");
      }

      export function openSessionModal() {
        if (!prepareFilePreviewForCompetingOverlay(openSessionModalNow)) return;
        openSessionModalNow();
      }

      export function closeSessionModal() {
        var reactNewSession = window.__wandReactNewSession;
        if (reactNewSession && typeof reactNewSession.closeIfOpen === "function") {
          try {
            if (reactNewSession.closeIfOpen()) return;
          } catch (_error) {}
        }
      }

      export function openWorktreeMergeModal(sessionId: string) {
        openWorktreeMergeForSession(sessionId, "merge");
      }

      export function closeWorktreeMergeModal() {
        return closeWorktreeMergeFromLegacy();
      }

      export function retryWorktreeCleanup(sessionId: string) {
        openWorktreeMergeForSession(sessionId, "cleanup");
      }

      function openSettingsModalNow() {
        if (
          !closeControllerForCompetingOverlay(folderPickerController)
          || !closeControllerForCompetingOverlay(quickCommitController)
          || !closeControllerForCompetingOverlay(worktreeMergeController)
          || !closeControllerForCompetingOverlay(window.__wandReactNewSession)
        ) return;
        var controller = window.__wandReactSettings;
        if (controller && typeof controller.open === "function") {
          // WebKit does not focus buttons on click by default. Establish the
          // invoking control explicitly so the dialog can restore it on close.
          var settingsTrigger = document.getElementById("settings-button");
          if (settingsTrigger) settingsTrigger.focus({ preventScroll: true });
          controller.open("about");
          return;
        }
        // The rollback flag can disable the React island. Settings has no
        // second DOM implementation, so fail visibly and offer a safe recovery.
        try {
          var queryDisabled = new URL(window.location.href).searchParams.get("reactUi") === "0";
          if (queryDisabled) {
            showToast("设置界面已被 ?reactUi=0 禁用；移除该参数并刷新后即可使用。", "error");
            return;
          }
          if (window.localStorage.getItem("wand.reactUi.enabled") === "false") {
            window.localStorage.setItem("wand.reactUi.enabled", "true");
            showToast("正在启用设置界面…", "info");
            window.setTimeout(function() { window.location.reload(); }, 120);
            return;
          }
        } catch (_error) {}
        showToast("设置界面未能启动，请刷新页面后重试。", "error");
      }

      export function openSettingsModal() {
        if (!prepareFilePreviewForCompetingOverlay(openSettingsModalNow)) return;
        openSettingsModalNow();
      }

      export function closeSettingsModal() {
        var controller = window.__wandReactSettings;
        if (controller && typeof controller.closeIfOpen === "function") controller.closeIfOpen();
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
        return ensureTerminalReady().then(function() {
          return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(withTerminalDimensions({ command: command, provider: command, cwd: defaultCwd, mode: defaultMode, sessionSource: "interactive" }))
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
        if (document.documentElement.classList.contains("is-wand-embed-terminal")) return false;
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
