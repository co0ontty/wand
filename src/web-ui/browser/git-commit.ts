import { state } from "./state";
import { iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import "./chat-render";
import "./chat-scroll";
import { showToast } from "./notifications";
import "./render";
import "./session-engine";
import {
  configureQuickCommitRuntime,
  quickCommitController,
} from "../react/quick-commit/controller";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { createGitStatusRefresh } from "./git-status-refresh";
import { createGitStatusCache } from "./git-status-cache";
import { prepareFilePreviewForCompetingOverlay } from "./file-preview-adapter";
import { closeReactOverlays } from "./react-overlay-coordinator";

// Functions defined in other modules (scripts.js IIFE scope)

      export function renderTopbarGitBadgeHtml() {
        if (!state.selectedId || !state.gitStatus || !state.gitStatus.isGit) return "";
        if (state.gitStatusSessionId !== state.selectedId) return "";
        var branch = state.gitStatus.branch || "?";
        var count = state.gitStatus.modifiedCount || 0;
        var titleText = branch + (count ? "  ·  " + count + " 个文件待提交" : "  ·  工作区干净");
        return '<button id="topbar-git-badge" class="topbar-git-badge" type="button" title="' + escapeHtml(titleText) + '" aria-label="快捷提交">'
          + '<svg class="topbar-git-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6"/></svg>'
          + '<span class="topbar-git-branch">' + escapeHtml(branch) + '</span>'
          + (count > 0
              ? '<span class="topbar-git-count">·' + count + '</span>'
              : '<span class="topbar-git-clean" aria-hidden="true">' + iconSvg("check", { size: 11, strokeWidth: 2.2 }) + '</span>')
          + '</button>';
      }

      // 顶栏 git 徽章归 React Shell 渲染（原目标 #topbar-git-slot 只存在于已删除的
      // legacy markup），这里只保留变更通知。
      export function updateTopbarGitBadge() {
        notifyLegacyUiChange("topbar:git");
      }

      /** 会话工作期间工作区随时会变，徽章不能只在切会话时取一次快照。 */
      var gitStatusRefresh = createGitStatusRefresh({
        coalesceMs: 1200,
        // 裸 shell、外部编辑器、别的终端手敲 git 都没有可用信号，只能兜底轮询。
        pollMs: 20000,
        selectedSessionId: function() { return state.selectedId; },
        hidden: function() { return document.hidden; },
        refresh: function(sessionId: string) { void loadGitStatus(sessionId, { force: true }); },
      });

      /** 已经取过的状态按会话缓存：切会话时先用它顶上，徽章不会闪一下就没。 */
      var gitStatusCache = createGitStatusCache<any>();

      /**
       * 写入展示状态。`fetched` 为 false 表示值来自缓存（不计入节流时间）。
       * 拿不到值时只把 `gitStatusSessionId` 清掉，让惰性取数路径（render /
       * loadSessions）会再来一次。
       */
      function displayGitStatus(sessionId: string | null, status: any, fetched: boolean) {
        state.gitStatus = status || null;
        state.gitStatusSessionId = status ? sessionId : null;
        if (fetched) state.gitStatusLastFetchAt = Date.now();
        updateTopbarGitBadge();
      }

      /**
       * 拿到一份新鲜状态。同一会话只认更晚发起的请求（两个请求可能交叉落地：
       * 回合结束的刷新与面板自己拉的取数），且只把当前会话的结果写到徽章上，
       * 其他会话先入缓存。
       */
      export function applyGitStatusSnapshot(sessionId: string, status: any, requestedAt?: number) {
        if (!gitStatusCache.accept(sessionId, status, requestedAt || Date.now())) return;
        if (sessionId !== state.selectedId) return;
        displayGitStatus(sessionId, status, true);
      }

      /** 切会话/回首页：有缓存就用缓存的，没有就先不显示，不必等新的一次取数。 */
      export function restoreGitStatusForSession(sessionId: string | null) {
        displayGitStatus(sessionId, sessionId ? gitStatusCache.peek(sessionId) : null, false);
      }

      /** 工作区可能变了（回合结束/进程退出）→ 合并成一次强制刷新。 */
      export function scheduleGitStatusRefresh() {
        gitStatusRefresh.schedule();
      }

      export function startGitStatusPolling() {
        gitStatusRefresh.startPolling();
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
        var requestedAt = Date.now();
        var promise = fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/git-status", {
          credentials: "same-origin"
        })
          .then(function(res) {
            // 404/401/500 这类失败与「真的不是 git 仓库」不同：不能拿它当
            // 非仓库去把徽章打没，这里当失败处理（retain 上一次的结果）。
            if (!res.ok) throw new Error("git-status " + res.status);
            return res.json();
          })
          .then(function(data: any) {
            applyGitStatusSnapshot(sessionId, data || { isGit: false }, requestedAt);
            return data;
          })
          .catch(function() {
            // 网络抖动同样不该把徽章打没：缓存里有这个会话的状态就继续用。
            var cached = gitStatusCache.peek(sessionId);
            if (sessionId === state.selectedId) {
              displayGitStatus(sessionId, cached, false);
            }
            return null;
          })
          .finally(function() {
            if (state.gitStatusInflight && state.gitStatusInflight.sessionId === sessionId) {
              state.gitStatusInflight = null;
            }
          });
        state.gitStatusInflight = { sessionId: sessionId, promise: promise };
        return promise;
      }

      configureQuickCommitRuntime({
        onOpen: function() {
          closeReactOverlays(["quickCommit"]);
        },
        onClose: function() {},
        onStatusLoaded: function(sessionId: string, status: any, requestedAt?: number) {
          applyGitStatusSnapshot(sessionId, status, requestedAt);
        },
        toast: function(message: string, tone: "success" | "error" | "info") {
          showToast(message, tone);
        },
      });

      export function openQuickCommitModal() {
        if (!state.selectedId) return;
        var sessionId = state.selectedId;
        var openIntent = function() {
          if (!closeReactOverlays(["quickCommit"])) return;
          quickCommitController.open({ sessionId: sessionId });
        };
        if (!prepareFilePreviewForCompetingOverlay(openIntent)) return;
        openIntent();
      }
