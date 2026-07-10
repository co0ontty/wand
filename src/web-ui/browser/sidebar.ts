import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import { persistSelectedId } from "./chat-scroll";
import { closeSwipedItem } from "./input";
import { showError, wandConfirm } from "./notifications";
import { updateSessionsList, refreshAll, isStructuredSession } from "./session-engine";
import { renderSessionItem } from "./session-ui";

// Functions defined in other modules (scripts.js IIFE scope)

      // 单一会话列表的数据源：Wand 会话（含已归档）与本机可恢复会话
      // 一起按创建/修改时间倒序排列。展开侧栏与折叠窄条共用这份顺序。
      export function getSessionEntries() {
        var entries: any[] = [];
        state.sessions.forEach(function(s: any) {
          var t = s.startedAt ? new Date(s.startedAt).getTime() : 0;
          entries.push({ kind: "session", ref: s, t: isFinite(t) ? t : 0 });
        });
        if (state.claudeHistoryLoaded) {
          getVisibleClaudeHistorySessions().forEach(function(h: any) {
            var t = h.timestamp ? new Date(h.timestamp).getTime() : Number(h.mtimeMs) || 0;
            if (!isFinite(t)) t = Number(h.mtimeMs) || 0;
            entries.push({ kind: "history", ref: h, t: t });
          });
        }
        if (state.codexHistoryLoaded) {
          getVisibleCodexHistorySessions().forEach(function(h: any) {
            var t = h.timestamp ? new Date(h.timestamp).getTime() : Number(h.mtimeMs) || 0;
            entries.push({ kind: "codex", ref: h, t: isFinite(t) ? t : 0 });
          });
        }
        entries.sort(function(a, b) { return b.t - a.t; });
        return entries;
      }

      export function renderSessions() {
        var groups: any[] = [];
        groups.push(renderSessionManageBar());
        var entries = getSessionEntries();
        if (entries.length === 0) {
          return renderSessionManageBar() + '<div class="empty-state"><strong>还没有会话记录</strong><br>点击上方「新对话」开始你的第一次对话。</div>';
        }
        groups.push(renderSessionEntries(entries));
        return groups.join("");
      }

      export function isSidebarNarrow() {
        // 桌面: pinned + collapsed = 56px 窄条。
        // 手机: pinned + collapsed 同样允许窄条（pin 单独不在手机生效，但 collapsed 是窄条形态的标志）。
        return !!state.sidebarPinned && !!state.sidebarCollapsed;
      }

      export function renderCollapsedSessionTiles() {
        var entries = getSessionEntries();
        var tiles = entries.map(function(e: any, i: any) {
          var idx = i + 1;
          if (e.kind === "session") {
            var s = e.ref;
            var activeCls = s.id === state.selectedId ? " active" : "";
            var title = s.title || s.description || s.summary || s.command || ("会话 " + idx);
            return '<button class="sidebar-collapsed-tile' + activeCls + '" type="button" data-collapsed-session-id="' + escapeHtml(s.id) + '" title="' + escapeHtml(title) + '">' + idx + '</button>';
          }
          var h = e.ref;
          var preview = h.firstUserMessage || "(空会话)";
          var hTitle = preview + " · " + formatHistoryTime(h.timestamp);
          return '<button class="sidebar-collapsed-tile" type="button" data-collapsed-history-id="' + escapeHtml(h.claudeSessionId) + '" data-provider="' + escapeHtml(e.kind === "codex" ? "codex" : "claude") + '" data-cwd="' + escapeHtml(h.cwd || "") + '" title="' + escapeHtml(hTitle) + '">' + idx + '</button>';
        }).join("");
        // 窄条底部固定一个「+」快速新建会话方块，替代被隐藏的 footer 新会话入口。
        var addTile = '<button class="sidebar-collapsed-tile add" type="button" data-collapsed-new-session="1" title="新建会话" aria-label="新建会话">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
          '</button>';
        return '<div class="sidebar-collapsed-tiles">' + tiles + addTile + '</div>';
      }

      export function renderSessionsListContent() {
        return isSidebarNarrow() ? renderCollapsedSessionTiles() : renderSessions();
      }

      export function renderSessionManageBar() {
        if (!state.sessionsManageMode) {
          return '<div class="session-manage-bar">' +
            '<span class="sidebar-intro">全部会话</span>' +
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

      export function renderSessionEntries(entries: any) {
        var html = '<section class="session-group">';
        html += entries.map(function(e: any) {
          return e.kind === "session"
            ? renderSessionItem(e.ref, "sessions")
            : renderClaudeHistoryItem(e.ref, e.kind);
        }).join("");
        html += '</section>';
        return html;
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

        return '<div class="session-item' + (state.sessionsManageMode && selMap[session.claudeSessionId] ? ' selected' : '') + '" data-claude-history-id="' + session.claudeSessionId + '" data-provider="' + (isCodex ? 'codex' : 'claude') + '" data-cwd="' + escapeHtml(session.cwd) + '" role="button" tabindex="0">' +
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
