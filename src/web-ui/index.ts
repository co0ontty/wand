// Main entry point for web-ui module
// Combines CSS and JavaScript into a single HTML document

import { EMBEDDED_WEB_ASSETS, type EmbeddedVendorAssetPath } from "./embedded-assets.js";
import { getCSSStyles } from "./styles.js";
import { getScriptContent } from "./scripts.js";

// Use String.fromCharCode to avoid template literal interpretation of </script>
const scriptClose = String.fromCharCode(60, 47) + "script>";
const scriptOpen = "<" + "script";

function vendorAssetUrl(relPath: EmbeddedVendorAssetPath): string {
  return `${relPath}?v=${EMBEDDED_WEB_ASSETS.vendor[relPath].hash}`;
}

export function renderApp(configPath: string): string {
  const cssStyles = getCSSStyles();
  const scriptContent = getScriptContent(configPath);
  const xtermSrc = vendorAssetUrl("/vendor/xterm/xterm.bundle.js");
  const qrcodeSrc = vendorAssetUrl("/vendor/qrcode/qrcode.bundle.js");
  const xtermCssHref = vendorAssetUrl("/vendor/xterm/xterm.css");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Wand Console</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%2313110f'/%3E%3Ctext x='32' y='44' text-anchor='middle' font-size='40' font-family='Arial,sans-serif' font-weight='700' fill='%23f5f3ee'%3EW%3C/text%3E%3C/svg%3E" />
  <meta name="description" content="Local CLI Console for Vibe Coding - Manage terminal sessions from your browser" />
  <meta name="theme-color" content="#f5f3ee" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#13110f" media="(prefers-color-scheme: dark)" />
  <meta name="format-detection" content="telephone=no" />
  <meta name="msapplication-tap-highlight" content="no" />
  <link rel="stylesheet" href="${xtermCssHref}" />
  <style>
${cssStyles}
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="overlay-root" data-wand-ui-root></div>
${scriptOpen} src="${xtermSrc}">${scriptClose}
${scriptOpen} src="${qrcodeSrc}">${scriptClose}
${scriptOpen}>
${scriptContent}
${scriptClose}
</body>
</html>`;
}
