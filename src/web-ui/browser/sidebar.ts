import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import { persistSelectedId } from "./chat-scroll";
import { closeSwipedItem } from "./input";
import { showError, wandConfirm } from "./notifications";
import { updateSessionsList, refreshAll, isStructuredSession } from "./session-engine";
import { renderSessionItem } from "./session-ui";

const NON_WAND_SESSIONS_EXPANDED_KEY = "wand-non-wand-sessions-expanded";
const AUTOMATION_SESSIONS_EXPANDED_KEY = "wand-automation-sessions-expanded";

function getSecondaryGroupStorageKey(group: HTMLDetailsElement) {
  if (group.classList.contains("automation-session-group")) return AUTOMATION_SESSIONS_EXPANDED_KEY;
  if (group.classList.contains("non-wand-session-group")) return NON_WAND_SESSIONS_EXPANDED_KEY;
  return "";
}

// Native <details> keeps the interaction lightweight. Persist its state so a
// background list refresh does not unexpectedly collapse the group.
document.addEventListener("toggle", function(event) {
  var group = event.target as HTMLDetailsElement | null;
  if (!group || !group.classList) return;
  var storageKey = getSecondaryGroupStorageKey(group);
  if (!storageKey) return;
  if (state.sessionsManageMode) {
    if (!group.open) group.open = true;
    return;
  }
  writeStoredBoolean(storageKey, group.open);
}, true);

document.addEventListener("click", function(event) {
  var target = event.target as Element | null;
  if (!target || typeof target.closest !== "function") return;

  // Keep every selectable item visible while batch management is active.
  if (target.closest(".non-wand-session-group.manage-mode > summary, .automation-session-group.manage-mode > summary")) {
    event.preventDefault();
    return;
  }

  var compactTrigger = target.closest("[data-expand-session-group]") as HTMLElement | null;
  if (!compactTrigger) return;
  var targetGroup = compactTrigger.dataset.expandSessionGroup;
  var storageKey = targetGroup === "automation"
    ? AUTOMATION_SESSIONS_EXPANDED_KEY
    : targetGroup === "non-wand"
      ? NON_WAND_SESSIONS_EXPANDED_KEY
      : "";
  if (!storageKey) return;
  writeStoredBoolean(storageKey, true);
  var collapseButton = document.getElementById("sidebar-collapse-btn");
  if (collapseButton) collapseButton.click();
});

