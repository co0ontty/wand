import { state, readStoredBoolean, writeStoredBoolean } from "./state";
import { t, iconSvg } from "./i18n";
import { escapeHtml, scrollInputToEnd, scrollPathElementToEnd } from "./utils";
import { getSelectedSession, focusInputBox } from "./input";
import { showToast } from "./notifications";
import { render, getEffectiveCwd } from "./render";
import { isStructuredSession, updateDrawerState } from "./session-engine";
import { renderSessions } from "./sidebar";
import { ensureTerminalFit, scheduleTerminalResize } from "./viewport";
import { getConfigCwd } from "./chat-scroll";
import { isBrowserReactShellMounted } from "./shell-runtime";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { openFilePreviewFromLegacy } from "./file-preview-adapter";

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
        if (isBrowserReactShellMounted()) {
          notifyLegacyUiChange("layout:files");
          return;
        }
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
        if (isBrowserReactShellMounted()) {
          notifyLegacyUiChange("layout:file-cwd");
          return;
        }
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!cwdEl) return;
        var cwd = session && session.cwd ? session.cwd : getConfigCwd();
        // Don't clobber the user's in-progress edit when the input is focused.
        if (cwdEl.tagName === "INPUT") {
          if (document.activeElement !== cwdEl) {
            (cwdEl as HTMLInputElement).value = cwd;
            scrollInputToEnd(cwdEl as HTMLInputElement);
          }
        } else {
          cwdEl.textContent = cwd;
        }
        cwdEl.title = cwd;
        // 长路径场景：把父级 file-explorer-header 横向滚到最右，
        // 让 input 的末尾（含最后一个目录名）默认可见。
        var headerEl = cwdEl.closest(".file-explorer-header");
        if (headerEl) {
          scrollPathElementToEnd(headerEl);
        }
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
      export function wandFileIcon(name, opts?) {
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

      export function refreshFileExplorer(opts?) {
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
        if (cwdEl && !isBrowserReactShellMounted()) {
          if (cwdEl.tagName === "INPUT") {
            // Avoid clobbering in-progress text while the user is typing.
            if (document.activeElement !== cwdEl) {
              (cwdEl as HTMLInputElement).value = cwd;
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

      export function renderFileTreeItem(item, depth?) {
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
          var openHandler = function() { openFilePreview((item as HTMLElement).dataset.path); };
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
            showFileContextMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, item);
          });
          item.addEventListener("touchstart", function(e) {
            pressFired = false;
            pressTimer = setTimeout(function() {
              pressFired = true;
              var t = (e as TouchEvent).touches && (e as TouchEvent).touches[0];
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
        var current = (inputBox as HTMLInputElement).value || "";
        var sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
        (inputBox as HTMLInputElement).value = current + sep + text;
        inputBox.dispatchEvent(new Event("input", { bubbles: true }));
        try { inputBox.focus(); (inputBox as HTMLInputElement).setSelectionRange((inputBox as HTMLInputElement).value.length, (inputBox as HTMLInputElement).value.length); } catch (e) {}
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
        showToast(msg);
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
            var idx = parseInt((btn as HTMLElement).dataset.idx!, 10);
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


      export function openFilePreview(filePath) {
        openFilePreviewFromLegacy(filePath);
      }
