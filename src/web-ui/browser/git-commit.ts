import { state } from "./state";
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

      // 顶栏 git 徽章归 React Shell 渲染；这里只发布状态，不写其 DOM。
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
