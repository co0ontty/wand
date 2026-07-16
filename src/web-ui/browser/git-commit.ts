import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import { PIXEL_AVATAR } from "./chat-render";
import { getConfigCwd } from "./chat-scroll";
import { showToast, wandConfirm } from "./notifications";
import { render, getEffectiveCwd } from "./render";
import { closeSessionModal, closeSettingsModal, closeWorktreeMergeModal, getToolModeHint, logout, setupFocusTrap } from "./session-engine";

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

      var quickCommitEscHandler: any = null;
      var quickCommitDragCleanup: any = null;
      var quickCommitDragState: any = null;

      export function normalizeQuickCommitAction(value: any) {
        if (
          value === "commit-tag" ||
          value === "commit-tag-push" ||
          value === "commit-push"
        ) return value;
        return "commit";
      }

      export function getQuickCommitActionMeta(action: any) {
        action = normalizeQuickCommitAction(action);
        if (action === "commit-tag-push") {
          return {
            action: action,
            label: "Commit + Tag + Push",
            verb: "提交、打 Tag 并推送",
            withTag: true,
            push: true,
            tone: "all",
          };
        }
        if (action === "commit-tag") {
          return {
            action: action,
            label: "Commit + Tag",
            verb: "提交并打 Tag",
            withTag: true,
            push: false,
            tone: "tag",
          };
        }
        if (action === "commit-push") {
          return {
            action: action,
            label: "Commit + Push",
            verb: "提交并推送",
            withTag: false,
            push: true,
            tone: "push",
          };
        }
        return {
          action: "commit",
          label: "Commit",
          verb: "仅提交",
          withTag: false,
          push: false,
          tone: "commit",
        };
      }

      export function openQuickCommitModal() {
        if (!state.selectedId) return;
        state.quickCommitOpen = true;
        state.quickCommitSubmitting = false;
        state.quickCommitAutoGenerating = false;
        state.quickCommitError = "";
        state.quickCommitForm = {
          customMessage: "",
          tag: "",
          // Whether the user has manually edited the tag (so we stop auto-overwriting it).
          tagEdited: false,
        };
        state.quickCommitPushing = false;
        state.quickCommitPushError = "";
        state.quickCommitResult = null;
        state.quickCommitDragAction = "commit";
        closeWorktreeMergeModal();
        closeSessionModal();
        closeSettingsModal();
        rerenderQuickCommitModal();
        var modal = document.getElementById("quick-commit-modal");
        if (modal) {
          modal.classList.remove("hidden");
          state.lastFocusedElement = document.activeElement;
          setupFocusTrap(modal);
        }
        if (quickCommitEscHandler) document.removeEventListener("keydown", quickCommitEscHandler);
        quickCommitEscHandler = function(e: any) {
          if (e.key === "Escape" && state.quickCommitOpen && !state.quickCommitSubmitting && !state.quickCommitPushing) {
            closeQuickCommitModal();
          }
        };
        document.addEventListener("keydown", quickCommitEscHandler);
        loadGitStatus(state.selectedId, { force: true }).then(function() {
          if (!state.quickCommitOpen) return;
          rerenderQuickCommitModal();
        });
      }

      export function closeQuickCommitModal() {
        state.quickCommitOpen = false;
        state.quickCommitSubmitting = false;
        state.quickCommitError = "";
        state.quickCommitResult = null;
        state.quickCommitDragAction = "commit";
        var modal = document.getElementById("quick-commit-modal");
        if (modal) modal.classList.add("hidden");
        if (state.focusTrapHandler) {
          document.removeEventListener("keydown", state.focusTrapHandler);
          state.focusTrapHandler = null;
        }
        if (quickCommitEscHandler) {
          document.removeEventListener("keydown", quickCommitEscHandler);
          quickCommitEscHandler = null;
        }
        if (quickCommitDragCleanup) {
          quickCommitDragCleanup();
          quickCommitDragCleanup = null;
        }
        if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
          state.lastFocusedElement.focus();
        }
      }

      export function rerenderQuickCommitModal() {
        var modal = document.getElementById("quick-commit-modal");
        if (!modal) return;
        if (quickCommitDragCleanup) {
          quickCommitDragCleanup();
          quickCommitDragCleanup = null;
        }
        var html = renderQuickCommitModal();
        var temp = document.createElement("div");
        temp.innerHTML = html;
        var fresh = temp.querySelector("#quick-commit-modal");
        if (!fresh) return;
        modal.innerHTML = fresh.innerHTML;
        attachQuickCommitModalListeners();
      }

      export function attachQuickCommitModalListeners() {
        var closeBtn = document.getElementById("quick-commit-close-btn");
        if (closeBtn) closeBtn.addEventListener("click", closeQuickCommitModal);
        var cancelBtn = document.getElementById("quick-commit-cancel-btn");
        if (cancelBtn) cancelBtn.addEventListener("click", closeQuickCommitModal);

        var aiBtn = document.getElementById("quick-commit-ai-btn");
        if (aiBtn) aiBtn.addEventListener("click", generateCommitMessageAI);
        var msgEl = document.getElementById("quick-commit-message") as HTMLTextAreaElement | null;
        if (msgEl) {
          msgEl.addEventListener("input", function() {
            state.quickCommitForm.customMessage = msgEl!.value;
          });
          // Cmd/Ctrl+Enter submits, matching the common editor shortcut.
          msgEl.addEventListener("keydown", function(e) {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submitQuickCommit("commit");
            }
          });
        }
        var tagInput = document.getElementById("quick-commit-tag") as HTMLInputElement | null;
        if (tagInput) {
          tagInput.addEventListener("input", function() {
            state.quickCommitForm.tag = tagInput!.value;
            state.quickCommitForm.tagEdited = true;
          });
          tagInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter") {
              e.preventDefault();
              submitQuickCommit("commit-tag");
            }
          });
        }

        var pushAfterBtn = document.getElementById("quick-commit-push-after-btn");
        if (pushAfterBtn) pushAfterBtn.addEventListener("click", function() {
          var result = state.quickCommitResult || {};
          submitPushOnly({ pushCommits: true, pushTags: !!result.tagName, closeOnSuccess: true });
        });

        attachQuickCommitDrag();
      }

      // Compose the final action from which stations the orb attached during the drag.
      // Commit is implicit — every action starts with a commit.
      export function composeOrbAction(attached: any) {
        var hasTag  = !!(attached && attached.tag);
        var hasPush = !!(attached && attached.push);
        if (hasTag && hasPush) return "commit-tag-push";
        if (hasTag)  return "commit-tag";
        if (hasPush) return "commit-push";
        return "commit";
      }

      // How close (px) the pointer must come to a loose chip's home before that chip is
      // magnetically picked up into the chip currently being dragged.
      var QC_DOCK_PICKUP_R = 58;
      // Sub 球的拾取判定用「home 矩形外扩 padding」而不是大磁吸半径：它是高成本
      // scope 修饰符（递归提交 submodule），且宽屏 home 正好在通往发射区的路径上，
      // 给 58px 半径会被「甩向发射区」误吸。外扩矩形 = 必须真正划过球体才吸上。
      var QC_DOCK_SUB_HIT_PAD = 10;

      // A plain tap on a chip fires its own action directly (tag/push imply a commit too).
      // 返回 {action, sub}：sub 是正交修饰符——单击 Submodule 球 = 提交父仓库 + 递归 submodule。
      export function qcChipTapIntent(id: any) {
        if (id === "tag") return { action: "commit-tag", sub: false };
        if (id === "push") return { action: "commit-push", sub: false };
        if (id === "sub") return { action: "commit", sub: true };
        return { action: "commit", sub: false };
      }

      // Magnetic dock: three loose chips (Commit / Tag / Push) rest in a field. Grab ANY chip and
      // drag it; whenever the pointer brushes another chip it sticks to the travelling cluster and
      // moves along (ordered Commit → Tag → Push). Fling the cluster into the right-side ▶ pad to
      // fire compose(members) — a commit is always implied. Release anywhere else and every chip
      // springs back home. A plain tap (no drag) on a chip fires that chip's own action.
      export function attachQuickCommitDrag() {
        var field   = document.getElementById("qc-dock-field");
        var stage   = document.getElementById("qc-dock-stage");
        var launch  = document.getElementById("qc-dock-launch");
        var cluster = document.getElementById("qc-dock-cluster");
        if (!field || !stage || !launch || !cluster) return;

        var ACTION_ORDER = ["commit", "tag", "push"];
        var chips: any = {};
        ACTION_ORDER.forEach(function(id) { chips[id] = field!.querySelector('[data-chip="' + id + '"]'); });
        if (!chips.commit || !chips.tag || !chips.push) return;
        // Submodule 球是可选的第 4 个 chip（正交 scope 修饰符），仅在仓库含 submodule 时渲染。
        chips.sub = field.querySelector('[data-chip="sub"]');
        var hasSub = !!chips.sub;
        // 几何 / 渲染 / 事件 / class 清除遍历全集 ALL；action 合成只用 ACTION_ORDER。
        // 磁吸候选：动作球用大半径（QC_DOCK_PICKUP_R），sub 用窄判定（划过球体才吸上）。
        var ALL = hasSub ? ACTION_ORDER.concat(["sub"]) : ACTION_ORDER;

        function cw(id: any) { return chips[id] ? chips[id].offsetWidth : 90; }
        function chH()  { return chips.commit ? chips.commit.offsetHeight : 38; }

        function isCompactDock() {
          return window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
        }

        // Resting (home) positions. 三角布局：Tag 左下 / Commit 顶中 / Push 右下
        // —— 从 Tag 横向滑到 Push 的轨迹从不穿过 Commit，避免误触；同时三色球
        // 形成的 ∧ 三角既好看又便于磁吸拾取。Sub 球（可选 scope 修饰符）站在
        // 三角外的右侧中段，明确区分「附加项」与「主动作」。
        function homePositions(): any {
          var fw = field!.clientWidth, fh = field!.clientHeight, H = chH();
          var commitW = cw("commit"), tagW = cw("tag"), pushW = cw("push");

          if (isCompactDock() && hasSub) {
            // 窄屏 + Sub：2×2 网格——commit/tag 上行，push/sub 下行；Sub 落右下角。
            var topY2 = Math.max(8, fh * 0.20 - H / 2);
            var botY2 = Math.min(fh - H - 8, fh * 0.70 - H / 2);
            var colL = function(w: any) { return Math.max(8, fw * 0.27 - w / 2); };
            var colR = function(w: any) { return Math.min(fw - w - 8, fw * 0.73 - w / 2); };
            return {
              commit: { x: colL(commitW), y: topY2 },
              tag: { x: colR(tagW), y: topY2 },
              push: { x: colL(pushW), y: botY2 },
              sub: { x: colR(cw("sub")), y: botY2 }
            };
          }

          // 三角布局（窄屏无 Sub / 所有宽屏情形）：Commit 顶中、Tag 左下、Push 右下。
          // 宽屏给出更紧的三角（左右收到 28%/72%），同时保留足够 Y 偏移让顶端
          // 与底排之间的视觉距离 > 半个 chip 高，横向直划无误触。
          var compact = isCompactDock();
          var topY = compact
            ? Math.max(8, fh * 0.18 - H / 2)
            : Math.max(8, fh * 0.12);
          var bottomY = compact
            ? Math.min(fh - H - 8, fh * 0.72 - H / 2)
            : Math.min(fh - H - 8, fh * 0.88 - H);
          var leftRatio = compact ? 0.24 : 0.28;
          var rightRatio = compact ? 0.76 : 0.72;

          var pos: any = {
            commit: { x: Math.max(8, (fw - commitW) / 2), y: topY },
            tag: { x: Math.max(8, fw * leftRatio - tagW / 2), y: bottomY },
            push: { x: Math.min(fw - pushW - 8, fw * rightRatio - pushW / 2), y: bottomY }
          };
          if (hasSub) {
            // 宽屏 + Sub：把 Sub 放到三角右外侧中段，远离 Push 的磁吸热区，
            // 视觉上是「主动作三角 + 附加 scope」的清晰分层。
            var subW = cw("sub");
            pos.sub = {
              x: Math.min(fw - subW - 8, fw * 0.94 - subW / 2),
              y: Math.max(8, Math.min(fh - H - 8, (fh - H) / 2))
            };
          }
          return pos;
        }

        var home: any = {};
        function placeChip(id: any, x: any, y: any) {
          if (chips[id]) chips[id].style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)";
        }
        function layoutHome(animated: any) {
          home = homePositions();
          ALL.forEach(function(id) {
            chips[id].classList.toggle("qc-chip--anim", !!animated);
            placeChip(id, home[id].x, home[id].y);
          });
        }
        layoutHome(false);

        var drag: any = null;

        // Stack travelling members so a four-chip cluster stays compact near the pointer.
        // Labels do not need to remain fully readable while dragging; the exposed leading
        // edge is enough to show that another action has joined the cluster.
        function layoutCluster(members: any, cx: any, cy: any) {
          var H = chH(), stackStep = 24;
          var ids = ALL.filter(function(id) { return members.indexOf(id) >= 0; });
          var widest = ids.reduce(function(w: any, id: any) { return Math.max(w, cw(id)); }, 0);
          var total = widest + Math.max(0, ids.length - 1) * stackStep;
          var fh = field!.clientHeight;
          var x = cx - total / 2;
          var y = Math.max(2, Math.min(fh - H - 2, cy - H / 2));
          ids.forEach(function(id) { placeChip(id, x, y); x += stackStep; });
          return { x: cx - total / 2 - 7, y: y - 7, w: total + 14, h: H + 14 };
        }
        function showCluster(box: any) {
          cluster!.classList.add("is-active");
          cluster!.style.transform = "translate(" + box.x.toFixed(1) + "px," + box.y.toFixed(1) + "px)";
          cluster!.style.width  = box.w.toFixed(1) + "px";
          cluster!.style.height = box.h.toFixed(1) + "px";
        }
        function hideCluster() { cluster!.classList.remove("is-active"); }

        function clusterAction(members: any) {
          return composeOrbAction({
            commit: true,
            tag: members.indexOf("tag") >= 0,
            push: members.indexOf("push") >= 0,
          });
        }
        // sub 不进 action 字符串（tone 体系不翻倍），只作为正交布尔随 cluster 传出。
        function clusterIncludesSub(members: any) {
          return members.indexOf("sub") >= 0;
        }
        function setLaunchLabel(t: any) {
          var l = document.getElementById("qc-dock-launch-label");
          if (l) l.textContent = t;
        }
        function pointInLaunch(x: any, y: any) {
          var r = launch!.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        }

        function onDown(id: any) {
          return function(e: any) {
            if (chips[id].disabled || isQuickCommitOpInFlight()) return;
            drag = { anchor: id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, members: [id] };
            ALL.forEach(function(m) { chips[m].classList.remove("qc-chip--anim"); });
            chips[id].classList.add("is-grabbing");
            try { chips[id].setPointerCapture(e.pointerId); } catch (err) { /* ignored */ }
            stage!.classList.add("is-dragging");
            e.preventDefault();
          };
        }
        function onMove(e: any) {
          if (!drag || drag.pointerId !== e.pointerId) return;
          if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
          var fr = field!.getBoundingClientRect();
          var fx = e.clientX - fr.left, fy = e.clientY - fr.top;
          // magnetic pickup: any loose chip whose home center is near the pointer joins the cluster.
          ACTION_ORDER.forEach(function(id) {
            if (drag.members.indexOf(id) >= 0) return;
            var hx = home[id].x + cw(id) / 2, hy = home[id].y + chH() / 2;
            var dx = fx - hx, dy = fy - hy;
            if (Math.sqrt(dx * dx + dy * dy) < QC_DOCK_PICKUP_R) {
              drag.members.push(id);
              chips[id].classList.remove("qc-chip--anim");
              chips[id].classList.add("is-attached");
            }
          });
          // Sub 球也可被反向吸附（不只是当 anchor）：判定收窄为 home 矩形外扩
          // QC_DOCK_SUB_HIT_PAD —— 指针必须真正划过球体才吸上，水平甩向发射区
          // （从顶点 Commit 或底排 Tag/Push 出发）不会误吸这个高成本 scope 修饰符。
          if (hasSub && drag.members.indexOf("sub") < 0) {
            var sx0 = home.sub.x - QC_DOCK_SUB_HIT_PAD, sy0 = home.sub.y - QC_DOCK_SUB_HIT_PAD;
            var sx1 = home.sub.x + cw("sub") + QC_DOCK_SUB_HIT_PAD, sy1 = home.sub.y + chH() + QC_DOCK_SUB_HIT_PAD;
            if (fx >= sx0 && fx <= sx1 && fy >= sy0 && fy <= sy1) {
              drag.members.push("sub");
              chips.sub.classList.remove("qc-chip--anim");
              chips.sub.classList.add("is-attached");
            }
          }
          var box = layoutCluster(drag.members, fx, fy);
          var hot = pointInLaunch(e.clientX, e.clientY);
          stage!.setAttribute("data-hot", hot ? "1" : "0");
          stage!.setAttribute("data-action", clusterAction(drag.members));
          if (drag.members.length > 1) showCluster(box); else hideCluster();
          setLaunchLabel(hot ? "松手执行" : "提交");
        }
        function endDrag(e: any, cancelled: any) {
          if (!drag || drag.pointerId !== e.pointerId) return;
          var cur = drag; drag = null;
          stage!.classList.remove("is-dragging");
          stage!.setAttribute("data-hot", "0");
          setLaunchLabel("提交");
          hideCluster();
          ALL.forEach(function(m) { chips[m].classList.remove("is-grabbing", "is-attached"); });
          try { chips[cur.anchor].releasePointerCapture(cur.pointerId); } catch (err) { /* ignored */ }

          if (!cancelled && !cur.moved) {
            // plain tap → fire this chip's own action
            var tap = qcChipTapIntent(cur.anchor);
            submitQuickCommit(tap.action, tap.sub);
            return;
          }
          if (!cancelled && pointInLaunch(e.clientX, e.clientY)) {
            submitQuickCommit(clusterAction(cur.members), clusterIncludesSub(cur.members));
            return;
          }
          // released loose → everyone springs back home
          stage!.setAttribute("data-action", "commit");
          layoutHome(true);
        }

        var onResize = function() { if (state.quickCommitOpen && !drag) layoutHome(false); };
        window.addEventListener("resize", onResize);

        ALL.forEach(function(id) {
          var c = chips[id];
          c.addEventListener("pointerdown", onDown(id));
          c.addEventListener("pointermove", onMove);
          c.addEventListener("pointerup", function(e: any) { endDrag(e, false); });
          c.addEventListener("pointercancel", function(e: any) { endDrag(e, true); });
          c.addEventListener("keydown", function(e: any) {
            if (c.disabled || isQuickCommitOpInFlight()) return;
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              e.preventDefault();
              var tap = qcChipTapIntent(id);
              submitQuickCommit(tap.action, tap.sub);
            }
          });
        });

        launch.addEventListener("click", function() {
          if ((launch as any).disabled || isQuickCommitOpInFlight() || drag) return;
          submitQuickCommit("commit");
        });

        quickCommitDragCleanup = function() {
          window.removeEventListener("resize", onResize);
          drag = null;
        };
      }

      export function generateCommitMessageAI() {
        if (!state.selectedId || state.quickCommitGenerating) return;
        // Sync any in-flight DOM input back into state so "empty?" checks read the latest value
        var msgEl = document.getElementById("quick-commit-message") as HTMLTextAreaElement | null;
        if (msgEl) state.quickCommitForm.customMessage = msgEl.value;
        var tagEl = document.getElementById("quick-commit-tag") as HTMLInputElement | null;
        if (tagEl) state.quickCommitForm.tag = tagEl.value;
        state.quickCommitGenerating = true;
        state.quickCommitError = "";
        rerenderQuickCommitModal();
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/generate-commit-message", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then(function(res) {
            return res.json().then(function(data: any) { return { ok: res.ok, data: data }; });
          })
          .then(function(result: any) {
            if (!result.ok) throw new Error((result.data && result.data.error) || "AI 生成失败。");
            var data = result.data || {};
            var aiMessage = typeof data.message === "string" ? data.message : "";
            var aiTag = typeof data.suggestedTag === "string" ? data.suggestedTag.trim() : "";
            // "AI 生成" recommends BOTH a commit message and a version tag.
            // Fill the message only when empty (never clobber what the user typed).
            var currentMessage = (state.quickCommitForm.customMessage || "").trim();
            if (!currentMessage && aiMessage) {
              state.quickCommitForm.customMessage = aiMessage;
            }
            // Adopt the AI tag (smarter than the local patch-bump default) unless the
            // user has manually edited it, and switch to "commit + tag" so the
            // recommendation is actually applied on commit.
            if (aiTag) {
              if (!state.quickCommitForm.tagEdited) state.quickCommitForm.tag = aiTag;
              state.quickCommitDragAction = "commit-tag";
            }
          })
          .catch(function(error: any) {
            state.quickCommitError = (error && error.message) || "AI 生成失败。";
          })
          .finally(function() {
            state.quickCommitGenerating = false;
            if (state.quickCommitOpen) rerenderQuickCommitModal();
          });
      }

      export function submitQuickCommit(action?: any, includeSubmodule?: any) {
        if (!state.selectedId || state.quickCommitSubmitting) return;
        var msgEl = document.getElementById("quick-commit-message") as HTMLTextAreaElement | null;
        if (msgEl) state.quickCommitForm.customMessage = msgEl.value;
        var tagEl = document.getElementById("quick-commit-tag") as HTMLInputElement | null;
        if (tagEl) state.quickCommitForm.tag = tagEl.value;
        var form = state.quickCommitForm || {};
        var meta = getQuickCommitActionMeta(action || state.quickCommitDragAction || "commit");
        var withTag = meta.withTag;
        var userTag = withTag ? (form.tag || "").trim() : "";
        var message = (form.customMessage || "").trim();
        // Auto-generate flow: empty commit message → ask backend to write one (autoMessage:true).
        // Empty tag (when withTag) → ask backend to derive one (autoTag:true). Both go in one round-trip.
        var autoMessage = !message;
        var before = {
          branch: (state.gitStatus || {}).branch || "",
          commitHash: (state.gitStatus || {}).lastCommit && (state.gitStatus || {}).lastCommit.shortHash
            ? (state.gitStatus || {}).lastCommit.shortHash
            : ((state.gitStatus || {}).head ? (state.gitStatus || {}).head.substring(0, 7) : ""),
          commitSubject: (state.gitStatus || {}).lastCommit && (state.gitStatus || {}).lastCommit.subject
            ? (state.gitStatus || {}).lastCommit.subject
            : "",
          tag: (state.gitStatus || {}).latestTag || "",
        };
        var payload = {
          autoMessage: autoMessage,
          customMessage: autoMessage ? "" : message,
          tag: userTag,
          autoTag: !!(withTag && !userTag),
          push: !!meta.push,
          // 正交 scope flag：是否把 commit/tag/push 递归进入各 submodule 内部。
          submodule: !!includeSubmodule
        };
        state.quickCommitSubmitting = true;
        state.quickCommitSubmoduleIntent = !!includeSubmodule;
        state.quickCommitAutoGenerating = autoMessage || payload.autoTag;
        state.quickCommitError = "";
        state.quickCommitPushError = "";
        state.quickCommitResult = null;
        state.quickCommitDragAction = meta.action;
        rerenderQuickCommitModal();
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/quick-commit", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function(res) {
            return res.json().then(function(data: any) { return { ok: res.ok, data: data }; });
          })
          .then(function(result: any) {
            if (!result.ok) throw new Error((result.data && result.data.error) || "快捷提交失败。");
            var data = result.data || {};
            var hash = data.commit && data.commit.hash ? data.commit.hash.substring(0, 7) : "";
            var tagName = data.tag && data.tag.name ? data.tag.name : "";
            var subCommits = Array.isArray(data.submoduleCommits) ? data.submoduleCommits : [];
            var subPrefix = subCommits.length > 0
              ? "已先提交 " + subCommits.length + " 个 submodule（" + subCommits.map(function(c: any) { return c.path; }).join("、") + "），"
              : "";
            var base = subPrefix + "已提交" + (hash ? " " + hash : "") + (tagName ? "，已打 Tag " + tagName : "");
            state.quickCommitResult = {
              action: meta.action,
              includeSubmodule: !!includeSubmodule,
              pushed: !!data.pushed,
              pushError: data.pushError || "",
              commitHash: hash,
              commitMessage: data.commit && data.commit.message ? data.commit.message : message,
              tagName: tagName,
              oldTag: before.tag,
              oldCommitHash: before.commitHash,
              oldCommitSubject: before.commitSubject,
              submoduleCount: subCommits.length,
            };
            if (meta.push && !data.pushError) {
              if (typeof showToast === "function") showToast(base + "，已推送。", "success");
              closeQuickCommitModal();
            } else {
              if (typeof showToast === "function") {
                showToast(base + (data.pushError ? "；push 失败：" + data.pushError : "。"), data.pushError ? "error" : "success");
              }
              if (state.selectedId) loadGitStatus(state.selectedId, { force: true }).then(function() {
                if (state.quickCommitOpen) rerenderQuickCommitModal();
              });
            }
          })
          .catch(function(error: any) {
            state.quickCommitError = (error && error.message) || "快捷提交失败。";
          })
          .finally(function() {
            state.quickCommitSubmitting = false;
            state.quickCommitAutoGenerating = false;
            if (state.quickCommitOpen) rerenderQuickCommitModal();
          });
      }

      export function submitPushOnly(opts?: any) {
        if (!state.selectedId || state.quickCommitPushing) return;
        var pushCommits = !!(opts && opts.pushCommits);
        var pushTags = !!(opts && opts.pushTags);
        var closeOnSuccess = !!(opts && opts.closeOnSuccess);
        if (!pushCommits && !pushTags) return;
        // 若本次提交曾纳入 submodule，补推时也递归推送各 submodule（commit + 同名 tag）。
        var priorResult = state.quickCommitResult || {};
        var includeSubmodule = !!priorResult.includeSubmodule;
        state.quickCommitPushing = true;
        state.quickCommitPushError = "";
        rerenderQuickCommitModal();
        fetch("/api/sessions/" + encodeURIComponent(state.selectedId) + "/git/push", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pushCommits: pushCommits, pushTags: pushTags, submodule: includeSubmodule, tag: priorResult.tagName || "" })
        })
          .then(function(res) { return res.json().then(function(data: any) { return { ok: res.ok, data: data }; }); })
          .then(function(result: any) {
            var data = result.data || {};
            if (!result.ok) throw new Error((data && data.error) || "推送失败。");
            // Backend marks `ok: false` on partial failure but still returns 200 — surface error toast.
            if (data.error) {
              state.quickCommitPushError = data.error;
              if (typeof showToast === "function") showToast("推送失败：" + data.error, "error");
              return;
            }
            var parts: any[] = [];
            if (data.pushedCommits) parts.push("commits");
            if (data.pushedTags) parts.push("tags");
            var label = parts.length ? parts.join(" 和 ") : "（无内容）";
            if (typeof showToast === "function") showToast("已推送 " + label, "success");
            if (state.quickCommitResult) state.quickCommitResult.pushed = true;
            if (closeOnSuccess) {
              closeQuickCommitModal();
              if (state.selectedId) loadGitStatus(state.selectedId, { force: true });
            } else if (state.selectedId) {
              loadGitStatus(state.selectedId, { force: true }).then(function() {
                if (state.quickCommitOpen) rerenderQuickCommitModal();
              });
            }
          })
          .catch(function(error: any) {
            state.quickCommitPushError = (error && error.message) || "推送失败。";
            if (typeof showToast === "function") showToast(state.quickCommitPushError, "error");
          })
          .finally(function() {
            state.quickCommitPushing = false;
            if (state.quickCommitOpen) rerenderQuickCommitModal();
          });
      }

      // Map a porcelain status (XY two-char, e.g. " M", "A.", "??") to a single
      // VS-Code-style letter badge: pick the first meaningful char, color by kind.
      export function qcStatusBadge(status: any) {
        var raw = (status || "").trim();
        if (raw === "??") return { letter: "U", cls: "untracked", title: "未跟踪" };
        if (raw === "!!") return { letter: "I", cls: "ignored", title: "已忽略" };
        var c = "";
        for (var i = 0; i < status.length; i++) {
          if (status[i] && status[i] !== "." && status[i] !== " ") { c = status[i]; break; }
        }
        c = (c || raw[0] || "?").toUpperCase();
        var map: any = {
          A: { cls: "add", title: "新增" },
          M: { cls: "mod", title: "修改" },
          D: { cls: "del", title: "删除" },
          R: { cls: "ren", title: "重命名" },
          C: { cls: "ren", title: "复制" },
          T: { cls: "mod", title: "类型变更" },
          U: { cls: "del", title: "冲突" }
        };
        var hit = map[c] || { cls: "other", title: "已更改" };
        return { letter: c, cls: hit.cls, title: hit.title };
      }

      export function renderQuickCommitFileRows(files: any) {
        var rows = files.map(function(item: any) {
          var badge = qcStatusBadge(item.status || "");
          var fullPath = item.path || "";
          var slash = fullPath.lastIndexOf("/");
          var dir = slash >= 0 ? fullPath.slice(0, slash + 1) : "";
          var base = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
          var subBadge = "";
          if (item.isSubmodule) {
            var st = item.submoduleState || {};
            var parts: any[] = [];
            if (st.commitChanged) parts.push("新指针");
            if (st.hasTrackedChanges) parts.push("dirty");
            if (st.hasUntracked) parts.push("未跟踪");
            var label = parts.length ? "submodule · " + parts.join(" / ") : "submodule";
            subBadge = '<span class="qc-submodule-badge">' + escapeHtml(label) + '</span>';
          }
          return '<div class="qc-file-row" title="' + escapeHtml(fullPath) + '">' +
            '<span class="qc-file-badge qc-badge-' + badge.cls + '" title="' + escapeHtml(badge.title) + '">' + escapeHtml(badge.letter) + '</span>' +
            '<span class="qc-file-path">' +
              (dir ? '<span class="qc-file-dir">' + escapeHtml(dir) + '</span>' : '') +
              '<span class="qc-file-name">' + escapeHtml(base) + '</span>' +
            '</span>' + subBadge +
          '</div>';
        }).join("");
        return rows || '<div class="qc-empty">没有可提交的改动。</div>';
      }

      export function isQuickCommitOpInFlight() {
        return state.quickCommitSubmitting || state.quickCommitPushing;
      }

      export function renderQuickCommitPair(label: any, fromHtml: any, toHtml: any, extraClass?: any) {
        return '<div class="qc-pair' + (extraClass ? ' ' + extraClass : '') + '">' +
          '<div class="qc-pair-label">' + escapeHtml(label) + '</div>' +
          '<div class="qc-pair-flow">' +
            '<div class="qc-pair-value qc-pair-value--from">' + fromHtml + '</div>' +
            '<div class="qc-pair-arrow" aria-hidden="true">→</div>' +
            '<div class="qc-pair-value qc-pair-value--to">' + toHtml + '</div>' +
          '</div>' +
        '</div>';
      }

      // 仓库是否含 submodule（后端 git-status 返回 hasSubmodule；旧响应缺该字段时回退扫 files）。
      export function quickCommitHasSubmodule() {
        var s = state.gitStatus || {};
        if (s.hasSubmodule === true) return true;
        var files = s.files || [];
        for (var i = 0; i < files.length; i++) {
          if (files[i] && files[i].isSubmodule === true) return true;
        }
        return false;
      }

      export function renderQuickCommitDragControl(hasChanges: any) {
        var disabled = !hasChanges || isQuickCommitOpInFlight();
        var hasSubmodule = quickCommitHasSubmodule();
        // Busy panel — replaces the dock entirely while the request is in flight.
        if (state.quickCommitSubmitting) {
          var subBusy = state.quickCommitSubmoduleIntent ? "（含 submodule）" : "";
          var busyLabel = (state.quickCommitAutoGenerating ? "AI 生成 + 提交中…" : "执行中…") + subBusy;
          return '<div class="qc-dock-wrap">' +
            '<div class="qc-dock-busy" role="status"><span class="qc-dock-busy-dot"></span>' + escapeHtml(busyLabel) + '</div>' +
          '</div>';
        }
        function chip(id: any, label: any, title?: any) {
          return '<button type="button" class="qc-chip qc-chip--' + id + '"' +
            ' data-chip="' + id + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + (disabled ? ' disabled' : '') + '>' +
            '<span class="qc-chip-dot" aria-hidden="true"></span>' +
            '<span class="qc-chip-label">' + label + '</span>' +
          '</button>';
        }
        var hint = disabled
          ? (!hasChanges ? "工作区干净，无可提交" : "")
          : ("拖动磁吸组合 · 丢进提交区执行 · 单击直接执行该项" + (hasSubmodule ? " · Sub 球可选，纳入后递归处理 submodule" : ""));
        return '<div class="qc-dock-wrap qc-dock-wrap--magnetic"' + (disabled ? ' data-disabled="1"' : '') + '>' +
          '<div id="qc-dock-stage" class="qc-dock-stage" data-action="commit" data-hot="0">' +
            '<div id="qc-dock-field" class="qc-dock-field">' +
              '<div id="qc-dock-cluster" class="qc-dock-cluster" aria-hidden="true"></div>' +
              chip("commit", "Commit") +
              chip("tag", "Tag") +
              chip("push", "Push") +
              (hasSubmodule ? chip("sub", "Sub", "提交父仓库并递归进入 submodule（commit / tag / 分别推送）") : "") +
            '</div>' +
            '<button type="button" id="qc-dock-launch" class="qc-dock-launch"' + (disabled ? ' disabled' : '') + ' aria-label="执行提交">' +
              '<span class="qc-dock-launch-arrow" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h12M13 6l6 6-6 6"/></svg>' +
              '</span>' +
              '<span id="qc-dock-launch-label" class="qc-dock-launch-label">提交</span>' +
            '</button>' +
          '</div>' +
          '<div class="qc-dock-hint">' + escapeHtml(hint) + '</div>' +
        '</div>';
      }

      export function renderQuickCommitResultPanel() {
        var r = state.quickCommitResult;
        if (!r) return "";
        var oldCommit = r.oldCommitHash
          ? '<code>' + escapeHtml(r.oldCommitHash) + '</code>' + (r.oldCommitSubject ? '<span>' + escapeHtml(r.oldCommitSubject) + '</span>' : '')
          : '<span class="qc-muted">无</span>';
        var newCommit = r.commitHash
          ? '<code>' + escapeHtml(r.commitHash) + '</code><span>' + escapeHtml(r.commitMessage || "") + '</span>'
          : '<span class="qc-muted">无</span>';
        var oldTag = r.oldTag ? '<code>' + escapeHtml(r.oldTag) + '</code>' : '<span class="qc-muted">无 tag</span>';
        var newTag = r.tagName ? '<code>' + escapeHtml(r.tagName) + '</code>' : '<span class="qc-muted">未打 tag</span>';
        var pushButton = r.pushed
          ? '<span class="qc-result-pushed">已推送</span>'
          : '<button id="quick-commit-push-after-btn" class="btn btn-primary btn-sm" type="button"' + (state.quickCommitPushing ? ' disabled' : '') + '>' + (state.quickCommitPushing ? '推送中...' : 'Push & Close') + '</button>';
        return '<section class="qc-result-panel">' +
          renderQuickCommitPair("Commit", oldCommit, newCommit, "") +
          renderQuickCommitPair("Tag", oldTag, newTag, "qc-pair--tag") +
          (r.pushError || state.quickCommitPushError ? '<p class="error-message">' + escapeHtml(r.pushError || state.quickCommitPushError) + '</p>' : '') +
          '<div class="qc-result-actions">' +
            '<button id="quick-commit-cancel-btn" class="btn btn-ghost btn-sm" type="button">关闭</button>' +
            pushButton +
          '</div>' +
        '</section>';
      }

      export function renderQuickCommitModal() {
        var s = state.gitStatus || {};
        var f = state.quickCommitForm || { customMessage: "", tag: "", tagEdited: false };
        var hasChanges = (s.modifiedCount || 0) > 0;
        var genBusy = state.quickCommitGenerating;
        var lc = s.lastCommit || {};
        var oldCommitHtml = lc.shortHash
          ? '<code>' + escapeHtml(lc.shortHash) + '</code><span>' + escapeHtml(lc.subject || "") + '</span>'
          : (s.head ? '<code>' + escapeHtml(s.head.substring(0, 7)) + '</code>' : '<span class="qc-muted">无 commit</span>');
        var oldTagHtml = s.latestTag ? '<code>' + escapeHtml(s.latestTag) + '</code>' : '<span class="qc-muted">无 tag</span>';
        var newTagHtml = '<input type="text" id="quick-commit-tag" class="field-input qc-tag-field-input" placeholder="留空则 AI 生成" value="' + escapeHtml(f.tag || "") + '"' + (state.quickCommitSubmitting ? ' disabled' : '') + '>';
        var nextCommitHtml = '<textarea id="quick-commit-message" class="field-input qc-message-input" rows="3" placeholder="New commit message" ' + (state.quickCommitSubmitting ? 'disabled' : '') + '>' + escapeHtml(f.customMessage || "") + '</textarea>';
        var subtitleParts: any[] = [];
        subtitleParts.push(s.branch || "(no branch)");
        subtitleParts.push(hasChanges ? ((s.modifiedCount || 0) + " 个改动") : "工作区干净");
        if (typeof s.ahead === "number" && s.ahead > 0) subtitleParts.push("↑" + s.ahead);
        if (typeof s.behind === "number" && s.behind > 0) subtitleParts.push("↓" + s.behind);
        var formPanel = state.quickCommitResult ? "" : '<section class="qc-release-panel">' +
          '<div class="qc-message-header">' +
            '<span class="qc-section-title">New</span>' +
            '<button type="button" id="quick-commit-ai-btn" class="btn btn-ghost btn-sm qc-ai-btn"' + (genBusy ? ' disabled' : '') + ' title="AI 生成 commit message 与 tag">' +
              '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5l1.4 3.6L13 6.5 9.4 7.9 8 11.5 6.6 7.9 3 6.5l3.6-1.4L8 1.5zM12.5 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" fill="currentColor"/></svg>' +
              '<span>' + (genBusy ? '生成中...' : 'AI') + '</span>' +
            '</button>' +
          '</div>' +
          renderQuickCommitPair("Commit", oldCommitHtml, nextCommitHtml, "qc-pair--commit") +
          renderQuickCommitPair("Tag", oldTagHtml, newTagHtml, "qc-pair--tag") +
          (state.quickCommitError ? '<p class="error-message">' + escapeHtml(state.quickCommitError) + '</p>' : '') +
          renderQuickCommitDragControl(hasChanges) +
          '<div class="qc-modal-actions"><button id="quick-commit-cancel-btn" class="btn btn-ghost btn-sm" type="button">取消</button></div>' +
        '</section>';
        var resultPanel = renderQuickCommitResultPanel();
        return '<section id="quick-commit-modal" class="modal-backdrop' + (state.quickCommitOpen ? '' : ' hidden') + '">' +
          '<div class="modal quick-commit-modal" role="dialog" aria-labelledby="quick-commit-title">' +
            '<div class="modal-header">' +
              '<div>' +
                '<h2 id="quick-commit-title" class="modal-title">快捷提交</h2>' +
                '<p class="modal-subtitle">' + escapeHtml(subtitleParts.join(" · ")) + '</p>' +
              '</div>' +
              '<button id="quick-commit-close-btn" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body">' +
              formPanel +
              resultPanel +
            '</div>' +
          '</div>' +
        '</section>';
      }

      export function renderWorktreeMergeModal() {
        return '<section id="worktree-merge-modal" class="modal-backdrop hidden">' +
          '<div class="modal worktree-merge-modal">' +
            '<div class="modal-header">' +
              '<div>' +
                '<h2 class="modal-title">合并 Worktree</h2>' +
                '<p class="modal-subtitle">检查当前任务分支并快捷合并到主分支。</p>' +
              '</div>' +
              '<button id="close-worktree-merge-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div id="worktree-merge-content" class="worktree-merge-content"></div>' +
              '<p id="worktree-merge-error" class="error-message hidden"></p>' +
              '<div class="worktree-merge-actions">' +
                '<button id="worktree-merge-cancel-button" class="btn btn-secondary">取消</button>' +
                '<button id="worktree-merge-confirm-button" class="btn btn-primary">确认合并并清理</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      export function renderSettingsModal() {
        return '<section id="settings-modal" class="modal-backdrop hidden">' +
          '<div class="modal settings-modal">' +
            '<div class="modal-header settings-modal-header">' +
              '<div class="settings-modal-title-group">' +
                '<h2 class="modal-title">设置</h2>' +
                '<p class="settings-modal-subtitle">调整应用配置、通知、安全和显示偏好</p>' +
              '</div>' +
              '<button id="close-settings-button" class="btn btn-ghost btn-icon modal-close-btn" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body settings-modal-body">' +
              '<div class="settings-layout">' +
                '<aside class="settings-sidebar">' +
                  '<div class="settings-sidebar-header">' +
                    '<div class="settings-sidebar-title">偏好设置</div>' +
                    '<div class="settings-sidebar-hint">左侧切换分区，右侧查看详细说明与选项。</div>' +
                  '</div>' +
                  '<div class="settings-tabs" role="tablist" aria-label="设置分组" aria-orientation="vertical">' +
                    '<button class="settings-tab active" data-tab="about" role="tab" aria-selected="true" aria-controls="settings-tab-about">' +
                      '<span class="settings-tab-main">关于</span>' +
                      '<span class="settings-tab-meta">版本、更新与连接方式</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="general" role="tab" aria-selected="false" aria-controls="settings-tab-general">' +
                      '<span class="settings-tab-main">基本配置</span>' +
                      '<span class="settings-tab-meta">连接、模式与运行环境</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="ai" role="tab" aria-selected="false" aria-controls="settings-tab-ai">' +
                      '<span class="settings-tab-main">AI 与模型</span>' +
                      '<span class="settings-tab-meta">默认模型、系统 API 与 Commit</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="notifications" role="tab" aria-selected="false" aria-controls="settings-tab-notifications">' +
                      '<span class="settings-tab-main">通知</span>' +
                      '<span class="settings-tab-meta">提示音与浏览器通知</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="security" role="tab" aria-selected="false" aria-controls="settings-tab-security">' +
                      '<span class="settings-tab-main">安全</span>' +
                      '<span class="settings-tab-meta">密码与证书</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="presets" role="tab" aria-selected="false" aria-controls="settings-tab-presets">' +
                      '<span class="settings-tab-main">命令预设</span>' +
                      '<span class="settings-tab-meta">查看已有预设</span>' +
                    '</button>' +
                    '<button class="settings-tab" data-tab="display" role="tab" aria-selected="false" aria-controls="settings-tab-display">' +
                      '<span class="settings-tab-main">显示</span>' +
                      '<span class="settings-tab-meta">卡片默认展开行为</span>' +
                    '</button>' +
                  '</div>' +
                '</aside>' +
                '<div class="settings-content">' +

              // About tab
              '<div class="settings-panel active" id="settings-tab-about" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">关于 Wand</h3>' +
                  '<p class="settings-panel-desc">查看版本信息、更新状态和 Android App 连接方式。</p>' +
                '</div>' +
                '<p id="settings-about-access-note" class="hint hidden">当前是 App 连接会话，仅展示版本与客户端下载信息。更新管理和连接码仅对管理员开放。</p>' +
                '<div class="settings-about-info">' +
                  '<div class="settings-about-row"><span class="settings-label">包名</span><span class="settings-value" id="settings-pkg-name">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">当前版本</span><span class="settings-value" id="settings-version">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">Node.js 要求</span><span class="settings-value" id="settings-node-req">-</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">仓库地址</span><span class="settings-value" id="settings-repo-url"><a href="#" target="_blank" rel="noopener">-</a></span></div>' +
                '</div>' +
                '<div class="settings-update-section" id="web-update-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("globe", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">Web 端</h4>' +
                      '<p class="settings-section-sub">浏览器访问的服务版本</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-about-row">' +
                    '<span class="settings-label">最新版本</span>' +
                    '<span class="settings-value" id="settings-latest-version">-</span>' +
                  '</div>' +
                  '<div class="settings-update-actions">' +
                    '<button type="button" id="check-update-button" class="btn btn-secondary btn-sm">检查更新</button>' +
                    '<button type="button" id="do-update-button" class="btn btn-primary btn-sm hidden">更新到最新版</button>' +
                    '<button type="button" id="do-restart-button" class="btn btn-success btn-sm hidden">重启生效</button>' +
                  '</div>' +
                  '<p id="update-message" class="hint hidden"></p>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<span class="settings-toggle-title">Beta 通道</span>' +
                      '<span class="settings-toggle-desc">更新到 npm beta 版本（tag + commit 尾标），尝鲜新功能，可能不稳定。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input type="checkbox" id="beta-channel-toggle" class="switch-toggle">' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<span class="settings-toggle-title">自动更新</span>' +
                      '<span class="settings-toggle-desc">检测到新版本将自动下载安装并重启服务。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input type="checkbox" id="auto-update-web-toggle" class="switch-toggle">' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div class="settings-update-section" id="provider-cli-update-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("terminal", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">开发 CLI</h4>' +
                      '<p class="settings-section-sub">Claude Code、Codex 与 OpenCode 的服务端版本</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-about-row"><span class="settings-label">Claude Code</span><span class="settings-value" id="provider-cli-status-claude">检测中…</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">Codex</span><span class="settings-value" id="provider-cli-status-codex">检测中…</span></div>' +
                  '<div class="settings-about-row"><span class="settings-label">OpenCode</span><span class="settings-value" id="provider-cli-status-opencode">检测中…</span></div>' +
                  '<div class="settings-update-actions">' +
                    '<button type="button" id="check-provider-cli-updates" class="btn btn-secondary btn-sm">检查更新</button>' +
                    '<button type="button" id="update-provider-clis" class="btn btn-primary btn-sm hidden">快速更新</button>' +
                  '</div>' +
                  '<p id="provider-cli-update-message" class="hint hidden"></p>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<span class="settings-toggle-title">自动更新 CLI</span>' +
                      '<span class="settings-toggle-desc">服务端每 30 分钟检查一次，并调用各 CLI 官方 updater 更新到最新版。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input type="checkbox" id="auto-update-cli-toggle" class="switch-toggle">' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div class="settings-update-section hidden" id="android-apk-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("smartphone", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">Android App</h4>' +
                      '<p class="settings-section-sub">原生客户端版本与 APK 下载</p>' +
                    '</div>' +
                  '</div>' +
                  '<div id="android-apk-current-row" class="settings-about-row hidden">' +
                    '<span class="settings-label">当前版本</span>' +
                    '<span class="settings-value" id="settings-android-apk-current">-</span>' +
                  '</div>' +
                  '<div id="android-apk-github-row" class="settings-about-row settings-about-row-action hidden">' +
                    '<span class="settings-label">线上版本</span>' +
                    '<span class="settings-value settings-value-flex" id="settings-android-apk-github">-</span>' +
                    '<button id="download-github-apk-btn" class="btn btn-secondary btn-sm hidden" type="button">下载</button>' +
                  '</div>' +
                  '<div id="android-apk-local-row" class="settings-about-row settings-about-row-action hidden">' +
                    '<span class="settings-label">本地版本</span>' +
                    '<span class="settings-value settings-value-flex" id="settings-android-apk-local">-</span>' +
                    '<button id="download-local-apk-btn" class="btn btn-secondary btn-sm hidden" type="button">下载</button>' +
                  '</div>' +
                  '<div id="android-auto-update-row" class="settings-toggle-row hidden">' +
                    '<div class="settings-toggle-text">' +
                      '<span class="settings-toggle-title">自动更新</span>' +
                      '<span class="settings-toggle-desc" id="android-auto-update-hint">检测到新版 APK 时自动拉起下载，安装仍需在系统中确认。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input type="checkbox" id="auto-update-apk-toggle" class="switch-toggle">' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                  '<p id="android-apk-message" class="hint hidden"></p>' +
                '</div>' +
                '<div class="settings-update-section hidden" id="macos-dmg-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("desktop", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">macOS App</h4>' +
                      '<p class="settings-section-sub">原生客户端版本与 DMG 下载</p>' +
                    '</div>' +
                  '</div>' +
                  '<div id="macos-dmg-current-row" class="settings-about-row hidden">' +
                    '<span class="settings-label">当前版本</span>' +
                    '<span class="settings-value" id="settings-macos-dmg-current">-</span>' +
                  '</div>' +
                  '<div id="macos-dmg-github-row" class="settings-about-row settings-about-row-action hidden">' +
                    '<span class="settings-label">线上版本</span>' +
                    '<span class="settings-value settings-value-flex" id="settings-macos-dmg-github">-</span>' +
                    '<button id="download-github-dmg-btn" class="btn btn-secondary btn-sm hidden" type="button">下载</button>' +
                  '</div>' +
                  '<div id="macos-dmg-local-row" class="settings-about-row settings-about-row-action hidden">' +
                    '<span class="settings-label">本地版本</span>' +
                    '<span class="settings-value settings-value-flex" id="settings-macos-dmg-local">-</span>' +
                    '<button id="download-local-dmg-btn" class="btn btn-secondary btn-sm hidden" type="button">下载</button>' +
                  '</div>' +
                  '<div id="macos-auto-update-row" class="settings-toggle-row hidden">' +
                    '<div class="settings-toggle-text">' +
                      '<span class="settings-toggle-title">自动更新</span>' +
                      '<span class="settings-toggle-desc" id="macos-auto-update-hint">检测到新版 DMG 将自动下载并挂载。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input type="checkbox" id="auto-update-dmg-toggle" class="switch-toggle">' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                  '<p id="macos-dmg-message" class="hint hidden"></p>' +
                '</div>' +
                '<div class="settings-update-section" id="android-connect-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("link", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">App 连接码</h4>' +
                      '<p class="settings-section-sub">粘贴到 Android App 即可自动连接，无需密码；改密码后失效。</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-connect-url-box">' +
                    '<code id="android-connect-code" class="settings-connect-url-text">-</code>' +
                    '<button id="copy-connect-code-button" class="btn btn-secondary btn-sm" type="button" title="复制连接码">复制</button>' +
                  '</div>' +
                  '<div class="settings-connect-qr-box">' +
                    '<div class="settings-connect-qr-wrap" id="android-connect-qr-wrap" title="点击放大">' +
                      '<canvas id="android-connect-qr" width="180" height="180"></canvas>' +
                      '<div class="settings-connect-qr-empty" id="android-connect-qr-empty">生成中…</div>' +
                    '</div>' +
                    '<p class="settings-connect-qr-hint">用 Wand App 扫一扫，即可一键填入服务器地址与连接码。</p>' +
                  '</div>' +
                '</div>' +
              '</div>' +

              // Notifications tab
              '<div class="settings-panel" id="settings-tab-notifications" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">通知</h3>' +
                  '<p class="settings-panel-desc">设置提示音、系统通知和浏览器通知的行为。</p>' +
                '</div>' +
                '<div class="settings-notification-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("bell", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">通知偏好</h4>' +
                      '<p class="settings-section-sub">提示音与应用内通知气泡</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<label class="settings-toggle-title" for="cfg-notif-sound">播放提示音</label>' +
                      '<span class="settings-toggle-desc">重要通知（版本更新、权限等待等）时播放柔和提示音。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input id="cfg-notif-sound" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                  '<div class="settings-range-row" id="notif-volume-field">' +
                    '<label class="settings-range-label" for="cfg-notif-volume">音量</label>' +
                    '<input id="cfg-notif-volume" type="range" min="0" max="100" step="5" class="settings-range" />' +
                    '<span id="cfg-notif-volume-val" class="settings-range-value">80%</span>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<label class="settings-toggle-title" for="cfg-notif-bubble">应用内通知气泡</label>' +
                      '<span class="settings-toggle-desc">在页面顶部弹出浮动通知气泡。</span>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input id="cfg-notif-bubble" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div id="native-sound-section" class="settings-notification-section hidden">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("music", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">系统通知铃声</h4>' +
                      '<p class="settings-section-sub">选择 Android 系统通知使用的铃声</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-row-with-action">' +
                    '<select id="native-sound-select" class="field-input field-select"></select>' +
                    '<button id="native-sound-preview" class="btn btn-secondary btn-sm btn-with-icon" type="button">' + iconSvg("play", { size: 11, strokeWidth: 1.8, fill: "currentColor" }) + '<span>试听</span></button>' +
                  '</div>' +
                '</div>' +
                '<div id="native-haptic-section" class="settings-notification-section hidden">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("vibrate", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">触感反馈</h4>' +
                      '<p class="settings-section-sub">按钮操作和任务完成时提供振动反馈</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text">' +
                      '<label class="settings-toggle-title" for="cfg-haptic-enabled">启用触感反馈</label>' +
                    '</div>' +
                    '<label class="settings-switch">' +
                      '<input id="cfg-haptic-enabled" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<div class="settings-notification-section">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("globe", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">浏览器通知</h4>' +
                      '<p class="settings-section-sub">来自系统通知中心的弹窗</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-about-row">' +
                    '<span class="settings-label">授权状态</span>' +
                    '<span class="settings-value" id="notification-permission-status">-</span>' +
                  '</div>' +
                  '<div class="settings-update-actions">' +
                    '<button id="notification-request-btn" class="btn btn-primary btn-sm hidden" type="button">授权通知</button>' +
                    '<button id="notification-reset-btn" class="btn btn-ghost btn-sm hidden" type="button">重新授权</button>' +
                    '<button id="notification-test-btn" class="btn btn-secondary btn-sm" type="button">发送测试通知</button>' +
                    '<button id="notification-test-delay-btn" class="btn btn-ghost btn-sm" type="button">10 秒后发送</button>' +
                  '</div>' +
                  '<p id="notification-test-message" class="hint hidden"></p>' +
                '</div>' +
              '</div>' +

              // General config tab
              '<div class="settings-panel" id="settings-tab-general" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">基本配置</h3>' +
                  '<p class="settings-panel-desc">配置服务连接、执行方式和工作目录。</p>' +
                '</div>' +
                '<div class="field-row">' +
                  '<div class="field">' +
                    '<label class="field-label" for="cfg-host">监听地址 (host)</label>' +
                    '<input id="cfg-host" type="text" class="field-input" placeholder="127.0.0.1" />' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="cfg-port">端口 (port)</label>' +
                    '<input id="cfg-port" type="number" class="field-input" placeholder="8443" min="1" max="65535" />' +
                  '</div>' +
                '</div>' +
                '<div class="settings-toggle-row">' +
                  '<div class="settings-toggle-text">' +
                    '<label class="settings-toggle-title" for="cfg-https">启用 HTTPS</label>' +
                    '<span class="settings-toggle-desc">使用自签名证书加密浏览器到服务的连接，host 为非 127.0.0.1 时建议开启。</span>' +
                  '</div>' +
                  '<label class="settings-switch">' +
                    '<input id="cfg-https" type="checkbox" class="switch-toggle" />' +
                    '<span class="switch-slider"></span>' +
                  '</label>' +
                '</div>' +
                '<div class="field-row">' +
                  '<div class="field">' +
                    '<label class="field-label" for="cfg-mode">默认执行模式</label>' +
                    '<select id="cfg-mode" class="field-input">' +
                      '<option value="default">default</option>' +
                      '<option value="assist">assist</option>' +
                      '<option value="agent">agent</option>' +
                      '<option value="agent-max">agent-max</option>' +
                      '<option value="auto-edit">auto-edit</option>' +
                      '<option value="full-access">full-access</option>' +
                      '<option value="native">native</option>' +
                      '<option value="managed">managed</option>' +
                    '</select>' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="cfg-language">回复语言</label>' +
                    '<select id="cfg-language" class="field-input">' +
                      '<option value="">自动（不指定）</option>' +
                      '<option value="中文">中文</option>' +
                      '<option value="English">English</option>' +
                      '<option value="日本語">日本語</option>' +
                      '<option value="한국어">한국어</option>' +
                      '<option value="Español">Español</option>' +
                      '<option value="Français">Français</option>' +
                      '<option value="Deutsch">Deutsch</option>' +
                      '<option value="Русский">Русский</option>' +
                    '</select>' +
                  '</div>' +
                '</div>' +
                '<p class="field-hint" style="margin-top:-4px;">设置回复语言后，Claude 将尽量使用指定语言回复。</p>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-structured-runner">结构化会话 Runner</label>' +
                  '<select id="cfg-structured-runner" class="field-input">' +
                    '<option value="sdk">SDK（@anthropic-ai/claude-agent-sdk，默认）</option>' +
                    '<option value="cli">CLI（spawn claude -p）</option>' +
                  '</select>' +
                  '<p class="field-hint" style="margin-top:4px;">SDK 模式使用官方 Agent SDK 替代 CLI subprocess，接口更整洁，功能等价。保存后对新建会话立即生效。</p>' +
                '</div>' +
                '<div class="settings-toggle-row">' +
                  '<div class="settings-toggle-text">' +
                    '<label class="settings-toggle-title" for="cfg-inherit-env">继承环境变量</label>' +
                    '<span class="settings-toggle-desc">启动 PTY / 结构化子进程时，把当前服务进程的环境变量传给 claude / codex / opencode。关闭后子进程仅获得最小可用环境（PATH/HOME/SHELL/LANG/TERM 等），可用于隔离 API key 等敏感凭据。</span>' +
                  '</div>' +
                  '<div class="settings-toggle-aside">' +
                    '<button type="button" id="cfg-view-env-btn" class="btn btn-secondary btn-sm" title="查看实际会注入到子进程的环境变量">查看</button>' +
                    '<label class="settings-switch">' +
                      '<input id="cfg-inherit-env" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</label>' +
                  '</div>' +
                '</div>' +
                '<section class="settings-model-card" aria-labelledby="settings-model-card-title">' +
                  '<div class="settings-model-card-header">' +
                    '<div class="settings-model-card-heading">' +
                      '<span class="settings-model-card-icon" aria-hidden="true">' + iconSvg("cpu", { size: 18, strokeWidth: 1.8 }) + '</span>' +
                      '<div>' +
                        '<h4 class="settings-model-card-title" id="settings-model-card-title">默认模型</h4>' +
                        '<p class="settings-model-card-desc">从已检测列表中选择，或直接输入自定义模型名称 / ID。</p>' +
                      '</div>' +
                    '</div>' +
                    '<button type="button" id="cfg-default-model-refresh" class="btn btn-secondary btn-sm settings-model-refresh" title="重新检测 Claude、Codex 与 OpenCode 模型">' +
                      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>' +
                      '<span>刷新列表</span>' +
                    '</button>' +
                  '</div>' +
                  '<div class="settings-model-grid">' +
                    '<div class="field settings-model-field">' +
                      '<div class="settings-model-label-row">' +
                        '<label class="field-label" for="cfg-default-model">Claude</label>' +
                        '<span class="settings-model-provider">Claude Code</span>' +
                      '</div>' +
                      '<div class="model-combobox" data-provider="claude">' +
                        '<div class="model-combobox-control">' +
                          '<input id="cfg-default-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-default-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="跟随 Claude Code 默认" />' +
                          '<button type="button" class="model-combobox-toggle" aria-label="展开 Claude 模型列表">' +
                            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>' +
                          '</button>' +
                        '</div>' +
                        '<div id="cfg-default-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="Claude 模型"></div>' +
                      '</div>' +
                      '<div class="settings-model-meta">' +
                        '<span class="settings-model-status" data-model-status="claude">跟随 CLI 默认</span>' +
                        '<span class="settings-model-help">会原样传给 <code>--model</code></span>' +
                      '</div>' +
                    '</div>' +
                    '<div class="field settings-model-field">' +
                      '<div class="settings-model-label-row">' +
                        '<label class="field-label" for="cfg-default-codex-model">Codex</label>' +
                        '<span class="settings-model-provider">Codex CLI</span>' +
                      '</div>' +
                      '<div class="model-combobox" data-provider="codex">' +
                        '<div class="model-combobox-control">' +
                          '<input id="cfg-default-codex-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-default-codex-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="跟随 Codex 默认" />' +
                          '<button type="button" class="model-combobox-toggle" aria-label="展开 Codex 模型列表">' +
                            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>' +
                          '</button>' +
                        '</div>' +
                        '<div id="cfg-default-codex-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="Codex 模型"></div>' +
                      '</div>' +
                      '<div class="settings-model-meta">' +
                        '<span class="settings-model-status" data-model-status="codex">跟随 CLI 默认</span>' +
                        '<span class="settings-model-help">留空则不传模型参数</span>' +
                      '</div>' +
                    '</div>' +
                    '<div class="field settings-model-field">' +
                      '<div class="settings-model-label-row">' +
                        '<label class="field-label" for="cfg-default-opencode-model">OpenCode</label>' +
                        '<span class="settings-model-provider">OpenCode CLI</span>' +
                      '</div>' +
                      '<div class="model-combobox" data-provider="opencode">' +
                        '<div class="model-combobox-control">' +
                          '<input id="cfg-default-opencode-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-default-opencode-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="跟随 OpenCode 默认" />' +
                          '<button type="button" class="model-combobox-toggle" aria-label="展开 OpenCode 模型列表">' +
                            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>' +
                          '</button>' +
                        '</div>' +
                        '<div id="cfg-default-opencode-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="OpenCode 模型"></div>' +
                      '</div>' +
                      '<div class="settings-model-meta">' +
                        '<span class="settings-model-status" data-model-status="opencode">跟随 CLI 默认</span>' +
                        '<span class="settings-model-help">格式为 provider/model</span>' +
                      '</div>' +
                    '</div>' +
                  '</div>' +
                  '<p class="field-hint settings-model-version" id="cfg-default-model-version">模型名称仅在新建会话时作为默认值；运行中的结构化会话仍可单独切换。</p>' +
                '</section>' +
                '<section class="settings-model-card" aria-labelledby="settings-system-ai-card-title">' +
                  '<div class="settings-model-card-header">' +
                    '<div class="settings-model-card-heading">' +
                      '<span class="settings-model-card-icon" aria-hidden="true">' + iconSvg("cpu", { size: 18, strokeWidth: 1.8 }) + '</span>' +
                      '<div>' +
                        '<h4 class="settings-model-card-title" id="settings-system-ai-card-title">系统 AI API</h4>' +
                        '<p class="settings-model-card-desc">直连自定义模型，用于快捷提交、提示词优化和会话标题。</p>' +
                      '</div>' +
                    '</div>' +
                    '<button type="button" id="cfg-system-ai-import" class="btn btn-secondary btn-sm settings-model-refresh" title="从 CLI 复制并保存 API 配置，不改变启用状态和 Commit 来源">' +
                      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>' +
                      '<span>从 CLI 导入</span>' +
                    '</button>' +
                  '</div>' +
                  '<div class="settings-toggle-row">' +
                    '<div class="settings-toggle-text"><label class="settings-toggle-title" for="cfg-system-ai-enabled">用于系统 AI 功能</label><span class="settings-toggle-desc" id="cfg-system-ai-status">控制提示词优化和会话标题；Commit 来源在下方单独选择。</span></div>' +
                    '<label class="settings-switch"><input id="cfg-system-ai-enabled" type="checkbox" class="switch-toggle" /><span class="switch-slider"></span></label>' +
                  '</div>' +
                  '<div class="settings-model-grid">' +
                    '<div class="field settings-model-field"><label class="field-label" for="cfg-system-ai-protocol">接口格式</label><select id="cfg-system-ai-protocol" class="field-input"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></div>' +
                    '<div class="field settings-model-field"><label class="field-label" for="cfg-system-ai-auth-header">认证方式</label><select id="cfg-system-ai-auth-header" class="field-input"><option value="bearer">Bearer Token</option><option value="x-api-key">x-api-key</option></select></div>' +
                    '<div class="field settings-model-field"><label class="field-label" for="cfg-system-ai-model">模型</label><input id="cfg-system-ai-model" class="field-input" type="text" autocomplete="off" placeholder="例如 gpt-5.5 / glm-5.2" aria-describedby="ai-config-message" /></div>' +
                    '<div class="field settings-model-field"><label class="field-label" for="cfg-system-ai-base-url">API 地址</label><input id="cfg-system-ai-base-url" class="field-input" type="url" autocomplete="off" placeholder="https://api.example.com" aria-describedby="ai-config-message" /></div>' +
                    '<div class="field settings-model-field"><label class="field-label" for="cfg-system-ai-key">API Key</label><input id="cfg-system-ai-key" class="field-input" type="password" autocomplete="new-password" placeholder="留空则保留已保存的密钥" aria-describedby="ai-config-message" /></div>' +
                  '</div>' +
                  '<p class="field-hint">API Key 仅保存在服务端 SQLite 中，设置接口不会回传明文。</p>' +
                '</section>' +
                '<section class="settings-model-card" aria-labelledby="settings-commit-model-card-title">' +
                  '<div class="settings-model-card-header">' +
                    '<div class="settings-model-card-heading">' +
                      '<span class="settings-model-card-icon" aria-hidden="true">' + iconSvg("edit", { size: 18, strokeWidth: 1.8 }) + '</span>' +
                      '<div>' +
                        '<h4 class="settings-model-card-title" id="settings-commit-model-card-title">Commit 生成</h4>' +
                        '<p class="settings-model-card-desc">明确选择快捷提交生成 message 与 tag 时使用的 AI 来源。</p>' +
                      '</div>' +
                    '</div>' +
                    '<button type="button" id="cfg-commit-model-refresh" class="btn btn-secondary btn-sm settings-model-refresh" title="重新检测所选 CLI 的模型">' +
                      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>' +
                      '<span>刷新列表</span>' +
                    '</button>' +
                  '</div>' +
                  '<fieldset class="settings-source-picker">' +
                    '<legend class="field-label">生成方式</legend>' +
                    '<div class="settings-source-options">' +
                      '<label class="settings-source-option" id="cfg-commit-source-cli-option" for="cfg-commit-source-cli">' +
                        '<input id="cfg-commit-source-cli" name="commit-ai-source" type="radio" value="cli" checked />' +
                        '<span class="settings-source-option-copy"><strong>CLI</strong><span>使用本机 Claude、Codex 或 OpenCode</span></span>' +
                      '</label>' +
                      '<label class="settings-source-option" id="cfg-commit-source-api-option" for="cfg-commit-source-api">' +
                        '<input id="cfg-commit-source-api" name="commit-ai-source" type="radio" value="api" />' +
                        '<span class="settings-source-option-copy"><strong>直连 API</strong><span>使用上方保存的 API 与模型</span></span>' +
                      '</label>' +
                    '</div>' +
                  '</fieldset>' +
                  '<div id="cfg-commit-api-panel" class="settings-source-panel" hidden>' +
                    '<div id="cfg-commit-api-status" class="settings-connection-status" role="status" aria-live="polite">检查 API 配置中…</div>' +
                    '<button type="button" id="cfg-commit-api-configure" class="btn btn-secondary btn-sm">配置直连 API</button>' +
                  '</div>' +
                  '<div id="cfg-commit-cli-panel" class="settings-model-grid">' +
                    '<div class="field settings-model-field">' +
                      '<div class="settings-model-label-row">' +
                        '<label class="field-label" for="cfg-commit-cli">CLI</label>' +
                        '<span class="settings-model-provider">快捷提交</span>' +
                      '</div>' +
                      '<select id="cfg-commit-cli" class="field-input">' +
                        '<option value="claude">Claude</option>' +
                        '<option value="codex">Codex</option>' +
                        '<option value="opencode">OpenCode</option>' +
                      '</select>' +
                      '<div class="settings-model-meta">' +
                        '<span class="settings-model-status">生成 commit message 与 tag</span>' +
                      '</div>' +
                    '</div>' +
                    '<div class="field settings-model-field">' +
                      '<div class="settings-model-label-row">' +
                        '<label class="field-label" for="cfg-commit-model">模型</label>' +
                        '<span class="settings-model-provider" id="cfg-commit-model-provider">Claude Code</span>' +
                      '</div>' +
                      '<div id="cfg-commit-model-combobox" class="model-combobox" data-provider="claude">' +
                        '<div class="model-combobox-control">' +
                          '<input id="cfg-commit-model" class="field-input model-combobox-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cfg-commit-model-listbox" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="跟随 Claude Code 默认" />' +
                          '<button type="button" class="model-combobox-toggle" aria-label="展开 commit 模型列表">' +
                            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>' +
                          '</button>' +
                        '</div>' +
                        '<div id="cfg-commit-model-listbox" class="model-combobox-menu hidden" role="listbox" aria-label="Commit 模型"></div>' +
                      '</div>' +
                      '<div class="settings-model-meta">' +
                        '<span class="settings-model-status" data-model-status>跟随 CLI 默认</span>' +
                        '<span class="settings-model-help">列表来自自动检测</span>' +
                      '</div>' +
                    '</div>' +
                  '</div>' +
                '</section>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-cwd">默认工作目录</label>' +
                  '<input id="cfg-cwd" type="text" class="field-input" placeholder="/home/user" />' +
                '</div>' +
                '<div class="field">' +
                  '<label class="field-label" for="cfg-shell">Shell</label>' +
                  '<input id="cfg-shell" type="text" class="field-input" placeholder="/bin/bash" />' +
                '</div>' +
                (typeof WandNative !== "undefined" && typeof WandNative.getAppIcon === "function" ?
                '<div class="settings-app-icon-block">' +
                  '<div class="settings-section-head">' +
                    '<span class="settings-section-icon">' + iconSvg("palette", { size: 18, strokeWidth: 1.7 }) + '</span>' +
                    '<div class="settings-section-head-text">' +
                      '<h4 class="settings-section-heading">应用图标</h4>' +
                      '<p class="settings-section-sub">选择 App 启动器图标，返回桌面后生效</p>' +
                    '</div>' +
                  '</div>' +
                  '<div id="app-icon-picker" class="settings-app-icon-picker">' +
                    '<button type="button" class="settings-app-icon-option" data-icon="shorthair">' +
                      '<span class="settings-app-icon-preview">' +
                        PIXEL_AVATAR.user +
                      '</span>' +
                      '<span class="settings-app-icon-label">赛博虎妞</span>' +
                    '</button>' +
                    '<button type="button" class="settings-app-icon-option" data-icon="garfield">' +
                      '<span class="settings-app-icon-preview">' +
                        PIXEL_AVATAR.assistant +
                      '</span>' +
                      '<span class="settings-app-icon-label">勤劳初二</span>' +
                    '</button>' +
                  '</div>' +
                  '<p id="app-icon-message" class="hint hidden"></p>' +
                '</div>'
                : '') +
                '<div class="settings-actions settings-actions-sticky">' +
                  '<button id="save-config-button" class="btn btn-primary btn-block">保存配置</button>' +
                '</div>' +
                '<p id="config-message" class="hint hidden settings-status-message" role="alert"></p>' +
              '</div>' +

              // AI and models tab. Model cards are moved here once the modal is
              // mounted, preserving their existing field IDs and event wiring.
              '<div class="settings-panel" id="settings-tab-ai" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">AI 与模型</h3>' +
                  '<p class="settings-panel-desc">集中管理会话默认模型、Wand 系统服务 API，以及快捷提交使用的模型。</p>' +
                '</div>' +
                '<div id="settings-ai-model-sections"></div>' +
                '<div class="settings-actions settings-actions-sticky">' +
                  '<button id="save-ai-config-button" class="btn btn-primary btn-block">保存 AI 与模型配置</button>' +
                '</div>' +
                '<p id="ai-config-message" class="hint hidden settings-status-message" role="alert"></p>' +
              '</div>' +

              // Security tab
              '<div class="settings-panel" id="settings-tab-security" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">安全</h3>' +
                  '<p class="settings-panel-desc">管理登录密码与 SSL 证书，敏感变更请确认后再保存。</p>' +
                '</div>' +
                '<div class="settings-card">' +
                  '<div class="settings-card-head">' +
                    '<span class="settings-card-icon" aria-hidden="true">' + iconSvg("lock", { size: 18, strokeWidth: 1.8 }) + '</span>' +
                    '<div class="settings-card-head-text">' +
                      '<h3 class="settings-card-title">修改密码</h3>' +
                      '<p class="settings-card-desc">至少 6 个字符；保存后下次登录生效。</p>' +
                    '</div>' +
                  '</div>' +
                  '<form id="change-password-form" autocomplete="on" onsubmit="return false;">' +
                    '<input type="text" name="username" autocomplete="username" value="wand" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none" readonly />' +
                    '<div class="field">' +
                      '<label class="field-label" for="new-password">新密码</label>' +
                      '<input id="new-password" type="password" class="field-input" placeholder="输入新密码（至少 6 个字符）" autocomplete="new-password" />' +
                    '</div>' +
                    '<div class="field">' +
                      '<label class="field-label" for="confirm-password">确认密码</label>' +
                      '<input id="confirm-password" type="password" class="field-input" placeholder="再次输入新密码" autocomplete="new-password" />' +
                    '</div>' +
                    '<div class="settings-card-actions">' +
                      '<button id="save-password-button" class="btn btn-primary" type="submit">保存密码</button>' +
                    '</div>' +
                    '<p id="settings-error" class="error-message hidden"></p>' +
                    '<p id="settings-success" class="hint settings-success-message hidden"></p>' +
                  '</form>' +
                '</div>' +
                '<div class="settings-card">' +
                  '<div class="settings-card-head">' +
                    '<span class="settings-card-icon" aria-hidden="true">' + iconSvg("certificate", { size: 18, strokeWidth: 1.8 }) + '</span>' +
                    '<div class="settings-card-head-text">' +
                      '<h3 class="settings-card-title">SSL 证书</h3>' +
                      '<p class="settings-card-desc" id="cert-status">加载中...</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="cert-key-file">私钥文件 (.key)</label>' +
                    '<div class="file-picker">' +
                      '<input id="cert-key-file" type="file" class="file-picker-input" accept=".key,.pem" />' +
                      '<label for="cert-key-file" class="file-picker-trigger">' +
                        '<svg class="file-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>' +
                        '<span class="file-picker-label">选择私钥</span>' +
                      '</label>' +
                      '<span class="file-picker-name" data-default="未选择文件">未选择文件</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="field">' +
                    '<label class="field-label" for="cert-cert-file">证书文件 (.crt/.pem)</label>' +
                    '<div class="file-picker">' +
                      '<input id="cert-cert-file" type="file" class="file-picker-input" accept=".crt,.pem,.cert" />' +
                      '<label for="cert-cert-file" class="file-picker-trigger">' +
                        '<svg class="file-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' +
                        '<span class="file-picker-label">选择证书</span>' +
                      '</label>' +
                      '<span class="file-picker-name" data-default="未选择文件">未选择文件</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-card-actions">' +
                    '<button id="upload-cert-button" class="btn btn-primary">上传证书</button>' +
                  '</div>' +
                  '<p id="cert-message" class="hint hidden"></p>' +
                '</div>' +
              '</div>' +

              // Command presets tab
              '<div class="settings-panel" id="settings-tab-presets" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">命令预设</h3>' +
                  '<p class="settings-panel-desc">当前命令预设从 config.json 读取，可在这里快速查看已有配置。</p>' +
                '</div>' +
                '<div id="presets-list" class="presets-list"></div>' +
              '</div>' +

              // Display settings tab
              '<div class="settings-panel" id="settings-tab-display" role="tabpanel">' +
                '<div class="settings-panel-header">' +
                  '<h3 class="settings-panel-title">显示</h3>' +
                  '<p class="settings-panel-desc">控制聊天视图里不同卡片类型的默认展开状态。</p>' +
                '</div>' +
                '<div class="settings-section-title">卡片默认展开状态</div>' +
                '<p class="hint settings-inline-hint">设置结构化聊天视图中各类卡片的默认展开/折叠状态。手动操作的展开状态优先于此默认设置。</p>' +
                '<div class="switch-card-list">' +
                  '<label class="switch-card" for="cfg-card-edit">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">编辑卡片 (Edit/Write)</span>' +
                      '<input id="cfg-card-edit" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">文件编辑和写入操作的 diff 视图</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-inline">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">内联工具 (Read/Glob/Grep)</span>' +
                      '<input id="cfg-card-inline" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">文件读取、搜索等工具的结果</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-terminal">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">终端输出 (Bash)</span>' +
                      '<input id="cfg-card-terminal" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">命令行执行结果</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-thinking">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">思考过程 (Thinking)</span>' +
                      '<input id="cfg-card-thinking" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">Claude 的思考过程块</div>' +
                  '</label>' +
                  '<label class="switch-card" for="cfg-card-toolgroup">' +
                    '<div class="switch-card-header">' +
                      '<span class="switch-card-title">工具组</span>' +
                      '<input id="cfg-card-toolgroup" type="checkbox" class="switch-toggle" />' +
                      '<span class="switch-slider"></span>' +
                    '</div>' +
                    '<div class="switch-card-desc">连续同类工具调用的折叠组</div>' +
                  '</label>' +
                '</div>' +
                '<div class="settings-actions settings-actions-sticky">' +
                  '<button id="save-display-button" class="btn btn-primary btn-block">保存显示设置</button>' +
                '</div>' +
                '<p id="display-message" class="hint hidden settings-status-message"></p>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>';
      }
