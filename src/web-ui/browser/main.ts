// ── Module imports ──
// Import order matters: state and base utilities first, then business modules.
// Each import triggers module-level side effects (e.g. localStorage migrations,
// global assignments, setInterval timers).
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

if ('serviceWorker' in navigator) {
  fetch('/sw.js', { cache: 'no-cache' })
    .then(function(response) {
      if (response.ok) {
        return navigator.serviceWorker.register('/sw.js');
      }
      console.log('SW fetch failed, skipping service worker registration');
      return Promise.reject('Service worker script not available');
    })
    .catch(function(e) {
      var msg = (e && e.message) || String(e || '');
      var isCertIssue = (e && e.name === 'TypeError') || /certificate|SSL|ERR_CERT/i.test(msg);
      if (isCertIssue && location.protocol === 'https:') {
        console.warn(
          '[wand] PWA / Service Worker 因 TLS 证书不可信而跳过。\n' +
          '解决办法（任选一种）：\n' +
          '  1) 从 ' + location.origin + '/cert/server.crt 下载本机自签证书，导入到系统/浏览器"受信任根证书颁发机构"\n' +
          '  2) 在本机用 mkcert 签发受信任证书，并在 ~/.wand/config.json 配置 tls.certPath / tls.keyPath\n' +
          '  3) 用内网 CA 或 Let\'s Encrypt 给域名签真证书（同上配置 tls）'
        );
      } else {
        console.log('SW registration failed:', msg);
      }
    });

  var reloading = false;
  var pageReady = false;
  setTimeout(function() { pageReady = true; }, 3000);
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    if (reloading || !pageReady) return;
    reloading = true;
    location.reload();
  });
}

(function() {
  function detectDisplayMode() {
    var mode = 'browser';
    if (window.matchMedia('(display-mode: window-controls-overlay)').matches) {
      mode = 'window-controls-overlay';
    } else if (window.matchMedia('(display-mode: standalone)').matches) {
      mode = 'standalone';
    } else if (window.matchMedia('(display-mode: fullscreen)').matches) {
      mode = 'fullscreen';
    } else if ((navigator as any).standalone === true) {
      mode = 'standalone';
    }
    document.documentElement.setAttribute('data-display-mode', mode);
    document.documentElement.classList.toggle('is-pwa', mode !== 'browser');
    return mode;
  }
  detectDisplayMode();
  ['standalone', 'window-controls-overlay', 'fullscreen'].forEach(function(m) {
    window.matchMedia('(display-mode: ' + m + ')').addEventListener('change', detectDisplayMode);
  });

  try {
    var ua = (navigator && navigator.userAgent) || "";
    if (/WandApp\//.test(ua)) {
      document.documentElement.classList.add('is-wand-app');
    }
  } catch (e) {}

  // iOS 原生壳据此判断网页是否已支持「侧边栏返回原生界面」按钮：
  // 旧版网页没有这个标记，壳会回退显示自己的顶部返回栏，避免用户被困在网页版。
  try { (window as any).__wandNativeBackHooked = true; } catch (e) {}
})();
