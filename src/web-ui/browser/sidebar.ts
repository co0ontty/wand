import { state } from "./state";
import "./i18n";
import { persistSelectedId } from "./chat-scroll";
import { wandConfirm } from "./notifications";
import { showActionError } from "./composer-action-error";
import { updateSessionsList, refreshAll } from "./session-engine";
import { parseJsonResponse } from "../react/http-adapter";
import { getErrorMessage } from "../../error-utils.js";

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
            .then(function(res) {
              // 全部失败时服务端回 400 + {error}；部分成功回 {ok:true, failed:[…]}。
              // 必须按状态解析：历史实现只 res.json() 就当成功，于是「删失败」也会
              // 清空选择并 refresh，用户看到的是「选中项丢了、会话还在」。
              return parseJsonResponse<{ failed?: string[] }>(res);
            })
            .then(function(payload) {
              var failed = payload && Array.isArray(payload.failed) ? payload.failed : [];
              if (failed.length > 0) {
                showActionError('有 ' + failed.length + ' 个会话未能删除，请重试。');
              }
              // 当前会话确实被删掉（而不是删除失败）时才取消选中。
              if (sessionIds.indexOf(state.selectedId) !== -1
                && failed.indexOf(state.selectedId) === -1) {
                state.selectedId = null;
                persistSelectedId();
              }
              // 部分成功时只保留失败项的选择，成功删除的项自然从列表消失；
              // 用户可以直接对失败项重试，不必重新定位它们。
              clearManageSelections();
              failed.forEach(function(id) { state.selectedSessionIds[id] = true; });
              return refreshAll();
            })
            .catch(function(error) {
              showActionError(getErrorMessage(error, '无法批量删除所选项目。'));
            });
        });
      }
