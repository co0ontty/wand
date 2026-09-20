import { state } from "./state";
import "./i18n";
import { persistSelectedId } from "./chat-scroll";
import { wandConfirm } from "./notifications";
import { showActionError } from "./composer-action-error";
import { updateSessionsList, refreshAll } from "./session-engine";

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
