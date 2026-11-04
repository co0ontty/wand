import { state } from "./state";
import "./chat-render-loader";
import "./chat-scroll";
import { showToast } from "./notifications";
import "./render";
import { refreshAll } from "./session-engine";
import {
  configureQuickCommitRuntime,
  quickCommitController,
} from "../react/quick-commit/controller";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { createGitStatusRefresh } from "./git-status-refresh";
import { createGitStatusCache, nextGitStatusRequestTime } from "./git-status-cache";
import { prepareFilePreviewForCompetingOverlay } from "./file-preview-adapter";
import { closeReactOverlays } from "./react-overlay-coordinator";

// Functions defined in other modules (scripts.js IIFE scope)

      // 顶栏 git 徽章归 React Shell 渲染；这里只发布状态，不写其 DOM。
      export function updateTopbarGitBadge() {
        notifyLegacyUiChange("topbar:git");
      }

      /** 工作区变更信号合并刷新；切换和回前台主动取数，空闲期间不轮询。 */
      var gitStatusRefresh = createGitStatusRefresh({
        coalesceMs: 1200,
        selectedSessionId: function() { return state.selectedId; },
        refresh: function(sessionId: string) { void loadGitStatus(sessionId, { force: true }); },
      });

      /** 已经取过的状态按会话缓存：切会话时先用缓存，徽章不会闪一下就没。 */
      var gitStatusCache = createGitStatusCache<any>();
      const gitStatusRequests = new Map<string, Promise<any>>();
      const gitStatusInvalidations = new Map<string, number>();
      const gitStatusReadInvalidations = new Map<string, number>();
      const gitStatusFollowups = new Set<string>();

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
        if (!gitStatusCache.accept(sessionId, status, requestedAt ?? nextGitStatusRequestTime())) return;
        if (sessionId !== state.selectedId) return;
        displayGitStatus(sessionId, status, true);
      }

      /** 切会话/回首页：有缓存就用缓存的，没有就先不显示，不必等新的一次取数。 */
      export function restoreGitStatusForSession(sessionId: string | null) {
        displayGitStatus(sessionId, sessionId ? gitStatusCache.peek(sessionId) : null, false);
      }

      /** 工作区可能变了（回合结束/进程退出）→ 合并成一次强制刷新。 */
      export function scheduleGitStatusRefresh(changedSessionId?: string) {
        const selectedId = state.selectedId;
        if (!selectedId) return;
        if (changedSessionId && changedSessionId !== selectedId) {
          const changed = state.sessions.find(session => session.id === changedSessionId);
          const selected = state.sessions.find(session => session.id === selectedId);
          if (!changed?.cwd || changed.cwd !== selected?.cwd) return;
        }
        gitStatusInvalidations.set(selectedId, (gitStatusInvalidations.get(selectedId) ?? 0) + 1);
        gitStatusRefresh.schedule();
      }

      export function stopGitStatusRefresh() {
        gitStatusRefresh.stop();
      }

      export function loadGitStatus(sessionId: any, options?: any) {
        if (!sessionId) return Promise.resolve(null);
        var force = options && options.force;
        // Force bypasses a settled cache, never a request already reading this session.
        if (gitStatusRequests.has(sessionId)) {
          if (force && (gitStatusReadInvalidations.get(sessionId) ?? 0) !== (gitStatusInvalidations.get(sessionId) ?? 0)) {
            gitStatusFollowups.add(sessionId);
          }
          return gitStatusRequests.get(sessionId)!;
        }
        const cached = !force ? gitStatusCache.peek(sessionId, 1000) : null;
        if (cached) return Promise.resolve(cached);
        // This read covers all signals received before it starts, including a
        // second signal queued while an older read was waiting to finish.
        if (sessionId === state.selectedId) gitStatusRefresh.stop();
        const invalidation = gitStatusInvalidations.get(sessionId) ?? 0;
        gitStatusReadInvalidations.set(sessionId, invalidation);
        var requestedAt = nextGitStatusRequestTime();
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
            if (data?.error) throw new Error("git-status failed");
            if (invalidation === (gitStatusInvalidations.get(sessionId) ?? 0)) {
              applyGitStatusSnapshot(sessionId, data || { isGit: false }, requestedAt);
            }
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
            if (gitStatusRequests.get(sessionId) === promise) {
              gitStatusRequests.delete(sessionId);
              gitStatusReadInvalidations.delete(sessionId);
              // A change during the read needs one trailing read. Repeated
              // completion signals share it instead of starting parallel scans.
              const followup = gitStatusFollowups.delete(sessionId);
              if (followup && sessionId === state.selectedId && invalidation !== (gitStatusInvalidations.get(sessionId) ?? 0)) {
                void loadGitStatus(sessionId, { force: true });
              }
            }
          });
        gitStatusRequests.set(sessionId, promise);
        return promise;
      }

      configureQuickCommitRuntime({
        onOpen: function() {
          closeReactOverlays(["quickCommit"]);
        },
        onClose: function() {},
        onArchived: function() { void refreshAll(); },
        nextStatusRequestTime: nextGitStatusRequestTime,
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
