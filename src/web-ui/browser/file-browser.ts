import { state, writeStoredBoolean } from "./state";
import { usesSidebarDrawer } from "../sidebar-layout";
import "./i18n";
import "./input";
import "./render";
import { updateDrawerState } from "./session-engine";
import "./sidebar";
import "./viewport";
import { fitTerminalToContainer } from "./terminal-fit";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { openFilePreviewFromLegacy } from "./file-preview-adapter";

      export function isMobileLayout() {
        return window.innerWidth <= 768;
      }

      // 侧栏形态（抽屉覆盖 ⟷ 停靠推开内容）判定，与 React Shell 共用同一套规则。
      // 注意：不要用 isMobileLayout() 代替它——平板竖屏（768）和 640–768 的桌面
      // 窗口必须在侧栏上表现为「停靠」，否则主内容会被盖住（见 sidebar-layout.ts）。
      export function isSidebarDrawerLayout() {
        return usesSidebarDrawer({
          width: window.innerWidth,
          height: window.innerHeight,
          coarsePointer: typeof window.matchMedia === "function"
            && window.matchMedia("(pointer: coarse)").matches,
        });
      }

      export function shouldShowSessionsBackdrop() {
        return !!state.sessionsDrawerOpen && (isSidebarDrawerLayout() || !state.sidebarPinned);
      }

      export function setFilePanelOpen(nextOpen) {
        state.filePanelOpen = nextOpen;
        try {
          localStorage.setItem("wand-file-panel-open", String(state.filePanelOpen));
        } catch (e) {}
        // 只有抽屉形态才需要把侧栏收走（抽屉会被文件面板盖住）；
        // 停靠形态侧栏本就并排常驻，收走只会留下一条空 padding。
        if (state.filePanelOpen && isSidebarDrawerLayout()) {
          state.sessionsDrawerOpen = false;
          writeStoredBoolean("wand-sidebar-open", false);
        }
        updateLayoutState();
      }

      export function toggleFilePanel() {
        setFilePanelOpen(!state.filePanelOpen);
      }

      // 文件面板开合与路径展示归 React Shell（#file-side-panel / .file-explorer-header
      // 均由 React 渲染），这里只保留变更通知。
      export function updateFilePanelState() {
        notifyLegacyUiChange("layout:files");
      }

      export function updateLayoutState() {
        updateDrawerState();
        updateFilePanelState();
      }

      export function updateFilePanelCwd(session) {
        notifyLegacyUiChange("layout:file-cwd");
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
        var rawFontSize = state.terminalBaseFontSize * state.terminalScale;
        var fontPx = Math.max(1, Math.round(rawFontSize));
        state.terminal.options.fontSize = fontPx;
        requestAnimationFrame(function() {
          if (!state.terminal || !state.terminalFitAddon) return;
          fitTerminalToContainer(state.terminal, state.terminalFitAddon);
        });
      }

      export function updateScaleLabel() {
        var label = document.getElementById("terminal-scale-label-top");
        if (label) {
          label.textContent = Math.round(state.terminalScale * 100) + "%";
        }
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

      export function openFilePreview(filePath) {
        openFilePreviewFromLegacy(filePath);
      }