// Functions defined in other modules (scripts.js IIFE scope)

      export function isAutomationSession(session: any) {
        var source = String(session && session.sessionSource || "").toLowerCase();
        return source === "automation" || source === "startup";
      }

      function sortSessionEntries(entries: any[]) {
        return entries.sort(function(a, b) { return b.t - a.t; });
      }

      // 三个来源各自在组内按时间倒序，辅助会话不会再改变普通 Wand 会话
      // 的展示顺序或窄栏编号。缺失来源按 interactive 兼容旧数据。
      export function getSessionEntryGroups() {
        var wandEntries: any[] = [];
        var automationEntries: any[] = [];
        var nonWandEntries: any[] = [];
        state.sessions.forEach(function(s: any) {
          var t = s.startedAt ? new Date(s.startedAt).getTime() : 0;
          var entry = { kind: "session", ref: s, t: isFinite(t) ? t : 0 };
          (isAutomationSession(s) ? automationEntries : wandEntries).push(entry);
        });
        if (state.claudeHistoryLoaded) {
          getVisibleClaudeHistorySessions().forEach(function(h: any) {
            var t = h.timestamp ? new Date(h.timestamp).getTime() : Number(h.mtimeMs) || 0;
            if (!isFinite(t)) t = Number(h.mtimeMs) || 0;
            nonWandEntries.push({ kind: "history", ref: h, t: t });
          });
        }
        if (state.codexHistoryLoaded) {
          getVisibleCodexHistorySessions().forEach(function(h: any) {
            var t = h.timestamp ? new Date(h.timestamp).getTime() : Number(h.mtimeMs) || 0;
            nonWandEntries.push({ kind: "codex", ref: h, t: isFinite(t) ? t : 0 });
          });
        }
        return {
          wand: sortSessionEntries(wandEntries),
          automation: sortSessionEntries(automationEntries),
          nonWand: sortSessionEntries(nonWandEntries)
        };
      }

      export function getSessionEntries() {
        var groups = getSessionEntryGroups();
        return groups.wand.concat(groups.automation, groups.nonWand);
      }

      export function renderSessions() {
        var groups: any[] = [];
        groups.push(renderSessionManageBar());
        var entries = getSessionEntryGroups();
        if (entries.wand.length + entries.automation.length + entries.nonWand.length === 0) {
          return renderSessionManageBar() + '<div class="empty-state"><strong>还没有会话记录</strong><br>点击上方「新对话」开始你的第一次对话。</div>';
        }
        if (entries.wand.length > 0) groups.push(renderSessionEntries(entries.wand));
        if (entries.automation.length > 0) groups.push(renderAutomationSessionGroup(entries.automation));
        if (entries.nonWand.length > 0) groups.push(renderNonWandSessionGroup(entries.nonWand));
        return groups.join("");
      }

      export function isSidebarNarrow() {
        // 桌面: pinned + collapsed = 56px 窄条。
        // 手机: pinned + collapsed 同样允许窄条（pin 单独不在手机生效，但 collapsed 是窄条形态的标志）。
        return !!state.sidebarPinned && !!state.sidebarCollapsed;
      }

      export function renderCollapsedSessionTiles() {
        var entries = getSessionEntryGroups();
        var tiles = entries.wand.map(function(e: any, i: any) {
          var idx = i + 1;
          var s = e.ref;
          var activeCls = s.id === state.selectedId ? " active" : "";
          var title = s.title || s.description || s.summary || s.command || ("会话 " + idx);
          return '<button class="sidebar-collapsed-tile' + activeCls + '" type="button" data-collapsed-session-id="' + escapeHtml(s.id) + '" title="' + escapeHtml(title) + '">' + idx + '</button>';
        }).join("");
        var automationCount = entries.automation.length;
        var automationActive = entries.automation.some(function(entry: any) { return entry.ref.id === state.selectedId; });
        var automationTile = automationCount > 0
          ? '<button class="sidebar-collapsed-tile automation-count-tile' + (automationActive ? ' active-group' : '') + '" type="button" data-expand-session-group="automation" title="展开查看 ' + automationCount + ' 个自动化会话" aria-label="展开查看 ' + automationCount + ' 个自动化会话">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>' +
              '<span class="non-wand-count-badge">' + (automationCount > 99 ? "99+" : automationCount) + '</span>' +
            '</button>'
          : '';
        var nonWandCount = entries.nonWand.length;
        var nonWandTile = nonWandCount > 0
          ? '<button class="sidebar-collapsed-tile non-wand-count-tile" type="button" data-expand-session-group="non-wand" title="展开查看 ' + nonWandCount + ' 个非 Wand 会话" aria-label="展开查看 ' + nonWandCount + ' 个非 Wand 会话">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>' +
              '<span class="non-wand-count-badge">' + (nonWandCount > 99 ? "99+" : nonWandCount) + '</span>' +
            '</button>'
          : '';
        // 窄条底部固定一个「+」快速新建会话方块，替代被隐藏的 footer 新会话入口。
        var addTile = '<button class="sidebar-collapsed-tile add" type="button" data-collapsed-new-session="1" title="新建会话" aria-label="新建会话">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
          '</button>';
        return '<div class="sidebar-collapsed-tiles">' + tiles + automationTile + nonWandTile + addTile + '</div>';
      }

      export function renderSessionsListContent() {
        return isSidebarNarrow() ? renderCollapsedSessionTiles() : renderSessions();
      }

      export function renderSessionManageBar() {
        if (!state.sessionsManageMode) {
          return '<div class="session-manage-bar">' +
            '<span class="sidebar-intro">Wand 会话</span>' +
            '<button class="btn btn-ghost btn-xs session-manage-toggle" data-action="toggle-manage-mode" type="button">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' +
              '<span>管理</span>' +
            '</button>' +
          '</div>';
        }

        var sessionCount = getSelectedSessionIds().length;
        var historyCount = getSelectedClaudeHistoryIds().length;
        var codexCount = getSelectedCodexHistoryIds().length;
        var totalCount = sessionCount + historyCount + codexCount;
        var hasAny = totalCount > 0;
        var selectable = countSelectableItems();
        var allSelected = selectable > 0 && totalCount >= selectable;
        var selectAllLabel = allSelected ? "取消全选" : "全选";
        var selectAllAction = allSelected ? "clear-selection" : "select-all-visible";
        var selectAllDisabled = selectable === 0 ? ' disabled' : '';

        // Flat in-place toolbar (NOT a popped card): the same sub-header row
        // morphs to [✕]  N 已选 ........ 全选/取消全选  删除. Sticky to the top
        // of the scroll so the count + delete stay reachable while selecting.
        var exitBtn = '<button class="session-manage-exit" data-action="toggle-manage-mode" type="button" aria-label="退出管理模式" title="退出管理模式">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' +
        '</button>';
        var summary = hasAny
          ? '<span class="session-manage-count">' + totalCount + '</span><span class="session-manage-summary-label">已选择</span>'
          : '<span class="session-manage-summary-label muted">选择要管理的项目</span>';
        return '<div class="session-manage-bar active">' +
          exitBtn +
          '<div class="session-manage-summary">' + summary + '</div>' +
          '<div class="session-manage-actions">' +
            '<button class="btn btn-ghost btn-xs" data-action="' + selectAllAction + '" type="button"' + selectAllDisabled + '>' + selectAllLabel + '</button>' +
            '<button class="btn btn-danger btn-xs" data-action="delete-selected" type="button"' + (hasAny ? '' : ' disabled') + '>删除' + (hasAny ? ' ' + totalCount : '') + '</button>' +
          '</div>' +
        '</div>';
      }

      export function renderSessionEntries(entries: any, extraClass?: any) {
        var html = '<section class="session-group' + (extraClass ? ' ' + extraClass : '') + '">';
        html += entries.map(function(e: any) {
          return e.kind === "session"
            ? renderSessionItem(e.ref, "sessions")
            : renderClaudeHistoryItem(e.ref, e.kind);
        }).join("");
        html += '</section>';
        return html;
      }

      export function renderNonWandSessionGroup(entries: any) {
        var expanded = state.sessionsManageMode || readStoredBoolean(NON_WAND_SESSIONS_EXPANDED_KEY, false);
        return '<details class="non-wand-session-group' + (state.sessionsManageMode ? ' manage-mode' : '') + '"' + (expanded ? ' open' : '') + '>' +
          '<summary class="non-wand-session-summary" title="Claude 与 Codex 的本机原生会话，不参与 Wand 会话排序">' +
            '<span class="non-wand-session-icon" aria-hidden="true">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>' +
            '</span>' +
            '<span class="non-wand-session-title">非 Wand 会话</span>' +
            '<span class="non-wand-session-count" aria-label="' + entries.length + ' 个会话">' + entries.length + '</span>' +
            '<svg class="non-wand-session-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
          '</summary>' +
          renderSessionEntries(entries, "non-wand-session-list") +
        '</details>';
      }

      export function renderAutomationSessionGroup(entries: any) {
        var expanded = state.sessionsManageMode || readStoredBoolean(AUTOMATION_SESSIONS_EXPANDED_KEY, false);
        return '<details class="automation-session-group' + (state.sessionsManageMode ? ' manage-mode' : '') + '"' + (expanded ? ' open' : '') + '>' +
          '<summary class="automation-session-summary" title="由自动化或启动任务创建，不参与普通 Wand 会话排序">' +
            '<span class="automation-session-icon" aria-hidden="true">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>' +
            '</span>' +
            '<span class="automation-session-title">自动化</span>' +
            '<span class="automation-session-count" aria-label="' + entries.length + ' 个会话">' + entries.length + '</span>' +
            '<svg class="automation-session-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
          '</summary>' +
          renderSessionEntries(entries, "automation-session-list") +
        '</details>';
      }

      export function getVisibleClaudeHistorySessions() {
        var managedIds = new Set();
        state.sessions.forEach(function(s: any) {
          if (s.claudeSessionId) managedIds.add(s.claudeSessionId);
        });
        return state.claudeHistory.filter(function(s: any) {
          return s.hasConversation && !s.managedByWand && !managedIds.has(s.claudeSessionId);
        });
      }

      export function getSelectedSessionIds() {
        return Object.keys(state.selectedSessionIds).filter(function(id) { return !!state.selectedSessionIds[id]; });
      }

      export function getSelectedClaudeHistoryIds() {
        return Object.keys(state.selectedClaudeHistoryIds).filter(function(id) { return !!state.selectedClaudeHistoryIds[id]; });
      }

      export function getSelectedCodexHistoryIds() {
        return Object.keys(state.selectedCodexHistoryIds).filter(function(id) { return !!state.selectedCodexHistoryIds[id]; });
      }

      export function clearManageSelections() {
        state.selectedSessionIds = {};
        state.selectedClaudeHistoryIds = {};
        state.selectedCodexHistoryIds = {};
      }

      export function toggleManageMode(force?: any) {
        state.sessionsManageMode = typeof force === "boolean" ? force : !state.sessionsManageMode;
        if (state.sessionsManageMode && (!state.claudeHistoryLoaded || !state.codexHistoryLoaded)) {
          // 进入管理模式即后台补齐两个 provider，让计数从一开始覆盖完整列表。
          ensureClaudeHistoryLoaded().then(updateSessionsList);
        }
        if (!state.sessionsManageMode) {
          clearManageSelections();
          closeSwipedItem();
        }
        updateSessionsList();
      }

      export function getSelectableSessions() {
        return state.sessions.slice();
      }

      export function countSelectableItems() {
        return getSelectableSessions().length + getVisibleClaudeHistorySessions().length + getVisibleCodexHistorySessions().length;
      }

      export function selectAllVisibleItems() {
        // 全选语义 = 选中所有可管理项（会话 + 全部 Claude 历史）。历史在登录后
        // 异步扫描，若用户在扫描完成前点「全选」，state.claudeHistory 仍为空会漏选，
        // 删除时表现为"只删了已加载的，跨目录/未扫完的历史还在"。这里先确保历史
        // 加载完成再全选。
        if (!state.claudeHistoryLoaded || !state.codexHistoryLoaded) {
          ensureClaudeHistoryLoaded().then(selectAllVisibleItems);
          return;
        }
        var nextSessionIds: any = {};
        getSelectableSessions().forEach(function(session: any) {
          nextSessionIds[session.id] = true;
        });
        var nextHistoryIds: any = {};
        getVisibleClaudeHistorySessions().forEach(function(session: any) {
          nextHistoryIds[session.claudeSessionId] = true;
        });
        var nextCodexIds: any = {};
        getVisibleCodexHistorySessions().forEach(function(session: any) {
          nextCodexIds[session.claudeSessionId] = true;
        });
        state.selectedSessionIds = nextSessionIds;
        state.selectedClaudeHistoryIds = nextHistoryIds;
        state.selectedCodexHistoryIds = nextCodexIds;
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

      export function renderManageCheckbox(kind: any, id: any, label: any) {
        if (!state.sessionsManageMode) return '';
        var selected = kind === "history"
          ? !!state.selectedClaudeHistoryIds[id]
          : kind === "codex"
            ? !!state.selectedCodexHistoryIds[id]
            : !!state.selectedSessionIds[id];
        return '<label class="session-manage-check">' +
          '<input type="checkbox" data-action="toggle-selection" data-kind="' + escapeHtml(kind) + '" data-id="' + escapeHtml(id) + '"' + (selected ? ' checked' : '') + ' aria-label="' + escapeHtml(label) + '">' +
          '<span></span>' +
        '</label>';
      }

      // Always use Wand's in-page confirmation so iOS / Android WebViews do not
      // fall back to differently styled platform JavaScript dialogs.
      export function confirmDelete(message: any, options?: any) {
        return wandConfirm(message, Object.assign({ type: "danger", danger: true, okLabel: "删除" }, options || {}));
      }

      export function batchDeleteSelected() {
        var sessionIds = getSelectedSessionIds();
        var historyIds = getSelectedClaudeHistoryIds();
        var codexIds = getSelectedCodexHistoryIds();
        var total = sessionIds.length + historyIds.length + codexIds.length;
        if (!total) return;
        confirmDelete('确认删除所选 ' + total + ' 项吗？此操作无法撤销。', {
          title: "删除所选 " + total + " 项",
        }).then(function(ok: any) {
          if (!ok) return;

          var requests: any[] = [];
          if (sessionIds.length > 0) {
            requests.push(fetch('/api/sessions/batch-delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ sessionIds: sessionIds })
            }).then(function(res) { return res.json(); }));
          }
          if (historyIds.length > 0) {
            requests.push(fetch('/api/claude-history/batch-delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ claudeSessionIds: historyIds })
            }).then(function(res) { return res.json(); }));
          }
          if (codexIds.length > 0) {
            requests.push(fetch('/api/codex-history/batch-delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ claudeSessionIds: codexIds })
            }).then(function(res) { return res.json(); }));
          }

          Promise.all(requests)
            .then(function() {
              if (sessionIds.indexOf(state.selectedId) !== -1) {
                state.selectedId = null;
                persistSelectedId();
              }
              state.claudeHistory = state.claudeHistory.filter(function(session: any) {
                return historyIds.indexOf(session.claudeSessionId) === -1;
              });
              state.codexHistory = state.codexHistory.filter(function(session: any) {
                return codexIds.indexOf(session.claudeSessionId) === -1;
              });
              clearManageSelections();
              return refreshAll();
            })
            .catch(function() {
              var errorEl = document.getElementById('action-error');
              showError(errorEl, '无法批量删除所选项目。');
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
            var errorEl = document.getElementById('action-error');
            showError(errorEl, '无法清空历史会话。');
          });
        });
      }

      export function renderClaudeHistoryItem(session: any, kind: any) {
        var isCodex = kind === "codex";
        var rAct = isCodex ? "resume-codex-history" : "resume-history";
        var dAct = isCodex ? "delete-codex-history" : "delete-history";
        var selMap = isCodex ? state.selectedCodexHistoryIds : state.selectedClaudeHistoryIds;
        var shortId = session.claudeSessionId.slice(0, 8);
        var preview = session.firstUserMessage || "(空会话)";
        var timeStr = formatHistoryTime(session.timestamp);
        var checkbox = renderManageCheckbox(kind, session.claudeSessionId, "选择会话 " + preview);
        var deleteButton = state.sessionsManageMode ? '' :
          '<button class="session-action-btn delete-btn" data-action="' + dAct + '" data-claude-session-id="' +
          session.claudeSessionId + '" type="button" aria-label="删除会话" title="删除会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
        var resumeButton = state.sessionsManageMode ? '' :
          '<button class="session-action-btn" data-action="' + rAct + '" data-claude-session-id="' +
          session.claudeSessionId + '" data-cwd="' + escapeHtml(session.cwd) +
          '" type="button" aria-label="恢复会话" title="' + (isCodex ? "恢复此 Codex 会话" : "恢复此 Claude 会话") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';

        return '<div class="session-item non-wand-session' + (state.sessionsManageMode && selMap[session.claudeSessionId] ? ' selected' : '') + '" data-claude-history-id="' + session.claudeSessionId + '" data-provider="' + (isCodex ? 'codex' : 'claude') + '" data-cwd="' + escapeHtml(session.cwd) + '" role="button" tabindex="0">' +
          '<div class="session-item-content">' +
            '<div class="session-item-row">' +
              checkbox +
              '<div class="session-main">' +
                '<div class="session-command claude-history-preview">' + escapeHtml(preview) + '</div>' +
                '<div class="session-meta">' +
                  '<span class="session-id" title="' + escapeHtml(session.claudeSessionId) + '">' + escapeHtml(shortId) + '</span>' +
                  '<span>' + escapeHtml(timeStr) + '</span>' +
                '</div>' +
              '</div>' +
              '<span class="session-actions">' + resumeButton + deleteButton + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }
      export function formatHistoryTime(isoStr: any) {
        if (!isoStr) return "";
        try {
          var d = new Date(isoStr);
          var now = new Date();
          var diffMs = (now as any) - (d as any);
          var diffMin = Math.floor(diffMs / 60000);
          if (diffMin < 1) return "刚刚";
          if (diffMin < 60) return diffMin + " 分钟前";
          var diffHr = Math.floor(diffMin / 60);
          if (diffHr < 24) return diffHr + " 小时前";
          var diffDay = Math.floor(diffHr / 24);
          if (diffDay < 30) return diffDay + " 天前";
          return d.toLocaleDateString();
        } catch (e) {
          return "";
        }
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

      export function getVisibleCodexHistorySessions() {
        var managedIds = new Set();
        state.sessions.forEach(function(s: any) {
          if (s.claudeSessionId) managedIds.add(s.claudeSessionId);
        });
        return state.codexHistory.filter(function(s: any) {
          return s.hasConversation && !s.managedByWand && !managedIds.has(s.claudeSessionId);
        });
      }
