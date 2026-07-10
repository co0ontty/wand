import { state, readStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml, renderTailMarqueePath } from "./utils";
import { isMobileLayout } from "./file-browser";
import { getSelectedSession } from "./input";
import { showToast } from "./notifications";
import { getEffectiveCwd, render } from "./render";
import { getPreferredTool, getSafeModeForTool, getToolModeHint, isStructuredSession } from "./session-engine";
import { renderManageCheckbox } from "./sidebar";

      export function renderFolderPicker(state) {
        var currentDir = getEffectiveCwd();

        // 如果有选中的会话，不显示单独的工作目录标签（已嵌入输入框内部）
        if (state.selectedId) {
          return '';
        }

        // 新建会话时显示简化的目录选择器（单行紧凑设计）
        return '<div class="folder-picker-compact" id="folder-picker-container">' +
          '<div class="folder-picker-compact-row">' +
            '<span class="folder-picker-compact-icon">' + iconSvg("folder", { size: 13, strokeWidth: 1.7 }) + '</span>' +
            '<input type="text" id="folder-picker-input" class="folder-picker-compact-input" value="' + escapeHtml(currentDir) + '" placeholder="工作目录" autocomplete="off" />' +
            '<button type="button" id="folder-picker-toggle" class="folder-picker-toggle" title="选择目录" aria-label="选择目录">' + iconSvg("chevronDown", { size: 11, strokeWidth: 2 }) + '</button>' +
          '</div>' +
          '<div id="folder-picker-dropdown" class="folder-picker-dropdown hidden">' +
            '<div class="folder-picker-quick-row">' +
              '<button class="folder-picker-quick-btn" data-path="/tmp">临时</button>' +
              '<button class="folder-picker-quick-btn" data-path="/">根目录</button>' +
            '</div>' +
          '</div>' +
          '<div id="folder-picker-validation" class="folder-picker-validation"></div>' +
        '</div>';
      }

      // 渲染内嵌到输入框的工作目录指示器
      export function renderWorkingDirIndicator(state) {
        var currentDir = getEffectiveCwd();
        var displayDir = currentDir;

        // 如果有选中的会话，使用会话的工作目录
        if (state.selectedId) {
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          displayDir = selectedSession && selectedSession.cwd ? selectedSession.cwd : currentDir;
        }


        return '<div class="working-dir-indicator" id="working-dir-indicator" title="' + escapeHtml(displayDir) + '" data-path="' + escapeHtml(displayDir) + '">' +
          '<span class="working-dir-indicator-icon">' + iconSvg("folder", { size: 12, strokeWidth: 1.7 }) + '</span>' +
          renderTailMarqueePath(displayDir, "working-dir-indicator-path", ' id="working-dir-indicator-path"') +
        '</div>';
      }

      export function timeAgo(isoString) {
        if (!isoString) return "";
        var now = Date.now();
        var then = new Date(isoString).getTime();
        var diff = Math.max(0, now - then);
        var seconds = Math.floor(diff / 1000);
        if (seconds < 60) return "刚刚";
        var minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + "分钟前";
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + "小时前";
        var days = Math.floor(hours / 24);
        if (days < 30) return days + "天前";
        return Math.floor(days / 30) + "个月前";
      }

      export function elapsedTime(isoString) {
        if (!isoString) return "";
        var now = Date.now();
        var then = new Date(isoString).getTime();
        var diff = Math.max(0, now - then);
        var seconds = Math.floor(diff / 1000);
        var minutes = Math.floor(seconds / 60);
        var hours = Math.floor(minutes / 60);
        if (hours > 0) return hours + "h" + (minutes % 60 > 0 ? (minutes % 60) + "m" : "");
        if (minutes > 0) return minutes + "m";
        return seconds + "s";
      }

      export function getSessionStatusLabel(session) {
        if (!session) return "";
        if (session.permissionBlocked) return "等待授权";
        if (isStructuredSession(session) && session.structuredState && session.structuredState.inFlight) return "思考中";
        var statusMap = {
          "idle": "空闲",
          "stopped": "已停止",
          "running": "运行中",
          "exited": "已退出",
          "failed": "已失败"
        };
        return statusMap[session.status] || session.status;
      }

      export function getSessionStatusClass(session) {
        if (!session) return "";
        if (session.permissionBlocked) return "permission-blocked";
        if (isStructuredSession(session) && session.structuredState && session.structuredState.inFlight) return "running";
        return session.status || "";
      }

      /** Get a human-readable activity description for a running session */
      export function getSessionActivityDesc(session) {
        if (!session) return "";
        if (session.permissionBlocked) return "等待你的授权";
        if (session.status !== "running") return "";
        // Check WebSocket-delivered currentTask first
        if (session.id === state.selectedId && state.currentTask && state.currentTask.title) {
          return state.currentTask.title;
        }
        // Fall back to snapshot-delivered currentTaskTitle
        if (session.currentTaskTitle) return session.currentTaskTitle;
        return "";
      }

      /** Get the most recent user-sent text from messages (for narrow-strip hover bubble). */
      export function getSessionLatestUserText(session) {
        var msgs = session && session.messages;
        if (!msgs || msgs.length === 0) return "";
        for (var i = msgs.length - 1; i >= 0; i--) {
          var msg = msgs[i];
          if (!msg || msg.role !== "user") continue;
          var content = msg.content;
          if (typeof content === "string") {
            var t = content.trim();
            if (t) return t;
            continue;
          }
          if (Array.isArray(content)) {
            for (var j = 0; j < content.length; j++) {
              var block = content[j];
              if (!block || block.type !== "text" || !block.text) continue;
              if (block.__queued) continue;
              var bt = String(block.text).trim();
              if (bt) return bt;
            }
          }
        }
        return "";
      }

      /** Get the last meaningful assistant text from messages for notification/display */
      export function getLastAssistantSummary(session) {
        var msgs = session && session.messages;
        if (!msgs || msgs.length === 0) return "";
        for (var i = msgs.length - 1; i >= 0; i--) {
          var msg = msgs[i];
          if (msg.role !== "assistant") continue;
          var blocks = msg.content || [];
          for (var j = 0; j < blocks.length; j++) {
            if (blocks[j].type === "text" && blocks[j].text && blocks[j].text.trim()) {
              var text = blocks[j].text.trim();
              // Strip markdown formatting for compact display
              text = text.replace(/^#+\s+/gm, "").replace(/\*\*/g, "").replace(/`/g, "");
              var firstLine = text.split("\n")[0].trim();
              return firstLine.slice(0, 100);
            }
          }
        }
        return "";
      }

      export function renderSessionItem(session, kind?) {
        var activeClass = session.id === state.selectedId ? " active" : "";
        var selectedClass = state.sessionsManageMode && state.selectedSessionIds[session.id] ? " selected" : "";
        var metaStatus = getSessionStatusLabel(session);
        var metaStatusClass = getSessionStatusClass(session);
        var resumeButton = "";
        var checkbox = renderManageCheckbox("sessions", session.id, "选择会话 " + session.command);

        if ((session.provider === "claude" || session.provider === "codex") && session.claudeSessionId) {
          if (session.status !== "running" && !state.sessionsManageMode && !isStructuredSession(session)) {
            var resumeTitle = session.provider === "codex" ? "恢复 Codex 会话" : "恢复 Claude 会话";
            resumeButton = '<button class="session-action-btn" data-action="resume" data-session-id="' + session.id + '" type="button" aria-label="' + resumeTitle + '" title="' + resumeTitle + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';
          }
        }

        var canOpenMerge = !state.sessionsManageMode && session.worktreeEnabled && session.worktree && session.worktree.branch && session.worktree.path;
        var needsCleanup = session.worktreeMergeStatus === "merged" && session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false;
        var mergeDisabled = session.status === "running" || session.worktreeMergeStatus === "merging";
        var mergeTitle = needsCleanup ? "重试清理 worktree" : "合并到主分支";
        var mergeButton = canOpenMerge && session.worktreeMergeStatus !== "merged"
          ? '<button class="session-action-btn merge-btn" data-action="worktree-merge" data-session-id="' + session.id + '" type="button" aria-label="' + escapeHtml(mergeTitle) + '" title="' + escapeHtml(mergeTitle) + '"' + (mergeDisabled ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10"/><path d="M7 12h10"/><path d="M7 17h10"/><path d="M5 7l-2 2 2 2"/><path d="M19 15l2 2-2 2"/></svg></button>'
          : needsCleanup
            ? '<button class="session-action-btn merge-btn" data-action="worktree-cleanup" data-session-id="' + session.id + '" type="button" aria-label="重试清理 worktree" title="重试清理 worktree"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>'
            : "";
        var deleteButton = state.sessionsManageMode ? '' : '<button class="session-action-btn delete-btn" data-action="delete-session" data-session-id="' + session.id + '" type="button" aria-label="删除会话" title="删除此会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
        var actionsHtml = '<span class="session-actions">' + resumeButton + mergeButton + deleteButton + '</span>';

        // Model-generated topic, with legacy summary/command fallbacks.
        var titleHtml = session.title || session.summary
          ? '<div class="session-title">' + escapeHtml(session.title || session.summary) + '</div>'
          : '<div class="session-command">' + escapeHtml(session.resumedFromSessionId ? session.command.replace(/\s+--resume\s+\S+/, '').replace(/\s+resume\s+[0-9a-f-]+/, '') : session.command) + '</div>';

        // Activity description for running sessions
        var activityDesc = getSessionActivityDesc(session);
        var activityHtml = "";
        if (session.status === "running" && activityDesc) {
          activityHtml = '<div class="session-activity">' + escapeHtml(activityDesc) + '</div>';
        }
        var descriptionHtml = session.description
          ? '<div class="session-description">' + escapeHtml(session.description) + '</div>'
          : '';

        // Time display
        var timeDisplay = "";
        if (session.status === "running") {
          timeDisplay = '<span class="session-time" title="已运行 ' + escapeHtml(elapsedTime(session.startedAt)) + '">' + escapeHtml(elapsedTime(session.startedAt)) + '</span>';
        } else if (session.endedAt) {
          timeDisplay = '<span class="session-time" title="' + escapeHtml(new Date(session.endedAt).toLocaleString()) + '">' + escapeHtml(timeAgo(session.endedAt)) + '</span>';
        } else if (session.startedAt) {
          timeDisplay = '<span class="session-time" title="' + escapeHtml(new Date(session.startedAt).toLocaleString()) + '">' + escapeHtml(timeAgo(session.startedAt)) + '</span>';
        }

        // Badges: worktree only (removed PTY/Structured and mode badges for cleaner look)
        var badgesHtml = renderWorktreeBadge(session);

        // Recovery hint
        var recoveryHtml = session.autoRecovered ? '<span class="session-recovery-hint">自动恢复</span>' : '';

        // Swipe-to-delete 红色背板（管理模式下不显示，避免与多选 UI 冲突）
        var swipeBgHtml = state.sessionsManageMode ? '' :
          '<div class="session-swipe-bg" aria-hidden="true">' +
            '<button class="session-swipe-delete" data-action="swipe-delete-session" data-session-id="' + session.id + '" type="button" tabindex="-1" aria-label="删除会话">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>' +
              '<span>删除</span>' +
            '</button>' +
          '</div>';

        return '<div class="session-item' + activeClass + selectedClass + '" data-session-id="' + session.id + '" role="button" tabindex="0">' +
          swipeBgHtml +
          '<div class="session-item-content">' +
            '<div class="session-item-row">' +
              checkbox +
              '<div class="session-main">' +
                '<div class="session-title-row">' +
                  titleHtml +
                  timeDisplay +
                '</div>' +
                descriptionHtml +
                activityHtml +
                '<div class="session-meta">' +
                  '<span class="session-status ' + metaStatusClass + '">' + escapeHtml(metaStatus) + '</span>' +
                  badgesHtml +
                  recoveryHtml +
                '</div>' +
              '</div>' +
              actionsHtml +
            '</div>' +
          '</div>' +
        '</div>';
      }

      export function getWorktreeMergeStatusLabel(session) {
        if (!session || !session.worktreeMergeStatus) return "";
        var labels = {
          ready: "可合并",
          checking: "检查中",
          merging: "合并中",
          merged: session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false ? "已合并待清理" : "已合并",
          failed: "合并失败"
        };
        return labels[session.worktreeMergeStatus] || "";
      }

      export function renderWorktreeMergeBadge(session) {
        var label = getWorktreeMergeStatusLabel(session);
        if (!label) return "";
        return '<span class="session-kind-badge worktree-merge ' + escapeHtml(session.worktreeMergeStatus || "") + '">' + escapeHtml(label) + '</span>';
      }

      export function renderWorktreeBadge(session) {
        if (!session || !session.worktreeEnabled) return "";
        var titleParts = [];
        if (session.worktree && session.worktree.branch) {
          titleParts.push('Worktree: ' + session.worktree.branch);
        }
        if (session.worktree && session.worktree.path) {
          titleParts.push('Path: ' + session.worktree.path);
        }
        var title = titleParts.length > 0 ? ' title="' + escapeHtml(titleParts.join('\n')) + '"' : '';
        return '<span class="session-kind-badge worktree"' + title + '>Worktree</span>' + renderWorktreeMergeBadge(session);
      }

      export function renderSessionKindBadge(session) {
        if (!session) return "";
        var primary = isStructuredSession(session)
          ? '<span class="session-kind-badge structured">Structured</span>'
          : '<span class="session-kind-badge pty">PTY</span>';
        return primary + renderWorktreeBadge(session);
      }

      export function renderModeCards(selectedMode) {
        var modes = [
          { id: "managed",     label: "托管",     desc: "全自动完成任务" },
          { id: "full-access", label: "全权限",   desc: "自动确认权限" },
          { id: "auto-edit",   label: "自动编辑", desc: "自动确认修改" },
          { id: "default",     label: "标准",     desc: "逐步确认操作" },
          { id: "native",      label: "原生",     desc: "原生结构化输出" }
        ];
        return modes.map(function(m) {
          var active = m.id === selectedMode ? " active" : "";
          return '<button type="button" class="mode-card' + active + '" data-mode="' + m.id + '">' +
            '<span class="mode-card-label">' + m.label + '</span>' +
            '<span class="mode-card-desc">' + m.desc + '</span>' +
          '</button>';
        }).join("");
      }

      export function renderProviderOptions(selectedTool) {
        var tools = [
          { id: "claude", label: "Claude", desc: "完整 Claude 会话能力" },
          { id: "codex", label: "Codex", desc: "结构化 JSONL 或 PTY 会话" }
        ];
        return tools.map(function(tool) {
          var active = tool.id === selectedTool ? " active" : "";
          return '<button type="button" class="mode-card provider-card' + active + '" data-provider="' + tool.id + '">' +
            '<span class="mode-card-label">' + tool.label + '</span>' +
            '<span class="mode-card-desc">' + tool.desc + '</span>' +
          '</button>';
        }).join("");
      }

      export function renderSessionKindOptions(selectedKind) {
        var kinds = [
          { id: "structured", label: "结构化", desc: "智能对话模式" },
          { id: "pty", label: "PTY", desc: "交互式终端会话" }
        ];
        return kinds.map(function(kind) {
          var active = kind.id === selectedKind ? " active" : "";
          var disabled = "";
          return '<button type="button" class="mode-card session-kind-card' + active + disabled + '" data-session-kind="' + kind.id + '">' +
            '<span class="mode-card-label">' + kind.label + '</span>' +
            '<span class="mode-card-desc">' + kind.desc + '</span>' +
          '</button>';
        }).join("");
      }

      export function renderWorktreeToggle(enabled) {
        return '<label class="session-inline-toggle" for="session-worktree-toggle" title="为该会话创建独立的 git worktree 分支">' +
          '<svg class="session-inline-toggle-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<circle cx="6" cy="6" r="2.2"/>' +
            '<circle cx="18" cy="6" r="2.2"/>' +
            '<circle cx="12" cy="18" r="2.2"/>' +
            '<path d="M6 8.2v3.4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8.2"/>' +
            '<path d="M12 13.6v2.2"/>' +
          '</svg>' +
          '<span class="session-inline-toggle-label">Worktree 模式</span>' +
          '<input id="session-worktree-toggle" type="checkbox" class="switch-toggle"' + (enabled ? ' checked' : '') + ' />' +
          '<span class="switch-slider" aria-hidden="true"></span>' +
        '</label>';
      }

      export function getSessionKindHint(kind) {
        var tool = state.sessionTool || "claude";
        if (kind === "structured") {
          return tool === "codex"
            ? "Codex JSONL 结构化聊天界面，支持多轮对话和工具调用展示。"
            : "结构化聊天界面，支持多轮对话、流式输出和工具调用展示。";
        }
        if (tool === "codex") {
          return "Codex PTY 终端会话；terminal 是原始输出，chat 是解析后的阅读视图。";
        }
        return "原始 PTY 终端会话，支持持续交互、终端视图和权限流。";
      }

      export function renderSessionModal() {
        var modalTool = getPreferredTool();
        var modalMode = getSafeModeForTool(modalTool, state.modeValue || state.chatMode || "default");
        var sessionKind = state.sessionCreateKind || "structured";
        var worktreeEnabled = state.sessionCreateWorktree === true;
        return '<section id="session-modal" class="modal-backdrop hidden">' +
          '<div class="modal session-modal">' +
            '<div class="modal-header">' +
              '<div>' +
                '<h2 class="modal-title">新对话</h2>' +
                '<p class="modal-subtitle">启动 Claude 或 Codex 会话，选择 provider、会话类型、模式和工作目录。</p>' +
              '</div>' +
              '<button id="close-modal-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label">Provider</label>' +
                '<div id="provider-cards" class="mode-cards">' +
                  renderProviderOptions(modalTool) +
                '</div>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label">会话类型</label>' +
                '<div id="session-kind-cards" class="mode-cards">' +
                  renderSessionKindOptions(sessionKind) +
                '</div>' +
                '<div class="field-hint session-kind-hint-row">' +
                  '<span id="session-kind-description">' + escapeHtml(getSessionKindHint(sessionKind)) + '</span>' +
                  // Worktree 模式入口暂时隐藏，保留 renderWorktreeToggle/state.sessionCreateWorktree 以便后续恢复
                  // renderWorktreeToggle(worktreeEnabled) +
                '</div>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="cwd">工作目录</label>' +
                '<div class="suggestions-wrap">' +
                  '<input id="cwd" type="text" class="field-input" autocomplete="off" placeholder="' + escapeHtml(getEffectiveCwd()) + '" />' +
                  '<div id="cwd-suggestions" class="suggestions hidden"></div>' +
                '</div>' +
                '<p class="field-hint">创建前先确认目录；留空则使用上方目录，支持路径自动补全。</p>' +
                '<div id="recent-paths-bubbles" class="recent-paths-bubbles"></div>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label">模式</label>' +
                '<div id="mode-cards" class="mode-cards">' +
                  renderModeCards(modalMode) +
                '</div>' +
                '<p id="mode-description" class="field-hint">' + escapeHtml(getToolModeHint(modalTool, modalMode)) + '</p>' +
              '</div>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button id="run-button" class="btn btn-primary btn-block">启动会话</button>' +
              '<p id="modal-error" class="error-message hidden"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }
