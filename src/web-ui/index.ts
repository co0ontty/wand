// Main entry point for the web UI shell. Only versioned external assets carry JS/CSS.

import { EMBEDDED_WEB_ASSETS, type EmbeddedVendorAssetPath } from "./embedded-assets.js";
import { getStylesAsset } from "./styles.js";
import { getBrowserModuleManifest, getLoginChunk, getScriptAsset, getThemePreloadAsset } from "./scripts.js";
import { WAND_FAVICON_URL } from "./brand-identity.js";

function vendorAssetUrl(relPath: EmbeddedVendorAssetPath): string {
  return `${relPath}?v=${EMBEDDED_WEB_ASSETS.vendor[relPath].hash}`;
}

export function renderApp(configPath: string, page: "console" | "settings" = "console",
  settingsAuth: "browser" | "client" = "browser", authenticated = true): string {
  const stylesHref = `/assets/app.css?v=${getStylesAsset().hash}`;
  // 匿名访客只下发登录小包（content/login.js），不预载控制台 runtime：
  // 之前登录页要等 Brotli 669KB 的整份控制台代码才能渲染密码框。
  const loginAsset = authenticated ? null : getLoginChunk();
  const scriptSrc = loginAsset
    ? `/assets/login.js?v=${loginAsset.hash}`
    : `/assets/app.js?v=${getScriptAsset(configPath).hash}`;
  // Discover the eager graph in the HTML instead of waiting for app.js to
  // download and execute its dynamic import. Preloading does not execute it:
  // the bootstrap still installs instance values before the runtime runs.
  const modulePreloads = authenticated
    ? getBrowserModuleManifest().eager
      .map(file => `<link rel="modulepreload" href="/assets/${file}" />`).join("\n  ")
    : "";
  const xtermSrc = vendorAssetUrl("/vendor/xterm/xterm.bundle.js");
  const qrcodeSrc = vendorAssetUrl("/vendor/qrcode/qrcode.bundle.js");
  const xtermCssHref = vendorAssetUrl("/vendor/xterm/xterm.css");

  return `<!doctype html>
<html lang="zh-CN"${page === "settings" ? ` data-wand-page="settings" data-wand-settings-auth="${settingsAuth}"` : ""}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <meta name="wand-xterm-script" content="${xtermSrc}" />
  <meta name="wand-qrcode-script" content="${qrcodeSrc}" />
  <title>${page === "settings" ? "Wand 设置" : "Wand Console"}</title>
  <link rel="icon" type="image/svg+xml" href="${WAND_FAVICON_URL}" />
  <meta name="description" content="Local CLI Console for Vibe Coding - Manage terminal sessions from your browser" />
  <meta name="theme-color" content="#faf8f5" />
  <meta name="format-detection" content="telephone=no" />
  <meta name="msapplication-tap-highlight" content="no" />
  ${modulePreloads}
  <script src="/assets/theme.js?v=${getThemePreloadAsset().hash}"></script>
  <link rel="stylesheet" href="${xtermCssHref}" />
  <link rel="stylesheet" href="${stylesHref}" />
</head>
<body>
  <div id="app">${authenticated ? "" : '<div data-login-controls style="height:100%"></div>'}</div>
  <div id="overlay-root" data-wand-ui-root></div>
<script src="${scriptSrc}"></script>
</body>
</html>`;
}
