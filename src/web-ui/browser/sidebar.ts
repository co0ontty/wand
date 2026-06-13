import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import { persistSelectedId } from "./chat-scroll";
import { closeSwipedItem } from "./input";
import { showError, wandConfirm } from "./notifications";
import { updateSessionsList, refreshAll, isStructuredSession } from "./session-engine";
import { renderSessionItem } from "./session-ui";

// Functions defined in other modules (scripts.js IIFE scope)

      // 「最近」分组的统一数据源：未归档 active sessions + 24h 内 Claude 历史，
      // 一起按"创建时间"倒序排（session 用 startedAt，history 用 timestamp）。
      // 展开侧栏的「最近」和折叠侧栏的窄条都基于这份列表渲染，序号严格对应。
      export function getRecentEntries() {
        var cutoff = Date.now() - 24 * 60 * 60 * 1000;
        var entries: any[] = [];
        state.sessions.forEach(function(s: any) {
          if (s.archived) return;
          var t = s.startedAt ? new Date(s.startedAt).getTime() : 0;
          entries.push({ kind: "session", ref: s, t: isFinite(t) ? t : 0 });
        });
        if (state.claudeHistoryLoaded) {
          getVisibleClaudeHistorySessions().forEach(function(h: any) {
            if (!h.timestamp) return;
            var t = new Date(h.timestamp).getTime();
            if (!isFinite(t) || t <= cutoff) return;
            entries.push({ kind: "history", ref: h, t: t });
          });
        }
        entries.sort(function(a, b) { return b.t - a.t; });
        return entries;
      }

      export function renderSessions() {
        // Claude/Codex history is rendered INLINE as the final collapsible
        // group of this same scrolling list (see renderClaudeHistoryGroup),
        // styled like 已归档. There is no separate docked region anymore —
        // that previously stranded an empty void above the footer.
        var archivedSessions = state.sessions.filter(function(session: any) { return session.archived; });
        var groups: any[] = [];
        groups.push(renderSessionManageBar());

        var recentEntries = getRecentEntries();
        var historyGroup = renderClaudeHistoryGroup();

        if (recentEntries.length > 0) {
          groups.push(renderRecentGroup(recentEntries));
        }
        if (archivedSessions.length > 0) {
          groups.push(renderArchivedGroup(archivedSessions));
        }
        if (recentEntries.length === 0 && archivedSessions.length === 0 && !historyGroup) {
          return renderSessionManageBar() + '<div class="empty-state"><strong>还没有会话记录</strong><br>点击上方「新对话」开始你的第一次对话。</div>';
        }
        if (historyGroup) {
          groups.push(historyGroup);
        }
        return groups.join("");
      }

      export function isSidebarNarrow() {
        // 桌面: pinned + collapsed = 56px 窄条。
        // 手机: pinned + collapsed 同样允许窄条（pin 单独不在手机生效，但 collapsed 是窄条形态的标志）。
        return !!state.sidebarPinned && !!state.sidebarCollapsed;
      }

      export function renderCollapsedSessionTiles() {
        var entries = getRecentEntries();
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
          return '<button class="sidebar-collapsed-tile history" type="button" data-collapsed-history-id="' + escapeHtml(h.claudeSessionId) + '" data-cwd="' + escapeHtml(h.cwd || "") + '" title="' + escapeHtml(hTitle) + '">' + idx + '</button>';
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
            '<span class="sidebar-intro">最近的会话记录</span>' +
            '<button class="btn btn-ghost btn-xs session-manage-toggle" data-action="toggle-manage-mode" type="button">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' +
              '<span>管理</span>' +
            '</button>' +
          '</div>';
        }

        var sessionCount = getSelectedSessionIds().length;
        var historyCount = getSelectedClaudeHistoryIds().length;
        var totalCount = sessionCount + historyCount;
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

      export function renderSessionGroup(title: any, sessions: any, kind?: any) {
        return '<section class="session-group">' +
          '<div class="session-group-title">' + escapeHtml(title) + '</div>' +
          sessions.map(function(session: any) { return renderSessionItem(session, kind); }).join("") +
        '</section>';
      }

      export function renderArchivedGroup(archivedSessions: any) {
        var expanded = !!state.archivedExpanded;
        var chevron = expanded ? "&#9662;" : "&#9656;";
        var header = '<div class="session-group-title claude-history-toggle" data-action="toggle-archived-group">' +
          '<span class="chevron">' + chevron + '</span> 已归档 ' +
          '<span class="history-count">' + archivedSessions.length + '</span>' +
          '</div>';
        if (!expanded) {
          return '<section class="session-group">' + header + '</section>';
        }
        var items = archivedSessions.map(function(session: any) { return renderSessionItem(session, "sessions"); }).join("");
        return '<section class="session-group">' + header + items + '</section>';
      }

      export function renderRecentGroup(entries: any) {
        // No "最近" group title here — the section intro ("最近的会话记录") above
        // already labels this group, so a second label would be redundant.
        var html = '<section class="session-group session-group--recent">';
        html += entries.map(function(e: any) {
          return e.kind === "session"
            ? renderSessionItem(e.ref, "sessions")
            : renderClaudeHistoryItem(e.ref, "history");
        }).join("");
        html += '</section>';
        return html;
      }

      // Compute the items eligible for the history region (older than 24h —
       // the recent-24h ones already show in the recent group above).
      export function getClaudeHistoryRegionItems() {
        var cutoff = Date.now() - 24 * 60 * 60 * 1000;
        return getVisibleClaudeHistorySessions().filter(function(s: any) {
          return !s.timestamp || new Date(s.timestamp).getTime() <= cutoff;
        });
      }

      // Render history as the final INLINE collapsible group of #sessions-list,
      // styled like the 已归档 group. Returns '' when history is fully loaded
      // and empty, so a workspace with no older CLI history shows no stray
      // "历史会话 0" row (and no stranded bar above the footer).
      export function renderClaudeHistoryGroup() {
        var visibleHistory = getClaudeHistoryRegionItems();
        var loaded = !!state.claudeHistoryLoaded;
        var codexVisible = getVisibleCodexHistorySessions();
        var codexLoaded = !!state.codexHistoryLoaded;
        var fullyLoaded = loaded && codexLoaded;
        var count = (loaded ? visibleHistory.length : 0) + (codexLoaded ? codexVisible.length : 0);
        if (fullyLoaded && count === 0) return '';

        var expanded = !!state.claudeHistoryExpanded;
        var chevron = expanded ? "&#9662;" : "&#9656;";
        var countContent = fullyLoaded ? (count > 999 ? "999+" : String(count)) : "···";
        var header = '<div class="session-group-title claude-history-toggle session-history-toggle" id="claude-history-toggle" role="button" tabindex="0" aria-expanded="' + expanded + '" title="' + (expanded ? "收起历史会话" : "展开历史会话") + '">' +
          '<span class="chevron">' + chevron + '</span> 历史会话 ' +
          '<span class="history-count' + (fullyLoaded ? '' : ' loading') + '">' + countContent + '</span>' +
        '</div>';
        var body = expanded
          ? '<div class="session-history-body">' + renderClaudeHistoryBodyContent(visibleHistory) + renderCodexHistoryBodyContent(codexVisible) + '</div>'
          : '';
        return '<section class="session-group session-group--history">' + header + body + '</section>';
      }

      export function renderClaudeHistoryBodyContent(visibleHistory: any) {
        if (!state.claudeHistoryLoaded) {
          return '<div class="claude-history-loading">扫描历史会话中…</div>';
        }
        if (visibleHistory.length === 0) {
          // Group is only rendered when there is content somewhere (Claude or
          // Codex); a Claude-empty/Codex-present case shows just the Codex list.
          return '';
        }
        var groups: any = {};
        var groupOrder: any[] = [];
        visibleHistory.forEach(function(s: any) {
          if (!groups[s.cwd]) {
            groups[s.cwd] = [];
            groupOrder.push(s.cwd);
          }
          groups[s.cwd].push(s);
        });
        var toolbar = '<div class="sidebar-history-toolbar">' +
          '<button class="btn btn-ghost btn-xs sidebar-history-clear" data-action="clear-all-history" type="button">清空全部</button>' +
        '</div>';
        var listHtml = '';
        groupOrder.forEach(function(cwd: any) {
          var cwdShort = cwd.split("/").filter(Boolean).slice(-3).join("/");
          var isDirExpanded = !!state.claudeHistoryExpandedDirs[cwd];
          listHtml += renderClaudeHistoryDirectoryHeader(cwd, cwdShort, groups[cwd].length, isDirExpanded);
          if (isDirExpanded) {
            listHtml += groups[cwd].map(function(session: any) { return renderClaudeHistoryItem(session, "history"); }).join("");
          }
        });
        return toolbar + '<div class="sidebar-history-scroll">' + listHtml + '</div>';
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

      export function clearManageSelections() {
        state.selectedSessionIds = {};
        state.selectedClaudeHistoryIds = {};
      }

      export function toggleManageMode(force?: any) {
        state.sessionsManageMode = typeof force === "boolean" ? force : !state.sessionsManageMode;
        if (state.sessionsManageMode && !state.claudeHistoryLoaded) {
          // 进入管理模式即后台补齐 Claude 历史，让「已选 N」「全选」计数从一开始
          // 就覆盖全部历史，而不是只统计已加载的那部分。
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
        return getSelectableSessions().length + getVisibleClaudeHistorySessions().length;
      }

      export function selectAllVisibleItems() {
        // 全选语义 = 选中所有可管理项（会话 + 全部 Claude 历史）。历史在登录后
        // 异步扫描，若用户在扫描完成前点「全选」，state.claudeHistory 仍为空会漏选，
        // 删除时表现为"只删了已加载的，跨目录/未扫完的历史还在"。这里先确保历史
        // 加载完成再全选。
        if (!state.claudeHistoryLoaded) {
          ensureClaudeHistoryLoaded().then(selectAllVisibleItems);
          return;
        }
        // 展开 Claude 历史分组，让用户能直观看到这些历史项也被选中了。
        state.claudeHistoryExpanded = true;
        var nextSessionIds: any = {};
        getSelectableSessions().forEach(function(session: any) {
          nextSessionIds[session.id] = true;
        });
        var nextHistoryIds: any = {};
        getVisibleClaudeHistorySessions().forEach(function(session: any) {
          nextHistoryIds[session.claudeSessionId] = true;
        });
        state.selectedSessionIds = nextSessionIds;
        state.selectedClaudeHistoryIds = nextHistoryIds;
        updateSessionsList();
      }

      export function clearSelections() {
        clearManageSelections();
        updateSessionsList();
      }

      export function toggleManagedItemSelection(kind: any, id: any) {
        if (!state.sessionsManageMode || !id) return;
        var target = kind === "history" ? state.selectedClaudeHistoryIds : state.selectedSessionIds;
        if (target[id]) {
          delete target[id];
        } else {
          target[id] = true;
        }
        updateSessionsList();
      }

      export function renderManageCheckbox(kind: any, id: any, label: any) {
        if (!state.sessionsManageMode) return '';
        var selected = kind === "history" ? !!state.selectedClaudeHistoryIds[id] : !!state.selectedSessionIds[id];
        return '<label class="session-manage-check">' +
          '<input type="checkbox" data-action="toggle-selection" data-kind="' + escapeHtml(kind) + '" data-id="' + escapeHtml(id) + '"' + (selected ? ' checked' : '') + ' aria-label="' + escapeHtml(label) + '">' +
          '<span></span>' +
        '</label>';
      }

      // Returns a Promise<boolean>. Uses the Liquid Glass styled wandConfirm
      // when available, falls back to native confirm during early page boot.
      export function confirmDelete(message: any, options?: any) {
        if (typeof (window as any).wandConfirm === "function") {
          return (window as any).wandConfirm(message, Object.assign({ type: "danger", danger: true, okLabel: "删除" }, options || {}));
        }
        return Promise.resolve(window.confirm(message));
      }

      export function batchDeleteSelected() {
        var sessionIds = getSelectedSessionIds();
        var historyIds = getSelectedClaudeHistoryIds();
        var total = sessionIds.length + historyIds.length;
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

          Promise.all(requests)
            .then(function() {
              if (sessionIds.indexOf(state.selectedId) !== -1) {
                state.selectedId = null;
                persistSelectedId();
              }
              state.claudeHistory = state.claudeHistory.filter(function(session: any) {
                return historyIds.indexOf(session.claudeSessionId) === -1;
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

      export function renderCodexHistoryDirectoryHeader(cwd: any, cwdShort: any, count: any, isExpanded: any) {
        var chevron = isExpanded ? "▾" : "▸";
        return '<div class="claude-history-directory-header codex-history-directory-header" data-action="toggle-codex-history-directory" data-cwd="' + escapeHtml(cwd) + '" role="button" tabindex="0">' +
          '<div class="session-group-title claude-history-directory-title">' +
            '<span class="chevron">' + chevron + '</span>' +
            '<span class="claude-history-directory-label">' + escapeHtml(cwdShort) + ' (' + count + ')</span>' +
          '</div>' +
        '</div>';
      }

      export function renderCodexHistoryBodyContent(visibleHistory: any) {
        if (!state.codexHistoryLoaded) {
          return '<div class="claude-history-loading">扫描 Codex 历史会话中…</div>';
        }
        if (visibleHistory.length === 0) {
          return '';
        }
        var groups: any = {};
        var groupOrder: any[] = [];
        visibleHistory.forEach(function(s: any) {
          if (!groups[s.cwd]) {
            groups[s.cwd] = [];
            groupOrder.push(s.cwd);
          }
          groups[s.cwd].push(s);
        });
        var listHtml = '<div class="sidebar-history-section-label">Codex</div>';
        groupOrder.forEach(function(cwd: any) {
          var cwdShort = cwd.split("/").filter(Boolean).slice(-3).join("/");
          var isDirExpanded = !!state.codexHistoryExpandedDirs[cwd];
          listHtml += renderCodexHistoryDirectoryHeader(cwd, cwdShort, groups[cwd].length, isDirExpanded);
          if (isDirExpanded) {
            listHtml += groups[cwd].map(function(session: any) { return renderClaudeHistoryItem(session, "codex"); }).join("");
          }
        });
        return '<div class="sidebar-history-scroll codex-history-scroll">' + listHtml + '</div>';
      }

      export function renderClaudeHistoryDirectoryHeader(cwd: any, cwdShort: any, count: any, isExpanded: any) {
        var chevron = isExpanded ? "&#9662;" : "&#9656;";
        return '<div class="claude-history-directory-header" data-action="toggle-history-directory" data-cwd="' + escapeHtml(cwd) + '" role="button" tabindex="0">' +
          '<div class="session-group-title claude-history-directory-title">' +
            '<span class="chevron">' + chevron + '</span>' +
            '<span class="claude-history-directory-label">' + escapeHtml(cwdShort) + ' (' + count + ')</span>' +
            '<button class="btn btn-danger btn-xs claude-history-directory-clear-btn" data-action="delete-history-directory" data-cwd="' +
            escapeHtml(cwd) + '" type="button" aria-label="清空此目录的历史会话" title="清空此目录的历史会话">清空此目录</button>' +
          '</div>' +
        '</div>';
      }

      export function renderClaudeHistoryItem(session: any, kind: any) {
        var isCodex = kind === "codex";
        var rAct = isCodex ? "resume-codex-history" : "resume-history";
        var dAct = isCodex ? "delete-codex-history" : "delete-history";
        var selMap = isCodex ? state.selectedCodexHistoryIds : state.selectedClaudeHistoryIds;
        var shortId = session.claudeSessionId.slice(0, 8);
        var preview = session.firstUserMessage || "(空会话)";
        var timeStr = formatHistoryTime(session.timestamp);
        var checkbox = renderManageCheckbox(kind, session.claudeSessionId, "选择历史会话 " + preview);
        var deleteButton = state.sessionsManageMode ? '' :
          '<button class="session-action-btn delete-btn" data-action="' + dAct + '" data-claude-session-id="' +
          session.claudeSessionId + '" type="button" aria-label="删除会话" title="隐藏此历史会话"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>';
        var resumeButton = state.sessionsManageMode ? '' :
          '<button class="session-action-btn" data-action="' + rAct + '" data-claude-session-id="' +
          session.claudeSessionId + '" data-cwd="' + escapeHtml(session.cwd) +
          '" type="button" aria-label="恢复会话" title="' + (isCodex ? "恢复此 Codex 历史会话" : "恢复此 Claude 历史会话") + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L3 10"/></svg></button>';

        return '<div class="session-item claude-history-item' + (state.sessionsManageMode && selMap[session.claudeSessionId] ? ' selected' : '') + '" data-claude-history-id="' + session.claudeSessionId + '" data-cwd="' + escapeHtml(session.cwd) + '" role="button" tabindex="0">' +
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
        ensureCodexHistoryLoaded();
        if (state.claudeHistoryLoaded) return Promise.resolve();
        if (_claudeHistoryLoadingPromise) return _claudeHistoryLoadingPromise;
        _claudeHistoryLoadingPromise = loadClaudeHistory().then(function() {
          _claudeHistoryLoadingPromise = null;
        }, function() {
          _claudeHistoryLoadingPromise = null;
        });
        return _claudeHistoryLoadingPromise;
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
