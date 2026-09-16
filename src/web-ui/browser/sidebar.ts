import { state } from "./state";
import "./i18n";
import { persistSelectedId } from "./chat-scroll";
import { closeSwipedItem } from "./input";
import { wandConfirm } from "./notifications";
import { showActionError } from "./composer-action-error";
import { updateSessionsList, refreshAll } from "./session-engine";

      export function getVisibleClaudeHistorySessions() {
        var managedIds = new Set();
        state.sessions.forEach(function(s: any) {
          if (s.claudeSessionId) managedIds.add(s.claudeSessionId);
        });
        return state.claudeHistory.filter(function(s: any) {
          return s.hasConversation && !s.managedByWand && !managedIds.has(s.claudeSessionId);
        });
      }

      function getSelectedSessionIds() {
        return Object.keys(state.selectedSessionIds).filter(function(id) { return !!state.selectedSessionIds[id]; });
      }

      function clearManageSelections() {
        state.selectedSessionIds = {};
        state.selectedClaudeHistoryIds = {};
        state.selectedCodexHistoryIds = {};
      }

      export function toggleManageMode(force?: any) {
        state.sessionsManageMode = typeof force === "boolean" ? force : !state.sessionsManageMode;
        if (!state.sessionsManageMode) {
          clearManageSelections();
          closeSwipedItem();
        }
        updateSessionsList();
      }

      function getSelectableSessions() {
        return state.sessions.slice();
      }

      export function selectAllVisibleItems() {
        var nextSessionIds: any = {};
        getSelectableSessions().forEach(function(session: any) {
          nextSessionIds[session.id] = true;
        });
        state.selectedSessionIds = nextSessionIds;
        state.selectedClaudeHistoryIds = {};
        state.selectedCodexHistoryIds = {};
        updateSessionsList();
      }

      export function clearSelections() {
        clearManageSelections();
        updateSessionsList();
      }

      export function toggleManagedItemSelection(kind: any, id: any) {
        if (!state.sessionsManageMode || !id) return;
        var target = kind === "history"
          ? state.selectedClaudeHistoryIds
          : kind === "codex"
            ? state.selectedCodexHistoryIds
            : state.selectedSessionIds;
        if (target[id]) {
          delete target[id];
        } else {
          target[id] = true;
        }
        updateSessionsList();
      }

      // Always use Wand's in-page confirmation so iOS / Android WebViews do not
      // fall back to differently styled platform JavaScript dialogs.
      export function confirmDelete(message: any, options?: any) {
        return wandConfirm(message, Object.assign({ type: "danger", danger: true, okLabel: "删除" }, options || {}));
      }

      export function batchDeleteSelected() {
        var sessionIds = getSelectedSessionIds();
        var total = sessionIds.length;
        if (!total) return;
        confirmDelete('确认删除所选 ' + total + ' 项吗？此操作无法撤销。', {
          title: "删除所选 " + total + " 项",
        }).then(function(ok: any) {
          if (!ok) return;

          fetch('/api/sessions/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionIds: sessionIds })
          })
            .then(function(res) { return res.json(); })
            .then(function() {
              if (sessionIds.indexOf(state.selectedId) !== -1) {
                state.selectedId = null;
                persistSelectedId();
              }
              clearManageSelections();
              return refreshAll();
            })
            .catch(function() {
              showActionError('无法批量删除所选项目。');
            });
        });
      }

      export function clearAllClaudeHistory() {
        var cutoff = Date.now() - 24 * 60 * 60 * 1000;
        var visibleHistory = getVisibleClaudeHistorySessions().filter(function(s: any) {
          return !s.timestamp || new Date(s.timestamp).getTime() <= cutoff;
        });
        if (!visibleHistory.length) return;
        return confirmDelete('确认清空当前显示的 ' + visibleHistory.length + ' 条 Claude 历史吗？', {
          title: "清空 Claude 历史",
          okLabel: "清空",
        }).then(function(ok: any) {
          if (!ok) return;
          var deleteIds = visibleHistory.map(function(session: any) { return session.claudeSessionId; });
          return fetch('/api/claude-history/batch-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ claudeSessionIds: deleteIds })
        })
          .then(function(res) { return res.json(); })
          .then(function(data: any) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            state.claudeHistory = state.claudeHistory.filter(function(s: any) {
              return deleteIds.indexOf(s.claudeSessionId) === -1;
            });
            clearManageSelections();
            updateSessionsList();
          })
          .catch(function() {
            showActionError('无法清空历史会话。');
          });
        });
      }

      export function loadClaudeHistory() {
        return fetch("/api/claude-history", { credentials: "same-origin" })
          .then(function(res) {
            if (!res.ok) return [];
            return res.json();
          })
          .then(function(sessions: any) {
            state.claudeHistory = sessions || [];
            state.claudeHistoryLoaded = true;
            updateSessionsList();
          })
          .catch(function() {
            state.claudeHistoryLoaded = true;
            state.claudeHistory = [];
            updateSessionsList();
          });
      }

      // 去重包装：登录后历史会异步扫描，多个入口（管理模式、全选、展开分组）
      // 可能同时想确保历史就绪。共享同一个 in-flight Promise，避免重复 fetch，
      // 且在已加载时立即 resolve。
      var _claudeHistoryLoadingPromise: any = null;
      export function ensureClaudeHistoryLoaded() {
        var codexPromise = ensureCodexHistoryLoaded();
        if (!state.claudeHistoryLoaded && !_claudeHistoryLoadingPromise) {
          _claudeHistoryLoadingPromise = loadClaudeHistory().then(function() {
            _claudeHistoryLoadingPromise = null;
          }, function() {
            _claudeHistoryLoadingPromise = null;
          });
        }
        var claudePromise = _claudeHistoryLoadingPromise || Promise.resolve();
        return Promise.all([claudePromise, codexPromise]).then(function() {});
      }

      export function loadCodexHistory() {
        return fetch("/api/codex-history", { credentials: "same-origin" })
          .then(function(res) {
            if (!res.ok) return [];
            return res.json();
          })
          .then(function(sessions: any) {
            state.codexHistory = sessions || [];
            state.codexHistoryLoaded = true;
            updateSessionsList();
          })
          .catch(function() {
            state.codexHistoryLoaded = true;
            state.codexHistory = [];
            updateSessionsList();
          });
      }

      var _codexHistoryLoadingPromise: any = null;
      export function ensureCodexHistoryLoaded() {
        if (state.codexHistoryLoaded) return Promise.resolve();
        if (_codexHistoryLoadingPromise) return _codexHistoryLoadingPromise;
        _codexHistoryLoadingPromise = loadCodexHistory().then(function() {
          _codexHistoryLoadingPromise = null;
        }, function() {
          _codexHistoryLoadingPromise = null;
        });
        return _codexHistoryLoadingPromise;
      }
