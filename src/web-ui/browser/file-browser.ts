import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml } from "./utils";
import { getSelectedSession, focusInputBox } from "./input";
import { hideError, openWandDialog, showError, showToast } from "./notifications";
import { render, getEffectiveCwd } from "./render";
import { isStructuredSession, updateDrawerState } from "./session-engine";
import { renderSessions } from "./sidebar";
import { ensureTerminalFit, scheduleTerminalResize } from "./viewport";
import { parseMarkdownTables } from "./chat-render";
import { getConfigCwd } from "./chat-scroll";

      export function isMobileLayout() {
        return window.innerWidth <= 768;
      }

      export function shouldShowSessionsBackdrop() {
        return !!state.sessionsDrawerOpen && (isMobileLayout() || !state.sidebarPinned);
      }

      export function setFilePanelOpen(nextOpen) {
        state.filePanelOpen = nextOpen;
        try {
          localStorage.setItem("wand-file-panel-open", String(state.filePanelOpen));
        } catch (e) {}
        if (state.filePanelOpen && isMobileLayout()) {
          state.sessionsDrawerOpen = false;
          writeStoredBoolean("wand-sidebar-open", false);
        }
        updateLayoutState();
        if (state.filePanelOpen) {
          refreshFileExplorer();
        }
      }

      export function toggleFilePanel() {
        setFilePanelOpen(!state.filePanelOpen);
      }

      export function updateFilePanelState() {
        var panel = document.getElementById("file-side-panel");
        var mainContent = document.querySelector(".main-content");
        var toggleBtn = document.getElementById("file-panel-toggle-btn");
        var backdrop = document.getElementById("file-panel-backdrop");
        if (panel) {
          panel.classList.toggle("open", state.filePanelOpen);
        }
        if (mainContent) {
          mainContent.classList.toggle("file-panel-open", state.filePanelOpen);
        }
        if (backdrop) {
          backdrop.classList.toggle("open", state.filePanelOpen);
        }
        if (toggleBtn) {
          toggleBtn.classList.toggle("active", state.filePanelOpen);
        }
      }

      export function updateLayoutState() {
        updateDrawerState();
        updateFilePanelState();
      }

      export function updateFilePanelCwd(session) {
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!cwdEl) return;
        var cwd = session && session.cwd ? session.cwd : getConfigCwd();
        // Don't clobber the user's in-progress edit when the input is focused.
        if (cwdEl.tagName === "INPUT") {
          if (document.activeElement !== cwdEl) {
            cwdEl.value = cwd;
          }
        } else {
          cwdEl.textContent = cwd;
        }
        cwdEl.title = cwd;
      }

      export function closeFilePanel() {
        if (!state.filePanelOpen) return;
        setFilePanelOpen(false);
      }

      export function adjustTerminalScale(delta) {
        var newScale = state.terminalScale + delta;
        // Clamp scale between 0.5 and 2
        newScale = Math.max(0.5, Math.min(2, newScale));
        // Round to nearest 0.25
        newScale = Math.round(newScale * 4) / 4;
        if (newScale === state.terminalScale) return;
        state.terminalScale = newScale;
        try {
          localStorage.setItem("wand-terminal-scale", String(newScale));
        } catch (e) {}
        applyTerminalScale();
        updateScaleLabel();
      }

      export function applyTerminalScale() {
        if (!state.terminal || !state.terminal.element) return;
        // 字号和行高都向上取整到整数像素：PC 端 1× DPR 下浏览器对亚像素
        // 字号/行高的舍入策略不一致（fontSize 16.25 → 16 或 17，行高
        // 19.5 → 19 或 20），相邻行/列的吸附方向不同就会让 wterm 网格
        // 错位。强制整数 px 让 cell 高度、字符高度都稳定一致，等价于
        // 之前桌面端必须按右上角缩放才能恢复的"整像素重排"路径。
        var rawFontSize = state.terminalBaseFontSize * state.terminalScale;
        var fontPx = Math.max(1, Math.round(rawFontSize));
        var rowPx = Math.max(1, Math.round(rawFontSize * 1.5));
        state.terminal.element.style.setProperty("--term-font-size", fontPx + "px");
        state.terminal.element.style.setProperty("--term-row-height", rowPx + "px");
        if (typeof state.terminal.remeasure === "function") {
          requestAnimationFrame(function() {
            if (state.terminal) state.terminal.remeasure();
          });
        }
      }

      export function updateScaleLabel() {
        var label = document.getElementById("terminal-scale-label-top");
        if (label) {
          label.textContent = Math.round(state.terminalScale * 100) + "%";
        }
      }

      // ── Inline SVG icon library for file UI ──
      // The previous design used unicode/emoji glyphs (⬆ ↻ 👁 ✕ 📋 ✏️ ⬇ ↩ A−) for
      // toolbar/header buttons. Those render inconsistently across OSes and don't
      // visually convey their action. These SVG icons are stroke-based, follow
      // currentColor, and stay crisp at any zoom.
      export var WAND_FILE_ICONS = {
        "chevron-left":  '<path d="M15 18l-6-6 6-6"/>',
        "arrow-up":      '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
        "refresh":       '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
        "eye":           '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
        "eye-off":       '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a19.86 19.86 0 0 1 4.22-5.18"/><path d="M1 1l22 22"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a19.83 19.83 0 0 1-3.36 4.27"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
        "x":             '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
        "search":        '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
        "copy":          '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
        "clipboard":     '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
        "download":      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
        "edit":          '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>',
        "save":          '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
        "rotate-ccw":    '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
        "wrap-text":     '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="M16 16l-2 2 2 2"/><path d="M3 18h6"/>',
        "type":          '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
        "minus":         '<path d="M5 12h14"/>',
        "plus":          '<path d="M12 5v14"/><path d="M5 12h14"/>',
        "send-to-input": '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
        "terminal":      '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
        "folder-open":   '<path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
        "info":          '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
      };

      // Render a stroke-based 16x16 SVG icon by name. Extra classes get appended
      // to the outer svg, so callers can target specific icons in CSS.
      export function wandFileIcon(name, opts) {
        opts = opts || {};
        var body = WAND_FILE_ICONS[name] || "";
        var size = opts.size || 16;
        var extraClass = opts.className ? " " + opts.className : "";
        return '<svg class="wand-icon wand-icon-' + name + extraClass +
          '" width="' + size + '" height="' + size +
          '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
          ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          body + '</svg>';
      }

      export function renderFileExplorer(cwd) {
        var root = cwd || getConfigCwd();
        if (!root) {
          return '<div class="file-explorer empty">未配置工作目录。</div>';
        }
        return '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(root) + '">' +
          '<div class="tree-loading">加载中…</div>' +
        '</div>';
      }

      // ── File tree helpers ──

      export var FILE_ICON_MAP = {
        // images
        png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️",
        avif: "🖼️", bmp: "🖼️", ico: "🖼️", heic: "🖼️", heif: "🖼️",
        // pdf / doc
        pdf: "📕", doc: "📘", docx: "📘", odt: "📘",
        xls: "📊", xlsx: "📊", csv: "📊", tsv: "📊",
        ppt: "📙", pptx: "📙",
        // video / audio
        mp4: "🎬", webm: "🎬", mov: "🎬", mkv: "🎬", m4v: "🎬", ogv: "🎬",
        mp3: "🎵", wav: "🎵", ogg: "🎵", m4a: "🎵", flac: "🎵", aac: "🎵", opus: "🎵",
        // archives
        zip: "📦", tar: "📦", gz: "📦", tgz: "📦", bz2: "📦", "7z": "📦", rar: "📦", xz: "📦",
        // markup / docs
        md: "📝", markdown: "📝", mdx: "📝", rst: "📝", txt: "📝", log: "📝",
        // web / styles
        html: "🌐", htm: "🌐", xml: "🌐",
        css: "🎨", scss: "🎨", less: "🎨",
        // configs
        json: "⚙️", jsonc: "⚙️", yaml: "⚙️", yml: "⚙️", toml: "⚙️",
        ini: "⚙️", cfg: "⚙️", conf: "⚙️", env: "⚙️", editorconfig: "⚙️",
        // code (default 📜)
        ts: "📜", tsx: "📜", js: "📜", jsx: "📜", mjs: "📜", cjs: "📜",
        py: "📜", rb: "📜", go: "📜", rs: "📜", java: "📜", c: "📜", cpp: "📜",
        h: "📜", hpp: "📜", cs: "📜", swift: "📜", kt: "📜", scala: "📜",
        php: "📜", sh: "📜", bash: "📜", zsh: "📜", fish: "📜", lua: "📜",
        sql: "📜", graphql: "📜", proto: "📜", vue: "📜", svelte: "📜",
        diff: "📜", patch: "📜",
        // fonts / binary
        ttf: "🔤", otf: "🔤", woff: "🔤", woff2: "🔤", eot: "🔤",
      };

      export function getFileIcon(item) {
        if (!item) return "📄";
        if (item.type === "dir") return "📁";
        var name = (item.name || "").toLowerCase();
        // basename-only matches first
        if (name === "dockerfile") return "🐳";
        if (name === "makefile") return "🛠️";
        if (name === "license") return "📜";
        if (name === "readme") return "📝";
        var dot = name.lastIndexOf(".");
        if (dot < 0 || dot === name.length - 1) return "📄";
        var ext = name.slice(dot + 1);
        return FILE_ICON_MAP[ext] || "📄";
      }

      export function formatFileSize(bytes) {
        if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "";
        if (bytes < 1024) return bytes + " B";
        var kb = bytes / 1024;
        if (kb < 1024) return (kb >= 10 ? Math.round(kb) : kb.toFixed(1)) + " KB";
        var mb = kb / 1024;
        if (mb < 1024) return (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + " MB";
        var gb = mb / 1024;
        return (gb >= 10 ? Math.round(gb) : gb.toFixed(1)) + " GB";
      }

      export function formatRelativeTime(iso) {
        if (!iso) return "";
        var t = Date.parse(iso);
        if (isNaN(t)) return "";
        return new Date(t).toLocaleString();
      }

      export function getEffectiveExplorerCwd() {
        if (state.fileExplorerCwd) return state.fileExplorerCwd;
        if (state.selectedId) {
          var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (session && session.cwd) return session.cwd;
        }
        return getConfigCwd();
      }

      export function refreshFileExplorer(opts) {
        opts = opts || {};
        var explorer = document.getElementById("file-explorer");
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!explorer) return;
        var cwd = opts.cwd || getEffectiveExplorerCwd();
        if (!cwd) {
          explorer.innerHTML = '<div class="file-explorer empty">没有可显示的工作目录。</div>';
          return;
        }
        state.fileExplorerCwd = cwd;
        state.fileExplorerLoading = true;
        state.allFiles = [];
        state.fileExplorerTruncated = false;
        state.fileExplorerTotal = 0;
        explorer.innerHTML = '<div class="file-explorer"><div class="tree-loading" style="padding:12px;color:var(--text-muted);font-size:0.8125rem;">加载中…</div></div>';
        if (cwdEl) {
          if (cwdEl.tagName === "INPUT") {
            // Avoid clobbering in-progress text while the user is typing.
            if (document.activeElement !== cwdEl) {
              cwdEl.value = cwd;
            }
          } else {
            cwdEl.textContent = cwd;
          }
          cwdEl.title = cwd;
        }
        var url = "/api/directory?q=" + encodeURIComponent(cwd) +
          "&gitStatus=true";
        fetch(url, { credentials: "same-origin" })
          .then(function(res) {
            if (!res.ok) throw new Error("Failed to load directory.");
            return res.json();
          })
          .then(function(payload) {
            state.fileExplorerLoading = false;
            // Backend returns { items, truncated, total }; tolerate the legacy array shape too.
            var items, truncated, total;
            if (Array.isArray(payload)) {
              items = payload; truncated = false; total = payload.length;
            } else {
              items = (payload && payload.items) || [];
              truncated = !!(payload && payload.truncated);
              total = (payload && payload.total) || items.length;
            }
            if (!items || items.length === 0) {
              explorer.innerHTML = '<div class="file-explorer empty">空目录或无法访问。</div>';
              return;
            }
            state.allFiles = items;
            state.fileExplorerTruncated = truncated;
            state.fileExplorerTotal = total;
            filterFileTree();
          })
          .catch(function() {
            state.fileExplorerLoading = false;
            explorer.innerHTML = '<div class="file-explorer empty">加载失败，请检查路径或权限。</div>';
          });
      }

      export function filterFileTree() {
        var explorer = document.getElementById("file-explorer");
        if (!explorer) return;
        var cwd = state.fileExplorerCwd || "";
        if (!cwd) return;

        var query = state.fileSearchQuery;
        var items = state.allFiles || [];
        var filtered = items;

        if (query) {
          var lowerQuery = query.toLowerCase();
          filtered = items.filter(function(item) {
            return item.name.toLowerCase().indexOf(lowerQuery) !== -1;
          });
        }

        if (filtered.length === 0) {
          explorer.innerHTML = '<div class="file-explorer empty">' + (query ? '没有找到匹配的文件' : '空目录') + '</div>';
          return;
        }

        var truncatedNotice = "";
        if (!query && state.fileExplorerTruncated) {
          var shown = items.length;
          truncatedNotice = '<div class="tree-truncated" title="后端按字母序最多返回 ' + shown + ' 项">显示前 ' + shown + ' 项 / 共 ' + state.fileExplorerTotal + ' 项</div>';
        }

        explorer.innerHTML = '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(cwd) + '">' +
          filtered.map(function(item) {
            return renderFileTreeItem(item);
          }).join("") +
        '</div>' + truncatedNotice;
        attachFileTreeListeners();
      }

      export function renderFileTreeItem(item, depth) {
        depth = depth || 0;
        var name = escapeHtml(item.name);
        var isDir = item.type === "dir";
        var displayIcon = getFileIcon(item);
        var toggleIcon = isDir ? "▸" : "";
        var toggleClass = isDir ? "" : " empty";
        var gitStatus = item.gitStatus;
        var statusBadge = renderGitStatusBadge(gitStatus);
        var meta = "";
        if (!isDir && typeof item.size === "number") {
          meta = '<span class="tree-meta" title="大小：' + escapeHtml(formatFileSize(item.size)) +
            (item.mtime ? '\n修改时间：' + escapeHtml(formatRelativeTime(item.mtime)) : '') +
            '">' + escapeHtml(formatFileSize(item.size)) + '</span>';
        }
        return '<div class="tree-item" data-path="' + escapeHtml(item.path) + '" data-type="' + escapeHtml(item.type) + '" data-name="' + escapeHtml(item.name) + '" tabindex="0">' +
          '<span class="tree-toggle' + toggleClass + '">' + toggleIcon + '</span>' +
          '<span class="tree-icon">' + displayIcon + '</span>' +
          '<span class="tree-name">' + name + '</span>' +
          meta +
          (statusBadge ? '<span class="git-status-badge ' + statusBadge.class + '" title="' + statusBadge.title + '">' + statusBadge.text + '</span>' : '') +
        '</div>';
      }

      export function renderGitStatusBadge(gitStatus) {
        if (!gitStatus) return null;
        if (gitStatus.staged === "added") return { text: "A", class: "git-added", title: "已暂存（新增）" };
        if (gitStatus.staged === "modified") return { text: "M", class: "git-modified", title: "已暂存（修改）" };
        if (gitStatus.staged === "deleted") return { text: "D", class: "git-deleted", title: "已暂存（删除）" };
        if (gitStatus.staged === "renamed") return { text: "R", class: "git-renamed", title: "已暂存（重命名）" };
        if (gitStatus.unstaged === "modified") return { text: "M", class: "git-unstaged", title: "未暂存（修改）" };
        if (gitStatus.unstaged === "deleted") return { text: "D", class: "git-unstaged-deleted", title: "未暂存（删除）" };
        if (gitStatus.untracked) return { text: "?", class: "git-untracked", title: "未跟踪" };
        return null;
      }

      export function attachFileTreeListeners() {
        var tree = document.getElementById("file-tree");
        if (!tree) return;
        tree.querySelectorAll(".tree-item[data-type='dir']").forEach(function(item) {
          item.addEventListener("click", function(e) {
            // Don't toggle when click came from the meta/badge area
            toggleTreeNode(item);
          });
        });
        tree.querySelectorAll(".tree-item[data-type='file']").forEach(function(item) {
          var openHandler = function() { openFilePreview(item.dataset.path); };
          item.addEventListener("click", openHandler);
          // Keep dblclick for old muscle memory; both work.
          item.addEventListener("dblclick", openHandler);
        });
        // Long-press / right-click context menu (path actions)
        var pressTimer = null;
        var pressFired = false;
        tree.querySelectorAll(".tree-item").forEach(function(item) {
          item.addEventListener("contextmenu", function(e) {
            e.preventDefault();
            showFileContextMenu(e.clientX, e.clientY, item);
          });
          item.addEventListener("touchstart", function(e) {
            pressFired = false;
            pressTimer = setTimeout(function() {
              pressFired = true;
              var t = e.touches && e.touches[0];
              showFileContextMenu(t ? t.clientX : 0, t ? t.clientY : 0, item);
            }, 500);
          }, { passive: true });
          item.addEventListener("touchend", function() {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
          });
          item.addEventListener("touchmove", function() {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
          });
        });
      }

      export function toggleTreeNode(item) {
        var p = item.dataset.path;
        var toggle = item.querySelector(".tree-toggle");
        var children = item.nextElementSibling;

        if (children && children.classList.contains("tree-children")) {
          var isOpen = children.classList.contains("open");
          children.classList.toggle("open");
          if (toggle) toggle.classList.toggle("open", !isOpen);
          // swap folder icon between 📁 and 📂
          var iconEl = item.querySelector(".tree-icon");
          if (iconEl) iconEl.textContent = isOpen ? "📁" : "📂";
          return;
        }

        if (toggle) toggle.classList.add("open");
        var iconEl2 = item.querySelector(".tree-icon");
        if (iconEl2) iconEl2.textContent = "📂";
        var url = "/api/directory?q=" + encodeURIComponent(p) +
          "&gitStatus=true";
        fetch(url, { credentials: "same-origin" })
          .then(function(res) { return res.json(); })
          .then(function(payload) {
            var items;
            if (Array.isArray(payload)) items = payload;
            else items = (payload && payload.items) || [];
            var childrenDiv = document.createElement("div");
            childrenDiv.className = "tree-children open";
            if (!items || items.length === 0) {
              childrenDiv.innerHTML = '<div class="tree-item" style="color:var(--text-muted);cursor:default;"><span class="tree-toggle empty">▸</span><span class="tree-name">（空目录）</span></div>';
            } else {
              childrenDiv.innerHTML = items.map(function(child) {
                return renderFileTreeItem(child);
              }).join("");
            }
            item.parentNode.insertBefore(childrenDiv, item.nextSibling);
            attachFileTreeListeners();
          })
          .catch(function() {});
      }

      // Walk up to the parent directory and re-render the tree.
      export function navigateExplorerUp() {
        var cwd = getEffectiveExplorerCwd();
        if (!cwd) return;
        var parent = cwd.replace(/\/+$/, "").replace(/\/[^\/]+$/, "");
        if (!parent) parent = "/";
        if (parent === cwd) return;
        refreshFileExplorer({ cwd: parent });
      }

      export function appendToComposer(text) {
        var inputBox = document.getElementById("input-box");
        if (!inputBox) return false;
        var current = inputBox.value || "";
        var sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
        inputBox.value = current + sep + text;
        inputBox.dispatchEvent(new Event("input", { bubbles: true }));
        try { inputBox.focus(); inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length); } catch (e) {}
        return true;
      }

      export function copyTextSafely(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(function() { return true; }).catch(function() { return fallback(); });
        }
        return Promise.resolve(fallback());
        function fallback() {
          try {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
          } catch (e) { return false; }
        }
      }

      export function showToastIfPossible(msg) {
        if (typeof window.showToast === "function") { window.showToast(msg); return; }
        // Lightweight transient toast.
        var t = document.createElement("div");
        t.className = "wand-mini-toast";
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function() { t.classList.add("show"); }, 10);
        setTimeout(function() {
          t.classList.remove("show");
          setTimeout(function() { t.remove(); }, 220);
        }, 1600);
      }

      export function dismissFileContextMenu() {
        var menu = document.getElementById("file-context-menu");
        if (menu) menu.remove();
        document.removeEventListener("click", dismissFileContextMenu, true);
        document.removeEventListener("scroll", dismissFileContextMenu, true);
      }

      export function showFileContextMenu(x, y, item) {
        dismissFileContextMenu();
        var fullPath = item.dataset.path || "";
        var type = item.dataset.type || "file";
        var cwd = state.fileExplorerCwd || "";
        var relativePath = fullPath;
        if (cwd && fullPath.indexOf(cwd) === 0) {
          relativePath = fullPath.slice(cwd.length).replace(/^\/+/, "") || ".";
        }

        var menu = document.createElement("div");
        menu.id = "file-context-menu";
        menu.className = "file-context-menu";
        var actions = [];
        if (type === "file") {
          actions.push({ label: "打开预览", icon: "👁", run: function() { openFilePreview(fullPath); } });
        } else {
          actions.push({ label: "进入此目录", icon: "📂", run: function() { refreshFileExplorer({ cwd: fullPath }); } });
        }
        actions.push({ label: "复制完整路径", icon: "📋", run: function() {
          copyTextSafely(fullPath).then(function() { showToastIfPossible("已复制路径"); });
        }});
        if (relativePath && relativePath !== fullPath) {
          actions.push({ label: "复制相对路径", icon: "📋", run: function() {
            copyTextSafely(relativePath).then(function() { showToastIfPossible("已复制相对路径"); });
          }});
        }
        actions.push({ label: "粘贴路径到输入框", icon: "✏️", run: function() {
          if (appendToComposer(fullPath)) showToastIfPossible("已粘贴到输入框");
        }});
        if (type === "file") {
          actions.push({ label: "下载文件", icon: "⬇", run: function() {
            var a = document.createElement("a");
            a.href = "/api/file-raw?download=1&path=" + encodeURIComponent(fullPath);
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
          }});
        }

        menu.innerHTML = actions.map(function(act, i) {
          return '<button type="button" class="file-context-menu-item" data-idx="' + i + '"><span class="ctx-icon">' + act.icon + '</span><span class="ctx-label">' + escapeHtml(act.label) + '</span></button>';
        }).join("");
        document.body.appendChild(menu);

        // Position with viewport-bound clamp
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var rect = menu.getBoundingClientRect();
        var left = Math.min(x, vw - rect.width - 8);
        var top = Math.min(y, vh - rect.height - 8);
        menu.style.left = Math.max(8, left) + "px";
        menu.style.top = Math.max(8, top) + "px";

        menu.querySelectorAll(".file-context-menu-item").forEach(function(btn) {
          btn.addEventListener("click", function(ev) {
            ev.stopPropagation();
            var idx = parseInt(btn.dataset.idx, 10);
            dismissFileContextMenu();
            if (actions[idx]) actions[idx].run();
          });
        });

        // Close on outside click / scroll
        setTimeout(function() {
          document.addEventListener("click", dismissFileContextMenu, true);
          document.addEventListener("scroll", dismissFileContextMenu, true);
        }, 0);
      }

      // Module-level handle for keyboard nav between siblings.
      export var _activeFilePreview = null;

      export function openFilePreview(filePath) {
        // If a modal is already open, just swap content (used by ←/→ navigation).
        var overlay = _activeFilePreview && _activeFilePreview.overlay;
        if (!overlay) {
          overlay = document.createElement("div");
          overlay.className = "file-preview-overlay";
          overlay.innerHTML =
            '<div class="file-preview-modal" tabindex="-1">' +
              '<div class="file-preview-header">' +
                '<div class="file-preview-title">' +
                  '<span class="file-preview-icon">📄</span>' +
                  '<div class="file-preview-name-block">' +
                    '<div class="file-preview-name-row">' +
                      '<span class="file-preview-filename">加载中…</span>' +
                    '</div>' +
                    '<span class="file-preview-path" title=""></span>' +
                  '</div>' +
                '</div>' +
                '<div class="file-preview-toolbar"></div>' +
                '<button class="file-preview-close" title="关闭 (Esc)" aria-label="关闭">' + wandFileIcon("x", { size: 18 }) + '</button>' +
              '</div>' +
              '<div class="file-preview-body">' +
                '<div class="file-preview-loading">加载预览…</div>' +
              '</div>' +
            '</div>';
          document.body.appendChild(overlay);

          var closeBtn = overlay.querySelector(".file-preview-close");
          var closeModal = function() {
            // Guard: warn before discarding unsaved edits.
            if (_activeFilePreview && _activeFilePreview.dirty) {
              if (typeof openWandDialog === "function") {
                openWandDialog({
                  type: "warning",
                  title: "放弃未保存的修改？",
                  message: "当前文件有未保存的改动，关闭后会丢失。",
                  buttons: [
                    { label: "继续编辑", value: false, kind: "ghost" },
                    { label: "放弃修改", value: true, kind: "danger", autofocus: true },
                  ],
                  cancelValue: false,
                }).then(function(go) { if (go) doClose(); });
                return;
              }
            }
            doClose();
          };
          var doClose = function() {
            overlay.remove();
            document.removeEventListener("keydown", keyHandler);
            _activeFilePreview = null;
          };
          closeBtn.addEventListener("click", closeModal);
          overlay.addEventListener("click", function(e) {
            if (e.target === overlay) closeModal();
          });
          var keyHandler = function(e) {
            // Ctrl/Cmd+S to save in edit mode.
            if ((e.key === "s" || e.key === "S") && (e.ctrlKey || e.metaKey)) {
              if (_activeFilePreview && _activeFilePreview.editing) {
                e.preventDefault();
                saveFileEdit();
                return;
              }
            }
            if (e.key === "Escape") {
              // Inside edit mode, Esc exits edit instead of closing the modal.
              if (_activeFilePreview && _activeFilePreview.editing) {
                e.preventDefault();
                exitFileEdit();
                return;
              }
              closeModal();
              return;
            }
            if (!_activeFilePreview) return;
            // Don't intercept arrow keys while typing.
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
            if (_activeFilePreview.editing) return;
            if (e.key === "ArrowLeft") { e.preventDefault(); navigatePreviewSibling(-1); }
            else if (e.key === "ArrowRight") { e.preventDefault(); navigatePreviewSibling(1); }
          };
          document.addEventListener("keydown", keyHandler);

          _activeFilePreview = { overlay: overlay, close: closeModal, path: filePath, data: null, editing: false, dirty: false };
        } else {
          _activeFilePreview.path = filePath;
          _activeFilePreview.editing = false;
          _activeFilePreview.dirty = false;
          // Reset header / body for the new file.
          var titleEl = overlay.querySelector(".file-preview-title");
          if (titleEl) {
            titleEl.innerHTML =
              '<span class="file-preview-icon">📄</span>' +
              '<div class="file-preview-name-block">' +
                '<div class="file-preview-name-row">' +
                  '<span class="file-preview-filename">加载中…</span>' +
                '</div>' +
                '<span class="file-preview-path" title=""></span>' +
              '</div>';
          }
          var toolbarEl = overlay.querySelector(".file-preview-toolbar");
          if (toolbarEl) toolbarEl.innerHTML = "";
          var pathEl = overlay.querySelector(".file-preview-path");
          if (pathEl) { pathEl.textContent = ""; pathEl.title = ""; }
          var bodyReset = overlay.querySelector(".file-preview-body");
          if (bodyReset) bodyReset.innerHTML = '<div class="file-preview-loading">加载预览…</div>';
        }

        var pathDisplayEl = overlay.querySelector(".file-preview-path");
        if (pathDisplayEl) {
          pathDisplayEl.textContent = filePath;
          pathDisplayEl.title = filePath;
        }

        fetch("/api/file-preview?path=" + encodeURIComponent(filePath), { credentials: "same-origin" })
          .then(function(res) {
            return res.json().then(function(data) { return { ok: res.ok, status: res.status, data: data }; });
          })
          .then(function(result) {
            var body = overlay.querySelector(".file-preview-body");
            if (!result.ok || (result.data && result.data.error)) {
              var msg = (result.data && result.data.error) || "加载失败";
              if (result.status === 413 && result.data && result.data.size) {
                msg += "（文件大小：" + formatFileSize(result.data.size) + "）";
              }
              body.innerHTML = '<div class="file-preview-error"><span class="preview-error-icon">⚠</span><span>' + escapeHtml(msg) + '</span></div>';
              // Even when text preview is rejected for size, still allow download.
              if (result.status === 413) {
                renderPreviewToolbar(overlay, {
                  kind: "binary",
                  path: filePath,
                  name: filePath.split("/").pop() || filePath,
                  ext: "",
                  size: (result.data && result.data.size) || 0,
                });
              }
              return;
            }
            _activeFilePreview.data = result.data;
            renderPreviewContent(overlay, result.data);
          })
          .catch(function() {
            var body = overlay.querySelector(".file-preview-body");
            body.innerHTML = '<div class="file-preview-error"><span class="preview-error-icon">⚠</span><span>加载预览失败</span></div>';
          });
      }

      // Move to the previous/next file sibling in the current explorer view.
      export function navigatePreviewSibling(direction) {
        if (!_activeFilePreview) return;
        var siblings = (state.allFiles || []).filter(function(item) { return item.type === "file"; });
        if (!siblings.length) return;
        var currentPath = _activeFilePreview.path;
        var idx = -1;
        for (var i = 0; i < siblings.length; i++) {
          if (siblings[i].path === currentPath) { idx = i; break; }
        }
        if (idx < 0) return;
        var nextIdx = (idx + direction + siblings.length) % siblings.length;
        var nextPath = siblings[nextIdx].path;
        if (nextPath && nextPath !== currentPath) openFilePreview(nextPath);
      }

      export function renderPreviewContent(overlay, data) {
        var filenameEl = overlay.querySelector(".file-preview-filename");
        if (filenameEl) filenameEl.textContent = data.name;
        var iconEl = overlay.querySelector(".file-preview-icon");
        if (iconEl) iconEl.textContent = getFileIcon({ name: data.name, type: "file" });

        // Title-bar badge: language for text, kind label for media/binary
        var titleEl = overlay.querySelector(".file-preview-title");
        var existingBadge = overlay.querySelector(".file-preview-lang");
        if (existingBadge) existingBadge.remove();
        var langBadge = document.createElement("span");
        langBadge.className = "file-preview-lang";
        var labelMap = { image: "图片", pdf: "PDF", video: "视频", audio: "音频", binary: "二进制" };
        if (data.kind === "text") {
          langBadge.textContent = data.lang || (data.ext || "").replace(".", "") || "text";
        } else {
          langBadge.textContent = labelMap[data.kind] || (data.ext || "").replace(".", "") || data.kind;
        }
        if (titleEl) titleEl.appendChild(langBadge);

        renderPreviewToolbar(overlay, data);

        var body = overlay.querySelector(".file-preview-body");
        body.innerHTML = "";
        body.classList.remove("kind-text", "kind-image", "kind-pdf", "kind-video", "kind-audio", "kind-binary");
        body.classList.add("kind-" + (data.kind || "text"));

        if (data.kind === "image") {
          renderImagePreview(body, data);
        } else if (data.kind === "pdf") {
          renderPdfPreview(body, data);
        } else if (data.kind === "video") {
          renderVideoPreview(body, data);
        } else if (data.kind === "audio") {
          renderAudioPreview(body, data);
        } else if (data.kind === "binary") {
          renderBinaryPreview(body, data);
        } else if ((data.lang === "markdown") || /\.(md|markdown|mdx)$/i.test(data.name || "")) {
          body.innerHTML = '<div class="markdown-preview">' + renderMarkdownPreview(data.content || "") + '</div>';
        } else {
          renderTextPreview(body, data);
        }
      }

      export function renderTextPreview(body, data) {
        var highlighted = highlightCodePreview(data.content || "", data.lang);
        var lines = highlighted.split("\n");
        var lineNums = lines.map(function(_, i) { return i + 1; });
        body.innerHTML =
          '<div class="code-preview-wrapper">' +
            '<div class="code-preview-lines">' + lineNums.join("\n") + '</div>' +
            '<div class="code-preview-content"><pre>' + lines.join("\n") + '</pre></div>' +
          '</div>';
      }

      export function renderImagePreview(body, data) {
        var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
        body.innerHTML =
          '<div class="image-preview-wrapper">' +
            '<img class="image-preview-img" src="' + src + '" alt="' + escapeHtml(data.name) + '" />' +
          '</div>';
        var img = body.querySelector(".image-preview-img");
        if (!img) return;
        var zoomed = false;
        img.addEventListener("click", function() {
          zoomed = !zoomed;
          img.classList.toggle("zoomed", zoomed);
        });
      }

      export function renderPdfPreview(body, data) {
        var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
        body.innerHTML =
          '<iframe class="pdf-preview-frame" src="' + src + '" title="' + escapeHtml(data.name) + '"></iframe>';
      }

      export function renderVideoPreview(body, data) {
        var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
        body.innerHTML =
          '<div class="media-preview-wrapper">' +
            '<video class="media-preview-video" controls preload="metadata" src="' + src + '">您的浏览器不支持 video 标签。</video>' +
            '<div class="media-preview-meta">' + escapeHtml(formatFileSize(data.size)) + '</div>' +
          '</div>';
      }

      export function renderAudioPreview(body, data) {
        var src = "/api/file-raw?path=" + encodeURIComponent(data.path);
        body.innerHTML =
          '<div class="media-preview-wrapper audio">' +
            '<div class="media-preview-icon">🎵</div>' +
            '<div class="media-preview-name">' + escapeHtml(data.name) + '</div>' +
            '<audio class="media-preview-audio" controls preload="metadata" src="' + src + '">您的浏览器不支持 audio 标签。</audio>' +
            '<div class="media-preview-meta">' + escapeHtml(formatFileSize(data.size)) + '</div>' +
          '</div>';
      }

      export function renderBinaryPreview(body, data) {
        var rawUrl = "/api/file-raw?download=1&path=" + encodeURIComponent(data.path);
        body.innerHTML =
          '<div class="binary-preview-card">' +
            '<div class="binary-preview-icon">📦</div>' +
            '<div class="binary-preview-name">' + escapeHtml(data.name) + '</div>' +
            '<div class="binary-preview-meta">' +
              '<span>' + escapeHtml((data.ext || "").replace(/^\./, "") || "未知格式") + '</span>' +
              '<span>·</span>' +
              '<span>' + escapeHtml(formatFileSize(data.size)) + '</span>' +
            '</div>' +
            '<div class="binary-preview-path" title="' + escapeHtml(data.path) + '">' + escapeHtml(data.path) + '</div>' +
            '<div class="binary-preview-actions">' +
              '<a class="binary-preview-btn" href="' + rawUrl + '" download="' + escapeHtml(data.name) + '">下载文件</a>' +
              '<button class="binary-preview-btn" type="button" data-action="view-cat">在终端中查看</button>' +
            '</div>' +
          '</div>';
        var catBtn = body.querySelector('[data-action="view-cat"]');
        if (catBtn) catBtn.addEventListener("click", function() {
          if (appendToComposer('cat -- "' + data.path + '"')) {
            showToastIfPossible("命令已粘贴到输入框");
          }
        });
      }

      export function renderPreviewToolbar(overlay, data) {
        var bar = overlay.querySelector(".file-preview-toolbar");
        if (!bar) return;
        bar.innerHTML = "";
        bar.classList.remove("editing");

        // ── Edit mode renders its own dedicated toolbar (save / revert / cancel). ──
        if (_activeFilePreview && _activeFilePreview.editing) {
          bar.classList.add("editing");
          renderEditToolbar(overlay, data);
          return;
        }

        var buttons = [];

        if (data.kind === "text") {
          buttons.push({ label: "编辑文件 (E)", icon: wandFileIcon("edit"), primary: true, action: function() {
            enterFileEdit();
          }});
        }

        // Common actions across all kinds
        buttons.push({ label: "复制路径", icon: wandFileIcon("clipboard"), action: function() {
          copyTextSafely(data.path).then(function() { showToastIfPossible("已复制路径"); });
        }});
        buttons.push({ label: "粘贴到输入框", icon: wandFileIcon("send-to-input"), action: function() {
          if (appendToComposer(data.path)) showToastIfPossible("已粘贴到输入框");
        }});
        buttons.push({ label: "下载", icon: wandFileIcon("download"), action: function() {
          var a = document.createElement("a");
          a.href = "/api/file-raw?download=1&path=" + encodeURIComponent(data.path);
          a.download = data.name || "";
          document.body.appendChild(a);
          a.click();
          a.remove();
        }});

        if (data.kind === "text") {
          buttons.push({ label: "复制全部内容", icon: wandFileIcon("copy"), action: function() {
            copyTextSafely(data.content || "").then(function() { showToastIfPossible("已复制内容"); });
          }});
          buttons.push({ label: "切换自动换行", icon: wandFileIcon("wrap-text"), toggleClass: "toolbar-active",
            getInitial: function() {
              var pre = overlay.querySelector(".code-preview-content pre");
              return pre && pre.classList.contains("wrap");
            },
            action: function(btn) {
              var pre = overlay.querySelector(".code-preview-content pre");
              if (!pre) return;
              pre.classList.toggle("wrap");
              btn.classList.toggle("toolbar-active", pre.classList.contains("wrap"));
            }
          });
          // Font-size adjustments — render as a single grouped chip with two halves.
          buttons.push({ kind: "group", className: "toolbar-group-fontsize",
            children: [
              { label: "缩小字号", icon: wandFileIcon("minus"), action: function() { adjustPreviewFontSize(overlay, -1); }},
              { kind: "label", icon: wandFileIcon("type"), label: "字号" },
              { label: "放大字号", icon: wandFileIcon("plus"), action: function() { adjustPreviewFontSize(overlay, +1); }},
            ],
          });
        }

        renderToolbarButtons(bar, buttons, overlay);
      }

      // Render a flat list of toolbar buttons (with optional grouped chips).
      export function renderToolbarButtons(bar, buttons, overlay) {
        buttons.forEach(function(b) {
          if (b.kind === "group") {
            var group = document.createElement("div");
            group.className = "file-preview-toolbar-group" + (b.className ? " " + b.className : "");
            b.children.forEach(function(child) {
              if (child.kind === "label") {
                var lab = document.createElement("span");
                lab.className = "file-preview-toolbar-grouplabel";
                lab.title = child.label || "";
                lab.innerHTML = child.icon || "";
                group.appendChild(lab);
                return;
              }
              group.appendChild(buildToolbarButton(child));
            });
            bar.appendChild(group);
            return;
          }
          bar.appendChild(buildToolbarButton(b));
        });
      }

      export function buildToolbarButton(b) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "file-preview-toolbar-btn";
        if (b.primary) btn.classList.add("primary");
        if (b.danger) btn.classList.add("danger");
        btn.title = b.label;
        btn.setAttribute("aria-label", b.label);
        btn.innerHTML = '<span class="toolbar-icon">' + (b.icon || "") + '</span>' +
          (b.text ? '<span class="toolbar-text">' + escapeHtml(b.text) + '</span>' : '');
        if (b.getInitial && b.getInitial()) btn.classList.add("toolbar-active");
        btn.addEventListener("click", function(ev) {
          ev.stopPropagation();
          if (typeof b.action === "function") b.action(btn);
        });
        return btn;
      }

      // ── Edit mode ──
      export function renderEditToolbar(overlay, data) {
        var bar = overlay.querySelector(".file-preview-toolbar");
        if (!bar) return;
        bar.innerHTML = "";
        var saving = _activeFilePreview && _activeFilePreview.saving;
        var buttons = [
          { label: "保存 (Ctrl+S)", icon: wandFileIcon("save"), text: "保存", primary: true,
            action: function() { saveFileEdit(); } },
          { label: "撤销改动", icon: wandFileIcon("rotate-ccw"),
            action: function() { revertFileEdit(); } },
          { label: "退出编辑 (Esc)", icon: wandFileIcon("x"),
            action: function() { exitFileEdit(); } },
        ];
        renderToolbarButtons(bar, buttons, overlay);
        if (saving) {
          bar.querySelectorAll(".file-preview-toolbar-btn").forEach(function(b) { b.disabled = true; });
        }
      }

      export function enterFileEdit() {
        if (!_activeFilePreview || !_activeFilePreview.data) return;
        var data = _activeFilePreview.data;
        if (data.kind !== "text") return;
        _activeFilePreview.editing = true;
        _activeFilePreview.dirty = false;
        _activeFilePreview.originalContent = data.content || "";
        var overlay = _activeFilePreview.overlay;
        var body = overlay.querySelector(".file-preview-body");
        if (!body) return;
        body.classList.add("editing");
        body.innerHTML =
          '<div class="code-editor-wrapper">' +
            '<textarea class="code-editor-textarea" spellcheck="false" autocomplete="off"' +
              ' autocorrect="off" autocapitalize="off" wrap="off"></textarea>' +
          '</div>';
        var ta = body.querySelector(".code-editor-textarea");
        if (ta) {
          ta.value = data.content || "";
          ta.addEventListener("input", function() {
            var dirty = ta.value !== (_activeFilePreview.originalContent || "");
            if (dirty !== _activeFilePreview.dirty) {
              _activeFilePreview.dirty = dirty;
              updateDirtyBadge();
            }
          });
          // Tab key inserts spaces (2-space indent) instead of moving focus.
          ta.addEventListener("keydown", function(e) {
            if (e.key === "Tab") {
              e.preventDefault();
              var start = ta.selectionStart, end = ta.selectionEnd;
              var indent = "  ";
              ta.value = ta.value.slice(0, start) + indent + ta.value.slice(end);
              ta.selectionStart = ta.selectionEnd = start + indent.length;
              ta.dispatchEvent(new Event("input"));
            }
          });
          // Focus and place caret at start so user sees the top of the file.
          setTimeout(function() {
            ta.focus();
            ta.setSelectionRange(0, 0);
            ta.scrollTop = 0;
          }, 30);
        }
        renderPreviewToolbar(overlay, data);
        updateDirtyBadge();
      }

      export function exitFileEdit() {
        if (!_activeFilePreview || !_activeFilePreview.editing) return;
        var doExit = function() {
          _activeFilePreview.editing = false;
          _activeFilePreview.dirty = false;
          var overlay = _activeFilePreview.overlay;
          var body = overlay.querySelector(".file-preview-body");
          if (body) body.classList.remove("editing");
          // Re-render preview from latest data.
          renderPreviewContent(overlay, _activeFilePreview.data);
          updateDirtyBadge();
        };
        if (_activeFilePreview.dirty && typeof openWandDialog === "function") {
          openWandDialog({
            type: "warning",
            title: "放弃未保存的修改？",
            message: "当前文件有未保存的改动，退出编辑后会丢失。",
            buttons: [
              { label: "继续编辑", value: false, kind: "ghost" },
              { label: "放弃修改", value: true, kind: "danger", autofocus: true },
            ],
            cancelValue: false,
          }).then(function(go) { if (go) doExit(); });
          return;
        }
        doExit();
      }

      export function revertFileEdit() {
        if (!_activeFilePreview || !_activeFilePreview.editing) return;
        var overlay = _activeFilePreview.overlay;
        var ta = overlay.querySelector(".code-editor-textarea");
        if (!ta) return;
        ta.value = _activeFilePreview.originalContent || "";
        _activeFilePreview.dirty = false;
        updateDirtyBadge();
        ta.focus();
      }

      export function saveFileEdit() {
        if (!_activeFilePreview || !_activeFilePreview.editing) return;
        if (_activeFilePreview.saving) return;
        var overlay = _activeFilePreview.overlay;
        var ta = overlay.querySelector(".code-editor-textarea");
        if (!ta) return;
        var newContent = ta.value;
        if (newContent === (_activeFilePreview.originalContent || "")) {
          showToastIfPossible("没有改动");
          return;
        }
        _activeFilePreview.saving = true;
        renderEditToolbar(overlay, _activeFilePreview.data);
        fetch("/api/file-write", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: _activeFilePreview.path, content: newContent }),
        }).then(function(res) {
          return res.json().then(function(json) { return { ok: res.ok, status: res.status, data: json }; });
        }).then(function(result) {
          _activeFilePreview.saving = false;
          if (!result.ok || (result.data && result.data.error)) {
            var msg = (result.data && result.data.error) || ("保存失败 (" + result.status + ")");
            showToastIfPossible(msg);
            renderEditToolbar(overlay, _activeFilePreview.data);
            return;
          }
          // Sync local cache so revert points at the new baseline.
          _activeFilePreview.data.content = newContent;
          _activeFilePreview.data.size = (result.data && result.data.size) || newContent.length;
          _activeFilePreview.originalContent = newContent;
          _activeFilePreview.dirty = false;
          showToastIfPossible("已保存");
          updateDirtyBadge();
          renderEditToolbar(overlay, _activeFilePreview.data);
          // Quietly refresh the file tree so size/git-status update.
          if (typeof refreshFileExplorer === "function") {
            try { refreshFileExplorer(); } catch (e) {}
          }
        }).catch(function(err) {
          _activeFilePreview.saving = false;
          showToastIfPossible("保存失败：" + (err && err.message ? err.message : "网络错误"));
          renderEditToolbar(overlay, _activeFilePreview.data);
        });
      }

      export function updateDirtyBadge() {
        if (!_activeFilePreview) return;
        var overlay = _activeFilePreview.overlay;
        if (!overlay) return;
        var row = overlay.querySelector(".file-preview-name-row");
        if (!row) return;
        var existing = row.querySelector(".file-preview-dirty");
        if (_activeFilePreview.dirty) {
          if (!existing) {
            var dot = document.createElement("span");
            dot.className = "file-preview-dirty";
            dot.title = "有未保存的修改";
            dot.textContent = "● 未保存";
            row.appendChild(dot);
          }
        } else if (existing) {
          existing.remove();
        }
      }

      export function adjustPreviewFontSize(overlay, delta) {
        var pre = overlay.querySelector(".code-preview-content pre");
        var nums = overlay.querySelector(".code-preview-lines");
        if (!pre) return;
        var current = parseFloat(getComputedStyle(pre).fontSize) || 13;
        var next = Math.max(10, Math.min(22, current + delta));
        pre.style.fontSize = next + "px";
        if (nums) nums.style.fontSize = next + "px";
      }

      export function highlightCodePreview(code, lang) {
        // Escape HTML first
        var escaped = code
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        // Simple token-based syntax highlighting
        var tokens = getSyntaxTokens();
        if (!tokens) return escaped;

        // Order matters: longer patterns first, then by priority
        var patterns = [];
        for (var category in tokens) {
          var t = tokens[category];
          if (t && t.pattern) {
            patterns.push({ pattern: t.pattern, cls: t.cls, priority: t.priority || 5 });
          }
        }
        patterns.sort(function(a, b) { return b.priority - a.priority; });

        // Build regex for all patterns
        var allPatterns = patterns.map(function(p) { return "(" + p.pattern.source + ")"; });
        var regex = new RegExp(allPatterns.join("|"), "gm");

        return escaped.replace(regex, function(match) {
          for (var i = 0; i < patterns.length; i++) {
            var p = patterns[i];
            var re = new RegExp("^" + p.pattern.source + "$", "gm");
            if (re.test(match)) {
              return '<span class="' + p.cls + '">' + match + '</span>';
            }
          }
          return match;
        });
      }

      export function getSyntaxTokens() {
        return {
          comment: { pattern: /\/\/.*|#[^\n]*/y, cls: "syntax-comment", priority: 1 },
          string: { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y, cls: "syntax-string", priority: 2 },
          keyword: { pattern: /\b(?:async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|module|namespace|new|null|of|override|private|protected|public|readonly|return|set|static|super|switch|this|throw|try|type|typeof|undefined|var|void|while|yield|abstract|as|base|bool|byte|char|decimal|double|event|explicit|extern|false|fixed|float|foreach|goto|implicit|in|int|internal|is|lock|long|object|operator|out|params|partial|readonly|ref|sbyte|sealed|short|sizeof|stackalloc|string|struct|switch|throw|true|try|uint|ulong|unchecked|unsafe|ushort|using|virtual|volatile|where|while|with|yield|def|elif|else|except|exec|finally|for|from|global|if|import|lambda|nonlocal|not|or|pass|print|raise|return|try|while|with|yield|True|False|None|and|in|is|lambda|not|or|fn|pub|use|mod|impl|trait|struct|enum|match|loop|while|for|if|else|return|self|super|crate|where|async|await|move|ref|mut|static|const|unsafe|extern|use|as|impl|struct|enum|type|fn|let|loop|if|else|match|return|self|Self|mod|pub|crate|macro|derive|where|async|await|dyn|self|package|func|go|return|defer|go|if|else|switch|case|default|for|range|select|break|continue|fallthrough|const|struct|enum|type|interface|map|chan|var|nil|true|false|iota|len|cap|append|make|new|panic|recover|select|else|if|elif|end|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while|end|and|begin|do|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while)\b/y, cls: "syntax-keyword", priority: 3 },
          number: { pattern: /\b(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:e[+-]?\d+)?)\b/y, cls: "syntax-number", priority: 2 },
          function: { pattern: /\b[A-Z][a-zA-Z0-9]*[a-z]\w*(?=\s*\()/y, cls: "syntax-function", priority: 4 },
          type: { pattern: /\b(?:string|number|boolean|void|any|unknown|never|object|symbol|bigint|Array|Object|String|Number|Boolean|Map|Set|WeakMap|WeakSet|Promise|Error|Type|Interface|Enum|Class|Struct|Impl|Trait|fn|fnc|func|function|def|proc|fun|pub|static|const|let|var|int|float|double|bool|char|byte|string|u8|u16|u32|u64|i8|i16|i32|i64|f32|f64|usize|isize|str|Vec|HashMap|Option|Result|Box|Rc|Arc|Cell|RefCell)\b/y, cls: "syntax-type", priority: 4 },
          operator: { pattern: /[+\-*/%=<>!&|^~?:]+|\.\.\.?/y, cls: "syntax-operator", priority: 5 },
          punctuation: { pattern: /[{}[\]();,\.]/y, cls: "syntax-punctuation", priority: 6 }
        };
      }

      export function renderMarkdownPreview(text) {
        if (!text) return "";
        var escaped = escapeHtml(text);

        // Code blocks with syntax highlighting
        escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
          var highlighted = highlightCodePreview(code.trim(), lang);
          var protectedHighlighted = highlighted.replace(/_/g, '&#95;').replace(/\*/g, '&#42;');
          return '<pre><code class="language-' + lang + '">' + protectedHighlighted + '</code></pre>';
        });

        // Inline code
        escaped = escaped.replace(/`([^`]+)`/g, function(_, code) {
          return '<code>' + code.replace(/_/g, '&#95;').replace(/\*/g, '&#42;') + '</code>';
        });

        // Headers
        escaped = escaped.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
        escaped = escaped.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
        escaped = escaped.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
        escaped = escaped.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
        escaped = escaped.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
        escaped = escaped.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

        // Bold and italic
        escaped = escaped.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
        escaped = escaped.replace(/(^|[^\w])___(\S(?:[^\n]*?\S)?)___(?!\w)/g, '$1<strong><em>$2</em></strong>');
        escaped = escaped.replace(/(^|[^\w])__(\S(?:[^\n]*?\S)?)__(?!\w)/g, '$1<strong>$2</strong>');
        escaped = escaped.replace(/(^|[^\w])_(\S(?:[^\n_]*?\S)?)_(?!\w)/g, '$1<em>$2</em>');

        // Strikethrough
        escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>');

        // Links
        escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Images
        escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

        // Blockquote
        escaped = escaped.replace(/^&gt;\s+(.*)$/gm, '<blockquote>$1</blockquote>');

        // Horizontal rule
        escaped = escaped.replace(/^---+$/gm, '<hr>');
        escaped = escaped.replace(/^\*\*\*+$/gm, '<hr>');

        // Unordered lists
        escaped = escaped.replace(/^[\-\*]\s+(.*)$/gm, '<li>$1</li>');
        escaped = escaped.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

        // Ordered lists
        escaped = escaped.replace(/^\d+\.\s+(.*)$/gm, '<li>$1</li>');

        // Tables (GFM)
        escaped = parseMarkdownTables(escaped);

        // Paragraphs
        var paragraphs = escaped.split(/\n{2,}/);
        escaped = paragraphs.map(function(p) {
          p = p.trim();
          if (!p) return "";
          if (/^<(h[1-6]|ul|ol|li|blockquote|pre|table|hr|div)/.test(p)) return p;
          return '<p>' + p.replace(/\n/g, "<br>") + '</p>';
        }).join("\n");

        return escaped;
      }
