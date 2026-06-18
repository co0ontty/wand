// ── Module imports ──
// Import order matters: legacy cleanup first, then state/base utilities and business modules.
// Each import triggers module-level side effects (e.g. localStorage migrations,
// global assignments, setInterval timers).
import "./legacy-pwa-cleanup";
import "./state";        // state initialization + localStorage migrations
import "./i18n";
import "./utils";
import "./chat-scroll";
import "./render";       // includes renderBootLoading() and restoreLoginSession() startup calls
import "./git-commit";
import "./sidebar";
import "./file-browser";
import "./session-ui";
import "./events";
import "./terminal";
import "./session-engine";
import "./input";
import "./viewport";
import "./websocket";    // includes 30s setInterval side effect
import "./chat-render";  // includes initMobileCopyLongPress self-executing
import "./notifications";
import { t } from "./i18n";
import { render, renderBootLoading, restoreLoginSession } from "./render";
import { state } from "./state";

(function() {
  try {
    var ua = (navigator && navigator.userAgent) || "";
    if (/WandApp\//.test(ua)) {
      document.documentElement.classList.add('is-wand-app');
    }
    if (/WandPlatform\/iOS/.test(ua)) {
      document.documentElement.classList.add('is-wand-ios');
    }
  } catch (e) {}

  // 嵌入终端模式：原生壳（iOS）把 PTY 会话套在原生头部里，只需网页展示
  // 终端黑窗，隐藏侧边栏 / 顶栏 / 空白欢迎页。由 ?embed=terminal 触发；
  // ?nativeInput=1 表示底部输入栏由原生组件渲染。
  try {
    const params = new URL(window.location.href).searchParams;
    if (params.get("embed") === "terminal") {
      document.documentElement.classList.add('is-wand-embed-terminal');
      if (params.get("nativeInput") === "1") {
        document.documentElement.classList.add('is-wand-native-input');
      }
    }
  } catch (e) {}

  // iOS 原生壳据此判断网页是否已支持「侧边栏返回原生界面」按钮：
  // 旧版网页没有这个标记，壳会回退显示自己的顶部返回栏，避免用户被困在网页版。
  try { (window as any).__wandNativeBackHooked = true; } catch (e) {}
})();
