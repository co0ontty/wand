// Main entry point for the web UI shell. Only versioned external assets carry JS/CSS.

import { EMBEDDED_WEB_ASSETS, type EmbeddedVendorAssetPath } from "./embedded-assets.js";
import { getStylesAsset } from "./styles.js";
import { getScriptAsset, getThemePreloadAsset } from "./scripts.js";
import { WAND_FAVICON_URL } from "./brand-identity.js";

function vendorAssetUrl(relPath: EmbeddedVendorAssetPath): string {
  return `${relPath}?v=${EMBEDDED_WEB_ASSETS.vendor[relPath].hash}`;
}

export function renderApp(configPath: string, page: "console" | "settings" = "console", settingsAuth: "browser" | "client" = "browser"): string {
  const stylesHref = `/assets/app.css?v=${getStylesAsset().hash}`;
  const scriptSrc = `/assets/app.js?v=${getScriptAsset(configPath).hash}`;
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
  <script src="/assets/theme.js?v=${getThemePreloadAsset().hash}"></script>
  <link rel="stylesheet" href="${xtermCssHref}" />
  <link rel="stylesheet" href="${stylesHref}" />
</head>
<body>
  <div id="app"></div>
  <div id="overlay-root" data-wand-ui-root></div>
<script src="${scriptSrc}"></script>
</body>
</html>`;
}
