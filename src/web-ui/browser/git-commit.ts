import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import { PIXEL_AVATAR } from "./chat-render";
import { getConfigCwd } from "./chat-scroll";
import { showToast, wandConfirm } from "./notifications";
import { render, getEffectiveCwd } from "./render";
import { closeSessionModal, closeSettingsModal, closeWorktreeMergeModal, getToolModeHint, logout } from "./session-engine";
import {
  configureQuickCommitRuntime,
  quickCommitController,
} from "../react/quick-commit/controller";
import { isBrowserReactShellMounted } from "./shell-runtime";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { folderPickerController } from "../react/folder-picker/controller";
import { prepareFilePreviewForCompetingOverlay } from "./file-preview-adapter";

// Functions defined in other modules (scripts.js IIFE scope)

      export function renderTopbarGitBadgeHtml() {
        if (!state.selectedId || !state.gitStatus || !state.gitStatus.isGit) return "";
        if (state.gitStatusSessionId !== state.selectedId) return "";
        var branch = state.gitStatus.branch || "?";
        var count = state.gitStatus.modifiedCount || 0;
        var titleText = branch + (count ? "  ·  " + count + " 个文件待提交" : "  ·  工作区干净");
        return '<button id="topbar-git-badge" class="topbar-git-badge" type="button" title="' + escapeHtml(titleText) + '" aria-label="快捷提交">'
          + '<svg class="topbar-git-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8"/><path d="M18 11v1a3 3 0 0 1-3 3H9"/></svg>'
          + '<span class="topbar-git-branch">' + escapeHtml(branch) + '</span>'
          + (count > 0
              ? '<span class="topbar-git-count">·' + count + '</span>'
              : '<span class="topbar-git-clean" aria-hidden="true">✓</span>')
          + '</button>';
      }

      export function updateTopbarGitBadge() {
        if (isBrowserReactShellMounted()) {
          notifyLegacyUiChange("topbar:git");
          return;
        }
        var slot = document.getElementById("topbar-git-slot");
        if (!slot) return;
        slot.innerHTML = renderTopbarGitBadgeHtml();
        var btn = document.getElementById("topbar-git-badge");
        if (btn) {
          btn.addEventListener("click", function(e) {
            e.preventDefault();
            openQuickCommitModal();
          });
        }
      }

      /**
       * Render the topbar three-dot menu. Items are scoped to the currently
       * selected session — global actions (settings/install/switch-server/
       * logout) live in the sidebar footer, so we don't duplicate them here.
       */
      export function renderTopbarMoreMenuHtml(session: any) {
        if (!session) return "";
        var open = state.topbarMoreOpen;
        var hasClaudeId = !!session.claudeSessionId;
        var hasCwd = !!session.cwd;
        var canOpenMerge = session.worktreeEnabled && session.worktree && session.worktree.branch && session.worktree.path;
        var needsCleanup = session.worktreeMergeStatus === "merged" && session.worktreeMergeInfo && session.worktreeMergeInfo.cleanupDone === false;
        var mergeDisabled = session.status === "running" || session.worktreeMergeStatus === "merging";
        var showMerge = canOpenMerge && session.worktreeMergeStatus !== "merged";
        var showCleanup = needsCleanup;
        var hasInfoGroup = hasClaudeId || hasCwd || true; // session-id button always renders
        var hasActionGroup = showMerge || showCleanup || true; // delete button always renders

        var copyIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        var cloudIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.5-8.74A6 6 0 1 0 6 14h11.5z"/></svg>';
        var folderIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
        var hashIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>';
        var mergeIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10"/><path d="M7 12h10"/><path d="M7 17h10"/><path d="M5 7l-2 2 2 2"/><path d="M19 15l2 2-2 2"/></svg>';
        var trashIconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>';

        var infoItems = "";
        if (hasClaudeId) {
          var historyIdLabel = session.provider === "codex"
            ? "复制 Codex thread ID"
            : session.provider === "opencode"
              ? "复制 OpenCode session ID"
              : "复制 Claude 会话 ID";
          infoItems += '<button class="topbar-more-item" data-action="copy-claude-session-id" type="button" role="menuitem">' + cloudIconSvg + '<span>' + historyIdLabel + '</span></button>';
        }
        if (hasCwd) {
          infoItems += '<button class="topbar-more-item" data-action="copy-cwd" type="button" role="menuitem">' + folderIconSvg + '<span>复制工作目录</span></button>';
        }
        infoItems += '<button class="topbar-more-item" data-action="copy-session-id" type="button" role="menuitem">' + hashIconSvg + '<span>复制会话 ID</span></button>';

        var actionItems = "";
        if (showMerge) {
          actionItems += '<button class="topbar-more-item" data-action="worktree-merge" type="button" role="menuitem"' + (mergeDisabled ? ' disabled' : '') + '>' + mergeIconSvg + '<span>合并到主分支…</span></button>';
        } else if (showCleanup) {
          actionItems += '<button class="topbar-more-item" data-action="worktree-cleanup" type="button" role="menuitem">' + mergeIconSvg + '<span>重试 worktree 清理</span></button>';
        }
        actionItems += '<button class="topbar-more-item topbar-more-item-danger" data-action="delete-session" type="button" role="menuitem">' + trashIconSvg + '<span>删除当前会话</span></button>';

        var divider = (hasInfoGroup && hasActionGroup) ? '<div class="topbar-more-divider" role="separator"></div>' : '';

        return '<div class="topbar-more-wrap">' +
          '<button id="topbar-more-button" class="topbar-btn square' + (open ? ' active' : '') + '" type="button" aria-label="当前会话操作" aria-haspopup="menu" aria-expanded="' + (open ? 'true' : 'false') + '" title="当前会话操作"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>' +
          '<div id="topbar-more-menu" class="topbar-more-menu' + (open ? '' : ' hidden') + '" role="menu" aria-label="当前会话">' +
            infoItems +
            divider +
            actionItems +
          '</div>' +
        '</div>';
      }

      export function loadGitStatus(sessionId: any, options?: any) {
        if (!sessionId) return Promise.resolve(null);
        var force = options && options.force;
        // Same session, fetched within 1s, and no force → skip.
        var now = Date.now();
        if (!force && state.gitStatusSessionId === sessionId && state.gitStatus && (now - state.gitStatusLastFetchAt) < 1000) {
          return Promise.resolve(state.gitStatus);
        }
        if (state.gitStatusInflight && state.gitStatusInflight.sessionId === sessionId) {
          return state.gitStatusInflight.promise;
        }
        state.gitStatusLoading = true;
        var promise = fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/git-status", {
          credentials: "same-origin"
        })
          .then(function(res) { return res.ok ? res.json() : { isGit: false }; })
          .then(function(data: any) {
            state.gitStatus = data || { isGit: false };
            state.gitStatusSessionId = sessionId;
            state.gitStatusLastFetchAt = Date.now();
            updateTopbarGitBadge();
            return data;
          })
          .catch(function() {
            state.gitStatus = { isGit: false };
            state.gitStatusSessionId = sessionId;
            state.gitStatusLastFetchAt = Date.now();
            updateTopbarGitBadge();
            return null;
          })
          .finally(function() {
            state.gitStatusLoading = false;
            if (state.gitStatusInflight && state.gitStatusInflight.sessionId === sessionId) {
              state.gitStatusInflight = null;
            }
          });
        state.gitStatusInflight = { sessionId: sessionId, promise: promise };
        return promise;
      }

      configureQuickCommitRuntime({
        onOpen: function() {
          folderPickerController.closeIfOpen();
          closeWorktreeMergeModal();
          closeSessionModal();
          closeSettingsModal();
        },
        onClose: function() {},
        onRepositoryChanged: function(sessionId: string) {
          void loadGitStatus(sessionId, { force: true });
        },
        toast: function(message: string, tone: "success" | "error" | "info") {
          showToast(message, tone);
        },
      });

      export function openQuickCommitModal() {
        if (!state.selectedId) return;
        var sessionId = state.selectedId;
        var openIntent = function() {
          if (folderPickerController.isOpen() && !folderPickerController.closeIfOpen()) return;
          var worktree = window.__wandReactWorktreeMerge;
          if (worktree?.isOpen() && !worktree.closeIfOpen()) return;
          var newSession = window.__wandReactNewSession;
          if (newSession?.isOpen() && !newSession.closeIfOpen()) return;
          var settings = window.__wandReactSettings;
          if (settings?.isOpen() && !settings.closeIfOpen()) return;
          quickCommitController.open({ sessionId: sessionId });
        };
        if (!prepareFilePreviewForCompetingOverlay(openIntent)) return;
        openIntent();
      }

      export function closeQuickCommitModal() {
        quickCommitController.closeIfOpen();
      }
